//! Remote egress: how the browser tabs of a remote-workspace window reach the
//! remote host.
//!
//! A remote-workspace window shows a workspace that lives on another machine,
//! and the addresses its agents print (`localhost:3000`) are that machine's.
//! The page still renders here, in a webview of this computer — only its
//! network leaves from there. Each remote connection gets a browser profile
//! of its own whose proxy is a SOCKS5 listener on this computer's loopback;
//! every connection that profile makes is carried as one stream over a single
//! WebSocket to the remote codeg-server's tunnel (`web/browser_tunnel`), which
//! connects to the destination from its side. Nothing is rewritten on the
//! way: the tunnel moves bytes, so TLS, WebSockets and HTTP/2 are exactly what
//! they would be on the remote host.
//!
//! **The listener has no authentication.** Chromium (WebView2) does not do
//! SOCKS5 authentication at all, and tauri's proxy setting drops credentials
//! on Linux — a token could only ever protect the macOS side. It binds to
//! `127.0.0.1` on a port chosen at random, which keeps it off the network;
//! another account on this same computer could still use it to reach the
//! remote host's network, the same as any loopback port forward. Everything
//! it carries goes through the remote server's own token check.
//!
//! **The port never changes for a connection while the app runs**: WebView2
//! fixes a profile's proxy arguments for the life of the process, so a
//! listener that moved would leave that profile's tabs pointing at nothing.
//!
//! **The probe.** Whether an engine really sends a given address through its
//! proxy is not something every engine documents (WebKit sends `localhost`
//! straight to this machine whatever the proxy says). So before a profile's
//! first tab, a hidden page of that profile opens an address on this
//! listener's own port. Through the proxy, that arrives here as a SOCKS
//! request for this very port, and is answered locally; around the proxy, it
//! arrives as a plain HTTP request, which gives the bypass away at once.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use futures::future::BoxFuture;
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot, watch, Notify};
use tokio_tungstenite::tungstenite::http::HeaderMap;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use tokio_util::sync::CancellationToken;

use crate::web::browser_tunnel::frame::{CloseCode, Frame, TUNNEL_PROTOCOL};
use crate::web::browser_tunnel::pump::{pump, StreamEvent};

/// Longest an OPEN may wait for its answer. The server tries each address of
/// a name for up to 10 s, and `localhost` has two.
const OPEN_TIMEOUT: Duration = Duration::from_secs(25);

/// Longest the WebSocket handshake may take.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// After a failed connect, requests within this long fail at once instead of
/// hammering a server that just said no.
const RETRY_AFTER: Duration = Duration::from_secs(2);

/// Keeps the WebSocket alive through proxies that close idle connections.
const PING_EVERY: Duration = Duration::from_secs(20);

/// Nothing at all from the server for this long — its pongs to our pings
/// included — and the tunnel is taken for dead.
const SILENCE_LIMIT: Duration = Duration::from_secs(60);

/// Longest a SOCKS client may take over its greeting and request.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// Frames waiting for the WebSocket (see `web/browser_tunnel`).
const OUTGOING_QUEUE: usize = 256;

/// Path the probe page and its WebSocket live under, on the listener's port.
pub const PROBE_PATH: &str = "/codeg-egress-probe/";

// ─── SOCKS5 ─────────────────────────────────────────────────────────────

/// Where a SOCKS client wants to go.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SocksTarget {
    /// A DNS name or an IP literal (IPv6 without brackets).
    pub host: String,
    pub port: u16,
}

#[derive(Debug)]
enum SocksError {
    /// Not SOCKS at all: the first bytes of something else (a plain HTTP
    /// request from an engine that bypassed its proxy).
    NotSocks(Vec<u8>),
    /// SOCKS, but nothing this listener can do (another auth method, BIND,
    /// UDP); the client has been told.
    Unsupported,
    Io(std::io::Error),
}

impl From<std::io::Error> for SocksError {
    fn from(err: std::io::Error) -> Self {
        Self::Io(err)
    }
}

const SOCKS_VERSION: u8 = 5;
const NO_AUTH: u8 = 0x00;
const NO_ACCEPTABLE_METHOD: u8 = 0xff;
const CMD_CONNECT: u8 = 0x01;

/// SOCKS5 reply codes (RFC 1928 §6).
mod reply {
    pub const SUCCEEDED: u8 = 0x00;
    pub const GENERAL_FAILURE: u8 = 0x01;
    pub const NOT_ALLOWED: u8 = 0x02;
    pub const NETWORK_UNREACHABLE: u8 = 0x03;
    pub const HOST_UNREACHABLE: u8 = 0x04;
    pub const REFUSED: u8 = 0x05;
    pub const TTL_EXPIRED: u8 = 0x06;
    pub const COMMAND_NOT_SUPPORTED: u8 = 0x07;
    pub const ADDRESS_NOT_SUPPORTED: u8 = 0x08;
}

/// The reply that tells a SOCKS client how its CONNECT went. The bound
/// address means nothing through a tunnel, so it is all zeros.
fn socks_reply(code: u8) -> [u8; 10] {
    [SOCKS_VERSION, code, 0, 1, 0, 0, 0, 0, 0, 0]
}

