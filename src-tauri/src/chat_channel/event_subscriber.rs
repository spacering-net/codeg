use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use sea_orm::DatabaseConnection;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use super::i18n::Lang;
use super::manager::ChatChannelManager;
use super::message_formatter;
use super::session_bridge::SessionBridge;
use super::types::RichMessage;
use crate::acp::internal_bus::InternalEventBus;
use crate::acp::types::{AcpEvent, EventEnvelope};
use crate::db::service::{
    app_metadata_service, chat_channel_message_log_service, chat_channel_service,
};
use crate::logging::throttle::{LagLogThrottle, LAG_LOG_WINDOW};

/// Minimum interval between pushes for the same event type per channel (debounce).
const DEBOUNCE_SECS: u64 = 5;

/// Events that export user-authored content (the prompt text itself) to
/// external sinks — IM channels, webhooks, and the outbound message log. They
/// are NOT part of the default ("all events") feed: a null/absent filter
/// EXCLUDES them, so an install that never customized its filter does not begin
/// forwarding prompt text after upgrade. The user must enable them
/// deliberately, which persists an explicit filter list containing the id.
const DEFAULT_OFF_EVENTS: &[&str] = &["user_prompt_sent"];
/// How often to refresh cached config from DB.
const CONFIG_CACHE_TTL_SECS: u64 = 30;

const MESSAGE_LANGUAGE_KEY: &str = "chat_message_language";
const EVENT_FILTER_KEY: &str = "chat_event_filter";
const EVENT_WEBHOOKS_KEY: &str = "chat_event_webhooks";

/// Bumped whenever the Events-tab config (event filter, webhooks, message
/// language) is written. The subscriber's config cache compares this against
/// its last-seen value and refreshes immediately on change, instead of waiting
/// out the `CONFIG_CACHE_TTL_SECS` window — so e.g. disabling a webhook stops
/// deliveries on the next event rather than up to 30s later.
static EVENT_CONFIG_EPOCH: AtomicU64 = AtomicU64::new(0);

/// Signal that the Events-tab config changed; call after a successful write.
pub fn bump_event_config_epoch() {
    EVENT_CONFIG_EPOCH.fetch_add(1, Ordering::Relaxed);
}

struct CachedChannel {
    id: i32,
    event_filter_json: Option<String>,
}

struct EventConfigCache {
    lang: Lang,
    global_filter: Option<Vec<String>>,
    /// Whether `global_filter` currently reflects a clean read for the latest
    /// observed config. While it does NOT, the filter is UNKNOWN and
    /// `process_envelope` fails CLOSED (suppresses all pushes) rather than fall
    /// back to the cached value. It is false in two cases:
    ///   - cold start, before any clean read — a startup DB error or a corrupt
    ///     stored value must not broadcast events a restrictive config would have
    ///     blocked, so we must not fall back to the broad default set; and
    ///   - after a config change (epoch bump) whose new filter could not be
    ///     loaded — the cached filter predates the change and may be BROADER than
    ///     the user's new intent, so it must not keep gating delivery.
    ///
    /// `global_filter == None` is ambiguous on its own (unread vs. cleanly-read
    /// default), and the cached value is ambiguous after a change (stale vs.
    /// current); this flag disambiguates both.
    filter_known: bool,
    enabled_channels: Vec<CachedChannel>,
    /// Channel-agnostic webhook sinks. Receive the same globally-filtered event
    /// feed as IM channels, but are not debounced and ignore the per-channel
    /// filter (an automation consumer wants the complete stream).
    webhooks: Vec<String>,
    /// `None` until the first clean refresh, which is what forces one.
    ///
    /// This used to be a plain `Instant` seeded with
    /// `Instant::now() - Duration::from_secs(TTL + 1)`, which is a panic, not a
    /// saturating subtraction: `Sub<Duration> for Instant` is a `checked_sub`
    /// plus `expect`. On Windows an `Instant` is the QPC reading, i.e. time
    /// since boot, so starting codeg inside the first 31 seconds of a boot
    /// aborted the process here. codeg ships an autostart plugin, so launching
    /// at login is an ordinary case, and this runs inside a long-lived spawned
    /// task with nobody at the keyboard.
    last_refresh: Option<Instant>,
    /// Value of `EVENT_CONFIG_EPOCH` at the last refresh; a mismatch forces an
    /// immediate refresh even within the TTL window.
    last_epoch: u64,
}

impl EventConfigCache {
    fn new() -> Self {
        Self {
            lang: Lang::default(),
            global_filter: None,
            // Unknown until the first clean read; process_envelope fails closed.
            filter_known: false,
            enabled_channels: Vec::new(),
            webhooks: Vec::new(),
            // Force refresh on first use
            last_refresh: None,
            last_epoch: 0,
        }
    }

    async fn refresh_if_needed(&mut self, db: &DatabaseConnection) {
        self.refresh_with_epoch(db, EVENT_CONFIG_EPOCH.load(Ordering::Relaxed))
            .await;
    }

    /// Refresh against an explicitly-supplied config epoch. `refresh_if_needed`
    /// passes the live `EVENT_CONFIG_EPOCH`; tests pass a fixed value so the
    /// `config_changed` decision is deterministic and doesn't depend on the
    /// process-global atomic (which other parallel tests mutate).
    async fn refresh_with_epoch(&mut self, db: &DatabaseConnection, epoch: u64) {
        // Skip only when neither the TTL has elapsed NOR the config epoch moved.
        // A config write (filter, webhooks, or language) bumps the epoch. When it
        // no longer matches the epoch of our last clean filter read, a change is
        // pending and the cached global_filter may already be out of date.
        let config_changed = epoch != self.last_epoch;
        if !config_changed
            && self
                .last_refresh
                .is_some_and(|at| at.elapsed() < Duration::from_secs(CONFIG_CACHE_TTL_SECS))
        {
            return;
        }

        if let Ok(Some(val)) = app_metadata_service::get_value(db, MESSAGE_LANGUAGE_KEY).await {
            self.lang = Lang::from_str_lossy(&val);
        }

        // Global event filter — the gate governing ALL delivery. Treat it as
        // KNOWN (and only then advance the epoch/TTL below) when the read AND
        // parse both succeed. A transient DB error or a corrupt stored value
        // leaves the prior value untouched and the read marked failed, so:
        //   - at cold start the filter stays UNKNOWN and process_envelope fails
        //     CLOSED (suppresses) rather than falling back to the broad default;
        //   - after a config change we keep retrying on the next event instead of
        //     holding a possibly-stale (broader) filter for the whole TTL window,
        //     and (see below) fail CLOSED meanwhile.
        // Successful-read cases:
        //   - no row / JSON "null" → the default set (None)
        //   - JSON [..]            → an explicit allow-list
        let filter_ok = match app_metadata_service::get_value(db, EVENT_FILTER_KEY).await {
            Ok(None) => {
                self.global_filter = None;
                self.filter_known = true;
                true
            }
            Ok(Some(json)) => match serde_json::from_str::<Option<Vec<String>>>(&json) {
                Ok(parsed) => {
                    self.global_filter = parsed;
                    self.filter_known = true;
                    true
                }
                // Corrupt value: keep the prior cached value, retry later.
                Err(_) => false,
            },
            // DB error: keep the prior cached value, retry later.
            Err(_) => false,
        };

        // A config change is pending (epoch advanced) but the new filter could
        // not be loaded. The cached filter predates the change and may be BROADER
        // than the user's new intent — keeping it as the delivery gate would leak
        // events the change might have disabled (e.g. a just-toggled-off
        // user_prompt_sent). Mark the filter UNKNOWN so process_envelope fails
        // CLOSED until a clean read for this change lands. A pure TTL refresh that
        // fails (epoch unchanged) instead keeps the still-valid prior filter, so a
        // transient blip doesn't drop legitimate notifications when nothing changed.
        if !filter_ok && config_changed {
            self.filter_known = false;
        }

        // Webhook delivery set — only ENABLED URLs. Absent/unparseable means no
        // webhooks configured.
        self.webhooks = app_metadata_service::get_value(db, EVENT_WEBHOOKS_KEY)
            .await
            .ok()
            .flatten()
            .map(|json| super::webhook::enabled_webhook_urls(&json))
            .unwrap_or_default();

        if let Ok(channels) = chat_channel_service::list_enabled(db).await {
            self.enabled_channels = channels
                .into_iter()
                .map(|ch| CachedChannel {
                    id: ch.id,
                    event_filter_json: ch.event_filter_json,
                })
                .collect();
        }

        // Only mark the cache refreshed for this epoch/TTL window when the global
        // filter — the gate governing ALL delivery — loaded cleanly. A failed
        // filter read leaves the cache eligible to retry on the very next event
        // instead of holding a possibly-stale (or still-unknown) filter until the
        // TTL elapses. The other reads above already keep-prior / fail-closed on
        // their own errors, so re-reading them while retrying is harmless.
        if filter_ok {
            self.last_refresh = Some(Instant::now());
            self.last_epoch = epoch;
        }
    }
}

