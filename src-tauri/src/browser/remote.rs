//! Remote-egress tabs, the app's side of `egress`: getting a remote
//! connection's egress ready for a tab — its listener started, its profile
//! pointed at the listener, the tunnel open and the probe passed — and, on
//! macOS, the alias those tabs reach the remote host's loopback by.
//!
//! A remote-workspace window opens an address of the remote host (one the
//! frontend decided is the remote host's: loopback, private) in a tab of the
//! connection's own profile, `remote-<connection id>`. Nothing about that tab
//! is allowed to fall back to this computer: every step here refuses rather
//! than open a tab that could load the remote host's address from here.

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Manager, Url};

use crate::app_error::AppCommandError;
use crate::browser::egress::{
    Egress, EgressRegistry, EgressStatus, ProbeVerdict, StreamFailure, TargetLoader, TunnelTarget,
};
use crate::browser::profile;
use crate::browser::types::BrowserErrorKind;
use crate::db::service::remote_workspace_connection_service;
use crate::db::AppDatabase;
use crate::models::ToHeaderMap;
use crate::web::browser_tunnel::frame::TUNNEL_PATH;

/// The name the tabs of a remote profile give the remote host's loopback on
/// macOS. WebKit sends `localhost` and loopback addresses around any proxy
/// (see `shim::macos`), but a `*.localhost` name goes through it, is still a
/// secure context, and is loopback to the remote codeg-server (RFC 6761),
/// which connects it to that host's own `localhost`. Dev servers take
/// `*.localhost` for local too, so their host checks let it in.
pub const ALIAS_HOST: &str = "remote.localhost";

/// Longest the probe page may take to prove itself.
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// This build or this machine cannot give remote tabs an egress (macOS before
/// 14 has no data store of a profile's own to proxy).
pub const BROWSER_I18N_KEY_REMOTE_UNAVAILABLE: &str = "browser.remote.error.unavailable";
/// The remote codeg-server predates the tunnel.
pub const BROWSER_I18N_KEY_REMOTE_UNSUPPORTED: &str = "browser.remote.error.unsupported";
/// The remote codeg-server has its tunnel switched off.
pub const BROWSER_I18N_KEY_REMOTE_DISABLED: &str = "browser.remote.error.disabled";
/// The tunnel could not be opened; `{reason}` says why.
pub const BROWSER_I18N_KEY_REMOTE_UNREACHABLE: &str = "browser.remote.error.unreachable";
/// The probe saw this computer's engine go around the proxy.
pub const BROWSER_I18N_KEY_REMOTE_BYPASSED: &str = "browser.remote.error.bypassed";
/// The probe page never proved anything either way.
pub const BROWSER_I18N_KEY_REMOTE_PROBE_FAILED: &str = "browser.remote.error.probeFailed";

/// Whether this build, on this machine, can give a remote connection's tabs
/// an egress: a profile of their own (macOS 14+), and on macOS the embedded
/// surface — the one the loopback rules and the alias are installed on.
pub fn supported() -> bool {
    let embedded_on_macos = cfg!(not(target_os = "macos")) || cfg!(feature = "browser-child");
    profile::profiles_supported() && embedded_on_macos
}

