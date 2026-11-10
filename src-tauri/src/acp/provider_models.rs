//! Listing a provider's models, for the settings pages' "fetch models".
//!
//! An agent talks to its provider in one of three wire protocols, and the
//! list is asked for the way that protocol does it:
//! - OpenAI: `GET {base}/models`, Bearer, `data[].id`;
//! - Anthropic: `GET {base}/v1/models?limit=1000` — `{base}/models` when the
//!   base already ends in a version such as `/v1` — with `x-api-key` (or
//!   Bearer, for an agent that sends the key that way) and
//!   `anthropic-version`, paged by `has_more` / `last_id`;
//! - Gemini: `GET {base}/v1beta/models?pageSize=1000`, `x-goog-api-key`,
//!   `models[].name` without its `models/` prefix, paged by `nextPageToken`.
//!
//! Codex reads a whole catalog instead of ids; that is
//! [`crate::acp::codex_endpoint_catalog`], which shares [`get_json`] — no
//! redirects (the key would follow them), short timeouts, a size cap, error
//! bodies cut short and scrubbed of the key, and errors as stable codes the
//! pages localize.
//!
//! A base URL that serves no list (404 or 405) is retried at the places
//! relays commonly put it: `/v1/models` for an OpenAI base without a version,
//! and the host root for a base ending in an Anthropic-compatibility path such
//! as `/anthropic` or `/api/coding`. Any other error stops there.

use std::collections::{BTreeMap, HashSet};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(15);
/// The most one response may carry: far above any real list (OpenRouter's,
/// the largest seen, is about 2 MB); this only stops a misbehaving endpoint
/// from filling memory.
pub(crate) const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const ERROR_BODY_CHARS: usize = 512;
/// Pages followed for a paged list before giving up on the rest.
const MAX_PAGES: usize = 10;
const ANTHROPIC_VERSION: &str = "2023-06-01";

/// Path endings under which relays serve an Anthropic-compatible API, longest
/// first so `/api/anthropic` is not taken for `/anthropic`. The list itself is
/// usually at the host's root.
const COMPAT_SUFFIXES: &[&str] = &[
    "/api/claudecode",
    "/api/anthropic",
    "/apps/anthropic",
    "/api/coding",
    "/claudecode",
    "/anthropic",
    "/coding",
    "/claude",
];

/// Why fetching or checking a provider's list failed. `code` is stable and
/// is what the settings pages localize; `message` is the English fallback.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointError {
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub params: BTreeMap<String, String>,
}

impl EndpointError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            params: BTreeMap::new(),
        }
    }

    pub fn with_param(mut self, key: &str, value: impl Into<String>) -> Self {
        self.params.insert(key.to_string(), value.into());
        self
    }

    /// The command error, localized by the page under `<namespace>.<code>`.
    pub fn to_app_error(&self, namespace: &str) -> crate::app_error::AppCommandError {
        use crate::app_error::{AppCommandError, AppErrorCode};
        let code = match self.code {
            "unauthorized" => AppErrorCode::AuthenticationFailed,
            "missing_api_key" | "missing_base_url" | "invalid_url" => AppErrorCode::InvalidInput,
            "timeout" | "network" | "redirect" | "http_status" | "not_found" => {
                AppErrorCode::NetworkError
            }
            "codex_not_installed" => AppErrorCode::DependencyMissing,
            "lock_busy" | "repair_needed" | "io" => AppErrorCode::IoError,
            _ => AppErrorCode::ConfigurationInvalid,
        };
        AppCommandError::new(code, self.message.clone())
            .with_i18n(format!("{namespace}.{}", self.code), self.params.clone())
    }
}

impl std::fmt::Display for EndpointError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

fn invalid_url(raw: &str) -> EndpointError {
    EndpointError::new("invalid_url", format!("not an http(s) URL: {raw}")).with_param("url", raw)
}

/// An http(s) URL with a host, without its fragment.
pub(crate) fn parse_http_url(raw: &str) -> Result<Url, EndpointError> {
    let trimmed = raw.trim();
    let mut url = Url::parse(trimmed).map_err(|_| invalid_url(trimmed))?;
    if !matches!(url.scheme(), "http" | "https") || url.host().is_none() {
        return Err(invalid_url(trimmed));
    }
    url.set_fragment(None);
    Ok(url)
}

