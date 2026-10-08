//! Codeg-owned, exact-byte workspace checkpoints (no Git commands or index use).
//!
//! These capture eligible worktree changes DURING a turn, not their authorship.
//! The caller must hold its activity guard from prompt admission through finish,
//! invalidate overlapping turns, and hold restore admission through DB commit.
//! `finish_turn_guarded` publishes under that coordinator's mutex. Captures and
//! preparations use `spawn_blocking`; PreparedRestore methods are synchronous:
//! call them in `spawn_blocking`, including compensation after protocol/DB errors.
//!
//! Coverage excludes Git internals, nested repositories, ignored paths and common
//! dependency/build directories. Links/reparse points, hardlinks, nonregular files,
//! non-UTF8 names, changed ignore policy and size overruns make a capture unavailable.
//! Only workspace .gitignore policy applies; global Git ignores and .git/info/exclude
//! are deliberately not consulted. Resource/resource-link prompts cannot currently
//! be matched losslessly to parsed content and therefore have unavailable coverage.
//! Limits: 16 MiB/file, 128 MiB/capture, 20,000 files, 512 MiB objects and 512 turn
//! records per canonical root. Quota exhaustion fails closed; no history is evicted.
//! Objects contain original (possibly dirty/untracked) bytes; treat the data directory
//! as private. No network, recursive deletion, HEAD/index mutation or Git restore.
//!
//! A durable recovery.json precedes writes. Partial failure and Drop compensate
//! best-effort, only when each current file still matches our planned state. If
//! compensation fails, the journal remains and further captures/restores refuse.
//! Fork-bound journals record the conversation and both session ids BEFORE
//! files change. `recover_for_database` reconciles a crash against that row:
//! a committed child keeps its files, an unchanged parent is compensated, and
//! an unrelated/deleted row requires manual reconciliation. `recover(root)`
//! refuses undecided fork-bound journals. A durable committed marker needs only
//! journal cleanup. The edit UI exposes the database-aware recovery operation.
//! Filesystem checks reject substituted ancestors before each operation. As with
//! other path-based workspace tools, callers must exclude hostile concurrent OS
//! mutation of directory names; the app lock cannot lock out external processes.

mod restore;
mod storage;
mod workspace;

#[cfg(test)]
mod tests;

use crate::acp::types::PromptInputBlock;
use crate::models::agent::AgentType;
use crate::models::message::{ContentBlock, MessageTurn, TurnRole};
use serde::{Deserialize, Serialize};
use std::path::Path;
use storage::{Record, RootGuard, Store};

pub use restore::{PreparedRestore, RestoreFile, RestorePreview};

/// Owns an exclusive nonblocking root lease. Dropping it leaves an incomplete
/// record: cancel, protocol error and overlap must never call finish.
#[derive(Debug)]
pub struct PendingCheckpoint {
    store: Store,
    record: Record,
    _guard: RootGuard,
}

/// Run `action` while holding the caller's activity mutex, iff still exclusive.
pub type CheckpointPublish = Box<dyn FnOnce() -> Result<(), String> + Send>;

pub async fn begin_turn(
    agent: AgentType,
    session: &str,
    root: &Path,
    user_index: usize,
    prompt_blocks: &[PromptInputBlock],
) -> Result<PendingCheckpoint, String> {
    let root = root.to_path_buf();
    let session = session.to_owned();
    let blocks = prompt_blocks.to_vec();
    blocking(move || begin(Store::open(&root)?, agent, &session, user_index, &blocks)).await
}

fn begin(
    store: Store,
    agent: AgentType,
    session: &str,
    user_index: usize,
    blocks: &[PromptInputBlock],
) -> Result<PendingCheckpoint, String> {
    let guard = store.lock()?;
    store.ensure_recovered()?;
    let mut record = Record::new(agent, session, user_index);
    // Invalidate even an existing completed slot: repeated ordinals are ambiguous.
    let repeated = store.record_path(&record).exists();
    store.write_record(&record)?;
    if repeated {
        return Err("Repeated checkpoint user index; coverage invalidated".into());
    }
    record.prompt = prompt_fingerprint(blocks)?;
    record.before = Some(workspace::capture(&store)?);
    store.write_record(&record)?;
    Ok(PendingCheckpoint {
        store,
        record,
        _guard: guard,
    })
}

pub async fn finish_turn(pending: PendingCheckpoint) -> Result<(), String> {
    finish_turn_guarded(pending, |publish| publish()).await
}

pub async fn finish_turn_guarded<F>(pending: PendingCheckpoint, publish: F) -> Result<(), String>
where
    F: FnOnce(CheckpointPublish) -> Result<(), String> + Send + 'static,
{
    blocking(move || {
        let mut pending = pending;
        let after = workspace::capture(&pending.store)?;
        if pending.record.before.as_ref().unwrap().scope != after.scope {
            return Err("Checkpoint scope/ignore policy changed during turn".into());
        }
        pending.record.after = Some(after);
        pending.record.finished_ms = Some(chrono::Utc::now().timestamp_millis());
        publish(Box::new(move || {
            pending.store.write_record(&pending.record)
        }))
    })
    .await
}

