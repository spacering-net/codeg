use std::collections::BTreeMap;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use tokio::net::TcpListener;
use tokio::sync::mpsc;

use super::*;

async fn run_probe(definition: McpDefinition, env: AgentEnv, ms: u64) -> McpProbeResult {
    let mut report = empty_report();
    let mut diagnostics = Diagnostics::default();
    let start = Instant::now();
    let result = tokio::time::timeout(
        Duration::from_millis(ms),
        probe(&definition, &env, &mut report, &mut diagnostics),
    )
    .await;
    finish(report, result, &diagnostics, start)
}

struct TestServer {
    url: String,
    work: tokio::task::JoinHandle<()>,
}

impl TestServer {
    async fn start(router: Router) -> Self {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let work = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        Self { url, work }
    }

    fn definition(&self) -> McpDefinition {
        McpDefinition::Http {
            url: format!("{}/mcp", self.url),
            headers: BTreeMap::new(),
        }
    }

    async fn probe(&self) -> McpProbeResult {
        run_probe(self.definition(), AgentEnv::default(), 2_000).await
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.work.abort();
    }
}

fn server_info(request: &Value) -> Value {
    assert_eq!(request["params"]["protocolVersion"], "2025-03-26");
    assert_eq!(request["params"]["capabilities"], json!({}));
    assert_eq!(request["params"]["clientInfo"]["name"], "codeg-probe");
    json!({"protocolVersion": "2025-03-26", "serverInfo": {"name": "test-server", "version": "1.0"}})
}

fn response(id: &Value, result: Value) -> Value {
    json!({"jsonrpc":"2.0", "id":id, "result": result})
}

#[tokio::test]
async fn streamable_http_tracks_session_and_counts_paginated_tools() {
    async fn handler(headers: HeaderMap, Json(request): Json<Value>) -> Response {
        assert_eq!(headers["accept"], "application/json, text/event-stream");
        assert_eq!(headers["content-type"], "application/json");
        let id = &request["id"];
        let method = request["method"].as_str().unwrap();
        if method == "initialize" {
            assert!(headers.get("mcp-session-id").is_none());
            let body = response(id, server_info(&request));
            let sse = format!(": ping\r\nevent: message\r\ndata: {body}\r\n\r\n");
            return (
                [
                    ("content-type", "text/event-stream; charset=utf-8"),
                    ("mcp-session-id", "session-a"),
                ],
                sse,
            )
                .into_response();
        }
        assert_eq!(headers["mcp-session-id"], "session-a");
        assert_eq!(headers["mcp-protocol-version"], "2025-03-26");
        match method {
            "notifications/initialized" => {
                assert!(id.is_null());
                StatusCode::ACCEPTED.into_response()
            }
            "tools/list" if id == &json!(2) => {
                let tools: Vec<_> = (0..200)
                    .map(|i| json!({"name": format!("tool-{i}"), "description": "界".repeat(300)}))
                    .collect();
                Json(response(id, json!({"tools": tools, "nextCursor":"more"}))).into_response()
            }
            "tools/list" => {
                assert_eq!(id, &json!(3));
                assert_eq!(request["params"]["cursor"], "more");
                Json(response(id, json!({"tools": [{"name":"last"}]}))).into_response()
            }
            other => panic!("unexpected method {other}"),
        }
    }
    let server = TestServer::start(Router::new().route("/mcp", post(handler))).await;
    let report = server.probe().await;
    assert_eq!(report.status, McpProbeStatus::Ok, "{report:?}");
    assert_eq!(report.http_status, Some(200));
    assert_eq!(report.tools_count, 201);
    assert_eq!(report.tools.len(), 200);
    assert_eq!(
        report.tools[0]
            .description
            .as_ref()
            .unwrap()
            .chars()
            .count(),
        256
    );
    assert_eq!(report.server_info.unwrap().name, "test-server");
}

#[tokio::test]
async fn gives_oauth_resource_metadata_on_401_and_distinguishes_403() {
    let server = TestServer::start(Router::new().route("/mcp", post(|| async {
        (StatusCode::UNAUTHORIZED, [("www-authenticate", "Basic realm=\"x,y\", Bearer realm=\"sample\", resource_metadata=\"https://mcp.example/.well-known/oauth-protected-resource\"")])
    }))).await;
    let report = server.probe().await;
    assert_eq!(report.status, McpProbeStatus::AuthRequired);
    assert_eq!(report.http_status, Some(401));
    let hint = report.auth_hint.unwrap();
    assert_eq!(hint.scheme.as_deref(), Some("Bearer"));
    assert_eq!(
        hint.resource_metadata.as_deref(),
        Some("https://mcp.example/.well-known/oauth-protected-resource")
    );

    let server =
        TestServer::start(Router::new().route("/mcp", post(|| async { StatusCode::FORBIDDEN })))
            .await;
    let report = server.probe().await;
    assert_eq!(report.status, McpProbeStatus::Forbidden);
    assert_eq!(report.http_status, Some(403));
}

