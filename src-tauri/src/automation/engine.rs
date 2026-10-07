//! Automation execution engine: replays a saved composer snapshot through the
//! existing ACP launch chain, then settles the run from the event bus.
//!
//! Design (see docs/automations-spec.md §6/§9):
//! - Completion is correlated by `connection_id` (the `TurnComplete` event has no
//!   conversation_id), via an in-memory `connection_id -> (run_id, automation_id)`
//!   index. `stop_reason` is the settle authority.
//! - A per-tick reconcile backstop settles runs whose `TurnComplete` was dropped
//!   (broadcast lag) by reading the produced conversation's terminal status, and
//!   fails runs this process is not tracking that exceeded a generous deadline.
//! - The idle sweep is NOT a hazard: an in-flight turn sits in `Prompting`, which
//!   `sweep_idle` already skips (it only reaps `Connected`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use chrono::Utc;
use sea_orm::{ActiveModelTrait, EntityTrait, IntoActiveModel, Set};
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::Mutex;
use tokio::time::MissedTickBehavior;

use crate::acp::manager::ConnectionManager;
use crate::acp::types::{AcpEvent, EventEnvelope, PromptInputBlock};
use crate::acp::InternalEventBus;
use crate::commands::acp::{build_session_runtime_env, verify_agent_installed};
use crate::commands::conversations::{create_conversation_core, emit_conversation_upsert};
use crate::commands::folders::{
    emit_folder_upsert, get_folder_core, git_checkout, git_is_clean, git_list_branches,
    git_worktree_add, open_worktree_folder_core, resolve_worktree_folder_core,
};
use crate::db::entities::conversation::{self, ConversationStatus};
use crate::db::service::{automation_service, conversation_service};
use crate::db::AppDatabase;
use crate::logging::throttle::{LagLogThrottle, LAG_LOG_WINDOW};
use crate::models::{
    AgentType, AutomationConfig, AutomationInfo, AutomationRunStatus, IsolationMode,
};
use crate::web::event_bridge::{
    emit_event, AutomationChange, EventEmitter, AUTOMATION_CHANGED_EVENT,
};

/// Generous absolute cap before a run we are no longer tracking (lost index, or
/// another process) is force-failed by the reconcile sweep. Not a turn timeout —
/// owned, live runs are never force-failed here.
const MAX_RUN_MINUTES: i64 = 180;

/// Reconcile sweep cadence.
const RECONCILE_INTERVAL_SECS: u64 = 30;

/// Scheduler poll cadence. Cron is minute-granular, so 30s catches each slot.
const SCHEDULER_INTERVAL_SECS: u64 = 30;

/// Run-history prune cadence + retention window.
const PRUNE_INTERVAL_SECS: u64 = 6 * 60 * 60;
const RUN_RETENTION_DAYS: i64 = 30;

static ENGINE: OnceLock<Arc<AutomationEngine>> = OnceLock::new();

/// The process-global engine, set once at boot by [`build_engine`]. Read by the
/// manual "run now" / cancel commands (and, later, the scheduler).
pub fn engine() -> Option<Arc<AutomationEngine>> {
    ENGINE.get().cloned()
}

pub struct AutomationEngine {
    db: AppDatabase,
    manager: ConnectionManager,
    emitter: EventEmitter,
    bus: Arc<InternalEventBus>,
    data_dir: PathBuf,
    /// Live automation runs: `connection_id -> (run_id, automation_id)`. The only
    /// way `TurnComplete` (keyed by connection_id) maps back to a run. Lost on
    /// restart — which is why boot reconcile + the conversation-status backstop
    /// exist.
    index: Arc<Mutex<HashMap<String, (i32, i32)>>>,
    /// Per-automation fire lock. Serializes the overlap-check + run-row insert (and
    /// the whole launch) so a manual run-now, a scheduled fire, and a double-click
    /// can't all pass `has_active_run` and start duplicate concurrent runs.
    automation_locks: Arc<Mutex<HashMap<i32, Arc<Mutex<()>>>>>,
    /// Serializes git checkout for `shared_in_root` runs on the same root folder.
    root_locks: Arc<Mutex<HashMap<i32, Arc<Mutex<()>>>>>,
    /// Held for the engine's lifetime: an exclusive advisory lock on the DB's
    /// sidecar lock file. The engine is only ever built while holding this lock
    /// (see [`build_engine`]), so its mere existence proves this process is the
    /// sole automation engine on the DB — which is exactly the precondition that
    /// makes the destructive boot reconcile safe. Kept open purely for its Drop:
    /// the OS releases the lock on exit/crash, so the next boot reconciles
    /// correctly.
    _engine_lock: std::fs::File,
}

struct ResolvedCwd {
    folder_id: i32,
    working_dir: String,
    worktree_folder_id: Option<i32>,
}

/// Build the engine and publish it to the process global, then return the handle
/// the caller spawns via [`run_automation_engine`].
///
/// Fails closed: returns `None` unless this process can take the data dir's
/// exclusive engine lock. So the engine runs *only* while provably the sole
/// engine on the DB (`engine()` stays unset otherwise, and manual run/cancel
/// return a clean "engine not running" error). `None` happens when another live
/// codeg process already holds the lock (e.g. a desktop app and a server pointed
/// at the same `CODEG_DATA_DIR`), or — rarely — when the lock can't be
/// established at all (a real IO error on the lock file, e.g. a filesystem
/// without lock support): we never start a lockless engine, since its other
/// guards (`automation_locks`, `root_locks`) are process-local, not cross-process.
pub fn build_engine(
    db: AppDatabase,
    manager: ConnectionManager,
    emitter: EventEmitter,
    bus: Arc<InternalEventBus>,
    data_dir: PathBuf,
) -> Option<Arc<AutomationEngine>> {
    let engine_lock = match acquire_engine_ownership(&data_dir) {
        Ownership::Exclusive(file) => file,
        Ownership::Taken => {
            tracing::info!(
                "[automation] another codeg process owns the automation engine for {}; \
                 this process will not drive automations",
                data_dir.display()
            );
            return None;
        }
        Ownership::Unavailable => {
            tracing::warn!(
                "[automation] could not establish the automation engine lock for {}; \
                 automations are disabled in this process",
                data_dir.display()
            );
            return None;
        }
    };
    let engine = Arc::new(AutomationEngine {
        db,
        manager,
        emitter,
        bus,
        data_dir,
        index: Arc::new(Mutex::new(HashMap::new())),
        automation_locks: Arc::new(Mutex::new(HashMap::new())),
        root_locks: Arc::new(Mutex::new(HashMap::new())),
        _engine_lock: engine_lock,
    });
    let _ = ENGINE.set(engine.clone());
    Some(engine)
}

