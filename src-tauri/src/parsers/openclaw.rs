use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use chrono::{DateTime, TimeZone, Utc};
use regex::Regex;
use serde::Deserialize;

use crate::models::*;
use crate::parsers::{
    compute_session_stats, folder_name_from_path, infer_context_window_max_tokens,
    latest_turn_total_usage_tokens, merge_context_window_stats, title_from_user_text, truncate_str,
    AgentParser, ParseError,
};

/// Regex to strip the "Sender (untrusted metadata):" block and optional
/// timestamp prefix from OpenClaw user messages.
fn sender_block_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?s)^Sender \(untrusted metadata\):\s*```[^`]*```\s*").unwrap())
}

fn timestamp_prefix_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\[.*?\]\s*").unwrap())
}

fn working_dir_prefix_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\[Working directory:[^\]]*\]\s*").unwrap())
}

/// Regex to extract the working directory path from a user message prefix.
fn working_dir_extract_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\[Working directory:\s*([^\]]+)\]").unwrap())
}

/// Extract the working directory from OpenClaw user message text.
/// Returns the expanded path (~ replaced with home dir).
fn extract_working_dir(text: &str) -> Option<String> {
    let captures = working_dir_extract_regex().captures(text)?;
    let raw_path = captures.get(1)?.as_str().trim();
    if raw_path.is_empty() {
        return None;
    }
    // Expand ~ to home directory
    if let Some(stripped) = raw_path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return Some(home.join(stripped).to_string_lossy().to_string());
        }
    }
    Some(raw_path.to_string())
}

/// Strip OpenClaw user message prefix metadata.
fn strip_openclaw_user_prefix(text: &str) -> String {
    let cleaned = sender_block_regex().replace(text, "");
    let cleaned = timestamp_prefix_regex().replace(&cleaned, "");
    let cleaned = working_dir_prefix_regex().replace(&cleaned, "");
    cleaned.trim().to_string()
}

// ── sessions.json deserialization ──────────────────────────────────────

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SessionMeta {
    session_id: String,
    updated_at: Option<u64>,
    model: Option<String>,
    context_tokens: Option<u64>,
    #[allow(dead_code)]
    input_tokens: Option<u64>,
    #[allow(dead_code)]
    output_tokens: Option<u64>,
    #[allow(dead_code)]
    cache_read: Option<u64>,
    #[allow(dead_code)]
    cache_write: Option<u64>,
    #[allow(dead_code)]
    total_tokens: Option<u64>,
    origin: Option<SessionOrigin>,
}

#[derive(Deserialize, Clone)]
struct SessionOrigin {
    label: Option<String>,
}

// ── JSONL tree ────────────────────────────────────────────────────────

/// A parsed JSONL record, indexed by its id.
#[derive(Clone)]
struct JRecord {
    id: String,
    parent_id: Option<String>,
    record_type: String,
    value: serde_json::Value,
}

/// Parsed tree of JSONL records.
struct JTree {
    records: HashMap<String, JRecord>,
    /// id → list of child ids (in insertion order)
    children: HashMap<String, Vec<String>>,
    /// Records with parentId = null (roots)
    #[allow(dead_code)]
    roots: Vec<String>,
    /// Session cwd from the "session" header
    session_cwd: Option<String>,
    /// True if no parent has more than one child (no forks → single linear chain)
    is_linear: bool,
    /// Record ids in file insertion order (used for fast path when is_linear)
    insertion_order: Vec<String>,
}

impl JTree {
    fn parse(path: &Path) -> Result<Self, ParseError> {
        let file = fs::File::open(path)?;
        let reader = BufReader::new(file);

        let mut records = HashMap::new();
        let mut children: HashMap<String, Vec<String>> = HashMap::new();
        let mut roots = Vec::new();
        let mut session_cwd = None;
        // Maintain insertion order for roots
        let mut insert_order: Vec<String> = Vec::new();

        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => continue,
            };
            if line.trim().is_empty() {
                continue;
            }
            let value: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let record_type = value
                .get("type")
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string();
            let id = value
                .get("id")
                .and_then(|i| i.as_str())
                .unwrap_or("")
                .to_string();
            let parent_id = value
                .get("parentId")
                .and_then(|p| p.as_str())
                .map(|s| s.to_string());

            if record_type == "session" {
                if session_cwd.is_none() {
                    session_cwd = value
                        .get("cwd")
                        .and_then(|s| s.as_str())
                        .map(|s| s.to_string());
                }
                continue; // session records don't participate in the tree
            }

            if id.is_empty() {
                continue;
            }

            let rec = JRecord {
                id: id.clone(),
                parent_id: parent_id.clone(),
                record_type,
                value,
            };

            match &parent_id {
                Some(pid) => {
                    children.entry(pid.clone()).or_default().push(id.clone());
                }
                None => {
                    roots.push(id.clone());
                }
            }

            insert_order.push(id.clone());
            records.insert(id, rec);
        }

        let is_linear = children.values().all(|kids| kids.len() <= 1);

        Ok(JTree {
            records,
            children,
            roots,
            session_cwd,
            is_linear,
            insertion_order: insert_order,
        })
    }

    /// Walk up the parentId chain from `leaf_id` to root, returning the path
    /// from root → leaf (reversed).
    fn ancestor_chain(&self, leaf_id: &str) -> Vec<String> {
        let mut chain = Vec::new();
        let mut current = Some(leaf_id.to_string());
        while let Some(id) = current {
            if let Some(rec) = self.records.get(&id) {
                chain.push(id);
                current = rec.parent_id.clone();
            } else {
                break;
            }
        }
        chain.reverse();
        chain
    }

    /// Find all leaf nodes (nodes that have no children).
    fn leaf_ids(&self) -> Vec<String> {
        self.records
            .keys()
            .filter(|id| !self.children.contains_key(*id) || self.children[*id].is_empty())
            .cloned()
            .collect()
    }

    /// Find the first user message in a branch (root → leaf path).
    /// This is the "fork point" user message that starts this conversation.
    fn find_branch_first_user_message(&self, branch: &[String]) -> Option<usize> {
        // Walk the branch and find where this branch diverges from others.
        // The first user message at or after the fork point is the conversation start.
        for (i, id) in branch.iter().enumerate() {
            if let Some(rec) = self.records.get(id) {
                if rec.record_type != "message" {
                    continue;
                }
                let role = rec
                    .value
                    .get("message")
                    .and_then(|m| m.get("role"))
                    .and_then(|r| r.as_str())
                    .unwrap_or("");
                if role != "user" {
                    continue;
                }
                // Check if parent has multiple children (fork point)
                if let Some(pid) = &rec.parent_id {
                    if let Some(siblings) = self.children.get(pid) {
                        if siblings.len() > 1 {
                            return Some(i);
                        }
                    }
                }
            }
        }
        // No fork point found → the first user message is the conversation start
        for (i, id) in branch.iter().enumerate() {
            if let Some(rec) = self.records.get(id) {
                if rec.record_type == "message" {
                    let role = rec
                        .value
                        .get("message")
                        .and_then(|m| m.get("role"))
                        .and_then(|r| r.as_str())
                        .unwrap_or("");
                    if role == "user" {
                        return Some(i);
                    }
                }
            }
        }
        None
    }

    /// Extract distinct conversation branches.
    /// Each branch is identified by its leaf node.
    /// Returns: Vec<(leaf_id, branch_record_ids from fork_user_msg → leaf)>
    fn conversation_branches(&self) -> Vec<(String, Vec<String>)> {
        // Fast path: linear chain (no forks) → single branch using insertion order
        if self.is_linear {
            if let Some(leaf_id) = self.insertion_order.last() {
                // Find the first user message in insertion order
                let first_user_idx = self.insertion_order.iter().position(|id| {
                    self.records.get(id).is_some_and(|r| {
                        r.record_type == "message"
                            && r.value
                                .get("message")
                                .and_then(|m| m.get("role"))
                                .and_then(|r| r.as_str())
                                == Some("user")
                    })
                });
                if let Some(idx) = first_user_idx {
                    let branch_ids = self.insertion_order[idx..].to_vec();
                    return vec![(leaf_id.clone(), branch_ids)];
                }
            }
            return vec![];
        }

        let leaves = self.leaf_ids();
        let mut branches = Vec::new();

        for leaf_id in &leaves {
            let chain = self.ancestor_chain(leaf_id);
            if chain.is_empty() {
                continue;
            }

            // Find the fork-point user message for this branch
            if let Some(fork_idx) = self.find_branch_first_user_message(&chain) {
                let branch_ids: Vec<String> = chain[fork_idx..].to_vec();
                // Only include branches that have at least one user message
                let has_user = branch_ids.iter().any(|id| {
                    self.records.get(id).is_some_and(|r| {
                        r.record_type == "message"
                            && r.value
                                .get("message")
                                .and_then(|m| m.get("role"))
                                .and_then(|r| r.as_str())
                                == Some("user")
                    })
                });
                if has_user {
                    branches.push((leaf_id.clone(), branch_ids));
                }
            }
        }

        branches
    }
}

// ── Parser ─────────────────────────────────────────────────────────────

pub struct OpenClawParser {
    base_dir: PathBuf,
}

impl Default for OpenClawParser {
    fn default() -> Self {
        Self::new()
    }
}

impl OpenClawParser {
    pub fn new() -> Self {
        let base_dir = dirs::home_dir()
            .unwrap_or_default()
            .join(".openclaw")
            .join("agents");
        Self { base_dir }
    }

    /// Test-only constructor that lets callers point the parser at a fixture
    /// directory instead of `~/.openclaw/agents`.
    #[cfg(any(test, feature = "test-utils"))]
    pub fn with_base_dir(base_dir: PathBuf) -> Self {
        Self { base_dir }
    }

    /// Read sessions.json for a given agent directory.
    fn read_session_index(agent_dir: &Path) -> Result<HashMap<String, SessionMeta>, ParseError> {
        let index_path = agent_dir.join("sessions").join("sessions.json");
        if !index_path.exists() {
            return Ok(HashMap::new());
        }
        let content = fs::read_to_string(&index_path)?;
        let index: HashMap<String, SessionMeta> = serde_json::from_str(&content)?;
        Ok(index)
    }

    /// List all JSONL files for an agent, including `.jsonl.reset.*` archives.
    fn list_jsonl_files(agent_dir: &Path) -> Vec<(String, PathBuf)> {
        let sessions_dir = agent_dir.join("sessions");
        if !sessions_dir.exists() {
            return Vec::new();
        }
        let mut files = Vec::new();
        if let Ok(entries) = fs::read_dir(&sessions_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                let name = path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                // Match both <uuid>.jsonl and <uuid>.jsonl.reset.<timestamp>
                if let Some(session_id) = extract_session_id_from_filename(&name) {
                    files.push((session_id, path));
                }
            }
        }
        files
    }

    /// Build summaries for all conversation branches in a single JSONL file.
    fn summaries_from_tree(
        agent_id: &str,
        session_id: &str,
        tree: &JTree,
        session_meta: Option<&SessionMeta>,
    ) -> Vec<ConversationSummary> {
        let branches = tree.conversation_branches();
        let mut summaries = Vec::new();

        for (leaf_id, branch_ids) in &branches {
            let mut cwd = tree.session_cwd.clone();
            let mut title: Option<String> = None;
            let mut first_timestamp: Option<DateTime<Utc>> = None;
            let mut last_timestamp: Option<DateTime<Utc>> = None;
            let mut message_count: u32 = 0;

            for id in branch_ids {
                let rec = match tree.records.get(id) {
                    Some(r) => r,
                    None => continue,
                };

                if let Some(ts) = parse_iso_timestamp(&rec.value) {
                    if first_timestamp.is_none() {
                        first_timestamp = Some(ts);
                    }
                    last_timestamp = Some(ts);
                }

                if rec.record_type != "message" {
                    continue;
                }

                let role = rec
                    .value
                    .get("message")
                    .and_then(|m| m.get("role"))
                    .and_then(|r| r.as_str())
                    .unwrap_or("");

                match role {
                    "user" => {
                        message_count += 1;
                        if let Some(text) = extract_first_text_content(&rec.value) {
                            if let Some(wd) = extract_working_dir(&text) {
                                cwd = Some(wd);
                            }
                            if title.is_none() {
                                let cleaned = strip_openclaw_user_prefix(&text);
                                if !cleaned.is_empty() {
                                    title = Some(title_from_user_text(&cleaned));
                                }
                            }
                        }
                    }
                    "assistant" => {
                        message_count += 1;
                    }
                    _ => {}
                }
            }

            let started_at = match first_timestamp {
                Some(ts) => ts,
                None => continue,
            };

            // Use updatedAt from sessions.json if this is the latest branch
            let ended_at = session_meta
                .and_then(|m| m.updated_at)
                .and_then(|ms| Utc.timestamp_millis_opt(ms as i64).single())
                .or(last_timestamp);

            if title.is_none() {
                title = session_meta
                    .and_then(|m| m.origin.as_ref())
                    .and_then(|o| o.label.clone());
            }

            // conversation_id: agentId/sessionId/leafId
            let conversation_id = format!("{}/{}/{}", agent_id, session_id, leaf_id);
            let folder_path = cwd.clone();
            let folder_name = folder_path.as_ref().map(|p| folder_name_from_path(p));

            summaries.push(ConversationSummary {
                id: conversation_id,
                agent_type: AgentType::OpenClaw,
                folder_path,
                folder_name,
                title,
                started_at,
                ended_at,
                message_count,
                model: session_meta.and_then(|m| m.model.clone()),
                git_branch: None,
                parent_id: None,
                parent_tool_use_id: None,
                delegation_call_id: None,
            });
        }

        summaries
    }

    /// Parse a JSONL file (tree-aware) to extract full conversation detail
    /// for a specific branch identified by leaf_id.
    fn parse_conversation_detail(
        jsonl_path: &Path,
        conversation_id: &str,
        leaf_id: Option<&str>,
        session_meta: Option<&SessionMeta>,
    ) -> Result<ConversationDetail, ParseError> {
        let tree = JTree::parse(jsonl_path)?;

        // Determine which branch to display
        let branch_ids = if let Some(lid) = leaf_id {
            // Specific branch: ancestor chain from leaf, starting from fork user msg
            let chain = tree.ancestor_chain(lid);
            if chain.is_empty() {
                return Err(ParseError::ConversationNotFound(
                    conversation_id.to_string(),
                ));
            }
            match tree.find_branch_first_user_message(&chain) {
                Some(idx) => chain[idx..].to_vec(),
                None => chain,
            }
        } else {
            // No leaf_id: use the full chain of the most recently updated leaf
            // (backward compat for old conversation IDs without leaf component)
            let branches = tree.conversation_branches();
            if branches.is_empty() {
                // Fallback: use all message records in order
                tree.records
                    .values()
                    .filter(|r| r.record_type == "message")
                    .map(|r| r.id.clone())
                    .collect()
            } else {
                // Find branch with latest timestamp
                let mut best: Option<(DateTime<Utc>, Vec<String>)> = None;
                for (_, branch) in &branches {
                    let ts = branch
                        .iter()
                        .filter_map(|id| tree.records.get(id))
                        .filter_map(|r| parse_iso_timestamp(&r.value))
                        .next_back();
                    if let Some(ts) = ts {
                        if best.as_ref().is_none_or(|(t, _)| ts > *t) {
                            best = Some((ts, branch.clone()));
                        }
                    }
                }
                best.map(|(_, b)| b).unwrap_or_default()
            }
        };

        let mut messages: Vec<UnifiedMessage> = Vec::new();
        let mut cwd = tree.session_cwd.clone();
        let mut model: Option<String> = None;
        let mut title: Option<String> = None;
        let mut first_timestamp: Option<DateTime<Utc>> = None;
        let mut last_timestamp: Option<DateTime<Utc>> = None;

        for id in &branch_ids {
            let rec = match tree.records.get(id) {
                Some(r) => r,
                None => continue,
            };

            if rec.record_type != "message" {
                continue;
            }

            if let Some(ts) = parse_iso_timestamp(&rec.value) {
                if first_timestamp.is_none() {
                    first_timestamp = Some(ts);
                }
                last_timestamp = Some(ts);
            }

            let role = rec
                .value
                .get("message")
                .and_then(|m| m.get("role"))
                .and_then(|r| r.as_str())
                .unwrap_or("");
            let timestamp = parse_iso_timestamp(&rec.value).unwrap_or_else(Utc::now);
            let msg_id = rec.id.clone();

            match role {
                "user" => {
                    if let Some(raw_text) = extract_first_text_content(&rec.value) {
                        if let Some(wd) = extract_working_dir(&raw_text) {
                            cwd = Some(wd);
                        }
                    }
                    let content = extract_user_content(&rec.value);
                    if content.is_empty() {
                        continue;
                    }
                    if title.is_none() {
                        if let Some(ContentBlock::Text { ref text }) = content.first() {
                            title = Some(title_from_user_text(text));
                        }
                    }
                    messages.push(UnifiedMessage {
                        id: msg_id,
                        role: MessageRole::User,
                        content,
                        timestamp,
                        usage: None,
                        duration_ms: None,
                        model: None,
                        completed_at: Some(timestamp),
                    agent_message_id: None,
                    });
                }
                "assistant" => {
                    let content = extract_assistant_content(&rec.value);
                    let usage = extract_usage(&rec.value);
                    let msg_model = rec
                        .value
                        .get("message")
                        .and_then(|m| m.get("model"))
                        .and_then(|m| m.as_str())
                        .map(|s| s.to_string());
                    if model.is_none() {
                        model = msg_model.clone();
                    }
                    messages.push(UnifiedMessage {
                        id: msg_id,
                        role: MessageRole::Assistant,
                        content,
                        timestamp,
                        usage,
                        duration_ms: None,
                        model: msg_model,
                        completed_at: Some(timestamp),
                    agent_message_id: None,
                    });
                }
                "toolResult" => {
                    let content = extract_tool_result_content(&rec.value);
                    messages.push(UnifiedMessage {
                        id: msg_id,
                        role: MessageRole::Tool,
                        content,
                        timestamp,
                        usage: None,
                        duration_ms: None,
                        model: None,
                        completed_at: Some(timestamp),
                    agent_message_id: None,
                    });
                }
                _ => {}
            }
        }

        if let Some(meta) = session_meta {
            if model.is_none() {
                model = meta.model.clone();
            }
        }

        let folder_path = cwd.clone();
        let folder_name = folder_path.as_ref().map(|p| folder_name_from_path(p));
        let mut turns = group_into_turns(messages);
        super::relocate_orphaned_tool_results(&mut turns);
        super::structurize_read_tool_output(&mut turns);
        super::resolve_patch_line_numbers(&mut turns, cwd.as_deref());
        super::backfill_turn_durations(&mut turns, &[]);

        let context_window_used_tokens = latest_turn_total_usage_tokens(&turns);
        let context_window_max_tokens = session_meta
            .and_then(|m| m.context_tokens)
            .or_else(|| infer_context_window_max_tokens(model.as_deref()));
        let session_stats = merge_context_window_stats(
            compute_session_stats(&turns),
            context_window_used_tokens,
            context_window_max_tokens,
        );

        let summary = ConversationSummary {
            id: conversation_id.to_string(),
            agent_type: AgentType::OpenClaw,
            folder_path,
            folder_name,
            title,
            started_at: first_timestamp.unwrap_or_else(Utc::now),
            ended_at: last_timestamp,
            message_count: turns.len() as u32,
            model,
            git_branch: None,
            parent_id: None,
            parent_tool_use_id: None,
            delegation_call_id: None,
        };

        Ok(ConversationDetail {
            summary,
            turns,
            session_stats,
            transcript_watermark: None,
        })
    }

    /// Resolve a conversation_id to (jsonl_path, leaf_id, session_meta).
    ///
    /// Conversation ID formats:
    /// - `agentId/sessionId/leafId` — tree-aware branch
    /// - `agentId/sessionId` — legacy, uses latest branch
    /// - bare UUID — ACP session ID fallback
    fn resolve_session(
        &self,
        conversation_id: &str,
    ) -> Result<(PathBuf, Option<String>, Option<SessionMeta>), ParseError> {
        let parts: Vec<&str> = conversation_id.splitn(3, '/').collect();

        if parts.len() >= 2 {
            let agent_id = parts[0];
            let session_id = parts[1];
            let leaf_id = parts.get(2).map(|s| s.to_string());
            let agent_dir = self.base_dir.join(agent_id);

            // Try exact JSONL file
            let jsonl_path = agent_dir
                .join("sessions")
                .join(format!("{}.jsonl", session_id));
            if jsonl_path.exists() {
                let meta = Self::read_session_index(&agent_dir)
                    .ok()
                    .and_then(|index| index.into_values().find(|m| m.session_id == session_id));
                return Ok((jsonl_path, leaf_id, meta));
            }

            // Try reset files
            if let Some((path, meta)) = Self::find_reset_file(&agent_dir, session_id) {
                return Ok((path, leaf_id, meta));
            }
        }

        // Fallback: scan all agent directories
        if self.base_dir.exists() {
            let bare_id = match parts.len() {
                1 => parts[0],
                2 => parts[1],
                _ => parts[1],
            };

            for entry in fs::read_dir(&self.base_dir)?.flatten() {
                let agent_dir = entry.path();
                if !agent_dir.is_dir() {
                    continue;
                }

                // Try direct session ID match
                let jsonl_path = agent_dir
                    .join("sessions")
                    .join(format!("{}.jsonl", bare_id));
                if jsonl_path.exists() {
                    let meta = Self::read_session_index(&agent_dir)
                        .ok()
                        .and_then(|index| index.into_values().find(|m| m.session_id == bare_id));
                    return Ok((jsonl_path, None, meta));
                }

                // Try reset files
                if let Some((path, meta)) = Self::find_reset_file(&agent_dir, bare_id) {
                    return Ok((path, None, meta));
                }

                // Fallback: ACP session ID doesn't match any file.
                // Scan all JSONL files and search for a branch whose leaf_id
                // or first user message timestamp matches.  As a last resort,
                // try the most recently updated session.
                let jsonl_files = Self::list_jsonl_files(&agent_dir);
                for (sid, path) in &jsonl_files {
                    if let Ok(tree) = JTree::parse(path) {
                        // Check if any leaf id matches the bare_id
                        let leaves = tree.leaf_ids();
                        if leaves.iter().any(|l| l == bare_id) {
                            let meta =
                                Self::read_session_index(&agent_dir).ok().and_then(|index| {
                                    index.into_values().find(|m| m.session_id == *sid)
                                });
                            return Ok((path.clone(), Some(bare_id.to_string()), meta));
                        }
                    }
                }

                // No fallback: if the ID doesn't match any file or leaf,
                // return ConversationNotFound to avoid showing wrong messages.
            }
        }

        Err(ParseError::ConversationNotFound(
            conversation_id.to_string(),
        ))
    }

    /// Find a `.jsonl.reset.*` file matching the given session_id.
    fn find_reset_file(
        agent_dir: &Path,
        session_id: &str,
    ) -> Option<(PathBuf, Option<SessionMeta>)> {
        let sessions_dir = agent_dir.join("sessions");
        if !sessions_dir.exists() {
            return None;
        }
        let prefix = format!("{}.jsonl.reset.", session_id);
        let mut candidates: Vec<(PathBuf, String)> = Vec::new();
        if let Ok(entries) = fs::read_dir(&sessions_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with(&prefix) {
                    // Extract timestamp suffix for sorting
                    let suffix = name[prefix.len()..].to_string();
                    candidates.push((entry.path(), suffix));
                }
            }
        }
        if candidates.is_empty() {
            return None;
        }
        // Sort by timestamp suffix descending to get the latest reset file
        candidates.sort_by(|a, b| b.1.cmp(&a.1));
        Some((candidates.into_iter().next().unwrap().0, None))
    }
}

impl AgentParser for OpenClawParser {
    fn list_conversations(&self) -> Result<Vec<ConversationSummary>, ParseError> {
        let mut conversations = Vec::new();

        if !self.base_dir.exists() {
            return Ok(conversations);
        }

        for entry in fs::read_dir(&self.base_dir)?.flatten() {
            let agent_dir = entry.path();
            if !agent_dir.is_dir() {
                continue;
            }

            let agent_id = agent_dir
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();

            let index = Self::read_session_index(&agent_dir).unwrap_or_default();

            // Scan all JSONL files (including reset archives)
            let jsonl_files = Self::list_jsonl_files(&agent_dir);
            for (session_id, path) in &jsonl_files {
                let tree = match JTree::parse(path) {
                    Ok(t) => t,
                    Err(_) => continue,
                };

                let meta = index
                    .values()
                    .find(|m| m.session_id == *session_id)
                    .cloned();

                let summaries =
                    Self::summaries_from_tree(&agent_id, session_id, &tree, meta.as_ref());
                conversations.extend(summaries);
            }
        }

        conversations.sort_by_key(|b| std::cmp::Reverse(b.started_at));
        Ok(conversations)
    }

    fn get_conversation(&self, conversation_id: &str) -> Result<ConversationDetail, ParseError> {
        let (jsonl_path, leaf_id, meta) = self.resolve_session(conversation_id)?;
        Self::parse_conversation_detail(
            &jsonl_path,
            conversation_id,
            leaf_id.as_deref(),
            meta.as_ref(),
        )
    }
}

// ── Helper functions ───────────────────────────────────────────────────

/// Extract session UUID from filenames like `<uuid>.jsonl` or `<uuid>.jsonl.reset.<ts>`.
fn extract_session_id_from_filename(name: &str) -> Option<String> {
    // Skip non-jsonl files
    if !name.contains(".jsonl") {
        return None;
    }
    // Skip sessions.json
    if name == "sessions.json" {
        return None;
    }
    // Extract the UUID part before .jsonl
    let uuid_part = name.split(".jsonl").next()?;
    if uuid_part.is_empty() {
        return None;
    }
    Some(uuid_part.to_string())
}

fn parse_iso_timestamp(value: &serde_json::Value) -> Option<DateTime<Utc>> {
    value
        .get("timestamp")
        .and_then(|t| t.as_str())
        .and_then(|s| s.parse::<DateTime<Utc>>().ok())
}

fn extract_first_text_content(value: &serde_json::Value) -> Option<String> {
    let content = value.get("message")?.get("content")?.as_array()?;
    for item in content {
        if item.get("type").and_then(|t| t.as_str()) == Some("text") {
            return item
                .get("text")
                .and_then(|t| t.as_str())
                .map(|s| s.to_string());
        }
    }
    None
}

fn extract_user_content(value: &serde_json::Value) -> Vec<ContentBlock> {
    let mut blocks = Vec::new();
    let message = match value.get("message") {
        Some(m) => m,
        None => return blocks,
    };
    let content = match message.get("content") {
        Some(c) => c,
        None => return blocks,
    };

    if let Some(arr) = content.as_array() {
        for item in arr {
            let block_type = item.get("type").and_then(|t| t.as_str()).unwrap_or("");
            if block_type == "text" {
                if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                    let cleaned = strip_openclaw_user_prefix(text);
                    if !cleaned.is_empty() {
                        blocks.push(ContentBlock::Text { text: cleaned });
                    }
                }
            }
        }
    }

    blocks
}

fn extract_assistant_content(value: &serde_json::Value) -> Vec<ContentBlock> {
    let mut blocks = Vec::new();
    let message = match value.get("message") {
        Some(m) => m,
        None => return blocks,
    };
    let content = match message.get("content") {
        Some(c) => c,
        None => return blocks,
    };

    if let Some(arr) = content.as_array() {
        for item in arr {
            let block_type = item.get("type").and_then(|t| t.as_str()).unwrap_or("");
            match block_type {
                "text" => {
                    if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                        // Strip [[reply_to_current]] prefix if present
                        let cleaned = text
                            .strip_prefix("[[reply_to_current]] ")
                            .unwrap_or(text)
                            .to_string();
                        if !cleaned.is_empty() {
                            blocks.push(ContentBlock::Text { text: cleaned });
                        }
                    }
                }
                "thinking" => {
                    if let Some(text) = item.get("thinking").and_then(|t| t.as_str()) {
                        if !text.is_empty() {
                            blocks.push(ContentBlock::Thinking {
                                text: text.to_string(),
                            });
                        }
                    }
                }
                "toolCall" => {
                    let tool_use_id = item
                        .get("id")
                        .and_then(|n| n.as_str())
                        .map(|s| s.to_string());
                    let tool_name = item
                        .get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or("unknown")
                        .to_string();
                    let is_edit_tool = matches!(
                        tool_name.to_lowercase().as_str(),
                        "edit"
                            | "write"
                            | "apply_patch"
                            | "patch"
                            | "applypatch"
                            | "edit_file"
                            | "editfile"
                    );
                    let max_len = if is_edit_tool { 50000 } else { 500 };
                    let input_preview = item.get("arguments").map(|a| {
                        let s = a.to_string();
                        truncate_str(&s, max_len)
                    });
                    blocks.push(ContentBlock::ToolUse {
                        tool_use_id,
                        tool_name,
                        input_preview,
                        status: None,
                        meta: None,
                    });
                }
                _ => {}
            }
        }
    }

    blocks
}

fn extract_tool_result_content(value: &serde_json::Value) -> Vec<ContentBlock> {
    let mut blocks = Vec::new();
    let message = match value.get("message") {
        Some(m) => m,
        None => return blocks,
    };

    let tool_use_id = message
        .get("toolCallId")
        .and_then(|n| n.as_str())
        .map(|s| s.to_string());

    let is_error = message
        .get("isError")
        .and_then(|e| e.as_bool())
        .unwrap_or(false);

    let output = message
        .get("content")
        .and_then(|c| c.as_array())
        .and_then(|arr| {
            let texts: Vec<String> = arr
                .iter()
                .filter_map(|item| {
                    if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                        item.get("text")
                            .and_then(|t| t.as_str())
                            .map(|s| s.to_string())
                    } else {
                        None
                    }
                })
                .collect();
            if texts.is_empty() {
                None
            } else {
                Some(texts.join("\n"))
            }
        });

    blocks.push(ContentBlock::ToolResult {
        tool_use_id,
        output_preview: output,
        is_error,
        agent_stats: None,
        images: Vec::new(),
        exit_code: None,
    });

    blocks
}

fn extract_usage(value: &serde_json::Value) -> Option<TurnUsage> {
    let usage = value.get("message")?.get("usage")?;
    Some(TurnUsage {
        input_tokens: usage.get("input").and_then(|v| v.as_u64()).unwrap_or(0),
        output_tokens: usage.get("output").and_then(|v| v.as_u64()).unwrap_or(0),
        cache_creation_input_tokens: usage
            .get("cacheWrite")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        cache_read_input_tokens: usage.get("cacheRead").and_then(|v| v.as_u64()).unwrap_or(0),
    })
}

/// Group flat messages into conversation turns.
/// Assistant + Tool messages merge into one Assistant turn.
fn group_into_turns(messages: Vec<UnifiedMessage>) -> Vec<MessageTurn> {
    let mut turns = Vec::new();
    let mut i = 0;

    while i < messages.len() {
        let msg = &messages[i];

        if matches!(msg.role, MessageRole::User) {
            turns.push(MessageTurn {
                id: format!("turn-{}", turns.len()),
                role: TurnRole::User,
                blocks: msg.content.clone(),
                timestamp: msg.timestamp,
                usage: None,
                duration_ms: None,
                model: None,
                completed_at: msg.completed_at,
            agent_message_id: None,
            });
            i += 1;
        } else if matches!(msg.role, MessageRole::System) {
            turns.push(MessageTurn {
                id: format!("turn-{}", turns.len()),
                role: TurnRole::System,
                blocks: msg.content.clone(),
                timestamp: msg.timestamp,
                usage: None,
                duration_ms: None,
                model: None,
                completed_at: msg.completed_at,
            agent_message_id: None,
            });
            i += 1;
        } else {
            // Assistant or Tool — start a group
            let mut blocks: Vec<ContentBlock> = msg.content.clone();
            let mut usage = msg.usage.clone();
            let duration_ms = msg.duration_ms;
            let turn_model = msg.model.clone();
            let timestamp = msg.timestamp;
            let mut completed_at = msg.completed_at;
            i += 1;

            // Only absorb immediately following Tool messages
            // (stop at the next assistant message to keep turns small for virtualization)
            while i < messages.len() && matches!(messages[i].role, MessageRole::Tool) {
                blocks.extend(messages[i].content.clone());
                if usage.is_none() {
                    usage = messages[i].usage.clone();
                }
                if messages[i].completed_at.is_some() {
                    completed_at = messages[i].completed_at;
                }
                i += 1;
            }

            turns.push(MessageTurn {
                id: format!("turn-{}", turns.len()),
                role: TurnRole::Assistant,
                blocks,
                timestamp,
                usage,
                duration_ms,
                model: turn_model,
                completed_at,
            agent_message_id: None,
            });
        }
    }

    turns
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;

    #[test]
    fn strips_sender_block_and_timestamp() {
        let input = "Sender (untrusted metadata):\n```json\n{\"label\": \"test\"}\n```\n\n[Tue 2026-03-17 12:56 GMT+8] Hello world";
        assert_eq!(strip_openclaw_user_prefix(input), "Hello world");
    }

    #[test]
    fn strips_timestamp_only() {
        let input = "[Tue 2026-03-17 12:56 GMT+8] Hello";
        assert_eq!(strip_openclaw_user_prefix(input), "Hello");
    }

    #[test]
    fn extracts_working_directory() {
        let text =
            "[Tue 2026-03-17 12:58 GMT+8] [Working directory: ~/forway/agent-workspace]\n\nHello";
        let wd = extract_working_dir(text).unwrap();
        let expected = dirs::home_dir()
            .unwrap()
            .join("forway/agent-workspace")
            .to_string_lossy()
            .to_string();
        assert_eq!(wd, expected);
    }

    #[test]
    fn extract_working_dir_returns_none_for_plain_text() {
        assert!(extract_working_dir("Hello world").is_none());
    }

    #[test]
    fn strips_working_dir_prefix() {
        let input = "[Tue 2026-03-17 12:58 GMT+8] [Working directory: ~/projects/test]\n\nHello";
        let result = strip_openclaw_user_prefix(input);
        assert_eq!(result, "Hello");
    }

    #[test]
    fn preserves_plain_text() {
        assert_eq!(strip_openclaw_user_prefix("Hello world"), "Hello world");
    }

    #[test]
    fn extracts_usage_from_openclaw_format() {
        let value = json!({
            "message": {
                "usage": {
                    "input": 6572,
                    "output": 246,
                    "cacheRead": 3584,
                    "cacheWrite": 100,
                    "totalTokens": 10402
                }
            }
        });
        let usage = extract_usage(&value).unwrap();
        assert_eq!(usage.input_tokens, 6572);
        assert_eq!(usage.output_tokens, 246);
        assert_eq!(usage.cache_read_input_tokens, 3584);
        assert_eq!(usage.cache_creation_input_tokens, 100);
    }

    #[test]
    fn extracts_assistant_content_with_thinking_and_tool_call() {
        let value = json!({
            "message": {
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": "I should read the file"},
                    {"type": "text", "text": "[[reply_to_current]] Let me check."},
                    {"type": "toolCall", "id": "call_123", "name": "read", "arguments": {"file_path": "/tmp/test"}}
                ]
            }
        });
        let blocks = extract_assistant_content(&value);
        assert_eq!(blocks.len(), 3);
        assert!(
            matches!(&blocks[0], ContentBlock::Thinking { text } if text == "I should read the file")
        );
        assert!(matches!(&blocks[1], ContentBlock::Text { text } if text == "Let me check."));
        assert!(
            matches!(&blocks[2], ContentBlock::ToolUse { tool_name, .. } if tool_name == "read")
        );
    }

    #[test]
    fn extracts_tool_result_content() {
        let value = json!({
            "message": {
                "role": "toolResult",
                "toolCallId": "call_123",
                "toolName": "read",
                "content": [{"type": "text", "text": "file contents here"}],
                "isError": false
            }
        });
        let blocks = extract_tool_result_content(&value);
        assert_eq!(blocks.len(), 1);
        assert!(matches!(
            &blocks[0],
            ContentBlock::ToolResult { tool_use_id, output_preview, is_error, .. }
            if tool_use_id.as_deref() == Some("call_123")
                && output_preview.as_deref() == Some("file contents here")
                && !is_error
        ));
    }

    #[test]
    fn parses_openclaw_conversation_detail_with_tree() {
        let path = std::env::temp_dir().join(format!(
            "codeg-openclaw-tree-{}.jsonl",
            uuid::Uuid::new_v4()
        ));
        let mut file = fs::File::create(&path).expect("create temp jsonl");

        writeln!(
            file,
            "{}",
            json!({"type":"session","version":3,"id":"test-session","timestamp":"2026-03-17T04:46:14.113Z","cwd":"/tmp/demo"})
        ).unwrap();

        writeln!(
            file,
            "{}",
            json!({"type":"message","id":"u1","parentId":null,"timestamp":"2026-03-17T04:56:22.819Z","message":{"role":"user","content":[{"type":"text","text":"[Tue 2026-03-17 12:56 GMT+8] Hello"}],"timestamp":1773723382812_i64}})
        ).unwrap();

        writeln!(
            file,
            "{}",
            json!({"type":"message","id":"a1","parentId":"u1","timestamp":"2026-03-17T04:56:30.466Z","message":{"role":"assistant","content":[{"type":"text","text":"[[reply_to_current]] Hi there!"}],"model":"gpt-5.4","usage":{"input":100,"output":50,"cacheRead":200,"cacheWrite":0,"totalTokens":350},"stopReason":"stop","timestamp":1773723390466_i64}})
        ).unwrap();

        let detail =
            OpenClawParser::parse_conversation_detail(&path, "test/test-session", None, None)
                .expect("parse detail");
        fs::remove_file(&path).unwrap();

        assert_eq!(detail.turns.len(), 2);
        assert!(matches!(detail.turns[0].role, TurnRole::User));
        assert!(matches!(detail.turns[1].role, TurnRole::Assistant));

        // User text should be cleaned
        assert!(matches!(
            &detail.turns[0].blocks[0],
            ContentBlock::Text { text } if text == "Hello"
        ));

        // Assistant text should strip [[reply_to_current]]
        assert!(matches!(
            &detail.turns[1].blocks[0],
            ContentBlock::Text { text } if text == "Hi there!"
        ));

        // Usage should be mapped correctly
        let usage = detail.turns[1].usage.as_ref().unwrap();
        assert_eq!(usage.input_tokens, 100);
        assert_eq!(usage.output_tokens, 50);
        assert_eq!(usage.cache_read_input_tokens, 200);

        // Session stats
        let stats = detail.session_stats.unwrap();
        assert!(stats.total_tokens.is_some());
    }

    #[test]
    fn tree_separates_branches() {
        // Simulate a JSONL with a tree:
        //   u1 → a1 → u2 → a2  (branch 1: "Hello" conversation)
        //              ↘ u3 → a3  (branch 2: "Bye" conversation, forked from a1)
        let path = std::env::temp_dir().join(format!(
            "codeg-openclaw-branches-{}.jsonl",
            uuid::Uuid::new_v4()
        ));
        let mut file = fs::File::create(&path).expect("create temp jsonl");

        writeln!(file, "{}", json!({"type":"session","version":3,"id":"s1","timestamp":"2026-03-17T01:00:00.000Z","cwd":"/tmp"})).unwrap();
        // Shared prefix
        writeln!(file, "{}", json!({"type":"message","id":"u1","parentId":null,"timestamp":"2026-03-17T01:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"Hello"}]}})).unwrap();
        writeln!(file, "{}", json!({"type":"message","id":"a1","parentId":"u1","timestamp":"2026-03-17T01:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Hi"}]}})).unwrap();
        // Branch 1 continues
        writeln!(file, "{}", json!({"type":"message","id":"u2","parentId":"a1","timestamp":"2026-03-17T01:00:03.000Z","message":{"role":"user","content":[{"type":"text","text":"How are you?"}]}})).unwrap();
        writeln!(file, "{}", json!({"type":"message","id":"a2","parentId":"u2","timestamp":"2026-03-17T01:00:04.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Good!"}]}})).unwrap();
        // Branch 2 forks from a1
        writeln!(file, "{}", json!({"type":"message","id":"u3","parentId":"a1","timestamp":"2026-03-17T01:00:05.000Z","message":{"role":"user","content":[{"type":"text","text":"Bye"}]}})).unwrap();
        writeln!(file, "{}", json!({"type":"message","id":"a3","parentId":"u3","timestamp":"2026-03-17T01:00:06.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Goodbye!"}]}})).unwrap();

        let tree = JTree::parse(&path).expect("parse tree");
        let branches = tree.conversation_branches();
        fs::remove_file(&path).unwrap();

        // Should find 2 branches
        assert_eq!(branches.len(), 2);

        // Branch ending at a2 should contain u2, a2 (forked at a1, u2 is the fork user msg)
        let branch_a2 = branches.iter().find(|(leaf, _)| leaf == "a2").unwrap();
        assert!(branch_a2.1.contains(&"u2".to_string()));
        assert!(branch_a2.1.contains(&"a2".to_string()));
        // Should NOT contain u3
        assert!(!branch_a2.1.contains(&"u3".to_string()));

        // Branch ending at a3 should contain u3, a3
        let branch_a3 = branches.iter().find(|(leaf, _)| leaf == "a3").unwrap();
        assert!(branch_a3.1.contains(&"u3".to_string()));
        assert!(branch_a3.1.contains(&"a3".to_string()));
        // Should NOT contain u2
        assert!(!branch_a3.1.contains(&"u2".to_string()));
    }

    #[test]
    fn extract_session_id_from_filename_works() {
        assert_eq!(
            extract_session_id_from_filename("abc-123.jsonl"),
            Some("abc-123".to_string())
        );
        assert_eq!(
            extract_session_id_from_filename("abc-123.jsonl.reset.2026-03-17T04-46-13.819Z"),
            Some("abc-123".to_string())
        );
        assert_eq!(extract_session_id_from_filename("sessions.json"), None);
        assert_eq!(extract_session_id_from_filename("readme.txt"), None);
    }
}
