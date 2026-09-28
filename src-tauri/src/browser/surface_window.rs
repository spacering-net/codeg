//! Owned-window surface: a top-level `WebviewWindow` attached to the owner
//! (`parent`). The only surface on Linux, the fallback everywhere else, and
//! the shape popups take when they cannot be adopted as tabs.
//!
//! On Linux this window is also where the page ↔ host channel and the rest of
//! the shim live, because there is no embedded surface to put them on: the
//! engine webview behind the window is taken hold of once, at creation, and
//! every operation afterwards goes through `platform`. On macOS and Windows an
//! owned window is a fallback that the host does not hold the webview of, and
//! `platform` answers the same calls by saying so.

use tauri::webview::{DownloadEvent, PageLoadEvent};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

use super::downloads;
use super::events;
use super::hooks;
use super::policy::{self, BrowserPolicy};
use super::profile;
use super::registry::BrowserRegistry;
use super::types::NavigationBlockReason;

pub use platform::*;

#[allow(clippy::too_many_arguments)]
pub fn create(
    app: &AppHandle,
    owner: &WebviewWindow,
    tab_id: &str,
    label: &str,
    title: &str,
    background: bool,
    devtools: bool,
    profile: &str,
) -> tauri::Result<WebviewWindow> {
    build(app, owner, tab_id, label, title, background, devtools, profile, None)
}

/// A window's container and proxy: `profile`'s.
fn in_profile<'a>(
    builder: WebviewWindowBuilder<'a, tauri::Wry, AppHandle>,
    profile: &str,
) -> tauri::Result<WebviewWindowBuilder<'a, tauri::Wry, AppHandle>> {
    // macOS: never a window of a remote profile. The loopback rules and the
    // alias its pages need are the embedded surface's; a window of wry's own
    // making would send the remote host's `localhost` to this computer.
    #[cfg(target_os = "macos")]
    if profile::is_remote_profile(profile) {
        return Err(tauri::Error::Io(std::io::Error::other(format!(
            "browser profile {profile} opens embedded tabs only"
        ))));
    }
    #[cfg(target_os = "macos")]
    // wry falls back to the default store below macOS 14, exactly like the
    // shim does for embedded tabs; the proxy is a property of the store and
    // is in place once `profile::prepare` has run.
    let builder = builder.data_store_identifier(profile::data_store_identifier(profile));
    #[cfg(target_os = "windows")]
    let builder = builder
        .data_directory(profile::directory(profile))
        .additional_browser_args(
            &profile::windows_args_for(profile).map_err(|e| tauri::Error::Io(std::io::Error::other(e)))?,
        );
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let builder = {
        let builder = builder.data_directory(profile::directory(profile));
        // A remote profile's egress, else the app's proxy (see
        // `profile::proxy_for`). The app's proxy is best effort; a remote
        // profile's is not: without it the window would load the remote
        // host's addresses from this computer.
        let remote = profile::is_remote_profile(profile);
        let refuse = |reason: String| tauri::Error::Io(std::io::Error::other(reason));
        match profile::proxy_for(profile) {
            Ok(Some(proxy)) => match Url::parse(&proxy.to_url_string()) {
                Ok(url) => builder.proxy_url(url),
                Err(err) if remote => return Err(refuse(err.to_string())),
                Err(_) => builder,
            },
            Ok(None) => builder,
            Err(reason) if remote => return Err(refuse(reason)),
            Err(reason) => {
                tracing::warn!("[browser] ignoring the configured proxy: {reason}");
                builder
            }
        }
    };
    Ok(builder)
}