/// Outcome of trying to become the sole automation engine for a data dir.
enum Ownership {
    /// Exclusive advisory lock held (file kept open for the process lifetime).
    /// This process is provably the sole engine, so the destructive boot
    /// reconcile is safe.
    Exclusive(std::fs::File),
    /// Another live process holds the lock; this process must not run an engine.
    Taken,
    /// The lock couldn't be established at all — a real IO error on the lock file
    /// (e.g. a filesystem without lock support), not contention. Rare, and we fail
    /// closed: without a proven lock we never start the engine.
    Unavailable,
}

/// Path of the per-DB engine lock: the DB filename plus a `.lock` suffix, so it
/// contends exactly when the `automation_run` table is shared — a debug desktop's
/// isolated `codeg-dev.db` never blocks a release `codeg.db`, and vice versa.
fn engine_lock_path(data_dir: &Path) -> PathBuf {
    data_dir.join(format!("{}.lock", crate::db::database_file_name()))
}

/// Take an exclusive, non-blocking advisory lock on the engine lock file, held
/// for the process lifetime. Uses the std cross-platform file lock (`flock` on
/// Unix, `LockFileEx` on Windows), so the single-engine invariant is enforced on
/// every platform. The aggressive boot reconcile (every `running` row is treated
/// as interrupted) is only sound when this process is the sole engine on the DB;
/// the held lock is the proof of that. The OS releases it on exit/crash, so the
/// next boot reconciles correctly.
fn acquire_engine_ownership(data_dir: &Path) -> Ownership {
    let path = engine_lock_path(data_dir);
    let file = match std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        // The file is a pure lock handle — we never write its contents, so
        // leaving any existing bytes is fine (and avoids a needless truncate).
        .truncate(false)
        .open(&path)
    {
        Ok(f) => f,
        Err(e) => {
            // Nearly unreachable: the SQLite DB lives in this same dir, so it is
            // writable. If it really can't open, fail closed rather than run a
            // lockless engine.
            tracing::warn!("[automation] engine lock open failed: {e}");
            return Ownership::Unavailable;
        }
    };
    match file.try_lock() {
        Ok(()) => Ownership::Exclusive(file),
        Err(std::fs::TryLockError::WouldBlock) => Ownership::Taken,
        Err(std::fs::TryLockError::Error(e)) => {
            // A real IO error (never `WouldBlock`) — e.g. a filesystem without
            // lock support. Fail closed: we won't run an engine we can't prove is
            // the only one.
            tracing::warn!("[automation] engine lock failed: {e}");
            Ownership::Unavailable
        }
    }
}

/// Long-running engine driver: boot recovery, then a single select loop over the
/// completion event stream + the reconcile interval. Spawn once per process in
/// each boot path (`lib.rs` setup via `tauri::async_runtime::spawn`, and
/// `bin/codeg_server.rs` via `tokio::spawn`).
pub async fn run_automation_engine(engine: Arc<AutomationEngine>) {
    // Boot recovery: a fresh process has no live connections, so any run still
    // `running` in the DB is an interruption — fail it (never re-fire here). This
    // force-fails EVERY `running` row, which is only correct when this process is
    // the sole engine on the DB. That holds here: the engine is built only while
    // holding the exclusive data-dir lock (see `build_engine`), so a process
    // sharing the data dir never reaches this point against another's live runs.
    match automation_service::boot_reconcile_interrupted(&engine.db.conn).await {
        Ok(n) if n > 0 => tracing::info!("[automation] boot reconcile failed {n} interrupted run(s)"),
        Ok(_) => {}
        Err(e) => tracing::warn!("[automation] boot reconcile error: {e}"),
    }

    let mut rx = engine.bus.subscribe();
    let mut reconcile = delay_interval(RECONCILE_INTERVAL_SECS);
    let mut schedule = delay_interval(SCHEDULER_INTERVAL_SECS);
    let mut prune = delay_interval(PRUNE_INTERVAL_SECS);
    let mut lag_throttle = LagLogThrottle::new(LAG_LOG_WINDOW);

    loop {
        tokio::select! {
            ev = rx.recv() => match ev {
                Ok(env) => engine.on_event(&env).await,
                // Dropped events under lag — the reconcile backstop recovers them.
                Err(RecvError::Lagged(n)) => {
                    if let Some(s) = lag_throttle.record(n) {
                        tracing::warn!(
                            "[automation] event bus lagged: dropped {} events across \
                             {} occurrence(s) in the last {}s; reconcile will recover",
                            s.dropped,
                            s.occurrences,
                            LAG_LOG_WINDOW.as_secs()
                        );
                    }
                }
                Err(RecvError::Closed) => break,
            },
            _ = reconcile.tick() => engine.reconcile_once().await,
            _ = schedule.tick() => {
                // Due-detection + CAS claim; each won slot fires off-thread so a
                // slow git/worktree launch never blocks the event/reconcile arms.
                let due = automation_service::list_due(&engine.db.conn, Utc::now())
                    .await
                    .unwrap_or_default();
                for id in due {
                    match automation_service::claim_due(&engine.db.conn, id, Utc::now()).await {
                        Ok(Some(slot)) => {
                            let eng = engine.clone();
                            tokio::spawn(async move {
                                if let Err(e) = eng.run_automation(id, "schedule", Some(slot)).await {
                                    tracing::info!("[automation] scheduled run {id}: {e}");
                                }
                            });
                        }
                        Ok(None) => {}
                        Err(e) => tracing::warn!("[automation] claim {id}: {e}"),
                    }
                }
            }
            _ = prune.tick() => {
                if let Err(e) =
                    automation_service::prune_old_runs(&engine.db.conn, RUN_RETENTION_DAYS).await
                {
                    tracing::warn!("[automation] prune error: {e}");
                }
            }
        }
    }
}

