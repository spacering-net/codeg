//! Where OpenCode 2 reads its global config, and how codeg reads and edits it
//! without losing what the user wrote.
//!
//! OpenCode 2 loads `opencode.json` and then `opencode.jsonc` from each config
//! directory (`core/src/config/discovery.ts`: `names = ["opencode.json",
//! "opencode.jsonc"]`), so the `.jsonc` file wins where both set a key, and it
//! no longer reads 1.x's `config.json` at all. Both files may hold comments and
//! trailing commas. Its own writers (`opencode mcp add`, `opencode plugin add`,
//! the `shell` setting) edit the last of the two that exists, creating
//! `opencode.jsonc` when neither does, and keep comments and formatting through
//! `jsonc-parser`'s edit operations.
//!
//! codeg follows the same rules: it edits the file that wins, and its own
//! writers change only the keys they own, through [`edit_object`], so a user's
//! comments and formatting survive. When codeg has to create the file it
//! creates `opencode.json`, the name its earlier releases used.
//!
//! The global directory is `$OPENCODE_CONFIG_DIR` when set (in 2.x it REPLACES
//! the default rather than adding a second directory, `util/src/global.ts`:
//! `config: process.env.OPENCODE_CONFIG_DIR ?? Path.config`), else
//! `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode` — on every platform,
//! macOS included.

use std::path::{Path, PathBuf};

use jsonc_parser::cst::{CstInputValue, CstObject, CstRootNode};
use jsonc_parser::ParseOptions;
use serde_json::Value;

use crate::parsers::AgentEnv;

/// The config file names OpenCode 2 loads from a directory, in load order: the
/// later one wins.
pub(crate) const CONFIG_FILE_NAMES: [&str; 2] = ["opencode.json", "opencode.jsonc"];

/// The global config directory of an OpenCode launched with `env`.
pub(crate) fn config_dir_for_env(env: &AgentEnv) -> Option<PathBuf> {
    if let Some(dir) = env.var_os("OPENCODE_CONFIG_DIR").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    crate::acp::opencode_plugins::xdg_config_home_for_env(env).map(|home| home.join("opencode"))
}

/// [`config_dir_for_env`] for an OpenCode launched with codeg's own
/// environment.
pub(crate) fn config_dir() -> Option<PathBuf> {
    config_dir_for_env(&AgentEnv::inherited())
}

/// The file codeg reads and edits in `dir`: `opencode.jsonc` when it exists,
/// since it is loaded last and wins, else `opencode.json`.
pub(crate) fn config_file_in(dir: &Path) -> PathBuf {
    let jsonc = dir.join(CONFIG_FILE_NAMES[1]);
    if jsonc.is_file() {
        jsonc
    } else {
        dir.join(CONFIG_FILE_NAMES[0])
    }
}

/// The global config file of an OpenCode launched with codeg's own
/// environment (see [`config_file_in`]).
pub(crate) fn config_file() -> Option<PathBuf> {
    config_dir().map(|dir| config_file_in(&dir))
}

/// What OpenCode's parser accepts: JSON plus comments and trailing commas.
/// The crate's defaults also take JSON5 forms (single quotes, hex numbers, …)
/// that OpenCode rejects, so those stay off: text codeg accepts must load.
fn parse_options() -> ParseOptions {
    ParseOptions {
        allow_comments: true,
        allow_trailing_commas: true,
        allow_loose_object_property_names: false,
        allow_missing_commas: false,
        allow_single_quoted_strings: false,
        allow_hexadecimal_numbers: false,
        allow_unary_plus_numbers: false,
        allow_bare_decimal_point_numbers: false,
        allow_non_finite_numbers: false,
        allow_extended_string_escapes: false,
    }
}

fn strip_bom(text: &str) -> &str {
    text.strip_prefix('\u{feff}').unwrap_or(text)
}

/// `text` (JSON with comments and trailing commas allowed) as a value, or the
/// parse error. Empty text is `{}`: an empty file is no config.
pub(crate) fn parse(text: &str) -> Result<Value, String> {
    let text = strip_bom(text);
    if text.trim().is_empty() {
        return Ok(Value::Object(Default::default()));
    }
    jsonc_parser::parse_to_serde_value::<Value>(text, &parse_options()).map_err(|e| e.to_string())
}

/// [`parse`], requiring an object at the root, as a config file must have.
pub(crate) fn parse_object(text: &str) -> Result<serde_json::Map<String, Value>, String> {
    match parse(text)? {
        Value::Object(map) => Ok(map),
        _ => Err("the root must be a JSON object".to_string()),
    }
}

/// `value` as input for the CST editor.
pub(crate) fn cst_value(value: &Value) -> CstInputValue {
    match value {
        Value::Null => CstInputValue::Null,
        Value::Bool(b) => CstInputValue::Bool(*b),
        Value::Number(n) => CstInputValue::Number(n.to_string()),
        Value::String(s) => CstInputValue::String(s.clone()),
        Value::Array(items) => CstInputValue::Array(items.iter().map(cst_value).collect()),
        Value::Object(map) => CstInputValue::Object(
            map.iter()
                .map(|(key, value)| (key.clone(), cst_value(value)))
                .collect(),
        ),
    }
}

