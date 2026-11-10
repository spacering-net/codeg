//! OpenCode 2 provider credentials, read and written through OpenCode itself.
//!
//! OpenCode 2 keeps provider credentials in the `credential` table of
//! `opencode.db`. It reads `auth.json` exactly once, in the migration that
//! upgrades a 1.x database (a fresh 2.x database never reads it), so writing
//! that file no longer connects anything.
//!
//! Its CLI cannot store an API key without a terminal (`auth login` asks for the
//! key through an interactive prompt only), and the table is internal: the
//! `value` column has changed shape before, and the database path follows
//! XDG/`OPENCODE_DB` rules and per-channel names. So codeg goes through the
//! HTTP API OpenCode's own clients use, served by the same private server
//! `opencode auth … --standalone` starts: `opencode serve --stdio --port 0`.
//! That server prints `{"url":"http://127.0.0.1:<port>"}` on its first stdout
//! line, binds loopback, requires basic auth (`opencode` and the
//! `OPENCODE_PASSWORD` it was started with) and exits when its stdin closes,
//! which is its lease. One such helper serves one settings operation and costs
//! about a second.
//!
//! The helper runs with a session's launch environment and in an empty
//! codeg-owned directory, so it opens the same database and global config a
//! session does while no project's config can add providers to it. Before any
//! integration call it asks for the default model, the readiness point
//! OpenCode's CLI uses too: until the first plugin generation has loaded, an
//! integration declared in the config is not known yet and connecting it
//! answers 404.
//!
//! Secrets travel one way. A key goes to OpenCode in a request body (never on a
//! command line), and nothing this module returns carries one: the integration
//! list holds ids, labels and methods only. The credential list it reads to
//! disconnect does carry each secret, and is dropped right there.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

use crate::acp::error::AcpError;
use crate::acp::registry::{self, AgentDistribution};
use crate::models::agent::AgentType;

/// How long the helper may take to print its URL. A first start under an
/// antivirus scan, or one that migrates a large database, can be slow.
const READY_TIMEOUT: Duration = Duration::from_secs(30);

/// Bound on each HTTP call. The readiness call waits for the first plugin
/// generation, which may install plugins.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// The basic-auth user OpenCode's server expects with `OPENCODE_PASSWORD`.
const SERVER_USER: &str = "opencode";

/// One authentication method of an integration, as OpenCode lists it: `key`,
/// `env`, `oauth`, `external` or `command`. Passed through as-is apart from
/// unknown keys, which are dropped; none of these carries a secret.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OpenCodeIntegrationMethod {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Extra fields the method asks for alongside the key (Azure's resource
    /// name, a Cloudflare account id, …), as OpenCode's form schema.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub form: Option<Vec<Value>>,
    /// The environment variables an `env` method reads.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub names: Option<Vec<String>>,
}

/// One way an integration is connected: a stored credential, or an
/// environment variable OpenCode found. Never carries the secret.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OpenCodeConnection {
    #[serde(rename = "type")]
    pub kind: String,
    /// The credential id, for a stored credential.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// `key`, `oauth` or `external`, for a stored credential.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    /// The variable's name, for an environment connection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// A problem OpenCode reported for this connection (`needs_auth`, with a
    /// message), when there is one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<Value>,
    /// Whether OpenCode uses this connection: the first one it lists. A stored
    /// credential outranks an environment variable.
    #[serde(default)]
    pub active: bool,
}

/// An integration (a provider, mostly) as OpenCode reports it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OpenCodeIntegration {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub methods: Vec<OpenCodeIntegrationMethod>,
    #[serde(default)]
    pub connections: Vec<OpenCodeConnection>,
}

/// The fields of a stored credential this module looks at. `value` (the
/// secret) is deliberately not one of them, so it is never even deserialized.
#[derive(Debug, Deserialize)]
struct StoredCredential {
    id: String,
    #[serde(rename = "integrationID", default)]
    integration_id: Option<String>,
}

