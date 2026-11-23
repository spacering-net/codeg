//! The file-system pieces every skills writer shares: the hash that tells a
//! changed skill from an unchanged one, copying a skill tree, replacing a
//! file in one step, and comparing paths.
//!
//! **What a hash leaves out.** Files an agent's use of a skill leaves behind —
//! `__pycache__/`, `*.pyc`, `.DS_Store`, `Thumbs.db` — never count as a
//! change: running a Science skill's script once must not make it "modified"
//! at the next start. The hash is otherwise the one the pack manifests have
//! always recorded (`skills/<id>/<relative path>`, NUL, the bytes, NUL, in
//! path order), so existing manifests still match.
//!
//! **Atomic writes.** A `SKILL.md` is replaced through a temporary sibling,
//! synced, then renamed over it, so an agent — or a crash — never sees half
//! of one. Unlike the MCP engine's writer (`mcp_engine::fsio::write_atomic`,
//! which Codeg's own private files — the link record, the manifests — go
//! through), a new skill file gets the usual permissions: skills hold no
//! secrets, and a project's skills are read by whoever works on it.

use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};

/// A file or directory name the change detection, copies and backups skip.
pub(crate) fn is_ignored_name(name: &str) -> bool {
    name == "__pycache__" || name == ".DS_Store" || name == "Thumbs.db" || name.ends_with(".pyc")
}

/// Whether any component of a relative path is one the hash skips.
pub(crate) fn is_ignored_rel(rel: &str) -> bool {
    rel.split('/').any(is_ignored_name)
}

