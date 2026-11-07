use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use prost::Message as ProstMessage;
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, Mutex, RwLock};
use tokio_tungstenite::tungstenite;

use crate::chat_channel::error::ChatChannelError;
use crate::chat_channel::traits::ChatChannelBackend;
use crate::chat_channel::types::*;

const FEISHU_BASE_URL: &str = "https://open.feishu.cn";
const TOKEN_REFRESH_MARGIN_SECS: u64 = 300;

// ── Lark WebSocket protobuf Frame (pbbp2) ──
// Source: larksuite/oapi-sdk-go ws/pbbp2.pb.go

const FRAME_METHOD_CONTROL: i32 = 0; // Ping/Pong
const FRAME_METHOD_DATA: i32 = 1; // Event/Card

#[derive(Clone, PartialEq, ProstMessage)]
struct Frame {
    #[prost(uint64, tag = 1)]
    seq_id: u64,
    #[prost(uint64, tag = 2)]
    log_id: u64,
    #[prost(int32, tag = 3)]
    service: i32,
    #[prost(int32, tag = 4)]
    method: i32,
    #[prost(message, repeated, tag = 5)]
    headers: Vec<FrameHeader>,
    #[prost(string, tag = 6)]
    payload_encoding: String,
    #[prost(string, tag = 7)]
    payload_type: String,
    #[prost(bytes = "vec", tag = 8)]
    payload: Vec<u8>,
    #[prost(string, tag = 9)]
    log_id_new: String,
}

#[derive(Clone, PartialEq, ProstMessage)]
struct FrameHeader {
    #[prost(string, tag = 1)]
    key: String,
    #[prost(string, tag = 2)]
    value: String,
}

impl Frame {
    fn get_header(&self, key: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|h| h.key == key)
            .map(|h| h.value.as_str())
    }

    fn set_header(&mut self, key: &str, value: &str) {
        if let Some(h) = self.headers.iter_mut().find(|h| h.key == key) {
            h.value = value.to_string();
        } else {
            self.headers.push(FrameHeader {
                key: key.to_string(),
                value: value.to_string(),
            });
        }
    }
}

// ── Lark REST API types ──

#[derive(Deserialize)]
struct TenantAccessTokenResponse {
    code: i32,
    msg: String,
    tenant_access_token: Option<String>,
    expire: Option<u64>,
}

#[derive(Serialize)]
struct SendMessageRequest {
    receive_id: String,
    msg_type: String,
    content: String,
}

#[derive(Deserialize)]
struct SendMessageResponse {
    code: i32,
    msg: String,
    data: Option<SendMessageData>,
}

#[derive(Deserialize)]
struct SendMessageData {
    message_id: Option<String>,
}

#[derive(Deserialize)]
struct WsConnectResponse {
    code: i32,
    msg: String,
    data: Option<WsConnectData>,
}

#[derive(Deserialize)]
struct WsConnectData {
    #[serde(rename = "URL")]
    url: Option<String>,
}

// ── Token cache ──

struct TokenCache {
    token: String,
    expires_at: Instant,
}

// ── Multi-part frame cache ──

struct PartialMessage {
    parts: HashMap<i32, Vec<u8>>,
    total: i32,
    created_at: Instant,
}

/// TTL for partial message reassembly entries. Prevents unbounded memory growth
/// if a multi-part message never completes (network issue, Lark SDK bug, etc).
const PARTIAL_MSG_TTL_SECS: u64 = 60;

// ── LarkBackend ──

pub struct LarkBackend {
    app_id: String,
    app_secret: String,
    chat_id: String,
    channel_id: i32,
    client: reqwest::Client,
    token_cache: Arc<RwLock<Option<TokenCache>>>,
    status: Arc<Mutex<ChannelConnectionStatus>>,
    shutdown_tx: Arc<Mutex<Option<tokio::sync::watch::Sender<bool>>>>,
}

