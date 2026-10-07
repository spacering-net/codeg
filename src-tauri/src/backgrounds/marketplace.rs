//! Workspace-background marketplace backed by [wallhaven.cc](https://wallhaven.cc/).
//!
//! Three operations, all proxied host-side so the webview never talks to the
//! CDN directly (it is unreachable from some networks — same reason
//! `crate::pets::marketplace` proxies):
//! - `search(...)` — public `GET /api/v1/search` with `purity=100` (SFW)
//!   hard-coded; the app structurally cannot request NSFW results.
//! - `fetch_asset(...)` — one allowlisted thumbnail, returned as a
//!   `BackgroundAsset` for the frontend to mint a blob URL from.
//! - `download(...)` — full image through the *same* validation and atomic
//!   write as a manual background pick, so a market download and a local
//!   file share one security path (byte sniff, 16 MiB / 40 Mpx caps).
//!
//! All traffic uses a process-wide `reqwest::Client` with a stable user-agent,
//! mirroring `crate::pets::marketplace`, and a redirect policy that re-applies
//! the host allowlist to every hop — validating only the URL we dial would
//! leave the allowlist enforceable in one place and bypassable in the next.

use std::sync::LazyLock;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};

use crate::app_error::AppCommandError;
use crate::backgrounds::{validate_background, write_background_atomic};
use crate::models::background::BackgroundAsset;

const WALLHAVEN_SEARCH_URL: &str = "https://wallhaven.cc/api/v1/search";
const WALLHAVEN_USER_AGENT: &str = "codeg-wallpaper-market/1.0";
/// SFW-only, permanently. Appended verbatim — never taken from params.
const WALLHAVEN_PURITY: &str = "100";
/// Search JSON cap. Real pages are ~50 KiB; 4 MiB matches the pet listing cap.
const MAX_SEARCH_JSON_BYTES: u64 = 4 * 1024 * 1024;
/// Thumbnail cap. Real `th.wallhaven.cc/small` files are tens of KiB.
const MAX_ASSET_BYTES: u64 = 4 * 1024 * 1024;
/// Full-image cap. Deliberately equals `backgrounds::MAX_BG_BYTES` so the
/// transport cap and the byte-level validator agree on one ceiling.
const MAX_DOWNLOAD_BYTES: u64 = 16 * 1024 * 1024;
/// Longest accepted search query; wallhaven itself truncates far earlier.
const MAX_QUERY_CHARS: usize = 128;
/// Deadline for the small JSON/thumbnail fetches, which are tens of KiB.
const SMALL_FETCH_TIMEOUT: Duration = Duration::from_secs(30);
/// Deadline for a full image. Deliberately not 30 s: at the 16 MiB ceiling that
/// would demand ~4.4 Mbit/s sustained, and this market exists precisely because
/// some users cannot reach the CDN well. Stalls are caught by the client's
/// read timeout, so this only bounds a slow-but-progressing transfer.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(300);
/// Redirect hops allowed, each re-checked against the host allowlist.
const MAX_REDIRECT_HOPS: usize = 5;

static MARKET_HTTP_CLIENT: LazyLock<Result<reqwest::Client, String>> = LazyLock::new(|| {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(8))
        // Per-read, not per-request: a stalled transfer still fails fast while a
        // slow one is allowed to finish (see `DOWNLOAD_TIMEOUT`).
        .read_timeout(Duration::from_secs(30))
        .redirect(wallhaven_redirect_policy())
        .user_agent(WALLHAVEN_USER_AGENT)
        .build()
        .map_err(|e| format!("failed to initialize wallpaper market HTTP client: {e}"))
});

fn client() -> Result<&'static reqwest::Client, AppCommandError> {
    MARKET_HTTP_CLIENT
        .as_ref()
        .map_err(|err| AppCommandError::network(err.clone()))
}

// ─── URL allowlist ───────────────────────────────────────────────────────

pub(crate) fn is_allowed_wallhaven_host(host: &str) -> bool {
    host == "wallhaven.cc" || host.ends_with(".wallhaven.cc")
}

/// Whether a *redirect target* is still inside the allowlist.
///
/// Validating the URL we hand to `reqwest` only covers the first hop. Under the
/// default redirect policy the client would then follow a `Location` anywhere —
/// and since `fetch_asset` hands the response body back to the caller, a
/// redirect off wallhaven would turn this proxy into a general-purpose reader of
/// whatever the *host* can reach, which in server mode may be a private network.
/// So every hop is re-checked, the way `forge` and `remote_proxy` re-check
/// theirs.
pub(crate) fn is_allowed_wallhaven_hop(url: &reqwest::Url) -> bool {
    url.scheme() == "https" && url.host_str().is_some_and(is_allowed_wallhaven_host)
}

