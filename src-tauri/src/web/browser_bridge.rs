//! Web-mode port bridge: shows a dev server that runs on the codeg host
//! inside the workbench when the workbench itself runs in a browser.
//!
//! In server / Docker deployments an agent's `http://localhost:3000` means the
//! *server's* loopback, which the user's browser cannot reach. The bridge
//! listens on extra ports next to codeg's own and forwards each of them to one
//! loopback port on the host, so the workbench can put the page in an iframe.
//!
//! ## One listener per target port — why not one shared listener
//!
//! A page served through a shared listener under a path prefix
//! (`/{cap}/{port}/…`) breaks as soon as it uses root-absolute URLs, which
//! every module-based dev server does (`/src/main.tsx`, `/_next/…`,
//! `/@vite/client`). Those requests arrive without the prefix and nothing in
//! them says which port they belong to: an iframe without `allow-same-origin`
//! runs in an opaque origin, which sends no `Referer` and attaches no cookies
//! to module scripts, `fetch` or XHR. Giving the frame `allow-same-origin`
//! would let two proxied pages read each other. So each target port gets its
//! own origin (its own bridge port), the frame may keep its origin, and the
//! page is served at `/` exactly as it would be on the host: no rewriting of
//! bodies, `history.pushState` routers work, HMR websockets connect.
//!
//! ## Authentication: a same-site cookie, not codeg's token
//!
//! An iframe navigation cannot carry a bearer header, and the page's own
//! requests must not carry codeg's token either. The workbench asks the API
//! (with the token) for a grant; the grant is a random capability tied to one
//! listener. The frame first loads the listener's entry URL carrying that
//! capability, which sets an `HttpOnly; SameSite=Lax` cookie named after the
//! bridge port and redirects to the page. Every later request — documents,
//! modules, fetch, websocket upgrades — carries the cookie: the bridge is a
//! different port on the same host as the workbench, which is the same *site*,
//! so browsers treat those cookies as first-party (including Safari). The
//! cookie is sent to codeg's own port too, where nothing reads cookies; the
//! workbench's own cookies (locale preferences) reach the bridge the same way
//! and are stripped before a request goes on to the dev server.
//!
//! Cookies ignore ports, so a page on one bridge port could make the browser
//! attach another listener's cookie to a request it sends there. Two things
//! keep the listeners apart: the entry answers with a small page that
//! navigates itself to the target (so the first document request, like every
//! request the page makes afterwards, is same-origin with the listener), and
//! every other request must be same-origin — `Sec-Fetch-Site: same-origin`
//! (or `none`, a navigation the user typed), or, where the browser sends no
//! Fetch Metadata (plain-http deployments: the headers only go to
//! trustworthy origins), an `Origin` or `Referer` naming the listener's own
//! authority. A request one proxied page aims at another listener is
//! `same-site`, or names the other page's authority, and is refused; a page
//! can drop its `Referer` but never claim another origin's.
//!
//! A capability stays valid for the life of its listener. A listener lives
//! while a workbench tab holds it, closes a minute after the last hold is
//! released, and closes after two hours without a request even when held (a
//! browser tab closed without notice); reopening the page mints a new grant.
//!
//! ## Addressing a target by hostname instead of by port
//!
//! One origin per target port does not have to mean one *port* per target.
//! `CODEG_BRIDGE_HOST_PATTERN` names the targets by hostname instead —
//! `3000.codeg.example.com` for port 3000 — and then the bridge binds nothing
//! of its own: those requests arrive on codeg's own listener, are recognised
//! by their `Host` before anything else looks at them, and are answered here
//! and nowhere else in codeg. A deployment publishes one port, and a reverse
//! proxy needs one wildcard vhost, instead of a range that has to be guessed
//! ahead of time. It is what GitHub Codespaces does
//! (`{codespace}-{port}.app.github.dev`) and what code-server's own docs
//! recommend over its sub-path proxy.
//!
//! Everything above still holds, and one part of it gets stronger: cookies
//! ignore ports but not hostnames, so a capability set on
//! `3000.codeg.example.com` is never sent to `3001.codeg.example.com` at all,
//! where between two bridge ports it was sent and then refused. The hostname
//! must be same-site with the workbench for the browser to send the cookie
//! into the frame at all, which a subdomain of the workbench's own host is by
//! construction — hence `auto`, and hence a template that should stay under
//! the same registrable domain.
//!
//! Sharing codeg's listener means codeg has to be sure which requests are
//! its own, and a hostname is not the bridge's because it looks like one:
//! `auto` describes `<port>.<anything>`, a shape that covers a workbench on
//! a numeric-leading hostname. So a request is a target's only when it names
//! a hostname codeg actually handed out for it (`Listener::hosts`), read
//! from every authority the request carries — a page can add a forwarded
//! header to a request of its own but cannot drop its `Host`. And a name
//! handed out stays the bridge's for the life of the process
//! (`Bridge::minted`), long after its target idles away: the browser's
//! memory of that origin — a service worker the page left behind — outlives
//! the target, and codeg's own pages must never be served through it.

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use axum::body::{Body, HttpBody};
use axum::extract::ws::{CloseFrame, Message as DownMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{FromRequestParts, Path as AxumPath, RawQuery, Request, State};
use axum::http::request::Parts;
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::CloseFrame as UpCloseFrame;
use tokio_tungstenite::tungstenite::Message as UpMessage;

/// Entry URL prefix on a bridge listener: `/__codeg_bridge/enter/{cap}?to=/path`.
pub const ENTER_PREFIX: &str = "/__codeg_bridge/enter/";
/// Unauthenticated reachability probe the workbench calls before showing
/// the frame, so an unmapped port is reported instead of a blank frame.
pub const PING_PATH: &str = "/__codeg_bridge/ping";
const COOKIE_PREFIX: &str = "codeg-bridge-";
/// The workbench's own cookies (locale preferences) live on the same host
/// and are not the dev server's business either.
const WORKBENCH_COOKIE_PREFIX: &str = "codeg.";
/// Ports above codeg's own that the bridge takes when `CODEG_BRIDGE_PORTS`
/// is not set.
pub const DEFAULT_POOL_SIZE: u16 = 10;
/// A listener nobody holds closes after this long without a request.
const UNHELD_IDLE: Duration = Duration::from_secs(60);
/// A held listener closes after this long without a request.
const HELD_IDLE: Duration = Duration::from_secs(2 * 60 * 60);
pub const SWEEP_INTERVAL: Duration = Duration::from_secs(30);
/// How long a closing listener waits for its connections before they are cut.
const CLOSE_GRACE: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BridgeConfig {
    /// Address the listeners bind to: the same one codeg's API listener uses.
    pub bind_host: String,
    /// Ports a listener may take, in order of preference; `0` means any free
    /// port (each listener its own). Empty when targets are addressed by
    /// hostname and nothing of our own is bound.
    pub ports: Vec<u16>,
    /// Hostname the browser should use for the bridge when it differs from
    /// the one the workbench was loaded from (a reverse proxy in front).
    pub public_host: Option<String>,
    /// Name the targets by hostname on codeg's own listener instead of giving
    /// each one a port of its own.
    pub host_pattern: Option<HostPattern>,
    /// Ports the bridge refuses to forward to: codeg's own listener.
    pub reserved: Vec<u16>,
}

impl BridgeConfig {
    /// Read `CODEG_BRIDGE_PORTS` / `CODEG_BRIDGE_HOST_PATTERN` /
    /// `CODEG_BRIDGE_PUBLIC_HOST`. `None` when the bridge is switched off
    /// (`CODEG_BRIDGE_PORTS=off`).
    pub fn from_env(bind_host: &str, codeg_port: u16) -> Option<Self> {
        let ports = std::env::var("CODEG_BRIDGE_PORTS").ok();
        let pattern = std::env::var("CODEG_BRIDGE_HOST_PATTERN").ok();
        let public_host = std::env::var("CODEG_BRIDGE_PUBLIC_HOST").ok();
        Self::from_values(
            bind_host,
            codeg_port,
            ports.as_deref(),
            pattern.as_deref(),
            public_host.as_deref(),
        )
    }

    /// The same, from values already read, so the rules can be tested without
    /// touching the process environment. `None` switches the bridge off: the
    /// operator asked for that (`CODEG_BRIDGE_PORTS=off`), or wrote something
    /// unreadable — a typo must not silently bind ten ports, and must not
    /// silently answer for hostnames, either.
    pub fn from_values(
        bind_host: &str,
        codeg_port: u16,
        ports_raw: Option<&str>,
        host_pattern_raw: Option<&str>,
        public_host_raw: Option<&str>,
    ) -> Option<Self> {
        let host_pattern = match host_pattern_raw.map(str::trim).filter(|p| !p.is_empty()) {
            Some(raw) => Some(HostPattern::parse(raw)?),
            None => None,
        };
        let ports = match ports_raw {
            Some(raw) => parse_ports(raw, codeg_port)?,
            None => default_ports(codeg_port),
        };
        let public_host = public_host_raw
            .map(|h| h.trim().to_string())
            .filter(|h| !h.is_empty());
        Some(Self {
            bind_host: bind_host.to_string(),
            // A hostname-addressed bridge binds nothing, so it claims no pool
            // either — including the default one nobody asked for.
            ports: if host_pattern.is_some() { Vec::new() } else { ports },
            public_host,
            host_pattern,
            reserved: vec![codeg_port],
        })
    }
}

/// How the browser addresses one target port when the bridge answers on
/// codeg's own listener instead of binding a port per target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostPattern {
    /// `auto`: the port is one label in front of the host the workbench
    /// itself was reached at — `3000.codeg.example.com` for a workbench on
    /// `codeg.example.com`, `3000.localhost` for one on `localhost`.
    Subdomain,
    /// A template naming `{port}`: `{port}.preview.example.com`,
    /// `p{port}-codeg.example.com`.
    Template { prefix: String, suffix: String },
}

