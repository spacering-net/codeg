//! The mark an agent's action leaves on the screen: for a moment after a
//! click, a scroll or typing lands, a ring where it landed. Actions are
//! delivered in the background — unless the person lets a window come to the
//! front for them — where nothing else on the screen moves: the real pointer
//! stays with the person, and a person should be able to see that something
//! was done, and where.
//!
//! A codeg window of its own: transparent, above other windows, never taking
//! focus, and passing every click through to whatever is under it. It is
//! shown only once an action is done, so it never stands between an action
//! and its target — on Windows a background click aimed by coordinates is
//! refused if another window is on top at that point.
//!
//! The window is made the first time some window is shared for control, so
//! the first mark does not wait for a webview to load, and is then only ever
//! hidden — between marks, and while nothing is shared for control — never
//! closed: a window on its way to being closed could be taken for a ready
//! one by a share that came straight after.
//!
//! Where a mark goes comes from the driver's own numbers (the element's frame
//! in its snapshot, or the window's frame measured before a point in it was
//! clicked), in the platform's desktop units: points on macOS — the units a
//! window is placed in there — and physical pixels elsewhere.

use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::watch;

use super::agent::ComputerAction;

pub const MARKER_LABEL: &str = "computer-marker";

/// Told to the marker window alone: play the mark for this action.
pub const MARKER_EVENT: &str = "computer://marker";

/// The window's side, in logical pixels. The mark is drawn in its middle.
const SIDE: f64 = 96.0;

/// How long a mark stays up.
const SHOWN_FOR: Duration = Duration::from_millis(1200);

#[derive(Debug, Clone, Copy, PartialEq)]
struct Mark {
    id: u64,
    at: (f64, f64),
    action: ComputerAction,
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
struct Wanted {
    /// Some window is shared for control; marks are taken only then.
    armed: bool,
    mark: Option<Mark>,
    /// Marks asked for so far: each has its own id, so a mark at the same
    /// place as the last is still played.
    marks: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MarkerPayload {
    id: u64,
    action: ComputerAction,
}

/// See the module note.
pub struct Marker {
    wanted: watch::Sender<Wanted>,
}

impl Marker {
    /// Start the task that keeps the window in line with what is wanted of
    /// it — one task, so the window is made, moved and hidden in the order
    /// asked, and a mark asked for over one still showing replaces it.
    pub fn start(app: AppHandle) -> Marker {
        let (wanted, rx) = watch::channel(Wanted::default());
        tauri::async_runtime::spawn(follow(app, rx));
        Marker { wanted }
    }

    /// Whether some window is shared for control: the window is made ready
    /// when one is, and hidden — any mark with it — when none is.
    pub fn arm(&self, armed: bool) {
        self.wanted.send_if_modified(|w| {
            let changed = w.armed != armed;
            w.armed = armed;
            if !armed {
                w.mark = None;
            }
            changed
        });
    }

    /// Mark where an action just landed, in desktop units — unless nothing
    /// is shared for control any more (the answer came back after a Stop):
    /// such a mark would otherwise wait and play at the next share.
    pub fn mark(&self, at: (f64, f64), action: ComputerAction) {
        if !(at.0.is_finite() && at.1.is_finite()) {
            return;
        }
        self.wanted.send_if_modified(|w| {
            if !w.armed {
                return false;
            }
            w.marks += 1;
            w.mark = Some(Mark {
                id: w.marks,
                at,
                action,
            });
            true
        });
    }

