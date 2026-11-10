use axum::{
    extract::Request,
    http::{header, HeaderMap, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use std::sync::Arc;

use super::proxy_auth::{ProxyJwtAuth, Rejection};

pub const WS_EVENT_PROTOCOL: &str = "codeg-events";
const WS_TOKEN_PROTOCOL_PREFIX: &str = "codeg-token.";
// Sent with every 401 this middleware returns. The web client reads it to
// tell Codeg's own rejection (re-enter the token) from a 401 sent by an
// identity-aware proxy in front of Codeg whose session expired (reload, so the
// proxy can run its login flow); see `src/lib/transport/web-auth.ts`.
const CODEG_CHALLENGE: &str = r#"Bearer realm="codeg""#;

fn unauthorized(message: &'static str) -> Response {
    (
        StatusCode::UNAUTHORIZED,
        [(header::WWW_AUTHENTICATE, CODEG_CHALLENGE)],
        message,
    )
        .into_response()
}

fn token_from_ws_protocols(value: &str) -> Option<String> {
    value
        .split(',')
        .map(str::trim)
        .find_map(|protocol| protocol.strip_prefix(WS_TOKEN_PROTOCOL_PREFIX))
        .and_then(|encoded| URL_SAFE_NO_PAD.decode(encoded).ok())
        .and_then(|bytes| String::from_utf8(bytes).ok())
}

fn carries_token(request: &Request, token: &str) -> bool {
    if let Some(auth_header) = request.headers().get("authorization") {
        if let Ok(auth_str) = auth_header.to_str() {
            if auth_str.strip_prefix("Bearer ").is_some_and(|t| t == token) {
                return true;
            }
        }
    }

    if let Some(protocol_header) = request.headers().get("sec-websocket-protocol") {
        if let Ok(protocols) = protocol_header.to_str() {
            if token_from_ws_protocols(protocols).is_some_and(|t| t == token) {
                return true;
            }
        }
    }

    false
}

pub async fn require_token(request: Request, next: Next, token: String) -> Response {
    // Fail closed on a misconfigured empty token: otherwise `Bearer ` (an empty
    // bearer value) would match it and silently disable authentication.
    if token.is_empty() {
        return unauthorized("Server token is not configured");
    }
    if carries_token(&request, &token) {
        return next.run(request).await;
    }
    unauthorized("Invalid or missing token")
}

/// How the web API authenticates a request: the access token always, and with
/// `CODEG_AUTH=proxy-jwt` also a proxy's verified assertion (see
/// `proxy_auth`). The token keeps working in that mode for clients that do
/// not pass through the proxy (`codeg-cli --url`, scripts).
#[derive(Clone)]
pub struct WebAuth {
    pub token: String,
    pub proxy: Option<Arc<ProxyJwtAuth>>,
}

/// Why a request the proxy's assertion would admit was not sent by Codeg's own
/// page, or `None` when it was.
///
/// The assertion rides on the proxy's session cookie, and the browser attaches
/// that cookie to requests that pages on other origins make as well:
/// Cloudflare sets its application cookie `SameSite=None` unless the operator
/// changes it, and even `Lax` or `Strict` lets a sibling subdomain's page send
/// it, because `SameSite` compares sites, not origins. Such a page could then
/// open the event or browser-tunnel WebSocket, or post a multipart upload
/// (neither needs a CORS preflight), as the signed-in user. The token cannot
/// travel that way, so only the assertion needs this check.
///
/// `Sec-Fetch-Site` is set by the browser and a page cannot change it:
/// `same-origin` is Codeg's own page and `none` an address the user typed;
/// `same-site` (a sibling subdomain) and `cross-site` are refused. A browser
/// that sends no Fetch Metadata still sends `Origin` on every WebSocket
/// handshake and every cross-origin POST, so when present it must name the host
/// the request was addressed to: `Host`, or a proxy's `X-Forwarded-Host` — a
/// page cannot set either on a request to another origin. A request with
/// neither header is not a WebSocket or POST from another origin's page: it
/// comes from a client that is not a browser, or is a cross-origin GET from an
/// old browser, whose answer that page cannot read (CORS) and which changes
/// nothing here.
fn cross_origin_initiator(headers: &HeaderMap) -> Option<String> {
    if let Some(site) = headers.get("sec-fetch-site") {
        let site = site.to_str().unwrap_or_default().trim();
        return (!matches!(site, "same-origin" | "none"))
            .then(|| format!("Sec-Fetch-Site: {site}"));
    }
    let origin = headers.get(header::ORIGIN)?;
    let origin = origin.to_str().unwrap_or_default().trim();
    let addressed = reqwest::Url::parse(origin)
        .ok()
        .filter(|url| matches!(url.scheme(), "http" | "https"))
        .and_then(|url| {
            let host = url.host_str()?.to_ascii_lowercase();
            Some(match url.port() {
                Some(port) => format!("{host}:{port}"),
                None => host,
            })
        });
    let hosts: Vec<String> = headers
        .get_all(header::HOST)
        .iter()
        .chain(headers.get_all("x-forwarded-host").iter())
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(|host| host.trim().to_ascii_lowercase())
        .collect();
    if addressed.is_some_and(|addressed| hosts.contains(&addressed)) {
        return None;
    }
    // Both, so a proxy that rewrites `Host` without `X-Forwarded-Host` shows.
    Some(format!("Origin: {origin}; sent to: {}", hosts.join(", ")))
}

pub async fn require_auth(request: Request, next: Next, auth: WebAuth) -> Response {
    let Some(proxy) = auth.proxy.as_ref() else {
        return require_token(request, next, auth.token).await;
    };
    if !auth.token.is_empty() && carries_token(&request, &auth.token) {
        return next.run(request).await;
    }
    match proxy.authenticate(request.headers()).await {
        Ok(()) => match cross_origin_initiator(request.headers()) {
            None => next.run(request).await,
            Some(initiator) => {
                tracing::warn!(
                    "[AUTH] proxy-jwt: refused a request sent by a page on another origin ({initiator})"
                );
                (StatusCode::FORBIDDEN, "Cross-origin request refused").into_response()
            }
        },
        Err(Rejection::Missing) => unauthorized("Invalid or missing token"),
        Err(reason) => {
            // The reason only: the assertion is a bearer credential.
            tracing::warn!("[AUTH] proxy-jwt assertion refused: {reason}");
            unauthorized("Invalid or missing token")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;

    #[test]
    fn parses_token_from_ws_protocols() {
        let token = "secret/token+value";
        let encoded = URL_SAFE_NO_PAD.encode(token);
        assert_eq!(
            token_from_ws_protocols(&format!("codeg-events, codeg-token.{encoded}")).as_deref(),
            Some(token)
        );
    }

    #[test]
    fn ignores_invalid_ws_protocol_token() {
        assert!(token_from_ws_protocols("codeg-events, codeg-token.not-valid-@@@@").is_none());
    }

    fn guarded(server_token: &str) -> axum_test::TestServer {
        let server_token = server_token.to_string();
        let app = axum::Router::new()
            .route("/api/health", axum::routing::post(|| async { "ok" }))
            .layer(axum::middleware::from_fn(move |req, next| {
                require_token(req, next, server_token.clone())
            }));
        axum_test::TestServer::new(app).unwrap()
    }

    // The web client tells Codeg's own 401 from one sent by a proxy in front
    // of it (whose session expired) by this challenge; see `web-auth.ts`.
    #[tokio::test]
    async fn every_rejection_carries_the_codeg_challenge() {
        let server = guarded("tok");

        let missing = server.post("/api/health").await;
        missing.assert_status_unauthorized();
        assert_eq!(missing.header("www-authenticate"), CODEG_CHALLENGE);

        let wrong = server
            .post("/api/health")
            .authorization_bearer("nope")
            .await;
        wrong.assert_status_unauthorized();
        assert_eq!(wrong.header("www-authenticate"), CODEG_CHALLENGE);

        let unconfigured = guarded("").post("/api/health").await;
        unconfigured.assert_status_unauthorized();
        assert_eq!(unconfigured.header("www-authenticate"), CODEG_CHALLENGE);
    }

    fn guarded_with(auth: WebAuth) -> axum_test::TestServer {
        let app = axum::Router::new()
            .route("/api/health", axum::routing::post(|| async { "ok" }))
            .layer(axum::middleware::from_fn(move |req, next| {
                require_auth(req, next, auth.clone())
            }));
        axum_test::TestServer::new(app).unwrap()
    }

    use crate::web::proxy_auth::testing::{TestIssuer, HEADER};

    #[tokio::test]
    async fn proxy_mode_admits_a_verified_assertion_without_the_token() {
        let issuer = TestIssuer::new();
        let server = guarded_with(WebAuth {
            token: "tok".into(),
            proxy: Some(Arc::new(issuer.auth().await)),
        });
        server
            .post("/api/health")
            .add_header(HEADER, issuer.assertion())
            .await
            .assert_status_ok();
    }

    #[tokio::test]
    async fn proxy_mode_still_admits_the_token() {
        let issuer = TestIssuer::new();
        let server = guarded_with(WebAuth {
            token: "tok".into(),
            proxy: Some(Arc::new(issuer.auth().await)),
        });
        server
            .post("/api/health")
            .authorization_bearer("tok")
            .await
            .assert_status_ok();
    }

    #[tokio::test]
    async fn proxy_mode_refuses_a_missing_or_bad_assertion_with_the_codeg_challenge() {
        let issuer = TestIssuer::new();
        let server = guarded_with(WebAuth {
            token: "tok".into(),
            proxy: Some(Arc::new(issuer.auth().await)),
        });

        let missing = server.post("/api/health").await;
        missing.assert_status_unauthorized();
        assert_eq!(missing.header("www-authenticate"), CODEG_CHALLENGE);

        let other_app = server
            .post("/api/health")
            .add_header(HEADER, issuer.assertion_for("another-app"))
            .await;
        other_app.assert_status_unauthorized();
        assert_eq!(other_app.header("www-authenticate"), CODEG_CHALLENGE);

        let forged = server
            .post("/api/health")
            .add_header(HEADER, TestIssuer::new().assertion())
            .await;
        forged.assert_status_unauthorized();

        let wrong_token = server
            .post("/api/health")
            .authorization_bearer("nope")
            .await;
        wrong_token.assert_status_unauthorized();
    }

    // Token mode must not grow a second way in: an assertion that would pass
    // in proxy mode is ignored.
    #[tokio::test]
    async fn token_mode_ignores_a_valid_assertion() {
        let issuer = TestIssuer::new();
        let server = guarded_with(WebAuth {
            token: "tok".into(),
            proxy: None,
        });
        let res = server
            .post("/api/health")
            .add_header(HEADER, issuer.assertion())
            .await;
        res.assert_status_unauthorized();
        assert_eq!(res.header("www-authenticate"), CODEG_CHALLENGE);
    }

    #[tokio::test]
    async fn proxy_mode_with_an_empty_token_accepts_no_empty_bearer() {
        let issuer = TestIssuer::new();
        let server = guarded_with(WebAuth {
            token: String::new(),
            proxy: Some(Arc::new(issuer.auth().await)),
        });
        server
            .post("/api/health")
            .add_header("authorization", "Bearer ")
            .await
            .assert_status_unauthorized();
    }

    async fn proxy_server(issuer: &TestIssuer) -> axum_test::TestServer {
        let auth = WebAuth {
            token: "tok".into(),
            proxy: Some(Arc::new(issuer.auth().await)),
        };
        let app = axum::Router::new()
            .route("/api/health", axum::routing::post(|| async { "ok" }))
            .route("/ws/events", axum::routing::get(|| async { "upgraded" }))
            .layer(axum::middleware::from_fn(move |req, next| {
                require_auth(req, next, auth.clone())
            }));
        axum_test::TestServer::new(app).unwrap()
    }

    // The assertion rides on the proxy's session cookie, which the browser
    // also attaches to requests that pages on other origins make: Cloudflare's
    // application cookie is SameSite=None unless the operator changes it, and
    // a sibling subdomain's page (`same-site`) sends it even under Lax or Strict.
    #[tokio::test]
    async fn proxy_mode_refuses_an_assertion_carried_by_another_origins_request() {
        let issuer = TestIssuer::new();
        let server = proxy_server(&issuer).await;

        for site in ["cross-site", "same-site"] {
            server
                .post("/api/health")
                .add_header(HEADER, issuer.assertion())
                .add_header("sec-fetch-site", site)
                .await
                .assert_status(StatusCode::FORBIDDEN);
        }
        // Without Fetch Metadata the Origin decides; `null` is an opaque one.
        for origin in ["https://evil.example.test", "null"] {
            server
                .post("/api/health")
                .add_header(HEADER, issuer.assertion())
                .add_header("host", "codeg.example.test")
                .add_header("origin", origin)
                .await
                .assert_status(StatusCode::FORBIDDEN);
        }
    }

    // A WebSocket handshake is a GET, and the one a page on another origin
    // opens carries the proxy's cookie too.
    #[tokio::test]
    async fn proxy_mode_refuses_another_origins_websocket_handshake() {
        let issuer = TestIssuer::new();
        let server = proxy_server(&issuer).await;
        server
            .get("/ws/events")
            .add_header(HEADER, issuer.assertion())
            .add_header("sec-fetch-mode", "websocket")
            .add_header("sec-fetch-site", "cross-site")
            .add_header("origin", "https://evil.example.test")
            .await
            .assert_status(StatusCode::FORBIDDEN);
        server
            .get("/ws/events")
            .add_header(HEADER, issuer.assertion())
            .add_header("host", "codeg.example.test")
            .add_header("origin", "https://evil.example.test")
            .await
            .assert_status(StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn proxy_mode_admits_an_assertion_sent_by_codegs_own_page() {
        let issuer = TestIssuer::new();
        let server = proxy_server(&issuer).await;

        for site in ["same-origin", "none"] {
            server
                .post("/api/health")
                .add_header(HEADER, issuer.assertion())
                .add_header("sec-fetch-site", site)
                .await
                .assert_status_ok();
        }
        server
            .get("/ws/events")
            .add_header(HEADER, issuer.assertion())
            .add_header("sec-fetch-mode", "websocket")
            .add_header("sec-fetch-site", "same-origin")
            .add_header("origin", "https://codeg.example.test")
            .await
            .assert_status_ok();
        // Chrome sends no Fetch Metadata on a WebSocket handshake, so its Origin
        // decides: against the browser's Host, or, where cloudflared rewrites
        // Host (`httpHostHeader`), the X-Forwarded-Host it moves the original to.
        server
            .get("/ws/events")
            .add_header(HEADER, issuer.assertion())
            .add_header("host", "codeg.example.test")
            .add_header("origin", "https://codeg.example.test")
            .await
            .assert_status_ok();
        server
            .get("/ws/events")
            .add_header(HEADER, issuer.assertion())
            .add_header("host", "localhost:3080")
            .add_header("x-forwarded-host", "codeg.example.test")
            .add_header("origin", "https://codeg.example.test")
            .await
            .assert_status_ok();
        // A browser without Fetch Metadata: its Origin names the host it
        // addressed, as `Host` or, behind a proxy that rewrites it, as
        // `X-Forwarded-Host`.
        server
            .post("/api/health")
            .add_header(HEADER, issuer.assertion())
            .add_header("host", "codeg.example.test")
            .add_header("origin", "https://codeg.example.test")
            .await
            .assert_status_ok();
        server
            .post("/api/health")
            .add_header(HEADER, issuer.assertion())
            .add_header("host", "127.0.0.1:3080")
            .add_header("x-forwarded-host", "codeg.example.test")
            .add_header("origin", "https://codeg.example.test")
            .await
            .assert_status_ok();
        // Neither header: not a request a page made.
        server
            .post("/api/health")
            .add_header(HEADER, issuer.assertion())
            .await
            .assert_status_ok();
    }

    // A page on another origin cannot send the token, so the token needs no
    // proof of where the request came from, in either mode.
    #[tokio::test]
    async fn the_token_is_admitted_whoever_sent_the_request() {
        let issuer = TestIssuer::new();
        proxy_server(&issuer)
            .await
            .post("/api/health")
            .authorization_bearer("tok")
            .add_header("sec-fetch-site", "cross-site")
            .await
            .assert_status_ok();
        guarded("tok")
            .post("/api/health")
            .authorization_bearer("tok")
            .add_header("sec-fetch-site", "cross-site")
            .await
            .assert_status_ok();
    }

    #[tokio::test]
    async fn an_accepted_request_carries_no_challenge() {
        let ok = guarded("tok")
            .post("/api/health")
            .authorization_bearer("tok")
            .await;
        ok.assert_status_ok();
        assert!(ok.maybe_header("www-authenticate").is_none());
    }
}
