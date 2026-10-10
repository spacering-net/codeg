//! "New folder" for the directory browser: create one directory, by name,
//! inside a directory that already exists.
//!
//! The browser walks the filesystem of whichever host serves the workspace
//! (this machine on desktop, the server in web mode), so this is the same
//! operation in both runtimes: the Tauri command and the HTTP handler both
//! call [`create_directory_core`].
//!
//! It is deliberately narrower than `create_dir_all`: the name is a single
//! path component, nothing above it is created, and an existing entry of that
//! name — a file, a directory, or a symlink, dangling or not — is reported
//! instead of being reused, so a typo can never silently open some other
//! folder as the new project.

use std::collections::BTreeMap;
use std::io;
use std::path::Path;

use crate::app_error::AppCommandError;

/// Characters Windows refuses in a file name, beyond the separators and
/// control characters every platform rejects here.
const WINDOWS_RESERVED_CHARS: [char; 7] = ['<', '>', ':', '"', '|', '?', '*'];

/// Device names Windows reserves in every directory, with or without an
/// extension (`nul.txt` is the NUL device too). Windows also reads the
/// superscript digits ¹ ² ³ as port numbers, so `COM¹` is a device as well.
const WINDOWS_RESERVED_NAMES: [&str; 28] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "COM¹", "COM²", "COM³", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8",
    "LPT9", "LPT¹", "LPT²", "LPT³",
];

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CreateDirectoryError {
    #[error("folder name cannot be empty")]
    EmptyName,
    /// `.`, `..`, or a name the platform reserves (Windows device names, or a
    /// trailing dot Windows would silently strip).
    #[error("\"{0}\" cannot be used as a folder name")]
    ReservedName(String),
    #[error("folder name cannot contain path separators")]
    PathSeparator,
    #[error("folder name cannot contain control characters")]
    ControlCharacter,
    #[error("folder name cannot contain \"{0}\"")]
    ReservedCharacter(char),
    /// The parent is empty, relative, or not a directory.
    #[error("cannot create a folder in \"{0}\"")]
    InvalidParent(String),
    #[error("parent folder does not exist: {0}")]
    ParentNotFound(String),
    #[error("\"{name}\" already exists in {parent}")]
    AlreadyExists { name: String, parent: String },
    #[error("permission denied: {0}")]
    PermissionDenied(String),
    #[error("failed to create folder: {0}")]
    Io(String),
}

impl CreateDirectoryError {
    /// Key under the frontend's `DirectoryBrowser` namespace. Part of the wire
    /// contract with `directory-browser.tsx`; pinned by a test below.
    pub fn i18n_key(&self) -> &'static str {
        match self {
            Self::EmptyName => "newFolder.errors.empty",
            Self::ReservedName(_) => "newFolder.errors.reservedName",
            Self::PathSeparator => "newFolder.errors.separator",
            Self::ControlCharacter => "newFolder.errors.controlCharacter",
            Self::ReservedCharacter(_) => "newFolder.errors.reservedCharacter",
            Self::InvalidParent(_) => "newFolder.errors.invalidParent",
            Self::ParentNotFound(_) => "newFolder.errors.parentNotFound",
            Self::AlreadyExists { .. } => "newFolder.errors.alreadyExists",
            Self::PermissionDenied(_) => "newFolder.errors.permissionDenied",
            Self::Io(_) => "newFolder.errors.failed",
        }
    }

    fn i18n_params(&self) -> BTreeMap<String, String> {
        let pairs: Vec<(&str, String)> = match self {
            Self::ReservedName(name) => vec![("name", name.clone())],
            Self::ReservedCharacter(c) => vec![("character", c.to_string())],
            Self::InvalidParent(path) | Self::ParentNotFound(path) => {
                vec![("path", path.clone())]
            }
            Self::AlreadyExists { name, .. } => vec![("name", name.clone())],
            Self::Io(reason) => vec![("reason", reason.clone())],
            _ => Vec::new(),
        };
        pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect()
    }
}

