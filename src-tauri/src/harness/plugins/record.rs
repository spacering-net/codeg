//! The plugins record: `~/.codeg/harness/plugins.json`, what Codeg installed
//! from Harness as a plugin, and how each agent has it.
//!
//! ```json
//! { "format": 1,
//!   "plugins": {
//!     "superpowers": {
//!       "item_id": "…", "ref": "obra/superpowers",
//!       "revision": 4, "version": "7.0.2",
//!       "archive_sha256": "…", "source": null,
//!       "files": [{ "path": "…", "sha256": "…", "size": 12, "executable": false }],
//!       "exec_sha256": "…", "state_sha256": "…",
//!       "autorun": [{ "host": "claude", "type": "hook", "path": "hooks/hooks.json", "event": "SessionStart" }],
//!       "consent": { "exec": "…", "at": "2026-11-19T09:30:00.000Z" },
//!       "hosts": {
//!         "claude_code": { "mode": "native", "state": "active", "skills": [],
//!                          "host_name": "superpowers" },
//!         "gemini": { "mode": "skills", "state": { "suspended": { "reason": "revision_yanked" } },
//!                     "skills": ["brainstorming"] } },
//!       "previous_revision": 3,
//!       "installed_at": "2026-11-19T09:30:00.000Z",
//!       "op": "20261119T093000-…" } } }
//! ```
//!
//! Keyed by install name ([`super::ctx::InstallName`]); the hosts by Codeg
//! agent as the agent is named on the wire (skills only applies to any
//! agent; the adapters map an agent to the website's host id). One revision
//! for every host. `op` is the operation that last wrote the entry: the
//! journal tells by it whether its operation got as far as the record.
//!
//! Written whole (a temp file beside it, synced, renamed over it; a new file
//! is the owner's alone, 0600) and only under the plugins lock. Fields a
//! newer Codeg adds are kept when this one rewrites the file; a record in a
//! newer format is never rewritten. A host mode or state this Codeg does not
//! know makes the record unreadable — never something to guess at — so a
//! newer Codeg that adds one raises the format.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::commands::mcp_engine::fsio;
use crate::harness::types::{AutorunPart, ComponentKind, FileEntry, PluginComponent, Source};
use crate::skills::owned::ExpertLink;

use super::ctx::PluginsCtx;

/// The format this Codeg reads and writes.
pub const FORMAT: u32 = 1;