/// A stored credential with its secret, read only by [`ServerClient::stored_key`].
#[derive(Deserialize)]
struct StoredCredentialValue {
    #[serde(rename = "integrationID", default)]
    integration_id: Option<String>,
    #[serde(default)]
    active: Option<bool>,
    #[serde(default)]
    value: Value,
}

#[derive(Debug, Deserialize)]
struct DataEnvelope<T> {
    data: T,
}

/// The integrations from an `/api/integration` response, each connection
/// marked active when it is the one OpenCode uses (the first).
fn integrations_from_response(body: &str) -> Result<Vec<OpenCodeIntegration>, AcpError> {
    let envelope: DataEnvelope<Vec<OpenCodeIntegration>> = serde_json::from_str(body)
        .map_err(|e| AcpError::protocol(format!("unexpected OpenCode integration list: {e}")))?;
    Ok(envelope
        .data
        .into_iter()
        .map(|mut integration| {
            for (index, connection) in integration.connections.iter_mut().enumerate() {
                connection.active = index == 0;
            }
            integration
        })
        .collect())
}

/// The message OpenCode put in an error response (`{"_tag": …, "message": …}`),
/// or the raw body.
fn error_message(status: reqwest::StatusCode, body: &str) -> String {
    let message = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| body.trim().to_string());
    if message.is_empty() {
        format!("OpenCode answered HTTP {status}")
    } else {
        format!("OpenCode answered HTTP {status}: {message}")
    }
}

/// An HTTP client for one OpenCode server, scoped to one location directory.
/// Split from the process that serves it so it can be tested against a stub.
struct ServerClient {
    http: reqwest::Client,
    base: String,
    password: String,
    directory: String,
}

