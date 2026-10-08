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
//! Disabled by default; settings and retention are scoped to the canonical root.
//! Limits: 16 MiB/file, 128 MiB/capture, 20,000 files, 512 MiB objects and 100
//! completed turns retained for at most 30 days. Old coverage may be evicted.
//! Manual edits made during a turn are included: authorship is not distinguishable.
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
mod retention;
mod storage;
mod workspace;

#[cfg(test)]
mod tests;

use crate::acp::types::PromptInputBlock;
use crate::models::agent::AgentType;
use crate::models::message::{ContentBlock, MessageTurn, TurnRole};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};
use storage::{Record, RootGuard, Store};

pub use restore::{PreparedRestore, RestoreFile, RestorePreview};
pub use retention::CheckpointStatus;

/// Cooperative, monotonic capture budget. Filesystem calls themselves cannot be
/// interrupted; checks bracket IO and each walk/read/hash iteration.
#[derive(Debug, Clone)]
pub struct CaptureControl {
    pub deadline: Instant,
    pub cancel: Arc<AtomicBool>,
}

impl Default for CaptureControl {
    fn default() -> Self {
        Self::with_budget(Duration::from_secs(2))
    }
}

impl CaptureControl {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn with_budget(budget: Duration) -> Self {
        Self {
            deadline: Instant::now() + budget,
            cancel: Arc::new(AtomicBool::new(false)),
        }
    }
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::Release);
    }
    pub(super) fn check(&self) -> Result<(), String> {
        if self.cancel.load(Ordering::Acquire) {
            Err("Checkpoint capture canceled".into())
        } else if Instant::now() >= self.deadline {
            Err("Checkpoint capture deadline exceeded".into())
        } else {
            Ok(())
        }
    }
    fn renewed(&self) -> Self {
        Self {
            deadline: Instant::now() + Duration::from_secs(2),
            cancel: self.cancel.clone(),
        }
    }
}

/// Reads only durable configuration, without scanning records or the workspace.
pub async fn enabled(root: &Path) -> Result<bool, String> {
    let root = root.to_path_buf();
    blocking(move || Ok(Store::open(&root)?.settings()?.enabled)).await
}

pub async fn status(root: &Path) -> Result<CheckpointStatus, String> {
    let root = root.to_path_buf();
    blocking(move || {
        let store = Store::open(&root)?;
        let _guard = store.lock()?;
        store.status()
    })
    .await
}

/// Changing this setting never deletes previously captured coverage.
pub async fn set_enabled(root: &Path, enabled: bool) -> Result<CheckpointStatus, String> {
    let root = root.to_path_buf();
    blocking(move || {
        let store = Store::open(&root)?;
        let _guard = store.lock()?;
        store.set_enabled(enabled)?;
        store.status()
    })
    .await
}

/// Reclaims abandoned, expired and over-limit data; retained coverage survives.
pub async fn cleanup(root: &Path) -> Result<CheckpointStatus, String> {
    let root = root.to_path_buf();
    blocking(move || {
        let store = Store::open(&root)?;
        let _guard = store.lock()?;
        store.report(store.collect(None, &Default::default(), 0, None))?;
        store.status()
    })
    .await
}

pub async fn inherit_prefix(
    agent: AgentType,
    parent: &str,
    child: &str,
    root: &Path,
    retained_user_count: usize,
) -> Result<(), String> {
    let (parent, child, root) = (parent.to_owned(), child.to_owned(), root.to_path_buf());
    blocking(move || {
        let store = Store::open(&root)?;
        let _guard = store.lock()?;
        store.ensure_recovered()?;
        store.inherit_prefix(agent, &parent, &child, retained_user_count)
    })
    .await
}

/// Owns an exclusive nonblocking root lease. Dropping it leaves an incomplete
/// record. Once the provider settles, the caller may finish successful, canceled
/// or failed turns alike, provided its exclusive activity lease is still valid.
#[derive(Debug)]
pub struct PendingCheckpoint {
    store: Store,
    record: Record,
    control: CaptureControl,
    _guard: RootGuard,
}

/// Discard preparation that the caller knows was never submitted to a provider.
/// Consumes the pending value while retaining its root lease through deletion.
/// Objects are left for later GC; completed coverage is never removed.
pub async fn discard_turn(pending: PendingCheckpoint) -> Result<(), String> {
    blocking(move || {
        let pending = pending;
        pending.store.discard_incomplete(
            pending.record.agent,
            &pending.record.session,
            pending.record.user_index,
        )
    })
    .await
}

/// Remove only an incomplete slot for a prompt that was NEVER submitted.
/// The caller must await preparation (including failed/canceled blocking work),
/// drop any returned PendingCheckpoint, and keep prompt admission excluded until
/// this call finishes. Prefer discard_turn when a pending value is available.
/// Missing/completed slots are successful no-ops. A busy root or invalid metadata
/// returns an error without removal. This does not sweep objects or other slots.
pub async fn discard_unsubmitted(
    agent: AgentType,
    session: &str,
    root: &Path,
    user_index: usize,
) -> Result<(), String> {
    let (session, root) = (session.to_owned(), root.to_path_buf());
    blocking(move || discard_unsubmitted_at(Store::open(&root)?, agent, &session, user_index)).await
}

fn discard_unsubmitted_at(
    store: Store,
    agent: AgentType,
    session: &str,
    user_index: usize,
) -> Result<(), String> {
    let _guard = store.lock()?;
    store.discard_incomplete(agent, session, user_index)
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
    begin_turn_controlled(
        agent,
        session,
        root,
        user_index,
        prompt_blocks,
        CaptureControl::default(),
    )
    .await
}

