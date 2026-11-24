//! A stand-in for SpaceRing's account API, for tests: an HTTP server on
//! loopback, started inside each test, that behaves like `api/clients/` — it
//! issues request IDs, codes and tokens, checks PKCE and the redirect, revokes
//! on logout and on a code presented twice — and answers whatever a test
//! scripts instead. It records every request. Nothing here reaches
//! spacering.net.
//!
//! Also the test's browser: [`raw_get`] sends one hand-written request to the
//! loopback listener, with exactly the request line and `Host` a test asks
//! for.

// The account's tests are desktop-only, like the account; the client's run
// in both runtimes.
#![cfg_attr(not(feature = "tauri-runtime"), allow(dead_code))]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::Request;
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::client::{CodeExchange, CreatedLogin, Grant, LoginRequest, SrnApi};
use super::pkce::{AuthCode, FlowSecret};
use crate::harness::origin::Origin;

/// What the stand-in answers a request with, instead of what SpaceRing would.
#[derive(Debug, Clone)]
pub(crate) enum Reply {
    /// As SpaceRing would.
    Normal,
    /// 200 with this JSON.
    Json(Value),
    /// This status, with this JSON.
    Status(u16, Value),
    /// 429 with this `Retry-After`.
    RateLimited(u64),
    /// 302 to this path.
    Redirect(String),
    /// This status, media type and body.
    Text(u16, &'static str, String),
    /// As SpaceRing would, after this long.
    Slow(Duration),
    /// This reply, after this long.
    Late(Duration, Box<Reply>),
}

/// One request, as the stand-in received it.
#[derive(Debug, Clone)]
pub(crate) struct Seen {
    pub method: Method,
    pub path: String,
    pub headers: HeaderMap,
    pub body: Bytes,
}

impl Seen {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|value| value.to_str().ok())
    }

    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
}

struct Login {
    body: Value,
    request_id: String,
    code: Option<String>,
    consumed: bool,
    issued: Option<String>,
}

#[derive(Clone)]
struct User {
    srn: u64,
    name: String,
    image: Option<String>,
}

#[derive(Default)]
struct Script {
    login: Option<Reply>,
    token: Option<Reply>,
    me: Option<Reply>,
    /// For the next `/me` only, before `me`.
    me_once: Option<Reply>,
    logout: Option<Reply>,
    authorization_url: Option<String>,
    /// Who the next tokens are issued to, when not [`State::user`].
    token_user: Option<User>,
}

struct State {
    origin: String,
    seen: Vec<Seen>,
    logins: Vec<Login>,
    /// Issued tokens: who they are for, and whether they still work.
    tokens: HashMap<String, (u64, bool)>,
    user: User,
    script: Script,
    /// The order things happened in, shared with whatever else a test
    /// records into it (the fake keychain).
    journal: Arc<Mutex<Vec<String>>>,
    /// The verifiers the test's own requests used, by request ID.
    verifiers: HashMap<String, FlowSecret>,
}

pub(crate) const USER_SRN: u64 = 10_000;
pub(crate) const AVATAR_PATH: &str =
    "/api/avatars/0199b5e2-6c4f-7d1a-9f2e-3c8a1b5d7e90/4f1c2a9e8b7d6c5a.png";

pub(crate) struct MockSrn {
    origin: Origin,
    state: Arc<Mutex<State>>,
    task: tokio::task::JoinHandle<()>,
}

