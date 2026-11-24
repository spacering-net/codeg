//! The plugins OpenCode 2 loads from its global config, and codeg's edits to
//! that list.
//!
//! OpenCode 2 declares plugins in an ordered `plugins` array of strings and
//! `{ "package": …, "options": … }` objects (`packages/schema/src/config/
//! plugin.ts`), and still reads 1.x's `plugin` array — strings and
//! `[name, options]` pairs — listing those entries first
//! (`core/src/config/normalize.ts`: `encoded.plugins = [...legacyPlugins,
//! ...nativePlugins]`). It installs npm and git packages ITSELF when a session
//! starts (`core/src/plugin/supervisor.ts`, with npm's Arborist into
//! `$XDG_CACHE_HOME/opencode/npm/…`), so codeg edits the declaration and
//! nothing else: there is no package to install, cache to probe or version to
//! pin from here. Plugin code written for OpenCode 1 does not run in OpenCode 2.
//!
//! An entry is one of (`core/src/config/plugin/source.ts`,
//! `core/src/plugin/supervisor.ts`):
//! - a package spec — an npm name with an optional version or tag, or a git
//!   specifier;
//! - a local plugin: `./x` and `../x` resolve from the directory of the config
//!   file that declares them (not the project, as in 1.x), `file://` URLs and
//!   absolute paths are taken as they are, and the target has to be a
//!   directory — a configured path to a single file is skipped;
//! - a directive: `-name` turns a plugin off, and `*`, `name.*` and
//!   `opencode.*` select built-in plugins.
//!
//! codeg's edits go through [`opencode_config::edit_object`], so comments and
//! formatting outside the list survive, and an edit that touches the list moves
//! 1.x `plugin` entries into `plugins` first, so the file is left in one shape.

use std::path::{Component, Path, PathBuf};

use jsonc_parser::cst::{CstInputValue, CstNode};
use serde::Serialize;
use serde_json::{json, Value};

use crate::acp::opencode_config;
use crate::parsers::AgentEnv;

/// What an entry of the plugin list names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginKind {
    /// An npm or git package, which OpenCode installs itself.
    Package,
    /// A local plugin directory.
    Path,
    /// `-name` (turns a plugin off) or a selector of built-in plugins.
    Directive,
}

/// What is at the path a local plugin entry resolves to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginPathState {
    Directory,
    Missing,
    /// A file: OpenCode 2 loads a configured local plugin only from a
    /// directory, and skips this one.
    NotDirectory,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PluginEntry {
    /// The entry as declared: the string, or the `package` of an object (or of
    /// a 1.x `[name, options]` pair).
    pub spec: String,
    pub kind: PluginKind,
    /// Declared under OpenCode 1's `plugin` key rather than `plugins`.
    pub legacy: bool,
    /// The entry carries options (the object or pair form).
    pub has_options: bool,
    /// For a local plugin: the directory OpenCode 2 loads. `None` for other
    /// kinds, and for a `file://` URL that names another host.
    pub resolved_path: Option<String>,
    pub path_state: Option<PluginPathState>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PluginList {
    /// The global config file the list lives in (the one codeg edits).
    pub config_path: PathBuf,
    /// The declared entries in the order OpenCode applies them: the `plugin`
    /// (1.x) entries first, then `plugins`.
    pub plugins: Vec<PluginEntry>,
}

/// `$XDG_CONFIG_HOME` as an OpenCode launched with `env` resolves it, else
/// `~/.config` — on macOS too, never `~/Library/Application Support`.
pub(crate) fn xdg_config_home_for_env(env: &AgentEnv) -> Option<PathBuf> {
    // An empty XDG_CONFIG_HOME must fall back to ~/.config, not resolve to a
    // relative "opencode/..." path (matches the XDG_DATA_HOME handling).
    env.var_os("XDG_CONFIG_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".config")))
}

/// `$XDG_CACHE_HOME` as an OpenCode launched with `env` resolves it, else
/// `~/.cache`.
pub(crate) fn xdg_cache_home_for_env(env: &AgentEnv) -> Option<PathBuf> {
    env.var_os("XDG_CACHE_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".cache")))
}

/// The global config file codeg reads plugins from and writes them to.
fn config_path() -> Result<PathBuf, String> {
    opencode_config::config_file()
        .ok_or_else(|| "Cannot determine OpenCode's config directory".to_string())
}

/// The plugins declared in OpenCode's global config.
pub fn list_plugins() -> Result<PluginList, String> {
    list_plugins_at(&config_path()?)
}

/// Declare `spec` in `plugins` (a no-op when it already is), moving any 1.x
/// `plugin` entries into `plugins` on the way.
pub fn add_plugin(spec: &str) -> Result<PluginList, String> {
    let _mcp_lock = mcp_write_lock()?;
    add_plugin_at(&config_path()?, spec)
}

/// Remove every entry that declares `spec`, from either list, moving the
/// remaining 1.x `plugin` entries into `plugins`.
pub fn remove_plugin(spec: &str) -> Result<PluginList, String> {
    let _mcp_lock = mcp_write_lock()?;
    remove_plugin_at(&config_path()?, spec)
}

/// The MCP write lock: OpenCode's config also holds its MCP servers
/// (`mcp.servers`), which the MCP page edits, so a plugin edit and an MCP
/// save take turns at the file (see `commands::mcp_engine::lock`).
fn mcp_write_lock() -> Result<crate::commands::mcp_engine::lock::McpWriteGuard, String> {
    crate::commands::mcp_engine::lock::acquire_blocking().map_err(|e| e.to_string())
}

/// The config text at `path`, `""` for a file that is not there.
fn read_config_text(path: &Path) -> Result<String, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(text),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(err) => Err(format!("Failed to read {}: {err}", path.display())),
    }
}

fn parse_config(path: &Path, text: &str) -> Result<serde_json::Map<String, Value>, String> {
    opencode_config::parse_object(text).map_err(|e| format!("{}: {e}", path.display()))
}

/// One of the two lists, or the error that keeps codeg from editing it.
fn plugin_array<'a>(
    root: &'a serde_json::Map<String, Value>,
    key: &str,
    path: &Path,
) -> Result<&'a [Value], String> {
    match root.get(key) {
        None => Ok(&[]),
        Some(Value::Array(items)) => Ok(items),
        Some(_) => Err(format!(
            "`{key}` in {} is not a list; fix it by hand first",
            path.display()
        )),
    }
}

