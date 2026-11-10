//! Windows: what the system says of a window the driver listed, asked by its
//! handle — which is what the driver's window id is there.
//!
//! The driver's listing leaves two things unsaid that decide whether a window
//! is one a person could mean to share, and whose it is:
//!
//! - **Whether it is drawn.** Windows can hide a window while leaving it
//!   visible by every other measure: the compositor *cloaks* it. The windows
//!   of the other virtual desktops are cloaked, and so are the ones the system
//!   keeps ready out of sight — the input experience (the emoji panel, the
//!   touch keyboard), a packaged application's own window while its frame is
//!   minimized. A cloaked window is off the screen: on another desktop, it is
//!   what a window on another Space is on macOS; on this one, furniture
//!   nobody can see. Only a window the system places on this desktop is taken
//!   for furniture: one it will not place stays as the driver listed it.
//! - **What a frame shows.** A packaged application draws inside the frame
//!   `ApplicationFrameHost` draws for it, in a core window of its own process
//!   set into the frame (see `appident`). Which process that is, is read off
//!   the core window: its owner, which the system keeps and no process can
//!   say otherwise of. While the frame is minimized, the core window stands
//!   outside it, cloaked, and the frame says which application it shows (by
//!   its application user model id): the one process running that
//!   application with a core window standing on its own is the one. None, or
//!   more than one, and the frame is nobody's that can be told.

use std::ffi::c_void;
use std::ptr;

use windows_sys::core::GUID;
use windows_sys::Win32::Foundation::{BOOL, HWND, RECT};

use crate::computer::appident::Com;
use crate::computer::procinfo::{process_image, process_start_while};
use crate::computer::protocol::ProcessRun;
use crate::computer::types::Rect;

/// The class of the window a packaged application draws in.
const CORE_WINDOW_CLASS: &str = "Windows.UI.Core.CoreWindow";

/// The most core windows looked through in one place; there are a handful.
/// A bound, so that windows coming and going under the walk cannot keep it
/// going.
const MAX_CORE_WINDOWS: usize = 256;

/// The longest application user model id, in UTF-16 units with its
/// terminating NUL (`APPLICATION_USER_MODEL_ID_MAX_LENGTH`).
const MAX_APP_USER_MODEL_ID: usize = 130;

/// `DWMWA_CLOAKED`.
const DWMWA_CLOAKED: u32 = 14;

/// `VT_LPWSTR`.
const VT_LPWSTR: u16 = 31;

/// `CLSCTX_ALL`.
const CLSCTX_ALL: u32 = 0x17;

/// `IID_IPropertyStore`.
const IID_PROPERTY_STORE: GUID = GUID::from_u128(0x886d8eeb_8cf2_4446_8d02_cdba1dbdcf99);

/// `PKEY_AppUserModel_ID`.
const APP_USER_MODEL_ID_KEY: PropertyKey = PropertyKey {
    format: GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
    id: 5,
};

/// `CLSID_VirtualDesktopManager`.
const CLSID_VIRTUAL_DESKTOP_MANAGER: GUID = GUID::from_u128(0xaa509086_5ca9_4c25_8f95_589d3c07b48a);

/// `IID_IVirtualDesktopManager`.
const IID_VIRTUAL_DESKTOP_MANAGER: GUID = GUID::from_u128(0xa5cd92ff_29be_454c_8d04_d82879fb3f1b);

// Declared here: windows-sys has these behind features this crate does not
// turn on (`Win32_UI_WindowsAndMessaging`, `Win32_Graphics_Dwm`,
// `Win32_System_Com`, `Win32_UI_Shell_PropertiesSystem`), and turning one on
// rebuilds every crate that shares windows-sys — Tauri among them.
#[link(name = "user32")]
extern "system" {
    fn GetWindowThreadProcessId(window: HWND, pid: *mut u32) -> u32;
    fn FindWindowExW(parent: HWND, after: HWND, class: *const u16, title: *const u16) -> HWND;
    fn IsIconic(window: HWND) -> BOOL;
    fn ShowWindowAsync(window: HWND, command: i32) -> BOOL;
    fn EnumWindows(callback: unsafe extern "system" fn(HWND, isize) -> BOOL, param: isize) -> BOOL;
    fn IsWindowVisible(window: HWND) -> BOOL;
    fn GetWindowLongW(window: HWND, index: i32) -> i32;
    fn GetClassNameW(window: HWND, name: *mut u16, capacity: i32) -> i32;
}

