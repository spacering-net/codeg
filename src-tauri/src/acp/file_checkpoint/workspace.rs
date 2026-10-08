use super::storage::{hash, sync_dir, ObjectBudget, Record, Store};
use super::CaptureControl;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

pub(super) const MAX_FILE: u64 = 16 * 1024 * 1024;
const MAX_SNAPSHOT: u64 = 128 * 1024 * 1024;
const MAX_FILES: usize = 20_000;
#[cfg(test)]
thread_local! {
    // Per-thread instrumentation proves scope verification never hashes regular
    // workspace contents without introducing timing-sensitive assertions.
    pub(super) static HASHED_BYTES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}
const EXCLUDED: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    "out",
    ".venv",
    "venv",
    "__pycache__",
    ".cache",
    "coverage",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct Entry {
    pub object: String,
    pub mode: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct Snapshot {
    pub files: BTreeMap<String, Entry>,
    pub scope: String,
}

#[cfg(test)]
pub(super) fn capture(store: &Store) -> Result<Snapshot, String> {
    scan(
        store,
        Some(ObjectBudget::default()),
        &CaptureControl::default(),
    )
}

pub(super) fn capture_controlled(
    store: &Store,
    record: &Record,
    control: &CaptureControl,
) -> Result<Snapshot, String> {
    scan(
        store,
        Some(ObjectBudget {
            active: Some(store.record_path(record)),
            ..Default::default()
        }),
        control,
    )
}

/// Bounded read-only verification; never adds objects to checkpoint storage.
pub(super) fn current_scope(store: &Store) -> Result<String, String> {
    Ok(scan(store, None, &CaptureControl::default())?.scope)
}

fn scan(
    store: &Store,
    mut budget: Option<ObjectBudget>,
    control: &CaptureControl,
) -> Result<Snapshot, String> {
    control.check()?;
    validate_absolute(&store.root)?;
    let root = store.root.clone();
    let filter_root = root.clone();
    let boundaries = std::sync::Arc::new(std::sync::Mutex::new(BTreeSet::new()));
    let found_boundaries = boundaries.clone();
    let filter_control = control.clone();
    let mut walker = ignore::WalkBuilder::new(&root);
    walker
        .hidden(false)
        .parents(false)
        .ignore(false)
        .git_ignore(true)
        .git_global(false)
        .git_exclude(false)
        .require_git(false)
        .follow_links(false)
        .filter_entry(move |entry| {
            if filter_control.check().is_err() {
                return false;
            }
            if entry.path() == filter_root {
                return true;
            }
            // Links are deliberately NOT filtered: they must fail the capture.
            if entry.file_type().is_some_and(|t| t.is_symlink()) {
                return true;
            }
            if entry
                .file_name()
                .to_str()
                .is_some_and(|name| EXCLUDED.iter().any(|x| name.eq_ignore_ascii_case(x)))
            {
                return false;
            }
            if entry.file_type().is_some_and(|t| t.is_dir())
                && fs::symlink_metadata(entry.path().join(".git")).is_ok()
            {
                found_boundaries
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(
                        entry
                            .path()
                            .strip_prefix(&filter_root)
                            .unwrap_or(entry.path())
                            .to_path_buf(),
                    );
                return false;
            }
            true
        });
    let mut files = BTreeMap::new();
    let mut policy = BTreeMap::new();
    let mut bytes = 0_u64;
    let mut visited = 0_usize;
    let mut file_count = 0;
    let mut canonical_dirs = BTreeSet::new();
    for item in walker.build() {
        control.check()?;
        let item = item.map_err(|e| format!("Incomplete checkpoint walk: {e}"))?;
        if let Some(error) = item.error() {
            return Err(format!("Incomplete checkpoint ignore policy: {error}"));
        }
        // Read policy files independently: a .gitignore may ignore itself.
        if item.path() == root || item.file_type().is_some_and(|t| t.is_dir()) {
            let policy_path = item.path().join(".gitignore");
            match fs::symlink_metadata(&policy_path) {
                Ok(_) => {
                    let name = policy_path
                        .strip_prefix(&root)
                        .map_err(|e| e.to_string())?
                        .to_str()
                        .ok_or("Non-UTF8 ignore policy path")?
                        .replace(std::path::MAIN_SEPARATOR, "/");
                    let (state, _) =
                        read_file_cached(&root, &name, Some(control), &mut canonical_dirs)?;
                    policy.insert(name, state.object);
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.to_string()),
            }
        }
        if item.path() == root {
            continue;
        }
        visited += 1;
        if visited > MAX_FILES * 2 {
            return Err("Checkpoint entry limit exceeded".into());
        }
        let meta = fs::symlink_metadata(item.path()).map_err(|e| e.to_string())?;
        reject_link(&meta)?;
        if meta.is_dir() {
            continue;
        }
        let relative = item.path().strip_prefix(&root).map_err(|e| e.to_string())?;
        let name = relative
            .to_str()
            .ok_or("Non-UTF8 checkpoint path")?
            .replace(std::path::MAIN_SEPARATOR, "/");
        validate_relative(&name)?;
        // Scope checks inspect only policy bytes and regular-file metadata. A
        // restore preview must not read/hash unrelated workspace file contents.
        let captured = if budget.is_some() {
            Some(read_file_cached(
                &root,
                &name,
                Some(control),
                &mut canonical_dirs,
            )?)
        } else {
            None
        };
        let size = if let Some((_, data)) = &captured {
            // Use the bytes actually read. A file can grow between the walk's
            // metadata read and the stable read_file_controlled snapshot.
            data.len() as u64
        } else {
            regular_handle(&open_read(item.path())?)?.len()
        };
        if size > MAX_FILE {
            return Err(format!("Checkpoint file exceeds 16 MiB: {name}"));
        }
        bytes = bytes.checked_add(size).ok_or("Checkpoint size overflow")?;
        file_count += 1;
        if bytes > MAX_SNAPSHOT || file_count > MAX_FILES {
            return Err("Checkpoint snapshot limit exceeded".into());
        }
        if let (Some(budget), Some((state, data))) = (&mut budget, captured) {
            store.put_object_controlled(&data, &state.object, budget, control)?;
            if relative.file_name().is_some_and(|n| n == ".gitignore") {
                policy.insert(name.clone(), state.object.clone());
            }
            files.insert(name, state);
        }
    }
    control.check()?;
    let boundaries = boundaries.lock().unwrap_or_else(|e| e.into_inner());
    let scope = hash(&serde_json::to_vec(&(policy, &*boundaries)).map_err(|e| e.to_string())?);
    control.check()?;
    Ok(Snapshot { files, scope })
}

pub(super) fn validate_relative(name: &str) -> Result<(), String> {
    if name.is_empty() || name.contains(['\\', ':', '\0']) || name.starts_with('/') {
        return Err(format!("Unsafe checkpoint path: {name}"));
    }
    for part in name.split('/') {
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.ends_with(['.', ' '])
            || EXCLUDED.iter().any(|x| part.eq_ignore_ascii_case(x))
        {
            return Err(format!("Unsafe/excluded checkpoint path: {name}"));
        }
        #[cfg(windows)]
        {
            let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
            if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                || (stem.len() == 4
                    && (stem.starts_with("COM") || stem.starts_with("LPT"))
                    && stem.as_bytes()[3].is_ascii_digit())
            {
                return Err(format!("Unsafe Windows device path: {name}"));
            }
        }
    }
    if Path::new(name)
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("Nonrelative checkpoint path".into());
    }
    Ok(())
}

