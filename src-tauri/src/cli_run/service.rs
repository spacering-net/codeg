//! `CliRunService`: the runtime side of `codeg-cli run`.
//!
//! One run is one prompt and one turn on a fresh connection. The service owns
//! everything that must not depend on the CLI staying connected:
//!
//! - **Launch** (`start`): the same chain automations use — folder, agent,
//!   environment, spawn, conversation row, prompt — plus the explicit
//!   `--model` / `--effort` / `--mode` / `-c` selections, each confirmed by the
//!   agent's own answer before the prompt goes out.
//! - **Policy**: permission requests, questions and Grok plan approvals are
//!   answered by the run's `--permissions` the moment they arrive, on the root
//!   connection and on every delegation child that inherited the run's tag.
//! - **Settlement**: the result is fixed on `TurnComplete`; the connection is
//!   let go only once the conversation row has its final status, so a
//!   successful run is never recorded as cancelled.
//! - **Cancellation**: serialized with the launch, so a cancel lands either
//!   before the prompt is queued or on the running turn — never in between.
//!
//! Settled runs are kept (in memory, bounded) so a CLI that lost its
//! connection can still collect the result.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant};

use tokio::sync::broadcast::error::RecvError;
use tokio::sync::{broadcast, watch, Mutex, Notify, RwLock};

use crate::acp::connection::SetterOutcome;
use crate::acp::manager::ConnectionManager;
use crate::acp::plan_approval::{PlanApprovalAnswer, PlanApprovalDecision};
use crate::acp::question::QuestionAnswer;
use crate::acp::session_state::TurnStatusWriter;
use crate::acp::types::{
    AcpEvent, ConnectionStatus, EventEnvelope, PermissionAnswerOrigin, PermissionOptionInfo,
    PromptInputBlock, SessionConfigKindInfo, SessionConfigOptionInfo,
};
use crate::acp::{InternalEventBus, SessionState};
use crate::db::entities::conversation::{self, ConversationStatus};
use crate::db::service::{assistant_service, conversation_service, folder_service};
use crate::db::AppDatabase;
use crate::models::agent::AgentType;
use crate::models::assistant::AssistantInfo;
use crate::web::event_bridge::EventEmitter;

use super::events;
use super::output_schema::{OutputSchema, MAX_REFUSED};
use super::policy::{decide_permission, CliRunTag, PermissionDecision, PermissionPolicy, RootSeed};
use super::wire::{
    self, capability, AgentEntry, AssistantEntry, AssistantRef, CancelReason, DecidedBy, ErrorBody,
    ErrorInfo, EventBody, EventsRequest, EventsResponse, FindRequest, FindResponse, FoundRun,
    GetRequest, GetResponse, Launch, LaunchSelection, PendingCard, PermissionDenial,
    PermissionVerdict, PromptBlock, QuestionVerdict, ReserveResponse, RunEvent, RunResult,
    RunState, RuntimeKind, StartRequest, StartResponse, Subtype,
};
use super::worktree::RunWorktree;

/// Owner label of every CLI connection: not a window, so closing one never
/// takes a run with it (`disconnect_by_owner_window`).
pub const CLI_OWNER_LABEL: &str = "cli";

/// How long a reservation waits for its `start` — room to upload a 10 MiB
/// prompt over a slow link.
const RESERVATION_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_RESERVATIONS: usize = 1000;

/// How long, and how many, settled runs are kept for a CLI to collect.
const RESULT_RETENTION: Duration = Duration::from_secs(30 * 60);
const MAX_SETTLED_RUNS: usize = 200;

/// Events kept per run; older ones are dropped and a late reader gets `gap`.
const MAX_EVENTS_PER_RUN: usize = 10_000;

/// Longest a poll waits for something new.
const MAX_POLL_WAIT: Duration = Duration::from_secs(25);

/// Prompt text (prompt + stdin) a run accepts.
pub const MAX_PROMPT_BYTES: usize = 10 * 1024 * 1024;

/// How long the launch waits for the agent's initial selectors before it
/// checks explicit selections against them.
const SELECTORS_WAIT: Duration = Duration::from_secs(30);
/// How long one explicit selection may wait for the agent's answer.
const SETTER_WAIT: Duration = Duration::from_secs(15);
/// How long the run waits, after its result is fixed, for the lifecycle worker
/// to record the conversation's final status — each of the two waits.
const STATUS_WAIT: Duration = Duration::from_secs(30);
/// Under `fail`: how long the run waits for its refusal's resolution.
const FAIL_ANSWER_WAIT: Duration = Duration::from_secs(5);

/// Cadence of the backstop that answers cards the event subscriptions missed.
const RECONCILE_INTERVAL: Duration = Duration::from_secs(2);

/// How often a run's `--timeout` timer checks whether the run settled early,
/// so it lets go of a finished run long before its deadline.
const TIMER_RECHECK: Duration = Duration::from_secs(60);

/// The `seq` of a turn whose `TurnComplete` was lost with lagged events: no
/// envelope, so no claim to take (`fallback_status_write` writes all the
/// same: only ever over a row still in progress).
const LOST_TURN_SEQ: u64 = 0;

/// Deepest nesting allowed: a run started from inside a run is depth 1, and a
/// run from inside that one would be 2.
const MAX_DEPTH: u8 = 1;

/// The fewest characters of a run id `cli_run_find` takes, and the most runs
/// it answers with.
pub const MIN_RUN_PREFIX: usize = 8;
const MAX_FOUND_RUNS: usize = 20;

/// How the desktop runtime brings a conversation to the front (`--open`).
pub trait SessionOpener: Send + Sync {
    fn open_conversation(&self, conversation_id: i32);
}

/// How a run gets its agent: the environment to run it with, then the
/// connection. Real runs go through the connection manager
/// ([`ManagerLauncher`]); tests stand in a scripted connection.
#[async_trait::async_trait]
pub trait AgentLauncher: Send + Sync {
    /// The agent's launch environment. Fails when the agent is disabled or
    /// not installed — never installs it.
    async fn environment(&self, agent: AgentType) -> Result<BTreeMap<String, String>, CliError>;

    /// The run's root connection, marked with `seed` from the moment it
    /// exists.
    #[allow(clippy::too_many_arguments)]
    async fn spawn(
        &self,
        agent: AgentType,
        working_dir: String,
        env: BTreeMap<String, String>,
        emitter: EventEmitter,
        mode: Option<String>,
        config: BTreeMap<String, String>,
        seed: RootSeed,
    ) -> Result<String, CliError>;
}

/// The launch chain UI sessions and automations use.
pub struct ManagerLauncher {
    db: AppDatabase,
    manager: ConnectionManager,
    data_dir: PathBuf,
}

#[async_trait::async_trait]
impl AgentLauncher for ManagerLauncher {
    async fn environment(&self, agent: AgentType) -> Result<BTreeMap<String, String>, CliError> {
        let env =
            crate::commands::acp::build_session_runtime_env(&self.db, agent, None, &self.data_dir)
                .await
                .map_err(|e| CliError::execution("agent_unavailable", e.to_string()))?;
        // The same check, and the same "no install" rule, as a UI connect.
        crate::commands::acp::verify_agent_installed(agent)
            .await
            .map_err(|e| {
                CliError::execution("agent_not_installed", e.to_string()).with_next_steps([
                    format!(
                        "codeg-cli agents   (shows how to install {})",
                        agent.as_wire()
                    ),
                ])
            })?;
        Ok(env)
    }

    async fn spawn(
        &self,
        agent: AgentType,
        working_dir: String,
        env: BTreeMap<String, String>,
        emitter: EventEmitter,
        mode: Option<String>,
        config: BTreeMap<String, String>,
        seed: RootSeed,
    ) -> Result<String, CliError> {
        self.manager
            .spawn_cli_root(
                agent,
                Some(working_dir),
                env,
                CLI_OWNER_LABEL.to_string(),
                emitter,
                mode,
                config,
                seed,
            )
            .await
            .map_err(|e| CliError::execution("agent_spawn_failed", e.to_string()))
    }
}

/// The waits of a run. Fixed in production; shortened by tests.
#[derive(Debug, Clone, Copy)]
pub struct Timings {
    pub selectors: Duration,
    pub setter: Duration,
    pub status: Duration,
    /// Under `fail`: how long the run waits to learn which answer took effect
    /// (its refusal, or a person's that came first) before it ends anyway.
    pub fail_answer: Duration,
}

impl Default for Timings {
    fn default() -> Self {
        Self {
            selectors: SELECTORS_WAIT,
            setter: SETTER_WAIT,
            status: STATUS_WAIT,
            fail_answer: FAIL_ANSWER_WAIT,
        }
    }
}

/// A failed `/api/cli_*` call: an HTTP status and the error body.
#[derive(Debug, Clone)]
pub struct CliError {
    pub status: u16,
    pub body: ErrorBody,
}

impl CliError {
    fn new(status: u16, subtype: Subtype, code: &str, message: impl Into<String>) -> Self {
        Self {
            status,
            body: ErrorBody {
                subtype,
                error: ErrorInfo {
                    code: code.to_string(),
                    message: message.into(),
                    next_steps: Vec::new(),
                },
            },
        }
    }

    pub fn usage(code: &str, message: impl Into<String>) -> Self {
        Self::new(400, Subtype::ErrorUsage, code, message)
    }

    pub fn execution(code: &str, message: impl Into<String>) -> Self {
        Self::new(422, Subtype::ErrorDuringExecution, code, message)
    }

    pub(crate) fn unavailable(code: &str, message: impl Into<String>) -> Self {
        Self::new(404, Subtype::ErrorRuntimeUnavailable, code, message)
    }

    pub fn incompatible(code: &str, message: impl Into<String>) -> Self {
        Self::new(409, Subtype::ErrorRuntimeIncompatible, code, message)
    }

    pub(crate) fn with_next_steps(mut self, steps: impl IntoIterator<Item = String>) -> Self {
        self.body.error.next_steps.extend(steps);
        self
    }

    fn run_not_found(run_id: &str) -> Self {
        Self::unavailable(
            "run_not_found",
            format!(
                "this codeg has no run {run_id}: it was never started here, or its result is \
                 past the {}-minute retention",
                RESULT_RETENTION.as_secs() / 60
            ),
        )
    }
}

/// Why a run was stopped from outside its turn.
#[derive(Debug, Clone, PartialEq, Eq)]
enum StopCause {
    User,
    Timeout,
    Interrupt,
    /// `--permissions fail` (or a refusal with no one-time option to refuse
    /// with) met this tool.
    PermissionRequired {
        tool: String,
    },
}

