//! History parser for agents that have **no codeg-side store parser**: custom
//! ACP agents.
//!
//! Every other parser in this module reverse-engineers one agent's private
//! session store. This one reads codeg's own ACP transcript
//! ([`crate::acp_transcript`]) — the raw `session/prompt` payloads and
//! `session/update` notifications the connection layer witnessed — and projects
//! them into [`MessageTurn`]s using nothing but ACP semantics.
//!
//! ## Divergence control
//!
//! The obvious risk with a second projection is that history renders
//! differently from the live stream. That is mitigated by reusing the very
//! helpers the live path uses — [`serialize_tool_call_content`],
//! [`synthesize_edit_input_from_diffs`], [`extract_tool_call_images`],
//! [`json_value_to_text`] from `acp::connection` — so tool calls, diffs and
//! images land in exactly the same shape the frontend already renders live.
//! What is deliberately NOT reproduced is the per-agent quirk handling in
//! `emit_conversation_update` (CodeBuddy sub-agent folding, Grok `use_tool`
//! unwrapping, codex sub-agent suppression …): custom agents get no quirk
//! handling anywhere, live or historical, so there is nothing to diverge from.
//!
//! ## Turn boundaries
//!
//! ACP has no "turn ended" notification — the stop reason is the *response* to
//! `session/prompt`. codeg records it as an explicit
//! [`EntryKind::TurnEnd`](crate::acp_transcript::EntryKind::TurnEnd) line, so
//! live-recorded transcripts have exact boundaries. Transcripts hydrated from a
//! `session/load` replay have no such line (the agent replays only
//! notifications), so there the boundary falls back to "a user message chunk
//! starts a new turn" — which is exactly how the replay is structured.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use chrono::{DateTime, TimeZone, Utc};
use agent_client_protocol::schema::v1::{SessionUpdate, ToolCallContent};
use serde::Deserialize as _;

use crate::acp::connection::{
    extract_tool_call_images, json_value_to_text, serialize_tool_call_content,
    synthesize_edit_input_from_diffs,
};
use crate::acp::types::PromptInputBlock;
use crate::acp_transcript::{self, EntryKind, Transcript, TranscriptEntry};
use crate::models::agent::AgentType;
use crate::models::conversation::{ConversationDetail, ConversationSummary, SessionStats};
use crate::models::message::{ContentBlock, ImageData, MessageTurn, TurnRole, TurnUsage};
use crate::parsers::{user_turn_block, user_turn_block_from_wire, AgentParser, ParseError};

pub struct AcpNativeParser {
    agent_type: AgentType,
    root: PathBuf,
}

impl AcpNativeParser {
    pub fn new(agent_type: AgentType) -> Self {
        Self {
            agent_type,
            root: crate::paths::codeg_acp_transcripts_root(),
        }
    }

    /// Root-injectable constructor for tests.
    pub fn new_in(agent_type: AgentType, root: PathBuf) -> Self {
        Self { agent_type, root }
    }

    /// Directory name for this agent's transcripts: its ACP registry id.
    fn agent_dir(&self) -> &'static str {
        crate::acp::registry::registry_id_for(self.agent_type)
    }
}

impl AgentParser for AcpNativeParser {
    fn list_conversations(&self) -> Result<Vec<ConversationSummary>, ParseError> {
        let dir = self.agent_dir();
        // A transcript another one continues is a prefix of it, so listing both
        // would show one conversation twice.
        let superseded = acp_transcript::superseded_session_ids_in(&self.root, dir);
        let mut out = Vec::new();
        for session_id in acp_transcript::list_session_ids_in(&self.root, dir) {
            if superseded.contains(&session_id) {
                continue;
            }
            let transcript = acp_transcript::read_chain_in(&self.root, dir, &session_id);
            // A transcript's header is written when the ACP session opens,
            // which is BEFORE the user has said anything — opening a
            // conversation and closing it without sending leaves a
            // header-only file. Listing that would put an untitled, zero-turn
            // row in the conversation list, and it would be the only one
            // there: the database side deliberately creates no conversation
            // row until the first prompt.
            if transcript.is_empty() {
                continue;
            }
            out.push(self.summarize(&session_id, &transcript));
        }
        out.sort_by_key(|c| std::cmp::Reverse(c.started_at));
        Ok(out)
    }

    fn get_conversation(&self, conversation_id: &str) -> Result<ConversationDetail, ParseError> {
        let dir = self.agent_dir();
        // Reads the whole continuation chain: when the agent had forgotten the
        // session and codeg started a fresh one, the earlier turns still live
        // under the previous session id.
        let transcript = acp_transcript::read_chain_in(&self.root, dir, conversation_id);
        if transcript.header.is_none() && transcript.is_empty() {
            return Err(ParseError::ConversationNotFound(conversation_id.to_string()));
        }
        let turns = project_turns(&transcript.entries);
        let (used, size) = latest_context_window(&transcript.entries);
        let session_stats = crate::parsers::merge_context_window_stats(
            session_stats(&turns),
            used,
            size,
        );
        Ok(ConversationDetail {
            summary: self.summarize(conversation_id, &transcript),
            turns,
            session_stats,
            // Not a single-file byte-watermark store; the background-overlay
            // hand-off this field drives is Claude-only.
            transcript_watermark: None,
        })
    }
}

impl AcpNativeParser {
    fn summarize(&self, session_id: &str, transcript: &Transcript) -> ConversationSummary {
        let started_at = transcript
            .header
            .as_ref()
            .map(|h| epoch_ms_to_utc(h.started_at_ms))
            .or_else(|| transcript.entries.first().map(|e| epoch_ms_to_utc(e.t)))
            .unwrap_or_else(Utc::now);
        let ended_at = transcript.entries.last().map(|e| epoch_ms_to_utc(e.t));
        let folder_path = transcript
            .header
            .as_ref()
            .map(|h| h.cwd.clone())
            .filter(|c| !c.is_empty());
        let folder_name = folder_path.as_deref().and_then(|p| {
            Path::new(p)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
        });
        let user_turns = transcript
            .entries
            .iter()
            .filter(|e| e.k == EntryKind::Prompt)
            .count();
        ConversationSummary {
            id: session_id.to_string(),
            agent_type: self.agent_type,
            folder_path,
            folder_name,
            // The first prompt's text is the only title an ACP transcript can
            // honestly yield — ACP has no title channel, and codeg's DB-side
            // auto-title backfill takes it from here.
            title: first_prompt_title(&transcript.entries),
            started_at,
            ended_at,
            message_count: user_turns as u32,
            model: None,
            git_branch: None,
            parent_id: None,
            parent_tool_use_id: None,
            delegation_call_id: None,
        }
    }
}

fn epoch_ms_to_utc(ms: u64) -> DateTime<Utc> {
    Utc.timestamp_millis_opt(ms as i64).single().unwrap_or_else(Utc::now)
}

fn first_prompt_title(entries: &[TranscriptEntry]) -> Option<String> {
    let first = entries.iter().find(|e| e.k == EntryKind::Prompt)?;
    let text = prompt_text(&first.p);
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(crate::parsers::truncate_str(trimmed, 80))
}

/// Concatenate the text of a recorded `session/prompt` content-block array.
///
/// Prose ONLY. An attachment-only prompt yields nothing here on purpose: this
/// string is the *authoritative* parsed title, and
/// `commands::conversations` writes it over any unlocked title the row
/// already has — including one the agent itself published over
/// `session_info_update`. Naming such a conversation after its attachment is
/// worth doing, but as a seed for a row that has no title at all; that lives
/// in `acp::manager`'s first-prompt seed (`attachment_names_from_prompt`).
fn prompt_text(payload: &serde_json::Value) -> String {
    payload
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
}

/// Blocks for a user turn recorded from a `session/prompt` payload.
fn prompt_blocks(payload: &serde_json::Value) -> Vec<ContentBlock> {
    let Some(items) = payload.as_array() else {
        return Vec::new();
    };
    items.iter().filter_map(user_turn_block_from_wire).collect()
}