#[tokio::test]
async fn reports_a_changed_session_id_without_returning_ids() {
    let server = TestServer::start(Router::new().route(
        "/mcp",
        post(|Json(request): Json<Value>| async move {
            if request["method"] == "initialize" {
                (
                    [("mcp-session-id", "first-private-id")],
                    Json(response(&request["id"], server_info(&request))),
                )
                    .into_response()
            } else {
                (
                    StatusCode::ACCEPTED,
                    [("mcp-session-id", "changed-private-id")],
                )
                    .into_response()
            }
        }),
    ))
    .await;
    let report = server.probe().await;
    assert_eq!(report.status, McpProbeStatus::SessionIdMismatch);
    assert_eq!(report.http_status, Some(202));
    assert!(!serde_json::to_string(&report)
        .unwrap()
        .contains("private-id"));
}

#[tokio::test]
async fn legacy_sse_posts_to_the_endpoint_and_reads_frames_on_the_get() {
    let (events, stream) = mpsc::channel::<String>(8);
    let stream = Arc::new(tokio::sync::Mutex::new(Some(stream)));
    let server = TestServer::start(Router::new().route("/events", get(move |headers: HeaderMap| {
        let stream = Arc::clone(&stream);
        async move {
            assert_eq!(headers["accept"], "text/event-stream");
            let receiver = stream.lock().await.take().unwrap();
            let body = futures_util::stream::unfold((true, receiver), |(first, mut receiver)| async move {
                let chunk = if first { "event: endpoint\ndata: /send?session=test\n\n".to_string() }
                    else { receiver.recv().await? };
                Some((Ok::<_, std::convert::Infallible>(chunk), (false, receiver)))
            });
            ([("content-type", "text/event-stream")], Body::from_stream(body))
        }
    })).route("/send", post(|State(events): State<mpsc::Sender<String>>, Json(request): Json<Value>| async move {
        let payload = match request["method"].as_str().unwrap() {
            "initialize" => server_info(&request),
            "notifications/initialized" => return StatusCode::ACCEPTED,
            "tools/list" => json!({"tools": [{"name":"legacy-tool"}]}),
            other => panic!("unexpected method {other}"),
        };
        events.send(format!("event: message\ndata: {}\n\n", response(&request["id"], payload))).await.unwrap();
        StatusCode::ACCEPTED
    })).with_state(events)).await;
    let definition = McpDefinition::Sse {
        url: format!("{}/events", server.url),
        headers: BTreeMap::new(),
    };
    let report = run_probe(definition, AgentEnv::default(), 2_000).await;
    assert_eq!(report.status, McpProbeStatus::Ok, "{report:?}");
    assert_eq!(report.tools_count, 1);
    assert_eq!(report.tools[0].name, "legacy-tool");
}

#[tokio::test]
async fn cross_origin_sse_endpoint_and_http_redirect_are_not_followed() {
    let router = Router::new()
        .route(
            "/events",
            get(|| async {
                (
                    [("content-type", "text/event-stream")],
                    "event: endpoint\ndata: http://127.0.0.1:1/send\n\n",
                )
            }),
        )
        .route(
            "/mcp",
            post(|| async {
                (
                    StatusCode::TEMPORARY_REDIRECT,
                    [("location", "http://127.0.0.1:1/elsewhere")],
                )
            }),
        );
    let server = TestServer::start(router).await;
    let definition = McpDefinition::Sse {
        url: format!("{}/events", server.url),
        headers: BTreeMap::from([("Authorization".into(), "Bearer configured-token".into())]),
    };
    let report = run_probe(definition, AgentEnv::default(), 2_000).await;
    assert_eq!(report.status, McpProbeStatus::ProtocolError);
    assert_eq!(server.probe().await.http_status, Some(307));
}

#[tokio::test]
async fn http_timeout_bounds_the_entire_handshake() {
    let server = TestServer::start(Router::new().route(
        "/mcp",
        post(|| async { std::future::pending::<StatusCode>().await }),
    ))
    .await;
    let report = run_probe(server.definition(), AgentEnv::default(), 50).await;
    assert_eq!(report.status, McpProbeStatus::Timeout);
}