/// `GWL_EXSTYLE`, and the two extended styles of a window every click
/// passes through: layered and transparent to the pointer.
const GWL_EXSTYLE: i32 = -20;
const WS_EX_TRANSPARENT: u32 = 0x0000_0020;
const WS_EX_LAYERED: u32 = 0x0008_0000;

/// `DWMWA_EXTENDED_FRAME_BOUNDS`: a window's frame as the compositor draws
/// it, in physical pixels whatever this process's own scaling.
const DWMWA_EXTENDED_FRAME_BOUNDS: u32 = 9;

/// The most top-level windows one walk of the screen takes in.
const MAX_SCREEN_WINDOWS: usize = 8192;

/// `SW_SHOWNOACTIVATE`: back to its most recent size and place, without
/// being made the active window.
const SW_SHOWNOACTIVATE: i32 = 4;
#[link(name = "dwmapi")]
extern "system" {
    fn DwmGetWindowAttribute(window: HWND, attribute: u32, value: *mut c_void, size: u32) -> i32;
}
#[link(name = "ole32")]
extern "system" {
    fn CoCreateInstance(
        class: *const GUID,
        outer: *mut c_void,
        context: u32,
        interface: *const GUID,
        object: *mut *mut c_void,
    ) -> i32;
    fn PropVariantClear(value: *mut PropVariant) -> i32;
}
#[link(name = "shell32")]
extern "system" {
    fn SHGetPropertyStoreForWindow(
        window: HWND,
        interface: *const GUID,
        store: *mut *mut c_void,
    ) -> i32;
}

// The structures below are laid out for the system to read or fill: a field
// the code never names is there for its place.

/// `PROPERTYKEY`.
#[repr(C)]
#[allow(dead_code)]
struct PropertyKey {
    format: GUID,
    id: u32,
}

/// `PROPVARIANT`, as far as reading a string out of it goes: its type, and the
/// first pointer-sized word of its value. The system's size and layout, on 32
/// and 64 bits alike.
#[repr(C)]
#[allow(dead_code)]
struct PropVariant {
    kind: u16,
    reserved: [u16; 3],
    value: [usize; 2],
}

impl PropVariant {
    fn empty() -> Self {
        Self {
            kind: 0,
            reserved: [0; 3],
            value: [0; 2],
        }
    }

    /// The string the value holds, when it holds one no longer than an
    /// application user model id can be.
    fn app_user_model_id(&self) -> Option<String> {
        if self.kind != VT_LPWSTR || self.value[0] == 0 {
            return None;
        }
        let text = self.value[0] as *const u16;
        // SAFETY: a VT_LPWSTR value points at a NUL-terminated string the
        // value owns until it is cleared; it is read up to its NUL, and no
        // further than the longest id there is.
        let len = (0..MAX_APP_USER_MODEL_ID).find(|i| unsafe { *text.add(*i) } == 0)?;
        // SAFETY: the `len` units just read, before the NUL.
        let units = unsafe { std::slice::from_raw_parts(text, len) };
        String::from_utf16(units).ok().filter(|id| !id.is_empty())
    }
}

/// The start of every COM object's table of methods.
#[repr(C)]
#[allow(dead_code)]
struct UnknownMethods {
    query_interface: usize,
    add_ref: usize,
    release: unsafe extern "system" fn(this: *mut c_void) -> u32,
}

