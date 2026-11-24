//! Reading and writing the agents' config files: bytes in, bytes out.
//!
//! A write replaces the file in one step (a sibling temp file, synced, then
//! renamed over it), so an agent — or a crash — never sees half of one. In
//! every other respect it behaves like writing in place: a symlinked config
//! (a dotfiles checkout) is written through its link, which stays a link, and
//! an existing file keeps its permissions. A file codeg creates — and a
//! directory it has to create for one — is its owner's alone: these files
//! hold tokens.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use super::model::BASIS_MISSING;

/// How many copies of one file from before a write are kept.
pub(crate) const BACKUPS_KEPT: usize = 5;

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// What `mcp_inventory` reports and `mcp_apply` compares: the hash of the
/// file's bytes, or [`BASIS_MISSING`] for a file that is not there.
pub(crate) fn basis_of(bytes: Option<&[u8]>) -> String {
    match bytes {
        Some(bytes) => sha256_hex(bytes),
        None => BASIS_MISSING.to_string(),
    }
}

/// The file's bytes, `None` when it does not exist.
///
/// The absence test is the read itself, not `Path::exists()`, which answers
/// `false` for any failed stat — a permission wall, a symlink loop — and
/// would report a file codeg simply could not open as an absent one.
pub(crate) fn read_bytes(path: &Path) -> std::io::Result<Option<Vec<u8>>> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

pub(crate) fn is_symlink(path: &Path) -> bool {
    std::fs::symlink_metadata(path)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false)
}

/// Whether the file exists and carries no write permission for its owner.
/// codeg leaves such a file alone: whoever made it read-only meant it.
pub(crate) fn is_write_protected(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o200 == 0
    }
    #[cfg(not(unix))]
    {
        meta.permissions().readonly()
    }
}

/// The file `path` names once symlinks are followed (a dangling link resolves
/// to where it points), so a rename replaces that file and keeps the links.
pub(crate) fn resolve_symlinks(path: &Path) -> PathBuf {
    let mut current = path.to_path_buf();
    // A cycle gives up where the OS would (ELOOP), on the last link reached.
    for _ in 0..40 {
        let Ok(dest) = std::fs::read_link(&current) else {
            break;
        };
        current = match current.parent() {
            Some(parent) if dest.is_relative() => parent.join(dest),
            _ => dest,
        };
    }
    current
}

/// Create `path`, readable by its owner only on Unix, and write `bytes`.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<std::fs::File> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    Ok(file)
}

fn sync_dir(dir: &Path) {
    #[cfg(unix)]
    if let Ok(handle) = std::fs::File::open(dir) {
        let _ = handle.sync_all();
    }
    #[cfg(not(unix))]
    let _ = dir;
}

/// `rename`, retried briefly on Windows, where another program holding the
/// target open (a sharing violation) usually lets go within moments. A rename
/// that still fails is a failed write: nothing falls back to writing in
/// place.
fn rename_over(from: &Path, to: &Path) -> std::io::Result<()> {
    let attempts = if cfg!(windows) { 4 } else { 1 };
    let mut last = None;
    for attempt in 0..attempts {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) => last = Some(e),
        }
        if attempt + 1 < attempts {
            std::thread::sleep(std::time::Duration::from_millis(40 * (attempt as u64 + 1)));
        }
    }
    Err(last.unwrap_or_else(|| std::io::Error::other("rename failed")))
}

/// Replace `path` with `bytes` in one step. See the module docs.
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let target = resolve_symlinks(path);
    let parent = target
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    // A directory codeg has to make — an agent that is not installed yet —
    // is the owner's alone, like the file that goes into it.
    create_private_dir(&parent)?;
    let file_name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "config".to_string());
    let tmp = parent.join(format!(
        ".{file_name}.codeg-{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));
    let permissions = std::fs::metadata(&target)
        .ok()
        .map(|meta| meta.permissions());
    let staged = write_private(&tmp, bytes).and_then(|file| {
        if let Some(permissions) = permissions {
            std::fs::set_permissions(&tmp, permissions)?;
        }
        file.sync_all()
    });
    if let Err(e) = staged {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    if let Err(e) = rename_over(&tmp, &target) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    sync_dir(&parent);
    Ok(())
}

/// Remove the file `path` names (through its links); a file already gone is
/// no error.
pub(crate) fn remove_file(path: &Path) -> std::io::Result<()> {
    let target = resolve_symlinks(path);
    match std::fs::remove_file(&target) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(dir)
    }
}

fn backup_stem(file: &Path) -> String {
    let name = file
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "config".to_string());
    // The name becomes part of another file's name: keep it to characters
    // every file system takes.
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Keep `bytes` — a config file as it was before codeg changed it — under
/// `dir`, readable by its owner only, and drop all but the newest
/// [`BACKUPS_KEPT`] copies of that file. Returns where the copy is.
pub(crate) fn backup(dir: &Path, file: &Path, bytes: &[u8]) -> std::io::Result<PathBuf> {
    create_private_dir(dir)?;
    let stem = backup_stem(file);
    // Sortable by name: the time first, then this process's own count, so
    // copies taken within one tick of the clock still sort in order.
    static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%.6fZ");
    let sequence = SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed) % 1_000_000;
    let path = dir.join(format!("{stem}.{stamp}-{sequence:06}.bak"));
    let file = write_private(&path, bytes)?;
    file.sync_all()?;
    prune_backups(dir, &stem);
    Ok(path)
}