/// A window of `profile` that is never shown, on `url`: the remote-egress
/// probe's page (see `browser/egress.rs`) where the profile's tabs are owned
/// windows (Linux, and Windows without the embedded surface), built with the
/// profile's folder, arguments and proxy exactly as they are. None of a tab's
/// hooks: the page is the listener's own and goes nowhere else.
#[cfg_attr(
    any(target_os = "macos", all(target_os = "windows", feature = "browser-child")),
    allow(dead_code)
)]
pub fn open_probe(app: &AppHandle, label: &str, profile: &str, url: Url) -> tauri::Result<WebviewWindow> {
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title("codeg")
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        .devtools(false)
        .disable_drag_drop_handler();
    in_profile(builder, profile)?.build()
}

/// The window a page asked for, built from the one that asked: same profile,
/// same hooks, and — where the engine insists on it — related to the opener,
/// which is what keeps `window.opener`, `Referer` and `noopener` the page's
/// own business rather than the host's.
#[allow(clippy::too_many_arguments)]
fn build(
    app: &AppHandle,
    owner: &WebviewWindow,
    tab_id: &str,
    label: &str,
    title: &str,
    background: bool,
    devtools: bool,
    profile: &str,
    opener: Option<platform::OpenerView>,
) -> tauri::Result<WebviewWindow> {
    let blank = Url::parse("about:blank").expect("static url");
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::External(blank))
        .title(title)
        .inner_size(1100.0, 760.0)
        .min_inner_size(480.0, 320.0)
        .focused(!background)
        .devtools(devtools)
        .on_navigation({
            let app = app.clone();
            let tab_id = tab_id.to_string();
            let label = label.to_string();
            move |url| {
                if !policy::navigation_allowed(url) {
                    // On macOS and Windows tauri asks only about top-level
                    // navigations, so every refusal is the page's own and
                    // worth a notice. On Linux the engine reports no frame at
                    // all and wry asks about every one of them, so a refusal
                    // that a FRAME would have been allowed is one of those and
                    // is refused quietly: the scheme list stays the top-level
                    // one, because a page must not be able to put `data:` in
                    // the address bar by asking for it as a navigation.
                    if !(cfg!(target_os = "linux") && policy::subframe_navigation_allowed(url)) {
                        hooks::navigation_blocked(&app, &tab_id, url.as_str(), NavigationBlockReason::Scheme);
                    }
                    return false;
                }
                if app
                    .try_state::<BrowserPolicy>()
                    .is_some_and(|policy| policy.blocked(url))
                {
                    hooks::navigation_blocked(&app, &tab_id, url.as_str(), NavigationBlockReason::HostRule);
                    return false;
                }
                // Allowed, and this is the last moment before the request is
                // made: the identity the page is shown is decided here.
                platform::navigating_to(&label, url);
                true
            }
        })
        .on_page_load({
            let app = app.clone();
            let tab_id = tab_id.to_string();
            move |_window, payload| {
                hooks::page_load(
                    &app,
                    &tab_id,
                    payload.url(),
                    matches!(payload.event(), PageLoadEvent::Started),
                )
            }
        })
        .on_document_title_changed({
            let app = app.clone();
            let tab_id = tab_id.to_string();
            move |_window, title| hooks::title_changed(&app, &tab_id, title)
        })
        .on_download({
            let app = app.clone();
            let tab_id = tab_id.to_string();
            move |_webview, event| match event {
                DownloadEvent::Requested { url, destination } => {
                    downloads::requested(&app, &tab_id, url.as_str(), destination)
                }
                DownloadEvent::Finished { url, path, success } => {
                    downloads::finished(&app, url.as_str(), path, success);
                    true
                }
                // `DownloadEvent` is non-exhaustive: a variant added upstream
                // must not silently become "allowed".
                _ => false,
            }
        })
        .disable_drag_drop_handler()
        .zoom_hotkeys_enabled(true)
        .browser_extensions_enabled(false);
    // The same identity the embedded tabs start with. An owned window keeps it
    // for life: the per-navigation hook that swaps in the sign-in identity is
    // the embedded surface's, so this is the only place a window is told what
    // it is.
    let builder = match profile::default_user_agent() {
        Some(user_agent) => builder.user_agent(user_agent),
        None => builder,
    };
    // Same container and proxy as the embedded tabs, so a page behaves the
    // same whichever surface hosts it.
    let builder = in_profile(builder, profile)?;
    let builder = platform::relate(builder, opener);
    // Every browser window answers `window.open` the same way: the popup
    // blocker's decision, and then a window of its own registered as a tab
    // beside the one that asked (see `platform::new_window`).
    let builder = platform::watch_new_windows(builder, app, owner, tab_id, profile);
    let builder = builder.parent(owner)?;
    let window = builder.build()?;

    // Hooked up before the webview is taken hold of: the window is already on
    // screen and the user can close it at any moment, and a `Destroyed` that
    // arrives before this is watching would leave the tab in the registry and
    // the webview in the map.
    {
        let app = app.clone();
        let tab_id = tab_id.to_string();
        let label = label.to_string();
        window.on_window_event(move |event| {
            if matches!(event, WindowEvent::Destroyed) {
                platform::forget(&label);
                if let Some(registry) = app.try_state::<BrowserRegistry>() {
                    if let Some(tab) = registry.remove(&tab_id) {
                        events::emit_closed(&app, &tab_id, &tab.state.owner_window, None);
                    }
                }
            }
        });
    }

    // Take hold of the engine webview before the caller navigates: on Linux
    // everything the shim does is reached through it, and the navigation hooks
    // have to be in place before the first load starts.
    platform::adopt(app, &window, tab_id);
    Ok(window)
}

