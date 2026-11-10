//! The loopback-only listener a runtime opens for the `codeg-cli`s of its own
//! machine, and the discovery file that points them at it.
//!
//! - Binds `127.0.0.1:0` and serves `/api/health` and `/api/cli_*` only — no
//!   web UI, no other API, no CORS.
//! - Authenticates with a token minted per launch, never stored in the
//!   database, published only in the private discovery file.
//! - Accepts only `Host: 127.0.0.1:<port>` / `localhost:<port>`, so a web page
//!   cannot reach it by DNS rebinding.
//!
//! The desktop's "Web service" is a different thing on purpose: it is off by
//! default, binds `0.0.0.0`, and serves the whole workbench with the full
//! token. A local script needs none of that.

use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use axum::extract::Request;
use axum::http::{header, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use tokio::sync::Mutex;

use super::discovery::{self, DiscoveryRecord};
use super::http::{public_routes, routes, HelloKey};
use super::service::CliRunService;
use super::wire::{self, BuildKind};

/// The app-metadata key of the "Allow command-line access" setting. Absent
/// means on.
pub const ACCESS_SETTING_KEY: &str = "cli_access_enabled";

/// What the settings page shows about command-line access.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliAccessStatus {
    pub enabled: bool,
    /// Listening and published.
    pub running: bool,
    /// The discovery file this runtime publishes (whether or not it exists).
    pub endpoint_file: String,
    /// Why access is enabled but not running, when it is not.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

struct Running {
    file: PathBuf,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
}

/// Starts and stops a runtime's command-line access.
pub struct CliAccess {
    service: Arc<CliRunService>,
    data_dir: PathBuf,
    running: Mutex<Option<Running>>,
    last_error: std::sync::Mutex<Option<String>>,
    /// Held across a setting's change and the start or stop it causes, and by
    /// the start at launch: two quick toggles cannot leave the listener in
    /// the state the setting is not.
    transition: Mutex<()>,
    /// The process is on its way out: nothing is published any more, not
    /// even by a start already under way.
    closing: AtomicBool,
}

impl CliAccess {
    pub fn new(service: Arc<CliRunService>, data_dir: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            service,
            data_dir,
            running: Mutex::new(None),
            last_error: std::sync::Mutex::new(None),
            transition: Mutex::new(()),
            closing: AtomicBool::new(false),
        })
    }

    /// This process's discovery file.
    pub fn endpoint_file(&self) -> PathBuf {
        discovery::file_for(&self.data_dir, std::process::id())
    }

    /// Start, unless the setting turns it off. Failures are logged and kept
    /// for `status`: a runtime without CLI access is still a runtime.
    pub async fn start_if_enabled(&self, db: &sea_orm::DatabaseConnection) {
        let _transition = self.transition.lock().await;
        if !access_enabled(db).await {
            tracing::info!("[cli] command-line access is off");
            return;
        }
        if let Err(e) = self.start().await {
            tracing::warn!("[cli] command-line access unavailable: {e}");
        }
    }

    /// Listen and publish. Idempotent.
    pub async fn start(&self) -> Result<(), String> {
        let mut running = self.running.lock().await;
        if running.is_some() {
            return Ok(());
        }
        if self.closing.load(Ordering::SeqCst) {
            return Err("codeg is shutting down".to_string());
        }
        let result = self.start_locked().await;
        match result {
            Ok(r) => {
                *running = Some(r);
                *self.last_error.lock().expect("last_error") = None;
                Ok(())
            }
            Err(e) => {
                *self.last_error.lock().expect("last_error") = Some(e.clone());
                Err(e)
            }
        }
    }

    async fn start_locked(&self) -> Result<Running, String> {
        let dir = discovery::dir(&self.data_dir);
        // Privacy first: with no private place to publish the token in, there
        // is no point listening at all.
        let prepared = discovery::prepare_dir(&dir)?;
        discovery::sweep_stale(&dir);

        let listener = tokio::net::TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
            .await
            .map_err(|e| format!("cannot listen on 127.0.0.1: {e}"))?;
        if let Err(e) = crate::web::socket_inherit::mark_listener_non_inheritable(&listener) {
            tracing::warn!("[cli] could not mark the listener non-inheritable: {e}");
        }
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let token = super::hello::random_hex(32);
        let router = loopback_router(Arc::clone(&self.service), token.clone(), port);

        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(async move {
            let serve = axum::serve(listener, router).with_graceful_shutdown(async move {
                let _ = rx.await;
            });
            if let Err(e) = serve.await {
                tracing::warn!("[cli] loopback listener stopped: {e}");
            }
        });

        let file = self.endpoint_file();
        let record = DiscoveryRecord {
            url: format!("http://127.0.0.1:{port}"),
            token,
            pid: std::process::id(),
            runtime: self.service.runtime(),
            build: BuildKind::current(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            api_version: wire::API_VERSION,
            data_dir: self.data_dir.to_string_lossy().into_owned(),
            started_at: chrono::Utc::now().to_rfc3339(),
        };
        if let Err(e) = discovery::write_record(&prepared, &file, &record) {
            let _ = tx.send(());
            return Err(format!("cannot publish {}: {e}", file.display()));
        }
        // An exit that removed the file while it was being written: gone
        // again. (Set before its removal, so one side always sees the other.)
        if self.closing.load(Ordering::SeqCst) {
            let _ = std::fs::remove_file(&file);
            let _ = tx.send(());
            return Err("codeg is shutting down".to_string());
        }
        tracing::info!(
            "[cli] command-line access on 127.0.0.1:{port}, published at {}",
            file.display()
        );
        Ok(Running {
            file,
            shutdown: Some(tx),
        })
    }

    /// Unpublish and stop listening. Idempotent.
    pub async fn stop(&self) {
        if let Some(mut running) = self.running.lock().await.take() {
            let _ = std::fs::remove_file(&running.file);
            if let Some(tx) = running.shutdown.take() {
                let _ = tx.send(());
            }
        }
    }

    /// Remove the discovery file without waiting — for exit paths that
    /// cannot await. The listener dies with the process.
    pub fn unpublish_now(&self) {
        self.closing.store(true, Ordering::SeqCst);
        let _ = std::fs::remove_file(self.endpoint_file());
    }

    pub async fn status(&self, db: &sea_orm::DatabaseConnection) -> CliAccessStatus {
        let running = self.running.lock().await.is_some();
        let enabled = access_enabled(db).await;
        CliAccessStatus {
            enabled,
            running,
            endpoint_file: self.endpoint_file().to_string_lossy().into_owned(),
            error: if enabled && !running {
                self.last_error.lock().expect("last_error").clone()
            } else {
                None
            },
        }
    }

    /// Save the setting and apply it now.
    pub async fn set_enabled(
        &self,
        db: &sea_orm::DatabaseConnection,
        enabled: bool,
    ) -> Result<CliAccessStatus, String> {
        let _transition = self.transition.lock().await;
        crate::db::service::app_metadata_service::upsert_value(
            db,
            ACCESS_SETTING_KEY,
            if enabled { "true" } else { "false" },
        )
        .await
        .map_err(|e| e.to_string())?;
        if enabled {
            let _ = self.start().await;
        } else {
            self.stop().await;
        }
        Ok(self.status(db).await)
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }
}