pub(crate) fn list_plugins_at(path: &Path) -> Result<PluginList, String> {
    let text = read_config_text(path)?;
    let root = parse_config(path, &text)?;
    let base = path.parent().unwrap_or_else(|| Path::new(""));
    let mut plugins = Vec::new();
    for (legacy, key) in [(true, "plugin"), (false, "plugins")] {
        for value in plugin_array(&root, key, path)? {
            let declared = if legacy {
                legacy_declaration(value)
            } else {
                native_declaration(value)
            };
            if let Some((spec, has_options)) = declared {
                plugins.push(describe(spec, legacy, has_options, base));
            }
        }
    }
    Ok(PluginList {
        config_path: path.to_path_buf(),
        plugins,
    })
}

/// A `plugins` entry as `(spec, has_options)`; `None` for a shape OpenCode 2
/// rejects.
fn native_declaration(value: &Value) -> Option<(&str, bool)> {
    match value {
        Value::String(spec) => Some((spec, false)),
        Value::Object(entry) => entry
            .get("package")
            .and_then(Value::as_str)
            .map(|spec| (spec, entry.contains_key("options"))),
        _ => None,
    }
}

/// A 1.x `plugin` entry — a string or a `[name, options]` pair — as
/// `(spec, has_options)`; `None` for a shape OpenCode rejects.
fn legacy_declaration(value: &Value) -> Option<(&str, bool)> {
    match value {
        Value::String(spec) => Some((spec, false)),
        Value::Array(pair) => match pair.as_slice() {
            [Value::String(spec), Value::Object(_)] => Some((spec, true)),
            _ => None,
        },
        _ => None,
    }
}

/// A 1.x `plugin` entry in the `plugins` form OpenCode 2 normalizes it to:
/// a pair becomes `{ "package", "options" }`; anything else stays as written.
fn native_form(value: &Value) -> Value {
    match value {
        Value::Array(pair) => match pair.as_slice() {
            [Value::String(spec), options @ Value::Object(_)] => {
                json!({ "package": spec, "options": options })
            }
            _ => value.clone(),
        },
        _ => value.clone(),
    }
}

/// Whether a list entry declares `spec` — the string itself, or the package
/// of an object or 1.x pair (what `opencode plugin remove` matches, too).
fn declares(value: &Value, spec: &str) -> bool {
    native_declaration(value)
        .or_else(|| legacy_declaration(value))
        .is_some_and(|(declared, _)| declared == spec)
}

fn describe(spec: &str, legacy: bool, has_options: bool, base: &Path) -> PluginEntry {
    let kind = classify(spec);
    let resolved = match kind {
        PluginKind::Path => resolve_local_target(spec, base),
        PluginKind::Package | PluginKind::Directive => None,
    };
    let path_state = resolved.as_deref().map(|target| {
        if target.is_dir() {
            PluginPathState::Directory
        } else if target.exists() {
            PluginPathState::NotDirectory
        } else {
            PluginPathState::Missing
        }
    });
    PluginEntry {
        spec: spec.to_string(),
        kind,
        legacy,
        has_options,
        resolved_path: resolved.map(|p| p.to_string_lossy().into_owned()),
        path_state,
    }
}

