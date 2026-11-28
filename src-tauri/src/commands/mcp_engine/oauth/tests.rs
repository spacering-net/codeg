use std::collections::BTreeMap;
use std::convert::Infallible;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex as SyncMutex;

use axum::body::{Body, Bytes};
use axum::extract::{Path as AxumPath, Query};
use axum::routing::{get, post};
use axum::{Form, Json};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use futures_util::{stream, StreamExt};
use http::{header, HeaderMap};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::{broadcast, mpsc};

use crate::commands::mcp_engine::{mcp_probe_core, McpProbeRequest};
use crate::db::test_helpers::fresh_in_memory_db;
use crate::web::event_bridge::{WebEvent, WebEventBroadcaster};

use super::*;

const CLIENT_SECRET: &str = "only-in-the-keyring";
const REFRESH_TOKEN: &str = "upstream-private-refresh";
const FIRST_ACCESS: &str = "upstream-private-access";
const SECOND_ACCESS: &str = "upstream-replacement-access";
const SESSION_ID: &str = "test-mcp-session";
const LEGACY_TICKET: &str = "private-upstream-sse-ticket";

type Fields = BTreeMap<String, String>;

struct Mock {
    base: String,
    codes: SyncMutex<BTreeMap<String, Fields>>,
    registered: SyncMutex<Vec<Value>>,
    auth_exchanges: AtomicUsize,
    refreshes: AtomicUsize,
    forwarded: AtomicUsize,
    discovered: AtomicUsize,
    reject_initial: AtomicBool,
    reject_refresh: AtomicBool,
    reject_replacement: AtomicBool,
    initial_ttl: AtomicU64,
    echoed_text: SyncMutex<Option<String>>,
    sse_sessions: SyncMutex<BTreeMap<String, mpsc::UnboundedSender<Bytes>>>,
}

impl Mock {
    async fn launch() -> (Arc<Self>, JoinHandle<()>) {
        let listener = bind_loopback(0).await.unwrap();
        let mock = Arc::new(Self {
            base: format!("http://{}", listener.local_addr().unwrap()),
            codes: Default::default(),
            registered: Default::default(),
            auth_exchanges: AtomicUsize::new(0),
            refreshes: AtomicUsize::new(0),
            forwarded: AtomicUsize::new(0),
            discovered: AtomicUsize::new(0),
            reject_initial: AtomicBool::new(false),
            reject_refresh: AtomicBool::new(false),
            reject_replacement: AtomicBool::new(false),
            initial_ttl: AtomicU64::new(3600),
            echoed_text: Default::default(),
            sse_sessions: Default::default(),
        });
        let router = Router::new()
            .route("/metadata/{kind}", get(resource_metadata))
            .route(
                "/.well-known/oauth-authorization-server/tenant",
                get(server_metadata),
            )
            .route("/register", post(register))
            .route("/authorize", get(authorize_browser))
            .route("/token", post(token))
            .route("/mcp", get(http_get).post(http_post))
            .route("/legacy", get(sse_get))
            .route("/messages", post(sse_post))
            .with_state(mock.clone());
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        (mock, task)
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    fn challenge(&self, kind: &str) -> Response {
        (
            StatusCode::UNAUTHORIZED,
            [(
                header::WWW_AUTHENTICATE,
                format!(
                    "Basic realm=\"MCP\", Bearer realm=\"MCP\", resource_metadata=\"{}\"",
                    self.url(&format!("/metadata/{kind}"))
                ),
            )],
        )
            .into_response()
    }

    fn authorized(&self, headers: &HeaderMap) -> bool {
        self.forwarded.fetch_add(1, Ordering::SeqCst);
        match headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
        {
            Some(FIRST_ACCESS) => !self.reject_initial.load(Ordering::SeqCst),
            Some(SECOND_ACCESS) => !self.reject_replacement.load(Ordering::SeqCst),
            _ => false,
        }
    }

    fn rpc(&self, request: Value) -> Option<Value> {
        let result = match request["method"].as_str().unwrap() {
            "initialize" => json!({
                "protocolVersion": request["params"]["protocolVersion"],
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "protected", "version": "1"},
            }),
            "notifications/initialized" => return None,
            "tools/list" => {
                json!({"tools": [{"name": "example", "description": self.echoed_text.lock().unwrap().clone().unwrap_or_default(), "inputSchema": {"type": "object"}}]})
            }
            _ => panic!("Unexpected MCP method"),
        };
        Some(json!({"jsonrpc": "2.0", "id": request["id"], "result": result}))
    }
}

