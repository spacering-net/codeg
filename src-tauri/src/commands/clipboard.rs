//! Put files *themselves* — not their paths — on the OS clipboard, so a paste
//! in Finder / Explorer / Files (or any app that accepts dropped files) writes
//! a copy of the entry rather than its name. And the way back: read which
//! files a copy in one of those put there, so a paste into the composer can
//! attach them by path, as a drop does.
//!
//! Desktop only, and deliberately so. The clipboard belongs to the machine
//! running the UI, while a web or remote-desktop window's workspace lives on
//! whatever host serves it — a file "copied" there would land on the *server's*
//! clipboard, where nobody can paste it. The file tree therefore offers the
//! action only in pure-desktop mode, and this command has no HTTP twin for web
//! mode to reach in the first place.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::app_error::AppCommandError;

/// One entry the OS clipboard holds as a file.
///
/// A webview hands a page the `File`s of a paste without their paths; `name`
/// and `size` are what the composer pairs those back to these entries by.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardFile {
    pub path: String,
    /// The final path component, the name the webview gives the `File`.
    pub name: String,
    /// Byte length of a regular file; `None` for anything else.
    pub size: Option<u64>,
    pub is_dir: bool,
}

/// Describe the paths a clipboard reader found, keeping the entries a paste
/// can be attached from: absolute, still there, and named in UTF-8 (the
/// agent is handed the path as text).
pub fn describe_clipboard_files(paths: Vec<PathBuf>) -> Vec<ClipboardFile> {
    paths
        .into_iter()
        .filter_map(|path| {
            if !path.is_absolute() {
                return None;
            }
            let meta = std::fs::metadata(&path).ok()?;
            Some(ClipboardFile {
                name: path.file_name()?.to_str()?.to_string(),
                path: path.to_str()?.to_string(),
                size: meta.is_file().then_some(meta.len()),
                is_dir: meta.is_dir(),
            })
        })
        .collect()
}

/// The URIs in Nautilus' `x-special/gnome-copied-files` payload: the verb
/// (`copy` or `cut`) on the first line, then one URI per line.
#[cfg_attr(
    not(all(target_os = "linux", feature = "tauri-runtime")),
    allow(dead_code)
)]
fn gnome_copied_file_uris(payload: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(payload)
        .lines()
        .skip(1)
        .map(str::trim)
        .filter(|line| line.starts_with("file://"))
        .map(str::to_string)
        .collect()
}

/// Turn the request's raw strings into filesystem entries we are willing to
/// hand the OS clipboard.
///
/// Absolute-only: a relative path means nothing to the app doing the paste,
/// which has its own working directory. Existence is checked through
/// `symlink_metadata`, so a symlink is copyable as the link it is even when
/// its target is gone — `exists()` would follow it and reject a dangling one
/// the file tree happily shows.
///
/// Each string is taken **byte for byte**. Surrounding whitespace is part of a
/// POSIX filename — `report` and `report ` are two different files, both of
/// which the tree lists — and the caller hands over a path it built from that
/// tree, never something a human typed. Trimming here would quietly copy the
/// neighbouring file, or report a visible entry as missing.
pub fn resolve_clipboard_paths(paths: &[String]) -> Result<Vec<PathBuf>, AppCommandError> {
    if paths.is_empty() {
        return Err(AppCommandError::invalid_input(
            "at least one path is required to copy",
        ));
    }
    let mut resolved = Vec::with_capacity(paths.len());
    for raw in paths {
        if raw.is_empty() {
            return Err(AppCommandError::invalid_input("path must not be empty"));
        }
        let path = PathBuf::from(raw);
        if !path.is_absolute() {
            return Err(AppCommandError::invalid_input(format!(
                "path must be absolute: {raw}"
            )));
        }
        if std::fs::symlink_metadata(&path).is_err() {
            return Err(AppCommandError::not_found(format!(
                "path does not exist: {raw}"
            )));
        }
        resolved.push(path);
    }
    Ok(resolved)
}

