//! The entire screen, shared as a whole: one picture of it, and pointer
//! actions at points on it.
//!
//! Sharing the screen does not lift the rules that hold for any window: codeg
//! itself and the applications on the blocklist are never seen nor touched.
//! Over the whole screen the helper judges that itself, window by window, at
//! the moment of the capture or the action, by the rules codeg hands it
//! ([`ScreenRules`]) — so a window that came up since codeg last looked is
//! judged too, not let through for want of having been listed. A window is
//! judged by its owner, as codeg judges a window it lists, and one whose
//! owner cannot be told an application the person could share — the menu
//! bar the system draws, the system's own agents — is judged as one that is
//! never shared. So is a window of the system's that shows what other
//! windows hold — an overview of every window, previews of them, other
//! applications' notifications ([`shows_others`]) — which codeg cannot
//! judge piece by piece; and the keys and corners that bring such an
//! overview up are kept out of reach (`keys::classify_for_screen`,
//! [`in_a_corner`]).
//!
//! Such a window is painted over in the picture, whatever is in front of it
//! and whatever layer it is on (a password manager's panel floats above the
//! windows an application list shows), with a margin for the edge the
//! pointer takes it by; and a point anywhere on what was painted over is
//! refused. What is refused is then exactly what the agent could not see.
//!
//! The windows come from the system itself, every layer of them and titled
//! or not: on macOS from the window server, on Windows from the window
//! manager's own list — before the picture is taken and again after, and a
//! picture is handed over only when the windows never shared stood still
//! across it: one moving, coming or going while it was taken could have been
//! caught where neither listing has it. A window nothing of shows (macOS:
//! drawn fully transparent) is no window here; one every click passes
//! through (Windows: a layered, click-through overlay) is painted over like
//! any other, and refuses no point — the click lands on what is under it,
//! judged on its own. An action goes only while the screen is as its
//! picture was taken: a point read off a picture of another size or scale
//! would land elsewhere than it was judged. Linux is not offered the screen.

use std::time::Duration;

use serde_json::{json, Value};

use super::driver_proc::DriverProc;
use super::ops::shrink_png;
#[cfg(any(target_os = "macos", windows))]
use crate::computer::agent::grantable;
use crate::computer::agent::Blocklist;
use crate::computer::protocol::{
    HelperError, HelperErrorCode, RawAct, RawCapture, ScreenGeometry, ScreenRules, WindowAction,
    WindowPoint,
};
use crate::computer::types::{ActEffect, PointerButton, Rect, ScrollDirection, ScrollUnit};

/// How long the driver may take to capture the whole screen.
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(60);

/// How long one pointer action on the screen may take, a drag's path aside.
const ACT_TIMEOUT: Duration = Duration::from_secs(30);

/// How many pictures are taken before a screen whose never-shared windows
/// keep moving is given up on.
const CAPTURE_ATTEMPTS: usize = 3;

/// How far past a window that is never shared the picture is painted over
/// and a point refused, in desktop units: the pointer takes a window by its
/// edge a little outside what it draws (to resize it) — on Windows by an
/// invisible border the frame the compositor reports leaves out, as wide as
/// the display is scaled.
#[cfg(windows)]
const EDGE: f64 = 16.0;
#[cfg(not(windows))]
const EDGE: f64 = 6.0;

/// One window on the screen, in desktop units, and whether the rules let it
/// be seen and touched.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScreenWindow {
    /// The system's own number for it, the same from one listing to the next.
    pub id: u64,
    pub bounds: Rect,
    pub allowed: bool,
    /// A click on it reaches it — false for an overlay every click passes
    /// through, which only hides what is under it.
    pub takes_clicks: bool,
}

impl ScreenWindow {
    /// What of the screen is this window's to keep from sight and touch:
    /// its frame and the edge around it ([`EDGE`]).
    fn reach(&self) -> Rect {
        Rect {
            x: self.bounds.x - EDGE,
            y: self.bounds.y - EDGE,
            width: self.bounds.width + 2.0 * EDGE,
            height: self.bounds.height + 2.0 * EDGE,
        }
    }
}

