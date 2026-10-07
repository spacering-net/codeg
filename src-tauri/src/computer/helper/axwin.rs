//! What the helper asks of Accessibility itself, rather than of the driver:
//! which windows are minimized, and which applications hidden (⌘H) — and the
//! one change it makes to a window on its own, putting it back on the screen.
//!
//! The driver's window list does not say which windows are minimized, nor
//! whose application is hidden. To it such a window is only off screen — as
//! are the hidden windows every application keeps (a main window closed to
//! the menu bar, a panel made ahead of time), which nobody means to share and
//! codeg leaves out of its lists. The application's accessibility interface
//! tells them apart: it says whether the application is hidden (`AXHidden`),
//! and lists the windows a person can bring up, minimized ones among them,
//! each saying whether it is (`AXMinimized`); ordered-out windows are not in
//! it at all. Nor has the driver a call that restores a window, or shows a
//! hidden application.
//!
//! Only asked once a process started for the purpose has found Accessibility
//! granted to the helper (see `HelperState::permissions`): a process keeps
//! the first "not granted" it hears for the rest of its life, and this one
//! would go on hearing it after the person had said yes. Every question goes
//! to another application and waits for its answer, so each is bounded
//! ([`TIMEOUT`]) and asked off the async runtime.

use std::collections::{BTreeSet, HashMap};

use super::ops::AppWindows;
use std::sync::OnceLock;

use core_foundation::array::CFArray;
use core_foundation::base::{CFGetTypeID, CFType, CFTypeID, CFTypeRef, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::number::CFNumber;
use core_foundation::string::{CFString, CFStringRef};

type AXError = i32;
const AX_SUCCESS: AXError = 0;
const AX_FAILURE: AXError = -25200;
const AX_NO_VALUE: AXError = -25212;

/// How long one question to an application may take before it counts as no
/// answer. A busy application answers well within it; a hung one would
/// otherwise hold each question for the system's six seconds.
const TIMEOUT: f32 = 0.5;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXUIElementCreateApplication(pid: libc::pid_t) -> CFTypeRef;
    fn AXUIElementCopyAttributeValue(
        element: CFTypeRef,
        attribute: CFStringRef,
        value: *mut CFTypeRef,
    ) -> AXError;
    fn AXUIElementSetAttributeValue(
        element: CFTypeRef,
        attribute: CFStringRef,
        value: CFTypeRef,
    ) -> AXError;
    fn AXUIElementSetMessagingTimeout(element: CFTypeRef, seconds: f32) -> AXError;
    fn AXUIElementGetTypeID() -> CFTypeID;
}

/// What each application says of its windows: for each of `listed`, whether
/// it is hidden and which of its windows are minimized; for each of `maybe`,
/// whether it is hidden — and its windows only if it is. An application that
/// would not answer (quit, hung, not an application) is left out.
pub async fn window_states(
    listed: BTreeSet<u32>,
    maybe: BTreeSet<u32>,
) -> HashMap<u32, AppWindows> {
    tokio::task::spawn_blocking(move || {
        let mut said = HashMap::new();
        for pid in listed.union(&maybe) {
            let Some(app) = application(*pid) else {
                continue;
            };
            let hidden = flag(&app, "AXHidden");
            if !listed.contains(pid) && hidden != Some(true) {
                continue;
            }
            let Ok(windows) = windows(&app) else {
                continue;
            };
            let minimized = windows
                .iter()
                .filter_map(|w| Some((window_number(w)?, flag(w, "AXMinimized"))))
                .collect();
            said.insert(*pid, AppWindows { hidden, minimized });
        }
        said
    })
    .await
    .unwrap_or_default()
}

/// Why a window is off the screen, as far as Accessibility tells.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutOfSight {
    Minimized,
    /// Its application is hidden (⌘H).
    AppHidden,
}

/// Whether `pid`'s window `window_id` is minimized or its application
/// hidden; `None` when it is neither, or that cannot be told.
pub async fn out_of_sight(pid: u32, window_id: u64) -> Option<OutOfSight> {
    tokio::task::spawn_blocking(move || {
        let app = application(pid)?;
        if flag(&app, "AXHidden") == Some(true) {
            return Some(OutOfSight::AppHidden);
        }
        let window = windows(&app)
            .ok()?
            .into_iter()
            .find(|w| window_number(w) == Some(window_id))?;
        (flag(&window, "AXMinimized") == Some(true)).then_some(OutOfSight::Minimized)
    })
    .await
    .ok()
    .flatten()
}

