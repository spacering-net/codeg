//! Browser-free ("headless") Google sign-in for Antigravity.
//!
//! # The problem
//!
//! Antigravity's two OAuth methods (`oauth-personal`, `oauth-business`) are the
//! only ones that reach the free tier with a plain Google account, and both
//! authenticate through a loopback browser flow that the **agent process** runs
//! (`oauth/credential_manager.py::_run_redirect_server`): it binds a one-shot
//! HTTP server on `127.0.0.1:<random port>`, calls `webbrowser.open(auth_url)`,
//! and blocks for up to 300 seconds waiting for Google to redirect back.
//!
//! On a Linux server with no desktop that is a dead end, and a silent one:
//! `webbrowser.open` finds no browser and returns `False` **without raising**,
//! so the agent's own "could not open a browser" log line never fires. The user
//! creates a session, it hangs for five minutes, and then fails with
//! `Onboarding failed: Timed out waiting for the authentication flow to
//! complete.` Nothing anywhere prints a link they could open themselves.
//!
//! # The mechanism
//!
//! Two facts make a fix possible without a tunnel, a second machine, or a copy
//! of Google's OAuth client secret:
//!
//! 1. **The agent prints the authorization URL.** `_run_redirect_server` ends
//!    with an unconditional `print("Open the following link to authenticate the
//!    ACP server: {url}")`. WHICH pipe it lands on is a version detail and has
//!    already moved once: 1.0.0 printed it to stdout, alongside the JSON-RPC
//!    frames, and 1.1.1 prints it to stderr. So both streams are scanned for
//!    it (see [`AuthUrlSink`]) — a sign-in that reads only one of them silently
//!    waits out [`URL_WAIT`] and reports that the agent produced no link.
//!    `PYTHONUNBUFFERED=1` is set for the stdout case, where CPython
//!    block-buffers a pipe and the line would otherwise sit in that buffer
//!    indefinitely; stderr is unbuffered either way.
//!
//! 2. **The loopback server accepts the redirect from anyone.** It records
//!    whatever single request it receives and hands the query string to
//!    `flow.fetch_token`, which validates `state` and exchanges the code. The
//!    browser that completes the consent does not have to be the process that
//!    delivers the result.
//!
//! So: codeg starts a short-lived agent process purely to sign in, drives ACP
//! `initialize` + `authenticate` over its stdio, scrapes the printed URL, and
//! shows it. The user opens it in whatever browser they have, consents, and
//! lands on a `http://127.0.0.1:<port>/?state=…&code=…` page their browser
//! cannot reach. They paste that address back, and codeg — which *is* on the
//! machine where that port is listening — performs the redirect on their
//! behalf. The agent then completes the exchange, runs its own onboarding, and
//! writes the credential exactly where a real session will look for it.
//!
//! # Why a dedicated process, and not the session's connection
//!
//! `authenticate` is a top-level ACP request: it triggers the identical sign-in
//! that `session/new` would, but before any session exists. Driving it from a
//! throwaway child keeps the whole feature inside the settings panel — no new
//! session-path states, no mid-`session/new` UI, and a failed sign-in costs the
//! user a retry rather than a broken conversation. The child is spawned with
//! [`crate::acp::connection::antigravity_launch_env`], i.e. byte-for-byte the
//! environment a real launch uses, because `GEMINI_HOME` decides where the
//! token is written and `AGY_ACP_FORCE_FILE_STORAGE` decides whether it is a
//! file or the macOS keychain. A child with a different environment would sign
//! the user in and then leave the credential somewhere nothing reads.
//!
//! # Security
//!
//! `finish` takes a URL typed by the user and makes codeg issue an HTTP request
//! — the shape of an SSRF. It is closed by construction: the request target is
//! rebuilt from the `redirect_uri` **codeg captured from the agent's own
//! authorization URL**, and only `code`/`state`/`error` are taken from the
//! paste. The captured value is additionally required to be
//! `http://127.0.0.1:<port>/`, matching the agent's hardcoded `_LOOPBACK_HOST`,
//! so even a compromised upstream cannot redirect codeg off the loopback. The
//! request also bypasses any configured proxy: a loopback address must never
//! leave the machine.
//!
//! # Signing out
//!
//! Signing in is only half an account: once a credential exists the agent
//! refreshes it silently and `authenticate` returns without opening anything,
//! so the sign-in above can never reach a second Google account. [`sign_out`]
//! is the other half, and it drives the agent's own ACP `logout` for the same
//! reason [`start`] drives its `authenticate` — where the credential lives
//! (a macOS login-keychain item, or a file under `GEMINI_HOME`) is decided by
//! rules inside the agent, so deleting it from here would be codeg guessing at
//! someone else's storage layout.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot, Mutex};

use crate::acp::error::AcpError;
use crate::acp::registry::{self, AgentDistribution};
use crate::acp::scratch_dir::LaunchScratch;
use crate::acp::stderr_tail::StderrTail;
use crate::models::agent::AgentType;

/// The exact line `oauth/credential_manager.py` prints before it starts waiting
/// for the redirect. Matched as a substring, not a prefix: on stdout the
/// agent's protocol writes go to the same fd, so a concurrent JSON-RPC frame
/// can share the line, and on stderr absl may prefix it with its own log
/// header.
const AUTH_PROMPT_MARKER: &str = "Open the following link to authenticate the ACP server: ";

/// The only redirect host the agent ever uses (`_LOOPBACK_HOST` in
/// `credential_manager.py`, chosen there so the target "does not depend on
/// IPv4/IPv6 name resolution"). Enforced rather than assumed — see the module
/// docs on `finish`.
const LOOPBACK_PREFIX: &str = "http://127.0.0.1:";

/// How long to wait for the child's `initialize` answer. The same 60 s the ACP
/// probe path allows, and for the same reason: this binary is CPython inside a
/// PAR and a cold first run unpacks a whole interpreter.
const INITIALIZE_WAIT: Duration = Duration::from_secs(60);

/// How long to wait for the agent to print its authorization URL, once
/// `initialize` has answered. Far short of the agent's own 300 s redirect wait —
/// a URL that has not appeared by now is not coming.
const URL_WAIT: Duration = Duration::from_secs(90);

/// How long to wait for `authenticate` to answer after the redirect is
/// delivered. Covers Google's token exchange **and** the agent's onboarding
/// round-trips (`loadCodeAssist`/`onboardUser` for consumer, license resolution
/// for Gemini Enterprise), which is why it is minutes rather than seconds.
const AUTHENTICATE_WAIT: Duration = Duration::from_secs(180);

/// Bound on the loopback redirect itself. The listener is on this machine and
/// answers with a static page, so anything slower is a wedged agent.
const REDIRECT_WAIT: Duration = Duration::from_secs(20);

/// How long to wait for `logout` to answer. Everything it does is local — drop
/// a keychain item or unlink a file, then rewrite `settings.json` — so the only
/// part that can take real time is the agent reaching it.
const LOGOUT_WAIT: Duration = Duration::from_secs(60);

/// After this a pending sign-in is stale: the agent's own
/// `_LOGIN_TIMEOUT_SECONDS` has expired, the one-shot listener is closed, and
/// delivering a redirect would only fail with "connection refused".
const PENDING_TTL: Duration = Duration::from_secs(300);

/// How long a helper gets to exit on its own after its stdin is closed.
///
/// Worth spending, and not only for politeness: the ACP server reads stdin EOF
/// as "the client is gone" and shuts down, and a graceful exit is the one path
/// on which a self-extracting build removes its OWN unpacked directory. Every
/// hard kill below leaves that to codeg's scratch cleanup instead.
const STDIN_EOF_GRACE: Duration = Duration::from_millis(1_500);

/// How long the tree gets to honor `SIGTERM` before the escalation to
/// `SIGKILL`. Mirrors `terminal_runtime::KILL_ESCALATE_GRACE`: `kill_tree`
/// sends only `SIGTERM` by default, which a process that traps it can ignore
/// forever.
const KILL_ESCALATE_GRACE: Duration = Duration::from_secs(2);

/// How long teardown waits to be able to REPORT the tree gone before returning
/// anyway. Bounding this is what keeps a wedged helper from pinning the
/// single sign-in slot — the process is already under `SIGKILL`, and whatever
/// it leaves on disk is the scratch sweep's problem, not this caller's.
const KILL_REPORT_BUDGET: Duration = Duration::from_secs(5);

/// JSON-RPC ids for the three requests this module ever sends. `authenticate`
/// and `logout` never share a child, so their ids only have to differ from
/// `initialize`'s.
const ID_INITIALIZE: i64 = 1;
const ID_AUTHENTICATE: i64 = 2;
const ID_LOGOUT: i64 = 3;

/// What the panel needs to render step one of the sign-in.
///
/// The three link fields are `None` together, exactly when `already_signed_in`
/// is true — the frontend type is a discriminated union on that flag.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityLoginStart {
    /// The agent already held a usable credential and `authenticate` returned
    /// without opening anything, so there is nothing to complete.
    ///
    /// Worth reporting rather than treating as "no link appeared": a user who
    /// copied a token file across, or who signed in earlier, would otherwise
    /// wait out the URL timeout only to be told the agent produced no link.
    pub already_signed_in: bool,
    /// Opaque id for the pending sign-in; passed back to [`finish`]/[`cancel`].
    pub handle: Option<String>,
    /// The Google consent URL to open in any browser, anywhere.
    pub auth_url: Option<String>,
    /// The address the browser will be redirected to and fail to reach. Shown
    /// so the dead page reads as an expected step rather than a broken login.
    pub redirect_uri: Option<String>,
    pub method_id: String,
    /// Seconds before the agent stops waiting, so the panel can say so.
    pub expires_in_secs: u64,
}

/// The outcome of step two.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityLoginOutcome {
    pub signed_in: bool,
    /// The agent's own words when it refused, already redacted. `None` on
    /// success.
    pub message: Option<String>,
    /// Whether the same link can still be used. True only for a paste codeg
    /// rejected on its own — the agent's listener never saw it, so the consent
    /// the user already gave is still good and only the paste needs fixing.
    /// False once the redirect has been delivered: it is one-shot.
    pub retryable: bool,
    /// Where the agent stores the credential this sign-in produced, when codeg
    /// can name it. Worth surfacing: it is a portable file, so a user with
    /// several headless machines can sign in once and copy it.
    pub credential_path: Option<String>,
}