/// Every file under `root`, as (relative path with `/`, absolute path), in
/// path order. Links inside the tree are followed — a linked file counts as
/// its content, a linked folder as its files — except one that leads back
/// into a folder already being walked, which is skipped.
pub(crate) fn tree_files(root: &Path) -> io::Result<Vec<(String, PathBuf)>> {
    fn walk(
        dir: &Path,
        rel: &str,
        ancestors: &mut Vec<PathBuf>,
        out: &mut Vec<(String, PathBuf)>,
    ) -> io::Result<()> {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if is_ignored_name(&name) {
                continue;
            }
            let path = entry.path();
            let child_rel = if rel.is_empty() {
                name.clone()
            } else {
                format!("{rel}/{name}")
            };
            let file_type = entry.file_type()?;
            let (is_dir, is_file) = if file_type.is_symlink() {
                match fs::metadata(&path) {
                    Ok(meta) => (meta.is_dir(), meta.is_file()),
                    // A dangling link inside a skill holds nothing.
                    Err(_) => continue,
                }
            } else {
                (file_type.is_dir(), file_type.is_file())
            };
            if is_dir {
                let real = fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
                if ancestors.contains(&real) {
                    continue;
                }
                ancestors.push(real);
                walk(&path, &child_rel, ancestors, out)?;
                ancestors.pop();
            } else if is_file {
                out.push((child_rel, path));
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    if fs::metadata(root)
        .map(|meta| meta.is_dir())
        .unwrap_or(false)
    {
        let mut ancestors = vec![fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf())];
        walk(root, "", &mut ancestors, &mut out)?;
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

/// The hash of a skill directory, under the name `logical_id` (the id the
/// manifests key it by, whatever the folder is called — a copy, a backup).
/// A directory that does not exist hashes as an empty one.
pub(crate) fn hash_skill_dir(dir: &Path, logical_id: &str) -> io::Result<String> {
    let mut hasher = Sha256::new();
    for (rel, path) in tree_files(dir)? {
        let contents = fs::read(&path)?;
        hasher.update(format!("skills/{logical_id}/{rel}").as_bytes());
        hasher.update(b"\0");
        hasher.update(&contents);
        hasher.update(b"\0");
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// The same hash over files given as (path as `skills/<id>/<rel>`, bytes) —
/// a bundle compiled into the binary.
pub(crate) fn hash_bundle_files(files: &mut [(&str, &[u8])]) -> String {
    files.sort_by_key(|(path, _)| *path);
    let mut hasher = Sha256::new();
    for (path, contents) in files.iter() {
        // `skills/<id>/…`: the ignore list applies below the id.
        let below = path.splitn(3, '/').nth(2).unwrap_or("");
        if is_ignored_rel(below) {
            continue;
        }
        hasher.update(path.as_bytes());
        hasher.update(b"\0");
        hasher.update(contents);
        hasher.update(b"\0");
    }
    format!("{:x}", hasher.finalize())
}

/// Fail at `point` when a test armed it ([`hooks`]).
fn hook(point: &'static str) -> io::Result<()> {
    #[cfg(test)]
    if hooks::armed(point) {
        return Err(io::Error::other(format!("injected failure at {point}")));
    }
    let _ = point;
    Ok(())
}

/// Copy the tree at `src` to `dst`, which must not exist. Skips what the hash
/// skips; links inside are copied as what they lead to (see [`tree_files`]).
/// On failure, whatever was made of `dst` is removed.
pub(crate) fn copy_tree(src: &Path, dst: &Path) -> io::Result<()> {
    copy_tree_with(src, dst, false)
}

/// [`copy_tree`], with every file and directory of the copy flushed to disk
/// before it returns: for a copy whose original is deleted afterwards (a move
/// across volumes, a backup taken before what it backs up is replaced). A
/// flush that fails fails the copy.
pub(crate) fn copy_tree_durable(src: &Path, dst: &Path) -> io::Result<()> {
    copy_tree_with(src, dst, true)
}

fn copy_tree_with(src: &Path, dst: &Path, durable: bool) -> io::Result<()> {
    if fs::symlink_metadata(dst).is_ok() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("{} already exists", dst.display()),
        ));
    }
    let result = (|| {
        if durable {
            // The folders on the way to `dst` too: a copy that is on disk
            // under a name that is not is no copy after a power loss.
            create_dir_all_durable(dst)?;
        } else {
            fs::create_dir_all(dst)?;
        }
        let mut dirs: BTreeSet<PathBuf> = BTreeSet::new();
        dirs.insert(dst.to_path_buf());
        for (rel, path) in tree_files(src)? {
            let to = dst.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
            if let Some(parent) = to.parent() {
                fs::create_dir_all(parent)?;
                if durable {
                    // Every folder between `dst` and the file.
                    let mut dir = parent.to_path_buf();
                    while dir.starts_with(dst) && dirs.insert(dir.clone()) {
                        match dir.parent() {
                            Some(up) => dir = up.to_path_buf(),
                            None => break,
                        }
                    }
                }
            }
            if durable {
                copy_file_synced(&path, &to)?;
            } else {
                fs::copy(&path, &to)?;
            }
        }
        if durable {
            // Deepest first, so each folder's entries are down before it.
            for dir in dirs.iter().rev() {
                sync_dir_strict(dir)?;
            }
            if let Some(parent) = dst.parent() {
                sync_dir_strict(parent)?;
            }
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(dst);
    }
    result
}

/// Copy one file to `to` (which must not exist) and flush it to disk; its
/// permissions follow the original's. Written through a handle of its own,
/// so the flush works on every platform (Windows flushes only a handle open
/// for writing).
fn copy_file_synced(from: &Path, to: &Path) -> io::Result<()> {
    let mut source = fs::File::open(from)?;
    let permissions = source.metadata()?.permissions();
    let mut target = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(to)?;
    io::copy(&mut source, &mut target)?;
    hook("sync").and_then(|()| target.sync_all())?;
    #[cfg(test)]
    hooks::note_synced_file();
    drop(target);
    fs::set_permissions(to, permissions)
}

/// Flush a directory's entries to disk. On Unix a failure is an error; on
/// Windows a directory cannot be flushed this way, and its entries are
/// written through with the files.
fn sync_dir_strict(dir: &Path) -> io::Result<()> {
    hook("sync")?;
    #[cfg(test)]
    hooks::note_synced_dir(dir);
    #[cfg(unix)]
    {
        fs::File::open(dir)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
        Ok(())
    }
}

/// Keep what is at `path` (a manifest or record that cannot be read) at
/// `aside` as well — a second name for the same file where the file system
/// allows it, else a copy — WITHOUT taking it away from `path`: it stays the
/// active one until its replacement is renamed over it, so an interrupted or
/// failed replacement never leaves no file there at all. An `aside` from an
/// earlier time is replaced. Fails (and nothing is to be replaced) when what
/// is there can be neither linked nor copied.
pub(crate) fn keep_aside(path: &Path, aside: &Path) -> io::Result<()> {
    if fs::symlink_metadata(path).is_err() {
        return Ok(());
    }
    let _ = fs::remove_file(aside);
    if fs::hard_link(path, aside).is_ok() {
        return Ok(());
    }
    fs::copy(path, aside).map(|_| ())
}

/// A test's injected failure at `point` ([`hooks`]); nothing outside tests.
pub(crate) fn fault_point(point: &'static str) -> io::Result<()> {
    hook(point)
}

/// Flush `dir`'s entries to disk (a rename into it, say), before something
/// is discarded that relies on them. A failure is an error.
pub(crate) fn flush_dir(dir: &Path) -> io::Result<()> {
    sync_dir_strict(dir)
}

/// `fs::create_dir_all`, with every folder it created flushed into its
/// parent, so a copy put under `dir` is reachable after a power loss — not
/// only its own folder, but the entries naming each folder on the way.
pub(crate) fn create_dir_all_durable(dir: &Path) -> io::Result<()> {
    let mut missing: Vec<PathBuf> = Vec::new();
    let mut current = Some(dir);
    while let Some(path) = current.filter(|p| !p.as_os_str().is_empty()) {
        if fs::symlink_metadata(path).is_ok() {
            break;
        }
        missing.push(path.to_path_buf());
        current = path.parent();
    }
    fs::create_dir_all(dir)?;
    // Shallowest first: each new folder's entry, in the folder above it.
    for created in missing.iter().rev() {
        if let Some(parent) = created.parent().filter(|p| !p.as_os_str().is_empty()) {
            sync_dir_strict(parent)?;
        }
    }
    Ok(())
}

/// A name that is one plain entry of a directory and nothing more: not empty,
/// not `.` or `..`, no separator of either kind, no drive or stream colon, no
/// NUL — on every platform, so a name that is harmless here cannot replace
/// the directory it is joined to on Windows (`C:x`).
pub(crate) fn plain_name(name: &str) -> bool {
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', ':', '\0']) {
        return false;
    }
    let mut components = Path::new(name).components();
    matches!(
        (components.next(), components.next()),
        (Some(Component::Normal(only)), None) if only == std::ffi::OsStr::new(name)
    )
}

/// Wrap a single markdown file as `<dst>/SKILL.md`, flushed to disk (the
/// original may be deleted next: `skills_adopt`). `dst` must not exist.
pub(crate) fn copy_markdown_as_skill(src: &Path, dst: &Path) -> io::Result<()> {
    if fs::symlink_metadata(dst).is_ok() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("{} already exists", dst.display()),
        ));
    }
    let result = (|| {
        fs::create_dir_all(dst)?;
        copy_file_synced(src, &dst.join("SKILL.md"))?;
        sync_dir_strict(dst)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(dst);
    }
    result
}

fn sync_dir(dir: &Path) {
    #[cfg(unix)]
    if let Ok(handle) = fs::File::open(dir) {
        let _ = handle.sync_all();
    }
    #[cfg(not(unix))]
    let _ = dir;
}

/// `rename`, retried briefly on Windows, where a file another program has
/// open usually lets go within moments.
pub(crate) fn rename(from: &Path, to: &Path) -> io::Result<()> {
    let attempts = if cfg!(windows) { 4 } else { 1 };
    let mut last = None;
    for attempt in 0..attempts {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(err) => last = Some(err),
        }
        if attempt + 1 < attempts {
            std::thread::sleep(std::time::Duration::from_millis(40 * (attempt as u64 + 1)));
        }
    }
    Err(last.unwrap_or_else(|| io::Error::other("rename failed")))
}

