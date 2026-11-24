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
//! This reads the same sources, in OpenCode 2's precedence:
//!
//! 1. a `limit.context` declared in the user's config, layered the way
//!    OpenCode 2 layers it (see [`ModelLimitSources::config_sources`]);
//! 2. the models.dev catalog OpenCode reads: the file `$OPENCODE_MODELS_PATH`
//!    names when it is set, which OpenCode reads INSTEAD of its cache
//!    (`core/src/models-dev.ts`, `populate`: `const cached = options?.file ?
//!    undefined : yield* loadFromCache()`); otherwise the copy OpenCode 2
//!    caches in its own database ([`database_catalog`]), then the
//!    `$XDG_CACHE_HOME/opencode/models.json` OpenCode 1.x cached — 2.x never
//!    writes that file, but it is what a session run on 1.x was sized by;
//! 3. codeg's bundled models.dev snapshot, for a model those catalogs do not
//!    list. OpenCode itself falls back to the snapshot compiled into its
//!    binary when it has no readable cache, so a machine that never fetched
//!    the catalog still sized its gauge from one.
//!
//! A model none of them names is left to the caller's name guess.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement};
use serde_json::Value;

use crate::acp::opencode_config::{self, CONFIG_FILE_NAMES};
use crate::parsers::AgentEnv;

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
    /// The global config directory: `$OPENCODE_CONFIG_DIR`, which in
    /// OpenCode 2 REPLACES `$XDG_CONFIG_HOME/opencode` rather than adding to it
    /// (see `acp::opencode_config::config_dir_for_env`).
    pub(crate) config_dir: Option<PathBuf>,
    /// `$OPENCODE_CONFIG`: one more config file, over the global ones.
    pub(crate) config_file: Option<PathBuf>,
    /// `$OPENCODE_CONFIG_CONTENT`: a config document held in the environment,
    /// merged over every file but the managed ones.
    pub(crate) config_content: Option<String>,
    /// The platform's system config directory, whose files are managed
    /// settings that override everything else
    /// (`ConfigDiscovery.systemDirectory`).
    pub(crate) system_dir: Option<PathBuf>,
    /// Whether the session directory's own config counts. OpenCode skips it
    /// under `OPENCODE_CONFIG_PROJECT_DISABLE` (or the older
    /// `OPENCODE_DISABLE_PROJECT_CONFIG`).
    pub(crate) project_config: bool,
    /// The outermost directory the project walk reads. OpenCode walks to the
    /// filesystem root (`None`); a test bounds the walk to its fixture, so
    /// nothing above it — a home directory a temporary one may sit in — is read.
    pub(crate) walk_boundary: Option<PathBuf>,
    /// `$OPENCODE_MODELS_PATH`: the catalog file OpenCode reads in place of
    /// its cache.
    pub(crate) catalog_file: Option<PathBuf>,
    /// Whether the catalog OpenCode 2 caches in its own database counts.
    pub(crate) database_catalog: bool,
    /// `$OPENCODE_MODELS_URL`, which names the cached catalog's database key.
    pub(crate) models_url: Option<String>,
    /// The `models.json` OpenCode 1.x cached its catalog in.
    pub(crate) legacy_catalog_file: Option<PathBuf>,
    /// Whether codeg's bundled models.dev snapshot answers last.
    pub(crate) bundled_catalog: bool,
}

/// One config document OpenCode merges: a file, or `$OPENCODE_CONFIG_CONTENT`.
#[derive(Clone, Debug, PartialEq, Eq)]
enum ConfigSource {
    File(PathBuf),
    Content(String),
}

impl ConfigSource {
    fn read(&self) -> Option<Value> {
        match self {
            Self::File(path) => parse_config(&std::fs::read_to_string(path).ok()?),
            Self::Content(text) => parse_config(text),
        }
    }
}

/// A config document as OpenCode parses it: JSON with comments and trailing
/// commas, an object at the root (the parser codeg's own config editor shares
/// with this lookup).
fn parse_config(text: &str) -> Option<Value> {
    opencode_config::parse_object(text).ok().map(Value::Object)
}

