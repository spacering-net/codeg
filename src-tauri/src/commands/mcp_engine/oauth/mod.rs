//! Host-owned MCP OAuth grants and the authenticated loopback proxy.

mod protocol;
mod proxy;
mod store;
#[cfg(feature = "tauri-runtime")]
pub mod tauri_commands;
mod wire;

#[cfg(test)]
mod tests;

use std::collections::BTreeMap;
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{RawQuery, State};
use axum::response::{Html, IntoResponse, Response};
use axum::{routing::get, Router};
use chrono::{DateTime, Utc};
use reqwest::{Client, Method, StatusCode};
use tokio::{net::TcpListener, sync::Mutex, task::JoinHandle, time::Instant};
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::app_error::AppCommandError;
use crate::srn::pkce::FlowSecret;
use crate::web::event_bridge::{emit_event, EventEmitter};

use super::model::McpDefinition;
use protocol::{Discovery, Registration, TokenResponse};
use store::{secret_key, Credentials, RouteMetadata, RoutesFile};

pub use store::SecretStore;
pub use wire::*;

type Result<T> = std::result::Result<T, AppCommandError>;
const FLOW_TTL: Duration = Duration::from_secs(300);
const CALLBACK_PATH: &str = "/oauth/callback";
const CREDENTIALS_ERROR: &str = "Could not access MCP OAuth credentials in the secure store";
const METADATA_ERROR: &str = "Could not access MCP OAuth route metadata";

pub struct McpOAuthBridge {
    path: PathBuf,
    store: Arc<dyn SecretStore>,
    client: Result<Client>,
    emitter: EventEmitter,
    state: Mutex<BridgeState>,
    // Serializes token replacement and revocation for one upstream while
    // allowing unrelated routes to refresh independently.
    route_locks: std::sync::Mutex<BTreeMap<String, std::sync::Weak<Mutex<()>>>>,
    legacy_endpoints: proxy::LegacyEndpoints,
    shutdown: CancellationToken,
}

#[derive(Default)]
struct BridgeState {
    storage_error: bool,
    preferred_port: Option<u16>,
    listener: Option<BridgeListener>,
    routes: BTreeMap<String, Route>,
    flows: BTreeMap<String, FlowSlot>,
}

struct BridgeListener {
    base: String,
    task: JoinHandle<()>,
}

struct Route {
    metadata: RouteMetadata,
    credentials: Option<Arc<Credentials>>,
    last_error: Option<String>,
    active: CancellationToken,
}

struct FlowSlot {
    metadata: RouteMetadata,
    // Taken only after validating the callback. Keep the slot reserved while
    // the network exchange runs so cancel/revoke can still invalidate it.
    flow: Option<PendingFlow>,
    listener_stop: CancellationToken,
    cancel: CancellationToken,
    deadline: Instant,
}

struct PendingFlow {
    callback: Url,
    state: FlowSecret,
    verifier: FlowSecret,
    discovery: Discovery,
    registration: Registration,
}

impl FlowSlot {
    fn stop(self) {
        self.listener_stop.cancel();
        self.cancel.cancel();
    }
}

impl Route {
    fn new(metadata: RouteMetadata, shutdown: &CancellationToken) -> Self {
        Self {
            metadata,
            credentials: None,
            last_error: None,
            active: shutdown.child_token(),
        }
    }

    fn credentials(&mut self, store: &dyn SecretStore) -> Result<Arc<Credentials>> {
        if let Some(credentials) = &self.credentials {
            return Ok(credentials.clone());
        }
        let invalid = || AppCommandError::io_error(CREDENTIALS_ERROR);
        let raw = store
            .get(&secret_key(&self.metadata.route_id))
            .map_err(|_| invalid())?
            .ok_or_else(|| {
                AppCommandError::authentication_failed(
                    "MCP OAuth credentials are missing. Authorize this route again.",
                )
            })?;
        let credentials: Credentials = serde_json::from_str(&raw).map_err(|_| invalid())?;
        if credentials.resource != self.metadata.upstream_url
            || !crate::srn::pkce::is_opaque(&credentials.bridge_token)
        {
            return Err(invalid());
        }
        let credentials = Arc::new(credentials);
        self.credentials = Some(credentials.clone());
        Ok(credentials)
    }
}

