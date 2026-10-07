use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageRole {
    User,
    Assistant,
    System,
    Tool,
}

/// A single tool call record from a subagent's execution transcript.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentToolCall {
    pub tool_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_preview: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_preview: Option<String>,
    pub is_error: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentExecutionStats {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_tool_use_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bash_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edit_file_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lines_added: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lines_removed: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub other_tool_count: Option<u32>,
    /// Tool calls extracted from the subagent's own JSONL transcript.
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub tool_calls: Vec<AgentToolCall>,
    /// The child's own session id, when the sub-agent ran as a standalone
    /// session on disk rather than as chunks folded into the parent's stream
    /// (Grok: every `spawn_subagent` child is a full session directory). Lets
    /// the Agent card offer to open that transcript — `get_conversation`
    /// resolves it directly even though the session is hidden from the list.
    /// Absent for agents whose sub-agents have no separate session.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub child_session_id: Option<String>,
}

/// Image payload shared by content blocks and ACP wire events.
///
/// Same shape used in three places:
/// 1. `ContentBlock::Image` (user-attached or assistant inline image)
/// 2. `ContentBlock::ImageGeneration.images` (codex-acp v0.14+ image generation)
/// 3. `ToolCallState.images` (snapshot recovery for in-flight image generation)
///
/// Re-exported from `acp::types` as `ToolCallImageInfo` for ACP wire callsites.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageData {
    pub data: String,
    pub mime_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uri: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    Text {
        text: String,
    },
    Image {
        data: String,
        mime_type: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        uri: Option<String>,
    },
    /// codex-acp v0.14+ image generation (PR #271). Distinct from `Image`
    /// because codex-acp positions image generation as a first-class
    /// `ToolCall(title="Image generation")` carrying a `revised_prompt` +
    /// generated image — not a generic image attachment. Modeling it as
    /// its own variant lets us keep `revised_prompt` and route to a
    /// dedicated renderer without title-string heuristics.
    ///
    /// Singular `image` (not Vec): codex-acp emits exactly one image per
    /// `ToolCall` (each `image_generation_begin/end` event pair has its
    /// own `call_id`). When a turn produces N images, the agent emits N
    /// separate ToolCalls — so the right unit is "one block, one image".
    /// `None` represents the in-flight placeholder state during streaming
    /// (`ImageGenerationBegin` arrived, `ImageGenerationEnd` hasn't yet).
    ImageGeneration {
        #[serde(skip_serializing_if = "Option::is_none")]
        revised_prompt: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        image: Option<ImageData>,
    },
    ToolUse {
        tool_use_id: Option<String>,
        tool_name: String,
        input_preview: Option<String>,
        /// The agent's own tool-call status (`pending` / `in_progress` /
        /// `completed` / `failed`) when the transcript records one.
        ///
        /// OPTIONAL, and `None` means UNKNOWN — never "settled". A reader may
        /// only act on an affirmative value, so every parser that can't honestly
        /// supply one keeps its existing behavior. This exists because absence
        /// of output is NOT evidence of liveness: an empty result still writes a
        /// `ToolResult`, grok backfills `output_preview` only for non-empty
        /// output, and a codex code-mode script that never `text()`s a call
        /// settles with none. A viewer polling a RUNNING session's transcript
        /// from disk (the grok `spawn_subagent` dialog) has no other way to tell
        /// a call that is still working from one that finished.
        ///
        /// Deliberately NOT derived from codex's `ScriptStatus`: that is
        /// script-level — a script can still be running after its first inner
        /// call already completed — so copying it onto recovered inner calls
        /// would manufacture a permanent spinner. The one codex card that does
        /// carry a status is an MCP call rebuilt from its OWN semantic
        /// `item_completed` record, which yields a per-call terminal outcome
        /// (`completed` / `failed`) that the wrapper script's status cannot.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status: Option<String>,
        /// ACP extensibility metadata associated with the tool call. The
        /// `delegate_to_agent` lifecycle writes
        /// `meta["codeg.delegation"] = { status, child_connection_id,
        /// child_conversation_id, error_code? }` here so a snapshot or DB
        /// re-fetch can re-bind the parent UI to the child conversation
        /// without depending on the live event stream having survived.
        ///
        /// `None` for tool uses without any meta (the agent didn't emit
        /// one, or the field predates the meta-on-ToolUse schema change).
        /// The shape is intentionally opaque — `serde_json::Value` —
        /// because the convention is agent-defined and may grow.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        meta: Option<serde_json::Value>,
    },
    ToolResult {
        tool_use_id: Option<String>,
        output_preview: Option<String>,
        is_error: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        agent_stats: Option<AgentExecutionStats>,
        /// Images returned in a tool result (e.g. Claude Code's `Read` of a
        /// PNG/JPEG, or a multi-page PDF read returning one image per page).
        /// The agent JSONL embeds these as base64 `image` content blocks; the
        /// adapter renders them in-position as image cards so the historical
        /// (JSONL replay) path matches the live ACP stream, which surfaces the
        /// same bytes via `ToolCallState.images`. Empty for the common
        /// text-only tool result.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        images: Vec<ImageData>,
    },
    Thinking {
        text: String,
    },
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub cache_read_input_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnifiedMessage {
    pub id: String,
    pub role: MessageRole,
    pub content: Vec<ContentBlock>,
    pub timestamp: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<TurnUsage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Wall-clock time the message finished. Each parser sets this to the
    /// best end-marker it has access to (e.g. Codex's `token_count` event,
    /// OpenCode's `completed_ms`, or just the event-log `timestamp` for
    /// agents that log post-generation). Crucially this is NOT computed as
    /// `timestamp + duration_ms` — those two fields encode unrelated spans
    /// in most parsers and adding them produces wrong completion times.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<DateTime<Utc>>,
    /// The agent's own id for this message, when it differs from [`Self::id`].
    ///
    /// `id` is whatever the parser keys messages by (Claude uses the record
    /// `uuid`); this is the id the AGENT would recognise. Propagated into
    /// [`MessageTurn::agent_message_id`], which documents what it is for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_message_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnRole {
    User,
    Assistant,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageTurn {
    pub id: String,
    pub role: TurnRole,
    pub blocks: Vec<ContentBlock>,
    pub timestamp: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<TurnUsage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Wall-clock time the turn finished, propagated from the last
    /// `UnifiedMessage` absorbed into this turn. Not computed from
    /// `timestamp + duration_ms` — those fields encode unrelated spans in
    /// most parsers (event-log time vs. full turn span).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<DateTime<Utc>>,
    /// The id the AGENT knows this turn's message by, when codeg can name it
    /// the same way the agent does. `id` above is positional (`turn-3`) and
    /// names nothing an agent could look up.
    ///
    /// Set only where a turn can be a fork point: `session/fork` takes an AIR
    /// fork point (`_meta.jetbrains.air.fork.messageId`) and claude-agent-acp
    /// 0.75.1, codex-acp 1.8.0 and deepseek-acp 0.8.0 all resolve it against
    /// their own message identity, so a fork "up to here" needs the agent's
    /// spelling of "here". Claude's is `assistant.message.id ?? uuid` and
    /// DeepSeek's is the session log's `message.id` — both pure functions of
    /// the stored record, which is why the parsers can derive them offline
    /// instead of having to have captured the live `messageId` chunk field.
    ///
    /// `None` for every parser with no such id (codex rollouts record no item
    /// ids at all, so that side forks by content fingerprint instead) and for
    /// synthesized turns, which name nothing the agent stored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_message_id: Option<String>,
}
