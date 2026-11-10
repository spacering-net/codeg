//! The one place codeg writes codex's files.
//!
//! config.toml, auth.json, the generated catalog (`codeg-model-catalog.json`),
//! the intent sidecar (`…source.json`), its provenance (`…meta.json`) and the
//! provider list it was built from (`…upstream.json`) all go through here, in
//! two steps:
//!
//! - [`prepare`], outside the lock, does the slow part: fetching or picking a
//!   provider list, building the catalog, asking codex to load it. Its result
//!   carries the [`Basis`] it was built on.
//! - [`LockedHome::commit`], under the two-layer lock ([`lock`]), checks that
//!   basis against what is on disk (and, for a user's save, in the database)
//!   right now — a refresh that finished after the user re-bound, or after
//!   another codeg published a newer list, is dropped instead of written —
//!   recomputes the keys codeg manages, and publishes everything as one
//!   change ([`txn`]).
//!
//! **Managed keys.** Whenever codeg publishes a static catalog, root
//! `model_catalog_json` points at it and root `model` is its default; a save
//! that edits either by hand is refused with a pointer to the control that
//! owns it. Otherwise a `model_catalog_json` of the user's own is theirs and
//! left alone. codeg never writes `model_catalog_url` or the
//! `api_key_model_discovery` feature: with either, any trouble at the URL
//! leaves codex with no models.
//!
//! **Who decides the intent.** A user's save takes it from the database when
//! a provider is bound, from what the panel sent otherwise. Background
//! refreshes, the pre-launch check and the post-install refresh read only
//! what is already published (sidecar, config.toml, auth.json, provenance,
//! upstream) and never change intent, binding or key — so several codeg
//! processes, each with a database of its own, sharing one `CODEX_HOME`
//! refresh the same published config instead of writing each other's.

pub mod lock;
pub mod txn;

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::acp::codex_endpoint_catalog::{
    self as endpoint, sha256_hex, CatalogCounts, CatalogDiff, EndpointCache, EndpointError,
    EndpointRequest, EndpointSnapshot,
};
use crate::acp::codex_model_catalog::{self as catalog, CatalogFormat, CodexModelConfig};
use crate::acp::codex_runtime::{self, CodexRuntime, JudgeError, ValidatedRuntime};

pub use lock::{CodexHomeGuard, LockError, LOCK_WAIT};
pub use txn::{Repair, Target, TxnError};

pub const META_REL: &str = "codeg-model-catalog.meta.json";
pub const UPSTREAM_REL: &str = "codeg-model-catalog.upstream.json";
pub const CONFIG_REL: &str = "config.toml";
pub const AUTH_REL: &str = "auth.json";
/// The only provider codeg configures.
pub const CODEG_PROVIDER: &str = "codeg";
/// The keys codeg itself writes into `[model_providers.codeg]`. A table with
/// anything else in it holds something the user wrote.
const CODEG_PROVIDER_KEYS: &[&str] = &[
    "name",
    "base_url",
    "wire_api",
    "supports_websockets",
    "requires_openai_auth",
];
/// At most this many runtimes are remembered as having accepted a catalog.
const MAX_VALIDATED: usize = 4;
/// A cached fetch this young counts as fresh for a save — the dialog or the
/// editor fetched it moments ago.
const RECENT_FETCH: chrono::Duration = chrono::Duration::minutes(10);

pub type CatalogError = EndpointError;

fn err(code: &'static str, message: impl Into<String>) -> CatalogError {
    EndpointError::new(code, message)
}

fn io_err(context: &str, e: impl std::fmt::Display) -> CatalogError {
    err("io", format!("{context}: {e}"))
}

impl From<LockError> for EndpointError {
    fn from(e: LockError) -> Self {
        match &e {
            LockError::Busy => err("lock_busy", e.to_string()),
            LockError::Held { path, .. } => {
                err("lock_held", e.to_string()).with_param("path", path.display().to_string())
            }
            LockError::Io(msg) => err("io", msg.clone()),
        }
    }
}

impl From<TxnError> for EndpointError {
    fn from(e: TxnError) -> Self {
        match &e {
            TxnError::Io(msg) => err("io", msg.clone()),
            // `fix` names the way out for the page: `copy_back` the file's
            // version from before the save (`backup`), `remove` a file the
            // save was creating, or `reset` — delete the `journal` and save
            // again — when codeg cannot finish or undo it.
            TxnError::NeedsRepair { path, repair, .. } => {
                let out = err("repair_needed", e.to_string())
                    .with_param("path", path.display().to_string());
                match repair {
                    Repair::CopyBack(backup) => out
                        .with_param("fix", "copy_back")
                        .with_param("backup", backup.display().to_string()),
                    Repair::Remove => out.with_param("fix", "remove"),
                    Repair::Reset(journal) => out
                        .with_param("fix", "reset")
                        .with_param("journal", journal.display().to_string()),
                }
            }
        }
    }
}

// ─── Published state ────────────────────────────────────────────────────

/// Where a published intent came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Binding {
    /// Edited in the Codex panel (API key mode).
    Panel,
    /// A model provider bound to Codex.
    Provider(i32),
    /// Published by a codeg that kept no provenance; corrected on the next
    /// save.
    Unknown,
}

impl Binding {
    pub fn as_wire(&self) -> String {
        match self {
            Binding::Panel => "panel".into(),
            Binding::Provider(id) => format!("provider:{id}"),
            Binding::Unknown => "unknown".into(),
        }
    }

    pub fn parse(raw: &str) -> Self {
        match raw {
            "panel" => Binding::Panel,
            other => other
                .strip_prefix("provider:")
                .and_then(|id| id.parse().ok())
                .map(Binding::Provider)
                .unwrap_or(Binding::Unknown),
        }
    }
}

/// Provenance of what codeg published (`codeg-model-catalog.meta.json`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogMeta {
    #[serde(default)]
    pub version: u32,
    pub intent_hash: String,
    pub binding: String,
    /// Hash of the published catalog file; `None` when none is published.
    #[serde(default)]
    pub snapshot_id: Option<String>,
    /// The runtimes that loaded the published catalog, newest first.
    #[serde(default)]
    pub validated_by: Vec<ValidatedRuntime>,
    /// Runtimes that refused it: two incompatible codex versions share this
    /// `CODEX_HOME`. Background refresh pauses while this is non-empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub conflict: Vec<ValidatedRuntime>,
    /// The official catalog version the published file was built against.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub officials_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    #[serde(default)]
    pub counts: CatalogCounts,
    // The provider request the published upstream answers; absent without a
    // provider source.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<CatalogFormat>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_fingerprint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_version_confirmed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_seq: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_started_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fetched_at: Option<DateTime<Utc>>,
    /// The last time the provider confirmed its list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<usize>,
    /// Why the published catalog is a stand-in (no provider list could be
    /// used), when it is one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub degraded: Option<String>,
    /// The list came from another key, parameters or codex version than the
    /// current request.
    #[serde(default)]
    pub stale: bool,
    #[serde(default)]
    pub diff: CatalogDiff,
    /// A refresh answered in the other shape; not published until re-picked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_format: Option<CatalogFormat>,
}

impl CatalogMeta {
    pub fn binding(&self) -> Binding {
        Binding::parse(&self.binding)
    }

    pub fn validated_versions(&self) -> Vec<&str> {
        self.validated_by
            .iter()
            .map(|v| v.version.as_str())
            .collect()
    }

    pub fn is_validated_by(&self, runtime: &CodexRuntime) -> bool {
        runtime.confirmed
            && self
                .validated_by
                .iter()
                .any(|v| v.version == runtime.version)
    }

    /// Whether the published catalog was built from this runtime's official
    /// catalog. An unconfirmed runtime cannot tell, and does not ask for a
    /// rebuild.
    pub fn built_for(&self, runtime: &CodexRuntime) -> bool {
        !runtime.confirmed || self.officials_version.as_deref() == Some(runtime.version.as_str())
    }
}

/// Everything already published under `CODEX_HOME`.
#[derive(Debug, Clone, Default)]
pub struct Published {
    pub home: PathBuf,
    pub config_toml: Option<String>,
    pub auth_json: Option<String>,
    pub sidecar: Option<String>,
    pub meta: Option<CatalogMeta>,
    pub upstream: Option<EndpointSnapshot>,
    pub catalog: Option<Vec<u8>>,
}

fn read_opt(path: &Path) -> Result<Option<Vec<u8>>, CatalogError> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(io_err(&format!("read {}", path.display()), e)),
    }
}