#[tokio::test]
async fn does_not_return_reflected_request_credentials() {
    let server = TestServer::start(Router::new().route("/mcp", post(|headers: HeaderMap, Json(request): Json<Value>| async move {
        assert_eq!(headers["authorization"], "Bearer test-access-token");
        assert_eq!(headers["cookie"], "x=test-cookie; y=other-cookie");
        assert_eq!(headers["x-api-key"], "test-api-key");
        match request["method"].as_str().unwrap() {
            "initialize" => Json(response(&request["id"], json!({"protocolVersion":"2025-03-26","serverInfo":{"name":"real-server with test-access-token", "version":"test-api-key"}}))).into_response(),
            "tools/list" => Json(response(&request["id"], json!({"tools":[{"name":"test-cookie", "description":"Authorization: Bearer test-access-token\n\u{0}Cookie: x=test-cookie; y=other-cookie"}]}))).into_response(),
            _ => StatusCode::ACCEPTED.into_response(),
        }
    }))).await;
    let McpDefinition::Http { url, .. } = server.definition() else {
        unreachable!()
    };
    let report = run_probe(
        McpDefinition::Http {
            url,
            headers: BTreeMap::from([
                ("Authorization".into(), "Bearer test-access-token".into()),
                ("Cookie".into(), "x=test-cookie; y=other-cookie".into()),
                ("X-Api-Key".into(), "test-api-key".into()),
            ]),
        },
        AgentEnv::default(),
        2_000,
    )
    .await;
    assert_eq!(report.status, McpProbeStatus::Ok, "{report:?}");
    let public = serde_json::to_string(&report).unwrap();
    for secret in [
        "test-access-token",
        "test-cookie",
        "other-cookie",
        "test-api-key",
    ] {
        assert!(!public.contains(secret));
    }
}

#[cfg(unix)]
fn shell(script: &str, env: BTreeMap<String, String>) -> McpDefinition {
    McpDefinition::Stdio {
        command: "/bin/sh".into(),
        args: vec!["-c".into(), script.into()],
        env,
    }
}

#[cfg(unix)]
#[tokio::test]
async fn stdio_exchanges_three_messages_in_the_selected_environment() {
    let definition = shell(
        r#"
        IFS= read -r init || exit 2
        case "$init" in *'"id":1'*'"method":"initialize"'*) ;; *) exit 3 ;; esac
        printf 'the environment contains %s\n' "$PRIVATE_TOKEN" >&2
        printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26","serverInfo":{"name":"test-stdio"}}}'
        IFS= read -r initialized || exit 4
        case "$initialized" in *'"method":"notifications/initialized"'*) ;; *) exit 5 ;; esac
        IFS= read -r list || exit 6
        case "$list" in *'"id":2'*'"method":"tools/list"'*) ;; *) exit 7 ;; esac
        [ "$PRIVATE_TOKEN" = "definition-only-secret" ] && [ "$AGENT_OVERRIDE" = "agent-only-secret" ] || exit 8
        printf '{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"local-tool","description":"%s"}]}}\n' "$AGENT_OVERRIDE"
    "#,
        BTreeMap::from([("PRIVATE_TOKEN".into(), "definition-only-secret".into())]),
    );
    let env = AgentEnv::with_overrides(&[
        ("PRIVATE_TOKEN", "overridden-secret"),
        ("AGENT_OVERRIDE", "agent-only-secret"),
    ]);
    let report = run_probe(definition, env, 2_000).await;
    assert_eq!(report.status, McpProbeStatus::Ok, "{report:?}");
    assert_eq!(report.tools[0].name, "local-tool");
    assert!(report
        .stderr_tail
        .as_ref()
        .unwrap()
        .contains("the environment contains"));
    let public = serde_json::to_string(&report).unwrap();
    assert!(!public.contains("-secret"));
}

#[tokio::test]
async fn stdio_reports_spawn_failure_without_command_or_args() {
    let definition = McpDefinition::Stdio {
        command: "/nonexistent/mcp-private-binary".into(),
        args: vec!["credential".into()],
        env: BTreeMap::new(),
    };
    let report = run_probe(definition, AgentEnv::default(), 2_000).await;
    assert_eq!(report.status, McpProbeStatus::SpawnFailed);
    assert!(!serde_json::to_string(&report)
        .unwrap()
        .contains("mcp-private-binary"));
}

