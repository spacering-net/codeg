//! `codeg-cli run`: one prompt, one turn.
//!
//! reserve → start → long-poll events → result. The runtime owns the run, so
//! this side only has to be careful about three things: a lost `start`
//! answer (retried with the same run id, which never starts a second run),
//! the clock (`--timeout` counts from the start of the command, and the
//! runtime keeps its own copy of what is left), and signals (the first
//! SIGINT/SIGTERM cancels the run and waits up to 10 s for its result; a
//! second exits at once — the cancel stands either way).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::time::Instant;

use crate::cli_run::output_schema::check_shape;
use crate::cli_run::service::MAX_PROMPT_BYTES;
use crate::cli_run::wire::{
    capability, CancelReason, ErrorInfo, EventBody, EventsRequest, EventsResponse, PromptBlock,
    ReserveResponse, RunEvent, StartRequest, StartResponse, Subtype,
};
use crate::cli_run::PermissionPolicy;

use super::args::{GlobalArgs, RunArgs, Target};
use super::connect::{self, Connection, Env};
use super::render::{self, Output, RunRef};
use super::{stdin, Failure};

/// A poll waits this long on the runtime; the request itself, ten seconds
/// longer.
const POLL_WAIT: Duration = Duration::from_secs(25);
const POLL_TIMEOUT: Duration = Duration::from_secs(35);
/// How long the launch may take: spawning the agent, its first selectors,
/// confirming the explicit selections.
const START_TIMEOUT: Duration = Duration::from_secs(300);
/// After a cancel: how long to wait for the run's result.
const SETTLE_WAIT: Duration = Duration::from_secs(10);
/// How long the runtime may stay unreachable mid-run before giving up.
const LOST_AFTER: Duration = Duration::from_secs(30);
/// After a second signal: how long the first one's cancel may still take to
/// reach the runtime before the process exits.
const CANCEL_GRACE: Duration = Duration::from_secs(2);

pub async fn run(global: &GlobalArgs, args: RunArgs, env: &Env) -> i32 {
    if args.targets.len() > 1 {
        return super::fanout::run(global, args, env).await;
    }
    let out = Output::new(args.output_format, global);
    out.hint_denials(PermissionPolicy::from(args.permissions) == PermissionPolicy::Deny);
    out.structured(args.output_schema.is_some());
    // From the first moment: a job waiting on stdin or on the runtime is as
    // silent, and as interruptible, as one waiting on the agent.
    let heartbeat = out.spawn_heartbeat();
    let mut interrupts = Interrupts::Own(Signals::install());
    let deadline = args.timeout.and_then(|d| Instant::now().checked_add(d));
    let mut run_ref = RunRef::default();
    let code = match run_inner(
        global,
        &args,
        env,
        &out,
        deadline,
        &mut run_ref,
        &mut interrupts,
    )
    .await
    {
        Ok(code) => code,
        Err(failure) => {
            out.failure(&failure, &run_ref);
            failure.exit_code()
        }
    };
    if let Some(h) = heartbeat {
        h.abort();
    }
    code
}

async fn run_inner(
    global: &GlobalArgs,
    args: &RunArgs,
    env: &Env,
    out: &Arc<Output>,
    deadline: Option<Instant>,
    run_ref: &mut RunRef,
    interrupts: &mut Interrupts,
) -> Result<i32, Failure> {
    // Until the run is reserved nothing was sent: a signal or the deadline
    // here ends the command with nothing to cancel.
    let setup = async {
        let prepared = prepare(global, args, env, out, deadline).await?;
        let reserved = within(deadline, reserve(&prepared.conn)).await??;
        Ok((prepared, reserved))
    };
    let (prepared, reserved) = tokio::select! {
        ready = setup => ready?,
        code = interrupts.recv() => {
            return Err(Failure::interrupted(
                code,
                "interrupted before the run started; nothing was sent",
            ));
        }
    };
    run_ref.run_id = Some(reserved.run_id.clone());
    let request = start_request(
        args,
        args.targets.first(),
        &prepared,
        reserved.run_id,
        args.worktree.clone(),
        deadline,
        env,
    );
    match drive(
        &prepared.conn,
        args,
        out,
        deadline,
        request,
        run_ref,
        interrupts,
    )
    .await?
    {
        Driven::Settled { event, signal_code } => {
            Ok(finish(out, args.output.as_deref(), &event, signal_code))
        }
        Driven::Detached(init) => {
            out.detached(&init);
            Ok(0)
        }
    }
}

/// What a command needs once, before any run: the prompt (stdin is read
/// once), the runtime proved, and the workspace — checked against what that
/// runtime can do.
pub(super) struct Prepared {
    pub prompt: Vec<PromptBlock>,
    pub conn: Connection,
    pub workspace: String,
    /// `--output-schema`, read.
    pub output_schema: Option<Value>,
}