pub fn spawn_event_subscriber(
    bus: Arc<InternalEventBus>,
    manager: ChatChannelManager,
    db_conn: DatabaseConnection,
    bridge: Arc<Mutex<SessionBridge>>,
) -> JoinHandle<()> {
    // Subscribe synchronously before the spawn so the broadcast buffer
    // catches any events emitted in the gap between `start_background`
    // returning and the spawned task's first `rx.recv().await` poll.
    let mut rx = bus.subscribe();
    let metrics = Arc::clone(bus.metrics());

    tokio::spawn(async move {
        let mut last_push: HashMap<(i32, String), Instant> = HashMap::new();
        let mut config = EventConfigCache::new();
        // One reqwest client, reused (and cheaply cloned) for every webhook POST.
        let webhook_client = super::webhook::make_webhook_client();
        let mut lag_throttle = LagLogThrottle::new(LAG_LOG_WINDOW);

        loop {
            let envelope_arc = match rx.recv().await {
                Ok(e) => e,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    metrics.lagged_count.fetch_add(n, Ordering::Relaxed);
                    if let Some(s) = lag_throttle.record(n) {
                        tracing::warn!(
                            "[ChatChannel] event subscriber lagged: dropped {} messages across \
                             {} occurrence(s) in the last {}s",
                            s.dropped,
                            s.occurrences,
                            LAG_LOG_WINDOW.as_secs()
                        );
                    }
                    continue;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    tracing::info!("[ChatChannel] internal bus closed, stopping subscriber");
                    break;
                }
            };

            config.refresh_if_needed(&db_conn).await;

            // Prune stale debounce entries
            last_push.retain(|_, t| t.elapsed() < Duration::from_secs(DEBOUNCE_SECS * 2));

            process_envelope(
                envelope_arc.as_ref(),
                &bridge,
                &manager,
                &db_conn,
                &config,
                &mut last_push,
                &webhook_client,
            )
            .await;
        }
    })
}

/// Handle a single bus envelope: map it to a chat-channel push, apply the
/// global + per-channel event filters and the per-(channel, event) debounce,
/// then fan out to the enabled channels and log the outcome.
///
/// Extracted from the subscriber loop so the filter/dedup/debounce logic is
/// unit-testable against a recording backend.
#[allow(clippy::too_many_arguments)]
async fn process_envelope(
    envelope: &EventEnvelope,
    bridge: &Arc<Mutex<SessionBridge>>,
    manager: &ChatChannelManager,
    db_conn: &DatabaseConnection,
    config: &EventConfigCache,
    last_push: &mut HashMap<(i32, String), Instant>,
    webhook_client: &reqwest::Client,
) {
    let Some((event_type, msg)) = parse_acp_event(&envelope.payload, config.lang) else {
        return;
    };

    // Fail closed unless the global filter reflects a clean read for the latest
    // config. An unread/unreadable filter (cold-start DB error or corrupt value)
    // must NOT fall back to the broad default set, and a filter left stale by a
    // config change whose new value couldn't be loaded must NOT keep gating with a
    // possibly-broader rule. Both leave `filter_known == false`; neither
    // `global_filter == None` nor the cached value can distinguish those states on
    // their own, so gate on the explicit known flag.
    if !config.filter_known {
        return;
    }

    // Global event filter first — a filtered-out event needs no bridge lock or
    // fan-out work. A null filter is the default set: opt-in events that export
    // prompt text (DEFAULT_OFF_EVENTS) stay off until the user enables them
    // (which materializes an explicit filter list containing the id).
    match &config.global_filter {
        Some(filter) => {
            if !filter.contains(&event_type) {
                return;
            }
        }
        None => {
            if DEFAULT_OFF_EVENTS.contains(&event_type.as_str()) {
                return;
            }
        }
    }

    // A permission request from a session that was started FROM a chat channel
    // is already handled interactively (with `/approve`, `/deny`) by the session
    // relay, scoped to its owning channel. Suppress the generic global push for
    // those connections so they aren't double-notified — the global event feed
    // exists for the desktop / web sessions the user isn't driving from chat.
    if event_type == "permission_request"
        && bridge.lock().await.get(&envelope.connection_id).is_some()
    {
        return;
    }

    // Webhook fan-out: channel-agnostic, shares the global gates above but is
    // independent of the per-channel filter and the debounce below. Built once
    // and delivered fire-and-forget so an unreachable endpoint can't stall the
    // subscriber loop. Runs even with zero enabled IM channels.
    if !config.webhooks.is_empty() {
        let payload =
            super::webhook::build_webhook_payload(&event_type, &envelope.connection_id, &msg);
        super::webhook::spawn_webhook_delivery(
            webhook_client.clone(),
            config.webhooks.clone(),
            payload,
        );
    }

    // Some events bypass the per-(channel, event) debounce. That debounce
    // throttles high-frequency events like turn_complete, but these are discrete,
    // individually-meaningful events that must each deliver:
    //   - permission_request: a blocking gate; a second gate on the same
    //     connection (sequential) or a concurrent agent's gate within the 5s
    //     window would otherwise be dropped — and a blocked agent emits no
    //     further event to re-trigger the lost nudge.
    //   - user_prompt_sent: each user message is a distinct action a consumer
    //     wants to see; coalescing two messages sent within 5s would silently
    //     swallow the second.
    //   - question_request: like permission_request, a blocking interactive
    //     gate (the agent is parked on ask_user_question); a second gate within
    //     the 5s window would be dropped with no later event to re-trigger it.
    let debounced = !matches!(
        event_type.as_str(),
        "permission_request" | "user_prompt_sent" | "question_request"
    );

    for ch in &config.enabled_channels {
        // Per-channel event filter
        if let Some(filter_json) = &ch.event_filter_json {
            if let Ok(filter) = serde_json::from_str::<Vec<String>>(filter_json) {
                if !filter.contains(&event_type) {
                    continue;
                }
            }
        }

        // Debounce: skip if the same event type was pushed to this channel
        // recently (permission_request is exempt — see above).
        let key = (ch.id, event_type.clone());
        let now = Instant::now();
        if debounced {
            if let Some(last) = last_push.get(&key) {
                if now.duration_since(*last) < Duration::from_secs(DEBOUNCE_SECS) {
                    continue;
                }
            }
        }

        // Send
        let send_result = manager.send_to_channel(ch.id, &msg).await;
        let (status, error_detail) = match &send_result {
            Ok(_) => {
                // Only update the debounce timestamp on success, and only for
                // debounced event types.
                if debounced {
                    last_push.insert(key, now);
                }
                ("sent", None)
            }
            Err(e) => ("failed", Some(e.to_string())),
        };

        let _ = chat_channel_message_log_service::create_log(
            db_conn,
            ch.id,
            "outbound",
            "event_push",
            &msg.to_plain_text(),
            status,
            error_detail,
        )
        .await;
    }
}

