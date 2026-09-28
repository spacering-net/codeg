//! Remote-workspace IPC proxy.
//!
//! When a desktop window is opened against a remote codeg-server, every API
//! call and WebSocket event for that connection is funnelled through Rust
//! commands defined here. The webview never opens an HTTP/WS connection to
//! the remote host directly — that path is blocked by the Tauri webview's
//! secure-context mixed-content rules whenever the remote URL is plain
//! `http://`. Routing through Rust (reqwest + tokio-tungstenite) bypasses
//! those rules and gives us a single place to manage auth, reconnect, and
//! per-window event isolation.
//!
//! ## Isolation contract
//!
//! - Different `connection_id`s use distinct Tauri event channels
//!   (`remote-ws-event-{id}`) AND distinct background WS tasks. Two remote
//!   workspaces opened side-by-side never mix events.
//! - Within one `connection_id`, multiple webviews (main + remote-settings
//!   child window, etc.) share **one** underlying WS connection but each
//!   event is dispatched only to the webview labels that have explicitly
//!   subscribed. We never `app.emit(...)` globally — every emit is
//!   `app.emit_to(EventTarget::webview(label), ...)`.
//! - When the last subscriber for a connection unsubscribes (or its window
//!   is destroyed), the WS task shuts down and the entry is removed from
//!   the proxy state.
//!
//! The whole module is gated to `feature = "tauri-runtime"` via `mod.rs`;
//! the inner-attribute form here would duplicate the predicate.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::body::Bytes;
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use futures_util::{SinkExt, Stream, StreamExt};
use serde_json::Value;
use tauri::{AppHandle, Emitter, EventTarget, State, WebviewWindow};
use tokio::sync::{mpsc, watch, Mutex, RwLock};
use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest,
    handshake::client::Request,
    http::{HeaderMap, HeaderValue},
    Message,
};
use tokio_util::sync::CancellationToken;

/// Outbound mpsc capacity per remote WS. Bounded so a runaway frontend
/// cannot exhaust memory by piling client-→-server messages, but generous
/// enough to absorb a brief handshake burst (multiple attaches firing at
/// the same moment when the user opens several conversation tabs).
const OUTBOUND_CAPACITY: usize = 64;

/// Maximum time `remote_ws_send_text` will wait for the outbound mpsc to
/// accept a frame before failing. Under sustained backpressure we'd rather
/// surface the failure to the JS side (which can reissue attaches) than
/// silently drop or block the Tauri command worker indefinitely.
const OUTBOUND_SEND_TIMEOUT: Duration = Duration::from_secs(2);

use crate::app_error::{
    AppCommandError, AppErrorCode, UPLOAD_I18N_KEY_NOT_A_FILE, UPLOAD_I18N_KEY_TOO_LARGE,
};
use crate::db::service::remote_workspace_connection_service;
use crate::db::AppDatabase;
use crate::models::ToHeaderMap;
use crate::workspace_transfer::{
    TransferDirection, TransferState, WorkspaceTransferManager, WorkspaceTransferProgress,
    WORKSPACE_TRANSFER_PROGRESS_EVENT,
};

/// Default HTTP request timeout. Long enough to survive remote ACP prompts
/// (which can stream for a while) but bounded so a hung remote can't lock a
/// webview indefinitely. Matches the JS-side `WEB_CALL_TIMEOUT_MS` ceiling
/// for unannotated requests. Callers that need more (e.g. the 60s ACP
/// `acp_describe_agent_options` probe) pass an explicit `timeout_ms` to
/// `remote_http_call`, which then uses `RequestBuilder::timeout` to override
/// this default for that single request.
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);

/// Upper bound on per-request timeout overrides. Caps how much a caller can
/// extend the default — protects against a buggy / malicious JS caller
/// supplying a huge value and locking a Tauri command worker on a hung
/// remote. 10 minutes is comfortably above every existing override (the
/// longest today is 70s for `describeAgentOptions`).
const HTTP_TIMEOUT_MAX: Duration = Duration::from_secs(600);

/// Number of consecutive WS connect failures before we give up and emit
/// `__unauthorized__`. Matches the JS-side `wsFailCount >= 3` threshold.
const WS_RECONNECT_FAIL_THRESHOLD: u32 = 3;

/// Exponential backoff bounds for WS reconnect. 1s/2s/4s/8s/16s/32s.
const WS_BACKOFF_INITIAL_SECS: u64 = 1;
const WS_BACKOFF_MAX_SECS: u64 = 32;

/// MUST match the values in `src-tauri/src/web/auth.rs` and
/// `src/lib/transport/ws-auth.ts`. The server's auth middleware reads the
/// `sec-websocket-protocol` header looking for `codeg-token.{base64url}`.
const WS_EVENT_PROTOCOL: &str = "codeg-events";
const WS_TOKEN_PROTOCOL_PREFIX: &str = "codeg-token.";
const WS_EVENTS_PATH: &str = "/ws/events";

/// Internal Tauri-event channels emitted by this proxy. The frontend
/// `RemoteDesktopTransport` reserves these names. MUST match the
/// equivalents in `src/lib/transport/constants.ts` and the
/// `__disconnected__` / `__unauthorized__` literals in
/// `src/lib/transport/remote-desktop-transport.ts`.
const WS_READY_CHANNEL: &str = "__ready__";
const WS_DISCONNECTED_CHANNEL: &str = "__disconnected__";
const WS_UNAUTHORIZED_CHANNEL: &str = "__unauthorized__";

/// One entry per active remote `connection_id` with at least one webview
/// subscribed.
struct WsTaskEntry {
    /// subscription_id (opaque string generated by the JS transport) →
    /// subscriber metadata. Using an opaque ID as the key means two concurrent
    /// transports for the same label never collide: each has its own key, so a
    /// stale unsubscribe from an old transport only removes its own entry and
    /// cannot affect a new transport that reused the same label.
    /// Fan-out deduplicates labels so a label shared by two subscriptions
    /// (shouldn't happen in practice) still receives only one copy per frame.
    subscribers: Mutex<HashMap<String, WsSubscriber>>,
    /// True only after the current underlying WebSocket has emitted `__ready__`.
    ready: RwLock<bool>,
    /// Signals the background WS task to exit.
    shutdown_tx: watch::Sender<bool>,
    /// Outbound text messages to forward over the WS to the remote server.
    /// Used by the attach protocol (Phase 4a) so a Tauri frontend can send
    /// `attach`/`detach`/`ping` frames through the proxy without owning the
    /// WS itself. Frames are dropped (with a warning log) when the WS is
    /// not currently OPEN — the JS-side `RemoteEventStream` re-issues
    /// attach frames on every `__ready__` so a transient WS gap is recovered
    /// automatically.
    outbound_tx: mpsc::Sender<String>,
}

#[derive(Clone)]
struct WsSubscriber {
    label: String,
    window_instance_id: String,
}

/// Matches `reqwest`'s own default redirect bound.
const MAX_REMOTE_REDIRECTS: usize = 10;

/// Two URLs reach the same server over the same kind of channel.
///
/// Scheme, host and port — a true origin, one notch stricter than the host-and-
/// port test `reqwest` uses to decide whether to strip `Authorization`. The
/// extra notch is the point: on a connection configured as `https://box:8443`,
/// a hop to `http://box:8443` keeps reqwest's host and port identical, so its
/// rule would allow it and put the connection's credentials on the wire in
/// plaintext. Refusing a scheme change costs only the `http` → `https` upgrade
/// on an identical explicit port, which is a URL the user can simply configure.
fn same_remote_origin(a: &reqwest::Url, b: &reqwest::Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

/// `host:port` for an error message. The port is not decoration: two ports on
/// one host are two origins here, and "refused a redirect off 127.0.0.1 to
/// 127.0.0.1" would read as a bug.
fn origin_label(url: &reqwest::Url) -> String {
    match (url.host_str(), url.port_or_known_default()) {
        (Some(host), Some(port)) => format!("{host}:{port}"),
        (Some(host), None) => host.to_string(),
        _ => url.as_str().to_string(),
    }
}

/// Redirect policy for every request that carries a connection's credentials.
///
/// `reqwest` already drops `Authorization` once a redirect crosses to another
/// host, so such a hop could only ever have come back 401 anyway. What it does
/// not know to drop is the connection's custom headers, which are credentials
/// of exactly the same kind — a Cloudflare Access service token, a proxy
/// secret. Refusing the hop keeps them on the host the user configured, and
/// turns what would have been a confusing 401 into a message that names the
/// problem. Same-host redirects still follow, under reqwest's own bound.
pub(crate) fn connection_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        let Some(previous) = attempt.previous().last() else {
            return attempt.follow();
        };
        if !same_remote_origin(previous, attempt.url()) {
            let message = format!(
                "refused a redirect off {} to {}: it would hand the connection's \
                 custom headers to another host",
                origin_label(previous),
                origin_label(attempt.url()),
            );
            return attempt.error(message);
        }
        // `>` not `>=`, to land on the same count `Policy::limited` allows.
        if attempt.previous().len() > MAX_REMOTE_REDIRECTS {
            return attempt.error(format!("more than {MAX_REMOTE_REDIRECTS} redirects"));
        }
        attempt.follow()
    })
}

