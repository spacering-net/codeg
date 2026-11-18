//! Codeg Web's SRN sign-in through the real router (`web::router`), against
//! a stand-in for SpaceRing (`srn::test_support`), a database and a key in a
//! temporary directory and a clock moved by hand. No network beyond
//! loopback, no keychain, no home directory.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::http::Method;
use axum_test::{TestRequest, TestResponse, TestServer};
use chrono::{DateTime, Utc};
use sea_orm::{DatabaseConnection, EntityTrait};
use serde_json::{json, Value};

#[cfg(unix)]
use super::config::CHILD_HIDDEN_ENV;
use super::config::{ClientSecret, WebConfig, CALLBACK_PATH};
use super::routes::{ACCOUNT_PATH, FLOW_COOKIE, LOGIN_PATH, LOGOUT_PATH, SESSION_COOKIE};
use super::seal::{KeySource, Sealer, KEY_FILE_NAME};
use super::service::{Clock, SrnWeb, Waits};
use crate::app_state::AppState;
use crate::db::entities::{srn_web_login, srn_web_session};
use crate::db::test_helpers::fresh_disk_db;
use crate::db::AppDatabase;
use crate::harness::origin::Origin;
use crate::srn::client::{CreatedLogin, SrnApi};
use crate::srn::pkce::RequestId;
use crate::srn::test_support::{MockSrn, Reply, AVATAR_PATH, USER_SRN};
use crate::web::proxy_auth::testing::{TestIssuer, HEADER as PROXY_HEADER};
use crate::web::shutdown::ShutdownSignal;

const INSTANCE_TOKEN: &str = "instance-token";
const PUBLIC: &str = "https://codeg.example.com";
const CLIENT: &str = "codeg-web-TestClient0123456789";
const SECRET: &str = "client-secret-0123456789abcdefghijklmnopqrstuvwxyz_-";

const LOGIN: &str = "/api/client/v1/login-requests";
const TOKEN: &str = "/api/client/v1/token";
const ME: &str = "/api/client/v1/me";
const LOGOUT: &str = "/api/client/v1/logout";

// ─── The rig ────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq)]
enum Access {
    Token,
    ProxyJwt,
}

struct Rig {
    srn: MockSrn,
    clock: Arc<Mutex<DateTime<Utc>>>,
    service: Arc<SrnWeb>,
    server: TestServer,
    conn: DatabaseConnection,
    dir: tempfile::TempDir,
    access: Access,
    issuer: TestIssuer,
}

fn config(srn: &MockSrn) -> WebConfig {
    WebConfig {
        public_origin: PUBLIC.into(),
        redirect_uri: format!("{PUBLIC}{CALLBACK_PATH}"),
        client_id: CLIENT.into(),
        client_secret: ClientSecret::from_test_value(SECRET),
        srn_origin: srn.origin().clone(),
    }
}

async fn rig() -> Rig {
    rig_with(Access::Token).await
}

async fn rig_with(access: Access) -> Rig {
    rig_waiting(access, Waits::default()).await
}

async fn rig_waiting(access: Access, waits: Waits) -> Rig {
    let dir = tempfile::tempdir().unwrap();
    let db = fresh_disk_db(dir.path()).await;
    let srn = MockSrn::start().await;
    let clock = Arc::new(Mutex::new(Utc::now()));
    let service = service_waiting(
        &srn,
        &db.conn,
        &clock,
        KeySource::server_file(dir.path()),
        waits,
    );
    let issuer = TestIssuer::new();
    let server = server_for(&db.conn, dir.path(), access, &issuer, Some(service.clone())).await;
    Rig {
        srn,
        clock,
        service,
        server,
        conn: db.conn,
        dir,
        access,
        issuer,
    }
}

fn service_on(
    srn: &MockSrn,
    conn: &DatabaseConnection,
    clock: &Arc<Mutex<DateTime<Utc>>>,
    key: KeySource,
) -> Arc<SrnWeb> {
    service_waiting(srn, conn, clock, key, Waits::default())
}

fn service_waiting(
    srn: &MockSrn,
    conn: &DatabaseConnection,
    clock: &Arc<Mutex<DateTime<Utc>>>,
    key: KeySource,
    waits: Waits,
) -> Arc<SrnWeb> {
    SrnWeb::assemble(
        Some(config(srn)),
        SrnApi::with_timeout(srn.origin().clone(), Duration::from_secs(2)),
        key,
        conn.clone(),
        Clock::Manual(clock.clone()),
        waits,
    )
}

async fn server_for(
    conn: &DatabaseConnection,
    dir: &std::path::Path,
    access: Access,
    issuer: &TestIssuer,
    service: Option<Arc<SrnWeb>>,
) -> TestServer {
    let static_dir = dir.join("static");
    std::fs::create_dir_all(&static_dir).unwrap();
    std::fs::write(static_dir.join("index.html"), "<html>index</html>").unwrap();
    let state = Arc::new(AppState::new_for_test(
        AppDatabase { conn: conn.clone() },
        dir.join("app"),
    ));
    let proxy = match access {
        Access::Token => None,
        Access::ProxyJwt => Some(Arc::new(issuer.auth().await)),
    };
    let router = crate::web::router::build_router_with_srn(
        state,
        INSTANCE_TOKEN.into(),
        proxy,
        static_dir,
        Arc::new(ShutdownSignal::new()),
        service,
    );
    TestServer::new(router).unwrap()
}

/// A browser's cookie jar, as far as these two cookies go.
#[derive(Default, Clone, Debug)]
struct Browser {
    cookies: BTreeMap<String, String>,
    /// Every cookie value it was ever given.
    seen: Vec<String>,
}

impl Browser {
    fn header(&self) -> Option<String> {
        (!self.cookies.is_empty()).then(|| {
            self.cookies
                .iter()
                .map(|(name, value)| format!("{name}={value}"))
                .collect::<Vec<_>>()
                .join("; ")
        })
    }

    fn take(&mut self, response: &TestResponse) {
        for set in response.headers().get_all("set-cookie") {
            let text = set.to_str().unwrap();
            let (pair, attributes) = text.split_once(';').unwrap_or((text, ""));
            let (name, value) = pair.split_once('=').unwrap();
            if attributes.contains("Max-Age=0") {
                self.cookies.remove(name);
            } else {
                self.cookies.insert(name.to_string(), value.to_string());
                self.seen.push(value.to_string());
            }
        }
    }

    fn session(&self) -> Option<&String> {
        self.cookies.get(SESSION_COOKIE)
    }
}

impl Rig {
    /// Admitted to the instance, as its page is.
    fn admit(&self, request: TestRequest) -> TestRequest {
        match self.access {
            Access::Token => request.authorization_bearer(INSTANCE_TOKEN),
            Access::ProxyJwt => request
                .add_header(PROXY_HEADER, self.issuer.assertion())
                .add_header("sec-fetch-site", "same-origin"),
        }
    }

    fn with_cookies(request: TestRequest, browser: &Browser) -> TestRequest {
        match browser.header() {
            Some(cookies) => request.add_header("cookie", cookies),
            None => request,
        }
    }

    async fn login(&self, browser: &mut Browser) -> TestResponse {
        let request = self
            .admit(self.server.post(LOGIN_PATH))
            .add_header("origin", PUBLIC)
            .json(&json!({}));
        let response = Self::with_cookies(request, browser).await;
        browser.take(&response);
        response
    }

    /// The person approves the latest sign-in on SpaceRing: the query the
    /// browser comes back with.
    fn approve_last(&self) -> String {
        let id = self.srn.request_ids().last().unwrap().clone();
        let body = self.srn.logins().last().unwrap().clone();
        let created = CreatedLogin {
            request_id: RequestId::parse(&id).unwrap(),
            authorization_url: url::Url::parse(&format!(
                "{}/authorize/#request_id={id}",
                self.srn.origin()
            ))
            .unwrap(),
        };
        let code = self.srn.approve(&created).unwrap();
        format!(
            "code={}&state={}",
            code.expose(),
            body["state"].as_str().unwrap()
        )
    }

