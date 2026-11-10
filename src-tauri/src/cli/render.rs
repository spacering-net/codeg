//! What `codeg-cli` prints, and where.
//!
//! - `text`: the final reply on stdout and nothing else — with
//!   `--output-schema`, the result's JSON on one line, or nothing when there is
//!   none; progress (tool calls, permission decisions) on stderr when it is a
//!   terminal or with `-v`.
//! - `json`: one result object on stdout at the end — on EVERY exit after the
//!   arguments parsed, failures included.
//! - `stream-json`: one event per line on stdout, `init` first, the result
//!   object last.
//!
//! In both JSON formats stdout carries JSON only: warnings, hints and error
//! messages go to stderr. A heartbeat goes to stderr when it is not a
//! terminal and nothing was written for a minute, so a CI step is not killed
//! for silence during a long review.
//!
//! The result is always the last thing printed, after `-o` is written: its
//! event is held back by `event` and printed by `result`.

use std::io::{IsTerminal, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::cli_run::wire::{
    AssistantRef, DecidedBy, EventBody, PermissionDenial, PermissionVerdict, QuestionVerdict,
    RunEvent, RunResult, RunState, RunStatus, Subtype, WorktreeInfo,
};

use super::args::{GlobalArgs, OutputFormat};
use super::Failure;

const HEARTBEAT_AFTER: Duration = Duration::from_secs(60);

pub struct Output {
    format: OutputFormat,
    quiet: bool,
    progress: bool,
    stderr_tty: bool,
    started: Instant,
    /// Shared by a command's runs (`child`): the heartbeat hears them all.
    last_stderr: Arc<Mutex<Instant>>,
    tool_calls: Arc<AtomicU64>,
    /// The highest `seq` seen: a result made up on this side comes after it.
    last_seq: AtomicU64,
    /// Refusals seen as events, for a result made up on this side.
    denials: Mutex<Vec<PermissionDenial>>,
    /// Whether to point out refusals at the end (`--permissions deny`).
    hint_denials: AtomicBool,
    /// Whether the runs were given `--output-schema`, for a result made up on
    /// this side.
    structured: AtomicBool,
    /// With several runs: whose lines these are (`#2 codex`).
    label: Option<String>,
}

/// The run a failure belongs to, as far as it got.
#[derive(Debug, Clone, Default)]
pub struct RunRef {
    pub run_id: Option<String>,
    pub conversation_id: Option<i32>,
    pub link: Option<String>,
    pub agent: Option<String>,
    pub assistant: Option<AssistantRef>,
    pub worktree: Option<WorktreeInfo>,
}

impl Output {
    pub fn new(format: OutputFormat, global: &GlobalArgs) -> Arc<Self> {
        let stderr_tty = std::io::stderr().is_terminal();
        Arc::new(Self::with(
            format,
            global.quiet,
            !global.quiet && (stderr_tty || global.verbose),
            stderr_tty,
        ))
    }

    fn with(format: OutputFormat, quiet: bool, progress: bool, stderr_tty: bool) -> Self {
        Self {
            format,
            quiet,
            progress,
            stderr_tty,
            started: Instant::now(),
            last_stderr: Arc::new(Mutex::new(Instant::now())),
            tool_calls: Arc::new(AtomicU64::new(0)),
            last_seq: AtomicU64::new(0),
            denials: Mutex::new(Vec::new()),
            hint_denials: AtomicBool::new(false),
            structured: AtomicBool::new(false),
            label: None,
        }
    }

    /// The output of one of a command's several runs: its own events and
    /// refusals, its lines marked `[label]`, the heartbeat shared.
    pub fn child(&self, label: String) -> Arc<Self> {
        Arc::new(Self {
            format: self.format,
            quiet: self.quiet,
            progress: self.progress,
            stderr_tty: self.stderr_tty,
            started: self.started,
            last_stderr: Arc::clone(&self.last_stderr),
            tool_calls: Arc::clone(&self.tool_calls),
            last_seq: AtomicU64::new(0),
            denials: Mutex::new(Vec::new()),
            hint_denials: AtomicBool::new(self.hint_denials.load(Ordering::Relaxed)),
            structured: AtomicBool::new(self.structured.load(Ordering::Relaxed)),
            label: Some(label),
        })
    }

    pub fn format(&self) -> OutputFormat {
        self.format
    }

    /// `line`, marked with whose it is when there are several runs.
    fn marked(&self, line: &str) -> String {
        match &self.label {
            Some(label) => format!("[{label}] {line}"),
            None => line.to_string(),
        }
    }

    pub fn hint_denials(&self, on: bool) {
        self.hint_denials.store(on, Ordering::Relaxed);
    }

    pub fn structured(&self, on: bool) {
        self.structured.store(on, Ordering::Relaxed);
    }

    /// The `seq` for a result this side makes up: after every event seen.
    pub fn next_seq(&self) -> u64 {
        self.last_seq.load(Ordering::Relaxed) + 1
    }

    /// One line on stderr. Counts as output for the heartbeat.
    pub fn stderr_line(&self, line: &str) {
        let mut err = std::io::stderr().lock();
        let _ = writeln!(err, "{line}");
        *self.last_stderr.lock().expect("last_stderr") = Instant::now();
    }

    /// A progress line: shown when stderr is a terminal or with `-v`.
    pub fn progress_line(&self, line: &str) {
        if self.progress {
            self.stderr_line(&self.marked(line));
        }
    }

    /// An informational line: suppressed by `-q`.
    pub fn note(&self, line: &str) {
        if !self.quiet {
            self.stderr_line(line);
        }
    }

    fn stdout_line(line: &str) {
        let mut out = std::io::stdout().lock();
        let _ = writeln!(out, "{line}");
        let _ = out.flush();
    }

    /// One JSON value, alone on a line of stdout.
    pub fn json_line(value: &impl serde::Serialize) {
        Self::stdout_line(&serde_json::to_string(value).expect("output serializes"));
    }

    /// A reply on stdout, as `text` prints it: a line of its own.
    pub fn reply(reply: &str) {
        let mut out = std::io::stdout().lock();
        let _ = out.write_all(reply.as_bytes());
        if !reply.ends_with('\n') {
            let _ = out.write_all(b"\n");
        }
        let _ = out.flush();
    }

    /// One event of the run, as it arrives. The result is held back for
    /// `result`.
    pub fn event(&self, event: &RunEvent) {
        self.last_seq.fetch_max(event.seq, Ordering::Relaxed);
        match &event.body {
            EventBody::ToolCall { .. } => {
                self.tool_calls.fetch_add(1, Ordering::Relaxed);
            }
            EventBody::Permission {
                request_id,
                conversation_id,
                tool,
                tool_kind,
                decision: PermissionVerdict::Denied | PermissionVerdict::Failed,
                ..
            } => self
                .denials
                .lock()
                .expect("denials")
                .push(PermissionDenial {
                    tool_name: tool.clone(),
                    tool_kind: tool_kind.clone(),
                    request_id: request_id.clone(),
                    conversation_id: *conversation_id,
                }),
            EventBody::Result(_) => return,
            _ => {}
        }
        match self.format {
            OutputFormat::StreamJson => {
                Self::stdout_line(&serde_json::to_string(event).expect("events serialize"));
            }
            OutputFormat::Json => {}
            OutputFormat::Text => {
                if self.progress {
                    if let Some(line) = describe(&event.body) {
                        self.stderr_line(&self.marked(&line));
                    }
                }
            }
        }
    }

    /// The run's result: the last thing printed.
    pub fn result(&self, event: &RunEvent) {
        let Some(result) = event.result() else {
            return;
        };
        match self.format {
            OutputFormat::StreamJson | OutputFormat::Json => {
                Self::stdout_line(&serde_json::to_string(event).expect("results serialize"));
                if let Some(error) = &result.error {
                    self.error_lines(&error.message, &error.next_steps);
                }
            }
            OutputFormat::Text => {
                if let Some(reply) = reply_text(result) {
                    Self::reply(&reply);
                }
                if let Some(error) = &result.error {
                    self.error_lines(&error.message, &error.next_steps);
                }
            }
        }
        self.denial_hint(result.permission_denials.len());
        if let Some(link) = &result.link {
            if self.progress {
                self.stderr_line(&format!("conversation: {link}"));
            }
        }
    }

    /// `--detach`: the run's `init` and nothing after it — the run goes on.
    /// `text` prints the run's id alone on stdout, for `RUN=$(codeg-cli …)`.
    pub fn detached(&self, init: &RunEvent) {
        let run_id = init.run_id.clone().unwrap_or_default();
        match self.format {
            OutputFormat::StreamJson | OutputFormat::Json => {
                Self::stdout_line(&serde_json::to_string(init).expect("events serialize"));
            }
            OutputFormat::Text => Self::stdout_line(&run_id),
        }
        let link = match &init.body {
            EventBody::Init { link, .. } => link.as_str(),
            _ => "",
        };
        self.note(&format!(
            "codeg-cli: the run goes on in Codeg ({link}); collect it with `codeg-cli result \
             {run_id}`"
        ));
    }

    /// `result` for a run that has not settled within its `--wait`.
    pub fn still_running(&self, status: &RunStatus) {
        if self.format.is_json() {
            Self::stdout_line(&serde_json::to_string(status).expect("statuses serialize"));
        }
        let link = status
            .link
            .as_deref()
            .map(|l| format!(" ({l})"))
            .unwrap_or_default();
        self.note(&format!(
            "codeg-cli: run {} is still {}{link}; it was not cancelled",
            status.run_id,
            match status.state {
                RunState::Reserved | RunState::Starting => "starting",
                RunState::Running | RunState::Settled => "running",
            }
        ));
    }

    pub fn error_lines(&self, message: &str, next_steps: &[String]) {
        self.stderr_line(&format!("codeg-cli: {}", self.marked(message)));
        for step in next_steps {
            self.stderr_line(&format!("  try: {step}"));
        }
    }

    /// How many refusals this output saw as events.
    pub fn refused(&self) -> usize {
        self.denials.lock().expect("denials").len()
    }

    pub fn denial_hint(&self, refused: usize) {
        if refused > 0 && self.hint_denials.load(Ordering::Relaxed) && !self.quiet {
            self.stderr_line(&format!(
                "codeg-cli: {refused} permission request(s) were refused by --permissions deny; \
                 --permissions allow lets them through once each, or set the agent's own mode \
                 with --mode"
            ));
        }
    }

    /// A failure on this side: as a result object in the JSON formats, as a
    /// message otherwise — after every event printed, with the refusals seen.
    pub fn failure(&self, failure: &Failure, run: &RunRef) {
        if self.format.is_json() {
            Self::json_line(&self.failure_event(failure, run));
        }
        // The message goes to stderr in every format: a person reads it there,
        // and stdout stays JSON-only.
        self.error_lines(&failure.message, &failure.next_steps);
        self.denial_hint(self.refused());
    }

    /// The result object of a failure on this side: after every event seen,
    /// with the refusals among them.
    pub fn failure_event(&self, failure: &Failure, run: &RunRef) -> RunEvent {
        RunEvent::new(
            self.next_seq(),
            run.run_id.clone(),
            EventBody::Result(Box::new(RunResult {
                subtype: failure.subtype,
                is_error: true,
                result: None,
                session_id: None,
                stop_reason: None,
                duration_ms: self.started.elapsed().as_millis() as u64,
                permission_denials: self.denials.lock().expect("denials").clone(),
                launch: Default::default(),
                pending: None,
                conversation_id: run.conversation_id,
                link: run.link.clone(),
                agent: run.agent.clone(),
                assistant: run.assistant.clone(),
                target_index: None,
                worktree: run.worktree.clone(),
                structured_output: self
                    .structured
                    .load(Ordering::Relaxed)
                    .then_some(serde_json::Value::Null),
                error: Some(failure.info()),
            })),
        )
    }

    /// Lines for a long silence, on a non-terminal stderr only.
    pub fn spawn_heartbeat(self: &Arc<Self>) -> Option<tokio::task::JoinHandle<()>> {
        if self.stderr_tty || self.quiet {
            return None;
        }
        let out = Arc::clone(self);
        Some(tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(5));
            loop {
                tick.tick().await;
                out.heartbeat_tick(Instant::now());
            }
        }))
    }

    fn heartbeat_tick(&self, now: Instant) {
        let silent_for = now.duration_since(*self.last_stderr.lock().expect("last_stderr"));
        if silent_for >= HEARTBEAT_AFTER {
            self.stderr_line(&heartbeat_line(
                now.duration_since(self.started),
                self.tool_calls.load(Ordering::Relaxed),
            ));
        }
    }
}

