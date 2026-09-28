//! The concrete surfaces behind a tab and the operations the command layer
//! needs from all of them. Both handle types are cheap `Send + Clone` values
//! that dispatch to the main thread internally, so callers clone a surface OUT
//! of the registry and operate on it with no lock held — holding the registry
//! mutex across a main-thread round trip would deadlock the moment the main
//! thread wants the registry too.

use tauri::Url;

use super::surface_window;
use super::types::{Bounds, SurfaceKind};

#[cfg(all(
    feature = "browser-child",
    any(target_os = "macos", target_os = "windows")
))]
use super::surface_child::ChildHandle;

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct SurfaceError(pub String);

/// Why a trusted gesture did not complete, and whether any of it reached the
/// page. `delivered` is what the caller's fallback decision turns on: a
/// gesture that failed before its first event can be redone another way; one
/// that failed after a press has already happened, and redoing it would do
/// it twice. Where the platform cannot tell (a timeout, a dropped answer) it
/// says `delivered: true`, which is the safe reading.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PointerFailure {
    pub delivered: bool,
    pub error: String,
}

/// A pointer event to be delivered as *real* input — not dispatched by script
/// — at a point in viewport CSS pixels. What `BrowserSurface::dispatch_pointer`
/// takes, on the one platform that has a channel for it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PointerGesture {
    Move {
        x: f64,
        y: f64,
    },
    Click {
        x: f64,
        y: f64,
        button: super::agent::PointerButton,
        /// 1 for a click, 2 for a double click.
        count: u8,
    },
}

impl From<tauri::Error> for SurfaceError {
    fn from(err: tauri::Error) -> Self {
        SurfaceError(err.to_string())
    }
}

#[cfg(all(
    feature = "browser-child",
    any(target_os = "macos", target_os = "windows")
))]
impl From<super::surface_child::ChildError> for SurfaceError {
    fn from(err: super::surface_child::ChildError) -> Self {
        SurfaceError(err.to_string())
    }
}

#[derive(Clone)]
pub enum BrowserSurface {
    #[cfg(all(
        feature = "browser-child",
        any(target_os = "macos", target_os = "windows")
    ))]
    Child(ChildHandle),
    /// Boxed: `WebviewWindow` is ~900 bytes and the enum is cloned around.
    Window(Box<tauri::WebviewWindow>),
}

// The child arm is compiled out on Linux; the macro keeps every method to one
// match instead of three cfg-laden copies.
macro_rules! per_surface {
    ($self:ident, child: |$c:ident| $child:expr, window: |$w:ident| $window:expr) => {
        match $self {
            #[cfg(all(
                feature = "browser-child",
                any(target_os = "macos", target_os = "windows")
            ))]
            BrowserSurface::Child($c) => $child,
            BrowserSurface::Window($w) => $window,
        }
    };
}

impl BrowserSurface {
    pub fn kind(&self) -> SurfaceKind {
        per_surface!(self, child: |_c| SurfaceKind::Child, window: |_w| SurfaceKind::Window)
    }

    pub fn is_embedded(&self) -> bool {
        self.kind() != SurfaceKind::Window
    }

    /// Whether the page ↔ host channel can be installed on this surface. Not
    /// the same question as `is_embedded`: the owned window is where the shim
    /// lives on Linux, and answers like a tab.
    pub fn has_channel(&self) -> bool {
        per_surface!(self, child: |_c| true, window: |_w| surface_window::HAS_CHANNEL)
    }

    pub fn label(&self) -> &str {
        per_surface!(self, child: |c| c.label(), window: |w| w.label())
    }

    pub fn navigate(&self, url: Url) -> Result<(), SurfaceError> {
        per_surface!(self,
            child: |c| Ok(c.load_url(url.as_str())?),
            window: |w| Ok(w.navigate(url)?))
    }

    pub fn reload(&self) -> Result<(), SurfaceError> {
        per_surface!(self, child: |c| Ok(c.reload()?), window: |w| Ok(w.reload()?))
    }

    /// Dev puppet only. Owned windows are deliberately not asked: wry 0.55's
    /// `url()` unwraps `WKWebView.URL`, which is nil until a navigation has
    /// committed (or after the first one failed), and that unwrap panics the
    /// main thread. The registry state carries the URL either way.
    pub fn url(&self) -> Result<Url, SurfaceError> {
        per_surface!(self,
            child: |c| Url::parse(&c.url()?).map_err(|e| SurfaceError(e.to_string())),
            window: |w| surface_window::url(w))
    }