/// Flatten a failed request into a detail string worth showing.
///
/// `reqwest`'s own `Display` stops at the outermost layer — "error following
/// redirect for url (…)", "error sending request for url (…)" — which is
/// precisely the layer that carries no reason. Everything worth reading is in
/// the source chain: the redirect refusal above, the connect error, the TLS
/// failure. Without this the host-pinning error reaches the user as a bare
/// "error following redirect" and looks like a bug rather than a decision.
pub(crate) fn request_error_detail(err: &reqwest::Error) -> String {
    let mut detail = err.to_string();
    let mut source: Option<&(dyn std::error::Error + 'static)> = std::error::Error::source(err);
    while let Some(cause) = source {
        detail.push_str(": ");
        detail.push_str(&cause.to_string());
        source = cause.source();
    }
    detail
}

/// Tauri-managed singleton.
pub struct RemoteProxyState {
    tasks: Mutex<HashMap<i32, Arc<WsTaskEntry>>>,
    destroyed_window_instances: Mutex<HashSet<String>>,
    http: reqwest::Client,
    workspace_http: reqwest::Client,
}

impl RemoteProxyState {
    pub fn new() -> Self {
        Self {
            tasks: Mutex::new(HashMap::new()),
            destroyed_window_instances: Mutex::new(HashSet::new()),
            http: reqwest::Client::builder()
                .timeout(HTTP_TIMEOUT)
                .redirect(connection_redirect_policy())
                .build()
                .expect("failed to build reqwest client for remote proxy"),
            workspace_http: reqwest::Client::builder()
                .redirect(connection_redirect_policy())
                .build()
                .expect("failed to build reqwest workspace client for remote proxy"),
        }
    }

    /// Register a forced-close cleanup hook for a concrete Tauri webview
    /// instance. This runs from window creation time, before frontend code can
    /// issue `remote_ws_subscribe`, so even a window destroyed while the
    /// subscribe invoke is still queued gets a tombstone before any late
    /// subscription insert can land.
    pub fn register_window_instance_cleanup(
        self: &Arc<Self>,
        window: &WebviewWindow,
        window_instance_id: String,
    ) {
        let proxy = self.clone();
        let label = window.label().to_string();
        window.on_window_event(move |event| {
            if !matches!(event, tauri::WindowEvent::Destroyed) {
                return;
            }
            let proxy = proxy.clone();
            let label = label.clone();
            let window_instance_id = window_instance_id.clone();
            tauri::async_runtime::spawn(async move {
                proxy
                    .mark_window_instance_destroyed(&label, &window_instance_id)
                    .await;
            });
        });
    }

    /// Remove one subscription by its opaque ID. Shuts down the WS task if
    /// no subscribers remain. A stale unsubscribe from a destroyed transport
    /// only removes its own ID and cannot affect any other transport.
    async fn remove_subscription(self: &Arc<Self>, connection_id: i32, subscription_id: &str) {
        let shutdown_tx = {
            let mut tasks = self.tasks.lock().await;
            let entry = match tasks.get(&connection_id) {
                Some(e) => e.clone(),
                None => return,
            };
            let mut subs = entry.subscribers.lock().await;
            subs.remove(subscription_id);
            if subs.is_empty() {
                tasks.remove(&connection_id);
                Some(entry.shutdown_tx.clone())
            } else {
                None
            }
        };
        if let Some(tx) = shutdown_tx {
            let _ = tx.send(true);
        }
    }

    /// Remove all subscriptions owned by the destroyed window instance. This
    /// is the forced-close fallback when the JS transport cannot call
    /// `remote_ws_unsubscribe`. The instance ID is generated before the window
    /// loads and carried through the URL, so a new window that reuses the same
    /// label has a different ID and is never touched by stale cleanup.
    async fn mark_window_instance_destroyed(
        self: &Arc<Self>,
        label: &str,
        window_instance_id: &str,
    ) {
        let shutdown_txs = {
            let mut destroyed = self.destroyed_window_instances.lock().await;
            destroyed.insert(window_instance_id.to_string());
            let mut tasks = self.tasks.lock().await;
            let connection_ids: Vec<i32> = tasks.keys().copied().collect();
            let mut shutdown_txs = Vec::new();

            for connection_id in connection_ids {
                let entry = match tasks.get(&connection_id) {
                    Some(e) => e.clone(),
                    None => continue,
                };
                let mut subs = entry.subscribers.lock().await;
                subs.retain(|_, sub| {
                    sub.label != label || sub.window_instance_id != window_instance_id
                });
                let is_empty = subs.is_empty();
                drop(subs);
                if is_empty {
                    if let Some(stored) = tasks.get(&connection_id) {
                        if Arc::ptr_eq(stored, &entry) {
                            tasks.remove(&connection_id);
                            shutdown_txs.push(entry.shutdown_tx.clone());
                        }
                    }
                }
            }
            shutdown_txs
        };
        for tx in shutdown_txs {
            let _ = tx.send(true);
        }
    }
}

impl Default for RemoteProxyState {
    fn default() -> Self {
        Self::new()
    }
}

// ─── HTTP proxy command ────────────────────────────────────────────────

/// Forward an HTTP API call to the remote codeg-server identified by
/// `connection_id`. The frontend's `RemoteDesktopTransport.call(cmd, args)`
/// delegates to this; it never opens a fetch from the webview.
///
/// Error mapping:
///
/// - HTTP 401 → `AppErrorCode::AuthenticationFailed` ("token expired"). The
///   frontend recognises this code and surfaces the connection-expired UI
///   in just the calling window — by design we don't broadcast to siblings.
/// - Other non-2xx with a structured `AppCommandError` body → forwarded
///   verbatim so the original `code` / `message` / `i18n_key` /
///   `i18n_params` reach the caller intact. This preserves the i18n
///   pipeline across the proxy boundary.
/// - Other non-2xx without a structured body → wrapped as
///   `NetworkError` with the raw body in `detail`.
/// - Connect / read errors → wrapped as `NetworkError`.
#[tauri::command]
pub async fn remote_http_call(
    db: State<'_, AppDatabase>,
    proxy: State<'_, Arc<RemoteProxyState>>,
    connection_id: i32,
    command: String,
    args: Option<Value>,
    timeout_ms: Option<u64>,
) -> Result<Value, AppCommandError> {
    let conn = remote_workspace_connection_service::get(&db.conn, connection_id)
        .await
        .map_err(AppCommandError::db)?
        .ok_or_else(|| {
            AppCommandError::not_found(format!("Remote connection {connection_id} not found"))
        })?;

    let url = format!(
        "{}/api/{}",
        conn.base_url.trim_end_matches('/'),
        command.trim_start_matches('/')
    );

    let body = args.unwrap_or(Value::Object(serde_json::Map::new()));

    let mut request = proxy
        .http
        .post(&url)
        .bearer_auth(conn.token.trim())
        .headers(conn.headers.to_header_map())
        .json(&body);
    // Per-request override beats the client-wide 30s default. Used by the
    // ACP probe path (`describeAgentOptions`) whose backend deadline is
    // longer than 30s — without this override, reqwest would abort here
    // before the backend can return its structured `ProbeTimedOut`.
    if let Some(ms) = timeout_ms {
        let requested = Duration::from_millis(ms);
        request = request.timeout(requested.min(HTTP_TIMEOUT_MAX));
    }
    let response = request.send().await.map_err(|e| {
        AppCommandError::network("Remote HTTP request failed").with_detail(request_error_detail(&e))
    })?;

    let status = response.status();

    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(AppCommandError::authentication_failed(
            "Remote Workspace token is invalid",
        ));
    }

    if !status.is_success() {
        let raw_body = response.text().await.unwrap_or_default();
        // The remote codeg-server always returns `Json(AppCommandError)`
        // on errors (see `web/handlers/error.rs::IntoResponse`). Try to
        // deserialize so the caller sees the original code + i18n hint.
        if let Ok(structured) = serde_json::from_str::<AppCommandError>(&raw_body) {
            return Err(structured);
        }
        return Err(
            AppCommandError::network(format!("Remote returned HTTP {status}")).with_detail(
                if raw_body.is_empty() {
                    status.canonical_reason().unwrap_or("error").to_string()
                } else {
                    raw_body
                },
            ),
        );
    }

    response.json::<Value>().await.map_err(|e| {
        AppCommandError::network("Failed to parse remote response").with_detail(e.to_string())
    })
}

// ─── Multipart upload proxy ───────────────────────────────────────────

/// Hard ceiling for `read_local_file_for_upload`. Mirrors the server-side
/// `UPLOAD_MAX_BYTES` in `web/handlers/files.rs`; kept here as a local
/// constant so this command can reject oversize reads *before* incurring
/// the file I/O cost — the remote `/api/upload_attachment` enforces the
/// same cap regardless, but a 100 MB read followed by a base64 encode and
/// an IPC trip would be a noticeable waste compared to early rejection.
const UPLOAD_MAX_BYTES: u64 = 20 * 1024 * 1024;

/// Maximum tolerated base64 payload length, pre-decode. Exactly
/// `ceil(UPLOAD_MAX_BYTES / 3) * 4` — that formula already accounts for
/// padding to the nearest 4-byte boundary, so a legitimate envelope of
/// exactly `UPLOAD_MAX_BYTES` raw bytes always fits. The current
/// frontend encoders (`btoa` for Web, `STANDARD.encode` for the Rust
/// `read_local_file_for_upload` side) emit clean base64 with no embedded
/// whitespace, so in practice the formula is exact. The `+ 4` slack is
/// one extra padded quad of headroom for a hypothetical future encoder
/// that appends a trailing `=`/`\n` (RFC 4648 explicitly permits
/// optional trailing CRLF). It is *not* load-bearing for any current
/// caller — the post-decode `bytes.len() > UPLOAD_MAX_BYTES` check
/// downstream is the authoritative guard, this constant only exists to
/// reject obviously oversized envelopes before allocating a `Vec<u8>`
/// the size of the base64 string. Used as a fast guard before
/// `STANDARD.decode` allocates.
const REMOTE_UPLOAD_MAX_BASE64_LEN: usize = {
    let raw = UPLOAD_MAX_BYTES as usize;
    raw.div_ceil(3) * 4 + 4
};

fn upload_i18n_params<const N: usize>(pairs: [(&str, String); N]) -> BTreeMap<String, String> {
    pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect()
}

/// Strip multipart-hostile bytes from a filename before handing it to
/// `reqwest::multipart::Part::file_name`. reqwest does not sanitize, and
/// a name containing CR/LF/`"`/`\` can inject extra `Content-Disposition`
/// headers (or simply corrupt the part boundary). Mirrors the server-side
/// `sanitize_upload_filename` in spirit but stays defensive — the server
/// will sanitize again when it stores the bytes, this layer just keeps
/// our outgoing multipart frame well-formed.
fn sanitize_upload_file_name(raw: &str) -> String {
    // Order matters: filter control chars first (which already covers
    // NUL, CR, LF, tab and the C1 range), then map the remaining
    // multipart-hostile punctuation. The mapped set is intentionally
    // small — we want to preserve user-visible filename content while
    // keeping the multipart frame parseable.
    let cleaned: String = raw
        .chars()
        .filter(|c| !c.is_control())
        .map(|c| match c {
            '"' | '\\' | '/' => '_',
            other => other,
        })
        .collect();
    let trimmed: String = cleaned.trim_matches(|c: char| c.is_whitespace()).into();
    let limited: String = trimmed.chars().take(255).collect();
    if limited.is_empty() {
        "file".to_string()
    } else {
        limited
    }
}

/// Stream a local file into a base64-wrapped JSON envelope ready to be
/// passed to `remote_upload_attachment`. Two callers need this today: the
/// Tauri-native drag-drop path (which receives OS paths from the webview
/// drag handler) and a future "attach this local path" command palette.
///
/// Rejects anything larger than `UPLOAD_MAX_BYTES` with a structured
/// `IoError` carrying the limit in `detail` so the frontend can format an
/// `attachUploadTooLarge` toast without round-tripping through the actual
/// upload endpoint.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFileForUpload {
    pub file_name: String,
    pub mime_type: Option<String>,
    pub size: u64,
    pub data_base64: String,
}

#[tauri::command]
pub async fn read_local_file_for_upload(
    path: String,
) -> Result<LocalFileForUpload, AppCommandError> {
    let path_buf = std::path::PathBuf::from(&path);
    // Use symlink_metadata + explicit `is_file()` so a webview-driven
    // invoke can't follow a `/tmp/symlink → /etc/shadow` into reading
    // anything outside the user's intent. The same guard rejects FIFOs
    // and device nodes — `tokio::fs::read` would otherwise block on a
    // FIFO until the writing side closes, hanging this command (and the
    // calling webview's drag-drop handler) indefinitely.
    let metadata = tokio::fs::symlink_metadata(&path_buf).await.map_err(|e| {
        AppCommandError::io_error("Failed to stat local file for upload")
            .with_detail(format!("{}: {e}", path_buf.display()))
    })?;
    if !metadata.file_type().is_file() {
        return Err(AppCommandError::io_error("Not a regular file")
            .with_detail(path_buf.display().to_string())
            .with_i18n(UPLOAD_I18N_KEY_NOT_A_FILE, BTreeMap::new()));
    }
    let size = metadata.len();
    if size > UPLOAD_MAX_BYTES {
        return Err(
            AppCommandError::io_error("Local file exceeds the upload size limit")
                .with_detail(format!("size={size} limit={UPLOAD_MAX_BYTES}"))
                .with_i18n(
                    UPLOAD_I18N_KEY_TOO_LARGE,
                    upload_i18n_params([
                        ("size", size.to_string()),
                        ("limit", UPLOAD_MAX_BYTES.to_string()),
                    ]),
                ),
        );
    }
    let bytes = tokio::fs::read(&path_buf).await.map_err(|e| {
        AppCommandError::io_error("Failed to read local file for upload")
            .with_detail(format!("{}: {e}", path_buf.display()))
    })?;
    let file_name = path_buf
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let mime_type = guess_mime_from_path(&path_buf);
    Ok(LocalFileForUpload {
        file_name: sanitize_upload_file_name(&file_name),
        mime_type,
        size,
        data_base64: STANDARD.encode(&bytes),
    })
}

