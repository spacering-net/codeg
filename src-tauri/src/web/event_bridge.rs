use std::sync::atomic::Ordering;
use std::sync::Arc;

use serde::{ser::SerializeStruct, Serialize, Serializer};
use tokio::sync::{broadcast, RwLock};

use crate::acp::{AcpEvent, EventBusMetrics, EventEnvelope, InternalEventBus, SessionState};

/// Broadcast-delivered event.
///
/// `payload` is wrapped in `Arc` so cloning across broadcast receivers is
/// refcount-only — avoids copying multi-MB JSON trees per subscriber.
#[derive(Clone, Debug)]
pub struct WebEvent {
    pub channel: String,
    pub payload: Arc<serde_json::Value>,
}

impl Serialize for WebEvent {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut state = serializer.serialize_struct("WebEvent", 2)?;
        state.serialize_field("channel", &self.channel)?;
        state.serialize_field("payload", self.payload.as_ref())?;
        state.end()
    }
}

pub struct WebEventBroadcaster {
    sender: broadcast::Sender<WebEvent>,
}

impl Default for WebEventBroadcaster {
    fn default() -> Self {
        Self::new()
    }
}

impl WebEventBroadcaster {
    pub fn new() -> Self {
        let (sender, _) = broadcast::channel(4096);
        Self { sender }
    }

    /// Serialize `payload` once and broadcast. Returns the serialized
    /// `Value` so Tauri callers can reuse it without serializing twice.
    pub fn send(&self, channel: &str, payload: &impl Serialize) -> Option<Arc<serde_json::Value>> {
        let value = Arc::new(serde_json::to_value(payload).ok()?);
        if self.sender.receiver_count() > 0 {
            let _ = self.sender.send(WebEvent {
                channel: channel.to_string(),
                payload: value.clone(),
            });
        }
        Some(value)
    }

    /// Broadcast a pre-serialized `Value` without re-serialization.
    pub fn send_value(&self, channel: &str, payload: Arc<serde_json::Value>) {
        if self.sender.receiver_count() == 0 {
            return;
        }
        let _ = self.sender.send(WebEvent {
            channel: channel.to_string(),
            payload,
        });
    }

    pub fn subscribe(&self) -> broadcast::Receiver<WebEvent> {
        self.sender.subscribe()
    }
}

/// Abstraction over event emission targets.
///
/// Three concerns layered together:
/// - **Tauri webview** (`Tauri` variant): events delivered to the desktop
///   webview via `app.emit`. Looked-up state (`Arc<WebEventBroadcaster>`,
///   `Arc<InternalEventBus>`) goes through `app.try_state`, registered in
///   `lib.rs::run` setup.
/// - **WS clients** (`WebOnly` variant): standalone server mode. Carries
///   the broadcaster directly because there's no AppHandle to look it up
///   from.
/// - **In-process consumers** (lifecycle / pet / chat-channel): receive
///   typed `Arc<EventEnvelope>` from `InternalEventBus`. Both `Tauri` and
///   `WebOnly` resolve to the same bus (via `acp_event_bus()`).
///
/// `Noop` drops everything — used for legacy non-streaming call paths and
/// in tests that don't observe events.
#[derive(Clone)]
pub enum EventEmitter {
    #[cfg(feature = "tauri-runtime")]
    Tauri(tauri::AppHandle),
    /// Standalone server runtime. Carries the broadcaster (transport-bound
    /// JSON delivery to WS clients on non-ACP channels) and the internal
    /// bus (typed envelope delivery to in-process subscribers).
    WebOnly {
        broadcaster: Arc<WebEventBroadcaster>,
        bus: Arc<InternalEventBus>,
    },
    /// Silent no-op emitter — drops all events. Used when streaming progress
    /// is not needed (e.g. legacy non-streaming call paths).
    Noop,
}

impl EventEmitter {
    /// Convenience constructor for the standalone server runtime path.
    /// Mirrors how `Tauri` resolves the same two pieces of state via
    /// `app.try_state`.
    pub fn web_only(broadcaster: Arc<WebEventBroadcaster>, bus: Arc<InternalEventBus>) -> Self {
        EventEmitter::WebOnly { broadcaster, bus }
    }

