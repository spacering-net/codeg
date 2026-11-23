//! Browser-free ("headless") Google sign-in for Antigravity.
//!
//! # The flow
//!
//! `agy acp --login` is the CLI's own terminal sign-in. It prints a Google
//! consent URL and waits on stdin for either the authorization code or the
//! full address the browser lands on:
//!
//! ```text
//! Open this link in a browser to log in with Google:
//!
//!   https://accounts.google.com/o/oauth2/auth?...
//!
//! Then paste the authorization code, or the full URL of the page you land on,
//! and press Enter:
//! ```
//!
//! That is already exactly what a machine with no desktop needs, so codeg
//! drives the CLI's flow instead of reimplementing OAuth: it spawns
//! `agy acp --login` with the same environment a real launch uses, scrapes the
//! URL from stdout/stderr, shows it in the settings panel, and writes the
//! pasted code back to the child's stdin. The CLI exchanges the code and stores
//! the credential in its own store (the system keyring, or its file fallback).
//!
//! The old standalone `agy_acp_server` needed a loopback redirect relay because
//! its OAuth flow bound `127.0.0.1:<random port>` inside the agent process.
//! `agy acp --login` uses a fixed `https://antigravity.google/oauth-callback`
//! redirect and asks the user to paste the result, so no relay is involved.
//!
//! # Signing out
//!
//! `logout` is an ACP request the CLI advertises in `initialize`
//! (`agentCapabilities.auth.logout`). It clears the credential the CLI store
//! holds; codeg drives it rather than deleting keyring entries itself, so the
//! CLI's own rules for which backend (keychain / file) owns the token stay in
//! one place.
//!
//! The panel's auth-method choice still selects which credential the launch
//! consumes: `apply_antigravity_env_policy` filters `GEMINI_API_KEY` /
//! `GOOGLE_*` per method, while the two OAuth methods use whatever
//! `agy acp --login` stored.

use std::collections::BTreeMap;
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;

use serde::Serialize;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{mpsc, Mutex};

use crate::acp::error::AcpError;
use crate::models::AgentType;

/// How long the CLI gets to print its consent URL. The process is local; a
/// value this generous only covers a cold start on a loaded machine.
const URL_WAIT: Duration = Duration::from_secs(20);

/// How long the CLI gets to exchange the pasted code once it is entered.
const EXCHANGE_WAIT: Duration = Duration::from_secs(180);

/// How long the ACP `logout` request gets to answer.
const LOGOUT_WAIT: Duration = Duration::from_secs(30);

/// How long the user has to complete the browser step, for the panel's copy.
pub const LOGIN_EXPIRES_SECS: u64 = 300;

/// JSON-RPC ids for the two requests [`sign_out`] sends.
const ID_INITIALIZE: i64 = 1;
const ID_LOGOUT: i64 = 2;

/// What the panel needs to render step one of the sign-in.
///
/// The link fields are `None` exactly when `already_signed_in` is true. The
/// frontend type is a discriminated union on that flag; `agy acp --login`
/// always asks for consent, so this flow always reports `false`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityLoginStart {
    pub already_signed_in: bool,
    /// Opaque id for the pending sign-in; passed back to [`finish`]/[`cancel`].
    pub handle: Option<String>,
    /// The Google consent URL to open in any browser, anywhere.
    pub auth_url: Option<String>,
    /// Where the browser lands after consent. The CLI asks the user to paste
    /// that address (or the code) back, so the panel shows it as the expected
    /// next step.
    pub redirect_uri: String,
    pub method_id: String,
    /// Seconds before the CLI stops waiting, so the panel can say so.
    pub expires_in_secs: u64,
}

/// The outcome of step two.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityLoginOutcome {
    pub signed_in: bool,
    /// The CLI's own words when it refused, already redacted. `None` on
    /// success.
    pub message: Option<String>,
    /// Whether the same link can still be used. `agy acp --login` is one-shot:
    /// it consumes the code and exits, so a rejected paste needs a new link.
    pub retryable: bool,
    /// Where the credential landed, when codeg can name it. The CLI owns that
    /// decision (keyring or file), so this is normally `None`.
    pub credential_path: Option<String>,
}

/// A sign-in waiting for the user's authorization code.
struct Pending {
    handle: String,
    child: Child,
    stdin: ChildStdin,
    lines: mpsc::UnboundedReceiver<String>,
}

static SLOT: OnceLock<Mutex<Option<Pending>>> = OnceLock::new();

fn slot() -> &'static Mutex<Option<Pending>> {
    SLOT.get_or_init(|| Mutex::new(None))
}