/// `file://` URI for an absolute path, percent-encoding every byte outside the
/// RFC 3986 unreserved set so spaces and non-ASCII names survive the trip.
///
/// Only the Linux backend speaks URIs (`text/uri-list` /
/// `x-special/gnome-copied-files`); macOS takes `NSURL`s and Windows takes raw
/// wide-char paths. It stays compiled — and tested — everywhere so the encoding
/// rule is not a thing only a Linux CI run can check.
///
/// The one non-test caller therefore exists only in a Linux **desktop** build:
/// `platform` is behind `tauri-runtime`, so a Linux `codeg-server` build has no
/// caller at all and would otherwise trip `-D dead-code`.
#[cfg_attr(
    not(all(target_os = "linux", feature = "tauri-runtime")),
    allow(dead_code)
)]
fn file_uri(path: &Path) -> String {
    const UNRESERVED_EXTRA: &[u8] = b"-._~/";
    let mut uri = String::from("file://");
    for byte in path.to_string_lossy().as_bytes() {
        if byte.is_ascii_alphanumeric() || UNRESERVED_EXTRA.contains(byte) {
            uri.push(*byte as char);
        } else {
            uri.push_str(&format!("%{byte:02X}"));
        }
    }
    uri
}

/// Copy the given filesystem entries onto the system clipboard as files.
///
/// `paths` must be absolute; every entry has to exist. Succeeding means the
/// clipboard now advertises those files — on Linux that advertisement is only
/// live while codeg runs, which is how every GTK app behaves.
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn copy_files_to_clipboard(
    app: tauri::AppHandle,
    paths: Vec<String>,
) -> Result<(), AppCommandError> {
    let resolved = resolve_clipboard_paths(&paths)?;
    platform::write_files(&app, resolved).map_err(|detail| {
        AppCommandError::io_error("failed to copy the files to the clipboard").with_detail(detail)
    })
}

/// The files the OS clipboard holds, as a copy in Finder / Explorer / a Linux
/// file manager put them there. Empty when it holds none.
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn read_clipboard_files(
    app: tauri::AppHandle,
) -> Result<Vec<ClipboardFile>, AppCommandError> {
    let paths = platform::read_files(&app).map_err(|detail| {
        AppCommandError::io_error("failed to read the files on the clipboard").with_detail(detail)
    })?;
    Ok(describe_clipboard_files(paths))
}

/// The per-OS clipboard writers and readers. Each writer takes ownership of
/// the resolved paths because the work may have to hop onto another thread to
/// reach the window toolkit.
#[cfg(feature = "tauri-runtime")]
mod platform {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    use tauri::AppHandle;