impl HostPattern {
    /// `auto`, or a template naming `{port}` once and reading back as a
    /// hostname. `None` for anything else, including a bare `{port}`: that
    /// would make every numeric hostname the bridge's.
    pub fn parse(raw: &str) -> Option<Self> {
        let raw = raw.trim().to_ascii_lowercase();
        if raw == "auto" {
            return Some(Self::Subdomain);
        }
        let (prefix, suffix) = raw.split_once("{port}")?;
        if suffix.contains("{port}") || (prefix.is_empty() && suffix.is_empty()) {
            return None;
        }
        // A digit next to the port would still read back as one port per
        // hostname, but not as the one a reader of the hostname sees:
        // `{port}0.example.com` makes `3000.example.com` port 300.
        if prefix.ends_with(|c: char| c.is_ascii_digit())
            || suffix.starts_with(|c: char| c.is_ascii_digit())
        {
            return None;
        }
        let pattern = Self::Template {
            prefix: prefix.to_string(),
            suffix: suffix.to_string(),
        };
        // It has to be a hostname and nothing else — no port, no path, no
        // credentials — and it has to read back as the port it was written
        // for, or the two directions would not agree.
        let sample = format!("{prefix}3000{suffix}");
        if !is_hostname(&sample) || pattern.target_of(&sample) != Some(3000) {
            return None;
        }
        Some(pattern)
    }

    /// The hostname that names `port` for a workbench reached at `base` (a
    /// hostname, no port); a template ignores `base`. `None` when `auto` has
    /// nothing to hang the port in front of — an address, or no name at all.
    pub fn render(&self, port: u16, base: &str) -> Option<String> {
        match self {
            Self::Subdomain => {
                let base = base.trim().trim_matches('.').to_ascii_lowercase();
                if !is_hostname(&base) || base.parse::<std::net::IpAddr>().is_ok() {
                    return None;
                }
                Some(format!("{port}.{base}"))
            }
            Self::Template { prefix, suffix } => Some(format!("{prefix}{port}{suffix}")),
        }
    }

    /// The target port `host` names, or `None` when the hostname is not the
    /// bridge's. `host` is a hostname with no port.
    pub fn target_of(&self, host: &str) -> Option<u16> {
        let host = host.trim().to_ascii_lowercase();
        let digits = match self {
            Self::Subdomain => {
                let (label, rest) = host.split_once('.')?;
                if !is_hostname(rest) {
                    return None;
                }
                label
            }
            Self::Template { prefix, suffix } => host
                .strip_prefix(prefix.as_str())?
                .strip_suffix(suffix.as_str())?,
        };
        parse_target_port(digits)
    }

    /// How it was written, for the status and the startup log.
    pub fn to_text(&self) -> String {
        match self {
            Self::Subdomain => "auto".to_string(),
            Self::Template { prefix, suffix } => format!("{prefix}{{port}}{suffix}"),
        }
    }
}

/// The digits of a bridge hostname as a port: decimal, no sign, no leading
/// zero, never `0`. One spelling per port, so a target cannot be reached
/// from two hostnames — which would be two origins holding one target.
fn parse_target_port(digits: &str) -> Option<u16> {
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if digits.len() > 1 && digits.starts_with('0') {
        return None;
    }
    digits.parse::<u16>().ok().filter(|port| *port != 0)
}

/// A plain DNS name: dot-separated labels of letters, digits and hyphens.
fn is_hostname(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}

/// The ten ports after codeg's own, stopping at the end of the port space.
pub fn default_ports(codeg_port: u16) -> Vec<u16> {
    (1..=DEFAULT_POOL_SIZE)
        .filter_map(|offset| codeg_port.checked_add(offset))
        .collect()
}

/// `3081-3090`, `3081,3082,3090`, a mix of both, `auto` (any free port), or
/// `off` / `none` / `disabled` / empty (no bridge; returns `None`). Codeg's
/// own port is never part of the pool. An unparseable value is `None` too:
/// a typo must not silently bind ten ports the operator did not choose.
pub fn parse_ports(raw: &str, codeg_port: u16) -> Option<Vec<u16>> {
    let raw = raw.trim();
    if raw.is_empty() || matches!(raw.to_ascii_lowercase().as_str(), "off" | "none" | "disabled") {
        return None;
    }
    if raw.eq_ignore_ascii_case("auto") {
        return Some(vec![0]);
    }
    let mut ports = Vec::new();
    for item in raw.split(',') {
        let item = item.trim();
        if item.is_empty() {
            continue;
        }
        let range = match item.split_once('-') {
            Some((lo, hi)) => (lo.trim().parse::<u16>().ok()?, hi.trim().parse::<u16>().ok()?),
            None => {
                let port = item.parse::<u16>().ok()?;
                (port, port)
            }
        };
        if range.0 == 0 || range.1 < range.0 {
            return None;
        }
        for port in range.0..=range.1 {
            if port != codeg_port && !ports.contains(&port) {
                ports.push(port);
            }
        }
    }
    if ports.is_empty() {
        None
    } else {
        Some(ports)
    }
}

/// What `browser_bridge_status` tells the workbench.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStatus {
    pub enabled: bool,
    /// Ports a listener may take (`0` = any free port); empty when targets
    /// are addressed by hostname.
    pub ports: Vec<u16>,
    pub public_host: Option<String>,
    /// How a target is named when the bridge answers by hostname.
    pub host_pattern: Option<String>,
}

/// A tab's ticket into one listener.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BridgeGrant {
    pub target_port: u16,
    /// Port of the listener that answers for this target; `None` when it is
    /// addressed by hostname and the browser keeps the port it already uses.
    pub bridge_port: Option<u16>,
    /// Hostname that names this target, when the bridge answers by hostname.
    pub bridge_host: Option<String>,
    /// Path on the bridge origin that sets the cookie and redirects to the
    /// page (`?to=/path` chooses where).
    pub entry_path: String,
    pub public_host: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum BridgeError {
    #[error("the port bridge is off on this server")]
    Disabled,
    #[error("port {0} is codeg's own listener")]
    Reserved(u16),
    #[error("no bridge port is free: {0}")]
    NoPort(String),
    #[error(
        "a hostname-addressed bridge needs the workbench reached by name, not by address ({0})"
    )]
    NoHostname(String),
}