impl LarkBackend {
    pub fn new(channel_id: i32, app_id: String, app_secret: String, chat_id: String) -> Self {
        Self {
            app_id,
            app_secret,
            chat_id,
            channel_id,
            client: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(30))
                .build()
                .unwrap_or_default(),
            token_cache: Arc::new(RwLock::new(None)),
            status: Arc::new(Mutex::new(ChannelConnectionStatus::Disconnected)),
            shutdown_tx: Arc::new(Mutex::new(None)),
        }
    }

    async fn get_tenant_access_token(&self) -> Result<String, ChatChannelError> {
        {
            let cache = self.token_cache.read().await;
            if let Some(cached) = cache.as_ref() {
                if cached.expires_at > Instant::now() {
                    return Ok(cached.token.clone());
                }
            }
        }

        let resp = self
            .client
            .post(format!(
                "{}/open-apis/auth/v3/tenant_access_token/internal",
                FEISHU_BASE_URL
            ))
            .json(&serde_json::json!({
                "app_id": self.app_id,
                "app_secret": self.app_secret,
            }))
            .send()
            .await
            .map_err(|e| ChatChannelError::AuthenticationFailed(e.to_string()))?;

        let result: TenantAccessTokenResponse = resp
            .json()
            .await
            .map_err(|e| ChatChannelError::AuthenticationFailed(e.to_string()))?;

        if result.code != 0 {
            return Err(ChatChannelError::AuthenticationFailed(format!(
                "code={}, msg={}",
                result.code, result.msg
            )));
        }

        let token = result
            .tenant_access_token
            .ok_or_else(|| ChatChannelError::AuthenticationFailed("No token in response".into()))?;
        let expire_secs = result.expire.unwrap_or(7200);

        let expires_at = Instant::now()
            + Duration::from_secs(expire_secs.saturating_sub(TOKEN_REFRESH_MARGIN_SECS));
        *self.token_cache.write().await = Some(TokenCache {
            token: token.clone(),
            expires_at,
        });

        Ok(token)
    }

    async fn send_lark_message(
        &self,
        msg_type: &str,
        content: &str,
    ) -> Result<SendOutcome, ChatChannelError> {
        let token = self.get_tenant_access_token().await?;

        let resp = self
            .client
            .post(format!(
                "{}/open-apis/im/v1/messages?receive_id_type=chat_id",
                FEISHU_BASE_URL
            ))
            .header("Authorization", format!("Bearer {}", token))
            .json(&SendMessageRequest {
                receive_id: self.chat_id.clone(),
                msg_type: msg_type.to_string(),
                content: content.to_string(),
            })
            .send()
            .await
            .map_err(|e| ChatChannelError::SendFailed(e.to_string()))?;

        let result: SendMessageResponse = resp
            .json()
            .await
            .map_err(|e| ChatChannelError::SendFailed(e.to_string()))?;

        if result.code != 0 {
            return Err(ChatChannelError::SendFailed(format!(
                "code={}, msg={}",
                result.code, result.msg
            )));
        }

        let message_id = result.data.and_then(|d| d.message_id).unwrap_or_default();
        Ok(SendOutcome::Sent(SentMessageId(message_id)))
    }

    async fn start_ws_receiver(
        &self,
        command_tx: mpsc::Sender<IncomingCommand>,
    ) -> Result<(), ChatChannelError> {
        // Verify we can get a WS URL before spawning the background task
        let _ = fetch_ws_url(&self.client, &self.app_id, &self.app_secret).await?;

        let (shutdown_tx, mut shutdown_rx) = tokio::sync::watch::channel(false);
        *self.shutdown_tx.lock().await = Some(shutdown_tx);

        let channel_id = self.channel_id;
        let status = self.status.clone();
        let app_id = self.app_id.clone();
        let app_secret = self.app_secret.clone();
        let client = self.client.clone();

        tokio::spawn(async move {
            let mut retry_count = 0u32;

            loop {
                if *shutdown_rx.borrow() {
                    break;
                }

                let ws_url = match fetch_ws_url(&client, &app_id, &app_secret).await {
                    Ok(url) => url,
                    Err(e) => {
                        tracing::error!("[Lark] failed to get WS endpoint: {e}");
                        *status.lock().await = ChannelConnectionStatus::Error;
                        let delay = Duration::from_secs((2u64).pow(retry_count.min(5)));
                        retry_count += 1;
                        tokio::select! {
                            _ = tokio::time::sleep(delay) => continue,
                            _ = shutdown_rx.changed() => break,
                        }
                    }
                };

                let ws_result = tokio_tungstenite::connect_async(&ws_url).await;
                let ws_stream = match ws_result {
                    Ok((stream, _)) => {
                        *status.lock().await = ChannelConnectionStatus::Connected;
                        retry_count = 0;
                        tracing::info!("[Lark] WebSocket connected");
                        stream
                    }
                    Err(e) => {
                        tracing::error!("[Lark] WebSocket connect failed: {e}");
                        *status.lock().await = ChannelConnectionStatus::Error;
                        let delay = Duration::from_secs((2u64).pow(retry_count.min(5)));
                        retry_count += 1;
                        tokio::select! {
                            _ = tokio::time::sleep(delay) => continue,
                            _ = shutdown_rx.changed() => break,
                        }
                    }
                };

                let (mut write, mut read) = ws_stream.split();
                let mut partial_msgs: HashMap<String, PartialMessage> = HashMap::new();
                let mut last_partial_cleanup = Instant::now();

                loop {
                    tokio::select! {
                        msg = read.next() => {
                            match msg {
                                Some(Ok(tungstenite::Message::Binary(data))) => {
                                    match Frame::decode(data.as_ref()) {
                                        Ok(frame) => {
                                            let frame_type = frame.get_header("type").unwrap_or("").to_string();

                                            if frame.method == FRAME_METHOD_CONTROL {
                                                // Control frame: ping → respond with pong
                                                if frame_type == "ping" {
                                                    let mut pong = frame.clone();
                                                    // Clear type header and set to pong
                                                    pong.set_header("type", "pong");
                                                    pong.payload = Vec::new();
                                                    let mut buf = Vec::new();
                                                    if pong.encode(&mut buf).is_ok() {
                                                        let _ = write.send(tungstenite::Message::Binary(buf.into())).await;
                                                    }
                                                }
                                            } else if frame.method == FRAME_METHOD_DATA && frame_type == "event" {
                                                let start = Instant::now();

                                                // Multi-part reassembly
                                                let msg_id = frame.get_header("message_id").unwrap_or("").to_string();
                                                let sum: i32 = frame.get_header("sum").and_then(|s| s.parse().ok()).unwrap_or(1);
                                                let seq: i32 = frame.get_header("seq").and_then(|s| s.parse().ok()).unwrap_or(0);

                                                // Evict stale partial messages to prevent unbounded memory growth
                                if last_partial_cleanup.elapsed() > Duration::from_secs(PARTIAL_MSG_TTL_SECS) {
                                    partial_msgs.retain(|_, pm| pm.created_at.elapsed() < Duration::from_secs(PARTIAL_MSG_TTL_SECS));
                                    last_partial_cleanup = Instant::now();
                                }

                                let full_payload = if sum <= 1 {
                                                    Some(frame.payload.clone())
                                                } else {
                                                    let entry = partial_msgs.entry(msg_id.clone()).or_insert_with(|| PartialMessage {
                                                        parts: HashMap::new(),
                                                        total: sum,
                                                        created_at: Instant::now(),
                                                    });
                                                    entry.parts.insert(seq, frame.payload.clone());
                                                    if entry.parts.len() as i32 >= entry.total {
                                                        // All parts received — reassemble in order
                                                        let mut combined = Vec::new();
                                                        for i in 0..entry.total {
                                                            if let Some(part) = entry.parts.get(&i) {
                                                                combined.extend_from_slice(part);
                                                            }
                                                        }
                                                        partial_msgs.remove(&msg_id);
                                                        Some(combined)
                                                    } else {
                                                        None // Still waiting for more parts
                                                    }
                                                };

                                                if let Some(payload_bytes) = full_payload {
                                                    // Process event
                                                    if let Ok(payload_str) = std::str::from_utf8(&payload_bytes) {
                                                        if let Ok(event) = serde_json::from_str::<serde_json::Value>(payload_str) {
                                                            handle_lark_event(&event, channel_id, &command_tx).await;
                                                        } else {
                                                            tracing::info!("[Lark] event payload is not valid JSON");
                                                        }
                                                    }

                                                    // Send acknowledgment: echo frame back with {"code":200}
                                                    let elapsed_ms = start.elapsed().as_millis();
                                                    let mut ack = frame.clone();
                                                    ack.payload = br#"{"code":200}"#.to_vec();
                                                    ack.set_header("biz_rt", &elapsed_ms.to_string());
                                                    let mut buf = Vec::new();
                                                    if ack.encode(&mut buf).is_ok() {
                                                        let _ = write.send(tungstenite::Message::Binary(buf.into())).await;
                                                    }
                                                }
                                            }
                                        }
                                        Err(e) => {
                                            tracing::error!("[Lark] protobuf decode error: {e}, len={}", data.len());
                                        }
                                    }
                                }
                                Some(Ok(tungstenite::Message::Ping(data))) => {
                                    let _ = write.send(tungstenite::Message::Pong(data)).await;
                                }
                                Some(Ok(tungstenite::Message::Close(_))) | None => {
                                    tracing::info!("[Lark] WebSocket closed, will reconnect");
                                    break;
                                }
                                Some(Err(e)) => {
                                    tracing::error!("[Lark] WebSocket error: {e}");
                                    break;
                                }
                                _ => {}
                            }
                        }
                        _ = shutdown_rx.changed() => {
                            let _ = write.close().await;
                            *status.lock().await = ChannelConnectionStatus::Disconnected;
                            return;
                        }
                    }
                }

                *status.lock().await = ChannelConnectionStatus::Connecting;
                let delay = Duration::from_secs(3);
                tokio::select! {
                    _ = tokio::time::sleep(delay) => {},
                    _ = shutdown_rx.changed() => break,
                }
            }

            *status.lock().await = ChannelConnectionStatus::Disconnected;
        });

        Ok(())
    }
}

