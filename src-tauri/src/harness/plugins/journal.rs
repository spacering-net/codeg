//! One operation on one plugin — files, hosts and record together — so that
//! a failure or a crash at any point leaves the record saying what the
//! hosts may have, and nothing of the plugin's files that a host may load is
//! lost.
//!
//! An operation ([`Tx`]) runs under the plugins lock:
//!
//! 1. **Begin**: the journal `<root>/.ops/<op>.json` (written atomically,
//!    0600): the action, the install name, the record's entry before (as it
//!    is now) and after (its `op` is this operation's), the revision folders
//!    this operation made, and the host steps.
//! 2. **Stage** ([`Tx::stage`]): the revision folder in place
//!    (`store::stage_revision`); one this operation is about to make is
//!    in the journal before it is made.
//! 3. **Host steps**: each written down as `planned` right before it runs
//!    and `done` right after ([`Tx::step_planned`], [`Tx::step_done`]); the
//!    journal is rewritten each time.
//! 4. **Commit** ([`Tx::commit`]): the journal marked `committing`, then
//!    the record with the `after` entry (or without the entry). The point of
//!    no return. The recovery takes an operation as committed when the
//!    record's entry carries its `op` — or, for a removal, when the entry is
//!    gone and the journal was marked (a restored record that merely lacks
//!    the plugin is not a commit).
//! 5. **Finish** ([`Tx::finish`]): the plugin's revisions other than the
//!    entry's own and previous one removed, staging cleared, the journal
//!    deleted.
//!
//! **Rolling back** (a failure before the commit, [`Tx::rollback`], or the
//! startup [`recover`] finding a journal whose `after` is not in the record):
//! - no host touched: the revision folders this operation made are removed
//!   (unless the record's entry uses them), the record is left as it is —
//!   except that a record restored without the entry the operation started
//!   from gets that entry back (the agents have its plugin);
//! - hosts touched (a step planned or done — it may have run): every such
//!   agent is marked [`HostState::NeedsRepair`] in the record's entry (the
//!   record's, else the journal's `before`; for a first install the `after`
//!   entry with only those agents, so that what the hosts now have can be
//!   repaired or uninstalled; each keeps the Experts links its `after`
//!   host lists, to be given back later, and a note of the state it had and
//!   of any other mode a step ran in — an uninstall's agents noted as
//!   uninstalling, so that their repair finishes it), and no revision folder is
//!   removed — a host may load from it. The revisions this operation made or reused go into
//!   the entry's `held_revisions`, kept while any agent needs repair.
//!
//! The journal is marked `rolling_back` (and no longer `committing`) before
//! anything is undone — by [`Tx::undoing`] before the caller undoes host
//! steps, and again, with the agents to mark, when the rollback starts — so
//! an interrupted rollback is resumed as one, never taken for a commit. A
//! commit whose record write fails clears its `committing` mark.
//!
//! The rollback undoes file-level work only: undoing what a host command
//! did is the caller's, before it rolls back, and the startup recovery never
//! runs a host command. A journal whose record no longer holds its `before`
//! (a restored backup) is rolled back the same way, and reported. Install
//! names that differ only in case are one name (one folder on a case-blind
//! disk). Nothing is cleared while the journals cannot all be read, and the
//! store's own folders (`.ops`, `.staging`, `.trash`) are never followed
//! through a link.

use std::collections::BTreeSet;
use std::fs;
use std::io;

use serde::{Deserialize, Serialize};

use crate::harness::skills::package::PackageFile;
use crate::harness::types::FileEntry;
use crate::skills::fsio::{create_dir_all_durable, op_id, remove_if_empty, write_private_atomic};

use super::ctx::{InstallName, PluginsCtx, STAGING_DIR};
use super::lock::PluginsGuard;
use super::record::{self, AgentWire, HostEntry, HostMode, HostState, PluginEntry};
use super::store::{self, Staged};