struct Listener {
    target_port: u16,
    /// Port of this listener's own socket; `None` when the target is
    /// addressed by hostname and its requests arrive on codeg's listener.
    bridge_port: Option<u16>,
    /// Bridge hostnames handed out for this target — one per host the
    /// workbench has been reached at. A request on codeg's listener is this
    /// target's only if it was addressed to a name in here: the pattern
    /// alone describes a *shape* (`auto` would claim `3000.anything`), and a
    /// shape is not a promise that codeg ever handed the name out.
    hosts: Mutex<HashSet<String>>,
    /// Believe `X-Forwarded-Host` / `X-Forwarded-Proto`: only when the
    /// operator declared a proxy in front (`CODEG_BRIDGE_PUBLIC_HOST`); a
    /// page can ask its browser to send those headers, `Host` it cannot.
    trust_forwarded: bool,
    caps: Mutex<Vec<String>>,
    /// Workbench tabs holding this listener open.
    holds: Mutex<HashSet<String>>,
    last_seen: Mutex<Instant>,
    shutdown: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl Listener {
    fn has_cap(&self, cap: &str) -> bool {
        let caps = lock(&self.caps);
        caps.iter().any(|known| constant_time_eq(known.as_bytes(), cap.as_bytes()))
    }

    fn touch(&self) {
        *lock(&self.last_seen) = Instant::now();
    }

    fn grant(
        &self,
        tab_id: &str,
        public_host: Option<String>,
        bridge_host: Option<String>,
    ) -> BridgeGrant {
        let cap = uuid::Uuid::new_v4().simple().to_string();
        lock(&self.caps).push(cap.clone());
        lock(&self.holds).insert(tab_id.to_string());
        self.touch();
        BridgeGrant {
            target_port: self.target_port,
            bridge_port: self.bridge_port,
            bridge_host,
            entry_path: format!("{ENTER_PREFIX}{cap}"),
            public_host,
        }
    }

    /// One name per listener: the bridge port it answers on, or — addressed
    /// by hostname — the target port, which is what its hostname says. That
    /// cookie is host-only, so it never reaches another target at all.
    fn cookie_name(&self) -> String {
        format!(
            "{COOKIE_PREFIX}{}",
            self.bridge_port.unwrap_or(self.target_port)
        )
    }

    /// How the listener reads in a log line.
    fn describe(&self) -> String {
        match self.bridge_port {
            Some(port) => format!("port {port}"),
            None => format!("the hostname for port {}", self.target_port),
        }
    }

    /// Stop accepting; connections still open get `CLOSE_GRACE`, then are cut.
    fn close(&self) {
        if let Some(tx) = lock(&self.shutdown).take() {
            let _ = tx.send(());
        }
        if let Some(task) = lock(&self.task).take() {
            if tokio::runtime::Handle::try_current().is_ok() {
                tokio::spawn(async move {
                    let abort = task.abort_handle();
                    if tokio::time::timeout(CLOSE_GRACE, task).await.is_err() {
                        abort.abort();
                    }
                });
            } else {
                task.abort();
            }
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

struct Bridge {
    config: Mutex<Option<BridgeConfig>>,
    /// Bumped by every `configure`, so an `open` that started under an
    /// earlier configuration cannot publish a listener after the bridge was
    /// switched off (or re-pointed) while it was binding.
    generation: AtomicU64,
    /// Live listeners by target port.
    listeners: Mutex<HashMap<u16, Arc<Listener>>>,
    /// Bridge hostnames this process has handed out. Nothing takes a name
    /// out of here — not the target idling away, not switching the bridge
    /// off, not pointing it somewhere else. An origin outlives the target
    /// it was handed out for: a page that ran there may have left a service
    /// worker behind, and codeg's own pages served under that name would be
    /// served through it. So the name is refused instead, for as long as
    /// this process runs.
    ///
    /// It grows by one per target port per hostname the workbench is
    /// reached at, and only an authenticated `browser_bridge_open` adds
    /// one: the whole port space on one hostname is a few megabytes, and
    /// asking for it means holding codeg's token.
    minted: Mutex<HashSet<String>>,
}

static BRIDGE: LazyLock<Bridge> = LazyLock::new(|| Bridge {
    config: Mutex::new(None),
    generation: AtomicU64::new(0),
    listeners: Mutex::new(HashMap::new()),
    minted: Mutex::new(HashSet::new()),
});

static SWEEPER: OnceLock<()> = OnceLock::new();

/// Whether any request on codeg's own listener could be the bridge's. Read
/// on every request codeg serves, so it stays out of the config mutex.
static HOST_MODE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Whether this process has ever handed out a bridge hostname. Never goes
/// back to false: those names stay refused after the bridge is switched off
/// or pointed somewhere else, which is the whole point of `BRIDGE.minted`.
static NAMES_HANDED_OUT: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Set (or, with `None`, switch off) the bridge. Switching off closes every
/// listener; changing the configuration keeps the listeners already bound.
pub fn configure(config: Option<BridgeConfig>) {
    let off = config.is_none();
    {
        let mut current = lock(&BRIDGE.config);
        *current = config;
        HOST_MODE.store(
            current.as_ref().is_some_and(|c| c.host_pattern.is_some()),
            Ordering::Release,
        );
        BRIDGE.generation.fetch_add(1, Ordering::AcqRel);
    }
    if off {
        shutdown_all();
    }
    // `BRIDGE.minted` is deliberately untouched: a name this process handed
    // out stays refused whatever the bridge is reconfigured to, because the
    // browser's memory of that origin does not get reconfigured with it.
}

pub fn status() -> BridgeStatus {
    match lock(&BRIDGE.config).as_ref() {
        Some(config) => BridgeStatus {
            enabled: true,
            ports: config.ports.clone(),
            public_host: config.public_host.clone(),
            host_pattern: config.host_pattern.as_ref().map(HostPattern::to_text),
        },
        None => BridgeStatus {
            enabled: false,
            ports: Vec::new(),
            public_host: None,
            host_pattern: None,
        },
    }
}

/// Number of live listeners.
pub fn listener_count() -> usize {
    lock(&BRIDGE.listeners).len()
}

/// Let `tab_id` reach `127.0.0.1:{target_port}` through the bridge, binding a
/// listener when the port has none yet. `workbench_host` is the hostname the
/// asking workbench was reached at, which `auto` hangs the port in front of.
pub async fn open(
    target_port: u16,
    tab_id: &str,
    workbench_host: Option<&str>,
) -> Result<BridgeGrant, BridgeError> {
    let (config, generation) = {
        let config = lock(&BRIDGE.config);
        let generation = BRIDGE.generation.load(Ordering::Acquire);
        (config.clone().ok_or(BridgeError::Disabled)?, generation)
    };
    if config.reserved.contains(&target_port) {
        return Err(BridgeError::Reserved(target_port));
    }
    if let Some(pattern) = &config.host_pattern {
        return open_by_host(&config, pattern, target_port, tab_id, workbench_host, generation);
    }
    if let Some(existing) = lock(&BRIDGE.listeners).get(&target_port).cloned() {
        return Ok(existing.grant(tab_id, config.public_host.clone(), None));
    }

    let used: HashSet<u16> =
        lock(&BRIDGE.listeners).values().filter_map(|l| l.bridge_port).collect();
    let mut last_error = String::from("no ports configured");
    for &port in &config.ports {
        if port != 0 && used.contains(&port) {
            continue;
        }
        let socket = match bind(&config.bind_host, port).await {
            Ok(socket) => socket,
            Err(err) => {
                last_error = format!("{}:{port}: {err}", config.bind_host);
                continue;
            }
        };
        let bridge_port = socket.local_addr().map(|a| a.port()).unwrap_or(port);
        let listener = Arc::new(Listener {
            target_port,
            bridge_port: Some(bridge_port),
            hosts: Mutex::new(HashSet::new()),
            trust_forwarded: config.public_host.is_some(),
            caps: Mutex::new(Vec::new()),
            holds: Mutex::new(HashSet::new()),
            last_seen: Mutex::new(Instant::now()),
            shutdown: Mutex::new(None),
            task: Mutex::new(None),
        });
        // Armed before it is published, so a `configure(None)` that drains
        // the map right after publication finds a listener it can close.
        serve(socket, listener.clone());
        // Another task may have bound this target while we were binding, and
        // the bridge may have been switched off: a listener is published only
        // under the configuration it was opened for.
        let winner = {
            let config_now = lock(&BRIDGE.config);
            if config_now.is_none() || BRIDGE.generation.load(Ordering::Acquire) != generation {
                drop(config_now);
                listener.close();
                return Err(BridgeError::Disabled);
            }
            let mut listeners = lock(&BRIDGE.listeners);
            match listeners.get(&target_port) {
                Some(existing) => existing.clone(),
                None => {
                    listeners.insert(target_port, listener.clone());
                    listener.clone()
                }
            }
        };
        if Arc::ptr_eq(&winner, &listener) {
            SWEEPER.get_or_init(|| {
                tokio::spawn(sweep_task());
            });
            tracing::info!(
                "[bridge] port {bridge_port} now forwards to 127.0.0.1:{target_port}"
            );
        } else {
            listener.close();
        }
        return Ok(winner.grant(tab_id, config.public_host.clone(), None));
    }
    Err(BridgeError::NoPort(last_error))
}

/// The same, for a bridge addressed by hostname: nothing to bind, so the
/// entry is only the capability holder the sweeper ages out. The hostname is
/// worked out here — the workbench's own is what `auto` builds on, and a
/// reverse proxy that replaced it is declared by `CODEG_BRIDGE_PUBLIC_HOST`.
fn open_by_host(
    config: &BridgeConfig,
    pattern: &HostPattern,
    target_port: u16,
    tab_id: &str,
    workbench_host: Option<&str>,
    generation: u64,
) -> Result<BridgeGrant, BridgeError> {
    let base = config
        .public_host
        .as_deref()
        .or(workbench_host)
        .unwrap_or_default();
    let host = pattern
        .render(target_port, base)
        .ok_or_else(|| BridgeError::NoHostname(base.to_string()))?;
    let (listener, fresh) = {
        // The bridge may have been switched off while this request was in
        // flight: an entry is published only under the configuration it was
        // opened for.
        let config_now = lock(&BRIDGE.config);
        if config_now.is_none() || BRIDGE.generation.load(Ordering::Acquire) != generation {
            return Err(BridgeError::Disabled);
        }
        let mut listeners = lock(&BRIDGE.listeners);
        match listeners.get(&target_port) {
            Some(existing) => (existing.clone(), false),
            None => {
                let listener = Arc::new(Listener {
                    target_port,
                    bridge_port: None,
                    hosts: Mutex::new(HashSet::new()),
                    trust_forwarded: config.public_host.is_some(),
                    caps: Mutex::new(Vec::new()),
                    holds: Mutex::new(HashSet::new()),
                    last_seen: Mutex::new(Instant::now()),
                    shutdown: Mutex::new(None),
                    task: Mutex::new(None),
                });
                listeners.insert(target_port, listener.clone());
                (listener, true)
            }
        }
    };
    if fresh {
        SWEEPER.get_or_init(|| {
            tokio::spawn(sweep_task());
        });
        tracing::info!("[bridge] {host} now forwards to 127.0.0.1:{target_port}");
    }
    // Remembered before the grant is handed out, so the first request under
    // this name already finds it. One target can carry several names: a
    // workbench reached at two hostnames renders one for each. The second
    // record outlives the target, so the name never becomes codeg's again.
    lock(&listener.hosts).insert(host.clone());
    lock(&BRIDGE.minted).insert(host.clone());
    NAMES_HANDED_OUT.store(true, Ordering::Release);
    Ok(listener.grant(tab_id, config.public_host.clone(), Some(host)))
}

/// `tab_id` no longer needs any listener.
pub fn close(tab_id: &str) {
    for listener in lock(&BRIDGE.listeners).values() {
        lock(&listener.holds).remove(tab_id);
    }
}

/// Close listeners nobody has used for a while; returns how many closed.
pub fn sweep(now: Instant) -> usize {
    let stale: Vec<Arc<Listener>> = {
        let mut listeners = lock(&BRIDGE.listeners);
        let stale: Vec<u16> = listeners
            .values()
            .filter(|l| {
                let idle = now.saturating_duration_since(*lock(&l.last_seen));
                let held = !lock(&l.holds).is_empty();
                idle >= if held { HELD_IDLE } else { UNHELD_IDLE }
            })
            .map(|l| l.target_port)
            .collect();
        stale.iter().filter_map(|port| listeners.remove(port)).collect()
    };
    for listener in &stale {
        tracing::info!(
            "[bridge] {} closed (127.0.0.1:{} idle)",
            listener.describe(),
            listener.target_port
        );
        listener.close();
    }
    stale.len()
}

pub fn shutdown_all() {
    let all: Vec<Arc<Listener>> = lock(&BRIDGE.listeners).drain().map(|(_, l)| l).collect();
    for listener in all {
        listener.close();
    }
}

async fn sweep_task() {
    loop {
        tokio::time::sleep(SWEEP_INTERVAL).await;
        sweep(Instant::now());
    }
}

/// Binds like the API listener does: an IP literal (bare or bracketed IPv6)
/// or a hostname such as `localhost`, resolved here.
async fn bind(host: &str, port: u16) -> std::io::Result<tokio::net::TcpListener> {
    let host = host.trim().trim_start_matches('[').trim_end_matches(']');
    let socket = match host.parse::<std::net::IpAddr>() {
        Ok(ip) => tokio::net::TcpListener::bind(SocketAddr::new(ip, port)).await?,
        Err(_) => tokio::net::TcpListener::bind((host, port)).await?,
    };
    if let Err(err) = super::socket_inherit::mark_listener_non_inheritable(&socket) {
        tracing::warn!("[bridge] failed to mark listener non-inheritable: {err}");
    }
    Ok(socket)
}

fn serve(socket: tokio::net::TcpListener, listener: Arc<Listener>) {
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    let router = Router::new()
        .route(PING_PATH, get(ping))
        .route("/__codeg_bridge/enter/{cap}", get(enter))
        .fallback(any(forward))
        .with_state(listener.clone());
    let task = tokio::spawn(async move {
        let serve = axum::serve(socket, router).with_graceful_shutdown(async move {
            let _ = rx.await;
        });
        if let Err(err) = serve.await {
            tracing::error!("[bridge] listener error: {err}");
        }
    });
    *lock(&listener.shutdown) = Some(tx);
    *lock(&listener.task) = Some(task);
}

// ─── Routing on codeg's own listener ───────────────────────────────────

/// Answer here, and nowhere else in codeg, when the request was addressed to
/// a bridge hostname. The outermost layer of codeg's router: a bridged
/// request gets the same treatment a listener of its own would give it —
/// no CORS layer, no compression, no body limit, no static fallback — and
/// codeg's own pages and API are never reached under that hostname.
///
/// Off unless `CODEG_BRIDGE_HOST_PATTERN` is set, and then a hostname the
/// pattern does not describe passes straight through to codeg.
pub async fn route_by_host(request: Request, next: Next) -> Response {
    // Names this process handed out are still refused after the bridge is
    // switched off or pointed somewhere else, so being off is not on its
    // own a reason to stop looking.
    if !HOST_MODE.load(Ordering::Acquire) && !NAMES_HANDED_OUT.load(Ordering::Acquire) {
        return next.run(request).await;
    }
    let live = {
        let config = lock(&BRIDGE.config);
        config
            .as_ref()
            .and_then(|c| c.host_pattern.clone().map(|p| (p, c.public_host.is_some())))
    };
    // Forwarding headers are the operator's proxy talking, and only a live
    // configuration says there is one.
    let names = addressed_hostnames(&request, live.as_ref().is_some_and(|(_, t)| *t));
    if live.is_some() {
        // A name codeg handed out for a live target is that target's,
        // whichever of the request's authorities carried it.
        for name in &names {
            let listener = lock(&BRIDGE.listeners)
                .values()
                .find(|l| lock(&l.hosts).contains(name))
                .cloned();
            if let Some(listener) = listener {
                return serve_one(listener, request).await;
            }
        }
    }
    {
        let minted = lock(&BRIDGE.minted);
        if unclaimed_is_the_bridges(live.as_ref().map(|(p, _)| p), &names, &minted) {
            return forbidden_page();
        }
    }
    next.run(request).await
}

/// Whether a request naming no *live* target is still the bridge's to
/// refuse. Two ways it can be.
///
/// A name this process once handed out stays the bridge's for good — the
/// target idling away, the bridge being switched off, the bridge being
/// pointed somewhere else, none of it reaches the browser's memory of that
/// origin. A page that ran there may have left a service worker behind, and
/// codeg's own pages served under that name would be served through it.
/// `pattern` is `None` for exactly those cases, and this is all that is
/// left to check.
///
/// A dedicated wildcard is the bridge's whether or not a name under it was
/// ever handed out: with `{port}.preview.example.com` the operator gave the
/// bridge every name there, so codeg has no business answering. `auto` gets
/// no such benefit of the doubt — it describes `<port>.<anything>`, a shape
/// that covers names codeg was never asked to take, a workbench on a
/// numeric-leading hostname among them.
fn unclaimed_is_the_bridges(
    pattern: Option<&HostPattern>,
    names: &[String],
    minted: &HashSet<String>,
) -> bool {
    names.iter().any(|name| {
        minted.contains(name)
            || pattern.is_some_and(|pattern| {
                matches!(pattern, HostPattern::Template { .. })
                    && pattern.target_of(name).is_some()
            })
    })
}

/// Every hostname this request carries: what the browser addressed (`Host`,
/// or HTTP/2's `:authority` where there is no `Host` header) and, behind a
/// declared proxy, each `X-Forwarded-Host` value — a proxy may append to
/// that header rather than replace it.
///
/// All of them, not the first that exists: a page can add a forwarded header
/// to a request of its own but cannot drop its `Host`, so naming the
/// workbench in one cannot carry a request out of the bridge and onto
/// codeg's pages under the bridge's own origin.
fn addressed_hostnames(request: &Request, trust_forwarded: bool) -> Vec<String> {
    let headers = request.headers();
    let mut raw: Vec<String> = Vec::new();
    if let Some(host) = headers.get(header::HOST).and_then(|v| v.to_str().ok()) {
        raw.push(host.to_string());
    } else if let Some(authority) = request.uri().authority() {
        raw.push(authority.as_str().to_string());
    }
    if trust_forwarded {
        for value in headers.get_all("x-forwarded-host") {
            if let Ok(value) = value.to_str() {
                raw.extend(value.split(',').map(str::to_string));
            }
        }
    }
    let mut names: Vec<String> = Vec::new();
    for value in raw {
        if let Some(name) = hostname_of(&value) {
            if !names.contains(&name) {
                names.push(name);
            }
        }
    }
    names
}

/// The three answers a bridge listener gives, dispatched by path for a
/// request that arrived on codeg's listener instead of one of our own.
async fn serve_one(listener: Arc<Listener>, request: Request) -> Response {
    // HEAD as well as GET: axum answers a `get(...)` route for both, and a
    // listener of its own is an axum router.
    let is_get = matches!(
        *request.method(),
        axum::http::Method::GET | axum::http::Method::HEAD
    );
    let path = request.uri().path().to_string();
    if is_get && path == PING_PATH {
        return ping().await;
    }
    // A capability is one path segment, as the listener's own route says.
    if let Some(cap) = path.strip_prefix(ENTER_PREFIX).filter(|c| !c.contains('/')) {
        if is_get {
            let (parts, _) = request.into_parts();
            return enter_response(&listener, cap, parts.uri.query(), &parts.headers);
        }
    }
    // Anything else under the bridge's own prefix is refused by `forward`.
    forward_request(listener, request).await
}

/// The hostname of a `host[:port]`, lower-cased. `None` for an address
/// literal: a bridge hostname is a name, and `3000.` in front of an IPv4
/// address or inside brackets is not one.
fn hostname_of(authority: &str) -> Option<String> {
    let authority = authority.trim();
    if authority.starts_with('[') {
        return None;
    }
    let host = authority.split(':').next()?.trim().to_ascii_lowercase();
    if host.is_empty() || host.parse::<std::net::IpAddr>().is_ok() {
        return None;
    }
    Some(host)
}

/// The hostname the workbench itself was reached at, which `auto` hangs the
/// target port in front of.
pub fn workbench_hostname(headers: &HeaderMap) -> Option<String> {
    let trust_forwarded = lock(&BRIDGE.config)
        .as_ref()
        .is_some_and(|c| c.public_host.is_some());
    addressed_authority(headers, trust_forwarded)
        .as_deref()
        .and_then(hostname_of)
}

// ─── Listener routes ───────────────────────────────────────────────────

async fn ping() -> Response {
    (
        StatusCode::NO_CONTENT,
        [
            (header::ACCESS_CONTROL_ALLOW_ORIGIN, "*"),
            (header::CACHE_CONTROL, "no-store"),
        ],
    )
        .into_response()
}

async fn enter(
    State(listener): State<Arc<Listener>>,
    AxumPath(cap): AxumPath<String>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
) -> Response {
    enter_response(&listener, &cap, query.as_deref(), &headers)
}

fn enter_response(
    listener: &Listener,
    cap: &str,
    query: Option<&str>,
    headers: &HeaderMap,
) -> Response {
    if !listener.has_cap(cap) {
        return forbidden_page();
    }
    listener.touch();
    let to = query
        .and_then(|q| query_param(q, "to"))
        .filter(|to| is_local_path(to))
        .unwrap_or_else(|| "/".to_string());
    let secure = if forwarded_https(headers) { "; Secure" } else { "" };
    let cookie = format!(
        "{}={cap}; Path=/; HttpOnly; SameSite=Lax{secure}",
        listener.cookie_name()
    );
    // Not a redirect: a redirected request keeps the workbench as its
    // initiator and arrives `same-site`, which is exactly what `forward`
    // refuses. A page that navigates itself makes the next request
    // same-origin with this listener.
    // `Referrer-Policy: origin`: the navigation the page makes carries this
    // listener's origin as its referrer (what `forward` checks when the
    // browser sends no Fetch Metadata) and not the entry URL with its
    // capability.
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::SET_COOKIE, cookie)
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::REFERRER_POLICY, "origin")
        .body(Body::from(bounce_page(&to)))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// The entry's answer: a page whose only job is to go to `to` on this
/// origin, by script or, failing that, by meta refresh. Replaces itself in
/// the history, so the frame's back button does not return here.
fn bounce_page(to: &str) -> String {
    let attribute = escape_html(to);
    let script = json_for_script(to);
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\">\
         <meta http-equiv=\"refresh\" content=\"0;url={attribute}\"><title>codeg</title></head>\
         <body><script>location.replace({script})</script></body></html>"
    )
}

async fn forward(State(listener): State<Arc<Listener>>, request: Request) -> Response {
    forward_request(listener, request).await
}

async fn forward_request(listener: Arc<Listener>, request: Request) -> Response {
    let (mut parts, body) = request.into_parts();
    if parts.uri.path().starts_with("/__codeg_bridge/") {
        return StatusCode::NOT_FOUND.into_response();
    }
    let cookie_name = listener.cookie_name();
    let presented = cookie_value(&parts.headers, &cookie_name);
    if !presented.is_some_and(|cap| listener.has_cap(&cap)) {
        return forbidden_page();
    }
    if !same_origin_initiator(&parts.headers, listener.trust_forwarded) {
        return cross_origin_page();
    }
    listener.touch();
    if is_websocket_upgrade(&parts.headers) {
        return proxy_websocket(&listener, &mut parts).await;
    }
    proxy_http(&listener, parts, body).await
}

// ─── HTTP forwarding ───────────────────────────────────────────────────

/// Never follows redirects (the browser must see them), never decodes bodies
/// (they pass through byte for byte, `Content-Length` intact), never goes
/// through a proxy, and has no overall timeout: a dev server's SSE / long
/// poll stays open as long as the page wants.
static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .no_proxy()
        .no_gzip()
        .no_brotli()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .build()
        .expect("failed to build the bridge client")
});