/// Set `key` on `object` to `value`, in place when the key exists (keeping its
/// position and the comments around it), appended otherwise.
pub(crate) fn set_property(object: &CstObject, key: &str, value: &Value) {
    match object.get(key) {
        Some(prop) => prop.set_value(cst_value(value)),
        None => {
            object.append(key, cst_value(value));
        }
    }
}

/// Remove `key` from `object`; whether it was there.
pub(crate) fn remove_property(object: &CstObject, key: &str) -> bool {
    match object.get(key) {
        Some(prop) => {
            prop.remove();
            true
        }
        None => false,
    }
}

/// Edit the root object of `text` through the CST, so everything the edit does
/// not touch — comments, formatting, key order — is kept byte for byte. Text
/// that is empty becomes `{}` first; text that does not parse, or whose root is
/// not an object, is refused rather than replaced.
pub(crate) fn edit_object(text: &str, edit: impl FnOnce(&CstObject)) -> Result<String, String> {
    let body = strip_bom(text);
    let source = if body.trim().is_empty() { "{}\n" } else { body };
    parse_object(source)?;
    let root = CstRootNode::parse(source, &parse_options()).map_err(|e| e.to_string())?;
    let object = root
        .object_value()
        .ok_or_else(|| "the root must be a JSON object".to_string())?;
    edit(&object);
    let mut out = root.to_string();
    if !out.ends_with('\n') {
        out.push('\n');
    }
    Ok(out)
}

/// Write `text` to `path` atomically (a sibling temp file renamed over it), so
/// a crash mid-write never leaves OpenCode a truncated config.
///
/// Otherwise it acts like writing the file in place: a symlinked config (a
/// dotfiles checkout) is written through the link, which stays a link, and an
/// existing file keeps its permissions. The config can hold credentials (an
/// MCP server's headers, a provider's `apiKey`), so the temp file is readable
/// by its owner only while it is written, and a file codeg creates stays so.
pub(crate) fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let target = resolve_symlinks(path);
    let parent = target
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", target.display()))?;
    std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    let file_name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "opencode.json".to_string());
    let tmp = parent.join(format!(
        ".{file_name}.codeg-{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));
    let permissions = std::fs::metadata(&target)
        .ok()
        .map(|meta| meta.permissions());
    let written = write_private(&tmp, text).and_then(|()| match permissions {
        Some(permissions) => std::fs::set_permissions(&tmp, permissions),
        None => Ok(()),
    });
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("write {}: {e}", tmp.display()));
    }
    std::fs::rename(&tmp, &target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("replace {}: {e}", target.display())
    })
}