/// Get connection `connection_id`'s egress ready for a tab of window
/// `owner`, and answer with the remote host its tabs go through. Once per
/// connection the probe runs first; after that this is the tunnel check
/// alone.
pub async fn prepare(
    app: &AppHandle,
    owner: &tauri::WebviewWindow,
    connection_id: i32,
) -> Result<String, AppCommandError> {
    if !supported() {
        return Err(AppCommandError::dependency_missing(
            "opening the remote host's addresses in the built-in browser needs macOS 14 or later",
        )
        .with_i18n(BROWSER_I18N_KEY_REMOTE_UNAVAILABLE, BTreeMap::new()));
    }
    let db = app.state::<AppDatabase>();
    let connection = remote_workspace_connection_service::get(&db.conn, connection_id)
        .await
        .map_err(AppCommandError::db)?
        .ok_or_else(|| AppCommandError::not_found(format!("Remote connection {connection_id} not found")))?;
    let host = display_host(&connection.base_url);
    let egress = app
        .state::<EgressRegistry>()
        .ensure(connection_id, || tunnel_loader(db.conn.clone(), connection_id))
        .await
        .map_err(AppCommandError::io)?;
    if egress.claim_reporting() {
        // The tabs of the profile hear when the tunnel drops and comes back.
        let (app, mut status) = (app.clone(), egress.subscribe());
        tauri::async_runtime::spawn(async move {
            while status.changed().await.is_ok() {
                let current = status.borrow_and_update().clone();
                crate::browser::events::emit_egress(&app, connection_id, &current);
            }
        });
    }
    let profile_id = profile::remote_profile_id(connection_id);
    profile::set_remote_egress(&profile_id, egress.socks_addr(), &host);
    egress.connect().await.map_err(tunnel_refusal)?;
    #[cfg(target_os = "macos")]
    crate::commands::browser::on_main_until_result(app, "Failed to prepare the remote browser profile", |done| {
        crate::browser::shim::macos::prepare_loopback_rules(done)
    })
    .await?;
    // The profile as its tabs will find it — its store pointed at the
    // listener, its folder in place — before the probe's page is built in
    // it: a page of a store with no proxy yet goes straight here.
    let _admission = profile::admit(&profile_id).map_err(AppCommandError::invalid_input)?;
    profile::prepare(app, &profile_id)
        .map_err(|e| AppCommandError::window("Failed to prepare the browser profile", e))?;
    verify(app, owner, &egress, &profile_id).await?;
    Ok(host)
}

/// A remote connection was deleted: its profile goes — the cookies and
/// storage of the remote host's pages, and its tabs, which close — and so do
/// its tunnel and listener. Best effort: the connection is gone whatever
/// becomes of its profile, and a profile that was never used has nothing to
/// remove.
pub async fn forget_connection(app: &AppHandle, connection_id: i32) {
    let profile_id = profile::remote_profile_id(connection_id);
    if let Some(registry) = app.try_state::<crate::browser::BrowserRegistry>() {
        if let Err(err) = crate::commands::browser::remove_profile_core(app, &registry, &profile_id).await {
            tracing::debug!("[browser] could not remove {profile_id} with its connection: {err}");
        }
    }
    if let Some(egress) = app
        .try_state::<EgressRegistry>()
        .and_then(|egresses| egresses.remove(connection_id))
    {
        egress.close().await;
    }
    profile::forget_remote_egress(&profile_id);
}

/// A remote connection's address, token or headers were edited: its tunnel,
/// if open, closes, and the next page request opens it again to wherever the
/// connection now points.
pub async fn connection_changed(app: &AppHandle, connection_id: i32) {
    if let Some(egress) = app
        .try_state::<EgressRegistry>()
        .and_then(|egresses| egresses.get(connection_id))
    {
        egress.reset().await;
    }
}

/// Where the tunnel is, read from the connection at every connect: a token
/// or address edited in the connection settings is used from the next one.
fn tunnel_loader(db: sea_orm::DatabaseConnection, connection_id: i32) -> TargetLoader {
    Arc::new(move || {
        let db = db.clone();
        Box::pin(async move {
            let connection = remote_workspace_connection_service::get(&db, connection_id)
                .await
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "the remote connection no longer exists".to_string())?;
            Ok(TunnelTarget {
                ws_url: crate::commands::remote_proxy::http_url_to_ws_url(&connection.base_url, TUNNEL_PATH),
                token: connection.token,
                headers: connection.headers.to_header_map(),
            })
        })
    })
}

/// `host[:port]` of a connection's address, as a tab names where it goes.
fn display_host(base_url: &str) -> String {
    Url::parse(base_url)
        .ok()
        .and_then(|url| {
            let host = url.host_str()?.to_string();
            Some(match url.port() {
                Some(port) => format!("{host}:{port}"),
                None => host,
            })
        })
        .unwrap_or_else(|| base_url.to_string())
}