    fn last_state(&self) -> String {
        self.srn.logins().last().unwrap()["state"]
            .as_str()
            .unwrap()
            .to_string()
    }

    /// The browser comes back (a top-level navigation from SpaceRing: no
    /// instance access). The `?srn=` result.
    async fn callback(&self, browser: &mut Browser, query: &str) -> String {
        let request = self
            .server
            .get(&format!("{CALLBACK_PATH}?{query}"))
            .add_header("sec-fetch-site", "cross-site");
        let response = Self::with_cookies(request, browser).await;
        assert_eq!(response.status_code(), 303, "{}", response.text());
        browser.take(&response);
        let location = response.header("location");
        location
            .to_str()
            .unwrap()
            .strip_prefix("/workspace?srn=")
            .unwrap_or_else(|| panic!("{location:?}"))
            .to_string()
    }

    async fn sign_in(&self, browser: &mut Browser) {
        let started = self.login(browser).await;
        assert_eq!(started.status_code(), 200, "{}", started.text());
        let query = self.approve_last();
        assert_eq!(self.callback(browser, &query).await, "ok");
        assert!(browser.session().is_some());
    }

    async fn status(&self, browser: &mut Browser) -> Value {
        let request = self.admit(self.server.get(ACCOUNT_PATH));
        let response = Self::with_cookies(request, browser).await;
        assert_eq!(response.status_code(), 200, "{}", response.text());
        browser.take(&response);
        response.json()
    }

    async fn logout(&self, browser: &mut Browser, body: Value) -> TestResponse {
        let request = self
            .admit(self.server.post(LOGOUT_PATH))
            .add_header("origin", PUBLIC)
            .json(&body);
        let response = Self::with_cookies(request, browser).await;
        browser.take(&response);
        response
    }

    fn advance(&self, by: Duration) {
        *self.clock.lock().unwrap() += chrono::Duration::from_std(by).unwrap();
    }

    /// The service's time, as the answers write it.
    fn now(&self) -> String {
        super::service::rfc3339(*self.clock.lock().unwrap())
    }

    async fn sessions(&self) -> Vec<srn_web_session::Model> {
        srn_web_session::Entity::find()
            .all(&self.conn)
            .await
            .unwrap()
    }

    async fn logins(&self) -> Vec<srn_web_login::Model> {
        srn_web_login::Entity::find().all(&self.conn).await.unwrap()
    }
}

fn set_cookie(response: &TestResponse, name: &str) -> Option<String> {
    response
        .headers()
        .get_all("set-cookie")
        .iter()
        .map(|v| v.to_str().unwrap().to_string())
        .find(|v| v.starts_with(&format!("{name}=")))
}

// ─── Starting ───────────────────────────────────────────────────────────

#[tokio::test]
async fn a_sign_in_starts_with_the_instance_s_client_and_a_flow_cookie() {
    let rig = rig().await;
    let mut browser = Browser::default();
    let response = rig.login(&mut browser).await;
    assert_eq!(response.status_code(), 200, "{}", response.text());
    let body: Value = response.json();
    let id = rig.srn.request_ids()[0].clone();
    assert_eq!(
        body["authorizationUrl"],
        format!("{}/authorize/#request_id={id}", rig.srn.origin())
    );
    assert!(body["expiresAt"].as_str().unwrap().ends_with('Z'));
    assert_eq!(response.header("cache-control"), "no-store");

    // SpaceRing got the instance's client, its exact redirect, and Basic
    // credentials — the secret only there.
    let sent = rig.srn.logins()[0].clone();
    assert_eq!(sent["client_id"], CLIENT);
    assert_eq!(sent["redirect_uri"], format!("{PUBLIC}/auth/srn/callback"));
    assert_eq!(sent["platform"], "web");
    assert!(!sent.to_string().contains(SECRET));
    let seen = rig.srn.seen();
    let request = seen.iter().find(|s| s.path == LOGIN).unwrap();
    use base64::Engine as _;
    let basic = format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD.encode(format!("{CLIENT}:{SECRET}"))
    );
    assert_eq!(request.header("authorization"), Some(basic.as_str()));
    assert_eq!(request.header("cookie"), None);

    // the pending row: hashes and sealed values only
    let rows = rig.logins().await;
    assert_eq!(rows.len(), 1);
    let row = &rows[0];
    let state = sent["state"].as_str().unwrap();
    assert_eq!(row.state_hash, super::service::digest(state));
    let flow = browser.cookies[FLOW_COOKIE].clone();
    assert_eq!(row.flow_hash, super::service::digest(&flow));
    let text = format!("{row:?}");
    for secret in [state, flow.as_str(), id.as_str()] {
        assert!(!text.contains(secret), "{text}");
    }
    assert!(row.verifier.starts_with("v1.") && row.request_id.starts_with("v1."));

    // a Chinese interface opens the Chinese page
    let zh = rig
        .admit(rig.server.post(LOGIN_PATH))
        .add_header("origin", PUBLIC)
        .json(&json!({ "locale": "zh_cn" }))
        .await;
    assert!(zh.json::<Value>()["authorizationUrl"]
        .as_str()
        .unwrap()
        .contains("/zh/authorize/#request_id="));
}

#[tokio::test]
async fn the_flow_and_session_cookies_are_host_only_secure_http_only_and_lax() {
    let rig = rig().await;
    let mut browser = Browser::default();
    let started = rig.login(&mut browser).await;
    let flow = set_cookie(&started, FLOW_COOKIE).unwrap();
    let query = rig.approve_last();
    let response = rig
        .server
        .get(&format!("{CALLBACK_PATH}?{query}"))
        .add_header("cookie", browser.header().unwrap())
        .await;
    let session = set_cookie(&response, SESSION_COOKIE).unwrap();
    let cleared = set_cookie(&response, FLOW_COOKIE).unwrap();
    for (cookie, max_age) in [
        (&flow, "Max-Age=600"),
        (&session, "Max-Age=2592000"),
        (&cleared, "Max-Age=0"),
    ] {
        assert!(cookie.starts_with("__Host-"), "{cookie}");
        let attributes: Vec<&str> = cookie.split(';').map(str::trim).skip(1).collect();
        for wanted in ["Path=/", "Secure", "HttpOnly", "SameSite=Lax", max_age] {
            assert!(attributes.contains(&wanted), "{cookie}: {wanted}");
        }
        assert!(!cookie.to_ascii_lowercase().contains("domain="), "{cookie}");
    }
    assert_eq!(response.header("referrer-policy"), "no-referrer");
    assert_eq!(response.header("cache-control"), "no-store");
}

