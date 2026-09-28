use std::collections::BTreeMap;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

use sea_orm::{
    ActiveModelTrait, ActiveValue::NotSet, ActiveValue::Set, DatabaseConnection, EntityTrait,
    TransactionTrait,
};

use crate::acp::connection::{
    spawn_agent_connection, AgentConnection, ConnectionCommand, GoalControlAction, SteerOutcome,
};
use crate::acp::agent_mentions::strip_route_separator_from_prompt;
use crate::acp::error::AcpError;
use crate::acp::feedback::{
    bounded_feedback_batch, FeedbackItem, FeedbackStatus, PendingFeedback,
    SessionFeedbackAccess, MAX_FEEDBACK_CHARS, MAX_FEEDBACK_RESPONSE_BYTES,
};
use crate::acp::plan_approval::{
    PlanApprovalAnswer, RegisteredPlanApproval, SessionPlanApprovalAccess,
};
use crate::acp::question::{
    build_outcome, QuestionAnswer, QuestionOutcome, QuestionSpec, RegisteredQuestion,
    SessionQuestionAccess,
};
use crate::acp::terminal_runtime::TerminalShellRuntimeConfig;
use crate::acp::types::{
    AcpEvent, AgentOptionsSnapshot, ConfigStaleKind, ConnectionInfo, ConnectionStatus,
    ForkResultInfo, PromptCapabilitiesInfo, PromptInputBlock,
};
use crate::db::entities::conversation::{self, ConversationKind, ConversationStatus};
use crate::db::service::conversation_service;
use crate::db::AppDatabase;
use crate::models::agent::AgentType;
use crate::web::event_bridge::{emit_with_state, emit_with_state_gated, EventEmitter};

/// Cap on the number of prompt-text chars kept in the `user_prompt_sent`
/// preview. Past this, `truncate_str` keeps this many chars and appends a short
/// `...` marker (so the rendered string can be a few chars longer). Bounds the
/// event payload so a large paste can't bloat the ring buffer, the per-channel
/// IM message, or the webhook body.
const USER_PROMPT_PREVIEW_MAX_CHARS: usize = 500;

/// Grace window `disconnect_all` waits after firing every `Disconnect` before
/// hard-killing surviving agent process trees. Long enough for a driver thread
/// to unwind and run its own post-loop cleanup (delegation/question/plan-approval
/// reclaim), short enough not to stall a quit noticeably. It is NOT there to
/// make the agent's death gentler — the graceful path ends in the same
/// `kill_tree`.
const DISCONNECT_ALL_GRACE: Duration = Duration::from_millis(500);

/// How long the polite signal gets before [`kill_tree_and_wait`] escalates to
/// `SIGKILL`. Counted from the first signal, which itself only lands after
/// [`DISCONNECT_ALL_GRACE`] of graceful shutdown, so anything still here has
/// already had a second to leave of its own accord.
const ESCALATE_TO_SIGKILL_AFTER: Duration = Duration::from_millis(500);

/// How often that sweep re-checks while it waits.
const CONFIRM_GONE_POLL: Duration = Duration::from_millis(50);

/// How long that sweep waits after `SIGKILL` for the reap to land. `kill(2)`
/// returns once the signal is queued, not once the target has been descheduled,
/// so on another core it can still be executing — briefly. Bounded tightly
/// because the wait can also end in no answer at all: a child that has already
/// exited but that nobody has reaped yet never zeroes its cell.
const SIGKILL_SETTLE: Duration = Duration::from_millis(200);

/// What one pass of [`kill_tree_pass`] established about the target itself.
#[derive(Debug, PartialEq, Eq)]
enum KillPass {
    /// The OS says there is no such process — the only report that positively
    /// means "not running".
    AlreadyGone,
    /// The signal was delivered to the target.
    Signalled,
    /// Neither could be established.
    Failed,
}

/// One signal pass over the process tree rooted at `pid`, reporting what
/// happened to the target itself (its descendants are killed either way).
///
/// `signal` is a `kill_tree` signal name; Windows ignores it and terminates
/// unconditionally. Blocking — call from `spawn_blocking`.
fn kill_tree_pass(pid: u32, signal: &str) -> KillPass {
    let config = kill_tree::Config {
        signal: signal.to_string(),
        ..Default::default()
    };
    match kill_tree::blocking::kill_tree_with_config(pid, &config) {
        Ok(outputs) => outputs
            .iter()
            .find_map(|o| match o {
                kill_tree::Output::MaybeAlreadyTerminated { process_id, .. }
                    if *process_id == pid =>
                {
                    Some(KillPass::AlreadyGone)
                }
                kill_tree::Output::Killed { process_id, .. } if *process_id == pid => {
                    Some(KillPass::Signalled)
                }
                _ => None,
            })
            .unwrap_or(KillPass::Failed),
        Err(e) => {
            tracing::debug!("[ACP] kill_tree pid={pid} signal={signal}: {e}");
            KillPass::Failed
        }
    }
}

/// Wait for `on_exit` to zero a connection's pid cell. `true` if it did within
/// roughly `budget` — the check follows the sleep, so the transition it sees
/// can be up to one poll late. Costs nothing per poll: no signal, no
/// process-table walk.
fn wait_for_reap(cell: &std::sync::atomic::AtomicU32, budget: Duration) -> bool {
    let started = std::time::Instant::now();
    while started.elapsed() < budget {
        std::thread::sleep(CONFIRM_GONE_POLL);
        if cell.load(std::sync::atomic::Ordering::SeqCst) == 0 {
            return true;
        }
    }
    false
}

/// Kill the process tree behind a connection's live pid cell and wait for the
/// target to stop running. Two signals at most: `SIGTERM`, then `SIGKILL` if
/// that was not enough.
///
/// `kill_tree` returns as soon as the signal is delivered, and its default
/// `SIGTERM` is both catchable and ignorable, so "the call returned" is not
/// "the agent is finished". That does not matter at quit — the OS cleans up
/// whatever is left — but it does for a caller that is about to touch state the
/// agent also writes (see [`ConnectionManager::disconnect_by_agent_type`]). So:
/// signal, give it the grace it deserves, then escalate.
///
/// Between the signals it waits on the pid CELL rather than re-signalling.
/// A second `SIGTERM` buys nothing — the first was delivered — while each extra
/// pass re-walks the whole process table and re-aims at a pid NUMBER that, once
/// the target exits, the OS is free to hand to something else.
///
/// The pid is loaded from the cell HERE, at the last possible moment, for the
/// reasons [`ConnectionManager::disconnect_all`] spells out. A cell reading
/// zero needs nothing: `on_exit` only zeroes it on a real reap, and a child
/// that never spawned has nothing to kill.
///
/// What `true` means, exactly, weakest case first:
/// - `SIGKILL` was delivered and [`SIGKILL_SETTLE`] passed without the reap
///   landing. `SIGKILL` cannot be caught, ignored or blocked, so the process
///   cannot run userspace code again; it is either unreaped, or stuck in an
///   uninterruptible syscall and will die on the way out of it. An in-flight
///   write already issued to the kernel may still complete.
/// - Or the reap landed, or the OS reported no such process. Then it is gone
///   outright.
///
/// `false` means the ESCALATION did not land: the `SIGKILL` pass came back with
/// neither a delivery nor a no-such-process. An earlier `SIGTERM` may well have
/// been delivered — see the call site for what is done about it.
///
/// One hazard survives all of this, and cannot be closed from here: between the
/// target exiting and its cell being zeroed, the pid NUMBER may be recycled, and
/// the escalation would then signal whatever now holds it. It is the same
/// exposure `disconnect_all` accepts — narrowed here to a single signal, where
/// re-probing in the wait loop would have spent one per poll — and closing it
/// properly needs a handle rather than a number: a pidfd, a process group, a job
/// object, all of them decided at spawn time.
///
/// Note the asymmetry: "the pid is out of the process table" is deliberately
/// NOT the bar, because it is not waitable. A child that has already exited but
/// has not been reaped yet answers signals exactly like a live one, so a
/// wait-for-the-pid-to-vanish loop would burn its whole window on a process
/// that died instantly.
///
/// Scope: this tracks the ROOT. Each pass re-walks and signals the whole tree,
/// but a descendant that ignores `SIGTERM` and outlives its parent is
/// reparented out of that tree and left to the OS — the same limit
/// `disconnect_all` has always had. Fine for the sign-out this exists for: the
/// credential lives in the agent process itself, not in the MCP servers it
/// starts. Closing it properly would mean giving every agent a process group or
/// a job object at spawn time.
///
/// Blocking — call from `spawn_blocking`.
fn kill_tree_and_wait(cell: &std::sync::atomic::AtomicU32) -> bool {
    let pid = cell.load(std::sync::atomic::Ordering::SeqCst);
    if pid == 0 {
        return true;
    }
    if kill_tree_pass(pid, "SIGTERM") == KillPass::AlreadyGone {
        return true;
    }
    if wait_for_reap(cell, ESCALATE_TO_SIGKILL_AFTER) {
        return true;
    }

    if kill_tree_pass(pid, "SIGKILL") == KillPass::Failed {
        // Neither gone nor reachable: someone else owns that pid now (recycled
        // onto another user's process, say), so it is not ours to wait for.
        // Reported, not acted on — retrying would not change the answer.
        tracing::warn!("[ACP] pid={pid} could not be signalled or confirmed gone");
        return false;
    }
    wait_for_reap(cell, SIGKILL_SETTLE);
    true
}

/// True for ids in the parsers' turn-id namespace (`turn-<digits>`), which every
/// parser assigns via `format!("turn-{}", n)`. A broadcast `message_id` must
/// never land here: it would collide with a persisted transcript turn id and let
/// id-keyed cross-client dedup suppress or hide a prompt. Used to reject an
/// untrusted client-supplied `message_id` of that shape.
fn is_reserved_turn_id(id: &str) -> bool {
    matches!(id.strip_prefix("turn-"), Some(rest)
        if !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit()))
}

/// Build the bounded preview string for a `user_prompt_sent` notification from
/// the `Text` blocks of a user prompt. Joins the (trimmed, non-empty) text
/// blocks with a space and caps the kept text at `USER_PROMPT_PREVIEW_MAX_CHARS`
/// chars (a `...` marker is appended past the cap). Returns `None` when the
/// prompt carries no text (e.g. image-only) — the notification fires for text
/// messages only.
fn user_prompt_text_preview(blocks: &[PromptInputBlock]) -> Option<String> {
    let joined = blocks
        .iter()
        .filter_map(|b| match b {
            PromptInputBlock::Text { text } => {
                let t = text.trim();
                (!t.is_empty()).then_some(t)
            }
            _ => None,
        })
        .collect::<Vec<_>>()
        .join(" ");
    let trimmed = joined.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(crate::parsers::truncate_str(
            trimmed,
            USER_PROMPT_PREVIEW_MAX_CHARS,
        ))
    }
}

/// Seed title for a freshly-created delegation child row, derived from the
/// delegating prompt's text blocks (the sub-agent's task). Uses the parser's own
/// `title_from_user_text` (folds reference links, caps at 100 chars) so the value
/// matches what `refresh_auto_title` would later compute from that same first
/// turn — the conditional UPDATE then sees no change and doesn't churn. Kept
/// unlocked by the caller so an AI-generated title can still replace it later.
///
/// A prompt with no prose at all — one dropped-in file and nothing else — is
/// named after what it carries instead. That row would otherwise read
/// "Untitled" forever: for an agent with no store parser, ACP has no title
/// channel and the history parse honestly reports no title. This value only
/// ever reaches `seed_auto_title_if_empty` / a fresh row's `title`, never
/// `refresh_auto_title`, so it cannot displace a name the agent published.
fn delegation_child_title_seed(blocks: &[PromptInputBlock]) -> Option<String> {
    let joined = blocks
        .iter()
        .filter_map(|b| match b {
            PromptInputBlock::Text { text } => {
                let t = text.trim();
                (!t.is_empty()).then_some(t)
            }
            _ => None,
        })
        .collect::<Vec<_>>()
        .join(" ");
    let trimmed = joined.trim();
    if !trimmed.is_empty() {
        return Some(crate::parsers::title_from_user_text(trimmed));
    }
    crate::acp::types::attachment_names_from_prompt(blocks)
        .map(|names| crate::parsers::title_from_user_text(&names))
}

/// Composite key identifying a logical agent session for spawn-time dedup.
/// Two `acp_connect` calls with the same triple race for the same `Mutex`,
/// so the second one observes the first's freshly-spawned connection in
/// `find_connection_for_reuse` instead of starting a duplicate process.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct SpawnDedupKey {
    agent_type: AgentType,
    working_dir: Option<PathBuf>,
    session_id: String,
}

/// Default upper bound on how long `spawn_agent` will hold the per-session
/// dedup lock waiting for `SessionStarted`. Picked to comfortably cover
/// cold-start agents (claude-code/codex warm: <2s; npx-fetched cold: 10–30s)
/// without deadlocking the next concurrent acp_connect when an agent is
/// genuinely broken.
pub(crate) const SPAWN_HANDSHAKE_TIMEOUT_SECS: u64 = 60;

/// Whether the turn a steer was admitted against is no longer the turn now in
/// flight — the guard `submit_feedback_native` applies across attachment
/// hydration, the one await between admission and the enqueue.
///
/// Both halves are needed. `turn_in_flight` alone cannot see "turn N ended and
/// N+1 started while we hydrated" — it reads true both times.
/// `SessionState.turns_completed` closes exactly that: it moves only on
/// `TurnComplete`, so it is stable for a turn's whole life and differs across
/// turns, whatever the new turn did to the flag. It is also independent of
/// whether the turn ever published a user message, which
/// `pending_user_message_started_at` is not (`user_message` is `None` for
/// delegation children and unbound conversations, so those turns would have
/// carried no identity at all).
fn steered_turn_changed(
    admitted_turns_completed: u64,
    now_in_flight: bool,
    now_turns_completed: u64,
) -> bool {
    !now_in_flight || now_turns_completed != admitted_turns_completed
}

/// Read the spawn-handshake timeout from `CODEG_ACP_SPAWN_HANDSHAKE_TIMEOUT_SECS`,
/// falling back to `SPAWN_HANDSHAKE_TIMEOUT_SECS`. Returns the configured
/// `Duration`. Tests can construct the manager with a custom value via
/// `with_spawn_handshake_timeout` instead of mutating env.
fn spawn_handshake_timeout_from_env() -> Duration {
    let secs = std::env::var("CODEG_ACP_SPAWN_HANDSHAKE_TIMEOUT_SECS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(SPAWN_HANDSHAKE_TIMEOUT_SECS);
    Duration::from_secs(secs)
}

/// Outcome of the `spawn_agent` dedup wait. Logged so production can audit
/// how often the timeout fires vs. the agent handshake completes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HandshakeWaitOutcome {
    /// `SessionStarted` applied; `external_id` is now set on the state.
    Ready,
    /// Sender was dropped before SessionStarted fired (typically the
    /// connection died during init — `run_connection` returned Err).
    Aborted,
    /// Timeout elapsed before either of the above. Releases the dedup lock
    /// so the next caller can proceed; the slow agent is no worse off.
    TimedOut,
}

impl HandshakeWaitOutcome {
    fn as_str(self) -> &'static str {
        match self {
            HandshakeWaitOutcome::Ready => "ready",
            HandshakeWaitOutcome::Aborted => "aborted",
            HandshakeWaitOutcome::TimedOut => "timeout",
        }
    }
}

/// Wait for the spawn-time `SessionStarted` signal, bounded by `timeout`.
/// Extracted so the outcome enum can be unit-tested without spawning a
/// real agent process.
async fn wait_for_session_started(
    rx: tokio::sync::oneshot::Receiver<()>,
    timeout: Duration,
) -> (HandshakeWaitOutcome, Duration) {
    let start = std::time::Instant::now();
    let outcome = match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(())) => HandshakeWaitOutcome::Ready,
        Ok(Err(_)) => HandshakeWaitOutcome::Aborted,
        Err(_) => HandshakeWaitOutcome::TimedOut,
    };
    (outcome, start.elapsed())
}

/// A connection that has left the map while its process may still be running.
struct DrainingChild {
    agent: AgentType,
    /// The connection's live pid cell. `on_spawn` publishes the pid and
    /// `on_exit` zeroes it on a real reap.
    pid: Arc<std::sync::atomic::AtomicU32>,
    parked_at: std::time::Instant,
}

type DrainingChildren = Vec<DrainingChild>;

/// How long a child whose pid reads zero is still treated as possibly running.
///
/// Zero is ambiguous: it means "reaped" AND "not spawned yet". A connection
/// torn down mid-spawn can publish a live pid moments later, so dropping it
/// immediately would hide a real writer. The grace resolves the ambiguity in
/// the safe direction — a false positive only downgrades a restore to the side
/// location, while a false negative unlinks a file an agent is writing.
const DRAIN_GRACE: std::time::Duration = std::time::Duration::from_secs(30);

/// Drop entries that are provably finished: pid back to zero and long enough
/// ago that it cannot be a spawn still in flight.
fn prune_reaped(draining: &mut DrainingChildren) {
    draining.retain(|c| {
        c.pid.load(std::sync::atomic::Ordering::SeqCst) != 0
            || c.parked_at.elapsed() < DRAIN_GRACE
    });
}

pub struct ConnectionManager {
    pub(crate) connections: Arc<Mutex<HashMap<String, AgentConnection>>>,
    /// Connections whose teardown was requested but whose child process has
    /// not been reaped yet.
    ///
    /// `disconnect` drops the map entry immediately and only then signals the
    /// child, so without this an agent that is still exiting — and still able
    /// to append to its transcript — is invisible to the backup restore gate,
    /// which would then unlink files it is still writing.
    ///
    /// Each entry holds the connection's live `child_pid` cell. `on_exit`
    /// zeroes it on a REAL reap; a connection that merely ended keeps its pid,
    /// because `ChildGuard::drop` signals the tree without waiting. So
    /// "non-zero" is exactly the codebase's existing definition of "this
    /// process may still be running", the same one the shutdown backstop
    /// relies on. Pruned on every push and every read, so it stays small.
    draining: Arc<Mutex<DrainingChildren>>,
    /// Read-held for the whole of `spawn_agent`, write-held while a backup
    /// restore writes transcripts back to the agents' own directories.
    ///
    /// Enumerating live connections and then writing is a check-then-use with
    /// a gap wide enough to drive through: staging a large archive takes
    /// minutes, and automations, the work-task engine and MCP delegation all
    /// start connections without a user clicking anything. Taking the write
    /// lock BEFORE enumerating closes it — no connection can appear between
    /// the count and the writes.
    external_restore_lock: Arc<tokio::sync::RwLock<()>>,
    /// Per-(agent, working_dir, session_id) async mutex. Held across the
    /// dedup-lookup + spawn + SessionStarted-wait critical section so two
    /// concurrent `spawn_agent` calls for the same logical session can't
    /// both miss dedup during the handshake window. Entries persist for
    /// process lifetime — bounded by the number of distinct sessions ever
    /// connected.
    spawn_locks: Arc<Mutex<HashMap<SpawnDedupKey, Arc<Mutex<()>>>>>,
    /// Bound on how long `spawn_agent` waits for the agent's handshake
    /// before releasing the dedup lock. Configurable per-instance for
    /// tests; in production initialized from env via
    /// `spawn_handshake_timeout_from_env`.
    spawn_handshake_timeout: Duration,
    /// Shared General Settings shell used by ACP terminal fallbacks. Cloned
    /// into each connection runtime so a setting update applies to existing
    /// model sessions as well as newly spawned ones.
    terminal_shell_config: TerminalShellRuntimeConfig,
    /// Delegation broker + token registry + UDS path installed during app
    /// bootstrap (`install_delegation`). When present, `spawn_agent` propagates
    /// the injection to `spawn_agent_connection`, which makes
    /// `codeg-mcp` appear in the agent's MCP server list during ACP
    /// init. `Arc<OnceLock>` so the inner `Self` cloned from `clone_ref` sees
    /// the install too — the lock is set once at startup and never mutated.
    delegation_injection: Arc<std::sync::OnceLock<crate::acp::connection::DelegationInjection>>,
    /// Chat-channel manager installed during bootstrap so live title writes
    /// can sync Telegram topic names without threading the manager through
    /// every `send_prompt_linked` caller. Optional in tests.
    chat_channel: Arc<std::sync::OnceLock<crate::chat_channel::manager::ChatChannelManager>>,
    /// Per-agent-type serialization for `probe_agent_options`. Without
    /// this, rapid agent-tab clicks in the settings UI would fan out one
    /// real CLI process per click — each one running up to 60s. The
    /// mutex bounds concurrent probes for the same agent_type to one;
    /// different agent_types remain parallel.
    probe_locks: Arc<Mutex<HashMap<AgentType, Arc<tokio::sync::Mutex<()>>>>>,
    /// In-flight `ask_user_question` calls awaiting the user's answer, keyed by
    /// the globally-unique `question_id`. The listener parks on the receiver;
    /// the answer / cancel path resolves (and removes) the matching sender.
    /// Shared across `clone_ref` clones so the listener-facing
    /// `register_question` and the command-facing `answer_question` touch the
    /// same map. Size tracks live concurrency (the agent is blocked per ask) —
    /// no cap, no cumulative growth; entries are removed on answer / cancel /
    /// connection teardown.
    pending_questions: Arc<Mutex<HashMap<String, PendingQuestionEntry>>>,
    /// In-flight Grok `exit_plan_mode` approvals awaiting the user's decision,
    /// keyed by the globally-unique `approval_id`. The connection's ext handler
    /// parks on the receiver; the answer / cancel path resolves (and removes) the
    /// matching sender. Shared across `clone_ref` clones so the connection-facing
    /// `register_plan_approval` and the command-facing `answer_plan_approval`
    /// touch the same map. At most one per connection (the agent is blocked in
    /// its `exit_plan_mode` call) — no cap, no cumulative growth.
    pending_plan_approvals: Arc<Mutex<HashMap<String, PendingPlanApprovalEntry>>>,
}

/// A parked `ask_user_question` awaiting its answer. The `sender` resolves the
/// blocked listener round-trip; `questions` is retained so `answer_question` can
/// build the self-describing outcome without a `SessionState` read (race-free).
struct PendingQuestionEntry {
    parent_connection_id: String,
    questions: Vec<QuestionSpec>,
    sender: tokio::sync::oneshot::Sender<QuestionOutcome>,
}

/// A parked Grok `exit_plan_mode` approval awaiting the user's decision. The
/// `sender` resolves the blocked ext-request round-trip in the connection's
/// handler. `parent_connection_id` routes the resolved event + answer.
struct PendingPlanApprovalEntry {
    parent_connection_id: String,
    sender: tokio::sync::oneshot::Sender<PlanApprovalAnswer>,
}

impl Default for ConnectionManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ConnectionManager {
    pub fn new() -> Self {
        Self {
            connections: Arc::new(Mutex::new(HashMap::new())),
            external_restore_lock: Arc::new(tokio::sync::RwLock::new(())),
            draining: Arc::new(Mutex::new(Vec::new())),
            spawn_locks: Arc::new(Mutex::new(HashMap::new())),
            spawn_handshake_timeout: spawn_handshake_timeout_from_env(),
            terminal_shell_config: TerminalShellRuntimeConfig::new(),
            delegation_injection: Arc::new(std::sync::OnceLock::new()),
            chat_channel: Arc::new(std::sync::OnceLock::new()),
            probe_locks: Arc::new(Mutex::new(HashMap::new())),
            pending_questions: Arc::new(Mutex::new(HashMap::new())),
            pending_plan_approvals: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Returns a shallow clone sharing the same underlying connection map.
    pub fn clone_ref(&self) -> Self {
        Self {
            connections: self.connections.clone(),
            external_restore_lock: self.external_restore_lock.clone(),
            draining: self.draining.clone(),
            spawn_locks: self.spawn_locks.clone(),
            spawn_handshake_timeout: self.spawn_handshake_timeout,
            terminal_shell_config: self.terminal_shell_config.clone(),
            delegation_injection: self.delegation_injection.clone(),
            chat_channel: self.chat_channel.clone(),
            probe_locks: self.probe_locks.clone(),
            pending_questions: self.pending_questions.clone(),
            pending_plan_approvals: self.pending_plan_approvals.clone(),
        }
    }

    /// Set the delegation injection context exactly once during bootstrap.
    /// Calling twice is a no-op — protects against accidental re-init in
    /// the unlikely event a second `build_delegation_stack` runs.
    pub fn install_delegation(&self, injection: crate::acp::connection::DelegationInjection) {
        let _ = self.delegation_injection.set(injection);
    }

    /// Install the chat-channel manager exactly once during bootstrap so
    /// live title writes can sync bound forum topics. Calling twice is a
    /// no-op. Tests leave this unset and skip the remote sync.
    pub fn install_chat_channel(
        &self,
        manager: crate::chat_channel::manager::ChatChannelManager,
    ) {
        let _ = self.chat_channel.set(manager);
    }

    pub(crate) fn chat_channel(
        &self,
    ) -> Option<crate::chat_channel::manager::ChatChannelManager> {
        self.chat_channel.get().map(|c| c.clone_ref())
    }

    fn delegation_snapshot(&self) -> Option<crate::acp::connection::DelegationInjection> {
        self.delegation_injection.get().cloned()
    }

    /// Returns the shared terminal-shell setting consumed by ACP terminal
    /// runtimes. Keeping the handle shared makes saves apply immediately to
    /// connections that are already running.
    pub fn terminal_shell_config(&self) -> TerminalShellRuntimeConfig {
        self.terminal_shell_config.clone()
    }

    /// Test-only constructor that overrides the spawn-handshake timeout.
    /// Production code should use `new()`.
    #[cfg(test)]
    fn with_spawn_handshake_timeout(timeout: Duration) -> Self {
        Self {
            connections: Arc::new(Mutex::new(HashMap::new())),
            external_restore_lock: Arc::new(tokio::sync::RwLock::new(())),
            draining: Arc::new(Mutex::new(Vec::new())),
            spawn_locks: Arc::new(Mutex::new(HashMap::new())),
            spawn_handshake_timeout: timeout,
            terminal_shell_config: TerminalShellRuntimeConfig::new(),
            delegation_injection: Arc::new(std::sync::OnceLock::new()),
            chat_channel: Arc::new(std::sync::OnceLock::new()),
            probe_locks: Arc::new(Mutex::new(HashMap::new())),
            pending_questions: Arc::new(Mutex::new(HashMap::new())),
            pending_plan_approvals: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Insert a synthetic `AgentConnection` for tests that need to exercise
    /// downstream code (attach, event broadcast, conversation linking)
    /// without spawning a real agent process. The returned connection is
    /// marked `Connected` and has a dropped `cmd_tx` receiver, so any
    /// attempt to send a prompt resolves to `ProcessExited` — fine for
    /// tests asserting on event-bus or session-state behavior.
    ///
    /// Gated behind `cfg(test)` (in-crate unit tests) and the `test-utils`
    /// feature (integration tests in `tests/*.rs`); the item is physically
    /// uncompiled in release builds so no production caller can reach it.
    #[cfg(any(test, feature = "test-utils"))]
    pub async fn insert_test_connection(
        &self,
        id: &str,
        agent_type: AgentType,
        working_dir: Option<PathBuf>,
        emitter: EventEmitter,
    ) {
        use crate::acp::session_state::SessionState;
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        let mut state = SessionState::new(
            id.to_string(),
            agent_type,
            working_dir,
            "test-window".to_string(),
            None,
        );
        state.status = ConnectionStatus::Connected;
        let conn = AgentConnection {
            id: id.to_string(),
            agent_type,
            status: ConnectionStatus::Connected,
            owner_window_label: "test-window".to_string(),
            cmd_tx: tx,
            state: Arc::new(tokio::sync::RwLock::new(state)),
            emitter,
            prompt_lock: Arc::new(tokio::sync::Mutex::new(())),
            config_fingerprint: String::new(),
            last_observed_fingerprint: String::new(),
            child_pid: Arc::new(std::sync::atomic::AtomicU32::new(0)),
        };
        let mut map = self.connections.lock().await;
        map.insert(id.to_string(), conn);
    }

    /// As [`insert_test_connection`], but keeps the command receiver ALIVE and
    /// returns it, so `send_prompt` can reach the concurrency gate (a dropped
    /// receiver fails `reserve()` with `ProcessExited` BEFORE the gate check,
    /// making the `TurnInProgress` branch untestable). Hold the returned
    /// receiver for the test's duration; drop it to simulate the process dying.
    ///
    /// Gated identically to [`insert_test_connection`] so it never compiles into
    /// a release build.
    #[cfg(any(test, feature = "test-utils"))]
    pub async fn insert_test_connection_live(
        &self,
        id: &str,
        agent_type: AgentType,
        working_dir: Option<PathBuf>,
        emitter: EventEmitter,
    ) -> tokio::sync::mpsc::Receiver<crate::acp::connection::ConnectionCommand> {
        use crate::acp::session_state::SessionState;
        let (tx, rx) = tokio::sync::mpsc::channel(4);
        let mut state = SessionState::new(
            id.to_string(),
            agent_type,
            working_dir,
            "test-window".to_string(),
            None,
        );
        state.status = ConnectionStatus::Connected;
        let conn = AgentConnection {
            id: id.to_string(),
            agent_type,
            status: ConnectionStatus::Connected,
            owner_window_label: "test-window".to_string(),
            cmd_tx: tx,
            state: Arc::new(tokio::sync::RwLock::new(state)),
            emitter,
            prompt_lock: Arc::new(tokio::sync::Mutex::new(())),
            config_fingerprint: String::new(),
            last_observed_fingerprint: String::new(),
            child_pid: Arc::new(std::sync::atomic::AtomicU32::new(0)),
        };
        self.connections.lock().await.insert(id.to_string(), conn);
        rx
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn spawn_agent(
        &self,
        agent_type: AgentType,
        working_dir: Option<String>,
        session_id: Option<String>,
        runtime_env: BTreeMap<String, String>,
        owner_window_label: String,
        emitter: EventEmitter,
        preferred_mode_id: Option<String>,
        preferred_config_values: BTreeMap<String, String>,
    ) -> Result<String, AcpError> {
        // Held for the whole establishment. A restore writing back to the
        // agents' own directories takes the write side, so it can never see an
        // empty connection list and then have one appear underneath it. Not
        // re-entrant: nothing reachable from here calls `spawn_agent` again.
        let _restore_guard = self.external_restore_lock.read().await;

        // Connection dedup: when resuming an agent session (session_id is
        // Some), look for a live AgentConnection that already represents
        // the same external session in the same working_dir for the same
        // agent_type and is not torn down. If found, reuse it instead of
        // spawning a fresh process — this is what makes a browser refresh
        // mid-turn re-attach to the existing live state rather than orphan it.
        let working_dir_path = working_dir.as_ref().map(PathBuf::from);

        // Acquire a per-(agent, working_dir, session_id) async mutex so two
        // concurrent connects for the same logical session can't both miss
        // dedup during the handshake window. The lookup → spawn → wait-for-
        // SessionStarted critical section runs under this lock; the second
        // waiter, on entry, observes the first call's connection with
        // `state.external_id` already populated and returns its id via
        // `find_connection_for_reuse`. Skipped entirely when `session_id`
        // is None (fresh sessions can't dedup — by design — since the
        // agent assigns the id).
        let session_id_for_log = session_id.clone();
        let dedup_lock = if let Some(sid) = session_id.as_deref() {
            let key = SpawnDedupKey {
                agent_type,
                working_dir: working_dir_path.clone(),
                session_id: sid.to_string(),
            };
            let mu = {
                let mut locks = self.spawn_locks.lock().await;
                locks
                    .entry(key)
                    .or_insert_with(|| Arc::new(Mutex::new(())))
                    .clone()
            };
            Some(mu.lock_owned().await)
        } else {
            None
        };

        if let Some(existing) = self
            .find_connection_for_reuse(agent_type, working_dir_path.as_ref(), session_id.as_deref())
            .await
        {
            tracing::info!(
                "[ACP] reusing connection id={} for session_id={}",
                existing,
                session_id.as_deref().unwrap_or("")
            );
            return Ok(existing);
        }

        let connection_id = uuid::Uuid::new_v4().to_string();
        tracing::info!(
            "[ACP] spawning connection id={} owner_window={} agent={:?}",
            connection_id, owner_window_label, agent_type
        );

        // `spawn_agent_connection` inserts the entry into `self.connections`,
        // installs the SessionStarted dedup signal on the state, registers
        // a cleanup hook, and returns the rx half of the signal. Any spawn
        // failure short-circuits before we touch the rx wait.
        let session_started_rx = spawn_agent_connection(
            connection_id.clone(),
            agent_type,
            working_dir,
            session_id,
            runtime_env,
            owner_window_label,
            emitter,
            self.connections.clone(),
            preferred_mode_id,
            preferred_config_values,
            self.delegation_snapshot(),
            self.terminal_shell_config.clone(),
        )
        .await?;

        // When dedup is active, hold the lock until the agent's
        // SessionStarted has applied (so external_id is populated for the
        // next waiter), aborted (connection died), or the timeout fires.
        // Logged on every wait so production can audit real-world handshake
        // latencies and tune `CODEG_ACP_SPAWN_HANDSHAKE_TIMEOUT_SECS`.
        if dedup_lock.is_some() {
            let timeout = self.spawn_handshake_timeout;
            let (outcome, elapsed) = wait_for_session_started(session_started_rx, timeout).await;
            tracing::info!(
                "[ACP] dedup_wait connection_id={} session_id={} outcome={} \
                 elapsed_ms={} timeout_ms={}",
                connection_id,
                session_id_for_log.as_deref().unwrap_or(""),
                outcome.as_str(),
                elapsed.as_millis(),
                timeout.as_millis(),
            );
        }
        // session_started_rx (in the no-dedup branch) is dropped here. tx
        // staying inside SessionState gets dropped naturally when the
        // connection terminates, no leak.

        drop(dedup_lock);

        Ok(connection_id)
    }

    /// Bump `last_activity_at` for a live connection so the idle sweep
    /// won't reap it. Used by the frontend keepalive loop to protect
    /// connections backing currently-open conversation tabs (the
    /// frontend is the only side that knows which tabs the user has
    /// open). Silently no-ops if the connection is missing or already
    /// in a terminal state — touch must never resurrect a dead
    /// connection or contend with the spawn/disconnect paths.
    pub async fn touch(&self, conn_id: &str) -> bool {
        let state_arc = {
            let connections = self.connections.lock().await;
            match connections.get(conn_id) {
                Some(conn) => conn.state.clone(),
                None => return false,
            }
        };
        let mut state = state_arc.write().await;
        if matches!(
            state.status,
            ConnectionStatus::Disconnected | ConnectionStatus::Error
        ) {
            return false;
        }
        state.last_activity_at = chrono::Utc::now();
        true
    }

    /// Disconnect connections that have been idle longer than `idle_timeout`.
    /// "Idle" means: status is `Connected`, no `pending_permission`, no
    /// launched-but-unresolved background work (async sub-agent / background
    /// shell — disconnecting kills the agent CLI and the background work with
    /// it), and no activity (no events, no commands) for at least
    /// `idle_timeout`. `Prompting` connections are always preserved (a turn is
    /// in flight). Returns the number of connections that were disconnected.
    pub async fn sweep_idle(&self, idle_timeout: Duration) -> usize {
        let now = chrono::Utc::now();
        let timeout = match chrono::Duration::from_std(idle_timeout) {
            Ok(d) => d,
            Err(_) => return 0,
        };
        let to_disconnect: Vec<String> = {
            let connections = self.connections.lock().await;
            let mut victims = Vec::new();
            for (id, conn) in connections.iter() {
                let Ok(state) = conn.state.try_read() else {
                    // Per-state writer holds the lock; a future tick will
                    // re-evaluate this entry. Don't block the connections
                    // mutex on it.
                    continue;
                };
                if state.status != ConnectionStatus::Connected {
                    continue;
                }
                if state.pending_permission.is_some() {
                    continue;
                }
                if state.has_active_background_work(now) {
                    continue;
                }
                let elapsed = now.signed_duration_since(state.last_activity_at);
                if elapsed >= timeout {
                    victims.push(id.clone());
                }
            }
            victims
        };
        let mut disconnected = 0;
        for id in to_disconnect {
            tracing::info!("[ACP] idle sweep disconnecting connection={}", id);
            if self.disconnect(&id).await.is_ok() {
                disconnected += 1;
            }
        }
        disconnected
    }

    /// Compare each running connection's spawn-time config fingerprint against a
    /// freshly recomputed one (keyed by agent type in `fresh`) and notify those
    /// that drifted. Drives the conversation-side "restart to apply" banner after
    /// a settings save.
    ///
    /// Emit policy, per connection:
    /// - emit `SessionConfigStale { stale }` only when the current fingerprint
    ///   differs from the one we last observed for it — a no-op save (identical
    ///   values) stays silent, while a second real change re-emits so a dismissed
    ///   banner reappears.
    /// - `stale = (current != spawn)`, so reverting a setting back to its
    ///   launch-time value emits `stale = false` and clears the banner.
    ///
    /// Returns the count of running connections currently on stale config across
    /// the affected agents (for the settings-side "N sessions need restart"
    /// toast). Connections whose agent type isn't in `fresh` are left untouched.
    ///
    /// `emit_with_state` is deferred until AFTER the connections-map lock is
    /// released (we collect targets first) so the SessionState write lock is
    /// never taken while holding the map lock.
    pub async fn refresh_connection_staleness(
        &self,
        fresh: &HashMap<AgentType, String>,
        kind: ConfigStaleKind,
    ) -> usize {
        let mut targets = Vec::new();
        let mut stale_count = 0usize;
        {
            let mut connections = self.connections.lock().await;
            for conn in connections.values_mut() {
                let Some(current) = fresh.get(&conn.agent_type) else {
                    continue;
                };
                let stale = *current != conn.config_fingerprint;
                if stale {
                    stale_count += 1;
                }
                if *current != conn.last_observed_fingerprint {
                    conn.last_observed_fingerprint = current.clone();
                    targets.push((Arc::clone(&conn.state), conn.emitter.clone(), stale));
                }
            }
        }
        for (state, emitter, stale) in targets {
            emit_with_state(&state, &emitter, AcpEvent::SessionConfigStale { stale, kind }).await;
        }
        stale_count
    }

    /// Look up an existing live connection that we can reuse instead of
    /// spawning a new process. Reuse criteria, ALL must hold:
    /// - `session_id` is Some (we never dedup speculative / fresh connects)
    /// - the connection's `state.external_id` equals `session_id`
    /// - the connection's `agent_type` equals the requested one
    /// - the connection's `working_dir` equals the requested one (compared as
    ///   `Option<PathBuf>` so canonicalization is the caller's concern)
    /// - the connection's `state.status` is neither `Disconnected` nor `Error`
    ///
    /// Per-session state is acquired via `read().await` rather than `try_read`:
    /// the only writer is `emit_with_state`, whose critical section is
    /// microseconds (apply_event + seq++ + broadcast::send), so contention
    /// resolves quickly and the previous "skip on writer" behavior was just
    /// trading correctness (false-negative dedup → duplicate process spawn)
    /// for an imperceptible latency win. The connections-map mutex is held
    /// across the awaits — fine because no path takes `state.write()` while
    /// holding the connections mutex (no lock-cycle).
    pub(crate) async fn find_connection_for_reuse(
        &self,
        agent_type: AgentType,
        working_dir: Option<&PathBuf>,
        session_id: Option<&str>,
    ) -> Option<String> {
        // No session_id → caller is opening a fresh session; never dedup.
        let session_id = session_id?;
        let connections = self.connections.lock().await;
        for (id, conn) in connections.iter() {
            if conn.agent_type != agent_type {
                continue;
            }
            let state = conn.state.read().await;
            if state.external_id.as_deref() != Some(session_id) {
                continue;
            }
            if state.working_dir.as_ref() != working_dir {
                continue;
            }
            if matches!(
                state.status,
                ConnectionStatus::Disconnected | ConnectionStatus::Error
            ) {
                continue;
            }
            return Some(id.clone());
        }
        None
    }

    /// Forwards a prompt to the connection's command channel without
    /// touching `prompt_lock`. Internal helper — both `send_prompt` and
    /// `send_prompt_linked` acquire the lock externally and then call
    /// this. Re-entering through `send_prompt` from `send_prompt_linked`
    /// while holding the lock would deadlock, hence the split.
    async fn send_prompt_inner(
        &self,
        conn_id: &str,
        mut blocks: Vec<PromptInputBlock>,
        user_message: Option<(String, Vec<crate::acp::UserMessageBlock>)>,
    ) -> Result<(), AcpError> {
        // Reject an empty prompt BEFORE touching the concurrency gate. An empty
        // prompt produces no turn — and thus no `TurnComplete` to clear the gate
        // — so enqueuing one with the gate set would wedge the connection into
        // rejecting every future send. `map_prompt_blocks` is 1:1, so empty
        // input blocks is the only way the loop could see an empty prompt; we
        // stop it here at the single shared enqueue path.
        if blocks.is_empty() {
            return Err(AcpError::protocol(
                "prompt must contain at least one content block".to_string(),
            ));
        }
        if strip_route_separator_from_prompt(&mut blocks) {
            tracing::debug!(
                "[ACP][{conn_id}] removed the reserved routing separator from an outgoing prompt"
            );
        }
        let (cmd_tx, state_arc) = {
            let connections = self.connections.lock().await;
            let conn = connections
                .get(conn_id)
                .ok_or_else(|| AcpError::ConnectionNotFound(conn_id.into()))?;
            (conn.cmd_tx.clone(), conn.state.clone())
        };
        // Concurrency gate: reject a second prompt while a turn is already in
        // flight on this connection. Reserve channel capacity FIRST — that
        // `reserve().await` is the only point that can block or be cancelled.
        // Then check+set the gate and hand the command to the permit
        // synchronously: because there is NO await between setting
        // `turn_in_flight` and the infallible `permit.send`, a dropped/cancelled
        // future can never strand the flag true (it is either never set — when
        // cancelled during reserve or the lock acquisition — or always followed
        // by the enqueue). The flag is set BEFORE the enqueue so it is in place
        // before the loop can dequeue and clear it on `TurnComplete`. Without
        // the gate the second `Prompt` would queue behind the active turn and be
        // silently dropped by the loop's in-turn handler (`_ => {}`) while the
        // caller saw success. `send_prompt` callers (e.g. the chat channel)
        // rely on this gate alone (no `prompt_lock`).
        let permit = cmd_tx
            .reserve()
            .await
            .map_err(|_| AcpError::ProcessExited)?;
        {
            let mut s = state_arc.write().await;
            if s.turn_in_flight {
                // Names the gate, not just the outcome: the linked path checks
                // the same flag once before its side effects and again here, and
                // the two lines share a module target with no file/line in the
                // default format — identical text would be unattributable.
                tracing::debug!(
                    connection_id = %conn_id,
                    "[ACP] prompt rejected at the send gate: a turn is already in flight"
                );
                return Err(AcpError::TurnInProgress);
            }
            s.turn_in_flight = true;
        }
        permit.send(ConnectionCommand::Prompt {
            blocks,
            user_message,
        });
        Ok(())
    }

    /// Clone the connection's `prompt_lock` under a short connections-map lock.
    /// Returned Arc allows the caller to hold the prompt lock without
    /// keeping the connections map locked.
    async fn clone_prompt_lock(
        &self,
        conn_id: &str,
    ) -> Result<Arc<tokio::sync::Mutex<()>>, AcpError> {
        let connections = self.connections.lock().await;
        let conn = connections
            .get(conn_id)
            .ok_or_else(|| AcpError::ConnectionNotFound(conn_id.into()))?;
        Ok(conn.prompt_lock.clone())
    }

    pub async fn send_prompt(
        &self,
        conn_id: &str,
        blocks: Vec<PromptInputBlock>,
    ) -> Result<(), AcpError> {
        let prompt_lock = self.clone_prompt_lock(conn_id).await?;
        let _guard = prompt_lock.lock_owned().await;
        self.send_prompt_inner(conn_id, blocks, None).await
    }

    /// Send a prompt while ensuring a `Conversation` DB row is bound to this
    /// connection. On the first call (when `state.conversation_id` is None),
    /// either:
    /// - **Caller-supplied path** — if `conversation_id` is `Some(id)`, the
    ///   caller (the frontend) has already created the row and we adopt it via
    ///   `ConversationLinked`. Requires `folder_id` to be `Some` so the event
    ///   carries both ids without forcing subscribers to re-query the DB.
    /// - **Backend-creates path** — if `conversation_id` is `None`, we create
    ///   the row from `folder_id` (required) and emit `ConversationLinked`.
    ///   Returns an error if `folder_id` is also `None`.
    ///
    /// Subsequent calls (when state is already linked) ignore both
    /// `folder_id` and `conversation_id` and just forward the prompt.
    ///
    /// Back-compat wrapper for callers that don't supply a client message id
    /// (the delegation broker, internal/test paths). The UI send path uses
    /// [`send_prompt_linked_with_message_id`] so the sender's optimistic turn
    /// dedups against the broadcast `UserMessage` echo by exact id.
    pub async fn send_prompt_linked(
        &self,
        db: &AppDatabase,
        conn_id: &str,
        blocks: Vec<PromptInputBlock>,
        folder_id: Option<i32>,
        conversation_id: Option<i32>,
        delegation: Option<crate::acp::delegation::spawner::DelegationLink>,
    ) -> Result<Option<i32>, AcpError> {
        self.send_prompt_linked_with_message_id(
            db,
            conn_id,
            blocks,
            folder_id,
            conversation_id,
            delegation,
            None,
        )
        .await
    }

    /// As [`send_prompt_linked`], plus an optional `client_message_id`: the
    /// id the sending UI assigned to its own optimistic user turn. When the
    /// user prompt is broadcast as [`AcpEvent::UserMessage`] (for cross-client
    /// viewers), this id becomes the event's `message_id`, so the sender's
    /// runtime dedups the echo against its optimistic turn by EXACT id rather
    /// than a heuristic — and an unrelated optimistic turn on another client
    /// never suppresses a different sender's prompt. `None` falls back to a
    /// connection-scoped id for non-UI senders.
    #[allow(clippy::too_many_arguments)]
    pub async fn send_prompt_linked_with_message_id(
        &self,
        db: &AppDatabase,
        conn_id: &str,
        mut blocks: Vec<PromptInputBlock>,
        folder_id: Option<i32>,
        conversation_id: Option<i32>,
        delegation: Option<crate::acp::delegation::spawner::DelegationLink>,
        client_message_id: Option<String>,
    ) -> Result<Option<i32>, AcpError> {
        // Reject an empty prompt up front, BEFORE any side effects: linking /
        // creating the conversation row, flipping it to InProgress, or emitting
        // events. An empty prompt is never accepted, so it must not mutate
        // persisted state (create a row, or flip an existing one — which would
        // then be rolled back to Cancelled). `send_prompt_inner` keeps a
        // defensive copy of this guard for the non-linked `send_prompt` path.
        if blocks.is_empty() {
            return Err(AcpError::protocol(
                "prompt must contain at least one content block".to_string(),
            ));
        }
        // Scrub the reserved separator HERE, before the conversation row, the
        // optimistic broadcast, and the ledger all take their copy of `blocks`,
        // so every persisted / displayed / on-the-wire copy is byte-identical.
        if strip_route_separator_from_prompt(&mut blocks) {
            tracing::debug!(
                "[ACP][{conn_id}] removed the reserved routing separator from an outgoing prompt"
            );
        }
        // Caller-supplied conversation_id requires folder_id (we include it in
        // the emitted ConversationLinked event so subscribers don't have to
        // re-query the DB). Validate before touching any state.
        if conversation_id.is_some() && folder_id.is_none() {
            return Err(AcpError::protocol(
                "conversation_id provided without folder_id".to_string(),
            ));
        }
        // Delegation is only meaningful on the create-new-row branch — adopting
        // an existing caller-supplied row already has its own (or no) parent
        // linkage. Reject the combination loudly so a misuse from the broker
        // doesn't silently drop the linkage.
        if delegation.is_some() && conversation_id.is_some() {
            return Err(AcpError::protocol(
                "delegation link is incompatible with caller-supplied conversation_id".to_string(),
            ));
        }

        // Acquire the per-connection prompt lock for the entire link-check
        // + DB write + emit + cmd_tx.send sequence. Two concurrent prompts
        // (multiple browser tabs of the same conversation; chat-channel
        // racing the UI) are now strictly serialized — the second waiter
        // observes `already_linked == true` after the first commits, so
        // it can't double-create a conversation row.
        let prompt_lock = self.clone_prompt_lock(conn_id).await?;
        let _prompt_guard = prompt_lock.lock_owned().await;

        // Snapshot what we need from the connection map under one short lock.
        // The conversation-linked check happens INSIDE the prompt lock so
        // any racing send sees a consistent post-link state.
        let (state_arc, emitter, agent_type, already_linked, turn_in_flight) = {
            let connections = self.connections.lock().await;
            let conn = connections
                .get(conn_id)
                .ok_or_else(|| AcpError::ConnectionNotFound(conn_id.into()))?;
            let (already, in_flight) = {
                let s = conn.state.read().await;
                (s.conversation_id.is_some(), s.turn_in_flight)
            };
            (
                conn.state.clone(),
                conn.emitter.clone(),
                conn.agent_type,
                already,
                in_flight,
            )
        };

        // Reject a concurrent prompt while a turn is already in flight, BEFORE
        // any side effects (row creation, InProgress emit, user-message
        // broadcast). `send_prompt_inner` re-checks and sets the flag
        // authoritatively below; doing it here too — while still holding
        // `prompt_lock`, so the value can't change underneath us (the loop only
        // ever clears it) — keeps a rejected prompt from flipping the row to
        // InProgress or broadcasting a phantom user message. The frontend turns
        // this rejection into a queued message above the input box.
        if turn_in_flight {
            // Distinct from `send_prompt_inner`'s send-gate line so a log reader
            // can tell which of the two checks bounced the prompt.
            tracing::debug!(
                connection_id = %conn_id,
                "[ACP] prompt rejected before admission: a turn is already in flight"
            );
            return Err(AcpError::TurnInProgress);
        }

        // Re-hydrate uploaded image attachments (web / remote-workspace mode
        // sends empty-payload marker blocks with a `file://` uri into the
        // uploads root; see `prompt_hydration`). Deliberately placed AFTER
        // admission — the connection-exists check (`clone_prompt_lock` above)
        // and the busy reject — so garbage or concurrent prompts never
        // trigger file reads, and the prompt lock we hold serializes
        // hydration per connection (a natural concurrency bound). Still
        // BEFORE any side effect (linking / row creation / status flip) and
        // before the `user_blocks_from_prompt` projection below, so a failure
        // aborts cleanly and the viewer broadcast, the sender echo, and the
        // agent all see the full bytes.
        crate::acp::prompt_hydration::hydrate_prompt_blocks(
            &mut blocks,
            &crate::paths::codeg_uploads_root(),
        )
        .await?;

        // CANCELLATION SHIELD around the first link, same shape and for the same
        // reason as `fork_session` below.
        //
        // Everything above this point is side-effect-free: drop this future and
        // `_prompt_guard` drops with it, having changed nothing. What follows is
        // not. `bind_external_id` COMMITS ownership of the agent session to a
        // row, and only the publication after it makes that row reachable —
        // `ConversationLinked` latches `state.conversation_id` (which is exactly
        // what `already_linked` reads), and the upsert puts the row in every
        // client's sidebar. Leaving that pair tied to this future means a
        // dropped caller (server mode: an HTTP client disconnecting
        // mid-request) can commit the bind and never publish, stranding a row
        // that owns the session but that nothing was told about — after which
        // Branch B fails EVERY retry with a `Conflict` naming that invisible
        // row, until the connection is re-established.
        //
        // Reordering does not solve it, it only moves the damage: publishing
        // first means a drop during the bind leaves the link latched onto a row
        // that does NOT hold the session, so the next prompt takes the
        // `already_linked` fast path and silently misfiles into the holder's
        // transcript. Both orderings are unsafe under cancellation, so the
        // phase must not be cancellable at all. It runs in a DETACHED task that
        // OWNS the guard and hands it back: dropping this future no longer
        // aborts the phase, it runs to completion and releases the lock when its
        // result is dropped. The handle is awaited only to hand the outcome to a
        // caller that is still there.
        let _prompt_guard = if already_linked {
            _prompt_guard
        } else {
            // Seed a delegation child's title from the task prompt so the
            // sidebar shows a meaningful label immediately. `list_children`
            // returns the raw DB title, so a child born with NULL reads
            // "Untitled" until the first detail load backfills it. Roots keep
            // `None` here and get the same first-prompt seed after the send
            // succeeds (so a failed enqueue does not name a cancelled row).
            // Computed out here so `blocks` stays with the caller for the
            // actual prompt.
            let seed_title = if delegation.is_some() {
                delegation_child_title_seed(&blocks)
            } else {
                None
            };
            let db_conn = db.conn.clone();
            let task_state = state_arc.clone();
            let task_emitter = emitter.clone();
            let task_conn_id = conn_id.to_string();
            let task_delegation = delegation.clone();
            let handle = tokio::spawn(async move {
                // Holding the owned guard for the whole task is what shields the
                // bind + publication from caller cancellation.
                let guard = _prompt_guard;
                let outcome: Result<(), AcpError> = async {
                    // Resolve which row this prompt belongs to WITHOUT
                    // announcing it yet — the announce is held back until the
                    // session id has actually been bound to that row below.
                    let (
                        linked_conversation_id,
                        linked_folder_id,
                        parent_conv_for_event,
                        parent_tool_for_event,
                    ) = match (conversation_id, folder_id) {
                        // Branch A: caller already owns a row — adopt it. No DB write.
                        (Some(caller_conv_id), Some(caller_folder_id)) => {
                            (caller_conv_id, caller_folder_id, None, None)
                        }
                        // Function-entry guard rejects this combination.
                        (Some(_), None) => unreachable!(
                            "conversation_id without folder_id should have been rejected at function entry"
                        ),
                        // Branch B: backend creates the row from caller-supplied
                        // folder_id. Phase 3c-1 made folder_id required here —
                        // every production caller that reaches this branch passes
                        // one, and silent fallback to working_dir-based
                        // find-or-create masked contract violations.
                        (None, Some(folder_id)) => {
                            // Snapshot the delegation link before
                            // move-into-create: we still need the parent ids for
                            // the ConversationLinked event payload.
                            let parent_conversation_id_for_event =
                                task_delegation.as_ref().map(|d| d.parent_conversation_id);
                            let parent_tool_use_id_for_event = task_delegation
                                .as_ref()
                                .map(|d| d.parent_tool_use_id.clone());
                            let row = conversation_service::create_with_delegation(
                                &db_conn,
                                folder_id,
                                agent_type,
                                seed_title,
                                None,
                                task_delegation,
                            )
                            .await
                            .map_err(|e| AcpError::protocol(e.to_string()))?;
                            (
                                row.id,
                                folder_id,
                                parent_conversation_id_for_event,
                                parent_tool_use_id_for_event,
                            )
                        }
                        (None, None) => {
                            return Err(AcpError::protocol(
                                "folder_id required for new conversation row".to_string(),
                            ));
                        }
                    };

                    // UI new-conversation path: SessionStarted applied
                    // state.external_id back during acp_connect, but
                    // conversation_id was None then so the lifecycle
                    // subscriber's SessionStarted handler skipped the DB write.
                    // Now that we have resolved the row in the same prompt_lock
                    // critical section, snapshot external_id and persist it
                    // synchronously — no dependence on broadcaster eventual
                    // consistency. The chat_channel reverse-order path (link
                    // before SessionStarted) is unaffected and continues to be
                    // handled by the lifecycle subscriber.
                    let eid_opt = task_state.read().await.external_id.clone();
                    let preserved = if let Some(eid) = eid_opt {
                        // THE codeg#500 write. Branch A above adopts a row the
                        // caller supplied, which may still be bound to an older
                        // session — a connection spawned with `session_id = None`
                        // (a reconnect that lost the id, or an unclassified
                        // `session/load` failure that fell through to
                        // `session/new`) arrives here holding a session that has
                        // nothing to do with the row's history.
                        // `bind_external_id` splits that history onto its own row
                        // instead of overwriting it.
                        let continues = crate::acp::continued_session_ids(agent_type, &eid);
                        match conversation_service::bind_external_id(
                            &db_conn,
                            linked_conversation_id,
                            &eid,
                            &continues,
                        )
                        .await
                        {
                            Ok(preserved) => preserved,
                            Err(e) => {
                                // Refused, or a genuine DB failure. Either way
                                // this row does not hold the session, so the
                                // prompt must not go out and the link must not
                                // stick.
                                //
                                // Branch B minted a row moments ago that no
                                // client has been told about — it was never
                                // announced, because the announce is below this
                                // bind. Drop it, or every refused attempt would
                                // leave another empty conversation behind for the
                                // sidebar's next full refetch to surface. Branch
                                // A creates nothing and has nothing to undo.
                                if conversation_id.is_none() {
                                    if let Err(cleanup) = conversation_service::soft_delete(
                                        &db_conn,
                                        linked_conversation_id,
                                    )
                                    .await
                                    {
                                        tracing::warn!(
                                            conversation_id = linked_conversation_id,
                                            error = %cleanup,
                                            "[manager] failed to drop the unannounced row left \
                                             by a refused bind"
                                        );
                                    }
                                }
                                return Err(AcpError::protocol(e.to_string()));
                            }
                        }
                    } else {
                        tracing::info!(
                            "[manager] send_prompt_linked: conversation resolved but \
                             external_id not yet on state (conn={task_conn_id}); lifecycle \
                             subscriber will catch up when SessionStarted arrives"
                        );
                        None
                    };

                    // Bound (or nothing to bind). NOW the link is real, so
                    // announce it: this is the write that makes `already_linked`
                    // true for every subsequent prompt on this connection.
                    emit_with_state(
                        &task_state,
                        &task_emitter,
                        AcpEvent::ConversationLinked {
                            conversation_id: linked_conversation_id,
                            folder_id: linked_folder_id,
                            parent_conversation_id: parent_conv_for_event,
                            parent_tool_use_id: parent_tool_for_event,
                        },
                    )
                    .await;
                    // Sidebar sync: a conversation born here (agent path — a
                    // prompt sent without a pre-created row, not the create
                    // button) must reach every client immediately via the global
                    // `conversation://changed` channel. Roots land in the sidebar
                    // list; delegation children (parent set) are routed into
                    // their parent's expanded sub-session subtree and bump its
                    // chevron. Emitted after the bind, so — unlike before, when
                    // Branch B broadcast an `external_id: null` summary and a
                    // second upsert corrected it — this carries the complete
                    // summary first time.
                    crate::commands::conversations::emit_conversation_upsert(
                        &task_emitter,
                        &db_conn,
                        linked_conversation_id,
                    )
                    .await;
                    // A new delegation child changes its parent's child_count
                    // (0 → >0 makes the parent's expand chevron appear). Re-emit
                    // the parent so every client converges its count from the
                    // authoritative DB aggregate rather than a drift-prone
                    // per-client increment. The parent may itself be a root or a
                    // nested child — the upsert routes correctly either way by
                    // its own parent_id.
                    if let Some(parent_id) = parent_conv_for_event {
                        crate::commands::conversations::emit_conversation_upsert(
                            &task_emitter,
                            &db_conn,
                            parent_id,
                        )
                        .await;
                    }
                    crate::commands::conversations::emit_preserved_conversation(
                        &task_emitter,
                        &db_conn,
                        preserved,
                    )
                    .await;
                    Ok(())
                }
                .await;
                // Logged HERE, not just returned. Once the phase is detached the
                // caller may be gone by now, and `handle.await`'s result is then
                // dropped unread — a `Conflict` (or any failure) would leave no
                // trace at all in exactly the disconnect case this shield exists
                // to handle.
                if let Err(e) = &outcome {
                    tracing::warn!(
                        connection_id = %task_conn_id,
                        error = %e,
                        "[manager] conversation link phase failed"
                    );
                }
                (outcome, guard)
            });
            let (outcome, guard) = handle.await.map_err(|e| {
                AcpError::protocol(format!("conversation link phase failed to join: {e}"))
            })?;
            outcome?;
            guard
        };

        // Centralized status transition: every prompt send flips the
        // conversation row to InProgress. This MUST happen on every call
        // (including the already-linked path) so that a follow-up turn whose
        // row is currently `pending_review` correctly transitions back. The
        // DB write precedes the event emit so any subscriber observing
        // `ConversationStatusChanged` can assume the row is consistent.
        // `update_status` is a single UPDATE — idempotent with respect to
        // the same status value, so re-writing `InProgress` is a benign no-op
        // on the row (touches `updated_at` only).
        let conversation_id_for_status = state_arc.read().await.conversation_id;
        if let Some(cid) = conversation_id_for_status {
            conversation_service::update_status(&db.conn, cid, ConversationStatus::InProgress)
                .await
                .map_err(|e| AcpError::protocol(e.to_string()))?;
            emit_with_state(
                &state_arc,
                &emitter,
                AcpEvent::ConversationStatusChanged {
                    conversation_id: cid,
                    status: ConversationStatus::InProgress,
                },
            )
            .await;
        }

        // Capture a bounded preview of the user's message BEFORE `blocks` is
        // moved into `send_prompt_inner`. Only on the genuine UI path
        // (`delegation.is_none()`): delegation / sub-agent prompts are not user
        // messages. Emitted after the send succeeds (below) so a prompt that
        // never reached the agent produces no "user message" notification.
        let user_prompt_preview = if delegation.is_none() {
            user_prompt_text_preview(&blocks)
        } else {
            None
        };
        // Seed an unlocked title from the first prompt so the sidebar is not
        // "Untitled" while the agent is still working. Native ACP titles
        // (session_info_update) replace this later via refresh_auto_title.
        // Delegation children are already seeded at row create.
        let first_prompt_title = if delegation.is_none() {
            delegation_child_title_seed(&blocks)
        } else {
            None
        };

        // Project the user's prompt blocks for the cross-client viewer
        // broadcast BEFORE `send_prompt_inner` consumes `blocks`, and hand the
        // payload to the connection loop (via `ConnectionCommand::Prompt`) so it
        // emits the `UserMessage` event in-order, right before the agent
        // request — guaranteeing its seq precedes the turn's agent events and
        // that it only fires for a prompt actually processed (a failed enqueue
        // delivers no command, so nothing strands a `pending_user_message`).
        // Gated on `delegation.is_none()` (children surface kickoff text
        // separately) and a bound conversation row (a sidebar-visible turn). The
        // `message_id` prefers the sender's client-supplied id (exact echo
        // dedup), falling back to a connection-scoped id for non-UI senders.
        let user_message: Option<(String, Vec<crate::acp::UserMessageBlock>)> =
            if delegation.is_none() && conversation_id_for_status.is_some() {
                let user_blocks = crate::acp::user_blocks_from_prompt(&blocks);
                if user_blocks.is_empty() {
                    None
                } else {
                    // A client-supplied id in the parsers' turn-id namespace
                    // (`turn-<digits>`, which every parser assigns) would collide
                    // with a persisted transcript turn id and break id-keyed dedup
                    // — a colliding id can suppress or hide a prompt. The id is
                    // untrusted (the web/Tauri prompt API accepts it verbatim), so
                    // reject that shape and fall back to a connection-scoped id;
                    // legitimate UI senders use `optimistic-<uuid>`.
                    let message_id = match client_message_id {
                        Some(id) if !is_reserved_turn_id(&id) => id,
                        _ => format!("user-{}-{}", conn_id, state_arc.read().await.event_seq),
                    };
                    Some((message_id, user_blocks))
                }
            } else {
                None
            };

        // We hold `_prompt_guard` here, so call the lock-free inner helper —
        // re-entering `send_prompt` would try to acquire the same mutex and
        // deadlock. The helper reserves channel capacity FIRST and only then
        // sets the turn-in-flight gate, with no await before the infallible
        // `permit.send`; so a failure (channel closed / process exited) happens
        // at the reserve step, BEFORE the gate is set — there is nothing to roll
        // back. On that failure we still flip the row to `Cancelled` so the UI
        // doesn't strand on `in_progress`: no `TurnComplete` will ever arrive
        // for a prompt that never reached the agent, so without this the
        // lifecycle subscriber's PendingReview write also never fires and the
        // row would be stuck until a follow-up `send_prompt_linked` re-flipped it.
        match self
            .send_prompt_inner(conn_id, blocks, user_message)
            .await
        {
            Ok(()) => {
                // The prompt reached the agent: surface it to the chat-channel
                // "user message" event feed. Notification-only — never gates the
                // send result.
                if let Some(text_preview) = user_prompt_preview {
                    emit_with_state(
                        &state_arc,
                        &emitter,
                        AcpEvent::UserPromptSent { text_preview },
                    )
                    .await;
                }
                if let (Some(cid), Some(title)) =
                    (conversation_id_for_status, first_prompt_title)
                {
                    match conversation_service::seed_auto_title_if_empty(&db.conn, cid, title)
                        .await
                    {
                        Ok(true) => {
                            crate::commands::conversations::emit_conversation_upsert(
                                &emitter, &db.conn, cid,
                            )
                            .await;
                            if let Some(ccm) = self.chat_channel() {
                                crate::commands::conversations::spawn_sync_conversation_title_until_current(
                                    db.conn.clone(),
                                    ccm,
                                    cid,
                                );
                            }
                        }
                        Ok(false) => {}
                        Err(e) => tracing::warn!(
                            conversation_id = cid,
                            error = %e,
                            "[manager] first-prompt title seed failed"
                        ),
                    }
                }
                Ok(conversation_id_for_status)
            }
            Err(send_err) => {
                if let Some(cid) = conversation_id_for_status {
                    match conversation_service::update_status(
                        &db.conn,
                        cid,
                        ConversationStatus::Cancelled,
                    )
                    .await
                    {
                        Ok(_) => {
                            emit_with_state(
                                &state_arc,
                                &emitter,
                                AcpEvent::ConversationStatusChanged {
                                    conversation_id: cid,
                                    status: ConversationStatus::Cancelled,
                                },
                            )
                            .await;
                        }
                        Err(rollback_err) => {
                            // Best-effort: original send error is the load-bearing
                            // signal; rollback failure is logged but not surfaced.
                            tracing::error!(
                                "[ACP][ERROR] failed to mark conversation {cid} cancelled \
                                 after send failure (original={send_err}): {rollback_err}"
                            );
                        }
                    }
                }
                Err(send_err)
            }
        }
    }

    pub async fn set_mode(&self, conn_id: &str, mode_id: String) -> Result<(), AcpError> {
        let cmd_tx = {
            let connections = self.connections.lock().await;
            let conn = connections
                .get(conn_id)
                .ok_or_else(|| AcpError::ConnectionNotFound(conn_id.into()))?;
            conn.cmd_tx.clone()
        };
        cmd_tx
            .send(ConnectionCommand::SetMode { mode_id })
            .await
            .map_err(|_| AcpError::ProcessExited)
    }

    pub async fn set_config_option(
        &self,
        conn_id: &str,
        config_id: String,
        value_id: String,
    ) -> Result<(), AcpError> {
        let cmd_tx = {
            let connections = self.connections.lock().await;
            let conn = connections
                .get(conn_id)
                .ok_or_else(|| AcpError::ConnectionNotFound(conn_id.into()))?;
            conn.cmd_tx.clone()
        };
        cmd_tx
            .send(ConnectionCommand::SetConfigOption {
                config_id,
                value_id,
            })
            .await
            .map_err(|_| AcpError::ProcessExited)
    }

    /// Pause or clear the session's active goal via the connection loop
    /// (codex-acp #293; the provider-neutral `_session/goal` since codex 1.2 /
    /// claude 0.66). Looked up by connectionId; the loop sources the sessionId
    /// from the live session, so callers only supply the action.
    ///
    /// STOPS THE RUNNING TURN TOO, for adapters whose control request travels
    /// out of band (see `registry::goal_control_is_out_of_band`). Without that,
    /// the button is a lie: codex's pause/clear are pure app-server metadata
    /// that only take hold at the next idle point, so the user clicks 暂停 and
    /// watches the agent keep working — the whole reason the goal card's
    /// controls were once ripped out.
    ///
    /// Two conditions guard it, and neither is "is a turn running?":
    /// * the goal must have been ACTIVE when the user clicked
    ///   (`SessionState.goal_active`, read before the request goes out). An
    ///   active goal is the thing driving the work, so stopping the work is
    ///   what the click means. A PAUSED goal drives nothing — clearing one is
    ///   housekeeping, and must never abort a turn the user started themselves
    ///   in the meantime.
    /// * the control must have LANDED. The loop reports that back over a
    ///   oneshot; a rejected request (or a closed channel) leaves the turn
    ///   alone, so a goal that is still `active` never gets its work killed
    ///   only to have codex resume it at the next idle point. The round-trip
    ///   also makes the interrupt strictly second: the goal is already
    ///   non-active when the abort lands, so nothing auto-continues on the way
    ///   out.
    ///
    /// Liveness deliberately does NOT gate it. `ConnectionStatus::Prompting`
    /// (and `turn_in_flight` with it) tracks turns CODEG started, and a goal
    /// loop's continuations are started by codex itself — detached turns no host
    /// request owns — so gating on them would skip the interrupt in exactly the
    /// case that motivated this. Any post-hoc read is unsound anyway: by the
    /// time the manager acts on it the turn it described may have ended. With
    /// the goal known active, the interrupt means precisely "press Stop on the
    /// user's behalf": `cancel()`'s row write is CAS'd from `InProgress`, a
    /// `session/cancel` with nothing running is a no-op, and its permission
    /// drain / delegation cascade are the semantics the Stop button already has
    /// (including its own turn-boundary race, which is not made worse here).
    ///
    /// Awaiting the round-trip is deliberate and cheap — an out-of-band control
    /// is a plain RPC that returns without waiting for the turn. It is NOT
    /// cancellation-shielded (unlike `submit_feedback_native`): a caller that
    /// disappears mid-await simply doesn't get the follow-up interrupt, which is
    /// the pre-existing behavior, never worse. The control itself is owned by
    /// the loop from the moment it is enqueued.
    pub async fn goal_control(
        &self,
        db: &DatabaseConnection,
        conn_id: &str,
        action: GoalControlAction,
    ) -> Result<(), AcpError> {
        let (cmd_tx, agent_type, state_arc) = {
            let connections = self.connections.lock().await;
            let conn = connections
                .get(conn_id)
                .ok_or_else(|| AcpError::ConnectionNotFound(conn_id.into()))?;
            (conn.cmd_tx.clone(), conn.agent_type, conn.state.clone())
        };
        // Read the goal state as it was when the user clicked — reading it after
        // the round-trip would see the transition we just asked for.
        let interrupts = crate::acp::registry::goal_control_is_out_of_band(agent_type)
            && state_arc.read().await.goal_active;
        // Only ask for an answer when it would change what we do next.
        let (reply_tx, reply_rx) = if interrupts {
            let (tx, rx) = tokio::sync::oneshot::channel();
            (Some(tx), Some(rx))
        } else {
            (None, None)
        };
        cmd_tx
            .send(ConnectionCommand::GoalControl {
                action,
                reply: reply_tx,
            })
            .await
            .map_err(|_| AcpError::ProcessExited)?;

        let Some(reply_rx) = reply_rx else {
            return Ok(());
        };
        if !matches!(reply_rx.await, Ok(true)) {
            return Ok(());
        }
        tracing::info!(
            "[ACP] goal {:?} landed; interrupting so the work stops now connection={}",
            action,
            conn_id
        );
        self.cancel(db, conn_id).await
    }

    /// Stop one AIR async task (`_session/async_task/stop`).
    ///
    /// Returns the adapter's own verdict, not "the request went through": it
    /// answers `false` for a task it declines to stop. Unshielded, unlike
    /// `submit_feedback_native` — there is nothing to persist on this path, so a
    /// caller that disconnects mid-await leaves no half-written state, and the
    /// user-visible result arrives on the session channel regardless of who is
    /// still listening for the reply.
    ///
    /// The task id is NOT pre-validated against `SessionState.async_tasks`. The
    /// adapter owns that table's real lifecycle (its `claimStop` already refuses
    /// unknown, terminal, and already-stopping tasks), and a local check could
    /// only ever be staler than the adapter's — it would turn a race into a
    /// silent no-op rather than the `false` the caller can report.
    pub async fn stop_async_task(&self, conn_id: &str, task_id: &str) -> Result<bool, AcpError> {
        let cmd_tx = {
            let connections = self.connections.lock().await;
            connections
                .get(conn_id)
                .ok_or_else(|| AcpError::ConnectionNotFound(conn_id.into()))?
                .cmd_tx
                .clone()
        };
        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
        cmd_tx
            .send(ConnectionCommand::StopAsyncTask {
                task_id: task_id.to_string(),
                reply: reply_tx,
            })
            .await
            .map_err(|_| AcpError::ProcessExited)?;
        reply_rx
            .await
            .map_err(|_| AcpError::protocol("Async task stop reply channel closed".to_string()))?
    }

    pub async fn cancel(&self, db: &DatabaseConnection, conn_id: &str) -> Result<(), AcpError> {
        let (cmd_tx, state_arc, emitter) = {
            let connections = self.connections.lock().await;
            let conn = connections
                .get(conn_id)
                .ok_or_else(|| AcpError::ConnectionNotFound(conn_id.into()))?;
            (
                conn.cmd_tx.clone(),
                conn.state.clone(),
                conn.emitter.clone(),
            )
        };
        cmd_tx
            .send(ConnectionCommand::Cancel)
            .await
            .map_err(|_| AcpError::ProcessExited)?;

        // Eagerly flip the row to `Cancelled` so the sidebar/tabs leave the
        // "running" state immediately. The agent typically replies with
        // `TurnComplete{cancelled}` which the lifecycle subscriber ignores,
        // and stays connected (so `handle_terminal_event` doesn't fire either)
        // — without this write the row would strand on `InProgress`.
        // CAS-guarded so we don't overwrite a `PendingReview`/`Completed`
        // status if the turn happened to end just before the user clicked.
        let conversation_id = state_arc.read().await.conversation_id;
        if let Some(cid) = conversation_id {
            match conversation_service::update_status_if(
                db,
                cid,
                ConversationStatus::InProgress,
                ConversationStatus::Cancelled,
            )
            .await
            {
                Ok(true) => {
                    emit_with_state(
                        &state_arc,
                        &emitter,
                        AcpEvent::ConversationStatusChanged {
                            conversation_id: cid,
                            status: ConversationStatus::Cancelled,
                        },
                    )
                    .await;
                }
                Ok(false) => {}
                Err(e) => {
                    tracing::error!(
                        "[ACP][ERROR] failed to mark conversation {cid} cancelled \
                         on user cancel (conn={conn_id}): {e}"
                    );
                }
            }
        }

        Ok(())
    }

    pub async fn respond_permission(
        &self,
        conn_id: &str,
        request_id: &str,
        option_id: &str,
    ) -> Result<(), AcpError> {
        let cmd_tx = {
            let connections = self.connections.lock().await;
            let conn = connections
                .get(conn_id)
                .ok_or_else(|| AcpError::ConnectionNotFound(conn_id.into()))?;
            conn.cmd_tx.clone()
        };
        cmd_tx
            .send(ConnectionCommand::RespondPermission {
                request_id: request_id.into(),
                option_id: option_id.into(),
            })
            .await
            .map_err(|_| AcpError::ProcessExited)
    }

    /// Fork the agent's session and persist the resulting two-row layout in
    /// one backend call: the current row gets re-pointed at S2 (the forked
    /// session) with a `[Fork]` title prefix, and a freshly-created sibling
    /// row preserves the pre-fork (S1) history at `PendingReview`. Frontend
    /// no longer touches `external_id` or fork-related row creation —
    /// the wire `ForkResultInfo` carries `sibling_conversation_id` for tab/UI
    /// reconciliation.
    pub async fn fork_session(
        &self,
        db: &AppDatabase,
        conn_id: &str,
        // Caller-supplied linkage for a connection that resumed a historical
        // conversation but hasn't sent a prompt through it yet. Such a
        // connection is bound to its session via `session_id` (resume) but its
        // conversation ROW isn't linked until the first prompt fires
        // `ConversationLinked` (see `send_prompt_linked`). A fork-send forks
        // BEFORE that first prompt, so without adopting the row here the fork
        // would reject as unlinked. Ignored when the connection is already
        // linked (the common new-conversation-then-fork path), and both must be
        // `Some` to link (a `conversation_id` needs its `folder_id`, mirroring
        // `send_prompt_linked`'s Branch A contract).
        link_conversation_id: Option<i32>,
        link_folder_id: Option<i32>,
        // Fork at this rendered turn instead of at the tail ("fork from here").
        // Resolved to an agent-specific `ForkPoint` below; a turn this agent
        // cannot name simply forks at the tail, which is what fork-send has
        // always done.
        fork_from_turn_id: Option<String>,
    ) -> Result<ForkResultInfo, AcpError> {
        let (state_arc, cmd_tx, emitter) = {
            let connections = self.connections.lock().await;
            let conn = connections
                .get(conn_id)
                .ok_or_else(|| AcpError::ConnectionNotFound(conn_id.into()))?;
            (
                conn.state.clone(),
                conn.cmd_tx.clone(),
                conn.emitter.clone(),
            )
        };

        // Serialize the fork against concurrent prompts on this connection via
        // the same per-connection `prompt_lock` that `send_prompt`/
        // `send_prompt_linked` hold. A fork re-points the live session, so a
        // prompt must never start a turn underneath it. The lock is held for the
        // WHOLE operation (gate check → enqueue → protocol round-trip →
        // persistence); because the LOCK (not a flag) provides the exclusion,
        // the fork never SETS `turn_in_flight`, so there is no flag a dropped
        // future could strand and no window where a prompt's side effects (row
        // create / InProgress) commit only to lose the gate to a fork and roll
        // back to `Cancelled`.
        let prompt_lock = self.clone_prompt_lock(conn_id).await?;
        let prompt_guard = prompt_lock.lock_owned().await;

        // Link the conversation row on demand, under the prompt lock so it
        // can't race a concurrent first prompt. A conversation opened from
        // history resumes via `session_id`, but its row is bound to the
        // connection only when the first prompt fires `ConversationLinked`;
        // fork-send forks first, so adopt the caller-supplied row here (the
        // same existing-row path as `send_prompt_linked` Branch A). No-op when
        // already linked, or when the caller didn't supply both ids (the check
        // below then rejects, unchanged).
        if state_arc.read().await.conversation_id.is_none() {
            if let (Some(cid), Some(fid)) = (link_conversation_id, link_folder_id) {
                emit_with_state(
                    &state_arc,
                    &emitter,
                    AcpEvent::ConversationLinked {
                        conversation_id: cid,
                        folder_id: fid,
                        parent_conversation_id: None,
                        parent_tool_use_id: None,
                    },
                )
                .await;
            }
        }

        // Fork requires a linked conversation row — the sibling we're about
        // to create exists to preserve THIS row's pre-fork history. Without
        // a current row, fork would either orphan S1 or violate the
        // no-pre-prompt-row invariant.
        let conversation_id = state_arc.read().await.conversation_id.ok_or_else(|| {
            AcpError::protocol("fork_session requires a linked conversation row".to_string())
        })?;

        // Resolve the fork point BEFORE the cancellation shield below: this is
        // a read-only parse, so a caller that disappears here has changed
        // nothing. Failing to resolve is not an error — it degrades to the tail
        // fork rather than refusing the user's click.
        let fork_point = match fork_from_turn_id {
            None => None,
            Some(turn_id) => {
                let agent_type = state_arc.read().await.agent_type;
                match crate::commands::conversations::get_folder_conversation_core(
                    &db.conn,
                    conversation_id,
                )
                .await
                {
                    Ok((detail, _)) => {
                        let point = crate::acp::fork::resolve_fork_point(
                            &detail.turns,
                            &turn_id,
                            agent_type,
                        );
                        if point.is_none() {
                            tracing::info!(
                                connection_id = %conn_id,
                                turn_id = %turn_id,
                                agent = %agent_type,
                                "[ACP] no fork point for this turn; forking at the tail"
                            );
                        }
                        point
                    }
                    Err(e) => {
                        tracing::warn!(
                            connection_id = %conn_id,
                            turn_id = %turn_id,
                            "[ACP] could not read the conversation to resolve a fork point \
                             ({e}); forking at the tail"
                        );
                        None
                    }
                }
            }
        };

        // Reject if a turn is already in flight. `prompt_lock` is FREE between a
        // prompt's enqueue and its `TurnComplete` (it is released the moment the
        // command is queued), so the lock alone can't catch a turn the loop is
        // mid-processing — only the gate can. We CHECK the gate (bouncing with
        // `TurnInProgress` so the caller re-queues) under the prompt lock, where
        // the loop is the only writer and the value can't flip to true
        // underneath us, but we never SET it: not setting the gate is precisely
        // why a dropped fork can't wedge the connection.
        if state_arc.read().await.turn_in_flight {
            tracing::debug!(
                connection_id = %conn_id,
                "[ACP] fork rejected: a turn is already in flight"
            );
            return Err(AcpError::TurnInProgress);
        }

        // CANCELLATION SHIELD. Up to here the fork is side-effect-free: if THIS
        // future is dropped now (e.g. an HTTP client disconnecting mid-fork), the
        // `prompt_guard` drops and nothing happened. But the instant we enqueue
        // `ConnectionCommand::Fork`, the connection loop executes the agent
        // `session/fork` and re-points the live session to S2 REGARDLESS of
        // whether this caller survives — `handle_fork_or_exit` ignores a dead
        // reply channel and still attaches + emits `SessionStarted{S2}`. So the
        // DB persistence (sibling row preserving S1 + `[Fork]` title) must NOT be
        // tied to this future; otherwise a dropped caller would strand the live
        // session on S2 with the pre-fork S1 history orphaned and no sibling row.
        // We run enqueue → reply → persist → emit in a DETACHED task that OWNS
        // the `prompt_guard`: dropping this future no longer aborts the
        // persistence — it runs to completion and only then releases the lock.
        // We await the task's handle purely to hand the result back to a live
        // caller; the result is harmlessly discarded if the caller is gone.
        let db_conn = db.conn.clone();
        let conn_id_for_task = conn_id.to_string();
        let handle = tokio::spawn(async move {
            // Holding the owned guard for the whole task is what shields the
            // persistence from caller cancellation.
            let _prompt_guard = prompt_guard;
            let outcome: Result<ForkResultInfo, AcpError> = async {
                // Protocol-only round trip — no DB writes inside the loop.
                let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
                cmd_tx
                    .send(ConnectionCommand::Fork {
                        fork_point,
                        reply: reply_tx,
                    })
                    .await
                    .map_err(|_| AcpError::ProcessExited)?;
                let protocol_result = reply_rx
                    .await
                    .map_err(|_| AcpError::protocol("Fork reply channel closed".to_string()))??;

                let forked_session_id = protocol_result.forked_session_id;
                let original_session_id = protocol_result.original_session_id;

                let sibling_id = Self::persist_fork_outcome(
                    &db_conn,
                    conversation_id,
                    forked_session_id.clone(),
                    original_session_id.clone(),
                )
                .await?;

                // Fork mutates the sidebar in two ways the rest of the system
                // never sees otherwise: the current row's title (`[Fork] …`) and
                // external_id (→ S2) changed, and a brand-new sibling row now
                // exists (external_id S1, PendingReview). Broadcast both on
                // `conversation://changed` so every other client converges in
                // real time instead of waiting for a manual refresh. Both rows
                // are roots; the helper still guards `parent_id` internally.
                crate::commands::conversations::emit_conversation_upsert(
                    &emitter,
                    &db_conn,
                    conversation_id,
                )
                .await;
                crate::commands::conversations::emit_conversation_upsert(
                    &emitter, &db_conn, sibling_id,
                )
                .await;

                Ok(ForkResultInfo {
                    forked_session_id,
                    original_session_id,
                    sibling_conversation_id: sibling_id,
                })
            }
            .await;
            // Surface failures even when the caller is gone (the detached task's
            // Result would otherwise be dropped silently).
            if let Err(ref e) = outcome {
                tracing::error!("[ACP][ERROR] fork persistence failed (conn={conn_id_for_task}): {e}");
            }
            outcome
        });

        match handle.await {
            Ok(result) => result,
            Err(join_err) => {
                tracing::error!(
                    "[ACP][ERROR] fork persistence task did not complete (conn={conn_id}): \
                     {join_err}"
                );
                Err(AcpError::protocol(format!(
                    "fork persistence task did not complete: {join_err}"
                )))
            }
        }
    }

    /// Persist the two-row fork layout: re-point the current row at S2 under a
    /// locked `[Fork]` title prefix, and INSERT a sibling row preserving the
    /// pre-fork (S1) history at `PendingReview`, which inherits the original's
    /// title lock. Returns the sibling row id.
    ///
    /// Both titles outlive the per-turn auto-title backfill by design: neither
    /// the user's own name nor codeg's `[Fork] ` marker exists in the session
    /// file the backfill re-parses, so an unlocked row would silently revert to
    /// the parsed title on its next detail load.
    ///
    /// Factored out of [`fork_session`] so the cancellation-shielded task body
    /// stays readable. Everything runs in one transaction so a mid-sequence
    /// failure can't leak: if INSERT fails we don't re-point the current row at
    /// S2 (it stays bound to S1; the lifecycle subscriber's eventual
    /// `SessionStarted{S2}` write would still occur, but the user-visible row
    /// layout stays consistent until then). If the current-row UPDATE fails we
    /// never insert a sibling — no orphan.
    ///
    /// The transaction is deliberately WRITE-FIRST. SeaORM's SQLite backend
    /// always opens a transaction with a plain (deferred) `BEGIN` — access mode
    /// isn't configurable per-transaction for SQLite — so a transaction that
    /// LED with the `SELECT` of the current row would take a read snapshot
    /// first; if any other pooled connection commits a write before this
    /// transaction's later UPDATE (routine under this app's concurrent
    /// multi-conversation load), SQLite can't promote that now-stale snapshot
    /// to a writer and fails the whole transaction with `SQLITE_BUSY_SNAPSHOT`
    /// (code 517) — surfaced to the user as "database is locked" even though
    /// nothing was actually deadlocked, and NOT retried by `busy_timeout` (that
    /// only covers ordinary lock contention). So the FIRST statement is a write
    /// (bump `updated_at`, which we want anyway and which claims the writer
    /// lock), and only THEN do we read the row. Reading under the held write
    /// lock has a second payoff: because no other writer can interpose between
    /// the read and the UPDATE/INSERT, the title/metadata we derive can't be a
    /// stale snapshot that a concurrent rename/soft-delete already superseded —
    /// the fork observes the latest committed row and never clobbers a newer
    /// title or forks from stale routing.
    ///
    /// The claim write is filtered on `deleted_at IS NULL` (the codebase-wide
    /// "live row" predicate). Forking a soft-deleted conversation would
    /// otherwise resurrect it as a fresh, visible sibling (`deleted_at = None`),
    /// so a claim that matches no LIVE row is treated as not-found and the whole
    /// fork aborts without writing anything.
    async fn persist_fork_outcome(
        db_conn: &DatabaseConnection,
        conversation_id: i32,
        forked_session_id: String,
        original_session_id: String,
    ) -> Result<i32, AcpError> {
        use sea_orm::sea_query::Expr;
        use sea_orm::{ColumnTrait, QueryFilter};

        db_conn
            .transaction::<_, i32, sea_orm::DbErr>(|txn| {
                Box::pin(async move {
                    let now = chrono::Utc::now();

                    // WRITE FIRST — see the fn doc. Bumping `updated_at` is the
                    // transaction's opening statement so SQLite acquires the
                    // writer lock immediately instead of taking a deferred read
                    // snapshot it would later have to (and might fail to)
                    // promote. Filtered on `deleted_at IS NULL` so a soft-deleted
                    // conversation can't be forked back into a live sibling;
                    // `rows_affected == 0` means the row is gone OR deleted.
                    let claimed = conversation::Entity::update_many()
                        .col_expr(conversation::Column::UpdatedAt, Expr::value(now))
                        .filter(conversation::Column::Id.eq(conversation_id))
                        .filter(conversation::Column::DeletedAt.is_null())
                        .exec(txn)
                        .await?;
                    if claimed.rows_affected == 0 {
                        return Err(sea_orm::DbErr::Custom(format!(
                            "conversation {conversation_id} not found or already deleted"
                        )));
                    }

                    // Read UNDER the write lock: this SELECT sees the latest
                    // committed state and no other writer can interpose before
                    // this transaction finishes, so the derived title/metadata
                    // below can't be superseded by a concurrent rename/delete.
                    // The successful live-row claim above guarantees this returns
                    // Some; the `ok_or_else` is defensive.
                    let current = conversation::Entity::find_by_id(conversation_id)
                        .one(txn)
                        .await?
                        .ok_or_else(|| {
                            sea_orm::DbErr::Custom(format!(
                                "conversation {conversation_id} not found"
                            ))
                        })?;

                    // Strip any `[Fork]` prefix tolerantly (matches the prior
                    // frontend regex `/^\[Fork]\s*/g` behaviour for both spaced
                    // and no-space variants). None title stays None.
                    let clean_title: Option<String> = current.title.as_ref().map(|t| {
                        t.strip_prefix("[Fork]")
                            .map(str::trim_start)
                            .unwrap_or(t.as_str())
                            .to_string()
                    });

                    let folder_id = current.folder_id;
                    let agent_type_str = current.agent_type.clone();
                    let git_branch = current.git_branch.clone();
                    // The lock rides along with the title it protects: the
                    // sibling holds the pre-fork history of the very row the
                    // user renamed, so a hand-picked name has to stay locked
                    // there too. Born unlocked, the sibling's first detail load
                    // re-parses S1 and lets `refresh_auto_title` adopt the
                    // session-file title — the rename silently reverting on the
                    // conversation the fork was supposed to leave untouched.
                    // Inheriting (not forcing) keeps an auto-titled sibling
                    // eligible for later backfills.
                    let title_locked = current.title_locked;
                    // The sibling keeps the original's sidebar routing (a forked
                    // chat conversation must stay in the Chat group). `Delegate`
                    // is unreachable here — children are never forked from the
                    // UI — but the invariant `delegate ⟺ parent_id set` wins
                    // over inheritance, so it degrades to `Regular`.
                    let sibling_kind = match current.kind {
                        ConversationKind::Delegate => ConversationKind::Regular,
                        ref kind => kind.clone(),
                    };

                    // UPDATE current row → S2. Writing external_id explicitly
                    // here closes the race against `refreshConversations()`
                    // after this fn returns; the lifecycle subscriber's later
                    // SessionStarted{S2} write is an idempotent no-op.
                    let mut active: conversation::ActiveModel = current.into();
                    if let Some(ref clean) = clean_title {
                        active.title = Set(Some(format!("[Fork] {clean}")));
                        // ...and lock it. The `[Fork] ` marker is codeg's own —
                        // no parser derives it from a transcript — so on an
                        // unlocked row it survives only until the next detail
                        // load, where the auto-title backfill adopts the
                        // session-file title and the two rows this fork just
                        // created end up wearing the SAME name. Forking is a
                        // deliberate user action on a conversation the user
                        // named (or accepted the name of), so treating the
                        // result as user-set is honest; the cost is that the
                        // forked row stops tracking the session file's title,
                        // exactly as a rename would. A titleless row writes no
                        // title here and stays unlocked, so the backfill can
                        // still give it its first name.
                        active.title_locked = Set(true);
                    }
                    active.external_id = Set(Some(forked_session_id));
                    active.updated_at = Set(now);
                    active.update(txn).await?;

                    // The lifecycle subscriber may have got here first. Its
                    // `SessionStarted{S2}` handler now runs the guarded
                    // `bind_external_id`, which preserves S1 on its own row
                    // when nothing else holds it — and that race is real, not
                    // theoretical: the fork reply is sent to us BEFORE
                    // `handle_fork_or_exit` emits `SessionStarted{S2}` (see
                    // `connection.rs`), so this detached persistence task and
                    // the lifecycle worker run concurrently from that point.
                    //
                    // Inserting a second S1 row would not merely duplicate it:
                    // `idx_conversation_external_agent` is UNIQUE over
                    // `(external_id, agent_type)`, so the INSERT would fail and
                    // roll back the whole fork. Adopt whatever already holds S1
                    // instead and return ITS id — the caller feeds that straight
                    // into `ForkResultInfo.sibling_conversation_id` and the
                    // sidebar upsert, both of which must name a real row.
                    if let Some(existing) = conversation::Entity::find()
                        .filter(conversation::Column::ExternalId.eq(original_session_id.clone()))
                        .filter(conversation::Column::AgentType.eq(agent_type_str.clone()))
                        .filter(conversation::Column::Id.ne(conversation_id))
                        .filter(conversation::Column::DeletedAt.is_null())
                        .one(txn)
                        .await?
                    {
                        return Ok(existing.id);
                    }

                    // INSERT sibling row preserving pre-fork (S1) history.
                    // PendingReview because no live agent is attached to S1.
                    let sibling = conversation::ActiveModel {
                        id: NotSet,
                        folder_id: Set(folder_id),
                        title: Set(clean_title),
                        title_locked: Set(title_locked),
                        agent_type: Set(agent_type_str),
                        status: Set(ConversationStatus::PendingReview),
                        kind: Set(sibling_kind),
                        model: Set(None),
                        git_branch: Set(git_branch),
                        external_id: Set(Some(original_session_id)),
                        parent_id: Set(None),
                        parent_tool_use_id: Set(None),
                        delegation_call_id: Set(None),
                        message_count: Set(0),
                        created_at: Set(now),
                        updated_at: Set(now),
                        deleted_at: Set(None),
                        pinned_at: Set(None),
                        origin_cwd: Set(None),
                    };
                    let inserted = sibling.insert(txn).await?;
                    Ok(inserted.id)
                })
            })
            .await
            .map_err(|e| AcpError::protocol(e.to_string()))
    }

    pub async fn disconnect(&self, conn_id: &str) -> Result<(), AcpError> {
        let removed = {
            // The map lock is held ACROSS the handoff into `draining`, and
            // readers take it in the same order, so an observer can never see
            // the connection in neither place.
            let mut connections = self.connections.lock().await;
            let removed = connections.remove(conn_id);
            if let Some(conn) = &removed {
                self.park_draining(conn).await;
            }
            removed
        };
        if let Some(conn) = removed {
            tracing::info!("[ACP] disconnect connection={}", conn_id);
            let _ = conn.cmd_tx.send(ConnectionCommand::Disconnect).await;
            Ok(())
        } else {
            Err(AcpError::ConnectionNotFound(conn_id.into()))
        }
    }

    /// Remember a connection's child until it is provably finished. Call while
    /// holding the connections lock, immediately after removing the entry.
    async fn park_draining(&self, conn: &AgentConnection) {
        let mut draining = self.draining.lock().await;
        prune_reaped(&mut draining);
        draining.push(DrainingChild {
            agent: conn.agent_type,
            pid: conn.child_pid.clone(),
            parked_at: std::time::Instant::now(),
        });
    }

    /// Every agent that could still be writing to its own files: connected or
    /// prompting, plus any whose connection is gone but whose process is not.
    ///
    /// Taken under the connections lock so the `disconnect` handoff into
    /// `draining` is atomic from here — otherwise a restore could look between
    /// the two and conclude nothing is running.
    pub async fn live_or_draining_agent_names(&self) -> Vec<String> {
        let connections = self.connections.lock().await;
        let mut names: Vec<String> = connections
            .values()
            .filter(|c| {
                matches!(
                    c.status,
                    ConnectionStatus::Connecting
                        | ConnectionStatus::Connected
                        | ConnectionStatus::Prompting
                )
            })
            .map(|c| c.agent_type.to_string())
            .collect();
        let mut draining = self.draining.lock().await;
        prune_reaped(&mut draining);
        names.extend(draining.iter().map(|c| c.agent.to_string()));
        names.sort();
        names.dedup();
        names
    }

    /// Probe an agent for the modes / config_options it advertises on a fresh
    /// session, then immediately disconnect. The probe runs with
    /// `EventEmitter::Noop` so no event reaches the desktop webview, the
    /// global `WebEventBroadcaster`, or the `InternalEventBus` — the events
    /// land only in this probe connection's own (unsubscribed) per-connection
    /// stream and in its `SessionState` (which is the read source here).
    ///
    /// Used by the delegation-settings UI to enumerate the options the user
    /// can override, with the guarantee that what the UI shows is exactly
    /// what `codeg-mcp` will pass through to `session/set_config_option`
    /// when a delegation actually fires.
    ///
    /// Returns `Ok(snapshot)` even when the agent advertises no options
    /// (empty `config_options`, `None` modes) — that's a valid outcome the
    /// UI can render as "this agent has nothing to configure."
    pub async fn probe_agent_options(
        &self,
        agent_type: AgentType,
        working_dir: Option<String>,
        runtime_env: BTreeMap<String, String>,
    ) -> Result<AgentOptionsSnapshot, AcpError> {
        // Owner window label is informational only (used for
        // disconnect_by_owner_window), but worth being explicit so a probe
        // connection that somehow leaks past the disconnect below is easy to
        // identify in logs / debug snapshots.
        let owner_window = "delegation-probe".to_string();
        // Serialize concurrent probes for the same agent_type. Rapid tab
        // switching in the settings UI would otherwise fan out one real
        // CLI process per click — each one running up to 60s. The mutex
        // bounds this to one in-flight probe per agent type; different
        // agent_types still probe in parallel.
        //
        // The outer `probe_locks` guard MUST be dropped BEFORE the
        // `.lock_owned().await` on the per-agent mutex. If we held it
        // across the await, a probe queued behind another for the SAME
        // agent_type would keep the outer map locked, blocking probes
        // for every OTHER agent_type too — silently turning the
        // per-agent serialization into a global one.
        let per_agent_lock: Arc<tokio::sync::Mutex<()>> = {
            let mut locks = self.probe_locks.lock().await;
            locks
                .entry(agent_type)
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
                .clone()
        };
        let _probe_guard = per_agent_lock.lock_owned().await;
        let conn_id = self
            .spawn_agent(
                agent_type,
                working_dir,
                None, // brand-new session — no resume
                runtime_env,
                owner_window,
                EventEmitter::Noop,
                None,
                BTreeMap::new(),
            )
            .await?;

        // Hold an `Arc<RwLock<SessionState>>` alongside the manager's own
        // entry so the state survives even if the connection task cleans
        // up its map slot mid-handshake. Without this, an agent that
        // errors during Initialize would trigger cleanup before the
        // probe's poll loop sees the `AcpEvent::Error` payload, and
        // `wait_for_session_options` would surface the unhelpful
        // `ConnectionNotFound` instead of the agent's own error text.
        let state_arc = self.get_state(&conn_id).await;

        // Generous timeout because some agents (Gemini in particular) take
        // 8-10s just to answer Initialize before session/new can even start;
        // a tight cap here would consistently return an empty snapshot and
        // make the settings UI claim those agents have nothing to configure.
        // Matches the per-step Initialize timeout in `connection.rs`.
        let probe_timeout = Duration::from_secs(60);
        let raw_snapshot = self.wait_for_session_options(&conn_id, probe_timeout).await;

        // If the wait errored, prefer the agent's own captured error
        // message over the generic ProbeTimedOut / ConnectionNotFound —
        // an agent that died on Initialize already explained why.
        let snapshot = match raw_snapshot {
            Ok(s) => Ok(s),
            Err(wait_err) => {
                let captured = if let Some(state) = state_arc.as_ref() {
                    state.read().await.last_error.clone()
                } else {
                    None
                };
                Err(match captured {
                    Some(err) => AcpError::protocol(err.message),
                    None => wait_err,
                })
            }
        };

        // Always disconnect — including on Err — so a failed probe doesn't
        // leak an agent process. Ignore disconnect errors (best-effort
        // cleanup; the agent will exit when its stdio is dropped anyway).
        let _ = self.disconnect(&conn_id).await;
        snapshot
    }

    /// Poll a connection's `SessionState` until the agent signals it has
    /// finished publishing its initial selectors (`SelectorsReady`), then
    /// give a small grace window for any tightly-following follow-up updates
    /// before snapshotting. Waiting on `selectors_ready` — not just
    /// `config_options.is_some()` — matters because some agents emit an
    /// empty `SessionConfigOptions` first and then push the real options
    /// in a subsequent update; returning on the first `Some(vec![])` would
    /// race ahead of those updates and report the agent as having nothing
    /// to configure.
    ///
    /// The `SessionConfigOptions` / `SelectorsReady` ACP events populate
    /// `SessionState` via `apply_event` regardless of which `EventEmitter`
    /// variant the connection uses — that's why the probe can rely on
    /// `Noop` and still observe the values here.
    ///
    /// Returns `AcpError::ProbeTimedOut` when the timeout elapses without
    /// `selectors_ready` ever flipping to `true`. Distinguishing that case
    /// from a clean "ready with no options" snapshot lets the UI tell the
    /// user "the agent never published its options — retry" instead of
    /// silently claiming the agent has nothing to configure.
    async fn wait_for_session_options(
        &self,
        conn_id: &str,
        timeout: Duration,
    ) -> Result<AgentOptionsSnapshot, AcpError> {
        let start = std::time::Instant::now();
        let poll_interval = Duration::from_millis(50);
        // Grace window between `selectors_ready` flipping true and the
        // snapshot we return. Lets a stragging `ConfigOptionUpdate` that
        // an agent emits in the same tick land before we read.
        let grace_period = Duration::from_millis(500);
        let mut selectors_ready_at: Option<std::time::Instant> = None;
        loop {
            let (
                config_options,
                modes,
                available_commands,
                prompt_capabilities,
                selectors_ready,
            ) = {
                let conns = self.connections.lock().await;
                let conn = conns
                    .get(conn_id)
                    .ok_or_else(|| AcpError::ConnectionNotFound(conn_id.into()))?;
                let s = conn.state.read().await;
                (
                    s.config_options.clone(),
                    s.modes.clone(),
                    s.available_commands.clone(),
                    s.prompt_capabilities.clone(),
                    s.selectors_ready,
                )
            };
            if selectors_ready {
                let ready_at = *selectors_ready_at.get_or_insert_with(std::time::Instant::now);
                if ready_at.elapsed() >= grace_period {
                    // Commands ride along from the same probe session (the grace
                    // window lets a late `available_commands` land before we read).
                    return Ok(AgentOptionsSnapshot {
                        modes,
                        config_options: config_options.unwrap_or_default(),
                        available_commands,
                        prompt_capabilities,
                    });
                }
            }
            if start.elapsed() >= timeout {
                return Err(AcpError::ProbeTimedOut);
            }
            tokio::time::sleep(poll_interval).await;
        }
    }

    pub async fn disconnect_by_owner_window(&self, owner_window_label: &str) -> usize {
        let cmd_txs = {
            let mut connections = self.connections.lock().await;
            let ids: Vec<String> = connections
                .iter()
                .filter_map(|(id, conn)| {
                    if conn.owner_window_label == owner_window_label {
                        Some(id.clone())
                    } else {
                        None
                    }
                })
                .collect();

            let mut txs = Vec::with_capacity(ids.len());
            for id in ids {
                if let Some(conn) = connections.remove(&id) {
                    // Same handoff as `disconnect`: closing a window leaves
                    // the agents exiting, not exited.
                    self.park_draining(&conn).await;
                    txs.push(conn.cmd_tx);
                }
            }
            txs
        };

        let disconnected = cmd_txs.len();
        for cmd_tx in cmd_txs {
            let _ = cmd_tx.send(ConnectionCommand::Disconnect).await;
        }
        tracing::info!(
            "[ACP] disconnect by owner window owner_window={} count={}",
            owner_window_label, disconnected
        );
        disconnected
    }

    /// End every live connection running `agent_type` and report how many there
    /// were, not returning until this agent's processes — the ones just ended
    /// AND any it already had exiting — have been put past running, as far as
    /// the OS lets that be established ([`kill_tree_and_wait`] is precise about
    /// where that stops).
    ///
    /// Added for the Antigravity sign-out, and the reason is the shape of that
    /// agent's credential store rather than anything about connections. An
    /// Antigravity process caches its OAuth credentials in memory and writes
    /// them back to the keychain (or token file) on every silent refresh,
    /// behind a lock that is per-PROCESS. So a connection still running while
    /// the credential is cleared will, at its next token expiry, helpfully
    /// restore the account the user just signed out of — or overwrite the one
    /// they signed in as afterwards.
    ///
    /// That is why this borrows [`Self::disconnect_all`]'s shape rather than
    /// [`Self::disconnect_by_owner_window`]'s, despite reading like the latter.
    /// The caller needs "those processes are gone", not "those processes were
    /// asked to go", and it differs from the shutdown backstop in the two ways
    /// that follow from exactly that:
    ///
    /// - It sweeps the `draining` list, not just the map. A connection an
    ///   earlier `disconnect` (or a closed window) already removed is invisible
    ///   in the map while its process is still exiting — and that process holds
    ///   the same in-memory credential. Only `draining` knows about it, and
    ///   nothing else would ever kill it.
    /// - It waits for each process to be past acting, escalating to `SIGKILL`;
    ///   see [`kill_tree_and_wait`] for what that does and does not establish.
    ///   `kill_tree` on its own returns as soon as `SIGTERM` is delivered, and
    ///   `SIGTERM` can be caught or ignored, so its return says nothing about
    ///   whether the agent is still there to write the credential back.
    ///
    /// Everything `disconnect_all` says about `try_send`, about sleeping the
    /// WHOLE grace window, and about loading each pid only afterwards applies
    /// verbatim. In particular the pid must not be read early: a connection
    /// still `Connecting` reads zero now and publishes a live pid moments later,
    /// and that is exactly the child that would go on to rewrite the credential.
    ///
    /// The return value counts the LIVE connections ended, not the processes
    /// swept — a drainer was disconnected by whoever parked it, and counting it
    /// again here would report a teardown that did not happen. A pid the sweep
    /// could not settle is logged, not raised. On unix that means `kill(2)`
    /// answered something other than `ESRCH` — in practice `EPERM`, i.e. that
    /// pid is not ours to signal, which points at a recycled number rather than
    /// a surviving agent, though it does not prove either. Weighed against
    /// refusing to return on it, which would strand the sign-out in exactly the
    /// dead end it exists to undo: the agent restoring a credential costs the
    /// user another press of the button, and never signing out costs them the
    /// account.
    ///
    /// Callers that need no new connection to appear behind them must hold
    /// [`Self::lock_out_new_connections`] BEFORE calling, as `disconnect_all`'s
    /// shutdown caller does by construction.
    pub async fn disconnect_by_agent_type(&self, agent_type: AgentType) -> usize {
        let cmd_txs: Vec<tokio::sync::mpsc::Sender<ConnectionCommand>> = {
            let mut connections = self.connections.lock().await;
            let ids: Vec<String> = connections
                .iter()
                .filter(|(_, conn)| conn.agent_type == agent_type)
                .map(|(id, _)| id.clone())
                .collect();

            let mut txs = Vec::with_capacity(ids.len());
            for id in ids {
                if let Some(conn) = connections.remove(&id) {
                    // Same handoff as every other teardown: the entry goes
                    // immediately, so the child is parked as draining to stay
                    // visible while it exits — and, here, to be swept below.
                    self.park_draining(&conn).await;
                    txs.push(conn.cmd_tx);
                }
            }
            txs
        };

        let disconnected = cmd_txs.len();
        for cmd_tx in &cmd_txs {
            let _ = cmd_tx.try_send(ConnectionCommand::Disconnect);
        }
        tracing::info!(
            "[ACP] disconnect by agent type agent={:?} count={}",
            agent_type, disconnected
        );

        // Every child that could still be running as this agent: the ones just
        // parked above AND the ones an earlier teardown left draining. Cells,
        // not pids — each pid is loaded at the last possible moment, inside the
        // sweep.
        let pid_cells: Vec<Arc<std::sync::atomic::AtomicU32>> = {
            let mut draining = self.draining.lock().await;
            prune_reaped(&mut draining);
            draining
                .iter()
                .filter(|c| c.agent == agent_type)
                .map(|c| c.pid.clone())
                .collect()
        };
        if pid_cells.is_empty() {
            return disconnected;
        }

        tokio::time::sleep(DISCONNECT_ALL_GRACE).await;

        match tokio::task::spawn_blocking(move || {
            pid_cells
                .iter()
                .filter(|cell| !kill_tree_and_wait(cell))
                .count()
        })
        .await
        {
            Ok(0) => {}
            Ok(unconfirmed) => tracing::warn!(
                "[ACP] disconnect by agent type agent={:?}: {} process(es) could not be confirmed gone",
                agent_type, unconfirmed
            ),
            // Only reachable if the sweep panicked or the runtime is shutting
            // down under it. Nothing to retry against — but it must not pass
            // silently for "everything was confirmed".
            Err(e) => tracing::warn!(
                "[ACP] disconnect by agent type agent={:?}: sweep did not finish: {e}",
                agent_type
            ),
        }

        disconnected
    }

    /// Disconnect every connection, then hard-kill any surviving agent process
    /// trees as a shutdown backstop.
    ///
    /// The graceful path (send `Disconnect` → the connection driver thread
    /// breaks its command loop → `run_connection` unwinds →
    /// `acp::agent_process`'s `ChildGuard::drop` runs `kill_tree`) is enough on its own
    /// *when it gets to run*. It doesn't at process exit: `run_connection` is
    /// driven on a dedicated `std::thread` (see `spawn_agent`), and when Tauri's
    /// `ExitRequested` handler returns the process terminates those threads
    /// mid-flight — often before the driver reaches `ChildGuard::drop` — so the
    /// agent CLI (and its own children, e.g. MCP servers / a forked `node`) is
    /// reparented and lingers until it independently notices its stdin EOF
    /// (~30s for Claude Code / node).
    ///
    /// So: fire every `Disconnect`, give the graceful path a short grace window,
    /// then synchronously `kill_tree` whatever is still running.
    ///
    /// What the window actually buys is NOT a gentler death for the agent — the
    /// graceful path ends in the same `kill_tree` — it is time for the driver
    /// thread's own post-loop cleanup (delegation-token revoke, `cancel_by_parent`
    /// for delegations / questions / plan approvals), which at quit previously
    /// got no time at all.
    ///
    /// Each pid is read from its live cell as late as possible — after the
    /// window, inside the kill loop — never from an up-front snapshot. That is
    /// load-bearing in both directions:
    /// - A connection whose process was reaped during the window has already
    ///   had its cell zeroed by the `on_exit` callback, so the backstop skips it
    ///   instead of `kill_tree`-ing a pid the OS may have recycled onto an
    ///   unrelated process tree. A connection that merely *ended* keeps its pid
    ///   and still gets swept — `ChildGuard::drop` signals without waiting, so
    ///   "the driver returned" is not "the agent is gone".
    /// - A connection whose child spawned *after* quit began (still `Connecting`
    ///   when the map was drained) publishes its pid into the same cell, so the
    ///   backstop still reaches it — an up-front snapshot would read `0` and
    ///   leak exactly the orphan this exists to kill.
    ///
    /// Only pids this manager spawned (and their descendants) are touched;
    /// `child_pid == 0` (never spawned, already finished, or a test/viewer entry
    /// that owns no process) is skipped.
    pub async fn disconnect_all(&self) -> usize {
        let handles: Vec<(
            tokio::sync::mpsc::Sender<ConnectionCommand>,
            Arc<std::sync::atomic::AtomicU32>,
        )> = {
            let mut connections = self.connections.lock().await;
            connections
                .drain()
                .map(|(_, conn)| (conn.cmd_tx, conn.child_pid))
                .collect()
        };
        let disconnected = handles.len();
        // `try_send`, not `send().await`: this is the shutdown path, and the
        // backstop below is only reachable if every send returns. A connection
        // whose command queue is full (32 deep) would otherwise park the whole
        // quit here — precisely the wedged connection whose tree most needs
        // killing. A dropped `Disconnect` just means that connection skips the
        // graceful path and gets hard-killed instead.
        for (cmd_tx, _) in &handles {
            let _ = cmd_tx.try_send(ConnectionCommand::Disconnect);
        }
        tracing::info!("[ACP] disconnect_all count={}", disconnected);

        if disconnected == 0 {
            return 0;
        }

        // Grace window: let the drivers unwind and run their own cleanup.
        tokio::time::sleep(DISCONNECT_ALL_GRACE).await;

        // Backstop: hard-kill whatever is still running. Runs on a blocking
        // thread so the synchronous `kill_tree` doesn't stall the async runtime
        // while a `block_on(disconnect_all())` shutdown caller waits on it.
        let pid_cells: Vec<Arc<std::sync::atomic::AtomicU32>> =
            handles.into_iter().map(|(_, pid)| pid).collect();
        let _ = tokio::task::spawn_blocking(move || {
            for cell in pid_cells {
                // Load here, not before the window — see the doc comment.
                let pid = cell.load(std::sync::atomic::Ordering::SeqCst);
                if pid == 0 {
                    continue;
                }
                match kill_tree::blocking::kill_tree(pid) {
                    Ok(_) => {
                        tracing::info!(
                            "[ACP] disconnect_all backstop killed process tree pid={pid}"
                        );
                    }
                    Err(e) => {
                        // The process can still exit between the load and the
                        // kill; that error is expected, not a failure.
                        tracing::debug!("[ACP] disconnect_all backstop kill_tree pid={pid}: {e}");
                    }
                }
            }
        })
        .await;

        disconnected
    }

    /// Block new connections from being established until the returned guard
    /// is dropped. The caller must enumerate live connections only AFTER
    /// holding this, never before.
    pub async fn lock_out_new_connections(
        &self,
    ) -> tokio::sync::OwnedRwLockWriteGuard<()> {
        self.external_restore_lock.clone().write_owned().await
    }

    pub async fn list_connections(&self) -> Vec<ConnectionInfo> {
        let connections = self.connections.lock().await;
        connections.values().map(|c| c.info()).collect()
    }

    /// Raw per-connection rows for the pet panel's active-session list.
    /// "Active" = the connection is currently `Prompting`, awaiting a
    /// permission, or in an `Error` state — the sessions a user would want to
    /// see or act on from the floating pet. Idle `Connected` sessions are
    /// excluded to keep the list focused (mirrors the Codex pet "signal"
    /// model).
    ///
    /// `title` is left empty here: this layer has no DB handle. The command
    /// layer (`pet_list_active_sessions_core`) fills it from the conversation
    /// row. Connections without both a bound `conversation_id` and `folder_id`
    /// are skipped — the panel needs both to render a row and to navigate to
    /// it. Lock discipline mirrors `find_connection_by_conversation_id`: hold
    /// the connections mutex while taking each per-session read lock (the
    /// reads are microseconds and released each iteration).
    pub async fn list_active_sessions(&self) -> Vec<crate::models::pet::PetSessionEntry> {
        let connections = self.connections.lock().await;
        let mut out = Vec::new();
        for (id, conn) in connections.iter() {
            let state = conn.state.read().await;
            let (Some(conversation_id), Some(folder_id)) =
                (state.conversation_id, state.folder_id)
            else {
                continue;
            };
            let pending = state
                .pending_permission
                .as_ref()
                .map(crate::models::pet::PetPermissionSummary::from);
            let is_active = pending.is_some()
                || matches!(
                    state.status,
                    ConnectionStatus::Prompting | ConnectionStatus::Error
                );
            if !is_active {
                continue;
            }
            out.push(crate::models::pet::PetSessionEntry {
                connection_id: id.clone(),
                conversation_id,
                folder_id,
                agent_type: state.agent_type,
                title: String::new(),
                status: state.status.clone(),
                pending,
                // Same reason as `title`: resolving a delegation child's parent
                // needs the DB. Filled by `pet_list_active_sessions_core`.
                parent: None,
            });
        }
        out
    }

    /// Clone the `Arc<RwLock<SessionState>>` for a given connection id so the
    /// caller can read/write state without holding the connections mutex.
    /// Returns `None` if no such connection is registered.
    pub async fn get_state(
        &self,
        conn_id: &str,
    ) -> Option<std::sync::Arc<tokio::sync::RwLock<crate::acp::SessionState>>> {
        let connections = self.connections.lock().await;
        connections.get(conn_id).map(|conn| conn.state.clone())
    }

    /// Like `get_state`, but also clones the connection's `EventEmitter`.
    /// Used by the lifecycle subscriber when it needs to both update the
    /// per-session state and re-broadcast a derived event (e.g. emitting
    /// `ConversationStatusChanged` after writing the row's status).
    /// One short lock on the connections map; both pieces are cheap to clone.
    pub async fn get_state_and_emitter(
        &self,
        conn_id: &str,
    ) -> Option<(
        std::sync::Arc<tokio::sync::RwLock<crate::acp::SessionState>>,
        EventEmitter,
    )> {
        let connections = self.connections.lock().await;
        connections
            .get(conn_id)
            .map(|conn| (conn.state.clone(), conn.emitter.clone()))
    }

    /// Wait (bounded) for the connected agent to say what a prompt may carry.
    ///
    /// `spawn_agent` returns as soon as the process is up and registered: it
    /// only holds for `SessionStarted` when deduplicating a RESUME, so a fresh
    /// session's `initialize` — which is what publishes these capabilities
    /// (`emit_prompt_capabilities`) — is still in flight when it returns. A
    /// caller that must know the encoding before its first prompt therefore has
    /// to ask, rather than read the state and find `None`.
    ///
    /// `None` means the wait ran out or the connection went away; callers treat
    /// that as "no information" and send what they already had, never as an
    /// error — the prompt itself is about to surface any real problem.
    pub async fn wait_for_prompt_capabilities(
        &self,
        conn_id: &str,
        timeout: Duration,
    ) -> Option<PromptCapabilitiesInfo> {
        let state = {
            let connections = self.connections.lock().await;
            connections.get(conn_id)?.state.clone()
        };
        let start = std::time::Instant::now();
        loop {
            {
                let s = state.read().await;
                if let Some(caps) = s.prompt_capabilities.clone() {
                    return Some(caps);
                }
                // A connection that already died will never advertise anything.
                if matches!(
                    s.status,
                    ConnectionStatus::Disconnected | ConnectionStatus::Error
                ) {
                    return None;
                }
            }
            if start.elapsed() >= timeout {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// Append a live-feedback note to a connection's session and broadcast it.
    ///
    /// Validation: the text is trimmed and rejected when empty
    /// ([`AcpError::InvalidFeedback`]) or longer than [`MAX_FEEDBACK_CHARS`] —
    /// the full text rides in the broadcast event, the snapshot, and the MCP
    /// response, so a sanity bound keeps one pathological note from bloating
    /// them. (There is deliberately no per-turn COUNT cap: the set is cleared
    /// every turn, so its size scales with human typing, not unboundedly.)
    ///
    /// Rejected with [`AcpError::NoActiveTurn`] unless a turn is in flight —
    /// feedback is mid-turn steering, pulled by the agent via the
    /// `check_user_feedback` MCP tool; with no active turn there is nothing to
    /// steer and the note would strand (the frontend falls back to an ordinary
    /// prompt). The append rides `emit_with_state` so `SessionState.feedback`,
    /// the ring buffer, and every attached client stay in lockstep.
    /// `blocks`, when present, is the full prompt-block draft (text plus
    /// image attachments) to deliver on the native wire instead of the bare
    /// `text` — `text` then serves as the recorded note. Only the native
    /// channel can carry blocks; see the pull-path gate below.
    pub async fn submit_feedback(
        &self,
        conn_id: &str,
        text: String,
        blocks: Option<Vec<PromptInputBlock>>,
    ) -> Result<FeedbackItem, AcpError> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Err(AcpError::InvalidFeedback("empty note".into()));
        }
        if trimmed.chars().count() > MAX_FEEDBACK_CHARS {
            return Err(AcpError::InvalidFeedback(format!(
                "note exceeds {MAX_FEEDBACK_CHARS} characters"
            )));
        }
        let text = trimmed.to_string();
        let blocks = blocks.filter(|b| !b.is_empty());
        let (state, cmd_tx, emitter) = {
            let connections = self.connections.lock().await;
            let conn = connections
                .get(conn_id)
                .ok_or_else(|| AcpError::ConnectionNotFound(conn_id.to_string()))?;
            (
                conn.state.clone(),
                conn.cmd_tx.clone(),
                conn.emitter.clone(),
            )
        };
        // Channel-aware eligibility: a note is deliverable natively (the
        // `_session/steering` push, synthesized at initialize) or through the
        // `check_user_feedback` pull tool. Reject only when NEITHER channel
        // exists — e.g. a session launched before the feature was enabled (no
        // tool) on an adapter without proven native steering.
        // `native_steering_available` is re-read on every call so a
        // `startedNewTurn` downgrade mid-session silently reroutes later
        // notes to the pull path.
        let (native, tool_available) = {
            let s = state.read().await;
            (s.native_steering_available, s.feedback_tool_available)
        };
        if !native && !tool_available {
            return Err(AcpError::FeedbackDisabled);
        }

        if native {
            return Self::submit_feedback_native(conn_id, state, cmd_tx, emitter, text, blocks)
                .await;
        }

        // The pull tool delivers plain text (`PendingFeedback`), so a draft
        // carrying attachment blocks cannot ride it without silently dropping
        // them. Two ways to get here: an ordinary pull session (the composer
        // offers its mid-turn send on every session with a delivery channel,
        // so a codex/grok/gemini draft with an image lands right here), or a
        // native session that downgraded between the frontend's channel read
        // and this call (startedNewTurn latch). `NoActiveTurn` is the
        // rejection the caller already maps to its queue fallback, which
        // re-routes the WHOLE draft — attachments included — as the next
        // turn's prompt.
        if blocks.is_some() {
            return Err(AcpError::NoActiveTurn);
        }

        let item = FeedbackItem::new_pending(
            uuid::Uuid::new_v4().to_string(),
            text,
            chrono::Utc::now(),
        );
        // Gate on `turn_in_flight` and append in ONE critical section (via the
        // gated emit): a `TurnComplete` (flips the flag) or `UserMessage`
        // (clears `feedback`) can't slip between the gate and the append+seq, so
        // a note is never stranded on a finished turn nor re-added to a new one.
        let applied = emit_with_state_gated(
            &state,
            &emitter,
            AcpEvent::FeedbackSubmitted { item: item.clone() },
            |s| s.turn_in_flight,
        )
        .await;
        if !applied {
            return Err(AcpError::NoActiveTurn);
        }
        Ok(item)
    }

    /// Native `_session/steering` delivery — the push half of
    /// [`Self::submit_feedback`], cancellation-shielded.
    ///
    /// SHIELD (fork_session's pattern): once `ConnectionCommand::Steer` is
    /// enqueued, the connection loop performs the injection REGARDLESS of
    /// whether this caller survives. An HTTP caller disconnecting mid-await
    /// must not leave "injected but unrecorded" state — no `FeedbackItem`, no
    /// broadcast, absent from reconnect snapshots — so enqueue → outcome →
    /// record → emit runs in a DETACHED task and the caller merely awaits the
    /// JoinHandle to relay the result to a still-live client.
    ///
    /// Invariants (asserted by tests):
    /// * NO DOUBLE DELIVERY. A natively-injected note is `Delivered` from
    ///   birth, and `read_pending_feedback` only returns `Pending` — so even
    ///   with the `check_user_feedback` tool still injected (it is, by
    ///   design), a pull can never hand the agent the same text again.
    /// * UNGATED EMIT. The pull path's `emit_with_state_gated(turn_in_flight)`
    ///   is exactly wrong here: the adapter's `injected` reply is the
    ///   authoritative fact the content reached the turn. Gating on a
    ///   just-settled turn would misreport `NoActiveTurn`, and the caller
    ///   would resubmit the same text as a prompt → duplicate. A delivered
    ///   note recorded right after `TurnComplete` is harmless — the notes
    ///   list renders only while prompting, and the next turn's `UserMessage`
    ///   clears `feedback`.
    /// * `created_at` PRECEDES THE INJECTION. It is taken before the `Steer`
    ///   command is enqueued, so it is earlier than any transcript entry the
    ///   injection can cause. The frontend relies on that ordering to tell the
    ///   agent's own copy of the message from the same words sent in an
    ///   earlier round (`suppressPersistedSteeredPrompts`).
    async fn submit_feedback_native(
        conn_id: &str,
        state: Arc<tokio::sync::RwLock<crate::acp::session_state::SessionState>>,
        cmd_tx: tokio::sync::mpsc::Sender<ConnectionCommand>,
        emitter: EventEmitter,
        text: String,
        blocks: Option<Vec<PromptInputBlock>>,
    ) -> Result<FeedbackItem, AcpError> {
        // Cheap pre-flight, NOT the authoritative check (that's the loop's
        // idle arm replying `NoActiveTurn`): skip the round-trip when no turn
        // is in flight at all. The counter read alongside it identifies WHICH
        // turn this steer was admitted against — see the re-check below.
        let admitted_turns_completed = {
            let s = state.read().await;
            if !s.turn_in_flight {
                return Err(AcpError::NoActiveTurn);
            }
            s.turns_completed
        };
        // The wire payload: the caller's full draft when it carried blocks
        // (attachments included), else the recorded text as a single block —
        // byte-identical to the historical text-only steer. Uploaded-image
        // markers (web / remote mode) are re-hydrated exactly like a prompt's,
        // AFTER the admission checks above so a rejected steer never triggers
        // file reads, and BEFORE the shield below so a failure aborts with no
        // side effects.
        // Whether the caller sent a real draft rather than bare text. Read
        // BEFORE `blocks` is consumed below, and the sole gate on recording a
        // block list at all: a text-only steer must keep producing exactly the
        // note it always produced.
        let had_blocks = blocks.is_some();
        let wire_blocks = match blocks {
            Some(mut blocks) => {
                crate::acp::prompt_hydration::hydrate_prompt_blocks(
                    &mut blocks,
                    &crate::paths::codeg_uploads_root(),
                )
                .await?;
                // Hydration is the ONLY await this path puts between admission
                // and the enqueue, and it runs for as long as reading the
                // uploads takes. The loop's idle arm already covers "the turn
                // ended" (it replies `NoActiveTurn`), but it cannot cover "the
                // NEXT turn started in the meantime": the loop would then be
                // in its active arm and inject the note into a turn the user
                // never aimed at, recorded `Delivered` while the composer
                // clears. Re-check the admitted turn's identity so that case
                // takes the caller's queue fallback instead — which re-routes
                // the whole draft, attachment included.
                let changed = {
                    let s = state.read().await;
                    steered_turn_changed(
                        admitted_turns_completed,
                        s.turn_in_flight,
                        s.turns_completed,
                    )
                };
                if changed {
                    return Err(AcpError::NoActiveTurn);
                }
                blocks
            }
            None => vec![PromptInputBlock::Text { text: text.clone() }],
        };
        // Project what the user sent for the broadcast, AFTER hydration and
        // from the same bytes the agent gets — the contract an ordinary prompt
        // already follows (`user_blocks_from_prompt` at the `UserMessage`
        // emit). Without it the note reaches the live transcript as `text`
        // alone, which is the composer's DISPLAY form: a steered image would
        // render as words about an image until a reload replaced it with the
        // agent's own copy.
        //
        // `None` for a text-only steer, so that path's note is unchanged and
        // the frontend keeps rendering it from `text`.
        //
        // Filtered on the ATTACHMENT bytes rather than on `blocks.is_some()`: a
        // draft that projects down to text alone says nothing `text` does not
        // already say, and recording a list for it would put one on a note the
        // field's contract calls text-only.
        //
        // No budget check here on purpose — the per-turn attachment bound lives
        // at the single authorized writer (`SessionState::apply_event`'s
        // `FeedbackSubmitted` arm), where the check and the append share one
        // critical section. Enforcing it here would be a read, an agent
        // round-trip, then a write: concurrent steers would both read the same
        // total and both pass it.
        let record_blocks = had_blocks
            .then(|| crate::acp::user_blocks_from_prompt(&wire_blocks))
            .filter(|projected| crate::acp::feedback::attachment_bytes(projected) > 0);
        let conn_id_for_task = conn_id.to_string();
        let handle = tokio::spawn(async move {
            let outcome: Result<FeedbackItem, AcpError> = async {
                // Stamped BEFORE the command goes out, so the note's instant is
                // causally earlier than anything the injection can cause. The
                // adapter pushes the text to the agent before it answers, and
                // the agent may write its own transcript copy of the message
                // while this task is still awaiting that answer — a note
                // stamped on the way back would then look NEWER than the copy
                // it produced, and the frontend (which folds a persisted copy
                // away only when it postdates the injection — see
                // `suppressPersistedSteeredPrompts`) would show the message
                // twice. Same clock, same host: `created_at` is when the note
                // was created, which is also what the pull path records.
                let created_at = chrono::Utc::now();
                let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
                cmd_tx
                    .send(ConnectionCommand::Steer {
                        blocks: wire_blocks,
                        reply: reply_tx,
                    })
                    .await
                    .map_err(|_| AcpError::ProcessExited)?;
                let steer = reply_rx.await.map_err(|_| {
                    AcpError::protocol("Steer reply channel closed".to_string())
                })??;
                match steer {
                    // Honored opt-in: the content was NOT consumed and is
                    // still host-owned. Surface the frontend's existing
                    // turn-end fallback (resubmit as a normal prompt).
                    SteerOutcome::PromptRequired => return Err(AcpError::NoActiveTurn),
                    SteerOutcome::Injected => {}
                    SteerOutcome::StartedNewTurn => {
                        // The adapter ignored the opt-in and detached a turn
                        // (stale binary lying about its version?). The content
                        // IS consumed — record it delivered, NEVER resend —
                        // but this adapter can't be trusted with the idle race
                        // again: downgrade to the MCP pull channel for the
                        // rest of the session.
                        tracing::warn!(
                            "[ACP][feedback] _session/steering returned startedNewTurn \
                             (conn={conn_id_for_task}); downgrading native steering for \
                             this session"
                        );
                        state.write().await.native_steering_available = false;
                    }
                }
                let item = FeedbackItem::new_delivered(
                    uuid::Uuid::new_v4().to_string(),
                    text,
                    created_at,
                    record_blocks,
                );
                // Ungated on purpose — see the invariant on this fn's doc.
                emit_with_state(
                    &state,
                    &emitter,
                    AcpEvent::FeedbackSubmitted { item: item.clone() },
                )
                .await;
                Ok(item)
            }
            .await;
            // Surface real failures even when the caller is gone (the
            // detached task's Result would otherwise drop silently).
            // `NoActiveTurn` is an expected reroute, not a failure.
            if let Err(ref e) = outcome {
                if !matches!(e, AcpError::NoActiveTurn) {
                    tracing::error!(
                        "[ACP][ERROR] native feedback submit failed (conn={conn_id_for_task}): {e}"
                    );
                }
            }
            outcome
        });
        match handle.await {
            Ok(result) => result,
            Err(join_err) => Err(AcpError::protocol(format!(
                "steer task did not complete: {join_err}"
            ))),
        }
    }

    /// Read the pending feedback for a connection WITHOUT marking it delivered.
    /// Returns an immediate snapshot. Read-only — backs the READ half of the
    /// `check_user_feedback` round-trip so the listener can commit delivery only
    /// after the response is actually written (a dropped / failed write leaves
    /// the notes pending for the agent's next check).
    pub async fn read_pending_feedback(&self, conn_id: &str) -> Vec<PendingFeedback> {
        let Some(state) = self.get_state(conn_id).await else {
            return Vec::new();
        };
        let pending: Vec<PendingFeedback> = {
            let s = state.read().await;
            s.feedback
                .iter()
                .filter(|f| f.status == FeedbackStatus::Pending)
                .map(|f| PendingFeedback {
                    id: f.id.clone(),
                    text: f.text.clone(),
                    created_at: f.created_at,
                })
                .collect()
        };
        bounded_feedback_batch(pending, MAX_FEEDBACK_RESPONSE_BYTES)
    }

    /// Mark the named notes `Delivered` and broadcast the consumption. Called by
    /// the listener ONLY after the `check_user_feedback` response was written to
    /// the companion, so a dropped / failed write leaves the notes pending and
    /// the agent's next check re-delivers them (at-least-once).
    ///
    /// Delivery boundary: "delivered" means the response reached the agent's MCP
    /// companion over the UDS. The one remaining hop (companion → agent stdout)
    /// can only fail when the agent process is gone/closing — i.e. the turn is
    /// being torn down, at which point the note is moot (the agent won't act on
    /// it). A mid-wait cancel is already handled upstream by the listener's
    /// peer-close race (no commit), and a cancel after the round-trip completes
    /// cannot suppress the response (the companion's inflight entry is already
    /// consumed). So this is the right boundary for a best-effort steering
    /// side-channel; an end-to-end ack would only cover the moot teardown tail.
    ///
    /// The mark happens under a single write lock; only notes still `Pending`
    /// flip (idempotent — a repeated commit, or a note already consumed by a
    /// racing call, is skipped) and only the ids actually flipped are emitted,
    /// so a double-commit can't double-broadcast.
    pub async fn commit_feedback_delivered(&self, conn_id: &str, ids: Vec<String>) {
        if ids.is_empty() {
            return;
        }
        let Some((state, emitter)) = self.get_state_and_emitter(conn_id).await else {
            return;
        };
        let id_set: std::collections::HashSet<&String> = ids.iter().collect();
        let delivered_at = chrono::Utc::now();
        let marked: Vec<String> = {
            let mut s = state.write().await;
            let mut marked = Vec::new();
            for f in s.feedback.iter_mut() {
                if f.status == FeedbackStatus::Pending && id_set.contains(&f.id) {
                    f.status = FeedbackStatus::Delivered;
                    f.delivered_at = Some(delivered_at);
                    marked.push(f.id.clone());
                }
            }
            marked
        };
        if !marked.is_empty() {
            emit_with_state(
                &state,
                &emitter,
                AcpEvent::FeedbackConsumed {
                    ids: marked,
                    delivered_at,
                },
            )
            .await;
        }
    }

    /// Register a blocking `ask_user_question` on a connection: park a one-shot
    /// in `pending_questions` keyed by a fresh `question_id`, broadcast the
    /// `QuestionRequest` (so every attached client renders the interactive card
    /// and a mid-turn attach recovers it from the snapshot), and hand the
    /// receiver back to the listener to await. `None` when the connection is
    /// gone (nothing to ask) OR when this connection already has a pending ask
    /// — see below.
    ///
    /// One pending ask per connection: `SessionState.pending_question` and the
    /// frontend card are single slots, so a second concurrent ask would
    /// overwrite the first's card/snapshot and orphan the first (still-parked)
    /// tool call with no way to answer it. A single agent is blocked in its
    /// `ask_user_question` call and cannot issue a second, so this only guards a
    /// parallel / misbehaving MCP client; the refused second call resolves as
    /// `declined` (the listener's None path) so its agent proceeds with its own
    /// judgment instead of hanging. The check + insert are atomic under the
    /// registry lock.
    pub async fn register_question(
        &self,
        conn_id: &str,
        questions: Vec<QuestionSpec>,
    ) -> Option<RegisteredQuestion> {
        // Defense-in-depth: the companion validates, but the broker socket is
        // only token-gated, so refuse to broadcast malformed/oversized specs
        // (None → the listener declines the ask, as for any other None path).
        if crate::acp::question::validate_specs(&questions).is_err() {
            return None;
        }
        let (state, emitter) = self.get_state_and_emitter(conn_id).await?;
        let question_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = tokio::sync::oneshot::channel();
        {
            let mut reg = self.pending_questions.lock().await;
            if reg.values().any(|e| e.parent_connection_id == conn_id) {
                return None;
            }
            reg.insert(
                question_id.clone(),
                PendingQuestionEntry {
                    parent_connection_id: conn_id.to_string(),
                    questions: questions.clone(),
                    sender: tx,
                },
            );
        }
        // Ungated emit: the agent is blocked in the tool call, so the card must
        // show regardless of any turn-flag timing.
        emit_with_state(
            &state,
            &emitter,
            AcpEvent::QuestionRequest {
                question_id: question_id.clone(),
                questions,
            },
        )
        .await;
        // Teardown event-ordering race: `cancel_questions_by_parent` may have
        // drained this entry between the insert above and the emit just now. The
        // QuestionRequest we broadcast would then have no waiter, and the sweep's
        // QuestionResolved may have raced ahead of it — leaving a card up with no
        // live backend waiter. Emit a compensating QuestionResolved (ordered after
        // our QuestionRequest) and decline. (The listener's post-register token
        // re-check covers the complementary case: a register that lands entirely
        // after the sweep, which this presence check would not catch.)
        if self
            .compensate_if_question_drained(&question_id, &state, &emitter)
            .await
        {
            return None;
        }
        Some(RegisteredQuestion {
            question_id,
            answer_rx: rx,
        })
    }

    /// Returns `true` — after emitting a clearing `QuestionResolved` — when
    /// `question_id` is no longer pending, i.e. a teardown sweep drained it in the
    /// window after its `QuestionRequest` was broadcast. The compensating event is
    /// ordered after the request so no client keeps a card with no live backend
    /// waiter. Returns `false` (no emit) while the entry is still parked.
    async fn compensate_if_question_drained(
        &self,
        question_id: &str,
        state: &std::sync::Arc<tokio::sync::RwLock<crate::acp::SessionState>>,
        emitter: &EventEmitter,
    ) -> bool {
        if self.pending_questions.lock().await.contains_key(question_id) {
            return false;
        }
        emit_with_state(
            state,
            emitter,
            AcpEvent::QuestionResolved {
                question_id: question_id.to_string(),
            },
        )
        .await;
        true
    }

    /// Resolve a pending `ask_user_question` with the user's submission (from any
    /// client). Removes the one-shot atomically (first answer wins; a duplicate /
    /// already-resolved id is an idempotent no-op), sends the self-describing
    /// outcome to the blocked listener, and broadcasts `QuestionResolved` so the
    /// card clears on every client. Routing uses the entry's stored parent
    /// connection (the `question_id` is the authoritative key), so a stale
    /// `conn_id` from the caller can't misroute.
    pub async fn answer_question(
        &self,
        conn_id: &str,
        question_id: &str,
        answer: QuestionAnswer,
    ) -> Result<(), AcpError> {
        let _ = conn_id;
        let entry = self.pending_questions.lock().await.remove(question_id);
        let Some(entry) = entry else {
            // Already answered / canceled / gone elsewhere — idempotent success.
            return Ok(());
        };
        let outcome = build_outcome(&entry.questions, &answer);
        // Ignore a dropped receiver: the listener may have abandoned the wait
        // (peer-close) at the same instant; the resolved-event below still clears
        // the card.
        let _ = entry.sender.send(outcome);
        if let Some((state, emitter)) = self.get_state_and_emitter(&entry.parent_connection_id).await
        {
            emit_with_state(
                &state,
                &emitter,
                AcpEvent::QuestionResolved {
                    question_id: question_id.to_string(),
                },
            )
            .await;
        }
        Ok(())
    }

    /// Cancel a pending `ask_user_question` — the companion's tool call was
    /// canceled (peer-close) or the connection is tearing down. Removes the
    /// one-shot (dropping the sender unblocks the listener with a declined
    /// outcome) and broadcasts `QuestionResolved` so the card clears. No-op if
    /// the question was already answered / gone.
    pub async fn cancel_question(&self, conn_id: &str, question_id: &str) {
        let _ = conn_id;
        let removed = self.pending_questions.lock().await.remove(question_id);
        let Some(entry) = removed else {
            return;
        };
        if let Some((state, emitter)) = self.get_state_and_emitter(&entry.parent_connection_id).await
        {
            emit_with_state(
                &state,
                &emitter,
                AcpEvent::QuestionResolved {
                    question_id: question_id.to_string(),
                },
            )
            .await;
        }
    }

    /// Cancel every pending `ask_user_question` parked on a connection that is
    /// tearing down. The `run_connection` cleanup guard calls this (alongside
    /// the delegation `DelegationBroker::cancel_by_parent` cascade) so question
    /// entries — and the listener tasks parked on them — are reclaimed
    /// synchronously on disconnect, instead of lingering until the companion's
    /// ask socket happens to close. Dropping each entry's sender unblocks its
    /// listener with a declined outcome; the `QuestionResolved` broadcast clears
    /// the card on every client. No-op when nothing is pending for this parent.
    pub async fn cancel_questions_by_parent(&self, conn_id: &str) {
        // Remove every entry for this parent under the lock (dropping their
        // senders unblocks the parked listeners), then emit outside the lock —
        // the registry mutex is never held across an await.
        let drained: Vec<String> = {
            let mut reg = self.pending_questions.lock().await;
            let ids: Vec<String> = reg
                .iter()
                .filter(|(_, e)| e.parent_connection_id == conn_id)
                .map(|(id, _)| id.clone())
                .collect();
            for id in &ids {
                reg.remove(id);
            }
            ids
        };
        if drained.is_empty() {
            return;
        }
        // Best-effort card clear: depending on the teardown path the connection
        // may already be out of the map (`disconnect` removes it before the
        // run_connection cleanup guard fires this sweep), so tolerate `None` — the
        // core removal above already ran and the frontend clears on disconnect.
        if let Some((state, emitter)) = self.get_state_and_emitter(conn_id).await {
            for question_id in drained {
                emit_with_state(&state, &emitter, AcpEvent::QuestionResolved { question_id }).await;
            }
        }
    }

    /// Register a pending Grok `exit_plan_mode` approval on `conn_id`, broadcast
    /// `PlanApprovalRequest` (so every attached client renders the card and a
    /// mid-turn attach recovers it from the snapshot), and return the receiver
    /// the connection's ext handler awaits. `None` when the connection is gone
    /// (nothing to approve) OR when one is already pending on it (the agent is
    /// blocked in a single `exit_plan_mode` call; a second would orphan the
    /// first). Mirrors [`Self::register_question`].
    pub async fn register_plan_approval(
        &self,
        conn_id: &str,
        tool_call_id: String,
        plan_markdown: String,
    ) -> Option<RegisteredPlanApproval> {
        let (state, emitter) = self.get_state_and_emitter(conn_id).await?;
        let approval_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = tokio::sync::oneshot::channel();
        {
            let mut reg = self.pending_plan_approvals.lock().await;
            if reg.values().any(|e| e.parent_connection_id == conn_id) {
                return None;
            }
            reg.insert(
                approval_id.clone(),
                PendingPlanApprovalEntry {
                    parent_connection_id: conn_id.to_string(),
                    sender: tx,
                },
            );
        }
        // Ungated emit: the agent is blocked in the tool call, so the card must
        // show regardless of any turn-flag timing.
        emit_with_state(
            &state,
            &emitter,
            AcpEvent::PlanApprovalRequest {
                approval_id: approval_id.clone(),
                tool_call_id,
                plan_markdown,
            },
        )
        .await;
        // Teardown event-ordering race (mirrors `register_question`): the
        // cleanup guard's `cancel_plan_approvals_by_parent` may have drained this
        // entry between the insert above and the emit just now — its
        // `PlanApprovalResolved` could then have raced ahead of our
        // `PlanApprovalRequest`, leaving a card up with no live backend waiter.
        // Emit a compensating `PlanApprovalResolved` (ordered after our request)
        // and decline.
        if self
            .compensate_if_plan_approval_drained(&approval_id, &state, &emitter)
            .await
        {
            return None;
        }
        Some(RegisteredPlanApproval {
            approval_id,
            answer_rx: rx,
        })
    }

    /// Returns `true` — after emitting a clearing `PlanApprovalResolved` — when
    /// `approval_id` is no longer pending, i.e. a teardown sweep drained it in the
    /// window after its `PlanApprovalRequest` was broadcast. Mirrors
    /// [`Self::compensate_if_question_drained`].
    async fn compensate_if_plan_approval_drained(
        &self,
        approval_id: &str,
        state: &std::sync::Arc<tokio::sync::RwLock<crate::acp::SessionState>>,
        emitter: &EventEmitter,
    ) -> bool {
        if self.pending_plan_approvals.lock().await.contains_key(approval_id) {
            return false;
        }
        emit_with_state(
            state,
            emitter,
            AcpEvent::PlanApprovalResolved {
                approval_id: approval_id.to_string(),
            },
        )
        .await;
        true
    }

    /// Resolve a pending plan approval with the user's decision (from any
    /// client). Removes the one-shot atomically (first answer wins; a duplicate /
    /// already-resolved id is an idempotent no-op), sends the decision to the
    /// blocked ext handler, and broadcasts `PlanApprovalResolved` so the card
    /// clears on every client. Routing uses the entry's stored parent connection
    /// (the `approval_id` is the authoritative key), so a stale `conn_id` from the
    /// caller can't misroute. Mirrors [`Self::answer_question`].
    pub async fn answer_plan_approval(
        &self,
        conn_id: &str,
        approval_id: &str,
        answer: PlanApprovalAnswer,
    ) -> Result<(), AcpError> {
        let _ = conn_id;
        let entry = self.pending_plan_approvals.lock().await.remove(approval_id);
        let Some(entry) = entry else {
            // Already answered / canceled / gone elsewhere — idempotent success.
            return Ok(());
        };
        // Ignore a dropped receiver: the handler may have abandoned the wait
        // (teardown) at the same instant; the resolved event below still clears
        // the card.
        let _ = entry.sender.send(answer);
        if let Some((state, emitter)) =
            self.get_state_and_emitter(&entry.parent_connection_id).await
        {
            emit_with_state(
                &state,
                &emitter,
                AcpEvent::PlanApprovalResolved {
                    approval_id: approval_id.to_string(),
                },
            )
            .await;
        }
        Ok(())
    }

    /// Cancel every pending plan approval parked on a connection that is tearing
    /// down (the `run_connection` cleanup guard calls this). Dropping each
    /// entry's sender resolves the handler's await as a disconnect (Grok keeps
    /// plan mode active, re-surfaces on reconnect); the `PlanApprovalResolved`
    /// broadcast clears the card. Mirrors [`Self::cancel_questions_by_parent`].
    pub async fn cancel_plan_approvals_by_parent(&self, conn_id: &str) {
        let drained: Vec<String> = {
            let mut reg = self.pending_plan_approvals.lock().await;
            let ids: Vec<String> = reg
                .iter()
                .filter(|(_, e)| e.parent_connection_id == conn_id)
                .map(|(id, _)| id.clone())
                .collect();
            for id in &ids {
                reg.remove(id);
            }
            ids
        };
        if drained.is_empty() {
            return;
        }
        // Best-effort card clear: the connection may already be out of the map
        // (disconnect removes it before this sweep), so tolerate `None`.
        if let Some((state, emitter)) = self.get_state_and_emitter(conn_id).await {
            for approval_id in drained {
                emit_with_state(&state, &emitter, AcpEvent::PlanApprovalResolved { approval_id })
                    .await;
            }
        }
    }

    /// Resolve a conversation_id to its currently-active connection id, if any.
    /// Used by the by-conversation snapshot endpoint and the LifecycleSubscriber.
    /// Per-session state is acquired via `read().await` to avoid the
    /// `try_read`-skip false negative that would intermittently return None
    /// while `emit_with_state` is mid-update — the wait is microseconds.
    pub async fn find_connection_by_conversation_id(&self, conversation_id: i32) -> Option<String> {
        let connections = self.connections.lock().await;
        for (id, conn) in connections.iter() {
            let state = conn.state.read().await;
            if state.conversation_id == Some(conversation_id) {
                return Some(id.clone());
            }
        }
        None
    }

    /// The in-flight user prompt for `conversation_id` and the instant its turn
    /// started, if a turn is currently running on its live connection. `Some`
    /// exactly between `UserMessage` and `TurnComplete` (see
    /// `SessionState.pending_user_message` / `pending_user_message_started_at`);
    /// `None` when no connection is bound to the conversation or no turn is in
    /// flight.
    ///
    /// Used by the detail endpoint to stamp the persisted in-flight user turn
    /// with the broadcast `message_id`, so a cross-client viewer's synthesized
    /// turn (keyed by that same id) dedups against it instead of rendering a
    /// second copy. The start instant lets the matcher tell the in-flight prompt
    /// apart from a prior identical one. One lock pass over the connections map,
    /// mirroring `find_connection_by_conversation_id`.
    pub async fn pending_user_message_for_conversation(
        &self,
        conversation_id: i32,
    ) -> Option<(
        crate::acp::session_state::PendingUserMessage,
        Option<chrono::DateTime<chrono::Utc>>,
    )> {
        let connections = self.connections.lock().await;
        for conn in connections.values() {
            let state = conn.state.read().await;
            if state.conversation_id == Some(conversation_id) {
                return state
                    .pending_user_message
                    .clone()
                    .map(|pending| (pending, state.pending_user_message_started_at));
            }
        }
        None
    }

    /// Resolve an `(external_id, agent_type)` (agent session) to its
    /// currently-active connection id, if any. Sibling to
    /// `find_connection_by_conversation_id`, used as the discovery fallback for
    /// the cross-client viewer attach: a connection binds its `conversation_id`
    /// only on the first prompt, but its `external_id` is set as soon as the
    /// session starts — so for a historical conversation opened by a second
    /// client *before* anyone has sent a prompt, the by-conversation lookup
    /// misses while this one still finds the live owner, letting the second
    /// client attach as a viewer instead of reusing the connection as a
    /// (mis-tagged) owner and later tearing it down.
    ///
    /// `agent_type` is part of the match because `external_id` is unique only
    /// per agent (`UNIQUE(external_id, agent_type)`), not globally — without it,
    /// a session id shared across two agents could attach a viewer to the wrong
    /// agent's connection.
    pub async fn find_connection_by_external_id(
        &self,
        external_id: &str,
        agent_type: AgentType,
    ) -> Option<String> {
        let connections = self.connections.lock().await;
        for (id, conn) in connections.iter() {
            if conn.agent_type != agent_type {
                continue;
            }
            let state = conn.state.read().await;
            if state.external_id.as_deref() == Some(external_id) {
                return Some(id.clone());
            }
        }
        None
    }
}

/// Production impl of `ConnectionSpawner` used by `DelegationBroker`.
///
/// Bundles `Arc<ConnectionManager>` with `Arc<AppDatabase>` because
/// `cancel` writes the cancelled status onto the conversation row, which
/// happens inside `ConnectionManager::cancel`. The wrapper exists so the
/// broker can depend on a small `dyn`-able interface instead of pulling
/// in the full `AppState` graph.
///
/// `data_dir` is required so `spawn` can build a runtime env that
/// includes the git credential helper — without it, delegated subagents
/// fail any git command that depends on the codeg-injected helper.
#[derive(Clone)]
pub struct ConnectionManagerSpawner {
    pub manager: Arc<ConnectionManager>,
    pub db: Arc<AppDatabase>,
    pub data_dir: Arc<PathBuf>,
}

#[async_trait::async_trait]
impl crate::acp::delegation::spawner::ConnectionSpawner for ConnectionManagerSpawner {
    async fn spawn(
        &self,
        parent_connection_id: &str,
        agent_type: AgentType,
        working_dir: Option<String>,
        preferred_mode_id: Option<String>,
        preferred_config_values: BTreeMap<String, String>,
    ) -> Result<String, crate::acp::delegation::spawner::SpawnerError> {
        use crate::acp::delegation::spawner::SpawnerError;
        // Resolve the parent connection so we can inherit its emitter and
        // owner_window. Falling back is not safe: a child whose emitter is
        // wired to a different broadcaster would emit events the frontend
        // never sees.
        let (emitter, owner_window, parent_working_dir) = {
            let conns = self.manager.connections.lock().await;
            let parent = conns.get(parent_connection_id).ok_or_else(|| {
                SpawnerError::Spawn(format!(
                    "parent connection {parent_connection_id} not found"
                ))
            })?;
            let pwd = {
                let s = parent.state.read().await;
                s.working_dir
                    .as_ref()
                    .map(|p| p.to_string_lossy().to_string())
            };
            (
                parent.emitter.clone(),
                parent.owner_window_label.clone(),
                pwd,
            )
        };
        let effective_working_dir = working_dir.or(parent_working_dir);

        // Build the same runtime env `acp_connect` would build for a
        // user-initiated session — disabled check, settings overrides,
        // model provider creds, git helper. Without this, delegated
        // subagents would skip the user's configuration entirely.
        let runtime_env = crate::commands::acp::build_session_runtime_env(
            &self.db,
            agent_type,
            None,
            self.data_dir.as_path(),
        )
        .await
        .map_err(|e| SpawnerError::Spawn(e.to_string()))?;

        self.manager
            .spawn_agent(
                agent_type,
                effective_working_dir,
                None,
                runtime_env,
                owner_window,
                emitter,
                preferred_mode_id,
                preferred_config_values,
            )
            .await
            .map_err(|e| SpawnerError::Spawn(e.to_string()))
    }

    async fn send_prompt_linked_for_delegation(
        &self,
        conn_id: &str,
        task: String,
        link: crate::acp::delegation::spawner::DelegationLink,
    ) -> Result<i32, crate::acp::delegation::spawner::SpawnerError> {
        use crate::acp::delegation::spawner::SpawnerError;
        // The child has no caller-supplied conversation_id (it's brand new).
        // folder_id must be None too — the manager's create-new-row branch
        // requires folder_id, which we resolve from the child's working_dir
        // via folder_service. Do that lookup here so the trait stays small.
        let working_dir_pathbuf = {
            let conns = self.manager.connections.lock().await;
            let conn = conns
                .get(conn_id)
                .ok_or_else(|| SpawnerError::Send(format!("child {conn_id} not found")))?;
            let s = conn.state.read().await;
            s.working_dir.clone()
        };
        let folder_path = working_dir_pathbuf
            .ok_or_else(|| {
                SpawnerError::Send(
                    "child connection has no working_dir; cannot derive folder_id".into(),
                )
            })?
            .to_string_lossy()
            .to_string();
        // `ensure_folder_for_path`, NOT `add_folder`: the row exists to carry the
        // child's `folder_id` and to resolve its cwd on resume, and neither of
        // those reads `is_open`. Opening it would turn whatever `working_dir` the
        // agent picked — a PR checkout under /tmp, a throwaway worktree — into a
        // top-level project in the user's sidebar, and would silently reopen a
        // folder the user had closed.
        let folder =
            crate::db::service::folder_service::ensure_folder_for_path(&self.db.conn, &folder_path)
                .await
                .map_err(|e| SpawnerError::Send(format!("ensure_folder_for_path: {e}")))?;

        let result = self
            .manager
            .send_prompt_linked(
                &self.db,
                conn_id,
                vec![PromptInputBlock::Text { text: task }],
                Some(folder.id),
                None,
                Some(link),
            )
            .await
            .map_err(|e| SpawnerError::Send(e.to_string()))?;
        result.ok_or_else(|| {
            SpawnerError::Send(
                "send_prompt_linked succeeded but no conversation_id was bound".into(),
            )
        })
    }

    async fn spawn_for_resume(
        &self,
        parent_connection_id: &str,
        agent_type: AgentType,
        working_dir: Option<String>,
        external_session_id: &str,
        preferred_mode_id: Option<String>,
        preferred_config_values: BTreeMap<String, String>,
    ) -> Result<crate::acp::delegation::spawner::ResumedSpawn, crate::acp::delegation::spawner::SpawnerError>
    {
        use crate::acp::delegation::spawner::{ResumedSpawn, SpawnerError};
        // Same parent inheritance as `spawn` — a resumed child whose emitter is
        // wired to a different broadcaster would stream to nobody.
        let (emitter, owner_window, parent_working_dir) = {
            let conns = self.manager.connections.lock().await;
            let parent = conns.get(parent_connection_id).ok_or_else(|| {
                SpawnerError::Spawn(format!(
                    "parent connection {parent_connection_id} not found"
                ))
            })?;
            let pwd = {
                let s = parent.state.read().await;
                s.working_dir
                    .as_ref()
                    .map(|p| p.to_string_lossy().to_string())
            };
            (
                parent.emitter.clone(),
                parent.owner_window_label.clone(),
                pwd,
            )
        };
        let effective_working_dir = working_dir.or(parent_working_dir);

        let runtime_env = crate::commands::acp::build_session_runtime_env(
            &self.db,
            agent_type,
            None,
            self.data_dir.as_path(),
        )
        .await
        .map_err(|e| SpawnerError::Spawn(e.to_string()))?;

        // Detect dedup reuse BEFORE spawning, with the SAME lookup
        // `spawn_agent` runs at its own entry: a live connection for this
        // (agent, working_dir, session_id) — e.g. the user has the canceled
        // child session open in a tab — makes `spawn_agent` return that
        // connection instead of creating one. The broker must know, because
        // its failure teardown may only disconnect a connection this call
        // actually created. A connection appearing in the pre-check→spawn
        // window is missed, but that window is milliseconds and a misfire
        // additionally requires the send itself to fail.
        let working_dir_path = effective_working_dir.as_ref().map(std::path::PathBuf::from);
        let pre_existing = self
            .manager
            .find_connection_for_reuse(
                agent_type,
                working_dir_path.as_ref(),
                Some(external_session_id),
            )
            .await;

        // `session_id = Some(..)` is the whole difference vs `spawn`: the
        // connection loads the child's prior agent session (and its context)
        // instead of minting a fresh one.
        let connection_id = self
            .manager
            .spawn_agent(
                agent_type,
                effective_working_dir,
                Some(external_session_id.to_string()),
                runtime_env,
                owner_window,
                emitter,
                preferred_mode_id,
                preferred_config_values,
            )
            .await
            .map_err(|e| SpawnerError::Spawn(e.to_string()))?;
        let reused = pre_existing.as_deref() == Some(connection_id.as_str());
        Ok(ResumedSpawn {
            connection_id,
            reused,
        })
    }

    async fn send_resume_prompt(
        &self,
        conn_id: &str,
        prompt: String,
        folder_id: i32,
        child_conversation_id: i32,
    ) -> Result<(), crate::acp::delegation::spawner::SpawnerError> {
        use crate::acp::delegation::spawner::SpawnerError;
        // Adopt the child's EXISTING row (caller-supplied path) — no delegation
        // link: the row already carries parent_id / parent_tool_use_id /
        // delegation_call_id from the original delegation, and
        // `send_prompt_linked` rejects a link combined with an explicit
        // conversation_id precisely because adopted rows own their linkage.
        self.manager
            .send_prompt_linked(
                &self.db,
                conn_id,
                vec![PromptInputBlock::Text { text: prompt }],
                Some(folder_id),
                Some(child_conversation_id),
                None,
            )
            .await
            .map(|_| ())
            .map_err(|e| SpawnerError::Send(e.to_string()))
    }

    async fn has_live_connection_for_conversation(&self, conversation_id: i32) -> bool {
        self.manager
            .find_connection_by_conversation_id(conversation_id)
            .await
            .is_some()
    }

    async fn cancel(
        &self,
        conn_id: &str,
    ) -> Result<(), crate::acp::delegation::spawner::SpawnerError> {
        self.manager
            .cancel(&self.db.conn, conn_id)
            .await
            .map_err(|e| crate::acp::delegation::spawner::SpawnerError::Cancel(e.to_string()))
    }

    async fn disconnect(
        &self,
        conn_id: &str,
    ) -> Result<(), crate::acp::delegation::spawner::SpawnerError> {
        self.manager
            .disconnect(conn_id)
            .await
            .map_err(|e| crate::acp::delegation::spawner::SpawnerError::Disconnect(e.to_string()))
    }
}

/// Production impl of `ParentSessionLookup` for the delegation listener.
/// Resolves the parent's current `conversation_id` by reading its
/// `SessionState`. Bundled with `ConnectionManagerSpawner` here so the
/// concrete wiring lives next to the manager it depends on.
#[derive(Clone)]
pub struct ConnectionManagerParentLookup {
    pub manager: Arc<ConnectionManager>,
}

#[async_trait::async_trait]
impl crate::acp::delegation::listener::ParentSessionLookup for ConnectionManagerParentLookup {
    async fn current_conversation_id(&self, parent_connection_id: &str) -> Option<i32> {
        let state = self.manager.get_state(parent_connection_id).await?;
        let snapshot = state.read().await;
        snapshot.conversation_id
    }
}

/// Production impl of `SessionFeedbackAccess` for the delegation listener's
/// `check_user_feedback` arm. Resolves the parent connection's pending feedback
/// by delegating to `ConnectionManager::read_pending_feedback` /
/// `commit_feedback_delivered`. Mirrors
/// `ConnectionManagerParentLookup` so the listener stays unit-testable with an
/// in-memory stub.
#[derive(Clone)]
pub struct ConnectionManagerFeedbackLookup {
    pub manager: Arc<ConnectionManager>,
}

#[async_trait::async_trait]
impl SessionFeedbackAccess for ConnectionManagerFeedbackLookup {
    async fn read_pending_feedback(
        &self,
        parent_connection_id: &str,
    ) -> Vec<PendingFeedback> {
        self.manager
            .read_pending_feedback(parent_connection_id)
            .await
    }

    async fn commit_feedback_delivered(&self, parent_connection_id: &str, ids: Vec<String>) {
        self.manager
            .commit_feedback_delivered(parent_connection_id, ids)
            .await
    }
}

/// Production impl of `SessionQuestionAccess` for the delegation listener's
/// `ask_user_question` arm. Registers / cancels the parent connection's pending
/// question by delegating to `ConnectionManager`. Mirrors
/// `ConnectionManagerFeedbackLookup` so the listener stays unit-testable with an
/// in-memory stub.
#[derive(Clone)]
pub struct ConnectionManagerQuestionLookup {
    pub manager: Arc<ConnectionManager>,
}

#[async_trait::async_trait]
impl SessionQuestionAccess for ConnectionManagerQuestionLookup {
    async fn register_question(
        &self,
        parent_connection_id: &str,
        questions: Vec<QuestionSpec>,
    ) -> Option<RegisteredQuestion> {
        self.manager
            .register_question(parent_connection_id, questions)
            .await
    }

    async fn cancel_question(&self, parent_connection_id: &str, question_id: &str) {
        self.manager
            .cancel_question(parent_connection_id, question_id)
            .await
    }

    async fn cancel_questions_by_parent(&self, parent_connection_id: &str) {
        self.manager
            .cancel_questions_by_parent(parent_connection_id)
            .await
    }
}

/// Production impl of [`SessionPlanApprovalAccess`] for the Grok `exit_plan_mode`
/// ext bridge. Registers / cancels the parent connection's pending plan approval
/// by delegating to `ConnectionManager`. Mirrors `ConnectionManagerQuestionLookup`
/// so the connection handler stays unit-testable with an in-memory stub.
#[derive(Clone)]
pub struct ConnectionManagerPlanApprovalLookup {
    pub manager: Arc<ConnectionManager>,
}

#[async_trait::async_trait]
impl SessionPlanApprovalAccess for ConnectionManagerPlanApprovalLookup {
    async fn register_plan_approval(
        &self,
        parent_connection_id: &str,
        tool_call_id: String,
        plan_markdown: String,
    ) -> Option<RegisteredPlanApproval> {
        self.manager
            .register_plan_approval(parent_connection_id, tool_call_id, plan_markdown)
            .await
    }

    async fn cancel_plan_approvals_by_parent(&self, parent_connection_id: &str) {
        self.manager
            .cancel_plan_approvals_by_parent(parent_connection_id)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::connection::AgentConnection;

    /// An agent that has left the connection map but not yet exited can still
    /// be appending to the transcript a restore is about to unlink, so the
    /// gate has to see it. `disconnect` drops the map entry immediately, which
    /// is why the pid is parked separately rather than the entry being kept.
    #[tokio::test]
    async fn disconnect_keeps_a_live_child_visible_after_the_map_entry_is_gone() {
        use std::sync::atomic::Ordering::SeqCst;
        let mgr = ConnectionManager::new();
        mgr.insert_test_connection("c1", AgentType::ClaudeCode, None, EventEmitter::Noop)
            .await;
        let pid = {
            let conns = mgr.connections.lock().await;
            conns.get("c1").unwrap().child_pid.clone()
        };
        pid.store(4242, SeqCst); // spawned

        mgr.disconnect("c1").await.unwrap();
        assert!(
            mgr.list_connections().await.is_empty(),
            "the map entry goes immediately — that is the whole problem"
        );
        assert_eq!(
            mgr.live_or_draining_agent_names().await,
            vec!["Claude Code".to_string()]
        );
    }

    /// Closing a window tears down its agents the same way, and leaves them
    /// exiting rather than exited.
    #[tokio::test]
    async fn closing_a_window_also_keeps_its_children_visible() {
        use std::sync::atomic::Ordering::SeqCst;
        let mgr = ConnectionManager::new();
        mgr.insert_test_connection("c1", AgentType::Codex, None, EventEmitter::Noop)
            .await;
        {
            let conns = mgr.connections.lock().await;
            conns.get("c1").unwrap().child_pid.store(777, SeqCst);
        }
        assert_eq!(mgr.disconnect_by_owner_window("test-window").await, 1);
        assert_eq!(
            mgr.live_or_draining_agent_names().await,
            vec!["Codex CLI".to_string()]
        );
    }

    /// The Antigravity sign-out ends that agent's connections and nobody
    /// else's. Precision is the point: their processes would write the cleared
    /// credential back on their next refresh, while an unrelated agent's
    /// session has nothing to do with it and must survive.
    #[tokio::test]
    async fn disconnecting_one_agent_type_leaves_the_others_running() {
        let mgr = ConnectionManager::new();
        mgr.insert_test_connection("agy1", AgentType::Antigravity, None, EventEmitter::Noop)
            .await;
        mgr.insert_test_connection("agy2", AgentType::Antigravity, None, EventEmitter::Noop)
            .await;
        mgr.insert_test_connection("cdx", AgentType::Codex, None, EventEmitter::Noop)
            .await;

        assert_eq!(
            mgr.disconnect_by_agent_type(AgentType::Antigravity).await,
            2
        );
        let left: Vec<String> = mgr
            .list_connections()
            .await
            .into_iter()
            .map(|c| c.id)
            .collect();
        assert_eq!(left, vec!["cdx".to_string()]);

        // And they leave exiting, not exited — the same handoff every other
        // teardown makes, so the shutdown backstop can still reach them. They
        // are out of the map yet still named here, alongside the live Codex.
        assert_eq!(
            mgr.live_or_draining_agent_names().await,
            vec!["Codex CLI".to_string(), "Google Antigravity".to_string()]
        );

        // Nothing of that type left: a second pass is a no-op rather than an
        // error, which is what makes the sign-out safe to retry.
        assert_eq!(
            mgr.disconnect_by_agent_type(AgentType::Antigravity).await,
            0
        );
    }

    /// A pid of zero means BOTH "reaped" and "not spawned yet", so a
    /// connection torn down mid-spawn — which can publish a live pid moments
    /// later — must not be dismissed. It ages out instead.
    #[tokio::test]
    async fn a_child_that_has_not_published_a_pid_is_still_assumed_live() {
        let mgr = ConnectionManager::new();
        mgr.insert_test_connection("c1", AgentType::Codex, None, EventEmitter::Noop)
            .await;
        mgr.disconnect("c1").await.unwrap();
        assert_eq!(
            mgr.live_or_draining_agent_names().await,
            vec!["Codex CLI".to_string()],
            "within the grace window an unpublished pid counts as running"
        );

        // Backdate past the grace: now zero can only mean finished.
        {
            let mut draining = mgr.draining.lock().await;
            for child in draining.iter_mut() {
                child.parked_at = std::time::Instant::now() - DRAIN_GRACE * 2;
            }
        }
        assert!(mgr.live_or_draining_agent_names().await.is_empty());
        assert_eq!(
            mgr.draining.lock().await.len(),
            0,
            "reading prunes, so the list cannot grow without bound"
        );
    }

    /// `spawn_agent` takes the read side of `external_restore_lock` as its
    /// very first statement, so holding the write side is what makes a backup
    /// restore's "are any agents running?" check a real gate rather than a
    /// check-then-use with a multi-minute gap.
    #[tokio::test]
    async fn lock_out_new_connections_blocks_connection_establishment() {
        let mgr = ConnectionManager::new();
        let guard = mgr.lock_out_new_connections().await;
        assert!(
            mgr.external_restore_lock.try_read().is_err(),
            "no connection may be established while the lockout is held"
        );
        drop(guard);
        assert!(mgr.external_restore_lock.try_read().is_ok());
    }
    // Test-only: the budget itself is enforced at the append in
    // `SessionState::apply_event`, so nothing in this module's production code
    // names it — only the tests that pin the bound do.
    use crate::acp::feedback::MAX_FEEDBACK_ATTACHMENT_BYTES_PER_TURN;
    use crate::acp::session_state::SessionState;
    use crate::acp::types::ConnectionStatus;
    use crate::web::event_bridge::{EventEmitter, WebEvent, WebEventBroadcaster};
    use std::path::PathBuf;
    use std::sync::Arc;
    use tokio::sync::{broadcast, mpsc, RwLock};

    #[test]
    fn is_reserved_turn_id_matches_only_the_parser_namespace() {
        // Rejected: the parsers' `turn-<digits>` ids (an untrusted client id of
        // this shape would collide with a persisted transcript turn).
        assert!(is_reserved_turn_id("turn-0"));
        assert!(is_reserved_turn_id("turn-42"));
        // Accepted: anything else, including the real UI sender id shape and the
        // connection-scoped fallback shape.
        assert!(!is_reserved_turn_id("optimistic-9f3c1a2b"));
        assert!(!is_reserved_turn_id("user-conn-7"));
        assert!(!is_reserved_turn_id("turn-")); // no number
        assert!(!is_reserved_turn_id("turn-1a")); // not all digits
        assert!(!is_reserved_turn_id("turnabout-1"));
        assert!(!is_reserved_turn_id(""));
    }

    fn fake_connection(id: &str, conv_id: Option<i32>) -> AgentConnection {
        let (tx, _rx) = mpsc::channel(1);
        let mut state = SessionState::new(
            id.to_string(),
            crate::models::agent::AgentType::ClaudeCode,
            None,
            "test-window".to_string(),
            None,
        );
        state.conversation_id = conv_id;
        state.status = ConnectionStatus::Connected;
        AgentConnection {
            id: id.to_string(),
            agent_type: crate::models::agent::AgentType::ClaudeCode,
            status: ConnectionStatus::Connected,
            owner_window_label: "test-window".to_string(),
            cmd_tx: tx,
            state: Arc::new(RwLock::new(state)),
            emitter: EventEmitter::Noop,
            prompt_lock: Arc::new(tokio::sync::Mutex::new(())),
            config_fingerprint: String::new(),
            last_observed_fingerprint: String::new(),
            child_pid: Arc::new(std::sync::atomic::AtomicU32::new(0)),
        }
    }

    /// Spawn a two-level process tree: `sh` (the stand-in for the agent CLI)
    /// backgrounds a `sleep` grandchild (the stand-in for the agent's own
    /// children — an MCP server, a forked `node`) and records its pid. The
    /// grandchild is what the backstop assertions are about: it is the process
    /// that gets reparented and lingers when only the direct child is killed.
    ///
    /// Returns the direct child — keep it alive, dropping a `Child` does NOT
    /// kill it — and the grandchild pid.
    #[cfg(unix)]
    async fn spawn_process_tree(pidfile: &std::path::Path) -> (std::process::Child, i32) {
        let mut child = std::process::Command::new("sh")
            .arg("-c")
            .arg(format!("sleep 30 & echo $! > '{}'; wait", pidfile.display()))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn sh");
        for _ in 0..150 {
            if let Ok(raw) = std::fs::read_to_string(pidfile) {
                if let Ok(pid) = raw.trim().parse::<i32>() {
                    return (child, pid);
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        // Bail-out path still reaps the tree, so a failing test can't leave a
        // `sleep` behind for 30s.
        let _ = kill_tree::blocking::kill_tree(child.id());
        let _ = child.wait();
        panic!("grandchild never recorded its pid");
    }

    /// True once `pid` is gone. `kill(pid, 0)` sends no signal, it only probes
    /// existence; polling keeps the assertion from racing kernel teardown.
    #[cfg(unix)]
    async fn wait_until_dead(pid: i32) -> bool {
        for _ in 0..150 {
            // SAFETY: signal 0 only probes for existence; it sends no signal.
            if unsafe { libc::kill(pid, 0) } != 0 {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        false
    }

    #[cfg(unix)]
    fn is_alive(pid: i32) -> bool {
        // SAFETY: signal 0 only probes for existence; it sends no signal.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    /// Quit has to kill the agent's whole process TREE. Killing just the direct
    /// child leaves its children reparented and lingering — that orphan window
    /// is the entire reason the backstop exists.
    ///
    /// The test connection's command receiver is dropped, so the graceful path
    /// is unavailable and the kill can only come from the backstop.
    /// Unix-only (relies on `sh` / `kill(2)`).
    #[cfg(unix)]
    #[tokio::test]
    async fn disconnect_all_backstop_kills_the_whole_agent_process_tree() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (mut child, gpid) = spawn_process_tree(&dir.path().join("g.pid")).await;

        let mgr = ConnectionManager::new();
        let conn = fake_connection("conn-tree", None);
        conn.child_pid
            .store(child.id(), std::sync::atomic::Ordering::SeqCst);
        mgr.connections
            .lock()
            .await
            .insert("conn-tree".to_string(), conn);

        assert_eq!(mgr.disconnect_all().await, 1);
        assert!(
            wait_until_dead(gpid).await,
            "grandchild {gpid} survived — the quit backstop did not kill the tree"
        );
        let _ = child.wait();
    }

    /// A connection still `Connecting` when quit begins publishes its pid AFTER
    /// the map is drained. Reading the pids up front would see `0` there and
    /// skip it, leaking exactly the orphan this exists to kill — so the load
    /// has to happen after the grace window, from the live cell.
    #[cfg(unix)]
    #[tokio::test]
    async fn disconnect_all_backstop_reaches_a_child_that_spawns_during_the_grace_window() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (mut child, gpid) = spawn_process_tree(&dir.path().join("g.pid")).await;

        let mgr = ConnectionManager::new();
        let conn = fake_connection("conn-late", None);
        // Still 0 at drain time, exactly like a connection whose agent process
        // hasn't launched yet.
        let cell = Arc::clone(&conn.child_pid);
        mgr.connections
            .lock()
            .await
            .insert("conn-late".to_string(), conn);

        let pid = child.id();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            cell.store(pid, std::sync::atomic::Ordering::SeqCst);
        });

        assert_eq!(mgr.disconnect_all().await, 1);
        assert!(
            wait_until_dead(gpid).await,
            "grandchild {gpid} survived — a pid published during the grace window was missed"
        );
        let _ = child.wait();
    }

    /// The mirror image: once the agent process has been reaped, the `on_exit`
    /// callback zeroes the cell and the backstop must leave that pid alone.
    /// Without the clear, a quit fires `kill_tree` at a pid whose process is
    /// already dead and reaped — and if the OS recycled that number, the victim
    /// is an unrelated process tree.
    #[cfg(unix)]
    #[tokio::test]
    async fn disconnect_all_backstop_leaves_a_cleared_pid_alone() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (mut child, gpid) = spawn_process_tree(&dir.path().join("g.pid")).await;

        let mgr = ConnectionManager::new();
        let conn = fake_connection("conn-cleared", None);
        conn.child_pid
            .store(child.id(), std::sync::atomic::Ordering::SeqCst);
        let cell = Arc::clone(&conn.child_pid);
        mgr.connections
            .lock()
            .await
            .insert("conn-cleared".to_string(), conn);

        // Stands in for the driver unwinding mid-window: the process is gone
        // and the guard has zeroed the cell.
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            cell.store(0, std::sync::atomic::Ordering::SeqCst);
        });

        assert_eq!(mgr.disconnect_all().await, 1);
        // Settle: a wrongly-issued SIGTERM would have landed by now.
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(
            is_alive(gpid),
            "backstop killed a tree whose pid the driver had already cleared"
        );

        let _ = kill_tree::blocking::kill_tree(child.id());
        let _ = child.wait();
    }

    /// The Antigravity sign-out needs "no process of this agent is running",
    /// and a child an earlier `disconnect` left draining is exactly the one the
    /// map cannot see. It was asked to go — `disconnect` sends and returns —
    /// but nothing ever checked that it went, and while it lives it still holds
    /// the credential the sign-out is about to clear.
    ///
    /// The test connection's command receiver is dropped, so the graceful path
    /// is unavailable: this process can only die from the sweep.
    #[cfg(unix)]
    #[tokio::test]
    async fn disconnect_by_agent_type_sweeps_a_child_left_draining_by_an_earlier_teardown() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (mut child, gpid) = spawn_process_tree(&dir.path().join("g.pid")).await;

        let mgr = ConnectionManager::new();
        mgr.insert_test_connection("agy-old", AgentType::Antigravity, None, EventEmitter::Noop)
            .await;
        mgr.connections
            .lock()
            .await
            .get("agy-old")
            .unwrap()
            .child_pid
            .store(child.id(), std::sync::atomic::Ordering::SeqCst);

        // Out of the map, into `draining` — a closed tab, say.
        mgr.disconnect("agy-old").await.unwrap();
        assert!(mgr.list_connections().await.is_empty());

        // Nothing live to end, so nothing to report — but its process is still
        // there, and that is what has to be gone.
        assert_eq!(
            mgr.disconnect_by_agent_type(AgentType::Antigravity).await,
            0
        );
        assert!(
            wait_until_dead(gpid).await,
            "grandchild {gpid} survived — a draining child of the same agent was never swept"
        );
        let _ = child.wait();
    }

    /// `kill_tree` sends `SIGTERM` and returns; `SIGTERM` can be caught or
    /// ignored. So "the kill call returned" is not "the agent is gone", and the
    /// sign-out's whole premise is that it IS gone before the credential goes.
    /// A process that ignores `SIGTERM` must still end up dead, via `SIGKILL`.
    #[cfg(unix)]
    #[tokio::test]
    async fn disconnect_by_agent_type_escalates_to_sigkill_for_a_child_that_ignores_sigterm() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (mut child, gpid) = spawn_sigterm_proof_tree(&dir.path().join("g.pid")).await;

        let mgr = ConnectionManager::new();
        mgr.insert_test_connection("agy", AgentType::Antigravity, None, EventEmitter::Noop)
            .await;
        mgr.connections
            .lock()
            .await
            .get("agy")
            .unwrap()
            .child_pid
            .store(child.id(), std::sync::atomic::Ordering::SeqCst);

        assert_eq!(
            mgr.disconnect_by_agent_type(AgentType::Antigravity).await,
            1
        );

        // The target is this test's own child, so how it died is readable, and
        // signal 9 is the escalation: it ignores SIGTERM, so nothing softer did
        // this. `try_wait` rather than `wait` because it does not block — a
        // status from it means the process was dead by the time the sweep
        // returned, not merely that it died eventually. (Strictly it means
        // "dead a few microseconds after", which is as close to the ordering as
        // a caller outside the process can observe.)
        use std::os::unix::process::ExitStatusExt;
        let status = child
            .try_wait()
            .expect("read the target's status")
            .expect("target was still running when the sweep returned");
        assert_eq!(
            status.signal(),
            Some(libc::SIGKILL),
            "target survived SIGTERM and was never SIGKILLed"
        );
        assert!(
            wait_until_dead(gpid).await,
            "grandchild {gpid} survived — the escalation reached the target but not its tree"
        );
    }

    /// Like [`spawn_process_tree`], but both levels ignore `SIGTERM`: the shell
    /// sets it to `SIG_IGN`, which `sleep` then inherits across `exec`. Stands
    /// in for an agent that traps it and takes its time — or never leaves.
    #[cfg(unix)]
    async fn spawn_sigterm_proof_tree(pidfile: &std::path::Path) -> (std::process::Child, i32) {
        let mut child = std::process::Command::new("sh")
            .arg("-c")
            .arg(format!(
                "trap '' TERM; sleep 30 & echo $! > '{}'; wait",
                pidfile.display()
            ))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn sh");
        for _ in 0..150 {
            if let Ok(raw) = std::fs::read_to_string(pidfile) {
                if let Ok(pid) = raw.trim().parse::<i32>() {
                    return (child, pid);
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        // SIGTERM would bounce off, so the bail-out path has to use SIGKILL.
        let config = kill_tree::Config {
            signal: "SIGKILL".to_string(),
            ..Default::default()
        };
        let _ = kill_tree::blocking::kill_tree_with_config(child.id(), &config);
        let _ = child.wait();
        panic!("grandchild never recorded its pid");
    }

    /// Build a broadcaster + subscribed receiver. Subscribing here (not lazily
    /// inside the test) ensures events emitted between construction and the
    /// first `recv` are buffered rather than dropped.
    fn make_test_broadcaster() -> (Arc<WebEventBroadcaster>, broadcast::Receiver<WebEvent>) {
        let bcast = Arc::new(WebEventBroadcaster::new());
        let rx = bcast.subscribe();
        (bcast, rx)
    }

    /// Thin wrapper around `ConnectionManager::insert_test_connection` so the
    /// existing in-crate tests keep their `insert_fake_connection(mgr, ...)`
    /// call shape after the public test helper landed.
    async fn insert_fake_connection(
        mgr: &ConnectionManager,
        id: &str,
        agent_type: crate::models::agent::AgentType,
        working_dir: Option<PathBuf>,
        emitter: EventEmitter,
    ) {
        mgr.insert_test_connection(id, agent_type, working_dir, emitter)
            .await;
    }

    #[tokio::test]
    async fn refresh_connection_staleness_flags_only_drifted_running_sessions() {
        let mgr = ConnectionManager::new();
        // Test connections spawn with an empty fingerprint (insert_test_connection).
        insert_fake_connection(&mgr, "c1", AgentType::Codex, None, EventEmitter::Noop).await;
        // A different agent type that must stay untouched.
        insert_fake_connection(&mgr, "c2", AgentType::ClaudeCode, None, EventEmitter::Noop).await;

        // A real config change for Codex (fresh fp differs from the "" spawn fp).
        let mut fresh = HashMap::new();
        fresh.insert(AgentType::Codex, "codex-v2".to_string());
        let n = mgr
            .refresh_connection_staleness(&fresh, ConfigStaleKind::AgentConfig)
            .await;
        assert_eq!(n, 1, "only the Codex session is stale");
        assert!(
            mgr.get_state("c1").await.unwrap().read().await.config_stale,
            "Codex session flagged stale"
        );
        assert!(
            !mgr.get_state("c2").await.unwrap().read().await.config_stale,
            "ClaudeCode session untouched (agent not in the fresh set)"
        );

        // Re-running with the SAME fingerprint keeps it stale but is idempotent.
        let n2 = mgr
            .refresh_connection_staleness(&fresh, ConfigStaleKind::AgentConfig)
            .await;
        assert_eq!(n2, 1);

        // Reverting Codex back to its spawn fingerprint ("") clears staleness.
        let mut reverted = HashMap::new();
        reverted.insert(AgentType::Codex, String::new());
        let n3 = mgr
            .refresh_connection_staleness(&reverted, ConfigStaleKind::AgentConfig)
            .await;
        assert_eq!(n3, 0, "reverted config is no longer stale");
        assert!(
            !mgr.get_state("c1").await.unwrap().read().await.config_stale,
            "staleness cleared after revert"
        );
    }

    /// Subscribe directly to the per-connection event stream. Phase 4b
    /// removed the dual-broadcast through the global `WebEventBroadcaster`
    /// for ACP events; the per-connection stream is now the only delivery
    /// path tests can observe. Subscribe BEFORE triggering the producing
    /// call so events emitted between subscribe and recv buffer rather
    /// than drop.
    async fn subscribe_conn_stream(
        mgr: &ConnectionManager,
        conn_id: &str,
    ) -> broadcast::Receiver<std::sync::Arc<crate::acp::types::EventEnvelope>> {
        let state = mgr
            .get_state(conn_id)
            .await
            .expect("connection should be registered");
        let stream = state.read().await.event_stream();
        stream.subscribe()
    }

    /// Receive the first envelope from a per-connection stream. Times out
    /// after 200 ms to keep tests honest.
    async fn recv_first_acp_event(
        rx: &mut broadcast::Receiver<std::sync::Arc<crate::acp::types::EventEnvelope>>,
    ) -> crate::acp::types::EventEnvelope {
        let evt = tokio::time::timeout(std::time::Duration::from_millis(200), rx.recv())
            .await
            .expect("timed out waiting for acp event")
            .expect("per-connection stream closed");
        (*evt).clone()
    }

    /// Drain the connection's command receiver (non-blocking) and return one
    /// entry per enqueued `Prompt` command: its attached `user_message` payload
    /// (the cross-client broadcast the loop emits before the agent request),
    /// flattened to `(message_id, text blocks)`. The inner `Option` is `None`
    /// for a `Prompt` carrying no user message (delegation child / unbound).
    /// The vec length is the number of `Prompt` commands enqueued — useful for
    /// asserting the concurrency gate stopped a second one. Call after the
    /// producing await.
    fn drain_prompt_user_messages(
        cmd_rx: &mut mpsc::Receiver<crate::acp::connection::ConnectionCommand>,
    ) -> Vec<Option<(String, Vec<String>)>> {
        let mut out = Vec::new();
        while let Ok(cmd) = cmd_rx.try_recv() {
            if let crate::acp::connection::ConnectionCommand::Prompt { user_message, .. } = cmd {
                out.push(user_message.map(|(id, blocks)| {
                    let texts = blocks
                        .iter()
                        .filter_map(|b| match b {
                            crate::acp::types::UserMessageBlock::Text { text } => {
                                Some(text.clone())
                            }
                            _ => None,
                        })
                        .collect::<Vec<String>>();
                    (id, texts)
                }));
            }
        }
        out
    }

    /// A minimal non-empty prompt for tests that exercise linking / status /
    /// caller-id behavior and don't care about the prompt content. (Empty
    /// prompts are now rejected before any side effects, so these tests must
    /// pass real content to reach the link path.)
    fn one_text_block() -> Vec<PromptInputBlock> {
        vec![PromptInputBlock::Text {
            text: "test prompt".into(),
        }]
    }

    /// Insert a connection with a LIVE command receiver so `send_prompt_inner`'s
    /// enqueue SUCCEEDS (the UserMessage broadcast is deferred until after a
    /// successful enqueue). Returns the receiver — keep it in scope for the
    /// test, otherwise the channel closes and the send fails.
    async fn insert_live_connection(
        mgr: &ConnectionManager,
        conn_id: &str,
        agent_type: AgentType,
        working_dir: Option<PathBuf>,
    ) -> tokio::sync::mpsc::Receiver<crate::acp::connection::ConnectionCommand> {
        use crate::acp::connection::AgentConnection;
        use crate::acp::session_state::SessionState;
        let (tx, rx) = mpsc::channel::<crate::acp::connection::ConnectionCommand>(4);
        let mut state = SessionState::new(
            conn_id.to_string(),
            agent_type,
            working_dir,
            "test-window".to_string(),
            None,
        );
        state.status = ConnectionStatus::Connected;
        let conn = AgentConnection {
            id: conn_id.to_string(),
            agent_type,
            status: ConnectionStatus::Connected,
            owner_window_label: "test-window".to_string(),
            cmd_tx: tx,
            state: Arc::new(RwLock::new(state)),
            emitter: EventEmitter::Noop,
            prompt_lock: Arc::new(tokio::sync::Mutex::new(())),
            config_fingerprint: String::new(),
            last_observed_fingerprint: String::new(),
            child_pid: Arc::new(std::sync::atomic::AtomicU32::new(0)),
        };
        mgr.connections
            .lock()
            .await
            .insert(conn_id.to_string(), conn);
        rx
    }

    /// Put a turn in flight on a connection inserted by
    /// [`insert_live_connection`] (which starts them `Connected`).
    async fn mark_prompting(mgr: &ConnectionManager, conn_id: &str) {
        let state = mgr.get_state(conn_id).await.expect("connection");
        state.write().await.status = ConnectionStatus::Prompting;
    }

    /// Mirror what a live `active` goal snapshot leaves on the state.
    async fn mark_goal_active(mgr: &ConnectionManager, conn_id: &str) {
        let state = mgr.get_state(conn_id).await.expect("connection");
        state.write().await.goal_active = true;
    }

    /// Stand in for the connection loop's `GoalControl` arm: take the command,
    /// assert the action, answer `landed`, and hand the receiver back so the
    /// test can see what (if anything) the manager enqueues next. Returns a
    /// JoinHandle because `goal_control` blocks on that answer.
    fn answer_goal_control(
        mut rx: tokio::sync::mpsc::Receiver<crate::acp::connection::ConnectionCommand>,
        expected: GoalControlAction,
        landed: bool,
    ) -> tokio::task::JoinHandle<tokio::sync::mpsc::Receiver<crate::acp::connection::ConnectionCommand>>
    {
        tokio::spawn(async move {
            match rx.recv().await.expect("goal control enqueued") {
                ConnectionCommand::GoalControl { action, reply } => {
                    assert_eq!(action, expected);
                    reply
                        .expect("an interrupting caller attaches a reply")
                        .send(landed)
                        .expect("manager is listening");
                }
                _ => panic!("expected a GoalControl command"),
            }
            rx
        })
    }

    #[tokio::test]
    async fn a_codex_goal_pause_mid_turn_interrupts_the_turn_after_the_goal_rpc() {
        // codex's pause is app-server metadata: it stops the goal from starting
        // ANOTHER turn but never touches the one that is running, so without
        // the interrupt the user clicks Pause and watches the agent keep
        // working. Order matters — the goal RPC has to LAND first, so the goal
        // is already non-active when the turn aborts and nothing auto-continues
        // on the way out.
        use crate::db::test_helpers;
        let db = test_helpers::fresh_in_memory_db().await;
        let mgr = ConnectionManager::new();
        let rx = insert_live_connection(&mgr, "c-goal-codex", AgentType::Codex, None).await;
        mark_prompting(&mgr, "c-goal-codex").await;
        mark_goal_active(&mgr, "c-goal-codex").await;
        let loop_stub = answer_goal_control(rx, GoalControlAction::Pause, true);

        mgr.goal_control(&db.conn, "c-goal-codex", GoalControlAction::Pause)
            .await
            .unwrap();

        let mut rx = loop_stub.await.unwrap();
        assert!(matches!(rx.try_recv(), Ok(ConnectionCommand::Cancel)));
        assert!(rx.try_recv().is_err(), "nothing else is enqueued");
    }

    #[tokio::test]
    async fn a_rejected_goal_control_leaves_the_turn_alone() {
        // The agent refused the pause (bad params, unknown session, dead
        // process). The goal is still active, so killing the turn would destroy
        // in-flight work AND let codex resume the goal at the next idle point —
        // strictly worse than the error banner the loop already emitted.
        use crate::db::test_helpers;
        let db = test_helpers::fresh_in_memory_db().await;
        let mgr = ConnectionManager::new();
        let rx = insert_live_connection(&mgr, "c-goal-refused", AgentType::Codex, None).await;
        mark_prompting(&mgr, "c-goal-refused").await;
        mark_goal_active(&mgr, "c-goal-refused").await;
        let loop_stub = answer_goal_control(rx, GoalControlAction::Pause, false);

        mgr.goal_control(&db.conn, "c-goal-refused", GoalControlAction::Pause)
            .await
            .unwrap();

        let mut rx = loop_stub.await.unwrap();
        assert!(rx.try_recv().is_err(), "a failed control cancels nothing");
    }

    #[tokio::test]
    async fn a_codex_goal_clear_interrupts_even_when_codeg_thinks_it_is_idle() {
        // Codeg's `Prompting` only covers turns IT started. A goal loop's
        // continuations are started by codex — detached turns no host request
        // owns — so the session reads "connected" while the agent is very much
        // working, which is precisely when the user hits Clear. Gating on our
        // own turn bookkeeping would skip the interrupt exactly there, so the
        // interrupt is not gated on liveness: with an ACTIVE goal, whatever is
        // running is the goal's work, and with nothing running the interrupt is
        // the same harmless no-op the Stop button is.
        use crate::db::test_helpers;
        let db = test_helpers::fresh_in_memory_db().await;
        let mgr = ConnectionManager::new();
        let rx = insert_live_connection(&mgr, "c-goal-idle", AgentType::Codex, None).await;
        mark_goal_active(&mgr, "c-goal-idle").await;
        let loop_stub = answer_goal_control(rx, GoalControlAction::Clear, true);

        mgr.goal_control(&db.conn, "c-goal-idle", GoalControlAction::Clear)
            .await
            .unwrap();

        let mut rx = loop_stub.await.unwrap();
        assert!(matches!(rx.try_recv(), Ok(ConnectionCommand::Cancel)));
        assert!(rx.try_recv().is_err(), "nothing else is enqueued");
    }

    #[tokio::test]
    async fn clearing_a_paused_goal_never_touches_the_users_own_turn() {
        // A paused goal drives nothing, so a turn running alongside it is
        // something the user started themselves. Dismissing the stale card is
        // housekeeping — killing that prompt (and draining its permissions, and
        // cascading to its delegations) would be destroying unrelated work.
        use crate::db::test_helpers;
        let db = test_helpers::fresh_in_memory_db().await;
        let mgr = ConnectionManager::new();
        let mut rx = insert_live_connection(&mgr, "c-goal-paused", AgentType::Codex, None).await;
        mark_prompting(&mgr, "c-goal-paused").await; // the user's own prompt
        // `goal_active` stays false: the last snapshot was `paused`.

        mgr.goal_control(&db.conn, "c-goal-paused", GoalControlAction::Clear)
            .await
            .unwrap();

        match rx.try_recv() {
            Ok(ConnectionCommand::GoalControl { action, reply }) => {
                assert_eq!(action, GoalControlAction::Clear);
                assert!(reply.is_none(), "no interrupt is intended, so none waits");
            }
            _ => panic!("expected a GoalControl command"),
        }
        assert!(rx.try_recv().is_err(), "the user's turn survives");
    }

    #[tokio::test]
    async fn a_claude_goal_clear_never_interrupts_the_turn_carrying_it() {
        // claude-agent-acp implements `_session/goal` by STEERING the text
        // "/goal clear" into the running turn (or prompting when idle).
        // Cancelling would kill the message that carries the clear and leave
        // the goal armed — worse than doing nothing. Same for every adapter
        // whose control channel we haven't verified. No interrupt is intended,
        // so no reply is even asked for and the call doesn't wait.
        use crate::db::test_helpers;
        let db = test_helpers::fresh_in_memory_db().await;
        let mgr = ConnectionManager::new();
        let mut rx =
            insert_live_connection(&mgr, "c-goal-claude", AgentType::ClaudeCode, None).await;
        mark_prompting(&mgr, "c-goal-claude").await;
        mark_goal_active(&mgr, "c-goal-claude").await;

        mgr.goal_control(&db.conn, "c-goal-claude", GoalControlAction::Clear)
            .await
            .unwrap();

        match rx.try_recv() {
            Ok(ConnectionCommand::GoalControl { action, reply }) => {
                assert_eq!(action, GoalControlAction::Clear);
                assert!(reply.is_none(), "nobody waits on an in-band control");
            }
            _ => panic!("expected a GoalControl command"),
        }
        assert!(rx.try_recv().is_err(), "the carrying turn survives");
    }

    #[tokio::test]
    async fn send_prompt_linked_attaches_user_message_to_prompt_for_root() {
        // A root send attaches the projected user-message payload to the
        // enqueued Prompt command (the connection loop emits the UserMessage
        // event itself, ordered before the agent request). With a live receiver
        // the enqueue succeeds and the payload is observable on the command.
        use crate::db::test_helpers;
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/um-root").await;
        let mgr = ConnectionManager::new();
        let conn_id = "conn-um-root";
        let mut cmd_rx = insert_live_connection(
            &mgr,
            conn_id,
            AgentType::ClaudeCode,
            Some(PathBuf::from("/tmp/um-root")),
        )
        .await;

        let result = mgr
            .send_prompt_linked(
                &db,
                conn_id,
                vec![PromptInputBlock::Text {
                    text: "hello viewers".into(),
                }],
                Some(folder_id),
                None,
                None,
            )
            .await;
        assert!(
            result.is_ok(),
            "enqueue should succeed with a live receiver"
        );

        let prompts = drain_prompt_user_messages(&mut cmd_rx);
        assert_eq!(prompts.len(), 1, "exactly one Prompt enqueued");
        let um = prompts[0]
            .as_ref()
            .expect("root Prompt carries a user_message");
        assert!(
            um.0.starts_with("user-"),
            "connection-scoped id fallback, got {:?}",
            um.0
        );
        assert!(
            um.1.iter().any(|t| t == "hello viewers"),
            "user_message must carry the prompt text, got {um:?}"
        );
    }

    #[tokio::test]
    async fn linked_ui_prompt_leaves_the_user_blocks_untouched() {
        use crate::db::test_helpers;

        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/agent-routes").await;
        let mgr = ConnectionManager::new();
        let conn_id = "conn-agent-routes";
        let mut cmd_rx = insert_live_connection(
            &mgr,
            conn_id,
            AgentType::Codex,
            Some(PathBuf::from("/tmp/agent-routes")),
        )
        .await;

        mgr.send_prompt_linked_with_message_id(
            &db,
            conn_id,
            vec![PromptInputBlock::Text {
                text: "ask [@Antigravity](codeg://agent/antigravity) to review".into(),
            }],
            Some(folder_id),
            None,
            None,
            Some("optimistic-route".into()),
        )
        .await
        .unwrap();

        let command = cmd_rx.try_recv().expect("one prompt command");
        let ConnectionCommand::Prompt {
            blocks,
            user_message,
        } = command
        else {
            panic!("expected prompt command");
        };
        // The routing frame is appended at the agent boundary in the connection
        // loop, never here: what the manager enqueues, persists and broadcasts
        // is exactly what the user typed.
        assert!(matches!(
            blocks.as_slice(),
            [PromptInputBlock::Text { text }]
                if text == "ask [@Antigravity](codeg://agent/antigravity) to review"
        ));
        let (message_id, user_blocks) = user_message.expect("root prompt is broadcast");
        assert_eq!(message_id, "optimistic-route");
        assert!(matches!(
            user_blocks.as_slice(),
            [crate::acp::types::UserMessageBlock::Text { text }]
                if text == "ask [@Antigravity](codeg://agent/antigravity) to review"
        ));
    }

    #[tokio::test]
    async fn reserved_route_separator_is_scrubbed_not_rejected() {
        // The separator is invisible and usually arrives inside content the user
        // did not author — an attached file's bytes land in `Resource.text`.
        // Rejecting made such a message permanently unsendable; the prompt must
        // go through with the character removed from EVERY copy.
        use crate::db::test_helpers;

        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/route-separator").await;
        let mgr = ConnectionManager::new();
        let conn_id = "conn-route-separator";
        let mut cmd_rx = insert_live_connection(
            &mgr,
            conn_id,
            AgentType::Codex,
            Some(PathBuf::from("/tmp/route-separator")),
        )
        .await;

        mgr.send_prompt_linked_with_message_id(
            &db,
            conn_id,
            vec![
                PromptInputBlock::Text {
                    text: "user\u{001e}frame".into(),
                },
                PromptInputBlock::Resource {
                    uri: "file:///tmp/records.dat".into(),
                    mime_type: Some("text/plain".into()),
                    text: Some("row-a\u{001e}row-b".into()),
                    blob: None,
                },
            ],
            Some(folder_id),
            None,
            None,
            Some("optimistic-reserved".into()),
        )
        .await
        .expect("an invisible control character must not block the send");

        let ConnectionCommand::Prompt {
            blocks,
            user_message,
            ..
        } = cmd_rx.try_recv().expect("the prompt still reaches the agent")
        else {
            panic!("expected prompt command");
        };
        assert!(matches!(
            blocks.as_slice(),
            [
                PromptInputBlock::Text { text },
                PromptInputBlock::Resource { text: Some(resource), .. },
            ] if text == "userframe" && resource == "row-arow-b"
        ));
        // The broadcast copy is projected from the SAME scrubbed blocks, so the
        // stored, displayed, and on-the-wire messages cannot drift apart.
        let (_, user_blocks) = user_message.expect("root prompt is broadcast");
        assert!(matches!(
            user_blocks.first(),
            Some(crate::acp::types::UserMessageBlock::Text { text }) if text == "userframe"
        ));
    }

    #[tokio::test]
    async fn send_prompt_linked_preserves_history_when_the_session_was_re_minted() {
        // codeg#500, end to end, in the exact shape the reporter described:
        // an existing completed conversation, then a new session started in the
        // same folder and pane.
        //
        // The connection was spawned with `session_id = None` (a reconnect that
        // lost the id, or an unclassified `session/load` failure that fell
        // through to `session/new`), so it holds S2 while the row the UI still
        // points at holds S1. Branch A adopts that row and persists the session
        // id onto it. Before the guard, S1 was left with no row at all — and
        // since the conversation list is built purely from DB rows, the user's
        // 49-minute conversation simply vanished from the sidebar.
        use crate::db::test_helpers;
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/reminted").await;
        let existing = conversation_service::create(
            &db.conn,
            folder_id,
            AgentType::Codex,
            Some("nouveauté de cette version".into()),
            None,
        )
        .await
        .unwrap();
        conversation_service::bind_external_id(&db.conn, existing.id, "S1", &[])
            .await
            .unwrap();
        conversation_service::update_status(
            &db.conn,
            existing.id,
            ConversationStatus::PendingReview,
        )
        .await
        .unwrap();

        let mgr = ConnectionManager::new();
        let conn_id = "conn-reminted";
        let _cmd_rx = insert_live_connection(
            &mgr,
            conn_id,
            AgentType::Codex,
            Some(PathBuf::from("/tmp/reminted")),
        )
        .await;
        // The connection came up on a session of its own — nobody told it about
        // S1, which is the whole problem.
        mgr.get_state(conn_id)
            .await
            .unwrap()
            .write()
            .await
            .external_id = Some("S2".into());

        mgr.send_prompt_linked(
            &db,
            conn_id,
            vec![PromptInputBlock::Text {
                text: "tu peux faire 2 couleur".into(),
            }],
            Some(folder_id),
            Some(existing.id),
            None,
        )
        .await
        .expect("the prompt itself must still go through");

        // The row the user has open follows the live session...
        let current = conversation_service::get_by_id(&db.conn, existing.id)
            .await
            .expect("current row");
        assert_eq!(current.external_id.as_deref(), Some("S2"));

        // ...and S1 is still indexed, under the title the user recognises, so
        // it remains visible and reopenable from the sidebar.
        let listed = crate::commands::conversations::list_all_conversations_core(
            &db.conn,
            &EventEmitter::Noop,
            &crate::chat_channel::manager::ChatChannelManager::new(),
            crate::commands::conversations::ListAllConversationsOptions::default(),
        )
        .await
        .expect("list");
        let preserved = listed
            .iter()
            .find(|c| c.external_id.as_deref() == Some("S1"))
            .expect("the previous session must remain in the conversation index");
        assert_eq!(
            preserved.title.as_deref(),
            Some("nouveauté de cette version")
        );
        assert_ne!(
            preserved.id, existing.id,
            "the preserved history lives on its own row"
        );
        assert_eq!(listed.len(), 2, "exactly two conversations, got {listed:?}");
    }

    #[tokio::test]
    async fn send_prompt_linked_refuses_a_session_owned_by_another_conversation() {
        // The connection holds a session that ALREADY belongs to a different
        // row, so no bind can make this row own it.
        //
        // The retry is the whole point of the test. `ConversationLinked` is
        // applied to `SessionState`, and `already_linked` is read from exactly
        // that field — so announcing the link before the bind meant the first
        // call failed with the link latched, and the SECOND call skipped the
        // entire link/bind block and dispatched the turn into a session this
        // row does not own. Both calls must fail identically, and neither may
        // enqueue a prompt.
        use crate::db::test_helpers;
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/conflict").await;

        let holder = conversation_service::create(
            &db.conn,
            folder_id,
            AgentType::Codex,
            Some("owns the session".into()),
            None,
        )
        .await
        .unwrap();
        conversation_service::bind_external_id(&db.conn, holder.id, "S_SHARED", &[])
            .await
            .unwrap();
        let target = conversation_service::create(
            &db.conn,
            folder_id,
            AgentType::Codex,
            Some("the row the user is looking at".into()),
            None,
        )
        .await
        .unwrap();

        let mgr = ConnectionManager::new();
        let conn_id = "conn-conflict";
        let mut cmd_rx = insert_live_connection(
            &mgr,
            conn_id,
            AgentType::Codex,
            Some(PathBuf::from("/tmp/conflict")),
        )
        .await;
        mgr.get_state(conn_id)
            .await
            .unwrap()
            .write()
            .await
            .external_id = Some("S_SHARED".into());

        for attempt in 1..=2 {
            let err = mgr
                .send_prompt_linked(
                    &db,
                    conn_id,
                    vec![PromptInputBlock::Text {
                        text: "should never reach the agent".into(),
                    }],
                    Some(folder_id),
                    Some(target.id),
                    None,
                )
                .await
                .expect_err("a session owned by another row must be refused");
            assert!(
                err.to_string().contains("already bound"),
                "attempt {attempt} must name the conflict, got {err}"
            );
            assert!(
                mgr.get_state(conn_id)
                    .await
                    .unwrap()
                    .read()
                    .await
                    .conversation_id
                    .is_none(),
                "attempt {attempt} must leave the connection UNLINKED, or the next \
                 prompt takes the already_linked fast path and skips the bind"
            );
            assert!(
                drain_prompt_user_messages(&mut cmd_rx).is_empty(),
                "attempt {attempt} must not enqueue a prompt"
            );
        }

        // Neither row moved, and no split row was manufactured.
        assert_eq!(
            conversation_service::get_by_id(&db.conn, target.id)
                .await
                .expect("target")
                .external_id,
            None
        );
        assert_eq!(
            conversation_service::get_by_id(&db.conn, holder.id)
                .await
                .expect("holder")
                .external_id
                .as_deref(),
            Some("S_SHARED")
        );
    }

    #[tokio::test]
    async fn send_prompt_linked_drops_the_row_it_minted_when_the_bind_is_refused() {
        // Branch B mints the row before the bind can be attempted. Since the
        // announce now happens AFTER the bind, a refused one leaves a row no
        // client was ever told about — invisible until the sidebar's next full
        // refetch surfaces it as an empty untitled conversation. Every retry
        // would add another.
        use crate::db::test_helpers;
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/conflict-b").await;

        let holder =
            conversation_service::create(&db.conn, folder_id, AgentType::Codex, None, None)
                .await
                .unwrap();
        conversation_service::bind_external_id(&db.conn, holder.id, "S_SHARED", &[])
            .await
            .unwrap();

        let mgr = ConnectionManager::new();
        let conn_id = "conn-conflict-b";
        let _cmd_rx = insert_live_connection(
            &mgr,
            conn_id,
            AgentType::Codex,
            Some(PathBuf::from("/tmp/conflict-b")),
        )
        .await;
        mgr.get_state(conn_id)
            .await
            .unwrap()
            .write()
            .await
            .external_id = Some("S_SHARED".into());

        for _ in 0..2 {
            mgr.send_prompt_linked(
                &db,
                conn_id,
                vec![PromptInputBlock::Text { text: "hi".into() }],
                Some(folder_id),
                // No conversation_id — Branch B.
                None,
                None,
            )
            .await
            .expect_err("must be refused");
        }

        let listed = crate::commands::conversations::list_all_conversations_core(
            &db.conn,
            &EventEmitter::Noop,
            &crate::chat_channel::manager::ChatChannelManager::new(),
            crate::commands::conversations::ListAllConversationsOptions::default(),
        )
        .await
        .expect("list");
        assert_eq!(
            listed.len(),
            1,
            "only the pre-existing holder may remain, got {listed:?}"
        );
        assert_eq!(listed[0].id, holder.id);
    }

    #[tokio::test]
    async fn send_prompt_linked_rejects_second_prompt_while_turn_in_flight() {
        // Two clients co-controlling one connection can send near-
        // simultaneously. The first accepted prompt marks the turn in flight;
        // the second must be REJECTED with TurnInProgress (not enqueued behind
        // the active turn and silently dropped by the loop) so the frontend can
        // re-queue it. Only one Prompt reaches the connection loop.
        use crate::db::test_helpers;
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/um-gate").await;
        let mgr = ConnectionManager::new();
        let conn_id = "conn-um-gate";
        let mut cmd_rx = insert_live_connection(
            &mgr,
            conn_id,
            AgentType::ClaudeCode,
            Some(PathBuf::from("/tmp/um-gate")),
        )
        .await;

        let first = mgr
            .send_prompt_linked(
                &db,
                conn_id,
                vec![PromptInputBlock::Text {
                    text: "first".into(),
                }],
                Some(folder_id),
                None,
                None,
            )
            .await;
        assert!(first.is_ok(), "first prompt accepted");

        let second = mgr
            .send_prompt_linked(
                &db,
                conn_id,
                vec![PromptInputBlock::Text {
                    text: "second".into(),
                }],
                Some(folder_id),
                None,
                None,
            )
            .await;
        assert!(
            matches!(second, Err(AcpError::TurnInProgress)),
            "second concurrent prompt must be rejected with TurnInProgress, got {second:?}"
        );

        let prompts = drain_prompt_user_messages(&mut cmd_rx);
        assert_eq!(
            prompts.len(),
            1,
            "only the first prompt reaches the loop; the second is rejected, not queued"
        );
    }

    #[tokio::test]
    async fn send_prompt_linked_rejects_empty_prompt_without_wedging_gate() {
        // An empty prompt is rejected BEFORE any side effects: it must NOT
        // create/link a conversation row, must NOT set the concurrency gate
        // (which — with no TurnComplete to clear it — would 409 every future
        // send), and the connection must stay usable for a real prompt.
        use crate::db::test_helpers;
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/um-empty").await;
        let mgr = ConnectionManager::new();
        let conn_id = "conn-um-empty";
        let mut cmd_rx = insert_live_connection(
            &mgr,
            conn_id,
            AgentType::ClaudeCode,
            Some(PathBuf::from("/tmp/um-empty")),
        )
        .await;

        let rows_before = count_conversation_rows(&db).await;
        let empty = mgr
            .send_prompt_linked(&db, conn_id, vec![], Some(folder_id), None, None)
            .await;
        assert!(empty.is_err(), "an empty prompt must be rejected");
        assert_eq!(
            count_conversation_rows(&db).await,
            rows_before,
            "a rejected empty prompt must NOT create/link a conversation row"
        );
        assert!(
            !mgr.get_state(conn_id)
                .await
                .unwrap()
                .read()
                .await
                .turn_in_flight,
            "a rejected empty prompt must NOT set the concurrency gate"
        );

        // The connection is not wedged: a real prompt afterwards is accepted.
        let ok = mgr
            .send_prompt_linked(
                &db,
                conn_id,
                vec![PromptInputBlock::Text { text: "hi".into() }],
                Some(folder_id),
                None,
                None,
            )
            .await;
        assert!(
            ok.is_ok(),
            "a real prompt after an empty one must still be accepted"
        );
        assert_eq!(
            drain_prompt_user_messages(&mut cmd_rx).len(),
            1,
            "exactly the one real prompt reached the loop"
        );
    }

    #[tokio::test]
    async fn send_prompt_returns_turn_in_progress_when_busy() {
        // The non-linked `send_prompt` path (used by the chat channel) must
        // surface `TurnInProgress` — NOT a connection-loss error — when a turn
        // is already in flight, so the chat channel treats it as a transient
        // busy rejection instead of tearing down the session.
        let mgr = ConnectionManager::new();
        let conn_id = "conn-busy";
        let _rx = insert_live_connection(&mgr, conn_id, AgentType::ClaudeCode, None).await;
        mgr.get_state(conn_id)
            .await
            .unwrap()
            .write()
            .await
            .turn_in_flight = true;

        let res = mgr
            .send_prompt(conn_id, vec![PromptInputBlock::Text { text: "hi".into() }])
            .await;
        assert!(
            matches!(res, Err(AcpError::TurnInProgress)),
            "send_prompt must return TurnInProgress when a turn is in flight, got {res:?}"
        );
    }

    #[tokio::test]
    async fn fork_session_rejects_when_turn_in_flight() {
        // A fork re-points the live session; it must not run while a turn is in
        // flight (a racing send would route to the wrong session, and the Fork
        // command would be dropped by the in-turn loop). It rejects with
        // TurnInProgress so the caller re-queues, WITHOUT enqueuing a Fork.
        use crate::db::test_helpers;
        let db = test_helpers::fresh_in_memory_db().await;
        let mgr = ConnectionManager::new();
        let conn_id = "conn-fork-busy";
        let mut cmd_rx = insert_live_connection(&mgr, conn_id, AgentType::ClaudeCode, None).await;
        {
            let state = mgr.get_state(conn_id).await.unwrap();
            let mut s = state.write().await;
            s.conversation_id = Some(7); // fork requires a linked row
            s.turn_in_flight = true; // a turn is already running
        }

        let res = mgr.fork_session(&db, conn_id, None, None, None).await;
        assert!(
            matches!(res, Err(AcpError::TurnInProgress)),
            "fork must reject with TurnInProgress while a turn is in flight, got {res:?}"
        );
        assert!(
            cmd_rx.try_recv().is_err(),
            "a rejected fork must NOT enqueue a Fork command"
        );
    }

    #[tokio::test]
    async fn fork_session_failure_leaves_gate_clear_and_lock_free() {
        // A fork holds `prompt_lock` for its whole critical section and never
        // SETS `turn_in_flight`, so even when the fork FAILS (here: a dead
        // command receiver makes the `Fork` send error) the connection isn't
        // wedged — the gate stays clear and the prompt lock is released on the
        // error path. (A fork emits no TurnComplete, so a gate it had set would
        // have had nothing to clear it.)
        use crate::db::test_helpers;
        let db = test_helpers::fresh_in_memory_db().await;
        let mgr = ConnectionManager::new();
        let conn_id = "conn-fork-fail";
        // insert_fake_connection drops the cmd receiver → the Fork send fails.
        insert_fake_connection(
            &mgr,
            conn_id,
            AgentType::ClaudeCode,
            None,
            EventEmitter::Noop,
        )
        .await;
        mgr.get_state(conn_id)
            .await
            .unwrap()
            .write()
            .await
            .conversation_id = Some(9);

        let res = mgr.fork_session(&db, conn_id, None, None, None).await;
        assert!(res.is_err(), "fork with a dead receiver must fail");
        assert!(
            !mgr.get_state(conn_id)
                .await
                .unwrap()
                .read()
                .await
                .turn_in_flight,
            "a failed fork must leave the gate clear"
        );
        let lock = mgr.clone_prompt_lock(conn_id).await.unwrap();
        assert!(
            lock.try_lock().is_ok(),
            "a failed fork must release prompt_lock so the connection stays usable"
        );
    }

    #[tokio::test]
    async fn fork_persists_despite_caller_cancellation() {
        // Cancellation-shield regression. Once `fork_session` enqueues the `Fork`
        // command, the connection loop re-points the live session to S2 and emits
        // `SessionStarted{S2}` REGARDLESS of caller liveness (it ignores a dead
        // reply channel). So the DB persistence that records the two-row layout
        // must NOT be tied to the caller's future — a dropped caller (HTTP client
        // disconnect) must not strand the live session on S2 with the pre-fork S1
        // history orphaned. We drop the caller mid-fork (reply withheld), then
        // release the reply and assert the detached task STILL persists the
        // current row (→ S2, `[Fork]` title) and the sibling (→ S1).
        use crate::acp::connection::ConnectionCommand;
        use crate::db::test_helpers;
        use sea_orm::EntityTrait;

        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/fork-shield").await;
        let pre = conversation_service::create(
            &db.conn,
            folder_id,
            AgentType::ClaudeCode,
            Some("Topic".into()),
            None,
        )
        .await
        .unwrap();
        conversation_service::bind_external_id(&db.conn, pre.id, "session-S1", &[])
            .await
            .unwrap();

        // Connection with a GATED fake fork reply: withheld until `go_tx` fires,
        // so we can drop the caller before the reply (and thus the persistence).
        let (tx, mut rx) = mpsc::channel::<ConnectionCommand>(4);
        let mut state = SessionState::new(
            "c-shield".to_string(),
            AgentType::ClaudeCode,
            None,
            "test-window".to_string(),
            None,
        );
        state.conversation_id = Some(pre.id);
        state.status = ConnectionStatus::Connected;
        let conn = AgentConnection {
            id: "c-shield".to_string(),
            agent_type: AgentType::ClaudeCode,
            status: ConnectionStatus::Connected,
            owner_window_label: "test-window".to_string(),
            cmd_tx: tx,
            state: Arc::new(RwLock::new(state)),
            emitter: EventEmitter::Noop,
            prompt_lock: Arc::new(tokio::sync::Mutex::new(())),
            config_fingerprint: String::new(),
            last_observed_fingerprint: String::new(),
            child_pid: Arc::new(std::sync::atomic::AtomicU32::new(0)),
        };
        let mgr = ConnectionManager::new();
        mgr.connections
            .lock()
            .await
            .insert("c-shield".to_string(), conn);

        let (go_tx, go_rx) = tokio::sync::oneshot::channel::<()>();
        let fake_loop = tokio::spawn(async move {
            if let Some(ConnectionCommand::Fork { reply, .. }) = rx.recv().await {
                go_rx.await.ok(); // withhold the reply until the test releases it
                let _ = reply.send(Ok(crate::acp::types::ForkProtocolResult {
                    forked_session_id: "session-S2".into(),
                    original_session_id: "session-S1".into(),
                }));
            }
            rx // keep the receiver alive
        });

        // Drive fork under a short timeout: it spawns the shielded task (which
        // enqueues `Fork` and blocks on the withheld reply), then the timeout
        // DROPS this caller future. The detached persistence task must survive.
        let timed = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            mgr.fork_session(&db, "c-shield", None, None, None),
        )
        .await;
        assert!(
            timed.is_err(),
            "caller must be dropped before the withheld reply is delivered"
        );

        // Nothing persisted yet (reply still withheld) — the row is untouched.
        let mid = conversation_service::get_by_id(&db.conn, pre.id)
            .await
            .unwrap();
        assert_eq!(
            mid.external_id.as_deref(),
            Some("session-S1"),
            "fork must not persist before the protocol reply"
        );

        // Release the reply: the DETACHED task completes the persistence even
        // though the caller is long gone.
        go_tx.send(()).ok();
        let _ = fake_loop.await;

        // Poll (bounded) until the two-row layout appears.
        let mut persisted = false;
        for _ in 0..200 {
            let current = conversation_service::get_by_id(&db.conn, pre.id)
                .await
                .unwrap();
            let rows = conversation::Entity::find().all(&db.conn).await.unwrap();
            let has_sibling = rows
                .iter()
                .any(|r| r.id != pre.id && r.external_id.as_deref() == Some("session-S1"));
            if current.external_id.as_deref() == Some("session-S2")
                && current.title.as_deref() == Some("[Fork] Topic")
                && has_sibling
            {
                persisted = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert!(
            persisted,
            "fork persistence must complete despite caller cancellation"
        );
    }

    #[tokio::test]
    async fn send_prompt_inner_does_not_set_gate_while_blocked_on_capacity() {
        // Cancellation-safety: the gate is set only AFTER reserving channel
        // capacity, with no await between the set and the send. If the future is
        // dropped while awaiting capacity (channel full), `turn_in_flight` must
        // remain false — otherwise a cancelled send would wedge the connection.
        let mgr = ConnectionManager::new();
        let conn_id = "conn-cancel";
        let _rx = insert_live_connection(&mgr, conn_id, AgentType::ClaudeCode, None).await;
        // Fill the command channel to capacity (4, per insert_live_connection)
        // by sending DIRECTLY on the cloned sender — bypassing the gate — so the
        // next reserve() blocks.
        let tx = mgr
            .connections
            .lock()
            .await
            .get(conn_id)
            .unwrap()
            .cmd_tx
            .clone();
        for _ in 0..4 {
            tx.send(crate::acp::connection::ConnectionCommand::Prompt {
                blocks: vec![PromptInputBlock::Text {
                    text: "filler".into(),
                }],
                user_message: None,
            })
            .await
            .unwrap();
        }

        // send_prompt_inner now blocks on reserve(); drop it via a short timeout.
        let fut = mgr.send_prompt_inner(
            conn_id,
            vec![PromptInputBlock::Text {
                text: "blocked".into(),
            }],
            None,
        );
        let res = tokio::time::timeout(std::time::Duration::from_millis(50), fut).await;
        assert!(
            res.is_err(),
            "send_prompt_inner should still be blocked on channel capacity"
        );
        assert!(
            !mgr.get_state(conn_id)
                .await
                .unwrap()
                .read()
                .await
                .turn_in_flight,
            "the gate must NOT be set while blocked on channel capacity (cancellation-safe)"
        );
    }

    #[tokio::test]
    async fn send_prompt_linked_uses_client_message_id_for_user_message() {
        // The UI threads its optimistic turn id as `client_message_id`; the
        // broadcast UserMessage must carry it verbatim so the sender dedups its
        // own echo by exact id (not a heuristic).
        use crate::db::test_helpers;
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/um-cmid").await;
        let mgr = ConnectionManager::new();
        let conn_id = "conn-um-cmid";
        let mut cmd_rx = insert_live_connection(
            &mgr,
            conn_id,
            AgentType::ClaudeCode,
            Some(PathBuf::from("/tmp/um-cmid")),
        )
        .await;

        mgr.send_prompt_linked_with_message_id(
            &db,
            conn_id,
            vec![PromptInputBlock::Text { text: "hi".into() }],
            Some(folder_id),
            None,
            None,
            Some("optimistic-abc".to_string()),
        )
        .await
        .expect("send");

        let prompts = drain_prompt_user_messages(&mut cmd_rx);
        assert_eq!(
            prompts
                .first()
                .and_then(|um| um.as_ref())
                .map(|(id, _)| id.as_str()),
            Some("optimistic-abc"),
            "Prompt's user_message must carry the client-supplied message_id verbatim"
        );
    }

    #[tokio::test]
    async fn send_prompt_linked_failed_reserve_leaves_gate_clear() {
        // A failed enqueue (dropped cmd receiver) fails at the channel
        // `reserve()` step — which is BEFORE the turn-in-flight gate is set — so
        // the gate is never set, not "rolled back". The connection must stay
        // usable (turn_in_flight false), and the row rolls back to Cancelled.
        // pending_user_message stays None (the loop, which never ran, owns it).
        use crate::db::test_helpers;
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/um-fail").await;
        let mgr = ConnectionManager::new();
        let conn_id = "conn-um-fail";
        // insert_fake_connection drops the cmd receiver → send_prompt_inner fails.
        insert_fake_connection(
            &mgr,
            conn_id,
            AgentType::ClaudeCode,
            Some(PathBuf::from("/tmp/um-fail")),
            EventEmitter::Noop,
        )
        .await;

        let result = mgr
            .send_prompt_linked(
                &db,
                conn_id,
                vec![PromptInputBlock::Text {
                    text: "never enqueued".into(),
                }],
                Some(folder_id),
                None,
                None,
            )
            .await;
        assert!(result.is_err(), "a dropped receiver must fail the enqueue");

        let state = mgr.get_state(conn_id).await.unwrap();
        let snap = state.read().await;
        assert!(
            !snap.turn_in_flight,
            "a failed enqueue must roll back turn_in_flight so the connection isn't wedged"
        );
        let pending = snap.pending_user_message.clone();
        assert!(
            pending.is_none(),
            "a failed enqueue must not strand pending_user_message"
        );
    }

    #[tokio::test]
    async fn send_prompt_linked_skips_user_message_for_delegation_child() {
        // Delegation children surface their kickoff prompt via a separate path;
        // send_prompt_linked must NOT broadcast a user_message (or capture
        // pending) for them, so the sub-agent viewer doesn't double-render.
        use crate::acp::delegation::spawner::DelegationLink;
        use crate::db::test_helpers;
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/um-deleg").await;
        let parent =
            conversation_service::create(&db.conn, folder_id, AgentType::ClaudeCode, None, None)
                .await
                .expect("parent");
        let mgr = ConnectionManager::new();
        let conn_id = "conn-um-deleg";
        let mut cmd_rx = insert_live_connection(
            &mgr,
            conn_id,
            AgentType::Codex,
            Some(PathBuf::from("/tmp/um-deleg")),
        )
        .await;

        mgr.send_prompt_linked(
            &db,
            conn_id,
            vec![PromptInputBlock::Text {
                text: "child kickoff".into(),
            }],
            Some(folder_id),
            None,
            Some(DelegationLink {
                parent_conversation_id: parent.id,
                parent_tool_use_id: "tu-1".into(),
                delegation_call_id: "call-1".into(),
            }),
        )
        .await
        .expect("delegation kickoff enqueues");

        let prompts = drain_prompt_user_messages(&mut cmd_rx);
        assert_eq!(prompts.len(), 1, "the kickoff prompt is enqueued");
        assert!(
            prompts[0].is_none(),
            "delegation child Prompt must carry NO user_message (kickoff is surfaced separately)"
        );
        let pending = mgr
            .get_state(conn_id)
            .await
            .unwrap()
            .read()
            .await
            .pending_user_message
            .clone();
        assert!(
            pending.is_none(),
            "delegation child must not capture pending_user_message"
        );
    }

    #[test]
    fn user_prompt_text_preview_joins_and_trims_text_blocks() {
        let blocks = vec![
            PromptInputBlock::Text {
                text: "  hello  ".into(),
            },
            PromptInputBlock::Text {
                text: "world".into(),
            },
        ];
        assert_eq!(
            user_prompt_text_preview(&blocks).as_deref(),
            Some("hello world")
        );
    }

    #[test]
    fn user_prompt_text_preview_is_none_for_empty_or_textless() {
        assert!(user_prompt_text_preview(&[]).is_none());
        assert!(
            user_prompt_text_preview(&[PromptInputBlock::Text { text: "   ".into() }]).is_none()
        );
        let img = vec![PromptInputBlock::Image {
            data: "x".into(),
            mime_type: "image/png".into(),
            uri: None,
        }];
        assert!(user_prompt_text_preview(&img).is_none());
    }

    #[test]
    fn user_prompt_text_preview_truncates_long_input() {
        let long = "a".repeat(USER_PROMPT_PREVIEW_MAX_CHARS + 50);
        let preview = user_prompt_text_preview(&[PromptInputBlock::Text { text: long }]).unwrap();
        // truncate_str keeps MAX chars then appends a 3-char "..." marker.
        assert_eq!(preview.chars().count(), USER_PROMPT_PREVIEW_MAX_CHARS + 3);
        assert!(preview.ends_with("..."));
    }

    /// The chat-channel handle is installed once at bootstrap on the ONE
    /// manager Tauri/axum owns, but every consumer (the web AppState at
    /// `web/mod.rs`, the lifecycle worker) holds a `clone_ref` of it. The
    /// handle therefore has to live behind the shared `Arc<OnceLock>` — if a
    /// clone ever got a fresh lock, live title writes would stop renaming
    /// bound Telegram topics on exactly the paths that do the writing, with
    /// no error anywhere.
    #[test]
    fn installed_chat_channel_survives_clone_ref() {
        let mgr = ConnectionManager::new();
        assert!(mgr.chat_channel().is_none(), "unset before bootstrap");

        // Install on a clone: the handle must become visible on the original
        // too (bootstrap order across `clone_ref` boundaries is not fixed).
        let clone = mgr.clone_ref();
        clone.install_chat_channel(crate::chat_channel::manager::ChatChannelManager::new());

        assert!(mgr.chat_channel().is_some());
        assert!(mgr.clone_ref().chat_channel().is_some());
    }

    #[test]
    fn delegation_child_title_seed_uses_parser_title_from_first_prompt() {
        // The delegating prompt is a single text block (the task) — the seed must
        // equal what the parser's `title_from_user_text` produces from it, so a
        // later `refresh_auto_title` over the same first turn is a no-op.
        let task = "Review the auth module for race conditions";
        let blocks = vec![PromptInputBlock::Text { text: task.into() }];
        assert_eq!(
            delegation_child_title_seed(&blocks),
            Some(crate::parsers::title_from_user_text(task))
        );
    }

    #[test]
    fn delegation_child_title_seed_is_none_for_textless_prompt() {
        // Empty / whitespace / image-only prompts seed no title (stays NULL,
        // backfilled on first detail load as before).
        assert!(delegation_child_title_seed(&[]).is_none());
        assert!(
            delegation_child_title_seed(&[PromptInputBlock::Text { text: "  \n ".into() }])
                .is_none()
        );
        let img = vec![PromptInputBlock::Image {
            data: "x".into(),
            mime_type: "image/png".into(),
            uri: None,
        }];
        assert!(delegation_child_title_seed(&img).is_none());
    }

    /// A message that is one dropped-in file and no prose. The row would read
    /// "Untitled" forever otherwise — for an agent with no store parser, ACP
    /// has no title channel and the history parse honestly reports none. The
    /// value is a SEED: it reaches `seed_auto_title_if_empty` / a fresh row's
    /// `title`, never `refresh_auto_title`, so a name the agent publishes over
    /// `session_info_update` still wins.
    #[test]
    fn delegation_child_title_seed_names_an_attachment_only_prompt() {
        let blocks = vec![
            PromptInputBlock::ResourceLink {
                uri: "file:///tmp/report.pdf".into(),
                name: "report.pdf".into(),
                mime_type: None,
                description: None,
            },
            PromptInputBlock::Resource {
                uri: "clipboard://my%20notes.txt-9f2".into(),
                mime_type: Some("text/plain".into()),
                text: Some("body".into()),
                blob: None,
            },
        ];
        assert_eq!(
            delegation_child_title_seed(&blocks).as_deref(),
            Some("report.pdf, my notes.txt-9f2")
        );

        // Prose still wins outright, attachments and all — and matches what
        // `refresh_auto_title` will later compute, so the row doesn't churn.
        let mut with_prose = blocks.clone();
        with_prose.insert(
            0,
            PromptInputBlock::Text {
                text: "Review these".into(),
            },
        );
        assert_eq!(
            delegation_child_title_seed(&with_prose),
            Some(crate::parsers::title_from_user_text("Review these"))
        );
    }

    #[test]
    fn delegation_child_title_seed_caps_long_task_text() {
        // Mirrors the parser cap (100 chars) so an over-long task doesn't store a
        // runaway title; `title_from_user_text` keeps 100 then appends "...".
        let long = "x".repeat(250);
        let seed = delegation_child_title_seed(&[PromptInputBlock::Text { text: long }]).unwrap();
        assert_eq!(seed.chars().count(), 103);
        assert!(seed.ends_with("..."));
    }

    /// A successful UI send (delegation = None, text present) emits
    /// `UserPromptSent` carrying the message preview, after the link + status
    /// events.
    #[tokio::test]
    async fn send_prompt_linked_emits_user_prompt_sent_on_success() {
        use crate::db::test_helpers;
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/ups").await;
        let mgr = ConnectionManager::new();
        let conn_id = "conn-ups-1";
        let _rx = insert_live_connection(
            &mgr,
            conn_id,
            AgentType::ClaudeCode,
            Some(PathBuf::from("/tmp/ups")),
        )
        .await;
        let mut stream = subscribe_conn_stream(&mgr, conn_id).await;

        mgr.send_prompt_linked(
            &db,
            conn_id,
            vec![PromptInputBlock::Text {
                text: "hello world".into(),
            }],
            Some(folder_id),
            None,
            None,
        )
        .await
        .expect("send should succeed with a live receiver");

        let mut found = None;
        for _ in 0..5 {
            let env = recv_first_acp_event(&mut stream).await;
            if let AcpEvent::UserPromptSent { text_preview } = env.payload {
                found = Some(text_preview);
                break;
            }
        }
        assert_eq!(found.as_deref(), Some("hello world"));
    }

    #[tokio::test]
    async fn send_prompt_linked_seeds_first_prompt_title_when_untitled() {
        use crate::db::test_helpers;
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/title-seed").await;
        let mgr = ConnectionManager::new();
        let conn_id = "conn-title-seed";
        let _rx = insert_live_connection(
            &mgr,
            conn_id,
            AgentType::ClaudeCode,
            Some(PathBuf::from("/tmp/title-seed")),
        )
        .await;

        mgr.send_prompt_linked(
            &db,
            conn_id,
            vec![PromptInputBlock::Text {
                text: "hello world".into(),
            }],
            Some(folder_id),
            None,
            None,
        )
        .await
        .expect("send");

        let cid = mgr
            .get_state(conn_id)
            .await
            .unwrap()
            .read()
            .await
            .conversation_id
            .expect("row linked");
        let row = conversation_service::get_by_id(&db.conn, cid)
            .await
            .expect("get");
        assert_eq!(row.title.as_deref(), Some("hello world"));
        assert!(
            !row.title_locked,
            "first-prompt seed must stay unlocked so a later ACP title can replace it"
        );
    }

    /// A textless prompt (image-only) succeeds but emits NO `UserPromptSent` —
    /// the notification fires for text messages only.
    #[tokio::test]
    async fn send_prompt_linked_skips_user_prompt_sent_for_textless_prompt() {
        use crate::db::test_helpers;
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/ups2").await;
        let mgr = ConnectionManager::new();
        let conn_id = "conn-ups-2";
        let _rx = insert_live_connection(
            &mgr,
            conn_id,
            AgentType::ClaudeCode,
            Some(PathBuf::from("/tmp/ups2")),
        )
        .await;
        let mut stream = subscribe_conn_stream(&mgr, conn_id).await;

        mgr.send_prompt_linked(
            &db,
            conn_id,
            vec![PromptInputBlock::Image {
                data: "deadbeef".into(),
                mime_type: "image/png".into(),
                uri: None,
            }],
            Some(folder_id),
            None,
            None,
        )
        .await
        .expect("send should succeed with a live receiver");

        let mut saw_user_prompt = false;
        for _ in 0..4 {
            match tokio::time::timeout(std::time::Duration::from_millis(100), stream.recv()).await {
                Ok(Ok(env)) => {
                    if matches!(env.payload, AcpEvent::UserPromptSent { .. }) {
                        saw_user_prompt = true;
                    }
                }
                _ => break,
            }
        }
        assert!(
            !saw_user_prompt,
            "a textless (image-only) prompt must not emit UserPromptSent"
        );
    }

    #[tokio::test]
    async fn get_state_returns_arc_for_known_connection() {
        let mgr = ConnectionManager::new();
        {
            let mut map = mgr.connections.lock().await;
            map.insert("c1".to_string(), fake_connection("c1", None));
        }
        let state = mgr.get_state("c1").await.expect("state should be found");
        assert_eq!(state.read().await.connection_id, "c1");
    }

    #[tokio::test]
    async fn get_state_returns_none_for_unknown_connection() {
        let mgr = ConnectionManager::new();
        assert!(mgr.get_state("does-not-exist").await.is_none());
    }

    #[tokio::test]
    async fn find_connection_by_conversation_id_matches_when_bound() {
        let mgr = ConnectionManager::new();
        {
            let mut map = mgr.connections.lock().await;
            map.insert("c1".to_string(), fake_connection("c1", Some(42)));
            map.insert("c2".to_string(), fake_connection("c2", None));
        }
        let found = mgr
            .find_connection_by_conversation_id(42)
            .await
            .expect("should find c1");
        assert_eq!(found, "c1");
        assert!(mgr.find_connection_by_conversation_id(999).await.is_none());
    }

    #[tokio::test]
    async fn send_prompt_linked_creates_conversation_on_first_call_only() {
        use crate::db::test_helpers;
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/test").await;

        let mgr = ConnectionManager::new();
        let conn_id = "c1";
        {
            let mut map = mgr.connections.lock().await;
            // Note: cmd_tx receiver is dropped, so send_prompt's mpsc.send will fail
            // with ProcessExited. That's fine — we only verify the linkage side
            // effect, not the actual prompt forwarding.
            map.insert(conn_id.into(), fake_connection(conn_id, None));
        }

        // First call: creates conversation row, sets state.conversation_id.
        // The mpsc send error after linking is expected and ignored here.
        let _ = mgr
            .send_prompt_linked(&db, conn_id, one_text_block(), Some(folder_id), None, None)
            .await;
        let snap = mgr
            .get_state(conn_id)
            .await
            .unwrap()
            .read()
            .await
            .to_snapshot();
        assert!(
            snap.conversation_id.is_some(),
            "conversation_id should be set"
        );
        assert_eq!(snap.folder_id, Some(folder_id));
        let first_id = snap.conversation_id.unwrap();

        // Second call: ignores folder_id, does NOT create another row.
        let _ = mgr
            .send_prompt_linked(&db, conn_id, one_text_block(), Some(folder_id), None, None)
            .await;
        let snap2 = mgr
            .get_state(conn_id)
            .await
            .unwrap()
            .read()
            .await
            .to_snapshot();
        assert_eq!(snap2.conversation_id, Some(first_id));
    }

    #[tokio::test]
    async fn send_prompt_linked_errors_when_no_folder_id() {
        use crate::db::test_helpers;
        let db = test_helpers::fresh_in_memory_db().await;
        let mgr = ConnectionManager::new();
        let conn_id = "c1";
        {
            let mut map = mgr.connections.lock().await;
            map.insert(conn_id.into(), fake_connection(conn_id, None));
        }
        let result = mgr
            .send_prompt_linked(&db, conn_id, one_text_block(), None, None, None)
            .await;
        assert!(
            result.is_err(),
            "should error when folder_id is not provided for a new conversation row"
        );
        let err_str = result.unwrap_err().to_string();
        assert!(
            err_str.contains("folder_id"),
            "error should mention missing folder_id, got: {err_str}"
        );
    }

    /// Count of `conversation` rows (ignoring soft-delete) — used by the
    /// caller-supplied conversation_id tests to assert no new row was created.
    async fn count_conversation_rows(db: &crate::db::AppDatabase) -> usize {
        use crate::db::entities::conversation;
        use sea_orm::EntityTrait;
        conversation::Entity::find()
            .all(&db.conn)
            .await
            .unwrap()
            .len()
    }

    #[tokio::test]
    async fn send_prompt_linked_uses_caller_conversation_id_when_provided() {
        use crate::db::test_helpers;
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/caller-id").await;
        // Pre-create a conversation row the caller will reference.
        let pre_existing =
            conversation_service::create(&db.conn, folder_id, AgentType::ClaudeCode, None, None)
                .await
                .unwrap();

        let mgr = ConnectionManager::new();
        let (broadcaster, _rx) = make_test_broadcaster();
        let conn_id = "conn-caller-id";
        insert_fake_connection(
            &mgr,
            conn_id,
            AgentType::ClaudeCode,
            Some(PathBuf::from("/tmp/caller-id")),
            EventEmitter::test_web_only(broadcaster.clone()),
        )
        .await;
        let mut rx = subscribe_conn_stream(&mgr, conn_id).await;

        // Count rows before
        let before = count_conversation_rows(&db).await;

        // Send with caller-supplied conversation_id + folder_id.
        let _ = mgr
            .send_prompt_linked(
                &db,
                conn_id,
                one_text_block(),
                Some(folder_id),
                Some(pre_existing.id),
                None,
            )
            .await;

        // No new conversation row was created.
        let after = count_conversation_rows(&db).await;
        assert_eq!(after, before, "no new row should be created");

        // State now has the caller-supplied conversation_id.
        let state = mgr.get_state(conn_id).await.unwrap();
        assert_eq!(state.read().await.conversation_id, Some(pre_existing.id));

        // ConversationLinked event was emitted with the caller's id.
        let env = recv_first_acp_event(&mut rx).await;
        match env.payload {
            AcpEvent::ConversationLinked {
                conversation_id,
                folder_id: emitted_folder,
                ..
            } => {
                assert_eq!(conversation_id, pre_existing.id);
                assert_eq!(emitted_folder, folder_id);
            }
            other => panic!("expected ConversationLinked, got {other:?}"),
        }
    }

    /// Drain the global broadcaster and report whether a `conversation://changed`
    /// upsert for `id` carrying `external_id` was emitted.
    fn drain_has_upsert_with_external_id(
        rx: &mut broadcast::Receiver<WebEvent>,
        id: i32,
        external_id: &str,
    ) -> bool {
        while let Ok(evt) = rx.try_recv() {
            if evt.channel != crate::web::event_bridge::CONVERSATION_CHANGED_EVENT {
                continue;
            }
            let p = &*evt.payload;
            if p["kind"] == "upsert"
                && p["summary"]["id"] == id
                && p["summary"]["external_id"] == external_id
            {
                return true;
            }
        }
        false
    }

    #[tokio::test]
    async fn send_prompt_linked_session_started_before_link_broadcasts_external_id_branch_b() {
        // SessionStarted-before-link: external_id is already on the live state
        // but no conversation_id yet, so the lifecycle subscriber skipped its
        // broadcast. The synchronous external_id persist inside
        // send_prompt_linked (backend-create Branch B) must itself emit a
        // corrective `conversation://changed` upsert so other clients converge.
        use crate::db::test_helpers;
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/sess-pre-b").await;
        let mgr = ConnectionManager::new();
        let (broadcaster, mut rx) = make_test_broadcaster();
        let conn_id = "conn-sess-pre-b";
        insert_fake_connection(
            &mgr,
            conn_id,
            AgentType::ClaudeCode,
            Some(PathBuf::from("/tmp/sess-pre-b")),
            EventEmitter::test_web_only(broadcaster.clone()),
        )
        .await;
        {
            let state = mgr.get_state(conn_id).await.unwrap();
            state.write().await.external_id = Some("ext-pre".to_string());
        }

        // cmd_tx receiver is dropped → the prompt send fails after linking, but
        // the link + external_id persist + broadcast already happened.
        let _ = mgr
            .send_prompt_linked(&db, conn_id, one_text_block(), Some(folder_id), None, None)
            .await;

        let cid = mgr
            .get_state(conn_id)
            .await
            .unwrap()
            .read()
            .await
            .conversation_id
            .expect("conversation should be linked");
        let row = conversation_service::get_by_id(&db.conn, cid)
            .await
            .unwrap();
        assert_eq!(row.external_id.as_deref(), Some("ext-pre"));
        assert!(
            drain_has_upsert_with_external_id(&mut rx, cid, "ext-pre"),
            "Branch B must broadcast a conversation://changed upsert carrying external_id"
        );
    }

    #[tokio::test]
    async fn send_prompt_linked_session_started_before_link_broadcasts_external_id_branch_a() {
        // Same precondition, caller-supplied conversation_id (adopt Branch A).
        use crate::db::test_helpers;
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/sess-pre-a").await;
        let pre =
            conversation_service::create(&db.conn, folder_id, AgentType::ClaudeCode, None, None)
                .await
                .unwrap();
        let mgr = ConnectionManager::new();
        let (broadcaster, mut rx) = make_test_broadcaster();
        let conn_id = "conn-sess-pre-a";
        insert_fake_connection(
            &mgr,
            conn_id,
            AgentType::ClaudeCode,
            Some(PathBuf::from("/tmp/sess-pre-a")),
            EventEmitter::test_web_only(broadcaster.clone()),
        )
        .await;
        {
            let state = mgr.get_state(conn_id).await.unwrap();
            state.write().await.external_id = Some("ext-pre-a".to_string());
        }

        let _ = mgr
            .send_prompt_linked(
                &db,
                conn_id,
                one_text_block(),
                Some(folder_id),
                Some(pre.id),
                None,
            )
            .await;

        let row = conversation_service::get_by_id(&db.conn, pre.id)
            .await
            .unwrap();
        assert_eq!(row.external_id.as_deref(), Some("ext-pre-a"));
        assert!(
            drain_has_upsert_with_external_id(&mut rx, pre.id, "ext-pre-a"),
            "Branch A must broadcast a conversation://changed upsert carrying external_id"
        );
    }

    #[tokio::test]
    async fn send_prompt_linked_rejects_conversation_id_without_folder_id() {
        use crate::db::test_helpers;
        let db = test_helpers::fresh_in_memory_db().await;
        let mgr = ConnectionManager::new();
        let (broadcaster, _rx) = make_test_broadcaster();
        let conn_id = "conn-bad-args";
        insert_fake_connection(
            &mgr,
            conn_id,
            AgentType::ClaudeCode,
            Some(PathBuf::from("/tmp/x")),
            EventEmitter::test_web_only(broadcaster),
        )
        .await;

        let err = mgr
            .send_prompt_linked(&db, conn_id, one_text_block(), None, Some(42), None)
            .await
            .expect_err("should reject conversation_id without folder_id");
        assert!(matches!(err, AcpError::Protocol(_)));
    }

    #[tokio::test]
    async fn send_prompt_linked_caller_id_is_noop_when_already_linked() {
        use crate::db::test_helpers;
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/already").await;
        let pre =
            conversation_service::create(&db.conn, folder_id, AgentType::ClaudeCode, None, None)
                .await
                .unwrap();

        let mgr = ConnectionManager::new();
        let (broadcaster, _rx) = make_test_broadcaster();
        let conn_id = "conn-already";
        insert_fake_connection(
            &mgr,
            conn_id,
            AgentType::ClaudeCode,
            Some(PathBuf::from("/tmp/already")),
            EventEmitter::test_web_only(broadcaster.clone()),
        )
        .await;
        // Pre-link the connection state.
        {
            let state = mgr.get_state(conn_id).await.unwrap();
            state.write().await.conversation_id = Some(pre.id);
        }
        let mut rx = subscribe_conn_stream(&mgr, conn_id).await;

        let before = count_conversation_rows(&db).await;
        let _ = mgr
            .send_prompt_linked(
                &db,
                conn_id,
                one_text_block(),
                Some(folder_id),
                Some(pre.id),
                None,
            )
            .await;
        let after = count_conversation_rows(&db).await;
        assert_eq!(after, before);

        // No ConversationLinked event was emitted (already linked). The
        // centralized status transition fires InProgress; then because the
        // dropped cmd_tx receiver makes `send_prompt_inner` return
        // ProcessExited, the rollback path fires Cancelled. Two events,
        // strictly ordered.
        let env_in_progress = recv_first_acp_event(&mut rx).await;
        match env_in_progress.payload {
            AcpEvent::ConversationStatusChanged {
                conversation_id,
                status,
            } => {
                assert_eq!(conversation_id, pre.id);
                assert_eq!(status, ConversationStatus::InProgress);
            }
            other => {
                panic!("first event must be ConversationStatusChanged(InProgress), got {other:?}")
            }
        }
        let env_cancelled = recv_first_acp_event(&mut rx).await;
        match env_cancelled.payload {
            AcpEvent::ConversationStatusChanged {
                conversation_id,
                status,
            } => {
                assert_eq!(conversation_id, pre.id);
                assert_eq!(status, ConversationStatus::Cancelled);
            }
            other => panic!(
                "second event must be ConversationStatusChanged(Cancelled) after send failure, got {other:?}"
            ),
        }
    }

    // ---------- Phase: status centralization ----------

    #[tokio::test]
    async fn send_prompt_linked_writes_in_progress_and_emits_event() {
        use crate::db::entities::conversation;
        use crate::db::test_helpers;
        use sea_orm::EntityTrait;

        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/status").await;

        let mgr = ConnectionManager::new();
        let (broadcaster, _rx) = make_test_broadcaster();
        let conn_id = "conn-status-1";
        insert_fake_connection(
            &mgr,
            conn_id,
            AgentType::ClaudeCode,
            Some(PathBuf::from("/tmp/status")),
            EventEmitter::test_web_only(broadcaster.clone()),
        )
        .await;
        let mut rx = subscribe_conn_stream(&mgr, conn_id).await;

        // First call: backend creates the conversation row and links it.
        // The cmd_tx receiver in `insert_fake_connection` has been dropped,
        // so `send_prompt_inner` returns ProcessExited — exercising the new
        // Cancelled-rollback path. We expect THREE events in order:
        //   1. ConversationLinked
        //   2. ConversationStatusChanged(InProgress)  [pre-send write]
        //   3. ConversationStatusChanged(Cancelled)   [rollback after send failure]
        let _ = mgr
            .send_prompt_linked(&db, conn_id, one_text_block(), Some(folder_id), None, None)
            .await;

        let env1 = recv_first_acp_event(&mut rx).await;
        let conv_id = match env1.payload {
            AcpEvent::ConversationLinked {
                conversation_id,
                folder_id: emitted_folder,
                ..
            } => {
                assert_eq!(emitted_folder, folder_id);
                conversation_id
            }
            other => panic!("first event must be ConversationLinked, got {other:?}"),
        };
        let env2 = recv_first_acp_event(&mut rx).await;
        match env2.payload {
            AcpEvent::ConversationStatusChanged {
                conversation_id,
                status,
            } => {
                assert_eq!(conversation_id, conv_id);
                assert_eq!(status, ConversationStatus::InProgress);
            }
            other => {
                panic!("second event must be ConversationStatusChanged(InProgress), got {other:?}")
            }
        }
        let env3 = recv_first_acp_event(&mut rx).await;
        match env3.payload {
            AcpEvent::ConversationStatusChanged {
                conversation_id,
                status,
            } => {
                assert_eq!(conversation_id, conv_id);
                assert_eq!(status, ConversationStatus::Cancelled);
            }
            other => panic!(
                "third event must be ConversationStatusChanged(Cancelled) on send failure, got {other:?}"
            ),
        }
        // Ordering invariant: ConversationLinked < InProgress < Cancelled.
        assert!(
            env2.seq > env1.seq && env3.seq > env2.seq,
            "event seqs must be strictly monotonic: linked={} in_progress={} cancelled={}",
            env1.seq,
            env2.seq,
            env3.seq
        );

        // DB row settles at Cancelled (the rollback after send failure). The
        // intermediate InProgress write is observable only via the event,
        // not by the time the test reads the row.
        let row = conversation::Entity::find_by_id(conv_id)
            .one(&db.conn)
            .await
            .unwrap()
            .expect("conversation row exists");
        assert_eq!(row.status, ConversationStatus::Cancelled);

        // Second send: already-linked path also writes + emits InProgress
        // and then Cancelled (same send-failure rollback). Pre-flip the row
        // to PendingReview to observe the transition flip forward — mirrors
        // the "follow-up turn after a TurnComplete" scenario.
        conversation_service::update_status(&db.conn, conv_id, ConversationStatus::PendingReview)
            .await
            .unwrap();

        let _ = mgr
            .send_prompt_linked(&db, conn_id, one_text_block(), Some(folder_id), None, None)
            .await;

        let env4 = recv_first_acp_event(&mut rx).await;
        match env4.payload {
            AcpEvent::ConversationStatusChanged {
                conversation_id,
                status,
            } => {
                assert_eq!(conversation_id, conv_id);
                assert_eq!(status, ConversationStatus::InProgress);
            }
            other => panic!(
                "second send must re-emit ConversationStatusChanged(InProgress) first, got {other:?}"
            ),
        }
        let env5 = recv_first_acp_event(&mut rx).await;
        match env5.payload {
            AcpEvent::ConversationStatusChanged {
                conversation_id,
                status,
            } => {
                assert_eq!(conversation_id, conv_id);
                assert_eq!(status, ConversationStatus::Cancelled);
            }
            other => {
                panic!("second send must rollback to Cancelled after send failure, got {other:?}")
            }
        }
        let row2 = conversation::Entity::find_by_id(conv_id)
            .one(&db.conn)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row2.status, ConversationStatus::Cancelled);
    }

    // ---------- Phase: connection dedup ----------

    #[tokio::test]
    async fn find_connection_for_reuse_returns_none_when_session_id_is_none() {
        let mgr = ConnectionManager::new();
        let (broadcaster, _rx) = make_test_broadcaster();
        // Insert a connection that *would* match if session_id were Some.
        let id = "c1";
        insert_fake_connection(
            &mgr,
            id,
            AgentType::ClaudeCode,
            Some(PathBuf::from("/tmp/reuse")),
            EventEmitter::test_web_only(broadcaster),
        )
        .await;
        {
            let state = mgr.get_state(id).await.unwrap();
            state.write().await.external_id = Some("ext-1".into());
        }
        let found = mgr
            .find_connection_for_reuse(
                AgentType::ClaudeCode,
                Some(&PathBuf::from("/tmp/reuse")),
                None,
            )
            .await;
        assert!(
            found.is_none(),
            "no session_id means we never dedup speculative connects"
        );
    }

    #[tokio::test]
    async fn spawn_agent_reuses_existing_connection_when_session_id_matches() {
        // Direct unit test for the lookup helper that spawn_agent calls
        // before its (process-spawning) block. We test the helper directly so
        // the test never tries to launch an agent process.
        let mgr = ConnectionManager::new();
        let (broadcaster, _rx) = make_test_broadcaster();
        let existing_id = "preexisting-conn";
        let working_dir = PathBuf::from("/tmp/reuse-match");
        insert_fake_connection(
            &mgr,
            existing_id,
            AgentType::ClaudeCode,
            Some(working_dir.clone()),
            EventEmitter::test_web_only(broadcaster.clone()),
        )
        .await;
        {
            let state = mgr.get_state(existing_id).await.unwrap();
            let mut s = state.write().await;
            s.external_id = Some("ext-1".into());
            s.status = ConnectionStatus::Connected;
        }

        // Same session_id + same agent + same working_dir -> reuse.
        let found = mgr
            .find_connection_for_reuse(AgentType::ClaudeCode, Some(&working_dir), Some("ext-1"))
            .await;
        assert_eq!(found.as_deref(), Some(existing_id));

        // Different session_id -> no reuse.
        assert!(mgr
            .find_connection_for_reuse(AgentType::ClaudeCode, Some(&working_dir), Some("other-ext"))
            .await
            .is_none());

        // Different working_dir -> no reuse.
        assert!(mgr
            .find_connection_for_reuse(
                AgentType::ClaudeCode,
                Some(&PathBuf::from("/tmp/different")),
                Some("ext-1")
            )
            .await
            .is_none());

        // Different agent_type -> no reuse.
        assert!(mgr
            .find_connection_for_reuse(AgentType::Codex, Some(&working_dir), Some("ext-1"))
            .await
            .is_none());
    }

    #[tokio::test]
    async fn find_connection_for_reuse_skips_disconnected_or_errored() {
        let mgr = ConnectionManager::new();
        let (broadcaster, _rx) = make_test_broadcaster();
        let working_dir = PathBuf::from("/tmp/torn-down");
        insert_fake_connection(
            &mgr,
            "torn",
            AgentType::ClaudeCode,
            Some(working_dir.clone()),
            EventEmitter::test_web_only(broadcaster.clone()),
        )
        .await;
        {
            let state = mgr.get_state("torn").await.unwrap();
            let mut s = state.write().await;
            s.external_id = Some("ext-1".into());
            s.status = ConnectionStatus::Disconnected;
        }
        assert!(
            mgr.find_connection_for_reuse(
                AgentType::ClaudeCode,
                Some(&working_dir),
                Some("ext-1"),
            )
            .await
            .is_none(),
            "Disconnected connection must not be reused"
        );

        // Flip to Error — also excluded.
        {
            let state = mgr.get_state("torn").await.unwrap();
            state.write().await.status = ConnectionStatus::Error;
        }
        assert!(
            mgr.find_connection_for_reuse(
                AgentType::ClaudeCode,
                Some(&working_dir),
                Some("ext-1"),
            )
            .await
            .is_none(),
            "Errored connection must not be reused"
        );
    }

    /// Helper that backdates a connection's `last_activity_at` so the
    /// idle sweep sees it as having crossed its threshold.
    async fn backdate_last_activity(mgr: &ConnectionManager, conn_id: &str, secs_ago: i64) {
        let state = mgr.get_state(conn_id).await.expect("connection exists");
        let mut s = state.write().await;
        s.last_activity_at = chrono::Utc::now() - chrono::Duration::seconds(secs_ago);
    }

    #[tokio::test]
    async fn sweep_idle_disconnects_idle_connected_connections() {
        let mgr = ConnectionManager::new();
        insert_fake_connection(
            &mgr,
            "stale",
            AgentType::ClaudeCode,
            Some(PathBuf::from("/tmp/stale")),
            EventEmitter::Noop,
        )
        .await;
        backdate_last_activity(&mgr, "stale", 600).await;

        let n = mgr.sweep_idle(Duration::from_secs(300)).await;
        assert_eq!(n, 1);
        assert!(
            mgr.connections.lock().await.get("stale").is_none(),
            "Idle connection must be removed after sweep"
        );
    }

    #[tokio::test]
    async fn sweep_idle_skips_recently_active_connection() {
        let mgr = ConnectionManager::new();
        insert_fake_connection(
            &mgr,
            "fresh",
            AgentType::ClaudeCode,
            None,
            EventEmitter::Noop,
        )
        .await;
        // last_activity_at defaults to "now" inside SessionState::new — no
        // backdating, so it should NOT be swept.
        let n = mgr.sweep_idle(Duration::from_secs(300)).await;
        assert_eq!(n, 0);
        assert!(mgr.connections.lock().await.contains_key("fresh"));
    }

    #[tokio::test]
    async fn sweep_idle_skips_prompting_connection() {
        let mgr = ConnectionManager::new();
        insert_fake_connection(
            &mgr,
            "prompting",
            AgentType::ClaudeCode,
            None,
            EventEmitter::Noop,
        )
        .await;
        backdate_last_activity(&mgr, "prompting", 600).await;
        // Override status to Prompting — a turn is in flight; never sweep.
        {
            let state = mgr.get_state("prompting").await.unwrap();
            state.write().await.status = ConnectionStatus::Prompting;
        }
        let n = mgr.sweep_idle(Duration::from_secs(300)).await;
        assert_eq!(n, 0);
        assert!(mgr.connections.lock().await.contains_key("prompting"));
    }

    #[tokio::test]
    async fn sweep_idle_skips_pending_permission() {
        use crate::acp::session_state::PendingPermissionState;
        let mgr = ConnectionManager::new();
        insert_fake_connection(
            &mgr,
            "permission",
            AgentType::ClaudeCode,
            None,
            EventEmitter::Noop,
        )
        .await;
        backdate_last_activity(&mgr, "permission", 600).await;
        {
            let state = mgr.get_state("permission").await.unwrap();
            state.write().await.pending_permission = Some(PendingPermissionState {
                request_id: "req-1".into(),
                tool_call_id: "tc-1".into(),
                tool_call: serde_json::json!({ "toolCallId": "tc-1", "title": "test" }),
                options: vec![],
                created_at: chrono::Utc::now(),
                queued: 0,
            });
        }
        let n = mgr.sweep_idle(Duration::from_secs(300)).await;
        assert_eq!(
            n, 0,
            "Connection with pending permission must not be swept (user is mid-decision)"
        );
        assert!(mgr.connections.lock().await.contains_key("permission"));
    }

    #[tokio::test]
    async fn sweep_idle_skips_active_background_work() {
        let mgr = ConnectionManager::new();
        insert_fake_connection(
            &mgr,
            "background",
            AgentType::ClaudeCode,
            None,
            EventEmitter::Noop,
        )
        .await;
        backdate_last_activity(&mgr, "background", 600).await;
        {
            let state = mgr.get_state("background").await.unwrap();
            let mut state = state.write().await;
            // Mirror what apply_event(BackgroundActivity) records: pending
            // work plus a recent watcher heartbeat.
            state.background_outstanding = 1;
            state.background_activity_at = Some(chrono::Utc::now());
        }
        let n = mgr.sweep_idle(Duration::from_secs(300)).await;
        assert_eq!(
            n, 0,
            "Connection with unresolved background work must not be swept \
             (disconnecting kills the agent CLI and the background task with it)"
        );
        assert!(mgr.connections.lock().await.contains_key("background"));

        // Once the watcher settles the work (outstanding back to 0), the same
        // connection becomes sweepable again.
        {
            let state = mgr.get_state("background").await.unwrap();
            let mut state = state.write().await;
            state.background_outstanding = 0;
            state.last_activity_at = chrono::Utc::now() - chrono::Duration::seconds(600);
        }
        let n = mgr.sweep_idle(Duration::from_secs(300)).await;
        assert_eq!(n, 1, "settled background work no longer exempts the sweep");
    }

    #[tokio::test]
    async fn sweep_idle_picks_only_qualifying_subset() {
        let mgr = ConnectionManager::new();
        for id in ["a", "b", "c"] {
            insert_fake_connection(&mgr, id, AgentType::ClaudeCode, None, EventEmitter::Noop).await;
        }
        // a: idle (sweep target), b: fresh (not idle), c: idle but Prompting (skipped).
        backdate_last_activity(&mgr, "a", 600).await;
        backdate_last_activity(&mgr, "c", 600).await;
        {
            let state = mgr.get_state("c").await.unwrap();
            state.write().await.status = ConnectionStatus::Prompting;
        }
        let n = mgr.sweep_idle(Duration::from_secs(300)).await;
        assert_eq!(n, 1);
        let map = mgr.connections.lock().await;
        assert!(!map.contains_key("a"));
        assert!(map.contains_key("b"));
        assert!(map.contains_key("c"));
    }

    /// When two `spawn_agent` calls race for the same logical session id,
    /// the per-key dedup mutex makes the second one observe the first's
    /// freshly-spawned connection and reuse it. Without the mutex, both
    /// would have missed dedup during the connecting window.
    ///
    /// Simulates the race by pre-inserting a "first call's connection" with
    /// `external_id` set; what's tested is that two concurrent
    /// `find_connection_for_reuse` calls under the same lock see consistent
    /// state. The `spawn_locks` map being shared via `clone_ref` is the
    /// invariant we need.
    #[tokio::test]
    async fn spawn_locks_are_shared_across_clone_ref() {
        let mgr = ConnectionManager::new();
        let cloned = mgr.clone_ref();
        // Both clones must reference the same map. Insert via one,
        // observe via the other.
        let key = SpawnDedupKey {
            agent_type: AgentType::ClaudeCode,
            working_dir: Some(PathBuf::from("/tmp/dedup-test")),
            session_id: "ext-shared".into(),
        };
        {
            let mut locks = mgr.spawn_locks.lock().await;
            locks
                .entry(key.clone())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())));
        }
        let cloned_locks = cloned.spawn_locks.lock().await;
        assert!(
            cloned_locks.contains_key(&key),
            "spawn_locks must be shared between original and clone_ref"
        );
    }

    /// Two concurrent `send_prompt_linked` calls on the SAME connection
    /// must serialize through the per-connection `prompt_lock` so the
    /// backend-creates branch can't fire twice and produce duplicate
    /// conversation rows. The second call observes `already_linked == true`
    /// (set by the first under the lock) and skips creation.
    #[tokio::test]
    async fn send_prompt_linked_serializes_concurrent_callers() {
        use crate::db::test_helpers;
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/race").await;

        let mgr = Arc::new(ConnectionManager::new());
        let conn_id = "race-conn";
        {
            let mut map = mgr.connections.lock().await;
            map.insert(conn_id.into(), fake_connection(conn_id, None));
        }

        let before = count_conversation_rows(&db).await;
        // tokio::join! polls the two futures concurrently in the SAME
        // task — they can borrow `&db` and `mgr` without the 'static
        // requirement that `tokio::spawn` would impose.
        let mgr_ref = mgr.as_ref();
        tokio::join!(
            async {
                let _ = mgr_ref
                    .send_prompt_linked(&db, conn_id, one_text_block(), Some(folder_id), None, None)
                    .await;
            },
            async {
                let _ = mgr_ref
                    .send_prompt_linked(&db, conn_id, one_text_block(), Some(folder_id), None, None)
                    .await;
            },
        );

        let after = count_conversation_rows(&db).await;
        assert_eq!(
            after - before,
            1,
            "exactly one new conversation row across two concurrent send_prompt_linked"
        );
    }

    // ---------- Phase: spawn handshake wait helper ----------

    #[tokio::test]
    async fn wait_for_session_started_returns_ready_when_sender_fires() {
        let (tx, rx) = tokio::sync::oneshot::channel();
        // Fire immediately on a separate task so the wait future actually
        // gets to register.
        tokio::spawn(async move {
            let _ = tx.send(());
        });
        let (outcome, elapsed) = wait_for_session_started(rx, Duration::from_millis(500)).await;
        assert_eq!(outcome, HandshakeWaitOutcome::Ready);
        assert!(
            elapsed < Duration::from_millis(500),
            "Ready outcome must resolve well before timeout, got {elapsed:?}"
        );
    }

    #[tokio::test]
    async fn wait_for_session_started_returns_aborted_when_sender_drops() {
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        // Drop the sender — emulates "connection died before SessionStarted",
        // i.e. SessionState's tx was dropped during cleanup.
        drop(tx);
        let (outcome, elapsed) = wait_for_session_started(rx, Duration::from_millis(500)).await;
        assert_eq!(outcome, HandshakeWaitOutcome::Aborted);
        assert!(
            elapsed < Duration::from_millis(500),
            "Aborted outcome must resolve well before timeout, got {elapsed:?}"
        );
    }

    #[tokio::test]
    async fn wait_for_session_started_returns_timed_out_when_neither_happens() {
        let (_tx, rx) = tokio::sync::oneshot::channel::<()>();
        // Hold the sender alive but never fire and never drop. Tight
        // timeout so the test stays fast; production timeout is 60s.
        let (outcome, elapsed) = wait_for_session_started(rx, Duration::from_millis(40)).await;
        assert_eq!(outcome, HandshakeWaitOutcome::TimedOut);
        assert!(
            elapsed >= Duration::from_millis(40),
            "TimedOut must wait at least the full timeout, got {elapsed:?}"
        );
    }

    #[test]
    fn spawn_handshake_timeout_from_env_uses_default_when_unset() {
        // Snapshot env, mutate, restore. Single test owns this var to avoid
        // cross-test contention.
        let prev = std::env::var("CODEG_ACP_SPAWN_HANDSHAKE_TIMEOUT_SECS").ok();
        std::env::remove_var("CODEG_ACP_SPAWN_HANDSHAKE_TIMEOUT_SECS");
        let default = spawn_handshake_timeout_from_env();
        assert_eq!(default, Duration::from_secs(SPAWN_HANDSHAKE_TIMEOUT_SECS));

        std::env::set_var("CODEG_ACP_SPAWN_HANDSHAKE_TIMEOUT_SECS", "5");
        assert_eq!(spawn_handshake_timeout_from_env(), Duration::from_secs(5));

        std::env::set_var("CODEG_ACP_SPAWN_HANDSHAKE_TIMEOUT_SECS", "garbage");
        assert_eq!(
            spawn_handshake_timeout_from_env(),
            Duration::from_secs(SPAWN_HANDSHAKE_TIMEOUT_SECS),
            "invalid value falls back to default"
        );

        // Restore.
        match prev {
            Some(v) => std::env::set_var("CODEG_ACP_SPAWN_HANDSHAKE_TIMEOUT_SECS", v),
            None => std::env::remove_var("CODEG_ACP_SPAWN_HANDSHAKE_TIMEOUT_SECS"),
        }
    }

    #[test]
    fn with_spawn_handshake_timeout_overrides_default_for_tests() {
        let mgr = ConnectionManager::with_spawn_handshake_timeout(Duration::from_secs(7));
        assert_eq!(mgr.spawn_handshake_timeout, Duration::from_secs(7));
    }

    /// When `send_prompt_inner` fails (process gone, channel closed) the row
    /// must end up `Cancelled`, NOT stuck on `in_progress`. Without this
    /// rollback the lifecycle subscriber's TurnComplete write never fires
    /// (no turn ever started), so the only thing that could later un-stick
    /// the row is a follow-up prompt happening to succeed — fragile, and on
    /// the server-side / chat-channel paths there may be no follow-up at all.
    #[tokio::test]
    async fn send_prompt_linked_rolls_back_to_cancelled_on_send_failure() {
        use crate::db::entities::conversation;
        use crate::db::test_helpers;
        use sea_orm::EntityTrait;

        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/cancel-rollback").await;

        let mgr = ConnectionManager::new();
        let (broadcaster, _rx) = make_test_broadcaster();
        let conn_id = "conn-cancel";
        // insert_fake_connection drops the cmd_tx receiver, so send_prompt_inner
        // returns ProcessExited — exactly the failure mode this test targets.
        insert_fake_connection(
            &mgr,
            conn_id,
            AgentType::ClaudeCode,
            Some(PathBuf::from("/tmp/cancel-rollback")),
            EventEmitter::test_web_only(broadcaster.clone()),
        )
        .await;
        let mut rx = subscribe_conn_stream(&mgr, conn_id).await;

        // Non-empty blocks so the send reaches `reserve()` (which fails on the
        // dropped receiver → ProcessExited); an empty prompt would be rejected
        // earlier, before the gate, and never exercise this rollback path.
        let result = mgr
            .send_prompt_linked(
                &db,
                conn_id,
                vec![PromptInputBlock::Text {
                    text: "trigger send failure".into(),
                }],
                Some(folder_id),
                None,
                None,
            )
            .await;
        assert!(
            matches!(result, Err(AcpError::ProcessExited)),
            "send_prompt_inner must propagate ProcessExited up to the caller; got {result:?}"
        );

        // Drain events: ConversationLinked → InProgress → Cancelled, in order.
        let env_linked = recv_first_acp_event(&mut rx).await;
        let conv_id = match env_linked.payload {
            AcpEvent::ConversationLinked {
                conversation_id, ..
            } => conversation_id,
            other => panic!("expected ConversationLinked first, got {other:?}"),
        };
        let env_in_progress = recv_first_acp_event(&mut rx).await;
        match env_in_progress.payload {
            AcpEvent::ConversationStatusChanged { status, .. } => {
                assert_eq!(status, ConversationStatus::InProgress);
            }
            other => {
                panic!("expected ConversationStatusChanged(InProgress) before send, got {other:?}")
            }
        }
        let env_cancelled = recv_first_acp_event(&mut rx).await;
        match env_cancelled.payload {
            AcpEvent::ConversationStatusChanged {
                conversation_id,
                status,
            } => {
                assert_eq!(conversation_id, conv_id);
                assert_eq!(
                    status,
                    ConversationStatus::Cancelled,
                    "send_prompt failure must roll the row forward to Cancelled, not leave InProgress"
                );
            }
            other => panic!(
                "expected ConversationStatusChanged(Cancelled) on send failure, got {other:?}"
            ),
        }

        // Strict ordering: linked < in_progress < cancelled. The lifecycle
        // contract says the Cancelled emit cannot precede the InProgress one
        // — UIs that animate based on "previous → current" depend on this.
        assert!(
            env_in_progress.seq > env_linked.seq && env_cancelled.seq > env_in_progress.seq,
            "event seq must be strictly monotonic: linked={} in_progress={} cancelled={}",
            env_linked.seq,
            env_in_progress.seq,
            env_cancelled.seq,
        );

        // DB row settles at Cancelled — final ground truth read.
        let row = conversation::Entity::find_by_id(conv_id)
            .one(&db.conn)
            .await
            .unwrap()
            .expect("conversation row exists");
        assert_eq!(row.status, ConversationStatus::Cancelled);
    }

    // ---------- fork_session ----------

    /// Build a connection whose cmd_rx is drained by a spawned task that
    /// fakes the protocol-level fork reply. Returns the manager so the test
    /// can call `fork_session`. The fake reply task lives until it processes
    /// one Fork command, then exits.
    async fn manager_with_fake_fork(
        conn_id: &str,
        conversation_id: i32,
        forked_session_id: &str,
        original_session_id: &str,
    ) -> (Arc<ConnectionManager>, tokio::task::JoinHandle<()>) {
        use crate::acp::connection::ConnectionCommand;
        let (tx, mut rx) = mpsc::channel::<ConnectionCommand>(4);
        let mut state = SessionState::new(
            conn_id.to_string(),
            crate::models::agent::AgentType::ClaudeCode,
            None,
            "test-window".to_string(),
            None,
        );
        state.conversation_id = Some(conversation_id);
        state.status = ConnectionStatus::Connected;
        let conn = AgentConnection {
            id: conn_id.to_string(),
            agent_type: crate::models::agent::AgentType::ClaudeCode,
            status: ConnectionStatus::Connected,
            owner_window_label: "test-window".to_string(),
            cmd_tx: tx,
            state: Arc::new(RwLock::new(state)),
            emitter: EventEmitter::Noop,
            prompt_lock: Arc::new(tokio::sync::Mutex::new(())),
            config_fingerprint: String::new(),
            last_observed_fingerprint: String::new(),
            child_pid: Arc::new(std::sync::atomic::AtomicU32::new(0)),
        };
        let mgr = Arc::new(ConnectionManager::new());
        {
            let mut map = mgr.connections.lock().await;
            map.insert(conn_id.to_string(), conn);
        }

        let forked = forked_session_id.to_string();
        let original = original_session_id.to_string();
        let join = tokio::spawn(async move {
            while let Some(cmd) = rx.recv().await {
                if let ConnectionCommand::Fork { reply, .. } = cmd {
                    let _ = reply.send(Ok(crate::acp::types::ForkProtocolResult {
                        forked_session_id: forked.clone(),
                        original_session_id: original.clone(),
                    }));
                    return;
                }
            }
        });
        (mgr, join)
    }

    #[tokio::test]
    async fn fork_session_writes_atomic_two_row_layout() {
        use crate::db::test_helpers;
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/fork-happy").await;

        // Pre-existing row: stands in for the conversation about to be forked.
        // Title gets a `[Fork] ` prefix; sibling row inherits the clean title.
        let pre = conversation_service::create(
            &db.conn,
            folder_id,
            AgentType::ClaudeCode,
            Some("Original Topic".into()),
            Some("feature/x".into()),
        )
        .await
        .unwrap();
        // External_id starts as S1 — manager.fork_session will swap to S2.
        conversation_service::bind_external_id(&db.conn, pre.id, "session-S1", &[])
            .await
            .unwrap();

        let (mgr, join) =
            manager_with_fake_fork("c-fork", pre.id, "session-S2", "session-S1").await;
        let result = mgr
            .fork_session(&db, "c-fork", None, None, None)
            .await
            .expect("fork_session should succeed");
        let _ = join.await;

        assert_eq!(result.forked_session_id, "session-S2");
        assert_eq!(result.original_session_id, "session-S1");
        let sibling_id = result.sibling_conversation_id;
        assert_ne!(sibling_id, pre.id, "sibling row must be a fresh row");

        // Current row: external_id=S2, title prefixed.
        let current = conversation_service::get_by_id(&db.conn, pre.id)
            .await
            .unwrap();
        assert_eq!(current.external_id.as_deref(), Some("session-S2"));
        assert_eq!(current.title.as_deref(), Some("[Fork] Original Topic"));

        // Sibling row: external_id=S1, clean title, PendingReview, same folder/git_branch.
        let sibling = conversation_service::get_by_id(&db.conn, sibling_id)
            .await
            .unwrap();
        assert_eq!(sibling.external_id.as_deref(), Some("session-S1"));
        assert_eq!(sibling.title.as_deref(), Some("Original Topic"));
        assert_eq!(sibling.status, "pending_review");
        assert_eq!(sibling.folder_id, folder_id);
        assert_eq!(sibling.git_branch.as_deref(), Some("feature/x"));
    }

    #[tokio::test]
    async fn fork_session_strips_existing_fork_prefix_without_stacking() {
        use crate::db::test_helpers;
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/fork-restack").await;

        // Title already has `[Fork] ` — re-fork must not produce `[Fork] [Fork] ...`.
        let pre = conversation_service::create(
            &db.conn,
            folder_id,
            AgentType::ClaudeCode,
            Some("[Fork] Topic".into()),
            None,
        )
        .await
        .unwrap();
        let (mgr, join) =
            manager_with_fake_fork("c-restack", pre.id, "session-S2", "session-S1").await;
        let result = mgr.fork_session(&db, "c-restack", None, None, None).await.unwrap();
        let _ = join.await;

        let current = conversation_service::get_by_id(&db.conn, pre.id)
            .await
            .unwrap();
        assert_eq!(
            current.title.as_deref(),
            Some("[Fork] Topic"),
            "should re-stack as single [Fork] prefix, not [Fork] [Fork] ..."
        );
        let sibling = conversation_service::get_by_id(&db.conn, result.sibling_conversation_id)
            .await
            .unwrap();
        assert_eq!(sibling.title.as_deref(), Some("Topic"));
    }

    #[tokio::test]
    async fn fork_session_adopts_a_sibling_the_lifecycle_subscriber_already_made() {
        // Fork's reply reaches us BEFORE `handle_fork_or_exit` emits
        // `SessionStarted{S2}`, so this persistence and the lifecycle worker
        // (which retries with backoff) run concurrently. If the lifecycle side
        // lands first, its guarded `bind_external_id` has already preserved S1
        // on a row of its own.
        //
        // Inserting a second S1 row then is not a cosmetic duplicate:
        // `(external_id, agent_type)` is UNIQUE, so the INSERT fails and rolls
        // back the entire fork — the user's fork just breaks. Adopt the
        // existing row instead, and return ITS id, because the caller puts that
        // id straight into the fork result and the sidebar upsert.
        use crate::db::test_helpers;
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/fork-raced").await;

        let pre = conversation_service::create(
            &db.conn,
            folder_id,
            AgentType::ClaudeCode,
            Some("Topic".into()),
            None,
        )
        .await
        .unwrap();
        conversation_service::bind_external_id(&db.conn, pre.id, "session-S1", &[])
            .await
            .unwrap();
        // Lifecycle got there first: S2 landed on the row and S1 was preserved.
        let preserved_id = conversation_service::bind_external_id(&db.conn, pre.id, "session-S2", &[])
            .await
            .unwrap()
            .expect("the lifecycle bind preserves S1");

        let (mgr, join) =
            manager_with_fake_fork("c-raced", pre.id, "session-S2", "session-S1").await;
        let result = mgr
            .fork_session(&db, "c-raced", None, None, None)
            .await
            .expect("fork must survive the lifecycle subscriber winning the race");
        let _ = join.await;

        assert_eq!(
            result.sibling_conversation_id, preserved_id,
            "fork must report the row that actually holds S1"
        );
        let listed = crate::commands::conversations::list_all_conversations_core(
            &db.conn,
            &EventEmitter::Noop,
            &crate::chat_channel::manager::ChatChannelManager::new(),
            crate::commands::conversations::ListAllConversationsOptions::default(),
        )
        .await
        .unwrap();
        assert_eq!(
            listed.len(),
            2,
            "exactly two rows regardless of who won the race, got {listed:?}"
        );
        assert_eq!(
            listed
                .iter()
                .filter(|c| c.external_id.as_deref() == Some("session-S1"))
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn fork_session_strips_no_space_fork_prefix() {
        // Defensive: a title produced outside the normal flow could lack the
        // space (e.g. external import). The frontend regex `/^\[Fork]\s*/g`
        // tolerated this; the backend strip must too, otherwise re-fork would
        // produce `[Fork] [Fork]xxx`.
        use crate::db::test_helpers;
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/fork-no-space").await;

        let pre = conversation_service::create(
            &db.conn,
            folder_id,
            AgentType::ClaudeCode,
            Some("[Fork]NoSpaceTitle".into()),
            None,
        )
        .await
        .unwrap();
        let (mgr, join) =
            manager_with_fake_fork("c-nosp", pre.id, "session-S2", "session-S1").await;
        mgr.fork_session(&db, "c-nosp", None, None, None).await.unwrap();
        let _ = join.await;

        let current = conversation_service::get_by_id(&db.conn, pre.id)
            .await
            .unwrap();
        assert_eq!(
            current.title.as_deref(),
            Some("[Fork] NoSpaceTitle"),
            "no-space prefix must be tolerantly stripped before re-stacking"
        );
    }

    #[tokio::test]
    async fn fork_session_reads_latest_committed_row_not_a_cached_snapshot() {
        // Regression guard for the write-first ordering in `persist_fork_outcome`.
        // The fork must derive its `[Fork] …` title and the sibling's preserved
        // title from the row's LATEST committed state, read under the write lock
        // the transaction takes with its opening statement — not from a value
        // captured earlier. If a future change reintroduces an early/cached read
        // (e.g. reading before the transaction, or threading a stale title in as
        // a param), a rename committed just before the fork would be clobbered.
        // Here we commit the rename first, then fork, and assert the fork
        // reflects the renamed title on both rows.
        use crate::db::test_helpers;
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/fork-latest").await;

        let pre = conversation_service::create(
            &db.conn,
            folder_id,
            AgentType::ClaudeCode,
            Some("Stale Original".into()),
            None,
        )
        .await
        .unwrap();
        // Commit a manual rename AFTER creation but BEFORE the fork runs. A
        // correct fork observes this; a stale-snapshot fork would emit
        // "[Fork] Stale Original" / "Stale Original" instead.
        conversation_service::update_title(&db.conn, pre.id, "Renamed By User".into())
            .await
            .unwrap();

        let (mgr, join) =
            manager_with_fake_fork("c-latest", pre.id, "session-S2", "session-S1").await;
        let result = mgr.fork_session(&db, "c-latest", None, None, None).await.unwrap();
        let _ = join.await;

        let current = conversation_service::get_by_id(&db.conn, pre.id)
            .await
            .unwrap();
        assert_eq!(
            current.title.as_deref(),
            Some("[Fork] Renamed By User"),
            "fork must prefix the LATEST committed title, not a stale snapshot"
        );
        let sibling = conversation_service::get_by_id(&db.conn, result.sibling_conversation_id)
            .await
            .unwrap();
        assert_eq!(
            sibling.title.as_deref(),
            Some("Renamed By User"),
            "sibling must preserve the LATEST committed title, not a stale snapshot"
        );
    }

    #[tokio::test]
    async fn fork_session_sibling_inherits_the_manual_title_lock() {
        // A rename locks the row (`update_title` sets `title_locked`) precisely
        // so the per-turn auto-title backfill can never overwrite the user's
        // name. The sibling the fork inserts IS that conversation's pre-fork
        // history, so it must inherit the lock: without it the user's name
        // survives only until the sibling's first detail load, which re-parses
        // S1 and adopts the session-file title (rename → fork → the original
        // conversation silently reverts to its pre-rename name).
        use crate::db::test_helpers;
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/fork-lock").await;

        // "XXX" stands in for the session-file (parser-derived) title.
        let pre = conversation_service::create(
            &db.conn,
            folder_id,
            AgentType::ClaudeCode,
            Some("XXX".into()),
            None,
        )
        .await
        .unwrap();
        conversation_service::update_title(&db.conn, pre.id, "YYY".into())
            .await
            .unwrap();

        let (mgr, join) =
            manager_with_fake_fork("c-fork-lock", pre.id, "session-S2", "session-S1").await;
        let result = mgr.fork_session(&db, "c-fork-lock", None, None, None).await.unwrap();
        let _ = join.await;

        let sibling_id = result.sibling_conversation_id;
        let sibling = conversation_service::get_by_id(&db.conn, sibling_id)
            .await
            .unwrap();
        assert_eq!(sibling.title.as_deref(), Some("YYY"));
        assert!(
            sibling.title_locked,
            "the sibling carries the renamed conversation's history, so it must \
             inherit the manual title lock"
        );
        // The forked row keeps the lock it already had (it is the same row).
        let current = conversation_service::get_by_id(&db.conn, pre.id)
            .await
            .unwrap();
        assert_eq!(current.title.as_deref(), Some("[Fork] YYY"));
        assert!(current.title_locked);

        // End-to-end guard: this is exactly what the next detail load does
        // (`get_folder_conversation_with_live_core` → `refresh_auto_title` with
        // the title parsed out of the S1 transcript). It must be a no-op on
        // both rows.
        assert!(
            !conversation_service::refresh_auto_title(&db.conn, sibling_id, "XXX".into())
                .await
                .unwrap(),
            "the auto-title backfill must not revert the sibling's user-set name"
        );
        assert!(
            !conversation_service::refresh_auto_title(&db.conn, pre.id, "XXX".into())
                .await
                .unwrap()
        );
        assert_eq!(
            conversation_service::get_by_id(&db.conn, sibling_id)
                .await
                .unwrap()
                .title
                .as_deref(),
            Some("YYY")
        );
    }

    #[tokio::test]
    async fn fork_session_locks_the_prefixed_title_it_writes() {
        // The `[Fork] ` marker exists nowhere in the transcript, so on an
        // unlocked row the very next detail load erases it: the auto-title
        // backfill adopts the parsed session-file title, leaving the forked row
        // and its sibling wearing the same name with nothing to tell them
        // apart. The fork therefore locks the title it writes.
        use crate::db::test_helpers;
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/fork-prefix-lock").await;

        let pre = conversation_service::create(
            &db.conn,
            folder_id,
            AgentType::ClaudeCode,
            Some("Auto Title".into()),
            None,
        )
        .await
        .unwrap();
        assert!(!pre.title_locked, "an auto-titled row starts unlocked");

        let (mgr, join) =
            manager_with_fake_fork("c-fork-prefix", pre.id, "session-S2", "session-S1").await;
        let result = mgr
            .fork_session(&db, "c-fork-prefix", None, None, None)
            .await
            .unwrap();
        let _ = join.await;

        let current = conversation_service::get_by_id(&db.conn, pre.id)
            .await
            .unwrap();
        assert_eq!(current.title.as_deref(), Some("[Fork] Auto Title"));
        assert!(
            current.title_locked,
            "the fork's own title must be protected from the auto-title backfill"
        );
        // The backfill the next detail load runs, with the title parsed out of
        // the forked transcript (a copy of S1, so the pre-fork title).
        assert!(
            !conversation_service::refresh_auto_title(&db.conn, pre.id, "Auto Title".into())
                .await
                .unwrap(),
            "the backfill must not strip the `[Fork] ` marker"
        );
        assert_eq!(
            conversation_service::get_by_id(&db.conn, pre.id)
                .await
                .unwrap()
                .title
                .as_deref(),
            Some("[Fork] Auto Title")
        );
        // The sibling wears the parsed title itself, so it needs no such
        // protection — see `fork_session_sibling_stays_unlocked_for_an_auto_title`.
        assert!(
            !conversation_service::get_by_id(&db.conn, result.sibling_conversation_id)
                .await
                .unwrap()
                .title_locked
        );
    }

    #[tokio::test]
    async fn fork_session_leaves_a_titleless_row_unlocked() {
        // Nothing to prefix means nothing to protect: a row forked before it
        // ever got a title must stay unlocked, or the auto-title backfill could
        // never give it its first name and it would read "Untitled" forever.
        use crate::db::test_helpers;
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/fork-untitled").await;

        let pre =
            conversation_service::create(&db.conn, folder_id, AgentType::ClaudeCode, None, None)
                .await
                .unwrap();

        let (mgr, join) =
            manager_with_fake_fork("c-fork-untitled", pre.id, "session-S2", "session-S1").await;
        let result = mgr
            .fork_session(&db, "c-fork-untitled", None, None, None)
            .await
            .unwrap();
        let _ = join.await;

        let current = conversation_service::get_by_id(&db.conn, pre.id)
            .await
            .unwrap();
        assert_eq!(current.title, None, "no title to prefix");
        assert!(!current.title_locked, "an unwritten title must stay unlocked");
        let sibling = conversation_service::get_by_id(&db.conn, result.sibling_conversation_id)
            .await
            .unwrap();
        assert_eq!(sibling.title, None);
        assert!(!sibling.title_locked);
        // Both rows can still be named by the backfill.
        assert!(
            conversation_service::refresh_auto_title(&db.conn, pre.id, "First Name".into())
                .await
                .unwrap()
        );
        assert!(
            conversation_service::refresh_auto_title(&db.conn, sibling.id, "First Name".into())
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn fork_session_sibling_stays_unlocked_for_an_auto_title() {
        // Inheriting the lock must mean INHERITING it, not always setting it:
        // an auto-titled conversation's sibling stays eligible for the
        // auto-title backfill, so a title the agent regenerates later still
        // lands on the preserved history.
        use crate::db::test_helpers;
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/fork-unlocked").await;

        let pre = conversation_service::create(
            &db.conn,
            folder_id,
            AgentType::ClaudeCode,
            Some("Auto Title".into()),
            None,
        )
        .await
        .unwrap();
        assert!(!pre.title_locked, "a fresh row starts unlocked");

        let (mgr, join) =
            manager_with_fake_fork("c-fork-unlocked", pre.id, "session-S2", "session-S1").await;
        let result = mgr
            .fork_session(&db, "c-fork-unlocked", None, None, None)
            .await
            .unwrap();
        let _ = join.await;

        let sibling_id = result.sibling_conversation_id;
        assert!(
            !conversation_service::get_by_id(&db.conn, sibling_id)
                .await
                .unwrap()
                .title_locked,
            "an auto-derived title must not become locked by forking"
        );
        assert!(
            conversation_service::refresh_auto_title(&db.conn, sibling_id, "Newer Title".into())
                .await
                .unwrap(),
            "the backfill must still be able to update an unlocked sibling"
        );
    }

    #[tokio::test]
    async fn fork_session_errors_without_orphan_when_row_missing() {
        // The current-row write is the transaction's first statement and its
        // `rows_affected == 0` is the not-found signal. If the linked row has
        // vanished (hard-deleted out from under a live connection), the fork
        // must error and, because the sibling INSERT shares the transaction,
        // leave NO orphan sibling behind.
        use crate::db::test_helpers;
        let db = test_helpers::fresh_in_memory_db().await;
        // Seed a folder but NO conversation row; the connection points at an id
        // that does not exist in the DB.
        let _folder_id = test_helpers::seed_folder(&db, "/tmp/fork-missing").await;
        let missing_conversation_id = 99_999;

        let (mgr, join) = manager_with_fake_fork(
            "c-missing",
            missing_conversation_id,
            "session-S2",
            "session-S1",
        )
        .await;
        let err = mgr
            .fork_session(&db, "c-missing", None, None, None)
            .await
            .expect_err("fork against a missing row must error");
        let _ = join.await;
        assert!(
            err.to_string().contains("not found"),
            "error should mention the missing row, got: {err}"
        );

        // No orphan: the failed transaction rolled back, so the DB holds zero
        // conversation rows (the sibling INSERT must not have committed).
        let all = conversation::Entity::find().all(&db.conn).await.unwrap();
        assert!(
            all.is_empty(),
            "a failed fork must not leave an orphan sibling row, found: {}",
            all.len()
        );
    }

    #[tokio::test]
    async fn fork_session_errors_without_orphan_when_row_soft_deleted() {
        // Forking a soft-deleted conversation must NOT resurrect it: the sibling
        // insert would set `deleted_at = None`, creating a fresh visible row from
        // deleted data. The write-first claim filters `deleted_at IS NULL`, so a
        // deleted row matches nothing → the fork aborts with a not-found error,
        // writes nothing, and leaves the original row soft-deleted and unchanged.
        use crate::db::test_helpers;
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/fork-deleted").await;

        let pre = conversation_service::create(
            &db.conn,
            folder_id,
            AgentType::ClaudeCode,
            Some("Doomed Topic".into()),
            None,
        )
        .await
        .unwrap();
        conversation_service::bind_external_id(&db.conn, pre.id, "session-S1", &[])
            .await
            .unwrap();
        conversation_service::soft_delete(&db.conn, pre.id)
            .await
            .unwrap();

        let (mgr, join) =
            manager_with_fake_fork("c-deleted", pre.id, "session-S2", "session-S1").await;
        let err = mgr
            .fork_session(&db, "c-deleted", None, None, None)
            .await
            .expect_err("fork against a soft-deleted row must error");
        let _ = join.await;
        assert!(
            err.to_string().contains("not found") || err.to_string().contains("deleted"),
            "error should mention the missing/deleted row, got: {err}"
        );

        // No resurrection: exactly the original row remains, still soft-deleted,
        // still bound to S1 — no visible sibling was inserted, and the current
        // row was neither re-pointed at S2 nor `[Fork]`-prefixed.
        let all = conversation::Entity::find().all(&db.conn).await.unwrap();
        assert_eq!(all.len(), 1, "no sibling row should have been inserted");
        let only = &all[0];
        assert_eq!(only.id, pre.id);
        assert!(
            only.deleted_at.is_some(),
            "the original row must stay soft-deleted"
        );
        assert_eq!(
            only.external_id.as_deref(),
            Some("session-S1"),
            "the deleted row must not be re-pointed at the forked session"
        );
        assert_eq!(
            only.title.as_deref(),
            Some("Doomed Topic"),
            "the deleted row must not gain a [Fork] prefix"
        );
    }

    #[tokio::test]
    async fn fork_session_rejects_unbound_connection() {
        // Without a linked conversation_id the sibling row would orphan S1
        // history (no row to point at it). fork_session must refuse early —
        // BEFORE sending the Fork command to the agent, so we don't burn an
        // ACP round-trip on a request we can't persist.
        use crate::db::test_helpers;
        let db = test_helpers::fresh_in_memory_db().await;
        let mgr = ConnectionManager::new();
        {
            let mut map = mgr.connections.lock().await;
            map.insert("c-unbound".into(), fake_connection("c-unbound", None));
        }
        let err = mgr
            .fork_session(&db, "c-unbound", None, None, None)
            .await
            .expect_err("unbound fork must error");
        assert!(
            err.to_string().contains("linked conversation row"),
            "error should mention missing linkage, got: {err}"
        );
    }

    #[tokio::test]
    async fn fork_session_links_unbound_row_from_caller_ids() {
        // Bug #2: a conversation opened from history resumes via `session_id`
        // but its row isn't bound to the connection until the first prompt
        // fires `ConversationLinked`. A fork-send forks BEFORE that prompt, so
        // fork_session must adopt the caller-supplied (conversation_id,
        // folder_id) and succeed — instead of rejecting as unlinked (which is
        // exactly what the user hit forking a conversation opened from history).
        use crate::acp::connection::ConnectionCommand;
        use crate::db::test_helpers;
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/fork-relink").await;
        let pre = conversation_service::create(
            &db.conn,
            folder_id,
            AgentType::ClaudeCode,
            Some("History".into()),
            None,
        )
        .await
        .unwrap();
        conversation_service::bind_external_id(&db.conn, pre.id, "session-S1", &[])
            .await
            .unwrap();

        // A connection with NO linked conversation_id — mirrors a fresh resume
        // of a historical conversation that hasn't sent a prompt yet.
        let (tx, mut rx) = mpsc::channel::<ConnectionCommand>(4);
        let mut state = SessionState::new(
            "c-relink".to_string(),
            AgentType::ClaudeCode,
            None,
            "test-window".to_string(),
            None,
        );
        state.conversation_id = None;
        state.status = ConnectionStatus::Connected;
        let conn = AgentConnection {
            id: "c-relink".to_string(),
            agent_type: AgentType::ClaudeCode,
            status: ConnectionStatus::Connected,
            owner_window_label: "test-window".to_string(),
            cmd_tx: tx,
            state: Arc::new(RwLock::new(state)),
            emitter: EventEmitter::Noop,
            prompt_lock: Arc::new(tokio::sync::Mutex::new(())),
            config_fingerprint: String::new(),
            last_observed_fingerprint: String::new(),
            child_pid: Arc::new(std::sync::atomic::AtomicU32::new(0)),
        };
        let mgr = ConnectionManager::new();
        {
            let mut map = mgr.connections.lock().await;
            map.insert("c-relink".to_string(), conn);
        }
        let join = tokio::spawn(async move {
            while let Some(cmd) = rx.recv().await {
                if let ConnectionCommand::Fork { reply, .. } = cmd {
                    let _ = reply.send(Ok(crate::acp::types::ForkProtocolResult {
                        forked_session_id: "session-S2".to_string(),
                        original_session_id: "session-S1".to_string(),
                    }));
                    return;
                }
            }
        });

        let result = mgr
            .fork_session(&db, "c-relink", Some(pre.id), Some(folder_id), None)
            .await
            .expect("fork must link the unbound row from caller ids and succeed");
        let _ = join.await;

        assert_eq!(result.forked_session_id, "session-S2");
        // The connection is now linked to the row...
        let linked = mgr.get_state("c-relink").await.expect("connection exists");
        assert_eq!(linked.read().await.conversation_id, Some(pre.id));
        // ...the current row is re-pointed to S2 with a `[Fork]` title...
        let current = conversation_service::get_by_id(&db.conn, pre.id)
            .await
            .unwrap();
        assert_eq!(current.external_id.as_deref(), Some("session-S2"));
        assert_eq!(current.title.as_deref(), Some("[Fork] History"));
        // ...and a sibling preserves the pre-fork S1 history.
        let sibling = conversation_service::get_by_id(&db.conn, result.sibling_conversation_id)
            .await
            .unwrap();
        assert_eq!(sibling.external_id.as_deref(), Some("session-S1"));
    }

    // --- wait_for_session_options polling ----------------------------------
    //
    // These tests exercise the probe's wait loop directly by hand-seeding
    // `SessionState` on an injected connection. They avoid spawning a real
    // agent (which is what `probe_agent_options` itself would do) — the goal
    // is to lock in the three behaviors the public API depends on:
    //   1. ready+grace → Ok(snapshot) reflecting current state
    //   2. never-ready within timeout → Err(ProbeTimedOut), not Ok(empty)
    //   3. selectors_ready=true with empty options → Ok(empty snapshot)

    use crate::acp::types::{
        SessionConfigKindInfo, SessionConfigOptionInfo, SessionConfigSelectInfo, SessionModeInfo,
        SessionModeStateInfo,
    };

    fn sample_modes() -> SessionModeStateInfo {
        SessionModeStateInfo {
            current_mode_id: "default".into(),
            available_modes: vec![
                SessionModeInfo {
                    id: "default".into(),
                    name: "Default".into(),
                    description: None,
                },
                SessionModeInfo {
                    id: "yolo".into(),
                    name: "YOLO".into(),
                    description: None,
                },
            ],
        }
    }

    fn sample_config_options() -> Vec<SessionConfigOptionInfo> {
        vec![SessionConfigOptionInfo {
            id: "model".into(),
            name: "Model".into(),
            description: None,
            category: None,
            kind: SessionConfigKindInfo::Select(SessionConfigSelectInfo {
                current_value: "sonnet".into(),
                options: vec![],
                groups: vec![],
            }),
            recommended_value: None,
        }]
    }

    #[tokio::test]
    async fn wait_for_session_options_returns_snapshot_after_ready_plus_grace() {
        let mgr = ConnectionManager::new();
        mgr.insert_test_connection(
            "probe-1",
            crate::models::agent::AgentType::ClaudeCode,
            None,
            EventEmitter::Noop,
        )
        .await;
        // Seed the state the probe is waiting on. Done BEFORE the wait
        // starts so the very first poll already sees ready=true and only
        // the 500 ms grace period gates the return.
        {
            let state = mgr.get_state("probe-1").await.expect("state");
            let mut s = state.write().await;
            s.modes = Some(sample_modes());
            s.config_options = Some(sample_config_options());
            s.selectors_ready = true;
        }

        let start = std::time::Instant::now();
        let snapshot = mgr
            .wait_for_session_options("probe-1", Duration::from_secs(2))
            .await
            .expect("ready+grace path must return Ok");
        let elapsed = start.elapsed();

        assert!(
            elapsed >= Duration::from_millis(450),
            "expected ~500ms grace, observed {elapsed:?}"
        );
        assert!(
            elapsed < Duration::from_millis(1500),
            "should NOT wait the full 2s timeout, observed {elapsed:?}"
        );
        assert_eq!(snapshot.config_options.len(), 1);
        assert!(snapshot.modes.is_some());
    }

    #[tokio::test]
    async fn wait_for_session_options_times_out_when_selectors_never_ready() {
        let mgr = ConnectionManager::new();
        mgr.insert_test_connection(
            "probe-2",
            crate::models::agent::AgentType::ClaudeCode,
            None,
            EventEmitter::Noop,
        )
        .await;
        // Critical guarantee: even though `config_options` is `Some(...)`,
        // because `selectors_ready` is still false, the wait MUST timeout
        // and return Err — never Ok(empty) which would mislead the UI.
        {
            let state = mgr.get_state("probe-2").await.expect("state");
            let mut s = state.write().await;
            s.config_options = Some(vec![]);
            s.selectors_ready = false;
        }

        let err = mgr
            .wait_for_session_options("probe-2", Duration::from_millis(300))
            .await
            .expect_err("timeout path must return Err");
        assert!(
            matches!(err, AcpError::ProbeTimedOut),
            "expected ProbeTimedOut, got {err:?}"
        );
        assert_eq!(err.code(), Some("probe_timed_out"));
    }

    #[tokio::test]
    async fn wait_for_session_options_returns_empty_when_ready_with_no_options() {
        let mgr = ConnectionManager::new();
        mgr.insert_test_connection(
            "probe-3",
            crate::models::agent::AgentType::ClaudeCode,
            None,
            EventEmitter::Noop,
        )
        .await;
        // Real outcome the UI renders as "agent has nothing to configure":
        // selectors_ready=true, modes=None, config_options=None. Must
        // succeed, not error — this is the path that distinguishes a
        // legitimately empty agent from an unresponsive one.
        {
            let state = mgr.get_state("probe-3").await.expect("state");
            let mut s = state.write().await;
            s.modes = None;
            s.config_options = None;
            s.selectors_ready = true;
        }

        let snapshot = mgr
            .wait_for_session_options("probe-3", Duration::from_secs(2))
            .await
            .expect("ready-empty path must return Ok, not Err");
        assert!(snapshot.modes.is_none());
        assert!(snapshot.config_options.is_empty());
    }

    #[tokio::test]
    async fn wait_for_session_options_unknown_connection_errors_immediately() {
        let mgr = ConnectionManager::new();
        let err = mgr
            .wait_for_session_options("does-not-exist", Duration::from_secs(5))
            .await
            .expect_err("missing connection must error");
        assert!(
            matches!(err, AcpError::ConnectionNotFound(_)),
            "expected ConnectionNotFound, got {err:?}"
        );
    }

    #[tokio::test]
    async fn apply_event_error_populates_last_error_snapshot() {
        // Directly drives SessionState::apply_event to assert the Error
        // arm now writes `last_error` (rather than being a no-op as it
        // was before). The probe path reads this to surface the
        // agent's own error message after cleanup runs.
        use crate::acp::session_state::SessionState;
        let mut s = SessionState::new(
            "c1".into(),
            crate::models::agent::AgentType::ClaudeCode,
            None,
            "test-window".into(),
            None,
        );
        assert!(s.last_error.is_none(), "fresh state has no error");

        s.apply_event(&AcpEvent::Error {
            message: "agent exploded".into(),
            agent_type: "claude_code".into(),
            code: Some("sdk_not_installed".into()),
            details: None,
            terminal: true,
        });
        let captured = s.last_error.as_ref().expect("error must be captured");
        assert_eq!(captured.message, "agent exploded");
        assert_eq!(captured.code.as_deref(), Some("sdk_not_installed"));

        // A second Error event overwrites — `last_error` is "latest",
        // not "first". Keeps post-mortem reads aligned with what the
        // user most recently observed on the event channel.
        s.apply_event(&AcpEvent::Error {
            message: "second failure".into(),
            agent_type: "claude_code".into(),
            code: None,
            details: None,
            terminal: true,
        });
        let captured = s.last_error.as_ref().unwrap();
        assert_eq!(captured.message, "second failure");
        assert!(captured.code.is_none());
    }

    // --- live feedback: submit gate + consume drain --------------------

    /// Make a test connection feedback-capable AND mid-turn (the happy state).
    async fn mark_feedback_ready(mgr: &ConnectionManager, conn_id: &str) {
        let state = mgr.get_state(conn_id).await.unwrap();
        let mut s = state.write().await;
        s.feedback_tool_available = true;
        s.turn_in_flight = true;
    }

    async fn set_feedback_tool_available(mgr: &ConnectionManager, conn_id: &str) {
        let state = mgr.get_state(conn_id).await.unwrap();
        state.write().await.feedback_tool_available = true;
    }

    #[tokio::test]
    async fn submit_feedback_rejected_when_tool_unavailable() {
        let mgr = ConnectionManager::new();
        mgr.insert_test_connection("c1", AgentType::ClaudeCode, None, EventEmitter::Noop)
            .await;
        // feedback_tool_available defaults false: the agent never got the tool
        // (e.g. its session started before the feature was enabled), even mid-turn.
        let state = mgr.get_state("c1").await.unwrap();
        state.write().await.turn_in_flight = true;
        let err = mgr.submit_feedback("c1", "note".into(), None).await.unwrap_err();
        assert!(matches!(err, AcpError::FeedbackDisabled));
        assert!(state.read().await.feedback.is_empty());
    }

    #[tokio::test]
    async fn submit_feedback_rejected_when_no_turn_in_flight() {
        let mgr = ConnectionManager::new();
        mgr.insert_test_connection("c1", AgentType::ClaudeCode, None, EventEmitter::Noop)
            .await;
        // Tool available but no turn in flight → nothing to steer.
        set_feedback_tool_available(&mgr, "c1").await;
        let err = mgr.submit_feedback("c1", "note".into(), None).await.unwrap_err();
        assert!(matches!(err, AcpError::NoActiveTurn));
        // And nothing was appended.
        let state = mgr.get_state("c1").await.unwrap();
        assert!(state.read().await.feedback.is_empty());
    }

    #[tokio::test]
    async fn submit_feedback_missing_connection_errors() {
        let mgr = ConnectionManager::new();
        let err = mgr
            .submit_feedback("nope", "note".into(), None)
            .await
            .unwrap_err();
        assert!(matches!(err, AcpError::ConnectionNotFound(_)));
    }

    #[tokio::test]
    async fn submit_feedback_appends_when_turn_in_flight() {
        let mgr = ConnectionManager::new();
        mgr.insert_test_connection("c1", AgentType::ClaudeCode, None, EventEmitter::Noop)
            .await;
        mark_feedback_ready(&mgr, "c1").await;
        let item = mgr
            .submit_feedback("c1", "  use UserService  ".into(), None)
            .await
            .unwrap();
        assert_eq!(item.status, FeedbackStatus::Pending);
        // Stored text is trimmed.
        assert_eq!(item.text, "use UserService");
        let state = mgr.get_state("c1").await.unwrap();
        let s = state.read().await;
        assert_eq!(s.feedback.len(), 1);
        assert_eq!(s.feedback[0].text, "use UserService");
    }

    #[tokio::test]
    async fn submit_feedback_rejects_empty_and_oversized() {
        let mgr = ConnectionManager::new();
        mgr.insert_test_connection("c1", AgentType::ClaudeCode, None, EventEmitter::Noop)
            .await;
        mark_feedback_ready(&mgr, "c1").await;
        // Empty / whitespace-only → rejected, nothing appended.
        for empty in ["", "   ", "\n\t "] {
            let err = mgr.submit_feedback("c1", empty.into(), None).await.unwrap_err();
            assert!(matches!(err, AcpError::InvalidFeedback(_)));
        }
        // Oversized → rejected.
        let huge = "x".repeat(MAX_FEEDBACK_CHARS + 1);
        let err = mgr.submit_feedback("c1", huge, None).await.unwrap_err();
        assert!(matches!(err, AcpError::InvalidFeedback(_)));
        // Exactly at the bound is accepted.
        let at_bound = "y".repeat(MAX_FEEDBACK_CHARS);
        assert!(mgr.submit_feedback("c1", at_bound, None).await.is_ok());
        let state = mgr.get_state("c1").await.unwrap();
        assert_eq!(state.read().await.feedback.len(), 1, "only the valid note stuck");
    }

    // --- native steering (push channel) ----------------------------------

    async fn mark_native_steering_ready(mgr: &ConnectionManager, conn_id: &str) {
        let state = mgr.get_state(conn_id).await.unwrap();
        let mut s = state.write().await;
        s.native_steering_available = true;
        s.turn_in_flight = true;
    }

    /// Play the connection loop's role: receive one `Steer` command and reply
    /// the given outcome. Returns the blocks the command carried.
    fn answer_steer(
        mut rx: tokio::sync::mpsc::Receiver<ConnectionCommand>,
        outcome: Result<SteerOutcome, AcpError>,
    ) -> tokio::task::JoinHandle<Vec<PromptInputBlock>> {
        tokio::spawn(async move {
            match rx.recv().await {
                Some(ConnectionCommand::Steer { blocks, reply }) => {
                    let _ = reply.send(outcome);
                    blocks
                }
                _ => panic!("expected a Steer command"),
            }
        })
    }

    /// [`answer_steer`] for a test that submits more than once: answers `n`
    /// Steer commands with the same outcome. The loop is what makes concurrent
    /// submits resolvable — each waits on its own reply channel, so a
    /// single-shot answerer would leave the second one hanging.
    /// Takes a bare [`SteerOutcome`] (which is `Copy`) rather than the
    /// `Result` [`answer_steer`] accepts, because `AcpError` is not `Clone` and
    /// a repeated answerer has to hand out the same value more than once. No
    /// caller needs a repeated FAILURE.
    fn answer_steer_n(
        mut rx: tokio::sync::mpsc::Receiver<ConnectionCommand>,
        outcome: SteerOutcome,
        n: usize,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            for _ in 0..n {
                match rx.recv().await {
                    Some(ConnectionCommand::Steer { reply, .. }) => {
                        let _ = reply.send(Ok(outcome));
                    }
                    _ => panic!("expected a Steer command"),
                }
            }
        })
    }

    /// The note's instant must precede the injection reaching the agent. The
    /// adapter hands the text to the agent BEFORE it answers `injected`, so the
    /// agent can write its own transcript copy of the message while this call
    /// is still awaiting that answer. A note stamped on the way back would
    /// postdate the copy it caused, and the frontend — which folds a persisted
    /// copy away only when it postdates the injection, so that the same words
    /// sent in an earlier round are never hidden — would show the message both
    /// as a transcript turn and as a live one.
    #[tokio::test]
    async fn native_submit_stamps_the_note_before_the_agent_can_see_it() {
        let mgr = ConnectionManager::new();
        let mut rx = mgr
            .insert_test_connection_live("c1", AgentType::ClaudeCode, None, EventEmitter::Noop)
            .await;
        mark_native_steering_ready(&mgr, "c1").await;
        // Stand in for the adapter: note when the injection reached it (the
        // earliest instant the agent could record the message), then dawdle
        // before answering, as a real round-trip does.
        let fake_loop = tokio::spawn(async move {
            match rx.recv().await {
                Some(ConnectionCommand::Steer { reply, .. }) => {
                    let seen_by_agent = chrono::Utc::now();
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                    let _ = reply.send(Ok(SteerOutcome::Injected));
                    seen_by_agent
                }
                _ => panic!("expected a Steer command"),
            }
        });

        let item = mgr
            .submit_feedback("c1", "use the other API".into(), None)
            .await
            .unwrap();
        let seen_by_agent = fake_loop.await.unwrap();
        assert!(
            item.created_at <= seen_by_agent,
            "created_at ({}) must precede the injection reaching the agent ({})",
            item.created_at,
            seen_by_agent
        );
    }

    #[tokio::test]
    async fn native_submit_injected_records_delivered_and_pull_stays_empty() {
        let mgr = ConnectionManager::new();
        let rx = mgr
            .insert_test_connection_live("c1", AgentType::ClaudeCode, None, EventEmitter::Noop)
            .await;
        mark_native_steering_ready(&mgr, "c1").await;
        // The pull tool coexists by design — and must see NOTHING (the
        // no-double-delivery invariant: native notes are Delivered from birth,
        // `read_pending_feedback` only returns Pending).
        set_feedback_tool_available(&mgr, "c1").await;
        let fake_loop = answer_steer(rx, Ok(SteerOutcome::Injected));

        let item = mgr.submit_feedback("c1", "  ship it  ".into(), None).await.unwrap();
        assert_eq!(item.status, FeedbackStatus::Delivered);
        assert!(item.delivered_at.is_some());
        assert_eq!(item.text, "ship it");
        // The wire carried the trimmed text as a single block (a blocks-less
        // submit stays byte-identical to the historical text-only steer).
        assert_eq!(
            fake_loop.await.unwrap(),
            vec![PromptInputBlock::Text {
                text: "ship it".into()
            }]
        );
        // ...and so does the NOTE: a text-only steer records no block list, so
        // every consumer keeps rendering it from `text` alone. This is the
        // half that keeps the attachment support below from changing the
        // historical path.
        assert_eq!(item.blocks, None);

        let state = mgr.get_state("c1").await.unwrap();
        {
            let s = state.read().await;
            assert_eq!(s.feedback.len(), 1);
            assert_eq!(s.feedback[0].status, FeedbackStatus::Delivered);
            assert!(s.native_steering_available, "injected must not downgrade");
        }
        assert!(
            mgr.read_pending_feedback("c1").await.is_empty(),
            "a check_user_feedback pull must never re-deliver a natively-injected note"
        );
    }

    #[tokio::test]
    async fn native_submit_with_blocks_carries_the_draft_and_records_the_text() {
        // A draft with an image attachment steers as its full block list (the
        // wire payload) while the recorded note's `text` stays the display
        // form. The note ALSO carries the projected blocks, because `text` is
        // what the composer collapsed the attachment into: without them the
        // live transcript renders a sentence about an image where the image
        // should be, and only a reload (which reads the agent's own copy) puts
        // it back. Projection matches an ordinary prompt's `user_message`.
        let mgr = ConnectionManager::new();
        let rx = mgr
            .insert_test_connection_live("c1", AgentType::ClaudeCode, None, EventEmitter::Noop)
            .await;
        mark_native_steering_ready(&mgr, "c1").await;
        let fake_loop = answer_steer(rx, Ok(SteerOutcome::Injected));

        let draft = vec![
            PromptInputBlock::Text {
                text: "make it match this mock".into(),
            },
            PromptInputBlock::Image {
                data: "aGk=".into(),
                mime_type: "image/png".into(),
                uri: None,
            },
        ];
        let item = mgr
            .submit_feedback("c1", "make it match this mock".into(), Some(draft.clone()))
            .await
            .unwrap();
        assert_eq!(item.status, FeedbackStatus::Delivered);
        assert_eq!(item.text, "make it match this mock");
        // The note carries the image, so the live transcript can render it at
        // the point the user sent it rather than waiting for a reload.
        assert_eq!(
            item.blocks,
            Some(vec![
                crate::acp::types::UserMessageBlock::Text {
                    text: "make it match this mock".into()
                },
                crate::acp::types::UserMessageBlock::Image {
                    data: "aGk=".into(),
                    mime_type: "image/png".into(),
                },
            ])
        );
        // The wire carried the caller's blocks verbatim, attachment included.
        assert_eq!(fake_loop.await.unwrap(), draft);
    }

    #[tokio::test]
    async fn a_draft_that_projects_to_text_alone_records_no_block_list() {
        // `blocks` means "this note carried more than its text". A draft whose
        // projection is text-only says nothing `text` does not, so recording a
        // list for it would put one on a note the field's contract calls
        // text-only — and the frontend would key its dedup on that list.
        let mgr = ConnectionManager::new();
        let rx = mgr
            .insert_test_connection_live("c1", AgentType::ClaudeCode, None, EventEmitter::Noop)
            .await;
        mark_native_steering_ready(&mgr, "c1").await;
        let fake_loop = answer_steer(rx, Ok(SteerOutcome::Injected));

        let item = mgr
            .submit_feedback(
                "c1",
                "just words".into(),
                Some(vec![PromptInputBlock::Text {
                    text: "just words".into(),
                }]),
            )
            .await
            .unwrap();

        assert_eq!(item.blocks, None);
        // The wire still carried what the caller sent — only the RECORD is
        // trimmed, so the agent's input is untouched.
        assert_eq!(
            fake_loop.await.unwrap(),
            vec![PromptInputBlock::Text {
                text: "just words".into()
            }]
        );
    }

    #[tokio::test]
    async fn steer_attachments_past_the_per_turn_budget_are_not_retained() {
        // The budget guards what OUTLIVES the event: `SessionState.feedback`,
        // which every snapshot is rebuilt from. So it is enforced at the append
        // — the single authorized writer, where the check and the push share
        // one critical section — not at the submit site, where a read, an agent
        // round-trip and a write would let two concurrent steers both pass it.
        //
        // Past the budget the note still DELIVERS and the event still carries
        // its blocks to whoever is attached right now; only the retained copy
        // drops them, so a reconnect renders it from `text` like any text-only
        // steer.
        let mgr = ConnectionManager::new();
        let rx = mgr
            .insert_test_connection_live("c1", AgentType::ClaudeCode, None, EventEmitter::Noop)
            .await;
        mark_native_steering_ready(&mgr, "c1").await;
        let fake_loop = answer_steer(rx, Ok(SteerOutcome::Injected));

        let huge = "A".repeat(MAX_FEEDBACK_ATTACHMENT_BYTES_PER_TURN + 1);
        let item = mgr
            .submit_feedback(
                "c1",
                "one enormous screenshot".into(),
                Some(vec![PromptInputBlock::Image {
                    data: huge,
                    mime_type: "image/png".into(),
                    uri: None,
                }]),
            )
            .await
            .unwrap();

        assert_eq!(
            item.status,
            FeedbackStatus::Delivered,
            "over budget is not a rejection — the agent already has the content"
        );

        // The RETAINED note is the one that had to shed the attachment.
        let state = mgr.get_state("c1").await.unwrap();
        {
            let s = state.read().await;
            assert_eq!(s.feedback.len(), 1);
            assert_eq!(
                s.feedback[0].blocks, None,
                "an over-budget attachment must not be kept for the turn"
            );
            assert_eq!(s.feedback[0].text, "one enormous screenshot");
        }

        // And the wire was never trimmed: the budget governs what codeg KEEPS,
        // not what the agent receives.
        let sent = fake_loop.await.unwrap();
        assert!(matches!(
            sent.as_slice(),
            [PromptInputBlock::Image { data, .. }]
                if data.len() == MAX_FEEDBACK_ATTACHMENT_BYTES_PER_TURN + 1
        ));
    }

    #[tokio::test]
    async fn concurrent_over_budget_steers_cannot_both_be_retained() {
        // The interleaving a submit-site check could not stop: two steers whose
        // attachments each fit the budget alone but not together. The append is
        // serialized by the state write lock, so the second one sees the first
        // already retained and sheds its own blocks.
        let mgr = ConnectionManager::new();
        let rx = mgr
            .insert_test_connection_live("c1", AgentType::ClaudeCode, None, EventEmitter::Noop)
            .await;
        mark_native_steering_ready(&mgr, "c1").await;
        let fake_loop = answer_steer_n(rx, SteerOutcome::Injected, 2);

        // Two thirds of the budget each: either alone is admissible, the pair
        // is not.
        let half = "A".repeat((MAX_FEEDBACK_ATTACHMENT_BYTES_PER_TURN / 3) * 2);
        let shot = |text: &str| {
            let data = half.clone();
            let text = text.to_string();
            let mgr = &mgr;
            async move {
                mgr.submit_feedback(
                    "c1",
                    text,
                    Some(vec![PromptInputBlock::Image {
                        data,
                        mime_type: "image/png".into(),
                        uri: None,
                    }]),
                )
                .await
                .unwrap()
            }
        };
        let (a, b) = tokio::join!(shot("first"), shot("second"));
        assert_eq!(a.status, FeedbackStatus::Delivered);
        assert_eq!(b.status, FeedbackStatus::Delivered);
        fake_loop.await.unwrap();

        let state = mgr.get_state("c1").await.unwrap();
        let s = state.read().await;
        assert_eq!(s.feedback.len(), 2, "both notes are still recorded");
        let retained: usize = s
            .feedback
            .iter()
            .filter_map(|f| f.blocks.as_deref())
            .map(crate::acp::feedback::attachment_bytes)
            .sum();
        assert!(
            retained <= MAX_FEEDBACK_ATTACHMENT_BYTES_PER_TURN,
            "the aggregate bound holds across concurrent steers: retained={retained}"
        );
        assert_eq!(
            s.feedback.iter().filter(|f| f.blocks.is_some()).count(),
            1,
            "exactly one of the pair keeps its attachment"
        );
    }

    #[test]
    fn a_steer_admitted_against_one_turn_does_not_ride_the_next_one() {
        // The guard `submit_feedback_native` applies across attachment
        // hydration — the one await between admission and the enqueue. The
        // loop's idle arm covers "the turn ended"; only this covers "the next
        // turn started", which would otherwise have the loop inject the note
        // into a turn the user never aimed at.
        //
        // Same turn throughout — the overwhelmingly common case.
        assert!(!steered_turn_changed(3, true, 3));
        // The turn ended and a NEW one started: still in flight, so the flag
        // alone says nothing. This is the case nothing else catches.
        assert!(steered_turn_changed(3, true, 4));
        // The turn simply ended (the loop's idle arm would also catch this).
        assert!(steered_turn_changed(3, false, 4));
        // A repeat `TurnComplete` double-counts; only inequality is read, so
        // the verdict is the same.
        assert!(steered_turn_changed(3, true, 5));
        // First turn of a connection: the counter starts at zero and carries
        // identity from the very first turn, with no "unknown" window.
        assert!(!steered_turn_changed(0, true, 0));
        assert!(steered_turn_changed(0, true, 1));
    }

    #[tokio::test]
    async fn turn_complete_moves_the_turn_identity_the_steer_guard_reads() {
        // The guard above is only as good as the counter under it: prove
        // `TurnComplete` — the single production clear of `turn_in_flight` —
        // is what moves it, so "the turn I was admitted against is over" is
        // observable even once a NEXT turn has set the flag again.
        let mgr = ConnectionManager::new();
        mgr.insert_test_connection("c1", AgentType::ClaudeCode, None, EventEmitter::Noop)
            .await;
        let state = mgr.get_state("c1").await.unwrap();
        let admitted = {
            let mut s = state.write().await;
            s.turn_in_flight = true;
            s.turns_completed
        };
        state.write().await.apply_event(&AcpEvent::TurnComplete {
            session_id: "ext".into(),
            stop_reason: "end_turn".into(),
            agent_type: "claude_code".into(),
        });
        // A next turn re-sets the flag, exactly as `send_prompt_inner` does.
        state.write().await.turn_in_flight = true;

        let s = state.read().await;
        assert!(
            steered_turn_changed(admitted, s.turn_in_flight, s.turns_completed),
            "an in-flight flag that belongs to the NEXT turn must not read as the admitted one"
        );
    }

    #[tokio::test]
    async fn pull_submit_with_blocks_rejects_instead_of_dropping_attachments() {
        // The pull tool delivers plain text, so a blocks-bearing note on a
        // pull-only session (native downgraded mid-race) must reject with
        // NoActiveTurn — the caller's queue fallback re-routes the whole
        // draft — rather than deliver the text and silently drop the image.
        let mgr = ConnectionManager::new();
        mgr.insert_test_connection("c1", AgentType::ClaudeCode, None, EventEmitter::Noop)
            .await;
        mark_feedback_ready(&mgr, "c1").await;
        let draft = vec![PromptInputBlock::Image {
            data: "aGk=".into(),
            mime_type: "image/png".into(),
            uri: None,
        }];
        let err = mgr
            .submit_feedback("c1", "1 attachment".into(), Some(draft))
            .await
            .unwrap_err();
        assert!(matches!(err, AcpError::NoActiveTurn));
        // Nothing recorded: the content is still draft-owned.
        let state = mgr.get_state("c1").await.unwrap();
        assert!(state.read().await.feedback.is_empty());
        assert!(mgr.read_pending_feedback("c1").await.is_empty());
    }

    #[tokio::test]
    async fn native_submit_prompt_required_maps_to_no_active_turn_and_records_nothing() {
        let mgr = ConnectionManager::new();
        let rx = mgr
            .insert_test_connection_live("c1", AgentType::ClaudeCode, None, EventEmitter::Noop)
            .await;
        mark_native_steering_ready(&mgr, "c1").await;
        let fake_loop = answer_steer(rx, Ok(SteerOutcome::PromptRequired));

        let err = mgr.submit_feedback("c1", "note".into(), None).await.unwrap_err();
        assert!(matches!(err, AcpError::NoActiveTurn));
        let _ = fake_loop.await;

        let state = mgr.get_state("c1").await.unwrap();
        let s = state.read().await;
        // Content was NOT consumed (honored opt-in): nothing recorded, and the
        // channel stays native — the caller resubmits as a normal prompt.
        assert!(s.feedback.is_empty());
        assert!(s.native_steering_available);
    }

    #[tokio::test]
    async fn native_submit_started_new_turn_records_delivered_and_downgrades_to_pull() {
        let mgr = ConnectionManager::new();
        let rx = mgr
            .insert_test_connection_live("c1", AgentType::ClaudeCode, None, EventEmitter::Noop)
            .await;
        mark_native_steering_ready(&mgr, "c1").await;
        set_feedback_tool_available(&mgr, "c1").await;
        let fake_loop = answer_steer(rx, Ok(SteerOutcome::StartedNewTurn));

        // The adapter ignored the opt-in: content consumed → recorded
        // Delivered (never resent), and the session downgrades to pull.
        let item = mgr.submit_feedback("c1", "note one".into(), None).await.unwrap();
        assert_eq!(item.status, FeedbackStatus::Delivered);
        let _ = fake_loop.await;
        let state = mgr.get_state("c1").await.unwrap();
        assert!(
            !state.read().await.native_steering_available,
            "startedNewTurn must downgrade native steering for the session"
        );

        // The NEXT note rides the pull path: lands Pending, no Steer command
        // (the loop receiver was consumed above — a native attempt would fail
        // on the dead channel, so an Ok(Pending) proves the pull branch ran).
        let second = mgr.submit_feedback("c1", "note two".into(), None).await.unwrap();
        assert_eq!(second.status, FeedbackStatus::Pending);
        let pending = mgr.read_pending_feedback("c1").await;
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].text, "note two");
    }

    #[tokio::test]
    async fn native_submit_records_even_when_turn_settles_before_the_reply() {
        // The ungated-emit invariant: the adapter's `injected` reply is
        // authoritative even if `TurnComplete` lands first. A gated emit here
        // would misreport NoActiveTurn → the frontend would resend the same
        // text as a prompt → duplicate.
        let mgr = ConnectionManager::new();
        let rx = mgr
            .insert_test_connection_live("c1", AgentType::ClaudeCode, None, EventEmitter::Noop)
            .await;
        mark_native_steering_ready(&mgr, "c1").await;
        let state = mgr.get_state("c1").await.unwrap();

        let state_for_loop = state.clone();
        let mut rx = rx;
        let fake_loop = tokio::spawn(async move {
            match rx.recv().await {
                Some(ConnectionCommand::Steer { reply, .. }) => {
                    // The turn settles BETWEEN the injection and the reply.
                    state_for_loop.write().await.turn_in_flight = false;
                    let _ = reply.send(Ok(SteerOutcome::Injected));
                }
                _ => panic!("expected a Steer command"),
            }
        });

        let item = mgr.submit_feedback("c1", "late note".into(), None).await.unwrap();
        assert_eq!(item.status, FeedbackStatus::Delivered);
        let _ = fake_loop.await;
        assert_eq!(state.read().await.feedback.len(), 1);

        // The next turn's UserMessage clears the (turn-scoped) note — the
        // post-turn residue is bounded and harmless.
        state.write().await.apply_event(&AcpEvent::UserMessage {
            message_id: "m-next".into(),
            blocks: Vec::new(),
        });
        assert!(state.read().await.feedback.is_empty());
    }

    #[tokio::test]
    async fn native_submit_records_despite_caller_cancellation() {
        // Cancellation-shield regression, mirroring
        // `fork_persists_despite_caller_cancellation`: once `Steer` is
        // enqueued the adapter may consume the text regardless of caller
        // liveness, so the Delivered record + broadcast must not be tied to
        // the caller's future.
        let mgr = ConnectionManager::new();
        let rx = mgr
            .insert_test_connection_live("c1", AgentType::ClaudeCode, None, EventEmitter::Noop)
            .await;
        mark_native_steering_ready(&mgr, "c1").await;

        let (go_tx, go_rx) = tokio::sync::oneshot::channel::<()>();
        let mut rx = rx;
        let fake_loop = tokio::spawn(async move {
            if let Some(ConnectionCommand::Steer { reply, .. }) = rx.recv().await {
                go_rx.await.ok(); // withhold the outcome until the caller is gone
                let _ = reply.send(Ok(SteerOutcome::Injected));
            }
            rx // keep the receiver alive
        });

        // Drive the submit under a short timeout: the shielded task enqueues
        // `Steer` and blocks on the withheld reply; the timeout DROPS this
        // caller future.
        let timed = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            mgr.submit_feedback("c1", "shielded note".into(), None),
        )
        .await;
        assert!(
            timed.is_err(),
            "caller must be dropped before the withheld outcome is delivered"
        );

        // Release the outcome: the DETACHED task records the note anyway.
        go_tx.send(()).ok();
        let _ = fake_loop.await;
        let state = mgr.get_state("c1").await.unwrap();
        let mut recorded = false;
        for _ in 0..200 {
            {
                let s = state.read().await;
                if s.feedback.len() == 1 && s.feedback[0].status == FeedbackStatus::Delivered {
                    recorded = true;
                    break;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert!(
            recorded,
            "native delivery must be recorded despite caller cancellation"
        );
    }

    #[tokio::test]
    async fn native_only_session_accepts_notes_without_the_pull_tool() {
        // The native channel needs no MCP companion (that's the point):
        // eligibility is channel-aware, not tool-only.
        let mgr = ConnectionManager::new();
        let rx = mgr
            .insert_test_connection_live("c1", AgentType::ClaudeCode, None, EventEmitter::Noop)
            .await;
        mark_native_steering_ready(&mgr, "c1").await;
        // feedback_tool_available stays false.
        let fake_loop = answer_steer(rx, Ok(SteerOutcome::Injected));
        let item = mgr.submit_feedback("c1", "no tool needed".into(), None).await.unwrap();
        assert_eq!(item.status, FeedbackStatus::Delivered);
        let _ = fake_loop.await;
    }

    // --- ask_user_question: register / answer / cancel -------------------

    fn q_spec() -> Vec<QuestionSpec> {
        vec![crate::acp::question::QuestionSpec {
            id: "qa".into(),
            question: "Which approach?".into(),
            header: "Approach".into(),
            multi_select: false,
            options: vec![
                crate::acp::question::QuestionOption {
                    label: "A".into(),
                    description: String::new(),
                },
                crate::acp::question::QuestionOption {
                    label: "B".into(),
                    description: String::new(),
                },
            ],
            is_secret: false,
        }]
    }

    #[tokio::test]
    async fn register_then_answer_question_resolves_and_clears() {
        let mgr = ConnectionManager::new();
        mgr.insert_test_connection("cq", AgentType::ClaudeCode, None, EventEmitter::Noop)
            .await;
        let reg = mgr
            .register_question("cq", q_spec())
            .await
            .expect("registered");
        // SessionState reflects the pending question for snapshot recovery.
        assert!(mgr
            .get_state("cq")
            .await
            .unwrap()
            .read()
            .await
            .pending_question
            .is_some());

        let answer = crate::acp::question::QuestionAnswer {
            answers: vec![crate::acp::question::QuestionAnswerItem {
                question_id: "qa".into(),
                labels: vec!["A".into()],
            }],
            declined: false,
        };
        mgr.answer_question("cq", &reg.question_id, answer)
            .await
            .unwrap();

        // The blocked listener's receiver resolves with the self-describing
        // outcome (question text joined in).
        let outcome = reg.answer_rx.await.expect("answer delivered");
        assert!(!outcome.declined);
        assert_eq!(outcome.answers.len(), 1);
        assert_eq!(outcome.answers[0].question, "Which approach?");
        assert_eq!(outcome.answers[0].selected, vec!["A".to_string()]);
        // pending_question cleared after resolve.
        assert!(mgr
            .get_state("cq")
            .await
            .unwrap()
            .read()
            .await
            .pending_question
            .is_none());

        // Idempotent: answering an already-resolved id is a no-op success.
        mgr.answer_question("cq", &reg.question_id, Default::default())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn cancel_question_clears_and_drops_sender() {
        let mgr = ConnectionManager::new();
        mgr.insert_test_connection("cqx", AgentType::ClaudeCode, None, EventEmitter::Noop)
            .await;
        let reg = mgr.register_question("cqx", q_spec()).await.unwrap();
        mgr.cancel_question("cqx", &reg.question_id).await;
        // Dropping the sender surfaces to the parked listener as a recv error
        // (which it renders as a declined outcome).
        assert!(reg.answer_rx.await.is_err());
        assert!(mgr
            .get_state("cqx")
            .await
            .unwrap()
            .read()
            .await
            .pending_question
            .is_none());
    }

    #[tokio::test]
    async fn cancel_questions_by_parent_drops_only_matching_connection() {
        // The run_connection teardown guard sweeps a tearing-down connection's
        // parked ask without touching other connections' pending questions.
        let mgr = ConnectionManager::new();
        mgr.insert_test_connection("ca", AgentType::ClaudeCode, None, EventEmitter::Noop)
            .await;
        mgr.insert_test_connection("cb", AgentType::ClaudeCode, None, EventEmitter::Noop)
            .await;
        let reg_a = mgr.register_question("ca", q_spec()).await.unwrap();
        let reg_b = mgr.register_question("cb", q_spec()).await.unwrap();

        // Tear down only connection "ca".
        mgr.cancel_questions_by_parent("ca").await;

        // ca's parked listener is unblocked (sender dropped → recv error) and its
        // card cleared; cb is untouched.
        assert!(reg_a.answer_rx.await.is_err());
        assert!(mgr
            .get_state("ca")
            .await
            .unwrap()
            .read()
            .await
            .pending_question
            .is_none());
        assert!(mgr
            .get_state("cb")
            .await
            .unwrap()
            .read()
            .await
            .pending_question
            .is_some());

        // cb still resolves normally afterwards.
        mgr.answer_question("cb", &reg_b.question_id, Default::default())
            .await
            .unwrap();
        assert!(reg_b.answer_rx.await.is_ok());
    }

    #[tokio::test]
    async fn register_then_answer_plan_approval_resolves_and_clears() {
        let mgr = ConnectionManager::new();
        mgr.insert_test_connection("pa", AgentType::Grok, None, EventEmitter::Noop)
            .await;
        let reg = mgr
            .register_plan_approval("pa", "call-1".into(), "# Plan\n- step".into())
            .await
            .expect("registered");
        // SessionState reflects the pending approval for snapshot recovery.
        {
            let state = mgr.get_state("pa").await.unwrap();
            let guard = state.read().await;
            let pending = guard.pending_plan_approval.as_ref().expect("pending set");
            assert_eq!(pending.plan_markdown, "# Plan\n- step");
            assert_eq!(pending.tool_call_id, "call-1");
        }

        mgr.answer_plan_approval(
            "pa",
            &reg.approval_id,
            crate::acp::plan_approval::PlanApprovalAnswer {
                decision: crate::acp::plan_approval::PlanApprovalDecision::RequestChanges,
                feedback: Some("use SSE".into()),
            },
        )
        .await
        .unwrap();

        // The blocked ext handler's receiver resolves with the user's decision.
        let got = reg.answer_rx.await.expect("answer delivered");
        assert_eq!(
            got.decision,
            crate::acp::plan_approval::PlanApprovalDecision::RequestChanges
        );
        assert_eq!(got.feedback.as_deref(), Some("use SSE"));
        // pending_plan_approval cleared after resolve.
        assert!(mgr
            .get_state("pa")
            .await
            .unwrap()
            .read()
            .await
            .pending_plan_approval
            .is_none());

        // Idempotent: answering an already-resolved id is a no-op success.
        mgr.answer_plan_approval(
            "pa",
            &reg.approval_id,
            crate::acp::plan_approval::PlanApprovalAnswer {
                decision: crate::acp::plan_approval::PlanApprovalDecision::Approve,
                feedback: None,
            },
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn register_plan_approval_refuses_second_pending_on_same_connection() {
        // At most one approval per connection (the agent is blocked in exit_plan_mode).
        let mgr = ConnectionManager::new();
        mgr.insert_test_connection("pa2", AgentType::Grok, None, EventEmitter::Noop)
            .await;
        let _reg = mgr
            .register_plan_approval("pa2", "c1".into(), "plan".into())
            .await
            .expect("first registers");
        assert!(mgr
            .register_plan_approval("pa2", "c2".into(), "plan2".into())
            .await
            .is_none());
    }

    #[tokio::test]
    async fn cancel_plan_approvals_by_parent_drops_sender_and_clears() {
        let mgr = ConnectionManager::new();
        mgr.insert_test_connection("pax", AgentType::Grok, None, EventEmitter::Noop)
            .await;
        let reg = mgr
            .register_plan_approval("pax", "c".into(), "plan".into())
            .await
            .unwrap();
        mgr.cancel_plan_approvals_by_parent("pax").await;
        // Dropping the sender surfaces to the parked handler as a recv error
        // (which it renders as a disconnect reply — plan mode stays active).
        assert!(reg.answer_rx.await.is_err());
        assert!(mgr
            .get_state("pax")
            .await
            .unwrap()
            .read()
            .await
            .pending_plan_approval
            .is_none());
    }

    #[tokio::test]
    async fn compensate_clears_card_when_entry_drained_before_request_emit() {
        // Regression for the teardown event-ordering race: register inserts, the
        // sweep drains the entry, THEN register's QuestionRequest emit lands. The
        // post-emit presence check must emit a compensating QuestionResolved so no
        // client keeps a card with no live backend waiter, and signal decline.
        let mgr = ConnectionManager::new();
        mgr.insert_test_connection("cc", AgentType::ClaudeCode, None, EventEmitter::Noop)
            .await;
        let (state, emitter) = mgr.get_state_and_emitter("cc").await.unwrap();

        // Simulate register's QuestionRequest emit for an entry that has already
        // been drained (never inserted here): the card shows, nothing is parked.
        emit_with_state(
            &state,
            &emitter,
            AcpEvent::QuestionRequest {
                question_id: "q1".into(),
                questions: q_spec(),
            },
        )
        .await;
        assert!(state.read().await.pending_question.is_some(), "card shown");

        // Missing entry → compensate clears the card and reports decline.
        assert!(
            mgr.compensate_if_question_drained("q1", &state, &emitter)
                .await,
            "missing entry is compensated"
        );
        assert!(
            state.read().await.pending_question.is_none(),
            "compensating QuestionResolved cleared the card"
        );

        // A genuinely-parked entry is left alone (no false compensation).
        let reg = mgr.register_question("cc", q_spec()).await.unwrap();
        assert!(
            !mgr.compensate_if_question_drained(&reg.question_id, &state, &emitter)
                .await,
            "present entry is not compensated"
        );
        assert!(state.read().await.pending_question.is_some());
    }

    #[tokio::test]
    async fn register_question_unknown_connection_is_none() {
        let mgr = ConnectionManager::new();
        assert!(mgr.register_question("nope", q_spec()).await.is_none());
    }

    #[tokio::test]
    async fn second_concurrent_ask_is_refused_and_first_stays_answerable() {
        // A parallel/misbehaving client could fire two asks on one connection
        // before the first resolves. The single-slot card/snapshot can't hold
        // two, so the second is refused (None → declined) and the FIRST stays
        // intact and answerable — never orphaned.
        let mgr = ConnectionManager::new();
        mgr.insert_test_connection("cc2", AgentType::ClaudeCode, None, EventEmitter::Noop)
            .await;
        let first = mgr
            .register_question("cc2", q_spec())
            .await
            .expect("first registers");
        // Second concurrent ask on the same connection is refused.
        assert!(
            mgr.register_question("cc2", q_spec()).await.is_none(),
            "second concurrent ask must be refused"
        );
        // The first is still the pending one and still answerable.
        let state = mgr.get_state("cc2").await.unwrap();
        assert_eq!(
            state.read().await.pending_question.as_ref().map(|p| p.question_id.clone()),
            Some(first.question_id.clone())
        );
        mgr.answer_question(
            "cc2",
            &first.question_id,
            crate::acp::question::QuestionAnswer {
                answers: vec![crate::acp::question::QuestionAnswerItem {
                    question_id: "qa".into(),
                    labels: vec!["A".into()],
                }],
                declined: false,
            },
        )
        .await
        .unwrap();
        assert!(first.answer_rx.await.is_ok(), "first ask resolves");
        // After resolve, a new ask is accepted again.
        assert!(mgr.register_question("cc2", q_spec()).await.is_some());
    }

    #[tokio::test]
    async fn read_pending_is_readonly_commit_marks_delivered() {
        let mgr = ConnectionManager::new();
        mgr.insert_test_connection("c1", AgentType::ClaudeCode, None, EventEmitter::Noop)
            .await;
        mark_feedback_ready(&mgr, "c1").await;
        let a = mgr.submit_feedback("c1", "a".into(), None).await.unwrap();
        let b = mgr.submit_feedback("c1", "b".into(), None).await.unwrap();

        // READ returns both pending notes (insert order) WITHOUT mutating state.
        let pending = mgr.read_pending_feedback("c1").await;
        let texts: Vec<&str> = pending.iter().map(|p| p.text.as_str()).collect();
        assert_eq!(texts, vec!["a", "b"]);
        // A second read still returns them — read is non-destructive, so an
        // abandoned (peer-closed) call leaves the notes retryable.
        assert_eq!(
            mgr.read_pending_feedback("c1")
                .await
                .len(),
            2
        );
        {
            let state = mgr.get_state("c1").await.unwrap();
            assert!(state
                .read()
                .await
                .feedback
                .iter()
                .all(|f| f.status == FeedbackStatus::Pending));
        }

        // COMMIT marks the named notes delivered.
        mgr.commit_feedback_delivered("c1", vec![a.id.clone(), b.id.clone()])
            .await;
        // Now READ returns nothing (delivered notes are filtered out).
        assert!(mgr
            .read_pending_feedback("c1")
            .await
            .is_empty());
        let state = mgr.get_state("c1").await.unwrap();
        assert!(state
            .read()
            .await
            .feedback
            .iter()
            .all(|f| f.status == FeedbackStatus::Delivered));

        // COMMIT is idempotent — re-committing already-delivered ids is a no-op.
        mgr.commit_feedback_delivered("c1", vec![a.id, b.id]).await;
    }

    #[tokio::test]
    async fn read_pending_missing_connection_returns_empty() {
        let mgr = ConnectionManager::new();
        assert!(mgr
            .read_pending_feedback("nope")
            .await
            .is_empty());
        // Commit on a missing connection is a safe no-op.
        mgr.commit_feedback_delivered("nope", vec!["x".into()]).await;
    }

}