/// The windows `pid`'s application names as its focused one and as its
/// main one, by window id: what it brings forward when it is activated.
/// Each `None` where it names none, or would not say.
pub async fn focused_and_main(pid: u32) -> (Option<u64>, Option<u64>) {
    tokio::task::spawn_blocking(move || {
        let Some(app) = application(pid) else {
            return (None, None);
        };
        // SAFETY: a pure query.
        let element_type = unsafe { AXUIElementGetTypeID() };
        let named = |name: &'static str| {
            let window = attribute(&app, name).ok()?;
            // SAFETY: a live object, only asked its type.
            if unsafe { CFGetTypeID(window.as_CFTypeRef()) } != element_type {
                return None;
            }
            window_number(&window)
        };
        (named("AXFocusedWindow"), named("AXMainWindow"))
    })
    .await
    .unwrap_or((None, None))
}

/// What Accessibility says of a menu command before it is chosen: where its
/// first title sits on the menu bar — `0` is the Apple menu, `1` the
/// application menu — whether every title on the way was found, once each,
/// and the command's keyboard shortcut, as a key and the menu's modifier
/// mask, when it has one.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MenuTarget {
    pub bar_index: Option<usize>,
    pub reached: bool,
    pub shortcut: Option<(String, i64)>,
}

/// The longest the walk through an application's menus may take, however
/// many items they hold: each question is bounded on its own ([`TIMEOUT`]),
/// and this bounds them all.
const MENU_WALK: std::time::Duration = std::time::Duration::from_secs(3);

/// The titles of the first two items of `pid`'s menu bar — the Apple menu
/// and the application menu — as the menu bar has them now; `None` when it
/// would not say, or gave one a tree row could not be matched by: empty
/// (the driver writes no title then), or with a quote or a line break in it.
pub async fn protected_menu_titles(pid: u32) -> Option<[String; 2]> {
    tokio::task::spawn_blocking(move || {
        let app = application(pid)?;
        let bar = attribute(&app, "AXMenuBar").ok()?;
        bound(&bar);
        let items = elements(&bar, "AXChildren").ok()?;
        let title = |item: &CFType| {
            attribute(item, "AXTitle")
                .ok()
                .and_then(|v| v.downcast_into::<CFString>())
                .map(|t| t.to_string().trim().to_string())
                .filter(|t| !t.is_empty() && !t.contains(['"', '\n', '\r']))
        };
        Some([title(items.first()?)?, title(items.get(1)?)?])
    })
    .await
    .ok()
    .flatten()
}

/// The mask bit that says a menu shortcut is pressed without ⌘
/// (`kAXMenuItemModifierNoCommand`).
pub const MENU_NO_COMMAND: i64 = 8;

/// Follow `path` through `pid`'s menus by title, as the driver will to
/// choose it — without choosing anything: AppKit lists a closed menu's items
/// too. A title met more than once, or not at all, stops the walk there.
pub async fn menu_target(pid: u32, path: Vec<String>) -> MenuTarget {
    tokio::task::spawn_blocking(move || menu_target_now(pid, &path))
        .await
        .unwrap_or_default()
}

fn menu_target_now(pid: u32, path: &[String]) -> MenuTarget {
    let deadline = std::time::Instant::now() + MENU_WALK;
    let mut out = MenuTarget::default();
    let Some(app) = application(pid) else {
        return out;
    };
    let Ok(bar) = attribute(&app, "AXMenuBar") else {
        return out;
    };
    bound(&bar);
    let Some((first, rest)) = path.split_first() else {
        return out;
    };
    let items = elements(&bar, "AXChildren").unwrap_or_default();
    let Some(index) = only_titled(&items, first, deadline) else {
        return out;
    };
    out.bar_index = Some(index);
    let mut current = items[index].clone();
    for title in rest {
        let children = menu_children(&current, deadline);
        let Some(next) = only_titled(&children, title, deadline) else {
            return out;
        };
        current = children[next].clone();
    }
    if std::time::Instant::now() >= deadline {
        return out;
    }
    out.reached = true;
    let key = attribute(&current, "AXMenuItemCmdChar")
        .ok()
        .and_then(|v| v.downcast_into::<CFString>())
        .map(|key| key.to_string())
        .filter(|key| !key.trim().is_empty());
    if let Some(key) = key {
        let mask = attribute(&current, "AXMenuItemCmdModifiers")
            .ok()
            .and_then(|v| v.downcast_into::<CFNumber>())
            .and_then(|n| n.to_i64())
            .unwrap_or(0);
        out.shortcut = Some((key, mask));
    }
    out
}