fn random43() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn s256(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

impl MockSrn {
    pub async fn start() -> Self {
        Self::start_with_journal(Arc::default()).await
    }

    pub async fn start_with_journal(journal: Arc<Mutex<Vec<String>>>) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let state = Arc::new(Mutex::new(State {
            origin: origin.clone(),
            seen: Vec::new(),
            logins: Vec::new(),
            tokens: HashMap::new(),
            user: User {
                srn: USER_SRN,
                name: "Ada Lovelace".into(),
                image: Some(format!("{origin}{AVATAR_PATH}")),
            },
            script: Script::default(),
            journal,
            verifiers: HashMap::new(),
        }));
        let app = axum::Router::new().fallback({
            let state = state.clone();
            move |request: Request| {
                let state = state.clone();
                async move { answer(state, request).await }
            }
        });
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Self {
            origin: Origin::parse(&origin).expect("a loopback origin"),
            state,
            task,
        }
    }

    pub fn origin(&self) -> &Origin {
        &self.origin
    }

    /// A client of this stand-in, with a short deadline.
    pub fn api(&self) -> SrnApi {
        SrnApi::with_timeout(self.origin.clone(), Duration::from_secs(5))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap()
    }

    /// Stops answering: from now on a request is refused.
    pub fn stop(&self) {
        self.task.abort();
    }

    pub fn script_login(&self, reply: Reply) {
        self.lock().script.login = Some(reply);
    }

    pub fn script_token(&self, reply: Reply) {
        self.lock().script.token = Some(reply);
    }

    pub fn script_me(&self, reply: Reply) {
        self.lock().script.me = Some(reply);
    }

    /// The next `/me` only.
    pub fn script_me_once(&self, reply: Reply) {
        self.lock().script.me_once = Some(reply);
    }

    pub fn script_logout(&self, reply: Reply) {
        self.lock().script.logout = Some(reply);
    }

    /// The authorization page to name, with `{origin}` and `{id}` filled in.
    pub fn script_authorization_url(&self, template: &str) {
        self.lock().script.authorization_url = Some(template.to_string());
    }

    /// Tokens are issued to this SRN from now on, while `/me` still answers
    /// for whoever holds them.
    pub fn issue_tokens_to(&self, srn: u64) {
        let mut state = self.lock();
        let mut user = state.user.clone();
        user.srn = srn;
        state.script.token_user = Some(user);
    }

    /// The account's name and picture change on the website.
    pub fn rename_user(&self, name: &str, image: Option<String>) {
        let mut state = self.lock();
        state.user.name = name.to_string();
        state.user.image = image;
    }

    pub fn user_srn(&self) -> u64 {
        USER_SRN
    }

    pub fn avatar_path(&self) -> &'static str {
        AVATAR_PATH
    }

    pub fn seen(&self) -> Vec<Seen> {
        self.lock().seen.clone()
    }

    pub fn paths(&self) -> Vec<String> {
        self.lock().seen.iter().map(|s| s.path.clone()).collect()
    }

    pub fn count(&self, path: &str) -> usize {
        self.lock().seen.iter().filter(|s| s.path == path).count()
    }

    /// The bodies of the login requests created, oldest first.
    pub fn logins(&self) -> Vec<Value> {
        self.lock().logins.iter().map(|l| l.body.clone()).collect()
    }

    /// The request IDs issued, oldest first.
    pub fn request_ids(&self) -> Vec<String> {
        self.lock()
            .logins
            .iter()
            .map(|l| l.request_id.clone())
            .collect()
    }

    /// Every code and token issued so far.
    pub fn issued(&self) -> Vec<String> {
        let state = self.lock();
        let mut all: Vec<String> = state.logins.iter().filter_map(|l| l.code.clone()).collect();
        all.extend(state.tokens.keys().cloned());
        all
    }

    pub fn tokens(&self) -> Vec<String> {
        self.lock().tokens.keys().cloned().collect()
    }

    /// Whether `token` still works.
    pub fn token_works(&self, token: &str) -> bool {
        self.lock()
            .tokens
            .get(token)
            .is_some_and(|(_, works)| *works)
    }

    /// Every verifier a token request carried.
    pub fn verifiers_seen(&self) -> Vec<String> {
        self.lock()
            .seen
            .iter()
            .filter(|s| s.path == "/api/client/v1/token")
            .filter_map(|s| s.json()["code_verifier"].as_str().map(str::to_string))
            .collect()
    }

    /// What the person does on the authorization page of the `index`-th
    /// login request: approve it. The address the page sends the browser to:
    /// `(port, path and query)`.
    pub fn approve_nth(&self, index: usize) -> (u16, String) {
        let mut state = self.lock();
        let code = random43();
        let login = &mut state.logins[index];
        login.code = Some(code.clone());
        callback(&login.body, &[("code", &code)])
    }

    /// The same, declining.
    pub fn deny_nth(&self, index: usize) -> (u16, String) {
        let state = self.lock();
        callback(&state.logins[index].body, &[("error", "access_denied")])
    }

    /// Approving a request the test made itself through [`Self::create`]:
    /// the code.
    pub fn approve(&self, created: &CreatedLogin) -> Option<AuthCode> {
        let mut state = self.lock();
        let code = random43();
        let login = state
            .logins
            .iter_mut()
            .find(|l| l.request_id == created.request_id.expose())?;
        login.code = Some(code.clone());
        AuthCode::parse(&code)
    }

    /// A login request made directly through `api`, with secrets of its own.
    pub async fn create(&self, api: &SrnApi) -> CreatedLogin {
        let state = FlowSecret::generate().unwrap();
        let verifier = FlowSecret::generate().unwrap();
        let challenge = verifier.challenge();
        let created = api
            .create_login_request(&LoginRequest {
                client_id: "codeg-desktop",
                redirect_uri: "http://127.0.0.1:43210/auth/callback",
                state: &state,
                code_challenge: &challenge,
                installation_id: "installation-0123456789",
                platform: std::env::consts::OS,
                device_name: Some("Test machine"),
            })
            .await
            .expect("the login request");
        self.lock()
            .verifiers
            .insert(created.request_id.expose().to_string(), verifier);
        created
    }

    pub fn verifier_of(&self, created: &CreatedLogin) -> FlowSecret {
        self.lock().verifiers[created.request_id.expose()].clone()
    }

    pub fn redirect_of(&self, _created: &CreatedLogin) -> String {
        "http://127.0.0.1:43210/auth/callback".to_string()
    }

    pub fn login_body(&self, created: &CreatedLogin) -> Value {
        self.lock()
            .logins
            .iter()
            .find(|l| l.request_id == created.request_id.expose())
            .map(|l| l.body.clone())
            .unwrap()
    }

    /// A whole sign-in, straight through the API.
    pub async fn sign_in_directly(&self, api: &SrnApi) -> Grant {
        let created = self.create(api).await;
        let code = self.approve(&created).unwrap();
        let verifier = self.verifier_of(&created);
        api.exchange_code(&CodeExchange {
            client_id: "codeg-desktop",
            redirect_uri: &self.redirect_of(&created),
            code: &code,
            verifier: &verifier,
        })
        .await
        .expect("the exchange")
    }

    /// A token SpaceRing issued outside any flow, as if signed in before.
    pub fn issue_token(&self) -> String {
        let token = random43();
        let mut state = self.lock();
        let srn = state.user.srn;
        state.tokens.insert(token.clone(), (srn, true));
        token
    }
}

