//! Durable client-message receipts. Native ids are often positional: neither
//! equal text nor a timestamp window proves which submitted prompt became a turn.
use super::types::PromptInputBlock;
use crate::models::{
    agent::AgentType,
    message::{ContentBlock, MessageTurn},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

const MAX_RECEIPTS: usize = 1000;
const MAX_BYTES: u64 = 1024 * 1024;

#[derive(Serialize, Deserialize)]
struct Receipt {
    #[serde(default)]
    reservation: String,
    client: String,
    agent: AgentType,
    session: String,
    prefix_len: usize,
    prefix_hash: String,
    prompt_hash: String,
    ambiguous: bool,
}

fn hash(value: &impl Serialize) -> Result<String, String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(value).map_err(|e| e.to_string())?)
    ))
}

fn prefix_hash(turns: &[MessageTurn]) -> Result<String, String> {
    hash(
        &turns
            .iter()
            .map(|t| (&t.id, &t.role, &t.timestamp, stable_blocks(&t.blocks)))
            .collect::<Vec<_>>(),
    )
}

/// Patch preview line numbers are resolved from the current worktree on every
/// parse. Retain the patch content while discarding only that derived location.
fn stable_blocks(blocks: &[ContentBlock]) -> Vec<ContentBlock> {
    let mut blocks = blocks.to_vec();
    for block in &mut blocks {
        if let ContentBlock::ToolUse {
            tool_name,
            input_preview: Some(preview),
            ..
        } = block
        {
            if matches!(
                tool_name.to_lowercase().as_str(),
                "apply_patch" | "edit" | "patch" | "applypatch"
            ) && (preview.contains("*** Update File: ") || preview.contains("*** Add File: "))
            {
                *preview = preview
                    .lines()
                    .map(|line| {
                        if line.starts_with("@@ -") && line.ends_with(" @@") {
                            "@@"
                        } else {
                            line
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
            }
        }
    }
    blocks
}

fn prompt_hash(agent: AgentType, blocks: &[PromptInputBlock]) -> Result<String, String> {
    super::file_checkpoint::prompt_fingerprint(agent, blocks)
}

fn turn_hash(agent: AgentType, turn: &MessageTurn) -> Result<String, String> {
    super::file_checkpoint::target_fingerprint(agent, turn)
}

struct Store {
    dir: PathBuf,
    _lease: File,
}

fn regular(path: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.file_type().is_symlink() {
        return Err("Unsafe receipt file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.nlink() != 1 {
            return Err("Receipt hard link refused".into());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return Err("Receipt reparse point refused".into());
        }
    }
    Ok(())
}

fn safe_ancestors(path: &Path) -> Result<(), String> {
    for part in path.ancestors() {
        match fs::symlink_metadata(part) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    return Err("Receipt symlink refused".into());
                }
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if meta.file_attributes() & 0x400 != 0 {
                        return Err("Receipt reparse point refused".into());
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}

impl Store {
    fn at(root: &Path, base: &Path) -> Result<Self, String> {
        let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
        let key = root.to_str().ok_or("Receipt workspace must be UTF-8")?;
        #[cfg(windows)]
        let key = key.to_lowercase();
        let dir = std::path::absolute(base)
            .map_err(|e| e.to_string())?
            .join(hash(&key)?);
        safe_ancestors(&dir)?;
        if dir.starts_with(&root) {
            return Err("Receipt data must be outside workspace".into());
        }
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let dir = fs::canonicalize(&dir).map_err(|e| e.to_string())?;
        #[cfg(windows)]
        let inside = PathBuf::from(dir.to_string_lossy().to_lowercase())
            .starts_with(PathBuf::from(root.to_string_lossy().to_lowercase()));
        #[cfg(not(windows))]
        let inside = dir.starts_with(&root);
        if inside {
            return Err("Receipt data resolves inside workspace".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
        let lock = dir.join("receipts.lock");
        if lock.exists() {
            regular(&lock)?;
        }
        let lease = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(lock)
            .map_err(|e| e.to_string())?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            match lease.try_lock() {
                Ok(()) => break,
                Err(error) if std::time::Instant::now() >= deadline => {
                    return Err(format!("Prompt receipt store busy: {error}"));
                }
                Err(_) => std::thread::sleep(std::time::Duration::from_millis(5)),
            }
        }
        Ok(Self { dir, _lease: lease })
    }
    fn open(root: &Path) -> Result<Self, String> {
        let base = if std::env::var_os("CODEG_HOME")
            .filter(|s| !s.is_empty())
            .is_some()
        {
            crate::paths::codeg_home_dir()
        } else {
            std::env::var_os("CODEG_DATA_DIR")
                .filter(|s| !s.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(crate::paths::codeg_home_dir)
        };
        Self::at(root, &base.join("prompt-receipts"))
    }
    fn read(&self) -> Result<Vec<Receipt>, String> {
        let path = self.dir.join("receipts.json");
        if !path.try_exists().map_err(|e| e.to_string())? {
            return Ok(Vec::new());
        }
        regular(&path)?;
        let mut bytes = Vec::new();
        File::open(path)
            .map_err(|e| e.to_string())?
            .take(MAX_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() as u64 > MAX_BYTES {
            return Err("Receipt metadata exceeds limit".into());
        }
        let receipts: Vec<Receipt> = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        if receipts.len() > MAX_RECEIPTS {
            return Err("Too many prompt receipts".into());
        }
        Ok(receipts)
    }
    fn record(
        &self,
        agent: AgentType,
        session: &str,
        client: &str,
        prefix: &[MessageTurn],
        blocks: &[PromptInputBlock],
    ) -> Result<String, String> {
        if client.is_empty() || client.len() > 128 || session.len() > 256 {
            return Err("Invalid prompt receipt identity".into());
        }
        let mut receipts = self.read()?;
        if receipts
            .iter()
            .any(|r| r.agent == agent && r.session == session && r.client == client)
        {
            return Err("Client message id already submitted".into());
        }
        let digest = prefix_hash(prefix)?;
        // A prior submission at this slot may still be unflushed. Invalidate
        // both claims, even when contents match. No later prompt can steal it.
        let mut ambiguous = false;
        for old in &mut receipts {
            if old.agent == agent
                && old.session == session
                && old.prefix_len == prefix.len()
                && old.prefix_hash == digest
            {
                old.ambiguous = true;
                ambiguous = true;
            }
        }
        let reservation = uuid::Uuid::new_v4().to_string();
        receipts.push(Receipt {
            reservation: reservation.clone(),
            client: client.into(),
            agent,
            session: session.into(),
            prefix_len: prefix.len(),
            prefix_hash: digest,
            // Unsupported content still reserves its slot: it must invalidate
            // an earlier unflushed submission even though it cannot be edited.
            prompt_hash: prompt_hash(agent, blocks).unwrap_or_default(),
            ambiguous,
        });
        if receipts.len() > MAX_RECEIPTS {
            receipts.drain(..receipts.len() - MAX_RECEIPTS);
        }
        self.write(&receipts)?;
        Ok(reservation)
    }

    fn write(&self, receipts: &[Receipt]) -> Result<(), String> {
        let data = serde_json::to_vec(receipts).map_err(|e| e.to_string())?;
        if data.len() as u64 > MAX_BYTES {
            return Err("Receipt metadata exceeds limit".into());
        }
        let mut temp = tempfile::NamedTempFile::new_in(&self.dir).map_err(|e| e.to_string())?;
        temp.write_all(&data).map_err(|e| e.to_string())?;
        temp.as_file().sync_all().map_err(|e| e.to_string())?;
        temp.persist(self.dir.join("receipts.json"))
            .map_err(|e| e.to_string())?;
        #[cfg(unix)]
        File::open(&self.dir)
            .and_then(|f| f.sync_all())
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    fn resolve(
        &self,
        agent: AgentType,
        session: &str,
        client: &str,
        current: &[MessageTurn],
    ) -> Result<MessageTurn, String> {
        let receipts = self.read()?;
        let receipt = receipts
            .iter()
            .find(|r| r.agent == agent && r.session == session && r.client == client)
            .ok_or("No durable prompt receipt; reload persisted history")?;
        if receipt.ambiguous {
            return Err("Prompt identity ambiguous after an unpersisted submission".into());
        }
        let prefix = current
            .get(..receipt.prefix_len)
            .ok_or("Prompt history changed")?;
        let target = current
            .get(receipt.prefix_len)
            .ok_or("Prompt has not been persisted")?;
        if prefix_hash(prefix)? != receipt.prefix_hash
            || turn_hash(agent, target)? != receipt.prompt_hash
        {
            return Err("Prompt receipt no longer matches native history".into());
        }
        Ok(target.clone())
    }
}

pub async fn record(
    agent: AgentType,
    session: &str,
    client: &str,
    root: &Path,
    prefix: &[MessageTurn],
    blocks: &[PromptInputBlock],
) -> Result<String, String> {
    let (session, client, root, prefix, blocks) = (
        session.to_owned(),
        client.to_owned(),
        root.to_owned(),
        prefix.to_vec(),
        blocks.to_vec(),
    );
    tokio::task::spawn_blocking(move || {
        Store::open(&root)?.record(agent, &session, &client, &prefix, &blocks)
    })
    .await
    .map_err(|e| e.to_string())?
}

pub async fn resolve(
    agent: AgentType,
    session: &str,
    client: &str,
    root: &Path,
    current: &[MessageTurn],
) -> Result<MessageTurn, String> {
    let (session, client, root, current) = (
        session.to_owned(),
        client.to_owned(),
        root.to_owned(),
        current.to_vec(),
    );
    tokio::task::spawn_blocking(move || {
        Store::open(&root)?.resolve(agent, &session, &client, &current)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A missing/compacted history cannot safely advance existing slot claims.
/// Remove those claims durably before allowing a new prompt in that session.
pub async fn invalidate(agent: AgentType, session: &str, root: &Path) -> Result<(), String> {
    let (session, root) = (session.to_owned(), root.to_owned());
    tokio::task::spawn_blocking(move || {
        let store = Store::open(&root)?;
        let mut receipts = store.read()?;
        receipts.retain(|r| r.agent != agent || r.session != session);
        store.write(&receipts)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Remove only a reservation proven never to have reached the native provider.
pub async fn discard_unsubmitted(
    agent: AgentType,
    session: &str,
    client: &str,
    reservation: &str,
    root: &Path,
) -> Result<(), String> {
    let (session, client, reservation, root) = (
        session.to_owned(),
        client.to_owned(),
        reservation.to_owned(),
        root.to_owned(),
    );
    tokio::task::spawn_blocking(move || {
        Store::open(&root)?.discard(agent, &session, &client, &reservation)
    })
    .await
    .map_err(|e| e.to_string())?
}

impl Store {
    fn discard(
        &self,
        agent: AgentType,
        session: &str,
        client: &str,
        reservation: &str,
    ) -> Result<(), String> {
        let mut receipts = self.read()?;
        receipts.retain(|r| {
            r.agent != agent
                || r.session != session
                || r.client != client
                || reservation.is_empty()
                || r.reservation != reservation
        });
        self.write(&receipts)
    }
}

#[cfg(test)]
mod tests;