/// Forward a multipart upload (file bytes + optional session bucket) to the
/// remote codeg-server identified by `connection_id`. Sibling of
/// `remote_http_call`, but multipart-shaped — the JSON proxy can't carry
/// binary bodies, and webview `fetch` to a plain `http://` remote is
/// blocked by mixed-content rules, so we cannot have the frontend hit
/// `/api/upload_attachment` directly when running inside a Tauri webview.
///
/// Error mapping mirrors `remote_http_call`: 401 → `AuthenticationFailed`,
/// other non-2xx prefers a structured `AppCommandError` body (preserving
/// `i18n_key` for the user toast), else wraps in `NetworkError`.
#[tauri::command]
pub async fn remote_upload_attachment(
    db: State<'_, AppDatabase>,
    proxy: State<'_, Arc<RemoteProxyState>>,
    connection_id: i32,
    file_name: String,
    mime_type: Option<String>,
    session_id: Option<String>,
    data_base64: String,
) -> Result<Value, AppCommandError> {
    let conn = remote_workspace_connection_service::get(&db.conn, connection_id)
        .await
        .map_err(AppCommandError::db)?
        .ok_or_else(|| {
            AppCommandError::not_found(format!("Remote connection {connection_id} not found"))
        })?;

    // Reject oversized payloads BEFORE allocating. The remote server
    // enforces the same cap on the decoded bytes, but a malicious /
    // buggy webview hitting this command directly would otherwise force
    // a `Vec<u8>` allocation roughly equal to the base64 length before
    // the cap fires server-side. Cap at `ceil(UPLOAD_MAX_BYTES * 4/3) +
    // padding slack` so a legitimate maximum-sized file (which encodes
    // to exactly `ceil(UPLOAD_MAX_BYTES / 3) * 4` bytes) always passes.
    if data_base64.len() > REMOTE_UPLOAD_MAX_BASE64_LEN {
        return Err(
            AppCommandError::io_error("Upload payload exceeds the size limit")
                .with_detail(format!(
                    "size={} limit={REMOTE_UPLOAD_MAX_BASE64_LEN}",
                    data_base64.len()
                ))
                .with_i18n(
                    UPLOAD_I18N_KEY_TOO_LARGE,
                    upload_i18n_params([
                        ("size", data_base64.len().to_string()),
                        ("limit", UPLOAD_MAX_BYTES.to_string()),
                    ]),
                ),
        );
    }
    let bytes = STANDARD.decode(data_base64.as_bytes()).map_err(|e| {
        AppCommandError::io_error("Failed to decode upload payload").with_detail(e.to_string())
    })?;
    // Belt-and-suspenders: decoded length must still respect the cap.
    // The base64 check above is a fast pre-filter; this guarantees that
    // any padding quirks can't squeeze through.
    if bytes.len() as u64 > UPLOAD_MAX_BYTES {
        return Err(
            AppCommandError::io_error("Upload payload exceeds the size limit")
                .with_detail(format!("size={} limit={UPLOAD_MAX_BYTES}", bytes.len()))
                .with_i18n(
                    UPLOAD_I18N_KEY_TOO_LARGE,
                    upload_i18n_params([
                        ("size", bytes.len().to_string()),
                        ("limit", UPLOAD_MAX_BYTES.to_string()),
                    ]),
                ),
        );
    }

    let mime = mime_type.unwrap_or_else(|| "application/octet-stream".to_string());
    // `reqwest::multipart::Part::file_name` does NOT strip CR/LF or
    // quote-escape — a name like `bad\r\nX-Auth: leak.txt` would inject
    // additional headers into the `Content-Disposition` line. Sanitize
    // ourselves before handing the value to reqwest. (The MIME string
    // goes through `mime_str`, which already rejects non-token chars.)
    //
    // Defense-in-depth: this is deliberately a second sanitize pass.
    // `read_local_file_for_upload` already sanitized `file_name` before
    // it returned, but this command is reachable from other JS callers
    // (e.g. the web `uploadAttachment` path packs an arbitrary
    // `file.name` straight through). Re-running the filter here means
    // every multipart frame leaving this process is uniformly clean,
    // regardless of upstream — and the extra cost is a single pass over
    // ≤255 chars, which is negligible compared to the upload itself.
    let safe_name = sanitize_upload_file_name(&file_name);
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(safe_name)
        .mime_str(&mime)
        .map_err(|e| {
            AppCommandError::io_error("Invalid MIME type for upload").with_detail(e.to_string())
        })?;
    let mut form = reqwest::multipart::Form::new().part("file", part);
    if let Some(sid) = session_id {
        if !sid.is_empty() {
            form = form.text("session_id", sid);
        }
    }

    let url = format!(
        "{}/api/upload_attachment",
        conn.base_url.trim_end_matches('/'),
    );
    let response = proxy
        .http
        .post(&url)
        .bearer_auth(conn.token.trim())
        .headers(conn.headers.to_header_map())
        .multipart(form)
        .send()
        .await
        .map_err(|e| {
            AppCommandError::network("Remote upload request failed")
                .with_detail(request_error_detail(&e))
        })?;

    let status = response.status();

    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(AppCommandError::authentication_failed(
            "Remote Workspace token is invalid",
        ));
    }

    if !status.is_success() {
        let raw_body = response.text().await.unwrap_or_default();
        if let Ok(structured) = serde_json::from_str::<AppCommandError>(&raw_body) {
            return Err(structured);
        }
        return Err(
            AppCommandError::network(format!("Remote returned HTTP {status}")).with_detail(
                if raw_body.is_empty() {
                    status.canonical_reason().unwrap_or("error").to_string()
                } else {
                    raw_body
                },
            ),
        );
    }

    response.json::<Value>().await.map_err(|e| {
        AppCommandError::network("Failed to parse remote upload response")
            .with_detail(e.to_string())
    })
}

/// Best-effort MIME guess by extension. Mirrors the frontend's
/// `MIME_BY_EXT` so a file uploaded via the desktop drag-drop path carries
/// the same `content-type` it would have if picked through the browser
/// `<input type=file>`. Falls back to `None` so the upload caller can
/// substitute `application/octet-stream`.
fn guess_mime_from_path(path: &std::path::Path) -> Option<String> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    let mime = match ext.as_str() {
        "txt" => "text/plain",
        "md" => "text/markdown",
        "json" => "application/json",
        "yaml" | "yml" => "application/yaml",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" | "mjs" | "cjs" => "text/javascript",
        "ts" => "text/typescript",
        "tsx" => "text/tsx",
        "jsx" => "text/jsx",
        "py" => "text/x-python",
        "rs" => "text/rust",
        "go" => "text/x-go",
        "java" => "text/x-java-source",
        "xml" => "application/xml",
        "toml" => "application/toml",
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => return None,
    };
    Some(mime.to_string())
}