fn classify(spec: &str) -> PluginKind {
    if spec.starts_with('-') || spec == "*" || spec.ends_with(".*") || spec.starts_with("opencode.")
    {
        PluginKind::Directive
    } else if is_local_spec(spec) {
        PluginKind::Path
    } else {
        PluginKind::Package
    }
}

/// The entries OpenCode 2 loads from disk rather than installing: `file://`
/// URLs, `./` and `../` paths, and absolute paths (`source.ts` checks exactly
/// these; a bare `.\x` is not relative there, so it is not here either).
fn is_local_spec(spec: &str) -> bool {
    spec.starts_with("file://")
        || spec.starts_with("./")
        || spec.starts_with("../")
        || is_absolute_spec(spec)
}

/// `path.isAbsolute`, plus the Windows drive form on every host, so a config
/// written on Windows is not read as a package anywhere.
fn is_absolute_spec(spec: &str) -> bool {
    if Path::new(spec).is_absolute() || has_windows_drive_prefix(spec) {
        return true;
    }
    // Node's win32 `path.isAbsolute` also accepts a bare root (`\p`, `/p`),
    // which Rust rejects on Windows without a drive prefix.
    cfg!(windows) && (spec.starts_with('\\') || spec.starts_with('/'))
}

fn has_windows_drive_prefix(spec: &str) -> bool {
    let bytes = spec.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'/' || bytes[2] == b'\\')
}

/// The directory OpenCode 2 loads for a local plugin entry declared in a
/// config file under `base`: `fileURLToPath` for a `file://` URL, `./` and
/// `../` resolved against `base`, an absolute path as written. `None` for a
/// `file://` URL that names another host — no local file answers for it.
fn resolve_local_target(spec: &str, base: &Path) -> Option<PathBuf> {
    if let Some(body) = spec.strip_prefix("file://") {
        return file_url_body_to_path(body);
    }
    if spec.starts_with("./") || spec.starts_with("../") {
        return Some(lexical_join(base, spec));
    }
    Some(PathBuf::from(spec))
}

