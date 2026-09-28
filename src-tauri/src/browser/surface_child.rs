//! Embedded surface for macOS / Windows: a wry child webview built straight
//! through tauri-runtime-wry's re-exported `wry` (`build_as_child` on the
//! owner window — the same call tauri-runtime-wry makes for its own child
//! webviews). tauri never learns about the view, so the workspace window stays
//! an ordinary `WebviewWindow` (see the `browser-child` note in Cargo.toml).
//!
//! wry's `WebView` is not `Send`; every instance lives in a thread-local on
//! the main thread and is only ever touched there. `ChildHandle` is the
//! `Send + Clone` stand-in the registry and the commands hold: each operation
//! hops to the main thread and waits for the answer, or runs inline when the
//! caller already is the main thread (wry handlers, window-event hooks).
//! Never call into a handle while holding the registry mutex — the main
//! thread may need that mutex to finish the very operation being waited on.
//!
//! Page-initiated new windows (`window.open`, `target=_blank`) are handled
//! here too: the engine asks for a webview, we build one from the opener's
//! configuration (which is what keeps `window.opener` alive) and hand it back
//! with `NewWindowResponse::Create`, registering it as a new tab next to the
//! opener. The host never navigates on the page's behalf.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, OnceLock};
use std::thread::ThreadId;
#[cfg(target_os = "windows")]
use std::time::Duration;

use tauri::{AppHandle, Manager, Url, WebviewWindow};
#[cfg(target_os = "windows")]
use tauri_runtime_wry::wry::WebContext;
use tauri_runtime_wry::wry::{
    self, dpi, NewWindowFeatures, NewWindowResponse, PageLoadEvent, Rect, WebViewBuilder,
};

use super::channel::{self, MessageSink};
use super::doc_guest::{self, DocGrant, DocGuests, GuestNavigation};
use super::events;
use super::hooks;
use super::policy::{self, BrowserPolicy};
use super::profile;
use super::registry::{BrowserRegistry, BrowserTab};
use super::surface::BrowserSurface;
use super::types::{
    Bounds, BrowserOpenRequestPayload, BrowserPopupPayload, BrowserTabState, ChannelKind,
    NavigationBlockReason, PopupPresentation, SurfaceKind, TabKind,
};
#[cfg(target_os = "macos")]
use super::shim::macos as shim;
#[cfg(target_os = "windows")]
use super::shim::windows as shim;

thread_local! {
    static SURFACES: RefCell<HashMap<String, wry::WebView>> = RefCell::new(HashMap::new());
}

static MAIN_THREAD: OnceLock<ThreadId> = OnceLock::new();
static POPUP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Must be called once from the main thread (tauri's `setup` hook) before any
/// surface is created; lets `ChildHandle` run inline instead of deadlocking
/// when it is used from a wry callback.
pub fn init_main_thread() {
    let _ = MAIN_THREAD.set(std::thread::current().id());
}

fn on_main_thread() -> bool {
    MAIN_THREAD.get() == Some(&std::thread::current().id())
}

#[derive(Debug, thiserror::Error)]
pub enum ChildError {
    #[error("browser surface {0} is gone")]
    Gone(String),
    #[error("main-thread dispatch failed: {0}")]
    Dispatch(String),
    #[error("{0}")]
    Op(String),
}

fn run_on_main<R: Send + 'static>(
    app: &AppHandle,
    f: impl FnOnce() -> R + Send + 'static,
) -> Result<R, ChildError> {
    if on_main_thread() {
        return Ok(f());
    }
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .map_err(|e| ChildError::Dispatch(e.to_string()))?;
    rx.recv().map_err(|e| ChildError::Dispatch(e.to_string()))
}

fn rect(bounds: Bounds) -> Rect {
    Rect {
        position: dpi::Position::Logical(dpi::LogicalPosition::new(bounds.x, bounds.y)),
        size: dpi::Size::Logical(dpi::LogicalSize::new(bounds.width, bounds.height)),
    }
}

/// Main thread only: which tab owns the platform webview behind `pointer`
/// (see `channel::MessageSink`).
fn tab_id_for_webview(pointer: usize) -> Option<String> {
    SURFACES.with(|s| {
        s.borrow()
            .iter()
            .find(|(_, wv)| shim::webview_pointer(wv) == pointer)
            .map(|(id, _)| id.clone())
    })
}

/// One sink for every tab: messages are attributed by source webview, because
/// an adopted popup shares its opener's user-content controller (macOS).
fn message_sink(app: &AppHandle) -> MessageSink {
    let app = app.clone();
    Arc::new(move |raw, main_frame, source| match tab_id_for_webview(source) {
        Some(tab_id) => channel::handle_message(&app, &tab_id, raw, main_frame),
        None => tracing::debug!("[browser] channel message from an unknown webview dropped"),
    })
}

/// Main thread only. Hook the engine's navigation reporting so failures and
/// provisional starts reach the registry, and its `window.close()` so a page
/// that closes its own window is heard. Neither is fatal when it cannot be
/// done: the load watcher still notices a failed load, only later and untyped,
/// and a popup that closes itself simply stays until the person closes it.
fn attach_engine_hooks(app: &AppHandle, tab_id: &str, kind: &ChildKind, webview: &wry::WebView) {
    #[cfg(target_os = "macos")]
    let installed = {
        let _ = kind;
        shim::install_navigation_delegate(webview, hooks::navigation_sink(app, tab_id))
    };
    #[cfg(target_os = "windows")]
    let installed = shim::install_navigation_hooks(
        webview,
        hooks::navigation_sink(app, tab_id),
        frame_navigation_sink(app, tab_id, kind),
        download_permission_sink(app, tab_id, kind),
    );
    if let Err(err) = installed {
        tracing::warn!(
            "[browser] tab {tab_id}: navigation hooks not installed ({err}); failures are detected by polling"
        );
    }
    // Installed on every child, guest included: whether a tab may act on the
    // request is `hooks::page_may_close_itself`'s to say, and it says no to
    // everything but an adopted popup.
    if let Err(err) = shim::install_page_close_hook(webview, hooks::page_close_sink(app, tab_id)) {
        tracing::warn!(
            "[browser] tab {tab_id}: window.close() not hooked ({err}); a page closing its own window is ignored"
        );
    }
}

