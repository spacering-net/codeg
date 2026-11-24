//! Settings → "Install command-line tool": `codeg-cli` on the user's own
//! PATH, from the desktop app.
//!
//! What that takes depends on the package:
//! - macOS: a link `/usr/local/bin/codeg-cli` → the app's sidecar, the one
//!   docs/cli.md has people make by hand — asking for an administrator's
//!   password when the folder needs it.
//! - Windows: the installer's `bin\` (only `codeg-cli.exe` in it) added to the
//!   user's PATH.
//! - an AppImage: a link `~/.local/bin/codeg-cli` → the copy the app keeps up
//!   to date (`shim`); likewise for a Linux build outside a package.
//! - a Linux package: nothing — `/usr/bin/codeg-cli` is on PATH already.
//!
//! A `codeg-cli` already there that is not the app's — the server package's,
//! say — is never replaced: the two are the same program. A debug build
//! installs `codeg-cli-dev`, never the command of an installed release.

use std::path::{Path, PathBuf};

use serde::Serialize;

use super::shim::{self, Kind, Layout};

/// What the settings page shows, and what installing would do.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandToolStatus {
    /// `link` (a link in a folder on PATH), `path` (a folder added to PATH),
    /// `package` (the package put it on PATH), or `none` (this build has no
    /// `codeg-cli` to offer).
    pub method: String,
    pub command: String,
    pub installed: bool,
    /// Where the command is, or will be: the link, or the folder.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    /// Another `codeg-cli` in the way, left as it is.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflict: Option<String>,
    /// Something to know: the link's folder is not on PATH, say.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// How this build's command gets on PATH.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Plan {
    Link { link: PathBuf, target: PathBuf },
    UserPath { dir: PathBuf },
    Package { at: PathBuf },
    Nothing,
}

fn plan(layout: Option<&Layout>, exe: &Path, home: Option<&Path>) -> Plan {
    let Some(layout) = layout else {
        return Plan::Nothing;
    };
    let command = layout.command;
    if cfg!(windows) {
        return Plan::UserPath {
            dir: layout.dir.clone(),
        };
    }
    if cfg!(target_os = "macos") {
        return match &layout.kind {
            Kind::Shim { target } => Plan::Link {
                link: Path::new("/usr/local/bin").join(command),
                target: target.clone(),
            },
            _ => Plan::Nothing,
        };
    }
    // Linux: a package installs the sidecar where PATH already looks.
    let exe_dir = exe.parent().unwrap_or(Path::new(""));
    if let Kind::Shim { target } = &layout.kind {
        if exe_dir == Path::new("/usr/bin") && target.parent() == Some(exe_dir) {
            return Plan::Package { at: target.clone() };
        }
    }
    let Some(home) = home else {
        return Plan::Nothing;
    };
    let target = match &layout.kind {
        // The image's own files go when it stops: the kept copy instead.
        Kind::Copy { .. } => layout.cli.clone(),
        Kind::Shim { target } => target.clone(),
        Kind::Installed => return Plan::Nothing,
    };
    Plan::Link {
        link: home.join(".local").join("bin").join(command),
        target,
    }
}

fn this_plan() -> Plan {
    let exe = std::env::current_exe().unwrap_or_default();
    plan(shim::layout(), &exe, dirs::home_dir().as_deref())
}

/// Where things stand.
pub fn status() -> CommandToolStatus {
    status_of(&this_plan(), shim::command_name())
}

fn status_of(plan: &Plan, command: &str) -> CommandToolStatus {
    let mut status = CommandToolStatus {
        method: "none".into(),
        command: command.to_string(),
        installed: false,
        location: None,
        conflict: None,
        note: None,
    };
    match plan {
        Plan::Nothing => {}
        Plan::Package { at } => {
            status.method = "package".into();
            status.installed = true;
            status.location = Some(at.to_string_lossy().into_owned());
        }
        Plan::Link { link, target } => {
            status.method = "link".into();
            status.location = Some(link.to_string_lossy().into_owned());
            match link_state(link, target) {
                LinkState::Ours { current: true } => status.installed = true,
                LinkState::Ours { current: false } | LinkState::Absent => {}
                LinkState::Other(what) => status.conflict = Some(what),
            }
            if let Some(dir) = link.parent() {
                if !on_path(dir) {
                    status.note = Some(format!("{} is not on your PATH", dir.display()));
                }
            }
        }
        Plan::UserPath { dir } => {
            status.method = "path".into();
            status.location = Some(dir.to_string_lossy().into_owned());
            status.installed = user_path_has(dir);
        }
    }
    status
}