/// `url` with `suffix` joined onto its path (a trailing `/` dropped first);
/// the query is kept.
pub(crate) fn with_path_suffix(url: &Url, suffix: &str) -> Url {
    let mut out = url.clone();
    let path = url.path().trim_end_matches('/').to_string();
    out.set_path(&format!("{path}{suffix}"));
    out
}

fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

/// A JSON answer and what it took.
#[derive(Debug, Clone)]
pub(crate) struct JsonReply {
    pub value: Value,
    pub bytes: usize,
    pub elapsed_ms: u64,
    pub started_at: DateTime<Utc>,
    pub fetched_at: DateTime<Utc>,
}

/// Every copy of the key, whatever its length and in any letter case, out of
/// text about to be shown or stored: a URL's host comes back lowercased from
/// the parser, and the key in it with it. A short key garbles a few letters
/// at worst.
pub(crate) fn scrub(text: &str, secret: &str) -> String {
    if secret.is_empty() {
        return text.to_string();
    }
    // ASCII case folding keeps every byte where it was, so a match in the
    // folded text is the same span of the original.
    let folded = text.to_ascii_lowercase();
    let needle = secret.to_ascii_lowercase();
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for (at, _) in folded.match_indices(needle.as_str()) {
        out.push_str(&text[last..at]);
        out.push_str("***");
        last = at + needle.len();
    }
    out.push_str(&text[last..]);
    out
}

/// GET `url` and read a JSON answer. A fresh client per call, so the proxy
/// settings codeg keeps in its own environment apply as they are now; a
/// loopback endpoint skips the proxy, which would dial its own loopback.
/// Redirects are refused rather than followed, since the headers carry the
/// key. `secret` is scrubbed from every message.
pub(crate) async fn get_json(
    url: &Url,
    headers: &[(String, String)],
    secret: &str,
) -> Result<JsonReply, EndpointError> {
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(TOTAL_TIMEOUT)
        .user_agent(concat!("codeg/", env!("CARGO_PKG_VERSION")));
    if is_loopback(url) {
        builder = builder.no_proxy();
    }
    let client = builder
        .build()
        .map_err(|e| EndpointError::new("network", format!("HTTP client: {e}")))?;

    let mut get = client
        .get(url.clone())
        .header(reqwest::header::ACCEPT, "application/json");
    for (name, value) in headers {
        get = get.header(name.as_str(), value.as_str());
    }

    let started_at = clock::now();
    let started = Instant::now();
    let response = get.send().await.map_err(|e| request_error(secret, &e))?;
    let status = response.status();
    if status.is_redirection() {
        // The endpoint was just sent the key and picks this host: scrub it
        // like any other text it hands back.
        let host = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|loc| url.join(loc).ok())
            .and_then(|u| u.host_str().map(|host| scrub(host, secret)))
            .unwrap_or_default();
        return Err(EndpointError::new(
            "redirect",
            format!(
                "the list URL redirects (HTTP {}) to {host}",
                status.as_u16()
            ),
        )
        .with_param("status", status.as_u16().to_string())
        .with_param("host", host));
    }

    let body = read_capped(secret, response).await?;
    let elapsed_ms = started.elapsed().as_millis() as u64;
    if !status.is_success() {
        let snippet = error_snippet(secret, &body);
        let (code, label) = match status.as_u16() {
            401 | 403 => ("unauthorized", "the key was rejected"),
            404 => ("not_found", "this URL serves no model list"),
            _ => ("http_status", "the provider answered with an error"),
        };
        return Err(EndpointError::new(
            code,
            format!("{label} (HTTP {}): {snippet}", status.as_u16()),
        )
        .with_param("status", status.as_u16().to_string())
        .with_param("body", snippet));
    }
    let value: Value = serde_json::from_slice(&body).map_err(|_| {
        EndpointError::new(
            "not_json",
            format!(
                "the provider did not answer with JSON: {}",
                error_snippet(secret, &body)
            ),
        )
    })?;
    Ok(JsonReply {
        value,
        bytes: body.len(),
        elapsed_ms,
        started_at,
        fetched_at: clock::now(),
    })
}

