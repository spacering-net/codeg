//! A plugin's files in the store: `<root>/<name>/<revision>/`, exactly the
//! revision's listed files.
//!
//! - **Staging** ([`stage_revision`]): every file written into
//!   `<root>/.staging/<op>/<revision>/` (each flushed, with its executable
//!   bit as listed), the folder read back and checked against the listing
//!   (every path, size and SHA-256, nothing more, no links), then renamed
//!   into place in one step. A revision folder is therefore whole or absent.
//!   One already in place is reused when it holds exactly the listing, and
//!   is an error when it does not: it is never overwritten.
//! - **Paths** follow the package rules (`harness::skills::package::safe_path`:
//!   relative, `/`-separated, one plain entry per segment, nothing that
//!   leaves the folder), no two the same ignoring case, no file where
//!   another needs a folder. The install name is one more such segment
//!   ([`InstallName`]).
//! - **Removing** ([`gc`]): a revision is moved into `<root>/.trash/` in one
//!   rename, then deleted, so a crash never leaves half a revision under its
//!   own name (where a later install would find it and refuse it). The
//!   startup recovery empties the trash.
//!
//! Claude Code and OpenCode load a plugin from where it is, so the revision
//! an agent last loaded must outlive the switch to the next one: a plugin
//! keeps its active and its previous revision until the next operation on
//! it. Everything here runs under the plugins lock.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::harness::skills::package::{is_sha256, safe_path, PackageFile};
use crate::harness::types::FileEntry;
use crate::skills::fsio::{create_dir_all_durable, flush_dir, op_id, remove_if_empty, rename};

use super::ctx::{InstallName, PluginsCtx};

/// A revision in place.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Staged {
    pub path: PathBuf,
    /// This call put it there (else it was there already, identical).
    pub created: bool,
}

/// Why a revision folder is not what its listing says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Mismatch {
    /// The folder is not there, or is not a plain folder (a link, a file).
    NotAFolder,
    Missing(String),
    /// Not the listed size or SHA-256.
    Differs(String),
    /// The executable bit is not the listed one.
    Mode(String),
    /// A file (or a link, or anything else) the listing does not have.
    Extra(String),
    Unreadable(String),
}

impl std::fmt::Display for Mismatch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Mismatch::NotAFolder => write!(f, "not a folder"),
            Mismatch::Missing(path) => write!(f, "{path}: missing"),
            Mismatch::Differs(path) => write!(f, "{path}: not the listed content"),
            Mismatch::Mode(path) => write!(f, "{path}: not the listed executable bit"),
            Mismatch::Extra(path) => write!(f, "{path}: not listed"),
            Mismatch::Unreadable(why) => write!(f, "{why}"),
        }
    }
}

fn mismatch_error(dir: &Path, problems: &[Mismatch]) -> io::Error {
    let shown: Vec<String> = problems.iter().take(5).map(Mismatch::to_string).collect();
    io::Error::other(format!(
        "{} is not the revision listed: {}",
        dir.display(),
        shown.join("; ")
    ))
}

/// The listing's own problems: a path that is not safe, two paths that are
/// one ignoring case, a file where another needs a folder, a hash that is not
/// one.
fn check_listing(listing: &[FileEntry]) -> io::Result<()> {
    let mut folded: BTreeSet<String> = BTreeSet::new();
    for file in listing {
        if !safe_path(&file.path) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("{}: not a path a package may hold", file.path),
            ));
        }
        if !is_sha256(&file.sha256) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("{}: not a SHA-256", file.path),
            ));
        }
        if !folded.insert(file.path.to_lowercase()) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("{}: listed twice", file.path),
            ));
        }
    }
    for path in &folded {
        let mut prefix = String::new();
        let segments: Vec<&str> = path.split('/').collect();
        for segment in &segments[..segments.len() - 1] {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(segment);
            if folded.contains(&prefix) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("{path}: a listed file is in the way"),
                ));
            }
        }
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn sha256_file(path: &Path) -> io::Result<String> {
    let mut hasher = Sha256::new();
    let mut file = fs::File::open(path)?;
    io::copy(&mut file, &mut hasher)?;
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(unix)]
fn is_executable(meta: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}