/// The windows on the screen, judged by `rules`.
pub async fn windows(rules: &ScreenRules) -> Result<Vec<ScreenWindow>, HelperError> {
    let blocklist = Blocklist::from_entries(&rules.blocklist);
    let me = rules.me.clone();
    #[cfg(target_os = "macos")]
    {
        tokio::task::spawn_blocking(move || {
            let mut apps: std::collections::HashMap<u32, crate::computer::protocol::RawApp> =
                Default::default();
            window_server_windows()
                .into_iter()
                .map(|(id, pid, layer, bounds)| {
                    let app = apps.entry(pid).or_insert_with(|| {
                        let started_at = crate::computer::procinfo::process_start(pid);
                        super::ops::identified(pid, started_at, "")
                    });
                    let allowed = !shows_others(app.bundle_id.as_deref(), layer)
                        && grantable(app, &me, &blocklist).is_ok();
                    // Whether clicks pass through cannot be told here: every
                    // window is taken to take them.
                    ScreenWindow {
                        id,
                        bounds,
                        allowed,
                        takes_clicks: true,
                    }
                })
                .collect()
        })
        .await
        .map_err(|e| HelperError::failed(format!("the screen's windows could not be read: {e}")))
    }
    #[cfg(windows)]
    {
        use crate::computer::protocol::{RawApp, RawWindow};
        tokio::task::spawn_blocking(move || {
            let listed = super::hwnd::screen_windows();
            let seen: Vec<(bool, bool)> = listed
                .iter()
                .map(|w| (shows_others(&w.class), !w.passes_clicks))
                .collect();
            let shown: Vec<RawWindow> = listed
                .into_iter()
                .map(|w| RawWindow {
                    window_id: w.id,
                    pid: w.pid,
                    title: String::new(),
                    bounds: w.frame,
                    on_screen: true,
                    minimized: Some(false),
                    hidden: None,
                    on_current_space: None,
                    z_index: None,
                    content: None,
                    app: RawApp {
                        pid: w.pid,
                        name: String::new(),
                        bundle_id: None,
                        path: None,
                        active: false,
                        started_at: None,
                    },
                })
                .collect();
            let stamps = shown
                .iter()
                .map(|w| crate::computer::procinfo::process_start(w.pid))
                .collect();
            super::ops::join_identified(shown, stamps)
                .into_iter()
                .zip(seen)
                .filter(|(w, _)| w.on_screen)
                .map(|(w, (overview, takes_clicks))| ScreenWindow {
                    id: w.window_id,
                    bounds: w.bounds,
                    allowed: !overview && grantable(&w.app, &me, &blocklist).is_ok(),
                    takes_clicks,
                })
                .collect()
        })
        .await
        .map_err(|e| HelperError::failed(format!("the screen's windows could not be read: {e}")))
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (me, blocklist);
        Err(HelperError::failed(
            "The entire screen is not offered on this system: share windows or applications \
             instead.",
        ))
    }
}

/// macOS: the window level the Dock keeps itself at.
#[cfg(target_os = "macos")]
const DOCK_LEVEL: i64 = 20;

/// macOS: the applications whose every window shows what other
/// applications' windows hold — Stage Manager's strip of them, and the
/// banners of every application's notifications.
#[cfg(target_os = "macos")]
const SHOWING_OTHERS: &[&str] = &["com.apple.WindowManager", "com.apple.notificationcenterui"];

/// macOS: whether a window of the application `bundle_id`, at `layer`,
/// shows what other applications' windows hold: one of [`SHOWING_OTHERS`],
/// or the Dock's away from its own level — where it draws every window at
/// once (Mission Control, an application's windows). The Dock at its level
/// is the Dock.
#[cfg(target_os = "macos")]
fn shows_others(bundle_id: Option<&str>, layer: i64) -> bool {
    match bundle_id {
        Some("com.apple.dock") => layer != DOCK_LEVEL,
        Some(id) => SHOWING_OTHERS.contains(&id),
        None => false,
    }
}

/// Windows: the window classes of the shell's views of other windows — Task
/// View and the window switcher (Windows 10's, and 11's), snapping's
/// suggestions, and the taskbar's previews.
#[cfg(windows)]
const OVERVIEW_CLASSES: &[&str] = &[
    "MultitaskingViewFrame",
    "XamlExplorerHostIslandWindow",
    "TaskListThumbnailWnd",
];

/// Windows: whether a window of class `class` shows what other windows hold
/// ([`OVERVIEW_CLASSES`]).
#[cfg(windows)]
fn shows_others(class: &str) -> bool {
    OVERVIEW_CLASSES.contains(&class)
}

