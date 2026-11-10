//! The environment of a program codeg starts while codeg runs from an AppImage.
//!
//! An AppImage's launcher sets codeg's environment up for the libraries and
//! data inside the image before codeg starts, and every process codeg starts
//! inherits it:
//!
//! - the AppImage runtime sets `APPIMAGE`, `APPDIR`, `OWD` and `ARGV0`;
//! - linuxdeploy's GTK hook (`apprun-hooks/linuxdeploy-plugin-gtk.sh`) points
//!   GTK, GIO, GdkPixbuf, GSettings and GObject introspection into the image
//!   and forces `GTK_THEME`;
//! - `AppRun.wrapped` (AppImageKit's AppRun) puts the image's directories in
//!   front of `PATH`, `LD_LIBRARY_PATH` and five more search paths, rebuilds
//!   the two GStreamer plugin paths, and sets `PYTHONHOME` and
//!   `PYTHONDONTWRITEBYTECODE`.
//!
//! A program from the host then loads the image's libraries, built on the
//! oldest distribution codeg supports, in place of its own (issue #983). On
//! Ubuntu 26.04 every uutils coreutils program needs `LIBSYSTEMD_254`, the
//! image's `libsystemd.so.0` stops at `LIBSYSTEMD_252`, and so `/usr/bin/env`
//! cannot start: not npm, not an agent behind a `#!/usr/bin/env node` line,
//! not a shell command. The host's `gio` fails on the image's GLib, so
//! `xdg-open` does too, and a host Python looks for its standard library
//! under the image's `PYTHONHOME`.
//!
//! codeg cannot drop that environment from its own process: GTK reads it as
//! it goes, and WebKit's helper processes, whose RUNPATH does not reach the
//! image's libraries, find them only through the `LD_LIBRARY_PATH` they
//! inherit from codeg. So it is put back for each program codeg starts
//! instead: [`restore`], [`restore_tokio`] and [`restore_pty`]. The image's
//! own programs (`codeg-mcp`, `codeg-cli`, `codeg` as git's credential
//! helper) run without it, through a RUNPATH to the image's library directory.
//!
//! Programs the Tauri plugins start (the opener's `xdg-open`, deep-link's
//! `xdg-mime`) are out of reach here: they inherit codeg's environment as is.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

/// Search paths the launcher points into the image. A program codeg starts
/// gets each without its entries inside the image, in the session's order;
/// one left with nothing is removed, as it was before the launcher set it.
const IMAGE_SEARCH_PATHS: &[&str] = &[
    // AppRun.wrapped
    "PATH",
    "LD_LIBRARY_PATH",
    "PYTHONHOME",
    "PYTHONPATH",
    "PERLLIB",
    "QT_PLUGIN_PATH",
    XDG_DATA_DIRS,
    "GSETTINGS_SCHEMA_DIR",
    // linuxdeploy-plugin-gtk.sh
    "GTK_DATA_PREFIX",
    "GTK_EXE_PREFIX",
    "GTK_PATH",
    "GTK_IM_MODULE_FILE",
    "GDK_PIXBUF_MODULE_FILE",
    "GIO_MODULE_DIR",
    "GI_TYPELIB_PATH",
    // the runtime: the image itself
    "APPDIR",
];

/// `AppRun.wrapped` builds these from the image's GStreamer directory and the
/// session's `QT_PLUGIN_PATH` (it reuses the wrong variable's old value), so
/// nothing in them is the session's own: when they point into the image, a
/// program codeg starts gets neither — a host GStreamer then searches its own
/// plugins, not Qt's.
const REBUILT_SEARCH_PATHS: &[&str] = &["GST_PLUGIN_SYSTEM_PATH", "GST_PLUGIN_SYSTEM_PATH_1_0"];

/// The GTK hook sets `$APPDIR/usr/share:/usr/share:$XDG_DATA_DIRS`. Its
/// `/usr/share` goes too when that changes nothing: when the session's value
/// has `/usr/share` again, or when the session had no value, whose default
/// (`/usr/local/share:/usr/share`) the variable left unset gives back.
const XDG_DATA_DIRS: &str = "XDG_DATA_DIRS";
const HOOK_DATA_DIR: &str = "/usr/share";