impl ModelLimitSources {
    /// The files the OpenCode launched with `env` reads: its environment is
    /// codeg's with the agent's own overrides laid over it, so the same
    /// variables send both to the same files.
    pub(crate) fn for_env(env: &AgentEnv) -> Self {
        let env_path = |key: &str| {
            env.var_os(key)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        };
        // `cli/src/server-process.ts`: `project: !truthy(process.env.
        // OPENCODE_CONFIG_PROJECT_DISABLE ?? process.env.
        // OPENCODE_DISABLE_PROJECT_CONFIG)` — the newer name wins whenever it
        // is set at all.
        let project_disabled = env
            .var("OPENCODE_CONFIG_PROJECT_DISABLE")
            .or_else(|| env.var("OPENCODE_DISABLE_PROJECT_CONFIG"))
            .is_some_and(|value| truthy(&value));
        Self {
            config_dir: opencode_config::config_dir_for_env(env),
            config_file: env_path("OPENCODE_CONFIG"),
            config_content: env
                .var("OPENCODE_CONFIG_CONTENT")
                .filter(|content| !content.trim().is_empty()),
            system_dir: Some(system_config_dir(env)),
            project_config: !project_disabled,
            walk_boundary: None,
            catalog_file: env_path("OPENCODE_MODELS_PATH"),
            database_catalog: true,
            models_url: env.var("OPENCODE_MODELS_URL"),
            legacy_catalog_file: crate::acp::opencode_plugins::xdg_cache_home_for_env(env)
                .map(|dir| dir.join("opencode").join("models.json")),
            bundled_catalog: true,
        }
    }

    /// The `kv` key OpenCode 2 caches its catalog under, or `None` when that
    /// cache is not read at all — `$OPENCODE_MODELS_PATH` replaces it.
    ///
    /// `core/src/models-dev.ts` (`cacheKey`): the default source is cached as
    /// `models-dev:v2:catalog`, any other `$OPENCODE_MODELS_URL` under that key
    /// plus `:` and `Hash.fast(source)`, the source's hex SHA-1 (a 2.2.0 run
    /// against `http://127.0.0.1:18504` wrote
    /// `models-dev:v2:catalog:fb73518eae8e5cbcf17e14439fe08f166c8420a5`).
    pub(crate) fn database_catalog_key(&self) -> Option<String> {
        const DEFAULT_SOURCE: &str = "https://models.opencode.ai";
        const KEY: &str = "models-dev:v2:catalog";
        if !self.database_catalog || self.catalog_file.is_some() {
            return None;
        }
        // `options?.url || defaultSource`: an empty URL is the default too.
        match self
            .models_url
            .as_deref()
            .filter(|url| !url.is_empty() && *url != DEFAULT_SOURCE)
        {
            None => Some(KEY.to_string()),
            Some(url) => {
                use sha1::{Digest, Sha1};
                let digest = Sha1::digest(url.as_bytes());
                let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
                Some(format!("{KEY}:{hex}"))
            }
        }
    }

