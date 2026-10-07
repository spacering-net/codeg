//! The ops that change a window, as fixed driver calls.
//!
//! Every action codeg sends is a closed [`WindowAction`]; this module builds
//! the driver's arguments from its fields — the tool (`click`,
//! `double_click`, `right_click`, `scroll`, `type_text`, `press_key`,
//! `set_value`), the window, the element or the point, the `delivery_mode`
//! codeg asked for where the tool takes one (macOS's `set_value` does not) —
//! and nothing else: the driver refuses an argument its tool does not name.
//! That is `"background"` unless codeg asked for the front, which it does
//! only where the person allows it: the driver then brings the window forward
//! for the one call and sends real input — and on macOS and Windows switches
//! back afterwards; on Linux the window stays in front. What the driver would
//! also accept (a desktop scope, a file to write a debug image to, a zoom's
//! coordinates) is never asked for.
//!
//! One action is the helper's own on macOS and Windows: putting a window back
//! on the screen ([`WindowAction::Restore`]), which the driver has no call
//! for that leaves it in the background. On macOS it goes through
//! Accessibility — the application shown again if it is hidden, the window
//! out of the Dock if it is minimized (see [`super::axwin`]); on Windows the
//! window is shown again without being made active (see `super::hwnd`).
//! Either way to that one window of that one process, bringing nothing to the
//! front. On Linux the driver's `bring_to_front` is the only way, and it
//! brings the window to the front: done only when codeg sent the restore
//! for the front. The driver is asked afterwards whether the window is on
//! the screen again.
//!
//! Before a call goes out, what only the helper knows is checked:
//!
//! * **The element.** The driver keeps the latest snapshot of each window and
//!   addresses an element by a token naming that snapshot and the element
//!   (`<snapshot id>:<index>`); the helper keeps the same snapshot
//!   ([`SnapshotBook`]), with what the tree said of each element. A ref from
//!   any other snapshot is stale, and text never goes into an element the tree
//!   judged secret (see [`super::tree`]).
//! * **The point.** A point is in the window's own pixels, read off a
//!   full-size capture of it at a certain size. The window is measured again
//!   now; at another size its contents are laid out elsewhere, and the point
//!   would land on something the agent never saw. The driver aims a point
//!   only for a window whose latest snapshot holds a capture of it: every
//!   snapshot the helper takes captures one (and keeps nothing of it), and
//!   where the driver has none ([`needs_capture`]) the helper takes a
//!   snapshot and sends the action once more — nothing went out the first
//!   time.
//!
//! The rest of "is this input still going where it was meant to" is the
//! driver's own background gate on macOS, which re-reads the window's owner,
//! the element's window and the application's other windows at the moment of
//! delivery, and refuses by code; each code comes back to codeg as one of the
//! helper's, in words written here rather than the driver's.

use std::collections::{HashMap, VecDeque};
use std::time::Duration;

use serde_json::{json, Value};

use super::driver_proc::DriverProc;
use super::keystate::held_modifiers;
use super::mcp::ToolCallResult;
use super::Delivery;
use crate::computer::keys::{Modifiers, Platform};
use crate::computer::protocol::{
    DriverTarget, ElementRef, HelperError, HelperErrorCode, OsPermission, RawAct, WindowAction,
    WindowPoint,
};
use crate::computer::types::{
    ActDelivery, ActEffect, ActRoute, PointerButton, Rect, ScrollDirection, ScrollUnit,
};

/// Everything but typing: one click, one key, one value.
const ACT_TIMEOUT: Duration = Duration::from_secs(30);
/// Typing: the driver budgets up to 100 s of synthesized keystrokes for one
/// call and refuses more before sending any.
const TYPE_TIMEOUT: Duration = Duration::from_secs(130);
/// Measuring a window before a point is clicked in it.
const MEASURE_TIMEOUT: Duration = Duration::from_secs(15);
/// How long a restored window has to be seen on the screen again: the Dock's
/// or the taskbar's animation, and an application slow to draw.
const RESTORE_WAIT: Duration = Duration::from_secs(3);
const RESTORE_POLL: Duration = Duration::from_millis(100);

/// The driver's intermediate pointer moves along a drag: one every 25 ms of
/// its path, within the driver's own bounds.
const DRAG_STEP_MS: u32 = 25;
const MAX_DRAG_STEPS: u32 = 200;

/// How many windows' latest snapshots the helper remembers. The driver keeps
/// eight per process; this bounds the helper's memory, not the driver's.
const BOOK_WINDOWS: usize = 64;

/// What the tree said of one element that can be acted on.
#[derive(Debug, Clone, PartialEq)]
pub struct ElementFacts {
    pub role: String,
    pub secret: bool,
    /// A menu command or a button named for pasting (`ops::element_refs`).
    pub paste: bool,
    /// Where the element was on the screen when the snapshot was taken, in
    /// the platform's desktop units — for the marker, not for aiming (the
    /// driver aims by the element itself).
    pub frame: Option<Rect>,
}

/// The latest snapshot of one window: the driver's id for it, and its
/// elements.
#[derive(Debug, Clone, PartialEq)]
pub struct SnapshotFacts {
    pub snapshot_id: String,
    pub elements: HashMap<u32, ElementFacts>,
}

/// The latest snapshot the helper took of each window, as the driver keeps
/// them: a new snapshot of a window replaces the one before.
#[derive(Default)]
pub struct SnapshotBook {
    windows: HashMap<(u32, u64), SnapshotFacts>,
    /// Oldest first, for letting go once there are too many.
    order: VecDeque<(u32, u64)>,
}

impl SnapshotBook {
    /// Remember a snapshot just taken of `(pid, window_id)` — or, with
    /// `None`, that the driver kept none, so nothing from before is current.
    pub fn record(&mut self, pid: u32, window_id: u64, facts: Option<SnapshotFacts>) {
        let key = (pid, window_id);
        // The driver mints ids from one counter: an answer that arrives after
        // a later snapshot's was recorded is not the current one.
        if let (Some(new), Some(held)) = (
            facts.as_ref().and_then(|f| snapshot_number(&f.snapshot_id)),
            self.windows
                .get(&key)
                .and_then(|f| snapshot_number(&f.snapshot_id)),
        ) {
            if new < held {
                return;
            }
        }
        self.order.retain(|k| *k != key);
        match facts {
            Some(facts) => {
                self.windows.insert(key, facts);
                self.order.push_back(key);
                while self.order.len() > BOOK_WINDOWS {
                    if let Some(oldest) = self.order.pop_front() {
                        self.windows.remove(&oldest);
                    }
                }
            }
            None => {
                self.windows.remove(&key);
            }
        }
    }

    /// Forget everything — the driver that took these snapshots is gone.
    pub fn clear(&mut self) {
        self.windows.clear();
        self.order.clear();
    }

    /// Where `element` was on the screen when its snapshot was taken, if that
    /// is still the window's latest snapshot and it said.
    pub fn frame(&self, pid: u32, window_id: u64, element: &ElementRef) -> Option<Rect> {
        self.windows
            .get(&(pid, window_id))
            .filter(|f| f.snapshot_id == element.snapshot_id)?
            .elements
            .get(&element.index)?
            .frame
    }

    /// Check `action`'s element against the latest snapshot of the window:
    /// it is from that snapshot, the snapshot has such an element, and the
    /// element may take what the action does to it.
    /// `paste_ok`: the clipboard is still what the agent put there, and a
    /// control that pastes may be pressed.
    pub fn check(
        &self,
        pid: u32,
        window_id: u64,
        action: &WindowAction,
        app_key: Option<&str>,
        paste_ok: bool,
    ) -> Result<(), HelperError> {
        let Some(element) = action.element() else {
            return Ok(());
        };
        let stale = || {
            HelperError::new(
                HelperErrorCode::StaleRef,
                "That ref is from a snapshot this window has moved past. Take a new \
                 computer_snapshot and use a ref from it.",
            )
        };
        let facts = self
            .windows
            .get(&(pid, window_id))
            .filter(|f| f.snapshot_id == element.snapshot_id)
            .ok_or_else(stale)?;
        let found = facts.elements.get(&element.index).ok_or_else(stale)?;
        // Pressing it pastes: the person's clipboard would land in the
        // window, unless it holds what the agent put there. Scrolling over
        // it does not.
        if found.paste && !paste_ok && !matches!(action, WindowAction::Scroll { .. }) {
            return Err(paste_refused());
        }
        if found.secret && action.writes_text() {
            return Err(HelperError::new(
                HelperErrorCode::SecretField,
                "That is a password or other secret field: typing into it, or setting it, is \
                 left to the user. Ask them to fill it in themselves.",
            ));
        }
        // Safari's pop-up menus with no accessible options are set by the
        // driver through AppleScript against Safari's *front* document — any
        // window of it, not necessarily this one — and in the helper's name.
        // With no key to tell the application by, it could be Safari.
        if matches!(action, WindowAction::SetValue { .. })
            && found.role == "AXPopUpButton"
            && app_key.is_none_or(is_safari)
        {
            return Err(HelperError::new(
                HelperErrorCode::ActionFailed,
                "Choosing from a pop-up menu in Safari cannot be done by setting its value. \
                 Click the menu to open it, then click the option.",
            ));
        }
        Ok(())
    }
}

