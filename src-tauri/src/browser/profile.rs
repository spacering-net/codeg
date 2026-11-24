//! Browser profiles: where tabs keep cookies, caches and storage, which
//! proxy their traffic goes through, and the one user-agent exception.
//!
//! Why tabs need a container of their own: the workspace webview keeps the
//! app's own localStorage and IndexedDB in WebKit's default data store (macOS)
//! / the app's WebView2 user-data folder (Windows), so "clear browsing data"
//! must never run against the store the app lives in, and a page opened in a
//! tab should not share a cookie jar with the app or with remote-workspace
//! windows. A proxy is a property of that same container
//! (`WKWebsiteDataStore.proxyConfigurations`, WebView2 environment arguments,
//! the WebKitGTK network session), which is the second reason.
//!
//! A profile is named by an id the frontend chooses (`default` always
//! exists, the others are minted when the user creates one in the settings);
//! everything platform-specific is derived from the id — a stable data-store
//! identifier on macOS 14+, a directory on Windows / Linux — so the backend
//! keeps no list of its own. Every profile shares the app's proxy setting —
//! except the remote-egress profiles (`remote-<connection id>`), which the
//! backend names itself, one per remote connection, and whose proxy is that
//! connection's egress (`browser/egress.rs`).

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Url};

pub const DEFAULT_PROFILE_ID: &str = "default";

/// Longest id accepted: ids become directory names and store identifiers.
pub const MAX_PROFILE_ID_LEN: usize = 40;

/// A profile id: `default`, or what the frontend minted — lowercase ASCII
/// letters, digits and dashes, starting with a letter or digit. A safe
/// directory name on every platform, and nothing that could be a path.
pub fn valid_profile_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_PROFILE_ID_LEN
        && id
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Prefix of the remote-egress profiles: `remote-<connection id>`. Never an
/// id the frontend mints (it mints `p-…`), and refused from it at the command
/// boundary (`browser_open_tab` takes the connection instead): a remote
/// profile's proxy is the one thing about it that must not be anything else,
/// and only the egress path sets it up.
pub const REMOTE_PROFILE_PREFIX: &str = "remote-";

/// The remote-egress profile of a remote connection.
pub fn remote_profile_id(connection_id: i32) -> String {
    format!("{REMOTE_PROFILE_PREFIX}{connection_id}")
}

pub fn is_remote_profile(profile_id: &str) -> bool {
    profile_id.starts_with(REMOTE_PROFILE_PREFIX)
}

/// The remote connection a remote profile belongs to.
pub fn remote_connection_id(profile_id: &str) -> Option<i32> {
    profile_id.strip_prefix(REMOTE_PROFILE_PREFIX)?.parse().ok()
}

/// A remote profile's egress: the SOCKS listener its traffic goes to, and the
/// remote host that traffic comes out of (what its tabs say they go through).
#[derive(Debug, Clone)]
struct RemoteEgress {
    socks: std::net::SocketAddr,
    host: String,
}

/// Every remote profile's egress. Set before the profile's first tab; the
/// listener is fixed for the process (see `browser/egress.rs`), the host is
/// refreshed at every open, as the connection's address may have been edited.
static REMOTE_EGRESS: Mutex<Option<HashMap<String, RemoteEgress>>> = Mutex::new(None);

fn remote_egress_entry(profile_id: &str) -> Option<RemoteEgress> {
    REMOTE_EGRESS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()?
        .get(profile_id)
        .cloned()
}

pub fn set_remote_egress(profile_id: &str, socks: std::net::SocketAddr, host: &str) {
    REMOTE_EGRESS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get_or_insert_with(HashMap::new)
        .insert(profile_id.to_string(), RemoteEgress { socks, host: host.to_string() });
}

/// The remote profile's connection is gone: nothing may be built in the
/// profile any more (`prepare` refuses a remote profile without an egress).
pub fn forget_remote_egress(profile_id: &str) {
    if let Some(map) = REMOTE_EGRESS.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
        map.remove(profile_id);
    }
}

fn remote_egress(profile_id: &str) -> Option<BrowserProxy> {
    let socks = remote_egress_entry(profile_id)?.socks;
    Some(BrowserProxy {
        scheme: ProxyScheme::Socks5,
        host: socks.ip().to_string(),
        port: socks.port(),
    })
}

/// The remote host a tab of `profile_id` reaches the network from: `None`
/// for every profile but a remote one.
pub fn remote_host(profile_id: &str) -> Option<String> {
    if !is_remote_profile(profile_id) {
        return None;
    }
    remote_egress_entry(profile_id).map(|egress| egress.host)
}

/// The proxy a profile's tabs use: its egress for a remote profile (which
/// must have been set up — a remote profile without its egress would send
/// the remote host's addresses to this computer), the app's setting for
/// every other one.
pub fn proxy_for(profile_id: &str) -> Result<Option<BrowserProxy>, String> {
    if is_remote_profile(profile_id) {
        return remote_egress(profile_id)
            .map(Some)
            .ok_or_else(|| format!("browser profile {profile_id} has no egress"));
    }
    current_proxy()
}

