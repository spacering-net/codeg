//! Linux shim on top of WebKitGTK (`webkit2gtk` + `gtk`).
//!
//! The helper script and the primitive it posts through live in a WebKitGTK
//! **script world** named `codeg`: `UserScript::for_world` injects the helper
//! there and `register_script_message_handler_in_world` puts
//! `window.webkit.messageHandlers.codegBrowser` in the same world — a separate
//! JavaScript global over the same DOM, invisible to page scripts and immune to
//! their prototype tampering, exactly like macOS's `WKContentWorld`. The send
//! primitive is spelled the same way it is on macOS, so both platforms share
//! one prefix script.
//!
//! Where this differs from the other two is **how a message is known to be the
//! page's own**. `script-message-received` reports a value and nothing about
//! the frame that sent it — no `WKFrameInfo`, no execution context — so there
//! is no frame to check a message against. What stands in for that check is
//! WHICH HANDLER it arrived on: the helper is injected twice, once into the top
//! frame with a primitive that posts through `codegBrowser`, and once into every
//! frame with one that posts through `codegBrowserFrame` — that second one
//! leaves the top frame's alone, by asking whether it is the top frame rather
//! than by running in a particular order. Messages
//! on the second handler are reported as not-the-main-frame, which is the same
//! answer macOS gets from `WKFrameInfo`, so `channel.rs` gates them identically:
//! `hello` and `nav-state` are refused, gestures and shortcuts are not (a
//! keystroke goes only to the frame that has focus, and a click inside an iframe
//! never reaches the top document — gating those would make ⌘F dead in an
//! iframe and deny every popup an embedded page asks for).
//!
//! Neither handler is reachable from page script: both live in the `codeg`
//! world, which the page cannot enter.
//!
//! Everything else a tab needs and neither tauri nor wry expose is a
//! `webkit2gtk` call from here: history, stop, snapshots, find in page, and
//! typed navigation failures (wry forwards `load-changed` as "page load
//! started / finished" and does not connect `load-failed` at all, so without
//! this a tab would report a perfectly successful load of a page that never
//! arrived).
//!
//! One thing deliberately absent: the sign-in identity. It is per navigation
//! and per MAIN frame, and WebKitGTK's user agent is a property of the whole
//! webview while its navigation decision does not say which frame is asking —
//! so any iframe, including one a hostile page adds on purpose, could put the
//! borrowed identity on the top-level page's own requests, or take it off
//! again in the middle of a sign-in. `sign_in_user_agent_supported()` says no
//! here for that reason.
//!
//! Every function runs on the GTK main thread against the live webview. The
//! per-webview state lives in a thread-local keyed by the `WebKitWebView`
//! pointer and is dropped by `forget` when the surface goes; signal handlers
//! capture that key rather than the state itself, so nothing here can keep a
//! webview alive past its tab.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;

use gtk::gdk;
use gtk::prelude::*;
use javascriptcore::ValueExt;
use serde_json::{json, Value};
use webkit2gtk::{
    DownloadExt, FindController, FindControllerExt, FindOptions, LoadEvent, SnapshotOptions,
    SnapshotRegion, URIRequestExt, UserContentInjectedFrames, UserContentManagerExt, UserScript,
    UserScriptInjectionTime, WebContext, WebContextExt, WebView, WebViewExt,
};

use super::super::hooks::LoadFailure;
use super::super::types::BrowserErrorKind;
pub use super::{NavigationEvent, NavigationSink, PageCloseSink};

/// Name of the script world the helper and its message handler live in.
pub const WORLD_NAME: &str = "codeg";
/// The message handler the TOP frame's helper posts through — the same name
/// macOS registers, so `channel::PREFIX_SCRIPT` is the send primitive on both.
pub const HANDLER_NAME: &str = "codegBrowser";
/// The one every other frame posts through. What arrives here is reported as
/// not the main frame.
pub const FRAME_HANDLER_NAME: &str = "codegBrowserFrame";

/// A channel message and whether it came from the page's own frame. Unlike the
/// other platforms this sink is already bound to one tab: a Linux surface owns
/// its user-content manager alone (nothing here is shared with an opener the
/// way a macOS popup shares its controller), so there is no webview to resolve.
pub type MessageSink = Arc<dyn Fn(String, bool) + Send + Sync>;