/// How a stream the server could not open is reported to the page's engine,
/// which turns it into its own "refused" / "unreachable" error page.
fn reply_for(code: CloseCode) -> u8 {
    match code {
        CloseCode::Refused => reply::REFUSED,
        CloseCode::Unreachable => reply::HOST_UNREACHABLE,
        CloseCode::NotAllowed => reply::NOT_ALLOWED,
        CloseCode::Timeout => reply::TTL_EXPIRED,
        _ => reply::GENERAL_FAILURE,
    }
}

/// Why a connection did not reach its destination — what a tab's error page
/// says in place of the engine's word for a failed proxied connection, which
/// is no help: WebKit reports every SOCKS failure as "bad URL", whatever the
/// reply said.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamFailure {
    /// Nothing listens there on the remote host.
    Refused,
    /// The remote host has no route there, or the name does not resolve.
    Unreachable,
    /// The remote server's policy keeps the tunnel off that address.
    NotAllowed,
    Timeout,
    /// The tunnel itself is down.
    TunnelDown,
    Failed,
}

impl StreamFailure {
    fn from_close(code: CloseCode) -> Self {
        match code {
            CloseCode::Refused => Self::Refused,
            CloseCode::Unreachable => Self::Unreachable,
            CloseCode::NotAllowed => Self::NotAllowed,
            CloseCode::Timeout => Self::Timeout,
            _ => Self::Failed,
        }
    }
}

/// How long a failure stays on record: the engine reports the failed load
/// within moments of the reply.
const FAILURE_MEMORY: Duration = Duration::from_secs(10);

/// The most recent failures, newest last.
const FAILURES_KEPT: usize = 32;

/// Read a SOCKS5 greeting and CONNECT request, answering the greeting.
async fn socks_handshake<S>(conn: &mut S) -> Result<SocksTarget, SocksError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut head = [0u8; 2];
    conn.read_exact(&mut head).await?;
    if head[0] != SOCKS_VERSION {
        return Err(SocksError::NotSocks(head.to_vec()));
    }
    let mut methods = vec![0u8; head[1] as usize];
    conn.read_exact(&mut methods).await?;
    if !methods.contains(&NO_AUTH) {
        conn.write_all(&[SOCKS_VERSION, NO_ACCEPTABLE_METHOD]).await?;
        return Err(SocksError::Unsupported);
    }
    conn.write_all(&[SOCKS_VERSION, NO_AUTH]).await?;

    let mut request = [0u8; 4];
    conn.read_exact(&mut request).await?;
    if request[0] != SOCKS_VERSION {
        return Err(SocksError::Unsupported);
    }
    if request[1] != CMD_CONNECT {
        conn.write_all(&socks_reply(reply::COMMAND_NOT_SUPPORTED)).await?;
        return Err(SocksError::Unsupported);
    }
    let host = match request[3] {
        0x01 => {
            let mut ip = [0u8; 4];
            conn.read_exact(&mut ip).await?;
            std::net::Ipv4Addr::from(ip).to_string()
        }
        0x03 => {
            let mut len = [0u8; 1];
            conn.read_exact(&mut len).await?;
            let mut name = vec![0u8; len[0] as usize];
            conn.read_exact(&mut name).await?;
            match String::from_utf8(name) {
                Ok(name) if !name.is_empty() => name,
                _ => {
                    conn.write_all(&socks_reply(reply::ADDRESS_NOT_SUPPORTED)).await?;
                    return Err(SocksError::Unsupported);
                }
            }
        }
        0x04 => {
            let mut ip = [0u8; 16];
            conn.read_exact(&mut ip).await?;
            std::net::Ipv6Addr::from(ip).to_string()
        }
        _ => {
            conn.write_all(&socks_reply(reply::ADDRESS_NOT_SUPPORTED)).await?;
            return Err(SocksError::Unsupported);
        }
    };
    let mut port = [0u8; 2];
    conn.read_exact(&mut port).await?;
    Ok(SocksTarget { host, port: u16::from_be_bytes(port) })
}

// ─── Status ─────────────────────────────────────────────────────────────

/// Where a connection's egress stands, for the tabs that depend on it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum EgressStatus {
    /// Nothing has needed the tunnel yet.
    Idle,
    Connecting,
    Ready,
    /// The WebSocket dropped or could not be opened; the next connection a
    /// tab makes tries again.
    Down { reason: String },
    /// The remote codeg-server has no tunnel (an older version).
    Unsupported,
    /// The remote codeg-server's tunnel is switched off.
    Disabled,
}

/// Where the tunnel is and how to get in: re-read before every connect, so a
/// token changed in the connection settings is used from the next one on.
pub struct TunnelTarget {
    pub ws_url: String,
    pub token: String,
    pub headers: HeaderMap,
}

pub type TargetLoader =
    Arc<dyn Fn() -> BoxFuture<'static, Result<TunnelTarget, String>> + Send + Sync>;

// ─── Probe ──────────────────────────────────────────────────────────────

/// What a probe page did, by nonce.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ProbeVisit {
    /// The page arrived through the proxy.
    pub page: bool,
    /// Its WebSocket did too.
    pub websocket: bool,
    /// Something of it came straight here, around the proxy.
    pub bypassed: bool,
}