impl Drop for MockSrn {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// The loopback address a login request named, with `pairs` and its state
/// as the query.
fn callback(body: &Value, pairs: &[(&str, &str)]) -> (u16, String) {
    let redirect = url::Url::parse(body["redirect_uri"].as_str().unwrap()).unwrap();
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    for (name, value) in pairs {
        query.append_pair(name, value);
    }
    query.append_pair("state", body["state"].as_str().unwrap());
    (
        redirect.port().unwrap(),
        format!("{}?{}", redirect.path(), query.finish()),
    )
}

async fn answer(state: Arc<Mutex<State>>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let body = axum::body::to_bytes(body, 1 << 20)
        .await
        .unwrap_or_default();
    let seen = Seen {
        method: parts.method.clone(),
        path: parts.uri.path().to_string(),
        headers: parts.headers.clone(),
        body,
    };
    let (script, journal) = {
        let mut state = state.lock().unwrap();
        state.seen.push(seen.clone());
        let script = match seen.path.as_str() {
            "/api/client/v1/login-requests" => state.script.login.clone(),
            "/api/client/v1/token" => state.script.token.clone(),
            "/api/client/v1/me" => state
                .script
                .me_once
                .take()
                .or_else(|| state.script.me.clone()),
            "/api/client/v1/logout" => state.script.logout.clone(),
            _ => None,
        };
        (script, state.journal.clone())
    };
    journal.lock().unwrap().push(format!(
        "srn {}",
        seen.path.rsplit('/').next().unwrap_or("")
    ));
    let reply = match script.unwrap_or(Reply::Normal) {
        Reply::Slow(delay) => {
            tokio::time::sleep(delay).await;
            Reply::Normal
        }
        Reply::Late(delay, reply) => {
            tokio::time::sleep(delay).await;
            *reply
        }
        reply => reply,
    };
    immediately(&state, &seen, reply)
}

fn immediately(state: &Arc<Mutex<State>>, seen: &Seen, reply: Reply) -> Response {
    match reply {
        Reply::Normal | Reply::Slow(_) | Reply::Late(..) => as_spacering(state, seen),
        Reply::Json(value) => axum::Json(value).into_response(),
        Reply::Status(status, value) => {
            (StatusCode::from_u16(status).unwrap(), axum::Json(value)).into_response()
        }
        Reply::RateLimited(seconds) => (
            StatusCode::TOO_MANY_REQUESTS,
            [(header::RETRY_AFTER, seconds.to_string())],
            axum::Json(json!({ "error": "rate_limited" })),
        )
            .into_response(),
        Reply::Redirect(to) => (StatusCode::FOUND, [(header::LOCATION, to)]).into_response(),
        Reply::Text(status, content_type, text) => (
            StatusCode::from_u16(status).unwrap(),
            [(header::CONTENT_TYPE, content_type)],
            text,
        )
            .into_response(),
    }
}

fn error(status: StatusCode, code: &str) -> Response {
    (status, axum::Json(json!({ "error": code }))).into_response()
}

fn bearer(seen: &Seen) -> Option<String> {
    seen.header("authorization")
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::to_string)
}