/// Whether `dir` holds exactly `listing`: every listed file with its size,
/// SHA-256 and (on Unix) executable bit; no other file — not even one the
/// skills hash ignores (`__pycache__/`, `*.pyc`): what an agent loads in
/// place is exactly what SRN vouched for; no link anywhere. Empty folders
/// are not counted.
pub fn verify_revision(dir: &Path, listing: &[FileEntry]) -> Result<(), Vec<Mismatch>> {
    if !fs::symlink_metadata(dir).is_ok_and(|meta| meta.is_dir()) {
        return Err(vec![Mismatch::NotAFolder]);
    }
    let listed: BTreeMap<&str, &FileEntry> = listing
        .iter()
        .map(|file| (file.path.as_str(), file))
        .collect();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut problems: Vec<Mismatch> = Vec::new();
    let mut dirs: Vec<(PathBuf, String)> = vec![(dir.to_path_buf(), String::new())];
    while let Some((current, rel)) = dirs.pop() {
        let entries = match fs::read_dir(&current) {
            Ok(entries) => entries,
            Err(error) => {
                problems.push(Mismatch::Unreadable(format!(
                    "{}: {error}",
                    current.display()
                )));
                continue;
            }
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    problems.push(Mismatch::Unreadable(format!(
                        "{}: {error}",
                        current.display()
                    )));
                    continue;
                }
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            let child = if rel.is_empty() {
                name
            } else {
                format!("{rel}/{name}")
            };
            // Not followed: a link is never part of a revision.
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(error) => {
                    problems.push(Mismatch::Unreadable(format!("{child}: {error}")));
                    continue;
                }
            };
            if file_type.is_dir() {
                dirs.push((entry.path(), child));
                continue;
            }
            let Some(file) = listed.get(child.as_str()).filter(|_| file_type.is_file()) else {
                problems.push(Mismatch::Extra(child));
                continue;
            };
            seen.insert(child.clone());
            let path = entry.path();
            let meta = match fs::symlink_metadata(&path) {
                Ok(meta) => meta,
                Err(error) => {
                    problems.push(Mismatch::Unreadable(format!("{child}: {error}")));
                    continue;
                }
            };
            if meta.len() != file.size {
                problems.push(Mismatch::Differs(child));
                continue;
            }
            match sha256_file(&path) {
                Ok(hash) if hash == file.sha256 => {}
                Ok(_) => {
                    problems.push(Mismatch::Differs(child));
                    continue;
                }
                Err(error) => {
                    problems.push(Mismatch::Unreadable(format!("{child}: {error}")));
                    continue;
                }
            }
            #[cfg(unix)]
            if is_executable(&meta) != file.executable {
                problems.push(Mismatch::Mode(child));
            }
        }
    }
    for path in listed.keys() {
        if !seen.contains(*path) {
            problems.push(Mismatch::Missing((*path).to_string()));
        }
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems)
    }
}

/// Write one file, flushed to disk, with the listed executable bit.
fn write_file(root: &Path, entry: &FileEntry, bytes: &[u8]) -> io::Result<()> {
    let path = root.join(entry.path.replace('/', std::path::MAIN_SEPARATOR_STR));
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut handle = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)?;
    handle.write_all(bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = if entry.executable { 0o755 } else { 0o644 };
        handle.set_permissions(fs::Permissions::from_mode(mode))?;
    }
    handle.sync_all()
}

/// Flush every folder under `root` (deepest first), and `root` itself.
fn flush_tree(root: &Path) -> io::Result<()> {
    let mut dirs = vec![root.to_path_buf()];
    let mut i = 0;
    while i < dirs.len() {
        for entry in fs::read_dir(&dirs[i])? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                dirs.push(entry.path());
            }
        }
        i += 1;
    }
    for dir in dirs.iter().rev() {
        flush_dir(dir)?;
    }
    Ok(())
}

/// `<root>/<name>`, made if missing; refused when it is a link or not a
/// folder (nothing is written through a link out of the store).
fn plugin_dir_for_write(ctx: &PluginsCtx, name: &InstallName) -> io::Result<PathBuf> {
    let dir = ctx.plugin_dir(name);
    match fs::symlink_metadata(&dir) {
        Ok(meta) if meta.is_dir() => Ok(dir),
        Ok(_) => Err(io::Error::other(format!(
            "{} is not a plain folder",
            dir.display()
        ))),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            create_dir_all_durable(&dir)?;
            Ok(dir)
        }
        Err(error) => Err(error),
    }
}

/// Put revision `revision` of `name` in place from `files`, checked against
/// `listing` (see the module docs). `op` names the staging folder: the
/// journal's operation, whose recovery clears it. Returns where it is and
/// whether this call made it.
pub(crate) fn stage_revision(
    ctx: &PluginsCtx,
    op: &str,
    name: &InstallName,
    revision: u64,
    listing: &[FileEntry],
    files: &[PackageFile],
) -> io::Result<Staged> {
    check_listing(listing)?;
    // `<root>/<name>` itself is never a link out of the store.
    if fs::symlink_metadata(ctx.plugin_dir(name)).is_ok_and(|meta| !meta.is_dir()) {
        return Err(io::Error::other(format!(
            "{} is not a plain folder",
            ctx.plugin_dir(name).display()
        )));
    }
    let target = ctx.revision_dir(name, revision);
    if fs::symlink_metadata(&target).is_ok() {
        return match verify_revision(&target, listing) {
            Ok(()) => Ok(Staged {
                path: target,
                created: false,
            }),
            Err(problems) => Err(mismatch_error(&target, &problems)),
        };
    }

    // The files given are exactly the listed ones, as listed.
    let by_path: BTreeMap<&str, &PackageFile> = files
        .iter()
        .map(|file| (file.path.as_str(), file))
        .collect();
    if by_path.len() != files.len() || files.len() != listing.len() {
        return Err(io::Error::other(
            "the package's files are not the ones listed",
        ));
    }
    for entry in listing {
        let Some(file) = by_path.get(entry.path.as_str()) else {
            return Err(io::Error::other(format!("{}: missing", entry.path)));
        };
        if file.bytes.len() as u64 != entry.size || sha256_hex(&file.bytes) != entry.sha256 {
            return Err(io::Error::other(format!(
                "{}: not the listed content",
                entry.path
            )));
        }
    }

    housekeeping_dir(&ctx.staging_root())?;
    let staging = ctx.staging_dir(op);
    create_dir_all_durable(&staging)?;
    let staged = staging.join(revision.to_string());
    fs::create_dir(&staged)?;
    for entry in listing {
        write_file(&staged, entry, &by_path[entry.path.as_str()].bytes)?;
    }
    flush_tree(&staged)?;
    flush_dir(&staging)?;
    // Read back from the disk, not trusted from memory.
    if let Err(problems) = verify_revision(&staged, listing) {
        return Err(mismatch_error(&staged, &problems));
    }
    ctx.fault("stage")?;

    let parent = plugin_dir_for_write(ctx, name)?;
    if fs::symlink_metadata(&target).is_ok() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("{} appeared while staging", target.display()),
        ));
    }
    rename(&staged, &target)?;
    flush_dir(&parent)?;
    ctx.fault("staged")?;
    remove_if_empty(&staging);
    remove_if_empty(&ctx.staging_root());
    Ok(Staged {
        path: target,
        created: true,
    })
}