/// The number in a driver snapshot id (`s` and eight hex digits).
fn snapshot_number(id: &str) -> Option<u64> {
    u64::from_str_radix(id.strip_prefix('s')?, 16).ok()
}

fn is_safari(app_key: &str) -> bool {
    let key = app_key.to_ascii_lowercase();
    key.starts_with("com.apple.safari") || key.ends_with("/safari.app")
}

/// Check that the points of an action are still where they were read: the
/// window is the size it was when the capture they came from was taken —
/// measured once for all of them. Returns where the window is now, when the
/// driver said — for the marker, not for aiming. Nothing to check, nothing
/// measured.
pub async fn check_points(
    driver: &DriverProc,
    pid: u32,
    window_id: u64,
    points: &[&WindowPoint],
) -> Result<Option<Rect>, HelperError> {
    if points.is_empty() {
        return Ok(None);
    }
    if !driver.full_size_captures() {
        return Err(HelperError::new(
            HelperErrorCode::ActionFailed,
            "Pointing by coordinates is not available right now. Use a ref from \
             computer_snapshot instead.",
        ));
    }
    let window = listed(driver, pid, window_id).await?;
    let bounds = window
        .get("bounds")
        .ok_or_else(|| HelperError::new(HelperErrorCode::NoSuchWindow, "the window is gone"))?;
    let number = |key: &str| bounds.get(key).and_then(Value::as_f64);
    let (width, height) = (
        number("width").unwrap_or(0.0),
        number("height").unwrap_or(0.0),
    );
    let resized = |point: &&WindowPoint| {
        (width - point.window_width).abs() > 1.0 || (height - point.window_height).abs() > 1.0
    };
    if points.iter().any(resized) {
        return Err(HelperError::new(
            HelperErrorCode::StaleRef,
            "The window has changed size since that screenshot, so its contents are not where \
             they were. Take a new computer_screenshot and use a point from it.",
        ));
    }
    // Where the window is, for the marker: only when the driver said.
    Ok(match (number("x"), number("y")) {
        (Some(x), Some(y)) => Some(Rect {
            x,
            y,
            width,
            height,
        }),
        _ => None,
    })
}

/// The driver's listing of one window now, as it gave it.
pub(super) async fn listed(
    driver: &DriverProc,
    pid: u32,
    window_id: u64,
) -> Result<Value, HelperError> {
    let result = driver
        .call(
            "list_windows",
            json!({ "pid": pid, "on_screen_only": false }),
            MEASURE_TIMEOUT,
        )
        .await?;
    if result.is_error {
        return Err(super::ops::tool_error("list_windows", &result));
    }
    result
        .structured
        .as_ref()
        .and_then(|s| s.get("windows"))
        .and_then(Value::as_array)
        .and_then(|windows| {
            windows
                .iter()
                .find(|w| w.get("window_id").and_then(Value::as_u64) == Some(window_id))
        })
        .cloned()
        .ok_or_else(|| HelperError::new(HelperErrorCode::NoSuchWindow, "the window is gone"))
}

/// Put the window back on the screen, then watch for it there: confirmed
/// once the driver lists it on screen, unverifiable if it has not by the time
/// [`RESTORE_WAIT`] has passed (a look already asked is answered first,
/// however long the driver takes). A window already on the screen is as the
/// action would leave it. `deliverable` is asked again just before each
/// change: reading the application's windows first can take long enough for
/// the person to press Stop.
async fn restore(
    driver: &DriverProc,
    pid: u32,
    window_id: u64,
    mode: ActDelivery,
    deliverable: &Delivery,
) -> Result<RawAct, HelperError> {
    let effect = |effect| RawAct {
        effect,
        route: None,
        submitted: None,
        submit_note: None,
        element_frame: None,
        window_frame: None,
        clipboard: None,
    };
    if !ask_back(driver, pid, window_id, mode, deliverable).await? {
        return Ok(effect(ActEffect::Confirmed));
    }
    let deadline = tokio::time::Instant::now() + RESTORE_WAIT;
    loop {
        let window = listed(driver, pid, window_id).await?;
        if window.get("is_on_screen").and_then(Value::as_bool) == Some(true) {
            return Ok(effect(ActEffect::Confirmed));
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(effect(ActEffect::Unverifiable));
        }
        tokio::time::sleep(RESTORE_POLL).await;
    }
}

/// Ask for the window back, through Accessibility: its application shown
/// again if hidden, then the window out of the Dock if minimized. `false`
/// when it was neither — nothing was asked. The window is looked for in the
/// driver's listing first: showing a hidden application again shows all its
/// windows, which is done only for a window of it that is still there.
#[cfg(target_os = "macos")]
async fn ask_back(
    driver: &DriverProc,
    pid: u32,
    window_id: u64,
    _mode: ActDelivery,
    deliverable: &Delivery,
) -> Result<bool, HelperError> {
    use super::axwin::Restore;
    let window = listed(driver, pid, window_id).await?;
    if window.get("is_on_screen").and_then(Value::as_bool) == Some(true) {
        return Ok(false);
    }
    let ready = deliverable.clone();
    match super::axwin::restore(pid, window_id, move || ready.check()).await? {
        Restore::Asked => Ok(true),
        Restore::AlreadyShown => Ok(false),
        Restore::Unlisted => Err(HelperError::new(
            HelperErrorCode::Occluded,
            "The window cannot be reached to restore it: it may be on another desktop \
             (Space). Ask the user to bring it back.",
        )),
        Restore::Failed(code) => Err(HelperError::new(
            HelperErrorCode::ActionFailed,
            format!(
                "The window's application did not restore it (Accessibility error {code}). \
                 Ask the user to restore it."
            ),
        )),
    }
}

/// Ask for the window back: shown again where it was if it is minimized,
/// without being made the active window. `false` when it was not minimized.
#[cfg(windows)]
async fn ask_back(
    _driver: &DriverProc,
    pid: u32,
    window_id: u64,
    _mode: ActDelivery,
    deliverable: &Delivery,
) -> Result<bool, HelperError> {
    use super::hwnd::Restore;
    let ready = deliverable.clone();
    let asked = tokio::task::spawn_blocking(move || {
        super::hwnd::restore(window_id, pid, move || ready.check())
    })
    .await
    .map_err(|e| HelperError::failed(format!("restore: {e}")))??;
    match asked {
        Restore::Asked => Ok(true),
        Restore::AlreadyShown => Ok(false),
        Restore::NotTheWindow => Err(HelperError::new(
            HelperErrorCode::NoSuchWindow,
            "the window is gone",
        )),
    }
}

/// Ask for the window back through the driver, which on Linux can only do it
/// by bringing it to the front — which codeg asked for only where the person
/// allows it. `false` when it is on the screen already. Where the window
/// manager says the window is not minimized — on another desktop — it is not
/// brought over, as on the other platforms; where nothing says (Wayland), an
/// off-screen window is brought back.
#[cfg(not(any(target_os = "macos", windows)))]
async fn ask_back(
    driver: &DriverProc,
    pid: u32,
    window_id: u64,
    mode: ActDelivery,
    deliverable: &Delivery,
) -> Result<bool, HelperError> {
    let window = listed(driver, pid, window_id).await?;
    if window.get("is_on_screen").and_then(Value::as_bool) == Some(true) {
        return Ok(false);
    }
    if minimized_on_x11(window_id).await == Some(false) {
        return Err(HelperError::new(
            HelperErrorCode::Occluded,
            "The window is not minimized: it is on another desktop, or otherwise out of reach. \
             Ask the user to bring it back.",
        ));
    }
    if mode != ActDelivery::Foreground {
        return Err(HelperError::new(
            HelperErrorCode::BackgroundUnavailable,
            "On Linux a window comes back on the screen only by being brought to the front.",
        ));
    }
    deliverable.check()?;
    let result = driver
        .call(
            "bring_to_front",
            json!({ "pid": pid, "window_id": window_id }),
            ACT_TIMEOUT,
        )
        .await?;
    if result.is_error {
        return Err(HelperError::new(
            HelperErrorCode::ActionFailed,
            format!(
                "The window could not be brought back: {}. Ask the user to restore it.",
                super::ops::tool_error("bring_to_front", &result).message
            ),
        ));
    }
    Ok(true)
}

/// Whether the X11 window manager has window `window_id` minimized; `None`
/// where it cannot be asked.
#[cfg(not(any(target_os = "macos", windows)))]
async fn minimized_on_x11(window_id: u64) -> Option<bool> {
    #[cfg(all(target_os = "linux", feature = "computer-helper"))]
    {
        tokio::task::spawn_blocking(move || {
            super::x11win::window_states(&[window_id])
                .get(&window_id)
                .map(|state| state.minimized)
        })
        .await
        .ok()
        .flatten()
    }
    #[cfg(not(all(target_os = "linux", feature = "computer-helper")))]
    {
        let _ = window_id;
        None
    }
}