/// `WKWebsiteDataStore` identifier of the default profile (macOS 14+):
/// uuid5(NAMESPACE_URL, "https://codeg.app/browser-profile/default"). Fixed so
/// the same store is found again after a restart or an update; the other
/// profiles' identifiers come from `data_store_identifier`, which must keep
/// producing this one for `default` (there is a test).
pub const DEFAULT_DATA_STORE_IDENTIFIER: [u8; 16] = [
    0xb5, 0xb1, 0xc6, 0x31, 0xe0, 0x8c, 0x58, 0xf2, 0xba, 0x41, 0x9d, 0x11, 0x62, 0x85, 0x6f, 0x26,
];

/// The data-store identifier of a profile (macOS 14+): a version-5 UUID of
/// `https://codeg.app/browser-profile/<id>` in the URL namespace, so the
/// same store is found again after a restart or an update and no two
/// profiles can share one.
pub fn data_store_identifier(profile_id: &str) -> [u8; 16] {
    use sha1::{Digest, Sha1};
    // RFC 4122 URL namespace, 6ba7b811-9dad-11d1-80b4-00c04fd430c8.
    const NAMESPACE_URL: [u8; 16] = [
        0x6b, 0xa7, 0xb8, 0x11, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8,
    ];
    let mut hasher = Sha1::new();
    hasher.update(NAMESPACE_URL);
    hasher.update(format!("https://codeg.app/browser-profile/{profile_id}").as_bytes());
    let digest = hasher.finalize();
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
    bytes
}

/// Directory holding the profile's data on Windows (WebView2 user-data
/// folder) and Linux (WebKitGTK data directory). Unused on macOS, where the
/// data store identifier plays this role.
pub fn directory(profile_id: &str) -> PathBuf {
    crate::paths::codeg_browser_profiles_root().join(profile_id)
}

/// Whether more than the default profile can exist here. macOS keeps the
/// profiles apart through per-identifier data stores, which arrived in
/// macOS 14; before that every tab shares WebKit's default store and a
/// second profile would be a name without a container.
pub fn profiles_supported() -> bool {
    #[cfg(target_os = "macos")]
    {
        crate::browser::shim::macos::supports_isolated_profile()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProxyScheme {
    Http,
    Socks5,
}

/// A proxy in the shape every webview engine's hook can take.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowserProxy {
    pub scheme: ProxyScheme,
    pub host: String,
    pub port: u16,
}

impl BrowserProxy {
    /// `scheme://host:port` — what WebView2's `--proxy-server` and tauri's
    /// `proxy_url` accept.
    pub fn to_url_string(&self) -> String {
        let scheme = match self.scheme {
            ProxyScheme::Http => "http",
            ProxyScheme::Socks5 => "socks5",
        };
        let host = if self.host.contains(':') && !self.host.starts_with('[') {
            format!("[{}]", self.host)
        } else {
            self.host.clone()
        };
        format!("{scheme}://{host}:{}", self.port)
    }
}

/// Parse the app's (already normalized) proxy URL into what a webview can
/// use. `http`, `socks5` and `socks5h` are accepted — the engines resolve
/// names proxy-side for SOCKS regardless of the `h`. `https` (TLS to the proxy
/// itself) is refused: none of the three engines' proxy hooks express it, so
/// pretending it is plain HTTP CONNECT would send cleartext to a TLS port.
pub fn parse_proxy(raw: &str) -> Result<BrowserProxy, String> {
    let url = Url::parse(raw.trim()).map_err(|e| format!("invalid proxy URL {raw:?}: {e}"))?;
    let scheme = match url.scheme() {
        "http" => ProxyScheme::Http,
        "socks5" | "socks5h" => ProxyScheme::Socks5,
        other => {
            return Err(format!(
                "the built-in browser cannot use a {other}:// proxy (http and socks5 only)"
            ))
        }
    };
    let host = url
        .host_str()
        .filter(|h| !h.is_empty())
        .ok_or_else(|| format!("proxy URL {raw:?} has no host"))?
        .trim_matches(|c| c == '[' || c == ']')
        .to_string();
    let port = url.port().unwrap_or(match scheme {
        ProxyScheme::Http => 80,
        ProxyScheme::Socks5 => 1080,
    });
    Ok(BrowserProxy { scheme, host, port })
}

/// The proxy browser tabs should use right now.
///
/// The source is the process environment: the app's "system proxy" setting
/// writes `HTTP(S)_PROXY` / `ALL_PROXY` when enabled and clears them when
/// disabled, and values a shell or service manager exported are honoured the
/// same way the app honours them for its own requests and for agent
/// processes. `Err` means a proxy is configured but the browser cannot use it.
pub fn current_proxy() -> Result<Option<BrowserProxy>, String> {
    match crate::network::proxy::effective_proxy_url() {
        None => Ok(None),
        Some(url) => parse_proxy(&url).map(Some),
    }
}

/// How the platform takes a proxy change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProxyApplies {
    /// Open and new tabs use the new proxy for their next connections.
    Live,
    /// Tabs opened after the change use it; open tabs keep the old one.
    NextTab,
    /// The engine fixes the proxy for the process; restart to change it.
    Restart,
    /// This platform (version) cannot proxy browser tabs.
    Unsupported,
}