fn delay_interval(secs: u64) -> tokio::time::Interval {
    let mut i = tokio::time::interval(Duration::from_secs(secs));
    i.set_missed_tick_behavior(MissedTickBehavior::Delay);
    i
}

impl AutomationEngine {
    // ── fire ────────────────────────────────────────────────────────────────

    /// Fire one run of `automation_id`. Records the run row, launches the agent,
    /// and returns the new run id. Does NOT wait for completion (the event
    /// subscriber settles it). On any pre-completion failure the run is settled
    /// `failed` with a visible error (never a silent hang).
    pub async fn run_automation(
        &self,
        automation_id: i32,
        trigger: &str,
        scheduled_for: Option<chrono::DateTime<Utc>>,
    ) -> Result<i32, String> {
        // Serialize every fire of this automation: the overlap check + run-row
        // insert below is otherwise a check-then-act race that a manual run-now
        // racing a scheduled fire (or a double-click) defeats, starting two runs.
        let fire_lock = self.fire_lock(automation_id).await;
        let _fire_guard = fire_lock.lock().await;

        let auto = automation_service::get(&self.db.conn, automation_id)
            .await
            .map_err(|e| e.to_string())?;

        // Overlap guard: never run two of the same automation concurrently.
        if automation_service::has_active_run(&self.db.conn, automation_id)
            .await
            .map_err(|e| e.to_string())?
        {
            let _ =
                automation_service::record_skipped_run(&self.db.conn, automation_id, trigger, scheduled_for)
                    .await;
            self.emit(AutomationChange::Upsert { id: automation_id });
            return Err("previous run still active".to_string());
        }

        let run = automation_service::start_run(&self.db.conn, automation_id, trigger, scheduled_for)
            .await
            .map_err(|e| e.to_string())?;
        // Broadcast the running row immediately so every client sees it the
        // instant it exists — `launch` can take seconds (worktree add + agent
        // spawn) before it re-emits RunStarted with the live "View conversation"
        // link attached. The frontend refetches the whole run list on each event,
        // so the double emit is idempotent. A launch that fails before the
        // re-emit still surfaces via the RunSettled(failed) emit in the `Err` arm.
        self.emit(AutomationChange::RunStarted {
            automation_id,
            run_id: run.id,
        });

        match self.launch(&auto, run.id).await {
            Ok(()) => Ok(run.id),
            Err(e) => {
                let _ = automation_service::settle_run(
                    &self.db.conn,
                    run.id,
                    AutomationRunStatus::Failed,
                    None,
                    Some(e.clone()),
                    None,
                )
                .await;
                self.emit(AutomationChange::RunSettled {
                    automation_id,
                    run_id: run.id,
                    status: "failed".to_string(),
                });
                Err(e)
            }
        }
    }

    /// Fire an enqueue-task automation: create a todo work task carrying the
    /// captured prompt (and the automation's agent as the per-task override),
    /// then settle the run synchronously — there is no session to wait for, so
    /// none of the TurnComplete / reconcile settle paths ever see this run.
    async fn enqueue_task(
        &self,
        auto: &AutomationInfo,
        cfg: &AutomationConfig,
        run_id: i32,
    ) -> Result<(), String> {
        let folder_id = auto
            .root_folder_id
            .ok_or_else(|| "automation has no target folder".to_string())?;
        let task_cfg = crate::models::WorkTaskConfig {
            prompt_blocks: cfg.prompt_blocks.clone(),
            display_text: cfg.display_text.clone(),
            agent_type: Some(auto.agent_type.clone()),
            mode_id: cfg.mode_id.clone(),
            config_values: cfg.config_values.clone(),
            label_snapshot: cfg.label_snapshot.clone(),
            deliverable: None,
            // An automation's own branch never applies to an enqueued task
            // (the editor blanks it for this mode), so the task branches from
            // the project folder's checkout like any unspecified one.
            base_branch: None,
        };
        let draft = crate::models::WorkTaskDraft {
            folder_id,
            title: first_chars(&auto.name, 80),
            config: serde_json::to_value(&task_cfg).map_err(|e| e.to_string())?,
        };
        // The command core (not the bare service) so the task board gets its
        // `task://changed` broadcast and the work-task pump its nudge for free.
        let info = crate::commands::work_task::work_task_create_core(&self.emitter, &self.db, draft)
            .await
            .map_err(|e| e.to_string())?;

        let settled = automation_service::settle_run(
            &self.db.conn,
            run_id,
            AutomationRunStatus::Succeeded,
            None,
            None,
            Some(format!("queued task #{}: {}", info.id, info.title)),
        )
        .await
        .map_err(|e| e.to_string())?;
        if settled {
            self.emit(AutomationChange::RunSettled {
                automation_id: auto.id,
                run_id,
                status: "succeeded".to_string(),
            });
        }
        Ok(())
    }

    /// Replay the captured composer snapshot through the existing launch chain.
    async fn launch(&self, auto: &AutomationInfo, run_id: i32) -> Result<(), String> {
        let cfg: AutomationConfig =
            serde_json::from_value(auto.config.clone()).map_err(|e| format!("bad config: {e}"))?;
        // Enqueue-task automations never touch the session machinery below —
        // no worktree, no spawn; the work-task engine owns execution.
        if cfg.action == crate::models::AutomationAction::EnqueueTask {
            return self.enqueue_task(auto, &cfg, run_id).await;
        }
        let agent_type = parse_agent_type(&auto.agent_type)?;
        let blocks = cfg
            .prompt_blocks
            .iter()
            .map(|v| serde_json::from_value::<PromptInputBlock>(v.clone()))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("bad prompt blocks: {e}"))?;
        if blocks.is_empty() {
            return Err("prompt is empty".to_string());
        }