/// Linux: the engine webview behind each owned window, and the shim calls that
/// need it.
///
/// `tauri::WebviewWindow` hands the platform webview out through `with_webview`
/// and only on the main thread, so it is taken once at creation and kept here —
/// the same arrangement `surface_child` uses for its wry views, for the same
/// reason: the webview is not `Send`, and a handle that crosses threads has to
/// hop back to reach it. Two callers need it synchronously from the main thread
/// (the navigation decision, which must set the sign-in identity before the
/// request goes out, and the window's own event hooks), which is why the map
/// exists at all instead of a `with_webview` round trip per call.
#[cfg(target_os = "linux")]
mod platform {
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc;
    use std::sync::{Arc, OnceLock};
    use std::thread::ThreadId;
    use std::time::Duration;

    use tauri::webview::{NewWindowFeatures, NewWindowResponse};
    use tauri::{AppHandle, Manager, Url, WebviewWindow, WebviewWindowBuilder, Wry};
    use webkit2gtk::WebView;

    use super::super::channel;
    use super::super::events;
    use super::super::hooks;
    use super::super::policy::{self, BrowserPolicy};
    use super::super::profile;
    use super::super::registry::{BrowserRegistry, BrowserTab};
    use super::super::shim::linux as shim;
    use super::super::surface::{BrowserSurface, SurfaceError};
    use super::super::types::{
        BrowserPopupPayload, BrowserTabState, ChannelKind, PopupPresentation, SurfaceKind, TabKind,
    };
    use super::super::tab_label;

    /// The opener a new window must be built from: WebKitGTK refuses to open
    /// one for a page unless the webview it is given is RELATED to the webview
    /// that asked, which is also what carries `window.opener` across.
    pub type OpenerView = WebView;

    /// This window carries the page ↔ host channel and the rest of the shim.
    pub const HAS_CHANNEL: bool = true;

    static POPUP_SEQ: AtomicU64 = AtomicU64::new(0);

    struct Live {
        webview: WebView,
        tab_id: String,
    }

    thread_local! {
        /// Engine webviews by window label. Main thread only.
        static WEBVIEWS: RefCell<HashMap<String, Live>> = RefCell::new(HashMap::new());
    }

    static MAIN_THREAD: OnceLock<ThreadId> = OnceLock::new();

    /// Must be called once from the main thread (tauri's `setup` hook) before
    /// any surface is created; lets the calls below run inline instead of
    /// deadlocking when they are used from a webview callback.
    pub fn init_main_thread() {
        let _ = MAIN_THREAD.set(std::thread::current().id());
    }

