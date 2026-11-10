//! Fetching a provider's own model list for Codex.
//!
//! codeg never hands codex a `model_catalog_url`: on the codex it pins, any
//! problem with that URL (a 401, an outage, a list codex cannot parse) leaves
//! codex with no models at all and codex-acp refuses to open a session. codeg
//! fetches the list itself, with the key, checks it, and publishes a static
//! `model_catalog_json` (see [`crate::acp::codex_catalog_commit`]). This module
//! is the fetch, the shape check and the normalization; publishing, ordering
//! and refresh live in the coordinator and the scheduler.
//!
//! Two shapes come back from `base_url + "/models"`:
//! - a Codex-native catalog `{"models":[ModelInfo…]}` (sub2api, CLIProxyAPI,
//!   LiteLLM answer this when the request carries `client_version`), used
//!   as-is apart from [`normalize_native`];
//! - an OpenAI list `{"data":[{"id"…}]}` (new-api, OpenAI itself), from which
//!   the user picks ids that [`synthesize_openai_entries`] turns into entries
//!   by cloning the metadata of the closest official model.
//!
//! The request mirrors what codex itself would send for the provider —
//! `client_version`, the provider's `query_params` and static `http_headers`,
//! Bearer auth, no redirects — so what codeg checked is what codex would get.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use url::Url;

use crate::acp::codex_model_catalog::{self, CatalogFormat};
use crate::acp::provider_models::{self, parse_http_url, with_path_suffix};
pub use crate::acp::provider_models::EndpointError;

/// Overrides that make a cloned GPT entry speak plain OpenAI Responses, for
/// an id no official model matches. Mirrors `CODEX_COMPAT_OVERRIDES` in
/// `src/lib/types.ts`, where the reasoning behind each key is recorded.
const COMPAT_OVERRIDES: &[(&str, Value)] = &[
    ("tool_mode", Value::Null),
    ("multi_agent_version", Value::Null),
    ("use_responses_lite", Value::Bool(false)),
    ("apply_patch_tool_type", Value::Null),
    ("supports_image_detail_original", Value::Bool(false)),
];

/// Hex SHA-256.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

impl EndpointError {
    /// The message for a path whose errors reach the settings page as plain
    /// text (the save commands): the English message, then a last line
    /// starting with [`ERROR_MARKER`] and holding `{code, params}` as JSON,
    /// which the page localizes from.
    pub fn marked_message(&self) -> String {
        let tag = serde_json::json!({ "code": self.code, "params": self.params });
        format!("{}\n{ERROR_MARKER}{tag}", self.message)
    }
}

/// See [`EndpointError::marked_message`]; `src/lib/codex-catalog-error.ts`
/// reads it.
pub const ERROR_MARKER: &str = "[codexCatalog] ";

impl From<EndpointError> for crate::app_error::AppCommandError {
    fn from(e: EndpointError) -> Self {
        e.to_app_error("codexCatalog")
    }
}

/// `base_url` + `/models`, joined on the path: a trailing `/` is dropped,
/// the query is kept and the fragment discarded, so
/// `https://host/v1?tenant=a` becomes `https://host/v1/models?tenant=a`.
pub fn derive_catalog_url(base_url: &str) -> Result<Url, EndpointError> {
    if base_url.trim().is_empty() {
        return Err(EndpointError::new(
            "missing_base_url",
            "the provider has no base URL",
        ));
    }
    Ok(with_path_suffix(&parse_http_url(base_url)?, "/models"))
}

/// The list URL a request goes to: the user's own catalog URL when set,
/// otherwise the one derived from `base_url`.
pub fn resolve_catalog_url(
    base_url: &str,
    catalog_url: Option<&str>,
) -> Result<Url, EndpointError> {
    match catalog_url.map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw) => parse_http_url(raw),
        None => derive_catalog_url(base_url),
    }
}

/// Everything a request is made of. Two requests with the same
/// [`EndpointRequest::fingerprint`] get the same answer from the provider
/// (bar the `client_version`, which is kept apart).
#[derive(Clone)]
pub struct EndpointRequest {
    /// The list URL with the provider's `query_params`, without
    /// `client_version`.
    url: Url,
    /// The provider's static `http_headers`, sorted by lower-cased name.
    headers: Vec<(String, String)>,
    api_key: String,
}

impl std::fmt::Debug for EndpointRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EndpointRequest")
            .field("url", &self.url.as_str())
            .field("headers", &self.headers.len())
            .finish_non_exhaustive()
    }
}

impl EndpointRequest {
    pub fn new(
        base_url: &str,
        catalog_url: Option<&str>,
        query_params: &[(String, String)],
        headers: &[(String, String)],
        api_key: &str,
    ) -> Result<Self, EndpointError> {
        let mut url = resolve_catalog_url(base_url, catalog_url)?;
        if !query_params.is_empty() {
            let mut pairs = url.query_pairs_mut();
            for (k, v) in query_params {
                pairs.append_pair(k, v);
            }
        }
        let key = api_key.trim();
        if key.is_empty() {
            return Err(EndpointError::new(
                "missing_api_key",
                "an API key is required to fetch the model list",
            ));
        }
        let mut headers: Vec<(String, String)> = headers
            .iter()
            .filter(|(name, _)| !name.trim().is_empty())
            .map(|(n, v)| (n.trim().to_string(), v.clone()))
            .collect();
        headers.sort_by_key(|(n, _)| n.to_ascii_lowercase());
        Ok(Self {
            url,
            headers,
            api_key: key.to_string(),
        })
    }

