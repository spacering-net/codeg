//! The strip that says, above every other window, that agents may use this
//! screen: up while any window is shared, naming what they may do and where,
//! with a Stop button on it. Actions happen in the background, in windows
//! the person may not be looking at (at the front only for a moment, where
//! they allow it), and the codeg window with the rest of
//! the panel may be hidden; this is the part of computer use that is never
//! out of sight.
//!
//! A codeg window of its own — agents can never act on it — at the top of the
//! main screen, above other windows and on every Space, never taking focus
//! (a click on Stop works without it), and draggable out of the way. Made the
//! first time something is shared, then hidden rather than closed, so it
//! stays where the person put it. It goes the moment nothing is shared — a
//! Stop included, which ends every sharing — and stays down, shared or not,
//! while the person has turned it off in Settings; Stop is still in the
//! status-bar popover then, and on the stop shortcut.
//!
//! What it says is the page's business (`computer://state`,
//! `computer://agent-activity`); when it is up is decided here, from the
//! same state.

use tauri::{
    AppHandle, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use tokio::sync::watch;

pub const INDICATOR_LABEL: &str = "computer-indicator";

/// The first size, in logical pixels, until the page has measured itself.
const WIDTH: f64 = 360.0;
const HEIGHT: f64 = 44.0;
/// How far below the top of the main screen's work area it starts.
const TOP: f64 = 10.0;

/// What the strip should be doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Strip {
    Hidden,
    /// Something is shared.
    Shown,
}

impl Strip {
    /// `shared`: anything is shared; `wanted`: the person has not turned the
    /// strip off.
    pub fn of(shared: bool, wanted: bool) -> Strip {
        if shared && wanted {
            Strip::Shown
        } else {
            Strip::Hidden
        }
    }
}

/// See the module note.
pub struct Indicator {
    wanted: watch::Sender<Strip>,
}

impl Indicator {
    /// Start the task that keeps the window in line with what is wanted of
    /// it — one task, so it is made, shown and hidden in the order asked.
    pub fn start(app: AppHandle) -> Indicator {
        let (wanted, rx) = watch::channel(Strip::Hidden);
        tauri::async_runtime::spawn(follow(app, rx));
        Indicator { wanted }
    }

    pub fn set(&self, strip: Strip) {
        self.wanted.send_if_modified(|w| {
            let changed = *w != strip;
            *w = strip;
            changed
        });
    }
}

async fn follow(app: AppHandle, mut rx: watch::Receiver<Strip>) {
    loop {
        let wanted = *rx.borrow_and_update();
        match wanted {
            Strip::Shown => {
                if let Some(window) = window(&app) {
                    let _ = window.show();
                }
            }
            Strip::Hidden => {
                if let Some(window) = app.get_webview_window(INDICATOR_LABEL) {
                    let _ = window.hide();
                }
            }
        }
        if rx.changed().await.is_err() {
            break;
        }
    }
}

/// The strip's window, made (hidden, at the top of the main screen) the
/// first time it is wanted.
fn window(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(window) = app.get_webview_window(INDICATOR_LABEL) {
        return Some(window);
    }
    let built = WebviewWindowBuilder::new(
        app,
        INDICATOR_LABEL,
        WebviewUrl::App("computer-indicator".into()),
    )
    .title("codeg")
    .inner_size(WIDTH, HEIGHT)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .focused(false)
    .focusable(false)
    // Stop answers the first click, focus or not.
    .accept_first_mouse(true)
    .visible(false)
    .build();
    match built {
        Ok(window) => {
            if let Some(origin) = app.primary_monitor().ok().flatten().map(|m| {
                let area = m.work_area();
                top_centre(
                    (area.position.x, area.position.y, area.size.width),
                    m.scale_factor(),
                    WIDTH,
                )
            }) {
                let _ = window.set_position(origin);
            }
            Some(window)
        }
        Err(e) => {
            tracing::warn!("[computer] could not open the computer use strip: {e}");
            None
        }
    }
}

/// Where a strip `width` logical pixels wide goes: centred at the top of a
/// work area `(x, y, width)` in physical pixels, at `scale`.
fn top_centre(area: (i32, i32, u32), scale: f64, width: f64) -> PhysicalPosition<i32> {
    let (x, y, area_width) = area;
    let strip = width * scale;
    PhysicalPosition::new(
        x + ((f64::from(area_width) - strip) / 2.0).round() as i32,
        y + (TOP * scale).round() as i32,
    )
}

/// Size the strip to what the page drew, keeping its middle where it is — the
/// page knows how long its words came out in this language.
pub fn fit(app: &AppHandle, width: f64, height: f64) {
    let Some(window) = app.get_webview_window(INDICATOR_LABEL) else {
        return;
    };
    if !(width.is_finite() && height.is_finite()) {
        return;
    }
    let (width, height) = (width.clamp(120.0, 720.0), height.clamp(24.0, 120.0));
    let (Ok(position), Ok(size), Ok(scale)) = (
        window.outer_position(),
        window.outer_size(),
        window.scale_factor(),
    ) else {
        return;
    };
    let _ = window.set_size(LogicalSize::new(width, height));
    let shift = (f64::from(size.width) - width * scale) / 2.0;
    let _ = window.set_position(PhysicalPosition::new(
        position.x + shift.round() as i32,
        position.y,
    ));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_is_up_while_anything_is_shared_unless_turned_off() {
        assert_eq!(Strip::of(true, true), Strip::Shown);
        assert_eq!(Strip::of(false, true), Strip::Hidden);
        assert_eq!(Strip::of(true, false), Strip::Hidden);
        assert_eq!(Strip::of(false, false), Strip::Hidden);
    }

    #[test]
    fn it_starts_centred_at_the_top_of_the_main_screen() {
        // A 1440-point-wide work area on a 2× screen, below a 25-point menu
        // bar: 2880 pixels wide, starting 50 pixels down.
        assert_eq!(
            top_centre((0, 50, 2880), 2.0, 360.0),
            PhysicalPosition::new(1080, 70)
        );
        assert_eq!(
            top_centre((-1920, 0, 1920), 1.0, 360.0),
            PhysicalPosition::new(-1140, 10)
        );
    }
}