/// `IPropertyStore`'s table, as far as `GetValue`.
#[repr(C)]
#[allow(dead_code)]
struct PropertyStoreMethods {
    unknown: UnknownMethods,
    get_count: usize,
    get_at: usize,
    get_value: unsafe extern "system" fn(
        this: *mut c_void,
        key: *const PropertyKey,
        value: *mut PropVariant,
    ) -> i32,
}

/// `IVirtualDesktopManager`'s table, as far as
/// `IsWindowOnCurrentVirtualDesktop`.
#[repr(C)]
#[allow(dead_code)]
struct VirtualDesktopManagerMethods {
    unknown: UnknownMethods,
    is_window_on_current_virtual_desktop:
        unsafe extern "system" fn(this: *mut c_void, window: HWND, on: *mut BOOL) -> i32,
}

/// A COM object we hold a reference to, released when dropped.
struct Object(*mut c_void);

impl Object {
    /// The object's table of methods, read as `M`.
    ///
    /// # Safety
    ///
    /// `M` must lay out the start of the object's own table.
    unsafe fn methods<M>(&self) -> &M {
        &**self.0.cast::<*const M>()
    }
}

impl Drop for Object {
    fn drop(&mut self) {
        // SAFETY: every table starts as IUnknown's; our one reference,
        // released once.
        unsafe { (self.methods::<UnknownMethods>().release)(self.0) };
    }
}

/// What the system says of windows, for one listing. COM is entered while it
/// lives: the virtual desktops are asked through it.
pub struct Desktop {
    /// Released before COM is left: fields are dropped in order.
    desktops: Option<Object>,
    _com: Com,
}

impl Desktop {
    pub fn open() -> Self {
        let com = Com::enter();
        let mut object = ptr::null_mut();
        // SAFETY: constant class and interface ids, no outer object, and an
        // out-pointer that holds our one reference on success.
        let status = unsafe {
            CoCreateInstance(
                &CLSID_VIRTUAL_DESKTOP_MANAGER,
                ptr::null_mut(),
                CLSCTX_ALL,
                &IID_VIRTUAL_DESKTOP_MANAGER,
                &mut object,
            )
        };
        let desktops = if status >= 0 && !object.is_null() {
            Some(Object(object))
        } else {
            None
        };
        Self {
            desktops,
            _com: com,
        }
    }

    /// The process owning `window`; `None` when it names no window.
    pub fn owner(&self, window: u64) -> Option<u32> {
        owner(handle(window)?)
    }

    /// Whether the compositor hides `window` (see the module note).
    pub fn cloaked(&self, window: u64) -> bool {
        handle(window).is_some_and(cloaked)
    }

    /// Whether `window` is on the virtual desktop on the screen; `None` when
    /// the system will not say.
    pub fn on_current_desktop(&self, window: u64) -> Option<bool> {
        let desktops = self.desktops.as_ref()?;
        let window = handle(window)?;
        let mut on: BOOL = 0;
        // SAFETY: a live virtual desktop manager, a window handle (one that
        // names no window is answered with an error) and an out-value.
        let status = unsafe {
            (desktops
                .methods::<VirtualDesktopManagerMethods>()
                .is_window_on_current_virtual_desktop)(desktops.0, window, &mut on)
        };
        (status >= 0).then_some(on != 0)
    }

