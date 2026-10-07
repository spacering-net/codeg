//! The macOS application menu: Tauri's default one, except that ⌘W is not
//! "Close Window".
//!
//! A key equivalent reaches the menu whenever the view holding keyboard focus
//! did not claim the keystroke. The workspace claims ⌘W itself — its keydown
//! listener closes the current tab and cancels the event — but only for
//! keystrokes its own document receives. One pressed inside an iframe (an
//! inline HTML preview) goes to that frame's document, and one pressed inside
//! a built-in browser page or an HTML document view goes to another webview
//! altogether. The workspace never saw those, WebKit handed them on, and the
//! predefined item closed the whole window where a tab was meant to go.
//!
//! So ⌘W is an item of our own. Over a workspace window it leaves the decision
//! to that window ([`CLOSE_SHORTCUT_EVENT`]), naming the browser surface that
//! had keyboard focus if one did — only the native side can tell which of its
//! views that was. Over any other window (settings, a commit window, an owned
//! browser window, an inspector) it does what the predefined item did.
//!
//! "Close Window" stays in the Window menu without a shortcut. ⇧⌘W, where
//! tabbed apps usually put it, is the workspace's own "close all file tabs",
//! and a menu item there would close the window the same way whenever that
//! shortcut did not apply.
//!
//! Windows and Linux have no application menu, so nothing there turns an
//! unclaimed Ctrl+W into closing the window.

use std::ffi::c_void;

use objc2::rc::Retained;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSApplication, NSWindow};
use serde::Serialize;
use tauri::menu::{
    AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID,
};
use tauri::{AppHandle, Emitter, Manager, Wry};

/// The File menu's "Close", bound to ⌘W.
const CLOSE_ID: &str = "app-menu:close";
/// The Window menu's "Close Window", without a shortcut.
const CLOSE_WINDOW_ID: &str = "app-menu:close-window";

/// Sent to a workspace window when ⌘W reached the menu while it was the key
/// window. Mirrored by `CLOSE_SHORTCUT_EVENT` in `src/lib/menu-close-shortcut.ts`.
pub const CLOSE_SHORTCUT_EVENT: &str = "app://close-shortcut";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloseShortcutPayload {
    /// The workspace window the shortcut was pressed in. The frontend
    /// subscribes with `EventTarget::Any`, so every webview hears the event
    /// whatever it is addressed to; this is what the listener checks.
    window: String,
    /// The built-in browser surface (a browser tab's page, or a document view)
    /// that had keyboard focus, by its backend tab id.
    surface_tab_id: Option<String>,
}

/// Tauri's default macOS menu (`tauri::menu::Menu::default`), item for item,
/// except for the two close items.
pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let pkg_info = app.package_info();
    let config = app.config();
    let about_metadata = AboutMetadata {
        name: Some(pkg_info.name.clone()),
        version: Some(pkg_info.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config.bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };
    let close = MenuItem::with_id(app, CLOSE_ID, "Close", true, Some("CmdOrCtrl+W"))?;
    let close_window = MenuItem::with_id(app, CLOSE_WINDOW_ID, "Close Window", true, None::<&str>)?;
    Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                pkg_info.name.clone(),
                true,
                &[
                    &PredefinedMenuItem::about(app, None, Some(about_metadata))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?,
            &Submenu::with_items(app, "File", true, &[&close])?,
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "View",
                true,
                &[&PredefinedMenuItem::fullscreen(app, None)?],
            )?,
            &Submenu::with_id_and_items(
                app,
                WINDOW_SUBMENU_ID,
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(app, None)?,
                    &PredefinedMenuItem::maximize(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &close_window,
                ],
            )?,
            &Submenu::with_id_and_items(app, HELP_SUBMENU_ID, "Help", true, &[])?,
        ],
    )
}

/// Act on one of this menu's items; `false` for any other id. Menu events
/// are delivered on the main thread.
pub fn handle_event(app: &AppHandle, id: &str) -> bool {
    match id {
        CLOSE_ID => close_shortcut(app),
        CLOSE_WINDOW_ID => {
            if let Some(window) = key_window() {
                window.performClose(None);
            }
        }
        _ => return false,
    }
    true
}

fn key_window() -> Option<Retained<NSWindow>> {
    NSApplication::sharedApplication(MainThreadMarker::new()?).keyWindow()
}

fn close_shortcut(app: &AppHandle) {
    let Some(key) = key_window() else {
        return;
    };
    let key_ptr = Retained::as_ptr(&key) as *mut c_void;
    let workspace = app.webview_windows().into_values().find(|window| {
        is_workspace_window(window.label()) && window.ns_window().is_ok_and(|ptr| ptr == key_ptr)
    });
    let Some(window) = workspace else {
        // Not a workspace: what the predefined "Close Window" did. Also the
        // path for windows tauri does not know about, such as an inspector.
        key.performClose(None);
        return;
    };
    let payload = CloseShortcutPayload {
        window: window.label().to_string(),
        surface_tab_id: focused_surface(&key),
    };
    if let Err(err) = window.emit_to(window.label(), CLOSE_SHORTCUT_EVENT, payload) {
        tracing::warn!("[menu] ⌘W could not reach {}: {err}", window.label());
    }
}

/// `main`, and the `remote-workspace-*` windows that load the same workspace.
fn is_workspace_window(label: &str) -> bool {
    label == "main" || label.starts_with("remote-workspace-")
}

#[cfg(feature = "browser-child")]
fn focused_surface(window: &NSWindow) -> Option<String> {
    crate::browser::surface_child::tab_with_keyboard_focus(window)
}

#[cfg(not(feature = "browser-child"))]
fn focused_surface(_window: &NSWindow) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_windows_are_main_and_remote_workspaces() {
        assert!(is_workspace_window("main"));
        assert!(is_workspace_window("remote-workspace-3"));
        assert!(!is_workspace_window("settings"));
        assert!(!is_workspace_window("remote-settings-3"));
        assert!(!is_workspace_window("commit-1"));
        assert!(!is_workspace_window("pet"));
    }
}