/// What the probe concluded about a listener's profile, once it has
/// concluded anything for good. (A probe that saw nothing at all — the page
/// never loaded — concludes nothing, and the next tab tries again.)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeVerdict {
    /// Everything the probe page did came through the proxy.
    Proxied,
    /// Something went around it: this engine would send the remote host's
    /// addresses to this computer, and stays that way for the run.
    Bypassed,
}

#[derive(Default)]
struct ProbeBook {
    visits: Mutex<HashMap<String, ProbeVisit>>,
    changed: Notify,
}

impl ProbeBook {
    fn note(&self, nonce: &str, update: impl FnOnce(&mut ProbeVisit)) {
        {
            let mut visits = self.visits.lock().unwrap_or_else(|e| e.into_inner());
            update(visits.entry(nonce.to_string()).or_default());
        }
        self.changed.notify_waiters();
    }

    fn get(&self, nonce: &str) -> ProbeVisit {
        self.visits
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(nonce)
            .copied()
            .unwrap_or_default()
    }
}

/// `localhost`, a `*.localhost` name, or a loopback address: a name for this
/// very machine, as the probe addresses the listener.
fn names_this_machine(host: &str) -> bool {
    let name = host.strip_suffix('.').unwrap_or(host).to_ascii_lowercase();
    if name == "localhost" || name.ends_with(".localhost") {
        return true;
    }
    name.parse::<std::net::IpAddr>()
        .is_ok_and(|ip| ip.to_canonical().is_loopback())
}