#[cfg(unix)]
#[tokio::test]
async fn stdio_timeout_keeps_only_sanitized_stderr() {
    let definition = shell(
        r#"printf 'starting %s\n' "$ACCESS_TOKEN" >&2; sleep 30"#,
        BTreeMap::from([("ACCESS_TOKEN".into(), "unprintable-token".into())]),
    );
    let report = run_probe(definition, AgentEnv::default(), 200).await;
    assert_eq!(report.status, McpProbeStatus::Timeout, "{report:?}");
    assert!(report.stderr_tail.as_ref().unwrap().starts_with("starting"));
    assert!(!serde_json::to_string(&report)
        .unwrap()
        .contains("unprintable-token"));
}

#[tokio::test]
async fn malformed_request_returns_the_config_error_wire_shape() {
    let db = crate::db::test_helpers::fresh_in_memory_db().await;
    let report = mcp_probe_core(
        &db,
        serde_json::from_value(json!({"timeout_ms": 1})).unwrap(),
    )
    .await;
    assert_eq!(report.status, McpProbeStatus::ConfigError);
    let report = serde_json::to_value(report).unwrap();
    assert_eq!(report["status"], "config_error");
    assert_eq!(report["tools"], json!([]));
    assert_eq!(report["tools_count"], 0);
    assert!(chrono::DateTime::parse_from_rfc3339(report["checked_at"].as_str().unwrap()).is_ok());
}

#[test]
fn a_saved_probe_prefers_the_native_definition_and_falls_back_to_paused() {
    use super::super::agents::AgentPaths;

    let dir = tempfile::tempdir().unwrap();
    let native = dir.path().join("mcp.json");
    let paused_path = dir.path().join("mcp-paused.json");
    let app = McpAppType::Cursor;
    let ctx = EngineCtx {
        paths: BTreeMap::from([(
            app,
            AgentPaths {
                servers: native.clone(),
                plugin_gate: None,
            },
        )]),
        paused_path: paused_path.clone(),
        lock_path: dir.path().join("mcp.lock"),
        backup_root: dir.path().join("backups"),
        lock_wait: Duration::ZERO,
    };
    let paused = json!({"type":"stdio", "command":"paused-example", "env":{"TOKEN":"fixture"}});
    let content = json!({"version":1,"entries":{"cursor":{"candidate":{"definition":paused,"paused_at":"2026-11-26T00:00:00Z"}}}});
    std::fs::write(paused_path, content.to_string()).unwrap();
    let load = || {
        stored_definition(&ctx, app, "candidate", &AgentEnv::default())
            .unwrap()
            .to_canonical_json()
    };
    assert_eq!(load(), paused);
    std::fs::write(
        native,
        r#"{"mcpServers":{"candidate":{"command":"live-example"}}}"#,
    )
    .unwrap();
    assert_eq!(load(), json!({"type":"stdio", "command":"live-example"}));
}

#[tokio::test]
async fn a_saved_codex_probe_resolves_its_home_and_auth_from_agent_env() {
    use crate::models::AgentType;

    let db = crate::db::test_helpers::fresh_in_memory_db().await;
    let dir = tempfile::tempdir().unwrap();
    agent_setting_service::ensure_defaults(
        &db.conn,
        &[agent_setting_service::AgentDefaultInput {
            agent_type: AgentType::Codex,
            registry_id: "codex".to_string(),
            default_sort_order: 0,
        }],
    )
    .await
    .unwrap();
    agent_setting_service::update_preferences(
        &db.conn,
        AgentType::Codex,
        true,
        Some(
            json!({
                "CODEX_HOME": dir.path(),
                "MCP_TEST_BEARER": "host-only-credential",
            })
            .to_string(),
        ),
    )
    .await
    .unwrap();
    let server = TestServer::start(Router::new().route(
        "/mcp",
        post(|headers: HeaderMap| async move {
            assert_eq!(headers["authorization"], "Bearer host-only-credential");
            (
                StatusCode::UNAUTHORIZED,
                [(
                    "www-authenticate",
                    "Bearer resource_metadata=\"https://example.test/host-only-credential\"",
                )],
            )
        }),
    ))
    .await;
    std::fs::write(
        dir.path().join("config.toml"),
        format!(
            "[mcp_servers.saved]\nurl = {:?}\nbearer_token_env_var = \"MCP_TEST_BEARER\"\n",
            format!("{}/mcp", server.url),
        ),
    )
    .unwrap();
    let request = serde_json::from_value(json!({"agent":"codex","key":"saved"})).unwrap();
    let report = mcp_probe_core(&db, request).await;
    assert_eq!(report.status, McpProbeStatus::AuthRequired, "{report:?}");
    assert_eq!(report.auth_hint.as_ref().unwrap().resource_metadata, None);
    assert!(!serde_json::to_string(&report)
        .unwrap()
        .contains("host-only-credential"));
}