/// macOS: how near a corner of the screen a point is refused, in desktop
/// points — the pointer arriving in a corner sets off what the person set it
/// to (Mission Control, locking the screen, sleeping the display).
#[cfg(target_os = "macos")]
const CORNER: f64 = 8.0;

/// Whether a point on the screen, in desktop units, is in one of its
/// corners ([`CORNER`]). macOS only: elsewhere a corner does nothing of the
/// kind.
fn in_a_corner(x: f64, y: f64) -> bool {
    #[cfg(target_os = "macos")]
    {
        let Some(screen) = main_display() else {
            // Where the screen is cannot be told: no corner can be ruled
            // out.
            return true;
        };
        let near = |v: f64, edge: f64| (v - edge).abs() < CORNER;
        let (left, top) = (screen.x, screen.y);
        let (right, bottom) = (screen.x + screen.width, screen.y + screen.height);
        (near(x, left) || near(x, right)) && (near(y, top) || near(y, bottom))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (x, y);
        false
    }
}

/// macOS: the main display's frame, in desktop points — the screen the
/// driver's picture is of.
#[cfg(target_os = "macos")]
fn main_display() -> Option<Rect> {
    #[repr(C)]
    struct CgRect {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    }
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGMainDisplayID() -> u32;
        fn CGDisplayBounds(display: u32) -> CgRect;
    }
    // SAFETY: plain queries; a display that has gone answers an empty frame.
    let frame = unsafe { CGDisplayBounds(CGMainDisplayID()) };
    let rect = Rect {
        x: frame.x,
        y: frame.y,
        width: frame.width,
        height: frame.height,
    };
    (!rect.is_empty()).then_some(rect)
}

/// Every window on the screen, any layer, as the window server lists it —
/// its number, its owner, its layer and its frame in desktop points — but
/// the ones drawn fully transparent.
#[cfg(target_os = "macos")]
fn window_server_windows() -> Vec<(u64, u32, i64, Rect)> {
    use core_foundation::array::{CFArray, CFArrayRef};
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::number::CFNumber;
    use core_foundation::string::CFString;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGWindowListCopyWindowInfo(option: u32, relative_to_window: u32) -> CFArrayRef;
    }
    const ON_SCREEN_ONLY: u32 = 1 << 0;
    const EXCLUDE_DESKTOP_ELEMENTS: u32 = 1 << 4;

    // SAFETY: a plain query; returns a +1 array, or null.
    let raw = unsafe { CGWindowListCopyWindowInfo(ON_SCREEN_ONLY | EXCLUDE_DESKTOP_ELEMENTS, 0) };
    if raw.is_null() {
        return Vec::new();
    }
    // SAFETY: the +1 array from above, released by the wrapper.
    let list: CFArray<CFDictionary<CFString, CFType>> =
        unsafe { CFArray::wrap_under_create_rule(raw) };
    let number = |dict: &CFDictionary<CFString, CFType>, key: &'static str| {
        dict.find(CFString::from_static_string(key))
            .and_then(|v| v.downcast::<CFNumber>())
            .and_then(|n| n.to_f64())
    };
    list.iter()
        .filter_map(|dict| {
            let pid = number(&dict, "kCGWindowOwnerPID")? as u32;
            if number(&dict, "kCGWindowAlpha").is_some_and(|alpha| alpha <= 0.0) {
                return None;
            }
            let layer = number(&dict, "kCGWindowLayer").unwrap_or(0.0) as i64;
            let id = number(&dict, "kCGWindowNumber")? as u64;
            let bounds = dict
                .find(CFString::from_static_string("kCGWindowBounds"))
                .and_then(|v| v.downcast::<CFDictionary>())?;
            // SAFETY: the window server's bounds dictionary has CFString keys
            // and CFNumber values.
            let bounds: CFDictionary<CFString, CFType> =
                unsafe { CFDictionary::wrap_under_get_rule(bounds.as_concrete_TypeRef()) };
            let rect = Rect {
                x: number(&bounds, "X")?,
                y: number(&bounds, "Y")?,
                width: number(&bounds, "Width")?,
                height: number(&bounds, "Height")?,
            };
            (!rect.is_empty()).then_some((id, pid, layer, rect))
        })
        .collect()
}