/// Windows only: whether a SUBFRAME may navigate to an address. WebView2's
/// `NavigationStarting` — the event wry turns into the navigation handler —
/// fires for the main frame alone, so without this an iframe would be outside
/// the scheme list and the `block` site rules altogether. The same decision
/// the main handler makes for a non-main frame, asked per frame.
#[cfg(target_os = "windows")]
fn frame_navigation_sink(
    app: &AppHandle,
    tab_id: &str,
    kind: &ChildKind,
) -> shim::FrameNavigationSink {
    let app = app.clone();
    let tab_id = tab_id.to_string();
    // The host of the document this guest shows, if it is one: a frame may
    // go to its own document's addresses and nowhere else — another guest's
    // host included.
    let document = match kind {
        ChildKind::Document(grant) => Some(grant.host().to_string()),
        ChildKind::Page => None,
    };
    Arc::new(move |url: &str| {
        let Ok(parsed) = Url::parse(url) else {
            return false;
        };
        if let Some(host) = &document {
            return matches!(
                doc_guest::guest_navigation(&parsed, host, false),
                GuestNavigation::Allow
            );
        }
        if !policy::subframe_navigation_allowed(&parsed) {
            tracing::debug!("[browser] tab {tab_id} blocked frame navigation to {url}");
            return false;
        }
        // A `block` site rule applies to every frame: a page must not be able
        // to load a blocked host by embedding it.
        if app
            .try_state::<BrowserPolicy>()
            .is_some_and(|policy| policy.blocked(&parsed))
        {
            tracing::debug!("[browser] tab {tab_id} blocked frame navigation to {url} (site rule)");
            return false;
        }
        true
    })
}

/// How far back a page that wants to download several files at once may look
/// for a click. Longer than the popup's second: a "download all" button fires
/// its requests over the time the server takes to answer each one, and the
/// engine only asks once the second download is already on its way.
#[cfg(target_os = "windows")]
const DOWNLOAD_GESTURE_WINDOW: Duration = Duration::from_secs(5);

/// Windows only: the answer to WebView2's multiple-downloads permission,
/// which the engine would otherwise put to the user in a bubble of its own
/// drawn over the page — and hold `DownloadStarting` back until it is
/// answered, so a click would appear to do nothing and codeg's download bar
/// would stay empty.
///
/// The same test the popup blocker applies: a page that was clicked recently
/// is doing what the user asked, and every file it takes shows up in the
/// download bar; one that was not is refused and says so. A document guest
/// does not download at all.
#[cfg(target_os = "windows")]
fn download_permission_sink(
    app: &AppHandle,
    tab_id: &str,
    kind: &ChildKind,
) -> shim::DownloadPermissionSink {
    let app = app.clone();
    let id = tab_id.to_string();
    let document = matches!(kind, ChildKind::Document(_));
    Arc::new(move |url: &str, user_initiated: bool| {
        if document {
            return false;
        }
        // The engine's own reading of "the user asked for this" counts too:
        // it is all a tab with no page channel has, since a gesture reaches
        // the ring through the channel.
        let gesture = app
            .try_state::<BrowserRegistry>()
            .is_some_and(|registry| {
                registry
                    .recent_gestures(&id)
                    .iter()
                    .any(|g| g.received.elapsed() <= DOWNLOAD_GESTURE_WINDOW)
            });
        if gesture || user_initiated {
            tracing::info!(
                "[browser] tab {id}: several downloads from {url} allowed (gesture {gesture}, engine {user_initiated})"
            );
            return true;
        }
        hooks::navigation_blocked(&app, &id, url, NavigationBlockReason::Download);
        false
    })
}

