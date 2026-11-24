//! The Harness client against a stand-in for SpaceRing: an HTTP server on
//! loopback, started inside each test, that records what it was sent and
//! answers what the test scripts. Nothing here reaches spacering.net.

use std::io::Write as _;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::Request;
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::cache::{unix_now, Cache, PICTURE_FRESH_SECS};
use super::client::{Backoff, Limits, USER_AGENT};
use super::types::{Installed, ItemStatus, VersionStatus};
use super::{Harness, HarnessError, ItemRef, ListQuery, Origin};
use crate::commands::harness as commands;

// ─── The stand-in ───────────────────────────────────────────────────────

/// One request, as the stand-in received it.
#[derive(Debug, Clone)]
struct Seen {
    method: Method,
    /// Path and query, as sent.
    target: String,
    headers: HeaderMap,
    body: Bytes,
}

impl Seen {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|value| value.to_str().ok())
    }
}

type Script = dyn Fn(&Seen, usize) -> Response + Send + Sync;

struct Site {
    origin: String,
    seen: Arc<Mutex<Vec<Seen>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Site {
    /// Starts a site that answers each request with `script(request, n)`, `n`
    /// counting the requests before it.
    async fn start(script: impl Fn(&Seen, usize) -> Response + Send + Sync + 'static) -> Self {
        Self::start_slow(Duration::ZERO, script).await
    }

    /// The same, answering only after `delay`.
    async fn start_slow(
        delay: Duration,
        script: impl Fn(&Seen, usize) -> Response + Send + Sync + 'static,
    ) -> Self {
        let seen: Arc<Mutex<Vec<Seen>>> = Arc::default();
        let script: Arc<Script> = Arc::new(script);
        let app = axum::Router::new().fallback({
            let seen = seen.clone();
            move |request: Request| {
                let seen = seen.clone();
                let script = script.clone();
                async move {
                    let (parts, body) = request.into_parts();
                    let body = axum::body::to_bytes(body, usize::MAX)
                        .await
                        .unwrap_or_default();
                    let this = Seen {
                        method: parts.method,
                        target: parts
                            .uri
                            .path_and_query()
                            .map(|target| target.as_str().to_string())
                            .unwrap_or_default(),
                        headers: parts.headers,
                        body,
                    };
                    let before = {
                        let mut all = seen.lock().unwrap();
                        all.push(this.clone());
                        all.len() - 1
                    };
                    if !delay.is_zero() {
                        tokio::time::sleep(delay).await;
                    }
                    script(&this, before)
                }
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Self { origin, seen, task }
    }

    fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }

    fn count(&self) -> usize {
        self.seen.lock().unwrap().len()
    }
}

impl Drop for Site {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// A client of `site` with its cache under `dir`, switched on, with a pause
/// of its own (a 429 in one test must not hold another).
fn harness(site: &Site, dir: &Path) -> Harness {
    Harness {
        enabled: true,
        origin: Origin::parse(&site.origin).expect("a loopback origin"),
        cache: Cache::in_data_dir(dir),
        limits: Limits::default(),
        backoff: Box::leak(Box::new(Backoff::default())),
    }
}

fn entries(dir: &Path) -> usize {
    std::fs::read_dir(super::cache_dir(dir).join("http"))
        .map(|listing| listing.count())
        .unwrap_or(0)
}

fn with_type(content_type: &'static str, body: impl Into<Body>) -> Response {
    ([(header::CONTENT_TYPE, content_type)], body.into()).into_response()
}

fn json_reply(value: &Value) -> Response {
    with_type("application/json", value.to_string())
}

fn tagged(etag: &'static str, mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::ETAG, HeaderValue::from_static(etag));
    response
}

fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        json_reply(&json!({ "error": "not_found" })),
    )
        .into_response()
}

fn not_modified() -> Response {
    StatusCode::NOT_MODIFIED.into_response()
}

/// A body sent in pieces, so that no `Content-Length` announces its size.
fn streamed(content_type: &'static str, pieces: Vec<Vec<u8>>) -> Response {
    let stream = futures::stream::iter(
        pieces
            .into_iter()
            .map(|piece| Ok::<_, std::convert::Infallible>(Bytes::from(piece))),
    );
    with_type(content_type, Body::from_stream(stream))
}

const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3];
const AVATAR: &str = "/api/avatars/0199b5e2-6c4f-7d1a-9f2e-3c8a1b5d7e90/4f1c2a9e8b7d6c5a.png";

/// A file of a package, as `harness_blob` reads it.
const DEFINITION: &str = "name: reviewer\ndescription: 审阅改动\ntools: [Read, Grep]\n";

/// The address of `bytes` on SpaceRing: their SHA-256, in lowercase hex.
fn hash_of(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn blob_path(sha256: &str) -> String {
    format!("/api/harness/v1/blobs/{sha256}")
}

/// A well-formed hash of no file the stand-in holds.
fn any_hash() -> String {
    "0".repeat(64)
}

// ─── Browsing ───────────────────────────────────────────────────────────

#[tokio::test]
async fn each_command_asks_its_own_address_and_gives_the_answer_back() {
    let site = Site::start(|request, _| match request.target.as_str() {
        "/api/harness/v1/config" => json_reply(&json!({ "kinds": ["skill"], "review": "off" })),
        "/api/harness/v1/items" => {
            json_reply(&json!({ "items": [], "next": null, "approxTotal": 0 }))
        }
        "/api/harness/v1/items/anthropics/pdf" => json_reply(&json!({ "ref": "anthropics/pdf" })),
        "/api/harness/v1/items/anthropics/pdf/versions" => {
            json_reply(&json!({ "versions": [{ "revision": 2 }, { "revision": 1 }] }))
        }
        "/api/harness/v1/items/anthropics/pdf/readme" => {
            with_type("text/html; charset=utf-8", "<h1>PDF</h1>")
        }
        "/api/harness/v1/items/anthropics/pdf/prompt" => {
            with_type("text/plain; charset=UTF-8", "Write a haiku.")
        }
        AVATAR => with_type("image/png", PNG),
        _ => not_found(),
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let harness = harness(&site, dir.path());

    assert_eq!(
        harness.config().await.unwrap(),
        json!({ "kinds": ["skill"], "review": "off" })
    );
    assert_eq!(
        harness.list(&ListQuery::default()).await.unwrap(),
        json!({ "items": [], "next": null, "approxTotal": 0 })
    );
    assert_eq!(
        harness.item("anthropics/pdf").await.unwrap(),
        json!({ "ref": "anthropics/pdf" })
    );
    assert_eq!(
        harness.versions("anthropics/pdf").await.unwrap(),
        json!([{ "revision": 2 }, { "revision": 1 }]),
        "the array itself, not the object around it"
    );
    assert_eq!(
        harness.readme("anthropics/pdf").await.unwrap().as_deref(),
        Some("<h1>PDF</h1>")
    );
    assert_eq!(
        harness.prompt("anthropics/pdf").await.unwrap(),
        "Write a haiku."
    );
    let asset = harness.asset(AVATAR).await.unwrap();
    assert_eq!(asset.mime, "image/png");
    assert_eq!(asset.bytes, PNG);

    let seen = site.seen();
    assert_eq!(seen.len(), 7);
    assert!(seen.iter().all(|request| request.method == Method::GET));
    let accepts: Vec<&str> = seen
        .iter()
        .map(|request| request.header("accept").unwrap())
        .collect();
    assert_eq!(
        accepts,
        [
            "application/json",
            "application/json",
            "application/json",
            "application/json",
            "text/html",
            "text/plain",
            "image/webp,image/png,image/jpeg,image/gif",
        ]
    );
}

#[tokio::test]
async fn json_goes_through_with_fields_and_values_this_codeg_never_heard_of() {
    let page = json!({
        "items": [{
            "id": "0199b0aa-0000-7000-8000-000000000001",
            "ref": "anthropics/pdf",
            "kind": "workflow",
            "status": "embargoed",
            "risk": "critical",
            "title": { "en": "PDF", "zh": "PDF 表单", "ja": "PDF フォーム" },
            "publisher": { "handle": "anthropics", "kind": "consortium", "avatar": null, "badge": "gold" },
            "installs": 12345678901234_u64,
            "score": 0.25,
            "latest": { "revision": 3, "version": null, "publishedAt": "2026-10-20T08:00:00.000Z" },
            "somethingNew": { "nested": [1, "two", null, { "three": true }] }
        }],
        "next": "eyJvIjoyNH0",
        "approxTotal": 4321,
        "facets": { "kind": { "workflow": 7 } }
    });
    let detail = json!({
        "ref": "anthropics/pdf",
        "kind": "workflow",
        "install": { "version": { "status": "quarantined" }, "packages": [{ "verified": "stale" }] },
        "checks": { "review": "escalated", "findings": [{ "severity": "critical", "futureField": 1 }] },
        "readme": null,
        "futureTopLevel": ["x"]
    });
    let config = json!({
        "limits": { "zipBytes": 10485760, "futureLimit": 1 },
        "kinds": ["skill", "mcp", "prompt", "assistant", "connector", "workflow"],
        "sorts": ["popular", "new", "updated", "trending"],
        "review": "sampled"
    });
    let versions =
        json!([{ "revision": 1, "status": "quarantined", "risk": "critical", "extra": {} }]);

    let site = Site::start({
        let (page, detail, config, versions) = (
            page.clone(),
            detail.clone(),
            config.clone(),
            versions.clone(),
        );
        move |request, _| match request.target.as_str() {
            "/api/harness/v1/config" => json_reply(&config),
            "/api/harness/v1/items" => json_reply(&page),
            "/api/harness/v1/items/anthropics/pdf" => json_reply(&detail),
            "/api/harness/v1/items/anthropics/pdf/versions" => {
                json_reply(&json!({ "versions": versions, "alsoNew": 1 }))
            }
            _ => not_found(),
        }
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let harness = harness(&site, dir.path());

    assert_eq!(harness.config().await.unwrap(), config);
    assert_eq!(harness.list(&ListQuery::default()).await.unwrap(), page);
    assert_eq!(harness.item("anthropics/pdf").await.unwrap(), detail);
    assert_eq!(harness.versions("anthropics/pdf").await.unwrap(), versions);
    // and through the command, as the frontend receives it
    assert_eq!(
        commands::harness_list_core(&harness, ListQuery::default())
            .await
            .unwrap(),
        page
    );
}

#[tokio::test]
async fn a_list_query_is_sent_escaped_in_one_order() {
    let site = Site::start(|_, _| json_reply(&json!({ "items": [] }))).await;
    let dir = tempfile::tempdir().unwrap();
    let harness = harness(&site, dir.path());

    harness
        .list(&ListQuery {
            cursor: Some("eyJvIjoyNH0=".into()),
            sort: Some("popular".into()),
            runtime: Some("node".into()),
            tag: Some("docs".into()),
            kind: Some("skill".into()),
            q: Some("  a&b=c d/é#?  ".into()),
        })
        .await
        .unwrap();
    harness
        .list(&ListQuery {
            q: Some("   ".into()),
            kind: Some(String::new()),
            ..ListQuery::default()
        })
        .await
        .unwrap();

    let seen = site.seen();
    assert_eq!(
        seen[0].target,
        "/api/harness/v1/items?q=a%26b%3Dc+d%2F%C3%A9%23%3F&kind=skill&tag=docs&runtime=node&sort=popular&cursor=eyJvIjoyNH0%3D"
    );
    assert_eq!(seen[1].target, "/api/harness/v1/items");
}

// ─── What is checked before anything is sent ────────────────────────────

#[tokio::test]
async fn a_malformed_address_or_path_makes_no_request() {
    let site = Site::start(|_, _| json_reply(&json!({}))).await;
    let dir = tempfile::tempdir().unwrap();
    let harness = harness(&site, dir.path());

    for bad in [
        "",
        "pdf",
        "Anthropics/pdf",
        "anthropics/pdf/versions",
        "../pdf",
        "anthropics/..",
        "anthropics/pdf?x=1",
        "anthropics/%2e%2e",
        "https://elsewhere.example/pdf",
    ] {
        assert_eq!(
            harness.item(bad).await,
            Err(HarnessError::InvalidRef),
            "{bad:?}"
        );
        assert_eq!(harness.versions(bad).await, Err(HarnessError::InvalidRef));
        assert_eq!(harness.readme(bad).await, Err(HarnessError::InvalidRef));
        assert_eq!(harness.prompt(bad).await, Err(HarnessError::InvalidRef));
    }
    for bad in [
        "",
        "/api/me",
        "/api/harness/v1/items",
        "/api/avatars/../me",
        "/api/avatars/u/a.png?size=9999",
        "/api/avatars/%2e%2e/me",
        "https://elsewhere.example/api/avatars/u/a.png",
        "//elsewhere.example/api/avatars/u/a.png",
        "/api/harness/v1/media/../items",
    ] {
        assert_eq!(
            harness.asset(bad).await,
            Err(HarnessError::InvalidRef),
            "{bad:?}"
        );
    }
    let upper = "9F2C0D1E".repeat(8);
    let short = "a".repeat(63);
    let long = "a".repeat(65);
    let dotted = format!("../{}", "a".repeat(61));
    let queried = format!("{}?x=1", "a".repeat(60));
    for bad in [
        "",
        "9f2c",
        upper.as_str(),
        short.as_str(),
        long.as_str(),
        dotted.as_str(),
        queried.as_str(),
    ] {
        assert_eq!(
            harness.blob(bad).await,
            Err(HarnessError::InvalidRef),
            "{bad:?}"
        );
        let error = commands::harness_blob_core(&harness, bad)
            .await
            .unwrap_err();
        assert_eq!(error.i18n_key.as_deref(), Some("Harness.errors.invalidRef"));
    }
    assert_eq!(
        harness
            .install_info(&ItemRef::parse("a/b").unwrap(), 0)
            .await
            .unwrap_err(),
        HarnessError::InvalidRef
    );
    assert_eq!(
        harness
            .list(&ListQuery {
                q: Some("x".repeat(201)),
                ..ListQuery::default()
            })
            .await,
        Err(HarnessError::Server { status: 400 })
    );

    assert_eq!(site.count(), 0, "something was sent");
    assert_eq!(entries(dir.path()), 0);
}

#[tokio::test]
async fn switched_off_every_command_refuses_and_nothing_is_sent() {
    let site = Site::start(|_, _| json_reply(&json!({}))).await;
    let dir = tempfile::tempdir().unwrap();
    let mut harness = harness(&site, dir.path());
    harness.enabled = false;

    let status = commands::harness_status_core(&harness);
    assert!(!status.enabled);
    assert_eq!(status.origin, site.origin);

    let disabled = Err(HarnessError::Disabled);
    assert_eq!(harness.config().await, disabled);
    assert_eq!(harness.list(&ListQuery::default()).await, disabled);
    assert_eq!(harness.item("anthropics/pdf").await, disabled);
    assert_eq!(harness.versions("anthropics/pdf").await, disabled);
    assert_eq!(
        harness.readme("anthropics/pdf").await,
        Err(HarnessError::Disabled)
    );
    assert_eq!(
        harness.prompt("anthropics/pdf").await,
        Err(HarnessError::Disabled)
    );
    assert_eq!(harness.asset(AVATAR).await, Err(HarnessError::Disabled));
    assert_eq!(harness.blob(&any_hash()).await, Err(HarnessError::Disabled));
    assert_eq!(
        harness
            .install_info(&ItemRef::parse("a/b").unwrap(), 1)
            .await
            .unwrap_err(),
        HarnessError::Disabled
    );
    assert_eq!(
        harness
            .resolve(&[Installed {
                id: "i".into(),
                revision: 1
            }])
            .await
            .unwrap_err(),
        HarnessError::Disabled
    );
    // even what would otherwise be refused for its own reasons
    assert_eq!(harness.item("not a ref").await, disabled);
    assert_eq!(harness.asset("/api/me").await, Err(HarnessError::Disabled));
    assert_eq!(
        harness.blob("not a hash").await,
        Err(HarnessError::Disabled)
    );

    // and as the frontend is told
    for error in [
        commands::harness_config_core(&harness).await.unwrap_err(),
        commands::harness_list_core(&harness, ListQuery::default())
            .await
            .unwrap_err(),
        commands::harness_item_core(&harness, "anthropics/pdf")
            .await
            .unwrap_err(),
        commands::harness_versions_core(&harness, "anthropics/pdf")
            .await
            .unwrap_err(),
        commands::harness_readme_core(&harness, "anthropics/pdf")
            .await
            .unwrap_err(),
        commands::harness_prompt_core(&harness, "anthropics/pdf")
            .await
            .unwrap_err(),
        commands::harness_blob_core(&harness, &any_hash())
            .await
            .unwrap_err(),
        commands::srn_asset_core(&harness, AVATAR)
            .await
            .unwrap_err(),
    ] {
        assert_eq!(error.i18n_key.as_deref(), Some("Harness.errors.disabled"));
    }

    assert_eq!(site.count(), 0, "something was sent");
}

#[tokio::test]
async fn switched_on_the_status_says_so_and_names_the_origin() {
    let site = Site::start(|_, _| json_reply(&json!({}))).await;
    let dir = tempfile::tempdir().unwrap();
    let harness = harness(&site, dir.path());
    let status = commands::harness_status_core(&harness);
    assert_eq!(
        serde_json::to_value(&status).unwrap(),
        json!({ "enabled": true, "origin": site.origin })
    );
    assert!(!status.origin.ends_with('/'));
    assert_eq!(site.count(), 0);
}

// ─── The request rules ──────────────────────────────────────────────────

#[tokio::test]
async fn nothing_that_identifies_the_user_or_the_machine_is_sent() {
    // The site tries to hand out a cookie with every answer.
    let site = Site::start(|request, _| {
        let mut response = match (request.method.clone(), request.target.as_str()) {
            (Method::POST, "/api/harness/v1/resolve") => {
                json_reply(&json!({ "items": [{ "id": "i", "status": "unavailable" }] }))
            }
            (_, target) if target.ends_with("/readme") => with_type("text/html", "<p>x</p>"),
            (_, target) if target.ends_with("/prompt") => with_type("text/plain", "x"),
            (_, target) if target.starts_with("/api/avatars/") => with_type("image/png", PNG),
            (_, target) if target.ends_with("/versions/1") => json_reply(&json!({
                "item": { "id": "i", "ref": "a/b", "kind": "skill" },
                "version": { "revision": 1, "version": null, "publishedAt": "p", "status": "ok" },
                "archive": null, "source": null, "risk": "low"
            })),
            (_, target) if target.ends_with("/versions") => json_reply(&json!({ "versions": [] })),
            (_, target) if target.starts_with("/api/harness/v1/blobs/") => {
                with_type("application/octet-stream", DEFINITION)
            }
            _ => json_reply(&json!({ "items": [] })),
        };
        let headers = response.headers_mut();
        headers.insert(header::ETAG, HeaderValue::from_static("W/\"1\""));
        headers.insert(
            header::SET_COOKIE,
            HeaderValue::from_static("sid=tracked; Path=/; Max-Age=3600"),
        );
        response
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let harness = harness(&site, dir.path());
    let file = hash_of(DEFINITION.as_bytes());

    // every request there is, each twice: the second would carry a cookie
    // kept from the first, and does carry the ETag (a file is asked for
    // once: its copy is served the second time)
    for _ in 0..2 {
        assert_eq!(harness.blob(&file).await.unwrap(), DEFINITION);
        harness.config().await.unwrap();
        harness
            .list(&ListQuery {
                q: Some("pdf".into()),
                ..ListQuery::default()
            })
            .await
            .unwrap();
        harness.item("a/b").await.unwrap();
        harness.versions("a/b").await.unwrap();
        harness.readme("a/b").await.unwrap();
        harness.prompt("a/b").await.unwrap();
        harness.asset(AVATAR).await.unwrap();
        harness
            .install_info(&ItemRef::parse("a/b").unwrap(), 1)
            .await
            .unwrap();
        harness
            .resolve(&[Installed {
                id: "i".into(),
                revision: 1,
            }])
            .await
            .unwrap();
    }

    let seen = site.seen();
    assert_eq!(seen.len(), 19);
    const SENT: [&str; 8] = [
        "host",
        "user-agent",
        "accept",
        "accept-encoding",
        "if-none-match",
        "cache-control",
        "content-type",
        "content-length",
    ];
    for request in &seen {
        for name in request.headers.keys() {
            assert!(
                SENT.contains(&name.as_str()),
                "{} {} was sent with a `{name}` header",
                request.method,
                request.target
            );
        }
        for never in ["cookie", "authorization", "referer", "origin"] {
            assert_eq!(request.header(never), None, "{never} on {}", request.target);
        }
        assert_eq!(request.header("user-agent"), Some(USER_AGENT));
        assert_eq!(
            request.header("user-agent"),
            Some(concat!("codeg/", env!("CARGO_PKG_VERSION")))
        );
        // nothing rides along in the address either
        let query = request.target.split_once('?').map(|(_, query)| query);
        assert!(matches!(query, None | Some("q=pdf")), "{}", request.target);
    }
    // the only body ever sent is the list `/resolve` is asked about
    for request in &seen {
        if request.method == Method::POST {
            assert_eq!(
                serde_json::from_slice::<Value>(&request.body).unwrap(),
                json!({ "installed": [{ "id": "i", "revision": 1 }] })
            );
        } else {
            assert!(request.body.is_empty());
        }
    }
}

#[tokio::test]
async fn a_redirect_to_another_host_is_not_followed() {
    let elsewhere = Site::start(|_, _| json_reply(&json!({ "stolen": true }))).await;
    let site = Site::start({
        let target = format!("{}/api/harness/v1/config", elsewhere.origin);
        move |_, _| {
            (
                StatusCode::FOUND,
                [(header::LOCATION, target.clone())],
                "elsewhere",
            )
                .into_response()
        }
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let harness = harness(&site, dir.path());

    assert_eq!(
        harness.config().await,
        Err(HarnessError::Server { status: 302 })
    );
    assert_eq!(
        harness.asset(AVATAR).await,
        Err(HarnessError::Server { status: 302 })
    );
    assert_eq!(
        harness.blob(&any_hash()).await,
        Err(HarnessError::Server { status: 302 })
    );
    assert_eq!(
        harness
            .resolve(&[Installed {
                id: "i".into(),
                revision: 1
            }])
            .await
            .unwrap_err(),
        HarnessError::Server { status: 302 }
    );
    assert_eq!(site.count(), 4);
    assert_eq!(elsewhere.count(), 0, "the redirect was followed");
    assert_eq!(entries(dir.path()), 0);
}

#[tokio::test]
async fn a_redirect_within_the_origin_is_followed() {
    let site = Site::start(|request, _| match request.target.as_str() {
        "/api/harness/v1/config" => (
            StatusCode::TEMPORARY_REDIRECT,
            [(header::LOCATION, "/api/harness/v1/config-moved")],
        )
            .into_response(),
        "/api/harness/v1/config-moved" => json_reply(&json!({ "moved": true })),
        _ => not_found(),
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let harness = harness(&site, dir.path());
    assert_eq!(harness.config().await.unwrap(), json!({ "moved": true }));
    assert_eq!(site.count(), 2);
}

#[tokio::test]
async fn an_answer_over_the_cap_is_refused() {
    let big = json!({ "items": [], "padding": "x".repeat(4096) }).to_string();
    let site = Site::start({
        let big = big.clone();
        move |request, _| match request.target.as_str() {
            // announced: refused before a byte of it is read
            "/api/harness/v1/config" => with_type("application/json", big.clone()),
            // unannounced, in pieces: refused when it crosses the cap
            "/api/harness/v1/items" => streamed(
                "application/json",
                big.as_bytes().chunks(512).map(<[u8]>::to_vec).collect(),
            ),
            "/api/harness/v1/items/a/b/readme" => {
                streamed("text/html", vec![vec![b'x'; 600], vec![b'y'; 600]])
            }
            "/api/harness/v1/items/a/b/prompt" => with_type("text/plain", "x".repeat(1200)),
            target if target.starts_with("/api/avatars/") => {
                with_type("image/png", vec![0u8; 1200])
            }
            _ => not_found(),
        }
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let mut harness = harness(&site, dir.path());
    harness.limits = Limits {
        json_bytes: 1024,
        readme_bytes: 1024,
        prompt_bytes: 1024,
        asset_bytes: 1024,
        ..Limits::default()
    };

    assert_eq!(harness.config().await, Err(HarnessError::TooLarge));
    assert_eq!(
        harness.list(&ListQuery::default()).await,
        Err(HarnessError::TooLarge)
    );
    assert_eq!(harness.readme("a/b").await, Err(HarnessError::TooLarge));
    assert_eq!(harness.prompt("a/b").await, Err(HarnessError::TooLarge));
    assert_eq!(harness.asset(AVATAR).await, Err(HarnessError::TooLarge));
    assert_eq!(entries(dir.path()), 0, "an answer over the cap was kept");

    // the same answers fit under the caps Codeg ships with
    harness.limits = Limits::default();
    assert!(harness.config().await.is_ok());
    assert!(harness.list(&ListQuery::default()).await.is_ok());
    assert_eq!(harness.asset(AVATAR).await.unwrap().bytes.len(), 1200);
}

#[tokio::test]
async fn the_cap_counts_what_a_compressed_answer_unpacks_to() {
    // 256 KiB of JSON that travels as a few hundred bytes
    let unpacked = json!({ "items": [], "padding": "x".repeat(256 * 1024) }).to_string();
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
    encoder.write_all(unpacked.as_bytes()).unwrap();
    let packed = encoder.finish().unwrap();
    assert!(packed.len() < 2048, "{} bytes packed", packed.len());

    let site = Site::start(move |request, _| {
        assert!(
            request
                .header("accept-encoding")
                .is_some_and(|accepted| accepted.contains("gzip")),
            "the client did not offer gzip"
        );
        (
            [
                (header::CONTENT_TYPE, "application/json"),
                (header::CONTENT_ENCODING, "gzip"),
            ],
            packed.clone(),
        )
            .into_response()
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let mut harness = harness(&site, dir.path());
    harness.limits.json_bytes = 64 * 1024;
    assert_eq!(
        harness.list(&ListQuery::default()).await,
        Err(HarnessError::TooLarge)
    );
    harness.limits.json_bytes = 1024 * 1024;
    assert_eq!(
        harness.list(&ListQuery::default()).await.unwrap()["padding"]
            .as_str()
            .unwrap()
            .len(),
        256 * 1024
    );
}

#[tokio::test]
async fn a_request_that_gets_no_answer_in_time_is_a_network_failure() {
    let site = Site::start_slow(Duration::from_secs(30), |_, _| json_reply(&json!({}))).await;
    let dir = tempfile::tempdir().unwrap();
    let mut harness = harness(&site, dir.path());
    harness.limits.request_timeout = Duration::from_millis(250);

    let started = std::time::Instant::now();
    let error = harness.config().await.unwrap_err();
    assert!(matches!(error, HarnessError::Network(_)), "{error:?}");
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "waited {:?} for a deadline of 250 ms",
        started.elapsed()
    );
    let wire = crate::app_error::AppCommandError::from(error);
    assert_eq!(wire.i18n_key.as_deref(), Some("Harness.errors.network"));
}

#[tokio::test]
async fn a_site_that_is_not_there_is_a_network_failure() {
    // a port nothing listens on: bound, then let go
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let dir = tempfile::tempdir().unwrap();
    let harness = Harness {
        enabled: true,
        origin: Origin::parse(&origin).unwrap(),
        cache: Cache::in_data_dir(dir.path()),
        limits: Limits::default(),
        backoff: Box::leak(Box::new(Backoff::default())),
    };
    let error = harness.item("a/b").await.unwrap_err();
    assert!(matches!(error, HarnessError::Network(_)), "{error:?}");
}

// ─── Answers that are not a success ─────────────────────────────────────

#[tokio::test]
async fn a_429_is_reported_with_its_wait_and_nothing_more_is_sent_meanwhile() {
    let site = Site::start(|_, _| {
        (
            StatusCode::TOO_MANY_REQUESTS,
            [(header::RETRY_AFTER, "7")],
            json_reply(&json!({ "error": "rate_limited" })),
        )
            .into_response()
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let harness = harness(&site, dir.path());

    assert_eq!(
        harness.config().await,
        Err(HarnessError::RateLimited { seconds: 7 })
    );
    assert_eq!(site.count(), 1);

    // every command, not only the one that was told
    assert_eq!(
        harness.config().await,
        Err(HarnessError::RateLimited { seconds: 7 })
    );
    assert_eq!(
        harness.item("a/b").await,
        Err(HarnessError::RateLimited { seconds: 7 })
    );
    assert_eq!(
        harness.asset(AVATAR).await,
        Err(HarnessError::RateLimited { seconds: 7 })
    );
    assert_eq!(
        harness.blob(&any_hash()).await,
        Err(HarnessError::RateLimited { seconds: 7 })
    );
    assert!(matches!(
        harness
            .resolve(&[Installed {
                id: "i".into(),
                revision: 1
            }])
            .await,
        Err(HarnessError::RateLimited { seconds: 7 })
    ));
    assert_eq!(site.count(), 1, "the site was asked again within its pause");

    let error = commands::harness_config_core(&harness).await.unwrap_err();
    assert_eq!(
        error.i18n_key.as_deref(),
        Some("Harness.errors.rateLimited")
    );
    assert_eq!(
        error
            .i18n_params
            .unwrap()
            .get("seconds")
            .map(String::as_str),
        Some("7")
    );
}

#[tokio::test]
async fn a_429_without_a_usable_retry_after_asks_for_a_minute() {
    for retry_after in [None, Some("soon"), Some("Wed, 21 Oct 2026 07:28:00 GMT")] {
        let site = Site::start(move |_, _| {
            let mut response = StatusCode::TOO_MANY_REQUESTS.into_response();
            if let Some(value) = retry_after {
                response
                    .headers_mut()
                    .insert(header::RETRY_AFTER, HeaderValue::from_static(value));
            }
            response
        })
        .await;
        let dir = tempfile::tempdir().unwrap();
        let harness = harness(&site, dir.path());
        assert_eq!(
            harness.list(&ListQuery::default()).await,
            Err(HarnessError::RateLimited { seconds: 60 }),
            "{retry_after:?}"
        );
        assert_eq!(
            harness.list(&ListQuery::default()).await,
            Err(HarnessError::RateLimited { seconds: 60 })
        );
        assert_eq!(site.count(), 1);
    }
}

#[tokio::test]
async fn a_pause_that_is_over_lets_requests_through_again() {
    let site = Site::start(|_, before| {
        if before == 0 {
            (StatusCode::TOO_MANY_REQUESTS, [(header::RETRY_AFTER, "1")]).into_response()
        } else {
            json_reply(&json!({ "ok": true }))
        }
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let harness = harness(&site, dir.path());
    assert_eq!(
        harness.config().await,
        Err(HarnessError::RateLimited { seconds: 1 })
    );
    tokio::time::sleep(Duration::from_millis(1100)).await;
    assert_eq!(harness.config().await.unwrap(), json!({ "ok": true }));
    assert_eq!(site.count(), 2);
}

#[tokio::test]
async fn a_404_is_not_found_and_a_description_that_is_not_there_is_none() {
    let site = Site::start(|_, _| not_found()).await;
    let dir = tempfile::tempdir().unwrap();
    let harness = harness(&site, dir.path());

    assert_eq!(harness.item("a/b").await, Err(HarnessError::NotFound));
    assert_eq!(harness.versions("a/b").await, Err(HarnessError::NotFound));
    assert_eq!(harness.prompt("a/b").await, Err(HarnessError::NotFound));
    assert_eq!(harness.asset(AVATAR).await, Err(HarnessError::NotFound));
    assert_eq!(harness.blob(&any_hash()).await, Err(HarnessError::NotFound));
    assert_eq!(harness.readme("a/b").await, Ok(None));
    assert_eq!(
        commands::harness_readme_core(&harness, "a/b")
            .await
            .unwrap(),
        None
    );

    let error = commands::harness_item_core(&harness, "a/b")
        .await
        .unwrap_err();
    assert_eq!(error.i18n_key.as_deref(), Some("Harness.errors.notFound"));
    assert_eq!(error.i18n_params, None);
}

#[tokio::test]
async fn any_other_failure_is_reported_with_its_status() {
    for status in [400_u16, 401, 403, 500, 502, 503, 304, 301] {
        let site = Site::start(move |_, _| {
            (
                StatusCode::from_u16(status).unwrap(),
                json_reply(&json!({ "error": "x" })),
            )
                .into_response()
        })
        .await;
        let dir = tempfile::tempdir().unwrap();
        let harness = harness(&site, dir.path());
        assert_eq!(
            harness.config().await,
            Err(HarnessError::Server { status }),
            "{status}"
        );
        let error = commands::harness_config_core(&harness).await.unwrap_err();
        assert_eq!(error.i18n_key.as_deref(), Some("Harness.errors.server"));
        assert_eq!(
            error.i18n_params.unwrap().get("status"),
            Some(&status.to_string())
        );
    }
}

#[tokio::test]
async fn an_answer_that_is_not_what_was_asked_for_is_refused() {
    let site = Site::start(|request, _| match request.target.as_str() {
        // cut off
        "/api/harness/v1/config" => with_type("application/json", "{\"limits\": {"),
        // JSON, but not an object
        "/api/harness/v1/items" => json_reply(&json!(["not", "a", "page"])),
        // a page saying something else, with a 200
        "/api/harness/v1/items/a/b" => with_type("text/html", "<html>Sign in to continue</html>"),
        // no `versions`
        "/api/harness/v1/items/a/b/versions" => json_reply(&json!({ "items": [] })),
        // `versions` that is not a list
        "/api/harness/v1/items/a/c/versions" => json_reply(&json!({ "versions": {} })),
        // not text
        "/api/harness/v1/items/a/b/readme" => with_type("text/html", vec![0xff_u8, 0xfe, 0x00]),
        // JSON where text was asked for
        "/api/harness/v1/items/a/b/prompt" => json_reply(&json!({ "text": "x" })),
        // a page of items without its items
        "/api/harness/v1/items?kind=skill" => json_reply(&json!({ "next": null })),
        // no content type at all
        "/api/harness/v1/items/a/d" => "{}".into_response().tap_without_type(),
        _ => not_found(),
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let harness = harness(&site, dir.path());

    let refused = |result: Result<Value, HarnessError>| {
        assert!(
            matches!(result, Err(HarnessError::InvalidResponse(_))),
            "{result:?}"
        )
    };
    refused(harness.config().await);
    refused(harness.list(&ListQuery::default()).await);
    refused(harness.item("a/b").await);
    refused(harness.versions("a/b").await);
    refused(harness.versions("a/c").await);
    refused(harness.item("a/d").await);
    refused(
        harness
            .list(&ListQuery {
                kind: Some("skill".into()),
                ..ListQuery::default()
            })
            .await,
    );
    assert!(matches!(
        harness.readme("a/b").await,
        Err(HarnessError::InvalidResponse(_))
    ));
    assert!(matches!(
        harness.prompt("a/b").await,
        Err(HarnessError::InvalidResponse(_))
    ));

    let error = commands::harness_config_core(&harness).await.unwrap_err();
    assert_eq!(
        error.i18n_key.as_deref(),
        Some("Harness.errors.invalidResponse")
    );
}

/// Strips the content type axum gives a string body.
trait WithoutType {
    fn tap_without_type(self) -> Response;
}

impl WithoutType for Response {
    fn tap_without_type(mut self) -> Response {
        self.headers_mut().remove(header::CONTENT_TYPE);
        self
    }
}

// ─── Pictures ───────────────────────────────────────────────────────────

#[tokio::test]
async fn only_a_picture_is_accepted_as_a_picture() {
    let site = Site::start(|request, _| match request.target.as_str() {
        "/api/avatars/u/page.png" => with_type("text/html", "<html></html>"),
        "/api/avatars/u/drawing.png" => with_type("image/svg+xml", "<svg onload=\"x()\"/>"),
        "/api/avatars/u/bytes.png" => with_type("application/octet-stream", PNG),
        "/api/avatars/u/untyped.png" => PNG.into_response().tap_without_type(),
        "/api/avatars/u/a.png" => with_type("image/png", PNG),
        "/api/avatars/u/a.jpg" => with_type("image/jpeg", PNG),
        "/api/harness/v1/media/abc.webp" => with_type("IMAGE/WEBP", PNG),
        "/api/harness/v1/media/abc.gif" => with_type("image/gif; note=x", PNG),
        _ => not_found(),
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let harness = harness(&site, dir.path());

    for refused in [
        "/api/avatars/u/page.png",
        "/api/avatars/u/drawing.png",
        "/api/avatars/u/bytes.png",
        "/api/avatars/u/untyped.png",
    ] {
        let result = harness.asset(refused).await;
        assert!(
            matches!(result, Err(HarnessError::InvalidResponse(_))),
            "{refused}: {result:?}"
        );
    }
    for (path, mime) in [
        ("/api/avatars/u/a.png", "image/png"),
        ("/api/avatars/u/a.jpg", "image/jpeg"),
        ("/api/harness/v1/media/abc.webp", "image/webp"),
        ("/api/harness/v1/media/abc.gif", "image/gif"),
    ] {
        let asset = harness.asset(path).await.unwrap();
        assert_eq!(asset.mime, mime, "{path}");
        assert_eq!(asset.bytes, PNG);
    }
}

#[tokio::test]
async fn a_picture_reaches_the_frontend_as_the_pet_marketplace_s_does() {
    let site = Site::start(|_, _| with_type("image/png", PNG)).await;
    let dir = tempfile::tempdir().unwrap();
    let harness = harness(&site, dir.path());

    let asset = commands::srn_asset_core(&harness, AVATAR).await.unwrap();
    // `{ mime, dataBase64 }`: what `pet_marketplace_asset` answers
    assert_eq!(
        serde_json::to_value(&asset).unwrap(),
        json!({ "mime": "image/png", "dataBase64": "iVBORw0KGgoAAQID" })
    );
    assert_eq!(site.seen()[0].target, AVATAR);

    let error = commands::srn_asset_core(&harness, "/api/me")
        .await
        .unwrap_err();
    assert_eq!(error.i18n_key.as_deref(), Some("Harness.errors.invalidRef"));
    assert_eq!(site.count(), 1);
}

// ─── A package's files, by their hashes ─────────────────────────────────

#[tokio::test]
async fn a_file_is_read_by_its_hash_once_and_then_served_from_its_copy() {
    let sha = hash_of(DEFINITION.as_bytes());
    // As SpaceRing serves a file: bytes, an ETag, immutable. Anything else
    // is over its rate limit.
    let site = Site::start({
        let path = blob_path(&sha);
        move |request, _| {
            if request.target != path {
                return (StatusCode::TOO_MANY_REQUESTS, [(header::RETRY_AFTER, "30")])
                    .into_response();
            }
            let mut response = with_type("application/octet-stream", DEFINITION);
            let headers = response.headers_mut();
            headers.insert(header::ETAG, HeaderValue::from_static("\"blob\""));
            headers.insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static("public, max-age=31536000, immutable"),
            );
            response
        }
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let harness = harness(&site, dir.path());

    assert_eq!(harness.blob(&sha).await.unwrap(), DEFINITION);
    let seen = site.seen();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].method, Method::GET);
    assert_eq!(seen[0].target, blob_path(&sha));
    assert_eq!(seen[0].header("accept"), Some("application/octet-stream"));
    assert_eq!(seen[0].header("if-none-match"), None);
    assert_eq!(entries(dir.path()), 1);

    // the copy, without a request: not even one to revalidate it
    assert_eq!(harness.blob(&sha).await.unwrap(), DEFINITION);
    assert_eq!(
        commands::harness_blob_core(&harness, &sha).await.unwrap(),
        DEFINITION
    );
    // by a client started later too: the copy is on disk
    assert_eq!(
        self::harness(&site, dir.path()).blob(&sha).await.unwrap(),
        DEFINITION
    );
    assert_eq!(site.count(), 1, "a file that was kept was asked for again");

    // and while the site has asked for a pause
    assert_eq!(
        harness.config().await,
        Err(HarnessError::RateLimited { seconds: 30 })
    );
    assert_eq!(harness.blob(&sha).await.unwrap(), DEFINITION);
    assert_eq!(site.count(), 2);
    assert_eq!(entries(dir.path()), 1);
}

#[tokio::test]
async fn a_file_is_told_by_its_hash_not_by_its_type() {
    let files: Vec<(&'static str, String)> = ["one", "two", "three"]
        .into_iter()
        .map(|text| (text, hash_of(text.as_bytes())))
        .collect();
    let site = Site::start({
        let files = files.clone();
        move |request, _| {
            let found = files
                .iter()
                .find(|(_, sha)| request.target == blob_path(sha));
            match found {
                Some(&("one", _)) => with_type("text/plain; charset=utf-8", "one"),
                Some(&("two", _)) => with_type("text/html", "two"),
                Some(&(text, _)) => text.into_response().tap_without_type(),
                None => not_found(),
            }
        }
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let harness = harness(&site, dir.path());
    for (text, sha) in &files {
        assert_eq!(harness.blob(sha).await.unwrap(), *text);
    }
}

#[tokio::test]
async fn a_file_that_does_not_hash_to_its_address_is_refused_and_not_kept() {
    let asked = hash_of(DEFINITION.as_bytes());
    let site = Site::start(|_, _| {
        tagged(
            "\"x\"",
            with_type("application/octet-stream", "name: someone else\n"),
        )
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let harness = harness(&site, dir.path());

    for _ in 0..2 {
        let result = harness.blob(&asked).await;
        assert!(
            matches!(result, Err(HarnessError::InvalidResponse(_))),
            "{result:?}"
        );
    }
    assert_eq!(site.count(), 2, "a refused answer was served from a copy");
    assert_eq!(entries(dir.path()), 0, "a refused answer was kept");
    let error = commands::harness_blob_core(&harness, &asked)
        .await
        .unwrap_err();
    assert_eq!(
        error.i18n_key.as_deref(),
        Some("Harness.errors.invalidResponse")
    );
}

#[tokio::test]
async fn a_copy_that_no_longer_matches_its_hash_is_fetched_again() {
    let sha = hash_of(DEFINITION.as_bytes());
    let site = Site::start(|_, _| with_type("application/octet-stream", DEFINITION)).await;
    let dir = tempfile::tempdir().unwrap();
    let harness = harness(&site, dir.path());
    assert_eq!(harness.blob(&sha).await.unwrap(), DEFINITION);

    // the copy on disk changes under it: a disk fault, another program
    let key = format!("{}{}", site.origin, blob_path(&sha));
    let mut copy = harness.cache.load(&key).expect("the file's copy");
    copy.body = b"name: someone else\n".to_vec();
    harness.cache.store(&key, &copy);

    assert_eq!(harness.blob(&sha).await.unwrap(), DEFINITION);
    assert_eq!(site.count(), 2);
    assert_eq!(
        harness.cache.load(&key).expect("the file's copy").body,
        DEFINITION.as_bytes()
    );
}

#[tokio::test]
async fn a_file_over_256_kib_is_too_large() {
    let at_cap = "x".repeat(256 * 1024);
    let over_cap = "y".repeat(256 * 1024 + 1);
    let (fits, announced, unannounced) = (
        hash_of(at_cap.as_bytes()),
        hash_of(over_cap.as_bytes()),
        any_hash(),
    );
    let site = Site::start({
        let (fits, announced) = (blob_path(&fits), blob_path(&announced));
        move |request, _| {
            if request.target == fits {
                with_type("application/octet-stream", at_cap.clone())
            } else if request.target == announced {
                // refused by its length, before a byte of it is read
                with_type("application/octet-stream", over_cap.clone())
            } else {
                // in pieces with no length: refused when it crosses the cap
                streamed(
                    "application/octet-stream",
                    vec![vec![b'z'; 200 * 1024], vec![b'z'; 200 * 1024]],
                )
            }
        }
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let harness = harness(&site, dir.path());
    assert_eq!(Limits::default().blob_bytes, 256 * 1024);

    assert_eq!(harness.blob(&announced).await, Err(HarnessError::TooLarge));
    assert_eq!(
        harness.blob(&unannounced).await,
        Err(HarnessError::TooLarge)
    );
    assert_eq!(entries(dir.path()), 0, "an answer over the cap was kept");
    let error = commands::harness_blob_core(&harness, &announced)
        .await
        .unwrap_err();
    assert_eq!(error.i18n_key.as_deref(), Some("Harness.errors.tooLarge"));

    // exactly at the cap is a file
    assert_eq!(harness.blob(&fits).await.unwrap().len(), 256 * 1024);
}

#[tokio::test]
async fn a_file_that_is_not_utf8_text_is_refused() {
    const BYTES: &[u8] = &[b'a', 0xff, 0xfe, b'b', 0x00];
    let sha = hash_of(BYTES);
    let site = Site::start(|_, _| with_type("application/octet-stream", BYTES)).await;
    let dir = tempfile::tempdir().unwrap();
    let harness = harness(&site, dir.path());

    let result = harness.blob(&sha).await;
    assert!(
        matches!(result, Err(HarnessError::InvalidResponse(_))),
        "{result:?}"
    );
    // It is the file, so its copy is kept; it is not text, so it is refused
    // again from the copy, without asking.
    let error = commands::harness_blob_core(&harness, &sha)
        .await
        .unwrap_err();
    assert_eq!(
        error.i18n_key.as_deref(),
        Some("Harness.errors.invalidResponse")
    );
    assert_eq!(site.count(), 1);
}

// ─── The cache ──────────────────────────────────────────────────────────

#[tokio::test]
async fn an_unchanged_answer_is_served_from_the_copy_kept() {
    // The site's item changes once: v1 until the third request, v2 after.
    let site = Site::start(|request, before| {
        let (etag, body) = if before < 2 {
            ("W/\"v1\"", json!({ "ref": "a/b", "rev": 1 }))
        } else {
            ("W/\"v2\"", json!({ "ref": "a/b", "rev": 2 }))
        };
        if request.header("if-none-match") == Some(etag) {
            tagged(etag, not_modified())
        } else {
            tagged(etag, json_reply(&body))
        }
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let harness = harness(&site, dir.path());

    // first: nothing kept, nothing to offer
    assert_eq!(
        harness.item("a/b").await.unwrap(),
        json!({ "ref": "a/b", "rev": 1 })
    );
    assert_eq!(entries(dir.path()), 1);
    // second: unchanged, served from the copy
    assert_eq!(
        harness.item("a/b").await.unwrap(),
        json!({ "ref": "a/b", "rev": 1 })
    );
    // third: changed, replaced
    assert_eq!(
        harness.item("a/b").await.unwrap(),
        json!({ "ref": "a/b", "rev": 2 })
    );
    // fourth: unchanged again, the newer copy
    assert_eq!(
        harness.item("a/b").await.unwrap(),
        json!({ "ref": "a/b", "rev": 2 })
    );
    assert_eq!(entries(dir.path()), 1);

    let offered: Vec<Option<String>> = site
        .seen()
        .iter()
        .map(|request| request.header("if-none-match").map(str::to_string))
        .collect();
    assert_eq!(
        offered,
        [
            None,
            Some("W/\"v1\"".to_string()),
            Some("W/\"v1\"".to_string()),
            Some("W/\"v2\"".to_string()),
        ]
    );

    // A client started later finds the copy: it is on disk, not in memory.
    let later = self::harness(&site, dir.path());
    assert_eq!(
        later.item("a/b").await.unwrap(),
        json!({ "ref": "a/b", "rev": 2 })
    );
    assert_eq!(
        site.seen().last().unwrap().header("if-none-match"),
        Some("W/\"v2\"")
    );
}

#[tokio::test]
async fn every_kind_of_answer_is_kept_and_revalidated() {
    let site = Site::start(|request, _| {
        if request.header("if-none-match") == Some("\"same\"") {
            return tagged("\"same\"", not_modified());
        }
        let response = match request.target.as_str() {
            target if target.ends_with("/readme") => with_type("text/html", "<p>kept</p>"),
            target if target.ends_with("/prompt") => with_type("text/plain", "kept"),
            target if target.starts_with("/api/avatars/") => with_type("image/png", PNG),
            target if target.ends_with("/versions") => json_reply(&json!({ "versions": [1] })),
            target if target.starts_with("/api/harness/v1/items") => {
                json_reply(&json!({ "items": ["kept"] }))
            }
            _ => json_reply(&json!({ "kept": true })),
        };
        tagged("\"same\"", response)
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let harness = harness(&site, dir.path());

    for round in 0..2 {
        assert_eq!(harness.config().await.unwrap(), json!({ "kept": true }));
        assert_eq!(
            harness.list(&ListQuery::default()).await.unwrap(),
            json!({ "items": ["kept"] })
        );
        assert_eq!(harness.versions("a/b").await.unwrap(), json!([1]));
        assert_eq!(
            harness.readme("a/b").await.unwrap().as_deref(),
            Some("<p>kept</p>")
        );
        assert_eq!(harness.prompt("a/b").await.unwrap(), "kept");
        let asset = harness.asset(AVATAR).await.unwrap();
        assert_eq!(
            (asset.mime.as_str(), asset.bytes.as_slice()),
            ("image/png", PNG)
        );
        assert_eq!(entries(dir.path()), 6, "round {round}");
    }
    let seen = site.seen();
    assert_eq!(seen.len(), 12);
    assert!(seen[..6]
        .iter()
        .all(|request| request.header("if-none-match").is_none()));
    assert!(seen[6..]
        .iter()
        .all(|request| request.header("if-none-match") == Some("\"same\"")));
}

#[tokio::test]
async fn a_picture_the_site_calls_immutable_is_asked_for_once() {
    const MEDIA: &str = "/api/harness/v1/media/abc.webp";
    const PLAIN: &str = "/api/avatars/u/plain.png";
    // Media is immutable; one avatar is not; `/config` claims to be, which
    // only a picture may; listing is over its rate limit.
    let site = Site::start(|request, _| {
        let (etag, policy, response) = match request.target.as_str() {
            MEDIA => (
                "\"m\"",
                "public, max-age=31536000, immutable",
                with_type("image/webp", PNG),
            ),
            PLAIN => ("\"p\"", "public, max-age=60", with_type("image/png", PNG)),
            "/api/harness/v1/config" => (
                "\"c\"",
                "public, max-age=60, immutable",
                json_reply(&json!({ "kinds": [] })),
            ),
            _ => {
                return (StatusCode::TOO_MANY_REQUESTS, [(header::RETRY_AFTER, "30")])
                    .into_response()
            }
        };
        let mut response = if request.header("if-none-match") == Some(etag) {
            not_modified()
        } else {
            response
        };
        let headers = response.headers_mut();
        headers.insert(header::ETAG, HeaderValue::from_static(etag));
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(policy));
        response
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let harness = harness(&site, dir.path());
    let asked = |target: &str| {
        site.seen()
            .iter()
            .filter(|request| request.target == target)
            .count()
    };

    for _ in 0..3 {
        let asset = harness.asset(MEDIA).await.unwrap();
        assert_eq!(
            (asset.mime.as_str(), asset.bytes.as_slice()),
            ("image/webp", PNG)
        );
        harness.asset(PLAIN).await.unwrap();
        harness.config().await.unwrap();
    }
    assert_eq!(asked(MEDIA), 1, "an immutable picture was asked for again");
    assert_eq!(
        asked(PLAIN),
        3,
        "a picture that may change was not asked about"
    );
    assert_eq!(
        asked("/api/harness/v1/config"),
        3,
        "what the catalog says was served without asking"
    );

    // the copy is on disk: a client started later does not ask either
    self::harness(&site, dir.path()).asset(MEDIA).await.unwrap();
    assert_eq!(asked(MEDIA), 1);

    // and it needs no request, so a pause does not hold it
    assert_eq!(
        harness.list(&ListQuery::default()).await,
        Err(HarnessError::RateLimited { seconds: 30 })
    );
    assert_eq!(harness.asset(MEDIA).await.unwrap().bytes, PNG);
    assert_eq!(
        harness.asset(PLAIN).await,
        Err(HarnessError::RateLimited { seconds: 30 })
    );

    // Past its time the copy is asked about once, and is fresh again.
    let later = self::harness(&site, dir.path());
    let key = format!("{}{MEDIA}", site.origin);
    let mut entry = later.cache.load(&key).expect("the picture's copy");
    let fresh_until = entry.fresh_until.expect("kept as fresh");
    assert!(fresh_until > unix_now() && fresh_until <= unix_now() + PICTURE_FRESH_SECS);
    entry.fresh_until = Some(unix_now() - 1);
    later.cache.store(&key, &entry);

    assert_eq!(later.asset(MEDIA).await.unwrap().bytes, PNG);
    assert_eq!(asked(MEDIA), 2);
    assert_eq!(
        site.seen().last().unwrap().header("if-none-match"),
        Some("\"m\"")
    );
    assert_eq!(later.asset(MEDIA).await.unwrap().bytes, PNG);
    assert_eq!(asked(MEDIA), 2);

    // what `/config` claimed was not written down
    let config = later
        .cache
        .load(&format!("{}/api/harness/v1/config", site.origin))
        .expect("the config's copy");
    assert_eq!(config.fresh_until, None);
}

#[tokio::test]
async fn each_question_has_its_own_copy() {
    let site = Site::start(|request, _| {
        tagged(
            "\"t\"",
            json_reply(&json!({ "items": [request.target.clone()] })),
        )
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let harness = harness(&site, dir.path());
    let of = |kind: &str| ListQuery {
        kind: Some(kind.into()),
        ..ListQuery::default()
    };

    harness.list(&of("skill")).await.unwrap();
    harness.list(&of("mcp")).await.unwrap();
    harness.list(&ListQuery::default()).await.unwrap();
    assert_eq!(entries(dir.path()), 3);
    assert!(
        site.seen()
            .iter()
            .all(|request| request.header("if-none-match").is_none()),
        "one question's ETag was offered for another"
    );

    // and another origin's copy of the same path is not this one's
    let other = Site::start(|_, _| tagged("\"t\"", json_reply(&json!({ "items": [] })))).await;
    self::harness(&other, dir.path())
        .list(&of("skill"))
        .await
        .unwrap();
    assert_eq!(other.seen()[0].header("if-none-match"), None);
    assert_eq!(entries(dir.path()), 4);
}

#[tokio::test]
async fn an_answer_without_an_etag_is_not_kept_and_a_404_clears_the_copy() {
    let site = Site::start(|_, before| match before {
        0 => tagged("\"1\"", json_reply(&json!({ "n": 0 }))),
        1 => json_reply(&json!({ "n": 1 })),
        2 => json_reply(&json!({ "n": 2 })),
        3 => tagged("\"4\"", json_reply(&json!({ "n": 3 }))),
        _ => not_found(),
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let harness = harness(&site, dir.path());

    harness.item("a/b").await.unwrap();
    assert_eq!(entries(dir.path()), 1);
    // no ETag: nothing to revalidate with, and the older copy is stale
    assert_eq!(harness.item("a/b").await.unwrap(), json!({ "n": 1 }));
    assert_eq!(entries(dir.path()), 0);
    harness.item("a/b").await.unwrap();
    assert_eq!(site.seen()[2].header("if-none-match"), None);

    harness.item("a/b").await.unwrap();
    assert_eq!(entries(dir.path()), 1);
    assert_eq!(harness.item("a/b").await, Err(HarnessError::NotFound));
    assert_eq!(entries(dir.path()), 0, "a removed item's copy stayed");
}

#[tokio::test]
async fn a_failure_never_serves_the_copy_kept() {
    // Kept once; after that the site fails in every way it can.
    let site = Site::start(|_, before| match before {
        0 => tagged("\"1\"", json_reply(&json!({ "kept": true }))),
        1 => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        2 => with_type("application/json", "{"),
        _ => (StatusCode::TOO_MANY_REQUESTS, [(header::RETRY_AFTER, "30")]).into_response(),
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let harness = harness(&site, dir.path());

    assert_eq!(harness.config().await.unwrap(), json!({ "kept": true }));
    assert_eq!(
        harness.config().await,
        Err(HarnessError::Server { status: 500 })
    );
    assert!(matches!(
        harness.config().await,
        Err(HarnessError::InvalidResponse(_))
    ));
    assert_eq!(
        harness.config().await,
        Err(HarnessError::RateLimited { seconds: 30 })
    );
    assert_eq!(
        harness.config().await,
        Err(HarnessError::RateLimited { seconds: 30 })
    );
}

#[tokio::test]
async fn the_cache_stays_within_its_bounds() {
    let site = Site::start(|request, _| {
        tagged(
            "\"t\"",
            json_reply(&json!({ "ref": request.target.clone(), "padding": "x".repeat(300) })),
        )
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let http = super::cache_dir(dir.path()).join("http");

    // by number
    let mut harness = harness(&site, dir.path());
    harness.cache = Cache::with_bounds(http.clone(), 3, 1 << 20);
    for name in ["a", "b", "c", "d", "e", "f"] {
        harness.item(&format!("p/{name}")).await.unwrap();
        assert!(entries(dir.path()) <= 3, "after p/{name}");
    }
    assert_eq!(entries(dir.path()), 3);

    // by size: each entry is some 500 bytes
    harness.cache = Cache::with_bounds(http.clone(), 100, 1_200);
    for name in ["g", "h", "i", "j"] {
        harness.item(&format!("p/{name}")).await.unwrap();
        let bytes: u64 = std::fs::read_dir(&http)
            .unwrap()
            .flatten()
            .map(|file| file.metadata().unwrap().len())
            .sum();
        assert!(bytes <= 1_200, "{bytes} bytes kept after p/{name}");
    }
    assert_eq!(entries(dir.path()), 2);
    assert!(
        std::fs::read_dir(&http)
            .unwrap()
            .flatten()
            .all(|file| file.file_name().to_string_lossy().ends_with(".entry")),
        "a temporary file was left behind"
    );
}

#[tokio::test]
async fn a_cache_that_cannot_be_written_does_not_fail_a_command() {
    let site = Site::start(|_, _| tagged("\"t\"", json_reply(&json!({ "ok": true })))).await;
    let dir = tempfile::tempdir().unwrap();
    // a file where the cache directory should be
    std::fs::write(dir.path().join("cache"), b"").unwrap();
    let harness = harness(&site, dir.path());
    assert_eq!(harness.config().await.unwrap(), json!({ "ok": true }));
    assert_eq!(harness.config().await.unwrap(), json!({ "ok": true }));
    assert_eq!(site.seen()[1].header("if-none-match"), None);
}

// ─── What an install is decided on ──────────────────────────────────────

#[tokio::test]
async fn install_info_is_one_revision_typed() {
    let site = Site::start(|request, _| match request.target.as_str() {
        "/api/harness/v1/items/anthropics/pdf/versions/3" => tagged(
            "\"i\"",
            json_reply(&json!({
                "item": { "id": "0199b0aa-0000-7000-8000-000000000001", "ref": "anthropics/pdf",
                          "kind": "skill", "title": { "en": "PDF" } },
                "version": { "revision": 3, "version": "1.2.0",
                             "publishedAt": "2026-10-20T08:00:00.000Z", "status": "quarantined" },
                "archive": { "url": "/api/harness/v1/archives/9f2c.zip", "sha256": "9f2c", "size": 48213 },
                "files": [{ "path": "SKILL.md", "sha256": "ab", "size": 2201, "executable": false }],
                "source": null,
                "skill": { "name": "pdf", "description": "Fill PDF forms" },
                "permissions": { "runsCode": ["python"] },
                "risk": "low", "reviewed": true, "advisories": [],
                "somethingNew": 1
            })),
        ),
        // answers another revision than the one asked for
        "/api/harness/v1/items/anthropics/pdf/versions/4" => json_reply(&json!({
            "item": { "id": "i", "ref": "anthropics/pdf", "kind": "skill" },
            "version": { "revision": 3, "version": null, "publishedAt": "p", "status": "ok" },
            "archive": null, "source": null, "risk": "low"
        })),
        // not an install info
        "/api/harness/v1/items/anthropics/pdf/versions/5" => json_reply(&json!({ "versions": [] })),
        _ => not_found(),
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let harness = harness(&site, dir.path());
    let pdf = ItemRef::parse("anthropics/pdf").unwrap();

    let info = harness.install_info(&pdf, 3).await.unwrap();
    assert_eq!(info.item.id, "0199b0aa-0000-7000-8000-000000000001");
    assert_eq!(info.version.revision, 3);
    assert_eq!(
        info.version.status,
        VersionStatus::Unknown,
        "a status this Codeg does not know must not read as ok"
    );
    assert_eq!(info.files[0].sha256, "ab");
    assert_eq!(
        info.archive.unwrap().url,
        "/api/harness/v1/archives/9f2c.zip"
    );

    assert!(matches!(
        harness.install_info(&pdf, 4).await,
        Err(HarnessError::InvalidResponse(_))
    ));
    assert!(matches!(
        harness.install_info(&pdf, 5).await,
        Err(HarnessError::InvalidResponse(_))
    ));
    assert_eq!(
        harness.install_info(&pdf, 6).await.unwrap_err(),
        HarnessError::NotFound
    );
}

#[tokio::test]
async fn resolve_is_asked_fresh_and_never_kept() {
    let site = Site::start(|_, before| {
        // an ETag, which a cache would take as an invitation
        tagged(
            "\"r\"",
            json_reply(&json!({ "items": [
                { "id": "a", "status": "public", "ref": "anthropics/pdf", "kind": "skill",
                  "latest": { "revision": 4, "version": "1.3.0", "publishedAt": "p" },
                  "advisories": [],
                  "installed": { "revision": 3, "status": if before == 0 { "ok" } else { "blocked" },
                                 "risk": "low", "reviewed": true,
                                 "permissions": { "declared": {}, "detected": {} },
                                 "checks": { "findings": { "low": 0, "medium": 0, "high": 0 },
                                             "secrets": 0, "review": "off" },
                                 "packages": [],
                                 "stateSha256": if before == 0 { "one" } else { "two" } } },
                { "id": "b", "status": "unavailable" }
            ] })),
        )
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let harness = harness(&site, dir.path());
    let asked = [
        Installed {
            id: "a".into(),
            revision: 3,
        },
        Installed {
            id: "b".into(),
            revision: 1,
        },
    ];

    let first = harness.resolve(&asked).await.unwrap();
    assert_eq!(first.len(), 2);
    assert_eq!(first[0].status, ItemStatus::Public);
    let state = first[0].installed.as_ref().unwrap();
    assert_eq!(state.status, VersionStatus::Ok);
    assert_eq!(state.state_sha256.as_deref(), Some("one"));
    assert_eq!(first[1].status, ItemStatus::Unavailable);

    // The revision was blocked in between: the second answer says so.
    let second = harness.resolve(&asked).await.unwrap();
    let state = second[0].installed.as_ref().unwrap();
    assert_eq!(state.status, VersionStatus::Blocked);
    assert_eq!(state.state_sha256.as_deref(), Some("two"));

    assert_eq!(entries(dir.path()), 0, "a /resolve answer was kept");
    let seen = site.seen();
    assert_eq!(seen.len(), 2);
    for request in &seen {
        assert_eq!(request.method, Method::POST);
        assert_eq!(request.target, "/api/harness/v1/resolve");
        assert_eq!(request.header("cache-control"), Some("no-store"));
        assert_eq!(request.header("content-type"), Some("application/json"));
        assert_eq!(request.header("accept"), Some("application/json"));
        assert_eq!(request.header("if-none-match"), None);
        assert_eq!(
            serde_json::from_slice::<Value>(&request.body).unwrap(),
            json!({ "installed": [{ "id": "a", "revision": 3 }, { "id": "b", "revision": 1 }] })
        );
    }
}

#[tokio::test]
async fn resolve_refuses_an_answer_that_does_not_pair_with_what_was_asked() {
    let asked = [
        Installed {
            id: "a".into(),
            revision: 3,
        },
        Installed {
            id: "b".into(),
            revision: 1,
        },
    ];
    for answer in [
        // one short
        json!({ "items": [{ "id": "a", "status": "unavailable" }] }),
        // one too many
        json!({ "items": [{ "id": "a", "status": "unavailable" }, { "id": "b", "status": "unavailable" },
                          { "id": "c", "status": "unavailable" }] }),
        // out of order
        json!({ "items": [{ "id": "b", "status": "unavailable" }, { "id": "a", "status": "unavailable" }] }),
        // the state of another revision
        json!({ "items": [{ "id": "a", "status": "retired", "installed": { "revision": 2, "status": "ok" } },
                          { "id": "b", "status": "unavailable" }] }),
        // not an answer
        json!({ "error": "invalid_request" }),
        json!([]),
    ] {
        let site = Site::start({
            let answer = answer.clone();
            move |_, _| json_reply(&answer)
        })
        .await;
        let dir = tempfile::tempdir().unwrap();
        let harness = harness(&site, dir.path());
        let result = harness.resolve(&asked).await;
        assert!(
            matches!(result, Err(HarnessError::InvalidResponse(_))),
            "{answer}: {result:?}"
        );
    }
}

#[tokio::test]
async fn resolve_asks_a_hundred_at_a_time_and_keeps_the_order() {
    let site = Site::start(|request, _| {
        let asked: Value = serde_json::from_slice(&request.body).unwrap();
        let items: Vec<Value> = asked["installed"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| json!({ "id": item["id"], "status": "unavailable" }))
            .collect();
        json_reply(&json!({ "items": items }))
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let harness = harness(&site, dir.path());
    let asked: Vec<Installed> = (0..230)
        .map(|n| Installed {
            id: format!("item-{n}"),
            revision: 1,
        })
        .collect();

    let resolved = harness.resolve(&asked).await.unwrap();
    assert_eq!(resolved.len(), 230);
    assert!(resolved
        .iter()
        .zip(&asked)
        .all(|(item, asked)| item.id == asked.id));
    let sizes: Vec<usize> = site
        .seen()
        .iter()
        .map(|request| {
            serde_json::from_slice::<Value>(&request.body).unwrap()["installed"]
                .as_array()
                .unwrap()
                .len()
        })
        .collect();
    assert_eq!(sizes, [100, 100, 30]);

    // nothing installed: nothing to ask
    assert!(harness.resolve(&[]).await.unwrap().is_empty());
    assert_eq!(site.count(), 3);
}

// ─── Who reaches the catalog ────────────────────────────────────────────

/// `codeg-mcp` offers agents the tools of one embedded list (plus
/// `submit_result`, whose schema a run brings with it). None of them reaches
/// the catalog: an install is something only a person confirms, in the
/// interface.
#[test]
fn codeg_mcp_offers_agents_no_harness_tool() {
    let tools: Vec<Value> =
        serde_json::from_str(crate::acp::delegation::companion::TOOL_SCHEMA_JSON)
            .expect("the companion's tool list");
    assert!(!tools.is_empty());
    for tool in &tools {
        let name = tool["name"].as_str().expect("a tool's name");
        assert!(
            !name.contains("harness") && !name.starts_with("srn"),
            "codeg-mcp offers `{name}`"
        );
    }
}

// ─── `/resolve` missing, and connections dropped under a request ────────

/// QA finding: a site that does not serve `/resolve` yet answers it 404,
/// with the same body as a missing item. `/resolve` never answers an item it
/// does not have that way (that is `unavailable`, in the body), so the 404
/// is the endpoint's: not "no item at this address".
#[tokio::test]
async fn a_resolve_that_is_not_there_is_not_a_missing_item() {
    let site = Site::start(|_, _| not_found()).await;
    let dir = tempfile::tempdir().unwrap();
    let harness = harness(&site, dir.path());
    let error = harness
        .resolve(&[Installed {
            id: "a".into(),
            revision: 1,
        }])
        .await
        .unwrap_err();
    assert_eq!(error, HarnessError::ResolveUnavailable);
    let wire = crate::app_error::AppCommandError::from(error);
    assert_eq!(
        wire.i18n_key.as_deref(),
        Some("Harness.errors.resolveUnavailable")
    );
    // an item the site does not have is still not found
    assert_eq!(
        harness.item("acme/notes").await.unwrap_err(),
        HarnessError::NotFound
    );
}

/// What a hand-written HTTP/1.1 server does with one request.
#[derive(Debug, Clone, Copy)]
enum Reply {
    /// Answer with this status (a JSON body: `/resolve`'s for a POST).
    Answer(u16),
    /// Close the connection without an answer: a pooled connection a proxy
    /// let go of just as the request went out.
    Close,
    /// Answer nothing for half a minute.
    Hang,
}

/// A server that speaks HTTP/1.1 by hand, so that a test decides what each
/// connection does with each request on it (`script(connection, request)`,
/// both counted from 0).
struct RawSite {
    origin: String,
    /// Per request: its connection and its request line.
    seen: Arc<Mutex<Vec<(usize, String)>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for RawSite {
    fn drop(&mut self) {
        self.task.abort();
    }
}

type RawScript = dyn Fn(usize, usize) -> Reply + Send + Sync;

impl RawSite {
    async fn start(script: impl Fn(usize, usize) -> Reply + Send + Sync + 'static) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let seen: Arc<Mutex<Vec<(usize, String)>>> = Arc::default();
        let script: Arc<RawScript> = Arc::new(script);
        let task = tokio::spawn({
            let seen = seen.clone();
            async move {
                for connection in 0.. {
                    let Ok((stream, _)) = listener.accept().await else {
                        return;
                    };
                    tokio::spawn(serve_raw(stream, connection, seen.clone(), script.clone()));
                }
            }
        });
        Self { origin, seen, task }
    }

    fn seen(&self) -> Vec<(usize, String)> {
        self.seen.lock().unwrap().clone()
    }

    fn harness(&self, dir: &Path) -> Harness {
        Harness {
            enabled: true,
            origin: Origin::parse(&self.origin).expect("a loopback origin"),
            cache: Cache::in_data_dir(dir),
            limits: Limits::default(),
            backoff: Box::leak(Box::new(Backoff::default())),
        }
    }
}

async fn serve_raw(
    mut stream: tokio::net::TcpStream,
    connection: usize,
    seen: Arc<Mutex<Vec<(usize, String)>>>,
    script: Arc<RawScript>,
) {
    use tokio::io::AsyncWriteExt;
    let mut buffer: Vec<u8> = Vec::new();
    for index in 0.. {
        let head_end = loop {
            if let Some(at) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
                break at + 4;
            }
            if !read_more(&mut stream, &mut buffer).await {
                return;
            }
        };
        let head = String::from_utf8_lossy(&buffer[..head_end]).into_owned();
        let length = head
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.trim()
                    .eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().ok())
                    .flatten()
            })
            .unwrap_or(0);
        while buffer.len() < head_end + length {
            if !read_more(&mut stream, &mut buffer).await {
                return;
            }
        }
        let request_line = head.lines().next().unwrap_or_default().to_string();
        let body: Vec<u8> = buffer.drain(..head_end + length).skip(head_end).collect();
        seen.lock()
            .unwrap()
            .push((connection, request_line.clone()));
        match script(connection, index) {
            Reply::Close => return,
            Reply::Hang => {
                tokio::time::sleep(Duration::from_secs(30)).await;
                return;
            }
            Reply::Answer(status) => {
                let answer = if request_line.starts_with("POST") {
                    let asked: Value = serde_json::from_slice(&body).unwrap_or_default();
                    let items: Vec<Value> = asked["installed"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default()
                        .iter()
                        .map(|item| json!({ "id": item["id"], "status": "unavailable" }))
                        .collect();
                    json!({ "items": items }).to_string()
                } else {
                    json!({ "ok": true }).to_string()
                };
                let reply = format!(
                    "HTTP/1.1 {status} Reply\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{answer}",
                    answer.len()
                );
                if stream.write_all(reply.as_bytes()).await.is_err() {
                    return;
                }
            }
        }
    }
}

/// Reads what has arrived onto `buffer`; `false` once the peer is gone.
async fn read_more(stream: &mut tokio::net::TcpStream, buffer: &mut Vec<u8>) -> bool {
    use tokio::io::AsyncReadExt;
    let mut chunk = [0u8; 4096];
    match stream.read(&mut chunk).await {
        Ok(0) | Err(_) => false,
        Ok(read) => {
            buffer.extend_from_slice(&chunk[..read]);
            true
        }
    }
}

const CONFIG_LINE: &str = "GET /api/harness/v1/config HTTP/1.1";
const RESOLVE_LINE: &str = "POST /api/harness/v1/resolve HTTP/1.1";

/// QA finding: through a proxy, a pooled connection the proxy had already
/// closed failed the next request ("connection closed before message
/// completed"). A GET, and `/resolve` (the read-only POST), are sent once
/// more, on a fresh connection.
#[tokio::test]
async fn a_request_on_a_connection_closed_under_it_is_sent_once_more() {
    let site = RawSite::start(|connection, request| {
        if connection == 0 && request == 1 {
            Reply::Close
        } else {
            Reply::Answer(200)
        }
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let harness = site.harness(dir.path());
    assert_eq!(harness.config().await.unwrap(), json!({ "ok": true }));
    assert_eq!(harness.config().await.unwrap(), json!({ "ok": true }));
    assert_eq!(
        site.seen(),
        [
            (0, CONFIG_LINE.to_string()),
            (0, CONFIG_LINE.to_string()),
            (1, CONFIG_LINE.to_string()),
        ],
        "the second request went out on the kept connection, then on a new one"
    );

    let site = RawSite::start(|connection, request| {
        if connection == 0 && request == 1 {
            Reply::Close
        } else {
            Reply::Answer(200)
        }
    })
    .await;
    let harness = site.harness(dir.path());
    let asked = [Installed {
        id: "a".into(),
        revision: 1,
    }];
    assert_eq!(harness.resolve(&asked).await.unwrap().len(), 1);
    let resolved = harness.resolve(&asked).await.unwrap();
    assert_eq!(resolved[0].status, ItemStatus::Unavailable);
    assert_eq!(
        site.seen(),
        [
            (0, RESOLVE_LINE.to_string()),
            (0, RESOLVE_LINE.to_string()),
            (1, RESOLVE_LINE.to_string()),
        ]
    );
}

#[tokio::test]
async fn a_connection_dropped_twice_is_not_tried_a_third_time() {
    let site = RawSite::start(|connection, request| {
        if connection == 0 && request == 0 {
            Reply::Answer(200)
        } else {
            Reply::Close
        }
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let harness = site.harness(dir.path());
    harness.config().await.unwrap();
    let error = harness.config().await.unwrap_err();
    assert!(matches!(error, HarnessError::Network(_)), "{error:?}");
    assert_eq!(site.seen().len(), 3, "sent once more, and only once");
}

/// An answer of any status, and a request that got no answer in time, are
/// never sent again.
#[tokio::test]
async fn an_answer_or_a_timeout_is_never_sent_again() {
    let site = RawSite::start(|_, request| {
        if request == 0 {
            Reply::Answer(200)
        } else {
            Reply::Answer(503)
        }
    })
    .await;
    let dir = tempfile::tempdir().unwrap();
    let harness = site.harness(dir.path());
    harness.config().await.unwrap();
    assert_eq!(
        harness.config().await.unwrap_err(),
        HarnessError::Server { status: 503 }
    );
    assert_eq!(site.seen().len(), 2);

    let site = RawSite::start(|_, _| Reply::Hang).await;
    let mut harness = site.harness(dir.path());
    harness.limits.request_timeout = Duration::from_millis(250);
    let error = harness.config().await.unwrap_err();
    assert!(matches!(error, HarnessError::Network(_)), "{error:?}");
    assert_eq!(site.seen().len(), 1, "a timeout is not sent again");
}
