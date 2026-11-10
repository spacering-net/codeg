//! Which application a process is, asked of the process itself.
//!
//! The driver has its own answer — `list_apps` — and on macOS it goes stale.
//! It reads `NSWorkspace.runningApplications`, which only changes while the
//! main run loop runs, and the driver never runs its: an application launched
//! after the driver started is missing from that list for good, and one that
//! quit stays on it — under a pid the system may since have handed to
//! another process, which would then pass for it. So on macOS the helper asks
//! the kernel which executable a process runs (`proc_pidpath`, an ordinary
//! BSD query, not TCC-governed) and reads the application off that.
//!
//! Only the main executable of an application bundle counts
//! (`<bundle>/Contents/MacOS/<exe>`), where the bundle is an application:
//! named `<name>.app`, or saying so itself (`CFBundlePackageType` `APPL`).
//! The second is how Chromium browsers run — from a clone of their bundle,
//! `<name>.app.bundle` in a temporary folder, made at launch so that an update
//! replacing the installed copy leaves the running code its signature. Such a
//! clone is on a blocklist by its bundle identifier or by the file name it was
//! cloned from, not by the installed copy's full path, which it does not
//! carry. An XPC service, an app extension or a bare executable draws windows
//! for another application or for nobody in particular — the password
//! AutoFill panel is one — and stays unidentified, which is what the driver's
//! list of regular applications left them as. So do Apple's own agents under
//! `/System` — the login window, the Gatekeeper and keychain prompts, Control
//! Center — except in the places Apple keeps the applications people use.
//!
//! A helper application inside another (`Foo.app/…/Foo Helper.app`) is the
//! application it sits in: its windows are that application's, and so is its
//! place on a blocklist — the Passwords menu-bar helper is Passwords. Only one
//! named `.app`, though: a bundle that is an application by its own word
//! alone is one only standing by itself, since inside another it would pass
//! for that one — a clone of a blocklisted application put inside an
//! application nobody listed would take that one's name. And an
//! application is known by its bundle identifier: one whose `Info.plist`
//! cannot be read is not told apart by its path instead, since the blocklist
//! names password managers by identifier.
//!
//! **Names.** An application is called what the Finder calls it: its file
//! name — Visual Studio Code, which calls itself `Code` — unless it calls
//! itself something else in the person's language: the Finder is 访达 in
//! Chinese, and WPS Office's file is `wpsoffice.app`. That name is the one
//! the window list carries for each window's owner, so a name there that the
//! bundle's own (untranslated) `Info.plist` does not have is taken as a
//! translation. The Finder's own translated name is not to be had here: a
//! process with no bundle of its own is answered in the development language.
//!
//! **Windows.** There the driver's answer names no application at all: its
//! list carries each process's executable by file name alone, and a path only
//! for the few whose file name happens to match a Start menu shortcut — none,
//! on many machines. So the helper reads the full path off the process itself
//! (with its start time, through the same handle: see `procinfo`), and the
//! executable is the application — unless it draws for other applications,
//! or is the system's own. `ApplicationFrameHost.exe` draws the frame of every
//! packaged application's window — Settings, Calculator — while the
//! application draws what is in it, in a window of its own process set inside
//! the frame; `msedgewebview2.exe` draws the inspector and the dialogs of
//! every application built on WebView2, codeg among them. A window of either
//! is any of those applications', and which one cannot be told from the
//! host's path: taken for the host, it would pass for an application no
//! blocklist names, and for one that is not codeg. So a frame is taken for
//! the application of the process drawing inside it, which the helper finds
//! by the frame's handle (see `helper::hwnd`) — and for as long as that same
//! run of it is inside; the frame host lends its windows nothing of its own.
//! A window of WebView2's stays unidentified, as on macOS does a process
//! drawing for another application. And the system's own agents stay
//! unidentified, as Apple's under `/System` do, framed or not: the Start
//! menu, the lock screen, the prompts for a PIN or for an account's password,
//! which Windows keeps each in a folder of its own in `SystemApps`.
//!
//! On Windows an application is called what Windows calls it to the person.
//! A packaged one — Terminal, Settings, the Notepad Windows 11 ships — goes by
//! its entry in the Start menu (the shell's Apps folder), in the person's
//! language: 终端, 设置, 记事本 in Chinese. Its executable's own description
//! is no name for it: Terminal's says "Windows Terminal Host", Notepad's
//! "Notepad.exe", Photos' nothing at all. Any other application goes by what
//! Task Manager calls it: the description in its executable's version
//! resource, in the person's language where Windows carries a translation —
//! Explorer is "Windows 资源管理器" in Chinese — or, where it gives none, its
//! file name. A name only says what to call an application, never what it is
//! (its path does), so each is read once per executable and kept: the Start
//! menu can take a fifth of a second to answer.

/// Windows: the executables whose windows are other applications'. See the
/// module note.
const HOSTS: &[&str] = &[FRAME_HOST, "msedgewebview2.exe"];

/// Windows: the host whose every window is a frame with an application
/// drawing inside it. See the module note.
const FRAME_HOST: &str = "ApplicationFrameHost.exe";

/// Windows: the folder the system keeps its own agents in. See the module
/// note.
const SYSTEM_APPS: &str = "SystemApps";

/// Windows: how many applications' names are kept (see the module note).
/// Past that they are all read again, as they are needed.
#[cfg(windows)]
const MAX_WINDOWS_NAMES: usize = 256;

/// Windows: how long a listing waits for an application's name before it
/// goes by its file name for now (see `windows_name`). The Start menu takes
/// a fifth of a second at worst when it is well.
#[cfg(windows)]
const NAME_WAIT: std::time::Duration = std::time::Duration::from_secs(2);

/// Windows: once a name has not come in time, how long no listing waits for
/// another — a shell slow to name one application is slow for all.
#[cfg(windows)]
const NAME_SLOW: std::time::Duration = std::time::Duration::from_secs(30);