/// Wire shape of the proxy part of `browser_capabilities`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserProxyStatus {
    /// Proxy browser tabs use, as `scheme://host:port`; `None` = direct.
    pub url: Option<String>,
    pub applies: ProxyApplies,
    /// Why `url` is `None` although a proxy is configured (unsupported
    /// scheme or platform), or why the shown proxy is not the configured one
    /// (Windows until a restart).
    pub reason: Option<String>,
}

/// Windows: WebView2 reads the proxy from the environment's browser
/// arguments, which are fixed for a user-data folder for the life of the
/// process — a later environment with different arguments fails to create.
/// The first browser webview therefore freezes the proxy for this run.
#[cfg(target_os = "windows")]
static FROZEN_PROXY: std::sync::OnceLock<Option<BrowserProxy>> = std::sync::OnceLock::new();

/// Windows: the proxy every browser webview of this process is built with.
#[cfg(target_os = "windows")]
pub fn frozen_proxy() -> Option<BrowserProxy> {
    FROZEN_PROXY
        .get_or_init(|| current_proxy().ok().flatten())
        .clone()
}

/// Browser arguments for WebView2. wry's own default flags come first, then
/// silent Integrated Windows Authentication is switched off for every host
/// (an arbitrary page must not be able to make the engine present the user's
/// Windows credentials), then the proxy. wry only injects `--proxy-server`
/// itself when no arguments are given at all, so once we hand it a string we
/// own the whole thing — hence one function for the entire string.
///
/// The string does not depend on the profile: WebView2 requires every
/// environment on one user-data folder to be created with identical
/// arguments, and one string for all profiles satisfies that by
/// construction (a profile that needs different arguments — a remote-egress
/// proxy — gets its own folder, never a second string on a shared one).
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn windows_browser_args(proxy: Option<&BrowserProxy>) -> String {
    let mut args = String::from(
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --auth-server-allowlist=",
    );
    if let Some(proxy) = proxy {
        args.push_str(" --proxy-server=");
        args.push_str(&proxy.to_url_string());
    }
    args
}

/// Browser arguments for WebView2 for `profile_id`: a remote profile routes
/// everything through its egress — loopback included, which Chromium would
/// otherwise send straight to this machine (`<-loopback>` switches that
/// implicit exception off) — and every other profile uses the app's proxy as
/// the process froze it. A remote profile has a folder of its own, so its
/// string never meets another on one folder.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn windows_args_for(profile_id: &str) -> Result<String, String> {
    if is_remote_profile(profile_id) {
        let proxy = proxy_for(profile_id)?;
        let mut args = windows_browser_args(proxy.as_ref());
        args.push_str(" --proxy-bypass-list=<-loopback>");
        return Ok(args);
    }
    #[cfg(target_os = "windows")]
    {
        Ok(windows_browser_args(frozen_proxy().as_ref()))
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(windows_browser_args(current_proxy().ok().flatten().as_ref()))
    }
}

pub fn proxy_status() -> BrowserProxyStatus {
    platform_proxy_status()
}

#[cfg(target_os = "macos")]
fn platform_proxy_status() -> BrowserProxyStatus {
    if !crate::browser::shim::macos::supports_isolated_profile() {
        return BrowserProxyStatus {
            url: None,
            applies: ProxyApplies::Unsupported,
            reason: Some("proxying browser tabs needs macOS 14 or later".to_string()),
        };
    }
    status_for(ProxyApplies::Live, current_proxy())
}