/// Request headers that describe this connection, not the request, plus the
/// ones the bridge sets itself.
fn drop_request_header(name: &str) -> bool {
    matches!(
        name,
        "host"
            | "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "proxy-connection"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
            | "expect"
            | "content-length"
            | "cookie"
            | "origin"
            | "referer"
    )
}

/// Response headers that must not reach the browser: connection-level ones,
/// and `X-Frame-Options` — the page is being shown in the user's own workbench
/// on purpose (a CSP `frame-ancestors` directive goes the same way, see
/// `without_frame_ancestors`).
fn drop_response_header(name: &str) -> bool {
    matches!(
        name,
        "connection" | "keep-alive" | "transfer-encoding" | "trailer" | "upgrade" | "x-frame-options"
    )
}

async fn proxy_http(listener: &Listener, parts: Parts, body: Body) -> Response {
    let target = listener.target_port;
    let path_and_query = parts
        .uri
        .path_and_query()
        .map(|p| p.as_str())
        .unwrap_or("/");
    let upstream = format!("http://127.0.0.1:{target}{path_and_query}");
    let mut builder = CLIENT.request(parts.method.clone(), &upstream);
    for (name, value) in parts.headers.iter() {
        if !drop_request_header(name.as_str()) {
            builder = builder.header(name, value);
        }
    }
    for (name, value) in rewritten_request_headers(&parts.headers, target) {
        builder = builder.header(name, value);
    }
    // Anything the browser sent as a body goes on as a stream (chunked
    // upstream when the length is unknown); a body-less GET stays body-less.
    if !body.is_end_stream() {
        builder = builder.body(reqwest::Body::wrap_stream(body.into_data_stream()));
    }

    let response = match builder.send().await {
        Ok(response) => response,
        Err(err) => return bad_gateway_page(target, &err),
    };

    let mut out = Response::builder().status(response.status().as_u16());
    for (name, value) in response.headers().iter() {
        if drop_response_header(name.as_str()) {
            continue;
        }
        if name == header::LOCATION {
            if let Some(rewritten) = rewrite_location(value, target) {
                out = out.header(name, rewritten);
                continue;
            }
        }
        if name == header::CONTENT_SECURITY_POLICY
            || name == header::CONTENT_SECURITY_POLICY_REPORT_ONLY
        {
            if let Some(kept) = without_frame_ancestors(value) {
                out = out.header(name, kept);
            }
            continue;
        }
        out = out.header(name, value);
    }
    out.body(Body::from_stream(response.bytes_stream()))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// `Cookie` without the bridge's own cookies, and `Origin` / `Referer`
/// pointing at the target as the page would if it ran there directly — dev
/// servers compare them with `Host` before they answer a websocket or a
/// module request.
fn rewritten_request_headers(headers: &HeaderMap, target: u16) -> Vec<(HeaderName, HeaderValue)> {
    let mut out = Vec::new();
    let cookies = foreign_cookies(headers);
    if !cookies.is_empty() {
        if let Ok(value) = HeaderValue::from_str(&cookies) {
            out.push((header::COOKIE, value));
        }
    }
    if headers.contains_key(header::ORIGIN) {
        if let Ok(value) = HeaderValue::from_str(&format!("http://127.0.0.1:{target}")) {
            out.push((header::ORIGIN, value));
        }
    }
    if let Some(referer) = headers.get(header::REFERER).and_then(|v| v.to_str().ok()) {
        if let Ok(url) = reqwest::Url::parse(referer) {
            let mut rewritten = format!("http://127.0.0.1:{target}{}", url.path());
            if let Some(query) = url.query() {
                rewritten.push('?');
                rewritten.push_str(query);
            }
            if let Ok(value) = HeaderValue::from_str(&rewritten) {
                out.push((header::REFERER, value));
            }
        }
    }
    out
}

/// An absolute `Location` on the target itself becomes a path on the bridge
/// origin; anything else (another host, a relative path) passes unchanged.
fn rewrite_location(value: &HeaderValue, target: u16) -> Option<HeaderValue> {
    let raw = value.to_str().ok()?;
    let url = reqwest::Url::parse(raw).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let host = url.host_str()?;
    if !is_loopback_host(host) || url.port_or_known_default() != Some(target) {
        return None;
    }
    let mut path = url.path().to_string();
    if let Some(query) = url.query() {
        path.push('?');
        path.push_str(query);
    }
    if let Some(fragment) = url.fragment() {
        path.push('#');
        path.push_str(fragment);
    }
    HeaderValue::from_str(&path).ok()
}

// ─── WebSocket forwarding ──────────────────────────────────────────────

fn is_websocket_upgrade(headers: &HeaderMap) -> bool {
    let upgrade = headers
        .get(header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"));
    let connection = headers
        .get(header::CONNECTION)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(',').any(|part| part.trim().eq_ignore_ascii_case("upgrade")));
    upgrade && connection
}

async fn proxy_websocket(listener: &Listener, parts: &mut Parts) -> Response {
    let target = listener.target_port;
    let upgrade = match WebSocketUpgrade::from_request_parts(parts, &()).await {
        Ok(upgrade) => upgrade,
        Err(rejection) => return rejection.into_response(),
    };
    let path_and_query = parts
        .uri
        .path_and_query()
        .map(|p| p.as_str())
        .unwrap_or("/");
    let mut request = match format!("ws://127.0.0.1:{target}{path_and_query}").into_client_request()
    {
        Ok(request) => request,
        Err(err) => return bad_gateway_page(target, &err),
    };
    for name in [header::SEC_WEBSOCKET_PROTOCOL, header::USER_AGENT, header::ACCEPT_LANGUAGE] {
        if let Some(value) = parts.headers.get(&name) {
            request.headers_mut().insert(name, value.clone());
        }
    }
    for (name, value) in rewritten_request_headers(&parts.headers, target) {
        request.headers_mut().insert(name, value);
    }

    let (upstream, response) = match tokio_tungstenite::connect_async(request).await {
        Ok(connected) => connected,
        Err(err) => return bad_gateway_page(target, &err),
    };
    let mut upgrade = upgrade;
    if let Some(protocol) = response
        .headers()
        .get(header::SEC_WEBSOCKET_PROTOCOL)
        .and_then(|v| v.to_str().ok())
    {
        upgrade = upgrade.protocols([protocol.to_string()]);
    }
    upgrade.on_upgrade(move |socket| pump(socket, upstream))
}

async fn pump(
    downstream: WebSocket,
    upstream: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) {
    let (mut down_tx, mut down_rx) = downstream.split();
    let (mut up_tx, mut up_rx) = upstream.split();
    let to_upstream = async {
        while let Some(Ok(message)) = down_rx.next().await {
            let close = matches!(message, DownMessage::Close(_));
            if up_tx.send(downstream_to_upstream(message)).await.is_err() || close {
                break;
            }
        }
        let _ = up_tx.close().await;
    };
    let to_downstream = async {
        while let Some(Ok(message)) = up_rx.next().await {
            let Some(message) = upstream_to_downstream(message) else {
                continue;
            };
            let close = matches!(message, DownMessage::Close(_));
            if down_tx.send(message).await.is_err() || close {
                break;
            }
        }
        let _ = down_tx.close().await;
    };
    tokio::select! {
        _ = to_upstream => {}
        _ = to_downstream => {}
    }
}

fn downstream_to_upstream(message: DownMessage) -> UpMessage {
    match message {
        DownMessage::Text(text) => UpMessage::Text(text.as_str().into()),
        DownMessage::Binary(bytes) => UpMessage::Binary(bytes),
        DownMessage::Ping(bytes) => UpMessage::Ping(bytes),
        DownMessage::Pong(bytes) => UpMessage::Pong(bytes),
        DownMessage::Close(frame) => UpMessage::Close(frame.map(|f| UpCloseFrame {
            code: f.code.into(),
            reason: f.reason.as_str().into(),
        })),
    }
}

fn upstream_to_downstream(message: UpMessage) -> Option<DownMessage> {
    Some(match message {
        UpMessage::Text(text) => DownMessage::Text(text.as_str().into()),
        UpMessage::Binary(bytes) => DownMessage::Binary(bytes),
        UpMessage::Ping(bytes) => DownMessage::Ping(bytes),
        UpMessage::Pong(bytes) => DownMessage::Pong(bytes),
        UpMessage::Close(frame) => DownMessage::Close(frame.map(|f| CloseFrame {
            code: u16::from(f.code),
            reason: f.reason.as_str().into(),
        })),
        UpMessage::Frame(_) => return None,
    })
}

// ─── Small helpers ─────────────────────────────────────────────────────

fn query_param(raw: &str, key: &str) -> Option<String> {
    raw.split('&').find_map(|segment| {
        let (name, value) = segment.split_once('=').unwrap_or((segment, ""));
        if name != key {
            return None;
        }
        Some(
            urlencoding::decode(value)
                .map(|c| c.into_owned())
                .unwrap_or_else(|_| value.to_string()),
        )
    })
}

/// A path the entry may redirect to: root-relative on this origin only, so
/// the entry URL cannot be used to send the browser somewhere else.
fn is_local_path(path: &str) -> bool {
    path.starts_with('/')
        && !path.starts_with("//")
        && !path.starts_with("/\\")
        && !path.chars().any(|c| c.is_control() || c.is_whitespace())
}

/// Whether the browser says this request comes from the listener's own
/// page. `Sec-Fetch-Site` is set by the browser and cannot be forged by a
/// page: `same-origin` is the page itself, `none` a navigation the user
/// typed; `same-site` is another port on this host — a different proxied
/// page, or the workbench, neither of which may talk to the dev server
/// directly — and `cross-site` is anyone else. Browsers send Fetch Metadata
/// only to trustworthy origins (https, or the local machine), so on a plain
/// http deployment the `Origin` (always on websockets, POSTs and CORS
/// requests) or else the `Referer` must name this listener's own authority,
/// the one in the request's `Host`; a page can omit its referrer but cannot
/// claim another origin's. Nothing to go on — an address typed in on such a
/// deployment, or a page that hides its referrer — is refused.
fn same_origin_initiator(headers: &HeaderMap, trust_forwarded: bool) -> bool {
    if let Some(site) = headers.get("sec-fetch-site").and_then(|v| v.to_str().ok()) {
        return matches!(site.trim(), "same-origin" | "none");
    }
    let Some(own) = request_authority(headers, trust_forwarded) else {
        return false;
    };
    if let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
        return url_authority(origin).is_some_and(|a| a == own);
    }
    if let Some(referer) = headers.get(header::REFERER).and_then(|v| v.to_str().ok()) {
        return url_authority(referer).is_some_and(|a| a == own);
    }
    false
}