impl From<CreateDirectoryError> for AppCommandError {
    fn from(err: CreateDirectoryError) -> Self {
        let message = err.to_string();
        let base = match &err {
            CreateDirectoryError::EmptyName
            | CreateDirectoryError::ReservedName(_)
            | CreateDirectoryError::PathSeparator
            | CreateDirectoryError::ControlCharacter
            | CreateDirectoryError::ReservedCharacter(_)
            | CreateDirectoryError::InvalidParent(_) => AppCommandError::invalid_input(message),
            CreateDirectoryError::ParentNotFound(_) => AppCommandError::not_found(message),
            CreateDirectoryError::AlreadyExists { .. } => AppCommandError::already_exists(message),
            CreateDirectoryError::PermissionDenied(_) => {
                AppCommandError::permission_denied(message)
            }
            CreateDirectoryError::Io(_) => AppCommandError::io_error(message),
        };
        base.with_i18n(err.i18n_key(), err.i18n_params())
    }
}

/// Check a typed folder name and return it without surrounding whitespace.
///
/// Unlike a path handed back from the tree, this one was typed by a person,
/// so leading and trailing whitespace is a slip rather than part of the name.
/// `windows` applies the extra rules of that platform; it is a parameter so
/// both rule sets are tested on every host.
fn validate_folder_name(name: &str, windows: bool) -> Result<&str, CreateDirectoryError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(CreateDirectoryError::EmptyName);
    }
    if name == "." || name == ".." {
        return Err(CreateDirectoryError::ReservedName(name.to_string()));
    }
    // Both separators on every platform, as the file tree's rename does: the
    // browser shows paths of both kinds, and a `\` inside a name reads as a
    // separator to anything that later takes the path Windows-style.
    if name.contains('/') || name.contains('\\') {
        return Err(CreateDirectoryError::PathSeparator);
    }
    // `char::is_control` covers NUL, the rest of C0, DEL and C1.
    if name.chars().any(char::is_control) {
        return Err(CreateDirectoryError::ControlCharacter);
    }
    if windows {
        if let Some(c) = name.chars().find(|c| WINDOWS_RESERVED_CHARS.contains(c)) {
            return Err(CreateDirectoryError::ReservedCharacter(c));
        }
        // Windows drops a trailing dot, so `notes.` would create `notes` and
        // the path returned would name a folder that does not exist.
        if name.ends_with('.') {
            return Err(CreateDirectoryError::ReservedName(name.to_string()));
        }
        let stem = name.split('.').next().unwrap_or(name).trim_end();
        if WINDOWS_RESERVED_NAMES
            .iter()
            .any(|reserved| stem.eq_ignore_ascii_case(reserved))
        {
            return Err(CreateDirectoryError::ReservedName(name.to_string()));
        }
    }
    Ok(name)
}

fn io_error(err: &io::Error, subject: &str) -> CreateDirectoryError {
    match err.kind() {
        io::ErrorKind::PermissionDenied => CreateDirectoryError::PermissionDenied(subject.into()),
        _ => CreateDirectoryError::Io(err.to_string()),
    }
}