        let cwd = self.resolve_cwd(auto, run_id).await?;

        // Announce the resolved working folder so every client's sidebar knows it
        // BEFORE the conversation upsert below lands — a conversation in a fresh
        // per-run worktree has no (client-)known folder to group under and would
        // never render otherwise. Re-broadcasting an already-open root folder
        // (shared_in_root) is an idempotent no-op on the client.
        if let Ok(detail) = get_folder_core(&self.db, cwd.folder_id).await {
            emit_folder_upsert(&self.emitter, detail);
        }

        // Recompute env from current settings (never snapshotted); hard-fail
        // visibly if the agent is disabled or not installed.
        let runtime_env = build_session_runtime_env(&self.db, agent_type, None, &self.data_dir)
            .await
            .map_err(|e| e.to_string())?;
        verify_agent_installed(agent_type)
            .await
            .map_err(|e| e.to_string())?;

        // A user cancel can arrive the instant run_automation's early RunStarted
        // makes the row visible. Re-read before spawning the CLI: if a concurrent
        // cancel_run settled this run while resolve_cwd was adding the worktree,
        // stop here — it already emitted RunSettled — rather than spawn an agent
        // for an already-cancelled run.
        if run_no_longer_running(&self.db.conn, run_id).await {
            // A per-run worktree may already exist (resolve_cwd ran, and its
            // folder was broadcast to the sidebar). Record it on the run so the
            // cancelled run still links its worktree for tracking/cleanup rather
            // than orphaning it, then stop before spawning the agent.
            if cwd.worktree_folder_id.is_some() {
                let _ = automation_service::attach_run_runtime(
                    &self.db.conn,
                    run_id,
                    None,
                    None,
                    cwd.worktree_folder_id,
                )
                .await;
            }
            return Ok(());
        }

        // Fresh connection (session_id=None), owner-labelled "automation".
        let conn_id = self
            .manager
            .spawn_agent(
                agent_type,
                Some(cwd.working_dir.clone()),
                None,
                runtime_env,
                "automation".to_string(),
                self.emitter.clone(),
                cfg.mode_id.clone(),
                cfg.config_values.clone(),
            )
            .await
            .map_err(|e| e.to_string())?;

        // Create the conversation row, then adopt it in send_prompt (Branch A).
        // Named after the AUTOMATION, not its prompt — the same name the
        // enqueue-a-task branch already gives the card it files, and the only
        // label that says which automation this run belongs to. Locked right
        // after, so the per-turn auto-title backfill can't swap it for whatever
        // the agent's session file parses to (issue #495). A prompt-derived
        // title was no more distinguishing anyway: the prompt is fixed, so
        // every run of an automation carried the identical one.
        let title = first_chars(&auto.name, 80);
        let conversation_id =
            match create_conversation_core(&self.db.conn, cwd.folder_id, agent_type, Some(title)).await
            {
                Ok(id) => id,
                Err(e) => {
                    let _ = self.manager.disconnect(&conn_id).await;
                    return Err(e.to_string());
                }
            };
        // Strictly before the upsert below: that broadcast is how any client
        // first learns this id, so locking first makes a backfill on this row
        // impossible rather than merely unlikely. Failing to lock only costs
        // the nice title — never the run.
        if let Err(e) = conversation_service::lock_title(&self.db.conn, conversation_id).await {
            tracing::warn!(
                "[automation] run {run_id}: could not lock conversation {conversation_id} title: {e}"
            );
        }

        // Surface the produced conversation in every client's sidebar the instant
        // it exists (InProgress) — independent of the implicit upsert inside
        // send_prompt_linked. Its folder was announced just above, so it can be
        // grouped/rendered right away; live status then rides the existing
        // ConversationStatusChanged → conversation://changed bridge.
        emit_conversation_upsert(&self.emitter, &self.db.conn, conversation_id).await;

        // Register for completion correlation BEFORE prompting, so a fast
        // TurnComplete can't race ahead of the index entry.
        self.index
            .lock()
            .await
            .insert(conn_id.clone(), (run_id, auto.id));
        let _ = automation_service::attach_run_runtime(
            &self.db.conn,
            run_id,
            Some(conversation_id),
            Some(conn_id.clone()),
            cwd.worktree_folder_id,
        )
        .await;

        // Re-emit now that the run carries its connection + conversation, so the
        // running row's "View conversation" link goes live during the run (the
        // early emit in `run_automation` already showed the row itself).
        self.emit(AutomationChange::RunStarted {
            automation_id: auto.id,
            run_id,
        });

        // Final cancel gate before the prompt — the one step that makes the agent
        // do work. The connection is in the index now, so a cancel landing in the
        // tiny window after this read still tears it down via cancel_run's
        // manager.cancel. If it was cancelled while we wired up, abort like the
        // send-error path below and converge the conversation (cancel_run could
        // not when it ran before this row existed); the run stays cancelled.
        if run_no_longer_running(&self.db.conn, run_id).await {
            self.index.lock().await.remove(&conn_id);
            let _ = self.manager.disconnect(&conn_id).await;
            self.cancel_conversation(conversation_id).await;
            return Ok(());
        }