fn request_error(secret: &str, e: &reqwest::Error) -> EndpointError {
    let detail = scrub(&e.to_string(), secret);
    if e.is_timeout() {
        EndpointError::new(
            "timeout",
            format!("the provider did not answer in time: {detail}"),
        )
    } else {
        EndpointError::new("network", format!("could not reach the provider: {detail}"))
            .with_param("detail", detail)
    }
}

async fn read_capped(secret: &str, response: reqwest::Response) -> Result<Vec<u8>, EndpointError> {
    if response
        .content_length()
        .is_some_and(|len| len as usize > MAX_RESPONSE_BYTES)
    {
        return Err(too_large());
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| request_error(secret, &e))?;
        if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(too_large());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn too_large() -> EndpointError {
    EndpointError::new(
        "too_large",
        format!(
            "the model list is larger than {} MiB",
            MAX_RESPONSE_BYTES / 1024 / 1024
        ),
    )
}

/// The first characters of a body, with the key removed, for an error message.
pub(crate) fn error_snippet(secret: &str, body: &[u8]) -> String {
    let text = String::from_utf8_lossy(body);
    let text = scrub(text.trim(), secret);
    let mut out: String = text.chars().take(ERROR_BODY_CHARS).collect();
    if text.chars().count() > ERROR_BODY_CHARS {
        out.push('…');
    }
    out
}

/// The wire protocol an agent speaks to its provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelsProtocol {
    Openai,
    Anthropic,
    Gemini,
}

/// How the key travels. Each protocol has its own default; an Anthropic agent
/// that sends the key as a Bearer token (Claude Code's
/// `ANTHROPIC_AUTH_TOKEN`) asks for [`KeyHeader::Bearer`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KeyHeader {
    Bearer,
    XApiKey,
    XGoogApiKey,
}

impl ModelsProtocol {
    fn default_key_header(self) -> KeyHeader {
        match self {
            ModelsProtocol::Openai => KeyHeader::Bearer,
            ModelsProtocol::Anthropic => KeyHeader::XApiKey,
            ModelsProtocol::Gemini => KeyHeader::XGoogApiKey,
        }
    }
}

/// One listed model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedModel {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
}

/// A provider's list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelList {
    /// The URL that answered, without its paging parameters.
    pub url: String,
    /// In the provider's order, each id once.
    pub models: Vec<ListedModel>,
}

/// What to ask and with which key.
#[derive(Clone)]
pub struct ModelsRequest {
    protocol: ModelsProtocol,
    base: Url,
    key_header: KeyHeader,
    api_key: String,
}

impl std::fmt::Debug for ModelsRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ModelsRequest")
            .field("protocol", &self.protocol)
            .field("base", &self.base.as_str())
            .field("key_header", &self.key_header)
            .finish_non_exhaustive()
    }
}

impl ModelsRequest {
    pub fn new(
        protocol: ModelsProtocol,
        base_url: &str,
        api_key: &str,
        key_header: Option<KeyHeader>,
    ) -> Result<Self, EndpointError> {
        if base_url.trim().is_empty() {
            return Err(EndpointError::new(
                "missing_base_url",
                "the provider has no base URL",
            ));
        }
        let base = parse_http_url(base_url)?;
        let key = api_key.trim();
        if key.is_empty() {
            return Err(EndpointError::new(
                "missing_api_key",
                "an API key is required to list the models",
            ));
        }
        Ok(Self {
            protocol,
            base,
            key_header: key_header.unwrap_or(protocol.default_key_header()),
            api_key: key.to_string(),
        })
    }

    /// The list URLs to try, in order; see the module notes.
    pub fn candidates(&self) -> Vec<Url> {
        let base = &self.base;
        let path = base.path().trim_end_matches('/');
        let versioned = ends_with_version(path);
        let mut out = Vec::new();
        match self.protocol {
            ModelsProtocol::Openai => {
                out.push(with_path_suffix(base, "/models"));
                if !versioned {
                    out.push(with_path_suffix(base, "/v1/models"));
                }
            }
            ModelsProtocol::Anthropic => {
                out.push(with_path_suffix(
                    base,
                    if versioned { "/models" } else { "/v1/models" },
                ));
            }
            ModelsProtocol::Gemini => {
                let mut root = base.clone();
                let trimmed = path
                    .strip_suffix("/v1beta")
                    .or_else(|| path.strip_suffix("/v1"))
                    .unwrap_or(path)
                    .to_string();
                root.set_path(&trimmed);
                out.push(with_path_suffix(&root, "/v1beta/models"));
            }
        }
        if self.protocol != ModelsProtocol::Gemini {
            if let Some(stripped) = COMPAT_SUFFIXES
                .iter()
                .find_map(|suffix| path.strip_suffix(suffix))
            {
                let mut root = base.clone();
                root.set_path(stripped);
                out.push(with_path_suffix(&root, "/v1/models"));
                out.push(with_path_suffix(&root, "/models"));
            }
        }
        let mut seen = HashSet::new();
        out.retain(|u| seen.insert(u.as_str().to_string()));
        out
    }