/// `host[:port]` the browser addressed, as written: `Host`, or — behind a
/// declared proxy — `X-Forwarded-Host` (first value).
fn addressed_authority(headers: &HeaderMap, trust_forwarded: bool) -> Option<String> {
    let forwarded = if trust_forwarded {
        headers
            .get("x-forwarded-host")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(',').next())
            .map(str::trim)
            .filter(|v| !v.is_empty())
    } else {
        None
    };
    match forwarded {
        Some(host) => Some(host.to_string()),
        None => Some(headers.get(header::HOST)?.to_str().ok()?.trim().to_string()),
    }
}

/// The same, with the default port made explicit.
fn request_authority(headers: &HeaderMap, trust_forwarded: bool) -> Option<String> {
    let host = addressed_authority(headers, trust_forwarded)?;
    let scheme = if trust_forwarded && forwarded_https(headers) { "https" } else { "http" };
    url_authority(&format!("{scheme}://{host}"))
}

/// `host:port` of an absolute URL, port explicit (the scheme's default when
/// the URL has none), host lower-cased; `None` for anything else (`null`,
/// a relative reference).
fn url_authority(raw: &str) -> Option<String> {
    let url = reqwest::Url::parse(raw.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let host = url.host_str()?.to_ascii_lowercase();
    let port = url.port_or_known_default()?;
    Some(format!("{host}:{port}"))
}

/// A CSP without its `frame-ancestors` directive — in every policy of the
/// header (a header value may carry several, comma-separated); `None` when
/// nothing else was in it (the header is then dropped).
fn without_frame_ancestors(value: &HeaderValue) -> Option<HeaderValue> {
    let raw = value.to_str().ok()?;
    let policies: Vec<String> = raw
        .split(',')
        .filter_map(|policy| {
            let kept: Vec<&str> = policy
                .split(';')
                .map(str::trim)
                .filter(|directive| {
                    !directive.is_empty()
                        && !directive
                            .split_whitespace()
                            .next()
                            .is_some_and(|name| name.eq_ignore_ascii_case("frame-ancestors"))
                })
                .collect();
            if kept.is_empty() {
                None
            } else {
                Some(kept.join("; "))
            }
        })
        .collect();
    if policies.is_empty() {
        return None;
    }
    HeaderValue::from_str(&policies.join(", ")).ok()
}

fn forwarded_https(headers: &HeaderMap) -> bool {
    headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(',').next().is_some_and(|p| p.trim().eq_ignore_ascii_case("https")))
}

