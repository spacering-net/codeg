//! The context window OpenCode gives a model: the denominator of the context
//! gauge on a reopened OpenCode session.
//!
//! OpenCode never writes a window into its transcripts. Its live ACP adapter
//! looks one up for every `usage_update` it sends (`findContextLimit(providers,
//! providerID, modelID)`, the `limit.context` of the latest assistant message's
//! model) in the provider list OpenCode assembles from the models.dev catalog
//! and the user's config. Guessing from the model id alone
//! ([`super::infer_context_window_max_tokens`]) knows none of the models
//! OpenCode's own gateways serve (`opencode/big-pickle`, `opencode-go/*`), none
//! of a custom provider's, and nothing of a catalog that gives one id a
//! different window under a different provider. So a session that showed its
//! gauge live lost it once reopened from history.
//!
//! This reads the same sources, in OpenCode's precedence:
//!
//! 1. a `limit.context` declared in the user's config files, layered the way
//!    OpenCode 1.18 layers them (see [`ModelLimitSources::config_files`]);
//! 2. the models.dev catalog OpenCode caches: `$OPENCODE_MODELS_PATH`, else
//!    `$XDG_CACHE_HOME/opencode/models.json`;
//! 3. codeg's bundled models.dev snapshot, for a model that catalog does not
//!    list. OpenCode itself falls back to the snapshot compiled into its
//!    binary when it has no readable cache, so a machine that never fetched
//!    the catalog still sized its gauge from one.
//!
//! A model none of them names is left to the caller's name guess.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

use serde_json::Value;

/// A model the way OpenCode addresses it: the provider that served it, and the
/// id that provider knows it by. Kept exactly as the transcript spells both,
/// since they are looked up as keys.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ModelRef {
    pub(crate) provider_id: Option<String>,
    pub(crate) model_id: String,
}

impl ModelRef {
    /// `None` without a model id. A blank provider counts as no provider.
    pub(crate) fn new(provider_id: Option<&str>, model_id: Option<&str>) -> Option<Self> {
        let model_id = model_id.filter(|id| !id.trim().is_empty())?;
        let provider_id = provider_id
            .filter(|id| !id.trim().is_empty())
            .map(str::to_string);
        Some(Self {
            provider_id,
            model_id: model_id.to_string(),
        })
    }
}

/// Where OpenCode keeps what decides a model's window.
///
/// Every source is optional so a test can point the lookup at fixtures, or at
/// nothing at all (the [`Default`]), which leaves the caller's name guess in
/// charge instead of whatever the machine running the suite has installed.
#[derive(Clone, Debug, Default)]
pub(crate) struct ModelLimitSources {
    /// The global config directory, `$XDG_CONFIG_HOME/opencode`.
    pub(crate) config_dir: Option<PathBuf>,
    /// `$OPENCODE_CONFIG`: one more config file, over the global ones.
    pub(crate) config_file: Option<PathBuf>,
    /// `$OPENCODE_CONFIG_DIR`: a directory read the way a `.opencode` one is.
    pub(crate) config_dir_env: Option<PathBuf>,
    /// The home directory, whose own `.opencode` OpenCode also reads.
    pub(crate) home_dir: Option<PathBuf>,
    /// Whether the session directory's own config files count. OpenCode skips
    /// them under `OPENCODE_DISABLE_PROJECT_CONFIG`.
    pub(crate) project_config: bool,
    /// The models.dev catalog OpenCode caches.
    pub(crate) catalog_file: Option<PathBuf>,
    /// Whether codeg's bundled models.dev snapshot answers last.
    pub(crate) bundled_catalog: bool,
}

impl ModelLimitSources {
    /// The files the OpenCode that codeg launches reads. Its agent process
    /// inherits codeg's environment, so the same variables send both to the
    /// same files.
    pub(crate) fn from_env() -> Self {
        let env_path = |key: &str| {
            std::env::var_os(key)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        };
        Self {
            config_dir: crate::acp::opencode_plugins::xdg_config_home()
                .map(|dir| dir.join("opencode")),
            config_file: env_path("OPENCODE_CONFIG"),
            config_dir_env: env_path("OPENCODE_CONFIG_DIR"),
            home_dir: dirs::home_dir(),
            project_config: !env_flag("OPENCODE_DISABLE_PROJECT_CONFIG"),
            catalog_file: env_path("OPENCODE_MODELS_PATH").or_else(|| {
                crate::acp::opencode_plugins::xdg_cache_home()
                    .map(|dir| dir.join("opencode").join("models.json"))
            }),
            bundled_catalog: true,
        }
    }