/// Map an ACP event into the chat-channel push tuple. Pattern-match on the
/// typed `AcpEvent` variant — Phase 5 source-of-truth replaces the prior
/// JSON `type`-string dispatch (which paid `serde_json::from_value` per
/// event for the global broadcaster path).
fn parse_acp_event(payload: &AcpEvent, lang: Lang) -> Option<(String, RichMessage)> {
    match payload {
        AcpEvent::TurnComplete {
            stop_reason,
            agent_type,
            ..
        } => {
            // Only push for end_turn, not for intermediate completions.
            if stop_reason != "end_turn" {
                return None;
            }
            Some((
                "turn_complete".to_string(),
                message_formatter::format_turn_complete(agent_type, stop_reason, lang),
            ))
        }
        AcpEvent::Error {
            message,
            agent_type,
            ..
        } => Some((
            "error".to_string(),
            message_formatter::format_agent_error(agent_type, message, lang),
        )),
        AcpEvent::PermissionRequest { tool_call, .. } => Some((
            "permission_request".to_string(),
            message_formatter::format_permission_request(tool_call, lang),
        )),
        AcpEvent::UserPromptSent { text_preview } => Some((
            "user_prompt_sent".to_string(),
            message_formatter::format_user_prompt_sent(text_preview, lang),
        )),
        AcpEvent::QuestionRequest { questions, .. } => Some((
            "question_request".to_string(),
            message_formatter::format_question_request(questions, lang),
        )),
        _ => None,
    }
}

#[cfg(test)]
mod permission_push_tests {
    //! Coverage for the global permission-request push: it fires for desktop /
    //! web sessions, is suppressed for chat-channel-bridged connections (whose
    //! interactive `/approve` flow lives in the session relay), still honours
    //! the global event filter, and doesn't regress the existing turn_complete
    //! push after the `process_envelope` extraction.
    use super::*;
    use crate::chat_channel::error::ChatChannelError;
    use crate::chat_channel::session_bridge::ActiveSession;
    use crate::chat_channel::traits::ChatChannelBackend;
    use crate::chat_channel::types::{
        ChannelConnectionStatus, ChannelType, IncomingCommand, SentMessageId,
    };
    use crate::db::test_helpers;
    use crate::models::agent::AgentType;
    use async_trait::async_trait;
    use std::collections::HashSet;
    use tokio::sync::mpsc;

    /// Channel backend that records the rendered plain text of every message,
    /// so a test can assert the exact lines pushed (or that none were).
    #[derive(Clone, Default)]
    struct Recorder {
        msgs: Arc<Mutex<Vec<String>>>,
    }
    struct RecordingBackend {
        rec: Recorder,
    }

    #[async_trait]
    impl ChatChannelBackend for RecordingBackend {
        fn channel_type(&self) -> ChannelType {
            ChannelType::Telegram
        }
        async fn start(&self, _tx: mpsc::Sender<IncomingCommand>) -> Result<(), ChatChannelError> {
            Ok(())
        }
        async fn stop(&self) -> Result<(), ChatChannelError> {
            Ok(())
        }
        async fn status(&self) -> ChannelConnectionStatus {
            ChannelConnectionStatus::Connected
        }
        async fn send_message(&self, text: &str) -> Result<SentMessageId, ChatChannelError> {
            self.rec.msgs.lock().await.push(text.to_string());
            Ok(SentMessageId("1".into()))
        }
        async fn send_rich_message(
            &self,
            message: &RichMessage,
        ) -> Result<SentMessageId, ChatChannelError> {
            self.rec.msgs.lock().await.push(message.to_plain_text());
            Ok(SentMessageId("1".into()))
        }
        async fn test_connection(&self) -> Result<(), ChatChannelError> {
            Ok(())
        }
    }

    async fn manager_with_recorder(channel_id: i32) -> (ChatChannelManager, Recorder) {
        let chat = ChatChannelManager::new();
        let rec = Recorder::default();
        chat.add_channel(
            channel_id,
            "test".into(),
            ChannelType::Telegram,
            Box::new(RecordingBackend { rec: rec.clone() }),
        )
        .await
        .unwrap();
        (chat, rec)
    }

    fn config_all_on(channel_id: i32) -> EventConfigCache {
        EventConfigCache {
            lang: Lang::En,
            global_filter: None,
            // Simulates a cache that has already read the filter cleanly.
            filter_known: true,
            enabled_channels: vec![CachedChannel {
                id: channel_id,
                event_filter_json: None,
            }],
            webhooks: Vec::new(),
            last_refresh: Some(Instant::now()),
            last_epoch: 0,
        }
    }

    /// Shared no-op client for tests that don't configure webhooks; with
    /// `config.webhooks` empty, `process_envelope` never issues a request.
    fn test_client() -> reqwest::Client {
        reqwest::Client::new()
    }