#[tokio::test]
async fn a_sign_in_is_refused_without_instance_access_origin_or_json() {
    let rig = rig().await;
    let refused = |response: &TestResponse, status: u16| {
        assert_eq!(response.status_code(), status, "{}", response.text());
        assert!(set_cookie(response, FLOW_COOKIE).is_none());
    };
    // no instance access: the instance's own 401, nothing else
    let response = rig
        .server
        .post(LOGIN_PATH)
        .add_header("origin", PUBLIC)
        .json(&json!({}))
        .await;
    refused(&response, 401);
    assert_eq!(
        response.header("www-authenticate"),
        r#"Bearer realm="codeg""#
    );
    let response = rig
        .server
        .post(LOGIN_PATH)
        .authorization_bearer("wrong")
        .add_header("origin", PUBLIC)
        .json(&json!({}))
        .await;
    refused(&response, 401);
    // no Origin, another one, two of them
    let response = rig
        .admit(rig.server.post(LOGIN_PATH))
        .json(&json!({}))
        .await;
    refused(&response, 403);
    assert_eq!(
        response.json::<Value>()["i18n_key"],
        "SrnAccount.errors.originRefused"
    );
    for origin in [
        "https://evil.example",
        "http://codeg.example.com",
        "https://codeg.example.com:8443",
        "https://codeg.example.com/",
        "null",
    ] {
        let response = rig
            .admit(rig.server.post(LOGIN_PATH))
            .add_header("origin", origin)
            .json(&json!({}))
            .await;
        refused(&response, 403);
    }
    // not JSON
    let response = rig
        .admit(rig.server.post(LOGIN_PATH))
        .add_header("origin", PUBLIC)
        .text("{}")
        .await;
    refused(&response, 400);
    let response = rig
        .admit(rig.server.post(LOGIN_PATH))
        .add_header("origin", PUBLIC)
        .add_header("content-type", "application/x-www-form-urlencoded")
        .bytes("locale=en".into())
        .await;
    refused(&response, 400);
    let response = rig
        .admit(rig.server.post(LOGIN_PATH))
        .add_header("origin", PUBLIC)
        .json(&json!({ "redirectUri": "https://evil.example/" }))
        .await;
    refused(&response, 400);
    assert_eq!(
        response.json::<Value>()["i18n_key"],
        "SrnAccount.errors.invalidRequest"
    );
    // a GET does nothing
    let response = rig.admit(rig.server.get(LOGIN_PATH)).await;
    assert_eq!(response.status_code(), 405);

    assert_eq!(rig.srn.count(LOGIN), 0, "SpaceRing was asked");
    assert!(rig.logins().await.is_empty());
}

#[tokio::test]
async fn spacering_refusing_the_client_is_said_so() {
    let rig = rig().await;
    rig.srn
        .script_login(Reply::Status(401, json!({ "error": "invalid_client" })));
    let mut browser = Browser::default();
    let response = rig.login(&mut browser).await;
    assert_eq!(response.status_code(), 502);
    assert_eq!(
        response.json::<Value>()["i18n_key"],
        "SrnAccount.errors.clientRejected"
    );
    assert!(browser.cookies.is_empty());
    assert!(rig.logins().await.is_empty());
}

// ─── Completing ─────────────────────────────────────────────────────────

async fn round_trip(access: Access) {
    let rig = rig_with(access).await;
    let mut browser = Browser::default();
    rig.sign_in(&mut browser).await;
    assert!(!browser.cookies.contains_key(FLOW_COOKIE));
    assert!(rig.logins().await.is_empty(), "the sign-in was spent");

    // the exchange: once, with the verifier, the exact redirect and Basic
    // credentials
    assert_eq!(rig.srn.count(TOKEN), 1);
    let seen = rig.srn.seen();
    let exchange = seen.iter().find(|s| s.path == TOKEN).unwrap();
    let body = exchange.json();
    assert_eq!(body["client_id"], CLIENT);
    assert_eq!(body["redirect_uri"], format!("{PUBLIC}/auth/srn/callback"));
    assert!(exchange
        .header("authorization")
        .is_some_and(|h| h.starts_with("Basic ")));
    // `/me` carries the token, not the client's credentials
    let me = seen.iter().find(|s| s.path == ME).unwrap();
    assert!(me
        .header("authorization")
        .is_some_and(|h| h.starts_with("Bearer ")));

    let state = rig.status(&mut browser).await;
    assert_eq!(state["status"], "signedIn", "{state}");
    assert_eq!(
        state["account"],
        json!({ "srn": USER_SRN, "name": "Ada Lovelace", "avatarPath": AVATAR_PATH })
    );
    assert_eq!(state["online"]["status"], "confirmed");
    assert_eq!(state["online"]["checking"], false);
    assert!(state["online"]["problem"].is_null());

    // the row: the cookie as a hash, the token sealed
    let rows = rig.sessions().await;
    assert_eq!(rows.len(), 1);
    let row = &rows[0];
    let cookie = browser.session().unwrap().clone();
    assert_eq!(row.cookie_hash, super::service::digest(&cookie));
    let token = rig.srn.tokens()[0].clone();
    assert!(!format!("{row:?}").contains(&token));
    assert!(!format!("{row:?}").contains(&cookie));
    assert_eq!(row.srn, USER_SRN as i64);
    assert_eq!(
        row.connection_id.as_deref(),
        Some("0199b5e2-0000-7000-8000-000000000001")
    );
}

#[tokio::test]
async fn a_sign_in_completes_under_token_access() {
    round_trip(Access::Token).await;
}

#[tokio::test]
async fn a_sign_in_completes_under_proxy_jwt_access() {
    round_trip(Access::ProxyJwt).await;
}

#[tokio::test]
async fn a_callback_without_the_flow_cookie_makes_no_session() {
    let rig = rig().await;
    let mut browser = Browser::default();
    rig.login(&mut browser).await;
    let query = rig.approve_last();
    // another browser (or one that dropped the cookie)
    let mut other = Browser::default();
    assert_eq!(rig.callback(&mut other, &query).await, "flow_missing");
    assert_eq!(rig.srn.count(TOKEN), 0);
    assert!(rig.sessions().await.is_empty());
    // the sign-in is still there for the browser that started it
    assert_eq!(rig.callback(&mut browser, &query).await, "ok");
}

#[tokio::test]
async fn a_callback_with_another_state_makes_no_session_and_spends_nothing() {
    let rig = rig().await;
    let mut browser = Browser::default();
    rig.login(&mut browser).await;
    let query = rig.approve_last();
    let code = query.split('&').next().unwrap();
    let other_state = "o".repeat(43);
    assert_eq!(
        rig.callback(&mut browser, &format!("{code}&state={other_state}"))
            .await,
        "expired"
    );
    assert_eq!(rig.srn.count(TOKEN), 0);
    assert!(rig.sessions().await.is_empty());
    // the flow cookie and the sign-in it is bound to are untouched
    assert!(browser.cookies.contains_key(FLOW_COOKIE));
    assert_eq!(rig.logins().await.len(), 1);
    assert_eq!(rig.callback(&mut browser, &query).await, "ok");

    // another browser's flow cookie cannot take this browser's sign-in
    let mut first = Browser::default();
    let mut second = Browser::default();
    rig.login(&mut first).await;
    let query = rig.approve_last();
    rig.login(&mut second).await;
    assert_eq!(rig.callback(&mut second, &query).await, "expired");
    assert_eq!(rig.callback(&mut first, &query).await, "ok");
}

#[tokio::test]
async fn an_expired_sign_in_makes_no_session() {
    let rig = rig().await;
    let mut browser = Browser::default();
    rig.login(&mut browser).await;
    let query = rig.approve_last();
    rig.advance(Duration::from_secs(10 * 60 + 1));
    assert_eq!(rig.callback(&mut browser, &query).await, "expired");
    assert_eq!(rig.srn.count(TOKEN), 0);
    assert!(rig.sessions().await.is_empty());
    assert!(rig.logins().await.is_empty());
    assert!(!browser.cookies.contains_key(FLOW_COOKIE));
}

#[tokio::test]
async fn a_replayed_callback_makes_no_second_session_and_no_second_exchange() {
    let rig = rig().await;
    let mut browser = Browser::default();
    rig.login(&mut browser).await;
    let query = rig.approve_last();
    let flow = browser.cookies[FLOW_COOKIE].clone();
    assert_eq!(rig.callback(&mut browser, &query).await, "ok");
    // the same address again, with the flow cookie put back
    let mut replay = browser.clone();
    replay.cookies.insert(FLOW_COOKIE.into(), flow);
    assert_eq!(rig.callback(&mut replay, &query).await, "expired");
    assert_eq!(rig.srn.count(TOKEN), 1, "the code was presented again");
    assert_eq!(rig.sessions().await.len(), 1);
    // and the first sign-in still works (its connection was not revoked)
    assert_eq!(rig.status(&mut browser).await["status"], "signedIn");
    assert!(rig.srn.token_works(&rig.srn.tokens()[0]));
}