    /// The window OpenCode gives `model` in a session run from `directory`, or
    /// `None` when no source names the model.
    pub(crate) fn context_window(&self, directory: Option<&Path>, model: &ModelRef) -> Option<u64> {
        // OpenCode keys the lookup by provider AND model, and so does this: the
        // catalog gives one id different windows under different providers
        // (`claude-sonnet-4-5` is 200K under `anthropic` but 1M through
        // OpenCode Zen), so a model with no provider is not looked up at all.
        let provider = model.provider_id.as_deref()?;

        // Config wins over the catalog, and the highest layer that declares a
        // window wins among the layers. A layer that mentions the model without
        // a window leaves the question to the ones below it, exactly as
        // OpenCode's deep merge does.
        let mut catalog_id: Option<String> = None;
        for path in self.config_files(directory) {
            let Some(config) = read_config(&path) else {
                continue;
            };
            let Some(entry) = config_model_entry(&config, provider, &model.model_id) else {
                continue;
            };
            let declared = entry
                .get("limit")
                .and_then(|limit| limit.get("context"))
                .and_then(token_count);
            if declared.is_some() {
                return declared;
            }
            if catalog_id.is_none() {
                catalog_id = declared_catalog_id(entry).map(str::to_string);
            }
        }

        let catalog_id = catalog_id.as_deref().unwrap_or(&model.model_id);
        // A model OpenCode's own catalog lists is settled by it, window or no
        // window. The bundled snapshot answers only for a model that catalog
        // does not list: OpenCode reads its compiled-in snapshot whenever its
        // cache is missing or unreadable, and a model the cache has dropped
        // since was listed when the session ran on it (OpenCode refuses a
        // model its provider list lacks), so an older models.dev revision is
        // the closest record left of the window it had then.
        let listed = self
            .catalog_file
            .as_deref()
            .and_then(cached_catalog_index)
            .and_then(|index| catalog_entry(&index, provider, catalog_id));
        match listed {
            Some(window) => window,
            None if self.bundled_catalog => {
                catalog_entry(bundled_catalog_index(), provider, catalog_id).flatten()
            }
            None => None,
        }
    }

    /// Every config file OpenCode 1.18 layers for a session run from
    /// `directory`, HIGHEST precedence first. OpenCode merges them in the
    /// opposite order, each file overriding the ones before it:
    ///
    /// - `config.json`, `opencode.json`, `opencode.jsonc` in the global config
    ///   directory, then `$OPENCODE_CONFIG`;
    /// - the project's `opencode.json` / `opencode.jsonc` from the worktree
    ///   root down to `directory`, the nearest merged last
    ///   (`ConfigPaths.projectFiles`);
    /// - `opencode.json` / `opencode.jsonc` in each `.opencode` directory from
    ///   `directory` up to the worktree root, then `~/.opencode`, then
    ///   `$OPENCODE_CONFIG_DIR` (`ConfigPaths.directories`). That walk lists
    ///   the NEAREST directory first, so an outer `.opencode` overrides an
    ///   inner one; this keeps OpenCode's order rather than correcting it.
    ///   Project config being off drops the project's `.opencode` directories
    ///   along with its files, but not `~/.opencode` or `$OPENCODE_CONFIG_DIR`.
    ///
    /// Sources that are not files on this machine (`$OPENCODE_CONFIG_CONTENT`,
    /// an organisation's account config, managed preferences) are left out.
    fn config_files(&self, directory: Option<&Path>) -> Vec<PathBuf> {
        const PROJECT_FILES: [&str; 2] = ["opencode.json", "opencode.jsonc"];

        let mut merge_order: Vec<PathBuf> = Vec::new();
        if let Some(dir) = &self.config_dir {
            for name in ["config.json", "opencode.json", "opencode.jsonc"] {
                merge_order.push(dir.join(name));
            }
        }
        merge_order.extend(self.config_file.clone());

        let project_dirs = match directory {
            Some(directory) if self.project_config => dirs_up_to_worktree(directory),
            _ => Vec::new(),
        };
        for dir in project_dirs.iter().rev() {
            for name in PROJECT_FILES {
                merge_order.push(dir.join(name));
            }
        }
        // `unique([configDir, ...project .opencode, ~/.opencode,
        // $OPENCODE_CONFIG_DIR])`, each directory keeping its FIRST place (a
        // session run from under the home directory walks past `~/.opencode`
        // on its own); then only the `.opencode` ones and
        // `$OPENCODE_CONFIG_DIR` are read. OpenCode compares these as strings,
        // so they are compared as spelled here too: `Path` equality would call
        // `$OPENCODE_CONFIG_DIR=/repo/.opencode/` the walk's `/repo/.opencode`
        // and drop the later of the two places OpenCode merges it at.
        let env_dir = self.config_dir_env.as_deref().map(Path::as_os_str);
        let mut dirs: Vec<PathBuf> = Vec::new();
        let listed = self
            .config_dir
            .iter()
            .cloned()
            .chain(project_dirs.iter().map(|dir| dir.join(".opencode")))
            .chain(self.home_dir.as_ref().map(|home| home.join(".opencode")))
            .chain(self.config_dir_env.clone());
        for dir in listed {
            if !dirs.iter().any(|kept| kept.as_os_str() == dir.as_os_str()) {
                dirs.push(dir);
            }
        }
        for dir in dirs {
            let read =
                dir.to_string_lossy().ends_with(".opencode") || env_dir == Some(dir.as_os_str());
            if read {
                for name in PROJECT_FILES {
                    merge_order.push(dir.join(name));
                }
            }
        }

        // Files are NOT de-duplicated across layers: OpenCode merges a file
        // once for every place it is listed (`$OPENCODE_CONFIG` naming a
        // project file loads it twice), so the file's values stand where it
        // was merged last, the first of its places this reversed list reaches.
        merge_order.reverse();
        merge_order
    }
}