type DownloadStart = dyn Fn(&str, &mut PathBuf) -> bool + Send + Sync;
/// The address, the destination the transfer was given, and whether it got
/// there: the destination tells two transfers of one address apart.
type DownloadFinish = dyn Fn(&str, &Path, bool) + Send + Sync;

/// Source-specific callbacks retained for each in-flight download.
#[derive(Clone)]
pub struct DownloadHandlers {
    pub started: Arc<DownloadStart>,
    pub finished: Arc<DownloadFinish>,
}

/// Whoever asked for the search in flight, waiting to be told what came of it.
type FindAnswer = Box<dyn Fn(bool)>;

#[derive(Default)]
struct SurfaceState {
    destroyed: Cell<bool>,
    downloads: RefCell<Option<DownloadHandlers>>,
    channel_installed: Cell<bool>,
    /// What `find_string` searched for last: the same term again is "next
    /// match", a different one starts a new search.
    find_term: RefCell<Option<String>>,
    /// Who is waiting for the result of the search in flight. WebKitGTK
    /// answers a search on the controller's signals rather than to the caller.
    find_waiting: RefCell<Option<FindAnswer>>,
    find_connected: Cell<bool>,
    navigation: RefCell<Option<NavigationSink>>,
    /// Where native destruction goes; `None` until the hook is installed.
    page_close: RefCell<Option<PageCloseSink>>,
}

thread_local! {
    /// State by `WebKitWebView` pointer. Main thread only.
    static STATES: RefCell<HashMap<usize, Rc<SurfaceState>>> = RefCell::new(HashMap::new());
}

/// The state of a webview, cloned out so no borrow of the map is held while a
/// sink runs — a sink reaches the registry, which reaches back in here.
fn state(key: usize) -> Option<Rc<SurfaceState>> {
    STATES.with(|states| states.borrow().get(&key).cloned())
}

fn state_of(key: usize) -> Rc<SurfaceState> {
    STATES.with(|states| states.borrow_mut().entry(key).or_default().clone())
}

/// Identity of the platform webview, and the key its state is kept under.
pub fn webview_pointer(webview: &WebView) -> usize {
    webview.as_ptr() as usize
}

/// Drop everything held for a surface that is going away.
pub fn forget(webview: &WebView) {
    STATES.with(|states| states.borrow_mut().remove(&webview_pointer(webview)));
}

/// The native widget can die before the deferred registry cleanup runs.
pub fn is_destroyed(webview: &WebView) -> bool {
    state(webview_pointer(webview)).is_some_and(|s| s.destroyed.get())
}

pub fn install_download_handlers(webview: &WebView, handlers: DownloadHandlers) {
    *state_of(webview_pointer(webview)).downloads.borrow_mut() = Some(handlers);
}

/// Install once when a profile context is created. Wry's per-view listeners
/// would all observe every transfer in this context and attribute it to the
/// first tab. Resolve the actual native source before installing handlers.
pub fn install_download_context(context: &WebContext) {
    context.connect_download_started(|_, download| {
        let handlers = download
            .web_view()
            .and_then(|view| state(webview_pointer(&view)))
            .and_then(|state| state.downloads.borrow().clone());
        let Some(handlers) = handlers else {
            download.cancel();
            return;
        };
        let Some(url) = download.request().and_then(|request| request.uri()) else {
            download.cancel();
            return;
        };
        // Where an accepted transfer was told to write; `None` for a refused
        // one, which has no registry entry to finish.
        let accepted: Rc<RefCell<Option<PathBuf>>> = Rc::new(RefCell::new(None));
        let failed = Rc::new(Cell::new(false));
        let started = accepted.clone();
        let started_url = url.clone();
        download.connect_decide_destination(move |download, suggested| {
            let mut path = PathBuf::from(suggested);
            if !(handlers.started)(&started_url, &mut path) {
                download.cancel();
                return true;
            }
            // Recorded first: the registry entry exists from here on, and a
            // cancel below emits `failed`, which reports it as unsuccessful.
            *started.borrow_mut() = Some(path.clone());
            match tauri::Url::from_file_path(&path) {
                Ok(uri) => download.set_destination(uri.as_str()),
                Err(()) => download.cancel(),
            }
            true
        });
        let error_state = failed.clone();
        download.connect_failed(move |_, _| error_state.set(true));
        download.connect_finished(move |_| {
            let destination = accepted.borrow_mut().take();
            if let Some(destination) = destination {
                (handlers.finished)(&url, &destination, !failed.get());
            }
        });
    });
}