/// Whether one of the store's own folders (`.staging`, `.ops`, `.trash`) is
/// there: `Ok(false)` when it is not, an error when it is anything but a
/// plain folder — a link would take what is written, or deleted, under it
/// out of the store.
pub(crate) fn housekeeping_dir(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => Ok(true),
        Ok(_) => Err(io::Error::other(format!(
            "{} is not a plain folder",
            path.display()
        ))),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

/// Move `path` into the trash in one rename, then delete it there. A
/// deletion that fails leaves it in the trash, for the next recovery.
pub(crate) fn discard(ctx: &PluginsCtx, path: &Path, label: &str) -> io::Result<()> {
    let trash = ctx.trash_dir();
    housekeeping_dir(&trash)?;
    create_dir_all_durable(&trash)?;
    let into = trash.join(format!("{label}-{}", op_id()));
    rename(path, &into)?;
    if let Some(parent) = path.parent() {
        flush_dir(parent)?;
    }
    ctx.fault("discarded")?;
    if fs::remove_dir_all(&into).is_ok() {
        remove_if_empty(&trash);
    }
    Ok(())
}

/// Delete everything in the trash (the startup recovery, under the lock).
pub(crate) fn empty_trash(ctx: &PluginsCtx) -> io::Result<()> {
    let trash = ctx.trash_dir();
    if !housekeeping_dir(&trash)? {
        return Ok(());
    }
    for entry in fs::read_dir(&trash)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            fs::remove_dir_all(entry.path())?;
        } else {
            fs::remove_file(entry.path())?;
        }
    }
    remove_if_empty(&trash);
    Ok(())
}

/// Remove every revision of `name` but `keep`; with nothing to keep, its
/// folder goes too once empty. Entries that are not a revision folder are
/// left alone. Returns the revisions removed. Refuses a `<root>/<name>` that
/// is a link or not a folder.
pub fn gc(ctx: &PluginsCtx, name: &InstallName, keep: &[u64]) -> io::Result<Vec<u64>> {
    let dir = ctx.plugin_dir(name);
    match fs::symlink_metadata(&dir) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
        Ok(meta) if !meta.is_dir() => {
            return Err(io::Error::other(format!(
                "{} is not a plain folder",
                dir.display()
            )))
        }
        Ok(_) => {}
    }
    let mut revisions: Vec<u64> = Vec::new();
    for entry in fs::read_dir(&dir)? {
        let entry = entry?;
        let file_name = entry.file_name().to_string_lossy().into_owned();
        let Ok(revision) = file_name.parse::<u64>() else {
            continue;
        };
        if revision.to_string() == file_name && !keep.contains(&revision) {
            revisions.push(revision);
        }
    }
    revisions.sort_unstable();
    for revision in &revisions {
        ctx.fault("gc")?;
        discard(
            ctx,
            &dir.join(revision.to_string()),
            &format!("{name}-{revision}"),
        )?;
    }
    if keep.is_empty() {
        remove_if_empty(&dir);
    }
    Ok(revisions)
}

/// Remove one revision this operation made (a rollback). Gone already: done.
pub(crate) fn remove_revision(
    ctx: &PluginsCtx,
    name: &InstallName,
    revision: u64,
) -> io::Result<()> {
    if fs::symlink_metadata(ctx.plugin_dir(name)).is_ok_and(|meta| !meta.is_dir()) {
        return Err(io::Error::other(format!(
            "{} is not a plain folder",
            ctx.plugin_dir(name).display()
        )));
    }
    let path = ctx.revision_dir(name, revision);
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
        Ok(_) => {
            discard(ctx, &path, &format!("{name}-{revision}"))?;
            remove_if_empty(&ctx.plugin_dir(name));
            Ok(())
        }
    }
}