/// Put the command on PATH, as `status` describes; the status after.
pub fn install() -> Result<CommandToolStatus, String> {
    let plan = this_plan();
    match &plan {
        Plan::Nothing => return Err("this build of Codeg has no codeg-cli to install".into()),
        Plan::Package { .. } => {}
        Plan::Link { link, target } => match link_state(link, target) {
            LinkState::Ours { current: true } => {}
            LinkState::Other(what) => return Err(what),
            LinkState::Ours { current: false } | LinkState::Absent => make_link(link, target)?,
        },
        Plan::UserPath { dir } => {
            if !user_path_has(dir) {
                add_to_user_path(dir)?;
            }
        }
    }
    Ok(status_of(&plan, shim::command_name()))
}

#[derive(Debug, PartialEq, Eq)]
enum LinkState {
    Absent,
    /// A link of the app's: to `target` (current), or to another copy of
    /// the app — moved, or an older install.
    Ours {
        current: bool,
    },
    /// Something else, described.
    Other(String),
}

fn link_state(link: &Path, target: &Path) -> LinkState {
    let Ok(meta) = link.symlink_metadata() else {
        return LinkState::Absent;
    };
    if !meta.file_type().is_symlink() {
        return LinkState::Other(format!(
            "{} is there already and is not the app's: it is the same program, so it is left \
             as it is",
            link.display()
        ));
    }
    let Ok(points_to) = std::fs::read_link(link) else {
        return LinkState::Other(format!("{} cannot be read", link.display()));
    };
    if points_to == target {
        return LinkState::Ours { current: true };
    }
    // Into a codeg.app bundle somewhere else: this app, moved, or a copy
    // of it — the link install.sh also keeps as the desktop's.
    let tail: Vec<_> = points_to
        .components()
        .rev()
        .take(4)
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    let ours = tail == ["codeg-cli", "MacOS", "Contents", "codeg.app"];
    if ours {
        LinkState::Ours { current: false }
    } else {
        LinkState::Other(format!(
            "{} leads to {}, not to this app: it is the same program, so it is left as it is",
            link.display(),
            points_to.display()
        ))
    }
}

/// Whether `dir` is on this process's PATH.
fn on_path(dir: &Path) -> bool {
    std::env::var_os("PATH").is_some_and(|path| std::env::split_paths(&path).any(|p| p == dir))
}

#[cfg(unix)]
fn make_link(link: &Path, target: &Path) -> Result<(), String> {
    let plain = (|| {
        if let Some(dir) = link.parent() {
            std::fs::create_dir_all(dir)?;
        }
        if link.symlink_metadata().is_ok() {
            std::fs::remove_file(link)?;
        }
        std::os::unix::fs::symlink(target, link)
    })();
    match plain {
        Ok(()) => Ok(()),
        Err(e) if cfg!(target_os = "macos") && e.kind() == std::io::ErrorKind::PermissionDenied => {
            make_link_as_admin(link, target)
        }
        Err(e) => Err(format!("cannot link {}: {e}", link.display())),
    }
}