// ---------------------------------------------------------------------------
// History, stop, load state
// ---------------------------------------------------------------------------

pub fn go_back(webview: &WebView) {
    webview.go_back();
}

pub fn go_forward(webview: &WebView) {
    webview.go_forward();
}

pub fn can_go_back(webview: &WebView) -> bool {
    webview.can_go_back()
}

pub fn can_go_forward(webview: &WebView) -> bool {
    webview.can_go_forward()
}

pub fn stop_loading(webview: &WebView) {
    webview.stop_loading();
}

pub fn is_loading(webview: &WebView) -> bool {
    webview.is_loading()
}

/// The address the webview is on — the provisional one while a navigation is
/// in flight, which is what makes the address bar follow the page.
pub fn current_url(webview: &WebView) -> Option<String> {
    webview
        .uri()
        .map(|uri| uri.to_string())
        .filter(|uri| !uri.is_empty())
}

/// Diagnostic view of the native state (dev puppet only).
pub fn debug_view(webview: &WebView) -> Value {
    let state = state(webview_pointer(webview));
    json!({
        "isLoading": webview.is_loading(),
        "hasUrl": current_url(webview).is_some(),
        "source": current_url(webview),
        "title": webview.title().map(|t| t.to_string()),
        "visible": webview.is_visible(),
        "channelInstalled": state.as_ref().is_some_and(|s| s.channel_installed.get()),
        "estimatedProgress": webview.estimated_load_progress(),
    })
}

// ---------------------------------------------------------------------------
// The page ↔ host channel
// ---------------------------------------------------------------------------

/// Install the helper in the `codeg` world and the handler it posts through.
/// `Ok(true)` — there is no page-world fallback on Linux, a failure is reported
/// as one. Idempotent per webview.
///
/// The scripts go in AFTER the handler is registered: a user script registered
/// here runs at the start of every document from now on, and the first of them
/// must not find its message handler missing.
pub fn install_world(
    webview: &WebView,
    top_scripts: &[&str],
    frame_scripts: &[&str],
    page_scripts: &[&str],
    sink: MessageSink,
) -> Result<bool, String> {
    let key = webview_pointer(webview);
    let state = state_of(key);
    if state.channel_installed.get() {
        return Ok(true);
    }
    let manager = webview
        .user_content_manager()
        .ok_or("this webview has no user content manager")?;
    for (name, main_frame) in [(HANDLER_NAME, true), (FRAME_HANDLER_NAME, false)] {
        if !manager.register_script_message_handler_in_world(name, WORLD_NAME) {
            return Err(format!("the engine refused the {name} message handler"));
        }
        let sink = sink.clone();
        manager.connect_script_message_received(Some(name), move |_, result| {
            let Some(value) = result.js_value() else {
                return;
            };
            // The helper posts strings. Anything else is not it.
            if !value.is_string() {
                return;
            }
            // Which frame spoke is the handler it arrived on: see the module
            // header. Nothing about the message itself is trusted for this.
            sink(value.to_str().to_string(), main_frame);
        });
    }
    for (scripts, frames) in [
        (top_scripts, UserContentInjectedFrames::TopFrame),
        (frame_scripts, UserContentInjectedFrames::AllFrames),
    ] {
        for source in scripts {
            manager.add_script(&UserScript::for_world(
                source,
                frames,
                UserScriptInjectionTime::Start,
                WORLD_NAME,
                &[],
                &[],
            ));
        }
    }
    // The page's own world, every frame: only the console shim goes this way.
    for source in page_scripts {
        manager.add_script(&UserScript::new(
            source,
            UserContentInjectedFrames::AllFrames,
            UserScriptInjectionTime::Start,
            &[],
            &[],
        ));
    }
    state.channel_installed.set(true);
    Ok(true)
}