pub async fn begin_turn_controlled(
    agent: AgentType,
    session: &str,
    root: &Path,
    user_index: usize,
    prompt_blocks: &[PromptInputBlock],
    control: CaptureControl,
) -> Result<PendingCheckpoint, String> {
    let root = root.to_path_buf();
    let session = session.to_owned();
    let blocks = prompt_blocks.to_vec();
    blocking(move || {
        begin_controlled(
            Store::open(&root)?,
            agent,
            &session,
            user_index,
            &blocks,
            control,
        )
    })
    .await
}

#[cfg(test)]
fn begin(
    store: Store,
    agent: AgentType,
    session: &str,
    user_index: usize,
    blocks: &[PromptInputBlock],
) -> Result<PendingCheckpoint, String> {
    begin_controlled(
        store,
        agent,
        session,
        user_index,
        blocks,
        CaptureControl::default(),
    )
}

fn begin_controlled(
    store: Store,
    agent: AgentType,
    session: &str,
    user_index: usize,
    blocks: &[PromptInputBlock],
    control: CaptureControl,
) -> Result<PendingCheckpoint, String> {
    let guard = store.lock()?;
    if !store.settings()?.enabled {
        return Err("Checkpoint disabled for workspace".into());
    }
    let result = (|| {
        control.check()?;
        store.ensure_recovered()?;
        let mut record = Record::new(agent, session, user_index);
        // Invalidate even an existing completed slot: repeated ordinals are ambiguous.
        let repeated = store.record_path(&record).exists();
        store.collect(
            Some(&store.record_path(&record)),
            &Default::default(),
            0,
            Some(&control),
        )?;
        store.write_record(&record)?;
        if repeated {
            return Err("Repeated checkpoint user index; coverage invalidated".into());
        }
        record.prompt = prompt_fingerprint(agent, blocks)?;
        record.before = Some(workspace::capture_controlled(&store, &record, &control)?);
        control.check()?;
        store.write_record(&record)?;
        control.check()?;
        Ok(record)
    })();
    let record = store.report(result)?;
    Ok(PendingCheckpoint {
        store,
        record,
        control,
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
    let control = pending.control.renewed();
    finish_turn_guarded_controlled(pending, control, publish).await
}

/// Override the after-capture budget/token, including a fresh token after the
/// provider was canceled. Publication still requires the caller's activity guard.
pub async fn finish_turn_guarded_controlled<F>(
    pending: PendingCheckpoint,
    control: CaptureControl,
    publish: F,
) -> Result<(), String>
where
    F: FnOnce(CheckpointPublish) -> Result<(), String> + Send + 'static,
{
    blocking(move || {
        let mut pending = pending;
        let captured = (|| {
            let after = workspace::capture_controlled(&pending.store, &pending.record, &control)?;
            if pending.record.before.as_ref().unwrap().scope != after.scope {
                return Err("Checkpoint scope/ignore policy changed during turn".into());
            }
            let pins = after.files.values().map(|e| e.object.clone()).collect();
            pending.store.collect(
                Some(&pending.store.record_path(&pending.record)),
                &pins,
                0,
                Some(&control),
            )?;
            control.check()?;
            Ok(after)
        })();
        let after = pending.store.report(captured)?;
        pending.record.after = Some(after);
        pending.record.finished_ms = Some(chrono::Utc::now().timestamp_millis());
        publish(Box::new(move || {
            pending.store.report(
                control
                    .check()
                    .and_then(|()| pending.store.write_record(&pending.record)),
            )
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

pub(crate) fn prompt_fingerprint(
    agent: AgentType,
    blocks: &[PromptInputBlock],
) -> Result<String, String> {
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
    identity_hash(agent, normalized, true)
}

pub(crate) fn target_fingerprint(agent: AgentType, target: &MessageTurn) -> Result<String, String> {
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
    identity_hash(agent, normalized, false)
}

fn identity_hash(
    agent: AgentType,
    blocks: Vec<IdentityBlock>,
    submitted: bool,
) -> Result<String, String> {
    // Native parsers may move images before/after text. Match their text joining
    // while preserving image sequence independently of its interleaving.
    let mut texts = Vec::new();
    let mut images = Vec::new();
    for block in blocks {
        match block {
            IdentityBlock::Text(part) => texts.push(part),
            image => images.push(image),
        }
    }
    let text = match agent {
        AgentType::Codex => {
            let text = texts.join("\n");
            if submitted {
                crate::parsers::codex::normalize_user_text(&text)
            } else {
                // The parser already normalized this text. Applying its desktop
                // attachment decoder twice can reinterpret a normalized near miss.
                text
            }
        }
        AgentType::DeepSeek => {
            let text = texts.into_iter().fold(String::new(), |mut text, part| {
                // Mirrors deepseek::collect_text_parts: leading empty parts do not
                // add separators; empty parts after visible text do.
                if !text.is_empty() {
                    text.push('\n');
                }
                text.push_str(&part);
                text
            });
            // user/message omits an entirely whitespace-only Text block even
            // when images keep the turn visible. Nonempty prose stays exact.
            if submitted && text.trim().is_empty() {
                String::new()
            } else {
                text
            }
        }
        AgentType::ClaudeCode if submitted => {
            // Claude keeps blocks separate but trims and strips system tags in
            // each one. Reuse that parser path so receipts and checkpoints match
            // actual transcript text without a second normalization of targets.
            texts
                .iter()
                .filter_map(|text| crate::parsers::claude::strip_system_tags(text))
                .collect::<String>()
        }
        _ => texts.concat(),
    };
    Ok(storage::hash(
        &serde_json::to_vec(&(text, images)).map_err(|e| e.to_string())?,
    ))
}