/// Begin a browser-free sign-in: spawn `agy acp --login`, wait for the URL it
/// prints, and hand that URL to the panel.
///
/// `method_id` is the panel's choice. Only the two OAuth methods have a
/// browser flow; the API-key methods read an environment variable and are the
/// panel's business, not this module's.
pub async fn start(
    runtime_env: &BTreeMap<String, String>,
    method_id: &str,
) -> Result<AntigravityLoginStart, AcpError> {
    if !crate::acp::connection::is_antigravity_auth_method(method_id) {
        return Err(AcpError::protocol(format!(
            "unknown Antigravity auth method {method_id:?}"
        )));
    }
    if !matches!(method_id, "oauth-personal" | "oauth-business") {
        return Err(AcpError::protocol(format!(
            "{method_id} does not use a browser sign-in; set its credential in the panel instead"
        )));
    }

    let mut guard = slot().lock().await;
    // A new sign-in displaces an unfinished one: the user is looking at a new
    // link, so the old child has nobody left to answer it.
    if let Some(old) = guard.take() {
        kill(old).await;
    }

    let mut pending = spawn_login(runtime_env, method_id).await?;
    let auth_url = match wait_for_url(&mut pending.lines).await {
        Ok(url) => url,
        Err(error) => {
            kill(pending).await;
            return Err(error);
        }
    };

    let handle = new_handle();
    let redirect_uri = redirect_uri_of(&auth_url);    let started = AntigravityLoginStart {
        already_signed_in: false,
        handle: Some(handle.clone()),
        auth_url: Some(auth_url),
        redirect_uri,
        method_id: method_id.to_string(),
        expires_in_secs: LOGIN_EXPIRES_SECS,
    };
    *guard = Some(Pending {
        handle,
        ..pending
    });
    Ok(started)
}

/// Complete a sign-in by writing the pasted code (or full redirect URL) to the
/// CLI's stdin and waiting for it to exit.
pub async fn finish(handle: &str, pasted: &str) -> Result<AntigravityLoginOutcome, AcpError> {
    let handle = handle.trim();
    let pasted = pasted.trim();
    if pasted.is_empty() {
        return Ok(AntigravityLoginOutcome {
            signed_in: false,
            message: Some("Enter the authorization code or the full address the browser landed on.".into()),
            retryable: true,
            credential_path: None,
        });
    }

    let mut guard = slot().lock().await;
    let Some(pending) = guard.take() else {
        return Err(AcpError::protocol(
            "this sign-in is no longer waiting; start it again",
        ));
    };
    if pending.handle != handle {
        *guard = Some(pending);
        return Err(AcpError::protocol(
            "this sign-in was replaced by a newer attempt; use the link on screen",
        ));
    }

    let mut pending = pending;
    if let Err(error) = write_line(&mut pending.stdin, pasted).await {
        kill(pending).await;
        return Err(error);
    }

    let wait = tokio::time::timeout(EXCHANGE_WAIT, pending.child.wait()).await;
    let mut output = Vec::new();
    while let Ok(line) = pending.lines.try_recv() {
        output.push(line);
    }
    match wait {
        Ok(Ok(status)) if status.success() => {
            tracing::info!("[ACP][Antigravity] agy acp --login completed");
            Ok(AntigravityLoginOutcome {
                signed_in: true,
                message: None,
                retryable: false,
                credential_path: None,
            })
        }
        Ok(Ok(status)) => Ok(AntigravityLoginOutcome {
            signed_in: false,
            message: Some(
                summarise(&output)
                    .unwrap_or_else(|| format!("agy acp --login exited with {status}")),
            ),
            retryable: false,
            credential_path: None,
        }),
        Ok(Err(error)) => Err(AcpError::SpawnFailed(error.to_string())),
        Err(_) => {
            kill(pending).await;
            Ok(AntigravityLoginOutcome {
                signed_in: false,
                message: Some("agy acp --login did not finish in time".into()),
                retryable: false,
                credential_path: None,
            })
        }
    }
}

/// Abandon a pending sign-in and end its child process.
pub async fn cancel(handle: &str) -> Result<(), AcpError> {
    let handle = handle.trim();
    let mut guard = slot().lock().await;
    let matches = guard.as_ref().is_some_and(|p| p.handle == handle);
    if matches {
        if let Some(pending) = guard.take() {
            kill(pending).await;
        }
    }
    Ok(())
}