#[cfg(target_os = "windows")]
fn platform_proxy_status() -> BrowserProxyStatus {
    let frozen = frozen_proxy();
    let mut status = status_for(ProxyApplies::Restart, current_proxy());
    if FROZEN_PROXY.get().is_some() && status.url != frozen.as_ref().map(BrowserProxy::to_url_string) {
        status.reason = Some("restart codeg for browser tabs to use the new proxy".to_string());
        status.url = frozen.map(|p| p.to_url_string());
    }
    status
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn platform_proxy_status() -> BrowserProxyStatus {
    status_for(ProxyApplies::NextTab, current_proxy())
}

fn status_for(applies: ProxyApplies, proxy: Result<Option<BrowserProxy>, String>) -> BrowserProxyStatus {
    match proxy {
        Ok(proxy) => BrowserProxyStatus {
            url: proxy.map(|p| p.to_url_string()),
            applies,
            reason: None,
        },
        Err(reason) => BrowserProxyStatus {
            url: None,
            applies,
            reason: Some(reason),
        },
    }
}

/// Whether browsing data lives apart from the app's own web storage.
pub fn isolated_storage() -> bool {
    #[cfg(target_os = "macos")]
    {
        crate::browser::shim::macos::supports_isolated_profile()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

/// Whether `profile_id` names a profile a tab can be opened in here: an
/// acceptable id that, on this platform, can be a container of its own.
pub fn check(profile_id: &str) -> Result<(), String> {
    if !valid_profile_id(profile_id) {
        return Err(format!("invalid browser profile id {profile_id:?}"));
    }
    if profile_id != DEFAULT_PROFILE_ID && !profiles_supported() {
        return Err("browser profiles other than the default need macOS 14 or later".to_string());
    }
    Ok(())
}

/// Get a profile ready for a tab (see `check`): its directory exists
/// (Windows / Linux) and, on macOS, its data store exists and points at the
/// current proxy. Idempotent and cheap after the first call.
pub fn prepare(app: &AppHandle, profile_id: &str) -> Result<(), String> {
    check(profile_id)?;
    // Not a single tab of a remote profile without its egress, on any
    // platform: built with the app's proxy (or none), it would reach this
    // computer instead of the remote host.
    if is_remote_profile(profile_id) && remote_egress(profile_id).is_none() {
        return Err(format!("browser profile {profile_id} has no egress"));
    }
    #[cfg(target_os = "macos")]
    {
        let proxy = if is_remote_profile(profile_id) {
            proxy_for(profile_id)?
        } else {
            proxy_or_none(current_proxy())
        };
        let profile_id = profile_id.to_string();
        run_on_main(app, move || crate::browser::shim::macos::ensure_profile(&profile_id, proxy))?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        let dir = directory(profile_id);
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("cannot create browser profile directory {}: {e}", dir.display()))
    }
}

/// The app's proxy setting changed. macOS re-points every profile's store,
/// which open tabs pick up for their next connections; the other platforms
/// take the change at the next tab (Linux) or restart (Windows) — see
/// `ProxyApplies`.
pub fn proxy_settings_changed(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let proxy = current_proxy();
        if let Err(err) = run_on_main(app, move || {
            crate::browser::shim::macos::apply_proxy_to_profiles(proxy_or_none(proxy))
        })
        .and_then(|r| r)
        {
            tracing::warn!("[browser] could not apply the proxy to the browser profiles: {err}");
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
    }
}

/// Who is using a profile's store right now, and which profiles are being
/// deleted. Opening a tab, adopting a popup and clearing data each hold an
/// `Admission` for the whole of their work (through the insert into the
/// registry, through the clear); a deletion marks the profile — refusing
/// new admissions — and then waits for the ones in flight to finish before
/// it touches the store. Without both halves, an open that had passed its
/// check could still build a webview on a store whose deletion had begun.
#[derive(Default)]
struct Occupancy {
    removing: HashSet<String>,
    in_flight: HashMap<String, usize>,
}

static OCCUPANCY: Mutex<Option<Occupancy>> = Mutex::new(None);

fn occupancy() -> std::sync::MutexGuard<'static, Option<Occupancy>> {
    OCCUPANCY.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Holds the profile in use for as long as the last clone lives. An
/// operation that hands work to the engine and gets told when it is done
/// (a clear) gives its native completion callback a `share()`, so a caller
/// that stops waiting cannot end the admission before the engine is done.
pub struct Admission(Arc<AdmissionMark>);

struct AdmissionMark(String);

impl Drop for AdmissionMark {
    fn drop(&mut self) {
        if let Some(state) = occupancy().as_mut() {
            if let Some(count) = state.in_flight.get_mut(&self.0) {
                *count = count.saturating_sub(1);
                if *count == 0 {
                    state.in_flight.remove(&self.0);
                }
            }
        }
    }
}

impl Admission {
    /// Another holder of the same admission.
    pub fn share(&self) -> Admission {
        Admission(self.0.clone())
    }
}

/// Take the profile into use for an operation; refused while the profile is
/// being deleted.
pub fn admit(profile_id: &str) -> Result<Admission, String> {
    let mut guard = occupancy();
    let state = guard.get_or_insert_with(Occupancy::default);
    if state.removing.contains(profile_id) {
        return Err("this browser profile is being deleted".to_string());
    }
    *state.in_flight.entry(profile_id.to_string()).or_insert(0) += 1;
    Ok(Admission(Arc::new(AdmissionMark(profile_id.to_string()))))
}

/// Marks a profile as being deleted for as long as the last clone lives —
/// the deletion command holds one, and so does every native completion
/// callback it starts, so a command that times out cannot lift the mark
/// while WebKit is still working on the store.
pub struct RemovalGuard(Arc<RemovalMark>);

struct RemovalMark(String);

impl Drop for RemovalMark {
    fn drop(&mut self) {
        if let Some(state) = occupancy().as_mut() {
            state.removing.remove(&self.0);
        }
    }
}

impl RemovalGuard {
    /// Another holder of the same mark (for a callback that outlives the
    /// command).
    pub fn share(&self) -> RemovalGuard {
        RemovalGuard(self.0.clone())
    }
}

/// Start deleting `profile_id`: from now on `admit` refuses it. A second
/// deletion of the same profile while one is running is refused.
pub fn begin_removal(profile_id: &str) -> Result<RemovalGuard, String> {
    let mut guard = occupancy();
    let state = guard.get_or_insert_with(Occupancy::default);
    if !state.removing.insert(profile_id.to_string()) {
        return Err(format!("browser profile {profile_id:?} is already being deleted"));
    }
    Ok(RemovalGuard(Arc::new(RemovalMark(profile_id.to_string()))))
}

pub fn is_removing(profile_id: &str) -> bool {
    occupancy()
        .as_ref()
        .is_some_and(|state| state.removing.contains(profile_id))
}

/// Operations holding the profile in use right now.
pub fn in_flight(profile_id: &str) -> usize {
    occupancy()
        .as_ref()
        .and_then(|state| state.in_flight.get(profile_id).copied())
        .unwrap_or(0)
}

/// How long a deletion waits for the profile's in-flight operations (an
/// open building its webview, a clear) before giving up.
pub const REMOVAL_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);

/// Wait until nothing holds the profile in use (deletion has already been
/// marked, so nothing new can). `false` when `REMOVAL_DRAIN_TIMEOUT` passes
/// first.
pub async fn wait_until_idle(profile_id: &str) -> bool {
    let deadline = std::time::Instant::now() + REMOVAL_DRAIN_TIMEOUT;
    while in_flight(profile_id) > 0 {
        if std::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    true
}

/// Windows / Linux: delete a profile's directory, and with it everything the
/// engine stored for it. The caller has made sure no tab of the profile is
/// open (and, on Windows, dropped the web context that held the folder).
#[cfg(not(target_os = "macos"))]
pub fn remove_directory(profile_id: &str) -> Result<(), String> {
    let dir = directory(profile_id);
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("cannot remove browser profile directory {}: {e}", dir.display())),
    }
}