async fn handle_lark_event(
    event: &serde_json::Value,
    channel_id: i32,
    command_tx: &mpsc::Sender<IncomingCommand>,
) {
    let event_type = event
        .pointer("/header/event_type")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if event_type == "im.message.receive_v1" {
        let msg_type = event
            .pointer("/event/message/message_type")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if msg_type != "text" {
            return;
        }

        // Group chat filtering: only process if bot is mentioned
        let chat_type = event
            .pointer("/event/message/chat_type")
            .and_then(|v| v.as_str())
            .unwrap_or("p2p");

        if chat_type == "group" {
            let mentions = event
                .pointer("/event/message/mentions")
                .and_then(|v| v.as_array());
            if mentions.is_none() || mentions.unwrap().is_empty() {
                return; // No mentions in group chat, ignore
            }
        }

        let content_str = event
            .pointer("/event/message/content")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        // Content is JSON string: {"text":"actual message"}
        let text = serde_json::from_str::<serde_json::Value>(content_str)
            .ok()
            .and_then(|v| v.get("text").and_then(|t| t.as_str()).map(String::from))
            .unwrap_or_default();

        if text.is_empty() {
            return;
        }

        // Strip mention placeholders (e.g. "@_user_1") from text
        let clean_text = strip_lark_mentions(&text, event);

        if clean_text.is_empty() {
            return;
        }

        let sender_id = event
            .pointer("/event/sender/sender_id/open_id")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();

        // Keep a safe breadcrumb (who sent it) at the default level; the message
        // body itself only logs at debug so it never lands on disk by default.
        tracing::info!("[Lark] incoming message from {sender_id}");
        tracing::debug!("[Lark] incoming message from {sender_id}: {clean_text}");

        let _ = command_tx
            .send(IncomingCommand {
                channel_id,
                sender_id,
                command_text: clean_text,
                callback_data: None,
                target: ChannelMessageTarget::channel(channel_id),
                metadata: event.clone(),
            })
            .await;
    }
}