/// The key of [`Record::plugins`]: an install name as written (checked with
/// [`super::ctx::InstallName::parse`] before it names a path).
pub type InstallNameKey = String;
/// The key of [`PluginEntry::hosts`]: a Codeg agent's wire id
/// (`AgentType::as_wire`). A name this Codeg does not know is kept.
pub type AgentWire = String;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Record {
    #[serde(default)]
    pub format: u32,
    #[serde(default)]
    pub plugins: BTreeMap<InstallNameKey, PluginEntry>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Default for Record {
    fn default() -> Self {
        Self {
            format: FORMAT,
            plugins: BTreeMap::new(),
            extra: Map::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginEntry {
    pub item_id: String,
    #[serde(rename = "ref")]
    pub item_ref: String,
    pub revision: u64,
    #[serde(default)]
    pub version: Option<String>,
    /// The archive's SHA-256, for a package that came as one.
    #[serde(default)]
    pub archive_sha256: Option<String>,
    /// Where the files came from, for a package that came file by file.
    #[serde(default)]
    pub source: Option<RecordSource>,
    /// The revision's files as listed: what `<root>/<name>/<revision>/`
    /// holds.
    #[serde(default)]
    pub files: Vec<RecordFile>,
    pub exec_sha256: String,
    /// What runs on its own once installed whole, as the install info
    /// listed it.
    #[serde(default)]
    pub autorun: Vec<AutorunEntry>,
    /// The revision's members (skills, assistants) as the install info
    /// listed them: what an agent's skills are read from, and what a later
    /// revision is compared with. Empty in an entry written before it was
    /// kept (read from the install info then).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub components: Vec<RecordComponent>,
    /// The fingerprint of the version's state the user agreed to.
    pub state_sha256: String,
    /// The user's agreement to what runs on its own, for the `exec_sha256`
    /// they saw. `None`: nothing was agreed to (skills only, or nothing
    /// runs).
    #[serde(default)]
    pub consent: Option<Consent>,
    #[serde(default)]
    pub hosts: BTreeMap<AgentWire, HostEntry>,
    /// The revision before this one, kept on disk until the next operation
    /// on the plugin (Claude Code loads a plugin from where it is).
    #[serde(default)]
    pub previous_revision: Option<u64>,
    /// Revisions an interrupted operation left that an agent needing
    /// repair may load from: kept while any agent needs repair. The
    /// operation that repairs them clears this.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub held_revisions: Vec<u64>,
    pub installed_at: String,
    /// The operation that last wrote this entry.
    pub op: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl PluginEntry {
    /// The revisions its folder must keep: this one, the one before, and —
    /// while an agent needs repair — those held for it.
    pub fn kept_revisions(&self) -> Vec<u64> {
        let mut keep = vec![self.revision];
        keep.extend(self.previous_revision);
        if self
            .hosts
            .values()
            .any(|host| host.state == HostState::NeedsRepair)
        {
            keep.extend(self.held_revisions.iter().copied());
        }
        keep.sort_unstable();
        keep.dedup();
        keep
    }

    /// The files as the store checks them.
    pub fn listing(&self) -> Vec<FileEntry> {
        self.files.iter().map(RecordFile::to_entry).collect()
    }
}

/// One listed file (`FileEntry`), with whatever else a newer Codeg wrote.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecordFile {
    pub path: String,
    pub sha256: String,
    pub size: u64,
    #[serde(default)]
    pub executable: bool,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl RecordFile {
    pub fn to_entry(&self) -> FileEntry {
        FileEntry {
            path: self.path.clone(),
            sha256: self.sha256.clone(),
            size: self.size,
            executable: self.executable,
        }
    }
}

impl From<&FileEntry> for RecordFile {
    fn from(file: &FileEntry) -> Self {
        Self {
            path: file.path.clone(),
            sha256: file.sha256.clone(),
            size: file.size,
            executable: file.executable,
            extra: Map::new(),
        }
    }
}

/// One member (`PluginComponent`). Its kind is kept as written, so that a
/// kind this Codeg does not know survives a rewrite unchanged.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecordComponent {
    pub kind: String,
    pub name: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tree_sha256: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl RecordComponent {
    pub fn to_component(&self) -> PluginComponent {
        PluginComponent {
            kind: serde_json::from_value(Value::String(self.kind.clone()))
                .unwrap_or(ComponentKind::Unknown),
            name: self.name.clone(),
            path: self.path.clone(),
            summary: None,
            tree_sha256: self.tree_sha256.clone(),
        }
    }
}

impl From<&PluginComponent> for RecordComponent {
    fn from(component: &PluginComponent) -> Self {
        Self {
            kind: serde_json::to_value(component.kind)
                .ok()
                .and_then(|value| value.as_str().map(str::to_string))
                .unwrap_or_else(|| "unknown".to_string()),
            name: component.name.clone(),
            path: component.path.clone(),
            tree_sha256: component.tree_sha256.clone(),
            extra: Map::new(),
        }
    }
}

impl From<&RecordSource> for Source {
    fn from(source: &RecordSource) -> Self {
        Source {
            repository: source.repository.clone(),
            commit: source.commit.clone(),
            path: source.path.clone(),
        }
    }
}

/// Where a package without an archive came from (`Source`), with whatever
/// else a newer Codeg wrote.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecordSource {
    pub repository: String,
    pub commit: String,
    pub path: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl From<&Source> for RecordSource {
    fn from(source: &Source) -> Self {
        Self {
            repository: source.repository.clone(),
            commit: source.commit.clone(),
            path: source.path.clone(),
            extra: Map::new(),
        }
    }
}

/// One part that runs on its own. Its type is kept as written, so that a
/// type this Codeg does not know survives a rewrite unchanged.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AutorunEntry {
    /// The website's host id the part belongs to.
    pub host: String,
    #[serde(rename = "type")]
    pub part_type: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl From<&AutorunPart> for AutorunEntry {
    fn from(part: &AutorunPart) -> Self {
        Self {
            host: part.host.clone(),
            part_type: serde_json::to_value(part.r#type)
                .ok()
                .and_then(|value| value.as_str().map(str::to_string))
                .unwrap_or_else(|| "unknown".to_string()),
            path: part.path.clone(),
            event: part.event.clone(),
            name: part.name.clone(),
            command: part.command.clone(),
            extra: Map::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Consent {
    /// The `exec_sha256` agreed to.
    pub exec: String,
    pub at: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// How one agent has the plugin.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostEntry {
    pub mode: HostMode,
    pub state: HostState,
    /// Skills only: the member skills put into the agent (their names in the
    /// skill store).
    #[serde(default)]
    pub skills: Vec<String>,
    /// Native: the name the host knows the plugin by, as its adapter's
    /// install returned it (`HostPlugin::with_host_name`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_name: Option<String>,
    /// The Experts pack's links of the same names that the install took out
    /// of the agent's directories: given back when the plugin leaves the
    /// agent (each only if the user left its place alone).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub experts: Vec<ExpertLink>,
    /// `NeedsRepair`: what the operation that stopped left to know (written
    /// when the agent is marked; the repair clears it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repair: Option<RepairNote>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl HostEntry {
    /// `mode`, active, nothing else yet.
    pub fn new(mode: HostMode) -> Self {
        Self {
            mode,
            state: HostState::Active,
            skills: Vec::new(),
            host_name: None,
            experts: Vec::new(),
            repair: None,
            extra: Map::new(),
        }
    }

    /// Mark the agent as needing repair, noting the state it had (once) and
    /// `other_modes`: modes the operation's steps used besides `mode` — what
    /// the agent may have of the plugin the other way.
    pub fn mark_needs_repair(&mut self, other_modes: impl IntoIterator<Item = HostMode>) {
        let mut note = self.repair.take().unwrap_or_default();
        if self.state != HostState::NeedsRepair && note.was.is_none() {
            note.was = Some(self.state.clone());
        }
        for mode in other_modes {
            if mode != self.mode && !note.other_modes.contains(&mode) {
                note.other_modes.push(mode);
            }
        }
        self.state = HostState::NeedsRepair;
        self.repair = Some(note);
    }
}

/// Why an agent needs repair, as far as the operation that stopped knew.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepairNote {
    /// The state it had before (none: it had nothing of the plugin, or this
    /// is not known). A repair brings it back to that, never further on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub was: Option<HostState>,
    /// The other mode a step may have left the plugin in (a change of mode
    /// cut short): taken out by the repair.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub other_modes: Vec<HostMode>,
    /// An uninstall stopped on this agent: the repair takes the plugin out
    /// of it (again) and the agent out of the record — it never puts the
    /// plugin back.
    #[serde(default, skip_serializing_if = "is_false")]
    pub uninstalling: bool,
    /// Codeg's backup was restored over the plugin store, the record or the
    /// skill store: what the agent has is as old as the backup at best. The
    /// repair only checks the host against the record, switches off and
    /// repoints what does not match (as a plugin; skills only: puts the
    /// members back as the record says) — it never puts a plugin into a
    /// host or switches one on.
    #[serde(default, skip_serializing_if = "is_false")]
    pub restored: bool,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

impl HostEntry {
    /// Mark the agent as needing repair after an uninstall stopped on it:
    /// the repair finishes the uninstall.
    pub fn mark_uninstalling(&mut self) {
        self.mark_needs_repair([]);
        if let Some(note) = self.repair.as_mut() {
            note.uninstalling = true;
        }
    }

    /// Mark the agent as needing repair after a backup was restored (see
    /// [`RepairNote::restored`]).
    pub fn mark_restored(&mut self) {
        self.mark_needs_repair([]);
        if let Some(note) = self.repair.as_mut() {
            note.restored = true;
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HostMode {
    /// Installed whole, through the host's own plugin system.
    Native,
    /// Its skills only, through Codeg's skill store.
    Skills,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HostState {
    Active,
    /// The user turned it off.
    DisabledByUser,
    /// Codeg turned it off because SRN no longer vouches for the revision;
    /// only an update turns it back on.
    Suspended {
        reason: String,
        #[serde(flatten)]
        extra: Map<String, Value>,
    },
    /// An operation stopped partway through on this agent: what the agent
    /// has is not known to match the record.
    NeedsRepair,
}

impl HostState {
    pub fn suspended(reason: impl Into<String>) -> Self {
        HostState::Suspended {
            reason: reason.into(),
            extra: Map::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecordError {
    /// It is there and cannot be read as a record.
    Unreadable(String),
    /// A newer Codeg wrote it in a format this one does not know.
    Newer(u32),
}

impl RecordError {
    pub fn detail(&self) -> String {
        match self {
            RecordError::Unreadable(why) => why.clone(),
            RecordError::Newer(format) => format!("written by a newer Codeg (format {format})"),
        }
    }
}

impl std::fmt::Display for RecordError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "the plugins record cannot be used: {}", self.detail())
    }
}

impl std::error::Error for RecordError {}

impl From<RecordError> for std::io::Error {
    fn from(error: RecordError) -> Self {
        std::io::Error::other(error)
    }
}

fn read(path: &Path) -> Result<Option<Record>, RecordError> {
    match fsio::read_bytes(path) {
        Ok(None) => Ok(None),
        Ok(Some(bytes)) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|error| RecordError::Unreadable(format!("{}: {error}", path.display()))),
        Err(error) => Err(RecordError::Unreadable(format!(
            "{}: {error}",
            path.display()
        ))),
    }
}

/// The record; an empty one when there is none yet. A newer format is read
/// as far as this Codeg understands it (to show it), never written back.
pub fn load(ctx: &PluginsCtx) -> Result<Record, RecordError> {
    Ok(read(&ctx.record)?.unwrap_or_default())
}

/// [`load`], for a caller that will write it back: a format this Codeg does
/// not know is refused.
pub fn load_for_write(ctx: &PluginsCtx) -> Result<Record, RecordError> {
    let record = load(ctx)?;
    if record.format > FORMAT {
        return Err(RecordError::Newer(record.format));
    }
    Ok(record)
}

/// After Codeg's backup was restored: what the record from before the
/// restore (`before`, kept in the restore's safety snapshot) had that the
/// restored one lacks — a plugin installed since the backup, an agent added
/// since — goes back in: the hosts may still have it, and only the record
/// lets it be repaired or uninstalled. Where the two disagree (the
/// restored record has the name for another item, or the item under another
/// name), the entry from before wins. `before` missing,
/// unreadable or newer: nothing. Returns what was carried, as
/// `name` / `name:agent`. The caller holds the plugins lock (and marks
/// everything for repair next, [`mark_restored`]).
pub fn carry_after_restore(
    ctx: &PluginsCtx,
    _lock: &super::lock::PluginsGuard,
    before: &Path,
) -> std::io::Result<Vec<String>> {
    let Ok(Some(before)) = read(before) else {
        return Ok(Vec::new());
    };
    if before.format > FORMAT {
        return Ok(Vec::new());
    }
    let Ok(mut record) = load_for_write(ctx) else {
        return Ok(Vec::new());
    };
    let restored = record.clone();
    let mut carried = Vec::new();
    for (name, old) in before.plugins {
        let key = record
            .plugins
            .iter()
            .find(|(key, entry)| key.eq_ignore_ascii_case(&name) && entry.item_id == old.item_id)
            .map(|(key, _)| key.clone());
        match key {
            // Not there as it was: the entry from before is what the hosts
            // have now, so it wins over whatever restored entry has its name
            // or its item (one name, one item, one entry). The entries from
            // before agree with each other, so the order they come in, and
            // a retry, end the same.
            None => {
                record.plugins.retain(|other, entry| {
                    let stale =
                        other.eq_ignore_ascii_case(&name) || entry.item_id == old.item_id;
                    if stale {
                        tracing::warn!(
                            "[Harness plugins] after the restore, {other} gives way to {name} from before"
                        );
                    }
                    !stale
                });
                carried.push(name.clone());
                record.plugins.insert(name, old);
            }
            Some(key) => {
                let entry = record.plugins.get_mut(&key).expect("found above");
                for (agent, old_host) in old.hosts {
                    match entry.hosts.entry(agent) {
                        std::collections::btree_map::Entry::Vacant(slot) => {
                            carried.push(format!("{key}:{}", slot.key()));
                            slot.insert(old_host);
                        }
                        std::collections::btree_map::Entry::Occupied(mut slot) => {
                            // The agent had it the other way since: the
                            // repair takes that way out (and needs the name
                            // the host knows it by); the Experts links it
                            // took are still to be given back.
                            let agent = slot.key().clone();
                            let host = slot.get_mut();
                            if old_host.mode != host.mode {
                                carried.push(format!("{key}:{agent}:{:?}", old_host.mode));
                                host.mark_needs_repair([old_host.mode]);
                                if host.host_name.is_none() {
                                    host.host_name = old_host.host_name.clone();
                                }
                            }
                            for link in old_host.experts {
                                if !host.experts.contains(&link) {
                                    host.experts.push(link);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    if record != restored {
        save(ctx, &record)?;
    }
    Ok(carried)
}

/// After Codeg's backup was restored over the plugin store, the record or
/// the skill store: every agent of every plugin marked as needing repair
/// (`RepairNote::restored`; one that needs it already keeps its note too).
/// Returns how many agents; `Ok(None)`: the record cannot be read (or a
/// newer Codeg wrote it), and is left as it is. No record: none. The caller
/// holds the plugins lock.
pub fn mark_restored(
    ctx: &PluginsCtx,
    lock: &super::lock::PluginsGuard,
) -> std::io::Result<Option<usize>> {
    mark_restored_where(ctx, lock, |_, _| true)
}

/// [`mark_restored`] for the agents `which(install name, agent)` picks.
pub fn mark_restored_where(
    ctx: &PluginsCtx,
    _lock: &super::lock::PluginsGuard,
    which: impl Fn(&str, &str) -> bool,
) -> std::io::Result<Option<usize>> {
    let Ok(mut record) = load_for_write(ctx) else {
        return Ok(None);
    };
    let mut marked = 0;
    for (name, entry) in record.plugins.iter_mut() {
        for (agent, host) in entry.hosts.iter_mut() {
            if which(name, agent) {
                host.mark_restored();
                marked += 1;
            }
        }
    }
    if marked > 0 {
        save(ctx, &record)?;
    }
    Ok(Some(marked))
}

/// Write the record whole. The caller holds the plugins lock. Refuses —
/// and leaves the file as it is — when the record given, or the one on disk,
/// is in a newer format, or the one on disk cannot be read.
pub fn save(ctx: &PluginsCtx, record: &Record) -> std::io::Result<()> {
    if record.format > FORMAT {
        return Err(RecordError::Newer(record.format).into());
    }
    if let Some(on_disk) = read(&ctx.record)? {
        if on_disk.format > FORMAT {
            return Err(RecordError::Newer(on_disk.format).into());
        }
    }
    ctx.fault("record_save")?;
    let mut record = record.clone();
    record.format = FORMAT;
    let mut bytes = serde_json::to_vec_pretty(&record).map_err(std::io::Error::other)?;
    bytes.push(b'\n');
    fsio::write_atomic(&ctx.record, &bytes)
}