/// Values the launcher sets for the image's sake, overwriting whatever the
/// session had: the runtime's `APPIMAGE`, `ARGV0` and `OWD`, which would make
/// an AppImage-aware program take codeg's image for its own; the GTK hook's
/// `GTK_THEME`; `AppRun.wrapped`'s `PYTHONDONTWRITEBYTECODE`. A program codeg
/// starts gets none of them, unless codeg sets one on that command itself.
const LAUNCHER_VALUES: &[&str] = &[
    "APPIMAGE",
    "ARGV0",
    "OWD",
    "GTK_THEME",
    "PYTHONDONTWRITEBYTECODE",
];

/// Put the session's environment back for `command`, which is about to start
/// a program from the host: no search path keeps an entry inside the image,
/// and the launcher's own values go. A variable the command already sets is
/// cleaned too (the agent and terminal layers build their `PATH` from
/// codeg's), except that a launcher value codeg sets on purpose stays.
///
/// For a command that inherits codeg's environment: after `env_clear` this
/// would add variables back. Does nothing outside an AppImage.
pub fn restore(command: &mut Command) {
    if let Some(image) = Image::current() {
        image.restore_command(command, |key| std::env::var_os(key));
    }
}

/// [`restore`] for a tokio command.
pub fn restore_tokio(command: &mut tokio::process::Command) {
    restore(command.as_std_mut());
}

/// [`restore`] for the built-in terminal's shell, whose command carries a
/// copy of the whole environment.
pub fn restore_pty(command: &mut portable_pty::CommandBuilder) {
    if let Some(image) = Image::current() {
        image.restore_pty_command(command);
    }
}

/// The image codeg runs from: mounted by the AppImage runtime, or extracted.
#[derive(Debug)]
struct Image {
    /// `APPDIR` as given, and resolved when that differs: the GTK hook writes
    /// paths under the first, `AppRun.wrapped` under the second, the
    /// directory of `realpath("/proc/self/exe")`.
    roots: Vec<PathBuf>,
}