/// Windows: the most names read at once. A read the shell never answers
/// keeps its thread; past this many, applications go by their file names
/// until one comes back, rather than a thread more each.
#[cfg(windows)]
const MAX_NAME_READERS: usize = 4;

/// Where Apple keeps the applications people use, under `/System`.
const SYSTEM_APPLICATIONS: &[&str] = &[
    "/System/Applications/",
    "/System/Cryptexes/App/System/Applications/",
    "/System/Library/CoreServices/Applications/",
];

/// The one application Apple keeps among its agents.
const FINDER: &str = "/System/Library/CoreServices/Finder.app";

/// The largest `Info.plist` read: real ones are a few kilobytes, and the
/// helper does not read an unbounded file because a bundle says so.
#[cfg(target_os = "macos")]
const MAX_INFO_PLIST: u64 = 1 << 20;

/// An application, as the process running it shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppIdentity {
    /// The application bundle.
    pub path: String,
    /// `CFBundleIdentifier` from the bundle's `Info.plist`.
    pub bundle_id: String,
    /// What the bundle's `Info.plist` calls the application, untranslated
    /// (`CFBundleDisplayName`, `CFBundleName`).
    pub plist_names: Vec<String>,
    /// The process runs a helper inside the application, not the application
    /// itself.
    pub nested: bool,
}

impl AppIdentity {
    /// What to call the application, given the name the window list gives the
    /// process that owns a window (`owner`). See the module note.
    pub fn name(&self, owner: &str) -> String {
        let owner = owner.trim();
        // A helper's own name is not the application's.
        if self.nested || owner.is_empty() {
            return file_name(&self.path);
        }
        // A bundle not named `.app` is a Chromium clone, named after the
        // installed bundle rather than by it.
        if !has_app_extension(&self.path) || !self.plist_names.iter().any(|n| n == owner) {
            return owner.to_string();
        }
        file_name(&self.path)
    }
}

/// The bundle's file name, as the Finder shows it: without `.app` — or, for a
/// Chromium clone, without `.app.bundle`.
fn file_name(bundle: &str) -> String {
    let file = bundle.rsplit('/').next().unwrap_or(bundle);
    let file = strip_suffix_ignore_case(file, ".bundle");
    strip_suffix_ignore_case(file, ".app").to_string()
}

/// `name` without `suffix` (ASCII, in any case), unless nothing would be left.
fn strip_suffix_ignore_case<'a>(name: &'a str, suffix: &str) -> &'a str {
    // `suffix` is ASCII, so where the name ends with it the bytes before it
    // end on a character boundary; anywhere else `get` says no.
    match name.len().checked_sub(suffix.len()).filter(|n| *n > 0) {
        Some(stem)
            if name
                .get(stem..)
                .is_some_and(|end| end.eq_ignore_ascii_case(suffix)) =>
        {
            &name[..stem]
        }
        _ => name,
    }
}

/// Whether `bundle` is named `<name>.app`.
pub fn has_app_extension(bundle: &str) -> bool {
    let name = bundle.rsplit('/').next().unwrap_or(bundle);
    strip_suffix_ignore_case(name, ".app").len() < name.len()
}

/// Whether `bundle` is an application: by its name, or by the package type
/// its `Info.plist` gives (`package_type`).
pub fn is_application(bundle: &str, package_type: Option<&str>) -> bool {
    has_app_extension(bundle) || package_type == Some("APPL")
}

/// The bundle whose main executable `executable` is, or `None` when it is
/// anything else: an executable nested deeper in a bundle, or one outside any.
/// Whether that bundle is an application is [`is_application`]'s question.
pub fn executable_bundle(executable: &str) -> Option<&str> {
    let (dir, file) = executable.rsplit_once('/')?;
    if file.is_empty() {
        return None;
    }
    let bundle = dir.strip_suffix("/Contents/MacOS")?;
    let name = bundle.rsplit('/').next()?;
    (!name.is_empty()).then_some(bundle)
}

/// The outermost `.app` bundle on `bundle`'s path — `bundle` itself unless it
/// sits inside another application. See the module note.
pub fn outermost_app_bundle(bundle: &str) -> &str {
    let mut end = 0;
    for part in bundle.split('/') {
        end += part.len();
        if has_app_extension(part) {
            return &bundle[..end];
        }
        end += 1;
    }
    bundle
}

/// Whether `bundle` is one of Apple's own agents or panels rather than an
/// application a person uses. See the module note.
pub fn is_system_component(bundle: &str) -> bool {
    bundle.starts_with("/System/")
        && !SYSTEM_APPLICATIONS
            .iter()
            .any(|dir| bundle.starts_with(dir))
        && !bundle.eq_ignore_ascii_case(FINDER)
}

/// Whether the executable at `path` is an application a person uses, as
/// Windows runs them: not a host, whose windows are other applications', and
/// not one of the system's own agents (see the module note). Hosts are known
/// by their file names, in any case, wherever they are; the agents by where
/// they are, the `SystemApps` folder of the system's own Windows folder — or,
/// where the system will not say which folder that is, any folder named so.
/// Both can only keep a window from being shared, never let one be.
pub fn is_windows_application(path: &str) -> bool {
    is_application_outside(path, system_apps_folder())
}

/// [`is_windows_application`], with the system's agents in `system_apps` —
/// or, where that is not known, in any folder named `SystemApps`.
fn is_application_outside(path: &str, system_apps: Option<&str>) -> bool {
    let mut parts = path.rsplit(['\\', '/']);
    let Some(file) = parts.next().filter(|file| !file.is_empty()) else {
        return false;
    };
    if HOSTS.iter().any(|host| file.eq_ignore_ascii_case(host)) {
        return false;
    }
    match system_apps {
        Some(folder) => !is_inside(path, folder),
        None => !parts.any(|dir| dir.eq_ignore_ascii_case(SYSTEM_APPS)),
    }
}

