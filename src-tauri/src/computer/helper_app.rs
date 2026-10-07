//! The helper app as codeg runs it on macOS: a copy outside codeg's bundle.
//!
//! codeg ships the helper as an app of its own inside its bundle
//! (`Contents/Helpers/codeg-computer-helper.app`), and for Accessibility that
//! is enough: macOS charges a process to the app it is the main executable
//! of. Screen Recording it charges to the *outermost* app around the
//! executable that the same team signed — codeg — so a helper run from inside
//! codeg's bundle would ask for Screen Recording in codeg's name and record
//! the screen on codeg's grant, which every agent's shell shares.
//!
//! So codeg runs the helper from a copy of the shipped app in the helper's
//! data directory, where no app of codeg's is around it. The copy is the
//! shipped app byte for byte — the same signature, so the same launch
//! requirement holds it and the grants are the same ones — and codeg brings
//! it up to date before every launch: a copy that is missing, or that differs
//! from the shipped app in any way (an update, a damaged or altered copy), is
//! replaced whole by one made beside it, so a launch never finds half of one.
//! Extended attributes are left behind: the signature does not cover them,
//! and a quarantine flag on the copy would only have Gatekeeper assess it
//! again.

use std::ffi::OsString;
use std::fs::{self, File, OpenOptions, Permissions};
use std::io::{self, Read};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Make the copy of `shipped`, an app bundle, in `home` the same as it, and
/// say where the copy is.
pub fn install(shipped: &Path, home: &Path) -> io::Result<PathBuf> {
    // One at a time: the running helper and a permission request can both be
    // starting, and codeg runs as a single instance, so this process is the
    // only one to do it.
    static INSTALLING: Mutex<()> = Mutex::new(());
    let _one = INSTALLING.lock().unwrap_or_else(|p| p.into_inner());

    let name = shipped
        .file_name()
        .ok_or_else(|| io::Error::other(format!("{} names no app", shipped.display())))?;
    let installed = home.join(name);
    if same_tree(shipped, &installed)? {
        return Ok(installed);
    }
    fs::create_dir_all(home)?;
    // Made beside it under a name nothing launches or lists as an app, then
    // put in its place.
    let mut prefix = OsString::from(".");
    prefix.push(name);
    prefix.push(".");
    sweep(home, &prefix);
    let mut staging = prefix;
    staging.push(format!("{}.{}.incoming", std::process::id(), unique()));
    let staging = home.join(staging);
    let made = copy_tree(shipped, &staging).and_then(|()| put_in_place(&staging, &installed));
    if made.is_err() {
        let _ = remove_entry(&staging);
    }
    made.map(|()| installed)
}

/// Throw away what earlier installs left in `home` under names starting with
/// `prefix` — a launch that died part-way, a copy that would not delete.
fn sweep(home: &Path, prefix: &OsString) {
    let Ok(entries) = fs::read_dir(home) else {
        return;
    };
    for entry in entries.flatten() {
        if entry
            .file_name()
            .as_encoded_bytes()
            .starts_with(prefix.as_encoded_bytes())
        {
            let _ = remove_entry(&entry.path());
        }
    }
}

/// Different on every call in this process.
fn unique() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

/// Move `staging` to `installed`: exchanged with what is there in one step,
/// the old one then thrown away. A helper still running from the old one
/// keeps its image.
fn put_in_place(staging: &Path, installed: &Path) -> io::Result<()> {
    if fs::symlink_metadata(installed).is_err() {
        return fs::rename(staging, installed);
    }
    match exchange(staging, installed) {
        Ok(()) => {
            // `staging` now holds what was in place.
            let _ = remove_entry(staging);
            Ok(())
        }
        // A file system that cannot exchange two names, or something in the
        // copy's place it will not exchange with a directory.
        Err(_) => replace_by_renames(staging, installed),
    }
}

/// Put `staging` in `installed`'s place in two renames: the old one aside,
/// the new one in — and the old one back, should the new one not go in.
fn replace_by_renames(staging: &Path, installed: &Path) -> io::Result<()> {
    let aside = staging.with_extension("outgoing");
    fs::rename(installed, &aside)?;
    if let Err(e) = fs::rename(staging, installed) {
        let _ = fs::rename(&aside, installed);
        return Err(e);
    }
    let _ = remove_entry(&aside);
    Ok(())
}