    /// Accept one connection, read the full HTTP/1.1 request (headers +
    /// Content-Length body), reply 200 so the detached delivery task resolves,
    /// and return the raw request text.
    async fn accept_request(listener: &tokio::net::TcpListener) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut buf = Vec::new();
        let mut chunk = [0u8; 1024];
        loop {
            if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                let header_end = pos + 4;
                let headers = String::from_utf8_lossy(&buf[..header_end]).to_lowercase();
                let len = headers
                    .lines()
                    .find_map(|l| {
                        l.strip_prefix("content-length:")
                            .and_then(|v| v.trim().parse::<usize>().ok())
                    })
                    .unwrap_or(0);
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

    fn turn_complete_envelope(connection_id: &str) -> EventEnvelope {
        EventEnvelope {
            seq: 1,
            connection_id: connection_id.into(),
            payload: AcpEvent::TurnComplete {
                session_id: "s".into(),
                stop_reason: "end_turn".into(),
                agent_type: "claude_code".into(),
            },
        }
    }

    fn permission_envelope(connection_id: &str) -> EventEnvelope {
        EventEnvelope {
            seq: 1,
            connection_id: connection_id.into(),
            payload: AcpEvent::PermissionRequest {
                request_id: "req-1".into(),
                tool_call: serde_json::json!({
                    "title": "Bash",
                    "rawInput": { "command": "npm test" }
                }),
                options: vec![],
                queued: 0,
            },
        }
    }

    fn user_prompt_envelope(connection_id: &str, text: &str) -> EventEnvelope {
        EventEnvelope {
            seq: 1,
            connection_id: connection_id.into(),
            payload: AcpEvent::UserPromptSent {
                text_preview: text.into(),
            },
        }
    }

    fn question_request_envelope(connection_id: &str) -> EventEnvelope {
        use crate::acp::question::{QuestionOption, QuestionSpec};
        EventEnvelope {
            seq: 1,
            connection_id: connection_id.into(),
            payload: AcpEvent::QuestionRequest {
                question_id: "q-1".into(),
                questions: vec![QuestionSpec {
                    id: "q1".into(),
                    question: "Which approach?".into(),
                    header: "Approach".into(),
                    multi_select: false,
                    options: vec![
                        QuestionOption {
                            label: "MVP first".into(),
                            description: String::new(),
                        },
                        QuestionOption {
                            label: "Risk first".into(),
                            description: String::new(),
                        },
                    ],
                    is_secret: false,
                }],
            },
        }
    }

    fn bridged_session(connection_id: &str, channel_id: i32) -> ActiveSession {
        ActiveSession {
            channel_id,
            sender_id: "u".into(),
            target: crate::chat_channel::types::ChannelMessageTarget::channel(channel_id),
            conversation_id: 1,
            connection_id: connection_id.into(),
            agent_type: AgentType::ClaudeCode,
            content_buffer: String::new(),
            tool_calls: Vec::new(),
            tool_call_inputs: HashMap::new(),
            delegation_rendered: HashSet::new(),
            last_flushed: Instant::now(),
            pending_prompt: None,
            permission_pending: None,
        }
    }

    async fn sent(rec: &Recorder) -> Vec<String> {
        rec.msgs.lock().await.clone()
    }

    /// A permission request from a NON-bridged (desktop / web) connection is
    /// pushed, carrying the localized title and the rendered operation detail.
    #[tokio::test]
    async fn permission_request_non_bridged_is_pushed() {
        let db = test_helpers::fresh_in_memory_db().await;
        let (chat, rec) = manager_with_recorder(7).await;
        let bridge = Arc::new(Mutex::new(SessionBridge::new()));
        let config = config_all_on(7);
        let mut last_push = HashMap::new();

        process_envelope(
            &permission_envelope("desktop-conn"),
            &bridge,
            &chat,
            &db.conn,
            &config,
            &mut last_push,
            &test_client(),
        )
        .await;

        let msgs = sent(&rec).await;
        assert_eq!(msgs.len(), 1, "expected one push, got {msgs:?}");
        assert!(msgs[0].contains("Permission Request"), "got {:?}", msgs[0]);
        assert!(msgs[0].contains("Bash: npm test"), "got {:?}", msgs[0]);
    }

    /// A permission request from a chat-channel-bridged connection is suppressed
    /// here — the session relay owns the interactive flow for that channel.
    #[tokio::test]
    async fn permission_request_bridged_is_suppressed() {
        let db = test_helpers::fresh_in_memory_db().await;
        let (chat, rec) = manager_with_recorder(7).await;
        let bridge = Arc::new(Mutex::new(SessionBridge::new()));
        bridge
            .lock()
            .await
            .register("im-conn".into(), bridged_session("im-conn", 7));
        let config = config_all_on(7);
        let mut last_push = HashMap::new();

        process_envelope(
            &permission_envelope("im-conn"),
            &bridge,
            &chat,
            &db.conn,
            &config,
            &mut last_push,
            &test_client(),
        )
        .await;

        assert!(
            sent(&rec).await.is_empty(),
            "bridged permission request must not be double-pushed"
        );
    }

    /// The global event filter still gates permission_request: with the id
    /// toggled off (filter present, not containing it), nothing is pushed.
    #[tokio::test]
    async fn permission_request_respects_global_filter() {
        let db = test_helpers::fresh_in_memory_db().await;
        let (chat, rec) = manager_with_recorder(7).await;
        let bridge = Arc::new(Mutex::new(SessionBridge::new()));
        let mut config = config_all_on(7);
        config.global_filter = Some(vec!["turn_complete".to_string()]);
        let mut last_push = HashMap::new();

        process_envelope(
            &permission_envelope("desktop-conn"),
            &bridge,
            &chat,
            &db.conn,
            &config,
            &mut last_push,
            &test_client(),
        )
        .await;

        assert!(sent(&rec).await.is_empty());
    }

    /// Permission requests bypass the debounce: two distinct agents blocking on
    /// a gate back-to-back (well inside the 5s window) must BOTH be pushed,
    /// because a blocked agent emits no further event to re-trigger a lost nudge.
    #[tokio::test]
    async fn permission_requests_are_not_debounced() {
        let db = test_helpers::fresh_in_memory_db().await;
        let (chat, rec) = manager_with_recorder(7).await;
        let bridge = Arc::new(Mutex::new(SessionBridge::new()));
        let config = config_all_on(7);
        let mut last_push = HashMap::new();

        process_envelope(
            &permission_envelope("conn-a"),
            &bridge,
            &chat,
            &db.conn,
            &config,
            &mut last_push,
            &test_client(),
        )
        .await;
        process_envelope(
            &permission_envelope("conn-b"),
            &bridge,
            &chat,
            &db.conn,
            &config,
            &mut last_push,
            &test_client(),
        )
        .await;

        assert_eq!(
            sent(&rec).await.len(),
            2,
            "both concurrent permission gates must be delivered"
        );
    }

    /// The reviewer's exact common path: ONE connection approves a first gate
    /// (e.g. ExitPlanMode) and immediately hits a second (e.g. Bash) well inside
    /// the 5s window. Both must deliver. Distinct from the test above, which
    /// covers two *different* connections — here the connection_id is identical,
    /// proving the exemption is connection-agnostic (debounce keys on
    /// (channel, event), so a blocked agent's follow-up gate is never swallowed).
    #[tokio::test]
    async fn permission_requests_same_connection_sequential_not_debounced() {
        let db = test_helpers::fresh_in_memory_db().await;
        let (chat, rec) = manager_with_recorder(7).await;
        let bridge = Arc::new(Mutex::new(SessionBridge::new()));
        let config = config_all_on(7);
        let mut last_push = HashMap::new();

        let gate = |title: &str, raw: serde_json::Value| EventEnvelope {
            seq: 1,
            connection_id: "conn-a".into(),
            payload: AcpEvent::PermissionRequest {
                request_id: "req".into(),
                tool_call: serde_json::json!({ "title": title, "rawInput": raw }),
                options: vec![],
                queued: 0,
            },
        };

        process_envelope(
            &gate("ExitPlanMode", serde_json::json!({})),
            &bridge,
            &chat,
            &db.conn,
            &config,
            &mut last_push,
            &test_client(),
        )
        .await;
        process_envelope(
            &gate("Bash", serde_json::json!({ "command": "npm run build" })),
            &bridge,
            &chat,
            &db.conn,
            &config,
            &mut last_push,
            &test_client(),
        )
        .await;

        let msgs = sent(&rec).await;
        assert_eq!(
            msgs.len(),
            2,
            "both sequential gates on one connection must deliver, got {msgs:?}"
        );
    }

    /// Contrast: turn_complete is still debounced — a second one within the 5s
    /// window is dropped. Guards against accidentally exempting everything.
    #[tokio::test]
    async fn turn_complete_is_debounced_within_window() {
        let db = test_helpers::fresh_in_memory_db().await;
        let (chat, rec) = manager_with_recorder(7).await;
        let bridge = Arc::new(Mutex::new(SessionBridge::new()));
        let config = config_all_on(7);
        let mut last_push = HashMap::new();

        let turn_complete = || EventEnvelope {
            seq: 1,
            connection_id: "c".into(),
            payload: AcpEvent::TurnComplete {
                session_id: "s".into(),
                stop_reason: "end_turn".into(),
                agent_type: "claude_code".into(),
            },
        };
        process_envelope(
            &turn_complete(),
            &bridge,
            &chat,
            &db.conn,
            &config,
            &mut last_push,
            &test_client(),
        )
        .await;
        process_envelope(
            &turn_complete(),
            &bridge,
            &chat,
            &db.conn,
            &config,
            &mut last_push,
            &test_client(),
        )
        .await;

        assert_eq!(
            sent(&rec).await.len(),
            1,
            "second turn_complete within 5s must be debounced"
        );
    }

    /// Regression: turn_complete (end_turn) still pushes after the refactor.
    #[tokio::test]
    async fn turn_complete_still_pushes() {
        let db = test_helpers::fresh_in_memory_db().await;
        let (chat, rec) = manager_with_recorder(7).await;
        let bridge = Arc::new(Mutex::new(SessionBridge::new()));
        let config = config_all_on(7);
        let mut last_push = HashMap::new();

        let envelope = EventEnvelope {
            seq: 1,
            connection_id: "c".into(),
            payload: AcpEvent::TurnComplete {
                session_id: "s".into(),
                stop_reason: "end_turn".into(),
                agent_type: "claude_code".into(),
            },
        };
        process_envelope(
            &envelope,
            &bridge,
            &chat,
            &db.conn,
            &config,
            &mut last_push,
            &test_client(),
        )
        .await;

        assert_eq!(sent(&rec).await.len(), 1);
    }

    /// Once explicitly enabled (filter contains the id), a user_prompt_sent
    /// event is pushed, carrying the localized title and the message text as the
    /// body.
    #[tokio::test]
    async fn user_prompt_sent_is_pushed() {
        let db = test_helpers::fresh_in_memory_db().await;
        let (chat, rec) = manager_with_recorder(7).await;
        let bridge = Arc::new(Mutex::new(SessionBridge::new()));
        let mut config = config_all_on(7);
        // Opt-in: user_prompt_sent is suppressed under the default null filter,
        // so an explicit list that includes it is required for delivery.
        config.global_filter = Some(vec!["user_prompt_sent".to_string()]);
        let mut last_push = HashMap::new();

        process_envelope(
            &user_prompt_envelope("desktop-conn", "refactor the auth module"),
            &bridge,
            &chat,
            &db.conn,
            &config,
            &mut last_push,
            &test_client(),
        )
        .await;

        let msgs = sent(&rec).await;
        assert_eq!(msgs.len(), 1, "expected one push, got {msgs:?}");
        assert!(msgs[0].contains("User Message"), "got {:?}", msgs[0]);
        assert!(
            msgs[0].contains("refactor the auth module"),
            "got {:?}",
            msgs[0]
        );
    }

    /// user_prompt_sent bypasses the debounce: two distinct user messages within
    /// the 5s window must BOTH deliver (each is a discrete user action).
    #[tokio::test]
    async fn user_prompt_sent_is_not_debounced() {
        let db = test_helpers::fresh_in_memory_db().await;
        let (chat, rec) = manager_with_recorder(7).await;
        let bridge = Arc::new(Mutex::new(SessionBridge::new()));
        let mut config = config_all_on(7);
        config.global_filter = Some(vec!["user_prompt_sent".to_string()]);
        let mut last_push = HashMap::new();

        process_envelope(
            &user_prompt_envelope("c", "first message"),
            &bridge,
            &chat,
            &db.conn,
            &config,
            &mut last_push,
            &test_client(),
        )
        .await;
        process_envelope(
            &user_prompt_envelope("c", "second message"),
            &bridge,
            &chat,
            &db.conn,
            &config,
            &mut last_push,
            &test_client(),
        )
        .await;

        assert_eq!(
            sent(&rec).await.len(),
            2,
            "both user messages within 5s must be delivered"
        );
    }

    /// The global event filter gates user_prompt_sent: with the id toggled off
    /// (filter present, not containing it), nothing is pushed.
    #[tokio::test]
    async fn user_prompt_sent_respects_global_filter() {
        let db = test_helpers::fresh_in_memory_db().await;
        let (chat, rec) = manager_with_recorder(7).await;
        let bridge = Arc::new(Mutex::new(SessionBridge::new()));
        let mut config = config_all_on(7);
        config.global_filter = Some(vec!["turn_complete".to_string()]);
        let mut last_push = HashMap::new();

        process_envelope(
            &user_prompt_envelope("desktop-conn", "hello"),
            &bridge,
            &chat,
            &db.conn,
            &config,
            &mut last_push,
            &test_client(),
        )
        .await;

        assert!(sent(&rec).await.is_empty());
    }

    /// Opt-in default: with NO explicit filter configured (null = the default
    /// "all events" set), user_prompt_sent is suppressed — it must not forward
    /// prompt text to channels until the user enables it deliberately. Contrast
    /// `turn_complete_still_pushes`, which DOES fire under the same null filter.
    #[tokio::test]
    async fn user_prompt_sent_off_by_default() {
        let db = test_helpers::fresh_in_memory_db().await;
        let (chat, rec) = manager_with_recorder(7).await;
        let bridge = Arc::new(Mutex::new(SessionBridge::new()));
        let config = config_all_on(7); // global_filter = None (the default)
        let mut last_push = HashMap::new();

        process_envelope(
            &user_prompt_envelope("desktop-conn", "secret prompt text"),
            &bridge,
            &chat,
            &db.conn,
            &config,
            &mut last_push,
            &test_client(),
        )
        .await;

        assert!(
            sent(&rec).await.is_empty(),
            "user_prompt_sent must be off under the default null filter"
        );
    }

    /// The opt-in default also gates webhooks: under the null filter, a
    /// configured webhook receives no user_prompt_sent delivery (no inbound
    /// connection). Mirrors `webhook_suppressed_by_global_filter`.
    #[tokio::test]
    async fn user_prompt_sent_off_by_default_for_webhooks() {
        use tokio::net::TcpListener;

        let db = test_helpers::fresh_in_memory_db().await;
        let (chat, _rec) = manager_with_recorder(7).await;
        let bridge = Arc::new(Mutex::new(SessionBridge::new()));
        let mut last_push = HashMap::new();

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let mut config = config_all_on(7); // global_filter = None (the default)
        config.webhooks = vec![format!("http://{addr}/hook")];

        process_envelope(
            &user_prompt_envelope("desktop-conn", "secret prompt text"),
            &bridge,
            &chat,
            &db.conn,
            &config,
            &mut last_push,
            &test_client(),
        )
        .await;

        let accepted = tokio::time::timeout(Duration::from_millis(400), listener.accept()).await;
        assert!(
            accepted.is_err(),
            "default-off user_prompt_sent must not reach a webhook"
        );
    }

    /// A configured webhook receives a POST with the structured JSON payload
    /// when an event passes the global gates — proving the subscriber wiring
    /// (config.webhooks → spawn_webhook_delivery → HTTP POST) end to end.
    #[tokio::test]
    async fn webhook_receives_post_for_event() {
        use tokio::net::TcpListener;

        let db = test_helpers::fresh_in_memory_db().await;
        let (chat, _rec) = manager_with_recorder(7).await;
        let bridge = Arc::new(Mutex::new(SessionBridge::new()));
        let mut last_push = HashMap::new();

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { accept_request(&listener).await });

        let mut config = config_all_on(7);
        config.webhooks = vec![format!("http://{addr}/hook")];

        process_envelope(
            &turn_complete_envelope("desktop-conn"),
            &bridge,
            &chat,
            &db.conn,
            &config,
            &mut last_push,
            &test_client(),
        )
        .await;

        let request = tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .expect("webhook should be delivered within 5s")
            .unwrap();
        assert!(request.starts_with("POST /hook"), "got: {request}");
        assert!(
            request.contains("\"event\":\"turn_complete\""),
            "got: {request}"
        );
        assert!(
            request.contains("\"connection_id\":\"desktop-conn\""),
            "got: {request}"
        );
    }