/// Inside a navigation handler: is the action being decided for the main
/// frame? Where the platform cannot say, the strict answer.
fn current_navigation_is_main_frame() -> bool {
    #[cfg(target_os = "macos")]
    {
        shim::current_navigation_is_main_frame().unwrap_or(true)
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

/// Main thread only: forget a tab's webview together with everything hung
/// on it. `true` when there was one.
fn drop_surface(id: &str) -> bool {
    SURFACES.with(|s| {
        let removed = s.borrow_mut().remove(id);
        if let Some(webview) = &removed {
            shim::forget_navigation_delegate(webview);
        }
        removed.is_some()
    })
}

#[derive(Clone, Debug)]
pub struct ChildHandle {
    tab_id: String,
    label: String,
    app: AppHandle,
}

impl ChildHandle {
    pub fn label(&self) -> &str {
        &self.label
    }

    /// Run `f` against the live webview on the main thread.
    fn with<R: Send + 'static>(
        &self,
        f: impl FnOnce(&wry::WebView) -> R + Send + 'static,
    ) -> Result<R, ChildError> {
        let id = self.tab_id.clone();
        run_on_main(&self.app, move || {
            SURFACES.with(|s| s.borrow().get(&id).map(f))
        })?
        .ok_or_else(|| ChildError::Gone(self.tab_id.clone()))
    }

    fn op(
        &self,
        f: impl FnOnce(&wry::WebView) -> wry::Result<()> + Send + 'static,
    ) -> Result<(), ChildError> {
        self.with(move |wv| f(wv).map_err(|e| e.to_string()))?
            .map_err(ChildError::Op)
    }

    pub fn load_url(&self, url: &str) -> Result<(), ChildError> {
        let url = url.to_string();
        self.op(move |wv| wv.load_url(&url))
    }

    pub fn reload(&self) -> Result<(), ChildError> {
        self.op(|wv| wv.reload())
    }

    /// The committed URL. `Err` while nothing has committed yet — never
    /// wry's `url()`, whose `unwrap` of a nil `WKWebView.URL` panics the
    /// main thread.
    pub fn url(&self) -> Result<String, ChildError> {
        self.with(shim::current_url)?
            .ok_or_else(|| ChildError::Op("no committed URL yet".into()))
    }

    /// Whether the engine still has a navigation in flight.
    pub fn is_loading(&self) -> Result<bool, ChildError> {
        self.with(shim::is_loading)
    }

    pub fn evaluate_script(&self, js: &str) -> Result<(), ChildError> {
        let js = js.to_string();
        self.op(move |wv| wv.evaluate_script(&js))
    }

    pub fn evaluate_script_with_callback(
        &self,
        js: &str,
        callback: impl Fn(String) + Send + 'static,
    ) -> Result<(), ChildError> {
        let js = js.to_string();
        self.op(move |wv| wv.evaluate_script_with_callback(&js, callback))
    }

    pub fn set_bounds(&self, bounds: Bounds) -> Result<(), ChildError> {
        self.op(move |wv| wv.set_bounds(rect(bounds)))
    }

    pub fn set_visible(&self, visible: bool) -> Result<(), ChildError> {
        self.op(move |wv| wv.set_visible(visible))
    }

    pub fn focus(&self) -> Result<(), ChildError> {
        self.op(|wv| wv.focus())
    }

    pub fn zoom(&self, factor: f64) -> Result<(), ChildError> {
        self.op(move |wv| wv.zoom(factor))
    }

    /// Through the shim, not `wry::WebView::open_devtools()`: the platforms
    /// differ in what they will say about the inspector afterwards, and the
    /// caller needs to know. `true` = it is up and this surface can be asked
    /// when it goes (macOS).
    pub fn open_devtools(&self) -> Result<bool, ChildError> {
        self.with(shim::open_devtools)
    }

    /// Whether the inspector is still on screen. Polled after `open_devtools`
    /// answered `true` — WebKit reports its closing no other way, and a page
    /// an inspector was docked into has to be put back when it does.
    pub fn devtools_visible(&self) -> Result<bool, ChildError> {
        self.with(shim::devtools_visible)
    }

    pub fn clear_all_browsing_data(&self) -> Result<(), ChildError> {
        self.op(|wv| wv.clear_all_browsing_data())
    }

    /// Install the isolated-world helper and the native message handler.
    /// `Ok(true)` = isolated world, `Ok(false)` = page-world fallback.
    pub fn install_channel(&self) -> Result<bool, ChildError> {
        self.install_channel_inner(false)
    }

    /// The same, for a webview the engine handed over for a page-initiated new
    /// window: its first document is the engine's own and the injection cannot
    /// be in time for that one, whatever address it reports.
    pub fn install_adopted_channel(&self) -> Result<bool, ChildError> {
        self.install_channel_inner(true)
    }

    fn install_channel_inner(&self, adopted: bool) -> Result<bool, ChildError> {
        let sink = message_sink(&self.app);
        let _ = adopted;
        #[cfg(target_os = "macos")]
        {
            self.with(move |wv| {
                shim::install_world(
                    wv,
                    &[channel::PREFIX_SCRIPT, channel::HELPER_JS],
                    &[channel::CONSOLE_JS],
                    sink,
                )
            })?
            .map_err(ChildError::Op)
        }
        // Windows needs no prefix script: the CDP binding IS the send
        // primitive the helper looks for. The install waits for the engine's
        // completions by pumping the message loop, so the engine object is
        // taken out of the surface map first — anything that pump dispatches
        // (a tab closing, another opening) needs the map free. The engine
        // reports the page's console itself, and the helper is told so.
        #[cfg(target_os = "windows")]
        {
            let id = self.tab_id.clone();
            run_on_main(&self.app, move || {
                SURFACES
                    .with(|s| s.borrow().get(&id).map(shim::engine_webview))
                    .map(|wv| {
                        shim::install_world(wv, channel::HELPER_JS_ENGINE_CONSOLE, sink, adopted)
                    })
            })?
            .ok_or_else(|| ChildError::Gone(self.tab_id.clone()))?
            .map_err(ChildError::Op)
        }
    }

    /// Evaluate an expression in the helper's world; see `shim::eval_in_world`
    /// for the result envelope.
    pub fn eval_in_world(
        &self,
        expression: &str,
        callback: impl Fn(Result<String, String>) + Send + 'static,
    ) -> Result<(), ChildError> {
        let expression = expression.to_string();
        self.with(move |wv| shim::eval_in_world(wv, &expression, callback))?
            .map_err(ChildError::Op)
    }

    /// Deliver a real pointer event at a page point; see
    /// `shim::dispatch_pointer`.
    pub fn dispatch_pointer(
        &self,
        gesture: super::surface::PointerGesture,
        done: impl FnOnce(Result<(), super::surface::PointerFailure>) + Send + 'static,
    ) -> Result<(), ChildError> {
        self.with(move |wv| shim::dispatch_pointer(wv, gesture, done))?
            .map_err(ChildError::Op)
    }

    pub fn snapshot_png(
        &self,
        callback: impl Fn(Result<Vec<u8>, String>) + Send + 'static,
    ) -> Result<(), ChildError> {
        self.with(move |wv| shim::snapshot_png(wv, callback))?
            .map_err(ChildError::Op)
    }

    /// The frame as displayed now, JPEG-encoded, for the freeze frame.
    pub fn snapshot_jpeg(
        &self,
        quality: f64,
        callback: impl Fn(Result<(Vec<u8>, u32, u32), String>) + Send + 'static,
    ) -> Result<(), ChildError> {
        self.with(move |wv| shim::snapshot_jpeg(wv, quality, callback))?
            .map_err(ChildError::Op)
    }

    /// Highlight the next / previous match of `query`; the callback gets
    /// whether anything matched.
    pub fn find(
        &self,
        query: &str,
        forward: bool,
        callback: impl Fn(bool) + Send + 'static,
    ) -> Result<(), ChildError> {
        let query = query.to_string();
        self.with(move |wv| shim::find_string(wv, &query, forward, callback))?
            .map_err(ChildError::Op)
    }

    /// Re-decide the identity for the page the webview shows right now (the
    /// preference changed). Read from the webview itself on the main thread,
    /// not from a state snapshot: a tab id can name a newer incarnation by
    /// the time a snapshot is acted on.
    pub fn refresh_user_agent(&self) -> Result<(), ChildError> {
        self.with(shim::refresh_user_agent)
    }

    pub fn clear_find(&self) -> Result<(), ChildError> {
        self.with(shim::clear_find)?.map_err(ChildError::Op)
    }

    pub fn go_back(&self) -> Result<(), ChildError> {
        self.with(shim::go_back)
    }

    pub fn go_forward(&self) -> Result<(), ChildError> {
        self.with(shim::go_forward)
    }

    pub fn can_go_back(&self) -> Result<bool, ChildError> {
        self.with(shim::can_go_back)
    }

    pub fn can_go_forward(&self) -> Result<bool, ChildError> {
        self.with(shim::can_go_forward)
    }

    pub fn stop(&self) -> Result<(), ChildError> {
        self.with(shim::stop_loading)
    }

    /// Dev puppet only: native-side state for a tab.
    pub fn debug_view(&self) -> Result<serde_json::Value, ChildError> {
        self.with(|wv| {
            let mut v = shim::debug_view(wv);
            v["wryBounds"] = wv
                .bounds()
                .map(|b| serde_json::json!(format!("{b:?}")))
                .unwrap_or(serde_json::Value::Null);
            v
        })
    }

    /// Detach and drop the webview (on the main thread; wry removes the
    /// native view from the window when the `WebView` drops).
    pub fn close(&self) -> Result<(), ChildError> {
        let id = self.tab_id.clone();
        let removed = run_on_main(&self.app, move || drop_surface(&id))?;
        if removed {
            Ok(())
        } else {
            Err(ChildError::Gone(self.tab_id.clone()))
        }
    }
}

/// Opener-provided platform configuration for a popup webview: what carries
/// the opener's data store on macOS, and the environment WebView2 insists a
/// new window be created from on Windows.
#[cfg(target_os = "macos")]
type OpenerConfiguration = objc2::rc::Retained<objc2_web_kit::WKWebViewConfiguration>;
#[cfg(target_os = "windows")]
type OpenerConfiguration = webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Environment;

/// What a child webview is for. A page gets the browser's policy (scheme
/// lists, site rules, popups, downloads); a document guest gets the guest's
/// (its own scheme, nothing else, no popups, no downloads) and the handler
/// that serves its files.
#[derive(Clone)]
pub enum ChildKind {
    Page,
    Document(Arc<DocGrant>),
}

#[cfg(target_os = "windows")]
thread_local! {
    // WebView2 keeps a webview's cookies and storage in its environment's
    // user-data folder; a profile's directory is that folder for every
    // browser webview of the profile in this process. One context per
    // profile, kept alive like tauri keeps its own.
    static WEB_CONTEXTS: RefCell<HashMap<String, WebContext>> = RefCell::new(HashMap::new());
}

/// Windows: drop the web context of a profile that is being deleted, so its
/// folder is no longer held open by this process (the engine's own browser
/// process may still be winding down; a deletion that fails is reported to
/// the user, who can retry). Main thread.
#[cfg(target_os = "windows")]
pub fn forget_profile_context(app: &AppHandle, profile_id: &str) -> Result<(), ChildError> {
    let profile_id = profile_id.to_string();
    run_on_main(app, move || {
        WEB_CONTEXTS.with(|contexts| {
            contexts.borrow_mut().remove(&profile_id);
        });
    })
}

/// Main thread only. Builds the child webview at `bounds` with every hook
/// attached and **no URL**: a regular tab is navigated by the caller once the
/// page channel is installed, a popup is navigated by the engine itself.
#[allow(clippy::too_many_arguments)]
fn build_child(
    app: &AppHandle,
    owner: &WebviewWindow,
    tab_id: &str,
    label: &str,
    bounds: Bounds,
    visible: bool,
    devtools: bool,
    configuration: Option<OpenerConfiguration>,
    kind: &ChildKind,
    profile: &str,
) -> Result<wry::WebView, String> {
    #[cfg(target_os = "windows")]
    {
        // Before the window's first child webview exists, because dropping one
        // takes the window's own resize hook away with it: see
        // `shim::hold_resize_hook`. Not fatal — a window that keeps wry's hook
        // until its first tab closes is still better than no tab at all.
        if let Err(err) = shim::hold_resize_hook(owner) {
            tracing::warn!(
                "[browser] window {}: resize hook not held ({err}); the app's webview may keep \
                 the wrong size once a tab closes",
                owner.label()
            );
        }
        // A popup is built into the environment its opener handed over —
        // WebView2 refuses a new window created from any other one — and that
        // environment already carries the opener's profile directory. Only a
        // regular tab picks its own.
        if configuration.is_some() {
            return configure_child(
                WebViewBuilder::new(),
                app,
                owner,
                tab_id,
                label,
                bounds,
                visible,
                devtools,
                configuration,
                kind,
                profile,
            )?
            .build_as_child(owner)
            .map_err(|e| e.to_string());
        }
        WEB_CONTEXTS.with(|contexts| {
            let mut contexts = contexts.borrow_mut();
            let context = contexts
                .entry(profile.to_string())
                .or_insert_with(|| WebContext::new(Some(profile::directory(profile))));
            configure_child(
                WebViewBuilder::new_with_web_context(context),
                app,
                owner,
                tab_id,
                label,
                bounds,
                visible,
                devtools,
                configuration,
                kind,
                profile,
            )?
            .build_as_child(owner)
            .map_err(|e| e.to_string())
        })
    }
    #[cfg(not(target_os = "windows"))]
    {
        configure_child(
            WebViewBuilder::new(),
            app,
            owner,
            tab_id,
            label,
            bounds,
            visible,
            devtools,
            configuration,
            kind,
            profile,
        )?
        .build_as_child(owner)
        .map_err(|e| e.to_string())
    }
}

/// The `codeg-doc:` handler of one document guest. Registered on the guest's
/// builder alone, bound to its grant, and checked against the webview it is
/// called for; the file work happens off the main thread (the engine calls
/// here on it), and a request that ends dynamic mode reports the new state.
fn document_protocol(
    app: &AppHandle,
    tab_id: &str,
    label: &str,
    grant: Arc<DocGrant>,
) -> impl Fn(wry::WebViewId<'_>, wry::http::Request<Vec<u8>>, wry::RequestAsyncResponder) + 'static {
    let app = app.clone();
    let tab_id = tab_id.to_string();
    let label = label.to_string();
    move |webview_id, request, responder| {
        if webview_id != label {
            tracing::warn!(
                "[browser] document request from webview {webview_id:?} refused (handler belongs to {label})"
            );
            responder.respond(doc_guest::forbidden());
            return;
        }
        let grant = grant.clone();
        let app = app.clone();
        let tab_id = tab_id.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let served = grant.serve(&request);
            let reset = served.reset.is_some();
            if let Some(reset) = &served.reset {
                tracing::info!(
                    "[browser] document {tab_id}: {} {:?} after scripts were enabled; back in safe mode",
                    reset.path,
                    reset.reason
                );
                events::emit_doc_state(&app, &grant.state(&tab_id));
            }
            responder.respond(served.response);
            // The documents that are loading were served under the dynamic
            // policy; reload every guest of this grant so the safe one
            // applies to the whole page everywhere, not only to the file
            // that was refused in this guest. Done here, not left to the
            // frontend, so the fence holds with nobody watching.
            if reset {
                let registry = app.try_state::<BrowserRegistry>();
                let guests = app.try_state::<DocGuests>();
                if let (Some(registry), Some(guests)) = (registry, guests) {
                    for id in guests.tabs_of(&grant) {
                        let Some(surface) = registry.surface(&id) else {
                            continue;
                        };
                        if let Err(err) = surface.reload() {
                            tracing::warn!("[browser] document {id}: reload after reset failed: {err}");
                        } else {
                            hooks::begin_load(&app, &id);
                        }
                    }
                }
            }
        });
    }
}