async fn resource_metadata(
    State(mock): State<Arc<Mock>>,
    AxumPath(kind): AxumPath<String>,
) -> Json<Value> {
    mock.discovered.fetch_add(1, Ordering::SeqCst);
    Json(json!({
        "resource": mock.url(if kind == "legacy" { "/legacy" } else { "/mcp" }),
        "authorization_servers": [mock.url("/tenant")],
        "scopes_supported": ["tools:read"],
    }))
}

async fn server_metadata(State(mock): State<Arc<Mock>>) -> Json<Value> {
    Json(json!({
        "issuer": mock.url("/tenant"),
        "authorization_endpoint": mock.url("/authorize?tenant=test"),
        "token_endpoint": mock.url("/token"),
        "registration_endpoint": mock.url("/register"),
        "scopes_supported": ["tools:read", "tools:write"],
        "token_endpoint_auth_methods_supported": ["none", "client_secret_post"],
        "code_challenge_methods_supported": ["S256"],
    }))
}

async fn register(State(mock): State<Arc<Mock>>, Json(request): Json<Value>) -> impl IntoResponse {
    assert_eq!(
        request["grant_types"],
        json!(["authorization_code", "refresh_token"])
    );
    assert_eq!(request["response_types"], json!(["code"]));
    assert_eq!(request["token_endpoint_auth_method"], "none");
    assert_eq!(request["client_name"], "Codeg");
    let id = format!("dynamic-{}", mock.registered.lock().unwrap().len());
    mock.registered.lock().unwrap().push(request);
    (StatusCode::CREATED, Json(json!({"client_id": id})))
}

async fn authorize_browser(State(mock): State<Arc<Mock>>, Query(query): Query<Fields>) -> Response {
    assert_eq!(query["response_type"], "code");
    assert_eq!(query["code_challenge_method"], "S256");
    assert_eq!(query["tenant"], "test");
    assert!(crate::srn::pkce::is_opaque(&query["state"]));
    assert!(crate::srn::pkce::is_opaque(&query["code_challenge"]));
    let code = uuid::Uuid::new_v4().to_string();
    let mut callback = Url::parse(&query["redirect_uri"]).unwrap();
    callback
        .query_pairs_mut()
        .append_pair("state", &query["state"])
        .append_pair("code", &code)
        .append_pair("untrusted", "<script>no-reflection</script>");
    mock.codes.lock().unwrap().insert(code, query);
    (
        StatusCode::FOUND,
        [(header::LOCATION, callback.to_string())],
    )
        .into_response()
}

async fn token(State(mock): State<Arc<Mock>>, Form(form): Form<Fields>) -> Response {
    if form["grant_type"] == "refresh_token" {
        mock.refreshes.fetch_add(1, Ordering::SeqCst);
        assert_eq!(form["refresh_token"], REFRESH_TOKEN);
        tokio::time::sleep(Duration::from_millis(50)).await;
        if mock.reject_refresh.load(Ordering::SeqCst) {
            return (
                StatusCode::BAD_REQUEST,
                format!("{{\"error_description\":\"{REFRESH_TOKEN}\"}}"),
            )
                .into_response();
        }
        return Json(
            json!({"access_token": SECOND_ACCESS, "token_type": "Bearer", "expires_in": 3600}),
        )
        .into_response();
    }
    mock.auth_exchanges.fetch_add(1, Ordering::SeqCst);
    assert_eq!(form["grant_type"], "authorization_code");
    let browser = mock.codes.lock().unwrap().remove(&form["code"]).unwrap();
    let verifier = &form["code_verifier"];
    assert!(crate::srn::pkce::is_opaque(verifier));
    assert_eq!(
        URL_SAFE_NO_PAD.encode(Sha256::digest(verifier)),
        browser["code_challenge"]
    );
    for field in ["resource", "redirect_uri", "client_id"] {
        assert_eq!(form[field], browser[field]);
    }
    if form["client_id"] == "manual" {
        assert_eq!(form["client_secret"], CLIENT_SECRET);
    }
    Json(json!({
        "access_token": FIRST_ACCESS,
        "refresh_token": REFRESH_TOKEN,
        "token_type": "bearer",
        "expires_in": mock.initial_ttl.load(Ordering::SeqCst),
        "scope": browser.get("scope").cloned().unwrap_or_default(),
    }))
    .into_response()
}