fn cookie_pairs(headers: &HeaderMap) -> Vec<(String, String)> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|line| line.split(';'))
        .filter_map(|pair| {
            let (name, value) = pair.trim().split_once('=')?;
            Some((name.trim().to_string(), value.trim().to_string()))
        })
        .collect()
}

fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    cookie_pairs(headers)
        .into_iter()
        .find(|(n, _)| n == name)
        .map(|(_, v)| v)
}

/// The page's own cookies, re-serialized without the bridge's and without
/// the workbench's (both share the host with the page).
fn foreign_cookies(headers: &HeaderMap) -> String {
    cookie_pairs(headers)
        .into_iter()
        .filter(|(name, _)| {
            !name.starts_with(COOKIE_PREFIX) && !name.starts_with(WORKBENCH_COOKIE_PREFIX)
        })
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("; ")
}

/// `localhost`, `*.localhost`, `127/8`, `::1` and the unspecified addresses,
/// which a browser connects to as local.
pub fn is_loopback_host(host: &str) -> bool {
    let host = host.trim().trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") {
        return true;
    }
    if host == "::1" || host == "::" || host == "0.0.0.0" {
        return true;
    }
    let host = host.strip_prefix("::ffff:").unwrap_or(&host);
    match host.parse::<std::net::Ipv4Addr>() {
        Ok(ip) => ip.octets()[0] == 127,
        Err(_) => false,
    }
}

fn html_page(status: StatusCode, title: &str, body: &str) -> Response {
    let html = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>{title}</title>\
         <style>body{{font:14px/1.5 system-ui,sans-serif;color:#333;margin:0;padding:32px 24px;\
         background:#fafafa}}h1{{font-size:16px;margin:0 0 8px}}p{{margin:0;max-width:52ch}}</style>\
         </head><body><h1>{title}</h1><p>{body}</p></body></html>"
    );
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(html))
        .unwrap_or_else(|_| status.into_response())
}

fn forbidden_page() -> Response {
    html_page(
        StatusCode::FORBIDDEN,
        "This preview is no longer valid",
        "Reopen the page from codeg to start a new preview session.",
    )
}

fn cross_origin_page() -> Response {
    html_page(
        StatusCode::FORBIDDEN,
        "This request did not come from the page itself",
        "A dev server shown through codeg only answers its own page. Open the address from codeg to view it.",
    )
}

fn bad_gateway_page(target: u16, err: &dyn std::fmt::Display) -> Response {
    let detail = escape_html(&err.to_string());
    html_page(
        StatusCode::BAD_GATEWAY,
        &format!("codeg cannot reach port {target} on its host"),
        &format!("Is the server still running there? Reload to try again. ({detail})"),
    )
}

fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// A JSON string literal safe inside a `<script>` block: `<`, `>` and `&`
/// become escapes so no `</script>` (or comment opener) can end the block.
fn json_for_script(text: &str) -> String {
    serde_json::to_string(text)
        .unwrap_or_else(|_| "\"/\"".to_string())
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('&', "\\u0026")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn port_pools_parse_ranges_lists_and_switches() {
        assert_eq!(parse_ports("3081-3083", 3080), Some(vec![3081, 3082, 3083]));
        assert_eq!(parse_ports("3081, 3090,3081", 3080), Some(vec![3081, 3090]));
        assert_eq!(parse_ports("3079-3082", 3080), Some(vec![3079, 3081, 3082]));
        assert_eq!(parse_ports("auto", 3080), Some(vec![0]));
        assert_eq!(parse_ports("AUTO", 3080), Some(vec![0]));
        for off in ["", "  ", "off", "none", "Disabled"] {
            assert_eq!(parse_ports(off, 3080), None, "{off:?}");
        }
        // A typo must not turn into a default pool.
        assert_eq!(parse_ports("3081-", 3080), None);
        assert_eq!(parse_ports("abc", 3080), None);
        assert_eq!(parse_ports("3090-3081", 3080), None);
        assert_eq!(parse_ports("0-3", 3080), None);
        // Only codeg's own port: nothing left.
        assert_eq!(parse_ports("3080", 3080), None);
    }

    #[test]
    fn default_pool_is_the_ten_ports_above_codeg() {
        assert_eq!(default_ports(3080), (3081..=3090).collect::<Vec<_>>());
        assert_eq!(default_ports(65533), vec![65534, 65535]);
    }

    #[test]
    fn entry_redirects_stay_on_this_origin() {
        assert!(is_local_path("/"));
        assert!(is_local_path("/docs?x=1#top"));
        assert!(!is_local_path(""));
        assert!(!is_local_path("//evil.example/"));
        assert!(!is_local_path("/\\evil.example/"));
        assert!(!is_local_path("http://evil.example/"));
        assert!(!is_local_path("/a\r\nSet-Cookie: x=y"));
        assert!(!is_local_path("/with space"));
    }

    #[test]
    fn cookies_are_read_and_filtered() {
        let mut headers = HeaderMap::new();
        headers.append(
            header::COOKIE,
            HeaderValue::from_static("a=1; codeg-bridge-3081=cap-one; b=2"),
        );
        headers.append(
            header::COOKIE,
            HeaderValue::from_static("codeg-bridge-3082=cap-two; codeg.locale=zh-CN"),
        );
        assert_eq!(cookie_value(&headers, "codeg-bridge-3081").as_deref(), Some("cap-one"));
        assert_eq!(cookie_value(&headers, "codeg-bridge-3082").as_deref(), Some("cap-two"));
        assert_eq!(cookie_value(&headers, "codeg-bridge-3083"), None);
        assert_eq!(foreign_cookies(&headers), "a=1; b=2");
        assert_eq!(foreign_cookies(&HeaderMap::new()), "");
    }

    #[test]
    fn origin_and_referer_point_at_the_target() {
        let mut headers = HeaderMap::new();
        headers.insert(header::ORIGIN, HeaderValue::from_static("http://codeg.example:3081"));
        headers.insert(
            header::REFERER,
            HeaderValue::from_static("http://codeg.example:3081/app/page?tab=2"),
        );
        headers.insert(header::COOKIE, HeaderValue::from_static("codeg-bridge-3081=c; sid=9"));
        let rewritten = rewritten_request_headers(&headers, 3000);
        let get = |name: HeaderName| {
            rewritten
                .iter()
                .find(|(n, _)| *n == name)
                .map(|(_, v)| v.to_str().unwrap().to_string())
        };
        assert_eq!(get(header::ORIGIN).as_deref(), Some("http://127.0.0.1:3000"));
        assert_eq!(
            get(header::REFERER).as_deref(),
            Some("http://127.0.0.1:3000/app/page?tab=2")
        );
        assert_eq!(get(header::COOKIE).as_deref(), Some("sid=9"));

        // `Origin: null` (a sandboxed frame) is rewritten too; no Origin at
        // all stays absent.
        let mut headers = HeaderMap::new();
        headers.insert(header::ORIGIN, HeaderValue::from_static("null"));
        let rewritten = rewritten_request_headers(&headers, 3000);
        assert_eq!(rewritten.len(), 1);
        assert!(rewritten_request_headers(&HeaderMap::new(), 3000).is_empty());
    }

    #[test]
    fn location_on_the_target_becomes_a_path() {
        let rewrite = |raw: &str| {
            rewrite_location(&HeaderValue::from_str(raw).unwrap(), 3000)
                .map(|v| v.to_str().unwrap().to_string())
        };
        assert_eq!(rewrite("http://127.0.0.1:3000/login?next=%2F").as_deref(), Some("/login?next=%2F"));
        assert_eq!(rewrite("http://localhost:3000/a#b").as_deref(), Some("/a#b"));
        assert_eq!(rewrite("http://[::1]:3000/").as_deref(), Some("/"));
        assert_eq!(rewrite("http://0.0.0.0:3000/x").as_deref(), Some("/x"));
        // Another port, another host, a relative path: untouched.
        assert_eq!(rewrite("http://127.0.0.1:3001/"), None);
        assert_eq!(rewrite("https://example.com/"), None);
        assert_eq!(rewrite("/relative"), None);
        assert_eq!(rewrite("login"), None);
    }

    #[test]
    fn loopback_hosts() {
        for host in ["localhost", "LOCALHOST", "app.localhost", "127.0.0.1", "127.1.2.3", "::1", "[::1]", "0.0.0.0", "::", "::ffff:127.0.0.1"] {
            assert!(is_loopback_host(host), "{host}");
        }
        for host in ["example.com", "10.0.0.1", "192.168.1.5", "128.0.0.1", "localhost.evil", "fe80::1", ""] {
            assert!(!is_loopback_host(host), "{host}");
        }
    }

    #[test]
    fn header_filters() {
        for name in ["host", "connection", "cookie", "origin", "referer", "content-length", "upgrade", "expect"] {
            assert!(drop_request_header(name), "{name}");
        }
        for name in ["accept", "authorization", "content-type", "accept-encoding", "sec-fetch-site", "x-requested-with"] {
            assert!(!drop_request_header(name), "{name}");
        }
        for name in ["x-frame-options", "connection", "transfer-encoding"] {
            assert!(drop_response_header(name), "{name}");
        }
        for name in ["content-type", "content-length", "content-encoding", "set-cookie", "location", "content-security-policy", "cache-control"] {
            assert!(!drop_response_header(name), "{name}");
        }
    }

    #[test]
    fn websocket_upgrade_detection() {
        let mut headers = HeaderMap::new();
        assert!(!is_websocket_upgrade(&headers));
        headers.insert(header::UPGRADE, HeaderValue::from_static("WebSocket"));
        assert!(!is_websocket_upgrade(&headers));
        headers.insert(header::CONNECTION, HeaderValue::from_static("keep-alive, Upgrade"));
        assert!(is_websocket_upgrade(&headers));
    }

    #[test]
    fn status_and_wire_names() {
        let json = serde_json::to_value(BridgeGrant {
            target_port: 3000,
            bridge_port: Some(3081),
            bridge_host: None,
            entry_path: "/__codeg_bridge/enter/abc".into(),
            public_host: None,
        })
        .unwrap();
        assert_eq!(json["bridgePort"], 3081);
        assert_eq!(json["entryPath"], "/__codeg_bridge/enter/abc");
        assert!(json["publicHost"].is_null());
        assert!(json["bridgeHost"].is_null());

        // Addressed by hostname: no port of ours, so the browser keeps the
        // one it is already talking to.
        let json = serde_json::to_value(BridgeGrant {
            target_port: 3000,
            bridge_port: None,
            bridge_host: Some("3000.codeg.example".into()),
            entry_path: "/__codeg_bridge/enter/abc".into(),
            public_host: None,
        })
        .unwrap();
        assert!(json["bridgePort"].is_null());
        assert_eq!(json["bridgeHost"], "3000.codeg.example");

        let json = serde_json::to_value(BridgeStatus {
            enabled: true,
            ports: Vec::new(),
            public_host: None,
            host_pattern: Some("{port}.codeg.example".into()),
        })
        .unwrap();
        assert_eq!(json["hostPattern"], "{port}.codeg.example");
    }

    #[test]
    fn host_patterns_parse_or_are_refused() {
        assert_eq!(HostPattern::parse("auto"), Some(HostPattern::Subdomain));
        assert_eq!(HostPattern::parse("  AUTO "), Some(HostPattern::Subdomain));
        assert_eq!(
            HostPattern::parse("{port}.preview.example.com"),
            Some(HostPattern::Template {
                prefix: String::new(),
                suffix: ".preview.example.com".into()
            })
        );
        assert_eq!(
            HostPattern::parse("P{port}-codeg.example.com"),
            Some(HostPattern::Template {
                prefix: "p".into(),
                suffix: "-codeg.example.com".into()
            })
        );
        for raw in [
            // Says nothing about where the port goes.
            "preview.example.com",
            "",
            "off",
            // Twice is not one answer.
            "{port}.{port}.example.com",
            // Every numeric hostname would be the bridge's.
            "{port}",
            // Not a hostname: a port, a path, a scheme, a wildcard.
            "{port}.example.com:8080",
            "{port}.example.com/preview",
            "https://{port}.example.com",
            "*.{port}.example.com",
            "{port}..example.com",
            "-{port}.example.com",
            // A digit next to the port: `3000.example.com` would be port 300.
            "{port}0.example.com",
            "p9{port}.example.com",
        ] {
            assert_eq!(HostPattern::parse(raw), None, "{raw:?}");
        }
    }

    #[test]
    fn a_hostname_names_one_target_port() {
        let auto = HostPattern::Subdomain;
        let template = HostPattern::parse("p{port}-codeg.example.com").unwrap();

        assert_eq!(auto.render(3000, "codeg.example.com").as_deref(), Some("3000.codeg.example.com"));
        assert_eq!(auto.render(3000, "LOCALHOST").as_deref(), Some("3000.localhost"));
        assert_eq!(auto.target_of("3000.codeg.example.com"), Some(3000));
        assert_eq!(auto.target_of("3000.LOCALHOST"), Some(3000));
        assert_eq!(template.render(5173, "ignored").as_deref(), Some("p5173-codeg.example.com"));
        assert_eq!(template.target_of("p5173-codeg.example.com"), Some(5173));

        // `auto` has nothing to build on: an address is not a name, and a
        // workbench reached without a `Host` has none at all.
        assert_eq!(auto.render(3000, "192.168.1.5"), None);
        assert_eq!(auto.render(3000, "127.0.0.1"), None);
        assert_eq!(auto.render(3000, "::1"), None);
        assert_eq!(auto.render(3000, ""), None);
        assert_eq!(auto.render(3000, "not a host"), None);

        // The workbench's own hostname is not one of the bridge's.
        assert_eq!(auto.target_of("codeg.example.com"), None);
        assert_eq!(auto.target_of("localhost"), None);
        assert_eq!(template.target_of("codeg.example.com"), None);
        assert_eq!(template.target_of("p-codeg.example.com"), None);
        // Neither is a near miss, in either direction.
        assert_eq!(template.target_of("p5173-codeg.example.com.evil.test"), None);
        assert_eq!(template.target_of("evil.p5173-codeg.example.com"), None);
        assert_eq!(auto.target_of("3000"), None);
        assert_eq!(auto.target_of("3000."), None);
        assert_eq!(auto.target_of("a3000.example.com"), None);
        assert_eq!(auto.target_of("3000.a b"), None);
        // One spelling per port: no leading zeros, no port 0, nothing past
        // the end of the port space.
        assert_eq!(auto.target_of("03000.example.com"), None);
        assert_eq!(auto.target_of("0.example.com"), None);
        assert_eq!(auto.target_of("65536.example.com"), None);
        assert_eq!(auto.target_of("65535.example.com"), Some(65535));
    }

    #[test]
    fn a_hostname_is_read_out_of_the_authority() {
        assert_eq!(hostname_of("3000.codeg.example:8080").as_deref(), Some("3000.codeg.example"));
        assert_eq!(hostname_of(" 3000.Codeg.Example ").as_deref(), Some("3000.codeg.example"));
        // Addresses are not names — `3000.` in front of one names nothing.
        assert_eq!(hostname_of("[::1]:3080"), None);
        assert_eq!(hostname_of("127.0.0.1:3080"), None);
        assert_eq!(hostname_of("192.168.1.5"), None);
        assert_eq!(hostname_of(""), None);
        assert_eq!(hostname_of(":3080"), None);
    }

    #[test]
    fn the_two_ways_of_addressing_are_configured_apart() {
        let config = |ports: Option<&str>, pattern: Option<&str>| {
            BridgeConfig::from_values("127.0.0.1", 3080, ports, pattern, None)
        };
        // No pattern: the pool, as before.
        let ports = config(None, None).unwrap();
        assert_eq!(ports.ports, (3081..=3090).collect::<Vec<_>>());
        assert_eq!(ports.host_pattern, None);
        // A pattern: nothing of our own is bound, so no pool is claimed —
        // not even the default one nobody asked for.
        let hosts = config(None, Some("auto")).unwrap();
        assert!(hosts.ports.is_empty());
        assert_eq!(hosts.host_pattern, Some(HostPattern::Subdomain));
        assert!(config(Some("3081-3090"), Some("auto")).unwrap().ports.is_empty());
        // An empty pattern is no pattern.
        assert_eq!(config(None, Some("   ")).unwrap().host_pattern, None);
        // Either switch turns the bridge off, and an unreadable value in
        // either does too: a typo must not fall back to a default.
        assert!(config(Some("off"), Some("auto")).is_none());
        assert!(config(None, Some("preview.example.com")).is_none());
        assert!(config(Some("nonsense"), None).is_none());
    }

    #[test]
    fn every_authority_a_request_carries_is_read() {
        let request = |pairs: &[(&str, &'static str)], uri: &str| {
            let mut builder = Request::builder().uri(uri);
            for (name, value) in pairs {
                builder = builder.header(*name, *value);
            }
            builder.body(Body::empty()).unwrap()
        };
        let direct = |pairs: &[(&str, &'static str)]| {
            addressed_hostnames(&request(pairs, "/x"), false)
        };
        let proxied = |pairs: &[(&str, &'static str)]| {
            addressed_hostnames(&request(pairs, "/x"), true)
        };

        assert_eq!(direct(&[("host", "3000.Codeg.Test:8080")]), ["3000.codeg.test"]);
        // A forwarding header a page added to its own request does not
        // replace the `Host` it cannot drop — both are read, so naming the
        // workbench in one cannot carry the request off the bridge.
        assert_eq!(
            proxied(&[("host", "3000.codeg.test"), ("x-forwarded-host", "codeg.test")]),
            ["3000.codeg.test", "codeg.test"]
        );
        // A proxy that appends rather than replaces, and one that sends the
        // header twice: every value counts.
        assert_eq!(
            proxied(&[("host", "codeg:3080"), ("x-forwarded-host", "evil.test, 3000.codeg.test")]),
            ["codeg", "evil.test", "3000.codeg.test"]
        );
        // Without a declared proxy in front, forwarding headers are nobody's
        // word for anything.
        assert_eq!(
            direct(&[("host", "3000.codeg.test"), ("x-forwarded-host", "codeg.test")]),
            ["3000.codeg.test"]
        );
        // HTTP/2 carries the authority in the request line, with no `Host`
        // header at all.
        assert_eq!(
            addressed_hostnames(&request(&[], "http://3000.codeg.test:8080/x"), false),
            ["3000.codeg.test"]
        );
        // `Host` wins over the URI's authority where both are there, as it
        // does for every other reader of this request.
        assert_eq!(
            addressed_hostnames(
                &request(&[("host", "3000.codeg.test")], "http://9.codeg.test/x"),
                false
            ),
            ["3000.codeg.test"]
        );
        // Addresses name no bridge target, and nothing at all is nothing.
        assert!(direct(&[("host", "127.0.0.1:3080")]).is_empty());
        assert!(direct(&[]).is_empty());
    }

    #[test]
    fn a_name_no_target_holds_stays_the_bridges_once_handed_out() {
        let auto = HostPattern::Subdomain;
        let template = HostPattern::parse("{port}.preview.example.com").unwrap();
        let names = |raw: &[&str]| raw.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let none = HashSet::new();
        let handed_out = HashSet::from(["3000.codeg.test".to_string()]);

        // A wildcard the operator handed over: the bridge answers for every
        // name under it, open target or not, handed out or not.
        assert!(unclaimed_is_the_bridges(Some(&template), &names(&["3000.preview.example.com"]), &none));
        assert!(unclaimed_is_the_bridges(
            Some(&template),
            &names(&["codeg.example.com", "3000.preview.example.com"]),
            &none
        ));
        assert!(!unclaimed_is_the_bridges(Some(&template), &names(&["codeg.example.com"]), &none));
        assert!(!unclaimed_is_the_bridges(Some(&template), &names(&["preview.example.com"]), &none));
        // `auto` claims nothing it did not hand out: the shape alone would
        // take a workbench on `3000.codeg.test` away from codeg.
        assert!(!unclaimed_is_the_bridges(Some(&auto), &names(&["3000.codeg.test"]), &none));
        assert!(!unclaimed_is_the_bridges(Some(&auto), &names(&[]), &none));
        // But once it has handed a name out, the name is the bridge's for
        // as long as this process runs — the target can idle away, the
        // origin the page ran on does not.
        assert!(unclaimed_is_the_bridges(Some(&auto), &names(&["3000.codeg.test"]), &handed_out));
        assert!(!unclaimed_is_the_bridges(Some(&auto), &names(&["3001.codeg.test"]), &handed_out));
        // And it stays the bridge's with no configuration at all behind it:
        // switching the bridge off, or pointing it somewhere else, does not
        // reach the browser's memory of that origin.
        assert!(unclaimed_is_the_bridges(None, &names(&["3000.codeg.test"]), &handed_out));
        assert!(!unclaimed_is_the_bridges(None, &names(&["3001.codeg.test"]), &handed_out));
        assert!(!unclaimed_is_the_bridges(None, &names(&["3000.preview.example.com"]), &none));
    }

    #[test]
    fn a_listeners_cookie_is_named_after_the_way_it_is_reached() {
        let listener = |bridge_port: Option<u16>| Listener {
            target_port: 3000,
            bridge_port,
            hosts: Mutex::new(HashSet::new()),
            trust_forwarded: false,
            caps: Mutex::new(Vec::new()),
            holds: Mutex::new(HashSet::new()),
            last_seen: Mutex::new(Instant::now()),
            shutdown: Mutex::new(None),
            task: Mutex::new(None),
        };
        assert_eq!(listener(Some(3081)).cookie_name(), "codeg-bridge-3081");
        // Addressed by hostname there is no bridge port; the target port is
        // what the hostname says, and the cookie is host-only anyway.
        assert_eq!(listener(None).cookie_name(), "codeg-bridge-3000");
    }

    #[test]
    fn only_the_listeners_own_page_may_ask() {
        let headers = |pairs: &[(&str, &'static str)]| {
            let mut headers = HeaderMap::new();
            for (name, value) in pairs {
                headers.append(HeaderName::from_bytes(name.as_bytes()).unwrap(), HeaderValue::from_static(value));
            }
            headers
        };
        let direct = |pairs: &[(&str, &'static str)]| same_origin_initiator(&headers(pairs), false);
        let proxied = |pairs: &[(&str, &'static str)]| same_origin_initiator(&headers(pairs), true);
        // Fetch Metadata decides when it is there, whatever else is.
        assert!(direct(&[("sec-fetch-site", "same-origin")]));
        assert!(direct(&[("sec-fetch-site", "none")]));
        assert!(!direct(&[("sec-fetch-site", "same-site")]));
        assert!(!direct(&[("sec-fetch-site", "cross-site")]));
        assert!(!direct(&[
            ("sec-fetch-site", "same-site"),
            ("host", "h:3081"),
            ("origin", "http://h:3081"),
        ]));
        // Without it (plain http): Origin, else Referer, must name the
        // authority the request was addressed to.
        assert!(direct(&[("host", "h:3081"), ("origin", "http://h:3081")]));
        assert!(direct(&[("host", "H:3081"), ("origin", "http://h:3081")]));
        assert!(!direct(&[("host", "h:3081"), ("origin", "http://h:3082")]));
        assert!(!direct(&[("host", "h:3081"), ("origin", "http://other:3081")]));
        assert!(!direct(&[("host", "h:3081"), ("origin", "null")]));
        assert!(direct(&[("host", "h:3081"), ("referer", "http://h:3081/")]));
        assert!(direct(&[("host", "h:3081"), ("referer", "http://h:3081/a/b?c")]));
        assert!(!direct(&[("host", "h:3081"), ("referer", "http://h:3082/")]));
        // Origin wins over Referer when both are there.
        assert!(!direct(&[
            ("host", "h:3081"),
            ("origin", "http://h:3082"),
            ("referer", "http://h:3081/"),
        ]));
        // Nothing to go on: refused (a typed address, a hidden referrer).
        assert!(!direct(&[("host", "h:3081")]));
        assert!(!direct(&[]));
        // Forwarding headers count only behind a declared proxy: a page can
        // ask its browser to send `X-Forwarded-Host`, so without one it is
        // ignored in favour of `Host`.
        assert!(proxied(&[
            ("host", "127.0.0.1:3081"),
            ("x-forwarded-host", "codeg.example"),
            ("x-forwarded-proto", "https"),
            ("origin", "https://codeg.example"),
        ]));
        assert!(!proxied(&[
            ("host", "127.0.0.1:3081"),
            ("x-forwarded-host", "codeg.example"),
            ("origin", "http://127.0.0.1:3081"),
        ]));
        assert!(!direct(&[
            ("host", "h:3081"),
            ("x-forwarded-host", "h:3082"),
            ("origin", "http://h:3082"),
        ]));
        assert!(direct(&[
            ("host", "h:3081"),
            ("x-forwarded-host", "h:3082"),
            ("origin", "http://h:3081"),
        ]));
        assert_eq!(url_authority("https://h").as_deref(), Some("h:443"));
        assert_eq!(url_authority("http://h").as_deref(), Some("h:80"));
        assert_eq!(url_authority("http://[::1]:3081/x").as_deref(), Some("[::1]:3081"));
        assert_eq!(url_authority("null"), None);
        assert_eq!(url_authority("/relative"), None);
        assert_eq!(url_authority("ftp://h:21"), None);
    }

    #[test]
    fn bounce_page_goes_to_the_path_and_escapes_it() {
        let page = bounce_page("/docs?x=1#top");
        assert!(page.contains("content=\"0;url=/docs?x=1#top\""));
        assert!(page.contains("location.replace(\"/docs?x=1#top\")"));
        let hostile = bounce_page("/a\"><script>alert(1)</script>");
        // The attribute is entity-escaped, the script literal cannot close
        // the block: exactly one `</script>` remains, the page's own.
        assert!(!hostile.contains("<script>alert"));
        assert!(hostile.contains("url=/a&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;\""));
        assert!(hostile.contains("location.replace(\"/a\\\"\\u003e\\u003cscript\\u003ealert(1)\\u003c/script\\u003e\")"));
        assert_eq!(hostile.matches("</script>").count(), 1);
    }

    #[test]
    fn frame_ancestors_is_dropped_from_a_csp() {
        let strip = |raw: &'static str| {
            without_frame_ancestors(&HeaderValue::from_static(raw)).map(|v| v.to_str().unwrap().to_string())
        };
        assert_eq!(
            strip("default-src 'self'; frame-ancestors 'none'; img-src *").as_deref(),
            Some("default-src 'self'; img-src *")
        );
        assert_eq!(strip("FRAME-ANCESTORS 'self'"), None);
        assert_eq!(strip("default-src 'self'").as_deref(), Some("default-src 'self'"));
        // A source expression that merely contains the word stays.
        assert_eq!(
            strip("img-src https://frame-ancestors.example").as_deref(),
            Some("img-src https://frame-ancestors.example")
        );
        // Several policies in one header: each loses the directive; a
        // policy left empty disappears.
        assert_eq!(
            strip("default-src 'self', frame-ancestors 'none', img-src *; frame-ancestors 'self'").as_deref(),
            Some("default-src 'self', img-src *")
        );
        assert_eq!(strip("frame-ancestors 'none', frame-ancestors 'self'"), None);
    }

    #[test]
    fn forwarded_proto_marks_secure_cookies() {
        let mut headers = HeaderMap::new();
        assert!(!forwarded_https(&headers));
        headers.insert("x-forwarded-proto", HeaderValue::from_static("https, http"));
        assert!(forwarded_https(&headers));
        headers.insert("x-forwarded-proto", HeaderValue::from_static("http"));
        assert!(!forwarded_https(&headers));
    }
}