    /// The global event filter gates webhooks too: with `turn_complete` toggled
    /// off, the configured webhook receives nothing (no connection attempt).
    #[tokio::test]
    async fn webhook_suppressed_by_global_filter() {
        use tokio::net::TcpListener;

        let db = test_helpers::fresh_in_memory_db().await;
        let (chat, _rec) = manager_with_recorder(7).await;
        let bridge = Arc::new(Mutex::new(SessionBridge::new()));
        let mut last_push = HashMap::new();

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let mut config = config_all_on(7);
        config.global_filter = Some(vec!["error".to_string()]); // turn_complete off
        config.webhooks = vec![format!("http://{addr}/hook")];

        process_envelope(
            &turn_complete_envelope("desktop-conn"),
            &bridge,
            &chat,
            &db.conn,
            &config,
            &mut last_push,
            &test_client(),
        )
        .await;

        // No delivery → no inbound connection within the window.
        let accepted = tokio::time::timeout(Duration::from_millis(400), listener.accept()).await;
        assert!(
            accepted.is_err(),
            "filtered-out event must not reach the webhook"
        );
    }

    /// A permission request from a chat-channel-bridged connection is suppressed
    /// for webhooks as well (dispatch sits behind the same early-return).
    #[tokio::test]
    async fn webhook_suppressed_for_bridged_permission() {
        use tokio::net::TcpListener;

        let db = test_helpers::fresh_in_memory_db().await;
        let (chat, _rec) = manager_with_recorder(7).await;
        let bridge = Arc::new(Mutex::new(SessionBridge::new()));
        bridge
            .lock()
            .await
            .register("im-conn".into(), bridged_session("im-conn", 7));
        let mut last_push = HashMap::new();

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let mut config = config_all_on(7);
        config.webhooks = vec![format!("http://{addr}/hook")];

        process_envelope(
            &permission_envelope("im-conn"),
            &bridge,
            &chat,
            &db.conn,
            &config,
            &mut last_push,
            &test_client(),
        )
        .await;

        let accepted = tokio::time::timeout(Duration::from_millis(400), listener.accept()).await;
        assert!(
            accepted.is_err(),
            "bridged permission request must not reach the webhook"
        );
    }