async fn http_get(State(mock): State<Arc<Mock>>, headers: HeaderMap) -> Response {
    if !headers.contains_key(header::AUTHORIZATION) {
        return mock.challenge("http");
    }
    if !mock.authorized(&headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if let Some(last_event_id) = headers.get("last-event-id") {
        assert_eq!(last_event_id, "continue-1");
    }
    (
        [(header::CONTENT_TYPE, "text/event-stream")],
        "id: continue-2\ndata: {}\n\n",
    )
        .into_response()
}

async fn http_post(
    State(mock): State<Arc<Mock>>,
    headers: HeaderMap,
    Json(request): Json<Value>,
) -> Response {
    if !mock.authorized(&headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    assert_eq!(headers[header::CONTENT_TYPE], "application/json");
    assert!(!headers.contains_key("x-private"));
    if request["method"] == "redirect" {
        return (
            StatusCode::TEMPORARY_REDIRECT,
            [(header::LOCATION, mock.url("/token"))],
        )
            .into_response();
    }
    if request["method"] != "initialize" {
        assert_eq!(headers["mcp-session-id"], SESSION_ID);
        assert!(headers.contains_key("mcp-protocol-version"));
    }
    let Some(reply) = mock.rpc(request) else {
        return StatusCode::ACCEPTED.into_response();
    };
    ([("mcp-session-id", SESSION_ID)], Json(reply)).into_response()
}

async fn sse_get(State(mock): State<Arc<Mock>>, headers: HeaderMap) -> Response {
    if !headers.contains_key(header::AUTHORIZATION) {
        return mock.challenge("legacy");
    }
    if !mock.authorized(&headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let id = uuid::Uuid::new_v4().to_string();
    let (sender, receiver) = mpsc::unbounded_channel();
    mock.sse_sessions.lock().unwrap().insert(id.clone(), sender);
    let endpoint = format!("ta: /messages?session={id}&ticket={LEGACY_TICKET}\r\n\r\n");
    let messages = stream::unfold(receiver, |mut receiver| async move {
        receiver
            .recv()
            .await
            .map(|bytes| (Ok::<_, Infallible>(bytes), receiver))
    });
    let body = stream::iter([
        Ok(Bytes::from_static(b"\xEF\xBB\xBFevent: endpoint\rda")),
        Ok(Bytes::from(endpoint)),
    ])
    .chain(messages);
    (
        [(header::CONTENT_TYPE, "text/event-stream")],
        Body::from_stream(body),
    )
        .into_response()
}

async fn sse_post(
    State(mock): State<Arc<Mock>>,
    Query(query): Query<Fields>,
    headers: HeaderMap,
    Json(request): Json<Value>,
) -> Response {
    if !mock.authorized(&headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    assert_eq!(query["ticket"], LEGACY_TICKET);
    if let Some(message) = mock.rpc(request) {
        let sessions = mock.sse_sessions.lock().unwrap();
        sessions[&query["session"]]
            .send(Bytes::from(format!("event: message\ndata: {message}\n\n")))
            .unwrap();
    }
    StatusCode::ACCEPTED.into_response()
}

struct Fixture {
    dir: tempfile::TempDir,
    store: Arc<store::MemorySecretStore>,
    bridge: Arc<McpOAuthBridge>,
    mock: Arc<Mock>,
    mock_task: JoinHandle<()>,
    client: Client,
    events: broadcast::Receiver<WebEvent>,
}

impl Fixture {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(store::MemorySecretStore::default());
        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let bridge = McpOAuthBridge::with_store(
            dir.path(),
            EventEmitter::test_web_only(broadcaster.clone()),
            store.clone(),
        );
        let (mock, mock_task) = Mock::launch().await;
        Self {
            dir,
            store,
            bridge,
            mock,
            mock_task,
            client: protocol::client().unwrap(),
            events: broadcaster.subscribe(),
        }
    }

    async fn start(&self, transport: McpOAuthTransport, manual: bool) -> McpOAuthStartResult {
        let (path, metadata) = if transport == McpOAuthTransport::Sse {
            ("/legacy", "/metadata/legacy")
        } else {
            ("/mcp", "/metadata/http")
        };
        self.bridge
            .mcp_oauth_start_core(McpOAuthStartRequest {
                upstream_url: self.mock.url(path),
                transport: Some(transport),
                resource_metadata_url: manual.then(|| self.mock.url(metadata)),
                client_id: manual.then(|| "manual".to_owned()),
                client_secret: manual.then(|| CLIENT_SECRET.to_owned()),
                scopes: None,
            })
            .await
            .unwrap()
    }

    async fn redirect(&self, start: &McpOAuthStartResult) -> String {
        let response = self
            .client
            .get(&start.authorization_url)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FOUND);
        response.headers()[header::LOCATION]
            .to_str()
            .unwrap()
            .to_owned()
    }

    async fn complete(
        &self,
        start: &McpOAuthStartResult,
        callback_url: String,
    ) -> Result<McpOAuthRouteInfo> {
        self.bridge
            .mcp_oauth_complete_callback_core(McpOAuthCompleteCallbackRequest {
                flow_id: start.flow_id.clone(),
                callback_url,
            })
            .await
    }

    async fn authorize(&self, transport: McpOAuthTransport) -> McpOAuthRouteInfo {
        let start = self.start(transport, false).await;
        self.complete(&start, self.redirect(&start).await)
            .await
            .unwrap()
    }

    async fn definition(&self, route: &McpOAuthRouteInfo) -> McpDefinition {
        self.bridge
            .mcp_oauth_bridge_definition_core(McpOAuthBridgeDefinitionRequest {
                route_id: route.route_id.clone(),
            })
            .await
            .unwrap()
    }

    async fn event(&mut self, status: McpOAuthGrantStatus) {
        let status = serde_json::to_value(status).unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let event = self.events.recv().await.unwrap();
                assert_eq!(event.channel, MCP_OAUTH_CHANGED_EVENT);
                assert_eq!(event.payload.as_object().unwrap().len(), 3);
                if event.payload["status"] == status {
                    break;
                }
            }
        })
        .await
        .unwrap();
    }

    async fn get(&self, definition: &McpDefinition) -> reqwest::Response {
        let (url, headers) = definition.remote().unwrap();
        self.client
            .get(url)
            .header(header::AUTHORIZATION, &headers["Authorization"])
            .send()
            .await
            .unwrap()
    }

    async fn probe(&self, definition: McpDefinition) -> Value {
        let db = fresh_in_memory_db().await;
        let report = mcp_probe_core(
            &db,
            McpProbeRequest {
                definition: Some(definition),
                agent: None,
                key: None,
                timeout_ms: None,
            },
        )
        .await;
        serde_json::to_value(report).unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.bridge.shutdown.cancel();
        self.mock_task.abort();
    }
}