/// The replayed counterpart of [`crate::acp::types::prompt_block_from_wire`]:
/// a `session/load`
/// chunk arrives already deserialized, so it is converted straight across
/// rather than being serialized back to JSON only to be re-read. Consumes the
/// block, so an embedded image's base64 moves instead of being copied twice.
fn prompt_block_from_content(content: agent_client_protocol::schema::v1::ContentBlock) -> Option<PromptInputBlock> {
    use agent_client_protocol::schema::v1::{ContentBlock as Wire, EmbeddedResourceResource as Res};
    let non_empty = |s: String| (!s.is_empty()).then_some(s);
    match content {
        Wire::Text(t) => Some(PromptInputBlock::Text {
            text: non_empty(t.text)?,
        }),
        Wire::Image(i) => Some(PromptInputBlock::Image {
            data: non_empty(i.data)?,
            mime_type: i.mime_type,
            uri: i.uri.and_then(non_empty),
        }),
        Wire::ResourceLink(l) => {
            let uri = non_empty(l.uri)?;
            Some(PromptInputBlock::ResourceLink {
                name: non_empty(l.name).unwrap_or_else(|| uri.clone()),
                uri,
                mime_type: l.mime_type,
                description: l.description,
            })
        }
        Wire::Resource(r) => {
            let (uri, mime_type, text, blob) = match r.resource {
                Res::TextResourceContents(t) => (t.uri, t.mime_type, non_empty(t.text), None),
                Res::BlobResourceContents(b) => (b.uri, b.mime_type, None, non_empty(b.blob)),
                // A shape this build does not know: it has no uri to show and
                // no bytes this can render.
                _ => return None,
            };
            let is_image = mime_type.as_deref().is_some_and(|m| m.starts_with("image/"));
            if uri.is_empty() && !(is_image && blob.is_some()) {
                return None;
            }
            Some(PromptInputBlock::Resource {
                uri,
                mime_type,
                text,
                blob,
            })
        }
        // Audio, and any kind a newer schema adds: nothing to render.
        _ => None,
    }
}

/// Accumulated state of one assistant turn under construction.
#[derive(Default)]
struct PendingTurn {
    blocks: Vec<ContentBlock>,
    started_at_ms: u64,
    last_at_ms: u64,
    /// Index into `blocks` of each open tool call's `ToolUse`, so a later
    /// `tool_call_update` patches the same block instead of appending a
    /// duplicate.
    tool_use_index: HashMap<String, usize>,
    /// Index of each tool call's `ToolResult`, appended on first output.
    tool_result_index: HashMap<String, usize>,
    usage: Option<TurnUsage>,
    duration_ms: Option<u64>,
    model: Option<String>,
    has_content: bool,
}

impl PendingTurn {
    fn new(at_ms: u64) -> Self {
        Self {
            started_at_ms: at_ms,
            last_at_ms: at_ms,
            ..Default::default()
        }
    }

    /// Append text, coalescing with a trailing block of the same kind so a
    /// streamed reply becomes one paragraph rather than one block per chunk.
    fn push_text(&mut self, text: &str, thinking: bool) {
        if text.is_empty() {
            return;
        }
        self.has_content = true;
        match self.blocks.last_mut() {
            Some(ContentBlock::Text { text: existing }) if !thinking => {
                existing.push_str(text);
                return;
            }
            Some(ContentBlock::Thinking { text: existing }) if thinking => {
                existing.push_str(text);
                return;
            }
            _ => {}
        }
        self.blocks.push(if thinking {
            ContentBlock::Thinking {
                text: text.to_string(),
            }
        } else {
            ContentBlock::Text {
                text: text.to_string(),
            }
        });
    }
}

/// Whether a `session/update` carries anything this module reads back — the
/// **write-side** gate, called by `acp::connection` before a line is recorded.
///
/// ACP broadcasts far more than conversation content: `available_commands_update`
/// alone republishes the agent's whole slash-command catalog (tens of KB) every
/// time it changes. Recording what nothing ever reads inflates every later parse
/// of the file for no gain.
///
/// This is a whitelist, not a blacklist, so an unrecognized future variant
/// degrades to "not recorded" rather than to "silently bloats every transcript".
/// It MUST stay in step with the two consumers below —
/// [`apply_update`]'s match arms and [`latest_context_window`] — and
/// `recorded_updates_are_exactly_the_ones_the_projection_reads` fails the build
/// if it drifts from either.
pub fn is_recorded_update(update: &SessionUpdate) -> bool {
    matches!(
        update,
        SessionUpdate::UserMessageChunk(_)
            | SessionUpdate::AgentMessageChunk(_)
            | SessionUpdate::AgentThoughtChunk(_)
            | SessionUpdate::ToolCall(_)
            | SessionUpdate::ToolCallUpdate(_)
            | SessionUpdate::Plan(_)
            | SessionUpdate::UsageUpdate(_)
    )
}

/// The context-window reading a transcript ends on: `(used, size)` from its
/// last recorded `usage_update`.
///
/// ACP's usage channel reports context **occupancy** (`used` of `size` tokens),
/// not the per-turn input/output counts `MessageTurn::usage` holds — so it
/// feeds the session footer's context-window trio, exactly like the built-in
/// parsers derive it from their own stores, and never a turn's token usage.
/// (A turn's usage stays `None` for custom agents: ACP has no channel for it,
/// and inventing one from occupancy deltas would be a guess rendered as fact.)
///
/// Matched on the raw payload rather than by deserializing: the answer is
/// almost always in the last few entries, and a string compare per entry costs
/// nothing next to building a `SessionUpdate`.
fn latest_context_window(entries: &[TranscriptEntry]) -> (Option<u64>, Option<u64>) {
    let found = entries.iter().rev().find(|e| {
        e.k == EntryKind::Update
            && e.p.get("sessionUpdate").and_then(|v| v.as_str()) == Some("usage_update")
    });
    let Some(entry) = found else {
        return (None, None);
    };
    let field = |name: &str| entry.p.get(name).and_then(|v| v.as_u64());
    // A window of zero is not a reading, it is an agent that reported nothing;
    // surfacing "0 tokens of 0" as a live gauge would be worse than silence.
    match field("size").filter(|s| *s > 0) {
        Some(size) => (field("used"), Some(size)),
        None => (None, None),
    }
}

/// Project recorded transcript entries into turns.
pub fn project_turns(entries: &[TranscriptEntry]) -> Vec<MessageTurn> {
    let mut turns: Vec<MessageTurn> = Vec::new();
    let mut pending: Option<PendingTurn> = None;
    // True between a recorded outgoing prompt and the first agent output: the
    // agent's `user_message_chunk` echo of that same prompt must not become a
    // second user turn.
    let mut prompt_just_recorded = false;
    // Timestamp of the prompt that opened the current turn. An assistant turn's
    // span starts when codeg SENT the prompt, not when the first token arrived —
    // time-to-first-token is part of how long the agent took, and this matches
    // what `turn_timings` records for built-ins.
    let mut turn_start_hint: Option<u64> = None;
    // True when the last block of the open user turn is PROSE — text a
    // `user_message_chunk` streamed — so the next text chunk may be appended to
    // it. False after an attachment marker or an image, which are one block per
    // prompt block in the live projection and must stay that way here: gluing
    // the next chunk's prose onto `[uri](uri)` would render one run-on
    // paragraph where the live path renders two.
    let mut user_prose_open = false;
    let mut seq = 0usize;

    for entry in entries {
        match entry.k {
            EntryKind::Prompt => {
                flush(&mut pending, &mut turns, &mut seq);
                let blocks = prompt_blocks(&entry.p);
                turns.push(MessageTurn {
                    id: format!("acp-{seq}"),
                    role: TurnRole::User,
                    blocks,
                    timestamp: epoch_ms_to_utc(entry.t),
                    usage: None,
                    duration_ms: None,
                    model: None,
                    completed_at: None,
                agent_message_id: None,
                });
                seq += 1;
                prompt_just_recorded = true;
                turn_start_hint = Some(entry.t);
                // A recorded prompt is a COMPLETE message, never a half-streamed
                // one, so nothing may be appended to its trailing block.
                user_prose_open = false;
            }
            EntryKind::TurnEnd => {
                if let Some(p) = pending.as_mut() {
                    apply_turn_end(p, &entry.p);
                    p.last_at_ms = entry.t;
                }
                flush(&mut pending, &mut turns, &mut seq);
                prompt_just_recorded = false;
                turn_start_hint = None;
                user_prose_open = false;
            }
            EntryKind::Update => {
                // Deserialized from a BORROWED `&Value`, not a cloned one: this
                // runs once per recorded chunk, and a long conversation records
                // tens of thousands, so cloning each payload only to drop it a
                // line later was a measurable share of the whole read.
                let Ok(update) = SessionUpdate::deserialize(&entry.p) else {
                    // A transcript written by a newer schema than this build
                    // understands. The raw line stays on disk (it is the ACP
                    // wire format, not an internal type), so a later build can
                    // still read it; skipping is the honest degradation.
                    tracing::debug!("[acp-native] skipping unparsable session update");
                    continue;
                };
                apply_update(
                    update,
                    entry.t,
                    &mut pending,
                    &mut turns,
                    &mut seq,
                    &mut prompt_just_recorded,
                    &mut turn_start_hint,
                    &mut user_prose_open,
                );
            }
        }
    }
    flush(&mut pending, &mut turns, &mut seq);
    turns
}