impl BridgeState {
    fn check_storage(&self) -> Result<()> {
        if self.storage_error {
            return Err(AppCommandError::io_error(METADATA_ERROR));
        }
        Ok(())
    }

    fn base(&self) -> Option<&str> {
        self.listener
            .as_ref()
            .filter(|listener| !listener.task.is_finished())
            .map(|listener| listener.base.as_str())
    }

    fn snapshot(&self) -> McpOAuthBridgeSnapshot {
        let base = self.base();
        let mut routes: BTreeMap<_, _> = self
            .routes
            .iter()
            .map(|(id, route)| (id, route.metadata.info(base, route.last_error.clone())))
            .collect();
        for slot in self.flows.values() {
            routes.insert(&slot.metadata.route_id, slot.metadata.info(base, None));
        }
        McpOAuthBridgeSnapshot {
            bridge_running: base.is_some(),
            bridge_base_url: base.map(str::to_owned),
            routes: routes.into_values().collect(),
        }
    }

    fn write(&self, path: &Path, port: Option<u16>, update: Option<&RouteMetadata>) -> Result<()> {
        self.check_storage()?;
        let routes = self
            .routes
            .values()
            .map(|route| &route.metadata)
            .filter(|route| {
                !update.is_some_and(|replacement| replacement.route_id == route.route_id)
            })
            .chain(update);
        RoutesFile::write(path, port, routes).map_err(|_| AppCommandError::io_error(METADATA_ERROR))
    }
}

pub(super) fn route_id(url: &Url) -> String {
    super::fsio::sha256_hex(url.as_str().as_bytes())[..16].to_owned()
}

fn random_secret() -> Result<FlowSecret> {
    FlowSecret::generate().map_err(|_| {
        AppCommandError::task_execution_failed("Could not generate an MCP OAuth secret")
    })
}

fn inactive_flow() -> AppCommandError {
    AppCommandError::not_found("The MCP OAuth flow is missing, expired, or already used")
}

impl Drop for McpOAuthBridge {
    fn drop(&mut self) {
        self.shutdown.cancel();
    }
}

impl McpOAuthBridge {
    pub fn new(data_dir: &Path, emitter: EventEmitter) -> Arc<Self> {
        Self::with_store(data_dir, emitter, Arc::new(store::KeyringStore))
    }

    #[cfg(any(test, feature = "test-utils"))]
    pub fn new_for_test(data_dir: &Path, emitter: EventEmitter) -> Arc<Self> {
        Self::with_store(
            data_dir,
            emitter,
            Arc::new(store::MemorySecretStore::default()),
        )
    }

    fn with_store(
        data_dir: &Path,
        emitter: EventEmitter,
        store: Arc<dyn SecretStore>,
    ) -> Arc<Self> {
        let path = data_dir.join(store::ROUTES_FILE);
        let shutdown = CancellationToken::new();
        let state = match RoutesFile::read(&path) {
            Ok(file) => BridgeState {
                preferred_port: file.preferred_port,
                routes: file
                    .routes
                    .into_iter()
                    .map(|metadata| (metadata.route_id.clone(), Route::new(metadata, &shutdown)))
                    .collect(),
                ..BridgeState::default()
            },
            Err(_) => BridgeState {
                storage_error: true,
                ..BridgeState::default()
            },
        };
        Arc::new(Self {
            path,
            store,
            client: protocol::client(),
            emitter,
            state: Mutex::new(state),
            route_locks: Default::default(),
            legacy_endpoints: Default::default(),
            shutdown,
        })
    }

    fn client(&self) -> Result<&Client> {
        self.client.as_ref().map_err(Clone::clone)
    }

    fn route_lock(&self, route_id: &str) -> Arc<Mutex<()>> {
        let mut locks = self.route_locks.lock().unwrap();
        if let Some(lock) = locks.get(route_id).and_then(std::sync::Weak::upgrade) {
            return lock;
        }
        locks.retain(|_, lock| lock.strong_count() > 0);
        let lock = Arc::new(Mutex::new(()));
        locks.insert(route_id.to_owned(), Arc::downgrade(&lock));
        lock
    }

    fn announce(&self, metadata: &RouteMetadata) {
        emit_event(
            &self.emitter,
            MCP_OAUTH_CHANGED_EVENT,
            McpOAuthChanged {
                route_id: metadata.route_id.clone(),
                upstream_url: metadata.upstream_url.clone(),
                status: metadata.status,
            },
        );
    }

