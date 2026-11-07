use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use rand::Rng;
use reqwest::header::{HeaderMap, HeaderValue};
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, Mutex};

use crate::chat_channel::error::ChatChannelError;
use crate::chat_channel::traits::ChatChannelBackend;
use crate::chat_channel::types::*;

const ILINK_BASE_URL: &str = "https://ilinkai.weixin.qq.com";
const ILINK_CHANNEL_VERSION: &str = "1.0.2";
/// iLink reports a reply context it will not accept — typically a
/// `context_token` that expired after inactivity, or per-token quota exhaustion,
/// sometimes with `errmsg` "rate limited" or empty — as `ret = -2`.
const CONTEXT_REJECTED_RET: i64 = -2;
/// Maximum number of messages buffered while context_token is expired.
const MAX_PENDING_MESSAGES: usize = 50;
/// Buffered messages older than this are dropped instead of replayed. A push
/// nudge is only useful while it is fresh, and replaying a backlog would flood
/// the chat with hours-old notifications as soon as the user messages the bot.
const MAX_PENDING_AGE: Duration = Duration::from_secs(10 * 60);
/// Upper bound on messages replayed on a fresh context_token, protecting the
/// ~10-message quota per token from being consumed by backlogged notifications.
const MAX_REPLAY_MESSAGES: usize = 3;

/// Shared HTTP client for QR code auth requests (avoids re-creating TLS state).
fn qr_client() -> reqwest::Client {
    use std::sync::OnceLock;
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(15))
                .build()
                .unwrap_or_default()
        })
        .clone()
}

// ── QR code auth types (public, used by commands) ──

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeixinQrcodeInfo {
    pub qrcode_id: String,
    pub qrcode_img_content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeixinQrcodeStatus {
    pub status: String,
    /// bot_token and base_url are consumed by the _core command layer and
    /// stripped before the response reaches the frontend.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bot_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
}

/// Frontend-safe subset of [`WeixinQrcodeStatus`] — no credentials.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeixinQrcodeStatusPublic {
    pub status: String,
}

/// One `sendmessage` call. `context_token` may be empty: iLink accepts a
/// tokenless send as a degraded fallback (see `WeixinBackend::send_text`).
struct SendRequest<'a> {
    client: &'a reqwest::Client,
    base_url: &'a str,
    bot_token: &'a str,
    wechat_uin: &'a str,
    to_user_id: &'a str,
    context_token: &'a str,
    text: &'a str,
}

// ── QR code auth functions (called before backend exists) ──

pub async fn weixin_get_qrcode() -> Result<WeixinQrcodeInfo, ChatChannelError> {
    let client = qr_client();
    let resp = client
        .get(format!("{ILINK_BASE_URL}/ilink/bot/get_bot_qrcode"))
        .query(&[("bot_type", "3")])
        .send()
        .await
        .map_err(|e| ChatChannelError::ConnectionFailed(format!("QR code request failed: {e}")))?;

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| ChatChannelError::ConnectionFailed(format!("QR code parse failed: {e}")))?;

    let qrcode_id = body
        .get("qrcode")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let raw_img = body
        .get("qrcode_img_content")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    if qrcode_id.is_empty() {
        return Err(ChatChannelError::ConnectionFailed(
            "Empty qrcode in response".into(),
        ));
    }

    // If the image content is a URL, try to fetch the actual image bytes.
    // If the URL points to an HTML SPA (which renders the QR code via JS),
    // generate the QR code ourselves — the SPA simply encodes the page URL.
    let qrcode_img_content = if raw_img.starts_with("http://") || raw_img.starts_with("https://") {
        match fetch_image_as_data_uri(&client, &raw_img).await {
            Ok(data_uri) => data_uri,
            Err(_) => {
                tracing::info!("[Weixin] URL is an SPA page, generating QR code from URL");
                generate_qrcode_data_uri(&raw_img)?
            }
        }
    } else {
        raw_img
    };

    Ok(WeixinQrcodeInfo {
        qrcode_id,
        qrcode_img_content,
    })
}

