//! Root-lease-only retention. Records are unlinked durably before object sweep.
//! In-progress capture objects are pinned in memory; their owner holds the lease.
//! Recovery journals pin both sides of every write, even after commit/IO failure.
use super::storage::{sync_dir, Record, Store};
use super::{restore, workspace, CaptureControl};
use crate::models::agent::AgentType;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

pub(super) const MAX_RECORDS: usize = 100;
pub(super) const MAX_OBJECT_BYTES: u64 = 512 * 1024 * 1024;
const MAX_AGE_MS: i64 = 30 * 24 * 60 * 60 * 1000;
// A fork can briefly hold a full parent and child prefix. Copying must not GC
// its source or a PreparedRestore's in-memory plan. The next collection applies
// the normal 100-record limit; writes cannot grow beyond this bounded allowance.
pub(super) const MAX_RECORD_FILES: usize = MAX_RECORDS * 2 + 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointStatus {
    pub enabled: bool,
    pub record_count: usize,
    pub object_bytes: u64,
    pub max_records: usize,
    pub max_object_bytes: u64,
    pub last_error: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct Settings {
    pub enabled: bool,
    pub last_error: Option<String>,
}

fn check(control: Option<&CaptureControl>) -> Result<(), String> {
    control.map_or(Ok(()), CaptureControl::check)
}

pub(super) fn complete(record: &Record) -> bool {
    record.finished_ms.is_some() && record.before.is_some()
        && record.after.is_some() && !record.prompt.is_empty()
}

fn references(record: &Record) -> impl Iterator<Item = &String> {
    record.before.iter().chain(record.after.iter())
        .flat_map(|s| s.files.values().map(|e| &e.object))
}

impl Store {
    pub fn settings(&self) -> Result<Settings, String> {
        let path = self.dir.join("settings.json");
        if !path.try_exists().map_err(|e| e.to_string())? { return Ok(Settings::default()); }
        self.read_json(&path)
    }

    pub fn set_enabled(&self, enabled: bool) -> Result<(), String> {
        let mut settings = self.settings()?;
        settings.enabled = enabled;
        self.write_json(&self.dir.join("settings.json"), &settings)
    }

    /// Called while the root lease is still held. Diagnostic failure must never
    /// turn failed coverage into success or hide the original error.
    pub fn report<T>(&self, result: Result<T, String>) -> Result<T, String> {
        let diagnostic = || -> Result<(), String> {
            let mut settings = self.settings()?;
            settings.last_error = result.as_ref().err().map(|e| e.chars().take(2048).collect());
            self.write_json(&self.dir.join("settings.json"), &settings)
        };
        if let Err(error) = diagnostic() { tracing::warn!(%error, "Cannot persist checkpoint diagnostic"); }
        result
    }

    pub fn records(&self, control: Option<&CaptureControl>) -> Result<Vec<(PathBuf, Record)>, String> {
        let dir = self.dir.join("records");
        workspace::validate_absolute(&dir)?;
        let mut records = Vec::new();
        for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
            check(control)?;
            let path = entry.map_err(|e| e.to_string())?.path();
            // A crash during atomic_write can leave a temporary file. It never
            // publishes coverage and is swept after validating the real records.
            if path.extension().is_none_or(|s| s != "json") { continue; }
            let record: Record = self.read_json(&path)?;
            if record.version != 1 || self.record_path(&record) != path {
                return Err("Invalid checkpoint record identity during retention".into());
            }
            records.push((path, record));
        }
        check(control)?;
        Ok(records)
    }

    fn objects(&self, control: Option<&CaptureControl>) -> Result<HashMap<String, (PathBuf, u64)>, String> {
        let dir = self.dir.join("objects");
        workspace::validate_absolute(&dir)?;
        let mut objects = HashMap::new();
        for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
            check(control)?;
            let path = entry.map_err(|e| e.to_string())?.path();
            let size = workspace::regular_metadata(&path)?.len();
            let name = path.file_name().and_then(|n| n.to_str()).ok_or("Invalid checkpoint object filename")?.to_owned();
            objects.insert(name, (path, size));
        }
        Ok(objects)
    }

    pub fn status(&self) -> Result<CheckpointStatus, String> {
        let settings = self.settings()?;
        Ok(CheckpointStatus {
            enabled: settings.enabled,
            record_count: self.records(None)?.len(),
            object_bytes: self.objects(None)?.values().map(|(_, size)| size).sum(),
            max_records: MAX_RECORD_FILES,
            max_object_bytes: self.max_object_bytes(),
            last_error: settings.last_error.or_else(|| self.journal_path().exists()
                .then(|| "Unresolved checkpoint recovery journal".into())),
        })
    }

    pub fn max_object_bytes(&self) -> u64 {
        #[cfg(test)]
        if let Some(limit) = self.object_limit { return limit; }
        MAX_OBJECT_BYTES
    }

    /// Caller holds the root lease. `active` protects the incomplete record;
    /// `pins` additionally protects every object encountered by the current scan.
    /// Reserve is checked *before* writing another object. Journal pins survive
    /// record eviction, so neither restore nor compensation can lose its bytes.
    pub fn collect(
        &self, active: Option<&Path>, pins: &HashSet<String>, reserve: u64,
        control: Option<&CaptureControl>,
    ) -> Result<u64, String> {
        check(control)?;
        let records = self.records(control)?;
        // Parse the journal before any deletion. Invalid metadata fails closed.
        let mut pinned = restore::recovery_objects(self)?;
        pinned.extend(pins.iter().cloned());
        let mut refs: HashMap<String, usize> = HashMap::new();
        let mut retained = Vec::new();
        let mut remove = Vec::new();
        let cutoff = chrono::Utc::now().timestamp_millis().saturating_sub(MAX_AGE_MS);
        for (path, record) in records {
            check(control)?;
            let protected = active == Some(path.as_path());
            if !protected && (!complete(&record) || record.finished_ms.unwrap_or(0) < cutoff) {
                remove.push(path);
            } else {
                for id in references(&record) { *refs.entry(id.clone()).or_default() += 1; }
                retained.push((path, record, protected));
            }
        }
        retained.sort_by(|a, b| (a.1.finished_ms, a.1.started_ms, &a.0).cmp(&(b.1.finished_ms, b.1.started_ms, &b.0)));
        let objects = self.objects(control)?;
        let mut bytes: u64 = objects.iter().filter(|(id, _)| refs.contains_key(*id) || pinned.contains(*id))
            .map(|(_, (_, size))| size).sum();
        // Reserve a slot for the current pending capture before it publishes.
        let mut completed = retained.iter().filter(|(_, r, protected)| complete(r) || *protected).count();
        for (path, record, protected) in &retained {
            check(control)?;
            if *protected { continue; }
            if completed <= MAX_RECORDS && bytes.saturating_add(reserve) <= self.max_object_bytes() { break; }
            remove.push(path.clone());
            completed -= usize::from(complete(record));
            for id in references(record) {
                let count = refs.get_mut(id).expect("retained object reference");
                *count -= 1;
                if *count == 0 && !pinned.contains(id) {
                    bytes = bytes.saturating_sub(objects.get(id).map_or(0, |(_, size)| *size));
                }
            }
        }
        for path in remove {
            check(control)?;
            workspace::validate_absolute(&path)?;
            fs::remove_file(path).map_err(|e| e.to_string())?;
        }
        // An interrupted record deletion leaves extra objects, never lost refs.
        sync_dir(&self.dir.join("records"))?;
        for (id, (path, _)) in &objects {
            check(control)?;
            if refs.get(id).copied().unwrap_or(0) == 0 && !pinned.contains(id) {
                fs::remove_file(path).map_err(|e| e.to_string())?;
            }
        }
        sync_dir(&self.dir.join("objects"))?;
        // Remove abandoned atomic-write metadata, bounding even failed captures.
        for entry in fs::read_dir(self.dir.join("records")).map_err(|e| e.to_string())? {
            check(control)?;
            let path = entry.map_err(|e| e.to_string())?.path();
            if path.extension().is_none_or(|s| s != "json") {
                workspace::regular_metadata(&path)?;
                fs::remove_file(path).map_err(|e| e.to_string())?;
            }
        }
        check(control)?;
        if bytes.saturating_add(reserve) > self.max_object_bytes() {
            return Err("Checkpoint object quota exceeded by protected coverage; coverage unavailable".into());
        }
        Ok(bytes)
    }

    /// Copy existing completed prefix slots without renumbering. Gaps stay gaps.
    /// No GC runs during copy: parent coverage and any live restore plan remain
    /// intact. A fixed burst allowance bounds metadata until the next collection.
    pub fn inherit_prefix(&self, agent: AgentType, parent: &str, child: &str, retained: usize) -> Result<(), String> {
        if parent == child { return Err("Checkpoint destination must be a new session".into()); }
        if retained == 0 { return Ok(()); }
        let records = self.records(None)?;
        if records.is_empty() { return Ok(()); }
        let mut copies = Vec::new();
        for (_, record) in &records {
            if record.agent == agent && record.session == parent && record.user_index < retained && complete(record) {
                let mut copy = record.clone();
                copy.session = child.into();
                if self.record_path(&copy).exists() {
                    let old: Record = self.read_json(&self.record_path(&copy))?;
                    if serde_json::to_vec(&old).map_err(|e| e.to_string())? != serde_json::to_vec(&copy).map_err(|e| e.to_string())? {
                        return Err("Checkpoint child prefix already differs".into());
                    }
                } else { copies.push(copy); }
            }
        }
        if records.len() + copies.len() > MAX_RECORD_FILES {
            return Err("Checkpoint prefix metadata quota exceeded; run cleanup before editing".into());
        }
        for record in copies { self.write_record(&record)?; }
        Ok(())
    }
}