impl From<CancelReason> for StopCause {
    fn from(reason: CancelReason) -> Self {
        match reason {
            CancelReason::User => Self::User,
            CancelReason::Timeout => Self::Timeout,
            CancelReason::Interrupt => Self::Interrupt,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Starting,
    Running,
    Settled,
}

/// A permission request the run has seen, for reporting what became of it.
#[derive(Debug, Clone)]
struct SeenRequest {
    conversation_id: Option<i32>,
    tool: String,
    tool_kind: Option<String>,
    options: Vec<PermissionOptionInfo>,
}

struct RunInner {
    /// The run's effective `--permissions` (narrowed for a nested run), fixed
    /// once the launch has resolved its caller. The depth lives on the root
    /// connection's tag, where a nested call reads it.
    policy: PermissionPolicy,
    phase: Phase,
    stop: Option<StopCause>,
    connection_id: Option<String>,
    root_state: Option<Arc<RwLock<SessionState>>>,
    conversation_id: Option<i32>,
    session_id: Option<String>,
    /// The agent and assistant, once the launch resolved them.
    agent: Option<String>,
    assistant: Option<AssistantRef>,
    /// The run's own worktree (`--worktree`), once made.
    worktree: Option<RunWorktree>,
    /// Whether the run was given `--output-schema`, and the schema once the
    /// launch compiled it.
    structured: bool,
    output_schema: Option<Arc<OutputSchema>>,
    launch: Launch,
    /// Permission requests seen, by request id.
    requests: HashMap<String, SeenRequest>,
    /// Requests, questions and plan approvals already acted on.
    handled: HashSet<String>,
    /// Requests whose outcome is already in the event log.
    reported: HashSet<String>,
    denials: Vec<PermissionDenial>,
    permission_failure: Option<String>,
    /// Under `fail`: the request the run refused and now ends for, once its
    /// resolution says which answer took effect — and since when it waits.
    failing: Option<(String, Instant)>,
    last_error: Option<String>,
    /// Events, oldest first; `seq` runs from 1.
    log: VecDeque<RunEvent>,
    next_seq: u64,
    /// `init` is out: agent events are reported from here on.
    reporting: bool,
    result: Option<RunResult>,
    settled_at: Option<Instant>,
    /// The root connection's `turns_completed` when the prompt went out: the
    /// run's turn has ended once the counter moved past it.
    turns_before_prompt: Option<u64>,
}

struct Run {
    id: String,
    begun: Instant,
    /// Held by the launch from the moment the run exists until its prompt is
    /// queued (or the launch gave up); a stop waits for it.
    launch: Arc<Mutex<()>>,
    inner: Mutex<RunInner>,
    changed: Notify,
    /// The launch's outcome, for a repeated `start` of the same run.
    started: watch::Sender<Option<Result<StartResponse, CliError>>>,
}

impl Run {
    /// Append an event and wake pollers. Before `init`, agent events are not
    /// reported (they are the selector traffic of the launch).
    fn push(&self, inner: &mut RunInner, body: EventBody) {
        let is_framing = matches!(body, EventBody::Init { .. } | EventBody::Result(_));
        if !inner.reporting && !is_framing {
            return;
        }
        if inner.phase == Phase::Settled && !matches!(body, EventBody::Result(_)) {
            return;
        }
        inner.next_seq += 1;
        inner
            .log
            .push_back(RunEvent::new(inner.next_seq, Some(self.id.clone()), body));
        while inner.log.len() > MAX_EVENTS_PER_RUN {
            inner.log.pop_front();
        }
        self.changed.notify_waiters();
    }
}

enum Entry {
    Reserved { expires: Instant },
    Run(Arc<Run>),
}

#[derive(Default)]
struct Registry {
    entries: HashMap<String, Entry>,
    /// Settled runs, oldest first, for retention.
    settled: VecDeque<String>,
}

impl Registry {
    fn prune(&mut self, now: Instant) {
        self.entries.retain(|_, entry| match entry {
            Entry::Reserved { expires } => *expires > now,
            Entry::Run(_) => true,
        });
        while self.settled.len() > MAX_SETTLED_RUNS {
            if let Some(id) = self.settled.pop_front() {
                self.entries.remove(&id);
            }
        }
        while let Some(id) = self.settled.front() {
            let expired = match self.entries.get(id) {
                Some(Entry::Run(run)) => run
                    .inner
                    .try_lock()
                    .ok()
                    .and_then(|inner| inner.settled_at)
                    .is_some_and(|at| now.duration_since(at) > RESULT_RETENTION),
                _ => true,
            };
            if !expired {
                break;
            }
            let id = id.clone();
            self.settled.pop_front();
            self.entries.remove(&id);
        }
    }

    fn reservations(&self) -> usize {
        self.entries
            .values()
            .filter(|e| matches!(e, Entry::Reserved { .. }))
            .count()
    }
}

pub struct CliRunService {
    db: AppDatabase,
    manager: ConnectionManager,
    emitter: EventEmitter,
    bus: Arc<InternalEventBus>,
    runtime: RuntimeKind,
    launcher: Arc<dyn AgentLauncher>,
    timings: Timings,
    opener: OnceLock<Arc<dyn SessionOpener>>,
    registry: StdMutex<Registry>,
    installs: Arc<super::agent_install::AgentInstalls>,
}

impl CliRunService {
    pub fn new(
        db: &AppDatabase,
        manager: &ConnectionManager,
        emitter: EventEmitter,
        bus: Arc<InternalEventBus>,
        data_dir: PathBuf,
        runtime: RuntimeKind,
    ) -> Arc<Self> {
        let launcher = Arc::new(ManagerLauncher {
            db: AppDatabase {
                conn: db.conn.clone(),
            },
            manager: manager.clone_ref(),
            data_dir,
        });
        Self::with_launcher(
            db,
            manager,
            emitter,
            bus,
            runtime,
            launcher,
            Timings::default(),
        )
    }

    /// [`Self::new`] with the agent launch and the waits replaced — for tests.
    pub fn with_launcher(
        db: &AppDatabase,
        manager: &ConnectionManager,
        emitter: EventEmitter,
        bus: Arc<InternalEventBus>,
        runtime: RuntimeKind,
        launcher: Arc<dyn AgentLauncher>,
        timings: Timings,
    ) -> Arc<Self> {
        Arc::new(Self {
            db: AppDatabase {
                conn: db.conn.clone(),
            },
            manager: manager.clone_ref(),
            emitter,
            bus,
            runtime,
            launcher,
            timings,
            opener: OnceLock::new(),
            registry: StdMutex::new(Registry::default()),
            installs: Arc::default(),
        })
    }

    pub fn runtime(&self) -> RuntimeKind {
        self.runtime
    }

    /// Install how this (desktop) runtime opens a conversation. Once.
    pub fn set_opener(&self, opener: Arc<dyn SessionOpener>) {
        let _ = self.opener.set(opener);
    }

    pub fn capabilities(&self) -> Vec<String> {
        let mut caps = vec![
            capability::RUN.to_string(),
            capability::EFFORT.to_string(),
            capability::RUN_LOOKUP.to_string(),
            capability::WORKTREE.to_string(),
            capability::AUTOMATIONS.to_string(),
            capability::AGENT_INSTALL.to_string(),
            capability::OUTPUT_SCHEMA.to_string(),
        ];
        if self.opener.get().is_some() {
            caps.push(capability::OPEN_SESSION.to_string());
        }
        caps
    }

    /// Start the service's background work: the bus subscription that answers
    /// delegated children's cards, and the backstop that answers whatever the
    /// subscriptions missed.
    pub fn spawn_background(self: &Arc<Self>) {
        let svc = Arc::clone(self);
        tokio::spawn(async move { svc.child_asks_loop().await });
        let svc = Arc::clone(self);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(RECONCILE_INTERVAL);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tick.tick().await;
                svc.reconcile_all().await;
            }
        });
    }

    // ── registry ─────────────────────────────────────────────────────────────

    pub fn reserve(&self) -> Result<ReserveResponse, CliError> {
        let mut reg = self.registry.lock().expect("registry");
        reg.prune(Instant::now());
        if reg.reservations() >= MAX_RESERVATIONS {
            return Err(CliError::new(
                429,
                Subtype::ErrorDuringExecution,
                "too_many_reservations",
                "too many runs are reserved but not started on this codeg; try again shortly",
            ));
        }
        let run_id = uuid::Uuid::new_v4().to_string();
        reg.entries.insert(
            run_id.clone(),
            Entry::Reserved {
                expires: Instant::now() + RESERVATION_TTL,
            },
        );
        Ok(ReserveResponse {
            run_id,
            expires_in_ms: RESERVATION_TTL.as_millis() as u64,
        })
    }

    fn run(&self, run_id: &str) -> Option<Arc<Run>> {
        match self.registry.lock().expect("registry").entries.get(run_id) {
            Some(Entry::Run(run)) => Some(Arc::clone(run)),
            _ => None,
        }
    }

    fn live_runs(&self) -> Vec<Arc<Run>> {
        self.registry
            .lock()
            .expect("registry")
            .entries
            .values()
            .filter_map(|e| match e {
                Entry::Run(run) => Some(Arc::clone(run)),
                Entry::Reserved { .. } => None,
            })
            .collect()
    }

    fn mark_settled(&self, run_id: &str) {
        let mut reg = self.registry.lock().expect("registry");
        reg.settled.push_back(run_id.to_string());
        reg.prune(Instant::now());
    }

    // ── start ────────────────────────────────────────────────────────────────

    pub async fn start(self: &Arc<Self>, req: StartRequest) -> Result<StartResponse, CliError> {
        enum Claim {
            Fresh(Arc<Run>, tokio::sync::OwnedMutexGuard<()>),
            Existing(Arc<Run>),
        }
        let claim = {
            let mut reg = self.registry.lock().expect("registry");
            let now = Instant::now();
            match reg.entries.get(&req.run_id) {
                Some(Entry::Run(run)) => Claim::Existing(Arc::clone(run)),
                Some(Entry::Reserved { expires }) if *expires > now => {
                    let run = Arc::new(Run {
                        id: req.run_id.clone(),
                        begun: now,
                        launch: Arc::new(Mutex::new(())),
                        inner: Mutex::new(RunInner::new(
                            req.permissions,
                            req.output_schema.is_some(),
                        )),
                        changed: Notify::new(),
                        started: watch::channel(None).0,
                    });
                    // Taken here, in the same critical section that turns the
                    // reservation into the run, so a cancel can never get the
                    // lock first and find nothing to stop.
                    let guard = Arc::clone(&run.launch)
                        .try_lock_owned()
                        .expect("a new run's launch lock is free");
                    reg.entries
                        .insert(req.run_id.clone(), Entry::Run(Arc::clone(&run)));
                    Claim::Fresh(run, guard)
                }
                _ => {
                    return Err(CliError::incompatible(
                        "run_not_reserved",
                        format!(
                            "run {} is not reserved here: it expired, was cancelled, or \
                             belongs to another codeg",
                            req.run_id
                        ),
                    ))
                }
            }
        };
        let run = match claim {
            Claim::Existing(run) => run,
            Claim::Fresh(run, guard) => {
                // A deadline too far off to represent is no deadline.
                let deadline = req
                    .timeout_ms
                    .and_then(|ms| Instant::now().checked_add(Duration::from_millis(ms)));
                if let Some(deadline) = deadline {
                    let svc = Arc::clone(self);
                    // Weak, and rechecked now and then: a run that settled
                    // early is not kept alive until its deadline.
                    let timed = Arc::downgrade(&run);
                    tokio::spawn(async move {
                        loop {
                            let left = deadline.saturating_duration_since(Instant::now());
                            if left.is_zero() {
                                break;
                            }
                            tokio::time::sleep(left.min(TIMER_RECHECK)).await;
                            let Some(run) = timed.upgrade() else {
                                return;
                            };
                            if run.inner.lock().await.phase == Phase::Settled {
                                return;
                            }
                        }
                        if let Some(run) = timed.upgrade() {
                            svc.stop_run(&run, StopCause::Timeout).await;
                        }
                    });
                }
                // Detached from this request: a CLI that goes away mid-launch
                // (Ctrl-C, a dropped link) must not abandon a half-made run.
                let svc = Arc::clone(self);
                let launched = Arc::clone(&run);
                tokio::spawn(async move {
                    let outcome = svc.launch(&launched, req, guard).await;
                    // Kept whether or not anyone waits on it now: a retried
                    // start that subscribes later reads it.
                    launched.started.send_replace(Some(outcome));
                });
                run
            }
        };
        Self::await_start(&run).await
    }

    /// A repeated `start` (its first answer was lost): the first launch's
    /// outcome, once it has one.
    async fn await_start(run: &Arc<Run>) -> Result<StartResponse, CliError> {
        let mut rx = run.started.subscribe();
        loop {
            if let Some(outcome) = rx.borrow().clone() {
                return outcome;
            }
            if rx.changed().await.is_err() {
                return Err(CliError::execution(
                    "run_lost",
                    "the run's launch went away",
                ));
            }
        }
    }

    /// Run the launch with its lock held throughout — a failure is settled
    /// before the lock goes, so a waiting stop finds the run already settled.
    async fn launch(
        self: &Arc<Self>,
        run: &Arc<Run>,
        req: StartRequest,
        launch_guard: tokio::sync::OwnedMutexGuard<()>,
    ) -> Result<StartResponse, CliError> {
        let outcome = self.launch_steps(run, req).await;
        if let Err(err) = &outcome {
            self.fail_launch(run, err).await;
        }
        drop(launch_guard);
        outcome
    }

    /// A stop that arrived meanwhile (it waits on the launch lock) is noticed
    /// at each checkpoint; once the prompt is queued the lock is released and
    /// the stop cancels the running turn instead.
    async fn launch_steps(
        self: &Arc<Self>,
        run: &Arc<Run>,
        req: StartRequest,
    ) -> Result<StartResponse, CliError> {
        let prompt = prompt_blocks(&req.prompt)?;
        let output_schema = match &req.output_schema {
            Some(schema) => Some(Arc::new(
                OutputSchema::compile(schema.clone())
                    .map_err(|why| CliError::usage("bad_output_schema", why))?,
            )),
            None => None,
        };
        if req.open && self.opener.get().is_none() {
            return Err(CliError::usage(
                "open_unsupported",
                "--open needs a desktop runtime; this one cannot open sessions",
            ));
        }
        if req.agent.is_some() && req.assistant.is_some() {
            return Err(CliError::usage(
                "agent_and_assistant",
                "give either --agent or --assistant: an assistant already decides its agent",
            ));
        }
        let workspace = validate_workspace(&req.workspace)?;
        let folder =
            crate::db::service::folder_service::ensure_folder_for_path(&self.db.conn, &workspace)
                .await
                .map_err(|e| CliError::execution("workspace_unavailable", e.to_string()))?;

        let assistant = match req.assistant.as_deref() {
            Some(key) => Some(self.resolve_assistant(key).await?),
            None => None,
        };
        let agent_type = match (&assistant, req.agent.as_deref()) {
            (Some(a), _) => a.agent_type,
            (None, Some(slug)) => self.resolve_agent_slug(slug).await?,
            (None, None) => self.folder_default_agent(folder.id).await?,
        };
        let assistant_ref = assistant.as_ref().map(|a| AssistantRef {
            id: a.id,
            name: a.name.clone(),
        });
        {
            // In the result from here on, a launch that fails included.
            let mut inner = run.inner.lock().await;
            inner.agent = Some(agent_type.as_wire().into_owned());
            inner.assistant = assistant_ref.clone();
        }

        // Depth and policy ceiling come from the caller's own record.
        let (depth, policy, narrowed_from) =
            self.nesting(req.caller.as_deref(), req.permissions).await?;

        if agent_type == AgentType::Kiro
            && (req.effort.is_some()
                || ["thinking", "reasoning_effort"]
                    .iter()
                    .any(|id| req.config.contains_key(*id)))
        {
            return Err(CliError::usage(
                "kiro_effort_unconfirmable",
                "Kiro's thinking effort and thinking switch cannot be set from the command \
                 line: Kiro gives no reliable confirmation of either, so a run could not know \
                 whether the setting took. Use an assistant with those options, or omit them.",
            ));
        }

        let (mode_pref, config_prefs) = match &assistant {
            Some(a) => (
                a.agent_options.mode_id.clone(),
                a.agent_options.config_values.clone(),
            ),
            // The agent's own defaults: not the delegation "Agent defaults",
            // which the settings page scopes to delegated children.
            None => (None, BTreeMap::new()),
        };

        {
            let mut inner = run.inner.lock().await;
            inner.policy = policy;
        }
        let assistant_selects = !config_prefs.is_empty() || mode_pref.is_some();

        let runtime_env = self.launcher.environment(agent_type).await?;
        self.check_stopped(run).await?;

        // `--worktree`: made once the agent is known to be there to work in
        // it; a launch that fails before its conversation exists takes it
        // away again (`fail_launch`).
        let worktree = match req.worktree.as_deref() {
            Some(name) => {
                let made = super::worktree::create(&workspace, name, &run.id).await?;
                run.inner.lock().await.worktree = Some(made.clone());
                self.check_stopped(run).await?;
                Some(made)
            }
            None => None,
        };
        let working_dir = worktree
            .as_ref()
            .map_or_else(|| workspace.clone(), |w| w.workspace.clone());

        if let Some(schema) = &output_schema {
            run.inner.lock().await.output_schema = Some(Arc::clone(schema));
            Self::report_refusals(run, schema);
        }
        // Tagged from its first moment — before its agent starts, so the
        // codeg-mcp it is given knows the run — and before a delegated child,
        // which can only come after the prompt, could look for the tag.
        let seed = RootSeed {
            tag: CliRunTag {
                run_id: run.id.clone(),
                policy,
                depth,
            },
            output_schema: output_schema.clone(),
        };
        let connection_id = self
            .launcher
            .spawn(
                agent_type,
                working_dir.clone(),
                runtime_env,
                self.emitter.clone(),
                mode_pref,
                config_prefs,
                seed,
            )
            .await?;
        let Some(state) = self.manager.get_state(&connection_id).await else {
            return Err(CliError::execution(
                "agent_exited",
                "the agent process ended while it was starting",
            ));
        };

        // Subscribe and register before anything is sent.
        let rx = state.read().await.event_stream().subscribe();
        {
            let mut inner = run.inner.lock().await;
            inner.connection_id = Some(connection_id.clone());
            inner.root_state = Some(Arc::clone(&state));
        }
        {
            let svc = Arc::clone(self);
            let pumped = Arc::clone(run);
            let conn = connection_id.clone();
            let pumped_state = Arc::clone(&state);
            tokio::spawn(async move { svc.pump(pumped, conn, pumped_state, rx).await });
        }

        let notices = self
            .apply_selections(
                run,
                &connection_id,
                &state,
                agent_type,
                &req,
                assistant.as_ref().filter(|_| assistant_selects),
            )
            .await?;
        self.check_stopped(run).await?;

        let title = req
            .title
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(|t| t.chars().take(200).collect::<String>());
        let locked_title = title.is_some();
        let folder_id = match &worktree {
            Some(w) => self.worktree_folder(folder.id, w).await?,
            None => folder.id,
        };
        let conversation_id = crate::commands::conversations::create_conversation_core(
            &self.db.conn,
            folder_id,
            agent_type,
            title,
        )
        .await
        .map_err(|e| CliError::execution("conversation_create_failed", e.to_string()))?;
        if locked_title {
            if let Err(e) = conversation_service::lock_title(&self.db.conn, conversation_id).await {
                tracing::warn!("[cli] run {}: could not lock the title: {e}", run.id);
            }
        }
        // Marked as the command line's, for the sidebar.
        if let Err(e) = conversation_service::set_source(
            &self.db.conn,
            conversation_id,
            conversation::SOURCE_CLI,
        )
        .await
        {
            tracing::warn!("[cli] run {}: could not mark the conversation: {e}", run.id);
        }
        crate::commands::conversations::emit_conversation_upsert(
            &self.emitter,
            &self.db.conn,
            conversation_id,
        )
        .await;
        {
            let mut inner = run.inner.lock().await;
            inner.conversation_id = Some(conversation_id);
        }
        self.check_stopped(run).await?;

        let mut suffix: Vec<PromptInputBlock> = assistant
            .as_ref()
            .and_then(|a| {
                crate::acp::agent_mentions::render_assistant_brief(&a.name, &a.instructions)
            })
            .map(|text| vec![PromptInputBlock::Text { text }])
            .unwrap_or_default();
        // How to hand the result in: with `submit_result` when the agent was
        // given it — known once its session is up, which the launch waited
        // for — or else in the reply.
        if let Some(schema) = &output_schema {
            let offered = state.read().await.result_tool_available;
            suffix.push(PromptInputBlock::Text {
                text: schema.instructions(offered),
            });
        }
        let link = wire::session_link(conversation_id);
        {
            let mut inner = run.inner.lock().await;
            // The last word on a stop, under the lock a stop is recorded
            // under: one recorded before this keeps the prompt from going
            // out; one after it finds the run running, waits for the prompt
            // to be queued, and cancels the turn.
            if inner.stop.is_some() || inner.phase == Phase::Settled {
                return Err(CliError::execution(
                    "run_stopped",
                    "the run was stopped before its prompt was sent",
                ));
            }
            inner.phase = Phase::Running;
            inner.reporting = true;
            inner.turns_before_prompt = Some(state.read().await.turns_completed);
            run.push(
                &mut inner,
                EventBody::Init {
                    conversation_id,
                    folder_id,
                    agent: agent_type.as_wire().into_owned(),
                    assistant: assistant_ref.clone(),
                    workspace: working_dir.clone(),
                    link: link.clone(),
                    worktree: worktree.as_ref().map(RunWorktree::info),
                },
            );
            let session_id = state.read().await.external_id.clone();
            inner.session_id = session_id.clone();
            let launch = inner.launch.clone();
            run.push(&mut inner, EventBody::Session { session_id, launch });
            if let Some(requested) = narrowed_from {
                run.push(
                    &mut inner,
                    EventBody::Notice {
                        severity: "warning".into(),
                        title: format!(
                            "--permissions {} narrowed to {}",
                            requested.as_str(),
                            policy.as_str()
                        ),
                        message: Some(
                            "this run was started from inside another CLI run, and a nested \
                             run never gets a wider policy than the run it came from"
                                .into(),
                        ),
                    },
                );
            }
            for notice in notices {
                run.push(&mut inner, notice);
            }
        }

        self.manager
            .send_prompt_linked_with_suffix(
                &self.db,
                &connection_id,
                prompt,
                Some(folder_id),
                Some(conversation_id),
                None,
                suffix,
            )
            .await
            .map_err(|e| CliError::execution("prompt_failed", e.to_string()))?;

        if req.open {
            if let Some(opener) = self.opener.get() {
                opener.open_conversation(conversation_id);
            }
        }

        Ok(StartResponse {
            run_id: run.id.clone(),
            conversation_id,
            folder_id,
            connection_id,
            agent: agent_type.as_wire().into_owned(),
            assistant: assistant_ref,
            link,
            workspace: Some(working_dir),
            worktree: worktree.as_ref().map(RunWorktree::info),
        })
    }

    /// A `notice` for each result `submit_result` refuses, until the run
    /// settles.
    fn report_refusals(run: &Arc<Run>, schema: &OutputSchema) {
        let mut refusals = schema.refusals();
        let run = Arc::downgrade(run);
        tokio::spawn(async move {
            while let Some(refusal) = refusals.recv().await {
                let Some(run) = run.upgrade() else {
                    return;
                };
                let mut inner = run.inner.lock().await;
                run.push(
                    &mut inner,
                    EventBody::Notice {
                        severity: "warning".into(),
                        title: format!(
                            "submit_result refused a result ({} of at most {MAX_REFUSED})",
                            refusal.number
                        ),
                        message: Some(refusal.errors.join("; ")),
                    },
                );
            }
        });
    }

    async fn check_stopped(&self, run: &Run) -> Result<(), CliError> {
        let inner = run.inner.lock().await;
        match &inner.stop {
            None if inner.phase != Phase::Settled => Ok(()),
            _ => Err(CliError::execution(
                "run_stopped",
                "the run was stopped before its prompt was sent",
            )),
        }
    }

    /// The launch failed: let the connection go, converge the conversation
    /// row, and settle the run with the launch's error (unless a stop already
    /// settled it).
    async fn fail_launch(&self, run: &Arc<Run>, err: &CliError) {
        let (conn, conversation_id, worktree) = {
            let inner = run.inner.lock().await;
            (
                inner.connection_id.clone(),
                inner.conversation_id,
                inner.worktree.clone(),
            )
        };
        if let Some(conn) = conn {
            let _ = self.manager.disconnect(&conn).await;
        }
        if let Some(cid) = conversation_id {
            self.converge_cancelled(cid).await;
        } else if let Some(worktree) = worktree {
            // Nothing ran in it, and no conversation points at it.
            super::worktree::remove(&worktree).await;
            run.inner.lock().await.worktree = None;
        }
        let mut inner = run.inner.lock().await;
        if inner.phase == Phase::Settled {
            return;
        }
        let (subtype, error) = match inner.stop.clone() {
            Some(cause) => stop_outcome(&cause),
            None => (err.body.subtype, Some(err.body.error.clone())),
        };
        self.settle_locked(run, &mut inner, subtype, None, None, error, None)
            .await;
    }

    /// The folder of a run's worktree: under the workspace's root folder, and
    /// open in the workspace only if that root is — a CLI run opens nothing
    /// the user has not. Open, it is announced, as an automation's is.
    async fn worktree_folder(
        &self,
        source_folder_id: i32,
        worktree: &RunWorktree,
    ) -> Result<i32, CliError> {
        let unavailable = |e: String| CliError::execution("workspace_unavailable", e);
        let source = folder_service::get_folder_by_id(&self.db.conn, source_folder_id)
            .await
            .map_err(|e| unavailable(e.to_string()))?
            .ok_or_else(|| unavailable("the workspace's folder is gone".into()))?;
        let root_id = source.parent_id.unwrap_or(source.id);
        let root_open = folder_service::is_open(&self.db.conn, root_id)
            .await
            .unwrap_or(false);
        if root_open {
            let detail = crate::commands::folders::open_worktree_folder_core(
                &self.db,
                worktree.workspace.clone(),
                source_folder_id,
            )
            .await
            .map_err(|e| unavailable(e.to_string()))?;
            let id = detail.id;
            crate::commands::folders::emit_folder_upsert(&self.emitter, detail);
            return Ok(id);
        }
        let entry = folder_service::ensure_worktree_folder_closed(
            &self.db.conn,
            &worktree.workspace,
            root_id,
        )
        .await
        .map_err(|e| unavailable(e.to_string()))?;
        crate::commands::folders::seed_worktree_alias(&self.db, entry.id, &worktree.workspace)
            .await;
        Ok(entry.id)
    }

    // ── resolution ───────────────────────────────────────────────────────────

    async fn resolve_assistant(&self, key: &str) -> Result<AssistantInfo, CliError> {
        let mut live = assistant_service::list_live_enabled(&self.db.conn)
            .await
            .map_err(|e| CliError::execution("assistants_unavailable", e.to_string()))?;
        let by_id = key.trim().parse::<i32>().ok();
        let wanted = assistant_service::name_key(key.trim());
        // A number is an id first: one assistant's numeric name never shadows
        // another's id (`codeg-cli assistants` shows both).
        let found = by_id
            .and_then(|id| live.iter().position(|a| a.id == id))
            .or_else(|| {
                live.iter()
                    .position(|a| assistant_service::name_key(&a.name) == wanted)
            });
        match found {
            Some(i) => Ok(live.swap_remove(i)),
            None => Err(CliError::usage(
                "unknown_assistant",
                format!("no enabled assistant is named or numbered {key:?}"),
            )
            .with_next_steps(["codeg-cli assistants".to_string()])),
        }
    }

    async fn resolve_agent_slug(&self, slug: &str) -> Result<AgentType, CliError> {
        if let Some(agent) = AgentType::from_wire(slug) {
            // A custom agent's slug is well formed whether or not it is
            // registered; one that is not would only fail at spawn.
            if agent
                .custom_id()
                .is_none_or(crate::acp::custom_registry::is_registered)
            {
                return Ok(agent);
            }
        }
        // `--agent code-reviewer` in the issue's own example: a role, which
        // codeg calls an assistant. Say so, with the exact spelling.
        if let Ok(assistant) = self.resolve_assistant(slug).await {
            return Err(CliError::usage(
                "agent_is_an_assistant",
                format!(
                    "{slug:?} is not an agent but an assistant; --agent takes an agent such as \
                     claude_code or codex"
                ),
            )
            .with_next_steps([format!("--assistant {}", shell_word(&assistant.name))]));
        }
        Err(
            CliError::usage("unknown_agent", format!("{slug:?} is not an agent"))
                .with_next_steps(["codeg-cli agents".to_string()]),
        )
    }

    async fn folder_default_agent(&self, folder_id: i32) -> Result<AgentType, CliError> {
        let detail = crate::commands::folders::get_folder_core(&self.db, folder_id)
            .await
            .map_err(|e| CliError::execution("workspace_unavailable", e.to_string()))?;
        if let Some(agent) = detail.default_agent_type {
            return Ok(agent);
        }
        let enabled: Vec<String> = self
            .agents()
            .await
            .map(|agents| {
                agents
                    .into_iter()
                    .filter(|a| a.enabled)
                    .map(|a| a.slug)
                    .collect()
            })
            .unwrap_or_default();
        Err(CliError::usage(
            "no_agent",
            "no --agent or --assistant given, and this workspace has no default agent",
        )
        .with_next_steps(
            enabled
                .into_iter()
                .take(5)
                .map(|slug| format!("--agent {slug}")),
        ))
    }

    /// `(depth, effective policy, narrowed from)` for a run whose caller is
    /// the connection `caller`.
    async fn nesting(
        &self,
        caller: Option<&str>,
        requested: PermissionPolicy,
    ) -> Result<(u8, PermissionPolicy, Option<PermissionPolicy>), CliError> {
        let Some(caller) = caller.filter(|c| !c.is_empty()) else {
            return Ok((0, requested, None));
        };
        let tag = match self.manager.get_state(caller).await {
            Some(state) => state.read().await.cli_run.clone(),
            // Gone, or a connection of another codeg: an ordinary depth 1.
            None => None,
        };
        let Some(tag) = tag else {
            // Started from a session a person or an automation drives: that
            // command already passed its own permission check.
            return Ok((1, requested, None));
        };
        let depth = tag.depth.saturating_add(1);
        if depth > MAX_DEPTH {
            return Err(CliError::usage(
                "nested_too_deep",
                "a CLI run started from inside a nested CLI run is refused: runs nest one level \
                 deep at most",
            ));
        }
        let policy = requested.narrowed_to(tag.policy);
        let narrowed = (policy != requested).then_some(requested);
        Ok((depth, policy, narrowed))
    }

    // ── explicit selections ──────────────────────────────────────────────────

    /// `--model`, then `--effort`, then `--mode`, then each `-c`: every one
    /// checked against what the agent offers, set, and confirmed by the
    /// agent's own answer before the next — a model switch can rewrite the
    /// effort list, so effort is checked against the list after it. Records
    /// `launch.requested` / `launch.effective`, and returns a notice for each
    /// option of `assistant` that is not in effect (those are applied at
    /// spawn, best-effort, as for a delegated child).
    async fn apply_selections(
        &self,
        run: &Arc<Run>,
        conn: &str,
        state: &Arc<RwLock<SessionState>>,
        agent: AgentType,
        req: &StartRequest,
        assistant: Option<&AssistantInfo>,
    ) -> Result<Vec<EventBody>, CliError> {
        let explicit = req.model.is_some()
            || req.effort.is_some()
            || req.mode.is_some()
            || !req.config.is_empty();
        // Waited for every run: it is when the session is up, so `session`
        // can name it and `launch.effective` can report it — and a session
        // that never comes up fails here, before a conversation row exists.
        // Only explicit selections need it to complete in time; without them
        // a slow agent costs the report, not the run.
        match self.wait_selectors(run, state).await {
            Ok(()) => {}
            Err(err)
                if explicit
                    || matches!(err.body.error.code.as_str(), "agent_exited" | "run_stopped") =>
            {
                return Err(err)
            }
            Err(_) => {}
        }
        // A stop is noticed between selections too: each may wait on the
        // agent, and a timeout must not wait for all of them.
        let mut unconfirmed = wire::Unconfirmed::default();
        if let Some(model) = &req.model {
            self.check_stopped(run).await?;
            let outcome = self
                .set_category(conn, state, "model", model, "--model")
                .await?;
            unconfirmed.model = outcome == SetterOutcome::Accepted;
        }
        if let Some(effort) = &req.effort {
            self.check_stopped(run).await?;
            let outcome = self
                .set_category(conn, state, "thought_level", effort, "--effort")
                .await?;
            unconfirmed.effort = outcome == SetterOutcome::Accepted;
        }
        if let Some(mode) = &req.mode {
            self.check_stopped(run).await?;
            let outcome = self.set_mode(conn, state, agent, mode).await?;
            unconfirmed.mode = outcome == SetterOutcome::Accepted;
        }
        let mut unconfirmed_options = Vec::new();
        for (id, value) in &req.config {
            self.check_stopped(run).await?;
            let flag = format!("-c {id}");
            let option = find_option(state, |o| o.id == *id).await.ok_or_else(|| {
                CliError::usage(
                    "unknown_config_option",
                    format!("{} offers no option {id:?}", agent.as_wire()),
                )
            })?;
            check_value(&option, value, &flag)?;
            let outcome = self
                .wait_setter(
                    self.manager
                        .set_config_option_and_wait(conn, id.clone(), value.clone()),
                    &flag,
                )
                .await?;
            expect_landed(&flag, value, &outcome)?;
            if outcome == SetterOutcome::Accepted {
                match option.category.as_deref() {
                    Some("model") => unconfirmed.model = true,
                    Some("thought_level") => unconfirmed.effort = true,
                    Some("mode") => unconfirmed.mode = true,
                    _ => unconfirmed_options.push(id.clone()),
                }
            }
        }

        let effective = current_selection(state).await;
        let from_assistant = assistant_selection(state, assistant).await;
        let requested = LaunchSelection {
            model: req.model.clone().or_else(|| from_assistant.model.clone()),
            effort: req.effort.clone().or_else(|| from_assistant.effort.clone()),
            mode: req.mode.clone().or_else(|| from_assistant.mode.clone()),
        };
        let mut notices = Vec::new();
        for id in unconfirmed_options {
            notices.push(EventBody::Notice {
                severity: "warning".into(),
                title: format!("-c {id}: the agent took the value without confirming it"),
                message: None,
            });
        }
        for (label, asked, flag_given, got) in [
            (
                "model",
                &from_assistant.model,
                req.model.is_some(),
                &effective.model,
            ),
            (
                "effort",
                &from_assistant.effort,
                req.effort.is_some(),
                &effective.effort,
            ),
            (
                "mode",
                &from_assistant.mode,
                req.mode.is_some(),
                &effective.mode,
            ),
        ] {
            if let (Some(asked), false) = (asked, flag_given) {
                if got.as_deref() != Some(asked.as_str()) {
                    notices.push(EventBody::Notice {
                        severity: "warning".into(),
                        title: format!("the assistant's {label} {asked:?} is not in effect"),
                        message: Some(format!(
                            "the session runs with {}",
                            got.as_deref().unwrap_or("the agent's default")
                        )),
                    });
                }
            }
        }
        let mut inner = run.inner.lock().await;
        inner.launch = Launch {
            requested,
            effective,
            unconfirmed,
        };
        Ok(notices)
    }

    async fn wait_selectors(
        &self,
        run: &Run,
        state: &Arc<RwLock<SessionState>>,
    ) -> Result<(), CliError> {
        let deadline = Instant::now() + self.timings.selectors;
        loop {
            self.check_stopped(run).await?;
            {
                let s = state.read().await;
                if s.selectors_ready {
                    return Ok(());
                }
                if matches!(
                    s.status,
                    ConnectionStatus::Disconnected | ConnectionStatus::Error
                ) {
                    return Err(CliError::execution(
                        "agent_exited",
                        "the agent process ended before it published its options",
                    ));
                }
            }
            if Instant::now() >= deadline {
                return Err(CliError::execution(
                    "selectors_timeout",
                    format!(
                        "the agent did not publish its options within {} seconds, so the \
                         explicit selections could not be checked",
                        self.timings.selectors.as_secs()
                    ),
                ));
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    async fn set_category(
        &self,
        conn: &str,
        state: &Arc<RwLock<SessionState>>,
        category: &str,
        value: &str,
        flag: &str,
    ) -> Result<SetterOutcome, CliError> {
        let option = find_option(state, |o| o.category.as_deref() == Some(category))
            .await
            .ok_or_else(|| {
                CliError::usage(
                    "option_unavailable",
                    format!("this agent offers nothing {flag} could set"),
                )
            })?;
        check_value(&option, value, flag)?;
        if current_value(&option).as_deref() == Some(value) {
            return Ok(SetterOutcome::Confirmed {
                current: value.to_string(),
            });
        }
        let outcome = self
            .wait_setter(
                self.manager
                    .set_config_option_and_wait(conn, option.id.clone(), value.to_string()),
                flag,
            )
            .await?;
        expect_landed(flag, value, &outcome)?;
        Ok(outcome)
    }

    async fn set_mode(
        &self,
        conn: &str,
        state: &Arc<RwLock<SessionState>>,
        agent: AgentType,
        mode: &str,
    ) -> Result<SetterOutcome, CliError> {
        let (current, available) = {
            let s = state.read().await;
            match &s.modes {
                Some(modes) => (
                    s.current_mode
                        .clone()
                        .or_else(|| Some(modes.current_mode_id.clone())),
                    modes
                        .available_modes
                        .iter()
                        .map(|m| m.id.clone())
                        .collect::<Vec<_>>(),
                ),
                None => (None, Vec::new()),
            }
        };
        if available.is_empty() {
            // Some agents publish their modes as a `mode` config option only.
            if find_option(state, |o| o.category.as_deref() == Some("mode"))
                .await
                .is_some()
            {
                return self.set_category(conn, state, "mode", mode, "--mode").await;
            }
            return Err(CliError::usage(
                "option_unavailable",
                format!("{} has no modes for --mode to set", agent.as_wire()),
            ));
        }
        if !available.iter().any(|m| m == mode) {
            return Err(CliError::usage(
                "unknown_mode",
                format!(
                    "{mode:?} is not one of this agent's modes: {}",
                    available.join(", ")
                ),
            ));
        }
        if current.as_deref() == Some(mode) {
            return Ok(SetterOutcome::Confirmed {
                current: mode.to_string(),
            });
        }
        let outcome = self
            .wait_setter(
                self.manager.set_mode_and_wait(conn, mode.to_string()),
                "--mode",
            )
            .await?;
        expect_landed("--mode", mode, &outcome)?;
        Ok(outcome)
    }

    async fn wait_setter(
        &self,
        setter: impl std::future::Future<Output = Result<SetterOutcome, crate::acp::error::AcpError>>,
        flag: &str,
    ) -> Result<SetterOutcome, CliError> {
        match tokio::time::timeout(self.timings.setter, setter).await {
            Ok(Ok(outcome)) => Ok(outcome),
            Ok(Err(e)) => Err(CliError::usage(
                "selection_failed",
                format!("the agent did not take {flag}: {e}"),
            )),
            Err(_) => Err(CliError::usage(
                "selection_unconfirmed",
                format!(
                    "the agent did not answer {flag} within {} seconds",
                    self.timings.setter.as_secs()
                ),
            )),
        }
    }

    // ── events of the root connection ────────────────────────────────────────

    async fn pump(
        self: Arc<Self>,
        run: Arc<Run>,
        conn: String,
        state: Arc<RwLock<SessionState>>,
        mut rx: broadcast::Receiver<Arc<EventEnvelope>>,
    ) {
        let mut last_seq = 0u64;
        loop {
            let (envelopes, lost) = match rx.recv().await {
                Ok(env) => (vec![env], false),
                // Fell behind: what was skipped is still in the connection's
                // ring buffer (`recent_events_after`), so a TurnComplete is
                // never lost to lag.
                Err(RecvError::Lagged(_)) => {
                    let replay = state.read().await.recent_events_after(last_seq);
                    match replay {
                        Some(events) => (events, false),
                        None => {
                            tracing::warn!(
                                "[cli] run {}: fell behind its connection's events beyond the \
                                 replay buffer",
                                run.id
                            );
                            // What is left of them still counts (the asks lost
                            // with the rest are the backstop's to answer);
                            // the turn's end, if lost too, is read off the
                            // state once these are handled.
                            let retained =
                                state.read().await.recent_events_retained_after(last_seq);
                            (retained, true)
                        }
                    }
                }
                Err(RecvError::Closed) => {
                    self.connection_lost(&run).await;
                    return;
                }
            };
            for env in envelopes {
                if env.seq <= last_seq {
                    continue;
                }
                last_seq = env.seq;
                if let Some(turn) = self.on_root_event(&run, &conn, &env).await {
                    self.finish(&run, &conn, &state, &mut rx, turn).await;
                    return;
                }
            }
            if lost {
                if let Some(turn) = self.turn_ended_unseen(&run, &state).await {
                    self.settle_turn(&run, &turn.stop_reason).await;
                    self.finish(&run, &conn, &state, &mut rx, turn).await;
                    return;
                }
            }
        }
    }

    /// Handle one root-connection event. `Some` when the turn is over.
    async fn on_root_event(
        &self,
        run: &Arc<Run>,
        conn: &str,
        env: &EventEnvelope,
    ) -> Option<TurnEnd> {
        match &env.payload {
            AcpEvent::TurnComplete { stop_reason, .. } => {
                self.settle_turn(run, stop_reason).await;
                return Some(TurnEnd {
                    seq: env.seq,
                    stop_reason: stop_reason.clone(),
                });
            }
            AcpEvent::StatusChanged {
                status: ConnectionStatus::Disconnected,
            }
            | AcpEvent::Error { terminal: true, .. } => {
                if let AcpEvent::Error { message, .. } = &env.payload {
                    run.inner.lock().await.last_error = Some(message.clone());
                }
                self.connection_lost(run).await;
                return Some(TurnEnd {
                    seq: env.seq,
                    stop_reason: "disconnected".into(),
                });
            }
            AcpEvent::SessionStarted { session_id } => {
                run.inner.lock().await.session_id = Some(session_id.clone());
            }
            _ => {}
        }
        if let Some(text) = events::error_text(&env.payload) {
            run.inner.lock().await.last_error = Some(text);
        }
        if !self.on_ask_event(run, conn, &env.payload).await {
            if let Some(body) = events::translate(&env.payload) {
                let mut inner = run.inner.lock().await;
                run.push(&mut inner, body);
            }
        }
        None
    }

    /// The connection ended before its turn did.
    async fn connection_lost(&self, run: &Arc<Run>) {
        let mut inner = run.inner.lock().await;
        if inner.phase == Phase::Settled {
            return;
        }
        // A stop, or `fail` waiting for its refusal's resolution when the
        // agent went: what ended the run, before the exit itself.
        let cause = inner.stop.clone().or_else(|| {
            inner
                .permission_failure
                .clone()
                .map(|tool| StopCause::PermissionRequired { tool })
        });
        let (subtype, error) = match cause {
            Some(cause) => stop_outcome(&cause),
            None => (
                Subtype::ErrorDuringExecution,
                Some(ErrorInfo {
                    code: "agent_exited".into(),
                    message: inner.last_error.clone().unwrap_or_else(|| {
                        "the agent process ended before the turn completed".into()
                    }),
                    next_steps: Vec::new(),
                }),
            ),
        };
        let text = self.final_text(&inner).await;
        self.settle_locked(run, &mut inner, subtype, text, None, error, None)
            .await;
    }

    /// After events were lost: the run's turn, when the root connection's
    /// state shows it ended. Its stop reason is gone with its envelope; the
    /// state keeps whether it ended normally.
    async fn turn_ended_unseen(
        &self,
        run: &Run,
        state: &Arc<RwLock<SessionState>>,
    ) -> Option<TurnEnd> {
        let before = run.inner.lock().await.turns_before_prompt?;
        let s = state.read().await;
        (s.turns_completed > before && !s.turn_in_flight).then(|| TurnEnd {
            seq: LOST_TURN_SEQ,
            stop_reason: if s.last_turn_ended_abnormally {
                "unknown".into()
            } else {
                "end_turn".into()
            },
        })
    }

    /// After the turn: wait for the lifecycle worker to record the row's
    /// final status (or record it ourselves when the worker never got the
    /// turn), THEN let the connection go — disconnecting first is what makes
    /// a successful session read as cancelled.
    async fn finish(
        &self,
        run: &Arc<Run>,
        conn: &str,
        state: &Arc<RwLock<SessionState>>,
        rx: &mut broadcast::Receiver<Arc<EventEnvelope>>,
        turn: TurnEnd,
    ) {
        let conversation_id = run.inner.lock().await.conversation_id;
        let writes_status =
            crate::acp::lifecycle::turn_complete_status(&turn.stop_reason).is_some();
        if let (Some(cid), true) = (conversation_id, writes_status) {
            // Two rounds. In each, the worker's write shows up as its event, or
            // the fallback writes the row itself: for a turn the worker never
            // got, or gave up on after its retries. A turn the worker still
            // holds gets another round, and so does a fallback write that
            // failed.
            for _ in 0..2 {
                if wait_status_changed(rx, cid, self.timings.status).await
                    || self.fallback_status_write(run, state, cid, &turn).await
                {
                    break;
                }
            }
        }
        let _ = self.manager.disconnect(conn).await;
    }

    /// The fallback's write of a turn's conversation status: one conditional
    /// update, only over a row the turn left in progress — so it can undo
    /// nothing: not the worker's write, not a cancel's, not a person's later
    /// choice. It does not wait on the worker's claim either: a worker that
    /// holds the turn and never writes it (slow, gone, out of retries) leaves
    /// nothing this write could spoil. Once it wrote, it claims the turn when
    /// the turn is free, so a late worker write skips. `true` once the row is
    /// final; `false` sends it to the next round.
    async fn fallback_status_write(
        &self,
        run: &Run,
        state: &Arc<RwLock<SessionState>>,
        conversation_id: i32,
        turn: &TurnEnd,
    ) -> bool {
        let Some(status) = crate::acp::lifecycle::turn_complete_status(&turn.stop_reason) else {
            return true;
        };
        match conversation_service::update_status_if(
            &self.db.conn,
            conversation_id,
            ConversationStatus::InProgress,
            status.clone(),
        )
        .await
        {
            Ok(moved) => {
                if moved {
                    if turn.seq != LOST_TURN_SEQ {
                        let _ = state
                            .write()
                            .await
                            .claim_turn_status(turn.seq, TurnStatusWriter::CliFallback);
                    }
                    // The connection was spawned with this emitter.
                    crate::web::event_bridge::emit_with_state(
                        state,
                        &self.emitter,
                        AcpEvent::ConversationStatusChanged {
                            conversation_id,
                            status,
                        },
                    )
                    .await;
                }
                true
            }
            Err(e) => {
                tracing::warn!(
                    "[cli] run {}: could not record the conversation's status: {e}",
                    run.id
                );
                false
            }
        }
    }

    // ── permission requests, questions, plan approvals ───────────────────────

    /// The asks of any connection of the run. `true` when `event` was one.
    async fn on_ask_event(&self, run: &Arc<Run>, conn: &str, event: &AcpEvent) -> bool {
        if !is_ask(event) {
            return matches!(
                event,
                AcpEvent::PermissionQueueDepth { .. }
                    | AcpEvent::QuestionResolved { .. }
                    | AcpEvent::PlanApprovalResolved { .. }
            );
        }
        let conversation_id = match self.manager.get_state(conn).await {
            Some(state) => state.read().await.conversation_id,
            None => None,
        };
        match event {
            AcpEvent::PermissionRequest {
                request_id,
                tool_call,
                options,
                ..
            } => {
                self.on_permission_request(
                    run,
                    conn,
                    conversation_id,
                    request_id,
                    tool_call,
                    options,
                )
                .await;
                true
            }
            AcpEvent::PermissionResolved {
                request_id,
                option_id,
                origin,
            } => {
                self.on_permission_resolved(run, request_id, option_id.as_deref(), origin.as_ref())
                    .await;
                true
            }
            AcpEvent::QuestionRequest { question_id, .. } => {
                self.on_question(run, conn, conversation_id, question_id)
                    .await;
                true
            }
            AcpEvent::PlanApprovalRequest { approval_id, .. } => {
                self.on_plan_approval(run, conn, approval_id).await;
                true
            }
            _ => false,
        }
    }

    async fn on_permission_request(
        &self,
        run: &Arc<Run>,
        conn: &str,
        conversation_id: Option<i32>,
        request_id: &str,
        tool_call: &serde_json::Value,
        options: &[PermissionOptionInfo],
    ) {
        let tool = tool_call
            .get("title")
            .and_then(|v| v.as_str())
            .filter(|t| !t.is_empty())
            .unwrap_or("tool")
            .to_string();
        let tool_kind = tool_call
            .get("kind")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let mut inner = run.inner.lock().await;
        if !inner.handled.insert(request_id.to_string()) {
            return;
        }
        inner.requests.insert(
            request_id.to_string(),
            SeenRequest {
                conversation_id,
                tool: tool.clone(),
                tool_kind: tool_kind.clone(),
                options: options.to_vec(),
            },
        );
        let settled = inner.phase == Phase::Settled;
        let policy = inner.policy;
        let decision = decide_permission(policy, options, tool_kind.as_deref());
        let origin = PermissionAnswerOrigin::CliPolicy {
            run_id: run.id.clone(),
        };
        match decision {
            PermissionDecision::Answer { option_id, allowed } => {
                if policy == PermissionPolicy::Allow && !allowed && !settled {
                    run.push(
                        &mut inner,
                        EventBody::Notice {
                            severity: "warning".into(),
                            title: format!("{tool}: refused, not allowed"),
                            message: Some(
                                "the request offers no allow-once option, and the policy never \
                                 picks one that would save a standing rule"
                                    .into(),
                            ),
                        },
                    );
                }
                drop(inner);
                let _ = self
                    .manager
                    .respond_permission_from(conn, request_id, &option_id, origin)
                    .await;
            }
            PermissionDecision::AnswerThenFail { option_id } => {
                // After the result is fixed, `fail` no longer changes it; just
                // keep the child from waiting until it is let go.
                if !settled {
                    inner.permission_failure.get_or_insert_with(|| tool.clone());
                    run.push(
                        &mut inner,
                        EventBody::Permission {
                            request_id: request_id.to_string(),
                            conversation_id,
                            tool: tool.clone(),
                            tool_kind,
                            decision: PermissionVerdict::Failed,
                            decided_by: Some(DecidedBy::Policy),
                            option_name: None,
                        },
                    );
                }
                // With a refusal to send, the run ends once its resolution
                // says which answer took effect — the refusal, or a person's
                // that came first — so the result records the real one
                // (`on_permission_resolved`; the backstop ends it if none
                // comes). With none, the request is withdrawn by the cancel.
                let waits = !settled && option_id.is_some() && inner.failing.is_none();
                if waits {
                    inner.failing = Some((request_id.to_string(), Instant::now()));
                }
                drop(inner);
                if let Some(option_id) = option_id {
                    let _ = self
                        .manager
                        .respond_permission_from(conn, request_id, &option_id, origin)
                        .await;
                }
                if !settled && !waits {
                    self.stop_run(run, StopCause::PermissionRequired { tool })
                        .await;
                }
            }
            PermissionDecision::Leave => {
                run.push(
                    &mut inner,
                    EventBody::Permission {
                        request_id: request_id.to_string(),
                        conversation_id,
                        tool,
                        tool_kind,
                        decision: PermissionVerdict::Waiting,
                        decided_by: None,
                        option_name: None,
                    },
                );
            }
        }
    }

    async fn on_permission_resolved(
        &self,
        run: &Arc<Run>,
        request_id: &str,
        option_id: Option<&str>,
        origin: Option<&PermissionAnswerOrigin>,
    ) {
        let mut inner = run.inner.lock().await;
        let Some(seen) = inner.requests.get(request_id).cloned() else {
            return;
        };
        if !inner.reported.insert(request_id.to_string()) {
            return;
        }
        let option = option_id.and_then(|id| seen.options.iter().find(|o| o.option_id == id));
        let decision = match (option_id, option) {
            (None, _) => PermissionVerdict::Withdrawn,
            (Some(_), Some(o)) if o.kind.starts_with("allow") => PermissionVerdict::Allowed,
            (Some(_), _) => PermissionVerdict::Denied,
        };
        let decided_by = match origin {
            None => DecidedBy::Withdrawn,
            Some(PermissionAnswerOrigin::CliPolicy { .. }) => DecidedBy::Policy,
            Some(PermissionAnswerOrigin::User | PermissionAnswerOrigin::ChatChannel) => {
                DecidedBy::User
            }
        };
        if inner.phase == Phase::Settled {
            return;
        }
        if decision == PermissionVerdict::Denied {
            inner.denials.push(PermissionDenial {
                tool_name: seen.tool.clone(),
                tool_kind: seen.tool_kind.clone(),
                request_id: request_id.to_string(),
                conversation_id: seen.conversation_id,
            });
        }
        let tool = seen.tool.clone();
        run.push(
            &mut inner,
            EventBody::Permission {
                request_id: request_id.to_string(),
                conversation_id: seen.conversation_id,
                tool: seen.tool,
                tool_kind: seen.tool_kind,
                decision,
                decided_by: Some(decided_by),
                option_name: option.map(|o| o.name.clone()),
            },
        );
        if inner
            .failing
            .as_ref()
            .is_some_and(|(failing, _)| failing == request_id)
        {
            inner.failing = None;
            drop(inner);
            self.stop_run(run, StopCause::PermissionRequired { tool })
                .await;
        }
    }

    async fn on_question(
        &self,
        run: &Arc<Run>,
        conn: &str,
        conversation_id: Option<i32>,
        question_id: &str,
    ) {
        let mut inner = run.inner.lock().await;
        if !inner.handled.insert(format!("question:{question_id}")) {
            return;
        }
        let decision = if inner.policy == PermissionPolicy::Wait {
            QuestionVerdict::Waiting
        } else {
            QuestionVerdict::Declined
        };
        run.push(
            &mut inner,
            EventBody::Question {
                question_id: question_id.to_string(),
                conversation_id,
                decision,
            },
        );
        drop(inner);
        if decision == QuestionVerdict::Declined {
            // As if the card were dismissed: the agent goes on by its own
            // judgment.
            let _ = self
                .manager
                .answer_question(
                    conn,
                    question_id,
                    QuestionAnswer {
                        answers: Vec::new(),
                        declined: true,
                    },
                )
                .await;
        }
    }

    async fn on_plan_approval(&self, run: &Arc<Run>, conn: &str, approval_id: &str) {
        let mut inner = run.inner.lock().await;
        if !inner.handled.insert(format!("plan:{approval_id}")) {
            return;
        }
        let settled = inner.phase == Phase::Settled;
        let policy = inner.policy;
        let decision = match policy {
            PermissionPolicy::Wait => {
                run.push(
                    &mut inner,
                    EventBody::Notice {
                        severity: "info".into(),
                        title: "the agent's plan is waiting for approval in Codeg".into(),
                        message: None,
                    },
                );
                return;
            }
            PermissionPolicy::Allow => PlanApprovalDecision::Approve,
            PermissionPolicy::Deny | PermissionPolicy::Reads | PermissionPolicy::Fail => {
                PlanApprovalDecision::Abandon
            }
        };
        let fails = policy == PermissionPolicy::Fail && !settled;
        if fails {
            inner
                .permission_failure
                .get_or_insert_with(|| "plan approval".to_string());
        }
        drop(inner);
        let _ = self
            .manager
            .answer_plan_approval(
                conn,
                approval_id,
                PlanApprovalAnswer {
                    decision,
                    feedback: None,
                },
            )
            .await;
        if fails {
            self.stop_run(
                run,
                StopCause::PermissionRequired {
                    tool: "plan approval".into(),
                },
            )
            .await;
        }
    }

    /// Delegated children's asks arrive on the process-wide bus (the root's
    /// arrive on its own stream, in `pump`).
    async fn child_asks_loop(self: Arc<Self>) {
        let mut rx = self.bus.subscribe();
        // The last ask seen on each delegated connection: where a replay
        // after a lag resumes.
        let mut seen: HashMap<String, u64> = HashMap::new();
        loop {
            match rx.recv().await {
                Ok(env) => self.on_child_envelope(&env, &mut seen).await,
                // What the bus skipped is still in each delegated connection's
                // own buffer — answers included, which the backstop's scan of
                // waiting cards cannot see. Older still is the backstop's.
                Err(RecvError::Lagged(_)) => self.replay_children(&mut seen).await,
                Err(RecvError::Closed) => return,
            }
        }
    }

    async fn on_child_envelope(&self, env: &EventEnvelope, seen: &mut HashMap<String, u64>) {
        if !is_ask(&env.payload) {
            return;
        }
        if seen
            .get(&env.connection_id)
            .is_some_and(|last| env.seq <= *last)
        {
            return;
        }
        let Some(state) = self.manager.get_state(&env.connection_id).await else {
            return;
        };
        let Some(tag) = state.read().await.cli_run.clone() else {
            return;
        };
        let Some(run) = self.run(&tag.run_id) else {
            return;
        };
        let root = run.inner.lock().await.connection_id.clone();
        if root.as_deref() == Some(env.connection_id.as_str()) {
            return;
        }
        seen.insert(env.connection_id.clone(), env.seq);
        self.on_ask_event(&run, &env.connection_id, &env.payload)
            .await;
    }

    async fn replay_children(&self, seen: &mut HashMap<String, u64>) {
        let mut live = HashSet::new();
        for run in self.live_runs() {
            for (conn, state) in self.manager.connections_of_cli_run(&run.id).await {
                live.insert(conn.clone());
                let after = seen.get(&conn).copied().unwrap_or(0);
                let replay = state.read().await.recent_events_retained_after(after);
                for env in replay {
                    // The root connection's are its pump's; skipped inside.
                    self.on_child_envelope(&env, seen).await;
                }
            }
        }
        seen.retain(|conn, _| live.contains(conn));
    }

    /// Answer what is still waiting on any connection of `run` — cards the
    /// subscriptions missed. Idempotent: every ask is acted on once.
    async fn reconcile_run(&self, run: &Arc<Run>) {
        // `fail` waited long enough for its refusal's resolution.
        let overdue = {
            let mut inner = run.inner.lock().await;
            match &inner.failing {
                Some((_, since)) if since.elapsed() >= self.timings.fail_answer => {
                    inner.failing = None;
                    inner.permission_failure.clone()
                }
                _ => None,
            }
        };
        if let Some(tool) = overdue {
            self.stop_run(run, StopCause::PermissionRequired { tool })
                .await;
            return;
        }
        for (conn, state) in self.manager.connections_of_cli_run(&run.id).await {
            let (conversation_id, permission, question, plan) = {
                let s = state.read().await;
                (
                    s.conversation_id,
                    s.pending_permission.clone(),
                    s.pending_question.as_ref().map(|q| q.question_id.clone()),
                    s.pending_plan_approval
                        .as_ref()
                        .map(|p| p.approval_id.clone()),
                )
            };
            if let Some(p) = permission {
                self.on_permission_request(
                    run,
                    &conn,
                    conversation_id,
                    &p.request_id,
                    &p.tool_call,
                    &p.options,
                )
                .await;
            }
            if let Some(question_id) = question {
                self.on_question(run, &conn, conversation_id, &question_id)
                    .await;
            }
            if let Some(approval_id) = plan {
                self.on_plan_approval(run, &conn, &approval_id).await;
            }
        }
    }

    async fn reconcile_all(&self) {
        for run in self.live_runs() {
            let unsettled = run.inner.lock().await.phase != Phase::Settled;
            if unsettled {
                self.reconcile_run(&run).await;
            }
        }
    }

    // ── settling and stopping ────────────────────────────────────────────────

    /// The root connection's turn ended.
    async fn settle_turn(&self, run: &Arc<Run>, stop_reason: &str) {
        let mut inner = run.inner.lock().await;
        if inner.phase == Phase::Settled {
            return;
        }
        // `fail` against settling: a delegated child's request may have been
        // applied to its state but not yet seen by the bus subscriber. Any
        // request that was emitted is in its connection's state by now (state
        // first, then the broadcast), so this scan cannot miss one.
        let mut failure = inner.permission_failure.clone();
        if failure.is_none() && inner.policy == PermissionPolicy::Fail {
            for (_, state) in self.manager.connections_of_cli_run(&run.id).await {
                if let Some(p) = &state.read().await.pending_permission {
                    let tool = p
                        .tool_call
                        .get("title")
                        .and_then(|v| v.as_str())
                        .unwrap_or("tool")
                        .to_string();
                    failure = Some(tool);
                    break;
                }
            }
        }
        let text = self.final_text(&inner).await;
        let (subtype, error) = if let Some(tool) = failure {
            stop_outcome(&StopCause::PermissionRequired { tool })
        } else if stop_reason == "end_turn" {
            (Subtype::Success, None)
        } else if stop_reason == "cancelled" {
            match inner.stop.clone() {
                Some(cause) => stop_outcome(&cause),
                None => (
                    Subtype::ErrorDuringExecution,
                    Some(ErrorInfo {
                        code: "cancelled".into(),
                        message: "the turn was cancelled in Codeg".into(),
                        next_steps: Vec::new(),
                    }),
                ),
            }
        } else {
            (
                Subtype::ErrorDuringExecution,
                Some(ErrorInfo {
                    code: format!("stop_{stop_reason}"),
                    message: inner
                        .last_error
                        .clone()
                        .unwrap_or_else(|| format!("the agent stopped: {stop_reason}")),
                    next_steps: Vec::new(),
                }),
            )
        };
        self.settle_locked(
            run,
            &mut inner,
            subtype,
            text,
            Some(stop_reason.to_string()),
            error,
            None,
        )
        .await;
    }

    async fn final_text(&self, inner: &RunInner) -> Option<String> {
        let state = inner.root_state.as_ref()?;
        let text = state.read().await.last_assistant_text.clone();
        text.filter(|t| !t.trim().is_empty())
    }

    #[allow(clippy::too_many_arguments)]
    async fn settle_locked(
        &self,
        run: &Arc<Run>,
        inner: &mut RunInner,
        subtype: Subtype,
        text: Option<String>,
        stop_reason: Option<String>,
        error: Option<ErrorInfo>,
        pending: Option<Vec<PendingCard>>,
    ) -> bool {
        if inner.phase == Phase::Settled {
            return false;
        }
        // `--output-schema`: the result that matches, or why there is none —
        // which fails a turn that otherwise went well. A run that failed for
        // its own reason keeps it.
        let (mut subtype, mut error) = (subtype, error);
        let mut structured_output = None;
        if inner.structured {
            let settled = match &inner.output_schema {
                Some(schema) => {
                    let offered = match &inner.root_state {
                        Some(state) => state.read().await.result_tool_available,
                        None => false,
                    };
                    Some(schema.settle(text.as_deref(), offered))
                }
                // Refused as no schema, or a launch that failed before it got
                // that far: the run's own error says why.
                None => None,
            };
            let (output, unmet) = match settled {
                Some(settled) => (settled.output, settled.unmet),
                None => (None, None),
            };
            if output.is_none() && subtype == Subtype::Success {
                subtype = Subtype::ErrorMaxStructuredOutputRetries;
                error = Some(ErrorInfo {
                    code: "output_schema_unmet".into(),
                    message: unmet.unwrap_or_else(|| {
                        "the agent handed in no result that matches --output-schema".into()
                    }),
                    next_steps: Vec::new(),
                });
            }
            structured_output = Some(output.unwrap_or(serde_json::Value::Null));
        }
        let result = RunResult {
            subtype,
            is_error: subtype.is_error(),
            result: text,
            session_id: inner.session_id.clone(),
            stop_reason,
            duration_ms: run.begun.elapsed().as_millis() as u64,
            permission_denials: inner.denials.clone(),
            launch: inner.launch.clone(),
            pending,
            conversation_id: inner.conversation_id,
            link: inner.conversation_id.map(wire::session_link),
            agent: inner.agent.clone(),
            assistant: inner.assistant.clone(),
            target_index: None,
            worktree: inner.worktree.as_ref().map(|w| w.info()),
            structured_output,
            error,
        };
        inner.result = Some(result.clone());
        // The result goes out even before `init` (a launch that failed early).
        inner.reporting = true;
        run.push(inner, EventBody::Result(Box::new(result)));
        inner.phase = Phase::Settled;
        inner.settled_at = Some(Instant::now());
        run.changed.notify_waiters();
        self.mark_settled(&run.id);
        true
    }

    /// Stop a run from outside its turn: timeout, Ctrl-C, `fail`, a user.
    /// Waits for the launch to queue its prompt or give up (it holds the
    /// launch lock until then), so the cancel never interleaves with it.
    async fn stop_run(&self, run: &Arc<Run>, cause: StopCause) {
        {
            let mut inner = run.inner.lock().await;
            if inner.phase == Phase::Settled {
                return;
            }
            if inner.stop.is_none() {
                inner.stop = Some(cause.clone());
            }
        }
        let _launch = run.launch.lock().await;
        // Checked, read and settled under one hold of the run's lock: a turn
        // that ends on its own meanwhile cannot settle in between, leaving
        // this stop to cancel a run that already succeeded.
        let (conn, conversation_id) = {
            let mut inner = run.inner.lock().await;
            if inner.phase == Phase::Settled {
                return;
            }
            let cause = inner.stop.clone().unwrap_or(cause);
            // Cards still waiting for a person, BEFORE the cancel drains them.
            let pending = if matches!(cause, StopCause::Timeout) {
                Some(self.pending_cards(&run.id).await)
            } else {
                None
            };
            // The result first, with the cards just read: the cancel below
            // ends the turn, and its `TurnComplete{cancelled}` must find
            // nothing left to decide.
            let (subtype, error) = stop_outcome(&cause);
            let text = self.final_text(&inner).await;
            self.settle_locked(
                run,
                &mut inner,
                subtype,
                text,
                Some("cancelled".into()),
                error,
                pending.filter(|p| !p.is_empty()),
            )
            .await;
            (inner.connection_id.clone(), inner.conversation_id)
        };
        if let Some(conn) = &conn {
            let _ = self.manager.cancel(&self.db.conn, conn).await;
        }
        if let Some(cid) = conversation_id {
            self.converge_cancelled(cid).await;
        }
        if let Some(conn) = &conn {
            let _ = self.manager.disconnect(conn).await;
        }
    }

    /// Every card still waiting for a person on the run's connections:
    /// permission requests, questions and plan approvals.
    async fn pending_cards(&self, run_id: &str) -> Vec<PendingCard> {
        let mut cards = Vec::new();
        for (_, state) in self.manager.connections_of_cli_run(run_id).await {
            let s = state.read().await;
            if let Some(p) = &s.pending_permission {
                cards.push(PendingCard {
                    request_id: p.request_id.clone(),
                    conversation_id: s.conversation_id,
                    tool: p
                        .tool_call
                        .get("title")
                        .and_then(|v| v.as_str())
                        .unwrap_or("tool")
                        .to_string(),
                });
            }
            if let Some(q) = &s.pending_question {
                cards.push(PendingCard {
                    request_id: q.question_id.clone(),
                    conversation_id: s.conversation_id,
                    tool: "question".into(),
                });
            }
            if let Some(p) = &s.pending_plan_approval {
                cards.push(PendingCard {
                    request_id: p.approval_id.clone(),
                    conversation_id: s.conversation_id,
                    tool: "plan approval".into(),
                });
            }
        }
        cards
    }

    /// Leave a conversation row the run created in a final state.
    async fn converge_cancelled(&self, conversation_id: i32) {
        use sea_orm::{ActiveModelTrait, EntityTrait, IntoActiveModel, Set};
        let Ok(Some(row)) = conversation::Entity::find_by_id(conversation_id)
            .one(&self.db.conn)
            .await
        else {
            return;
        };
        if row.status != ConversationStatus::InProgress {
            return;
        }
        let mut active = row.into_active_model();
        active.status = Set(ConversationStatus::Cancelled);
        if active.update(&self.db.conn).await.is_ok() {
            crate::commands::conversations::emit_conversation_upsert(
                &self.emitter,
                &self.db.conn,
                conversation_id,
            )
            .await;
        }
    }

    pub async fn cancel(
        self: &Arc<Self>,
        run_id: &str,
        reason: CancelReason,
    ) -> Result<(), CliError> {
        {
            let mut reg = self.registry.lock().expect("registry");
            if let Some(Entry::Reserved { .. }) = reg.entries.get(run_id) {
                // Withdrawing a reservation leaves nothing to start: a late
                // `start` for it is refused.
                reg.entries.remove(run_id);
                return Ok(());
            }
        }
        if let Some(run) = self.run(run_id) {
            // Detached, like the launch: a CLI that stops waiting (a second
            // Ctrl-C) still gets its run cancelled.
            let svc = Arc::clone(self);
            let stopping = tokio::spawn(async move { svc.stop_run(&run, reason.into()).await });
            let _ = stopping.await;
        }
        Ok(())
    }

    // ── reading ──────────────────────────────────────────────────────────────

    pub async fn events(&self, req: &EventsRequest) -> Result<EventsResponse, CliError> {
        let run = self
            .run(&req.run_id)
            .ok_or_else(|| CliError::run_not_found(&req.run_id))?;
        // From the request's arrival: the reconciliation below counts.
        let wait = Duration::from_millis(req.wait_ms).min(MAX_POLL_WAIT);
        let deadline = tokio::time::Instant::now() + wait;
        if run.inner.lock().await.phase != Phase::Settled {
            self.reconcile_run(&run).await;
        }
        loop {
            let notified = run.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let inner = run.inner.lock().await;
                let response = read_after(&run, &inner, req.after);
                if !response.events.is_empty() || response.done {
                    return Ok(response);
                }
            }
            tokio::select! {
                _ = &mut notified => continue,
                _ = tokio::time::sleep_until(deadline) => {
                    let inner = run.inner.lock().await;
                    return Ok(read_after(&run, &inner, req.after));
                }
            }
        }
    }

    /// The run's state and, once it settled, its result. With `waitMs`, a run
    /// still going is waited for that long (capped like a poll) first.
    pub async fn get(&self, req: &GetRequest) -> Result<GetResponse, CliError> {
        if let Some(Entry::Reserved { .. }) = self
            .registry
            .lock()
            .expect("registry")
            .entries
            .get(&req.run_id)
        {
            return Ok(GetResponse {
                state: RunState::Reserved,
                result: None,
                conversation_id: None,
                link: None,
                agent: None,
            });
        }
        let run = self
            .run(&req.run_id)
            .ok_or_else(|| CliError::run_not_found(&req.run_id))?;
        let wait = Duration::from_millis(req.wait_ms.unwrap_or(0)).min(MAX_POLL_WAIT);
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            let notified = run.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let inner = run.inner.lock().await;
                if inner.phase == Phase::Settled || tokio::time::Instant::now() >= deadline {
                    return Ok(snapshot(&inner));
                }
            }
            tokio::select! {
                _ = &mut notified => continue,
                _ = tokio::time::sleep_until(deadline) => {
                    return Ok(snapshot(&*run.inner.lock().await));
                }
            }
        }
    }

    /// The runs whose id starts with `prefix`, newest first — what lets
    /// `codeg-cli result 8d0c7c2e` stand for the whole id.
    pub async fn find(&self, req: &FindRequest) -> Result<FindResponse, CliError> {
        let prefix = req.prefix.trim().to_ascii_lowercase();
        if prefix.len() < MIN_RUN_PREFIX
            || !prefix.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
        {
            return Err(CliError::usage(
                "bad_run_id",
                format!(
                    "{:?} is not the start of a run id: give at least {MIN_RUN_PREFIX} of its \
                     characters",
                    req.prefix
                ),
            ));
        }
        let matching: Vec<Arc<Run>> = {
            let mut reg = self.registry.lock().expect("registry");
            reg.prune(Instant::now());
            reg.entries
                .iter()
                .filter(|(id, _)| id.starts_with(&prefix))
                .filter_map(|(_, entry)| match entry {
                    Entry::Run(run) => Some(Arc::clone(run)),
                    // Not started: nothing to read or cancel by a prefix (the
                    // CLI that reserved it holds the whole id).
                    Entry::Reserved { .. } => None,
                })
                .collect()
        };
        let mut found = Vec::with_capacity(matching.len());
        for run in &matching {
            let inner = run.inner.lock().await;
            found.push((
                run.begun,
                FoundRun {
                    run_id: run.id.clone(),
                    state: snapshot(&inner).state,
                    conversation_id: inner.conversation_id,
                    agent: inner.agent.clone(),
                },
            ));
        }
        found.sort_by_key(|(begun, _)| std::cmp::Reverse(*begun));
        Ok(FindResponse {
            runs: found
                .into_iter()
                .take(MAX_FOUND_RUNS)
                .map(|(_, f)| f)
                .collect(),
        })
    }

    /// Every agent this codeg knows. `installed` is the launch's own check, so
    /// it says whether a run could start the agent — the list's `available`
    /// does not: it holds for any npm package, and for a binary that has a
    /// build for this platform.
    pub async fn agents(&self) -> Result<Vec<AgentEntry>, CliError> {
        let agents = crate::commands::acp::acp_list_agents_core(&self.db)
            .await
            .map_err(|e| CliError::execution("agents_unavailable", e.to_string()))?;
        let mut entries = Vec::with_capacity(agents.len());
        for a in agents {
            let installed = a.available
                && crate::commands::acp::verify_agent_installed(a.agent_type)
                    .await
                    .is_ok();
            let install_hint = (!installed)
                .then(|| install_hint(a.agent_type, a.available, a.install_url.as_deref()));
            entries.push(AgentEntry {
                slug: a.agent_type.as_wire().into_owned(),
                name: a.name,
                enabled: a.enabled,
                installed,
                install_hint,
            });
        }
        Ok(entries)
    }

    pub async fn automations(&self) -> Result<Vec<wire::AutomationEntry>, CliError> {
        super::automations::list(&self.db).await
    }

    pub async fn automation_run(
        &self,
        req: &wire::AutomationRunRequest,
    ) -> Result<wire::AutomationRunState, CliError> {
        super::automations::run(&self.db, req.automation_id).await
    }

    pub async fn automation_run_get(
        &self,
        req: &wire::AutomationRunGetRequest,
    ) -> Result<wire::AutomationRunState, CliError> {
        super::automations::get_waiting(&self.db, req).await
    }

    pub fn agent_install(
        &self,
        req: &wire::AgentInstallRequest,
    ) -> Result<wire::AgentInstallState, CliError> {
        self.installs.install(&self.db, &self.emitter, req)
    }

    pub async fn agent_install_get(
        &self,
        req: &wire::AgentInstallGetRequest,
    ) -> Result<wire::AgentInstallState, CliError> {
        self.installs.get(req).await
    }

    pub async fn assistants(&self) -> Result<Vec<AssistantEntry>, CliError> {
        let live = assistant_service::list_live_enabled(&self.db.conn)
            .await
            .map_err(|e| CliError::execution("assistants_unavailable", e.to_string()))?;
        Ok(live
            .into_iter()
            .map(|a| AssistantEntry {
                id: a.id,
                name: a.name,
                agent: a.agent_type.as_wire().into_owned(),
                description: a.description,
            })
            .collect())
    }
}