/// Sign Antigravity out through the CLI's ACP `logout` request, so the next
/// sign-in can reach a different account.
pub async fn sign_out(runtime_env: &BTreeMap<String, String>) -> Result<(), AcpError> {
    let mut guard = slot().lock().await;
    if let Some(pending) = guard.take() {
        kill(pending).await;
    }

    let mut child = spawn_acp(runtime_env).await?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| AcpError::protocol("agy acp closed stdin"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AcpError::protocol("agy acp closed stdout"))?;
    let mut lines = BufReader::new(stdout).lines();

    let outcome = async {
        write_json(
            &mut stdin,
            &serde_json::json!({
                "jsonrpc": "2.0",
                "id": ID_INITIALIZE,
                "method": "initialize",
                "params": {
                    "protocolVersion": 1,
                    "clientCapabilities": {},
                    "clientInfo": { "name": "codeg", "version": env!("CARGO_PKG_VERSION") },
                },
            }),
        )
        .await?;
        let handshake = await_id(&mut lines, ID_INITIALIZE).await?;
        if handshake
            .pointer("/result/agentCapabilities/auth/logout")
            .is_none_or(serde_json::Value::is_null)
        {
            return Err(AcpError::protocol(
                "this version of the Antigravity CLI cannot sign out. Update it in Agent Settings.",
            ));
        }

        write_json(
            &mut stdin,
            &serde_json::json!({
                "jsonrpc": "2.0",
                "id": ID_LOGOUT,
                "method": "logout",
                "params": {},
            }),
        )
        .await?;
        await_id(&mut lines, ID_LOGOUT).await.map(|_| ())
    }
    .await;

    let _ = child.kill().await;
    let _ = child.wait().await;
    match &outcome {
        Ok(()) => tracing::info!("[ACP][Antigravity] signed out through agy acp"),
        Err(error) => tracing::warn!("[ACP][Antigravity] sign-out failed: {error}"),
    }
    outcome
}

async fn spawn_login(
    runtime_env: &BTreeMap<String, String>,
    method_id: &str,
) -> Result<Pending, AcpError> {
    let binary = resolve_cli()?;
    let mut command = crate::process::tokio_command(&binary);
    command
        .arg("acp")
        .arg("--login")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // `GEMINI_HOME` is rejected by `agy acp`; the same tree rides on the flag.
    let env = crate::acp::connection::antigravity_launch_env(runtime_env, None);
    for (key, value) in &env {
        command.env(key, value);
    }
    if let Some(dir) = crate::acp::connection::antigravity_gemini_dir_arg(runtime_env, &env) {
        command.arg("--gemini-dir").arg(dir);
    }
    // The panel's method is the intent; `--login` itself only knows Google.
    // `oauth-business` goes through the same Google consent screen, where the
    // user can pick the enterprise account.
    tracing::info!("[ACP][Antigravity] starting agy acp --login for {method_id}");
    let mut child = command
        .spawn()
        .map_err(|error| AcpError::SpawnFailed(error.to_string()))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| AcpError::SpawnFailed("agy acp --login closed stdin".into()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AcpError::SpawnFailed("agy acp --login closed stdout".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AcpError::SpawnFailed("agy acp --login closed stderr".into()))?;

    let (tx, lines) = mpsc::unbounded_channel();
    spawn_reader(stdout, tx.clone());
    spawn_reader(stderr, tx);
    Ok(Pending {
        handle: String::new(),
        child,
        stdin,
        lines,
    })
}

async fn spawn_acp(runtime_env: &BTreeMap<String, String>) -> Result<Child, AcpError> {
    let binary = resolve_cli()?;
    let mut command = crate::process::tokio_command(&binary);
    command
        .arg("acp")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let env = crate::acp::connection::antigravity_launch_env(runtime_env, None);
    for (key, value) in &env {
        command.env(key, value);
    }
    if let Some(dir) = crate::acp::connection::antigravity_gemini_dir_arg(runtime_env, &env) {
        command.arg("--gemini-dir").arg(dir);
    }
    command
        .spawn()
        .map_err(|error| AcpError::SpawnFailed(error.to_string()))
}

fn resolve_cli() -> Result<std::path::PathBuf, AcpError> {
    crate::commands::acp::resolve_system_agent_binary_for(AgentType::Antigravity, "agy")
        .ok_or_else(|| {
            AcpError::SdkNotInstalled(
                "Google Antigravity CLI is not installed. Please install it in Agent Settings."
                    .into(),
            )
        })
}

fn spawn_reader<R>(stream: R, tx: mpsc::UnboundedSender<String>)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(stream).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
}

