//! The one way a request leaves for SpaceRing.
//!
//! The rules, all enforced here so that no caller can forget one:
//!
//! - **HTTPS only.** The client refuses any other scheme, redirects included.
//!   The single exception is a development build pointed at a loopback
//!   address (`origin.rs`), where plain HTTP is the only thing a dev server
//!   speaks.
//! - **One host.** A redirect is followed only within the origin it came
//!   from; one that points anywhere else is not followed, and its 3xx is
//!   reported like any other answer that is not a success.
//! - **Anonymous.** The endpoints Codeg reads need no identity, so none is
//!   sent: no cookie (there is no cookie store), no SRN token, no install id.
//!   `User-Agent` says which Codeg is asking, and that is all.
//! - **Bounded.** Each request has a deadline, and a body is read only up to
//!   the cap its caller names — counted on the decompressed bytes, so a small
//!   compressed answer cannot unpack into a large one.
//! - **Patient.** After a 429 nothing is sent to that origin until the time
//!   its `Retry-After` named has passed; requests made meanwhile fail at once
//!   with the time that is left.
//! - **The user's proxy.** A reqwest client samples the proxy environment
//!   once, when it is built, and Codeg lets the proxy change while it runs —
//!   so, as in `forge::http_client`, the client is kept with the proxy
//!   settings it was built under and rebuilt when they differ.
//! - **Once more, after a dropped connection.** A request that may be sent
//!   twice (every one here: GETs, and `/resolve`, a read-only POST) is sent
//!   once more when the connection it went out on was closed or reset under
//!   it before any answer came — what happens when a proxy on the way has
//!   already let go of a pooled connection. Nothing else is retried: not a
//!   timeout, not a failure to connect (DNS, refused, TLS), not an answer of
//!   any status, not a body cut short. Idle connections are kept for
//!   [`POOL_IDLE_TIMEOUT`] only, so fewer go stale in the first place.
//!
//! The SRN account API (`srn::client`) talks to the same origin and builds on
//! the same pieces: [`account_api_client`] is this client with no redirect
//! followed and no request ever sent twice, and [`read_capped`],
//! [`media_type`] and [`describe`] read its answers.

use std::collections::HashMap;
use std::sync::{Mutex, RwLock};
use std::time::{Duration, Instant};

use reqwest::header::{
    HeaderMap, ACCEPT, CACHE_CONTROL, CONTENT_TYPE, ETAG, IF_NONE_MATCH, RETRY_AFTER,
};
use reqwest::{StatusCode, Url};

use super::error::HarnessError;
use super::origin::{same_origin, Origin};

/// Which Codeg is asking. Nothing about the machine or the user.
pub(crate) const USER_AGENT: &str = concat!("codeg/", env!("CARGO_PKG_VERSION"));

/// How long a connection may take to open. `forge::http_client`'s number:
/// long enough for a slow proxy, short enough that "offline" shows as such.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// How long the catalog client keeps an idle connection for the next
/// request. reqwest's default is 90 s; proxies and edges close idle
/// connections on clocks of their own, often sooner, and a request sent on
/// one already closed fails ("connection closed before message completed").
/// Browsing comes in bursts: a quarter of a minute still reuses connections
/// within one, and lets them go between them.
pub(crate) const POOL_IDLE_TIMEOUT: Duration = Duration::from_secs(15);

/// Hops within the origin before a redirect chain is called a loop.
const MAX_REDIRECTS: usize = 5;

/// What a 429 without a usable `Retry-After` is taken to ask for. The API
/// itself sends 60.
pub(crate) const DEFAULT_RETRY_AFTER_SECS: u64 = 60;

/// The longest pause one answer can impose, whatever it says: a mistaken
/// header must not silence the catalog until Codeg is restarted.
pub(crate) const MAX_RETRY_AFTER_SECS: u64 = 60 * 60;

/// An ETag longer than this is not kept: it would be sent back on every
/// request for the entry.
const MAX_ETAG_BYTES: usize = 256;

/// The image types SpaceRing serves (`/api/avatars/`, `/media/`). SVG is
/// deliberately not among them: it is markup, not a picture.
const IMAGE_TYPES: [&str; 4] = ["image/webp", "image/png", "image/jpeg", "image/gif"];

