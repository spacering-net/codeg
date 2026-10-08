use super::storage::{hash, sync_dir, Store};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

pub(super) const MAX_FILE: u64 = 16 * 1024 * 1024;
const MAX_SNAPSHOT: u64 = 128 * 1024 * 1024;
const MAX_FILES: usize = 20_000;
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

pub(super) fn capture(store: &Store) -> Result<Snapshot, String> {
    scan(store, true)
}

/// Bounded read-only verification; never adds objects to checkpoint storage.
pub(super) fn current_scope(store: &Store) -> Result<String, String> {
    Ok(scan(store, false)?.scope)
}

fn scan(store: &Store, persist: bool) -> Result<Snapshot, String> {
    validate_absolute(&store.root)?;
    let root = store.root.clone();
    let filter_root = root.clone();
    let boundaries = std::sync::Arc::new(std::sync::Mutex::new(BTreeSet::new()));
    let found_boundaries = boundaries.clone();
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
                found_boundaries.lock().unwrap_or_else(|e| e.into_inner())
                    .insert(entry.path().strip_prefix(&filter_root).unwrap_or(entry.path()).to_path_buf());
                return false;
            }
            true
        });
    let mut files = BTreeMap::new();
    let mut policy = BTreeMap::new();
    let mut bytes = 0_u64;
    let mut visited = 0_usize;
    let mut quota = None;
    for item in walker.build() {
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
                    let (state, _) = read_file(&root, &name)?;
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
        let (state, data) = read_file(&root, &name)?;
        bytes = bytes
            .checked_add(data.len() as u64)
            .ok_or("Checkpoint size overflow")?;
        if bytes > MAX_SNAPSHOT || files.len() >= MAX_FILES {
            return Err("Checkpoint snapshot limit exceeded".into());
        }
        if persist {
            store.put_object(&data, &mut quota)?;
        }
        if relative.file_name().is_some_and(|n| n == ".gitignore") {
            policy.insert(name.clone(), state.object.clone());
        }
        files.insert(name, state);
    }
    let boundaries = boundaries.lock().unwrap_or_else(|e| e.into_inner());
    let scope = hash(&serde_json::to_vec(&(policy, &*boundaries)).map_err(|e| e.to_string())?);
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
    validate_relative(name)?;
    validate_absolute(root)?;
    let canonical = fs::canonicalize(root).map_err(|e| e.to_string())?;
    if canonical != root {
        return Err("Checkpoint root identity changed".into());
    }
    let path = root.join(name);
    validate_absolute(&path)?;
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
        if p.exists()
            && !fs::canonicalize(p)
                .map_err(|e| e.to_string())?
                .starts_with(root)
        {
            return Err("Checkpoint ancestor escapes root".into());
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
    let path = checked_path(root, name)?;
    let mut file = open_read(&path)?;
    let before = regular_handle(&file)?;
    if before.len() > MAX_FILE {
        return Err(format!("Checkpoint file exceeds 16 MiB: {name}"));
    }
    let mut data = Vec::new();
    (&mut file)
        .take(MAX_FILE + 1)
        .read_to_end(&mut data)
        .map_err(|e| e.to_string())?;
    let after = regular_handle(&file)?;
    if data.len() as u64 > MAX_FILE
        || data.len() as u64 != after.len()
        || before.len() != after.len()
        || before.modified().ok() != after.modified().ok()
        || mode(&before) != mode(&after)
    {
        return Err(format!("Checkpoint file changed during capture: {name}"));
    }
    checked_path(root, name)?;
    Ok((
        Entry {
            object: hash(&data),
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
