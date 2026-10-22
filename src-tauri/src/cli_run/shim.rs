//! codeg's own `codeg-cli`, first for everything codeg starts.
//!
//! The desktop app puts a `codeg-cli` of its own release first on the PATH of
//! its built-in terminal and of every agent, and names it in `CODEG_CLI`, so
//! a `codeg-cli` typed there, or run by an agent, is the one that matches the
//! runtime it talks to (`CODEG_CLI_ENDPOINT_FILE` already picks the runtime).
//! A login shell may put its own PATH first; `CODEG_CLI` always holds.
//!
//! Where that `codeg-cli` is:
//! - macOS, Linux packages: `<data dir>/cli/bin/codeg-cli`, a script that
//!   runs the app's own sidecar — rewritten at every start, so a moved or
//!   updated app keeps it right. Only a file with [`MARKER`] as its second
//!   line is ours: one the user put there under that name is left alone.
//! - an AppImage: a copy of the image's sidecar there instead (the image's
//!   files are gone when it stops), written only over a copy of ours — which
//!   the SHA-256 recorded beside it, [`SHA_FILE`], tells apart from one the
//!   user changed. A copy in use is replaced by a rename, which leaves it
//!   running.
//! - Windows: the installer's `bin\`, which holds nothing but
//!   `codeg-cli.exe`. A debug build copies its own into
//!   `%LOCALAPPDATA%\app.codeg\cli\bin\` — never into the roaming data
//!   directory, which is no place for a program.
//!
//! A debug build names its command `codeg-cli-dev`, so it never takes the
//! name of an installed release's.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// The second line of every shim this module writes.
pub const MARKER: &str = "# codeg-cli shim, written by Codeg at every start: changes are lost";

/// Beside a copy (AppImage, Windows debug): the SHA-256 of the copy last
/// written, which is ours to replace while it still matches — the release's
/// record; a debug build's is `.codeg-cli-dev.sha256` (`record_of`).
pub const SHA_FILE: &str = ".codeg-cli.sha256";

/// The record beside the copy at `path`: one per command, so a debug build
/// sharing the directory never touches the release's.
fn record_of(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let command = name.strip_suffix(".exe").unwrap_or(&name);
    path.with_file_name(format!(".{command}.sha256"))
}

/// How codeg's own `codeg-cli` is put in place.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Kind {
    /// A script running `target`, the app's sidecar.
    Shim { target: PathBuf },
    /// A copy of `source` (the AppImage's sidecar, or a debug build's).
    Copy { source: PathBuf },
    /// The installer's own (Windows `bin\`): nothing to write.
    Installed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Layout {
    /// The directory put first on PATH.
    pub dir: PathBuf,
    /// The command name: `codeg-cli`, or `codeg-cli-dev` for a debug build.
    pub command: &'static str,
    /// The program in `dir`.
    pub cli: PathBuf,
    pub kind: Kind,
}

static LAYOUT: OnceLock<Layout> = OnceLock::new();

/// The command name this build's `codeg-cli` goes by.
pub fn command_name() -> &'static str {
    if cfg!(debug_assertions) {
        "codeg-cli-dev"
    } else {
        "codeg-cli"
    }
}

/// Where this desktop process's own `codeg-cli` goes, for its data directory
/// and the executable it runs as. `None`: the app has no usable sidecar (a
/// development build that never built one leaves an empty placeholder).
pub fn plan_desktop(data_dir: &Path, local_data_dir: Option<&Path>, exe: &Path) -> Option<Layout> {
    let exe_dir = exe.parent()?;
    let command = command_name();
    let sidecar = exe_dir.join(if cfg!(windows) {
        "codeg-cli.exe"
    } else {
        "codeg-cli"
    });
    if !is_program(&sidecar) {
        return None;
    }
    if cfg!(windows) {
        if cfg!(debug_assertions) {
            let dir = local_data_dir?.join("cli").join("bin");
            return Some(Layout {
                cli: dir.join(format!("{command}.exe")),
                dir,
                command,
                kind: Kind::Copy { source: sidecar },
            });
        }
        let dir = exe_dir.join("bin");
        let cli = dir.join("codeg-cli.exe");
        return is_program(&cli).then_some(Layout {
            dir,
            command,
            cli,
            kind: Kind::Installed,
        });
    }
    let dir = data_dir.join(super::discovery::DIR).join("bin");
    let kind = if in_appimage(exe) {
        Kind::Copy { source: sidecar }
    } else {
        Kind::Shim { target: sidecar }
    };
    Some(Layout {
        cli: dir.join(command),
        dir,
        command,
        kind,
    })
}