pub(super) async fn prepare(
    global: &GlobalArgs,
    args: &RunArgs,
    env: &Env,
    out: &Arc<Output>,
    deadline: Option<Instant>,
) -> Result<Prepared, Failure> {
    let output_schema = args
        .output_schema
        .as_deref()
        .map(read_output_schema)
        .transpose()?;
    let prompt = within(deadline, read_prompt(args)).await??;
    let (conn, candidates) = within(deadline, connect::connect(global, env)).await??;
    let ready = candidates
        .iter()
        .filter(|c| c.state == connect::CandidateState::Ready)
        .count();
    if ready > 1 || global.verbose {
        out.note(&format!(
            "codeg-cli: using the {:?} {:?} codeg {} ({})",
            conn.hello.build, conn.hello.runtime, conn.hello.version, conn.source
        ));
    }
    if args.open {
        if let Some(refusal) = open_refusal(conn.remote, conn.hello.runtime, &conn.source) {
            return Err(refusal);
        }
    }
    let needs = [
        (true, capability::RUN, "running prompts"),
        (args.effort.is_some(), capability::EFFORT, "--effort"),
        (args.open, capability::OPEN_SESSION, "--open"),
        (args.worktree.is_some(), capability::WORKTREE, "--worktree"),
        (
            args.output_schema.is_some(),
            capability::OUTPUT_SCHEMA,
            "--output-schema",
        ),
    ];
    for (needed, cap, what) in needs {
        if needed && !conn.has(cap) {
            return Err(incompatible(&conn, cap, what));
        }
    }
    let workspace = workspace(args, conn.remote)?;
    Ok(Prepared {
        prompt,
        conn,
        workspace,
        output_schema,
    })
}

/// The largest `--output-schema` file read. The schema itself may be 64 KiB
/// once compact (`check_shape`); this leaves room for its layout.
const MAX_SCHEMA_FILE_BYTES: u64 = 1024 * 1024;

/// `--output-schema FILE`: JSON, an object, of objects at its root. The
/// runtime compiles it, and says what else is wrong with it.
fn read_output_schema(path: &Path) -> Result<Value, Failure> {
    let bad = |why: String| {
        Failure::usage(
            "bad_output_schema",
            format!("--output-schema {}: {why}", path.display()),
        )
    };
    let size = std::fs::metadata(path)
        .map_err(|e| bad(e.to_string()))?
        .len();
    if size > MAX_SCHEMA_FILE_BYTES {
        return Err(bad(format!(
            "{size} bytes is too large for a schema of at most 64 KiB"
        )));
    }
    let text = std::fs::read_to_string(path).map_err(|e| bad(e.to_string()))?;
    let schema: Value =
        serde_json::from_str(&text).map_err(|e| bad(format!("this is not JSON: {e}")))?;
    check_shape(&schema).map_err(bad)?;
    Ok(schema)
}

/// A run id, with no side effect: a start that never comes lets it expire.
pub(super) async fn reserve(conn: &Connection) -> Result<ReserveResponse, Failure> {
    conn.post("cli_run_reserve", &json!({}), Duration::from_secs(30))
        .await
}

/// The start of run `run_id`: the prompt and options of the command, with
/// `target`'s agent or assistant (none: the workspace's default agent).
pub(super) fn start_request(
    args: &RunArgs,
    target: Option<&Target>,
    prepared: &Prepared,
    run_id: String,
    worktree: Option<String>,
    deadline: Option<Instant>,
    env: &Env,
) -> StartRequest {
    StartRequest {
        run_id,
        workspace: prepared.workspace.clone(),
        agent: target.and_then(Target::agent),
        assistant: target.and_then(Target::assistant),
        prompt: prepared.prompt.clone(),
        model: args.model.clone(),
        effort: args.effort.clone(),
        mode: args.mode.clone(),
        config: args.config.iter().cloned().collect(),
        permissions: args.permissions.into(),
        title: args.title.clone(),
        timeout_ms: remaining_ms(deadline),
        caller: env.caller.clone(),
        open: args.open,
        worktree,
        output_schema: prepared.output_schema.clone(),
    }
}

/// How a run ended for this command.
pub(super) enum Driven {
    /// The result event (not printed yet), and the signal that interrupted
    /// the run, if one did.
    Settled {
        event: RunEvent,
        signal_code: Option<i32>,
    },
    /// `--detach`: the run's `init`; the run goes on.
    Detached(RunEvent),
}