    /// The window OpenCode gives `model` in a session run from `directory`, or
    /// `None` when no source names the model. `database` is the catalog
    /// OpenCode 2 cached in the session's own database, when there is one
    /// ([`database_catalog`]).
    pub(crate) fn context_window(
        &self,
        directory: Option<&Path>,
        model: &ModelRef,
        database: Option<&DatabaseCatalog>,
    ) -> Option<u64> {
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
        for source in self.config_sources(directory) {
            let Some(config) = source.read() else {
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
        // A model a catalog OpenCode reads lists is settled by it, window or no
        // window. The bundled snapshot answers only for a model none of them
        // lists: OpenCode reads its compiled-in snapshot whenever its cache is
        // missing or unreadable, and a model the cache has dropped since was
        // listed when the session ran on it (OpenCode refuses a model its
        // provider list lacks), so an older models.dev revision is the closest
        // record left of the window it had then.
        match self.catalog_listing(provider, catalog_id, database) {
            Some(window) => window,
            None if self.bundled_catalog => {
                catalog_entry(bundled_catalog_index(), provider, catalog_id).flatten()
            }
            None => None,
        }
    }

    /// What the first catalog that lists `provider/model` says of it.
    fn catalog_listing(
        &self,
        provider: &str,
        model: &str,
        database: Option<&DatabaseCatalog>,
    ) -> Option<Option<u64>> {
        let in_file = |path: &Path| {
            cached_catalog_index(path).and_then(|index| catalog_entry(&index, provider, model))
        };
        if let Some(file) = &self.catalog_file {
            return in_file(file);
        }
        database
            .and_then(|catalog| catalog_entry(&catalog.0, provider, model))
            .or_else(|| self.legacy_catalog_file.as_deref().and_then(in_file))
    }

    /// Every config document OpenCode 2 merges for a session run from
    /// `directory`, HIGHEST precedence first. OpenCode merges them in the
    /// opposite order, each over the ones before it (`core/src/config.ts`,
    /// `load`, and `core/src/config/discovery.ts`):
    ///
    /// - `opencode.json` then `opencode.jsonc` in the global directory, then
    ///   `$OPENCODE_CONFIG` — 2.x no longer reads 1.x's `config.json`;
    /// - the same two names in every directory from the filesystem root down
    ///   to `directory`, the nearest last: the walk does NOT stop at the
    ///   worktree root (`fs.up({ targets: ["."], start })`; OpenCode's own test
    ///   "loads global and ancestor configuration across the project
    ///   boundary");
    /// - `.opencode/opencode.json(c)` in the same directories, outermost first,
    ///   so the nearest `.opencode` lands on top of every project file;
    /// - `$OPENCODE_CONFIG_CONTENT`;
    /// - the system directory's two files, managed settings that override all
    ///   of the above.
    ///
    /// The walk skips what OpenCode loads as global already — the global and
    /// system directories and their files — and does not run at all from one
    /// of those directories. Project config being off drops the files and the
    /// `.opencode` directories of the walk alike. MDM managed preferences and
    /// remote ("wellknown") config are left out: neither is a file codeg can
    /// read here.
    fn config_sources(&self, directory: Option<&Path>) -> Vec<ConfigSource> {
        let in_dir = |dir: &Path| CONFIG_FILE_NAMES.map(|name| dir.join(name));
        let global_roots: Vec<&Path> = self
            .system_dir
            .iter()
            .chain(self.config_dir.iter())
            .map(PathBuf::as_path)
            .collect();
        let global_files: Vec<PathBuf> = global_roots.iter().flat_map(|dir| in_dir(dir)).collect();

        let mut merge_order: Vec<ConfigSource> = Vec::new();
        if let Some(dir) = &self.config_dir {
            merge_order.extend(in_dir(dir).map(ConfigSource::File));
        }
        merge_order.extend(self.config_file.clone().map(ConfigSource::File));

        // A relative directory has no ancestors worth reading: resolving it
        // would read codeg's own working directory instead of the session's.
        let walk: Vec<&Path> = match directory {
            Some(dir)
                if self.project_config && dir.is_absolute() && !global_roots.contains(&dir) =>
            {
                dir.ancestors()
                    .filter(|ancestor| {
                        self.walk_boundary
                            .as_deref()
                            .is_none_or(|boundary| ancestor.starts_with(boundary))
                    })
                    .collect()
            }
            _ => Vec::new(),
        };
        for dir in walk.iter().rev() {
            merge_order.extend(
                in_dir(dir)
                    .into_iter()
                    .filter(|file| !global_files.contains(file))
                    .map(ConfigSource::File),
            );
        }
        for dir in walk.iter().rev() {
            let dot = dir.join(".opencode");
            if !global_roots.contains(&dot.as_path()) {
                merge_order.extend(in_dir(&dot).map(ConfigSource::File));
            }
        }
        merge_order.extend(self.config_content.clone().map(ConfigSource::Content));
        if let Some(dir) = &self.system_dir {
            merge_order.extend(in_dir(dir).map(ConfigSource::File));
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
fn truthy(value: &str) -> bool {
    let value = value.to_ascii_lowercase();
    value == "true" || value == "1"
}

/// `ConfigDiscovery.systemDirectory` (`core/src/config/discovery.ts`):
/// `/Library/Application Support/opencode`, `%ProgramData%\opencode`, or
/// `/etc/opencode`.
fn system_config_dir(env: &AgentEnv) -> PathBuf {
    if cfg!(target_os = "macos") {
        PathBuf::from("/Library/Application Support/opencode")
    } else if cfg!(windows) {
        env.var("ProgramData")
            .filter(|dir| !dir.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("C:\\ProgramData"))
            .join("opencode")
    } else {
        PathBuf::from("/etc/opencode")
    }
}

/// `providers.<provider>.models.<model>` in a config document — OpenCode 2's
/// spelling — else the 1.x `provider.<provider>` block it still accepts and
/// migrates in memory (`core/src/config/normalize.ts`: `mergeMap(…,
/// "providers", legacyProviders, nativeProviders, …)`). A native block
/// replaces a legacy one of the same id outright rather than merging into it,
/// and the migration renames two 1.x provider ids
/// (`core/src/v1/config/migrate.ts`, `providerID`), so a 2.x session served by
/// `azure` finds its models under the 1.x `azure-cognitive-services` block.
fn config_model_entry<'a>(config: &'a Value, provider: &str, model: &str) -> Option<&'a Value> {
    if let Some(native) = config.get("providers").and_then(|all| all.get(provider)) {
        return native.get("models")?.get(model);
    }
    let legacy = config.get("provider")?;
    std::iter::once(provider)
        .chain(legacy_provider_ids(provider).iter().copied())
        .find_map(|id| legacy.get(id))?
        .get("models")?
        .get(model)
}

/// The 1.x provider ids OpenCode 2 migrates onto `provider`.
fn legacy_provider_ids(provider: &str) -> &'static [&'static str] {
    match provider {
        "azure" => &["azure-cognitive-services"],
        "google-vertex" => &["google-vertex-anthropic"],
        _ => &[],
    }
}

/// The catalog entry a config model stands for. OpenCode resolves a config
/// model against the catalog by the id it declares before its own key, so an
/// alias still inherits the real model's window: `modelID` in OpenCode 2's
/// format (`schema/src/config/provider.ts`), `id` in the 1.x one it migrates
/// (`modelID: info.id`).
fn declared_catalog_id(entry: &Value) -> Option<&str> {
    entry
        .get("modelID")
        .or_else(|| entry.get("id"))
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

/// Index a models.dev catalog: `{ <provider>: { models: { <model>: { limit: {
/// context } } } } }`, the shape both OpenCode 1.x's `api.json` and 2.x's
/// `/experimental/v2.0/api.json` share. Keyed by the map keys, which is how
/// OpenCode keys its provider list. Input that is not a catalog indexes to
/// nothing.
fn index_catalog(catalog: &Value) -> ContextIndex {
    let Some(providers) = catalog.as_object() else {
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
        index.insert(provider_id.clone(), windows.collect());
    }
    index
}

fn index_models_dev(raw: &str) -> ContextIndex {
    serde_json::from_str::<Value>(raw)
        .map(|catalog| index_catalog(&catalog))
        .unwrap_or_default()
}

/// The models.dev catalog OpenCode 2 cached in a session's database.
///
/// 2.x stopped writing `models.json`: its catalog lives in the `kv` table, as
/// `{"updatedAt", "digest", "body"}` with `body` the catalog's raw JSON text
/// (`core/src/models-dev.ts`, `writeCache`).
#[derive(Clone, Debug)]
pub(crate) struct DatabaseCatalog(Arc<ContextIndex>);

#[cfg(test)]
impl DatabaseCatalog {
    pub(crate) fn from_catalog(catalog: &Value) -> Self {
        Self(Arc::new(index_catalog(catalog)))
    }
}

struct CachedDatabaseCatalog {
    database: PathBuf,
    key: String,
    time_updated: i64,
    index: Arc<ContextIndex>,
}

/// The catalog cached under `key` in the `kv` table of the database at
/// `database` that `conn` reads, parsed once per version of the row: the
/// multi-megabyte value is only read again when its `time_updated` moves,
/// which every refresh OpenCode writes does. `None` when the database has no
/// such row — no `kv` table (a 1.x database), or a 2.x one that has not
/// fetched the catalog yet.
pub(crate) async fn database_catalog(
    conn: &DatabaseConnection,
    database: &Path,
    key: &str,
) -> Option<DatabaseCatalog> {
    static SLOT: Mutex<Option<CachedDatabaseCatalog>> = Mutex::new(None);

    let stamp_row = conn
        .query_one(Statement::from_sql_and_values(
            DbBackend::Sqlite,
            "SELECT time_updated FROM kv WHERE key = ?",
            [key.into()],
        ))
        .await
        .ok()??;
    let time_updated: i64 = stamp_row.try_get("", "time_updated").ok()?;
    if let Ok(slot) = SLOT.lock() {
        if let Some(cached) = slot.as_ref().filter(|cached| {
            cached.database == database && cached.key == key && cached.time_updated == time_updated
        }) {
            return Some(DatabaseCatalog(Arc::clone(&cached.index)));
        }
    }

    let value_row = conn
        .query_one(Statement::from_sql_and_values(
            DbBackend::Sqlite,
            "SELECT value FROM kv WHERE key = ?",
            [key.into()],
        ))
        .await
        .ok()??;
    let value: String = value_row.try_get("", "value").ok()?;
    let cached: Value = serde_json::from_str(&value).ok()?;
    let index = match cached.get("body")? {
        Value::String(body) => index_models_dev(body),
        body => index_catalog(body),
    };
    let index = Arc::new(index);
    if let Ok(mut slot) = SLOT.lock() {
        *slot = Some(CachedDatabaseCatalog {
            database: database.to_path_buf(),
            key: key.to_string(),
            time_updated,
            index: Arc::clone(&index),
        });
    }
    Some(DatabaseCatalog(index))
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
/// catalog every time would cost that much per session. One slot is enough:
/// a lookup reads at most one catalog file. The fingerprint picks up a rewrite
/// on the next read. A file that changes while it is read is used but not
/// remembered.
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

    /// A config document declaring `window` for `provider/model`, in
    /// OpenCode 2's spelling.
    fn declaring(provider: &str, model: &str, window: u64) -> String {
        serde_json::json!({
            "providers": { provider: { "models": { model: { "limit": { "context": window } } } } }
        })
        .to_string()
    }

    /// Sources reading only what a test lays out under `root`, with
    /// `cache/models.json` as `$OPENCODE_MODELS_PATH`.
    fn sources(root: &Path) -> ModelLimitSources {
        ModelLimitSources {
            config_dir: Some(root.join("config")),
            config_file: None,
            config_content: None,
            system_dir: None,
            project_config: true,
            walk_boundary: Some(root.to_path_buf()),
            catalog_file: Some(root.join("cache").join("models.json")),
            database_catalog: false,
            models_url: None,
            legacy_catalog_file: None,
            bundled_catalog: false,
        }
    }

    /// A session directory under `root`, a level below its repository, which
    /// the walk must look past.
    fn session_dir(root: &Path) -> PathBuf {
        let dir = root.join("work").join("repo").join("app");
        fs::create_dir_all(&dir).expect("session dir");
        fs::create_dir_all(root.join("work").join("repo").join(".git")).expect("git dir");
        dir
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

        let window =
            |provider: &str, id: &str| sources.context_window(None, &model(provider, id), None);
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
        assert_eq!(sources.context_window(None, &bare, None), None);
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
            sources.context_window(None, &target, None),
            None,
            "no catalog file"
        );
        write(sources.catalog_file.as_deref().unwrap(), "{ not json");
        assert_eq!(sources.context_window(None, &target, None), None);
        write(sources.catalog_file.as_deref().unwrap(), "[1, 2, 3]");
        assert_eq!(sources.context_window(None, &target, None), None);
    }

    #[test]
    fn a_rewritten_catalog_is_read_again() {
        let root = tempfile::tempdir().expect("tempdir");
        let sources = sources(root.path());
        let catalog = sources.catalog_file.clone().unwrap();
        let target = model("opencode", "big-pickle");

        write(&catalog, CATALOG);
        assert_eq!(sources.context_window(None, &target, None), Some(200_000));
        // A different size is a different fingerprint even within one mtime tick.
        write(
            &catalog,
            r#"{"opencode":{"models":{"big-pickle":{"limit":{"context":400000}}}}}"#,
        );
        assert_eq!(sources.context_window(None, &target, None), Some(400_000));
    }

    /// The catalogs OpenCode 2 reads, in its order: `$OPENCODE_MODELS_PATH`
    /// alone when it is set; otherwise its database cache, then the
    /// `models.json` 1.x left behind, then codeg's snapshot.
    #[test]
    fn the_models_path_replaces_the_cache_and_the_cache_beats_the_1x_file() {
        let root = tempfile::tempdir().expect("tempdir");
        let legacy = root
            .path()
            .join("xdg-cache")
            .join("opencode")
            .join("models.json");
        write(
            &legacy,
            r#"{"opencode":{"models":{"big-pickle":{"limit":{"context":111000}},"retired":{"limit":{"context":64000}}}}}"#,
        );
        let database = DatabaseCatalog::from_catalog(&serde_json::json!({
            "opencode": { "models": { "big-pickle": { "limit": { "context": 222000 } } } }
        }));
        let cached = ModelLimitSources {
            catalog_file: None,
            database_catalog: true,
            legacy_catalog_file: Some(legacy),
            ..sources(root.path())
        };
        let window = |sources: &ModelLimitSources, id: &str, database: Option<&DatabaseCatalog>| {
            sources.context_window(None, &model("opencode", id), database)
        };

        assert_eq!(
            window(&cached, "big-pickle", Some(&database)),
            Some(222_000)
        );
        // A model the 2.x cache no longer lists is still in the one 1.x kept.
        assert_eq!(window(&cached, "retired", Some(&database)), Some(64_000));
        // A database that has not cached a catalog leaves it to the 1.x file.
        assert_eq!(window(&cached, "big-pickle", None), Some(111_000));

        // `$OPENCODE_MODELS_PATH` is all OpenCode reads, cache or no cache.
        let models_path = ModelLimitSources {
            catalog_file: Some(root.path().join("custom.json")),
            ..cached.clone()
        };
        write(
            models_path.catalog_file.as_deref().unwrap(),
            r#"{"opencode":{"models":{"big-pickle":{"limit":{"context":333000}}}}}"#,
        );
        assert_eq!(
            window(&models_path, "big-pickle", Some(&database)),
            Some(333_000)
        );
        assert_eq!(window(&models_path, "retired", Some(&database)), None);
        assert_eq!(models_path.database_catalog_key(), None);
    }

    #[test]
    fn the_database_catalog_key_follows_the_models_url() {
        let root = tempfile::tempdir().expect("tempdir");
        let with_url = |url: Option<&str>| ModelLimitSources {
            catalog_file: None,
            database_catalog: true,
            models_url: url.map(str::to_string),
            ..sources(root.path())
        };

        assert_eq!(
            with_url(None).database_catalog_key().as_deref(),
            Some("models-dev:v2:catalog")
        );
        assert_eq!(
            with_url(Some("")).database_catalog_key().as_deref(),
            Some("models-dev:v2:catalog")
        );
        assert_eq!(
            with_url(Some("https://models.opencode.ai"))
                .database_catalog_key()
                .as_deref(),
            Some("models-dev:v2:catalog")
        );
        // The key a real OpenCode 2.2.0 wrote for this mirror.
        assert_eq!(
            with_url(Some("http://127.0.0.1:18504"))
                .database_catalog_key()
                .as_deref(),
            Some("models-dev:v2:catalog:fb73518eae8e5cbcf17e14439fe08f166c8420a5")
        );
        let off = ModelLimitSources {
            database_catalog: false,
            ..with_url(None)
        };
        assert_eq!(off.database_catalog_key(), None);
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
            sources.context_window(None, &model("opencode", "big-pickle"), None),
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
                "providers": {
                    "X": {
                        "package": "aisdk:@ai-sdk/openai-compatible",
                        "settings": { "baseURL": "https://llm.example/v1" },
                        "models": {
                            "xx": { "name": "xx", "limit": { "context": 32768, "output": 4096 } },
                            "undeclared": { "name": "undeclared" }
                        }
                    }
                }
            }"#,
        );

        assert_eq!(
            sources.context_window(None, &model("X", "xx"), None),
            Some(32_768)
        );
        assert_eq!(
            sources.context_window(None, &model("X", "undeclared"), None),
            None
        );
    }