/// Strip Lark mention placeholders (e.g. `@_user_1`) from the message text.
fn strip_lark_mentions(text: &str, event: &serde_json::Value) -> String {
    let mut result = text.to_string();
    if let Some(mentions) = event
        .pointer("/event/message/mentions")
        .and_then(|v| v.as_array())
    {
        for mention in mentions {
            if let Some(key) = mention.get("key").and_then(|v| v.as_str()) {
                result = result.replace(key, "");
            }
        }
    }
    result.trim().to_string()
}

/// Fetch a fresh WebSocket endpoint URL from Feishu.
async fn fetch_ws_url(
    client: &reqwest::Client,
    app_id: &str,
    app_secret: &str,
) -> Result<String, ChatChannelError> {
    let resp = client
        .post(format!("{}/callback/ws/endpoint", FEISHU_BASE_URL))
        .json(&serde_json::json!({
            "AppID": app_id,
            "AppSecret": app_secret,
        }))
        .send()
        .await
        .map_err(|e| ChatChannelError::ConnectionFailed(e.to_string()))?;

    let ws_resp: WsConnectResponse = resp
        .json()
        .await
        .map_err(|e| ChatChannelError::ConnectionFailed(e.to_string()))?;

    if ws_resp.code != 0 {
        return Err(ChatChannelError::ConnectionFailed(format!(
            "WS connect failed: code={}, msg={}",
            ws_resp.code, ws_resp.msg
        )));
    }

    ws_resp
        .data
        .and_then(|d| d.url)
        .ok_or_else(|| ChatChannelError::ConnectionFailed("No WebSocket URL returned".into()))
}