/// A menu item's items, the untitled menu AppKit puts between them seen
/// through, as the driver sees them — as many as `deadline` leaves time for.
fn menu_children(item: &CFType, deadline: std::time::Instant) -> Vec<CFType> {
    let mut out = Vec::new();
    for child in elements(item, "AXChildren").unwrap_or_default() {
        if std::time::Instant::now() >= deadline {
            break;
        }
        let role = attribute(&child, "AXRole")
            .ok()
            .and_then(|v| v.downcast_into::<CFString>())
            .map(|r| r.to_string());
        if role.as_deref() == Some("AXMenu") {
            out.extend(elements(&child, "AXChildren").unwrap_or_default());
        } else {
            out.push(child);
        }
    }
    out
}

/// Where among `items` the one titled `title` is — trimmed, as the driver
/// matches — when exactly one is, and `deadline` left time to look at them
/// all.
fn only_titled(items: &[CFType], title: &str, deadline: std::time::Instant) -> Option<usize> {
    let wanted = title.trim();
    let mut found = None;
    for (index, item) in items.iter().enumerate() {
        if std::time::Instant::now() >= deadline {
            return None;
        }
        let matches = attribute(item, "AXTitle")
            .ok()
            .and_then(|v| v.downcast_into::<CFString>())
            .is_some_and(|t| t.to_string().trim() == wanted);
        if matches {
            if found.is_some() {
                return None;
            }
            found = Some(index);
        }
    }
    found
}

/// What asking for a window back came to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Restore {
    /// It was minimized, or its application hidden, and the application took
    /// the request.
    Asked,
    /// It is neither: there was nothing to do.
    AlreadyShown,
    /// Accessibility does not list it: on another desktop, or not a window a
    /// person can bring up.
    Unlisted,
    /// The application would not answer, or refused; the error it gave.
    Failed(i32),
}

/// Put `pid`'s window `window_id` back on the screen — its application shown
/// again if it is hidden, then the window out of the Dock if it is minimized
/// — as clicking it in the Dock would, except that the application is not
/// brought to the front. `ready` is asked on the same thread just before each
/// change is made, once everything read to decide on it has been read; what
/// it refuses is not done, and its error comes back as it is.
pub async fn restore<E: Send + 'static>(
    pid: u32,
    window_id: u64,
    ready: impl Fn() -> Result<(), E> + Send + 'static,
) -> Result<Restore, E> {
    tokio::task::spawn_blocking(move || restore_now(pid, window_id, ready))
        .await
        .unwrap_or(Ok(Restore::Failed(AX_FAILURE)))
}

fn restore_now<E>(
    pid: u32,
    window_id: u64,
    ready: impl Fn() -> Result<(), E>,
) -> Result<Restore, E> {
    let Some(app) = application(pid) else {
        return Ok(Restore::Failed(AX_FAILURE));
    };
    // A hidden application shows its windows again as a whole; a minimized
    // one among them stays in the Dock until it is asked for too.
    let hidden = flag(&app, "AXHidden") == Some(true);
    if hidden {
        ready()?;
        let err = set_false(&app, "AXHidden");
        if err != AX_SUCCESS {
            return Ok(Restore::Failed(err));
        }
    }
    let shown = if hidden {
        Restore::Asked
    } else {
        Restore::AlreadyShown
    };
    let windows = match windows(&app) {
        Ok(windows) => windows,
        Err(_) if hidden => return Ok(shown),
        Err(e) => return Ok(Restore::Failed(e)),
    };
    let Some(window) = windows
        .into_iter()
        .find(|w| window_number(w) == Some(window_id))
    else {
        return Ok(if hidden { shown } else { Restore::Unlisted });
    };
    if flag(&window, "AXMinimized") == Some(false) {
        return Ok(shown);
    }
    ready()?;
    let err = set_false(&window, "AXMinimized");
    Ok(if err == AX_SUCCESS {
        Restore::Asked
    } else {
        Restore::Failed(err)
    })
}

/// Set a yes-or-no attribute of `element` to no.
fn set_false(element: &CFType, name: &'static str) -> AXError {
    let name = CFString::from_static_string(name);
    // SAFETY: a live element, a valid attribute name and a CFBoolean that
    // outlives the call.
    unsafe {
        AXUIElementSetAttributeValue(
            element.as_CFTypeRef(),
            name.as_concrete_TypeRef(),
            CFBoolean::false_value().as_CFTypeRef(),
        )
    }
}