/// Whether `path` lies inside `folder`: the same letters, in any case, with
/// either separator, and a separator after them.
fn is_inside(path: &str, folder: &str) -> bool {
    let fold = |c: char| {
        if c == '/' {
            '\\'
        } else {
            c.to_ascii_lowercase()
        }
    };
    let mut path = path.chars().map(fold);
    folder.chars().map(fold).all(|c| path.next() == Some(c)) && path.next() == Some('\\')
}

/// Windows: the `SystemApps` folder of the system's own Windows folder,
/// asked once; `None` when the system will not say.
#[cfg(windows)]
fn system_apps_folder() -> Option<&'static str> {
    use std::sync::OnceLock;

    // Declared here: windows-sys has it behind a feature this crate does not
    // turn on (`Win32_System_SystemInformation`), and turning one on rebuilds
    // every crate that shares windows-sys — Tauri among them.
    #[link(name = "kernel32")]
    extern "system" {
        fn GetSystemWindowsDirectoryW(buffer: *mut u16, size: u32) -> u32;
    }
    static FOLDER: OnceLock<Option<String>> = OnceLock::new();
    FOLDER
        .get_or_init(|| {
            let mut buf = [0u16; 512];
            // SAFETY: `buf` holds as many units as said; the answer is the
            // number written without the NUL, or the size needed when that
            // is more than there is room for.
            let len = unsafe { GetSystemWindowsDirectoryW(buf.as_mut_ptr(), buf.len() as u32) };
            let len = usize::try_from(len)
                .ok()
                .filter(|len| (1..buf.len()).contains(len))?;
            let windows = String::from_utf16(&buf[..len]).ok()?;
            Some(format!(r"{}\{SYSTEM_APPS}", windows.trim_end_matches('\\')))
        })
        .as_deref()
}

#[cfg(not(windows))]
fn system_apps_folder() -> Option<&'static str> {
    None
}

/// Whether the executable at `path` is the frame host, known by its file
/// name as the other hosts are. Taking a process for it lends its windows no
/// identity: each is still the application of the process drawing inside it,
/// or nobody's (see the module note).
pub fn is_frame_host(path: &str) -> bool {
    path.rsplit(['\\', '/'])
        .next()
        .is_some_and(|file| file.eq_ignore_ascii_case(FRAME_HOST))
}

/// The application `pid` runs, when it is one (see the module note). macOS
/// only: Windows has `windows_owner`, and Linux reads the driver's own list
/// afresh on every call.
#[cfg(target_os = "macos")]
pub fn identify(pid: u32) -> Option<AppIdentity> {
    identify_executable(&executable_path(pid)?)
}

/// Windows: an application, as the process running it shows.
#[cfg(windows)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowsApp {
    /// Its executable's full path, which is what it is known by.
    pub path: String,
    /// What to call it (see the module note).
    pub name: String,
}

/// Windows: whose the windows of a process are (see the module note).
#[cfg(windows)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WindowsOwner {
    /// An application ([`is_windows_application`]): they are its own.
    Application(WindowsApp),
    /// The frame host: each is the application drawing inside it.
    FrameHost,
    /// Another host, one of the system's agents, or a process that has gone
    /// or will not say: nobody's that can be told.
    Unknown,
}

/// Windows: whose the windows of `pid` are — read off the process, while it
/// is still the one that started at `started_at`.
#[cfg(windows)]
pub fn windows_owner(pid: u32, started_at: u64) -> WindowsOwner {
    let Some(image) =
        crate::computer::procinfo::process_image(pid).filter(|image| image.started == started_at)
    else {
        return WindowsOwner::Unknown;
    };
    if is_frame_host(&image.path) {
        return WindowsOwner::FrameHost;
    }
    if !is_windows_application(&image.path) {
        return WindowsOwner::Unknown;
    }
    WindowsOwner::Application(WindowsApp {
        name: windows_name(&image.path, image.app_user_model_id.as_deref()),
        path: image.path,
    })
}

/// Windows: the application `pid` runs — when the process is still the one
/// that started at `started_at`, and runs an application
/// ([`is_windows_application`]).
#[cfg(windows)]
pub fn windows_application(pid: u32, started_at: u64) -> Option<WindowsApp> {
    match windows_owner(pid, started_at) {
        WindowsOwner::Application(app) => Some(app),
        WindowsOwner::FrameHost | WindowsOwner::Unknown => None,
    }
}