    /// Resolve the `InternalEventBus` for ACP-typed event delivery.
    ///
    /// In Tauri mode, looks up `Arc<InternalEventBus>` registered with
    /// `app.manage` during setup. Returns `None` if the bus isn't
    /// registered (only happens in degraded test setups) — the caller
    /// treats this as "no in-process consumers wired".
    pub fn acp_event_bus(&self) -> Option<Arc<InternalEventBus>> {
        match self {
            #[cfg(feature = "tauri-runtime")]
            EventEmitter::Tauri(app) => {
                use tauri::Manager;
                app.try_state::<Arc<InternalEventBus>>()
                    .map(|s| Arc::clone(&s))
            }
            EventEmitter::WebOnly { bus, .. } => Some(Arc::clone(bus)),
            EventEmitter::Noop => None,
        }
    }

    /// Resolve the `EventBusMetrics` handle. Same lookup rules as
    /// `acp_event_bus()`.
    pub fn metrics(&self) -> Option<Arc<EventBusMetrics>> {
        self.acp_event_bus().map(|bus| Arc::clone(bus.metrics()))
    }

    /// Test-only convenience: build a `WebOnly` emitter with a fresh,
    /// orphan `InternalEventBus`. Tests that assert against the
    /// broadcaster don't need to wire the bus through their own setup.
    #[cfg(any(test, feature = "test-utils"))]
    pub fn test_web_only(broadcaster: Arc<WebEventBroadcaster>) -> Self {
        let metrics = Arc::new(EventBusMetrics::default());
        let bus = Arc::new(InternalEventBus::new(metrics));
        EventEmitter::WebOnly { broadcaster, bus }
    }
}

/// Global side-channel for cross-client conversation list/status sync.
pub const CONVERSATION_CHANGED_EVENT: &str = "conversation://changed";

/// Global side-channel announcing a live-feedback enable/disable. The settings
/// UI runs in a SEPARATE window (`openSettingsWindow`), so the conversation
/// feedback bar can't learn about a save through any frontend-only cache — it
/// relies on this backend broadcast to converge across every window / WS client,
/// exactly like [`CONVERSATION_CHANGED_EVENT`]. Payload: `FeedbackSettings`
/// (`{ "enabled": bool }`).
pub const FEEDBACK_SETTINGS_CHANGED_EVENT: &str = "feedback-settings://changed";

/// Global side-channel announcing an ask-user-question enable/disable. Same
/// cross-window rationale as [`FEEDBACK_SETTINGS_CHANGED_EVENT`]: the settings UI
/// runs in a separate window, so a conversation view learns the flag flipped
/// only via this backend broadcast. Payload: `QuestionSettings` (`{ "enabled":
/// bool }`).
pub const QUESTION_SETTINGS_CHANGED_EVENT: &str = "question-settings://changed";

/// Global side-channel announcing a `get_session_info` enable/disable. Same
/// cross-window rationale as [`QUESTION_SETTINGS_CHANGED_EVENT`]: the settings UI
/// runs in a separate window, so other views learn the flag flipped only via this
/// backend broadcast. Payload: `SessionInfoSettings` (`{ "enabled": bool }`).
pub const SESSION_INFO_SETTINGS_CHANGED_EVENT: &str = "session-info-settings://changed";

/// Global side-channel announcing a browser-tools enable/disable
/// (`browser_list_tabs` / `browser_snapshot`). Same cross-window rationale as
/// [`SESSION_INFO_SETTINGS_CHANGED_EVENT`]. Payload: `BrowserToolsSettings`
/// (`{ "enabled": bool }`).
pub const BROWSER_TOOLS_SETTINGS_CHANGED_EVENT: &str = "browser-tools-settings://changed";

/// Global side-channel announcing a chat-authoring enable/disable
/// (`create_automation` / `create_work_task`). Same cross-window rationale as
/// [`SESSION_INFO_SETTINGS_CHANGED_EVENT`]. Payload: `ChatAuthoringSettings`
/// (`{ "automations_enabled": bool, "work_tasks_enabled": bool }`).
pub const CHAT_AUTHORING_SETTINGS_CHANGED_EVENT: &str = "chat-authoring-settings://changed";