/// Whether `exe` runs from inside a mounted AppImage.
fn in_appimage(exe: &Path) -> bool {
    std::env::var_os("APPIMAGE").is_some()
        && std::env::var_os("APPDIR").is_some_and(|dir| exe.starts_with(dir))
}

/// A file that can be run: there, and not the empty placeholder a
/// development build writes for a sidecar it did not build.
fn is_program(path: &Path) -> bool {
    path.metadata().is_ok_and(|m| m.is_file() && m.len() > 0)
}

impl Layout {
    /// The app's own program, there for as long as the app runs whatever
    /// became of the shim or the copy: what `CODEG_CLI` names.
    pub fn program(&self) -> &Path {
        match &self.kind {
            Kind::Shim { target } => target,
            Kind::Copy { source } => source,
            Kind::Installed => &self.cli,
        }
    }

    /// Put `dir` first on this process's PATH and name the app's own program
    /// in `CODEG_CLI`, for everything it starts. Before any thread exists:
    /// `set_var` is not thread-safe.
    pub fn export(&self) {
        let sep = if cfg!(windows) { ";" } else { ":" };
        let path = std::env::var_os("PATH").unwrap_or_default();
        let mut joined = self.dir.as_os_str().to_os_string();
        if !path.is_empty() {
            joined.push(sep);
            joined.push(path);
        }
        std::env::set_var("PATH", joined);
        std::env::set_var(CLI_ENV, self.program());
    }

    /// Keep this layout for the rest of the process (`path_dir`).
    pub fn remember(self) {
        let _ = LAYOUT.set(self);
    }

    /// Put the program in place: write the shim, or the copy. Off the
    /// startup path — it reads and may write a few MB.
    pub fn write(&self) -> Result<(), String> {
        match &self.kind {
            Kind::Installed => Ok(()),
            Kind::Shim { target } => {
                self.prepare_dir()?;
                write_shim(&self.cli, target)
            }
            Kind::Copy { source } => {
                self.prepare_dir()?;
                write_copy(&self.cli, source)
            }
        }
    }

    /// `dir`, and above it the data directory's private `cli/`, made the way
    /// command-line access makes it: owner-only. Created any other way first,
    /// `cli/` would be refused by command-line access later.
    fn prepare_dir(&self) -> Result<(), String> {
        if cfg!(unix) {
            if let Some(cli_dir) = self.dir.parent() {
                super::discovery::prepare_dir(cli_dir)?;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                match std::fs::DirBuilder::new().mode(0o700).create(&self.dir) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(e) => return Err(format!("cannot create {}: {e}", self.dir.display())),
                }
            }
            Ok(())
        } else {
            std::fs::create_dir_all(&self.dir)
                .map_err(|e| format!("cannot create {}: {e}", self.dir.display()))
        }
    }
}

/// The variable that names codeg's own `codeg-cli` for what it starts.
pub const CLI_ENV: &str = "CODEG_CLI";

/// The directory codeg's own `codeg-cli` is in, when this process has one.
pub fn path_dir() -> Option<&'static Path> {
    LAYOUT.get().map(|l| l.dir.as_path())
}

/// The layout this process remembered.
pub fn layout() -> Option<&'static Layout> {
    LAYOUT.get()
}

fn shim_text(target: &Path) -> String {
    format!(
        "#!/bin/sh\n{MARKER}\nexec {} \"$@\"\n",
        crate::git_credential::sh_single_quote(&target.to_string_lossy())
    )
}

/// Whether the file at `path` is a shim this module wrote.
pub fn is_our_shim(path: &Path) -> bool {
    std::fs::read_to_string(path)
        .ok()
        .is_some_and(|text| text.lines().nth(1) == Some(MARKER))
}

fn write_shim(path: &Path, target: &Path) -> Result<(), String> {
    let text = shim_text(target);
    if path.symlink_metadata().is_ok() {
        if std::fs::read_to_string(path).ok().as_deref() == Some(text.as_str()) {
            return Ok(());
        }
        // Ours to replace: a shim of ours, or a copy an AppImage of the app
        // wrote there (the data directory outlives a change of package).
        if !is_our_shim(path) && !is_our_copy(path) {
            return Err(format!(
                "{} is not a shim of Codeg's; left as it is",
                path.display()
            ));
        }
    }
    replace_with(path, |tmp| std::fs::write(tmp, &text))?;
    // No copy here any more: a record left behind would vouch for whatever
    // came to sit under the name next.
    let _ = std::fs::remove_file(record_of(path));
    Ok(())
}