/// Ceiling on how long the slot may stay [`SlotState::Finishing`].
///
/// `finish`'s own waits ([`REDIRECT_WAIT`] + [`AUTHENTICATE_WAIT`]) bound the
/// work, and the slack covers the code around them. It exists because that
/// state must expire on its own: in server mode a client disconnect drops the
/// handler future mid-`await`, and a `Finishing` that nothing ever clears would
/// refuse every later sign-in for the life of the process.
const FINISH_BUDGET: Duration = Duration::from_secs(
    REDIRECT_WAIT.as_secs() + AUTHENTICATE_WAIT.as_secs() + 30,
);

/// A sign-in waiting for its redirect.
struct Pending {
    handle: String,
    method_id: String,
    redirect_uri: String,
    /// The `state` the agent generated. A paste that carries a different one is
    /// rejected here so the user gets "that link was for an earlier attempt"
    /// instead of oauthlib's `MismatchingStateError` three layers down.
    state: String,
    credential_path: Option<PathBuf>,
    /// Ended as a TREE, and still ended if this `Pending` is dropped rather
    /// than torn down — see [`HelperChild`].
    child: HelperChild,
    /// Held open for the child's whole life. The ACP server treats stdin EOF as
    /// "the client is gone" and shuts down — which would abort the very
    /// `authenticate` call this sign-in is waiting on.
    _stdin: tokio::process::ChildStdin,
    responses: mpsc::UnboundedReceiver<serde_json::Value>,
    stderr: Arc<StderrTail>,
    /// The helper's per-launch temp directory, carried so every teardown path
    /// — delivered, rejected, stale, cancelled, displaced — can hand it back.
    scratch: Option<LaunchScratch>,
    started: Instant,
}

impl Pending {
    fn is_stale(&self) -> bool {
        self.started.elapsed() >= PENDING_TTL
    }

    /// Teardown: end the helper's whole process TREE, then hand its scratch
    /// directory back.
    ///
    /// This used to be a bare `child.kill()`, justified by "the child has no
    /// session, so it has no localharness descendants to reap". That reasoning
    /// covered the wrong descendant. The Windows build is a PyInstaller
    /// *onefile*, whose bootloader unpacks ~1.17 GB and then runs the real
    /// program as a CHILD of itself — so killing the direct process leaves the
    /// payload alive, holding the very files the next step wants to delete.
    async fn kill(self) {
        let Pending {
            child,
            _stdin,
            scratch,
            ..
        } = self;
        reap_and_release(child, _stdin, scratch).await;
    }
}

/// End a helper's process tree and release its scratch directory.
///
/// Graceful first, bounded throughout: closing stdin lets the ACP server exit
/// on its own (and clean up its own unpacked directory, on the builds that do),
/// and every wait afterwards has a ceiling so a process that refuses to die can
/// never pin the single sign-in slot. Scratch removal is not on this path at
/// all — [`LaunchScratch::release`] retries in the background and the sweeps
/// are the backstop.
async fn reap_and_release(
    mut helper: HelperChild,
    stdin: tokio::process::ChildStdin,
    scratch: Option<LaunchScratch>,
) {
    // EOF on stdin is the agent's own shutdown signal.
    drop(stdin);

    let Some(child) = helper.child.as_mut() else {
        return;
    };
    let exited = match child.id() {
        // Already reaped by someone else; nothing to signal.
        None => true,
        Some(pid) => {
            if tokio::time::timeout(STDIN_EOF_GRACE, child.wait())
                .await
                .is_ok()
            {
                true
            } else {
                kill_tree_signal(pid, "SIGTERM").await;
                if tokio::time::timeout(KILL_ESCALATE_GRACE, child.wait())
                    .await
                    .is_ok()
                {
                    true
                } else {
                    kill_tree_signal(pid, "SIGKILL").await;
                    tokio::time::timeout(KILL_REPORT_BUDGET, child.wait())
                        .await
                        .is_ok()
                }
            }
        }
    };
    if !exited {
        tracing::warn!(
            "[ACP][Antigravity] helper did not confirm exit within the kill budget; \
             its scratch directory is left to the sweep"
        );
    }

    // Disarm LAST. Everything above is `.await`, so this function is itself
    // cancellable, and until this line the guard is what covers that.
    drop(helper.child.take());

    if let Some(scratch) = scratch {
        scratch.release();
    }
}

/// A helper process that is ended as a TREE even if the future holding it is
/// dropped instead of run to completion.
///
/// `kill_on_drop` — which this spawn does set — signals only the DIRECT
/// process, and the Windows build is a PyInstaller onefile whose bootloader
/// runs the real program as a child of itself. So an unwind that relies on
/// `kill_on_drop` alone leaves the payload running with its ~1.17 GB unpacked
/// tree open, which is the original bug wearing a different hat. And an unwind
/// is reachable in ordinary operation: the HTTP handlers await these futures
/// directly, so a client that disconnects mid-sign-in cancels one.
///
/// [`reap_and_release`] disarms this on every path that completes.
#[derive(Debug)]
struct HelperChild {
    /// `None` once teardown has run. The `Option` is what makes "already
    /// handled" and "dropped early" distinguishable inside `Drop`.
    child: Option<tokio::process::Child>,
}

impl HelperChild {
    fn new(child: tokio::process::Child) -> Self {
        Self { child: Some(child) }
    }
}

impl Drop for HelperChild {
    fn drop(&mut self) {
        let Some(child) = self.child.take() else {
            return;
        };
        let Some(pid) = child.id() else {
            return;
        };
        tracing::warn!(
            "[ACP][Antigravity] teardown was cancelled; ending helper tree {pid} out of band"
        );
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            // No runtime to finish the job on. `kill_on_drop` still gets the
            // direct process as `child` falls out of scope here.
            return;
        };
        handle.spawn(async move {
            // The `Child` moves INTO the task and is not dropped until the wait
            // returns. That is deliberate: releasing it first would let the OS
            // recycle the pid while `kill_tree` is still walking it, and the
            // tree we ended would not be the tree we meant.
            let mut child = child;
            kill_tree_signal(pid, "SIGKILL").await;
            let _ = child.wait().await;
        });
    }
}

/// One signal pass over the process tree rooted at `pid`. Windows ignores the
/// signal name and terminates unconditionally.
async fn kill_tree_signal(pid: u32, signal: &str) {
    let config = kill_tree::Config {
        signal: signal.to_string(),
        ..Default::default()
    };
    if let Err(e) = kill_tree::tokio::kill_tree_with_config(pid, &config).await {
        tracing::debug!("[ACP][Antigravity] kill_tree({signal}) for pid {pid}: {e}");
    }
}

/// The one browser-free sign-in this installation may have in flight.
///
/// One at a time is not a simplification, it is the domain: the credential is
/// per-`GEMINI_HOME`, so two concurrent sign-ins race each other to the same
/// token file and the account that wins is whichever agent happens to write
/// last. Both of the slow stretches happen OUTSIDE the lock — spawning the
/// agent and waiting for its link, then delivering the redirect and waiting out
/// onboarding — so the slot has to carry which stretch is in progress rather
/// than only "is something pending".
#[derive(Default)]
struct Slot {
    /// Bumped by every [`start`]. Because a `start` publishes its attempt only
    /// after a handshake it performs unlocked, a slow older call can reach the
    /// install point after a newer one already gave the user a link. The
    /// generation is what lets it notice and reap its own child instead of
    /// killing the link on screen.
    generation: u64,
    state: SlotState,
}

#[derive(Default)]
enum SlotState {
    #[default]
    Idle,
    /// A `start` is between spawning its agent and installing the result. This
    /// deliberately does NOT block another `start` — the user may just be
    /// impatient, and the generation already decides which attempt wins.
    Starting,
    /// A link has been published and the agent is holding its listener open.
    Waiting(Box<Pending>),
    /// A `finish` has taken the attempt and its agent is exchanging the code
    /// and running onboarding — the window in which the credential is actually
    /// written. A `start` during it would put a second agent on the same file,
    /// so this one is refused until `until`.
    Finishing { until: Instant },
}

fn pending_slot() -> &'static Mutex<Slot> {
    static SLOT: OnceLock<Mutex<Slot>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(Slot::default()))
}

/// Take ownership of the slot for a new `start`, displacing any published
/// attempt.
///
/// `Err` only when a sign-in is mid-completion: that one is about to write the
/// credential, and letting a second agent start now is the one overlap that can
/// leave the wrong account signed in.
async fn claim_slot() -> Result<u64, AcpError> {
    claim_slot_as(SlotState::Starting).await
}

/// [`claim_slot`], parking the slot in `next` instead of [`SlotState::Starting`].
///
/// A sign-out needs the exclusive state from the instant it is granted: unlike
/// a `start`, whose unlocked stretch only produces a link, it is already on its
/// way to erasing the credential. Installing that state here rather than in a
/// second lock acquisition is what keeps a `start` from slipping in between.
async fn claim_slot_as(next: SlotState) -> Result<u64, AcpError> {
    let mut slot = pending_slot().lock().await;
    if let SlotState::Finishing { until } = slot.state {
        if Instant::now() < until {
            return Err(AcpError::protocol(
                "a sign-in is already being completed; wait for it to finish before starting \
                 another",
            ));
        }
        // Expired: whoever owned it is gone (most likely its caller
        // disconnected and the future was dropped), so the slot is ours.
    }
    slot.generation += 1;
    let displaced = match std::mem::replace(&mut slot.state, next) {
        SlotState::Waiting(pending) => Some(pending),
        _ => None,
    };
    if let Some(displaced) = displaced {
        tracing::info!(
            "[ACP][Antigravity] a new sign-in displaced attempt {}",
            displaced.handle
        );
        // Under the lock on purpose: a few milliseconds, and it keeps "the slot
        // no longer names it" and "its process is gone" from being observable
        // apart.
        displaced.kill().await;
    }
    Ok(slot.generation)
}

/// Publish a finished handshake, unless a newer `start` has taken over.
///
/// `Err` hands the attempt back so the caller can reap the child it just
/// spawned — the newer attempt is the one the user is looking at. Boxed on both
/// sides: `Waiting` stores it boxed anyway, and an unboxed `Pending` would make
/// every `Ok` of this `Result` carry the several hundred bytes of the error.
async fn install(generation: u64, pending: Box<Pending>) -> Result<(), Box<Pending>> {
    let mut slot = pending_slot().lock().await;
    if slot.generation != generation {
        return Err(pending);
    }
    slot.state = SlotState::Waiting(pending);
    Ok(())
}

/// Give the slot back after a `start` that will not publish anything.
///
/// Scoped to this attempt's generation so a failure arriving late cannot undo a
/// newer sign-in that has already claimed the slot.
async fn abandon_start(generation: u64) {
    let mut slot = pending_slot().lock().await;
    if slot.generation == generation && matches!(slot.state, SlotState::Starting) {
        slot.state = SlotState::Idle;
    }
}