#[tokio::test]
async fn a_head_request_does_not_spend_the_sign_in() {
    let rig = rig().await;
    let mut browser = Browser::default();
    rig.login(&mut browser).await;
    let query = rig.approve_last();
    let response = rig
        .server
        .method(Method::HEAD, &format!("{CALLBACK_PATH}?{query}"))
        .add_header("cookie", browser.header().unwrap())
        .await;
    assert_eq!(response.status_code(), 405);
    assert_eq!(rig.srn.count(TOKEN), 0);
    assert_eq!(rig.callback(&mut browser, &query).await, "ok");
}

#[tokio::test]
async fn a_declined_or_malformed_callback_says_so() {
    let rig = rig().await;
    let mut browser = Browser::default();
    rig.login(&mut browser).await;
    let state = rig.last_state();
    assert_eq!(
        rig.callback(&mut browser, &format!("error=access_denied&state={state}"))
            .await,
        "access_denied"
    );
    assert!(rig.logins().await.is_empty(), "the sign-in was spent");
    for bad in [
        String::new(),
        format!("state={state}"),
        format!("code=short&state={state}"),
        format!("code={}&state={state}&next=/x", "c".repeat(43)),
        format!("error=server_error&state={state}"),
    ] {
        assert_eq!(rig.callback(&mut browser, &bad).await, "invalid_callback");
    }
    assert_eq!(rig.srn.count(TOKEN), 0);
    assert!(rig.sessions().await.is_empty());
}

#[tokio::test]
async fn a_refused_exchange_is_not_retried_and_makes_no_session() {
    let rig = rig().await;
    rig.srn
        .script_token(Reply::Status(400, json!({ "error": "invalid_grant" })));
    let mut browser = Browser::default();
    rig.login(&mut browser).await;
    let query = rig.approve_last();
    assert_eq!(rig.callback(&mut browser, &query).await, "exchange_failed");
    assert_eq!(rig.srn.count(TOKEN), 1);
    assert!(rig.sessions().await.is_empty());

    rig.srn.script_token(Reply::Normal);
    rig.srn
        .script_me_once(Reply::Status(401, json!({ "error": "invalid_token" })));
    rig.login(&mut browser).await;
    let query = rig.approve_last();
    assert_eq!(rig.callback(&mut browser, &query).await, "revoked");
    assert!(rig.sessions().await.is_empty());
}

#[tokio::test]
async fn another_account_at_me_keeps_nothing() {
    let rig = rig().await;
    rig.srn.issue_tokens_to(USER_SRN + 1);
    let mut browser = Browser::default();
    rig.login(&mut browser).await;
    let query = rig.approve_last();
    assert_eq!(rig.callback(&mut browser, &query).await, "account_changed");
    rig.service.settle().await;
    assert!(rig.sessions().await.is_empty());
    let token = rig.srn.tokens()[0].clone();
    assert!(
        !rig.srn.token_works(&token),
        "the new connection was not ended"
    );
}

#[tokio::test]
async fn an_older_session_is_replaced_and_its_connection_ended() {
    let rig = rig().await;
    let mut browser = Browser::default();
    rig.sign_in(&mut browser).await;
    let old_cookie = browser.session().unwrap().clone();
    let old_token = rig.srn.tokens()[0].clone();
    rig.sign_in(&mut browser).await;
    rig.service.settle().await;
    let new_cookie = browser.session().unwrap().clone();
    assert_ne!(old_cookie, new_cookie);
    let rows = rig.sessions().await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].cookie_hash, super::service::digest(&new_cookie));
    assert!(
        !rig.srn.token_works(&old_token),
        "the old connection lives on"
    );
    assert_eq!(rig.status(&mut browser).await["status"], "signedIn");

    // the old cookie is nobody now
    let mut stale = Browser::default();
    stale.cookies.insert(SESSION_COOKIE.into(), old_cookie);
    assert_eq!(rig.status(&mut stale).await["status"], "signedOut");
    assert!(
        stale.session().is_none(),
        "the stale cookie was not cleared"
    );
}

#[tokio::test]
async fn browsers_are_independent() {
    let rig = rig().await;
    let mut one = Browser::default();
    let mut two = Browser::default();
    rig.sign_in(&mut one).await;
    assert_eq!(rig.status(&mut two).await["status"], "signedOut");
    rig.sign_in(&mut two).await;
    assert_eq!(rig.sessions().await.len(), 2);
    let response = rig.logout(&mut one, json!({})).await;
    assert_eq!(response.status_code(), 200);
    assert_eq!(rig.status(&mut one).await["status"], "signedOut");
    assert_eq!(rig.status(&mut two).await["status"], "signedIn");
}

// ─── Reading ────────────────────────────────────────────────────────────

#[tokio::test]
async fn the_account_states_are_the_account_domain_s_own() {
    let rig = rig().await;
    let mut browser = Browser::default();
    // signed out is a 200, never the instance's 401
    assert_eq!(
        rig.status(&mut browser).await,
        json!({ "status": "signedOut" })
    );
    // pending, with the page to open again
    let started: Value = rig.login(&mut browser).await.json();
    let pending = rig.status(&mut browser).await;
    assert_eq!(pending["status"], "pending");
    assert_eq!(pending["authorizationUrl"], started["authorizationUrl"]);
    assert_eq!(pending["expiresAt"], started["expiresAt"]);
    // but the instance's 401 without instance access
    let response = rig.server.get(ACCOUNT_PATH).await;
    assert_eq!(response.status_code(), 401);
    // not enabled
    let off = SrnWeb::assemble(
        None,
        SrnApi::with_timeout(rig.srn.origin().clone(), Duration::from_secs(2)),
        KeySource::server_file(rig.dir.path()),
        rig.conn.clone(),
        Clock::System,
        Waits::default(),
    );
    for service in [Some(off), None] {
        let server = server_for(
            &rig.conn,
            rig.dir.path(),
            Access::Token,
            &rig.issuer,
            service,
        )
        .await;
        let state: Value = server
            .get(ACCOUNT_PATH)
            .authorization_bearer(INSTANCE_TOKEN)
            .await
            .json();
        assert_eq!(state, json!({ "status": "notEnabled" }));
        let response = server
            .post(LOGIN_PATH)
            .authorization_bearer(INSTANCE_TOKEN)
            .add_header("origin", PUBLIC)
            .json(&json!({}))
            .await;
        assert_eq!(response.status_code(), 409);
        assert_eq!(
            response.json::<Value>()["i18n_key"],
            "SrnAccount.errors.notEnabled"
        );
        let response = server.get(&format!("{CALLBACK_PATH}?code=x&state=y")).await;
        assert_eq!(response.header("location"), "/workspace?srn=not_enabled");
        // instance access is exactly as it was
        server
            .post("/api/health")
            .authorization_bearer(INSTANCE_TOKEN)
            .json(&json!({}))
            .await
            .assert_status_ok();
        assert_eq!(
            server
                .post("/api/health")
                .json(&json!({}))
                .await
                .status_code(),
            401
        );
    }
}

#[tokio::test]
async fn me_is_asked_at_most_hourly() {
    let rig = rig().await;
    let mut browser = Browser::default();
    rig.sign_in(&mut browser).await;
    assert_eq!(rig.srn.count(ME), 1);
    for _ in 0..3 {
        assert_eq!(rig.status(&mut browser).await["status"], "signedIn");
    }
    rig.advance(Duration::from_secs(59 * 60));
    rig.status(&mut browser).await;
    assert_eq!(rig.srn.count(ME), 1, "asked within the hour");
    rig.advance(Duration::from_secs(2 * 60));
    let state = rig.status(&mut browser).await;
    assert_eq!(state["online"]["status"], "confirmed");
    assert_eq!(rig.srn.count(ME), 2);
    rig.status(&mut browser).await;
    assert_eq!(rig.srn.count(ME), 2);
}