fn heartbeat_line(elapsed: Duration, tool_calls: u64) -> String {
    let minutes = elapsed.as_secs() / 60;
    format!("codeg-cli: still running ({minutes}m so far, {tool_calls} tool calls)")
}

/// A progress line for an event, in `text` mode.
fn describe(body: &EventBody) -> Option<String> {
    Some(match body {
        EventBody::Init { agent, link, .. } => format!("▸ started {agent} — {link}"),
        EventBody::ToolCall { title, kind, .. } => format!("▸ {title} ({kind})"),
        EventBody::Permission {
            tool,
            decision,
            decided_by,
            ..
        } => {
            let by = match decided_by {
                Some(DecidedBy::Policy) => " by --permissions",
                Some(DecidedBy::User) => " in Codeg",
                _ => "",
            };
            match decision {
                PermissionVerdict::Allowed => format!("▸ permission for {tool}: allowed{by}"),
                PermissionVerdict::Denied => format!("▸ permission for {tool}: refused{by}"),
                PermissionVerdict::Failed => {
                    format!("▸ permission for {tool}: needed, and --permissions fail ends the run")
                }
                PermissionVerdict::Waiting => {
                    format!("▸ permission for {tool}: waiting for you in Codeg")
                }
                PermissionVerdict::Withdrawn => format!("▸ permission for {tool}: withdrawn"),
            }
        }
        EventBody::Question { decision, .. } => match decision {
            QuestionVerdict::Declined => "▸ the agent asked a question; declined".to_string(),
            QuestionVerdict::Waiting => {
                "▸ the agent asked a question; waiting for you in Codeg".to_string()
            }
        },
        EventBody::Notice {
            severity,
            title,
            message,
        } => match message {
            Some(m) => format!("{severity}: {title} — {m}"),
            None => format!("{severity}: {title}"),
        },
        EventBody::Error { message, .. } => format!("error: {message}"),
        EventBody::Gap {} => "warning: some progress events were lost".to_string(),
        _ => return None,
    })
}