/// Marks a journal as a plugin operation's.
const KIND: &str = "harness_plugin";
const FORMAT: u64 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Install,
    Update,
    Uninstall,
    /// Hosts changed without a new revision (a mode, enabling, disabling).
    Change,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepState {
    /// About to run, or running: it may have done something.
    Planned,
    Done,
}

/// One host command (or skills-engine call) for one agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostStep {
    pub agent: AgentWire,
    /// How the agent is to have the plugin when the step is through.
    pub mode: HostMode,
    /// What the step does (`install`, `update`, `disable`, …), for the
    /// report.
    pub action: String,
    pub state: StepState,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Journal {
    pub kind: String,
    pub format: u64,
    pub op: String,
    pub action: Action,
    pub name: String,
    pub before: Option<PluginEntry>,
    pub after: Option<PluginEntry>,
    /// Revision folders this operation made (or was about to make).
    #[serde(default)]
    pub created: Vec<u64>,
    /// Every revision this operation put in place or reused: a host step
    /// may point an agent at any of them.
    #[serde(default)]
    pub staged: Vec<u64>,
    #[serde(default)]
    pub steps: Vec<HostStep>,
    /// The record is about to get `after`: written right before it is. A
    /// removal whose entry is gone counts as committed only with it.
    #[serde(default)]
    pub committing: bool,
    /// The rollback is under way (it may have written the record): the
    /// recovery rolls back again, whatever the record says.
    #[serde(default)]
    pub rolling_back: bool,
    /// The agents that rollback marks as needing repair (written with
    /// `rolling_back`): a resumed rollback marks the same ones.
    #[serde(default)]
    pub repair: Option<Vec<AgentWire>>,
    pub created_at: String,
}

impl Journal {
    /// Every agent a step was planned for.
    pub fn touched(&self) -> BTreeSet<AgentWire> {
        self.steps.iter().map(|step| step.agent.clone()).collect()
    }
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn write_journal(ctx: &PluginsCtx, journal: &Journal) -> io::Result<()> {
    create_dir_all_durable(&ctx.ops_dir())?;
    let mut bytes = serde_json::to_vec_pretty(journal).map_err(io::Error::other)?;
    bytes.push(b'\n');
    write_private_atomic(&ctx.journal_path(&journal.op), &bytes)
}

fn read_journal(path: &std::path::Path) -> Result<Journal, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    let journal: Journal = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    if journal.kind != KIND || journal.format > FORMAT {
        return Err("a journal this Codeg does not know".to_string());
    }
    Ok(journal)
}