impl ServerClient {
    fn new(base: &str, password: &str, directory: &str) -> Result<Self, AcpError> {
        // Loopback only: a configured proxy must never see these requests,
        // and one without a NO_PROXY exception would swallow them.
        let http = reqwest::Client::builder()
            .no_proxy()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|e| AcpError::protocol(format!("OpenCode helper client: {e}")))?;
        Ok(Self {
            http,
            base: base.trim_end_matches('/').to_string(),
            password: password.to_string(),
            directory: directory.to_string(),
        })
    }

    async fn send(
        &self,
        method: reqwest::Method,
        path: &str,
        located: bool,
        body: Option<Value>,
    ) -> Result<String, AcpError> {
        let mut request = self
            .http
            .request(method, format!("{}{path}", self.base))
            .basic_auth(SERVER_USER, Some(&self.password));
        if located {
            request = request.query(&[("location[directory]", self.directory.as_str())]);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request
            .send()
            .await
            .map_err(|e| AcpError::protocol(format!("OpenCode helper request failed: {e}")))?;
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if status.is_success() {
            Ok(text)
        } else {
            Err(AcpError::protocol(error_message(status, &text)))
        }
    }

    /// Wait for the first plugin generation, so integrations declared in the
    /// config exist before anything addresses them.
    async fn ready(&self) -> Result<(), AcpError> {
        self.send(reqwest::Method::GET, "/api/model/default", true, None)
            .await
            .map(|_| ())
    }

    async fn integrations(&self) -> Result<Vec<OpenCodeIntegration>, AcpError> {
        let body = self
            .send(reqwest::Method::GET, "/api/integration", true, None)
            .await?;
        integrations_from_response(&body)
    }

    async fn connect_key(
        &self,
        integration_id: &str,
        key: &str,
        answer: Option<&BTreeMap<String, Value>>,
    ) -> Result<(), AcpError> {
        let mut body = serde_json::json!({ "key": key });
        if let Some(answer) = answer.filter(|answer| !answer.is_empty()) {
            body["answer"] = serde_json::to_value(answer)
                .map_err(|e| AcpError::protocol(format!("OpenCode form answer: {e}")))?;
        }
        let path = format!(
            "/api/integration/{}/connect/key",
            urlencoding::encode(integration_id)
        );
        self.send(reqwest::Method::POST, &path, true, Some(body))
            .await
            .map(|_| ())
    }

    /// The ids of the credentials stored for `integration_id`.
    async fn credential_ids(&self, integration_id: &str) -> Result<Vec<String>, AcpError> {
        let body = self
            .send(reqwest::Method::GET, "/api/credential", false, None)
            .await?;
        let envelope: DataEnvelope<Vec<StoredCredential>> = serde_json::from_str(&body)
            .map_err(|e| AcpError::protocol(format!("unexpected OpenCode credential list: {e}")))?;
        Ok(envelope
            .data
            .into_iter()
            .filter(|credential| credential.integration_id.as_deref() == Some(integration_id))
            .map(|credential| credential.id)
            .collect())
    }

    /// The API key OpenCode would use for `integration_id`: the active stored
    /// credential's (a legacy row with no flag counts when it is the only
    /// one), when that credential is a key.
    async fn stored_key(&self, integration_id: &str) -> Result<Option<String>, AcpError> {
        let body = self
            .send(reqwest::Method::GET, "/api/credential", false, None)
            .await?;
        let envelope: DataEnvelope<Vec<StoredCredentialValue>> = serde_json::from_str(&body)
            .map_err(|e| AcpError::protocol(format!("unexpected OpenCode credential list: {e}")))?;
        let mine: Vec<StoredCredentialValue> = envelope
            .data
            .into_iter()
            .filter(|credential| credential.integration_id.as_deref() == Some(integration_id))
            .collect();
        let chosen = mine
            .iter()
            .find(|credential| credential.active == Some(true))
            .or_else(|| (mine.len() == 1).then(|| &mine[0]));
        Ok(chosen.and_then(|credential| {
            (credential.value.get("type").and_then(Value::as_str) == Some("key"))
                .then(|| credential.value.get("key").and_then(Value::as_str))
                .flatten()
                .map(str::trim)
                .filter(|key| !key.is_empty())
                .map(str::to_string)
        }))
    }

    async fn remove_credential(&self, credential_id: &str) -> Result<(), AcpError> {
        let path = format!("/api/credential/{}", urlencoding::encode(credential_id));
        self.send(reqwest::Method::DELETE, &path, false, None)
            .await
            .map(|_| ())
    }

    /// Remove every credential stored for the integration. Removing only the
    /// active one would promote the next, leaving it connected.
    async fn disconnect(&self, integration_id: &str) -> Result<(), AcpError> {
        for id in self.credential_ids(integration_id).await? {
            self.remove_credential(&id).await?;
        }
        Ok(())
    }
}

/// A running `opencode serve --stdio --port 0` and a client for it. Dropping it
/// kills the process; [`Helper::finish`] closes its lease instead and lets it
/// exit on its own.
struct Helper {
    child: tokio::process::Child,
    client: ServerClient,
}

impl Helper {
    async fn start(bin: &Path, env: &[(String, String)], cwd: &Path) -> Result<Self, AcpError> {
        let password = uuid::Uuid::new_v4().simple().to_string();
        let mut command = crate::process::tokio_command(bin);
        command
            .args(["serve", "--stdio", "--port", "0"])
            .current_dir(cwd)
            .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .env("OPENCODE_PASSWORD", &password)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command
            .spawn()
            .map_err(|e| AcpError::SpawnFailed(format!("{}: {e}", bin.display())))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AcpError::protocol("OpenCode helper has no stdout"))?;
        let mut stderr = child.stderr.take();