/// Create the directory `name` inside `parent_path` and return its path.
///
/// - `parent_path` must be an absolute path to an existing directory. It is
///   used as given (a symlink to a directory is followed, as the browser does
///   when it lists one), and the result is `parent_path` joined with the
///   trimmed name — the same spelling the browser uses for that row.
/// - Exactly one directory is created: no missing ancestors are made.
/// - An existing entry with that name fails with `AlreadyExists`, including a
///   symlink, so the final component is never followed. `create_dir` itself
///   refuses an existing path too, which closes the gap between the check
///   and the creation.
pub fn create_directory_core(
    parent_path: &str,
    name: &str,
) -> Result<String, CreateDirectoryError> {
    let name = validate_folder_name(name, cfg!(windows))?;

    // Relative (or empty) would resolve against the process's working
    // directory, which the user never sees in the browser.
    let parent = Path::new(parent_path);
    if !parent.is_absolute() {
        return Err(CreateDirectoryError::InvalidParent(parent_path.to_string()));
    }
    match std::fs::metadata(parent) {
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => return Err(CreateDirectoryError::InvalidParent(parent_path.to_string())),
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            return Err(CreateDirectoryError::ParentNotFound(
                parent_path.to_string(),
            ));
        }
        Err(err) => return Err(io_error(&err, parent_path)),
    }

    let target = parent.join(name);
    let already_exists = || CreateDirectoryError::AlreadyExists {
        name: name.to_string(),
        parent: parent_path.to_string(),
    };
    // `symlink_metadata`, not `exists()`: a dangling symlink "doesn't exist"
    // to the latter, yet still occupies the name.
    if std::fs::symlink_metadata(&target).is_ok() {
        return Err(already_exists());
    }
    std::fs::create_dir(&target).map_err(|err| match err.kind() {
        io::ErrorKind::AlreadyExists => already_exists(),
        _ => io_error(&err, parent_path),
    })?;

    Ok(target.to_string_lossy().into_owned())
}