fn tunnel_refusal(status: EgressStatus) -> AppCommandError {
    match status {
        EgressStatus::Unsupported => AppCommandError::dependency_missing(
            "the remote codeg-server cannot carry browser traffic; update it to open its addresses here",
        )
        .with_i18n(BROWSER_I18N_KEY_REMOTE_UNSUPPORTED, BTreeMap::new()),
        EgressStatus::Disabled => AppCommandError::permission_denied(
            "the remote codeg-server has its browser tunnel switched off",
        )
        .with_i18n(BROWSER_I18N_KEY_REMOTE_DISABLED, BTreeMap::new()),
        EgressStatus::Down { reason } => AppCommandError::network(format!(
            "cannot reach the remote codeg-server's browser tunnel: {reason}"
        ))
        .with_i18n(
            BROWSER_I18N_KEY_REMOTE_UNREACHABLE,
            BTreeMap::from([("reason".to_string(), reason)]),
        ),
        // `connect` answers with a failure only.
        EgressStatus::Idle | EgressStatus::Connecting | EgressStatus::Ready => {
            AppCommandError::network("the browser tunnel is not ready")
        }
    }
}

/// The probe (see `egress`), unless it has already given its verdict for this
/// listener: a hidden page of the profile loads an address on the listener's
/// own port, then addresses this machine by loopback literals, then opens a
/// WebSocket. The page and its WebSocket must arrive through the proxy, and
/// nothing may arrive around it.
async fn verify(
    app: &AppHandle,
    owner: &tauri::WebviewWindow,
    egress: &Egress,
    profile_id: &str,
) -> Result<(), AppCommandError> {
    let mut verdict = egress.verdict().await;
    match *verdict {
        Some(ProbeVerdict::Proxied) => return Ok(()),
        Some(ProbeVerdict::Bypassed) => return Err(bypassed()),
        None => {}
    }
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    // Windows and Linux proxy `localhost` like any name, which is the thing
    // to prove there; macOS never does, and its tabs use the alias.
    let host = if cfg!(target_os = "macos") { ALIAS_HOST } else { "localhost" };
    let url = egress.probe_url(host, &nonce);
    let page = ProbePage::open(app, owner, profile_id, &url, &nonce)
        .await
        .map_err(|e| AppCommandError::window("Failed to open the remote browser probe", e))?;
    let visit = egress.await_probe(&nonce, PROBE_TIMEOUT).await;
    drop(page);
    if visit.bypassed {
        tracing::warn!("[browser] {profile_id}: the probe went around the proxy; remote tabs stay closed");
        *verdict = Some(ProbeVerdict::Bypassed);
        return Err(bypassed());
    }
    if visit.page && visit.websocket {
        *verdict = Some(ProbeVerdict::Proxied);
        return Ok(());
    }
    tracing::warn!("[browser] {profile_id}: the probe proved nothing ({visit:?})");
    Err(AppCommandError::network(
        "the built-in browser could not confirm that it reaches the remote host through the tunnel",
    )
    .with_i18n(BROWSER_I18N_KEY_REMOTE_PROBE_FAILED, BTreeMap::new()))
}

fn bypassed() -> AppCommandError {
    AppCommandError::dependency_missing(
        "this computer's browser engine sends some addresses around the tunnel, so the remote host's pages cannot be opened here",
    )
    .with_i18n(BROWSER_I18N_KEY_REMOTE_BYPASSED, BTreeMap::new())
}

/// The probe's page while it runs, built the way the profile's tabs are; it
/// goes when this is dropped, whichever way the probe ends.
struct ProbePage {
    app: AppHandle,
    page: ProbeSurface,
}

enum ProbeSurface {
    /// macOS: a `WKWebView` in no window, kept by the shim under this key.
    #[cfg(target_os = "macos")]
    View(String),
    /// Windows with the embedded surface: a hidden child webview of the
    /// window the tab is for — on the environment the profile's tabs use,
    /// which every webview on the profile's folder has to share.
    #[cfg(all(target_os = "windows", feature = "browser-child"))]
    Child(crate::browser::surface_child::ChildHandle),
    /// Linux, and Windows without the embedded surface: a window that is
    /// never shown, as the profile's tabs are owned windows there.
    #[cfg(not(any(target_os = "macos", all(target_os = "windows", feature = "browser-child"))))]
    Window(tauri::WebviewWindow),
}