fn wallhaven_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if !is_allowed_wallhaven_hop(attempt.url()) {
            let refused = format!("refused a redirect off wallhaven.cc to {}", attempt.url());
            return attempt.error(refused);
        }
        if attempt.previous().len() > MAX_REDIRECT_HOPS {
            return attempt.error(format!("more than {MAX_REDIRECT_HOPS} redirects"));
        }
        attempt.follow()
    })
}

/// Accept only `https` URLs on wallhaven.cc or a subdomain, with no embedded
/// userinfo. Everything the market fetches funnels through this check.
pub(crate) fn parse_wallhaven_https_url(raw: &str) -> Result<reqwest::Url, AppCommandError> {
    let url = reqwest::Url::parse(raw).map_err(|_| {
        AppCommandError::invalid_input("Marketplace URL must be a valid https wallhaven.cc URL.")
    })?;
    if url.scheme() != "https" {
        return Err(AppCommandError::invalid_input(
            "Marketplace URL must use https.",
        ));
    }
    // A URL carrying userinfo is not a shape wallhaven ever produces; refuse
    // it rather than wonder what it was impersonating.
    if !url.username().is_empty() || url.password().is_some() {
        return Err(AppCommandError::invalid_input(
            "Marketplace URL must not embed credentials.",
        ));
    }
    let host = url
        .host_str()
        .ok_or_else(|| AppCommandError::invalid_input("Marketplace URL must name a host."))?;
    if !is_allowed_wallhaven_host(host) {
        return Err(AppCommandError::invalid_input(
            "Marketplace URL host must be wallhaven.cc or a subdomain.",
        ));
    }
    Ok(url)
}

/// Canonical page URL for an id — derived, never trusted from the listing,
/// because `download` requires exactly this shape for `source_url`.
pub(crate) fn wallhaven_source_url(id: &str) -> String {
    format!("https://wallhaven.cc/w/{}", id.trim())
}

// ─── Wire types ──────────────────────────────────────────────────────────

/// Query parameters for `search`. `category` accepts exactly
/// all/general/anime/people; anything else is an error (a typo silently
/// becoming "all" would look like broken filtering).
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketSearchParams {
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub page: Option<u32>,
}

/// One listing entry re-serialized as a stable contract (a subset of the
/// upstream record, like `pets::marketplace::MarketplacePetSummary`).
///
/// `width`/`height`/`file_size_bytes` are carried rather than dropped because
/// `download` refuses anything past `backgrounds::MAX_BG_BYTES` /
/// `MAX_BG_PIXELS`, and roughly one wallhaven listing in fifteen is past one of
/// them. Without these three numbers the frontend cannot tell a wallpaper it can
/// apply from one it can only fail on. `0` means the listing omitted the field.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketWallpaperSummary {
    pub id: String,
    pub thumb_url: String,
    pub full_url: String,
    pub source_url: String,
    pub width: u32,
    pub height: u32,
    pub file_size_bytes: u64,
    pub category: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketSearchPage {
    pub items: Vec<MarketWallpaperSummary>,
    pub page: u32,
    pub last_page: u32,
}

/// wallhaven category bitmask: general=100 / anime=010 / people=001.
pub(crate) fn wallhaven_categories(
    category: Option<&str>,
) -> Result<&'static str, AppCommandError> {
    match category {
        None | Some("all") => Ok("111"),
        Some("general") => Ok("100"),
        Some("anime") => Ok("010"),
        Some("people") => Ok("001"),
        Some(other) => Err(AppCommandError::invalid_input(format!(
            "Unknown wallpaper market category: {other}"
        ))),
    }
}

// ─── Search ──────────────────────────────────────────────────────────────