#[async_trait]
impl ChatChannelBackend for LarkBackend {
    fn channel_type(&self) -> ChannelType {
        ChannelType::Lark
    }

    async fn start(
        &self,
        command_tx: mpsc::Sender<IncomingCommand>,
    ) -> Result<(), ChatChannelError> {
        *self.status.lock().await = ChannelConnectionStatus::Connecting;
        self.get_tenant_access_token().await?;
        *self.status.lock().await = ChannelConnectionStatus::Connected;

        if let Err(e) = self.start_ws_receiver(command_tx).await {
            tracing::error!("[Lark] WebSocket receiver failed to start: {e}");
        }

        Ok(())
    }

    async fn stop(&self) -> Result<(), ChatChannelError> {
        if let Some(tx) = self.shutdown_tx.lock().await.take() {
            let _ = tx.send(true);
        }
        *self.status.lock().await = ChannelConnectionStatus::Disconnected;
        Ok(())
    }

    async fn status(&self) -> ChannelConnectionStatus {
        *self.status.lock().await
    }

    async fn send_message(&self, text: &str) -> Result<SendOutcome, ChatChannelError> {
        let content = serde_json::json!({ "text": text }).to_string();
        self.send_lark_message("text", &content).await
    }

    async fn send_rich_message(
        &self,
        message: &RichMessage,
    ) -> Result<SendOutcome, ChatChannelError> {
        let card = build_lark_card(message);
        let content = serde_json::to_string(&card)
            .map_err(|e| ChatChannelError::SendFailed(e.to_string()))?;
        self.send_lark_message("interactive", &content).await
    }

    async fn test_connection(&self) -> Result<(), ChatChannelError> {
        self.get_tenant_access_token().await?;
        Ok(())
    }
}