/// What `text` prints on stdout for a result: the reply — or, for a run given
/// `--output-schema`, its result's JSON on one line, and nothing when it has
/// none: what is not that JSON never goes there.
pub fn reply_text(result: &RunResult) -> Option<String> {
    match &result.structured_output {
        None => result.result.clone(),
        Some(serde_json::Value::Null) => None,
        Some(output) => Some(serde_json::to_string(output).expect("JSON serializes")),
    }
}

/// What `-o` writes: what `text` prints, the result's JSON with its line end.
pub fn file_text(result: &RunResult) -> Option<String> {
    let text = reply_text(result)?;
    Some(match result.structured_output {
        Some(_) => text + "\n",
        None => text,
    })
}

/// The exit code for a result: its subtype's, with an interrupted run taking
/// the code of the signal that interrupted it.
pub fn exit_code(result: &RunResult, signal_code: Option<i32>) -> i32 {
    match (result.subtype, signal_code) {
        (Subtype::ErrorInterrupted, Some(code)) => code,
        (subtype, _) => subtype.exit_code(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_heartbeat_says_how_long_and_how_much() {
        assert_eq!(
            heartbeat_line(Duration::from_secs(185), 7),
            "codeg-cli: still running (3m so far, 7 tool calls)"
        );
    }

    #[test]
    fn a_heartbeat_waits_for_a_minute_of_silence() {
        let out = Output::with(OutputFormat::Text, false, false, false);
        let before = *out.last_stderr.lock().unwrap();
        out.heartbeat_tick(before + Duration::from_secs(30));
        assert_eq!(*out.last_stderr.lock().unwrap(), before, "not yet");
        // A minute of silence writes one line, which itself resets the clock.
        let later = before + Duration::from_secs(61);
        out.heartbeat_tick(later);
        assert!(*out.last_stderr.lock().unwrap() > before);
    }

    #[test]
    fn progress_lines_say_who_decided() {
        let line = describe(&EventBody::Permission {
            request_id: "r".into(),
            conversation_id: None,
            tool: "Bash".into(),
            tool_kind: None,
            decision: PermissionVerdict::Denied,
            decided_by: Some(DecidedBy::Policy),
            option_name: None,
        })
        .unwrap();
        assert_eq!(line, "▸ permission for Bash: refused by --permissions");
        assert!(describe(&EventBody::MessageDelta { text: "x".into() }).is_none());
    }

    fn quiet_output(format: OutputFormat) -> Output {
        Output::with(format, true, false, false)
    }

    /// A result made up on this side comes after what was streamed — a
    /// consumer following `seq` must not take it for an old event — and
    /// keeps the refusals already reported.
    #[test]
    fn a_result_made_up_here_follows_the_events_and_keeps_their_refusals() {
        let out = quiet_output(OutputFormat::Json);
        out.event(&RunEvent::new(
            7,
            Some("r".into()),
            EventBody::Permission {
                request_id: "p1".into(),
                conversation_id: Some(3),
                tool: "Bash".into(),
                tool_kind: Some("execute".into()),
                decision: PermissionVerdict::Denied,
                decided_by: Some(DecidedBy::Policy),
                option_name: None,
            },
        ));
        out.event(&RunEvent::new(
            9,
            Some("r".into()),
            EventBody::MessageDelta { text: "x".into() },
        ));
        assert_eq!(out.next_seq(), 10);
        let denials = out.denials.lock().unwrap().clone();
        assert_eq!(denials.len(), 1);
        assert_eq!(denials[0].tool_name, "Bash");
        assert_eq!(denials[0].conversation_id, Some(3));
    }

    /// `text` prints the reply, or for a run given `--output-schema` its
    /// result on one line — and nothing at all when it has none, so stdout
    /// never holds anything else. A result made up on this side for such a
    /// run says it had none.
    #[test]
    fn text_prints_the_result_of_a_structured_run_and_nothing_else() {
        let mut result = RunResult {
            subtype: Subtype::Success,
            is_error: false,
            result: Some("Looks good.".into()),
            session_id: None,
            stop_reason: None,
            duration_ms: 0,
            permission_denials: vec![],
            launch: Default::default(),
            pending: None,
            conversation_id: None,
            link: None,
            agent: None,
            assistant: None,
            target_index: None,
            worktree: None,
            structured_output: None,
            error: None,
        };
        assert_eq!(reply_text(&result).as_deref(), Some("Looks good."));
        assert_eq!(file_text(&result).as_deref(), Some("Looks good."));
        result.structured_output = Some(serde_json::json!({"verdict": "pass", "n": [1, 2]}));
        assert_eq!(
            reply_text(&result).as_deref(),
            Some(r#"{"verdict":"pass","n":[1,2]}"#)
        );
        assert_eq!(
            file_text(&result).as_deref(),
            Some("{\"verdict\":\"pass\",\"n\":[1,2]}\n")
        );
        result.structured_output = Some(serde_json::Value::Null);
        assert_eq!(reply_text(&result), None);
        assert_eq!(file_text(&result), None);

        let out = quiet_output(OutputFormat::Json);
        let failure = Failure::usage("timeout", "x");
        let made_up = |out: &Output| {
            out.failure_event(&failure, &RunRef::default())
                .result()
                .cloned()
                .unwrap()
                .structured_output
        };
        assert_eq!(made_up(&out), None);
        out.structured(true);
        assert_eq!(made_up(&out), Some(serde_json::Value::Null));
    }

    #[test]
    fn an_interrupted_run_exits_with_the_signals_code() {
        let mut result = RunResult {
            subtype: Subtype::ErrorInterrupted,
            is_error: true,
            result: None,
            session_id: None,
            stop_reason: None,
            duration_ms: 0,
            permission_denials: vec![],
            launch: Default::default(),
            pending: None,
            conversation_id: None,
            link: None,
            agent: None,
            assistant: None,
            target_index: None,
            worktree: None,
            structured_output: None,
            error: None,
        };
        assert_eq!(exit_code(&result, Some(143)), 143);
        assert_eq!(exit_code(&result, None), 130);
        result.subtype = Subtype::ErrorTimeout;
        assert_eq!(exit_code(&result, Some(143)), 3);
    }
}