/// Announces a delegation-settings write. Same cross-window rationale as
/// [`CHAT_AUTHORING_SETTINGS_CHANGED_EVENT`], and load-bearing for the same
/// reason: the record has two editors — the settings form, which writes all
/// four keys, and the status-bar codeg-mcp popover, which writes only
/// `enabled` — so a form left open across a popover toggle would revert it on
/// the next save. Payload: `DelegationSettings`.
pub const DELEGATION_SETTINGS_CHANGED_EVENT: &str = "delegation-settings://changed";

/// Payload for the global [`CONVERSATION_CHANGED_EVENT`] side-channel. Drives
/// cross-client sidebar sync (membership + status) independent of the
/// per-connection ACP attach protocol, so clients that are NOT attached to a
/// conversation's connection still see it appear / update / disappear / change
/// state.
///
/// Delivered via [`emit_event`], so in desktop mode a single emit reaches both
/// the Tauri webview (`app.emit`) and every WebSocket browser
/// (`WebEventBroadcaster`); in standalone server mode it reaches all browsers.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ConversationChange {
    /// Insert-or-replace by id. Covers create and field updates (e.g. title).
    /// Carries the full summary so the frontend renders without a re-fetch.
    /// Root conversations omit `parent_id` (serde skips `None`); delegation
    /// children carry it and the frontend filters them out of the sidebar.
    ///
    /// Boxed so this variant doesn't bloat the whole enum (the summary is by far
    /// the largest payload); serde serializes `Box<T>` transparently, so the wire
    /// shape — `{ "kind": "upsert", "summary": { … } }` — is unchanged.
    Upsert {
        summary: Box<crate::models::DbConversationSummary>,
    },
    /// Remove by id (soft delete).
    Deleted { id: i32 },
    /// Lightweight running-state change. Emitted centrally from
    /// [`emit_with_state`] whenever a `ConversationStatusChanged` ACP event
    /// flows through, so the sidebar's status reaches every client (not just
    /// those attached to the connection).
    Status { id: i32, status: String },
}

/// Global side-channel for cross-client folder list sync. Mirrors
/// [`CONVERSATION_CHANGED_EVENT`]: a single [`emit_event`] reaches the Tauri
/// webview and every WebSocket client. A folder created headlessly (e.g. the
/// automation engine minting a per-run worktree) is otherwise invisible to every
/// client until the next full `fetchFolders` — so without this broadcast a
/// conversation produced in that worktree can't be placed in the sidebar
/// (grouping renders rows only under known/open folders).
///
/// Distinct from [`"folder://open-in-workspace"`] (the project launcher's
/// hand-off, whose listener also opens + focuses a new conversation tab): this
/// channel ONLY upserts the folder into the workspace list, so a background
/// emitter never steals the user's focus.
pub const FOLDER_CHANGED_EVENT: &str = "folder://changed";

/// Payload for [`FOLDER_CHANGED_EVENT`]. The full [`FolderDetail`] rides on the
/// event so clients apply it without a re-fetch (matching
/// [`ConversationChange::Upsert`]). `folder` is boxed to keep the enum small
/// next to the id-only `Deleted`.
///
/// [`FolderDetail`]: crate::models::FolderDetail
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FolderChange {
    /// Insert-or-replace by id (create / reopen / field update).
    Upsert {
        folder: Box<crate::models::FolderDetail>,
    },
    /// Drop by id: the folder row is soft-deleted and will never come back
    /// (today: a work task's worktree folder, once the worktree is off disk).
    /// The mirror image of `Upsert` — without it a vanished worktree keeps
    /// rendering in every client's sidebar until the next full `fetchFolders`.
    ///
    /// Deliberately NOT emitted when a folder is merely closed
    /// (`remove_folder_from_workspace`): that row stays alive in
    /// `list_all_folder_details` for by-id cwd lookups.
    Deleted { id: i32 },
}