/// Windows: what to call the application whose executable is at `path` —
/// `app_user_model_id` names it when it is a packaged one. Read once and
/// kept (see the module note), on a thread of its own: a listing waits for it
/// [`NAME_WAIT`] at most — no longer at all for a while after one has not
/// come in time ([`NAME_SLOW`]) — and meanwhile goes by the file name, so a
/// shell that does not answer cannot hold a listing up. A name still being
/// read is not asked for again, no more than [`MAX_NAME_READERS`] are read at
/// once, and one is kept when it comes, for the listings after.
#[cfg(windows)]
fn windows_name(path: &str, app_user_model_id: Option<&str>) -> String {
    use std::collections::{HashMap, HashSet};
    use std::sync::{mpsc, Mutex, OnceLock};
    use std::time::{Duration, Instant};

    type Key = (String, Option<String>);
    #[derive(Default)]
    struct Names {
        known: HashMap<Key, String>,
        /// Being read by a thread that has not answered yet.
        asking: HashSet<Key>,
        /// Until when no listing waits for a name.
        slow_until: Option<Instant>,
    }
    static NAMES: OnceLock<Mutex<Names>> = OnceLock::new();
    let names: &'static Mutex<Names> = NAMES.get_or_init(Mutex::default);
    let key: Key = (path.to_string(), app_user_model_id.map(str::to_string));
    let wait = {
        let Ok(mut held) = names.lock() else {
            return file_name_of(path);
        };
        if let Some(name) = held.known.get(&key) {
            return name.clone();
        }
        if held.asking.len() >= MAX_NAME_READERS || !held.asking.insert(key.clone()) {
            return file_name_of(path);
        }
        if held.slow_until.is_some_and(|until| Instant::now() < until) {
            Duration::ZERO
        } else {
            NAME_WAIT
        }
    };
    let (told, answer) = mpsc::channel();
    let asked = key.clone();
    let reader = std::thread::Builder::new()
        .name("codeg-app-name".into())
        .spawn(move || {
            let (path, id) = &asked;
            let name = id
                .as_deref()
                .and_then(windows_names::start_menu_name)
                .or_else(|| windows_names::file_description(path))
                .unwrap_or_else(|| file_name_of(path));
            if let Ok(mut held) = names.lock() {
                held.asking.remove(&asked);
                if held.known.len() >= MAX_WINDOWS_NAMES {
                    held.known.clear();
                }
                held.known.insert(asked.clone(), name.clone());
            }
            let _ = told.send(name);
        });
    if reader.is_err() {
        if let Ok(mut held) = names.lock() {
            held.asking.remove(&key);
        }
        return file_name_of(path);
    }
    match answer.recv_timeout(wait) {
        Ok(name) => name,
        Err(_) => {
            if !wait.is_zero() {
                if let Ok(mut held) = names.lock() {
                    held.slow_until = Some(Instant::now() + NAME_SLOW);
                }
            }
            file_name_of(path)
        }
    }
}

/// Windows: the file name of the executable at `path` — what an application
/// is called when nothing better says.
#[cfg(windows)]
fn file_name_of(path: &str) -> String {
    path.rsplit(['\\', '/'])
        .next()
        .filter(|file| !file.is_empty())
        .unwrap_or(path)
        .to_string()
}

#[cfg(windows)]
pub(crate) use windows_names::Com;

/// Windows: the two places an application's name is read from (see the
/// module note).
#[cfg(windows)]
mod windows_names {
    use std::ffi::c_void;
    use std::ptr;

    use windows_sys::Win32::Storage::FileSystem::{
        GetFileVersionInfoExW, GetFileVersionInfoSizeExW, VerQueryValueW, FILE_VER_GET_LOCALISED,
    };
    use windows_sys::Win32::UI::Shell::SIGDN_NORMALDISPLAY;

    /// The largest version resource read: real ones are a few kilobytes, and
    /// the helper does not read an unbounded one because an executable says
    /// so.
    const MAX_VERSION_INFO: u32 = 1 << 20;

    /// Where a version resource's strings are looked for when it does not
    /// say which languages it has them in: US English, then no language,
    /// each as Unicode and as Windows' Western code page.
    const FALLBACK_TRANSLATIONS: [(u16, u16); 4] = [
        (0x0409, 0x04b0),
        (0x0409, 0x04e4),
        (0x0000, 0x04b0),
        (0x0000, 0x04e4),
    ];

    /// `COINIT_MULTITHREADED`.
    const COINIT_MULTITHREADED: u32 = 0;

    // Declared here: windows-sys has these behind features this crate does
    // not turn on (`Win32_System_Com`, `Win32_UI_Shell_Common`), and turning
    // one on rebuilds every crate that shares windows-sys — Tauri among them.
    #[link(name = "ole32")]
    extern "system" {
        fn CoInitializeEx(reserved: *const c_void, co_init: u32) -> i32;
        fn CoUninitialize();
        fn CoTaskMemFree(block: *const c_void);
    }
    #[link(name = "shell32")]
    extern "system" {
        fn SHParseDisplayName(
            name: *const u16,
            bind_context: *mut c_void,
            id_list: *mut *mut c_void,
            attributes_asked: u32,
            attributes: *mut u32,
        ) -> i32;
        fn SHGetNameFromIDList(id_list: *const c_void, kind: i32, name: *mut *mut u16) -> i32;
        fn ILFree(id_list: *const c_void);
    }

    /// What the Start menu calls the packaged application
    /// `app_user_model_id`: the display name of its entry in the shell's
    /// Apps folder, which is in the person's language.
    pub fn start_menu_name(app_user_model_id: &str) -> Option<String> {
        // Declared first, so the list and the string below are let go of
        // while COM is still entered.
        let _com = Com::enter();
        let item = wide(&format!(r"shell:AppsFolder\{app_user_model_id}"));
        let mut id_list = ptr::null_mut();
        // SAFETY: a NUL-terminated name, no bind context, and an out-pointer
        // for the item's id list, which is ours to free once it is set.
        let status = unsafe {
            SHParseDisplayName(
                item.as_ptr(),
                ptr::null_mut(),
                &mut id_list,
                0,
                ptr::null_mut(),
            )
        };
        if status < 0 || id_list.is_null() {
            return None;
        }
        let id_list = IdList(id_list);
        let mut name = ptr::null_mut();
        // SAFETY: a live id list; on success `name` is a NUL-terminated
        // string of the caller's to free.
        let status = unsafe { SHGetNameFromIDList(id_list.0, SIGDN_NORMALDISPLAY, &mut name) };
        if status < 0 || name.is_null() {
            return None;
        }
        let name = TaskString(name);
        trimmed(&name.units())
    }