/// Begin a browser-free sign-in: spawn the agent, ask it to authenticate, and
/// return the URL it wants a human to open.
///
/// `method_id` is taken from the caller rather than from the stored row on
/// purpose. The panel can offer "sign in" for the method currently selected in
/// the form, and the agent persists the choice itself (`_remember_auth_type`
/// runs at the end of a successful `authenticate`), so codeg does not write
/// `settings.json` here — doing so would record the *saved* method, which is
/// not necessarily the one being signed in.
pub async fn start(
    runtime_env: &BTreeMap<String, String>,
    method_id: &str,
) -> Result<AntigravityLoginStart, AcpError> {
    if !crate::acp::connection::is_antigravity_auth_method(method_id) {
        return Err(AcpError::protocol(format!(
            "unknown Antigravity auth method {method_id:?}"
        )));
    }
    // The API-key methods read a credential straight from the environment and
    // never open a browser, so there is nothing here for them to fix. Refusing
    // is better than spawning a child that returns "invalid params".
    if !matches!(method_id, "oauth-personal" | "oauth-business") {
        return Err(AcpError::protocol(format!(
            "{method_id} does not use a browser sign-in; set its credential in the panel instead"
        )));
    }

    let generation = claim_slot().await?;
    // Every failure below has to hand the slot back, and there are a dozen of
    // them (spawn, handshake, timeout, a malformed link). One `Err` arm beats
    // remembering to release on each.
    match start_claimed(runtime_env, method_id, generation).await {
        Ok(started) => Ok(started),
        Err(e) => {
            abandon_start(generation).await;
            Err(e)
        }
    }
}

/// [`start`] with the slot already claimed for `generation`.
async fn start_claimed(
    runtime_env: &BTreeMap<String, String>,
    method_id: &str,
    generation: u64,
) -> Result<AntigravityLoginStart, AcpError> {
    let mut sign_in_env = Vec::new();
    // Without this the agent's `print` of the authorization URL sits in
    // CPython's block buffer for a piped stdout and never reaches us — see the
    // module docs. It is the whole reason this flow can see the link at all.
    sign_in_env.push(("PYTHONUNBUFFERED".to_string(), "1".to_string()));
    // Point `webbrowser` at a no-op so it cannot do something worse than
    // nothing. On a server with a TEXT browser installed (`lynx`, `w3m`,
    // `links`) CPython picks a `GenericBrowser` and **`wait()`s on it**, so the
    // agent would block on a terminal browser wired to the ACP pipes. An empty
    // value is not an option: the spawn layer reads that as "remove the
    // variable" and the search runs anyway.
    if let Some(noop) = noop_browser() {
        sign_in_env.push(("BROWSER".to_string(), noop));
    }

    let AgentChild {
        child,
        mut stdin,
        mut responses,
        url: mut url_rx,
        stderr: tail,
        scratch,
    } = spawn_agent(runtime_env, sign_in_env).await?;

    // `initialize` first, and its answer awaited before `authenticate` goes
    // out. Not just protocol politeness: it keeps the URL `print` — which the
    // agent emits during `authenticate`, onto the same fd as the JSON-RPC
    // frames — from racing a response codeg still has to parse.
    // Not `?`: an early return here would drop `child` — which `kill_on_drop`
    // turns into a signal to the DIRECT process only, leaving a onefile
    // payload alive — and strand the scratch directory with it.
    if let Err(e) = initialize(&mut stdin, &mut responses, &tail).await {
        reap_and_release(child, stdin, scratch).await;
        return Err(e);
    }

    let authenticate = serde_json::json!({
        "jsonrpc": "2.0",
        "id": ID_AUTHENTICATE,
        "method": "authenticate",
        "params": { "methodId": method_id },
    });
    if let Err(e) = write_frame(&mut stdin, &authenticate).await {
        reap_and_release(child, stdin, scratch).await;
        return Err(e);
    }

    // From here the agent is inside its 300 s redirect wait, so any failure
    // must kill the child rather than leave it blocked.
    //
    // Racing the URL against the `authenticate` response is not belt-and-braces:
    // both non-URL outcomes are ordinary. A cached, still-refreshable token
    // makes `authenticate` return immediately with no link at all, and a
    // rejected method makes it return an error — and in both cases the child
    // stays alive, so waiting on the URL alone would burn the full timeout
    // before reporting something already known.
    let signal = tokio::time::timeout(URL_WAIT, async {
        loop {
            tokio::select! {
                biased;
                url = &mut url_rx => {
                    // `Err` means every clone of the sink dropped, i.e. BOTH
                    // output streams hit EOF — the process is gone.
                    return url.map_or(StartSignal::Gone, StartSignal::Url);
                }
                message = responses.recv() => {
                    let Some(message) = message else { return StartSignal::Gone };
                    if message.get("id").and_then(serde_json::Value::as_i64)
                        != Some(ID_AUTHENTICATE)
                    {
                        continue;
                    }
                    return match error_message(&message) {
                        Some(reason) => StartSignal::Failed(reason),
                        None => StartSignal::Authenticated,
                    };
                }
            }
        }
    })
    .await
    .unwrap_or(StartSignal::TimedOut);

    let auth_url = match signal {
        StartSignal::Url(url) => url,
        StartSignal::Authenticated => {
            reap_and_release(child, stdin, scratch).await;
            tracing::info!(
                "[ACP][Antigravity] {method_id} was already signed in; no link needed"
            );
            return Ok(AntigravityLoginStart {
                already_signed_in: true,
                handle: None,
                auth_url: None,
                redirect_uri: None,
                method_id: method_id.to_string(),
                expires_in_secs: PENDING_TTL.as_secs(),
            });
        }
        StartSignal::Failed(reason) => {
            reap_and_release(child, stdin, scratch).await;
            return Err(AcpError::protocol(format!(
                "Antigravity refused to start a sign-in: {reason}"
            )));
        }
        StartSignal::Gone | StartSignal::TimedOut => {
            reap_and_release(child, stdin, scratch).await;
            let reported = drain_error(&mut responses, ID_AUTHENTICATE);
            return Err(AcpError::protocol(match reported {
                Some(message) => format!("Antigravity refused to start a sign-in: {message}"),
                None => format!(
                    "Antigravity did not produce a sign-in link.{}",
                    stderr_hint(&tail)
                ),
            }));
        }
    };

    let redirect_uri = match extract_redirect_uri(&auth_url) {
        Ok(uri) => uri,
        Err(reason) => {
            reap_and_release(child, stdin, scratch).await;
            return Err(AcpError::protocol(reason));
        }
    };
    let state = query_param(&auth_url, "state").unwrap_or_default();

    let handle = uuid::Uuid::new_v4().to_string();
    let credential_path = credential_path_for(runtime_env, method_id);
    let pending = Box::new(Pending {
        handle: handle.clone(),
        method_id: method_id.to_string(),
        redirect_uri: redirect_uri.clone(),
        state,
        credential_path: credential_path.clone(),
        child,
        _stdin: stdin,
        responses,
        stderr: tail,
        scratch,
        started: Instant::now(),
    });
    // The spawn and handshake above ran OUTSIDE the lock, so a newer `start`
    // may already have claimed the slot and shown the user a different link.
    // If so this attempt is the stale one and gets reaped, rather than
    // displacing the link on screen.
    if let Err(orphan) = install(generation, pending).await {
        orphan.kill().await;
        return Err(AcpError::protocol(
            "a newer sign-in replaced this one; use the link it produced",
        ));
    }

    tracing::info!(
        "[ACP][Antigravity] browser-free sign-in started for {method_id}; redirect listener at {redirect_uri}"
    );
    Ok(AntigravityLoginStart {
        already_signed_in: false,
        handle: Some(handle),
        auth_url: Some(auth_url),
        redirect_uri: Some(redirect_uri),
        method_id: method_id.to_string(),
        expires_in_secs: PENDING_TTL.as_secs(),
    })
}

/// A short-lived Antigravity process driven over raw JSON-RPC, with its three
/// streams already split apart.
struct AgentChild {
    child: HelperChild,
    /// Must stay open for the child's whole life: the ACP server reads stdin
    /// EOF as "the client is gone" and shuts down — which would abort whatever
    /// request is in flight.
    stdin: tokio::process::ChildStdin,
    responses: mpsc::UnboundedReceiver<serde_json::Value>,
    /// Resolves with the authorization URL the agent prints during an OAuth
    /// `authenticate`. Nothing else it does produces one.
    url: oneshot::Receiver<String>,
    stderr: Arc<StderrTail>,
    /// See [`Pending::scratch`]. Moves into the `Pending` on the sign-in path
    /// and is consumed directly by [`sign_out_claimed`].
    scratch: Option<LaunchScratch>,
}

/// Spawn the installed Antigravity binary with a launch-identical environment.
///
/// Shared by the two flows that reach the agent outside a session, and the
/// environment is why: `GEMINI_HOME` decides WHICH credential store the child
/// touches and `AGY_ACP_FORCE_FILE_STORAGE` decides whether that store is a
/// file or the macOS keychain. A child built any other way would faithfully
/// sign the user in — or out — of something no session ever reads.
///
/// `extra_env` is layered on top afterwards, so a caller can add the variables
/// only its own flow needs.
async fn spawn_agent(
    runtime_env: &BTreeMap<String, String>,
    extra_env: Vec<(String, String)>,
) -> Result<AgentChild, AcpError> {
    let binary = resolve_binary()?;
    // Same per-launch temp isolation the session path gets, and for the same
    // reason: this spawns the identical self-extracting binary, so sign-in and
    // sign-out each unpack a full copy. They were invisible in the leak report
    // because neither emits the `[ACP] spawning connection` line the user
    // counted — the directories were there all the same.
    let scratch = crate::acp::scratch_dir::create();
    let mut env = crate::acp::connection::antigravity_launch_env(
        runtime_env,
        scratch.as_ref().map(|s| s.path()),
    );
    env.extend(extra_env);

    let mut command = crate::process::tokio_command(&binary);
    command
        .args(antigravity_launch_args())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Backstop for every path that drops a child without going through
        // `kill()`. Dropping a tokio `Child` detaches by default, and a
        // detached agent here is not merely a stray process: mid-sign-in it
        // holds a loopback listener open for the rest of its 300 s wait, so
        // the port and the attempt both linger with nothing able to reach them.
        .kill_on_drop(true);
    for (key, value) in &env {
        // Mirrors the spawn layer's convention (`acp::agent_process`): an empty
        // value means "do not let the child inherit this one".
        if value.is_empty() {
            command.env_remove(key);
        } else {
            command.env(key, value);
        }
    }

    // Every `?` from here down would drop `scratch` on the floor, so the
    // fallible stretch is fenced and its failures release the directory before
    // propagating. `LaunchScratch` deliberately has no `Drop`: removal needs to
    // retry across a process tree that is still dying, which a synchronous drop
    // cannot do without blocking whoever happens to drop it.
    let spawned = async {
        let mut child = crate::process::spawn_retrying_exec_busy(|| command.spawn())
            .await
            .map_err(|e| AcpError::SpawnFailed(e.to_string()))?;

        let stdin = child.stdin.take().ok_or_else(|| {
            AcpError::SpawnFailed("the Antigravity process has no stdin".to_string())
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            AcpError::SpawnFailed("the Antigravity process has no stdout".to_string())
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            AcpError::SpawnFailed("the Antigravity process has no stderr".to_string())
        })?;
        Ok::<_, AcpError>((child, stdin, stdout, stderr))
    }
    .await;
    let (child, stdin, stdout, stderr) = match spawned {
        Ok(parts) => parts,
        Err(e) => {
            if let Some(scratch) = scratch {
                scratch.release();
            }
            return Err(e);
        }
    };

    let (response_tx, responses) = mpsc::unbounded_channel::<serde_json::Value>();
    let (url_sink, url) = AuthUrlSink::new();
    tokio::spawn(read_agent_stdout(stdout, response_tx, url_sink.clone()));

    // Redacted on write and bounded, so it is safe to put in an error message.
    let tail = Arc::new(StderrTail::new());
    tokio::spawn(read_agent_stderr(stderr, Arc::clone(&tail), url_sink));

    Ok(AgentChild {
        child: HelperChild::new(child),
        stdin,
        responses,
        url,
        stderr: tail,
        scratch,
    })
}