/// Global side-channel for sidebar folder-group sync, alongside
/// [`FOLDER_CHANGED_EVENT`]. Groups are edited in one window but rendered in
/// every client, so a rename / recolor / delete has to reach them all.
pub const FOLDER_GROUP_CHANGED_EVENT: &str = "folder-group://changed";

/// Payload for [`FOLDER_GROUP_CHANGED_EVENT`].
///
/// Group CRUD carries its detail so clients apply it without a re-fetch, but a
/// LAYOUT change deliberately carries nothing: one drag rewrites `group_id` /
/// `sort_order` on every visible folder, and per-row `folder://changed` upserts
/// would turn a single gesture into a burst of events that must then be applied
/// in order to land on the right layout. A single "go re-read both lists" nudge
/// is smaller, order-independent and self-healing.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FolderGroupChange {
    /// Insert-or-replace by id (create / rename / recolor).
    Upsert {
        group: crate::models::FolderGroupDetail,
    },
    /// The group is gone. Its member folders are NOT deleted — they returned to
    /// the top level, which the accompanying `Layout` refetch picks up.
    Deleted { id: i32 },
    /// Folder membership and/or ordering changed; re-fetch the folder and group
    /// lists.
    Layout,
}

/// Per-agent progress of the import picker's local-session scan. Emitted by
/// `scan_importable_sessions` once per parser so the picker window can render
/// a live checklist while the (potentially seconds-long) filesystem walk runs.
/// Broadcast like every other side-channel — windows not in the `scanning`
/// phase simply ignore it.
pub const IMPORT_SCAN_PROGRESS_EVENT: &str = "import-scan://progress";

/// Payload for [`IMPORT_SCAN_PROGRESS_EVENT`].
#[derive(Debug, Clone, Serialize)]
pub struct ImportScanProgress {
    pub agent_type: crate::models::AgentType,
    /// Parsers completed so far (1-based, monotonic).
    pub done: u32,
    pub total: u32,
    /// Importable root sessions this parser contributed.
    pub session_count: u32,
}

/// One-shot "a batch import finished" nudge. Deliberately a NEW channel rather
/// than a [`ConversationChange`] variant: the frontend's `conversation://changed`
/// handler routes any unknown `kind` into its status branch (clobbering state
/// with `undefined`s on stale clients), whereas an unknown channel simply has no
/// subscriber. Carries ids only — clients respond with a single full refetch,
/// which also covers the per-row title refreshes, so a large batch never floods
/// the bus with thousands of upserts (created folders still broadcast
/// individually on [`FOLDER_CHANGED_EVENT`]).
pub const CONVERSATIONS_BULK_CHANGED_EVENT: &str = "conversations://bulk-changed";

/// Payload for [`CONVERSATIONS_BULK_CHANGED_EVENT`].
#[derive(Debug, Clone, Serialize)]
pub struct ConversationsBulkChanged {
    pub imported: u32,
    pub updated: u32,
    pub folder_ids: Vec<i32>,
}

/// Global side-channel for cross-client open-tab sync. Mirrors
/// [`CONVERSATION_CHANGED_EVENT`]: a single [`emit_event`] reaches the Tauri
/// webview and every WebSocket client.
pub const TABS_CHANGED_EVENT: &str = "tabs://changed";

/// Payload for the [`TABS_CHANGED_EVENT`] side-channel. Carries the full
/// conversation-bound tab set (a snapshot, not a delta) so every client
/// converges idempotently — matching the full-replacement save semantics.
///
/// - `version` — workspace-global logical clock; clients drop events at or
///   below their last-applied version (except `origin == "server"`).
/// - `origin` — the originating client's id, echoed back so the originator can
///   ignore its own broadcast; the sentinel `"server"` marks cascade-originated
///   changes (folder removal, conversation deletion) that every client applies.
/// - `tabs` — the canonical persisted set; `is_active` marks the focused tab,
///   which is mirrored across clients.
#[derive(Debug, Clone, Serialize)]
pub struct TabsChanged {
    pub version: i64,
    pub origin: String,
    pub tabs: Vec<crate::models::OpenedTab>,
}