/// `start`, then the events until the result. A cancel sent on the way gets
/// a moment to reach the runtime however the command ends — the process exit
/// would drop it (the runtime also cancels on its own clock).
#[allow(clippy::too_many_arguments)]
pub(super) async fn drive(
    conn: &Connection,
    args: &RunArgs,
    out: &Arc<Output>,
    deadline: Option<Instant>,
    request: StartRequest,
    run_ref: &mut RunRef,
    interrupts: &mut Interrupts,
) -> Result<Driven, Failure> {
    let mut cancelling: Option<tokio::task::JoinHandle<()>> = None;
    let outcome = drive_loop(
        conn,
        args,
        out,
        deadline,
        request,
        run_ref,
        interrupts,
        &mut cancelling,
    )
    .await;
    if let Some(task) = cancelling.take() {
        let _ = tokio::time::timeout(CANCEL_GRACE, task).await;
    }
    outcome
}

#[allow(clippy::too_many_arguments)]
async fn drive_loop(
    conn: &Connection,
    args: &RunArgs,
    out: &Arc<Output>,
    deadline: Option<Instant>,
    request: StartRequest,
    run_ref: &mut RunRef,
    interrupts: &mut Interrupts,
    cancelling: &mut Option<tokio::task::JoinHandle<()>>,
) -> Result<Driven, Failure> {
    let run_id = request.run_id.clone();
    let mut signal_code: Option<i32> = None;
    // A cancel sent, and the time its result is awaited until. The cancel
    // runs on its own: a second signal does not wait for it.
    let mut settle_by: Option<Instant> = None;

    // ── start (retried with the same run id: never a second run) ──
    // Given up on (a signal, the deadline), the start's answer is no longer
    // waited for; the runtime carries the launch on and the cancel stops it.
    let started: Option<StartResponse> = tokio::select! {
        started = start_with_retry(conn, &request, deadline) => Some(started?),
        code = interrupts.recv() => {
            signal_code = Some(code);
            *cancelling = Some(spawn_cancel(conn, &run_id, CancelReason::Interrupt));
            settle_by = Some(Instant::now() + SETTLE_WAIT);
            None
        }
        _ = sleep_until_opt(deadline) => {
            *cancelling = Some(spawn_cancel(conn, &run_id, CancelReason::Timeout));
            settle_by = Some(Instant::now() + SETTLE_WAIT);
            None
        }
    };
    if let Some(started) = &started {
        run_ref.conversation_id = Some(started.conversation_id);
        run_ref.link = Some(started.link.clone());
        run_ref.agent = Some(started.agent.clone());
        run_ref.assistant = started.assistant.clone();
        run_ref.worktree = started.worktree.clone();
        if args.detach {
            // The prompt is with the agent (what a successful start means):
            // the run goes on without this command.
            return Ok(Driven::Detached(init_event(started, &request.workspace)));
        }
        if args.permissions == super::args::PolicyArg::Wait {
            out.note(&format!(
                "codeg-cli: --permissions wait: answer the agent's requests in Codeg at {}",
                started.link
            ));
        }
    }

    // ── events until the result ──
    let mut after = 0u64;
    let mut unreachable_since: Option<Instant> = None;
    loop {
        let page_request = EventsRequest {
            run_id: run_id.clone(),
            after,
            wait_ms: POLL_WAIT.as_millis() as u64,
        };
        let poll_started = Instant::now();
        let poll = conn.post::<_, EventsResponse>("cli_run_events", &page_request, POLL_TIMEOUT);
        tokio::select! {
            polled = poll => match polled {
                Ok(page) => {
                    unreachable_since = None;
                    after = page.next;
                    for event in &page.events {
                        out.event(event);
                        if event.result().is_some() {
                            return Ok(Driven::Settled { event: event.clone(), signal_code });
                        }
                    }
                    if page.done {
                        // Done without a result event in this page: read it.
                        let event = read_result(conn, out, &run_id).await?;
                        return Ok(Driven::Settled { event, signal_code });
                    }
                }
                Err(f) if is_transient(&f) => {
                    // From the start of the first request that got no answer:
                    // a poll that hangs is as unanswered as one refused.
                    let since = *unreachable_since.get_or_insert(poll_started);
                    if since.elapsed() > LOST_AFTER {
                        return Err(lost(f, &run_id));
                    }
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
                Err(f) => return Err(f),
            },
            code = interrupts.recv() => {
                if signal_code.is_some() {
                    // Quit now (the first signal's cancel still gets its moment).
                    return Err(Failure::interrupted(code, "interrupted; the run was cancelled"));
                }
                signal_code = Some(code);
                out.note("codeg-cli: interrupted; cancelling the run (again to quit now)");
                *cancelling = Some(spawn_cancel(conn, &run_id, CancelReason::Interrupt));
                settle_by = Some(Instant::now() + SETTLE_WAIT);
            }
            _ = sleep_until_opt(deadline), if settle_by.is_none() => {
                *cancelling = Some(spawn_cancel(conn, &run_id, CancelReason::Timeout));
                settle_by = Some(Instant::now() + SETTLE_WAIT);
            }
            _ = sleep_until_opt(settle_by) => {
                return Err(match signal_code {
                    Some(code) => Failure::interrupted(code, "interrupted; the run was cancelled"),
                    None => Failure::new(
                        Subtype::ErrorTimeout,
                        "timeout",
                        "--timeout ran out; the run was cancelled",
                    ),
                });
            }
        }
    }
}

async fn start_with_retry(
    conn: &Connection,
    request: &StartRequest,
    deadline: Option<Instant>,
) -> Result<StartResponse, Failure> {
    let mut attempt = 0;
    loop {
        attempt += 1;
        let timeout = match deadline {
            Some(d) => d
                .saturating_duration_since(Instant::now())
                .min(START_TIMEOUT),
            None => START_TIMEOUT,
        };
        // What is left of the budget at each attempt: a retry gives the
        // runtime no more time than the command still has.
        let mut request = request.clone();
        request.timeout_ms = remaining_ms(deadline);
        match conn.post("cli_run_start", &request, timeout).await {
            Ok(started) => return Ok(started),
            // The answer may have been lost after the runtime took the run:
            // the same run id gets the same run back.
            Err(f) if is_transient(&f) && attempt < 5 => {
                tokio::time::sleep(Duration::from_millis(300 * attempt)).await;
            }
            Err(f) => return Err(f),
        }
    }
}

/// The `init` event of a run that `start` answered for: what `--detach`
/// prints, as `stream-json` would have printed it first.
fn init_event(started: &StartResponse, workspace: &str) -> RunEvent {
    RunEvent::new(
        1,
        Some(started.run_id.clone()),
        EventBody::Init {
            conversation_id: started.conversation_id,
            folder_id: started.folder_id,
            agent: started.agent.clone(),
            assistant: started.assistant.clone(),
            workspace: started
                .workspace
                .clone()
                .unwrap_or_else(|| workspace.to_string()),
            link: started.link.clone(),
            worktree: started.worktree.clone(),
        },
    )
}

/// The budget left before `deadline`, as the runtime's `timeoutMs`.
fn remaining_ms(deadline: Option<Instant>) -> Option<u64> {
    deadline.map(|d| {
        d.saturating_duration_since(Instant::now())
            .as_millis()
            .clamp(1, u64::MAX as u128) as u64
    })
}

async fn read_result(
    conn: &Connection,
    out: &Arc<Output>,
    run_id: &str,
) -> Result<RunEvent, Failure> {
    let got: crate::cli_run::wire::GetResponse = conn
        .post(
            "cli_run_get",
            &json!({ "runId": run_id }),
            Duration::from_secs(30),
        )
        .await?;
    let Some(result) = got.result else {
        return Err(Failure::new(
            Subtype::ErrorRuntimeUnavailable,
            "result_missing",
            "the run ended without a result",
        ));
    };
    let event = RunEvent::new(
        out.next_seq(),
        Some(run_id.to_string()),
        EventBody::Result(Box::new(result)),
    );
    out.event(&event);
    Ok(event)
}

/// Write `-o`, then print the result — so that a reply that could not be
/// written is part of the result printed, exit code and all.
pub(super) fn finish(
    out: &Arc<Output>,
    output: Option<&Path>,
    event: &RunEvent,
    signal_code: Option<i32>,
) -> i32 {
    let event = write_output(out, output, event);
    out.result(&event);
    let result = event.result().expect("a result event");
    render::exit_code(result, signal_code)
}

/// The result event once `-o` is written: written for a failed turn too,
/// when it produced a reply (the exit code and `is_error` say how it went);
/// without a reply the file is left as it was. With `--output-schema` the
/// file is the result's JSON, and is left as it was without one. A reply that
/// could not be written turns a success into `output_unwritable`.
pub(super) fn write_output(out: &Output, output: Option<&Path>, event: &RunEvent) -> RunEvent {
    let mut event = event.clone();
    let reply = event.result().and_then(render::file_text);
    if let (Some(path), Some(reply)) = (output, reply) {
        if let Err(e) = write_atomically(path, &reply) {
            let message = format!("cannot write the reply to {}: {e}", path.display());
            match &mut event.body {
                EventBody::Result(r) if !r.is_error => {
                    r.subtype = Subtype::ErrorDuringExecution;
                    r.is_error = true;
                    r.error = Some(ErrorInfo {
                        code: "output_unwritable".into(),
                        message,
                        next_steps: Vec::new(),
                    });
                }
                // The run's own error comes first; this one is said beside it.
                _ => out.error_lines(&message, &[]),
            }
        }
    }
    event
}

/// Same-directory temporary file, then rename: a reader never sees half a
/// reply, and a failed write leaves the old file alone.
pub fn write_atomically(path: &Path, text: &str) -> std::io::Result<()> {
    let dir = match path.parent() {
        Some(d) if !d.as_os_str().is_empty() => d.to_path_buf(),
        _ => PathBuf::from("."),
    };
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "output".into());
    let tmp = dir.join(format!(
        ".{name}.tmp-{}",
        crate::cli_run::hello::random_hex(4)
    ));
    let written = std::fs::write(&tmp, text).and_then(|()| std::fs::rename(&tmp, path));
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written
}