// ─── Workspace file upload / download proxy ───────────────────────────
//
// Issue #179 follow-up: a Tauri client bound to a remote codeg-server
// previously had no path to upload/download workspace files. The web
// build hits `/api/upload_workspace_file` etc. directly, but a webview
// against a plain `http://` remote is blocked by mixed-content rules
// (same reason `remote_upload_attachment` exists). These three commands
// proxy the workspace endpoints over reqwest.
//
// Workspace file transfers intentionally have no application-level size
// limit. These bytes move between the user's own machine/browser and their
// workspace; OS disk space, network throughput, and the remote server are
// the natural boundaries.

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteWorkspaceUploadPathEntry {
    pub local_path: String,
    pub relative_path: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteWorkspaceUploadPathResult {
    pub transfer_id: String,
    pub files: Vec<RemoteWorkspaceUploadedFile>,
    pub bytes: u64,
}

#[derive(Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteWorkspaceUploadedFile {
    pub path: String,
    pub name: String,
    pub size: u64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceDownloadTicket {
    url: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteWorkspaceDownloadResult {
    pub transfer_id: String,
    pub bytes: u64,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn remote_upload_workspace_paths(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    proxy: State<'_, Arc<RemoteProxyState>>,
    transfers: State<'_, Arc<WorkspaceTransferManager>>,
    connection_id: i32,
    root_path: String,
    target_path: String,
    entries: Vec<RemoteWorkspaceUploadPathEntry>,
) -> Result<RemoteWorkspaceUploadPathResult, AppCommandError> {
    if entries.is_empty() {
        return Err(AppCommandError::invalid_input(
            "No local paths were provided for upload",
        ));
    }

    let conn = remote_workspace_connection_service::get(&db.conn, connection_id)
        .await
        .map_err(AppCommandError::db)?
        .ok_or_else(|| {
            AppCommandError::not_found(format!("Remote connection {connection_id} not found"))
        })?;

    let custom_headers = conn.headers.to_header_map();
    let (transfer_id, cancel_token) = transfers.register_transfer().await;
    let result = async {
        let _permit = transfers
            .remote_upload_semaphore
            .acquire()
            .await
            .map_err(|_| {
                AppCommandError::task_execution_failed(
                    "Remote workspace upload semaphore is closed",
                )
            })?;

        let mut uploaded = Vec::new();
        let mut total_bytes = 0u64;

        for entry in entries {
            if cancel_token.is_cancelled() {
                return Err(workspace_transfer_cancelled());
            }
            let local_path = PathBuf::from(&entry.local_path);
            let metadata = tokio::fs::symlink_metadata(&local_path)
                .await
                .map_err(|e| {
                    AppCommandError::io_error("Failed to stat local upload path")
                        .with_detail(format!("{}: {e}", local_path.display()))
                })?;
            if metadata.file_type().is_symlink() {
                return Err(AppCommandError::invalid_input(
                    "Local upload path is a symlink; refuse to follow it",
                ));
            }
            if metadata.is_dir() {
                let base_prefix = entry
                    .relative_path
                    .as_deref()
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .or_else(|| {
                        local_path
                            .file_name()
                            .map(|s| s.to_string_lossy().to_string())
                    })
                    .unwrap_or_default();
                for walked in walkdir::WalkDir::new(&local_path).follow_links(false) {
                    if cancel_token.is_cancelled() {
                        return Err(workspace_transfer_cancelled());
                    }
                    let walked = walked.map_err(|e| {
                        AppCommandError::io_error("Failed to walk local upload directory")
                            .with_detail(e.to_string())
                    })?;
                    if walked.file_type().is_symlink() || !walked.file_type().is_file() {
                        continue;
                    }
                    let nested = walked.path().strip_prefix(&local_path).map_err(|_| {
                        AppCommandError::io_error("Failed to calculate local relative path")
                    })?;
                    let relative_path = join_upload_relative(&base_prefix, nested);
                    let file_result = upload_one_workspace_path(
                        &app,
                        &proxy,
                        &conn.base_url,
                        conn.token.trim(),
                        &custom_headers,
                        &transfer_id,
                        cancel_token.clone(),
                        &root_path,
                        &target_path,
                        walked.path(),
                        Some(relative_path),
                    )
                    .await?;
                    total_bytes = total_bytes.saturating_add(file_result.size);
                    uploaded.push(file_result);
                }
            } else if metadata.is_file() {
                let file_result = upload_one_workspace_path(
                    &app,
                    &proxy,
                    &conn.base_url,
                    conn.token.trim(),
                    &custom_headers,
                    &transfer_id,
                    cancel_token.clone(),
                    &root_path,
                    &target_path,
                    &local_path,
                    entry.relative_path.filter(|s| !s.is_empty()),
                )
                .await?;
                total_bytes = total_bytes.saturating_add(file_result.size);
                uploaded.push(file_result);
            } else {
                return Err(AppCommandError::invalid_input(
                    "Local upload path is not a regular file or directory",
                ));
            }
        }

        emit_workspace_transfer_progress(
            &app,
            WorkspaceTransferProgress {
                transfer_id: transfer_id.clone(),
                direction: TransferDirection::Upload,
                loaded: total_bytes,
                total: Some(total_bytes),
                state: TransferState::Done,
                path: None,
                error: None,
            },
        );

        Ok(RemoteWorkspaceUploadPathResult {
            transfer_id: transfer_id.clone(),
            files: uploaded,
            bytes: total_bytes,
        })
    }
    .await;

    if let Err(err) = &result {
        let state = if cancel_token.is_cancelled() {
            TransferState::Cancelled
        } else {
            TransferState::Error
        };
        emit_workspace_transfer_progress(
            &app,
            WorkspaceTransferProgress {
                transfer_id: transfer_id.clone(),
                direction: TransferDirection::Upload,
                loaded: 0,
                total: None,
                state,
                path: None,
                error: Some(err.message.clone()),
            },
        );
    }
    transfers.finish_transfer(&transfer_id).await;
    result
}

#[allow(clippy::too_many_arguments)]
async fn upload_one_workspace_path(
    app: &AppHandle,
    proxy: &RemoteProxyState,
    base_url: &str,
    token: &str,
    custom_headers: &HeaderMap,
    transfer_id: &str,
    cancel_token: CancellationToken,
    root_path: &str,
    target_path: &str,
    local_path: &Path,
    relative_path: Option<String>,
) -> Result<RemoteWorkspaceUploadedFile, AppCommandError> {
    let metadata = tokio::fs::symlink_metadata(local_path)
        .await
        .map_err(AppCommandError::io)?;
    if !metadata.file_type().is_file() {
        return Err(AppCommandError::invalid_input(
            "Local upload path is not a regular file",
        ));
    }
    let size = metadata.len();
    let file = tokio::fs::File::open(local_path)
        .await
        .map_err(AppCommandError::io)?;
    let file_name = local_path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string());
    let safe_name = sanitize_upload_file_name(&file_name);
    let display_path = relative_path.clone().unwrap_or_else(|| safe_name.clone());

    emit_workspace_transfer_progress(
        app,
        WorkspaceTransferProgress {
            transfer_id: transfer_id.to_string(),
            direction: TransferDirection::Upload,
            loaded: 0,
            total: Some(size),
            state: TransferState::Running,
            path: Some(display_path.clone()),
            error: None,
        },
    );

    let stream = file_upload_stream(
        app.clone(),
        transfer_id.to_string(),
        cancel_token.clone(),
        file,
        size,
        display_path.clone(),
    );
    let body = reqwest::Body::wrap_stream(stream);
    let part = reqwest::multipart::Part::stream_with_length(body, size).file_name(safe_name);
    let mut form = reqwest::multipart::Form::new()
        .text("root_path", root_path.to_string())
        .text("target_path", target_path.to_string());
    if let Some(rp) = relative_path {
        form = form.text("relative_path", rp);
    }
    form = form.part("file", part);

    let url = format!(
        "{}/api/upload_workspace_file",
        base_url.trim_end_matches('/'),
    );
    let response = proxy
        .workspace_http
        .post(&url)
        .bearer_auth(token)
        .headers(custom_headers.clone())
        .multipart(form)
        .send()
        .await
        .map_err(|e| {
            if cancel_token.is_cancelled() {
                return workspace_transfer_cancelled();
            }
            AppCommandError::network("Remote workspace upload failed")
                .with_detail(request_error_detail(&e))
        })?;

    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(AppCommandError::authentication_failed(
            "Remote Workspace token is invalid",
        ));
    }
    if !status.is_success() {
        let raw_body = response.text().await.unwrap_or_default();
        if let Ok(structured) = serde_json::from_str::<AppCommandError>(&raw_body) {
            return Err(structured);
        }
        return Err(
            AppCommandError::network(format!("Remote returned HTTP {status}")).with_detail(
                if raw_body.is_empty() {
                    status.canonical_reason().unwrap_or("error").to_string()
                } else {
                    raw_body
                },
            ),
        );
    }

    let uploaded = response
        .json::<RemoteWorkspaceUploadedFile>()
        .await
        .map_err(|e| {
            AppCommandError::network("Failed to parse remote upload response")
                .with_detail(e.to_string())
        })?;
    emit_workspace_transfer_progress(
        app,
        WorkspaceTransferProgress {
            transfer_id: transfer_id.to_string(),
            direction: TransferDirection::Upload,
            loaded: size,
            total: Some(size),
            state: TransferState::Running,
            path: Some(display_path),
            error: None,
        },
    );
    Ok(uploaded)
}

fn file_upload_stream(
    app: AppHandle,
    transfer_id: String,
    cancel_token: CancellationToken,
    file: tokio::fs::File,
    total: u64,
    path: String,
) -> impl Stream<Item = Result<Bytes, std::io::Error>> + Send + 'static {
    futures::stream::try_unfold((file, 0u64), move |(mut file, loaded)| {
        let app = app.clone();
        let transfer_id = transfer_id.clone();
        let cancel_token = cancel_token.clone();
        let path = path.clone();
        async move {
            if cancel_token.is_cancelled() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Interrupted,
                    "Workspace transfer cancelled",
                ));
            }
            let mut buf = vec![0u8; 64 * 1024];
            use tokio::io::AsyncReadExt;
            let n = file.read(&mut buf).await?;
            if n == 0 {
                return Ok(None);
            }
            buf.truncate(n);
            let loaded = loaded.saturating_add(n as u64);
            emit_workspace_transfer_progress(
                &app,
                WorkspaceTransferProgress {
                    transfer_id,
                    direction: TransferDirection::Upload,
                    loaded,
                    total: Some(total),
                    state: TransferState::Running,
                    path: Some(path),
                    error: None,
                },
            );
            Ok(Some((Bytes::from(buf), (file, loaded))))
        }
    })
}

fn join_upload_relative(base: &str, nested: &Path) -> String {
    let nested = nested.to_string_lossy().replace('\\', "/");
    if base.is_empty() {
        nested
    } else if nested.is_empty() {
        base.to_string()
    } else {
        format!("{}/{nested}", base.trim_end_matches('/'))
    }
}

fn workspace_transfer_cancelled() -> AppCommandError {
    AppCommandError::task_execution_failed("Workspace transfer cancelled")
}

fn emit_workspace_transfer_progress(app: &AppHandle, progress: WorkspaceTransferProgress) {
    let _ = app.emit(WORKSPACE_TRANSFER_PROGRESS_EVENT, progress);
}