/// OpenCode's reading of a boolean flag: `true` or `1`, in any case.
fn env_flag(key: &str) -> bool {
    std::env::var(key).is_ok_and(|value| {
        let value = value.to_ascii_lowercase();
        value == "true" || value == "1"
    })
}

/// `directory` and each of its parents up to its worktree root, nearest first.
///
/// The root is the nearest directory holding `.git`, which is where OpenCode's
/// project detection stops. Outside a repository OpenCode's worktree is `/`, so
/// the walk runs to the filesystem root. A relative `directory` has no
/// ancestors worth reading: resolving it would read codeg's own working
/// directory instead of the session's.
fn dirs_up_to_worktree(directory: &Path) -> Vec<PathBuf> {
    if !directory.is_absolute() {
        return Vec::new();
    }
    let mut dirs = Vec::new();
    for dir in directory.ancestors() {
        dirs.push(dir.to_path_buf());
        if dir.join(".git").exists() {
            break;
        }
    }
    dirs
}

fn read_config(path: &Path) -> Option<Value> {
    parse_jsonc(&std::fs::read_to_string(path).ok()?)
}

/// Parse a config file the way OpenCode does (`jsonc-parser`, trailing commas
/// allowed): JSON, plus `//` and `/* */` comments and trailing commas. A new
/// OpenCode install writes `opencode.jsonc`, so comments are to be expected.
fn parse_jsonc(raw: &str) -> Option<Value> {
    let raw = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    serde_json::from_str(raw)
        .ok()
        .or_else(|| serde_json::from_str(&strip_jsonc(raw)).ok())
}

/// `raw` with its comments and trailing commas blanked out, strings untouched.
fn strip_jsonc(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    // Where the last comma outside a string sits in `out`, for as long as
    // nothing but whitespace and comments has followed it. A `}` or `]` that
    // arrives while it is still open makes it a trailing comma.
    let mut open_comma: Option<usize> = None;
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                open_comma = None;
                out.push(c);
                while let Some(c) = chars.next() {
                    out.push(c);
                    match c {
                        '\\' => {
                            if let Some(escaped) = chars.next() {
                                out.push(escaped);
                            }
                        }
                        '"' => break,
                        _ => {}
                    }
                }
            }
            '/' if chars.peek() == Some(&'/') => {
                for c in chars.by_ref() {
                    if c == '\n' {
                        out.push('\n');
                        break;
                    }
                }
            }
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                let mut previous = '\0';
                for c in chars.by_ref() {
                    if previous == '*' && c == '/' {
                        break;
                    }
                    previous = c;
                }
                out.push(' ');
            }
            ',' => {
                open_comma = Some(out.len());
                out.push(c);
            }
            '}' | ']' => {
                if let Some(at) = open_comma.take() {
                    out.replace_range(at..at + 1, " ");
                }
                out.push(c);
            }
            c if c.is_whitespace() => out.push(c),
            c => {
                open_comma = None;
                out.push(c);
            }
        }
    }
    out
}

/// `provider.<provider>.models.<model>` in a config file, which OpenCode 2's
/// config format spells `providers`.
fn config_model_entry<'a>(config: &'a Value, provider: &str, model: &str) -> Option<&'a Value> {
    ["provider", "providers"]
        .into_iter()
        .find_map(|key| config.get(key)?.get(provider)?.get("models")?.get(model))
}

/// The catalog entry a config model stands for. OpenCode resolves a config
/// model against the catalog by its `id` (`api.id` in OpenCode 2's format)
/// before its own key, so an alias still inherits the real model's window.
fn declared_catalog_id(entry: &Value) -> Option<&str> {
    entry
        .get("id")
        .or_else(|| entry.get("api").and_then(|api| api.get("id")))
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
}