/// Send `initialize` and hand back the agent's answer.
///
/// Takes the three streams rather than the whole [`AgentChild`] because both
/// callers destructure it on the way in — a sign-in has to hold `url` and
/// `child` across the same await.
async fn initialize(
    stdin: &mut tokio::process::ChildStdin,
    responses: &mut mpsc::UnboundedReceiver<serde_json::Value>,
    stderr: &StderrTail,
) -> Result<serde_json::Value, AcpError> {
    let init = serde_json::json!({
        "jsonrpc": "2.0",
        "id": ID_INITIALIZE,
        "method": "initialize",
        "params": {
            "protocolVersion": 1,
            "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false } },
            "clientInfo": { "name": "codeg", "version": env!("CARGO_PKG_VERSION") },
        },
    });
    write_frame(stdin, &init).await?;
    await_response(responses, ID_INITIALIZE, INITIALIZE_WAIT, stderr)
        .await
        .map_err(|reason| {
            AcpError::protocol(format!("Antigravity did not accept `initialize`: {reason}"))
        })
}

/// The first thing the agent does after `authenticate` that codeg can act on.
enum StartSignal {
    /// It printed a link and is now blocking on its loopback listener.
    Url(String),
    /// It signed in from a cached credential — no link, nothing to complete.
    Authenticated,
    /// It refused, in its own words.
    Failed(String),
    /// Its stdout closed: the process died.
    Gone,
    TimedOut,
}

/// Deliver the redirect the user's browser could not, and report whether the
/// agent signed in.
///
/// `pasted` is whatever the user copied: the whole redirected address, a bare
/// query string, or just the code. Only `code`, `state` and `error` are read
/// from it; the request target itself comes from the captured `redirect_uri`.
pub async fn finish(handle: &str, pasted: &str) -> Result<AntigravityLoginOutcome, AcpError> {
    let parsed = ParsedRedirect::parse(pasted);

    // Validate WITHOUT consuming the attempt. A paste codeg itself rejects
    // never reached the agent, so the listener is still open and the consent
    // the user already gave in their browser is still good — making them redo
    // the whole Google round trip over a truncated copy would be gratuitous.
    // Only a redirect that actually goes out spends the attempt, because the
    // listener answers exactly one request.
    let (target, pending, generation) = {
        let mut slot = pending_slot().lock().await;
        let SlotState::Waiting(pending) = &slot.state else {
            return Err(AcpError::protocol(
                "no sign-in is waiting; start a new one",
            ));
        };
        if pending.handle != handle {
            return Err(AcpError::protocol(
                "this sign-in is no longer active; start a new one",
            ));
        }
        let credential_path = display_path(&pending.credential_path);

        if pending.is_stale() {
            let stale = take_waiting(&mut slot);
            drop(slot);
            stale.kill().await;
            return Ok(AntigravityLoginOutcome {
                signed_in: false,
                message: Some(
                    "This sign-in expired — Antigravity stops waiting after 5 minutes. \
                     Start a new one."
                        .to_string(),
                ),
                retryable: false,
                credential_path,
            });
        }
        if let Some(reason) = reject_locally(&pending.state, &parsed) {
            // Left in `Waiting`: the agent never heard about this paste.
            return Ok(AntigravityLoginOutcome {
                signed_in: false,
                message: Some(reason),
                retryable: true,
                credential_path,
            });
        }
        let target = build_redirect_request(&pending.redirect_uri, &pending.state, &parsed)?;

        // Hand the slot from `Waiting` to `Finishing` atomically. From here the
        // agent is about to write the credential, so `claim_slot` refuses a
        // second sign-in until this one answers or its budget runs out. The
        // generation rides along so the release at the end can tell this
        // completion from a later one that took over after an expiry.
        let pending = take_waiting(&mut slot);
        slot.state = SlotState::Finishing {
            until: Instant::now() + FINISH_BUDGET,
        };
        (target, pending, slot.generation)
    };

    if let Some(error) = &parsed.error {
        // Forwarded rather than short-circuited: the agent's listener is still
        // blocking, and an `error` releases it immediately instead of burning
        // the rest of the 300 s. Its own message then rides back through
        // `authenticate`.
        tracing::info!("[ACP][Antigravity] sign-in redirect carried error={error}");
    }

    let outcome = finish_delivering(target, pending).await;
    release_finishing(generation).await;
    Ok(outcome)
}

/// Move the published attempt out of the slot, leaving it [`SlotState::Idle`].
///
/// Panics if the slot is not [`SlotState::Waiting`]; every caller has just
/// matched on it under the same lock.
fn take_waiting(slot: &mut Slot) -> Pending {
    match std::mem::take(&mut slot.state) {
        SlotState::Waiting(pending) => *pending,
        _ => unreachable!("caller matched Waiting under this lock"),
    }
}

/// Release the slot after a `finish`, whatever its verdict.
///
/// Generation-scoped, and that is load-bearing rather than defensive. The
/// `Finishing` deadline exists so a dropped `finish` future cannot wedge the
/// slot — but it also means a slow `finish` can outlive its own claim: once its
/// budget expires, a second sign-in claims the slot, publishes, and enters its
/// OWN `Finishing`. A state-only check would then let the first call's late
/// cleanup mark that second completion `Idle`, re-opening the exact overlap the
/// state exists to prevent, at the exact moment the credential is being
/// written. The generation is what tells the two apart: every attempt comes
/// from one `claim_slot`, so it names this completion and no other.
async fn release_finishing(generation: u64) {
    let mut slot = pending_slot().lock().await;
    if slot.generation == generation && matches!(slot.state, SlotState::Finishing { .. }) {
        slot.state = SlotState::Idle;
    }
}

/// The half of `finish` that runs with the slot marked `Finishing`: deliver the
/// redirect, then wait for the agent's verdict. Always reaps the child.
async fn finish_delivering(target: String, pending: Pending) -> AntigravityLoginOutcome {
    let Pending {
        method_id,
        credential_path,
        child,
        mut responses,
        stderr,
        _stdin,
        scratch,
        ..
    } = pending;
    let credential_path = display_path(&credential_path);

    if let Err(reason) = deliver_redirect(&target).await {
        reap_and_release(child, _stdin, scratch).await;
        return AntigravityLoginOutcome {
            signed_in: false,
            message: Some(reason),
            retryable: false,
            credential_path,
        };
    }

    let outcome = await_response(&mut responses, ID_AUTHENTICATE, AUTHENTICATE_WAIT, &stderr).await;
    reap_and_release(child, _stdin, scratch).await;

    match outcome {
        Ok(_) => {
            tracing::info!("[ACP][Antigravity] browser-free sign-in succeeded for {method_id}");
            AntigravityLoginOutcome {
                signed_in: true,
                message: None,
                retryable: false,
                credential_path,
            }
        }
        Err(reason) => {
            tracing::warn!("[ACP][Antigravity] browser-free sign-in failed: {reason}");
            AntigravityLoginOutcome {
                signed_in: false,
                message: Some(reason),
                retryable: false,
                credential_path,
            }
        }
    }
}

/// Why codeg will not send this paste on, if it will not.
///
/// Everything here is decidable without touching the agent, which is exactly
/// what makes these failures cheap to retry. Takes the expected `state` rather
/// than the whole [`Pending`] so it is a pure function of the two things it
/// reads — and so the tests exercise it directly instead of a copy of it.
fn reject_locally(expected_state: &str, parsed: &ParsedRedirect) -> Option<String> {
    // An `error` is a legitimate answer (the user pressed "deny"), so it is
    // forwarded rather than rejected — the agent needs to hear it to stop
    // waiting.
    if parsed.error.is_none() && parsed.code.is_none() {
        return Some(
            "No authorization code found. Paste the whole address your browser ended up on \
             — it starts with http://127.0.0.1: and contains `code=`."
                .to_string(),
        );
    }
    if let Some(state) = &parsed.state {
        if !expected_state.is_empty() && state != expected_state {
            return Some(
                "That address belongs to a different sign-in attempt. Use the link this \
                 sign-in gave you, or start a new one."
                    .to_string(),
            );
        }
    }
    None
}

/// Abandon a pending sign-in and stop its agent process.
pub async fn cancel(handle: &str) -> Result<(), AcpError> {
    let abandoned = {
        let mut slot = pending_slot().lock().await;
        let SlotState::Waiting(pending) = &slot.state else {
            return Err(AcpError::protocol(
                "no sign-in is waiting; start a new one",
            ));
        };
        // A handle that is not the current one belongs to an attempt already
        // displaced (a stale browser tab, a double submit). Reporting that is
        // right; killing the one the user IS working on would not be.
        if pending.handle != handle {
            return Err(AcpError::protocol(
                "this sign-in is no longer active; start a new one",
            ));
        }
        take_waiting(&mut slot)
    };
    abandoned.kill().await;
    Ok(())
}