    /// OpenCode 2 still reads a 1.x `provider` block, migrating it in memory:
    /// a native `providers` block of the same id replaces it, and the two
    /// renamed 1.x ids are found under their old names.
    #[test]
    fn a_1x_provider_block_counts_until_a_native_one_replaces_it() {
        let root = tempfile::tempdir().expect("tempdir");
        let sources = sources(root.path());
        let config = root.path().join("config").join("opencode.json");
        write(
            &config,
            r#"{
                "provider": {
                    "p": { "models": { "m": { "limit": { "context": 1000 } } } },
                    "azure-cognitive-services": { "models": { "gpt": { "limit": { "context": 2000 } } } }
                }
            }"#,
        );
        assert_eq!(
            sources.context_window(None, &model("p", "m"), None),
            Some(1_000)
        );
        assert_eq!(
            sources.context_window(None, &model("azure", "gpt"), None),
            Some(2_000)
        );

        write(
            &config,
            r#"{
                "provider": { "p": { "models": { "m": { "limit": { "context": 1000 } } } } },
                "providers": { "p": { "models": { "other": { "limit": { "context": 3000 } } } } }
            }"#,
        );
        assert_eq!(sources.context_window(None, &model("p", "m"), None), None);
        assert_eq!(
            sources.context_window(None, &model("p", "other"), None),
            Some(3_000)
        );
    }

    #[test]
    fn global_config_files_layer_in_opencodes_order() {
        let root = tempfile::tempdir().expect("tempdir");
        let sources = sources(root.path());
        let config = root.path().join("config");
        let target = model("p", "m");

        // OpenCode 2 no longer reads 1.x's `config.json`.
        write(&config.join("config.json"), &declaring("p", "m", 1_000));
        assert_eq!(sources.context_window(None, &target, None), None);
        write(&config.join("opencode.json"), &declaring("p", "m", 2_000));
        assert_eq!(sources.context_window(None, &target, None), Some(2_000));
        write(&config.join("opencode.jsonc"), &declaring("p", "m", 3_000));
        assert_eq!(sources.context_window(None, &target, None), Some(3_000));

        let custom = root.path().join("custom.json");
        write(&custom, &declaring("p", "m", 4_000));
        let with_custom = ModelLimitSources {
            config_file: Some(custom),
            ..sources.clone()
        };
        assert_eq!(with_custom.context_window(None, &target, None), Some(4_000));
    }

    #[test]
    fn a_layer_without_a_window_defers_to_the_layers_below() {
        let root = tempfile::tempdir().expect("tempdir");
        let sources = sources(root.path());
        let config = root.path().join("config");
        write(&config.join("opencode.json"), &declaring("p", "m", 1_000));
        write(
            &config.join("opencode.jsonc"),
            r#"{
                // Renames the model without restating its window.
                "providers": { "p": { "models": { "m": { "name": "renamed", "limit": { "output": 512 } } } } },
            }"#,
        );

        assert_eq!(
            sources.context_window(None, &model("p", "m"), None),
            Some(1_000)
        );
    }

    #[test]
    fn project_files_walk_past_the_worktree_root_the_nearest_winning() {
        let root = tempfile::tempdir().expect("tempdir");
        let sources = sources(root.path());
        let target = model("p", "m");
        let session = session_dir(root.path());
        let repo = session.parent().unwrap().to_path_buf();

        write(
            &root.path().join("config").join("opencode.json"),
            &declaring("p", "m", 1_000),
        );
        // Above the worktree root: OpenCode 2 reads it too.
        write(
            &root.path().join("work").join("opencode.json"),
            &declaring("p", "m", 2_000),
        );
        assert_eq!(
            sources.context_window(Some(&session), &target, None),
            Some(2_000)
        );
        write(&repo.join("opencode.jsonc"), &declaring("p", "m", 3_000));
        assert_eq!(
            sources.context_window(Some(&session), &target, None),
            Some(3_000)
        );
        // The nearest directory is merged last, and `.jsonc` after `.json`.
        write(&session.join("opencode.json"), &declaring("p", "m", 4_000));
        assert_eq!(
            sources.context_window(Some(&session), &target, None),
            Some(4_000)
        );
        write(&session.join("opencode.jsonc"), &declaring("p", "m", 5_000));
        assert_eq!(
            sources.context_window(Some(&session), &target, None),
            Some(5_000)
        );

        let no_project = ModelLimitSources {
            project_config: false,
            ..sources.clone()
        };
        assert_eq!(
            no_project.context_window(Some(&session), &target, None),
            Some(1_000)
        );
        // A relative directory is not resolved against codeg's own.
        assert_eq!(
            sources.context_window(Some(Path::new("work/repo/app")), &target, None),
            Some(1_000)
        );
    }

    #[test]
    fn dot_opencode_directories_outrank_project_files_the_nearest_winning() {
        let root = tempfile::tempdir().expect("tempdir");
        let sources = sources(root.path());
        let target = model("p", "m");
        let session = session_dir(root.path());
        let repo = session.parent().unwrap().to_path_buf();

        write(&session.join("opencode.jsonc"), &declaring("p", "m", 1_000));
        // Even an outer `.opencode` lands over the nearest project file…
        write(
            &repo.join(".opencode").join("opencode.json"),
            &declaring("p", "m", 2_000),
        );
        assert_eq!(
            sources.context_window(Some(&session), &target, None),
            Some(2_000)
        );
        // …and among `.opencode` directories the nearest is merged last.
        write(
            &session.join(".opencode").join("opencode.json"),
            &declaring("p", "m", 3_000),
        );
        assert_eq!(
            sources.context_window(Some(&session), &target, None),
            Some(3_000)
        );

        // Project config off drops the walk's `.opencode` directories too.
        let no_project = ModelLimitSources {
            project_config: false,
            ..sources.clone()
        };
        assert_eq!(
            no_project.context_window(Some(&session), &target, None),
            None
        );
    }

    #[test]
    fn config_content_and_the_system_directory_override_the_project() {
        let root = tempfile::tempdir().expect("tempdir");
        let target = model("p", "m");
        let session = session_dir(root.path());
        write(
            &session.join(".opencode").join("opencode.jsonc"),
            &declaring("p", "m", 1_000),
        );
        let with_content = ModelLimitSources {
            config_content: Some(declaring("p", "m", 2_000)),
            ..sources(root.path())
        };
        assert_eq!(
            with_content.context_window(Some(&session), &target, None),
            Some(2_000)
        );

        let system = root.path().join("system");
        write(&system.join("opencode.json"), &declaring("p", "m", 3_000));
        let managed = ModelLimitSources {
            system_dir: Some(system),
            ..with_content.clone()
        };
        assert_eq!(
            managed.context_window(Some(&session), &target, None),
            Some(3_000)
        );
    }

    /// What OpenCode loads as global config is not read a second time as the
    /// project's: `$OPENCODE_CONFIG_DIR` pointed at a project's `.opencode`
    /// keeps the global (lowest) place, so the project's own file still wins.
    #[test]
    fn the_walk_skips_what_is_loaded_as_global() {
        let root = tempfile::tempdir().expect("tempdir");
        let target = model("p", "m");
        let session = session_dir(root.path());
        let dot = session.join(".opencode");
        write(&dot.join("opencode.json"), &declaring("p", "m", 1_000));
        write(&session.join("opencode.json"), &declaring("p", "m", 2_000));

        let global_is_dot = ModelLimitSources {
            config_dir: Some(dot.clone()),
            ..sources(root.path())
        };
        assert_eq!(
            global_is_dot.context_window(Some(&session), &target, None),
            Some(2_000)
        );
        // A session run from the global directory itself reads no project.
        assert_eq!(
            global_is_dot.context_window(Some(&dot), &target, None),
            Some(1_000)
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
                // OpenCode 2 spells the alias `modelID`…
                "providers": { "anthropic": { "models": { "sonnet": { "modelID": "claude-sonnet-4-5" } } } },
                /* …and the 1.x block it migrates `id`. */
                "provider": { "opencode": { "models": { "pickle": { "id": "big-pickle" } } } },
            }"#,
        );

        assert_eq!(
            sources.context_window(None, &model("anthropic", "sonnet"), None),
            Some(200_000)
        );
        assert_eq!(
            sources.context_window(None, &model("opencode", "pickle"), None),
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
        assert_eq!(bundled.context_window(None, &target, None), Some(window));
        assert_eq!(
            sources(root.path()).context_window(None, &target, None),
            None,
            "the snapshot is only read when enabled"
        );
        // A catalog OpenCode could not read, which sends it to its own
        // compiled-in snapshot.
        let catalog = bundled.catalog_file.clone().unwrap();
        write(&catalog, "{ torn write");
        assert_eq!(bundled.context_window(None, &target, None), Some(window));
        // A readable catalog that no longer lists the model.
        write(
            &catalog,
            r#"{"made-up-provider":{"models":{"made-up-model":{"limit":{"context":1}}}}}"#,
        );
        assert_eq!(bundled.context_window(None, &target, None), Some(window));
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
            assert_eq!(bundled.context_window(None, &target, None), None);
        }
    }

    #[test]
    fn a_file_listed_twice_counts_where_opencode_merges_it_last() {
        let root = tempfile::tempdir().expect("tempdir");
        let target = model("p", "m");
        let session = session_dir(root.path());
        let repo_config = session.parent().unwrap().join("opencode.json");
        write(&repo_config, &declaring("p", "m", 200_000));
        write(
            &root.path().join("config").join("opencode.jsonc"),
            &declaring("p", "m", 32_000),
        );

        // `$OPENCODE_CONFIG` names the repository's own project file:
        // OpenCode merges it right after the global files AND again on the
        // walk, so its window stands over the global one either way — and
        // under a nearer project file that declares one.
        let sources = ModelLimitSources {
            config_file: Some(repo_config),
            ..sources(root.path())
        };
        assert_eq!(
            sources.context_window(Some(&session), &target, None),
            Some(200_000)
        );
        write(&session.join("opencode.json"), &declaring("p", "m", 64_000));
        assert_eq!(
            sources.context_window(Some(&session), &target, None),
            Some(64_000)
        );
    }

    #[test]
    fn jsonc_comments_and_trailing_commas_are_accepted() {
        let root = tempfile::tempdir().expect("tempdir");
        let sources = sources(root.path());
        write(
            &root.path().join("config").join("opencode.jsonc"),
            "\u{feff}{\n  // line comment with \"quotes\" and a trailing comma,\n  \"providers\": { \"p\": { \"models\": { \"m\": { \"limit\": { \"context\": 1000, }, }, }, }, }, /* block */\n}\n",
        );
        assert_eq!(
            sources.context_window(None, &model("p", "m"), None),
            Some(1_000)
        );

        // What OpenCode's parser rejects declares nothing.
        write(
            &root.path().join("config").join("opencode.jsonc"),
            "{ 'providers': { 'p': { 'models': { 'm': { 'limit': { 'context': 1000 } } } } } }",
        );
        assert_eq!(sources.context_window(None, &model("p", "m"), None), None);
    }
}