#[tauri::command]
pub async fn remote_cancel_workspace_transfer(
    transfers: State<'_, Arc<WorkspaceTransferManager>>,
    transfer_id: String,
) -> Result<bool, AppCommandError> {
    Ok(transfers.cancel(&transfer_id).await)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn remote_download_workspace_file(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    proxy: State<'_, Arc<RemoteProxyState>>,
    transfers: State<'_, Arc<WorkspaceTransferManager>>,
    connection_id: i32,
    root_path: String,
    path: String,
    save_path: String,
) -> Result<RemoteWorkspaceDownloadResult, AppCommandError> {
    remote_workspace_download_stream(
        app,
        db,
        proxy,
        transfers,
        connection_id,
        "file",
        root_path,
        path,
        save_path,
    )
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn remote_download_workspace_dir(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    proxy: State<'_, Arc<RemoteProxyState>>,
    transfers: State<'_, Arc<WorkspaceTransferManager>>,
    connection_id: i32,
    root_path: String,
    path: String,
    save_path: String,
) -> Result<RemoteWorkspaceDownloadResult, AppCommandError> {
    remote_workspace_download_stream(
        app,
        db,
        proxy,
        transfers,
        connection_id,
        "dir",
        root_path,
        path,
        save_path,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn remote_workspace_download_stream(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    proxy: State<'_, Arc<RemoteProxyState>>,
    transfers: State<'_, Arc<WorkspaceTransferManager>>,
    connection_id: i32,
    kind: &str,
    root_path: String,
    path: String,
    save_path: String,
) -> Result<RemoteWorkspaceDownloadResult, AppCommandError> {
    let conn = remote_workspace_connection_service::get(&db.conn, connection_id)
        .await
        .map_err(AppCommandError::db)?
        .ok_or_else(|| {
            AppCommandError::not_found(format!("Remote connection {connection_id} not found"))
        })?;

    let custom_headers = conn.headers.to_header_map();
    let (transfer_id, cancel_token) = transfers.register_transfer().await;
    let result = async {
        let _permit = transfers
            .remote_download_semaphore
            .acquire()
            .await
            .map_err(|_| {
                AppCommandError::task_execution_failed(
                    "Remote workspace download semaphore is closed",
                )
            })?;

        let ticket_url = format!(
            "{}/api/workspace_download_ticket",
            conn.base_url.trim_end_matches('/')
        );
        let ticket_response = proxy
            .workspace_http
            .post(ticket_url)
            .bearer_auth(conn.token.trim())
            .headers(custom_headers.clone())
            .json(&serde_json::json!({
                "rootPath": root_path,
                "path": path,
                "kind": kind,
            }))
            .send()
            .await
            .map_err(|e| {
                AppCommandError::network("Remote workspace download ticket failed")
                    .with_detail(request_error_detail(&e))
            })?;
        let status = ticket_response.status();
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(AppCommandError::authentication_failed(
                "Remote Workspace token is invalid",
            ));
        }
        if !status.is_success() {
            return remote_error_from_response(status, ticket_response).await;
        }
        let ticket = ticket_response
            .json::<WorkspaceDownloadTicket>()
            .await
            .map_err(|e| {
                AppCommandError::network("Failed to parse remote download ticket")
                    .with_detail(e.to_string())
            })?;
        let download_url = absolute_remote_ticket_url(&conn.base_url, &ticket.url)?;
        let response = proxy
            .workspace_http
            .get(download_url)
            .headers(custom_headers.clone())
            .send()
            .await
            .map_err(|e| {
                AppCommandError::network("Remote workspace download failed")
                    .with_detail(request_error_detail(&e))
            })?;

        let status = response.status();
        if !status.is_success() {
            return remote_error_from_response(status, response).await;
        }
        let total = response.content_length();
        emit_workspace_transfer_progress(
            &app,
            WorkspaceTransferProgress {
                transfer_id: transfer_id.clone(),
                direction: TransferDirection::Download,
                loaded: 0,
                total,
                state: TransferState::Running,
                path: Some(save_path.clone()),
                error: None,
            },
        );
        let stream = response.bytes_stream().map(|chunk| {
            chunk.map_err(|e| {
                AppCommandError::network("Failed to read remote download stream")
                    .with_detail(e.to_string())
            })
        });
        let bytes = write_response_stream_to_partial(
            stream,
            &save_path,
            &transfer_id,
            cancel_token.clone(),
            |loaded| {
                emit_workspace_transfer_progress(
                    &app,
                    WorkspaceTransferProgress {
                        transfer_id: transfer_id.clone(),
                        direction: TransferDirection::Download,
                        loaded,
                        total,
                        state: TransferState::Running,
                        path: Some(save_path.clone()),
                        error: None,
                    },
                );
            },
        )
        .await?;

        emit_workspace_transfer_progress(
            &app,
            WorkspaceTransferProgress {
                transfer_id: transfer_id.clone(),
                direction: TransferDirection::Download,
                loaded: bytes,
                total,
                state: TransferState::Done,
                path: Some(save_path.clone()),
                error: None,
            },
        );
        Ok(RemoteWorkspaceDownloadResult {
            transfer_id: transfer_id.clone(),
            bytes,
        })
    }
    .await;

    if let Err(err) = &result {
        let state = if cancel_token.is_cancelled() {
            TransferState::Cancelled
        } else {
            TransferState::Error
        };
        emit_workspace_transfer_progress(
            &app,
            WorkspaceTransferProgress {
                transfer_id: transfer_id.clone(),
                direction: TransferDirection::Download,
                loaded: 0,
                total: None,
                state,
                path: Some(save_path),
                error: Some(err.message.clone()),
            },
        );
    }
    transfers.finish_transfer(&transfer_id).await;
    result
}

async fn remote_error_from_response(
    status: reqwest::StatusCode,
    response: reqwest::Response,
) -> Result<RemoteWorkspaceDownloadResult, AppCommandError> {
    let raw_body = response.text().await.unwrap_or_default();
    if let Ok(structured) = serde_json::from_str::<AppCommandError>(&raw_body) {
        return Err(structured);
    }
    Err(
        AppCommandError::network(format!("Remote returned HTTP {status}")).with_detail(
            if raw_body.is_empty() {
                status.canonical_reason().unwrap_or("error").to_string()
            } else {
                raw_body
            },
        ),
    )
}

/// Resolve the download URL the remote handed back, and refuse one that leaves
/// the connection's origin.
///
/// `codeg-server` always answers with a path (`create_download_ticket` builds
/// `/api/workspace_download/<ticket>`), so the absolute branch only ever fires
/// for a remote that went off-script. It matters because this is the one
/// request that carries the connection's custom headers with no bearer token
/// gating them: a remote free to name any host is a remote free to choose who
/// receives those credentials.
fn absolute_remote_ticket_url(
    base_url: &str,
    ticket_url: &str,
) -> Result<String, AppCommandError> {
    let resolved = if ticket_url.starts_with("http://") || ticket_url.starts_with("https://") {
        ticket_url.to_string()
    } else if ticket_url.starts_with('/') {
        format!("{}{}", base_url.trim_end_matches('/'), ticket_url)
    } else {
        format!("{}/{}", base_url.trim_end_matches('/'), ticket_url)
    };
    let same_origin = match (
        reqwest::Url::parse(base_url),
        reqwest::Url::parse(&resolved),
    ) {
        (Ok(base), Ok(target)) => same_remote_origin(&base, &target),
        _ => false,
    };
    if !same_origin {
        return Err(AppCommandError::network(
            "Remote download ticket points outside the connection",
        )
        .with_detail(format!("ticket url: {ticket_url}")));
    }
    Ok(resolved)
}

fn partial_download_path(save_path: &str, transfer_id: &str) -> String {
    format!("{save_path}.codeg-download-{transfer_id}.part")
}

async fn write_response_stream_to_partial<S, F>(
    mut stream: S,
    save_path: &str,
    transfer_id: &str,
    cancel: CancellationToken,
    mut on_progress: F,
) -> Result<u64, AppCommandError>
where
    S: Stream<Item = Result<Bytes, AppCommandError>> + Unpin,
    F: FnMut(u64),
{
    use tokio::io::AsyncWriteExt;

    let partial_path = partial_download_path(save_path, transfer_id);
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&partial_path)
        .await
        .map_err(|e| {
            AppCommandError::io_error("Failed to create local download file")
                .with_detail(format!("{partial_path}: {e}"))
        })?;

    let result: Result<u64, AppCommandError> = async {
        let mut total: u64 = 0;
        loop {
            let next = tokio::select! {
                _ = cancel.cancelled() => return Err(workspace_transfer_cancelled()),
                next = stream.next() => next,
            };
            let Some(chunk) = next else {
                break;
            };
            let chunk = chunk?;
            total = total.saturating_add(chunk.len() as u64);
            file.write_all(&chunk).await.map_err(|e| {
                AppCommandError::io_error("Failed to write download to disk")
                    .with_detail(e.to_string())
            })?;
            on_progress(total);
        }
        file.flush().await.map_err(|e| {
            AppCommandError::io_error("Failed to flush downloaded file").with_detail(e.to_string())
        })?;
        file.sync_all().await.map_err(|e| {
            AppCommandError::io_error("Failed to sync downloaded file").with_detail(e.to_string())
        })?;
        Ok(total)
    }
    .await;

    drop(file);
    if result.is_err() {
        let _ = tokio::fs::remove_file(&partial_path).await;
        return result;
    }

    if tokio::fs::try_exists(save_path).await.unwrap_or(false) {
        if let Err(e) = tokio::fs::remove_file(save_path).await {
            let _ = tokio::fs::remove_file(&partial_path).await;
            return Err(
                AppCommandError::io_error("Failed to replace existing download")
                    .with_detail(format!("{save_path}: {e}")),
            );
        }
    }
    tokio::fs::rename(&partial_path, save_path)
        .await
        .map_err(|e| {
            let _ = std::fs::remove_file(&partial_path);
            AppCommandError::io_error("Failed to finalize download")
                .with_detail(format!("{partial_path} -> {save_path}: {e}"))
        })?;

    result
}

// ─── WebSocket proxy commands ─────────────────────────────────────────

/// Subscribe the calling webview to the remote server's WS event stream.
/// `subscription_id` is an opaque string generated by the JS transport
/// (UUID). Using a caller-supplied ID means the JS side can issue an
/// unsubscribe even if the subscribe invoke hasn't returned yet — it already
/// knows the ID. Two concurrent transports for the same window label never
/// collide because each has a distinct subscription_id.
#[tauri::command]
pub async fn remote_ws_subscribe(
    app: AppHandle,
    db: State<'_, AppDatabase>,
    proxy: State<'_, Arc<RemoteProxyState>>,
    window: WebviewWindow,
    connection_id: i32,
    subscription_id: String,
    window_instance_id: String,
) -> Result<(), AppCommandError> {
    let label = window.label().to_string();
    let event_name = format!("remote-ws-event-{connection_id}");
    let proxy_arc: Arc<RemoteProxyState> = (*proxy).clone();
    let subscriber = WsSubscriber {
        label: label.clone(),
        window_instance_id,
    };

    // Fast path: existing entry — insert this subscription_id.
    // Hold the destroyed-instance lock while inserting into `subscribers`, in
    // the same lock order as `mark_window_instance_destroyed`. This prevents a
    // window destroy event from slipping between the tombstone check and the
    // subscription insert.
    let needs_new_task = {
        let destroyed = proxy_arc.destroyed_window_instances.lock().await;
        if destroyed.contains(&subscriber.window_instance_id) {
            return Ok(());
        }
        let tasks = proxy_arc.tasks.lock().await;
        match tasks.get(&connection_id) {
            Some(entry) => {
                let mut subs = entry.subscribers.lock().await;
                subs.insert(subscription_id.clone(), subscriber.clone());
                drop(subs);
                let is_ready = *entry.ready.read().await;
                Some(is_ready)
            }
            None => None,
        }
    };

    if let Some(is_ready) = needs_new_task {
        if is_ready {
            emit_internal_to_label(&app, &label, &event_name, WS_READY_CHANNEL);
        }
        return Ok(());
    }

    // Slow path: load credentials, create entry, spawn WS task.
    let conn = remote_workspace_connection_service::get(&db.conn, connection_id)
        .await
        .map_err(AppCommandError::db)?
        .ok_or_else(|| {
            AppCommandError::not_found(format!("Remote connection {connection_id} not found"))
        })?;

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let (outbound_tx, outbound_rx) = mpsc::channel::<String>(OUTBOUND_CAPACITY);
    let entry = Arc::new(WsTaskEntry {
        subscribers: Mutex::new({
            let mut map = HashMap::new();
            map.insert(subscription_id.clone(), subscriber.clone());
            map
        }),
        ready: RwLock::new(false),
        shutdown_tx,
        outbound_tx,
    });

    // Insert under the proxy lock. If a concurrent subscribe raced us, fold
    // our subscription into the existing entry and abort our task spawn.
    {
        let destroyed = proxy_arc.destroyed_window_instances.lock().await;
        if destroyed.contains(&subscriber.window_instance_id) {
            return Ok(());
        }
        let mut tasks = proxy_arc.tasks.lock().await;
        if let Some(existing) = tasks.get(&connection_id) {
            existing
                .subscribers
                .lock()
                .await
                .insert(subscription_id, subscriber);
            return Ok(());
        }
        tasks.insert(connection_id, entry.clone());
    }

    let task_app = app.clone();
    let task_proxy = proxy_arc.clone();
    let base_url = conn.base_url.clone();
    let token = conn.token.clone();
    let custom_headers = conn.headers.to_header_map();
    let task_entry = entry.clone();

    tauri::async_runtime::spawn(async move {
        run_ws_task(
            task_app,
            task_proxy,
            connection_id,
            base_url,
            token,
            custom_headers,
            task_entry,
            shutdown_rx,
            outbound_rx,
        )
        .await;
    });

    Ok(())
}

/// Send an arbitrary text frame over the existing WS to the remote server.
/// Used by the JS-side `RemoteEventStream` to forward `attach` / `detach` /
/// `ping` messages without owning the WS itself.
///
/// Returns `Err(NetworkError)` when the proxy has no entry for this
/// `connection_id`, when the outbound channel is closed, or when the queue
/// stays full for `OUTBOUND_SEND_TIMEOUT`. The JS side uses the failure
/// as a signal to reissue active attach frames; previously we returned
/// `Ok(())` on drop and the stream could stick on a missing snapshot until
/// the next reconnect.
///
/// The Tauri command is a thin wrapper around `remote_ws_send_text_core`
/// so the failure-mode logic is unit-testable without a Tauri runtime.
#[tauri::command]
pub async fn remote_ws_send_text(
    proxy: State<'_, Arc<RemoteProxyState>>,
    connection_id: i32,
    text: String,
) -> Result<(), AppCommandError> {
    let proxy_arc: Arc<RemoteProxyState> = (*proxy).clone();
    remote_ws_send_text_core(&proxy_arc, connection_id, text).await
}

async fn remote_ws_send_text_core(
    proxy: &Arc<RemoteProxyState>,
    connection_id: i32,
    text: String,
) -> Result<(), AppCommandError> {
    let entry = {
        let tasks = proxy.tasks.lock().await;
        tasks.get(&connection_id).cloned()
    };
    let Some(entry) = entry else {
        return Err(AppCommandError::new(
            AppErrorCode::NetworkError,
            format!("remote ws task not active for connection {connection_id}"),
        ));
    };
    // Bounded backpressure: prefer waiting briefly for the outbound queue
    // to drain over silently dropping. Control frames (attach/detach) MUST
    // surface failure so the JS side can reissue, and input frames benefit
    // from backpressure too. The 2s ceiling protects the Tauri command
    // worker from a permanently stuck WS.
    match tokio::time::timeout(OUTBOUND_SEND_TIMEOUT, entry.outbound_tx.send(text)).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(_)) => Err(AppCommandError::new(
            AppErrorCode::NetworkError,
            format!("remote ws outbound channel closed for connection {connection_id}"),
        )),
        Err(_) => Err(AppCommandError::new(
            AppErrorCode::NetworkError,
            format!(
                "remote ws send timed out after {}s for connection {connection_id} (outbound queue full)",
                OUTBOUND_SEND_TIMEOUT.as_secs()
            ),
        )),
    }
}