    /// The list URL (with the provider's query parameters), as shown and as
    /// the cache files it.
    pub fn url(&self) -> &str {
        self.url.as_str()
    }

    pub fn host(&self) -> String {
        self.url.host_str().unwrap_or_default().to_string()
    }

    /// Identity of the request: URL, header names and value digests, key
    /// digest. Never contains a secret.
    pub fn fingerprint(&self) -> String {
        let mut input = String::from("codeg-codex-catalog-request/v1\n");
        input.push_str(self.url.as_str());
        input.push('\n');
        for (name, value) in &self.headers {
            input.push_str(&name.to_ascii_lowercase());
            input.push('=');
            input.push_str(&sha256_hex(value.as_bytes()));
            input.push('\n');
        }
        input.push_str("key=");
        input.push_str(&sha256_hex(self.api_key.as_bytes()));
        sha256_hex(input.as_bytes())
    }

    /// A short digest of the key, telling two keys apart without holding one.
    pub fn key_digest(&self) -> String {
        sha256_hex(format!("codeg-codex-key/{}", self.api_key).as_bytes())[..12].to_string()
    }

    /// Remove every copy of the key from text about to be shown or stored —
    /// whatever its length: a short key garbles a few letters at worst.
    #[cfg(test)]
    fn scrub(&self, text: &str) -> String {
        provider_models::scrub(text, &self.api_key)
    }
}

/// One id of an OpenAI-style list, with the context length when the
/// provider says (OpenRouter's `context_length`, vLLM's `max_model_len`, …).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiModelId {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
}

/// What a provider answered, by shape.
#[derive(Debug, Clone, PartialEq)]
pub enum EndpointPayload {
    Native(Vec<Value>),
    OpenAiList(Vec<OpenAiModelId>),
}

impl EndpointPayload {
    pub fn format(&self) -> CatalogFormat {
        match self {
            EndpointPayload::Native(_) => CatalogFormat::Native,
            EndpointPayload::OpenAiList(_) => CatalogFormat::OpenaiList,
        }
    }

    /// Hash of the content alone, so a re-fetch of an unchanged list is
    /// recognized whatever the request looked like.
    pub fn content_hash(&self) -> String {
        let value = match self {
            EndpointPayload::Native(models) => Value::Array(models.clone()),
            EndpointPayload::OpenAiList(ids) => serde_json::to_value(ids).unwrap_or(Value::Null),
        };
        sha256_hex(serde_json::to_string(&value).unwrap_or_default().as_bytes())
    }

    /// The slugs or ids, in the provider's order.
    pub fn names(&self) -> Vec<String> {
        match self {
            EndpointPayload::Native(models) => models
                .iter()
                .filter_map(|m| m.get("slug").and_then(Value::as_str))
                .map(str::to_string)
                .collect(),
            EndpointPayload::OpenAiList(ids) => ids.iter().map(|m| m.id.clone()).collect(),
        }
    }
}

/// A successful fetch.
#[derive(Debug, Clone)]
pub struct FetchOutcome {
    pub payload: EndpointPayload,
    pub bytes: usize,
    pub elapsed_ms: u64,
    pub started_at: DateTime<Utc>,
    pub fetched_at: DateTime<Utc>,
}

/// GET the list: with Bearer auth and the provider's own headers, through
/// [`provider_models::get_json`].
pub async fn fetch(
    request: &EndpointRequest,
    client_version: &str,
) -> Result<FetchOutcome, EndpointError> {
    let mut url = request.url.clone();
    url.query_pairs_mut()
        .append_pair("client_version", client_version);
    let mut headers = vec![(
        "Authorization".to_string(),
        format!("Bearer {}", request.api_key),
    )];
    headers.extend(request.headers.iter().cloned());
    let reply = provider_models::get_json(&url, &headers, &request.api_key).await?;
    let payload = classify(&reply.value)?;
    Ok(FetchOutcome {
        payload,
        bytes: reply.bytes,
        elapsed_ms: reply.elapsed_ms,
        started_at: reply.started_at,
        fetched_at: reply.fetched_at,
    })
}

/// Tell the two shapes apart. Extra keys are fine (new-api adds
/// `success`); anything else is `unrecognized_shape`.
pub fn classify(value: &Value) -> Result<EndpointPayload, EndpointError> {
    if let Some(models) = value.get("models").and_then(Value::as_array) {
        if models
            .iter()
            .all(|m| m.get("slug").is_some_and(Value::is_string))
        {
            return Ok(EndpointPayload::Native(models.clone()));
        }
    }
    if let Some(data) = value.get("data").and_then(Value::as_array) {
        if data
            .iter()
            .all(|m| m.get("id").is_some_and(Value::is_string))
        {
            let mut seen = HashSet::new();
            let ids = data
                .iter()
                .filter_map(|m| {
                    let id = m.get("id")?.as_str()?.trim();
                    if id.is_empty() || !seen.insert(id.to_string()) {
                        return None;
                    }
                    Some(OpenAiModelId {
                        id: id.to_string(),
                        context_window: context_window_of(m),
                    })
                })
                .collect();
            return Ok(EndpointPayload::OpenAiList(ids));
        }
    }
    Err(EndpointError::new(
        "unrecognized_shape",
        "the provider's answer is neither a Codex catalog nor an OpenAI model list",
    ))
}

fn context_window_of(entry: &Value) -> Option<u64> {
    [
        "context_window",
        "context_length",
        "max_context_length",
        "max_model_len",
    ]
    .iter()
    .find_map(|key| entry.get(*key).and_then(Value::as_u64))
    .filter(|n| *n > 0)
}