/// Move a directory to a place that must not exist yet: a rename where it can
/// be one; across volumes, a copy that is flushed to disk and checked against
/// the original before the original goes.
pub(crate) fn move_dir(from: &Path, to: &Path, logical_id: &str) -> io::Result<()> {
    if fs::symlink_metadata(to).is_ok() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("{} already exists", to.display()),
        ));
    }
    if let Some(parent) = to.parent() {
        create_dir_all_durable(parent)?;
    }
    match hook("move_rename").and_then(|()| fs::rename(from, to)) {
        Ok(()) => {
            // One rename: nothing is discarded, the folder is under one name
            // or the other. Its new entry is flushed where that can be done.
            for dir in [to.parent(), from.parent()].into_iter().flatten() {
                if !dir.as_os_str().is_empty() {
                    let _ = sync_dir_strict(dir);
                }
            }
            Ok(())
        }
        Err(rename_err) => {
            // Most likely another volume. Copy (durably), compare, then
            // remove: the original goes only once its copy is on disk.
            copy_tree_durable(from, to).map_err(|copy_err| {
                io::Error::other(format!(
                    "move {} failed ({rename_err}); copy failed ({copy_err})",
                    from.display()
                ))
            })?;
            let compared = hash_skill_dir(from, logical_id)
                .and_then(|a| hash_skill_dir(to, logical_id).map(|b| a == b));
            match compared {
                Ok(true) => {}
                Ok(false) => {
                    let _ = fs::remove_dir_all(to);
                    return Err(io::Error::other(format!(
                        "the copy of {} does not match it",
                        from.display()
                    )));
                }
                Err(err) => {
                    let _ = fs::remove_dir_all(to);
                    return Err(err);
                }
            }
            fs::remove_dir_all(from)
        }
    }
}

