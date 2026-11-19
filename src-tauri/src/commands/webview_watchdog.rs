//! Watchdog and recovery for WebView2 renderer crashes/hangs on Windows (Issue #1023).
//!
//! In multi-GPU switching or virtual display environments (ToDesk, GameViewer, RDP),
//! WebView2's hardware acceleration pipeline can stall or crash with `0x8007139F`
//! (ERROR_INVALID_STATE) on script execution, leaving the UI permanently unresponsive.
//!
//! This module attaches a `ProcessFailed` event handler to every webview window,
//! enabling automatic reload on renderer crash/unresponsive.

#[cfg(all(target_os = "windows", feature = "tauri-runtime"))]
pub mod windows_impl {
    use tauri::{AppHandle, Manager, WebviewWindow};
    use tauri_plugin_notification::NotificationExt;
    use webview2_com::ProcessFailedEventHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2,
        ICoreWebView2ProcessFailedEventArgs,
        ICoreWebView2ProcessFailedEventArgs2,
        COREWEBVIEW2_PROCESS_FAILED_KIND,
        COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
        COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_REASON,
    };
    use windows::core::Interface;

    /// Attaches the ProcessFailed watchdog to a window.
    pub fn attach_watchdog(window: &WebviewWindow) {
        let label = window.label().to_string();
        let app = window.app_handle().clone();

        let _ = window.with_webview(move |platform| {
            let controller = platform.controller();
            let webview2 = match unsafe { controller.CoreWebView2() } {
                Ok(w) => w,
                Err(err) => {
                    tracing::error!("[webview2-watchdog] Failed to get CoreWebView2 for window {label}: {err}");
                    return;
                }
            };

            let mut token = 0i64;
            let window_label = label.clone();
            let app_handle = app.clone();
            let webview_clone = webview2.clone();

            unsafe {
                let handler_label = window_label.clone();
                let res = webview2.add_ProcessFailed(
                    &ProcessFailedEventHandler::create(Box::new(move |_sender, args| {
                        if let Some(args) = args {
                            handle_process_failed(&app_handle, &webview_clone, &handler_label, &args);
                        }
                        Ok(())
                    })),
                    &mut token,
                );
                if let Err(err) = res {
                    tracing::error!("[webview2-watchdog] Failed to add_ProcessFailed for window {window_label}: {err}");
                } else {
                    tracing::debug!("[webview2-watchdog] Attached ProcessFailed handler to window {window_label}");
                }
            }
        });
    }

    fn handle_process_failed(
        app: &AppHandle,
        webview2: &ICoreWebView2,
        label: &str,
        args: &ICoreWebView2ProcessFailedEventArgs,
    ) {
        let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND(0);
        let _ = unsafe { args.ProcessFailedKind(&mut kind) };

        let mut exit_code: i32 = -1;
        let mut reason_desc = String::new();

        if let Ok(args2) = args.cast::<ICoreWebView2ProcessFailedEventArgs2>() {
            let mut code: i32 = 0;
            if unsafe { args2.ExitCode(&mut code) }.is_ok() {
                exit_code = code;
            }
            let mut reason = COREWEBVIEW2_PROCESS_FAILED_REASON(0);
            if unsafe { args2.Reason(&mut reason) }.is_ok() {
                reason_desc = format!("{reason:?}");
            }
        }

        tracing::warn!(
            "[webview2-watchdog] Window {label} ProcessFailed: kind={kind:?}, exit_code={exit_code}, reason={reason_desc}"
        );

        match kind {
            COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE
            | COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED
            | COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED => {
                tracing::info!(
                    "[webview2-watchdog] Attempting automatic page reload for window {label}"
                );
                let reload_res = unsafe { webview2.Reload() };
                if let Err(e) = reload_res {
                    tracing::error!("[webview2-watchdog] Automatic reload failed for window {label}: {e}");
                } else {
                    tracing::info!("[webview2-watchdog] Successfully issued Reload for window {label}");
                }

                let _ = app
                    .notification()
                    .builder()
                    .title("Codeg - UI Recovered")
                    .body("The window renderer was unresponsive and has been automatically reloaded.")
                    .show();
            }
            COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED => {
                tracing::warn!(
                    "[webview2-watchdog] GPU process exited for window {label}. WebView2 will attempt to fallback to software rendering or restart GPU process."
                );
            }
            COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED => {
                tracing::error!(
                    "[webview2-watchdog] Browser process exited unexpectedly for window {label}."
                );
            }
            _ => {
                tracing::debug!("[webview2-watchdog] Other process failed kind: {kind:?}");
            }
        }
    }
}

#[cfg(not(all(target_os = "windows", feature = "tauri-runtime")))]
pub mod windows_impl {
    use tauri::WebviewWindow;

    pub fn attach_watchdog(_window: &WebviewWindow) {}
}

pub use windows_impl::attach_watchdog;