    /// The description in the version resource of the executable at `path`,
    /// in the person's language where Windows carries a translation of it.
    pub fn file_description(path: &str) -> Option<String> {
        let path = wide(path);
        let mut unused = 0;
        // SAFETY: a NUL-terminated path and a valid out-pointer.
        let size = unsafe {
            GetFileVersionInfoSizeExW(FILE_VER_GET_LOCALISED, path.as_ptr(), &mut unused)
        };
        if size == 0 || size > MAX_VERSION_INFO {
            return None;
        }
        let mut block = vec![0u8; size as usize];
        // SAFETY: `block` holds `size` bytes, the size just asked for.
        let read = unsafe {
            GetFileVersionInfoExW(
                FILE_VER_GET_LOCALISED,
                path.as_ptr(),
                0,
                size,
                block.as_mut_ptr().cast(),
            )
        };
        if read == 0 {
            return None;
        }
        // The languages the strings are in, as (language, code page) pairs.
        let listed: Vec<(u16, u16)> = value(&block, r"\VarFileInfo\Translation", |bytes| bytes)
            .map(|bytes| {
                bytes
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .map(|&[l0, l1, c0, c1]| {
                        (u16::from_le_bytes([l0, l1]), u16::from_le_bytes([c0, c1]))
                    })
                    .collect()
            })
            .unwrap_or_default();
        listed
            .into_iter()
            .chain(FALLBACK_TRANSLATIONS)
            .find_map(|(language, code_page)| {
                let key = format!(r"\StringFileInfo\{language:04X}{code_page:04X}\FileDescription");
                // A string's length is given in UTF-16 units.
                let bytes = value(&block, &key, |units| units.saturating_mul(2))?;
                let units: Vec<u16> = bytes
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|&unit| u16::from_le_bytes(unit))
                    .collect();
                trimmed(&units)
            })
    }

    /// The value at `sub_block` of the version resource read into `block`,
    /// as the bytes it spans there — `length` turns the length the call gives
    /// into bytes. `None` when there is no such value, or it would reach past
    /// the resource.
    fn value<'a>(
        block: &'a [u8],
        sub_block: &str,
        length: impl Fn(usize) -> usize,
    ) -> Option<&'a [u8]> {
        let sub_block = wide(sub_block);
        let mut found: *mut c_void = ptr::null_mut();
        let mut len = 0u32;
        // SAFETY: `block` is the resource GetFileVersionInfoExW filled, and
        // both out-pointers are valid; what `found` points at is read only
        // below, once it is known to lie within `block`.
        let ok = unsafe {
            VerQueryValueW(
                block.as_ptr().cast(),
                sub_block.as_ptr(),
                &mut found,
                &mut len,
            )
        };
        if ok == 0 || found.is_null() {
            return None;
        }
        let start = (found as usize).checked_sub(block.as_ptr() as usize)?;
        block.get(start..start.checked_add(length(len as usize))?)
    }

    /// `units` up to the first NUL, trimmed; `None` when nothing is left.
    fn trimmed(units: &[u16]) -> Option<String> {
        let units = units.split(|unit| *unit == 0).next().unwrap_or(units);
        let text = String::from_utf16_lossy(units);
        let text = text.trim();
        (!text.is_empty()).then(|| text.to_string())
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(Some(0)).collect()
    }

    /// COM, entered on this thread while the guard lives: the shell's names
    /// are read through it, and the virtual desktops asked (see
    /// `helper::hwnd`). A thread already in COM in the other mode stays so,
    /// which serves as well.
    pub(crate) struct Com(bool);

    impl Com {
        pub(crate) fn enter() -> Self {
            // SAFETY: no reserved pointer; a success (S_OK, or S_FALSE when
            // already entered) is balanced in `drop`.
            let status = unsafe { CoInitializeEx(ptr::null(), COINIT_MULTITHREADED) };
            Self(status >= 0)
        }
    }

    impl Drop for Com {
        fn drop(&mut self) {
            if self.0 {
                // SAFETY: balances the CoInitializeEx that succeeded.
                unsafe { CoUninitialize() };
            }
        }
    }

    /// An item id list the shell allocated, freed when dropped.
    struct IdList(*mut c_void);

    impl Drop for IdList {
        fn drop(&mut self) {
            // SAFETY: the list SHParseDisplayName returned, freed once.
            unsafe { ILFree(self.0) };
        }
    }

    /// A string the shell allocated with COM's allocator, freed when dropped.
    struct TaskString(*mut u16);

    impl TaskString {
        fn units(&self) -> Vec<u16> {
            let mut len = 0;
            // SAFETY: a NUL-terminated string, read up to its NUL.
            while unsafe { *self.0.add(len) } != 0 {
                len += 1;
            }
            // SAFETY: the `len` units just read before the NUL.
            unsafe { std::slice::from_raw_parts(self.0, len) }.to_vec()
        }
    }

    impl Drop for TaskString {
        fn drop(&mut self) {
            // SAFETY: the string SHGetNameFromIDList returned, freed once.
            unsafe { CoTaskMemFree(self.0.cast()) };
        }
    }
}

/// The application `executable` is the main executable of — or sits inside,
/// when it is the main executable of a helper application within another.
#[cfg(target_os = "macos")]
fn identify_executable(executable: &str) -> Option<AppIdentity> {
    let own = executable_bundle(executable)?;
    let app = outermost_app_bundle(own);
    if is_system_component(app) {
        return None;
    }
    let info = bundle_info(app)?;
    // Standing by itself, an application by its name or its own word; inside
    // another, by its name only (see the module note).
    let own_is_application = if own == app {
        is_application(own, info.package_type.as_deref())
    } else {
        has_app_extension(own)
    };
    if !own_is_application {
        return None;
    }
    Some(AppIdentity {
        path: app.to_string(),
        bundle_id: info.id?,
        plist_names: info.names,
        nested: own != app,
    })
}

/// The executable `pid` runs, as the kernel has it.
#[cfg(target_os = "macos")]
fn executable_path(pid: u32) -> Option<String> {
    let pid = libc::c_int::try_from(pid).ok().filter(|p| *p > 0)?;
    let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: `buf` is a live buffer of exactly the size passed; the call
    // writes at most that many bytes and returns how many it wrote.
    let written = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
    let written = usize::try_from(written).ok().filter(|n| *n > 0)?;
    buf.truncate(written);
    String::from_utf8(buf).ok()
}