/// Ceiling on how long a sign-out may hold the slot exclusively.
///
/// Its own two waits bound the work, and the slack covers the code around them.
/// It exists for the same reason [`FINISH_BUDGET`] does: in server mode a
/// client disconnect drops the handler future mid-`await`, and an exclusive
/// state nothing ever clears would refuse every later sign-in for the life of
/// the process.
const SIGN_OUT_BUDGET: Duration =
    Duration::from_secs(INITIALIZE_WAIT.as_secs() + LOGOUT_WAIT.as_secs() + 30);

/// Discard the credential Antigravity is holding, so the next sign-in can reach
/// a different Google account.
///
/// This is what makes [`start`] usable more than once. The agent refreshes a
/// cached token silently, so a second `authenticate` for an account that is
/// already signed in returns immediately and prints no link — the panel can
/// only report `already_signed_in`, and the first account a user picks is the
/// last one they ever get. Nothing the user can reasonably reach fixes that
/// either: the credential is a login-keychain item on macOS and a file under
/// `GEMINI_HOME` elsewhere, so it outlives uninstalling the Antigravity CLI and
/// reinstalling codeg.
///
/// Driven through the agent's own ACP `logout` rather than by deleting the
/// store from here. Which backend holds the credential is decided inside the
/// agent (`credential_store.py::create_default_store` probes for a usable
/// keychain and falls back to the file), and its `clear` deliberately wipes
/// BOTH so an older plaintext token cannot survive — rules codeg would have to
/// copy, and re-copy whenever they change.
///
/// `logout` also removes `auth.type` from the server's `settings.json`, which
/// is codeg's business: a session whose `auth.type` is missing fails outright
/// with `Authentication required`. The caller puts the saved method back (see
/// `acp_antigravity_sign_out_core`).
pub async fn sign_out(runtime_env: &BTreeMap<String, String>) -> Result<(), AcpError> {
    // Exclusive from the instant it is granted, unlike a `start`: this call is
    // already on its way to erasing the credential, and a sign-in overlapping
    // it would race the same store. Any published attempt is displaced and
    // reaped — the user asking to sign out has abandoned the link on screen.
    let generation = claim_slot_as(SlotState::Finishing {
        until: Instant::now() + SIGN_OUT_BUDGET,
    })
    .await?;
    let outcome = sign_out_claimed(runtime_env).await;
    release_finishing(generation).await;
    outcome
}

/// [`sign_out`] with the slot already held.
async fn sign_out_claimed(runtime_env: &BTreeMap<String, String>) -> Result<(), AcpError> {
    let mut agent = spawn_agent(runtime_env, Vec::new()).await?;
    let outcome = request_logout(&mut agent).await;
    // Reaped once here rather than on each early return inside: unlike a
    // sign-in, `logout` opens no listener and holds no port, so the only thing
    // a failure leaves behind is the process — and, since this spawns the same
    // self-extracting binary, its unpacked copy.
    let AgentChild {
        child,
        stdin,
        scratch,
        ..
    } = agent;
    reap_and_release(child, stdin, scratch).await;
    match &outcome {
        Ok(()) => tracing::info!("[ACP][Antigravity] signed out; the stored credential is gone"),
        Err(e) => tracing::warn!("[ACP][Antigravity] sign-out failed: {e}"),
    }
    outcome
}

/// Handshake, check the capability, ask the agent to sign out.
async fn request_logout(agent: &mut AgentChild) -> Result<(), AcpError> {
    let handshake = initialize(&mut agent.stdin, &mut agent.responses, &agent.stderr).await?;
    if !advertises_logout(&handshake) {
        return Err(AcpError::protocol(
            "this version of Google Antigravity cannot sign out. Update it in Agent Settings, \
             or delete its stored credential yourself.",
        ));
    }

    let logout = serde_json::json!({
        "jsonrpc": "2.0",
        "id": ID_LOGOUT,
        "method": "logout",
        "params": {},
    });
    write_frame(&mut agent.stdin, &logout).await?;
    await_response(
        &mut agent.responses,
        ID_LOGOUT,
        LOGOUT_WAIT,
        &agent.stderr,
    )
    .await
    .map(|_| ())
    .map_err(|reason| AcpError::protocol(format!("Antigravity refused to sign out: {reason}")))
}

/// Whether the agent's `initialize` answer offers the ACP `logout` method.
///
/// Checked rather than assumed because the protocol says to — the agent's own
/// comment beside the capability reads "Clients MUST NOT call `logout` unless
/// this is advertised" — and because the alternative is a bare `-32601` where
/// the actionable answer is "your Antigravity is too old to sign out".
fn advertises_logout(handshake: &serde_json::Value) -> bool {
    handshake
        .pointer("/result/agentCapabilities/auth/logout")
        .is_some_and(|value| !value.is_null())
}

/// The bits of a pasted redirect codeg is willing to act on.
#[derive(Debug, Default, PartialEq, Eq)]
struct ParsedRedirect {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

impl ParsedRedirect {
    /// Accepts a full URL, a bare query string, or a lone authorization code.
    ///
    /// The lone-code case is not a convenience so much as a safety valve: some
    /// browsers render the unreachable loopback page without an address bar the
    /// user can copy in full, and Google's codes are distinctive enough
    /// (`4/0A…`) that people reliably extract just that part.
    fn parse(raw: &str) -> Self {
        let raw = raw.trim();
        if raw.is_empty() {
            return Self::default();
        }
        let query = match raw.split_once('?') {
            Some((_, query)) => query,
            // No `?` at all: either someone pasted the query string on its own,
            // or just the code.
            None if raw.contains('=') => raw,
            None => {
                return Self {
                    code: Some(raw.to_string()),
                    ..Self::default()
                }
            }
        };
        // A fragment is never part of the query and can only be noise here.
        let query = query.split('#').next().unwrap_or(query);

        let mut parsed = Self::default();
        for pair in query.split('&') {
            let Some((key, value)) = pair.split_once('=') else {
                continue;
            };
            let value = percent_decode(value);
            if value.is_empty() {
                continue;
            }
            match key.trim() {
                "code" => parsed.code = Some(value),
                "state" => parsed.state = Some(value),
                "error" => parsed.error = Some(value),
                _ => {}
            }
        }
        parsed
    }
}

/// Rebuild the redirect request from the captured listener address.
///
/// The single place the SSRF question is answered: the host, port and path come
/// from `redirect_uri`, which codeg read out of the agent's own authorization
/// URL and re-checks here against the agent's hardcoded loopback host. Only the
/// three OAuth parameters come from the user.
fn build_redirect_request(
    redirect_uri: &str,
    expected_state: &str,
    parsed: &ParsedRedirect,
) -> Result<String, AcpError> {
    if !is_loopback_redirect(redirect_uri) {
        return Err(AcpError::protocol(
            "Antigravity asked for a redirect target that is not on the loopback interface; \
             refusing to contact it",
        ));
    }
    let mut query: Vec<String> = Vec::new();
    // Always the captured value, never the pasted one — they are equal by the
    // time we get here (checked in `finish`) and this way they cannot diverge.
    if !expected_state.is_empty() {
        query.push(format!("state={}", urlencoding::encode(expected_state)));
    }
    if let Some(code) = &parsed.code {
        query.push(format!("code={}", urlencoding::encode(code)));
    }
    if let Some(error) = &parsed.error {
        query.push(format!("error={}", urlencoding::encode(error)));
    }
    let separator = if redirect_uri.contains('?') { '&' } else { '?' };
    Ok(format!("{redirect_uri}{separator}{}", query.join("&")))
}

fn is_loopback_redirect(redirect_uri: &str) -> bool {
    let Some(rest) = redirect_uri.strip_prefix(LOOPBACK_PREFIX) else {
        return false;
    };
    // `127.0.0.1:8080@evil.example` parses as a host of `evil.example` under
    // RFC 3986 userinfo rules, so the port must be digits and the authority
    // must end right there.
    let port = rest.split('/').next().unwrap_or(rest);
    !port.is_empty() && port.chars().all(|c| c.is_ascii_digit())
}

/// Perform the redirect against the agent's one-shot listener.
async fn deliver_redirect(target: &str) -> Result<(), String> {
    let client = reqwest::Client::builder()
        // A loopback address must never be handed to a proxy — and codeg's
        // users routinely run behind one.
        .no_proxy()
        // The loopback-only invariant is checked on the target codeg builds;
        // following a redirect would let the response choose the next one and
        // step straight out of it. The shipped listener only ever answers 200,
        // so nothing legitimate is lost.
        .redirect(reqwest::redirect::Policy::none())
        .timeout(REDIRECT_WAIT)
        .build()
        .map_err(|e| format!("could not build an HTTP client for the redirect: {e}"))?;
    match client.get(target).send().await {
        Ok(response) if response.status().is_success() => Ok(()),
        Ok(response) => Err(format!(
            "Antigravity's sign-in listener answered {} instead of accepting the redirect.",
            response.status()
        )),
        Err(e) if e.is_connect() => Err(
            "Antigravity is no longer listening for this sign-in (it waits 5 minutes). \
             Start a new sign-in."
                .to_string(),
        ),
        Err(e) if e.is_timeout() => Err(
            "Antigravity's sign-in listener did not answer in time. Start a new sign-in."
                .to_string(),
        ),
        Err(e) => Err(format!("Could not deliver the redirect: {e}")),
    }
}

/// Wait for the JSON-RPC response with `id`, translating it into
/// the-message-or-why-not.
///
/// Anything that is not that response is dropped: the only other traffic on
/// this connection is notifications these flows have no use for. `Ok` carries
/// the whole message rather than `()` because `initialize`'s answer is where
/// the agent's capabilities are, and a sign-out has to read one before it may
/// ask for it.
async fn await_response(
    responses: &mut mpsc::UnboundedReceiver<serde_json::Value>,
    id: i64,
    wait: Duration,
    stderr: &StderrTail,
) -> Result<serde_json::Value, String> {
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        let message = match tokio::time::timeout_at(deadline, responses.recv()).await {
            Ok(Some(message)) => message,
            // Channel closed: stdout hit EOF, so the process is gone.
            Ok(None) => {
                return Err(format!(
                    "the Antigravity process exited before answering.{}",
                    stderr_hint(stderr)
                ))
            }
            Err(_) => {
                return Err(format!(
                    "Antigravity did not answer within {}s.{}",
                    wait.as_secs(),
                    stderr_hint(stderr)
                ))
            }
        };
        if message.get("id").and_then(serde_json::Value::as_i64) != Some(id) {
            continue;
        }
        return match error_message(&message) {
            Some(reason) => Err(reason),
            None => Ok(message),
        };
    }
}