    pub fn eval(&self, js: &str) -> Result<(), SurfaceError> {
        per_surface!(self, child: |c| Ok(c.evaluate_script(js)?), window: |w| Ok(w.eval(js)?))
    }

    pub fn eval_with_callback(
        &self,
        js: &str,
        callback: impl Fn(String) + Send + 'static,
    ) -> Result<(), SurfaceError> {
        per_surface!(self,
            child: |c| Ok(c.evaluate_script_with_callback(js, callback)?),
            window: |w| Ok(w.eval_with_callback(js, callback)?))
    }

    /// Find in page. Only embedded surfaces have it: an owned window is a
    /// plain `WebviewWindow`, whose `WKWebView` the host does not hold.
    pub fn find(
        &self,
        query: &str,
        forward: bool,
        callback: impl Fn(bool) + Send + 'static,
    ) -> Result<(), SurfaceError> {
        per_surface!(self,
            child: |c| Ok(c.find(query, forward, callback)?),
            window: |w| surface_window::find(w, query, forward, callback))
    }

    pub fn clear_find(&self) -> Result<(), SurfaceError> {
        per_surface!(self,
            child: |c| Ok(c.clear_find()?),
            window: |w| surface_window::clear_find(w))
    }

    pub fn hide(&self) -> Result<(), SurfaceError> {
        per_surface!(self, child: |c| Ok(c.set_visible(false)?), window: |w| Ok(w.hide()?))
    }

    pub fn show(&self) -> Result<(), SurfaceError> {
        per_surface!(self,
            child: |c| Ok(c.set_visible(true)?),
            // Un-hiding alone can leave the window behind its owner; showing
            // it is a request to see it.
            window: |w| { w.show()?; w.set_focus()?; Ok(()) })
    }

    pub fn set_focus(&self) -> Result<(), SurfaceError> {
        per_surface!(self, child: |c| Ok(c.focus()?), window: |w| Ok(w.set_focus()?))
    }

    pub fn close(&self) -> Result<(), SurfaceError> {
        per_surface!(self, child: |c| Ok(c.close()?), window: |w| Ok(w.close()?))
    }

    /// Show the engine's web inspector for this page. `true` when it is up and
    /// this surface can be asked whether it still is — which is what
    /// [`Self::devtools_visible`] is polled for.
    ///
    /// Only does anything on a surface that was BUILT with the inspector
    /// available: all three engines take it as a webview attribute at creation
    /// (`developerExtrasEnabled`, `SetAreDevToolsEnabled`,
    /// `enable-developer-extras`) and none of them lets it be turned on
    /// afterwards. Neither engine reports back either, so the caller answers
    /// that question from the registry rather than from here — see
    /// `commands::browser::devtools_refusal`.
    ///
    /// Never `true` for an owned window: its host window holds the page and
    /// nothing else, so wherever the inspector goes is the ordinary browser
    /// layout, and there is nothing to put back afterwards.
    pub fn open_devtools(&self) -> Result<bool, SurfaceError> {
        per_surface!(self,
            child: |c| Ok(c.open_devtools()?),
            window: |w| { w.open_devtools(); Ok(false) })
    }

    /// Whether the inspector is still up. Only ever asked of a surface that
    /// said it had one to watch.
    pub fn devtools_visible(&self) -> Result<bool, SurfaceError> {
        per_surface!(self,
            child: |c| Ok(c.devtools_visible()?),
            window: |_w| Ok(false))
    }

    /// Only meaningful for embedded surfaces; an owned window keeps whatever
    /// size and position the user gave it.
    pub fn set_bounds(&self, bounds: Bounds) -> Result<(), SurfaceError> {
        per_surface!(self,
            child: |c| Ok(c.set_bounds(bounds)?),
            window: |_w| { let _ = bounds; Ok(()) })
    }

    pub fn install_channel(&self) -> Result<bool, SurfaceError> {
        per_surface!(self,
            child: |c| Ok(c.install_channel()?),
            window: |w| surface_window::install_channel(w))
    }

    pub fn eval_in_world(
        &self,
        expression: &str,
        callback: impl Fn(Result<String, String>) + Send + 'static,
    ) -> Result<(), SurfaceError> {
        per_surface!(self,
            child: |c| Ok(c.eval_in_world(expression, callback)?),
            window: |w| surface_window::eval_in_world(w, expression, callback))
    }