/// The permissions an action needs of the OS: every action reaches the
/// window through Accessibility, and a point is placed by capturing the
/// window again to measure it.
pub fn permissions_for(action: &WindowAction) -> &'static [OsPermission] {
    if action.point().is_some() {
        &[OsPermission::Accessibility, OsPermission::ScreenRecording]
    } else {
        &[OsPermission::Accessibility]
    }
}

/// Carry out `action` on the window, delivered as `mode` says: one driver
/// call, or two for typing that ends with return, both delivered alike.
/// `deliverable` is asked just before each call goes out — whatever must
/// still hold at the moment of delivery (nothing stopped, the same process,
/// an unlocked session) — and a call it refuses is not made; so is a key or
/// typing at the front while the person holds a modifier ([`keys_free`]).
pub async fn act(
    driver: &DriverProc,
    pid: u32,
    window_id: u64,
    action: &WindowAction,
    mode: ActDelivery,
    deliverable: &Delivery,
    paste_ok: bool,
) -> Result<RawAct, HelperError> {
    // Only macOS checks a menu command's own shortcut for a paste.
    #[cfg(not(target_os = "macos"))]
    let _ = paste_ok;
    let platform = Platform::current();
    let mut args = json!({
        "pid": pid,
        "window_id": window_id,
    });
    if takes_delivery(action, platform) {
        args["delivery_mode"] = json!(mode.as_str());
    }
    match action {
        WindowAction::Click {
            at,
            button,
            count,
            modifiers,
        } => {
            let tool = match (button, count) {
                (PointerButton::Left, 1) | (PointerButton::Middle, 1) => "click",
                (PointerButton::Left, 2) => "double_click",
                (PointerButton::Right, 1) => "right_click",
                _ => {
                    return Err(HelperError::new(
                        HelperErrorCode::BadRequest,
                        "a click is one or two presses of the left button, or one of another",
                    ))
                }
            };
            if *button == PointerButton::Middle {
                args["button"] = json!("middle");
            }
            put_modifiers(&mut args, *modifiers, platform);
            put_target(&mut args, at);
            deliverable.check()?;
            one(driver, tool, args, mode, ACT_TIMEOUT).await
        }
        WindowAction::Drag {
            from,
            to,
            button,
            modifiers,
            duration_ms,
        } => {
            // Whole pixels: Linux's driver rounds a drag's points where it
            // truncates a click's, and rounding up could put a point in the
            // image's last half pixel just past its edge.
            args["from_x"] = json!(from.x.floor());
            args["from_y"] = json!(from.y.floor());
            args["to_x"] = json!(to.x.floor());
            args["to_y"] = json!(to.y.floor());
            args["button"] = json!(match button {
                PointerButton::Left => "left",
                PointerButton::Right => "right",
                PointerButton::Middle => "middle",
            });
            args["duration_ms"] = json!(duration_ms);
            args["steps"] = json!((duration_ms / DRAG_STEP_MS).clamp(1, MAX_DRAG_STEPS));
            put_modifiers(&mut args, *modifiers, platform);
            #[cfg(target_os = "macos")]
            if mode == ActDelivery::Foreground {
                deliverable.check()?;
                front_of_its_app(driver, pid, window_id).await?;
            }
            deliverable.check()?;
            let timeout = ACT_TIMEOUT + Duration::from_millis(u64::from(*duration_ms));
            one(driver, "drag", args, mode, timeout).await
        }
        WindowAction::Scroll {
            at,
            direction,
            amount,
            unit,
        } => {
            args["direction"] = json!(match direction {
                ScrollDirection::Up => "up",
                ScrollDirection::Down => "down",
                ScrollDirection::Left => "left",
                ScrollDirection::Right => "right",
            });
            args["amount"] = json!((*amount).clamp(1, crate::computer::types::MAX_SCROLL_AMOUNT));
            args["by"] = json!(match unit {
                ScrollUnit::Line => "line",
                ScrollUnit::Page => "page",
            });
            if let Some(at) = at {
                put_target(&mut args, at);
            }
            deliverable.check()?;
            one(driver, "scroll", args, mode, ACT_TIMEOUT).await
        }
        WindowAction::Type {
            element,
            text,
            submit,
        } => {
            put_element(&mut args, element);
            let mut key = args.clone();
            args["text"] = json!(text);
            deliverable.check()?;
            keys_free(mode, held_modifiers)?;
            let typed = one(driver, "type_text", args, mode, TYPE_TIMEOUT).await?;
            if !*submit {
                return Ok(typed);
            }
            key["key"] = json!("return");
            // Typing can take a while: the second call is held to the same
            // conditions as the first, at its own moment.
            let pressed = match deliverable
                .check()
                .and_then(|()| keys_free(mode, held_modifiers))
            {
                Ok(()) => one(driver, "press_key", key, mode, ACT_TIMEOUT).await,
                Err(e) => Err(e),
            };
            Ok(match pressed {
                // Both went out: the whole is as sure as its less sure half.
                Ok(pressed) => RawAct {
                    effect: weaker(typed.effect, pressed.effect),
                    submitted: Some(true),
                    ..typed
                },
                // The text went in; return did not. Said as such, and why.
                Err(e) => RawAct {
                    submitted: Some(false),
                    submit_note: Some(e.message),
                    ..typed
                },
            })
        }
        WindowAction::Key { element, chord } => {
            args["key"] = json!(chord.key.driver_name(platform));
            let modifiers = chord.modifiers.driver_names(platform);
            if !modifiers.is_empty() {
                args["modifiers"] = json!(modifiers);
            }
            if let Some(element) = element {
                put_element(&mut args, element);
            }
            deliverable.check()?;
            keys_free(mode, held_modifiers)?;
            one(driver, "press_key", args, mode, ACT_TIMEOUT).await
        }
        WindowAction::SetValue { element, value } => {
            put_element(&mut args, element);
            args["value"] = json!(value);
            deliverable.check()?;
            one(driver, "set_value", args, mode, ACT_TIMEOUT).await
        }
        WindowAction::InvokeMenu { path } => {
            // The driver brings the application forward for it itself, and
            // reads nothing but these three.
            if platform == Platform::Windows {
                return Err(HelperError::new(
                    HelperErrorCode::ActionFailed,
                    "Menus cannot be chosen by title on Windows: click the menu by its ref \
                     instead.",
                ));
            }
            #[cfg(target_os = "macos")]
            menu_in_reach(pid, path, paste_ok).await?;
            let args = json!({ "pid": pid, "window_id": window_id, "path": path });
            deliverable.check()?;
            one(driver, "invoke_menu", args, mode, ACT_TIMEOUT).await
        }
        WindowAction::SetFrame {
            x,
            y,
            width,
            height,
        } => {
            // What is not given stays as the window is now — read just
            // before, not taken from a listing an earlier move or the person
            // has overtaken.
            let now = listed(driver, pid, window_id)
                .await?
                .get("bounds")
                .and_then(super::ops::rect)
                .ok_or_else(|| {
                    HelperError::new(
                        HelperErrorCode::ActionFailed,
                        "The window's frame could not be read, so it was not moved.",
                    )
                })?;
            let frame = Rect {
                x: x.unwrap_or(now.x),
                y: y.unwrap_or(now.y),
                width: width.unwrap_or(now.width),
                height: height.unwrap_or(now.height),
            };
            // The driver takes the frame alone: no delivery mode — moving a
            // window does not bring it forward.
            let args = json!({
                "pid": pid,
                "window_id": window_id,
                "x": frame.x,
                "y": frame.y,
                "width": frame.width,
                "height": frame.height,
            });
            deliverable.check()?;
            one(driver, "set_window_frame", args, mode, ACT_TIMEOUT).await
        }
        WindowAction::Restore => {
            deliverable.check()?;
            restore(driver, pid, window_id, mode, deliverable).await
        }
    }
}

/// A drag at the front on macOS goes in as real pointer input once the
/// driver has brought the application forward — the application, not the
/// window: the windows the application names as its focused and main ones
/// come forward with it, and the drag lands on whatever is then under the
/// pointer. So it is sent only for the window that is already its
/// application's front one: on the screen; ahead, in the window server's
/// order, of every other window of the application on this desktop or on
/// another (that one would come forward, and the desktop switch to it); and
/// not behind another the application names as focused or main. Asked just
/// before the drag.
#[cfg(target_os = "macos")]
async fn front_of_its_app(
    driver: &DriverProc,
    pid: u32,
    window_id: u64,
) -> Result<(), HelperError> {
    let result = driver
        .call(
            "list_windows",
            json!({ "pid": pid, "on_screen_only": false }),
            MEASURE_TIMEOUT,
        )
        .await?;
    if result.is_error {
        return Err(super::ops::tool_error("list_windows", &result));
    }
    let windows = super::ops::parse_windows(super::ops::structured("list_windows", &result)?)?;
    let Some(target) = windows
        .iter()
        .find(|w| w.pid == pid && w.window_id == window_id)
    else {
        return Err(HelperError::new(
            HelperErrorCode::NoSuchWindow,
            "the window is gone",
        ));
    };
    if !target.on_screen {
        return Err(HelperError::new(
            HelperErrorCode::Occluded,
            "The window is not on the screen — minimized, hidden or on another desktop (Space) — \
             and a drag at the front goes wherever the pointer is. computer_restore brings back a \
             minimized window or a hidden application; otherwise ask the user to bring it back.",
        ));
    }
    let front = target.z_index;
    let ahead = windows
        .iter()
        .filter(|w| w.pid == pid && w.window_id != window_id)
        .filter(|w| w.on_screen || w.on_current_space == Some(false))
        .any(|w| match (w.z_index, front) {
            (Some(other), Some(front)) => other > front,
            // Where the order cannot be told, it cannot be ruled out.
            _ => true,
        });
    let (focused, main) = super::axwin::focused_and_main(pid).await;
    let named_other = [focused, main]
        .into_iter()
        .flatten()
        .any(|named| named != window_id);
    if ahead || named_other {
        return Err(HelperError::new(
            HelperErrorCode::Occluded,
            "Another window of this application is in front of this one, or is the one the \
             application brings forward, and a drag at the front would land on it — so nothing \
             was sent. Once this window is the application's front one, drag again: ask the user \
             to click it, or bring it forward with a computer_click on it at the front.",
        ));
    }
    Ok(())
}