// ---------------------------------------------------------------------------
// The user-agent exception for Google's sign-in pages
// ---------------------------------------------------------------------------
//
// Google refuses to sign a user in from an "embedded browser" — a WebKit or
// WebView2 view whose user agent is not one of the browsers it knows — with
// "This browser or app may not be secure". Presenting a Firefox identity to
// its sign-in hosts, and to them only, is what every embedded browser does;
// everywhere else the engine's own user agent stays, because bot checks
// (Cloudflare Turnstile among them) reject a user agent that does not match
// the engine that sent it. The switch is a user preference, on by default,
// pushed here by the frontend like the site rules.

/// Hosts that get the sign-in user agent (and their subdomains).
const GOOGLE_SIGN_IN_HOSTS: [&str; 2] = ["accounts.google.com", "accounts.youtube.com"];

/// Environment variable naming further hosts (comma-separated) that get the
/// sign-in identity: another provider with the same refusal, or a server of
/// one's own to check the switch against. Read once per process.
pub const SIGN_IN_HOSTS_ENV: &str = "CODEG_BROWSER_SIGN_IN_HOSTS";

fn extra_sign_in_hosts() -> &'static [String] {
    static EXTRA: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
    EXTRA.get_or_init(|| parse_host_list(&std::env::var(SIGN_IN_HOSTS_ENV).unwrap_or_default()))
}

fn parse_host_list(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|h| h.trim().trim_end_matches('.').to_ascii_lowercase())
        .filter(|h| !h.is_empty())
        .collect()
}

fn host_matches(host: &str, known: &str) -> bool {
    host == known || host.strip_suffix(known).is_some_and(|prefix| prefix.ends_with('.'))
}

/// Whether `host` (or a parent domain of it) is one of the sign-in hosts:
/// Google's, plus whatever `CODEG_BROWSER_SIGN_IN_HOSTS` names.
pub fn is_google_sign_in_host(host: &str) -> bool {
    is_sign_in_host_among(host, extra_sign_in_hosts())
}

fn is_sign_in_host_among(host: &str, extra: &[String]) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    GOOGLE_SIGN_IN_HOSTS.iter().any(|known| host_matches(&host, known))
        || extra.iter().any(|known| host_matches(&host, known))
}

/// Firefox ESR's user agent for this platform. Firefox freezes the macOS
/// version at 10.15 and the Windows one at 10.0 in its own string; sending
/// anything else would be the odd one out.
#[cfg(target_os = "macos")]
pub const SIGN_IN_USER_AGENT: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0";
#[cfg(target_os = "windows")]
pub const SIGN_IN_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0";
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub const SIGN_IN_USER_AGENT: &str =
    "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";

static SIGN_IN_USER_AGENT_ENABLED: AtomicBool = AtomicBool::new(true);

pub fn set_sign_in_user_agent(enabled: bool) {
    SIGN_IN_USER_AGENT_ENABLED.store(enabled, Ordering::Relaxed);
}

pub fn sign_in_user_agent_enabled() -> bool {
    SIGN_IN_USER_AGENT_ENABLED.load(Ordering::Relaxed)
}

/// The user agent a tab must present for a main-frame navigation to `url`:
/// the sign-in identity for Google's sign-in hosts while the switch is on,
/// the platform's default identity everywhere else (`None` where that is the
/// engine's own string, untouched).
pub fn user_agent_for(url: &Url) -> Option<&'static str> {
    if sign_in_user_agent_enabled() && url.host_str().is_some_and(is_google_sign_in_host) {
        return Some(SIGN_IN_USER_AGENT);
    }
    default_user_agent()
}

/// What a log line calls the identity a tab was just given.
pub fn user_agent_name(user_agent: Option<&str>) -> &'static str {
    match user_agent {
        Some(value) if value == SIGN_IN_USER_AGENT => "sign-in identity",
        Some(_) => "default identity",
        None => "engine's own",
    }
}

// ---------------------------------------------------------------------------
// The identity every other host sees
// ---------------------------------------------------------------------------

