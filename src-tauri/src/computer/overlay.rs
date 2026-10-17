//! Showing and hiding computer use's own windows — the strip and the action
//! mark — without ever activating them.
//!
//! Both are built `focused(false)` and `focusable(false)`, then only ever
//! shown and hidden. On Windows, tao 0.37.1 shows a window that has been
//! created with `ShowWindow(SW_SHOW)` whatever it was built with, and
//! `SW_SHOW` activates a window in spite of its `WS_EX_NOACTIVATE`
//! (tauri-apps/tao#1358, not merged yet). Through `WebviewWindow::show` the
//! strip would take the keyboard from whatever the person is typing in, and
//! the mark the foreground from the window an agent has just acted on. So on
//! Windows they are shown with `SW_SHOWNOACTIVATE` — what tao did up to 0.37.0
//! — and hidden here too: tao never learns that they are visible, so a `hide`
//! that went through it would change nothing.
//!
//! The calls go through the main thread, as tao's own do, queued behind
//! whatever placement was asked for first: a mark never shows at the spot of
//! the one before it.

use tauri::WebviewWindow;

/// Show `window` without activating it.
pub fn show(window: &WebviewWindow) {
    #[cfg(windows)]
    {
        show_window(
            window,
            windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNOACTIVATE,
        );
    }
    #[cfg(not(windows))]
    {
        let _ = window.show();
    }
}

/// Hide a window shown with [`show`].
pub fn hide(window: &WebviewWindow) {
    #[cfg(windows)]
    {
        show_window(window, windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE);
    }
    #[cfg(not(windows))]
    {
        let _ = window.hide();
    }
}

#[cfg(windows)]
fn show_window(
    window: &WebviewWindow,
    command: windows_sys::Win32::UI::WindowsAndMessaging::SHOW_WINDOW_CMD,
) {
    let target = window.clone();
    let _ = window.run_on_main_thread(move || {
        if let Ok(hwnd) = target.hwnd() {
            // SAFETY: on the main thread, which owns the window, with the
            // handle of a window that is still alive.
            unsafe {
                windows_sys::Win32::UI::WindowsAndMessaging::ShowWindow(hwnd.0, command);
            }
        }
    });
}
