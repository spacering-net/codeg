//! Wry child surfaces backed by GTK widgets. The overlay leaves the workspace
//! webview in charge of the window size; the fixed layer positions browser
//! pages above it without creating an X11 child window (also works on Wayland).

use std::sync::Arc;

use gtk::prelude::*;
use tauri::WebviewWindow;
use tauri_runtime_wry::wry::{self, WebViewExtUnix};

use super::linux;
use super::{NavigationSink, PageCloseSink};
use crate::browser::channel::{self, MessageSink};
use crate::browser::surface::{PointerFailure, PointerGesture};
use crate::browser::types::Bounds;

const OVERLAY_NAME: &str = "codeg-browser-overlay";

/// Get the browser layer of this workspace, creating it on first use. Main
/// thread only. GTK owns the layer, so destroying the owner releases it too.
pub fn container(owner: &WebviewWindow) -> Result<gtk::Fixed, String> {
    let window = owner.gtk_window().map_err(|e| e.to_string())?;
    if let Some(overlay) = window.child().filter(|w| w.widget_name() == OVERLAY_NAME) {
        return overlay
            .downcast::<gtk::Overlay>()
            .map_err(|_| "browser layer is not a GTK overlay".to_string())?
            .children()
            .into_iter()
            .find_map(|w| w.downcast::<gtk::Fixed>().ok())
            .ok_or_else(|| "browser overlay has no fixed layer".to_string());
    }
    let vbox = owner.default_vbox().map_err(|e| e.to_string())?;
    let workspace = vbox
        .children()
        .into_iter()
        .find(|w| w.is::<webkit2gtk::WebView>())
        .ok_or("workspace webview is missing from its GTK container")?;
    Ok(attach_container(window.upcast_ref(), &vbox, &workspace))
}

/// Replace the root VBox: Tauri's Linux click/touch resize handlers require
/// the workspace webview's grandparent to be the GTK window. Nesting the
/// overlay inside that VBox adds a level and makes those handlers panic.
/// Tauri still owns the same workspace webview and its WebviewWindow identity.
fn attach_container(window: &gtk::Window, vbox: &gtk::Box, workspace: &gtk::Widget) -> gtk::Fixed {
    // Taking the workspace out of its parent takes the window's keyboard focus
    // with it. It goes back once the workspace is in place again: the first
    // tab of a window opens on a click or a keystroke in the workspace, and
    // whoever made it would otherwise find the keyboard dead until a click.
    let had_focus = workspace.is_focus();
    let overlay = gtk::Overlay::new();
    overlay.set_widget_name(OVERLAY_NAME);
    let fixed = gtk::Fixed::new();
    vbox.remove(workspace);
    window.remove(vbox);
    overlay.add(workspace);
    overlay.add_overlay(&fixed);
    // The Fixed spans the window: pass empty-area input to the workspace,
    // while each browser webview's own GDK window still receives its events.
    overlay.set_overlay_pass_through(&fixed, true);
    window.add(&overlay);
    fixed.show();
    overlay.show();
    if had_focus {
        workspace.grab_focus();
    }
    fixed
}

/// Main thread, before `webview` is hidden for an overlay: if it holds the
/// window's keyboard focus, give that to the workspace webview under the
/// browser layer. Raising the window does not move it (GTK keeps one focus
/// widget per window), and hiding the widget that holds it leaves the window
/// with none at all: the overlay would hear no key until it was clicked.
pub fn release_focus(webview: &wry::WebView) {
    release_focus_of(webview.webview().upcast_ref());
}

fn release_focus_of(page: &gtk::Widget) {
    if !page.is_focus() {
        return;
    }
    let workspace = page
        .parent()
        .and_then(|layer| layer.parent())
        .and_then(|overlay| overlay.downcast::<gtk::Overlay>().ok())
        .and_then(|overlay| overlay.child());
    match workspace {
        Some(workspace) => workspace.grab_focus(),
        None => tracing::debug!("[browser] focus not handed back: no workspace under the page"),
    }
}

/// Persist both the requested size and Fixed coordinates. Wry's set_bounds
/// (0.55 through 0.57) only changes the current allocation, which GTK
/// overwrites at the next layout pass with the old position and size.
pub fn set_bounds(webview: &wry::WebView, bounds: Bounds) -> wry::Result<()> {
    let widget = webview.webview();
    let parent = widget
        .parent()
        .ok_or_else(|| gtk::glib::bool_error!("browser surface is detached"))?;
    let fixed = parent.downcast::<gtk::Fixed>().map_err(|_| {
        gtk::glib::bool_error!("browser surface is not attached to its fixed layer")
    })?;
    position_widget(&fixed, widget.upcast_ref(), bounds);
    Ok(())
}