/// The setting, read; on unless switched off.
pub async fn access_enabled(db: &sea_orm::DatabaseConnection) -> bool {
    !matches!(
        crate::db::service::app_metadata_service::get_value(db, ACCESS_SETTING_KEY)
            .await
            .ok()
            .flatten()
            .as_deref(),
        Some("false")
    )
}

/// The loopback router: health, hello, and the token-guarded CLI routes, all
/// behind the `Host` check.
pub fn loopback_router(service: Arc<CliRunService>, token: String, port: u16) -> Router {
    let hello = HelloKey {
        token: token.clone(),
        port: Some(port),
    };
    let guarded = routes(Arc::clone(&service)).layer(middleware::from_fn(move |req, next| {
        crate::web::auth::require_token(req, next, token.clone())
    }));
    Router::new()
        .nest(
            "/api",
            Router::new()
                .route("/health", post(health))
                .merge(public_routes(service, hello))
                .merge(guarded),
        )
        .layer(middleware::from_fn(move |req: Request, next: Next| {
            check_host(req, next, port)
        }))
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok", "version": env!("CARGO_PKG_VERSION") }))
}

/// Only `127.0.0.1:<port>` and `localhost:<port>`: a page that rebinds its own
/// host name to 127.0.0.1 still sends its own name.
async fn check_host(req: Request, next: Next, port: u16) -> Response {
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    let allowed = host == format!("127.0.0.1:{port}") || host == format!("localhost:{port}");
    if !allowed {
        return (StatusCode::MISDIRECTED_REQUEST, "unexpected Host").into_response();
    }
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::manager::ConnectionManager;
    use crate::acp::{EventBusMetrics, InternalEventBus};
    use crate::cli_run::wire::{HelloRequest, HelloResponse, RuntimeKind};
    use crate::db::test_helpers;
    use crate::web::event_bridge::{EventEmitter, WebEventBroadcaster};

    async fn access(data_dir: &Path) -> (Arc<CliAccess>, crate::db::AppDatabase) {
        let db = test_helpers::fresh_in_memory_db().await;
        let bus = Arc::new(InternalEventBus::new(Arc::new(EventBusMetrics::default())));
        let emitter = EventEmitter::web_only(Arc::new(WebEventBroadcaster::new()), bus.clone());
        let service = CliRunService::new(
            &db,
            &ConnectionManager::new(),
            emitter,
            bus,
            data_dir.to_path_buf(),
            RuntimeKind::Server,
        );
        (CliAccess::new(service, data_dir.to_path_buf()), db)
    }

    fn client() -> reqwest::Client {
        // Loopback only: never through a proxy from the environment.
        reqwest::Client::builder().no_proxy().build().unwrap()
    }

    /// Once the process is on its way out, nothing is published again — not
    /// by a start under way, nor by a toggle.
    #[tokio::test]
    async fn nothing_is_published_after_the_exit_began() {
        let data = tempfile::tempdir().unwrap();
        let (access, db) = access(data.path()).await;
        access.start().await.expect("starts");
        assert!(access.endpoint_file().exists());

        access.unpublish_now();
        assert!(!access.endpoint_file().exists());
        access.stop().await;
        assert!(access.start().await.is_err());
        let status = access.set_enabled(&db.conn, true).await.expect("saved");
        assert!(!status.running);
        assert!(!access.endpoint_file().exists());
    }

    #[tokio::test]
    async fn the_loopback_listener_proves_itself_and_guards_its_routes() {
        let data = tempfile::tempdir().unwrap();
        let (access, db) = access(data.path()).await;
        access.start().await.expect("starts");
        let file = access.endpoint_file();
        let record = discovery::read_record(&file).expect("published");
        assert_eq!(record.pid, std::process::id());
        assert_eq!(record.api_version, wire::API_VERSION);
        let port: u16 = record.url.rsplit(':').next().unwrap().parse().unwrap();

        // The challenge needs no token, and only the token holder can answer.
        let nonce = crate::cli_run::hello::random_hex(16);
        let hello: HelloResponse = client()
            .post(format!("{}/api/cli_hello", record.url))
            .json(&HelloRequest {
                nonce: nonce.clone(),
                client_version: "test".into(),
                api_version: wire::API_VERSION,
            })
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(crate::cli_run::hello::verify(
            &record.token,
            &nonce,
            Some(port),
            &hello.proof
        ));
        assert_eq!(hello.runtime, RuntimeKind::Server);
        assert!(hello.capabilities.contains(&"run".to_string()));

        let reserve = format!("{}/api/cli_run_reserve", record.url);
        let without = client()
            .post(&reserve)
            .json(&serde_json::json!({}))
            .send()
            .await
            .unwrap();
        assert_eq!(without.status(), StatusCode::UNAUTHORIZED);
        let with = client()
            .post(&reserve)
            .bearer_auth(&record.token)
            .json(&serde_json::json!({}))
            .send()
            .await
            .unwrap();
        assert_eq!(with.status(), StatusCode::OK);
        let body: serde_json::Value = with.json().await.unwrap();
        assert!(body["runId"].as_str().is_some_and(|id| !id.is_empty()));

        // A page that rebinds its own name to 127.0.0.1 still sends its name.
        let rebound = client()
            .post(&reserve)
            .header(header::HOST, format!("evil.example:{port}"))
            .bearer_auth(&record.token)
            .json(&serde_json::json!({}))
            .send()
            .await
            .unwrap();
        assert_eq!(rebound.status(), StatusCode::MISDIRECTED_REQUEST);

        // Switching access off unpublishes and stops listening.
        let status = access.set_enabled(&db.conn, false).await.unwrap();
        assert!(!status.enabled && !status.running);
        assert!(!file.exists());
        assert!(!access_enabled(&db.conn).await);
        let refused = client().post(&reserve).send().await;
        assert!(refused.is_err(), "nothing listens any more");

        let status = access.set_enabled(&db.conn, true).await.unwrap();
        assert!(status.enabled && status.running);
        let again = discovery::read_record(&file).expect("republished");
        assert_ne!(again.token, record.token, "a fresh token per start");
        access.stop().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn no_listener_when_the_directory_is_not_private() {
        use std::os::unix::fs::PermissionsExt;
        let data = tempfile::tempdir().unwrap();
        let dir = discovery::dir(data.path());
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        let (access, db) = access(data.path()).await;
        let err = access.start().await.expect_err("refused");
        assert!(err.contains("readable by other users"), "{err}");
        let status = access.status(&db.conn).await;
        assert!(status.enabled && !status.running);
        assert!(status.error.is_some());
        assert!(!access.endpoint_file().exists());
    }
}
