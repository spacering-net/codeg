//! Outbound webhook delivery for the global chat-channel event feed.
//!
//! Webhooks are a channel-agnostic event sink: when an ACP event passes the
//! global event filter (and the bridged-permission suppression), the event
//! subscriber POSTs a structured JSON payload to every configured URL — in
//! addition to the IM channel fan-out. Unlike IM channels, webhooks are NOT
//! debounced and do NOT participate in the per-channel filter; an automation
//! consumer wants the complete event stream.
//!
//! Delivery is fire-and-forget (`tokio::spawn` per URL) so a slow or
//! unreachable endpoint never stalls the event subscriber loop.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::types::RichMessage;

/// One configured webhook sink. Persisted (as a JSON array) under the
/// `chat_event_webhooks` app-metadata key and mirrored on the frontend.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WebhookConfig {
    pub url: String,
    pub enabled: bool,
}

/// Parse the stored webhook config JSON and return the URLs of ENABLED entries
/// only — the set the event subscriber actually delivers to. Unparseable input
/// yields an empty list (treated as "no webhooks").
pub fn enabled_webhook_urls(json: &str) -> Vec<String> {
    serde_json::from_str::<Vec<WebhookConfig>>(json)
        .map(|list| {
            list.into_iter()
                .filter(|w| w.enabled)
                .map(|w| w.url)
                .collect()
        })
        .unwrap_or_default()
}

/// The conversation behind the connection an event came from, as far as the
/// global feed could resolve it. Every field is optional on the wire: a
/// connection that has not been bound to a conversation row yet (or whose row
/// is gone) still delivers, with these left `null`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SessionContext {
    pub conversation_id: Option<i32>,
    pub conversation_title: Option<String>,
    /// Stable agent id (`claude_code`, `codex`, a custom agent's id, ...).
    pub agent_type: Option<String>,
    /// The agent's display name (`Claude Code`, a custom agent's label, ...).
    pub agent_name: Option<String>,
    /// The assistant a delegated sub-session runs as, if it was started as one.
    pub assistant_name: Option<String>,
    /// Set for a delegation sub-session: the conversation that delegated it.
    /// `None` for a top-level session.
    pub parent: Option<ParentSession>,
}

/// The conversation a sub-session was delegated from (its direct parent; for
/// a nested sub-session that is itself a sub-session).
#[derive(Debug, Clone, PartialEq)]
pub struct ParentSession {
    pub conversation_id: i32,
    pub title: Option<String>,
}

/// Build the JSON body POSTed to each webhook for one event.
///
/// Pure (no I/O, no clock) so the wire contract is unit-testable. `title`,
/// `body` and the `fields` labels are localized per the chat message-language
/// setting (same text IM channels receive); `event`, `level`, `source`,
/// `agent_type` and `session_kind` are stable machine-readable values.
/// `session_kind` is `"sub_session"` for a delegation sub-session (then the
/// `parent_conversation_*` keys name the conversation that delegated it) and
/// `"session"` otherwise.
pub fn build_webhook_payload(
    event_type: &str,
    connection_id: &str,
    msg: &RichMessage,
    session: &SessionContext,
) -> serde_json::Value {
    let fields: Vec<serde_json::Value> = msg
        .fields
        .iter()
        .map(|(label, value)| serde_json::json!({ "label": label, "value": value }))
        .collect();
    let session_kind = if session.parent.is_some() {
        "sub_session"
    } else {
        "session"
    };

    serde_json::json!({
        "event": event_type,
        "level": msg.level,
        "title": msg.title,
        "body": msg.body,
        "fields": fields,
        "connection_id": connection_id,
        "conversation_id": session.conversation_id,
        "conversation_title": session.conversation_title,
        "agent_type": session.agent_type,
        "agent_name": session.agent_name,
        "assistant_name": session.assistant_name,
        "session_kind": session_kind,
        "parent_conversation_id": session.parent.as_ref().map(|p| p.conversation_id),
        "parent_conversation_title": session.parent.as_ref().and_then(|p| p.title.clone()),
        "source": "codeg",
    })
}

/// Build the shared reqwest client used for webhook delivery. Mirrors the
/// timeout posture of the IM backends (see `backends/telegram.rs`).
pub fn make_webhook_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap_or_default()
}

/// Fan the payload out to every URL on detached tasks. Returns immediately;
/// failures are logged, not surfaced (the event loop must not block on, or be
/// failed by, an unreachable consumer).
pub fn spawn_webhook_delivery(
    client: reqwest::Client,
    urls: Vec<String>,
    payload: serde_json::Value,
) {
    for url in urls {
        let client = client.clone();
        let payload = payload.clone();
        tokio::spawn(async move {
            if let Err(e) = post_one(&client, &url, &payload).await {
                // Redact: webhook URLs often carry secrets in the path/query.
                tracing::error!(
                    "[ChatChannel] webhook delivery to {} failed: {e}",
                    redact_url(&url)
                );
            }
        });
    }
}