/// Unsubscribe one subscription by its opaque ID. Only removes the entry
/// matching `subscription_id`; a stale call from a destroyed transport is
/// always a safe no-op for any other transport.
#[tauri::command]
pub async fn remote_ws_unsubscribe(
    proxy: State<'_, Arc<RemoteProxyState>>,
    connection_id: i32,
    subscription_id: String,
) -> Result<(), AppCommandError> {
    let proxy_arc: Arc<RemoteProxyState> = (*proxy).clone();
    proxy_arc
        .remove_subscription(connection_id, &subscription_id)
        .await;
    Ok(())
}

// ─── WS background task ───────────────────────────────────────────────

/// Long-running task that maintains one WebSocket per `connection_id`.
/// Lifecycle:
///   1. Connect (with subprotocol-auth header).
///   2. On successful upgrade, emit `__ready__` to current subscribers.
///   3. Read messages, fan out to subscribers as `(channel, payload)`
///      envelopes.
///   4. On disconnect, emit `__disconnected__`, increment fail count, back
///      off, retry.
///   5. After `WS_RECONNECT_FAIL_THRESHOLD` consecutive failures, emit
///      `__unauthorized__` and exit.
///   6. At any point, a `shutdown_tx.send(true)` causes graceful exit.
///
/// On exit (any path), the task removes its entry from `proxy.tasks` —
/// but only if the entry still matches its own `Arc`, so a racy
/// resubscribe that already replaced the entry isn't clobbered.
// `app`/`proxy`/`connection_id`/`base_url`/`token`/`entry`/`shutdown_rx`/
// `outbound_rx` are all distinct concerns the task needs; bundling into a
// single struct would just spread the field definitions to a different
// place without improving readability.
#[allow(clippy::too_many_arguments)]
async fn run_ws_task(
    app: AppHandle,
    proxy: Arc<RemoteProxyState>,
    connection_id: i32,
    base_url: String,
    token: String,
    custom_headers: HeaderMap,
    entry: Arc<WsTaskEntry>,
    mut shutdown_rx: watch::Receiver<bool>,
    mut outbound_rx: mpsc::Receiver<String>,
) {
    let event_name = format!("remote-ws-event-{connection_id}");
    let ws_url = http_url_to_ws_url(&base_url, WS_EVENTS_PATH);
    let mut fail_count: u32 = 0;

    'reconnect: loop {
        if *shutdown_rx.borrow() {
            break;
        }

        let connect_result = tokio::select! {
            biased;
            _ = shutdown_rx.changed() => {
                if *shutdown_rx.borrow() {
                    break;
                }
                continue;
            }
            res = connect_with_subprotocol_auth(&ws_url, WS_EVENT_PROTOCOL, &token, &custom_headers) => res,
        };

        let mut socket = match connect_result {
            Ok(s) => s,
            Err(err) => {
                tracing::error!("[RemoteProxy] WS connect failed for connection {connection_id}: {err}");
                fail_count += 1;
                if fail_count >= WS_RECONNECT_FAIL_THRESHOLD {
                    emit_internal(&app, &entry, &event_name, WS_UNAUTHORIZED_CHANNEL).await;
                    break;
                }
                if backoff_sleep(&mut shutdown_rx, fail_count).await {
                    break;
                }
                continue;
            }
        };

        // Connect succeeded — reset fail count. We do not emit `__ready__`
        // here; the remote server emits the real `__ready__` only after it
        // has subscribed to its broadcaster, and that is the readiness
        // contract the frontend relies on.
        fail_count = 0;

        // Read loop. Exits on shutdown, error, or remote close.
        loop {
            tokio::select! {
                biased;
                changed = shutdown_rx.changed() => {
                    if changed.is_ok() && *shutdown_rx.borrow() {
                        let _ = socket.send(Message::Close(None)).await;
                        break 'reconnect;
                    }
                }
                outbound = outbound_rx.recv() => match outbound {
                    Some(text) => {
                        if let Err(err) = socket.send(Message::Text(text.into())).await {
                            tracing::error!(
                                "[RemoteProxy] outbound send failed on connection {connection_id}: {err}"
                            );
                            break;
                        }
                    }
                    None => {
                        // Sender side dropped — only happens at proxy state
                        // teardown; treat as graceful exit.
                        let _ = socket.send(Message::Close(None)).await;
                        break 'reconnect;
                    }
                },
                msg = socket.next() => match msg {
                    Some(Ok(Message::Text(text))) => {
                        if let Err(err) = forward_text_message(&app, &entry, &event_name, &text).await {
                            tracing::error!(
                                "[RemoteProxy] failed to forward WS message on connection {connection_id}: {err}"
                            );
                        }
                    }
                    Some(Ok(Message::Binary(_))) => {
                        // Server only emits text frames today; ignore binary.
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        let _ = socket.send(Message::Pong(payload)).await;
                    }
                    Some(Ok(Message::Pong(_))) | Some(Ok(Message::Frame(_))) => {}
                    Some(Ok(Message::Close(_))) | None => {
                        break;
                    }
                    Some(Err(err)) => {
                        tracing::error!(
                            "[RemoteProxy] WS read error on connection {connection_id}: {err}"
                        );
                        break;
                    }
                },
            }
        }

        // Disconnected (not via shutdown). Notify and try again.
        *entry.ready.write().await = false;
        emit_internal(&app, &entry, &event_name, WS_DISCONNECTED_CHANNEL).await;
        fail_count += 1;
        if fail_count >= WS_RECONNECT_FAIL_THRESHOLD {
            emit_internal(&app, &entry, &event_name, WS_UNAUTHORIZED_CHANNEL).await;
            break;
        }
        if backoff_sleep(&mut shutdown_rx, fail_count).await {
            break;
        }
    }

    *entry.ready.write().await = false;

    // Cleanup: remove our entry from the proxy state. We only remove if
    // the stored Arc still points to us — a fresh resubscribe between
    // our shutdown signal and this cleanup could have already replaced
    // it, and we mustn't blow away the newer entry.
    let mut tasks = proxy.tasks.lock().await;
    if let Some(stored) = tasks.get(&connection_id) {
        if Arc::ptr_eq(stored, &entry) {
            tasks.remove(&connection_id);
        }
    }
}

/// Sleep for the exponential-backoff duration corresponding to
/// `fail_count` (1s, 2s, 4s, … capped at `WS_BACKOFF_MAX_SECS`). Returns
/// `true` if shutdown was requested during the wait — caller should exit
/// its loop in that case.
async fn backoff_sleep(shutdown_rx: &mut watch::Receiver<bool>, fail_count: u32) -> bool {
    let shift = fail_count.saturating_sub(1).min(8) as u64;
    let secs = (WS_BACKOFF_INITIAL_SECS << shift).min(WS_BACKOFF_MAX_SECS);
    tokio::select! {
        biased;
        changed = shutdown_rx.changed() => changed.is_ok() && *shutdown_rx.borrow(),
        _ = tokio::time::sleep(Duration::from_secs(secs)) => false,
    }
}

/// Forward a text frame from the remote WS to all current subscribers of
/// this connection. The remote codeg-server's `ws.rs` emits frames shaped
/// `{ "channel": "...", "payload": ... }` (see `WebEventBroadcaster`).
/// We re-emit the payload as-is into the Tauri event named
/// `remote-ws-event-{connection_id}`, but only to webview labels listed in
/// the subscriber set — never broadcast.
async fn forward_text_message(
    app: &AppHandle,
    entry: &Arc<WsTaskEntry>,
    event_name: &str,
    text: &str,
) -> Result<(), String> {
    // Validate the JSON shape minimally to surface server-side bugs
    // (malformed frames) without dropping the frame entirely.
    let envelope: Value =
        serde_json::from_str(text).map_err(|e| format!("invalid WS frame: {e}"))?;

    if envelope
        .get("channel")
        .and_then(Value::as_str)
        .is_some_and(|channel| channel == WS_READY_CHANNEL)
    {
        *entry.ready.write().await = true;
    }

    let labels = snapshot_subscribers(entry).await;
    for label in labels {
        if let Err(e) = app.emit_to(EventTarget::webview(&label), event_name, &envelope) {
            tracing::error!("[RemoteProxy] emit_to {label} for {event_name} failed: {e}");
        }
    }
    Ok(())
}

/// Emit one of the internal lifecycle channels (`__ready__`,
/// `__disconnected__`, `__unauthorized__`) to all current subscribers.
async fn emit_internal(
    app: &AppHandle,
    entry: &Arc<WsTaskEntry>,
    event_name: &str,
    channel: &'static str,
) {
    let labels = snapshot_subscribers(entry).await;
    for label in labels {
        emit_internal_to_label(app, &label, event_name, channel);
    }
}

fn emit_internal_to_label(app: &AppHandle, label: &str, event_name: &str, channel: &'static str) {
    let envelope = serde_json::json!({
        "channel": channel,
        "payload": Value::Null,
    });
    if let Err(e) = app.emit_to(EventTarget::webview(label), event_name, &envelope) {
        tracing::error!("[RemoteProxy] emit_to {label} for {event_name} ({channel}) failed: {e}");
    }
}

/// Collect the unique labels to fan-out to. Deduplicates because two
/// subscription IDs could theoretically map to the same label.
async fn snapshot_subscribers(entry: &Arc<WsTaskEntry>) -> Vec<String> {
    let subs = entry.subscribers.lock().await;
    let mut labels: Vec<String> = subs.values().map(|sub| sub.label.clone()).collect();
    labels.sort_unstable();
    labels.dedup();
    labels
}

// ─── Helpers ──────────────────────────────────────────────────────────

/// Connect to a remote WebSocket with subprotocol-based token auth, speaking
/// `protocol` (`codeg-events`, or the browser tunnel's). The remote server's
/// auth middleware (see `web/auth.rs`) accepts either `Authorization: Bearer …`
/// or a subprotocol entry shaped `codeg-token.{base64url(token)}`. The latter
/// is what browser WebSocket clients use because browsers cannot set arbitrary
/// headers on WS handshakes; we follow the same convention here so both
/// transports share one server-side codepath.
pub(crate) async fn connect_with_subprotocol_auth(
    ws_url: &str,
    protocol: &str,
    token: &str,
    custom_headers: &HeaderMap,
) -> Result<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    String,
> {
    let request = ws_request_with_subprotocol_auth(ws_url, protocol, token, custom_headers)?;
    let (stream, _resp) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| format!("connect_async: {e}"))?;
    Ok(stream)
}

/// The handshake request `connect_with_subprotocol_auth` sends, for a caller
/// that needs tungstenite's own error back (the HTTP status of a refused
/// upgrade says what the server is).
pub(crate) fn ws_request_with_subprotocol_auth(
    ws_url: &str,
    protocol: &str,
    token: &str,
    custom_headers: &HeaderMap,
) -> Result<Request, String> {
    let mut request: Request = ws_url
        .into_client_request()
        .map_err(|e| format!("invalid WS URL: {e}"))?;

    let encoded_token = URL_SAFE_NO_PAD.encode(token.trim().as_bytes());
    let protocols_value = format!("{protocol}, {WS_TOKEN_PROTOCOL_PREFIX}{encoded_token}");
    request.headers_mut().insert(
        "sec-websocket-protocol",
        HeaderValue::from_str(&protocols_value)
            .map_err(|e| format!("invalid subprotocol value: {e}"))?,
    );
    request.headers_mut().extend(custom_headers.clone());
    Ok(request)
}

