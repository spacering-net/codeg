//! Server-mode reverse proxy for `officecli watch` preview servers.
//!
//! In standalone / Docker deployments the browser can't reach the server's
//! loopback, so the office preview iframe loads
//! `/api/office-watch-proxy/{port}/?cap=...` and we forward it to
//! `http://127.0.0.1:{port}/...`. (Desktop skips this entirely — the Tauri
//! webview loads the loopback URL directly.)
//!
//! ## Why a path-rewriting shim (the crux)
//!
//! officecli's watch page is a single self-contained HTML whose inline JS hits
//! **root-absolute** endpoints: `EventSource('/events')` (live refresh),
//! `fetch('/api/edit')`, `fetch('/api/selection')`, `fetch('/')`. Loaded inside
//! an iframe at `{origin}/api/office-watch-proxy/{port}/`, those `/...` URLs
//! resolve against the app origin (`{origin}/events`), bypassing the proxy — so
//! the live-refresh SSE never connects. We therefore **inject a tiny JS shim**
//! at the top of `<head>` that patches `fetch`/`EventSource`/`XMLHttpRequest` to
//! re-prefix any root-absolute URL with `/api/office-watch-proxy/{port}` (and
//! carry the capability). Because the page has no external JS and the shim runs
//! before officecli's scripts, every request flows back through the proxy.
//!
//! ## A hidden preview holds no event stream
//!
//! A browser allows only a handful of connections per server (six over
//! HTTP/1.1), and the preview frames' requests all share one pool: with an
//! event stream held open per preview, a seventh preview never connects, and
//! every request a frame makes waits, the shown preview's included. The app
//! keeps the file column's office previews mounted out of sight, as many as
//! are open, so the shim also lets go of a page's stream while the app says
//! its preview is hidden, and takes it up again when it is shown, catching up
//! on what changed meanwhile (`office_watch_shim.js`; the app's side is
//! `OfficePreview`). A hidden preview keeps its watch by renewing its hold
//! (`office_watch::renew_office_watch_core`) instead of by a stream.
//!
//! ## Auth + SSRF + token isolation
//!
//! An iframe navigation can't carry a Bearer header, so this route lives in the
//! unauthenticated `public_api` Router and self-validates a `?cap=` query param
//! via [`office_watch::validate_watch_cap`] — a per-watch capability minted by
//! the Bearer-authed `start_office_watch` API. That gates the request **and**
//! gates the `{port}` against the SSRF whitelist (only ports *we* bound to a
//! watch), so the proxy can never be aimed at an arbitrary internal service. The
//! global `CODEG_TOKEN` never enters the iframe; a leaked `cap` only exposes the
//! one open document's watch.
//!
//! ## CORS
//!
//! The web-mode iframe runs with an opaque origin (no `allow-same-origin`), so
//! its sub-requests are cross-origin. The router's global `CorsLayer`
//! (`allow_origin(Any)`) already answers preflights and stamps
//! `Access-Control-Allow-Origin: *` onto every `/api/*` response, this route
//! included — so we deliberately add **no** CORS headers here (doing so would
//! emit a duplicate `Access-Control-Allow-Origin`, which browsers reject).

use std::sync::LazyLock;
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::{Path as AxumPath, RawQuery};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;

use crate::office_watch::{
    acquire_sse_lease, note_proxy_request, release_sse_lease, validate_watch_cap,
};

/// Releases a watch's SSE lease when the proxied `/events` response body is
/// dropped — i.e. when the browser disconnects (tab close, refresh, network
/// loss, or the shim letting go for a hidden preview). Once no lease is left
/// and no other sign of life follows, the pool's sweep drops the web pages'
/// hold even if their `stop_office_watch` never arrived.
struct SseLeaseGuard {
    port: u16,
}

impl Drop for SseLeaseGuard {
    fn drop(&mut self) {
        release_sse_lease(self.port);
    }
}