pub async fn preview(
    agent: AgentType,
    session: &str,
    root: &Path,
    target_user_index: usize,
    expected_total_users: usize,
    target: &MessageTurn,
) -> Result<RestorePreview, String> {
    let (session, root, target) = (session.to_owned(), root.to_path_buf(), target.clone());
    blocking(move || {
        let store = Store::open(&root)?;
        let _guard = store.lock()?;
        Ok(restore::plan(
            &store,
            agent,
            &session,
            target_user_index,
            expected_total_users,
            &target,
        )?
        .preview)
    })
    .await
}

pub async fn prepare_restore(
    agent: AgentType,
    session: &str,
    root: &Path,
    target_user_index: usize,
    expected_total_users: usize,
    target: &MessageTurn,
    preview_token: &str,
) -> Result<PreparedRestore, String> {
    let (session, root, target, token) = (
        session.to_owned(),
        root.to_path_buf(),
        target.clone(),
        preview_token.to_owned(),
    );
    blocking(move || {
        let store = Store::open(&root)?;
        restore::prepare(
            store,
            agent,
            &session,
            target_user_index,
            expected_total_users,
            &target,
            &token,
        )
    })
    .await
}

/// Retry an interrupted restore. Refuses to overwrite files edited since the
/// interruption, retaining the journal for operator inspection and repair.
pub async fn recover(root: &Path) -> Result<(), String> {
    let root = root.to_path_buf();
    blocking(move || {
        let store = Store::open(&root)?;
        let _guard = store.lock()?;
        restore::recover(&store)
    })
    .await
}

/// Reconcile the same database row that the fork transaction updates. An
/// unrelated/deleted row is ambiguous, so leave its recovery journal untouched.
pub async fn recover_for_database(
    root: &Path,
    db: &sea_orm::DatabaseConnection,
) -> Result<(), String> {
    let root = root.to_path_buf();
    let (store, guard, binding) = blocking(move || {
        let store = Store::open(&root)?;
        let guard = store.lock()?;
        let binding = restore::recovery_binding(&store)?;
        Ok((store, guard, binding))
    })
    .await?;
    let committed = if let Some(binding) = binding {
        let row = crate::db::service::conversation_service::get_by_id(db, binding.conversation_id)
            .await
            .map_err(|e| format!("Cannot reconcile restore conversation: {e}"))?;
        match row.external_id.as_deref() {
            Some(id) if id == binding.forked_session_id => true,
            Some(id) if id == binding.original_session_id => false,
            _ => {
                return Err(
                    "Restore conversation changed again; recovery requires manual reconciliation"
                        .into(),
                )
            }
        }
    } else {
        false
    };
    blocking(move || {
        let _guard = guard;
        restore::recover_decided(&store, committed)
    })
    .await
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("Checkpoint task failed: {e}"))?
}

#[derive(Serialize, Deserialize)]
enum IdentityBlock {
    Text(String),
    Image { data: String, mime_type: String },
}

fn prompt_fingerprint(blocks: &[PromptInputBlock]) -> Result<String, String> {
    let normalized = blocks
        .iter()
        .map(|block| match block {
            PromptInputBlock::Text { text } => Ok(IdentityBlock::Text(text.clone())),
            PromptInputBlock::Image {
                data, mime_type, ..
            } => Ok(IdentityBlock::Image {
                data: data.clone(),
                mime_type: mime_type.clone(),
            }),
            _ => Err("Checkpoint prompt identity unavailable for resource attachments".to_owned()),
        })
        .collect::<Result<Vec<_>, _>>()?;
    identity_hash(normalized)
}

fn target_fingerprint(target: &MessageTurn) -> Result<String, String> {
    if !matches!(target.role, TurnRole::User) {
        return Err("Checkpoint target is not a user turn".into());
    }
    let normalized = target
        .blocks
        .iter()
        .map(|block| match block {
            ContentBlock::Text { text } => Ok(IdentityBlock::Text(text.clone())),
            ContentBlock::Image {
                data, mime_type, ..
            } => Ok(IdentityBlock::Image {
                data: data.clone(),
                mime_type: mime_type.clone(),
            }),
            _ => Err("Checkpoint target has unsupported content blocks".to_owned()),
        })
        .collect::<Result<Vec<_>, _>>()?;
    identity_hash(normalized)
}

fn identity_hash(blocks: Vec<IdentityBlock>) -> Result<String, String> {
    // Native parsers may move images before/after text. Preserve exact text
    // concatenation and image sequence independently of their interleaving.
    let mut text = String::new();
    let mut images = Vec::new();
    for block in blocks {
        match block {
            IdentityBlock::Text(part) => text.push_str(&part),
            image => images.push(image),
        }
    }
    Ok(storage::hash(
        &serde_json::to_vec(&(text, images)).map_err(|e| e.to_string())?,
    ))
}