/// The journals in `<root>/.ops`, as (op from the file name, journal or why
/// it cannot be read). An error when the folder cannot be listed whole: no
/// caller may take "none could be read" for "there are none".
fn journals(ctx: &PluginsCtx) -> io::Result<Vec<(String, Result<Journal, String>)>> {
    let dir = ctx.ops_dir();
    if !store::housekeeping_dir(&dir)? {
        return Ok(Vec::new());
    }
    let mut out: Vec<(String, Result<Journal, String>)> = Vec::new();
    for entry in fs::read_dir(&dir)? {
        let entry = entry?;
        let file_name = entry.file_name().to_string_lossy().into_owned();
        let Some(op) = file_name.strip_suffix(".json") else {
            continue;
        };
        if op.starts_with('.') {
            continue;
        }
        out.push((op.to_string(), read_journal(&entry.path())));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

fn other(message: impl Into<String>) -> io::Error {
    io::Error::other(message.into())
}

/// An operation on one plugin. Lives while its caller holds the plugins
/// lock (the guard is asked for at [`Tx::begin`]). It keeps its own copy of
/// the context, so it can go to a blocking task and back.
pub struct Tx {
    ctx: PluginsCtx,
    name: InstallName,
    journal: Journal,
    committed: bool,
}

impl std::fmt::Debug for Tx {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Tx")
            .field("op", &self.journal.op)
            .field("name", &self.name)
            .field("committed", &self.committed)
            .finish_non_exhaustive()
    }
}

impl Tx {
    /// Start an operation on `name`, whose record entry is to become
    /// `after` (`None`: removed). The entry before is the record's now. The
    /// journal is on disk when this returns. Refused while the record cannot
    /// be written (unreadable, newer format) or an earlier operation on the
    /// plugin is unfinished.
    pub fn begin(
        ctx: &PluginsCtx,
        _lock: &PluginsGuard,
        action: Action,
        name: &InstallName,
        after: Option<PluginEntry>,
    ) -> io::Result<Self> {
        let current = record::load_for_write(ctx)?;
        // Install names are folders: on a case-blind disk `Foo` and `foo`
        // are one, so they are one name here too.
        if let Some(other_name) = case_alias(&current, name) {
            return Err(other(format!(
                "{name} is taken by the installed plugin {other_name}"
            )));
        }
        let before = current.plugins.get(name.as_str()).cloned();
        if before.is_none() && after.is_none() {
            return Err(other(format!("{name} is not installed")));
        }
        if journals(ctx)?.iter().any(|(_, journal)| match journal {
            Ok(journal) => journal.name.eq_ignore_ascii_case(name.as_str()),
            // One that cannot be read may be this plugin's.
            Err(_) => true,
        }) {
            return Err(other(format!(
                "an earlier operation on the plugins is unfinished ({})",
                ctx.ops_dir().display()
            )));
        }
        let op = op_id();
        let mut journal = Journal {
            kind: KIND.to_string(),
            format: FORMAT,
            op: op.clone(),
            action,
            name: name.as_str().to_string(),
            before,
            after,
            created: Vec::new(),
            staged: Vec::new(),
            steps: Vec::new(),
            committing: false,
            rolling_back: false,
            repair: None,
            created_at: now(),
        };
        if let Some(after) = journal.after.as_mut() {
            after.op = op;
        }
        ctx.fault("begin")?;
        write_journal(ctx, &journal)?;
        Ok(Self {
            ctx: ctx.clone(),
            name: name.clone(),
            journal,
            committed: false,
        })
    }

    pub fn op(&self) -> &str {
        &self.journal.op
    }

    pub fn journal(&self) -> &Journal {
        &self.journal
    }

    fn write(&self) -> io::Result<()> {
        write_journal(&self.ctx, &self.journal)
    }

    /// Put revision `revision` in place (or reuse it, identical). A folder
    /// this operation is to make is in the journal first.
    pub(crate) fn stage(
        &mut self,
        revision: u64,
        listing: &[FileEntry],
        files: &[PackageFile],
    ) -> io::Result<Staged> {
        let target = self.ctx.revision_dir(&self.name, revision);
        let mut changed = false;
        if fs::symlink_metadata(&target).is_err() && !self.journal.created.contains(&revision) {
            self.journal.created.push(revision);
            changed = true;
        }
        if !self.journal.staged.contains(&revision) {
            self.journal.staged.push(revision);
            changed = true;
        }
        if changed {
            self.write()?;
        }
        store::stage_revision(
            &self.ctx,
            &self.journal.op,
            &self.name,
            revision,
            listing,
            files,
        )
    }

    /// Write down a host step about to run. Returns its index.
    pub fn step_planned(&mut self, agent: &str, mode: HostMode, action: &str) -> io::Result<usize> {
        self.ctx.fault("step")?;
        self.journal.steps.push(HostStep {
            agent: agent.to_string(),
            mode,
            action: action.to_string(),
            state: StepState::Planned,
        });
        self.write()?;
        Ok(self.journal.steps.len() - 1)
    }

    /// Write down that the step at `index` went through.
    pub fn step_done(&mut self, index: usize) -> io::Result<()> {
        self.ctx.fault("step")?;
        let step = self
            .journal
            .steps
            .get_mut(index)
            .ok_or_else(|| other(format!("no step {index}")))?;
        step.state = StepState::Done;
        self.write()
    }

    /// The entry the record is to get, as it stands now (a step's outcome
    /// can change it before the commit).
    pub fn set_after(&mut self, after: Option<PluginEntry>) -> io::Result<()> {
        if self.committed {
            return Err(other("the operation is committed"));
        }
        if after.is_none() && self.journal.before.is_none() {
            return Err(other(format!("{} is not installed", self.name)));
        }
        self.journal.after = after.map(|mut after| {
            after.op = self.journal.op.clone();
            after
        });
        self.write()
    }

    /// Write the record with the `after` entry. From here on the operation
    /// is finished, never rolled back.
    pub fn commit(&mut self) -> io::Result<()> {
        self.ctx.fault("commit")?;
        let mut current = record::load_for_write(&self.ctx)?;
        self.journal.committing = true;
        self.write()?;
        match &self.journal.after {
            Some(after) => {
                current
                    .plugins
                    .insert(self.journal.name.clone(), after.clone());
            }
            None => {
                current.plugins.remove(&self.journal.name);
            }
        }
        if let Err(error) = record::save(&self.ctx, &current) {
            // Not committed after all: the journal says so again, so that
            // what the caller undoes next is never taken for a commit.
            self.journal.committing = false;
            let _ = self.write();
            return Err(error);
        }
        self.committed = true;
        Ok(())
    }

    /// Write down that the operation is being undone — before the caller
    /// undoes any host step. From here on the recovery only rolls it back
    /// (marking every agent a step touched, unless [`Tx::rollback`] got as
    /// far as naming the ones it could not restore).
    pub fn undoing(&mut self) -> io::Result<()> {
        if self.committed {
            return Err(other("the operation is committed; finish it"));
        }
        self.journal.committing = false;
        self.journal.rolling_back = true;
        self.write()
    }

    /// Clean up after the commit: revisions the entry does not keep, the
    /// staging folder, the journal. A revision that cannot be removed is
    /// reported, not an error (the next operation removes it); the journal
    /// that cannot be deleted is (the next start finishes the job).
    pub fn finish(self) -> io::Result<Vec<String>> {
        if !self.committed {
            return Err(other("the operation is not committed"));
        }
        finish(&self.ctx, &self.name, &self.journal)
    }

    /// Undo the operation's file-level work before the commit (see the
    /// module docs), after the caller undid what host steps it could (having
    /// called [`Tx::undoing`] first). `needs_repair`: the agents whose host
    /// steps the caller could not undo — they are marked
    /// [`HostState::NeedsRepair`]. Returns the agents marked. On failure the
    /// journal stays, for the next start.
    pub fn rollback(self, needs_repair: &BTreeSet<AgentWire>) -> io::Result<Vec<AgentWire>> {
        if self.committed {
            return Err(other("the operation is committed; finish it"));
        }
        roll_back(&self.ctx, &self.name, &self.journal, needs_repair)
    }
}

fn clear_staging(ctx: &PluginsCtx, op: &str) -> io::Result<()> {
    if !store::housekeeping_dir(&ctx.staging_root())? {
        return Ok(());
    }
    let staging = ctx.staging_dir(op);
    match fs::symlink_metadata(&staging) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(&staging)?,
        Ok(_) => fs::remove_file(&staging)?,
    }
    remove_if_empty(&ctx.staging_root());
    Ok(())
}