/// Convert an `http://…` or `https://…` base URL into the corresponding
/// WebSocket URL ending in `path` (`/ws/events`, …). Anything else is passed
/// through untouched so tungstenite can surface a clean parse error.
pub(crate) fn http_url_to_ws_url(base_url: &str, path: &str) -> String {
    let trimmed = base_url.trim_end_matches('/');
    if let Some(rest) = trimmed.strip_prefix("https://") {
        format!("wss://{rest}{path}")
    } else if let Some(rest) = trimmed.strip_prefix("http://") {
        format!("ws://{rest}{path}")
    } else {
        format!("{trimmed}{path}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn subscriber(label: &str, window_instance_id: &str) -> WsSubscriber {
        WsSubscriber {
            label: label.to_string(),
            window_instance_id: window_instance_id.to_string(),
        }
    }

    fn test_entry(subscribers: HashMap<String, WsSubscriber>) -> Arc<WsTaskEntry> {
        let (shutdown_tx, _shutdown_rx) = watch::channel(false);
        let (outbound_tx, _outbound_rx) = mpsc::channel::<String>(8);
        Arc::new(WsTaskEntry {
            subscribers: Mutex::new(subscribers),
            ready: RwLock::new(false),
            shutdown_tx,
            outbound_tx,
        })
    }

    // ─── Host pinning for credential-carrying requests ──────────────────
    //
    // Both of these guard the same thing from two directions: the custom
    // headers on a remote connection are credentials, and neither the remote
    // nor a redirect it issues gets to choose which host receives them.

    #[test]
    fn ticket_url_resolves_a_path_against_the_connection() {
        // The only shape `codeg-server` actually returns.
        assert_eq!(
            absolute_remote_ticket_url("https://box.example", "/api/workspace_download/t1")
                .unwrap(),
            "https://box.example/api/workspace_download/t1"
        );
        // A base with a path prefix keeps it — this is why the resolution is
        // string concatenation and not `Url::join`, which would drop `/codeg`.
        assert_eq!(
            absolute_remote_ticket_url("https://box.example/codeg", "/api/workspace_download/t1")
                .unwrap(),
            "https://box.example/codeg/api/workspace_download/t1"
        );
        assert_eq!(
            absolute_remote_ticket_url("https://box.example/", "api/workspace_download/t1")
                .unwrap(),
            "https://box.example/api/workspace_download/t1"
        );
        // Absolute, but still the connection's own host: allowed.
        assert_eq!(
            absolute_remote_ticket_url("https://box.example", "https://box.example/dl/t1").unwrap(),
            "https://box.example/dl/t1"
        );
    }

    #[test]
    fn ticket_url_refuses_a_host_the_connection_did_not_name() {
        for ticket in [
            "https://evil.example/dl/t1",
            // Same host, different port — a different server.
            "https://box.example:8443/dl/t1",
            // Same host, downgraded scheme.
            "http://box.example/dl/t1",
        ] {
            let err = absolute_remote_ticket_url("https://box.example", ticket)
                .expect_err("ticket url should be refused: {ticket}");
            assert!(
                err.message.contains("outside the connection"),
                "unexpected message for {ticket}: {}",
                err.message
            );
        }

        // The case a host-and-port test alone would wave through: identical
        // explicit port, scheme downgraded, so the credentials would have gone
        // out in plaintext. `reqwest`'s own strip rule has this blind spot.
        assert!(
            absolute_remote_ticket_url("https://box.example:8443", "http://box.example:8443/dl/t1")
                .is_err(),
            "a plaintext downgrade on the same port must be refused"
        );
    }

    /// Accept `responses.len()` connections in order, answering each with the
    /// matching canned response. Returns the raw request text of each, so a
    /// test can assert on the headers that actually arrived.
    async fn serve_sequence(
        listener: tokio::net::TcpListener,
        responses: Vec<String>,
    ) -> Vec<String> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut requests = Vec::with_capacity(responses.len());
        for response in responses {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let n = stream.read(&mut buf).await.unwrap();
            requests.push(String::from_utf8_lossy(&buf[..n]).to_string());
            stream.write_all(response.as_bytes()).await.unwrap();
            stream.flush().await.unwrap();
        }
        requests
    }

    fn redirect_to(location: &str) -> String {
        // `Connection: close` so the follow-up hop opens a fresh connection and
        // lands on the next `accept()` rather than being pipelined onto this one.
        format!(
            "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\n\
             Connection: close\r\n\r\n"
        )
    }

    fn ok_response() -> String {
        "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string()
    }

    #[tokio::test]
    async fn redirect_to_another_host_never_delivers_the_custom_header() {
        // Two loopback ports are two origins, so this is the cross-host case.
        let hop = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let elsewhere = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let hop_addr = hop.local_addr().unwrap();
        let elsewhere_addr = elsewhere.local_addr().unwrap();

        let hop_task = tokio::spawn(serve_sequence(
            hop,
            vec![redirect_to(&format!("http://{elsewhere_addr}/next"))],
        ));
        let elsewhere_task = tokio::spawn(serve_sequence(elsewhere, vec![ok_response()]));

        let client = reqwest::Client::builder()
            .redirect(connection_redirect_policy())
            // Hermetic: this box has HTTP_PROXY set, and reqwest does not
            // bypass loopback for it. Without this the request reaches the
            // proxy instead of the test server, which answers 502 — an error,
            // so the cross-host case would pass for entirely the wrong reason.
            .no_proxy()
            .build()
            .unwrap();
        let err = client
            .get(format!("http://{hop_addr}/start"))
            .header("X-Access-Secret", "s3cret")
            .send()
            .await
            .expect_err("a redirect off the connection host must not be followed");
        assert!(err.is_redirect(), "expected a redirect error, got: {err}");
        // reqwest's own Display is just "error following redirect for url (…)",
        // so this also pins that the reason survives into what the UI renders.
        let detail = request_error_detail(&err);
        assert!(
            detail.contains("refused a redirect off")
                && detail.contains(&elsewhere_addr.to_string()),
            "the refusal reason must reach the caller: {detail}"
        );

        let hop_request = hop_task.await.unwrap().remove(0);
        assert!(
            hop_request.contains("s3cret"),
            "the configured host should still receive the header: {hop_request}"
        );

        // Nothing ever connected to the second host, so its `accept()` is still
        // pending. That, rather than an assertion on headers it never saw, is
        // the proof the credential stayed put.
        elsewhere_task.abort();
        assert!(
            elsewhere_task.await.unwrap_err().is_cancelled(),
            "the redirect target received a request"
        );
    }

    #[tokio::test]
    async fn redirect_within_the_same_host_still_follows_and_keeps_the_header() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(serve_sequence(
            listener,
            vec![redirect_to("/next"), ok_response()],
        ));

        let client = reqwest::Client::builder()
            .redirect(connection_redirect_policy())
            // Hermetic: this box has HTTP_PROXY set, and reqwest does not
            // bypass loopback for it. Without this the request reaches the
            // proxy instead of the test server, which answers 502 — an error,
            // so the cross-host case would pass for entirely the wrong reason.
            .no_proxy()
            .build()
            .unwrap();
        let response = client
            .get(format!("http://{addr}/start"))
            .header("X-Access-Secret", "s3cret")
            .send()
            .await
            .expect("a same-host redirect should still be followed");
        assert!(response.status().is_success());

        let requests = server.await.unwrap();
        assert_eq!(requests.len(), 2, "the redirect should have been followed");
        assert!(requests[1].starts_with("GET /next"), "got: {}", requests[1]);
        assert!(
            requests[1].contains("s3cret"),
            "the header must survive a same-host hop: {}",
            requests[1]
        );
    }

    #[test]
    fn http_url_to_ws_url_http() {
        assert_eq!(
            http_url_to_ws_url("http://localhost:8080", "/ws/events"),
            "ws://localhost:8080/ws/events"
        );
    }

    #[test]
    fn http_url_to_ws_url_https_trailing_slash() {
        assert_eq!(
            http_url_to_ws_url("https://example.com/", "/ws/events"),
            "wss://example.com/ws/events"
        );
    }

    #[test]
    fn http_url_to_ws_url_unknown_scheme() {
        // tungstenite will reject this, but our helper passes it through.
        assert_eq!(
            http_url_to_ws_url("ftp://example.com", "/ws/events"),
            "ftp://example.com/ws/events"
        );
    }

    #[test]
    fn partial_download_path_is_unique_sibling() {
        let path = partial_download_path("/tmp/out.zip", "abc");
        assert_eq!(path, "/tmp/out.zip.codeg-download-abc.part");
    }

    #[tokio::test]
    async fn write_response_stream_to_partial_removes_partial_on_error() {
        let dir = tempfile::tempdir().unwrap();
        let save_path = dir.path().join("out.bin");
        let stream = futures::stream::iter([
            Ok(Bytes::from_static(b"partial")),
            Err(AppCommandError::network("simulated stream failure")),
        ]);

        let err = write_response_stream_to_partial(
            stream,
            &save_path.to_string_lossy(),
            "test-transfer",
            CancellationToken::new(),
            |_| {},
        )
        .await
        .unwrap_err();

        assert!(err.message.contains("simulated"));
        let partial = partial_download_path(&save_path.to_string_lossy(), "test-transfer");
        assert!(!Path::new(&partial).exists());
        assert!(!save_path.exists());
    }

    #[tokio::test]
    async fn stale_unsubscribe_only_removes_its_own_subscription() {
        let proxy = Arc::new(RemoteProxyState::new());
        let entry = test_entry(HashMap::from([
            (
                "old-sub".to_string(),
                subscriber("remote-workspace-1", "old"),
            ),
            (
                "new-sub".to_string(),
                subscriber("remote-workspace-1", "new"),
            ),
        ]));
        proxy.tasks.lock().await.insert(1, entry.clone());

        proxy.remove_subscription(1, "old-sub").await;

        let subscribers = entry.subscribers.lock().await;
        assert!(!subscribers.contains_key("old-sub"));
        assert!(subscribers.contains_key("new-sub"));
        drop(subscribers);
        assert!(proxy.tasks.lock().await.contains_key(&1));
    }

    #[tokio::test]
    async fn window_instance_cleanup_preserves_reused_label_with_new_instance() {
        let proxy = Arc::new(RemoteProxyState::new());
        let entry = test_entry(HashMap::from([
            (
                "old-sub".to_string(),
                subscriber("remote-workspace-1", "old"),
            ),
            (
                "new-sub".to_string(),
                subscriber("remote-workspace-1", "new"),
            ),
            (
                "other-label".to_string(),
                subscriber("remote-settings-1", "settings"),
            ),
        ]));
        proxy.tasks.lock().await.insert(1, entry.clone());

        proxy
            .mark_window_instance_destroyed("remote-workspace-1", "old")
            .await;

        let subscribers = entry.subscribers.lock().await;
        assert!(!subscribers.contains_key("old-sub"));
        assert!(subscribers.contains_key("new-sub"));
        assert!(subscribers.contains_key("other-label"));
        drop(subscribers);
        assert!(proxy.tasks.lock().await.contains_key(&1));
    }

    #[tokio::test]
    async fn window_instance_cleanup_tombstones_and_shuts_down_empty_task() {
        let proxy = Arc::new(RemoteProxyState::new());
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let (outbound_tx, _outbound_rx) = mpsc::channel::<String>(8);
        let entry = Arc::new(WsTaskEntry {
            subscribers: Mutex::new(HashMap::from([(
                "sub".to_string(),
                subscriber("remote-workspace-1", "dead"),
            )])),
            ready: RwLock::new(false),
            shutdown_tx,
            outbound_tx,
        });
        proxy.tasks.lock().await.insert(1, entry);

        proxy
            .mark_window_instance_destroyed("remote-workspace-1", "dead")
            .await;

        assert!(proxy
            .destroyed_window_instances
            .lock()
            .await
            .contains("dead"));
        assert!(!proxy.tasks.lock().await.contains_key(&1));
        assert!(*shutdown_rx.borrow());
    }

    // ─── remote_ws_send_text failure surfacing ─────────────────────────
    //
    // Pre-fix, this command silently returned Ok(()) on no-entry / queue-
    // full so a dropped attach frame would leave the JS-side subscription
    // stuck waiting for a snapshot that never came. The tests pin the
    // contract that every drop path now surfaces NetworkError so the JS
    // reattach-on-failure loop can recover.
    //
    // For a description of the user-visible failure mode this protects
    // against, see the comment on `remote_ws_send_text` in this file.
    fn entry_with_outbound(capacity: usize) -> (Arc<WsTaskEntry>, mpsc::Receiver<String>) {
        let (shutdown_tx, _shutdown_rx) = watch::channel(false);
        let (outbound_tx, outbound_rx) = mpsc::channel::<String>(capacity);
        let entry = Arc::new(WsTaskEntry {
            subscribers: Mutex::new(HashMap::new()),
            ready: RwLock::new(false),
            shutdown_tx,
            outbound_tx,
        });
        (entry, outbound_rx)
    }

    #[tokio::test]
    async fn send_text_no_entry_returns_network_error() {
        let proxy = Arc::new(RemoteProxyState::new());
        let err = remote_ws_send_text_core(&proxy, 42, "hi".to_string())
            .await
            .expect_err("expected Err when no entry exists");
        assert!(matches!(err.code, AppErrorCode::NetworkError));
        assert!(
            err.message.contains("not active"),
            "message should mention 'not active', got: {}",
            err.message
        );
    }

    #[tokio::test]
    async fn send_text_happy_path_delivers_to_receiver() {
        let proxy = Arc::new(RemoteProxyState::new());
        let (entry, mut outbound_rx) = entry_with_outbound(8);
        proxy.tasks.lock().await.insert(7, entry);

        remote_ws_send_text_core(&proxy, 7, "hello".to_string())
            .await
            .expect("send should succeed");

        let received = outbound_rx.recv().await.expect("frame should arrive");
        assert_eq!(received, "hello");
    }

    #[tokio::test]
    async fn send_text_closed_channel_returns_network_error() {
        let proxy = Arc::new(RemoteProxyState::new());
        let (entry, outbound_rx) = entry_with_outbound(8);
        proxy.tasks.lock().await.insert(7, entry);
        // Drop the receiver — outbound_tx.send will fail with SendError
        // once try_send / send observes the closed channel.
        drop(outbound_rx);

        let err = remote_ws_send_text_core(&proxy, 7, "hi".to_string())
            .await
            .expect_err("expected Err when channel closed");
        assert!(matches!(err.code, AppErrorCode::NetworkError));
        assert!(
            err.message.contains("closed"),
            "message should mention 'closed', got: {}",
            err.message
        );
    }

    #[tokio::test(start_paused = true)]
    async fn send_text_queue_full_times_out() {
        let proxy = Arc::new(RemoteProxyState::new());
        let (entry, _outbound_rx) = entry_with_outbound(1);
        proxy.tasks.lock().await.insert(7, entry);

        // Fill the single-slot queue so the next send must wait.
        remote_ws_send_text_core(&proxy, 7, "first".to_string())
            .await
            .expect("first send fits the buffer");

        let send_fut = remote_ws_send_text_core(&proxy, 7, "second".to_string());
        // Advance virtual time past OUTBOUND_SEND_TIMEOUT so the inner
        // tokio::time::timeout fires deterministically without the test
        // actually sleeping.
        let advance = OUTBOUND_SEND_TIMEOUT + Duration::from_millis(100);
        let (res, _) = tokio::join!(send_fut, async {
            tokio::time::sleep(advance).await;
        });

        let err = res.expect_err("queue-full second send should time out");
        assert!(matches!(err.code, AppErrorCode::NetworkError));
        assert!(
            err.message.contains("timed out"),
            "message should mention 'timed out', got: {}",
            err.message
        );
    }

    // ─── i18n key wire-format tripwire ─────────────────────────────────
    //
    // The frontend branches on these exact literal strings. If anyone
    // renames the Rust constants without updating the TS side
    // (`UPLOAD_I18N_KEY_*` in `src/lib/api.ts`), the test still passes
    // but runtime degrades silently — that's why we pin the literals
    // here instead of asserting `KEY == KEY`. CI will fail loudly the
    // moment somebody touches one side, forcing the lockstep edit.

    #[test]
    fn upload_i18n_keys_have_expected_values() {
        assert_eq!(UPLOAD_I18N_KEY_TOO_LARGE, "errors.upload.tooLarge");
        assert_eq!(UPLOAD_I18N_KEY_NOT_A_FILE, "errors.upload.notAFile");
    }

    #[test]
    fn app_command_error_with_i18n_roundtrips_through_serde() {
        // Reproduces the end-to-end path: error built in
        // `read_local_file_for_upload` → serialized for IPC → parsed by
        // the frontend's `extractAppCommandError` (which mirrors serde's
        // shape). If serde ever drops `i18n_key` / `i18n_params` from
        // the wire format, the frontend silently demotes to the
        // generic-failure toast — this test pins the contract.
        let err = AppCommandError::io_error("Local file exceeds the upload size limit")
            .with_detail("size=41943040 limit=20971520")
            .with_i18n(
                UPLOAD_I18N_KEY_TOO_LARGE,
                upload_i18n_params([
                    ("size", "41943040".to_string()),
                    ("limit", UPLOAD_MAX_BYTES.to_string()),
                ]),
            );

        let json = serde_json::to_value(&err).expect("serialize");
        assert_eq!(json["i18n_key"], "errors.upload.tooLarge");
        assert_eq!(json["i18n_params"]["size"], "41943040");
        assert_eq!(json["i18n_params"]["limit"], UPLOAD_MAX_BYTES.to_string());
        assert_eq!(json["code"], "io_error");

        let parsed: AppCommandError = serde_json::from_value(json).expect("deserialize");
        assert_eq!(parsed.i18n_key.as_deref(), Some("errors.upload.tooLarge"));
        let params = parsed.i18n_params.expect("params");
        assert_eq!(params.get("size").map(String::as_str), Some("41943040"));
        assert_eq!(
            params.get("limit").map(String::as_str),
            Some(UPLOAD_MAX_BYTES.to_string().as_str())
        );
    }

    #[test]
    fn app_command_error_omits_i18n_when_absent() {
        // The `#[serde(skip_serializing_if = "Option::is_none")]`
        // attribute must hold — otherwise the WS proxy and HTTP API
        // would emit noisy `null` fields on every error. Pin it.
        let err = AppCommandError::io_error("plain error");
        let json = serde_json::to_value(&err).expect("serialize");
        assert!(json.get("i18n_key").is_none());
        assert!(json.get("i18n_params").is_none());
        assert!(json.get("detail").is_none());
    }

    #[test]
    fn upload_i18n_params_helper_builds_map() {
        let params = upload_i18n_params([("a", "1".to_string()), ("b", "two".to_string())]);
        assert_eq!(params.get("a").map(String::as_str), Some("1"));
        assert_eq!(params.get("b").map(String::as_str), Some("two"));
        assert_eq!(params.len(), 2);
    }

    // ─── base64 size cap boundary ──────────────────────────────────────

    #[test]
    fn remote_upload_max_base64_len_admits_exact_limit_payload() {
        // A payload of exactly `UPLOAD_MAX_BYTES` raw bytes encodes to
        // a base64 string that MUST pass the pre-decode guard — anything
        // else means we'd reject a legitimate maximum-sized upload.
        let raw = vec![0u8; UPLOAD_MAX_BYTES as usize];
        let encoded = STANDARD.encode(&raw);
        assert!(
            encoded.len() <= REMOTE_UPLOAD_MAX_BASE64_LEN,
            "max-size base64 ({}) exceeds the constant ({})",
            encoded.len(),
            REMOTE_UPLOAD_MAX_BASE64_LEN
        );
    }

    #[test]
    fn remote_upload_max_base64_len_matches_formula() {
        // Lock the formula: any deviation from `ceil(N/3)*4 + 4` will
        // either tighten the cap (false-negative risk) or widen it
        // (defeats the pre-allocation guard). Both warrant a deliberate
        // commit message rather than silent drift.
        let expected = (UPLOAD_MAX_BYTES as usize).div_ceil(3) * 4 + 4;
        assert_eq!(REMOTE_UPLOAD_MAX_BASE64_LEN, expected);
    }

    // ─── filename sanitization ─────────────────────────────────────────

    #[test]
    fn sanitize_upload_file_name_preserves_plain_names() {
        assert_eq!(sanitize_upload_file_name("notes.md"), "notes.md");
        assert_eq!(
            sanitize_upload_file_name("with spaces 中文.pdf"),
            "with spaces 中文.pdf"
        );
    }

    #[test]
    fn sanitize_upload_file_name_strips_header_injection_chars() {
        // `reqwest::multipart::Part::file_name` does not escape these.
        // A CRLF followed by a header name would inject an extra header
        // line into the Content-Disposition. Control chars (CR, LF,
        // tab, NUL, …) are filtered out entirely, while quote, slash
        // and backslash are mapped to `_` so the visible name still
        // makes sense to the user.
        let evil = "leak.txt\r\nX-Auth: bad";
        assert_eq!(sanitize_upload_file_name(evil), "leak.txtX-Auth: bad");

        let punctuation = "foo\"bar\\baz/qux.txt";
        assert_eq!(
            sanitize_upload_file_name(punctuation),
            "foo_bar_baz_qux.txt"
        );

        // NUL is a control char and gets filtered out — *not* replaced
        // with `_`. Either result kills the header-injection vector;
        // pinning the observed behavior so any future change to
        // `is_control()` semantics or the filter ordering is loud.
        let with_nul = "foo\0bar.txt";
        assert_eq!(sanitize_upload_file_name(with_nul), "foobar.txt");
    }

    #[test]
    fn sanitize_upload_file_name_falls_back_when_empty() {
        assert_eq!(sanitize_upload_file_name(""), "file");
        assert_eq!(sanitize_upload_file_name("   "), "file");
        // Entirely control chars: filtered to empty, then fallback.
        assert_eq!(sanitize_upload_file_name("\r\n\t\0"), "file");
    }

    #[test]
    fn sanitize_upload_file_name_caps_length_at_255_chars() {
        let name = "a".repeat(300);
        let result = sanitize_upload_file_name(&name);
        assert_eq!(result.chars().count(), 255);
    }

    // ─── MIME guess ────────────────────────────────────────────────────

    #[test]
    fn guess_mime_from_path_handles_common_extensions() {
        let cases = [
            ("/tmp/foo.json", Some("application/json")),
            ("/tmp/foo.PDF", Some("application/pdf")), // case-insensitive
            ("/tmp/foo.unknown", None),
            ("/tmp/no-extension", None),
        ];
        for (path, expected) in cases {
            assert_eq!(
                guess_mime_from_path(std::path::Path::new(path)),
                expected.map(str::to_string),
                "case: {path}"
            );
        }
    }
}