async fn read_prompt(args: &RunArgs) -> Result<Vec<PromptBlock>, Failure> {
    let readable = !args.no_stdin && stdin::is_readable();
    let given = args.prompt.clone().or_else(|| args.prompt_arg.clone());
    let mut blocks = Vec::new();
    match given.as_deref() {
        Some("-") => {
            if !readable {
                return Err(no_stdin_failure());
            }
            blocks.push(stdin::read_all(MAX_PROMPT_BYTES).await?);
        }
        Some(text) => {
            blocks.push(text.to_string());
            // Prompt + piped stdin: stdin is context for the prompt
            // (`git diff | codeg-cli -p "review"`).
            if readable {
                let rest = MAX_PROMPT_BYTES.saturating_sub(text.len());
                let piped = stdin::read_all(rest).await?;
                if !piped.is_empty() {
                    blocks.push(piped);
                }
            }
        }
        None => {
            if !readable {
                return Err(no_stdin_failure());
            }
            blocks.push(stdin::read_all(MAX_PROMPT_BYTES).await?);
        }
    }
    let total: usize = blocks.iter().map(String::len).sum();
    if total > MAX_PROMPT_BYTES {
        return Err(Failure::usage(
            "prompt_too_large",
            "the prompt and stdin together exceed 10 MiB",
        ));
    }
    if blocks.iter().all(|b| b.trim().is_empty()) {
        return Err(Failure::usage("empty_prompt", "the prompt is empty"));
    }
    Ok(blocks
        .into_iter()
        .filter(|b| !b.is_empty())
        .map(|text| PromptBlock::Text { text })
        .collect())
}