/// Reduce a URL to `scheme://host[:port]` for logging, dropping the path,
/// query and any userinfo — webhook URLs frequently embed credentials there
/// (e.g. Slack/Discord tokens) which must not reach logs. Unparseable input
/// collapses to a non-revealing placeholder.
fn redact_url(url: &str) -> String {
    match reqwest::Url::parse(url) {
        Ok(u) => match (u.host_str(), u.port()) {
            (Some(host), Some(port)) => format!("{}://{host}:{port}", u.scheme()),
            (Some(host), None) => format!("{}://{host}", u.scheme()),
            (None, _) => "<webhook>".to_string(),
        },
        Err(_) => "<webhook>".to_string(),
    }
}

/// POST one payload to one URL, mapping transport errors and non-2xx
/// responses to a `String` for logging.
async fn post_one(
    client: &reqwest::Client,
    url: &str,
    payload: &serde_json::Value,
) -> Result<(), String> {
    let resp = client
        .post(url)
        .json(payload)
        .send()
        .await
        // `reqwest::Error`'s Display embeds the request URL ("... for url (...)"),
        // which would re-leak path/query secrets the explicit redaction strips.
        // `without_url()` removes it before stringifying.
        .map_err(|e| e.without_url().to_string())?;

    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_channel::types::MessageLevel;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn sample_msg() -> RichMessage {
        RichMessage {
            title: Some("Turn Complete".into()),
            body: "Claude Code finished its turn.".into(),
            fields: vec![("Stop Reason".into(), "End Turn".into())],
            level: MessageLevel::Info,
        }
    }

    #[test]
    fn payload_has_stable_envelope_and_localized_text() {
        let payload = build_webhook_payload(
            "turn_complete",
            "conn-abc",
            &sample_msg(),
            &SessionContext::default(),
        );
        assert_eq!(payload["event"], "turn_complete");
        assert_eq!(payload["level"], "info");
        assert_eq!(payload["title"], "Turn Complete");
        assert_eq!(payload["body"], "Claude Code finished its turn.");
        assert_eq!(payload["connection_id"], "conn-abc");
        assert_eq!(payload["source"], "codeg");
        assert_eq!(payload["fields"][0]["label"], "Stop Reason");
        assert_eq!(payload["fields"][0]["value"], "End Turn");
    }

    #[test]
    fn payload_without_a_resolved_conversation_is_a_session_with_null_context() {
        let payload = build_webhook_payload(
            "turn_complete",
            "conn-abc",
            &sample_msg(),
            &SessionContext::default(),
        );
        assert_eq!(payload["session_kind"], "session");
        for key in [
            "conversation_id",
            "conversation_title",
            "agent_type",
            "agent_name",
            "assistant_name",
            "parent_conversation_id",
            "parent_conversation_title",
        ] {
            assert!(payload[key].is_null(), "{key} should be null: {payload}");
        }
    }

    #[test]
    fn payload_carries_top_level_session_context() {
        let session = SessionContext {
            conversation_id: Some(7),
            conversation_title: Some("Fix the login flow".into()),
            agent_type: Some("claude_code".into()),
            agent_name: Some("Claude Code".into()),
            assistant_name: None,
            parent: None,
        };
        let payload = build_webhook_payload("turn_complete", "conn-abc", &sample_msg(), &session);
        assert_eq!(payload["conversation_id"], 7);
        assert_eq!(payload["conversation_title"], "Fix the login flow");
        assert_eq!(payload["agent_type"], "claude_code");
        assert_eq!(payload["agent_name"], "Claude Code");
        assert!(payload["assistant_name"].is_null());
        assert_eq!(payload["session_kind"], "session");
        assert!(payload["parent_conversation_id"].is_null());
        assert!(payload["parent_conversation_title"].is_null());
    }

    #[test]
    fn payload_marks_a_sub_session_and_names_its_parent() {
        let session = SessionContext {
            conversation_id: Some(9),
            conversation_title: Some("Review the patch".into()),
            agent_type: Some("codex".into()),
            agent_name: Some("Codex CLI".into()),
            assistant_name: Some("Reviewer".into()),
            parent: Some(ParentSession {
                conversation_id: 7,
                title: Some("Fix the login flow".into()),
            }),
        };
        let payload = build_webhook_payload("turn_complete", "conn-child", &sample_msg(), &session);
        assert_eq!(payload["session_kind"], "sub_session");
        assert_eq!(payload["conversation_id"], 9);
        assert_eq!(payload["assistant_name"], "Reviewer");
        assert_eq!(payload["parent_conversation_id"], 7);
        assert_eq!(payload["parent_conversation_title"], "Fix the login flow");
    }

    #[test]
    fn payload_level_tracks_message_level() {
        let err = RichMessage {
            title: Some("Agent Error".into()),
            body: "boom".into(),
            fields: vec![],
            level: MessageLevel::Error,
        };
        let payload = build_webhook_payload("error", "c", &err, &SessionContext::default());
        assert_eq!(payload["level"], "error");
        assert_eq!(payload["title"], "Agent Error");
        assert!(payload["fields"].as_array().unwrap().is_empty());
    }

    #[test]
    fn enabled_webhook_urls_keeps_only_enabled() {
        let json = r#"[
            {"url":"https://a.test/h","enabled":true},
            {"url":"https://b.test/h","enabled":false},
            {"url":"https://c.test/h","enabled":true}
        ]"#;
        assert_eq!(
            enabled_webhook_urls(json),
            vec![
                "https://a.test/h".to_string(),
                "https://c.test/h".to_string()
            ]
        );
        assert!(enabled_webhook_urls("not json").is_empty());
        assert!(enabled_webhook_urls("[]").is_empty());
    }

    #[test]
    fn redact_url_keeps_only_scheme_host_port() {
        assert_eq!(
            redact_url("https://hooks.slack.com/services/T000/B000/XXXXsecret"),
            "https://hooks.slack.com"
        );
        assert_eq!(
            redact_url("http://192.168.1.10:9000/in?token=abc"),
            "http://192.168.1.10:9000"
        );
        // userinfo and path/query are dropped, not surfaced
        assert_eq!(
            redact_url("https://user:pass@host.test/p?q=1"),
            "https://host.test"
        );
        assert_eq!(redact_url("not a url"), "<webhook>");
    }

    #[test]
    fn payload_title_null_when_absent() {
        let msg = RichMessage::info("just a body");
        let payload =
            build_webhook_payload("permission_request", "c", &msg, &SessionContext::default());
        assert!(payload["title"].is_null());
        assert_eq!(payload["event"], "permission_request");
    }

    /// Read a full HTTP/1.1 request (headers + Content-Length body) from a
    /// loopback connection, then write a minimal 200 so the client's
    /// `send().await` resolves. Returns the raw request text.
    async fn read_request_and_respond(mut stream: tokio::net::TcpStream) -> String {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 1024];
        loop {
            // Stop once headers are in and the declared body has arrived.
            if let Some(header_end) = find_header_end(&buf) {
                let len = content_length(&buf[..header_end]);
                if buf.len() >= header_end + len {
                    break;
                }
            }
            let n = stream.read(&mut chunk).await.unwrap_or(0);
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
        }
        let _ = stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
            .await;
        let _ = stream.flush().await;
        String::from_utf8_lossy(&buf).into_owned()
    }

    fn find_header_end(buf: &[u8]) -> Option<usize> {
        buf.windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 4)
    }

    fn content_length(headers: &[u8]) -> usize {
        let text = String::from_utf8_lossy(headers).to_lowercase();
        for line in text.lines() {
            if let Some(v) = line.strip_prefix("content-length:") {
                if let Ok(n) = v.trim().parse::<usize>() {
                    return n;
                }
            }
        }
        0
    }

    #[tokio::test]
    async fn post_one_sends_post_with_json_body() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            read_request_and_respond(stream).await
        });

        let client = make_webhook_client();
        let payload = build_webhook_payload(
            "turn_complete",
            "conn-1",
            &sample_msg(),
            &SessionContext::default(),
        );
        post_one(&client, &format!("http://{addr}/hook"), &payload)
            .await
            .expect("post should succeed");

        let request = server.await.unwrap();
        assert!(request.starts_with("POST /hook"), "got: {request}");
        assert!(
            request
                .to_lowercase()
                .contains("content-type: application/json"),
            "missing json content-type: {request}"
        );
        assert!(
            request.contains("\"event\":\"turn_complete\""),
            "got: {request}"
        );
        assert!(
            request.contains("\"connection_id\":\"conn-1\""),
            "got: {request}"
        );
    }

    #[tokio::test]
    async fn post_one_error_does_not_leak_url_secrets() {
        // Bind then drop to obtain a port nothing listens on → connection refused.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);

        let client = make_webhook_client();
        let payload = serde_json::json!({ "event": "error" });
        let url = format!("http://{addr}/services/T0/B0/SECRETPATH?token=SECRETQUERY");
        let err = post_one(&client, &url, &payload)
            .await
            .expect_err("connection should be refused");
        assert!(!err.contains("SECRETPATH"), "leaked path secret: {err}");
        assert!(!err.contains("SECRETQUERY"), "leaked query secret: {err}");
    }

    #[tokio::test]
    async fn post_one_reports_non_2xx() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut chunk = [0u8; 1024];
            let _ = stream.read(&mut chunk).await;
            let _ = stream
                .write_all(b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\n\r\n")
                .await;
            let _ = stream.flush().await;
        });

        let client = make_webhook_client();
        let payload = serde_json::json!({ "event": "error" });
        let err = post_one(&client, &format!("http://{addr}/"), &payload)
            .await
            .expect_err("non-2xx should error");
        assert!(err.contains("500"), "got: {err}");
    }
}