/// What the URL loader alone checks and a static file does not: slugs that
/// are present and unique. codeg keeps the rule so a list a provider would
/// break codex's own URL path with is not quietly accepted here.
pub fn validate_native(models: &[Value]) -> Result<(), EndpointError> {
    let mut seen = HashSet::new();
    let mut dups = Vec::new();
    for m in models {
        let slug = m
            .get("slug")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        if slug.is_empty() {
            return Err(EndpointError::new(
                "unrecognized_shape",
                "an entry of the provider's catalog has an empty slug",
            ));
        }
        if !seen.insert(slug.to_string()) {
            dups.push(slug.to_string());
        }
    }
    if dups.is_empty() {
        return Ok(());
    }
    dups.sort();
    dups.dedup();
    Err(EndpointError::new(
        "duplicate_slugs",
        format!("the provider's catalog repeats {}", dups.join(", ")),
    )
    .with_param("slugs", dups.join(", ")))
}

/// A provider-listed entry is one it serves through the API: the key codeg
/// configures is the provider's own, so `supported_in_api: false` (which the
/// picker filters out under API-key auth) would only hide what the provider
/// just offered. Hidden entries stay as they are.
pub fn normalize_native(models: &[Value]) -> Vec<Value> {
    models
        .iter()
        .map(|m| {
            let mut m = m.clone();
            if let Some(obj) = m.as_object_mut() {
                if obj.get("visibility").and_then(Value::as_str) == Some("list") {
                    obj.insert("supported_in_api".into(), Value::Bool(true));
                }
                if let Some(slug) = obj.get("slug").and_then(Value::as_str) {
                    let trimmed = slug.trim().to_string();
                    obj.insert("slug".into(), Value::String(trimmed));
                }
            }
            m
        })
        .collect()
}

/// Which metadata a synthesized entry carries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SynthTemplate {
    /// The id is an official slug: the official entry itself.
    Official { slug: String },
    /// Cloned from the official codex's own longest-prefix rule would pick.
    Prefix { slug: String },
    /// No official matched: the generic compatible template.
    Compat { slug: String },
}

fn find_by_longest_prefix<'a>(id: &str, officials: &'a [Value]) -> Option<&'a Value> {
    let mut best: Option<(&'a Value, usize)> = None;
    for candidate in officials {
        let Some(slug) = candidate.get("slug").and_then(Value::as_str) else {
            continue;
        };
        if !id.starts_with(slug) {
            continue;
        }
        if best.is_none_or(|(_, len)| slug.len() > len) {
            best = Some((candidate, slug.len()));
        }
    }
    best.map(|(m, _)| m)
}

/// codex's `find_model_by_namespaced_suffix`: strip ONE leading namespace
/// that looks like a provider id (`custom/gpt-5.3-codex`), then match again.
fn find_by_namespaced_suffix<'a>(id: &str, officials: &'a [Value]) -> Option<&'a Value> {
    let (namespace, suffix) = id.split_once('/')?;
    if suffix.contains('/')
        || namespace.is_empty()
        || !namespace
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return None;
    }
    find_by_longest_prefix(suffix, officials)
}

/// The template an id would be built from, matched the way codex matches a
/// model it has no catalog entry for (`construct_model_info_from_candidates`).
pub fn template_for(id: &str, officials: &[Value]) -> Option<SynthTemplate> {
    if officials
        .iter()
        .any(|m| m.get("slug").and_then(Value::as_str) == Some(id))
    {
        return Some(SynthTemplate::Official {
            slug: id.to_string(),
        });
    }
    if let Some(m) =
        find_by_longest_prefix(id, officials).or_else(|| find_by_namespaced_suffix(id, officials))
    {
        let slug = m.get("slug")?.as_str()?.to_string();
        return Some(SynthTemplate::Prefix { slug });
    }
    codex_model_catalog::fallback_base_slug(officials).map(|slug| SynthTemplate::Compat { slug })
}

/// Build catalog entries for the ids the user picked from an OpenAI list.
///
/// Each id becomes a first-class entry (`visibility: "list"`,
/// `supported_in_api: true`, no `upgrade` offer) cloned from
/// [`template_for`]'s match in `officials` — the runtime's official catalog,
/// so a codex upgrade that ships new fields reaches these entries on the next
/// rebuild. `seen` carries what the provider said about each id (its
/// context length); an id it no longer returns keeps what was last seen.
pub fn synthesize_openai_entries(
    selected: &[String],
    seen: &HashMap<String, OpenAiModelId>,
    officials: &[Value],
) -> Vec<Value> {
    let mut out = Vec::new();
    let mut done = HashSet::new();
    for id in selected {
        let id = id.trim();
        if id.is_empty() || !done.insert(id.to_string()) {
            continue;
        }
        let Some(template) = template_for(id, officials) else {
            continue;
        };
        let (base_slug, compat, official) = match &template {
            SynthTemplate::Official { slug } => (slug, false, true),
            SynthTemplate::Prefix { slug } => (slug, false, false),
            SynthTemplate::Compat { slug } => (slug, true, false),
        };
        let Some(base) = officials
            .iter()
            .find(|m| m.get("slug").and_then(Value::as_str) == Some(base_slug.as_str()))
            .and_then(Value::as_object)
        else {
            continue;
        };
        let mut obj: Map<String, Value> = base.clone();
        if compat {
            for (k, v) in COMPAT_OVERRIDES {
                obj.insert((*k).to_string(), v.clone());
            }
        }
        obj.insert("slug".into(), Value::String(id.to_string()));
        if !official {
            obj.insert("display_name".into(), Value::String(id.to_string()));
        }
        if let Some(cw) = seen.get(id).and_then(|m| m.context_window) {
            obj.insert("context_window".into(), Value::from(cw));
            let max = obj
                .get("max_context_window")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                .max(cw);
            obj.insert("max_context_window".into(), Value::from(max));
        }
        obj.insert("visibility".into(), Value::String("list".into()));
        obj.insert("supported_in_api".into(), Value::Bool(true));
        obj.insert("upgrade".into(), Value::Null);
        out.push(Value::Object(obj));
    }
    out
}