/// A positive token count. OpenCode truncates a fractional one.
fn token_count(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| {
            value
                .as_f64()
                .filter(|count| count.is_finite() && *count >= 1.0)
                .map(|count| count.trunc() as u64)
        })
        .filter(|count| *count > 0)
}

/// `provider → model → limit.context` for every model a catalog lists, all
/// this needs of one. A model listed without a usable window maps to `None`.
type ContextIndex = HashMap<String, HashMap<String, Option<u64>>>;

/// What a catalog says of a model: `None` if it does not list the model at
/// all, `Some(None)` if it lists it without a window.
fn catalog_entry(index: &ContextIndex, provider: &str, model: &str) -> Option<Option<u64>> {
    index.get(provider)?.get(model).copied()
}

/// Index a models.dev `api.json`, the shape OpenCode caches:
/// `{ <provider>: { models: { <model>: { limit: { context } } } } }`. Keyed by
/// the map keys, which is how OpenCode keys its provider list. Input that is
/// not a catalog indexes to nothing.
fn index_models_dev(raw: &str) -> ContextIndex {
    let Ok(Value::Object(providers)) = serde_json::from_str::<Value>(raw) else {
        return ContextIndex::new();
    };
    let mut index = ContextIndex::new();
    for (provider_id, provider) in providers {
        let Some(models) = provider.get("models").and_then(Value::as_object) else {
            continue;
        };
        let windows = models.iter().map(|(model_id, model)| {
            let window = model
                .get("limit")
                .and_then(|limit| limit.get("context"))
                .and_then(token_count);
            (model_id.clone(), window)
        });
        index.insert(provider_id, windows.collect());
    }
    index
}

/// `(mtime, size)`, the change detector `summary_cache` uses too.
type Fingerprint = (Option<SystemTime>, u64);

fn fingerprint(path: &Path) -> Option<Fingerprint> {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.modified().ok(), meta.len()))
}

struct CachedCatalog {
    path: PathBuf,
    fingerprint: Fingerprint,
    index: Arc<ContextIndex>,
}

/// The catalog at `path`, parsed once per version of the file.
///
/// Every OpenCode history read lands here, and the token-usage sync reads each
/// changed OpenCode session back to back, so re-parsing a multi-megabyte
/// catalog every time would cost that much per session. One slot is enough
/// for the one catalog a process reads; the fingerprint picks up OpenCode's
/// periodic refresh on the next read. A file that changes while it is read is
/// used but not remembered.
fn cached_catalog_index(path: &Path) -> Option<Arc<ContextIndex>> {
    static SLOT: Mutex<Option<CachedCatalog>> = Mutex::new(None);

    let before = fingerprint(path)?;
    if let Ok(slot) = SLOT.lock() {
        if let Some(cached) = slot
            .as_ref()
            .filter(|cached| cached.path == path && cached.fingerprint == before)
        {
            return Some(Arc::clone(&cached.index));
        }
    }

    let raw = std::fs::read_to_string(path).ok()?;
    let index = Arc::new(index_models_dev(&raw));
    if fingerprint(path) == Some(before) {
        if let Ok(mut slot) = SLOT.lock() {
            *slot = Some(CachedCatalog {
                path: path.to_path_buf(),
                fingerprint: before,
                index: Arc::clone(&index),
            });
        }
    }
    Some(index)
}