/// What a tab presents when no host asks for another identity — `None` where
/// the engine already names a browser and nothing needs saying.
///
/// macOS is the exception. WKWebView's own string ends at `(KHTML, like
/// Gecko)`: `Version/… Safari/…` are Safari's tokens and an embedder only gets
/// them by asking, so what a site sniffing that string sees is an engine with
/// no browser on it. `https://www.baidu.com/` answers it with a five-line
/// document whose whole content is `location.replace(https → http)`; WebKit
/// upgrades that http navigation straight back to https, gets the same
/// document again, and the tab flickers through the loop about seventeen times
/// a second until it is closed. Measured in a bare WKWebView with none of this
/// app's code in it (170 main-frame loads in 10 s), and measured to load once
/// with the tokens appended — it is the engine's identity that is short, not
/// something we do to it.
///
/// This is not the borrowed identity of the sign-in hosts above: nothing here
/// is claimed that is not true. These tabs are WebKit, at the version Safari
/// ships on this release — so a bot check that rejects a user agent not
/// matching the engine behind it (Turnstile among them) still sees a pair that
/// matches.
#[cfg(target_os = "macos")]
pub fn default_user_agent() -> Option<&'static str> {
    static USER_AGENT: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    Some(USER_AGENT.get_or_init(|| {
        let (major, minor) = crate::browser::shim::macos::macos_version();
        // The prefix is Safari's own and frozen by Apple: `10_15_7` and
        // `605.1.15` are what Safari sends on every release since, Apple
        // Silicon included, so it is copied rather than derived.
        format!(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 \
             (KHTML, like Gecko) Version/{}.{minor} Safari/605.1.15",
            safari_major(major)
        )
    }))
}

/// Safari's marketing version on a macOS release: the two were aligned in
/// macOS 26, and before that Safari ran three majors ahead (macOS 11 →
/// Safari 14 … macOS 15 → Safari 18).
#[cfg(target_os = "macos")]
fn safari_major(macos_major: isize) -> isize {
    if macos_major >= 26 {
        macos_major
    } else {
        macos_major.max(11) + 3
    }
}

/// Windows and Linux need nothing: WebView2's own string is Chrome's, and
/// WebKitGTK's already carries `Version/… Safari/…`.
#[cfg(not(target_os = "macos"))]
pub fn default_user_agent() -> Option<&'static str> {
    None
}

/// Whether this platform switches the user agent per navigation. It takes a
/// hook on the navigation decision, which embedded tabs have on macOS
/// (`decidePolicyForNavigationAction:`) and on Windows (`NavigationStarting`).
pub fn sign_in_user_agent_supported() -> bool {
    // Wherever a navigation can be caught before the request goes out AND the
    // frame it belongs to is known: the embedded surface's navigation delegate
    // on macOS and Windows. Not Linux — WebKitGTK's user agent belongs to the
    // whole webview and its navigation decision does not say which frame is
    // asking, so an iframe could put the borrowed identity on the top-level
    // page's requests (see `shim/linux.rs`).
    cfg!(all(
        any(target_os = "macos", target_os = "windows"),
        feature = "browser-child"
    ))
}

/// An unusable proxy (unsupported scheme) means direct connections, not a
/// failed tab: the settings section explains why.
#[cfg(target_os = "macos")]
fn proxy_or_none(proxy: Result<Option<BrowserProxy>, String>) -> Option<BrowserProxy> {
    match proxy {
        Ok(proxy) => proxy,
        Err(reason) => {
            tracing::warn!("[browser] ignoring the configured proxy: {reason}");
            None
        }
    }
}