impl ProbePage {
    #[cfg(target_os = "macos")]
    async fn open(
        app: &AppHandle,
        _owner: &tauri::WebviewWindow,
        profile_id: &str,
        url: &str,
        key: &str,
    ) -> Result<Self, String> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let (profile_id, url, owned_key) = (profile_id.to_string(), url.to_string(), key.to_string());
        app.run_on_main_thread(move || {
            let _ = tx.send(crate::browser::shim::macos::open_probe_view(&profile_id, &url, &owned_key));
        })
        .map_err(|e| e.to_string())?;
        rx.await.map_err(|_| "the probe page was dropped".to_string())??;
        Ok(Self { app: app.clone(), page: ProbeSurface::View(key.to_string()) })
    }

    #[cfg(all(target_os = "windows", feature = "browser-child"))]
    async fn open(
        app: &AppHandle,
        owner: &tauri::WebviewWindow,
        profile_id: &str,
        url: &str,
        key: &str,
    ) -> Result<Self, String> {
        let probe_id = format!("egress-probe-{key}");
        let label = crate::browser::tab_label(&probe_id);
        let bounds = crate::browser::types::Bounds { x: 0.0, y: 0.0, width: 1.0, height: 1.0 };
        let handle = crate::browser::surface_child::create(app, owner, &probe_id, &label, bounds, true, false, profile_id)
            .map_err(|e| e.to_string())?;
        // Owned from here: a failed load still closes the webview.
        let page = Self { app: app.clone(), page: ProbeSurface::Child(handle) };
        let ProbeSurface::Child(handle) = &page.page;
        handle.load_url(url).map_err(|e| e.to_string())?;
        Ok(page)
    }

    #[cfg(not(any(target_os = "macos", all(target_os = "windows", feature = "browser-child"))))]
    async fn open(
        app: &AppHandle,
        _owner: &tauri::WebviewWindow,
        profile_id: &str,
        url: &str,
        key: &str,
    ) -> Result<Self, String> {
        let url = Url::parse(url).map_err(|e| e.to_string())?;
        let label = format!("{}egress-probe-{key}", crate::browser::TAB_LABEL_PREFIX);
        crate::browser::surface_window::open_probe(app, &label, profile_id, url)
            .map(|window| Self { app: app.clone(), page: ProbeSurface::Window(window) })
            .map_err(|e| e.to_string())
    }
}

impl Drop for ProbePage {
    fn drop(&mut self) {
        match &self.page {
            #[cfg(target_os = "macos")]
            ProbeSurface::View(key) => {
                let key = key.clone();
                let _ = self
                    .app
                    .run_on_main_thread(move || crate::browser::shim::macos::close_probe_view(&key));
            }
            #[cfg(all(target_os = "windows", feature = "browser-child"))]
            ProbeSurface::Child(handle) => {
                let _ = &self.app;
                let _ = handle.close();
            }
            #[cfg(not(any(target_os = "macos", all(target_os = "windows", feature = "browser-child"))))]
            ProbeSurface::Window(window) => {
                let _ = &self.app;
                let _ = window.destroy();
            }
        }
    }
}

/// Why a remote tab's page did not load, when the tunnel knows: the error
/// page's kind in place of the engine's, which cannot tell a refused port
/// from a dropped tunnel through a proxy (WebKit calls both "bad URL").
/// `None` for every other tab, and when the tunnel saw nothing go wrong.
pub fn failure_kind(app: &AppHandle, profile_id: &str, url: &str) -> Option<BrowserErrorKind> {
    let egress = app
        .try_state::<EgressRegistry>()?
        .get(profile::remote_connection_id(profile_id)?)?;
    let url = Url::parse(url).ok()?;
    let failure = egress.recent_failure(url.host_str()?, url.port_or_known_default()?)?;
    Some(match failure {
        StreamFailure::Refused => BrowserErrorKind::RemoteRefused,
        StreamFailure::Unreachable => BrowserErrorKind::RemoteUnreachable,
        StreamFailure::NotAllowed => BrowserErrorKind::RemoteNotAllowed,
        StreamFailure::Timeout => BrowserErrorKind::RemoteTimeout,
        StreamFailure::TunnelDown => BrowserErrorKind::TunnelDown,
        StreamFailure::Failed => BrowserErrorKind::Failed,
    })
}

