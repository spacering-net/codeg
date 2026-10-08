use super::workspace::{self, Snapshot};
use super::{retention::MAX_RECORD_FILES, CaptureControl};
use crate::models::agent::AgentType;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const MAX_JSON: u64 = 16 * 1024 * 1024;

pub(super) fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct Record {
    pub version: u32,
    pub agent: AgentType,
    pub session: String,
    pub user_index: usize,
    pub prompt: String,
    pub started_ms: i64,
    pub finished_ms: Option<i64>,
    pub before: Option<Snapshot>,
    pub after: Option<Snapshot>,
}

impl Record {
    pub fn new(agent: AgentType, session: &str, user_index: usize) -> Self {
        Self {
            version: 1,
            agent,
            session: session.into(),
            user_index,
            prompt: String::new(),
            started_ms: chrono::Utc::now().timestamp_millis(),
            finished_ms: None,
            before: None,
            after: None,
        }
    }
}

#[derive(Debug, Clone)]
pub(super) struct Store {
    pub root: PathBuf,
    pub dir: PathBuf,
    #[cfg(test)]
    pub object_limit: Option<u64>,
}

fn held_roots() -> &'static Mutex<HashSet<PathBuf>> {
    static HELD: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    HELD.get_or_init(|| Mutex::new(HashSet::new()))
}

#[derive(Debug)]
pub(super) struct RootGuard {
    key: PathBuf,
    _file: File,
}

impl Drop for RootGuard {
    fn drop(&mut self) {
        let _ = self._file.unlock();
        held_roots()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.key);
    }
}

fn root_key(root: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        PathBuf::from(root.to_string_lossy().to_lowercase())
    }
    #[cfg(not(windows))]
    {
        root.to_path_buf()
    }
}

impl Store {
    pub fn open(root: &Path) -> Result<Self, String> {
        let base = if std::env::var_os("CODEG_HOME")
            .filter(|v| !v.is_empty())
            .is_some()
        {
            crate::paths::codeg_home_dir()
        } else if let Some(data) = std::env::var_os("CODEG_DATA_DIR").filter(|v| !v.is_empty()) {
            PathBuf::from(data)
        } else {
            crate::paths::codeg_home_dir()
        };
        Self::at(root, &base.join("file-checkpoints"))
    }

    pub fn at(root: &Path, base: &Path) -> Result<Self, String> {
        // Reject links in the user-supplied spelling before canonicalizing.
        workspace::validate_absolute(root)?;
        let root = fs::canonicalize(root).map_err(|e| format!("Checkpoint root: {e}"))?;
        if !root.is_dir() {
            return Err("Checkpoint root is not a directory".into());
        }
        let absolute_base = std::path::absolute(base).map_err(|e| e.to_string())?;
        if root_key(&absolute_base).starts_with(root_key(&root)) {
            return Err("Checkpoint data must live outside the workspace".into());
        }
        workspace::validate_absolute(&absolute_base)?;
        fs::create_dir_all(&absolute_base).map_err(|e| e.to_string())?;
        let base = fs::canonicalize(&absolute_base).map_err(|e| e.to_string())?;
        if root_key(&base).starts_with(root_key(&root)) {
            return Err("Checkpoint data resolves inside workspace".into());
        }
        let key = root_key(&root);
        let key = key.to_str().ok_or("Checkpoint root must be UTF-8")?;
        let dir = base.join(hash(key.as_bytes()));
        workspace::validate_absolute(&dir)?;
        for sub in ["", "objects", "records"] {
            let path = dir.join(sub);
            workspace::validate_absolute(&path)?;
            fs::create_dir_all(&path).map_err(|e| e.to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
                    .map_err(|e| e.to_string())?;
            }
        }
        Ok(Self {
            root,
            dir,
            #[cfg(test)]
            object_limit: None,
        })
    }