fn position_widget(fixed: &gtk::Fixed, widget: &gtk::Widget, bounds: Bounds) {
    widget.set_size_request(bounds.width.round() as i32, bounds.height.round() as i32);
    fixed.move_(widget, bounds.x.round() as i32, bounds.y.round() as i32);
}

// The owned-window implementation already supplies Linux's native operations.
// Adapt Wry's wrapper here so the shared ChildHandle keeps the same contract.
macro_rules! native_op {
    ($name:ident -> $result:ty) => {
        pub fn $name(webview: &wry::WebView) -> $result {
            linux::$name(&webview.webview())
        }
    };
}

native_op!(webview_pointer -> usize);
native_op!(current_url -> Option<String>);
native_op!(is_loading -> bool);
native_op!(is_destroyed -> bool);
native_op!(go_back -> ());
native_op!(go_forward -> ());
native_op!(can_go_back -> bool);
native_op!(can_go_forward -> bool);
native_op!(stop_loading -> ());
native_op!(clear_find -> Result<(), String>);
native_op!(debug_view -> serde_json::Value);

pub fn forget_navigation_delegate(webview: &wry::WebView) {
    linux::forget(&webview.webview());
}

pub fn install_navigation_hooks(
    webview: &wry::WebView,
    sink: NavigationSink,
) -> Result<(), String> {
    linux::install_navigation_hooks(&webview.webview(), sink)
}

pub fn install_page_close_hook(webview: &wry::WebView, sink: PageCloseSink) -> Result<(), String> {
    linux::install_page_close_hook(&webview.webview(), sink)
}

pub fn install_world(
    webview: &wry::WebView,
    top_scripts: &[&str],
    page_scripts: &[&str],
    sink: MessageSink,
) -> Result<bool, String> {
    let native = webview.webview();
    let pointer = linux::webview_pointer(&native);
    linux::install_world(
        &native,
        top_scripts,
        &[channel::FRAME_PREFIX_SCRIPT, channel::HELPER_JS],
        page_scripts,
        Arc::new(move |raw, main_frame| sink(raw, main_frame, pointer)),
    )
}

pub fn eval_in_world(
    webview: &wry::WebView,
    expression: &str,
    callback: impl Fn(Result<String, String>) + Send + 'static,
) -> Result<(), String> {
    linux::eval_in_world(&webview.webview(), expression, callback)
}

pub fn snapshot_png(
    webview: &wry::WebView,
    callback: impl Fn(Result<Vec<u8>, String>) + Send + 'static,
) -> Result<(), String> {
    linux::snapshot_png(&webview.webview(), callback)
}

pub fn snapshot_jpeg(
    webview: &wry::WebView,
    quality: f64,
    callback: impl Fn(Result<(Vec<u8>, u32, u32), String>) + Send + 'static,
) -> Result<(), String> {
    linux::snapshot_jpeg(&webview.webview(), quality, callback)
}

pub fn find_string(
    webview: &wry::WebView,
    query: &str,
    forward: bool,
    callback: impl Fn(bool) + Send + 'static,
) -> Result<(), String> {
    linux::find_string(&webview.webview(), query, forward, callback)
}

/// Linux keeps the engine's user agent, as the owned-window surface does.
pub fn refresh_user_agent(_webview: &wry::WebView) {}

/// WebKitGTK opens a separate inspector; no embedded inspector layout to restore.
pub fn open_devtools(webview: &wry::WebView) -> bool {
    webview.open_devtools();
    false
}

pub fn devtools_visible(webview: &wry::WebView) -> bool {
    webview.is_devtools_open()
}

/// WebKitGTK has no trusted input channel; callers use the existing fallback.
pub fn dispatch_pointer(
    _webview: &wry::WebView,
    _gesture: PointerGesture,
    _done: impl FnOnce(Result<(), PointerFailure>) + Send + 'static,
) -> Result<(), String> {
    Err("this surface delivers no trusted input".into())
}

#[cfg(test)]
#[path = "linux_child_tests.rs"]
mod tests;