#[tokio::test]
async fn discovery_dynamic_registration_pkce_and_loopback_callback() {
    let mut fixture = Fixture::new().await;
    assert!(
        !fixture
            .bridge
            .mcp_oauth_list_core()
            .await
            .unwrap()
            .bridge_running
    );
    let start = fixture.start(McpOAuthTransport::Http, false).await;
    assert_eq!(start.registration_mode, McpOAuthRegistrationMode::Dynamic);
    fixture.event(McpOAuthGrantStatus::Authorizing).await;
    assert_eq!(fixture.mock.discovered.load(Ordering::SeqCst), 1);
    assert_eq!(
        fixture.mock.registered.lock().unwrap()[0]["redirect_uris"],
        json!([start.callback_url])
    );
    let callback = fixture.redirect(&start).await;
    let response = fixture.client.get(&callback).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let html = response.text().await.unwrap();
    assert!(!html.contains("no-reflection"));
    assert!(!html.contains("<script>"));
    fixture.event(McpOAuthGrantStatus::Authorized).await;
    assert!(fixture.complete(&start, callback).await.is_err());
    let snapshot = fixture.bridge.mcp_oauth_list_core().await.unwrap();
    assert_eq!(
        snapshot.routes[0].issuer.as_deref(),
        Some(fixture.mock.url("/tenant").as_str())
    );
    assert_eq!(snapshot.routes[0].scopes, ["tools:read"]);
    assert_eq!(snapshot.routes[0].route_id, start.route_id);
    assert!(snapshot.bridge_running);
    assert_eq!(fixture.mock.auth_exchanges.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn manual_callback_rejects_wrong_state_and_atomically_consumes_once() {
    let fixture = Fixture::new().await;
    let start = fixture.start(McpOAuthTransport::Http, true).await;
    assert_eq!(start.registration_mode, McpOAuthRegistrationMode::Manual);
    assert!(fixture.mock.registered.lock().unwrap().is_empty());
    let callback = fixture.redirect(&start).await;
    let wrong = format!("{}?state=incorrect&code=credential", start.callback_url);
    assert!(fixture.complete(&start, wrong).await.is_err());
    assert!(fixture
        .complete(&start, callback.replace("127.0.0.1", "localhost"))
        .await
        .is_err());
    let (manual, loopback) = tokio::join!(
        fixture.complete(&start, callback.clone()),
        fixture.client.get(&callback).send()
    );
    let loopback_won = loopback.is_ok_and(|result| result.status() == StatusCode::OK);
    assert_ne!(manual.is_ok(), loopback_won);
    assert!(fixture.complete(&start, callback).await.is_err());
    assert_eq!(fixture.mock.auth_exchanges.load(Ordering::SeqCst), 1);
    let next = fixture.start(McpOAuthTransport::Http, true).await;
    assert_eq!(next.route_id, start.route_id);
    let callback = fixture.redirect(&next).await;
    let cancel = || {
        fixture.bridge.mcp_oauth_cancel_core(McpOAuthCancelRequest {
            flow_id: next.flow_id.clone(),
        })
    };
    assert!(cancel().await.unwrap().cancelled);
    assert!(!cancel().await.unwrap().cancelled);
    assert!(fixture.complete(&next, callback).await.is_err());
    assert_eq!(
        fixture.bridge.mcp_oauth_list_core().await.unwrap().routes[0].status,
        McpOAuthGrantStatus::Authorized
    );
}

#[tokio::test]
async fn bridge_validates_local_auth_and_probes_streamable_mcp_with_redaction() {
    let fixture = Fixture::new().await;
    let route = fixture.authorize(McpOAuthTransport::Http).await;
    let definition = fixture.definition(&route).await;
    let (url, headers) = definition.remote().unwrap();
    let authorization = &headers["Authorization"];
    assert_eq!(
        fixture.client.get(url).send().await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        fixture
            .client
            .get(url)
            .bearer_auth("incorrect")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        fixture
            .client
            .get(url)
            .header(header::AUTHORIZATION, authorization)
            .header(header::ORIGIN, "https://untrusted.example")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(fixture.mock.forwarded.load(Ordering::SeqCst), 0);
    *fixture.mock.echoed_text.lock().unwrap() = Some(format!(
        "echo: {authorization} / {}",
        authorization.trim_start_matches("Bearer ")
    ));
    let probe = fixture.probe(definition.clone()).await;
    assert_eq!(probe["status"], "ok", "{probe}");
    assert_eq!(probe["tools"][0]["name"], "example");
    assert!(!probe
        .to_string()
        .contains(authorization.trim_start_matches("Bearer ")));
    let events = fixture
        .client
        .get(url)
        .header(header::AUTHORIZATION, authorization)
        .header("last-event-id", "continue-1")
        .send()
        .await
        .unwrap();
    assert_eq!(events.headers()[header::CONTENT_TYPE], "text/event-stream");
    assert!(events.text().await.unwrap().contains("continue-2"));
    let redirect = fixture
        .client
        .post(url)
        .header(header::AUTHORIZATION, authorization)
        .json(&json!({"method": "redirect"}))
        .send()
        .await
        .unwrap();
    assert_eq!(redirect.status(), StatusCode::BAD_GATEWAY);
    assert!(!redirect.headers().contains_key(header::LOCATION));
}

#[tokio::test]
async fn legacy_sse_rewrites_endpoint_and_probes_it_without_exposing_upstream_ticket() {
    let fixture = Fixture::new().await;
    let route = fixture.authorize(McpOAuthTransport::Sse).await;
    let definition = fixture.definition(&route).await;
    assert!(matches!(definition, McpDefinition::Sse { .. }));
    let response = fixture.get(&definition).await;
    let mut events = response.bytes_stream();
    let endpoint = events.next().await.unwrap().unwrap();
    let endpoint = String::from_utf8_lossy(&endpoint);
    assert!(endpoint.contains(&format!("/mcp/{}/sse-msg/", route.route_id)));
    assert!(!endpoint.contains(LEGACY_TICKET));
    drop(events);
    let probe = fixture.probe(definition).await;
    assert_eq!(probe["status"], "ok", "{probe}");
    assert_eq!(probe["tools"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn refreshes_expired_and_rejected_tokens_single_flight() {
    for initial_expiry in [0, 3600] {
        let fixture = Fixture::new().await;
        fixture
            .mock
            .initial_ttl
            .store(initial_expiry, Ordering::SeqCst);
        fixture.mock.reject_initial.store(true, Ordering::SeqCst);
        let route = fixture.authorize(McpOAuthTransport::Http).await;
        let definition = fixture.definition(&route).await;
        let responses =
            futures_util::future::join_all((0..8).map(|_| fixture.get(&definition))).await;
        assert!(responses
            .iter()
            .all(|response| response.status() == StatusCode::OK));
        assert_eq!(fixture.mock.refreshes.load(Ordering::SeqCst), 1);
        assert_eq!(fixture.mock.auth_exchanges.load(Ordering::SeqCst), 1);
        assert_eq!(fixture.definition(&route).await, definition);
        let credentials = fixture
            .store
            .get(&secret_key(&route.route_id))
            .unwrap()
            .unwrap();
        assert!(credentials.contains(SECOND_ACCESS));
        assert!(credentials.contains(REFRESH_TOKEN));
    }
}

#[tokio::test]
async fn refresh_failure_or_repeated_unauthorized_expires_route_and_emits_safe_event() {
    for fail_refresh in [true, false] {
        let mut fixture = Fixture::new().await;
        fixture.mock.reject_initial.store(true, Ordering::SeqCst);
        fixture
            .mock
            .reject_refresh
            .store(fail_refresh, Ordering::SeqCst);
        fixture
            .mock
            .reject_replacement
            .store(!fail_refresh, Ordering::SeqCst);
        let route = fixture.authorize(McpOAuthTransport::Http).await;
        let definition = fixture.definition(&route).await;
        assert_eq!(
            fixture.get(&definition).await.status(),
            StatusCode::UNAUTHORIZED
        );
        fixture.event(McpOAuthGrantStatus::Expired).await;
        let snapshot = fixture.bridge.mcp_oauth_list_core().await.unwrap();
        assert_eq!(snapshot.routes[0].status, McpOAuthGrantStatus::Expired);
        let error = snapshot.routes[0].last_error.as_deref().unwrap();
        assert!(!error.contains(REFRESH_TOKEN));
        assert!(!error.contains("error_description"));
        let forwarded = fixture.mock.forwarded.load(Ordering::SeqCst);
        assert_eq!(
            fixture.get(&definition).await.status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(fixture.mock.forwarded.load(Ordering::SeqCst), forwarded);
        assert_eq!(fixture.mock.refreshes.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test]
async fn persistence_omits_secrets_and_reuses_port_and_bridge_token_until_revoked() {
    let fixture = Fixture::new().await;
    let start = fixture.start(McpOAuthTransport::Http, true).await;
    let route = fixture
        .complete(&start, fixture.redirect(&start).await)
        .await
        .unwrap();
    let definition = fixture.definition(&route).await;
    let (_, headers) = definition.remote().unwrap();
    let bridge_token = headers["Authorization"].trim_start_matches("Bearer ");
    let raw = std::fs::read_to_string(fixture.dir.path().join(store::ROUTES_FILE)).unwrap();
    for field in [
        "access_token",
        "refresh_token",
        "client_secret",
        "bridge_token",
        "last_error",
        "bridge_url",
    ] {
        assert!(!raw.contains(&format!("\"{field}\"")));
    }
    for secret in [FIRST_ACCESS, REFRESH_TOKEN, CLIENT_SECRET, bridge_token] {
        assert!(!raw.contains(secret));
    }
    let stored: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(stored["routes"][0]["status"], "authorized");
    assert_eq!(stored["routes"][0]["has_refresh_token"], true);
    fixture.bridge.shutdown().await;
    let restarted = McpOAuthBridge::with_store(
        fixture.dir.path(),
        EventEmitter::Noop,
        fixture.store.clone(),
    );
    restarted.start_if_persisted().await;
    let restarted_definition = restarted
        .mcp_oauth_bridge_definition_core(McpOAuthBridgeDefinitionRequest {
            route_id: route.route_id.clone(),
        })
        .await
        .unwrap();
    assert_eq!(restarted_definition, definition);
    assert_eq!(fixture.get(&definition).await.status(), StatusCode::OK);
    let snapshot = restarted
        .mcp_oauth_revoke_core(McpOAuthRevokeRequest {
            route_id: route.route_id.clone(),
        })
        .await
        .unwrap();
    assert_eq!(snapshot.routes[0].status, McpOAuthGrantStatus::Revoked);
    assert!(fixture
        .store
        .get(&secret_key(&route.route_id))
        .unwrap()
        .is_none());
    assert_eq!(
        fixture.get(&definition).await.status(),
        StatusCode::UNAUTHORIZED
    );
    restarted.shutdown().await;
}

#[test]
fn url_policy_blocks_credentials_private_networks_and_remote_to_loopback_discovery() {
    for url in [
        "file:///not-an-oauth-url",
        "http://example.com/mcp",
        "http://127.0.0.2/mcp",
        "https://169.254.169.254/",
        "https://10.0.0.2/",
        "https://[::ffff:127.0.0.2]/",
        "https://user:hidden@example.com/",
        "https://example.com/#secret",
        "https://example.com/?secret=1",
    ] {
        assert!(
            protocol::upstream_url(url).is_err(),
            "unexpected permitted URL {url}"
        );
    }
    for url in [
        "http://127.0.0.1:8181/mcp",
        "http://localhost/mcp",
        "http://[::1]/mcp",
        "https://example.com/mcp",
    ] {
        assert!(protocol::upstream_url(url).is_ok());
    }
    let remote = protocol::upstream_url("https://example.com/mcp").unwrap();
    assert!(protocol::discovered_url("http://localhost:8181/metadata", &remote).is_err());
    assert_eq!(
        route_id(&remote),
        route_id(&protocol::upstream_url("https://EXAMPLE.com:443/mcp").unwrap())
    );
}

#[tokio::test]
async fn six_api_routes_share_state_and_use_the_snake_case_wire_contract() {
    let fixture = Fixture::new().await;
    let db = fresh_in_memory_db().await;
    let mut state = crate::app_state::AppState::new_for_test(db, fixture.dir.path().to_path_buf());
    state.mcp_oauth_bridge = fixture.bridge.clone();
    let api = axum_test::TestServer::new(crate::web::router::build_router(
        Arc::new(state),
        "test-instance-token".into(),
        fixture.dir.path().to_path_buf(),
        Arc::new(crate::web::shutdown::ShutdownSignal::new()),
    ))
    .unwrap();
    let post = |command: &str| {
        api.post(&format!("/api/mcp_oauth_{command}"))
            .add_header("authorization", "Bearer test-instance-token")
    };
    let list = post("list").json(&json!({})).await;
    assert_eq!(list.status_code(), StatusCode::OK);
    assert_eq!(
        list.json::<Value>(),
        json!({"bridge_running": false, "bridge_base_url": null, "routes": []})
    );
    let start = post("start")
        .json(&json!({"upstream_url": fixture.mock.url("/mcp")}))
        .await;
    assert_eq!(start.status_code(), StatusCode::OK);
    let start = start.json::<McpOAuthStartResult>();
    assert_eq!(start.registration_mode, McpOAuthRegistrationMode::Dynamic);
    let callback = fixture.redirect(&start).await;
    let using_callback = post("complete_callback")
        .json(&json!({"flow_id": start.flow_id, "callback_url": callback}))
        .await;
    assert_eq!(using_callback.status_code(), StatusCode::OK);
    let route = using_callback.json::<Value>();
    assert_eq!(route["route_id"], start.route_id);
    assert_eq!(route["status"], "authorized");
    assert_eq!(route["transport"], "http");
    assert!(route.get("last_error").is_none());
    assert!(route["has_refresh_token"].as_bool().unwrap());
    let definition = post("bridge_definition")
        .json(&json!({"route_id": start.route_id}))
        .await;
    assert_eq!(definition.status_code(), StatusCode::OK);
    assert_eq!(definition.json::<Value>()["type"], "http");
    let cancel = post("cancel")
        .json(&json!({"flow_id": start.flow_id}))
        .await;
    assert_eq!(cancel.json::<Value>(), json!({"cancelled": false}));
    let revoked = post("revoke")
        .json(&json!({"route_id": start.route_id}))
        .await;
    assert_eq!(revoked.status_code(), StatusCode::OK);
    assert_eq!(revoked.json::<Value>()["routes"][0]["status"], "revoked");
    assert_eq!(
        api.post("/api/mcp_oauth_list")
            .json(&json!({}))
            .await
            .status_code(),
        StatusCode::UNAUTHORIZED
    );
}