/// Evaluate `expression` in the `codeg` world of the main frame. The result
/// arrives as the JSON string `{"ok":true,"value":…}` or
/// `{"ok":false,"error":…}` — the same envelope the other platforms produce,
/// built inside the page so no platform value conversion is needed.
pub fn eval_in_world(
    webview: &WebView,
    expression: &str,
    callback: impl Fn(Result<String, String>) + Send + 'static,
) -> Result<(), String> {
    if !state(webview_pointer(webview)).is_some_and(|s| s.channel_installed.get()) {
        return Err("the page has no isolated world yet".into());
    }
    let wrapped = format!(
        "(function(){{try{{return JSON.stringify({{ok:true,value:(function(){{return ({expression});}})()}})}}catch(e){{return JSON.stringify({{ok:false,error:String(e&&e.stack||e)}})}}}})()"
    );
    // Deprecated in favour of `evaluate_javascript`, which needs WebKitGTK
    // 2.40. This one has been there since 2.22 and does the same thing, and the
    // version a distribution has to ship should not move for a rename.
    #[allow(deprecated)]
    webview.run_javascript_in_world(
        &wrapped,
        WORLD_NAME,
        None::<&gtk::gio::Cancellable>,
        move |result| {
            callback(result.map_err(|e| e.to_string()).and_then(|result| {
                result
                    .js_value()
                    .filter(ValueExt::is_string)
                    .map(|value| value.to_str().to_string())
                    .ok_or_else(|| "non-string result".to_string())
            }));
        },
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

/// Viewport snapshot as PNG bytes.
pub fn snapshot_png(
    webview: &WebView,
    callback: impl Fn(Result<Vec<u8>, String>) + Send + 'static,
) -> Result<(), String> {
    capture(webview, move |pixbuf| {
        encode(&pixbuf, "png", &[]).map(|bytes| bytes.0)
    }, callback)
}

/// The frame as displayed now, JPEG-encoded, for the freeze frame.
pub fn snapshot_jpeg(
    webview: &WebView,
    quality: f64,
    callback: impl Fn(Result<(Vec<u8>, u32, u32), String>) + Send + 'static,
) -> Result<(), String> {
    let quality = quality.clamp(0.0, 1.0) * 100.0;
    let quality = format!("{}", quality.round() as u32);
    capture(
        webview,
        move |pixbuf| encode(&pixbuf, "jpeg", &[("quality", quality.as_str())]),
        callback,
    )
}

/// Take the viewport snapshot and hand the pixels to `encode` off the signal.
fn capture<T: Send + 'static>(
    webview: &WebView,
    encode: impl Fn(gdk::gdk_pixbuf::Pixbuf) -> Result<T, String> + Send + 'static,
    callback: impl Fn(Result<T, String>) + Send + 'static,
) -> Result<(), String> {
    webview.snapshot(
        SnapshotRegion::Visible,
        SnapshotOptions::NONE,
        None::<&gtk::gio::Cancellable>,
        move |surface| {
            callback(
                surface
                    .map_err(|e| format!("the engine could not draw the page: {e}"))
                    .and_then(|surface| {
                        // The surface is the size the engine drew; asking it
                        // rather than the widget keeps a scaled display honest.
                        let width = surface_size(&surface)?;
                        gdk::pixbuf_get_from_surface(&surface, 0, 0, width.0, width.1)
                            .ok_or_else(|| "the snapshot had no pixels".to_string())
                    })
                    .and_then(&encode),
            );
        },
    );
    Ok(())
}

/// The pixel size of a cairo surface the engine drew into.
fn surface_size(surface: &gtk::cairo::Surface) -> Result<(i32, i32), String> {
    let image = gtk::cairo::ImageSurface::try_from(surface.clone())
        .map_err(|_| "the snapshot is not an image surface".to_string())?;
    Ok((image.width(), image.height()))
}

/// Encode a pixel buffer, and report what it ended up being.
fn encode(
    pixbuf: &gdk::gdk_pixbuf::Pixbuf,
    format: &str,
    options: &[(&str, &str)],
) -> Result<(Vec<u8>, u32, u32), String> {
    let bytes = pixbuf
        .save_to_bufferv(format, options)
        .map_err(|e| format!("cannot encode the snapshot as {format}: {e}"))?;
    Ok((bytes, pixbuf.width() as u32, pixbuf.height() as u32))
}

// ---------------------------------------------------------------------------
// Find in page
// ---------------------------------------------------------------------------

/// Search for `query`, or step to the next match when it is the term the last
/// search used. `callback` is told whether anything was found.
pub fn find_string(
    webview: &WebView,
    query: &str,
    forward: bool,
    callback: impl Fn(bool) + Send + 'static,
) -> Result<(), String> {
    let key = webview_pointer(webview);
    let state = state_of(key);
    let controller = webview
        .find_controller()
        .ok_or("this webview has no find controller")?;
    connect_find(&controller, key, &state);
    *state.find_waiting.borrow_mut() = Some(Box::new(callback));
    let same = state.find_term.borrow().as_deref() == Some(query);
    if same {
        if forward {
            controller.search_next();
        } else {
            controller.search_previous();
        }
        return Ok(());
    }
    *state.find_term.borrow_mut() = Some(query.to_string());
    let mut options = FindOptions::CASE_INSENSITIVE | FindOptions::WRAP_AROUND;
    if !forward {
        options |= FindOptions::BACKWARDS;
    }
    // No cap: the engine counts what it finds, and a limit here would make
    // "no more matches" mean two different things.
    controller.search(query, options.bits(), u32::MAX);
    Ok(())
}

pub fn clear_find(webview: &WebView) -> Result<(), String> {
    let key = webview_pointer(webview);
    if let Some(state) = state(key) {
        *state.find_term.borrow_mut() = None;
        let _ = state.find_waiting.borrow_mut().take();
    }
    if let Some(controller) = webview.find_controller() {
        controller.search_finish();
    }
    Ok(())
}

/// Route the controller's two answers to whoever asked. Connected once per
/// webview: the signals are the controller's, not one search's.
fn connect_find(controller: &FindController, key: usize, state: &SurfaceState) {
    if state.find_connected.replace(true) {
        return;
    }
    controller.connect_found_text(move |_, _matches| answer_find(key, true));
    controller.connect_failed_to_find_text(move |_| answer_find(key, false));
}

fn answer_find(key: usize, found: bool) {
    let waiting = state(key).and_then(|state| state.find_waiting.borrow_mut().take());
    if let Some(waiting) = waiting {
        waiting(found);
    }
}

// ---------------------------------------------------------------------------
// Navigation hooks: what wry does not report
// ---------------------------------------------------------------------------

/// Install the navigation hooks. wry forwards `load-changed` as "page load
/// started / finished" and never connects `load-failed`, so a tab is told
/// nothing about a load that ended without a page — and WebKitGTK, left to
/// itself, replaces the document with its own error page and says nothing.
/// Idempotent per webview.
pub fn install_navigation_hooks(
    webview: &WebView,
    navigation: NavigationSink,
) -> Result<(), String> {
    let key = webview_pointer(webview);
    let state = state_of(key);
    if state.navigation.borrow().is_some() {
        return Ok(());
    }
    *state.navigation.borrow_mut() = Some(navigation);

    webview.connect_load_changed(move |webview, event| {
        let Some(uri) = current_url(webview) else {
            return;
        };
        match event {
            LoadEvent::Started => report(key, NavigationEvent::Started(uri)),
            LoadEvent::Redirected => report(key, NavigationEvent::Redirected(uri)),
            // Committed and finished are wry's to report, and it does.
            _ => {}
        }
    });
    webview.connect_load_failed(move |_webview, event, uri, error| {
        match classify(error) {
            Some(kind) => {
                tracing::debug!("[browser] navigation failed: {error} -> {kind:?}");
                report(
                    key,
                    NavigationEvent::Failed(LoadFailure {
                        kind,
                        message: error.message().to_string(),
                        url: Some(uri.to_string()),
                        // WebKitGTK reports which load event the failure ended.
                        // Committed means the document IS in place and broke
                        // afterwards — a dropped connection mid-body — which
                        // must stop the spinner, not replace the page the user
                        // is reading with an error.
                        provisional: matches!(
                            event,
                            LoadEvent::Started | LoadEvent::Redirected
                        ),
                    }),
                );
            }
            // Stopped by the user or refused by the host's own handler: not a
            // failure of the page, and an error page over a load the user
            // stopped on purpose would be the engine contradicting the user.
            None => {
                tracing::debug!("[browser] navigation ended without a page ({error})");
                report(key, NavigationEvent::Interrupted);
            }
        }
        // `false`: the engine puts its own error page up, which is what an
        // owned window should show. An embedded tab's view is hidden while
        // the tab has an error, and the pane shows codeg's own page instead.
        false
    });
    webview.connect_load_failed_with_tls_errors(move |_webview, uri, _certificate, flags| {
        tracing::debug!("[browser] navigation failed on the certificate: {flags:?}");
        report(
            key,
            NavigationEvent::Failed(LoadFailure {
                kind: BrowserErrorKind::Tls,
                message: String::new(),
                url: Some(uri.to_string()),
                provisional: true,
            }),
        );
        false
    });
    Ok(())
}

fn report(key: usize, event: NavigationEvent) {
    let sink = state(key).and_then(|s| s.navigation.borrow().clone());
    if let Some(sink) = sink {
        sink(event);
    }
}

/// Observe native destruction, not `close`: wry's earlier close handler
/// destroys the widget and disconnects later close handlers. Destruction
/// still runs during that disposal, allowing the host to retire the surface.
pub fn install_page_close_hook(webview: &WebView, sink: PageCloseSink) -> Result<(), String> {
    let key = webview_pointer(webview);
    let current = state_of(key);
    if current.page_close.borrow().is_some() {
        return Ok(());
    }
    *current.page_close.borrow_mut() = Some(sink);
    webview.connect_destroy(move |_| {
        if let Some(state) = state(key) {
            state.destroyed.set(true);
            report_page_close(key);
        }
    });
    Ok(())
}

/// Told out of the map rather than from a captured handle, like [`report`]:
/// a signal handler lives as long as the webview, and nothing here may keep
/// that webview alive past its tab.
fn report_page_close(key: usize) {
    let sink = state(key).and_then(|s| s.page_close.borrow().clone());
    if let Some(sink) = sink {
        sink();
    }
}

/// Classify a WebKitGTK load error. `None` means "not a failure of the page":
/// a cancelled navigation covers a load the user stopped, one superseded by
/// another, and one our own policy handler refused.
fn classify(error: &gtk::glib::Error) -> Option<BrowserErrorKind> {
    use webkit2gtk::NetworkError;
    if error.matches(NetworkError::Cancelled) {
        return None;
    }
    // A name that does not resolve reaches here as the resolver's own error
    // when the engine passes it through; when it does not, it is an ordinary
    // transport failure and is reported as one.
    if error.matches(gtk::gio::ResolverError::NotFound) {
        return Some(BrowserErrorKind::Dns);
    }
    if error.matches(gtk::gio::TlsError::BadCertificate) {
        return Some(BrowserErrorKind::Tls);
    }
    Some(BrowserErrorKind::Failed)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The engine's errors, by kind — and the one that is NOT a page failure.
    /// A load the user stopped must not paint an error over the page they
    /// stopped it on.
    #[test]
    fn load_errors_classify_by_engine_error() {
        use webkit2gtk::NetworkError;
        assert_eq!(
            classify(&gtk::glib::Error::new(NetworkError::Cancelled, "stopped")),
            None
        );
        assert_eq!(
            classify(&gtk::glib::Error::new(
                NetworkError::Transport,
                "connection reset"
            )),
            Some(BrowserErrorKind::Failed)
        );
        assert_eq!(
            classify(&gtk::glib::Error::new(
                NetworkError::Failed,
                "something else"
            )),
            Some(BrowserErrorKind::Failed)
        );
        assert_eq!(
            classify(&gtk::glib::Error::new(
                gtk::gio::ResolverError::NotFound,
                "no such host"
            )),
            Some(BrowserErrorKind::Dns)
        );
    }
}