/// Global side-channel for cross-client automation list + run sync. Mirrors
/// [`CONVERSATION_CHANGED_EVENT`]: a single [`emit_event`] reaches the Tauri
/// webview and every WebSocket client. The scheduler runs headless (no window),
/// so this broadcast is the only way an open automations view learns a run
/// started or settled.
pub const AUTOMATION_CHANGED_EVENT: &str = "automation://changed";

/// Payload for [`AUTOMATION_CHANGED_EVENT`]. Carries only ids — clients refetch
/// the affected automation / its runs. All variants are small, so no boxing is
/// needed (unlike [`ConversationChange`]).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AutomationChange {
    /// Insert-or-replace by id (create, edit, enable/disable, last-run update).
    Upsert { id: i32 },
    /// Soft-deleted by id.
    Deleted { id: i32 },
    /// A run was claimed and launched.
    RunStarted { automation_id: i32, run_id: i32 },
    /// A run reached a terminal state (succeeded / failed / cancelled / skipped).
    RunSettled {
        automation_id: i32,
        run_id: i32,
        status: String,
    },
}

/// Global side-channel for cross-client work-task board sync. Mirrors
/// [`AUTOMATION_CHANGED_EVENT`]: the task engine runs headless, so this
/// broadcast is the only way an open tasks view (or the sidebar badge) learns a
/// task advanced. Payload is id-only — clients refetch.
pub const WORK_TASK_CHANGED_EVENT: &str = "task://changed";

/// Payload for [`WORK_TASK_CHANGED_EVENT`]. Ids only — clients respond with a
/// refetch of the task list (and badge count).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorkTaskChange {
    /// Insert-or-replace by id (create, edit, any status transition).
    Upsert { id: i32 },
    /// Soft-deleted by id.
    Deleted { id: i32 },
    /// Something the folder's tasks INHERIT changed: its task settings, or the
    /// folder's own default agent (the layer below them). Either can change
    /// what an inheriting task runs — and reports — without touching a row.
    Settings { folder_id: i32 },
    /// Bulk change (e.g. boot reconcile) — refetch everything.
    Refresh,
}

/// Progress of a token-usage sync, emitted while the dashboard's materialized
/// facts are rebuilt from the agents' transcripts. Throttled by the emitter
/// (see `commands::token_usage`), so a multi-thousand-conversation pass sends
/// tens of messages rather than thousands. Payload is
/// [`crate::models::token_usage::TokenUsageSyncProgress`]; the final tick
/// carries the completed result. Like every other side channel this is
/// broadcast — clients not showing the dashboard simply ignore it.
pub const TOKEN_USAGE_SYNC_PROGRESS_EVENT: &str = "token-usage-sync://progress";

/// Unified event emission: serializes the payload exactly once and dispatches
/// the shared `Arc<Value>` to both the Tauri webview and the web broadcaster.
pub fn emit_event(emitter: &EventEmitter, event: &str, payload: impl Serialize) {
    match emitter {
        #[cfg(feature = "tauri-runtime")]
        EventEmitter::Tauri(app) => {
            use tauri::{Emitter, Manager};
            let Ok(value) = serde_json::to_value(&payload) else {
                return;
            };
            let shared = Arc::new(value);
            // `&Value` is Copy, so Tauri's `Clone` bound is satisfied without
            // copying the payload — Tauri serializes through the reference.
            let _ = app.emit(event, shared.as_ref());
            if let Some(web) = app.try_state::<Arc<WebEventBroadcaster>>() {
                web.send_value(event, shared);
            }
        }
        EventEmitter::WebOnly { broadcaster, .. } => {
            let _ = broadcaster.send(event, &payload);
        }
        EventEmitter::Noop => {}
    }
}