fn user_json(user: &User) -> Value {
    json!({ "srn": user.srn, "name": user.name, "image": user.image })
}

/// What `api/clients/routes.ts` answers.
fn as_spacering(state: &Arc<Mutex<State>>, seen: &Seen) -> Response {
    let mut state = state.lock().unwrap();
    if seen.header("cookie").is_some() {
        return error(StatusCode::BAD_REQUEST, "invalid_request");
    }
    match (seen.method.as_str(), seen.path.as_str()) {
        ("POST", "/api/client/v1/login-requests") => {
            let body = seen.json();
            let fine = body["response_type"] == "code"
                && body["scope"] == "profile:read"
                && body["code_challenge_method"] == "S256"
                && body["state"].as_str().is_some_and(|s| s.len() >= 43)
                && body["code_challenge"]
                    .as_str()
                    .is_some_and(|c| c.len() == 43);
            if !fine {
                return error(StatusCode::BAD_REQUEST, "invalid_request");
            }
            let request_id = random43();
            let url = match &state.script.authorization_url {
                Some(template) => template
                    .replace("{origin}", &state.origin)
                    .replace("{id}", &request_id),
                None => format!("{}/authorize/#request_id={request_id}", state.origin),
            };
            state.logins.push(Login {
                body,
                request_id: request_id.clone(),
                code: None,
                consumed: false,
                issued: None,
            });
            axum::Json(json!({
                "request_id": request_id,
                "authorization_url": url,
                "expires_at": "2026-11-16T00:10:00.000Z",
            }))
            .into_response()
        }
        ("POST", "/api/client/v1/token") => {
            let body = seen.json();
            let code = body["code"].as_str().unwrap_or_default().to_string();
            let verifier = body["code_verifier"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            let redirect = body["redirect_uri"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            let Some(index) = state
                .logins
                .iter()
                .position(|l| l.code.as_deref() == Some(code.as_str()))
            else {
                return error(StatusCode::BAD_REQUEST, "invalid_grant");
            };
            let challenge_ok = state.logins[index].body["code_challenge"] == s256(&verifier);
            let redirect_ok = state.logins[index].body["redirect_uri"] == redirect.as_str();
            if !challenge_ok || !redirect_ok {
                return error(StatusCode::BAD_REQUEST, "invalid_grant");
            }
            if state.logins[index].consumed {
                // presented again: the connection it opened ends
                if let Some(issued) = state.logins[index].issued.clone() {
                    if let Some(entry) = state.tokens.get_mut(&issued) {
                        entry.1 = false;
                    }
                }
                return error(StatusCode::BAD_REQUEST, "invalid_grant");
            }
            let user = state
                .script
                .token_user
                .clone()
                .unwrap_or_else(|| state.user.clone());
            let token = random43();
            state.tokens.insert(token.clone(), (user.srn, true));
            state.logins[index].consumed = true;
            state.logins[index].issued = Some(token.clone());
            axum::Json(json!({
                "access_token": token,
                "token_type": "Bearer",
                "scope": "profile:read",
                "expires_at": "2026-12-16T00:00:00.000Z",
                "connection_id": "0199b5e2-0000-7000-8000-000000000001",
                "user": user_json(&user),
            }))
            .into_response()
        }
        ("GET", "/api/client/v1/me") => {
            let works = bearer(seen)
                .and_then(|token| state.tokens.get(&token).copied())
                .filter(|(_, works)| *works);
            match works {
                Some(_) => axum::Json(json!({
                    "scope": "profile:read",
                    "expires_at": "2026-12-16T00:00:00.000Z",
                    "connection_id": "0199b5e2-0000-7000-8000-000000000001",
                    "user": user_json(&state.user),
                }))
                .into_response(),
                None => error(StatusCode::UNAUTHORIZED, "invalid_token"),
            }
        }
        ("POST", "/api/client/v1/logout") => match bearer(seen) {
            Some(token) => {
                if let Some(entry) = state.tokens.get_mut(&token) {
                    entry.1 = false;
                }
                axum::Json(json!({ "ok": true })).into_response()
            }
            None => error(StatusCode::UNAUTHORIZED, "invalid_token"),
        },
        _ => error(StatusCode::NOT_FOUND, "not_found"),
    }
}

/// Whether connections to `127.0.0.1:<port>` are refused within a second.
pub(crate) async fn wait_closed(port: u16) -> bool {
    for _ in 0..100 {
        if tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_err()
        {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    false
}

/// What a raw request to the loopback listener got back.
#[derive(Debug)]
pub(crate) struct RawResponse {
    pub status: u16,
    /// Header lines, names lowercase.
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl RawResponse {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    }
}

/// Sends `GET <target>` to `127.0.0.1:<port>` exactly as written — `host`
/// is the `Host` header's value, none when `None` — and reads the answer to
/// its end.
pub(crate) async fn raw_get(
    port: u16,
    target: &str,
    host: Option<&str>,
) -> std::io::Result<RawResponse> {
    raw_request(port, "GET", target, host).await
}

pub(crate) async fn raw_request(
    port: u16,
    method: &str,
    target: &str,
    host: Option<&str>,
) -> std::io::Result<RawResponse> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await?;
    let mut request = format!("{method} {target} HTTP/1.1\r\n");
    if let Some(host) = host {
        request.push_str(&format!("Host: {host}\r\n"));
    }
    request.push_str("Connection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).await?;
    let mut raw = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut raw))
        .await
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "no answer"))??;
    let text = String::from_utf8_lossy(&raw).to_string();
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .and_then(|line| line.split(' ').nth(1))
        .and_then(|code| code.parse().ok())
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "no status"))?;
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(n, v)| (n.trim().to_ascii_lowercase(), v.trim().to_string()))
        .collect();
    Ok(RawResponse {
        status,
        headers,
        body: body.to_string(),
    })
}