fn flush(pending: &mut Option<PendingTurn>, turns: &mut Vec<MessageTurn>, seq: &mut usize) {
    let Some(p) = pending.take() else { return };
    if !p.has_content {
        return;
    }
    turns.push(MessageTurn {
        id: format!("acp-{seq}"),
        role: TurnRole::Assistant,
        blocks: p.blocks,
        timestamp: epoch_ms_to_utc(p.started_at_ms),
        usage: p.usage,
        duration_ms: p
            .duration_ms
            .or_else(|| p.last_at_ms.checked_sub(p.started_at_ms)),
        model: p.model,
        completed_at: Some(epoch_ms_to_utc(p.last_at_ms)),
    agent_message_id: None,
    });
    *seq += 1;
}

fn apply_turn_end(pending: &mut PendingTurn, payload: &serde_json::Value) {
    if let Some(ms) = payload.get("durationMs").and_then(|v| v.as_u64()) {
        pending.duration_ms = Some(ms);
    }
    if let Some(model) = payload.get("model").and_then(|v| v.as_str()) {
        if !model.is_empty() {
            pending.model = Some(model.to_string());
        }
    }
    if let Some(usage) = payload.get("usage") {
        if let Some(parsed) = parse_usage(usage) {
            pending.usage = Some(parsed);
        }
    }
}

/// Read an ACP usage object. Field names follow the `unstable_session_usage`
/// shape, with snake_case accepted as well since agents differ.
fn parse_usage(value: &serde_json::Value) -> Option<TurnUsage> {
    let get = |camel: &str, snake: &str| -> u64 {
        value
            .get(camel)
            .or_else(|| value.get(snake))
            .and_then(|v| v.as_u64())
            .unwrap_or(0)
    };
    let input = get("inputTokens", "input_tokens");
    let output = get("outputTokens", "output_tokens");
    let cache_create = get("cacheCreationInputTokens", "cache_creation_input_tokens");
    let cache_read = get("cacheReadInputTokens", "cache_read_input_tokens");
    if input == 0 && output == 0 && cache_create == 0 && cache_read == 0 {
        return None;
    }
    Some(TurnUsage {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: cache_create,
        cache_read_input_tokens: cache_read,
    })
}

#[allow(clippy::too_many_arguments)]
fn apply_update(
    update: SessionUpdate,
    at_ms: u64,
    pending: &mut Option<PendingTurn>,
    turns: &mut Vec<MessageTurn>,
    seq: &mut usize,
    prompt_just_recorded: &mut bool,
    turn_start_hint: &mut Option<u64>,
    user_prose_open: &mut bool,
) {
    // Opening a turn consumes the prompt's timestamp, so the turn's span covers
    // time-to-first-token; without a recorded prompt (replay) it starts here.
    macro_rules! open_turn {
        () => {
            pending.get_or_insert_with(|| PendingTurn::new(turn_start_hint.take().unwrap_or(at_ms)))
        };
    }
    match update {
        SessionUpdate::UserMessageChunk(chunk) => {
            // Live path: codeg already recorded the outgoing prompt, so the
            // agent's echo is a duplicate. Replay path: there is no recorded
            // prompt, so this IS the user turn and it also ends the previous
            // assistant turn.
            if *prompt_just_recorded {
                return;
            }
            let Some(input) = prompt_block_from_content(chunk.content) else {
                return;
            };
            // Resource/image chunks append in order to the same user turn;
            // incoming text chunks retain the existing text-coalescing behavior,
            // but only onto prose — an attachment marker is one block per prompt
            // block in the live projection, and appending to it would glue the
            // next sentence onto the end of a markdown link.
            let is_text = matches!(input, PromptInputBlock::Text { .. });
            let block = user_turn_block(&input);
            let coalesce = is_text && *user_prose_open;
            flush(pending, turns, seq);
            *turn_start_hint = Some(at_ms);
            match turns.last_mut() {
                // Consecutive replay chunks belong to one user message.
                Some(last) if matches!(last.role, TurnRole::User) => {
                    if let (
                        true,
                        Some(ContentBlock::Text { text: existing }),
                        ContentBlock::Text { text },
                    ) = (coalesce, last.blocks.last_mut(), &block)
                    {
                        existing.push_str(text);
                    } else {
                        last.blocks.push(block);
                    }
                }
                _ => {
                    turns.push(MessageTurn {
                        id: format!("acp-{seq}"),
                        role: TurnRole::User,
                        blocks: vec![block],
                        timestamp: epoch_ms_to_utc(at_ms),
                        usage: None,
                        duration_ms: None,
                        model: None,
                        completed_at: None,
                        agent_message_id: None,
                    });
                    *seq += 1;
                }
            }
            *user_prose_open = is_text;
        }
        SessionUpdate::AgentMessageChunk(chunk) => {
            *prompt_just_recorded = false;
            let p = open_turn!();
            p.last_at_ms = at_ms;
            match &chunk.content {
                agent_client_protocol::schema::v1::ContentBlock::Image(image) => {
                    p.has_content = true;
                    p.blocks.push(ContentBlock::Image {
                        data: image.data.clone(),
                        mime_type: image.mime_type.clone(),
                        uri: image.uri.clone(),
                    });
                }
                other => {
                    let text = content_block_text(other);
                    p.push_text(&text, false);
                }
            }
        }
        SessionUpdate::AgentThoughtChunk(chunk) => {
            *prompt_just_recorded = false;
            let p = open_turn!();
            p.last_at_ms = at_ms;
            let text = content_block_text(&chunk.content);
            p.push_text(&text, true);
        }
        SessionUpdate::ToolCall(tc) => {
            *prompt_just_recorded = false;
            let p = open_turn!();
            p.last_at_ms = at_ms;
            let id = tc.tool_call_id.to_string();
            let status = format!("{:?}", tc.status).to_lowercase();
            upsert_tool_call(
                p,
                &id,
                Some(tc.title.clone()),
                tc.raw_input.as_ref(),
                &tc.content,
                tc.raw_output.as_ref(),
                Some(status.as_str()),
                tc.meta.clone().map(serde_json::Value::Object),
            );
        }
        SessionUpdate::ToolCallUpdate(tcu) => {
            *prompt_just_recorded = false;
            let p = open_turn!();
            p.last_at_ms = at_ms;
            let id = tcu.tool_call_id.to_string();
            let status = tcu.fields.status.map(|s| format!("{s:?}").to_lowercase());
            upsert_tool_call(
                p,
                &id,
                tcu.fields.title.clone(),
                tcu.fields.raw_input.as_ref(),
                tcu.fields.content.as_deref().unwrap_or(&[]),
                tcu.fields.raw_output.as_ref(),
                status.as_deref(),
                tcu.meta.clone().map(serde_json::Value::Object),
            );
        }
        SessionUpdate::Plan(plan) => {
            *prompt_just_recorded = false;
            let p = open_turn!();
            p.last_at_ms = at_ms;
            upsert_plan(p, &plan);
        }
        // Nothing else describes a TURN. `usage_update` does reach the
        // projection, but through [`latest_context_window`] — it reports the
        // session's context occupancy, not this turn's tokens. The rest
        // (slash-command catalogs, mode switches, config echoes) is refused at
        // record time by [`is_recorded_update`] and survives only in
        // transcripts written before that filter existed.
        _ => {}
    }
}