    fn on_main_thread() -> bool {
        MAIN_THREAD.get() == Some(&std::thread::current().id())
    }

    fn run_on_main<R: Send + 'static>(
        app: &AppHandle,
        f: impl FnOnce() -> R + Send + 'static,
    ) -> Result<R, SurfaceError> {
        if on_main_thread() {
            return Ok(f());
        }
        let (tx, rx) = mpsc::channel();
        app.run_on_main_thread(move || {
            let _ = tx.send(f());
        })
        .map_err(|e| SurfaceError(format!("main-thread dispatch failed: {e}")))?;
        rx.recv()
            .map_err(|e| SurfaceError(format!("main-thread dispatch failed: {e}")))
    }

    /// Run `f` against the engine webview of an owned window, on the main
    /// thread.
    fn with<T: Send + 'static>(
        window: &WebviewWindow,
        f: impl FnOnce(&WebView) -> T + Send + 'static,
    ) -> Result<T, SurfaceError> {
        let label = window.label().to_string();
        run_on_main(window.app_handle(), move || {
            WEBVIEWS.with(|live| live.borrow().get(&label).map(|live| f(&live.webview)))
        })?
        .ok_or_else(|| SurfaceError("this window has no engine webview".into()))
    }

    /// Take hold of a new window's engine webview and hook its navigation
    /// reporting. Waits for it: the caller installs the channel and navigates
    /// as soon as this returns, and both go through the map.
    pub(super) fn adopt(app: &AppHandle, window: &WebviewWindow, tab_id: &str) {
        let label = window.label().to_string();
        let held = label.clone();
        let tab = tab_id.to_string();
        let sink = hooks::navigation_sink(app, tab_id);
        let closing = hooks::page_close_sink(app, tab_id);
        let (tx, rx) = mpsc::channel();
        let asked = window.with_webview(move |platform| {
            let webview = platform.inner();
            if let Err(err) = shim::install_navigation_hooks(&webview, sink) {
                tracing::warn!(
                    "[browser] window {held}: navigation hooks not installed ({err}); \
                     failures are detected by polling"
                );
            }
            if let Err(err) = shim::install_page_close_hook(&webview, closing) {
                tracing::warn!(
                    "[browser] window {held}: window.close() not hooked ({err}); \
                     a page closing its own window is ignored"
                );
            }
            // An entry already under this label is a window that went without
            // its `Destroyed` being seen. Its state is keyed by a pointer that
            // the allocator can hand out again, so it is let go of here rather
            // than left to be inherited by whoever lands on that address.
            let replaced = WEBVIEWS.with(|live| {
                live.borrow_mut()
                    .insert(held, Live { webview, tab_id: tab })
            });
            if let Some(replaced) = replaced {
                shim::forget(&replaced.webview);
            }
            let _ = tx.send(());
        });
        match asked {
            // Bounded rather than open-ended: a main thread that never answers
            // is a bug, and hanging a command thread on it would hide the bug
            // behind a frozen tab. The surface still works, without the shim.
            Ok(()) => {
                if rx.recv_timeout(Duration::from_secs(5)).is_err() {
                    tracing::warn!(
                        "[browser] window {label}: the engine webview did not arrive; \
                         history, find and the page channel are unavailable"
                    );
                }
            }
            Err(err) => tracing::warn!("[browser] window {label}: no engine webview ({err})"),
        }
    }

    /// Main thread. Drop what is held for a window that is going away.
    pub(super) fn forget(label: &str) {
        let live = WEBVIEWS.with(|live| live.borrow_mut().remove(label));
        if let Some(live) = live {
            shim::forget(&live.webview);
        }
    }

    /// Build the new window from the one that asked for it.
    pub(super) fn relate<'a>(
        builder: WebviewWindowBuilder<'a, Wry, AppHandle>,
        opener: Option<OpenerView>,
    ) -> WebviewWindowBuilder<'a, Wry, AppHandle> {
        match opener {
            Some(view) => builder.with_related_view(view),
            None => builder,
        }
    }

    /// Answer `window.open` the way the embedded surfaces do: the scheme list,
    /// then the site rules, then a user gesture the page can point at — and
    /// only then a window of its own, registered as a tab beside the one that
    /// asked. The engine navigates that window itself, so `window.opener`,
    /// `Referer` and `noopener` are what the page asked for; the host only
    /// decides whether there is a window at all.
    pub(super) fn watch_new_windows<'a>(
        builder: WebviewWindowBuilder<'a, Wry, AppHandle>,
        app: &AppHandle,
        owner: &WebviewWindow,
        tab_id: &str,
        profile: &str,
    ) -> WebviewWindowBuilder<'a, Wry, AppHandle> {
        let app = app.clone();
        let owner_label = owner.label().to_string();
        let opener_tab_id = tab_id.to_string();
        let profile = profile.to_string();
        builder.on_new_window(move |url, features| {
            new_window(&app, &owner_label, &opener_tab_id, &profile, url, features)
        })
    }

    fn new_window(
        app: &AppHandle,
        owner_label: &str,
        opener_tab_id: &str,
        profile: &str,
        url: Url,
        features: NewWindowFeatures,
    ) -> NewWindowResponse<Wry> {
        let Some(registry) = app.try_state::<BrowserRegistry>() else {
            return NewWindowResponse::Deny;
        };
        if !policy::navigation_allowed(&url) {
            return deny(app, opener_tab_id, &url, &features, "blocked-scheme");
        }
        if app
            .try_state::<BrowserPolicy>()
            .is_some_and(|policy| policy.blocked(&url))
        {
            return deny(app, opener_tab_id, &url, &features, "blocked-host");
        }
        let has_gesture = registry
            .recent_gestures(opener_tab_id)
            .iter()
            .any(|g| g.received.elapsed() <= policy::POPUP_GESTURE_WINDOW);
        if !has_gesture {
            return deny(app, opener_tab_id, &url, &features, "no-gesture");
        }
        let Some(owner) = app.get_webview_window(owner_label) else {
            return deny(app, opener_tab_id, &url, &features, "owner-gone");
        };
        // A fresh id: the counter is process-wide, but an id could still be
        // taken (the frontend names its own tabs), and a label already in use
        // would fail the build.
        let tab_id = loop {
            let seq = POPUP_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
            let candidate = format!("{opener_tab_id}-p{seq}");
            if !registry.contains(&candidate) {
                break candidate;
            }
        };
        let label = tab_label(&tab_id);
        // Held until the popup is registered: a deletion of the profile that
        // has begun refuses it, and one that begins now waits.
        let Ok(_admission) = profile::admit(profile) else {
            return deny(app, opener_tab_id, &url, &features, "profile-deleting");
        };
        // Inherited from the opener, and recorded as such: the popup's own
        // popups read it back from the registry.
        let devtools = registry
            .update(opener_tab_id, |tab| tab.devtools)
            .unwrap_or(false);
        let window = match super::build(
            app,
            &owner,
            &tab_id,
            &label,
            &crate::commands::browser::origin_title(&url),
            false,
            devtools,
            profile,
            Some(features.opener().webview.clone()),
        ) {
            Ok(window) => window,
            Err(err) => {
                tracing::warn!("[browser] popup window creation failed: {err}");
                return deny(app, opener_tab_id, &url, &features, "create-failed");
            }
        };
        let surface = BrowserSurface::Window(Box::new(window.clone()));
        let mut state = BrowserTabState {
            tab_id: tab_id.clone(),
            owner_window: owner_label.to_string(),
            kind: TabKind::Page,
            surface: SurfaceKind::Window,
            channel: ChannelKind::Degraded, // native once `hello` arrives
            channel_error: None,
            url: String::new(),
            requested_url: url.to_string(),
            title: String::new(),
            favicon: None,
            loading: true,
            can_go_back: false,
            can_go_forward: false,
            origin: None,
            zoom: 1.0,
            error: None,
            remote_host: profile::remote_host(profile),
            opener_tab_id: Some(opener_tab_id.to_string()),
            profile: Some(profile.to_string()),
            agent_grant: None,
        };
        // Before the engine loads anything into it.
        if let Err(err) = install_channel(&window) {
            tracing::warn!("[browser] popup {tab_id}: page channel unavailable ({err})");
            state.channel_error = Some(err.to_string());
        }
        if let Err(err) = registry.insert(BrowserTab::new(
            state.clone(),
            surface.clone(),
            Default::default(),
            true,
            devtools,
        )) {
            tracing::warn!("[browser] popup registry insert failed: {err}");
            let _ = surface.close();
            return deny(app, opener_tab_id, &url, &features, "registry");
        }
        // The engine navigates this window itself; arm the failed-load watcher
        // since a never-committing load reports nothing.
        hooks::begin_load(app, &tab_id);
        events::emit_state(app, &state);
        events::emit_popup(
            app,
            &BrowserPopupPayload {
                presentation: PopupPresentation::Adopted,
                opener_tab_id: opener_tab_id.to_string(),
                tab_id: Some(tab_id),
                url: url.to_string(),
                requested_size: features.size().map(|s| [s.width, s.height]),
                reason: None,
                profile: Some(profile.to_string()),
            },
        );
        NewWindowResponse::Create { window }
    }

    fn deny(
        app: &AppHandle,
        opener_tab_id: &str,
        url: &Url,
        features: &NewWindowFeatures,
        reason: &str,
    ) -> NewWindowResponse<Wry> {
        tracing::info!(
            "[browser] tab {opener_tab_id}: new-window request for {url} denied ({reason})"
        );
        events::emit_popup(
            app,
            &BrowserPopupPayload {
                presentation: PopupPresentation::Denied,
                opener_tab_id: opener_tab_id.to_string(),
                tab_id: None,
                url: url.to_string(),
                requested_size: features.size().map(|s| [s.width, s.height]),
                reason: Some(reason.to_string()),
                profile: None,
            },
        );
        NewWindowResponse::Deny
    }

    /// Main thread. The navigation decision, for whatever the surface wants to
    /// do with the address before the request goes out. Nothing today: the
    /// sign-in identity, which is what this moment exists for on the other
    /// platforms, cannot be scoped to the main frame here (see
    /// `shim/linux.rs`), and there is nothing else that has to happen this
    /// early.
    pub(super) fn navigating_to(_label: &str, _url: &Url) {}

    pub fn install_channel(window: &WebviewWindow) -> Result<bool, SurfaceError> {
        let app = window.app_handle().clone();
        let label = window.label().to_string();
        run_on_main(window.app_handle(), move || {
            WEBVIEWS.with(|live| {
                let live = live.borrow();
                let Some(live) = live.get(&label) else {
                    return Err(SurfaceError("this window has no engine webview".into()));
                };
                let tab_id = live.tab_id.clone();
                let sink: shim::MessageSink = Arc::new(move |raw, main_frame| {
                    channel::handle_message(&app, &tab_id, raw, main_frame)
                });
                shim::install_world(
                    &live.webview,
                    &[channel::PREFIX_SCRIPT, channel::HELPER_JS],
                    &[channel::FRAME_PREFIX_SCRIPT, channel::HELPER_JS],
                    &[channel::CONSOLE_JS],
                    sink,
                )
                .map_err(SurfaceError)
            })
        })?
    }

    pub fn eval_in_world(
        window: &WebviewWindow,
        expression: &str,
        callback: impl Fn(Result<String, String>) + Send + 'static,
    ) -> Result<(), SurfaceError> {
        let expression = expression.to_string();
        with(window, move |webview| {
            shim::eval_in_world(webview, &expression, callback)
        })?
        .map_err(SurfaceError)
    }

    pub fn snapshot_png(
        window: &WebviewWindow,
        callback: impl Fn(Result<Vec<u8>, String>) + Send + 'static,
    ) -> Result<(), SurfaceError> {
        with(window, move |webview| shim::snapshot_png(webview, callback))?.map_err(SurfaceError)
    }

    pub fn snapshot_jpeg(
        window: &WebviewWindow,
        quality: f64,
        callback: impl Fn(Result<(Vec<u8>, u32, u32), String>) + Send + 'static,
    ) -> Result<(), SurfaceError> {
        with(window, move |webview| {
            shim::snapshot_jpeg(webview, quality, callback)
        })?
        .map_err(SurfaceError)
    }

    pub fn find(
        window: &WebviewWindow,
        query: &str,
        forward: bool,
        callback: impl Fn(bool) + Send + 'static,
    ) -> Result<(), SurfaceError> {
        let query = query.to_string();
        with(window, move |webview| {
            shim::find_string(webview, &query, forward, callback)
        })?
        .map_err(SurfaceError)
    }

    pub fn clear_find(window: &WebviewWindow) -> Result<(), SurfaceError> {
        with(window, shim::clear_find)?.map_err(SurfaceError)
    }

    pub fn go_back(window: &WebviewWindow) -> Result<(), SurfaceError> {
        with(window, shim::go_back)
    }

    pub fn go_forward(window: &WebviewWindow) -> Result<(), SurfaceError> {
        with(window, shim::go_forward)
    }

    pub fn can_go_back(window: &WebviewWindow) -> Result<bool, SurfaceError> {
        with(window, shim::can_go_back)
    }

    pub fn can_go_forward(window: &WebviewWindow) -> Result<bool, SurfaceError> {
        with(window, shim::can_go_forward)
    }

    pub fn stop(window: &WebviewWindow) -> Result<(), SurfaceError> {
        with(window, shim::stop_loading)
    }

    pub fn is_loading(window: &WebviewWindow) -> Result<bool, SurfaceError> {
        with(window, shim::is_loading)
    }

    pub fn url(window: &WebviewWindow) -> Result<Url, SurfaceError> {
        let url = with(window, shim::current_url)?
            .ok_or_else(|| SurfaceError("nothing has been loaded in this window yet".into()))?;
        Url::parse(&url).map_err(|e| SurfaceError(e.to_string()))
    }

    /// No per-navigation identity here; the engine's own stands.
    pub fn refresh_user_agent(_window: &WebviewWindow) -> Result<(), SurfaceError> {
        Ok(())
    }

    pub fn debug_view(window: &WebviewWindow) -> Result<serde_json::Value, SurfaceError> {
        with(window, shim::debug_view)
    }
}