/// Desktop entry point; web mode reaches the same core through
/// `POST /api/create_directory`.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn create_directory(
    parent_path: String,
    name: String,
) -> Result<String, AppCommandError> {
    Ok(create_directory_core(&parent_path, &name)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_error::AppErrorCode;

    fn path_str(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn creates_one_directory_and_returns_its_path() {
        let dir = tempfile::tempdir().unwrap();
        let parent = path_str(dir.path());

        let created = create_directory_core(&parent, "my-project").unwrap();

        assert_eq!(created, path_str(&dir.path().join("my-project")));
        assert!(dir.path().join("my-project").is_dir());
    }

    #[test]
    fn trims_whitespace_around_a_typed_name() {
        let dir = tempfile::tempdir().unwrap();
        let created = create_directory_core(&path_str(dir.path()), "  spaced  ").unwrap();
        assert_eq!(created, path_str(&dir.path().join("spaced")));
        assert!(dir.path().join("spaced").is_dir());
    }

    #[test]
    fn keeps_unicode_and_inner_spaces() {
        let dir = tempfile::tempdir().unwrap();
        let created = create_directory_core(&path_str(dir.path()), "פרויקט חדש").unwrap();
        assert!(Path::new(&created).is_dir());
        assert!(created.ends_with("פרויקט חדש"));
    }

    #[test]
    fn rejects_an_existing_directory_instead_of_reusing_it() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("taken")).unwrap();
        std::fs::write(dir.path().join("taken").join("keep.txt"), "x").unwrap();

        let err = create_directory_core(&path_str(dir.path()), "taken").unwrap_err();

        assert_eq!(
            err,
            CreateDirectoryError::AlreadyExists {
                name: "taken".into(),
                parent: path_str(dir.path()),
            }
        );
        assert!(dir.path().join("taken").join("keep.txt").exists());
    }

    #[test]
    fn rejects_an_existing_file_of_that_name() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("notes"), "x").unwrap();
        let err = create_directory_core(&path_str(dir.path()), "notes").unwrap_err();
        assert!(matches!(err, CreateDirectoryError::AlreadyExists { .. }));
        assert!(dir.path().join("notes").is_file());
    }

    #[cfg(unix)]
    #[test]
    fn never_follows_a_symlink_in_the_final_component() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let elsewhere = outside.path().join("elsewhere");
        // Dangling: `exists()` would call this name free, and a follow would
        // create `elsewhere` outside the parent.
        std::os::unix::fs::symlink(&elsewhere, dir.path().join("link")).unwrap();
        // Live: pointing at a real directory must not count as success either.
        std::os::unix::fs::symlink(outside.path(), dir.path().join("live")).unwrap();

        for name in ["link", "live"] {
            let err = create_directory_core(&path_str(dir.path()), name).unwrap_err();
            assert!(
                matches!(err, CreateDirectoryError::AlreadyExists { .. }),
                "{name}: {err:?}"
            );
        }
        assert!(!elsewhere.exists());
    }

    #[cfg(unix)]
    #[test]
    fn follows_a_symlinked_parent_like_the_browser_does() {
        let real = tempfile::tempdir().unwrap();
        let holder = tempfile::tempdir().unwrap();
        let link = holder.path().join("projects");
        std::os::unix::fs::symlink(real.path(), &link).unwrap();

        let created = create_directory_core(&path_str(&link), "app").unwrap();

        // Spelled through the link, as the browser listed it; made in the target.
        assert_eq!(created, path_str(&link.join("app")));
        assert!(real.path().join("app").is_dir());
    }

    #[test]
    fn rejects_invalid_names() {
        let dir = tempfile::tempdir().unwrap();
        let parent = path_str(dir.path());
        let cases: [(&str, CreateDirectoryError); 9] = [
            ("", CreateDirectoryError::EmptyName),
            ("   ", CreateDirectoryError::EmptyName),
            (".", CreateDirectoryError::ReservedName(".".into())),
            ("..", CreateDirectoryError::ReservedName("..".into())),
            (" .. ", CreateDirectoryError::ReservedName("..".into())),
            ("a\0b", CreateDirectoryError::ControlCharacter),
            ("line\nbreak", CreateDirectoryError::ControlCharacter),
            ("tab\there", CreateDirectoryError::ControlCharacter),
            ("bell\u{7}", CreateDirectoryError::ControlCharacter),
        ];
        for (name, expected) in cases {
            assert_eq!(
                create_directory_core(&parent, name).unwrap_err(),
                expected,
                "{name:?}"
            );
        }
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn rejects_traversal_through_the_name() {
        let root = tempfile::tempdir().unwrap();
        let parent = root.path().join("parent");
        std::fs::create_dir(&parent).unwrap();
        let parent_str = path_str(&parent);

        for name in [
            "../escaped",
            "..\\escaped",
            "nested/child",
            "nested\\child",
            "/abs",
            "\\abs",
            "C:\\abs",
            "./here",
        ] {
            assert_eq!(
                create_directory_core(&parent_str, name).unwrap_err(),
                CreateDirectoryError::PathSeparator,
                "{name:?}"
            );
        }
        assert!(!root.path().join("escaped").exists());
        assert_eq!(std::fs::read_dir(&parent).unwrap().count(), 0);
    }

    #[test]
    fn creates_no_missing_ancestors() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing");

        let err = create_directory_core(&path_str(&missing), "child").unwrap_err();

        assert_eq!(
            err,
            CreateDirectoryError::ParentNotFound(path_str(&missing))
        );
        assert!(!missing.exists());
    }

    #[test]
    fn rejects_a_relative_empty_or_file_parent() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("file.txt");
        std::fs::write(&file, "x").unwrap();

        for parent in ["", "relative/dir", ".", path_str(&file).as_str()] {
            assert_eq!(
                create_directory_core(parent, "child").unwrap_err(),
                CreateDirectoryError::InvalidParent(parent.to_string()),
                "{parent:?}"
            );
        }
        assert!(!Path::new("relative/dir/child").exists());
    }

    #[test]
    fn windows_rules() {
        for name in ["a<b", "a>b", "a:b", "a\"b", "a|b", "a?b", "a*b"] {
            assert!(
                matches!(
                    validate_folder_name(name, true),
                    Err(CreateDirectoryError::ReservedCharacter(_))
                ),
                "{name:?}"
            );
        }
        for name in [
            "CON",
            "nul",
            "Com1",
            "lpt9",
            "aux.txt",
            "nul .txt",
            "COM¹",
            "lpt³",
            "Com².log",
            "trailing.",
        ] {
            assert!(
                matches!(
                    validate_folder_name(name, true),
                    Err(CreateDirectoryError::ReservedName(_))
                ),
                "{name:?}"
            );
        }
        for name in ["console", "COM10", "my.app", "nulled"] {
            assert_eq!(validate_folder_name(name, true), Ok(name), "{name:?}");
        }
        // Elsewhere those names are ordinary.
        for name in ["a:b", "CON", "trailing."] {
            assert_eq!(validate_folder_name(name, false), Ok(name), "{name:?}");
        }
    }

    #[test]
    fn maps_to_http_friendly_codes_with_i18n_keys() {
        let cases = [
            (CreateDirectoryError::EmptyName, "invalid_input"),
            (
                CreateDirectoryError::InvalidParent("x".into()),
                "invalid_input",
            ),
            (
                CreateDirectoryError::ParentNotFound("/x".into()),
                "not_found",
            ),
            (
                CreateDirectoryError::AlreadyExists {
                    name: "a".into(),
                    parent: "/x".into(),
                },
                "already_exists",
            ),
            (
                CreateDirectoryError::PermissionDenied("/x".into()),
                "permission_denied",
            ),
            (CreateDirectoryError::Io("boom".into()), "io_error"),
        ];
        for (err, code) in cases {
            let key = err.i18n_key();
            let app: AppCommandError = err.into();
            let wire = serde_json::to_value(app.code).unwrap();
            assert_eq!(wire, code);
            assert_eq!(app.i18n_key.as_deref(), Some(key));
        }

        let app: AppCommandError = CreateDirectoryError::AlreadyExists {
            name: "taken".into(),
            parent: "/home".into(),
        }
        .into();
        assert!(matches!(app.code, AppErrorCode::AlreadyExists));
        assert_eq!(
            app.i18n_key.as_deref(),
            Some("newFolder.errors.alreadyExists")
        );
        assert_eq!(
            app.i18n_params.unwrap().get("name").map(String::as_str),
            Some("taken")
        );
    }

    #[test]
    fn i18n_keys_stay_in_lockstep_with_the_frontend() {
        // `src/i18n/messages/*.json` → `DirectoryBrowser.newFolder.errors.*`.
        let keys = [
            CreateDirectoryError::EmptyName.i18n_key(),
            CreateDirectoryError::ReservedName(String::new()).i18n_key(),
            CreateDirectoryError::PathSeparator.i18n_key(),
            CreateDirectoryError::ControlCharacter.i18n_key(),
            CreateDirectoryError::ReservedCharacter('*').i18n_key(),
            CreateDirectoryError::InvalidParent(String::new()).i18n_key(),
            CreateDirectoryError::ParentNotFound(String::new()).i18n_key(),
            CreateDirectoryError::AlreadyExists {
                name: String::new(),
                parent: String::new(),
            }
            .i18n_key(),
            CreateDirectoryError::PermissionDenied(String::new()).i18n_key(),
            CreateDirectoryError::Io(String::new()).i18n_key(),
        ];
        let en: serde_json::Value =
            serde_json::from_str(include_str!("../../../src/i18n/messages/en.json")).unwrap();
        for key in keys {
            let mut node = &en["DirectoryBrowser"];
            for part in key.split('.') {
                node = &node[part];
            }
            assert!(node.is_string(), "missing en.json entry for {key}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn reports_a_read_only_parent_as_permission_denied() {
        use std::os::unix::fs::PermissionsExt;
        // root ignores mode bits, so there is nothing to observe there.
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let locked = dir.path().join("locked");
        std::fs::create_dir(&locked).unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555)).unwrap();

        let result = create_directory_core(&path_str(&locked), "child");

        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(
            result.unwrap_err(),
            CreateDirectoryError::PermissionDenied(path_str(&locked))
        );
    }
}