/// Whether a menu command an application shared as a whole may be chosen
/// (macOS): not in the Apple menu or the application menu, which reach past
/// the application — restarting, logging out, Services, hiding every other
/// application — and not one whose shortcut is ⌘V, a paste by another name.
/// A command the walk through the menus as they stand cannot reach — a title
/// missing or met twice, a menu that fills itself only once opened — is
/// refused: what it is cannot be told before it is chosen.
#[cfg(target_os = "macos")]
async fn menu_in_reach(pid: u32, path: &[String], paste_ok: bool) -> Result<(), HelperError> {
    use super::axwin::{menu_target, MENU_NO_COMMAND};
    let target = menu_target(pid, path.to_vec()).await;
    match target.bar_index {
        None => Err(HelperError::new(
            HelperErrorCode::ActionFailed,
            format!(
                "The menu bar has no single menu titled \"{}\". Read the menus again \
                 (computer_snapshot) and use their titles exactly.",
                path.first().map(String::as_str).unwrap_or_default()
            ),
        )),
        Some(0 | 1) => Err(HelperError::new(
            HelperErrorCode::BeyondApp,
            "The Apple menu and the application menu reach past the application — restarting, \
             logging out, Services, hiding the others — so nothing in them is chosen for an agent. \
             The application's own shortcuts do what it needs of them (⌘, for its settings, ⌘Q to \
             quit it).",
        )),
        Some(_) if !target.reached => Err(HelperError::new(
            HelperErrorCode::ActionFailed,
            "That command cannot be found in the application's menus as they stand: a title is \
             missing or appears twice, or the menu fills itself only when opened. Read the menus \
             again (computer_snapshot) and use their titles exactly; for a menu that fills itself, \
             click it open and choose the item by ref.",
        )),
        Some(_) => match target.shortcut {
            Some((key, mask))
                if !paste_ok && key.eq_ignore_ascii_case("v") && mask & MENU_NO_COMMAND == 0 =>
            {
                Err(HelperError::new(
                    HelperErrorCode::PasteRefused,
                    "That command pastes (⌘V), and the clipboard is the user's own: what is on it \
                     may not come from any window you may read. Type the text with computer_type \
                     instead.",
                ))
            }
            _ => Ok(()),
        },
    }
}

/// Whether `action` pastes by its key: ⌘V / Ctrl+V and the rest of its
/// kind (`keys::classify`).
pub fn pastes(action: &WindowAction) -> bool {
    match action {
        WindowAction::Key { chord, .. } => {
            crate::computer::keys::classify(chord, Platform::current())
                == crate::computer::keys::ChordClass::Paste
        }
        // A menu command named for pasting, on every platform; the one
        // whose shortcut is ⌘V is caught on macOS by `menu_in_reach`.
        WindowAction::InvokeMenu { path } => path
            .iter()
            .any(|title| crate::computer::keys::names_paste(title)),
        _ => false,
    }
}

/// A paste refused: the clipboard is not what the agent put there.
pub fn paste_refused() -> HelperError {
    HelperError::new(
        HelperErrorCode::PasteRefused,
        "That pastes, and the clipboard holds what the user put there, not what you copied from \
         a window you may read or wrote with computer_clipboard_write. Type the text with \
         computer_type instead, or copy it from a shared window first.",
    )
}

/// The modifiers held over a pointer action, as `platform`'s driver spells
/// them; none, nothing said.
fn put_modifiers(args: &mut Value, modifiers: Modifiers, platform: Platform) {
    let names = modifiers.driver_names(platform);
    if !names.is_empty() {
        args["modifier"] = json!(names);
    }
}

/// Keys and typing sent with the window brought to the front go in as real
/// input, and combine with whatever modifier is held at that moment (see
/// `keystate`): while the person holds one — or where that cannot be told —
/// none is sent. In the background they reach the window alone, and go as
/// asked.
fn keys_free(
    mode: ActDelivery,
    held: impl FnOnce() -> Option<Vec<&'static str>>,
) -> Result<(), HelperError> {
    if mode != ActDelivery::Foreground {
        return Ok(());
    }
    match held() {
        Some(held) if held.is_empty() => Ok(()),
        Some(held) => Err(HelperError::new(
            HelperErrorCode::ActionFailed,
            modifiers_held(&held),
        )),
        None => Err(HelperError::new(
            HelperErrorCode::ActionFailed,
            MODIFIERS_UNKNOWN,
        )),
    }
}

/// What the agent is told where the held modifiers cannot be told.
const MODIFIERS_UNKNOWN: &str = "On this desktop codeg cannot tell whether the user is holding \
     down a modifier key, and keys sent with the window brought to the front would combine with \
     one — so nothing was sent, and retrying will not change that. Leave `delivery` out to send \
     it in the background, or use computer_set_value or a click on an element by ref.";

