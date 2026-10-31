use serde::Serialize;

/// A single persisted message-queue item, returned to the frontend. The `draft`
/// travels as a JSON string (`draft_json`) because `PromptDraft` is a
/// frontend-only type; the client re-parses it. Field names are snake_case to
/// match how the rest of the codebase serializes command returns (no camelCase
/// conversion happens on the wire for event/return payloads).
#[derive(Debug, Clone, Serialize)]
pub struct MessageQueueItem {
    pub id: String,
    pub draft_json: String,
    pub mode_id: Option<String>,
    pub adopt_send_time_mode: bool,
}