/// Text of an ACP content block. Non-text blocks that still carry a textual
/// projection (resource links, embedded text resources) degrade to it.
fn content_block_text(block: &agent_client_protocol::schema::v1::ContentBlock) -> String {
    match block {
        agent_client_protocol::schema::v1::ContentBlock::Text(t) => t.text.clone(),
        agent_client_protocol::schema::v1::ContentBlock::ResourceLink(link) => link.uri.clone(),
        agent_client_protocol::schema::v1::ContentBlock::Resource(res) => match &res.resource {
            agent_client_protocol::schema::v1::EmbeddedResourceResource::TextResourceContents(t) => t.text.clone(),
            _ => String::new(),
        },
        _ => String::new(),
    }
}

/// Insert or patch one tool call's `ToolUse` / `ToolResult` pair.
///
/// Uses the same input/output/image projection as the live path so a tool call
/// looks identical whether it is streaming or reloaded from disk.
#[allow(clippy::too_many_arguments)]
fn upsert_tool_call(
    pending: &mut PendingTurn,
    id: &str,
    title: Option<String>,
    raw_input: Option<&serde_json::Value>,
    content: &[ToolCallContent],
    raw_output: Option<&serde_json::Value>,
    status: Option<&str>,
    meta: Option<serde_json::Value>,
) {
    pending.has_content = true;
    let own_input =
        json_value_to_text(&raw_input.cloned()).filter(|t| !t.trim().is_empty());
    let synthesized_edit = if own_input.is_none() {
        synthesize_edit_input_from_diffs(content)
    } else {
        None
    };
    let input_preview = synthesized_edit.clone().or(own_input);
    let output = serialize_tool_call_content(content, synthesized_edit.is_none())
        .or_else(|| json_value_to_text(&raw_output.cloned()));
    let images: Vec<ImageData> = extract_tool_call_images(content)
        .unwrap_or_default()
        .into_iter()
        .collect();
    let is_error = status == Some("failed");

    match pending.tool_use_index.get(id).copied() {
        Some(idx) => {
            if let Some(ContentBlock::ToolUse {
                tool_name,
                input_preview: existing_input,
                meta: existing_meta,
                ..
            }) = pending.blocks.get_mut(idx)
            {
                if let Some(t) = title.filter(|t| !t.is_empty()) {
                    *tool_name = t;
                }
                if input_preview.is_some() {
                    *existing_input = input_preview;
                }
                if meta.is_some() {
                    *existing_meta = meta;
                }
            }
        }
        None => {
            pending.tool_use_index.insert(id.to_string(), pending.blocks.len());
            pending.blocks.push(ContentBlock::ToolUse {
                tool_use_id: Some(id.to_string()),
                // ACP has no tool *name* channel — `title` is what the agent
                // chose to display, and it is what the frontend classifier
                // falls back to for built-ins too.
                tool_name: title.unwrap_or_else(|| "tool".to_string()),
                input_preview,
                status: None,
                meta,
            });
        }
    }

    // A result block appears only once the call produced output (or failed);
    // a pending call with no content yet renders as a running tool card.
    if output.is_none() && images.is_empty() && !is_error {
        return;
    }
    match pending.tool_result_index.get(id).copied() {
        Some(idx) => {
            if let Some(ContentBlock::ToolResult {
                output_preview,
                is_error: existing_error,
                images: existing_images,
                ..
            }) = pending.blocks.get_mut(idx)
            {
                if output.is_some() {
                    *output_preview = output;
                }
                *existing_error = is_error;
                if !images.is_empty() {
                    *existing_images = images;
                }
            }
        }
        None => {
            pending
                .tool_result_index
                .insert(id.to_string(), pending.blocks.len());
            pending.blocks.push(ContentBlock::ToolResult {
                tool_use_id: Some(id.to_string()),
                output_preview: output,
                is_error,
                agent_stats: None,
                images,
            });
        }
    }
}

/// ACP plans are cumulative snapshots: each `plan` update replaces the previous
/// one. Model that as a single synthetic `TodoWrite` tool call whose input the
/// frontend already renders as a plan card.
fn upsert_plan(pending: &mut PendingTurn, plan: &agent_client_protocol::schema::v1::Plan) {
    let todos: Vec<serde_json::Value> = plan
        .entries
        .iter()
        .map(|e| {
            serde_json::json!({
                "content": e.content,
                "status": format!("{:?}", e.status).to_lowercase(),
                "priority": format!("{:?}", e.priority).to_lowercase(),
            })
        })
        .collect();
    let input = serde_json::json!({ "todos": todos }).to_string();
    const PLAN_ID: &str = "acp-plan";
    pending.has_content = true;
    match pending.tool_use_index.get(PLAN_ID).copied() {
        Some(idx) => {
            if let Some(ContentBlock::ToolUse { input_preview, .. }) = pending.blocks.get_mut(idx) {
                *input_preview = Some(input);
            }
        }
        None => {
            pending
                .tool_use_index
                .insert(PLAN_ID.to_string(), pending.blocks.len());
            pending.blocks.push(ContentBlock::ToolUse {
                tool_use_id: Some(PLAN_ID.to_string()),
                tool_name: "TodoWrite".to_string(),
                input_preview: Some(input),
                status: None,
                meta: None,
            });
        }
    }
}