    /// Whether this surface can deliver real input events at a point — as
    /// opposed to events dispatched by script in the page. Only WebView2 has
    /// a channel for it (CDP `Input.*`). The WebKit engines take no
    /// synthesized input short of the window's own event queue, which goes to
    /// wherever the pointer happens to be on screen, not to a page point.
    pub fn supports_trusted_input(&self) -> bool {
        per_surface!(self, child: |_c| cfg!(target_os = "windows"), window: |_w| false)
    }

    /// Deliver `gesture` as real input; `done` hears whether the engine took
    /// it. Only where `supports_trusted_input` — anywhere else this is an
    /// error, not a fallback.
    pub fn dispatch_pointer(
        &self,
        gesture: PointerGesture,
        done: impl FnOnce(Result<(), PointerFailure>) + Send + 'static,
    ) -> Result<(), SurfaceError> {
        per_surface!(self,
            child: |c| Ok(c.dispatch_pointer(gesture, done)?),
            window: |_w| {
                let _ = (gesture, done);
                Err(SurfaceError("this surface delivers no trusted input".into()))
            })
    }

    pub fn snapshot_png(
        &self,
        callback: impl Fn(Result<Vec<u8>, String>) + Send + 'static,
    ) -> Result<(), SurfaceError> {
        per_surface!(self,
            child: |c| Ok(c.snapshot_png(callback)?),
            window: |w| surface_window::snapshot_png(w, callback))
    }

    /// The frame as displayed now, JPEG-encoded (for the freeze frame shown
    /// while a surface is hidden under an overlay). Embedded surfaces only.
    pub fn snapshot_jpeg(
        &self,
        quality: f64,
        callback: impl Fn(Result<(Vec<u8>, u32, u32), String>) + Send + 'static,
    ) -> Result<(), SurfaceError> {
        per_surface!(self,
            child: |c| Ok(c.snapshot_jpeg(quality, callback)?),
            window: |w| surface_window::snapshot_jpeg(w, quality, callback))
    }

    pub fn go_back(&self) -> Result<(), SurfaceError> {
        per_surface!(self,
            child: |c| Ok(c.go_back()?),
            window: |w| surface_window::go_back(w))
    }

    pub fn go_forward(&self) -> Result<(), SurfaceError> {
        per_surface!(self,
            child: |c| Ok(c.go_forward()?),
            window: |w| surface_window::go_forward(w))
    }

    /// Engine-side "still loading", used to notice failed navigations (wry
    /// reports no failure event). Owned windows: not yet.
    pub fn is_loading(&self) -> Result<bool, SurfaceError> {
        per_surface!(self,
            child: |c| Ok(c.is_loading()?),
            window: |w| surface_window::is_loading(w))
    }

    pub fn can_go_back(&self) -> Result<bool, SurfaceError> {
        per_surface!(self, child: |c| Ok(c.can_go_back()?), window: |w| surface_window::can_go_back(w))
    }

    pub fn can_go_forward(&self) -> Result<bool, SurfaceError> {
        per_surface!(self,
            child: |c| Ok(c.can_go_forward()?),
            window: |w| surface_window::can_go_forward(w))
    }

    pub fn stop(&self) -> Result<(), SurfaceError> {
        per_surface!(self,
            child: |c| Ok(c.stop()?),
            window: |w| surface_window::stop(w))
    }

    /// Dev puppet only.
    pub fn debug_view(&self) -> Result<serde_json::Value, SurfaceError> {
        per_surface!(self,
            child: |c| Ok(c.debug_view()?),
            window: |w| surface_window::debug_view(w))
    }

    pub fn set_zoom(&self, factor: f64) -> Result<(), SurfaceError> {
        per_surface!(self, child: |c| Ok(c.zoom(factor)?), window: |w| Ok(w.set_zoom(factor)?))
    }

    /// Wipe cookies, caches and storage. Every tab shares one data store, so
    /// clearing through any surface clears them all.
    pub fn clear_browsing_data(&self) -> Result<(), SurfaceError> {
        per_surface!(self,
            child: |c| Ok(c.clear_all_browsing_data()?),
            window: |w| Ok(w.clear_all_browsing_data()?))
    }

    /// Re-decide the identity the surface presents for the page it shows
    /// (the sign-in preference changed). Owned windows have no per-navigation
    /// identity and keep the engine's own.
    pub fn refresh_user_agent(&self) -> Result<(), SurfaceError> {
        per_surface!(self,
            child: |c| Ok(c.refresh_user_agent()?),
            window: |w| surface_window::refresh_user_agent(w))
    }
}
