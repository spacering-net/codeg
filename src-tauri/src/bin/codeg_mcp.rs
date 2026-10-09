//! `codeg-mcp` — the per-launch stdio MCP companion that an agent CLI runs
//! to surface codeg's tools to its LLM: the multi-agent delegation tools
//! (`delegate_to_agent` etc.), `check_user_feedback` (pull the user's mid-turn
//! steering notes), `ask_user_question` (block on a multiple-choice card), and
//! `get_session_info` (resolve a referenced session by id), plus the
//! chat-authoring tools (`create_automation` / `create_work_task`), gated by the
//! `--features` groups (`delegation` / `feedback` / `ask` / `sessions` /
//! `tasks` / `automations` / `taskboard`).
//!
//! The agent's MCP config (injected by codeg via `load_mcp_servers_for_agent`)
//! spawns this binary with two required flags and a per-server environment
//! variable containing the ephemeral broker capability token:
//!
//!   CODEG_MCP_TOKEN=<ephemeral secret> codeg-mcp \
//!     --parent-connection-id <uuid> \
//!     --socket-path <abs path>
//!
//! All three values are required and the binary exits early if any is missing.
//! `--custom-agents` optionally carries the `custom:<id>` slugs registered
//! in the parent, so `delegate_to_agent`'s schema can offer them as targets;
//! `--disabled-agents` optionally names the built-ins to drop from that
//! schema so only agents enabled in settings are advertised.
//! Everything heavyweight — JSON-RPC dispatch, UDS round-trip, MCP tool
//! schema, cancellation tracking — lives in
//! `codeg_lib::acp::delegation::{companion, transport}` so it's
//! unit-testable without spawning a process.
//!
//! Stdin lines are dispatched concurrently: synchronous methods
//! (`initialize`, `tools/list`) emit a response inline, `tools/call`
//! spawns a tokio task that drives the UDS round-trip racing a cancel
//! channel, and `notifications/cancelled` wakes the relevant task without
//! blocking the reader. Stdout writes are serialized through a mutex so
//! interleaved frames never corrupt the wire.

use std::io::Write;
use std::process::ExitCode;
use std::sync::Arc;

use codeg_lib::acp::delegation::companion::{
    dispatch_line, drain_and_cancel_all, CompanionContext, CompanionFeatures, InflightCalls,
    JsonRpcResponse, LineAction, SpawnResult,
};
use codeg_lib::acp::delegation::parent_watcher::{wait_for_parent_exit, DEFAULT_POLL_INTERVAL};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Stdout};
use tokio::sync::Mutex;

struct Args {
    parent_connection_id: String,
    socket_path: String,
    token: String,
    /// Optional PID of the codeg / codeg-server process that owns this
    /// session. When set, codeg-mcp exits as soon as the parent is gone so
    /// orphaned companions don't keep the binary file locked (Windows
    /// upgrade failure) or hold open a UDS / pipe nobody will ever read
    /// from. Omitted by older parents — backward compatible.
    parent_pid: Option<u32>,
    /// Comma-joined tool groups to expose (e.g.
    /// `delegation,feedback,ask,sessions,automations,taskboard`). Omitted by parents that predate
    /// feature gating; see `CompanionFeatures::parse` (defaults to
    /// delegation-only).
    features: Option<String>,
    /// Comma-joined `custom:<id>` slugs of the custom ACP agents registered
    /// in the parent at injection time, appended to `delegate_to_agent`'s
    /// `agent_type` enum. Omitted when the parent has none (the embedded
    /// builtin-only schema is served unchanged).
    custom_agents: Option<String>,
    /// Comma-joined wire slugs of the built-in agents the user has disabled
    /// in settings, removed from `delegate_to_agent`'s `agent_type` enum so
    /// only launchable targets are advertised. Omitted when nothing is
    /// disabled (disabled customs are simply left out of `--custom-agents`).
    disabled_agents: Option<String>,
}

fn parse_args() -> Result<Args, String> {
    parse_args_from(
        std::env::args().skip(1),
        std::env::var("CODEG_MCP_TOKEN").ok(),
    )
}