        let mut lines = BufReader::new(stdout).lines();
        let first = tokio::time::timeout(READY_TIMEOUT, lines.next_line()).await;
        let url = match first {
            Ok(Ok(Some(line))) => serde_json::from_str::<Value>(line.trim())
                .ok()
                .and_then(|value| value.get("url").and_then(Value::as_str).map(str::to_string)),
            _ => None,
        };
        let Some(url) = url else {
            let _ = child.start_kill();
            let mut tail = String::new();
            if let Some(stderr) = stderr.as_mut() {
                let mut buf = Vec::new();
                let _ = tokio::time::timeout(
                    Duration::from_secs(2),
                    stderr.take(16 * 1024).read_to_end(&mut buf),
                )
                .await;
                tail = String::from_utf8_lossy(&buf).trim().to_string();
            }
            return Err(AcpError::protocol(if tail.is_empty() {
                format!("OpenCode ({}) did not start its server", bin.display())
            } else {
                format!(
                    "OpenCode ({}) did not start its server: {}",
                    bin.display(),
                    tail.lines().last().unwrap_or_default()
                )
            }));
        };
        // Drain the rest of both streams so a chatty server can never block
        // on a full pipe.
        tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
        if let Some(mut stderr) = stderr {
            tokio::spawn(async move {
                let _ = tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await;
            });
        }

        let client = ServerClient::new(&url, &password, &cwd.to_string_lossy())?;
        let helper = Self { child, client };
        helper.client.ready().await?;
        Ok(helper)
    }

    /// Close the lease and give the server a moment to exit by itself.
    async fn finish(mut self) {
        drop(self.child.stdin.take());
        if tokio::time::timeout(Duration::from_secs(5), self.child.wait())
            .await
            .is_err()
        {
            let _ = self.child.start_kill();
        }
    }
}

/// The OpenCode codeg would launch for a session: the best managed install,
/// else one on PATH. A 1.x build has no credential API, so it is refused the
/// same way a session refuses it.
async fn resolve_binary() -> Result<PathBuf, AcpError> {
    let meta = registry::get_agent_meta(AgentType::OpenCode);
    let AgentDistribution::Binary {
        cmd,
        version: pinned,
        ..
    } = meta.distribution
    else {
        return Err(AcpError::protocol("OpenCode is not a binary agent"));
    };
    let (bin, label) =
        match crate::acp::binary_cache::find_best_cached_binary_for_agent(AgentType::OpenCode, cmd)? {
            Some((path, version)) => (path, Some(version)),
            None => (
                crate::commands::acp::resolve_system_agent_binary_for(AgentType::OpenCode, cmd)
                    .ok_or_else(|| {
                        AcpError::SdkNotInstalled(
                            "OpenCode is not installed. Install it in Agent Settings to connect providers."
                                .to_string(),
                        )
                    })?,
                None,
            ),
        };
    if let Some(version) = crate::acp::opencode_launch::pre_v2_runtime(&bin, label.as_deref()).await
    {
        return Err(AcpError::AgentRuntimeOutdated(
            crate::acp::opencode_launch::runtime_outdated_message(
                &version,
                &bin,
                label.is_some(),
                pinned,
            ),
        ));
    }
    Ok(bin)
}

/// The empty directory the helper runs in, so no project's config is loaded.
fn helper_directory(data_dir: &Path) -> Result<PathBuf, AcpError> {
    let dir = data_dir.join("opencode").join("credentials-cwd");
    std::fs::create_dir_all(&dir)
        .map_err(|e| AcpError::protocol(format!("create {}: {e}", dir.display())))?;
    Ok(dir)
}

/// A helper started the way a session would start OpenCode.
async fn start_helper(
    runtime_env: &BTreeMap<String, String>,
    data_dir: &Path,
) -> Result<Helper, AcpError> {
    let bin = resolve_binary().await?;
    let env = crate::acp::connection::opencode_helper_env(runtime_env);
    let cwd = helper_directory(data_dir)?;
    Helper::start(&bin, &env, &cwd).await
}

/// Every integration OpenCode knows, with how each is connected.
pub(crate) async fn list(
    runtime_env: &BTreeMap<String, String>,
    data_dir: &Path,
) -> Result<Vec<OpenCodeIntegration>, AcpError> {
    let helper = start_helper(runtime_env, data_dir).await?;
    let result = helper.client.integrations().await;
    helper.finish().await;
    result
}