    /// Webhooks are intentionally NOT debounced: two `turn_complete` events
    /// inside the 5s window each deliver, even though the IM-channel push of the
    /// second is debounced (contrast `turn_complete_is_debounced_within_window`).
    #[tokio::test]
    async fn webhook_is_not_debounced() {
        use tokio::net::TcpListener;

        let db = test_helpers::fresh_in_memory_db().await;
        let (chat, _rec) = manager_with_recorder(7).await;
        let bridge = Arc::new(Mutex::new(SessionBridge::new()));
        let mut last_push = HashMap::new();

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        // Each event opens its own connection; collect both.
        let server = tokio::spawn(async move {
            let first = accept_request(&listener).await;
            let second = accept_request(&listener).await;
            (first, second)
        });

        let mut config = config_all_on(7);
        config.webhooks = vec![format!("http://{addr}/hook")];

        for _ in 0..2 {
            process_envelope(
                &turn_complete_envelope("c"),
                &bridge,
                &chat,
                &db.conn,
                &config,
                &mut last_push,
                &test_client(),
            )
            .await;
        }

        let (first, second) = tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .expect("both webhook deliveries should arrive within 5s")
            .unwrap();
        assert!(first.starts_with("POST /hook"), "got: {first}");
        assert!(second.starts_with("POST /hook"), "got: {second}");
    }

    /// Disabling a webhook takes effect on the next event, not up to 30s later:
    /// the config-epoch bump on write forces `refresh_if_needed` to re-read even
    /// though the TTL window has not elapsed.
    #[tokio::test]
    async fn webhook_disable_refreshes_within_ttl_window() {
        use crate::chat_channel::webhook::WebhookConfig;
        use crate::commands::chat_channel::set_chat_event_webhooks_core;

        let db = test_helpers::fresh_in_memory_db().await;

        set_chat_event_webhooks_core(
            &db,
            vec![WebhookConfig {
                url: "https://a.test/h".into(),
                enabled: true,
            }],
        )
        .await
        .unwrap();

        let mut config = EventConfigCache::new();
        config.refresh_if_needed(&db.conn).await;
        assert_eq!(config.webhooks, vec!["https://a.test/h".to_string()]);
        // The just-completed refresh resets last_refresh to ~now, so the TTL has
        // NOT elapsed for the second call — only the epoch bump can force it.

        set_chat_event_webhooks_core(
            &db,
            vec![WebhookConfig {
                url: "https://a.test/h".into(),
                enabled: false,
            }],
        )
        .await
        .unwrap();
        config.refresh_if_needed(&db.conn).await;
        assert!(
            config.webhooks.is_empty(),
            "disabled webhook must drop out of the dispatch set within the TTL window"
        );
    }