/// What the agent is told when the person is holding `held` down.
fn modifiers_held(held: &[&str]) -> String {
    let names = match held {
        [] => String::new(),
        [one] => (*one).to_string(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    };
    format!(
        "The user is holding down {names} right now. Keys sent with the window brought to the \
         front go in as real input and would have combined with what they hold, so nothing was \
         sent. Try again in a moment; if this keeps happening, ask the user to let go of {names}."
    )
}

/// The less certain of two effects: confirmed, then unverifiable, then
/// partial, then suspected no-op.
fn weaker(a: ActEffect, b: ActEffect) -> ActEffect {
    let rank = |e: ActEffect| match e {
        ActEffect::Confirmed => 3,
        ActEffect::Unverifiable => 2,
        ActEffect::Partial => 1,
        ActEffect::SuspectedNoop => 0,
    };
    if rank(a) <= rank(b) {
        a
    } else {
        b
    }
}

/// Whether the driver's tool for `action` on `platform` takes a delivery
/// mode: all but macOS's `set_value`, which sets a value through
/// Accessibility alone.
fn takes_delivery(action: &WindowAction, platform: Platform) -> bool {
    !(platform == Platform::Mac && matches!(action, WindowAction::SetValue { .. }))
}

fn put_element(args: &mut Value, element: &ElementRef) {
    args["element_token"] = json!(element_token(element));
}

/// The driver's name for an element: its snapshot's id and its index in that
/// snapshot, as the driver writes them (`s0000002a:7`).
fn element_token(element: &ElementRef) -> String {
    format!("{}:{}", element.snapshot_id, element.index)
}

fn put_target(args: &mut Value, at: &DriverTarget) {
    match at {
        DriverTarget::Element(element) => put_element(args, element),
        DriverTarget::Point(point) => {
            args["x"] = json!(point.x);
            args["y"] = json!(point.y);
        }
    }
}

/// One driver call, delivered as `mode` says (and as `args` already asks),
/// and what it did.
async fn one(
    driver: &DriverProc,
    tool: &str,
    args: Value,
    mode: ActDelivery,
    timeout: Duration,
) -> Result<RawAct, HelperError> {
    let result = driver.call(tool, args, timeout).await?;
    if result.is_error {
        return Err(act_error(tool, mode, &result));
    }
    action_result(tool, mode, &result)
}

/// Read the driver's closed action result: how far it can vouch for the
/// action, and the route it took. One it refused without calling it an
/// error says why by code (`error.code`), read as any refusal is.
fn action_result(
    tool: &str,
    mode: ActDelivery,
    result: &ToolCallResult,
) -> Result<RawAct, HelperError> {
    let structured = result.structured.as_ref();
    let effect = structured
        .and_then(|s| s.get("effect"))
        .and_then(Value::as_str);
    let effect = match effect {
        Some("confirmed") => ActEffect::Confirmed,
        Some("partial") => ActEffect::Partial,
        Some("suspected_noop") => ActEffect::SuspectedNoop,
        Some("refused") => {
            return Err(match result.code() {
                Some(_) => act_error(tool, mode, result),
                None => HelperError::new(
                    HelperErrorCode::ActionFailed,
                    format!("The application refused the {tool}."),
                ),
            })
        }
        // Delivered, and nothing said what came of it.
        _ => ActEffect::Unverifiable,
    };
    let route = structured
        .and_then(|s| s.get("route"))
        .cloned()
        .and_then(|r| serde_json::from_value::<ActRoute>(r).ok());
    Ok(RawAct {
        effect,
        route,
        submitted: None,
        submit_note: None,
        element_frame: None,
        window_frame: None,
        clipboard: None,
    })
}

/// The window class Chromium gives its windows on Windows
/// (`Chrome_WidgetWin_1`), as the driver names a refused target's.
const CHROMIUM_WINDOW_CLASS: &str = "Chrome_WidgetWin_";

/// What the agent is told when the driver would not send the input in the
/// background. A key or text is refused for the application as a whole —
/// aimed at an element by ref as much as at the window, and every time — so
/// the words say what still reaches it in the background, rather than
/// suggest a ref. On Windows the commonest such application is one built on
/// Chromium, which drops every key that does not come from the front; the
/// driver names it by its window class. Two refusals are of another kind: on
/// Windows an application's accessibility interface that did not finish a
/// click it may already have acted on (`effect: "unverifiable"`), and on
/// Linux background input that goes through `/dev/uinput`, which the
/// session cannot write. Whether the front is to be had is the person's
/// setting, which codeg knows and adds to these words.
fn background_refusal(tool: &str, result: &ToolCallResult) -> String {
    let said = |key: &str| {
        result
            .structured
            .as_ref()
            .and_then(|s| s.get(key))
            .and_then(Value::as_str)
    };
    if said("effect") == Some("unverifiable") {
        return "The application's accessibility interface did not finish that action, and it \
                may have gone through even so. Read the window (computer_snapshot or \
                computer_screenshot) before trying it again."
            .to_string();
    }
    if result.code() == Some("uinput_unavailable") || said("cause") == Some("uinput_unavailable") {
        return "This Linux desktop takes such input in the background only through \
                /dev/uinput, which codeg cannot use here, so nothing was sent."
            .to_string();
    }
    if !matches!(tool, "press_key" | "type_text") {
        return "This application does not take that kind of input in the background. Try an \
                element by ref, or computer_set_value."
            .to_string();
    }
    let mut words = "This application takes no key presses or typing while it is in the \
                     background, so nothing was sent — and trying again in the background, by \
                     ref or not, will not change that. Fill a field with computer_set_value \
                     instead, and click by ref what the key would have done (a search or submit \
                     button, in place of return), or ask the user to press it."
        .to_string();
    let chromium = result
        .structured
        .as_ref()
        .and_then(|s| s.get("target_class"))
        .and_then(Value::as_str)
        .is_some_and(|class| class.starts_with(CHROMIUM_WINDOW_CLASS));
    if chromium {
        words.push_str(
            " On Windows no application built on Chromium takes keys in the background: Edge, \
             Chrome, VS Code and other Electron apps. For a web page, codeg's own browser (the \
             browser_* tools) does.",
        );
    }
    words
}

/// Said when the driver holds no capture of the window to aim a point by:
/// its latest snapshot of the window has none. The helper then takes a
/// snapshot, which captures the window, and tries once more
/// ([`needs_capture`]); these words reach the agent only if that fails too.
const NO_CAPTURE: &str = "The window has no capture to aim a point by just now, so nothing was \
     sent. Take a new computer_screenshot and use a point from it.";

/// Whether `error` is the driver holding no capture of the window to aim a
/// point by: nothing was sent, and a snapshot gives it one.
pub fn needs_capture(error: &HelperError) -> bool {
    error.code == HelperErrorCode::StaleRef && error.message == NO_CAPTURE
}

/// A window whose application runs with more rights than the driver: no
/// input reaches it, whichever way it is sent.
const HIGHER_RIGHTS: &str = "That window's application runs with more rights than codeg (as \
     administrator), and Windows lets no input from codeg reach it, in the background or at the \
     front. Nothing was sent; ask the user to do this step.";

/// A call with the window brought to the front that failed before any input
/// went out.
const FRONT_NOT_HAD: &str = "The window could not be brought to the front just now, so nothing \
     was sent. Try again in a moment; if it keeps failing, ask the user to do this step.";

/// A call with the window brought to the front that failed with its input
/// sent, or perhaps sent.
const FRONT_LOST: &str = "This action, with the window brought to the front, did not finish \
     cleanly, so whether it went through cannot be told — it may have. Read the window \
     (computer_snapshot or computer_screenshot) before doing it again: repeating it blindly could \
     do it twice.";

/// What the driver says, word for word, only of a front it failed to have
/// before any input went out: on Windows its `foreground_unavailable: …`
/// texts that end "no input was sent" (or never got as far as the mouse); on
/// macOS the activation that came before the keys or the click. A failure
/// said any other way may have come after.
const NOTHING_SENT: [&str; 7] = [
    "no input was sent",
    "no mouse input was sent",
    "before mouse input could be sent",
    "foreground HID delivery is unavailable",
    "could not resolve target window for foreground HID delivery",
    "rejected foreground HID activation",
    "did not become focused for foreground HID delivery",
];

/// What to say of a call with the window brought to the front that the
/// driver could not deliver; `None` for any other failure. On Windows the
/// driver says it in words, not codes (`foreground_unavailable: …` when the
/// window was not, or did not stay, at the front; `UIPI: …` for an
/// application running with more rights than it); on macOS by the code
/// `delivery_failed`, or `foreground_unavailable` for a click at a point; on
/// Linux by `foreground_unavailable` or, for a window manager that did not
/// answer in time, `foreground_timeout`. Only a failure the driver says came
/// before any input went out is one to simply try again: a click it found the
/// window gone from the front *after* may well have landed.
fn front_failure(code: &str, text: &str) -> Option<&'static str> {
    let text = text.trim_start();
    if text.starts_with("UIPI") {
        Some(HIGHER_RIGHTS)
    } else if matches!(
        code,
        "delivery_failed" | "foreground_unavailable" | "foreground_timeout"
    ) || text.starts_with("foreground_unavailable")
        || text.starts_with("foreground_timeout")
    {
        if NOTHING_SENT.iter().any(|said| text.contains(said)) {
            Some(FRONT_NOT_HAD)
        } else {
            Some(FRONT_LOST)
        }
    } else {
        None
    }
}