/// codeg's bundled models.dev snapshot, indexed once per process.
fn bundled_catalog_index() -> &'static ContextIndex {
    static INDEX: OnceLock<ContextIndex> = OnceLock::new();
    INDEX.get_or_init(|| {
        let mut index = ContextIndex::new();
        for provider in crate::acp::opencode_catalog::bundled_catalog() {
            let windows = provider
                .models
                .into_iter()
                .map(|model| (model.id, model.context.filter(|window| *window > 0)));
            index.entry(provider.id).or_default().extend(windows);
        }
        index
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn model(provider: &str, id: &str) -> ModelRef {
        ModelRef::new(Some(provider), Some(id)).expect("model ref")
    }

    fn write(path: &Path, contents: &str) {
        fs::create_dir_all(path.parent().expect("parent")).expect("create dirs");
        fs::write(path, contents).expect("write fixture");
    }

    /// A config file declaring `window` for `provider/model`.
    fn declaring(provider: &str, model: &str, window: u64) -> String {
        serde_json::json!({
            "provider": { provider: { "models": { model: { "limit": { "context": window } } } } }
        })
        .to_string()
    }

    /// Sources reading only what a test lays out under `root`.
    fn sources(root: &Path) -> ModelLimitSources {
        ModelLimitSources {
            config_dir: Some(root.join("config")),
            config_file: None,
            config_dir_env: None,
            home_dir: Some(root.join("home")),
            project_config: true,
            catalog_file: Some(root.join("cache").join("models.json")),
            bundled_catalog: false,
        }
    }

    const CATALOG: &str = r#"{
        "opencode": {
            "id": "opencode",
            "models": {
                "big-pickle": { "id": "big-pickle", "limit": { "context": 200000, "input": 160000, "output": 32000 } },
                "no-limit": { "id": "no-limit" },
                "zero": { "limit": { "context": 0 } },
                "fractional": { "limit": { "context": 131072.9 } }
            }
        },
        "anthropic": { "models": { "claude-sonnet-4-5": { "limit": { "context": 200000 } } } },
        "not-a-provider": "ignored"
    }"#;

    #[test]
    fn the_catalog_answers_by_provider_and_model() {
        let root = tempfile::tempdir().expect("tempdir");
        let sources = sources(root.path());
        write(sources.catalog_file.as_deref().unwrap(), CATALOG);

        let window = |provider: &str, id: &str| sources.context_window(None, &model(provider, id));
        assert_eq!(window("opencode", "big-pickle"), Some(200_000));
        assert_eq!(window("anthropic", "claude-sonnet-4-5"), Some(200_000));
        assert_eq!(window("opencode", "fractional"), Some(131_072));
        // The same id under a provider the catalog does not pair it with.
        assert_eq!(window("anthropic", "big-pickle"), None);
        assert_eq!(window("opencode", "no-limit"), None);
        assert_eq!(window("opencode", "zero"), None);
        assert_eq!(window("unknown", "big-pickle"), None);
    }

    #[test]
    fn a_model_without_a_provider_is_not_looked_up() {
        let root = tempfile::tempdir().expect("tempdir");
        let sources = sources(root.path());
        write(sources.catalog_file.as_deref().unwrap(), CATALOG);

        let bare = ModelRef::new(None, Some("big-pickle")).expect("model ref");
        assert_eq!(sources.context_window(None, &bare), None);
        let blank = ModelRef::new(Some("  "), Some("big-pickle")).expect("model ref");
        assert_eq!(blank.provider_id, None);
        assert!(ModelRef::new(Some("opencode"), Some(" ")).is_none());
        assert!(ModelRef::new(Some("opencode"), None).is_none());
    }

    #[test]
    fn an_unreadable_catalog_answers_nothing() {
        let root = tempfile::tempdir().expect("tempdir");
        let sources = sources(root.path());
        let target = model("opencode", "big-pickle");

        assert_eq!(
            sources.context_window(None, &target),
            None,
            "no catalog file"
        );
        write(sources.catalog_file.as_deref().unwrap(), "{ not json");
        assert_eq!(sources.context_window(None, &target), None);
        write(sources.catalog_file.as_deref().unwrap(), "[1, 2, 3]");
        assert_eq!(sources.context_window(None, &target), None);
    }

    #[test]
    fn a_rewritten_catalog_is_read_again() {
        let root = tempfile::tempdir().expect("tempdir");
        let sources = sources(root.path());
        let catalog = sources.catalog_file.clone().unwrap();
        let target = model("opencode", "big-pickle");

        write(&catalog, CATALOG);
        assert_eq!(sources.context_window(None, &target), Some(200_000));
        // A different size is a different fingerprint even within one mtime tick.
        write(
            &catalog,
            r#"{"opencode":{"models":{"big-pickle":{"limit":{"context":400000}}}}}"#,
        );
        assert_eq!(sources.context_window(None, &target), Some(400_000));
    }

    #[test]
    fn a_declared_window_beats_the_catalog() {
        let root = tempfile::tempdir().expect("tempdir");
        let sources = sources(root.path());
        write(sources.catalog_file.as_deref().unwrap(), CATALOG);
        write(
            &root.path().join("config").join("opencode.json"),
            &declaring("opencode", "big-pickle", 64_000),
        );

        assert_eq!(
            sources.context_window(None, &model("opencode", "big-pickle")),
            Some(64_000)
        );
    }

    #[test]
    fn a_custom_provider_is_sized_by_its_own_declaration() {
        let root = tempfile::tempdir().expect("tempdir");
        let sources = sources(root.path());
        write(
            &root.path().join("config").join("opencode.json"),
            r#"{
                "$schema": "https://opencode.ai/config.json",
                "provider": {
                    "X": {
                        "npm": "@ai-sdk/openai-compatible",
                        "options": { "baseURL": "https://llm.example/v1" },
                        "models": {
                            "xx": { "name": "xx", "limit": { "context": 32768, "output": 4096 } },
                            "undeclared": { "name": "undeclared" }
                        }
                    }
                }
            }"#,
        );

        assert_eq!(
            sources.context_window(None, &model("X", "xx")),
            Some(32_768)
        );
        assert_eq!(
            sources.context_window(None, &model("X", "undeclared")),
            None
        );
    }

    #[test]
    fn global_config_files_layer_in_opencodes_order() {
        let root = tempfile::tempdir().expect("tempdir");
        let sources = sources(root.path());
        let config = root.path().join("config");
        let target = model("p", "m");

        write(&config.join("config.json"), &declaring("p", "m", 1_000));
        assert_eq!(sources.context_window(None, &target), Some(1_000));
        write(&config.join("opencode.json"), &declaring("p", "m", 2_000));
        assert_eq!(sources.context_window(None, &target), Some(2_000));
        write(&config.join("opencode.jsonc"), &declaring("p", "m", 3_000));
        assert_eq!(sources.context_window(None, &target), Some(3_000));

        let custom = root.path().join("custom.json");
        write(&custom, &declaring("p", "m", 4_000));
        let with_custom = ModelLimitSources {
            config_file: Some(custom),
            ..sources.clone()
        };
        assert_eq!(with_custom.context_window(None, &target), Some(4_000));
    }

    #[test]
    fn a_layer_without_a_window_defers_to_the_layers_below() {
        let root = tempfile::tempdir().expect("tempdir");
        let sources = sources(root.path());
        let config = root.path().join("config");
        write(&config.join("config.json"), &declaring("p", "m", 1_000));
        write(
            &config.join("opencode.json"),
            r#"{"provider":{"p":{"models":{"m":{"name":"renamed","limit":{"output":512}}}}}}"#,
        );

        assert_eq!(sources.context_window(None, &model("p", "m")), Some(1_000));
    }

    #[test]
    fn project_config_overrides_global_and_stops_at_the_worktree_root() {
        let root = tempfile::tempdir().expect("tempdir");
        let sources = sources(root.path());
        let target = model("p", "m");
        let outside = root.path().join("work");
        let repo = outside.join("repo");
        let session_dir = repo.join("packages").join("app");
        fs::create_dir_all(repo.join(".git")).expect("git dir");
        fs::create_dir_all(&session_dir).expect("session dir");

        write(
            &root.path().join("config").join("opencode.json"),
            &declaring("p", "m", 1_000),
        );
        // Above the worktree root: OpenCode never reads it.
        write(&outside.join("opencode.json"), &declaring("p", "m", 9_999));
        assert_eq!(
            sources.context_window(Some(&session_dir), &target),
            Some(1_000)
        );

        write(&repo.join("opencode.json"), &declaring("p", "m", 2_000));
        assert_eq!(
            sources.context_window(Some(&session_dir), &target),
            Some(2_000)
        );
        // The nearest project file is merged last, and `.jsonc` after `.json`.
        write(
            &session_dir.join("opencode.json"),
            &declaring("p", "m", 3_000),
        );
        assert_eq!(
            sources.context_window(Some(&session_dir), &target),
            Some(3_000)
        );
        write(
            &session_dir.join("opencode.jsonc"),
            &declaring("p", "m", 4_000),
        );
        assert_eq!(
            sources.context_window(Some(&session_dir), &target),
            Some(4_000)
        );

        let no_project = ModelLimitSources {
            project_config: false,
            ..sources.clone()
        };
        assert_eq!(
            no_project.context_window(Some(&session_dir), &target),
            Some(1_000)
        );
        // A relative directory is not resolved against codeg's own.
        assert_eq!(
            sources.context_window(Some(Path::new("packages/app")), &target),
            Some(1_000)
        );
    }

    #[test]
    fn dot_opencode_directories_come_last_outermost_winning() {
        let root = tempfile::tempdir().expect("tempdir");
        let sources = sources(root.path());
        let target = model("p", "m");
        let repo = root.path().join("repo");
        let session_dir = repo.join("app");
        fs::create_dir_all(repo.join(".git")).expect("git dir");
        fs::create_dir_all(&session_dir).expect("session dir");

        write(
            &session_dir.join("opencode.jsonc"),
            &declaring("p", "m", 1_000),
        );
        write(
            &session_dir.join(".opencode").join("opencode.json"),
            &declaring("p", "m", 2_000),
        );
        assert_eq!(
            sources.context_window(Some(&session_dir), &target),
            Some(2_000)
        );
        // OpenCode lists `.opencode` directories nearest first and merges them
        // in that order, so the outer one lands on top.
        write(
            &repo.join(".opencode").join("opencode.json"),
            &declaring("p", "m", 3_000),
        );
        assert_eq!(
            sources.context_window(Some(&session_dir), &target),
            Some(3_000)
        );
        // Turning project config off drops the project's `.opencode`
        // directories along with its files (`ConfigPaths.directories` gates
        // that walk on the same flag), but not `~/.opencode`.
        let no_project = ModelLimitSources {
            project_config: false,
            ..sources.clone()
        };
        assert_eq!(no_project.context_window(Some(&session_dir), &target), None);
        write(
            &root
                .path()
                .join("home")
                .join(".opencode")
                .join("opencode.json"),
            &declaring("p", "m", 4_000),
        );
        assert_eq!(
            sources.context_window(Some(&session_dir), &target),
            Some(4_000)
        );
        assert_eq!(
            no_project.context_window(Some(&session_dir), &target),
            Some(4_000)
        );

        let env_dir = root.path().join("env-config");
        write(&env_dir.join("opencode.jsonc"), &declaring("p", "m", 5_000));
        let with_env_dir = ModelLimitSources {
            config_dir_env: Some(env_dir),
            ..sources.clone()
        };
        assert_eq!(
            with_env_dir.context_window(Some(&session_dir), &target),
            Some(5_000)
        );
    }

    #[test]
    fn a_config_alias_is_sized_by_the_model_it_points_at() {
        let root = tempfile::tempdir().expect("tempdir");
        let sources = sources(root.path());
        write(sources.catalog_file.as_deref().unwrap(), CATALOG);
        write(
            &root.path().join("config").join("opencode.jsonc"),
            r#"{
                // OpenCode 1.x spells the alias `id`…
                "provider": { "opencode": { "models": { "pickle": { "id": "big-pickle" } } } },
                /* …and OpenCode 2.x `api.id`, under `providers`. */
                "providers": { "anthropic": { "models": { "sonnet": { "api": { "id": "claude-sonnet-4-5" } } } } },
            }"#,
        );

        assert_eq!(
            sources.context_window(None, &model("opencode", "pickle")),
            Some(200_000)
        );
        assert_eq!(
            sources.context_window(None, &model("anthropic", "sonnet")),
            Some(200_000)
        );
    }

    /// Some model the bundled snapshot gives a window, whichever it is: a
    /// named one may leave the snapshot the next time it is regenerated.
    fn a_bundled_model() -> (String, String, u64) {
        bundled_catalog_index()
            .iter()
            .find_map(|(provider, models)| {
                models.iter().find_map(|(id, window)| {
                    window.map(|window| (provider.clone(), id.clone(), window))
                })
            })
            .expect("the bundled snapshot gives some model a window")
    }

    #[test]
    fn the_bundled_snapshot_answers_for_a_model_the_catalog_does_not_list() {
        let root = tempfile::tempdir().expect("tempdir");
        let bundled = ModelLimitSources {
            bundled_catalog: true,
            ..sources(root.path())
        };
        let (provider, id, window) = a_bundled_model();
        let target = model(&provider, &id);

        // No catalog file at all, as on a machine that never fetched one.
        assert_eq!(bundled.context_window(None, &target), Some(window));
        assert_eq!(
            sources(root.path()).context_window(None, &target),
            None,
            "the snapshot is only read when enabled"
        );
        // A catalog OpenCode could not read, which sends it to its own
        // compiled-in snapshot.
        let catalog = bundled.catalog_file.clone().unwrap();
        write(&catalog, "{ torn write");
        assert_eq!(bundled.context_window(None, &target), Some(window));
        // A readable catalog that no longer lists the model.
        write(
            &catalog,
            r#"{"made-up-provider":{"models":{"made-up-model":{"limit":{"context":1}}}}}"#,
        );
        assert_eq!(bundled.context_window(None, &target), Some(window));
    }

    #[test]
    fn a_model_the_catalog_lists_without_a_window_stays_unsized() {
        let root = tempfile::tempdir().expect("tempdir");
        let bundled = ModelLimitSources {
            bundled_catalog: true,
            ..sources(root.path())
        };
        let (provider, id, _) = a_bundled_model();
        let target = model(&provider, &id);

        // OpenCode read this and found no window, so it showed no gauge; the
        // bundled snapshot does not get to overrule the catalog it read.
        for listed in [
            serde_json::json!({ "limit": { "context": 0 } }),
            serde_json::json!({ "limit": { "output": 4096 } }),
            serde_json::json!({ "name": "no limit at all" }),
        ] {
            write(
                bundled.catalog_file.as_deref().unwrap(),
                &serde_json::json!({ &provider: { "models": { &id: listed } } }).to_string(),
            );
            assert_eq!(bundled.context_window(None, &target), None);
        }
    }

    #[test]
    fn a_file_listed_twice_counts_where_opencode_merges_it_last() {
        let root = tempfile::tempdir().expect("tempdir");
        let target = model("p", "m");
        let repo = root.path().join("repo");
        let session_dir = repo.join("app");
        fs::create_dir_all(repo.join(".git")).expect("git dir");
        fs::create_dir_all(&session_dir).expect("session dir");
        let app_config = session_dir.join("opencode.json");
        write(&app_config, &declaring("p", "m", 200_000));
        write(&repo.join("opencode.jsonc"), &declaring("p", "m", 32_000));

        // `$OPENCODE_CONFIG` names the session directory's own project file:
        // OpenCode merges it right after the global files AND again as the
        // nearest project file, after the repository root's.
        let sources = ModelLimitSources {
            config_file: Some(app_config),
            ..sources(root.path())
        };
        assert_eq!(
            sources.context_window(Some(&session_dir), &target),
            Some(200_000)
        );
    }

    #[test]
    fn a_dot_opencode_directory_reached_twice_keeps_its_first_place() {
        let root = tempfile::tempdir().expect("tempdir");
        let target = model("p", "m");
        // The home directory sits inside the worktree, so the project walk
        // passes `~/.opencode` on its way to the root's `.opencode`.
        let home = root.path().join("home");
        let session_dir = home.join("project");
        fs::create_dir_all(root.path().join(".git")).expect("git dir");
        fs::create_dir_all(&session_dir).expect("session dir");
        write(
            &home.join(".opencode").join("opencode.json"),
            &declaring("p", "m", 1_000),
        );
        write(
            &root.path().join(".opencode").join("opencode.json"),
            &declaring("p", "m", 2_000),
        );

        // `unique` keeps `~/.opencode` where the walk met it, before the
        // root's; listed again as the home directory it is not moved last.
        let sources = sources(root.path());
        assert_eq!(sources.home_dir.as_deref(), Some(home.as_path()));
        assert_eq!(
            sources.context_window(Some(&session_dir), &target),
            Some(2_000)
        );
    }

    #[test]
    fn config_dir_env_is_told_apart_from_the_walk_as_opencode_spells_it() {
        let root = tempfile::tempdir().expect("tempdir");
        let target = model("p", "m");
        let repo = root.path().join("repo");
        let session_dir = repo.join("app");
        let app_dot = session_dir.join(".opencode");
        fs::create_dir_all(repo.join(".git")).expect("git dir");
        write(
            &app_dot.join("opencode.json"),
            &declaring("p", "m", 200_000),
        );
        write(
            &repo.join(".opencode").join("opencode.json"),
            &declaring("p", "m", 32_000),
        );
        let with_env_dir = |env_dir: PathBuf| ModelLimitSources {
            config_dir_env: Some(env_dir),
            ..sources(root.path())
        };

        // Spelled exactly as the walk spells it, `unique` keeps only the
        // walk's place, nearest first, so the outer `.opencode` lands last.
        assert_eq!(
            with_env_dir(app_dot.clone()).context_window(Some(&session_dir), &target),
            Some(32_000)
        );
        // With a trailing separator it is a different string to OpenCode, so
        // it is merged again at the very end.
        let mut trailing = app_dot.into_os_string();
        trailing.push(std::path::MAIN_SEPARATOR_STR);
        assert_eq!(
            with_env_dir(PathBuf::from(trailing)).context_window(Some(&session_dir), &target),
            Some(200_000)
        );
    }

    #[test]
    fn jsonc_comments_and_trailing_commas_are_accepted() {
        let parsed = parse_jsonc(
            "\u{feff}{\n  // line comment with \"quotes\" and a trailing comma,\n  \"url\": \"https://opencode.ai/config.json\", /* block */\n  \"escaped\": \"a \\\"quoted // not a comment\\\" /* nor this */\",\n  \"list\": [1, 2, /* two */ 3,],\n  \"nested\": { \"a\": { \"b\": 1, }, },\n}\n",
        )
        .expect("jsonc parses");

        assert_eq!(
            parsed,
            serde_json::json!({
                "url": "https://opencode.ai/config.json",
                "escaped": "a \"quoted // not a comment\" /* nor this */",
                "list": [1, 2, 3],
                "nested": { "a": { "b": 1 } },
            })
        );
    }

    #[test]
    fn jsonc_that_is_still_malformed_is_rejected() {
        assert_eq!(parse_jsonc("{ \"a\": 1 /* unterminated"), None);
        assert_eq!(parse_jsonc("{ \"a\": , }"), None);
        assert_eq!(parse_jsonc("{ ,, }"), None);
        assert_eq!(parse_jsonc(""), None);
    }
}