/// Dedicated client for loopback proxying: never routes through a system proxy,
/// and crucially has **no overall request timeout** — the watch refresh channel
/// is a long-lived SSE stream that an overall timeout would sever. Only the
/// initial TCP connect is bounded.
static OFFICE_PROXY_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(5))
        .build()
        .expect("failed to build office watch proxy client")
});

/// JS shim injected at the top of officecli's `<head>`. Patches the three URL
/// entry points so every root-absolute request is re-prefixed through the proxy
/// and carries the capability, and holds the page's event stream only while
/// the app shows the preview (see the module docs). `__PFX__`/`__CAP__`/
/// `__VER__` are substituted per request (never `format!`'d, to avoid escaping
/// the JS braces). The `rw()` guard is idempotent so officecli's own
/// `fetch('/')` re-fetch can't double-prefix.
const SHIM_JS: &str = include_str!("office_watch_shim.js");

/// The shim for a page the proxy serves under `prefix` with capability `cap`,
/// as the `<script>` to inject. `version` is the document version the page
/// shows at least (see [`upstream_version`]); unknown, the shim catches the
/// page up the first time it is shown again.
fn shim_for(prefix: &str, cap: &str, version: Option<u64>) -> String {
    let version = version.map_or_else(|| "-1".to_string(), |v| v.to_string());
    let js = SHIM_JS
        .replace("__PFX__", prefix)
        .replace("__CAP__", cap)
        .replace("__VER__", &version);
    format!("<script>{js}</script>")
}

/// The watch's document version, from its `GET /api/status`. Asked before the
/// page itself is fetched, so it can only be older than what the page shows:
/// the shim takes it as the version it starts from, and an edit landing in
/// between costs one needless catch-up, never a missed one.
async fn upstream_version(port: u16) -> Option<u64> {
    let resp = OFFICE_PROXY_CLIENT
        .get(format!("http://127.0.0.1:{port}/api/status"))
        .timeout(Duration::from_secs(2))
        .send()
        .await
        .ok()?;
    let status: serde_json::Value = resp.json().await.ok()?;
    status.get("version")?.as_u64()
}

/// Request headers we forward downstream → upstream. Deliberately excludes Host,
/// Authorization, Cookie, and hop-by-hop headers. `content-type` is forwarded so
/// officecli parses POST bodies (`/api/edit`, `/api/selection`).
fn forward_request_header(name: &str) -> bool {
    matches!(
        name,
        "accept"
            | "accept-language"
            | "content-type"
            | "range"
            | "if-none-match"
            | "if-modified-since"
    )
}

/// Response headers we copy upstream → downstream. `content-type` is
/// load-bearing for `text/html`, `text/event-stream`, and JSON; `content-length`
/// is intentionally dropped (the body is streamed, or rewritten for HTML).
fn forward_response_header(name: &str) -> bool {
    matches!(
        name,
        "content-type" | "cache-control" | "etag" | "last-modified" | "expires"
    )
}

/// Extract a single query param value (percent-decoded).
fn query_param(raw: &str, key: &str) -> Option<String> {
    raw.split('&').find_map(|seg| {
        let mut it = seg.splitn(2, '=');
        if it.next()? != key {
            return None;
        }
        let raw_val = it.next().unwrap_or("");
        Some(
            urlencoding::decode(raw_val)
                .map(|c| c.into_owned())
                .unwrap_or_else(|_| raw_val.to_string()),
        )
    })
}

/// Re-serialize the query string with `key` removed, preserving the remaining
/// segments verbatim (so officecli's own params pass through intact).
fn query_without(raw: &str, key: &str) -> String {
    let kept: Vec<&str> = raw
        .split('&')
        .filter(|seg| !seg.is_empty() && seg.split('=').next() != Some(key))
        .collect();
    if kept.is_empty() {
        String::new()
    } else {
        format!("?{}", kept.join("&"))
    }
}