    pub async fn start_if_persisted(self: &Arc<Self>) {
        let start = {
            let state = self.state.lock().await;
            if state.storage_error {
                tracing::warn!("Could not read MCP OAuth route metadata");
            }
            state
                .routes
                .values()
                .any(|route| route.metadata.status == McpOAuthGrantStatus::Authorized)
        };
        if start && self.ensure_listening().await.is_err() {
            tracing::warn!("Could not start the MCP OAuth loopback bridge");
        }
    }

    async fn ensure_listening(self: &Arc<Self>) -> Result<()> {
        let mut state = self.state.lock().await;
        state.check_storage()?;
        if self.shutdown.is_cancelled() {
            return Err(AppCommandError::task_execution_failed(
                "The MCP OAuth bridge is shutting down",
            ));
        }
        if state.base().is_some() {
            return Ok(());
        }
        let port = state.preferred_port.unwrap_or(0);
        let listener = match bind_loopback(port).await {
            Err(_) if port != 0 => bind_loopback(0).await?,
            result => result?,
        };
        let port = listener.local_addr().map_err(|_| bind_error())?.port();
        if state.preferred_port != Some(port) {
            state.write(&self.path, Some(port), None)?;
            state.preferred_port = Some(port);
        }
        let cancel = self.shutdown.clone();
        let router = proxy::router(Arc::downgrade(self));
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(cancel.cancelled_owned())
                .await;
        });
        state.listener = Some(BridgeListener {
            base: format!("http://127.0.0.1:{port}"),
            task,
        });
        Ok(())
    }

    pub async fn shutdown(&self) {
        self.shutdown.cancel();
        let listener = {
            let mut state = self.state.lock().await;
            for slot in std::mem::take(&mut state.flows).into_values() {
                slot.stop();
            }
            state.listener.take()
        };
        if let Some(BridgeListener { mut task, .. }) = listener {
            if tokio::time::timeout(Duration::from_secs(2), &mut task)
                .await
                .is_err()
            {
                task.abort();
                let _ = task.await;
            }
        }
    }

    pub async fn mcp_oauth_list_core(&self) -> Result<McpOAuthBridgeSnapshot> {
        let state = self.state.lock().await;
        state.check_storage()?;
        Ok(state.snapshot())
    }

    pub async fn mcp_oauth_start_core(
        self: &Arc<Self>,
        request: McpOAuthStartRequest,
    ) -> Result<McpOAuthStartResult> {
        let upstream = protocol::upstream_url(&request.upstream_url)?;
        let route_id = route_id(&upstream);
        let transport = request.transport.unwrap_or_default();
        {
            let state = self.state.lock().await;
            check_start(&state, &route_id, upstream.as_str(), &self.shutdown)?;
        }
        let client = self.client()?;
        let discovery = protocol::discover(client, &upstream, &request).await?;
        let listener = bind_loopback(0).await?;
        let port = listener.local_addr().map_err(|_| bind_error())?.port();
        let callback = Url::parse(&format!("http://127.0.0.1:{port}{CALLBACK_PATH}"))
            .expect("loopback callback URL");
        let registration = protocol::register(client, &discovery, request, &callback).await?;
        let csrf_state = random_secret()?;
        let verifier = random_secret()?;
        let flow_id = random_secret()?.expose().to_owned();
        let mut authorization = discovery.authorization_endpoint.clone();
        let original_query: Vec<_> = authorization
            .query_pairs()
            .into_owned()
            .filter(|(key, _)| {
                !matches!(
                    key.as_str(),
                    "response_type"
                        | "client_id"
                        | "redirect_uri"
                        | "state"
                        | "code_challenge"
                        | "code_challenge_method"
                        | "resource"
                        | "scope"
                )
            })
            .collect();
        authorization.set_query(None);
        let scope = discovery.scopes.join(" ");
        {
            let mut params = authorization.query_pairs_mut();
            params.extend_pairs(original_query);
            params.extend_pairs([
                ("response_type", "code"),
                ("client_id", &registration.client_id),
                ("redirect_uri", callback.as_str()),
                ("state", csrf_state.expose()),
                ("code_challenge", &verifier.challenge()),
                ("code_challenge_method", "S256"),
                ("resource", upstream.as_str()),
            ]);
            if !scope.is_empty() {
                params.append_pair("scope", &scope);
            }
        }
        let listener_stop = self.shutdown.child_token();
        let cancel = self.shutdown.child_token();
        let deadline = Instant::now() + FLOW_TTL;
        let now = Utc::now();
        let result = McpOAuthStartResult {
            flow_id: flow_id.clone(),
            route_id: route_id.clone(),
            upstream_url: upstream.to_string(),
            authorization_url: authorization.into(),
            callback_url: callback.to_string(),
            expires_at: now + FLOW_TTL,
            registration_mode: registration.mode,
        };
        let metadata = RouteMetadata {
            route_id,
            upstream_url: upstream.into(),
            transport,
            issuer: Some(discovery.issuer.to_string()),
            scopes: discovery.scopes.clone(),
            expires_at: None,
            has_refresh_token: false,
            status: McpOAuthGrantStatus::Authorizing,
            updated_at: now,
        };
        {
            let mut runtime = self.state.lock().await;
            check_start(
                &runtime,
                &metadata.route_id,
                &metadata.upstream_url,
                &self.shutdown,
            )?;
            if runtime.flows.len() >= 32 {
                return Err(AppCommandError::task_execution_failed(
                    "Too many concurrent MCP OAuth authorization flows",
                ));
            }
            runtime.flows.insert(
                flow_id.clone(),
                FlowSlot {
                    metadata: metadata.clone(),
                    flow: Some(PendingFlow {
                        callback,
                        state: csrf_state,
                        verifier,
                        discovery,
                        registration,
                    }),
                    listener_stop: listener_stop.clone(),
                    cancel: cancel.clone(),
                    deadline,
                },
            );
            self.announce(&metadata);
        }
        let weak = Arc::downgrade(self);
        let router = Router::new()
            .route(CALLBACK_PATH, get(callback_handler))
            .with_state((weak.clone(), flow_id.clone()));
        tokio::spawn(async move {
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(listener_stop.cancelled_owned())
                .await;
        });
        tokio::spawn(async move {
            tokio::select! {
                _ = cancel.cancelled() => {},
                _ = tokio::time::sleep_until(deadline) => {
                    if let Some(bridge) = weak.upgrade() {
                        bridge.finish_failed_flow(&flow_id, "The MCP OAuth authorization expired").await;
                    }
                },
            }
        });
        Ok(result)
    }

    pub async fn mcp_oauth_complete_callback_core(
        self: &Arc<Self>,
        request: McpOAuthCompleteCallbackRequest,
    ) -> Result<McpOAuthRouteInfo> {
        self.complete(&request.flow_id, CallbackInput::Url(&request.callback_url))
            .await
    }

    async fn complete(
        self: &Arc<Self>,
        flow_id: &str,
        callback: CallbackInput<'_>,
    ) -> Result<McpOAuthRouteInfo> {
        let (flow, metadata, cancel, code) = {
            let mut state = self.state.lock().await;
            let slot = state
                .flows
                .get_mut(flow_id)
                .filter(|slot| Instant::now() < slot.deadline && !slot.cancel.is_cancelled())
                .ok_or_else(inactive_flow)?;
            let pending = slot.flow.as_ref().ok_or_else(inactive_flow)?;
            let query = callback.parse(&pending.callback)?;
            let code = validate_callback(&pending.state, &query)?;
            let flow = slot.flow.take().ok_or_else(inactive_flow)?;
            // Close the accepting socket before starting the exchange. Axum's
            // graceful shutdown still lets this request return a safe page.
            slot.listener_stop.cancel();
            (flow, slot.metadata.clone(), slot.cancel.clone(), code)
        };
        let flow_id = flow_id.to_owned();
        let bridge = self.clone();
        // A disconnect from either entry point must not strand a consumed flow.
        tokio::spawn(async move {
            let result = tokio::select! {
                biased;
                _ = cancel.cancelled() => Err(inactive_flow()),
                result = bridge.complete_flow(&flow_id, flow, metadata, code) => result,
            };
            if result.is_err() {
                bridge
                    .finish_failed_flow(&flow_id, "MCP OAuth authorization could not be completed")
                    .await;
            }
            result
        })
        .await
        .map_err(|_| AppCommandError::task_execution_failed("MCP OAuth callback task failed"))?
    }

    async fn complete_flow(
        self: &Arc<Self>,
        flow_id: &str,
        flow: PendingFlow,
        mut metadata: RouteMetadata,
        code: Option<String>,
    ) -> Result<McpOAuthRouteInfo> {
        let code = code.ok_or_else(|| {
            AppCommandError::authentication_failed(
                "The OAuth provider did not authorize this MCP service",
            )
        })?;
        let tokens = protocol::exchange(
            self.client()?,
            flow.discovery.token_endpoint.clone(),
            &flow.registration.client_id,
            flow.registration.client_secret.as_deref(),
            flow.registration.auth,
            vec![
                ("grant_type", "authorization_code"),
                ("code", &code),
                ("redirect_uri", flow.callback.as_str()),
                ("code_verifier", flow.verifier.expose()),
                ("resource", &metadata.upstream_url),
            ],
        )
        .await?;
        self.ensure_listening().await?;
        let lock = self.route_lock(&metadata.route_id);
        let _guard = lock.lock().await;
        let mut state = self.state.lock().await;
        if !state
            .flows
            .get(flow_id)
            .is_some_and(|slot| Instant::now() < slot.deadline && !slot.cancel.is_cancelled())
        {
            return Err(inactive_flow());
        }
        let previous = if let Some(route) = state
            .routes
            .get_mut(&metadata.route_id)
            .filter(|route| route.metadata.status != McpOAuthGrantStatus::Revoked)
        {
            let old = route.credentials(self.store.as_ref());
            match old {
                Ok(credentials) => Some(credentials),
                Err(error)
                    if matches!(
                        error.code,
                        crate::app_error::AppErrorCode::AuthenticationFailed
                    ) =>
                {
                    None
                }
                Err(error) => return Err(error),
            }
        } else {
            None
        };
        let bridge_token = match previous {
            Some(credentials) => credentials.bridge_token.clone(),
            None => random_secret()?.expose().to_owned(),
        };
        update_token_metadata(&mut metadata, &tokens, tokens.refresh_token.is_some());
        let credentials = Credentials {
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            client_id: flow.registration.client_id,
            client_secret: flow.registration.client_secret,
            token_endpoint: flow.discovery.token_endpoint.into(),
            resource: metadata.upstream_url.clone(),
            bridge_token,
            client_auth: flow.registration.auth,
        };
        self.save_grant(&mut state, metadata.clone(), credentials)?;
        if let Some(slot) = state.flows.remove(flow_id) {
            slot.stop();
        }
        self.announce(&metadata);
        Ok(metadata.info(state.base(), None))
    }

    fn save_grant(
        &self,
        state: &mut BridgeState,
        metadata: RouteMetadata,
        credentials: Credentials,
    ) -> Result<Arc<Credentials>> {
        let key = secret_key(&metadata.route_id);
        let invalid = || AppCommandError::io_error(CREDENTIALS_ERROR);
        let old = self.store.get(&key).map_err(|_| invalid())?;
        let encoded = serde_json::to_string(&credentials).map_err(|_| invalid())?;
        self.store.set(&key, &encoded).map_err(|_| invalid())?;
        if let Err(error) = state.write(&self.path, state.preferred_port, Some(&metadata)) {
            let rollback = match old {
                Some(old) => self.store.set(&key, &old),
                None => self.store.delete(&key),
            };
            if rollback.is_err() {
                tracing::error!(
                    "Could not restore MCP OAuth credentials after a metadata write failure"
                );
            }
            return Err(error);
        }
        let credentials = Arc::new(credentials);
        let route = state
            .routes
            .entry(metadata.route_id.clone())
            .or_insert_with(|| Route::new(metadata.clone(), &self.shutdown));
        if route.active.is_cancelled() {
            route.active = self.shutdown.child_token();
        }
        route.metadata = metadata;
        route.last_error = None;
        route.credentials = Some(credentials.clone());
        Ok(credentials)
    }

    async fn finish_failed_flow(&self, flow_id: &str, error: &'static str) {
        self.remove_flow(flow_id, Some(error)).await;
    }

    async fn remove_flow(&self, flow_id: &str, error: Option<&'static str>) -> bool {
        let mut state = self.state.lock().await;
        let Some(slot) = state.flows.remove(flow_id) else {
            return false;
        };
        let mut fallback = slot.metadata.clone();
        slot.stop();
        if let Some(route) = state.routes.get_mut(&fallback.route_id) {
            route.last_error = error.map(str::to_owned);
            self.announce(&route.metadata);
        } else {
            fallback.status = if error.is_some() {
                McpOAuthGrantStatus::Expired
            } else {
                McpOAuthGrantStatus::Revoked
            };
            fallback.updated_at = Utc::now();
            self.announce(&fallback);
        }
        true
    }

    pub async fn mcp_oauth_cancel_core(
        &self,
        request: McpOAuthCancelRequest,
    ) -> Result<McpOAuthCancelResult> {
        Ok(McpOAuthCancelResult {
            cancelled: self.remove_flow(&request.flow_id, None).await,
        })
    }

    pub async fn mcp_oauth_revoke_core(
        &self,
        request: McpOAuthRevokeRequest,
    ) -> Result<McpOAuthBridgeSnapshot> {
        let route_id = request.route_id;
        // Revocation takes effect while a refresh is in flight. The refresh
        // observes the cancelled route before it can store replacement keys.
        let mut state = self.state.lock().await;
        state.check_storage()?;
        let pending_id = state
            .flows
            .iter()
            .find(|(_, slot)| slot.metadata.route_id == route_id)
            .map(|(id, _)| id.clone());
        let mut metadata = state
            .routes
            .get(&route_id)
            .map(|route| route.metadata.clone())
            .or_else(|| {
                pending_id
                    .as_ref()
                    .and_then(|id| state.flows.get(id))
                    .map(|slot| slot.metadata.clone())
            })
            .ok_or_else(|| AppCommandError::not_found("MCP OAuth route not found"))?;
        metadata.status = McpOAuthGrantStatus::Revoked;
        metadata.expires_at = None;
        metadata.has_refresh_token = false;
        metadata.updated_at = Utc::now();
        // Persist the denial before deleting credentials so a restart cannot
        // re-enable the route if deleting the key fails or is interrupted.
        state.write(&self.path, state.preferred_port, Some(&metadata))?;
        if let Some(slot) = pending_id.and_then(|id| state.flows.remove(&id)) {
            slot.stop();
        }
        let route = state
            .routes
            .entry(route_id.clone())
            .or_insert_with(|| Route::new(metadata.clone(), &self.shutdown));
        route.active.cancel();
        route.metadata = metadata;
        route.credentials = None;
        let deleted = self
            .store
            .delete(&secret_key(&route_id))
            .map_err(|_| AppCommandError::io_error(CREDENTIALS_ERROR));
        route.last_error = deleted.as_ref().err().map(|error| error.message.clone());
        self.announce(&route.metadata);
        deleted?;
        Ok(state.snapshot())
    }

    pub async fn mcp_oauth_bridge_definition_core(
        &self,
        request: McpOAuthBridgeDefinitionRequest,
    ) -> Result<McpDefinition> {
        let mut state = self.state.lock().await;
        state.check_storage()?;
        if state
            .flows
            .values()
            .any(|slot| slot.metadata.route_id == request.route_id)
        {
            return Err(AppCommandError::authentication_failed(
                "MCP OAuth authorization is in progress",
            ));
        }
        let url = state
            .base()
            .map(|base| format!("{base}/mcp/{}", request.route_id));
        let route = state
            .routes
            .get_mut(&request.route_id)
            .ok_or_else(|| AppCommandError::not_found("MCP OAuth route not found"))?;
        if route.metadata.status != McpOAuthGrantStatus::Authorized {
            return Err(AppCommandError::authentication_failed(
                "MCP OAuth route is not authorized",
            ));
        }
        let url = url.ok_or_else(|| {
            AppCommandError::task_execution_failed("The MCP OAuth bridge is not running")
        })?;
        let credentials = route.credentials(self.store.as_ref())?;
        let headers = BTreeMap::from([(
            "Authorization".to_owned(),
            format!("Bearer {}", credentials.bridge_token),
        )]);
        Ok(match route.metadata.transport {
            McpOAuthTransport::Http => McpDefinition::Http { url, headers },
            McpOAuthTransport::Sse => McpDefinition::Sse { url, headers },
        })
    }
}