/// The deadline of a request and the size caps of each kind of answer.
#[derive(Debug, Clone)]
pub(crate) struct Limits {
    /// A whole request, from sending it to the last byte of the body.
    pub request_timeout: Duration,
    /// Any JSON answer.
    pub json_bytes: u64,
    /// An item's description, as HTML.
    pub readme_bytes: u64,
    /// A prompt's text.
    pub prompt_bytes: u64,
    /// A picture.
    pub asset_bytes: u64,
    /// One file of a package, read by its hash (`harness_blob`).
    pub blob_bytes: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            // `forge::http_client`'s deadline. Browsing is interactive: past
            // half a minute the person is better served by "retry".
            request_timeout: Duration::from_secs(30),
            // The largest JSON the API hands out is an item with a 500-file
            // manifest and a 100 KiB prompt or assistant definition, or a
            // 100-item page: well under 1 MiB each.
            json_bytes: 4 * 1024 * 1024,
            // Rendered from a description that is one file of a package, and
            // a file is at most 5 MiB (`/config`'s `fileBytes`); markup adds
            // to it.
            readme_bytes: 8 * 1024 * 1024,
            // A prompt's body is at most 100 KiB (`/config`'s `textBytes`).
            prompt_bytes: 1024 * 1024,
            // SpaceRing keeps no picture over 1 MB.
            asset_bytes: 4 * 1024 * 1024,
            // The frontend's contract: a file copied as text (an assistant's
            // definition, a prompt's file) is at most 256 KiB, which is more
            // than twice the body any prompt or assistant may have.
            blob_bytes: 256 * 1024,
        }
    }
}

/// What a request is answered with, which is also what it asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Expect {
    Json,
    Html,
    Text,
    Image,
    /// One file of a package, by its hash. SpaceRing serves every file as
    /// `application/octet-stream`, whatever it holds, so its type says
    /// nothing: what shows an answer is the file asked for is that it hashes
    /// to its address, which the caller checks (`Harness::fetch_by_hash`).
    File,
}

impl Expect {
    fn accept(self) -> &'static str {
        match self {
            Self::Json => "application/json",
            Self::Html => "text/html",
            Self::Text => "text/plain",
            Self::Image => "image/webp,image/png,image/jpeg,image/gif",
            Self::File => "application/octet-stream",
        }
    }

    /// Whether an answer of this media type (lowercase, no parameters) is one.
    pub(crate) fn accepts(self, content_type: &str) -> bool {
        match self {
            Self::Json => content_type == "application/json",
            Self::Html => content_type == "text/html",
            Self::Text => content_type == "text/plain",
            Self::Image => IMAGE_TYPES.contains(&content_type),
            Self::File => true,
        }
    }
}

/// A request, as its caller describes it.
pub(crate) struct Outgoing<'a> {
    pub url: &'a Url,
    pub expect: Expect,
    /// The most bytes of body to read.
    pub cap: u64,
    /// The ETag of the copy the caller holds, to be told "unchanged" instead
    /// of being sent it again.
    pub if_none_match: Option<&'a str>,
    /// A JSON body makes this a POST that no cache on the way may answer.
    pub json_body: Option<&'a serde_json::Value>,
    /// Sending it twice changes nothing (a GET, or a read-only query such as
    /// `/resolve`): it may be sent once more after a dropped connection.
    pub idempotent: bool,
}

/// An answer that was a success.
#[derive(Debug)]
pub(crate) enum Incoming {
    /// 304: the copy the caller holds is current.
    NotModified {
        /// As for a body.
        immutable: bool,
    },
    Body {
        etag: Option<String>,
        /// The media type, lowercase and without parameters.
        content_type: String,
        /// The site says what is at this address never changes
        /// (`Cache-Control: immutable`).
        immutable: bool,
        body: Vec<u8>,
    },
}

/// Until when each origin asked to be left alone.
#[derive(Debug, Default)]
pub(crate) struct Backoff(Mutex<HashMap<String, Instant>>);