pub async fn search(params: MarketSearchParams) -> Result<MarketSearchPage, AppCommandError> {
    let query = params
        .query
        .as_deref()
        .map(str::trim)
        .filter(|q| !q.is_empty());
    if let Some(q) = query {
        if q.chars().count() > MAX_QUERY_CHARS {
            return Err(AppCommandError::invalid_input(format!(
                "Search query exceeds {MAX_QUERY_CHARS} characters."
            )));
        }
    }
    let page = params.page.unwrap_or(1).max(1);
    let categories = wallhaven_categories(params.category.as_deref())?;

    let mut url = reqwest::Url::parse(WALLHAVEN_SEARCH_URL)
        .map_err(|e| AppCommandError::network(format!("invalid search URL: {e}")))?;
    {
        let mut pairs = url.query_pairs_mut();
        pairs.append_pair("categories", categories);
        pairs.append_pair("purity", WALLHAVEN_PURITY);
        pairs.append_pair("page", &page.to_string());
        match query {
            Some(q) => {
                pairs.append_pair("q", q);
                pairs.append_pair("sorting", "relevance");
            }
            // Browse mode: the last month's top list is a sensible default grid.
            None => {
                pairs.append_pair("sorting", "toplist");
                pairs.append_pair("topRange", "1M");
            }
        }
    }

    let resp = client()?
        .get(url)
        .timeout(SMALL_FETCH_TIMEOUT)
        .send()
        .await
        .map_err(|e| AppCommandError::network(format!("wallhaven search failed: {e}")))?;
    if !resp.status().is_success() {
        return Err(AppCommandError::network(format!(
            "wallhaven search returned HTTP {}",
            resp.status()
        )));
    }
    let body = read_capped(resp, MAX_SEARCH_JSON_BYTES, "wallhaven search payload").await?;
    let text = String::from_utf8_lossy(&body).into_owned();
    parse_search_payload(&text)
}

/// Pure parser so the listing contract is unit-testable without network.
pub(crate) fn parse_search_payload(body: &str) -> Result<MarketSearchPage, AppCommandError> {
    #[derive(Deserialize)]
    struct ApiThumbs {
        #[serde(default)]
        small: Option<String>,
    }
    #[derive(Deserialize)]
    struct ApiItem {
        id: String,
        #[serde(default)]
        path: Option<String>,
        #[serde(default)]
        thumbs: Option<ApiThumbs>,
        #[serde(default)]
        dimension_x: Option<u32>,
        #[serde(default)]
        dimension_y: Option<u32>,
        #[serde(default)]
        file_size: Option<u64>,
        #[serde(default)]
        category: Option<String>,
    }
    #[derive(Default, Deserialize)]
    struct ApiMeta {
        #[serde(default)]
        current_page: Option<u32>,
        #[serde(default)]
        last_page: Option<u32>,
    }
    #[derive(Deserialize)]
    struct ApiPayload {
        #[serde(default)]
        data: Vec<ApiItem>,
        #[serde(default)]
        meta: Option<ApiMeta>,
    }

    let payload: ApiPayload = serde_json::from_str(body)
        .map_err(|e| AppCommandError::network(format!("wallhaven returned malformed JSON: {e}")))?;

    let mut items = Vec::with_capacity(payload.data.len());
    for item in payload.data {
        let (Some(full_url), Some(thumb_url)) = (item.path, item.thumbs.and_then(|t| t.small))
        else {
            continue;
        };
        // A listing entry pointing off wallhaven is dropped, not trusted —
        // the frontend will only ever hand us URLs we vouched for here.
        if parse_wallhaven_https_url(&full_url).is_err()
            || parse_wallhaven_https_url(&thumb_url).is_err()
        {
            continue;
        }
        // Derived from the id, not copied from the listing. Computed before
        // `item.id` is moved into the summary below.
        let source_url = wallhaven_source_url(&item.id);
        items.push(MarketWallpaperSummary {
            id: item.id,
            thumb_url,
            full_url,
            source_url,
            width: item.dimension_x.unwrap_or(0),
            height: item.dimension_y.unwrap_or(0),
            file_size_bytes: item.file_size.unwrap_or(0),
            category: item.category.unwrap_or_default(),
        });
    }
    let meta = payload.meta.unwrap_or_default();
    Ok(MarketSearchPage {
        // Both floored at 1: the frontend pages relative to `page`, so a `0`
        // from upstream would put its cursor somewhere that cannot be asked for.
        page: meta.current_page.unwrap_or(1).max(1),
        last_page: meta.last_page.unwrap_or(1).max(1),
        items,
    })
}

// ─── Asset proxy (thumbnails) ────────────────────────────────────────────

pub async fn fetch_asset(url: &str) -> Result<BackgroundAsset, AppCommandError> {
    let url = parse_wallhaven_https_url(url)?;
    let (mime, bytes) = fetch_image_capped(
        &url,
        MAX_ASSET_BYTES,
        SMALL_FETCH_TIMEOUT,
        "wallhaven thumbnail",
    )
    .await?;
    Ok(BackgroundAsset {
        mime,
        data_base64: BASE64.encode(&bytes),
    })
}

// ─── Download & apply ────────────────────────────────────────────────────