#[allow(clippy::too_many_arguments)]
fn configure_child<'a>(
    builder: WebViewBuilder<'a>,
    app: &AppHandle,
    owner: &WebviewWindow,
    tab_id: &str,
    label: &'a str,
    bounds: Bounds,
    visible: bool,
    devtools: bool,
    configuration: Option<OpenerConfiguration>,
    kind: &ChildKind,
    profile: &str,
) -> Result<WebViewBuilder<'a>, String> {
    let nav_id = tab_id.to_string();
    let nav_app = app.clone();
    let nav_owner = owner.label().to_string();
    let nav_kind = kind.clone();
    // The profile this webview was built in, fixed for its life: what the
    // hooks report, rather than a registry lookup that could find a later
    // incarnation of the same id or nothing at all.
    let nav_profile = profile.to_string();
    let mut builder = builder
        .with_id(label)
        .with_bounds(rect(bounds))
        .with_visible(visible)
        .with_focused(false)
        .with_devtools(devtools)
        .with_hotkeys_zoom(true);
    // The identity this surface starts out with. Every main-frame navigation
    // re-decides it (`shim::*::apply_user_agent`), but that hook is not
    // installed yet here, and the first request must not be the one that goes
    // out as a nameless engine.
    if let Some(user_agent) = profile::default_user_agent() {
        builder = builder.with_user_agent(user_agent);
    }
    builder = builder
        .with_navigation_handler(move |url| {
            let Ok(parsed) = Url::parse(&url) else {
                tracing::info!("[browser] tab {nav_id} blocked unparsable navigation {url:?}");
                return false;
            };
            // The engine asks about every frame's navigation; only the
            // top-level one gets the strict list and a notice when refused.
            let main_frame = current_navigation_is_main_frame();
            // A document guest: its own documents and nothing with a scheme
            // of its own. A web address is reported so the user can open it
            // in a tab; the guest itself never leaves its root.
            if let ChildKind::Document(grant) = &nav_kind {
                return match doc_guest::guest_navigation(&parsed, grant.host(), main_frame) {
                    GuestNavigation::Allow => true,
                    GuestNavigation::External => {
                        if main_frame {
                            hooks::navigation_blocked(&nav_app, &nav_id, &url, NavigationBlockReason::External);
                        }
                        false
                    }
                    GuestNavigation::Scheme => {
                        if main_frame {
                            hooks::navigation_blocked(&nav_app, &nav_id, &url, NavigationBlockReason::Scheme);
                        }
                        false
                    }
                };
            }
            let scheme_ok = if main_frame {
                policy::navigation_allowed(&parsed)
            } else {
                policy::subframe_navigation_allowed(&parsed)
            };
            if !scheme_ok {
                if main_frame {
                    hooks::navigation_blocked(&nav_app, &nav_id, &url, NavigationBlockReason::Scheme);
                } else {
                    tracing::debug!("[browser] tab {nav_id} blocked frame navigation to {url}");
                }
                return false;
            }
            // A `block` site rule applies to every frame: a page must not be
            // able to load a blocked host by embedding it.
            if nav_app
                .try_state::<BrowserPolicy>()
                .is_some_and(|policy| policy.blocked(&parsed))
            {
                if main_frame {
                    hooks::navigation_blocked(&nav_app, &nav_id, &url, NavigationBlockReason::HostRule);
                }
                return false;
            }
            // ⌘/Ctrl-click on a plain anchor: the page did not prevent the
            // default, so the engine is about to navigate this tab. Browsers
            // open a background tab instead; so do we — the host cancels the
            // in-place navigation and asks the frontend for a new tab. (No
            // JS involved: a page can always add a later listener, so only
            // the navigation itself is a reliable signal.)
            if let Some(registry) = nav_app.try_state::<BrowserRegistry>() {
                if registry.take_modifier_click(&nav_id, &url, policy::POPUP_GESTURE_WINDOW) {
                    events::emit_open_request(
                        &nav_app,
                        &BrowserOpenRequestPayload {
                            url: url.clone(),
                            source: "modifier-click".to_string(),
                            activate: false,
                            owner_window: Some(nav_owner.clone()),
                            opener_tab_id: Some(nav_id.clone()),
                            profile: Some(nav_profile.clone()),
                            request_id: None,
                        },
                    );
                    return false;
                }
            }
            // A remote profile's page on macOS addresses the remote host's
            // loopback by an alias (see `browser::remote`), WebKit sending
            // loopback addresses around the proxy: a link, redirect or script
            // that goes to one is refused, and the tab goes to the same
            // address on the alias instead. After the modifier-click check,
            // which opens its own tab and so its own rewrite. A frame cannot
            // be sent anywhere by the host; it is refused (its load would be
            // stopped by the profile's loopback rules all the same). A form
            // POSTed to a loopback address arrives as a GET: rare, since a
            // remote page's own forms post to its own (alias) origin.
            #[cfg(target_os = "macos")]
            if profile::is_remote_profile(&nav_profile) {
                if let Some(alias) = crate::browser::remote::alias_for(&parsed) {
                    if main_frame {
                        crate::browser::remote::redirect_to_alias(&nav_app, &nav_id, alias);
                    } else {
                        tracing::debug!("[browser] tab {nav_id} blocked a loopback frame: {url}");
                    }
                    return false;
                }
            }
            true
        })
        .with_on_page_load_handler({
            let app = app.clone();
            let id = tab_id.to_string();
            move |event, url| {
                if let Ok(url) = Url::parse(&url) {
                    hooks::page_load(&app, &id, &url, matches!(event, PageLoadEvent::Started));
                }
            }
        })
        .with_document_title_changed_handler({
            let app = app.clone();
            let id = tab_id.to_string();
            move |title| hooks::title_changed(&app, &id, title)
        });
    builder = match kind {
        ChildKind::Page => builder
            // The engine transfers the file; the host only decides where it
            // may land (`downloads::requested` rewrites the path) and
            // reports it.
            .with_download_started_handler({
                let app = app.clone();
                let id = tab_id.to_string();
                move |url, destination| super::downloads::requested(&app, &id, &url, destination)
            })
            .with_download_completed_handler({
                let app = app.clone();
                move |url: String, path, success| {
                    super::downloads::finished(&app, &url, path, success)
                }
            })
            .with_new_window_req_handler(new_window_handler(app.clone(), owner.clone(), tab_id.to_string(), profile.to_string())),
        ChildKind::Document(grant) => builder
            // A document does not download and does not open windows: both
            // are refused and reported, and a web address a `window.open`
            // names is offered to the user like a link would be.
            .with_download_started_handler({
                let app = app.clone();
                let id = tab_id.to_string();
                move |url, _destination| {
                    hooks::navigation_blocked(&app, &id, &url, NavigationBlockReason::Download);
                    false
                }
            })
            .with_new_window_req_handler({
                let app = app.clone();
                let id = tab_id.to_string();
                move |url, _features| {
                    let reason = match Url::parse(&url) {
                        Ok(parsed) if matches!(parsed.scheme(), "http" | "https") => {
                            NavigationBlockReason::External
                        }
                        _ => NavigationBlockReason::Scheme,
                    };
                    hooks::navigation_blocked(&app, &id, &url, reason);
                    NewWindowResponse::Deny
                }
            })
            .with_asynchronous_custom_protocol(
                doc_guest::DOC_SCHEME.to_string(),
                document_protocol(app, tab_id, label, grant.clone()),
            ),
    };
    #[cfg(target_os = "macos")]
    {
        use tauri_runtime_wry::wry::WebViewBuilderExtMacos;
        let mtm = objc2::MainThreadMarker::new().ok_or("not on the main thread")?;
        // A popup keeps its opener's configuration (that is what preserves
        // `window.opener`); a regular tab gets one whose data store is the
        // browser profile's, so nothing a page stores lands in the app's own
        // store and the profile's proxy applies; a document guest gets a
        // store that dies with it.
        let configuration = match (configuration, kind) {
            (Some(configuration), _) => configuration,
            (None, ChildKind::Page) => super::shim::macos::profile_configuration(mtm, profile)?,
            (None, ChildKind::Document(_)) => super::shim::macos::document_configuration(mtm),
        };
        builder = builder.with_webview_configuration(configuration);
    }
    #[cfg(target_os = "windows")]
    {
        use tauri_runtime_wry::wry::WebViewBuilderExtWindows;
        // WebView2 takes the proxy (and everything else) from the environment's
        // browser arguments: one string per user-data folder for the life of
        // the process, see `profile::windows_args_for`.
        builder = builder.with_additional_browser_args(profile::windows_args_for(profile)?);
        // A popup: the opener's environment, arguments and user-data folder
        // included, which is what makes `NewWindowResponse::Create` acceptable
        // to the engine.
        if let Some(environment) = configuration {
            builder = builder.with_environment(environment);
        }
        // A document guest keeps nothing: an in-private profile of the same
        // environment — which is ONE partition for every guest of the
        // process, unlike macOS where each gets its own data store. What
        // keeps two documents' storage apart on this platform is that they
        // are two origins (`doc_guest::mint_host`), not the partition.
        if let ChildKind::Document(_) = kind {
            builder = builder.with_incognito(true);
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let _ = configuration;
    Ok(builder)
}

/// Build the child webview for a regular tab. The caller navigates afterwards,
/// once the page ↔ host channel is installed.
#[allow(clippy::too_many_arguments)]
pub fn create(
    app: &AppHandle,
    owner: &WebviewWindow,
    tab_id: &str,
    label: &str,
    bounds: Bounds,
    background: bool,
    devtools: bool,
    profile: &str,
) -> Result<ChildHandle, ChildError> {
    let handle = ChildHandle {
        tab_id: tab_id.to_string(),
        label: label.to_string(),
        app: app.clone(),
    };
    let app = app.clone();
    let owner = owner.clone();
    let id = tab_id.to_string();
    let label = label.to_string();
    let profile = profile.to_string();
    run_on_main(&app.clone(), move || -> Result<(), String> {
        let kind = ChildKind::Page;
        let webview = build_child(&app, &owner, &id, &label, bounds, !background, devtools, None, &kind, &profile)?;
        attach_engine_hooks(&app, &id, &kind, &webview);
        SURFACES.with(|s| s.borrow_mut().insert(id, webview));
        Ok(())
    })?
    .map_err(ChildError::Op)?;
    Ok(handle)
}

/// Build the child webview for a document guest: the same surface as a tab,
/// with the guest's policy and the handler that serves `grant`'s files. The
/// caller navigates to the document once the page ↔ host channel is in.
#[allow(clippy::too_many_arguments)]
pub fn create_document(
    app: &AppHandle,
    owner: &WebviewWindow,
    tab_id: &str,
    label: &str,
    bounds: Bounds,
    background: bool,
    devtools: bool,
    grant: Arc<DocGrant>,
) -> Result<ChildHandle, ChildError> {
    let handle = ChildHandle {
        tab_id: tab_id.to_string(),
        label: label.to_string(),
        app: app.clone(),
    };
    let app = app.clone();
    let owner = owner.clone();
    let id = tab_id.to_string();
    let label = label.to_string();
    run_on_main(&app.clone(), move || -> Result<(), String> {
        let kind = ChildKind::Document(grant);
        // A guest's store is its own (non-persistent); the profile only names
        // the WebView2 environment it would share on Windows.
        let webview = build_child(&app, &owner, &id, &label, bounds, !background, devtools, None, &kind, profile::DEFAULT_PROFILE_ID)?;
        attach_engine_hooks(&app, &id, &kind, &webview);
        SURFACES.with(|s| s.borrow_mut().insert(id, webview));
        Ok(())
    })?
    .map_err(ChildError::Op)?;
    Ok(handle)
}

fn deny(app: &AppHandle, opener_tab_id: &str, url: &str, features: &NewWindowFeatures, reason: &str) -> NewWindowResponse {
    tracing::info!("[browser] tab {opener_tab_id}: new-window request for {url} denied ({reason})");
    events::emit_popup(
        app,
        &BrowserPopupPayload {
            presentation: PopupPresentation::Denied,
            opener_tab_id: opener_tab_id.to_string(),
            tab_id: None,
            url: url.to_string(),
            requested_size: features.size.map(|s| [s.width, s.height]),
            reason: Some(reason.to_string()),
            profile: None,
        },
    );
    NewWindowResponse::Deny
}

/// wry calls this on the main thread for every page-initiated new window.
/// Policy (v3 §5.3): scheme allow-list, then a user gesture within
/// `POPUP_GESTURE_WINDOW` (the popup blocker), then `Create` — the engine
/// navigates its own webview, so `window.opener`, `Referer` and `noopener`
/// semantics are exactly what the page asked for; the host only decides how
/// to present it, and for now every popup is adopted as a tab beside its
/// opener.
fn new_window_handler(
    app: AppHandle,
    owner: WebviewWindow,
    opener_tab_id: String,
    opener_profile: String,
) -> impl Fn(String, NewWindowFeatures) -> NewWindowResponse + 'static {
    move |url, features| {
        let Some(registry) = app.try_state::<BrowserRegistry>() else {
            return NewWindowResponse::Deny;
        };
        let parsed = match Url::parse(&url) {
            Ok(u) if policy::navigation_allowed(&u) => u,
            _ => return deny(&app, &opener_tab_id, &url, &features, "blocked-scheme"),
        };
        if app
            .try_state::<BrowserPolicy>()
            .is_some_and(|policy| policy.blocked(&parsed))
        {
            return deny(&app, &opener_tab_id, &url, &features, "blocked-host");
        }
        let has_gesture = registry
            .recent_gestures(&opener_tab_id)
            .iter()
            .any(|g| g.received.elapsed() <= policy::POPUP_GESTURE_WINDOW);
        if !has_gesture {
            return deny(&app, &opener_tab_id, &url, &features, "no-gesture");
        }

        {
            // A fresh id: the counter is process-wide, but an id could still
            // be taken (the frontend names its own tabs), and inserting over
            // a live entry would drop that tab's webview from under it.
            let tab_id = loop {
                let seq = POPUP_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
                let candidate = format!("{opener_tab_id}-p{seq}");
                if !registry.contains(&candidate) && !SURFACES.with(|s| s.borrow().contains_key(&candidate)) {
                    break candidate;
                }
            };
            let label = super::tab_label(&tab_id);
            let (bounds, devtools) = registry
                .update(&opener_tab_id, |tab| (tab.last_bounds, tab.devtools))
                .unwrap_or_default();
            // macOS: the opener's configuration carries the opener's data
            // store. Windows: its environment, which the engine insists the
            // new window be created from. Either way the popup lives in the
            // opener's profile — the one its webview was built in — whatever
            // the registry says about the opener by now; the state says the
            // same so the frontend can show it.
            #[cfg(target_os = "macos")]
            let configuration = features.opener.target_configuration.clone();
            #[cfg(target_os = "windows")]
            let configuration = features.opener.environment.clone();
            let profile = opener_profile.clone();
            // Held until the popup is registered: a deletion of the profile
            // that has begun refuses it, and one that begins now waits.
            let Ok(_admission) = profile::admit(&profile) else {
                return deny(&app, &opener_tab_id, &url, &features, "profile-deleting");
            };
            let kind = ChildKind::Page;
            let webview = match build_child(&app, &owner, &tab_id, &label, bounds, true, devtools, Some(configuration), &kind, &profile) {
                Ok(webview) => webview,
                Err(err) => {
                    tracing::warn!("[browser] popup webview creation failed: {err}");
                    return deny(&app, &opener_tab_id, &url, &features, "create-failed");
                }
            };
            // The platform object the engine will load the request into.
            #[cfg(target_os = "macos")]
            let platform = objc2::rc::Retained::into_super(
                tauri_runtime_wry::wry::WebViewExtMacOS::webview(&webview),
            );
            #[cfg(target_os = "windows")]
            let platform = tauri_runtime_wry::wry::WebViewExtWindows::webview(&webview);
            attach_engine_hooks(&app, &tab_id, &kind, &webview);
            SURFACES.with(|s| s.borrow_mut().insert(tab_id.clone(), webview));
            let handle = ChildHandle {
                tab_id: tab_id.clone(),
                label,
                app: app.clone(),
            };
            // macOS: the same user-content controller as the opener in
            // practice, so this is a no-op that still reports the channel
            // kind. Windows: a webview of its own, so a full install. Either
            // way it happens before the engine loads anything.
            let (channel, channel_error) = match handle.install_adopted_channel() {
                Ok(true) => (ChannelKind::Degraded, None), // native once `hello` arrives
                Ok(false) => (ChannelKind::Legacy, None),
                Err(err) => {
                    tracing::warn!("[browser] popup {tab_id}: page channel unavailable ({err})");
                    (ChannelKind::Degraded, Some(err.to_string()))
                }
            };
            let state = BrowserTabState {
                tab_id: tab_id.clone(),
                owner_window: owner.label().to_string(),
                kind: TabKind::Page,
                surface: SurfaceKind::Child,
                channel,
                channel_error,
                url: String::new(),
                requested_url: parsed.to_string(),
                title: String::new(),
                favicon: None,
                loading: true,
                can_go_back: false,
                can_go_forward: false,
                origin: None,
                zoom: 1.0,
                error: None,
                remote_host: profile::remote_host(&profile),
                opener_tab_id: Some(opener_tab_id.clone()),
                profile: Some(profile.clone()),
                agent_grant: None,
            };
            if let Err(err) = registry.insert(BrowserTab::new(
                state.clone(),
                BrowserSurface::Child(handle),
                bounds,
                true,
                devtools,
            )) {
                tracing::warn!("[browser] popup registry insert failed: {err}");
                drop_surface(&tab_id);
                return deny(&app, &opener_tab_id, &url, &features, "registry");
            }
            // The engine navigates this webview itself; arm the failed-load
            // watcher since a never-committing load reports nothing.
            hooks::begin_load(&app, &tab_id);
            events::emit_state(&app, &state);
            events::emit_popup(
                &app,
                &BrowserPopupPayload {
                    presentation: PopupPresentation::Adopted,
                    opener_tab_id: opener_tab_id.clone(),
                    tab_id: Some(tab_id),
                    url: parsed.to_string(),
                    requested_size: features.size.map(|s| [s.width, s.height]),
                    reason: None,
                    profile: Some(profile),
                },
            );
            NewWindowResponse::Create { webview: platform }
        }
    }
}