    /// A corrupt read AFTER a config change (epoch bumped) must fail CLOSED, not
    /// keep gating with the now-stale prior filter. The cached value is retained
    /// (never widened to the default set), but `filter_known` flips to false so
    /// `process_envelope` suppresses everything until a clean read for the change
    /// lands — the user's narrowing can't be undone by a momentary glitch.
    #[tokio::test]
    async fn corrupt_filter_after_config_change_fails_closed() {
        use crate::commands::chat_channel::set_chat_event_filter_core;

        let db = test_helpers::fresh_in_memory_db().await;

        // Establish an explicit, restrictive filter (only "error").
        set_chat_event_filter_core(&db, Some(vec!["error".to_string()]))
            .await
            .unwrap();
        let mut config = EventConfigCache::new();
        config.refresh_if_needed(&db.conn).await;
        assert_eq!(config.global_filter, Some(vec!["error".to_string()]));
        assert!(config.filter_known);

        // Corrupt the stored value directly, then force a refresh via the epoch
        // (simulating a failed read landing right after a config change).
        app_metadata_service::upsert_value(&db.conn, EVENT_FILTER_KEY, "{not valid json")
            .await
            .unwrap();
        bump_event_config_epoch();
        config.refresh_if_needed(&db.conn).await;

        assert_eq!(
            config.global_filter,
            Some(vec!["error".to_string()]),
            "a corrupt stored filter must not widen delivery to the default set"
        );
        assert!(
            !config.filter_known,
            "a pending config change with a failed read must fail closed, not keep \
             gating with the stale prior filter"
        );
    }

    /// The Codex scenario end-to-end: a broad filter is in effect, the user
    /// narrows it (epoch bump), but the re-read fails. The previously-broad filter
    /// must NOT keep delivering a now-disabled event — delivery fails closed.
    #[tokio::test]
    async fn stale_broad_filter_after_change_fails_closed_for_delivery() {
        use crate::commands::chat_channel::set_chat_event_filter_core;

        let db = test_helpers::fresh_in_memory_db().await;
        let (chat, rec) = manager_with_recorder(7).await;
        let bridge = Arc::new(Mutex::new(SessionBridge::new()));

        // Broad filter that includes turn_complete; loaded cleanly.
        set_chat_event_filter_core(
            &db,
            Some(vec!["turn_complete".to_string(), "error".to_string()]),
        )
        .await
        .unwrap();
        let mut config = config_all_on(7);
        config.refresh_if_needed(&db.conn).await;
        assert!(config.filter_known);

        // User narrows (would drop turn_complete) but the re-read fails: corrupt
        // the stored value and bump the epoch to model the change + failed load.
        app_metadata_service::upsert_value(&db.conn, EVENT_FILTER_KEY, "{corrupt")
            .await
            .unwrap();
        bump_event_config_epoch();
        config.refresh_if_needed(&db.conn).await;

        let mut last_push = HashMap::new();
        process_envelope(
            &turn_complete_envelope("desktop-conn"),
            &bridge,
            &chat,
            &db.conn,
            &config,
            &mut last_push,
            &test_client(),
        )
        .await;

        assert!(
            sent(&rec).await.is_empty(),
            "a stale-broad filter after an unloaded change must not keep delivering"
        );
    }

    /// Contrast: a failed read during a PURE TTL refresh (no config change, epoch
    /// unchanged) keeps the still-valid cached filter and stays KNOWN — a transient
    /// blip must not drop legitimate notifications when nothing actually changed.
    ///
    /// Drives `refresh_with_epoch` with a FIXED epoch (matching the cache's
    /// `last_epoch`) so `config_changed` is deterministically false — independent
    /// of the process-global `EVENT_CONFIG_EPOCH`, which parallel tests mutate.
    #[tokio::test]
    async fn ttl_refresh_failure_without_change_keeps_filter_known() {
        use crate::commands::chat_channel::set_chat_event_filter_core;

        // Fixed epoch used for BOTH refreshes; `EventConfigCache::new()` starts
        // `last_epoch` at 0, so 0 == 0 → no pending change on the second refresh.
        const EPOCH: u64 = 0;

        let db = test_helpers::fresh_in_memory_db().await;

        // Clean broad filter that includes turn_complete.
        set_chat_event_filter_core(
            &db,
            Some(vec!["turn_complete".to_string(), "error".to_string()]),
        )
        .await
        .unwrap();
        let mut config = EventConfigCache::new();
        config.refresh_with_epoch(&db.conn, EPOCH).await;
        assert!(config.filter_known);

        // Corrupt the value, then force a TTL-only refresh at the SAME epoch:
        // config_changed is false, so the failed read must keep the filter known.
        app_metadata_service::upsert_value(&db.conn, EVENT_FILTER_KEY, "{corrupt")
            .await
            .unwrap();
        config.last_refresh = None;
        config.refresh_with_epoch(&db.conn, EPOCH).await;

        assert!(
            config.filter_known,
            "a TTL-only failed read (no config change) must keep the filter known"
        );
        assert_eq!(
            config.global_filter,
            Some(vec!["turn_complete".to_string(), "error".to_string()]),
            "and keep gating with the still-valid prior filter"
        );
    }

    /// Cold start with the filter still UNKNOWN (never read cleanly): a default-on
    /// event must NOT deliver. Proves the cold-start fail-open is closed — an
    /// unreadable restrictive config can't leak through the broad default set.
    #[tokio::test]
    async fn unknown_filter_fails_closed_for_channels() {
        let db = test_helpers::fresh_in_memory_db().await;
        let (chat, rec) = manager_with_recorder(7).await;
        let bridge = Arc::new(Mutex::new(SessionBridge::new()));
        let mut config = config_all_on(7);
        config.filter_known = false; // never read cleanly yet
        let mut last_push = HashMap::new();

        // turn_complete is a default-ON event, yet it must be suppressed while the
        // filter is unknown.
        process_envelope(
            &turn_complete_envelope("desktop-conn"),
            &bridge,
            &chat,
            &db.conn,
            &config,
            &mut last_push,
            &test_client(),
        )
        .await;

        assert!(
            sent(&rec).await.is_empty(),
            "no event may deliver before the global filter is known"
        );
    }

    /// Cold start with an UNKNOWN filter also gates webhooks (the same upstream
    /// fail-closed return), so a configured webhook receives nothing.
    #[tokio::test]
    async fn unknown_filter_fails_closed_for_webhooks() {
        use tokio::net::TcpListener;

        let db = test_helpers::fresh_in_memory_db().await;
        let (chat, _rec) = manager_with_recorder(7).await;
        let bridge = Arc::new(Mutex::new(SessionBridge::new()));
        let mut last_push = HashMap::new();

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let mut config = config_all_on(7);
        config.filter_known = false;
        config.webhooks = vec![format!("http://{addr}/hook")];

        process_envelope(
            &turn_complete_envelope("desktop-conn"),
            &bridge,
            &chat,
            &db.conn,
            &config,
            &mut last_push,
            &test_client(),
        )
        .await;

        let accepted = tokio::time::timeout(Duration::from_millis(400), listener.accept()).await;
        assert!(
            accepted.is_err(),
            "an unknown filter must not reach the webhook"
        );
    }

    /// A corrupt stored value read at COLD START (no prior clean load) must leave
    /// the filter UNKNOWN — not fall back to the cleanly-read default — so delivery
    /// stays fail-closed until a valid value can be read.
    #[tokio::test]
    async fn cold_corrupt_filter_read_stays_unknown() {
        let db = test_helpers::fresh_in_memory_db().await;
        app_metadata_service::upsert_value(&db.conn, EVENT_FILTER_KEY, "{not valid json")
            .await
            .unwrap();

        let mut config = EventConfigCache::new();
        config.refresh_if_needed(&db.conn).await;

        assert!(
            !config.filter_known,
            "a cold corrupt filter read must remain unknown (fail closed), not become the default set"
        );
    }