/// Fetch an image from a URL and return it as a `data:<mime>;base64,...` string.
///
/// Returns an error if the URL points to an HTML page (SPA) rather than a
/// raw image — the caller will generate a QR code from the URL instead.
async fn fetch_image_as_data_uri(
    client: &reqwest::Client,
    url: &str,
) -> Result<String, ChatChannelError> {
    let resp = client
        .get(url)
        .header(
            reqwest::header::USER_AGENT,
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        )
        .header(reqwest::header::REFERER, ILINK_BASE_URL)
        .send()
        .await
        .map_err(|e| ChatChannelError::ConnectionFailed(format!("Image fetch failed: {e}")))?;

    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/png")
        .to_string();

    if content_type.contains("text/html") || content_type.contains("text/plain") {
        return Err(ChatChannelError::ConnectionFailed(
            "QR code URL is an SPA page".into(),
        ));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| ChatChannelError::ConnectionFailed(format!("Image read failed: {e}")))?;

    if bytes.is_empty() {
        return Err(ChatChannelError::ConnectionFailed(
            "Empty image response".into(),
        ));
    }
    let b64 = B64.encode(&bytes);
    let mime = content_type.split(';').next().unwrap_or("image/png").trim();
    Ok(format!("data:{mime};base64,{b64}"))
}

/// Generate a QR code image encoding the given text and return as a PNG data URI.
///
/// The iLink QR page is a SPA that renders `window.location.href` as a QR code.
/// We replicate that logic server-side so the frontend can display it directly.
fn generate_qrcode_data_uri(content: &str) -> Result<String, ChatChannelError> {
    use image::{codecs::png::PngEncoder, ImageEncoder, Luma};
    use qrcode::QrCode;

    let code = QrCode::new(content.as_bytes()).map_err(|e| {
        ChatChannelError::ConnectionFailed(format!("QR code generation failed: {e}"))
    })?;

    let img = code
        .render::<Luma<u8>>()
        .quiet_zone(true)
        .min_dimensions(250, 250)
        .build();
    let (w, h) = (img.width(), img.height());

    let mut png_buf: Vec<u8> = Vec::new();
    PngEncoder::new(&mut png_buf)
        .write_image(img.as_raw(), w, h, image::ExtendedColorType::L8)
        .map_err(|e| ChatChannelError::ConnectionFailed(format!("PNG encoding failed: {e}")))?;

    let b64 = B64.encode(&png_buf);
    Ok(format!("data:image/png;base64,{b64}"))
}

pub async fn weixin_check_qrcode(qrcode: &str) -> Result<WeixinQrcodeStatus, ChatChannelError> {
    let client = qr_client();
    let resp = client
        .get(format!("{ILINK_BASE_URL}/ilink/bot/get_qrcode_status"))
        .query(&[("qrcode", qrcode)])
        .send()
        .await
        .map_err(|e| {
            ChatChannelError::ConnectionFailed(format!("QR status request failed: {e}"))
        })?;

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| ChatChannelError::ConnectionFailed(format!("QR status parse failed: {e}")))?;

    let status = body
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("waiting")
        .to_string();

    let bot_token = body
        .get("bot_token")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let base_url = body
        .get("baseurl")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    Ok(WeixinQrcodeStatus {
        status,
        bot_token,
        base_url,
    })
}

// ── Backend implementation ──

struct WeixinReplyContext {
    to_user_id: String,
    context_token: String,
    expired: bool,
}

/// A message iLink would not accept yet, retried on the next context refresh.
#[derive(Clone, Debug)]
struct PendingMessage {
    text: String,
    queued_at: Instant,
}

/// Queue `msg` for the next `context_token` refresh, or drop it when the
/// buffer is already full.
async fn queue_pending(buf: &Mutex<Vec<PendingMessage>>, msg: PendingMessage) -> SendOutcome {
    let mut buf = buf.lock().await;
    if buf.len() < MAX_PENDING_MESSAGES {
        buf.push(msg);
        SendOutcome::Buffered
    } else {
        tracing::warn!("[Weixin] pending buffer full, dropping message");
        SendOutcome::Dropped
    }
}