/// Whether the file at `path` is a copy this module wrote: its SHA-256 is
/// the one recorded beside it.
fn is_our_copy(path: &Path) -> bool {
    let recorded = std::fs::read_to_string(record_of(path)).ok();
    let current = sha256(path).ok();
    current.is_some() && recorded.as_deref().map(str::trim) == current.as_deref()
}

fn write_copy(path: &Path, source: &Path) -> Result<(), String> {
    let wanted = sha256(source).map_err(|e| format!("cannot read {}: {e}", source.display()))?;
    let record = record_of(path);
    if path.symlink_metadata().is_ok() {
        let current = sha256(path).ok();
        if current.as_deref() == Some(wanted.as_str()) {
            let _ = std::fs::write(&record, &wanted);
            return Ok(());
        }
        // Ours to replace: a copy of ours, or a shim a package of the app
        // wrote there.
        if !is_our_copy(path) && !is_our_shim(path) {
            return Err(format!(
                "{} was changed since Codeg wrote it; left as it is",
                path.display()
            ));
        }
    }
    replace_with(path, |tmp| std::fs::copy(source, tmp).map(|_| ()))?;
    std::fs::write(&record, &wanted).map_err(|e| format!("cannot record {}: {e}", record.display()))
}

/// Write `path` through a temporary file beside it, then rename it over:
/// a reader never sees half of it, and one running keeps the old file.
fn replace_with(
    path: &Path,
    write: impl FnOnce(&Path) -> std::io::Result<()>,
) -> Result<(), String> {
    let dir = path.parent().unwrap_or(Path::new("."));
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = dir.join(format!(".{name}.tmp-{}", super::hello::random_hex(4)));
    let done = write(&tmp).and_then(|()| {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))?;
        }
        rename_over(&tmp, path)
    });
    if done.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    done.map_err(|e| format!("cannot write {}: {e}", path.display()))
}

/// Windows refuses to rename over a program that runs; it lets the running
/// one be renamed aside, though.
fn rename_over(from: &Path, to: &Path) -> std::io::Result<()> {
    match std::fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(e) if cfg!(windows) && to.exists() => {
            let aside = to.with_extension(format!("old-{}", super::hello::random_hex(4)));
            std::fs::rename(to, &aside).map_err(|_| e)?;
            std::fs::rename(from, to)
        }
        Err(e) => Err(e),
    }
}