fn update_token_metadata(
    metadata: &mut RouteMetadata,
    tokens: &TokenResponse,
    has_refresh_token: bool,
) {
    metadata.expires_at = tokens.expires_at();
    metadata.scopes = tokens.scopes(&metadata.scopes);
    metadata.has_refresh_token = has_refresh_token;
    metadata.status = McpOAuthGrantStatus::Authorized;
    metadata.updated_at = Utc::now();
}

fn check_start(
    state: &BridgeState,
    route_id: &str,
    upstream: &str,
    shutdown: &CancellationToken,
) -> Result<()> {
    state.check_storage()?;
    if shutdown.is_cancelled() {
        return Err(AppCommandError::task_execution_failed(
            "The MCP OAuth bridge is shutting down",
        ));
    }
    if state
        .routes
        .get(route_id)
        .is_some_and(|route| route.metadata.upstream_url != upstream)
    {
        return Err(AppCommandError::already_exists(
            "An MCP OAuth route with this ID belongs to another server",
        ));
    }
    if state
        .flows
        .values()
        .any(|slot| slot.metadata.route_id == route_id)
    {
        return Err(AppCommandError::already_exists(
            "MCP OAuth authorization is already in progress for this route",
        ));
    }
    Ok(())
}

fn bind_error() -> AppCommandError {
    AppCommandError::io_error("Could not bind an MCP OAuth loopback listener")
}