/// Lexical `path.resolve`: `.` components drop out and `..` pops one level.
/// Deliberately not `canonicalize`, which fails on exactly the case that has to
/// be reported — a path that is not there.
fn lexical_join(base: &Path, relative: &str) -> PathBuf {
    let mut out = base.to_path_buf();
    for component in Path::new(relative).components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// `fileURLToPath` for the host-less URLs users actually write.
fn file_url_body_to_path(body: &str) -> Option<PathBuf> {
    // WHATWG's Windows drive-letter quirk: in file host state a `C:` buffer is
    // NOT parsed as a host — it is handed to the path state instead, so
    // `file://C:/dir/p` and `file://C:\dir\p` both normalize to
    // `file:///C:/dir/p` with an EMPTY host, and `fileURLToPath` resolves them
    // rather than throwing `ERR_INVALID_FILE_URL_HOST`.
    let path_part = if has_windows_drive_prefix(body) {
        body.to_string()
    } else {
        // `localhost` is the only host Node accepts; anything else names a
        // machine, and no local file answers for it.
        match body.strip_prefix("localhost/") {
            Some(rest) => format!("/{rest}"),
            None if body.starts_with('/') => body.to_string(),
            None => return None,
        }
    };
    let decoded = urlencoding::decode(&path_part).ok()?.into_owned();
    // `file:///C:/x` decodes to `/C:/x`; Node drops that leading slash for the
    // Windows drive form.
    match decoded.strip_prefix('/') {
        Some(rest) if has_windows_drive_prefix(rest) => Some(PathBuf::from(rest)),
        _ => Some(PathBuf::from(decoded)),
    }
}

/// What a plugin edit does to the list.
#[derive(Clone, Copy)]
enum PluginChange<'a> {
    Add(&'a str),
    Remove(&'a str),
    /// Every declaration of `old` becomes one of `new`, in its place.
    Replace {
        old: &'a str,
        new: &'a str,
    },
}

fn validate_new_spec(spec: &str) -> Result<&str, String> {
    let spec = spec.trim();
    if spec.is_empty() {
        return Err("Enter a plugin package or a local plugin directory".to_string());
    }
    if spec.chars().any(char::is_whitespace) {
        return Err(format!(
            "\"{spec}\" is not a plugin package or path: it contains whitespace"
        ));
    }
    if spec.starts_with('-') {
        return Err(format!(
            "\"{spec}\" starts with '-', which OpenCode reads as turning a plugin off, not adding one"
        ));
    }
    Ok(spec)
}

/// A local plugin directory to declare as it is: an absolute path, taken
/// whole — spaces and all, which a typed spec may not have — but nothing
/// that trimming would change or that OpenCode would read as a directive.
fn validate_local_dir(spec: &str) -> Result<&str, String> {
    if spec.is_empty()
        || spec != spec.trim()
        || spec.starts_with('-')
        || spec.chars().any(char::is_control)
        || !is_absolute_spec(spec)
    {
        return Err(format!("\"{spec}\" is not an absolute plugin directory"));
    }
    Ok(spec)
}

pub(crate) fn add_plugin_at(path: &Path, spec: &str) -> Result<PluginList, String> {
    let spec = validate_new_spec(spec)?;
    apply_plugin_change(path, PluginChange::Add(spec))?;
    list_plugins_at(path)
}

/// [`add_plugin_at`] for a local plugin directory named by its absolute
/// path (Harness plugins in Codeg's store).
pub(crate) fn add_local_dir_at(path: &Path, dir: &str) -> Result<PluginList, String> {
    let dir = validate_local_dir(dir)?;
    apply_plugin_change(path, PluginChange::Add(dir))?;
    list_plugins_at(path)
}

/// Declare `new` where `old` is declared, in one edit: the last declaration
/// of `old` (whose options OpenCode goes by) takes `new` in its place — its
/// position, the comments around it and, in the object form, its options —
/// and any other one goes (all of them, when `new` is already declared).
/// With `old` the same as `new`, a spec declared more than once keeps only
/// its last declaration. Nothing changes when `old` is not
/// declared: a replacement never adds a plugin that was taken out.
pub(crate) fn replace_plugin_at(path: &Path, old: &str, new: &str) -> Result<PluginList, String> {
    let old = old.trim();
    if old.is_empty() {
        return Err("No plugin to replace".to_string());
    }
    let new = validate_local_dir(new).or_else(|_| validate_new_spec(new))?;
    apply_plugin_change(path, PluginChange::Replace { old, new })?;
    list_plugins_at(path)
}

pub(crate) fn remove_plugin_at(path: &Path, spec: &str) -> Result<PluginList, String> {
    let spec = spec.trim();
    if spec.is_empty() {
        return Err("No plugin to remove".to_string());
    }
    apply_plugin_change(path, PluginChange::Remove(spec))?;
    list_plugins_at(path)
}

/// Apply `change` to the config at `path`, writing only when the file changes.
///
/// Both lists are checked before anything is written: a `plugin` or `plugins`
/// that is not an array is refused rather than replaced. When `plugin` (1.x) is
/// present, its entries move to the front of `plugins` — where OpenCode 2
/// already applies them — and the key goes, so the file ends in one shape with
/// the same effective order.
fn apply_plugin_change(path: &Path, change: PluginChange<'_>) -> Result<(), String> {
    let text = read_config_text(path)?;
    let root = parse_config(path, &text)?;
    let legacy = plugin_array(&root, "plugin", path)?;
    let native = plugin_array(&root, "plugins", path)?;
    let has_legacy = root.contains_key("plugin");
    let is_declared = |spec: &str| {
        legacy
            .iter()
            .chain(native)
            .any(|value| declares(value, spec))
    };
    let declared = match change {
        PluginChange::Add(spec) | PluginChange::Remove(spec) => is_declared(spec),
        PluginChange::Replace { old, .. } => is_declared(old),
    };
    let changes_list = match change {
        PluginChange::Add(_) => !declared,
        PluginChange::Remove(_) => declared,
        // The same spec: only when it is declared more than once.
        PluginChange::Replace { old, new } if old == new => {
            legacy
                .iter()
                .chain(native)
                .filter(|value| declares(value, old))
                .count()
                > 1
        }
        PluginChange::Replace { .. } => declared,
    };
    // A replacement of what is not declared leaves the file as it is, 1.x
    // entries and all.
    let replacing = matches!(change, PluginChange::Replace { .. });
    if !changes_list && (!has_legacy || replacing) {
        return Ok(());
    }
    let migrated: Vec<Value> = legacy.iter().map(native_form).collect();

    let mut edited = false;
    let updated = opencode_config::edit_object(&text, |root| {
        if has_legacy {
            match root
                .array_value("plugins")
                .filter(|plugins| plugins.to_string().contains('\n'))
            {
                // A list laid out one entry per line takes the moved entries
                // the same way, and keeps what was written inside it.
                Some(plugins) => {
                    for (index, entry) in migrated.iter().enumerate() {
                        plugins.insert(index, opencode_config::cst_value(entry));
                    }
                }
                // An absent or one-line list is written afresh: entries moved
                // into a one-line list one by one would land half on the
                // bracket's line.
                None => {
                    let merged: Vec<Value> = migrated.iter().chain(native).cloned().collect();
                    opencode_config::set_property(root, "plugins", &Value::Array(merged));
                }
            }
            opencode_config::remove_property(root, "plugin");
        }
        let Some(plugins) = root.array_value_or_create("plugins") else {
            return;
        };
        match change {
            PluginChange::Add(spec) => {
                if !declared {
                    plugins.append(opencode_config::cst_value(&Value::String(spec.to_string())));
                }
            }
            PluginChange::Remove(spec) => {
                for element in plugins.elements() {
                    if element_declares(&element, spec) {
                        element.remove();
                    }
                }
            }
            PluginChange::Replace { old, new } => {
                // With `new` declared already, the old ones only go. Else the
                // last declaration takes it — OpenCode goes by the options
                // of the last one that loads — and the earlier ones go.
                let mut placed = old != new && is_declared(new);
                let matching: Vec<CstNode> = plugins
                    .elements()
                    .into_iter()
                    .filter(|element| element_declares(element, old))
                    .collect();
                for element in matching.into_iter().rev() {
                    if !placed && replace_declaration(&element, new) {
                        placed = true;
                    } else {
                        element.remove();
                    }
                }
            }
        }
        edited = true;
    })
    .map_err(|e| format!("{}: {e}", path.display()))?;
    if !edited {
        return Err(format!(
            "`plugins` in {} is not a list; fix it by hand first",
            path.display()
        ));
    }
    opencode_config::write_atomic(path, &updated)
}

/// Whether a list element declares `spec`: its own text, comments and all,
/// read back the way the file was.
fn element_declares(element: &CstNode, spec: &str) -> bool {
    opencode_config::parse(&element.to_string()).is_ok_and(|value| declares(&value, spec))
}

/// Make `element` declare `spec` instead: a string becomes `spec`, an
/// object's `package` does and a 1.x pair's name (their options stay).
/// `false` for any other form.
fn replace_declaration(element: &CstNode, spec: &str) -> bool {
    let value = CstInputValue::String(spec.to_string());
    if let Some(text) = element.as_string_lit() {
        text.replace_with(value);
        return true;
    }
    if let Some(pair) = element.as_array() {
        return match pair.elements().first().and_then(CstNode::as_string_lit) {
            Some(text) => {
                text.replace_with(value);
                true
            }
            None => false,
        };
    }
    match element.as_object().and_then(|object| object.get("package")) {
        Some(package) => {
            package.set_value(value);
            true
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn read_value(path: &Path) -> Value {
        opencode_config::parse(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn specs(list: &PluginList) -> Vec<(&str, PluginKind, bool)> {
        list.plugins
            .iter()
            .map(|p| (p.spec.as_str(), p.kind, p.legacy))
            .collect()
    }

    #[test]
    fn lists_legacy_entries_first_then_plugins() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opencode.jsonc");
        write(
            &path,
            r#"{
  // both lists, the way a half-migrated file looks
  "plugins": ["native-a", { "package": "native-b", "options": { "x": 1 } }, 42],
  "plugin": ["legacy-a", ["legacy-b", { "y": 2 }], ["not", "a", "pair"]],
}"#,
        );
        let list = list_plugins_at(&path).unwrap();
        assert_eq!(list.config_path, path);
        assert_eq!(
            specs(&list),
            vec![
                ("legacy-a", PluginKind::Package, true),
                ("legacy-b", PluginKind::Package, true),
                ("native-a", PluginKind::Package, false),
                ("native-b", PluginKind::Package, false),
            ]
        );
        assert!(list.plugins[1].has_options);
        assert!(list.plugins[3].has_options);
        assert!(!list.plugins[0].has_options);
    }

    #[test]
    fn a_missing_file_lists_nothing_and_a_broken_one_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opencode.json");
        assert!(list_plugins_at(&path).unwrap().plugins.is_empty());
        write(&path, "{ \"plugins\": [");
        assert!(list_plugins_at(&path).is_err());
        write(&path, "{ \"plugins\": \"oops\" }");
        let err = list_plugins_at(&path).unwrap_err();
        assert!(err.contains("not a list"), "{err}");
    }

    #[test]
    fn classifies_packages_paths_and_directives_the_way_opencode_2_does() {
        for (spec, kind) in [
            ("oh-my-opencode", PluginKind::Package),
            ("@scope/name@1.2.3", PluginKind::Package),
            ("github:user/repo#main", PluginKind::Package),
            ("./plugins/local", PluginKind::Path),
            ("../shared/plugin", PluginKind::Path),
            ("file:///srv/plugins/p", PluginKind::Path),
            ("/srv/plugins/p", PluginKind::Path),
            ("C:\\plugins\\p", PluginKind::Path),
            ("-oh-my-opencode", PluginKind::Directive),
            ("*", PluginKind::Directive),
            ("opencode.*", PluginKind::Directive),
            ("opencode.browser", PluginKind::Directive),
            ("acme.*", PluginKind::Directive),
        ] {
            assert_eq!(classify(spec), kind, "{spec}");
        }
    }

    /// OpenCode 2 resolves `./` from the directory of the file that declares
    /// it (1.x used the project), and loads a configured local plugin only
    /// from a directory.
    #[test]
    fn local_plugins_resolve_from_the_config_dir_and_must_be_directories() {
        let dir = tempfile::tempdir().unwrap();
        let config_dir = dir.path().join("config");
        let path = config_dir.join("opencode.json");
        std::fs::create_dir_all(config_dir.join("plugins").join("good")).unwrap();
        write(&config_dir.join("plugins").join("single.ts"), "export {}");
        let file_url = format!(
            "file://{}",
            config_dir.join("plugins").join("good").to_string_lossy()
        );
        write(
            &path,
            &serde_json::json!({
                "plugins": ["./plugins/good", "./plugins/single.ts", "../elsewhere/gone", file_url]
            })
            .to_string(),
        );
        let list = list_plugins_at(&path).unwrap();
        let states: Vec<_> = list
            .plugins
            .iter()
            .map(|p| (p.resolved_path.clone(), p.path_state))
            .collect();
        assert_eq!(
            states,
            vec![
                (
                    Some(
                        config_dir
                            .join("plugins")
                            .join("good")
                            .to_string_lossy()
                            .into_owned()
                    ),
                    Some(PluginPathState::Directory)
                ),
                (
                    Some(
                        config_dir
                            .join("plugins")
                            .join("single.ts")
                            .to_string_lossy()
                            .into_owned()
                    ),
                    Some(PluginPathState::NotDirectory)
                ),
                (
                    Some(
                        dir.path()
                            .join("elsewhere")
                            .join("gone")
                            .to_string_lossy()
                            .into_owned()
                    ),
                    Some(PluginPathState::Missing)
                ),
                (
                    Some(
                        config_dir
                            .join("plugins")
                            .join("good")
                            .to_string_lossy()
                            .into_owned()
                    ),
                    Some(PluginPathState::Directory)
                ),
            ]
        );
    }

    #[test]
    fn file_urls_decode_the_way_node_decodes_them() {
        assert_eq!(
            file_url_body_to_path("/tmp/a%20b/p"),
            Some(PathBuf::from("/tmp/a b/p"))
        );
        assert_eq!(
            file_url_body_to_path("localhost/tmp/p"),
            Some(PathBuf::from("/tmp/p"))
        );
        // A real host is not a local file.
        assert_eq!(file_url_body_to_path("example.com/tmp/p"), None);
        // The Windows drive form loses the slash Node drops, and a drive
        // letter in the host slot is pushed into the path.
        assert_eq!(
            file_url_body_to_path("/C:/plugins/p"),
            Some(PathBuf::from("C:/plugins/p"))
        );
        assert_eq!(
            file_url_body_to_path("C:/plugins/p"),
            Some(PathBuf::from("C:/plugins/p"))
        );
    }

    #[test]
    fn adding_appends_to_plugins_and_creates_the_file_when_needed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opencode.json");
        let list = add_plugin_at(&path, "  opencode-helicone@1.0.0 ").unwrap();
        assert_eq!(
            specs(&list),
            vec![("opencode-helicone@1.0.0", PluginKind::Package, false)]
        );
        assert_eq!(
            read_value(&path),
            serde_json::json!({ "plugins": ["opencode-helicone@1.0.0"] })
        );

        // Declaring it again changes nothing, not even the file's bytes.
        let before = std::fs::read_to_string(&path).unwrap();
        add_plugin_at(&path, "opencode-helicone@1.0.0").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
    }

    #[test]
    fn adding_refuses_what_is_not_a_plugin_to_add() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opencode.json");
        assert!(add_plugin_at(&path, "   ").is_err());
        assert!(add_plugin_at(&path, "two words").is_err());
        assert!(add_plugin_at(&path, "-oh-my-opencode").is_err());
        assert!(!path.exists(), "a refused add writes nothing");
    }

    /// The edit that touches the list leaves the file in OpenCode 2's shape:
    /// the 1.x entries move to the front of `plugins`, where OpenCode already
    /// applies them, pairs become objects, and `plugin` goes.
    #[test]
    fn an_edit_moves_legacy_entries_into_plugins_in_effective_order() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opencode.json");
        write(
            &path,
            r#"{
  "plugin": ["legacy-a", ["legacy-b", { "y": 2 }]],
  "plugins": ["native-a"]
}"#,
        );
        add_plugin_at(&path, "added").unwrap();
        let value = read_value(&path);
        assert!(value.get("plugin").is_none(), "{value}");
        assert_eq!(
            value["plugins"],
            serde_json::json!([
                "legacy-a",
                { "package": "legacy-b", "options": { "y": 2 } },
                "native-a",
                "added"
            ])
        );
    }

    #[test]
    fn removing_drops_every_declaration_of_the_spec_from_either_list() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opencode.json");
        write(
            &path,
            r#"{
  "plugin": [["dup", { "from": "v1" }], "keep-legacy"],
  "plugins": ["dup", { "package": "dup" }, "keep-native"]
}"#,
        );
        let list = remove_plugin_at(&path, "dup").unwrap();
        assert_eq!(
            specs(&list),
            vec![
                ("keep-legacy", PluginKind::Package, false),
                ("keep-native", PluginKind::Package, false),
            ]
        );
        assert_eq!(
            read_value(&path),
            serde_json::json!({ "plugins": ["keep-legacy", "keep-native"] })
        );

        // Removing what is not declared leaves the file alone.
        let before = std::fs::read_to_string(&path).unwrap();
        remove_plugin_at(&path, "never-declared").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
    }

    #[test]
    fn an_add_and_a_remove_keep_comments_in_an_opencode_jsonc() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opencode.jsonc");
        let original = r#"{
  // My OpenCode setup.
  "model": "anthropic/claude-sonnet-5-5", // the default model
  "plugins": [
    "first", // keep this one
  ],
  /* trailing block comment */
}
"#;
        write(&path, original);
        add_plugin_at(&path, "second").unwrap();
        let added = std::fs::read_to_string(&path).unwrap();
        for comment in [
            "// My OpenCode setup.",
            "// the default model",
            "// keep this one",
            "/* trailing block comment */",
        ] {
            assert!(added.contains(comment), "{comment} lost:\n{added}");
        }
        assert_eq!(
            opencode_config::parse(&added).unwrap()["plugins"],
            serde_json::json!(["first", "second"])
        );

        remove_plugin_at(&path, "second").unwrap();
        let removed = std::fs::read_to_string(&path).unwrap();
        for comment in [
            "// My OpenCode setup.",
            "// the default model",
            "// keep this one",
            "/* trailing block comment */",
        ] {
            assert!(removed.contains(comment), "{comment} lost:\n{removed}");
        }
        let value = opencode_config::parse(&removed).unwrap();
        assert_eq!(value["plugins"], serde_json::json!(["first"]));
        assert_eq!(value["model"], "anthropic/claude-sonnet-5-5");
    }

    #[test]
    fn an_edit_refuses_a_config_it_cannot_read_and_leaves_it_alone() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opencode.json");
        for broken in ["{ \"plugins\": [", "{ \"plugin\": \"not-a-list\" }"] {
            write(&path, broken);
            assert!(add_plugin_at(&path, "x").is_err(), "{broken}");
            assert!(remove_plugin_at(&path, "x").is_err(), "{broken}");
            assert_eq!(std::fs::read_to_string(&path).unwrap(), broken);
        }
    }

    /// The list follows the file OpenCode reads: `OPENCODE_CONFIG_DIR` over
    /// `XDG_CONFIG_HOME`, and `opencode.jsonc` over `opencode.json`.
    #[test]
    fn the_list_lives_in_the_config_file_opencode_reads() {
        let dir = tempfile::tempdir().unwrap();
        let own = dir.path().join("own");
        write(
            &own.join("opencode.json"),
            r#"{ "plugins": ["from-json"] }"#,
        );
        write(
            &own.join("opencode.jsonc"),
            r#"{ "plugins": ["from-jsonc"] }"#,
        );
        let xdg = dir.path().join("xdg");
        temp_env::with_vars(
            [
                ("OPENCODE_CONFIG_DIR", Some(own.as_os_str())),
                ("XDG_CONFIG_HOME", Some(xdg.as_os_str())),
            ],
            || {
                let list = list_plugins().unwrap();
                assert_eq!(list.config_path, own.join("opencode.jsonc"));
                assert_eq!(list.plugins[0].spec, "from-jsonc");
                add_plugin("added").unwrap();
                assert_eq!(
                    read_value(&own.join("opencode.jsonc"))["plugins"],
                    serde_json::json!(["from-jsonc", "added"])
                );
                assert_eq!(
                    read_value(&own.join("opencode.json"))["plugins"],
                    serde_json::json!(["from-json"])
                );
            },
        );
    }
    #[test]
    fn a_replacement_keeps_the_entry_s_place_its_comments_and_its_options() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opencode.jsonc");
        let original = r#"{
  // My OpenCode setup.
  "plugins": [
    "first", // keep this one
    "/store/p/4", // Codeg's
    { "package": "/store/q/1", "options": { "x": 1 } },
    "last",
  ],
}
"#;
        write(&path, original);
        replace_plugin_at(&path, "/store/p/4", "/store/p/5").unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            text,
            original.replace("\"/store/p/4\"", "\"/store/p/5\""),
            "one edit, nothing else moved"
        );

        replace_plugin_at(&path, "/store/q/1", "/store/q/2").unwrap();
        assert_eq!(
            read_value(&path)["plugins"],
            serde_json::json!([
                "first",
                "/store/p/5",
                { "package": "/store/q/2", "options": { "x": 1 } },
                "last"
            ])
        );

        // Done already, or never there: nothing changes, nothing is added.
        let before = std::fs::read_to_string(&path).unwrap();
        replace_plugin_at(&path, "/store/p/4", "/store/p/5").unwrap();
        replace_plugin_at(&path, "/store/gone/1", "/store/gone/2").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
    }

    #[test]
    fn a_replacement_leaves_one_declaration() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opencode.json");
        write(
            &path,
            r#"{ "plugins": ["a", "/s/p/3", "b", "/s/p/3"], "plugin": ["/s/p/3"] }"#,
        );
        replace_plugin_at(&path, "/s/p/3", "/s/p/4").unwrap();
        assert_eq!(
            read_value(&path),
            serde_json::json!({ "plugins": ["a", "b", "/s/p/4"] })
        );

        // The options OpenCode goes by (the last declaration's) stay.
        write(
            &path,
            r#"{ "plugin": ["/s/p/3"], "plugins": [{ "package": "/s/p/3", "options": { "o": 1 } }, "z"] }"#,
        );
        replace_plugin_at(&path, "/s/p/3", "/s/p/4").unwrap();
        assert_eq!(
            read_value(&path),
            serde_json::json!({ "plugins": [{ "package": "/s/p/4", "options": { "o": 1 } }, "z"] })
        );

        // `new` declared already: the old ones only go.
        write(&path, r#"{ "plugins": ["/s/p/3", "x", "/s/p/4"] }"#);
        replace_plugin_at(&path, "/s/p/3", "/s/p/4").unwrap();
        assert_eq!(
            read_value(&path),
            serde_json::json!({ "plugins": ["x", "/s/p/4"] })
        );

        // The same spec twice: the last declaration, with its options, stays.
        write(
            &path,
            r#"{ "plugins": ["/s/p/4", "x", { "package": "/s/p/4", "options": { "o": 2 } }] }"#,
        );
        replace_plugin_at(&path, "/s/p/4", "/s/p/4").unwrap();
        assert_eq!(
            read_value(&path),
            serde_json::json!({ "plugins": ["x", { "package": "/s/p/4", "options": { "o": 2 } }] })
        );
        // Declared once: nothing is written.
        let before = std::fs::read_to_string(&path).unwrap();
        replace_plugin_at(&path, "/s/p/4", "/s/p/4").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), before);

        // Not declared: not even the 1.x entries move.
        let legacy = "{\n  \"plugin\": [\"x\"], // 1.x\n  \"plugins\": [\"y\"]\n}\n";
        write(&path, legacy);
        replace_plugin_at(&path, "/s/p/3", "/s/p/4").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), legacy);

        assert!(replace_plugin_at(&path, " ", "/s/p/5").is_err());
        assert!(replace_plugin_at(&path, "/s/p/4", "-p").is_err());
    }

    #[test]
    fn a_local_directory_is_declared_whole() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opencode.json");
        let spaced = "/Users/Jane Doe/.codeg/plugins/p/4";
        add_local_dir_at(&path, spaced).unwrap();
        add_local_dir_at(&path, spaced).unwrap();
        assert_eq!(
            read_value(&path),
            serde_json::json!({ "plugins": [spaced] })
        );
        for refused in ["", "relative/p", " /lead", "/trail ", "-/p", "/a\nb"] {
            assert!(add_local_dir_at(&path, refused).is_err(), "{refused:?}");
        }
        assert_eq!(
            read_value(&path),
            serde_json::json!({ "plugins": [spaced] })
        );
    }
}