impl Image {
    /// The image this process runs from, if any. Looked up once.
    fn current() -> Option<&'static Image> {
        static IMAGE: OnceLock<Option<Image>> = OnceLock::new();
        IMAGE
            .get_or_init(|| {
                // AppImages are Linux's: an `APPDIR` anywhere else means
                // something else.
                if !cfg!(target_os = "linux") {
                    return None;
                }
                let appdir = std::env::var_os("APPDIR")?;
                let exe = std::env::current_exe().ok()?;
                Image::find(Path::new(&appdir), &exe)
            })
            .as_ref()
    }

    /// `appdir` as the image `exe` runs from: an absolute directory, not `/`,
    /// holding the `AppRun` every AppImage starts with, and holding `exe`. A
    /// stray `APPDIR` that meant something else would otherwise cost every
    /// program codeg starts its search paths.
    fn find(appdir: &Path, exe: &Path) -> Option<Image> {
        if !appdir.is_absolute() || appdir.parent().is_none() {
            return None;
        }
        let mut roots = vec![appdir.to_path_buf()];
        if let Ok(resolved) = std::fs::canonicalize(appdir) {
            if resolved != appdir {
                roots.push(resolved);
            }
        }
        let image = Image { roots };
        (image.contains(exe) && appdir.join("AppRun").is_file()).then_some(image)
    }

    /// Whether `path` names something inside the image (by components, so
    /// another image mounted beside it under a longer name is not).
    fn contains(&self, path: &Path) -> bool {
        self.roots.iter().any(|root| path.starts_with(root))
    }

    /// What becomes of `key`'s `value` for a program codeg starts: `None` when
    /// it does not point into the image (nothing to change), `Some(None)` when
    /// nothing of it is left, so the variable goes.
    ///
    /// Empty entries go with the image's: the launcher joins its directories
    /// to whatever the session had, empty or not, and an empty entry in a
    /// search path means the current directory — for `LD_LIBRARY_PATH`, a
    /// project's own `libc.so.6`.
    fn change(&self, key: &str, value: &OsStr) -> Option<Option<OsString>> {
        let entries: Vec<PathBuf> = std::env::split_paths(value).collect();
        if !entries.iter().any(|entry| self.contains(entry)) {
            return None;
        }
        if REBUILT_SEARCH_PATHS.contains(&key) {
            return Some(None);
        }
        let mut kept: Vec<&PathBuf> = entries
            .iter()
            .filter(|entry| !entry.as_os_str().is_empty() && !self.contains(entry))
            .collect();
        if key == XDG_DATA_DIRS
            && kept
                .first()
                .is_some_and(|first| first.as_path() == Path::new(HOOK_DATA_DIR))
            && (kept.len() == 1
                || kept[1..]
                    .iter()
                    .any(|e| e.as_path() == Path::new(HOOK_DATA_DIR)))
        {
            kept.remove(0);
        }
        if kept.is_empty() {
            return Some(None);
        }
        Some(std::env::join_paths(kept).ok())
    }

    /// [`restore`] with `inherited` standing in for codeg's environment.
    fn restore_command(&self, command: &mut Command, inherited: impl Fn(&str) -> Option<OsString>) {
        // What the command sets (`Some`) or removes (`None`) itself so far.
        let own: Vec<(OsString, Option<OsString>)> = command
            .get_envs()
            .map(|(key, value)| (key.to_os_string(), value.map(OsStr::to_os_string)))
            .collect();
        let set_on_command = |key: &str| own.iter().find(|(k, _)| k == key).map(|(_, v)| v);

        for &key in IMAGE_SEARCH_PATHS.iter().chain(REBUILT_SEARCH_PATHS) {
            let value = match set_on_command(key) {
                Some(value) => value.clone(),
                None => inherited(key),
            };
            match value.and_then(|value| self.change(key, &value)) {
                Some(Some(kept)) => {
                    command.env(key, kept);
                }
                Some(None) => {
                    command.env_remove(key);
                }
                None => {}
            }
        }
        for &key in LAUNCHER_VALUES {
            if set_on_command(key).is_none() && inherited(key).is_some() {
                command.env_remove(key);
            }
        }
    }

    /// [`restore_pty`]: the builder holds the whole environment, so whatever
    /// it has is what the shell would get.
    fn restore_pty_command(&self, command: &mut portable_pty::CommandBuilder) {
        for &key in IMAGE_SEARCH_PATHS.iter().chain(REBUILT_SEARCH_PATHS) {
            match command
                .get_env(key)
                .and_then(|value| self.change(key, value))
            {
                Some(Some(kept)) => command.env(key, kept),
                Some(None) => command.env_remove(key),
                None => {}
            }
        }
        for &key in LAUNCHER_VALUES {
            command.env_remove(key);
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    const ROOT: &str = "/tmp/.mount_codegAbc123";

    fn image() -> Image {
        Image {
            roots: vec![PathBuf::from(ROOT)],
        }
    }

    /// What the 0.38.0 AppImage's launcher hands codeg, captured from its
    /// real `AppRun` → `linuxdeploy-plugin-gtk.sh` → `AppRun.wrapped` chain
    /// (mount path renamed), after `cli_run::shim` put its directory first on
    /// `PATH` and named the image's `codeg-cli` in `CODEG_CLI`. The session
    /// had `PATH`, `XDG_DATA_DIRS`, `HOME` and `LANG`, and none of the rest.
    fn launched() -> BTreeMap<&'static str, String> {
        let r = ROOT;
        BTreeMap::from([
            ("HOME", "/home/u".to_string()),
            ("LANG", "en_US.UTF-8".to_string()),
            ("CODEG_CLI", format!("{r}/usr/bin/codeg-cli")),
            ("APPIMAGE", "/home/u/Apps/codeg.AppImage".to_string()),
            ("APPDIR", r.to_string()),
            ("OWD", "/home/u".to_string()),
            ("ARGV0", "./codeg.AppImage".to_string()),
            ("GTK_THEME", "Adwaita:dark".to_string()),
            ("PYTHONDONTWRITEBYTECODE", "1".to_string()),
            ("PYTHONHOME", format!("{r}/usr/")),
            (
                "PATH",
                format!(
                    "/home/u/.local/share/codeg/cli/bin:{r}/usr/bin/:{r}/usr/sbin/:{r}/usr/games/:\
                     {r}/bin/:{r}/sbin/:/home/u/.volta/bin:/usr/local/bin:/usr/bin:/bin"
                ),
            ),
            (
                "LD_LIBRARY_PATH",
                format!(
                    "{r}/usr/lib/:{r}/usr/lib/i386-linux-gnu/:{r}/usr/lib/x86_64-linux-gnu/:\
                     {r}/usr/lib32/:{r}/usr/lib64/:{r}/lib/:{r}/lib/i386-linux-gnu/:\
                     {r}/lib/x86_64-linux-gnu/:{r}/lib32/:{r}/lib64/:"
                ),
            ),
            ("PYTHONPATH", format!("{r}/usr/share/pyshared/:")),
            (
                "XDG_DATA_DIRS",
                format!(
                    "{r}/usr/share/:{r}/usr/share:/usr/share:\
                     /usr/share/ubuntu:/usr/local/share/:/usr/share/:/var/lib/snapd/desktop"
                ),
            ),
            (
                "PERLLIB",
                format!("{r}/usr/share/perl5/:{r}/usr/lib/perl5/:"),
            ),
            (
                "GSETTINGS_SCHEMA_DIR",
                format!("{r}/usr/share/glib-2.0/schemas/:{r}//usr/share/glib-2.0/schemas"),
            ),
            (
                "QT_PLUGIN_PATH",
                format!(
                    "{r}/usr/lib/qt4/plugins/:{r}/usr/lib/i386-linux-gnu/qt4/plugins/:\
                     {r}/usr/lib/x86_64-linux-gnu/qt4/plugins/:{r}/usr/lib32/qt4/plugins/:\
                     {r}/usr/lib64/qt4/plugins/:{r}/usr/lib/qt5/plugins/:\
                     {r}/usr/lib/i386-linux-gnu/qt5/plugins/:\
                     {r}/usr/lib/x86_64-linux-gnu/qt5/plugins/:{r}/usr/lib32/qt5/plugins/:\
                     {r}/usr/lib64/qt5/plugins/:"
                ),
            ),
            ("GST_PLUGIN_SYSTEM_PATH", format!("{r}/usr/lib/gstreamer:")),
            (
                "GST_PLUGIN_SYSTEM_PATH_1_0",
                format!("{r}/usr/lib/gstreamer-1.0:"),
            ),
            ("GTK_DATA_PREFIX", r.to_string()),
            ("GTK_EXE_PREFIX", format!("{r}//usr")),
            ("GTK_PATH", format!("{r}//usr/lib/gtk-3.0")),
            (
                "GTK_IM_MODULE_FILE",
                format!("{r}//usr/lib/gtk-3.0/3.0.0/immodules.cache"),
            ),
            (
                "GDK_PIXBUF_MODULE_FILE",
                format!("{r}//usr/lib/gdk-pixbuf-2.0/2.10.0/loaders.cache"),
            ),
            ("GIO_MODULE_DIR", format!("{r}//usr/lib/gio/modules")),
            ("GI_TYPELIB_PATH", format!("{r}//usr/lib/girepository-1.0")),
        ])
    }

    /// The environment a child of `command` gets, given codeg's `inherited`.
    fn child_env(
        command: &Command,
        inherited: &BTreeMap<&str, String>,
    ) -> BTreeMap<String, String> {
        let mut env: BTreeMap<String, String> = inherited
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect();
        for (key, value) in command.get_envs() {
            let key = key.to_string_lossy().into_owned();
            match value {
                Some(value) => env.insert(key, value.to_string_lossy().into_owned()),
                None => env.remove(&key),
            };
        }
        env
    }

    fn lookup<'a>(
        env: &'a BTreeMap<&'static str, String>,
    ) -> impl Fn(&str) -> Option<OsString> + 'a {
        move |key| env.get(key).map(OsString::from)
    }

    #[test]
    fn a_child_gets_the_session_environment_back() {
        let launched = launched();
        let mut command = Command::new("npm");
        image().restore_command(&mut command, lookup(&launched));

        let expected = BTreeMap::from([
            ("HOME".to_string(), "/home/u".to_string()),
            ("LANG".to_string(), "en_US.UTF-8".to_string()),
            // The image's own CLI, named on purpose for agents: not the
            // launcher's, so it stays.
            ("CODEG_CLI".to_string(), format!("{ROOT}/usr/bin/codeg-cli")),
            (
                "PATH".to_string(),
                "/home/u/.local/share/codeg/cli/bin:/home/u/.volta/bin:/usr/local/bin:/usr/bin:/bin"
                    .to_string(),
            ),
            (
                "XDG_DATA_DIRS".to_string(),
                "/usr/share/ubuntu:/usr/local/share/:/usr/share/:/var/lib/snapd/desktop"
                    .to_string(),
            ),
        ]);
        assert_eq!(child_env(&command, &launched), expected);
    }

    #[test]
    fn what_the_session_had_survives_in_its_order() {
        let mut launched = launched();
        launched.insert(
            "LD_LIBRARY_PATH",
            format!("{ROOT}/usr/lib/:{ROOT}/lib64/:/opt/cuda/lib64:/opt/x/lib"),
        );
        launched.insert(
            "PYTHONPATH",
            format!("{ROOT}/usr/share/pyshared/:/home/u/py::/srv/py"),
        );
        let mut command = Command::new("node");
        image().restore_command(&mut command, lookup(&launched));

        let env = child_env(&command, &launched);
        assert_eq!(env["LD_LIBRARY_PATH"], "/opt/cuda/lib64:/opt/x/lib");
        // An empty entry would have meant the current directory.
        assert_eq!(env["PYTHONPATH"], "/home/u/py:/srv/py");
    }

    /// `AppRun.wrapped` ends both GStreamer paths with the session's
    /// `QT_PLUGIN_PATH`, which is all that would be left of them.
    #[test]
    fn the_gstreamer_paths_go_whole() {
        let mut launched = launched();
        launched.insert(
            "QT_PLUGIN_PATH",
            format!("{ROOT}/usr/lib/qt5/plugins/:/usr/lib/qt6/plugins"),
        );
        launched.insert(
            "GST_PLUGIN_SYSTEM_PATH",
            format!("{ROOT}/usr/lib/gstreamer:/usr/lib/qt6/plugins"),
        );
        launched.insert(
            "GST_PLUGIN_SYSTEM_PATH_1_0",
            format!("{ROOT}/usr/lib/gstreamer-1.0:/usr/lib/qt6/plugins"),
        );
        let mut command = Command::new("totem");
        image().restore_command(&mut command, lookup(&launched));

        let env = child_env(&command, &launched);
        assert_eq!(env["QT_PLUGIN_PATH"], "/usr/lib/qt6/plugins");
        assert!(!env.contains_key("GST_PLUGIN_SYSTEM_PATH"));
        assert!(!env.contains_key("GST_PLUGIN_SYSTEM_PATH_1_0"));
    }

    #[test]
    fn the_gtk_hooks_data_dir_goes_only_where_nothing_is_lost() {
        let xdg = |session: &str| {
            let value = format!("{ROOT}/usr/share/:{ROOT}/usr/share:/usr/share:{session}");
            image().change(XDG_DATA_DIRS, OsStr::new(&value))
        };
        // The session had none: unset again, so its default comes back.
        assert_eq!(xdg(""), Some(None));
        // The session has `/usr/share` itself, in its own place.
        assert_eq!(
            xdg("/opt/share:/usr/share"),
            Some(Some(OsString::from("/opt/share:/usr/share")))
        );
        assert_eq!(xdg("/usr/share"), Some(Some(OsString::from("/usr/share"))));
        // Without the hook's, nothing would name `/usr/share` at all.
        assert_eq!(
            xdg("/opt/share"),
            Some(Some(OsString::from("/usr/share:/opt/share")))
        );
    }

    #[test]
    fn nothing_changes_for_values_without_the_image() {
        let session = BTreeMap::from([
            ("PATH", "/usr/bin:/bin".to_string()),
            ("LD_LIBRARY_PATH", "/opt/cuda/lib64".to_string()),
            ("XDG_DATA_DIRS", "/usr/share".to_string()),
        ]);
        let mut command = Command::new("git");
        image().restore_command(&mut command, lookup(&session));
        assert_eq!(command.get_envs().count(), 0);
    }

    #[test]
    fn a_value_set_on_the_command_is_cleaned_but_a_chosen_launcher_value_stays() {
        let launched = launched();
        let mut command = Command::new("claude-agent-acp");
        // The agent layer's PATH: its own directory in front of codeg's.
        command.env(
            "PATH",
            format!("/home/u/.claude/local:{ROOT}/usr/bin/:/usr/bin"),
        );
        command.env("GTK_THEME", "HighContrast");
        command.env_remove("PYTHONPATH");
        image().restore_command(&mut command, lookup(&launched));

        let env = child_env(&command, &launched);
        assert_eq!(env["PATH"], "/home/u/.claude/local:/usr/bin");
        assert_eq!(env["GTK_THEME"], "HighContrast");
        assert!(!env.contains_key("PYTHONPATH"));
        assert!(!env.contains_key("APPIMAGE"));
    }

    #[test]
    fn an_image_mounted_beside_it_under_a_longer_name_is_not_this_one() {
        let other = format!("{ROOT}4/usr/lib");
        let session = BTreeMap::from([("LD_LIBRARY_PATH", format!("{ROOT}/usr/lib/:{other}"))]);
        let mut command = Command::new("sh");
        image().restore_command(&mut command, lookup(&session));
        assert_eq!(child_env(&command, &session)["LD_LIBRARY_PATH"], other);
    }

    #[test]
    fn the_terminal_shell_gets_the_session_environment_back() {
        let launched = launched();
        let mut command = portable_pty::CommandBuilder::new("bash");
        command.env_clear();
        for (key, value) in &launched {
            command.env(key, value);
        }
        image().restore_pty_command(&mut command);

        let env: BTreeMap<String, String> = command
            .iter_full_env_as_str()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        assert_eq!(
            env.keys().map(String::as_str).collect::<Vec<_>>(),
            ["CODEG_CLI", "HOME", "LANG", "PATH", "XDG_DATA_DIRS"]
        );
        assert_eq!(
            env["PATH"],
            "/home/u/.local/share/codeg/cli/bin:/home/u/.volta/bin:/usr/local/bin:/usr/bin:/bin"
        );
    }

    /// `AppRun.wrapped` names the image by `realpath`, so a mount below a
    /// symlinked directory shows up under two names.
    #[test]
    fn the_image_is_found_under_its_resolved_name_too() {
        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path().join("real");
        let mount = real.join(".mount_codegXyz");
        std::fs::create_dir_all(mount.join("usr/bin")).unwrap();
        std::fs::write(mount.join("AppRun"), "").unwrap();
        let link = tmp.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let given = link.join(".mount_codegXyz");
        let resolved = std::fs::canonicalize(&mount).unwrap();

        let image = Image::find(&given, &resolved.join("usr/bin/codeg")).expect("an image");
        let session = BTreeMap::from([(
            "LD_LIBRARY_PATH",
            format!(
                "{}/usr/lib/:{}/usr/lib/gio/modules:/opt/lib",
                resolved.display(),
                given.display()
            ),
        )]);
        let mut command = Command::new("sh");
        image.restore_command(&mut command, lookup(&session));
        assert_eq!(child_env(&command, &session)["LD_LIBRARY_PATH"], "/opt/lib");
    }

    #[test]
    fn only_an_appimage_codeg_runs_from_counts() {
        let tmp = tempfile::tempdir().unwrap();
        let appdir = std::fs::canonicalize(tmp.path()).unwrap();
        std::fs::create_dir_all(appdir.join("usr/bin")).unwrap();
        let exe = appdir.join("usr/bin/codeg");

        // No `AppRun`: some other `APPDIR`.
        assert!(Image::find(&appdir, &exe).is_none());
        std::fs::write(appdir.join("AppRun"), "").unwrap();
        assert!(Image::find(&appdir, &exe).is_some());
        // codeg is not in it.
        assert!(Image::find(&appdir, Path::new("/usr/bin/codeg")).is_none());
        // Not a usable root.
        assert!(Image::find(Path::new("relative/dir"), Path::new("relative/dir/codeg")).is_none());
        assert!(Image::find(Path::new("/"), Path::new("/usr/bin/codeg")).is_none());
    }
}