/// Store `key` for `integration_id`, making it the credential OpenCode uses,
/// and return the integrations as that leaves them. With `replace`, the
/// integration's earlier credentials are removed afterwards (editing a
/// connected provider replaces its key rather than adding a second account).
/// `answer` fills the extra form fields some key methods ask for.
pub(crate) async fn connect_key(
    runtime_env: &BTreeMap<String, String>,
    data_dir: &Path,
    integration_id: &str,
    key: &str,
    answer: Option<BTreeMap<String, Value>>,
    replace: bool,
) -> Result<Vec<OpenCodeIntegration>, AcpError> {
    let integration_id = integration_id.trim();
    let key = key.trim();
    if integration_id.is_empty() || key.is_empty() {
        return Err(AcpError::protocol(
            "a provider id and an API key are required",
        ));
    }
    let helper = start_helper(runtime_env, data_dir).await?;
    let client = &helper.client;
    let result = async {
        let previous = if replace {
            client.credential_ids(integration_id).await?
        } else {
            Vec::new()
        };
        client
            .connect_key(integration_id, key, answer.as_ref())
            .await?;
        for id in previous {
            client.remove_credential(&id).await?;
        }
        client.integrations().await
    }
    .await;
    helper.finish().await;
    result
}

/// The API key stored for `integration_id`, for codeg to act on the user's
/// behalf (listing a provider's models). It never leaves the backend.
pub(crate) async fn stored_key(
    runtime_env: &BTreeMap<String, String>,
    data_dir: &Path,
    integration_id: &str,
) -> Result<Option<String>, AcpError> {
    let helper = start_helper(runtime_env, data_dir).await?;
    let result = helper.client.stored_key(integration_id.trim()).await;
    helper.finish().await;
    result
}

