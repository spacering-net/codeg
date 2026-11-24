//! `/api/cli_*`: the routes `codeg-cli` talks to.
//!
//! Mounted twice, on the same handlers: under the main `/api` router (main
//! token; how CI reaches a remote `codeg-server`), and on the loopback-only
//! listener a runtime opens for the CLIs of its own machine (per-launch CLI
//! token; see `listener.rs`).

use std::sync::Arc;

use axum::extract::{DefaultBodyLimit, Extension};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};

use super::service::{CliError, CliRunService, MAX_PROMPT_BYTES};
use super::wire::{
    self, AgentEntry, AssistantEntry, CancelRequest, EventsRequest, EventsResponse, FindRequest,
    FindResponse, GetRequest, GetResponse, HelloRequest, HelloResponse, ReserveResponse,
    StartRequest, StartResponse,
};

/// Room for the JSON around a prompt at its size limit.
const START_BODY_LIMIT: usize = MAX_PROMPT_BYTES + 256 * 1024;

/// What `cli_hello` signs with: the token clients of these routes hold, and,
/// on the loopback listener, its own port.
#[derive(Clone)]
pub struct HelloKey {
    pub token: String,
    pub port: Option<u16>,
}

impl IntoResponse for CliError {
    fn into_response(self) -> Response {
        let status = StatusCode::from_u16(self.status).unwrap_or(StatusCode::BAD_REQUEST);
        (status, Json(self.body)).into_response()
    }
}

/// The routes that need a token, wired to `service`.
pub fn routes(service: Arc<CliRunService>) -> Router {
    Router::new()
        .route("/cli_run_reserve", post(reserve))
        .route(
            "/cli_run_start",
            post(start).layer(DefaultBodyLimit::max(START_BODY_LIMIT)),
        )
        .route("/cli_run_events", post(events))
        .route("/cli_run_cancel", post(cancel))
        .route("/cli_run_get", post(get))
        .route("/cli_run_find", post(find))
        .route("/cli_automations", post(automations))
        .route("/cli_automation_run", post(automation_run))
        .route("/cli_automation_run_get", post(automation_run_get))
        .route("/cli_agent_install", post(agent_install))
        .route("/cli_agent_install_get", post(agent_install_get))
        .route("/cli_agents", post(agents))
        .route("/cli_assistants", post(assistants))
        .layer(Extension(service))
}

/// `cli_hello`, which must answer WITHOUT a token.
pub fn public_routes(service: Arc<CliRunService>, key: HelloKey) -> Router {
    Router::new()
        .route("/cli_hello", post(hello))
        .layer(Extension(key))
        .layer(Extension(service))
}

async fn hello(
    Extension(service): Extension<Arc<CliRunService>>,
    Extension(key): Extension<HelloKey>,
    Json(req): Json<HelloRequest>,
) -> Result<Json<HelloResponse>, CliError> {
    if req.api_version != wire::API_VERSION {
        return Err(CliError::incompatible(
            "api_version",
            format!(
                "this codeg speaks CLI API {}, the CLI speaks {}; use a codeg-cli from the same \
                 release as this codeg ({})",
                wire::API_VERSION,
                req.api_version,
                env!("CARGO_PKG_VERSION")
            ),
        ));
    }
    if req.nonce.len() < 32 || req.nonce.len() > 256 {
        return Err(CliError::usage(
            "bad_nonce",
            "the nonce must be 32–256 characters",
        ));
    }
    Ok(Json(HelloResponse {
        proof: super::hello::proof(&key.token, &req.nonce, key.port),
        runtime: service.runtime(),
        build: wire::BuildKind::current(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        api_version: wire::API_VERSION,
        capabilities: service.capabilities(),
    }))
}

async fn reserve(
    Extension(service): Extension<Arc<CliRunService>>,
) -> Result<Json<ReserveResponse>, CliError> {
    service.reserve().map(Json)
}

async fn start(
    Extension(service): Extension<Arc<CliRunService>>,
    Json(req): Json<StartRequest>,
) -> Result<Json<StartResponse>, CliError> {
    service.start(req).await.map(Json)
}

async fn events(
    Extension(service): Extension<Arc<CliRunService>>,
    Json(req): Json<EventsRequest>,
) -> Result<Json<EventsResponse>, CliError> {
    service.events(&req).await.map(Json)
}

async fn cancel(
    Extension(service): Extension<Arc<CliRunService>>,
    Json(req): Json<CancelRequest>,
) -> Result<Json<serde_json::Value>, CliError> {
    service.cancel(&req.run_id, req.reason).await?;
    Ok(Json(serde_json::json!({})))
}

async fn get(
    Extension(service): Extension<Arc<CliRunService>>,
    Json(req): Json<GetRequest>,
) -> Result<Json<GetResponse>, CliError> {
    service.get(&req).await.map(Json)
}

async fn find(
    Extension(service): Extension<Arc<CliRunService>>,
    Json(req): Json<FindRequest>,
) -> Result<Json<FindResponse>, CliError> {
    service.find(&req).await.map(Json)
}

async fn automations(
    Extension(service): Extension<Arc<CliRunService>>,
) -> Result<Json<Vec<wire::AutomationEntry>>, CliError> {
    service.automations().await.map(Json)
}

async fn automation_run(
    Extension(service): Extension<Arc<CliRunService>>,
    Json(req): Json<wire::AutomationRunRequest>,
) -> Result<Json<wire::AutomationRunState>, CliError> {
    service.automation_run(&req).await.map(Json)
}

async fn automation_run_get(
    Extension(service): Extension<Arc<CliRunService>>,
    Json(req): Json<wire::AutomationRunGetRequest>,
) -> Result<Json<wire::AutomationRunState>, CliError> {
    service.automation_run_get(&req).await.map(Json)
}

async fn agent_install(
    Extension(service): Extension<Arc<CliRunService>>,
    Json(req): Json<wire::AgentInstallRequest>,
) -> Result<Json<wire::AgentInstallState>, CliError> {
    service.agent_install(&req).map(Json)
}

async fn agent_install_get(
    Extension(service): Extension<Arc<CliRunService>>,
    Json(req): Json<wire::AgentInstallGetRequest>,
) -> Result<Json<wire::AgentInstallState>, CliError> {
    service.agent_install_get(&req).await.map(Json)
}

async fn agents(
    Extension(service): Extension<Arc<CliRunService>>,
) -> Result<Json<Vec<AgentEntry>>, CliError> {
    service.agents().await.map(Json)
}

async fn assistants(
    Extension(service): Extension<Arc<CliRunService>>,
) -> Result<Json<Vec<AssistantEntry>>, CliError> {
    service.assistants().await.map(Json)
}