/// `pid`'s application, as Accessibility sees it.
fn application(pid: u32) -> Option<CFType> {
    let pid = libc::pid_t::try_from(pid).ok()?;
    // SAFETY: returns a +1 element, or null.
    let raw = unsafe { AXUIElementCreateApplication(pid) };
    if raw.is_null() {
        return None;
    }
    // SAFETY: the +1 element from above, released by the wrapper.
    let app = unsafe { CFType::wrap_under_create_rule(raw) };
    bound(&app);
    Some(app)
}

/// Hold every question to `element` to [`TIMEOUT`]. Set on each element
/// asked: the bound is the element's own, not its application's.
fn bound(element: &CFType) {
    // SAFETY: a live element; this only sets a number on it.
    unsafe { AXUIElementSetMessagingTimeout(element.as_CFTypeRef(), TIMEOUT) };
}

/// One attribute's value, or the error the application answered with.
fn attribute(element: &CFType, name: &'static str) -> Result<CFType, AXError> {
    let name = CFString::from_static_string(name);
    let mut value: CFTypeRef = std::ptr::null();
    // SAFETY: a live element, a valid attribute name, and an out pointer that
    // receives a +1 value on success.
    let err = unsafe {
        AXUIElementCopyAttributeValue(
            element.as_CFTypeRef(),
            name.as_concrete_TypeRef(),
            &mut value,
        )
    };
    if err != AX_SUCCESS {
        return Err(err);
    }
    if value.is_null() {
        return Err(AX_NO_VALUE);
    }
    // SAFETY: the +1 value from above, released by the wrapper.
    Ok(unsafe { CFType::wrap_under_create_rule(value) })
}

/// A yes-or-no attribute. Some applications answer with a number.
fn flag(element: &CFType, name: &'static str) -> Option<bool> {
    let value = attribute(element, name).ok()?;
    if let Some(yes) = value.downcast::<CFBoolean>() {
        return Some(yes.into());
    }
    value
        .downcast::<CFNumber>()
        .and_then(|n| n.to_i64())
        .map(|n| n != 0)
}

/// The application's windows, as Accessibility lists them.
fn windows(app: &CFType) -> Result<Vec<CFType>, AXError> {
    elements(app, "AXWindows")
}

/// The elements an attribute of `element` lists.
fn elements(element: &CFType, name: &'static str) -> Result<Vec<CFType>, AXError> {
    let list = attribute(element, name)?
        .downcast_into::<CFArray>()
        .ok_or(AX_NO_VALUE)?;
    // SAFETY: a pure query.
    let element_type = unsafe { AXUIElementGetTypeID() };
    Ok(list
        .iter()
        .map(|item| *item)
        // SAFETY: a non-null object the array holds.
        .filter(|item| !item.is_null() && unsafe { CFGetTypeID(*item) } == element_type)
        .map(|item| {
            // SAFETY: an element the array holds, retained for the wrapper.
            let window = unsafe { CFType::wrap_under_get_rule(item) };
            bound(&window);
            window
        })
        .collect())
}

/// The window server's number for an accessibility window: what the
/// driver's listing names windows by. Private (`_AXUIElementGetWindow`), and
/// what every window manager and the driver itself map windows with; looked
/// up at run time, so a macOS without it costs the helper this module, not
/// its start.
fn window_number(window: &CFType) -> Option<u64> {
    type GetWindow = unsafe extern "C" fn(CFTypeRef, *mut u32) -> AXError;
    static GET_WINDOW: OnceLock<Option<GetWindow>> = OnceLock::new();
    let get = (*GET_WINDOW.get_or_init(|| {
        static NAME: &[u8] = b"_AXUIElementGetWindow\0";
        // SAFETY: RTLD_DEFAULT lookup of a NUL-terminated name; this module
        // links ApplicationServices, which carries it.
        let sym = unsafe { libc::dlsym(libc::RTLD_DEFAULT, NAME.as_ptr().cast()) };
        // SAFETY: the symbol has exactly this signature.
        (!sym.is_null())
            .then(|| unsafe { std::mem::transmute::<*mut libc::c_void, GetWindow>(sym) })
    }))?;
    let mut number = 0u32;
    // SAFETY: a live window element and an out pointer for the number.
    let err = unsafe { get(window.as_CFTypeRef(), &mut number) };
    (err == AX_SUCCESS && number != 0).then_some(u64::from(number))
}