pub async fn download(url: &str, source_url: &str) -> Result<(), AppCommandError> {
    let full_url = parse_wallhaven_https_url(url)?;
    // `source_url` is metadata we display/compare; require it to be the real
    // page URL shape so a download can't be attributed to a bogus source.
    let source = parse_wallhaven_https_url(source_url)?;
    if source.host_str() != Some("wallhaven.cc") || !source.path().starts_with("/w/") {
        return Err(AppCommandError::invalid_input(
            "sourceUrl must be a https://wallhaven.cc/w/<id> page URL.",
        ));
    }

    let (_mime, bytes) = fetch_image_capped(
        &full_url,
        MAX_DOWNLOAD_BYTES,
        DOWNLOAD_TIMEOUT,
        "wallpaper download",
    )
    .await?;
    // Same gate as a manual pick: byte sniff, 16 MiB and 40 Mpx caps. Off the
    // runtime like every other command in `commands::background` — decoding a
    // header and fsyncing up to 16 MiB is not work to do on an executor thread.
    tokio::task::spawn_blocking(move || {
        validate_background(&bytes)?;
        write_background_atomic(&bytes)
    })
    .await
    .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?
}

// ─── Shared fetch helper ─────────────────────────────────────────────────

async fn fetch_image_capped(
    url: &reqwest::Url,
    cap: u64,
    timeout: Duration,
    what: &str,
) -> Result<(String, Vec<u8>), AppCommandError> {
    let resp = client()?
        .get(url.clone())
        .timeout(timeout)
        .send()
        .await
        .map_err(|e| AppCommandError::network(format!("{what} failed: {e}")))?;
    if !resp.status().is_success() {
        return Err(AppCommandError::network(format!(
            "{what} returned HTTP {}",
            resp.status()
        )));
    }
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| {
            v.split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase()
        });
    // wallhaven serves jpeg/png/webp for both thumbs and full images. The
    // byte-level sniff in `validate_background` remains the final authority
    // for downloads; this is the early, cheap rejection.
    if !matches!(
        content_type.as_deref(),
        Some("image/jpeg") | Some("image/png") | Some("image/webp")
    ) {
        return Err(AppCommandError::network(format!(
            "{what} returned unsupported content-type {content_type:?}"
        )));
    }
    let bytes = read_capped(resp, cap, what).await?;
    Ok((content_type.expect("checked above"), bytes))
}