pub(super) fn reject_link(meta: &Metadata) -> Result<(), String> {
    if meta.file_type().is_symlink() {
        return Err("Symlinks are outside checkpoint coverage".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return Err("Reparse points are outside checkpoint coverage".into());
        }
    }
    Ok(())
}

/// Validate every existing ancestor without following a link. Missing tail is OK.
pub(super) fn validate_absolute(path: &Path) -> Result<(), String> {
    let path = std::path::absolute(path).map_err(|e| e.to_string())?;
    let mut current = PathBuf::new();
    for component in path.components() {
        if matches!(component, Component::ParentDir | Component::CurDir) {
            return Err("Non-normal checkpoint absolute path".into());
        }
        current.push(component.as_os_str());
        // A Windows drive prefix alone is not an absolute filesystem entry.
        if matches!(component, Component::Prefix(_)) {
            continue;
        }
        match fs::symlink_metadata(&current) {
            Ok(meta) => {
                reject_link(&meta)?;
                if current != path && !meta.is_dir() {
                    return Err("Checkpoint ancestor is not a directory".into());
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}

pub(super) fn checked_path(root: &Path, name: &str) -> Result<PathBuf, String> {
    checked_path_cached(root, name, &mut BTreeSet::new())
}

// Cache canonical directory spellings only within one bounded workspace scan.
// Link/reparse-point, ancestor type and nested-repository checks remain fresh on
// EVERY access. Ordinary directory replacement keeps the same canonical spelling;
// link substitution is rejected before consulting this cache. Restore operations
// use checked_path above and never share this cache across operations.
fn checked_path_cached(
    root: &Path,
    name: &str,
    canonical_dirs: &mut BTreeSet<PathBuf>,
) -> Result<PathBuf, String> {
    validate_relative(name)?;
    let path = root.join(name);
    // This validates root and all its ancestors as well as the complete leaf
    // path, so a second validate_absolute(root) would repeat the same syscalls.
    validate_absolute(&path)?;
    if !canonical_dirs.contains(root) {
        let canonical = fs::canonicalize(root).map_err(|e| e.to_string())?;
        if canonical != root {
            return Err("Checkpoint root identity changed".into());
        }
        canonical_dirs.insert(root.to_path_buf());
    }
    let mut parent = path.parent();
    while let Some(p) = parent {
        if p == root {
            break;
        }
        if !p.starts_with(root) {
            return Err("Checkpoint path escapes root".into());
        }
        if fs::symlink_metadata(p.join(".git")).is_ok() {
            return Err("Checkpoint path became a nested repository".into());
        }
        if !canonical_dirs.contains(p) && p.exists() {
            if !fs::canonicalize(p)
                .map_err(|e| e.to_string())?
                .starts_with(root)
            {
                return Err("Checkpoint ancestor escapes root".into());
            }
            if canonical_dirs.len() < MAX_FILES * 2 + 1 {
                canonical_dirs.insert(p.to_path_buf());
            }
        }
        parent = p.parent();
    }
    Ok(path)
}

pub(super) fn regular_metadata(path: &Path) -> Result<Metadata, String> {
    let meta = fs::symlink_metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    reject_link(&meta)?;
    if !meta.is_file() {
        return Err(format!("Nonregular checkpoint file: {}", path.display()));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.nlink() != 1 {
            return Err("Hardlinks are outside checkpoint coverage".into());
        }
    }
    Ok(meta)
}

pub(super) fn regular_handle(file: &File) -> Result<Metadata, String> {
    let meta = file.metadata().map_err(|e| e.to_string())?;
    reject_link(&meta)?;
    if !meta.is_file() {
        return Err("Nonregular checkpoint handle".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.nlink() != 1 {
            return Err("Hardlinks are outside checkpoint coverage".into());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) } == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        if info.nNumberOfLinks != 1 {
            return Err("Hardlinks are outside checkpoint coverage".into());
        }
    }
    Ok(meta)
}

pub(super) fn open_read(path: &Path) -> Result<File, String> {
    regular_metadata(path)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000);
    }
    let file = options.open(path).map_err(|e| e.to_string())?;
    regular_handle(&file)?;
    Ok(file)
}

fn mode(meta: &Metadata) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o7777
    }
    #[cfg(not(unix))]
    {
        u32::from(meta.permissions().readonly())
    }
}