/// What a bundle's `Info.plist` says of it.
#[cfg(target_os = "macos")]
#[derive(Debug, Default)]
struct BundleInfo {
    /// `CFBundleIdentifier`.
    id: Option<String>,
    /// `CFBundlePackageType`.
    package_type: Option<String>,
    /// `CFBundleDisplayName` and `CFBundleName`, where given.
    names: Vec<String>,
}

/// `bundle`'s `Info.plist`, XML or binary.
#[cfg(target_os = "macos")]
fn bundle_info(bundle: &str) -> Option<BundleInfo> {
    use std::io::Read;

    use core_foundation::base::{CFType, TCFType};
    use core_foundation::data::CFData;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::propertylist::{
        create_with_data, kCFPropertyListImmutable, CFPropertyList,
    };
    use core_foundation::string::CFString;

    let file =
        std::fs::File::open(std::path::Path::new(bundle).join("Contents/Info.plist")).ok()?;
    let mut bytes = Vec::new();
    file.take(MAX_INFO_PLIST + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > MAX_INFO_PLIST {
        return None;
    }
    let (raw, _format) =
        create_with_data(CFData::from_buffer(&bytes), kCFPropertyListImmutable).ok()?;
    // SAFETY: `create_with_data` returned a +1 property list, released by the
    // wrapper.
    let plist = unsafe { CFPropertyList::wrap_under_create_rule(raw) };
    let dict = plist.downcast_into::<CFDictionary>()?;
    // SAFETY: the same dictionary, viewed with the key and value types every
    // property-list dictionary has; retained by the view for its own life.
    let dict: CFDictionary<CFString, CFType> =
        unsafe { CFDictionary::wrap_under_get_rule(dict.as_concrete_TypeRef()) };
    let text = |key: &'static str| {
        dict.find(CFString::from_static_string(key))
            .and_then(|value| value.downcast::<CFString>())
            .map(|value| value.to_string())
            .filter(|value| !value.is_empty())
    };
    Some(BundleInfo {
        id: text("CFBundleIdentifier"),
        package_type: text("CFBundlePackageType"),
        names: ["CFBundleDisplayName", "CFBundleName"]
            .into_iter()
            .filter_map(text)
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The main executable of a bundle names the bundle, whatever the bundle
    /// is; anything else — an executable deeper inside, a bare one — names
    /// nothing.
    #[test]
    fn a_main_executable_names_its_bundle() {
        assert_eq!(
            executable_bundle("/Applications/Visual Studio Code.app/Contents/MacOS/Code"),
            Some("/Applications/Visual Studio Code.app")
        );
        assert_eq!(
            executable_bundle("/Applications/企业微信.app/Contents/MacOS/企业微信"),
            Some("/Applications/企业微信.app")
        );
        assert_eq!(
            executable_bundle(
                "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/\
                 Contents/MacOS/Code Helper"
            ),
            Some("/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app")
        );
        assert_eq!(
            executable_bundle(
                "/private/var/folders/xy/T/X/com.google.Chrome.code_sign_clone/\
                 code_sign_clone.V0opBB/Google Chrome.app.bundle/Contents/MacOS/Google Chrome"
            ),
            Some(
                "/private/var/folders/xy/T/X/com.google.Chrome.code_sign_clone/\
                 code_sign_clone.V0opBB/Google Chrome.app.bundle"
            )
        );
        for other in [
            "/Users/me/codeg/src-tauri/target/debug/codeg",
            "/Applications/Foo.app/Contents/Resources/bin/foo",
            "/Applications/Foo.app/Contents/MacOS/",
            "/Contents/MacOS/x",
            "codeg",
        ] {
            assert_eq!(executable_bundle(other), None, "{other}");
        }
    }

    /// An application is named `.app` or says it is one; a service, an
    /// extension or a framework is neither.
    #[test]
    fn an_application_is_named_so_or_says_so() {
        assert!(is_application("/Applications/Termius.app", None));
        assert!(is_application("/Applications/Termius.APP", Some("XPC!")));
        assert!(is_application(
            "/private/var/folders/xy/X/c/Google Chrome.app.bundle",
            Some("APPL")
        ));
        for (bundle, package_type) in [
            ("/private/var/folders/xy/X/c/Google Chrome.app.bundle", None),
            (
                "/System/Library/PrivateFrameworks/SafariPlatformSupport.framework/Versions/A/\
                 XPCServices/com.apple.SafariPlatformSupport.Helper.xpc",
                Some("XPC!"),
            ),
            (
                "/System/Library/ExtensionKit/Extensions/WebThumbnailExtension.appex",
                Some("XPC!"),
            ),
            ("/Applications/.app", None),
        ] {
            assert!(!is_application(bundle, package_type), "{bundle}");
        }
    }

    /// A helper application is the application it sits in; an application on
    /// its own is itself.
    #[test]
    fn a_nested_helper_is_the_application_it_sits_in() {
        assert_eq!(
            outermost_app_bundle(
                "/System/Applications/Passwords.app/Contents/Library/LoginItems/\
                 PasswordsMenuBarExtra.app"
            ),
            "/System/Applications/Passwords.app"
        );
        assert_eq!(
            outermost_app_bundle(
                "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app"
            ),
            "/Applications/Visual Studio Code.app"
        );
        assert_eq!(
            outermost_app_bundle("/Applications/企业微信.app"),
            "/Applications/企业微信.app"
        );
        assert_eq!(
            outermost_app_bundle("/Library/Foo.framework/Resources/Helper.app"),
            "/Library/Foo.framework/Resources/Helper.app"
        );
        assert_eq!(
            outermost_app_bundle("/private/var/folders/xy/X/c/Google Chrome.app.bundle"),
            "/private/var/folders/xy/X/c/Google Chrome.app.bundle"
        );
    }

    /// Apple's agents are system components; the applications Apple ships —
    /// in /System/Applications, the Safari cryptex, CoreServices'
    /// Applications folder — and the Finder are not, and nothing outside
    /// /System is.
    #[test]
    fn apples_agents_are_system_components_and_its_applications_are_not() {
        for component in [
            "/System/Library/CoreServices/loginwindow.app",
            "/System/Library/CoreServices/CoreServicesUIAgent.app",
            "/System/Library/CoreServices/ControlCenter.app",
            "/System/Library/CoreServices/WiFiAgent.app",
        ] {
            assert!(is_system_component(component), "{component}");
        }
        for application in [
            "/System/Applications/Notes.app",
            "/System/Applications/Utilities/Terminal.app",
            "/System/Cryptexes/App/System/Applications/Safari.app",
            "/System/Library/CoreServices/Applications/Archive Utility.app",
            "/System/Library/CoreServices/Finder.app",
            "/Applications/Clash Verge.app",
            "/Users/me/Applications/Tool.app",
        ] {
            assert!(!is_system_component(application), "{application}");
        }
    }

    fn identity(path: &str, names: &[&str], nested: bool) -> AppIdentity {
        AppIdentity {
            path: path.into(),
            bundle_id: "com.example".into(),
            plist_names: names.iter().map(|n| n.to_string()).collect(),
            nested,
        }
    }

    /// Named as the Finder names it: by the file name where the application
    /// only calls itself what its Info.plist says, by its own name where that
    /// is a translation, and by the owner's name for a clone, which is not
    /// named by its file.
    #[test]
    fn an_application_is_named_as_the_finder_names_it() {
        let code = identity(
            "/Applications/Visual Studio Code.app",
            &["Code", "Code"],
            false,
        );
        assert_eq!(code.name("Code"), "Visual Studio Code");
        assert_eq!(code.name(""), "Visual Studio Code");
        let finder = identity(FINDER, &["Finder"], false);
        assert_eq!(finder.name("访达"), "访达");
        let wps = identity(
            "/Applications/wpsoffice.app",
            &["wpsoffice", "wpsoffice"],
            false,
        );
        assert_eq!(wps.name("WPS Office"), "WPS Office");
        assert_eq!(wps.name("wpsoffice"), "wpsoffice");
        let chrome = identity(
            "/private/var/folders/xy/X/c/Google Chrome.app.bundle",
            &["Google Chrome", "Chrome"],
            false,
        );
        assert_eq!(chrome.name("Google Chrome"), "Google Chrome");
        assert_eq!(chrome.name(" "), "Google Chrome");
        // A helper inside: the application's file name, not the helper's.
        let helper = identity("/Applications/Google Chrome.app", &["Google Chrome"], true);
        assert_eq!(
            helper.name("Google Chrome Helper (Alerts)"),
            "Google Chrome"
        );
    }

    /// Windows: an executable is an application unless it is a host — by its
    /// file name, in any case and wherever it is — or one of the system's
    /// agents in the `SystemApps` folder of the system's Windows folder (in
    /// any folder named so, where the system will not say which that is). The
    /// applications Windows ships elsewhere, Settings and Edge among them,
    /// are applications, and so is one a person keeps in a `SystemApps`
    /// folder of their own. The frame host is told from the other hosts the
    /// same way.
    #[test]
    fn windows_applications_are_told_from_hosts_and_agents() {
        let system = Some(r"C:\Windows\SystemApps");
        for application in [
            r"C:\Windows\ImmersiveControlPanel\SystemSettings.exe",
            r"C:\Windows\explorer.exe",
            r"C:\Windows\System32\Taskmgr.exe",
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            r"C:\Program Files\WindowsApps\Microsoft.WindowsTerminal_1.23.0.0_x64__8wekyb3d8bbwe\WindowsTerminal.exe",
            r"C:\ApplicationFrameHost.exe\Other.exe",
            r"C:\Windows\System32\ApplicationFrameHost.exe.bak",
            r"C:\Tools\SystemApps.exe",
            r"C:\Windows\SystemAppsX\Thing.exe",
        ] {
            assert!(is_application_outside(application, system), "{application}");
            assert!(is_application_outside(application, None), "{application}");
        }
        for other in [
            r"C:\Windows\System32\ApplicationFrameHost.exe",
            r"c:\windows\system32\applicationframehost.EXE",
            r"C:\Program Files (x86)\Microsoft\EdgeWebView\Application\129.0.2792.79\msedgewebview2.exe",
            r"C:\Windows\SystemApps\microsoft.creddialoghost_cw5n1h2txyewy\CredDialogHost.exe",
            r"c:\windows\systemapps\Microsoft.LockApp_cw5n1h2txyewy\LockApp.exe",
            "C:/Windows/SystemApps/Microsoft.LockApp_cw5n1h2txyewy/LockApp.exe",
            r"C:\Windows\SystemApps\",
            "",
        ] {
            assert!(!is_application_outside(other, system), "{other}");
            assert!(!is_application_outside(other, None), "{other}");
        }
        // A `SystemApps` folder that is not the system's: a person's own is
        // theirs — unless the system will not say which is its own.
        for elsewhere in [
            r"C:\Tools\SystemApps\Thing\Thing.exe",
            r"D:\WINNT\systemapps\MicrosoftWindows.Client.CBS_cw5n1h2txyewy\TextInputHost.exe",
        ] {
            assert!(is_application_outside(elsewhere, system), "{elsewhere}");
            assert!(!is_application_outside(elsewhere, None), "{elsewhere}");
        }
        // The system's own folder, where it says.
        if let Some(folder) = system_apps_folder() {
            let lock = format!(r"{folder}\Microsoft.LockApp_cw5n1h2txyewy\LockApp.exe");
            assert!(!is_windows_application(&lock), "{lock}");
        }
        // Of the hosts, the frame host alone frames an application.
        assert!(is_frame_host(
            r"C:\Windows\System32\ApplicationFrameHost.exe"
        ));
        assert!(is_frame_host(
            r"c:\windows\system32\applicationframehost.EXE"
        ));
        for other in [
            r"C:\Program Files (x86)\Microsoft\EdgeWebView\Application\129.0.2792.79\msedgewebview2.exe",
            r"C:\ApplicationFrameHost.exe\Other.exe",
            r"C:\Windows\System32\ApplicationFrameHost.exe.bak",
            "",
        ] {
            assert!(!is_frame_host(other), "{other}");
        }
    }

    /// Windows: this test runner is read off its own process — by its full
    /// path, while it is the process that started when it did — and goes by
    /// its description, or its file name where it gives none.
    #[cfg(windows)]
    #[test]
    fn a_windows_application_is_its_executable() {
        let me = std::process::id();
        let started = crate::computer::procinfo::process_start(me).unwrap();
        let app = windows_application(me, started).expect("this process's executable");
        let exe = std::env::current_exe().unwrap();
        assert!(
            app.path.eq_ignore_ascii_case(&exe.to_string_lossy()),
            "{}",
            app.path
        );
        let file = exe.file_name().unwrap().to_string_lossy().into_owned();
        assert_eq!(
            app.name,
            windows_names::file_description(&app.path).unwrap_or(file),
            "{}",
            app.path
        );
        // A process that started at another time is another process.
        assert_eq!(windows_application(me, started.wrapping_add(1)), None);
        assert_eq!(windows_application(0, 0), None);
    }

    /// Windows: a system library describes itself, in whatever language;
    /// a file that is not there describes nothing, and the Start menu has no
    /// entry for an application that does not exist.
    #[cfg(windows)]
    #[test]
    fn windows_names_are_read_where_windows_keeps_them() {
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        let kernel = format!(r"{root}\System32\kernel32.dll");
        let description = windows_names::file_description(&kernel);
        assert!(
            description.as_deref().is_some_and(|d| !d.is_empty()),
            "{kernel}: {description:?}"
        );
        assert_eq!(
            windows_names::file_description(r"C:\nonexistent\Nothing.exe"),
            None
        );
        assert_eq!(
            windows_names::start_menu_name("Codeg.Nonexistent_0000000000000!App"),
            None
        );
    }

    /// This test runner is a bare executable, which is no application; the
    /// Finder, which every logged-in session runs, is one, with what it says
    /// of itself read from its own Info.plist.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_running_application_is_read_off_its_process() {
        assert_eq!(identify(std::process::id()), None);
        assert_eq!(identify(0), None);
        let finder = bundle_info(FINDER).expect("the Finder's Info.plist");
        assert_eq!(finder.id.as_deref(), Some("com.apple.finder"));
        assert!(finder.names.iter().any(|n| n == "Finder"));
        assert!(bundle_info("/nonexistent/Nothing.app").is_none());
    }

    /// A bundle on disk: an application by name or by its own word, a
    /// service by neither; inside another application, a helper named `.app`
    /// is that application, and a bundle that only says it is one is nothing.
    #[cfg(target_os = "macos")]
    #[test]
    fn bundles_on_disk_are_told_apart() {
        let root = tempfile::tempdir().unwrap();
        let bundle = |rel: &str, package_type: Option<&str>, id: &str| {
            let contents = root.path().join(rel).join("Contents");
            std::fs::create_dir_all(contents.join("MacOS")).unwrap();
            let package_type = package_type
                .map(|t| format!("<key>CFBundlePackageType</key><string>{t}</string>"))
                .unwrap_or_default();
            std::fs::write(
                contents.join("Info.plist"),
                format!(
                    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\
                     <plist version=\"1.0\"><dict>\
                     <key>CFBundleIdentifier</key><string>{id}</string>\
                     <key>CFBundleName</key><string>Short</string>\
                     {package_type}</dict></plist>"
                ),
            )
            .unwrap();
            format!("{}/Contents/MacOS/exe", root.path().join(rel).display())
        };
        let clone = bundle("c/Browser.app.bundle", Some("APPL"), "com.example.browser");
        let service = bundle("s/Service.xpc", Some("XPC!"), "com.example.service");
        let unmarked = bundle("u/Tool.bundle", None, "com.example.tool");
        let app = bundle("Suite.app", Some("APPL"), "com.example.suite");
        let helper = bundle("Suite.app/Contents/Library/Helper.app", None, "h");
        let inner_clone = bundle(
            "Suite.app/Contents/Library/Vault.app.bundle",
            Some("APPL"),
            "com.example.vault",
        );
        let inner_service = bundle(
            "Suite.app/Contents/XPCServices/Inner.xpc",
            Some("XPC!"),
            "i",
        );

        let clone = identify_executable(&clone).expect("a clone that says it is an application");
        assert_eq!(clone.bundle_id, "com.example.browser");
        assert!(!clone.nested);
        assert_eq!(clone.plist_names, vec!["Short".to_string()]);
        assert_eq!(identify_executable(&service), None);
        assert_eq!(identify_executable(&unmarked), None);
        assert_eq!(
            identify_executable(&app).unwrap().bundle_id,
            "com.example.suite"
        );
        let helper = identify_executable(&helper).expect("a helper application inside");
        assert_eq!(helper.bundle_id, "com.example.suite");
        assert!(helper.nested);
        // Taken for the suite, it would lose its own identifier — and its
        // place on a blocklist.
        assert_eq!(identify_executable(&inner_clone), None);
        assert_eq!(identify_executable(&inner_service), None);
    }
}