impl RunInner {
    fn new(policy: PermissionPolicy, structured: bool) -> Self {
        Self {
            policy,
            phase: Phase::Starting,
            stop: None,
            connection_id: None,
            root_state: None,
            conversation_id: None,
            session_id: None,
            agent: None,
            assistant: None,
            worktree: None,
            structured,
            output_schema: None,
            launch: Launch::default(),
            requests: HashMap::new(),
            handled: HashSet::new(),
            reported: HashSet::new(),
            denials: Vec::new(),
            permission_failure: None,
            failing: None,
            last_error: None,
            log: VecDeque::new(),
            next_seq: 0,
            reporting: false,
            result: None,
            settled_at: None,
            turns_before_prompt: None,
        }
    }
}

struct TurnEnd {
    seq: u64,
    stop_reason: String,
}

/// The subtype and error a stop settles a run with.
fn stop_outcome(cause: &StopCause) -> (Subtype, Option<ErrorInfo>) {
    let info = |code: &str, message: String| {
        Some(ErrorInfo {
            code: code.into(),
            message,
            next_steps: Vec::new(),
        })
    };
    match cause {
        StopCause::Timeout => (
            Subtype::ErrorTimeout,
            info("timeout", "--timeout ran out; the run was cancelled".into()),
        ),
        StopCause::Interrupt => (
            Subtype::ErrorInterrupted,
            info(
                "interrupted",
                "the CLI was interrupted; the run was cancelled".into(),
            ),
        ),
        StopCause::User => (
            Subtype::ErrorDuringExecution,
            info("cancelled", "the run was cancelled".into()),
        ),
        StopCause::PermissionRequired { tool } => (
            Subtype::ErrorPermissionRequired,
            Some(ErrorInfo {
                code: "permission_required".into(),
                message: format!("{tool} needed a permission the run's policy does not give"),
                next_steps: vec![
                    "--permissions allow   (allow every request, once each)".into(),
                    "--permissions wait    (answer it yourself in Codeg)".into(),
                ],
            }),
        ),
    }
}