/// A refused action, by the driver's code, in words for the agent. Only where
/// the driver's own text is the useful part (an action that was tried and
/// failed) is it passed on, shortened. `mode` is how the call was delivered:
/// the front fails in ways of its own.
fn act_error(tool: &str, mode: ActDelivery, result: &ToolCallResult) -> HelperError {
    let code = result.code().unwrap_or("");
    let error = |code: HelperErrorCode, words: &str| HelperError::new(code, words);
    if mode == ActDelivery::Foreground {
        if let Some(words) = front_failure(code, &result.text()) {
            return error(HelperErrorCode::ActionFailed, words);
        }
    }
    match code {
        "stale_element_token" | "invalid_element_token" | "conflicting_element_target" => error(
            HelperErrorCode::StaleRef,
            "That ref is from a snapshot this window has moved past. Take a new \
             computer_snapshot and use a ref from it.",
        ),
        "screenshot_context_missing" => error(HelperErrorCode::StaleRef, NO_CAPTURE),
        "px_frame_mismatch" => error(
            HelperErrorCode::StaleRef,
            "The window changed while the point was being placed. Take a new \
             computer_screenshot and use a point from it.",
        ),
        "window_not_found"
        | "window_target_not_found"
        | "window_id_not_found"
        | "owner_pid_mismatch"
        | "window_owner_pid_mismatch"
        | "window_target_mismatch"
        | "px_window_not_found" => error(HelperErrorCode::NoSuchWindow, "the window is gone"),
        "element_outside_target_window" => error(
            HelperErrorCode::OutOfTarget,
            "That element is not part of this window — a menu or panel of the application's \
             own, perhaps. Only what is inside the shared window can be acted on.",
        ),
        "point_outside_window" => error(
            HelperErrorCode::OutOfTarget,
            "That point is outside the window as it is now, so nothing was sent. Take a new \
             computer_screenshot and use a point from it.",
        ),
        "target_occluded" => error(
            HelperErrorCode::Occluded,
            "Another application's window is over that point, and the click would land on it \
             instead, so nothing was sent. Click an element by ref, or ask the user to move the \
             window that is in the way.",
        ),
        "off_space_or_ax_unresolved" => error(
            HelperErrorCode::Occluded,
            "The window is on another desktop (Space), or its contents cannot be reached right \
             now. Ask the user to bring it onto the current desktop.",
        ),
        "minimized_or_hidden_window" | "window_minimized" | "element_not_visible" => error(
            HelperErrorCode::Occluded,
            "The window is minimized or its application is hidden, so pointer and key input \
             cannot reach it. Such a window (computer_list_windows marks it minimized or hidden) \
             comes back with computer_restore — the user will see it — and then this can be \
             tried again. A click on an element by ref, or computer_set_value, may work as it \
             is.",
        ),
        "same_pid_keyboard_ambiguity" => error(
            HelperErrorCode::Occluded,
            "Its application has other windows open that the keys could reach instead, so no \
             keys are sent in the background. Use computer_set_value on the field, or a click \
             on an element by ref — or ask the user to close the application's other windows.",
        ),
        "popup_keyboard_grab" => error(
            HelperErrorCode::ActionFailed,
            "A pop-up of the application — a menu or a list — holds the keyboard, so the keys \
             were not sent. Choose from it or close it first, then try again.",
        ),
        "wm_chord_unavailable" => error(
            HelperErrorCode::ActionFailed,
            "The desktop's window manager takes that key combination for itself, so it was not \
             sent to the window.",
        ),
        // Refused in the background, and not for want of rights: the front
        // may take it, where the person allows it.
        "background_unavailable"
        | "background_occluded"
        | "background_pointer_failed"
        | "uinput_unavailable"
        | "SCREEN_SHARING_REQUIRES_FOREGROUND_HID" => error(
            HelperErrorCode::BackgroundUnavailable,
            &background_refusal(tool, result),
        ),
        // The front would be refused as well.
        "background_uipi_blocked" => error(HelperErrorCode::ActionFailed, HIGHER_RIGHTS),
        "input_delivery_unavailable" => error(
            HelperErrorCode::ActionFailed,
            "This window takes no typing from codeg: Windows can accept it without it ever \
             reaching the prompt, so it is not sent, in the background or at the front. Ask the \
             user to type it, or run the command another way.",
        ),
        "type_text_synthesis_budget_exceeded" => {
            let chunk = result
                .structured
                .as_ref()
                .and_then(|s| s.get("max_chunk_chars"))
                .and_then(Value::as_u64);
            error(
                HelperErrorCode::ActionFailed,
                &match chunk {
                    Some(n) => format!(
                        "That is more text than can be typed in one call here; nothing was typed. \
                         Send at most {n} characters at a time."
                    ),
                    None => "That is more text than can be typed in one call here; nothing was \
                             typed. Send it in smaller pieces."
                        .to_string(),
                },
            )
        }
        "type_text_incomplete" => error(
            HelperErrorCode::ActionFailed,
            "Only part of the text was typed. Take a new computer_snapshot to see what \
             arrived before typing the rest.",
        ),
        "input_busy" => error(
            HelperErrorCode::ActionFailed,
            "The window is busy with other input. Try again in a moment.",
        ),
        "set_value_unavailable" => error(
            HelperErrorCode::ActionFailed,
            "That element's value cannot be set directly here; nothing was changed. Type into it \
             with computer_type, or choose with clicks.",
        ),
        "element_bounds_unavailable" => error(
            HelperErrorCode::ActionFailed,
            "Where that element is cannot be read, so it was not clicked. Click a point on it \
             from a computer_screenshot, or an element inside it.",
        ),
        "ax_timeout" => error(
            HelperErrorCode::ActionFailed,
            "The application did not finish the action in time, so whether it went through \
             cannot be told — it may have. Read the window (computer_snapshot or \
             computer_screenshot) before doing it again.",
        ),
        "modified_pointer_unavailable" => error(
            HelperErrorCode::ActionFailed,
            "Keys cannot be held down through that pointer action on this desktop, so nothing \
             was sent. Do it without modifiers.",
        ),
        // Arguments codeg built and the driver does not take: a fault here,
        // not in what the agent asked.
        "invalid_arguments" => {
            tracing::error!(
                "the driver refused the {tool} codeg built: {}",
                result.text()
            );
            error(
                HelperErrorCode::ActionFailed,
                &format!(
                    "The driver did not take the {tool} as codeg sent it, so nothing was sent. \
                     That is a fault in codeg, not in the request — trying again will not help. \
                     Tell the user."
                ),
            )
        }
        "screen_recording_permission_denied" => {
            HelperError::permission_missing(OsPermission::ScreenRecording)
        }
        "permission_denied" | "accessibility_permission_denied" | "tcc_permission_denied" => {
            HelperError::permission_missing(OsPermission::Accessibility)
        }
        _ => {
            let text = result.text();
            let text: String = text.chars().take(300).collect();
            error(
                HelperErrorCode::ActionFailed,
                &if text.trim().is_empty() {
                    format!("The {tool} did not happen.")
                } else {
                    format!("The {tool} did not happen: {}", text.trim())
                },
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::computer::keys::{Chord, Key, Modifiers};

    fn facts(id: &str, elements: &[(u32, &str, bool)]) -> SnapshotFacts {
        SnapshotFacts {
            snapshot_id: id.into(),
            elements: elements
                .iter()
                .map(|(i, role, secret)| {
                    (
                        *i,
                        ElementFacts {
                            role: role.to_string(),
                            secret: *secret,
                            paste: false,
                            frame: None,
                        },
                    )
                })
                .collect(),
        }
    }

    /// A control named for pasting is not pressed — by a click or a key —
    /// whatever the grant: it would write the user's clipboard into the
    /// window. Scrolling over it is nothing of the kind.
    #[test]
    fn a_paste_control_is_not_pressed() {
        let mut book = SnapshotBook::default();
        let mut snapshot = facts("s00000001", &[(4, "AXMenuItem", false)]);
        if let Some(paste) = snapshot.elements.get_mut(&4) {
            paste.paste = true;
        }
        book.record(1, 10, Some(snapshot));
        let at = DriverTarget::Element(element("s00000001", 4));
        let click = WindowAction::Click {
            at: at.clone(),
            button: PointerButton::Left,
            count: 1,
            modifiers: Modifiers::default(),
        };
        let key = WindowAction::Key {
            element: Some(element("s00000001", 4)),
            chord: Chord {
                key: Key::Return,
                modifiers: Modifiers::default(),
            },
        };
        for pressed in [click, key] {
            assert_eq!(
                book.check(1, 10, &pressed, None, false).unwrap_err().code,
                HelperErrorCode::PasteRefused
            );
        }
        let scroll = WindowAction::Scroll {
            at: Some(at),
            direction: crate::computer::types::ScrollDirection::Down,
            amount: 1,
            unit: crate::computer::types::ScrollUnit::Line,
        };
        assert!(book.check(1, 10, &scroll, None, false).is_ok());
    }

    fn element(id: &str, index: u32) -> ElementRef {
        ElementRef {
            snapshot_id: id.into(),
            index,
        }
    }

    /// An element's frame is told only from the snapshot the ref names, and
    /// only while that is still the window's latest.
    #[test]
    fn an_element_is_placed_by_its_own_snapshot() {
        let mut book = SnapshotBook::default();
        let mut first = facts("s00000001", &[(3, "AXButton", false)]);
        let frame = Rect {
            x: 10.0,
            y: 20.0,
            width: 30.0,
            height: 40.0,
        };
        first.elements.get_mut(&3).unwrap().frame = Some(frame);
        book.record(1, 10, Some(first));
        assert_eq!(book.frame(1, 10, &element("s00000001", 3)), Some(frame));
        assert_eq!(book.frame(1, 10, &element("s00000001", 4)), None);
        assert_eq!(book.frame(1, 11, &element("s00000001", 3)), None);
        book.record(1, 10, Some(facts("s00000002", &[(3, "AXButton", false)])));
        assert_eq!(book.frame(1, 10, &element("s00000001", 3)), None);
        assert_eq!(book.frame(1, 10, &element("s00000002", 3)), None);
    }

    /// A ref is good only against the window's latest snapshot, and only for
    /// an element that snapshot has; a newer snapshot, or none at all,
    /// makes it stale.
    #[test]
    fn a_ref_is_good_only_against_the_latest_snapshot() {
        let mut book = SnapshotBook::default();
        book.record(1, 10, Some(facts("s00000001", &[(3, "AXButton", false)])));
        let click = |e| WindowAction::Click {
            at: DriverTarget::Element(e),
            button: PointerButton::Left,
            count: 1,
            modifiers: Modifiers::default(),
        };
        assert!(book
            .check(1, 10, &click(element("s00000001", 3)), None, false)
            .is_ok());
        let code = |r: Result<(), HelperError>| r.unwrap_err().code;
        assert_eq!(
            code(book.check(1, 10, &click(element("s00000001", 4)), None, false)),
            HelperErrorCode::StaleRef
        );
        // The same id on another window is not that window's snapshot.
        assert_eq!(
            code(book.check(1, 11, &click(element("s00000001", 3)), None, false)),
            HelperErrorCode::StaleRef
        );
        book.record(1, 10, Some(facts("s00000002", &[(3, "AXButton", false)])));
        assert_eq!(
            code(book.check(1, 10, &click(element("s00000001", 3)), None, false)),
            HelperErrorCode::StaleRef
        );
        book.record(1, 10, None);
        assert_eq!(
            code(book.check(1, 10, &click(element("s00000002", 3)), None, false)),
            HelperErrorCode::StaleRef
        );
    }

    /// Text never goes into a secret field — by typing, by setting its value
    /// or by a character key — though it may be clicked, and a key that types
    /// nothing may be pressed on it.
    #[test]
    fn nothing_is_typed_into_a_secret_field() {
        let mut book = SnapshotBook::default();
        book.record(1, 10, Some(facts("s00000001", &[(2, "AXTextField", true)])));
        let pw = || element("s00000001", 2);
        for writes in [
            WindowAction::Type {
                element: pw(),
                text: "hunter2".into(),
                submit: false,
            },
            WindowAction::SetValue {
                element: pw(),
                value: "hunter2".into(),
            },
            WindowAction::Key {
                element: Some(pw()),
                chord: Chord {
                    key: Key::Char('h'),
                    modifiers: Modifiers::default(),
                },
            },
        ] {
            assert_eq!(
                book.check(1, 10, &writes, None, false).unwrap_err().code,
                HelperErrorCode::SecretField,
                "{writes:?}"
            );
        }
        for fine in [
            WindowAction::Click {
                at: DriverTarget::Element(pw()),
                button: PointerButton::Left,
                count: 1,
                modifiers: Modifiers::default(),
            },
            WindowAction::Key {
                element: Some(pw()),
                chord: Chord {
                    key: Key::Tab,
                    modifiers: Modifiers::default(),
                },
            },
        ] {
            assert!(book.check(1, 10, &fine, None, false).is_ok(), "{fine:?}");
        }
    }

    /// Safari's pop-up menus are not set by value — that path acts on
    /// Safari's front document, whichever window that is.
    #[test]
    fn a_safari_pop_up_is_not_set_by_value() {
        let mut book = SnapshotBook::default();
        book.record(1, 10, Some(facts("s00000001", &[(5, "AXPopUpButton", false)])));
        let set = WindowAction::SetValue {
            element: element("s00000001", 5),
            value: "Large".into(),
        };
        assert_eq!(
            book.check(1, 10, &set, Some("com.apple.Safari"), false)
                .unwrap_err()
                .code,
            HelperErrorCode::ActionFailed
        );
        assert!(book
            .check(1, 10, &set, Some("com.apple.TextEdit"), false)
            .is_ok());
        // An application codeg cannot name could be Safari.
        assert_eq!(
            book.check(1, 10, &set, None, false).unwrap_err().code,
            HelperErrorCode::ActionFailed
        );
    }

    /// Two halves of one action are only as certain as the less certain.
    #[test]
    fn a_pair_of_calls_is_as_sure_as_its_weaker_half() {
        use ActEffect::*;
        assert_eq!(weaker(Confirmed, Unverifiable), Unverifiable);
        assert_eq!(weaker(Confirmed, Confirmed), Confirmed);
        assert_eq!(weaker(Partial, Confirmed), Partial);
        assert_eq!(weaker(Unverifiable, SuspectedNoop), SuspectedNoop);
    }

    /// The book lets go of the oldest windows past its bound.
    #[test]
    fn the_book_is_bounded() {
        let mut book = SnapshotBook::default();
        for w in 0..(BOOK_WINDOWS as u64 + 5) {
            book.record(1, w, Some(facts("s00000001", &[])));
        }
        assert_eq!(book.windows.len(), BOOK_WINDOWS);
        assert!(!book.windows.contains_key(&(1, 0)));
        assert!(book.windows.contains_key(&(1, BOOK_WINDOWS as u64 + 4)));
    }

    /// The driver's result is read into the closed effect and route; a
    /// result that says nothing is "unverifiable", never "confirmed".
    #[test]
    fn a_result_says_no_more_than_the_driver_can_vouch_for() {
        let ok = |structured: Value| ToolCallResult {
            is_error: false,
            content: Vec::new(),
            structured: Some(structured),
        };
        let back = ActDelivery::Background;
        let act = action_result(
            "click",
            back,
            &ok(json!({"effect": "confirmed", "route": "accessibility",
                        "delivery": {"mode": "background"}, "evidence": [{"kind": "value_readback"}]})),
        )
        .unwrap();
        assert_eq!(act.effect, ActEffect::Confirmed);
        assert_eq!(act.route, Some(ActRoute::Accessibility));
        let vague = action_result("click", back, &ToolCallResult::default()).unwrap();
        assert_eq!(vague.effect, ActEffect::Unverifiable);
        let novel = action_result(
            "click",
            back,
            &ok(json!({"effect": "unverifiable", "route": "telepathy"})),
        )
        .unwrap();
        assert_eq!(novel.route, Some(ActRoute::Other));
        assert!(action_result("click", back, &ok(json!({"effect": "refused"}))).is_err());
        // A refusal answered without an error says why by code, and is read
        // as any refusal is.
        let occluded = action_result(
            "click",
            back,
            &ok(json!({"effect": "refused", "error": {"code": "target_occluded", "hint": "x"}})),
        )
        .unwrap_err();
        assert_eq!(occluded.code, HelperErrorCode::Occluded);
    }

    /// An element goes to the driver by its token alone — the snapshot's id
    /// and the element's index, as the driver writes them — and a delivery
    /// mode goes with every action whose tool takes one: all but macOS's
    /// `set_value`.
    #[test]
    fn the_driver_gets_only_what_its_tools_take() {
        let mut args = json!({"pid": 1, "window_id": 2});
        put_element(&mut args, &element("s0000002a", 7));
        assert_eq!(
            args,
            json!({"pid": 1, "window_id": 2, "element_token": "s0000002a:7"})
        );
        let set = WindowAction::SetValue {
            element: element("s0000002a", 7),
            value: "x".into(),
        };
        let click = WindowAction::Click {
            at: DriverTarget::Element(element("s0000002a", 7)),
            button: PointerButton::Left,
            count: 1,
            modifiers: Modifiers::default(),
        };
        assert!(!takes_delivery(&set, Platform::Mac));
        assert!(takes_delivery(&set, Platform::Windows));
        assert!(takes_delivery(&set, Platform::Linux));
        assert!(takes_delivery(&click, Platform::Mac));
    }

    /// The driver's refusals come back as the helper's codes, in the
    /// helper's words.
    #[test]
    fn refusals_are_read_by_code() {
        let refused = |structured: Value, text: &str| ToolCallResult {
            is_error: true,
            content: vec![json!({"type": "text", "text": text})],
            structured: Some(structured),
        };
        let cases = [
            (
                json!({"status": "refused", "refusal": {"code": "stale_element_token"}}),
                HelperErrorCode::StaleRef,
            ),
            (
                json!({"code": "same_pid_keyboard_ambiguity", "effect": "refused"}),
                HelperErrorCode::Occluded,
            ),
            (
                json!({"code": "element_outside_target_window", "effect": "refused"}),
                HelperErrorCode::OutOfTarget,
            ),
            (
                json!({"code": "background_unavailable", "effect": "refused"}),
                HelperErrorCode::BackgroundUnavailable,
            ),
            (
                json!({"code": "owner_pid_mismatch", "effect": "refused"}),
                HelperErrorCode::NoSuchWindow,
            ),
        ];
        let back = ActDelivery::Background;
        for (structured, want) in cases {
            let e = act_error("click", back, &refused(structured.clone(), "driver words"));
            assert_eq!(e.code, want, "{structured}");
            assert!(!e.message.contains("driver words"), "{}", e.message);
        }
        // Keys and typing refused in the background: a ref would not help,
        // so what still reaches the application is named instead — and a
        // Chromium window, by its class, is said to be one. A click is still
        // pointed at a ref. Whether the front may be tried is not the
        // helper's to say.
        let background = |tool: &str, class: &str| {
            let refusal = json!({"code": "background_unavailable", "target_class": class});
            let e = act_error(tool, back, &refused(refusal, "driver words"));
            assert_eq!(e.code, HelperErrorCode::BackgroundUnavailable);
            assert!(!e.message.contains("driver words"), "{}", e.message);
            assert!(!e.message.contains("front"), "{}", e.message);
            e.message
        };
        for tool in ["press_key", "type_text"] {
            let edge = background(tool, "Chrome_WidgetWin_1");
            assert!(edge.contains("computer_set_value"), "{edge}");
            assert!(edge.contains("Chromium"), "{edge}");
            let other = background(tool, "HwndWrapper[App;;1]");
            assert!(other.contains("computer_set_value"), "{other}");
            assert!(!other.contains("Chromium"), "{other}");
        }
        let click = background("click", "Chrome_WidgetWin_1");
        assert!(click.contains("element by ref"), "{click}");
        assert!(!click.contains("Chromium"), "{click}");
        // What the front would not help either is no background refusal.
        for code in ["background_uipi_blocked", "input_delivery_unavailable"] {
            let e = act_error("type_text", back, &refused(json!({ "code": code }), ""));
            assert_eq!(e.code, HelperErrorCode::ActionFailed, "{code}");
            assert!(e.message.contains("at the front"), "{}", e.message);
        }
        // A minimized window points at the way back where there is one.
        let minimized = act_error(
            "type_text",
            back,
            &refused(
                json!({"code": "minimized_or_hidden_window", "effect": "refused"}),
                "",
            ),
        );
        assert_eq!(minimized.code, HelperErrorCode::Occluded);
        assert!(minimized.message.contains("computer_restore"));
        let budget = act_error(
            "type_text",
            back,
            &refused(
                json!({"code": "type_text_synthesis_budget_exceeded", "max_chunk_chars": 2578}),
                "",
            ),
        );
        assert_eq!(budget.code, HelperErrorCode::ActionFailed);
        assert!(budget.message.contains("2578"));
        let other = act_error(
            "set_value",
            back,
            &refused(json!({"code": "tool_invocation_failed"}), "element is disabled"),
        );
        assert_eq!(other.code, HelperErrorCode::ActionFailed);
        assert!(other.message.contains("element is disabled"));
        // The driver with no capture of the window to aim by: nothing went
        // out, and the helper knows to give it one.
        let uncaptured = act_error(
            "click",
            back,
            &refused(
                json!({"code": "screenshot_context_missing"}),
                "Call get_window_state",
            ),
        );
        assert!(needs_capture(&uncaptured));
        assert!(!uncaptured.message.contains("get_window_state"));
        assert!(!needs_capture(&act_error(
            "click",
            back,
            &refused(json!({"code": "stale_element_token"}), ""),
        )));
        for (code, want) in [
            ("point_outside_window", HelperErrorCode::OutOfTarget),
            ("target_occluded", HelperErrorCode::Occluded),
            (
                "background_pointer_failed",
                HelperErrorCode::BackgroundUnavailable,
            ),
            ("popup_keyboard_grab", HelperErrorCode::ActionFailed),
            ("wm_chord_unavailable", HelperErrorCode::ActionFailed),
            ("set_value_unavailable", HelperErrorCode::ActionFailed),
            ("element_bounds_unavailable", HelperErrorCode::ActionFailed),
            (
                "modified_pointer_unavailable",
                HelperErrorCode::ActionFailed,
            ),
        ] {
            let e = act_error(
                "click",
                back,
                &refused(json!({ "code": code }), "driver words"),
            );
            assert_eq!(e.code, want, "{code}");
            assert!(!e.message.contains("driver words"), "{code}: {}", e.message);
        }
        // What may have happened is said to have perhaps happened.
        let late = act_error("click", back, &refused(json!({"code": "ax_timeout"}), ""));
        assert!(late.message.contains("may have"), "{}", late.message);
        let unverified = act_error(
            "click",
            back,
            &refused(
                json!({"code": "background_unavailable", "uia_status": "busy",
                       "effect": "unverifiable"}),
                "",
            ),
        );
        assert_eq!(unverified.code, HelperErrorCode::BackgroundUnavailable);
        assert!(
            unverified.message.contains("may have"),
            "{}",
            unverified.message
        );
        // Linux input that needs /dev/uinput, by code or by cause.
        for structured in [
            json!({"code": "uinput_unavailable"}),
            json!({"code": "background_unavailable", "cause": "uinput_unavailable"}),
        ] {
            let e = act_error("click", back, &refused(structured, ""));
            assert_eq!(e.code, HelperErrorCode::BackgroundUnavailable);
            assert!(e.message.contains("/dev/uinput"), "{}", e.message);
        }
        // Arguments the driver does not take are codeg's fault, said so.
        let bad = act_error(
            "set_value",
            back,
            &refused(
                json!({"status": "refused", "refusal": {"code": "invalid_arguments"}}),
                "",
            ),
        );
        assert_eq!(bad.code, HelperErrorCode::ActionFailed);
        assert!(bad.message.contains("fault in codeg"), "{}", bad.message);
    }

    /// The front fails in words of its own — a window that would not come
    /// forward, an application with more rights than codeg — and they are
    /// read as such only when the front was asked for. Only a failure the
    /// driver says came before any input went out is one to try again; one
    /// it found after (the window gone from the front once the click was
    /// sent) or does not place may have done what was asked.
    #[test]
    fn the_front_fails_in_its_own_words() {
        let failed = |code: Option<&str>, text: &str| ToolCallResult {
            is_error: true,
            content: vec![json!({"type": "text", "text": text})],
            structured: code.map(|code| json!({ "code": code })),
        };
        let front = ActDelivery::Foreground;
        let not_had = |e: &HelperError| {
            assert_eq!(e.code, HelperErrorCode::ActionFailed);
            assert!(e.message.contains("nothing was sent"), "{}", e.message);
            assert!(!e.message.contains("HWND"), "{}", e.message);
        };
        let lost = |e: &HelperError| {
            assert_eq!(e.code, HelperErrorCode::ActionFailed);
            assert!(e.message.contains("may have"), "{}", e.message);
            assert!(!e.message.contains("nothing was sent"), "{}", e.message);
            assert!(!e.message.contains("HWND"), "{}", e.message);
        };
        // The pinned driver's own words, before and after the input.
        for before in [
            "foreground_unavailable: Windows did not confirm exact target HWND 0x1 for type_text \
             within 500 ms (actual foreground HWND 0x2). Route the request through the \
             UIAccess-manifested cua-driver-uia worker; no input was sent.",
            "foreground_unavailable: Windows did not activate exact target HWND 0x1 (actual \
             foreground HWND 0x2); no mouse input was sent",
            "foreground_unavailable: exact target HWND 0x1 disappeared before mouse input could \
             be sent",
        ] {
            not_had(&act_error("click", front, &failed(None, before)));
        }
        let after = failed(
            None,
            "foreground_unavailable: exact target HWND 0x1 or a verified same-process post-action \
             window was not foreground after the click (actual foreground HWND 0x2)",
        );
        lost(&act_error("click", front, &after));
        lost(&act_error(
            "press_key",
            front,
            &failed(None, "foreground_unavailable: something new"),
        ));
        let mac = failed(
            Some("delivery_failed"),
            "press_key delivery failed: WindowServer rejected foreground HID activation",
        );
        not_had(&act_error("press_key", front, &mac));
        lost(&act_error(
            "press_key",
            front,
            &failed(
                Some("delivery_failed"),
                "press_key delivery failed: post rejected",
            ),
        ));
        // macOS's click at a point, by its own code: before the click when
        // it says so, and otherwise perhaps after.
        not_had(&act_error(
            "click",
            front,
            &failed(
                Some("foreground_unavailable"),
                "click failed: foreground HID delivery to window 5 was not possible: window 5 \
                 did not become focused for foreground HID delivery",
            ),
        ));
        lost(&act_error(
            "click",
            front,
            &failed(
                Some("foreground_unavailable"),
                "click failed: foreground HID delivery to window 5 was not possible: post failed",
            ),
        ));
        // Linux's window manager that did not answer in time.
        lost(&act_error(
            "press_key",
            front,
            &failed(
                Some("foreground_timeout"),
                "foreground_timeout: the window manager did not confirm activation",
            ),
        ));
        let rights = failed(None, "UIPI: target hwnd 0x1 is at High integrity");
        let e = act_error("type_text", front, &rights);
        assert!(e.message.contains("administrator"), "{}", e.message);
        // In the background the same words are the driver's own.
        let e = act_error("press_key", ActDelivery::Background, &mac);
        assert!(e.message.contains("WindowServer"), "{}", e.message);
    }

    /// At the front, keys and typing wait for the person's modifiers: none
    /// is sent while one is held, and the agent is told which. In the
    /// background the held keys do not matter, and are not even asked.
    #[test]
    fn keys_at_the_front_wait_for_held_modifiers() {
        let front = ActDelivery::Foreground;
        assert!(keys_free(front, || Some(Vec::new())).is_ok());
        let e = keys_free(front, || Some(vec!["Ctrl"])).unwrap_err();
        assert_eq!(e.code, HelperErrorCode::ActionFailed);
        assert!(
            e.message.contains("holding down Ctrl right now"),
            "{}",
            e.message
        );
        assert!(e.message.contains("nothing was sent"), "{}", e.message);
        let e = keys_free(front, || Some(vec!["Ctrl", "Shift", "the Windows key"])).unwrap_err();
        assert!(
            e.message.contains("Ctrl, Shift and the Windows key"),
            "{}",
            e.message
        );
        assert!(keys_free(ActDelivery::Background, || unreachable!("not asked")).is_ok());
        // Where the platform will not say, nothing goes at the front either.
        let e = keys_free(front, || None).unwrap_err();
        assert_eq!(e.code, HelperErrorCode::ActionFailed);
        assert!(e.message.contains("cannot tell"), "{}", e.message);
    }

    /// Only a point needs the window measured — and Screen Recording, to
    /// measure it by.
    #[test]
    fn a_point_needs_screen_recording_and_an_element_does_not() {
        let at_point = WindowAction::Click {
            at: DriverTarget::Point(WindowPoint {
                x: 1.0,
                y: 2.0,
                window_width: 100.0,
                window_height: 100.0,
            }),
            button: PointerButton::Left,
            count: 1,
            modifiers: Modifiers::default(),
        };
        assert!(permissions_for(&at_point).contains(&OsPermission::ScreenRecording));
        let at_element = WindowAction::SetValue {
            element: element("s00000001", 1),
            value: "x".into(),
        };
        assert_eq!(permissions_for(&at_element), &[OsPermission::Accessibility]);
    }
}