#[tokio::test]
async fn use_is_recorded_hourly_and_keeps_the_session_alive() {
    let rig = rig().await;
    let mut browser = Browser::default();
    rig.sign_in(&mut browser).await;
    let created = rig.sessions().await[0].expires_at;
    let request = rig.admit(rig.server.get(ACCOUNT_PATH));
    let response = Rig::with_cookies(request, &browser).await;
    assert!(
        set_cookie(&response, SESSION_COOKIE).is_none(),
        "written at once"
    );
    // 29 days on, a use moves the end 30 days from then
    rig.advance(Duration::from_secs(29 * 24 * 3600));
    let request = rig.admit(rig.server.get(ACCOUNT_PATH));
    let response = Rig::with_cookies(request, &browser).await;
    let renewed = set_cookie(&response, SESSION_COOKIE).unwrap();
    assert!(renewed.contains(browser.session().unwrap()));
    assert!(renewed.contains("Max-Age=2592000"));
    let moved = rig.sessions().await[0].expires_at;
    assert!(
        moved > created + chrono::Duration::days(28),
        "{created} {moved}"
    );
    // and unused for 30 days it is over
    rig.advance(Duration::from_secs(30 * 24 * 3600 + 1));
    assert_eq!(rig.status(&mut browser).await["status"], "signedOut");
}

#[tokio::test]
async fn spacering_s_401_ends_the_session_here() {
    let rig = rig().await;
    let mut browser = Browser::default();
    rig.sign_in(&mut browser).await;
    rig.advance(Duration::from_secs(61 * 60));
    rig.srn
        .script_me(Reply::Status(401, json!({ "error": "invalid_token" })));
    let state = rig.status(&mut browser).await;
    assert_eq!(state["status"], "signedOut");
    assert_eq!(state["problem"]["i18n_key"], "SrnAccount.errors.revoked");
    assert!(rig.sessions().await.is_empty());
    assert!(browser.session().is_none(), "the cookie was not cleared");
}

#[tokio::test]
async fn an_unanswered_or_busy_spacering_keeps_the_session() {
    // A read waits out the whole check: on Windows a refused connection
    // takes about two seconds (its connect retries), as long as a read's
    // own wait.
    let rig = rig_waiting(
        Access::Token,
        Waits {
            check: super::service::CHECK_DEADLINE,
            ..Waits::default()
        },
    )
    .await;
    let mut browser = Browser::default();
    rig.sign_in(&mut browser).await;
    let cases: Vec<(Reply, &str, Duration)> = vec![
        (
            Reply::Status(503, json!({ "error": "server_error" })),
            "SrnAccount.errors.server",
            Duration::from_secs(61 * 60),
        ),
        (
            Reply::RateLimited(120),
            "SrnAccount.errors.rateLimited",
            Duration::from_secs(61 * 60),
        ),
    ];
    for (reply, key, wait) in cases {
        rig.advance(wait);
        rig.srn.script_me(reply);
        let state = rig.status(&mut browser).await;
        assert_eq!(state["status"], "signedIn", "{state}");
        assert_eq!(state["online"]["status"], "unconfirmed");
        assert_eq!(state["online"]["problem"]["i18n_key"], key);
        // and it is still so on the next read, without asking again
        let asked = rig.srn.count(ME);
        let again = rig.status(&mut browser).await;
        assert_eq!(again["online"]["problem"]["i18n_key"], key);
        assert_eq!(rig.srn.count(ME), asked);
        assert_eq!(rig.sessions().await.len(), 1);
    }
    // a pause SpaceRing asked for is kept, and the hour after an answer
    let session = &rig.sessions().await[0];
    assert_eq!(session.check_problem.as_deref(), Some("rate_limited:120"));
    rig.advance(Duration::from_secs(61 * 60));
    // offline
    rig.srn.stop();
    let state = rig.status(&mut browser).await;
    assert_eq!(state["status"], "signedIn");
    assert_eq!(state["online"]["status"], "unconfirmed");
    assert_eq!(
        state["online"]["problem"]["i18n_key"],
        "SrnAccount.errors.network"
    );
    assert_eq!(rig.sessions().await.len(), 1);
    assert!(browser.session().is_some());
}

/// Short enough that an answer SpaceRing holds back for a second outlasts
/// them, and well inside the client's own two seconds.
fn short_waits() -> Waits {
    Waits {
        check: Duration::from_millis(150),
        logout: Duration::from_millis(150),
    }
}

#[tokio::test]
async fn a_check_answered_in_time_is_the_read_s_own_answer() {
    let rig = rig().await;
    let mut browser = Browser::default();
    rig.sign_in(&mut browser).await;
    rig.advance(Duration::from_secs(61 * 60));
    rig.srn.rename_user("Ada L.", None);
    let state = rig.status(&mut browser).await;
    assert_eq!(state["status"], "signedIn", "{state}");
    assert_eq!(state["account"]["name"], "Ada L.");
    assert_eq!(state["online"]["status"], "confirmed");
    assert_eq!(state["online"]["checking"], false);
    let row = &rig.sessions().await[0];
    assert_eq!(
        state["online"]["confirmedAt"],
        super::service::rfc3339(row.last_confirmed_at.unwrap())
    );
    assert_eq!(state["online"]["confirmedAt"], rig.now());
    assert_eq!(rig.srn.count(ME), 2);
}

#[tokio::test]
async fn a_slow_check_answers_the_read_at_once_and_the_next_read_after_it() {
    let rig = rig_waiting(Access::Token, short_waits()).await;
    let mut browser = Browser::default();
    rig.sign_in(&mut browser).await;
    let before = rig.sessions().await[0].clone();
    rig.advance(Duration::from_secs(61 * 60));
    rig.srn.rename_user("Ada L.", None);
    rig.srn.script_me(Reply::Slow(Duration::from_secs(1)));
    let started = Instant::now();
    let state = rig.status(&mut browser).await;
    assert!(
        started.elapsed() < Duration::from_millis(900),
        "the read waited for /me: {:?}",
        started.elapsed()
    );
    // what the row says, marked as checking
    assert_eq!(state["status"], "signedIn", "{state}");
    assert_eq!(state["account"]["name"], "Ada Lovelace");
    assert_eq!(state["online"]["status"], "confirmed");
    assert_eq!(state["online"]["checking"], true);
    assert_eq!(
        state["online"]["confirmedAt"],
        super::service::rfc3339(before.last_confirmed_at.unwrap())
    );
    // a read meanwhile starts no second check
    let meanwhile = rig.status(&mut browser).await;
    assert_eq!(meanwhile["online"]["checking"], true);
    // the check ends on its own and records what SpaceRing said
    rig.service.settle().await;
    assert_eq!(rig.srn.count(ME), 2, "the sign-in's and one check");
    let row = &rig.sessions().await[0];
    assert_eq!(row.display_name, "Ada L.");
    assert_eq!(
        super::service::rfc3339(row.last_confirmed_at.unwrap()),
        rig.now()
    );
    assert_eq!(row.check_problem, None);
    // which the next read says, without asking again
    let after = rig.status(&mut browser).await;
    assert_eq!(after["account"]["name"], "Ada L.");
    assert_eq!(after["online"]["status"], "confirmed");
    assert_eq!(after["online"]["checking"], false);
    assert_eq!(
        after["online"]["confirmedAt"],
        super::service::rfc3339(row.last_confirmed_at.unwrap())
    );
    assert_eq!(rig.srn.count(ME), 2);
    assert!(browser.session().is_some());
}