    fn headers(&self) -> Vec<(String, String)> {
        let mut headers = vec![match self.key_header {
            KeyHeader::Bearer => (
                "Authorization".to_string(),
                format!("Bearer {}", self.api_key),
            ),
            KeyHeader::XApiKey => ("x-api-key".to_string(), self.api_key.clone()),
            KeyHeader::XGoogApiKey => ("x-goog-api-key".to_string(), self.api_key.clone()),
        }];
        if self.protocol == ModelsProtocol::Anthropic {
            headers.push((
                "anthropic-version".to_string(),
                ANTHROPIC_VERSION.to_string(),
            ));
        }
        headers
    }
}

/// The last path segment is a version: `v1`, `v4` (Zhipu's
/// `/api/coding/paas/v4`).
fn ends_with_version(path: &str) -> bool {
    let last = path.rsplit('/').next().unwrap_or("");
    last.strip_prefix('v')
        .is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
}

/// The page parameters of a list request.
fn page_url(protocol: ModelsProtocol, url: &Url, cursor: Option<&str>) -> Url {
    let mut out = url.clone();
    {
        let mut pairs = out.query_pairs_mut();
        match protocol {
            ModelsProtocol::Openai => {}
            ModelsProtocol::Anthropic => {
                pairs.append_pair("limit", "1000");
                if let Some(cursor) = cursor {
                    pairs.append_pair("after_id", cursor);
                }
            }
            ModelsProtocol::Gemini => {
                pairs.append_pair("pageSize", "1000");
                if let Some(cursor) = cursor {
                    pairs.append_pair("pageToken", cursor);
                }
            }
        }
    }
    if out.query() == Some("") {
        out.set_query(None);
    }
    out
}

fn str_field<'a>(entry: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|k| entry.get(*k).and_then(Value::as_str))
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn context_window_of(entry: &Value) -> Option<u64> {
    [
        "context_window",
        "context_length",
        "max_context_length",
        "max_model_len",
        "inputTokenLimit",
    ]
    .iter()
    .find_map(|key| entry.get(*key).and_then(Value::as_u64))
    .filter(|n| *n > 0)
}

/// One page of any of the shapes a list comes in: `{data:[{id}]}` (OpenAI,
/// Anthropic), `{models:[{name:"models/…"}]}` (Gemini) or a Codex catalog
/// `{models:[{slug}]}`. Entries without an id are skipped; a Gemini model
/// that cannot generate content (an embedding model) is left out.
fn parse_page(value: &Value) -> Result<Vec<ListedModel>, EndpointError> {
    let entries = value
        .get("data")
        .and_then(Value::as_array)
        .or_else(|| value.get("models").and_then(Value::as_array))
        .ok_or_else(|| {
            EndpointError::new(
                "unrecognized_shape",
                "the provider's answer is not a model list",
            )
        })?;
    Ok(entries
        .iter()
        .filter(|entry| {
            entry
                .get("supportedGenerationMethods")
                .and_then(Value::as_array)
                .is_none_or(|methods| {
                    methods
                        .iter()
                        .any(|m| m.as_str() == Some("generateContent"))
                })
        })
        .filter_map(|entry| {
            let id = str_field(entry, &["id", "slug"]).or_else(|| {
                let name = str_field(entry, &["name"])?;
                Some(name.strip_prefix("models/").unwrap_or(name))
            })?;
            let display_name = str_field(entry, &["display_name", "displayName"])
                .filter(|name| *name != id)
                .map(str::to_string);
            Some(ListedModel {
                id: id.to_string(),
                display_name,
                context_window: context_window_of(entry),
            })
        })
        .collect())
}

