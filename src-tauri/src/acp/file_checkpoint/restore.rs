use super::storage::{hash, sync_dir, Record, RootGuard, Store};
use super::workspace::{self, Entry};
use crate::models::agent::AgentType;
use crate::models::message::MessageTurn;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePreview {
    pub token: String,
    pub files: Vec<RestoreFile>,
    pub conflicts: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreFile {
    pub path: String,
    /// Operation performed by restore: created, modified or deleted.
    pub change: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Change {
    path: String,
    original: Option<Entry>,
    desired: Option<Entry>,
}

pub(super) struct Plan {
    pub preview: RestorePreview,
    changes: Vec<Change>,
    scope: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct Journal {
    version: u32,
    /// Version 2 publishes this immutable plan once. The small progress file is
    /// tied to this id so an interrupted cleanup cannot replay an older cursor.
    #[serde(default)]
    transaction_id: String,
    #[serde(default)]
    committed: bool,
    #[serde(default)]
    binding: Option<RecoveryBinding>,
    root: PathBuf,
    changes: Vec<Change>,
    /// Legacy v1 cursor. For v2, read_journal overlays the durable progress file.
    attempted: usize,
    #[serde(default)]
    inherited: Vec<InheritedRecord>,
}

#[derive(Debug, Serialize, Deserialize)]
struct Progress {
    version: u32,
    transaction_id: String,
    attempted: usize,
    committed: bool,
    binding: Option<RecoveryBinding>,
}

/// Only records absent at preflight belong to this transaction. Hashing the
/// serialized record lets cleanup refuse a subsequently replaced child slot.
#[derive(Debug, Serialize, Deserialize)]
struct InheritedRecord {
    agent: AgentType,
    session: String,
    user_index: usize,
    fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct RecoveryBinding {
    pub conversation_id: i32,
    pub original_session_id: String,
    pub forked_session_id: String,
}

/// Holds the root OS/process lease until commit, rollback or Drop. All mutation
/// methods perform blocking filesystem IO. No Clone/Serialize: retain one value
/// inside the caller's Arc<tokio::sync::Mutex<_>>, running methods off-runtime.
#[derive(Debug)]
pub struct PreparedRestore {
    store: Store,
    _guard: RootGuard,
    journal: Journal,
    applied: bool,
    settled: bool,
    journal_written: bool,
    scope: String,
    #[cfg(test)]
    pub(super) fail_after: Option<usize>,
}

pub(super) fn plan(
    store: &Store,
    agent: AgentType,
    session: &str,
    index: usize,
    total: usize,
    target: &MessageTurn,
) -> Result<Plan, String> {
    store.ensure_recovered()?;
    if index >= total || total - index > 512 {
        return Err("Checkpoint user range invalid or exceeds retained coverage".into());
    }
    let mut records = Vec::new();
    for i in index..total {
        let record = store
            .read_record(agent, session, i)
            .map_err(|e| format!("Missing checkpoint coverage at user {i}: {e}"))?;
        if record.before.is_none()
            || record.after.is_none()
            || record.finished_ms.is_none()
            || record.prompt.is_empty()
        {
            return Err(format!("Incomplete checkpoint coverage at user {i}"));
        }
        records.push(record);
    }
    let first = &records[0];
    if first.prompt != super::target_fingerprint(agent, target)? {
        return Err("Checkpoint target prompt fingerprint changed".into());
    }
    // Native parsers with no timestamp use the epoch. Otherwise bind the target
    // to this capture's wall-clock interval (allow native second precision).
    let timestamp = target.timestamp.timestamp_millis();
    if timestamp != 0
        && (timestamp < first.started_ms.saturating_sub(2000)
            || timestamp > first.finished_ms.unwrap().saturating_add(2000))
    {
        return Err("Checkpoint target timestamp does not match captured turn".into());
    }
    let scope = &first.before.as_ref().unwrap().scope;
    if workspace::current_scope(store)? != *scope {
        return Err("Current workspace ignore policy differs from checkpoint".into());
    }
    let mut changed = BTreeSet::new();
    for record in &records {
        let (before, after) = (
            record.before.as_ref().unwrap(),
            record.after.as_ref().unwrap(),
        );
        if &before.scope != scope || &after.scope != scope {
            return Err("Checkpoint ignore policy differs across selected turns".into());
        }
        for name in before.files.keys().chain(after.files.keys()) {
            workspace::validate_relative(name)?;
            if before.files.get(name) != after.files.get(name) {
                changed.insert(name.clone());
            }
        }
    }
    let mut conflicts = Vec::new();
    let mut changes = Vec::new();
    let mut files = Vec::new();
    let mut current_states = BTreeMap::new();
    let final_files = &records.last().unwrap().after.as_ref().unwrap().files;
    for path in changed {
        for pair in records.windows(2) {
            if pair[0].after.as_ref().unwrap().files.get(&path)
                != pair[1].before.as_ref().unwrap().files.get(&path)
            {
                conflicts.push(format!("{path}: changed between captured turns"));
            }
        }
        let original = final_files.get(&path).cloned();
        let desired = first.before.as_ref().unwrap().files.get(&path).cloned();
        let actual = workspace::current(&store.root, &path);
        match &actual {
            Ok(current) if *current != original => conflicts.push(format!(
                "{path}: current bytes or mode differ from last checkpoint"
            )),
            Err(e) => conflicts.push(format!("{path}: {e}")),
            _ => {}
        }
        current_states.insert(path.clone(), actual);
        // Validate the entire range even if it ultimately cancels itself out.
        if original != desired {
            files.push(RestoreFile {
                path: path.clone(),
                change: match (&original, &desired) {
                    (None, Some(_)) => "created",
                    (Some(_), None) => "deleted",
                    _ => "modified",
                }
                .into(),
            });
            for state in [&original, &desired].into_iter().flatten() {
                store.object(&state.object)?;
            }
            changes.push(Change {
                path,
                original,
                desired,
            });
        }
    }
    conflicts.sort();
    conflicts.dedup();
    // Include exact target identity, every before/after baseline, current states
    // and all planned operations, not merely a list of filenames or a timestamp.
    let token = hash(
        &serde_json::to_vec(&(
            1,
            &store.root,
            agent,
            session,
            index,
            total,
            target,
            &records,
            &current_states,
            &changes,
            &conflicts,
        ))
        .map_err(|e| e.to_string())?,
    );
    Ok(Plan {
        preview: RestorePreview {
            token,
            files,
            conflicts,
        },
        changes,
        scope: scope.clone(),
    })
}

#[allow(clippy::too_many_arguments)]
pub(super) fn prepare(
    store: Store,
    agent: AgentType,
    session: &str,
    index: usize,
    total: usize,
    target: &MessageTurn,
    token: &str,
) -> Result<PreparedRestore, String> {
    let guard = store.lock()?;
    let plan = plan(&store, agent, session, index, total, target)?;
    if token.is_empty() || token != plan.preview.token {
        return Err("Checkpoint preview changed; preview again before restoring".into());
    }
    if !plan.preview.conflicts.is_empty() {
        return Err(format!(
            "Checkpoint restore conflicts: {}",
            plan.preview.conflicts.join("; ")
        ));
    }
    let journal = Journal {
        version: 2,
        transaction_id: uuid::Uuid::new_v4().to_string(),
        committed: false,
        binding: None,
        root: store.root.clone(),
        changes: plan.changes,
        attempted: 0,
        inherited: Vec::new(),
    };
    Ok(PreparedRestore {
        store,
        _guard: guard,
        journal,
        applied: false,
        settled: false,
        journal_written: false,
        scope: plan.scope,
        #[cfg(test)]
        fail_after: None,
    })
}

impl PreparedRestore {
    /// Copy fork coverage under the lease already held by this transaction.
    /// Invoke off-runtime after fork creation and before database persistence.
    pub fn inherit_prefix(
        &mut self,
        agent: AgentType,
        parent: &str,
        child: &str,
        retained_user_count: usize,
    ) -> Result<(), String> {
        if self.settled || self.journal_written {
            return Err("Checkpoint restore already settled".into());
        }
        if parent == child {
            return Err("Checkpoint destination must be a new session".into());
        }
        let records = self.store.records(None)?;
        let mut copies = Vec::new();
        for (_, record) in &records {
            if record.agent != agent
                || record.session != parent
                || record.user_index >= retained_user_count
                || !super::retention::complete(record)
            {
                continue;
            }
            let mut copy = record.clone();
            copy.session = child.into();
            let path = self.store.record_path(&copy);
            if path.try_exists().map_err(|e| e.to_string())? {
                let old: Record = self.store.read_json(&path)?;
                if record_fingerprint(&old)? != record_fingerprint(&copy)? {
                    return Err("Checkpoint child prefix already differs".into());
                }
            } else {
                copies.push(copy);
            }
        }
        if records.len() + copies.len() > super::retention::MAX_RECORD_FILES {
            return Err(
                "Checkpoint prefix metadata quota exceeded; run cleanup before editing".into(),
            );
        }
        self.journal.inherited = copies
            .iter()
            .map(|record| {
                Ok(InheritedRecord {
                    agent: record.agent,
                    session: record.session.clone(),
                    user_index: record.user_index,
                    fingerprint: record_fingerprint(record)?,
                })
            })
            .collect::<Result<_, String>>()?;
        // The manifest precedes even the first metadata write. A crash before
        // bind_fork has no file/DB side effects, and plain recovery can abort it.
        self.persist_plan()?;
        for record in copies {
            if let Err(error) = self.store.write_record(&record) {
                return match self.rollback() {
                    Ok(()) => Err(error),
                    Err(cleanup) => {
                        Err(format!("{error}; inheritance cleanup required: {cleanup}"))
                    }
                };
            }
        }
        Ok(())
    }
    /// Recorded before the first file write, so crash recovery can consult the
    /// transaction's conversation row instead of guessing whether DB commit won.
    pub fn bind_fork(
        &mut self,
        conversation_id: i32,
        original: &str,
        forked: &str,
    ) -> Result<(), String> {
        if self.settled || self.applied || self.journal.attempted != 0 {
            return Err("Cannot change a started restore transaction".into());
        }
        if original == forked {
            return Err("Restore destination must be a new session".into());
        }
        self.journal.binding = Some(RecoveryBinding {
            conversation_id,
            original_session_id: original.into(),
            forked_session_id: forked.into(),
        });
        if self.journal_written {
            write_progress(&self.store, &self.journal)?;
        }
        Ok(())
    }
    /// Apply the plan with automatic compensation on failure. The journal and
    /// lease remain until the caller commits after persisting its fork session.
    pub fn apply(&mut self) -> Result<(), String> {
        if self.settled {
            return Err("Checkpoint restore already settled".into());
        }
        if self.applied {
            return Ok(());
        }
        if !self.journal_written {
            self.store.ensure_recovered()?;
        }
        if workspace::current_scope(&self.store)? != self.scope {
            return Err("Workspace ignore policy changed since restore preparation".into());
        }
        // Reject every conflict before making any mutation.
        for change in &self.journal.changes {
            if workspace::current(&self.store.root, &change.path)? != change.original {
                return Err(format!(
                    "File changed since restore preparation: {}",
                    change.path
                ));
            }
            if let Some(state) = &change.desired {
                self.store.object(&state.object)?;
            }
        }
        let result = self.apply_inner();
        if let Err(error) = result {
            return match self.rollback() {
                Ok(()) => Err(format!("Restore failed and was compensated: {error}")),
                Err(recovery) => Err(format!(
                    "Restore failed: {error}; recovery required: {recovery}"
                )),
            };
        }
        self.applied = true;
        Ok(())
    }

    fn persist_plan(&mut self) -> Result<(), String> {
        if !self.journal_written {
            self.store.ensure_recovered()?;
            // Remove a sidecar left after durable plan removal. No live plan
            // exists here and the root lease excludes another transaction.
            remove_progress(&self.store)?;
            // Failed rename/fsync may still publish the plan; Drop must clean it.
            self.journal_written = true;
            self.store
                .write_json(&self.store.journal_path(), &self.journal)?;
        }
        Ok(())
    }

    fn apply_inner(&mut self) -> Result<(), String> {
        self.persist_plan()?;
        for (i, change) in self.journal.changes.iter().enumerate() {
            #[cfg(test)]
            if self.fail_after == Some(i) {
                return Err("Injected write failure".into());
            }
            self.journal.attempted = i + 1;
            write_progress(&self.store, &self.journal)?;
            workspace::replace(&self.store, &change.path, &change.original, &change.desired)?;
        }
        Ok(())
    }

    /// Restore pre-apply bytes after failed protocol or DB persistence. Idempotent.
    pub fn rollback(&mut self) -> Result<(), String> {
        if self.settled {
            return Ok(());
        }
        if self.journal_written {
            // A failed progress write may have failed before or after rename.
            // Only the durable cursor identifies files we could have touched.
            if self
                .store
                .journal_path()
                .try_exists()
                .map_err(|e| e.to_string())?
            {
                let durable = read_journal(&self.store)?;
                if durable.transaction_id != self.journal.transaction_id {
                    return Err("Checkpoint recovery journal belongs to another transaction".into());
                }
                compensate(&self.store, &durable)?;
                cleanup_inherited(&self.store, &durable)?;
            }
            remove_journal(&self.store)?;
        }
        self.settled = true;
        self.applied = false;
        Ok(())
    }

    /// Caller has durably persisted the fork session. Removes recovery journal;
    /// dropping an applied but uncommitted value instead compensates best-effort.
    pub fn commit(&mut self) -> Result<(), String> {
        if self.settled {
            return Ok(());
        }
        if !self.applied {
            return Err("Cannot commit a restore before apply".into());
        }
        // External DB persistence has already succeeded. From this instant,
        // neither Drop nor an explicit rollback may undo that committed decision,
        // even if journal persistence/cleanup reports an IO error.
        self.settled = true;
        self.journal.committed = true;
        write_progress(&self.store, &self.journal)?;
        remove_journal(&self.store)
    }
}

/// Retention reads this before any unlink. Even a committed journal pins bytes
/// until durable journal removal; malformed journals stop collection entirely.
pub(super) fn recovery_objects(store: &Store) -> Result<std::collections::HashSet<String>, String> {
    if !store
        .journal_path()
        .try_exists()
        .map_err(|e| e.to_string())?
    {
        return Ok(Default::default());
    }
    let journal = read_journal(store)?;
    Ok(journal
        .changes
        .iter()
        .flat_map(|c| c.original.iter().chain(c.desired.iter()))
        .map(|e| e.object.clone())
        .collect())
}

impl Drop for PreparedRestore {
    fn drop(&mut self) {
        if !self.settled && self.journal_written {
            if let Err(error) = self.rollback() {
                tracing::error!(%error, "Workspace checkpoint compensation incomplete; recovery journal retained");
            }
        }
    }
}

fn compensate(store: &Store, journal: &Journal) -> Result<(), String> {
    validate_journal(store, journal)?;
    if journal.committed {
        return Ok(());
    }
    let mut errors = Vec::new();
    for change in journal.changes[..journal.attempted].iter().rev() {
        let restore = || -> Result<(), String> {
            let current = workspace::current(&store.root, &change.path)?;
            if current == change.original {
                return Ok(());
            }
            if current != change.desired {
                return Err(format!(
                    "{}: changed since restore; refusing compensation overwrite",
                    change.path
                ));
            }
            workspace::replace(store, &change.path, &change.desired, &change.original)
        };
        if let Err(error) = restore() {
            errors.push(error);
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

fn remove_journal(store: &Store) -> Result<(), String> {
    workspace::validate_absolute(&store.journal_path())?;
    match fs::remove_file(store.journal_path()) {
        Ok(()) => sync_dir(&store.dir)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }
    // Plan removal must be durable BEFORE removing its progress; otherwise a
    // surviving plan could be mistaken for a transaction that wrote no files.
    remove_progress(store)
}

pub(super) fn recover(store: &Store) -> Result<(), String> {
    if !store
        .journal_path()
        .try_exists()
        .map_err(|e| e.to_string())?
    {
        return Ok(());
    }
    let journal = read_journal(store)?;
    if journal.binding.is_some() && !journal.committed {
        return Err("File restore requires database reconciliation before recovery".into());
    }
    compensate(store, &journal)?;
    cleanup_inherited(store, &journal)?;
    remove_journal(store)
}

pub(super) fn recovery_binding(store: &Store) -> Result<Option<RecoveryBinding>, String> {
    if !store
        .journal_path()
        .try_exists()
        .map_err(|e| e.to_string())?
    {
        return Ok(None);
    }
    let journal = read_journal(store)?;
    if journal.committed {
        return Ok(None);
    }
    Ok(journal.binding)
}

pub(super) fn recover_decided(store: &Store, committed: bool) -> Result<(), String> {
    if !store
        .journal_path()
        .try_exists()
        .map_err(|e| e.to_string())?
    {
        return Ok(());
    }
    let mut journal = read_journal(store)?;
    journal.committed |= committed;
    compensate(store, &journal)?;
    cleanup_inherited(store, &journal)?;
    remove_journal(store)
}

fn progress_path(store: &Store) -> PathBuf {
    store.dir.join("recovery-progress.json")
}

fn remove_progress(store: &Store) -> Result<(), String> {
    let path = progress_path(store);
    workspace::validate_absolute(&path)?;
    match fs::remove_file(path) {
        Ok(()) => sync_dir(&store.dir),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn write_progress(store: &Store, journal: &Journal) -> Result<(), String> {
    store.write_json(
        &progress_path(store),
        &Progress {
            version: 1,
            transaction_id: journal.transaction_id.clone(),
            attempted: journal.attempted,
            committed: journal.committed,
            binding: journal.binding.clone(),
        },
    )
}

fn validate_journal(store: &Store, journal: &Journal) -> Result<(), String> {
    if !matches!(journal.version, 1 | 2)
        || journal.root != store.root
        || journal.attempted > journal.changes.len()
        || (journal.version == 2 && journal.transaction_id.is_empty())
        || (journal.version == 1 && !journal.inherited.is_empty())
    {
        return Err("Invalid checkpoint recovery journal".into());
    }
    Ok(())
}

fn read_journal(store: &Store) -> Result<Journal, String> {
    let mut journal: Journal = store.read_json(&store.journal_path())?;
    validate_journal(store, &journal)?;
    if journal.version == 2
        && progress_path(store)
            .try_exists()
            .map_err(|e| e.to_string())?
    {
        let progress: Progress = store.read_json(&progress_path(store))?;
        if progress.version != 1 || progress.transaction_id != journal.transaction_id {
            return Err("Checkpoint recovery progress belongs to another transaction".into());
        }
        journal.attempted = progress.attempted;
        journal.committed |= progress.committed;
        journal.binding = progress.binding;
        validate_journal(store, &journal)?;
    }
    Ok(journal)
}

fn record_fingerprint(record: &Record) -> Result<String, String> {
    Ok(hash(
        &serde_json::to_vec(record).map_err(|e| e.to_string())?,
    ))
}

fn cleanup_inherited(store: &Store, journal: &Journal) -> Result<(), String> {
    if journal.committed {
        return Ok(());
    }
    // Validate all still-present copies before unlinking any. Never remove a
    // parent's record or an independently replaced child slot. Missing copies
    // are normal after a partial copy, interrupted cleanup, or retention.
    let mut paths = Vec::new();
    for inherited in &journal.inherited {
        let identity = Record::new(inherited.agent, &inherited.session, inherited.user_index);
        let path = store.record_path(&identity);
        if !path.try_exists().map_err(|e| e.to_string())? {
            continue;
        }
        let record: Record = store.read_json(&path)?;
        if record.agent != inherited.agent
            || record.session != inherited.session
            || record.user_index != inherited.user_index
            || record_fingerprint(&record)? != inherited.fingerprint
        {
            return Err("Inherited checkpoint changed; refusing transaction cleanup".into());
        }
        paths.push(path);
    }
    for path in paths {
        workspace::validate_absolute(&path)?;
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    // Do not sweep objects: a prepared plan or remaining parent may need them.
    sync_dir(&store.dir.join("records"))
}