fn drop_journal(ctx: &PluginsCtx, op: &str) -> io::Result<()> {
    match fs::remove_file(ctx.journal_path(op)) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    remove_if_empty(&ctx.ops_dir());
    Ok(())
}

fn finish(ctx: &PluginsCtx, name: &InstallName, journal: &Journal) -> io::Result<Vec<String>> {
    ctx.fault("finish")?;
    let mut problems = Vec::new();
    // What the record holds now: the entry this operation wrote, perhaps
    // with hosts marked since.
    let keep = record::load_for_write(ctx)
        .map_err(io::Error::from)?
        .plugins
        .get(name.as_str())
        .map(PluginEntry::kept_revisions);
    match keep {
        Some(keep) => {
            if let Err(error) = store::gc(ctx, name, &keep) {
                problems.push(format!("{name}: old revisions not removed ({error})"));
            }
        }
        None => {
            if let Err(error) = store::gc(ctx, name, &[]) {
                problems.push(format!("{name}: files not removed ({error})"));
            }
        }
    }
    clear_staging(ctx, &journal.op)?;
    drop_journal(ctx, &journal.op)?;
    Ok(problems)
}

/// A key of `record` that is `name` in another spelling (one folder on a
/// case-blind disk).
fn case_alias<'r>(record: &'r record::Record, name: &InstallName) -> Option<&'r String> {
    record
        .plugins
        .keys()
        .find(|key| key.as_str() != name.as_str() && key.eq_ignore_ascii_case(name.as_str()))
}