fn snapshot(inner: &RunInner) -> GetResponse {
    GetResponse {
        state: match inner.phase {
            Phase::Starting => RunState::Starting,
            Phase::Running => RunState::Running,
            Phase::Settled => RunState::Settled,
        },
        result: inner.result.clone(),
        conversation_id: inner.conversation_id,
        link: inner.conversation_id.map(wire::session_link),
        agent: inner.agent.clone(),
    }
}

fn read_after(run: &Run, inner: &RunInner, after: u64) -> EventsResponse {
    let first_kept = inner
        .log
        .front()
        .map(|e| e.seq)
        .unwrap_or(inner.next_seq + 1);
    let gap = after + 1 < first_kept && after < inner.next_seq;
    let mut events: Vec<RunEvent> = inner
        .log
        .iter()
        .filter(|e| e.seq > after)
        .cloned()
        .collect();
    if gap {
        events.insert(
            0,
            RunEvent::new(after, Some(run.id.clone()), EventBody::Gap {}),
        );
    }
    let events = events::coalesce_deltas(events);
    let next = events.last().map(|e| e.seq).unwrap_or(after).max(after);
    let done = inner.phase == Phase::Settled && next >= inner.next_seq;
    EventsResponse {
        events,
        next,
        done,
        gap,
    }
}