/// The entire screen, every window `rules` do not allow painted over, shrunk
/// to `max_dimension` — taken again while the windows never shared will not
/// stand still across it (see the module note).
pub async fn capture(
    driver: &DriverProc,
    rules: &ScreenRules,
    max_dimension: Option<u32>,
) -> Result<RawCapture, HelperError> {
    for _ in 0..CAPTURE_ATTEMPTS {
        let before = windows(rules).await?;
        let picture = take_picture(driver).await?;
        let after = windows(rules).await?;
        if refused(&before) != refused(&after) {
            continue;
        }
        let windows: Vec<ScreenWindow> = before.into_iter().chain(after).collect();
        return paint_picture(picture, windows, max_dimension).await;
    }
    Err(HelperError::failed(
        "windows that are never shared kept moving, coming or going while the screen was \
         being captured, so no picture was handed over — try again in a moment",
    ))
}

/// What the driver's picture of the screen holds: the PNG, and the screen's
/// size in desktop units.
struct Picture {
    png_base64: String,
    screen_width: f64,
    screen_height: f64,
}

/// The windows `rules` refuse, by number and frame, in one order: what must
/// stand still across a picture.
fn refused(windows: &[ScreenWindow]) -> Vec<(u64, [u64; 4])> {
    let mut out: Vec<(u64, [u64; 4])> = windows
        .iter()
        .filter(|w| !w.allowed)
        .map(|w| {
            let b = w.bounds;
            (
                w.id,
                [
                    b.x.to_bits(),
                    b.y.to_bits(),
                    b.width.to_bits(),
                    b.height.to_bits(),
                ],
            )
        })
        .collect();
    out.sort_unstable();
    out
}

/// The driver's picture of the screen, as it is.
async fn take_picture(driver: &DriverProc) -> Result<Picture, HelperError> {
    let result = driver
        .call("get_desktop_state", json!({}), CAPTURE_TIMEOUT)
        .await?;
    if result.is_error {
        return Err(super::ops::tool_error("get_desktop_state", &result));
    }
    let said = result.structured.clone().unwrap_or(Value::Null);
    let number = |key: &str| {
        said.get(key)
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite() && *n > 0.0)
    };
    let (Some(screen_width), Some(screen_height)) =
        (number("screen_width"), number("screen_height"))
    else {
        return Err(HelperError::failed(
            "the screen capture came back without the screen's size",
        ));
    };
    let Some((data, mime)) = result.image() else {
        return Err(HelperError::failed(
            "the screen capture came back without an image",
        ));
    };
    if mime != "image/png" {
        return Err(HelperError::failed(format!(
            "the screen capture came back as {mime}"
        )));
    }
    Ok(Picture {
        png_base64: data.to_string(),
        screen_width,
        screen_height,
    })
}

/// `picture`, every one of `windows` the rules refuse painted over, shrunk to
/// `max_dimension`.
async fn paint_picture(
    picture: Picture,
    windows: Vec<ScreenWindow>,
    max_dimension: Option<u32>,
) -> Result<RawCapture, HelperError> {
    let Picture {
        png_base64,
        screen_width,
        screen_height,
    } = picture;
    let masked = tokio::task::spawn_blocking(move || {
        let painted = paint_over(&png_base64, &windows, screen_width)?;
        shrink_png(&painted, max_dimension)
    })
    .await
    .map_err(|e| HelperError::failed(format!("the screen capture could not be prepared: {e}")))?
    .map_err(|e| HelperError::failed(format!("the screen capture could not be prepared: {e}")))?;
    Ok(RawCapture {
        png_base64: masked.png_base64,
        width: masked.width,
        height: masked.height,
        native_width: masked.native_width,
        native_height: masked.native_height,
        full_size: true,
        window_bounds: Rect {
            x: 0.0,
            y: 0.0,
            width: screen_width,
            height: screen_height,
        },
        title: None,
    })
}

/// Paint every window not allowed over in the PNG, at its frame scaled from
/// desktop units to the picture's pixels (`screen_width` units across).
fn paint_over(
    png_base64: &str,
    windows: &[ScreenWindow],
    screen_width: f64,
) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use image::ImageFormat;

    let bytes = STANDARD
        .decode(png_base64)
        .map_err(|e| format!("not base64: {e}"))?;
    let mut image = image::load_from_memory_with_format(&bytes, ImageFormat::Png)
        .map_err(|e| format!("not a PNG: {e}"))?
        .to_rgba8();
    let ratio = f64::from(image.width()) / screen_width;
    let (width, height) = (image.width(), image.height());
    for window in windows.iter().filter(|w| !w.allowed) {
        let reach = window.reach();
        let clamp = |v: f64, max: u32| (v.max(0.0) as u32).min(max);
        let left = clamp((reach.x * ratio).floor(), width);
        let top = clamp((reach.y * ratio).floor(), height);
        let right = clamp(((reach.x + reach.width) * ratio).ceil(), width);
        let bottom = clamp(((reach.y + reach.height) * ratio).ceil(), height);
        for y in top..bottom {
            for x in left..right {
                image.put_pixel(x, y, image::Rgba([24, 24, 27, 255]));
            }
        }
    }
    let mut out = std::io::Cursor::new(Vec::new());
    image
        .write_to(&mut out, ImageFormat::Png)
        .map_err(|e| format!("png encoding failed: {e}"))?;
    Ok(STANDARD.encode(out.into_inner()))
}