fn roll_back(
    ctx: &PluginsCtx,
    name: &InstallName,
    journal: &Journal,
    touched: &BTreeSet<AgentWire>,
) -> io::Result<Vec<AgentWire>> {
    ctx.fault("rollback")?;
    let mut current = record::load_for_write(ctx)?;
    if let Some(alias) = case_alias(&current, name) {
        return Err(other(format!(
            "the record holds {alias}, another spelling of {name}"
        )));
    }
    // Before anything is moved or written: a rollback that stops partway is
    // resumed as this rollback, for these agents, never taken for a commit.
    let mut rolling_back = journal.clone();
    rolling_back.committing = false;
    rolling_back.rolling_back = true;
    rolling_back.repair = Some(touched.iter().cloned().collect());
    write_journal(ctx, &rolling_back)?;
    let entry = current.plugins.get(name.as_str()).cloned();
    let mut marked = Vec::new();
    // The name may be another item's in the record now (a restored journal
    // of a plugin since installed under a new name, the old name taken by
    // another): that entry is not this operation's to mark.
    let journal_item = journal
        .before
        .as_ref()
        .or(journal.after.as_ref())
        .map(|entry| entry.item_id.clone());
    let foreign = entry.as_ref().is_some_and(|entry| {
        journal_item
            .as_ref()
            .is_some_and(|item| &entry.item_id != item)
    });
    if foreign {
        tracing::warn!(
            "[Harness plugins] {name} is another item in the record now; the rollback leaves the record as it is"
        );
    }
    // A record restored without the entry the operation started from: the
    // agents have that entry's plugin again (or still), so it goes back in.
    let reinstate = !foreign && entry.is_none() && journal.before.is_some();
    if !foreign && (!touched.is_empty() || reinstate) {
        // The entry the record has; else the one it had (a restored record
        // without it); else — a first install — the one being installed,
        // with only the agents it touched: they have something of it now.
        let (mut base, from_after) = match (entry, &journal.before, &journal.after) {
            (Some(entry), _, _) => (entry, false),
            (None, Some(before), _) => (before.clone(), false),
            (None, None, Some(after)) => (after.clone(), true),
            (None, None, None) => return Err(other(format!("{name}: nothing to mark"))),
        };
        if from_after {
            base.hosts.retain(|agent, _| touched.contains(agent));
        }
        for agent in touched {
            let mode = journal
                .steps
                .iter()
                .rev()
                .find(|step| &step.agent == agent)
                .map(|step| step.mode);
            // Every mode a step of the agent's ran in: one other than the
            // entry's may have left something behind.
            let modes: Vec<HostMode> = journal
                .steps
                .iter()
                .filter(|step| &step.agent == agent)
                .map(|step| step.mode)
                .collect();
            // An uninstall cut short is finished by the repair, never
            // undone by it.
            let uninstalling = journal.action == Action::Uninstall;
            // An operation that came with a restored backup: the repair only
            // checks, switches off and repoints.
            let restored = came_restored(ctx, &journal.op);
            match base.hosts.get_mut(agent) {
                Some(host) => {
                    host.mark_needs_repair(modes.iter().copied());
                    if uninstalling {
                        host.mark_uninstalling();
                    }
                    if restored {
                        host.mark_restored();
                    }
                    // The Experts links the operation took out of the agent
                    // (its `after` has them): still to be given back.
                    let taken = journal
                        .after
                        .as_ref()
                        .and_then(|after| after.hosts.get(agent))
                        .map(|after| after.experts.clone())
                        .unwrap_or_default();
                    for link in taken {
                        if !host.experts.contains(&link) {
                            host.experts.push(link);
                        }
                    }
                }
                None => {
                    let from_after = journal
                        .after
                        .as_ref()
                        .and_then(|after| after.hosts.get(agent))
                        .cloned();
                    // It had nothing of the plugin before.
                    let mut host = match (from_after, mode) {
                        (Some(mut host), _) => {
                            host.state = HostState::NeedsRepair;
                            host
                        }
                        (None, Some(mode)) => HostEntry {
                            state: HostState::NeedsRepair,
                            ..HostEntry::new(mode)
                        },
                        (None, None) => continue,
                    };
                    host.mark_needs_repair(modes.iter().copied());
                    if uninstalling {
                        host.mark_uninstalling();
                    }
                    if restored {
                        host.mark_restored();
                    }
                    base.hosts.insert(agent.clone(), host);
                }
            }
            marked.push(agent.clone());
        }
        // A revision this operation made or reused may be what a touched
        // agent loads now: held until the agents are repaired, even one the
        // entry keeps today (a later update moves `previous_revision` on).
        if !touched.is_empty() {
            for revision in journal.created.iter().chain(&journal.staged) {
                if !base.held_revisions.contains(revision) {
                    base.held_revisions.push(*revision);
                }
            }
        }
        // An entry for an item the record has under another name (a
        // restored journal of a plugin since installed again under a new
        // name): one item, one entry — the record's stays.
        let elsewhere = current
            .plugins
            .iter()
            .find(|(key, entry)| key.as_str() != name.as_str() && entry.item_id == base.item_id)
            .map(|(key, _)| key.clone());
        match elsewhere {
            Some(other) => {
                tracing::warn!(
                    "[Harness plugins] {name}: its item is installed as {other}; the rollback leaves the record as it is"
                );
                marked.clear();
            }
            None => {
                current.plugins.insert(name.as_str().to_string(), base);
                record::save(ctx, &current)?;
            }
        }
    }
    if touched.is_empty() {
        // Every agent is as it was: what this operation made goes, unless
        // the record's entry uses it.
        let used = current
            .plugins
            .get(name.as_str())
            .map(PluginEntry::kept_revisions)
            .unwrap_or_default();
        for revision in &journal.created {
            if !used.contains(revision) {
                store::remove_revision(ctx, name, *revision)?;
            }
        }
    }
    clear_staging(ctx, &journal.op)?;
    drop_journal(ctx, &journal.op)?;
    Ok(marked)
}