    /// A failed filter read must not consume the epoch/TTL: the cache keeps
    /// retrying on the next refresh and picks up a newly-written (narrower) filter
    /// WITHOUT another epoch bump — so a transient failure can't pin a stale,
    /// broader filter for the whole TTL window.
    #[tokio::test]
    async fn failed_filter_read_keeps_retrying_until_clean() {
        use crate::commands::chat_channel::set_chat_event_filter_core;

        let db = test_helpers::fresh_in_memory_db().await;

        // Clean broad filter first.
        set_chat_event_filter_core(
            &db,
            Some(vec!["turn_complete".to_string(), "error".to_string()]),
        )
        .await
        .unwrap();
        let mut config = EventConfigCache::new();
        config.refresh_if_needed(&db.conn).await;
        assert_eq!(
            config.global_filter,
            Some(vec!["turn_complete".to_string(), "error".to_string()])
        );

        // Corrupt + bump epoch: refresh keeps the prior value and must NOT consume
        // the epoch (filter read failed).
        app_metadata_service::upsert_value(&db.conn, EVENT_FILTER_KEY, "{corrupt")
            .await
            .unwrap();
        bump_event_config_epoch();
        config.refresh_if_needed(&db.conn).await;
        assert_eq!(
            config.global_filter,
            Some(vec!["turn_complete".to_string(), "error".to_string()]),
            "keeps prior on a corrupt read"
        );
        assert!(
            !config.filter_known,
            "while the changed config is unloaded it fails closed (stale-broad guard)"
        );

        // Write a narrower VALID filter without bumping the epoch. Because the
        // failed read did not consume the epoch/TTL, the next refresh still
        // re-reads and narrows — rather than holding the broader filter.
        app_metadata_service::upsert_value(&db.conn, EVENT_FILTER_KEY, "[\"error\"]")
            .await
            .unwrap();
        config.refresh_if_needed(&db.conn).await;
        assert_eq!(
            config.global_filter,
            Some(vec!["error".to_string()]),
            "a failed read must keep retrying and pick up the narrower filter without a new epoch bump"
        );
        assert!(
            config.filter_known,
            "a clean read for the change restores the known state (delivery resumes)"
        );
    }

    // ── question_request (ask_user_question) global push ──

    /// AskUserQuestion is a default-ON event: under the null (default) filter it
    /// is pushed, carrying the localized title and the question text. Contrast
    /// `user_prompt_sent_off_by_default`, which is opt-in under the same filter.
    #[tokio::test]
    async fn question_request_pushed_by_default() {
        let db = test_helpers::fresh_in_memory_db().await;
        let (chat, rec) = manager_with_recorder(7).await;
        let bridge = Arc::new(Mutex::new(SessionBridge::new()));
        let config = config_all_on(7); // global_filter = None (the default)
        let mut last_push = HashMap::new();

        process_envelope(
            &question_request_envelope("desktop-conn"),
            &bridge,
            &chat,
            &db.conn,
            &config,
            &mut last_push,
            &test_client(),
        )
        .await;

        let msgs = sent(&rec).await;
        assert_eq!(msgs.len(), 1, "expected one push, got {msgs:?}");
        assert!(msgs[0].contains("Agent Question"), "got {:?}", msgs[0]);
        assert!(msgs[0].contains("Which approach?"), "got {:?}", msgs[0]);
    }

    /// Unlike permission_request, a question from a chat-channel-bridged
    /// connection is NOT suppressed: there is no IM `/answer` flow, so the push
    /// is the only signal the user gets that the agent is blocked.
    #[tokio::test]
    async fn question_request_bridged_is_still_pushed() {
        let db = test_helpers::fresh_in_memory_db().await;
        let (chat, rec) = manager_with_recorder(7).await;
        let bridge = Arc::new(Mutex::new(SessionBridge::new()));
        bridge
            .lock()
            .await
            .register("im-conn".into(), bridged_session("im-conn", 7));
        let config = config_all_on(7);
        let mut last_push = HashMap::new();

        process_envelope(
            &question_request_envelope("im-conn"),
            &bridge,
            &chat,
            &db.conn,
            &config,
            &mut last_push,
            &test_client(),
        )
        .await;

        assert_eq!(
            sent(&rec).await.len(),
            1,
            "a bridged question must still notify (no IM answer flow to defer to)"
        );
    }

    /// Question requests bypass the debounce: two gates back-to-back inside the
    /// 5s window must BOTH deliver (a blocked agent emits no further event).
    #[tokio::test]
    async fn question_requests_are_not_debounced() {
        let db = test_helpers::fresh_in_memory_db().await;
        let (chat, rec) = manager_with_recorder(7).await;
        let bridge = Arc::new(Mutex::new(SessionBridge::new()));
        let config = config_all_on(7);
        let mut last_push = HashMap::new();

        process_envelope(
            &question_request_envelope("conn-a"),
            &bridge,
            &chat,
            &db.conn,
            &config,
            &mut last_push,
            &test_client(),
        )
        .await;
        process_envelope(
            &question_request_envelope("conn-b"),
            &bridge,
            &chat,
            &db.conn,
            &config,
            &mut last_push,
            &test_client(),
        )
        .await;

        assert_eq!(
            sent(&rec).await.len(),
            2,
            "both question gates within 5s must be delivered"
        );
    }

    /// The global event filter still gates question_request: with the id toggled
    /// off (filter present, not containing it), nothing is pushed.
    #[tokio::test]
    async fn question_request_respects_global_filter() {
        let db = test_helpers::fresh_in_memory_db().await;
        let (chat, rec) = manager_with_recorder(7).await;
        let bridge = Arc::new(Mutex::new(SessionBridge::new()));
        let mut config = config_all_on(7);
        config.global_filter = Some(vec!["turn_complete".to_string()]);
        let mut last_push = HashMap::new();

        process_envelope(
            &question_request_envelope("desktop-conn"),
            &bridge,
            &chat,
            &db.conn,
            &config,
            &mut last_push,
            &test_client(),
        )
        .await;

        assert!(sent(&rec).await.is_empty());
    }

    /// A configured webhook receives the question_request POST under the default
    /// filter — proving default-on plus webhook fan-out end to end.
    #[tokio::test]
    async fn question_request_reaches_webhook() {
        use tokio::net::TcpListener;

        let db = test_helpers::fresh_in_memory_db().await;
        let (chat, _rec) = manager_with_recorder(7).await;
        let bridge = Arc::new(Mutex::new(SessionBridge::new()));
        let mut last_push = HashMap::new();

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { accept_request(&listener).await });

        let mut config = config_all_on(7);
        config.webhooks = vec![format!("http://{addr}/hook")];

        process_envelope(
            &question_request_envelope("desktop-conn"),
            &bridge,
            &chat,
            &db.conn,
            &config,
            &mut last_push,
            &test_client(),
        )
        .await;

        let request = tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .expect("webhook should be delivered within 5s")
            .unwrap();
        assert!(request.starts_with("POST /hook"), "got: {request}");
        assert!(
            request.contains("\"event\":\"question_request\""),
            "got: {request}"
        );
    }
}