#[tokio::test]
async fn a_slow_check_without_an_answer_is_recorded_as_one() {
    let rig = rig_waiting(Access::Token, short_waits()).await;
    let mut browser = Browser::default();
    rig.sign_in(&mut browser).await;
    rig.advance(Duration::from_secs(61 * 60));
    rig.srn.script_me(Reply::Late(
        Duration::from_secs(1),
        Box::new(Reply::Status(503, json!({ "error": "server_error" }))),
    ));
    let state = rig.status(&mut browser).await;
    assert_eq!(state["online"]["checking"], true);
    assert_eq!(state["online"]["status"], "confirmed");
    rig.service.settle().await;
    assert_eq!(
        rig.sessions().await[0].check_problem.as_deref(),
        Some("server:503")
    );
    let after = rig.status(&mut browser).await;
    assert_eq!(after["status"], "signedIn");
    assert_eq!(after["online"]["status"], "unconfirmed");
    assert_eq!(after["online"]["checking"], false);
    assert_eq!(
        after["online"]["problem"]["i18n_key"],
        "SrnAccount.errors.server"
    );
    assert_eq!(rig.srn.count(ME), 2);
}

#[tokio::test]
async fn a_slow_401_or_another_account_ends_the_session_for_the_next_read() {
    let rig = rig_waiting(Access::Token, short_waits()).await;
    let mut browser = Browser::default();
    let someone_else = json!({ "user": { "srn": USER_SRN + 1, "name": "Grace", "image": null } });
    for (reply, revoked_here) in [
        (Reply::Status(401, json!({ "error": "invalid_token" })), 0),
        (Reply::Json(someone_else), 1),
    ] {
        rig.sign_in(&mut browser).await;
        rig.advance(Duration::from_secs(61 * 60));
        let logouts = rig.srn.count(LOGOUT);
        rig.srn
            .script_me(Reply::Late(Duration::from_secs(1), Box::new(reply)));
        let state = rig.status(&mut browser).await;
        assert_eq!(state["status"], "signedIn", "{state}");
        assert_eq!(state["online"]["checking"], true);
        rig.service.settle().await;
        assert!(
            rig.sessions().await.is_empty(),
            "the session outlived the answer"
        );
        assert_eq!(rig.srn.count(LOGOUT), logouts + revoked_here);
        // the cookie of a session that is gone goes with the next read
        assert!(browser.session().is_some());
        let after = rig.status(&mut browser).await;
        assert_eq!(after["status"], "signedOut", "{after}");
        assert!(browser.session().is_none(), "the cookie was not cleared");
        rig.srn.script_me(Reply::Normal);
    }
}

#[tokio::test]
async fn a_session_that_does_not_open_counts_as_signed_out_and_goes() {
    let rig = rig().await;
    let mut browser = Browser::default();
    rig.sign_in(&mut browser).await;
    // the database restored where the key is not: another key
    let elsewhere = tempfile::tempdir().unwrap();
    let moved = service_on(
        &rig.srn,
        &rig.conn,
        &rig.clock,
        KeySource::server_file(elsewhere.path()),
    );
    let server = server_for(
        &rig.conn,
        rig.dir.path(),
        Access::Token,
        &rig.issuer,
        Some(moved),
    )
    .await;
    let response = server
        .get(ACCOUNT_PATH)
        .authorization_bearer(INSTANCE_TOKEN)
        .add_header("cookie", browser.header().unwrap())
        .await;
    let state: Value = response.json();
    assert_eq!(state["status"], "signedOut");
    assert_eq!(
        state["problem"]["i18n_key"],
        "SrnAccount.errors.sessionUnreadable"
    );
    assert!(set_cookie(&response, SESSION_COOKIE)
        .unwrap()
        .contains("Max-Age=0"));
    assert!(rig.sessions().await.is_empty());
}

#[tokio::test]
async fn a_key_that_will_not_open_removes_nothing() {
    let rig = rig().await;
    let mut browser = Browser::default();
    rig.sign_in(&mut browser).await;
    // a restart, and the key file will not read (a directory in its place)
    let broken = tempfile::tempdir().unwrap();
    std::fs::create_dir(broken.path().join(KEY_FILE_NAME)).unwrap();
    let restarted = service_on(
        &rig.srn,
        &rig.conn,
        &rig.clock,
        KeySource::server_file(broken.path()),
    );
    let server = server_for(
        &rig.conn,
        rig.dir.path(),
        Access::Token,
        &rig.issuer,
        Some(restarted),
    )
    .await;
    let state: Value = server
        .get(ACCOUNT_PATH)
        .authorization_bearer(INSTANCE_TOKEN)
        .add_header("cookie", browser.header().unwrap())
        .await
        .json();
    assert_eq!(state["status"], "unavailable");
    assert_eq!(
        state["problem"]["i18n_key"],
        "SrnAccount.errors.keyUnavailable"
    );
    assert_eq!(rig.sessions().await.len(), 1);
}

#[tokio::test]
async fn a_session_survives_a_restart() {
    let rig = rig().await;
    let mut browser = Browser::default();
    rig.sign_in(&mut browser).await;
    // a new process: a new connection to the same file, the same key file
    let db = fresh_disk_db(rig.dir.path()).await;
    let restarted = service_on(
        &rig.srn,
        &db.conn,
        &rig.clock,
        KeySource::server_file(rig.dir.path()),
    );
    let server = server_for(
        &db.conn,
        rig.dir.path(),
        Access::Token,
        &rig.issuer,
        Some(restarted),
    )
    .await;
    let state: Value = server
        .get(ACCOUNT_PATH)
        .authorization_bearer(INSTANCE_TOKEN)
        .add_header("cookie", browser.header().unwrap())
        .await
        .json();
    assert_eq!(state["status"], "signedIn", "{state}");
}

// ─── Signing out ────────────────────────────────────────────────────────

#[tokio::test]
async fn signing_out_ends_it_here_and_on_spacering() {
    let rig = rig().await;
    let mut browser = Browser::default();
    rig.sign_in(&mut browser).await;
    let token = rig.srn.tokens()[0].clone();
    let response = rig
        .logout(&mut browser, json!({ "expectedSrn": USER_SRN }))
        .await;
    assert_eq!(response.status_code(), 200, "{}", response.text());
    assert_eq!(
        response.json::<Value>(),
        json!({ "state": { "status": "signedOut" }, "remote": "confirmed" })
    );
    assert!(browser.session().is_none());
    assert!(rig.sessions().await.is_empty());
    assert!(!rig.srn.token_works(&token));
    // again: nothing to sign out
    let again: Value = rig.logout(&mut browser, json!({})).await.json();
    assert_eq!(again["remote"], "notSignedIn");
}

#[tokio::test]
async fn the_session_is_gone_here_before_spacering_is_told() {
    let rig = rig().await;
    let mut browser = Browser::default();
    rig.sign_in(&mut browser).await;
    rig.srn.script_logout(Reply::Late(
        Duration::from_millis(400),
        Box::new(Reply::Normal),
    ));
    let mut signing_out = browser.clone();
    let logout = rig.logout(&mut signing_out, json!({}));
    let watch = async {
        // SpaceRing has the request (and holds the answer back): by now
        // the row must be gone
        while rig.srn.count(LOGOUT) == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        rig.sessions().await.len()
    };
    let (response, left) = tokio::join!(logout, watch);
    assert_eq!(left, 0, "the session outlived the call to SpaceRing");
    assert_eq!(response.json::<Value>()["remote"], "confirmed");
}