/// How an operation's record stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stand {
    /// The `after` entry is in (or, for a removal that got as far as its
    /// commit, the entry is gone).
    Committed,
    /// The `before` entry is still in.
    Before,
    /// Neither: the record was restored or edited.
    Foreign,
}

fn stand(journal: &Journal, current: Option<&PluginEntry>) -> Stand {
    let op_of = |entry: Option<&PluginEntry>| entry.map(|entry| entry.op.clone());
    match &journal.after {
        Some(_) if current.is_some_and(|entry| entry.op == journal.op) => Stand::Committed,
        None if current.is_none() && journal.committing => Stand::Committed,
        _ if op_of(current) == op_of(journal.before.as_ref()) => Stand::Before,
        _ => Stand::Foreign,
    }
}

/// Put in the store by a backup restore before it recovers the restored
/// journals: the operations (journal file names) that came with the backup.
/// Rolling back one of them marks the agents it marks for repair as restored
/// too, in the same record write ([`HostEntry::mark_restored`]), so that an
/// agent such a rollback brings in is never repaired as if no backup had
/// been restored; other operations are not affected. Removed once none of
/// them is left ([`clear_restored_mark`]).
pub const RESTORED_MARK: &str = ".restored";

fn restored_mark(ctx: &PluginsCtx) -> std::path::PathBuf {
    ctx.root.join(RESTORED_MARK)
}