fn no_stdin_failure() -> Failure {
    Failure::usage(
        "no_prompt",
        "no prompt: give one with -p, as an argument, or on a pipe (stdin is a terminal or \
         empty device, so it is not read)",
    )
    .with_next_steps([
        "codeg-cli -p \"review the diff\"".to_string(),
        "git diff | codeg-cli -p \"review this\"".to_string(),
    ])
}

/// The workspace to send. On this machine's codeg: the current directory by
/// default, a relative path made absolute against it — lexically, as
/// written (not trimmed, not resolved through links). With `--url` the path
/// belongs to the server's machine: required, and sent untouched, since this
/// machine's rules may not even read it as absolute (`C:\repo` from Linux).
fn workspace(args: &RunArgs, remote: bool) -> Result<String, Failure> {
    if remote {
        return args.workspace.clone().ok_or_else(|| {
            Failure::usage(
                "workspace_required",
                "with --url, -w is required: a directory on the server's machine",
            )
        });
    }
    let path = match &args.workspace {
        None => std::env::current_dir()
            .map_err(|e| Failure::usage("no_cwd", format!("no current directory: {e}")))?,
        Some(raw) => std::path::absolute(raw)
            .map_err(|e| Failure::usage("bad_workspace", format!("{raw:?}: {e}")))?,
    };
    Ok(path.to_string_lossy().into_owned())
}

fn incompatible(conn: &Connection, capability: &str, what: &str) -> Failure {
    Failure::new(
        Subtype::ErrorRuntimeIncompatible,
        "runtime_incompatible",
        format!(
            "the codeg at {} ({} {}) does not support {what} (capability {capability:?}). \
             Nothing was sent.",
            conn.source,
            match conn.hello.runtime {
                crate::cli_run::wire::RuntimeKind::Desktop => "desktop",
                crate::cli_run::wire::RuntimeKind::Server => "server",
            },
            conn.hello.version
        ),
    )
    .with_next_steps(["upgrade codeg on that machine".to_string()])
}

/// `--open` brings the conversation up in this computer's desktop app: with a
/// server, or over `--url`, it is a usage error — no upgrade would make it
/// work. A desktop that lacks the capability is an older one, which the
/// capability check reports as such.
fn open_refusal(
    remote: bool,
    runtime: crate::cli_run::wire::RuntimeKind,
    source: &str,
) -> Option<Failure> {
    let why = if remote {
        "--open opens the conversation in this computer's desktop app; it does not go with \
         --url"
            .to_string()
    } else if runtime != crate::cli_run::wire::RuntimeKind::Desktop {
        format!("--open needs the desktop app; {source} is a codeg-server")
    } else {
        return None;
    };
    Some(Failure::usage("open_unsupported", why))
}