#[tokio::test]
async fn a_sign_out_spacering_does_not_confirm_is_still_done_here() {
    let rig = rig().await;
    let mut browser = Browser::default();
    rig.sign_in(&mut browser).await;
    rig.srn
        .script_logout(Reply::Status(503, json!({ "error": "server_error" })));
    let response = rig.logout(&mut browser, json!({ "locale": "zh_cn" })).await;
    let result: Value = response.json();
    assert_eq!(result["state"], json!({ "status": "signedOut" }));
    assert_eq!(result["remote"], "unconfirmed");
    let url = format!("{}/zh/console/clients/", rig.srn.origin());
    assert_eq!(result["manageConnectionsUrl"], url);
    assert_eq!(
        result["problem"]["i18n_key"],
        "SrnAccount.errors.signedOutLocally"
    );
    assert_eq!(
        result["problem"]["i18n_params"],
        json!({ "code": "signed_out_locally", "url": url, "reason": "server", "status": "503" })
    );
    // the local session went first, whatever SpaceRing said
    assert!(browser.session().is_none());
    assert!(rig.sessions().await.is_empty());

    // and with SpaceRing out of reach
    rig.sign_in(&mut browser).await;
    rig.srn.stop();
    let result: Value = rig.logout(&mut browser, json!({})).await.json();
    assert_eq!(result["remote"], "unconfirmed");
    assert_eq!(result["problem"]["i18n_params"]["reason"], "network");
    assert!(rig.sessions().await.is_empty());
}

#[tokio::test]
async fn a_sign_out_spacering_never_answers_is_unconfirmed_within_its_deadline() {
    let rig = rig_waiting(Access::Token, short_waits()).await;
    let mut browser = Browser::default();
    rig.sign_in(&mut browser).await;
    rig.srn.script_logout(Reply::Slow(Duration::from_secs(30)));
    let started = Instant::now();
    let response = rig.logout(&mut browser, json!({})).await;
    // the deadline ended it, not the client's own two seconds
    assert!(
        started.elapsed() < Duration::from_millis(1500),
        "{:?}",
        started.elapsed()
    );
    let result: Value = response.json();
    assert_eq!(result["state"], json!({ "status": "signedOut" }));
    assert_eq!(result["remote"], "unconfirmed");
    let url = format!("{}/console/clients/", rig.srn.origin());
    assert_eq!(result["manageConnectionsUrl"], url);
    assert_eq!(
        result["problem"]["i18n_key"],
        "SrnAccount.errors.signedOutLocally"
    );
    assert_eq!(result["problem"]["i18n_params"]["reason"], "network");
    assert_eq!(rig.srn.count(LOGOUT), 1);
    assert!(browser.session().is_none());
    assert!(rig.sessions().await.is_empty());
}

#[tokio::test]
async fn a_sign_out_needs_the_shown_account_instance_access_origin_and_json() {
    let rig = rig().await;
    let mut browser = Browser::default();
    rig.sign_in(&mut browser).await;
    let response = rig
        .logout(&mut browser, json!({ "expectedSrn": USER_SRN + 1 }))
        .await;
    assert_eq!(response.status_code(), 409);
    assert_eq!(
        response.json::<Value>()["i18n_key"],
        "SrnAccount.errors.accountChanged"
    );
    let cookie = browser.header().unwrap();
    let response = rig
        .server
        .post(LOGOUT_PATH)
        .add_header("origin", PUBLIC)
        .add_header("cookie", cookie.clone())
        .json(&json!({}))
        .await;
    assert_eq!(response.status_code(), 401);
    let response = rig
        .admit(rig.server.post(LOGOUT_PATH))
        .add_header("origin", "https://evil.example")
        .add_header("cookie", cookie.clone())
        .json(&json!({}))
        .await;
    assert_eq!(response.status_code(), 403);
    let response = rig
        .admit(rig.server.post(LOGOUT_PATH))
        .add_header("origin", PUBLIC)
        .add_header("cookie", cookie)
        .text("{}")
        .await;
    assert_eq!(response.status_code(), 400);
    assert_eq!(rig.sessions().await.len(), 1);
    assert_eq!(rig.srn.count(LOGOUT), 0);
}

// ─── Boundaries ─────────────────────────────────────────────────────────

#[tokio::test]
async fn srn_cookies_admit_nothing_on_the_instance() {
    let rig = rig().await;
    let mut browser = Browser::default();
    rig.sign_in(&mut browser).await;
    let cookie = browser.header().unwrap();
    let response = rig
        .server
        .post("/api/health")
        .add_header("cookie", cookie.clone())
        .json(&json!({}))
        .await;
    assert_eq!(response.status_code(), 401);
    let response = rig
        .server
        .post("/api/list_open_folders")
        .add_header("cookie", cookie.clone())
        .add_header("origin", PUBLIC)
        .json(&json!({}))
        .await;
    assert_eq!(response.status_code(), 401);
    let response = rig
        .server
        .get("/ws/events")
        .add_header("cookie", cookie.clone())
        .await;
    assert_eq!(response.status_code(), 401);
    // nor do they reach the account without instance access
    let response = rig
        .server
        .get(ACCOUNT_PATH)
        .add_header("cookie", cookie)
        .await;
    assert_eq!(response.status_code(), 401);
}

#[tokio::test]
async fn the_account_routes_offer_no_cors() {
    let rig = rig().await;
    for path in [LOGIN_PATH, LOGOUT_PATH, ACCOUNT_PATH] {
        let preflight = rig
            .server
            .method(Method::OPTIONS, path)
            .add_header("origin", "https://evil.example")
            .add_header("access-control-request-method", "POST")
            .add_header(
                "access-control-request-headers",
                "content-type,authorization",
            )
            .await;
        assert!(
            preflight
                .maybe_header("access-control-allow-origin")
                .is_none(),
            "{path}"
        );
        assert!(preflight
            .maybe_header("access-control-allow-credentials")
            .is_none());
    }
    let state = rig
        .admit(rig.server.get(ACCOUNT_PATH))
        .add_header("origin", "https://evil.example")
        .await;
    assert!(state.maybe_header("access-control-allow-origin").is_none());
    // where the instance API has its wildcard CORS
    let health = rig
        .admit(rig.server.post("/api/health"))
        .add_header("origin", "https://evil.example")
        .json(&json!({}))
        .await;
    assert!(health.maybe_header("access-control-allow-origin").is_some());
}

#[tokio::test]
async fn the_callback_is_answered_before_the_static_pages() {
    let rig = rig().await;
    let response = rig.server.get(CALLBACK_PATH).await;
    assert_eq!(response.status_code(), 303);
    assert_eq!(
        response.header("location"),
        "/workspace?srn=invalid_callback"
    );
    assert!(!response.text().contains("index"));
    // and any other address still is the app
    assert!(rig
        .server
        .get("/auth/srn/other")
        .await
        .text()
        .contains("index"));
}

// ─── Cleaning up ────────────────────────────────────────────────────────

#[tokio::test]
async fn the_cleanup_removes_what_is_over_and_ends_its_connections() {
    let rig = rig().await;
    let mut old = Browser::default();
    rig.sign_in(&mut old).await;
    let old_token = rig.srn.tokens()[0].clone();
    let mut pending = Browser::default();
    rig.login(&mut pending).await;
    rig.advance(Duration::from_secs(29 * 24 * 3600));
    let mut recent = Browser::default();
    rig.sign_in(&mut recent).await;
    let mut waiting = Browser::default();
    rig.login(&mut waiting).await;
    rig.advance(Duration::from_secs(2 * 24 * 3600));
    // the first session is 31 days unused; the second, two; the first
    // sign-in is long expired, the second too (ten minutes)
    let (logins, sessions) = rig.service.cleanup().await;
    assert_eq!((logins, sessions), (2, 1));
    let rows = rig.sessions().await;
    assert_eq!(rows.len(), 1);
    assert_eq!(
        rows[0].cookie_hash,
        super::service::digest(recent.session().unwrap())
    );
    assert!(!rig.srn.token_works(&old_token), "not revoked");
    assert!(rig.logins().await.is_empty());
    assert_eq!(rig.status(&mut recent).await["status"], "signedIn");
}