/// macOS / Windows: an owned window is the fallback surface, and the host does
/// not hold its engine webview — tauri hands that out on the main thread only,
/// and the embedded surface is where these operations are implemented on both
/// platforms. Nothing here fails silently: each call says what it needs.
#[cfg(not(target_os = "linux"))]
mod platform {
    use tauri::{AppHandle, Url, WebviewWindow, WebviewWindowBuilder, Wry};

    use super::super::surface::SurfaceError;

    /// Nothing is needed to relate an owned window to its opener here: the
    /// embedded surface is where a popup is adopted on both platforms.
    pub type OpenerView = ();

    /// The host has no hold on this window's engine webview, so there is
    /// nowhere to put the channel.
    pub const HAS_CHANNEL: bool = false;

    fn embedded_only(what: &str) -> SurfaceError {
        SurfaceError(format!("{what} needs an embedded surface on this platform"))
    }

    pub fn init_main_thread() {}

    pub(super) fn relate<'a>(
        builder: WebviewWindowBuilder<'a, Wry, AppHandle>,
        _opener: Option<OpenerView>,
    ) -> WebviewWindowBuilder<'a, Wry, AppHandle> {
        builder
    }

    /// `surface_child` answers `window.open` for the embedded surface, which is
    /// the one a page runs in here.
    pub(super) fn watch_new_windows<'a>(
        builder: WebviewWindowBuilder<'a, Wry, AppHandle>,
        _app: &AppHandle,
        _owner: &WebviewWindow,
        _tab_id: &str,
        _profile: &str,
    ) -> WebviewWindowBuilder<'a, Wry, AppHandle> {
        builder
    }

    pub(super) fn adopt(_app: &AppHandle, _window: &WebviewWindow, _tab_id: &str) {}

    pub(super) fn forget(_label: &str) {}

    pub(super) fn navigating_to(_label: &str, _url: &Url) {}

    pub fn install_channel(_window: &WebviewWindow) -> Result<bool, SurfaceError> {
        Err(embedded_only("the page channel"))
    }

    pub fn eval_in_world(
        _window: &WebviewWindow,
        _expression: &str,
        _callback: impl Fn(Result<String, String>) + Send + 'static,
    ) -> Result<(), SurfaceError> {
        Err(embedded_only("world evaluation"))
    }

    pub fn snapshot_png(
        _window: &WebviewWindow,
        _callback: impl Fn(Result<Vec<u8>, String>) + Send + 'static,
    ) -> Result<(), SurfaceError> {
        Err(embedded_only("snapshots"))
    }

    pub fn snapshot_jpeg(
        _window: &WebviewWindow,
        _quality: f64,
        _callback: impl Fn(Result<(Vec<u8>, u32, u32), String>) + Send + 'static,
    ) -> Result<(), SurfaceError> {
        Err(embedded_only("snapshots"))
    }

    pub fn find(
        _window: &WebviewWindow,
        _query: &str,
        _forward: bool,
        _callback: impl Fn(bool) + Send + 'static,
    ) -> Result<(), SurfaceError> {
        Err(embedded_only("find in page"))
    }

    pub fn clear_find(_window: &WebviewWindow) -> Result<(), SurfaceError> {
        Err(embedded_only("find in page"))
    }

    pub fn go_back(_window: &WebviewWindow) -> Result<(), SurfaceError> {
        Err(embedded_only("history navigation"))
    }

    pub fn go_forward(_window: &WebviewWindow) -> Result<(), SurfaceError> {
        Err(embedded_only("history navigation"))
    }

    pub fn can_go_back(_window: &WebviewWindow) -> Result<bool, SurfaceError> {
        Ok(false)
    }

    pub fn can_go_forward(_window: &WebviewWindow) -> Result<bool, SurfaceError> {
        Ok(false)
    }

    pub fn stop(_window: &WebviewWindow) -> Result<(), SurfaceError> {
        Err(embedded_only("stopping a load"))
    }

    pub fn is_loading(_window: &WebviewWindow) -> Result<bool, SurfaceError> {
        Err(embedded_only("the load state"))
    }

    /// Deliberately not asked of wry: `url()` unwraps `WKWebView.URL`, which is
    /// nil until a navigation has committed (or after the first one failed),
    /// and that unwrap panics the main thread. The registry state carries the
    /// URL either way.
    pub fn url(_window: &WebviewWindow) -> Result<Url, SurfaceError> {
        Err(SurfaceError(
            "owned windows report their URL through the tab state".into(),
        ))
    }

    /// An owned window here has no per-navigation identity and keeps the
    /// engine's own.
    pub fn refresh_user_agent(_window: &WebviewWindow) -> Result<(), SurfaceError> {
        Ok(())
    }

    pub fn debug_view(window: &WebviewWindow) -> Result<serde_json::Value, SurfaceError> {
        Ok(serde_json::json!({ "visible": window.is_visible().ok() }))
    }
}
