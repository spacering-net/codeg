//! `codeg-computer-helper`: the executor behind codeg's `computer_*` tools.
//!
//! Everything it does lives in `codeg_lib::computer::helper`; this file holds
//! only the one thing that must not be linked into codeg itself — the calls
//! that *ask* macOS for a permission. Raised from here, the request names the
//! helper; raised from codeg, it would name codeg, and a person who clicked
//! "Allow" would have handed the permission to every agent's shell.
//!
//! They run in a helper codeg starts for the one request
//! (`--request-permission <name>`), not in the one serving it: macOS takes a
//! request from each process once.

use codeg_lib::computer::helper::{run, EXIT_FAILED};
use codeg_lib::computer::protocol::{OsPermission, PermissionAsked, REQUEST_PERMISSION_ARG};

fn main() {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() == Some(REQUEST_PERMISSION_ARG) {
        std::process::exit(request_permission(args.next().as_deref()));
    }
    std::process::exit(run());
}

/// Ask for the one permission named, print whether the system put up its
/// own dialog for it, and exit. Asks for nothing else, whatever else is
/// missing: the person pressed the button for this one.
fn request_permission(name: Option<&str>) -> i32 {
    let Some(permission) = name.and_then(OsPermission::from_arg) else {
        eprintln!(
            "usage: codeg-computer-helper {REQUEST_PERMISSION_ARG} accessibility|screen-recording"
        );
        return EXIT_FAILED;
    };
    #[cfg(target_os = "macos")]
    let prompted = macos::request(permission);
    #[cfg(not(target_os = "macos"))]
    let prompted = {
        let _ = permission;
        false
    };
    match serde_json::to_string(&PermissionAsked { prompted }) {
        Ok(line) => {
            println!("{line}");
            0
        }
        Err(e) => {
            eprintln!("{e}");
            EXIT_FAILED
        }
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::collections::{HashMap, HashSet};
    use std::ffi::c_void;
    use std::time::{Duration, Instant};

    use codeg_lib::computer::protocol::OsPermission;
    use codeg_lib::computer::tcc;
    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::CFString;
    use core_foundation_sys::array::{CFArrayGetCount, CFArrayGetValueAtIndex, CFArrayRef};
    use core_foundation_sys::base::{CFRelease, CFTypeRef};
    use core_foundation_sys::dictionary::{CFDictionaryGetValueIfPresent, CFDictionaryRef};
    use core_foundation_sys::number::{kCFNumberSInt64Type, CFNumberGetValue, CFNumberRef};
    use core_foundation_sys::string::CFStringRef;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        static kAXTrustedCheckOptionPrompt: CFStringRef;
        fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> u8;
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        static kCGWindowOwnerPID: CFStringRef;
        static kCGWindowNumber: CFStringRef;
        fn CGWindowListCopyWindowInfo(option: u32, relative_to_window: u32) -> CFArrayRef;
    }

    /// `kCGWindowListOptionOnScreenOnly`.
    const ON_SCREEN_ONLY: u32 = 1;

    /// The executable of the system agent that puts up both dialogs —
    /// "Device Control and Data Access" for Accessibility, "Screen
    /// Recording" for the other. Matched by its executable, not by the name
    /// the window list gives its owner, which may be localized.
    const DIALOG_OWNER: &str = "universalAccessAuthWarn";

    /// How long to watch for its dialog once the request has gone out.
    const DIALOG_WATCH: Duration = Duration::from_secs(2);
    const DIALOG_POLL: Duration = Duration::from_millis(100);

    /// Ask for `permission`, and say whether a dialog of the system's came up
    /// for it. The system does not put one up for a permission already
    /// granted, nor once the person has turned the switch off in System
    /// Settings — only then is it for codeg to open that pane.
    pub fn request(permission: OsPermission) -> bool {
        if granted(permission) {
            return false;
        }
        let before = dialogs();
        ask(permission);
        let deadline = Instant::now() + DIALOG_WATCH;
        loop {
            if dialogs().difference(&before).next().is_some() {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(DIALOG_POLL);
        }
    }

    fn granted(permission: OsPermission) -> bool {
        match permission {
            OsPermission::Accessibility => tcc::accessibility_granted(),
            OsPermission::ScreenRecording => tcc::screen_recording_granted(),
        }
    }

    fn ask(permission: OsPermission) {
        match permission {
            OsPermission::Accessibility => {
                // SAFETY: the option key is a CFString constant for the life
                // of the process; the dictionary outlives the call.
                unsafe {
                    let options = CFDictionary::from_CFType_pairs(&[(
                        CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt),
                        CFBoolean::true_value(),
                    )]);
                    AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef());
                }
            }
            OsPermission::ScreenRecording => {
                // macOS 10.15+, so looked up rather than linked.
                type Request = unsafe extern "C" fn() -> u8;
                static NAME: &[u8] = b"CGRequestScreenCaptureAccess\0";
                // SAFETY: RTLD_DEFAULT lookup of a NUL-terminated name; the
                // symbol has exactly this signature.
                unsafe {
                    let sym = libc::dlsym(libc::RTLD_DEFAULT, NAME.as_ptr().cast());
                    if !sym.is_null() {
                        let request: Request =
                            std::mem::transmute::<*mut libc::c_void, Request>(sym);
                        request();
                    }
                }
            }
        }
    }

    /// The system's permission dialogs on screen now, by window number. The
    /// window list gives each window's number and owner whatever this
    /// process may record; it is the titles it keeps back.
    fn dialogs() -> HashSet<i64> {
        let mut found = HashSet::new();
        let mut owners: HashMap<i64, bool> = HashMap::new();
        // SAFETY: the list is ours to release (a Copy function); each entry
        // is a dictionary it owns, read while it lives, and the values taken
        // from it are the documented types for their keys.
        unsafe {
            let list = CGWindowListCopyWindowInfo(ON_SCREEN_ONLY, 0);
            if list.is_null() {
                return found;
            }
            for i in 0..CFArrayGetCount(list) {
                let window = CFArrayGetValueAtIndex(list, i) as CFDictionaryRef;
                let (Some(pid), Some(number)) = (
                    number_for(window, kCGWindowOwnerPID),
                    number_for(window, kCGWindowNumber),
                ) else {
                    continue;
                };
                if *owners.entry(pid).or_insert_with(|| runs_dialog_owner(pid)) {
                    found.insert(number);
                }
            }
            CFRelease(list as CFTypeRef);
        }
        found
    }

    /// The number `window` holds under `key`, if it holds one.
    ///
    /// # Safety
    /// `window` is a live dictionary from the window list.
    unsafe fn number_for(window: CFDictionaryRef, key: CFStringRef) -> Option<i64> {
        let mut value: *const c_void = std::ptr::null();
        if CFDictionaryGetValueIfPresent(window, key.cast(), &mut value) == 0 || value.is_null() {
            return None;
        }
        let mut n: i64 = 0;
        CFNumberGetValue(
            value as CFNumberRef,
            kCFNumberSInt64Type,
            (&mut n as *mut i64).cast(),
        )
        .then_some(n)
    }

    /// Whether process `pid` runs the dialog agent's executable.
    fn runs_dialog_owner(pid: i64) -> bool {
        let Ok(pid) = libc::c_int::try_from(pid) else {
            return false;
        };
        let mut path = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        // SAFETY: the buffer is as long as the size passed.
        let len = unsafe { libc::proc_pidpath(pid, path.as_mut_ptr().cast(), path.len() as u32) };
        if len <= 0 {
            return false;
        }
        path.truncate(len as usize);
        path.rsplit(|b| *b == b'/').next() == Some(DIALOG_OWNER.as_bytes())
    }
}