    pub fn lock(&self) -> Result<RootGuard, String> {
        let key = root_key(&self.root);
        let mut held = held_roots().lock().unwrap_or_else(|e| e.into_inner());
        if held
            .iter()
            .any(|other| key.starts_with(other) || other.starts_with(&key))
        {
            return Err("Workspace checkpoint/restore busy".into());
        }
        let path = self.dir.join("root.lock");
        workspace::validate_absolute(&path)?;
        if path.exists() {
            workspace::regular_metadata(&path)?;
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .map_err(|e| e.to_string())?;
        workspace::regular_handle(&file)?;
        file.try_lock()
            .map_err(|e| format!("Workspace checkpoint/restore busy: {e}"))?;
        held.insert(key.clone());
        Ok(RootGuard { key, _file: file })
    }

    pub fn ensure_recovered(&self) -> Result<(), String> {
        if self
            .journal_path()
            .try_exists()
            .map_err(|e| e.to_string())?
        {
            Err(format!(
                "Unresolved checkpoint recovery journal: {}; run checkpoint recovery first",
                self.journal_path().display()
            ))
        } else {
            Ok(())
        }
    }
    pub fn journal_path(&self) -> PathBuf {
        self.dir.join("recovery.json")
    }
    pub fn record_path(&self, record: &Record) -> PathBuf {
        let key = serde_json::to_vec(&(record.agent, &record.session, record.user_index))
            .expect("serialize identity");
        self.dir
            .join("records")
            .join(format!("{}.json", hash(&key)))
    }
    pub fn write_record(&self, record: &Record) -> Result<(), String> {
        let path = self.record_path(record);
        if !path.exists()
            && fs::read_dir(self.dir.join("records"))
                .map_err(|e| e.to_string())?
                .count()
                >= MAX_RECORD_FILES
        {
            return Err("Checkpoint record quota exceeded; coverage unavailable".into());
        }
        self.write_json(&path, record)
    }
    pub fn read_record(
        &self,
        agent: AgentType,
        session: &str,
        index: usize,
    ) -> Result<Record, String> {
        let r: Record = self.read_json(&self.record_path(&Record::new(agent, session, index)))?;
        if r.version != 1 || r.agent != agent || r.session != session || r.user_index != index {
            return Err("Checkpoint record identity mismatch".into());
        }
        Ok(r)
    }
    /// Caller holds the root lease and knows this prompt was never submitted.
    pub fn discard_incomplete(
        &self,
        agent: AgentType,
        session: &str,
        index: usize,
    ) -> Result<(), String> {
        let path = self.record_path(&Record::new(agent, session, index));
        workspace::validate_absolute(&path)?;
        if !path.try_exists().map_err(|e| e.to_string())? {
            return Ok(());
        }
        let record = self.read_record(agent, session, index)?;
        // Preserve even partially malformed publication markers: discard must
        // never erase a previously completed turn just because other fields fail.
        if record.finished_ms.is_some() || record.after.is_some() {
            return Ok(());
        }
        workspace::validate_absolute(&path)?;
        fs::remove_file(&path).map_err(|e| e.to_string())?;
        sync_dir(&self.dir.join("records"))
    }
    pub fn read_json<T: DeserializeOwned>(&self, path: &Path) -> Result<T, String> {
        workspace::validate_absolute(path)?;
        let meta = workspace::regular_metadata(path)?;
        if meta.len() > MAX_JSON {
            return Err("Checkpoint metadata exceeds limit".into());
        }
        let file = workspace::open_read(path)?;
        let mut data = Vec::new();
        file.take(MAX_JSON + 1)
            .read_to_end(&mut data)
            .map_err(|e| e.to_string())?;
        if data.len() as u64 > MAX_JSON {
            return Err("Checkpoint metadata exceeds limit".into());
        }
        serde_json::from_slice(&data).map_err(|e| format!("Invalid checkpoint metadata: {e}"))
    }
    pub fn write_json<T: Serialize>(&self, path: &Path, value: &T) -> Result<(), String> {
        let data = serde_json::to_vec(value).map_err(|e| e.to_string())?;
        if data.len() as u64 > MAX_JSON {
            return Err("Checkpoint metadata exceeds limit".into());
        }
        atomic_write(path, &data)
    }
    pub fn put_object_controlled(
        &self,
        data: &[u8],
        id: &str,
        budget: &mut ObjectBudget,
        control: &CaptureControl,
    ) -> Result<(), String> {
        control.check()?;
        // Pin BEFORE quota GC: even a deduplicated object may otherwise lose its
        // last old-record reference during this scan.
        budget.pins.insert(id.to_owned());
        let path = self.dir.join("objects").join(id);
        if path.try_exists().map_err(|e| e.to_string())? {
            if self.object_controlled(id, Some(control))? != data {
                return Err("Checkpoint object hash mismatch".into());
            }
            return control.check();
        }
        if budget
            .bytes
            .is_none_or(|n| n.saturating_add(data.len() as u64) > self.max_object_bytes())
        {
            budget.bytes = Some(self.collect(
                budget.active.as_deref(),
                &budget.pins,
                data.len() as u64,
                Some(control),
            )?);
        }
        control.check()?;
        atomic_write(&path, data)?;
        budget.bytes = Some(budget.bytes.unwrap() + data.len() as u64);
        control.check()
    }

    #[cfg(test)]
    pub fn put_object(&self, data: &[u8], quota: &mut Option<u64>) -> Result<String, String> {
        // Legacy test helper does not GC: callers may be assembling references.
        let id = hash(data);
        let path = self.dir.join("objects").join(&id);
        if path.exists() {
            self.object(&id)?;
            return Ok(id);
        }
        let mut bytes = quota.unwrap_or(0);
        if quota.is_none() {
            for entry in fs::read_dir(self.dir.join("objects")).map_err(|e| e.to_string())? {
                bytes +=
                    workspace::regular_metadata(&entry.map_err(|e| e.to_string())?.path())?.len();
            }
        }
        if bytes.saturating_add(data.len() as u64) > self.max_object_bytes() {
            return Err("Checkpoint object quota exceeded".into());
        }
        atomic_write(&path, data)?;
        *quota = Some(bytes + data.len() as u64);
        Ok(id)
    }

    pub fn object(&self, id: &str) -> Result<Vec<u8>, String> {
        self.object_controlled(id, None)
    }

    fn object_controlled(
        &self,
        id: &str,
        control: Option<&CaptureControl>,
    ) -> Result<Vec<u8>, String> {
        if id.len() != 64
            || !id
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return Err("Invalid checkpoint object id".into());
        }
        let path = self.dir.join("objects").join(id);
        workspace::validate_absolute(&path)?;
        let mut file = workspace::open_read(&path)?;
        let (bytes, actual) = workspace::read_hashed(&mut file, control)?;
        if actual != id {
            return Err("Checkpoint object corrupted".into());
        }
        Ok(bytes)
    }
}

#[derive(Default)]
pub(super) struct ObjectBudget {
    pub active: Option<PathBuf>,
    pub pins: HashSet<String>,
    pub bytes: Option<u64>,
}

pub(super) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    workspace::validate_absolute(path)?;
    if path.exists() {
        workspace::regular_metadata(path)?;
    }
    let parent = path.parent().ok_or("Missing checkpoint metadata parent")?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    temp.write_all(bytes).map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist(path).map_err(|e| e.to_string())?;
    sync_dir(parent)
}

pub(super) fn sync_dir(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        File::open(path)
            .and_then(|f| f.sync_all())
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}