fn read_file(root: &Path, name: &str) -> Result<(Entry, Vec<u8>), String> {
    read_file_controlled(root, name, None)
}

/// Chunked IO/hash checks bound CPU work and avoid a single 16 MiB uninterruptible
/// hash/read loop. The operating system may still stall an individual disk call.
pub(super) fn read_hashed(
    file: &mut File,
    control: Option<&CaptureControl>,
) -> Result<(Vec<u8>, String), String> {
    let mut data = Vec::new();
    let mut hasher = Sha256::new();
    let mut chunk = [0_u8; 64 * 1024];
    loop {
        if let Some(control) = control {
            control.check()?;
        }
        let count = file.read(&mut chunk).map_err(|e| e.to_string())?;
        #[cfg(test)]
        HASHED_BYTES.with(|bytes| bytes.set(bytes.get() + count));
        if let Some(control) = control {
            control.check()?;
        }
        if count == 0 {
            break;
        }
        if data.len() as u64 + count as u64 > MAX_FILE {
            return Err("Checkpoint file exceeds 16 MiB".into());
        }
        hasher.update(&chunk[..count]);
        data.extend_from_slice(&chunk[..count]);
    }
    Ok((data, format!("{:x}", hasher.finalize())))
}

fn read_file_controlled(
    root: &Path,
    name: &str,
    control: Option<&CaptureControl>,
) -> Result<(Entry, Vec<u8>), String> {
    read_file_cached(root, name, control, &mut BTreeSet::new())
}