// ─── What stays secret ──────────────────────────────────────────────────

#[tokio::test]
async fn the_key_file_and_plain_tokens_stay_out_of_codeg_s_backup() {
    use crate::commands::backup::core::{create_backup_core, BackupInputs, BackupOptions};
    use crate::commands::backup::sections::LiveRoots;

    let rig = rig().await;
    let mut browser = Browser::default();
    rig.sign_in(&mut browser).await;
    let data = rig.dir.path();
    // the server's key sits in the data directory, beside tokens.json
    let key_file = data.join(KEY_FILE_NAME);
    assert!(key_file.is_file());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&key_file).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
    std::fs::write(data.join("tokens.json"), "{}").unwrap();

    let dest = data.join("backup.codeg.zip");
    let manifest = create_backup_core(
        BackupInputs {
            conn: &rig.conn,
            data_dir: data,
            live_roots: LiveRoots::rooted_at(data),
            app_version: "0.45.0",
            runtime_label: "server",
        },
        BackupOptions::default(),
        &dest,
        &crate::web::event_bridge::EventEmitter::Noop,
        "srn-web",
        &tokio_util::sync::CancellationToken::new(),
    )
    .await
    .unwrap();
    let paths: Vec<&str> = manifest.entries.iter().map(|e| e.path.as_str()).collect();
    assert!(paths.contains(&"db/codeg.db"), "{paths:?}");
    assert!(
        paths.iter().any(|p| p.ends_with("tokens.json")),
        "{paths:?}"
    );
    assert!(!paths.iter().any(|p| p.contains("srn-web")), "{paths:?}");

    // the database it carries holds the session, sealed
    let out = data.join("out");
    crate::commands::backup::archive::extract_all(
        &dest,
        &out,
        &manifest,
        &tokio_util::sync::CancellationToken::new(),
        &mut crate::commands::backup::archive::null_progress(),
    )
    .unwrap();
    let snapshot = std::fs::read(out.join("db/codeg.db")).unwrap();
    let token = rig.srn.tokens()[0].clone();
    assert!(!snapshot.windows(token.len()).any(|w| w == token.as_bytes()));
    let cookie = browser.session().unwrap().clone();
    assert!(!snapshot
        .windows(cookie.len())
        .any(|w| w == cookie.as_bytes()));
    let hash = super::service::digest(&cookie);
    assert!(
        snapshot.windows(hash.len()).any(|w| w == hash.as_bytes()),
        "the session is not in the snapshot"
    );
    let found: Vec<String> = walkdir::WalkDir::new(&out)
        .into_iter()
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    assert!(
        !found.iter().any(|name| name.contains("srn-web")),
        "{found:?}"
    );
}

/// Everything written to the log while it happens, at every level.
#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for Captured {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn nothing_secret_is_logged() {
    let captured = Captured::default();
    let writer = captured.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::TRACE)
        .with_ansi(false)
        .with_writer(move || writer.clone())
        .finish();
    // As in the desktop's test: a second live dispatcher keeps another test
    // thread's callsite registration from hiding this one's.
    let _second = tracing::Dispatch::new(tracing::subscriber::NoSubscriber::default());
    let _guard = tracing::subscriber::set_default(subscriber);

    let rig = rig().await;
    let mut browser = Browser::default();
    rig.sign_in(&mut browser).await;
    rig.sign_in(&mut browser).await;
    rig.advance(Duration::from_secs(61 * 60));
    rig.srn
        .script_me(Reply::Status(503, json!({ "error": "server_error" })));
    rig.status(&mut browser).await;
    rig.srn.script_me(Reply::Normal);
    rig.srn
        .script_logout(Reply::Status(502, json!({ "error": "bad_gateway" })));
    rig.logout(&mut browser, json!({})).await;
    rig.login(&mut browser).await;
    let query = rig.approve_last();
    rig.srn
        .script_token(Reply::Status(400, json!({ "error": "invalid_grant" })));
    rig.callback(&mut browser, &query).await;
    rig.service.settle().await;

    let logged = String::from_utf8_lossy(&captured.0.lock().unwrap()).to_string();
    assert!(
        logged.contains("[srn-web] sign-in came back: ok"),
        "the log was captured: {logged}"
    );
    let mut secrets: Vec<String> = vec![SECRET.to_string()];
    use base64::Engine as _;
    secrets.push(base64::engine::general_purpose::STANDARD.encode(format!("{CLIENT}:{SECRET}")));
    secrets.extend(rig.srn.issued());
    secrets.extend(rig.srn.tokens());
    secrets.extend(rig.srn.verifiers_seen());
    secrets.extend(rig.srn.request_ids());
    secrets.extend(
        rig.srn
            .logins()
            .iter()
            .map(|l| l["state"].as_str().unwrap().to_string()),
    );
    secrets.extend(browser.seen.iter().cloned());
    assert!(secrets.len() > 10);
    for secret in secrets {
        assert!(!logged.contains(&secret), "a secret in the log:\n{logged}");
    }
}

#[cfg(unix)]
#[test]
fn the_settings_never_reach_a_program_codeg_starts() {
    let script = CHILD_HIDDEN_ENV
        .iter()
        .map(|name| format!("printf '%s=%s\\n' {name} \"${{{name}-unset}}\";"))
        .collect::<String>();
    let expected = CHILD_HIDDEN_ENV
        .iter()
        .map(|name| format!("{name}=unset\n"))
        .collect::<String>();
    // set on the command, as an agent's launch environment would
    let mut command = std::process::Command::new("/bin/sh");
    command.arg("-c").arg(&script);
    for name in CHILD_HIDDEN_ENV {
        command.env(name, "/run/secrets/codeg-srn-client-secret");
    }
    crate::appimage_env::restore(&mut command);
    let out = command.output().unwrap();
    assert_eq!(String::from_utf8_lossy(&out.stdout), expected);

    // inherited from codeg's own environment, through the spawn helper
    let vars: Vec<(&str, Option<&str>)> = CHILD_HIDDEN_ENV
        .iter()
        .map(|name| (*name, Some("/run/secrets/codeg-srn-client-secret")))
        .collect();
    temp_env::with_vars(vars, || {
        let out = crate::process::std_command("/bin/sh")
            .arg("-c")
            .arg(&script)
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), expected);
        let tokio_command = crate::process::tokio_command("/bin/sh");
        assert!(!tokio_command.as_std().get_envs().any(|(name, value)| {
            CHILD_HIDDEN_ENV
                .iter()
                .any(|hidden| name == std::ffi::OsStr::new(hidden))
                && value.is_some()
        }));
    });

    // the built-in terminal's shell
    let mut pty = portable_pty::CommandBuilder::new("/bin/sh");
    for name in CHILD_HIDDEN_ENV {
        pty.env(name, "/run/secrets/codeg-srn-client-secret");
    }
    crate::appimage_env::restore_pty(&mut pty);
    for name in CHILD_HIDDEN_ENV {
        assert!(pty.get_env(name).is_none(), "{name}");
    }
}

#[tokio::test]
async fn the_desktop_and_server_keys_never_go_through_tokens_json() {
    // The server's key is a file of its own: making it writes nothing else.
    let dir = tempfile::tempdir().unwrap();
    Sealer::new(KeySource::server_file(dir.path()))
        .key()
        .await
        .unwrap();
    let names: Vec<String> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
        .collect();
    assert_eq!(names, vec![KEY_FILE_NAME.to_string()]);
    // and the origin rule is the desktop's: release builds talk to
    // spacering.net only
    assert_eq!(
        crate::harness::origin::resolve(true, Some("https://elsewhere.example")),
        Origin::release()
    );
}