async fn bind_loopback(port: u16) -> Result<TcpListener> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port))
        .await
        .map_err(|_| bind_error())?;
    crate::web::socket_inherit::mark_listener_non_inheritable(&listener)
        .map_err(|_| bind_error())?;
    Ok(listener)
}

enum CallbackInput<'a> {
    Url(&'a str),
    Query(&'a str),
}

impl CallbackInput<'_> {
    fn parse(self, expected: &Url) -> Result<String> {
        let invalid =
            || AppCommandError::invalid_input("The callback must match the MCP OAuth redirect URL");
        match self {
            Self::Url(raw) if raw.len() <= 16 * 1024 => {
                let mut url = Url::parse(raw).map_err(|_| invalid())?;
                let query = url.query().ok_or_else(invalid)?.to_owned();
                url.set_query(None);
                if url != *expected {
                    return Err(invalid());
                }
                Ok(query)
            }
            Self::Query(query) if query.len() <= 16 * 1024 => Ok(query.to_owned()),
            _ => Err(invalid()),
        }
    }
}

fn validate_callback(expected_state: &FlowSecret, query: &str) -> Result<Option<String>> {
    let (mut state, mut code, mut denied) = (None, None, false);
    let invalid =
        || AppCommandError::authentication_failed("Invalid MCP OAuth callback state or parameters");
    for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
        match key.as_ref() {
            "state" if state.is_none() => state = Some(value),
            "code" if code.is_none() => code = Some(value.into_owned()),
            "error" if !denied => denied = true,
            "state" | "code" | "error" => return Err(invalid()),
            _ => {}
        }
    }
    if !state.is_some_and(|state| expected_state.matches(&state)) || denied && code.is_some() {
        return Err(invalid());
    }
    if denied {
        return Ok(None);
    }
    code.filter(|code| !code.is_empty() && !code.chars().any(char::is_control))
        .map(Some)
        .ok_or_else(invalid)
}