    /// The run of the process drawing inside `frame`, a window of the frame
    /// host `host` (see the module note); `None` when no process is, or when
    /// which one cannot be told. The run is read off the process it was found
    /// by — through the handle the core window is found still inside the
    /// frame and still that process's with, or the one its application was
    /// read through — so a pid that passed to another process in between
    /// cannot lend the frame that process's identity.
    pub fn frame_content(&self, frame: u64, host: u32) -> Option<ProcessRun> {
        let frame = handle(frame)?;
        let inside: Vec<(HWND, u32)> = core_windows(frame)
            .filter_map(|window| Some((window, owner(window)?)))
            .filter(|(_, pid)| *pid != host)
            .collect();
        match found(inside.iter().map(|(_, pid)| *pid)) {
            Found::One(pid) => {
                let window = inside.first()?.0;
                let started_at = process_start_while(pid, || {
                    owner(window) == Some(pid) && core_windows(frame).any(|w| w == window)
                })?;
                Some(ProcessRun { pid, started_at })
            }
            Found::Several => None,
            // Minimized: the core window stands on its own.
            Found::Nothing => {
                let shown = app_user_model_id(frame)?;
                let runs = core_windows(ptr::null_mut())
                    .filter_map(owner)
                    .filter_map(|pid| {
                        let image = process_image(pid)?;
                        (image.app_user_model_id.as_deref() == Some(shown.as_str())).then_some(
                            ProcessRun {
                                pid,
                                started_at: image.started,
                            },
                        )
                    });
                match found(runs) {
                    Found::One(run) => Some(run),
                    Found::Nothing | Found::Several => None,
                }
            }
        }
    }
}

/// Whether the process drawing inside `frame`, a window of the frame host
/// `host`, is still `pid` — where the frame says: `None` while no core window
/// is inside it (minimized, or in passing), when only that the run is alive
/// can be told.
pub fn frame_holds(frame: u64, host: u32, pid: u32) -> Option<bool> {
    let frame = handle(frame)?;
    let mut inside = core_windows(frame)
        .filter_map(owner)
        .filter(|drawer| *drawer != host)
        .peekable();
    inside.peek()?;
    Some(inside.all(|drawer| drawer == pid))
}

/// What asking for a window back came to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Restore {
    /// It was minimized, and it was asked to come back.
    Asked,
    /// It is not minimized: there was nothing to do.
    AlreadyShown,
    /// No such window, or not `pid`'s.
    NotTheWindow,
}

/// Put `pid`'s window `window_id` back on the screen if it is minimized —
/// as clicking it on the taskbar would, except that it is not made the
/// active window: the person's keyboard focus stays where it is. `ready` is
/// asked just before the one change is made; what it refuses is not done.
pub fn restore<E>(
    window_id: u64,
    pid: u32,
    ready: impl FnOnce() -> Result<(), E>,
) -> Result<Restore, E> {
    let Some(window) = handle(window_id) else {
        return Ok(Restore::NotTheWindow);
    };
    if owner(window) != Some(pid) {
        return Ok(Restore::NotTheWindow);
    }
    // SAFETY: a handle is a plain value; a stale one answers no.
    if unsafe { IsIconic(window) } == 0 {
        return Ok(Restore::AlreadyShown);
    }
    ready()?;
    // SAFETY: as above. Asynchronous, so a hung application cannot hold the
    // helper: whether the window came back is read afterwards.
    unsafe { ShowWindowAsync(window, SW_SHOWNOACTIVATE) };
    Ok(Restore::Asked)
}

/// One top-level window on the screen, as [`screen_windows`] finds it.
#[derive(Debug, Clone, PartialEq)]
pub struct ScreenHwnd {
    /// Its handle, as the driver's window id is.
    pub id: u64,
    pub pid: u32,
    /// Its frame as the compositor draws it, in physical pixels — the units
    /// the driver's picture of the screen is in.
    pub frame: Rect,
    pub class: String,
    /// A layered overlay every click passes through.
    pub passes_clicks: bool,
}