async fn wait_for_url(lines: &mut mpsc::UnboundedReceiver<String>) -> Result<String, AcpError> {
    let deadline = tokio::time::Instant::now() + URL_WAIT;
    loop {
        match tokio::time::timeout_at(deadline, lines.recv()).await {
            Err(_) => {
                return Err(AcpError::protocol(
                    "agy acp --login did not print a sign-in link. Run `agy acp --login` in a terminal to see why.",
                ))
            }
            Ok(None) => {
                return Err(AcpError::protocol(
                    "agy acp --login exited before printing a sign-in link",
                ))
            }
            Ok(Some(line)) => {
                if let Some(url) = extract_url(&line) {
                    return Ok(url);
                }
            }
        }
    }
}

/// Pull the first `https://` token out of a CLI line. The link is printed on
/// its own line, but the same scraper also sees the surrounding prose, so it
/// must not treat the trailing period as part of the URL.
fn extract_url(line: &str) -> Option<String> {
    line.split_whitespace()
        .map(|token| token.trim_end_matches(['.', ',', ')', '"', '\'']))
        .find(|token| token.starts_with("https://"))
        .map(str::to_string)
}

fn redirect_uri_of(auth_url: &str) -> String {
    url::Url::parse(auth_url)
        .ok()
        .and_then(|url| {
            url.query_pairs()
                .find(|(key, _)| key == "redirect_uri")
                .map(|(_, value)| value.into_owned())
        })
        .unwrap_or_else(|| "https://antigravity.google/oauth-callback".to_string())
}

fn new_handle() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    format!("agy-login-{n}-{}", std::process::id())
}

async fn write_line(stdin: &mut ChildStdin, line: &str) -> Result<(), AcpError> {
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|error| AcpError::protocol(format!("could not send the code to agy: {error}")))?;
    stdin
        .write_all(b"\n")
        .await
        .map_err(|error| AcpError::protocol(format!("could not send the code to agy: {error}")))?;
    stdin
        .flush()
        .await
        .map_err(|error| AcpError::protocol(format!("could not send the code to agy: {error}")))?;
    Ok(())
}

async fn write_json(stdin: &mut ChildStdin, value: &serde_json::Value) -> Result<(), AcpError> {
    let mut line =
        serde_json::to_vec(value).map_err(|error| AcpError::protocol(error.to_string()))?;
    line.push(b'\n');
    stdin
        .write_all(&line)
        .await
        .map_err(|error| AcpError::protocol(format!("could not write to agy acp: {error}")))?;
    stdin
        .flush()
        .await
        .map_err(|error| AcpError::protocol(format!("could not write to agy acp: {error}")))?;
    Ok(())
}

async fn await_id(
    lines: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    id: i64,
) -> Result<serde_json::Value, AcpError> {
    let deadline = tokio::time::Instant::now() + LOGOUT_WAIT;
    loop {
        match tokio::time::timeout_at(deadline, lines.next_line()).await {
            Err(_) => return Err(AcpError::protocol("agy acp did not answer in time")),
            Ok(Err(error)) => return Err(AcpError::protocol(error.to_string())),
            Ok(Ok(None)) => {
                return Err(AcpError::protocol("agy acp exited before answering"))
            }
            Ok(Ok(Some(line))) => {
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                    continue;
                };
                if value.get("id").and_then(serde_json::Value::as_i64) != Some(id) {
                    continue;
                }
                if let Some(error) = value.get("error") {
                    let message = error
                        .get("message")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("unknown error");
                    return Err(AcpError::protocol(format!("Antigravity refused sign-out: {message}")));
                }
                return Ok(value);
            }
        }
    }
}

/// The last meaningful line the CLI printed, for a failed sign-in.
fn summarise(lines: &[String]) -> Option<String> {
    lines
        .iter()
        .rev()
        .map(|line| line.trim())
        .find(|line| !line.is_empty())
        .map(|line| line.to_string())
}

async fn kill(pending: Pending) {
    let Pending { mut child, .. } = pending;
    let _ = child.kill().await;
    let _ = child.wait().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_the_consent_url_from_the_cli_output() {
        let line = "  https://accounts.google.com/o/oauth2/auth?x=1&y=2";
        assert_eq!(
            extract_url(line).as_deref(),
            Some("https://accounts.google.com/o/oauth2/auth?x=1&y=2")
        );
    }

    #[test]
    fn trims_trailing_prose_punctuation() {
        assert_eq!(
            extract_url("open https://accounts.google.com/o?x=1.").as_deref(),
            Some("https://accounts.google.com/o?x=1")
        );
    }

    #[test]
    fn reads_the_redirect_uri() {
        assert_eq!(
            redirect_uri_of(
                "https://accounts.google.com/o?redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&state=1"
            ),
            "https://antigravity.google/oauth-callback"
        );
    }
}
