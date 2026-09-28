//! Work-task execution engine: drives the manual pipeline
//! `todo → queued → running ⇄ awaiting_input → review → merging → done`.
//!
//! Structure mirrors `automation::engine` (single per-process engine elected by
//! an exclusive data-dir file lock; a `tokio::select!` loop over the internal
//! event bus + a reconcile tick), with three task-specific additions:
//! - **run_seq generations**: every launch claims a new `run_seq`; events are
//!   matched on `(connection_id, run_seq)` and settle through CAS updates, so a
//!   cancel racing a late `TurnComplete` is a zero-side-effect no-op.
//! - **backend-driven awaiting_input**: the engine subscribes to
//!   Question/Permission/PlanApproval request+resolve events (the frontend has
//!   no global pending-question channel for unopened conversations) and flips
//!   `running ⇄ awaiting_input` from an outstanding-request-id set.
//! - **two-stage merge with persisted intent**: stage A merges base INTO the
//!   worktree (conflicts always land there); stage B lands on the base branch
//!   in the project folder under a per-folder git mutex, with the merge intent
//!   persisted before execution so crash recovery can replay git truth.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use sea_orm::{ActiveModelTrait, EntityTrait, IntoActiveModel, Set};
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::{oneshot, Mutex, Notify};
use tokio::time::MissedTickBehavior;

use crate::acp::manager::ConnectionManager;
use crate::acp::types::{
    AcpEvent, ConnectionStatus, EventEnvelope, PromptCapabilitiesInfo, PromptInputBlock,
};
use crate::acp::work_task_tools::{TaskReportAck, WorkTaskToolAccess};
use crate::acp::InternalEventBus;
use crate::commands::acp::{build_session_runtime_env, verify_agent_installed};
use crate::commands::conversations::{
    create_conversation_core, emit_conversation_upsert, get_folder_conversation_core,
};
use crate::commands::folders::{
    emit_folder_deleted, emit_folder_upsert, get_folder_core, git_worktree_add,
    open_worktree_folder_core, resolve_git_head,
};
use crate::db::entities::conversation::{self, ConversationStatus};
use crate::db::entities::work_task::WorkTaskStatus;
use crate::db::entities::{folder, folder_command};
use crate::db::service::{conversation_service, tab_service, work_task_service};
use crate::db::AppDatabase;
use crate::forge::deliver::{
    adopt_pull_request, pull_request_body, writeback_comment_body, DeliveryCtx, ForgeDeliveryApi,
    ForgePr, NewPullRequest, PrAdoption, TaskOutcome,
};
use crate::forge::{ForgeItemKind, ForgeSourceMeta, SOURCE_KIND_ISSUE, SOURCE_KIND_PR};
use crate::logging::throttle::{LagLogThrottle, LAG_LOG_WINDOW};
use crate::models::{
    AgentType, FollowUpIntent, WorkTaskConfig, WorkTaskFolderSettings, WorkTaskMergeOp,
    WorkTaskMergeState, WorkTaskPreflight, WorkTaskQueuedMerge, DELIVERABLE_REPORT,
    STAGE_PROMPT_ALL,
};
use crate::web::event_bridge::{
    emit_event, EventEmitter, WorkTaskChange, WORK_TASK_CHANGED_EVENT,
};
use crate::work_task::compact;
use crate::work_task::git as task_git;

/// Reconcile sweep cadence.
const RECONCILE_INTERVAL_SECS: u64 = 30;

/// How often planned starts are checked. Its own (tighter) tick rather than a
/// step of the reconcile sweep: this one is a cheap indexed-ish scan, and it
/// bounds how late a task the user planned for a given minute actually starts.
const SCHEDULE_INTERVAL_SECS: u64 = 15;

/// Cap on the preflight output tail persisted with a red light.
const PREFLIGHT_TAIL_CHARS: usize = 4000;

/// How often a waiting pre-prompt compaction re-checks that its connection is
/// still alive. NOT a deadline on the turn — see `await_compaction_turn`, which
/// only ever ends the wait on evidence the turn is over or the connection is
/// gone. Loose enough to cost nothing on a turn that runs for minutes.
const COMPACTION_LIVENESS_TICK: Duration = Duration::from_secs(5);

/// Why a worktree removal declined to run, as one clause. Every surface that
/// can decline one composes its message from THIS — `complete_task`'s checkbox,
/// `cleanup_task`, the delivered-PR keep reason, and the task delete — so the
/// card, the toast and the timeline cannot drift into describing the same
/// condition differently. Only the remedy changes, because only the remedy
/// depends on what the user was doing.
const WORKTREE_HOLDS_UNCOMMITTED: &str = "it still holds uncommitted files";

/// The reason plus the way out of it.
pub(crate) fn worktree_kept(remedy: &str) -> String {
    format!("the worktree was kept: {WORKTREE_HOLDS_UNCOMMITTED}. {remedy}")
}

/// The remedy for the surfaces whose retry IS the cleanup itself.
pub(crate) const RETRY_THE_CLEANUP: &str = "Remove them, then retry the cleanup.";

/// The probe every worktree-removal gate shares: does this checkout still hold
/// work (tracked edits or files git has never seen)?
///
/// FAILS CLOSED. Only two reasons for git being unable to answer are safe to
/// read as "clean": the checkout is already off disk, or git removed its
/// registration and contents but left a readable, strictly empty directory
/// behind. Any entry in that shell (ignored and hidden files included), a
/// corrupt index, a permission error, or another transient filesystem failure
/// means we could not prove the directory is safe to destroy. The operation
/// waiting on this answer is `git worktree remove --force`, so guessing "clean"
/// there trades a recoverable stall for unrecoverable files.
///
/// The `.git` marker is checked FIRST, and not as an optimization: `has_changes`
/// runs `git status` with the path as its working directory, and git walks UP
/// from there. A shell with no marker left is not a checkout git can speak for,
/// so whatever it answers is about the repository that ENCLOSES the shell — the
/// project itself whenever the folder's worktree root is a path inside it. That
/// answer is a clean `Ok(false)` or a dirty `Ok(true)` about somebody else's
/// files, and neither is this path's; only the directory probe below is.
async fn path_holds_uncommitted(path: &str) -> bool {
    match std::fs::symlink_metadata(Path::new(path).join(".git")) {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return shell_holds_entries(path),
        // Could not even look at the marker — no proof of anything. Fail closed.
        Err(_) => return true,
    }
    match task_git::has_changes(path).await {
        Ok(dirty) => dirty,
        Err(_) => shell_holds_entries(path),
    }
}

/// The one thing left to ask about a directory git has stopped speaking for: is
/// it strictly empty? Anything else — an entry of any kind, or a failure to read
/// the directory at all — is "holds work", because a `--force` removal is what
/// waits on the answer. Only a path that is gone reads as nothing to lose.
fn shell_holds_entries(path: &str) -> bool {
    match std::fs::read_dir(path) {
        // `Some(Err(_))` is deliberately still "holds work": even learning
        // whether an entry exists has to succeed before removal is safe.
        Ok(mut entries) => entries.next().is_some(),
        Err(e) => e.kind() != std::io::ErrorKind::NotFound,
    }
}

/// Why [`TaskEngine::cleanup_task`] did not remove a worktree.
///
/// The two answers are not interchangeable to `work_task_delete_core`, which
/// tombstones the task immediately afterwards. A cleanup that TRIED AND FAILED
/// leaves stale bookkeeping behind and the delete may proceed over it. A
/// cleanup that was REFUSED to protect work must stop it: the tombstone takes
/// the card, its `cleanup_state` and its retry entry all at once, stranding a
/// directory the user was told would be deleted with nothing left anywhere to
/// say why — the failure mode a plain `Err` swallowed by a `warn!` produces.
#[derive(Debug)]
pub struct CleanupBlocked {
    pub message: String,
    /// The worktree was left standing deliberately, and still holds work.
    pub holds_work: bool,
}

impl CleanupBlocked {
    /// Tried, could not finish. Callers may proceed past it.
    fn failed(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            holds_work: false,
        }
    }
}

static ENGINE: OnceLock<Arc<TaskEngine>> = OnceLock::new();

/// The process-global engine, set once at boot by [`build_task_engine`]. Read
/// by the start/cancel/merge/cleanup commands.
pub fn engine() -> Option<Arc<TaskEngine>> {
    ENGINE.get().cloned()
}

pub struct TaskEngine {
    db: AppDatabase,
    manager: ConnectionManager,
    emitter: EventEmitter,
    bus: Arc<InternalEventBus>,
    data_dir: PathBuf,
    /// Live runs: `connection_id -> (task_id, run_seq)` — the only way events
    /// keyed by connection_id map back to a task generation. Lost on restart
    /// (boot reconcile covers that).
    index: Arc<Mutex<HashMap<String, (i32, i32)>>>,
    /// Outstanding blocking requests per task (`"q:<id>"`, `"p:<id>"`,
    /// `"a:<id>"` — namespaced so the three id spaces can't collide). Non-empty
    /// set ⇔ awaiting_input. Requests raised by a delegation sub-agent are
    /// additionally prefixed with the child's connection id
    /// (`"<child_conn>#p:<id>"`) so [`TaskEngine::forget_delegation_child`] can
    /// drop the whole group when that child goes away.
    awaiting: Arc<Mutex<HashMap<i32, HashSet<String>>>>,
    /// `child_connection_id -> parent_connection_id` for delegation children of
    /// a task run. A sub-agent's blocking prompts arrive on the CHILD's
    /// connection, which is not in `index` — without this mapping they are
    /// dropped and the board keeps saying "running" while the run is actually
    /// parked on the user (#447). Populated from `DelegationStarted` (only for
    /// connections that ARE task runs) and dropped on `DelegationCompleted`.
    delegation_parents: Arc<Mutex<HashMap<String, String>>>,
    /// Tasks currently being launched (`queued`, then `preparing` in DB, but
    /// owned by an in-flight launch), mapped to their folder so the pump's
    /// concurrency accounting stays per-folder. Keeps the pump from
    /// double-launching, and is the reconcile sweep's ownership test for
    /// `preparing` rows. Entries carry an ownership token: a slow launch that
    /// is still unwinding must not drop the entry a newer launch of the same
    /// task now depends on.
    launching: Arc<Mutex<HashMap<i32, LaunchOwner>>>,
    /// Source of `LaunchOwner` tokens.
    launch_token: Arc<std::sync::atomic::AtomicU64>,
    /// Live setup (init command) child processes, by task. A cancel kills the
    /// process TREE so a long `pnpm install` stops with the task instead of
    /// running to completion in the background.
    setup_children: Arc<Mutex<HashMap<i32, SetupChild>>>,
    /// Tasks whose launch is currently waiting out a pre-prompt compaction
    /// turn, and the connection running it. Serves the same role
    /// `setup_children` does for a long init command: the launch holds the task
    /// lock across the whole compaction, so a cancel has to be able to reach
    /// the turn WITHOUT that lock — otherwise "stop" would sit behind the very
    /// turn it is trying to stop. The compaction connection is deliberately NOT
    /// in `index`: its `TurnComplete` is the launch's own signal, and an
    /// indexed one would settle the task into review before its work ever
    /// started.
    compacting: Arc<Mutex<HashMap<i32, CompactRun>>>,
    /// `connection_id -> event seq` of a compaction `TurnComplete` the launch
    /// has already consumed as its own signal.
    ///
    /// The bus is a BROADCAST: this engine's own receiver and the launch's
    /// waiter each get their own copy of that envelope. The waiter is awaiting
    /// exactly it, so it always reacts first; the engine's loop awaits DB work
    /// per event and can be arbitrarily far behind. "The connection was not in
    /// `index` when this was emitted" is therefore something `on_event` cannot
    /// observe — by the time it dequeues, the launch may have indexed the
    /// connection and sent the round's real prompt, and the compaction's
    /// completion would settle THAT turn (and disconnect the agent mid-round).
    /// The seq is the discriminator: per-connection and monotonic (assigned
    /// under the state write lock in `emit_with_state_gated`), so it names one
    /// exact envelope rather than "a turn on this connection".
    compaction_turns: Arc<Mutex<HashMap<String, u64>>>,
    /// Tasks whose merge/delivery is executing in THIS process — the reconcile
    /// tick must not run crash recovery against them. A merge only needs it
    /// for the dispatch window (a live agent connection covers the rest); a
    /// delivery has no connection, so it stays in here for its whole run.
    ///
    /// Entries carry an ownership TOKEN, for the same reason `launching` does:
    /// a losing attempt that is still unwinding must not drop the entry the
    /// winner now depends on — that would hand a live delivery to the
    /// reconcile sweep, which would bounce it mid-push.
    merging: Arc<Mutex<HashMap<i32, u64>>>,
    /// Source of `merging` ownership tokens.
    in_flight_token: Arc<std::sync::atomic::AtomicU64>,
    /// Push + pull-request calls, behind a trait so engine tests can drive the
    /// delivery state machine — including every failure point and both
    /// recovery branches — without a network or the OS keyring.
    forge: Arc<dyn ForgeDeliveryApi>,
    /// Per-task lock serializing launch vs cancel teardown (same role as the
    /// automation engine's fire lock).
    task_locks: Arc<Mutex<HashMap<i32, Arc<Mutex<()>>>>>,
    /// Per-project-folder git mutex: merge and worktree cleanup serialize here.
    folder_locks: Arc<Mutex<HashMap<i32, Arc<Mutex<()>>>>>,
    /// Per-folder pump lock so concurrent pumps can't over-launch past
    /// max_concurrent.
    pump_locks: Arc<Mutex<HashMap<i32, Arc<Mutex<()>>>>>,
    /// Held for the engine's lifetime: exclusive advisory lock on
    /// `<db>.tasks.lock`. Its existence proves this process is the sole task
    /// engine on the DB — the precondition for the destructive boot reconcile.
    _engine_lock: std::fs::File,
}

/// Build the engine and publish it to the process global. Fails closed like the
/// automation engine: `None` unless this process holds the exclusive task lock.
pub fn build_task_engine(
    db: AppDatabase,
    manager: ConnectionManager,
    emitter: EventEmitter,
    bus: Arc<InternalEventBus>,
    data_dir: PathBuf,
) -> Option<Arc<TaskEngine>> {
    let engine_lock = match acquire_engine_ownership(&data_dir) {
        Ownership::Exclusive(file) => file,
        Ownership::Taken => {
            tracing::info!(
                "[work_task] another codeg process owns the task engine for {}; \
                 this process will not drive tasks",
                data_dir.display()
            );
            return None;
        }
        Ownership::Unavailable => {
            tracing::warn!(
                "[work_task] could not establish the task engine lock for {}; \
                 tasks are disabled in this process",
                data_dir.display()
            );
            return None;
        }
    };
    let engine = Arc::new(TaskEngine {
        db,
        manager,
        emitter,
        bus,
        data_dir,
        index: Arc::new(Mutex::new(HashMap::new())),
        awaiting: Arc::new(Mutex::new(HashMap::new())),
        delegation_parents: Arc::new(Mutex::new(HashMap::new())),
        launching: Arc::new(Mutex::new(HashMap::new())),
        launch_token: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        setup_children: Arc::new(Mutex::new(HashMap::new())),
        compacting: Arc::new(Mutex::new(HashMap::new())),
        compaction_turns: Arc::new(Mutex::new(HashMap::new())),
        merging: Arc::new(Mutex::new(HashMap::new())),
        in_flight_token: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        forge: Arc::new(crate::forge::deliver::ForgeDelivery),
        task_locks: Arc::new(Mutex::new(HashMap::new())),
        folder_locks: Arc::new(Mutex::new(HashMap::new())),
        pump_locks: Arc::new(Mutex::new(HashMap::new())),
        _engine_lock: engine_lock,
    });
    let _ = ENGINE.set(engine.clone());
    Some(engine)
}

/// Hard stop when walking `TaskEngine::delegation_parents` up to its run. Well
/// above any usable `depth_limit` (the delegation config's, which bounds the
/// real chain), so it only ever fires against a map that shouldn't exist —
/// insurance against spinning, not a functional limit.
const MAX_DELEGATION_CHAIN_HOPS: usize = 16;

/// Build an engine WITHOUT taking the process-wide ownership lock or publishing
/// it to the `ENGINE` cell, so a test can drive the instance methods (event
/// handling, request tracking) directly. The subscriber loop is never started;
/// tests feed `on_event` themselves.
#[cfg(test)]
fn test_engine(db: AppDatabase) -> Arc<TaskEngine> {
    test_engine_with_forge(db, Arc::new(crate::forge::deliver::ForgeDelivery))
}

/// As [`test_engine`], with the forge write path replaced — delivery tests
/// drive push/find/create from a fake so no test ever reaches the network or
/// the credential store.
#[cfg(test)]
fn test_engine_with_forge(db: AppDatabase, forge: Arc<dyn ForgeDeliveryApi>) -> Arc<TaskEngine> {
    test_engine_full(db, forge, EventEmitter::Noop)
}

/// As [`test_engine_with_forge`], with the emitter chosen by the caller — the
/// broadcast-ordering tests need a real `WebEventBroadcaster` behind it to read
/// back what the engine announced, and in what order.
#[cfg(test)]
fn test_engine_full(
    db: AppDatabase,
    forge: Arc<dyn ForgeDeliveryApi>,
    emitter: EventEmitter,
) -> Arc<TaskEngine> {
    Arc::new(TaskEngine {
        db,
        manager: ConnectionManager::new(),
        emitter,
        bus: Arc::new(InternalEventBus::new(Default::default())),
        // An anonymous temp file, not a handle on `data_dir`: opening a
        // DIRECTORY as a File succeeds on Unix but fails on Windows.
        _engine_lock: tempfile::tempfile().expect("temp file"),
        data_dir: std::env::temp_dir(),
        index: Arc::new(Mutex::new(HashMap::new())),
        awaiting: Arc::new(Mutex::new(HashMap::new())),
        delegation_parents: Arc::new(Mutex::new(HashMap::new())),
        launching: Arc::new(Mutex::new(HashMap::new())),
        launch_token: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        setup_children: Arc::new(Mutex::new(HashMap::new())),
        compacting: Arc::new(Mutex::new(HashMap::new())),
        compaction_turns: Arc::new(Mutex::new(HashMap::new())),
        merging: Arc::new(Mutex::new(HashMap::new())),
        in_flight_token: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        forge,
        task_locks: Arc::new(Mutex::new(HashMap::new())),
        folder_locks: Arc::new(Mutex::new(HashMap::new())),
        pump_locks: Arc::new(Mutex::new(HashMap::new())),
    })
}

enum Ownership {
    Exclusive(std::fs::File),
    Taken,
    Unavailable,
}

/// `<db-file>.tasks.lock` — sibling of the automation engine's `<db>.lock`, so
/// the two engines elect independently but both contend exactly when the DB is
/// shared.
fn engine_lock_path(data_dir: &Path) -> PathBuf {
    data_dir.join(format!("{}.tasks.lock", crate::db::database_file_name()))
}

fn acquire_engine_ownership(data_dir: &Path) -> Ownership {
    let path = engine_lock_path(data_dir);
    let file = match std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
    {
        Ok(f) => f,
        Err(e) => {
            tracing::warn!("[work_task] engine lock open failed: {e}");
            return Ownership::Unavailable;
        }
    };
    match file.try_lock() {
        Ok(()) => Ownership::Exclusive(file),
        Err(std::fs::TryLockError::WouldBlock) => Ownership::Taken,
        Err(std::fs::TryLockError::Error(e)) => {
            tracing::warn!("[work_task] engine lock failed: {e}");
            Ownership::Unavailable
        }
    }
}

/// Long-running driver: boot recovery, then a select loop over the event bus +
/// the reconcile tick. Spawn once per process in each boot path.
pub async fn run_task_engine(engine: Arc<TaskEngine>) {
    // Subscribed BEFORE the boot work below, not after it: a broadcast receiver
    // only ever sees what is published after it subscribes, and the boot work
    // is not instant (a git probe per merging row, a re-measure per review
    // row). A task the user starts inside that window would emit its events
    // into a bus nobody is listening to, and a missed `TurnComplete` leaves it
    // running forever — the reconcile sweep deliberately leaves rows whose
    // connection is still live to `on_event`. Anything that piles up while boot
    // finishes is processed right after, which is safe by construction: every
    // settle is a CAS on `(connection_id, run_seq)`, so an event for a
    // generation boot already failed is a no-op. A backlog past the channel's
    // capacity surfaces as `Lagged`, which the loop already handles.
    let mut rx = engine.bus.subscribe();

    // Boot recovery: no connections (and no setup child processes) survive a
    // restart, so queued / preparing / running / awaiting_input are
    // interruptions → failed(interrupted); retry is idempotent (the worktree is
    // reused, and an init command that never finished re-runs — see the setup
    // marker). merging is exempt — it recovers from git truth below, never from
    // connection liveness.
    match work_task_service::boot_reconcile_interrupted(&engine.db.conn).await {
        Ok(n) if n > 0 => {
            tracing::info!("[work_task] boot reconcile failed {n} interrupted task(s)");
            engine.emit_changed_all();
        }
        Ok(_) => {}
        Err(e) => tracing::warn!("[work_task] boot reconcile error: {e}"),
    }
    match work_task_service::list_by_status(&engine.db.conn, &[WorkTaskStatus::Merging]).await {
        Ok(rows) => {
            for row in rows {
                engine.recover_merging(row.id).await;
            }
        }
        Err(e) => tracing::warn!("[work_task] boot merging scan error: {e}"),
    }
    engine.refresh_review_diff_stats().await;

    let mut reconcile = {
        let mut i = tokio::time::interval(Duration::from_secs(RECONCILE_INTERVAL_SECS));
        i.set_missed_tick_behavior(MissedTickBehavior::Delay);
        i
    };
    // Fires immediately on its first tick, which is also the catch-up pass: a
    // plan whose time passed while the app was closed runs late rather than
    // never.
    let mut schedule = {
        let mut i = tokio::time::interval(Duration::from_secs(SCHEDULE_INTERVAL_SECS));
        i.set_missed_tick_behavior(MissedTickBehavior::Delay);
        i
    };
    let mut lag_throttle = LagLogThrottle::new(LAG_LOG_WINDOW);

    loop {
        tokio::select! {
            ev = rx.recv() => match ev {
                Ok(env) => engine.on_event(&env).await,
                Err(RecvError::Lagged(n)) => {
                    if let Some(s) = lag_throttle.record(n) {
                        tracing::warn!(
                            "[work_task] event bus lagged: dropped {} events across \
                             {} occurrence(s) in the last {}s; reconcile will recover",
                            s.dropped,
                            s.occurrences,
                            LAG_LOG_WINDOW.as_secs()
                        );
                    }
                }
                Err(RecvError::Closed) => break,
            },
            _ = schedule.tick() => engine.claim_due_scheduled().await,
            _ = reconcile.tick() => engine.reconcile_once().await,
        }
    }
}

/// What a merge request actually did. Merges into one base branch are serial,
/// so a click that finds the folder's slot busy takes a place in line instead
/// of failing — and the caller has to be able to tell the user which happened.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeDispatch {
    /// The merge generation is running now.
    Dispatched,
    /// Parked on the row; the folder's merge pump dispatches it when the slot
    /// frees.
    Queued,
}

/// How a task finished, carried to the (spawned) forge write-back. Owned
/// strings because it outlives the settle that produced it.
#[derive(Debug, Clone, PartialEq, Eq)]
enum WritebackOutcome {
    /// Landed on the local base branch — the commit it became.
    Merged(String),
    /// Published as a pull request — its URL.
    Delivered(String),
    /// Accepted without landing anything — see `TaskOutcome::Accepted`.
    Accepted { nothing_to_land: bool },
}

impl MergeDispatch {
    pub fn is_queued(self) -> bool {
        matches!(self, MergeDispatch::Queued)
    }
}

/// The queued merge a pump dispatch is FOR, carried from the scan down to the
/// CAS that spends it.
///
/// `raw` is the row's `pending_merge` JSON verbatim — an optimistic token, not
/// a re-serialization: every write that consumes a queued merge demands the
/// column still equal it. Between the scan and the dispatch the pump does a
/// worktree stat, takes the folder lock and runs three git subprocesses, and a
/// user can withdraw or edit the merge anywhere in that window. `run_seq` does
/// not move for either, so without this token a withdrawn merge would still
/// land on the base branch.
struct QueuedMergeClaim {
    raw: String,
    /// The instant the task took its place in line, so a re-park (the slot got
    /// taken first) keeps it rather than going to the back.
    queued_at: chrono::DateTime<chrono::Utc>,
}

/// What one pass over a folder's merge queue concluded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DrainOutcome {
    /// A merge is running (or was just dispatched / refused) — the folder's one
    /// merge slot is spoken for this round.
    Taken,
    /// Nothing is queued. The slot is free for the auto-merge sweep.
    Empty,
    /// The queue changed while this pass worked on it; the snapshot is out of
    /// date and must be re-read before anything else may use the slot.
    Stale,
}

/// How many times a drain re-reads a queue that changed under it before it
/// gives the slot back to the next pump. Each retry requires a fresh
/// concurrent change, so this only bounds a pathological click loop.
const MERGE_QUEUE_DRAIN_ATTEMPTS: usize = 3;

/// How a launch composes its prompt.
enum LaunchMode {
    /// First run: the task's own prompt blocks.
    Fresh,
    /// Retry after failure: resume the session if possible and ask to continue.
    Retry,
    /// A follow-up on a reviewed task: the user's text, framed by their intent,
    /// plus whatever the composer attached out of band (images, pasted bytes).
    Return {
        intent: FollowUpIntent,
        feedback: String,
        attachments: Vec<serde_json::Value>,
    },
    /// Merge generation: the agent lands the task onto the base branch itself
    /// (sync base into the worktree, resolve conflicts, merge into base). The
    /// task sits in `merging` for the whole turn; the engine settles from git
    /// truth, never from the agent's word.
    Merge {
        root_path: String,
        base_branch: String,
        work_branch: String,
        /// "squash" | "merge"
        strategy: String,
        /// `None` → the agent writes the commit message itself.
        message: Option<String>,
        /// Whatever the user added in the merge dialog, verbatim. `None` when
        /// they left it empty — which is every merge dispatched before this
        /// existed, and the auto-merge sweep's every landing.
        instructions: Option<String>,
    },
}

impl LaunchMode {
    /// The task status a launch of this mode expects to find when it starts.
    fn expected_status(&self) -> WorkTaskStatus {
        match self {
            LaunchMode::Merge { .. } => WorkTaskStatus::Merging,
            _ => WorkTaskStatus::Queued,
        }
    }

    /// The status the task holds for the REST of the launch, once setup has
    /// begun — what the cancel gates re-check. A merge generation stays
    /// `merging` throughout; every other mode moves `queued → preparing` before
    /// it touches the worktree.
    fn in_flight_status(&self) -> WorkTaskStatus {
        match self {
            LaunchMode::Merge { .. } => WorkTaskStatus::Merging,
            _ => WorkTaskStatus::Preparing,
        }
    }

    /// Timeline `round` label for the prompt this mode composes. Every
    /// follow-up intent shares the `return` stage: the folder's per-stage
    /// prompt settings stay four stages wide, and the intent rides the `round`
    /// event beside this label for the transcript's phase divider.
    fn round_kind(&self) -> &'static str {
        match self {
            LaunchMode::Fresh => "work",
            LaunchMode::Retry => "retry",
            LaunchMode::Return { .. } => "return",
            LaunchMode::Merge { .. } => "merge",
        }
    }

    /// The follow-up intent this launch carries, for the `round` marker.
    fn round_intent(&self) -> Option<FollowUpIntent> {
        match self {
            LaunchMode::Return { intent, .. } => Some(*intent),
            _ => None,
        }
    }

    /// Whether this launch may write to the worktree. A question is answered in
    /// chat; everything else is work.
    fn is_read_only(&self) -> bool {
        matches!(
            self,
            LaunchMode::Return {
                intent: FollowUpIntent::Question,
                ..
            }
        )
    }
}

impl TaskEngine {
    // ── user entry points ───────────────────────────────────────────────────

    /// Manual start: claim todo → queued, then pump the folder.
    pub async fn start(self: &Arc<Self>, task_id: i32) -> Result<(), String> {
        let task = work_task_service::get_model(&self.db.conn, task_id)
            .await
            .map_err(|e| e.to_string())?;
        self.preflight_folder(task.folder_id).await?;
        match work_task_service::claim_for_run(&self.db.conn, task_id, WorkTaskStatus::Todo, "user")
            .await
            .map_err(|e| e.to_string())?
        {
            Some(_) => {
                self.emit_upsert(task_id);
                self.pump_folder(task.folder_id).await;
                Ok(())
            }
            None => Err("task is not in todo".to_string()),
        }
    }

    /// "Start all": claim every todo of the folder, then pump. With no folder
    /// selected this is the global sweep — every folder that holds todos, each
    /// on its own preflight (an invalid folder is skipped, not fatal).
    pub async fn start_all(self: &Arc<Self>, folder_id: Option<i32>) -> Result<u32, String> {
        let folder_ids = match folder_id {
            Some(id) => vec![id],
            None => work_task_service::folders_with_todos(&self.db.conn)
                .await
                .map_err(|e| e.to_string())?,
        };
        let explicit = folder_id.is_some();
        let mut claimed = 0u32;
        for fid in folder_ids {
            if let Err(e) = self.preflight_folder(fid).await {
                if explicit {
                    return Err(e);
                }
                tracing::info!("[work_task] start all skips folder {fid}: {e}");
                continue;
            }
            let ids = work_task_service::list_todo_ids(&self.db.conn, fid)
                .await
                .map_err(|e| e.to_string())?;
            let mut folder_claimed = 0u32;
            for id in ids {
                // The unplanned-only claim, not the generic one: `ids` is a
                // snapshot, and a plan set in the meantime must still be
                // honoured rather than silently overridden by a bulk button.
                if work_task_service::claim_unplanned_for_run(
                    &self.db.conn,
                    id,
                    WorkTaskStatus::Todo,
                    "user",
                )
                .await
                    .map_err(|e| e.to_string())?
                    .is_some()
                {
                    folder_claimed += 1;
                    self.emit_upsert(id);
                }
            }
            if folder_claimed > 0 {
                self.pump_folder(fid).await;
            }
            claimed += folder_claimed;
        }
        Ok(claimed)
    }

    /// Retry a failed task: claim failed → queued (same worktree / session
    /// reused by the launch), then pump. An optional note rides the claim's own
    /// transaction and reaches the retry prompt — a failure usually has a cause
    /// the user knows and the agent doesn't.
    pub async fn retry(
        self: &Arc<Self>,
        task_id: i32,
        note: Option<String>,
        attachments: Vec<serde_json::Value>,
        allow_duplicate_source: bool,
    ) -> Result<(), String> {
        let task = work_task_service::get_model(&self.db.conn, task_id)
            .await
            .map_err(|e| e.to_string())?;
        self.preflight_folder(task.folder_id).await?;
        let note = note.map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
        // An attachment is an instruction on its own: a screenshot with no
        // sentence still has to reach the retry prompt, so the action is
        // recorded whenever EITHER part is present.
        let action = (note.is_some() || !attachments.is_empty()).then(|| {
            serde_json::json!({
                "action": "retry",
                "note": note.unwrap_or_default(),
                "blocks": attachments,
            })
        });
        match work_task_service::claim_for_run_with_action(
            &self.db.conn,
            task_id,
            WorkTaskStatus::Failed,
            "user",
            action,
            allow_duplicate_source,
        )
        .await
        .map_err(|e| e.to_string())?
        {
            Some(_) => {
                self.emit_upsert(task_id);
                self.pump_folder(task.folder_id).await;
                Ok(())
            }
            None => Err("task is not in failed".to_string()),
        }
    }

    /// Send a reviewed task back to the agent with a follow-up. Launches
    /// directly (explicit user action — does not wait behind the queue).
    ///
    /// The intent picks the wording the agent receives; the feedback itself is
    /// recorded inside the claim's transaction, so a pump that steals the
    /// freshly queued generation still finds the instruction.
    pub async fn return_task(
        self: &Arc<Self>,
        task_id: i32,
        intent: FollowUpIntent,
        feedback: String,
        attachments: Vec<serde_json::Value>,
    ) -> Result<(), String> {
        let task = work_task_service::get_model(&self.db.conn, task_id)
            .await
            .map_err(|e| e.to_string())?;
        self.preflight_folder(task.folder_id).await?;
        let Some(_) = work_task_service::claim_for_run_with_action(
            &self.db.conn,
            task_id,
            WorkTaskStatus::Review,
            "user",
            Some(serde_json::json!({
                "action": "return",
                "intent": intent.as_str(),
                "feedback": feedback,
                "blocks": attachments,
            })),
            false,
        )
        .await
        .map_err(|e| e.to_string())?
        else {
            return Err("task is not in review".to_string());
        };
        self.emit_upsert(task_id);
        self.spawn_launch(
            task_id,
            task.folder_id,
            LaunchMode::Return {
                intent,
                feedback,
                attachments,
            },
        );
        Ok(())
    }

    /// Cancel a task from any non-terminal state except merging. The worktree
    /// is kept — removing it is a separate call the callers chain on when the
    /// user asked for it (`work_task_cancel_core`'s checkbox, the delete path),
    /// and it has to come after this one returns: the removal refuses while a
    /// live agent connection is still on the task, and shedding that connection
    /// is the last thing we do below. `reason` is the user's own note for the
    /// timeline; internal cancels (a conversation the user stopped from the
    /// chat UI, a delete) pass None.
    pub async fn cancel(
        self: &Arc<Self>,
        task_id: i32,
        reason: Option<String>,
    ) -> Result<(), String> {
        let won = work_task_service::cancel(&self.db.conn, task_id, reason.as_deref())
            .await
            .map_err(|e| e.to_string())?;
        if !won {
            return Err("task cannot be canceled in its current state".to_string());
        }
        self.emit_upsert(task_id);

        // Stop a running init command / pre-prompt compaction BEFORE waiting on
        // the task lock: the launch holds that lock for its whole setup, so
        // waiting first would mean waiting out the very `pnpm install` — or the
        // very compaction turn — we are trying to stop. The run_seq we just
        // canceled scopes both to this generation (cancel does not bump it, so
        // the row still carries it).
        if let Ok(task) = work_task_service::get_model(&self.db.conn, task_id).await {
            self.kill_setup_child(task_id, task.run_seq).await;
            self.abort_compaction(task_id, task.run_seq).await;
        }

        // Serialize the teardown with a possibly in-flight launch: the launch
        // holds the task lock across spawn → prompt, and its status gates
        // re-read after each step — so we tear down either before the prompt
        // (gate aborts) or after the turn is truly in flight (manager.cancel
        // aborts a real turn), never interleaved with the prompt enqueue.
        let lock = self.task_lock(task_id).await;
        let _guard = lock.lock().await;

        let conn_id = {
            self.index
                .lock()
                .await
                .iter()
                .find(|(_, (tid, _))| *tid == task_id)
                .map(|(c, _)| c.clone())
        };
        if let Some(conn_id) = conn_id {
            let _ = self.manager.cancel(&self.db.conn, &conn_id).await;
            self.forget_connection(&conn_id).await;
            self.forget_delegation_children_of(&conn_id).await;
            let _ = self.manager.disconnect(&conn_id).await;
        }
        self.awaiting.lock().await.remove(&task_id);

        // Converge a stranded InProgress conversation.
        let task = work_task_service::get_model(&self.db.conn, task_id).await.ok();
        if let Some(conv_id) = task.as_ref().and_then(|t| t.conversation_id) {
            if self.conversation_status(conv_id).await == Some(ConversationStatus::InProgress) {
                self.cancel_conversation(conv_id).await;
            }
        }
        // The slot freed — refill from the queue (and an auto folder's todo).
        if let Some(folder_id) = task.map(|t| t.folder_id) {
            self.pump_folder(folder_id).await;
        }
        Ok(())
    }

    // ── scheduler ───────────────────────────────────────────────────────────

    /// Queue every to-do task whose planned start has arrived, then pump the
    /// folders that gained one. Runs on its own tick and also as a nudge right
    /// after a plan is set, so a time already in the past takes effect at once.
    ///
    /// Claiming does not launch: the task lands in `queued` like any manual
    /// start, and the folder's concurrency limit still governs what actually
    /// runs.
    pub async fn claim_due_scheduled(self: &Arc<Self>) {
        let claimed =
            match work_task_service::claim_due_scheduled(&self.db.conn, chrono::Utc::now()).await {
                Ok(rows) => rows,
                Err(e) => {
                    tracing::warn!("[work_task] scheduled claim error: {e}");
                    return;
                }
            };
        if claimed.is_empty() {
            return;
        }
        let mut folders: Vec<i32> = Vec::new();
        for (task_id, folder_id) in claimed {
            tracing::info!("[work_task] scheduled start claimed task {task_id}");
            self.emit_upsert(task_id);
            if !folders.contains(&folder_id) {
                folders.push(folder_id);
            }
        }
        for folder_id in folders {
            self.pump_folder(folder_id).await;
        }
    }

    // ── pump ────────────────────────────────────────────────────────────────

    /// Launch queued tasks of a folder up to its `max_concurrent` (0 =
    /// unlimited). Serialized per folder so concurrent pumps can't over-launch.
    pub async fn pump_folder(self: &Arc<Self>, folder_id: i32) {
        let lock = {
            let mut locks = self.pump_locks.lock().await;
            locks
                .entry(folder_id)
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        let _guard = lock.lock().await;

        let settings = work_task_service::settings_get_effective(&self.db.conn, folder_id)
            .await
            .unwrap_or_default();
        let max = settings.max_concurrent.max(0) as u64;

        // Scheduler arm: an auto_process folder claims todo heads into the
        // queue until the budget (which counts queued) is spent; the drain
        // loop below then launches them like any manually queued task.
        if settings.auto_process {
            loop {
                match work_task_service::auto_claim_next(
                    &self.db.conn,
                    folder_id,
                    settings.max_concurrent,
                )
                .await
                {
                    Ok(Some(id)) => self.emit_upsert(id),
                    Ok(None) => break,
                    Err(e) => {
                        tracing::warn!("[work_task] auto claim error: {e}");
                        break;
                    }
                }
            }
        }

        loop {
            // Only THIS folder's in-flight launches count against its limit.
            let launching: Vec<i32> = self
                .launching
                .lock()
                .await
                .iter()
                .filter(|(_, owner)| owner.folder_id == folder_id)
                .map(|(tid, _)| *tid)
                .collect();
            let active = match work_task_service::active_launched_count(&self.db.conn, folder_id)
                .await
            {
                Ok(n) => n + launching.len() as u64,
                Err(e) => {
                    tracing::warn!("[work_task] pump count error: {e}");
                    return;
                }
            };
            if max != 0 && active >= max {
                return;
            }
            let next = match work_task_service::next_queued(&self.db.conn, folder_id, &launching)
                .await
            {
                Ok(Some(t)) => t,
                Ok(None) => return,
                Err(e) => {
                    tracing::warn!("[work_task] pump next error: {e}");
                    return;
                }
            };
            // Claimed synchronously: this loop iterates immediately, and the
            // task must already read as in-flight when it does.
            let token = self.claim_launch_slot(next.id, folder_id).await;
            self.spawn_launch_owned(next.id, folder_id, launch_mode_for(&next), Some(token));
        }
    }

    /// Mark `task_id` as owned by a new launch and return the ownership token.
    async fn claim_launch_slot(&self, task_id: i32, folder_id: i32) -> u64 {
        let token = self
            .launch_token
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.launching
            .lock()
            .await
            .insert(task_id, LaunchOwner { folder_id, token });
        token
    }

    /// Give up ownership — but only if the entry is still ours. A launch that
    /// is slowly unwinding must not drop the slot a NEWER launch of the same
    /// task now holds, or the reconcile sweep would requeue a live setup and
    /// the folder's accounting would lose a slot.
    async fn release_launch_slot(&self, task_id: i32, token: u64) {
        let mut launching = self.launching.lock().await;
        if launching.get(&task_id).is_some_and(|o| o.token == token) {
            launching.remove(&task_id);
        }
    }

    fn spawn_launch(self: &Arc<Self>, task_id: i32, folder_id: i32, mode: LaunchMode) {
        self.spawn_launch_owned(task_id, folder_id, mode, None);
    }

    /// `token: Some(_)` when the caller already claimed the slot (the pump,
    /// whose loop must see the task as in-flight the moment it continues);
    /// `None` to claim it here.
    fn spawn_launch_owned(
        self: &Arc<Self>,
        task_id: i32,
        folder_id: i32,
        mode: LaunchMode,
        token: Option<u64>,
    ) {
        let engine = self.clone();
        tokio::spawn(async move {
            let token = match token {
                Some(token) => token,
                None => engine.claim_launch_slot(task_id, folder_id).await,
            };
            // A merge generation stays `merging` and is NEVER failed: it
            // recovers from git truth (`recover_merging`, driven by the
            // reconcile tick) so a half-merge can go back to review.
            let is_merge = matches!(mode, LaunchMode::Merge { .. });
            // The generation the launch actually operated on, published as soon
            // as it has read the row. A setup failure must be attributed to THAT
            // generation: a cancel + requeue (which bumps run_seq) can land
            // while a slow setup is still unwinding, and failing the row by its
            // *current* sequence would kill the fresh run instead.
            let launched_seq = LaunchSeq::default();
            let result = engine.launch(task_id, mode, &launched_seq, None).await;
            let errored = result.is_err();
            if let Err(e) = result {
                tracing::info!("[work_task] launch {task_id}: {e}");
                if let (false, Some(seq)) = (is_merge, launched_seq.get()) {
                    let failed = work_task_service::fail(
                        &engine.db.conn,
                        task_id,
                        &[WorkTaskStatus::Queued, WorkTaskStatus::Preparing],
                        Some(seq),
                        "setup_error",
                        Some(e),
                    )
                    .await
                    .unwrap_or(false);
                    if failed {
                        engine.emit_upsert(task_id);
                    }
                }
            }
            // Released only after the failure is settled: while the entries are
            // held, the reconcile sweep cannot mistake this row for an orphaned
            // `preparing`, and a cancel still has a kill slot to write to.
            engine.release_setup_slot(task_id, launched_seq.get()).await;
            engine.release_launch_slot(task_id, token).await;
            if errored {
                // A slot may have opened up (or this task left the queue) —
                // keep draining.
                engine.pump_folder(folder_id).await;
            }
        });
    }

    // ── launch ──────────────────────────────────────────────────────────────

    /// `dispatched` is fired once the generation is LIVE — the agent answered,
    /// the conversation is bound and the row carries both coordinates — which
    /// is the point a caller that only wanted to start the run can stop
    /// waiting. Everything after it (the pre-prompt compaction turn, the
    /// prompt itself) belongs to the run, not to the click that asked for it.
    /// See [`DispatchSignal`]; `None` for the launches nobody awaits.
    async fn launch(
        self: &Arc<Self>,
        task_id: i32,
        mode: LaunchMode,
        launched_seq: &LaunchSeq,
        dispatched: Option<&DispatchSignal>,
    ) -> Result<(), String> {
        let lock = self.task_lock(task_id).await;
        let _guard = lock.lock().await;

        let task = work_task_service::get_model(&self.db.conn, task_id)
            .await
            .map_err(|e| e.to_string())?;
        if task.status != mode.expected_status() {
            return Ok(()); // canceled (or otherwise moved on) before we got here
        }
        let run_seq = task.run_seq;
        launched_seq.set(run_seq);
        let root = get_folder_core(&self.db, task.folder_id)
            .await
            .map_err(|e| e.to_string())?;

        // Effective agent + config: task override > folder task settings >
        // folder default agent. Audited via a config_effective event (values
        // are inherited live, never frozen).
        let cfg: WorkTaskConfig =
            serde_json::from_str(&task.config).unwrap_or_default();
        let settings = work_task_service::settings_get_effective(&self.db.conn, task.folder_id)
            .await
            .unwrap_or_default();
        let (agent_str, mode_id, config_values) = effective_agent_config(&cfg, &settings, &root);
        let agent_str = agent_str.ok_or_else(|| {
            "no agent configured: set a task agent or a folder default".to_string()
        })?;
        let agent_type = parse_agent_type(&agent_str)?;

        // Cheap validation before any side effects; the full prompt is composed
        // after the spawn, once we know whether the session actually resumed.
        if matches!(mode, LaunchMode::Fresh) && cfg.prompt_blocks.is_empty() {
            return Err("prompt is empty".to_string());
        }

        // Out of the queue: from here the task holds its slot and does real
        // work (worktree, init command, agent spawn), so the board must stop
        // calling it "queued". Losing the CAS means a concurrent cancel or a
        // newer generation took over. A merge generation stays `merging`.
        if !matches!(mode, LaunchMode::Merge { .. }) {
            // Reserve the kill slot BEFORE the row can read as `preparing`, and
            // hold it for the whole phase. A cancel cannot wait for the task
            // lock (this launch holds it across the entire init command), so it
            // must always find somewhere to record itself — including during
            // `ensure_worktree`, which takes seconds on a big repo.
            // `spawn_launch_owned` releases the slot, including when the CAS
            // below loses.
            self.reserve_setup_slot(task_id, run_seq).await;
            if !work_task_service::begin_setup(&self.db.conn, task_id, run_seq)
                .await
                .map_err(|e| e.to_string())?
            {
                return Ok(());
            }
            self.emit_upsert(task_id);
        }

        // Cancel gate before the expensive part of setup, so a cancel that
        // landed while we were reading config never reaches `git worktree add`.
        if !still_expected(&self.db.conn, task_id, run_seq, mode.in_flight_status()).await {
            return Ok(());
        }

        // Worktree: reuse the recorded one when it still exists (retry/return),
        // else mint a fresh one pinned to the base recorded FIRST (no drift
        // window between reading the branch and creating the worktree). A merge
        // generation never creates one — merging a fresh empty worktree would
        // "land" as a no-op tree match.
        let wt = if matches!(mode, LaunchMode::Merge { .. }) {
            self.existing_worktree(&task).await?
        } else {
            let wt = self.ensure_worktree(&task, &root, &settings).await?;
            // Run the folder's init command (deps install etc.) before the
            // agent ever sees the tree. Gated on the setup marker, NOT on "the
            // tree was just created": an init that was killed (cancel) or cut
            // short (restart) leaves a half-installed tree that must initialize
            // again. A failure is a setup error — the task must not start
            // half-initialized.
            if let Some(command) = settings
                .init_command
                .as_deref()
                .map(str::trim)
                .filter(|c| !c.is_empty())
            {
                if !setup_marker_present(&wt.path).await {
                    self.run_init_command(task_id, run_seq, command, &wt.path)
                        .await?;
                    write_setup_marker(&wt.path).await;
                }
            }
            wt
        };

        let _ = work_task_service::record_event(
            &self.db.conn,
            task_id,
            "config_effective",
            "engine",
            Some(serde_json::json!({
                "agent": agent_str,
                "mode": mode_id,
                "model": config_values.get("model"),
            })),
        )
        .await;

        // Announce the worktree folder before any conversation upsert so every
        // client can group the conversation (idempotent re-broadcast).
        if let Ok(detail) = get_folder_core(&self.db, wt.folder_id).await {
            emit_folder_upsert(&self.emitter, detail);
        }

        // Resume the previous session for retry/return/merge when we have one.
        let resume_session_id = match mode {
            LaunchMode::Fresh => None,
            LaunchMode::Retry | LaunchMode::Return { .. } | LaunchMode::Merge { .. } => {
                match task.conversation_id {
                    Some(conv_id) => conversation::Entity::find_by_id(conv_id)
                        .one(&self.db.conn)
                        .await
                        .ok()
                        .flatten()
                        .and_then(|c| c.external_id),
                    None => None,
                }
            }
        };

        let runtime_env =
            build_session_runtime_env(&self.db, agent_type, resume_session_id.as_deref(), &self.data_dir)
                .await
                .map_err(|e| e.to_string())?;
        verify_agent_installed(agent_type)
            .await
            .map_err(|e| e.to_string())?;

        // Cancel gate before spawning the CLI.
        if !still_expected(&self.db.conn, task_id, run_seq, mode.in_flight_status()).await {
            return Ok(());
        }

        let mut resumed = resume_session_id.is_some();
        let conn_id = match self
            .manager
            .spawn_agent(
                agent_type,
                Some(wt.path.clone()),
                resume_session_id.clone(),
                runtime_env.clone(),
                "work_task".to_string(),
                self.emitter.clone(),
                mode_id.clone(),
                config_values.clone(),
            )
            .await
        {
            Ok(id) => id,
            Err(e) if resumed => {
                // Resume failed (e.g. the agent lost the session) → fall back
                // to a fresh session in the same worktree, recorded on the
                // timeline.
                tracing::info!("[work_task] resume failed for task {task_id}: {e}; falling back");
                let _ = work_task_service::record_event(
                    &self.db.conn,
                    task_id,
                    "resume_fallback",
                    "engine",
                    Some(serde_json::json!({ "error": e.to_string() })),
                )
                .await;
                resumed = false;
                self.manager
                    .spawn_agent(
                        agent_type,
                        Some(wt.path.clone()),
                        None,
                        runtime_env,
                        "work_task".to_string(),
                        self.emitter.clone(),
                        mode_id.clone(),
                        config_values.clone(),
                    )
                    .await
                    .map_err(|e| e.to_string())?
            }
            Err(e) => return Err(e.to_string()),
        };

        // Conversation row: reuse when resuming the same session; otherwise a
        // fresh row (fresh runs and resume fallbacks).
        let conversation_id = if resumed {
            task.conversation_id.expect("resumed implies conversation")
        } else {
            let title = conversation_title_for_task(&task.title);
            let id = match create_conversation_core(
                &self.db.conn,
                wt.folder_id,
                agent_type,
                Some(title),
            )
            .await
            {
                Ok(id) => id,
                Err(e) => {
                    let _ = self.manager.disconnect(&conn_id).await;
                    return Err(e.to_string());
                }
            };
            // The card's name IS this session's identity — freeze it the way a
            // manual rename would, or the per-turn auto-title backfill replaces
            // it with whatever the agent's session file parses to (for agents
            // with no title of their own: the first line of the composed
            // prompt, e.g. "项目：/Users/…"). Issue #495.
            //
            // Strictly before the upsert below: that broadcast is how any
            // client first learns this id, so locking first makes a backfill on
            // this row impossible rather than merely unlikely. A failure here
            // only costs the nice title — never the launch.
            if let Err(e) = conversation_service::lock_title(&self.db.conn, id).await {
                tracing::warn!(
                    "[work_task] task {task_id}: could not lock conversation {id} title: {e}"
                );
            }
            id
        };
        emit_conversation_upsert(&self.emitter, &self.db.conn, conversation_id).await;

        // Publish the run's live coordinates NOW, while the status stays what
        // it was (`preparing`, or `merging` for a merge round).
        //
        // A resumed launch may spend minutes on the pre-prompt compaction just
        // below, and until this write the row named the previous generation's
        // dead connection or nothing at all — so every surface that streams a
        // task's session (the board's 查看会话 drawer above all) showed the
        // LAST round's finished transcript while this one's agent was visibly
        // working. Only for a resume: a fresh session cannot compact, reaches
        // `mark_running` in the next breath, and would only gain a row pointing
        // at a conversation its own failure path may still cancel.
        //
        // Losing the CAS means a cancel or a newer generation got here first,
        // and the rest of this launch is that generation's to skip — unwound
        // exactly like the `mark_running` loss below.
        if resumed {
            let bound = if matches!(mode, LaunchMode::Merge { .. }) {
                work_task_service::mark_merging_live(
                    &self.db.conn,
                    task_id,
                    run_seq,
                    conversation_id,
                    &conn_id,
                )
                .await
            } else {
                work_task_service::mark_preparing_live(
                    &self.db.conn,
                    task_id,
                    run_seq,
                    conversation_id,
                    &conn_id,
                )
                .await
            };
            match bound {
                Ok(true) => self.emit_upsert(task_id),
                Ok(false) => {
                    let _ = self.manager.disconnect(&conn_id).await;
                    return Ok(());
                }
                Err(e) => {
                    let _ = self.manager.disconnect(&conn_id).await;
                    return Err(e.to_string());
                }
            }
        }

        // The generation is live: whoever was only waiting for the dispatch to
        // START (the merge click) is released here, before the compaction turn
        // that would otherwise hold their dialog open for its whole duration.
        if let Some(dispatched) = dispatched {
            dispatched.fire(Ok(()));
        }

        // A resumed session carries every earlier round's context. Give the
        // folder's threshold (when set) a chance to shrink it BEFORE this
        // round's prompt goes in — see `compact_before_prompt` for why this
        // sits ahead of the index insert.
        if resumed {
            self.compact_before_prompt(CompactRequest {
                task_id,
                run_seq,
                conn_id: &conn_id,
                agent_type,
                settings: &settings,
                folder_id: wt.folder_id,
                conversation_id,
                in_flight: mode.in_flight_status(),
            })
            .await;
        }

        let mut blocks =
            match compose_prompt(&cfg, &task, &mode, &settings, resumed, &self.db.conn).await {
                Ok(blocks) => blocks,
                // The one path that abandons the connection without a teardown
                // (it always has). A compaction just fenced this connection's
                // completion, and nothing downstream would ever lift that fence.
                Err(e) => {
                    self.compaction_turns.lock().await.remove(&conn_id);
                    return Err(e);
                }
            };
        // Re-encode attached images for the agent that actually answered the
        // handshake. A task's blocks are STORED — the composer picked their
        // encoding from a transient probe that may not have landed, possibly
        // months ago, and the task's agent can change between then and this
        // run. The live session's advertised capabilities are the only truth.
        //
        // Only for a prompt that actually carries an image, and only then do we
        // wait: `spawn_agent` returns before a FRESH session's handshake
        // completes, so the capabilities are typically still unpublished here.
        // Every other launch (the overwhelming majority) pays nothing.
        if blocks.iter().any(carries_image) {
            match self
                .manager
                .wait_for_prompt_capabilities(&conn_id, IMAGE_CAPABILITY_WAIT)
                .await
            {
                Some(caps) => reencode_images(&mut blocks, &caps),
                None => tracing::warn!(
                    "[work_task] task {task_id}: agent never advertised prompt capabilities; \
                     sending attached images as stored"
                ),
            }
        }

        // Register for completion correlation BEFORE prompting so a fast
        // TurnComplete can't race ahead of the index entry.
        self.index
            .lock()
            .await
            .insert(conn_id.clone(), (task_id, run_seq));

        // queued → running (CAS on run_seq) — or, for a merge generation, just
        // record the live coordinates while the status stays merging. Losing
        // means a concurrent cancel/settle — tear down without side effects.
        let marked = if matches!(mode, LaunchMode::Merge { .. }) {
            work_task_service::mark_merging_live(
                &self.db.conn,
                task_id,
                run_seq,
                conversation_id,
                &conn_id,
            )
            .await
        } else {
            work_task_service::mark_running(
                &self.db.conn,
                task_id,
                run_seq,
                conversation_id,
                &conn_id,
            )
            .await
        };
        // A write that FAILED (a busy database, say) leaves this generation in
        // exactly the state a lost CAS does — never marked live, no prompt
        // sent — so it unwinds the same way instead of propagating out with the
        // connection still registered. `launch`'s caller fails the row on an
        // `Err`, and a failed row holding an index entry for a live connection
        // is the stale-binding hazard the run_seq CAS exists to prevent.
        let marked = match marked {
            Ok(marked) => marked,
            Err(e) => {
                self.forget_connection(&conn_id).await;
                let _ = self.manager.disconnect(&conn_id).await;
                if !resumed {
                    self.cancel_conversation(conversation_id).await;
                }
                return Err(e.to_string());
            }
        };
        if !marked {
            self.forget_connection(&conn_id).await;
            let _ = self.manager.disconnect(&conn_id).await;
            if !resumed {
                self.cancel_conversation(conversation_id).await;
            }
            return Ok(());
        }
        self.emit_upsert(task_id);

        let prompt_head = prompt_head(&blocks);
        match self
            .manager
            .send_prompt_linked_with_message_id(
                &self.db,
                &conn_id,
                blocks,
                Some(wt.folder_id),
                Some(conversation_id),
                None,
                None,
            )
            .await
        {
            Ok(_) => {
                // Timeline round marker: lets the transcript viewer label this
                // prompt's turn with its phase (work / retry / return / merge).
                let _ = work_task_service::record_event(
                    &self.db.conn,
                    task_id,
                    "round",
                    "engine",
                    Some(serde_json::json!({
                        "kind": mode.round_kind(),
                        "intent": mode.round_intent().map(FollowUpIntent::as_str),
                        "run_seq": run_seq,
                        "prompt_head": prompt_head,
                    })),
                )
                .await;
                Ok(())
            }
            Err(e) => {
                self.forget_connection(&conn_id).await;
                let _ = self.manager.disconnect(&conn_id).await;
                if !resumed {
                    self.cancel_conversation(conversation_id).await;
                }
                Err(e.to_string())
            }
        }
    }

    /// Resolve (and if needed create) the task's worktree. On creation the base
    /// branch + sha are recorded BEFORE `git worktree add` runs against that
    /// exact sha, and the directory goes wherever the folder's settings put it
    /// (next to the project folder by default).
    async fn ensure_worktree(
        &self,
        task: &crate::db::entities::work_task::Model,
        root: &crate::models::FolderDetail,
        settings: &WorkTaskFolderSettings,
    ) -> Result<WorktreeRef, String> {
        if let Some(wt_id) = task.worktree_folder_id {
            if let Ok(detail) = get_folder_core(&self.db, wt_id).await {
                if Path::new(&detail.path).exists() {
                    return Ok(WorktreeRef {
                        folder_id: detail.id,
                        path: detail.path,
                    });
                }
            }
        }

        // The directory is gone, but the branch may not be: a retry / follow-up
        // after the checkout was removed must continue the work already
        // committed on the branch — not restart on a fresh base while those
        // commits sit stranded on a branch nothing points to. Only when the
        // branch cannot be re-checked-out does the fresh mint below take over
        // (re-recording base + branch).
        if let Some(wt) = self.recreate_worktree_from_branch(task, root, settings).await {
            return Ok(wt);
        }

        // Where the task's branch starts, and what its diff is measured
        // against. Normally both are the project folder's current HEAD; a task
        // created FOR a particular branch starts at that branch's tip instead,
        // and a task that IS a pull request starts at that pull request's head
        // and measures against the merge base (see `pr_checkout_point`).
        let (base_branch, base_sha, start_at) = match self.pr_checkout_point(task, root).await? {
            Some(point) => point,
            None => match chosen_base_branch(task) {
                Some(branch) => {
                    // A branch that is gone by the time the task is claimed
                    // FAILS the setup: the choice exists so the work lands
                    // somewhere specific, and quietly branching from the
                    // checkout instead would be the wrong answer delivered
                    // without a word. The LOCAL branch specifically — the
                    // merge lands into the project checkout, which can only be
                    // on a local branch — and looking it up this way is also
                    // what keeps an arbitrary string out of the git commands
                    // (and out of the merge prompt) downstream: only a name
                    // git itself resolved under `refs/heads/` gets through.
                    let tip = task_git::local_branch_tip(&root.path, &branch)
                        .await
                        .map_err(|e| e.to_string())?
                        .ok_or_else(|| {
                            format!(
                                "the task's base branch '{branch}' does not exist in the \
                                 project folder"
                            )
                        })?;
                    (branch, tip.clone(), tip)
                }
                None => {
                    let head = resolve_git_head(&root.path).await.map_err(|e| e.to_string())?;
                    let base_branch = head.branch.ok_or_else(|| {
                        "project folder is not on a branch (detached HEAD?)".to_string()
                    })?;
                    let base_sha = task_git::rev_parse(&root.path, "HEAD")
                        .await
                        .map_err(|e| e.to_string())?;
                    (base_branch, base_sha.clone(), base_sha)
                }
            },
        };

        let branch = format!("task/{}", task.id);
        let dir = format!("{}-task-{}", basename(&root.path), task.id);
        // A configured root that does not exist yet (the folder's first task)
        // needs no `mkdir`: `git worktree add` creates the leading directories
        // along with the checkout.
        let mut wt_path = worktree_path_in(&root.path, settings.worktree_root.as_deref(), &dir);
        let mut branch_used = branch.clone();

        if let Err(e) = git_worktree_add(
            root.path.clone(),
            branch.clone(),
            wt_path.clone(),
            Some(start_at.clone()),
        )
        .await
        {
            // A leftover from a prior attempt may collide — retry once with a
            // generation-scoped suffix.
            let suffix = format!("r{}b", task.run_seq);
            branch_used = format!("{branch}-{suffix}");
            wt_path = worktree_path_in(
                &root.path,
                settings.worktree_root.as_deref(),
                &format!("{dir}-{suffix}"),
            );
            git_worktree_add(
                root.path.clone(),
                branch_used.clone(),
                wt_path.clone(),
                Some(start_at.clone()),
            )
            .await
            .map_err(|_| format!("worktree add failed: {e}"))?;
        }

        // Whatever a pull-request checkout fetched is now held by the task's
        // own branch, so the names it was fetched under can go.
        self.drop_pr_fetch_refs(task, root).await;

        let wt = open_worktree_folder_core(&self.db, wt_path, task.folder_id)
            .await
            .map_err(|e| e.to_string())?;
        work_task_service::attach_worktree(
            &self.db.conn,
            task.id,
            wt.id,
            &base_branch,
            &base_sha,
            &branch_used,
        )
        .await
        .map_err(|e| e.to_string())?;
        Ok(WorktreeRef {
            folder_id: wt.id,
            path: wt.path,
        })
    }

    /// `(base branch, base sha, start commit)` for a task triggered from a
    /// pull request; `None` for every other task, which starts at the project
    /// folder's HEAD.
    ///
    /// Three decisions live here:
    ///
    /// - **Start at the pull request's head**, fetched through `pull/{n}/head`
    ///   — a ref GitHub keeps even after the head branch is deleted, and the
    ///   only one that works without write access to it.
    /// - **Pin to the OID recorded at trigger time**, not to whatever the ref
    ///   points at now: the user triggered a specific state, and a push landing
    ///   while the task sat in the queue must not silently change the subject.
    ///   When that commit is no longer on the server (a force-push), this
    ///   fails with an explanation instead of checking out a stranger.
    /// - **Measure the diff from the MERGE BASE**, not from the head. The task
    ///   is reviewed as "the pull request plus whatever the agent did", so the
    ///   pull request's own changes have to be inside the diff; anchoring at
    ///   the head would hide exactly what is under review. Anchoring at the
    ///   base branch's tip would be wrong the other way — every commit the base
    ///   gained since would show up as this task's work.
    async fn pr_checkout_point(
        &self,
        task: &crate::db::entities::work_task::Model,
        root: &crate::models::FolderDetail,
    ) -> Result<Option<(String, String, String)>, String> {
        if task.source_kind.as_deref() != Some(SOURCE_KIND_PR) {
            return Ok(None);
        }
        let meta = task
            .source_meta
            .as_deref()
            .and_then(|s| serde_json::from_str::<ForgeSourceMeta>(s).ok())
            .ok_or_else(|| "the task's source information is unreadable".to_string())?;
        let (Some(base_ref), Some(head_sha)) = (meta.base_ref.as_deref(), meta.head_sha.as_deref())
        else {
            return Err(
                "this pull request task is missing its branch information — trigger it again"
                    .to_string(),
            );
        };

        // Per-task ref names: these fetches run in the shared project folder,
        // where `FETCH_HEAD` belongs to whoever wrote it last.
        let base_ref_local = format!("refs/codeg/task-{}/pr-base", task.id);
        let head_ref_local = format!("refs/codeg/task-{}/pr-head", task.id);
        // Fetched with the account the task was triggered by, over an explicit
        // URL — NOT through the folder's `origin`. This is the engine's only
        // setup step that touches the network, and a private repository's
        // origin may be SSH or may have no cached credential at all; going
        // through the pinned identity is what makes a private repository work
        // here at all, and it is the same identity the delivery will push as.
        let ctx = DeliveryCtx {
            conn: &self.db.conn,
            data_dir: &self.data_dir,
            provider: meta.provider,
            server_host: &meta.server_host,
            account_id: &meta.account_id,
            owner_repo: &meta.owner_repo,
        };
        let base_tip = self
            .forge
            .fetch_ref(
                &ctx,
                &root.path,
                &format!("refs/heads/{base_ref}"),
                &base_ref_local,
            )
            .await
            .map_err(|e| {
                format!("could not fetch '{base_ref}', the pull request's base branch: {e}")
            })?;
        // Both forges publish a proposed change's head under a server-side ref
        // — that is what makes it fetchable without adding the contributor's
        // remote — but they spell it differently, and the wrong spelling is
        // simply a ref that does not exist.
        let fetched_head = self
            .forge
            .fetch_ref(
                &ctx,
                &root.path,
                &meta.provider.change_head_ref(meta.number),
                &head_ref_local,
            )
            .await
            .map_err(|e| {
                format!(
                    "could not fetch {} #{}: {e}",
                    meta.provider.change_noun(),
                    meta.number
                )
            })?;

        if !fetched_head.eq_ignore_ascii_case(head_sha)
            && !task_git::commit_present(&root.path, head_sha)
                .await
                .unwrap_or(false)
        {
            return Err(format!(
                "pull request #{} was force-pushed since this task was created, and the commit \
                 it was triggered on ({}) is no longer there — trigger it again from the \
                 workbench to work on the current head",
                meta.number,
                first_chars(head_sha, 7)
            ));
        }
        let base_sha = task_git::merge_base(&root.path, &base_tip, head_sha)
            .await
            .map_err(|e| {
                format!("could not find where pull request #{} branched off: {e}", meta.number)
            })?;
        // The refs stay for now — see `drop_pr_fetch_refs`: until the task's
        // branch exists, they are the only thing keeping what we just fetched
        // reachable. A failed setup leaves them behind, which costs nothing:
        // the next attempt force-updates the same two names.
        Ok(Some((base_ref.to_string(), base_sha, head_sha.to_string())))
    }

    /// Drop the refs `pr_checkout_point` fetched under. Called only once the
    /// task's branch exists: those refs are what keeps the fetched commits
    /// reachable until then, and deleting them earlier would leave a window in
    /// which a concurrent `git gc` could prune what we are about to check out.
    async fn drop_pr_fetch_refs(
        &self,
        task: &crate::db::entities::work_task::Model,
        root: &crate::models::FolderDetail,
    ) {
        if task.source_kind.as_deref() != Some(SOURCE_KIND_PR) {
            return;
        }
        for suffix in ["pr-base", "pr-head"] {
            task_git::delete_ref(&root.path, &format!("refs/codeg/task-{}/{suffix}", task.id)).await;
        }
    }

    /// Try to re-create the task's worktree from its still-existing work
    /// branch (`git worktree add <path> <branch>`, prior commits intact), at
    /// the recorded folder's path — or the standard naming when that row is
    /// gone. `None` when the branch is gone too, the path is occupied, or git
    /// refuses (e.g. the branch is checked out elsewhere) — the caller then
    /// mints a fresh worktree.
    async fn recreate_worktree_from_branch(
        &self,
        task: &crate::db::entities::work_task::Model,
        root: &crate::models::FolderDetail,
        settings: &WorkTaskFolderSettings,
    ) -> Option<WorktreeRef> {
        let branch = task.work_branch.as_deref()?;
        // The recorded base stays authoritative for the branch's history; the
        // three are only ever written together, but a row missing them must
        // fall through to the fresh mint that records them.
        let base_branch = task.base_branch.as_deref()?;
        let base_sha = task.base_sha.as_deref()?;
        // The LOCAL branch specifically — an unqualified lookup would let a
        // same-name tag answer here and the add below would check out a
        // detached HEAD instead of the branch.
        match task_git::local_branch_tip(&root.path, branch).await {
            Ok(Some(_)) => {}
            _ => return None, // branch gone too — nothing to continue from
        }
        // Prefer the recorded folder row's path so the row binds back to the
        // same workspace entry; fall back to the standard naming.
        let recorded = match task.worktree_folder_id {
            Some(wt_id) => get_folder_core(&self.db, wt_id).await.ok().map(|d| d.path),
            None => None,
        };
        let path = recorded.unwrap_or_else(|| {
            worktree_path_in(
                &root.path,
                settings.worktree_root.as_deref(),
                &format!("{}-task-{}", basename(&root.path), task.id),
            )
        });
        if Path::new(&path).exists() {
            return None; // something else lives there now
        }
        if let Err(e) = task_git::worktree_add_existing_branch(&root.path, &path, branch).await {
            tracing::info!(
                "[work_task] task {}: could not re-create the worktree from branch \
                 {branch}: {e}",
                task.id
            );
            return None;
        }
        let wt = match open_worktree_folder_core(&self.db, path.clone(), task.folder_id).await {
            Ok(wt) => wt,
            Err(e) => {
                // The checkout exists but has no folder row; the fresh-mint
                // fallback will collide on the path and suffix itself, so the
                // launch still proceeds.
                tracing::warn!(
                    "[work_task] task {}: recreated worktree at {path} but could not open \
                     its folder: {e}",
                    task.id
                );
                return None;
            }
        };
        // Re-attach under the ORIGINAL base: the branch's history is diffed
        // against it, and re-recording today's HEAD would misstate the change
        // set the review shows.
        if let Err(e) = work_task_service::attach_worktree(
            &self.db.conn,
            task.id,
            wt.id,
            base_branch,
            base_sha,
            branch,
        )
        .await
        {
            tracing::warn!(
                "[work_task] task {}: could not re-attach the recreated worktree: {e}",
                task.id
            );
        }
        Some(WorktreeRef {
            folder_id: wt.id,
            path: wt.path,
        })
    }

    /// The task's recorded worktree, required to exist on disk — the merge
    /// generation must never mint a fresh (empty) one.
    async fn existing_worktree(&self, task: &crate::db::entities::work_task::Model) -> Result<WorktreeRef, String> {
        let wt_id = task
            .worktree_folder_id
            .ok_or_else(|| "task has no worktree".to_string())?;
        let detail = get_folder_core(&self.db, wt_id)
            .await
            .map_err(|e| e.to_string())?;
        if !Path::new(&detail.path).exists() {
            return Err("the task worktree no longer exists on disk".to_string());
        }
        Ok(WorktreeRef {
            folder_id: detail.id,
            path: detail.path,
        })
    }

    /// Run the folder's worktree init command in an uninitialized worktree.
    /// The outcome is always recorded on the timeline; a failure aborts the
    /// launch (setup error) so the agent never starts half-initialized.
    async fn run_init_command(
        &self,
        task_id: i32,
        run_seq: i32,
        command: &str,
        cwd: &str,
    ) -> Result<(), String> {
        let run = self.run_setup_shell(task_id, run_seq, command, cwd).await;
        let (exit_code, tail) = match &run {
            Ok((code, tail)) => (*code, tail.clone()),
            Err(e) => (None, e.clone()),
        };
        let ok = matches!(run, Ok((Some(0), _)));
        let _ = work_task_service::record_event(
            &self.db.conn,
            task_id,
            "init_command",
            "engine",
            Some(serde_json::json!({
                "command": command,
                "exit_code": exit_code,
                "output_tail": (!ok && !tail.is_empty()).then_some(tail.clone()),
            })),
        )
        .await;
        if ok {
            Ok(())
        } else {
            let code = exit_code.map(|c| c.to_string()).unwrap_or_else(|| "?".into());
            Err(format!("worktree init command failed (exit {code}): {tail}"))
        }
    }

    /// Open the kill slot for a generation entering setup. Held for the whole
    /// preparing phase so a cancel always has somewhere to record itself, even
    /// before (or after) a child process exists.
    async fn reserve_setup_slot(&self, task_id: i32, run_seq: i32) {
        self.setup_children.lock().await.insert(
            task_id,
            SetupChild {
                kill_requested: false,
                run_seq,
                wake: Arc::new(Notify::new()),
            },
        );
    }

    /// Close the slot once the launch is over — but only if it is still this
    /// generation's, so a slow unwinding launch cannot drop the slot a newer
    /// one is relying on.
    async fn release_setup_slot(&self, task_id: i32, run_seq: Option<i32>) {
        let Some(run_seq) = run_seq else { return };
        let mut children = self.setup_children.lock().await;
        if children.get(&task_id).is_some_and(|s| s.run_seq == run_seq) {
            children.remove(&task_id);
        }
    }

    /// `run_shell_capture` for the setup phase: the child is bound to the
    /// task's kill slot so a cancel kills its process TREE instead of letting a
    /// multi-minute install run to completion after the user gave up.
    ///
    /// Every cancel window is covered, and the kill always happens HERE, in the
    /// task that owns the child:
    /// - before the spawn → the slot already says `kill_requested`, so no child
    ///   is ever started;
    /// - during the spawn → `notify_one` leaves a permit, so the wait loop's
    ///   first `notified()` returns immediately and kills;
    /// - while waiting → the wake fires and we kill, then keep awaiting the
    ///   child so it is still reaped normally;
    /// - after the child was reaped → nobody holds its pid any more, so a
    ///   recycled pid can never be signalled.
    async fn run_setup_shell(
        &self,
        task_id: i32,
        run_seq: i32,
        line: &str,
        cwd: &str,
    ) -> Result<(Option<i32>, String), String> {
        let wake = {
            // The slot is opened by `launch` before setup begins; re-assert it
            // if it somehow went missing, so the child is never unkillable.
            let mut children = self.setup_children.lock().await;
            let slot = children.entry(task_id).or_insert_with(|| SetupChild {
                kill_requested: false,
                run_seq,
                wake: Arc::new(Notify::new()),
            });
            if slot.kill_requested {
                return Err("canceled before the init command started".to_string());
            }
            slot.run_seq = run_seq;
            slot.wake.clone()
        };
        let child = shell_command(line, cwd)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        let pid = child.id();

        let wait = child.wait_with_output();
        tokio::pin!(wait);
        let mut killed = false;
        let out = loop {
            tokio::select! {
                out = &mut wait => break out,
                // Kill once, then go back to awaiting the child: the process
                // is only reaped by the `wait` branch, so `pid` is still ours.
                _ = wake.notified(), if !killed => {
                    killed = true;
                    kill_process_tree(pid).await;
                }
            }
        };
        let out = out.map_err(|e| e.to_string())?;
        Ok(combine_capture(&out))
    }

    /// Stop the setup of `task_id`, but only when the slot belongs to
    /// generation `run_seq` — a stale cancel must not stop a task that was
    /// already requeued and relaunched. Records the request and wakes the
    /// runner; the actual kill happens in `run_setup_shell`, which is the only
    /// place that knows the child is still alive.
    async fn kill_setup_child(&self, task_id: i32, run_seq: i32) {
        let wake = {
            let mut children = self.setup_children.lock().await;
            match children.get_mut(&task_id) {
                Some(slot) if slot.run_seq == run_seq => {
                    slot.kill_requested = true;
                    slot.wake.clone()
                }
                _ => return,
            }
        };
        wake.notify_one();
    }

    /// Compact the resumed session's context before this round's prompt, when
    /// the folder's settings ask for it (`auto_compact_percent`).
    ///
    /// Placement is the whole design. It runs AFTER the spawn (only a live
    /// session can be compacted, and only a live session can say how full it
    /// is) and BEFORE the `index` insert and `mark_running`, so:
    /// - the compaction turn's `TurnComplete` reaches `on_event` with no index
    ///   entry behind it and is dropped — an indexed one would settle the task
    ///   into review before its actual work started;
    /// - the round's own prompt is sent only once this turn has landed, which
    ///   is the point of the feature.
    ///
    /// The cost of staying out of `index` is that a compaction turn which
    /// somehow blocked on a permission would not flip the card to
    /// `awaiting_input` — it would sit in `preparing` until the user cancels.
    /// Accepted deliberately: compaction is a self-contained summarisation
    /// turn, and the alternative (indexing it) trades a rare stall for a
    /// systematic mis-settle of every task that compacts.
    ///
    /// Out of `index` is NOT out of sight, though. The launch publishes the
    /// run's connection on the row before calling this (see `mark_preparing_live`
    /// / `mark_merging_live`), and this records a `started` timeline entry once
    /// the turn is away, so a wait that can run for minutes is watchable rather
    /// than a card that has apparently stopped.
    ///
    /// Never fails the launch. A compaction that could not be measured, has no
    /// command to run, or ends badly records itself on the timeline and lets
    /// the round proceed: an over-full context makes the next prompt likely to
    /// fail, but refusing to send it makes it certain.
    ///
    /// Only called for a launch that RESUMED — a fresh session's context is
    /// empty by construction.
    async fn compact_before_prompt(&self, req: CompactRequest<'_>) {
        let CompactRequest {
            task_id,
            run_seq,
            conn_id,
            agent_type,
            settings,
            folder_id,
            conversation_id,
            in_flight,
        } = req;
        let threshold = settings.auto_compact_percent;
        if threshold <= 0 {
            return;
        }
        let Some(before) = self.context_reading(conn_id, conversation_id).await else {
            // The agent reports no usable occupancy (no live `usage_update`, and
            // a transcript that carries no window either). Recorded rather than
            // silent: with the threshold switched on, "nothing happened" is a
            // result the user needs an explanation for.
            self.record_compact_event(
                task_id,
                run_seq,
                serde_json::json!({
                    "status": "skipped",
                    "reason": "usage_unknown",
                    "threshold_percent": threshold,
                }),
            )
            .await;
            return;
        };
        if !compact::trips_threshold(before.percent, threshold) {
            return;
        }

        let advertised = match self.manager.get_state(conn_id).await {
            Some(state) => state.read().await.available_commands.clone(),
            None => Vec::new(),
        };
        let Some(command) = compact::resolve_compact_command(
            settings.compact_command.as_deref(),
            agent_type,
            &advertised,
        ) else {
            self.record_compact_event(
                task_id,
                run_seq,
                serde_json::json!({
                    "status": "skipped",
                    "reason": "no_command",
                    "threshold_percent": threshold,
                    "before_percent": round1(before.percent),
                }),
            )
            .await;
            return;
        };

        // Cancel gate, then the kill slot, then the gate AGAIN — the same
        // ordering `reserve_setup_slot` uses for the init command. A cancel
        // that lands before the slot exists is caught by the re-check (it flips
        // the row first); one that lands after finds the slot and aborts the
        // turn. Without the re-check, a cancel in between would fall through to
        // the task lock, which this launch holds until the compaction it is
        // trying to stop has finished.
        if !still_expected(&self.db.conn, task_id, run_seq, in_flight).await {
            return;
        }
        self.compacting.lock().await.insert(
            task_id,
            CompactRun {
                run_seq,
                conn_id: conn_id.to_string(),
            },
        );
        if !still_expected(&self.db.conn, task_id, run_seq, in_flight).await {
            self.release_compact_slot(task_id, run_seq).await;
            return;
        }

        // Subscribed BEFORE the send: the turn can complete the instant it is
        // enqueued, and a receiver only ever sees what is published after it
        // subscribes.
        let mut rx = self.bus.subscribe();
        let sent = self
            .manager
            .send_prompt_linked_with_message_id(
                &self.db,
                conn_id,
                vec![PromptInputBlock::Text {
                    text: command.clone(),
                }],
                Some(folder_id),
                Some(conversation_id),
                None,
                None,
            )
            .await;
        if let Err(e) = sent {
            self.release_compact_slot(task_id, run_seq).await;
            self.record_compact_event(
                task_id,
                run_seq,
                serde_json::json!({
                    "status": "failed",
                    "command": command,
                    "threshold_percent": threshold,
                    "before_percent": round1(before.percent),
                    "error": e.to_string(),
                }),
            )
            .await;
            return;
        }
        // The turn is away and the wait below is unbounded, so this is the only
        // thing that can explain the gap while it runs: a round that sits for
        // minutes between its dispatch and its prompt is otherwise a timeline
        // with nothing in it, and a compaction that never returns leaves no
        // trace at all. Recorded AFTER the send so it never claims a turn that
        // was refused, and paired with the outcome event below.
        self.record_compact_event(
            task_id,
            run_seq,
            serde_json::json!({
                "status": "started",
                "command": command,
                "threshold_percent": threshold,
                "before_percent": round1(before.percent),
                "before_source": before.source,
            }),
        )
        .await;
        self.emit_upsert(task_id);

        let outcome = self.await_compaction_turn(&mut rx, conn_id).await;
        self.release_compact_slot(task_id, run_seq).await;

        // Read the occupancy back from the LIVE session only. The transcript
        // fallback is write-behind, so re-parsing here would report the
        // pre-compaction figure as the result of the compaction.
        let after = self.live_context_reading(conn_id).await;
        let mut payload = serde_json::json!({
            "status": outcome.status,
            "command": command,
            "threshold_percent": threshold,
            "before_percent": round1(before.percent),
            "before_source": before.source,
        });
        if let Some(map) = payload.as_object_mut() {
            if let Some(used) = before.used {
                map.insert("before_used_tokens".into(), used.into());
            }
            if let Some(size) = before.size {
                map.insert("before_size_tokens".into(), size.into());
            }
            if let Some(after) = after.as_ref() {
                map.insert("after_percent".into(), round1(after.percent).into());
                if let Some(used) = after.used {
                    map.insert("after_used_tokens".into(), used.into());
                }
            }
            if let Some(detail) = outcome.detail {
                map.insert("detail".into(), detail.into());
            }
        }
        self.record_compact_event(task_id, run_seq, payload).await;
    }

    /// Wait out the compaction turn on `conn_id`.
    ///
    /// Deliberately unbounded in TIME — compacting a full context is a real
    /// model turn, and a deadline here would just send the round's prompt into
    /// the very context we were told to shrink. What ends the wait is evidence:
    /// the turn completing, the connection dying, or a cancel (which aborts the
    /// turn through [`Self::abort_compaction`], producing a
    /// `TurnComplete{cancelled}` of its own).
    ///
    /// The bus alone is not enough evidence, which is why the wait also polls
    /// liveness. `apply_event` clears `turn_in_flight` on `TurnComplete` but
    /// NOT on a terminal `Error` or `StatusChanged{Disconnected}` — and a
    /// receiver that lags drops whichever of those arrived. Blocking purely on
    /// `recv()` would then park forever on a connection that is already gone,
    /// holding the task lock and taking any later cancel down with it. The tick
    /// never shortens a live turn; it only notices a dead one.
    ///
    /// Records the completing envelope's seq in `compaction_turns` BEFORE
    /// returning, so the engine's own (possibly lagging) receiver can still
    /// recognise it later and refuse to settle the round with it.
    async fn await_compaction_turn(
        &self,
        rx: &mut tokio::sync::broadcast::Receiver<Arc<EventEnvelope>>,
        conn_id: &str,
    ) -> CompactOutcome {
        loop {
            let event = tokio::select! {
                received = rx.recv() => received,
                _ = tokio::time::sleep(COMPACTION_LIVENESS_TICK) => {
                    match self.compaction_still_running(conn_id).await {
                        Some(outcome) => return outcome,
                        None => continue,
                    }
                }
            };
            match event {
                Ok(env) if env.connection_id == conn_id => match &env.payload {
                    AcpEvent::TurnComplete { stop_reason, .. } => {
                        self.mark_compaction_turn(conn_id, env.seq).await;
                        return match stop_reason.as_str() {
                            "cancelled" | "canceled" => CompactOutcome::new("canceled", None),
                            "end_turn" | "" => CompactOutcome::new("ok", None),
                            // The agent REFUSED to run the compaction prompt —
                            // nothing was compacted, so this is not an "ok" with
                            // a footnote. It reaches this arm at all only because
                            // a prompt rejection stopped tearing the connection
                            // down (it used to arrive as the terminal `Error`
                            // below, and settled as `failed`); mapping it
                            // anywhere else would silently promote a failed
                            // compaction to a successful one.
                            "rejected" => CompactOutcome::new(
                                "failed",
                                Some("the agent rejected the compaction prompt".into()),
                            ),
                            // The agent REFUSED to run the compaction prompt —
                            // nothing was compacted, so this is not an "ok" with
                            // a footnote. It reaches this arm at all only because
                            // a prompt rejection stopped tearing the connection
                            // down (it used to arrive as the terminal `Error`
                            // below, and settled as `failed`); mapping it
                            // anywhere else would silently promote a failed
                            // compaction to a successful one.
                            other => CompactOutcome::new("ok", Some(other.to_string())),
                        };
                    }
                    // A terminal error tears the connection down without a
                    // `TurnComplete` (the state is discarded, not settled), so
                    // it has to end the wait itself. Fenced on the way out for
                    // the same reason the liveness exit is: in-order delivery
                    // proves no completion is queued on THIS receiver, but not
                    // that the dying connection emits none after this event.
                    AcpEvent::Error {
                        message,
                        terminal: true,
                        ..
                    } => {
                        self.fence_completed_turns(conn_id).await;
                        return CompactOutcome::new("failed", Some(message.clone()));
                    }
                    AcpEvent::StatusChanged {
                        status: ConnectionStatus::Disconnected | ConnectionStatus::Error,
                    } => {
                        self.fence_completed_turns(conn_id).await;
                        return CompactOutcome::new("failed", Some("connection lost".into()));
                    }
                    _ => {}
                },
                Ok(_) => {}
                // Whatever ended this turn may be among the events the lag
                // dropped, so ask the connection directly instead of waiting
                // for a message that may never come again. Only OUR receiver
                // dropped them — the engine's own copy may still be pending,
                // which is why the probe fences before ending the wait.
                Err(RecvError::Lagged(_)) => {
                    if let Some(outcome) = self.compaction_still_running(conn_id).await {
                        return outcome;
                    }
                }
                Err(RecvError::Closed) => {
                    return CompactOutcome::new("failed", Some("event bus closed".into()))
                }
            }
        }
    }

    /// Liveness probe for a compaction turn: `None` means "still running, keep
    /// waiting", `Some(outcome)` means the wait is over.
    ///
    /// Reads the same flag the send gate itself owns. `send_prompt_inner` sets
    /// `turn_in_flight` synchronously before the send returns, so by the time
    /// this can run, `false` means this turn has already ended and its event
    /// was missed. A connection the manager no longer knows is gone for good —
    /// its state (and any flag on it) was discarded, not settled.
    ///
    /// Ending the wait WITHOUT having seen the completion still has to fence
    /// that completion off, because it may be sitting in the engine's own
    /// receiver right now: the flag is cleared by `apply_event` BEFORE the
    /// envelope is broadcast, so this can observe a finished turn whose event
    /// nobody has delivered yet. The watermark is the connection's current
    /// `event_seq` — every event already emitted is at or below it, and the
    /// round's own completion, which cannot even be prompted until this
    /// function has returned, is necessarily above it.
    async fn compaction_still_running(&self, conn_id: &str) -> Option<CompactOutcome> {
        let Some(state) = self.manager.get_state(conn_id).await else {
            self.fence_completed_turns(conn_id).await;
            return Some(CompactOutcome::new("failed", Some("connection lost".into())));
        };
        let seq = {
            let s = state.read().await;
            if s.turn_in_flight {
                return None;
            }
            s.event_seq
        };
        self.mark_compaction_turn(conn_id, seq).await;
        Some(CompactOutcome::new("ok", Some("turn end not observed".into())))
    }

    /// Fence every `TurnComplete` this connection has emitted so far, for a
    /// wait that is ending without having read one.
    ///
    /// The watermark is the connection's current `event_seq`: everything
    /// already emitted is at or below it, and the round's own completion —
    /// which cannot be prompted until this wait returns — is above it. A
    /// connection the manager has already dropped can report no seq, so its
    /// whole id is fenced; ids are per-launch UUIDs and never reused.
    async fn fence_completed_turns(&self, conn_id: &str) {
        let seq = match self.manager.get_state(conn_id).await {
            Some(state) => state.read().await.event_seq,
            None => u64::MAX,
        };
        self.mark_compaction_turn(conn_id, seq).await;
    }

    /// Fence off every `TurnComplete` up to `seq` on this connection: they
    /// belong to the launch's pre-prompt compaction, not to the round.
    async fn mark_compaction_turn(&self, conn_id: &str, seq: u64) {
        self.compaction_turns
            .lock()
            .await
            .insert(conn_id.to_string(), seq);
    }

    /// Whether this `TurnComplete` is fenced off as a launch's own compaction
    /// signal — in which case `on_event` must not treat it as the round's turn.
    ///
    /// A watermark rather than an exact seq: the wait can end without ever
    /// seeing the completion (see `compaction_still_running`), and it must
    /// still be able to fence one it never read. Self-cleaning — a seq ABOVE
    /// the watermark can only be the round's own turn, which both lets it
    /// through and retires the mark. A connection that never completes another
    /// turn is cleared by `retire_connection` / `forget_connection`.
    async fn claim_compaction_turn(&self, conn_id: &str, seq: u64) -> bool {
        let mut marks = self.compaction_turns.lock().await;
        match marks.get(conn_id).copied() {
            Some(marked) if marked >= seq => true,
            Some(_) => {
                marks.remove(conn_id);
                false
            }
            None => false,
        }
    }

    /// Drop the in-memory traces of a connection this engine is done with: its
    /// run binding and its compaction fence. Paired with the `disconnect` calls
    /// on the launch's teardown paths, which — unlike `retire_connection` —
    /// unwind a generation that never became live.
    async fn forget_connection(&self, conn_id: &str) {
        self.index.lock().await.remove(conn_id);
        self.compaction_turns.lock().await.remove(conn_id);
    }

    /// Abort a pre-prompt compaction this task's launch is waiting on. Called
    /// by `cancel` BEFORE it takes the task lock, for the same reason
    /// [`Self::kill_setup_child`] is: the launch holds that lock across the
    /// whole compaction turn.
    ///
    /// Only cancels the turn — the launch's own teardown (disconnect, and the
    /// conversation when it was not resumed) happens where it always has, on
    /// the `mark_running` CAS it is about to lose.
    async fn abort_compaction(&self, task_id: i32, run_seq: i32) {
        let conn_id = {
            let compacting = self.compacting.lock().await;
            match compacting.get(&task_id) {
                Some(run) if run.run_seq == run_seq => run.conn_id.clone(),
                _ => return,
            }
        };
        let _ = self.manager.cancel(&self.db.conn, &conn_id).await;
    }

    /// Drop this generation's compaction slot. Generation-checked so a slow
    /// unwind can never drop a newer launch's slot.
    async fn release_compact_slot(&self, task_id: i32, run_seq: i32) {
        let mut compacting = self.compacting.lock().await;
        if matches!(compacting.get(&task_id), Some(run) if run.run_seq == run_seq) {
            compacting.remove(&task_id);
        }
    }

    /// Record one step of a compaction on the timeline, stamped with the
    /// generation it belongs to.
    ///
    /// The stamp is load-bearing, not decoration: the board decides "this card
    /// is compacting right now" from the LAST `context_compact` of the current
    /// generation being a `started` with no outcome after it, and an unstamped
    /// event from an earlier round would answer for a round that has moved on.
    async fn record_compact_event(
        &self,
        task_id: i32,
        run_seq: i32,
        mut payload: serde_json::Value,
    ) {
        if let Some(map) = payload.as_object_mut() {
            map.insert("run_seq".into(), run_seq.into());
        }
        let _ = work_task_service::record_event(
            &self.db.conn,
            task_id,
            "context_compact",
            "engine",
            Some(payload),
        )
        .await;
    }

    /// Context-window occupancy of the session about to be prompted: the live
    /// connection first, the parsed transcript second.
    ///
    /// The live reading is the agent's own accounting of the session it just
    /// loaded, and costs a lock. The transcript is what the Session Details
    /// dialog shows and covers every agent that reports usage in its own files
    /// but publishes no ACP `usage_update` — at the price of a full parse,
    /// which is why it only runs when the threshold is switched on and the live
    /// value is missing.
    async fn context_reading(&self, conn_id: &str, conversation_id: i32) -> Option<ContextReading> {
        if let Some(live) = self.live_context_reading(conn_id).await {
            return Some(live);
        }
        // The transcript belongs to the session the ROW names; the compaction
        // goes to the one the CONNECTION holds. Those are the same session on
        // an ordinary resume — but not when a `session/load` failure the
        // adapter swallowed fell through to `session/new`, which `spawn_agent`
        // still reports as success, so the launch still reads as `resumed`
        // (see the codeg#500 note in `send_prompt_linked_with_message_id`).
        // Measuring the old session and compacting the new one would spend a
        // whole turn shrinking a context that is already empty, so the fallback
        // is only trusted when the two ids match exactly.
        //
        // Exactly, not through `continued_session_ids`: that relation answers
        // "is this the same CONVERSATION", and a continuation is precisely the
        // case where the agent restarted and its context was rebuilt — the old
        // transcript's occupancy would not describe the new session.
        let live_session = self
            .manager
            .get_state(conn_id)
            .await?
            .read()
            .await
            .external_id
            .clone()?;
        let row = conversation_service::get_by_id(&self.db.conn, conversation_id)
            .await
            .ok()?;
        if !compact::transcript_describes_live_session(
            row.external_id.as_deref(),
            Some(live_session.as_str()),
        ) {
            tracing::info!(
                conversation_id,
                row_session = row.external_id.as_deref().unwrap_or("<none>"),
                live_session = %live_session,
                "[work_task] transcript occupancy refused: the connection holds a \
                 different session than the row"
            );
            return None;
        }
        let (detail, _) = get_folder_conversation_core(&self.db.conn, conversation_id)
            .await
            .ok()?;
        let stats = detail.session_stats?;
        let percent = stats
            .context_window_usage_percent
            .filter(|p| p.is_finite() && *p > 0.0)
            .or_else(|| {
                compact::occupancy_percent(
                    stats.context_window_used_tokens,
                    stats.context_window_max_tokens,
                )
            })?;
        Some(ContextReading {
            percent,
            used: stats.context_window_used_tokens,
            size: stats.context_window_max_tokens,
            source: "transcript",
        })
    }

    /// The live connection's own `usage_update` reading, if it has published
    /// one.
    async fn live_context_reading(&self, conn_id: &str) -> Option<ContextReading> {
        let state = self.manager.get_state(conn_id).await?;
        let usage = state.read().await.usage.clone()?;
        let percent = compact::occupancy_percent(Some(usage.used), Some(usage.size))?;
        Some(ContextReading {
            percent,
            used: Some(usage.used),
            size: Some(usage.size),
            source: "live",
        })
    }

    /// Start preflight: the target folder must exist, be live, and be a
    /// project root (not a worktree).
    async fn preflight_folder(&self, folder_id: i32) -> Result<(), String> {
        let row = folder::Entity::find_by_id(folder_id)
            .one(&self.db.conn)
            .await
            .map_err(|e| e.to_string())?
            .filter(|f| f.deleted_at.is_none())
            .ok_or_else(|| "folder not found".to_string())?;
        if row.parent_id.is_some() {
            return Err("tasks must run from a project folder, not a worktree".to_string());
        }
        Ok(())
    }

    // ── event settlement ────────────────────────────────────────────────────

    async fn on_event(self: &Arc<Self>, env: &EventEnvelope) {
        match &env.payload {
            AcpEvent::TurnComplete { stop_reason, .. } => {
                // A pre-prompt compaction's completion is the LAUNCH's signal,
                // never the round's — see `compaction_turns` for why the index
                // alone cannot tell them apart from in here.
                if self.claim_compaction_turn(&env.connection_id, env.seq).await {
                    return;
                }
                self.on_turn_complete(&env.connection_id, stop_reason).await;
            }
            AcpEvent::QuestionRequest { question_id, .. } => {
                self.track_request(&env.connection_id, format!("q:{question_id}"), true)
                    .await;
            }
            AcpEvent::QuestionResolved { question_id } => {
                self.track_request(&env.connection_id, format!("q:{question_id}"), false)
                    .await;
            }
            AcpEvent::PermissionRequest { request_id, .. } => {
                self.track_request(&env.connection_id, format!("p:{request_id}"), true)
                    .await;
            }
            AcpEvent::PermissionResolved { request_id } => {
                self.track_request(&env.connection_id, format!("p:{request_id}"), false)
                    .await;
            }
            AcpEvent::PlanApprovalRequest { approval_id, .. } => {
                self.track_request(&env.connection_id, format!("a:{approval_id}"), true)
                    .await;
            }
            AcpEvent::PlanApprovalResolved { approval_id } => {
                self.track_request(&env.connection_id, format!("a:{approval_id}"), false)
                    .await;
            }
            // Both delegation events ride the PARENT's stream, so
            // `env.connection_id` is the (possibly task-owning) parent and the
            // child id is in the payload.
            AcpEvent::DelegationStarted {
                child_connection_id,
                ..
            } => {
                // Scoped to task runs: a delegation from an ordinary chat tab
                // has no board row to flip, and mapping it would grow this map
                // for the life of the process. Resolved through
                // `task_for_connection` rather than `index` alone so a nested
                // delegation (a sub-agent delegating further) maps to the same
                // run — its prompts block the task just as much.
                if self.task_for_connection(&env.connection_id).await.is_some() {
                    self.delegation_parents
                        .lock()
                        .await
                        .insert(child_connection_id.clone(), env.connection_id.clone());
                    // The broker starts the child's turn BEFORE announcing it
                    // (`send_prompt_linked_for_delegation` precedes
                    // `emit_started_if_real`), so a child that blocks
                    // immediately raised its prompt while we had no mapping and
                    // we dropped it. Recover from live state now that we do —
                    // otherwise the board sits at `running` for a run that is
                    // already parked on the user.
                    self.backfill_child_blocking_prompts(child_connection_id)
                        .await;
                }
            }
            AcpEvent::DelegationCompleted {
                child_connection_id,
                ..
            } => {
                self.forget_delegation_child(child_connection_id).await;
            }
            _ => {}
        }
    }

    /// Resolve the task generation an event belongs to, and whether `conn_id` is
    /// the run's OWN connection. A connection that isn't itself a task run may
    /// still be a delegation child of one, in which case the run is its
    /// parent's and the caller must namespace anything it records by
    /// `conn_id` — see [`Self::track_request`].
    ///
    /// Walks the delegation chain rather than one hop: with `depth_limit > 1` a
    /// sub-agent can delegate further, and a grandchild parked on a permission
    /// blocks the run exactly as much as a direct child does. Bounded by
    /// [`MAX_DELEGATION_CHAIN_HOPS`] so a malformed map can never spin.
    ///
    /// Never holds two of the engine's maps at once (each guard is a statement
    /// temporary), matching the discipline the rest of these helpers keep.
    async fn task_for_connection(&self, conn_id: &str) -> Option<((i32, i32), bool)> {
        if let Some(entry) = self.index.lock().await.get(conn_id).copied() {
            return Some((entry, true));
        }
        let mut cursor = conn_id.to_string();
        for _ in 0..MAX_DELEGATION_CHAIN_HOPS {
            let parent = self.delegation_parents.lock().await.get(&cursor).cloned()?;
            if let Some(entry) = self.index.lock().await.get(&parent).copied() {
                return Some((entry, false));
            }
            cursor = parent;
        }
        None
    }

    /// Detach `root`'s delegation-child mappings, transitively, and return every
    /// connection id removed (`root` itself only when `include_root`).
    ///
    /// Transitive because a sub-agent may have delegated further: dropping only
    /// the direct children would strand the deeper links, and — since
    /// [`Self::task_for_connection`] deliberately doesn't prune as it walks —
    /// nothing else would ever collect them.
    ///
    /// Terminates unconditionally: each iteration removes the entries it
    /// enqueues, so the map strictly shrinks.
    async fn detach_delegation_subtree(&self, root: &str, include_root: bool) -> Vec<String> {
        let mut parents = self.delegation_parents.lock().await;
        let mut detached = Vec::new();
        let mut frontier = vec![root.to_string()];
        while let Some(node) = frontier.pop() {
            let children: Vec<String> = parents
                .iter()
                .filter(|(_, parent)| parent.as_str() == node)
                .map(|(child, _)| child.clone())
                .collect();
            for child in children {
                parents.remove(&child);
                frontier.push(child.clone());
                detached.push(child);
            }
        }
        if include_root && parents.remove(root).is_some() {
            detached.push(root.to_string());
        }
        detached
    }

    /// Track any blocking prompt the child is ALREADY parked on, reading its
    /// live `SessionState` (authoritative, and updated independently of the
    /// event bus). Idempotent: re-tracking a key already in the set is a
    /// no-op insert, so a prompt we did see plus this backfill can't
    /// double-count.
    ///
    /// Reads all three prompt kinds rather than the single top-precedence one,
    /// so resolving whichever comes first can't empty the set while another is
    /// still outstanding.
    async fn backfill_child_blocking_prompts(&self, child_conn_id: &str) {
        let Some(state) = self.manager.get_state(child_conn_id).await else {
            return;
        };
        // Collect under the read lock, track after releasing it — `track_request`
        // takes the engine's own maps and must not nest inside a session lock.
        let keys: Vec<String> = {
            let s = state.read().await;
            let mut keys = Vec::new();
            if let Some(p) = s.pending_permission.as_ref() {
                keys.push(format!("p:{}", p.request_id));
            }
            if let Some(q) = s.pending_question.as_ref() {
                keys.push(format!("q:{}", q.question_id));
            }
            if let Some(a) = s.pending_plan_approval.as_ref() {
                keys.push(format!("a:{}", a.approval_id));
            }
            keys
        };
        for key in keys {
            self.track_request(child_conn_id, key, true).await;
        }
    }

    /// Drop every delegation-child mapping belonging to a retired run, and
    /// return the connection ids that were detached — their outstanding
    /// requests are now unanswerable, so whoever does not clear the task's set
    /// wholesale has to retract those keys by hand (see
    /// [`Self::retire_connection`]).
    async fn forget_delegation_children_of(&self, parent_conn_id: &str) -> Vec<String> {
        // `parent_conn_id` is a run connection, never a key in this map.
        self.detach_delegation_subtree(parent_conn_id, false).await
    }

    /// Drop every engine-side trace of a run connection: its `index` entry, the
    /// task's outstanding-request set, and its delegation children.
    ///
    /// `index` is what attributes an incoming event to a task, so an entry that
    /// outlives its connection keeps answering for a row that has moved on —
    /// and `remove_worktree_locked` reads the same map as "a live agent is
    /// working in there". Whoever takes over from a settle that will never
    /// arrive calls this; the entry has no other way out (`reconcile_once`
    /// only ever looks at `running` / `awaiting_input` rows).
    async fn retire_connection(&self, conn_id: &str, task_id: i32) {
        // A connection that is being retired will never complete another turn,
        // so an unspent compaction marker on it would linger for the life of
        // the process. (`claim_compaction_turn` clears every marker whose
        // connection does complete one.)
        self.compaction_turns.lock().await.remove(conn_id);

        // Unmap this run's delegation children FIRST: the purge below needs
        // their ids, and a child that is already detached can no longer publish
        // a fresh key (`track_request` resolves a child through
        // `delegation_parents`, and an unmapped one resolves to nothing).
        let orphaned: Vec<String> = self
            .forget_delegation_children_of(conn_id)
            .await
            .iter()
            .map(|child| format!("{child}#"))
            .collect();

        // The outstanding-request set is keyed by TASK, not by connection, so
        // clearing it while another generation still owns the row would drop
        // ITS pending permissions — resolving one of the survivors then empties
        // an already-empty set and flips the card back to `running` with the
        // agent still parked. Hence "was this the last connection on the task",
        // and hence the `index` guard held ACROSS the clear rather than just
        // the test: a launch registers its generation in `index` before it can
        // publish any request (and a delegation child's keys only exist while
        // its parent is indexed), so holding it is what keeps the answer true
        // until the set is gone. Lock order is index → awaiting; every other
        // `awaiting` critical section is a leaf, so it cannot invert.
        let emptied_for = {
            let mut index = self.index.lock().await;
            index.remove(conn_id);
            let survivor = index
                .values()
                .find(|(tid, _)| *tid == task_id)
                .map(|(_, run_seq)| *run_seq);
            let mut awaiting = self.awaiting.lock().await;
            match survivor {
                // Last one out, so the whole set goes — orphans included. A set
                // inherited by the next generation would never flip the row to
                // `awaiting_input` again.
                None => {
                    awaiting.remove(&task_id);
                    None
                }
                // Someone else still owns the row: keep THEIR requests, but
                // retract this run's children's. Sparing those is the opposite
                // error and the worse one — the chain that named them is gone,
                // so neither `track_request` nor `forget_delegation_child` can
                // resolve them any more, and one key stuck in a shared set pins
                // the survivor on the wrong side of the `running` ⇄
                // `awaiting_input` edge until something clears the set
                // wholesale. Only a LATER retirement that is the last one out
                // (or a cancel) does that, so it outlasts every generation the
                // orphan is actually lying about.
                Some(run_seq) => Self::retract_keys(&mut awaiting, task_id, &orphaned)
                    .then_some(run_seq),
            }
        };

        // Emptied by the retraction alone: the row is parked on requests that
        // just became unanswerable, so return it to the survivor's `running`
        // through the same flip `track_request` would have used.
        if let Some(run_seq) = emptied_for {
            let flipped = work_task_service::flip_awaiting(&self.db.conn, task_id, run_seq, false)
                .await
                .unwrap_or(false);
            if flipped {
                self.emit_upsert(task_id);
            }
        }
    }

    /// Drop every key under `prefixes` from the task's outstanding set,
    /// reporting whether that is what emptied it (and so owes a flip back to
    /// `running`). An untouched set never reports `true`, however empty.
    fn retract_keys(
        awaiting: &mut HashMap<i32, HashSet<String>>,
        task_id: i32,
        prefixes: &[String],
    ) -> bool {
        if prefixes.is_empty() {
            return false;
        }
        let Some(set) = awaiting.get_mut(&task_id) else {
            return false;
        };
        let before = set.len();
        set.retain(|k| !prefixes.iter().any(|p| k.starts_with(p.as_str())));
        if set.len() == before {
            return false; // nothing of this subtree's was outstanding
        }
        if set.is_empty() {
            awaiting.remove(&task_id);
            return true;
        }
        false
    }

    /// Drop a finished delegation child (and anything it delegated in turn) plus
    /// any blocking requests they left unanswered.
    ///
    /// The cleanup is the load-bearing half: a child torn down while a
    /// permission was still pending (cancel, crash, parent teardown) would
    /// otherwise leave its key in the task's outstanding set forever, pinning
    /// the row at `awaiting_input` with nothing left that could ever resolve it.
    /// Empties the set through the same flip path as `track_request` so the row
    /// returns to `running`.
    async fn forget_delegation_child(&self, child_conn_id: &str) {
        // Resolve the run BEFORE detaching — afterwards the chain is gone.
        let entry = self.task_for_connection(child_conn_id).await;
        let detached = self.detach_delegation_subtree(child_conn_id, true).await;
        let Some(((task_id, run_seq), _)) = entry else {
            return;
        };
        let prefixes: Vec<String> = detached.iter().map(|c| format!("{c}#")).collect();
        let emptied = {
            let mut awaiting = self.awaiting.lock().await;
            Self::retract_keys(&mut awaiting, task_id, &prefixes)
        };
        if emptied {
            let flipped = work_task_service::flip_awaiting(&self.db.conn, task_id, run_seq, false)
                .await
                .unwrap_or(false);
            if flipped {
                self.emit_upsert(task_id);
            }
        }
    }

    async fn on_turn_complete(self: &Arc<Self>, conn_id: &str, stop_reason: &str) {
        let entry = { self.index.lock().await.get(conn_id).copied() };
        let Some((task_id, run_seq)) = entry else {
            return; // not a task run
        };

        let summary = self.capture_summary(conn_id).await;
        self.retire_connection(conn_id, task_id).await;
        let _ = self.manager.disconnect(conn_id).await;

        let task = work_task_service::get_model(&self.db.conn, task_id).await.ok();

        // A merge generation settles from git truth whatever the stop reason —
        // the agent may have landed the merge and then errored or been stopped.
        if let Some(t) = task
            .as_ref()
            .filter(|t| t.status == WorkTaskStatus::Merging && t.run_seq == run_seq)
        {
            self.settle_merge_generation(t, stop_reason, summary.as_deref())
                .await;
            self.pump_folder(t.folder_id).await;
            // The folder's one merge slot just freed — the next merge the user
            // queued (or the auto-merge train) can land now.
            self.spawn_merge_pump(t.folder_id);
            return;
        }

        let changed = match stop_reason {
            "end_turn" => {
                // A `task_complete` report from this generation decides the
                // settle: blocked → failed(verdict_blocked); success /
                // needs_review → review. The verdict column is cleared on every
                // claim, so a present verdict is always this generation's — and
                // its summary (written with it) outranks the captured
                // last-assistant text.
                let verdict = task
                    .as_ref()
                    .filter(|t| t.run_seq == run_seq)
                    .and_then(|t| t.verdict.clone());
                if verdict.as_deref() == Some("blocked") {
                    let error = task
                        .as_ref()
                        .and_then(|t| t.result_summary.clone())
                        .unwrap_or_else(|| "agent reported the task as blocked".to_string());
                    work_task_service::fail(
                        &self.db.conn,
                        task_id,
                        &[WorkTaskStatus::Running, WorkTaskStatus::AwaitingInput],
                        Some(run_seq),
                        "verdict_blocked",
                        Some(error),
                    )
                    .await
                    .unwrap_or(false)
                } else {
                    let own_summary = if verdict.is_some() {
                        task.as_ref().and_then(|t| t.result_summary.clone())
                    } else {
                        None
                    };
                    let stats = self.snapshot_diff_stats(task_id).await;
                    let settled = work_task_service::settle_review(
                        &self.db.conn,
                        task_id,
                        run_seq,
                        own_summary.or(summary),
                        stats,
                    )
                    .await
                    .unwrap_or(false);
                    if settled {
                        self.spawn_post_review(task_id, run_seq);
                    }
                    settled
                }
            }
            "cancelled" => {
                // A cancelled task generation is a cancellation, not an agent
                // failure. Keep it generation-scoped: a delayed event must not
                // cancel a task that already reached review or was requeued.
                work_task_service::cancel_running_generation(&self.db.conn, task_id, run_seq)
                    .await
                    .unwrap_or(false)
            }
            other => work_task_service::fail(
                &self.db.conn,
                task_id,
                &[WorkTaskStatus::Running, WorkTaskStatus::AwaitingInput],
                Some(run_seq),
                "agent_error",
                Some(format!("agent stopped: {other}")),
            )
            .await
            .unwrap_or(false),
        };
        if changed {
            self.emit_upsert(task_id);
        }
        // A slot freed up — keep the queue draining.
        if let Ok(task) = work_task_service::get_model(&self.db.conn, task_id).await {
            self.pump_folder(task.folder_id).await;
        }
    }

    /// Track an outstanding blocking request and flip running ⇄ awaiting_input
    /// on the empty↔non-empty edges of the per-task set.
    ///
    /// `conn_id` may be the task's own connection or one of its delegation
    /// children: a sub-agent parked on a permission blocks the run just as
    /// surely as the top-level agent does, and is in fact harder to notice
    /// (#447). A child's keys are prefixed with its connection id so
    /// [`Self::forget_delegation_child`] can retract them as a group.
    async fn track_request(&self, conn_id: &str, key: String, outstanding: bool) {
        let Some(((task_id, run_seq), is_own_connection)) =
            self.task_for_connection(conn_id).await
        else {
            return;
        };
        let key = if is_own_connection {
            key
        } else {
            format!("{conn_id}#{key}")
        };
        let flip = {
            let mut awaiting = self.awaiting.lock().await;
            let set = awaiting.entry(task_id).or_default();
            if outstanding {
                set.insert(key);
                set.len() == 1
            } else {
                set.remove(&key);
                if set.is_empty() {
                    awaiting.remove(&task_id);
                    true
                } else {
                    false
                }
            }
        };
        if flip {
            let flipped =
                work_task_service::flip_awaiting(&self.db.conn, task_id, run_seq, outstanding)
                    .await
                    .unwrap_or(false);
            if flipped {
                self.emit_upsert(task_id);
            }
        }
    }

    // ── codeg-mcp task reporting tools ──────────────────────────────────────

    /// `task_progress`: attribute the report through the connection index and
    /// append an `agent_progress` event (the card/timeline milestone).
    pub async fn record_progress(&self, conn_id: &str, message: &str) -> TaskReportAck {
        let entry = { self.index.lock().await.get(conn_id).copied() };
        let Some((task_id, run_seq)) = entry else {
            return TaskReportAck::rejected("this session is not executing a work task");
        };
        // Generation guard: a stale connection's report is a no-op.
        match work_task_service::get_model(&self.db.conn, task_id).await {
            Ok(task) if task.run_seq == run_seq => {}
            _ => return TaskReportAck::rejected("the task moved on to a new run"),
        }
        if let Err(e) = work_task_service::record_event(
            &self.db.conn,
            task_id,
            "agent_progress",
            "agent",
            // Stamped with the generation that reported it: the card's progress
            // line is a claim about what the run is doing NOW, and a merge (or
            // a retry, or a follow-up) that inherited the previous round's last
            // milestone was narrating work it is not doing.
            Some(serde_json::json!({ "message": message, "run_seq": run_seq })),
        )
        .await
        {
            return TaskReportAck::rejected(&format!("could not record progress: {e}"));
        }
        self.emit_upsert(task_id);
        TaskReportAck::recorded()
    }

    /// `task_complete`: stash the verdict + summary on the current generation;
    /// the TurnComplete settle reads them to decide review vs failed.
    pub async fn record_complete(
        &self,
        conn_id: &str,
        verdict: &str,
        summary: Option<&str>,
    ) -> TaskReportAck {
        let entry = { self.index.lock().await.get(conn_id).copied() };
        let Some((task_id, run_seq)) = entry else {
            return TaskReportAck::rejected("this session is not executing a work task");
        };
        match work_task_service::set_verdict(&self.db.conn, task_id, run_seq, verdict, summary)
            .await
        {
            Ok(true) => {
                self.emit_upsert(task_id);
                TaskReportAck::recorded()
            }
            Ok(false) => TaskReportAck::rejected("the task is not running anymore"),
            Err(e) => TaskReportAck::rejected(&format!("could not record verdict: {e}")),
        }
    }

    // ── preflight (acceptance red/green light) ──────────────────────────────

    /// After a settle into review: run the folder's preflight command (if one
    /// is configured), then give auto-merge its chance. One spawned task, in
    /// that order — the sweep requires a green light whenever a preflight is
    /// configured, so the light must be on the row before the sweep reads it.
    /// Fire-and-forget: the light is written CAS (review + run_seq), so a task
    /// that moved on ignores a slow finish, and the sweep re-checks status.
    fn spawn_post_review(self: &Arc<Self>, task_id: i32, run_seq: i32) {
        let engine = self.clone();
        tokio::spawn(async move {
            engine.run_preflight(task_id, run_seq).await;
            if let Ok(task) = work_task_service::get_model(&engine.db.conn, task_id).await {
                engine.merge_pump(task.folder_id).await;
            }
        });
    }

    async fn run_preflight(&self, task_id: i32, run_seq: i32) {
        let Ok(task) = work_task_service::get_model(&self.db.conn, task_id).await else {
            return;
        };
        let settings = work_task_service::settings_get_effective(&self.db.conn, task.folder_id)
            .await
            .unwrap_or_default();
        // A free-form command wins over a folder-command reference; the
        // reference must still exist and belong to this project folder.
        let custom = settings
            .preflight_command
            .as_deref()
            .map(str::trim)
            .filter(|c| !c.is_empty());
        let (display_name, command_line) = match custom {
            Some(cmd) => (cmd.to_string(), cmd.to_string()),
            None => {
                let Some(command_id) = settings.preflight_command_id else {
                    return;
                };
                let Ok(Some(command)) = folder_command::Entity::find_by_id(command_id)
                    .one(&self.db.conn)
                    .await
                else {
                    return;
                };
                if command.folder_id != task.folder_id {
                    return;
                }
                (command.name, command.command)
            }
        };
        let Some(wt_id) = task.worktree_folder_id else {
            return;
        };
        let Ok(wt) = get_folder_core(&self.db, wt_id).await else {
            return;
        };
        if !Path::new(&wt.path).exists() {
            return;
        }

        let mut light = WorkTaskPreflight {
            status: "running".to_string(),
            command: display_name,
            exit_code: None,
            output_tail: None,
        };
        match work_task_service::set_preflight(&self.db.conn, task_id, run_seq, &light).await {
            Ok(true) => self.emit_upsert(task_id),
            _ => return, // task already moved on
        }

        match run_shell_capture(&command_line, &wt.path).await {
            Ok((code, tail)) => {
                let passed = code == Some(0);
                light.status = if passed { "passed" } else { "failed" }.to_string();
                light.exit_code = code;
                // The tail only matters when the light is red.
                light.output_tail = (!passed && !tail.is_empty()).then_some(tail);
            }
            Err(e) => {
                light.status = "failed".to_string();
                light.output_tail = Some(format!("could not run the command: {e}"));
            }
        }
        if work_task_service::set_preflight(&self.db.conn, task_id, run_seq, &light)
            .await
            .unwrap_or(false)
        {
            self.emit_upsert(task_id);
        }
    }

    /// Best-effort diff-stat snapshot of what THIS TASK produced — measured
    /// from [`own_work_anchor`], not from the review baseline (see that
    /// function for why the two differ on a pull-request task).
    async fn snapshot_diff_stats(&self, task_id: i32) -> Option<(i32, i32, i32)> {
        let task = work_task_service::get_model(&self.db.conn, task_id).await.ok()?;
        let wt_id = task.worktree_folder_id?;
        let wt = get_folder_core(&self.db, wt_id).await.ok()?;
        let anchor = own_work_anchor(&wt.path, &task).await?;
        diff_stats_from(&wt.path, &anchor).await
    }

    /// Boot pass: re-measure the counters of every task sitting in review.
    ///
    /// They were snapshotted when the run settled and nothing rewrites them
    /// afterwards, so a row can outlive the state it describes — a worktree the
    /// user committed to (or reverted) in the meantime, and rows written before
    /// [`own_work_anchor`] existed, which credited a pull-request task with the
    /// pull request's own change set and cost it the "complete" button. The
    /// counters decide which acceptance the board offers, so the correction has
    /// to reach the row itself; recomputing per card is not an option (the list
    /// endpoint would run one `git diff` per task, per refresh).
    ///
    /// Best-effort throughout: an unreadable worktree keeps whatever the row
    /// already says, which is exactly the pre-existing behaviour.
    async fn refresh_review_diff_stats(self: &Arc<Self>) {
        let Ok(rows) = work_task_service::list_by_status(&self.db.conn, &[WorkTaskStatus::Review])
            .await
        else {
            return;
        };
        for task in rows {
            let Some(wt) = self.live_worktree(&task).await else {
                continue;
            };
            let Some(anchor) = own_work_anchor(&wt.path, &task).await else {
                continue;
            };
            let Some(stats) = diff_stats_from(&wt.path, &anchor).await else {
                continue;
            };
            if (task.files_changed, task.additions, task.deletions)
                == (Some(stats.0), Some(stats.1), Some(stats.2))
            {
                continue;
            }
            match work_task_service::refresh_diff_stats(
                &self.db.conn,
                task.id,
                task.run_seq,
                stats,
            )
            .await
            {
                Ok(true) => {
                    tracing::info!(
                        "[work_task] task {}: diff stat corrected to {} file(s), +{}/-{}",
                        task.id,
                        stats.0,
                        stats.1,
                        stats.2
                    );
                    self.emit_upsert(task.id);
                }
                Ok(false) => {} // left review meanwhile — its own settle owns the row
                Err(e) => tracing::warn!(
                    "[work_task] task {}: could not refresh the diff stat: {e}",
                    task.id
                ),
            }
        }
    }

    /// Best-effort: the turn's final assistant text (cleared at next turn
    /// start) becomes the task's result summary.
    async fn capture_summary(&self, conn_id: &str) -> Option<String> {
        let (state, _) = self.manager.get_state_and_emitter(conn_id).await?;
        let text = state.read().await.last_assistant_text.clone();
        text.filter(|t| !t.trim().is_empty())
    }

    // ── accept without merging ─────────────────────────────────────────────

    /// Accept a reviewed task without dispatching a merge generation: review →
    /// done, optionally taking the worktree with it.
    ///
    /// Two ways in, and the board offers exactly one of them per task:
    /// - the recorded diff stat is empty — nothing to land. The stat is a
    ///   snapshot from when the run settled, so git (not the row) re-decides
    ///   under the lock;
    /// - the worktree is GONE (folder row removed, or its directory deleted
    ///   from disk) — a merge generation cannot run at all, so completing is
    ///   the only acceptance left. The leftovers are converged like any other
    ///   removal, except the work branch survives whenever it still holds
    ///   commits the base never received.
    ///
    /// The whole decision runs inside the folder's git lock, with the CAS in
    /// the middle: check, settle and remove form one critical section, leaving
    /// no window in which the task can gain a commit between the check that
    /// cleared it and the `branch -D` that would take it away.
    ///
    /// Two probes on the live-worktree path, because neither alone sees
    /// everything the removal destroys. The anchor diff
    /// ([`Self::has_landable_changes`]) covers commits made on the branch after
    /// the run settled — invisible to `git status` — as well as uncommitted
    /// files, untracked ones included. What it cannot see is a worktree that
    /// differs from its own HEAD while matching the anchor: work committed and
    /// then edited back out is a `git status` finding and an empty diff.
    /// Anything either one finds keeps the worktree on disk.
    pub async fn complete_task(
        self: &Arc<Self>,
        task_id: i32,
        delete_worktree: bool,
    ) -> Result<(), String> {
        let task = work_task_service::get_model(&self.db.conn, task_id)
            .await
            .map_err(|e| e.to_string())?;
        if task.status != WorkTaskStatus::Review {
            return Err("task is not in review".to_string());
        }

        // Held across the check → CAS → removal. Uncontended in the common
        // case: the merge path holds this only for its dispatch, not for the
        // generation that follows.
        let lock = self.folder_lock(task.folder_id).await;
        let _guard = lock.lock().await;

        let live_wt = self.live_worktree(&task).await;
        // Which of the two acceptances this is. The second one's branch may
        // still hold commits nobody landed, so the comment must not say
        // "nothing to land" about it.
        let nothing_to_land = live_wt.is_some();
        let reason = match &live_wt {
            Some(wt) => {
                if self.has_landable_changes(&task, &wt.path).await? {
                    return Err(
                        "this task changed files after all — merge it instead of completing it"
                            .to_string(),
                    );
                }
                "completed without merging: no changes"
            }
            None => "completed without merging: the worktree is gone",
        };
        if !work_task_service::complete_without_merge(&self.db.conn, task_id, reason)
            .await
            .map_err(|e| e.to_string())?
        {
            return Err("task left review before it could be completed".to_string());
        }
        self.emit_upsert(task_id);
        // The third settlement gets a comment too: the setting promises one
        // whenever a forge task finishes, and "accepted, nothing to land" is
        // an outcome the issue's readers want as much as the other two. The
        // CAS above is what makes it one comment and not one per attempt.
        self.spawn_forge_writeback(task_id, WritebackOutcome::Accepted { nothing_to_land });

        if live_wt.is_none() {
            // Nothing usable is left behind the worktree pointer — converge
            // the bookkeeping regardless of the checkbox (there is no worktree
            // left to keep), sparing only a branch that still holds work.
            self.converge_missing_worktree(&task).await;
            self.emit_upsert(task_id);
        } else if delete_worktree {
            if self.worktree_holds_uncommitted(&task).await {
                let _ = work_task_service::set_cleanup_state(
                    &self.db.conn,
                    task_id,
                    true,
                    Some(worktree_kept(RETRY_THE_CLEANUP)),
                )
                .await;
                self.emit_upsert(task_id);
            } else {
                // Broadcast omitted: the removal announces its own outcome.
                self.remove_worktree_locked(task_id, None).await;
            }
        }
        Ok(())
    }

    /// The task's recorded worktree while it can still serve a merge: folder
    /// row live and directory on disk. `None` covers "never recorded", "row
    /// removed" and "directory gone" alike.
    async fn live_worktree(
        &self,
        task: &crate::db::entities::work_task::Model,
    ) -> Option<crate::models::FolderDetail> {
        let wt_id = task.worktree_folder_id?;
        let detail = get_folder_core(&self.db, wt_id).await.ok()?;
        Path::new(&detail.path).exists().then_some(detail)
    }

    /// Converge the leftovers of a worktree that is no longer usable (folder
    /// row removed, or directory gone from disk): prune the stale git
    /// registration, soft-delete the folder row, re-parent its conversations —
    /// the same sequence every other removal runs — EXCEPT that the work
    /// branch survives whenever it still holds commits the base never
    /// received. This path is reached without the user ever confirming a
    /// deletion of work, and `branch -D` is its only irreversible step; a kept
    /// branch stays visible in the branch selector for a manual merge or
    /// delete. Caller holds the folder git lock.
    async fn converge_missing_worktree(&self, task: &crate::db::entities::work_task::Model) {
        let task_id = task.id;
        let Some(wt_id) = task.worktree_folder_id else {
            return; // already detached — nothing to converge
        };
        let root = get_folder_core(&self.db, task.folder_id).await.ok();
        let wt = get_folder_core(&self.db, wt_id).await.ok();
        let (Some(root), Some(wt)) = (root, wt) else {
            // The folder rows are already gone — detach, and tell clients
            // still holding a stale copy to drop it.
            let _ = work_task_service::clear_worktree(&self.db.conn, task_id).await;
            emit_folder_deleted(&self.emitter, wt_id);
            return;
        };
        let mut branch_to_delete = task.work_branch.as_deref();
        if let Some(branch) = branch_to_delete {
            if task_git::branch_holds_unlanded_work(
                &root.path,
                branch,
                task.base_branch.as_deref(),
                task.base_sha.as_deref(),
            )
            .await
            {
                tracing::info!(
                    "[work_task] task {task_id}: keeping branch {branch} — it still holds \
                     unlanded commits"
                );
                let _ = work_task_service::record_event(
                    &self.db.conn,
                    task_id,
                    "user_action",
                    "engine",
                    Some(serde_json::json!({ "action": "branch_kept", "branch": branch })),
                )
                .await;
                branch_to_delete = None;
            }
        }
        if let Err(e) =
            task_git::remove_worktree_and_branch(&root.path, &wt.path, branch_to_delete, None).await
        {
            let _ = work_task_service::set_cleanup_state(
                &self.db.conn,
                task_id,
                true,
                Some(e.to_string()),
            )
            .await;
            return;
        }
        converge_worktree_removal(&self.db, &self.emitter, task_id, wt_id, task.folder_id, &wt.path)
            .await;
    }

    /// Whether the task worktree still has anything uncommitted (tracked edits
    /// or untracked files). No worktree recorded and no folder row both read as
    /// "nothing to lose" — there is no checkout for a removal to destroy.
    async fn worktree_holds_uncommitted(
        &self,
        task: &crate::db::entities::work_task::Model,
    ) -> bool {
        let Some(wt_id) = task.worktree_folder_id else {
            return false;
        };
        let Ok(wt) = get_folder_core(&self.db, wt_id).await else {
            return false;
        };
        path_holds_uncommitted(&wt.path).await
    }

    /// Live git truth for "would an acceptance still have something to take
    /// from this task?" — work committed on the branch after the run settled
    /// (which `git status` reports as a clean worktree) as well as work the
    /// agent never committed, new files included. Measured from
    /// [`own_work_anchor`], the same place the recorded diff stat is taken
    /// from, so the board's offer and this check cannot disagree. `wt_path` is
    /// the already-verified live worktree (see [`Self::live_worktree`]).
    async fn has_landable_changes(
        &self,
        task: &crate::db::entities::work_task::Model,
        wt_path: &str,
    ) -> Result<bool, String> {
        let Some(anchor) = own_work_anchor(wt_path, task).await else {
            return Ok(false);
        };
        let files = task_git::diff_numstat_with_untracked(wt_path, &anchor)
            .await
            .map_err(|e| format!("could not read the task's changes: {e}"))?;
        Ok(!files.is_empty())
    }

    // ── merge (two-stage, persisted intent, per-folder git mutex) ───────────

    /// Land a reviewed task on its base branch. Runs the full stage 0/A/B
    /// pipeline; on any failure the task returns to review with a readable
    /// error. Optionally removes the worktree after landing.
    /// Accept a reviewed task: dispatch a MERGE GENERATION — the agent lands
    /// the task onto the base branch itself in its session, resolving any
    /// conflicts in the same turn. Validation runs before the review→merging
    /// CAS, so a refused merge leaves the task untouched; after dispatch the
    /// settle comes from git truth (`settle_merge_generation` / recovery),
    /// never from the agent's word. `auto` marks a dispatch the engine's
    /// auto-merge sweep issued rather than a click — same pipeline (including
    /// the folder's per-stage prompts), different actor on the timeline.
    ///
    /// A click that arrives while the folder's one merge slot is busy is
    /// QUEUED rather than refused: the intent is parked on the row and the
    /// merge pump dispatches it when the slot frees, so accepting a whole
    /// review column is one pass of clicks instead of a wait per landing. An
    /// unattended dispatch never queues — the sweep runs its own train.
    ///
    /// Returns as soon as the generation is LIVE — the CAS committed and the
    /// agent answered — not when the merge lands, and not when the round's
    /// prompt goes in either: a resumed session may compact first, and that
    /// turn is the run's own work (see [`Self::spawn_merge_launch`]). So the
    /// errors this reports are the ones a caller can act on — a refusal that
    /// left the task untouched, or a dispatch that could not get an agent up —
    /// while anything after that reaches the user on the card.
    ///
    /// `claim` is set only when the pump is spending a merge the user queued
    /// earlier; it binds every write here to that exact parked intent (see
    /// [`QueuedMergeClaim`]). A click passes `None` and always wins.
    pub async fn merge_task(
        self: &Arc<Self>,
        task_id: i32,
        message: Option<String>,
        delete_worktree: bool,
        instructions: Option<String>,
        auto: bool,
    ) -> Result<MergeDispatch, String> {
        self.merge_task_inner(task_id, message, delete_worktree, instructions, auto, None)
            .await
    }

    async fn merge_task_inner(
        self: &Arc<Self>,
        task_id: i32,
        message: Option<String>,
        delete_worktree: bool,
        instructions: Option<String>,
        auto: bool,
        claim: Option<&QueuedMergeClaim>,
    ) -> Result<MergeDispatch, String> {
        let task = work_task_service::get_model(&self.db.conn, task_id)
            .await
            .map_err(|e| e.to_string())?;
        if task.status != WorkTaskStatus::Review {
            return Err("task is not in review".to_string());
        }
        // A pull-request task's work belongs on the pull request's own branch,
        // where its author and reviewers are looking. Landing it straight onto
        // the base here would take the pull request's changes in behind their
        // backs — under a local commit, with the pull request left open and
        // apparently unmerged. The gate is HERE rather than in the UI because
        // this path is reachable by id (an old frontend, a direct API call) and
        // because it covers queueing and the pump's later dispatch too.
        if task.source_kind.as_deref() == Some(SOURCE_KIND_PR) {
            return Err(
                "this task came from a pull request — deliver it back to that pull request \
                 instead of merging it here"
                    .to_string(),
            );
        }
        let message = message
            .map(|m| m.trim().to_string())
            .filter(|m| !m.is_empty());
        // Same normalization as the message: whitespace-only is "the user typed
        // nothing", and nothing is what the prompt must then omit entirely.
        let instructions = instructions
            .map(|i| i.trim().to_string())
            .filter(|i| !i.is_empty());
        let settings = work_task_service::settings_get_effective(&self.db.conn, task.folder_id)
            .await
            .unwrap_or_default();
        let strategy = if settings.merge_strategy == "merge" {
            "merge"
        } else {
            "squash"
        }
        .to_string();
        let (root, _wt, base_branch, work_branch) = self.merge_coordinates(&task).await?;

        // Dispatch under the per-folder git lock: one merge per project at a
        // time, with the base state validated right before the CAS.
        let lock = self.folder_lock(task.folder_id).await;
        let _guard = lock.lock().await;

        let another_merging =
            work_task_service::list_by_status(&self.db.conn, &[WorkTaskStatus::Merging])
                .await
                .map_err(|e| e.to_string())?
                .into_iter()
                .any(|t| t.folder_id == task.folder_id);
        if another_merging {
            if auto {
                // The sweep drains its column one landing at a time and
                // re-sweeps on every settle; a parked unattended intent would
                // outlive the setting that asked for it.
                return Err(
                    "another task of this project is already merging — wait for it".to_string()
                );
            }
            // Take (or keep) a place in line. Reusing the existing `queued_at`
            // is what makes re-queuing — the user reopening the dialog to
            // change the message, or the pump re-parking a merge whose slot got
            // taken first — an edit rather than a trip to the back of the queue.
            let queued_at = claim
                .map(|c| c.queued_at)
                .or_else(|| {
                    work_task_service::queued_merge(task.pending_merge.as_deref())
                        .map(|q| q.queued_at)
                })
                .unwrap_or_else(chrono::Utc::now);
            let intent = WorkTaskQueuedMerge {
                message,
                delete_worktree,
                instructions,
                queued_at,
            };
            let queued = work_task_service::queue_merge(
                &self.db.conn,
                task_id,
                &intent,
                task.run_seq,
                claim.map(|c| c.raw.as_str()),
            )
            .await
            .map_err(|e| e.to_string())?;
            if !queued {
                return Err(missed_queue_cas(claim));
            }
            self.emit_upsert(task_id);
            return Ok(MergeDispatch::Queued);
        }
        let head = resolve_git_head(&root.path).await.map_err(|e| e.to_string())?;
        if head.branch.as_deref() != Some(base_branch.as_str()) {
            // Not necessarily a branch the user wandered off: a task created
            // FOR another branch has a base the project folder may never have
            // been on. So the ask is "put it there", not "put it back".
            return Err(format!(
                "project folder is on '{}', expected '{base_branch}' — switch it to \
                 '{base_branch}' to merge",
                head.branch.as_deref().unwrap_or("detached HEAD")
            ));
        }
        match task_git::staged_clean(&root.path).await {
            Ok(true) => {}
            Ok(false) => {
                return Err(
                    "the project folder has staged changes — commit or unstage them first"
                        .to_string(),
                )
            }
            Err(e) => return Err(e.to_string()),
        }
        let pre_merge_head = task_git::rev_parse(&root.path, "HEAD")
            .await
            .map_err(|e| e.to_string())?;

        let state = WorkTaskMergeState {
            op: WorkTaskMergeOp::Land,
            pre_merge_head,
            message: message.clone().unwrap_or_default(),
            strategy: strategy.clone(),
            delete_worktree,
            auto_message: message.is_none(),
            instructions: instructions.clone(),
            ..Default::default()
        };
        // Keep recovery away from the dispatch window (begin → live conn).
        // Losing the claim REFUSES the dispatch rather than continuing without
        // ownership: the claim and the CAS are independent, so a claim-loser
        // can still win review→merging, and the claim-holder's own CAS failure
        // would then release the only registry entry — leaving the winning
        // generation unowned for exactly the window this registry exists to
        // cover. The wording keeps `is_benign_merge_race` true, so the
        // unattended sweep skips this round instead of bannering the card.
        let Some(in_flight) = self.claim_in_flight(task_id).await else {
            return Err(
                "this task is already merging — wait for the operation in flight".to_string(),
            );
        };
        // `task.run_seq` was read before the folder lock; the CAS binds the
        // dispatch to that exact generation, so waiting out the lock behind an
        // attempt that failed (and bannered the row) misses instead of
        // redispatching — the auto path's no-retry latch depends on this.
        let began = work_task_service::begin_merge(
            &self.db.conn,
            task_id,
            &state,
            task.run_seq,
            auto,
            claim.map(|c| c.raw.as_str()),
        )
        .await;
        // The folder lock covered what it is for: validating the base state and
        // committing the CAS as one step. The row now reads `merging`, which is
        // what makes the next dispatch queue, and the launch below wants the
        // TASK lock — which `remove_worktree_locked` takes before this one.
        drop(_guard);
        let result = match began {
            Err(e) => Err(e.to_string()),
            Ok(None) => Err(match claim {
                Some(_) => missed_queue_cas(claim),
                None => "task left review before the merge began".to_string(),
            }),
            Ok(Some(_run_seq)) => {
                self.emit_upsert(task_id);
                // The claim goes with it: from here the launch owns this
                // generation, and it is the only thing that releases it.
                return self
                    .spawn_merge_launch(
                        task_id,
                        task.folder_id,
                        LaunchMode::Merge {
                            root_path: root.path.clone(),
                            base_branch: base_branch.clone(),
                            work_branch: work_branch.clone(),
                            strategy,
                            message,
                            instructions,
                        },
                        in_flight,
                    )
                    .await;
            }
        };
        // Only a dispatch that never spent the CAS gets here, so the claim is
        // still this call's to give back.
        self.release_in_flight(task_id, in_flight).await;
        self.emit_upsert(task_id);
        result
    }

    /// Run a merge generation's launch off-thread and wait only for it to
    /// become LIVE (see [`Self::launch`]'s `dispatched`).
    ///
    /// The caller is a click on the merge dialog's button, and everything past
    /// the live agent — the pre-prompt context compaction above all, which is
    /// deliberately unbounded in time — is the run's own work, reported on the
    /// card through `task://changed` like every other round. Awaiting it here
    /// is what used to hold that dialog open, spinner and all, for the whole
    /// compaction of a full context window.
    ///
    /// Inherits the in-flight claim: it must outlive the WHOLE launch (it is
    /// what keeps `recover_merging` off a generation that is still setting up),
    /// so releasing it at dispatch would hand a compacting merge to the very
    /// recovery pass this registry exists to hold back.
    ///
    /// A launch that fails before going live is reported to the caller AND
    /// settled here, so the two never disagree about a merge that never ran.
    async fn spawn_merge_launch(
        self: &Arc<Self>,
        task_id: i32,
        folder_id: i32,
        mode: LaunchMode,
        in_flight: u64,
    ) -> Result<MergeDispatch, String> {
        let (dispatched, live) = DispatchSignal::new();
        let engine = self.clone();
        tokio::spawn(async move {
            // A merge generation never transitions out of `merging` here, so
            // the sequence sink stays unused — a failure goes back to review
            // through `back_to_review` below.
            let merge_seq = LaunchSeq::default();
            let result = engine
                .launch(task_id, mode, &merge_seq, Some(&dispatched))
                .await;
            if let Err(e) = &result {
                engine
                    .back_to_review(task_id, format!("merge dispatch failed: {e}"), None)
                    .await;
            }
            // Settle first, THEN release, and only then let the caller go: a
            // dispatch that returns an error has to leave a task nothing is
            // holding — otherwise the click's next act (re-merging, say) races
            // this generation's own teardown.
            engine.release_in_flight(task_id, in_flight).await;
            // Whatever happened, the caller stops waiting: `fire` is a no-op
            // once the launch has already reported itself live, so a failure
            // AFTER the dispatch (the round's own prompt refused, say) is left
            // to the card rather than replayed into a dialog that has closed.
            dispatched.fire(result.clone());
            engine.emit_upsert(task_id);
            if result.is_err() {
                // The folder's merge slot never really got spent — let the next
                // queued landing (or the auto-merge train) have it.
                engine.spawn_merge_pump(folder_id);
            }
        });
        // A sender dropped without firing means the launch returned early
        // without dispatching (a cancel gate, a lost CAS): the row is still
        // `merging` and nobody failed it, exactly as before this ran off-thread
        // — `recover_merging` settles it from git truth on the next tick.
        live.await.unwrap_or(Ok(())).map(|()| MergeDispatch::Dispatched)
    }

    /// Settle a finished merge generation from git truth: landed ⟺ the base
    /// HEAD moved and contains the work (branch ancestry for merge commits,
    /// tree equality for squashes). Anything else goes back to review with the
    /// reason, after cleaning any half-done merge out of the project folder.
    async fn settle_merge_generation(
        self: &Arc<Self>,
        task: &crate::db::entities::work_task::Model,
        stop_reason: &str,
        summary: Option<&str>,
    ) {
        let task_id = task.id;
        let Some(state) = task
            .merge_state
            .as_deref()
            .and_then(|s| serde_json::from_str::<WorkTaskMergeState>(s).ok())
        else {
            self.back_to_review(task_id, "merge state lost — please merge again".to_string(), None)
                .await;
            return;
        };
        let root = match get_folder_core(&self.db, task.folder_id).await {
            Ok(r) => r,
            Err(e) => {
                self.back_to_review(task_id, e.to_string(), None).await;
                return;
            }
        };
        let lock = self.folder_lock(task.folder_id).await;
        let _guard = lock.lock().await;

        match self.merge_landed_commit(task, &state, &root.path).await {
            Ok(Some(commit)) => {
                let landed = work_task_service::merge_landed(&self.db.conn, task_id, &commit)
                    .await
                    .unwrap_or(false);
                if landed {
                    self.emit_upsert(task_id);
                    // Only on the transition — `merge_landed` is a CAS, so a
                    // second settle of the same generation posts nothing.
                    self.spawn_forge_writeback(task_id, WritebackOutcome::Merged(commit));
                    if state.delete_worktree {
                        self.remove_worktree_locked(task_id, None).await;
                    }
                }
            }
            Ok(None) => {
                self.clean_merge_residue(&root.path).await;
                let reason = match stop_reason {
                    "end_turn" => match summary.map(str::trim).filter(|s| !s.is_empty()) {
                        Some(s) => format!(
                            "the agent finished without landing the merge: {}",
                            first_chars(s, 300)
                        ),
                        None => "the agent finished without landing the merge — review and \
                                 merge again"
                            .to_string(),
                    },
                    "cancelled" => "the merge run was stopped before landing".to_string(),
                    other => format!("the merge run failed before landing: {other}"),
                };
                self.back_to_review(task_id, reason, None).await;
            }
            Err(e) => {
                self.back_to_review(task_id, format!("could not verify the merge: {e}"), None)
                    .await;
            }
        }
    }

    /// `Some(base HEAD)` when git truth says this task landed on the base.
    /// The commit message is deliberately not consulted — it may have been
    /// written by the agent.
    async fn merge_landed_commit(
        &self,
        task: &crate::db::entities::work_task::Model,
        state: &WorkTaskMergeState,
        root_path: &str,
    ) -> Result<Option<String>, String> {
        let head = task_git::rev_parse(root_path, "HEAD")
            .await
            .map_err(|e| e.to_string())?;
        if head == state.pre_merge_head {
            return Ok(None);
        }
        let Some(work_branch) = task.work_branch.as_deref() else {
            return Ok(None);
        };
        let ancestor = task_git::is_ancestor(root_path, work_branch, &head)
            .await
            .unwrap_or(false);
        let same_tree = task_git::trees_equal(root_path, &head, work_branch)
            .await
            .unwrap_or(false);
        Ok((ancestor || same_tree).then_some(head))
    }

    /// Clean a half-done landing out of the project folder: an in-progress
    /// merge (MERGE_HEAD) or a staged-but-uncommitted squash.
    async fn clean_merge_residue(&self, root_path: &str) {
        let residue = task_git::has_merge_head(root_path).await.unwrap_or(false)
            || !task_git::staged_clean(root_path).await.unwrap_or(true);
        if residue {
            let _ = task_git::reset_merge(root_path).await;
        }
    }

    async fn back_to_review(
        &self,
        task_id: i32,
        error: String,
        conflict_files: Option<Vec<String>>,
    ) {
        let _ = work_task_service::merge_back_to_review(
            &self.db.conn,
            task_id,
            None,
            Some(error),
            conflict_files,
        )
        .await;
        self.emit_upsert(task_id);
    }

    /// merging → review for a DELIVERY, bound to the generation the caller is
    /// acting on. Crash recovery can spend seconds at the forge before it
    /// decides, and by then the row may already belong to a delivery someone
    /// started since — `status = merging` alone would let the stale pass bounce
    /// the live one.
    async fn bounce_delivery(
        &self,
        task: &crate::db::entities::work_task::Model,
        error: String,
    ) {
        let _ = work_task_service::merge_back_to_review(
            &self.db.conn,
            task.id,
            Some(task.run_seq),
            Some(error),
            None,
        )
        .await;
        self.emit_upsert(task.id);
    }

    /// Resolve (project folder, worktree folder, base branch, work branch) or
    /// explain what's missing.
    async fn merge_coordinates(
        &self,
        task: &crate::db::entities::work_task::Model,
    ) -> Result<
        (
            crate::models::FolderDetail,
            crate::models::FolderDetail,
            String,
            String,
        ),
        String,
    > {
        let root = get_folder_core(&self.db, task.folder_id)
            .await
            .map_err(|e| e.to_string())?;
        let wt_id = task
            .worktree_folder_id
            .ok_or_else(|| "task has no worktree".to_string())?;
        let wt = get_folder_core(&self.db, wt_id)
            .await
            .map_err(|e| e.to_string())?;
        if !Path::new(&wt.path).exists() {
            return Err("the task worktree no longer exists on disk".to_string());
        }
        let base_branch = task
            .base_branch
            .clone()
            .ok_or_else(|| "task has no recorded base branch".to_string())?;
        let work_branch = task
            .work_branch
            .clone()
            .ok_or_else(|| "task has no recorded work branch".to_string())?;
        Ok((root, wt, base_branch, work_branch))
    }

    // ── in-flight ownership (merge / delivery) ──────────────────────────────

    /// Claim in-flight ownership of a task, so the reconcile sweep leaves its
    /// `merging` row alone. `None` when another operation in this process
    /// already holds it.
    async fn claim_in_flight(&self, task_id: i32) -> Option<u64> {
        let token = self
            .in_flight_token
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            + 1;
        match self.merging.lock().await.entry(task_id) {
            std::collections::hash_map::Entry::Occupied(_) => None,
            std::collections::hash_map::Entry::Vacant(slot) => {
                slot.insert(token);
                Some(token)
            }
        }
    }

    /// Release a claim — and ONLY our own. Comparing the token is what keeps a
    /// losing attempt from freeing the winner's task.
    async fn release_in_flight(&self, task_id: i32, token: u64) {
        let mut held = self.merging.lock().await;
        if held.get(&task_id) == Some(&token) {
            held.remove(&task_id);
        }
    }

    // ── deliver to the forge (push + pull request) ──────────────────────────

    /// Accept a reviewed forge-sourced task by DELIVERING it: push the work
    /// branch to the repository the work belongs in — the issue's own
    /// repository, or for a pull-request task the repository its head branch
    /// lives in (a fork, when it came from one) — then adopt or open the pull
    /// request that carries it. The third way to `done`, alongside a local
    /// merge and an acceptance with nothing to land.
    ///
    /// Unlike a merge this needs no agent — there are no conflicts to resolve,
    /// just a push and two REST calls — so the engine runs it itself and
    /// settles from the forge's answer instead of from an agent's word.
    ///
    /// Every precondition is checked BEFORE the review→merging CAS, so a
    /// refused delivery leaves the task exactly as it was. After the CAS, any
    /// failure returns the task to review with the reason on the card; every
    /// step is idempotent, so the retry is just another click.
    ///
    /// `delete_worktree` is the same offer the other two acceptances make, and
    /// it rides on the delivery rather than gating it — see
    /// [`Self::remove_delivered_worktree`].
    pub async fn deliver_pr(
        self: &Arc<Self>,
        task_id: i32,
        pr_title: Option<String>,
        draft: bool,
        delete_worktree: bool,
    ) -> Result<String, String> {
        let task = work_task_service::get_model(&self.db.conn, task_id)
            .await
            .map_err(|e| e.to_string())?;
        if task.status != WorkTaskStatus::Review {
            return Err("task is not in review".to_string());
        }
        // The gate lives HERE, not in the UI: this command is reachable by id
        // from an old frontend or a direct web API call.
        let from_pull = match task.source_kind.as_deref() {
            Some(SOURCE_KIND_ISSUE) => false,
            Some(SOURCE_KIND_PR) => true,
            _ => {
                return Err(
                    "only tasks triggered from a forge issue or pull request can be delivered"
                        .to_string(),
                )
            }
        };
        let meta = task
            .source_meta
            .as_deref()
            .and_then(|s| serde_json::from_str::<ForgeSourceMeta>(s).ok())
            .ok_or_else(|| "the task's source information is unreadable".to_string())?;

        let (_root, wt, base_branch, work_branch) = self.merge_coordinates(&task).await?;
        // Where the push lands. An issue's task publishes its own branch; a
        // pull request's task pushes back to the branch that pull request
        // already tracks, so its author sees the work in the review they
        // opened rather than in a second one.
        let remote_branch = if from_pull {
            let head_ref = meta
                .head_ref
                .clone()
                .filter(|r| !r.trim().is_empty())
                .ok_or_else(|| {
                    "this pull request task does not know which branch to push back to — \
                     trigger it again"
                        .to_string()
                })?;
            // The push lands in the recorded HEAD repository — the fork, when
            // the pull request comes from one. Resolvability is re-checked
            // here, before the CAS, so a row whose fork codeg cannot name
            // (written by an older build, or hydrated while the fork was
            // already gone) is refused with the task left exactly as it was.
            pull_push_repo(&meta)?;
            head_ref
        } else {
            work_branch.clone()
        };
        // A FAILING clean check, deliberately not `worktree_holds_uncommitted`:
        // that one reads a git error as "clean" because its caller (worktree
        // removal) is tolerant of a worktree already off disk. Publishing a
        // branch on the strength of a question git refused to answer is a very
        // different bet.
        match task_git::has_changes(&wt.path).await {
            Ok(false) => {}
            Ok(true) => {
                return Err("the task worktree still has uncommitted changes — send it back for \
                            one more round so the agent commits them, then deliver"
                    .to_string())
            }
            Err(e) => return Err(format!("could not read the task worktree's state: {e}")),
        }
        // GitHub answers an empty pull request with a 422, and a push back that
        // carries nothing leaves the pull request untouched while the task
        // records a delivery. Refuse before the CAS and point at the button that
        // actually applies — the likeliest task here is a review-only one,
        // whose worktree holds the pull request and nothing else.
        if !self.has_landable_changes(&task, &wt.path).await? {
            return Err(if from_pull {
                "this task added nothing to the pull request — complete it instead of pushing back"
            } else {
                "this task has nothing to deliver — complete it instead of opening a pull request"
            }
            .to_string());
        }
        // The pull request is diffed against the base branch AS THE REMOTE HAS
        // IT, not against the local one the task branched from. If those have
        // drifted apart — unpushed commits on the local base — the pull request
        // would carry work the review never showed, and merging it would land
        // that work too.
        //
        // This gate FAILS CLOSED. Being unable to read the remote base is not
        // reassurance: a base branch that does not exist there fails the same
        // way, and the push that follows would still publish the branch (it is
        // only the pull request that needs the base to exist), so nothing
        // downstream re-asks this question. Refusing costs a retry; guessing
        // costs published work nobody reviewed.
        let ctx = DeliveryCtx {
            conn: &self.db.conn,
            data_dir: &self.data_dir,
            provider: meta.provider,
            server_host: &meta.server_host,
            account_id: &meta.account_id,
            owner_repo: &meta.owner_repo,
        };
        if let Some(base_sha) = task.base_sha.as_deref() {
            let Some(remote_tip) = self
                .forge
                .remote_base_tip(&ctx, &wt.path, &base_branch)
                .await
            else {
                return Err(format!(
                    "could not read '{base_branch}' from the source repository, so there is no \
                     way to tell whether this task's starting point is published — check that \
                     the branch exists there and that you are online, then deliver"
                ));
            };
            if !task_git::is_ancestor(&wt.path, base_sha, &remote_tip)
                .await
                .unwrap_or(false)
            {
                return Err(format!(
                    "'{base_branch}' has commits here that are not on the remote yet, so the \
                     pull request would carry more than this task's own work — push \
                     '{base_branch}' first, then deliver"
                ));
            }
        }

        let expected_head = task_git::rev_parse(&wt.path, &work_branch)
            .await
            .map_err(|e| format!("could not resolve the task branch: {e}"))?;
        let title = pr_title
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| task.title.clone());

        let state = WorkTaskMergeState {
            op: WorkTaskMergeOp::DeliverPr,
            remote_branch: Some(remote_branch.clone()),
            expected_head: Some(expected_head.clone()),
            pr_title: Some(title.clone()),
            draft,
            ..Default::default()
        };

        // Ownership BEFORE the CAS and held across the whole delivery — not
        // just the dispatch, the way a merge does it. A merge hands off to its
        // agent session and `recover_merging` then sees a live connection; a
        // delivery has no session at all, so this claim is the only thing
        // telling the reconcile tick that the row's `merging` is alive and not
        // orphaned. It doubles as mutual exclusion: two clients clicking
        // deliver on the same task must not both run the push.
        let Some(token) = self.claim_in_flight(task_id).await else {
            return Err(
                "this task is already merging — wait for the operation in flight".to_string(),
            );
        };
        let outcome = self
            .deliver_guarded(
                &task,
                &meta,
                &wt.path,
                &base_branch,
                &work_branch,
                &remote_branch,
                from_pull,
                &state,
            )
            .await;
        // Only after the delivery SUCCEEDED: one that bounced back to review
        // still needs its checkout for the retry. Still inside the claim, so a
        // second click cannot start a delivery on a task whose worktree is
        // half removed. `expected_head` is the OID the push published, and the
        // cleanup is allowed to destroy the branch only while it is still that.
        if outcome.is_ok() && delete_worktree {
            self.remove_delivered_worktree(task_id, task.folder_id, &expected_head)
                .await;
        }
        self.release_in_flight(task_id, token).await;
        self.emit_upsert(task_id);
        outcome
    }

    /// Take a delivered task's worktree with it, the way the merge and the
    /// no-merge acceptances do. Runs AFTER the settle, on a task that is
    /// already `done`, and deliberately returns nothing: the delivery is what
    /// the button promised and it has happened — a removal that fails flags
    /// `cleanup_state` and stays retryable from the card, which must not
    /// re-read as "the push failed".
    ///
    /// TWO probes, because each is blind to exactly what the other sees — the
    /// pairing `complete_task` documents, aimed at what a DELIVERY publishes
    /// rather than at what a merge lands:
    ///
    /// - `deliver_pr` refused a dirty worktree before the CAS, but that was
    ///   before the push and the REST calls. `worktree remove --force` drops
    ///   whatever appeared since without a word, and a file that was never
    ///   committed is on no forge at all;
    /// - a COMMIT made in that same window leaves `git status` spotless and is
    ///   just as unpublished — the delivery pushed `published_head`, not it. So
    ///   the branch tip is checked against the OID that actually reached the
    ///   forge, which is the only thing that ever made `branch -D` safe here.
    ///   `has_landable_changes` cannot serve as that probe: it is true of every
    ///   delivery by construction.
    ///
    /// Either probe keeps the worktree, says why, and leaves the retry on the
    /// card. The tip then rides along to the removal itself, so the read above
    /// and the delete cannot straddle a ref that moves in between.
    ///
    /// Takes the folder git lock, so no caller may already hold it.
    async fn remove_delivered_worktree(
        self: &Arc<Self>,
        task_id: i32,
        folder_id: i32,
        published_head: &str,
    ) {
        let lock = self.folder_lock(folder_id).await;
        let _guard = lock.lock().await;
        let Ok(task) = work_task_service::get_model(&self.db.conn, task_id).await else {
            return;
        };
        if let Some(reason) = self.delivered_worktree_keep_reason(&task, published_head).await {
            let _ =
                work_task_service::set_cleanup_state(&self.db.conn, task_id, true, Some(reason))
                    .await;
            self.emit_upsert(task_id);
            return;
        }
        // Broadcast omitted: the removal announces its own outcome.
        self.remove_worktree_locked(task_id, Some(published_head)).await;
    }

    /// Why a delivered task's checkout must outlive the cleanup its user asked
    /// for, or `None` when nothing objects. See
    /// [`Self::remove_delivered_worktree`] for what the two answers protect.
    ///
    /// The tip half FAILS CLOSED: a branch git declines to resolve is not a
    /// branch anyone may `-D`. The `None`s above it are the opposite case and
    /// deliberately so — no worktree recorded, no folder row, no work branch
    /// means there is nothing here for the removal to destroy, and it already
    /// handles each of those itself.
    async fn delivered_worktree_keep_reason(
        &self,
        task: &crate::db::entities::work_task::Model,
        published_head: &str,
    ) -> Option<String> {
        let wt_id = task.worktree_folder_id?;
        let wt = get_folder_core(&self.db, wt_id).await.ok()?;
        if path_holds_uncommitted(&wt.path).await {
            return Some(worktree_kept(RETRY_THE_CLEANUP));
        }
        let branch = task.work_branch.as_deref()?;
        match task_git::rev_parse(&wt.path, branch).await {
            Ok(tip) if tip.eq_ignore_ascii_case(published_head) => None,
            Ok(_) => Some(format!(
                "the worktree was kept: '{branch}' moved on after the delivery, so it holds \
                 commits that were never pushed. Deliver again to publish them, or remove the \
                 worktree by hand once they are safe."
            )),
            Err(e) => Some(format!(
                "the worktree was kept: '{branch}' could not be read, so there is no telling \
                 whether it still holds only the delivered work ({e})"
            )),
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn deliver_guarded(
        self: &Arc<Self>,
        task: &crate::db::entities::work_task::Model,
        meta: &ForgeSourceMeta,
        wt_path: &str,
        base_branch: &str,
        work_branch: &str,
        remote_branch: &str,
        from_pull: bool,
        state: &WorkTaskMergeState,
    ) -> Result<String, String> {
        let task_id = task.id;
        let run_seq =
            match work_task_service::begin_delivery(&self.db.conn, task_id, state, task.run_seq)
                .await
            {
                Err(e) => return Err(e.to_string()),
                Ok(None) => return Err("task left review before the delivery began".to_string()),
                Ok(Some(seq)) => seq,
            };
        self.emit_upsert(task_id);

        let expected_head = state.expected_head.clone().unwrap_or_default();
        let title = state.pr_title.clone().unwrap_or_else(|| task.title.clone());
        let attempt = if from_pull {
            self.push_back_to_pull(
                task_id,
                meta,
                wt_path,
                work_branch,
                remote_branch,
                &expected_head,
            )
            .await
        } else {
            self.push_and_open(
                task_id,
                meta,
                wt_path,
                base_branch,
                work_branch,
                &expected_head,
                &title,
                state.draft,
            )
            .await
        };
        match attempt {
            Ok(pr) => match self.settle_delivery(task_id, meta, run_seq, &pr).await {
                Ok(url) => Ok(url),
                Err(e) => {
                    self.back_to_review(task_id, e.clone(), None).await;
                    Err(e)
                }
            },
            Err(e) => {
                self.back_to_review(task_id, e.clone(), None).await;
                Err(e)
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn push_and_open(
        &self,
        task_id: i32,
        meta: &ForgeSourceMeta,
        wt_path: &str,
        base_branch: &str,
        work_branch: &str,
        expected_head: &str,
        title: &str,
        draft: bool,
    ) -> Result<ForgePr, String> {
        let ctx = DeliveryCtx {
            conn: &self.db.conn,
            data_dir: &self.data_dir,
            provider: meta.provider,
            server_host: &meta.server_host,
            account_id: &meta.account_id,
            owner_repo: &meta.owner_repo,
        };
        // Fast-forward push of the same commits is a no-op, so a retry after a
        // later step failed costs nothing and changes nothing.
        self.forge
            .push_branch(&ctx, wt_path, &meta.owner_repo, work_branch, work_branch)
            .await
            .map_err(|e| format!("could not push the task branch: {e}"))?;

        // Look before creating: the previous attempt may have opened the pull
        // request and died on the way to settling it.
        let existing = self
            .forge
            .find_pulls(&ctx, work_branch)
            .await
            .map_err(|e| format!("could not check for an existing pull request: {e}"))?;
        match adopt_pull_request(
            existing,
            expected_head,
            work_branch,
            base_branch,
            &meta.owner_repo,
        ) {
            PrAdoption::Merged(pr) | PrAdoption::Open(pr) => Ok(pr),
            PrAdoption::ClosedUnmerged(pr) => Err(format!(
                "pull request #{} for this branch was closed without merging — reopen it, or \
                 send the task back for another round to deliver a new commit",
                pr.number
            )),
            // Someone moved the branch out from under us. Creating is not an
            // option (GitHub allows one open pull request per head/base pair),
            // and adopting would settle this task against a commit it never
            // produced.
            PrAdoption::StaleHead(pr) => Err(format!(
                "pull request #{} already covers this branch but points at a different commit — \
                 someone else pushed to it. Check that branch before delivering again",
                pr.number
            )),
            PrAdoption::NoMatch => {
                let body = pull_request_body(&meta.url, meta.number, task_id);
                self.forge
                    .create_pull(
                        &ctx,
                        &NewPullRequest {
                            title,
                            head: work_branch,
                            base: base_branch,
                            body: &body,
                            draft,
                        },
                    )
                    .await
                    .map_err(|e| format!("could not open the pull request: {e}"))
            }
        }
    }

    /// Deliver a task that IS a pull request: push the work back onto that
    /// pull request's own branch. Nothing is created — the pull request the
    /// task came from is the delivery.
    ///
    /// The push is fast-forward only (as everywhere here), and that is what
    /// makes the check afterwards a lookup rather than a race: a push that
    /// succeeded proves our commits are on that branch, so the pull request is
    /// re-read only to confirm it is still the open pull request for it. Its
    /// head OID is deliberately NOT required to equal ours — someone pushing
    /// on top of our work a second later has not undone the delivery, and
    /// demanding equality would bounce a task whose work is safely published.
    async fn push_back_to_pull(
        &self,
        task_id: i32,
        meta: &ForgeSourceMeta,
        wt_path: &str,
        work_branch: &str,
        remote_branch: &str,
        expected_head: &str,
    ) -> Result<ForgePr, String> {
        let ctx = DeliveryCtx {
            conn: &self.db.conn,
            data_dir: &self.data_dir,
            provider: meta.provider,
            server_host: &meta.server_host,
            account_id: &meta.account_id,
            owner_repo: &meta.owner_repo,
        };
        // Read BEFORE pushing: a pull request that is already closed or merged
        // must not receive commits nobody is going to look at.
        let before = self
            .forge
            .get_pull(&ctx, meta.number)
            .await
            .map_err(|e| format!("could not read pull request #{}: {e}", meta.number))?;
        self.check_pull_target(&before, meta, remote_branch)?;

        let pushed = !before.head_sha.eq_ignore_ascii_case(expected_head);
        let after = if !pushed {
            // The pull request already sits at the commit this task would
            // push: a retry of a delivery whose push landed before something
            // interrupted the settle. There is nothing left to publish, so
            // nothing is pushed — which is also what lets such a retry finish
            // on a fork the account cannot write to. A task with nothing of
            // its own never reaches this branch; `has_landable_changes`
            // refuses it in favour of completing. It is why the closed/merged
            // refusal below does not run here, too: a merged pull request that
            // carries this exact head IS the delivery, and `settle_pull_target`
            // says so.
            before.clone()
        } else {
            if before.merged || before.state != "open" {
                return Err(format!(
                    "pull request #{} is no longer open — reopen it, then deliver",
                    meta.number
                ));
            }
            let push_repo = pull_push_repo(meta)?;
            self.forge
                .push_branch(&ctx, wt_path, &push_repo, work_branch, remote_branch)
                .await
                .map_err(|e| {
                    let own_repo = crate::forge::same_repo(&push_repo, &meta.owner_repo);
                    let where_ = if own_repo {
                        format!("could not push back to '{remote_branch}'")
                    } else {
                        format!("could not push back to '{remote_branch}' on {push_repo}")
                    };
                    // A hint is only added when git actually said something we
                    // recognise. The fork case used to carry the permission
                    // hint unconditionally, which reads as a finding rather
                    // than the guess it was: a push refused for being out of
                    // date came back advising the reader to go change a
                    // setting on the pull request that was already correct.
                    match classify_push_refusal(&e) {
                        PushRefusal::Permission if !own_repo => format!(
                            "{where_}: {e} — pushing to a fork needs its author to allow edits \
                             from maintainers on the {}",
                            meta.provider.change_noun()
                        ),
                        PushRefusal::BranchMoved => format!(
                            "{where_}: {e} — that branch has commits this task does not have, so \
                             the push is not a fast-forward. Bring them into the task's branch, \
                             then deliver again"
                        ),
                        _ => format!("{where_}: {e}"),
                    }
                })?;

            // Re-read so the settled row links the pull request as it is now
            // (and so a pull request closed during the push is not reported
            // as open).
            self.forge.get_pull(&ctx, meta.number).await.map_err(|e| {
                format!(
                    "the work was pushed to '{remote_branch}', but pull request #{} could not be \
                     read back: {e}",
                    meta.number
                )
            })?
        };
        self.settle_pull_target(
            task_id,
            &ctx,
            wt_path,
            &after,
            meta,
            remote_branch,
            expected_head,
            pushed,
        )
        .await?;
        Ok(after)
    }

    /// The pull request a push-back may push INTO: same repository, same head
    /// branch as the task recorded. Anything else means the pull request was
    /// retargeted under us, and the task goes back to a human.
    fn check_pull_target(
        &self,
        pr: &ForgePr,
        meta: &ForgeSourceMeta,
        remote_branch: &str,
    ) -> Result<(), String> {
        let noun = meta.provider.change_noun();
        // Compared against the head repository RECORDED at trigger time (the
        // fork, when the pull request comes from one — rows without one are
        // same-repo by construction), not against the source repository: a
        // fork's pull request legitimately lives elsewhere, and the thing
        // being caught here is the head moving since the task was made.
        let recorded_repo = meta
            .head_repo
            .as_deref()
            .map(str::trim)
            .filter(|r| !r.is_empty())
            .unwrap_or(&meta.owner_repo);
        if !crate::forge::same_repo(&pr.head_repo, recorded_repo) {
            return Err(format!(
                "{noun} #{} now comes from {}, not {recorded_repo} — check it before delivering \
                 again",
                meta.number, pr.head_repo
            ));
        }
        if pr.head_ref != remote_branch {
            return Err(format!(
                "{noun} #{} now tracks branch '{}', not '{remote_branch}' — check it before \
                 delivering again",
                meta.number, pr.head_ref
            ));
        }
        Ok(())
    }

    /// The pull request a push-back may SETTLE against — a stricter question
    /// than where it may push, and asked after any pushing is behind us.
    ///
    /// Everything [`check_pull_target`] asks, plus two things that can change
    /// underneath a push and would otherwise be recorded as a delivery:
    ///
    /// - the BASE must still be the one the task was reviewed against. A
    ///   retargeted pull request shows a different diff than the one a human
    ///   approved, so calling that "delivered" would put this task's name on a
    ///   review nobody did.
    /// - it must still be OPEN, or MERGED. Merged is a success — our commits
    ///   landed, which is exactly what delivery means. Closed-without-merging
    ///   is not: the work sits on a branch whose review someone shut, and the
    ///   card must say so rather than claim it is done.
    ///
    /// `pushed` is only wording: whether this attempt actually published
    /// anything ("the work was pushed, but…") or found the head already there
    /// and skipped the push — an error must not claim a push that never ran.
    #[allow(clippy::too_many_arguments)]
    async fn settle_pull_target(
        &self,
        task_id: i32,
        ctx: &DeliveryCtx<'_>,
        repo_path: &str,
        pr: &ForgePr,
        meta: &ForgeSourceMeta,
        remote_branch: &str,
        expected_head: &str,
        pushed: bool,
    ) -> Result<(), String> {
        self.check_pull_target(pr, meta, remote_branch)?;
        let noun = meta.provider.change_noun();
        let done = if pushed {
            format!("the work was pushed to '{remote_branch}'")
        } else {
            format!("'{remote_branch}' already holds this task's work")
        };
        if let Some(base) = meta.base_ref.as_deref() {
            if pr.base_ref != base {
                return Err(format!(
                    "{done}, but {noun} #{} now targets '{}' instead of '{base}' — it was \
                     retargeted, so check the diff there before delivering again",
                    meta.number, pr.base_ref
                ));
            }
        }
        if pr.merged {
            // Merged is a success only if the merge CONTAINS what we pushed.
            // Both losing orders are real: someone merges the old head while
            // we are pushing (our commits are not in it), and someone
            // fast-forwards on top of our commits and merges that (they are).
            // Equality answers only the second; git answers both.
            if !self
                .merge_carries_our_work(task_id, ctx, repo_path, meta, expected_head, &pr.head_sha)
                .await
            {
                return Err(format!(
                    "{done}, but {noun} #{} was merged at a commit that does not contain it — \
                     this task's work is on that branch and NOT in that merge, so it needs a \
                     new {noun}",
                    meta.number
                ));
            }
            return Ok(());
        }
        if pr.state != "open" {
            return Err(format!(
                "{done}, but {noun} #{} was closed without merging — reopen it, then deliver",
                meta.number
            ));
        }
        Ok(())
    }

    /// Whether the merge that closed this change carries the commit we pushed.
    ///
    /// Equality is the ordinary answer and costs nothing. When the heads
    /// differ, only git can tell "someone fast-forwarded on top of our work
    /// and merged that" (a delivery) from "someone merged the old head while
    /// we were pushing" (not one) — so the change's server-side head ref is
    /// fetched and asked. Anything that cannot be PROVEN is a no: a delivery
    /// we cannot show is not one this may record.
    async fn merge_carries_our_work(
        &self,
        task_id: i32,
        ctx: &DeliveryCtx<'_>,
        repo_path: &str,
        meta: &ForgeSourceMeta,
        expected_head: &str,
        merged_head: &str,
    ) -> bool {
        // No anchor, nothing to prove. (A delivery always records one; this is
        // the "stored state was unreadable" case, and it must not turn into a
        // ref name with an empty component either.)
        if expected_head.trim().is_empty() {
            return false;
        }
        if merged_head.eq_ignore_ascii_case(expected_head) {
            return true;
        }
        // Scoped by TASK, like the other scratch refs this engine writes.
        // Sibling deliveries in one folder do not share a lock and can overlap,
        // and two of them may legitimately be about the same item or even the
        // same commit — a shared name would let one force-update or delete the
        // ref between another's fetch and its ancestry check.
        let probe = format!("refs/codeg/task-{task_id}/merged-probe");
        let fetched = self
            .forge
            .fetch_ref(
                ctx,
                repo_path,
                &meta.provider.change_head_ref(meta.number),
                &probe,
            )
            .await;
        let carried = match fetched {
            Ok(_) => task_git::is_ancestor(repo_path, expected_head, &probe)
                .await
                .unwrap_or(false),
            Err(e) => {
                tracing::info!("[forge] could not check what the merge carries: {e}");
                false
            }
        };
        task_git::delete_ref(repo_path, &probe).await;
        carried
    }

    /// merging → done with the pull request recorded on the row. The worktree
    /// is deliberately KEPT: the pull request is open against this task's
    /// branch, and another review round on it is a normal next step. Cleanup
    /// stays where it already is — the user's, on a finished card.
    async fn settle_delivery(
        self: &Arc<Self>,
        task_id: i32,
        meta: &ForgeSourceMeta,
        run_seq: i32,
        pr: &ForgePr,
    ) -> Result<String, String> {
        let mut meta = meta.clone();
        meta.result_pr = Some(pr.html_url.clone());
        // Serialized out here on purpose — see `complete_delivered`: its
        // transaction must open with a write.
        let meta_json = serde_json::to_string(&meta)
            .map_err(|e| format!("could not record the pull request: {e}"))?;
        let settled = work_task_service::complete_delivered(
            &self.db.conn,
            task_id,
            run_seq,
            &pr.html_url,
            &meta_json,
        )
        .await
        .map_err(|e| e.to_string())?;
        if !settled {
            return Err(format!(
                "the task moved on while pull request {} was being opened — it is open and \
                 unchanged, nothing was lost",
                pr.html_url
            ));
        }
        self.emit_upsert(task_id);
        // Behind the same CAS as the settle, so the retry of a delivery that
        // already finished cannot comment twice.
        self.spawn_forge_writeback(task_id, WritebackOutcome::Delivered(pr.html_url.clone()));
        Ok(pr.html_url.clone())
    }

    // ── write the outcome back to the forge (best-effort) ───────────────────

    /// Tell the thread a task came from that it finished — a comment carrying
    /// the outcome, the link and the diff counters, and nothing else.
    ///
    /// SPAWNED, never awaited by the settle that triggers it. A local merge
    /// settles inside the folder's git lock, and a REST call has no business
    /// holding that lock; a delivery settles while the user waits on the
    /// button. The price is honest best-effort: a process that exits right
    /// after a settle can leave neither a comment nor a failure event, and
    /// nothing retries. Guaranteed delivery needs a persisted outbox, which is
    /// deliberately not this.
    fn spawn_forge_writeback(self: &Arc<Self>, task_id: i32, outcome: WritebackOutcome) {
        let engine = self.clone();
        tokio::spawn(async move {
            engine.forge_writeback(task_id, outcome).await;
        });
    }

    async fn forge_writeback(self: &Arc<Self>, task_id: i32, outcome: WritebackOutcome) {
        let Ok(task) = work_task_service::get_model(&self.db.conn, task_id).await else {
            return;
        };
        // Only a task that HAS a thread, and only a provider we can post to.
        // Both kinds get a comment; WHERE it goes differs by forge, which is
        // why the item kind is carried rather than assumed (GitHub serves
        // issue and pull-request comments from one endpoint, GitLab from two).
        let item_kind = match task.source_kind.as_deref() {
            Some(SOURCE_KIND_ISSUE) => ForgeItemKind::Issue,
            Some(SOURCE_KIND_PR) => ForgeItemKind::Change,
            _ => return,
        };
        let Some(meta) = task
            .source_meta
            .as_deref()
            .and_then(|s| serde_json::from_str::<ForgeSourceMeta>(s).ok())
        else {
            return;
        };
        // The answer the user gave in the trigger dialog, carried on the task
        // itself. Absent on rows minted before the choice lived there — those
        // stay silent, which is the posture the folder setting it replaced
        // shipped with. This is a write to a place other people are watching,
        // so "no recorded yes" means no.
        if !meta.writeback.unwrap_or(false) {
            return;
        }

        // The counters recorded when the run settled — reading git here would
        // fail on exactly the tasks whose worktree the merge just deleted.
        let stats = task
            .files_changed
            .map(|files| (files, task.additions.unwrap_or(0), task.deletions.unwrap_or(0)));
        let base_branch = task.base_branch.clone().unwrap_or_default();
        let outcome = match &outcome {
            WritebackOutcome::Merged(commit) => TaskOutcome::Merged {
                commit,
                base_branch: &base_branch,
            },
            WritebackOutcome::Delivered(pr_url) => TaskOutcome::Delivered { pr_url },
            WritebackOutcome::Accepted { nothing_to_land } => TaskOutcome::Accepted {
                nothing_to_land: *nothing_to_land,
            },
        };
        let body = writeback_comment_body(task_id, &outcome, stats);

        let ctx = DeliveryCtx {
            conn: &self.db.conn,
            data_dir: &self.data_dir,
            provider: meta.provider,
            server_host: &meta.server_host,
            account_id: &meta.account_id,
            owner_repo: &meta.owner_repo,
        };
        let (kind, payload) = match self
            .forge
            .comment_issue(&ctx, item_kind, meta.number, &body)
            .await
        {
            Ok(url) => ("forge_writeback", serde_json::json!({ "url": url })),
            // Failure is recorded and dropped: the task is finished either way,
            // and a comment nobody sees must not reopen a settled row.
            Err(error) => (
                "forge_writeback_failed",
                serde_json::json!({ "error": error, "number": meta.number }),
            ),
        };
        let _ =
            work_task_service::record_event(&self.db.conn, task_id, kind, "engine", Some(payload))
                .await;
        // The card's own fields did not change; this is what makes an open
        // detail sheet reload its timeline.
        self.emit_upsert(task_id);
    }

    /// Crash recovery for a delivery: the forge is the only truth about what
    /// the dead process managed to do. No `ls-remote` probe — the four-way
    /// match already requires the pushed OID to be the pull request's head, so
    /// a separate branch-tip read adds a failure mode and no information.
    ///
    /// Every exit binds to the generation this pass READ, never just to
    /// "the row is merging": a recovery that spent seconds at the forge must
    /// not bounce a delivery someone started in the meantime.
    async fn recover_delivery(
        self: &Arc<Self>,
        task: &crate::db::entities::work_task::Model,
        state: &WorkTaskMergeState,
    ) {
        let task_id = task.id;
        let (Some(remote_branch), Some(expected_head)) =
            (state.remote_branch.as_deref(), state.expected_head.as_deref())
        else {
            self.bounce_delivery(
                task,
                "the delivery was interrupted and its state is incomplete — deliver again"
                    .to_string(),
            )
            .await;
            return;
        };
        let (Some(meta), Some(base_branch)) = (
            task.source_meta
                .as_deref()
                .and_then(|s| serde_json::from_str::<ForgeSourceMeta>(s).ok()),
            task.base_branch.as_deref(),
        ) else {
            self.bounce_delivery(
                task,
                "the delivery was interrupted and the task's source information is unreadable — \
                 deliver again"
                    .to_string(),
            )
            .await;
            return;
        };

        let ctx = DeliveryCtx {
            conn: &self.db.conn,
            data_dir: &self.data_dir,
            provider: meta.provider,
            server_host: &meta.server_host,
            account_id: &meta.account_id,
            owner_repo: &meta.owner_repo,
        };
        // A push-back knows exactly which pull request it was delivering into —
        // the number is part of the task's identity — so recovery looks it up
        // instead of searching by head branch.
        if task.source_kind.as_deref() == Some(SOURCE_KIND_PR) {
            self.recover_push_back(task, &ctx, &meta, remote_branch, expected_head)
                .await;
            return;
        }
        let found = match self.forge.find_pulls(&ctx, remote_branch).await {
            Ok(prs) => prs,
            Err(e) => {
                self.bounce_delivery(
                    task,
                    format!("could not check the pull request after a restart: {e}"),
                )
                .await;
                return;
            }
        };
        // Anything short of all four criteria goes back to a human. Adopting on
        // a partial match would settle the task against someone else's pull
        // request that merely reused the branch name.
        match adopt_pull_request(
            found,
            expected_head,
            remote_branch,
            base_branch,
            &meta.owner_repo,
        ) {
            PrAdoption::Merged(pr) | PrAdoption::Open(pr) => {
                if let Err(e) = self.settle_delivery(task_id, &meta, task.run_seq, &pr).await {
                    self.bounce_delivery(task, e).await;
                }
            }
            PrAdoption::ClosedUnmerged(pr) => {
                self.bounce_delivery(
                    task,
                    format!(
                        "the delivery was interrupted and pull request #{} was closed without \
                         merging — deliver again if you still want it",
                        pr.number
                    ),
                )
                .await;
            }
            PrAdoption::StaleHead(pr) => {
                self.bounce_delivery(
                    task,
                    format!(
                        "the delivery was interrupted and pull request #{} now points at a \
                         different commit — check that branch before delivering again",
                        pr.number
                    ),
                )
                .await;
            }
            PrAdoption::NoMatch => {
                self.bounce_delivery(
                    task,
                    "the delivery was interrupted before its pull request existed — deliver again"
                        .to_string(),
                )
                .await;
            }
        }
    }

    /// Crash recovery for a push-back: did the dead process get the commits
    /// onto the pull request's branch?
    ///
    /// Only one answer settles the task — the pull request's head IS the commit
    /// this delivery pushed. Deliberately stricter than the live path (which
    /// takes a successful push as proof): here there is no proof, and "someone
    /// pushed after us" and "we never pushed" look identical from the outside.
    /// Bouncing costs one click, and the retry is a no-op push followed by the
    /// normal settle.
    async fn recover_push_back(
        self: &Arc<Self>,
        task: &crate::db::entities::work_task::Model,
        ctx: &DeliveryCtx<'_>,
        meta: &ForgeSourceMeta,
        remote_branch: &str,
        expected_head: &str,
    ) {
        let pr = match self.forge.get_pull(ctx, meta.number).await {
            Ok(pr) => pr,
            Err(e) => {
                self.bounce_delivery(
                    task,
                    format!(
                        "could not read pull request #{} after a restart: {e}",
                        meta.number
                    ),
                )
                .await;
                return;
            }
        };
        // The same question the live path asks after its push — with the head
        // OID added, because a crash left no "the push succeeded" evidence and
        // "someone else pushed" is indistinguishable from "we never did".
        // The task's own worktree may be gone after a crash; the project
        // folder's object store is the same one and always there.
        let repo_path = match get_folder_core(&self.db, task.folder_id).await {
            Ok(folder) => folder.path,
            Err(e) => {
                self.bounce_delivery(task, format!("the delivery was interrupted: {e}")).await;
                return;
            }
        };
        if let Err(reason) = self
            .settle_pull_target(
                task.id,
                ctx,
                &repo_path,
                &pr,
                meta,
                remote_branch,
                expected_head,
                // A recovery cannot know whether the interrupted attempt got
                // its push out; claiming one is the conservative reading.
                true,
            )
            .await
        {
            self.bounce_delivery(task, format!("the delivery was interrupted: {reason}")).await;
            return;
        }
        // For a MERGED change the check above already PROVED the merge carries
        // this task's commit, which is strictly more than the head OID says —
        // asking again here would reject the very case that proof exists for
        // (someone fast-forwarded on top of our work and merged that).
        if !pr.merged && !pr.head_sha.eq_ignore_ascii_case(expected_head) {
            self.bounce_delivery(
                task,
                format!(
                    "the delivery was interrupted and {} #{} does not show this task's commit — \
                     deliver again",
                    meta.provider.change_noun(),
                    meta.number
                ),
            )
            .await;
            return;
        }
        if let Err(e) = self.settle_delivery(task.id, meta, task.run_seq, &pr).await {
            self.bounce_delivery(task, e).await;
        }
    }

    // ── merge pump (the folder's one merge slot) ────────────────────────────

    /// Advance the folder's merge slot: the user's merge queue first, then the
    /// auto-merge train. Called wherever that slot can have freed (a settled
    /// merge, crash recovery, a fresh review, the reconcile tick) — the two
    /// sources of landings share one slot, so they share one pump.
    async fn merge_pump(self: &Arc<Self>, folder_id: i32) {
        if self.drain_merge_queue(folder_id).await {
            return;
        }
        self.auto_merge_sweep(folder_id).await;
    }

    /// Dispatch the oldest merge the user queued on this folder. Returns
    /// whether the merge slot is spoken for — the auto sweep must not chase a
    /// user's landing into the same slot, and a queued column drains one
    /// landing per pump (every settle pumps again).
    ///
    /// A queue that changed under the scan (the user withdrew or edited a merge
    /// while this was working) is re-scanned rather than worked from the stale
    /// picture: continuing would dispatch out of order, and reporting an empty
    /// queue would hand the slot to the auto sweep — which has neither the
    /// user's commit message nor their worktree choice. Bounded, because each
    /// retry needs a fresh concurrent change to happen at all; still churning
    /// after that leaves the slot to the next pump.
    async fn drain_merge_queue(self: &Arc<Self>, folder_id: i32) -> bool {
        for _ in 0..MERGE_QUEUE_DRAIN_ATTEMPTS {
            match self.drain_merge_queue_once(folder_id).await {
                DrainOutcome::Taken => return true,
                DrainOutcome::Empty => return false,
                DrainOutcome::Stale => continue,
            }
        }
        true
    }

    /// One pass over the folder's queue. See [`Self::drain_merge_queue`].
    ///
    /// Refusals are handled like the sweep's: a task that left the queue on its
    /// own moves on to the next one, and a real refusal (wrong base branch,
    /// staged changes, a worktree that vanished) banners the row and drops its
    /// queue entry, so a hopeless intent is attempted once rather than looped
    /// over by the reconcile tick.
    async fn drain_merge_queue_once(self: &Arc<Self>, folder_id: i32) -> DrainOutcome {
        // Fast path only — merge_task re-checks under the folder lock.
        let merging = work_task_service::list_by_status(&self.db.conn, &[WorkTaskStatus::Merging])
            .await
            .unwrap_or_default();
        if merging.iter().any(|t| t.folder_id == folder_id) {
            return DrainOutcome::Taken;
        }
        let mut queued: Vec<_> =
            work_task_service::list_by_status(&self.db.conn, &[WorkTaskStatus::Review])
                .await
                .unwrap_or_default()
                .into_iter()
                .filter(|t| t.folder_id == folder_id)
                .filter_map(|t| {
                    // The raw column value travels with the parsed intent: it is
                    // the token every write below CASes on (see
                    // `QueuedMergeClaim`).
                    let raw = t.pending_merge.clone()?;
                    let intent = work_task_service::queued_merge(Some(raw.as_str()))?;
                    let claim = QueuedMergeClaim {
                        raw,
                        queued_at: intent.queued_at,
                    };
                    Some((intent, claim, t))
                })
                .collect();
        queued.sort_by_key(|(intent, _, task)| queue_order(intent, task));
        for (intent, claim, task) in queued {
            if self.live_worktree(&task).await.is_none() {
                // Only the intent we scanned can be refused; anything else on
                // the row now is a change we have to re-read.
                if !self
                    .refuse_queued_merge(&task, &claim, "the task worktree no longer exists on disk")
                    .await
                {
                    return DrainOutcome::Stale;
                }
                continue;
            }
            match self
                .merge_task_inner(
                    task.id,
                    intent.message.clone(),
                    intent.delete_worktree,
                    intent.instructions.clone(),
                    false,
                    Some(&claim),
                )
                .await
            {
                // Queued again: the slot was taken between the scan and the
                // folder lock. The row keeps its place in line untouched.
                Ok(_) => return DrainOutcome::Taken,
                // The user withdrew or edited THIS merge while we worked on it:
                // the whole snapshot is stale (their edit may now sort first,
                // and it must not be left to the auto sweep's defaults).
                Err(e) if is_queued_merge_superseded(&e) => return DrainOutcome::Stale,
                // The task left review on its own — it is out of the queue for
                // good, so the rest of the snapshot still holds.
                Err(e) if is_benign_merge_race(&e) => continue,
                Err(e) => {
                    tracing::warn!("[work_task] queued merge of task {} refused: {e}", task.id);
                    if !self.refuse_queued_merge(&task, &claim, &e).await {
                        return DrainOutcome::Stale;
                    }
                    return DrainOutcome::Taken;
                }
            }
        }
        DrainOutcome::Empty
    }

    /// Drop a queued merge that cannot run and leave the reason on the card —
    /// the queue must not hold an intent the user has no way to see failing.
    ///
    /// Both writes are CAS'd on the refused intent: while the dispatch was
    /// failing the user may have withdrawn it or queued different options, and
    /// neither a silent delete of that newer request nor a banner about an
    /// older one would be true.
    /// `false` = the row moved on, so nothing was written: its current state is
    /// not this refusal's to judge, and the caller must re-read the queue.
    async fn refuse_queued_merge(
        &self,
        task: &crate::db::entities::work_task::Model,
        claim: &QueuedMergeClaim,
        error: &str,
    ) -> bool {
        let dropped = work_task_service::clear_queued_merge(&self.db.conn, task.id, &claim.raw)
            .await
            .unwrap_or(false);
        if !dropped {
            return false;
        }
        let _ = work_task_service::set_review_error(
            &self.db.conn,
            task.id,
            task.run_seq,
            &format!("queued merge failed: {error}"),
        )
        .await;
        self.emit_upsert(task.id);
        true
    }

    // ── auto-merge (unattended landing) ─────────────────────────────────────

    /// Fire-and-forget [`Self::merge_pump`] — a dispatch takes the folder's git
    /// lock to validate and commit its CAS, and waits on the agent coming up
    /// after that, neither of which may stall the engine's event loop.
    fn spawn_merge_pump(self: &Arc<Self>, folder_id: i32) {
        let engine = self.clone();
        tokio::spawn(async move {
            engine.merge_pump(folder_id).await;
        });
    }

    /// Pump one folder — or, with `None`, every folder that currently holds a
    /// reviewed task. `None` serves the reconcile tick and a change of the
    /// global settings row, which can switch auto-merge on for any folder that
    /// follows it. Each folder's pump runs spawned, so one folder's dispatch
    /// cannot delay another's.
    pub async fn sweep_merge_backlog(self: &Arc<Self>, folder_id: Option<i32>) {
        match folder_id {
            Some(folder_id) => self.spawn_merge_pump(folder_id),
            None => {
                let review = work_task_service::list_by_status(
                    &self.db.conn,
                    &[WorkTaskStatus::Review],
                )
                .await
                .unwrap_or_default();
                let mut swept: HashSet<i32> = HashSet::new();
                for task in review {
                    if swept.insert(task.folder_id) {
                        self.spawn_merge_pump(task.folder_id);
                    }
                }
            }
        }
    }

    /// When the folder's settings ask for it, dispatch the same merge the
    /// button would — agent-written commit message, worktree per the folder's
    /// default — for the oldest reviewed task that is actually mergeable. One
    /// dispatch per sweep: merges are serial per folder anyway, and every
    /// settle re-sweeps, so a column of reviewed tasks drains one landing at a
    /// time (the merge train).
    ///
    /// Concurrent sweeps, clicks and settles are all safe: `merge_task`
    /// serializes dispatches on the folder git lock and CAS-guards
    /// review→merging, so the worst case is a benign "someone got there first"
    /// refusal, which the sweep swallows. A dispatch refused for a real reason
    /// (wrong base branch, staged changes, …) leaves that reason on the row as
    /// the card's error banner — and a row with an error is no longer
    /// eligible, so a hopeless dispatch is attempted once, not looped.
    async fn auto_merge_sweep(self: &Arc<Self>, folder_id: i32) {
        let settings = work_task_service::settings_get_effective(&self.db.conn, folder_id)
            .await
            .unwrap_or_default();
        if !settings.auto_merge {
            return;
        }
        // Fast path only — merge_task re-checks under the folder lock.
        let merging = work_task_service::list_by_status(&self.db.conn, &[WorkTaskStatus::Merging])
            .await
            .unwrap_or_default();
        if merging.iter().any(|t| t.folder_id == folder_id) {
            return;
        }
        let mut candidates: Vec<_> =
            work_task_service::list_by_status(&self.db.conn, &[WorkTaskStatus::Review])
                .await
                .unwrap_or_default()
                .into_iter()
                .filter(|t| t.folder_id == folder_id && auto_merge_candidate(t, &settings))
                .collect();
        candidates.sort_by_key(|t| (t.settled_at, t.id));
        for task in candidates {
            // A gone worktree cannot serve a merge generation; that task's
            // acceptance is the "complete" button — a user decision.
            if self.live_worktree(&task).await.is_none() {
                continue;
            }
            match self
                // No instructions: nobody was at the keyboard to write any.
                .merge_task(task.id, None, settings.delete_worktree_default, None, true)
                .await
            {
                // An unattended dispatch never queues (see `merge_task`), so
                // this is always the live generation.
                Ok(_) => {}
                Err(e) if is_benign_merge_race(&e) => {}
                Err(e) => {
                    tracing::warn!(
                        "[work_task] auto-merge of task {} refused: {e}",
                        task.id
                    );
                    if work_task_service::set_review_error(
                        &self.db.conn,
                        task.id,
                        task.run_seq,
                        &format!("auto-merge failed: {e}"),
                    )
                    .await
                    .unwrap_or(false)
                    {
                        self.emit_upsert(task.id);
                    }
                }
            }
            // One dispatch (or one refusal) per sweep. Cascading on after a
            // refusal would stamp one environmental problem onto every card
            // in the column.
            return;
        }
    }

    // ── merging crash recovery (git truth) ──────────────────────────────────

    /// Recover a task stuck in `merging` (crash / lost process) from git
    /// truth in the project folder. A merge generation with a live agent
    /// connection is not stuck — its TurnComplete settles it.
    pub async fn recover_merging(self: &Arc<Self>, task_id: i32) {
        if self.merging.lock().await.contains_key(&task_id) {
            return; // merge dispatch / delivery in flight in this process
        }
        let Ok(task) = work_task_service::get_model(&self.db.conn, task_id).await else {
            return;
        };
        if task.status != WorkTaskStatus::Merging {
            return;
        }
        if let Some(conn_id) = task.connection_id.as_deref() {
            if self.manager.get_state_and_emitter(conn_id).await.is_some() {
                return; // live merge generation — on_turn_complete owns the settle
            }
            // Dead: its TurnComplete is never coming, so this pass inherits the
            // teardown that settle owed. Retire it BEFORE deciding anything —
            // this very pass calls `remove_worktree_locked` when the merge
            // landed, and a leftover entry reads there as "a live agent is
            // still working in that worktree" and refuses the cleanup the user
            // asked for. Nothing below re-reads the connection.
            self.retire_connection(conn_id, task_id).await;
        }
        let Some(state) = task
            .merge_state
            .as_deref()
            .and_then(|s| serde_json::from_str::<WorkTaskMergeState>(s).ok())
        else {
            self.back_to_review(
                task_id,
                "merge state lost — please merge again".to_string(),
                None,
            )
            .await;
            return;
        };
        // A `merging` row is one of two very different things. Read the op
        // before touching anything operation-specific: a delivery never went
        // near the project folder, and its truth lives at the forge.
        if state.op == WorkTaskMergeOp::DeliverPr {
            self.recover_delivery(&task, &state).await;
            return;
        }
        let Ok(root) = get_folder_core(&self.db, task.folder_id).await else {
            return;
        };

        let lock = self.folder_lock(task.folder_id).await;
        let _guard = lock.lock().await;
        // Re-read under the lock; an in-flight settle may have finished it.
        let Ok(current) = work_task_service::get_model(&self.db.conn, task_id).await else {
            return;
        };
        if current.status != WorkTaskStatus::Merging || current.run_seq != task.run_seq {
            return;
        }

        match self.merge_landed_commit(&current, &state, &root.path).await {
            Ok(Some(commit)) => {
                let landed = work_task_service::merge_landed(&self.db.conn, task_id, &commit)
                    .await
                    .unwrap_or(false);
                if landed {
                    self.emit_upsert(task_id);
                    self.spawn_forge_writeback(task_id, WritebackOutcome::Merged(commit));
                    if state.delete_worktree {
                        self.remove_worktree_locked(task_id, None).await;
                    }
                }
            }
            Ok(None) => {
                self.clean_merge_residue(&root.path).await;
                self.back_to_review(
                    task_id,
                    "the merge was interrupted before landing — merge again".to_string(),
                    None,
                )
                .await;
            }
            Err(e) => {
                self.back_to_review(task_id, format!("could not verify the merge: {e}"), None)
                    .await;
            }
        }
    }

    // ── worktree cleanup ────────────────────────────────────────────────────

    /// Remove a task's worktree + branch (user action from the card, the
    /// post-merge checkbox, or the cancel dialog's). Takes the task lock and
    /// then the per-folder git lock, in that order.
    ///
    /// Refuses — with the reason both returned and flagged on the row — while
    /// the worktree still holds uncommitted files. See the check itself for why
    /// that line is drawn here and not at the confirmation.
    ///
    /// The TASK lock is what makes this safe against a launch, and the folder
    /// lock cannot stand in for it: [`Self::launch`] holds the task lock across
    /// its whole setup — `ensure_worktree` included — and takes no folder lock
    /// at all, so a folder-scoped removal runs straight through a checkout that
    /// is being created. Reachable whenever the row leaves a launchable state
    /// and comes back: cancel (`canceled`) → the user requeues (`todo`, a pure
    /// DB write that waits on nothing) → the pump claims and launches, all
    /// while this call sits between its status read and its removal. Nothing
    /// else about that sequence is wrong — the fresh run mints its own worktree
    /// — but deleting the directory out from under `ensure_worktree` is.
    ///
    /// Hence read the status twice: once before the lock so a `running` task
    /// fails fast instead of queueing behind its own init command (which can be
    /// a whole `pnpm install`), and once after, because only the second read is
    /// serialized against the launch it is trying to exclude.
    ///
    /// Ordering is deadlock-free by inspection: the task lock is only ever
    /// taken here, in [`Self::cancel`], and in [`Self::launch`], and none of
    /// those three is reachable while a folder lock is held (`launch` runs in
    /// its own spawned task, and `cancel`'s only nested wait is the pump lock).
    pub async fn cleanup_task(&self, task_id: i32) -> Result<(), CleanupBlocked> {
        /// Statuses whose worktree is either in use or about to be — the launch
        /// path owns it, not the user.
        fn in_use(status: &WorkTaskStatus) -> bool {
            matches!(
                status,
                WorkTaskStatus::Queued
                    | WorkTaskStatus::Preparing
                    | WorkTaskStatus::Running
                    | WorkTaskStatus::AwaitingInput
                    | WorkTaskStatus::Merging
            )
        }
        const REFUSAL: &str = "cancel or finish the task before removing its worktree";

        let task = work_task_service::get_model(&self.db.conn, task_id)
            .await
            .map_err(|e| CleanupBlocked::failed(e.to_string()))?;
        if in_use(&task.status) {
            return Err(CleanupBlocked::failed(REFUSAL));
        }
        let task_guard = self.task_lock(task_id).await;
        let _task_guard = task_guard.lock().await;
        // Re-read under the lock: whatever claimed the row while we waited is
        // now either fully set up (and refused here) or still blocked on this
        // lock at the top of `launch` — where it re-reads its own status and
        // gives up if a cancel moved the row on.
        let task = work_task_service::get_model(&self.db.conn, task_id)
            .await
            .map_err(|e| CleanupBlocked::failed(e.to_string()))?;
        if in_use(&task.status) {
            return Err(CleanupBlocked::failed(REFUSAL));
        }
        let lock = self.folder_lock(task.folder_id).await;
        let _guard = lock.lock().await;
        // Uncommitted work is the one thing behind this call that git cannot
        // give back, and nothing on the way in ever named it: the cancel
        // dialog's checkbox promises "its worktree and work branch", the card's
        // button says "Delete worktree", and neither mentions files the agent
        // left unstaged. The removal underneath is `worktree remove --force`,
        // so without this check a stop pressed mid-edit — the very moment a
        // checkout is most likely to be dirty — takes the edits with it.
        //
        // The other two surfaces that remove a worktree already draw this line:
        // `complete_task` refuses with this same sentence, and the branch
        // dropdown's removal re-asks under an explicit "those changes cannot be
        // recovered" confirmation. This one just took it. Committed work is a
        // different matter and stays deletable — `branch -D` is what the
        // checkbox spells out, and the reflog still holds those commits.
        //
        // Recorded AND returned, because the callers hear different channels:
        // the direct button surfaces the `Err` as a toast, `work_task_cancel_core`
        // swallows it and reads `cleanup_state` off the card instead, and the
        // delete path — which would otherwise tombstone that card and the reason
        // with it — stops on `holds_work` rather than swallowing.
        if self.worktree_holds_uncommitted(&task).await {
            let _ = work_task_service::set_cleanup_state(
                &self.db.conn,
                task_id,
                true,
                Some(worktree_kept(RETRY_THE_CLEANUP)),
            )
            .await;
            self.emit_upsert(task_id);
            return Err(CleanupBlocked {
                message: worktree_kept(RETRY_THE_CLEANUP),
                holds_work: true,
            });
        }
        // No `emit_upsert` here: the removal owns that broadcast now, and only
        // it can tell a pass that changed the row from one that found nothing
        // to do.
        self.remove_worktree_locked(task_id, None).await;
        Ok(())
    }

    /// Git-first-then-DB worktree removal, and the `task://changed` that tells
    /// clients about it. Caller holds the folder git lock.
    ///
    /// The broadcast lives HERE rather than at the call sites: this is the only
    /// thing that knows whether the row moved, and the acceptance paths reach it
    /// AFTER their own `emit_upsert` (`settle_merge_generation`,
    /// `recover_merging`) — so a caller-side convention leaves the card holding
    /// a snapshot taken before the worktree was detached, and its "worktree
    /// removed" badge (`worktreeWasRemoved`, keyed on `worktree_folder_id`)
    /// never appears until a full refetch. `converge_worktree_removal` owns its
    /// folder / conversation / tab broadcasts for the same reason.
    ///
    /// `expected_tip` is forwarded to [`task_git::remove_worktree_and_branch`]:
    /// `Some(oid)` deletes the work branch only while it still points there.
    /// The local-merge paths pass `None` — they settle from git truth about the
    /// base, not from an OID they published.
    async fn remove_worktree_locked(&self, task_id: i32, expected_tip: Option<&str>) {
        if self.remove_worktree_inner(task_id, expected_tip).await {
            self.emit_upsert(task_id);
        }
    }

    /// The removal itself. Returns whether it wrote to the task row — the
    /// broadcast in [`Self::remove_worktree_locked`] rides that answer, so a
    /// pass that decided there was nothing to do stays silent.
    ///
    /// Order matters: the git removal runs first; only after it succeeds does
    /// the DB transaction re-parent the worktree's conversations onto the
    /// project folder (stamping `origin_cwd`), close its tabs, and soft-delete
    /// the folder row. A git failure flags `cleanup_state='failed'` (retryable
    /// from the card) and leaves the DB untouched; a `done` task never leaves
    /// `done` either way — including a branch that moved out from under an
    /// `expected_tip`, which lands here as exactly that kind of git failure.
    async fn remove_worktree_inner(&self, task_id: i32, expected_tip: Option<&str>) -> bool {
        let Ok(task) = work_task_service::get_model(&self.db.conn, task_id).await else {
            return false;
        };
        let Some(wt_id) = task.worktree_folder_id else {
            // Nothing left to remove. A cleanup flag surviving past the
            // detach would offer a retry that can never succeed — clear it.
            if task.cleanup_state.is_some() {
                let _ =
                    work_task_service::set_cleanup_state(&self.db.conn, task_id, false, None).await;
                return true;
            }
            return false;
        };
        // Precondition: no live connection of ours on this task. `index` alone
        // cannot answer that — it is a correlation table, not a liveness one,
        // and an entry whose connection died stays put until something retires
        // it. Believing such an entry costs the user a worktree they asked to
        // remove and a `failed` flag whose retry can never clear (nothing will
        // ever arrive to remove the entry). Ask the manager, and retire what it
        // says is gone.
        let mut has_conn = false;
        let claimed: Vec<String> = {
            self.index
                .lock()
                .await
                .iter()
                .filter(|(_, (tid, _))| *tid == task_id)
                .map(|(conn_id, _)| conn_id.clone())
                .collect()
        };
        for conn_id in claimed {
            if self.manager.get_state_and_emitter(&conn_id).await.is_some() {
                has_conn = true;
            } else {
                self.retire_connection(&conn_id, task_id).await;
            }
        }
        if has_conn {
            let _ = work_task_service::set_cleanup_state(
                &self.db.conn,
                task_id,
                true,
                Some("task still has a live agent connection".to_string()),
            )
            .await;
            return true;
        }

        let root = match get_folder_core(&self.db, task.folder_id).await {
            Ok(r) => r,
            Err(e) => {
                let _ = work_task_service::set_cleanup_state(
                    &self.db.conn,
                    task_id,
                    true,
                    Some(e.to_string()),
                )
                .await;
                return true;
            }
        };
        let Ok(wt) = get_folder_core(&self.db, wt_id).await else {
            // Folder row already gone (a retried cleanup) — just detach, and
            // still tell clients to drop it: one holding a stale copy would
            // otherwise keep rendering a worktree no refetch would return.
            let _ = work_task_service::clear_worktree(&self.db.conn, task_id).await;
            emit_folder_deleted(&self.emitter, wt_id);
            return true;
        };

        if let Err(e) = task_git::remove_worktree_and_branch(
            &root.path,
            &wt.path,
            task.work_branch.as_deref(),
            expected_tip,
        )
        .await
        {
            let _ = work_task_service::set_cleanup_state(
                &self.db.conn,
                task_id,
                true,
                Some(e.to_string()),
            )
            .await;
            return true;
        }

        converge_worktree_removal(
            &self.db,
            &self.emitter,
            task_id,
            wt_id,
            task.folder_id,
            &wt.path,
        )
        .await;
        true
    }

    // ── reconcile ───────────────────────────────────────────────────────────

    async fn reconcile_once(self: &Arc<Self>) {
        // running / awaiting_input whose worker died without a TurnComplete.
        let active = work_task_service::list_by_status(
            &self.db.conn,
            &[WorkTaskStatus::Running, WorkTaskStatus::AwaitingInput],
        )
        .await
        .unwrap_or_default();
        for task in active {
            let Some(conn_id) = task.connection_id.clone() else {
                continue;
            };
            if self.manager.get_state_and_emitter(&conn_id).await.is_some() {
                continue; // live — on_event settles it authoritatively
            }
            // Connection gone. If the produced conversation reached a terminal
            // status the TurnComplete was merely dropped — settle from it.
            self.retire_connection(&conn_id, task.id).await;
            let conv_status = match task.conversation_id {
                Some(cid) => self.conversation_status(cid).await,
                None => None,
            };
            let changed = match conv_status {
                Some(ConversationStatus::PendingReview) | Some(ConversationStatus::Completed) => {
                    let stats = self.snapshot_diff_stats(task.id).await;
                    let settled = work_task_service::settle_review(
                        &self.db.conn,
                        task.id,
                        task.run_seq,
                        None,
                        stats,
                    )
                    .await
                    .unwrap_or(false);
                    if settled {
                        // The dropped TurnComplete owed review its preflight
                        // and its auto-merge chance — same hook as the live
                        // settle path.
                        self.spawn_post_review(task.id, task.run_seq);
                    }
                    settled
                }
                Some(ConversationStatus::Cancelled) => {
                    work_task_service::cancel_running_generation(
                        &self.db.conn,
                        task.id,
                        task.run_seq,
                    )
                    .await
                    .unwrap_or(false)
                }
                _ => work_task_service::fail(
                    &self.db.conn,
                    task.id,
                    &[WorkTaskStatus::Running, WorkTaskStatus::AwaitingInput],
                    Some(task.run_seq),
                    "interrupted",
                    Some("task lost its worker".to_string()),
                )
                .await
                .unwrap_or(false),
            };
            if changed {
                self.emit_upsert(task.id);
            }
        }

        // preparing rows that no in-flight launch owns → back to the queue.
        // `launching` is authoritative here: this process holds the exclusive
        // engine lock, and the entry outlives the whole launch (including its
        // failure handling). Without this sweep an orphan would sit in
        // `preparing` forever — `next_queued` only picks `queued`, so it would
        // lose the self-healing a stuck `queued` row gets today.
        let preparing =
            work_task_service::list_by_status(&self.db.conn, &[WorkTaskStatus::Preparing])
                .await
                .unwrap_or_default();
        if !preparing.is_empty() {
            let launching: HashSet<i32> = self.launching.lock().await.keys().copied().collect();
            for task in preparing {
                if launching.contains(&task.id) {
                    continue;
                }
                match work_task_service::abandon_setup(&self.db.conn, task.id, task.run_seq).await {
                    Ok(true) => {
                        tracing::info!(
                            "[work_task] requeued orphaned setup of task {}",
                            task.id
                        );
                        self.emit_upsert(task.id);
                    }
                    Ok(false) => {}
                    Err(e) => tracing::warn!("[work_task] abandon setup error: {e}"),
                }
            }
        }

        // merging not owned by this process's in-flight merges → git truth.
        // Spawned off-thread: recovery waits on the per-folder git lock, and an
        // in-flight merge on that folder must not stall the event loop here.
        let merging = work_task_service::list_by_status(&self.db.conn, &[WorkTaskStatus::Merging])
            .await
            .unwrap_or_default();
        for task in merging {
            let engine = self.clone();
            tokio::spawn(async move {
                engine.recover_merging(task.id).await;
                engine.pump_folder(task.folder_id).await;
                // Recovery freed the folder's merge slot (landed or bounced) —
                // resume the queue / auto-merge train where the crash cut it.
                engine.merge_pump(task.folder_id).await;
            });
        }

        // Pending backlog: queued tasks whose slot freed while no event fired,
        // plus todo tasks of auto_process folders (the pump checks the flag).
        for folder_id in work_task_service::folders_with_pending(&self.db.conn)
            .await
            .unwrap_or_default()
        {
            self.pump_folder(folder_id).await;
        }

        // Review backlog: merges the user queued whose pump never ran (queued
        // before a restart, or a settle lost in the crash window), plus the
        // auto-merge folders' own backlog (a dispatch lost between the settle
        // and the merge, and tasks already sitting in review when the setting
        // was switched on). The pump re-checks per folder, so this is a cheap
        // scan for folders with neither.
        self.sweep_merge_backlog(None).await;
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    async fn task_lock(&self, task_id: i32) -> Arc<Mutex<()>> {
        let mut locks = self.task_locks.lock().await;
        locks
            .entry(task_id)
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    async fn folder_lock(&self, folder_id: i32) -> Arc<Mutex<()>> {
        let mut locks = self.folder_locks.lock().await;
        locks
            .entry(folder_id)
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    fn emit_upsert(&self, task_id: i32) {
        emit_event(
            &self.emitter,
            WORK_TASK_CHANGED_EVENT,
            WorkTaskChange::Upsert { id: task_id },
        );
    }

    fn emit_changed_all(&self) {
        emit_event(
            &self.emitter,
            WORK_TASK_CHANGED_EVENT,
            WorkTaskChange::Refresh,
        );
    }

    async fn conversation_status(&self, conv_id: i32) -> Option<ConversationStatus> {
        conversation::Entity::find_by_id(conv_id)
            .one(&self.db.conn)
            .await
            .ok()
            .flatten()
            .map(|m| m.status)
    }

    async fn cancel_conversation(&self, conversation_id: i32) {
        if let Ok(Some(row)) = conversation::Entity::find_by_id(conversation_id)
            .one(&self.db.conn)
            .await
        {
            let mut active = row.into_active_model();
            active.status = Set(ConversationStatus::Cancelled);
            if active.update(&self.db.conn).await.is_ok() {
                emit_conversation_upsert(&self.emitter, &self.db.conn, conversation_id).await;
            }
        }
    }
}

struct WorktreeRef {
    folder_id: i32,
    path: String,
}

/// Converge DB + clients once a task worktree is off disk. Split out of
/// [`TaskEngine::remove_worktree_locked`] so the ordering contract below is
/// unit-testable without a real git worktree.
///
/// Write order: conversations first (never orphaned under a vanishing folder),
/// then its tabs, then the folder row. Each step ends in a broadcast, because a
/// removal no client hears about is a removal no client shows: the sidebar keeps
/// the dead worktree until the next full `fetchFolders` (i.e. a reload).
async fn converge_worktree_removal(
    db: &AppDatabase,
    emitter: &EventEmitter,
    task_id: i32,
    wt_id: i32,
    project_folder_id: i32,
    wt_path: &str,
) {
    let moved = conversation_service::reparent_folder_conversations(
        &db.conn,
        wt_id,
        project_folder_id,
        wt_path,
    )
    .await
    .unwrap_or(0);

    match tab_service::delete_folder_tabs_and_bump(&db.conn, wt_id).await {
        Ok(inv) => {
            if let Some(tabs) = inv.emit {
                emit_event(
                    emitter,
                    crate::web::event_bridge::TABS_CHANGED_EVENT,
                    crate::web::event_bridge::TabsChanged {
                        version: inv.version,
                        origin: "server".to_string(),
                        tabs,
                    },
                );
            }
        }
        Err(e) => tracing::warn!("[work_task] tab cleanup failed for folder {wt_id}: {e}"),
    }

    // Announce the folder drop only when the row really is gone, so a failed
    // write can't leave clients disagreeing with what a refetch would return.
    let folder_gone = match folder::Entity::find_by_id(wt_id).one(&db.conn).await {
        Ok(Some(row)) => {
            let now = chrono::Utc::now();
            let mut active = row.into_active_model();
            active.is_open = Set(false);
            active.deleted_at = Set(Some(now));
            active.updated_at = Set(now);
            match active.update(&db.conn).await {
                Ok(_) => true,
                Err(e) => {
                    tracing::warn!("[work_task] worktree folder {wt_id} soft-delete failed: {e}");
                    false
                }
            }
        }
        // Already soft-deleted / never there: a client still holding it is stale.
        Ok(None) => true,
        Err(e) => {
            tracing::warn!("[work_task] worktree folder {wt_id} lookup failed: {e}");
            false
        }
    };

    let _ = work_task_service::clear_worktree(&db.conn, task_id).await;
    let _ = work_task_service::record_event(
        &db.conn,
        task_id,
        "user_action",
        "engine",
        Some(serde_json::json!({ "action": "cleanup", "reparented": moved })),
    )
    .await;

    // Conversations first: this starts every client's refetch, so the moved
    // rows have the shortest possible window with no folder to render under.
    emit_event(
        emitter,
        crate::web::event_bridge::CONVERSATIONS_BULK_CHANGED_EVENT,
        crate::web::event_bridge::ConversationsBulkChanged {
            imported: 0,
            updated: moved as u32,
            folder_ids: vec![project_folder_id],
        },
    );
    if folder_gone {
        emit_folder_deleted(emitter, wt_id);
    }
}

/// The commit THIS TASK's own work sits on top of: the point its worktree was
/// checked out at, which is also the point an acceptance would deliver from.
/// The counters on the row and every "is there anything to land" probe measure
/// from here — deliberately not from the review baseline, which answers a
/// different question ("what is under review", pull request included).
///
/// For an ordinary task the two coincide: the branch was minted at the recorded
/// base, so "diff against the base" and "what the agent did" are one set. Two
/// things move the anchor off it:
///
/// - **A task triggered from a pull request starts ON that pull request's
///   head**, while its base is the MERGE BASE — because the review is meant to
///   show the pull request plus whatever the agent did (see
///   [`TaskEngine::pr_checkout_point`]). Measuring the task's own work from
///   there would credit it with every file the pull request itself changed: a
///   review-only task that committed nothing would report a full change set,
///   the board would offer to push it back (a delivery with nothing in it),
///   and "complete" — the acceptance that actually applies — would never
///   appear. The head comes from the task's source snapshot, which is what the
///   checkout used; it must still be a commit HERE, since a force-push can
///   leave the row naming one this repository never had.
/// - **The branch absorbing base content** (the agent merged the base branch
///   in, or rebased onto it) moves the merge base forward, and everything the
///   base contributed would otherwise read as this task's work. Taken only
///   when it moved FORWARD from the recorded base: a base branch that is
///   behind locally, or a same-name branch of unrelated history, must not drag
///   the anchor backwards and inflate the count it was meant to correct.
///
/// `wt_path` is the task's worktree — where every ref here is resolved.
async fn own_work_anchor(
    wt_path: &str,
    task: &crate::db::entities::work_task::Model,
) -> Option<String> {
    if task.source_kind.as_deref() == Some(SOURCE_KIND_PR) {
        let head = task
            .source_meta
            .as_deref()
            .and_then(|s| serde_json::from_str::<ForgeSourceMeta>(s).ok())
            .and_then(|m| m.head_sha)
            .filter(|s| !s.trim().is_empty());
        if let Some(head) = head {
            if task_git::commit_present(wt_path, &head).await.unwrap_or(false) {
                return Some(head);
            }
        }
    }
    let recorded = task.base_sha.clone().or_else(|| task.base_branch.clone());
    let Some(base_branch) = task.base_branch.as_deref() else {
        return recorded;
    };
    let Ok(Some(tip)) = task_git::local_branch_tip(wt_path, base_branch).await else {
        return recorded;
    };
    let Ok(merge_base) = task_git::merge_base(wt_path, &tip, "HEAD").await else {
        return recorded;
    };
    match task.base_sha.as_deref() {
        Some(sha) => task_git::is_ancestor(wt_path, sha, &merge_base)
            .await
            .unwrap_or(false)
            .then_some(merge_base)
            .or(recorded),
        // No recorded sha to move forward from — the merge base is strictly
        // better than the branch NAME this would otherwise diff against, which
        // measures against its tip and calls the base's own progress a change.
        None => Some(merge_base),
    }
}

/// `(files, additions, deletions)` of the worktree against `anchor`,
/// uncommitted work included — nothing forces the agent to commit before the
/// task lands in review, and a task whose new files are still untracked has
/// done work all the same.
async fn diff_stats_from(wt_path: &str, anchor: &str) -> Option<(i32, i32, i32)> {
    let files = task_git::diff_numstat_with_untracked(wt_path, anchor)
        .await
        .ok()?;
    let adds: i32 = files.iter().map(|f| f.additions).sum();
    let dels: i32 = files.iter().map(|f| f.deletions).sum();
    Some((files.len() as i32, adds, dels))
}

/// Row-level auto-merge eligibility: everything the sweep can decide without
/// touching git. Mirrors what the board offers — a task whose merge button the
/// user would not see (nothing to land) or would not press yet (red or pending
/// preflight, an error banner from an earlier attempt) is not auto-merged.
///
/// - `files_changed == 0` is the "complete" button's territory: dispatching a
///   merge generation there would land nothing and bounce. `None` (stats
///   unreadable) merges, exactly like the UI defaults to the merge button.
/// - With a preflight configured, only a green light qualifies; `None` means
///   the light is not written yet (the post-preflight hook re-sweeps) and a
///   red light waits for the user. Without one, there is no gate.
/// - `last_error` present = an earlier merge failed or was refused; retrying
///   unattended would loop, so the row waits for the user (any claim or a
///   fresh dispatch clears it).
fn auto_merge_candidate(
    task: &crate::db::entities::work_task::Model,
    settings: &WorkTaskFolderSettings,
) -> bool {
    if task.status != WorkTaskStatus::Review {
        return false;
    }
    // Forge-sourced tasks never auto-merge: their prompt embeds text authored
    // by arbitrary external users, so landing without a human review would be
    // an injection -> main-branch pipeline. A hard rule, deliberately not a
    // setting — the user's explicit merge click on the card is unaffected.
    if task.source_kind.is_some() {
        return false;
    }
    if task.last_error.is_some() {
        return false;
    }
    // A merge the user queued is theirs to land, with the commit message and
    // the worktree choice THEY picked. The unattended dispatch has neither, so
    // the queue's own drain owns this row (and clears the intent in the same
    // CAS that starts the merge, which makes the row a normal candidate again).
    //
    // Any value in the column counts, parseable or not: the authoritative gate
    // is `begin_merge`'s `PendingMerge IS NULL` filter, SQL cannot parse the
    // JSON, and a looser predicate here would just dispatch into a CAS that
    // misses every time — a sweep spinning on a row it can never land.
    if task.pending_merge.is_some() {
        return false;
    }
    if task.files_changed == Some(0) {
        return false;
    }
    if preflight_configured(settings) {
        let passed = task
            .preflight
            .as_deref()
            .and_then(|s| serde_json::from_str::<WorkTaskPreflight>(s).ok())
            .is_some_and(|p| p.status == "passed");
        if !passed {
            return false;
        }
    }
    true
}

/// Whether the folder's settings would make `run_preflight` attempt a command
/// at all — the sweep's gate must not wait for a light that will never be
/// written.
fn preflight_configured(settings: &WorkTaskFolderSettings) -> bool {
    settings
        .preflight_command
        .as_deref()
        .map(str::trim)
        .is_some_and(|c| !c.is_empty())
        || settings.preflight_command_id.is_some()
}

/// Why a queue-bound CAS missed. With a claim it can be either "the row left
/// review" or "this queued merge is no longer the one on the row" (withdrawn,
/// or edited into a different one) — the pump treats both the same way, and
/// both are races it should lose quietly rather than banner.
fn missed_queue_cas(claim: Option<&QueuedMergeClaim>) -> String {
    match claim {
        Some(_) => "the queued merge was changed or withdrawn before it could start".to_string(),
        None => "task left review before the merge was queued".to_string(),
    }
}

/// The order the folder's merge queue drains in: oldest request first, task id
/// breaking a tie. Mirrored client-side by `mergeQueueRanks`, so the place in
/// line a card shows is the order the pump actually dispatches in.
fn queue_order(
    intent: &WorkTaskQueuedMerge,
    task: &crate::db::entities::work_task::Model,
) -> (chrono::DateTime<chrono::Utc>, i32) {
    (intent.queued_at, task.id)
}

/// Merge-dispatch refusals that mean "someone else is (or just was) handling
/// this" rather than "this merge cannot work": the losing side of a race with
/// a click, another sweep or a user action. Matched on `merge_task`'s own
/// wording (same file, a screen up) — these are skipped silently, because the
/// next settle re-sweeps, while every other refusal banners the row.
fn is_benign_merge_race(error: &str) -> bool {
    error.contains("not in review")
        || error.contains("left review")
        || error.contains("already merging")
        || is_queued_merge_superseded(error)
}

/// The one benign race the drain cannot simply step over: the user withdrew or
/// edited the very merge it was dispatching (see [`missed_queue_cas`]). Their
/// word replaces the whole snapshot — a re-read, not a skip.
fn is_queued_merge_superseded(error: &str) -> bool {
    error.contains("changed or withdrawn")
}

/// What a refused push-back most likely means, read off git's own words.
///
/// Deliberately narrow. Whatever this returns is printed to a human as advice,
/// so the only two shapes recognised are the ones git states plainly, and
/// everything else is `Unknown` — which prints no advice at all. An unhelpful
/// message costs a reader a moment; a confident wrong one sends them to change
/// a setting that was never the problem.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PushRefusal {
    /// The remote refused the account: no write access, or a fork whose author
    /// did not allow maintainer edits.
    Permission,
    /// The branch has commits the task's branch does not, so a fast-forward
    /// push cannot apply. Routine on a long-lived pull request: the author
    /// pushed, or merged the base branch in, after this task was triggered.
    BranchMoved,
    Unknown,
}

/// Match on git's stderr, which reaches here inside the delivery error string.
/// Permission is tested first: a forge that refuses the push outright can also
/// mention "rejected", and being told the wrong one of these two is precisely
/// the failure this classification exists to stop.
fn classify_push_refusal(error: &str) -> PushRefusal {
    let lower = error.to_lowercase();
    // The status codes are matched in the phrasing git and curl actually
    // print, not as bare digits: "403" on its own also matches a branch called
    // `fix/403-page` or a repository named after an issue number, and the whole
    // point of this function is to stop it handing out confident wrong advice.
    let permission = [
        "permission to",
        "denied to",
        "error: 403",
        "error: 401",
        "http 403",
        "http 401",
        "status code 403",
        "status code 401",
        "authentication failed",
        "write access",
        "read-only",
        "protected branch",
        "pre-receive hook declined",
    ];
    if permission.iter().any(|needle| lower.contains(needle)) {
        return PushRefusal::Permission;
    }
    let moved = [
        "non-fast-forward",
        "fetch first",
        "updates were rejected",
        "[rejected]",
        "behind its remote",
        "stale info",
    ];
    if moved.iter().any(|needle| lower.contains(needle)) {
        return PushRefusal::BranchMoved;
    }
    PushRefusal::Unknown
}

/// The repository a pull-request task's push-back lands in: the HEAD
/// repository recorded at trigger time — the fork, when the pull request comes
/// from one. A row that recorded none falls back to the source repository:
/// builds that predate the field refused forks at trigger, so their rows are
/// same-repo by construction. `Err` is the one head codeg cannot push to ever —
/// a fork it cannot name (GitLab's unresolved `project-{id}` placeholder, or a
/// fork deleted since GitHub hydrated the row).
fn pull_push_repo(meta: &ForgeSourceMeta) -> Result<String, String> {
    let recorded = meta
        .head_repo
        .as_deref()
        .map(str::trim)
        .filter(|r| !r.is_empty())
        .unwrap_or(&meta.owner_repo);
    crate::forge::normalize_repo(recorded).ok_or_else(|| {
        format!(
            "{} #{} comes from a fork whose repository codeg cannot see (it may be private or \
             deleted), so there is nowhere to push the work back to — its commits stay on the \
             task's local branch",
            meta.provider.change_noun(),
            meta.number
        )
    })
}

/// Pick the launch mode for a pump-driven launch from the task's history: a
/// task with a prior conversation continues (retry semantics); one with no
/// session to continue starts fresh. Explicit returns launch directly with
/// `LaunchMode::Return`.
///
/// The bound session IS the whole criterion, which is what lets a transition
/// decide how the next start behaves: `retry` (failed → queued) keeps the link
/// and therefore continues, while `requeue_canceled` drops it so a task the
/// user put back on the board runs from the top. `compose_prompt` must not
/// read `Fresh` as "this task has no history" — see its doc.
fn launch_mode_for(task: &crate::db::entities::work_task::Model) -> LaunchMode {
    if task.conversation_id.is_some() {
        LaunchMode::Retry
    } else {
        LaunchMode::Fresh
    }
}

/// The branch the task was created FOR, if its config names one. A blank
/// choice is no choice: the editor writes the empty string for "the project
/// folder's current branch", which is also what every task predating the
/// field carries.
fn chosen_base_branch(task: &crate::db::entities::work_task::Model) -> Option<String> {
    serde_json::from_str::<WorkTaskConfig>(&task.config)
        .ok()?
        .base_branch
        .map(|b| b.trim().to_string())
        .filter(|b| !b.is_empty())
}

/// Layered agent config: task override wins wholesale; else the folder's task
/// settings; else the folder's default agent with no extra options.
fn effective_agent_config(
    cfg: &WorkTaskConfig,
    settings: &WorkTaskFolderSettings,
    root: &crate::models::FolderDetail,
) -> (
    Option<String>,
    Option<String>,
    std::collections::BTreeMap<String, String>,
) {
    if let Some(agent) = cfg.agent_type.clone() {
        return (Some(agent), cfg.mode_id.clone(), cfg.config_values.clone());
    }
    if let Some(agent) = settings.default_agent_type.clone() {
        return (
            Some(agent),
            settings.mode_id.clone(),
            settings.config_values.clone(),
        );
    }
    let folder_default = root
        .default_agent_type
        .as_ref()
        .and_then(|a| serde_json::to_value(a).ok())
        .and_then(|v| v.as_str().map(String::from));
    (
        folder_default,
        settings.mode_id.clone(),
        settings.config_values.clone(),
    )
}

/// Compose the prompt for a launch mode. Fresh runs replay the task's blocks.
/// Retry/return compose against the session we actually got: a resumed session
/// already carries the task context, while a fresh fallback session needs the
/// full original description again. Every prompt ends with the worktree guard,
/// then with whatever the folder's settings add for this stage.
///
/// "Fresh" is a mode, NOT a promise that the task is pristine: `requeue_canceled`
/// drops the session link so a re-queued task starts over, which sends a task
/// that already ran — worktree, branch and all — back through the fresh arm. Both
/// replaying arms therefore read the instruction log rather than the mode.
async fn compose_prompt(
    cfg: &WorkTaskConfig,
    task: &crate::db::entities::work_task::Model,
    mode: &LaunchMode,
    settings: &WorkTaskFolderSettings,
    resumed: bool,
    conn: &sea_orm::DatabaseConnection,
) -> Result<Vec<PromptInputBlock>, String> {
    let mut blocks: Vec<PromptInputBlock> = Vec::new();
    let original: Vec<PromptInputBlock> = cfg
        .prompt_blocks
        .iter()
        .map(|v| serde_json::from_value::<PromptInputBlock>(v.clone()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("bad prompt blocks: {e}"))?;

    // Whether this launch is (re)doing the task's ORIGINAL work order, as
    // opposed to follow-up work the user asked for later. The worktree guard
    // below keys its licence on this: a report-deliverable task forbids code
    // changes on its original order, but a returned "now apply the fix" turn
    // is precisely a change order and must get the normal write licence.
    let mut original_work_order = false;
    // A replay standing in for an unanswered question: it already says "do not
    // change any files for it", so the guard must not hand back the commit
    // grant three blocks later.
    let mut replayed_question = false;

    match mode {
        LaunchMode::Fresh => {
            if original.is_empty() {
                return Err("prompt is empty".to_string());
            }
            // Read the log, not the mode. A fresh launch used to mean a task
            // with no history at all; since a requeue drops the session link it
            // also means "run this again from the top", and that task may owe
            // the user an instruction its stopped generation never answered —
            // a returned "rework this" is silently lost otherwise, and a
            // returned question comes back as a work order with a full commit
            // grant. Same two reads as the retry arm, for the same reasons.
            let scan = instruction_scan(conn, task.id).await;
            original_work_order = scan.interrupted.is_none();
            replayed_question = matches!(scan.interrupted, Some(FollowUpIntent::Question));
            // Only when a generation actually got as far as its own turn
            // (`started_at` is written by `mark_running` and never cleared): a
            // task canceled during setup has nothing in its worktree to warn
            // about, and its prompt stays byte-identical to a first run's.
            if task.started_at.is_some() {
                blocks.push(PromptInputBlock::Text {
                    text: "You are running this task again from the top: an earlier run was \
                           stopped and the task was put back on the board, so this session \
                           carries none of that run's context. Its worktree may still hold \
                           that run's work — check the current state first and build on \
                           whatever is already there instead of redoing it. The original task \
                           was:"
                        .to_string(),
                });
            }
            blocks.extend(original);
            push_replay(&mut blocks, &scan, resumed, task.id);
        }
        LaunchMode::Retry => {
            blocks.push(PromptInputBlock::Text {
                text: "The previous run of this task was interrupted. Continue working in \
                       this worktree and complete the task."
                    .to_string(),
            });
            if !resumed {
                blocks.push(PromptInputBlock::Text {
                    text: "The original task follows for reference:".to_string(),
                });
                blocks.extend(original);
            }
            // Replay whatever instruction the interrupted generation still
            // owed the user, framed the way they meant it — an unanswered
            // question must not come back as a work order.
            let scan = instruction_scan(conn, task.id).await;
            // A retry stands in for whichever turn was interrupted, and the
            // licence follows THAT turn — `interrupted`, not the newest note:
            // a retry/requeue note refines the turn it interrupts (a hint, a
            // screenshot), it does not change what kind of turn it was. With
            // no unsettled follow-up underneath, this is the original order
            // again.
            original_work_order = scan.interrupted.is_none();
            replayed_question = matches!(scan.interrupted, Some(FollowUpIntent::Question));
            push_replay(&mut blocks, &scan, resumed, task.id);
        }
        LaunchMode::Return {
            intent,
            feedback,
            attachments,
        } => {
            if !resumed {
                // Session resume failed — the fresh session has no context, so
                // replay the task before the feedback.
                blocks.push(PromptInputBlock::Text {
                    text: "You are picking up a task whose previous session could not be \
                           resumed. The worktree already contains that session's work. \
                           The original task was:"
                        .to_string(),
                });
                blocks.extend(original);
            }
            blocks.push(PromptInputBlock::Text {
                text: follow_up_text(*intent, feedback),
            });
            blocks.extend(attachment_blocks(attachments, task.id));
        }
        LaunchMode::Merge {
            root_path,
            base_branch,
            work_branch,
            strategy,
            message,
            instructions,
        } => {
            if !resumed {
                blocks.push(PromptInputBlock::Text {
                    text: "You are picking up a task whose previous session could not be \
                           resumed. The worktree already contains that session's work. \
                           The original task was:"
                        .to_string(),
                });
                blocks.extend(original);
            }
            let land_command = if strategy == "merge" {
                format!(
                    "git -C \"{root_path}\" merge --no-ff -m \"<message>\" {work_branch}"
                )
            } else {
                format!(
                    "git -C \"{root_path}\" merge --squash {work_branch} && \
                     git -C \"{root_path}\" commit -m \"<message>\""
                )
            };
            // Indented under step 3 rather than left dangling after it: it says
            // what to substitute for that step's `<message>`, and read as a
            // fourth line it looked like a fourth instruction.
            let message_rule = match message {
                Some(m) => format!("   Use exactly this commit message:\n   {m}"),
                None => "   For `<message>`, write a concise Conventional Commits \
                         message yourself, summarizing what this task changed."
                    .to_string(),
            };
            // The user's own words get their own paragraph, before the closing
            // rules — those rules stay last on purpose (same reason the standing
            // worktree guard below is the last built-in block): whatever the
            // user asked for, it does not license a push or a self-deletion.
            let extra = match instructions {
                Some(i) => format!("\nAlso follow these instructions from the user:\n{i}\n"),
                None => String::new(),
            };
            blocks.push(PromptInputBlock::Text {
                text: format!(
                    "The user accepted this task — land it onto the base branch \
                     `{base_branch}` now, doing all git operations yourself:\n\
                     1. Commit any uncommitted changes in this worktree to the current \
                     branch (`{work_branch}`).\n\
                     2. Run `git merge {base_branch}` here and resolve every conflict so \
                     both the base's changes and this task's intent survive; complete the \
                     merge commit.\n\
                     3. Land onto the base checkout at `{root_path}`:\n   {land_command}\n\
                     {message_rule}\n\
                     {extra}\n\
                     Do NOT push, do NOT delete this worktree or its branch, and do not \
                     change anything else on the base branch — leave the checkout at \
                     `{root_path}` on `{base_branch}`, never switch branches there. \
                     Finish with one short line saying what landed."
                ),
            });
        }
    }

    // The standing worktree guard — a merge generation replaces it with its
    // own instructions (it exists to forbid exactly what a merge must do).
    //
    // It is the LAST built-in block, so its licence clause is the last thing
    // the agent reads: a read-only turn — and a report-deliverable original
    // order — has to swap that clause out, or "commit to the current branch as
    // you like" would quietly undo the intent's own "don't touch any file"
    // instruction several blocks earlier.
    if !matches!(mode, LaunchMode::Merge { .. }) {
        let branch = task
            .work_branch
            .as_deref()
            .map(|b| format!(" (branch `{b}`)"))
            .unwrap_or_default();
        let base = task
            .base_branch
            .as_deref()
            .map(|b| format!(" (`{b}`)"))
            .unwrap_or_default();
        let licence = if mode.is_read_only() || replayed_question {
            format!(
                "This turn is a question, not a work order: answer it in your reply and do NOT \
                 create, edit, delete or commit any file, and do not merge into, rebase onto, or \
                 push the base branch{base}. If answering would require a change, describe the \
                 change instead of making it."
            )
        } else if original_work_order && cfg.deliverable.as_deref() == Some(DELIVERABLE_REPORT) {
            // Report-deliverable order (forge plan-first / review-only):
            // the generic "commit as you like" grant would quietly undo the
            // task's own "analysis only" instruction several blocks earlier —
            // the licence must defer to the task text, not overrule it.
            format!(
                "This turn delivers a report, not code changes: put the full findings in your \
                 final reply — the user reads them from there, and may return this task for \
                 follow-up work afterwards. Commit only what the task's instructions \
                 explicitly allow (often nothing), and do NOT merge into, rebase onto, or \
                 push the base branch{base}."
            )
        } else {
            format!(
                "Commit to the current branch as you like, but do NOT merge into, rebase onto, \
                 or push the base branch{base} — the user lands the result after review. Finish \
                 with a short summary of what you did."
            )
        };
        blocks.push(PromptInputBlock::Text {
            text: format!(
                "—— Work task context ——\nYou are working inside a dedicated git worktree for \
                 this task{branch}. {licence}\nIf the `task_progress` and `task_complete` tools \
                 are available to you, report milestones with `task_progress` as you go, and \
                 call `task_complete` once right before you finish (verdict `success`, \
                 `needs_review`, or `blocked`, plus a short summary).",
            ),
        });
    }

    // Whatever the user added in task settings, always last: it refines the
    // built-in wording above it, and staying at the end keeps `prompt_head`
    // (the transcript's round marker) on the prompt's own opening text.
    blocks.extend(stage_prompt_block(settings, mode.round_kind()));
    Ok(blocks)
}

/// The user's own instructions for a stage: the `all` text (every stage) then
/// the stage's own, as one trailing block. Empty when neither is configured.
fn stage_prompt_block(
    settings: &WorkTaskFolderSettings,
    stage: &str,
) -> Option<PromptInputBlock> {
    let extras: Vec<&str> = [STAGE_PROMPT_ALL, stage]
        .into_iter()
        .filter_map(|key| settings.stage_prompts.get(key))
        .map(|text| text.trim())
        .filter(|text| !text.is_empty())
        .collect();
    if extras.is_empty() {
        return None;
    }
    Some(PromptInputBlock::Text {
        text: format!("—— Additional instructions ——\n{}", extras.join("\n\n")),
    })
}

/// The prompt text for a follow-up on a reviewed task. The intent decides the
/// framing, which is the whole point of having intents: the same sentence from
/// the user means "fix this", "also do this" or "explain this" depending on it,
/// and an agent told it was *returned* work will start editing either way.
fn follow_up_text(intent: FollowUpIntent, feedback: &str) -> String {
    match intent {
        // Historical wording, kept verbatim: this is what an unlabelled
        // follow-up composes, so the default path is unchanged.
        FollowUpIntent::Revise => format!(
            "The user reviewed your work on this task and returned it with the following \
             feedback. Address it in this same worktree:\n\n{feedback}"
        ),
        FollowUpIntent::Continue => format!(
            "The user reviewed your work on this task and accepted it as it stands. Keep going \
             in this same worktree with the following additional work — do not redo or second-\
             guess what is already there:\n\n{feedback}"
        ),
        FollowUpIntent::Question => format!(
            "The user has a question about your work on this task. Answer it directly in your \
             reply. This is a question, not a work order: do not create, edit, delete or commit \
             any file unless the user explicitly asks you to. If answering would require a \
             change, describe the change instead of making it.\n\n{feedback}"
        ),
        FollowUpIntent::Verify => {
            let base = "The user wants this task checked over before they accept it. Review your \
                        own work: read the full diff of this worktree against the base branch \
                        looking for bugs, leftovers, debug code and anything the task asked for \
                        but you did not do; run the project's own checks or tests; and fix what \
                        you find. Report what you checked and what you changed.";
            if feedback.is_empty() {
                base.to_string()
            } else {
                format!("{base}\n\nWhat they want you to pay attention to:\n\n{feedback}")
            }
        }
    }
}

/// The attachment blocks recorded on a `user_action` payload, if any. Absent on
/// every event written before follow-ups could carry attachments, so a missing
/// or malformed field simply means "nothing was attached".
fn payload_blocks(payload: &serde_json::Value) -> Vec<serde_json::Value> {
    payload
        .get("blocks")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
}

/// Parse stored attachment blocks, dropping (with a warning) any that no longer
/// deserialize. Unlike the task's own prompt, an attachment is an addition to
/// the instruction — losing one must not stop the run that carries the rest.
fn attachment_blocks(raw: &[serde_json::Value], task_id: i32) -> Vec<PromptInputBlock> {
    raw.iter()
        .filter_map(|v| match serde_json::from_value::<PromptInputBlock>(v.clone()) {
            Ok(block) => Some(block),
            Err(e) => {
                tracing::warn!("[work_task] task {task_id}: dropping bad attachment block: {e}");
                None
            }
        })
        .collect()
}

/// How long a launch waits for the agent to advertise what a prompt may carry,
/// before sending its attached images in whatever shape they were stored. Only
/// image-bearing prompts ever wait, and only until the handshake lands — which
/// is the same round trip the prompt itself is about to need anyway.
const IMAGE_CAPABILITY_WAIT: Duration = Duration::from_secs(20);

/// Whether this block carries image bytes in either of the two wire encodings.
fn carries_image(block: &PromptInputBlock) -> bool {
    match block {
        PromptInputBlock::Image { .. } => true,
        PromptInputBlock::Resource {
            mime_type, blob, ..
        } => {
            blob.is_some()
                && mime_type
                    .as_deref()
                    .is_some_and(|m| m.starts_with("image/"))
        }
        _ => false,
    }
}

/// Swap every attached image into the shape the connected agent advertised.
///
/// Two wire encodings carry the same bytes: a native `Image` block, and a
/// `Resource` whose `blob` holds them under an image mime type (what an agent
/// that rejects image content but accepts embedded context takes). The composer
/// picks one at compose time from a probe; this picks again at dispatch, when
/// the session has actually said what it accepts.
///
/// Grok needs neither swap — it advertises both bits — but its images still get
/// sorted per mime further downstream, in `acp::connection`, which is the last
/// point that sees the blocks.
///
/// Only image-carrying blocks are touched, and only to move between those two
/// encodings — never to invent or drop content. An agent that advertises
/// neither is left alone: there is no third shape to reach for, and rewriting
/// into one it also rejects would only obscure the error it is about to raise.
fn reencode_images(blocks: &mut [PromptInputBlock], caps: &PromptCapabilitiesInfo) {
    for (index, block) in blocks.iter_mut().enumerate() {
        match block {
            PromptInputBlock::Image {
                data,
                mime_type,
                uri,
            } if !caps.image && caps.embedded_context => {
                *block = PromptInputBlock::Resource {
                    // A path-less image (a pasted screenshot) needs some stable
                    // identifier; its position in this prompt is one.
                    uri: uri
                        .clone()
                        .unwrap_or_else(|| format!("clipboard://work-task-image-{index}")),
                    mime_type: Some(mime_type.clone()),
                    text: None,
                    blob: Some(std::mem::take(data)),
                };
            }
            PromptInputBlock::Resource {
                uri,
                mime_type,
                text: None,
                blob: Some(blob),
            } if caps.image
                && !caps.embedded_context
                && mime_type
                    .as_deref()
                    .is_some_and(|m| m.starts_with("image/")) =>
            {
                *block = PromptInputBlock::Image {
                    data: std::mem::take(blob),
                    mime_type: mime_type.clone().unwrap_or_default(),
                    uri: Some(uri.clone()),
                };
            }
            _ => {}
        }
    }
}

/// A restart note reaches the agent as context, not as the task itself.
fn restart_note_block(note: &str) -> PromptInputBlock {
    PromptInputBlock::Text {
        text: format!(
            "The user restarted this task and left this note — take it into account:\n\n{note}"
        ),
    }
}

/// What the user last asked for, and how they meant it.
#[derive(Debug, Clone, PartialEq, Eq)]
enum OutstandingKind {
    /// A follow-up on a reviewed task.
    Review(FollowUpIntent),
    /// A note attached to a retry or a re-queue.
    Restart,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Outstanding {
    kind: OutstandingKind,
    text: String,
    /// Raw prompt blocks the user attached to that instruction (images, pasted
    /// bytes). Kept unparsed here — `attachment_blocks` validates at the point
    /// the prompt is composed.
    attachments: Vec<serde_json::Value>,
}

/// The user instruction the agent still owes a turn to, if any.
///
/// Scans the task's events newest-first and stops at whichever comes first:
/// - a follow-up `user_action` (return / retry / requeue) → that one is
///   outstanding;
/// - a settle into `review` → a generation ran to completion after anything
///   earlier, so nothing is owed.
///
/// It is a barrier, not a filter. Filtering (e.g. "skip questions") would walk
/// *past* the newest instruction and resurrect an older one the agent already
/// carried out — replaying "add the tests" long after they were added. And the
/// review barrier is what stops a note from being re-injected into every
/// subsequent generation for the rest of the task's life.
/// What a retry launch learns from the event log: the newest instruction the
/// interrupted generation still owes the user (`outstanding`, replayed into
/// the prompt), and the kind of turn that generation was actually running
/// (`interrupted`, which picks the guard's licence). They differ exactly when
/// a retry/requeue note sits on top of a failed follow-up: the note is the
/// newer INSTRUCTION, but the turn underneath is still that follow-up — a
/// note refines the turn it interrupts, it does not change its kind.
struct InstructionScan {
    outstanding: Option<Outstanding>,
    /// The unsettled `return` intent beneath any retry/requeue notes; `None`
    /// when the generation was (re)doing the task's original order.
    interrupted: Option<FollowUpIntent>,
    /// That same `return` as an INSTRUCTION, and only when a newer
    /// retry/requeue note took the `outstanding` slot away from it.
    ///
    /// A resumed session already has those words in its transcript, so the
    /// note alone is the right replay there — that is what "a note refines the
    /// turn it interrupts" means. A session with no context (a re-queued
    /// task's fresh launch, a resume that failed over) has nothing: replaying
    /// only the note hands the agent "take this into account" with no account
    /// to take it into, and for a question it pairs a read-only licence with a
    /// question the agent was never shown.
    interrupted_instruction: Option<Outstanding>,
}

async fn instruction_scan(
    conn: &sea_orm::DatabaseConnection,
    task_id: i32,
) -> InstructionScan {
    // Newest-first, and narrowed IN THE QUERY to the two kinds that can settle
    // the question. Scanning raw events would let a chatty run bury the answer:
    // `agent_progress` volume is up to the agent, so a few hundred milestones
    // would push the instruction past any limit. Filtered this way the limit
    // bounds a log of decisions, which is small.
    let events = work_task_service::recent_events_of_kinds(
        conn,
        task_id,
        &["user_action", "status_changed"],
        200,
    )
    .await
    .unwrap_or_default();
    let mut scan = InstructionScan {
        outstanding: None,
        interrupted: None,
        interrupted_instruction: None,
    };
    for event in events {
        match event.kind.as_str() {
            "status_changed" => {
                let settled = event
                    .payload
                    .as_ref()
                    .and_then(|p| p.get("to"))
                    .and_then(|v| v.as_str())
                    == Some("review");
                // Reaching review consumed every older instruction: whatever
                // lies beyond was delivered and decided on.
                if settled {
                    break;
                }
            }
            "user_action" => {
                let payload = match event.payload {
                    Some(p) => p,
                    None => continue,
                };
                let Some(action) = payload.get("action").and_then(|v| v.as_str()) else {
                    break;
                };
                match action {
                    "return" => {
                        let intent = FollowUpIntent::from_wire(
                            payload.get("intent").and_then(|v| v.as_str()),
                        )
                        .unwrap_or_default();
                        let returned =
                            payload.get("feedback").and_then(|v| v.as_str()).map(|text| {
                                Outstanding {
                                    kind: OutstandingKind::Review(intent),
                                    text: text.to_string(),
                                    attachments: payload_blocks(&payload),
                                }
                            });
                        if scan.outstanding.is_none() {
                            let Some(returned) = returned else {
                                break;
                            };
                            scan.outstanding = Some(returned);
                        } else {
                            // A retry/requeue note already claimed the newest
                            // slot. Keep the returned words too — see the field.
                            scan.interrupted_instruction = returned;
                        }
                        // The newest unsettled return IS the interrupted turn
                        // (a second return needs another review in between,
                        // which would have settled this scan already).
                        scan.interrupted = Some(intent);
                        break;
                    }
                    "retry" | "requeue" => {
                        if scan.outstanding.is_none() {
                            let Some(text) = payload.get("note").and_then(|v| v.as_str()) else {
                                break;
                            };
                            scan.outstanding = Some(Outstanding {
                                kind: OutstandingKind::Restart,
                                text: text.to_string(),
                                attachments: payload_blocks(&payload),
                            });
                        }
                        // Keep looking: the turn this note interrupted lies
                        // deeper in the log.
                    }
                    // Other user actions (delete, …) neither carry nor consume
                    // an instruction.
                    _ => continue,
                }
            }
            _ => continue,
        }
    }
    scan
}

/// Replay everything the launch still owes the user, oldest first, with each
/// instruction's own attachments right behind the sentence that framed it.
///
/// `resumed` is the whole difference. A resumed session carries the interrupted
/// turn in its transcript, so the newest instruction is the entire replay — a
/// retry/requeue note refines a turn the agent can still read. A session with
/// no context has to be given that turn as well, or the note lands on nothing:
/// see [`InstructionScan::interrupted_instruction`].
///
/// Shared by both replaying arms — a re-queued task reaches `Fresh` with
/// exactly the same debt to the user as an interrupted one reaching `Retry`,
/// so the two must not drift apart in what they replay or how they word it.
fn push_replay(
    blocks: &mut Vec<PromptInputBlock>,
    scan: &InstructionScan,
    resumed: bool,
    task_id: i32,
) {
    let mut push = |instruction: &Outstanding| {
        blocks.push(outstanding_block(instruction));
        blocks.extend(attachment_blocks(&instruction.attachments, task_id));
    };
    if !resumed {
        if let Some(interrupted) = &scan.interrupted_instruction {
            push(interrupted);
        }
    }
    if let Some(outstanding) = &scan.outstanding {
        push(outstanding);
    }
}

/// The block that replays one outstanding instruction, framed the way the user
/// meant it: an unanswered question must not come back as a work order.
fn outstanding_block(outstanding: &Outstanding) -> PromptInputBlock {
    match outstanding.kind {
        OutstandingKind::Restart => restart_note_block(&outstanding.text),
        OutstandingKind::Review(FollowUpIntent::Question) => PromptInputBlock::Text {
            text: format!(
                "The user asked this question before the interruption and never got an \
                 answer. Answer it, and do not change any files for it:\n\n{}",
                outstanding.text
            ),
        },
        OutstandingKind::Review(_) => PromptInputBlock::Text {
            text: format!("Latest review feedback to address:\n{}", outstanding.text),
        },
    }
}

/// One-shot sink for the generation a launch actually operated on. The launch
/// fills it as soon as it has read the row; `spawn_launch` reads it afterwards
/// so a setup failure is attributed to the right generation.
#[derive(Default)]
struct LaunchSeq(std::sync::Mutex<Option<i32>>);

impl LaunchSeq {
    // Poison-tolerant, matching the locks in `office_watch` and
    // `background_watch`. The guarded value is a plain `Option<i32>` that
    // cannot be left half-written, so a panic elsewhere in the launch has
    // nothing to corrupt here, while `expect` would turn that unrelated panic
    // into a permanent failure of every later launch. The schedule tick reaches
    // this with nobody at the keyboard.
    fn set(&self, run_seq: i32) {
        *self.0.lock().unwrap_or_else(|p| p.into_inner()) = Some(run_seq);
    }

    fn get(&self) -> Option<i32> {
        *self.0.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// One-shot "this generation is live" report from a launch to whoever asked
/// for it — today the merge click, which must not sit on the rest of the run.
///
/// Fire-once by construction, and callable from either side of the launch: the
/// launch itself fires `Ok` the moment the agent is up and the row carries its
/// coordinates, while the task that drives it fires the launch's error for
/// every way of failing before that point. Whichever comes first wins; the
/// other is a no-op, so a failure AFTER a successful dispatch stays on the card
/// instead of being reported to a caller that has already been told the merge
/// started.
struct DispatchSignal(std::sync::Mutex<Option<oneshot::Sender<Result<(), String>>>>);

impl DispatchSignal {
    fn new() -> (Self, oneshot::Receiver<Result<(), String>>) {
        let (tx, rx) = oneshot::channel();
        (Self(std::sync::Mutex::new(Some(tx))), rx)
    }

    fn fire(&self, result: Result<(), String>) {
        // Poison-tolerant for the same reason as `LaunchSeq`: the fire-once
        // guarantee is the `take()`, not the lock's poison flag, and refusing
        // to fire after an unrelated panic would leave the caller waiting on a
        // oneshot that is never sent.
        let sender = self.0.lock().unwrap_or_else(|p| p.into_inner()).take();
        if let Some(sender) = sender {
            let _ = sender.send(result);
        }
    }
}

/// Ownership of a task's in-flight launch slot: which folder it counts
/// against, plus a token so only the launch that took the slot can release it.
struct LaunchOwner {
    folder_id: i32,
    token: u64,
}

/// A task's setup (init command) kill slot, open for the whole preparing phase.
///
/// The slot deliberately does NOT hold the child's pid. Only the task that
/// spawned the child ever kills it, so a pid can never be signalled after it
/// has been reaped (and possibly recycled by the OS onto an unrelated
/// process). A canceller just raises `kill_requested` and rings `wake`.
struct SetupChild {
    /// A cancel arrived: refuse to start an init command, and kill a live one.
    kill_requested: bool,
    /// Generation that owns the slot — a stale cancel must not stop a newer run.
    run_seq: i32,
    /// Rung by the canceller, awaited by whoever is running the child.
    wake: Arc<Notify>,
}

/// A launch's in-flight pre-prompt compaction, keyed by task in
/// [`TaskEngine::compacting`]. Holds the connection the compaction turn runs
/// on so a cancel can abort that turn without the task lock, and the generation
/// that owns it so a stale cancel cannot abort a newer run's compaction.
struct CompactRun {
    run_seq: i32,
    conn_id: String,
}

/// Everything [`TaskEngine::compact_before_prompt`] needs about the launch it
/// is running inside. A struct rather than a parameter list because four of
/// the fields are bare `i32`s in a row — named at the call site, a transposed
/// pair is a compile error instead of a task compacting someone else's session.
struct CompactRequest<'a> {
    task_id: i32,
    run_seq: i32,
    conn_id: &'a str,
    agent_type: AgentType,
    settings: &'a WorkTaskFolderSettings,
    /// The WORKTREE folder the conversation belongs to — same value the round's
    /// own prompt is linked with.
    folder_id: i32,
    conversation_id: i32,
    /// Status this generation holds for the rest of the launch, which the
    /// cancel gates re-check (`preparing`, or `merging` for a merge round).
    in_flight: WorkTaskStatus,
}

/// One context-window occupancy reading, plus where it came from — the source
/// rides the timeline event because "live" and "transcript" answer slightly
/// different questions (what the agent has loaded vs. what its last turn
/// recorded), and a surprising percentage is only debuggable with it.
struct ContextReading {
    percent: f64,
    used: Option<u64>,
    size: Option<u64>,
    source: &'static str,
}

/// How a compaction turn ended: `"ok"` / `"canceled"` / `"failed"`, plus the
/// stop reason or error worth showing beside it.
struct CompactOutcome {
    status: &'static str,
    detail: Option<String>,
}

impl CompactOutcome {
    fn new(status: &'static str, detail: Option<String>) -> Self {
        Self { status, detail }
    }
}

/// One decimal place, for percentages written to the timeline — the same
/// precision the composer's context ring shows, so the two never read as
/// disagreeing about the same session.
fn round1(percent: f64) -> f64 {
    (percent * 10.0).round() / 10.0
}

/// Marker file (in the worktree's PRIVATE git dir, so it can never show up in
/// `git status` or be committed) recording that the folder's init command
/// completed successfully in this worktree.
const SETUP_MARKER: &str = "codeg-task-init-ok";

async fn setup_marker_present(wt_path: &str) -> bool {
    match task_git::git_dir(wt_path).await {
        Ok(dir) => dir.join(SETUP_MARKER).exists(),
        // Can't resolve the git dir → assume not initialized. Re-running an
        // init command is wasteful at worst; skipping one is a broken tree.
        Err(_) => false,
    }
}

async fn write_setup_marker(wt_path: &str) {
    match task_git::git_dir(wt_path).await {
        Ok(dir) => {
            if let Err(e) = tokio::fs::write(dir.join(SETUP_MARKER), b"").await {
                tracing::warn!("[work_task] could not write the setup marker: {e}");
            }
        }
        Err(e) => tracing::warn!("[work_task] could not resolve the worktree git dir: {e}"),
    }
}

/// Best-effort kill of a child's whole process tree. Killing only the direct
/// child is not enough: the init command runs as `sh -c "<line>"`, and the real
/// work (`pnpm install` and its downloads) happens in descendants that would
/// otherwise keep running. Deliberately not `kill_on_drop`, which SIGKILLs the
/// shell first and reparents the descendants out of reach — same rationale as
/// `commands::office_tools::stream_install_or_kill_tree`.
async fn kill_process_tree(pid: Option<u32>) {
    let Some(pid) = pid else { return };
    if let Err(e) = kill_tree::tokio::kill_tree(pid).await {
        tracing::warn!("[work_task] kill_tree failed for setup pid {pid}: {e}");
    }
}

async fn still_expected(
    conn: &sea_orm::DatabaseConnection,
    task_id: i32,
    run_seq: i32,
    expected: WorkTaskStatus,
) -> bool {
    matches!(
        work_task_service::get_model(conn, task_id).await,
        Ok(t) if t.status == expected && t.run_seq == run_seq
    )
}

/// Head of the first text block of a prompt — the transcript viewer matches
/// user turns against it to place round dividers.
fn prompt_head(blocks: &[PromptInputBlock]) -> String {
    blocks
        .iter()
        .find_map(|b| match b {
            PromptInputBlock::Text { text } => Some(first_chars(text.trim(), 160)),
            _ => None,
        })
        .unwrap_or_default()
}

/// Run one shell command line in `cwd`, capturing combined output. stdin is
/// null (a command waiting on input sees EOF); no timeout by design — the
/// result write is generation-guarded, so a runaway command can only waste its
/// own process. Returns (exit code, trailing output capped to
/// `PREFLIGHT_TAIL_CHARS`).
async fn run_shell_capture(line: &str, cwd: &str) -> Result<(Option<i32>, String), String> {
    let out = shell_command(line, cwd)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    Ok(combine_capture(&out))
}

/// The platform's shell invocation for one command line, ready to `output()` or
/// `spawn()`. stdin is null so a command waiting on input sees EOF.
fn shell_command(line: &str, cwd: &str) -> tokio::process::Command {
    #[cfg(not(windows))]
    let mut command = {
        let mut c = crate::process::tokio_command("/bin/sh");
        c.arg("-c").arg(line);
        c
    };
    #[cfg(windows)]
    let mut command = {
        let comspec = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());
        let mut c = crate::process::tokio_command(comspec);
        c.arg("/C").arg(line);
        c
    };
    command.current_dir(cwd);
    command.stdin(std::process::Stdio::null());
    command
}

/// (exit code, trailing combined output) of a finished shell capture.
fn combine_capture(out: &std::process::Output) -> (Option<i32>, String) {
    let mut combined = String::from_utf8_lossy(&out.stdout).into_owned();
    combined.push_str(&String::from_utf8_lossy(&out.stderr));
    (
        out.status.code(),
        tail_chars(&combined, PREFLIGHT_TAIL_CHARS),
    )
}

fn tail_chars(s: &str, n: usize) -> String {
    let trimmed = s.trim_end();
    let count = trimmed.chars().count();
    if count <= n {
        return trimmed.to_string();
    }
    trimmed.chars().skip(count - n).collect()
}

fn parse_agent_type(s: &str) -> Result<AgentType, String> {
    serde_json::from_value(serde_json::Value::String(s.to_string()))
        .map_err(|_| format!("unknown agent type: {s}"))
}

fn first_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// Cap on a task-derived conversation title. Long enough for a real card name,
/// short enough that the sidebar row is not one giant ellipsis.
const CONVERSATION_TITLE_MAX_CHARS: usize = 80;

/// The title the session a task produces carries: the task's own name, capped.
/// It is LOCKED on the conversation row at launch (`conversation_service::
/// lock_title`), so a board card and the session it spawned always read the
/// same in the sidebar (issue #495).
///
/// One definition, because two callers must agree byte-for-byte: the launch-time
/// seed here, and the rename propagation in `commands::work_task`, which
/// recognises "still the task's name" by comparing against this exact value.
pub(crate) fn conversation_title_for_task(task_title: &str) -> String {
    first_chars(task_title.trim(), CONVERSATION_TITLE_MAX_CHARS)
}

/// The project folder's own name — what a task worktree directory is named
/// after. `Path` semantics rather than a `/` split, so `C:\src\repo` yields
/// `repo` too.
///
/// The answer is always RELATIVE, empty included: a path with no final
/// component (a filesystem root, or one ending in `..`) must not fall back to
/// the path itself, because the name is JOINED onto the configured worktree
/// root — and an absolute one replaces that root instead of landing under it.
fn basename(path: &str) -> &str {
    Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
}

/// `name` placed next to the project folder — where task worktrees live when
/// the folder configures no root of its own. A project folder with no parent
/// (a drive or filesystem root) falls back to the bare name, which git then
/// resolves against the repository itself.
fn sibling_path(root_path: &str, name: &str) -> String {
    match Path::new(root_path).parent() {
        Some(parent) if !parent.as_os_str().is_empty() => {
            parent.join(name).to_string_lossy().into_owned()
        }
        _ => name.to_string(),
    }
}

/// Where the task worktree directory `name` goes for a project at
/// `root_path`. `worktree_root` is the folder setting: blank (or absent) keeps
/// the historical layout — right next to the project folder — and any other
/// value becomes the directory every new worktree of that folder is created
/// in. A typed path is taken at face value in the two ways a user expects: `~`
/// is the home directory, and something relative hangs off the project folder.
fn worktree_path_in(root_path: &str, worktree_root: Option<&str>, name: &str) -> String {
    worktree_path_in_home(root_path, worktree_root, name, dirs::home_dir().as_deref())
}

/// [`worktree_path_in`] with the home directory injected — `dirs::home_dir()`
/// reads the real user's home even under a pinned `HOME`, so tests must hand
/// one in rather than set the environment.
fn worktree_path_in_home(
    root_path: &str,
    worktree_root: Option<&str>,
    name: &str,
    home: Option<&Path>,
) -> String {
    let Some(configured) = worktree_root.map(str::trim).filter(|r| !r.is_empty()) else {
        return sibling_path(root_path, name);
    };
    let base = expand_home(configured, home);
    let base = if base.is_absolute() {
        base
    } else {
        Path::new(root_path).join(base)
    };
    base.join(name).to_string_lossy().into_owned()
}

/// Expand a leading `~` against `home`. Left as-is when the home directory is
/// unknown, so the path still resolves as literally written instead of
/// silently becoming a different directory.
fn expand_home(path: &str, home: Option<&Path>) -> PathBuf {
    let Some(home) = home else {
        return PathBuf::from(path);
    };
    if path == "~" {
        return home.to_path_buf();
    }
    match path
        .strip_prefix("~/")
        .or_else(|| path.strip_prefix("~\\"))
    {
        Some(rest) => home.join(rest),
        None => PathBuf::from(path),
    }
}

/// codeg-mcp `task_progress` / `task_complete` access handed to the delegation
/// listener at boot. Resolves the process-global engine at CALL time — the
/// listener is constructed before the engine, and a process that never wins the
/// engine lock cleanly rejects every report.
pub struct EngineWorkTaskTools;

#[async_trait::async_trait]
impl WorkTaskToolAccess for EngineWorkTaskTools {
    async fn report_progress(&self, parent_connection_id: &str, message: &str) -> TaskReportAck {
        let Some(engine) = engine() else {
            return TaskReportAck::rejected("no task engine running in this process");
        };
        engine.record_progress(parent_connection_id, message).await
    }

    async fn complete(
        &self,
        parent_connection_id: &str,
        verdict: &str,
        summary: Option<&str>,
    ) -> TaskReportAck {
        let Some(engine) = engine() else {
            return TaskReportAck::rejected("no task engine running in this process");
        };
        engine
            .record_complete(parent_connection_id, verdict, summary)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Windows has no absolute path without a drive, and the resolver branches
    /// on `is_absolute` — so the fixtures need a prefix that makes them count
    /// as absolute on both platforms.
    #[cfg(windows)]
    const ABS_PREFIX: &str = "C:";
    #[cfg(not(windows))]
    const ABS_PREFIX: &str = "";

    /// The stderr shapes below are what git and the forges actually print. A
    /// push-back refused for being out of date used to come back advising the
    /// reader to turn on maintainer edits — a setting that, in the report that
    /// prompted this, was already on. So the two must never be confused.
    #[test]
    fn a_stale_push_back_is_not_read_as_a_permission_problem() {
        let out_of_date = "git push failed: ! [rejected]        task/57 -> feat/x \
             (fetch first)\nerror: failed to push some refs to \
             'https://github.com/owner/repo.git'\nhint: Updates were rejected because the \
             remote contains work that you do not have locally.";
        assert_eq!(classify_push_refusal(out_of_date), PushRefusal::BranchMoved);
        assert_eq!(
            classify_push_refusal("git push failed: ! [rejected] a -> b (non-fast-forward)"),
            PushRefusal::BranchMoved
        );
    }

    #[test]
    fn a_refused_fork_push_is_read_as_a_permission_problem() {
        let denied = "git push: authentication failed. Configure a GitHub account in \
             Settings → Version Control.: remote: Permission to author/repo.git denied to \
             maintainer.\nfatal: unable to access \
             'https://github.com/author/repo.git/': The requested URL returned error: 403";
        assert_eq!(classify_push_refusal(denied), PushRefusal::Permission);
        assert_eq!(
            classify_push_refusal(
                "remote: GitLab: You are not allowed to push code to \
                 protected branches on this project."
            ),
            PushRefusal::Permission
        );
        // A forge that refuses outright can also say "rejected"; permission
        // has to win, or the advice sends the reader to rebase for nothing.
        assert_eq!(
            classify_push_refusal(
                "! [remote rejected] a -> b (pre-receive hook declined)\nerror: failed to push"
            ),
            PushRefusal::Permission
        );
    }

    /// Anything unrecognised must stay `Unknown`, because `Unknown` is what
    /// prints no advice — the whole point of the split.
    #[test]
    fn an_unrecognised_push_failure_gets_no_advice() {
        assert_eq!(
            classify_push_refusal("git push failed: fatal: the remote end hung up unexpectedly"),
            PushRefusal::Unknown
        );
        assert_eq!(classify_push_refusal(""), PushRefusal::Unknown);
    }

    /// A status code has to be matched in the phrasing that carries it. Branch
    /// and repository names are part of every push error, and plenty of them
    /// are named after an issue number.
    #[test]
    fn a_number_in_a_branch_name_is_not_a_status_code() {
        let stale_on_an_issue_branch = "git push failed: ! [rejected] fix/403-page -> \
             fix/401-redirect (fetch first)\nerror: failed to push some refs to \
             'https://github.com/owner/repo-403.git'";
        assert_eq!(
            classify_push_refusal(stale_on_an_issue_branch),
            PushRefusal::BranchMoved,
            "a 403 in a ref name must not be read as a permission refusal"
        );
    }

    #[test]
    fn worktree_names_carry_ids() {
        assert_eq!(basename("/home/me/repo"), "repo");
        assert_eq!(basename("/home/me/repo/"), "repo");
        assert_eq!(
            sibling_path("/home/me/repo", "repo-task-7"),
            Path::new("/home/me")
                .join("repo-task-7")
                .to_string_lossy()
                .into_owned()
        );
        // No parent to be a sibling of: the bare name, which git resolves
        // against the repository it runs in.
        assert_eq!(sibling_path("repo", "repo-task-7"), "repo-task-7");
    }

    /// The derived directory name is joined ONTO the configured root, so it
    /// has to stay relative even for the paths that have no final component
    /// to borrow: a filesystem root, and anything ending in `..`. An absolute
    /// name would replace the configured root instead of landing under it —
    /// silently putting the worktree somewhere the user never chose.
    #[test]
    fn a_project_without_a_name_still_lands_under_the_configured_root() {
        let trees = format!("{ABS_PREFIX}/var/worktrees");
        for root in [format!("{ABS_PREFIX}/"), format!("{ABS_PREFIX}/home/me/..")] {
            let dir = format!("{}-task-7", basename(&root));
            assert!(
                !Path::new(&dir).is_absolute(),
                "the derived name must be relative, got {dir:?} for root {root:?}"
            );
            assert_eq!(
                worktree_path_in_home(&root, Some(&trees), &dir, None),
                Path::new(&trees).join(&dir).to_string_lossy().into_owned(),
                "root {root:?} must not escape the configured worktree directory"
            );
        }
    }

    /// Where a fresh task worktree lands. The default layout is load-bearing:
    /// every worktree already on disk was minted next to its project folder,
    /// so an unset (or blanked) setting has to keep producing exactly that
    /// path — the recreate-from-branch fallback looks for it by name.
    #[test]
    fn a_blank_worktree_root_keeps_worktrees_next_to_the_project() {
        let root = format!("{ABS_PREFIX}/home/me/repo");
        let expected = Path::new(&format!("{ABS_PREFIX}/home/me"))
            .join("repo-task-7")
            .to_string_lossy()
            .into_owned();
        for setting in [None, Some(""), Some("   ")] {
            assert_eq!(
                worktree_path_in_home(&root, setting, "repo-task-7", None),
                expected,
                "setting {setting:?} must not move the worktree"
            );
        }
    }

    /// A configured directory holds the worktree DIRECTORY, not the checkout
    /// itself — two tasks of the same folder have to be able to share it.
    #[test]
    fn a_configured_root_holds_one_directory_per_task() {
        let root = format!("{ABS_PREFIX}/home/me/repo");
        let trees = format!("{ABS_PREFIX}/var/worktrees");
        // Compared as paths, not strings: a separator the setting carried in
        // survives into the result — `Path::join` reuses a trailing one rather
        // than adding its own — and on Windows `/` and `\` are the same
        // separator. Only the directory the worktree lands in is pinned here,
        // never the spelling of the separators.
        let at = |name: &str| Path::new(&trees).join(name);
        let landed = |setting: &str, name: &str| {
            PathBuf::from(worktree_path_in_home(&root, Some(setting), name, None))
        };
        assert_eq!(landed(&trees, "repo-task-7"), at("repo-task-7"));
        assert_eq!(landed(&trees, "repo-task-8"), at("repo-task-8"));
        // Typed paths arrive with stray whitespace and trailing separators.
        assert_eq!(
            landed(&format!("  {trees}/  "), "repo-task-7"),
            at("repo-task-7")
        );
    }

    /// The two shorthands a typed path is expected to honour: `~` is the home
    /// directory, and a relative path hangs off the project folder. An unknown
    /// home leaves `~` alone rather than guessing a different directory.
    #[test]
    fn a_typed_root_expands_home_and_resolves_relatives() {
        let root = format!("{ABS_PREFIX}/home/me/repo");
        let home = PathBuf::from(format!("{ABS_PREFIX}/home/me"));
        assert_eq!(
            worktree_path_in_home(&root, Some("~/trees"), "repo-task-7", Some(&home)),
            home.join("trees")
                .join("repo-task-7")
                .to_string_lossy()
                .into_owned()
        );
        assert_eq!(
            worktree_path_in_home(&root, Some("~"), "repo-task-7", Some(&home)),
            home.join("repo-task-7").to_string_lossy().into_owned()
        );
        assert_eq!(
            worktree_path_in_home(&root, Some(".worktrees"), "repo-task-7", Some(&home)),
            Path::new(&root)
                .join(".worktrees")
                .join("repo-task-7")
                .to_string_lossy()
                .into_owned()
        );
        assert_eq!(
            worktree_path_in_home(&root, Some("~/trees"), "repo-task-7", None),
            Path::new(&root)
                .join("~/trees")
                .join("repo-task-7")
                .to_string_lossy()
                .into_owned(),
            "an unknown home must not silently relocate the worktree"
        );
    }

    /// Native Windows paths, where the naming and the join have to agree: a
    /// project folder whose "name" came back as the whole path (`C:\src\repo`)
    /// makes `<root>/<name>` an absolute join that REPLACES the configured
    /// root, so every setting would silently resolve back to the sibling
    /// layout. Nothing here is exotic — it is what the OS folder picker hands
    /// back on Windows.
    #[cfg(windows)]
    #[test]
    fn a_windows_project_path_still_honours_the_configured_root() {
        // Expectations are built with `Path::join` so they pin the DIRECTORY
        // the worktree lands in without also asserting separator spelling.
        let at = |dir: &str| {
            Path::new(dir)
                .join("repo-task-7")
                .to_string_lossy()
                .into_owned()
        };
        assert_eq!(basename("C:\\src\\repo"), "repo");
        assert_eq!(
            worktree_path_in_home("C:\\src\\repo", Some("D:\\worktrees"), "repo-task-7", None),
            at("D:\\worktrees"),
            "a configured root on another drive must not collapse to the sibling layout"
        );
        assert_eq!(
            worktree_path_in_home("C:\\src\\repo", Some(".worktrees"), "repo-task-7", None),
            at("C:\\src\\repo\\.worktrees")
        );
        assert_eq!(
            worktree_path_in_home("C:\\src\\repo", None, "repo-task-7", None),
            at("C:\\src"),
            "the default layout is unchanged on Windows"
        );
        assert_eq!(
            worktree_path_in_home(
                "C:\\src\\repo",
                Some("~\\trees"),
                "repo-task-7",
                Some(Path::new("C:\\Users\\me"))
            ),
            at("C:\\Users\\me\\trees")
        );
        // A UNC project folder keeps its share prefix.
        assert_eq!(
            sibling_path("\\\\server\\share\\repo", "repo-task-7"),
            at("\\\\server\\share")
        );
    }

    #[test]
    fn prompt_head_takes_the_first_text_block() {
        let blocks = vec![PromptInputBlock::Text {
            text: "  Fix the login flow and add tests.  ".to_string(),
        }];
        assert_eq!(prompt_head(&blocks), "Fix the login flow and add tests.");
        assert_eq!(prompt_head(&[]), "");
    }

    /// #649: the pump reads nothing but the conversation link to decide
    /// whether a launch continues or starts over, so a row that still points
    /// at an earlier run is dispatched as `Retry` no matter how it got back to
    /// the queue. `requeue_canceled` clears the link precisely so a task the
    /// user put back on the board comes through here as `Fresh`.
    #[test]
    fn launch_mode_follows_the_conversation_link() {
        let mut task = task_row();
        task.conversation_id = None;
        assert!(matches!(launch_mode_for(&task), LaunchMode::Fresh));

        task.conversation_id = Some(41);
        assert!(matches!(launch_mode_for(&task), LaunchMode::Retry));
    }

    /// The sweep's row-level gate: exactly the tasks whose merge button the
    /// board would show — and whose light is green — land unattended.
    #[test]
    fn auto_merge_candidate_mirrors_the_board() {
        let settings = WorkTaskFolderSettings::default();
        let mut task = task_row();
        task.status = WorkTaskStatus::Review;
        assert!(auto_merge_candidate(&task, &settings));

        // Unknown stats merge (the UI defaults to the merge button there); an
        // empty change set is the complete button's territory.
        task.files_changed = Some(3);
        assert!(auto_merge_candidate(&task, &settings));
        task.files_changed = Some(0);
        assert!(!auto_merge_candidate(&task, &settings));
        task.files_changed = None;

        // An earlier failed or refused merge waits for the user.
        task.last_error = Some("merge dispatch failed: conflict".into());
        assert!(!auto_merge_candidate(&task, &settings));
        task.last_error = None;

        // The forge red line: a task whose prompt embeds text authored by an
        // arbitrary external user (issue body) never lands unattended, no
        // matter what the folder's auto_merge says. Mutation check both ways —
        // this row is a candidate on every OTHER gate (asserted just above),
        // so flipping ONLY source_kind proves this guard is what blocks it,
        // and clearing it proves the guard doesn't leak onto normal tasks.
        task.source_kind = Some("forge_issue".into());
        assert!(
            !auto_merge_candidate(&task, &settings),
            "forge-sourced tasks must never be unattended-merge candidates"
        );
        task.source_kind = None;
        assert!(auto_merge_candidate(&task, &settings));

        // A merge the user queued belongs to the queue's own drain, with THEIR
        // commit message and worktree choice — the unattended dispatch has
        // neither, so it must not take this row (a drain that skipped it after
        // losing a race would otherwise hand it straight to the sweep).
        task.pending_merge = Some(
            serde_json::to_string(&WorkTaskQueuedMerge {
                message: Some("feat: land it".into()),
                delete_worktree: false,
                instructions: None,
                queued_at: chrono::DateTime::from_timestamp(1_800_000_000, 0).unwrap(),
            })
            .unwrap(),
        );
        assert!(!auto_merge_candidate(&task, &settings));
        // Deliberately the same predicate `begin_merge`'s auto CAS uses —
        // "anything in the column" rather than "a parseable intent". A gate
        // looser than the CAS that finally decides would dispatch into a miss
        // on every sweep; a manual merge clears the column either way.
        task.pending_merge = Some(r#"{"legacy":true}"#.into());
        assert!(!auto_merge_candidate(&task, &settings));
        task.pending_merge = None;

        // Only review is mergeable.
        task.status = WorkTaskStatus::Running;
        assert!(!auto_merge_candidate(&task, &settings));
        task.status = WorkTaskStatus::Review;

        // A configured preflight gates on a green light — absent, running and
        // red all wait. A blank custom command is no gate; a legacy id-only
        // reference is one.
        let gated = WorkTaskFolderSettings {
            preflight_command: Some("pnpm test".into()),
            ..Default::default()
        };
        assert!(!auto_merge_candidate(&task, &gated));
        for status in ["running", "failed"] {
            task.preflight =
                Some(format!(r#"{{"status":"{status}","command":"pnpm test"}}"#));
            assert!(!auto_merge_candidate(&task, &gated), "{status} light");
        }
        task.preflight = Some(r#"{"status":"passed","command":"pnpm test"}"#.into());
        assert!(auto_merge_candidate(&task, &gated));
        assert!(!preflight_configured(&WorkTaskFolderSettings {
            preflight_command: Some("  ".into()),
            ..Default::default()
        }));
        assert!(preflight_configured(&WorkTaskFolderSettings {
            preflight_command_id: Some(4),
            ..Default::default()
        }));
    }

    /// The refusal wordings that mean "lost a race" are skipped silently by
    /// the sweep; the strings live in `merge_task`, and this pin keeps the
    /// match and the wording from drifting apart.
    #[test]
    fn benign_merge_races_are_recognized() {
        assert!(is_benign_merge_race("task is not in review"));
        assert!(is_benign_merge_race(
            "task left review before the merge began"
        ));
        // The queue's own CAS miss: the row moved on (a follow-up, a stop)
        // while its queued dispatch waited for the folder lock.
        assert!(is_benign_merge_race(
            "task left review before the merge was queued"
        ));
        // A withdrawal / edit under the pump is benign too, but it is the one
        // the drain must RE-READ for instead of stepping over: the user's new
        // word may sort first, and leaving the slot to the auto sweep would
        // land it with the unattended defaults.
        let superseded = missed_queue_cas(Some(&QueuedMergeClaim {
            raw: "{}".to_string(),
            queued_at: chrono::DateTime::from_timestamp(1_800_000_000, 0).unwrap(),
        }));
        assert!(is_benign_merge_race(&superseded));
        assert!(is_queued_merge_superseded(&superseded));
        assert!(!is_queued_merge_superseded("task is not in review"));
        assert!(!is_queued_merge_superseded(&missed_queue_cas(None)));
        assert!(is_benign_merge_race(
            "another task of this project is already merging — wait for it"
        ));
        assert!(!is_benign_merge_race(
            "project folder is on 'feature', expected 'main' — switch it to 'main' to merge"
        ));
        assert!(!is_benign_merge_race(
            "the task worktree no longer exists on disk"
        ));
    }

    /// The merge queue is first-asked-first-served, with the task id breaking a
    /// tie — the same rule `mergeQueueRanks` draws on the cards, so the "第 2
    /// 位" a user reads is the order they actually land in.
    #[test]
    fn the_merge_queue_drains_oldest_request_first() {
        let intent = |secs: i64| WorkTaskQueuedMerge {
            message: None,
            delete_worktree: true,
            instructions: None,
            queued_at: chrono::DateTime::from_timestamp(1_800_000_000 + secs, 0)
                .expect("valid instant"),
        };
        let row = |id: i32| crate::db::entities::work_task::Model {
            id,
            ..task_row()
        };

        let mut queue = [
            (intent(2), row(1)),
            (intent(1), row(3)),
            // Same instant as task 3 — id decides, exactly as the client does.
            (intent(1), row(2)),
        ];
        queue.sort_by_key(|(intent, task)| queue_order(intent, task));
        assert_eq!(
            queue.iter().map(|(_, t)| t.id).collect::<Vec<_>>(),
            vec![2, 3, 1]
        );
    }

    /// Minimal task row for prompt composition (nothing here touches the DB).
    fn task_row() -> crate::db::entities::work_task::Model {
        let now = chrono::Utc::now();
        crate::db::entities::work_task::Model {
            id: 7,
            folder_id: 1,
            title: "Fix the login flow".to_string(),
            config: "{}".to_string(),
            status: WorkTaskStatus::Queued,
            failure_reason: None,
            last_error: None,
            run_seq: 1,
            sort_order: 0,
            worktree_folder_id: None,
            conversation_id: None,
            connection_id: None,
            base_branch: Some("main".to_string()),
            base_sha: None,
            work_branch: Some("task/7".to_string()),
            merge_state: None,
            pending_merge: None,
            cleanup_state: None,
            verdict: None,
            result_summary: None,
            files_changed: None,
            additions: None,
            deletions: None,
            merge_commit: None,
            completion_kind: None,
            preflight: None,
            archived_at: None,
            scheduled_at: None,
            source_kind: None,
            source_key: None,
            source_meta: None,
            created_at: now,
            updated_at: now,
            started_at: None,
            settled_at: None,
            finished_at: None,
            deleted_at: None,
        }
    }

    fn task_config() -> WorkTaskConfig {
        WorkTaskConfig {
            prompt_blocks: vec![serde_json::json!({
                "type": "text",
                "text": "Fix the login flow and add tests."
            })],
            ..Default::default()
        }
    }

    fn settings_with(pairs: &[(&str, &str)]) -> WorkTaskFolderSettings {
        WorkTaskFolderSettings {
            stage_prompts: pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            ..Default::default()
        }
    }

    fn texts(blocks: &[PromptInputBlock]) -> Vec<String> {
        blocks
            .iter()
            .filter_map(|b| match b {
                PromptInputBlock::Text { text } => Some(text.clone()),
                _ => None,
            })
            .collect()
    }

    fn merge_mode() -> LaunchMode {
        LaunchMode::Merge {
            root_path: "/repo".to_string(),
            base_branch: "main".to_string(),
            work_branch: "task/7".to_string(),
            strategy: "squash".to_string(),
            message: None,
            instructions: None,
        }
    }

    fn return_mode(intent: FollowUpIntent) -> LaunchMode {
        LaunchMode::Return {
            intent,
            feedback: "please fix the copy".to_string(),
            attachments: Vec::new(),
        }
    }

    /// Insert a task row so events have something to hang off, then compose.
    async fn seeded_task(conn: &sea_orm::DatabaseConnection) -> i32 {
        use sea_orm::{ActiveModelTrait, Set};
        let now = chrono::Utc::now();
        let row = crate::db::entities::work_task::ActiveModel {
            folder_id: Set(1),
            title: Set("Fix the login flow".to_string()),
            config: Set("{}".to_string()),
            status: Set(WorkTaskStatus::Failed),
            run_seq: Set(1),
            sort_order: Set(0),
            created_at: Set(now),
            updated_at: Set(now),
            ..Default::default()
        };
        row.insert(conn).await.expect("insert task").id
    }

    async fn user_action(conn: &sea_orm::DatabaseConnection, id: i32, payload: serde_json::Value) {
        work_task_service::record_event(conn, id, "user_action", "user", Some(payload))
            .await
            .expect("record user action");
    }

    async fn settled_into_review(conn: &sea_orm::DatabaseConnection, id: i32) {
        work_task_service::record_event(
            conn,
            id,
            "status_changed",
            "engine",
            Some(serde_json::json!({ "to": "review" })),
        )
        .await
        .expect("record settle");
    }

    /// The replay half of [`instruction_scan`], for the cases that assert on
    /// the instruction alone and not on the licence it implies.
    async fn outstanding_instruction(
        conn: &sea_orm::DatabaseConnection,
        task_id: i32,
    ) -> Option<Outstanding> {
        instruction_scan(conn, task_id).await.outstanding
    }

    /// Each scenario reframes the SAME user text — that is the whole point of
    /// having scenarios, and `revise` must stay byte-identical to the wording
    /// the action had before they existed.
    #[tokio::test]
    async fn follow_up_scenarios_reframe_the_same_feedback() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let cases = [
            (
                FollowUpIntent::Revise,
                "The user reviewed your work on this task and returned it with the following \
                 feedback. Address it in this same worktree:\n\nplease fix the copy",
            ),
            (FollowUpIntent::Continue, "accepted it as it stands"),
            (FollowUpIntent::Question, "This is a question, not a work order"),
            (FollowUpIntent::Verify, "read the full diff of this worktree"),
        ];
        for (intent, expected) in cases {
            let blocks = compose_prompt(
                &task_config(),
                &task_row(),
                &return_mode(intent),
                &WorkTaskFolderSettings::default(),
                true,
                &db.conn,
            )
            .await
            .expect("compose");
            let joined = texts(&blocks).join("\n");
            assert!(
                joined.contains(expected),
                "{}: missing its own framing in {joined}",
                intent.as_str()
            );
            assert!(
                joined.contains("please fix the copy"),
                "{}: dropped the user's text",
                intent.as_str()
            );
        }
    }

    /// The standing guard licenses committing, and it is the LAST block the
    /// agent reads — so a question turn has to replace it, not merely say
    /// "don't edit" a few blocks earlier.
    #[tokio::test]
    async fn a_question_turn_withdraws_the_licence_to_commit() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let blocks = compose_prompt(
            &task_config(),
            &task_row(),
            &return_mode(FollowUpIntent::Question),
            &WorkTaskFolderSettings::default(),
            true,
            &db.conn,
        )
        .await
        .expect("compose");
        let guard = texts(&blocks)
            .into_iter()
            .find(|t| t.starts_with("—— Work task context ——"))
            .expect("guard block");
        assert!(!guard.contains("Commit to the current branch as you like"));
        assert!(guard.contains("do NOT create, edit, delete or commit any file"));
        // The base-branch rules survive the swap.
        assert!(guard.contains("push the base branch"));

        // …and a working scenario keeps the original licence.
        let working = compose_prompt(
            &task_config(),
            &task_row(),
            &return_mode(FollowUpIntent::Revise),
            &WorkTaskFolderSettings::default(),
            true,
            &db.conn,
        )
        .await
        .expect("compose");
        assert!(texts(&working)
            .iter()
            .any(|t| t.contains("Commit to the current branch as you like")));
    }

    /// A report-deliverable task (forge plan-first / review-only)
    /// swaps the commit licence on its ORIGINAL order — otherwise the guard's
    /// "commit as you like", being the last block read, would quietly undo the
    /// task's own "analysis only" instruction.
    #[tokio::test]
    async fn a_report_deliverable_order_swaps_the_commit_licence() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let report_cfg = WorkTaskConfig {
            deliverable: Some(DELIVERABLE_REPORT.to_string()),
            ..task_config()
        };
        let guard_of = |blocks: &[PromptInputBlock]| {
            texts(blocks)
                .into_iter()
                .find(|t| t.starts_with("—— Work task context ——"))
                .expect("guard block")
        };

        let fresh = compose_prompt(
            &report_cfg,
            &task_row(),
            &LaunchMode::Fresh,
            &WorkTaskFolderSettings::default(),
            false,
            &db.conn,
        )
        .await
        .expect("compose");
        let guard = guard_of(&fresh);
        assert!(!guard.contains("Commit to the current branch as you like"));
        assert!(guard.contains("This turn delivers a report"));
        // The base-branch rules survive the swap.
        assert!(guard.contains("push the base branch"));

        // A retry with nothing outstanding re-runs that same order.
        let retry = compose_prompt(
            &report_cfg,
            &task_row(),
            &LaunchMode::Retry,
            &WorkTaskFolderSettings::default(),
            true,
            &db.conn,
        )
        .await
        .expect("compose");
        assert!(guard_of(&retry).contains("This turn delivers a report"));

        // Returned for changes, the write licence comes BACK: "now apply the
        // fix" is precisely a change order, and it is how a report task's
        // loop is meant to close.
        let returned = compose_prompt(
            &report_cfg,
            &task_row(),
            &return_mode(FollowUpIntent::Revise),
            &WorkTaskFolderSettings::default(),
            true,
            &db.conn,
        )
        .await
        .expect("compose");
        assert!(guard_of(&returned).contains("Commit to the current branch as you like"));

        // Same for a retry that stands in for an interrupted review follow-up:
        // the outstanding feedback, not the original order, is the work.
        let id = seeded_task(&db.conn).await;
        user_action(
            &db.conn,
            id,
            serde_json::json!({
                "action": "return",
                "intent": "revise",
                "feedback": "apply the fix you recommended",
            }),
        )
        .await;
        let mut row = task_row();
        row.id = id;
        let retry_review = compose_prompt(
            &report_cfg,
            &row,
            &LaunchMode::Retry,
            &WorkTaskFolderSettings::default(),
            true,
            &db.conn,
        )
        .await
        .expect("compose");
        assert!(guard_of(&retry_review).contains("Commit to the current branch as you like"));

        // An unrecognized deliverable value reads as a normal task: a config
        // written by a newer build must still launch, not change meaning.
        let odd_cfg = WorkTaskConfig {
            deliverable: Some("something-newer".to_string()),
            ..task_config()
        };
        let odd = compose_prompt(
            &odd_cfg,
            &task_row(),
            &LaunchMode::Fresh,
            &WorkTaskFolderSettings::default(),
            false,
            &db.conn,
        )
        .await
        .expect("compose");
        assert!(guard_of(&odd).contains("Commit to the current branch as you like"));
    }

    /// A retry stands in for the turn it interrupted, and a retry/requeue note
    /// refines that turn without changing its KIND — so the guard's licence
    /// follows the unsettled follow-up underneath the note, not the note.
    #[tokio::test]
    async fn a_retry_licence_follows_the_interrupted_turn_not_the_note() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let report_cfg = WorkTaskConfig {
            deliverable: Some(DELIVERABLE_REPORT.to_string()),
            ..task_config()
        };
        let guard_of = |blocks: &[PromptInputBlock]| {
            texts(blocks)
                .into_iter()
                .find(|t| t.starts_with("—— Work task context ——"))
                .expect("guard block")
        };

        // An unanswered question retried: the replay already says "do not
        // change any files for it", so the guard must withdraw the commit
        // grant as well — for every task, not only report ones.
        let questioned = seeded_task(&db.conn).await;
        user_action(
            &db.conn,
            questioned,
            serde_json::json!({
                "action": "return",
                "intent": "question",
                "feedback": "why is the cap 200?",
            }),
        )
        .await;
        let mut row = task_row();
        row.id = questioned;
        let blocks = compose_prompt(
            &task_config(),
            &row,
            &LaunchMode::Retry,
            &WorkTaskFolderSettings::default(),
            true,
            &db.conn,
        )
        .await
        .expect("compose");
        let guard = guard_of(&blocks);
        assert!(guard.contains("do NOT create, edit, delete or commit any file"));
        assert!(!guard.contains("Commit to the current branch as you like"));

        // A note layered over a failed "apply the fix" return on a report
        // task: the turn underneath is a change order, so the write licence
        // survives — while the note is still the replayed instruction.
        let returned = seeded_task(&db.conn).await;
        user_action(
            &db.conn,
            returned,
            serde_json::json!({
                "action": "return",
                "intent": "revise",
                "feedback": "apply the fix you recommended",
            }),
        )
        .await;
        user_action(
            &db.conn,
            returned,
            serde_json::json!({
                "action": "retry",
                "note": "it failed on CI, go again",
                "blocks": [],
            }),
        )
        .await;
        row.id = returned;
        let blocks = compose_prompt(
            &report_cfg,
            &row,
            &LaunchMode::Retry,
            &WorkTaskFolderSettings::default(),
            true,
            &db.conn,
        )
        .await
        .expect("compose");
        assert!(guard_of(&blocks).contains("Commit to the current branch as you like"));
        assert!(texts(&blocks).join("\n").contains("it failed on CI, go again"));

        // The same note on a run that never reached review: still the
        // original report order.
        let fresh_note = seeded_task(&db.conn).await;
        user_action(
            &db.conn,
            fresh_note,
            serde_json::json!({
                "action": "retry",
                "note": "network glitch, go again",
                "blocks": [],
            }),
        )
        .await;
        row.id = fresh_note;
        for (label, mode) in [("fresh", LaunchMode::Fresh), ("retry", LaunchMode::Retry)] {
            let blocks = compose_prompt(
                &report_cfg,
                &row,
                &mode,
                &WorkTaskFolderSettings::default(),
                true,
                &db.conn,
            )
            .await
            .expect("compose");
            assert!(
                guard_of(&blocks).contains("This turn delivers a report"),
                "restart note on the original order keeps the report licence ({label})"
            );
        }
    }

    /// The one scenario that stands alone without user text.
    #[tokio::test]
    async fn a_self_check_composes_without_any_user_text() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let blocks = compose_prompt(
            &task_config(),
            &task_row(),
            &LaunchMode::Return {
                intent: FollowUpIntent::Verify,
                feedback: String::new(),
                attachments: Vec::new(),
            },
            &WorkTaskFolderSettings::default(),
            true,
            &db.conn,
        )
        .await
        .expect("compose");
        let joined = texts(&blocks).join("\n");
        assert!(joined.contains("read the full diff of this worktree"));
        assert!(!joined.contains("What they want you to pay attention to"));
    }

    /// A retry replays what the interrupted generation still owed — and an
    /// unanswered question must not come back as a work order.
    #[tokio::test]
    async fn a_retry_replays_an_unanswered_question_as_a_question() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let id = seeded_task(&db.conn).await;
        user_action(
            &db.conn,
            id,
            serde_json::json!({
                "action": "return", "intent": "question", "feedback": "why the extra table?",
            }),
        )
        .await;

        let mut row = task_row();
        row.id = id;
        let blocks = compose_prompt(
            &task_config(),
            &row,
            &LaunchMode::Retry,
            &WorkTaskFolderSettings::default(),
            true,
            &db.conn,
        )
        .await
        .expect("compose");
        let joined = texts(&blocks).join("\n");
        assert!(joined.contains("never got an answer"));
        assert!(joined.contains("why the extra table?"));
        assert!(!joined.contains("Latest review feedback to address"));
    }

    /// The lookup is a barrier, not a filter: skipping past the newest
    /// instruction would resurrect an older one the agent already carried out.
    #[tokio::test]
    async fn a_newer_instruction_hides_an_older_one() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let id = seeded_task(&db.conn).await;
        user_action(
            &db.conn,
            id,
            serde_json::json!({
                "action": "return", "intent": "revise", "feedback": "rename the column",
            }),
        )
        .await;
        settled_into_review(&db.conn, id).await;
        user_action(
            &db.conn,
            id,
            serde_json::json!({
                "action": "return", "intent": "question", "feedback": "why the extra table?",
            }),
        )
        .await;

        let outstanding = outstanding_instruction(&db.conn, id)
            .await
            .expect("an outstanding instruction");
        assert_eq!(
            outstanding.kind,
            OutstandingKind::Review(FollowUpIntent::Question)
        );
        assert_eq!(outstanding.text, "why the extra table?");
    }

    /// A completed turn consumes the instruction it carried, so it stops being
    /// re-injected into every generation for the rest of the task's life.
    #[tokio::test]
    async fn settling_into_review_consumes_the_instruction() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let id = seeded_task(&db.conn).await;
        user_action(
            &db.conn,
            id,
            serde_json::json!({ "action": "requeue", "note": "install deps first" }),
        )
        .await;
        assert!(outstanding_instruction(&db.conn, id).await.is_some());

        settled_into_review(&db.conn, id).await;
        assert!(outstanding_instruction(&db.conn, id).await.is_none());
    }

    /// A task canceled before it ever had a session comes back through `Fresh`,
    /// so the note the user attached has to reach that arm too.
    #[tokio::test]
    async fn a_restart_note_reaches_a_fresh_launch() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let id = seeded_task(&db.conn).await;
        user_action(
            &db.conn,
            id,
            serde_json::json!({ "action": "requeue", "note": "target the v2 API this time" }),
        )
        .await;

        let mut row = task_row();
        row.id = id;
        let blocks = compose_prompt(
            &task_config(),
            &row,
            &LaunchMode::Fresh,
            &WorkTaskFolderSettings::default(),
            false,
            &db.conn,
        )
        .await
        .expect("compose");
        let joined = texts(&blocks).join("\n");
        assert!(joined.contains("target the v2 API this time"));
        assert!(joined.contains("The user restarted this task"));
        // The task's own brief still opens the prompt, so the transcript's
        // phase divider keeps matching on it.
        assert_eq!(prompt_head(&blocks), "Fix the login flow and add tests.");
        // Nothing ever ran (`started_at` is unset), so nothing warns about a
        // worktree that cannot hold an earlier run's work.
        assert!(!joined.contains("running this task again from the top"));
    }

    /// A requeue drops the session link, so the run the user put back on the
    /// board comes through `Fresh` — in the SAME worktree, carrying whatever
    /// the stopped generation left there. The prompt has to say so: read as a
    /// first run it would have the agent redo work that is already committed on
    /// the branch.
    #[tokio::test]
    async fn a_requeued_run_says_its_worktree_is_not_empty() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let id = seeded_task(&db.conn).await;

        let mut row = task_row();
        row.id = id;
        row.started_at = Some(chrono::Utc::now());
        let blocks = compose_prompt(
            &task_config(),
            &row,
            &LaunchMode::Fresh,
            &WorkTaskFolderSettings::default(),
            false,
            &db.conn,
        )
        .await
        .expect("compose");
        let joined = texts(&blocks).join("\n");
        assert!(
            joined.contains("Its worktree may still hold that run's work"),
            "a re-run must not read as a first run: {joined}"
        );
        // The brief itself still reaches the agent — the framing precedes it,
        // exactly as the retry / return arms do when their session is new.
        assert!(joined.contains("Fix the login flow and add tests."));
        // The original order is still an order: the licence stays the working
        // one (nothing was returned, so there is no follow-up underneath).
        assert!(joined.contains("Commit to the current branch as you like"));
    }

    /// #649's requeue lands on `Fresh`, and a task can be sitting on a
    /// follow-up when the user stops it: review → "rework this" → cancel →
    /// requeue. The feedback is the whole point of that generation, so the
    /// arm that replaces it must replay it — dropping it sends the agent back
    /// to the original order in a worktree where that order is already done.
    #[tokio::test]
    async fn a_requeued_run_replays_the_follow_up_it_interrupted() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let id = seeded_task(&db.conn).await;
        user_action(
            &db.conn,
            id,
            serde_json::json!({
                "action": "return",
                "intent": "revise",
                "feedback": "the empty-state copy is still wrong",
            }),
        )
        .await;
        // A requeue with neither note nor attachment records no action at all
        // (`requeue_canceled` writes one only when the user wrote something),
        // so the returned feedback is still the newest instruction.

        let mut row = task_row();
        row.id = id;
        row.started_at = Some(chrono::Utc::now());
        let blocks = compose_prompt(
            &task_config(),
            &row,
            &LaunchMode::Fresh,
            &WorkTaskFolderSettings::default(),
            false,
            &db.conn,
        )
        .await
        .expect("compose");
        let joined = texts(&blocks).join("\n");
        assert!(
            joined.contains("the empty-state copy is still wrong"),
            "the returned feedback must survive the requeue: {joined}"
        );
        assert!(joined.contains("Latest review feedback to address"));
    }

    /// And the licence follows that same turn. A question the user asked before
    /// stopping the run is still a question after the requeue: the guard's
    /// "commit as you like" is the last thing the agent reads, so it has to be
    /// withdrawn here just as the retry arm withdraws it.
    #[tokio::test]
    async fn a_requeued_question_keeps_its_read_only_licence() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let id = seeded_task(&db.conn).await;
        user_action(
            &db.conn,
            id,
            serde_json::json!({
                "action": "return",
                "intent": "question",
                "feedback": "why did you pick a map here?",
            }),
        )
        .await;

        let mut row = task_row();
        row.id = id;
        row.started_at = Some(chrono::Utc::now());
        let blocks = compose_prompt(
            &task_config(),
            &row,
            &LaunchMode::Fresh,
            &WorkTaskFolderSettings::default(),
            false,
            &db.conn,
        )
        .await
        .expect("compose");
        let guard = texts(&blocks)
            .into_iter()
            .find(|t| t.starts_with("—— Work task context ——"))
            .expect("guard block");
        assert!(!guard.contains("Commit to the current branch as you like"));
        assert!(guard.contains("do NOT create, edit, delete or commit any file"));
    }

    /// …and the note the user types INTO the requeue box must not bury it. The
    /// scan stops at the newest instruction, so a note takes the `outstanding`
    /// slot and only the returned turn's *intent* survives — fine for a resumed
    /// session, which still has the words, and useless for the session a
    /// requeue now starts, which would get a read-only licence for a question
    /// it was never shown, or "take this note into account" with no account.
    #[tokio::test]
    async fn a_requeue_note_does_not_bury_the_turn_it_refines() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let id = seeded_task(&db.conn).await;
        user_action(
            &db.conn,
            id,
            serde_json::json!({
                "action": "return",
                "intent": "question",
                "feedback": "why did you pick a map here?",
            }),
        )
        .await;
        user_action(
            &db.conn,
            id,
            serde_json::json!({ "action": "requeue", "note": "check the logs first" }),
        )
        .await;

        let mut row = task_row();
        row.id = id;
        row.started_at = Some(chrono::Utc::now());
        let blocks = compose_prompt(
            &task_config(),
            &row,
            &LaunchMode::Fresh,
            &WorkTaskFolderSettings::default(),
            false,
            &db.conn,
        )
        .await
        .expect("compose");
        let joined = texts(&blocks).join("\n");
        assert!(
            joined.contains("why did you pick a map here?"),
            "the question the note refines has to reach a context-less session: {joined}"
        );
        assert!(joined.contains("check the logs first"));
        // Oldest first: the turn, then the note that refines it.
        let question = joined.find("why did you pick a map here?").expect("question");
        let note = joined.find("check the logs first").expect("note");
        assert!(question < note, "the note refines the turn, so it follows it");
        // And it is still a question, so the licence stays read-only.
        let guard = texts(&blocks)
            .into_iter()
            .find(|t| t.starts_with("—— Work task context ——"))
            .expect("guard block");
        assert!(guard.contains("do NOT create, edit, delete or commit any file"));
    }

    /// The mirror image, and the reason the extra replay is gated on `resumed`:
    /// a session that really did resume already holds the returned turn, and
    /// replaying it a second time would re-ask a question the transcript above
    /// already shows being asked.
    #[tokio::test]
    async fn a_resumed_retry_replays_only_the_newest_instruction() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let id = seeded_task(&db.conn).await;
        user_action(
            &db.conn,
            id,
            serde_json::json!({
                "action": "return", "intent": "revise", "feedback": "rename the column",
            }),
        )
        .await;
        user_action(
            &db.conn,
            id,
            serde_json::json!({ "action": "retry", "note": "install deps first" }),
        )
        .await;

        let mut row = task_row();
        row.id = id;
        let resumed = compose_prompt(
            &task_config(),
            &row,
            &LaunchMode::Retry,
            &WorkTaskFolderSettings::default(),
            true,
            &db.conn,
        )
        .await
        .expect("compose");
        let joined = texts(&resumed).join("\n");
        assert!(joined.contains("install deps first"));
        assert!(
            !joined.contains("rename the column"),
            "the resumed transcript already carries it: {joined}"
        );

        // …while the fallback session that never resumed needs both.
        let fell_back = compose_prompt(
            &task_config(),
            &row,
            &LaunchMode::Retry,
            &WorkTaskFolderSettings::default(),
            false,
            &db.conn,
        )
        .await
        .expect("compose");
        let joined = texts(&fell_back).join("\n");
        assert!(joined.contains("rename the column"));
        assert!(joined.contains("install deps first"));
    }

    /// A screenshot pasted into the follow-up box has to reach the agent as an
    /// image block, right behind the sentence that framed it — dropping it
    /// would leave the framing pointing at nothing.
    #[tokio::test]
    async fn a_follow_up_carries_its_attachments_after_the_framing() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let blocks = compose_prompt(
            &task_config(),
            &task_row(),
            &LaunchMode::Return {
                intent: FollowUpIntent::Revise,
                feedback: "the header is wrong, see this".to_string(),
                attachments: vec![
                    serde_json::json!({
                        "type": "image", "data": "aGk=", "mime_type": "image/png", "uri": null,
                    }),
                    // A block that no longer deserializes is dropped, not fatal:
                    // one bad attachment must not stop the run carrying the rest.
                    serde_json::json!({ "type": "not_a_block" }),
                ],
            },
            &WorkTaskFolderSettings::default(),
            true,
            &db.conn,
        )
        .await
        .expect("compose");
        // The framing sentence, then the image it refers to, then the worktree
        // guard every prompt ends with.
        let framing = blocks
            .iter()
            .position(
                |b| matches!(b, PromptInputBlock::Text { text } if text.contains("the header is wrong, see this")),
            )
            .expect("the feedback is in there");
        assert!(
            matches!(
                blocks.get(framing + 1),
                Some(PromptInputBlock::Image { data, .. }) if data == "aGk="
            ),
            "the image follows the framing text, unparseable blocks aside: {blocks:?}"
        );
        assert_eq!(
            blocks
                .iter()
                .filter(|b| matches!(b, PromptInputBlock::Image { .. }))
                .count(),
            1
        );
    }

    /// The same attachments have to survive the replay path: a run interrupted
    /// before it answered owes the user the screenshot as well as the sentence.
    #[tokio::test]
    async fn an_outstanding_instruction_replays_its_attachments() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let id = seeded_task(&db.conn).await;
        user_action(
            &db.conn,
            id,
            serde_json::json!({
                "action": "retry",
                "note": "it looked like this",
                "blocks": [
                    { "type": "image", "data": "aGk=", "mime_type": "image/png", "uri": null },
                ],
            }),
        )
        .await;

        let outstanding = outstanding_instruction(&db.conn, id)
            .await
            .expect("an outstanding instruction");
        assert_eq!(outstanding.attachments.len(), 1);

        let mut row = task_row();
        row.id = id;
        let blocks = compose_prompt(
            &task_config(),
            &row,
            &LaunchMode::Retry,
            &WorkTaskFolderSettings::default(),
            true,
            &db.conn,
        )
        .await
        .expect("compose");
        assert!(
            blocks
                .iter()
                .any(|b| matches!(b, PromptInputBlock::Image { data, .. } if data == "aGk=")),
            "the replayed instruction keeps its image: {blocks:?}"
        );
    }

    /// A task's image blocks are stored, so the encoding the composer chose can
    /// be stale by the time the run happens (a slow probe then, a different
    /// agent now). Dispatch re-encodes for whoever actually answered.
    #[test]
    fn images_are_reencoded_for_the_agent_that_answered() {
        let caps = |image, embedded_context| PromptCapabilitiesInfo {
            image,
            audio: false,
            embedded_context,
        };
        let image = || PromptInputBlock::Image {
            data: "aGk=".to_string(),
            mime_type: "image/png".to_string(),
            uri: None,
        };
        let embedded = || PromptInputBlock::Resource {
            uri: "file:///shot.png".to_string(),
            mime_type: Some("image/png".to_string()),
            text: None,
            blob: Some("aGk=".to_string()),
        };

        // Native image → embedded blob for an agent that takes only the latter,
        // with a stable synthetic uri for a path-less screenshot.
        let mut blocks = vec![PromptInputBlock::Text { text: "see".into() }, image()];
        reencode_images(&mut blocks, &caps(false, true));
        assert!(
            matches!(
                &blocks[1],
                PromptInputBlock::Resource { uri, mime_type, text: None, blob: Some(b) }
                    if uri == "clipboard://work-task-image-1"
                        && mime_type.as_deref() == Some("image/png")
                        && b == "aGk="
            ),
            "{:?}",
            blocks[1]
        );
        // The prose beside it is untouched.
        assert!(matches!(&blocks[0], PromptInputBlock::Text { text } if text == "see"));

        // …and back, for an agent that takes images but not embedded context.
        let mut blocks = vec![embedded()];
        reencode_images(&mut blocks, &caps(true, false));
        assert!(
            matches!(
                &blocks[0],
                PromptInputBlock::Image { data, mime_type, uri: Some(u) }
                    if data == "aGk=" && mime_type == "image/png" && u == "file:///shot.png"
            ),
            "{:?}",
            blocks[0]
        );

        // An agent that takes both, or neither, gets exactly what was stored:
        // there is no better shape to reach for in either case.
        for c in [caps(true, true), caps(false, false)] {
            let mut blocks = vec![image(), embedded()];
            reencode_images(&mut blocks, &c);
            assert!(matches!(&blocks[0], PromptInputBlock::Image { uri: None, .. }));
            assert!(matches!(&blocks[1], PromptInputBlock::Resource { blob: Some(_), .. }));
        }

        // A non-image embedded resource (a pasted text file) is never turned
        // into an image, whatever the agent accepts.
        let mut blocks = vec![PromptInputBlock::Resource {
            uri: "clipboard://notes".to_string(),
            mime_type: Some("text/markdown".to_string()),
            text: None,
            blob: Some("aGk=".to_string()),
        }];
        reencode_images(&mut blocks, &caps(true, false));
        assert!(matches!(
            &blocks[0],
            PromptInputBlock::Resource { mime_type, .. }
                if mime_type.as_deref() == Some("text/markdown")
        ));
    }

    /// An event written before follow-ups could carry attachments has no
    /// `blocks` field at all — that has to read as "nothing was attached".
    #[tokio::test]
    async fn a_legacy_instruction_without_blocks_still_replays() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let id = seeded_task(&db.conn).await;
        user_action(
            &db.conn,
            id,
            serde_json::json!({ "action": "return", "intent": "revise", "feedback": "redo it" }),
        )
        .await;

        let outstanding = outstanding_instruction(&db.conn, id)
            .await
            .expect("an outstanding instruction");
        assert_eq!(outstanding.text, "redo it");
        assert!(outstanding.attachments.is_empty());
    }

    /// Two ways a busy task could hide its own instruction: `list_events`
    /// returns the OLDEST rows within its limit, and an agent's progress
    /// milestones are unbounded in number, so scanning raw events would bury
    /// the instruction under them.
    #[tokio::test]
    async fn a_chatty_run_cannot_bury_the_latest_instruction() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let id = seeded_task(&db.conn).await;
        user_action(
            &db.conn,
            id,
            serde_json::json!({ "action": "retry", "note": "the DB was locked" }),
        )
        .await;
        for _ in 0..520 {
            work_task_service::record_event(&db.conn, id, "agent_progress", "agent", None)
                .await
                .expect("filler event");
        }

        let outstanding = outstanding_instruction(&db.conn, id)
            .await
            .expect("found under the filler");
        assert_eq!(outstanding.kind, OutstandingKind::Restart);
        assert_eq!(outstanding.text, "the DB was locked");
    }

    /// A follow-up recorded by `claim_for_run_with_action` must be readable the
    /// moment the claim commits — a pump can launch the generation right after.
    #[tokio::test]
    async fn a_claim_carries_its_instruction_atomically() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let id = seeded_task(&db.conn).await;
        let seq = work_task_service::claim_for_run_with_action(
            &db.conn,
            id,
            WorkTaskStatus::Failed,
            "user",
            Some(serde_json::json!({ "action": "retry", "note": "install deps first" })),
            false,
        )
        .await
        .expect("claim")
        .expect("claim won");
        assert_eq!(seq, 2);

        let outstanding = outstanding_instruction(&db.conn, id)
            .await
            .expect("instruction visible right after the claim");
        assert_eq!(outstanding.text, "install deps first");

        // A LOST claim must not leave an instruction behind for some later
        // generation to pick up.
        let lost = work_task_service::claim_for_run_with_action(
            &db.conn,
            id,
            WorkTaskStatus::Failed,
            "user",
            Some(serde_json::json!({ "action": "retry", "note": "orphan" })),
            false,
        )
        .await
        .expect("claim");
        assert!(lost.is_none());
        assert_eq!(
            outstanding_instruction(&db.conn, id).await.unwrap().text,
            "install deps first"
        );
    }

    #[tokio::test]
    async fn stage_prompts_land_after_the_built_in_guard() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let settings = settings_with(&[("all", "Reply in Chinese."), ("work", "Run pnpm test.")]);
        let blocks = compose_prompt(
            &task_config(),
            &task_row(),
            &LaunchMode::Fresh,
            &settings,
            false,
            &db.conn,
        )
        .await
        .expect("compose");

        let texts = texts(&blocks);
        // …task blocks…, worktree guard, then the user's own instructions.
        assert!(texts[texts.len() - 2].starts_with("—— Work task context ——"));
        let last = texts.last().expect("trailing block");
        assert!(last.starts_with("—— Additional instructions ——"));
        // "all" first, then the stage's own text.
        let all_at = last.find("Reply in Chinese.").expect("all text");
        let work_at = last.find("Run pnpm test.").expect("stage text");
        assert!(all_at < work_at);
        // The round marker still keys off the task's own opening line, so the
        // transcript's phase dividers are unaffected.
        assert_eq!(prompt_head(&blocks), "Fix the login flow and add tests.");
    }

    #[tokio::test]
    async fn stage_prompts_select_only_their_own_stage() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let settings = settings_with(&[
            ("all", "EVERY-STAGE"),
            ("work", "WORK-ONLY"),
            ("retry", "RETRY-ONLY"),
            ("return", "RETURN-ONLY"),
            ("merge", "MERGE-ONLY"),
        ]);
        let modes = [
            (LaunchMode::Fresh, "WORK-ONLY"),
            (LaunchMode::Retry, "RETRY-ONLY"),
            (return_mode(FollowUpIntent::Revise), "RETURN-ONLY"),
            // Every scenario shares the `return` stage, so the settings dialog
            // stays four stages wide however many scenarios exist.
            (return_mode(FollowUpIntent::Continue), "RETURN-ONLY"),
            (return_mode(FollowUpIntent::Question), "RETURN-ONLY"),
            (return_mode(FollowUpIntent::Verify), "RETURN-ONLY"),
            (merge_mode(), "MERGE-ONLY"),
        ];
        for (mode, expected) in modes {
            let blocks = compose_prompt(
                &task_config(),
                &task_row(),
                &mode,
                &settings,
                false,
                &db.conn,
            )
            .await
            .expect("compose");
            let joined = texts(&blocks).join("\n");
            assert!(joined.contains("EVERY-STAGE"), "{expected}: missing all-stage text");
            assert!(joined.contains(expected), "{expected}: missing own text");
            for other in ["WORK-ONLY", "RETRY-ONLY", "RETURN-ONLY", "MERGE-ONLY"] {
                if other != expected {
                    assert!(!joined.contains(other), "{expected}: leaked {other}");
                }
            }
        }
    }

    #[tokio::test]
    async fn merge_stage_keeps_its_extra_without_the_guard() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let settings = settings_with(&[("merge", "Write the commit message in Chinese.")]);
        let blocks = compose_prompt(
            &task_config(),
            &task_row(),
            &merge_mode(),
            &settings,
            true,
            &db.conn,
        )
        .await
        .expect("compose");

        let texts = texts(&blocks);
        // The merge generation replaces the guard (it forbids exactly what a
        // merge must do) — the user's extra still trails it.
        assert!(texts.iter().all(|t| !t.starts_with("—— Work task context ——")));
        assert!(texts[0].contains("land it onto the base branch"));
        assert!(texts
            .last()
            .expect("trailing block")
            .contains("Write the commit message in Chinese."));
    }

    /// What the user typed in the merge dialog has to reach the agent — and has
    /// to land BEFORE the closing rules, which are what keep "also do X" from
    /// being read as licence to push or to delete the worktree.
    #[tokio::test]
    async fn merge_prompt_carries_the_users_instructions_ahead_of_the_rules() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let LaunchMode::Merge {
            root_path,
            base_branch,
            work_branch,
            strategy,
            message,
            ..
        } = merge_mode()
        else {
            unreachable!("merge_mode is a merge")
        };
        let mode = LaunchMode::Merge {
            root_path,
            base_branch,
            work_branch,
            strategy,
            message,
            instructions: Some("Prefer this branch's side on any conflict.".to_string()),
        };
        let blocks = compose_prompt(
            &task_config(),
            &task_row(),
            &mode,
            &WorkTaskFolderSettings::default(),
            true,
            &db.conn,
        )
        .await
        .expect("compose");

        let recipe = &texts(&blocks)[0];
        let said = recipe
            .find("Prefer this branch's side on any conflict.")
            .expect("the user's own words reach the agent");
        let rules = recipe.find("Do NOT push").expect("the closing rules");
        assert!(
            said < rules,
            "the rules must stay last — they are what an over-eager reading of \
             the user's request would otherwise override"
        );
    }

    /// …and an empty box adds nothing: no dangling header, no stray blank
    /// section between the numbered steps and the rules.
    #[tokio::test]
    async fn merge_prompt_says_nothing_when_there_are_no_instructions() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let blocks = compose_prompt(
            &task_config(),
            &task_row(),
            &merge_mode(), // `instructions: None`
            &WorkTaskFolderSettings::default(),
            true,
            &db.conn,
        )
        .await
        .expect("compose");

        let recipe = &texts(&blocks)[0];
        assert!(
            !recipe.contains("instructions from the user"),
            "no header without a body"
        );
        assert!(recipe.contains("land it onto the base branch"));
    }

    #[tokio::test]
    async fn blank_stage_prompts_add_nothing() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let bare = compose_prompt(
            &task_config(),
            &task_row(),
            &LaunchMode::Fresh,
            &WorkTaskFolderSettings::default(),
            false,
            &db.conn,
        )
        .await
        .expect("compose");
        let blank = compose_prompt(
            &task_config(),
            &task_row(),
            &LaunchMode::Fresh,
            &settings_with(&[("all", "  \n "), ("work", "")]),
            false,
            &db.conn,
        )
        .await
        .expect("compose");
        assert_eq!(texts(&bare), texts(&blank));
    }

    /// The worktree is off disk; everything below is what the clients see.
    /// Without the `folder://changed` delete the removed worktree keeps
    /// rendering in every sidebar until the next full `fetchFolders`.
    #[tokio::test]
    async fn worktree_removal_announces_the_dropped_folder() {
        use crate::db::test_helpers::{fresh_in_memory_db, seed_folder};
        use crate::web::event_bridge::WebEventBroadcaster;

        let db = fresh_in_memory_db().await;
        let root_id = seed_folder(&db, "/tmp/repo").await;
        let wt = open_worktree_folder_core(&db, "/tmp/repo-task-1".to_string(), root_id)
            .await
            .expect("worktree folder");
        let conv = conversation_service::create(&db.conn, wt.id, AgentType::ClaudeCode, None, None)
            .await
            .expect("conversation");
        let task = work_task_service::create(
            &db.conn,
            crate::models::WorkTaskDraft {
                folder_id: root_id,
                title: "fix login".to_string(),
                config: serde_json::json!({
                    "display_text": "fix login",
                    "prompt_blocks": [{ "type": "text", "text": "fix login" }],
                }),
            },
        )
        .await
        .expect("task");
        work_task_service::attach_worktree(&db.conn, task.id, wt.id, "main", "abc", "task/1")
            .await
            .expect("attach");

        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let mut rx = broadcaster.subscribe();
        let emitter = EventEmitter::test_web_only(broadcaster.clone());

        converge_worktree_removal(&db, &emitter, task.id, wt.id, root_id, &wt.path).await;

        // The folder row is gone from every list a client can fetch…
        assert!(
            crate::db::service::folder_service::get_folder_by_id(&db.conn, wt.id)
                .await
                .expect("lookup")
                .is_none()
        );
        // …its conversation moved to the project folder (stamped with where it ran)…
        let moved = conversation_service::get_by_id(&db.conn, conv.id)
            .await
            .expect("conversation row");
        assert_eq!(moved.folder_id, root_id);
        assert_eq!(moved.origin_cwd.as_deref(), Some("/tmp/repo-task-1"));
        // …and the task no longer points at it.
        let after = work_task_service::get_model(&db.conn, task.id)
            .await
            .expect("task row");
        assert_eq!(after.worktree_folder_id, None);

        // Conversations first (that refetch is what re-places the moved rows),
        // then the folder drop.
        let bulk = rx.try_recv().expect("bulk change should broadcast");
        assert_eq!(
            bulk.channel,
            crate::web::event_bridge::CONVERSATIONS_BULK_CHANGED_EVENT
        );
        let dropped = rx.try_recv().expect("folder delete should broadcast");
        assert_eq!(
            dropped.channel,
            crate::web::event_bridge::FOLDER_CHANGED_EVENT
        );
        assert_eq!(dropped.payload["kind"], "deleted");
        assert_eq!(dropped.payload["id"], wt.id);
    }

    /// A retried cleanup finds the row already soft-deleted. It must still
    /// announce the drop — a client that missed the first broadcast is the
    /// reason the user retried.
    #[tokio::test]
    async fn worktree_removal_re_announces_an_already_deleted_folder() {
        use crate::db::test_helpers::{fresh_in_memory_db, seed_folder};
        use crate::web::event_bridge::WebEventBroadcaster;

        let db = fresh_in_memory_db().await;
        let root_id = seed_folder(&db, "/tmp/repo2").await;
        let task = work_task_service::create(
            &db.conn,
            crate::models::WorkTaskDraft {
                folder_id: root_id,
                title: "fix login".to_string(),
                config: serde_json::json!({
                    "display_text": "fix login",
                    "prompt_blocks": [{ "type": "text", "text": "fix login" }],
                }),
            },
        )
        .await
        .expect("task");

        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let mut rx = broadcaster.subscribe();
        let emitter = EventEmitter::test_web_only(broadcaster.clone());

        // Folder id 9999 never existed — the "already gone" branch.
        converge_worktree_removal(&db, &emitter, task.id, 9999, root_id, "/tmp/repo2-task-1").await;

        let _bulk = rx.try_recv().expect("bulk change should broadcast");
        let dropped = rx.try_recv().expect("folder delete should broadcast");
        assert_eq!(dropped.payload["kind"], "deleted");
        assert_eq!(dropped.payload["id"], 9999);
    }

    #[test]
    fn engine_lock_is_per_data_dir() {
        let dir = tempfile::tempdir().expect("temp dir");
        let guard = match acquire_engine_ownership(dir.path()) {
            Ownership::Exclusive(f) => f,
            _ => panic!("first acquisition should win"),
        };
        assert!(matches!(
            acquire_engine_ownership(dir.path()),
            Ownership::Taken
        ));
        // Independent of the automation engine's lock file in the same dir.
        let automation_lock = dir
            .path()
            .join(format!("{}.lock", crate::db::database_file_name()));
        assert!(!automation_lock.exists());
        drop(guard);
    }

    // -- blocking prompts raised by a delegation sub-agent (#447) -----------

    const PARENT_CONN: &str = "conn-task";
    const CHILD_CONN: &str = "conn-child";

    /// A task driven to `running` on `PARENT_CONN`, with the engine's live
    /// index seeded as the launch path would. Returns `(engine, task_id)`.
    async fn running_task() -> (Arc<TaskEngine>, i32) {
        use crate::db::test_helpers::{fresh_in_memory_db, seed_folder};

        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, "/tmp/task-deleg").await;
        let conv =
            conversation_service::create(&db.conn, folder_id, AgentType::ClaudeCode, None, None)
                .await
                .expect("conversation");
        let task = work_task_service::create(
            &db.conn,
            crate::models::WorkTaskDraft {
                folder_id,
                title: "fix login".to_string(),
                config: serde_json::json!({
                    "display_text": "fix login",
                    "prompt_blocks": [{ "type": "text", "text": "fix login" }],
                }),
            },
        )
        .await
        .expect("task");
        // Walk the real transition chain rather than writing the row directly,
        // so the run_seq the engine flips against is the one the CAS minted.
        let run_seq = work_task_service::claim_for_run(
            &db.conn,
            task.id,
            WorkTaskStatus::Todo,
            "test",
        )
        .await
        .expect("claim")
        .expect("claimed");
        assert!(work_task_service::begin_setup(&db.conn, task.id, run_seq)
            .await
            .expect("begin_setup"));
        assert!(
            work_task_service::mark_running(&db.conn, task.id, run_seq, conv.id, PARENT_CONN)
                .await
                .expect("mark_running")
        );

        let engine = test_engine(db);
        engine
            .index
            .lock()
            .await
            .insert(PARENT_CONN.into(), (task.id, run_seq));
        (engine, task.id)
    }

    async fn status_of(engine: &TaskEngine, task_id: i32) -> WorkTaskStatus {
        work_task_service::get_model(&engine.db.conn, task_id)
            .await
            .expect("task row")
            .status
    }

    #[tokio::test]
    async fn a_late_cancelled_event_does_not_cancel_a_task_in_review() {
        let (engine, task_id) = running_task().await;
        let run_seq = work_task_service::get_model(&engine.db.conn, task_id)
            .await
            .expect("task row")
            .run_seq;
        assert!(work_task_service::settle_review(
            &engine.db.conn,
            task_id,
            run_seq,
            None,
            None,
        )
        .await
        .expect("settle review"));

        engine.on_turn_complete(PARENT_CONN, "cancelled").await;

        assert_eq!(status_of(&engine, task_id).await, WorkTaskStatus::Review);
    }

    #[tokio::test]
    async fn a_current_cancelled_event_cancels_the_running_task() {
        let (engine, task_id) = running_task().await;

        engine.on_turn_complete(PARENT_CONN, "cancelled").await;

        assert_eq!(status_of(&engine, task_id).await, WorkTaskStatus::Canceled);
    }

    /// The other half of the CAS: the status alone would let a stale
    /// connection's cancel land on the RUN AFTER it, which is `running` again
    /// and so passes the status gate. Only `run_seq` tells the two apart.
    #[tokio::test]
    async fn a_previous_generation_cancelled_event_spares_the_current_run() {
        let (engine, task_id) = running_task().await;
        let row = work_task_service::get_model(&engine.db.conn, task_id)
            .await
            .expect("task row");
        let (stale_seq, conv_id) = (row.run_seq, row.conversation_id.expect("conversation"));
        // Walk the real chain into the next generation: settle, requeue, run.
        assert!(work_task_service::settle_review(
            &engine.db.conn,
            task_id,
            stale_seq,
            None,
            None,
        )
        .await
        .expect("settle review"));
        let next_seq = work_task_service::claim_for_run(
            &engine.db.conn,
            task_id,
            WorkTaskStatus::Review,
            "test",
        )
        .await
        .expect("claim")
        .expect("claimed");
        assert_ne!(next_seq, stale_seq);
        assert!(work_task_service::begin_setup(&engine.db.conn, task_id, next_seq)
            .await
            .expect("begin_setup"));
        assert!(work_task_service::mark_running(
            &engine.db.conn,
            task_id,
            next_seq,
            conv_id,
            "conn-next",
        )
        .await
        .expect("mark_running"));

        // The old connection's cancel finally arrives.
        engine.on_turn_complete(PARENT_CONN, "cancelled").await;

        assert_eq!(status_of(&engine, task_id).await, WorkTaskStatus::Running);
    }

    /// Walk the row on to a fresh generation running on `conn_id`, WITHOUT
    /// retiring the previous one's `index` entry — the state a delayed
    /// `TurnComplete` from the old connection lands in. Returns the new run_seq.
    async fn relaunch_on(engine: &TaskEngine, task_id: i32, conn_id: &str) -> i32 {
        let row = work_task_service::get_model(&engine.db.conn, task_id)
            .await
            .expect("task row");
        let conv_id = row.conversation_id.expect("conversation");

        assert!(work_task_service::settle_review(
            &engine.db.conn,
            task_id,
            row.run_seq,
            None,
            None,
        )
        .await
        .expect("settle review"));
        let next_seq = work_task_service::claim_for_run(
            &engine.db.conn,
            task_id,
            WorkTaskStatus::Review,
            "test",
        )
        .await
        .expect("claim")
        .expect("claimed");
        assert!(work_task_service::begin_setup(&engine.db.conn, task_id, next_seq)
            .await
            .expect("begin_setup"));
        assert!(work_task_service::mark_running(
            &engine.db.conn,
            task_id,
            next_seq,
            conv_id,
            conn_id,
        )
        .await
        .expect("mark_running"));
        engine
            .index
            .lock()
            .await
            .insert(conn_id.into(), (task_id, next_seq));
        next_seq
    }

    #[tokio::test]
    async fn a_previous_generation_cancel_does_not_clear_current_waits() {
        let (engine, task_id) = running_task().await;
        relaunch_on(&engine, task_id, "conn-next").await;

        engine
            .track_request("conn-next", "permission-a".into(), true)
            .await;
        engine
            .track_request("conn-next", "permission-b".into(), true)
            .await;
        assert_eq!(
            status_of(&engine, task_id).await,
            WorkTaskStatus::AwaitingInput
        );

        engine.on_turn_complete(PARENT_CONN, "cancelled").await;
        engine
            .track_request("conn-next", "permission-a".into(), false)
            .await;

        assert_eq!(
            status_of(&engine, task_id).await,
            WorkTaskStatus::AwaitingInput,
            "the second request in the current generation is still outstanding"
        );

        engine
            .track_request("conn-next", "permission-b".into(), false)
            .await;
        assert_eq!(status_of(&engine, task_id).await, WorkTaskStatus::Running);
    }

    /// The mirror image of the case above, and the half sparing the set opens:
    /// a retired run's DELEGATION children are namespaced by connection id, so
    /// keeping the task's set keeps THEIR keys too — with nothing left that
    /// could ever answer them, because the same retirement just unmapped the
    /// chain (`track_request` and `forget_delegation_child` both resolve a
    /// detached child to nothing). One orphan pins the set non-empty until a
    /// wholesale clear comes along — a later retirement that IS the last one
    /// out, or a cancel — and until then every generation's first request
    /// misses the `len() == 1` edge: the board says `running` for a run parked
    /// on the user, which is bug #447 all over again. Unlike the transient
    /// over-clear, answering the request is not what gets you out of it.
    #[tokio::test]
    async fn retiring_a_run_takes_its_orphaned_delegation_requests_with_it() {
        let (engine, task_id) = running_task().await;
        engine
            .on_event(&delegation_started(PARENT_CONN, CHILD_CONN))
            .await;
        engine.on_event(&permission_request(CHILD_CONN, "r1")).await;
        assert_eq!(
            status_of(&engine, task_id).await,
            WorkTaskStatus::AwaitingInput
        );

        relaunch_on(&engine, task_id, "conn-next").await;
        engine.on_turn_complete(PARENT_CONN, "cancelled").await;

        assert!(
            engine.awaiting.lock().await.get(&task_id).is_none(),
            "a child's key cannot outlive the delegation chain that named it"
        );

        // ...and the surviving generation's own edge still swings both ways.
        engine
            .track_request("conn-next", "p:r9".into(), true)
            .await;
        assert_eq!(
            status_of(&engine, task_id).await,
            WorkTaskStatus::AwaitingInput
        );
        engine
            .track_request("conn-next", "p:r9".into(), false)
            .await;
        assert_eq!(status_of(&engine, task_id).await, WorkTaskStatus::Running);
    }

    fn env(conn_id: &str, payload: AcpEvent) -> EventEnvelope {
        EventEnvelope {
            seq: 0,
            connection_id: conn_id.to_string(),
            payload,
        }
    }

    fn delegation_started(parent: &str, child: &str) -> EventEnvelope {
        env(
            parent,
            AcpEvent::DelegationStarted {
                parent_connection_id: parent.into(),
                parent_tool_use_id: "tu-1".into(),
                child_connection_id: child.into(),
                child_conversation_id: 1,
                agent_type: AgentType::Codex,
                task_preview: "run the tests".into(),
                task_id: "task-1".into(),
            },
        )
    }

    fn delegation_completed(parent: &str, child: &str) -> EventEnvelope {
        env(
            parent,
            AcpEvent::DelegationCompleted {
                parent_connection_id: parent.into(),
                parent_tool_use_id: "tu-1".into(),
                child_connection_id: child.into(),
                child_conversation_id: 1,
                agent_type: AgentType::Codex,
                result: crate::acp::types::DelegationResultSummary::Ok {
                    duration_ms: 0,
                    text_preview: None,
                },
            },
        )
    }

    fn permission_request(conn: &str, request_id: &str) -> EventEnvelope {
        env(
            conn,
            AcpEvent::PermissionRequest {
                request_id: request_id.into(),
                tool_call: serde_json::json!({}),
                options: vec![],
                queued: 0,
            },
        )
    }

    #[tokio::test]
    async fn a_delegated_child_permission_flips_the_task_to_awaiting_input() {
        // #447: the prompt arrives on the CHILD's connection, which is not in
        // `index`. Before the parent lookup existed it was dropped outright and
        // the board kept saying "running" for a run that was parked on the user.
        let (engine, task_id) = running_task().await;
        engine.on_event(&delegation_started(PARENT_CONN, CHILD_CONN)).await;
        engine.on_event(&permission_request(CHILD_CONN, "r1")).await;

        assert_eq!(status_of(&engine, task_id).await, WorkTaskStatus::AwaitingInput);

        engine
            .on_event(&env(
                CHILD_CONN,
                AcpEvent::PermissionResolved {
                    request_id: "r1".into(),
                },
            ))
            .await;
        assert_eq!(status_of(&engine, task_id).await, WorkTaskStatus::Running);
    }

    #[tokio::test]
    async fn a_child_torn_down_mid_permission_does_not_wedge_awaiting_input() {
        // The failure this guards: a sub-agent cancelled/crashed while its
        // permission was still pending leaves a key nothing can ever resolve,
        // pinning the row at awaiting_input for the rest of the run.
        let (engine, task_id) = running_task().await;
        engine.on_event(&delegation_started(PARENT_CONN, CHILD_CONN)).await;
        engine.on_event(&permission_request(CHILD_CONN, "r1")).await;
        assert_eq!(status_of(&engine, task_id).await, WorkTaskStatus::AwaitingInput);

        engine.on_event(&delegation_completed(PARENT_CONN, CHILD_CONN)).await;
        assert_eq!(
            status_of(&engine, task_id).await,
            WorkTaskStatus::Running,
            "an unanswerable request must not outlive its sub-agent"
        );
        assert!(engine.delegation_parents.lock().await.is_empty());
    }

    #[tokio::test]
    async fn a_child_permission_does_not_clear_the_parents_own_block() {
        // Both connections' keys live in one set, so they must be independently
        // namespaced — otherwise resolving one would flip the row back while
        // the other is still waiting.
        let (engine, task_id) = running_task().await;
        engine.on_event(&delegation_started(PARENT_CONN, CHILD_CONN)).await;
        engine.on_event(&permission_request(PARENT_CONN, "r1")).await;
        // Same request_id on the child: a plausible collision, since the two
        // agents mint ids independently.
        engine.on_event(&permission_request(CHILD_CONN, "r1")).await;

        engine
            .on_event(&env(
                CHILD_CONN,
                AcpEvent::PermissionResolved {
                    request_id: "r1".into(),
                },
            ))
            .await;
        assert_eq!(
            status_of(&engine, task_id).await,
            WorkTaskStatus::AwaitingInput,
            "the parent's own permission is still outstanding"
        );

        engine
            .on_event(&env(
                PARENT_CONN,
                AcpEvent::PermissionResolved {
                    request_id: "r1".into(),
                },
            ))
            .await;
        assert_eq!(status_of(&engine, task_id).await, WorkTaskStatus::Running);
    }

    #[tokio::test]
    async fn a_permission_racing_ahead_of_delegation_started_is_recovered() {
        // The broker starts the child's turn BEFORE announcing the delegation
        // (`send_prompt_linked_for_delegation` precedes `emit_started_if_real`),
        // so a child that blocks immediately raises its prompt while the engine
        // still has no mapping for it — and drops it. Without the backfill the
        // board sits at `running` for a run already parked on the user, which is
        // the very bug #447 is about.
        use crate::acp::session_state::PendingPermissionState;
        use crate::models::agent::AgentType;
        use crate::web::event_bridge::EventEmitter;

        let (engine, task_id) = running_task().await;
        engine
            .manager
            .insert_test_connection(CHILD_CONN, AgentType::Codex, None, EventEmitter::Noop)
            .await;

        // Permission arrives first and is dropped (no mapping yet).
        engine.on_event(&permission_request(CHILD_CONN, "r1")).await;
        assert_eq!(status_of(&engine, task_id).await, WorkTaskStatus::Running);

        // The child's live state carries it regardless — that is what the
        // backfill reads when the announcement finally lands.
        {
            let state = engine.manager.get_state(CHILD_CONN).await.expect("state");
            let mut s = state.write().await;
            s.pending_permission = Some(PendingPermissionState {
                request_id: "r1".into(),
                tool_call_id: "tc-1".into(),
                tool_call: serde_json::json!({}),
                options: vec![],
                created_at: chrono::Utc::now(),
                queued: 0,
            });
        }
        engine.on_event(&delegation_started(PARENT_CONN, CHILD_CONN)).await;
        assert_eq!(
            status_of(&engine, task_id).await,
            WorkTaskStatus::AwaitingInput
        );

        // The recovered key matches what a normal resolve retracts — otherwise
        // the row would wedge at awaiting_input.
        engine
            .on_event(&env(
                CHILD_CONN,
                AcpEvent::PermissionResolved {
                    request_id: "r1".into(),
                },
            ))
            .await;
        assert_eq!(status_of(&engine, task_id).await, WorkTaskStatus::Running);
    }

    #[tokio::test]
    async fn a_nested_delegation_child_still_maps_to_the_run() {
        // A sub-agent that delegates further blocks the task just as much, so
        // the grandchild has to resolve through the chain rather than requiring
        // its parent to be the run's own connection.
        let (engine, task_id) = running_task().await;
        engine.on_event(&delegation_started(PARENT_CONN, CHILD_CONN)).await;
        engine.on_event(&delegation_started(CHILD_CONN, "conn-grandchild")).await;

        engine
            .on_event(&permission_request("conn-grandchild", "r1"))
            .await;
        assert_eq!(
            status_of(&engine, task_id).await,
            WorkTaskStatus::AwaitingInput
        );
    }

    #[tokio::test]
    async fn completing_a_child_retracts_its_whole_subtree() {
        // The middle child finishing takes its own delegations down with it, so
        // a grandchild's unanswered prompt must be retracted too — otherwise
        // the row wedges at awaiting_input on a key nothing can resolve, and
        // the grandchild's mapping is stranded in the map forever.
        let (engine, task_id) = running_task().await;
        engine.on_event(&delegation_started(PARENT_CONN, CHILD_CONN)).await;
        engine.on_event(&delegation_started(CHILD_CONN, "conn-grandchild")).await;
        engine
            .on_event(&permission_request("conn-grandchild", "r1"))
            .await;
        assert_eq!(
            status_of(&engine, task_id).await,
            WorkTaskStatus::AwaitingInput
        );

        engine.on_event(&delegation_completed(PARENT_CONN, CHILD_CONN)).await;
        assert_eq!(status_of(&engine, task_id).await, WorkTaskStatus::Running);
        assert!(
            engine.delegation_parents.lock().await.is_empty(),
            "the grandchild's mapping must not be stranded"
        );
    }

    // ── delivery (push + pull request) ──────────────────────────────────

    /// Forge write path under test control: no network, no keyring, and every
    /// step independently failable so each failure point can be exercised.
    #[derive(Default)]
    struct FakeForge {
        /// `(repository, work branch, remote branch)` of every push.
        pushes: Mutex<Vec<(String, String, String)>>,
        created: Mutex<Vec<(String, String, String, bool)>>,
        existing: Mutex<Vec<ForgePr>>,
        /// What the source repository's base branch points at. The fixture
        /// seeds it with the task's own base, i.e. "nothing unpushed".
        remote_base: Mutex<Option<String>>,
        /// `(issue number, comment body)` of every write-back attempt.
        comments: Mutex<Vec<(ForgeItemKind, i64, String)>>,
        push_error: Option<String>,
        find_error: Option<String>,
        create_error: Option<String>,
        comment_error: Option<String>,
        get_pull_error: Option<String>,
        /// What the pull request looks like once the push has happened — how
        /// a test says "someone closed / retargeted / merged it while codeg
        /// was pushing", which is the whole window the settle check guards.
        after_push: Mutex<Option<ForgePr>>,
        /// A file dropped into the worktree the moment the push runs. Opens
        /// the other window of the same kind: the worktree was clean when
        /// `deliver_pr` checked it and is dirty by the time the post-delivery
        /// cleanup would run `worktree remove --force` over it.
        dirty_on_push: Option<String>,
        /// A file COMMITTED onto the work branch the moment the push runs —
        /// the half `dirty_on_push` cannot reach. `git status` stays spotless,
        /// so only a check against the OID the delivery actually published can
        /// tell that the branch has outrun it.
        commit_on_push: Option<String>,
    }

    #[async_trait::async_trait]
    impl ForgeDeliveryApi for FakeForge {
        async fn push_branch(
            &self,
            _ctx: &DeliveryCtx<'_>,
            worktree_path: &str,
            repo: &str,
            work_branch: &str,
            remote_branch: &str,
        ) -> Result<(), String> {
            if let Some(e) = &self.push_error {
                return Err(e.clone());
            }
            if let Some(name) = &self.dirty_on_push {
                std::fs::write(std::path::Path::new(worktree_path).join(name), "scratch\n")
                    .expect("write");
            }
            if let Some(name) = &self.commit_on_push {
                let dir = std::path::Path::new(worktree_path);
                std::fs::write(dir.join(name), "landed after the push\n").expect("write");
                git_run(dir, &["add", "-A"]);
                git_run(dir, &["commit", "-qm", "never published"]);
            }
            self.pushes.lock().await.push((
                repo.to_string(),
                work_branch.to_string(),
                remote_branch.to_string(),
            ));
            if let Some(changed) = self.after_push.lock().await.clone() {
                *self.existing.lock().await = vec![changed];
            }
            Ok(())
        }

        async fn find_pulls(
            &self,
            _ctx: &DeliveryCtx<'_>,
            _head_branch: &str,
        ) -> Result<Vec<ForgePr>, String> {
            if let Some(e) = &self.find_error {
                return Err(e.clone());
            }
            Ok(self.existing.lock().await.clone())
        }

        async fn remote_base_tip(
            &self,
            _ctx: &DeliveryCtx<'_>,
            _worktree_path: &str,
            _base_branch: &str,
        ) -> Option<String> {
            self.remote_base.lock().await.clone()
        }

        /// The fixtures' "remote" is a local path on `origin`, so the fake
        /// fetches through it — what production adds on top is the pinned
        /// account's credentials and an explicit URL, neither of which a
        /// temporary directory has any use for.
        async fn fetch_ref(
            &self,
            _ctx: &DeliveryCtx<'_>,
            repo_path: &str,
            remote_ref: &str,
            local_ref: &str,
        ) -> Result<String, String> {
            task_git::fetch_into_ref(repo_path, "origin", remote_ref, local_ref)
                .await
                .map_err(|e| e.to_string())
        }

        async fn get_pull(&self, _ctx: &DeliveryCtx<'_>, number: i64) -> Result<ForgePr, String> {
            if let Some(e) = &self.get_pull_error {
                return Err(e.clone());
            }
            self.existing
                .lock()
                .await
                .iter()
                .find(|pr| pr.number == number)
                .cloned()
                .ok_or_else(|| format!("pull request #{number} not found"))
        }

        async fn comment_issue(
            &self,
            _ctx: &DeliveryCtx<'_>,
            kind: ForgeItemKind,
            number: i64,
            body: &str,
        ) -> Result<String, String> {
            if let Some(e) = &self.comment_error {
                return Err(e.clone());
            }
            self.comments.lock().await.push((kind, number, body.to_string()));
            Ok(format!("https://github.test/acme/app/issues/{number}#issuecomment-1"))
        }

        async fn create_pull(
            &self,
            _ctx: &DeliveryCtx<'_>,
            req: &NewPullRequest<'_>,
        ) -> Result<ForgePr, String> {
            if let Some(e) = &self.create_error {
                return Err(e.clone());
            }
            self.created.lock().await.push((
                req.title.to_string(),
                req.head.to_string(),
                req.base.to_string(),
                req.draft,
            ));
            Ok(ForgePr {
                number: 42,
                html_url: "https://github.test/acme/app/pull/42".to_string(),
                state: "open".to_string(),
                merged: false,
                head_sha: "unused-by-the-fake".to_string(),
                head_ref: req.head.to_string(),
                head_repo: "acme/app".to_string(),
                base_ref: req.base.to_string(),
            })
        }
    }

    fn git_run(dir: &std::path::Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .output()
            .expect("spawn git");
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        // A fixture repository must not translate line endings, whoever's git
        // opens it. The env above neuters the global and system config for the
        // commands THIS helper runs — but the engine's git, spawned through
        // `crate::process`, inherits the real environment, and Git for Windows
        // ships `core.autocrlf=true` in its system config. The two then disagree
        // about one worktree: the engine checks a file out as CRLF while a
        // `git add` here stores those bytes verbatim, so a file nobody touched
        // reads as rewritten, and a diff measured from a commit credits the task
        // with work it never did. Repo-LOCAL config is the one layer both sides
        // read.
        match args.first() {
            // `init` runs with the repository as its cwd; `clone` names the
            // destination last.
            Some(&"init") => git_run(dir, &["config", "core.autocrlf", "false"]),
            Some(&"clone") => {
                let dest = std::path::PathBuf::from(args.last().expect("clone destination"));
                git_run(&dest, &["config", "core.autocrlf", "false"]);
            }
            _ => {}
        }
    }

    struct Delivery {
        engine: Arc<TaskEngine>,
        forge: Arc<FakeForge>,
        /// Everything the engine broadcast, in order — the ordering tests read
        /// it, and holding it also keeps the sender from reporting no
        /// receivers for every other test on this fixture.
        events: tokio::sync::broadcast::Receiver<crate::web::event_bridge::WebEvent>,
        task_id: i32,
        head: String,
        /// The commit the task branched from — a real commit that is NOT a
        /// descendant of `head`, which is what a "merged something else" test
        /// needs to be about.
        base_sha: String,
        worktree: std::path::PathBuf,
        root: std::path::PathBuf,
        _root: tempfile::TempDir,
    }

    /// A real repository with a real task worktree holding one committed
    /// change, plus the board row that describes it — the exact state a task
    /// is in when its review column offers "deliver".
    async fn delivery_fixture(forge: FakeForge) -> Delivery {
        use sea_orm::{ActiveModelTrait, Set};

        let root = tempfile::tempdir().expect("tempdir");
        let root_path = root.path().to_path_buf();
        git_run(&root_path, &["init", "-q", "-b", "main"]);
        std::fs::write(root_path.join("a.txt"), "one\n").expect("write");
        git_run(&root_path, &["add", "-A"]);
        git_run(&root_path, &["commit", "-q", "-m", "base"]);
        let base_sha = task_git::rev_parse(root_path.to_str().unwrap(), "HEAD")
            .await
            .expect("base sha");
        // Its own `origin`: the fake forge fetches through it, so a test can
        // publish a real `refs/pull/7/head` and have git answer questions
        // about it exactly as it would against a server.
        git_run(&root_path, &["remote", "add", "origin", root_path.to_str().unwrap()]);

        let worktree = root_path.join("wt");
        git_run(
            &root_path,
            &["worktree", "add", "-q", "-b", "task/7", worktree.to_str().unwrap()],
        );
        std::fs::write(worktree.join("a.txt"), "one\ntwo\n").expect("write");
        git_run(&worktree, &["commit", "-qam", "the work"]);
        let head = task_git::rev_parse(worktree.to_str().unwrap(), "task/7")
            .await
            .expect("work head");

        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let folder_id =
            crate::db::test_helpers::seed_folder(&db, root_path.to_str().unwrap()).await;
        let wt_folder_id =
            crate::db::test_helpers::seed_folder(&db, worktree.to_str().unwrap()).await;

        let meta = serde_json::json!({
            "provider": "github",
            "server_host": "github.com",
            "api_base": "https://api.github.com",
            "account_id": "acc-1",
            "owner_repo": "acme/app",
            "number": 7,
            "url": "https://github.com/acme/app/issues/7",
            "title": "Fix the login flow",
        });
        let now = chrono::Utc::now();
        let task = crate::db::entities::work_task::ActiveModel {
            folder_id: Set(folder_id),
            title: Set("#7 · Fix the login flow".to_string()),
            config: Set("{}".to_string()),
            status: Set(WorkTaskStatus::Review),
            run_seq: Set(1),
            sort_order: Set(0),
            worktree_folder_id: Set(Some(wt_folder_id)),
            base_branch: Set(Some("main".to_string())),
            base_sha: Set(Some(base_sha.clone())),
            work_branch: Set(Some("task/7".to_string())),
            source_kind: Set(Some(SOURCE_KIND_ISSUE.to_string())),
            source_key: Set(Some("github:github.com:acme/app:issue:7".to_string())),
            source_meta: Set(Some(meta.to_string())),
            created_at: Set(now),
            updated_at: Set(now),
            ..Default::default()
        }
        .insert(&db.conn)
        .await
        .expect("insert task");

        let forge = Arc::new(forge);
        // Default posture: the remote base is exactly where this task branched
        // from, so nothing unpushed can leak into the pull request.
        *forge.remote_base.lock().await = Some(base_sha.clone());
        let broadcaster = Arc::new(crate::web::event_bridge::WebEventBroadcaster::new());
        let events = broadcaster.subscribe();
        Delivery {
            engine: test_engine_full(
                db,
                forge.clone(),
                EventEmitter::test_web_only(broadcaster),
            ),
            forge,
            events,
            task_id: task.id,
            head,
            base_sha,
            worktree,
            root: root_path,
            _root: root,
        }
    }

    async fn row(engine: &Arc<TaskEngine>, id: i32) -> crate::db::entities::work_task::Model {
        work_task_service::get_model(&engine.db.conn, id)
            .await
            .expect("task row")
    }

    /// The happy path, end to end: the branch is pushed, a pull request is
    /// opened against the recorded base, and the task settles into `done` with
    /// the evidence of HOW it finished — plus the link, on the row the issue
    /// list reads back.
    #[tokio::test]
    async fn delivery_opens_a_pull_request_and_settles_the_task() {
        let f = delivery_fixture(FakeForge::default()).await;
        let url = f
            .engine
            .deliver_pr(f.task_id, Some("  Fix login  ".into()), false, false)
            .await
            .expect("delivery");
        assert_eq!(url, "https://github.test/acme/app/pull/42");

        assert_eq!(
            f.forge.pushes.lock().await.as_slice(),
            [("acme/app".to_string(), "task/7".to_string(), "task/7".to_string())]
        );
        let created = f.forge.created.lock().await.clone();
        assert_eq!(
            created,
            [("Fix login".to_string(), "task/7".to_string(), "main".to_string(), false)],
            "title trimmed, head/base taken from the task's own record"
        );

        let task = row(&f.engine, f.task_id).await;
        assert_eq!(task.status, WorkTaskStatus::Done);
        assert_eq!(task.completion_kind.as_deref(), Some("delivered_pr"));
        assert!(task.merge_state.is_none(), "the in-flight intent is spent");
        assert!(task.last_error.is_none());
        assert!(task.finished_at.is_some());
        let meta: serde_json::Value =
            serde_json::from_str(task.source_meta.as_deref().unwrap()).unwrap();
        assert_eq!(meta["result_pr"], "https://github.test/acme/app/pull/42");
        // The worktree is kept because this caller did not ask for it to go —
        // the pull request points at this branch and another round on it is a
        // normal next step.
        assert!(f.worktree.exists());
        // Nothing is left in the in-flight set for the reconcile tick to trip on.
        assert!(f.engine.merging.lock().await.is_empty());
    }

    /// The delivery's own version of the offer both other acceptances make:
    /// take the checkout along. Safe here in a way a bare `branch -D` is not —
    /// by the time this runs the commits it destroys locally are on the forge.
    #[tokio::test]
    async fn a_delivery_takes_the_worktree_along_when_asked() {
        let f = delivery_fixture(FakeForge::default()).await;
        let url = f.engine.deliver_pr(f.task_id, None, false, true).await.expect("delivery");
        assert_eq!(url, "https://github.test/acme/app/pull/42");

        let task = row(&f.engine, f.task_id).await;
        assert_eq!(task.status, WorkTaskStatus::Done);
        assert_eq!(task.completion_kind.as_deref(), Some("delivered_pr"));
        assert!(!f.worktree.exists(), "the checkout is gone from disk");
        assert!(task.worktree_folder_id.is_none(), "and the row's pointer with it");
        assert!(task.cleanup_state.is_none(), "a removal that worked flags nothing");
        assert!(
            task_git::rev_parse(f.root.to_str().unwrap(), "refs/heads/task/7").await.is_err(),
            "the local branch goes too — the push that just ran is what makes that safe"
        );
        assert!(f.engine.merging.lock().await.is_empty());
    }

    /// The worktree turned dirty between `deliver_pr`'s pre-flight clean check
    /// and the removal. `worktree remove --force` would drop those files
    /// without a word and they are on no forge, so the checkout is KEPT and
    /// flagged for a retry from the card — while the delivery itself, which is
    /// what the button promised, still reports success.
    #[tokio::test]
    async fn a_worktree_that_turned_dirty_is_kept_rather_than_forced_away() {
        let f = delivery_fixture(FakeForge {
            dirty_on_push: Some("scratch.txt".into()),
            ..Default::default()
        })
        .await;
        let url = f.engine.deliver_pr(f.task_id, None, false, true).await.expect("delivery");
        assert_eq!(url, "https://github.test/acme/app/pull/42");

        let task = row(&f.engine, f.task_id).await;
        assert_eq!(task.status, WorkTaskStatus::Done, "the delivery still landed");
        assert_eq!(task.completion_kind.as_deref(), Some("delivered_pr"));
        assert!(f.worktree.join("scratch.txt").exists(), "the stray file survives");
        assert!(task.worktree_folder_id.is_some(), "the checkout is still the task's");
        assert_eq!(
            task.cleanup_state.as_deref(),
            Some("failed"),
            "so the card can offer the cleanup again once the file is dealt with"
        );
    }

    /// The blind spot `git status` cannot cover: a COMMIT made in the same
    /// window leaves the worktree spotless while putting the branch ahead of
    /// everything the delivery published. `worktree remove --force` plus
    /// `branch -D` would take that commit with them, and it is on no forge —
    /// so the tip is checked against the OID that actually went out, and a
    /// branch that outran it keeps both its checkout and its commit.
    #[tokio::test]
    async fn a_branch_that_outran_the_delivery_keeps_its_unpublished_commit() {
        let f = delivery_fixture(FakeForge {
            commit_on_push: Some("later.txt".into()),
            ..Default::default()
        })
        .await;
        let url = f.engine.deliver_pr(f.task_id, None, false, true).await.expect("delivery");
        assert_eq!(url, "https://github.test/acme/app/pull/42");

        let task = row(&f.engine, f.task_id).await;
        assert_eq!(task.status, WorkTaskStatus::Done, "the delivery still landed");
        assert_eq!(task.completion_kind.as_deref(), Some("delivered_pr"));
        assert!(f.worktree.exists(), "the checkout survives");
        assert!(task.worktree_folder_id.is_some(), "and stays the task's");
        assert_eq!(
            task.cleanup_state.as_deref(),
            Some("failed"),
            "retryable once the extra commit is delivered or moved somewhere safe"
        );
        // Spotless — which is exactly why the other probe could not have
        // caught this, and why the tip check has to exist.
        assert!(!task_git::has_changes(f.worktree.to_str().unwrap()).await.expect("status"));
        let tip = task_git::rev_parse(f.root.to_str().unwrap(), "refs/heads/task/7")
            .await
            .expect("the branch is still there");
        assert_ne!(tip, f.head, "and it holds the commit nobody pushed");
    }

    /// A pull request that already matches all four criteria is ADOPTED. This
    /// is what makes a retry after a settle-time failure safe: the second
    /// attempt must not open a second pull request for the same commit.
    #[tokio::test]
    async fn an_existing_matching_pull_request_is_adopted_not_duplicated() {
        let f = delivery_fixture(FakeForge::default()).await;
        f.forge.existing.lock().await.push(ForgePr {
            number: 11,
            html_url: "https://github.test/acme/app/pull/11".into(),
            state: "open".into(),
            merged: false,
            head_sha: f.head.clone(),
            head_ref: "task/7".into(),
            head_repo: "Acme/App".into(), // canonical casing, as the API sends
            base_ref: "main".into(),
        });

        let url = f.engine.deliver_pr(f.task_id, None, false, false).await.expect("delivery");
        assert_eq!(url, "https://github.test/acme/app/pull/11");
        assert!(
            f.forge.created.lock().await.is_empty(),
            "adoption must not create a duplicate"
        );
        assert_eq!(row(&f.engine, f.task_id).await.status, WorkTaskStatus::Done);
    }

    /// A near-miss is never adopted: same commit, different base. Without the
    /// four-way match this would settle the task against the wrong pull
    /// request; with it, a new one is opened for the right base.
    #[tokio::test]
    async fn a_pull_request_for_another_base_is_not_adopted() {
        let f = delivery_fixture(FakeForge::default()).await;
        f.forge.existing.lock().await.push(ForgePr {
            number: 12,
            html_url: "https://github.test/acme/app/pull/12".into(),
            state: "open".into(),
            merged: false,
            head_sha: f.head.clone(),
            head_ref: "task/7".into(),
            head_repo: "acme/app".into(),
            base_ref: "release/1.x".into(), // ← the only difference
        });

        let url = f.engine.deliver_pr(f.task_id, None, false, false).await.expect("delivery");
        assert_eq!(url, "https://github.test/acme/app/pull/42", "a new one was opened");
        assert_eq!(f.forge.created.lock().await.len(), 1);
    }

    /// Every step after the review→merging CAS can fail, and every one of them
    /// has to leave the task in review with a readable reason — never stranded
    /// in `merging`, where only crash recovery could free it.
    #[tokio::test]
    async fn any_failed_step_returns_the_task_to_review() {
        let cases = [
            (
                FakeForge { push_error: Some("remote rejected".into()), ..Default::default() },
                "could not push",
            ),
            (
                FakeForge { find_error: Some("502 bad gateway".into()), ..Default::default() },
                "could not check for an existing pull request",
            ),
            (
                FakeForge { create_error: Some("422 no commits".into()), ..Default::default() },
                "could not open the pull request",
            ),
        ];
        for (forge, expected) in cases {
            let f = delivery_fixture(forge).await;
            let err = f
                .engine
                .deliver_pr(f.task_id, None, false, false)
                .await
                .expect_err("must fail");
            assert!(err.contains(expected), "got {err}");
            let task = row(&f.engine, f.task_id).await;
            assert_eq!(task.status, WorkTaskStatus::Review, "{expected}");
            assert!(task.last_error.is_some(), "the card must explain itself");
            assert!(task.merge_state.is_none());
            assert!(task.completion_kind.is_none());
            assert!(f.engine.merging.lock().await.is_empty());
        }
    }

    /// A closed-without-merge match is a human decision. The engine neither
    /// reopens it nor opens a duplicate — it hands the task back with the
    /// reason.
    #[tokio::test]
    async fn a_closed_pull_request_stops_the_delivery() {
        let f = delivery_fixture(FakeForge::default()).await;
        f.forge.existing.lock().await.push(ForgePr {
            number: 13,
            html_url: "https://github.test/acme/app/pull/13".into(),
            state: "closed".into(),
            merged: false,
            head_sha: f.head.clone(),
            head_ref: "task/7".into(),
            head_repo: "acme/app".into(),
            base_ref: "main".into(),
        });
        let err = f.engine.deliver_pr(f.task_id, None, false, false).await.expect_err("must stop");
        assert!(err.contains("closed without merging"), "got {err}");
        assert!(f.forge.created.lock().await.is_empty());
        assert_eq!(row(&f.engine, f.task_id).await.status, WorkTaskStatus::Review);
    }

    /// Preconditions are checked BEFORE the CAS, so a refusal leaves the task
    /// untouched — same status, same run generation, and nothing pushed.
    #[tokio::test]
    async fn refusals_happen_before_anything_moves() {
        // Uncommitted work in the worktree: publishing it would push a branch
        // that does not match what the user reviewed.
        let dirty = delivery_fixture(FakeForge::default()).await;
        std::fs::write(dirty.worktree.join("scratch.txt"), "junk\n").expect("write");
        let err = dirty
            .engine
            .deliver_pr(dirty.task_id, None, false, false)
            .await
            .expect_err("dirty worktree");
        assert!(err.contains("uncommitted changes"), "got {err}");

        // Nothing to land: GitHub answers that with a 422, so refuse early and
        // point at the button that does apply.
        let empty = delivery_fixture(FakeForge::default()).await;
        git_run(&empty.worktree, &["reset", "-q", "--hard", "HEAD~1"]);
        let err = empty
            .engine
            .deliver_pr(empty.task_id, None, false, false)
            .await
            .expect_err("nothing to deliver");
        assert!(err.contains("nothing to deliver"), "got {err}");

        for f in [&dirty, &empty] {
            let task = row(&f.engine, f.task_id).await;
            assert_eq!(task.status, WorkTaskStatus::Review);
            assert_eq!(task.run_seq, 1, "no generation was spent");
            assert!(task.last_error.is_none(), "a refusal is not a card banner");
            assert!(f.forge.pushes.lock().await.is_empty());
        }
    }

    /// The gate lives in the engine, not the UI: this command is reachable by
    /// id from an old frontend or a direct web API call.
    ///
    /// Two ways to be undeliverable, and neither may push anything: a task with
    /// no forge source has no repository to deliver to at all, and a
    /// pull-request task whose branch information is missing (a row written
    /// before that was recorded) must be re-triggered rather than pushed at a
    /// branch name we would have to guess.
    #[tokio::test]
    async fn a_task_without_deliverable_provenance_is_refused() {
        use sea_orm::{ActiveModelTrait, Set};
        for (kind, needle) in [
            (None, "issue or pull request"),
            (Some(SOURCE_KIND_PR), "does not know which branch"),
        ] {
            let f = delivery_fixture(FakeForge::default()).await;
            let mut update: crate::db::entities::work_task::ActiveModel =
                row(&f.engine, f.task_id).await.into();
            update.source_kind = Set(kind.map(str::to_string));
            update.update(&f.engine.db.conn).await.expect("update kind");

            let err = f
                .engine
                .deliver_pr(f.task_id, None, false, false)
                .await
                .expect_err("must refuse");
            assert!(err.contains(needle), "got {err}");
            assert!(f.forge.pushes.lock().await.is_empty());
            assert_eq!(row(&f.engine, f.task_id).await.status, WorkTaskStatus::Review);
        }
    }

    /// Crash recovery: the process died between the push and the settle. The
    /// forge is the only truth, and a full four-way match settles the task
    /// exactly as the live path would have.
    #[tokio::test]
    async fn recovery_settles_a_delivery_whose_pull_request_matches() {
        for merged in [false, true] {
            let f = delivery_fixture(FakeForge::default()).await;
            f.forge.existing.lock().await.push(ForgePr {
                number: 21,
                html_url: "https://github.test/acme/app/pull/21".into(),
                state: if merged { "closed".into() } else { "open".into() },
                merged,
                head_sha: f.head.clone(),
                head_ref: "task/7".into(),
                head_repo: "acme/app".into(),
                base_ref: "main".into(),
            });
            interrupt_delivery(&f, "task/7").await;

            f.engine.recover_merging(f.task_id).await;

            let task = row(&f.engine, f.task_id).await;
            assert_eq!(task.status, WorkTaskStatus::Done, "merged={merged}");
            assert_eq!(task.completion_kind.as_deref(), Some("delivered_pr"));
            assert!(f.forge.created.lock().await.is_empty(), "recovery never creates");
        }
    }

    /// Everything short of a full match goes back to a human. Adopting a
    /// near-miss would settle the task against a pull request that merely
    /// reused the branch name.
    #[tokio::test]
    async fn recovery_bounces_anything_it_cannot_prove() {
        let cases: Vec<(&str, Option<ForgePr>)> = vec![
            ("no pull request at all", None),
            (
                "someone else's branch of the same name",
                Some(ForgePr {
                    number: 22,
                    html_url: "https://github.test/acme/app/pull/22".into(),
                    state: "open".into(),
                    merged: false,
                    head_sha: "0000000000000000000000000000000000000000".into(),
                    head_ref: "task/7".into(),
                    head_repo: "acme/app".into(),
                    base_ref: "main".into(),
                }),
            ),
        ];
        for (label, existing) in cases {
            let f = delivery_fixture(FakeForge::default()).await;
            if let Some(pr) = existing {
                f.forge.existing.lock().await.push(pr);
            }
            interrupt_delivery(&f, "task/7").await;

            f.engine.recover_merging(f.task_id).await;

            let task = row(&f.engine, f.task_id).await;
            assert_eq!(task.status, WorkTaskStatus::Review, "{label}");
            assert!(task.last_error.is_some(), "{label}: needs a reason");
            assert!(task.completion_kind.is_none(), "{label}");
        }
    }

    /// A delivery running in THIS process is not orphaned. Recovery has no
    /// live connection to check (a delivery has no agent session), so the
    /// in-flight set is the only thing standing between a slow push and the
    /// reconcile tick tearing it down.
    #[tokio::test]
    async fn recovery_leaves_a_delivery_this_process_owns_alone() {
        let f = delivery_fixture(FakeForge::default()).await;
        interrupt_delivery(&f, "task/7").await;
        f.engine.claim_in_flight(f.task_id).await.expect("claim");

        f.engine.recover_merging(f.task_id).await;

        let task = row(&f.engine, f.task_id).await;
        assert_eq!(task.status, WorkTaskStatus::Merging, "left alone");
        assert!(task.last_error.is_none());
    }

    /// Park the task in `merging` with a delivery intent, exactly as a process
    /// that died mid-delivery would have left it.
    async fn interrupt_delivery(f: &Delivery, remote_branch: &str) {
        let state = WorkTaskMergeState {
            op: WorkTaskMergeOp::DeliverPr,
            remote_branch: Some(remote_branch.to_string()),
            expected_head: Some(f.head.clone()),
            pr_title: Some("Fix login".to_string()),
            ..Default::default()
        };
        let seq = row(&f.engine, f.task_id).await.run_seq;
        work_task_service::begin_delivery(&f.engine.db.conn, f.task_id, &state, seq)
            .await
            .expect("begin delivery")
            .expect("CAS");
    }

    /// The pull request would be diffed against the base branch AS THE REMOTE
    /// HAS IT. A local base that is ahead means the review showed the task's
    /// own commit while the pull request would carry the unpushed ones too —
    /// refuse rather than publish work nobody looked at.
    #[tokio::test]
    async fn a_local_base_ahead_of_the_remote_is_refused() {
        let f = delivery_fixture(FakeForge::default()).await;
        // One more commit on main, never pushed, and the task is recorded as
        // having branched from it.
        std::fs::write(f.root.join("b.txt"), "unpushed\n").expect("write");
        git_run(&f.root, &["add", "-A"]);
        git_run(&f.root, &["commit", "-q", "-m", "local only"]);
        let local_base = task_git::rev_parse(f.root.to_str().unwrap(), "HEAD")
            .await
            .expect("local base");
        let mut update: crate::db::entities::work_task::ActiveModel =
            row(&f.engine, f.task_id).await.into();
        update.base_sha = sea_orm::Set(Some(local_base));
        sea_orm::ActiveModelTrait::update(update, &f.engine.db.conn)
            .await
            .expect("record the local base");

        let err = f
            .engine
            .deliver_pr(f.task_id, None, false, false)
            .await
            .expect_err("must refuse");
        assert!(err.contains("not on the remote yet"), "got {err}");
        assert!(f.forge.pushes.lock().await.is_empty(), "refused before the push");
        assert_eq!(row(&f.engine, f.task_id).await.status, WorkTaskStatus::Review);

        // And an unreadable remote base is NOT reassurance: a base branch that
        // does not exist on the remote fails exactly the same way, and the push
        // would still publish the branch. This gate fails closed.
        *f.forge.remote_base.lock().await = None;
        let err = f
            .engine
            .deliver_pr(f.task_id, None, false, false)
            .await
            .expect_err("an unreadable base must refuse");
        assert!(err.contains("could not read"), "got {err}");
        assert!(f.forge.pushes.lock().await.is_empty());
    }

    /// A merge that cannot take in-flight ownership must not dispatch either.
    /// The claim and the review→merging CAS are independent, so a claim-loser
    /// that carried on could win the CAS and then be left unowned when the
    /// claim-holder released the registry entry on its own way out.
    #[tokio::test]
    async fn a_merge_that_cannot_claim_ownership_does_not_dispatch() {
        let f = delivery_fixture(FakeForge::default()).await;
        let token = f
            .engine
            .claim_in_flight(f.task_id)
            .await
            .expect("delivery claims first");

        let err = f
            .engine
            .merge_task(f.task_id, None, false, None, false)
            .await
            .expect_err("must not dispatch");
        assert!(err.contains("already merging"), "got {err}");
        // Swallowed by the unattended sweep rather than bannered onto the card
        // — the condition clears itself in seconds.
        assert!(is_benign_merge_race(&err));

        let task = row(&f.engine, f.task_id).await;
        assert_eq!(task.status, WorkTaskStatus::Review, "no CAS was spent");
        assert!(task.merge_state.is_none());
        assert_eq!(
            f.engine.merging.lock().await.get(&f.task_id),
            Some(&token),
            "the refused merge must leave the claim it never held"
        );
    }

    /// Two clients clicking deliver at once. Only one may run the push, and —
    /// the part that bit us — the LOSER must not release the winner's
    /// ownership, or the reconcile sweep would bounce a live delivery.
    #[tokio::test]
    async fn a_second_delivery_neither_runs_nor_steals_the_claim() {
        let f = delivery_fixture(FakeForge::default()).await;
        let token = f
            .engine
            .claim_in_flight(f.task_id)
            .await
            .expect("first claim wins");

        let err = f
            .engine
            .deliver_pr(f.task_id, None, false, false)
            .await
            .expect_err("the second must not run");
        assert!(err.contains("already merging"), "got {err}");
        assert!(f.forge.pushes.lock().await.is_empty());
        assert_eq!(
            f.engine.merging.lock().await.get(&f.task_id),
            Some(&token),
            "the loser must leave the winner's claim in place"
        );

        // And releasing with a foreign token is a no-op for the same reason.
        f.engine.release_in_flight(f.task_id, token + 99).await;
        assert_eq!(f.engine.merging.lock().await.get(&f.task_id), Some(&token));
        f.engine.release_in_flight(f.task_id, token).await;
        assert!(f.engine.merging.lock().await.is_empty());
    }

    /// A recovery pass that spent time at the forge must not undo a delivery
    /// that started while it was deciding — the bounce is bound to the
    /// generation the pass actually read.
    #[tokio::test]
    async fn stale_recovery_cannot_bounce_a_newer_generation() {
        let f = delivery_fixture(FakeForge::default()).await;
        interrupt_delivery(&f, "task/7").await;
        let stale = row(&f.engine, f.task_id).await;

        // The row moves on (a bounce and a fresh delivery), so the snapshot the
        // recovery pass is holding is now a generation behind.
        f.engine.bounce_delivery(&stale, "first".into()).await;
        interrupt_delivery(&f, "task/7").await;
        let current = row(&f.engine, f.task_id).await;
        assert!(current.run_seq > stale.run_seq);

        f.engine.bounce_delivery(&stale, "stale bounce".into()).await;

        let after = row(&f.engine, f.task_id).await;
        assert_eq!(after.status, WorkTaskStatus::Merging, "still delivering");
        assert_eq!(after.run_seq, current.run_seq);
    }

    /// One branch may have several open pull requests as long as each targets
    /// its own base — but only ONE per head/base pair. So a pull request for
    /// another base is no obstacle (create), while one for THIS base headed by
    /// a different commit is (bounce, rather than earn a 422 from GitHub).
    #[tokio::test]
    async fn a_stale_head_on_this_base_bounces_instead_of_duplicating() {
        let f = delivery_fixture(FakeForge::default()).await;
        f.forge.existing.lock().await.push(ForgePr {
            number: 31,
            html_url: "https://github.test/acme/app/pull/31".into(),
            state: "open".into(),
            merged: false,
            head_sha: "0000000000000000000000000000000000000000".into(),
            head_ref: "task/7".into(),
            head_repo: "acme/app".into(),
            base_ref: "main".into(),
        });

        let err = f
            .engine
            .deliver_pr(f.task_id, None, false, false)
            .await
            .expect_err("must bounce");
        assert!(err.contains("different commit"), "got {err}");
        assert!(
            f.forge.created.lock().await.is_empty(),
            "GitHub would refuse a duplicate anyway — do not ask"
        );
        let task = row(&f.engine, f.task_id).await;
        assert_eq!(task.status, WorkTaskStatus::Review);
        assert!(task.last_error.is_some());
    }

    /// A delivery occupies the folder's `merging` slot, so a sibling task's
    /// unattended merge is refused while it runs. That refusal must stay a
    /// BENIGN race: `set_review_error` would latch auto-merge off for that card
    /// permanently, over a condition that clears itself in seconds.
    #[test]
    fn a_delivery_in_flight_does_not_latch_off_a_sibling_auto_merge() {
        assert!(is_benign_merge_race(
            "another task of this project is already merging — wait for it"
        ));
    }

    // ── write the outcome back to the forge ─────────────────────────────────

    /// Record the trigger dialog's write-back answer on the task's own source
    /// metadata — where the engine reads it. Call it AFTER any helper that
    /// rewrites `source_meta` wholesale (`as_pull_request_task`), or the
    /// rewrite drops the answer.
    async fn set_writeback(f: &Delivery, wanted: bool) {
        use sea_orm::{ActiveModelTrait, IntoActiveModel, Set};
        let task = row(&f.engine, f.task_id).await;
        let mut meta: serde_json::Value =
            serde_json::from_str(task.source_meta.as_deref().expect("source meta"))
                .expect("source meta json");
        meta["writeback"] = serde_json::json!(wanted);
        let mut active = task.into_active_model();
        active.source_meta = Set(Some(meta.to_string()));
        active.update(&f.engine.db.conn).await.expect("record the write-back answer");
    }

    async fn enable_writeback(f: &Delivery) {
        set_writeback(f, true).await;
    }

    /// The write-back is spawned off the settlement path, so an assertion about
    /// it has to wait for it rather than read straight after the settle.
    async fn wait_for<F, Fut>(what: &str, probe: F)
    where
        F: Fn() -> Fut,
        Fut: std::future::Future<Output = bool>,
    {
        for _ in 0..300 {
            if probe().await {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("timed out waiting for {what}");
    }

    async fn events_of(engine: &Arc<TaskEngine>, task_id: i32) -> Vec<String> {
        work_task_service::list_events(&engine.db.conn, task_id, 200)
            .await
            .expect("events")
            .into_iter()
            .map(|e| e.kind)
            .collect()
    }

    /// A task that came from a proposed change gets its comment on the CHANGE,
    /// not on an issue with the same number. GitHub serves both from one
    /// endpoint and would not notice; GitLab has two collections, where the
    /// wrong one lands on an unrelated issue or 404s.
    #[tokio::test]
    async fn a_pull_request_tasks_comment_targets_the_pull_request() {
        let f = delivery_fixture(FakeForge::default()).await;
        let pr = open_pull("whatever-the-branch-points-at", "feature", "Acme/App");
        as_pull_request_task(&f, pr.clone()).await;
        enable_writeback(&f).await;
        f.forge.existing.lock().await.push(pr);

        f.engine
            .deliver_pr(f.task_id, None, false, false)
            .await
            .expect("push back");

        let forge = f.forge.clone();
        wait_for("the write-back", move || {
            let forge = forge.clone();
            async move { !forge.comments.lock().await.is_empty() }
        })
        .await;
        let comments = f.forge.comments.lock().await.clone();
        assert_eq!(
            (comments[0].0, comments[0].1),
            (ForgeItemKind::Change, 7),
            "the comment belongs on the pull request the task came from"
        );
    }

    /// The comment is a fact sheet: the link and the counters. Nothing the
    /// agent wrote may reach a thread other people are reading.
    #[tokio::test]
    async fn a_delivered_task_comments_the_link_and_the_numbers() {
        use sea_orm::{ActiveModelTrait, IntoActiveModel, Set};
        let f = delivery_fixture(FakeForge::default()).await;
        enable_writeback(&f).await;
        // The counters a settled run leaves on the row, plus the agent's own
        // words — which must NOT travel.
        let mut active = row(&f.engine, f.task_id).await.into_active_model();
        active.files_changed = Set(Some(3));
        active.additions = Set(Some(42));
        active.deletions = Set(Some(7));
        active.result_summary =
            Set(Some("I refactored the auth module and rewrote the tests".to_string()));
        active.update(&f.engine.db.conn).await.expect("record the run's result");

        f.engine
            .deliver_pr(f.task_id, None, false, false)
            .await
            .expect("delivery");

        let forge = f.forge.clone();
        wait_for("the write-back", move || {
            let forge = forge.clone();
            async move { !forge.comments.lock().await.is_empty() }
        })
        .await;
        let comments = f.forge.comments.lock().await.clone();
        assert_eq!(comments.len(), 1);
        let (kind, number, body) = &comments[0];
        assert_eq!(*number, 7, "the comment goes on the issue the task came from");
        assert_eq!(*kind, ForgeItemKind::Issue, "…in the issue's own thread");
        assert!(body.contains("https://github.test/acme/app/pull/42"), "{body}");
        assert!(body.contains("(3 files, +42/-7)"), "{body}");
        assert!(!body.contains("refactored"), "agent text leaked: {body}");
        assert!(
            events_of(&f.engine, f.task_id).await.contains(&"forge_writeback".to_string()),
            "the comment belongs on the timeline"
        );
    }

    /// A task whose trigger dialog left the box unchecked publishes nothing —
    /// this is the one thing a task does in a place other people watch.
    #[tokio::test]
    async fn a_task_that_declined_the_comment_writes_nothing() {
        let f = delivery_fixture(FakeForge::default()).await;
        set_writeback(&f, false).await;
        f.engine
            .deliver_pr(f.task_id, None, false, false)
            .await
            .expect("delivery");
        // The settle emitted; give a spawned write-back the same chance to run
        // as the enabled case gets before concluding it did not.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(f.forge.comments.lock().await.is_empty());
        assert!(!events_of(&f.engine, f.task_id).await.contains(&"forge_writeback".to_string()));
    }

    /// A row minted before the choice lived on the task carries no answer at
    /// all. "No recorded yes" is a no: an upgrade must not start commenting on
    /// threads for tasks whose author was never asked.
    #[tokio::test]
    async fn a_task_without_a_recorded_answer_writes_nothing() {
        let f = delivery_fixture(FakeForge::default()).await;
        assert!(
            !row(&f.engine, f.task_id)
                .await
                .source_meta
                .unwrap_or_default()
                .contains("writeback"),
            "the fixture stands in for a pre-choice row"
        );
        f.engine
            .deliver_pr(f.task_id, None, false, false)
            .await
            .expect("delivery");
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(f.forge.comments.lock().await.is_empty());
        assert!(!events_of(&f.engine, f.task_id).await.contains(&"forge_writeback".to_string()));
    }

    /// Best-effort means best-effort: a comment that cannot be posted is a
    /// timeline entry, not a status change. The task is finished either way.
    #[tokio::test]
    async fn a_failed_write_back_leaves_the_finished_task_alone() {
        let f = delivery_fixture(FakeForge {
            comment_error: Some("403 forbidden".into()),
            ..Default::default()
        })
        .await;
        enable_writeback(&f).await;
        f.engine
            .deliver_pr(f.task_id, None, false, false)
            .await
            .expect("delivery");

        let engine = f.engine.clone();
        let task_id = f.task_id;
        wait_for("the failure event", move || {
            let engine = engine.clone();
            async move {
                events_of(&engine, task_id).await.contains(&"forge_writeback_failed".to_string())
            }
        })
        .await;
        let task = row(&f.engine, f.task_id).await;
        assert_eq!(task.status, WorkTaskStatus::Done);
        assert_eq!(task.completion_kind.as_deref(), Some("delivered_pr"));
        assert!(task.last_error.is_none(), "a failed comment is not a task failure");
    }

    /// The OTHER settlement path: a task that landed on the base branch
    /// locally. Its comment names the commit, not a pull request — and the
    /// write-back is spawned from inside the folder's git lock, which it must
    /// neither take nor be blocked by.
    #[tokio::test]
    async fn a_locally_merged_task_comments_the_commit() {
        use sea_orm::{ActiveModelTrait, IntoActiveModel, Set};
        let f = delivery_fixture(FakeForge::default()).await;
        enable_writeback(&f).await;

        // The state a crashed merge generation leaves behind: `merging`, with
        // the base HEAD it started from…
        let pre_merge_head = task_git::rev_parse(f.root.to_str().unwrap(), "HEAD")
            .await
            .expect("base head");
        let state = WorkTaskMergeState {
            op: WorkTaskMergeOp::Land,
            pre_merge_head,
            strategy: "merge".into(),
            ..Default::default()
        };
        let mut active = row(&f.engine, f.task_id).await.into_active_model();
        active.status = Set(WorkTaskStatus::Merging);
        active.merge_state = Set(Some(serde_json::to_string(&state).expect("state")));
        active.files_changed = Set(Some(1));
        active.additions = Set(Some(1));
        active.deletions = Set(Some(0));
        active.update(&f.engine.db.conn).await.expect("to merging");
        // …and the landing itself, which the dead process did complete.
        git_run(&f.root, &["merge", "--no-ff", "-q", "-m", "land", "task/7"]);
        let landed_commit = task_git::rev_parse(f.root.to_str().unwrap(), "HEAD")
            .await
            .expect("landed head");

        f.engine.recover_merging(f.task_id).await;
        assert_eq!(row(&f.engine, f.task_id).await.status, WorkTaskStatus::Done);

        let forge = f.forge.clone();
        wait_for("the write-back", move || {
            let forge = forge.clone();
            async move { !forge.comments.lock().await.is_empty() }
        })
        .await;
        let comments = f.forge.comments.lock().await.clone();
        assert_eq!(comments.len(), 1, "one settle, one comment");
        let (kind, number, body) = &comments[0];
        assert_eq!((*kind, *number), (ForgeItemKind::Issue, 7));
        assert!(body.contains(&landed_commit[..7]), "the commit that landed: {body}");
        assert!(body.contains("`main`") && body.contains("(1 file, +1/-0)"), "{body}");

        // A second recovery pass finds a `done` row and settles nothing, so the
        // issue does not collect a comment per sweep.
        f.engine.recover_merging(f.task_id).await;
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert_eq!(f.forge.comments.lock().await.len(), 1);
    }

    // ── the dead merge generation's connection ──────────────────────────────

    /// Park the fixture's task exactly where a process that died mid-merge left
    /// it: `merging`, pointing at a connection that no longer exists, with that
    /// connection still in the engine's correlation index.
    async fn interrupt_merge(f: &Delivery, conn_id: &str, delete_worktree: bool) {
        use sea_orm::{ActiveModelTrait, IntoActiveModel, Set};
        let state = WorkTaskMergeState {
            op: WorkTaskMergeOp::Land,
            pre_merge_head: task_git::rev_parse(f.root.to_str().unwrap(), "HEAD")
                .await
                .expect("base head"),
            strategy: "merge".into(),
            delete_worktree,
            ..Default::default()
        };
        let task = row(&f.engine, f.task_id).await;
        let run_seq = task.run_seq;
        let mut active = task.into_active_model();
        active.status = Set(WorkTaskStatus::Merging);
        active.merge_state = Set(Some(serde_json::to_string(&state).expect("state")));
        active.connection_id = Set(Some(conn_id.to_string()));
        active.update(&f.engine.db.conn).await.expect("to merging");
        // Registered at launch, and only a TurnComplete ever takes it out.
        f.engine
            .index
            .lock()
            .await
            .insert(conn_id.into(), (f.task_id, run_seq));
    }

    /// The dead generation's index entry has no other way out — `reconcile_once`
    /// only scans `running` / `awaiting_input`, and the TurnComplete that would
    /// have retired it is the very thing that went missing. Recovery inherits
    /// that teardown, and must do it before it acts: this same pass honors the
    /// "delete the worktree" the user ticked, and worktree removal reads that
    /// same map as "an agent is still working in there".
    #[tokio::test]
    async fn recovery_retires_the_dead_merge_generations_connection() {
        const DEAD_CONN: &str = "conn-of-a-dead-merge";
        let f = delivery_fixture(FakeForge::default()).await;
        interrupt_merge(&f, DEAD_CONN, true).await;
        // The landing itself, which the dead process did complete.
        git_run(&f.root, &["merge", "--no-ff", "-q", "-m", "land", "task/7"]);

        f.engine.recover_merging(f.task_id).await;

        assert!(
            !f.engine.index.lock().await.contains_key(DEAD_CONN),
            "the dead generation must not outlive its recovery"
        );
        let task = row(&f.engine, f.task_id).await;
        assert_eq!(task.status, WorkTaskStatus::Done);
        assert_eq!(
            task.cleanup_state, None,
            "nothing is working in that worktree — the removal must not be refused"
        );
        assert_eq!(task.worktree_folder_id, None, "detached");
        assert!(!f.worktree.exists(), "and really gone from disk");
    }

    /// The other outcome, same teardown: a recovery that cannot prove the merge
    /// landed bounces the row to `review` — where a surviving entry would keep
    /// attributing the dead connection's late events to a task that has moved
    /// on, and would block the worktree cleanup offered right there on the card.
    #[tokio::test]
    async fn a_bounced_recovery_retires_the_dead_connection_too() {
        const DEAD_CONN: &str = "conn-of-a-lost-merge";
        let f = delivery_fixture(FakeForge::default()).await;
        // No merge commit: the process died before landing anything.
        interrupt_merge(&f, DEAD_CONN, false).await;

        f.engine.recover_merging(f.task_id).await;

        let task = row(&f.engine, f.task_id).await;
        assert_eq!(task.status, WorkTaskStatus::Review);
        assert!(task.last_error.is_some(), "bounced with a reason");
        assert!(
            !f.engine.index.lock().await.contains_key(DEAD_CONN),
            "a task back in review has no run to correlate events to"
        );
    }

    /// Retiring one generation must not disarm another. The outstanding-request
    /// set is keyed by task, so a stale pass that reaches a task someone else
    /// has already relaunched would otherwise drop the live generation's
    /// pending permissions — and the next resolution would empty a set that is
    /// already empty and put the card back to `running` while the agent is
    /// still parked on the request nobody answered.
    #[tokio::test]
    async fn retiring_a_connection_spares_the_requests_of_one_still_on_the_task() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let engine = test_engine(db);
        {
            let mut index = engine.index.lock().await;
            index.insert("conn-old".into(), (7, 1));
            index.insert("conn-new".into(), (7, 2));
        }
        engine
            .awaiting
            .lock()
            .await
            .insert(7, ["p:req-1".to_string()].into_iter().collect());

        engine.retire_connection("conn-old", 7).await;

        {
            let index = engine.index.lock().await;
            assert!(!index.contains_key("conn-old"), "the retired one is gone");
            assert!(index.contains_key("conn-new"), "and only that one");
        }
        assert_eq!(
            engine.awaiting.lock().await.get(&7).map(|s| s.len()),
            Some(1),
            "the live generation is still waiting on its permission"
        );

        // The last one out does clear it — a set inherited by the next
        // generation would never flip the row to `awaiting_input` again.
        engine.retire_connection("conn-new", 7).await;
        assert!(engine.awaiting.lock().await.get(&7).is_none());
    }

    /// `index` is a correlation table, not a liveness one. Whatever leaves an
    /// entry behind, the user's "remove worktree" must not be refused on behalf
    /// of a connection that is gone — the refusal sets a `failed` flag whose
    /// retry can never clear, because nothing would ever arrive to remove the
    /// entry. The manager is the truth, and what it says is gone is retired.
    #[tokio::test]
    async fn worktree_removal_is_not_refused_by_a_dead_connection() {
        const ZOMBIE: &str = "conn-nobody-holds";
        let f = delivery_fixture(FakeForge::default()).await;
        let run_seq = row(&f.engine, f.task_id).await.run_seq;
        f.engine
            .index
            .lock()
            .await
            .insert(ZOMBIE.into(), (f.task_id, run_seq));

        f.engine.cleanup_task(f.task_id).await.expect("cleanup");

        let task = row(&f.engine, f.task_id).await;
        assert_eq!(task.cleanup_state, None, "not a live agent");
        assert_eq!(task.worktree_folder_id, None, "detached");
        assert!(!f.worktree.exists(), "and really gone from disk");
        assert!(!f.engine.index.lock().await.contains_key(ZOMBIE), "retired");
    }

    /// Git for Windows can finish the destructive part of `worktree remove`
    /// (registration and checkout contents) but fail to remove the now-empty
    /// directory. That first pass leaves the task flagged for cleanup; its retry
    /// must recognize the harmless shell, finish the branch/DB cleanup, and not
    /// report files that do not exist.
    #[tokio::test]
    async fn worktree_cleanup_retry_converges_an_empty_detached_shell() {
        let f = delivery_fixture(FakeForge::default()).await;
        let worktree = f.worktree.to_str().expect("utf-8 worktree");
        git_run(&f.root, &["worktree", "remove", "--force", worktree]);
        std::fs::create_dir(&f.worktree).expect("empty shell");
        work_task_service::set_cleanup_state(
            &f.engine.db.conn,
            f.task_id,
            true,
            Some("the first removal stopped after git detached it".into()),
        )
        .await
        .expect("flag failed cleanup");

        f.engine
            .cleanup_task(f.task_id)
            .await
            .expect("retry cleanup");

        let task = row(&f.engine, f.task_id).await;
        assert_eq!(task.cleanup_state, None, "the retry is fully settled");
        assert_eq!(
            task.worktree_folder_id, None,
            "folder bookkeeping converged"
        );
        assert!(!f.worktree.exists(), "the empty shell is gone");
        assert!(
            task_git::rev_parse(f.root.to_str().unwrap(), "refs/heads/task/7")
                .await
                .is_err(),
            "the requested work branch goes too"
        );
    }

    /// A missing `.git` file alone is not proof that the directory is a harmless
    /// post-removal shell. Files may have appeared after the partial teardown,
    /// and none of them is recoverable through git, so the retry must preserve
    /// both the sentinel and the branch.
    #[tokio::test]
    async fn worktree_cleanup_retry_preserves_a_file_in_a_detached_shell() {
        let f = delivery_fixture(FakeForge::default()).await;
        let worktree = f.worktree.to_str().expect("utf-8 worktree");
        git_run(&f.root, &["worktree", "remove", "--force", worktree]);
        std::fs::create_dir(&f.worktree).expect("empty shell");
        std::fs::write(f.worktree.join("sentinel.txt"), "not in git\n").expect("sentinel");

        let err = f
            .engine
            .cleanup_task(f.task_id)
            .await
            .expect_err("a non-empty shell is not removable");

        assert!(err.holds_work, "the retry is refused as a data-safety gate");
        assert_eq!(
            std::fs::read_to_string(f.worktree.join("sentinel.txt")).expect("read sentinel"),
            "not in git\n"
        );
        let task = row(&f.engine, f.task_id).await;
        assert!(
            task.worktree_folder_id.is_some(),
            "the retry remains available"
        );
        assert!(
            task_git::rev_parse(f.root.to_str().unwrap(), "refs/heads/task/7")
                .await
                .is_ok(),
            "the branch survives with the sentinel"
        );
    }

    /// A repository with `layout` applied to it, for the probe tests below:
    /// returns `(tempdir, repo path, worktree path)`. The two tests that pass
    /// `"sibling"` reproduce the DEFAULT worktree layout — beside the project,
    /// with no repository of the fixture's own above it, which is the layout in
    /// which a shell has no enclosing repository for `git status` to answer
    /// about instead. (Nothing here can rule out a repository ABOVE the system
    /// temp directory; in that environment the sibling pair still asserts the
    /// right answers, but it is `an_empty_shell_inside_a_dirty_project_reads_as_clean`
    /// — which builds its own enclosing repository — that pins the regression
    /// unconditionally.)
    fn probe_repo(layout: &str) -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let repo = dir.path().join("repo");
        std::fs::create_dir(&repo).expect("mkdir");
        git_run(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("a.txt"), "one\n").expect("write");
        git_run(&repo, &["add", "-A"]);
        git_run(&repo, &["commit", "-q", "-m", "base"]);
        let worktree = match layout {
            "sibling" => dir.path().join("wt"),
            _ => repo.join("wt"),
        };
        (dir, repo, worktree)
    }

    /// THE probe behind issue #642's dead-end retry, exercised where the bug
    /// actually happens. `has_changes` runs `git status` from the path itself,
    /// so a shell in the default layout — beside the project, no repository
    /// above it — makes git error, and reading that error as "dirty" is what
    /// made the retry offer the same refusal forever. An empty shell has, by
    /// definition, nothing a `--force` removal could take.
    #[tokio::test]
    async fn an_empty_shell_beside_a_project_reads_as_clean() {
        let (_dir, _repo, worktree) = probe_repo("sibling");
        std::fs::create_dir(&worktree).expect("empty shell");

        assert!(
            !path_holds_uncommitted(worktree.to_str().expect("utf-8")).await,
            "an empty post-removal shell holds nothing"
        );
    }

    /// The other half of the same answer: outside a repository git errors on a
    /// shell whatever is in it, so emptiness is the ONLY thing separating a
    /// harmless leftover from files nothing can give back.
    #[tokio::test]
    async fn a_file_in_a_shell_beside_a_project_still_reads_as_dirty() {
        let (_dir, _repo, worktree) = probe_repo("sibling");
        std::fs::create_dir(&worktree).expect("shell");
        std::fs::write(worktree.join("sentinel.txt"), "not in git\n").expect("sentinel");

        assert!(
            path_holds_uncommitted(worktree.to_str().expect("utf-8")).await,
            "a shell with an entry in it is not removable"
        );
    }

    /// A worktree root configured INSIDE the project (a relative
    /// `worktree_root`, which the setting takes at face value) puts the shell
    /// under the project's own `.git`. `git status` then answers happily — about
    /// the PROJECT — so a project with a stray file of its own would answer
    /// "dirty" for a shell holding nothing, and #642's retry would still never
    /// converge. Without a `.git` marker the path is not a checkout git speaks
    /// for, and its answer must not be read as this path's.
    ///
    /// The project's dirt is an edit to a TRACKED file, not a stray untracked
    /// one: `has_changes` spawns git through `crate::process`, which inherits
    /// the real environment, so an untracked fixture is only as visible as the
    /// developer's global `core.excludesFile` lets it be — and a fixture git
    /// silently ignores would make this test pass against the very bug it
    /// exists to pin. No ignore rule can hide a modified tracked file.
    #[tokio::test]
    async fn an_empty_shell_inside_a_dirty_project_reads_as_clean() {
        let (_dir, repo, worktree) = probe_repo("nested");
        std::fs::write(repo.join("a.txt"), "the project's own mess\n").expect("dirty project");
        std::fs::create_dir(&worktree).expect("empty shell");

        assert!(
            !path_holds_uncommitted(worktree.to_str().expect("utf-8")).await,
            "the project's dirt is not the shell's"
        );
    }

    /// And the marker check must not short-circuit the case it is guarding: a
    /// checkout that still HAS its `.git` is exactly what `git status` is for,
    /// uncommitted work included. Tracked and modified for the reason above —
    /// an untracked fixture would read as clean under a global ignore rule that
    /// happens to match it, and fail this assertion on that developer's machine
    /// alone.
    #[tokio::test]
    async fn an_intact_worktree_is_still_measured_by_git() {
        let (_dir, repo, worktree) = probe_repo("sibling");
        let worktree_path = worktree.to_str().expect("utf-8");
        git_run(
            &repo,
            &["worktree", "add", "-q", "-b", "task/probe", worktree_path],
        );
        assert!(
            !path_holds_uncommitted(worktree_path).await,
            "a fresh checkout holds nothing"
        );

        std::fs::write(worktree.join("a.txt"), "unstaged\n").expect("edit");

        assert!(
            path_holds_uncommitted(worktree_path).await,
            "an uncommitted edit in a live checkout is work"
        );
    }

    /// The removal underneath is `worktree remove --force`, and a stop pressed
    /// while the agent is editing is exactly when a checkout is dirty. Nothing
    /// the user clicked named those files — the cancel dialog's checkbox offers
    /// "its worktree and work branch" — so this has to refuse, the same line
    /// `complete_task` draws and the branch dropdown re-asks about.
    #[tokio::test]
    async fn worktree_removal_refuses_to_take_uncommitted_work() {
        let f = delivery_fixture(FakeForge::default()).await;
        // Both shapes `git status` reports: an edit to a tracked file, and a
        // file git has never seen. Either one on its own is unrecoverable.
        std::fs::write(f.worktree.join("a.txt"), "one\ntwo\nthree\n").expect("write");
        std::fs::write(f.worktree.join("notes.md"), "half a thought\n").expect("write");

        let err = f
            .engine
            .cleanup_task(f.task_id)
            .await
            .expect_err("must not take uncommitted work");
        assert!(err.holds_work, "declined to protect work, not a failure");
        assert!(
            err.message.contains("uncommitted files"),
            "and says why: {}",
            err.message
        );

        assert!(f.worktree.exists(), "the checkout survives");
        assert_eq!(
            std::fs::read_to_string(f.worktree.join("notes.md")).expect("read"),
            "half a thought\n",
            "and so does the work inside it"
        );
        let task = row(&f.engine, f.task_id).await;
        assert_eq!(
            task.cleanup_state.as_deref(),
            Some("failed"),
            "flagged, because the cancel and delete paths swallow the error and \
             the card is the only place left to say it"
        );
        assert!(
            task.worktree_folder_id.is_some(),
            "still attached, so the retry has something to remove"
        );
    }

    /// The probe fails CLOSED. `git status` can stop answering for reasons that
    /// have nothing to do with the checkout being gone — a corrupt index, a
    /// permission error — and the operation waiting on that answer is
    /// `worktree remove --force`. Reading "could not ask" as "clean" would
    /// trade a recoverable stall for unrecoverable files.
    #[tokio::test]
    async fn a_worktree_git_cannot_read_is_not_assumed_clean() {
        let f = delivery_fixture(FakeForge::default()).await;
        // A linked worktree's `.git` is a FILE pointing back at the real gitdir.
        // Pointing it nowhere makes every git command in here fail while the
        // directory — and whatever the user left in it — stays on disk.
        std::fs::write(f.worktree.join("unsaved.txt"), "not committed\n").expect("write");
        std::fs::write(f.worktree.join(".git"), "gitdir: /nowhere/at/all\n").expect("write");

        let err = f
            .engine
            .cleanup_task(f.task_id)
            .await
            .expect_err("must not force-remove a checkout it could not read");
        assert!(err.holds_work, "unprovable is treated as unsafe");

        assert!(f.worktree.exists(), "the checkout survives");
        assert_eq!(
            std::fs::read_to_string(f.worktree.join("unsaved.txt")).expect("read"),
            "not committed\n"
        );
    }

    /// The removal has to serialize against a LAUNCH, and the folder git lock
    /// cannot do that: `launch` holds the TASK lock across its whole setup —
    /// `ensure_worktree` included — and takes no folder lock at all.
    ///
    /// The sequence that gets there is ordinary board use: a cancel that was
    /// asked to take the worktree along leaves the row `canceled`, the user
    /// requeues it (a pure DB write that waits on no lock), and the pump
    /// launches it — all while the removal sits between its status read and its
    /// `git worktree remove`. Nothing about the requeue is wrong; the fresh run
    /// would mint its own checkout. Deleting the directory out from under
    /// `ensure_worktree` is.
    ///
    /// Holding the task lock here stands in for that launch: without the lock
    /// on the removal's side, the worktree is gone before the guard is dropped.
    #[tokio::test]
    async fn worktree_removal_waits_for_the_task_lock() {
        let f = delivery_fixture(FakeForge::default()).await;
        let engine = f.engine.clone();
        let task_id = f.task_id;

        // Stand in for a launch that has the row and is inside its setup.
        let held = engine.task_lock(task_id).await;
        let guard = held.lock().await;

        let removal = tokio::spawn({
            let engine = engine.clone();
            async move { engine.cleanup_task(task_id).await }
        });

        // Long enough that an unserialized removal — a few DB reads and a
        // `git worktree remove` — would have finished several times over.
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert!(
            f.worktree.exists(),
            "the checkout must survive while the launch holds the task lock"
        );
        assert!(!removal.is_finished(), "and the removal must still be parked");

        drop(guard);
        removal.await.expect("join").expect("cleanup");
        assert!(!f.worktree.exists(), "and go once the lock is free");
        assert_eq!(row(&engine, task_id).await.worktree_folder_id, None);
    }

    /// Drain everything the fixture's engine has broadcast so far.
    fn drained(f: &mut Delivery) -> Vec<crate::web::event_bridge::WebEvent> {
        let mut out = Vec::new();
        while let Ok(ev) = f.events.try_recv() {
            out.push(ev);
        }
        out
    }

    /// An acceptance that removes the worktree has to say so on the TASK
    /// channel, not just the folder one. Both acceptance paths broadcast the
    /// row BEFORE the cleanup runs (`settle_merge_generation` and this one), so
    /// a removal that stays silent leaves every open board holding the snapshot
    /// taken while the worktree still existed: the card flips to `done` but its
    /// "worktree removed" badge — keyed on `worktree_folder_id` going null —
    /// never appears until someone refetches the whole table.
    #[tokio::test]
    async fn removing_the_worktree_announces_the_task_after_the_folder() {
        let mut f = delivery_fixture(FakeForge::default()).await;
        interrupt_merge(&f, "conn-of-a-dead-merge", true).await;
        git_run(&f.root, &["merge", "--no-ff", "-q", "-m", "land", "task/7"]);
        let _ = drained(&mut f); // everything up to the merge is setup noise

        f.engine.recover_merging(f.task_id).await;

        assert_eq!(
            row(&f.engine, f.task_id).await.worktree_folder_id,
            None,
            "precondition: this run really did detach the worktree"
        );
        let events = drained(&mut f);
        let folder_gone = events
            .iter()
            .position(|e| {
                e.channel == crate::web::event_bridge::FOLDER_CHANGED_EVENT
                    && e.payload["kind"] == "deleted"
            })
            .expect("the worktree folder drop is broadcast");
        assert!(
            events.iter().skip(folder_gone).any(|e| {
                e.channel == WORK_TASK_CHANGED_EVENT
                    && e.payload["kind"] == "upsert"
                    && e.payload["id"] == f.task_id
            }),
            "the task must be re-announced AFTER the detach — an upsert from \
             before it carries the worktree the client is being told to drop; \
             saw {:?}",
            events.iter().map(|e| &e.channel).collect::<Vec<_>>()
        );
    }

    /// A task nobody triggered from a forge has no thread to comment on — the
    /// write-back must never invent one from the folder's remote.
    #[tokio::test]
    async fn a_task_without_a_forge_source_is_never_commented() {
        use sea_orm::{ActiveModelTrait, IntoActiveModel, Set};
        let f = delivery_fixture(FakeForge::default()).await;
        enable_writeback(&f).await;
        let mut active = row(&f.engine, f.task_id).await.into_active_model();
        active.source_kind = Set(None);
        active.source_meta = Set(None);
        active.update(&f.engine.db.conn).await.expect("clear source");

        f.engine
            .forge_writeback(f.task_id, WritebackOutcome::Merged("abc1234".into()))
            .await;
        assert!(f.forge.comments.lock().await.is_empty());
    }

    /// The engine has to be listening to the event bus BEFORE it starts its
    /// boot work, not after: the bus drops what it broadcasts while nobody is
    /// subscribed, so a task the user starts during boot would emit its
    /// `TurnComplete` into nothing and sit `running` forever — the reconcile
    /// sweep deliberately leaves rows whose connection is still live to
    /// `on_event`.
    ///
    /// Pinned without timing games. A `merging` row parks the boot pass on the
    /// folder's git lock, which this test holds, so the engine is provably
    /// still inside boot work when the event goes out; and the queued row
    /// flipping to `failed` is the boot pass announcing it got that far.
    #[tokio::test]
    async fn boot_work_does_not_swallow_the_events_published_under_it() {
        use crate::db::test_helpers::{fresh_in_memory_db, seed_folder};
        use sea_orm::{ActiveModelTrait, Set};

        let dir = tempfile::tempdir().expect("tempdir");
        git_run(dir.path(), &["init", "-q", "-b", "main"]);
        std::fs::write(dir.path().join("a.txt"), "one\n").expect("write");
        git_run(dir.path(), &["add", "-A"]);
        git_run(dir.path(), &["commit", "-q", "-m", "base"]);

        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, dir.path().to_str().expect("utf-8 path")).await;
        let draft = |title: &str| crate::models::WorkTaskDraft {
            folder_id,
            title: title.to_string(),
            config: serde_json::json!({ "display_text": title }),
        };

        // Interrupted by the restart — the boot pass fails it, which is how
        // this test learns the pass has begun.
        let interrupted = work_task_service::create(&db.conn, draft("interrupted"))
            .await
            .expect("task");
        work_task_service::claim_for_run(&db.conn, interrupted.id, WorkTaskStatus::Todo, "test")
            .await
            .expect("claim")
            .expect("claimed");

        // The row that parks the boot pass on the folder's git lock.
        let now = chrono::Utc::now();
        let merging = crate::db::entities::work_task::ActiveModel {
            folder_id: Set(folder_id),
            title: Set("mid-merge".to_string()),
            config: Set("{}".to_string()),
            status: Set(WorkTaskStatus::Merging),
            run_seq: Set(1),
            sort_order: Set(0),
            base_branch: Set(Some("main".to_string())),
            work_branch: Set(Some("task/1".to_string())),
            merge_state: Set(Some(
                serde_json::to_string(&WorkTaskMergeState {
                    op: WorkTaskMergeOp::Land,
                    strategy: "merge".into(),
                    ..Default::default()
                })
                .expect("state"),
            )),
            created_at: Set(now),
            updated_at: Set(now),
            ..Default::default()
        }
        .insert(&db.conn)
        .await
        .expect("merging row");

        let engine = test_engine(db);
        let lock = engine.folder_lock(folder_id).await;
        let guard = lock.lock().await;

        let driver = engine.clone();
        tokio::spawn(async move { run_task_engine(driver).await });

        let probe = engine.clone();
        wait_for("the boot pass to start", move || {
            let probe = probe.clone();
            async move { row(&probe, interrupted.id).await.status == WorkTaskStatus::Failed }
        })
        .await;

        // A run the user starts while boot is still going. Created HERE, after
        // the boot pass swept the interrupted rows, so nothing but the event
        // below can settle it.
        let live = work_task_service::create(&engine.db.conn, draft("started during boot"))
            .await
            .expect("task");
        let conv = conversation_service::create(
            &engine.db.conn,
            folder_id,
            AgentType::ClaudeCode,
            None,
            None,
        )
        .await
        .expect("conversation");
        let run_seq =
            work_task_service::claim_for_run(&engine.db.conn, live.id, WorkTaskStatus::Todo, "test")
                .await
                .expect("claim")
                .expect("claimed");
        assert!(work_task_service::begin_setup(&engine.db.conn, live.id, run_seq)
            .await
            .expect("begin_setup"));
        assert!(work_task_service::mark_running(
            &engine.db.conn,
            live.id,
            run_seq,
            conv.id,
            PARENT_CONN
        )
        .await
        .expect("mark_running"));
        engine
            .index
            .lock()
            .await
            .insert(PARENT_CONN.into(), (live.id, run_seq));
        // A LIVE connection, so the reconcile sweep keeps its hands off the row
        // — which is exactly the production shape that makes a lost
        // `TurnComplete` permanent.
        engine
            .manager
            .insert_test_connection(
                PARENT_CONN,
                AgentType::ClaudeCode,
                None,
                crate::web::event_bridge::EventEmitter::Noop,
            )
            .await;

        engine.bus.send(std::sync::Arc::new(env(
            PARENT_CONN,
            AcpEvent::TurnComplete {
                session_id: "s-1".into(),
                stop_reason: "end_turn".into(),
                agent_type: "claude_code".into(),
            },
        )));

        // Boot can finish now; the event has to survive it.
        drop(guard);
        let probe = engine.clone();
        wait_for("the settle from an event published during boot", move || {
            let probe = probe.clone();
            async move { row(&probe, live.id).await.status == WorkTaskStatus::Review }
        })
        .await;
        assert_eq!(
            row(&engine, merging.id).await.status,
            WorkTaskStatus::Review,
            "the parked boot pass still ran to completion"
        );
    }

    /// Nothing makes an agent commit before its task lands in review — the
    /// merge generation's prompt starts by committing whatever is left over —
    /// so a task whose new files are still untracked has done work all the
    /// same. Reading it as "changed nothing" would put "complete" on the card
    /// and let the user close a task whose work never lands.
    #[tokio::test]
    async fn work_the_agent_never_committed_still_counts() {
        let f = delivery_fixture(FakeForge::default()).await;
        // Undo the fixture's commit, leaving its content in the worktree as an
        // uncommitted edit, and add a new file nobody ran `git add` on.
        git_run(&f.worktree, &["reset", "-q", "--mixed", "HEAD~1"]);
        std::fs::write(f.worktree.join("fresh.txt"), "a\nb\n").expect("write");

        let stats = f.engine.snapshot_diff_stats(f.task_id).await.expect("stats");
        assert_eq!(stats, (2, 3, 0), "the edit and the new file both count");
        let task = row(&f.engine, f.task_id).await;
        assert!(
            f.engine
                .has_landable_changes(&task, f.worktree.to_str().unwrap())
                .await
                .expect("landable probe"),
            "completing this task would strand real work"
        );
    }

    /// Base content the branch ABSORBED is not this task's work. An agent that
    /// merges the base branch in — or rebases onto it — brings every commit the
    /// base gained along, and measuring from the commit the task branched off
    /// would count all of it: a task that added one line would report the whole
    /// week's work, and the counters decide which acceptance the board offers.
    #[tokio::test]
    async fn base_content_the_branch_absorbed_is_not_the_tasks_work() {
        let f = delivery_fixture(FakeForge::default()).await;
        // The task's own contribution, as the fixture left it.
        assert_eq!(
            f.engine.snapshot_diff_stats(f.task_id).await,
            Some((1, 1, 0))
        );

        // The base branch moves on, and the worktree takes it in.
        git_run(&f.root, &["checkout", "-q", "main"]);
        std::fs::write(f.root.join("later.txt"), "one\ntwo\nthree\n").expect("write");
        git_run(&f.root, &["add", "-A"]);
        git_run(&f.root, &["commit", "-qm", "the base moves on"]);
        git_run(&f.worktree, &["merge", "-q", "--no-edit", "main"]);

        assert_eq!(
            f.engine.snapshot_diff_stats(f.task_id).await,
            Some((1, 1, 0)),
            "the merged-in base branch is not this task's change set"
        );
        let task = row(&f.engine, f.task_id).await;
        assert!(
            f.engine
                .has_landable_changes(&task, f.worktree.to_str().unwrap())
                .await
                .expect("landable probe"),
            "…and its own commit is still there to land"
        );
    }

    // ── tasks that ARE a pull request ───────────────────────────────────────

    /// Re-stamp the delivery fixture's task as one triggered from a pull
    /// request: same repository and worktree, different provenance — and a
    /// head branch (`feature`) that is deliberately NOT the task's own branch,
    /// so a push to the wrong one is visible.
    async fn as_pull_request_task(f: &Delivery, pr: ForgePr) {
        use sea_orm::{ActiveModelTrait, IntoActiveModel, Set};
        let meta = serde_json::json!({
            "provider": "github",
            "server_host": "github.com",
            "api_base": "https://api.github.com",
            "account_id": "acc-1",
            "owner_repo": "acme/app",
            "number": 7,
            "url": "https://github.com/acme/app/pull/7",
            "title": "Fix the login flow",
            "base_ref": "main",
            "head_ref": pr.head_ref,
            "head_sha": pr.head_sha,
            // Canonical casing, as GitHub answers it — the fork test is a
            // comparison, and an exact one would call this a fork.
            "head_repo": pr.head_repo,
        });
        let mut active = row(&f.engine, f.task_id).await.into_active_model();
        active.source_kind = Set(Some(SOURCE_KIND_PR.to_string()));
        active.source_key = Set(Some("github:github.com:acme/app:pr:7".to_string()));
        active.source_meta = Set(Some(meta.to_string()));
        active.update(&f.engine.db.conn).await.expect("as a pull request task");
    }

    fn open_pull(head_sha: &str, head_ref: &str, head_repo: &str) -> ForgePr {
        ForgePr {
            number: 7,
            html_url: "https://github.test/acme/app/pull/7".into(),
            state: "open".into(),
            merged: false,
            head_sha: head_sha.into(),
            head_ref: head_ref.into(),
            head_repo: head_repo.into(),
            base_ref: "main".into(),
        }
    }

    /// A repository on `main` that also carries a `feature` branch the project
    /// checkout is NOT on. Returns `(engine, task id, home, feature tip, main
    /// tip)`; the task's config is whatever the caller passes.
    async fn branch_choice_fixture(
        config: serde_json::Value,
    ) -> (Arc<TaskEngine>, i32, tempfile::TempDir, String, String) {
        use sea_orm::{ActiveModelTrait, Set};

        let home = tempfile::tempdir().expect("tempdir");
        let root = home.path().join("repo");
        std::fs::create_dir_all(&root).expect("mkdir");
        git_run(&root, &["init", "-q", "-b", "main"]);
        std::fs::write(root.join("a.txt"), "one\n").expect("write");
        git_run(&root, &["add", "-A"]);
        git_run(&root, &["commit", "-q", "-m", "base"]);
        // The branch the user wants this task to work on…
        git_run(&root, &["checkout", "-q", "-b", "feature"]);
        std::fs::write(root.join("feature.txt"), "the feature\n").expect("write");
        git_run(&root, &["add", "-A"]);
        git_run(&root, &["commit", "-q", "-m", "the feature so far"]);
        let feature_tip = task_git::rev_parse(root.to_str().unwrap(), "HEAD")
            .await
            .expect("feature tip");
        // …and the branch the project folder happens to be sitting on.
        git_run(&root, &["checkout", "-q", "main"]);
        std::fs::write(root.join("b.txt"), "meanwhile\n").expect("write");
        git_run(&root, &["add", "-A"]);
        git_run(&root, &["commit", "-q", "-m", "main moves on"]);
        let main_tip = task_git::rev_parse(root.to_str().unwrap(), "HEAD")
            .await
            .expect("main tip");

        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let folder_id = crate::db::test_helpers::seed_folder(&db, root.to_str().unwrap()).await;
        let now = chrono::Utc::now();
        let task = crate::db::entities::work_task::ActiveModel {
            folder_id: Set(folder_id),
            title: Set("Polish the feature".to_string()),
            config: Set(config.to_string()),
            status: Set(WorkTaskStatus::Todo),
            run_seq: Set(1),
            sort_order: Set(0),
            created_at: Set(now),
            updated_at: Set(now),
            ..Default::default()
        }
        .insert(&db.conn)
        .await
        .expect("insert task");

        (test_engine(db), task.id, home, feature_tip, main_tip)
    }

    /// The task says which branch it is for, and that is where it starts and
    /// what it lands back onto — whatever the project folder happens to be
    /// checked out on when the task is claimed.
    #[tokio::test]
    async fn a_task_starts_on_the_base_branch_it_was_created_for() {
        let (engine, task_id, home, feature_tip, _main_tip) =
            branch_choice_fixture(serde_json::json!({ "base_branch": "feature" })).await;
        let task = row(&engine, task_id).await;
        let root = get_folder_core(&engine.db, task.folder_id).await.expect("root");

        let wt = engine
            .ensure_worktree(&task, &root, &WorkTaskFolderSettings::default())
            .await
            .expect("worktree");

        assert_eq!(
            task_git::rev_parse(&wt.path, "HEAD").await.expect("head"),
            feature_tip,
            "the worktree starts at the chosen branch's tip"
        );
        let after = row(&engine, task_id).await;
        assert_eq!(
            after.base_branch.as_deref(),
            Some("feature"),
            "the merge lands back onto the branch the task was created for"
        );
        assert_eq!(after.base_sha.as_deref(), Some(feature_tip.as_str()));
        drop(home);
    }

    /// No choice recorded — every task created before this existed, and every
    /// task of a user who does not care — keeps branching from the project
    /// folder's current checkout.
    #[tokio::test]
    async fn a_task_without_a_chosen_branch_still_follows_the_checkout() {
        let (engine, task_id, home, _feature_tip, main_tip) =
            branch_choice_fixture(serde_json::json!({})).await;
        let task = row(&engine, task_id).await;
        let root = get_folder_core(&engine.db, task.folder_id).await.expect("root");

        engine
            .ensure_worktree(&task, &root, &WorkTaskFolderSettings::default())
            .await
            .expect("worktree");

        let after = row(&engine, task_id).await;
        assert_eq!(after.base_branch.as_deref(), Some("main"));
        assert_eq!(after.base_sha.as_deref(), Some(main_tip.as_str()));
        drop(home);
    }

    /// A branch that is gone by the time the task is claimed must not quietly
    /// fall back to the checkout: the whole point of the choice is that the
    /// work lands somewhere specific, and starting from `main` instead would
    /// be a wrong answer delivered silently.
    #[tokio::test]
    async fn a_chosen_branch_that_disappeared_refuses_instead_of_falling_back() {
        let (engine, task_id, home, _feature_tip, _main_tip) =
            branch_choice_fixture(serde_json::json!({ "base_branch": "gone" })).await;
        let task = row(&engine, task_id).await;
        let root = get_folder_core(&engine.db, task.folder_id).await.expect("root");

        let err = engine
            .ensure_worktree(&task, &root, &WorkTaskFolderSettings::default())
            .await
            .err()
            .expect("must refuse");
        assert!(err.contains("gone"), "{err}");
        assert!(row(&engine, task_id).await.worktree_folder_id.is_none());
        drop(home);
    }

    /// A repository that HAS a proposed change: `origin` carries `main` (moved
    /// on since), the contributor's `feature` branch, and the server-side head
    /// ref the forge publishes for it — `refs/pull/7/head` on GitHub,
    /// `refs/merge_requests/7/head` on GitLab. Parameterized by forge because
    /// that ref name is the ONE thing setup cannot guess: the wrong spelling
    /// is simply a ref that does not exist.
    ///
    /// `root` is a clone — the project folder. Returns `(engine, task id, root
    /// path, head commit, merge base)`.
    async fn pull_checkout_fixture(
        head_sha_recorded: Option<&str>,
        provider: crate::forge::ForgeProvider,
    ) -> (Arc<TaskEngine>, i32, tempfile::TempDir, String, String) {
        use sea_orm::{ActiveModelTrait, Set};

        let home = tempfile::tempdir().expect("tempdir");
        let origin = home.path().join("origin");
        std::fs::create_dir_all(&origin).expect("mkdir");
        git_run(&origin, &["init", "-q", "-b", "main"]);
        std::fs::write(origin.join("a.txt"), "one\n").expect("write");
        git_run(&origin, &["add", "-A"]);
        git_run(&origin, &["commit", "-q", "-m", "base"]);
        let branch_point = task_git::rev_parse(origin.to_str().unwrap(), "HEAD")
            .await
            .expect("branch point");
        // The contributor's work…
        git_run(&origin, &["checkout", "-q", "-b", "feature"]);
        std::fs::write(origin.join("feature.txt"), "the contribution\n").expect("write");
        git_run(&origin, &["add", "-A"]);
        git_run(&origin, &["commit", "-q", "-m", "the pull request"]);
        let pull_head = task_git::rev_parse(origin.to_str().unwrap(), "HEAD")
            .await
            .expect("pull head");
        git_run(&origin, &["update-ref", &provider.change_head_ref(7), &pull_head]);
        // …and the base branch moving on underneath it, which is what makes
        // "merge base" and "base tip" different commits.
        git_run(&origin, &["checkout", "-q", "main"]);
        std::fs::write(origin.join("b.txt"), "meanwhile\n").expect("write");
        git_run(&origin, &["add", "-A"]);
        git_run(&origin, &["commit", "-q", "-m", "main moves on"]);

        let root = home.path().join("root");
        git_run(
            home.path(),
            &["clone", "-q", origin.to_str().unwrap(), root.to_str().unwrap()],
        );

        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let folder_id = crate::db::test_helpers::seed_folder(&db, root.to_str().unwrap()).await;
        let meta = serde_json::json!({
            "provider": provider.as_str(),
            "server_host": "github.com",
            "api_base": "https://api.github.com",
            "account_id": "acc-1",
            "owner_repo": "acme/app",
            "number": 7,
            "url": "https://github.com/acme/app/pull/7",
            "title": "The contribution",
            "base_ref": "main",
            "head_ref": "feature",
            "head_sha": head_sha_recorded.unwrap_or(&pull_head),
            "head_repo": "acme/app",
        });
        let now = chrono::Utc::now();
        let task = crate::db::entities::work_task::ActiveModel {
            folder_id: Set(folder_id),
            title: Set("#7 · The contribution".to_string()),
            config: Set("{}".to_string()),
            status: Set(WorkTaskStatus::Todo),
            run_seq: Set(1),
            sort_order: Set(0),
            source_kind: Set(Some(SOURCE_KIND_PR.to_string())),
            source_key: Set(Some(format!("{}:github.com:acme/app:pr:7", provider.as_str()))),
            source_meta: Set(Some(meta.to_string())),
            created_at: Set(now),
            updated_at: Set(now),
            ..Default::default()
        }
        .insert(&db.conn)
        .await
        .expect("insert task");
        // The fake forge, because setup now fetches through the pinned account
        // rather than the folder's `origin` — and resolving that account for
        // real would read the OS keyring, which a unit test must never do. The
        // fake fetches from this fixture's local `origin` instead.
        (
            test_engine_with_forge(db, Arc::new(FakeForge::default())),
            task.id,
            home,
            pull_head,
            branch_point,
        )
    }

    /// A pull-request task starts ON the pull request, and its review diff is
    /// measured from the MERGE BASE — so the pull request's own changes are
    /// part of what gets reviewed, and the base branch's unrelated progress is
    /// not.
    #[tokio::test]
    async fn a_pull_request_task_checks_out_the_pull_request_head() {
        let (engine, task_id, home, pull_head, branch_point) =
            pull_checkout_fixture(None, crate::forge::ForgeProvider::GitHub).await;
        let task = row(&engine, task_id).await;
        let root = get_folder_core(&engine.db, task.folder_id).await.expect("root");

        let wt = engine
            .ensure_worktree(&task, &root, &WorkTaskFolderSettings::default())
            .await
            .expect("worktree");

        assert_eq!(
            task_git::rev_parse(&wt.path, "HEAD").await.expect("head"),
            pull_head,
            "the worktree starts at the pull request's head"
        );
        let after = row(&engine, task_id).await;
        assert_eq!(after.base_branch.as_deref(), Some("main"));
        assert_eq!(
            after.base_sha.as_deref(),
            Some(branch_point.as_str()),
            "the diff baseline is where the pull request branched off"
        );
        let changed = task_git::diff_numstat(&wt.path, &branch_point)
            .await
            .expect("diff");
        assert!(
            changed.iter().any(|f| f.file == "feature.txt"),
            "the pull request's own change must be inside the review diff: {changed:?}"
        );
        assert!(
            !changed.iter().any(|f| f.file == "b.txt"),
            "the base branch's later commits are not this task's work: {changed:?}"
        );
        drop(home);
    }

    /// The counters on the row are the TASK's own work, which on a
    /// pull-request task is NOT the review diff: the worktree starts on the
    /// pull request, so the whole contribution is already there before the
    /// agent does anything. A review-only run — findings reported, nothing
    /// committed — has to settle at zero, or the board hides "complete" behind
    /// a delivery that would push an empty change.
    #[tokio::test]
    async fn a_pull_request_task_counts_only_what_the_agent_added() {
        let (engine, task_id, home, _pull_head, branch_point) =
            pull_checkout_fixture(None, crate::forge::ForgeProvider::GitHub).await;
        let task = row(&engine, task_id).await;
        let root = get_folder_core(&engine.db, task.folder_id).await.expect("root");
        let wt = engine
            .ensure_worktree(&task, &root, &WorkTaskFolderSettings::default())
            .await
            .expect("worktree");
        let task = row(&engine, task_id).await;

        // What the user reviews still holds the pull request itself…
        let reviewed = task_git::diff_numstat(&wt.path, &branch_point)
            .await
            .expect("review diff");
        assert!(
            reviewed.iter().any(|f| f.file == "feature.txt"),
            "the review diff is unchanged: {reviewed:?}"
        );
        // …while the task's own contribution is empty, on both the recorded
        // stat and the live probe the acceptances re-ask.
        assert_eq!(
            engine.snapshot_diff_stats(task_id).await,
            Some((0, 0, 0)),
            "a review-only run changed nothing"
        );
        assert!(!engine
            .has_landable_changes(&task, &wt.path)
            .await
            .expect("landable probe"));

        // A round that does commit is counted — and only its own file.
        std::fs::write(Path::new(&wt.path).join("fix.txt"), "the agent's work\n").expect("write");
        git_run(Path::new(&wt.path), &["add", "-A"]);
        git_run(Path::new(&wt.path), &["commit", "-qm", "the agent's fix"]);
        assert_eq!(
            engine.snapshot_diff_stats(task_id).await,
            Some((1, 1, 0)),
            "the agent's file, not the pull request's"
        );
        assert!(engine
            .has_landable_changes(&task, &wt.path)
            .await
            .expect("landable probe"));
        drop(home);
    }

    /// The same rule on the path that made it matter: a pull-request task whose
    /// agent wrote a file and never added it. The counters have to say the task
    /// did something, the drawer has to list the same file the counters count,
    /// and completing has to refuse — closing it here would leave work that
    /// nothing is going to land (delivery cannot push an uncommitted tree
    /// either; it says so and asks for another round). The ignore rules are
    /// pinned where they are applied, in
    /// `git::tests::the_acceptance_measure_sees_work_that_was_never_committed`.
    #[tokio::test]
    async fn an_untracked_file_keeps_a_pull_request_task_out_of_complete() {
        use sea_orm::{ActiveModelTrait, IntoActiveModel, Set};
        let (engine, task_id, home, _pull_head, _branch_point) =
            pull_checkout_fixture(None, crate::forge::ForgeProvider::GitHub).await;
        let task = row(&engine, task_id).await;
        let root = get_folder_core(&engine.db, task.folder_id).await.expect("root");
        let wt = engine
            .ensure_worktree(&task, &root, &WorkTaskFolderSettings::default())
            .await
            .expect("worktree");

        std::fs::write(Path::new(&wt.path).join("findings.md"), "one\ntwo\n").expect("write");

        assert_eq!(
            engine.snapshot_diff_stats(task_id).await,
            Some((1, 2, 0)),
            "an uncommitted new file is still this task's work"
        );
        let listed = crate::commands::work_task::work_task_changed_files_core(&engine.db, task_id)
            .await
            .expect("changed files");
        assert!(
            listed.iter().any(|f| f.file == "findings.md"),
            "the drawer must list what the card counts: {listed:?}"
        );

        let mut active = row(&engine, task_id).await.into_active_model();
        active.status = Set(WorkTaskStatus::Review);
        active.update(&engine.db.conn).await.expect("into review");
        let refused = engine
            .complete_task(task_id, false)
            .await
            .expect_err("the work is still sitting there");
        assert!(refused.contains("changed files after all"), "{refused}");
        assert_eq!(
            row(&engine, task_id).await.status,
            WorkTaskStatus::Review,
            "a refused completion leaves the task where it was"
        );
        drop(home);
    }

    /// The counters are written once, when the run settles, and every board
    /// decision reads them afterwards — so a row can outlive what it describes
    /// (a worktree committed to since, or a pull-request task settled by a
    /// build that credited it with the pull request's own files). The boot pass
    /// re-measures whatever is still sitting in review.
    #[tokio::test]
    async fn the_boot_pass_re_measures_a_review_row() {
        use sea_orm::{ActiveModelTrait, IntoActiveModel, Set};
        let (engine, task_id, home, _pull_head, _branch_point) =
            pull_checkout_fixture(None, crate::forge::ForgeProvider::GitHub).await;
        let task = row(&engine, task_id).await;
        let root = get_folder_core(&engine.db, task.folder_id).await.expect("root");
        engine
            .ensure_worktree(&task, &root, &WorkTaskFolderSettings::default())
            .await
            .expect("worktree");

        // The row an older build left behind: in review, carrying the pull
        // request's change set as if the task had written it.
        let mut active = row(&engine, task_id).await.into_active_model();
        active.status = Set(WorkTaskStatus::Review);
        active.files_changed = Set(Some(1));
        active.additions = Set(Some(1));
        active.deletions = Set(Some(0));
        active.update(&engine.db.conn).await.expect("stale review row");

        engine.refresh_review_diff_stats().await;

        let after = row(&engine, task_id).await;
        assert_eq!(
            (after.files_changed, after.additions, after.deletions),
            (Some(0), Some(0), Some(0)),
            "the corrected counters are what the board reads"
        );
        assert_eq!(after.status, WorkTaskStatus::Review, "nothing else moved");
        drop(home);
    }

    /// The same setup against GitLab. Everything downstream — the merge-base
    /// baseline, the pinned OID, the review diff — is shared code; what is NOT
    /// shared is the ref the head is published under, and fetching GitHub's
    /// spelling from a GitLab server finds nothing at all.
    #[tokio::test]
    async fn a_merge_request_task_checks_out_the_gitlab_head_ref() {
        let (engine, task_id, home, mr_head, branch_point) =
            pull_checkout_fixture(None, crate::forge::ForgeProvider::GitLab).await;
        let task = row(&engine, task_id).await;
        let root = get_folder_core(&engine.db, task.folder_id).await.expect("root");

        let wt = engine
            .ensure_worktree(&task, &root, &WorkTaskFolderSettings::default())
            .await
            .expect("worktree");

        assert_eq!(
            task_git::rev_parse(&wt.path, "HEAD").await.expect("head"),
            mr_head,
            "the worktree starts at the merge request's head"
        );
        assert_eq!(
            row(&engine, task_id).await.base_sha.as_deref(),
            Some(branch_point.as_str()),
            "the diff baseline is where the merge request branched off"
        );
        drop(home);
    }

    /// A pull request force-pushed since the task was created no longer has
    /// the commit the user triggered on. Checking out the NEW head would run
    /// the task against code nobody chose, so setup fails and says so.
    #[tokio::test]
    async fn a_force_pushed_pull_request_refuses_instead_of_switching_commits() {
        let gone = "0123456789012345678901234567890123456789";
        let (engine, task_id, home, _pull_head, _base) =
            pull_checkout_fixture(Some(gone), crate::forge::ForgeProvider::GitHub).await;
        let task = row(&engine, task_id).await;
        let root = get_folder_core(&engine.db, task.folder_id).await.expect("root");

        let err = engine
            .ensure_worktree(&task, &root, &WorkTaskFolderSettings::default())
            .await
            .err()
            .expect("must refuse");
        assert!(err.contains("force-pushed"), "{err}");
        assert!(row(&engine, task_id).await.worktree_folder_id.is_none());
        drop(home);
    }

    /// The window between "we checked" and "we pushed" is real, and what the
    /// pull request looks like AFTER the push is what the card will claim. A
    /// review that was closed, or retargeted at another base, is not a
    /// delivery — the task says so instead of recording `done`.
    #[tokio::test]
    async fn a_push_back_does_not_settle_against_a_review_that_moved() {
        for (label, mutate, expect) in [
            (
                "closed while we pushed",
                Box::new(|pr: &mut ForgePr| pr.state = "closed".into()) as Box<dyn Fn(&mut ForgePr)>,
                "closed without merging",
            ),
            (
                "retargeted while we pushed",
                Box::new(|pr: &mut ForgePr| pr.base_ref = "release/1.x".into()),
                "now targets 'release/1.x'",
            ),
        ] {
            let pr = open_pull("whatever-the-branch-points-at", "feature", "Acme/App");
            let mut moved = pr.clone();
            mutate(&mut moved);
            let f = delivery_fixture(FakeForge {
                after_push: Mutex::new(Some(moved)),
                ..Default::default()
            })
            .await;
            as_pull_request_task(&f, pr.clone()).await;
            f.forge.existing.lock().await.push(pr);

            let err = f
                .engine
                .deliver_pr(f.task_id, None, false, false)
                .await
                .err()
                .unwrap_or_else(|| panic!("{label}: must not settle"));
            assert!(err.contains(expect), "{label}: {err}");
            // The push itself DID happen — the work is safe on the branch, and
            // the message says where it went. What is refused is calling it a
            // finished delivery.
            assert_eq!(f.forge.pushes.lock().await.len(), 1, "{label}");
            let task = row(&f.engine, f.task_id).await;
            assert_eq!(task.status, WorkTaskStatus::Review, "{label}");
        }
    }

    /// Merged in that same window is the opposite answer — but ONLY when what
    /// merged is what we pushed. The losing order is real: someone merges the
    /// old head, we push on top, and the reread says "merged" about a merge
    /// our commits are not in.
    #[tokio::test]
    async fn a_push_back_settles_on_a_merge_only_when_it_contains_our_commit() {
        // Merged AT the commit this delivery pushed: the work landed.
        let pr = open_pull("whatever-the-branch-points-at", "feature", "Acme/App");
        let mut merged_ours = pr.clone();
        merged_ours.state = "closed".into();
        merged_ours.merged = true;
        let f = delivery_fixture(FakeForge::default()).await;
        as_pull_request_task(&f, pr.clone()).await;
        f.forge.existing.lock().await.push(pr.clone());
        // `f.head` is the commit the task branch points at — what the push
        // publishes, and therefore what a merge containing our work reports.
        merged_ours.head_sha = f.head.clone();
        *f.forge.after_push.lock().await = Some(merged_ours);
        f.engine
            .deliver_pr(f.task_id, None, false, false)
            .await
            .expect("merged at our commit is a delivery");
        assert_eq!(row(&f.engine, f.task_id).await.status, WorkTaskStatus::Done);

        // Merged at a DESCENDANT of what we pushed: someone fast-forwarded on
        // top of this task's work and merged that. Our commits are in it, so
        // it IS the delivery — equality alone would have rejected this.
        let pr = open_pull("whatever-the-branch-points-at", "feature", "Acme/App");
        let f = delivery_fixture(FakeForge::default()).await;
        as_pull_request_task(&f, pr.clone()).await;
        f.forge.existing.lock().await.push(pr.clone());
        // A real child commit of the task's head, published where the forge
        // publishes a change's head.
        git_run(&f.worktree, &["commit", "-q", "--allow-empty", "-m", "on top of the task"]);
        let descendant = task_git::rev_parse(f.worktree.to_str().unwrap(), "HEAD")
            .await
            .expect("descendant");
        git_run(&f.root, &["update-ref", "refs/pull/7/head", &descendant]);
        // …and the task branch put back, so what the delivery pushes is still
        // this task's own head.
        git_run(&f.worktree, &["reset", "-q", "--hard", &f.head]);
        let mut merged_on_top = pr.clone();
        merged_on_top.state = "closed".into();
        merged_on_top.merged = true;
        merged_on_top.head_sha = descendant;
        *f.forge.after_push.lock().await = Some(merged_on_top);
        f.engine
            .deliver_pr(f.task_id, None, false, false)
            .await
            .expect("a merge that contains our commit is a delivery");
        assert_eq!(row(&f.engine, f.task_id).await.status, WorkTaskStatus::Done);
        assert!(
            probe_refs(&f.root).await.is_empty(),
            "the ancestry probe cleans up after itself"
        );

        // Merged at SOMETHING ELSE while we were pushing: our commits are on
        // the branch and not in that merge, and the card must not say done.
        let pr = open_pull("whatever-the-branch-points-at", "feature", "Acme/App");
        let f = delivery_fixture(FakeForge::default()).await;
        as_pull_request_task(&f, pr.clone()).await;
        f.forge.existing.lock().await.push(pr.clone());
        // The published head is the base commit — a real commit, and NOT a
        // descendant of this task's work.
        git_run(&f.root, &["update-ref", "refs/pull/7/head", &f.base_sha]);
        let mut merged_theirs = pr;
        merged_theirs.state = "closed".into();
        merged_theirs.merged = true;
        merged_theirs.head_sha = f.base_sha.clone();
        *f.forge.after_push.lock().await = Some(merged_theirs);
        let err = f
            .engine
            .deliver_pr(f.task_id, None, false, false)
            .await
            .expect_err("a merge without our commit is not a delivery");
        assert!(err.contains("does not contain it"), "{err}");
        assert_eq!(row(&f.engine, f.task_id).await.status, WorkTaskStatus::Review);
        // The scratch ref is scoped to the task (siblings in one folder do not
        // share a lock) and is gone whichever way the answer went — on this
        // failing path as much as on the settling one above.
        assert!(
            probe_refs(&f.root).await.is_empty(),
            "no scratch ref may survive a refusal either"
        );
    }

    /// Every `refs/codeg/*` ref left in a repository — the engine's scratch
    /// namespace, which nothing outside it may ever find.
    async fn probe_refs(root: &std::path::Path) -> Vec<String> {
        let out = crate::process::tokio_command("git")
            .args(["for-each-ref", "--format=%(refname)", "refs/codeg/"])
            .current_dir(root)
            .output()
            .await
            .expect("for-each-ref");
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(str::to_string)
            .collect()
    }

    /// The delivery of a pull-request task is a push back onto that pull
    /// request's OWN branch. Nothing is created — the review the user is
    /// already looking at is where the work belongs.
    #[tokio::test]
    async fn a_pull_request_task_is_pushed_back_to_its_own_branch() {
        let f = delivery_fixture(FakeForge::default()).await;
        let pr = open_pull("whatever-the-branch-points-at", "feature", "Acme/App");
        as_pull_request_task(&f, pr.clone()).await;
        f.forge.existing.lock().await.push(pr);

        let url = f
            .engine
            .deliver_pr(f.task_id, Some("ignored".into()), false, false)
            .await
            .expect("push back");
        assert_eq!(url, "https://github.test/acme/app/pull/7");
        assert_eq!(
            f.forge.pushes.lock().await.as_slice(),
            [("acme/app".to_string(), "task/7".to_string(), "feature".to_string())],
            "the work branch goes to the pull request's head branch"
        );
        assert!(
            f.forge.created.lock().await.is_empty(),
            "a pull request that exists is not opened a second time"
        );
        let task = row(&f.engine, f.task_id).await;
        assert_eq!(task.status, WorkTaskStatus::Done);
        assert_eq!(task.completion_kind.as_deref(), Some("delivered_pr"));
        assert_eq!(
            task.source_meta
                .as_deref()
                .and_then(|s| serde_json::from_str::<ForgeSourceMeta>(s).ok())
                .and_then(|m| m.result_pr)
                .as_deref(),
            Some("https://github.test/acme/app/pull/7")
        );
    }

    /// A pull request from a FORK pushes back to the fork — that is where its
    /// branch lives, and where its author and reviewers are looking. The
    /// repository in the push is the fork's; every API call stays on the
    /// source repository.
    #[tokio::test]
    async fn a_fork_pull_request_task_pushes_back_to_the_fork() {
        let f = delivery_fixture(FakeForge::default()).await;
        // Canonical casing, as the API answers it — the push URL normalizes.
        let pr = open_pull("whatever-the-branch-points-at", "feature", "Contributor/App");
        as_pull_request_task(&f, pr.clone()).await;
        f.forge.existing.lock().await.push(pr);

        f.engine.deliver_pr(f.task_id, None, false, false).await.expect("fork push back");
        assert_eq!(
            f.forge.pushes.lock().await.as_slice(),
            [("contributor/app".to_string(), "task/7".to_string(), "feature".to_string())],
            "the push lands in the fork, not in the source repository"
        );
        let task = row(&f.engine, f.task_id).await;
        assert_eq!(task.status, WorkTaskStatus::Done);
        assert_eq!(task.completion_kind.as_deref(), Some("delivered_pr"));
    }

    /// A push back with nothing new is REFUSED, and the acceptance that fits
    /// takes over. The task's branch is the pull request's own head — a review
    /// turn that committed nothing — so a delivery would push nothing, leave
    /// the pull request exactly as it was, and still record the task as
    /// delivered to it. The board offers "complete" for this row (nothing of
    /// its own to land); the backend has to agree, or the two disagree about
    /// the same task.
    ///
    /// The review-only task on a fork this account cannot write to is still
    /// accepted — completing needs no write access at all, and the fake here
    /// would fail any push.
    #[tokio::test]
    async fn a_push_back_with_nothing_new_is_refused_for_completing() {
        let forge = FakeForge {
            push_error: Some("403: permission denied".into()),
            ..FakeForge::default()
        };
        let f = delivery_fixture(forge).await;
        // The pull request's head IS the task branch's head: nothing to push.
        let pr = open_pull(&f.head, "feature", "contributor/app");
        as_pull_request_task(&f, pr.clone()).await;
        f.forge.existing.lock().await.push(pr);

        let refused = f
            .engine
            .deliver_pr(f.task_id, None, false, false)
            .await
            .expect_err("a delivery with nothing in it");
        assert!(refused.contains("complete it instead"), "{refused}");
        assert!(f.forge.pushes.lock().await.is_empty(), "no push may run");
        assert_eq!(
            row(&f.engine, f.task_id).await.status,
            WorkTaskStatus::Review,
            "a refused delivery leaves the task exactly as it was"
        );

        f.engine
            .complete_task(f.task_id, false)
            .await
            .expect("accepted without touching the fork");
        let task = row(&f.engine, f.task_id).await;
        assert_eq!(task.status, WorkTaskStatus::Done);
        assert_eq!(
            task.completion_kind.as_deref(),
            Some("accepted_without_merge"),
            "…and recorded as what it was, not as a delivery"
        );
    }

    /// The OTHER way a delivery finds nothing to push: its push already landed
    /// and something interrupted the settle. The retry must recognize the pull
    /// request as carrying this task's commit and finish — without pushing
    /// again, which is what lets it complete on a fork this account cannot
    /// write to (the fake here fails any push). Distinguished from the refused
    /// case above by the task actually having work: it was triggered on the
    /// pull request's earlier head and committed on top of it.
    #[tokio::test]
    async fn a_delivery_whose_push_already_landed_settles_without_pushing_again() {
        let forge = FakeForge {
            push_error: Some("403: permission denied".into()),
            ..FakeForge::default()
        };
        let f = delivery_fixture(forge).await;
        as_pull_request_task(&f, open_pull(&f.base_sha, "feature", "contributor/app")).await;
        // What the forge answers today: the task's own commit is already there.
        f.forge
            .existing
            .lock()
            .await
            .push(open_pull(&f.head, "feature", "contributor/app"));

        f.engine
            .deliver_pr(f.task_id, None, false, false)
            .await
            .expect("settled without a push");
        assert!(f.forge.pushes.lock().await.is_empty(), "no push may run");
        let task = row(&f.engine, f.task_id).await;
        assert_eq!(task.status, WorkTaskStatus::Done);
        assert_eq!(task.completion_kind.as_deref(), Some("delivered_pr"));
    }

    /// A row recorded before the head repository was part of the meta (builds
    /// that refused forks at trigger, so same-repo by construction) pushes
    /// where it always did: the source repository.
    #[tokio::test]
    async fn a_push_back_without_a_recorded_head_repo_pushes_to_the_source_repo() {
        let f = delivery_fixture(FakeForge::default()).await;
        let pr = open_pull("whatever-the-branch-points-at", "feature", "");
        as_pull_request_task(&f, pr.clone()).await;
        // What the forge answers TODAY still names the repository.
        f.forge.existing.lock().await.push(open_pull(
            "whatever-the-branch-points-at",
            "feature",
            "acme/app",
        ));

        f.engine.deliver_pr(f.task_id, None, false, false).await.expect("push back");
        assert_eq!(
            f.forge.pushes.lock().await.as_slice(),
            [("acme/app".to_string(), "task/7".to_string(), "feature".to_string())]
        );
        assert_eq!(row(&f.engine, f.task_id).await.status, WorkTaskStatus::Done);
    }

    /// Everything that would make the push land somewhere it does not belong
    /// is refused BEFORE the push, with the task untouched in review.
    #[tokio::test]
    async fn a_push_back_refuses_before_it_pushes_anywhere_wrong() {
        // A closed pull request: the commits would sit on a branch nobody is
        // reviewing any more.
        let closed = delivery_fixture(FakeForge::default()).await;
        let mut pr = open_pull("x", "feature", "acme/app");
        pr.state = "closed".into();
        as_pull_request_task(&closed, pr.clone()).await;
        closed.forge.existing.lock().await.push(pr);
        let err = closed
            .engine
            .deliver_pr(closed.task_id, None, false, false)
            .await
            .expect_err("closed");
        assert!(err.contains("no longer open"), "{err}");
        assert!(closed.forge.pushes.lock().await.is_empty());
        assert_eq!(row(&closed.engine, closed.task_id).await.status, WorkTaskStatus::Review);

        // A fork codeg cannot NAME — GitLab's unresolved `project-{id}`
        // placeholder — has no push URL, ever. Refused before the CAS.
        let fork = delivery_fixture(FakeForge::default()).await;
        as_pull_request_task(&fork, open_pull("x", "feature", "project-4711")).await;
        let err = fork
            .engine
            .deliver_pr(fork.task_id, None, false, false)
            .await
            .expect_err("unnameable fork");
        assert!(err.contains("cannot see"), "{err}");
        assert!(fork.forge.pushes.lock().await.is_empty());
        assert_eq!(row(&fork.engine, fork.task_id).await.status, WorkTaskStatus::Review);

        // Retargeted under us: the pull request now tracks another branch, so
        // pushing to the recorded one delivers into nothing.
        let moved = delivery_fixture(FakeForge::default()).await;
        as_pull_request_task(&moved, open_pull("x", "feature", "acme/app")).await;
        moved
            .forge
            .existing
            .lock()
            .await
            .push(open_pull("x", "someone-elses-branch", "acme/app"));
        let err = moved
            .engine
            .deliver_pr(moved.task_id, None, false, false)
            .await
            .expect_err("retargeted");
        assert!(err.contains("now tracks branch"), "{err}");
        assert!(moved.forge.pushes.lock().await.is_empty());
        assert_eq!(row(&moved.engine, moved.task_id).await.status, WorkTaskStatus::Review);
    }

    /// Landing a pull request's work on the local base would take its changes
    /// in behind the author's back and leave the review open. The refusal is
    /// in the engine, where an old frontend or a direct API call still hits it.
    #[tokio::test]
    async fn a_pull_request_task_is_never_merged_locally() {
        let f = delivery_fixture(FakeForge::default()).await;
        as_pull_request_task(&f, open_pull("x", "feature", "acme/app")).await;
        let err = f
            .engine
            .merge_task(f.task_id, None, false, None, false)
            .await
            .expect_err("must refuse");
        assert!(err.contains("deliver it back"), "{err}");
        assert_eq!(row(&f.engine, f.task_id).await.status, WorkTaskStatus::Review);
    }

    /// The merge dispatch runs its launch off-thread so the click is not held
    /// for the run (a resumed session may compact first — an unbounded turn).
    /// What must NOT change with it: a launch that never gets an agent up still
    /// reports its reason to the caller, and leaves the row settled and unowned
    /// by the time it does. Anything less and the dialog would close on a merge
    /// that silently never started.
    #[tokio::test]
    async fn a_merge_whose_launch_never_goes_live_still_reports_and_settles() {
        let f = delivery_fixture(FakeForge::default()).await;
        // Neither the task nor its folder names an agent, so the launch fails
        // where every launch checks first — before any connection exists.
        let err = f
            .engine
            .merge_task(f.task_id, None, false, None, false)
            .await
            .expect_err("a launch that cannot start must not read as dispatched");
        assert!(err.contains("no agent configured"), "{err}");

        let task = row(&f.engine, f.task_id).await;
        assert_eq!(task.status, WorkTaskStatus::Review, "settled before we returned");
        assert!(
            task.last_error
                .as_deref()
                .unwrap_or_default()
                .contains("merge dispatch failed"),
            "{:?}",
            task.last_error
        );
        assert!(
            f.engine.merging.lock().await.is_empty(),
            "the generation must own nothing once its failure is reported"
        );
    }

    /// Fire-once, from either side. The launch reports itself live; the task
    /// driving it reports every way of failing before that point. A second
    /// report — a launch that fails AFTER going live — must not overwrite the
    /// first, or a dispatch the user was told succeeded would come back as an
    /// error into a dialog that has already closed.
    #[tokio::test]
    async fn the_dispatch_signal_reports_exactly_once() {
        let (signal, live) = DispatchSignal::new();
        signal.fire(Ok(()));
        signal.fire(Err("the round's prompt was refused".to_string()));
        assert_eq!(live.await.expect("sender fired"), Ok(()));

        // …and the other way round: nothing went live, so the failure is what
        // the caller gets.
        let (signal, live) = DispatchSignal::new();
        signal.fire(Err("no agent configured".to_string()));
        signal.fire(Ok(()));
        assert_eq!(
            live.await.expect("sender fired"),
            Err("no agent configured".to_string())
        );

        // A sender dropped without firing is the launch returning early without
        // dispatching (a cancel gate, a lost CAS) — the caller has to notice
        // rather than hang.
        let (signal, live) = DispatchSignal::new();
        drop(signal);
        assert!(live.await.is_err());
    }

    /// Recovery of an interrupted push-back settles on ONE piece of evidence:
    /// the pull request's head IS the commit this delivery was pushing.
    #[tokio::test]
    async fn recovery_settles_a_push_back_only_on_the_commit_it_pushed() {
        for (head_sha, expect_done) in [("<the task head>", true), ("0000000", false)] {
            let f = delivery_fixture(FakeForge::default()).await;
            let sha = if expect_done { f.head.clone() } else { head_sha.to_string() };
            as_pull_request_task(&f, open_pull(&sha, "feature", "acme/app")).await;
            f.forge.existing.lock().await.push(open_pull(&sha, "feature", "acme/app"));
            interrupt_delivery(&f, "feature").await;

            f.engine.recover_merging(f.task_id).await;
            let task = row(&f.engine, f.task_id).await;
            if expect_done {
                assert_eq!(task.status, WorkTaskStatus::Done);
                assert_eq!(task.completion_kind.as_deref(), Some("delivered_pr"));
            } else {
                assert_eq!(task.status, WorkTaskStatus::Review);
                assert!(
                    task.last_error.as_deref().unwrap_or_default().contains("does not show"),
                    "{:?}",
                    task.last_error
                );
            }
        }
    }

    /// Merge states written before deliveries existed carry no `op`. They are
    /// all lands, and reading one as a delivery would send crash recovery to
    /// the forge for a task that never had one.
    #[test]
    fn merge_state_without_an_op_decodes_as_a_land() {
        let legacy = r#"{"pre_merge_head":"abc123","message":"m","strategy":"squash",
                         "delete_worktree":true,"auto_message":false}"#;
        let state: WorkTaskMergeState = serde_json::from_str(legacy).expect("legacy state");
        assert_eq!(state.op, WorkTaskMergeOp::Land);
        assert_eq!(state.pre_merge_head, "abc123");
        assert!(state.delete_worktree);
        assert!(state.expected_head.is_none());
    }

    #[tokio::test]
    async fn delegations_from_a_non_task_connection_are_not_tracked() {
        // A delegation from an ordinary chat tab has no board row to flip; the
        // map must not grow for it.
        let (engine, _task_id) = running_task().await;
        engine.on_event(&delegation_started("conn-chat", "conn-other-child")).await;
        assert!(engine.delegation_parents.lock().await.is_empty());
    }

    // ── pre-prompt context compaction ───────────────────────────────────────

    const COMPACT_CONN: &str = "conn-compact";

    /// A generation parked exactly where `compact_before_prompt` runs: claimed,
    /// setup begun (`preparing`), agent connection live, and — as in the real
    /// launch at this point — nothing in `index` yet.
    struct CompactFixture {
        engine: Arc<TaskEngine>,
        task_id: i32,
        run_seq: i32,
        folder_id: i32,
        conversation_id: i32,
        /// The connection's command channel. Held for the test's duration: a
        /// dropped receiver makes every send fail before it reaches the gate.
        rx: tokio::sync::mpsc::Receiver<crate::acp::connection::ConnectionCommand>,
    }

    async fn compact_fixture(usage: Option<(u64, u64)>) -> CompactFixture {
        use crate::db::test_helpers::{fresh_in_memory_db, seed_folder};

        let db = fresh_in_memory_db().await;
        let folder_id = seed_folder(&db, "/tmp/task-compact").await;
        let conv =
            conversation_service::create(&db.conn, folder_id, AgentType::ClaudeCode, None, None)
                .await
                .expect("conversation");
        let task = work_task_service::create(
            &db.conn,
            crate::models::WorkTaskDraft {
                folder_id,
                title: "fix login".to_string(),
                config: serde_json::json!({
                    "display_text": "fix login",
                    "prompt_blocks": [{ "type": "text", "text": "fix login" }],
                }),
            },
        )
        .await
        .expect("task");
        let run_seq =
            work_task_service::claim_for_run(&db.conn, task.id, WorkTaskStatus::Todo, "test")
                .await
                .expect("claim")
                .expect("claimed");
        assert!(work_task_service::begin_setup(&db.conn, task.id, run_seq)
            .await
            .expect("begin_setup"));

        let engine = test_engine(db);
        let rx = engine
            .manager
            .insert_test_connection_live(
                COMPACT_CONN,
                AgentType::ClaudeCode,
                None,
                EventEmitter::Noop,
            )
            .await;
        if let Some((used, size)) = usage {
            let state = engine.manager.get_state(COMPACT_CONN).await.expect("state");
            state.write().await.usage =
                Some(crate::acp::session_state::UsageInfo { used, size });
        }
        CompactFixture {
            engine,
            task_id: task.id,
            run_seq,
            folder_id,
            conversation_id: conv.id,
            rx,
        }
    }

    fn compact_settings(percent: i32, command: Option<&str>) -> WorkTaskFolderSettings {
        WorkTaskFolderSettings {
            auto_compact_percent: percent,
            compact_command: command.map(str::to_string),
            ..Default::default()
        }
    }

    /// Drive `compact_before_prompt` to completion, answering the compaction
    /// turn with `stop_reason` once its prompt has actually been enqueued.
    /// Returns the text of the prompt it sent, or `None` when it sent none.
    async fn run_compaction(
        f: &mut CompactFixture,
        settings: WorkTaskFolderSettings,
        stop_reason: &str,
    ) -> Option<String> {
        let engine = f.engine.clone();
        let (task_id, run_seq, folder_id, conversation_id) =
            (f.task_id, f.run_seq, f.folder_id, f.conversation_id);
        let handle = tokio::spawn(async move {
            engine
                .compact_before_prompt(CompactRequest {
                    task_id,
                    run_seq,
                    conn_id: COMPACT_CONN,
                    agent_type: AgentType::ClaudeCode,
                    settings: &settings,
                    folder_id,
                    conversation_id,
                    in_flight: WorkTaskStatus::Preparing,
                })
                .await;
        });

        // Either a prompt shows up (compaction ran) or the call returns having
        // sent nothing. Waiting on the two together is what keeps the "no
        // compaction" assertions from depending on a sleep.
        let sent = tokio::select! {
            cmd = f.rx.recv() => match cmd.expect("connection alive") {
                crate::acp::connection::ConnectionCommand::Prompt { blocks, .. } => blocks
                    .iter()
                    .find_map(|b| match b {
                        PromptInputBlock::Text { text } => Some(text.clone()),
                        _ => None,
                    }),
                _ => panic!("the compaction must arrive as a prompt"),
            },
            _ = &mut Box::pin(async {
                while !handle.is_finished() {
                    tokio::task::yield_now().await;
                }
            }) => None,
        };
        if sent.is_some() {
            // The waiter subscribed before it sent, so the bus has a receiver.
            f.engine.bus.send(Arc::new(EventEnvelope {
                seq: 1,
                connection_id: COMPACT_CONN.to_string(),
                payload: AcpEvent::TurnComplete {
                    session_id: "sess".to_string(),
                    stop_reason: stop_reason.to_string(),
                    agent_type: AgentType::ClaudeCode.to_string(),
                },
            }));
        }
        handle.await.expect("compaction finished");
        sent
    }

    async fn compact_events(engine: &TaskEngine, task_id: i32) -> Vec<serde_json::Value> {
        work_task_service::list_events(&engine.db.conn, task_id, 500)
            .await
            .expect("events")
            .into_iter()
            .filter(|e| e.kind == "context_compact")
            .map(|e| e.payload.unwrap_or(serde_json::Value::Null))
            .collect()
    }

    /// The feature's whole point: a nearly full session is compacted, and the
    /// round's own prompt only goes out after that turn has landed.
    #[tokio::test]
    async fn a_full_context_is_compacted_before_the_round_prompt() {
        let mut f = compact_fixture(Some((90_000, 100_000))).await;

        let sent = run_compaction(&mut f, compact_settings(80, None), "end_turn").await;

        assert_eq!(sent.as_deref(), Some("/compact"));
        let events = compact_events(&f.engine, f.task_id).await;
        // A pair: the turn is announced when it goes out (the wait after it is
        // unbounded, and a card with nothing on its timeline is how a compaction
        // that never returns used to look) and again when it lands.
        assert_eq!(events.len(), 2, "{events:?}");
        assert_eq!(events[0]["status"], "started");
        assert_eq!(events[0]["before_percent"], 90.0);
        assert_eq!(events[0]["command"], "/compact");
        assert_eq!(events[1]["status"], "ok");
        assert_eq!(events[1]["before_percent"], 90.0);
        assert_eq!(events[1]["before_source"], "live");
        assert_eq!(events[1]["command"], "/compact");
        // The slot the canceller reaches through must not outlive the turn.
        assert!(f.engine.compacting.lock().await.is_empty());
    }

    /// A compaction the agent REFUSED is a failure, not an "ok" with a
    /// footnote. `rejected` reaches the `TurnComplete` arm at all only because
    /// a prompt rejection stopped tearing the connection down (issue #797); it
    /// used to arrive as the terminal `Error` the waiter settles as `failed`,
    /// and the catch-all below it would otherwise have promoted a compaction
    /// that never ran to a successful one.
    #[tokio::test]
    async fn a_rejected_compaction_prompt_is_recorded_as_a_failure() {
        let mut f = compact_fixture(Some((90_000, 100_000))).await;

        let sent = run_compaction(&mut f, compact_settings(80, None), "rejected").await;

        assert_eq!(sent.as_deref(), Some("/compact"));
        let events = compact_events(&f.engine, f.task_id).await;
        assert_eq!(events.len(), 2, "{events:?}");
        assert_eq!(events[1]["status"], "failed");
        assert_eq!(
            events[1]["detail"], "the agent rejected the compaction prompt",
            "{events:?}"
        );
    }

    /// Below the threshold nothing is sent and nothing is written — the
    /// ordinary case has to stay free of both an extra turn and timeline noise.
    #[tokio::test]
    async fn a_session_below_the_threshold_is_left_alone() {
        let mut f = compact_fixture(Some((50_000, 100_000))).await;

        let sent = run_compaction(&mut f, compact_settings(80, None), "end_turn").await;

        assert_eq!(sent, None);
        assert!(compact_events(&f.engine, f.task_id).await.is_empty());
    }

    /// The off switch. A full context with the setting at 0 is exactly today's
    /// behaviour — no reading, no turn, no event.
    #[tokio::test]
    async fn a_zero_threshold_disables_the_check() {
        let mut f = compact_fixture(Some((99_000, 100_000))).await;

        let sent = run_compaction(&mut f, compact_settings(0, None), "end_turn").await;

        assert_eq!(sent, None);
        assert!(compact_events(&f.engine, f.task_id).await.is_empty());
    }

    /// The explicit setting is what gets sent, verbatim — it exists precisely
    /// for the agents codeg has no default for.
    #[tokio::test]
    async fn the_configured_command_is_sent_verbatim() {
        let mut f = compact_fixture(Some((90_000, 100_000))).await;

        let sent = run_compaction(&mut f, compact_settings(80, Some("/summarize")), "end_turn")
            .await;

        assert_eq!(sent.as_deref(), Some("/summarize"));
    }

    /// A session that reports no occupancy can't be measured against a
    /// threshold. It must not be compacted on a guess — and the skip is
    /// recorded, because with the setting switched on "nothing happened" needs
    /// an explanation.
    #[tokio::test]
    async fn an_unmeasurable_session_is_not_compacted_but_is_recorded() {
        let mut f = compact_fixture(None).await;

        let sent = run_compaction(&mut f, compact_settings(80, None), "end_turn").await;

        assert_eq!(sent, None);
        let events = compact_events(&f.engine, f.task_id).await;
        assert_eq!(events.len(), 1, "{events:?}");
        assert_eq!(events[0]["status"], "skipped");
        assert_eq!(events[0]["reason"], "usage_unknown");
    }

    /// A cancel that lands while the compaction turn is in flight ends the
    /// wait through the same `TurnComplete{cancelled}` the manager emits — the
    /// launch must not sit on it, and the round is recorded as canceled rather
    /// than compacted.
    #[tokio::test]
    async fn a_canceled_compaction_turn_releases_the_launch() {
        let mut f = compact_fixture(Some((90_000, 100_000))).await;

        let sent = run_compaction(&mut f, compact_settings(80, None), "cancelled").await;

        assert_eq!(sent.as_deref(), Some("/compact"));
        let events = compact_events(&f.engine, f.task_id).await;
        assert_eq!(events[0]["status"], "started");
        assert_eq!(events[1]["status"], "canceled");
        assert!(f.engine.compacting.lock().await.is_empty());
    }

    fn turn_complete_envelope(conn_id: &str, seq: u64, stop_reason: &str) -> EventEnvelope {
        EventEnvelope {
            seq,
            connection_id: conn_id.to_string(),
            payload: AcpEvent::TurnComplete {
                session_id: "sess".to_string(),
                stop_reason: stop_reason.to_string(),
                agent_type: AgentType::ClaudeCode.to_string(),
            },
        }
    }

    /// The race the `compaction_turns` marker exists for. The bus is a
    /// broadcast: the launch's waiter reacts to the compaction's `TurnComplete`
    /// at once, but the engine's own receiver awaits DB work per event and can
    /// dequeue that same envelope only after the launch has indexed the
    /// connection and sent the round's real prompt. Handled naively, the
    /// compaction's completion would settle the round it preceded — and
    /// disconnect the agent mid-work.
    #[tokio::test]
    async fn a_late_compaction_completion_does_not_settle_the_round() {
        let mut f = compact_fixture(Some((90_000, 100_000))).await;
        let sent = run_compaction(&mut f, compact_settings(80, None), "end_turn").await;
        assert_eq!(sent.as_deref(), Some("/compact"));

        // The launch goes on to bind the connection to the run and prompt it.
        assert!(work_task_service::mark_running(
            &f.engine.db.conn,
            f.task_id,
            f.run_seq,
            f.conversation_id,
            COMPACT_CONN,
        )
        .await
        .expect("mark_running"));
        f.engine
            .index
            .lock()
            .await
            .insert(COMPACT_CONN.into(), (f.task_id, f.run_seq));

        // Only NOW does the engine's own loop get to the compaction's envelope
        // (seq 1 — the one `run_compaction` published).
        f.engine
            .on_event(&turn_complete_envelope(COMPACT_CONN, 1, "end_turn"))
            .await;

        assert_eq!(
            status_of(&f.engine, f.task_id).await,
            WorkTaskStatus::Running,
            "the compaction's completion must not settle the round it preceded"
        );

        // The other direction: the ROUND's own completion, a later seq on the
        // same connection, still settles normally.
        f.engine
            .on_event(&turn_complete_envelope(COMPACT_CONN, 2, "end_turn"))
            .await;
        assert_eq!(
            status_of(&f.engine, f.task_id).await,
            WorkTaskStatus::Review
        );
    }

    /// The fence covers everything up to its watermark — the wait can end
    /// without ever reading the completion, and must still be able to fence one
    /// it never saw — but nothing above it. A higher seq can only be the round's
    /// own turn, so it passes AND retires the fence.
    #[tokio::test]
    async fn the_compaction_fence_stops_at_the_rounds_own_turn() {
        let f = compact_fixture(Some((90_000, 100_000))).await;
        f.engine.mark_compaction_turn(COMPACT_CONN, 4).await;

        assert!(f.engine.claim_compaction_turn(COMPACT_CONN, 4).await);
        assert!(
            f.engine.claim_compaction_turn(COMPACT_CONN, 2).await,
            "a completion emitted before the watermark is the launch's too"
        );

        assert!(!f.engine.claim_compaction_turn(COMPACT_CONN, 9).await);
        assert!(
            f.engine.compaction_turns.lock().await.is_empty(),
            "the round's own turn retires the fence"
        );
        // Another connection's turns are never fenced by this one's mark.
        f.engine.mark_compaction_turn(COMPACT_CONN, 4).await;
        assert!(!f.engine.claim_compaction_turn("conn-other", 1).await);
    }

    /// Ending the wait on liveness rather than on the event itself is exactly
    /// when the completion is most likely to still be sitting in the engine's
    /// receiver: `apply_event` clears `turn_in_flight` BEFORE the envelope is
    /// broadcast. The probe has to fence it on the way out, or the fix for the
    /// settle race has a hole the size of the tick.
    #[tokio::test]
    async fn ending_the_wait_on_liveness_still_fences_the_completion() {
        let f = compact_fixture(Some((90_000, 100_000))).await;
        let state = f
            .engine
            .manager
            .get_state(COMPACT_CONN)
            .await
            .expect("state");
        {
            let mut s = state.write().await;
            s.turn_in_flight = false;
            s.event_seq = 7;
        }

        let outcome = f
            .engine
            .compaction_still_running(COMPACT_CONN)
            .await
            .expect("the wait ends");
        assert_eq!(outcome.status, "ok");
        assert!(
            f.engine.claim_compaction_turn(COMPACT_CONN, 7).await,
            "a completion the wait never read must still be fenced"
        );

        // A connection that vanished cannot report a seq, so its whole id is
        // fenced — ids are per-launch UUIDs, never reused.
        let outcome = f
            .engine
            .compaction_still_running("conn-vanished")
            .await
            .expect("the wait ends");
        assert_eq!(outcome.status, "failed");
        assert!(f.engine.claim_compaction_turn("conn-vanished", 99).await);
    }

    /// The fence must not outlive the launch that set it. A generation torn
    /// down before it ever went live (lost CAS, failed prompt, cancel) is
    /// retired by `forget_connection`, not by `retire_connection`.
    #[tokio::test]
    async fn a_torn_down_launch_takes_its_fence_with_it() {
        let f = compact_fixture(Some((90_000, 100_000))).await;
        f.engine.mark_compaction_turn(COMPACT_CONN, 4).await;
        f.engine
            .index
            .lock()
            .await
            .insert(COMPACT_CONN.into(), (f.task_id, f.run_seq));

        f.engine.forget_connection(COMPACT_CONN).await;

        assert!(f.engine.compaction_turns.lock().await.is_empty());
        assert!(f.engine.index.lock().await.is_empty());
    }

    /// `apply_event` clears `turn_in_flight` on `TurnComplete` but not on a
    /// terminal error or a disconnect — so a receiver that lagged one of those
    /// away would block on `recv()` for a connection that is never going to
    /// speak again, holding the task lock and taking any later cancel with it.
    /// The liveness tick is what ends those waits.
    #[tokio::test]
    async fn a_wait_with_no_events_still_ends_on_liveness() {
        let f = compact_fixture(Some((90_000, 100_000))).await;
        // Paused only now, and never around DB work: the sqlite pool's acquire
        // timeout runs on the same clock, so a test that freezes it before the
        // fixture exists dies with `PoolTimedOut`. With the runtime otherwise
        // idle, the tick's sleep auto-advances, so the wait costs no wall time.
        tokio::time::pause();

        // The connection is gone and no event is coming.
        let mut rx = f.engine.bus.subscribe();
        let outcome = f
            .engine
            .await_compaction_turn(&mut rx, "conn-never-registered")
            .await;
        assert_eq!(outcome.status, "failed");

        // Alive, but the turn already ended and its event was missed.
        let state = f
            .engine
            .manager
            .get_state(COMPACT_CONN)
            .await
            .expect("state");
        state.write().await.turn_in_flight = false;
        let outcome = f.engine.await_compaction_turn(&mut rx, COMPACT_CONN).await;
        assert_eq!(outcome.status, "ok");
    }

    /// The kill slot is generation-scoped like every other one on this engine:
    /// a cancel of an older run must not abort the compaction of a newer one.
    #[tokio::test]
    async fn a_stale_cancel_does_not_abort_a_newer_compaction() {
        let f = compact_fixture(Some((90_000, 100_000))).await;
        f.engine.compacting.lock().await.insert(
            f.task_id,
            CompactRun {
                run_seq: f.run_seq,
                conn_id: COMPACT_CONN.to_string(),
            },
        );

        f.engine.release_compact_slot(f.task_id, f.run_seq - 1).await;
        assert!(
            f.engine.compacting.lock().await.contains_key(&f.task_id),
            "an older generation must not release the live slot"
        );

        f.engine.release_compact_slot(f.task_id, f.run_seq).await;
        assert!(f.engine.compacting.lock().await.is_empty());
    }
}