#[cfg(target_os = "macos")]
fn run_on_main<R: Send + 'static>(
    app: &AppHandle,
    f: impl FnOnce() -> R + Send + 'static,
) -> Result<R, String> {
    if objc2::MainThreadMarker::new().is_some() {
        return Ok(f());
    }
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_schemes_a_webview_can_take() {
        let http = parse_proxy("http://127.0.0.1:7890").unwrap();
        assert_eq!(http.scheme, ProxyScheme::Http);
        assert_eq!(http.host, "127.0.0.1");
        assert_eq!(http.port, 7890);
        assert_eq!(http.to_url_string(), "http://127.0.0.1:7890");

        let socks = parse_proxy("socks5h://proxy.corp:1081").unwrap();
        assert_eq!(socks.scheme, ProxyScheme::Socks5);
        assert_eq!(socks.to_url_string(), "socks5://proxy.corp:1081");

        assert_eq!(parse_proxy("http://proxy.corp").unwrap().port, 80);
        assert_eq!(parse_proxy("socks5://proxy.corp").unwrap().port, 1080);
        assert_eq!(parse_proxy("http://[::1]:8080").unwrap().to_url_string(), "http://[::1]:8080");
    }

    #[test]
    fn refuses_what_the_engines_cannot_express() {
        assert!(parse_proxy("https://proxy.corp:443").unwrap_err().contains("https"));
        assert!(parse_proxy("socks4://proxy.corp:1080").is_err());
        assert!(parse_proxy("http://:8080").is_err());
        assert!(parse_proxy("not a url").is_err());
    }

    #[test]
    fn windows_arguments_are_the_whole_string() {
        assert_eq!(
            windows_browser_args(None),
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --auth-server-allowlist="
        );
        let proxy = parse_proxy("socks5://127.0.0.1:1080").unwrap();
        assert_eq!(
            windows_browser_args(Some(&proxy)),
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --auth-server-allowlist= --proxy-server=socks5://127.0.0.1:1080"
        );
        // Same input, same string: WebView2 rejects a second environment on
        // the same user-data folder with different arguments.
        assert_eq!(windows_browser_args(Some(&proxy)), windows_browser_args(Some(&proxy)));
    }

    #[test]
    fn profile_ids_are_directory_safe() {
        for ok in ["default", "p-1a2b3c4d5e6f", "work", "a", "0abc-def"] {
            assert!(valid_profile_id(ok), "{ok}");
        }
        for bad in [
            "",
            "Default",
            "-lead",
            "with space",
            "dots..",
            "slash/x",
            "back\\x",
            "über",
            &"x".repeat(MAX_PROFILE_ID_LEN + 1),
        ] {
            assert!(!valid_profile_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn identifier_is_a_version_5_uuid() {
        // Version nibble 5, RFC 4122 variant — what uuid5() produces, so the
        // constant was not typed by hand.
        assert_eq!(DEFAULT_DATA_STORE_IDENTIFIER[6] >> 4, 5);
        assert_eq!(DEFAULT_DATA_STORE_IDENTIFIER[8] & 0xc0, 0x80);
    }

    /// The derivation must keep finding the store the default profile has
    /// used since it shipped, and must tell profiles apart.
    #[test]
    fn identifiers_derive_from_the_profile_id() {
        assert_eq!(data_store_identifier(DEFAULT_PROFILE_ID), DEFAULT_DATA_STORE_IDENTIFIER);
        let work = data_store_identifier("work");
        assert_ne!(work, DEFAULT_DATA_STORE_IDENTIFIER);
        assert_eq!(work, data_store_identifier("work"));
        assert_eq!(work[6] >> 4, 5);
        assert_eq!(work[8] & 0xc0, 0x80);
        // Reference value from an independent uuid5 implementation.
        assert_eq!(
            data_store_identifier("work"),
            [0x76, 0x78, 0x5b, 0x58, 0x04, 0x9d, 0x56, 0xd9, 0x96, 0x83, 0x8e, 0xd6, 0xa1, 0x2f, 0xee, 0x3a]
        );
    }

    #[test]
    fn a_profile_is_marked_for_as_long_as_its_deletion_runs() {
        assert!(!is_removing("p-going"));
        let guard = begin_removal("p-going").unwrap();
        assert!(is_removing("p-going"));
        assert!(begin_removal("p-going").is_err());
        assert!(!is_removing("p-other"));
        // A callback's share keeps the mark after the command's own is gone.
        let shared = guard.share();
        drop(guard);
        assert!(is_removing("p-going"));
        drop(shared);
        assert!(!is_removing("p-going"));
        // Free again once the first deletion is over.
        drop(begin_removal("p-going").unwrap());
    }

    #[test]
    fn admissions_are_counted_and_refused_during_a_deletion() {
        assert_eq!(in_flight("p-busy"), 0);
        let a = admit("p-busy").unwrap();
        let b = admit("p-busy").unwrap();
        assert_eq!(in_flight("p-busy"), 2);
        // A share is the same admission, not a second one, and keeps it
        // alive after the original is gone.
        let shared = a.share();
        assert_eq!(in_flight("p-busy"), 2);
        drop(a);
        assert_eq!(in_flight("p-busy"), 2);
        drop(shared);
        assert_eq!(in_flight("p-busy"), 1);
        let removal = begin_removal("p-busy").unwrap();
        assert!(admit("p-busy").is_err());
        // Other profiles are not affected.
        drop(admit("p-free").unwrap());
        drop(b);
        assert_eq!(in_flight("p-busy"), 0);
        drop(removal);
        drop(admit("p-busy").unwrap());
    }

    #[tokio::test]
    async fn a_deletion_waits_for_the_profile_to_drain() {
        let held = admit("p-drain").unwrap();
        let _removal = begin_removal("p-drain").unwrap();
        let waiter = tokio::spawn(async { wait_until_idle("p-drain").await });
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert!(!waiter.is_finished());
        drop(held);
        assert!(waiter.await.unwrap());
    }

    #[test]
    fn directories_are_per_profile() {
        let a = directory("default");
        let b = directory("work");
        assert_eq!(a.file_name().unwrap(), "default");
        assert_eq!(b.file_name().unwrap(), "work");
        assert_eq!(a.parent(), b.parent());
    }

    #[test]
    fn sign_in_user_agent_is_for_google_sign_in_hosts_only() {
        set_sign_in_user_agent(true);
        let sign_in = Url::parse("https://accounts.google.com/v3/signin/identifier?flowName=x").unwrap();
        assert_eq!(user_agent_for(&sign_in), Some(SIGN_IN_USER_AGENT));
        let sub = Url::parse("https://oauth.accounts.google.com/").unwrap();
        assert_eq!(user_agent_for(&sub), Some(SIGN_IN_USER_AGENT));
        let youtube = Url::parse("https://accounts.youtube.com/accounts/SetSID").unwrap();
        assert_eq!(user_agent_for(&youtube), Some(SIGN_IN_USER_AGENT));
        for native in [
            "https://www.google.com/",
            "https://mail.google.com/",
            "https://accounts.google.com.evil.example/",
            "https://notaccounts.google.com/",
            "https://example.com/accounts.google.com",
            "http://localhost:3000/",
        ] {
            // Everything else gets the platform's own identity, borrowing
            // nobody's: on macOS that is the engine's string with the tokens
            // it is missing, elsewhere the engine's string untouched.
            assert_eq!(
                user_agent_for(&Url::parse(native).unwrap()),
                default_user_agent(),
                "{native}"
            );
            assert_ne!(user_agent_for(&Url::parse(native).unwrap()), Some(SIGN_IN_USER_AGENT));
        }
        assert!(SIGN_IN_USER_AGENT.contains("Firefox/"));
        assert!(is_google_sign_in_host("ACCOUNTS.GOOGLE.COM."));

        // The switch only gives back the borrowed identity; the default one
        // is not a preference and stays.
        set_sign_in_user_agent(false);
        assert_eq!(user_agent_for(&sign_in), default_user_agent());
        set_sign_in_user_agent(true);
    }

    /// The tokens a sniffing site looks for, and the reason this exists: a
    /// string that stops at `(KHTML, like Gecko)` is read as "not a browser".
    #[cfg(target_os = "macos")]
    #[test]
    fn the_default_identity_names_the_browser_the_engine_belongs_to() {
        let user_agent = default_user_agent().expect("macOS answers with one");
        assert!(user_agent.starts_with("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "));
        assert!(user_agent.contains("AppleWebKit/605.1.15 (KHTML, like Gecko) Version/"));
        assert!(user_agent.ends_with(" Safari/605.1.15"));
        // Nothing of Firefox's in it: that identity is the sign-in hosts' and
        // is a claim this one does not make.
        assert!(!user_agent.contains("Gecko/"));
        assert!(!user_agent.contains("Firefox/"));
        // Same string every time — it is handed out as `&'static str`.
        assert_eq!(default_user_agent(), default_user_agent());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn safari_ran_three_majors_ahead_of_macos_until_they_were_aligned() {
        assert_eq!(safari_major(11), 14);
        assert_eq!(safari_major(15), 18);
        assert_eq!(safari_major(26), 26);
        assert_eq!(safari_major(30), 30);
        // A release older than any this app runs on still names a Safari that
        // existed, rather than `Version/13.0` for macOS 10.
        assert_eq!(safari_major(10), 14);
    }

    /// The environment list extends the built-in one with the same rule
    /// (exact host or a subdomain), whatever the spelling.
    #[test]
    fn extra_sign_in_hosts_come_from_the_environment_list() {
        let extra = parse_host_list(" Login.Corp.Example. ,, 127.0.0.1 ");
        assert_eq!(extra, vec!["login.corp.example".to_string(), "127.0.0.1".to_string()]);
        assert!(is_sign_in_host_among("login.corp.example", &extra));
        assert!(is_sign_in_host_among("sso.login.corp.example", &extra));
        assert!(is_sign_in_host_among("127.0.0.1", &extra));
        assert!(!is_sign_in_host_among("corp.example", &extra));
        assert!(!is_sign_in_host_among("notlogin.corp.example", &extra));
        assert!(!is_sign_in_host_among("127.0.0.10", &extra));
        // Google's hosts stay whatever the list says.
        assert!(is_sign_in_host_among("accounts.google.com", &extra));
        assert!(is_sign_in_host_among("accounts.google.com", &[]));
        assert!(parse_host_list("").is_empty());
    }

    #[test]
    fn a_remote_profile_goes_only_through_its_egress() {
        let id = remote_profile_id(9001);
        assert_eq!(id, "remote-9001");
        assert_eq!(remote_connection_id(&id), Some(9001));
        assert_eq!(remote_connection_id("remote-x"), None);
        assert_eq!(remote_connection_id(DEFAULT_PROFILE_ID), None);
        assert!(is_remote_profile(&id) && valid_profile_id(&id));
        assert!(!is_remote_profile(DEFAULT_PROFILE_ID) && !is_remote_profile("p-abc"));
        // No egress yet: no proxy, no arguments, no host — never the app's.
        assert!(proxy_for(&id).is_err());
        assert!(windows_args_for(&id).is_err());
        assert_eq!(remote_host(&id), None);

        set_remote_egress(&id, "127.0.0.1:45678".parse().unwrap(), "box.example.com:8443");
        let proxy = proxy_for(&id).unwrap().unwrap();
        assert_eq!(proxy.to_url_string(), "socks5://127.0.0.1:45678");
        let args = windows_args_for(&id).unwrap();
        assert!(args.contains(" --proxy-server=socks5://127.0.0.1:45678"), "{args}");
        assert!(args.ends_with(" --proxy-bypass-list=<-loopback>"), "{args}");
        assert_eq!(remote_host(&id).as_deref(), Some("box.example.com:8443"));
        // Only a remote profile has a remote host.
        set_remote_egress("p-abc", "127.0.0.1:1".parse().unwrap(), "elsewhere");
        assert_eq!(remote_host("p-abc"), None);
        assert!(!windows_args_for(DEFAULT_PROFILE_ID).unwrap().contains("<-loopback>"));
    }

    #[test]
    fn wire_names() {
        let status = BrowserProxyStatus {
            url: Some("http://127.0.0.1:7890".into()),
            applies: ProxyApplies::NextTab,
            reason: None,
        };
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["applies"], "next-tab");
        assert_eq!(json["url"], "http://127.0.0.1:7890");
    }
}