fn parse_args_from(
    arguments: impl Iterator<Item = String>,
    token: Option<String>,
) -> Result<Args, String> {
    let mut parent_connection_id = None;
    let mut socket_path = None;
    let mut parent_pid = None;
    let mut features = None;
    let mut custom_agents = None;
    let mut disabled_agents = None;

    let mut iter = arguments;
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--parent-connection-id" => {
                parent_connection_id = Some(
                    iter.next()
                        .ok_or_else(|| "--parent-connection-id requires a value".to_string())?,
                );
            }
            "--socket-path" => {
                socket_path = Some(
                    iter.next()
                        .ok_or_else(|| "--socket-path requires a value".to_string())?,
                );
            }
            "--parent-pid" => {
                let raw = iter
                    .next()
                    .ok_or_else(|| "--parent-pid requires a value".to_string())?;
                parent_pid = Some(
                    raw.parse::<u32>()
                        .map_err(|e| format!("--parent-pid must be a u32: {e}"))?,
                );
            }
            "--features" => {
                features = Some(
                    iter.next()
                        .ok_or_else(|| "--features requires a value".to_string())?,
                );
            }
            "--custom-agents" => {
                custom_agents = Some(
                    iter.next()
                        .ok_or_else(|| "--custom-agents requires a value".to_string())?,
                );
            }
            "--disabled-agents" => {
                disabled_agents = Some(
                    iter.next()
                        .ok_or_else(|| "--disabled-agents requires a value".to_string())?,
                );
            }
            "--help" | "-h" => {
                println!(
                    "CODEG_MCP_TOKEN=<secret> codeg-mcp --parent-connection-id <uuid> --socket-path <path> [--parent-pid <pid>] [--features delegation,feedback,ask,sessions,tasks] [--custom-agents custom:<id>,...] [--disabled-agents <agent>,...]"
                );
                std::process::exit(0);
            }
            other => return Err(format!("unknown arg: {other}")),
        }
    }
    Ok(Args {
        parent_connection_id: parent_connection_id
            .ok_or_else(|| "missing --parent-connection-id".to_string())?,
        socket_path: socket_path.ok_or_else(|| "missing --socket-path".to_string())?,
        token: token
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "missing CODEG_MCP_TOKEN".to_string())?,
        parent_pid,
        features,
        custom_agents,
        disabled_agents,
    })
}

/// Split an optional comma-joined arg value into its non-empty entries.
fn parse_csv(raw: Option<&str>) -> Vec<String> {
    raw.map(|csv| {
        csv.split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect()
    })
    .unwrap_or_default()
}