/// The cursor of the next page, if the answer says there is one.
fn next_cursor(protocol: ModelsProtocol, value: &Value) -> Option<String> {
    let cursor = match protocol {
        ModelsProtocol::Openai => None,
        ModelsProtocol::Anthropic => value
            .get("has_more")
            .and_then(Value::as_bool)
            .filter(|more| *more)
            .and_then(|_| value.get("last_id").and_then(Value::as_str)),
        ModelsProtocol::Gemini => value.get("nextPageToken").and_then(Value::as_str),
    };
    cursor
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .map(str::to_string)
}

/// Every page of the list at `url`.
async fn list_at(request: &ModelsRequest, url: &Url) -> Result<Vec<ListedModel>, EndpointError> {
    let headers = request.headers();
    let mut models = Vec::new();
    let mut seen_cursors = HashSet::new();
    let mut cursor: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let page = page_url(request.protocol, url, cursor.as_deref());
        let reply = get_json(&page, &headers, &request.api_key).await?;
        models.extend(parse_page(&reply.value)?);
        match next_cursor(request.protocol, &reply.value) {
            Some(next) if seen_cursors.insert(next.clone()) => cursor = Some(next),
            _ => break,
        }
    }
    let mut seen = HashSet::new();
    models.retain(|m| seen.insert(m.id.clone()));
    Ok(models)
}

/// List the provider's models: the first candidate URL that serves a list
/// answers; one that does not (404 or 405) hands over to the next.
pub async fn list_models(request: &ModelsRequest) -> Result<ModelList, EndpointError> {
    let candidates = request.candidates();
    let mut first_miss: Option<EndpointError> = None;
    for url in &candidates {
        match list_at(request, url).await {
            Ok(models) => {
                return Ok(ModelList {
                    url: url.to_string(),
                    models,
                })
            }
            Err(e) if is_miss(&e) => {
                first_miss.get_or_insert(e);
            }
            Err(e) => return Err(e),
        }
    }
    let tried: Vec<&str> = candidates.iter().map(Url::as_str).collect();
    let miss = first_miss.unwrap_or_else(|| EndpointError::new("not_found", "no list URL"));
    Err(EndpointError::new(
        "not_found",
        format!(
            "no model list at {} ({})",
            tried.join(", "),
            miss.message
        ),
    )
    .with_param("status", miss.params.get("status").cloned().unwrap_or_default())
    .with_param("url", tried.first().copied().unwrap_or_default()))
}

fn is_miss(e: &EndpointError) -> bool {
    e.code == "not_found" || (e.code == "http_status" && e.params.get("status").is_some_and(|s| s == "405"))
}

/// The time the provider-list code goes by — when a list was fetched, and
/// for the Codex catalog when it is due again: the wall clock, or under test
/// the thread's stand-in.
pub(crate) mod clock {
    use chrono::{DateTime, Utc};

    pub fn now() -> DateTime<Utc> {
        #[cfg(test)]
        if let Some(t) = NOW.with(std::cell::Cell::get) {
            return t;
        }
        Utc::now()
    }

    #[cfg(test)]
    thread_local! {
        static NOW: std::cell::Cell<Option<DateTime<Utc>>> = const { std::cell::Cell::new(None) };
    }