/// Entry counts the settings page shows: everything, the listed ones, and
/// the ones the picker keeps under API-key auth (`list` AND
/// `supported_in_api`) — the rule codeg's providers actually live under.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogCounts {
    pub total: usize,
    pub listed: usize,
    pub usable: usize,
}

pub fn counts(models: &[Value]) -> CatalogCounts {
    let listed = |m: &&Value| m.get("visibility").and_then(Value::as_str) == Some("list");
    CatalogCounts {
        total: models.len(),
        listed: models.iter().filter(listed).count(),
        usable: models
            .iter()
            .filter(listed)
            .filter(|m| m.get("supported_in_api").and_then(Value::as_bool) == Some(true))
            .count(),
    }
}

/// What changed between two fetches of the same list.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogDiff {
    pub added: Vec<String>,
    pub removed: Vec<String>,
}

impl CatalogDiff {
    pub fn between(previous: &[String], current: &[String]) -> Self {
        let before: HashSet<&String> = previous.iter().collect();
        let after: HashSet<&String> = current.iter().collect();
        Self {
            added: current
                .iter()
                .filter(|n| !before.contains(n))
                .cloned()
                .collect(),
            removed: previous
                .iter()
                .filter(|n| !after.contains(n))
                .cloned()
                .collect(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.added.is_empty() && self.removed.is_empty()
    }
}

// ─── Fetch cache ────────────────────────────────────────────────────────

/// One fetched list as cached and as published (`codeg-model-catalog.upstream.json`
/// holds the same shape). Carries no secret: the request is a fingerprint and
/// a key digest.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointSnapshot {
    pub url: String,
    pub request_fingerprint: String,
    pub key_digest: String,
    /// The `CODEX_HOME` request counter value this fetch took. Orders
    /// snapshots by when their request was ISSUED, independent of the clock.
    pub request_seq: u64,
    pub request_started_at: DateTime<Utc>,
    pub fetched_at: DateTime<Utc>,
    pub client_version: String,
    pub client_version_confirmed: bool,
    pub format: CatalogFormat,
    pub bytes: usize,
    pub elapsed_ms: u64,
    pub content_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub models: Option<Vec<Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ids: Option<Vec<OpenAiModelId>>,
    /// For an OpenAI list: the last metadata seen for ids the user picked,
    /// kept so an id the provider stops returning can still be built.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub last_seen: BTreeMap<String, OpenAiModelId>,
    #[serde(default)]
    pub diff: CatalogDiff,
}

impl EndpointSnapshot {
    pub fn payload(&self) -> Option<EndpointPayload> {
        match self.format {
            CatalogFormat::Native => self.models.clone().map(EndpointPayload::Native),
            CatalogFormat::OpenaiList => self.ids.clone().map(EndpointPayload::OpenAiList),
        }
    }

    pub fn names(&self) -> Vec<String> {
        self.payload().map(|p| p.names()).unwrap_or_default()
    }