/// Where a point of the picture goes: to the driver — on macOS in the
/// picture's own pixels, which the driver reads against its own picture of
/// the screen; elsewhere in the screen's own pixels — and, in desktop units,
/// where that lands on the screen. Whole pixels, as the driver takes them.
fn landing(point: &WindowPoint, scale: f64) -> Landing {
    if cfg!(target_os = "macos") {
        let (x, y) = (point.x.floor(), point.y.floor());
        Landing {
            driver: (x, y),
            screen: (x / scale, y / scale),
        }
    } else {
        let (x, y) = ((point.x / scale).floor(), (point.y / scale).floor());
        Landing {
            driver: (x, y),
            screen: (x, y),
        }
    }
}

/// See [`landing`].
#[derive(Debug, Clone, Copy, PartialEq)]
struct Landing {
    driver: (f64, f64),
    screen: (f64, f64),
}

/// Whether a point on the screen, in desktop units, is clear of every window
/// the rules do not allow that a click could reach: of what the picture
/// paints over, whatever is in front of it. A click through an overlay that
/// passes every click lands on what is under it, judged on its own.
fn lands_allowed(windows: &[ScreenWindow], (x, y): (f64, f64)) -> bool {
    windows
        .iter()
        .filter(|w| !w.allowed && w.takes_clicks)
        .all(|w| {
            let r = w.reach();
            !(x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height)
        })
}

/// Whether the screen is still as `geometry` says the picture was taken: the
/// same size, at the same scale. macOS only, where the driver reads the
/// point off a picture of the screen as it is at the moment of the action;
/// elsewhere the point goes to the driver in the screen's own pixels, the
/// units it was judged in.
fn same_screen(geometry: &ScreenGeometry) -> bool {
    #[cfg(target_os = "macos")]
    {
        let Some((screen, scale)) = main_display_now() else {
            return false;
        };
        (screen.width - geometry.width).abs() < 0.5
            && (screen.height - geometry.height).abs() < 0.5
            && (scale - geometry.scale).abs() < 0.01
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = geometry;
        true
    }
}

/// macOS: the main display's frame in desktop points, and its pixels to a
/// point as the driver reckons them — its picture's width over its width in
/// points, and 1 where the picture is no wider.
#[cfg(target_os = "macos")]
fn main_display_now() -> Option<(Rect, f64)> {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGMainDisplayID() -> u32;
        fn CGDisplayCopyDisplayMode(display: u32) -> *mut std::ffi::c_void;
        fn CGDisplayModeGetPixelWidth(mode: *mut std::ffi::c_void) -> usize;
        fn CGDisplayModeRelease(mode: *mut std::ffi::c_void);
    }
    let screen = main_display()?;
    // SAFETY: plain queries; the mode is released once, and a display that
    // has gone answers no mode.
    let pixels = unsafe {
        let mode = CGDisplayCopyDisplayMode(CGMainDisplayID());
        if mode.is_null() {
            return None;
        }
        let pixels = CGDisplayModeGetPixelWidth(mode);
        CGDisplayModeRelease(mode);
        pixels
    } as f64;
    let scale = if pixels > screen.width {
        pixels / screen.width
    } else {
        1.0
    };
    Some((screen, scale))
}