/// The agent's own explanation for a failed request, if it sent one.
fn error_message(message: &serde_json::Value) -> Option<String> {
    let error = message.get("error")?;
    // Antigravity puts the actionable text in `error.message`, and for
    // auth_required (-32000) repeats a longer form in `error.data.message`.
    let text = error
        .get("data")
        .and_then(|data| data.get("message"))
        .and_then(serde_json::Value::as_str)
        .or_else(|| error.get("message").and_then(serde_json::Value::as_str))
        .unwrap_or("the request failed");
    Some(crate::acp::stderr_tail::sanitize_diagnostic(text))
}

/// Non-blocking look for an already-delivered error response with `id`.
fn drain_error(
    responses: &mut mpsc::UnboundedReceiver<serde_json::Value>,
    id: i64,
) -> Option<String> {
    while let Ok(message) = responses.try_recv() {
        if message.get("id").and_then(serde_json::Value::as_i64) == Some(id) {
            return error_message(&message);
        }
    }
    None
}

/// A short, already-redacted excerpt of the agent's stderr for an error message.
///
/// The prompt line is dropped rather than quoted. It is not a diagnostic, and
/// the tail holds it truncated to `MAX_LINE_BYTES` — so a message complaining
/// that no link appeared would end in two thirds of a consent URL, which reads
/// as corruption rather than as the link it is.
fn stderr_hint(stderr: &StderrTail) -> String {
    let slice = stderr.tail_since(0, 4, 600);
    let lines: Vec<&str> = slice
        .lines
        .iter()
        .map(String::as_str)
        .filter(|line| !line.contains(AUTH_PROMPT_MARKER))
        .collect();
    if lines.is_empty() {
        return String::new();
    }
    format!(" Last output: {}", lines.join(" / "))
}

/// The authorization URL, from whichever of the child's two streams prints it.
///
/// Which one that is depends on the agent's version and has already moved once
/// — 1.0.0 printed it to stdout, 1.1.1 prints it to stderr — so both pumps
/// offer their lines here and the first match wins. Scanning only the stream
/// this build happens to pin would make a sign-in against the other one hang
/// for [`URL_WAIT`] and then report, wrongly, that no link was produced.
///
/// A `oneshot::Sender` cannot be cloned, hence the shared slot. The lock is
/// held for a single `take`, never across an await.
#[derive(Clone)]
struct AuthUrlSink(Arc<std::sync::Mutex<Option<oneshot::Sender<String>>>>);

impl AuthUrlSink {
    /// The sink and the receiver that resolves with the first URL offered.
    ///
    /// The receiver also errs once EVERY clone is dropped, which is how
    /// [`start_claimed`] learns the child's output closed — so no clone may
    /// outlive the two pumps.
    fn new() -> (Self, oneshot::Receiver<String>) {
        let (tx, rx) = oneshot::channel();
        (Self(Arc::new(std::sync::Mutex::new(Some(tx)))), rx)
    }

    /// Offer one raw output line; a no-op unless it carries the prompt and
    /// nothing has claimed the channel yet.
    fn offer(&self, line: &str) {
        let Some(url) = find_auth_url(line) else {
            return;
        };
        // A poisoned lock is recovered rather than propagated: losing the URL
        // would strand the user on a spinner, and there is no invariant here a
        // panicking holder could have broken — the slot is one `Option`.
        let mut slot = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(tx) = slot.take() {
            let _ = tx.send(url);
        }
    }
}

/// Read the child's stdout, routing JSON-RPC frames to `responses` and any
/// printed authorization URL to `url_sink`.
///
/// Both are checked on every line rather than one-or-the-other: when the agent
/// prints the URL here it shares the file descriptor with the protocol frames,
/// so a line can in principle carry both.
///
/// Generic over the reader rather than taking a [`tokio::process::ChildStdout`]
/// so a test can drive the real pump over a cursor. Which stream feeds the sink
/// is exactly what regressed, and a test of [`AuthUrlSink`] alone would not
/// have noticed.
async fn read_agent_stdout<R>(
    stdout: R,
    responses: mpsc::UnboundedSender<serde_json::Value>,
    url_sink: AuthUrlSink,
) where
    R: tokio::io::AsyncRead + Unpin,
{
    let reader = BufReader::new(stdout);
    crate::process::collect_lines_lossy(reader, |line| {
        url_sink.offer(line);
        if let Some(start) = line.find('{') {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line[start..]) {
                let _ = responses.send(value);
            }
        }
    })
    .await;
}

/// Read the child's stderr into `tail`, offering every line to `url_sink` on
/// the way.
///
/// The offer happens on the RAW line and before `push`, because the tail
/// redacts and truncates to `MAX_LINE_BYTES` on the way in — which would slice
/// a ~510-character consent URL off mid-query.
async fn read_agent_stderr<R>(stderr: R, tail: Arc<StderrTail>, url_sink: AuthUrlSink)
where
    R: tokio::io::AsyncRead + Unpin,
{
    let reader = BufReader::new(stderr);
    crate::process::collect_lines_lossy(reader, |line| {
        url_sink.offer(line);
        tail.push(line);
    })
    .await;
}

/// Pull the authorization URL out of the agent's prompt line.
fn find_auth_url(line: &str) -> Option<String> {
    let rest = &line[line.find(AUTH_PROMPT_MARKER)? + AUTH_PROMPT_MARKER.len()..];
    // The URL runs to the first whitespace: nothing in a query string can
    // contain an unescaped space, and a JSON frame spliced onto the same line
    // would start after one.
    let url = rest.split_whitespace().next()?;
    url.starts_with("https://").then(|| url.to_string())
}

/// The loopback address the agent will be redirected to, read from its own
/// authorization URL.
fn extract_redirect_uri(auth_url: &str) -> Result<String, String> {
    let redirect = query_param(auth_url, "redirect_uri").ok_or_else(|| {
        "Antigravity's sign-in link carries no redirect address, so codeg cannot complete it"
            .to_string()
    })?;
    if !is_loopback_redirect(&redirect) {
        return Err(
            "Antigravity's sign-in link points somewhere other than the loopback interface; \
             refusing to complete it"
                .to_string(),
        );
    }
    Ok(redirect)
}

/// One query parameter from a URL, percent-decoded.
fn query_param(url: &str, key: &str) -> Option<String> {
    let (_, query) = url.split_once('?')?;
    let query = query.split('#').next().unwrap_or(query);
    for pair in query.split('&') {
        let (name, value) = pair.split_once('=')?;
        if name == key {
            let decoded = percent_decode(value);
            return (!decoded.is_empty()).then_some(decoded);
        }
    }
    None
}

/// Percent-decode a query value, treating `+` as a space (the form encoding
/// `urllib.parse.parse_qs` on the other side expects).
fn percent_decode(raw: &str) -> String {
    let plus_decoded = raw.replace('+', " ");
    urlencoding::decode(&plus_decoded)
        .map(|decoded| decoded.into_owned())
        // Not valid percent-encoding: keep the literal text rather than losing
        // it. A code that survives this is still either accepted or rejected by
        // Google, which is the authority that matters.
        .unwrap_or(plus_decoded)
}

/// Where the agent will keep the credential this sign-in produces.
///
/// `None` whenever the answer would be a guess — the same conditions under which
/// [`crate::acp::connection::antigravity_acp_dir_for_runtime_env`] declines —
/// and also on macOS, where the default store is the login keychain and the file
/// is only a fallback (`credential_store.py::create_default_store`). Naming a
/// file that will not be written is worse than saying nothing.
fn credential_path_for(runtime_env: &BTreeMap<String, String>, method_id: &str) -> Option<PathBuf> {
    if uses_macos_keychain(runtime_env) {
        return None;
    }
    let file = match method_id {
        "oauth-business" => "acp_business_token.json",
        _ => "acp_token.json",
    };
    crate::acp::connection::antigravity_acp_dir_for_runtime_env(runtime_env)
        .ok()
        .map(|dir| dir.join(file))
}

/// Whether the agent will prefer the macOS keychain over the token file.
fn uses_macos_keychain(runtime_env: &BTreeMap<String, String>) -> bool {
    if !cfg!(target_os = "macos") {
        return false;
    }
    // `AGY_ACP_FORCE_FILE_STORAGE` accepts 1/true/yes, case-insensitively.
    !runtime_env
        .get("AGY_ACP_FORCE_FILE_STORAGE")
        .map(|value| value.trim().to_ascii_lowercase())
        .is_some_and(|value| matches!(value.as_str(), "1" | "true" | "yes"))
}

fn display_path(path: &Option<PathBuf>) -> Option<String> {
    path.as_ref().map(|p| p.display().to_string())
}

/// The already-installed Antigravity binary, resolved exactly as a launch would.
///
/// Never downloads: this runs from a settings-panel click, and a sign-in that
/// silently pulls a few hundred megabytes would be a surprise. The install
/// button next to it is the place for that.
fn resolve_binary() -> Result<PathBuf, AcpError> {
    let meta = registry::get_agent_meta(AgentType::Antigravity);
    let AgentDistribution::Binary { cmd, platforms, .. } = meta.distribution else {
        return Err(AcpError::protocol(
            "Antigravity is not a binary agent in this build",
        ));
    };
    let platform = registry::current_platform();
    if !platforms.iter().any(|p| p.platform == platform) {
        return Err(AcpError::PlatformNotSupported(format!(
            "{} is not available on {platform}",
            meta.name
        )));
    }
    if let Some((path, version)) =
        crate::acp::binary_cache::find_best_cached_binary_for_agent(AgentType::Antigravity, cmd)?
    {
        tracing::info!("[ACP][Antigravity] sign-in using cached binary {version}");
        return Ok(path);
    }
    crate::commands::acp::resolve_system_agent_binary(cmd).ok_or_else(|| {
        AcpError::SdkNotInstalled(format!(
            "{} is not installed. Please install it in Agent Settings.",
            meta.name
        ))
    })
}

/// The launch flags the registry pins for this platform.
fn antigravity_launch_args() -> Vec<String> {
    match registry::get_agent_meta(AgentType::Antigravity).distribution {
        AgentDistribution::Binary { args, .. } => args.iter().map(|a| (*a).to_string()).collect(),
        _ => Vec::new(),
    }
}

/// An executable that accepts a URL and does nothing, if this platform has one.
fn noop_browser() -> Option<String> {
    #[cfg(unix)]
    {
        // CPython's `BROWSER` handling registers a bare path as a
        // `GenericBrowser` and runs it as `[path, url]`, so any argument-
        // tolerant no-op works. `true` is in the POSIX toolset; the two paths
        // cover every distribution and macOS.
        for candidate in ["/usr/bin/true", "/bin/true"] {
            if std::path::Path::new(candidate).exists() {
                return Some(candidate.to_string());
            }
        }
        None
    }
    // Windows has no equivalent single-file no-op, and a machine running the
    // Windows build has a browser anyway — leaving `BROWSER` alone there means
    // the real one opens, which is the better outcome.
    #[cfg(not(unix))]
    {
        None
    }
}