        match self
            .manager
            .send_prompt_linked_with_message_id(
                &self.db,
                &conn_id,
                blocks,
                Some(cwd.folder_id),
                Some(conversation_id),
                None,
                None,
            )
            .await
        {
            Ok(_) => Ok(()),
            Err(e) => {
                self.index.lock().await.remove(&conn_id);
                let _ = self.manager.disconnect(&conn_id).await;
                // The conversation row was created `InProgress`; with the prompt
                // never sent and the connection gone, no TurnComplete will flip it
                // and reconcile won't revisit a Failed run — so flip it terminal
                // here to avoid stranding a stuck-in-progress conversation.
                self.cancel_conversation(conversation_id).await;
                Err(e.to_string())
            }
        }
    }

    /// Resolve the working directory for a run from `(root_folder_id, isolation,
    /// branch)`, reusing the existing worktree/checkout machinery. v1 requires a
    /// target folder (folderless deferred).
    async fn resolve_cwd(&self, auto: &AutomationInfo, run_id: i32) -> Result<ResolvedCwd, String> {
        let Some(root_folder_id) = auto.root_folder_id else {
            return Err("automation has no target folder".to_string());
        };
        let root = get_folder_core(&self.db, root_folder_id)
            .await
            .map_err(|e| e.to_string())?;

        match auto.isolation {
            IsolationMode::WorktreePerRun => {
                // Fresh isolated worktree per run; names carry the automation +
                // run id so `git worktree list` / the branch tree groups them.
                let branch = format!("automation/{}/run-{}", auto.id, run_id);
                // A repo checked out at a drive / share root has no name of
                // its own to prefix with.
                let repo_name = match basename(&root.path) {
                    "" => "workspace",
                    name => name,
                };
                let dir = format!("{}-automation-{}-run-{}", repo_name, auto.id, run_id);
                let mut wt_path = sibling_path(&root.path, &dir);

                // Retry once with a short suffix if a leftover collides (a prior
                // attempt for this run id that failed before cleanup).
                if let Err(e) =
                    git_worktree_add(root.path.clone(), branch.clone(), wt_path.clone(), None).await
                {
                    let suffix = short_suffix(run_id);
                    let branch2 = format!("{branch}-{suffix}");
                    wt_path = sibling_path(&root.path, &format!("{dir}-{suffix}"));
                    git_worktree_add(root.path.clone(), branch2, wt_path.clone(), None)
                        .await
                        .map_err(|_| format!("worktree add failed: {e}"))?;
                }

                let wt = open_worktree_folder_core(&self.db, wt_path, root_folder_id)
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(ResolvedCwd {
                    folder_id: wt.id,
                    working_dir: wt.path,
                    worktree_folder_id: Some(wt.id),
                })
            }
            IsolationMode::SharedInRoot => {
                let Some(branch) = auto.branch.clone() else {
                    // No branch pinned: run in the root tree as-is.
                    return Ok(ResolvedCwd {
                        folder_id: root_folder_id,
                        working_dir: root.path,
                        worktree_folder_id: None,
                    });
                };

                // Serialize checkout per root so concurrent shared runs can't
                // corrupt each other's index during the switch.
                let lock = self.root_lock(root_folder_id).await;
                let _guard = lock.lock().await;

                let resolution =
                    resolve_worktree_folder_core(&self.db, root.path.clone(), branch.clone())
                        .await
                        .map_err(|e| e.to_string())?;
                match resolution.path {
                    Some(path) => Ok(ResolvedCwd {
                        folder_id: resolution.folder_id.unwrap_or(root_folder_id),
                        working_dir: path,
                        worktree_folder_id: resolution.folder_id,
                    }),
                    None => {
                        // A remote pick stores the stripped leaf name, and a bare
                        // `git checkout <leaf>` silently prefers a same-named local
                        // branch (possibly divergent) over the intended remote.
                        // Refuse that ambiguity loudly rather than run the wrong
                        // branch. With no local match the checkout below DWIMs a
                        // unique remote into a tracking branch (and git raises its
                        // own error when multiple remotes share the name).
                        if auto.is_remote_branch {
                            let locals = git_list_branches(root.path.clone())
                                .await
                                .map_err(|e| e.to_string())?;
                            if locals.iter().any(|b| b == &branch) {
                                return Err(format!(
                                    "automation targets remote branch '{branch}' but a local \
                                     branch of that name exists — use a per-run worktree or \
                                     remove the local branch"
                                ));
                            }
                        }
                        // Switching the user's shared root tree to the target
                        // branch must not drag their uncommitted work along: a
                        // dirty tree would carry those edits onto the target
                        // branch (or make `git checkout` fail). Refuse loudly and
                        // tell them to commit/stash or use a per-run worktree.
                        if !git_is_clean(root.path.clone())
                            .await
                            .map_err(|e| e.to_string())?
                        {
                            return Err(format!(
                                "the shared root working tree has uncommitted changes, so it \
                                 can't be switched to '{branch}' — commit or stash them, or \
                                 use a per-run worktree for this automation"
                            ));
                        }
                        git_checkout(root.path.clone(), branch)
                            .await
                            .map_err(|e| e.to_string())?;
                        Ok(ResolvedCwd {
                            folder_id: root_folder_id,
                            working_dir: root.path,
                            worktree_folder_id: None,
                        })
                    }
                }
            }
        }
    }

    async fn root_lock(&self, root_folder_id: i32) -> Arc<Mutex<()>> {
        let mut locks = self.root_locks.lock().await;
        locks
            .entry(root_folder_id)
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    async fn fire_lock(&self, automation_id: i32) -> Arc<Mutex<()>> {
        let mut locks = self.automation_locks.lock().await;
        locks
            .entry(automation_id)
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    // ── completion ────────────────────────────────────────────────────────────

    async fn on_event(&self, env: &EventEnvelope) {
        let AcpEvent::TurnComplete { stop_reason, .. } = &env.payload else {
            return;
        };
        let conn_id = env.connection_id.clone();
        let entry = { self.index.lock().await.get(&conn_id).copied() };
        let Some((run_id, automation_id)) = entry else {
            return; // not an automation run
        };

        let (status, status_str) = classify_stop_reason(stop_reason);
        let summary = self.capture_summary(&conn_id).await;
        let error = if status == AutomationRunStatus::Failed {
            Some(format!("agent stopped: {stop_reason}"))
        } else {
            None
        };

        let settled = automation_service::settle_run(
            &self.db.conn,
            run_id,
            status,
            Some(stop_reason.clone()),
            error,
            summary,
        )
        .await;

        // One prompt, one turn, then disconnect (last_assistant_text is cleared
        // at the next turn start, so an automation connection is never reused).
        self.index.lock().await.remove(&conn_id);
        let _ = self.manager.disconnect(&conn_id).await;

        if let Ok(true) = settled {
            self.emit(AutomationChange::RunSettled {
                automation_id,
                run_id,
                status: status_str.to_string(),
            });
        }
    }

    /// Best-effort: capture the turn's final assistant text on the TurnComplete
    /// tick (it's process-local and cleared at the next turn start).
    async fn capture_summary(&self, conn_id: &str) -> Option<String> {
        let (state, _) = self.manager.get_state_and_emitter(conn_id).await?;
        let text = state.read().await.last_assistant_text.clone();
        text.filter(|t| !t.trim().is_empty())
    }

    // ── reconcile backstop ────────────────────────────────────────────────────

    async fn reconcile_once(&self) {
        let active = match automation_service::list_active_runs(&self.db.conn).await {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!("[automation] reconcile list error: {e}");
                return;
            }
        };
        if active.is_empty() {
            return;
        }
        // run_id -> connection_id for runs THIS process launched and is tracking.
        let owned: HashMap<i32, String> = {
            self.index
                .lock()
                .await
                .iter()
                .map(|(conn_id, (run_id, _))| (*run_id, conn_id.clone()))
                .collect()
        };
        let now = Utc::now();

        for run in active {
            if let Some(conn_id) = owned.get(&run.id) {
                // We own this run; `on_event` settles it authoritatively (with the
                // real stop_reason). Leave it alone while its connection is live —
                // settling here from coarse conversation status would race on_event
                // and discard stop_reason fidelity (and could mislabel a cancel).
                if self.manager.get_state_and_emitter(conn_id).await.is_some() {
                    continue;
                }
                // Connection gone but still Running: the TurnComplete can never
                // arrive. Settle from the conversation's terminal status, else
                // fail. Either way drop the now-dead index entry.
                let handled = self.settle_from_conversation(&run).await;
                self.index.lock().await.remove(conn_id);
                if !handled
                    && automation_service::settle_run(
                        &self.db.conn,
                        run.id,
                        AutomationRunStatus::Failed,
                        None,
                        Some("run lost its worker".to_string()),
                        None,
                    )
                    .await
                    .unwrap_or(false)
                {
                    self.emit_settled(&run, "failed");
                }
                continue;
            }

            // Not owned (lost index, or another process). Recover from the
            // conversation's terminal status (a dropped TurnComplete), else fail
            // once the run blows past a generous absolute deadline.
            if self.settle_from_conversation(&run).await {
                continue;
            }
            if let Some(started) = run.started_at {
                if now.signed_duration_since(started) > chrono::Duration::minutes(MAX_RUN_MINUTES)
                    && automation_service::settle_run(
                        &self.db.conn,
                        run.id,
                        AutomationRunStatus::Failed,
                        None,
                        Some("run exceeded max duration or lost its worker".to_string()),
                        None,
                    )
                    .await
                    .unwrap_or(false)
                {
                    self.emit_settled(&run, "failed");
                }
            }
        }
    }

    /// If the produced conversation reached a terminal status, settle the run
    /// accordingly (CAS) and emit. Returns true if the conversation was terminal
    /// (run handled — even if the CAS was lost to a concurrent settle); false if
    /// still InProgress or there is no produced conversation.
    async fn settle_from_conversation(&self, run: &crate::models::AutomationRunInfo) -> bool {
        let Some(conv_id) = run.conversation_id else {
            return false;
        };
        let Some(status) = self.conversation_status(conv_id).await else {
            return false;
        };
        let (run_status, status_str, error) = match status {
            ConversationStatus::PendingReview | ConversationStatus::Completed => {
                (AutomationRunStatus::Succeeded, "succeeded", None)
            }
            ConversationStatus::Cancelled => (
                AutomationRunStatus::Failed,
                "failed",
                Some("agent cancelled or refused".to_string()),
            ),
            ConversationStatus::InProgress => return false,
        };
        if automation_service::settle_run(&self.db.conn, run.id, run_status, None, error, None)
            .await
            .unwrap_or(false)
        {
            self.emit_settled(run, status_str);
        }
        true
    }

    async fn conversation_status(&self, conv_id: i32) -> Option<ConversationStatus> {
        conversation::Entity::find_by_id(conv_id)
            .one(&self.db.conn)
            .await
            .ok()
            .flatten()
            .map(|m| m.status)
    }

    // ── cancel ────────────────────────────────────────────────────────────────

    /// Cancel a run: stop the live turn if we own it, then settle `cancelled`.
    /// Settling a run with no live connection clears a wedged row.
    pub async fn cancel_run(&self, run_id: i32) -> Result<(), String> {
        // Settle first (CAS) so a racing reconcile tick can't relabel this user
        // cancel as Failed via the conversation-status path.
        let settled = automation_service::settle_run(
            &self.db.conn,
            run_id,
            AutomationRunStatus::Cancelled,
            Some("cancelled".to_string()),
            None,
            None,
        )
        .await
        .map_err(|e| e.to_string())?;

        // Resolve the automation id to take its fire_lock; bail cleanly if the
        // run vanished (shouldn't happen right after a successful settle).
        let Some(run) = run_by_id(&self.db.conn, run_id).await.ok().flatten() else {
            return Ok(());
        };
        let automation_id = run.automation_id;

        // Announce the cancel immediately so the UI leaves "running" without
        // waiting on the teardown below, which may block on an in-progress launch
        // holding the fire_lock.
        if settled {
            self.emit(AutomationChange::RunSettled {
                automation_id,
                run_id,
                status: "cancelled".to_string(),
            });
        }

        // Serialize the teardown with launch. `run_automation` holds this
        // automation's fire_lock across its entire inline `launch()` (including
        // `send_prompt`), so taking it here forces the connection teardown to run
        // either BEFORE launch prompts (its gate then aborts on the cancelled
        // status set above) or AFTER the turn is truly in flight (so
        // `manager.cancel` aborts a real turn) — never interleaved with the prompt
        // enqueue, which would otherwise let the prompt reach the agent after the
        // cancel. Lock order matches launch (fire_lock then index), so no deadlock.
        let fire_lock = self.fire_lock(automation_id).await;
        let _guard = fire_lock.lock().await;

        // Re-read under the lock: a launch that has since finished may have
        // attached the conversation after the snapshot above.
        let conversation_id = run_by_id(&self.db.conn, run_id)
            .await
            .ok()
            .flatten()
            .and_then(|r| r.conversation_id);

        // Stop the live turn and drop the index entry / connection.
        let conn_id = {
            self.index
                .lock()
                .await
                .iter()
                .find(|(_, (rid, _))| *rid == run_id)
                .map(|(c, _)| c.clone())
        };
        if let Some(conn_id) = conn_id {
            let _ = self.manager.cancel(&self.db.conn, &conn_id).await;
            self.index.lock().await.remove(&conn_id);
            let _ = self.manager.disconnect(&conn_id).await;
        }

        // Converge the produced conversation. A run with no live worker (lost
        // index / another process / cancelled mid-launch) would otherwise strand
        // its conversation at InProgress in the sidebar.
        if let Some(conv_id) = conversation_id {
            if self.conversation_status(conv_id).await == Some(ConversationStatus::InProgress) {
                self.cancel_conversation(conv_id).await;
            }
        }
        Ok(())
    }

    // ── helpers ───────────────────────────────────────────────────────────────

    fn emit(&self, change: AutomationChange) {
        emit_event(&self.emitter, AUTOMATION_CHANGED_EVENT, change);
    }

    fn emit_settled(&self, run: &crate::models::AutomationRunInfo, status: &str) {
        self.emit(AutomationChange::RunSettled {
            automation_id: run.automation_id,
            run_id: run.id,
            status: status.to_string(),
        });
    }

    /// Flip a produced conversation to a terminal status — used when a launch
    /// fails after the row was created `InProgress`, so it isn't left stranded.
    async fn cancel_conversation(&self, conversation_id: i32) {
        if let Ok(Some(row)) = conversation::Entity::find_by_id(conversation_id)
            .one(&self.db.conn)
            .await
        {
            let mut active = row.into_active_model();
            active.status = Set(ConversationStatus::Cancelled);
            if active.update(&self.db.conn).await.is_ok() {
                // The create-time upsert announced this row as InProgress; converge
                // every sidebar to the terminal status (this direct flip emits no
                // ConversationStatusChanged of its own).
                emit_conversation_upsert(&self.emitter, &self.db.conn, conversation_id).await;
            }
        }
    }
}