/// A click, a drag or a scroll on the screen at points in its picture's own
/// pixels — `scale` of them to a desktop unit, as the picture was taken —
/// as real input at the front, refused where any point would land on what
/// the rules do not allow. `ready` is asked just before it goes.
pub async fn act(
    driver: &DriverProc,
    rules: &ScreenRules,
    action: &WindowAction,
    geometry: ScreenGeometry,
    ready: impl Fn() -> Result<(), HelperError>,
) -> Result<RawAct, HelperError> {
    let points = action.points();
    let scale = geometry.scale;
    if points.is_empty() || !(scale.is_finite() && scale > 0.0) {
        return Err(HelperError::new(
            HelperErrorCode::BadRequest,
            "an action on the screen is at a point of its picture",
        ));
    }
    if !same_screen(&geometry) {
        return Err(HelperError::new(
            HelperErrorCode::StaleRef,
            "The screen changed since that screenshot — its size or its scaling — so a point \
             read off it would not land where it was read, and nothing was sent. Take a new \
             computer_screenshot of d1 and use a point from it.",
        ));
    }
    let landings: Vec<Landing> = points.iter().map(|p| landing(p, scale)).collect();
    if landings.iter().any(|l| in_a_corner(l.screen.0, l.screen.1)) {
        return Err(HelperError::new(
            HelperErrorCode::OutOfTarget,
            "That point is in a corner of the screen, where the pointer arriving sets off what \
             the user set the corner to do — showing every window, locking the screen — so \
             nothing was sent. Pick a point away from the corners.",
        ));
    }
    let windows = windows(rules).await?;
    if landings.iter().any(|l| !lands_allowed(&windows, l.screen)) {
        return Err(HelperError::new(
            HelperErrorCode::OutOfTarget,
            "That point is on a part of the screen that is never shared — a window of codeg's \
             own, of an application on the user's never-share list, or of the system's that \
             no application owns — which sharing the screen does not reach, so nothing was \
             sent. Take a new screenshot: those parts are painted over in it.",
        ));
    }
    let button = |button: &PointerButton| match button {
        PointerButton::Left => "left",
        PointerButton::Right => "right",
        PointerButton::Middle => "middle",
    };
    let (tool, args, timeout) = match action {
        WindowAction::Click {
            at: crate::computer::protocol::DriverTarget::Point(p),
            button: b,
            count,
            modifiers,
        } => {
            let (x, y) = landing(p, scale).driver;
            let mut args = json!({
                "scope": "desktop",
                "x": x,
                "y": y,
                "button": button(b),
                "count": count,
            });
            let names = modifiers.driver_names(crate::computer::keys::Platform::current());
            if !names.is_empty() {
                args["modifier"] = json!(names);
            }
            ("click", args, ACT_TIMEOUT)
        }
        WindowAction::Drag {
            from,
            to,
            button: b,
            modifiers,
            duration_ms,
        } => {
            let (from_x, from_y) = landing(from, scale).driver;
            let (to_x, to_y) = landing(to, scale).driver;
            let mut args = json!({
                "scope": "desktop",
                "from_x": from_x,
                "from_y": from_y,
                "to_x": to_x,
                "to_y": to_y,
                "button": button(b),
                "duration_ms": duration_ms,
            });
            let names = modifiers.driver_names(crate::computer::keys::Platform::current());
            if !names.is_empty() {
                args["modifier"] = json!(names);
            }
            let timeout = ACT_TIMEOUT + Duration::from_millis(u64::from(*duration_ms));
            ("drag", args, timeout)
        }
        WindowAction::Scroll {
            at: Some(crate::computer::protocol::DriverTarget::Point(p)),
            direction,
            amount,
            unit,
        } => (
            "scroll",
            json!({
                "scope": "desktop",
                "x": landing(p, scale).driver.0,
                "y": landing(p, scale).driver.1,
                "direction": match direction {
                    ScrollDirection::Up => "up",
                    ScrollDirection::Down => "down",
                    ScrollDirection::Left => "left",
                    ScrollDirection::Right => "right",
                },
                "by": match unit {
                    ScrollUnit::Line => "line",
                    ScrollUnit::Page => "page",
                },
                "amount": (*amount).clamp(1, crate::computer::types::MAX_SCROLL_AMOUNT),
            }),
            ACT_TIMEOUT,
        ),
        _ => {
            return Err(HelperError::new(
                HelperErrorCode::BadRequest,
                "the screen takes a click, a drag or a scroll at a point",
            ))
        }
    };
    ready()?;
    let result = driver.call(tool, args, timeout).await?;
    if result.is_error {
        return Err(HelperError::new(
            HelperErrorCode::ActionFailed,
            super::ops::tool_error(tool, &result).message,
        ));
    }
    Ok(RawAct {
        effect: ActEffect::Unverifiable,
        route: None,
        submitted: None,
        submit_note: None,
        element_frame: None,
        window_frame: None,
        clipboard: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window(x: f64, y: f64, w: f64, h: f64, allowed: bool) -> ScreenWindow {
        ScreenWindow {
            id: (x + y * 10_000.0) as u64,
            bounds: Rect {
                x,
                y,
                width: w,
                height: h,
            },
            allowed,
            takes_clicks: true,
        }
    }

    fn point(x: f64, y: f64) -> WindowPoint {
        WindowPoint {
            x,
            y,
            window_width: 2000.0,
            window_height: 1000.0,
        }
    }

    /// Whether a point of a picture at twice the desktop's units lands clear.
    fn clear(windows: &[ScreenWindow], x: f64, y: f64) -> bool {
        lands_allowed(windows, landing(&point(x, y), 2.0).screen)
    }

    /// The system's views of other windows are never seen nor touched over
    /// the entire screen; the Dock at its own level is the Dock.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_systems_views_of_other_windows_are_never_shared() {
        assert!(!shows_others(Some("com.apple.dock"), DOCK_LEVEL));
        assert!(shows_others(Some("com.apple.dock"), 25));
        assert!(shows_others(Some("com.apple.WindowManager"), 0));
        assert!(shows_others(Some("com.apple.notificationcenterui"), 23));
        assert!(!shows_others(Some("com.apple.finder"), 0));
        assert!(!shows_others(None, 0));
    }

    /// A point anywhere a refused window reaches is refused — whatever is
    /// in front of it there, as the picture paints it over whatever is —
    /// and its edge with it; anywhere else it goes.
    #[test]
    fn a_point_is_refused_wherever_a_refused_window_reaches() {
        // An allowed editor over a refused vault, and a full-screen layer of
        // an allowed application (the Dock keeps one) over both.
        let windows = [
            window(0.0, 0.0, 2000.0, 1000.0, true),
            window(100.0, 100.0, 200.0, 200.0, true),
            window(0.0, 0.0, 400.0, 400.0, false),
        ];
        assert!(!clear(&windows, 300.0, 300.0));
        assert!(!clear(&windows, 100.0, 100.0));
        // Just past the vault's right edge, within the edge it is taken by.
        assert!(!clear(&windows, 2.0 * (400.0 + EDGE - 1.0), 20.0));
        assert!(clear(&windows, 2.0 * (400.0 + EDGE + 1.0), 20.0));
        assert!(clear(&windows, 1000.0, 1000.0));
        // An overlay every click passes through refuses no point.
        let overlay = [ScreenWindow {
            takes_clicks: false,
            ..window(0.0, 0.0, 2000.0, 1000.0, false)
        }];
        assert!(clear(&overlay, 300.0, 300.0));
    }

    /// A picture is handed over only when the windows never shared stood
    /// still across it: one moved, came or went in between is caught.
    #[test]
    fn the_never_shared_windows_must_stand_still_across_a_picture() {
        let vault = window(0.0, 0.0, 400.0, 400.0, false);
        let editor = window(500.0, 0.0, 400.0, 400.0, true);
        let moved = ScreenWindow {
            bounds: Rect {
                x: 10.0,
                ..vault.bounds
            },
            ..vault
        };
        assert_eq!(refused(&[vault, editor]), refused(&[editor, vault]));
        // An allowed window moving is no matter: the refused ones are
        // painted over whatever is in front of them.
        let editor_moved = ScreenWindow {
            bounds: Rect {
                x: 600.0,
                ..editor.bounds
            },
            ..editor
        };
        assert_eq!(refused(&[vault, editor]), refused(&[vault, editor_moved]));
        assert_ne!(refused(&[vault, editor]), refused(&[moved, editor]));
        assert_ne!(refused(&[vault, editor]), refused(&[editor]));
        assert_ne!(refused(&[editor]), refused(&[editor, vault]));
    }

    /// A point goes to the driver in the picture's pixels on macOS, which
    /// reads it against its own picture, and in the screen's own pixels
    /// elsewhere — whole ones, judged where they land.
    #[test]
    fn a_point_goes_where_it_is_judged() {
        let l = landing(&point(201.7, 99.2), 2.0);
        if cfg!(target_os = "macos") {
            assert_eq!(l.driver, (201.0, 99.0));
            assert_eq!(l.screen, (100.5, 49.5));
        } else {
            assert_eq!(l.driver, (100.0, 49.0));
            assert_eq!(l.screen, (100.0, 49.0));
        }
    }
}