/// Insert the shim right after the opening `<head ...>` tag so it runs before
/// officecli's inline scripts. Falls back to prepending if there's no `<head>`.
/// Offsets come from an ASCII-lowercased copy, which preserves byte length and
/// boundaries, so they index the original safely.
fn inject_shim(html: &str, shim: &str) -> String {
    let lower = html.to_ascii_lowercase();
    if let Some(hs) = lower.find("<head") {
        if let Some(rel_end) = lower[hs..].find('>') {
            let at = hs + rel_end + 1;
            let mut out = String::with_capacity(html.len() + shim.len());
            out.push_str(&html[..at]);
            out.push_str(shim);
            out.push_str(&html[at..]);
            return out;
        }
    }
    format!("{shim}{html}")
}

pub async fn proxy_root(
    AxumPath(port): AxumPath<u16>,
    method: Method,
    headers: HeaderMap,
    raw_query: RawQuery,
    body: Bytes,
) -> Response {
    proxy_inner(method, port, String::new(), headers, raw_query, body).await
}

pub async fn proxy(
    AxumPath((port, rest)): AxumPath<(u16, String)>,
    method: Method,
    headers: HeaderMap,
    raw_query: RawQuery,
    body: Bytes,
) -> Response {
    proxy_inner(method, port, rest, headers, raw_query, body).await
}