/// The nonce in a probe request's path, if it is one.
fn probe_nonce(path: &str) -> Option<&str> {
    let rest = path.strip_prefix(PROBE_PATH)?;
    let nonce = rest.split(['/', '?']).next()?;
    (!nonce.is_empty() && nonce.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
        .then_some(nonce)
}

/// The page a probe loads. It reports itself by arriving; then it addresses
/// this machine by literal loopback names, which have to come through the
/// proxy as well or not leave the page at all (on macOS the remote profile's
/// content rules stop them, WebKit sending them around any proxy); and only
/// once those have settled does it open a WebSocket back to its own host —
/// the last thing the probe waits for, so a bypass is on record before it.
fn probe_page(nonce: &str) -> String {
    format!(
        "<!doctype html><title>codeg egress probe</title><script>\
         const base = '{PROBE_PATH}{nonce}';\
         const direct = ['127.0.0.1', 'localhost'].map((host) =>\
         fetch('http://' + host + ':' + location.port + base + '/direct',\
         {{ mode: 'no-cors', cache: 'no-store' }}));\
         Promise.allSettled(direct).then(() => new WebSocket(\
         (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + base + '/ws'));\
         </script>"
    )
}

// ─── The tunnel session ─────────────────────────────────────────────────

struct Slot {
    events: mpsc::UnboundedSender<StreamEvent>,
    /// Waiting for the server's answer to the OPEN.
    opened: Option<oneshot::Sender<Result<(), (CloseCode, String)>>>,
}

/// One WebSocket to the remote tunnel and the streams it carries.
struct Session {
    frames: mpsc::Sender<Frame>,
    streams: Mutex<HashMap<u32, Slot>>,
    next_id: AtomicU32,
    closed: CancellationToken,
}

impl Session {
    fn is_open(&self) -> bool {
        !self.closed.is_cancelled()
    }

    fn forget(&self, id: u32) {
        self.streams.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    }

    /// Route a frame from the server to its stream.
    fn dispatch(&self, frame: Frame) {
        let id = frame.stream();
        let mut streams = self.streams.lock().unwrap_or_else(|e| e.into_inner());
        let Some(slot) = streams.get_mut(&id) else {
            // A stream that already ended here; late frames mean nothing.
            return;
        };
        match frame {
            Frame::Opened { .. } => {
                if let Some(opened) = slot.opened.take() {
                    let _ = opened.send(Ok(()));
                }
            }
            Frame::Close { code, message, .. } if slot.opened.is_some() => {
                if let Some(opened) = slot.opened.take() {
                    let _ = opened.send(Err((code, message)));
                }
                streams.remove(&id);
            }
            frame => {
                if let Some(event) = StreamEvent::from_frame(frame) {
                    let _ = slot.events.send(event);
                }
            }
        }
    }

    /// Everything still waiting learns the session is gone; open streams see
    /// their event channel close and let their connection go.
    fn shut(&self) {
        self.closed.cancel();
        let slots: Vec<Slot> = self
            .streams
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain()
            .map(|(_, slot)| slot)
            .collect();
        for mut slot in slots {
            if let Some(opened) = slot.opened.take() {
                let _ = opened.send(Err((CloseCode::Failed, "the tunnel closed".into())));
            }
        }
    }
}

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn run_session(socket: Socket, session: Arc<Session>, mut outgoing: mpsc::Receiver<Frame>) {
    let (mut sink, mut incoming) = socket.split();
    let closed = session.closed.clone();
    let writer = tokio::spawn(async move {
        let mut ping = tokio::time::interval(PING_EVERY);
        ping.tick().await;
        loop {
            tokio::select! {
                _ = closed.cancelled() => break,
                frame = outgoing.recv() => {
                    let Some(frame) = frame else { break };
                    if sink.send(Message::Binary(frame.encode().into())).await.is_err() {
                        break;
                    }
                }
                _ = ping.tick() => {
                    if sink.send(Message::Ping(Vec::new().into())).await.is_err() {
                        break;
                    }
                }
            }
        }
        let _ = sink.close().await;
        // A writer that can no longer send ends the session: a tunnel that
        // can only listen carries nothing.
        closed.cancel();
    });
    loop {
        let message = tokio::select! {
            _ = session.closed.cancelled() => break,
            // Silence for this long, pings included, is a path that drops
            // packets without saying so.
            message = tokio::time::timeout(SILENCE_LIMIT, incoming.next()) => match message {
                Ok(Some(message)) => message,
                Ok(None) => break,
                Err(_) => {
                    tracing::debug!("[browser-egress] the tunnel went silent; closing it");
                    break;
                }
            },
        };
        match message {
            Ok(Message::Binary(bytes)) => match Frame::decode(&bytes) {
                Ok(frame) => session.dispatch(frame),
                Err(err) => {
                    tracing::debug!("[browser-egress] {err}; closing the tunnel");
                    break;
                }
            },
            Ok(Message::Close(_)) | Err(_) => break,
            Ok(_) => {}
        }
    }
    session.shut();
    writer.abort();
}

// ─── Egress ─────────────────────────────────────────────────────────────

/// The egress of one remote connection: its SOCKS listener, and the tunnel
/// behind it.
pub struct Egress {
    socks_addr: SocketAddr,
    loader: TargetLoader,
    status: watch::Sender<EgressStatus>,
    session: tokio::sync::Mutex<Option<Arc<Session>>>,
    last_failure: Mutex<Option<(Instant, EgressStatus)>>,
    probes: ProbeBook,
    verdict: tokio::sync::Mutex<Option<ProbeVerdict>>,
    /// Somebody has taken on reporting `status` (see `claim_reporting`).
    reported: std::sync::atomic::AtomicBool,
    failures: Mutex<std::collections::VecDeque<(Instant, SocksTarget, StreamFailure)>>,
    accept: tokio::task::AbortHandle,
}

impl Drop for Egress {
    fn drop(&mut self) {
        self.accept.abort();
    }
}

impl Egress {
    /// Bind the listener and start taking connections. The tunnel itself is
    /// opened by the first connection that needs it.
    pub async fn start(loader: TargetLoader) -> std::io::Result<Arc<Self>> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let socks_addr = listener.local_addr()?;
        let (status, _) = watch::channel(EgressStatus::Idle);
        let egress = Arc::new_cyclic(|weak: &Weak<Egress>| {
            let accept = tokio::spawn(accept_loop(listener, weak.clone())).abort_handle();
            Egress {
                socks_addr,
                loader,
                status,
                session: tokio::sync::Mutex::new(None),
                last_failure: Mutex::new(None),
                probes: ProbeBook::default(),
                verdict: tokio::sync::Mutex::new(None),
                reported: std::sync::atomic::AtomicBool::new(false),
                failures: Mutex::new(std::collections::VecDeque::new()),
                accept,
            }
        });
        Ok(egress)
    }

    /// `127.0.0.1:<port>` — what the profile's proxy points at.
    pub fn socks_addr(&self) -> SocketAddr {
        self.socks_addr
    }

    pub fn status(&self) -> EgressStatus {
        self.status.borrow().clone()
    }

    pub fn subscribe(&self) -> watch::Receiver<EgressStatus> {
        self.status.subscribe()
    }

    /// Close the tunnel now, whatever it carries; the next connection opens
    /// a new one and reads the target again — for a connection whose address
    /// or token was edited.
    pub async fn reset(&self) {
        // Under the session lock: a connect to the old address still in
        // flight finishes first, and what it leaves behind is cleared here
        // rather than surviving the reset.
        let mut current = self.session.lock().await;
        *self.last_failure.lock().unwrap_or_else(|e| e.into_inner()) = None;
        self.failures.lock().unwrap_or_else(|e| e.into_inner()).clear();
        if let Some(session) = current.take() {
            session.shut();
        }
    }

    /// Stop for good: the listener and the tunnel both — for a connection
    /// that was deleted. The port is not needed again: no tab of the profile
    /// is ever opened after this.
    pub async fn close(&self) {
        self.accept.abort();
        self.reset().await;
    }

    /// True for the first caller only: the one that forwards `subscribe`'s
    /// changes to whoever shows them, once for the listener's life.
    pub fn claim_reporting(&self) -> bool {
        !self.reported.swap(true, Ordering::SeqCst)
    }

    /// Open the tunnel now rather than on the first connection, so a tab can
    /// say at once whether the remote host is reachable.
    pub async fn connect(&self) -> Result<(), EgressStatus> {
        self.session().await.map(|_| ())
    }

    /// The probe page's address for `nonce` on host `host` (`localhost`, or
    /// the `*.localhost` alias WebKit is sent to).
    pub fn probe_url(&self, host: &str, nonce: &str) -> String {
        format!("http://{host}:{}{PROBE_PATH}{nonce}", self.socks_addr.port())
    }

    /// Wait until the probe `nonce` has proven the page and its WebSocket
    /// came through the proxy — or seen it bypass the proxy, or run out of
    /// time. What it saw either way.
    pub async fn await_probe(&self, nonce: &str, timeout: Duration) -> ProbeVisit {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let changed = self.probes.changed.notified();
            let visit = self.probes.get(nonce);
            if visit.bypassed || (visit.page && visit.websocket) {
                return visit;
            }
            if tokio::time::timeout_at(deadline, changed).await.is_err() {
                return self.probes.get(nonce);
            }
        }
    }

    /// The probe's verdict so far, held: whoever holds it runs the probe if
    /// there is none yet, and every other tab of the profile waits for the
    /// answer instead of probing too.
    pub async fn verdict(&self) -> tokio::sync::MutexGuard<'_, Option<ProbeVerdict>> {
        self.verdict.lock().await
    }

    /// Why the latest connection to `host:port` failed, if one did a moment
    /// ago. `host` as a URL has it (an IPv6 address in brackets or not).
    pub fn recent_failure(&self, host: &str, port: u16) -> Option<StreamFailure> {
        let host = host.trim_start_matches('[').trim_end_matches(']');
        let failures = self.failures.lock().unwrap_or_else(|e| e.into_inner());
        failures
            .iter()
            .rev()
            .take_while(|(at, _, _)| at.elapsed() < FAILURE_MEMORY)
            .find(|(_, target, _)| target.port == port && target.host.eq_ignore_ascii_case(host))
            .map(|(_, _, failure)| *failure)
    }

    fn clear_failure(&self, target: &SocksTarget) {
        self.failures
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|(_, failed, _)| failed != target);
    }

    fn note_failure(&self, target: &SocksTarget, failure: StreamFailure) {
        let mut failures = self.failures.lock().unwrap_or_else(|e| e.into_inner());
        if failures.len() == FAILURES_KEPT {
            failures.pop_front();
        }
        failures.push_back((Instant::now(), target.clone(), failure));
    }

    async fn session(&self) -> Result<Arc<Session>, EgressStatus> {
        let mut current = self.session.lock().await;
        if let Some(session) = current.as_ref().filter(|s| s.is_open()) {
            return Ok(session.clone());
        }
        let recent_failure = self
            .last_failure
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .filter(|(at, _)| at.elapsed() < RETRY_AFTER)
            .map(|(_, status)| status.clone());
        if let Some(status) = recent_failure {
            return Err(status);
        }
        self.status.send_replace(EgressStatus::Connecting);
        match self.open_socket().await {
            Ok(socket) => {
                let (frames, outgoing) = mpsc::channel(OUTGOING_QUEUE);
                let session = Arc::new(Session {
                    frames,
                    streams: Mutex::new(HashMap::new()),
                    next_id: AtomicU32::new(1),
                    closed: CancellationToken::new(),
                });
                *self.last_failure.lock().unwrap_or_else(|e| e.into_inner()) = None;
                // Ready before the session runs: one that dies at once must
                // leave `Down` behind, not be painted over with `Ready`.
                self.status.send_replace(EgressStatus::Ready);
                let status = self.status.clone();
                let watched = session.clone();
                tokio::spawn(async move {
                    run_session(socket, watched, outgoing).await;
                    status.send_replace(EgressStatus::Down {
                        reason: "the tunnel closed".into(),
                    });
                });
                *current = Some(session.clone());
                Ok(session)
            }
            Err(status) => {
                *self.last_failure.lock().unwrap_or_else(|e| e.into_inner()) =
                    Some((Instant::now(), status.clone()));
                self.status.send_replace(status.clone());
                Err(status)
            }
        }
    }

    async fn open_socket(&self) -> Result<Socket, EgressStatus> {
        let down = |reason: String| EgressStatus::Down { reason };
        let target = (self.loader)().await.map_err(down)?;
        let request = crate::commands::remote_proxy::ws_request_with_subprotocol_auth(
            &target.ws_url,
            TUNNEL_PROTOCOL,
            &target.token,
            &target.headers,
        )
        .map_err(down)?;
        match tokio::time::timeout(CONNECT_TIMEOUT, tokio_tungstenite::connect_async(request)).await {
            Ok(Ok((socket, _))) => Ok(socket),
            Ok(Err(WsError::Http(response))) => Err(match response.status().as_u16() {
                // An older server has no such route: a 404, or — where it
                // serves the web app — the app's page from its fallback with
                // a 200. The tunnel itself answers 101 or refuses.
                404 | 200..=299 => EgressStatus::Unsupported,
                403 => EgressStatus::Disabled,
                401 => down("the remote server refused the token".into()),
                status => down(format!("the remote server answered {status}")),
            }),
            Ok(Err(err)) => Err(down(err.to_string())),
            Err(_) => Err(down("the remote server did not answer in time".into())),
        }
    }

    async fn serve(self: Arc<Self>, mut conn: TcpStream) {
        let _ = conn.set_nodelay(true);
        let Ok(handshake) = tokio::time::timeout(HANDSHAKE_TIMEOUT, socks_handshake(&mut conn)).await else {
            return;
        };
        let target = match handshake {
            Ok(target) => target,
            Err(SocksError::NotSocks(first)) => {
                self.serve_bypassed(conn, first).await;
                return;
            }
            Err(SocksError::Unsupported) => return,
            Err(SocksError::Io(err)) => {
                tracing::trace!("[browser-egress] SOCKS handshake failed: {err}");
                return;
            }
        };
        if self.is_own(&target) {
            self.serve_probe(conn).await;
            return;
        }
        let session = match self.session().await {
            Ok(session) => session,
            Err(_) => {
                self.note_failure(&target, StreamFailure::TunnelDown);
                let _ = conn.write_all(&socks_reply(reply::NETWORK_UNREACHABLE)).await;
                return;
            }
        };
        let id = session.next_id.fetch_add(1, Ordering::Relaxed);
        let Some(open) = Frame::open(id, &target.host, target.port) else {
            let _ = conn.write_all(&socks_reply(reply::ADDRESS_NOT_SUPPORTED)).await;
            return;
        };
        let (events_tx, events) = mpsc::unbounded_channel();
        let (opened_tx, opened) = oneshot::channel();
        {
            let mut streams = session.streams.lock().unwrap_or_else(|e| e.into_inner());
            // Checked under the lock `shut` drains the table under: a slot
            // put in after that would wait out the whole OPEN timeout.
            if !session.is_open() {
                drop(streams);
                self.note_failure(&target, StreamFailure::TunnelDown);
                let _ = conn.write_all(&socks_reply(reply::NETWORK_UNREACHABLE)).await;
                return;
            }
            streams.insert(id, Slot { events: events_tx, opened: Some(opened_tx) });
        }
        if session.frames.send(open).await.is_err() {
            session.forget(id);
            self.note_failure(&target, StreamFailure::TunnelDown);
            let _ = conn.write_all(&socks_reply(reply::NETWORK_UNREACHABLE)).await;
            return;
        }
        match tokio::time::timeout(OPEN_TIMEOUT, opened).await {
            Ok(Ok(Ok(()))) => {
                // What went wrong before at this destination is over.
                self.clear_failure(&target);
                if conn.write_all(&socks_reply(reply::SUCCEEDED)).await.is_err() {
                    let _ = session
                        .frames
                        .send(Frame::Close { stream: id, code: CloseCode::Normal, message: String::new() })
                        .await;
                    session.forget(id);
                    return;
                }
                let end = pump(conn, id, events, session.frames.clone()).await;
                tracing::trace!("[browser-egress] stream {id} ended: {end:?}");
                session.forget(id);
            }
            Ok(Ok(Err((code, message)))) => {
                tracing::debug!(
                    "[browser-egress] {}:{} not opened: {message}",
                    target.host,
                    target.port
                );
                // A tunnel that closed under the OPEN says `Failed`; that is
                // the tunnel's failure, not the destination's.
                let failure = if session.is_open() {
                    StreamFailure::from_close(code)
                } else {
                    StreamFailure::TunnelDown
                };
                self.note_failure(&target, failure);
                let _ = conn.write_all(&socks_reply(reply_for(code))).await;
            }
            // The session went away while the OPEN was out.
            Ok(Err(_)) => {
                self.note_failure(&target, StreamFailure::TunnelDown);
                let _ = conn.write_all(&socks_reply(reply::NETWORK_UNREACHABLE)).await;
            }
            Err(_) => {
                self.note_failure(&target, StreamFailure::Timeout);
                let _ = session
                    .frames
                    .send(Frame::Close { stream: id, code: CloseCode::Timeout, message: String::new() })
                    .await;
                session.forget(id);
                let _ = conn.write_all(&socks_reply(reply::TTL_EXPIRED)).await;
            }
        }
    }

    /// A CONNECT addressed to this very listener: the probe (see the module
    /// docs). Never forwarded — the remote host's port of the same number
    /// is somebody else's.
    fn is_own(&self, target: &SocksTarget) -> bool {
        target.port == self.socks_addr.port() && names_this_machine(&target.host)
    }

    async fn serve_probe(&self, mut conn: TcpStream) {
        if conn.write_all(&socks_reply(reply::SUCCEEDED)).await.is_err() {
            return;
        }
        let Some(head) = read_request_head(&mut conn, Vec::new()).await else {
            return;
        };
        tracing::debug!("[browser-egress] {} came through the proxy", head.path());
        let Some(nonce) = probe_nonce(head.path()).map(str::to_string) else {
            let _ = conn.write_all(b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n").await;
            return;
        };
        if let Some(key) = head.websocket_key() {
            self.probes.note(&nonce, |visit| visit.websocket = true);
            let accept = websocket_accept(&key);
            let _ = conn
                .write_all(
                    format!(
                        "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\n\
                         connection: Upgrade\r\nsec-websocket-accept: {accept}\r\n\r\n"
                    )
                    .as_bytes(),
                )
                .await;
            return;
        }
        self.probes.note(&nonce, |visit| visit.page = true);
        let body = probe_page(&nonce);
        let _ = conn
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: text/html; charset=utf-8\r\n\
                     cache-control: no-store\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            )
            .await;
    }

    /// A plain HTTP request straight to this port: an engine that went around
    /// its proxy. If it is a probe's, the probe has its answer.
    async fn serve_bypassed(&self, mut conn: TcpStream, first: Vec<u8>) {
        if let Some(head) = read_request_head(&mut conn, first).await {
            tracing::debug!("[browser-egress] {} came around the proxy", head.path());
            if let Some(nonce) = probe_nonce(head.path()) {
                self.probes.note(nonce, |visit| visit.bypassed = true);
            }
        }
        let _ = conn.write_all(b"HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n").await;
    }
}