async fn run_by_id(
    conn: &sea_orm::DatabaseConnection,
    run_id: i32,
) -> Result<Option<crate::db::entities::automation_run::Model>, sea_orm::DbErr> {
    crate::db::entities::automation_run::Entity::find_by_id(run_id)
        .one(conn)
        .await
}

/// True only when the run was positively read in a non-`Running` state (e.g. a
/// concurrent `cancel_run` settled it). A read error or missing row returns
/// `false` so a transient DB hiccup never aborts a legitimate launch — the
/// reconcile backstop still covers a genuinely lost run.
async fn run_no_longer_running(conn: &sea_orm::DatabaseConnection, run_id: i32) -> bool {
    matches!(
        run_by_id(conn, run_id).await,
        Ok(Some(run)) if run.status != AutomationRunStatus::Running
    )
}

fn parse_agent_type(s: &str) -> Result<AgentType, String> {
    serde_json::from_value(serde_json::Value::String(s.to_string()))
        .map_err(|_| format!("unknown agent type: {s}"))
}

/// `end_turn` → succeeded; explicit cancel → cancelled; everything else
/// (refusal / max_tokens / max_turn_requests / empty / unknown) → failed.
fn classify_stop_reason(stop_reason: &str) -> (AutomationRunStatus, &'static str) {
    match stop_reason {
        "end_turn" => (AutomationRunStatus::Succeeded, "succeeded"),
        "cancelled" => (AutomationRunStatus::Cancelled, "cancelled"),
        _ => (AutomationRunStatus::Failed, "failed"),
    }
}