/// `/usr/local/bin` is often the administrator's: macOS asks for the
/// password, as other apps' "install the command" do.
#[cfg(unix)]
fn make_link_as_admin(link: &Path, target: &Path) -> Result<(), String> {
    let quoted = |p: &Path| {
        format!(
            "quoted form of \"{}\"",
            p.to_string_lossy()
                .replace('\\', "\\\\")
                .replace('"', "\\\"")
        )
    };
    let dir = link.parent().unwrap_or(Path::new("/usr/local/bin"));
    let script = format!(
        "do shell script \"/bin/mkdir -p \" & {} & \" && /bin/ln -sfn \" & {} & \" \" & {} \
         with prompt \"Codeg wants to put codeg-cli on your PATH.\" with administrator privileges",
        quoted(dir),
        quoted(target),
        quoted(link)
    );
    let out = std::process::Command::new("/usr/bin/osascript")
        .args(["-e", &script])
        .output()
        .map_err(|e| format!("cannot ask for permission: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "{} was not linked: {}",
            link.display(),
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

#[cfg(not(unix))]
fn make_link(link: &Path, _target: &Path) -> Result<(), String> {
    Err(format!("cannot link {} here", link.display()))
}

/// Whether the user's own PATH (not this process's) holds `dir`.
#[cfg(windows)]
fn user_path_has(dir: &Path) -> bool {
    windows_user_path::read()
        .ok()
        .is_some_and(|path| windows_user_path::contains(&path, dir))
}

#[cfg(not(windows))]
fn user_path_has(_dir: &Path) -> bool {
    false
}

#[cfg(windows)]
fn add_to_user_path(dir: &Path) -> Result<(), String> {
    let current = windows_user_path::read()?;
    let dir = dir.to_string_lossy();
    let next = if current.trim().is_empty() {
        dir.into_owned()
    } else {
        format!("{};{dir}", current.trim_end_matches(';'))
    };
    windows_user_path::write(&next)
}

#[cfg(not(windows))]
fn add_to_user_path(dir: &Path) -> Result<(), String> {
    Err(format!("cannot add {} to PATH here", dir.display()))
}

/// The user's `Path` in `HKCU\Environment`, read and written as the system's
/// own environment editor does: kept `REG_EXPAND_SZ`, and announced to the
/// running programs that listen for a change.
#[cfg(windows)]
mod windows_user_path {
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER,
        KEY_READ, KEY_WRITE, REG_EXPAND_SZ,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
    };

    fn wide(s: &str) -> Vec<u16> {
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    struct Key(HKEY);

    impl Drop for Key {
        fn drop(&mut self) {
            // SAFETY: opened by RegOpenKeyExW below, closed once.
            unsafe { RegCloseKey(self.0) };
        }
    }

    fn open(access: u32) -> Result<Key, String> {
        let name = wide("Environment");
        let mut key: HKEY = std::ptr::null_mut();
        // SAFETY: valid name, out pointer to a local.
        let rc = unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, name.as_ptr(), 0, access, &mut key) };
        if rc != ERROR_SUCCESS {
            return Err(format!("cannot open HKCU\\Environment (error {rc})"));
        }
        Ok(Key(key))
    }

    pub fn read() -> Result<String, String> {
        let key = open(KEY_READ)?;
        let value = wide("Path");
        let mut size: u32 = 0;
        // SAFETY: size query with a null buffer.
        let rc = unsafe {
            RegQueryValueExW(
                key.0,
                value.as_ptr(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut size,
            )
        };
        if rc == ERROR_FILE_NOT_FOUND {
            return Ok(String::new());
        }
        if rc != ERROR_SUCCESS {
            return Err(format!("cannot read the user's Path (error {rc})"));
        }
        let mut buf = vec![0u16; (size as usize).div_ceil(2) + 1];
        let mut size = (buf.len() * 2) as u32;
        // SAFETY: buffer of `size` bytes.
        let rc = unsafe {
            RegQueryValueExW(
                key.0,
                value.as_ptr(),
                std::ptr::null(),
                std::ptr::null_mut(),
                buf.as_mut_ptr().cast(),
                &mut size,
            )
        };
        if rc != ERROR_SUCCESS {
            return Err(format!("cannot read the user's Path (error {rc})"));
        }
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Ok(String::from_utf16_lossy(&buf[..len]))
    }

    pub fn write(path: &str) -> Result<(), String> {
        let key = open(KEY_WRITE)?;
        let value = wide("Path");
        let data = wide(path);
        // SAFETY: data is a NUL-terminated UTF-16 string of the given size.
        let rc = unsafe {
            RegSetValueExW(
                key.0,
                value.as_ptr(),
                0,
                REG_EXPAND_SZ,
                data.as_ptr().cast(),
                (data.len() * 2) as u32,
            )
        };
        if rc != ERROR_SUCCESS {
            return Err(format!("cannot write the user's Path (error {rc})"));
        }
        let environment = wide("Environment");
        let mut result = 0usize;
        // SAFETY: a broadcast with a static string; bounded by the timeout.
        unsafe {
            SendMessageTimeoutW(
                HWND_BROADCAST,
                WM_SETTINGCHANGE,
                0,
                environment.as_ptr() as isize,
                SMTO_ABORTIFHUNG,
                5000,
                &mut result,
            )
        };
        Ok(())
    }

    /// Whether `path` (`;`-separated) holds `dir`, compared as Windows does:
    /// with `%VARIABLES%` expanded, regardless of case and of a trailing
    /// backslash.
    pub fn contains(path: &str, dir: &Path) -> bool {
        let want = dir.to_string_lossy();
        let want = want.trim_end_matches('\\');
        path.split(';')
            .map(|p| expand(p.trim()))
            .any(|p| p.trim_end_matches('\\').eq_ignore_ascii_case(want))
    }

    /// `%NAME%` replaced by the variable's value, as `REG_EXPAND_SZ` is read;
    /// a name with no value is kept as written.
    fn expand(entry: &str) -> String {
        let mut out = String::new();
        let mut rest = entry;
        while let Some(start) = rest.find('%') {
            let Some(len) = rest[start + 1..].find('%') else {
                break;
            };
            let name = &rest[start + 1..start + 1 + len];
            out.push_str(&rest[..start]);
            match std::env::var(name).ok().filter(|_| !name.is_empty()) {
                Some(value) => out.push_str(&value),
                None => out.push_str(&rest[start..start + len + 2]),
            }
            rest = &rest[start + len + 2..];
        }
        out.push_str(rest);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// For the platform tests (macOS and Linux plan links).
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn layout(kind: Kind, dir: &Path) -> Layout {
        Layout {
            dir: dir.to_path_buf(),
            command: "codeg-cli",
            cli: dir.join("codeg-cli"),
            kind,
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn on_macos_the_link_goes_where_the_docs_put_it() {
        let target = PathBuf::from("/Applications/codeg.app/Contents/MacOS/codeg-cli");
        let shim = layout(
            Kind::Shim {
                target: target.clone(),
            },
            Path::new("/d/cli/bin"),
        );
        assert_eq!(
            plan(
                Some(&shim),
                Path::new("/Applications/codeg.app/Contents/MacOS/codeg"),
                None
            ),
            Plan::Link {
                link: PathBuf::from("/usr/local/bin/codeg-cli"),
                target,
            }
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn on_linux_a_package_needs_nothing_and_an_appimage_links_its_copy() {
        let packaged = layout(
            Kind::Shim {
                target: PathBuf::from("/usr/bin/codeg-cli"),
            },
            Path::new("/d/cli/bin"),
        );
        assert!(matches!(
            plan(
                Some(&packaged),
                Path::new("/usr/bin/codeg"),
                Some(Path::new("/home/u"))
            ),
            Plan::Package { .. }
        ));
        let image = layout(
            Kind::Copy {
                source: PathBuf::from("/tmp/.mount_x/usr/bin/codeg-cli"),
            },
            Path::new("/d/cli/bin"),
        );
        assert_eq!(
            plan(
                Some(&image),
                Path::new("/tmp/.mount_x/usr/bin/codeg"),
                Some(Path::new("/home/u"))
            ),
            Plan::Link {
                link: PathBuf::from("/home/u/.local/bin/codeg-cli"),
                target: PathBuf::from("/d/cli/bin/codeg-cli"),
            }
        );
    }

    #[test]
    fn a_build_without_codeg_cli_offers_nothing() {
        assert_eq!(plan(None, Path::new("/x/codeg"), None), Plan::Nothing);
        let status = status_of(&Plan::Nothing, "codeg-cli");
        assert_eq!(status.method, "none");
        assert!(!status.installed);
    }

    #[cfg(unix)]
    #[test]
    fn a_link_is_made_left_alone_or_repointed_as_whose_it_is() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("codeg.app/Contents/MacOS/codeg-cli");
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&target, "cli").unwrap();
        let link = root.path().join("bin").join("codeg-cli");

        assert_eq!(link_state(&link, &target), LinkState::Absent);
        make_link(&link, &target).unwrap();
        assert_eq!(
            link_state(&link, &target),
            LinkState::Ours { current: true }
        );

        // The app moved: the old link is still ours, to point at it anew.
        let moved = root.path().join("new/codeg.app/Contents/MacOS/codeg-cli");
        assert_eq!(
            link_state(&link, &moved),
            LinkState::Ours { current: false }
        );
        make_link(&link, &moved).unwrap();
        assert_eq!(std::fs::read_link(&link).unwrap(), moved);

        // The server package's own file: same program, never replaced.
        std::fs::remove_file(&link).unwrap();
        std::fs::write(&link, "server's").unwrap();
        assert!(matches!(link_state(&link, &target), LinkState::Other(_)));
        // A link somewhere else: likewise, whatever its path looks like.
        for elsewhere in [
            "/opt/codeg/codeg-cli",
            "/opt/server/cli/bin/codeg-cli",
            "/Applications/Other.app/Contents/MacOS/codeg-cli",
        ] {
            std::fs::remove_file(&link).unwrap();
            std::os::unix::fs::symlink(elsewhere, &link).unwrap();
            assert!(
                matches!(link_state(&link, &target), LinkState::Other(_)),
                "{elsewhere}"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_folder_on_the_user_path_is_found_whatever_its_case() {
        let dir = Path::new(r"C:\Users\u\AppData\Local\codeg\bin");
        assert!(windows_user_path::contains(
            r"C:\Windows;c:\users\U\appdata\local\codeg\BIN\;D:\x",
            dir
        ));
        assert!(!windows_user_path::contains(r"C:\Windows", dir));
        // Written with a variable, as the user's own PATH often is.
        let local = std::env::var("LOCALAPPDATA").unwrap();
        let under_local = Path::new(&local).join("codeg").join("bin");
        assert!(windows_user_path::contains(
            r"C:\Windows;%LOCALAPPDATA%\codeg\bin",
            &under_local
        ));
    }
}