    /// Ids with what is known about each: the current answer first, then
    /// what was last seen.
    pub fn seen_ids(&self) -> HashMap<String, OpenAiModelId> {
        let mut out: HashMap<String, OpenAiModelId> = self
            .last_seen
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        for m in self.ids.iter().flatten() {
            out.insert(m.id.clone(), m.clone());
        }
        out
    }
}

/// Assemble the snapshot of one fetch.
#[allow(clippy::too_many_arguments)]
pub fn snapshot_of(
    request: &EndpointRequest,
    seq: u64,
    client_version: &str,
    client_version_confirmed: bool,
    outcome: &FetchOutcome,
    previous_last_seen: &BTreeMap<String, OpenAiModelId>,
    selected: &[String],
) -> EndpointSnapshot {
    let (models, ids) = match &outcome.payload {
        EndpointPayload::Native(m) => (Some(m.clone()), None),
        EndpointPayload::OpenAiList(i) => (None, Some(i.clone())),
    };
    let mut last_seen = BTreeMap::new();
    if let Some(ids) = &ids {
        let current: HashMap<&str, &OpenAiModelId> =
            ids.iter().map(|m| (m.id.as_str(), m)).collect();
        for id in selected {
            if let Some(m) = current.get(id.as_str()) {
                last_seen.insert(id.clone(), (*m).clone());
            } else if let Some(m) = previous_last_seen.get(id) {
                last_seen.insert(id.clone(), m.clone());
            }
        }
    }
    EndpointSnapshot {
        url: request.url().to_string(),
        request_fingerprint: request.fingerprint(),
        key_digest: request.key_digest(),
        request_seq: seq,
        request_started_at: outcome.started_at,
        fetched_at: outcome.fetched_at,
        client_version: client_version.to_string(),
        client_version_confirmed,
        format: outcome.payload.format(),
        bytes: outcome.bytes,
        elapsed_ms: outcome.elapsed_ms,
        content_hash: outcome.payload.content_hash(),
        models,
        ids,
        last_seen,
        diff: CatalogDiff::default(),
    }
}

fn cache_root() -> PathBuf {
    crate::paths::codeg_home_dir()
        .join("cache")
        .join("codex")
        .join("endpoint-catalogs")
}

fn normalized_home(codex_home: &Path) -> String {
    std::fs::canonicalize(codex_home)
        .unwrap_or_else(|_| codex_home.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

/// `<root>/<sha(CODEX_HOME)>/<sha(url)>` — one directory per list URL, inside
/// one per `CODEX_HOME`, so every sequence number compared within a
/// directory came from the same counter.
fn cache_dir_for(root: &Path, codex_home: &Path, url: &str) -> PathBuf {
    root.join(&sha256_hex(normalized_home(codex_home).as_bytes())[..32])
        .join(&sha256_hex(url.as_bytes())[..32])
}

fn cache_file_name(fingerprint: &str, client_version: &str, format: CatalogFormat) -> String {
    let id = sha256_hex(format!("{fingerprint}\n{client_version}").as_bytes());
    format!("{}.{}.json", &id[..32], format.as_str())
}

/// The cache, rooted at `~/.codeg/cache/codex/endpoint-catalogs` (or a test's
/// own directory).
#[derive(Debug, Clone)]
pub struct EndpointCache {
    root: PathBuf,
}

impl Default for EndpointCache {
    fn default() -> Self {
        Self { root: cache_root() }
    }
}

impl EndpointCache {
    pub fn at(root: PathBuf) -> Self {
        Self { root }
    }

    /// Every cached snapshot for one URL, newest request first.
    pub fn for_url(&self, codex_home: &Path, url: &str) -> Vec<EndpointSnapshot> {
        let dir = cache_dir_for(&self.root, codex_home, url);
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return Vec::new();
        };
        let mut out: Vec<EndpointSnapshot> = entries
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
            .filter_map(|e| std::fs::read_to_string(e.path()).ok())
            .filter_map(|text| serde_json::from_str::<EndpointSnapshot>(&text).ok())
            .filter(|s| s.url == url)
            .collect();
        out.sort_by_key(|s| std::cmp::Reverse(s.request_seq));
        out
    }

    /// The cached snapshot for exactly this request, version and format.
    pub fn exact(
        &self,
        codex_home: &Path,
        request: &EndpointRequest,
        client_version: &str,
        format: Option<CatalogFormat>,
    ) -> Option<EndpointSnapshot> {
        self.for_url(codex_home, request.url())
            .into_iter()
            .find(|s| {
                s.request_fingerprint == request.fingerprint()
                    && s.client_version == client_version
                    && format.is_none_or(|f| s.format == f)
            })
    }

    /// Store a snapshot, filling in its diff against the newest earlier
    /// snapshot of the same URL and format. A snapshot already on disk for
    /// the same identity with a LATER request is left alone: a slow old
    /// request cannot overwrite a newer answer.
    pub fn store(&self, codex_home: &Path, snapshot: &mut EndpointSnapshot) -> std::io::Result<()> {
        // One store at a time in this process, so the check against a later
        // request and the write it allows cannot interleave with another
        // store's. (Two processes can still race; the published upstream list,
        // not the cache, is what a publication relies on.)
        static STORES: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _one = STORES.lock().unwrap_or_else(|e| e.into_inner());
        let dir = cache_dir_for(&self.root, codex_home, &snapshot.url);
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(cache_file_name(
            &snapshot.request_fingerprint,
            &snapshot.client_version,
            snapshot.format,
        ));
        let earlier = self
            .for_url(codex_home, &snapshot.url)
            .into_iter()
            .filter(|s| s.format == snapshot.format && s.request_seq < snapshot.request_seq)
            .max_by_key(|s| s.request_seq);
        if let Some(prev) = &earlier {
            snapshot.diff = CatalogDiff::between(&prev.names(), &snapshot.names());
        }
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(existing) = serde_json::from_str::<EndpointSnapshot>(&text) {
                if existing.request_seq > snapshot.request_seq {
                    return Ok(());
                }
            }
        }
        let bytes = serde_json::to_vec(snapshot).map_err(std::io::Error::other)?;
        write_atomic(&path, &bytes)
    }
}

/// Same-directory temp file, fsync, rename.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let dir = path.parent().unwrap_or(Path::new("."));
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = dir.join(format!(".{name}.{}.tmp", uuid::Uuid::new_v4().simple()));
    let result = (|| {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// Remove cache directories nobody wrote to for a month.
pub fn sweep_cache() {
    let root = cache_root();
    let cutoff = std::time::SystemTime::now() - Duration::from_secs(30 * 24 * 60 * 60);
    let Ok(homes) = std::fs::read_dir(&root) else {
        return;
    };
    for home in homes.flatten() {
        let Ok(urls) = std::fs::read_dir(home.path()) else {
            continue;
        };
        for url_dir in urls.flatten() {
            let Ok(files) = std::fs::read_dir(url_dir.path()) else {
                continue;
            };
            for f in files.flatten() {
                let old = f
                    .metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .is_some_and(|m| m < cutoff);
                if old {
                    let _ = std::fs::remove_file(f.path());
                }
            }
            let _ = std::fs::remove_dir(url_dir.path());
        }
        let _ = std::fs::remove_dir(home.path());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::provider_models::MAX_RESPONSE_BYTES;
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn officials() -> Vec<Value> {
        codex_model_catalog::bundled_snapshot_models()
    }

    #[test]
    fn a_key_of_any_length_is_scrubbed() {
        let request = EndpointRequest::new("https://r/v1", None, &[], &[], "abc").unwrap();
        assert_eq!(request.scrub("bad key abc, abc!"), "bad key ***, ***!");
    }

    /// Stores racing in one process keep the answer to the latest request.
    #[test]
    fn concurrent_stores_keep_the_latest_request() {
        let dir = tempfile::tempdir().unwrap();
        let cache = EndpointCache::at(dir.path().join("cache"));
        let home = dir.path().join("home");
        let request = EndpointRequest::new("https://r/v1", None, &[], &[], "sk").unwrap();
        let outcome = FetchOutcome {
            payload: EndpointPayload::Native(vec![json!({"slug": "m", "visibility": "list"})]),
            bytes: 1,
            elapsed_ms: 1,
            started_at: Utc::now(),
            fetched_at: Utc::now(),
        };
        std::thread::scope(|scope| {
            for seq in (1..=24u64).rev() {
                let (cache, home, request, outcome) = (&cache, &home, &request, &outcome);
                scope.spawn(move || {
                    let mut snapshot = snapshot_of(
                        request,
                        seq,
                        "0.160.1",
                        true,
                        outcome,
                        &BTreeMap::new(),
                        &[],
                    );
                    cache.store(home, &mut snapshot).unwrap();
                });
            }
        });
        let kept = cache.exact(&home, &request, "0.160.1", None).unwrap();
        assert_eq!(kept.request_seq, 24);
    }

    #[test]
    fn derives_the_list_url_on_the_path() {
        let cases = [
            ("https://host/v1", "https://host/v1/models"),
            ("https://host/v1/", "https://host/v1/models"),
            (
                "https://host/v1?tenant=a",
                "https://host/v1/models?tenant=a",
            ),
            ("https://host/v1#frag", "https://host/v1/models"),
            ("http://127.0.0.1:8317", "http://127.0.0.1:8317/models"),
        ];
        for (base, want) in cases {
            assert_eq!(derive_catalog_url(base).unwrap().as_str(), want, "{base}");
        }
        assert_eq!(derive_catalog_url("").unwrap_err().code, "missing_base_url");
        assert_eq!(
            derive_catalog_url("ftp://x/v1").unwrap_err().code,
            "invalid_url"
        );
        assert_eq!(
            derive_catalog_url("not a url").unwrap_err().code,
            "invalid_url"
        );
        // The user's own URL wins, checked the same way.
        assert_eq!(
            resolve_catalog_url("https://a/v1", Some(" https://b/list#x "))
                .unwrap()
                .as_str(),
            "https://b/list"
        );
    }

    #[test]
    fn the_fingerprint_follows_the_request_but_holds_no_secret() {
        let req = |url: &str, key: &str, headers: &[(String, String)]| {
            EndpointRequest::new(url, None, &[], headers, key).unwrap()
        };
        let a = req("https://h/v1", "sk-one", &[]);
        assert_eq!(
            a.fingerprint(),
            req("https://h/v1/", "sk-one", &[]).fingerprint()
        );
        assert_ne!(
            a.fingerprint(),
            req("https://h/v1", "sk-two", &[]).fingerprint()
        );
        assert_ne!(
            a.fingerprint(),
            req("https://h/v2", "sk-one", &[]).fingerprint()
        );
        let h = [("X-Tenant".to_string(), "a".to_string())];
        assert_ne!(
            a.fingerprint(),
            req("https://h/v1", "sk-one", &h).fingerprint()
        );
        assert!(!a.fingerprint().contains("sk-one"));
        assert_ne!(
            a.key_digest(),
            req("https://h/v1", "sk-two", &[]).key_digest()
        );
        // Query parameters are part of the URL.
        let q = EndpointRequest::new(
            "https://h/v1",
            None,
            &[("api-version".into(), "2".into())],
            &[],
            "sk-one",
        )
        .unwrap();
        assert_eq!(q.url(), "https://h/v1/models?api-version=2");
        assert_ne!(q.fingerprint(), a.fingerprint());
        assert_eq!(
            EndpointRequest::new("https://h/v1", None, &[], &[], "  ")
                .unwrap_err()
                .code,
            "missing_api_key"
        );
    }

    #[test]
    fn classifies_native_openai_and_garbage() {
        let native = classify(&json!({"models":[{"slug":"a"},{"slug":"b"}]})).unwrap();
        assert_eq!(native.format(), CatalogFormat::Native);
        assert_eq!(native.names(), ["a", "b"]);
        // new-api's extra keys, OpenRouter's context length, duplicates folded.
        let list = classify(&json!({
            "success": true, "object": "list",
            "data": [
                {"id": "glm-5.2", "context_length": 131072},
                {"id": "kimi-k3"},
                {"id": "glm-5.2"}
            ]
        }))
        .unwrap();
        assert_eq!(
            list,
            EndpointPayload::OpenAiList(vec![
                OpenAiModelId {
                    id: "glm-5.2".into(),
                    context_window: Some(131072)
                },
                OpenAiModelId {
                    id: "kimi-k3".into(),
                    context_window: None
                },
            ])
        );
        for garbage in [
            json!({"nope":1}),
            json!([1, 2]),
            json!({"models":[{"id":"x"}]}),
        ] {
            assert_eq!(classify(&garbage).unwrap_err().code, "unrecognized_shape");
        }
    }

    #[test]
    fn native_slugs_must_be_present_and_unique() {
        assert!(validate_native(&[json!({"slug":"a"}), json!({"slug":"b"})]).is_ok());
        let err = validate_native(&[json!({"slug":"a"}), json!({"slug":" a "})]).unwrap_err();
        assert_eq!(err.code, "duplicate_slugs");
        assert_eq!(err.params["slugs"], "a");
        assert_eq!(
            validate_native(&[json!({"slug":" "})]).unwrap_err().code,
            "unrecognized_shape"
        );
    }

    #[test]
    fn listed_native_entries_become_api_usable_and_hidden_stay_hidden() {
        let out = normalize_native(&[
            json!({"slug":"a","visibility":"list","supported_in_api":false}),
            json!({"slug":"b","visibility":"hide","supported_in_api":false}),
        ]);
        assert_eq!(out[0]["supported_in_api"], json!(true));
        assert_eq!(out[1]["supported_in_api"], json!(false));
        let c = counts(&out);
        assert_eq!((c.total, c.listed, c.usable), (2, 1, 1));
    }

    #[test]
    fn synthesized_entries_clone_the_closest_official() {
        let official = officials();
        let seen: HashMap<String, OpenAiModelId> = [(
            "glm-5.2".to_string(),
            OpenAiModelId {
                id: "glm-5.2".into(),
                context_window: Some(131072),
            },
        )]
        .into();
        let picked = [
            "gpt-6.1-sol".to_string(),
            "gpt-6.1-sol-2026-10-01".to_string(),
            "openrouter/gpt-6-luna".to_string(),
            "glm-5.2".to_string(),
            "glm-5.2".to_string(),
        ];
        let out = synthesize_openai_entries(&picked, &seen, &official);
        assert_eq!(out.len(), 4, "duplicates folded");
        for m in &out {
            assert_eq!(m["visibility"], "list");
            assert_eq!(m["supported_in_api"], json!(true));
            assert_eq!(m["upgrade"], Value::Null);
        }
        // An exact official keeps its own name.
        let exact = official
            .iter()
            .find(|m| m["slug"] == "gpt-6.1-sol")
            .unwrap();
        assert_eq!(out[0]["display_name"], exact["display_name"]);
        assert!(matches!(
            template_for("gpt-6.1-sol-2026-10-01", &official),
            Some(SynthTemplate::Prefix { slug }) if slug == "gpt-6.1-sol"
        ));
        assert_eq!(out[1]["display_name"], "gpt-6.1-sol-2026-10-01");
        assert!(matches!(
            template_for("openrouter/gpt-6-luna", &official),
            Some(SynthTemplate::Prefix { slug }) if slug == "gpt-6-luna"
        ));
        // Two namespaces deep is not stripped (codex's own rule).
        assert!(matches!(
            template_for("a/b/gpt-6-luna", &official),
            Some(SynthTemplate::Compat { .. })
        ));
        // No match: the compatible template, with the provider's context length.
        let glm = &out[3];
        assert_eq!(glm["slug"], "glm-5.2");
        assert_eq!(glm["tool_mode"], Value::Null);
        assert_eq!(glm["use_responses_lite"], json!(false));
        assert_eq!(glm["context_window"], json!(131072));
        assert!(glm["max_context_window"].as_u64().unwrap() >= 131072);
        assert!(glm.get("base_instructions").is_some());
    }

    #[test]
    fn diff_lists_what_appeared_and_disappeared() {
        let d = CatalogDiff::between(
            &["a".into(), "b".into()],
            &["b".into(), "c".into(), "d".into()],
        );
        assert_eq!(d.added, ["c", "d"]);
        assert_eq!(d.removed, ["a"]);
        assert!(CatalogDiff::between(&["a".into()], &["a".into()]).is_empty());
    }

    fn snapshot(req: &EndpointRequest, seq: u64, version: &str, ids: &[&str]) -> EndpointSnapshot {
        let outcome = FetchOutcome {
            payload: EndpointPayload::OpenAiList(
                ids.iter()
                    .map(|i| OpenAiModelId {
                        id: (*i).into(),
                        context_window: None,
                    })
                    .collect(),
            ),
            bytes: 10,
            elapsed_ms: 1,
            started_at: Utc::now(),
            fetched_at: Utc::now(),
        };
        snapshot_of(req, seq, version, true, &outcome, &BTreeMap::new(), &[])
    }

    #[test]
    fn the_cache_keeps_the_later_request_and_separates_homes() {
        let dir = tempfile::tempdir().unwrap();
        let cache = EndpointCache::at(dir.path().join("cache"));
        let home_a = dir.path().join("a");
        let home_b = dir.path().join("b");
        let req = EndpointRequest::new("https://h/v1", None, &[], &[], "sk-1").unwrap();

        let mut newer = snapshot(&req, 7, "0.160.1", &["x", "y"]);
        cache.store(&home_a, &mut newer).unwrap();
        // A slower request issued earlier lands afterwards: ignored.
        let mut older = snapshot(&req, 5, "0.160.1", &["x"]);
        cache.store(&home_a, &mut older).unwrap();
        let hit = cache.exact(&home_a, &req, "0.160.1", None).unwrap();
        assert_eq!(hit.request_seq, 7);
        assert_eq!(hit.names(), ["x", "y"]);

        // Another CODEX_HOME's counter is a different sequence entirely.
        let mut other = snapshot(&req, 1, "0.160.1", &["z"]);
        cache.store(&home_b, &mut other).unwrap();
        assert_eq!(
            cache
                .exact(&home_a, &req, "0.160.1", None)
                .unwrap()
                .request_seq,
            7
        );
        assert_eq!(
            cache.exact(&home_b, &req, "0.160.1", None).unwrap().names(),
            ["z"]
        );

        // A later fetch with another version records the diff.
        let mut next = snapshot(&req, 9, "0.161.0", &["y", "w"]);
        cache.store(&home_a, &mut next).unwrap();
        let stored = cache.exact(&home_a, &req, "0.161.0", None).unwrap();
        assert_eq!(stored.diff.added, ["w"]);
        assert_eq!(stored.diff.removed, ["x"]);
        assert_eq!(cache.for_url(&home_a, req.url()).len(), 2);
        // Asking for another format misses.
        assert!(cache
            .exact(&home_a, &req, "0.161.0", Some(CatalogFormat::Native))
            .is_none());
    }

    #[test]
    fn last_seen_keeps_picked_ids_the_provider_dropped() {
        let req = EndpointRequest::new("https://h/v1", None, &[], &[], "sk-1").unwrap();
        let outcome = FetchOutcome {
            payload: EndpointPayload::OpenAiList(vec![OpenAiModelId {
                id: "a".into(),
                context_window: Some(1000),
            }]),
            bytes: 1,
            elapsed_ms: 1,
            started_at: Utc::now(),
            fetched_at: Utc::now(),
        };
        let previous: BTreeMap<String, OpenAiModelId> = [(
            "gone".to_string(),
            OpenAiModelId {
                id: "gone".into(),
                context_window: Some(500),
            },
        )]
        .into();
        let s = snapshot_of(
            &req,
            1,
            "0.160.1",
            true,
            &outcome,
            &previous,
            &["a".into(), "gone".into(), "never".into()],
        );
        assert_eq!(s.last_seen.len(), 2);
        assert_eq!(s.last_seen["gone"].context_window, Some(500));
        assert_eq!(s.seen_ids()["a"].context_window, Some(1000));
    }

    /// A one-shot HTTP server on loopback answering `response` to the first
    /// request, and reporting the request it saw.
    async fn serve_once(response: Vec<u8>) -> (String, tokio::task::JoinHandle<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 8192];
            let n = sock.read(&mut buf).await.unwrap_or(0);
            let _ = sock.write_all(&response).await;
            let _ = sock.shutdown().await;
            String::from_utf8_lossy(&buf[..n]).into_owned()
        });
        (format!("http://{addr}/v1"), handle)
    }

    fn http(status: &str, extra: &str, body: &str) -> Vec<u8> {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n{body}",
            body.len()
        )
        .into_bytes()
    }