fn first_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// The separator `path` writes its own segments with, so a derived sibling
/// stays in the same form the folder was registered under instead of mixing
/// `C:\work\repo` with a `/`. A bare drive designator (`C:`) carries no
/// separator yet but is still Windows.
fn path_separator(path: &str) -> char {
    if path.contains('\\') {
        '\\'
    } else if path.contains('/') {
        '/'
    } else if is_drive_designator(path) {
        '\\'
    } else {
        '/'
    }
}

/// `C:` — a Windows drive, which names a root rather than a directory.
fn is_drive_designator(s: &str) -> bool {
    let bytes = s.as_bytes();
    bytes.len() == 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

/// True when `trimmed` (already stripped of trailing separators) is a root
/// with no parent to hang a sibling off: a drive (`C:`), a UNC share
/// (`\\server\share`), or the POSIX root (empty after trimming).
fn is_root_designator(trimmed: &str) -> bool {
    if trimmed.is_empty() || is_drive_designator(trimmed) {
        return true;
    }
    // `\\server\share` (or `//server/share`) — the host and share are both
    // part of the root designator, so a "sibling" of the share would be a
    // DIFFERENT share, not a directory.
    let unc = trimmed
        .strip_prefix("\\\\")
        .or_else(|| trimmed.strip_prefix("//"));
    match unc {
        Some(rest) => rest.split(['/', '\\']).filter(|s| !s.is_empty()).count() <= 2,
        None => false,
    }
}

/// Last segment of an OS path, accepting either separator — a `/`-only split
/// handed back the whole of `C:\work\repo` on Windows, which then went into a
/// directory name. Returns `""` at a root, which has no name of its own, so
/// callers substitute their own label rather than building a directory called
/// `C:` (a colon is not even legal in a Windows file name).
fn basename(path: &str) -> &str {
    let trimmed = path.trim_end_matches(['/', '\\']);
    if is_drive_designator(trimmed) {
        return "";
    }
    match trimmed.rfind(['/', '\\']) {
        Some(idx) => &trimmed[idx + 1..],
        None => trimmed,
    }
}

/// `name` placed next to `root_path`.
///
/// At a root there is no sibling, so `name` lands INSIDE the root instead.
/// Staying absolute is what matters: a bare relative name makes git resolve
/// the worktree inside the repository and the run then registers that
/// unresolved string as its working directory. `\\server\share` is a root too
/// — a literal sibling of it addresses another share, not a directory.
fn sibling_path(root_path: &str, name: &str) -> String {
    let trimmed = root_path.trim_end_matches(['/', '\\']);
    let separator = path_separator(root_path);
    if is_root_designator(trimmed) {
        return format!("{trimmed}{separator}{name}");
    }
    match trimmed.rfind(['/', '\\']) {
        Some(idx) => format!("{}{}{}", &trimmed[..idx], separator, name),
        None => name.to_string(),
    }
}

fn short_suffix(run_id: i32) -> String {
    // Deterministic, leftover-avoiding suffix (no RNG needed at this layer).
    format!("r{run_id}b")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_stop_reason_maps_outcomes() {
        assert_eq!(classify_stop_reason("end_turn").1, "succeeded");
        assert_eq!(classify_stop_reason("cancelled").1, "cancelled");
        assert_eq!(classify_stop_reason("refusal").1, "failed");
        assert_eq!(classify_stop_reason("max_tokens").1, "failed");
        assert_eq!(classify_stop_reason("").1, "failed");
    }

    #[test]
    fn worktree_names_carry_ids() {
        assert_eq!(basename("/home/me/repo"), "repo");
        assert_eq!(basename("/home/me/repo/"), "repo");
        assert_eq!(sibling_path("/home/me/repo", "repo-automation-3-run-7"), "/home/me/repo-automation-3-run-7");
    }

    // Windows folders are registered with backslashes, so a `/`-only split
    // used to yield the whole path as the "name" and a bare relative sibling
    // — git would then have planted the worktree inside the repo.
    #[test]
    fn worktree_names_follow_windows_separators() {
        assert_eq!(basename("C:\\work\\repo"), "repo");
        assert_eq!(basename("C:\\work\\repo\\"), "repo");
        assert_eq!(
            sibling_path("C:\\work\\repo", "repo-automation-3-run-7"),
            "C:\\work\\repo-automation-3-run-7"
        );
        // A repo directly on the drive root still gets an absolute sibling.
        assert_eq!(sibling_path("C:\\repo", "repo-run"), "C:\\repo-run");
        // Forward slashes typed on Windows stay forward slashes.
        assert_eq!(sibling_path("C:/work/repo", "repo-run"), "C:/work/repo-run");
    }

    // Roots have no sibling, so the worktree lands inside them. What must
    // never happen is a RELATIVE result: git would resolve it inside the repo
    // and the run would then register that unresolved string as its cwd.
    #[test]
    fn worktree_paths_stay_absolute_at_roots() {
        assert_eq!(sibling_path("C:\\", "workspace-run"), "C:\\workspace-run");
        assert_eq!(sibling_path("C:", "workspace-run"), "C:\\workspace-run");
        assert_eq!(sibling_path("/", "workspace-run"), "/workspace-run");
        // A share root's "sibling" would be another share, not a directory.
        assert_eq!(
            sibling_path("\\\\server\\share", "share-run"),
            "\\\\server\\share\\share-run"
        );
        assert_eq!(
            sibling_path("//server/share", "share-run"),
            "//server/share/share-run"
        );
        // A directory inside a share still gets a true sibling.
        assert_eq!(
            sibling_path("\\\\server\\share\\repo", "repo-run"),
            "\\\\server\\share\\repo-run"
        );
    }

    // `C:` is not a directory name — a colon is not legal in a Windows file
    // name — so the root cases yield no basename and the caller labels them.
    #[test]
    fn basename_is_empty_at_a_drive_root() {
        assert_eq!(basename("C:\\"), "");
        assert_eq!(basename("C:"), "");
        assert_eq!(basename("/"), "");
        assert_eq!(basename("\\\\server\\share"), "share");
    }

    #[test]
    fn first_chars_truncates_on_char_boundary() {
        assert_eq!(first_chars("hello world", 5), "hello");
        assert_eq!(first_chars("日本語テスト", 3), "日本語");
    }

    // The std file lock treats independent `open()`s as separate holders even
    // within one process, so a second acquisition stands in for another process.
    #[test]
    fn engine_lock_is_exclusive_per_data_dir() {
        let dir = tempfile::tempdir().expect("temp dir");

        // First acquisition takes the exclusive lock and holds the file open.
        let guard = match acquire_engine_ownership(dir.path()) {
            Ownership::Exclusive(f) => f,
            _ => panic!("first acquisition should take the exclusive lock"),
        };

        // A second acquisition on the same dir is refused while the guard lives.
        assert!(matches!(
            acquire_engine_ownership(dir.path()),
            Ownership::Taken
        ));

        // A different data dir is independent.
        let other = tempfile::tempdir().expect("temp dir");
        assert!(matches!(
            acquire_engine_ownership(other.path()),
            Ownership::Exclusive(_)
        ));

        // Releasing the guard frees the dir for the next owner. The reacquire can
        // momentarily still observe `Taken`: this binary runs tests in parallel,
        // and when a sibling test spawns a subprocess, `fork` duplicates our open
        // lock fd into the child. The child keeps the underlying open file
        // description — and thus the advisory lock — alive until it reaches `exec`
        // and `O_CLOEXEC` drops the inherited fd, so `drop(guard)` doesn't release
        // the lock until that brief window closes. Retry until it clears; a genuine
        // regression (the lock never released on drop) still fails at the deadline.
        drop(guard);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            match acquire_engine_ownership(dir.path()) {
                Ownership::Exclusive(_) => break,
                Ownership::Taken | Ownership::Unavailable => {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "lock not reacquirable after the guard was dropped"
                    );
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
            }
        }
    }

    // Fail closed: if the lock file can't even be opened, ownership is
    // `Unavailable` (so `build_engine` returns `None` and no lockless engine
    // starts). Simulated with a "data dir" that is actually a file — opening a
    // child path under it fails.
    #[test]
    fn engine_lock_unavailable_when_lock_file_cannot_open() {
        let file = tempfile::NamedTempFile::new().expect("temp file");
        assert!(matches!(
            acquire_engine_ownership(file.path()),
            Ownership::Unavailable
        ));
    }
}