async fn write_frame(
    stdin: &mut tokio::process::ChildStdin,
    frame: &serde_json::Value,
) -> Result<(), AcpError> {
    let mut line = serde_json::to_string(frame).map_err(|e| AcpError::protocol(e.to_string()))?;
    line.push('\n');
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| AcpError::protocol(format!("could not talk to Antigravity: {e}")))?;
    stdin
        .flush()
        .await
        .map_err(|e| AcpError::protocol(format!("could not talk to Antigravity: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    /// A stand-in for a real attempt: the slot lifecycle cares about the
    /// handle, the generation and whether the child gets reaped, none of which
    /// need an actual agent. `cat` is the cheapest process that stays alive on
    /// a piped stdin and closes its stdout the instant it dies.
    #[cfg(unix)]
    async fn fake_pending(handle: &str) -> (Box<Pending>, tokio::process::ChildStdout) {
        let mut child = tokio::process::Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .expect("spawn /bin/cat");
        let stdin = child.stdin.take().expect("stdin");
        let stdout = child.stdout.take().expect("stdout");
        let (_tx, responses) = mpsc::unbounded_channel();
        // `_tx` is dropped here on purpose: nothing in these tests waits on a
        // response, and a closed channel is the honest shape for a dead agent.
        let pending = Box::new(Pending {
            handle: handle.to_string(),
            method_id: "oauth-personal".to_string(),
            redirect_uri: "http://127.0.0.1:1/".to_string(),
            state: "st".to_string(),
            credential_path: None,
            child: HelperChild::new(child),
            _stdin: stdin,
            responses,
            stderr: Arc::new(StderrTail::new()),
            scratch: None,
            started: Instant::now(),
        });
        (pending, stdout)
    }

    /// Asserts the process behind `stdout` is gone. A killed `cat` closes it; a
    /// live one leaves the read pending, so the timeout is the failure.
    #[cfg(unix)]
    async fn assert_reaped(mut stdout: tokio::process::ChildStdout, what: &str) {
        use tokio::io::AsyncReadExt;
        let mut buf = [0u8; 1];
        let read = tokio::time::timeout(Duration::from_secs(5), stdout.read(&mut buf)).await;
        match read {
            Ok(Ok(0)) => {}
            other => panic!("{what} was not reaped: {other:?}"),
        }
    }

    /// One test, not six: the slot is process-global, and cargo runs tests on
    /// parallel threads — separate cases would fight over it.
    ///
    /// The invariant under test is "one sign-in at a time", and the reason it
    /// needs a state machine rather than an `Option` is that both slow stretches
    /// happen outside the lock. A slow older `start` reaching the install point
    /// late must reap ITSELF rather than kill the link already on screen, and a
    /// `start` arriving mid-completion must be refused rather than put a second
    /// agent on the same credential file.
    #[cfg(unix)]
    #[tokio::test]
    async fn the_slot_admits_exactly_one_sign_in() {
        let first = claim_slot().await.expect("idle slot is claimable");
        let (p1, out1) = fake_pending("h1").await;
        assert!(install(first, p1).await.is_ok());

        // A second start displaces the published attempt AND reaps its child —
        // otherwise that agent holds its loopback listener for 300s.
        let second = claim_slot().await.expect("a published attempt is displaceable");
        assert!(second > first);
        assert_reaped(out1, "the displaced attempt").await;

        // The older start finally finishes its handshake. It must NOT take the
        // slot back: the user is looking at the newer link.
        let (stale, out_stale) = fake_pending("h-stale").await;
        let returned = install(first, stale)
            .await
            .expect_err("a stale generation must not install");
        returned.kill().await;
        assert_reaped(out_stale, "the stale attempt").await;

        let (p2, out2) = fake_pending("h2").await;
        assert!(install(second, p2).await.is_ok());

        // Cancelling something that is not the current attempt leaves the
        // current one alone.
        assert!(cancel("h-stale").await.is_err());

        // Mid-completion, a new start is refused rather than racing the
        // credential write.
        {
            let mut slot = pending_slot().lock().await;
            let taken = take_waiting(&mut slot);
            slot.state = SlotState::Finishing {
                until: Instant::now() + FINISH_BUDGET,
            };
            drop(slot);
            taken.kill().await;
        }
        assert_reaped(out2, "the completing attempt").await;
        assert!(
            claim_slot().await.is_err(),
            "a start during completion must be refused"
        );

        // ...but only until the budget runs out. Without that expiry a dropped
        // `finish` future (a disconnected web client) would wedge every later
        // sign-in for the life of the process.
        pending_slot().lock().await.state = SlotState::Finishing {
            until: Instant::now() - Duration::from_secs(1),
        };
        let third = claim_slot().await.expect("an expired completion releases");

        // A failure arriving late releases only its OWN generation.
        abandon_start(third - 1).await;
        assert!(
            matches!(pending_slot().lock().await.state, SlotState::Starting),
            "a stale abandon must not release a newer start"
        );
        abandon_start(third).await;
        assert!(matches!(
            pending_slot().lock().await.state,
            SlotState::Idle
        ));

        // And `release_finishing` is a no-op unless the slot is actually
        // completing, so a late one cannot cancel a fresh start.
        let fourth = claim_slot().await.expect("idle again");
        release_finishing(fourth).await;
        assert!(matches!(
            pending_slot().lock().await.state,
            SlotState::Starting
        ));

        // The sharp version of the same point, and the reason the release is
        // generation-scoped: attempt A's completion outlives its budget, B
        // takes over and reaches its OWN completion, and only then does A's
        // cleanup arrive. Clearing on state alone would mark B idle mid
        // credential-write — precisely the overlap `Finishing` exists to stop.
        let attempt_a = fourth;
        pending_slot().lock().await.state = SlotState::Finishing {
            until: Instant::now() - Duration::from_secs(1),
        };
        let attempt_b = claim_slot().await.expect("an expired completion releases");
        pending_slot().lock().await.state = SlotState::Finishing {
            until: Instant::now() + FINISH_BUDGET,
        };
        release_finishing(attempt_a).await;
        assert!(
            matches!(
                pending_slot().lock().await.state,
                SlotState::Finishing { .. }
            ),
            "a late release must not end a newer completion"
        );
        assert!(
            claim_slot().await.is_err(),
            "and the newer completion must still be exclusive"
        );

        release_finishing(attempt_b).await;
        assert!(matches!(
            pending_slot().lock().await.state,
            SlotState::Idle
        ));

        // A sign-out takes the same exclusive state, and takes it in ONE lock
        // acquisition. It is about to erase the credential from the moment it
        // is granted, so unlike a `start` there is no window in which another
        // agent may be put on the same store — and any link already on screen
        // belongs to a sign-in the user has just abandoned, so it is displaced
        // and its child reaped.
        let before_sign_out = claim_slot().await.expect("idle again");
        let (p3, out3) = fake_pending("h3").await;
        assert!(install(before_sign_out, p3).await.is_ok());
        let sign_out = claim_slot_as(SlotState::Finishing {
            until: Instant::now() + SIGN_OUT_BUDGET,
        })
        .await
        .expect("a published attempt is displaceable by a sign-out");
        assert_reaped(out3, "the attempt a sign-out displaced").await;
        assert!(
            claim_slot().await.is_err(),
            "a sign-in during a sign-out must be refused"
        );
        release_finishing(sign_out).await;
        assert!(matches!(
            pending_slot().lock().await.state,
            SlotState::Idle
        ));
    }

    /// The protocol requires the check ("Clients MUST NOT call `logout` unless
    /// this is advertised"), and without it an Antigravity too old to sign out
    /// answers `-32601` instead of saying so.
    #[test]
    fn reads_the_logout_capability_out_of_the_handshake() {
        let advertised = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "protocolVersion": 1,
                "agentCapabilities": { "loadSession": true, "auth": { "logout": {} } },
            },
        });
        assert!(advertises_logout(&advertised));

        // An older build: same handshake, no `auth` block at all.
        let older = serde_json::json!({
            "id": 1,
            "result": { "agentCapabilities": { "loadSession": true } },
        });
        assert!(!advertises_logout(&older));
        // An `auth` block that offers other things but not this one.
        let no_logout = serde_json::json!({
            "id": 1,
            "result": { "agentCapabilities": { "auth": {} } },
        });
        assert!(!advertises_logout(&no_logout));
        // Present-but-null is the same as absent: `pointer` finds a value
        // either way, so the emptiness has to be tested separately.
        let nulled = serde_json::json!({
            "id": 1,
            "result": { "agentCapabilities": { "auth": { "logout": null } } },
        });
        assert!(!advertises_logout(&nulled));
    }

    #[test]
    fn finds_the_url_in_the_agents_prompt_line() {
        let line = "Open the following link to authenticate the ACP server: \
                    https://accounts.google.com/o/oauth2/v2/auth?state=abc&redirect_uri=x";
        assert_eq!(
            find_auth_url(line).as_deref(),
            Some("https://accounts.google.com/o/oauth2/v2/auth?state=abc&redirect_uri=x")
        );
    }

    /// The prompt shares a file descriptor with the JSON-RPC stream, so a frame
    /// can be spliced onto the same line. Both halves must still be recovered.
    #[test]
    fn finds_the_url_when_a_json_frame_shares_the_line() {
        let line = "Open the following link to authenticate the ACP server: https://accounts.google.com/x?state=s \
                    {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{}}";
        assert_eq!(
            find_auth_url(line).as_deref(),
            Some("https://accounts.google.com/x?state=s")
        );
        let json_start = line.find('{').unwrap();
        let value: serde_json::Value = serde_json::from_str(&line[json_start..]).unwrap();
        assert_eq!(value.get("id").and_then(|v| v.as_i64()), Some(2));
    }

    #[test]
    fn ignores_unrelated_stdout_lines() {
        assert_eq!(find_auth_url("INFO starting the ACP server"), None);
        assert_eq!(
            find_auth_url("Open the following link to authenticate the ACP server: ftp://x"),
            None
        );
    }

    /// The regression that made "Get sign-in link" spin for the full 90s and
    /// then claim the agent produced no link: 1.1.1 moved the prompt from
    /// stdout to stderr, and only stdout was scanned. Both PUMPS are driven
    /// here, not just the sink — the sink was never the broken part.
    #[tokio::test]
    async fn either_pump_delivers_the_sign_in_link() {
        const URL: &str = "https://accounts.google.com/o/oauth2/v2/auth?state=s1";
        let prompt = format!("{AUTH_PROMPT_MARKER}{URL}");

        // stderr: where 1.1.1 prints it, interleaved with the absl log lines
        // that share the stream.
        let (sink, rx) = AuthUrlSink::new();
        let tail = Arc::new(StderrTail::new());
        let stderr = format!(
            "I0909 08:14:14.490210 credential_manager.py:553] Launching browser login flow\n\
             {prompt}\n"
        );
        read_agent_stderr(Cursor::new(stderr.into_bytes()), Arc::clone(&tail), sink).await;
        assert_eq!(rx.await.expect("a link on stderr must reach the sink"), URL);

        // stdout: where 1.0.0 printed it. Still scanned, because a user may pin
        // that version — and the JSON frames sharing the stream must survive.
        let (sink, rx) = AuthUrlSink::new();
        let (tx, mut responses) = mpsc::unbounded_channel();
        let stdout = format!("{prompt}\n{{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{{}}}}\n");
        read_agent_stdout(Cursor::new(stdout.into_bytes()), tx, sink).await;
        assert_eq!(rx.await.expect("a link on stdout must reach the sink"), URL);
        assert_eq!(
            responses
                .recv()
                .await
                .and_then(|m| m.get("id").and_then(serde_json::Value::as_i64)),
            Some(2),
            "the protocol frames must still be parsed"
        );
    }

    /// Two pumps, one channel: whoever matches first wins and the other's offer
    /// is inert. Without this a build that printed the prompt to BOTH streams
    /// would panic or lose the link on the second send.
    #[tokio::test]
    async fn the_first_stream_to_see_the_link_wins() {
        let (sink, rx) = AuthUrlSink::new();
        let other = sink.clone();
        sink.offer(
            "Open the following link to authenticate the ACP server: https://example.test/a?state=1",
        );
        other.offer(
            "Open the following link to authenticate the ACP server: https://example.test/b?state=2",
        );
        // And a line that carries no prompt never claims the channel.
        other.offer("I0909 08:14:14.317436 server.py:2390] Authenticate called");
        assert_eq!(rx.await.unwrap(), "https://example.test/a?state=1");
    }

    /// `start_claimed` reads a closed channel as `StartSignal::Gone`, so the
    /// sink must not survive its pumps — a clone parked anywhere else would
    /// turn a dead child into a silent 90s wait.
    #[tokio::test]
    async fn dropping_both_pumps_closes_the_channel() {
        let (sink, mut rx) = AuthUrlSink::new();
        let other = sink.clone();
        drop(sink);
        assert!(
            tokio::time::timeout(Duration::from_millis(50), &mut rx)
                .await
                .is_err(),
            "one live pump must keep the channel open"
        );
        drop(other);
        assert!(rx.await.is_err(), "the last clone must close the channel");
    }

    /// The prompt line is the last thing on stderr when the URL scan misses, so
    /// an unfiltered hint would append a truncated consent URL to "no link was
    /// produced".
    #[test]
    fn the_stderr_hint_never_quotes_the_sign_in_link() {
        let tail = StderrTail::new();
        tail.push("I0909 08:14:14.490210 credential_manager.py:553] Launching browser login flow");
        tail.push(&format!(
            "{AUTH_PROMPT_MARKER}https://accounts.google.com/o/oauth2/v2/auth?state=s&code_challenge=x"
        ));
        let hint = stderr_hint(&tail);
        assert!(
            !hint.contains("accounts.google.com") && !hint.contains(AUTH_PROMPT_MARKER),
            "the hint leaked the link: {hint}"
        );
        assert!(
            hint.contains("Launching browser login flow"),
            "the real diagnostic must survive: {hint}"
        );

        // With nothing but the prompt to report, the hint is empty rather than
        // a dangling "Last output:".
        let only_prompt = StderrTail::new();
        only_prompt.push(&format!("{AUTH_PROMPT_MARKER}https://accounts.google.com/x"));
        assert_eq!(stderr_hint(&only_prompt), "");
    }

    #[test]
    fn reads_the_redirect_uri_out_of_the_auth_url() {
        let url = "https://accounts.google.com/o/oauth2/v2/auth?response_type=code\
                   &client_id=x.apps.googleusercontent.com\
                   &redirect_uri=http%3A%2F%2F127.0.0.1%3A54926%2F&state=Sx9";
        assert_eq!(
            extract_redirect_uri(url).unwrap(),
            "http://127.0.0.1:54926/"
        );
        assert_eq!(query_param(url, "state").as_deref(), Some("Sx9"));
    }

    #[test]
    fn refuses_an_auth_url_that_redirects_off_the_loopback() {
        let url = "https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fevil.example%2F";
        assert!(extract_redirect_uri(url).is_err());
    }

    /// The whole SSRF surface: whatever the user pastes, the request must go to
    /// the address codeg captured.
    #[test]
    fn the_request_target_ignores_the_pasted_host() {
        let parsed = ParsedRedirect::parse("http://evil.example/?code=4%2Fabc&state=good");
        let target = build_redirect_request("http://127.0.0.1:5100/", "good", &parsed).unwrap();
        assert!(
            target.starts_with("http://127.0.0.1:5100/?"),
            "target was {target}"
        );
        assert!(target.contains("code=4%2Fabc"));
        assert!(!target.contains("evil.example"));
    }

    #[test]
    fn refuses_to_contact_a_non_loopback_listener() {
        let parsed = ParsedRedirect::parse("?code=abc");
        assert!(build_redirect_request("http://evil.example/", "", &parsed).is_err());
        assert!(build_redirect_request("http://127.0.0.1.evil.example/", "", &parsed).is_err());
        assert!(build_redirect_request("https://127.0.0.1:80/", "", &parsed).is_err());
    }

    /// A userinfo trick (`127.0.0.1:80@host`) makes the real host the part after
    /// the `@`, so the port must be digits and nothing else.
    #[test]
    fn rejects_a_userinfo_disguised_authority() {
        assert!(!is_loopback_redirect("http://127.0.0.1:80@evil.example/"));
        assert!(!is_loopback_redirect("http://127.0.0.1:/"));
        assert!(is_loopback_redirect("http://127.0.0.1:54926/"));
    }

    #[test]
    fn parses_every_shape_a_user_might_paste() {
        let full = ParsedRedirect::parse(
            "http://127.0.0.1:5100/?state=st1&code=4%2F0AVGz&scope=openid+email",
        );
        assert_eq!(full.code.as_deref(), Some("4/0AVGz"));
        assert_eq!(full.state.as_deref(), Some("st1"));

        let query_only = ParsedRedirect::parse("state=st1&code=4%2F0AVGz");
        assert_eq!(query_only, full);

        let bare = ParsedRedirect::parse("  4/0AVGz  ");
        assert_eq!(bare.code.as_deref(), Some("4/0AVGz"));
        assert_eq!(bare.state, None);

        let denied = ParsedRedirect::parse("http://127.0.0.1:5100/?error=access_denied&state=st1");
        assert_eq!(denied.error.as_deref(), Some("access_denied"));
        assert_eq!(denied.code, None);

        assert_eq!(ParsedRedirect::parse("   "), ParsedRedirect::default());
    }

    /// A fragment is not part of the query; letting it through would append
    /// junk to the code.
    #[test]
    fn drops_a_url_fragment() {
        let parsed = ParsedRedirect::parse("http://127.0.0.1:5100/?code=abc#anchor");
        assert_eq!(parsed.code.as_deref(), Some("abc"));
    }

    /// The paste is checked before the attempt is spent, so these are the
    /// failures a user can fix by pasting again — no second trip through
    /// Google's consent screen.
    #[test]
    fn rejects_only_what_it_can_decide_without_the_agent() {
        let cases = [
            ("st1", "http://127.0.0.1:5100/?state=st1&code=abc", false),
            ("st1", "http://127.0.0.1:5100/?state=other&code=abc", true),
            ("st1", "http://127.0.0.1:5100/?state=st1", true),
            // A denial is a real answer and must reach the agent so it stops
            // waiting; rejecting it here would strand the child for 300 s.
            (
                "st1",
                "http://127.0.0.1:5100/?state=st1&error=access_denied",
                false,
            ),
            // A bare code carries no state to disagree with.
            ("st1", "4/0AVGz", false),
            ("st1", "   ", true),
        ];
        for (state, pasted, expect_rejected) in cases {
            let rejected = reject_locally(state, &ParsedRedirect::parse(pasted)).is_some();
            assert_eq!(rejected, expect_rejected, "for {pasted:?}");
        }
    }

    #[test]
    fn reads_the_agents_error_text_out_of_a_response() {
        let message = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 2,
            "error": {
                "code": -32000,
                "message": "Onboarding failed: ineligible",
                "data": { "reason": "onboarding_failed" },
            },
        });
        assert_eq!(
            error_message(&message).as_deref(),
            Some("Onboarding failed: ineligible")
        );
        // `data.message` wins when present: that is where auth_required puts
        // the long, actionable form.
        let with_data = serde_json::json!({
            "id": 2,
            "error": { "message": "short", "data": { "message": "the long actionable one" } },
        });
        assert_eq!(
            error_message(&with_data).as_deref(),
            Some("the long actionable one")
        );
        assert_eq!(error_message(&serde_json::json!({"id": 2, "result": {}})), None);
    }

    /// The agent's message is rendered in the panel, so it goes through the
    /// same redaction every other agent diagnostic does.
    #[test]
    fn redacts_a_credential_echoed_back_in_an_error() {
        let message = serde_json::json!({
            "id": 2,
            "error": { "message": "rejected api_key=sk-live-abcdefghijkl" },
        });
        let text = error_message(&message).unwrap();
        assert!(!text.contains("sk-live-abcdefghijkl"), "leaked in {text:?}");
    }

    #[test]
    fn credential_path_follows_gemini_home() {
        let mut env = BTreeMap::new();
        env.insert("GEMINI_HOME".to_string(), "/srv/gemini".to_string());
        env.insert("AGY_ACP_FORCE_FILE_STORAGE".to_string(), "1".to_string());
        assert_eq!(
            credential_path_for(&env, "oauth-personal"),
            Some(PathBuf::from("/srv/gemini/antigravity-acp/acp_token.json"))
        );
        assert_eq!(
            credential_path_for(&env, "oauth-business"),
            Some(PathBuf::from(
                "/srv/gemini/antigravity-acp/acp_business_token.json"
            ))
        );
    }

    /// On macOS the default backend is the keychain, so the file path would name
    /// something that never gets written.
    #[test]
    fn no_credential_path_when_the_keychain_owns_it() {
        let mut env = BTreeMap::new();
        env.insert("GEMINI_HOME".to_string(), "/srv/gemini".to_string());
        assert_eq!(
            credential_path_for(&env, "oauth-personal").is_none(),
            cfg!(target_os = "macos")
        );
    }
}