/// Serialize a `JsonRpcResponse` and append a newline; small enough to keep
/// inline so the write-mutex critical section stays tight.
async fn write_response(
    stdout: &Arc<Mutex<Stdout>>,
    resp: &JsonRpcResponse,
) -> std::io::Result<()> {
    let serialized = serde_json::to_string(resp).map_err(|e| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, format!("encode: {e}"))
    })?;
    let mut guard = stdout.lock().await;
    guard.write_all(serialized.as_bytes()).await?;
    guard.write_all(b"\n").await?;
    guard.flush().await?;
    Ok(())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    // Stderr-only subscriber: stdout is the JSON-RPC protocol channel, and
    // concurrent mcp processes share no log file. No hub/buffer/emitter.
    let _log_guard = codeg_lib::logging::init::init_mcp();

    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            let _ = writeln!(std::io::stderr(), "codeg-mcp: {e}");
            return ExitCode::from(2);
        }
    };
    let ctx = CompanionContext {
        parent_connection_id: args.parent_connection_id,
        socket_path: args.socket_path,
        token: args.token,
        features: CompanionFeatures::parse(args.features.as_deref()),
        custom_agents: parse_csv(args.custom_agents.as_deref()),
        disabled_agents: parse_csv(args.disabled_agents.as_deref()),
    };

    let stdin = tokio::io::stdin();
    let stdout = Arc::new(Mutex::new(tokio::io::stdout()));
    let inflight = Arc::new(InflightCalls::new());
    let mut lines = BufReader::new(stdin).lines();

    // Optional parent-PID watchdog. Composed as a separate future so the
    // main loop can race it against stdin reads via `tokio::select!`;
    // when no PID was provided we substitute a never-ready future, which
    // tokio's branch evaluation skips for free.
    let watchdog: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> =
        match args.parent_pid {
            Some(pid) => Box::pin(wait_for_parent_exit(pid, DEFAULT_POLL_INTERVAL)),
            None => Box::pin(std::future::pending()),
        };
    tokio::pin!(watchdog);

    loop {
        tokio::select! {
            // Bias toward parent-exit detection: if the watchdog fires
            // mid-stdin-read we want to bail rather than finish a round-trip
            // whose response no one will read.
            biased;
            _ = &mut watchdog => {
                // Best-effort: cancel every in-flight delegation BEFORE we
                // hard-exit so the broker doesn't park each pending row
                // on `rx.await` waiting for a TurnComplete it can never
                // deliver. cancel_by_parent on the codeg main side is the
                // ultimate backstop, but firing the explicit cancels here
                // closes the window between MCP shutdown and parent ACP
                // disconnect detection on the codeg side.
                drain_and_cancel_all(&ctx, &inflight, "parent process exited").await;
                let _ = writeln!(
                    std::io::stderr(),
                    "codeg-mcp: parent process exited, shutting down"
                );
                // Hard exit on purpose: `tokio::io::stdin()` parks a
                // blocking worker thread that the runtime can't cancel,
                // so returning normally would keep the process alive
                // until the parent agent CLI also closes stdin — defeating
                // the watchdog. The agent CLI sees the stdout pipe close
                // and tears down its MCP client cleanly.
                std::process::exit(0);
            }
            line_result = lines.next_line() => {
                let line = match line_result {
                    Ok(Some(l)) => l,
                    Ok(None) => {
                        // Parent closed stdin. Same shutdown rationale as
                        // the watchdog branch: drain pending delegations
                        // before returning so the broker can resolve them
                        // immediately.
                        drain_and_cancel_all(&ctx, &inflight, "companion stdio closed").await;
                        break;
                    }
                    Err(e) => {
                        let _ = writeln!(std::io::stderr(), "codeg-mcp: read stdin: {e}");
                        drain_and_cancel_all(&ctx, &inflight, "companion stdin error").await;
                        return ExitCode::from(1);
                    }
                };
                let line = line.trim().to_string();
                if line.is_empty() {
                    continue;
                }
                let action = dispatch_line(&ctx, inflight.clone(), &line).await;
                match action {
                    LineAction::Respond(resp) => {
                        if let Err(e) = write_response(&stdout, &resp).await {
                            let _ = writeln!(std::io::stderr(), "codeg-mcp: write stdout: {e}");
                            return ExitCode::from(1);
                        }
                    }
                    LineAction::Spawn(spawned) => {
                        // Drive the round-trip in a detached task so the
                        // stdin reader stays responsive — the next line may
                        // be a `notifications/cancelled` for THIS request.
                        let stdout = stdout.clone();
                        tokio::spawn(async move {
                            let SpawnResult {
                                response,
                                after_relay,
                            } = spawned.future.await;
                            // `None` → cancellation won; suppress per MCP spec.
                            let Some(resp) = response else {
                                return;
                            };
                            if let Err(e) = write_response(&stdout, &resp).await {
                                let _ = writeln!(
                                    std::io::stderr(),
                                    "codeg-mcp: write stdout: {e}"
                                );
                                // Relay failed (agent stdin gone) → skip any
                                // post-relay action so feedback notes stay
                                // pending for the next check (at-least-once).
                                return;
                            }
                            // The response reached the agent's stdin. Only now
                            // run any post-relay action — for
                            // `check_user_feedback`, the delivery commit that
                            // marks the pulled notes `Delivered`.
                            if let Some(after) = after_relay {
                                after.await;
                            }
                        });
                    }
                    LineAction::Silent => {}
                }
            }
        }
    }
    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_token_must_come_from_nonempty_environment() {
        let argv = || {
            [
                "--parent-connection-id",
                "parent",
                "--socket-path",
                "/tmp/codeg.sock",
            ]
            .into_iter()
            .map(str::to_string)
        };

        assert!(parse_args_from(argv(), None).is_err());
        assert!(parse_args_from(argv(), Some(String::new())).is_err());
        assert!(parse_args_from(argv(), Some("  ".to_string())).is_err());

        let parsed = parse_args_from(argv(), Some("test-capability".to_string()))
            .expect("nonempty environment token is accepted");
        assert_eq!(parsed.token, "test-capability");

        let legacy_argv = argv().chain(["--token".to_string(), "legacy-value".to_string()]);
        assert!(parse_args_from(legacy_argv, Some("test-capability".to_string())).is_err());
    }
}