fn read_text(path: &Path) -> Result<Option<String>, CatalogError> {
    Ok(read_opt(path)?.map(|b| String::from_utf8_lossy(&b).into_owned()))
}

impl Published {
    pub fn read(home: &Path) -> Result<Self, CatalogError> {
        let meta = read_opt(&home.join(META_REL))?
            .and_then(|b| serde_json::from_slice::<CatalogMeta>(&b).ok());
        let upstream = read_opt(&home.join(UPSTREAM_REL))?
            .and_then(|b| serde_json::from_slice::<EndpointSnapshot>(&b).ok());
        Ok(Self {
            home: home.to_path_buf(),
            config_toml: read_text(&home.join(CONFIG_REL))?,
            auth_json: read_text(&home.join(AUTH_REL))?,
            sidecar: read_text(&home.join(catalog::SOURCE_REL))?,
            meta,
            upstream,
            catalog: read_opt(&home.join(catalog::CATALOG_REL))?,
        })
    }

    pub fn snapshot_id(&self) -> Option<String> {
        self.catalog.as_deref().map(sha256_hex)
    }

    /// Identity of the published provenance, for the commit-time check.
    pub fn meta_id(&self) -> Option<String> {
        self.meta
            .as_ref()
            .map(|m| sha256_hex(&serde_json::to_vec(m).unwrap_or_default()))
    }

    /// Whether codeg's catalog file is published and config.toml points at it.
    pub fn publishes_catalog(&self) -> bool {
        self.catalog.is_some() && self.references_codeg_catalog()
    }

    /// The published intent, when there is a sidecar.
    pub fn intent(&self) -> Option<CodexModelConfig> {
        self.sidecar
            .as_deref()
            .map(|raw| catalog::parse_model_config(Some(raw)))
    }

    /// Whether config.toml's `model_catalog_json` points at codeg's file.
    pub fn references_codeg_catalog(&self) -> bool {
        self.config_toml
            .as_deref()
            .and_then(|t| root_str_of(t, "model_catalog_json"))
            .is_some_and(|v| is_codeg_catalog_ref(&v, &self.home))
    }

    pub fn config_text(&self) -> &str {
        self.config_toml.as_deref().unwrap_or("")
    }

    /// The published provider list, when it answers `request`: fetched for
    /// it, or confirmed for it since (the provenance records the latest
    /// confirmation of the same content).
    pub fn upstream_answering(&self, request: &EndpointRequest) -> Option<&EndpointSnapshot> {
        let up = self.upstream.as_ref().filter(|u| u.url == request.url())?;
        let fingerprint = request.fingerprint();
        let confirmed = self.meta.as_ref().is_some_and(|m| {
            m.request_fingerprint.as_deref() == Some(fingerprint.as_str())
                && m.content_hash.as_deref() == Some(up.content_hash.as_str())
        });
        (up.request_fingerprint == fingerprint || confirmed).then_some(up)
    }

    pub fn auth_text(&self) -> &str {
        self.auth_json.as_deref().unwrap_or("")
    }
}

/// Resolve a `model_catalog_json` value the way codex does: `~/…` against the
/// home dir, absolute as-is, anything else relative to `CODEX_HOME`.
pub fn resolve_home_relative(value: &str, codex_home: &Path) -> PathBuf {
    let home = || dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    if value == "~" {
        return home();
    }
    if let Some(rest) = value.strip_prefix("~/") {
        return home().join(rest);
    }
    let p = Path::new(value);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        codex_home.join(value)
    }
}

/// Whether a `model_catalog_json` value names codeg's own file. Anything else
/// is the user's, and codeg never deletes it.
pub fn is_codeg_catalog_ref(value: &str, codex_home: &Path) -> bool {
    let value = value.trim();
    !value.is_empty()
        && same_path(
            &resolve_home_relative(value, codex_home),
            &codex_home.join(catalog::CATALOG_REL),
        )
}

/// Whether two paths name one file: resolved through symlinks when both
/// exist, else compared with `.` and `..` folded away.
fn same_path(a: &Path, b: &Path) -> bool {
    if let (Ok(a), Ok(b)) = (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        return a == b;
    }
    lexical(a) == lexical(b)
}