fn read_file_cached(
    root: &Path,
    name: &str,
    control: Option<&CaptureControl>,
    canonical_dirs: &mut BTreeSet<PathBuf>,
) -> Result<(Entry, Vec<u8>), String> {
    if let Some(control) = control {
        control.check()?;
    }
    let path = checked_path_cached(root, name, canonical_dirs)?;
    let mut file = open_read(&path)?;
    let before = regular_handle(&file)?;
    if before.len() > MAX_FILE {
        return Err(format!("Checkpoint file exceeds 16 MiB: {name}"));
    }
    let (data, object) = read_hashed(&mut file, control)?;
    let after = regular_handle(&file)?;
    if data.len() as u64 > MAX_FILE
        || data.len() as u64 != after.len()
        || before.len() != after.len()
        || before.modified().ok() != after.modified().ok()
        || mode(&before) != mode(&after)
    {
        return Err(format!("Checkpoint file changed during capture: {name}"));
    }
    checked_path_cached(root, name, canonical_dirs)?;
    Ok((
        Entry {
            object,
            mode: mode(&after),
        },
        data,
    ))
}

pub(super) fn current(root: &Path, name: &str) -> Result<Option<Entry>, String> {
    let path = checked_path(root, name)?;
    match fs::symlink_metadata(&path) {
        Ok(_) => read_file(root, name).map(|(state, _)| Some(state)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Atomically replace a single regular file. Permissions are set only on our
/// private fresh temporary inode, never on an existing (possibly linked) file.
pub(super) fn replace(
    store: &Store,
    name: &str,
    expected: &Option<Entry>,
    desired: &Option<Entry>,
) -> Result<(), String> {
    if current(&store.root, name)? != *expected {
        return Err(format!("File changed before write: {name}"));
    }
    let path = checked_path(&store.root, name)?;
    if let Some(entry) = desired {
        let bytes = store.object(&entry.object)?;
        let parent = path.parent().ok_or("Missing workspace parent")?;
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        checked_path(&store.root, name)?;
        let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
        temp.write_all(&bytes).map_err(|e| e.to_string())?;
        let mut permissions = temp
            .as_file()
            .metadata()
            .map_err(|e| e.to_string())?
            .permissions();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            permissions.set_mode(entry.mode);
        }
        #[cfg(not(unix))]
        permissions.set_readonly(entry.mode != 0);
        temp.as_file()
            .set_permissions(permissions)
            .map_err(|e| e.to_string())?;
        temp.as_file().sync_all().map_err(|e| e.to_string())?;
        if current(&store.root, name)? != *expected {
            return Err(format!("File changed before replacement: {name}"));
        }
        temp.persist(&path).map_err(|e| e.to_string())?;
        sync_dir(parent)?;
    } else {
        // Removing a leaf never recursively removes a directory or follows links.
        if expected.is_some() {
            fs::remove_file(&path).map_err(|e| e.to_string())?;
            sync_dir(path.parent().unwrap())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod path_cache_tests {
    use super::*;

    #[test]
    fn cached_directories_still_reject_new_repository_boundaries_and_non_directories() {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        fs::create_dir(root.join("src")).unwrap();
        fs::write(root.join("src/a"), b"a").unwrap();
        let mut cache = BTreeSet::new();
        checked_path_cached(&root, "src/a", &mut cache).unwrap();
        assert_eq!(cache.len(), 2);
        checked_path_cached(&root, "src/a", &mut cache).unwrap();
        assert_eq!(cache.len(), 2);
        fs::create_dir(root.join("src/.git")).unwrap();
        assert!(checked_path_cached(&root, "src/a", &mut cache)
            .unwrap_err()
            .contains("nested repository"));
        fs::remove_dir(root.join("src/.git")).unwrap();
        fs::remove_file(root.join("src/a")).unwrap();
        fs::remove_dir(root.join("src")).unwrap();
        fs::write(root.join("src"), b"now a file").unwrap();
        assert!(checked_path_cached(&root, "src/a", &mut cache)
            .unwrap_err()
            .contains("not a directory"));
    }

    #[cfg(unix)]
    #[test]
    fn cached_directory_spelling_does_not_allow_symlink_substitution() {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        fs::create_dir(root.join("src")).unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("a"), b"outside").unwrap();
        let mut cache = BTreeSet::new();
        checked_path_cached(&root, "src/a", &mut cache).unwrap();
        fs::remove_dir(root.join("src")).unwrap();
        std::os::unix::fs::symlink(outside.path(), root.join("src")).unwrap();
        assert!(checked_path_cached(&root, "src/a", &mut cache)
            .unwrap_err()
            .contains("Symlinks"));
    }
}