/// Every top-level window on the screen: shown, not minimized, and not
/// hidden by the compositor.
pub fn screen_windows() -> Vec<ScreenHwnd> {
    unsafe extern "system" fn take(window: HWND, param: isize) -> BOOL {
        // SAFETY: `param` is the vector below, which outlives the walk; the
        // walk calls back on this thread alone.
        let windows = unsafe { &mut *(param as *mut Vec<HWND>) };
        windows.push(window);
        BOOL::from(windows.len() < MAX_SCREEN_WINDOWS)
    }
    let mut windows: Vec<HWND> = Vec::new();
    // SAFETY: a callback that only adds to the vector `param` points at.
    unsafe { EnumWindows(take, &mut windows as *mut Vec<HWND> as isize) };
    windows
        .into_iter()
        .filter_map(|window| {
            // SAFETY: plain queries of a handle; one that has gone since is
            // answered as no window.
            let shown = unsafe { IsWindowVisible(window) } != 0 && unsafe { IsIconic(window) } == 0;
            // SAFETY: as above.
            let style = unsafe { GetWindowLongW(window, GWL_EXSTYLE) } as u32;
            if !shown || cloaked(window) {
                return None;
            }
            Some(ScreenHwnd {
                id: window as usize as u64,
                pid: owner(window)?,
                frame: frame(window)?,
                class: class_of(window),
                passes_clicks: style & WS_EX_LAYERED != 0 && style & WS_EX_TRANSPARENT != 0,
            })
        })
        .collect()
}

/// The class `window` was made with; empty when it cannot be read.
fn class_of(window: HWND) -> String {
    // A class name is at most 256 characters.
    let mut name = [0u16; 257];
    // SAFETY: a buffer of the length given; the answer is the number of
    // units written without the NUL, 0 for a handle that names no window.
    let len = unsafe { GetClassNameW(window, name.as_mut_ptr(), name.len() as i32) };
    usize::try_from(len)
        .ok()
        .and_then(|len| name.get(..len))
        .map(String::from_utf16_lossy)
        .unwrap_or_default()
}

/// Whether the compositor hides `window` (see the module note).
fn cloaked(window: HWND) -> bool {
    let mut cloaked = 0u32;
    // SAFETY: a 4-byte value for the attribute that fills one; a handle that
    // names no window is answered with an error.
    let status = unsafe {
        DwmGetWindowAttribute(
            window,
            DWMWA_CLOAKED,
            (&mut cloaked as *mut u32).cast(),
            std::mem::size_of::<u32>() as u32,
        )
    };
    status >= 0 && cloaked != 0
}

/// `window`'s frame as the compositor draws it, in physical pixels; `None`
/// when it has none to draw, or has gone.
fn frame(window: HWND) -> Option<Rect> {
    let mut rect = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    // SAFETY: a RECT for the attribute that fills one; a handle that names
    // no window is answered with an error.
    let status = unsafe {
        DwmGetWindowAttribute(
            window,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            (&mut rect as *mut RECT).cast(),
            std::mem::size_of::<RECT>() as u32,
        )
    };
    let frame = Rect {
        x: f64::from(rect.left),
        y: f64::from(rect.top),
        width: f64::from(rect.right) - f64::from(rect.left),
        height: f64::from(rect.bottom) - f64::from(rect.top),
    };
    (status >= 0 && !frame.is_empty()).then_some(frame)
}

/// What a walk turned up: nothing, one (however often it turned up), or
/// several.
#[derive(Debug, PartialEq, Eq)]
enum Found<T> {
    Nothing,
    One(T),
    Several,
}

fn found<T: PartialEq>(mut items: impl Iterator<Item = T>) -> Found<T> {
    let Some(first) = items.next() else {
        return Found::Nothing;
    };
    if items.all(|item| item == first) {
        Found::One(first)
    } else {
        Found::Several
    }
}

/// The window `id` names, as a handle; 0 names none.
fn handle(id: u64) -> Option<HWND> {
    usize::try_from(id)
        .ok()
        .filter(|id| *id != 0)
        .map(|id| id as HWND)
}

/// The process owning `window`; `None` when it is no window.
fn owner(window: HWND) -> Option<u32> {
    let mut pid = 0;
    // SAFETY: a valid out-pointer; a handle that is no window is answered
    // with 0.
    let thread = unsafe { GetWindowThreadProcessId(window, &mut pid) };
    (thread != 0 && pid != 0).then_some(pid)
}