impl Backoff {
    /// The pause the process shares: a 429 on one command holds every other.
    pub(crate) fn shared() -> &'static Backoff {
        static SHARED: std::sync::LazyLock<Backoff> = std::sync::LazyLock::new(Backoff::default);
        &SHARED
    }

    /// Whole seconds left of the pause at `now`, rounded up; `None` once it
    /// is over.
    pub(crate) fn remaining_at(&self, origin: &Origin, now: Instant) -> Option<u64> {
        let mut pauses = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let until = *pauses.get(origin.as_str())?;
        let left = until.saturating_duration_since(now);
        if left.is_zero() {
            pauses.remove(origin.as_str());
            return None;
        }
        Some(left.as_secs() + u64::from(left.subsec_nanos() > 0))
    }

    pub(crate) fn hold(&self, origin: &Origin, seconds: u64, now: Instant) {
        let until = now + Duration::from_secs(seconds);
        let mut pauses = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let entry = pauses.entry(origin.as_str().to_string()).or_insert(until);
        // two answers in flight: the longer pause stands
        if *entry < until {
            *entry = until;
        }
    }
}

/// The seconds a 429 asks for: its `Retry-After` when that is a number of
/// seconds, the default otherwise (absent, an HTTP date, anything else), and
/// never less than one or more than [`MAX_RETRY_AFTER_SECS`].
pub(crate) fn retry_after_seconds(value: Option<&str>) -> u64 {
    value
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(DEFAULT_RETRY_AFTER_SECS)
        .clamp(1, MAX_RETRY_AFTER_SECS)
}

/// Sends `request` to `origin` and reads the answer, under the rules at the
/// top of this file.
pub(crate) async fn send(
    origin: &Origin,
    backoff: &Backoff,
    timeout: Duration,
    request: Outgoing<'_>,
) -> Result<Incoming, HarnessError> {
    if !origin.holds(request.url) {
        // Every address is made by `Origin::join`; this is the backstop for a
        // caller that built one some other way.
        return Err(HarnessError::InvalidRef);
    }
    if let Some(seconds) = backoff.remaining_at(origin, Instant::now()) {
        return Err(HarnessError::RateLimited { seconds });
    }

    let client = http_client(origin.is_https())?;
    let build = || {
        let mut builder = match request.json_body {
            Some(body) => client
                .post(request.url.clone())
                .header(CACHE_CONTROL, "no-store")
                .json(body),
            None => client.get(request.url.clone()),
        };
        builder = builder
            .header(ACCEPT, request.expect.accept())
            .timeout(timeout);
        if let Some(etag) = request.if_none_match {
            builder = builder.header(IF_NONE_MATCH, etag);
        }
        builder
    };

    let response = match build().send().await {
        Ok(response) => response,
        // The pooled connection it went out on was closed under it: once
        // more, on a fresh one. Only once, and only for what may be sent twice.
        Err(error) if request.idempotent && connection_dropped(&error) => {
            tracing::debug!(
                "[harness] connection dropped before an answer ({}); sending once more",
                describe(&error)
            );
            build()
                .send()
                .await
                .map_err(|error| HarnessError::Network(describe(&error)))?
        }
        Err(error) => return Err(HarnessError::Network(describe(&error))),
    };
    let status = response.status();
    let immutable = is_immutable(response.headers());
    if status == StatusCode::NOT_MODIFIED && request.if_none_match.is_some() {
        return Ok(Incoming::NotModified { immutable });
    }
    if status == StatusCode::TOO_MANY_REQUESTS {
        let seconds = retry_after_seconds(header_text(response.headers(), RETRY_AFTER));
        backoff.hold(origin, seconds, Instant::now());
        return Err(HarnessError::RateLimited { seconds });
    }
    if status == StatusCode::NOT_FOUND {
        return Err(HarnessError::NotFound);
    }
    if !status.is_success() {
        // A redirect that left the origin lands here too: it was not
        // followed, so its 3xx is the answer.
        return Err(HarnessError::Server {
            status: status.as_u16(),
        });
    }

    let content_type = media_type(response.headers());
    if !request.expect.accepts(&content_type) {
        return Err(HarnessError::invalid_response(format!(
            "expected {}, got {}",
            request.expect.accept(),
            if content_type.is_empty() {
                "no content type"
            } else {
                content_type.as_str()
            }
        )));
    }
    let etag = header_text(response.headers(), ETAG)
        .filter(|etag| !etag.is_empty() && etag.len() <= MAX_ETAG_BYTES)
        .map(str::to_string);
    let body = read_capped(response, request.cap).await?;
    Ok(Incoming::Body {
        etag,
        content_type,
        immutable,
        body,
    })
}