async fn wait_status_changed(
    rx: &mut broadcast::Receiver<Arc<EventEnvelope>>,
    conversation_id: i32,
    within: Duration,
) -> bool {
    let deadline = tokio::time::Instant::now() + within;
    loop {
        tokio::select! {
            got = rx.recv() => match got {
                Ok(env) => {
                    if let AcpEvent::ConversationStatusChanged { conversation_id: cid, .. } = &env.payload {
                        if *cid == conversation_id {
                            return true;
                        }
                    }
                }
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => return false,
            },
            _ = tokio::time::sleep_until(deadline) => return false,
        }
    }
}

fn is_ask(event: &AcpEvent) -> bool {
    matches!(
        event,
        AcpEvent::PermissionRequest { .. }
            | AcpEvent::PermissionResolved { .. }
            | AcpEvent::QuestionRequest { .. }
            | AcpEvent::PlanApprovalRequest { .. }
    )
}

fn prompt_blocks(blocks: &[PromptBlock]) -> Result<Vec<PromptInputBlock>, CliError> {
    let mut total = 0usize;
    let mut out = Vec::new();
    for block in blocks {
        match block {
            PromptBlock::Text { text } => {
                total += text.len();
                if !text.is_empty() {
                    out.push(PromptInputBlock::Text { text: text.clone() });
                }
            }
        }
    }
    if out.is_empty() {
        return Err(CliError::usage("empty_prompt", "the prompt is empty"));
    }
    if total > MAX_PROMPT_BYTES {
        return Err(CliError::usage(
            "prompt_too_large",
            format!("the prompt is {total} bytes; the limit is 10 MiB"),
        ));
    }
    Ok(out)
}

/// The workspace exactly as given, checked by THIS machine's rules — it may
/// come from a client on another OS.
fn validate_workspace(raw: &str) -> Result<String, CliError> {
    let path = Path::new(raw);
    if raw.is_empty() || !path.is_absolute() {
        return Err(CliError::usage(
            "workspace_not_absolute",
            format!("the workspace must be an absolute path on the runtime's machine: {raw:?}"),
        ));
    }
    if !path.is_dir() {
        return Err(CliError::usage(
            "workspace_not_found",
            format!("no directory {raw:?} on the runtime's machine"),
        ));
    }
    Ok(raw.to_string())
}

async fn find_option(
    state: &Arc<RwLock<SessionState>>,
    pred: impl Fn(&SessionConfigOptionInfo) -> bool,
) -> Option<SessionConfigOptionInfo> {
    state
        .read()
        .await
        .config_options
        .as_ref()?
        .iter()
        .find(|o| pred(o))
        .cloned()
}

fn current_value(option: &SessionConfigOptionInfo) -> Option<String> {
    match &option.kind {
        SessionConfigKindInfo::Select(select) => Some(select.current_value.clone()),
        SessionConfigKindInfo::Boolean(toggle) => Some(toggle.current_value.to_string()),
    }
}

fn option_values(option: &SessionConfigOptionInfo) -> Vec<String> {
    match &option.kind {
        SessionConfigKindInfo::Select(select) => {
            let mut values: Vec<String> = select.options.iter().map(|o| o.value.clone()).collect();
            for group in &select.groups {
                values.extend(group.options.iter().map(|o| o.value.clone()));
            }
            values
        }
        SessionConfigKindInfo::Boolean(_) => vec!["true".into(), "false".into()],
    }
}

/// A value the option cannot take is refused before anything is sent.
fn check_value(option: &SessionConfigOptionInfo, value: &str, flag: &str) -> Result<(), CliError> {
    let values = option_values(option);
    if values.iter().any(|v| v == value) {
        return Ok(());
    }
    let kind = if matches!(option.kind, SessionConfigKindInfo::Boolean(_)) {
        "true or false".to_string()
    } else {
        values.join(", ")
    };
    Err(CliError::usage(
        "invalid_value",
        format!(
            "{flag} {value:?} is not one of {}'s values: {kind}",
            option.name
        ),
    ))
}

/// The agent's answer, read against what was asked for.
fn expect_landed(flag: &str, requested: &str, outcome: &SetterOutcome) -> Result<(), CliError> {
    match outcome {
        SetterOutcome::Confirmed { current } if current == requested => Ok(()),
        SetterOutcome::Confirmed { current } => Err(CliError::usage(
            "selection_rewritten",
            format!("{flag}: asked for {requested:?}, the agent settled on {current:?}"),
        )),
        SetterOutcome::Accepted => Ok(()),
        SetterOutcome::NotExecuted => Err(CliError::usage(
            "selection_not_applied",
            format!("{flag}: nothing was sent to the agent, so {requested:?} is not in effect"),
        )),
        SetterOutcome::Refused { message } => Err(CliError::usage(
            "selection_refused",
            format!("{flag}: {message}"),
        )),
    }
}

async fn current_selection(state: &Arc<RwLock<SessionState>>) -> LaunchSelection {
    let s = state.read().await;
    let by_category = |category: &str| {
        s.config_options.as_ref().and_then(|opts| {
            opts.iter()
                .find(|o| o.category.as_deref() == Some(category))
                .and_then(current_value)
        })
    };
    LaunchSelection {
        model: by_category("model"),
        effort: by_category("thought_level"),
        mode: s
            .current_mode
            .clone()
            .or_else(|| s.modes.as_ref().map(|m| m.current_mode_id.clone()))
            .or_else(|| by_category("mode")),
    }
}

/// What `assistant`'s saved options ask of model, effort and mode, read
/// against the session's own option list (the options are keyed by id, which
/// differs between agents).
async fn assistant_selection(
    state: &Arc<RwLock<SessionState>>,
    assistant: Option<&AssistantInfo>,
) -> LaunchSelection {
    let Some(assistant) = assistant else {
        return LaunchSelection::default();
    };
    let s = state.read().await;
    let by_category = |category: &str| {
        let option = s
            .config_options
            .as_ref()?
            .iter()
            .find(|o| o.category.as_deref() == Some(category))?;
        assistant
            .agent_options
            .config_values
            .get(&option.id)
            .cloned()
    };
    LaunchSelection {
        model: by_category("model"),
        effort: by_category("thought_level"),
        mode: assistant
            .agent_options
            .mode_id
            .clone()
            .or_else(|| by_category("mode")),
    }
}

/// How to install an agent that is not: for an npm package, the command
/// itself (`package` is the registry's pinned spec, version included).
fn install_hint(agent: AgentType, available: bool, install_url: Option<&str>) -> String {
    if !available {
        return "not available for this platform".to_string();
    }
    match crate::acp::registry::get_agent_meta(agent).distribution {
        crate::acp::registry::AgentDistribution::Npx { package, .. } => {
            format!("npm install -g {package}")
        }
        _ => match install_url {
            Some(url) => format!("see {url}, or install it in Codeg → Settings → Agents"),
            None => "install it in Codeg → Settings → Agents".to_string(),
        },
    }
}