/// The core windows directly inside `parent` — or, for a null `parent`,
/// standing on their own — front to back.
fn core_windows(parent: HWND) -> impl Iterator<Item = HWND> {
    let class: Vec<u16> = CORE_WINDOW_CLASS.encode_utf16().chain(Some(0)).collect();
    let mut after: HWND = ptr::null_mut();
    std::iter::from_fn(move || {
        // SAFETY: a NUL-terminated class name, and a handle the call itself
        // gave (or null); one that has gone since is answered with null.
        let next = unsafe { FindWindowExW(parent, after, class.as_ptr(), ptr::null()) };
        if next.is_null() {
            return None;
        }
        after = next;
        Some(next)
    })
    .take(MAX_CORE_WINDOWS)
}

/// The application user model id `window` says it belongs to: a frame says
/// the one of the application it shows.
fn app_user_model_id(window: HWND) -> Option<String> {
    let mut store = ptr::null_mut();
    // SAFETY: a constant interface id, and an out-pointer that holds our one
    // reference on success.
    let status = unsafe { SHGetPropertyStoreForWindow(window, &IID_PROPERTY_STORE, &mut store) };
    if status < 0 || store.is_null() {
        return None;
    }
    let store = Object(store);
    let mut value = PropVariant::empty();
    // SAFETY: a live property store, a key that outlives the call, and an
    // empty value for it to fill — cleared below, whatever it holds.
    let status = unsafe {
        (store.methods::<PropertyStoreMethods>().get_value)(
            store.0,
            &APP_USER_MODEL_ID_KEY,
            &mut value,
        )
    };
    let id = if status >= 0 {
        value.app_user_model_id()
    } else {
        None
    };
    // SAFETY: the value GetValue filled, or left empty; cleared once.
    unsafe { PropVariantClear(&mut value) };
    id
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One process is found however many of its windows turn up; none, or
    /// two, is not one.
    #[test]
    fn one_process_is_found_however_often_it_turns_up() {
        assert_eq!(found([7, 7, 7].into_iter()), Found::One(7));
        assert_eq!(found(std::iter::empty::<u32>()), Found::Nothing);
        assert_eq!(found([7, 8, 7].into_iter()), Found::Several);
    }

    /// A handle that names no window says nothing of one: no owner, not
    /// hidden, on no desktop, framing nothing.
    #[test]
    fn a_handle_that_names_no_window_says_nothing() {
        let desktop = Desktop::open();
        assert_eq!(desktop.owner(0), None);
        assert!(!desktop.cloaked(0));
        assert_eq!(desktop.on_current_desktop(0), None);
        assert_eq!(desktop.frame_content(0, std::process::id()), None);
        assert_eq!(frame_holds(0, std::process::id(), 1), None);
    }

    /// The value is laid out as the system's is, and its string is read up
    /// to its NUL — not at all when it would run past the longest id, or is
    /// no string.
    #[test]
    fn a_string_value_is_read_up_to_its_nul_and_no_further() {
        let size = if cfg!(target_pointer_width = "64") {
            24
        } else {
            16
        };
        assert_eq!(std::mem::size_of::<PropVariant>(), size);
        let string = |units: &[u16]| PropVariant {
            kind: VT_LPWSTR,
            reserved: [0; 3],
            value: [units.as_ptr() as usize, 0],
        };
        let id: Vec<u16> = "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"
            .encode_utf16()
            .chain(Some(0))
            .collect();
        assert_eq!(
            string(&id).app_user_model_id().as_deref(),
            Some("Microsoft.WindowsCalculator_8wekyb3d8bbwe!App")
        );
        let long: Vec<u16> = std::iter::repeat_n(u16::from(b'a'), MAX_APP_USER_MODEL_ID)
            .chain(Some(0))
            .collect();
        assert_eq!(string(&long).app_user_model_id(), None);
        assert_eq!(string(&[0]).app_user_model_id(), None);
        assert_eq!(PropVariant::empty().app_user_model_id(), None);
    }
}