/// The file `path` names once symlinks are followed (a dangling link resolves
/// to where it points), so a rename replaces that file and keeps the links.
fn resolve_symlinks(path: &Path) -> PathBuf {
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

/// Create `path`, readable by its owner only on Unix, and write `text` to it.
fn write_private(path: &Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(text.as_bytes())?;
    file.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn the_dir_follows_opencode_config_dir_then_xdg() {
        let env = AgentEnv::from_overrides(BTreeMap::from([
            (
                "OPENCODE_CONFIG_DIR".to_string(),
                "/srv/oc-config".to_string(),
            ),
            ("XDG_CONFIG_HOME".to_string(), "/srv/xdg".to_string()),
        ]));
        assert_eq!(
            config_dir_for_env(&env),
            Some(PathBuf::from("/srv/oc-config"))
        );

        let env = AgentEnv::from_overrides(BTreeMap::from([
            ("OPENCODE_CONFIG_DIR".to_string(), String::new()),
            ("XDG_CONFIG_HOME".to_string(), "/srv/xdg".to_string()),
        ]));
        assert_eq!(
            config_dir_for_env(&env),
            Some(PathBuf::from("/srv/xdg/opencode"))
        );
    }

    #[test]
    fn the_jsonc_file_wins_when_it_exists() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert_eq!(config_file_in(dir.path()), dir.path().join("opencode.json"));
        std::fs::write(dir.path().join("opencode.json"), "{}").expect("write");
        assert_eq!(config_file_in(dir.path()), dir.path().join("opencode.json"));
        std::fs::write(dir.path().join("opencode.jsonc"), "{}").expect("write");
        assert_eq!(
            config_file_in(dir.path()),
            dir.path().join("opencode.jsonc")
        );
    }

    #[test]
    fn parsing_takes_comments_and_trailing_commas_but_not_json5() {
        let text = "\u{feff}{\n  // the model\n  \"model\": \"a/b\", /* inline */\n  \"list\": [1, 2,],\n}\n";
        let value = parse(text).expect("jsonc");
        assert_eq!(value["model"], "a/b");
        assert_eq!(value["list"], serde_json::json!([1, 2]));
        assert!(parse("{'model': 'a/b'}").is_err());
        assert!(parse("{\"n\": 0x10}").is_err());
        assert!(parse("{\"a\": 1 \"b\": 2}").is_err());
        assert_eq!(parse("  \n").expect("empty"), serde_json::json!({}));
        assert!(parse_object("[1]").is_err());
    }

    #[test]
    fn an_edit_keeps_comments_and_untouched_keys() {
        let text = "{\n  // keep me\n  \"model\": \"a/b\", // trailing\n  \"mcp\": {\n    /* servers */\n    \"servers\": {}\n  },\n}\n";
        let out = edit_object(text, |root| {
            set_property(root, "model", &serde_json::json!("c/d"));
            let mcp = root.object_value("mcp").expect("mcp");
            let servers = mcp.object_value("servers").expect("servers");
            set_property(
                &servers,
                "x",
                &serde_json::json!({"type": "local", "command": ["x", "--flag \"q\""]}),
            );
            set_property(root, "share", &serde_json::json!("disabled"));
        })
        .expect("edit");
        assert!(out.contains("// keep me"), "{out}");
        assert!(out.contains("// trailing"), "{out}");
        assert!(out.contains("/* servers */"), "{out}");
        let value = parse(&out).expect("still parses");
        assert_eq!(value["model"], "c/d");
        assert_eq!(value["share"], "disabled");
        assert_eq!(
            value["mcp"]["servers"]["x"]["command"],
            serde_json::json!(["x", "--flag \"q\""])
        );

        let removed = edit_object(&out, |root| {
            assert!(remove_property(root, "share"));
            assert!(!remove_property(root, "missing"));
        })
        .expect("remove");
        assert!(parse(&removed).expect("parses").get("share").is_none());
        assert!(removed.contains("// keep me"), "{removed}");
    }

    #[test]
    fn an_edit_refuses_text_it_cannot_parse_and_starts_empty_files_fresh() {
        assert!(edit_object("{ \"a\": ", |_| {}).is_err());
        assert!(edit_object("[1, 2]", |_| {}).is_err());
        let fresh =
            edit_object("", |root| set_property(root, "a", &serde_json::json!(1))).expect("fresh");
        assert_eq!(parse(&fresh).expect("parses"), serde_json::json!({"a": 1}));
    }

    #[test]
    fn writes_replace_the_file_atomically() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("nested").join("opencode.json");
        write_atomic(&path, "{\"a\": 1}\n").expect("write");
        write_atomic(&path, "{\"a\": 2}\n").expect("rewrite");
        assert_eq!(
            std::fs::read_to_string(&path).expect("read"),
            "{\"a\": 2}\n"
        );
        let leftovers: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .expect("list")
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_rewrite_keeps_the_files_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("tempdir");
        let mode =
            |path: &Path| std::fs::metadata(path).expect("stat").permissions().mode() & 0o777;

        // A file codeg creates is private: it may hold credentials.
        let created = dir.path().join("opencode.json");
        write_atomic(&created, "{}\n").expect("create");
        assert_eq!(mode(&created), 0o600);

        // A file that exists keeps whatever the user gave it.
        for kept in [0o600, 0o640, 0o644] {
            std::fs::set_permissions(&created, std::fs::Permissions::from_mode(kept))
                .expect("chmod");
            write_atomic(&created, "{\"a\": 1}\n").expect("rewrite");
            assert_eq!(mode(&created), kept);
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_config_is_written_through_its_link() {
        let dir = tempfile::tempdir().expect("tempdir");
        let dotfiles = dir.path().join("dotfiles");
        std::fs::create_dir_all(&dotfiles).expect("mkdir");
        let real = dotfiles.join("opencode.jsonc");
        std::fs::write(&real, "{}\n").expect("seed");
        let config_dir = dir.path().join("config");
        std::fs::create_dir_all(&config_dir).expect("mkdir");
        let link = config_dir.join("opencode.jsonc");
        std::os::unix::fs::symlink("../dotfiles/opencode.jsonc", &link).expect("link");

        write_atomic(&link, "{\"a\": 1}\n").expect("write");
        assert!(std::fs::symlink_metadata(&link)
            .expect("lstat")
            .file_type()
            .is_symlink());
        assert_eq!(
            std::fs::read_to_string(&real).expect("read"),
            "{\"a\": 1}\n"
        );

        // A dangling link gets its target created.
        let dangling = config_dir.join("opencode.json");
        std::os::unix::fs::symlink("../dotfiles/opencode.json", &dangling).expect("link");
        write_atomic(&dangling, "{}\n").expect("write");
        assert!(std::fs::symlink_metadata(&dangling)
            .expect("lstat")
            .file_type()
            .is_symlink());
        assert_eq!(
            std::fs::read_to_string(dotfiles.join("opencode.json")).expect("read"),
            "{}\n"
        );
    }
}