/// 统一 ACP 事件发射入口。
///
/// 流程：
/// 1. 写锁拿到 `SessionState`
/// 2. `apply_event` 把事件应用到 state（也更新 `last_activity_at`）
/// 3. `event_seq += 1`
/// 4. 用新 seq 构造 `EventEnvelope`，推入 ring buffer，记录淘汰计数
/// 5. 释放写锁
/// 6. 分发到三条路径：
///    - 每连接 `ConnectionEventStream`（WS attach 协议主路径）
///    - 进程内 `InternalEventBus`（lifecycle / pet / chat-channel 订阅者）
///    - Tauri 模式下额外 `app.emit("acp://event", ...)` 给 webview
///
/// 不再向 `WebEventBroadcaster` 上的 `acp://event` 频道广播——所有 ACP
/// 事件消费者要么走 per-connection stream（WS 客户端），要么走
/// InternalEventBus（进程内订阅者），要么走 Tauri `app.emit`（桌面 webview）。
/// 删除该全局广播是 Phase 5 架构清理的核心：它消除了 WS 客户端 receiver-side
/// 去重 (`attachManagedConnectionIdsRef`) 的必要性。
pub async fn emit_with_state(
    state: &Arc<RwLock<SessionState>>,
    emitter: &EventEmitter,
    payload: AcpEvent,
) {
    emit_with_state_gated(state, emitter, payload, |_| true).await;
}