fn header_text(headers: &HeaderMap, name: reqwest::header::HeaderName) -> Option<&str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

/// Whether `Cache-Control` carries the `immutable` directive.
fn is_immutable(headers: &HeaderMap) -> bool {
    header_text(headers, CACHE_CONTROL).is_some_and(|value| {
        value
            .split(',')
            .any(|directive| directive.trim().eq_ignore_ascii_case("immutable"))
    })
}

/// `Content-Type` without its parameters, lowercase; empty when there is none.
pub(crate) fn media_type(headers: &HeaderMap) -> String {
    header_text(headers, CONTENT_TYPE)
        .map(|value| {
            value
                .split(';')
                .next()
                .unwrap_or(value)
                .trim()
                .to_ascii_lowercase()
        })
        .unwrap_or_default()
}

/// Reads a body of at most `cap` bytes. A `Content-Length` over the cap is
/// refused before anything is read; a body that says nothing, or lies, is
/// stopped at the first chunk that crosses it.
pub(crate) async fn read_capped(
    mut response: reqwest::Response,
    cap: u64,
) -> Result<Vec<u8>, HarnessError> {
    if response.content_length().is_some_and(|length| length > cap) {
        return Err(HarnessError::TooLarge);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| HarnessError::Network(describe(&error)))?
    {
        if body.len() as u64 + chunk.len() as u64 > cap {
            return Err(HarnessError::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// Whether a request that failed with `error` before any answer arrived did
/// so because the connection it went out on was closed or reset under it —
/// a pooled connection a proxy (or the server) had already let go — and for
/// no other reason. A timeout, a failure to connect (DNS, refused, a TLS
/// handshake, a proxy's tunnel), a redirect or a body error is not that.
fn connection_dropped(error: &reqwest::Error) -> bool {
    if error.is_timeout()
        || error.is_connect()
        || error.is_status()
        || error.is_redirect()
        || error.is_body()
        || error.is_decode()
        || error.is_builder()
    {
        return false;
    }
    let mut cause = std::error::Error::source(error);
    while let Some(inner) = cause {
        if let Some(hyper) = inner.downcast_ref::<hyper::Error>() {
            // closed while the answer was awaited, or before the request
            // could be written at all
            if hyper.is_incomplete_message() || hyper.is_canceled() {
                return true;
            }
        }
        if let Some(io) = inner.downcast_ref::<std::io::Error>() {
            use std::io::ErrorKind::{
                BrokenPipe, ConnectionAborted, ConnectionReset, UnexpectedEof,
            };
            if matches!(
                io.kind(),
                ConnectionReset | ConnectionAborted | BrokenPipe | UnexpectedEof
            ) {
                return true;
            }
        }
        cause = inner.source();
    }
    false
}

/// A transport failure with its causes: reqwest's own text stops at "error
/// sending request", and the reason (DNS, TLS, refused, timed out) is in the
/// chain behind it.
pub(crate) fn describe(error: &reqwest::Error) -> String {
    let mut text = error.to_string();
    let mut cause = std::error::Error::source(error);
    while let Some(inner) = cause {
        text.push_str(": ");
        text.push_str(&inner.to_string());
        cause = inner.source();
    }
    text
}

/// The proxy settings a client was built under, with that client.
type KeyedClient = (Vec<(String, String)>, reqwest::Client);

/// One client per transport rule: `[0]` may speak HTTP (a development build's
/// loopback origin), `[1]` speaks HTTPS only.
static HTTP_CLIENTS: [RwLock<Option<KeyedClient>>; 2] = [RwLock::new(None), RwLock::new(None)];

/// The same pair, for the SRN account API.
static ACCOUNT_API_CLIENTS: [RwLock<Option<KeyedClient>>; 2] =
    [RwLock::new(None), RwLock::new(None)];

/// Whose rules a client follows where the two differ.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Rules {
    /// The catalog: a redirect is followed within the origin it came from,
    /// up to [`MAX_REDIRECTS`] hops, and reqwest's own retry of a request a
    /// server refused before reading it (an HTTP/2 `REFUSED_STREAM` or
    /// `GOAWAY`) stays on.
    Catalog,
    /// The SRN account API: no redirect is followed (the 3xx is the answer),
    /// and no request is ever sent twice — not even that retry, which a
    /// server that did read the request could not tell from a replay.
    AccountApi,
}

/// Every variable a reqwest client samples its proxy decision from when it is
/// built: the proxy addresses and the bypass list.
fn proxy_fingerprint() -> Vec<(String, String)> {
    let mut fingerprint = crate::network::proxy::current_proxy_env_vars();
    fingerprint.extend(crate::network::proxy::current_no_proxy_env_vars());
    fingerprint
}

fn http_client(https_only: bool) -> Result<reqwest::Client, HarnessError> {
    keyed_client(
        &HTTP_CLIENTS[usize::from(https_only)],
        proxy_fingerprint(),
        https_only,
    )
}

/// The client [`send`] uses — the user's proxy, rebuilt when it changes, the
/// same `User-Agent`, connect timeout and transport rule, no `Referer` — but
/// one that never follows a redirect and never sends a request twice
/// ([`Rules::AccountApi`]). For the SRN account API (`srn::client`): its
/// requests carry a code, a verifier or a token; an answer pointing anywhere
/// else is a failure, not a hop; and a code exchange must happen once.
pub(crate) fn account_api_client(https_only: bool) -> Result<reqwest::Client, HarnessError> {
    keyed_client_with(
        &ACCOUNT_API_CLIENTS[usize::from(https_only)],
        proxy_fingerprint(),
        https_only,
        Rules::AccountApi,
    )
}

/// The client kept in `slot` if it was built under `fingerprint`, else a new
/// one, kept in its place.
fn keyed_client(
    slot: &RwLock<Option<KeyedClient>>,
    fingerprint: Vec<(String, String)>,
    https_only: bool,
) -> Result<reqwest::Client, HarnessError> {
    keyed_client_with(slot, fingerprint, https_only, Rules::Catalog)
}

/// [`keyed_client`], under `rules`.
fn keyed_client_with(
    slot: &RwLock<Option<KeyedClient>>,
    fingerprint: Vec<(String, String)>,
    https_only: bool,
    rules: Rules,
) -> Result<reqwest::Client, HarnessError> {
    if let Ok(guard) = slot.read() {
        if let Some((built_under, client)) = guard.as_ref() {
            if *built_under == fingerprint {
                return Ok(client.clone());
            }
        }
    }
    let policy = match rules {
        Rules::Catalog => reqwest::redirect::Policy::custom(|attempt| {
            let within_origin = attempt
                .previous()
                .last()
                .is_some_and(|previous| same_origin(previous, attempt.url()));
            if !within_origin {
                attempt.stop()
            } else if attempt.previous().len() > MAX_REDIRECTS {
                attempt.error("too many redirects")
            } else {
                attempt.follow()
            }
        }),
        Rules::AccountApi => reqwest::redirect::Policy::none(),
    };
    let mut builder = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(CONNECT_TIMEOUT)
        .https_only(https_only)
        // the address before a redirect is nobody's business either
        .referer(false)
        .redirect(policy);
    match rules {
        // Stale idle connections let go sooner (see `send`'s once-more).
        Rules::Catalog => builder = builder.pool_idle_timeout(POOL_IDLE_TIMEOUT),
        Rules::AccountApi => builder = builder.retry(reqwest::retry::never()),
    }
    let client = builder
        .build()
        .map_err(|error| HarnessError::Network(format!("http client build failed: {error}")))?;
    if let Ok(mut guard) = slot.write() {
        *guard = Some((fingerprint, client.clone()));
    }
    Ok(client)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn origin(text: &str) -> Origin {
        Origin::parse(text).unwrap()
    }

    #[test]
    fn retry_after_is_seconds_with_a_default_and_bounds() {
        assert_eq!(retry_after_seconds(Some("7")), 7);
        assert_eq!(retry_after_seconds(Some(" 120 ")), 120);
        assert_eq!(retry_after_seconds(None), 60);
        assert_eq!(retry_after_seconds(Some("")), 60);
        assert_eq!(retry_after_seconds(Some("soon")), 60);
        assert_eq!(retry_after_seconds(Some("-5")), 60);
        assert_eq!(retry_after_seconds(Some("1.5")), 60);
        assert_eq!(
            retry_after_seconds(Some("Wed, 21 Oct 2026 07:28:00 GMT")),
            60
        );
        assert_eq!(retry_after_seconds(Some("0")), 1);
        assert_eq!(retry_after_seconds(Some("86400")), MAX_RETRY_AFTER_SECS);
    }

    #[test]
    fn a_pause_holds_its_origin_until_it_is_over() {
        let backoff = Backoff::default();
        let here = origin("https://spacering.net");
        let there = origin("https://staging.spacering.net");
        let start = Instant::now();
        assert_eq!(backoff.remaining_at(&here, start), None);

        backoff.hold(&here, 60, start);
        assert_eq!(backoff.remaining_at(&here, start), Some(60));
        assert_eq!(
            backoff.remaining_at(&here, start + Duration::from_millis(500)),
            Some(60),
            "a part of a second is a second still to wait"
        );
        assert_eq!(
            backoff.remaining_at(&here, start + Duration::from_secs(59)),
            Some(1)
        );
        assert_eq!(backoff.remaining_at(&there, start), None);

        // a shorter pause arriving late does not cut the longer one short
        backoff.hold(&here, 5, start);
        assert_eq!(backoff.remaining_at(&here, start), Some(60));
        backoff.hold(&here, 90, start);
        assert_eq!(backoff.remaining_at(&here, start), Some(90));

        assert_eq!(
            backoff.remaining_at(&here, start + Duration::from_secs(90)),
            None
        );
        assert_eq!(backoff.remaining_at(&here, start), None, "and it is gone");
    }

    #[test]
    fn each_answer_is_recognized_by_its_media_type() {
        assert!(Expect::Json.accepts("application/json"));
        assert!(!Expect::Json.accepts("text/html"));
        assert!(!Expect::Json.accepts(""));
        assert!(Expect::Html.accepts("text/html"));
        assert!(Expect::Text.accepts("text/plain"));
        for image in ["image/webp", "image/png", "image/jpeg", "image/gif"] {
            assert!(Expect::Image.accepts(image), "{image}");
        }
        for other in ["image/svg+xml", "text/html", "application/octet-stream", ""] {
            assert!(!Expect::Image.accepts(other), "{other}");
        }
        // a file is told by its hash, not by its type
        for any in ["application/octet-stream", "text/plain", "text/html", ""] {
            assert!(Expect::File.accepts(any), "{any}");
        }

        let mut headers = HeaderMap::new();
        assert_eq!(media_type(&headers), "");
        headers.insert(
            CONTENT_TYPE,
            "Application/JSON; charset=UTF-8".parse().unwrap(),
        );
        assert_eq!(media_type(&headers), "application/json");
    }

    #[test]
    fn immutable_is_a_directive_of_its_own() {
        let with = |value: &'static str| {
            let mut headers = HeaderMap::new();
            headers.insert(CACHE_CONTROL, value.parse().unwrap());
            is_immutable(&headers)
        };
        assert!(with("public, max-age=31536000, immutable"));
        assert!(with("Immutable"));
        assert!(with("max-age=60,IMMUTABLE , public"));
        assert!(!with("public, max-age=60, s-maxage=300"));
        assert!(!with("no-store"));
        assert!(!with("max-age=60, x-immutable"));
        assert!(!with("ext=\"not immutable\""));
        assert!(!is_immutable(&HeaderMap::new()));
    }

    /// What makes a proxy change in Settings take effect without a restart:
    /// the client is kept with the proxy settings it was built under, and
    /// different settings build another.
    #[test]
    fn the_client_is_rebuilt_when_the_proxy_settings_change() {
        let slot: RwLock<Option<KeyedClient>> = RwLock::new(None);
        let direct: Vec<(String, String)> = Vec::new();
        let proxied = vec![(
            "HTTPS_PROXY".to_string(),
            "http://127.0.0.1:7890".to_string(),
        )];

        keyed_client(&slot, direct.clone(), true).unwrap();
        assert_eq!(slot.read().unwrap().as_ref().unwrap().0, direct);
        keyed_client(&slot, direct.clone(), true).unwrap();
        assert_eq!(slot.read().unwrap().as_ref().unwrap().0, direct);

        keyed_client(&slot, proxied.clone(), true).unwrap();
        assert_eq!(slot.read().unwrap().as_ref().unwrap().0, proxied);

        // and the shared one is always the one for the settings in force
        http_client(true).unwrap();
        assert_eq!(
            HTTP_CLIENTS[1].read().unwrap().as_ref().unwrap().0,
            proxy_fingerprint()
        );
    }
}