    /// Take any mark down now — the person pressed Stop.
    pub fn clear(&self) {
        self.wanted.send_if_modified(|w| w.mark.take().is_some());
    }
}

async fn follow(app: AppHandle, mut rx: watch::Receiver<Wanted>) {
    let mut shown: Option<u64> = None;
    loop {
        let wanted = *rx.borrow_and_update();
        if !wanted.armed {
            if let Some(window) = app.get_webview_window(MARKER_LABEL) {
                let _ = window.hide();
            }
        } else if let Some(window) = window(&app) {
            match wanted.mark {
                Some(mark) if shown != Some(mark.id) => {
                    shown = Some(mark.id);
                    place(&app, &window, mark.at);
                    let _ = window.show();
                    let _ = app.emit_to(
                        MARKER_LABEL,
                        MARKER_EVENT,
                        MarkerPayload {
                            id: mark.id,
                            action: mark.action,
                        },
                    );
                    tokio::select! {
                        _ = tokio::time::sleep(SHOWN_FOR) => {
                            let _ = window.hide();
                        }
                        changed = rx.changed() => {
                            if changed.is_err() {
                                break;
                            }
                            continue;
                        }
                    }
                }
                Some(_) => {}
                None => {
                    let _ = window.hide();
                }
            }
        }
        if rx.changed().await.is_err() {
            break;
        }
    }
}

/// The marker window, made hidden the first time it is wanted.
fn window(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(window) = app.get_webview_window(MARKER_LABEL) {
        return Some(window);
    }
    let built =
        WebviewWindowBuilder::new(app, MARKER_LABEL, WebviewUrl::App("computer-marker".into()))
            .title("codeg")
            .inner_size(SIDE, SIDE)
            .resizable(false)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            .skip_taskbar(true)
            .focused(false)
            .focusable(false)
            .visible(false)
            .build();
    match built {
        Ok(window) => {
            // Clicks pass through to whatever is under the mark.
            let _ = window.set_ignore_cursor_events(true);
            Some(window)
        }
        Err(e) => {
            tracing::warn!("[computer] could not open the action marker: {e}");
            None
        }
    }
}

/// Put the window's middle on `at`.
fn place(app: &AppHandle, window: &WebviewWindow, at: (f64, f64)) {
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        let _ = window.set_position(tauri::LogicalPosition::new(
            at.0 - SIDE / 2.0,
            at.1 - SIDE / 2.0,
        ));
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Physical pixels: the window is as many of them wide as its logical
        // side times the scale of the monitor the point is on. Placed, sized
        // in logical pixels (a move across monitors rescales it), placed
        // again.
        let monitors = app.available_monitors().unwrap_or_default();
        let scale = scale_at(
            monitors.iter().map(|m| {
                (
                    m.position().x,
                    m.position().y,
                    m.size().width,
                    m.size().height,
                    m.scale_factor(),
                )
            }),
            at,
        );
        let origin = physical_origin(at, scale);
        let _ = window.set_position(origin);
        let _ = window.set_size(tauri::LogicalSize::new(SIDE, SIDE));
        let _ = window.set_position(origin);
    }
}

/// The scale factor of the monitor `(x, y, width, height, scale)` that holds
/// `at` (physical pixels), or 1.
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn scale_at(monitors: impl Iterator<Item = (i32, i32, u32, u32, f64)>, at: (f64, f64)) -> f64 {
    monitors
        .filter(|(x, y, w, h, _)| {
            let (x, y) = (f64::from(*x), f64::from(*y));
            at.0 >= x && at.1 >= y && at.0 < x + f64::from(*w) && at.1 < y + f64::from(*h)
        })
        .map(|(.., scale)| scale)
        .find(|scale| scale.is_finite() && *scale > 0.0)
        .unwrap_or(1.0)
}

/// Where a window `SIDE` logical pixels wide, at `scale`, goes so that its
/// middle is on `at` (physical pixels).
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn physical_origin(at: (f64, f64), scale: f64) -> tauri::PhysicalPosition<i32> {
    let half = SIDE * scale / 2.0;
    tauri::PhysicalPosition::new((at.0 - half).round() as i32, (at.1 - half).round() as i32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_mark_is_centred_on_the_monitor_it_lands_on() {
        let monitors = [(0, 0, 2560, 1440, 2.0), (2560, 0, 1920, 1080, 1.0)];
        assert_eq!(scale_at(monitors.into_iter(), (100.0, 100.0)), 2.0);
        assert_eq!(scale_at(monitors.into_iter(), (3000.0, 100.0)), 1.0);
        // Off every monitor: as at scale 1.
        assert_eq!(scale_at(monitors.into_iter(), (-50.0, 100.0)), 1.0);
        assert_eq!(
            physical_origin((1000.0, 500.0), 2.0),
            tauri::PhysicalPosition::new(904, 404)
        );
        assert_eq!(
            physical_origin((3000.5, 100.0), 1.0),
            tauri::PhysicalPosition::new(2953, 52)
        );
    }
}