fn build_lark_card(msg: &RichMessage) -> serde_json::Value {
    let header_color = match msg.level {
        MessageLevel::Info => "blue",
        MessageLevel::Warning => "orange",
        MessageLevel::Error => "red",
    };

    let title = msg.title.as_deref().unwrap_or("Codeg");

    let mut elements: Vec<serde_json::Value> = Vec::new();

    if !msg.body.is_empty() {
        // Render the body as PLAIN TEXT, never markdown. An event body can carry
        // user-authored content (e.g. `user_prompt_sent` forwards the prompt
        // text verbatim), and Lark's `markdown` element would interpret `<at>`
        // mentions, links, and formatting embedded in it. `plain_text`
        // neutralizes all of that; existing event bodies are plain sentences, so
        // their rendering is unchanged.
        elements.push(serde_json::json!({
            "tag": "div",
            "text": {
                "tag": "plain_text",
                "content": msg.body,
            },
        }));
    }

    if !msg.fields.is_empty() {
        // Render each field as PLAIN TEXT, never `lark_md`. A field VALUE can carry
        // untrusted content — `permission_request` puts the proposed tool operation
        // (e.g. a Bash command) here, and `error` puts the agent's error string —
        // which `lark_md` would interpret, letting embedded `<at>` mentions, links
        // and markdown inject into the card. The label is our own i18n constant, so
        // the only injectable part is the value; plain_text neutralizes both. We
        // drop the bold label styling (cosmetic) for safety, mirroring the body.
        let field_elements: Vec<serde_json::Value> = msg
            .fields
            .iter()
            .map(|(k, v)| {
                serde_json::json!({
                    "is_short": true,
                    "text": {
                        "tag": "plain_text",
                        "content": format!("{}\n{}", k, v),
                    }
                })
            })
            .collect();

        elements.push(serde_json::json!({
            "tag": "div",
            "fields": field_elements,
        }));
    }

    serde_json::json!({
        "config": { "wide_screen_mode": true },
        "header": {
            "title": {
                "tag": "plain_text",
                "content": title,
            },
            "template": header_color,
        },
        "elements": elements,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The card body must render as `plain_text`, never `markdown` — an event
    /// body can carry user-authored content (e.g. `user_prompt_sent`), and a
    /// markdown body would let `<at>` mentions / links / formatting inject into
    /// the Lark card. Guards against a regression back to the markdown element.
    #[test]
    fn body_renders_as_plain_text_not_markdown() {
        let raw = "<at id=all></at> **bold** [x](http://e.test)";
        let msg = RichMessage::info(raw).with_title("User Message");
        let card = build_lark_card(&msg);

        let elements = card["elements"].as_array().expect("elements array");
        let body = &elements[0];
        assert_eq!(body["tag"], "div", "body must be a div element");
        assert_eq!(
            body["text"]["tag"], "plain_text",
            "body text must be plain_text, not markdown"
        );
        // Content is preserved verbatim — there is no markdown element to
        // interpret the `<at>` / `**` / link syntax.
        assert_eq!(body["text"]["content"], raw);
        assert!(
            elements.iter().all(|e| e["tag"] != "markdown"),
            "no element may render the body as markdown"
        );
    }

    /// Field VALUES carry untrusted content (a permission tool command, an agent
    /// error string), so they must render as `plain_text` — never `lark_md`,
    /// which would interpret embedded `<at>` / links / markdown. Guards against a
    /// regression back to the lark_md field rendering.
    #[test]
    fn fields_render_as_plain_text_not_lark_md() {
        let injected = "Bash: echo [x](http://e.test) <at id=all></at> **b**";
        let msg = RichMessage {
            title: Some("Permission Request".into()),
            body: "An agent is waiting for approval.".into(),
            fields: vec![("Operation".into(), injected.into())],
            level: MessageLevel::Warning,
        };
        let card = build_lark_card(&msg);

        let elements = card["elements"].as_array().expect("elements array");
        let field_el = elements
            .iter()
            .find(|e| e.get("fields").is_some())
            .expect("a div element carrying fields");
        let fields = field_el["fields"].as_array().expect("fields array");
        assert_eq!(
            fields[0]["text"]["tag"], "plain_text",
            "field text must be plain_text, not lark_md"
        );
        // The injected value is preserved verbatim, with no markup interpretation.
        let content = fields[0]["text"]["content"].as_str().unwrap();
        assert!(content.contains(injected), "got {content:?}");
        assert!(
            elements
                .iter()
                .all(|e| e["text"]["tag"] != "lark_md" && e["tag"] != "lark_md"),
            "no element may render content as lark_md"
        );
    }
}