    /// Run `f` on the UI thread and wait for its answer.
    ///
    /// AppKit's pasteboard and GTK's clipboard are both main-thread affairs.
    /// The hop is unconditional because the only caller is an `async`
    /// `tauri::command`, whose body Tauri always drives on the async runtime —
    /// never the main thread, where blocking on the reply would deadlock.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn run_on_main<R: Send + 'static>(
        app: &AppHandle,
        f: impl FnOnce() -> R + Send + 'static,
    ) -> Result<R, String> {
        let (tx, rx) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || {
            let _ = tx.send(f());
        })
        .map_err(|e| e.to_string())?;
        rx.recv().map_err(|e| e.to_string())
    }

    /// macOS: file URLs on the general pasteboard. `NSURL` conforms to
    /// `NSPasteboardWriting`, so Finder, Mail and every document app read the
    /// entry as a real file rather than as its path string.
    #[cfg(target_os = "macos")]
    pub fn write_files(app: &AppHandle, paths: Vec<std::path::PathBuf>) -> Result<(), String> {
        use objc2::rc::Retained;
        use objc2::runtime::ProtocolObject;
        use objc2_app_kit::{NSPasteboard, NSPasteboardWriting};
        use objc2_foundation::{NSArray, NSString, NSURL};

        run_on_main(app, move || {
            let writers: Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>> = paths
                .iter()
                .map(|path| {
                    let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
                    ProtocolObject::from_retained(url)
                })
                .collect();
            let pasteboard = NSPasteboard::generalPasteboard();
            pasteboard.clearContents();
            if pasteboard.writeObjects(&NSArray::from_retained_slice(&writers)) {
                Ok(())
            } else {
                Err("the pasteboard refused the file URLs".to_string())
            }
        })?
    }

    /// macOS: the file URL on each item of the general pasteboard, one item
    /// per copied file as Finder writes them. A file reference URL
    /// (`file:///.file/id=…`) is resolved to the path it points at.
    #[cfg(target_os = "macos")]
    pub fn read_files(app: &AppHandle) -> Result<Vec<std::path::PathBuf>, String> {
        use objc2_app_kit::{NSPasteboard, NSPasteboardTypeFileURL};
        use objc2_foundation::NSURL;

        run_on_main(app, || {
            let Some(items) = NSPasteboard::generalPasteboard().pasteboardItems() else {
                return Vec::new();
            };
            items
                .iter()
                .filter_map(|item| {
                    // SAFETY: an AppKit constant, initialized before main.
                    let file_url = item.stringForType(unsafe { NSPasteboardTypeFileURL })?;
                    let url = NSURL::URLWithString(&file_url)?.filePathURL()?;
                    Some(std::path::PathBuf::from(url.path()?.to_string()))
                })
                .collect()
        })
    }

    /// Linux: GTK owns the CLIPBOARD selection and serves the data lazily, so
    /// the three flavours a paste target might ask for are all advertised at
    /// once and rendered on demand:
    ///
    /// * `x-special/gnome-copied-files` — what Nautilus/Nemo/Caja paste from,
    ///   and the only one carrying the copy-vs-cut verb.
    /// * `text/uri-list` — the cross-desktop drag-and-drop flavour.
    /// * `UTF8_STRING` — a plain-text fallback for everything else.
    ///
    /// Lazy serving is also why the data dies with the process: nothing but a
    /// running clipboard manager can outlive the owner, which is how every GTK
    /// app behaves.
    #[cfg(target_os = "linux")]
    pub fn write_files(app: &AppHandle, paths: Vec<std::path::PathBuf>) -> Result<(), String> {
        use gtk::{gdk, Clipboard, TargetEntry, TargetFlags};

        const TARGET_GNOME: u32 = 0;
        const TARGET_URI_LIST: u32 = 1;
        const TARGET_TEXT: u32 = 2;

        let uris: Vec<String> = paths.iter().map(|path| super::file_uri(path)).collect();
        // Nautilus' format: the verb, then one URI per line.
        let gnome_payload = std::iter::once("copy".to_string())
            .chain(uris.iter().cloned())
            .collect::<Vec<_>>()
            .join("\n");
        let text_payload = paths
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("\n");

        run_on_main(app, move || {
            let targets = [
                TargetEntry::new(
                    "x-special/gnome-copied-files",
                    TargetFlags::empty(),
                    TARGET_GNOME,
                ),
                TargetEntry::new("text/uri-list", TargetFlags::empty(), TARGET_URI_LIST),
                TargetEntry::new("UTF8_STRING", TargetFlags::empty(), TARGET_TEXT),
            ];
            let clipboard = Clipboard::get(&gdk::SELECTION_CLIPBOARD);
            let served = clipboard.set_with_data(&targets, move |_, selection, info| {
                match info {
                    TARGET_GNOME => {
                        // `target()` is the atom the requester asked for, which
                        // saves interning our own copy of the name.
                        selection.set(&selection.target(), 8, gnome_payload.as_bytes());
                    }
                    TARGET_URI_LIST => {
                        let borrowed: Vec<&str> = uris.iter().map(String::as_str).collect();
                        selection.set_uris(&borrowed);
                    }
                    _ => {
                        selection.set_text(&text_payload);
                    }
                }
            });
            if served {
                Ok(())
            } else {
                Err("GTK refused ownership of the clipboard selection".to_string())
            }
        })?
    }

    /// Linux: the `text/uri-list` a file manager offers for copied files, or,
    /// when that is empty, Nautilus' own `x-special/gnome-copied-files`. GTK
    /// answers on the main loop, so the request is made there and the reply
    /// awaited here, never on the main thread itself.
    #[cfg(target_os = "linux")]
    pub fn read_files(app: &AppHandle) -> Result<Vec<std::path::PathBuf>, String> {
        use gtk::{gdk, glib, Clipboard};

        let (tx, rx) = std::sync::mpsc::channel::<Vec<String>>();
        run_on_main(app, move || {
            let clipboard = Clipboard::get(&gdk::SELECTION_CLIPBOARD);
            clipboard.request_uris(move |clipboard, uris| {
                if !uris.is_empty() {
                    let _ = tx.send(uris.iter().map(|uri| uri.to_string()).collect());
                    return;
                }
                let gnome = gdk::Atom::intern("x-special/gnome-copied-files");
                clipboard.request_contents(&gnome, move |_, selection| {
                    let _ = tx.send(super::gnome_copied_file_uris(&selection.data()));
                });
            });
        })?;
        let uris = rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .map_err(|e| format!("the clipboard did not answer: {e}"))?;
        Ok(uris
            .iter()
            .filter_map(|uri| glib::filename_from_uri(uri).ok())
            .map(|(path, _host)| path)
            .collect())
    }

    /// Windows: `CF_HDROP` — a `DROPFILES` header followed by a
    /// double-NUL-terminated list of wide-char paths, which is exactly what
    /// Explorer produces for Ctrl+C and what every shell target pastes.
    ///
    /// `SetClipboardData` hands the block to the system on success, so the
    /// allocation is only freed on the failure paths.
    #[cfg(target_os = "windows")]
    pub fn write_files(
        _app: &tauri::AppHandle,
        paths: Vec<std::path::PathBuf>,
    ) -> Result<(), String> {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Foundation::{GlobalFree, HGLOBAL, POINT};
        use windows_sys::Win32::System::DataExchange::{
            CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
        };
        use windows_sys::Win32::System::Memory::{
            GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE,
        };
        use windows_sys::Win32::System::Ole::CF_HDROP;
        use windows_sys::Win32::UI::Shell::DROPFILES;

        let mut names: Vec<u16> = Vec::new();
        for path in &paths {
            names.extend(path.as_os_str().encode_wide());
            names.push(0);
        }
        // The list itself is NUL-terminated on top of each entry's own NUL.
        names.push(0);

        let header_size = std::mem::size_of::<DROPFILES>();
        let total = header_size + names.len() * std::mem::size_of::<u16>();

        // SAFETY: every pointer below is derived from this one allocation and
        // stays inside `total` bytes; the block is unlocked before it is either
        // handed to the clipboard or freed.
        unsafe {
            let handle: HGLOBAL = GlobalAlloc(GMEM_MOVEABLE, total);
            if handle.is_null() {
                return Err("could not allocate the clipboard buffer".to_string());
            }
            let base = GlobalLock(handle);
            if base.is_null() {
                GlobalFree(handle);
                return Err("could not lock the clipboard buffer".to_string());
            }
            let header = base.cast::<DROPFILES>();
            header.write(DROPFILES {
                // Where the path list starts, measured from the header.
                pFiles: header_size as u32,
                pt: POINT { x: 0, y: 0 },
                fNC: 0,
                // Wide-char path list.
                fWide: 1,
            });
            std::ptr::copy_nonoverlapping(
                names.as_ptr(),
                base.cast::<u8>().add(header_size).cast::<u16>(),
                names.len(),
            );
            GlobalUnlock(handle);

            if OpenClipboard(std::ptr::null_mut()) == 0 {
                GlobalFree(handle);
                return Err("another application is holding the clipboard".to_string());
            }
            EmptyClipboard();
            let owned = SetClipboardData(CF_HDROP as u32, handle);
            CloseClipboard();
            if owned.is_null() {
                // Ownership never transferred, so the buffer is still ours.
                GlobalFree(handle);
                return Err("the clipboard refused the file list".to_string());
            }
        }
        Ok(())
    }

    /// Windows: the `CF_HDROP` list Explorer puts on the clipboard for Ctrl+C.
    /// The clipboard keeps owning the block; it is only read while open.
    #[cfg(target_os = "windows")]
    pub fn read_files(_app: &tauri::AppHandle) -> Result<Vec<std::path::PathBuf>, String> {
        use std::os::windows::ffi::OsStringExt;
        use windows_sys::Win32::System::DataExchange::{
            CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
        };
        use windows_sys::Win32::System::Ole::CF_HDROP;
        use windows_sys::Win32::UI::Shell::{DragQueryFileW, HDROP};

        // SAFETY: the handle is only used between `OpenClipboard` and
        // `CloseClipboard`, and every buffer handed to `DragQueryFileW` is
        // sized from the length it reported for that entry.
        unsafe {
            if IsClipboardFormatAvailable(CF_HDROP as u32) == 0 {
                return Ok(Vec::new());
            }
            if OpenClipboard(std::ptr::null_mut()) == 0 {
                return Err("another application is holding the clipboard".to_string());
            }
            let hdrop: HDROP = GetClipboardData(CF_HDROP as u32);
            let mut paths = Vec::new();
            if !hdrop.is_null() {
                let count = DragQueryFileW(hdrop, u32::MAX, std::ptr::null_mut(), 0);
                for index in 0..count {
                    let len = DragQueryFileW(hdrop, index, std::ptr::null_mut(), 0);
                    let mut name = vec![0u16; len as usize + 1];
                    let copied = DragQueryFileW(hdrop, index, name.as_mut_ptr(), name.len() as u32);
                    name.truncate(copied as usize);
                    paths.push(std::path::PathBuf::from(std::ffi::OsString::from_wide(
                        &name,
                    )));
                }
            }
            CloseClipboard();
            Ok(paths)
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    pub fn write_files(
        _app: &tauri::AppHandle,
        _paths: Vec<std::path::PathBuf>,
    ) -> Result<(), String> {
        Err("copying files to the clipboard is not supported on this platform".to_string())
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    pub fn read_files(_app: &tauri::AppHandle) -> Result<Vec<std::path::PathBuf>, String> {
        Ok(Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_an_empty_request() {
        let err = resolve_clipboard_paths(&[]).expect_err("empty");
        assert!(err.message.contains("at least one path"), "{err:?}");
    }

    #[test]
    fn rejects_a_relative_path() {
        let err = resolve_clipboard_paths(&["src/lib.rs".to_string()]).expect_err("relative");
        assert!(err.message.contains("absolute"), "{err:?}");
    }

    #[test]
    fn rejects_a_path_that_is_gone() {
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = dir.path().join("nope.txt");
        let err = resolve_clipboard_paths(&[missing.to_string_lossy().into_owned()])
            .expect_err("missing");
        assert!(err.message.contains("does not exist"), "{err:?}");
    }

    #[test]
    fn accepts_existing_files_and_directories() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("a b.txt");
        std::fs::write(&file, b"x").expect("write");
        let resolved = resolve_clipboard_paths(&[
            file.to_string_lossy().into_owned(),
            dir.path().to_string_lossy().into_owned(),
        ])
        .expect("resolve");
        assert_eq!(resolved, vec![file, dir.path().to_path_buf()]);
    }

    #[test]
    #[cfg(unix)]
    fn keeps_a_filename_whose_name_ends_in_a_space() {
        // `report` and `report ` are two different files and the tree lists
        // both, so trimming the request would copy the WRONG one — silently,
        // because the trimmed path exists too.
        let dir = tempfile::tempdir().expect("tempdir");
        let plain = dir.path().join("report");
        let padded = dir.path().join("report ");
        std::fs::write(&plain, b"plain").expect("write");
        std::fs::write(&padded, b"padded").expect("write");
        let resolved =
            resolve_clipboard_paths(&[padded.to_string_lossy().into_owned()]).expect("resolve");
        assert_eq!(resolved, vec![padded]);
    }

    #[test]
    #[cfg(unix)]
    fn accepts_a_dangling_symlink() {
        // The tree shows broken links, so "copy the file itself" has to mean
        // the link — `Path::exists()` would follow it and call it missing.
        let dir = tempfile::tempdir().expect("tempdir");
        let link = dir.path().join("broken");
        std::os::unix::fs::symlink(dir.path().join("gone"), &link).expect("symlink");
        let resolved =
            resolve_clipboard_paths(&[link.to_string_lossy().into_owned()]).expect("resolve");
        assert_eq!(resolved, vec![link]);
    }

    #[test]
    fn percent_encodes_everything_outside_the_unreserved_set() {
        assert_eq!(
            file_uri(Path::new("/home/me/a b.txt")),
            "file:///home/me/a%20b.txt"
        );
        assert_eq!(
            file_uri(Path::new("/home/me/说明.md")),
            "file:///home/me/%E8%AF%B4%E6%98%8E.md"
        );
        // `#` and `?` would otherwise start a fragment / query.
        assert_eq!(
            file_uri(Path::new("/tmp/a#b?c.txt")),
            "file:///tmp/a%23b%3Fc.txt"
        );
        // Unreserved characters stay literal.
        assert_eq!(
            file_uri(Path::new("/tmp/a-b_c.d~e/f")),
            "file:///tmp/a-b_c.d~e/f"
        );
    }

    #[test]
    fn describes_files_and_folders_by_name_and_size() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("bundle.zip");
        std::fs::write(&file, b"PK\x05\x06").expect("write");
        let folder = dir.path().join("assets");
        std::fs::create_dir(&folder).expect("mkdir");

        let described = describe_clipboard_files(vec![file.clone(), folder.clone()]);
        assert_eq!(
            described,
            vec![
                ClipboardFile {
                    path: file.to_string_lossy().into_owned(),
                    name: "bundle.zip".to_string(),
                    size: Some(4),
                    is_dir: false,
                },
                ClipboardFile {
                    path: folder.to_string_lossy().into_owned(),
                    name: "assets".to_string(),
                    size: None,
                    is_dir: true,
                },
            ]
        );
    }

    #[test]
    fn crosses_the_ipc_in_the_shape_the_composer_reads() {
        let entry = ClipboardFile {
            path: "/work/assets".to_string(),
            name: "assets".to_string(),
            size: None,
            is_dir: true,
        };
        assert_eq!(
            serde_json::to_value(&entry).expect("serialize"),
            serde_json::json!({
                "path": "/work/assets",
                "name": "assets",
                "size": null,
                "isDir": true,
            })
        );
    }

    #[test]
    fn leaves_out_what_a_paste_cannot_attach() {
        let dir = tempfile::tempdir().expect("tempdir");
        let gone = dir.path().join("gone.txt");
        let relative = PathBuf::from("relative.txt");
        assert_eq!(describe_clipboard_files(vec![gone, relative]), vec![]);
    }

    #[test]
    fn reads_the_uris_out_of_a_gnome_copied_files_payload() {
        assert_eq!(
            gnome_copied_file_uris(b"copy\nfile:///home/me/a%20b.txt\nfile:///home/me/dir\n"),
            vec!["file:///home/me/a%20b.txt", "file:///home/me/dir"]
        );
        // `cut` is a verb too, and anything that is not a file URI is skipped.
        assert_eq!(
            gnome_copied_file_uris(b"cut\r\nfile:///x\r\nhttps://example.com\r\n"),
            vec!["file:///x"]
        );
        assert!(gnome_copied_file_uris(b"").is_empty());
    }
}