/// Swap what two paths name, atomically (`renamex_np` with `RENAME_SWAP`).
fn exchange(a: &Path, b: &Path) -> io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let a = CString::new(a.as_os_str().as_bytes())?;
    let b = CString::new(b.as_os_str().as_bytes())?;
    // SAFETY: two NUL-terminated paths that outlive the call.
    if unsafe { libc::renamex_np(a.as_ptr(), b.as_ptr(), libc::RENAME_SWAP) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// Remove whatever `path` names — a directory and all in it, a file, a link
/// (not what it points at) — and nothing when it names nothing.
fn remove_entry(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
    }
}

/// Whether `copy` holds what `original` does: the same names, kinds,
/// permission bits, bytes and link targets all the way down. Trouble reading
/// `original` is an error; anything wrong with `copy` is only a difference.
fn same_tree(original: &Path, copy: &Path) -> io::Result<bool> {
    let meta = fs::symlink_metadata(original)?;
    let Ok(copied) = fs::symlink_metadata(copy) else {
        return Ok(false);
    };
    let kind = meta.file_type();
    if kind != copied.file_type() {
        return Ok(false);
    }
    if kind.is_symlink() {
        return Ok(fs::read_link(copy).ok() == Some(fs::read_link(original)?));
    }
    if mode(&meta) != mode(&copied) {
        return Ok(false);
    }
    if kind.is_dir() {
        let names = names_in(original)?;
        if names_in(copy).ok().as_ref() != Some(&names) {
            return Ok(false);
        }
        for name in &names {
            if !same_tree(&original.join(name), &copy.join(name))? {
                return Ok(false);
            }
        }
        return Ok(true);
    }
    if kind.is_file() {
        return Ok(meta.len() == copied.len() && same_bytes(original, copy)?);
    }
    Err(not_copied(original))
}

/// Whether two files hold the same bytes. Trouble reading `original` is an
/// error; trouble reading `copy` is a difference.
fn same_bytes(original: &Path, copy: &Path) -> io::Result<bool> {
    let mut original = File::open(original)?;
    let Ok(mut copy) = File::open(copy) else {
        return Ok(false);
    };
    let mut theirs = vec![0u8; 64 * 1024];
    let mut ours = vec![0u8; 64 * 1024];
    loop {
        let n = fill(&mut original, &mut theirs)?;
        let Ok(m) = fill(&mut copy, &mut ours) else {
            return Ok(false);
        };
        if theirs[..n] != ours[..m] {
            return Ok(false);
        }
        if n == 0 {
            return Ok(true);
        }
    }
}

/// Read into `buf` until it is full or the file ends; how much was read.
fn fill(file: &mut File, buf: &mut [u8]) -> io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        match file.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(filled)
}

/// Copy `original` to `copy`, which does not exist yet: directories, files
/// (their bytes and permission bits, nothing else) and links, all the way
/// down.
fn copy_tree(original: &Path, copy: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(original)?;
    let kind = meta.file_type();
    if kind.is_symlink() {
        return std::os::unix::fs::symlink(fs::read_link(original)?, copy);
    }
    if kind.is_dir() {
        fs::create_dir(copy)?;
        for name in names_in(original)? {
            copy_tree(&original.join(&name), &copy.join(&name))?;
        }
    } else if kind.is_file() {
        let mut from = File::open(original)?;
        let mut to = OpenOptions::new().write(true).create_new(true).open(copy)?;
        io::copy(&mut from, &mut to)?;
        to.sync_all()?;
    } else {
        return Err(not_copied(original));
    }
    // Last, so a directory is still writable while it fills; and set outright,
    // so the umask leaves no mark.
    fs::set_permissions(copy, Permissions::from_mode(mode(&meta)))
}

/// A directory's entries, by name, in order.
fn names_in(dir: &Path) -> io::Result<Vec<OsString>> {
    let mut names = fs::read_dir(dir)?
        .map(|entry| entry.map(|e| e.file_name()))
        .collect::<io::Result<Vec<_>>>()?;
    names.sort();
    Ok(names)
}

/// The permission bits, without the file type or the set-id bits.
fn mode(meta: &fs::Metadata) -> u32 {
    meta.permissions().mode() & 0o777
}