/// Where a tab of `profile_id` really goes for `url`: on macOS, a remote
/// profile's loopback address becomes the same address on `ALIAS_HOST`;
/// everything else goes where it says — on Windows and Linux the engine
/// proxies loopback like any other name.
pub fn egress_address<'a>(profile_id: &str, url: &'a Url) -> Cow<'a, Url> {
    if cfg!(target_os = "macos") && profile::is_remote_profile(profile_id) {
        if let Some(alias) = alias_for(url) {
            return Cow::Owned(alias);
        }
    }
    Cow::Borrowed(url)
}

/// `url` as the remote host knows it, for a tab of `profile_id`: a remote
/// profile's page on `ALIAS_HOST` is on that host's own `localhost`, which
/// the tunnel connects the alias to. For what leaves the tab for the remote
/// host — a page handed to a conversation, whose agent runs there — where the
/// alias names nothing (a copied link is named the same way, by the
/// frontend's `remoteHostAddress`). Every other tab and address is returned
/// as it is.
pub fn host_address<'a>(profile_id: Option<&str>, url: &'a str) -> Cow<'a, str> {
    if !profile_id.is_some_and(profile::is_remote_profile) {
        return Cow::Borrowed(url);
    }
    let Ok(mut parsed) = Url::parse(url) else {
        return Cow::Borrowed(url);
    };
    if parsed.host_str() != Some(ALIAS_HOST) || parsed.set_host(Some("localhost")).is_err() {
        return Cow::Borrowed(url);
    }
    Cow::Owned(parsed.into())
}

/// `url` on `ALIAS_HOST`, when it addresses this machine by a loopback name:
/// `localhost` (a trailing dot too), `127.0.0.0/8`, `::1` and the IPv4-mapped
/// forms, and the unspecified addresses dev servers print (`0.0.0.0`, `::`),
/// which a connection reaches the host itself by.
pub fn alias_for(url: &Url) -> Option<Url> {
    if !matches!(url.scheme(), "http" | "https" | "ws" | "wss") {
        return None;
    }
    let loopback = match url.host()? {
        url::Host::Domain(name) => name.strip_suffix('.').unwrap_or(name).eq_ignore_ascii_case("localhost"),
        url::Host::Ipv4(ip) => ip.is_loopback() || ip.is_unspecified(),
        url::Host::Ipv6(ip) => {
            ip.is_loopback()
                || ip.is_unspecified()
                || ip.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback() || v4.is_unspecified())
        }
    };
    if !loopback {
        return None;
    }
    let mut alias = url.clone();
    alias.set_host(Some(ALIAS_HOST)).ok()?;
    Some(alias)
}