/// Remove every credential stored for `integration_id`, and return the
/// integrations as that leaves them.
pub(crate) async fn disconnect(
    runtime_env: &BTreeMap<String, String>,
    data_dir: &Path,
    integration_id: &str,
) -> Result<Vec<OpenCodeIntegration>, AcpError> {
    let integration_id = integration_id.trim();
    if integration_id.is_empty() {
        return Err(AcpError::protocol("a provider id is required"));
    }
    let helper = start_helper(runtime_env, data_dir).await?;
    let client = &helper.client;
    let result = async {
        client.disconnect(integration_id).await?;
        client.integrations().await
    }
    .await;
    helper.finish().await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// `/api/integration` as OpenCode 2.2.0 answers it (trimmed from a real
    /// capture): a location envelope, a key method with a form, an env method,
    /// and connections in the order OpenCode ranks them.
    const INTEGRATIONS: &str = r#"{"location":{"directory":"/tmp/x"},"data":[
        {"id":"azure","name":"Azure","methods":[{"type":"key","label":"API key","form":[{"key":"resourceName","title":"Enter Azure Resource Name","required":true,"type":"string","placeholder":"e.g. my-models"}]},{"type":"env","names":["AZURE_API_KEY"]}],"connections":[]},
        {"id":"deepseek","name":"DeepSeek","metadata":{"x":1},"methods":[{"type":"key"},{"type":"env","names":["DEEPSEEK_API_KEY"]}],"connections":[{"type":"credential","id":"cred_1","label":"DeepSeek","method":"key"},{"type":"env","name":"DEEPSEEK_API_KEY"}]}
    ]}"#;

    #[test]
    fn integrations_mark_the_first_connection_active() {
        let list = integrations_from_response(INTEGRATIONS).expect("parse");
        assert_eq!(list.len(), 2);
        assert!(list[0].connections.is_empty());
        assert_eq!(list[0].methods[0].form.as_ref().map(Vec::len), Some(1));
        assert_eq!(
            list[0].methods[1].names.as_deref(),
            Some(&["AZURE_API_KEY".to_string()][..])
        );
        let deepseek = &list[1];
        assert_eq!(deepseek.connections.len(), 2);
        assert!(deepseek.connections[0].active);
        assert_eq!(deepseek.connections[0].id.as_deref(), Some("cred_1"));
        assert!(!deepseek.connections[1].active);
        assert_eq!(
            deepseek.connections[1].name.as_deref(),
            Some("DEEPSEEK_API_KEY")
        );
    }

    #[test]
    fn an_error_body_yields_opencodes_message() {
        let body = r#"{"_tag":"IntegrationNotFoundError","integrationID":"nope","message":"Integration not found: nope"}"#;
        let message = error_message(reqwest::StatusCode::NOT_FOUND, body);
        assert!(message.contains("404"), "{message}");
        assert!(message.contains("Integration not found: nope"), "{message}");
        assert_eq!(
            error_message(reqwest::StatusCode::BAD_GATEWAY, ""),
            "OpenCode answered HTTP 502 Bad Gateway"
        );
    }

    /// A stub of the endpoints this module calls, recording each request.
    #[derive(Clone, Default)]
    struct Stub {
        log: Arc<Mutex<Vec<String>>>,
        credentials: Arc<Mutex<Vec<(String, String)>>>,
    }

    async fn serve_stub(stub: Stub) -> String {
        use axum::extract::{Path as AxPath, Query, State};
        use axum::http::{HeaderMap, StatusCode};
        use axum::routing::{delete, get, post};
        use axum::{Json, Router};

        fn authorized(headers: &HeaderMap) -> bool {
            use base64::Engine;
            let expected = format!(
                "Basic {}",
                base64::engine::general_purpose::STANDARD.encode("opencode:pw")
            );
            headers.get("authorization").and_then(|v| v.to_str().ok()) == Some(expected.as_str())
        }

        let app = Router::new()
            .route(
                "/api/model/default",
                get(
                    |State(stub): State<Stub>,
                     headers: HeaderMap,
                     Query(q): Query<BTreeMap<String, String>>| async move {
                        stub.log.lock().unwrap().push(format!(
                            "ready {}",
                            q.get("location[directory]").cloned().unwrap_or_default()
                        ));
                        if authorized(&headers) {
                            StatusCode::OK
                        } else {
                            StatusCode::UNAUTHORIZED
                        }
                    },
                ),
            )
            .route(
                "/api/integration",
                get(|State(stub): State<Stub>| async move {
                    stub.log.lock().unwrap().push("list".into());
                    let connections: Vec<Value> = stub
                        .credentials
                        .lock()
                        .unwrap()
                        .iter()
                        .map(|(id, _)| {
                            serde_json::json!({"type":"credential","id":id,"label":"DeepSeek","method":"key"})
                        })
                        .collect();
                    Json(serde_json::json!({"data":[{"id":"deepseek","name":"DeepSeek","methods":[{"type":"key"}],"connections":connections}]}))
                }),
            )
            .route(
                "/api/integration/{id}/connect/key",
                post(
                    |State(stub): State<Stub>, AxPath(id): AxPath<String>, Json(body): Json<Value>| async move {
                        stub.log.lock().unwrap().push(format!("connect {id} {body}"));
                        if id != "deepseek" {
                            return (
                                StatusCode::NOT_FOUND,
                                Json(serde_json::json!({"_tag":"IntegrationNotFoundError","message":format!("Integration not found: {id}")})),
                            );
                        }
                        let mut credentials = stub.credentials.lock().unwrap();
                        let next = format!("cred_{}", credentials.len() + 1);
                        credentials.insert(0, (next, id));
                        (StatusCode::NO_CONTENT, Json(Value::Null))
                    },
                ),
            )
            .route(
                "/api/credential",
                get(|State(stub): State<Stub>| async move {
                    stub.log.lock().unwrap().push("credentials".into());
                    let data: Vec<Value> = stub
                        .credentials
                        .lock()
                        .unwrap()
                        .iter()
                        .map(|(id, integration)| {
                            serde_json::json!({"id":id,"integrationID":integration,"label":"DeepSeek","active":true,"value":{"type":"key","key":"sk-secret"}})
                        })
                        .collect();
                    Json(serde_json::json!({ "data": data }))
                }),
            )
            .route(
                "/api/credential/{id}",
                delete(|State(stub): State<Stub>, AxPath(id): AxPath<String>| async move {
                    stub.log.lock().unwrap().push(format!("remove {id}"));
                    stub.credentials.lock().unwrap().retain(|(c, _)| c != &id);
                    StatusCode::NO_CONTENT
                }),
            )
            .with_state(stub);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve");
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn the_client_connects_replaces_and_disconnects_through_the_api() {
        let stub = Stub::default();
        let base = serve_stub(stub.clone()).await;
        let client =
            ServerClient::new(&base, "pw", "/data/opencode/credentials-cwd").expect("client");

        client.ready().await.expect("ready");
        client
            .connect_key("deepseek", "sk-1", None)
            .await
            .expect("connect");
        // A key with form answers carries them in the body.
        let mut answer = BTreeMap::new();
        answer.insert("resourceName".to_string(), Value::from("my-models"));
        let previous = client.credential_ids("deepseek").await.expect("ids");
        client
            .connect_key("deepseek", "sk-2", Some(&answer))
            .await
            .expect("connect with answer");
        for id in previous {
            client.remove_credential(&id).await.expect("remove");
        }
        let after_replace = client.integrations().await.expect("list");
        assert_eq!(after_replace[0].connections.len(), 1);
        assert_eq!(
            after_replace[0].connections[0].id.as_deref(),
            Some("cred_2")
        );

        let missing = client.connect_key("nope", "sk", None).await.unwrap_err();
        assert!(
            missing.to_string().contains("Integration not found: nope"),
            "{missing}"
        );

        // The stored key is read for codeg's own use; the stub's active
        // credential carries "sk-secret".
        assert_eq!(
            client.stored_key("deepseek").await.expect("key").as_deref(),
            Some("sk-secret")
        );
        assert_eq!(client.stored_key("nope").await.expect("none"), None);

        client.disconnect("deepseek").await.expect("disconnect");
        assert!(client.integrations().await.expect("list")[0]
            .connections
            .is_empty());

        let log = stub.log.lock().unwrap().clone();
        assert_eq!(log[0], "ready /data/opencode/credentials-cwd");
        // Compared as values: whether serde_json keeps key order depends on
        // the build's feature set.
        let bodies: Vec<Value> = log
            .iter()
            .filter_map(|line| line.strip_prefix("connect deepseek "))
            .map(|body| serde_json::from_str(body).expect("logged json"))
            .collect();
        assert!(
            bodies.contains(&serde_json::json!({"key": "sk-1"})),
            "{log:?}"
        );
        assert!(
            bodies.contains(&serde_json::json!({
                "key": "sk-2",
                "answer": {"resourceName": "my-models"}
            })),
            "{log:?}"
        );
        assert!(log.contains(&"remove cred_1".to_string()), "{log:?}");
        assert!(log.contains(&"remove cred_2".to_string()), "{log:?}");
    }

    #[tokio::test]
    async fn a_wrong_password_is_reported_not_retried() {
        let base = serve_stub(Stub::default()).await;
        let client = ServerClient::new(&base, "wrong", "/x").expect("client");
        let err = client.ready().await.unwrap_err();
        assert!(err.to_string().contains("401"), "{err}");
    }

    /// The listed shape never carries a secret, whatever OpenCode adds to a
    /// connection.
    #[test]
    fn a_connection_never_serializes_a_secret() {
        let body = r#"{"data":[{"id":"x","name":"X","methods":[],"connections":[{"type":"credential","id":"c","label":"L","method":"key","value":{"type":"key","key":"sk-leak"},"key":"sk-leak"}]}]}"#;
        let list = integrations_from_response(body).expect("parse");
        let out = serde_json::to_string(&list).expect("serialize");
        assert!(!out.contains("sk-leak"), "{out}");
    }
}