/// Replace the file `path` (through its links, as writing in place would)
/// with `bytes`, in one step. A new file gets the usual permissions; an
/// existing one keeps its own. The directory must exist.
pub(crate) fn write_content_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::io::Write;
    let target = crate::commands::mcp_engine::fsio::resolve_symlinks(path);
    let parent = target
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "SKILL.md".to_string());
    let tmp = parent.join(format!(
        ".{name}.codeg-{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));
    let permissions = fs::metadata(&target).ok().map(|meta| meta.permissions());
    let staged = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        file.write_all(bytes)?;
        if let Some(permissions) = permissions {
            fs::set_permissions(&tmp, permissions)?;
        }
        file.sync_all()
    })();
    if let Err(err) = staged {
        let _ = fs::remove_file(&tmp);
        return Err(err);
    }
    if let Err(err) = rename(&tmp, &target) {
        let _ = fs::remove_file(&tmp);
        return Err(err);
    }
    sync_dir(&parent);
    Ok(())
}

/// Codeg's own files beside the skills (the link record, the manifests):
/// the MCP engine's writer, which makes a new file its owner's alone.
pub(crate) fn write_private_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    crate::commands::mcp_engine::fsio::write_atomic(path, bytes)
}

/// `path` with `.` and `..` taken out lexically.
pub(crate) fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Where a path really is: the longest part of it that exists, resolved
/// through links, with the rest appended. Two spellings of one directory
/// compare equal this way; nothing is created.
pub(crate) fn normalize(path: &Path) -> PathBuf {
    let path = lexical(path);
    if let Ok(real) = fs::canonicalize(&path) {
        return real;
    }
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut current = path.as_path();
    while let Some(parent) = current.parent() {
        if let Some(name) = current.file_name() {
            tail.push(name.to_os_string());
        }
        if parent.as_os_str().is_empty() {
            break;
        }
        if let Ok(real) = fs::canonicalize(parent) {
            let mut out = real;
            for name in tail.iter().rev() {
                out.push(name);
            }
            return out;
        }
        current = parent;
    }
    path
}