pub struct WeixinBackend {
    bot_token: String,
    base_url: String,
    client: reqwest::Client,
    status: Arc<Mutex<ChannelConnectionStatus>>,
    channel_id: i32,
    shutdown_tx: Arc<Mutex<Option<tokio::sync::watch::Sender<bool>>>>,
    reply_context: Arc<Mutex<Option<WeixinReplyContext>>>,
    /// Messages iLink rejected because the reply context was stale. They are
    /// retried on the next context refresh, minus any that aged out while
    /// waiting (see `MAX_PENDING_AGE`).
    pending_messages: Arc<Mutex<Vec<PendingMessage>>>,
    /// Stable X-WECHAT-UIN value for this backend instance.
    wechat_uin: String,
}

impl WeixinBackend {
    pub fn new(channel_id: i32, bot_token: String, base_url: String) -> Self {
        let uin_raw = rand::thread_rng().gen::<u32>().to_string();
        let wechat_uin = B64.encode(uin_raw.as_bytes());

        Self {
            bot_token,
            base_url,
            client: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(45))
                .build()
                .unwrap_or_default(),
            status: Arc::new(Mutex::new(ChannelConnectionStatus::Disconnected)),
            channel_id,
            shutdown_tx: Arc::new(Mutex::new(None)),
            reply_context: Arc::new(Mutex::new(None)),
            pending_messages: Arc::new(Mutex::new(Vec::new())),
            wechat_uin,
        }
    }

    fn build_headers(bot_token: &str, wechat_uin: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("Content-Type", HeaderValue::from_static("application/json"));
        headers.insert(
            "AuthorizationType",
            HeaderValue::from_static("ilink_bot_token"),
        );

        if let Ok(val) = HeaderValue::from_str(wechat_uin) {
            headers.insert("X-WECHAT-UIN", val);
        }

        let bearer = format!("Bearer {bot_token}");
        if let Ok(val) = HeaderValue::from_str(&bearer) {
            headers.insert("Authorization", val);
        }

        headers
    }

    /// Build the JSON body for the iLink sendmessage API.
    fn build_send_body(
        to_user_id: &str,
        context_token: &str,
        client_id: &str,
        text: &str,
    ) -> serde_json::Value {
        serde_json::json!({
            "msg": {
                "from_user_id": "",
                "to_user_id": to_user_id,
                "client_id": client_id,
                "message_type": 2,
                "message_state": 2,
                "context_token": context_token,
                "item_list": [{
                    "type": 1,
                    "text_item": { "text": text }
                }]
            },
            "base_info": { "channel_version": ILINK_CHANNEL_VERSION }
        })
    }

    /// One `sendmessage` call.
    ///
    /// Returns `Ok(Some(client_id))` when iLink accepted the message, or
    /// `Ok(None)` when it rejected the reply context (see
    /// `CONTEXT_REJECTED_RET`).
    async fn do_send(req: SendRequest<'_>) -> Result<Option<String>, ChatChannelError> {
        let client_id = format!("codeg-{}", uuid::Uuid::new_v4());
        let body = Self::build_send_body(req.to_user_id, req.context_token, &client_id, req.text);
        let url = format!("{}/ilink/bot/sendmessage", req.base_url);

        let resp = req
            .client
            .post(&url)
            .headers(Self::build_headers(req.bot_token, req.wechat_uin))
            .json(&body)
            .send()
            .await
            .map_err(|e| ChatChannelError::SendFailed(e.to_string()))?;

        let status_code = resp.status();
        let resp_text = resp.text().await.unwrap_or_default();

        if !status_code.is_success() {
            return Err(ChatChannelError::SendFailed(format!(
                "HTTP {status_code}: {resp_text}"
            )));
        }

        // A stale reply context or quota limit comes back as a non-zero `ret`
        // even though the HTTP call succeeded, so inspect the body before calling it delivered.
        if let Ok(resp_json) = serde_json::from_str::<serde_json::Value>(&resp_text) {
            if let Some(ret) = resp_json.get("ret").and_then(|v| v.as_i64()) {
                if ret != 0 {
                    let errmsg = resp_json
                        .get("errmsg")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown");
                    tracing::info!("[Weixin] sendmessage ret={ret}, errmsg={errmsg}");

                    if ret == CONTEXT_REJECTED_RET {
                        return Ok(None);
                    }

                    return Err(ChatChannelError::SendFailed(format!("ret={ret}: {errmsg}")));
                }
            }
        }

        Ok(Some(client_id))
    }

    async fn send_text(&self, text: &str) -> Result<SendOutcome, ChatChannelError> {
        // Extract context data under lock, then release
        let (to_user_id, context_token, expired) = {
            let guard = self.reply_context.lock().await;
            let ctx = guard.as_ref().ok_or_else(|| {
                ChatChannelError::SendFailed(
                    "No active WeChat conversation context. A user must message the bot first."
                        .into(),
                )
            })?;
            (
                ctx.to_user_id.clone(),
                ctx.context_token.clone(),
                ctx.expired,
            )
        };

        // If context is already expired, buffer immediately without network calls.
        // This avoids blocking other channels behind network timeouts while context is stale.
        if expired {
            tracing::info!(
                "[Weixin] context expired, buffering message immediately (len={})",
                text.len()
            );
            return Ok(queue_pending(
                &self.pending_messages,
                PendingMessage {
                    text: text.to_string(),
                    queued_at: Instant::now(),
                },
            )
            .await);
        }

        tracing::info!(
            "[Weixin] sendmessage to={to_user_id}, context_token_len={}, text_len={}",
            context_token.len(),
            text.len()
        );

        let delivered = Self::do_send(SendRequest {
            client: &self.client,
            base_url: &self.base_url,
            bot_token: &self.bot_token,
            wechat_uin: &self.wechat_uin,
            to_user_id: &to_user_id,
            context_token: &context_token,
            text,
        })
        .await?;

        match delivered {
            Some(client_id) => Ok(SendOutcome::Sent(SentMessageId(client_id))),
            None => {
                // Reply context rejected (ret = -2). Remember it is stale so later
                // sends buffer immediately, and queue this message.
                if let Some(ref mut c) = *self.reply_context.lock().await {
                    c.expired = true;
                }
                tracing::info!(
                    "[Weixin] context_token rejected (ret={CONTEXT_REJECTED_RET}), buffering message (len={})",
                    text.len()
                );
                Ok(queue_pending(
                    &self.pending_messages,
                    PendingMessage {
                        text: text.to_string(),
                        queued_at: Instant::now(),
                    },
                )
                .await)
            }
        }
    }
}