fn lost(failure: Failure, run_id: &str) -> Failure {
    Failure::new(
        Subtype::ErrorRuntimeUnavailable,
        "runtime_lost",
        format!("lost the runtime mid-run: {}", failure.message),
    )
    .with_next_steps([
        "the run may still be going: open its conversation in Codeg to watch or cancel it"
            .to_string(),
        format!("codeg-cli result {run_id} --wait 30m   (once that codeg answers again)"),
    ])
}

fn is_transient(failure: &Failure) -> bool {
    failure.subtype == Subtype::ErrorRuntimeUnavailable && failure.code == "runtime_unavailable"
}

async fn cancel(conn: &Connection, run_id: &str, reason: CancelReason) {
    let _ = conn
        .post::<_, serde_json::Value>(
            "cli_run_cancel",
            &json!({ "runId": run_id, "reason": reason }),
            Duration::from_secs(10),
        )
        .await;
}

/// The cancel, on its own: the loop keeps listening for signals meanwhile.
fn spawn_cancel(
    conn: &Connection,
    run_id: &str,
    reason: CancelReason,
) -> tokio::task::JoinHandle<()> {
    let conn = conn.clone();
    let run_id = run_id.to_string();
    tokio::spawn(async move { cancel(&conn, &run_id, reason).await })
}

/// Bound `fut` by the deadline; past it, nothing has been sent yet.
pub(super) async fn within<T>(
    deadline: Option<Instant>,
    fut: impl std::future::Future<Output = T>,
) -> Result<T, Failure> {
    match deadline {
        None => Ok(fut.await),
        Some(d) => tokio::time::timeout_at(d, fut).await.map_err(|_| {
            Failure::new(
                Subtype::ErrorTimeout,
                "timeout",
                "--timeout ran out before the run started; nothing was sent",
            )
        }),
    }
}

async fn sleep_until_opt(when: Option<Instant>) {
    match when {
        Some(t) => tokio::time::sleep_until(t).await,
        None => std::future::pending().await,
    }
}

/// Where a run hears of SIGINT and SIGTERM: the process's own signals, or —
/// with several runs — a listener that counts them for all of them.
pub(super) enum Interrupts {
    Own(Signals),
    /// The listener's count of signals so far and the last one's exit code,
    /// with how many of them this run has heard. A run that starts listening
    /// late still hears the signals that came before.
    Shared {
        signals: tokio::sync::watch::Receiver<(u32, i32)>,
        heard: u32,
    },
}

impl Interrupts {
    pub(super) fn shared(signals: tokio::sync::watch::Receiver<(u32, i32)>) -> Self {
        Self::Shared { signals, heard: 0 }
    }

    /// The next signal's exit code: 130 for SIGINT, 143 for SIGTERM.
    pub(super) async fn recv(&mut self) -> i32 {
        match self {
            Self::Own(signals) => signals.recv().await,
            Self::Shared { signals, heard } => loop {
                let (count, code) = *signals.borrow_and_update();
                if count > *heard {
                    *heard += 1;
                    return code;
                }
                if signals.changed().await.is_err() {
                    std::future::pending::<()>().await;
                }
            },
        }
    }
}

/// SIGINT and SIGTERM (Ctrl-C on Windows), as exit codes.
pub(super) struct Signals {
    #[cfg(unix)]
    int: Option<tokio::signal::unix::Signal>,
    #[cfg(unix)]
    term: Option<tokio::signal::unix::Signal>,
    #[cfg(windows)]
    ctrl_c: Option<tokio::signal::windows::CtrlC>,
}

impl Signals {
    pub(super) fn install() -> Self {
        #[cfg(unix)]
        {
            use tokio::signal::unix::{signal, SignalKind};
            Self {
                int: signal(SignalKind::interrupt()).ok(),
                term: signal(SignalKind::terminate()).ok(),
            }
        }
        #[cfg(windows)]
        {
            Self {
                ctrl_c: tokio::signal::windows::ctrl_c().ok(),
            }
        }
    }