/// The identity of an entry in a directory: its directory normalized, its
/// own name as it is — an entry that is a link must not be resolved.
pub(crate) fn entry_key(path: &Path) -> PathBuf {
    match (path.parent(), path.file_name()) {
        (Some(dir), Some(name)) if !dir.as_os_str().is_empty() => normalize(dir).join(name),
        _ => lexical(path),
    }
}

/// `\\?\C:\x` → `C:\x`: how Windows hands back some targets, and every
/// canonical path.
pub(crate) fn strip_verbatim(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => path.to_path_buf(),
    }
}

/// Equality for two normalized paths; on Windows case-blind, and blind to
/// the verbatim prefix (`canonicalize` adds it, a junction's target and a
/// path as written lack it).
pub(crate) fn same_path(a: &Path, b: &Path) -> bool {
    #[cfg(windows)]
    {
        a == b
            || strip_verbatim(a)
                .to_string_lossy()
                .eq_ignore_ascii_case(&strip_verbatim(b).to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        a == b
    }
}

/// Whether the place `path` names, followed through every link on its way,
/// is inside `root` (both normalized).
pub(crate) fn resolves_into(path: &Path, root: &Path) -> bool {
    let real = normalize(path);
    let root = normalize(root);
    #[cfg(windows)]
    {
        let real = real.to_string_lossy().to_ascii_lowercase();
        let root = root.to_string_lossy().to_ascii_lowercase();
        real == root || real.starts_with(&format!("{}\\", root.trim_end_matches('\\')))
    }
    #[cfg(not(windows))]
    {
        real.starts_with(&root)
    }
}

/// A name for a fresh scratch directory.
pub(crate) fn op_id() -> String {
    format!(
        "{}-{}",
        chrono::Utc::now().format("%Y%m%dT%H%M%S"),
        uuid::Uuid::new_v4().simple()
    )
}

/// Remove `dir` if it is empty; anything else stays.
pub(crate) fn remove_if_empty(dir: &Path) {
    if fs::read_dir(dir)
        .map(|mut entries| entries.next().is_none())
        .unwrap_or(false)
    {
        let _ = fs::remove_dir(dir);
    }
}

/// The names in `dir` (an empty set when it cannot be read).
pub(crate) fn child_names(dir: &Path) -> BTreeSet<String> {
    fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default()
}

/// Test-only failures and counts for the pieces here that take no
/// [`super::SkillsCtx`] (per test thread).
#[cfg(test)]
pub(crate) mod hooks {
    use std::cell::{Cell, RefCell};
    use std::collections::BTreeSet;

    thread_local! {
        static ARMED: RefCell<BTreeSet<&'static str>> = const { RefCell::new(BTreeSet::new()) };
        static SYNCED_FILES: Cell<usize> = const { Cell::new(0) };
        static SYNCED_DIRS: RefCell<Vec<std::path::PathBuf>> = const { RefCell::new(Vec::new()) };
    }

    pub(crate) fn arm(point: &'static str) {
        ARMED.with(|armed| armed.borrow_mut().insert(point));
    }

    pub(crate) fn disarm() {
        ARMED.with(|armed| armed.borrow_mut().clear());
        SYNCED_FILES.with(|n| n.set(0));
        SYNCED_DIRS.with(|dirs| dirs.borrow_mut().clear());
    }

    pub(crate) fn armed(point: &str) -> bool {
        ARMED.with(|armed| armed.borrow().contains(point))
    }

    pub(crate) fn note_synced_file() {
        SYNCED_FILES.with(|n| n.set(n.get() + 1));
    }

    /// Files flushed to disk on this thread since [`disarm`].
    pub(crate) fn synced_files() -> usize {
        SYNCED_FILES.with(Cell::get)
    }

    pub(crate) fn note_synced_dir(dir: &std::path::Path) {
        SYNCED_DIRS.with(|dirs| dirs.borrow_mut().push(dir.to_path_buf()));
    }

    /// Directories flushed on this thread since [`disarm`], in order.
    pub(crate) fn synced_dirs() -> Vec<std::path::PathBuf> {
        SYNCED_DIRS.with(|dirs| dirs.borrow().clone())
    }
}