    /// Stop this thread's clock at `t` (`None`: the wall clock again).
    #[cfg(test)]
    pub fn set(t: Option<DateTime<Utc>>) {
        NOW.with(|now| now.set(t));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn request(protocol: ModelsProtocol, base: &str) -> ModelsRequest {
        ModelsRequest::new(protocol, base, "sk-secret", None).unwrap()
    }

    fn urls(protocol: ModelsProtocol, base: &str) -> Vec<String> {
        request(protocol, base)
            .candidates()
            .iter()
            .map(|u| u.to_string())
            .collect()
    }

    #[test]
    fn each_protocol_asks_where_its_list_lives() {
        use ModelsProtocol::*;
        assert_eq!(
            urls(Openai, "https://api.openai.com/v1/"),
            ["https://api.openai.com/v1/models"]
        );
        assert_eq!(
            urls(Openai, "https://api.deepseek.com"),
            [
                "https://api.deepseek.com/models",
                "https://api.deepseek.com/v1/models"
            ]
        );
        // The version may be any number, and the query stays.
        assert_eq!(
            urls(Openai, "https://open.bigmodel.cn/api/coding/paas/v4?x=1"),
            ["https://open.bigmodel.cn/api/coding/paas/v4/models?x=1"]
        );
        assert_eq!(
            urls(Anthropic, "https://api.anthropic.com"),
            ["https://api.anthropic.com/v1/models"]
        );
        assert_eq!(
            urls(Anthropic, "https://relay.example/v1"),
            ["https://relay.example/v1/models"]
        );
        // An Anthropic-compatibility path: the list is usually at the root.
        assert_eq!(
            urls(Anthropic, "https://open.bigmodel.cn/api/anthropic"),
            [
                "https://open.bigmodel.cn/api/anthropic/v1/models",
                "https://open.bigmodel.cn/v1/models",
                "https://open.bigmodel.cn/models"
            ]
        );
        for base in [
            "https://generativelanguage.googleapis.com",
            "https://generativelanguage.googleapis.com/v1beta/",
            "https://generativelanguage.googleapis.com/v1",
        ] {
            assert_eq!(
                urls(Gemini, base),
                ["https://generativelanguage.googleapis.com/v1beta/models"],
                "{base}"
            );
        }
    }

    #[test]
    fn a_request_needs_a_url_and_a_key() {
        let err = |base: &str, key: &str| {
            ModelsRequest::new(ModelsProtocol::Openai, base, key, None)
                .unwrap_err()
                .code
        };
        assert_eq!(err("", "sk"), "missing_base_url");
        assert_eq!(err("ftp://h/v1", "sk"), "invalid_url");
        assert_eq!(err("not a url", "sk"), "invalid_url");
        assert_eq!(err("https://h/v1", "  "), "missing_api_key");
        // The key never shows in a debug print.
        let shown = format!("{:?}", request(ModelsProtocol::Openai, "https://h/v1"));
        assert!(!shown.contains("sk-secret"), "{shown}");
    }

    #[test]
    fn reads_every_shape_a_list_comes_in() {
        let ids = |v: Value| -> Vec<String> {
            parse_page(&v).unwrap().into_iter().map(|m| m.id).collect()
        };
        // OpenAI, with new-api's extra keys and a repeated id kept for later.
        assert_eq!(
            ids(json!({"success": true, "data": [{"id": "glm-5.2"}, {"id": " kimi-k3 "}, {"nope": 1}]})),
            ["glm-5.2", "kimi-k3"]
        );
        // Gemini: the prefix goes, and an embedding model is not offered.
        let gemini = parse_page(&json!({"models": [
            {"name": "models/gemini-3-pro", "displayName": "Gemini 3 Pro", "inputTokenLimit": 1048576,
             "supportedGenerationMethods": ["generateContent", "countTokens"]},
            {"name": "models/text-embedding-005", "supportedGenerationMethods": ["embedContent"]}
        ]}))
        .unwrap();
        assert_eq!(
            gemini,
            [ListedModel {
                id: "gemini-3-pro".into(),
                display_name: Some("Gemini 3 Pro".into()),
                context_window: Some(1048576),
            }]
        );
        // Anthropic's display name; a Codex catalog's slugs.
        let anthropic = parse_page(&json!({"data": [
            {"id": "claude-opus-5-5", "display_name": "Claude Opus 5.5", "type": "model"}
        ]}))
        .unwrap();
        assert_eq!(anthropic[0].display_name.as_deref(), Some("Claude Opus 5.5"));
        assert_eq!(ids(json!({"models": [{"slug": "gpt-5.5"}]})), ["gpt-5.5"]);
        assert_eq!(ids(json!({"data": []})), Vec::<String>::new());
        for garbage in [json!({"nope": 1}), json!([1, 2]), json!({"data": 3})] {
            assert_eq!(parse_page(&garbage).unwrap_err().code, "unrecognized_shape");
        }
    }

    /// A listener answering each connection with the next response, and
    /// handing back what each request looked like.
    async fn serve(responses: Vec<Vec<u8>>) -> (String, tokio::task::JoinHandle<Vec<String>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let mut seen = Vec::new();
            for response in responses {
                let (mut sock, _) = listener.accept().await.unwrap();
                let mut buf = vec![0u8; 8192];
                let n = sock.read(&mut buf).await.unwrap_or(0);
                let _ = sock.write_all(&response).await;
                let _ = sock.shutdown().await;
                seen.push(String::from_utf8_lossy(&buf[..n]).into_owned());
            }
            seen
        });
        (format!("http://{addr}"), handle)
    }

    fn http(status: &str, body: &str) -> Vec<u8> {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .into_bytes()
    }

    fn request_line(raw: &str) -> &str {
        raw.lines().next().unwrap_or_default()
    }

    fn header<'a>(raw: &'a str, name: &str) -> Option<&'a str> {
        raw.lines().find_map(|line| {
            let (n, v) = line.split_once(':')?;
            n.eq_ignore_ascii_case(name).then_some(v.trim())
        })
    }

    #[tokio::test]
    async fn an_openai_list_is_asked_with_a_bearer_key() {
        let (base, seen) = serve(vec![http(
            "200 OK",
            r#"{"data":[{"id":"b"},{"id":"a"},{"id":"b"}]}"#,
        )])
        .await;
        let list = list_models(&request(ModelsProtocol::Openai, &format!("{base}/v1")))
            .await
            .unwrap();
        let ids: Vec<_> = list.models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["b", "a"]);
        assert_eq!(list.url, format!("{base}/v1/models"));
        let raw = &seen.await.unwrap()[0];
        assert_eq!(request_line(raw), "GET /v1/models HTTP/1.1");
        assert_eq!(header(raw, "authorization"), Some("Bearer sk-secret"));
    }

    #[tokio::test]
    async fn an_anthropic_list_is_followed_page_by_page() {
        let (base, seen) = serve(vec![
            http(
                "200 OK",
                r#"{"data":[{"id":"claude-a"}],"has_more":true,"last_id":"claude-a"}"#,
            ),
            http(
                "200 OK",
                r#"{"data":[{"id":"claude-b"}],"has_more":false,"last_id":"claude-b"}"#,
            ),
        ])
        .await;
        let list = list_models(&request(ModelsProtocol::Anthropic, &base))
            .await
            .unwrap();
        let ids: Vec<_> = list.models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["claude-a", "claude-b"]);
        let seen = seen.await.unwrap();
        assert_eq!(request_line(&seen[0]), "GET /v1/models?limit=1000 HTTP/1.1");
        assert_eq!(
            request_line(&seen[1]),
            "GET /v1/models?limit=1000&after_id=claude-a HTTP/1.1"
        );
        assert_eq!(header(&seen[0], "x-api-key"), Some("sk-secret"));
        assert_eq!(header(&seen[0], "anthropic-version"), Some("2023-06-01"));
        assert_eq!(header(&seen[0], "authorization"), None);
    }

    #[tokio::test]
    async fn an_agent_that_sends_a_bearer_token_lists_with_one() {
        let (base, seen) = serve(vec![http("200 OK", r#"{"data":[]}"#)]).await;
        let req =
            ModelsRequest::new(ModelsProtocol::Anthropic, &base, "tok", Some(KeyHeader::Bearer))
                .unwrap();
        list_models(&req).await.unwrap();
        let raw = &seen.await.unwrap()[0];
        assert_eq!(header(raw, "authorization"), Some("Bearer tok"));
        assert_eq!(header(raw, "x-api-key"), None);
    }

    #[tokio::test]
    async fn a_gemini_list_is_paged_by_token() {
        let (base, seen) = serve(vec![
            http(
                "200 OK",
                r#"{"models":[{"name":"models/gemini-a"}],"nextPageToken":"p2"}"#,
            ),
            http("200 OK", r#"{"models":[{"name":"models/gemini-b"}]}"#),
        ])
        .await;
        let list = list_models(&request(ModelsProtocol::Gemini, &base))
            .await
            .unwrap();
        let ids: Vec<_> = list.models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["gemini-a", "gemini-b"]);
        let seen = seen.await.unwrap();
        assert_eq!(
            request_line(&seen[1]),
            "GET /v1beta/models?pageSize=1000&pageToken=p2 HTTP/1.1"
        );
        assert_eq!(header(&seen[0], "x-goog-api-key"), Some("sk-secret"));
    }

    #[tokio::test]
    async fn a_url_without_a_list_hands_over_to_the_next_candidate() {
        let (base, seen) = serve(vec![
            http("404 Not Found", r#"{"error":"no route"}"#),
            http("405 Method Not Allowed", "{}"),
            http("200 OK", r#"{"data":[{"id":"glm-5.2"}]}"#),
        ])
        .await;
        let list = list_models(&request(
            ModelsProtocol::Anthropic,
            &format!("{base}/api/anthropic"),
        ))
        .await
        .unwrap();
        assert_eq!(list.url, format!("{base}/models"));
        let lines: Vec<String> = seen
            .await
            .unwrap()
            .iter()
            .map(|r| request_line(r).to_string())
            .collect();
        assert_eq!(
            lines,
            [
                "GET /api/anthropic/v1/models?limit=1000 HTTP/1.1",
                "GET /v1/models?limit=1000 HTTP/1.1",
                "GET /models?limit=1000 HTTP/1.1",
            ]
        );
    }

    #[tokio::test]
    async fn any_other_error_stops_and_never_shows_the_key() {
        let (base, seen) = serve(vec![http(
            "401 Unauthorized",
            r#"{"error":{"message":"bad key sk-secret"}}"#,
        )])
        .await;
        let err = list_models(&request(ModelsProtocol::Openai, &base))
            .await
            .unwrap_err();
        assert_eq!(err.code, "unauthorized");
        assert_eq!(err.params["status"], "401");
        assert!(!err.message.contains("sk-secret"), "{}", err.message);
        // Only the first candidate was asked.
        assert_eq!(seen.await.unwrap().len(), 1);

        let (base, _) = serve(vec![http("404 Not Found", "{}"), http("404 Not Found", "{}")]).await;
        let err = list_models(&request(ModelsProtocol::Openai, &base))
            .await
            .unwrap_err();
        assert_eq!(err.code, "not_found");
        assert_eq!(err.params["url"], format!("{base}/models"));
    }

    #[tokio::test]
    async fn a_redirect_is_refused() {
        let (base, _) = serve(vec![b"HTTP/1.1 302 Found\r\nLocation: https://elsewhere.example/models\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()])
        .await;
        let err = list_models(&request(ModelsProtocol::Openai, &format!("{base}/v1")))
            .await
            .unwrap_err();
        assert_eq!(err.code, "redirect");
        assert_eq!(err.params["host"], "elsewhere.example");
    }

    /// The endpoint has the key, and can name a redirect host after it.
    #[tokio::test]
    async fn a_redirect_host_never_echoes_the_key() {
        let (base, _) = serve(vec![b"HTTP/1.1 302 Found\r\nLocation: https://sk-secret.attacker.example/models\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()])
        .await;
        let err = list_models(&request(ModelsProtocol::Openai, &format!("{base}/v1")))
            .await
            .unwrap_err();
        assert_eq!(err.code, "redirect");
        assert!(!err.message.contains("sk-secret"), "{}", err.message);
        assert!(
            !err.params["host"].contains("sk-secret"),
            "{:?}",
            err.params
        );

        // The parser lowercases the host, and a key with capitals in it.
        let (base, _) = serve(vec![b"HTTP/1.1 302 Found\r\nLocation: https://sk-SeCrEt.attacker.example/models\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()])
        .await;
        let mixed = ModelsRequest::new(
            ModelsProtocol::Openai,
            &format!("{base}/v1"),
            "sk-SeCrEt",
            None,
        )
        .unwrap();
        let err = list_models(&mixed).await.unwrap_err();
        assert_eq!(err.code, "redirect");
        assert_eq!(err.params["host"], "***.attacker.example");
        assert!(
            !err.message.to_ascii_lowercase().contains("sk-secret"),
            "{}",
            err.message
        );
    }

    #[test]
    fn the_key_is_scrubbed_in_any_case_around_any_text() {
        assert_eq!(
            scrub("bad key SK-ABC, sk-abc!", "sk-Abc"),
            "bad key ***, ***!"
        );
        assert_eq!(scrub("ключ sk-abc — ключ", "SK-ABC"), "ключ *** — ключ");
        assert_eq!(scrub("nothing here", ""), "nothing here");
    }

    #[test]
    fn an_error_is_localized_under_the_callers_namespace() {
        let e = EndpointError::new("unauthorized", "no").with_param("status", "401");
        let app = e.to_app_error("providerModels");
        assert_eq!(app.i18n_key.as_deref(), Some("providerModels.unauthorized"));
    }
}