/// Aggregate per-turn usage into the session footer. `None` when no turn
/// carried usage (ACP usage reporting is optional).
fn session_stats(turns: &[MessageTurn]) -> Option<SessionStats> {
    let total_duration_ms: u64 = turns.iter().filter_map(|t| t.duration_ms).sum();
    let mut total = TurnUsage {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
    };
    let mut any = false;
    for usage in turns.iter().filter_map(|t| t.usage.as_ref()) {
        any = true;
        total.input_tokens += usage.input_tokens;
        total.output_tokens += usage.output_tokens;
        total.cache_creation_input_tokens += usage.cache_creation_input_tokens;
        total.cache_read_input_tokens += usage.cache_read_input_tokens;
    }
    if !any && total_duration_ms == 0 {
        return None;
    }
    let total_tokens = any.then(|| {
        total.input_tokens
            + total.output_tokens
            + total.cache_creation_input_tokens
            + total.cache_read_input_tokens
    });
    Some(SessionStats {
        total_usage: any.then_some(total),
        total_tokens,
        total_duration_ms,
        context_window_used_tokens: None,
        context_window_max_tokens: None,
        context_window_usage_percent: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::types::prompt_block_from_wire;
    use crate::acp_transcript::{TranscriptEntry, TranscriptHeader};

    fn entry(t: u64, k: EntryKind, p: serde_json::Value) -> TranscriptEntry {
        TranscriptEntry { t, k, p }
    }

    fn update(t: u64, p: serde_json::Value) -> TranscriptEntry {
        entry(t, EntryKind::Update, p)
    }

    fn prompt(t: u64, text: &str) -> TranscriptEntry {
        entry(
            t,
            EntryKind::Prompt,
            serde_json::json!([{ "type": "text", "text": text }]),
        )
    }

    fn text_chunk(kind: &str, text: &str) -> serde_json::Value {
        serde_json::json!({
            "sessionUpdate": kind,
            "content": { "type": "text", "text": text }
        })
    }

    fn attachment_prompt() -> serde_json::Value {
        serde_json::json!([
            {"type":"text", "text":"Review these files"},
            {"type":"resource_link", "name":"report.pdf", "uri":"file:///tmp/report.pdf", "mimeType":"application/pdf"},
            {"type":"resource", "resource":{"uri":"attachment:///note.txt", "mimeType":"text/plain", "text":"private file contents"}},
            {"type":"resource", "resource":{"uri":"attachment:///data.bin", "mimeType":"application/octet-stream", "blob":"c2VjcmV0"}},
            {"type":"resource", "resource":{"uri":"attachment:///plot.png", "mimeType":"image/png", "blob":"aW1hZ2U="}},
            {"type":"image", "data":"bmF0aXZl", "mimeType":"image/jpeg", "uri":"file:///tmp/photo.jpg"}
        ])
    }

    #[test]
    fn recorded_prompt_preserves_attachment_markers_and_images() {
        let turns = project_turns(&[entry(1, EntryKind::Prompt, attachment_prompt())]);
        assert_eq!(turns.len(), 1);
        let blocks = &turns[0].blocks;
        assert_eq!(blocks.len(), 6);
        for (index, expected) in [
            (1, "[report.pdf](file:///tmp/report.pdf)"),
            // The attachment a text resource is shown as — without its body.
            (
                2,
                "attachment:///note.txt\n<context ref=\"attachment:///note.txt\">\n\n</context>",
            ),
            (3, "[attachment:///data.bin](attachment:///data.bin)"),
        ] {
            assert!(matches!(&blocks[index], ContentBlock::Text { text } if text == expected));
        }
        assert!(
            matches!(&blocks[4], ContentBlock::Image { data, mime_type, uri }
            if data == "aW1hZ2U=" && mime_type == "image/png" && uri.as_deref() == Some("attachment:///plot.png"))
        );
        assert!(
            matches!(&blocks[5], ContentBlock::Image { data, mime_type, .. }
            if data == "bmF0aXZl" && mime_type == "image/jpeg")
        );
        let text = prompt_text(&attachment_prompt());
        assert_eq!(text, "Review these files");
    }

    #[test]
    fn replayed_attachments_match_recorded_prompt_and_stay_in_one_user_turn() {
        let payload = attachment_prompt();
        let mut entries = vec![];
        for (i, content) in payload.as_array().unwrap().iter().enumerate() {
            entries.push(update(
                i as u64 + 1,
                serde_json::json!({
                    "sessionUpdate":"user_message_chunk", "content":content
                }),
            ));
        }
        entries.push(update(10, text_chunk("user_message_chunk", "after ")));
        entries.push(update(11, text_chunk("user_message_chunk", "images")));
        entries.push(update(12, text_chunk("agent_message_chunk", "done")));
        let turns = project_turns(&entries);
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].blocks.len(), 7);
        let expected = prompt_blocks(&payload);
        assert_eq!(
            serde_json::to_value(&turns[0].blocks[..6]).unwrap(),
            serde_json::to_value(expected).unwrap()
        );
        assert!(
            matches!(&turns[0].blocks[6], ContentBlock::Text { text } if text == "after images")
        );
        assert!(matches!(turns[1].role, TurnRole::Assistant));
    }

    #[test]
    fn recorded_attachment_echoes_do_not_duplicate_user_turns() {
        let payload = attachment_prompt();
        let mut entries = vec![entry(1, EntryKind::Prompt, payload.clone())];
        for content in payload.as_array().unwrap() {
            entries.push(update(
                2,
                serde_json::json!({"sessionUpdate":"user_message_chunk", "content":content}),
            ));
        }
        entries.push(update(3, text_chunk("agent_message_chunk", "done")));
        let turns = project_turns(&entries);
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].blocks.len(), 6);
    }

    /// A recorded prompt is read as raw JSON (it must survive bytes written by
    /// older builds) while a `session/load` chunk arrives already typed. Two
    /// readers, one meaning: the same content has to produce the same block
    /// whichever door it comes through, or history would contradict itself
    /// depending on whether codeg recorded the turn or the agent replayed it.
    #[test]
    fn the_typed_and_raw_readers_agree_on_the_same_content() {
        for item in attachment_prompt().as_array().expect("an array") {
            let typed = agent_client_protocol::schema::v1::ContentBlock::deserialize(item)
                .expect("every block in the fixture is valid ACP");
            assert_eq!(
                prompt_block_from_content(typed),
                prompt_block_from_wire(item),
                "{item}"
            );
        }
        // And on content neither door should let through.
        for junk in [
            serde_json::json!({"type":"text", "text":""}),
            serde_json::json!({"type":"image", "data":"", "mimeType":"image/png"}),
            serde_json::json!({"type":"resource_link", "uri":"", "name":"x"}),
            serde_json::json!({"type":"audio", "data":"QUJD", "mimeType":"audio/wav"}),
        ] {
            assert_eq!(prompt_block_from_wire(&junk), None, "{junk}");
            if let Ok(typed) = agent_client_protocol::schema::v1::ContentBlock::deserialize(&junk) {
                assert_eq!(prompt_block_from_content(typed), None, "{junk}");
            }
        }
    }

    /// The parsed title is the AUTHORITATIVE one — `commands::conversations`
    /// writes it over any unlocked title the row holds, including one the agent
    /// published itself. So it stays prose-only: an attachment-only prompt
    /// reports no title here and is named by the first-prompt SEED instead
    /// (`acp::manager::delegation_child_title_seed`), which only ever fills a
    /// row that has no title at all.
    #[test]
    fn the_parsed_title_is_prose_only_and_never_an_attachment_name() {
        let attachments_only = serde_json::json!([
            {"type":"resource_link", "name":"report.pdf", "uri":"file:///tmp/report.pdf"},
            {"type":"image", "data":"aW1n", "mimeType":"image/png"}
        ]);
        assert_eq!(
            first_prompt_title(&[entry(1, EntryKind::Prompt, attachments_only)]),
            None
        );
        assert_eq!(
            first_prompt_title(&[entry(1, EntryKind::Prompt, attachment_prompt())]).as_deref(),
            Some("Review these files")
        );
    }

    /// An everyday file name is not a safe Markdown fragment. The marker is
    /// escaped the way the composer escapes its own `@`-file links, so the
    /// frontend's reference-link parser recovers the real path instead of
    /// showing raw `[…](…)` source with the link broken at the first space.
    #[test]
    fn markers_for_awkward_paths_stay_well_formed_links() {
        let blocks = prompt_blocks(&serde_json::json!([
            {"type":"resource_link", "name":"b (1).ts", "uri":"file:///a/b (1).ts"},
            {"type":"resource", "resource":{"uri":"file:///a/c).ts", "mimeType":"text/plain"}}
        ]));
        assert_eq!(blocks.len(), 2);
        assert!(
            matches!(&blocks[0], ContentBlock::Text { text } if text == "[b \\(1\\).ts](<file:///a/b (1).ts>)")
        );
        assert!(
            matches!(&blocks[1], ContentBlock::Text { text } if text == "[file:///a/c\\).ts](<file:///a/c).ts>)")
        );
    }

    /// A replay whose user message puts the attachment BEFORE the prose (the
    /// order an agent that front-loads file context stores it in). The marker is
    /// a whole block, so the sentence after it must not be glued onto the end of
    /// its markdown link — the live projection emits one block per prompt block,
    /// and the transcript has to read the same way.
    #[test]
    fn replayed_prose_after_an_attachment_marker_stays_its_own_block() {
        let entries = vec![
            update(
                1,
                serde_json::json!({
                    "sessionUpdate":"user_message_chunk",
                    "content":{"type":"resource", "resource":{
                        "uri":"file:///tmp/note.txt", "mimeType":"text/plain", "text":"body"
                    }}
                }),
            ),
            update(2, text_chunk("user_message_chunk", "what does ")),
            update(3, text_chunk("user_message_chunk", "this do?")),
            update(4, text_chunk("agent_message_chunk", "reading it")),
        ];
        let turns = project_turns(&entries);
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].blocks.len(), 2);
        assert!(
            matches!(&turns[0].blocks[0], ContentBlock::Text { text } if text == "file:///tmp/note.txt\n<context ref=\"file:///tmp/note.txt\">\n\n</context>")
        );
        // The two prose chunks still coalesce with each other.
        assert!(
            matches!(&turns[0].blocks[1], ContentBlock::Text { text } if text == "what does this do?")
        );
    }

    /// The regression the attachment fix turns on: a user message carrying only
    /// an attachment used to project to nothing, so it neither ended the
    /// previous assistant turn nor appeared at all — the next reply merged into
    /// the previous one.
    #[test]
    fn an_attachment_only_replayed_chunk_ends_the_previous_assistant_turn() {
        let entries = vec![
            update(1, text_chunk("agent_message_chunk", "first reply")),
            update(
                2,
                serde_json::json!({
                    "sessionUpdate":"user_message_chunk",
                    "content":{"type":"resource", "resource":{
                        "uri":"file:///tmp/data.bin",
                        "mimeType":"application/octet-stream",
                        "blob":"c2VjcmV0"
                    }}
                }),
            ),
            update(3, text_chunk("agent_message_chunk", "second reply")),
        ];
        let turns = project_turns(&entries);
        assert_eq!(turns.len(), 3);
        assert!(matches!(turns[0].role, TurnRole::Assistant));
        assert!(matches!(turns[1].role, TurnRole::User));
        assert_eq!(turns[1].blocks.len(), 1);
        assert!(matches!(turns[2].role, TurnRole::Assistant));
        assert!(
            matches!(&turns[2].blocks[0], ContentBlock::Text { text } if text == "second reply")
        );
    }

    /// The live user turn is projected by `acp::types::user_blocks_from_prompt`;
    /// this parser re-derives the same mapping from the recorded wire bytes.
    /// They are two implementations of one contract — a viewer watching live and
    /// a reader after a refresh must see the same message — so pin them
    /// together over the block shapes codeg's composer actually sends.
    #[test]
    fn history_projection_matches_the_live_user_message_projection() {
        use crate::acp::types::{user_blocks_from_prompt, PromptInputBlock, UserMessageBlock};

        let sent = vec![
            PromptInputBlock::Text {
                text: "Review these files".into(),
            },
            PromptInputBlock::ResourceLink {
                uri: "file:///tmp/report.pdf".into(),
                name: "report.pdf".into(),
                mime_type: Some("application/pdf".into()),
                description: None,
            },
            // A path-less pasted text file: embedded body, synthetic uri.
            PromptInputBlock::Resource {
                uri: "clipboard://note.txt-1".into(),
                mime_type: Some("text/plain".into()),
                text: Some("private file contents".into()),
                blob: None,
            },
            PromptInputBlock::Resource {
                uri: "clipboard://data.bin-2".into(),
                mime_type: Some("application/octet-stream".into()),
                text: None,
                blob: Some("c2VjcmV0".into()),
            },
            // How an `image: false` / `embedded_context: true` agent carries an
            // image — promoted back to a thumbnail on BOTH sides.
            PromptInputBlock::Resource {
                uri: "clipboard://plot.png-3".into(),
                mime_type: Some("image/png".into()),
                text: None,
                blob: Some("aW1hZ2U=".into()),
            },
            PromptInputBlock::Image {
                data: "bmF0aXZl".into(),
                mime_type: "image/jpeg".into(),
                uri: Some("file:///tmp/photo.jpg".into()),
            },
        ];
        // Exactly what `record_prompt` writes: the wire blocks `session/prompt`
        // carried, serialized.
        let recorded =
            serde_json::to_value(crate::acp::connection::map_prompt_blocks(sent.clone()))
                .expect("wire blocks serialize");

        // `uri` is dropped on both sides: the broadcast carries an image by its
        // bytes alone, so it is not a projection difference to compare.
        let live: Vec<(&str, String, String)> = user_blocks_from_prompt(&sent)
            .iter()
            .map(|b| match b {
                UserMessageBlock::Text { text } => ("text", text.clone(), String::new()),
                UserMessageBlock::Image { data, mime_type } => {
                    ("image", data.clone(), mime_type.clone())
                }
            })
            .collect();
        let history: Vec<(&str, String, String)> = prompt_blocks(&recorded)
            .iter()
            .map(|b| match b {
                ContentBlock::Text { text } => ("text", text.clone(), String::new()),
                ContentBlock::Image {
                    data, mime_type, ..
                } => ("image", data.clone(), mime_type.clone()),
                other => panic!("a user turn may only hold text and images, got {other:?}"),
            })
            .collect();
        assert_eq!(history, live);
    }

    #[test]
    fn attachment_only_history_is_not_empty_and_malformed_resources_are_ignored() {
        let blocks = prompt_blocks(&serde_json::json!([
            {"type":"resource_link", "uri":"file:///tmp/unnamed", "name":""},
            {"type":"resource", "resource":{"uri":"attachment:///empty.png", "mimeType":"image/png", "blob":""}},
            {"type":"image", "data":"legacy", "mime_type":"image/jpeg"},
            {"type":"resource"},
            {"type":"resource", "resource":{"blob":"do not expose"}},
            {"type":"resource_link", "name":"missing uri"},
            {"type":"image", "data":""}
        ]));
        assert_eq!(blocks.len(), 3);
        assert!(
            matches!(&blocks[0], ContentBlock::Text { text } if text == "[file:///tmp/unnamed](file:///tmp/unnamed)")
        );
        assert!(
            matches!(&blocks[1], ContentBlock::Text { text } if text == "[attachment:///empty.png](attachment:///empty.png)")
        );
        assert!(
            matches!(&blocks[2], ContentBlock::Image { mime_type, .. } if mime_type == "image/jpeg")
        );
    }

    #[test]
    fn projects_a_simple_two_turn_conversation() {
        let entries = vec![
            prompt(1000, "hello"),
            update(1010, text_chunk("agent_message_chunk", "hi ")),
            update(1020, text_chunk("agent_message_chunk", "there")),
            entry(
                1030,
                EntryKind::TurnEnd,
                serde_json::json!({"stopReason": "end_turn"}),
            ),
            prompt(2000, "again"),
            update(2010, text_chunk("agent_message_chunk", "ok")),
        ];
        let turns = project_turns(&entries);
        assert_eq!(turns.len(), 4);
        assert!(matches!(turns[0].role, TurnRole::User));
        assert!(matches!(turns[1].role, TurnRole::Assistant));
        // Streamed chunks coalesce into one text block.
        assert_eq!(turns[1].blocks.len(), 1);
        match &turns[1].blocks[0] {
            ContentBlock::Text { text } => assert_eq!(text, "hi there"),
            other => panic!("expected text block, got {other:?}"),
        }
        // The assistant turn spans from the prompt send (1000) to turn end
        // (1030), so time-to-first-token is included.
        assert_eq!(turns[1].duration_ms, Some(30));
        assert_eq!(turns[1].timestamp, epoch_ms_to_utc(1000));
        // The trailing turn is flushed even with no TurnEnd line.
        assert!(matches!(turns[3].role, TurnRole::Assistant));
    }

    #[test]
    fn thinking_and_text_stay_separate_blocks() {
        let entries = vec![
            prompt(1, "go"),
            update(2, text_chunk("agent_thought_chunk", "let me ")),
            update(3, text_chunk("agent_thought_chunk", "think")),
            update(4, text_chunk("agent_message_chunk", "done")),
        ];
        let turns = project_turns(&entries);
        let blocks = &turns[1].blocks;
        assert_eq!(blocks.len(), 2);
        match (&blocks[0], &blocks[1]) {
            (ContentBlock::Thinking { text: think }, ContentBlock::Text { text }) => {
                assert_eq!(think, "let me think");
                assert_eq!(text, "done");
            }
            other => panic!("unexpected blocks: {other:?}"),
        }
    }

    #[test]
    fn tool_call_and_update_merge_into_one_pair() {
        let entries = vec![
            prompt(1, "run it"),
            update(
                2,
                serde_json::json!({
                    "sessionUpdate": "tool_call",
                    "toolCallId": "call-1",
                    "title": "Bash",
                    "kind": "execute",
                    "status": "pending",
                    "rawInput": { "command": "ls" }
                }),
            ),
            update(
                3,
                serde_json::json!({
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "call-1",
                    "status": "completed",
                    "content": [
                        { "type": "content", "content": { "type": "text", "text": "a.txt" } }
                    ]
                }),
            ),
        ];
        let turns = project_turns(&entries);
        let blocks = &turns[1].blocks;
        assert_eq!(blocks.len(), 2, "one ToolUse + one ToolResult");
        match &blocks[0] {
            ContentBlock::ToolUse {
                tool_use_id,
                tool_name,
                input_preview,
                ..
            } => {
                assert_eq!(tool_use_id.as_deref(), Some("call-1"));
                assert_eq!(tool_name, "Bash");
                assert!(input_preview.as_deref().unwrap().contains("\"ls\""));
            }
            other => panic!("expected tool use, got {other:?}"),
        }
        match &blocks[1] {
            ContentBlock::ToolResult {
                tool_use_id,
                output_preview,
                is_error,
                ..
            } => {
                assert_eq!(tool_use_id.as_deref(), Some("call-1"));
                assert_eq!(output_preview.as_deref(), Some("a.txt"));
                assert!(!is_error);
            }
            other => panic!("expected tool result, got {other:?}"),
        }
    }

    /// A `delegate_to_agent` call from the codeg-mcp companion must replay
    /// under its wire name. The frontend's tool-kind classifier
    /// (`isAgentLikeToolName`) recognizes `delegate_to_agent` across host
    /// naming conventions and renders the delegation card from it — the same
    /// path the live session takes — so the projection must pass the reported
    /// title through verbatim rather than genericizing or rewriting it.
    #[test]
    fn a_delegation_call_replays_under_its_wire_name() {
        let entries = vec![
            prompt(1, "fan out"),
            update(
                2,
                serde_json::json!({
                    "sessionUpdate": "tool_call",
                    "toolCallId": "call-9",
                    "title": "mcp__codeg-mcp__delegate_to_agent",
                    "kind": "other",
                    "status": "pending",
                    "rawInput": { "agent_type": "custom:goose", "task": "review the diff" }
                }),
            ),
            update(
                3,
                serde_json::json!({
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "call-9",
                    "status": "completed",
                    "content": [
                        { "type": "content", "content": { "type": "text", "text": "Task started: task-1" } }
                    ]
                }),
            ),
        ];
        let turns = project_turns(&entries);
        let blocks = &turns[1].blocks;
        match &blocks[0] {
            ContentBlock::ToolUse {
                tool_name,
                input_preview,
                ..
            } => {
                assert_eq!(tool_name, "mcp__codeg-mcp__delegate_to_agent");
                let input = input_preview.as_deref().unwrap();
                assert!(input.contains("custom:goose"));
                assert!(input.contains("review the diff"));
            }
            other => panic!("expected tool use, got {other:?}"),
        }
        match &blocks[1] {
            ContentBlock::ToolResult {
                tool_use_id,
                output_preview,
                is_error,
                ..
            } => {
                assert_eq!(tool_use_id.as_deref(), Some("call-9"));
                assert_eq!(output_preview.as_deref(), Some("Task started: task-1"));
                assert!(!is_error);
            }
            other => panic!("expected tool result, got {other:?}"),
        }
    }

    #[test]
    fn failed_tool_call_marks_the_result_as_an_error() {
        let entries = vec![
            prompt(1, "run it"),
            update(
                2,
                serde_json::json!({
                    "sessionUpdate": "tool_call",
                    "toolCallId": "c",
                    "title": "Bash",
                    "kind": "execute",
                    "status": "failed"
                }),
            ),
        ];
        let turns = project_turns(&entries);
        match turns[1].blocks.last() {
            Some(ContentBlock::ToolResult { is_error, .. }) => assert!(is_error),
            other => panic!("expected an error result, got {other:?}"),
        }
    }

    #[test]
    fn diff_content_becomes_a_canonical_edit_input() {
        // Mirrors the live path: a Diff block with no rawInput must classify as
        // an edit, not as a tool named after the diff header.
        let entries = vec![
            prompt(1, "edit it"),
            update(
                2,
                serde_json::json!({
                    "sessionUpdate": "tool_call",
                    "toolCallId": "e1",
                    "title": "--- /repo/a.txt",
                    "kind": "edit",
                    "status": "completed",
                    "content": [
                        {
                            "type": "diff",
                            "path": "/repo/a.txt",
                            "oldText": "one\n",
                            "newText": "two\n"
                        }
                    ]
                }),
            ),
        ];
        let turns = project_turns(&entries);
        match &turns[1].blocks[0] {
            ContentBlock::ToolUse { input_preview, .. } => {
                let input = input_preview.as_deref().expect("synthesized edit input");
                let v: serde_json::Value = serde_json::from_str(input).unwrap();
                assert_eq!(v["file_path"], "/repo/a.txt");
                assert_eq!(v["old_string"], "one\n");
                assert_eq!(v["new_string"], "two\n");
            }
            other => panic!("expected tool use, got {other:?}"),
        }
    }

    #[test]
    fn plan_updates_collapse_into_one_replaceable_card() {
        let entries = vec![
            prompt(1, "plan it"),
            update(
                2,
                serde_json::json!({
                    "sessionUpdate": "plan",
                    "entries": [
                        {"content": "step one", "priority": "high", "status": "pending"}
                    ]
                }),
            ),
            update(
                3,
                serde_json::json!({
                    "sessionUpdate": "plan",
                    "entries": [
                        {"content": "step one", "priority": "high", "status": "completed"},
                        {"content": "step two", "priority": "medium", "status": "pending"}
                    ]
                }),
            ),
        ];
        let turns = project_turns(&entries);
        let plan_blocks: Vec<_> = turns[1]
            .blocks
            .iter()
            .filter(|b| matches!(b, ContentBlock::ToolUse { tool_name, .. } if tool_name == "TodoWrite"))
            .collect();
        assert_eq!(plan_blocks.len(), 1, "the plan card is replaced, not repeated");
        match plan_blocks[0] {
            ContentBlock::ToolUse { input_preview, .. } => {
                let v: serde_json::Value =
                    serde_json::from_str(input_preview.as_deref().unwrap()).unwrap();
                assert_eq!(v["todos"].as_array().unwrap().len(), 2);
                assert_eq!(v["todos"][0]["status"], "completed");
            }
            other => panic!("expected tool use, got {other:?}"),
        }
    }

    #[test]
    fn live_user_echo_does_not_duplicate_the_recorded_prompt() {
        let entries = vec![
            prompt(1, "hello"),
            // The agent echoes the same prompt back before replying.
            update(2, text_chunk("user_message_chunk", "hello")),
            update(3, text_chunk("agent_message_chunk", "hi")),
        ];
        let turns = project_turns(&entries);
        assert_eq!(turns.len(), 2, "echo must not create a second user turn");
        assert!(matches!(turns[0].role, TurnRole::User));
        assert!(matches!(turns[1].role, TurnRole::Assistant));
    }

    #[test]
    fn replayed_transcript_without_prompts_still_yields_user_turns() {
        // `session/load` replays notifications only — no recorded prompts.
        let entries = vec![
            update(1, text_chunk("user_message_chunk", "hello")),
            update(2, text_chunk("agent_message_chunk", "hi")),
            update(3, text_chunk("user_message_chunk", "more")),
            update(4, text_chunk("agent_message_chunk", "ok")),
        ];
        let turns = project_turns(&entries);
        assert_eq!(turns.len(), 4);
        assert!(matches!(turns[0].role, TurnRole::User));
        assert!(matches!(turns[1].role, TurnRole::Assistant));
        assert!(matches!(turns[2].role, TurnRole::User));
        assert!(matches!(turns[3].role, TurnRole::Assistant));
        match &turns[2].blocks[0] {
            ContentBlock::Text { text } => assert_eq!(text, "more"),
            other => panic!("expected text, got {other:?}"),
        }
    }

    #[test]
    fn turn_end_usage_feeds_turn_and_session_stats() {
        let entries = vec![
            prompt(1, "hi"),
            update(2, text_chunk("agent_message_chunk", "yo")),
            entry(
                5,
                EntryKind::TurnEnd,
                serde_json::json!({
                    "stopReason": "end_turn",
                    "durationMs": 42,
                    "model": "some-model",
                    "usage": { "inputTokens": 10, "outputTokens": 5 }
                }),
            ),
        ];
        let turns = project_turns(&entries);
        let assistant = &turns[1];
        assert_eq!(assistant.duration_ms, Some(42));
        assert_eq!(assistant.model.as_deref(), Some("some-model"));
        let usage = assistant.usage.as_ref().expect("usage recorded");
        assert_eq!(usage.input_tokens, 10);
        assert_eq!(usage.output_tokens, 5);

        let stats = session_stats(&turns).expect("stats");
        assert_eq!(stats.total_tokens, Some(15));
        assert_eq!(stats.total_duration_ms, 42);
    }

    /// The write-side whitelist and the read-side match arms are two
    /// hand-maintained views of one set. This asserts they agree by RUNNING the
    /// projection over each variant rather than by restating either list, so
    /// teaching `apply_update` a new variant without whitelisting it (or the
    /// reverse) fails here instead of silently costing that content forever.
    #[test]
    fn recorded_updates_are_exactly_the_ones_the_projection_reads() {
        let samples = [
            text_chunk("user_message_chunk", "hi"),
            text_chunk("agent_message_chunk", "hi"),
            text_chunk("agent_thought_chunk", "hmm"),
            serde_json::json!({
                "sessionUpdate": "tool_call", "toolCallId": "c", "title": "Bash",
                "kind": "execute", "status": "pending"
            }),
            serde_json::json!({
                "sessionUpdate": "tool_call_update", "toolCallId": "c", "status": "completed"
            }),
            serde_json::json!({
                "sessionUpdate": "plan",
                "entries": [{"content": "step", "priority": "high", "status": "pending"}]
            }),
            serde_json::json!({"sessionUpdate": "usage_update", "used": 1, "size": 2}),
            // Not conversation content — the ones the filter exists for.
            serde_json::json!({"sessionUpdate": "available_commands_update", "availableCommands": []}),
            serde_json::json!({"sessionUpdate": "current_mode_update", "currentModeId": "ask"}),
            serde_json::json!({"sessionUpdate": "config_option_update", "configOptions": []}),
            serde_json::json!({"sessionUpdate": "session_info_update"}),
        ];
        for payload in samples {
            // Deserializing first also proves the sample really is the variant
            // it claims to be: a typo'd payload would otherwise pass as "not
            // recorded, not read" and assert nothing.
            let parsed: SessionUpdate = serde_json::from_value(payload.clone())
                .unwrap_or_else(|e| panic!("sample is not a valid SessionUpdate: {payload} ({e})"));
            let entry = [update(1, payload.clone())];
            let read = !project_turns(&entry).is_empty()
                || latest_context_window(&entry) != (None, None);
            assert_eq!(
                is_recorded_update(&parsed),
                read,
                "whitelist and projection disagree about {payload}"
            );
        }
    }

    #[test]
    fn the_last_usage_update_becomes_the_context_window_footer() {
        let entries = vec![
            prompt(1, "hi"),
            update(2, serde_json::json!({"sessionUpdate":"usage_update","used":100,"size":1000})),
            update(3, text_chunk("agent_message_chunk", "ok")),
            update(4, serde_json::json!({"sessionUpdate":"usage_update","used":250,"size":1000})),
        ];
        assert_eq!(latest_context_window(&entries), (Some(250), Some(1000)));
        // Occupancy is NOT a turn's token usage: recording it must not put
        // invented numbers on the turns.
        assert!(project_turns(&entries).iter().all(|t| t.usage.is_none()));

        // A window of zero is an agent reporting nothing, not a reading.
        let zero = [update(5, serde_json::json!({"sessionUpdate":"usage_update","used":9,"size":0}))];
        assert_eq!(latest_context_window(&zero), (None, None));
        assert_eq!(latest_context_window(&[prompt(1, "hi")]), (None, None));
    }

    #[test]
    fn unparsable_updates_are_skipped_without_losing_neighbours() {
        let entries = vec![
            prompt(1, "hi"),
            update(2, serde_json::json!({"sessionUpdate": "from_the_future"})),
            update(3, text_chunk("agent_message_chunk", "still here")),
        ];
        let turns = project_turns(&entries);
        assert_eq!(turns.len(), 2);
        match &turns[1].blocks[0] {
            ContentBlock::Text { text } => assert_eq!(text, "still here"),
            other => panic!("expected text, got {other:?}"),
        }
    }

    fn temp_root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "codeg-acp-native-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn reads_a_session_end_to_end_from_disk() {
        let root = temp_root();
        let agent = AgentType::custom("acp-native-e2e").unwrap();
        let dir = "acp-native-e2e";
        crate::acp_transcript::append_line_in(
            &root,
            dir,
            "sess1",
            &serde_json::to_string(&TranscriptHeader::new(
                "custom:acp-native-e2e",
                "sess1",
                "/repo/project",
                1_750_000_000_000,
            ))
            .unwrap(),
        );
        for e in [
            prompt(1_750_000_000_100, "build the thing"),
            update(1_750_000_000_200, text_chunk("agent_message_chunk", "done")),
            update(
                1_750_000_000_300,
                serde_json::json!({"sessionUpdate":"usage_update","used":3_000,"size":200_000}),
            ),
        ] {
            crate::acp_transcript::append_line_in(
                &root,
                dir,
                "sess1",
                &serde_json::to_string(&e).unwrap(),
            );
        }

        let parser = AcpNativeParser::new_in(agent, root.clone());
        let detail = parser.get_conversation("sess1").expect("found");
        assert_eq!(detail.summary.id, "sess1");
        assert_eq!(detail.summary.agent_type, agent);
        assert_eq!(detail.summary.folder_path.as_deref(), Some("/repo/project"));
        assert_eq!(detail.summary.folder_name.as_deref(), Some("project"));
        assert_eq!(detail.summary.title.as_deref(), Some("build the thing"));
        assert_eq!(detail.summary.message_count, 1);
        assert_eq!(detail.turns.len(), 2);
        // The recorded `usage_update` reaches the session footer's
        // context-window gauge, which was unreachable for custom agents before.
        let stats = detail.session_stats.as_ref().expect("stats");
        assert_eq!(stats.context_window_used_tokens, Some(3_000));
        assert_eq!(stats.context_window_max_tokens, Some(200_000));
        assert_eq!(stats.context_window_usage_percent, Some(1.5));

        let listed = parser.list_conversations().expect("listed");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "sess1");

        assert!(matches!(
            parser.get_conversation("missing"),
            Err(ParseError::ConversationNotFound(_))
        ));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_session_opened_but_never_used_is_not_listed() {
        // Opening a conversation writes the ACP header before the user has
        // typed anything. Closing it there must not leave an untitled,
        // zero-turn row in the list.
        let root = temp_root();
        let agent = AgentType::custom("acp-native-empty").unwrap();
        let dir = "acp-native-empty";
        crate::acp_transcript::append_line_in(
            &root,
            dir,
            "never-used",
            &serde_json::to_string(&TranscriptHeader::new(
                "custom:acp-native-empty",
                "never-used",
                "/repo",
                1_750_000_000_000,
            ))
            .unwrap(),
        );
        let parser = AcpNativeParser::new_in(agent, root.clone());
        assert!(parser.list_conversations().expect("listed").is_empty());

        // One prompt is enough to make it a real conversation.
        crate::acp_transcript::append_line_in(
            &root,
            dir,
            "never-used",
            &serde_json::to_string(&prompt(1_750_000_000_100, "hello")).unwrap(),
        );
        assert_eq!(parser.list_conversations().expect("listed").len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_session_restarted_after_the_agent_forgot_it_reads_as_one_conversation() {
        // The agent kept its sessions in memory, so reopening the conversation
        // failed `session/load` and codeg opened `sess-new` for the same
        // conversation, linked back to `sess-old`. Both halves must render as
        // one history, listed once.
        let root = temp_root();
        let agent = AgentType::custom("acp-native-chain").unwrap();
        let dir = "acp-native-chain";
        let write = |session: &str, lines: Vec<String>| {
            for line in lines {
                crate::acp_transcript::append_line_in(&root, dir, session, &line);
            }
        };

        write(
            "sess-old",
            vec![
                serde_json::to_string(&TranscriptHeader::new(
                    "custom:acp-native-chain",
                    "sess-old",
                    "/repo/project",
                    1_750_000_000_000,
                ))
                .unwrap(),
                serde_json::to_string(&prompt(1_750_000_000_100, "first question")).unwrap(),
                serde_json::to_string(&update(
                    1_750_000_000_200,
                    text_chunk("agent_message_chunk", "first answer"),
                ))
                .unwrap(),
            ],
        );
        write(
            "sess-new",
            vec![
                serde_json::to_string(
                    &TranscriptHeader::new(
                        "custom:acp-native-chain",
                        "sess-new",
                        // A different cwd on purpose: the conversation's folder
                        // must come from where it actually started.
                        "/somewhere/else",
                        1_750_000_900_000,
                    )
                    .continuing("sess-old"),
                )
                .unwrap(),
                serde_json::to_string(&prompt(1_750_000_900_100, "follow up")).unwrap(),
                serde_json::to_string(&update(
                    1_750_000_900_200,
                    text_chunk("agent_message_chunk", "second answer"),
                ))
                .unwrap(),
            ],
        );

        let parser = AcpNativeParser::new_in(agent, root.clone());
        let detail = parser.get_conversation("sess-new").expect("found");
        assert_eq!(detail.turns.len(), 4, "both halves of the history render");
        assert_eq!(detail.summary.message_count, 2);
        assert_eq!(
            detail.summary.title.as_deref(),
            Some("first question"),
            "the title still comes from the conversation's first prompt"
        );
        assert_eq!(detail.summary.folder_path.as_deref(), Some("/repo/project"));

        // Listed once, under the head of the chain.
        let listed = parser.list_conversations().expect("listed");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "sess-new");
        assert_eq!(listed[0].message_count, 2);

        // The old id keeps resolving to its own prefix — a detail fetch that
        // races the `external_id` update still shows history, never an error.
        let old = parser.get_conversation("sess-old").expect("still readable");
        assert_eq!(old.turns.len(), 2);
        let _ = std::fs::remove_dir_all(&root);
    }
}