fn not_copied(path: &Path) -> io::Error {
    io::Error::other(format!(
        "{} is not a file, a directory or a link",
        path.display()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::MetadataExt;

    const APP: &str = "codeg-computer-helper.app";

    /// A small app bundle, as the release ships the helper.
    fn shipped(root: &Path) -> PathBuf {
        let app = root.join("codeg.app/Contents/Helpers").join(APP);
        let exe = app.join("Contents/MacOS/codeg-computer-helper");
        fs::create_dir_all(exe.parent().unwrap()).unwrap();
        fs::create_dir_all(app.join("Contents/Resources")).unwrap();
        fs::create_dir_all(app.join("Contents/_CodeSignature")).unwrap();
        fs::write(&exe, vec![7u8; 200 * 1024]).unwrap();
        fs::set_permissions(&exe, Permissions::from_mode(0o755)).unwrap();
        fs::write(app.join("Contents/Info.plist"), b"<plist/>").unwrap();
        fs::write(app.join("Contents/Resources/icon.icns"), b"icon").unwrap();
        fs::write(app.join("Contents/_CodeSignature/CodeResources"), b"seal").unwrap();
        app
    }

    fn exe_of(app: &Path) -> PathBuf {
        app.join("Contents/MacOS/codeg-computer-helper")
    }

    /// The first launch makes the copy, beside nothing of codeg's, and the
    /// copy is the shipped app: names, bytes, permission bits.
    #[test]
    fn the_copy_is_the_shipped_app() {
        let root = tempfile::tempdir().unwrap();
        let app = shipped(root.path());
        let home = root.path().join("data/computer-helper");
        let installed = install(&app, &home).unwrap();
        assert_eq!(installed, home.join(APP));
        assert!(same_tree(&app, &installed).unwrap());
        assert_eq!(
            fs::metadata(exe_of(&installed))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o755
        );
        assert_eq!(fs::read(exe_of(&installed)).unwrap(), vec![7u8; 200 * 1024]);
        // Nothing else was left in the directory.
        assert_eq!(names_in(&home).unwrap(), vec![OsString::from(APP)]);
    }

    /// A copy already the same is left as it is: nothing is rewritten under
    /// a helper that may be running from it.
    #[test]
    fn a_current_copy_is_left_alone() {
        let root = tempfile::tempdir().unwrap();
        let app = shipped(root.path());
        let home = root.path().join("home");
        let installed = install(&app, &home).unwrap();
        let before = fs::metadata(exe_of(&installed)).unwrap().ino();
        install(&app, &home).unwrap();
        assert_eq!(fs::metadata(exe_of(&installed)).unwrap().ino(), before);
    }

    /// Any difference brings in a fresh copy: an update, a changed byte, a
    /// lost permission bit, a file added or taken away.
    #[test]
    fn any_difference_brings_a_fresh_copy() {
        let root = tempfile::tempdir().unwrap();
        let app = shipped(root.path());
        let home = root.path().join("home");
        let installed = install(&app, &home).unwrap();
        type Damage = fn(&Path);
        let damage: [(&str, Damage); 5] = [
            ("a byte", |i| {
                let mut bytes = fs::read(exe_of(i)).unwrap();
                bytes[100_000] ^= 1;
                fs::write(exe_of(i), bytes).unwrap();
            }),
            ("a bit", |i| {
                fs::set_permissions(exe_of(i), Permissions::from_mode(0o644)).unwrap()
            }),
            ("an added file", |i| {
                fs::write(i.join("Contents/.DS_Store"), b"").unwrap()
            }),
            ("a missing file", |i| {
                fs::remove_file(i.join("Contents/Info.plist")).unwrap()
            }),
            ("a link in a file's place", |i| {
                let plist = i.join("Contents/Info.plist");
                fs::remove_file(&plist).unwrap();
                std::os::unix::fs::symlink("/etc/hosts", &plist).unwrap();
            }),
        ];
        for (what, damage) in damage {
            damage(&installed);
            assert!(!same_tree(&app, &installed).unwrap(), "{what}");
            assert_eq!(install(&app, &home).unwrap(), installed);
            assert!(same_tree(&app, &installed).unwrap(), "{what}");
            assert_eq!(
                names_in(&home).unwrap(),
                vec![OsString::from(APP)],
                "{what}"
            );
        }
        // An update: the shipped app changed.
        fs::write(exe_of(&app), b"the next release").unwrap();
        install(&app, &home).unwrap();
        assert_eq!(fs::read(exe_of(&installed)).unwrap(), b"the next release");
    }

    /// The old copy goes out in one exchange: a helper running from it keeps
    /// the file it was started from.
    #[test]
    fn a_running_copy_keeps_its_file() {
        let root = tempfile::tempdir().unwrap();
        let app = shipped(root.path());
        let home = root.path().join("home");
        let installed = install(&app, &home).unwrap();
        let mut open = File::open(exe_of(&installed)).unwrap();
        fs::write(exe_of(&app), b"newer").unwrap();
        install(&app, &home).unwrap();
        let mut old = Vec::new();
        open.read_to_end(&mut old).unwrap();
        assert_eq!(old, vec![7u8; 200 * 1024]);
        assert_eq!(fs::read(exe_of(&installed)).unwrap(), b"newer");
    }

    /// What a launch that died part-way left behind goes, and a file or a
    /// link where the copy belongs is replaced like any other difference.
    #[test]
    fn leftovers_and_impostors_are_cleared() {
        let root = tempfile::tempdir().unwrap();
        let app = shipped(root.path());
        let home = root.path().join("home");
        let leftover = home.join(format!(".{APP}.1.0.incoming"));
        fs::create_dir_all(leftover.join("Contents")).unwrap();
        fs::write(home.join(APP), b"not an app").unwrap();
        let installed = install(&app, &home).unwrap();
        assert!(same_tree(&app, &installed).unwrap());
        assert!(!leftover.exists());

        let elsewhere = root.path().join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        fs::remove_dir_all(&installed).unwrap();
        std::os::unix::fs::symlink(&elsewhere, &installed).unwrap();
        install(&app, &home).unwrap();
        assert!(fs::symlink_metadata(&installed).unwrap().is_dir());
        assert!(same_tree(&app, &installed).unwrap());
        // The link went, not what it pointed at.
        assert!(elsewhere.is_dir());
    }

    /// Links inside the app come across as links, and nothing but the bytes
    /// and the permission bits of a file does — no quarantine flag.
    #[test]
    fn links_are_kept_and_attributes_are_not() {
        let root = tempfile::tempdir().unwrap();
        let app = shipped(root.path());
        std::os::unix::fs::symlink("Info.plist", app.join("Contents/Alias")).unwrap();
        let name = std::ffi::CString::new("com.apple.quarantine").unwrap();
        let value = b"0081;00000000;codeg;";
        let path = std::ffi::CString::new(exe_of(&app).as_os_str().as_encoded_bytes()).unwrap();
        // SAFETY: NUL-terminated name and path, a value of the length given.
        let set = unsafe {
            libc::setxattr(
                path.as_ptr(),
                name.as_ptr(),
                value.as_ptr().cast(),
                value.len(),
                0,
                0,
            )
        };
        assert_eq!(set, 0, "{}", io::Error::last_os_error());

        let installed = install(&app, &root.path().join("home")).unwrap();
        assert_eq!(
            fs::read_link(installed.join("Contents/Alias")).unwrap(),
            Path::new("Info.plist")
        );
        let copied =
            std::ffi::CString::new(exe_of(&installed).as_os_str().as_encoded_bytes()).unwrap();
        // SAFETY: as above; a null buffer asks only for the size.
        let size = unsafe {
            libc::getxattr(
                copied.as_ptr(),
                name.as_ptr(),
                std::ptr::null_mut(),
                0,
                0,
                0,
            )
        };
        assert_eq!(size, -1);
        assert_eq!(
            io::Error::last_os_error().raw_os_error(),
            Some(libc::ENOATTR)
        );
    }

    /// Where two names cannot be exchanged, the old copy goes aside and the
    /// new one in; should the new one not go in, the old one is put back.
    #[test]
    fn replacing_by_renames_keeps_one_copy_in_place() {
        let root = tempfile::tempdir().unwrap();
        let installed = root.path().join(APP);
        let staging = root.path().join(format!(".{APP}.1.0.incoming"));
        fs::create_dir_all(installed.join("old")).unwrap();
        fs::create_dir_all(staging.join("new")).unwrap();
        replace_by_renames(&staging, &installed).unwrap();
        assert!(installed.join("new").is_dir());
        assert_eq!(names_in(root.path()).unwrap(), vec![OsString::from(APP)]);

        // Nothing to move in: the copy that was there stays.
        assert!(replace_by_renames(&staging, &installed).is_err());
        assert!(installed.join("new").is_dir());
        assert_eq!(names_in(root.path()).unwrap(), vec![OsString::from(APP)]);
    }

    /// The shipped app cannot be read: an error, and the copy is not touched.
    #[test]
    fn an_unreadable_original_is_an_error() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        assert!(install(&root.path().join("absent.app"), &home).is_err());
        assert!(!home.join("absent.app").exists());
    }
}