    #[tokio::test]
    async fn fetch_sends_what_codex_would_and_reads_a_native_catalog() {
        let (base, seen) = serve_once(http(
            "200 OK",
            "",
            r#"{"models":[{"slug":"m1","visibility":"list"}]}"#,
        ))
        .await;
        let req = EndpointRequest::new(
            &base,
            None,
            &[("tenant".into(), "a".into())],
            &[("X-Org".into(), "o1".into())],
            "sk-secret",
        )
        .unwrap();
        let out = fetch(&req, "0.160.1").await.unwrap();
        assert_eq!(out.payload.names(), ["m1"]);
        let raw = seen.await.unwrap();
        let first = raw.lines().next().unwrap();
        assert!(
            first.starts_with("GET /v1/models?tenant=a&client_version=0.160.1 "),
            "{first}"
        );
        let lower = raw.to_ascii_lowercase();
        assert!(lower.contains("authorization: bearer sk-secret"));
        assert!(lower.contains("x-org: o1"));
        assert!(lower.contains("accept: application/json"));
    }

    #[tokio::test]
    async fn fetch_maps_failures_to_codes_and_never_echoes_the_key() {
        let cases = [
            (
                http("401 Unauthorized", "", r#"{"error":"bad key sk-secret"}"#),
                "unauthorized",
            ),
            (http("404 Not Found", "", "{}"), "not_found"),
            (http("500 Internal Server Error", "", "boom"), "http_status"),
            (
                http("302 Found", "Location: https://evil.example/x\r\n", ""),
                "redirect",
            ),
            (http("200 OK", "", "<html>"), "not_json"),
            (
                http("200 OK", "", r#"{"weird":true}"#),
                "unrecognized_shape",
            ),
        ];
        for (response, code) in cases {
            let (base, seen) = serve_once(response).await;
            let req = EndpointRequest::new(&base, None, &[], &[], "sk-secret").unwrap();
            let err = fetch(&req, "0.160.1").await.unwrap_err();
            assert_eq!(err.code, code, "{err:?}");
            assert!(!err.message.contains("sk-secret"), "{err:?}");
            if code == "redirect" {
                assert_eq!(err.params["host"], "evil.example");
            }
            let _ = seen.await;
        }
    }

    #[tokio::test]
    async fn fetch_accepts_a_catalog_over_codexs_url_limit_but_not_a_huge_one() {
        // 1.2 MB: codex's URL loader would hang up, a static file is fine.
        let entry = format!(r#"{{"slug":"m","pad":"{}"}}"#, "x".repeat(1_200_000));
        let (base, seen) =
            serve_once(http("200 OK", "", &format!(r#"{{"models":[{entry}]}}"#))).await;
        let req = EndpointRequest::new(&base, None, &[], &[], "sk-1").unwrap();
        assert!(fetch(&req, "0.160.1").await.is_ok());
        let _ = seen.await;

        let huge = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            MAX_RESPONSE_BYTES + 1
        );
        let (base, seen) = serve_once(huge.into_bytes()).await;
        let req = EndpointRequest::new(&base, None, &[], &[], "sk-1").unwrap();
        assert_eq!(fetch(&req, "0.160.1").await.unwrap_err().code, "too_large");
        let _ = seen.await;
    }
}