#[async_trait]
impl ChatChannelBackend for WeixinBackend {
    fn channel_type(&self) -> ChannelType {
        ChannelType::Weixin
    }

    async fn start(
        &self,
        command_tx: mpsc::Sender<IncomingCommand>,
    ) -> Result<(), ChatChannelError> {
        *self.status.lock().await = ChannelConnectionStatus::Connecting;

        tracing::info!(
            "[Weixin] start: base_url={}, token_len={}",
            self.base_url,
            self.bot_token.len()
        );

        // Verify auth by doing a quick getupdates with empty cursor
        let verify_body = serde_json::json!({
            "get_updates_buf": "",
            "base_info": { "channel_version": ILINK_CHANNEL_VERSION }
        });
        let url = format!("{}/ilink/bot/getupdates", self.base_url);
        tracing::info!("[Weixin] verify POST {url}");

        let resp = self
            .client
            .post(&url)
            .headers(Self::build_headers(&self.bot_token, &self.wechat_uin))
            .json(&verify_body)
            .send()
            .await
            .map_err(|e| ChatChannelError::ConnectionFailed(e.to_string()))?;

        let status_code = resp.status();
        let resp_text = resp
            .text()
            .await
            .map_err(|e| ChatChannelError::ConnectionFailed(e.to_string()))?;

        tracing::info!("[Weixin] verify response status={status_code}");
        tracing::debug!("[Weixin] verify response body={resp_text}");

        let verify_result: serde_json::Value = serde_json::from_str(&resp_text)
            .map_err(|e| ChatChannelError::ConnectionFailed(format!("JSON parse failed: {e}")))?;

        // iLink API auth failures come back as `{"errcode":-14,"errmsg":"session timeout"}`
        // (no `ret` field). Treat any non-zero errcode as authentication failure.
        if let Some(errcode) = verify_result.get("errcode").and_then(|v| v.as_i64()) {
            if errcode != 0 {
                let errmsg = verify_result
                    .get("errmsg")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown error");
                return Err(ChatChannelError::AuthenticationFailed(format!(
                    "Weixin verification failed (errcode={errcode}): {errmsg}"
                )));
            }
        }

        let ret = verify_result.get("ret").and_then(|v| v.as_i64());

        // Check for known auth-failure codes
        if ret == Some(-14) {
            return Err(ChatChannelError::AuthenticationFailed(
                "Session expired (ret=-14), please re-authenticate".into(),
            ));
        }

        // The iLink API may omit the `ret` field or return non-zero on the first
        // call. Always extract the cursor if present — it's needed for polling.
        let initial_cursor = verify_result
            .get("get_updates_buf")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        if let Some(r) = ret {
            if r != 0 {
                tracing::info!(
                    "[Weixin] verify returned ret={r}, but got cursor len={}",
                    initial_cursor.len()
                );
            }
        }

        *self.status.lock().await = ChannelConnectionStatus::Connected;

        // Start long-polling loop
        let (shutdown_tx, mut shutdown_rx) = tokio::sync::watch::channel(false);
        *self.shutdown_tx.lock().await = Some(shutdown_tx);

        let client = self.client.clone();
        let bot_token = self.bot_token.clone();
        let base_url = self.base_url.clone();
        let wechat_uin = self.wechat_uin.clone();
        let channel_id = self.channel_id;
        let status = self.status.clone();
        let reply_context = self.reply_context.clone();
        let pending_messages = self.pending_messages.clone();

        tokio::spawn(async move {
            let mut cursor = initial_cursor;
            let mut consecutive_errors: u32 = 0;

            loop {
                if *shutdown_rx.borrow() {
                    break;
                }

                let body = serde_json::json!({
                    "get_updates_buf": cursor,
                    "base_info": { "channel_version": ILINK_CHANNEL_VERSION }
                });

                let result = tokio::select! {
                    r = client
                        .post(format!("{base_url}/ilink/bot/getupdates"))
                        .headers(WeixinBackend::build_headers(&bot_token, &wechat_uin))
                        .json(&body)
                        .send() => r,
                    _ = shutdown_rx.changed() => break,
                };

                match result {
                    Ok(resp) => {
                        // Recover from error state after successful poll
                        consecutive_errors = 0;
                        {
                            let mut s = status.lock().await;
                            if *s == ChannelConnectionStatus::Error {
                                *s = ChannelConnectionStatus::Connected;
                            }
                        }

                        if let Ok(body) = resp.json::<serde_json::Value>().await {
                            let ret = body.get("ret").and_then(|v| v.as_i64());

                            // Always update cursor if present
                            if let Some(new_cursor) =
                                body.get("get_updates_buf").and_then(|v| v.as_str())
                            {
                                if !new_cursor.is_empty() {
                                    cursor = new_cursor.to_string();
                                }
                            }

                            // If ret is explicitly non-zero (not just missing), log it
                            if let Some(r) = ret {
                                if r != 0 {
                                    tracing::info!("[Weixin] getupdates ret={r}");
                                }
                                // Session expired — pause and wait for re-auth
                                if r == -14 {
                                    tracing::info!("[Weixin] session expired (ret=-14), pausing 30s");
                                    *status.lock().await = ChannelConnectionStatus::Error;
                                    tokio::time::sleep(Duration::from_secs(30)).await;
                                    continue;
                                }
                            }

                            // Process messages
                            if let Some(msgs) = body.get("msgs").and_then(|v| v.as_array()) {
                                if !msgs.is_empty() {
                                    tracing::info!("[Weixin] got {} message(s)", msgs.len());
                                }
                                for msg in msgs {
                                    // Only handle user messages (message_type=1),
                                    // skip bot echo (message_type=2)
                                    let msg_type = msg.get("message_type").and_then(|v| v.as_i64());
                                    if msg_type != Some(1) {
                                        continue;
                                    }

                                    // Extract text from type=1 (text) or type=3 (voice-to-text)
                                    let text = msg
                                        .get("item_list")
                                        .and_then(|v| v.as_array())
                                        .and_then(|items| {
                                            items.iter().find_map(|item| {
                                                let t =
                                                    item.get("type").and_then(|v| v.as_i64())?;
                                                match t {
                                                    1 => item
                                                        .pointer("/text_item/text")
                                                        .and_then(|v| v.as_str()),
                                                    3 => item
                                                        .pointer("/voice_item/text")
                                                        .and_then(|v| v.as_str()),
                                                    _ => None,
                                                }
                                            })
                                        });

                                    let text = match text {
                                        Some(t) if !t.is_empty() => t,
                                        _ => {
                                            tracing::warn!("[Weixin] skipped non-text message");
                                            continue;
                                        }
                                    };

                                    let from_user_id = msg
                                        .get("from_user_id")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or_default();
                                    let context_token = msg
                                        .get("context_token")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or_default();

                                    // Store reply context for outbound messages
                                    // Single lock scope to avoid TOCTOU
                                    let was_expired = if !from_user_id.is_empty() && !context_token.is_empty() {
                                        let mut guard = reply_context.lock().await;
                                        let was =
                                            guard.as_ref().map(|c| c.expired).unwrap_or(false);
                                        *guard = Some(WeixinReplyContext {
                                            to_user_id: from_user_id.to_string(),
                                            context_token: context_token.to_string(),
                                            expired: false,
                                        });
                                        was
                                    } else {
                                        false
                                    };

                                    // 1. Dispatch incoming user command FIRST before replaying buffered messages
                                    tracing::debug!("[Weixin] dispatching: {text}");
                                    let send_result = command_tx
                                        .send(IncomingCommand {
                                            channel_id,
                                            sender_id: from_user_id.to_string(),
                                            command_text: text.to_string(),
                                            callback_data: None,
                                            target: ChannelMessageTarget::channel(channel_id),
                                            metadata: msg.clone(),
                                        })
                                        .await;
                                    if let Err(e) = send_result {
                                        tracing::error!("[Weixin] command_tx.send failed: {e}");
                                    }

                                    // 2. Retry what was queued while context was stale, bounded to MAX_REPLAY_MESSAGES
                                    if was_expired && !from_user_id.is_empty() && !context_token.is_empty() {
                                        let buffered: Vec<PendingMessage> =
                                            pending_messages.lock().await.drain(..).collect();
                                        let now = Instant::now();
                                        let (stale, fresh): (Vec<_>, Vec<_>) =
                                            buffered.into_iter().partition(|m| {
                                                now.duration_since(m.queued_at)
                                                    >= MAX_PENDING_AGE
                                            });
                                        if !stale.is_empty() {
                                            tracing::info!(
                                                "[Weixin] dropping {} stale buffered message(s) older than {:?}",
                                                stale.len(),
                                                MAX_PENDING_AGE
                                            );
                                        }
                                        if !fresh.is_empty() {
                                            // Give command_dispatcher a brief head start to answer the user's message
                                            tokio::time::sleep(Duration::from_millis(300)).await;

                                            let to_replay: Vec<PendingMessage> =
                                                if fresh.len() > MAX_REPLAY_MESSAGES {
                                                    let skip = fresh.len() - MAX_REPLAY_MESSAGES;
                                                    tracing::info!(
                                                        "[Weixin] bounding replay: replaying latest {} of {} buffered messages",
                                                        MAX_REPLAY_MESSAGES,
                                                        fresh.len()
                                                    );
                                                    fresh.into_iter().skip(skip).collect()
                                                } else {
                                                    fresh
                                                };

                                            tracing::info!(
                                                "[Weixin] context refreshed, resending {} buffered message(s)",
                                                to_replay.len()
                                            );

                                            for pending in to_replay {
                                                let result = WeixinBackend::do_send(SendRequest {
                                                    client: &client,
                                                    base_url: &base_url,
                                                    bot_token: &bot_token,
                                                    wechat_uin: &wechat_uin,
                                                    to_user_id: from_user_id,
                                                    context_token,
                                                    text: &pending.text,
                                                })
                                                .await;
                                                match result {
                                                    Ok(Some(_)) => {}
                                                    Ok(None) => {
                                                        // Context rejected (quota or token expired).
                                                        // Re-mark expired so subsequent sends buffer, re-queue, and stop replaying.
                                                        if let Some(ref mut c) = *reply_context.lock().await {
                                                            c.expired = true;
                                                        }
                                                        tracing::info!(
                                                            "[Weixin] context_token rejected during replay (ret={CONTEXT_REJECTED_RET}), re-queueing and stopping replay"
                                                        );
                                                        let _ = queue_pending(&pending_messages, pending).await;
                                                        break;
                                                    }
                                                    Err(e) => {
                                                        tracing::error!(
                                                            "[Weixin] resend error: {e}"
                                                        );
                                                        let _ = queue_pending(&pending_messages, pending).await;
                                                        break;
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        } else {
                            tracing::error!("[Weixin] failed to parse response body");
                        }
                    }
                    Err(e) => {
                        consecutive_errors += 1;
                        tracing::error!("[Weixin] polling error ({consecutive_errors}): {e}");
                        *status.lock().await = ChannelConnectionStatus::Error;
                        // Exponential backoff: 5s, 10s, 20s, capped at 30s
                        let delay =
                            std::cmp::min(5 * 2u64.saturating_pow(consecutive_errors - 1), 30);
                        tokio::time::sleep(Duration::from_secs(delay)).await;
                    }
                }
            }
            *status.lock().await = ChannelConnectionStatus::Disconnected;
        });

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
        self.send_text(text).await
    }

    async fn send_rich_message(
        &self,
        message: &RichMessage,
    ) -> Result<SendOutcome, ChatChannelError> {
        let plain_text = message.to_plain_text();
        self.send_text(&plain_text).await
    }

    async fn test_connection(&self) -> Result<(), ChatChannelError> {
        let body = serde_json::json!({
            "get_updates_buf": "",
            "base_info": { "channel_version": ILINK_CHANNEL_VERSION }
        });

        let url = format!("{}/ilink/bot/getupdates", self.base_url);
        let resp = self
            .client
            .post(&url)
            .headers(Self::build_headers(&self.bot_token, &self.wechat_uin))
            .json(&body)
            .send()
            .await
            .map_err(|e| ChatChannelError::ConnectionFailed(e.to_string()))?;

        let status_code = resp.status();
        let resp_text = resp
            .text()
            .await
            .map_err(|e| ChatChannelError::ConnectionFailed(e.to_string()))?;

        tracing::info!("[Weixin] test_connection: status={status_code}");
        tracing::debug!("[Weixin] test_connection body={resp_text}");

        let resp_json: serde_json::Value = serde_json::from_str(&resp_text)
            .map_err(|e| ChatChannelError::ConnectionFailed(format!("Not valid JSON: {e}")))?;

        if !status_code.is_success() {
            return Err(ChatChannelError::AuthenticationFailed(format!(
                "HTTP {status_code}"
            )));
        }

        // Check for known auth-failure codes
        if let Some(ret) = resp_json.get("ret").and_then(|v| v.as_i64()) {
            if ret == -14 {
                return Err(ChatChannelError::AuthenticationFailed(
                    "Session expired (ret=-14)".into(),
                ));
            }
        }

        Ok(())
    }
}

#[cfg(test)]
impl WeixinBackend {
    pub(crate) async fn set_test_reply_context(
        &self,
        to_user_id: &str,
        context_token: &str,
        expired: bool,
    ) {
        *self.reply_context.lock().await = Some(WeixinReplyContext {
            to_user_id: to_user_id.to_string(),
            context_token: context_token.to_string(),
            expired,
        });
    }

    pub(crate) async fn is_context_expired(&self) -> bool {
        self.reply_context
            .lock()
            .await
            .as_ref()
            .map(|c| c.expired)
            .unwrap_or(false)
    }

    pub(crate) async fn pending_count(&self) -> usize {
        self.pending_messages.lock().await.len()
    }

    pub(crate) async fn push_test_pending(&self, text: &str, age: Duration) {
        let queued_at = Instant::now().checked_sub(age).unwrap_or_else(Instant::now);
        self.pending_messages.lock().await.push(PendingMessage {
            text: text.to_string(),
            queued_at,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    async fn spawn_mock_server(
        status_code: u16,
        body: &'static str,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            if let Ok((mut socket, _)) = listener.accept().await {
                let mut buf = vec![0u8; 4096];
                let _ = socket.read(&mut buf).await;
                let resp = format!(
                    "HTTP/1.1 {status_code} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(resp.as_bytes()).await;
                let _ = socket.flush().await;
            }
        });
        (format!("http://{addr}"), handle)
    }

    #[tokio::test]
    async fn test_send_success() {
        let (base_url, _server) = spawn_mock_server(200, r#"{"ret": 0, "errmsg": "ok"}"#).await;
        let backend = WeixinBackend::new(1, "test_token".into(), base_url);
        backend
            .set_test_reply_context("wx_user_1", "valid_token", false)
            .await;

        let outcome = backend.send_message("hello world").await.unwrap();
        assert!(outcome.is_sent(), "expected sent outcome, got {outcome:?}");
        assert_eq!(backend.pending_count().await, 0);
        assert!(!backend.is_context_expired().await);
    }

    #[tokio::test]
    async fn test_send_rejected_context_buffers_and_marks_expired() {
        let (base_url, _server) =
            spawn_mock_server(200, r#"{"ret": -2, "errmsg": "token expired"}"#).await;
        let backend = WeixinBackend::new(1, "test_token".into(), base_url);
        backend
            .set_test_reply_context("wx_user_1", "stale_token", false)
            .await;

        let outcome = backend.send_message("test nudge").await.unwrap();
        assert_eq!(outcome, SendOutcome::Buffered);
        assert!(backend.is_context_expired().await, "should mark context as expired");
        assert_eq!(backend.pending_count().await, 1, "should buffer rejected message");
    }

    #[tokio::test]
    async fn test_send_when_expired_buffers_immediately_without_network() {
        // Point to closed port: if any network call is made, it would fail or timeout
        let backend = WeixinBackend::new(1, "test_token".into(), "http://127.0.0.1:1".into());
        backend
            .set_test_reply_context("wx_user_1", "old_token", true)
            .await;

        let outcome = backend.send_message("offline nudge").await.unwrap();
        assert_eq!(outcome, SendOutcome::Buffered);
        assert_eq!(backend.pending_count().await, 1);
    }

    #[tokio::test]
    async fn test_send_buffer_full_reports_dropped() {
        let backend = WeixinBackend::new(1, "test_token".into(), "http://127.0.0.1:1".into());
        backend
            .set_test_reply_context("wx_user_1", "old_token", true)
            .await;

        // Fill buffer to max capacity
        for i in 0..MAX_PENDING_MESSAGES {
            backend.push_test_pending(&format!("msg {i}"), Duration::from_secs(10)).await;
        }
        assert_eq!(backend.pending_count().await, MAX_PENDING_MESSAGES);

        let outcome = backend.send_message("overflow message").await.unwrap();
        assert_eq!(outcome, SendOutcome::Dropped);
        assert_eq!(backend.pending_count().await, MAX_PENDING_MESSAGES);
    }

    #[tokio::test]
    async fn test_stale_buffered_messages_are_dropped_by_age() {
        let now = Instant::now();
        let old_msg = PendingMessage {
            text: "stale 15m".into(),
            queued_at: now.checked_sub(Duration::from_secs(15 * 60)).unwrap(),
        };
        let fresh_msg = PendingMessage {
            text: "fresh 30s".into(),
            queued_at: now.checked_sub(Duration::from_secs(30)).unwrap(),
        };
        let messages = vec![old_msg, fresh_msg];
        let (stale, fresh): (Vec<_>, Vec<_>) = messages
            .into_iter()
            .partition(|m| now.duration_since(m.queued_at) >= MAX_PENDING_AGE);

        assert_eq!(stale.len(), 1);
        assert_eq!(stale[0].text, "stale 15m");
        assert_eq!(fresh.len(), 1);
        assert_eq!(fresh[0].text, "fresh 30s");
    }
}