fn prune_backups(dir: &Path, stem: &str) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let prefix = format!("{stem}.");
    let mut copies: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name.strip_prefix(&prefix)
                        .and_then(|rest| rest.strip_suffix(".bak"))
                        // The stamp starts with the year: `settings.json.…`
                        // must not count as a copy of `settings.…`.
                        .is_some_and(|stamp| stamp.starts_with(|c: char| c.is_ascii_digit()))
                })
        })
        .collect();
    copies.sort();
    let excess = copies.len().saturating_sub(BACKUPS_KEPT);
    for old in copies.into_iter().take(excess) {
        let _ = std::fs::remove_file(old);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_write_replaces_the_file_and_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("config.json");
        write_atomic(&path, b"one").unwrap();
        write_atomic(&path, b"two").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"two");
        let names: Vec<String> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["config.json"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_new_file_is_private_and_an_existing_one_keeps_its_mode() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        write_atomic(&path, b"a = 1\n").unwrap();
        assert_eq!(mode(&path), 0o600);
        for kept in [0o644, 0o640, 0o600] {
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(kept)).unwrap();
            write_atomic(&path, b"a = 2\n").unwrap();
            assert_eq!(mode(&path), kept);
        }
    }

    /// The directories codeg has to make for a file — the home of an agent
    /// that is not installed yet — are the owner's alone; one that is already
    /// there keeps the mode it has.
    #[cfg(unix)]
    #[test]
    fn a_directory_made_for_a_file_is_private_and_an_existing_one_is_left_alone() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        let existing = dir.path().join("existing");
        std::fs::create_dir(&existing).unwrap();
        std::fs::set_permissions(&existing, std::fs::Permissions::from_mode(0o755)).unwrap();

        let path = existing.join("made").join("deeper").join("mcp.json");
        write_atomic(&path, b"{}").unwrap();
        assert_eq!(mode(&existing.join("made")), 0o700);
        assert_eq!(mode(&existing.join("made").join("deeper")), 0o700);
        assert_eq!(mode(&path), 0o600);
        assert_eq!(mode(&existing), 0o755);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_file_is_written_through_its_link() {
        let dir = tempfile::tempdir().unwrap();
        let real_dir = dir.path().join("dotfiles");
        std::fs::create_dir_all(&real_dir).unwrap();
        let real = real_dir.join("settings.json");
        std::fs::write(&real, "{}").unwrap();
        let link = dir.path().join("settings.json");
        std::os::unix::fs::symlink("dotfiles/settings.json", &link).unwrap();

        write_atomic(&link, b"{\"a\":1}").unwrap();
        assert!(is_symlink(&link));
        assert_eq!(std::fs::read(&real).unwrap(), b"{\"a\":1}");
        // No temp file was left beside the link either.
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2);

        remove_file(&link).unwrap();
        assert!(is_symlink(&link), "the link itself stays");
        assert!(!real.exists());
    }

    #[test]
    fn the_basis_tells_a_missing_file_from_an_empty_one() {
        assert_eq!(basis_of(None), BASIS_MISSING);
        assert_eq!(
            basis_of(Some(b"")),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn only_the_newest_copies_of_a_file_are_kept() {
        let dir = tempfile::tempdir().unwrap();
        let backups = dir.path().join("backups").join("codex");
        let file = Path::new("/somewhere/config.toml");
        let other = Path::new("/somewhere/config.toml.old");
        let mut made = Vec::new();
        for i in 0..(BACKUPS_KEPT + 3) {
            made.push(backup(&backups, file, format!("copy {i}").as_bytes()).unwrap());
        }
        let kept_other = backup(&backups, other, b"another file").unwrap();
        let left: Vec<PathBuf> = made.iter().filter(|path| path.exists()).cloned().collect();
        assert_eq!(left, made[3..].to_vec());
        assert!(kept_other.exists());
        assert_eq!(
            std::fs::read(made.last().unwrap()).unwrap(),
            format!("copy {}", BACKUPS_KEPT + 2).as_bytes()
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(made.last().unwrap()), 0o600);
            assert_eq!(mode(&backups), 0o700);
        }
    }
}