async fn accept_loop(listener: TcpListener, egress: Weak<Egress>) {
    loop {
        let Ok((conn, _)) = listener.accept().await else {
            // Out of descriptors or the like: try again shortly.
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        };
        let Some(egress) = egress.upgrade() else { return };
        tokio::spawn(egress.serve(conn));
    }
}

/// An HTTP request's head, read up to the blank line.
struct RequestHead(String);

impl RequestHead {
    fn path(&self) -> &str {
        self.0.lines().next().and_then(|line| line.split(' ').nth(1)).unwrap_or("")
    }

    fn websocket_key(&self) -> Option<String> {
        let mut upgrade = false;
        let mut key = None;
        for line in self.0.lines().skip(1) {
            let Some((name, value)) = line.split_once(':') else { continue };
            let (name, value) = (name.trim().to_ascii_lowercase(), value.trim());
            if name == "upgrade" && value.eq_ignore_ascii_case("websocket") {
                upgrade = true;
            } else if name == "sec-websocket-key" {
                key = Some(value.to_string());
            }
        }
        key.filter(|_| upgrade)
    }
}

/// Read a request head (at most 8 KiB), starting from bytes already read.
async fn read_request_head(conn: &mut TcpStream, mut buf: Vec<u8>) -> Option<RequestHead> {
    const MAX_HEAD: usize = 8 * 1024;
    let mut chunk = [0u8; 1024];
    loop {
        if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            buf.truncate(end);
            return String::from_utf8(buf).ok().map(RequestHead);
        }
        if buf.len() > MAX_HEAD {
            return None;
        }
        let n = tokio::time::timeout(Duration::from_secs(5), conn.read(&mut chunk))
            .await
            .ok()?
            .ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

/// `Sec-WebSocket-Accept` for a `Sec-WebSocket-Key` (RFC 6455 §4.2.2).
fn websocket_accept(key: &str) -> String {
    use base64::Engine as _;
    use sha1::{Digest, Sha1};
    let mut hasher = Sha1::new();
    hasher.update(key.as_bytes());
    hasher.update(b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
    base64::engine::general_purpose::STANDARD.encode(hasher.finalize())
}

// ─── Registry ───────────────────────────────────────────────────────────

/// The egress of every remote connection that has needed one this run.
/// Kept for the life of the process (see the module docs on the port).
#[derive(Default)]
pub struct EgressRegistry {
    egresses: Mutex<HashMap<i32, Arc<Egress>>>,
    /// Held while a listener starts, so that the first two tabs of a
    /// connection start one between them.
    starting: tokio::sync::Mutex<()>,
}

impl EgressRegistry {
    /// The connection's egress, started the first time it is asked for.
    pub async fn ensure(
        &self,
        connection_id: i32,
        loader: impl FnOnce() -> TargetLoader,
    ) -> std::io::Result<Arc<Egress>> {
        if let Some(egress) = self.get(connection_id) {
            return Ok(egress);
        }
        let _starting = self.starting.lock().await;
        if let Some(egress) = self.get(connection_id) {
            return Ok(egress);
        }
        let egress = Egress::start(loader()).await?;
        self.egresses
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(connection_id, egress.clone());
        Ok(egress)
    }

    /// Take the connection's egress out of the registry (it was deleted).
    pub fn remove(&self, connection_id: i32) -> Option<Arc<Egress>> {
        self.egresses
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&connection_id)
    }

    pub fn get(&self, connection_id: i32) -> Option<Arc<Egress>> {
        self.egresses
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&connection_id)
            .cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::duplex;

    async fn handshake(bytes: &[u8]) -> (Result<SocksTarget, SocksError>, Vec<u8>) {
        let (mut client, mut server) = duplex(1024);
        client.write_all(bytes).await.unwrap();
        let result = socks_handshake(&mut server).await;
        drop(server);
        let mut answer = Vec::new();
        client.read_to_end(&mut answer).await.unwrap();
        (result, answer)
    }

    #[tokio::test]
    async fn a_connect_by_name_ipv4_or_ipv6_is_read() {
        let (target, answer) =
            handshake(&[5, 1, 0, 5, 1, 0, 3, 9, b'l', b'o', b'c', b'a', b'l', b'h', b'o', b's', b't', 0x0b, 0xb8]).await;
        assert_eq!(target.unwrap(), SocksTarget { host: "localhost".into(), port: 3000 });
        assert_eq!(answer, [5, 0], "only the greeting is answered here");

        let (target, _) = handshake(&[5, 1, 0, 5, 1, 0, 1, 127, 0, 0, 1, 0, 80]).await;
        assert_eq!(target.unwrap(), SocksTarget { host: "127.0.0.1".into(), port: 80 });

        let mut v6 = vec![5, 1, 0, 5, 1, 0, 4];
        v6.extend_from_slice(&std::net::Ipv6Addr::LOCALHOST.octets());
        v6.extend_from_slice(&[0x01, 0xbb]);
        let (target, _) = handshake(&v6).await;
        assert_eq!(target.unwrap(), SocksTarget { host: "::1".into(), port: 443 });
    }

    #[tokio::test]
    async fn what_this_listener_cannot_do_is_refused_in_socks_terms() {
        // Username/password only.
        let (result, answer) = handshake(&[5, 1, 2]).await;
        assert!(matches!(result, Err(SocksError::Unsupported)));
        assert_eq!(answer, [5, 0xff]);
        // BIND.
        let (result, answer) = handshake(&[5, 1, 0, 5, 2, 0, 1, 127, 0, 0, 1, 0, 80]).await;
        assert!(matches!(result, Err(SocksError::Unsupported)));
        assert_eq!(answer[2..4], [5, reply::COMMAND_NOT_SUPPORTED]);
        // Empty name.
        let (result, answer) = handshake(&[5, 1, 0, 5, 1, 0, 3, 0, 0, 80]).await;
        assert!(matches!(result, Err(SocksError::Unsupported)));
        assert_eq!(answer[2..4], [5, reply::ADDRESS_NOT_SUPPORTED]);
    }

    #[tokio::test]
    async fn plain_http_is_told_apart_from_socks() {
        let (result, _) = handshake(b"GET /x HTTP/1.1\r\n\r\n").await;
        let Err(SocksError::NotSocks(first)) = result else { panic!("read as SOCKS") };
        assert_eq!(first, b"GE");
    }

    #[test]
    fn close_codes_become_the_socks_replies_engines_understand() {
        assert_eq!(reply_for(CloseCode::Refused), reply::REFUSED);
        assert_eq!(reply_for(CloseCode::Unreachable), reply::HOST_UNREACHABLE);
        assert_eq!(reply_for(CloseCode::NotAllowed), reply::NOT_ALLOWED);
        assert_eq!(reply_for(CloseCode::Timeout), reply::TTL_EXPIRED);
        assert_eq!(reply_for(CloseCode::Failed), reply::GENERAL_FAILURE);
    }

    #[test]
    fn probe_paths_carry_a_plain_nonce_and_nothing_else() {
        assert_eq!(probe_nonce("/codeg-egress-probe/abc-123"), Some("abc-123"));
        assert_eq!(probe_nonce("/codeg-egress-probe/abc/ws"), Some("abc"));
        assert_eq!(probe_nonce("/codeg-egress-probe/abc?x=1"), Some("abc"));
        assert_eq!(probe_nonce("/codeg-egress-probe/"), None);
        assert_eq!(probe_nonce("/codeg-egress-probe/a%20b"), None);
        assert_eq!(probe_nonce("/other/abc"), None);
    }

    #[test]
    fn only_names_of_this_machine_address_the_listener_itself() {
        for own in ["localhost", "LOCALHOST.", "remote.localhost", "127.0.0.1", "::1", "::ffff:127.0.0.1"] {
            assert!(names_this_machine(own), "{own}");
        }
        for other in ["example.com", "localhost.example.com", "10.0.0.1", "0.0.0.0"] {
            assert!(!names_this_machine(other), "{other}");
        }
    }

    #[tokio::test]
    async fn a_failure_is_remembered_for_its_own_destination_only() {
        let egress = Egress::start(Arc::new(|| Box::pin(async { Err::<TunnelTarget, _>("unused".to_string()) })))
            .await
            .unwrap();
        let target = |host: &str, port| SocksTarget { host: host.into(), port };
        egress.note_failure(&target("remote.localhost", 3000), StreamFailure::Refused);
        egress.note_failure(&target("::1", 8080), StreamFailure::Timeout);
        assert_eq!(egress.recent_failure("remote.localhost", 3000), Some(StreamFailure::Refused));
        assert_eq!(egress.recent_failure("REMOTE.localhost", 3000), Some(StreamFailure::Refused));
        // A URL writes an IPv6 host in brackets; SOCKS does not.
        assert_eq!(egress.recent_failure("[::1]", 8080), Some(StreamFailure::Timeout));
        assert_eq!(egress.recent_failure("remote.localhost", 3001), None);
        assert_eq!(egress.recent_failure("localhost", 3000), None);
        // The newest word on a destination is the one that counts.
        egress.note_failure(&target("remote.localhost", 3000), StreamFailure::TunnelDown);
        assert_eq!(egress.recent_failure("remote.localhost", 3000), Some(StreamFailure::TunnelDown));
        // A connection that got through ends the story: a later failure of
        // the page is not this one.
        egress.clear_failure(&target("remote.localhost", 3000));
        assert_eq!(egress.recent_failure("remote.localhost", 3000), None);
        assert_eq!(egress.recent_failure("[::1]", 8080), Some(StreamFailure::Timeout));
    }

    #[test]
    fn the_websocket_accept_matches_rfc_6455() {
        // The worked example of RFC 6455 §1.3.
        assert_eq!(websocket_accept("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    }
}