    /// The next signal's exit code: 130 for SIGINT, 143 for SIGTERM.
    pub(super) async fn recv(&mut self) -> i32 {
        #[cfg(unix)]
        {
            let int = async {
                match &mut self.int {
                    Some(s) => {
                        s.recv().await;
                    }
                    None => std::future::pending::<()>().await,
                }
            };
            let term = async {
                match &mut self.term {
                    Some(s) => {
                        s.recv().await;
                    }
                    None => std::future::pending::<()>().await,
                }
            };
            tokio::select! {
                _ = int => 130,
                _ = term => 143,
            }
        }
        #[cfg(windows)]
        {
            match &mut self.ctrl_c {
                Some(s) => {
                    s.recv().await;
                }
                None => std::future::pending::<()>().await,
            }
            130
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli_run::wire::RunResult;

    #[test]
    fn a_local_workspace_is_made_absolute_as_written() {
        let args = RunArgs {
            workspace: Some("sub/../dir".into()),
            ..RunArgs::default()
        };
        let got = workspace(&args, false).unwrap();
        assert!(Path::new(&got).is_absolute(), "{got}");
        assert!(got.ends_with("dir"), "{got}");
        // POSIX keeps `..`: after a symlink it is not the parent the text
        // shows. Windows resolves it from the text, as it reads paths itself.
        #[cfg(unix)]
        assert!(
            got.contains(".."),
            "not resolved, only made absolute: {got}"
        );
        #[cfg(windows)]
        assert!(!got.contains(".."), "{got}");
        let none = workspace(&RunArgs::default(), false).unwrap();
        assert_eq!(
            PathBuf::from(none),
            std::env::current_dir().unwrap(),
            "the current directory by default"
        );
    }

    #[test]
    fn a_remote_workspace_is_sent_untouched_and_is_required() {
        let args = RunArgs {
            workspace: Some(r"C:\repo".into()),
            ..RunArgs::default()
        };
        assert_eq!(workspace(&args, true).unwrap(), r"C:\repo");
        let err = workspace(&RunArgs::default(), true).unwrap_err();
        assert_eq!(err.subtype, Subtype::ErrorUsage);
    }

    #[test]
    fn open_goes_with_this_computers_desktop_only() {
        use crate::cli_run::wire::RuntimeKind;
        assert!(open_refusal(false, RuntimeKind::Desktop, "f").is_none());
        for (remote, runtime) in [
            (false, RuntimeKind::Server),
            (true, RuntimeKind::Desktop),
            (true, RuntimeKind::Server),
        ] {
            let refusal = open_refusal(remote, runtime, "f").expect("refused");
            assert_eq!(refusal.subtype, Subtype::ErrorUsage, "{remote} {runtime:?}");
            assert_eq!(refusal.code, "open_unsupported");
        }
    }

    #[test]
    fn the_reply_file_is_replaced_whole() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("review.md");
        std::fs::write(&path, "old").unwrap();
        write_atomically(&path, "new reply").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new reply");
        assert_eq!(
            std::fs::read_dir(dir.path()).unwrap().count(),
            1,
            "no temp left"
        );
        let missing_dir = dir.path().join("nope").join("review.md");
        assert!(write_atomically(&missing_dir, "x").is_err());
    }

    /// A reply that could not be written is part of the result printed: a
    /// success becomes an error, with the exit code to match.
    #[test]
    fn a_reply_that_cannot_be_written_makes_the_result_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let args = RunArgs {
            output: Some(dir.path().join("missing").join("review.md")),
            ..RunArgs::default()
        };
        let global = GlobalArgs {
            quiet: true,
            ..GlobalArgs::default()
        };
        let out = Output::new(super::super::args::OutputFormat::Json, &global);
        let result = RunResult {
            subtype: Subtype::Success,
            is_error: false,
            result: Some("looks good".into()),
            session_id: None,
            stop_reason: Some("end_turn".into()),
            duration_ms: 1,
            permission_denials: vec![],
            launch: Default::default(),
            pending: None,
            conversation_id: Some(1),
            link: None,
            agent: None,
            assistant: None,
            target_index: None,
            worktree: None,
            structured_output: None,
            error: None,
        };
        let event = RunEvent::new(
            5,
            Some("r".into()),
            EventBody::Result(Box::new(result.clone())),
        );
        assert_eq!(finish(&out, args.output.as_deref(), &event, None), 1);

        // Written, it changes nothing.
        let args = RunArgs {
            output: Some(dir.path().join("review.md")),
            ..RunArgs::default()
        };
        assert_eq!(finish(&out, args.output.as_deref(), &event, None), 0);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("review.md")).unwrap(),
            "looks good"
        );
    }

    /// `--output-schema FILE` is read before anything is sent: JSON, an
    /// object, of objects at its root — what is wrong with it said with the
    /// file's name, as a usage error.
    #[test]
    fn an_output_schema_file_is_checked_before_anything_is_sent() {
        let dir = tempfile::tempdir().unwrap();
        let write = |name: &str, text: &str| {
            let path = dir.path().join(name);
            std::fs::write(&path, text).unwrap();
            path
        };
        let good = write(
            "good.json",
            r#"{"type": "object", "required": ["verdict"]}"#,
        );
        assert_eq!(
            read_output_schema(&good).unwrap(),
            json!({"type": "object", "required": ["verdict"]})
        );
        let big = write("big.json", &" ".repeat(MAX_SCHEMA_FILE_BYTES as usize + 1));
        for (path, why) in [
            (dir.path().join("missing.json"), ""),
            (write("text.json", "verdict: pass"), "not JSON"),
            (write("list.json", "[]"), "JSON object"),
            (
                write("array.json", r#"{"type": "array"}"#),
                "\"type\": \"object\"",
            ),
            (big, "too large"),
        ] {
            let err = read_output_schema(&path).unwrap_err();
            assert_eq!(err.subtype, Subtype::ErrorUsage, "{}", path.display());
            assert_eq!(err.code, "bad_output_schema");
            assert!(
                err.message.contains(&path.display().to_string()),
                "{}",
                err.message
            );
            assert!(err.message.contains(why), "{}", err.message);
        }
    }

    /// With `--output-schema`, `-o` holds the result's JSON — and is left as
    /// it was when there is none, whatever the reply said.
    #[test]
    fn a_reply_file_holds_the_result_of_a_structured_run() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("result.json");
        let global = GlobalArgs {
            quiet: true,
            ..GlobalArgs::default()
        };
        let out = Output::new(super::super::args::OutputFormat::Json, &global);
        let mut result = RunResult {
            subtype: Subtype::Success,
            is_error: false,
            result: Some("Here it is.".into()),
            session_id: None,
            stop_reason: Some("end_turn".into()),
            duration_ms: 1,
            permission_denials: vec![],
            launch: Default::default(),
            pending: None,
            conversation_id: Some(1),
            link: None,
            agent: None,
            assistant: None,
            target_index: None,
            worktree: None,
            structured_output: Some(json!({"verdict": "pass", "issues": []})),
            error: None,
        };
        let event = |r: &RunResult| {
            RunEvent::new(5, Some("r".into()), EventBody::Result(Box::new(r.clone())))
        };
        assert_eq!(finish(&out, Some(&path), &event(&result), None), 0);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{\"verdict\":\"pass\",\"issues\":[]}\n"
        );

        result.subtype = Subtype::ErrorMaxStructuredOutputRetries;
        result.is_error = true;
        result.structured_output = Some(Value::Null);
        assert_eq!(finish(&out, Some(&path), &event(&result), None), 7);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{\"verdict\":\"pass\",\"issues\":[]}\n",
            "left as it was"
        );
    }

    #[test]
    fn a_detached_run_prints_the_init_stream_json_would_have() {
        let mut started = StartResponse {
            run_id: "r1".into(),
            conversation_id: 7,
            folder_id: 3,
            connection_id: "c".into(),
            agent: "codex".into(),
            assistant: None,
            link: "codeg://session/7".into(),
            workspace: Some("/srv/repo".into()),
            worktree: None,
        };
        let event = init_event(&started, "/sent");
        assert_eq!(event.seq, 1);
        assert_eq!(event.run_id.as_deref(), Some("r1"));
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["type"], "init");
        assert_eq!(json["conversation_id"], 7);
        assert_eq!(json["workspace"], "/srv/repo", "the runtime's word for it");
        // An older runtime does not say: what was sent is where it works.
        started.workspace = None;
        let json = serde_json::to_value(init_event(&started, "/sent")).unwrap();
        assert_eq!(json["workspace"], "/sent");
    }

    /// Several runs share one signal listener: a run that starts listening
    /// after a signal still hears it — once — and the next one after.
    #[tokio::test]
    async fn a_run_listening_late_still_hears_the_signals_before() {
        let (tx, rx) = tokio::sync::watch::channel((0u32, 0i32));
        tx.send_modify(|(count, last)| {
            *count += 1;
            *last = 130;
        });
        let mut late = Interrupts::shared(rx);
        assert_eq!(late.recv().await, 130);
        let again = tokio::time::timeout(Duration::from_millis(50), late.recv()).await;
        assert!(again.is_err(), "the same signal is not heard twice");
        tx.send_modify(|(count, last)| {
            *count += 1;
            *last = 143;
        });
        assert_eq!(late.recv().await, 143);
    }

    #[test]
    fn the_budget_left_is_never_more_than_the_deadline_allows() {
        assert_eq!(remaining_ms(None), None);
        let soon = Instant::now() + Duration::from_secs(60);
        let left = remaining_ms(Some(soon)).unwrap();
        assert!(left <= 60_000 && left > 59_000, "{left}");
        // Already past: the least there is, never zero (no timeout at all).
        assert_eq!(remaining_ms(Some(Instant::now())), Some(1));
    }

    #[test]
    fn an_interrupted_failure_keeps_its_signals_code() {
        assert_eq!(Failure::interrupted(143, "x").exit_code(), 143);
        assert_eq!(Failure::interrupted(130, "x").exit_code(), 130);
        assert_eq!(Failure::usage("u", "x").exit_code(), 2);
    }

    #[tokio::test]
    async fn a_deadline_before_the_run_is_a_timeout_with_nothing_sent() {
        let past = Some(Instant::now());
        let err = within(past, std::future::pending::<()>())
            .await
            .unwrap_err();
        assert_eq!(err.subtype, Subtype::ErrorTimeout);
        assert!(err.message.contains("nothing was sent"));
    }
}