/// Whether `op` came with a restored backup. A mark that cannot be read
/// counts every operation.
fn came_restored(ctx: &PluginsCtx, op: &str) -> bool {
    match fs::read(restored_mark(ctx)) {
        Ok(bytes) => serde_json::from_slice::<Vec<String>>(&bytes)
            .map_or(true, |ops| ops.iter().any(|listed| listed == op)),
        Err(error) => error.kind() != io::ErrorKind::NotFound,
    }
}

/// Write the mark for every journal in the store now (none: no mark),
/// durably. A backup restore calls it before it recovers them.
pub fn mark_restored_journals(ctx: &PluginsCtx) -> io::Result<()> {
    let ops: Vec<String> = journals(ctx)?.into_iter().map(|(op, _)| op).collect();
    if ops.is_empty() {
        return Ok(());
    }
    let bytes = serde_json::to_vec(&ops).map_err(io::Error::other)?;
    let mark = restored_mark(ctx);
    let tmp = ctx.root.join(format!("{RESTORED_MARK}.tmp"));
    {
        use std::io::Write;
        let mut file = fs::File::create(&tmp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
    }
    fs::rename(&tmp, &mark)?;
    crate::skills::fsio::flush_dir(&ctx.root)
}

/// Remove the mark once none of its operations has a journal left.
pub fn clear_restored_mark(ctx: &PluginsCtx) -> io::Result<()> {
    let mark = restored_mark(ctx);
    let Ok(bytes) = fs::read(&mark) else {
        return Ok(());
    };
    let left: Vec<String> = journals(ctx)?.into_iter().map(|(op, _)| op).collect();
    let pending = match serde_json::from_slice::<Vec<String>>(&bytes) {
        Ok(ops) => ops.iter().any(|op| left.contains(op)),
        Err(_) => !left.is_empty(),
    };
    if !pending {
        fs::remove_file(&mark)?;
    }
    Ok(())
}

/// What the startup recovery did.
#[derive(Debug, Default)]
pub struct RecoveryReport {
    pub finished: usize,
    pub rolled_back: usize,
    /// (install name, agent) marked [`HostState::NeedsRepair`].
    pub needs_repair: Vec<(String, AgentWire)>,
    pub problems: Vec<String>,
}

/// Finish or roll back every journal (see the module docs), then clear
/// staging that no journal owns and empty the trash. Never runs a host
/// command. Takes the plugins lock's guard: run it at startup before the
/// skills journals are recovered.
pub fn recover(ctx: &PluginsCtx, _lock: &PluginsGuard) -> RecoveryReport {
    let mut report = RecoveryReport::default();
    let mut waiting: BTreeSet<String> = BTreeSet::new();
    let scanned = match journals(ctx) {
        Ok(scanned) => Some(scanned),
        Err(error) => {
            report.problems.push(format!(
                "{}: the journals cannot be listed ({error}); nothing is cleared",
                ctx.ops_dir().display()
            ));
            None
        }
    };
    let complete = scanned.is_some();
    for (op, journal) in scanned.unwrap_or_default() {
        let path = ctx.journal_path(&op);
        let journal = match journal {
            Ok(journal) => journal,
            Err(why) => {
                report
                    .problems
                    .push(format!("{}: {why}; left as it is", path.display()));
                waiting.insert(op);
                continue;
            }
        };
        let name = match InstallName::parse(&journal.name) {
            Some(name) if journal.op == op => name,
            _ => {
                report.problems.push(format!(
                    "{}: the journal does not belong here; left as it is",
                    path.display()
                ));
                waiting.insert(op);
                continue;
            }
        };
        // A record in a newer format is not this Codeg's to act on: not even
        // to finish (its entries may mean more than this one reads).
        let current = match record::load_for_write(ctx) {
            Ok(record) if case_alias(&record, &name).is_some() => {
                report.problems.push(format!(
                    "{}: the record holds another spelling of {name}; the journal waits",
                    path.display()
                ));
                waiting.insert(op);
                continue;
            }
            Ok(record) => record.plugins.get(name.as_str()).cloned(),
            Err(error) => {
                report.problems.push(format!(
                    "{}: {}; the journal waits",
                    path.display(),
                    error.detail()
                ));
                waiting.insert(op);
                continue;
            }
        };
        let stand = if journal.rolling_back {
            // Its rollback may have written the record already: it goes on.
            Stand::Before
        } else {
            stand(&journal, current.as_ref())
        };
        match stand {
            Stand::Committed => match finish(ctx, &name, &journal) {
                Ok(problems) => {
                    report.finished += 1;
                    report.problems.extend(problems);
                }
                Err(error) => {
                    report
                        .problems
                        .push(format!("{}: finishing failed ({error})", path.display()));
                    waiting.insert(op);
                }
            },
            stand => {
                if stand == Stand::Foreign {
                    report.problems.push(format!(
                        "{}: the record is not the one this operation knew (a restored backup?)",
                        path.display()
                    ));
                }
                let touched = match (&journal.rolling_back, &journal.repair) {
                    (true, Some(repair)) => repair.iter().cloned().collect(),
                    _ => journal.touched(),
                };
                match roll_back(ctx, &name, &journal, &touched) {
                    Ok(marked) => {
                        report.rolled_back += 1;
                        report.needs_repair.extend(
                            marked
                                .into_iter()
                                .map(|agent| (name.as_str().to_string(), agent)),
                        );
                    }
                    Err(error) => {
                        report
                            .problems
                            .push(format!("{}: rolling back failed ({error})", path.display()));
                        waiting.insert(op);
                    }
                }
            }
        }
    }
    if !complete {
        return report;
    }
    // Staging no journal owns, and our own temporary files in `.ops`; only
    // under folders that are the store's own, not links out of it.
    let staging_ok = match store::housekeeping_dir(&ctx.staging_root()) {
        Ok(_) => true,
        Err(error) => {
            report.problems.push(error.to_string());
            false
        }
    };
    if let Some(entries) = staging_ok
        .then(|| fs::read_dir(ctx.staging_root()).ok())
        .flatten()
    {
        for entry in entries.flatten() {
            let op = entry.file_name().to_string_lossy().into_owned();
            if !waiting.contains(&op) {
                if let Err(error) = clear_staging(ctx, &op) {
                    report
                        .problems
                        .push(format!("{}: {error}", ctx.staging_dir(&op).display()));
                }
            }
        }
    }
    if let Some(entries) = matches!(store::housekeeping_dir(&ctx.ops_dir()), Ok(true))
        .then(|| fs::read_dir(ctx.ops_dir()).ok())
        .flatten()
    {
        for entry in entries.flatten() {
            let file_name = entry.file_name().to_string_lossy().into_owned();
            if file_name.starts_with('.') && file_name.ends_with(".tmp") {
                let _ = fs::remove_file(entry.path());
            }
        }
        remove_if_empty(&ctx.ops_dir());
    }
    if staging_ok {
        remove_if_empty(&ctx.root.join(STAGING_DIR));
    }
    if let Err(error) = store::empty_trash(ctx) {
        report
            .problems
            .push(format!("{}: {error}", ctx.trash_dir().display()));
    }
    report
}