async fn callback_handler(
    State((bridge, flow_id)): State<(std::sync::Weak<McpOAuthBridge>, String)>,
    RawQuery(query): RawQuery,
    method: Method,
) -> Response {
    if method != Method::GET {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let accepted = if let (Some(bridge), Some(query)) = (bridge.upgrade(), query) {
        bridge
            .complete(&flow_id, CallbackInput::Query(&query))
            .await
            .is_ok()
    } else {
        false
    };
    let (status, page) = if accepted {
        (StatusCode::OK, "<!doctype html><title>Codeg</title><p>Authorization completed. You can close this window.</p>")
    } else {
        (StatusCode::BAD_REQUEST, "<!doctype html><title>Codeg</title><p>Authorization could not be completed. Return to Codeg to try again.</p>")
    };
    (
        status,
        [
            ("cache-control", "no-store"),
            (
                "content-security-policy",
                "default-src 'none'; frame-ancestors 'none'",
            ),
            ("referrer-policy", "no-referrer"),
            ("x-content-type-options", "nosniff"),
        ],
        Html(page),
    )
        .into_response()
}

fn expires_soon(expires_at: Option<DateTime<Utc>>) -> bool {
    expires_at.is_some_and(|expires_at| expires_at <= Utc::now() + chrono::Duration::seconds(60))
}