fn sha256(path: &Path) -> std::io::Result<String> {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    std::io::copy(&mut std::fs::File::open(path)?, &mut hasher)?;
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn program(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_shim_runs_the_apps_own_codeg_cli_and_is_rewritten_only_while_ours() {
        let root = tempfile::tempdir().unwrap();
        let app = root.path().join("codeg.app/Contents/MacOS");
        program(&app.join("codeg"), "app");
        program(&app.join("codeg-cli"), "cli");
        let data = root.path().join("data");
        let layout = plan_desktop(&data, None, &app.join("codeg")).expect("a sidecar");
        assert_eq!(layout.dir, data.join("cli").join("bin"));
        assert_eq!(layout.cli, layout.dir.join(command_name()));
        assert_eq!(
            layout.kind,
            Kind::Shim {
                target: app.join("codeg-cli")
            }
        );
        // CODEG_CLI names the app's own program, there whatever the shim.
        assert_eq!(layout.program(), app.join("codeg-cli"));

        layout.write().unwrap();
        let text = std::fs::read_to_string(&layout.cli).unwrap();
        assert!(text.starts_with("#!/bin/sh\n"), "{text}");
        assert!(text.contains(&*app.join("codeg-cli").to_string_lossy()));
        assert!(is_our_shim(&layout.cli));
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&layout.cli), 0o755);
        assert_eq!(
            mode(&data.join("cli")),
            0o700,
            "as command-line access makes it"
        );

        // The app moved: the next start points the shim at it.
        let moved = root.path().join("elsewhere/codeg.app/Contents/MacOS");
        program(&moved.join("codeg"), "app");
        program(&moved.join("codeg-cli"), "cli");
        let later = plan_desktop(&data, None, &moved.join("codeg")).unwrap();
        later.write().unwrap();
        assert!(std::fs::read_to_string(&later.cli)
            .unwrap()
            .contains(&*moved.to_string_lossy()));

        // A file the user put under that name stays.
        std::fs::write(&later.cli, "#!/bin/sh\necho mine\n").unwrap();
        assert!(later.write().is_err());
        assert_eq!(
            std::fs::read_to_string(&later.cli).unwrap(),
            "#!/bin/sh\necho mine\n"
        );
    }

    /// install.sh tells these files apart by the same marker and record:
    /// one changed here alone would have it delete the app's own.
    #[test]
    fn install_sh_knows_the_shims_and_copies_by_the_same_marks() {
        let script = include_str!("../../../install.sh");
        assert!(script.contains(&format!("DESKTOP_SHIM_MARKER=\"{MARKER}\"")));
        assert!(script.contains(SHA_FILE));
    }

    /// The release keeps the record install.sh reads; a debug build's own
    /// record sits beside it, apart.
    #[test]
    fn each_command_keeps_its_own_record() {
        let dir = Path::new("/d/cli/bin");
        assert_eq!(record_of(&dir.join("codeg-cli")), dir.join(SHA_FILE));
        assert_eq!(
            record_of(&dir.join("codeg-cli-dev.exe")),
            dir.join(".codeg-cli-dev.sha256")
        );
        assert_eq!(
            record_of(&dir.join("codeg-cli-dev")),
            dir.join(".codeg-cli-dev.sha256")
        );
    }

    #[test]
    fn no_layout_without_a_real_sidecar() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("bin");
        program(&dir.join("codeg"), "app");
        assert!(plan_desktop(root.path(), None, &dir.join("codeg")).is_none());
        // The empty placeholder a development build writes is no program.
        program(&dir.join("codeg-cli"), "");
        program(&dir.join("codeg-cli.exe"), "");
        assert!(plan_desktop(root.path(), None, &dir.join("codeg")).is_none());
    }

    #[test]
    fn a_copy_is_replaced_while_it_is_the_one_written_and_kept_once_changed() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("mount/usr/bin/codeg-cli");
        program(&source, "v1");
        let dir = root.path().join("bin");
        std::fs::create_dir_all(&dir).unwrap();
        let copy = dir.join("codeg-cli");

        write_copy(&copy, &source).unwrap();
        assert_eq!(std::fs::read_to_string(&copy).unwrap(), "v1");
        let recorded = std::fs::read_to_string(dir.join(SHA_FILE)).unwrap();
        assert_eq!(recorded, sha256(&copy).unwrap());

        // A newer image: the copy is still ours, so it is replaced.
        program(&source, "v2");
        write_copy(&copy, &source).unwrap();
        assert_eq!(std::fs::read_to_string(&copy).unwrap(), "v2");

        // Changed by the user: left alone from then on.
        std::fs::write(&copy, "mine").unwrap();
        program(&source, "v3");
        assert!(write_copy(&copy, &source).is_err());
        assert_eq!(std::fs::read_to_string(&copy).unwrap(), "mine");

        // A file found there with no record of ours is not ours either.
        let other = root.path().join("other");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join("codeg-cli"), "someone's").unwrap();
        assert!(write_copy(&other.join("codeg-cli"), &source).is_err());
    }

    /// The data directory outlives a change of package: an AppImage takes
    /// over the shim a deb/rpm install wrote, and the other way round.
    #[test]
    fn a_shim_and_a_copy_of_ours_replace_each_other() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("bin");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("codeg-cli");
        let source = root.path().join("image/codeg-cli");
        program(&source, "binary");

        write_shim(&file, Path::new("/usr/bin/codeg-cli")).unwrap();
        write_copy(&file, &source).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "binary");
        assert!(dir.join(SHA_FILE).exists());

        write_shim(&file, Path::new("/usr/bin/codeg-cli")).unwrap();
        assert!(is_our_shim(&file));
        assert!(
            !dir.join(SHA_FILE).exists(),
            "no record left to vouch for the next file"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_copy_in_use_is_replaced_by_a_rename_that_leaves_it_running() {
        use std::os::unix::fs::MetadataExt;
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("codeg-cli.src");
        program(&source, "v1");
        let copy = root.path().join("codeg-cli");
        write_copy(&copy, &source).unwrap();
        let before = std::fs::metadata(&copy).unwrap().ino();
        program(&source, "v2");
        write_copy(&copy, &source).unwrap();
        assert_ne!(
            std::fs::metadata(&copy).unwrap().ino(),
            before,
            "a new file under the name: the old one, if running, keeps going"
        );
    }
}