/// Read a response body with a hard ceiling: reject on declared
/// Content-Length and again on accumulated bytes, so a lying header or a
/// chunked stream cannot balloon memory.
async fn read_capped(
    mut resp: reqwest::Response,
    cap: u64,
    what: &str,
) -> Result<Vec<u8>, AppCommandError> {
    let cap_mib = cap / (1024 * 1024);
    if let Some(len) = resp.content_length() {
        if len > cap {
            return Err(AppCommandError::network(format!(
                "{what} exceeds {cap_mib} MiB cap."
            )));
        }
    }
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| AppCommandError::network(format!("{what} failed mid-transfer: {e}")))?
    {
        if buf.len() as u64 + chunk.len() as u64 > cap {
            return Err(AppCommandError::network(format!(
                "{what} exceeds {cap_mib} MiB cap."
            )));
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = r#"{
      "data": [
        {
          "id": "abc123",
          "url": "https://wallhaven.cc/w/abc123",
          "path": "https://w.wallhaven.cc/full/ab/wallhaven-abc123.jpg",
          "thumbs": { "small": "https://th.wallhaven.cc/small/ab/abc123.jpg" },
          "dimension_x": 1920,
          "dimension_y": 1080,
          "file_size": 4455320,
          "category": "general"
        },
        {
          "id": "bad9",
          "url": "https://wallhaven.cc/w/bad9",
          "path": "https://evil.example/full/wallhaven-bad9.jpg",
          "thumbs": { "small": "https://th.wallhaven.cc/small/ba/bad9.jpg" },
          "dimension_x": 800,
          "dimension_y": 600,
          "file_size": 91234,
          "category": "anime"
        }
      ],
      "meta": { "current_page": 2, "last_page": 10, "per_page": 24, "total": 240 }
    }"#;

    #[test]
    fn categories_maps_known_filters() {
        assert_eq!(wallhaven_categories(Some("all")).unwrap(), "111");
        assert_eq!(wallhaven_categories(Some("general")).unwrap(), "100");
        assert_eq!(wallhaven_categories(Some("anime")).unwrap(), "010");
        assert_eq!(wallhaven_categories(Some("people")).unwrap(), "001");
        assert_eq!(wallhaven_categories(None).unwrap(), "111");
    }

    #[test]
    fn categories_rejects_unknown_value() {
        assert!(wallhaven_categories(Some("nsfw")).is_err());
    }

    #[test]
    fn host_allowlist_accepts_wallhaven_and_subdomains_only() {
        assert!(is_allowed_wallhaven_host("wallhaven.cc"));
        assert!(is_allowed_wallhaven_host("th.wallhaven.cc"));
        assert!(is_allowed_wallhaven_host("w.wallhaven.cc"));
        assert!(!is_allowed_wallhaven_host("wallhaven.cc.evil"));
        assert!(!is_allowed_wallhaven_host("evil.cc"));
    }

    #[test]
    fn url_parser_enforces_https_wallhaven_no_userinfo() {
        assert!(parse_wallhaven_https_url("https://w.wallhaven.cc/full/ab/x.jpg").is_ok());
        assert!(parse_wallhaven_https_url("https://wallhaven.cc/w/abc").is_ok());
        assert!(parse_wallhaven_https_url("http://wallhaven.cc/w/abc").is_err());
        assert!(parse_wallhaven_https_url("https://example.com/a.jpg").is_err());
        assert!(parse_wallhaven_https_url("file:///etc/passwd").is_err());
        assert!(parse_wallhaven_https_url("https://user:pw@wallhaven.cc/w/abc").is_err());
        assert!(parse_wallhaven_https_url("not a url").is_err());
    }

    #[test]
    fn source_url_is_derived_from_id() {
        assert_eq!(
            wallhaven_source_url(" abc123 "),
            "https://wallhaven.cc/w/abc123"
        );
    }

    #[test]
    fn search_payload_parses_and_drops_non_wallhaven_entries() {
        let page = parse_search_payload(FIXTURE).expect("parse");
        // 第二项的 path 指向 evil.example —— 整条丢弃，不信任。
        assert_eq!(page.items.len(), 1);
        let item = &page.items[0];
        assert_eq!(item.id, "abc123");
        assert_eq!(
            item.thumb_url,
            "https://th.wallhaven.cc/small/ab/abc123.jpg"
        );
        assert_eq!(
            item.full_url,
            "https://w.wallhaven.cc/full/ab/wallhaven-abc123.jpg"
        );
        assert_eq!(item.source_url, "https://wallhaven.cc/w/abc123");
        assert_eq!((item.width, item.height), (1920, 1080));
        assert_eq!(item.file_size_bytes, 4_455_320);
        assert_eq!(item.category, "general");
        assert_eq!(page.page, 2);
        assert_eq!(page.last_page, 10);
    }

    /// A listing that omits the size fields must still be usable; `0` is the
    /// "unknown" the frontend reads as "let the backend decide".
    #[test]
    fn search_payload_defaults_missing_size_fields_to_zero() {
        let page = parse_search_payload(
            r#"{"data":[{"id":"x1","path":"https://w.wallhaven.cc/full/x/x1.jpg",
               "thumbs":{"small":"https://th.wallhaven.cc/small/x/x1.jpg"}}]}"#,
        )
        .expect("parse");
        let item = &page.items[0];
        assert_eq!((item.width, item.height, item.file_size_bytes), (0, 0, 0));
    }

    #[test]
    fn redirect_hops_are_held_to_the_same_allowlist_as_the_first_url() {
        let allowed = |raw: &str| is_allowed_wallhaven_hop(&reqwest::Url::parse(raw).unwrap());
        assert!(allowed("https://w.wallhaven.cc/full/ab/x.jpg"));
        assert!(allowed("https://wallhaven.cc/w/abc"));
        // The shapes an open redirect would aim at: another host, a scheme
        // downgrade, and the metadata/loopback endpoints a host-side proxy
        // must never be steered onto.
        assert!(!allowed("https://evil.example/x.jpg"));
        assert!(!allowed("https://wallhaven.cc.evil/x.jpg"));
        assert!(!allowed("http://wallhaven.cc/w/abc"));
        assert!(!allowed("http://169.254.169.254/latest/meta-data/"));
        assert!(!allowed("https://127.0.0.1/admin"));
    }

    #[test]
    fn search_payload_tolerates_missing_meta() {
        let page = parse_search_payload(r#"{"data":[]}"#).expect("parse");
        assert!(page.items.is_empty());
        assert_eq!(page.page, 1);
        assert_eq!(page.last_page, 1);
    }

    #[test]
    fn search_payload_rejects_garbage() {
        assert!(parse_search_payload("not json").is_err());
    }
}