/// Like [`emit_with_state`], but a `gate` predicate — evaluated under the SAME
/// write lock, BEFORE `apply_event` — can veto the emit: returning `false`
/// aborts with no mutation, no seq bump, no broadcast, and returns `false`.
///
/// The point is atomicity: the gate, the state mutation, and the seq assignment
/// all happen in one critical section, so no other event can interleave between
/// "decide to accept" and "apply + sequence". Used by feedback submit to gate on
/// `turn_in_flight` together with the append (a `TurnComplete`/`UserMessage`
/// can't slip in between to strand or re-add the note), and to assign the
/// `FeedbackSubmitted` seq atomically with the append.
pub async fn emit_with_state_gated<F>(
    state: &Arc<RwLock<SessionState>>,
    emitter: &EventEmitter,
    payload: AcpEvent,
    gate: F,
) -> bool
where
    F: FnOnce(&SessionState) -> bool,
{
    let (envelope_arc, stream, evicted) = {
        let mut s = state.write().await;
        if !gate(&s) {
            return false;
        }
        s.apply_event(&payload);
        s.event_seq += 1;
        let envelope = Arc::new(EventEnvelope {
            seq: s.event_seq,
            connection_id: s.connection_id.clone(),
            payload,
        });
        let evicted = s.push_recent_event(Arc::clone(&envelope));
        (envelope, s.event_stream(), evicted)
    };

    // Per-connection broadcaster — primary delivery path for web/remote-
    // desktop transports (they use Subscribe-with-Snapshot attach for ACP
    // events).
    stream.send(Arc::clone(&envelope_arc));

    // In-process consumers (lifecycle, pet, chat-channel). Typed envelope —
    // no JSON parse on the receiver side. Plus surface ring-buffer pressure
    // and bus emit-rate via metrics so operators can see when things drift.
    match emitter {
        #[cfg(feature = "tauri-runtime")]
        EventEmitter::Tauri(app) => {
            use tauri::{Emitter, Manager};
            // Tauri webview listener is the desktop frontend's only ACP path
            // (it subscribes via `app.listen`, not the WS attach protocol).
            let _ = app.emit("acp://event", envelope_arc.as_ref());
            if let Some(bus) = app.try_state::<Arc<InternalEventBus>>() {
                bus.send(Arc::clone(&envelope_arc));
                if evicted > 0 {
                    bus.metrics()
                        .ring_buffer_evict_count
                        .fetch_add(evicted as u64, Ordering::Relaxed);
                }
            }
        }
        EventEmitter::WebOnly { bus, .. } => {
            bus.send(Arc::clone(&envelope_arc));
            if evicted > 0 {
                bus.metrics()
                    .ring_buffer_evict_count
                    .fetch_add(evicted as u64, Ordering::Relaxed);
            }
        }
        EventEmitter::Noop => {}
    }

    // Bridge conversation status transitions onto the global
    // `conversation://changed` side-channel so clients NOT attached to this
    // connection (only showing the sidebar, or a different browser entirely)
    // still observe running-state changes live — the per-connection delivery
    // above only reaches attached clients. One central hook here covers every
    // `ConversationStatusChanged` emit site (manager + lifecycle). `status`
    // serializes to the same snake_case string the DB stores (e.g.
    // "in_progress"), matching `DbConversationSummary.status`.
    if let AcpEvent::ConversationStatusChanged {
        conversation_id,
        status,
    } = &envelope_arc.payload
    {
        if let Ok(serde_json::Value::String(status_str)) = serde_json::to_value(status) {
            emit_event(
                emitter,
                CONVERSATION_CHANGED_EVENT,
                ConversationChange::Status {
                    id: *conversation_id,
                    status: status_str,
                },
            );
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::entities::conversation::ConversationStatus;
    use crate::models::AgentType;

    fn fresh_state() -> Arc<RwLock<SessionState>> {
        Arc::new(RwLock::new(SessionState::new(
            "conn-test".to_string(),
            AgentType::ClaudeCode,
            None,
            "win-test".to_string(),
            None,
        )))
    }

    #[tokio::test]
    async fn emit_with_state_bridges_status_change_to_global_channel() {
        // A ConversationStatusChanged ACP event must ALSO surface on the global
        // `conversation://changed` channel so clients NOT attached to this
        // connection (e.g. only viewing the sidebar) still observe the flip.
        let state = fresh_state();
        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let mut rx = broadcaster.subscribe();
        let emitter = EventEmitter::test_web_only(broadcaster.clone());

        emit_with_state(
            &state,
            &emitter,
            AcpEvent::ConversationStatusChanged {
                conversation_id: 7,
                status: ConversationStatus::PendingReview,
            },
        )
        .await;

        let evt = rx
            .try_recv()
            .expect("status change should bridge to the global channel");
        let p = &*evt.payload;
        assert_eq!(evt.channel, CONVERSATION_CHANGED_EVENT);
        assert_eq!(p["kind"], "status");
        assert_eq!(p["id"], 7);
        assert_eq!(p["status"], "pending_review");
    }

    #[tokio::test]
    async fn emit_with_state_non_status_event_does_not_touch_global_channel() {
        // High-frequency stream events (deltas, etc.) must NOT spam the global
        // sidebar channel — only status transitions bridge.
        let state = fresh_state();
        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let mut rx = broadcaster.subscribe();
        let emitter = EventEmitter::test_web_only(broadcaster.clone());

        emit_with_state(
            &state,
            &emitter,
            AcpEvent::ContentDelta {
                text: "hello".to_string(),
                parent_tool_use_id: None,
            },
        )
        .await;

        assert!(
            rx.try_recv().is_err(),
            "non-status ACP events must not emit on conversation://changed"
        );
    }

    #[test]
    fn emit_event_broadcasts_tabs_changed_snapshot() {
        // The open-tab set syncs via the same global side-channel as the
        // sidebar: one `emit_event` on `tabs://changed` reaches every client,
        // carrying version + origin (for echo suppression) + the full set.
        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let mut rx = broadcaster.subscribe();
        let emitter = EventEmitter::test_web_only(broadcaster.clone());

        emit_event(
            &emitter,
            TABS_CHANGED_EVENT,
            TabsChanged {
                version: 6,
                origin: "win-abc".to_string(),
                tabs: vec![],
            },
        );

        let evt = rx.try_recv().expect("tabs change should broadcast");
        let p = &*evt.payload;
        assert_eq!(evt.channel, TABS_CHANGED_EVENT);
        assert_eq!(p["version"], 6);
        assert_eq!(p["origin"], "win-abc");
        assert!(p["tabs"].is_array(), "tabs must serialize as an array");
    }

    #[test]
    fn emit_event_broadcasts_folder_change_upsert() {
        // A headlessly-created folder (e.g. an automation worktree) reaches every
        // client via `folder://changed`, carrying the full detail so clients apply
        // it without a re-fetch. The boxed `folder` serializes transparently — the
        // wire shape is `{ "kind": "upsert", "folder": { … } }`.
        use crate::db::entities::folder::FolderKind;
        use crate::models::FolderDetail;

        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let mut rx = broadcaster.subscribe();
        let emitter = EventEmitter::test_web_only(broadcaster.clone());

        emit_event(
            &emitter,
            FOLDER_CHANGED_EVENT,
            FolderChange::Upsert {
                folder: Box::new(FolderDetail {
                    id: 42,
                    name: "repo".to_string(),
                    path: "/home/me/repo".to_string(),
                    git_branch: Some("main".to_string()),
                    default_agent_type: None,
                    last_opened_at: chrono::Utc::now(),
                    sort_order: 0,
                    color: "inherit".to_string(),
                    parent_id: Some(7),
                    kind: FolderKind::Regular,
                    alias: None,
                    group_id: None,
                }),
            },
        );

        let evt = rx.try_recv().expect("folder change should broadcast");
        let p = &*evt.payload;
        assert_eq!(evt.channel, FOLDER_CHANGED_EVENT);
        assert_eq!(p["kind"], "upsert");
        assert_eq!(p["folder"]["id"], 42);
        assert_eq!(p["folder"]["parent_id"], 7);
        assert_eq!(p["folder"]["kind"], "regular");
    }

    #[test]
    fn emit_event_broadcasts_folder_change_deleted() {
        // A removed task worktree rides the SAME channel as its creation, so a
        // client that learned about the folder from an upsert also hears it go.
        // Wire shape is id-only: `{ "kind": "deleted", "id": 42 }`.
        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let mut rx = broadcaster.subscribe();
        let emitter = EventEmitter::test_web_only(broadcaster.clone());

        emit_event(
            &emitter,
            FOLDER_CHANGED_EVENT,
            FolderChange::Deleted { id: 42 },
        );

        let evt = rx.try_recv().expect("folder delete should broadcast");
        let p = &*evt.payload;
        assert_eq!(evt.channel, FOLDER_CHANGED_EVENT);
        assert_eq!(p["kind"], "deleted");
        assert_eq!(p["id"], 42);
        assert!(p["folder"].is_null(), "delete carries no folder detail");
    }

    #[test]
    fn emit_event_broadcasts_folder_group_change_wire_shapes() {
        // The three shapes the sidebar switches on. `layout` in particular must
        // serialize as a bare tagged variant with no body — the client treats it
        // as "re-read both lists", so any payload there would be dead weight the
        // sender is tempted to start trusting.
        use crate::models::FolderGroupDetail;

        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let mut rx = broadcaster.subscribe();
        let emitter = EventEmitter::test_web_only(broadcaster.clone());

        emit_event(
            &emitter,
            FOLDER_GROUP_CHANGED_EVENT,
            FolderGroupChange::Upsert {
                group: FolderGroupDetail {
                    id: 3,
                    name: "Work".to_string(),
                    color: "blue".to_string(),
                    sort_order: 2,
                },
            },
        );
        let evt = rx.try_recv().expect("group upsert should broadcast");
        assert_eq!(evt.channel, FOLDER_GROUP_CHANGED_EVENT);
        let p = &*evt.payload;
        assert_eq!(p["kind"], "upsert");
        assert_eq!(p["group"]["id"], 3);
        assert_eq!(p["group"]["name"], "Work");
        assert_eq!(p["group"]["color"], "blue");
        assert_eq!(p["group"]["sort_order"], 2);

        emit_event(
            &emitter,
            FOLDER_GROUP_CHANGED_EVENT,
            FolderGroupChange::Deleted { id: 3 },
        );
        let evt = rx.try_recv().expect("group delete should broadcast");
        let p = &*evt.payload;
        assert_eq!(p["kind"], "deleted");
        assert_eq!(p["id"], 3);

        emit_event(&emitter, FOLDER_GROUP_CHANGED_EVENT, FolderGroupChange::Layout);
        let evt = rx.try_recv().expect("layout nudge should broadcast");
        let p = &*evt.payload;
        assert_eq!(p["kind"], "layout");
        assert!(p["group"].is_null(), "the layout nudge carries no payload");
        assert!(p["id"].is_null(), "the layout nudge carries no payload");
    }
}