async fn proxy_inner(
    method: Method,
    port: u16,
    rest: String,
    headers: HeaderMap,
    RawQuery(raw_query): RawQuery,
    body: Bytes,
) -> Response {
    // CORS preflight (OPTIONS) is short-circuited by the router's global
    // `CorsLayer` before reaching here, so this handler only ever sees the real
    // GET/POST requests.
    let raw = raw_query.unwrap_or_default();

    // 1. AUTH + SSRF — the request must name a port we bound to a watch and
    //    carry that watch's exact capability. This single check is the whole
    //    gate: an unknown port or wrong cap fails closed.
    let cap = query_param(&raw, "cap").unwrap_or_default();
    if cap.is_empty() || !validate_watch_cap(port, &cap) {
        return (StatusCode::UNAUTHORIZED, "invalid capability").into_response();
    }

    // A page loading or talking to its watch is a sign of life, which keeps the
    // web pages' hold on it ("Who holds a watch" in `office_watch`).
    note_proxy_request(port);

    // The version the document page will show at least, asked before the page
    // itself is (the shim catches the page up from it, see `upstream_version`).
    let version = if method == Method::GET && rest.is_empty() {
        upstream_version(port).await
    } else {
        None
    };

    // 2. Build the upstream URL, stripping `cap` so it never reaches officecli.
    let upstream = format!("http://127.0.0.1:{port}/{rest}{}", query_without(&raw, "cap"));

    // 3. Forward method + curated request headers + body.
    let mut req = OFFICE_PROXY_CLIENT.request(method, &upstream);
    for (name, value) in headers.iter() {
        if forward_request_header(name.as_str()) {
            req = req.header(name.as_str(), value.as_bytes());
        }
    }
    if !body.is_empty() {
        req = req.body(body);
    }

    let upstream_resp = match req.send().await {
        Ok(r) => r,
        Err(_) => return (StatusCode::BAD_GATEWAY, "watch upstream unreachable").into_response(),
    };

    let status = upstream_resp.status().as_u16();
    let content_type = upstream_resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|ct| ct.to_ascii_lowercase())
        .unwrap_or_default();
    let is_html = content_type.contains("text/html");
    let is_sse = content_type.contains("text/event-stream");

    let mut builder = Response::builder().status(status);
    for (name, value) in upstream_resp.headers().iter() {
        if forward_response_header(name.as_str()) {
            builder = builder.header(name.as_str(), value.as_bytes());
        }
    }

    // 4a. HTML document → buffer, inject the path-rewriting shim, return fixed.
    //     (Only the ~120KB root page; everything else streams.) The rewritten
    //     page carries the cap, so don't let an intermediary cache it.
    if is_html {
        let bytes = match upstream_resp.bytes().await {
            Ok(b) => b,
            Err(_) => return (StatusCode::BAD_GATEWAY, "watch upstream read error").into_response(),
        };
        let shim = shim_for(&format!("/api/office-watch-proxy/{port}"), &cap, version);
        let html = inject_shim(&String::from_utf8_lossy(&bytes), &shim);
        return builder
            .header("cache-control", "no-store")
            .body(Body::from(html))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
    }

    // 4b. Everything else (SSE `/events`, JSON `/api/*`) → stream transparently.
    builder = builder.header("x-accel-buffering", "no");
    if is_sse {
        // Hold an SSE lease for the life of this response body. When the browser
        // disconnects, axum drops the body → the guard drops → the lease is
        // released, letting the sweep reap an abandoned web preview even if no
        // `stop_office_watch` ever arrives. The guard rides inside the stream's
        // map closure, so it's owned for exactly the connection's lifetime.
        acquire_sse_lease(port);
        let guard = SseLeaseGuard { port };
        let stream = upstream_resp.bytes_stream().map(move |chunk| {
            let _hold = &guard;
            chunk
        });
        return builder
            .body(Body::from_stream(stream))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
    }
    builder
        .body(Body::from_stream(upstream_resp.bytes_stream()))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_param_extracts_and_decodes() {
        assert_eq!(query_param("cap=abc", "cap").as_deref(), Some("abc"));
        assert_eq!(
            query_param("foo=1&cap=ab%2Bc&bar=2", "cap").as_deref(),
            Some("ab+c") // percent-decoded
        );
        assert_eq!(query_param("foo=1", "cap"), None);
        assert_eq!(query_param("cap=", "cap").as_deref(), Some(""));
    }

    #[test]
    fn query_without_strips_only_named_key() {
        assert_eq!(query_without("cap=secret", "cap"), "");
        assert_eq!(query_without("foo=1&cap=secret", "cap"), "?foo=1");
        assert_eq!(query_without("cap=secret&a=1&b=2", "cap"), "?a=1&b=2");
        assert_eq!(query_without("", "cap"), "");
        // A param merely containing the key in its value is untouched.
        assert_eq!(query_without("x=cap", "cap"), "?x=cap");
    }

    #[test]
    fn inject_shim_lands_after_head_open() {
        let html = "<html><head><title>x</title></head><body>b</body></html>";
        let out = inject_shim(html, "<SHIM>");
        assert_eq!(
            out,
            "<html><head><SHIM><title>x</title></head><body>b</body></html>"
        );
        // Case-insensitive on the tag.
        let upper = "<HTML><HEAD><meta></HEAD>";
        assert!(inject_shim(upper, "<S>").starts_with("<HTML><HEAD><S><meta>"));
        // No <head> → prepend.
        assert_eq!(inject_shim("<body>x</body>", "<S>"), "<S><body>x</body>");
    }

    #[test]
    fn shim_substitutes_every_placeholder() {
        let shim = shim_for("/api/office-watch-proxy/26315", "deadbeef", Some(7));
        assert!(shim.contains("const P = \"/api/office-watch-proxy/26315\""));
        assert!(shim.contains("const C = \"deadbeef\""));
        assert!(shim.contains("Number(\"7\")"));
        assert!(!shim.contains("__PFX__"));
        assert!(!shim.contains("__CAP__"));
        assert!(!shim.contains("__VER__"));
        // Unknown, the version the page starts from is below any real one.
        assert!(shim_for("/p", "c", None).contains("Number(\"-1\")"));
        // One script element, which nothing inside ends early.
        assert!(shim.starts_with("<script>"));
        assert_eq!(shim.matches("</script").count(), 1);
        assert!(shim.ends_with("</script>"));
    }
}