fn lexical(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

// ─── config.toml / auth.json ────────────────────────────────────────────

fn parse_doc(text: &str) -> Result<toml_edit::Document, CatalogError> {
    text.parse::<toml_edit::Document>()
        .map_err(|e| err("invalid_config", format!("invalid codex config.toml: {e}")))
}

fn root_str_of(text: &str, key: &str) -> Option<String> {
    let value = text.parse::<toml::Table>().ok()?;
    value
        .get(key)?
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn doc_root_str(doc: &toml_edit::Document, key: &str) -> Option<String> {
    doc.get(key)
        .and_then(|i| i.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn set_root(doc: &mut toml_edit::Document, key: &str, value: Option<&str>) {
    match value {
        Some(v) => doc[key] = toml_edit::value(v),
        None => remove_root(doc, key),
    }
}

/// Remove a root key without losing the comment lines above it — often the
/// file's own header. They move to whatever is now written first after it:
/// the next root value, else the first table header.
fn remove_root(doc: &mut toml_edit::Document, key: &str) {
    let root = doc.as_table_mut();
    let comment = root
        .key_decor(key)
        .and_then(|d| d.prefix())
        .and_then(|p| p.as_str())
        .filter(|p| p.contains('#'))
        .map(str::to_string);
    let later: Vec<String> = root
        .iter()
        .map(|(k, _)| k.to_string())
        .skip_while(|k| k != key)
        .skip(1)
        .collect();
    if root.remove(key).is_none() {
        return;
    }
    let Some(comment) = comment else { return };
    let prepend = |decor: &mut toml_edit::Decor| {
        let rest = decor
            .prefix()
            .and_then(|p| p.as_str())
            .unwrap_or("")
            .to_string();
        decor.set_prefix(format!("{comment}{rest}"));
    };
    if let Some(next) = later
        .iter()
        .find(|k| root.get(k).is_some_and(toml_edit::Item::is_value))
    {
        if let Some(decor) = root.key_decor_mut(next) {
            prepend(decor);
        }
        return;
    }
    if let Some(first) = first_header_position(root) {
        with_header_at(root, first, &mut |t| prepend(t.decor_mut()));
    }
}

fn sub_tables(item: &toml_edit::Item) -> Vec<&toml_edit::Table> {
    match item {
        toml_edit::Item::Table(t) => vec![t],
        toml_edit::Item::ArrayOfTables(a) => a.iter().collect(),
        _ => Vec::new(),
    }
}

/// The position of the first `[header]` written under `table`.
fn first_header_position(table: &toml_edit::Table) -> Option<usize> {
    table
        .iter()
        .flat_map(|(_, item)| sub_tables(item))
        .flat_map(|t| {
            let own = (!t.is_implicit() && !t.is_dotted())
                .then(|| t.position())
                .flatten();
            own.into_iter().chain(first_header_position(t))
        })
        .min()
}

fn with_header_at(
    table: &mut toml_edit::Table,
    position: usize,
    f: &mut dyn FnMut(&mut toml_edit::Table),
) -> bool {
    for (_, item) in table.iter_mut() {
        let subs: Vec<&mut toml_edit::Table> = match item {
            toml_edit::Item::Table(t) => vec![t],
            toml_edit::Item::ArrayOfTables(a) => a.iter_mut().collect(),
            _ => continue,
        };
        for t in subs {
            if !t.is_implicit() && !t.is_dotted() && t.position() == Some(position) {
                f(t);
                return true;
            }
            if with_header_at(t, position, f) {
                return true;
            }
        }
    }
    false
}

/// The request parts codex would use for the `codeg` provider: its base URL,
/// `query_params` and static `http_headers`. `None` when the active provider
/// is not codeg's — a provider the user configured is theirs to manage.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProviderParts {
    pub base_url: String,
    pub query_params: Vec<(String, String)>,
    pub headers: Vec<(String, String)>,
}

pub fn codeg_provider_parts(toml_text: &str) -> Option<ProviderParts> {
    let value = toml_text.parse::<toml::Table>().ok().unwrap_or_default();
    let active = value.get("model_provider").and_then(toml::Value::as_str);
    if active.map(str::trim) != Some(CODEG_PROVIDER) {
        return None;
    }
    let table = value
        .get("model_providers")
        .and_then(|t| t.get(CODEG_PROVIDER))
        .and_then(toml::Value::as_table);
    let pairs = |key: &str| -> Vec<(String, String)> {
        table
            .and_then(|t| t.get(key))
            .and_then(toml::Value::as_table)
            .map(|t| {
                t.iter()
                    .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                    .collect()
            })
            .unwrap_or_default()
    };
    Some(ProviderParts {
        base_url: table
            .and_then(|t| t.get("base_url"))
            .and_then(toml::Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string(),
        query_params: pairs("query_params"),
        headers: pairs("http_headers"),
    })
}

/// Whether the active provider table carries a hand-written
/// `model_catalog_url` (shown as a hint: it does nothing while codeg
/// publishes a catalog file, and makes codex fetch it itself otherwise).
pub fn active_provider_has_catalog_url(toml_text: &str) -> bool {
    let Ok(value) = toml_text.parse::<toml::Table>() else {
        return false;
    };
    let Some(active) = value.get("model_provider").and_then(toml::Value::as_str) else {
        return false;
    };
    value
        .get("model_providers")
        .and_then(|t| t.get(active.trim()))
        .and_then(|t| t.get("model_catalog_url"))
        .is_some()
}

pub fn auth_api_key(auth_text: &str) -> Option<String> {
    serde_json::from_str::<Value>(auth_text)
        .ok()?
        .get("OPENAI_API_KEY")?
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// The provider request an intent publishes under, derived from the config
/// about to be published. `None` without a provider source.
pub fn request_for(
    intent: &CodexModelConfig,
    toml_text: &str,
    auth_text: &str,
) -> Result<Option<EndpointRequest>, CatalogError> {
    let Some(source) = intent.catalog.as_ref() else {
        return Ok(None);
    };
    let parts = codeg_provider_parts(toml_text).ok_or_else(|| {
        err(
            "provider_not_codeg",
            "the model list can only come from the provider codeg configures",
        )
    })?;
    let key = auth_api_key(auth_text).unwrap_or_default();
    EndpointRequest::new(
        &parts.base_url,
        source.url.as_deref(),
        &parts.query_params,
        &parts.headers,
        &key,
    )
    .map(Some)
}

/// A structured change to config.toml, applied on top of its base.
#[derive(Debug, Clone)]
pub enum TomlEdit {
    /// codeg's own provider, pointed at a bound provider's endpoint.
    ProviderEndpoint { base_url: String },
    /// The Codex panel's sandbox / approval controls.
    Sandbox(crate::acp::types::CodexSandboxStructuredConfig),
}

/// How the auth.json about to be published is made.
#[derive(Debug, Clone)]
pub enum AuthInput {
    /// Leave it as it is on disk.
    Keep,
    /// The panel's whole text.
    Text(String),
    /// Disk (or `base`, when given) with `OPENAI_API_KEY` set — a bound
    /// provider's key. An empty key leaves the field as it is.
    SetKey { base: Option<String>, key: String },
}

/// How the config.toml about to be published is made, before the managed
/// keys are applied.
#[derive(Debug, Clone)]
pub struct TomlInput {
    /// The whole text the user submitted (raw editor / panel draft); `None`
    /// starts from disk.
    pub base: Option<String>,
    /// The text the submitted draft was loaded from, to tell the user's own
    /// edits of a managed key from the disk changing underneath.
    pub baseline: Option<String>,
    pub edits: Vec<TomlEdit>,
}

impl TomlInput {
    pub fn disk() -> Self {
        Self {
            base: None,
            baseline: None,
            edits: Vec::new(),
        }
    }
}

/// Provider ids codex builds in. A `[model_providers.<id>]` table does not
/// configure one of them (the Bedrock ids and, from codex 0.165, Google Cloud
/// Vertex AI's `gcp` even reject most fields), so a bound provider never lands
/// there.
const BUILT_IN_PROVIDERS: &[&str] = &[
    "openai",
    "amazon-bedrock",
    "amazon-bedrock-runtime",
    "gcp",
    "ollama",
    "lmstudio",
];

fn apply_provider_endpoint(
    doc: &mut toml_edit::Document,
    base_url: &str,
) -> Result<(), CatalogError> {
    // The active provider gets the endpoint — codeg's own unless the user
    // named one of theirs. Only codeg's table gets codeg's keys.
    let active = doc_root_str(doc, "model_provider")
        .filter(|p| !BUILT_IN_PROVIDERS.contains(&p.as_str()))
        .unwrap_or_else(|| CODEG_PROVIDER.to_string());
    doc["model_provider"] = toml_edit::value(active.as_str());
    remove_root(doc, "api_base_url");
    let providers = &mut doc["model_providers"];
    if providers.is_none() {
        let mut t = toml_edit::Table::new();
        t.set_implicit(true);
        *providers = toml_edit::Item::Table(t);
    }
    let Some(providers) = providers.as_table_like_mut() else {
        return Err(err("invalid_config", "model_providers is not a table"));
    };
    if providers.get(&active).is_none() {
        providers.insert(&active, toml_edit::Item::Table(toml_edit::Table::new()));
    }
    let Some(table) = providers
        .get_mut(&active)
        .and_then(|i| i.as_table_like_mut())
    else {
        return Err(err(
            "invalid_config",
            format!("model_providers.{active} is not a table"),
        ));
    };
    if base_url.trim().is_empty() {
        table.remove("base_url");
    } else {
        table.insert("base_url", toml_edit::value(base_url));
    }
    if active != CODEG_PROVIDER {
        return Ok(());
    }
    table.insert("name", toml_edit::value(CODEG_PROVIDER));
    table.insert("wire_api", toml_edit::value("responses"));
    let actor_auth = table
        .get("http_headers")
        .and_then(|h| h.as_table_like())
        .is_some_and(|h| {
            h.iter().any(|(name, v)| {
                name.eq_ignore_ascii_case("x-openai-actor-authorization")
                    && v.as_str().is_some_and(|s| !s.trim().is_empty())
            })
        });
    if table.get("requires_openai_auth").is_none() && !actor_auth {
        table.insert("requires_openai_auth", toml_edit::value(true));
    }
    Ok(())
}

/// codeg's provider table when codex no longer uses it (a switch to the
/// ChatGPT subscription drops root `model_provider`): removed when it holds
/// only codeg's own keys, kept whole when it holds anything the user wrote —
/// removing only codeg's keys would drop the required `name` and codex would
/// refuse the entire config.
fn prune_inactive_codeg_provider(doc: &mut toml_edit::Document) {
    if doc_root_str(doc, "model_provider").as_deref() == Some(CODEG_PROVIDER) {
        return;
    }
    let only_codeg_keys = doc
        .get("model_providers")
        .and_then(|p| p.as_table_like())
        .and_then(|p| p.get(CODEG_PROVIDER))
        .and_then(|t| t.as_table_like())
        .is_some_and(|t| t.iter().all(|(k, _)| CODEG_PROVIDER_KEYS.contains(&k)));
    if !only_codeg_keys {
        return;
    }
    let mut now_empty = false;
    if let Some(providers) = doc
        .get_mut("model_providers")
        .and_then(|p| p.as_table_like_mut())
    {
        providers.remove(CODEG_PROVIDER);
        now_empty = providers.is_empty();
    }
    if now_empty {
        remove_root(doc, "model_providers");
    }
}

/// config.toml as the user's input and the structured edits make it, before
/// the managed keys.
pub fn compose_toml(input: &TomlInput, disk: &str) -> Result<String, CatalogError> {
    let mut text = input.base.clone().unwrap_or_else(|| disk.to_string());
    for edit in &input.edits {
        if let TomlEdit::Sandbox(sandbox) = edit {
            text = crate::commands::acp::apply_codex_sandbox_config(&text, sandbox)
                .map_err(|e| err("invalid_config", e.to_string()))?;
        }
    }
    let mut doc = parse_doc(&text)?;
    for edit in &input.edits {
        if let TomlEdit::ProviderEndpoint { base_url } = edit {
            apply_provider_endpoint(&mut doc, base_url)?;
        }
    }
    if input.base.is_some() {
        prune_inactive_codeg_provider(&mut doc);
    }
    Ok(doc.to_string())
}

pub fn compose_auth(input: &AuthInput, disk: &str) -> Result<String, CatalogError> {
    match input {
        AuthInput::Keep => Ok(disk.to_string()),
        AuthInput::Text(text) if text.trim().is_empty() => Ok(disk.to_string()),
        AuthInput::Text(text) => {
            let parsed: Value = serde_json::from_str(text)
                .map_err(|e| err("invalid_config", format!("invalid codex auth.json: {e}")))?;
            if !parsed.is_object() {
                return Err(err(
                    "invalid_config",
                    "invalid codex auth.json: root must be a JSON object",
                ));
            }
            Ok(text.clone())
        }
        AuthInput::SetKey { base, key } => {
            let source = base.as_deref().unwrap_or(disk);
            let mut value = serde_json::from_str::<Value>(source)
                .ok()
                .filter(Value::is_object)
                .unwrap_or_else(|| serde_json::json!({}));
            if key.trim().is_empty() {
                return Ok(if source.trim().is_empty() {
                    String::new()
                } else {
                    source.to_string()
                });
            }
            if value.get("OPENAI_API_KEY").and_then(Value::as_str) == Some(key.as_str()) {
                return Ok(source.to_string());
            }
            value["OPENAI_API_KEY"] = Value::String(key.clone());
            serde_json::to_string_pretty(&value).map_err(|e| io_err("serialize auth.json", e))
        }
    }
}

// ─── Building a catalog ─────────────────────────────────────────────────

/// What a commit does with `model_catalog_json`.
#[derive(Debug, Clone, PartialEq)]
pub enum PlanKind {
    /// Publish this catalog and point codex at it.
    Static(Built),
    /// The published catalog stays as it is (and codex keeps pointing at it).
    Keep { default_model: Option<String> },
    /// No catalog: codeg's reference goes, its file later (see
    /// [`cleanup_released`]); a user's own reference stays.
    Release,
}

impl PlanKind {
    pub fn manages_catalog(&self) -> bool {
        !matches!(self, PlanKind::Release)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Built {
    pub bytes: Vec<u8>,
    pub default_model: Option<String>,
    pub counts: CatalogCounts,
}

impl Built {
    fn from_catalog(value: &Value, default_model: Option<String>) -> Result<Self, CatalogError> {
        let models = value
            .get("models")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let counts = endpoint::counts(&models);
        if counts.usable == 0 {
            return Err(err(
                "no_usable_models",
                "no model is left that Codex can offer: keep at least one listed model",
            ));
        }
        let bytes = serde_json::to_vec_pretty(value).map_err(|e| io_err("serialize catalog", e))?;
        Ok(Self {
            bytes,
            default_model,
            counts,
        })
    }
}

/// The intent without what an OpenAI list does not use: its blocklist (an
/// OpenAI list is an allowlist, `selected`).
fn without_exclusions(intent: &CodexModelConfig) -> CodexModelConfig {
    CodexModelConfig {
        excluded_officials: Vec::new(),
        ..intent.clone()
    }
}

/// Build the catalog an intent publishes. `upstream` is the provider list to
/// build from (`None` when none could be had: the stand-in rules apply and the
/// result says why). `officials` is the runtime's official catalog: the
/// listed models of a codex-catalog intent, and the clone templates always.
pub fn build_plan(
    intent: &CodexModelConfig,
    officials: &[Value],
    upstream: Option<&EndpointSnapshot>,
) -> Result<(PlanKind, Option<&'static str>), CatalogError> {
    let Some(source) = intent.catalog.as_ref() else {
        if catalog::is_effectively_empty(intent, officials) {
            return Ok((PlanKind::Release, None));
        }
        let value = catalog::expand_to_catalog(intent, officials);
        let default = catalog::default_slug(intent, officials);
        return Ok((
            PlanKind::Static(Built::from_catalog(&value, default)?),
            None,
        ));
    };
    if let Some(up) = upstream {
        return match up.format {
            CatalogFormat::Native => {
                let models = endpoint::normalize_native(up.models.as_deref().unwrap_or_default());
                endpoint::validate_native(&models)?;
                let value = catalog::expand_catalog(intent, &models, officials);
                let default = catalog::default_slug(intent, &models);
                Ok((
                    PlanKind::Static(Built::from_catalog(&value, default)?),
                    None,
                ))
            }
            CatalogFormat::OpenaiList => {
                let listed = endpoint::synthesize_openai_entries(
                    &source.selected,
                    &up.seen_ids(),
                    officials,
                );
                let intent = without_exclusions(intent);
                let value = catalog::expand_catalog(&intent, &listed, officials);
                let default = catalog::default_slug(&intent, &listed);
                Ok((
                    PlanKind::Static(Built::from_catalog(&value, default)?),
                    None,
                ))
            }
        };
    }
    // No provider list at all.
    let intent_no_ex = without_exclusions(intent);
    let openai = source.format == Some(CatalogFormat::OpenaiList)
        || (source.format.is_none() && !source.selected.is_empty());
    let listed = if openai {
        // The picks are the user's own allowlist: rebuild them from the
        // templates, without the context lengths the provider reported.
        endpoint::synthesize_openai_entries(&source.selected, &HashMap::new(), officials)
    } else {
        // A provider catalog cannot be guessed: only the explicit default
        // stands in (built from the closest template), next to the customs.
        match intent.default.as_deref() {
            Some(d) if !intent.customs.iter().any(|c| c.slug == d) => {
                endpoint::synthesize_openai_entries(&[d.to_string()], &HashMap::new(), officials)
            }
            _ => Vec::new(),
        }
    };
    if listed.is_empty() && intent.customs.is_empty() {
        return Ok((PlanKind::Release, Some("no_provider_list")));
    }
    let value = catalog::expand_catalog(&intent_no_ex, &listed, officials);
    let default = catalog::default_slug(&intent_no_ex, &listed);
    Ok((
        PlanKind::Static(Built::from_catalog(&value, default)?),
        Some("no_provider_list"),
    ))
}

/// What saving a draft would make of the keys codeg manages, for the page
/// to show while the draft is edited.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanPreview {
    /// config.toml with the managed keys as the save would set them.
    pub final_toml: String,
    /// codeg would publish a catalog: `model_catalog_json` names its file.
    pub manages_catalog: bool,
    /// The root `model` codeg sets while it does.
    pub default_model: Option<String>,
    pub counts: Option<CatalogCounts>,
    /// Why it would be a stand-in or lose its source (`no_provider_list`,
    /// `provider_source_dropped`).
    pub warnings: Vec<String>,
}

/// [`PlanPreview`] of a draft: the intent `intent_raw`, config.toml and
/// auth.json as they would be saved. Read-only — nothing is fetched, judged
/// or written — so it answers as the save would when the provider and codex
/// agree; the save still has the catalog checked by codex.
pub async fn plan_preview(
    intent_raw: Option<&str>,
    toml_text: &str,
    auth_text: &str,
    published: &Published,
    cache: &EndpointCache,
) -> Result<PlanPreview, CatalogError> {
    let home = published.home.as_path();
    let runtime = codex_runtime::current().await;
    let mut intent = intent_raw
        .filter(|raw| !raw.trim().is_empty())
        .map(|raw| catalog::parse_model_config(Some(raw)))
        .unwrap_or_default();
    let mut warnings = Vec::new();
    if intent.catalog.is_some() && codeg_provider_parts(toml_text).is_none() {
        intent.catalog = None;
        warnings.push("provider_source_dropped".to_string());
    }
    let officials = officials_for(&runtime).await;
    let request = request_for(&intent, toml_text, auth_text)?;
    // The list a save without a fetch would build from: the published one
    // when it answers this request, else this request's latest cached one.
    let upstream = request.as_ref().and_then(|request| {
        let want = intent.catalog.as_ref().and_then(|c| c.format);
        let format_ok = |s: &EndpointSnapshot| want.is_none_or(|f| s.format == f);
        published
            .upstream
            .clone()
            .filter(|up| {
                format_ok(up) && published.meta.as_ref().is_some_and(|m| same_request(m, request))
            })
            .or_else(|| {
                cache
                    .for_url(home, request.url())
                    .into_iter()
                    .filter(|s| s.request_fingerprint == request.fingerprint() && format_ok(s))
                    .max_by_key(|s| s.request_seq)
            })
    });
    let (plan, stand_in) = build_plan(&intent, &officials, upstream.as_ref())?;
    if let Some(warning) = stand_in {
        warnings.push(warning.to_string());
    }
    let mut doc = parse_doc(toml_text)?;
    let (default_model, counts) = match &plan {
        PlanKind::Static(built) => (built.default_model.clone(), Some(built.counts)),
        PlanKind::Keep { default_model } => (default_model.clone(), None),
        PlanKind::Release => (None, None),
    };
    if plan.manages_catalog() {
        set_root(&mut doc, "model_catalog_json", Some(catalog::CATALOG_REL));
        set_root(&mut doc, "model", default_model.as_deref());
    } else if doc_root_str(&doc, "model_catalog_json").is_some_and(|v| is_codeg_catalog_ref(&v, home))
    {
        remove_root(&mut doc, "model_catalog_json");
    }
    Ok(PlanPreview {
        final_toml: doc.to_string(),
        manages_catalog: plan.manages_catalog(),
        default_model,
        counts,
        warnings,
    })
}

/// The runtimes that accepted a catalog, and those that refused it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Validation {
    pub validated_by: Vec<ValidatedRuntime>,
    pub conflict: Vec<ValidatedRuntime>,
}

pub fn judge_error(e: JudgeError) -> CatalogError {
    match e {
        JudgeError::NotInstalled => err("codex_not_installed", "codex is not installed"),
        JudgeError::Rejected(msg) => err(
            "codex_rejected",
            format!("Codex rejected the catalog: {msg}"),
        )
        .with_param("reason", msg),
        JudgeError::CountMismatch { .. } => {
            err("codex_rejected", e.to_string()).with_param("reason", e.to_string())
        }
        JudgeError::Timeout => {
            err("codex_rejected", "Codex did not answer in time").with_param("reason", "timeout")
        }
        JudgeError::Io(msg) => err("io", msg),
    }
}

/// Ask the current runtime — and every other runtime that accepted the
/// previous catalog and is still on disk — whether they load `bytes`.
///
/// The current runtime refusing is an error. Another refusing is a conflict:
/// the catalog is still published (it is what this launch can use), and the
/// refusers are recorded. A codex that is not installed is skipped: nothing
/// can launch until one is, and the pre-launch check judges it first.
pub async fn validate_group(
    bytes: &[u8],
    current: &CodexRuntime,
    previous: &[ValidatedRuntime],
) -> Result<Validation, CatalogError> {
    let mut out = Validation::default();
    if let Some(js) = current.codex_js.as_deref() {
        match codex_runtime::judge(js, bytes).await {
            Ok(_) => {
                if let Some(entry) = current.validated_entry() {
                    out.validated_by.push(entry);
                }
            }
            Err(JudgeError::NotInstalled) => {}
            Err(e) => return Err(judge_error(e)),
        }
    }
    for entry in previous {
        let Some(entry) = entry.refreshed() else {
            continue;
        };
        if out.validated_by.iter().any(|v| v.version == entry.version)
            || out.conflict.iter().any(|v| v.version == entry.version)
            || (current.confirmed && entry.version == current.version)
        {
            continue;
        }
        match codex_runtime::judge(Path::new(&entry.codex_js), bytes).await {
            Ok(_) => out.validated_by.push(entry),
            Err(JudgeError::NotInstalled) => {}
            Err(_) => out.conflict.push(entry),
        }
    }
    out.validated_by.truncate(MAX_VALIDATED);
    Ok(out)
}

/// Add the current runtime to a validation that already holds, newest first.
fn merged_validation(
    previous: &[ValidatedRuntime],
    current: &ValidatedRuntime,
) -> Vec<ValidatedRuntime> {
    let mut out = vec![current.clone()];
    for v in previous {
        if v.version != current.version && out.len() < MAX_VALIDATED {
            out.push(v.clone());
        }
    }
    out
}

pub fn intent_hash(intent: &CodexModelConfig) -> String {
    sha256_hex(serde_json::to_string(intent).unwrap_or_default().as_bytes())
}

// ─── Prepare ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    /// A save, a bind, a provider edit or "Refresh now".
    User,
    /// The scheduler.
    Background,
    /// The check before a Codex session starts.
    Prelaunch,
    /// After codex-acp was installed or upgraded in codeg.
    Install,
}

impl Origin {
    pub fn is_user(self) -> bool {
        self == Origin::User
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FetchPolicy {
    /// Use only what is published or cached.
    Never,
    /// Fetch unless the published list already answers this request for
    /// this runtime (or one was fetched moments ago).
    IfNeeded,
    /// Always fetch first.
    Force,
}

/// What a prepared commit was built on. The lock-side check recomputes it;
/// any difference means the result is out of date.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Basis {
    pub binding: Binding,
    pub intent_hash: Option<String>,
    pub request_fingerprint: Option<String>,
    pub client_version: String,
    pub snapshot_id: Option<String>,
    /// The provenance the result was built from. Another process confirming
    /// the same catalog under a later request changes it and nothing else.
    pub meta_id: Option<String>,
}

/// What happens to the published upstream list.
#[derive(Debug, Clone, PartialEq)]
pub enum UpstreamAction {
    Keep,
    Write(Box<EndpointSnapshot>),
    Delete,
}

/// A commit, prepared outside the lock.
#[derive(Debug, Clone)]
pub struct Prepared {
    pub origin: Origin,
    pub basis: Basis,
    /// The sidecar to publish, verbatim; `None` deletes it.
    pub sidecar: Option<String>,
    pub plan: PlanKind,
    /// `None` deletes the provenance.
    pub meta: Option<CatalogMeta>,
    pub upstream: UpstreamAction,
    /// The request number of the provider list this commit publishes or
    /// re-confirms, when it does: a published list from a LATER request wins.
    pub request_seq: Option<u64>,
    /// Preparing asked the provider (whether or not it answered).
    pub fetched: bool,
    /// The fetch made while preparing failed (the published state was kept,
    /// or a stand-in built).
    pub fetch_error: Option<CatalogError>,
    pub warnings: Vec<String>,
}

impl Prepared {
    /// Nothing to publish beyond what is there.
    pub fn is_noop(&self) -> bool {
        matches!(self.plan, PlanKind::Keep { .. })
            && self.upstream == UpstreamAction::Keep
            && self.meta.is_none()
    }
}

/// Everything [`prepare`] works from.
pub struct PrepareInput<'a> {
    pub origin: Origin,
    pub binding: Binding,
    /// The intent to publish, verbatim (what goes into the sidecar).
    pub intent_raw: Option<String>,
    /// config.toml and auth.json as this commit will publish them, bar the
    /// managed keys — what the provider request derives from.
    pub toml_text: &'a str,
    pub auth_text: &'a str,
    pub published: &'a Published,
    pub fetch: FetchPolicy,
    pub cache: &'a EndpointCache,
}

/// The current runtime's official catalog, or the best stand-in when it
/// cannot be read (no codex installed yet).
pub async fn officials_for(runtime: &CodexRuntime) -> Vec<Value> {
    #[cfg(test)]
    if let Some(models) = tests::hooks::officials() {
        return models;
    }
    match crate::acp::codex_catalog_source::catalog_for_runtime(runtime).await {
        Some(models) => models,
        None => crate::acp::codex_catalog_source::cached_or_bundled_snapshot(),
    }
}

fn same_request(meta: &CatalogMeta, request: &EndpointRequest) -> bool {
    meta.request_fingerprint.as_deref() == Some(request.fingerprint().as_str())
        && meta.url.as_deref() == Some(request.url())
}

/// Fetch with a fresh request number, store the result in the cache.
async fn fetch_into_cache(
    home: &Path,
    request: &EndpointRequest,
    runtime: &CodexRuntime,
    cache: &EndpointCache,
    previous: Option<&EndpointSnapshot>,
    selected: &[String],
) -> Result<EndpointSnapshot, CatalogError> {
    let seq = lock::take_seq(home).await?;
    let outcome = endpoint::fetch(request, &runtime.version).await?;
    let last_seen = previous
        .filter(|p| p.url == request.url())
        .map(|p| p.last_seen.clone())
        .unwrap_or_default();
    let mut snapshot = endpoint::snapshot_of(
        request,
        seq,
        &runtime.version,
        runtime.confirmed,
        &outcome,
        &last_seen,
        selected,
    );
    if let Err(e) = cache.store(home, &mut snapshot) {
        tracing::warn!("[codex-catalog] could not cache the provider list: {e}");
    }
    Ok(snapshot)
}

/// One way to source the provider list, tried in order.
struct Candidate {
    snapshot: EndpointSnapshot,
    fresh: bool,
    stale: bool,
}

pub async fn prepare(input: PrepareInput<'_>) -> Result<Prepared, CatalogError> {
    let published = input.published;
    let home = published.home.as_path();
    let runtime = codex_runtime::current().await;
    let mut sidecar = input.intent_raw.clone().filter(|s| !s.trim().is_empty());
    let mut intent = sidecar
        .as_deref()
        .map(|raw| catalog::parse_model_config(Some(raw)))
        .unwrap_or_default();
    // What was asked for, before anything below adjusts it: the commit-time
    // check compares the current intent against this.
    let asked_hash = sidecar.as_ref().map(|_| intent_hash(&intent));
    let mut warnings = Vec::new();
    // A provider list needs codeg's provider; under any other the intent
    // keeps its customs and loses the source.
    if intent.catalog.is_some() && codeg_provider_parts(input.toml_text).is_none() {
        intent.catalog = None;
        sidecar = Some(serde_json::to_string(&intent).map_err(|e| io_err("serialize intent", e))?);
        warnings.push("provider_source_dropped".to_string());
    }
    let hash = sidecar.as_ref().map(|_| intent_hash(&intent));
    let request = request_for(&intent, input.toml_text, input.auth_text)?;
    let basis = Basis {
        binding: input.binding.clone(),
        intent_hash: asked_hash,
        request_fingerprint: request.as_ref().map(EndpointRequest::fingerprint),
        client_version: runtime.version.clone(),
        snapshot_id: published.snapshot_id(),
        meta_id: published.meta_id(),
    };
    let prev_meta = published.meta.as_ref();
    let officials = officials_for(&runtime).await;

    let Some(request) = request else {
        // No provider source: a codex-catalog expansion, or nothing at all.
        let (plan, _) = build_plan(&intent, &officials, None)?;
        return finish_without_source(
            input.origin,
            basis,
            sidecar,
            plan,
            &intent,
            &input.binding,
            &runtime,
            prev_meta,
            published,
            warnings,
        )
        .await;
    };

    let source = intent.catalog.clone().unwrap_or_default();
    let wanted_format = source.format;
    let current_published = prev_meta.is_some_and(|m| {
        same_request(m, &request)
            && m.intent_hash == hash.clone().unwrap_or_default()
            && published.publishes_catalog()
    });

    // 1. Fetch, if this commit should.
    let recent = input
        .cache
        .exact(home, &request, &runtime.version, wanted_format)
        .filter(|s| crate::acp::provider_models::clock::now() - s.fetched_at < RECENT_FETCH);
    let needs_fetch = match input.fetch {
        FetchPolicy::Never => false,
        FetchPolicy::Force => true,
        FetchPolicy::IfNeeded => {
            let up_to_date = prev_meta.is_some_and(|m| {
                same_request(m, &request)
                    && m.client_version.as_deref() == Some(runtime.version.as_str())
                    && !m.stale
                    && m.degraded.is_none()
                    && published.upstream.is_some()
            });
            !up_to_date && recent.is_none()
        }
    };
    let mut fetch_error = None;
    let mut fresh: Option<EndpointSnapshot> = None;
    if needs_fetch {
        match fetch_into_cache(
            home,
            &request,
            &runtime,
            input.cache,
            published.upstream.as_ref(),
            &source.selected,
        )
        .await
        {
            Ok(s) => fresh = Some(s),
            Err(e) => fetch_error = Some(e),
        }
    } else if input.fetch == FetchPolicy::IfNeeded {
        fresh = recent;
    }

    // A list in the other shape is never published as this intent.
    if let (Some(s), Some(want)) = (&fresh, wanted_format) {
        if s.format != want {
            if input.origin.is_user() {
                return Err(err(
                    "format_changed",
                    format!(
                        "the provider now answers with a {} list; fetch it again and re-pick",
                        s.format.as_str()
                    ),
                )
                .with_param("format", s.format.as_str()));
            }
            // Keep what is published — a catalog, or none when a stand-in
            // released it — and remember the provider moved.
            let mut meta = prev_meta.cloned().unwrap_or_default();
            meta.pending_format = Some(s.format);
            meta.checked_at = Some(s.fetched_at);
            let plan = if published.publishes_catalog() {
                PlanKind::Keep {
                    default_model: prev_meta.and_then(|m| m.default_model.clone()),
                }
            } else {
                PlanKind::Release
            };
            return Ok(Prepared {
                origin: input.origin,
                basis,
                sidecar,
                plan,
                meta: Some(meta),
                upstream: UpstreamAction::Keep,
                request_seq: Some(s.request_seq),
                fetched: needs_fetch,
                fetch_error: None,
                warnings,
            });
        }
    }

    // 2. The provider confirmed the same list: keep the catalog, update when
    //    and how it was confirmed. Not when the runtime's official catalog
    //    moved on since it was built: the templates it was cloned from did too.
    if let (Some(s), true) = (&fresh, current_published) {
        let meta = prev_meta.cloned().unwrap_or_default();
        if meta.content_hash.as_deref() == Some(s.content_hash.as_str())
            && meta.is_validated_by(&runtime)
            && meta.built_for(&runtime)
        {
            let mut meta = meta;
            record_request(&mut meta, s);
            meta.checked_at = Some(s.fetched_at);
            meta.stale = false;
            meta.pending_format = None;
            meta.diff = s.diff.clone();
            return Ok(Prepared {
                origin: input.origin,
                basis,
                sidecar,
                plan: PlanKind::Keep {
                    default_model: meta.default_model.clone(),
                },
                meta: Some(meta),
                upstream: UpstreamAction::Keep,
                request_seq: Some(s.request_seq),
                fetched: needs_fetch,
                fetch_error: None,
                warnings,
            });
        }
    }

    // 3. No new list: keep the current publication when it still answers
    //    this request and intent and this runtime loads it — a passing
    //    outage must not swap a newer publication for a fallback.
    if fresh.is_none() && current_published {
        let meta = prev_meta.cloned().unwrap_or_default();
        let loads = if meta.is_validated_by(&runtime) {
            true
        } else {
            match (&published.catalog, runtime.codex_js.as_deref()) {
                (Some(bytes), Some(js)) => codex_runtime::judge(js, bytes).await.is_ok(),
                _ => false,
            }
        };
        if loads {
            let mut meta_update = None;
            if !meta.is_validated_by(&runtime) {
                if let Some(entry) = runtime.validated_entry() {
                    let mut m = meta.clone();
                    m.validated_by = merged_validation(&m.validated_by, &entry);
                    meta_update = Some(m);
                }
            }
            return Ok(Prepared {
                origin: input.origin,
                basis,
                sidecar,
                plan: PlanKind::Keep {
                    default_model: meta.default_model.clone(),
                },
                meta: meta_update,
                upstream: UpstreamAction::Keep,
                request_seq: None,
                fetched: needs_fetch,
                fetch_error,
                warnings,
            });
        }
    }

    // 4. Pick a list: this fetch, then the same request's earlier answers
    //    (published, cached), then the same URL's other answers (another
    //    key, parameters or codex version). Another URL's list never stands
    //    in for this one.
    let mut candidates: Vec<Candidate> = Vec::new();
    if let Some(s) = fresh.clone() {
        candidates.push(Candidate {
            snapshot: s,
            fresh: true,
            stale: false,
        });
    }
    let fp = request.fingerprint();
    let format_ok = |s: &EndpointSnapshot| wanted_format.is_none_or(|f| s.format == f);
    let mut same: Vec<EndpointSnapshot> = Vec::new();
    let mut other: Vec<EndpointSnapshot> = Vec::new();
    if let (Some(up), Some(m)) = (&published.upstream, prev_meta) {
        if up.url == request.url() && format_ok(up) {
            let mut up = up.clone();
            // The provenance holds the latest confirmation of this list.
            if let Some(seq) = m.request_seq {
                up.request_seq = up.request_seq.max(seq);
            }
            if same_request(m, &request) {
                same.push(up);
            } else {
                other.push(up);
            }
        }
    }
    for s in input.cache.for_url(home, request.url()) {
        if !format_ok(&s) {
            continue;
        }
        if s.request_fingerprint == fp {
            same.push(s);
        } else {
            other.push(s);
        }
    }
    same.sort_by_key(|s| std::cmp::Reverse(s.request_seq));
    other.sort_by_key(|s| std::cmp::Reverse(s.request_seq));
    for s in same {
        candidates.push(Candidate {
            snapshot: s,
            fresh: false,
            stale: false,
        });
    }
    for s in other {
        candidates.push(Candidate {
            snapshot: s,
            fresh: false,
            stale: true,
        });
    }

    let previous_validation = prev_meta
        .map(|m| m.validated_by.clone())
        .unwrap_or_default();
    let mut last_error = None;
    for c in candidates {
        let (plan, _) = match build_plan(&intent, &officials, Some(&c.snapshot)) {
            Ok(p) => p,
            Err(e) => {
                last_error = Some(e);
                continue;
            }
        };
        let PlanKind::Static(built) = &plan else {
            continue;
        };
        let validation = match validate_group(&built.bytes, &runtime, &previous_validation).await {
            Ok(v) => v,
            Err(e) => {
                last_error = Some(e);
                continue;
            }
        };
        let mut meta = static_meta(
            hash.clone().unwrap_or_default(),
            &input.binding,
            built,
            &validation,
            &runtime,
        );
        record_request(&mut meta, &c.snapshot);
        meta.format = Some(c.snapshot.format);
        meta.checked_at = Some(c.snapshot.fetched_at);
        meta.stale = c.stale;
        meta.diff = if c.fresh {
            c.snapshot.diff.clone()
        } else {
            prev_meta
                .filter(|m| same_request(m, &request))
                .map(|m| m.diff.clone())
                .unwrap_or_default()
        };
        if c.stale {
            warnings.push("stale_provider_list".into());
        }
        let mut upstream = c.snapshot.clone();
        upstream.diff = CatalogDiff::default();
        return Ok(Prepared {
            origin: input.origin,
            basis,
            sidecar,
            plan,
            meta: Some(meta),
            // Only a fresh answer can be a slow, late one; an older list picked
            // deliberately as a fallback is not ordered against the published one.
            request_seq: c.fresh.then_some(c.snapshot.request_seq),
            upstream: UpstreamAction::Write(Box::new(upstream)),
            fetched: needs_fetch,
            fetch_error,
            warnings,
        });
    }

    // A user who just asked for a list and got an answer codex refuses is
    // told so, rather than handed a stand-in.
    if input.origin.is_user() && fresh.is_some() {
        if let Some(e) = last_error {
            return Err(e);
        }
    }

    // 5. Nothing usable: the stand-in.
    let (plan, degraded) = build_plan(&intent, &officials, None)?;
    if let Some(e) = fetch_error.clone() {
        if input.origin.is_user() && !matches!(plan, PlanKind::Static(_)) {
            // Nothing at all to publish for what the user asked: say why.
            return Err(e);
        }
    }
    warnings.push("degraded".into());
    let mut prepared = finish_without_source(
        input.origin,
        basis,
        sidecar,
        plan,
        &intent,
        &input.binding,
        &runtime,
        prev_meta,
        published,
        warnings,
    )
    .await?;
    if let Some(meta) = prepared.meta.as_mut() {
        meta.degraded = Some(degraded.unwrap_or("no_provider_list").to_string());
        meta.url = Some(request.url().to_string());
        meta.request_fingerprint = Some(request.fingerprint());
        meta.key_digest = Some(request.key_digest());
        meta.format = wanted_format;
        // Keep the published list for the next attempt.
        if let Some(prev) = prev_meta {
            meta.checked_at = prev.checked_at;
        }
    }
    prepared.upstream = UpstreamAction::Keep;
    prepared.fetch_error = fetch_error;
    prepared.fetched = needs_fetch;
    Ok(prepared)
}

fn record_request(meta: &mut CatalogMeta, s: &EndpointSnapshot) {
    meta.url = Some(s.url.clone());
    meta.request_fingerprint = Some(s.request_fingerprint.clone());
    meta.key_digest = Some(s.key_digest.clone());
    meta.client_version = Some(s.client_version.clone());
    meta.client_version_confirmed = Some(s.client_version_confirmed);
    meta.request_seq = Some(s.request_seq);
    meta.request_started_at = Some(s.request_started_at);
    meta.fetched_at = Some(s.fetched_at);
    meta.content_hash = Some(s.content_hash.clone());
    meta.bytes = Some(s.bytes);
}

fn static_meta(
    intent_hash: String,
    binding: &Binding,
    built: &Built,
    validation: &Validation,
    runtime: &CodexRuntime,
) -> CatalogMeta {
    CatalogMeta {
        version: 1,
        intent_hash,
        binding: binding.as_wire(),
        snapshot_id: Some(sha256_hex(&built.bytes)),
        validated_by: validation.validated_by.clone(),
        conflict: validation.conflict.clone(),
        officials_version: runtime.confirmed.then(|| runtime.version.clone()),
        default_model: built.default_model.clone(),
        counts: built.counts,
        ..Default::default()
    }
}

/// The meta, upstream and plan for an intent with no provider list to
/// publish (a codex-catalog expansion, a release, or a stand-in).
#[allow(clippy::too_many_arguments)]
async fn finish_without_source(
    origin: Origin,
    basis: Basis,
    sidecar: Option<String>,
    plan: PlanKind,
    intent: &CodexModelConfig,
    binding: &Binding,
    runtime: &CodexRuntime,
    prev_meta: Option<&CatalogMeta>,
    published: &Published,
    warnings: Vec<String>,
) -> Result<Prepared, CatalogError> {
    // Only a provider source outlives a release: the user's choice of source
    // stands while no list is available.
    let keeps_intent = sidecar.is_some() && intent.catalog.is_some();
    let upstream_action = if intent.catalog.is_some() {
        UpstreamAction::Keep
    } else if published.upstream.is_some() {
        UpstreamAction::Delete
    } else {
        UpstreamAction::Keep
    };
    match plan {
        PlanKind::Static(built) => {
            // Unchanged content and a runtime that already loaded it: only the
            // provenance may need to say so.
            let same = published.snapshot_id().as_deref()
                == Some(sha256_hex(&built.bytes).as_str())
                && published.references_codeg_catalog();
            let previous = prev_meta
                .map(|m| m.validated_by.clone())
                .unwrap_or_default();
            let validation = if same && prev_meta.is_some_and(|m| m.is_validated_by(runtime)) {
                Validation {
                    validated_by: previous.clone(),
                    conflict: prev_meta.map(|m| m.conflict.clone()).unwrap_or_default(),
                }
            } else {
                validate_group(&built.bytes, runtime, &previous).await?
            };
            let meta = static_meta(intent_hash(intent), binding, &built, &validation, runtime);
            Ok(Prepared {
                origin,
                basis,
                sidecar,
                plan: PlanKind::Static(built),
                meta: Some(meta),
                upstream: upstream_action,
                request_seq: None,
                fetched: false,
                fetch_error: None,
                warnings,
            })
        }
        PlanKind::Release => {
            // A provider source that fell back to nothing keeps its intent and
            // provenance; anything else goes with the reference.
            let meta = keeps_intent.then(|| CatalogMeta {
                version: 1,
                intent_hash: intent_hash(intent),
                binding: binding.as_wire(),
                ..Default::default()
            });
            Ok(Prepared {
                origin,
                basis,
                sidecar: if keeps_intent { sidecar } else { None },
                plan: PlanKind::Release,
                meta,
                upstream: if keeps_intent {
                    UpstreamAction::Keep
                } else if published.upstream.is_some() {
                    UpstreamAction::Delete
                } else {
                    UpstreamAction::Keep
                },
                request_seq: None,
                fetched: false,
                fetch_error: None,
                warnings,
            })
        }
        PlanKind::Keep { default_model } => Ok(Prepared {
            origin,
            basis,
            sidecar,
            plan: PlanKind::Keep { default_model },
            meta: None,
            upstream: UpstreamAction::Keep,
            request_seq: None,
            fetched: false,
            fetch_error: None,
            warnings,
        }),
    }
}

// ─── Commit ─────────────────────────────────────────────────────────────

/// What the commit-time check compares against: the binding and intent as
/// they are NOW (re-read from the database for a user's save, from the
/// published state otherwise).
#[derive(Debug, Clone)]
pub struct CurrentIntent {
    pub binding: Binding,
    pub intent_raw: Option<String>,
}

/// What to do with root `model` when no catalog is published.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReleaseModel {
    /// Leave whatever the composed config.toml has (the panel's own value).
    Keep,
    Set(String),
    Clear,
}

#[derive(Debug, Clone)]
pub struct CommitOutcome {
    pub changed: Vec<String>,
    pub config_toml: String,
    pub auth_json: String,
    pub meta: Option<CatalogMeta>,
}

#[derive(Debug, Clone)]
pub enum CommitError {
    /// Something the result was built on changed: prepare again (a user's
    /// save) or drop it (everyone else).
    Stale(&'static str),
    /// A provider list from a later request is already published.
    Superseded,
    Failed(CatalogError),
}

impl From<CatalogError> for CommitError {
    fn from(e: CatalogError) -> Self {
        CommitError::Failed(e)
    }
}

impl From<TxnError> for CommitError {
    fn from(e: TxnError) -> Self {
        CommitError::Failed(e.into())
    }
}

/// Whether a commit was cut short (its journal is still there). Taking the
/// lock finishes or undoes it.
pub fn interrupted(home: &Path) -> bool {
    home.join(txn::JOURNAL_FILE).exists()
}

/// `CODEX_HOME` with both locks held and any interrupted commit resolved.
pub struct LockedHome {
    guard: CodexHomeGuard,
    published: Published,
}

/// Take the lock, finish or undo an interrupted commit, read what is
/// published.
pub async fn lock_home(home: &Path) -> Result<LockedHome, CatalogError> {
    let guard = lock::acquire(home, LOCK_WAIT).await?;
    txn::recover(&guard)?;
    let published = Published::read(home)?;
    Ok(LockedHome { guard, published })
}

const MANAGED_KEYS: [&str; 2] = ["model_catalog_json", "model"];

impl LockedHome {
    pub fn published(&self) -> &Published {
        &self.published
    }

    pub fn guard(&self) -> &CodexHomeGuard {
        &self.guard
    }

    /// The commit-time check, then the managed keys, then one transaction.
    pub async fn commit(
        &self,
        prepared: &Prepared,
        current: &CurrentIntent,
        toml: &TomlInput,
        auth: &AuthInput,
        release_model: &ReleaseModel,
    ) -> Result<CommitOutcome, CommitError> {
        let published = &self.published;
        let home = self.guard.home();
        let config = compose_toml(toml, published.config_text())?;
        let auth_text = compose_auth(auth, published.auth_text())?;

        // 1. Still what it was built on?
        if published.snapshot_id() != prepared.basis.snapshot_id {
            return Err(CommitError::Stale("the published catalog changed"));
        }
        if published.meta_id() != prepared.basis.meta_id {
            return Err(CommitError::Stale("the published provenance changed"));
        }
        if current.binding != prepared.basis.binding {
            return Err(CommitError::Stale("the binding changed"));
        }
        // Against what was asked for, not what came out: the prepared
        // sidecar may have dropped a provider source codeg cannot serve.
        let current_hash = current
            .intent_raw
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .map(|raw| intent_hash(&catalog::parse_model_config(Some(raw))));
        if current_hash != prepared.basis.intent_hash {
            return Err(CommitError::Stale("the model list settings changed"));
        }
        let intent = current
            .intent_raw
            .as_deref()
            .map(|raw| catalog::parse_model_config(Some(raw)))
            .unwrap_or_default();
        let fingerprint = request_for(&intent, &config, &auth_text)
            .ok()
            .flatten()
            .map(|r| r.fingerprint());
        if intent.catalog.is_some() && fingerprint != prepared.basis.request_fingerprint {
            return Err(CommitError::Stale("the provider request changed"));
        }
        let runtime = codex_runtime::current().await;
        if runtime.version != prepared.basis.client_version {
            return Err(CommitError::Stale("the codex runtime changed"));
        }
        // 2. Never let an earlier request overwrite a later answer to the
        //    same request. A list for another request (the user switching
        //    back to an endpoint fetched earlier) is not ordered against it.
        if let (Some(ours), Some(theirs)) = (prepared.request_seq, published.meta.as_ref()) {
            let same_request = theirs.request_fingerprint.is_some()
                && theirs.request_fingerprint == prepared.basis.request_fingerprint;
            if same_request && theirs.request_seq.is_some_and(|seq| seq > ours) {
                return Err(CommitError::Superseded);
            }
        }

        // 3. Managed keys.
        let mut doc = parse_doc(&config)?;
        if prepared.plan.manages_catalog() {
            if let (Some(base), Some(baseline)) = (&toml.base, &toml.baseline) {
                for key in MANAGED_KEYS {
                    if root_str_of(base, key) != root_str_of(baseline, key) {
                        return Err(CommitError::Failed(
                            err(
                                "managed_key_edited",
                                format!(
                                    "`{key}` is managed by codeg while it publishes the model list; change it in the model list instead"
                                ),
                            )
                            .with_param("key", key),
                        ));
                    }
                }
            }
            let default_model = match &prepared.plan {
                PlanKind::Static(b) => b.default_model.clone(),
                PlanKind::Keep { default_model } => default_model.clone(),
                PlanKind::Release => None,
            };
            set_root(&mut doc, "model_catalog_json", Some(catalog::CATALOG_REL));
            set_root(&mut doc, "model", default_model.as_deref());
        } else {
            let owned = doc_root_str(&doc, "model_catalog_json")
                .is_some_and(|v| is_codeg_catalog_ref(&v, home));
            if owned {
                remove_root(&mut doc, "model_catalog_json");
            }
            match release_model {
                ReleaseModel::Keep => {}
                ReleaseModel::Set(m) => set_root(&mut doc, "model", Some(m)),
                ReleaseModel::Clear => set_root(&mut doc, "model", None),
            }
        }
        let config_out = doc.to_string();

        // 4. One transaction, files before what references them.
        let mut targets = Vec::new();
        if let PlanKind::Static(built) = &prepared.plan {
            targets.push(Target::write(catalog::CATALOG_REL, built.bytes.clone()));
        }
        match &prepared.upstream {
            UpstreamAction::Keep => {}
            UpstreamAction::Write(s) => targets.push(Target::write(
                UPSTREAM_REL,
                serde_json::to_vec_pretty(s.as_ref())
                    .map_err(|e| io_err("serialize upstream", e))?,
            )),
            UpstreamAction::Delete => targets.push(Target::delete(UPSTREAM_REL)),
        }
        let meta_out = match &prepared.meta {
            Some(meta) => {
                let mut meta = meta.clone();
                meta.version = 1;
                if let PlanKind::Keep { .. } = prepared.plan {
                    meta.snapshot_id = published.snapshot_id();
                }
                targets.push(Target::write(
                    META_REL,
                    serde_json::to_vec_pretty(&meta).map_err(|e| io_err("serialize meta", e))?,
                ));
                Some(meta)
            }
            None if matches!(prepared.plan, PlanKind::Release) && prepared.sidecar.is_none() => {
                targets.push(Target::delete(META_REL));
                None
            }
            None => published.meta.clone(),
        };
        match &prepared.sidecar {
            Some(raw) => targets.push(Target::write(catalog::SOURCE_REL, raw.as_bytes().to_vec())),
            None => targets.push(Target::delete(catalog::SOURCE_REL)),
        }
        let auth_changes = match auth {
            AuthInput::Keep => false,
            AuthInput::Text(t) => !t.trim().is_empty(),
            AuthInput::SetKey { .. } => true,
        };
        if auth_changes && !auth_text.is_empty() {
            targets.push(Target::write(AUTH_REL, auth_text.clone().into_bytes()));
        }
        targets.push(Target::write(CONFIG_REL, config_out.clone().into_bytes()));
        let report = txn::commit_files(&self.guard, targets)?;
        Ok(CommitOutcome {
            changed: report.changed,
            config_toml: config_out,
            auth_json: auth_text,
            meta: meta_out,
        })
    }
}

/// Delete codeg's catalog file once config.toml no longer points at it. Run
/// at startup, under the lock: a commit that released it left the file for a
/// codex that may have been starting on the old config.
pub async fn cleanup_released(home: &Path) -> Result<(), CatalogError> {
    // Most homes have nothing to clean up: leave their lock (and, for someone
    // who never used Codex, the directory itself) uncreated.
    let unlocked = Published::read(home)?;
    if !interrupted(home) && !(unlocked.catalog.is_some() && !unlocked.references_codeg_catalog()) {
        return Ok(());
    }
    let locked = lock_home(home).await?;
    let p = locked.published();
    if p.catalog.is_some() && !p.references_codeg_catalog() {
        let keeps_source = p.intent().is_some_and(|i| i.catalog.is_some());
        let mut targets = vec![Target::delete(catalog::CATALOG_REL)];
        if !keeps_source {
            if p.upstream.is_some() {
                targets.push(Target::delete(UPSTREAM_REL));
            }
            if p.sidecar.is_none() && p.meta.is_some() {
                targets.push(Target::delete(META_REL));
            }
        }
        txn::commit_files(locked.guard(), targets)?;
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests;