/// A page of a remote tab navigated to a loopback address (macOS): the
/// engine was told no, and the tab goes to the alias instead, on a later turn
/// of the main thread — not from inside the engine's own decision.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn redirect_to_alias(app: &AppHandle, tab_id: &str, alias: Url) {
    let (handle, tab_id) = (app.clone(), tab_id.to_string());
    let _ = app.run_on_main_thread(move || {
        let Some(registry) = handle.try_state::<crate::browser::BrowserRegistry>() else {
            return;
        };
        if let Err(err) = crate::commands::browser::navigate_core(&handle, &registry, &tab_id, alias.as_str()) {
            tracing::debug!("[browser] tab {tab_id}: could not follow the alias: {err}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn aliased(raw: &str) -> Option<String> {
        alias_for(&Url::parse(raw).unwrap()).map(|url| url.to_string())
    }

    #[test]
    fn loopback_addresses_move_to_the_alias_keeping_everything_else() {
        assert_eq!(
            aliased("http://localhost:3000/a?b=1#c").as_deref(),
            Some("http://remote.localhost:3000/a?b=1#c")
        );
        assert_eq!(aliased("https://LOCALHOST./x").as_deref(), Some("https://remote.localhost/x"));
        assert_eq!(aliased("http://127.0.0.1:5173/").as_deref(), Some("http://remote.localhost:5173/"));
        assert_eq!(aliased("http://127.9.9.9/").as_deref(), Some("http://remote.localhost/"));
        assert_eq!(aliased("http://[::1]:8080/").as_deref(), Some("http://remote.localhost:8080/"));
        assert_eq!(aliased("http://[::ffff:127.0.0.1]:1/").as_deref(), Some("http://remote.localhost:1/"));
        assert_eq!(aliased("http://0.0.0.0:3000/").as_deref(), Some("http://remote.localhost:3000/"));
        assert_eq!(aliased("http://[::]:3000/").as_deref(), Some("http://remote.localhost:3000/"));
        assert_eq!(aliased("ws://localhost:24678/hmr").as_deref(), Some("ws://remote.localhost:24678/hmr"));
        assert_eq!(
            aliased("http://user:pw@localhost:3000/").as_deref(),
            Some("http://user:pw@remote.localhost:3000/")
        );
    }

    #[test]
    fn every_other_address_is_left_alone() {
        for raw in [
            "http://remote.localhost:3000/",
            "http://app.localhost/",
            "http://localhost.example.com/",
            "http://10.0.0.5:3000/",
            "http://192.168.1.2/",
            "https://example.com/",
            "http://[fd00::1]/",
            "about:blank",
            "blob:http://localhost:3000/uuid",
        ] {
            assert_eq!(aliased(raw), None, "{raw}");
        }
    }

    #[test]
    fn only_a_remote_profile_on_macos_is_rewritten() {
        let url = Url::parse("http://localhost:3000/").unwrap();
        assert_eq!(egress_address("default", &url).as_str(), "http://localhost:3000/");
        assert_eq!(egress_address("p-abc", &url).as_str(), "http://localhost:3000/");
        let remote = egress_address("remote-7", &url);
        if cfg!(target_os = "macos") {
            assert_eq!(remote.as_str(), "http://remote.localhost:3000/");
        } else {
            assert_eq!(remote.as_str(), "http://localhost:3000/");
        }
    }

    #[test]
    fn a_remote_tab_s_alias_leaves_the_tab_as_the_remote_host_s_localhost() {
        let remote = Some("remote-7");
        assert_eq!(
            host_address(remote, "http://remote.localhost:3000/a?b=1#c"),
            "http://localhost:3000/a?b=1#c"
        );
        assert_eq!(host_address(remote, "https://u:p@remote.localhost/x"), "https://u:p@localhost/x");
        // What the alias took a loopback address to, it gives back.
        let aliased = alias_for(&Url::parse("http://localhost:5173/app").unwrap()).unwrap();
        assert_eq!(host_address(remote, aliased.as_str()), "http://localhost:5173/app");
        for raw in [
            "http://localhost:3000/",
            "http://app.localhost/",
            "http://remote.localhost.example.com/",
            "http://10.0.0.5:3000/",
            "blob:http://remote.localhost:3000/uuid",
            "about:blank",
            "not a url",
            "",
        ] {
            assert_eq!(host_address(remote, raw), raw, "{raw}");
        }
        // A tab of any other profile keeps its address, alias or not.
        for profile in [None, Some("default"), Some("p-abc")] {
            assert_eq!(host_address(profile, "http://remote.localhost:3000/"), "http://remote.localhost:3000/");
        }
    }

    #[test]
    fn a_connection_is_named_by_host_and_port() {
        assert_eq!(display_host("https://box.example.com:8443/"), "box.example.com:8443");
        assert_eq!(display_host("http://10.0.0.2"), "10.0.0.2");
        assert_eq!(display_host("http://[fd00::2]:3080"), "[fd00::2]:3080");
        assert_eq!(display_host("not a url"), "not a url");
    }
}