/// `name` as one shell word for a `next_steps` line.
fn shell_word(name: &str) -> String {
    if !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./:@".contains(c))
    {
        name.to_string()
    } else {
        format!("'{}'", name.replace('\'', r"'\''"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::connection::ConnectionCommand;
    use crate::acp::types::{SessionConfigSelectInfo, SessionConfigSelectOptionInfo};
    use crate::acp::EventBusMetrics;
    use crate::db::test_helpers;
    use crate::web::event_bridge::{emit_with_state, WebEventBroadcaster};

    type SetterAnswer = dyn Fn(&ConnectionCommand) -> Result<SetterOutcome, String> + Send + Sync;

    /// Stands in a test connection for the agent, and records every command
    /// the run sends it.
    struct ScriptedLauncher {
        manager: ConnectionManager,
        commands: Arc<StdMutex<Vec<(String, String)>>>,
        changed: Arc<Notify>,
        spawned: StdMutex<Vec<String>>,
        /// Installed on the connection's state at spawn, with
        /// `selectors_ready`, when present.
        options: Option<Vec<SessionConfigOptionInfo>>,
        answer: Arc<SetterAnswer>,
        /// Held by `spawn` until released, to stop a launch mid-way.
        gate: Option<Arc<tokio::sync::Semaphore>>,
        /// The session never comes up: the connection fails instead.
        dead_on_arrival: bool,
        /// Whether the agent "was given" `submit_result` when its run has an
        /// `--output-schema` — as codeg-mcp's injection decides.
        result_tool: bool,
    }

    fn describe(cmd: &ConnectionCommand) -> String {
        match cmd {
            ConnectionCommand::Prompt {
                blocks,
                internal_suffix,
                ..
            } => {
                let text: Vec<String> = blocks
                    .iter()
                    .chain(internal_suffix)
                    .map(|b| match b {
                        PromptInputBlock::Text { text } => text.clone(),
                        _ => "<block>".into(),
                    })
                    .collect();
                format!("prompt:{}", text.join("|"))
            }
            ConnectionCommand::RespondPermission {
                request_id,
                option_id,
                origin,
            } => format!("respond:{request_id}:{option_id}:{origin:?}"),
            ConnectionCommand::SetConfigOption {
                config_id,
                value_id,
                ..
            } => format!("set:{config_id}={value_id}"),
            ConnectionCommand::SetMode { mode_id, .. } => format!("mode:{mode_id}"),
            ConnectionCommand::Cancel => "cancel".into(),
            ConnectionCommand::Disconnect => "disconnect".into(),
            _ => "other".into(),
        }
    }

    #[async_trait::async_trait]
    impl AgentLauncher for ScriptedLauncher {
        async fn environment(
            &self,
            _agent: AgentType,
        ) -> Result<BTreeMap<String, String>, CliError> {
            Ok(BTreeMap::new())
        }

        async fn spawn(
            &self,
            agent: AgentType,
            working_dir: String,
            _env: BTreeMap<String, String>,
            emitter: EventEmitter,
            _mode: Option<String>,
            _config: BTreeMap<String, String>,
            seed: RootSeed,
        ) -> Result<String, CliError> {
            if let Some(gate) = &self.gate {
                let _ = gate.acquire().await.expect("gate").forget();
            }
            let id = format!("conn-{}", self.spawned.lock().unwrap().len() + 1);
            let mut rx = self
                .manager
                .insert_test_connection_live(&id, agent, Some(PathBuf::from(working_dir)), emitter)
                .await;
            {
                // An agent whose session came up and published its selectors,
                // on a connection marked as the run's from the start.
                let state = self.manager.get_state(&id).await.expect("state");
                let mut s = state.write().await;
                s.result_tool_available = self.result_tool && seed.output_schema.is_some();
                s.cli_run = Some(seed.tag);
                s.cli_output_schema = seed.output_schema;
                if self.dead_on_arrival {
                    s.status = ConnectionStatus::Error;
                } else {
                    s.config_options = self.options.clone();
                    s.selectors_ready = true;
                }
            }
            self.spawned.lock().unwrap().push(id.clone());
            let commands = Arc::clone(&self.commands);
            let changed = Arc::clone(&self.changed);
            let answer = Arc::clone(&self.answer);
            let conn = id.clone();
            tokio::spawn(async move {
                while let Some(cmd) = rx.recv().await {
                    commands
                        .lock()
                        .unwrap()
                        .push((conn.clone(), describe(&cmd)));
                    changed.notify_waiters();
                    match cmd {
                        ConnectionCommand::SetConfigOption { ref reply, .. }
                        | ConnectionCommand::SetMode { ref reply, .. }
                            if reply.is_some() =>
                        {
                            let outcome = answer(&cmd);
                            match cmd {
                                ConnectionCommand::SetConfigOption { reply, .. }
                                | ConnectionCommand::SetMode { reply, .. } => {
                                    let _ = reply.expect("checked").send(outcome);
                                }
                                _ => unreachable!(),
                            }
                        }
                        _ => {}
                    }
                }
            });
            Ok(id)
        }
    }

    struct Harness {
        svc: Arc<CliRunService>,
        db: AppDatabase,
        manager: ConnectionManager,
        emitter: EventEmitter,
        launcher: Arc<ScriptedLauncher>,
        workspace: tempfile::TempDir,
    }

    /// How the scripted agent behaves.
    #[derive(Default)]
    struct Script {
        options: Option<Vec<SessionConfigOptionInfo>>,
        answer: Option<Arc<SetterAnswer>>,
        gate: Option<Arc<tokio::sync::Semaphore>>,
        dead_on_arrival: bool,
        /// See [`ScriptedLauncher::result_tool`].
        result_tool: bool,
    }

    impl Harness {
        async fn new() -> Self {
            Self::with(Script::default()).await
        }

        async fn with(script: Script) -> Self {
            let db = test_helpers::fresh_in_memory_db().await;
            let manager = ConnectionManager::new();
            let bus = Arc::new(InternalEventBus::new(Arc::new(EventBusMetrics::default())));
            let emitter = EventEmitter::web_only(Arc::new(WebEventBroadcaster::new()), bus.clone());
            let launcher = Arc::new(ScriptedLauncher {
                manager: manager.clone_ref(),
                commands: Arc::new(StdMutex::new(Vec::new())),
                changed: Arc::new(Notify::new()),
                spawned: StdMutex::new(Vec::new()),
                options: script.options,
                answer: script
                    .answer
                    .unwrap_or_else(|| Arc::new(|_| Err("unscripted".into()))),
                gate: script.gate,
                dead_on_arrival: script.dead_on_arrival,
                result_tool: script.result_tool,
            });
            let svc = CliRunService::with_launcher(
                &db,
                &manager,
                emitter.clone(),
                bus,
                RuntimeKind::Server,
                launcher.clone(),
                Timings {
                    selectors: Duration::from_secs(2),
                    setter: Duration::from_secs(2),
                    status: Duration::from_millis(150),
                    fail_answer: Duration::from_millis(200),
                },
            );
            svc.spawn_background();
            Self {
                svc,
                db,
                manager,
                emitter,
                launcher,
                workspace: tempfile::tempdir().expect("tempdir"),
            }
        }

        fn request(&self, run_id: &str, policy: PermissionPolicy) -> StartRequest {
            StartRequest {
                run_id: run_id.to_string(),
                workspace: self.workspace.path().to_string_lossy().into_owned(),
                agent: Some("claude_code".into()),
                assistant: None,
                prompt: vec![PromptBlock::Text {
                    text: "review it".into(),
                }],
                model: None,
                effort: None,
                mode: None,
                config: BTreeMap::new(),
                permissions: policy,
                title: None,
                timeout_ms: None,
                caller: None,
                open: false,
                worktree: None,
                output_schema: None,
            }
        }

        async fn start(&self, policy: PermissionPolicy) -> StartResponse {
            let run_id = self.svc.reserve().expect("reserve").run_id;
            self.svc
                .start(self.request(&run_id, policy))
                .await
                .expect("the run starts")
        }

        async fn state(&self, conn: &str) -> Arc<RwLock<SessionState>> {
            self.manager.get_state(conn).await.expect("live connection")
        }

        async fn emit(&self, conn: &str, event: AcpEvent) {
            let state = self.state(conn).await;
            emit_with_state(&state, &self.emitter, event).await;
        }

        fn commands(&self, conn: &str) -> Vec<String> {
            self.launcher
                .commands
                .lock()
                .unwrap()
                .iter()
                .filter(|(c, _)| c == conn)
                .map(|(_, d)| d.clone())
                .collect()
        }

        async fn until_command(&self, conn: &str, prefix: &str) -> String {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let notified = self.launcher.changed.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                if let Some(found) = self
                    .commands(conn)
                    .into_iter()
                    .find(|c| c.starts_with(prefix))
                {
                    return found;
                }
                assert!(
                    Instant::now() < deadline,
                    "no {prefix:?} command; saw {:?}",
                    self.commands(conn)
                );
                let _ = tokio::time::timeout(Duration::from_millis(100), notified).await;
            }
        }

        /// Every event of the run, polling until it is done.
        async fn drain(&self, run_id: &str) -> Vec<RunEvent> {
            let mut all = Vec::new();
            let mut after = 0;
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let got = self
                    .svc
                    .events(&EventsRequest {
                        run_id: run_id.to_string(),
                        after,
                        wait_ms: 200,
                    })
                    .await
                    .expect("events");
                after = got.next;
                all.extend(got.events);
                if got.done {
                    return all;
                }
                assert!(
                    Instant::now() < deadline,
                    "the run never settled; saw {all:#?}"
                );
            }
        }

        async fn row_status(&self, conversation_id: i32) -> ConversationStatus {
            use sea_orm::EntityTrait;
            conversation::Entity::find_by_id(conversation_id)
                .one(&self.db.conn)
                .await
                .unwrap()
                .expect("row")
                .status
        }
    }

    fn result_of(events: &[RunEvent]) -> RunResult {
        events
            .last()
            .and_then(RunEvent::result)
            .cloned()
            .expect("the last event is the result")
    }

    fn types(events: &[RunEvent]) -> Vec<String> {
        events
            .iter()
            .map(|e| {
                serde_json::to_value(&e.body).unwrap()["type"]
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect()
    }

    fn turn_complete(stop_reason: &str) -> AcpEvent {
        AcpEvent::TurnComplete {
            session_id: "s1".into(),
            stop_reason: stop_reason.into(),
            agent_type: "claude_code".into(),
        }
    }

    fn reply(text: &str) -> AcpEvent {
        AcpEvent::ContentDelta {
            text: text.into(),
            parent_tool_use_id: None,
        }
    }

    fn permission(request_id: &str, title: &str, kind: &str) -> AcpEvent {
        AcpEvent::PermissionRequest {
            request_id: request_id.into(),
            tool_call: serde_json::json!({"title": title, "kind": kind}),
            options: vec![
                PermissionOptionInfo {
                    option_id: "allow".into(),
                    name: "Allow".into(),
                    kind: "allow_once".into(),
                    meta: None,
                },
                PermissionOptionInfo {
                    option_id: "always".into(),
                    name: "Always".into(),
                    kind: "allow_always".into(),
                    meta: None,
                },
                PermissionOptionInfo {
                    option_id: "reject".into(),
                    name: "Reject".into(),
                    kind: "reject_once".into(),
                    meta: None,
                },
            ],
            queued: 0,
        }
    }

    fn resolved(request_id: &str, option: &str, origin: PermissionAnswerOrigin) -> AcpEvent {
        AcpEvent::PermissionResolved {
            request_id: request_id.into(),
            option_id: Some(option.into()),
            origin: Some(origin),
        }
    }

    #[tokio::test]
    async fn a_run_streams_its_reply_and_settles_after_the_row_does() {
        let h = Harness::new().await;
        let started = h.start(PermissionPolicy::Deny).await;
        assert_eq!(
            started.link,
            format!("codeg://session/{}", started.conversation_id)
        );
        h.until_command(&started.connection_id, "prompt:review it")
            .await;

        h.emit(&started.connection_id, reply("hel")).await;
        h.emit(&started.connection_id, reply("lo")).await;
        h.emit(&started.connection_id, turn_complete("end_turn"))
            .await;

        let events = h.drain(&started.run_id).await;
        assert_eq!(
            types(&events),
            ["init", "session", "message_delta", "result"]
        );
        assert_eq!(
            events[2].body,
            EventBody::MessageDelta {
                text: "hello".into()
            }
        );
        let result = result_of(&events);
        assert_eq!(result.subtype, Subtype::Success);
        assert_eq!(result.result.as_deref(), Some("hello"));
        assert_eq!(result.conversation_id, Some(started.conversation_id));

        // No lifecycle worker runs here, so the run's own fallback records
        // the row's status — and only then lets the connection go.
        h.until_command(&started.connection_id, "disconnect").await;
        assert_eq!(
            h.row_status(started.conversation_id).await,
            ConversationStatus::PendingReview
        );
    }

    fn review_schema() -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {"verdict": {"enum": ["pass", "fail"]}},
            "required": ["verdict"]
        })
    }

    async fn start_structured(h: &Harness) -> StartResponse {
        let run_id = h.svc.reserve().expect("reserve").run_id;
        let mut req = h.request(&run_id, PermissionPolicy::Deny);
        req.output_schema = Some(review_schema());
        h.svc.start(req).await.expect("the run starts")
    }

    /// What the listener does with a `submit_result` call on `conn`.
    async fn submit(h: &Harness, conn: &str, value: serde_json::Value) -> bool {
        use crate::acp::result_tool::{ConnectionManagerResultLookup, ResultToolAccess};
        ConnectionManagerResultLookup {
            manager: Arc::new(h.manager.clone_ref()),
        }
        .submit(conn, value)
        .await
        .accepted
    }

    /// A schema that is none is the caller's mistake: refused before the
    /// agent is started or a conversation made.
    #[tokio::test]
    async fn an_output_schema_that_is_no_schema_is_refused_before_anything_starts() {
        let h = Harness::new().await;
        for schema in [
            serde_json::json!({"type": "array"}),
            serde_json::json!({"type": "object", "required": "verdict"}),
        ] {
            let run_id = h.svc.reserve().expect("reserve").run_id;
            let mut req = h.request(&run_id, PermissionPolicy::Deny);
            req.output_schema = Some(schema.clone());
            let err = h.svc.start(req).await.expect_err("refused");
            assert_eq!(err.body.subtype, Subtype::ErrorUsage, "{schema}");
            assert_eq!(err.body.error.code, "bad_output_schema");
        }
        assert!(h.launcher.spawned.lock().unwrap().is_empty());
    }

    /// The root connection carries the run and its schema from the start, so
    /// its codeg-mcp offers `submit_result`; the prompt says to call it; and
    /// the last result it accepted is the run's — a refused one reported as
    /// it happens.
    #[tokio::test]
    async fn a_result_handed_in_with_submit_result_is_the_runs() {
        let h = Harness::with(Script {
            result_tool: true,
            ..Script::default()
        })
        .await;
        let started = start_structured(&h).await;
        let conn = started.connection_id.clone();
        {
            let state = h.state(&conn).await;
            let s = state.read().await;
            assert_eq!(
                s.cli_run.as_ref().map(|t| t.run_id.as_str()),
                Some(started.run_id.as_str())
            );
            assert!(s.cli_output_schema.is_some());
        }
        let prompt = h.until_command(&conn, "prompt:review it").await;
        assert!(prompt.contains("`submit_result`"), "{prompt}");
        assert!(
            !prompt.contains("\"verdict\""),
            "the tool carries the schema: {prompt}"
        );

        assert!(!submit(&h, &conn, serde_json::json!({"verdict": "maybe"})).await);
        assert!(submit(&h, &conn, serde_json::json!({"verdict": "pass"})).await);
        h.emit(&conn, reply("Handed it in.")).await;
        h.emit(&conn, turn_complete("end_turn")).await;

        let events = h.drain(&started.run_id).await;
        let refused = events.iter().find_map(|e| match &e.body {
            EventBody::Notice { title, message, .. } if title.contains("submit_result") => {
                Some(message.clone().unwrap_or_default())
            }
            _ => None,
        });
        assert!(
            refused.is_some_and(|m| m.contains("/verdict")),
            "{events:#?}"
        );
        let result = result_of(&events);
        assert_eq!(result.subtype, Subtype::Success);
        assert_eq!(
            result.structured_output,
            Some(serde_json::json!({"verdict": "pass"}))
        );
        assert_eq!(result.result.as_deref(), Some("Handed it in."));
        // The run is over: the tool takes nothing more.
        assert!(!submit(&h, &conn, serde_json::json!({"verdict": "fail"})).await);
    }

    /// An agent without the tool is given the schema in its prompt, and its
    /// reply is read for the JSON.
    #[tokio::test]
    async fn without_the_tool_the_reply_is_the_result() {
        let h = Harness::new().await;
        let started = start_structured(&h).await;
        let conn = started.connection_id.clone();
        let prompt = h.until_command(&conn, "prompt:review it").await;
        assert!(!prompt.contains("submit_result"), "{prompt}");
        assert!(prompt.contains("\"verdict\""), "{prompt}");

        h.emit(&conn, reply("Here:\n```json\n{\"verdict\": \"fail\"}\n```"))
            .await;
        h.emit(&conn, turn_complete("end_turn")).await;
        let result = result_of(&h.drain(&started.run_id).await);
        assert_eq!(result.subtype, Subtype::Success);
        assert_eq!(
            result.structured_output,
            Some(serde_json::json!({"verdict": "fail"}))
        );
    }

    /// A turn that went well but handed in nothing that matches fails with
    /// its own subtype and exit code; a run that failed for another reason
    /// keeps that one. Either way `structured_output` is there, `null`.
    #[tokio::test]
    async fn a_turn_without_a_result_that_matches_fails_with_exit_code_7() {
        let h = Harness::with(Script {
            result_tool: true,
            ..Script::default()
        })
        .await;
        let started = start_structured(&h).await;
        let conn = started.connection_id.clone();
        h.until_command(&conn, "prompt:review it").await;
        h.emit(&conn, reply("All good, I think.")).await;
        h.emit(&conn, turn_complete("end_turn")).await;
        let result = result_of(&h.drain(&started.run_id).await);
        assert_eq!(result.subtype, Subtype::ErrorMaxStructuredOutputRetries);
        assert_eq!(result.subtype.exit_code(), 7);
        assert!(result.is_error);
        let error = result.error.expect("why");
        assert_eq!(error.code, "output_schema_unmet");
        assert!(
            error.message.contains("did not call submit_result"),
            "{}",
            error.message
        );
        assert_eq!(result.structured_output, Some(serde_json::Value::Null));
        assert_eq!(result.result.as_deref(), Some("All good, I think."));

        let started = start_structured(&h).await;
        h.until_command(&started.connection_id, "prompt:review it")
            .await;
        h.svc
            .cancel(&started.run_id, CancelReason::User)
            .await
            .expect("cancel");
        let result = result_of(&h.drain(&started.run_id).await);
        assert_eq!(result.subtype, Subtype::ErrorDuringExecution);
        assert_eq!(result.error.map(|e| e.code).as_deref(), Some("cancelled"));
        assert_eq!(result.structured_output, Some(serde_json::Value::Null));
    }

    /// The sidebar tells a CLI run's conversation apart by its source — set
    /// before the row is first announced, so no client sees it unmarked.
    #[tokio::test]
    async fn a_runs_conversation_is_marked_as_the_command_lines() {
        use sea_orm::EntityTrait;
        let h = Harness::new().await;
        let started = h.start(PermissionPolicy::Deny).await;
        let row = conversation::Entity::find_by_id(started.conversation_id)
            .one(&h.db.conn)
            .await
            .unwrap()
            .expect("row");
        assert_eq!(row.source.as_deref(), Some(conversation::SOURCE_CLI));
        let summary = conversation_service::get_by_id(&h.db.conn, started.conversation_id)
            .await
            .unwrap();
        assert_eq!(summary.source.as_deref(), Some("cli"));
    }

    /// `codeg-cli result --wait`: a `get` that waits answers the moment the
    /// run settles; one whose wait runs out answers with the run as it is —
    /// its conversation known before its result.
    #[tokio::test]
    async fn a_get_that_waits_answers_when_the_run_settles() {
        let h = Harness::new().await;
        let started = h.start(PermissionPolicy::Deny).await;
        h.until_command(&started.connection_id, "prompt:review it")
            .await;
        let get = |wait_ms| GetRequest {
            run_id: started.run_id.clone(),
            wait_ms,
        };

        let running = h.svc.get(&get(None)).await.unwrap();
        assert_eq!(running.state, RunState::Running);
        assert!(running.result.is_none());
        assert_eq!(running.conversation_id, Some(started.conversation_id));
        assert_eq!(running.link.as_deref(), Some(started.link.as_str()));
        assert_eq!(running.agent.as_deref(), Some("claude_code"));

        let asked = Instant::now();
        let still = h.svc.get(&get(Some(150))).await.unwrap();
        assert_eq!(still.state, RunState::Running);
        assert!(asked.elapsed() >= Duration::from_millis(150));

        let svc = Arc::clone(&h.svc);
        let waiting_for = get(Some(20_000));
        let waiting = tokio::spawn(async move { svc.get(&waiting_for).await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        h.emit(&started.connection_id, reply("done")).await;
        h.emit(&started.connection_id, turn_complete("end_turn"))
            .await;
        let got = tokio::time::timeout(Duration::from_secs(5), waiting)
            .await
            .expect("answered once the run settled, not at the end of its wait")
            .unwrap()
            .unwrap();
        assert_eq!(got.state, RunState::Settled);
        let result = got.result.expect("a settled run has its result");
        assert_eq!(result.subtype, Subtype::Success);
        assert_eq!(result.result.as_deref(), Some("done"));
        assert_eq!(result.agent.as_deref(), Some("claude_code"));
    }

    /// `--worktree`: the agent works in a checkout of its own, recorded under
    /// the workspace's folder — closed, as that one is — and named in `init`
    /// and in the result, where the user finds the branch to review.
    #[tokio::test]
    async fn a_worktree_run_works_in_a_checkout_of_its_own() {
        let h = Harness::new().await;
        let (_outer, repo) = super::super::worktree::test_support::repository();
        let run_id = h.svc.reserve().expect("reserve").run_id;
        let mut req = h.request(&run_id, PermissionPolicy::Deny);
        req.workspace = repo.to_string_lossy().into_owned();
        req.worktree = Some(String::new());
        let started = h.svc.start(req).await.expect("the run starts");

        let worktree = started.worktree.clone().expect("a worktree");
        assert_eq!(worktree.branch, format!("cli/{}", &run_id[..8]));
        assert!(Path::new(&worktree.path).join("sub").join("file").is_file());
        assert_eq!(started.workspace.as_deref(), Some(worktree.path.as_str()));
        let state = h.state(&started.connection_id).await;
        assert_eq!(
            state.read().await.working_dir.as_deref(),
            Some(Path::new(&worktree.path)),
            "the agent was started in the worktree"
        );

        let folder = folder_service::get_folder_by_id(&h.db.conn, started.folder_id)
            .await
            .unwrap()
            .expect("the worktree's folder");
        assert_eq!(folder.path, worktree.path);
        let root = folder_service::ensure_folder_for_path(&h.db.conn, &repo.to_string_lossy())
            .await
            .unwrap();
        assert_eq!(folder.parent_id, Some(root.id));
        assert!(
            !folder_service::is_open(&h.db.conn, folder.id)
                .await
                .unwrap(),
            "the workspace's folder is closed, so the worktree's is too"
        );

        h.emit(&started.connection_id, turn_complete("end_turn"))
            .await;
        let events = h.drain(&started.run_id).await;
        match &events[0].body {
            EventBody::Init {
                workspace,
                worktree: Some(info),
                folder_id,
                ..
            } => {
                assert_eq!(workspace, &worktree.path);
                assert_eq!(info, &worktree);
                assert_eq!(*folder_id, started.folder_id);
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(result_of(&events).worktree, Some(worktree.clone()));
        assert!(
            Path::new(&worktree.path).is_dir(),
            "a finished run's worktree stays for review"
        );
    }

    /// Where the user is looking — the repository open in the workspace — the
    /// worktree shows up beside it, as an automation's does.
    #[tokio::test]
    async fn a_worktree_of_an_open_folder_is_opened_too() {
        let h = Harness::new().await;
        let (_outer, repo) = super::super::worktree::test_support::repository();
        let root = folder_service::add_folder(&h.db.conn, &repo.to_string_lossy())
            .await
            .unwrap();
        let run_id = h.svc.reserve().expect("reserve").run_id;
        let mut req = h.request(&run_id, PermissionPolicy::Deny);
        req.workspace = repo.to_string_lossy().into_owned();
        req.worktree = Some("look".into());
        let started = h.svc.start(req).await.expect("the run starts");
        let folder = folder_service::get_folder_by_id(&h.db.conn, started.folder_id)
            .await
            .unwrap()
            .expect("the worktree's folder");
        assert_eq!(folder.parent_id, Some(root.id));
        assert!(folder_service::is_open(&h.db.conn, folder.id)
            .await
            .unwrap());
        assert_eq!(
            folder.alias.as_deref(),
            Some("cli/look"),
            "named for its branch"
        );
    }

    /// A launch that fails before its conversation exists ran nothing in its
    /// worktree: the checkout and the branch go with it.
    #[tokio::test]
    async fn a_launch_that_fails_takes_its_worktree_away() {
        let h = Harness::with(Script {
            dead_on_arrival: true,
            ..Script::default()
        })
        .await;
        let (outer, repo) = super::super::worktree::test_support::repository();
        let run_id = h.svc.reserve().expect("reserve").run_id;
        let mut req = h.request(&run_id, PermissionPolicy::Deny);
        req.workspace = repo.to_string_lossy().into_owned();
        req.worktree = Some("doomed".into());
        h.svc
            .start(req)
            .await
            .expect_err("the session never comes up");

        assert!(!outer.path().join("repo-cli-doomed").exists());
        let branches = std::process::Command::new("git")
            .args(["branch", "--list", "cli/doomed"])
            .current_dir(&repo)
            .output()
            .unwrap();
        assert!(String::from_utf8_lossy(&branches.stdout).trim().is_empty());
        let result = h
            .svc
            .get(&GetRequest {
                run_id,
                wait_ms: None,
            })
            .await
            .unwrap()
            .result
            .expect("settled");
        assert!(result.is_error);
        assert_eq!(result.worktree, None, "no worktree left to name");
    }

    #[tokio::test]
    async fn a_run_is_found_by_the_start_of_its_id() {
        let h = Harness::new().await;
        let started = h.start(PermissionPolicy::Deny).await;
        let find = |prefix: &str| FindRequest {
            prefix: prefix.to_string(),
        };

        // Any case: ids are lowercase, a person may not type them so.
        let found = h
            .svc
            .find(&find(&started.run_id[..8].to_uppercase()))
            .await
            .unwrap();
        assert_eq!(found.runs.len(), 1);
        assert_eq!(found.runs[0].run_id, started.run_id);
        assert_eq!(found.runs[0].state, RunState::Running);
        assert_eq!(found.runs[0].conversation_id, Some(started.conversation_id));
        assert_eq!(found.runs[0].agent.as_deref(), Some("claude_code"));

        // Too little of an id, or not one: refused, not matched against all.
        for bad in ["", "8d0c7c2", "not-an-id-at-all"] {
            let err = h.svc.find(&find(bad)).await.unwrap_err();
            assert_eq!(err.body.subtype, Subtype::ErrorUsage, "{bad:?}");
            assert_eq!(err.body.error.code, "bad_run_id");
        }

        // A reservation is no run yet: its CLI holds the whole id.
        let reserved = h.svc.reserve().unwrap().run_id;
        let found = h.svc.find(&find(&reserved[..8])).await.unwrap();
        assert!(found.runs.iter().all(|r| r.run_id != reserved));
    }

    /// A worker that holds the turn and never writes it (gone, out of
    /// retries) does not stop the fallback; the turn is then the fallback's.
    #[tokio::test]
    async fn the_fallback_writes_a_turn_the_worker_holds_but_never_wrote() {
        let h = Harness::new().await;
        let started = h.start(PermissionPolicy::Deny).await;
        let state = h.state(&started.connection_id).await;
        let run = h.svc.run(&started.run_id).expect("the run");
        let turn = TurnEnd {
            seq: 41,
            stop_reason: "end_turn".into(),
        };
        assert!(state
            .write()
            .await
            .claim_turn_status(41, TurnStatusWriter::Lifecycle));
        assert!(
            h.svc
                .fallback_status_write(&run, &state, started.conversation_id, &turn)
                .await
        );
        assert_eq!(
            h.row_status(started.conversation_id).await,
            ConversationStatus::PendingReview
        );
    }

    /// The CLI's start request can go away mid-launch (Ctrl-C, a dropped
    /// link); the launch goes on, and a retried start reads its outcome even
    /// though nobody was waiting when it came.
    #[tokio::test]
    async fn a_start_retried_after_the_first_went_away_gets_the_launch() {
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        let h = Harness::with(Script {
            gate: Some(gate.clone()),
            ..Script::default()
        })
        .await;
        let run_id = h.svc.reserve().unwrap().run_id;
        let svc = Arc::clone(&h.svc);
        let req = h.request(&run_id, PermissionPolicy::Deny);
        let first = tokio::spawn(async move { svc.start(req).await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        first.abort();
        let _ = first.await;
        gate.add_permits(1);
        let conn = loop {
            if let Some(conn) = h.launcher.spawned.lock().unwrap().first().cloned() {
                break conn;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        };
        h.until_command(&conn, "prompt:").await;
        tokio::time::sleep(Duration::from_millis(50)).await;

        let again = tokio::time::timeout(
            Duration::from_secs(5),
            h.svc.start(h.request(&run_id, PermissionPolicy::Deny)),
        )
        .await
        .expect("a retried start does not hang")
        .expect("the run's launch");
        assert_eq!(again.run_id, run_id);
        assert_eq!(again.connection_id, conn);
    }

    #[tokio::test]
    async fn a_config_value_taken_unconfirmed_is_marked_so() {
        let h = Harness::with(Script {
            options: Some(vec![effort_option("low")]),
            answer: Some(Arc::new(|_| Ok(SetterOutcome::Accepted))),
            ..Script::default()
        })
        .await;
        let run_id = h.svc.reserve().unwrap().run_id;
        let mut req = h.request(&run_id, PermissionPolicy::Deny);
        req.config.insert("effort".into(), "high".into());
        let started = h.svc.start(req).await.expect("an accepted value proceeds");
        h.emit(&started.connection_id, turn_complete("end_turn"))
            .await;
        let result = result_of(&h.drain(&run_id).await);
        assert!(
            result.launch.unconfirmed.effort,
            "-c on the effort option is reported like --effort"
        );
    }

    #[tokio::test]
    async fn a_number_is_an_assistants_id_before_another_ones_name() {
        use crate::models::assistant::{
            AssistantAgentConfig, AssistantAvatar, AssistantDraft, AssistantLabelSnapshot,
        };
        let h = Harness::new().await;
        let draft = |name: &str, agent_type: AgentType| AssistantDraft {
            name: name.into(),
            description: String::new(),
            avatar: AssistantAvatar::Monogram {
                color: "violet".into(),
            },
            agent_config: AssistantAgentConfig {
                agent_type,
                agent_options: Default::default(),
                label_snapshot: AssistantLabelSnapshot {
                    agent: "agent".into(),
                    mode: None,
                    options: vec![],
                },
            },
            instructions: String::new(),
            enabled: true,
        };
        // Listed first, and named like the next one's id.
        let named = assistant_service::create(&h.db.conn, &draft("2", AgentType::Codex))
            .await
            .expect("assistant");
        let numbered =
            assistant_service::create(&h.db.conn, &draft("reviewer", AgentType::ClaudeCode))
                .await
                .expect("assistant");
        assert_eq!(numbered.id, 2, "a fresh database numbers from 1");
        assert_ne!(named.id, numbered.id);

        let got = h.svc.resolve_assistant("2").await.expect("found");
        assert_eq!(got.id, numbered.id);
        let got = h.svc.resolve_assistant("reviewer").await.expect("found");
        assert_eq!(got.id, numbered.id);
    }

    /// Events lost to lag beyond the replay buffer can include the turn's
    /// end; the connection's state still says whether it came.
    #[tokio::test]
    async fn a_turn_end_lost_with_lagged_events_is_read_off_the_state() {
        let h = Harness::new().await;
        let started = h.start(PermissionPolicy::Deny).await;
        h.until_command(&started.connection_id, "prompt:").await;
        let run = h.svc.run(&started.run_id).expect("the run");
        let state = h.state(&started.connection_id).await;
        let before = run
            .inner
            .lock()
            .await
            .turns_before_prompt
            .expect("recorded");

        {
            let mut s = state.write().await;
            s.turn_in_flight = true;
            s.turns_completed = before;
        }
        assert!(
            h.svc.turn_ended_unseen(&run, &state).await.is_none(),
            "still running"
        );

        {
            let mut s = state.write().await;
            s.turn_in_flight = false;
            s.turns_completed = before + 1;
            s.last_turn_ended_abnormally = false;
        }
        let turn = h.svc.turn_ended_unseen(&run, &state).await.expect("ended");
        assert_eq!(turn.stop_reason, "end_turn");
        assert_eq!(turn.seq, LOST_TURN_SEQ);

        state.write().await.last_turn_ended_abnormally = true;
        let turn = h.svc.turn_ended_unseen(&run, &state).await.expect("ended");
        assert_eq!(turn.stop_reason, "unknown");
    }

    /// Under `fail` a card a person answered before the policy's refusal
    /// landed still ends the run, but is reported as theirs, not as refused.
    #[tokio::test]
    async fn fail_reports_the_answer_that_took_effect() {
        let h = Harness::new().await;
        let started = h.start(PermissionPolicy::Fail).await;
        let conn = started.connection_id.clone();
        h.emit(&conn, permission("p1", "Bash", "execute")).await;
        h.until_command(&conn, "respond:p1").await;
        h.emit(&conn, resolved("p1", "allow", PermissionAnswerOrigin::User))
            .await;
        let events = h.drain(&started.run_id).await;
        let result = result_of(&events);
        assert_eq!(result.subtype, Subtype::ErrorPermissionRequired);
        assert!(
            result.permission_denials.is_empty(),
            "{:?}",
            result.permission_denials
        );
        assert!(events.iter().any(|e| matches!(
            &e.body,
            EventBody::Permission {
                decision: PermissionVerdict::Allowed,
                decided_by: Some(DecidedBy::User),
                ..
            }
        )));
    }

    /// An agent that exits while `fail` waits for its refusal's resolution:
    /// the run still ends as permission_required, not as an agent exit.
    #[tokio::test]
    async fn fail_outlives_the_agent_exiting_meanwhile() {
        let h = Harness::new().await;
        let started = h.start(PermissionPolicy::Fail).await;
        let conn = started.connection_id.clone();
        h.emit(&conn, permission("p1", "Bash", "execute")).await;
        h.until_command(&conn, "respond:p1").await;
        h.emit(
            &conn,
            AcpEvent::StatusChanged {
                status: ConnectionStatus::Disconnected,
            },
        )
        .await;
        let result = result_of(&h.drain(&started.run_id).await);
        assert_eq!(result.subtype, Subtype::ErrorPermissionRequired);
    }

    /// A refusal whose resolution never comes ends the run all the same.
    #[tokio::test]
    async fn fail_ends_the_run_even_without_a_resolution() {
        let h = Harness::new().await;
        let started = h.start(PermissionPolicy::Fail).await;
        let conn = started.connection_id.clone();
        h.emit(&conn, permission("p1", "Bash", "execute")).await;
        h.until_command(&conn, "respond:p1").await;
        h.until_command(&conn, "cancel").await;
        let result = result_of(&h.drain(&started.run_id).await);
        assert_eq!(result.subtype, Subtype::ErrorPermissionRequired);
    }

    /// The fallback never writes over anything but a row still in progress:
    /// a status a person set meanwhile stays.
    #[tokio::test]
    async fn the_fallback_never_undoes_a_status_set_meanwhile() {
        let h = Harness::new().await;
        let started = h.start(PermissionPolicy::Deny).await;
        let state = h.state(&started.connection_id).await;
        let run = h.svc.run(&started.run_id).expect("the run");
        conversation_service::update_status(
            &h.db.conn,
            started.conversation_id,
            ConversationStatus::Completed,
        )
        .await
        .unwrap();
        for seq in [41, LOST_TURN_SEQ] {
            let turn = TurnEnd {
                seq,
                stop_reason: "end_turn".into(),
            };
            assert!(
                h.svc
                    .fallback_status_write(&run, &state, started.conversation_id, &turn)
                    .await
            );
            assert_eq!(
                h.row_status(started.conversation_id).await,
                ConversationStatus::Completed
            );
        }
    }

    #[tokio::test]
    async fn deny_refuses_once_and_reports_the_denial() {
        let h = Harness::new().await;
        let started = h.start(PermissionPolicy::Deny).await;
        let conn = started.connection_id.clone();
        h.emit(&conn, permission("p1", "Bash", "execute")).await;
        let answer = h.until_command(&conn, "respond:p1").await;
        assert!(
            answer.starts_with("respond:p1:reject:CliPolicy"),
            "{answer}"
        );
        h.emit(
            &conn,
            resolved(
                "p1",
                "reject",
                PermissionAnswerOrigin::CliPolicy {
                    run_id: started.run_id.clone(),
                },
            ),
        )
        .await;
        h.emit(&conn, turn_complete("end_turn")).await;

        let events = h.drain(&started.run_id).await;
        let permission = events
            .iter()
            .find(|e| matches!(e.body, EventBody::Permission { .. }))
            .expect("a permission event");
        assert_eq!(
            permission.body,
            EventBody::Permission {
                request_id: "p1".into(),
                conversation_id: Some(started.conversation_id),
                tool: "Bash".into(),
                tool_kind: Some("execute".into()),
                decision: PermissionVerdict::Denied,
                decided_by: Some(DecidedBy::Policy),
                option_name: Some("Reject".into()),
            }
        );
        let result = result_of(&events);
        assert_eq!(result.subtype, Subtype::Success);
        assert_eq!(result.permission_denials.len(), 1);
        assert_eq!(result.permission_denials[0].tool_name, "Bash");
    }

    /// The person on the card answered first — with the very option the
    /// policy then also submits. The report credits whoever's answer took
    /// effect, which only the event's origin can tell.
    #[tokio::test]
    async fn an_answer_a_person_gave_first_is_theirs() {
        let h = Harness::new().await;
        let started = h.start(PermissionPolicy::Deny).await;
        let conn = started.connection_id.clone();
        h.emit(&conn, permission("p1", "Bash", "execute")).await;
        h.until_command(&conn, "respond:p1").await;
        h.emit(
            &conn,
            resolved("p1", "reject", PermissionAnswerOrigin::User),
        )
        .await;
        h.emit(&conn, turn_complete("end_turn")).await;
        let events = h.drain(&started.run_id).await;
        assert!(events.iter().any(|e| matches!(
            e.body,
            EventBody::Permission {
                decision: PermissionVerdict::Denied,
                decided_by: Some(DecidedBy::User),
                ..
            }
        )));
    }

    #[tokio::test]
    async fn reads_allows_a_read_once_and_never_always() {
        let h = Harness::new().await;
        let started = h.start(PermissionPolicy::Reads).await;
        let conn = started.connection_id.clone();
        h.emit(&conn, permission("p1", "Read", "read")).await;
        h.emit(&conn, permission("p2", "Bash", "execute")).await;
        assert!(h
            .until_command(&conn, "respond:p1")
            .await
            .starts_with("respond:p1:allow:"));
        assert!(h
            .until_command(&conn, "respond:p2")
            .await
            .starts_with("respond:p2:reject:"));
        assert!(!h.commands(&conn).iter().any(|c| c.contains(":always:")));
    }

    #[tokio::test]
    async fn fail_ends_the_run_as_permission_required() {
        let h = Harness::new().await;
        let started = h.start(PermissionPolicy::Fail).await;
        let conn = started.connection_id.clone();
        h.emit(&conn, permission("p1", "Bash", "execute")).await;
        assert!(h
            .until_command(&conn, "respond:p1")
            .await
            .starts_with("respond:p1:reject:"));
        // The run ends once the refusal is known to be the answer.
        h.emit(
            &conn,
            resolved(
                "p1",
                "reject",
                PermissionAnswerOrigin::CliPolicy {
                    run_id: started.run_id.clone(),
                },
            ),
        )
        .await;
        h.until_command(&conn, "cancel").await;
        let result = result_of(&h.drain(&started.run_id).await);
        assert_eq!(result.subtype, Subtype::ErrorPermissionRequired);
        assert_eq!(result.subtype.exit_code(), 5);
        assert_eq!(result.error.as_ref().unwrap().code, "permission_required");
        assert_eq!(result.permission_denials.len(), 1, "refused by the policy");
        assert_eq!(
            h.row_status(started.conversation_id).await,
            ConversationStatus::Cancelled
        );
    }

    /// A delegated child's request is already on its state when the root's
    /// turn ends, but the bus has not delivered it yet. Settling must still
    /// see it: under `fail` that run did not succeed.
    #[tokio::test]
    async fn fail_sees_a_child_request_the_bus_has_not_delivered() {
        let h = Harness::new().await;
        let started = h.start(PermissionPolicy::Fail).await;
        h.manager
            .insert_test_connection("child", AgentType::Codex, None, EventEmitter::Noop)
            .await;
        {
            let state = h.state("child").await;
            let mut s = state.write().await;
            s.cli_run = Some(CliRunTag {
                run_id: started.run_id.clone(),
                policy: PermissionPolicy::Fail,
                depth: 0,
            });
            s.apply_event(&permission("c1", "Write", "edit"));
        }
        h.emit(&started.connection_id, turn_complete("end_turn"))
            .await;
        let result = result_of(&h.drain(&started.run_id).await);
        assert_eq!(result.subtype, Subtype::ErrorPermissionRequired);
    }

    #[tokio::test]
    async fn a_child_inherits_the_runs_policy() {
        let h = Harness::new().await;
        let started = h.start(PermissionPolicy::Deny).await;
        let rx = h
            .manager
            .insert_test_connection_live("child", AgentType::Codex, None, h.emitter.clone())
            .await;
        let commands = Arc::new(StdMutex::new(Vec::new()));
        {
            let commands = Arc::clone(&commands);
            let mut rx = rx;
            tokio::spawn(async move {
                while let Some(cmd) = rx.recv().await {
                    commands.lock().unwrap().push(describe(&cmd));
                }
            });
        }
        h.state("child").await.write().await.cli_run = Some(CliRunTag {
            run_id: started.run_id.clone(),
            policy: PermissionPolicy::Deny,
            depth: 0,
        });
        h.emit("child", permission("c1", "Bash", "execute")).await;
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if commands
                .lock()
                .unwrap()
                .iter()
                .any(|c| c.starts_with("respond:c1:reject:"))
            {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "the child's card was never answered"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    #[tokio::test]
    async fn a_timeout_cancels_and_lists_the_cards_left_waiting() {
        let h = Harness::new().await;
        let run_id = h.svc.reserve().unwrap().run_id;
        let mut req = h.request(&run_id, PermissionPolicy::Wait);
        req.timeout_ms = Some(400);
        let started = h.svc.start(req).await.expect("starts");
        h.emit(&started.connection_id, permission("p1", "Bash", "execute"))
            .await;
        let events = h.drain(&run_id).await;
        assert!(events.iter().any(|e| matches!(
            e.body,
            EventBody::Permission {
                decision: PermissionVerdict::Waiting,
                ..
            }
        )));
        let result = result_of(&events);
        assert_eq!(result.subtype, Subtype::ErrorTimeout);
        let pending = result.pending.expect("the waiting card is listed");
        assert_eq!(pending[0].request_id, "p1");
        assert_eq!(pending[0].tool, "Bash");
        h.until_command(&started.connection_id, "cancel").await;
        assert!(!h
            .commands(&started.connection_id)
            .iter()
            .any(|c| c.starts_with("respond:")));
    }

    #[tokio::test]
    async fn a_cancelled_reservation_cannot_be_started() {
        let h = Harness::new().await;
        let run_id = h.svc.reserve().unwrap().run_id;
        h.svc
            .cancel(&run_id, CancelReason::Interrupt)
            .await
            .unwrap();
        let err = h
            .svc
            .start(h.request(&run_id, PermissionPolicy::Deny))
            .await
            .expect_err("a withdrawn reservation is refused");
        assert_eq!(err.body.error.code, "run_not_reserved");
        assert!(h.launcher.spawned.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_repeated_start_returns_the_same_run() {
        let h = Harness::new().await;
        let run_id = h.svc.reserve().unwrap().run_id;
        let (a, b) = tokio::join!(
            h.svc.start(h.request(&run_id, PermissionPolicy::Deny)),
            h.svc.start(h.request(&run_id, PermissionPolicy::Deny)),
        );
        let (a, b) = (a.unwrap(), b.unwrap());
        assert_eq!(a.conversation_id, b.conversation_id);
        assert_eq!(h.launcher.spawned.lock().unwrap().len(), 1);
    }

    /// A stop that lands while the launch is still spawning the agent waits
    /// for it, and the launch then gives up before the prompt: the agent never
    /// gets one.
    #[tokio::test]
    async fn a_stop_during_the_launch_means_no_prompt() {
        let gate = Arc::new(tokio::sync::Semaphore::new(0));
        let h = Harness::with(Script {
            gate: Some(gate.clone()),
            ..Script::default()
        })
        .await;
        let run_id = h.svc.reserve().unwrap().run_id;
        let svc = Arc::clone(&h.svc);
        let req = h.request(&run_id, PermissionPolicy::Deny);
        let start = tokio::spawn(async move { svc.start(req).await });
        // The launch is inside spawn; stop it there.
        tokio::time::sleep(Duration::from_millis(50)).await;
        let svc = Arc::clone(&h.svc);
        let rid = run_id.clone();
        let stop = tokio::spawn(async move { svc.cancel(&rid, CancelReason::Interrupt).await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        gate.add_permits(1);
        let err = start.await.unwrap().expect_err("the launch gives up");
        stop.await.unwrap().unwrap();
        assert_eq!(err.body.error.code, "run_stopped");
        let conn = h.launcher.spawned.lock().unwrap()[0].clone();
        h.until_command(&conn, "disconnect").await;
        assert!(!h.commands(&conn).iter().any(|c| c.starts_with("prompt:")));
        let result = h
            .svc
            .get(&GetRequest {
                run_id: run_id.clone(),
                wait_ms: None,
            })
            .await
            .unwrap()
            .result
            .expect("settled");
        assert_eq!(result.subtype, Subtype::ErrorInterrupted);
    }

    fn effort_option(current: &str) -> SessionConfigOptionInfo {
        SessionConfigOptionInfo {
            id: "effort".into(),
            name: "Effort".into(),
            description: None,
            category: Some("thought_level".into()),
            kind: SessionConfigKindInfo::Select(SessionConfigSelectInfo {
                current_value: current.into(),
                options: ["low", "medium", "high"]
                    .iter()
                    .map(|v| SessionConfigSelectOptionInfo {
                        value: v.to_string(),
                        name: v.to_string(),
                        description: None,
                    })
                    .collect(),
                groups: vec![],
            }),
            recommended_value: None,
        }
    }

    #[tokio::test]
    async fn an_effort_the_agent_rewrites_stops_the_launch_before_the_prompt() {
        let h = Harness::with(Script {
            options: Some(vec![effort_option("low")]),
            answer: Some(Arc::new(|_| {
                Ok(SetterOutcome::Confirmed {
                    current: "medium".into(),
                })
            })),
            ..Script::default()
        })
        .await;
        let run_id = h.svc.reserve().unwrap().run_id;
        let mut req = h.request(&run_id, PermissionPolicy::Deny);
        req.effort = Some("high".into());
        let err = h.svc.start(req).await.expect_err("rewritten");
        assert_eq!(err.body.subtype, Subtype::ErrorUsage);
        assert_eq!(err.body.error.code, "selection_rewritten");
        assert!(err.body.error.message.contains("\"high\""));
        assert!(err.body.error.message.contains("\"medium\""));
        let conn = h.launcher.spawned.lock().unwrap()[0].clone();
        assert!(h.commands(&conn).iter().any(|c| c == "set:effort=high"));
        assert!(!h.commands(&conn).iter().any(|c| c.starts_with("prompt:")));
    }

    #[tokio::test]
    async fn a_value_the_agent_does_not_offer_is_refused_without_a_request() {
        let h = Harness::with(Script {
            options: Some(vec![effort_option("low")]),
            ..Script::default()
        })
        .await;
        let run_id = h.svc.reserve().unwrap().run_id;
        let mut req = h.request(&run_id, PermissionPolicy::Deny);
        req.effort = Some("max".into());
        let err = h.svc.start(req).await.expect_err("unknown value");
        assert_eq!(err.body.error.code, "invalid_value");
        assert!(err.body.error.message.contains("low, medium, high"));
        let conn = h.launcher.spawned.lock().unwrap()[0].clone();
        assert!(!h.commands(&conn).iter().any(|c| c.starts_with("set:")));
    }

    #[tokio::test]
    async fn an_accepted_but_unconfirmed_setting_is_marked_so() {
        let h = Harness::with(Script {
            options: Some(vec![effort_option("low")]),
            answer: Some(Arc::new(|_| Ok(SetterOutcome::Accepted))),
            ..Script::default()
        })
        .await;
        let run_id = h.svc.reserve().unwrap().run_id;
        let mut req = h.request(&run_id, PermissionPolicy::Deny);
        req.effort = Some("high".into());
        let started = h
            .svc
            .start(req)
            .await
            .expect("an accepted setting proceeds");
        h.emit(&started.connection_id, turn_complete("end_turn"))
            .await;
        let result = result_of(&h.drain(&run_id).await);
        assert!(result.launch.unconfirmed.effort);
        assert_eq!(result.launch.requested.effort.as_deref(), Some("high"));
    }

    #[tokio::test]
    async fn a_nested_run_gets_no_wider_policy_than_its_caller() {
        let h = Harness::new().await;
        h.manager
            .insert_test_connection("caller", AgentType::ClaudeCode, None, EventEmitter::Noop)
            .await;
        h.state("caller").await.write().await.cli_run = Some(CliRunTag {
            run_id: "outer".into(),
            policy: PermissionPolicy::Deny,
            depth: 0,
        });
        let run_id = h.svc.reserve().unwrap().run_id;
        let mut req = h.request(&run_id, PermissionPolicy::Allow);
        req.caller = Some("caller".into());
        let started = h.svc.start(req).await.expect("starts");
        let tag = h
            .state(&started.connection_id)
            .await
            .read()
            .await
            .cli_run
            .clone()
            .unwrap();
        assert_eq!((tag.policy, tag.depth), (PermissionPolicy::Deny, 1));
        h.emit(&started.connection_id, turn_complete("end_turn"))
            .await;
        let events = h.drain(&run_id).await;
        assert!(events.iter().any(|e| matches!(
            &e.body,
            EventBody::Notice { title, .. } if title == "--permissions allow narrowed to deny"
        )));

        // One more level is refused before anything is spawned.
        h.state(&started.connection_id).await.write().await.cli_run = Some(CliRunTag {
            run_id: "inner".into(),
            policy: PermissionPolicy::Deny,
            depth: 1,
        });
        let deeper = h.svc.reserve().unwrap().run_id;
        let mut req = h.request(&deeper, PermissionPolicy::Deny);
        req.caller = Some(started.connection_id.clone());
        let spawned_before = h.launcher.spawned.lock().unwrap().len();
        let err = h.svc.start(req).await.expect_err("too deep");
        assert_eq!(err.body.error.code, "nested_too_deep");
        assert_eq!(h.launcher.spawned.lock().unwrap().len(), spawned_before);
    }

    #[tokio::test]
    async fn an_assistant_named_as_an_agent_gets_the_exact_flag() {
        use crate::models::assistant::{
            AssistantAgentConfig, AssistantAvatar, AssistantDraft, AssistantLabelSnapshot,
        };
        let h = Harness::new().await;
        assistant_service::create(
            &h.db.conn,
            &AssistantDraft {
                name: "code-reviewer".into(),
                description: String::new(),
                avatar: AssistantAvatar::Monogram {
                    color: "violet".into(),
                },
                agent_config: AssistantAgentConfig {
                    agent_type: AgentType::Codex,
                    agent_options: Default::default(),
                    label_snapshot: AssistantLabelSnapshot {
                        agent: "Codex CLI".into(),
                        mode: None,
                        options: vec![],
                    },
                },
                instructions: "Review strictly.".into(),
                enabled: true,
            },
        )
        .await
        .expect("assistant");
        let run_id = h.svc.reserve().unwrap().run_id;
        let mut req = h.request(&run_id, PermissionPolicy::Deny);
        req.agent = Some("code-reviewer".into());
        let err = h.svc.start(req).await.expect_err("not an agent");
        assert_eq!(err.body.subtype, Subtype::ErrorUsage);
        assert_eq!(err.body.error.next_steps, ["--assistant code-reviewer"]);

        // As an assistant it runs on the assistant's agent, with its brief.
        let run_id = h.svc.reserve().unwrap().run_id;
        let mut req = h.request(&run_id, PermissionPolicy::Deny);
        req.agent = None;
        req.assistant = Some("Code-Reviewer".into());
        let started = h.svc.start(req).await.expect("assistant run");
        assert_eq!(started.agent, "codex");
        let prompt = h.until_command(&started.connection_id, "prompt:").await;
        assert!(prompt.starts_with("prompt:review it|"), "{prompt}");
        assert!(prompt.contains("Review strictly."), "{prompt}");
    }

    /// A session that never comes up fails the launch before a conversation
    /// row exists — not a row stuck in progress next to a dead connection.
    #[tokio::test]
    async fn a_session_that_never_comes_up_fails_before_any_row() {
        let h = Harness::with(Script {
            dead_on_arrival: true,
            ..Script::default()
        })
        .await;
        let run_id = h.svc.reserve().unwrap().run_id;
        let err = h
            .svc
            .start(h.request(&run_id, PermissionPolicy::Deny))
            .await
            .expect_err("no session");
        assert_eq!(err.body.error.code, "agent_exited");
        use sea_orm::EntityTrait;
        let rows = conversation::Entity::find().all(&h.db.conn).await.unwrap();
        assert!(rows.is_empty(), "no conversation row: {rows:?}");
    }

    #[tokio::test]
    async fn a_lost_connection_fails_the_run_with_the_last_error() {
        let h = Harness::new().await;
        let started = h.start(PermissionPolicy::Deny).await;
        h.emit(
            &started.connection_id,
            AcpEvent::Error {
                message: "agent crashed".into(),
                agent_type: "claude_code".into(),
                code: None,
                details: None,
                terminal: true,
            },
        )
        .await;
        let result = result_of(&h.drain(&started.run_id).await);
        assert_eq!(result.subtype, Subtype::ErrorDuringExecution);
        assert_eq!(result.error.unwrap().message, "agent crashed");
    }

    #[tokio::test]
    async fn a_cursor_before_the_kept_events_reads_as_a_gap() {
        let run = Run {
            id: "r".into(),
            begun: Instant::now(),
            launch: Arc::new(Mutex::new(())),
            inner: Mutex::new(RunInner::new(PermissionPolicy::Deny, false)),
            changed: Notify::new(),
            started: watch::channel(None).0,
        };
        let mut inner = RunInner::new(PermissionPolicy::Deny, false);
        inner.reporting = true;
        for text in ["a", "b", "c"] {
            run.push(&mut inner, EventBody::MessageDelta { text: text.into() });
        }
        inner.log.pop_front(); // seq 1 dropped
        let read = read_after(&run, &inner, 0);
        assert!(read.gap);
        assert_eq!(read.events[0].body, EventBody::Gap {});
        assert_eq!(
            read.events[1].body,
            EventBody::MessageDelta { text: "bc".into() }
        );
        assert_eq!(read.next, 3);
        assert!(!read_after(&run, &inner, 1).gap);
        assert!(read_after(&run, &inner, 3).events.is_empty());
    }

    #[test]
    fn workspaces_are_checked_on_the_runtimes_machine() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_string_lossy().into_owned();
        assert_eq!(validate_workspace(&path).unwrap(), path);
        assert_eq!(
            validate_workspace("relative/dir")
                .unwrap_err()
                .body
                .error
                .code,
            "workspace_not_absolute"
        );
        let missing = dir.path().join("missing").to_string_lossy().into_owned();
        assert_eq!(
            validate_workspace(&missing).unwrap_err().body.error.code,
            "workspace_not_found"
        );
    }

    /// The hint is run as it stands (`eval "$hint"` in docs/cli.md): the
    /// registry's spec carries its version, so the command names it once.
    #[test]
    fn an_npm_hint_names_the_pinned_version_once() {
        let hint = install_hint(AgentType::ClaudeCode, true, None);
        assert!(
            hint.starts_with("npm install -g @agentclientprotocol/claude-agent-acp@"),
            "{hint}"
        );
        assert_eq!(hint.matches('@').count(), 2, "scope and version: {hint}");
        assert!(!hint.ends_with('@'), "{hint}");
        assert_eq!(
            install_hint(AgentType::ClaudeCode, false, None),
            "not available for this platform"
        );
    }

    #[test]
    fn names_become_single_shell_words() {
        assert_eq!(shell_word("code-reviewer"), "code-reviewer");
        assert_eq!(shell_word("Code Reviewer"), "'Code Reviewer'");
        assert_eq!(shell_word("it's"), r"'it'\''s'");
    }
}
