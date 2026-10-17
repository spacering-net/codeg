use std::collections::HashSet;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use chrono::{DateTime, TimeZone, Utc};
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;

use crate::models::{
    AgentType, ContentBlock, ConversationDetail, ConversationSummary, MessageTurn, TurnRole,
};
use crate::parsers::{
    backfill_turn_durations, compute_session_stats, folder_name_from_path,
    merge_context_window_stats, relocate_orphaned_tool_results, structurize_read_tool_output,
    title_from_user_text, truncate_str, AgentEnv, AgentParser, ParseError,
};

/// Caps mirroring the Grok parser: bound a single tool output / input preview
/// so one noisy command can't bloat a conversation detail payload.
const CURSOR_TOOL_OUTPUT_CAP: usize = 100_000;
const CURSOR_TOOL_INPUT_CAP: usize = 8_000;

/// Resolve Cursor's config home, mirroring the CLI's own chain:
/// `CURSOR_CONFIG_DIR`, else `$XDG_CONFIG_HOME/cursor`, else `~/.cursor`.
/// The CLI's chat store (`chats/`) and `cli-config.json` live under this path;
/// the user-level `mcp.json` does NOT (the CLI hardcodes `~/.cursor/mcp.json`).
pub(crate) fn resolve_cursor_config_dir() -> PathBuf {
    resolve_cursor_config_dir_for_env(&AgentEnv::inherited())
}

/// The config home of the Cursor CLI launched with `env`.
pub(crate) fn resolve_cursor_config_dir_for_env(env: &AgentEnv) -> PathBuf {
    resolve_cursor_config_from(
        env.var_os("CURSOR_CONFIG_DIR"),
        env.var_os("XDG_CONFIG_HOME"),
        dirs::home_dir(),
    )
}

fn resolve_cursor_config_from(
    config_env: Option<OsString>,
    xdg_env: Option<OsString>,
    home_dir: Option<PathBuf>,
) -> PathBuf {
    if let Some(dir) = config_env.filter(|value| !value.is_empty()) {
        return PathBuf::from(dir);
    }
    if let Some(xdg) = xdg_env.filter(|value| !value.is_empty()) {
        return PathBuf::from(xdg).join("cursor");
    }
    home_dir.unwrap_or_default().join(".cursor")
}

/// Cursor (cursor-agent CLI) stores each conversation as a **SQLite blob
/// store**. Interactive CLI/IDE chats — and the sub-agent children spawned by
/// `task` tool calls — are grouped by the MD5 of the resolved working
/// directory, while ACP sessions (what codeg drives) live under a flat
/// per-session root with a JSON sidecar:
///
/// ```text
/// $CURSOR_CONFIG_DIR/                (default ~/.cursor)
/// ├── chats/
/// │   └── <md5-hex-of-cwd>/          # createHash("md5").update(resolve(cwd))
/// │       └── <chat-uuid>/
/// │           └── store.db           # blobs(id TEXT, data BLOB) + meta(key, value)
/// └── acp-sessions/
///     └── <session-uuid>/
///         ├── meta.json              # {schemaVersion, cwd, title}
///         └── store.db               # same blob-store format
/// ```
///
/// `meta` key `"0"` holds the chat metadata as **hex-encoded UTF-8 JSON**:
/// `{agentId, latestRootBlobId (hex), name, createdAt, mode, isRunEverything,
/// approvalMode, lastUsedModel, subagentInfo, …}` (legacy `mode:"auto-run"`
/// maps to `default`). `blobs` is a content-addressed DAG of protobuf
/// (`agent.v1.*`) messages, ids stored as lowercase hex:
///
/// ```text
/// latestRootBlobId → ConversationStateStructure
///   .turns[] (blob ids) → ConversationTurnStructure
///     .agent_conversation_turn:
///        .user_message (blob id) → UserMessage{text, rich_text, text_blob_id}
///        .steps[] (blob ids) → ConversationStep (oneof assistant_message /
///                              thinking_message / tool_call{ToolCall oneof})
///     .shell_conversation_turn:  user-typed `!` commands
///        .shell_command / .shell_output (blob ids)
///   .token_details {used_tokens, max_tokens}
///   .turn_timings[] {duration_ms, timestamp_ms}   (aligned with .turns)
///   .tracked_git_repo_branches[] {repo_path, branch_name}
/// ```
///
/// The schema was extracted from the CLI's own protobuf-es runtime field
/// tables (2026.07.16 bundle); every decode below is defensive — unknown
/// fields are skipped and unknown tool variants degrade to a generic tool
/// card — so an upstream schema drift renders less detail instead of failing.
pub struct CursorParser {
    chats_dir: PathBuf,
    acp_sessions_dir: PathBuf,
    /// Root of codeg's own per-turn timing journal (`crate::turn_timings`) —
    /// the fallback clock for turns whose store yields none (thinking+text
    /// only; the ACP store has no message timestamps).
    turn_timings_root: PathBuf,
}

impl CursorParser {
    pub fn new() -> Self {
        Self::for_env(&AgentEnv::inherited())
    }

    /// The history of the Cursor CLI launched with `env`. The turn-timing
    /// journal is codeg's own and does not move with it.
    pub fn for_env(env: &AgentEnv) -> Self {
        let config_dir = resolve_cursor_config_dir_for_env(env);
        Self {
            chats_dir: config_dir.join("chats"),
            acp_sessions_dir: config_dir.join("acp-sessions"),
            turn_timings_root: crate::paths::codeg_turn_timings_root(),
        }
    }

    /// Construct a parser pointed at an explicit `chats` directory (tests).
    /// The ACP-session root is derived as its `acp-sessions` sibling, and the
    /// timing journal as its `turn-timings` sibling.
    #[cfg(any(test, feature = "test-utils"))]
    pub fn with_base_dir(chats_dir: PathBuf) -> Self {
        let sibling = |name: &str| {
            chats_dir
                .parent()
                .map(|p| p.join(name))
                .unwrap_or_else(|| PathBuf::from(name))
        };
        let acp_sessions_dir = sibling("acp-sessions");
        let turn_timings_root = sibling("turn-timings");
        Self {
            chats_dir,
            acp_sessions_dir,
            turn_timings_root,
        }
    }

    fn build_summary(&self, chat_dir: &Path, chat_id: &str) -> Option<ConversationSummary> {
        let conn = open_store(&chat_dir.join("store.db"))?;
        let meta = read_chat_meta(&conn)?;
        // Sub-agent transcripts are children of a main chat; only top-level
        // chats are listed (mirrors the other parsers).
        if meta.is_subagent {
            return None;
        }
        let state = meta
            .latest_root_blob_id
            .as_deref()
            .and_then(|id| read_blob(&conn, id))
            .map(|bytes| decode_state(&bytes))?;
        // A chat that never got a turn (e.g. `create-chat`, or an ACP session
        // opened without a prompt) is metadata-only — not listed.
        if state.turn_blob_ids.is_empty() {
            return None;
        }
        let sidecar = read_sidecar_meta(chat_dir);
        let title = meta
            .name
            .clone()
            .or_else(|| sidecar.title.clone())
            .or_else(|| {
                first_user_text(&conn, &state)
                    .as_deref()
                    .map(title_from_user_text)
            });
        Some(summary_from(chat_id, &meta, &state, &sidecar, title))
    }

    fn build_detail(&self, chat_dir: &Path, chat_id: &str) -> Option<ConversationDetail> {
        let conn = open_store(&chat_dir.join("store.db"))?;
        let meta = read_chat_meta(&conn)?;
        let state = meta
            .latest_root_blob_id
            .as_deref()
            .and_then(|id| read_blob(&conn, id))
            .map(|bytes| decode_state(&bytes))
            .unwrap_or_default();

        let (mut turns, store_clocked) = build_turns(&conn, &state, &meta);
        // Overlay codeg's own turn-span journal — recorded live by the ACP
        // connection layer. It fills turns the store left clockless (tool-free
        // turns) and replaces tool-span fallback clocks, which only cover the
        // tools, not the whole turn. CLI-native chats simply have no journal
        // file (empty vec, no-op).
        apply_turn_timing_journal(
            &mut turns,
            &crate::turn_timings::read_turn_timings_in(
                &self.turn_timings_root,
                crate::turn_timings::CURSOR_JOURNAL_AGENT,
                chat_id,
            ),
            &store_clocked,
        );
        relocate_orphaned_tool_results(&mut turns);
        structurize_read_tool_output(&mut turns);
        // Cursor's own `turn_timings` win; this only reaches turns the store
        // never timed (and in a store with no clock at all it changes nothing —
        // those turns share one synthetic timestamp, so every span is zero).
        backfill_turn_durations(&mut turns, &[]);

        // Cursor records only a session-level context meter (token_details);
        // pair it with the turns' aggregate stats so the status bar shows the
        // context ring.
        let session_stats = merge_context_window_stats(
            compute_session_stats(&turns),
            state.used_tokens,
            state.max_tokens,
        );

        let title = turns
            .iter()
            .find(|t| matches!(t.role, TurnRole::User))
            .and_then(|t| {
                t.blocks.iter().find_map(|b| match b {
                    ContentBlock::Text { text } if !text.trim().is_empty() => {
                        Some(title_from_user_text(text))
                    }
                    _ => None,
                })
            });
        let sidecar = read_sidecar_meta(chat_dir);
        let title = meta.name.clone().or_else(|| sidecar.title.clone()).or(title);
        let summary = summary_from(chat_id, &meta, &state, &sidecar, title);

        Some(ConversationDetail {
            summary,
            turns,
            session_stats,
            transcript_watermark: None,
        })
    }

    /// Locate the directory matching `conversation_id`: the flat
    /// `acp-sessions/<uuid>/` root first (direct hit), then the
    /// `chats/<md5>/<uuid>/` buckets (two shallow levels).
    fn find_chat_dir(&self, conversation_id: &str) -> Option<PathBuf> {
        let acp_candidate = self.acp_sessions_dir.join(conversation_id);
        if acp_candidate.join("store.db").is_file() {
            return Some(acp_candidate);
        }
        for group in read_subdirs(&self.chats_dir) {
            let candidate = group.join(conversation_id);
            if candidate.join("store.db").is_file() {
                return Some(candidate);
            }
        }
        None
    }

    /// Append `chat_dir`'s summary to `out` when it holds a listable store.
    fn collect_summary(&self, chat_dir: &Path, out: &mut Vec<ConversationSummary>) {
        let Some(chat_id) = chat_dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
        else {
            return;
        };
        if !chat_dir.join("store.db").is_file() {
            return;
        }
        if let Some(summary) = self.build_summary(chat_dir, &chat_id) {
            out.push(summary);
        }
    }
}

impl Default for CursorParser {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentParser for CursorParser {
    fn list_conversations(&self) -> Result<Vec<ConversationSummary>, ParseError> {
        let mut conversations = Vec::new();
        for group in read_subdirs(&self.chats_dir) {
            for chat_dir in read_subdirs(&group) {
                self.collect_summary(&chat_dir, &mut conversations);
            }
        }
        // ACP sessions (codeg-driven) live under the flat per-uuid root.
        for chat_dir in read_subdirs(&self.acp_sessions_dir) {
            self.collect_summary(&chat_dir, &mut conversations);
        }
        conversations.sort_by_key(|c| std::cmp::Reverse(c.started_at));
        Ok(conversations)
    }

    fn get_conversation(&self, conversation_id: &str) -> Result<ConversationDetail, ParseError> {
        let chat_dir = self
            .find_chat_dir(conversation_id)
            .ok_or_else(|| ParseError::ConversationNotFound(conversation_id.to_string()))?;
        self.build_detail(&chat_dir, conversation_id)
            .ok_or_else(|| ParseError::ConversationNotFound(conversation_id.to_string()))
    }
}

fn summary_from(
    chat_id: &str,
    meta: &ChatMeta,
    state: &DecodedState,
    sidecar: &SidecarMeta,
    title: Option<String>,
) -> ConversationSummary {
    // The sidecar cwd is authoritative for ACP sessions: their stores are
    // keyed by session uuid (no md5(cwd) bucket), and the workspace refs
    // inside the DAG only appear once a turn ran.
    let folder_path = sidecar.cwd.clone().or_else(|| state.workspace_path());
    let folder_name = folder_path.as_deref().map(folder_name_from_path);
    let started_at = meta
        .created_at_ms
        .or(state.started_ms)
        .or_else(|| state.timings.first().and_then(|t| t.timestamp_ms))
        .and_then(ms_to_utc)
        .unwrap_or_else(Utc::now);
    let ended_at = state
        .timings
        .last()
        .and_then(|t| Some(t.timestamp_ms? + t.duration_ms.unwrap_or(0)))
        .and_then(ms_to_utc);
    ConversationSummary {
        id: chat_id.to_string(),
        agent_type: AgentType::Cursor,
        folder_path,
        folder_name,
        title,
        started_at,
        ended_at,
        // user + assistant per agent turn (approximation before full decode).
        message_count: (state.turn_blob_ids.len() as u32).saturating_mul(2),
        model: meta.last_used_model.clone(),
        git_branch: state.git_branch.clone(),
        parent_id: None,
        parent_tool_use_id: None,
        delegation_call_id: None,
    }
}

fn ms_to_utc(ms: u64) -> Option<DateTime<Utc>> {
    Utc.timestamp_millis_opt(i64::try_from(ms).ok()?).single()
}

/// First user prompt text, for the title fallback (decodes only turn 0).
fn first_user_text(conn: &Connection, state: &DecodedState) -> Option<String> {
    let turn_bytes = read_blob(conn, state.turn_blob_ids.first()?)?;
    let agent_turn = wire::first_message(&turn_bytes, 1)?;
    let user_ref = wire::first_bytes(&agent_turn, 1)?;
    let msg = read_user_message(conn, &user_ref);
    let text = decode_user_text(conn, &msg)?;
    (!text.trim().is_empty()).then_some(text)
}

// ---------------------------------------------------------------------------
// store.db access
// ---------------------------------------------------------------------------

/// Chat metadata from `meta["0"]` (hex-encoded UTF-8 JSON).
#[derive(Default)]
struct ChatMeta {
    name: Option<String>,
    created_at_ms: Option<u64>,
    last_used_model: Option<String>,
    latest_root_blob_id: Option<Vec<u8>>,
    is_subagent: bool,
}

fn open_store(path: &Path) -> Option<Connection> {
    // Prefer a read-only handle — codeg never mutates cursor's stores.
    if let Some(conn) =
        try_open_store(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
    {
        return Some(conn);
    }
    // The CLI keeps live stores in WAL mode with most data in `-wal`; after a
    // CLI crash the wal-index can need recovery, which a read-only connection
    // is not allowed to run (SQLITE_READONLY_RECOVERY). Fall back to a
    // read-write handle (no CREATE) — recovery rebuilds the index without
    // altering database content, exactly as the CLI's own next open would.
    try_open_store(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
}

fn try_open_store(path: &Path, flags: OpenFlags) -> Option<Connection> {
    let conn = Connection::open_with_flags(path, flags).ok()?;
    // The CLI may hold the store open while codeg lists sessions; give reads a
    // short grace period instead of failing on a transient lock.
    let _ = conn.busy_timeout(std::time::Duration::from_millis(200));
    // Opening is lazy — probe so a handle that cannot actually read (stale WAL
    // index, foreign schema) reports failure here instead of yielding no rows.
    conn.query_row("SELECT count(*) FROM meta", [], |row| row.get::<_, i64>(0))
        .ok()?;
    Some(conn)
}

/// Sidecar `meta.json` beside an ACP session's `store.db`
/// (`acp-sessions/<uuid>/meta.json`): `{schemaVersion, cwd, title}`. Absent
/// for `chats/` stores — every field degrades to `None`.
#[derive(Default)]
struct SidecarMeta {
    cwd: Option<String>,
    title: Option<String>,
}

fn read_sidecar_meta(chat_dir: &Path) -> SidecarMeta {
    let Ok(raw) = std::fs::read_to_string(chat_dir.join("meta.json")) else {
        return SidecarMeta::default();
    };
    let Ok(v) = serde_json::from_str::<Value>(&raw) else {
        return SidecarMeta::default();
    };
    let non_empty = |field: &str| {
        v.get(field)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    SidecarMeta {
        cwd: non_empty("cwd"),
        title: non_empty("title"),
    }
}

fn read_chat_meta(conn: &Connection) -> Option<ChatMeta> {
    let raw: String = conn
        .query_row("SELECT value FROM meta WHERE key = '0'", [], |row| {
            row.get(0)
        })
        .ok()?;
    // The value is hex-encoded UTF-8 JSON; tolerate a plain-JSON variant
    // defensively (older stores).
    let json_text = if raw.trim_start().starts_with('{') {
        raw
    } else {
        String::from_utf8(hex_decode(raw.trim())?).ok()?
    };
    let v: Value = serde_json::from_str(&json_text).ok()?;

    let non_empty = |s: &str| {
        let t = s.trim();
        (!t.is_empty()).then(|| t.to_string())
    };
    Some(ChatMeta {
        name: v.get("name").and_then(Value::as_str).and_then(non_empty),
        created_at_ms: json_ms(v.get("createdAt")),
        last_used_model: v
            .get("lastUsedModel")
            .and_then(Value::as_str)
            .and_then(non_empty),
        latest_root_blob_id: v
            .get("latestRootBlobId")
            .and_then(Value::as_str)
            .and_then(hex_decode),
        is_subagent: v
            .get("subagentInfo")
            .is_some_and(|s| !s.is_null()),
    })
}

/// Accept `createdAt` as epoch-ms number or RFC3339 string.
fn json_ms(v: Option<&Value>) -> Option<u64> {
    let v = v?;
    if let Some(n) = v.as_u64() {
        return Some(n);
    }
    let s = v.as_str()?;
    DateTime::parse_from_rfc3339(s)
        .ok()
        .and_then(|dt| u64::try_from(dt.timestamp_millis()).ok())
}

fn read_blob(conn: &Connection, id: &[u8]) -> Option<Vec<u8>> {
    conn.query_row(
        "SELECT data FROM blobs WHERE id = ?1",
        [hex_encode(id)],
        |row| row.get::<_, Vec<u8>>(0),
    )
    .ok()
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) || s.is_empty() {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok())
        .collect()
}

// ---------------------------------------------------------------------------
// Minimal protobuf wire-format reader (varint / length-delimited / fixed).
// ---------------------------------------------------------------------------

mod wire {
    pub enum Val<'a> {
        Varint(u64),
        Fixed64(u64),
        Bytes(&'a [u8]),
        /// 32-bit scalars (float/fixed32) — parsed to keep the field stream
        /// aligned; no cursor message we decode carries one we read.
        Fixed32,
    }

    impl<'a> Val<'a> {
        pub fn bytes(&self) -> Option<&'a [u8]> {
            match self {
                Val::Bytes(b) => Some(b),
                _ => None,
            }
        }
        pub fn str(&self) -> Option<&'a str> {
            std::str::from_utf8(self.bytes()?).ok()
        }
        pub fn u64(&self) -> Option<u64> {
            match self {
                Val::Varint(v) => Some(*v),
                _ => None,
            }
        }
        pub fn i32(&self) -> Option<i32> {
            // int32/int64/enum are varint-encoded (negatives use 10 bytes).
            self.u64().map(|v| v as i64 as i32)
        }
        pub fn f64(&self) -> Option<f64> {
            match self {
                Val::Fixed64(v) => Some(f64::from_bits(*v)),
                _ => None,
            }
        }
    }

    /// Iterate `(field_number, value)` pairs; stops silently at malformed
    /// input (truncated varint, out-of-bounds length, group wire types).
    pub struct Fields<'a> {
        buf: &'a [u8],
        pos: usize,
        malformed: bool,
    }

    impl<'a> Fields<'a> {
        pub fn new(buf: &'a [u8]) -> Self {
            Self {
                buf,
                pos: 0,
                malformed: false,
            }
        }

        /// Bytes consumed so far.
        pub fn consumed(&self) -> usize {
            self.pos
        }

        /// Whether iteration stopped on malformed input rather than a clean
        /// end-of-buffer. A failed parse may still have advanced `pos` (even
        /// to the buffer end, e.g. a truncated trailing varint), so
        /// `consumed()` alone cannot distinguish the two.
        pub fn is_malformed(&self) -> bool {
            self.malformed
        }

        fn varint(&mut self) -> Option<u64> {
            let mut out: u64 = 0;
            for i in 0..10 {
                let b = *self.buf.get(self.pos)?;
                self.pos += 1;
                out |= u64::from(b & 0x7f) << (7 * i);
                if b & 0x80 == 0 {
                    return Some(out);
                }
            }
            None
        }
    }

    impl<'a> Fields<'a> {
        fn parse_next(&mut self) -> Option<(u32, Val<'a>)> {
            let key = self.varint()?;
            let field_no = u32::try_from(key >> 3).ok()?;
            match key & 0x7 {
                0 => Some((field_no, Val::Varint(self.varint()?))),
                1 => {
                    let end = self.pos.checked_add(8)?;
                    let raw = self.buf.get(self.pos..end)?;
                    self.pos = end;
                    Some((field_no, Val::Fixed64(u64::from_le_bytes(raw.try_into().ok()?))))
                }
                2 => {
                    let len = usize::try_from(self.varint()?).ok()?;
                    let end = self.pos.checked_add(len)?;
                    let raw = self.buf.get(self.pos..end)?;
                    self.pos = end;
                    Some((field_no, Val::Bytes(raw)))
                }
                5 => {
                    let end = self.pos.checked_add(4)?;
                    self.buf.get(self.pos..end)?;
                    self.pos = end;
                    Some((field_no, Val::Fixed32))
                }
                _ => None, // groups (3/4) / invalid: stop
            }
        }
    }

    impl<'a> Iterator for Fields<'a> {
        type Item = (u32, Val<'a>);

        fn next(&mut self) -> Option<Self::Item> {
            if self.pos >= self.buf.len() {
                return None; // clean end
            }
            let item = self.parse_next();
            if item.is_none() {
                self.malformed = true;
            }
            item
        }
    }

    /// First occurrence of length-delimited `field` as raw bytes.
    pub fn first_bytes(buf: &[u8], field: u32) -> Option<Vec<u8>> {
        Fields::new(buf)
            .find(|(no, v)| *no == field && v.bytes().is_some())
            .and_then(|(_, v)| v.bytes().map(<[u8]>::to_vec))
    }

    /// First occurrence of `field` as an embedded message (same wire type as
    /// bytes — the caller decides how to interpret it).
    pub fn first_message(buf: &[u8], field: u32) -> Option<Vec<u8>> {
        first_bytes(buf, field)
    }

    /// First occurrence of `field` as a UTF-8 string.
    pub fn first_str(buf: &[u8], field: u32) -> Option<String> {
        Fields::new(buf)
            .find(|(no, v)| *no == field && v.str().is_some())
            .and_then(|(_, v)| v.str().map(str::to_string))
    }

    /// Whether `buf` decodes as a well-formed field stream to its exact end.
    /// Distinguishes a genuine message wrapper from a text payload whose
    /// leading bytes merely *look* like a field frame (those either fail to
    /// parse — flagged malformed even when the failed parse advanced to the
    /// buffer end — or stop short of the end).
    pub fn is_complete_message(buf: &[u8]) -> bool {
        let mut fields = Fields::new(buf);
        while fields.next().is_some() {}
        !fields.is_malformed() && fields.consumed() == buf.len()
    }
}

/// Decode a protobuf map<string, google.protobuf.Value> whose entries are the
/// repeated occurrences of `entry_field` in `buf` (each entry = {1: key,
/// 2: Value}). This is both `google.protobuf.Struct` (entries at field 1) and
/// `McpArgs.args` (map entries directly at field 2). Unknown/malformed parts
/// degrade to `null`s rather than failing.
fn decode_value_map(buf: &[u8], entry_field: u32) -> Value {
    let mut map = serde_json::Map::new();
    for (no, val) in wire::Fields::new(buf) {
        if no != entry_field {
            continue;
        }
        let Some(entry) = val.bytes() else { continue };
        let mut key: Option<String> = None;
        let mut value = Value::Null;
        for (eno, ev) in wire::Fields::new(entry) {
            match eno {
                1 => key = ev.str().map(str::to_string),
                2 => {
                    if let Some(b) = ev.bytes() {
                        value = decode_proto_value(b);
                    }
                }
                _ => {}
            }
        }
        if let Some(key) = key {
            map.insert(key, value);
        }
    }
    Value::Object(map)
}

/// `google.protobuf.Struct`: its `fields` map entries live at field 1.
fn decode_proto_struct(buf: &[u8]) -> Value {
    decode_value_map(buf, 1)
}

fn decode_proto_value(buf: &[u8]) -> Value {
    for (no, val) in wire::Fields::new(buf) {
        match no {
            1 => return Value::Null,
            2 => {
                if let Some(f) = val.f64() {
                    return serde_json::Number::from_f64(f)
                        .map(Value::Number)
                        .unwrap_or(Value::Null);
                }
            }
            3 => {
                if let Some(s) = val.str() {
                    return Value::String(s.to_string());
                }
            }
            4 => {
                if let Some(b) = val.u64() {
                    return Value::Bool(b != 0);
                }
            }
            5 => {
                if let Some(b) = val.bytes() {
                    return decode_proto_struct(b);
                }
            }
            6 => {
                if let Some(b) = val.bytes() {
                    let items = wire::Fields::new(b)
                        .filter(|(no, _)| *no == 1)
                        .filter_map(|(_, v)| v.bytes().map(decode_proto_value))
                        .collect();
                    return Value::Array(items);
                }
            }
            _ => {}
        }
    }
    Value::Null
}

// ---------------------------------------------------------------------------
// agent.v1 message decoding
// ---------------------------------------------------------------------------

#[derive(Default)]
struct TurnTiming {
    duration_ms: Option<u64>,
    timestamp_ms: Option<u64>,
}

#[derive(Default)]
struct DecodedState {
    turn_blob_ids: Vec<Vec<u8>>,
    used_tokens: Option<u64>,
    max_tokens: Option<u64>,
    repo_path: Option<String>,
    git_branch: Option<String>,
    timings: Vec<TurnTiming>,
    started_ms: Option<u64>,
    workspace_uris: Vec<String>,
    /// `working_directory` seen on a shell tool call — the workspace fallback
    /// for non-git projects. Filled lazily during turn decoding.
    shell_cwd: std::cell::RefCell<Option<String>>,
}

impl DecodedState {
    /// Workspace path, best source first: the tracked git repo, then any
    /// recorded workspace URI, then a shell call's working directory.
    fn workspace_path(&self) -> Option<String> {
        if let Some(repo) = &self.repo_path {
            return Some(repo.clone());
        }
        if let Some(uri) = self.workspace_uris.last() {
            let path = uri.strip_prefix("file://").unwrap_or(uri);
            if !path.trim().is_empty() {
                return Some(path.to_string());
            }
        }
        self.shell_cwd.borrow().clone()
    }
}

/// Decode `agent.v1.ConversationStateStructure` (the DAG root).
fn decode_state(buf: &[u8]) -> DecodedState {
    let mut state = DecodedState::default();
    for (no, val) in wire::Fields::new(buf) {
        match no {
            // 8: turns (repeated bytes — blob ids)
            8 => {
                if let Some(b) = val.bytes() {
                    state.turn_blob_ids.push(b.to_vec());
                }
            }
            // 5: token_details {1 used_tokens, 2 max_tokens}
            5 => {
                if let Some(b) = val.bytes() {
                    for (tno, tval) in wire::Fields::new(b) {
                        match tno {
                            1 => state.used_tokens = tval.u64(),
                            2 => state.max_tokens = tval.u64(),
                            _ => {}
                        }
                    }
                }
            }
            // 9: previous_workspace_uris (repeated string)
            9 => {
                if let Some(s) = val.str() {
                    state.workspace_uris.push(s.to_string());
                }
            }
            // 14: turn_timings {1 duration_ms, 2 timestamp_ms}
            14 => {
                if let Some(b) = val.bytes() {
                    let mut timing = TurnTiming::default();
                    for (tno, tval) in wire::Fields::new(b) {
                        match tno {
                            1 => timing.duration_ms = tval.u64(),
                            2 => timing.timestamp_ms = tval.u64(),
                            _ => {}
                        }
                    }
                    state.timings.push(timing);
                }
            }
            // 21: tracked_git_repo_branches {1 repo_path, 2 branch_name}
            21 => {
                if let Some(b) = val.bytes() {
                    if state.repo_path.is_none() {
                        state.repo_path =
                            wire::first_str(b, 1).filter(|s| !s.trim().is_empty());
                        state.git_branch =
                            wire::first_str(b, 2).filter(|s| !s.trim().is_empty());
                    }
                }
            }
            // 26: conversation_started_timestamp_ms
            26 => state.started_ms = val.u64(),
            _ => {}
        }
    }
    state
}

/// Resolve a turn's user-message reference into the raw `UserMessage` bytes.
/// `user_ref` is normally a blob id; fall back to treating it as an inline
/// `UserMessage` if the blob is absent (defensive dual-path).
fn read_user_message(conn: &Connection, user_ref: &[u8]) -> Vec<u8> {
    read_blob(conn, user_ref).unwrap_or_else(|| user_ref.to_vec())
}

/// User prompt text from a decoded `UserMessage`: `text` (1), else the
/// large-text blob (`text_blob_id`, 18), else `rich_text` (8).
fn decode_user_text(conn: &Connection, msg: &[u8]) -> Option<String> {
    let text = wire::first_str(msg, 1).filter(|s| !s.is_empty());
    if text.is_some() {
        return text;
    }
    if let Some(id) = wire::first_bytes(msg, 18) {
        if let Some(blob) = read_blob(conn, &id) {
            if let Ok(s) = String::from_utf8(blob) {
                if !s.is_empty() {
                    return Some(s);
                }
            }
        }
    }
    wire::first_str(msg, 8).filter(|s| !s.is_empty())
}

/// User-attached images from a decoded `UserMessage`.
///
/// Each attachment is a repeated field-3 entry wrapping an image variant at
/// field 1: `{1: image blob id (32 bytes), 2: attachment uuid, 7: mime}`; the
/// referenced blob holds the raw encoded bytes (PNG/JPEG/…), verified against
/// a real ACP session (`89504e47…` magic under `blobs`). Re-encoded as base64
/// for the `ContentBlock::Image` wire shape the frontend renders. Non-image
/// mimes, unresolvable blob ids, and malformed entries are skipped — an
/// attachment we can't decode must not sink the turn's text.
fn decode_user_images(conn: &Connection, msg: &[u8]) -> Vec<ContentBlock> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let mut out = Vec::new();
    for (no, val) in wire::Fields::new(msg) {
        if no != 3 {
            continue;
        }
        let Some(attachment) = val.bytes() else {
            continue;
        };
        let Some(image) = wire::first_message(attachment, 1) else {
            continue;
        };
        let Some(mime_type) = wire::first_str(&image, 7).filter(|m| m.starts_with("image/"))
        else {
            continue;
        };
        let Some(bytes) = wire::first_bytes(&image, 1).and_then(|id| read_blob(conn, &id))
        else {
            continue;
        };
        if bytes.is_empty() {
            continue;
        }
        out.push(ContentBlock::Image {
            data: STANDARD.encode(&bytes),
            mime_type,
            uri: None,
        });
    }
    out
}

/// Build codeg turns from the DAG: one User + one Assistant `MessageTurn` per
/// `AgentConversationTurnStructure`; `!`-shell turns render as a user command
/// turn plus an assistant turn holding the terminal card.
///
/// The second return value indexes the assistant turns whose clock came from
/// the STORE's own root `turn_timings` (IDE-written chats). Those clocks are
/// authoritative; everything else — tool-span fallback or no clock at all —
/// may be upgraded by codeg's turn-span journal downstream.
fn build_turns(
    conn: &Connection,
    state: &DecodedState,
    meta: &ChatMeta,
) -> (Vec<MessageTurn>, HashSet<usize>) {
    let mut turns: Vec<MessageTurn> = Vec::new();
    let mut store_clocked: HashSet<usize> = HashSet::new();

    for (i, turn_id) in state.turn_blob_ids.iter().enumerate() {
        let Some(turn_bytes) = read_blob(conn, turn_id) else {
            continue;
        };
        let timing = state.timings.get(i);
        let root_ts_ms = timing.and_then(|t| t.timestamp_ms);
        let root_duration_ms = timing.and_then(|t| t.duration_ms).filter(|d| *d > 0);
        let store_clock = root_ts_ms.is_some() || root_duration_ms.is_some();
        let ts = root_ts_ms
            .and_then(ms_to_utc)
            .or_else(|| meta.created_at_ms.and_then(ms_to_utc))
            .unwrap_or_else(Utc::now);
        let completed_at = timing
            .and_then(|t| Some(t.timestamp_ms? + t.duration_ms.unwrap_or(0)))
            .and_then(ms_to_utc);
        let duration_ms = root_duration_ms;

        if let Some(agent_turn) = wire::first_message(&turn_bytes, 1) {
            // One pass over the steps: decode blocks and (only when the root
            // carries no timing for this turn) fold the tool-call clock span,
            // without retaining every raw step payload.
            let want_span = !store_clock;
            let mut span: Option<(u64, u64)> = None;
            let mut blocks: Vec<ContentBlock> = Vec::new();
            for (no, val) in wire::Fields::new(&agent_turn) {
                if no != 2 {
                    continue;
                }
                let Some(step_ref) = val.bytes() else { continue };
                let step = read_blob(conn, step_ref).unwrap_or_else(|| step_ref.to_vec());
                if want_span {
                    fold_tool_span(&step, &mut span);
                }
                decode_step(conn, &step, state, &mut blocks);
            }
            // ACP-written stores carry no root `turn_timings`; the span of
            // the turn's own tool calls is the fallback clock. Thinking and
            // text steps carry no clock at all, so a tool-free turn stays
            // clockless rather than borrowing a wrong timestamp.
            let ts = span.and_then(|(lo, _)| ms_to_utc(lo)).unwrap_or(ts);
            let completed_at =
                completed_at.or_else(|| span.and_then(|(_, hi)| ms_to_utc(hi)));
            let duration_ms = duration_ms
                .or_else(|| span.and_then(|(lo, hi)| (hi > lo).then_some(hi - lo)));

            // --- user prompt (text + attached images) ---
            if let Some(user_ref) = wire::first_bytes(&agent_turn, 1) {
                let msg = read_user_message(conn, &user_ref);
                let mut user_blocks: Vec<ContentBlock> = Vec::new();
                if let Some(text) = decode_user_text(conn, &msg) {
                    if !text.trim().is_empty() {
                        user_blocks.push(ContentBlock::Text { text });
                    }
                }
                // Text first, then attachments — matching the composer's
                // send order. An image-only prompt still produces the turn.
                user_blocks.extend(decode_user_images(conn, &msg));
                if !user_blocks.is_empty() {
                    turns.push(MessageTurn {
                        id: String::new(),
                        role: TurnRole::User,
                        blocks: user_blocks,
                        timestamp: ts,
                        usage: None,
                        duration_ms: None,
                        model: None,
                        completed_at: None,
                    agent_message_id: None,
                    });
                }
            }
            if !blocks.is_empty() {
                if store_clock {
                    store_clocked.insert(turns.len());
                }
                turns.push(MessageTurn {
                    id: String::new(),
                    role: TurnRole::Assistant,
                    blocks,
                    timestamp: ts,
                    usage: None,
                    duration_ms,
                    model: meta.last_used_model.clone(),
                    completed_at,
                agent_message_id: None,
                });
            }
        } else if let Some(shell_turn) = wire::first_message(&turn_bytes, 2) {
            // --- user-typed `!` shell command ---
            let command = wire::first_bytes(&shell_turn, 1)
                .and_then(|id| {
                    let msg = read_blob(conn, &id).unwrap_or(id);
                    wire::first_str(&msg, 1)
                })
                .unwrap_or_default();
            let output = wire::first_bytes(&shell_turn, 2).map(|id| {
                let msg = read_blob(conn, &id).unwrap_or(id);
                let stdout = wire::first_str(&msg, 1).unwrap_or_default();
                let stderr = wire::first_str(&msg, 2).unwrap_or_default();
                let exit_code = wire::Fields::new(&msg)
                    .find(|(no, _)| *no == 3)
                    .and_then(|(_, v)| v.i32())
                    .unwrap_or(0);
                (join_streams(&stdout, &stderr), exit_code)
            });
            if command.trim().is_empty() {
                continue;
            }
            turns.push(MessageTurn {
                id: String::new(),
                role: TurnRole::User,
                blocks: vec![ContentBlock::Text {
                    text: format!("! {command}"),
                }],
                timestamp: ts,
                usage: None,
                duration_ms: None,
                model: None,
                completed_at: None,
            agent_message_id: None,
            });
            let tool_id = format!("cursor-shell-{i}");
            let (preview, exit_code) = output.unwrap_or((None, 0));
            if store_clock {
                store_clocked.insert(turns.len());
            }
            turns.push(MessageTurn {
                id: String::new(),
                role: TurnRole::Assistant,
                blocks: vec![
                    ContentBlock::ToolUse {
                        tool_use_id: Some(tool_id.clone()),
                        tool_name: "shell".to_string(),
                        input_preview: bounded_json_preview(
                            &serde_json::json!({ "command": command }),
                        ),
                        status: None,
                        meta: None,
                    },
                    ContentBlock::ToolResult {
                        tool_use_id: Some(tool_id),
                        output_preview: preview,
                        is_error: exit_code != 0,
                        agent_stats: None,
                        images: Vec::new(),
                    },
                ],
                timestamp: ts,
                usage: None,
                duration_ms,
                model: None,
                completed_at,
            agent_message_id: None,
            });
        }
    }

    for (i, turn) in turns.iter_mut().enumerate() {
        turn.id = format!("cursor-turn-{i}");
    }
    (turns, store_clocked)
}

/// Merge codeg's own turn-span journal (`crate::turn_timings`) onto the
/// store's turns: it fills turns the store left clockless (thinking+text-only
/// turns have neither root `turn_timings` nor tool `f59`/`f60` stamps) AND
/// replaces tool-span fallback clocks — the tool span only covers
/// first-tool-start → last-tool-end (often a sub-second slice of a long
/// turn), while a matched journal line measured the full prompt → `end_turn`
/// wall span at the connection. Replacement additionally requires the line
/// to BRACKET the existing tool span (see the containment guard below), so
/// a stale line misattributed across identical prompts can only ever reach
/// turns that had no clock to lose.
///
/// Alignment is tail-anchored and hash-verified: walk the user turns and the
/// journal both **backwards**, pairing while `prompt_hash(user text)` matches
/// the journal line, and STOP at the first mismatch. The tail anchor is what
/// makes the dominant divergence safe — turns recorded before the journal
/// feature existed all sit at the FRONT of a session, so the recorded tail
/// still aligns; a mid-walk confusion (a crash gap, a turn codeg never saw)
/// stops the walk instead of scanning, which could misassign spans between
/// identical prompts. STORE-native clocks (root `turn_timings`, indexed by
/// `store_clocked` — IDE-written chats) always win: the journal only
/// corroborates those pairs.
///
/// Identical-prompt runs get an extra equality guard (Codex review): a line
/// can exist for a turn the store never kept (see the count guard below for
/// the sources), so a run of same-hash journal entries can be LONGER than
/// the store's run of same-text turns — hash pairing alone would then hand
/// that phantom's span to an older identical prompt (image-only prompts all
/// hash as "" and are the easiest collision). Whenever either side is in a
/// same-hash run, both runs must have EQUAL length or the walk stops before
/// assigning anything from that run.
///
/// These guards are defense-in-depth, not a proof: two narrow residuals
/// remain where a WRONG span (not just a missing one) can be assigned — a
/// clean-`end_turn` turn Cursor failed to persist, and a missing journal
/// SUFFIX whose stale tail hash-collides with the store's newest turn. Both
/// are documented in `turn_timings`' module docs; the latter is pinned by
/// `accepted_residual_missing_tail_lines_can_misattribute_span`.
/// The hashes a stored user turn's text may have been journaled under.
///
/// The connection hashes the prompt's own text blocks BEFORE it appends
/// codeg's internal frames (the `@agent` / `@assistant` routing frames, the
/// assistant brief), while Cursor stores the prompt it received: the user's
/// text, then each frame, joined by whatever its ACP server puts between
/// blocks. So the user's text is everything before the first frame, less one
/// joiner — the very string seen between two frames when there are several,
/// otherwise each of the usual ones in turn. Text without a frame keeps its
/// single exact hash.
fn user_prompt_hashes(text: &str) -> Vec<String> {
    use crate::acp::agent_mentions::internal_frame_spans;
    use crate::turn_timings::prompt_hash;
    let spans = internal_frame_spans(text);
    let Some(&(first_start, first_end)) = spans.first() else {
        return vec![prompt_hash(text)];
    };
    let prefix = &text[..first_start];
    let mut joiners: Vec<&str> = Vec::new();
    if let Some(&(second_start, _)) = spans.get(1) {
        joiners.push(&text[first_end..second_start]);
    }
    joiners.extend(["\n\n", "\r\n", "\n", " "]);
    let mut candidates: Vec<&str> = vec![prefix];
    candidates.extend(
        joiners
            .iter()
            .filter(|j| !j.is_empty())
            .filter_map(|j| prefix.strip_suffix(*j)),
    );
    candidates.push(prefix.trim_end());
    let mut hashes: Vec<String> = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        let hash = prompt_hash(candidate);
        if !hashes.contains(&hash) {
            hashes.push(hash);
        }
    }
    hashes
}

fn apply_turn_timing_journal(
    turns: &mut [MessageTurn],
    journal: &[crate::turn_timings::TurnTiming],
    store_clocked: &HashSet<usize>,
) {
    if journal.is_empty() {
        return;
    }
    // Contiguity anchor (Codex review R5/R6): trust only the journal's
    // trailing run of SAME-CONNECTION, strictly consecutive ordinals. An
    // ordinal step ≠ 1 walking backwards means a gap (dropped line, skipped
    // non-`end_turn` turn) — and ordinals are only comparable within one
    // connection, so a `conn` change ends trust too (numerically consecutive
    // ordinals across a resume boundary prove nothing: old conn's ord 1
    // followed by a new conn's ord 2 whose ord-1 turn was canceled). Either
    // way positions across the boundary can't anchor, and the reverse walk
    // could otherwise slide over the gap onto an older same-hash entry
    // (store [x, y, x, z] with journal [x, z] would hand the FIRST x's span
    // to the THIRD turn). Within the trusted run, adjacent entries are
    // adjacent turns by construction.
    let mut trusted_start = journal.len() - 1;
    while trusted_start > 0 {
        let prev = &journal[trusted_start - 1];
        let cur = &journal[trusted_start];
        if prev.ord + 1 != cur.ord || prev.conn != cur.conn {
            break;
        }
        trusted_start -= 1;
    }
    let journal = &journal[trusted_start..];
    // (user turn index, following assistant turn index if adjacent)
    let user_indices: Vec<usize> = turns
        .iter()
        .enumerate()
        .filter(|(_, t)| matches!(t.role, TurnRole::User))
        .map(|(i, _)| i)
        .collect();
    // Count guard (Codex review R4-2): the writer journals only cleanly
    // completed turns, which Cursor persists in all but the failure case
    // documented as the first `turn_timings` residual — so a legitimate
    // journal can have FEWER entries than the store has user turns
    // (pre-feature turns, dropped lines) but, that residual aside, never
    // MORE. More entries means phantom lines (turns the store never kept, a
    // foreign file), and a phantom at the tail would hash-pair with an older
    // same-text turn even across non-contiguous positions. Nothing is
    // salvageable then.
    if journal.len() > user_indices.len() {
        return;
    }
    let user_hash = |turns: &[MessageTurn], user_idx: usize| -> Vec<String> {
        let text: String = turns[user_idx]
            .blocks
            .iter()
            .filter_map(|b| match b {
                ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        user_prompt_hashes(&text)
    };
    let mut j = journal.len();
    for (pos, &user_idx) in user_indices.iter().enumerate().rev() {
        if j == 0 {
            break;
        }
        let entry = &journal[j - 1];
        if !user_hash(turns, user_idx).contains(&entry.prompt_sha) {
            break;
        }
        // Same-hash-run equality guard (see the doc comment). Runs are counted
        // from this pairing backwards on both sides; inequality means the
        // journal recorded turns the store never kept (or vice versa) and the
        // 1:1 tail alignment inside the run is unprovable.
        let journal_run = journal[..j]
            .iter()
            .rev()
            .take_while(|e| e.prompt_sha == entry.prompt_sha)
            .count();
        let store_run = user_indices[..=pos]
            .iter()
            .rev()
            .take_while(|&&u| user_hash(turns, u).contains(&entry.prompt_sha))
            .count();
        if (journal_run > 1 || store_run > 1) && journal_run != store_run {
            break;
        }
        j -= 1;
        let started = ms_to_utc(entry.started_at_ms);
        let assistant_idx = (user_idx + 1 < turns.len()
            && matches!(turns[user_idx + 1].role, TurnRole::Assistant))
        .then_some(user_idx + 1);
        if assistant_idx.map(|a| store_clocked.contains(&a)).unwrap_or(false) {
            continue; // store-native root timing present — journal only corroborates
        }
        let Some(a) = assistant_idx else { continue };
        // A tool-span fallback clock is a subset of the turn; the matched
        // journal line replaces it with the full prompt→end_turn span — but
        // only when the line BRACKETS the span. For a line that truly
        // measured this turn, containment is structural: the connection
        // stamps the start before the prompt reaches the agent (so before
        // any tool runs) and the end when `TurnComplete` arrives (after the
        // last tool finished), all on one machine's clock. A line
        // misattributed across identical prompts (the documented
        // missing-suffix residual) belongs to an OLDER turn, which ended
        // before this turn's tools started — it fails the check and the tool
        // span, though partial, stays as the safer clock. The check also
        // subsumes degenerate zero-span lines (they can't bracket a real
        // span and have no duration to offer).
        if turns[a].duration_ms.is_some() || turns[a].completed_at.is_some() {
            let fallback_start = turns[a].timestamp.timestamp_millis();
            let fallback_end = turns[a]
                .completed_at
                .map(|c| c.timestamp_millis())
                .unwrap_or(fallback_start);
            let brackets = (entry.started_at_ms as i64) <= fallback_start
                && (entry.ended_at_ms as i64) >= fallback_end;
            if !brackets {
                continue;
            }
        }
        let journal_span_ms = (entry.ended_at_ms > entry.started_at_ms)
            .then(|| entry.ended_at_ms - entry.started_at_ms);
        turns[a].completed_at = ms_to_utc(entry.ended_at_ms);
        turns[a].duration_ms = journal_span_ms;
        // The turn's fallback timestamp (session createdAt or first tool
        // start) upgrades to the observed send time on both siblings.
        if let Some(start) = started {
            turns[user_idx].timestamp = start;
            turns[a].timestamp = start;
        }
    }
}

/// Fold one step's tool-call wall-clock stamps into a min/max span:
/// `ToolCall.started_at_ms` (field 59) / `ended_at_ms` (field 60). A
/// failed-fast call may carry only the end stamp, so both fields fold into
/// the same span. Non-tool steps contribute nothing.
fn fold_tool_span(step: &[u8], span: &mut Option<(u64, u64)>) {
    // ConversationStep oneof field 2 = tool_call.
    let Some(tool_call) = wire::first_message(step, 2) else {
        return;
    };
    for (no, val) in wire::Fields::new(&tool_call) {
        if no != 59 && no != 60 {
            continue;
        }
        let Some(ms) = val.u64().filter(|ms| *ms > 0) else {
            continue;
        };
        *span = Some(match *span {
            Some((lo, hi)) => (lo.min(ms), hi.max(ms)),
            None => (ms, ms),
        });
    }
}

/// Decode one `ConversationStep` into content blocks.
fn decode_step(
    conn: &Connection,
    step: &[u8],
    state: &DecodedState,
    blocks: &mut Vec<ContentBlock>,
) {
    for (no, val) in wire::Fields::new(step) {
        let Some(body) = val.bytes() else { continue };
        match no {
            // assistant_message { 1: text }
            1 => {
                if let Some(text) = wire::first_str(body, 1).filter(|t| !t.is_empty()) {
                    if let Some(ContentBlock::Text { text: last }) = blocks.last_mut() {
                        last.push_str(&text);
                    } else {
                        blocks.push(ContentBlock::Text { text });
                    }
                }
            }
            // tool_call { oneof … }
            2 => decode_tool_call(conn, body, state, blocks),
            // thinking_message { 1: text }
            3 => {
                if let Some(text) = wire::first_str(body, 1).filter(|t| !t.is_empty()) {
                    if let Some(ContentBlock::Thinking { text: last }) = blocks.last_mut() {
                        last.push('\n');
                        last.push_str(&text);
                    } else {
                        blocks.push(ContentBlock::Thinking { text });
                    }
                }
            }
            _ => {}
        }
    }
}

/// `agent.v1.ToolCall` oneof field number → tool name, for every variant the
/// 2026.07.16 CLI models. Undecoded variants still render a named card.
fn tool_name_for_field(no: u32) -> Option<&'static str> {
    Some(match no {
        1 => "shell",
        3 => "delete",
        4 => "glob",
        5 => "grep",
        8 => "read",
        9 => "update_todos",
        10 => "read_todos",
        12 => "edit",
        13 => "ls",
        14 => "read_lints",
        15 => "mcp",
        16 => "sem_search",
        17 => "create_plan",
        18 => "web_search",
        19 => "task",
        20 => "list_mcp_resources",
        21 => "read_mcp_resource",
        22 => "apply_agent_diff",
        23 => "ask_question",
        24 => "fetch",
        25 => "switch_mode",
        28 => "generate_image",
        29 => "record_screen",
        30 => "computer_use",
        31 => "write_shell_stdin",
        32 => "reflect",
        33 => "setup_vm_environment",
        34 => "truncated_tool_call",
        35 => "start_grind_execution",
        36 => "start_grind_planning",
        37 => "web_fetch",
        38 => "report_bugfix_results",
        39 => "ai_attribution",
        40 => "pr_management",
        41 => "mcp_auth",
        42 => "await",
        43 => "blame_by_file_path",
        44 => "get_mcp_tools",
        45 => "report_bug",
        46 => "set_active_branch",
        48 => "communicate_update",
        49 => "send_final_summary",
        50 => "update_pr_code_tour",
        51 => "replace_env",
        52 => "edit_pr_labels",
        53 => "record_ci_investigation_findings",
        55 => "send_message",
        56 => "fetch_cloud_agent_data",
        58 => "send_to_user",
        61 => "pi_read",
        62 => "pi_bash",
        63 => "pi_edit",
        64 => "pi_write",
        65 => "pi_grep",
        66 => "pi_find",
        67 => "pi_ls",
        68 => "connect_scm",
        69 => "search_conversations",
        _ => return None,
    })
}

struct DecodedTool {
    name: String,
    input: Option<Value>,
    output: Option<String>,
    is_error: bool,
}

/// Decode one `agent.v1.ToolCall` into a ToolUse + ToolResult block pair.
fn decode_tool_call(
    conn: &Connection,
    body: &[u8],
    state: &DecodedState,
    blocks: &mut Vec<ContentBlock>,
) {
    let mut tool: Option<DecodedTool> = None;
    let mut tool_call_id: Option<String> = None;

    for (no, val) in wire::Fields::new(body) {
        match no {
            57 => tool_call_id = val.str().map(str::to_string),
            _ => {
                if tool.is_none() {
                    if let (Some(name), Some(payload)) = (tool_name_for_field(no), val.bytes()) {
                        tool = Some(decode_tool_variant(conn, no, name, payload, state));
                    }
                }
            }
        }
    }

    let Some(tool) = tool else { return };
    let id = tool_call_id
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("cursor-tool-{}", blocks.len()));
    blocks.push(ContentBlock::ToolUse {
        tool_use_id: Some(id.clone()),
        tool_name: tool.name,
        input_preview: tool.input.as_ref().and_then(bounded_json_preview_ref),
        status: None,
        meta: None,
    });
    blocks.push(ContentBlock::ToolResult {
        tool_use_id: Some(id),
        output_preview: tool
            .output
            .map(|o| truncate_str(&o, CURSOR_TOOL_OUTPUT_CAP)),
        is_error: tool.is_error,
        agent_stats: None,
        images: Vec::new(),
    });
}

/// Per-variant decode. `args` is field 1, `result` field 2 on every
/// `agent.v1.<X>ToolCall` message.
fn decode_tool_variant(
    conn: &Connection,
    field_no: u32,
    name: &str,
    payload: &[u8],
    state: &DecodedState,
) -> DecodedTool {
    let args = wire::first_message(payload, 1);
    let result = wire::first_message(payload, 2);
    let mut tool = DecodedTool {
        name: name.to_string(),
        input: None,
        output: None,
        is_error: false,
    };

    match field_no {
        // shell
        1 => {
            if let Some(a) = &args {
                let command = wire::first_str(a, 1);
                if let Some(cwd) = wire::first_str(a, 2).filter(|s| !s.trim().is_empty()) {
                    state.shell_cwd.borrow_mut().get_or_insert(cwd);
                }
                let description = wire::first_str(a, 15);
                tool.input = Some(json_obj(&[
                    ("command", command),
                    ("description", description),
                ]));
            }
            if let Some(r) = &result {
                // oneof: 1 success / 2 failure / 3 timeout / 4 rejected /
                //        5 spawn_error / 7 permission_denied
                for (no, val) in wire::Fields::new(r) {
                    let Some(b) = val.bytes() else { continue };
                    match no {
                        1 | 2 => {
                            let interleaved_field = if no == 1 { 10 } else { 9 };
                            let out = wire::first_str(b, interleaved_field)
                                .filter(|s| !s.is_empty())
                                .or_else(|| {
                                    let stdout = wire::first_str(b, 5).unwrap_or_default();
                                    let stderr = wire::first_str(b, 6).unwrap_or_default();
                                    join_streams(&stdout, &stderr)
                                });
                            let exit_code = wire::Fields::new(b)
                                .find(|(fno, _)| *fno == 3)
                                .and_then(|(_, v)| v.i32())
                                .unwrap_or(0);
                            tool.output = out;
                            tool.is_error = no == 2 || exit_code != 0;
                            break;
                        }
                        3 => {
                            tool.output = Some("Command timed out".to_string());
                            tool.is_error = true;
                            break;
                        }
                        4 => {
                            tool.output = Some("Command rejected".to_string());
                            tool.is_error = true;
                            break;
                        }
                        5 | 7 => {
                            tool.output = wire::first_str(b, 1);
                            tool.is_error = true;
                            break;
                        }
                        _ => {}
                    }
                }
            }
        }
        // delete
        3 => {
            tool.input = args
                .as_deref()
                .map(|a| json_obj(&[("file_path", wire::first_str(a, 1))]));
        }
        // glob
        4 => {
            if let Some(a) = &args {
                tool.input = Some(json_obj(&[
                    ("pattern", wire::first_str(a, 2)),
                    ("path", wire::first_str(a, 1)),
                ]));
            }
            if let Some(success) = result.as_deref().and_then(|r| wire::first_message(r, 1)) {
                let files: Vec<String> = wire::Fields::new(&success)
                    .filter(|(no, _)| *no == 3)
                    .filter_map(|(_, v)| v.str().map(str::to_string))
                    .collect();
                if !files.is_empty() {
                    tool.output = Some(files.join("\n"));
                }
            }
        }
        // grep
        5 => {
            if let Some(a) = &args {
                tool.input = Some(json_obj(&[
                    ("pattern", wire::first_str(a, 1)),
                    ("path", wire::first_str(a, 2)),
                    ("glob", wire::first_str(a, 3)),
                ]));
            }
        }
        // read
        8 => {
            if let Some(a) = &args {
                let mut obj = serde_json::Map::new();
                if let Some(path) = wire::first_str(a, 1) {
                    obj.insert("file_path".into(), Value::String(path));
                }
                for (key, field) in [("offset", 2), ("limit", 3)] {
                    if let Some(n) = wire::Fields::new(a)
                        .find(|(no, _)| *no == field)
                        .and_then(|(_, v)| v.i32())
                    {
                        obj.insert(key.into(), Value::Number(n.into()));
                    }
                }
                tool.input = Some(Value::Object(obj));
            }
            if let Some(r) = &result {
                if let Some(success) = wire::first_message(r, 1) {
                    // content oneof: 1 inline string / 10 content blob /
                    //                6 binary data / 9 binary blob id
                    tool.output = wire::first_str(&success, 1)
                        .filter(|s| !s.is_empty())
                        .or_else(|| {
                            wire::first_bytes(&success, 10)
                                .and_then(|id| read_blob(conn, &id))
                                .and_then(|b| String::from_utf8(b).ok())
                        })
                        .or_else(|| {
                            let has_binary = wire::first_bytes(&success, 6).is_some()
                                || wire::first_bytes(&success, 9).is_some();
                            has_binary.then(|| "<binary file content>".to_string())
                        });
                } else if let Some(err) = wire::first_message(r, 2) {
                    tool.output = wire::first_str(&err, 1);
                    tool.is_error = true;
                }
            }
        }
        // update_todos
        9 => {
            if let Some(a) = &args {
                let todos: Vec<Value> = wire::Fields::new(a)
                    .filter(|(no, _)| *no == 1)
                    .filter_map(|(_, v)| v.bytes().map(<[u8]>::to_vec))
                    .filter_map(|item| {
                        wire::first_str(&item, 2).map(|content| {
                            serde_json::json!({ "content": content })
                        })
                    })
                    .collect();
                tool.input = Some(serde_json::json!({ "todos": todos }));
            }
        }
        // edit
        12 => {
            tool.input = args
                .as_deref()
                .map(|a| json_obj(&[("file_path", wire::first_str(a, 1))]));
            if let Some(r) = &result {
                for (no, val) in wire::Fields::new(r) {
                    let Some(b) = val.bytes() else { continue };
                    match no {
                        // success: prefer the ready-made diff, else message
                        1 => {
                            tool.output = wire::first_str(b, 5)
                                .filter(|s| !s.is_empty())
                                .or_else(|| wire::first_str(b, 8));
                            break;
                        }
                        // 2 file_not_found / 3+4 permission / 6 rejected / 7 error
                        2..=7 => {
                            tool.output = wire::first_str(b, 2).or_else(|| wire::first_str(b, 1));
                            tool.is_error = true;
                            break;
                        }
                        _ => {}
                    }
                }
            }
        }
        // ls
        13 => {
            tool.input = args
                .as_deref()
                .map(|a| json_obj(&[("path", wire::first_str(a, 1))]));
        }
        // mcp
        15 => {
            if let Some(a) = &args {
                let server = wire::first_str(a, 9)
                    .or_else(|| wire::first_str(a, 4))
                    .filter(|s| !s.is_empty());
                let tool_name = wire::first_str(a, 5)
                    .filter(|s| !s.is_empty())
                    .or_else(|| wire::first_str(a, 1));
                tool.name = match (server, tool_name) {
                    (Some(server), Some(t)) => format!("{server}__{t}"),
                    (None, Some(t)) => t,
                    _ => "mcp".to_string(),
                };
                // `McpArgs.args` is map<string, google.protobuf.Value>: the
                // map entries are the repeated field-2 occurrences on McpArgs
                // itself (there is no wrapping Struct message).
                let decoded = decode_value_map(a, 2);
                if decoded.as_object().is_some_and(|m| !m.is_empty()) {
                    tool.input = Some(decoded);
                }
            }
            if let Some(r) = &result {
                if let Some(success) = wire::first_message(r, 1) {
                    let mut texts: Vec<String> = Vec::new();
                    for (no, val) in wire::Fields::new(&success) {
                        if no == 1 {
                            if let Some(item) = val.bytes() {
                                if let Some(text_msg) = wire::first_message(item, 1) {
                                    if let Some(t) = wire::first_str(&text_msg, 1) {
                                        texts.push(t);
                                    }
                                }
                            }
                        } else if no == 2 {
                            tool.is_error = val.u64() == Some(1);
                        }
                    }
                    if !texts.is_empty() {
                        tool.output = Some(texts.join("\n"));
                    }
                } else if let Some(err) = wire::first_message(r, 2) {
                    tool.output = wire::first_str(&err, 1);
                    tool.is_error = true;
                }
            }
        }
        // sem_search
        16 => {
            if let Some(success) = result.as_deref().and_then(|r| wire::first_message(r, 1)) {
                tool.output = wire::first_str(&success, 1).filter(|s| !s.is_empty());
            }
        }
        // create_plan
        17 => {
            if let Some(a) = &args {
                tool.input = Some(json_obj(&[("name", wire::first_str(a, 4))]));
                tool.output = wire::first_str(a, 1).filter(|s| !s.is_empty());
            }
        }
        // web_search
        18 => {
            tool.input = args
                .as_deref()
                .map(|a| json_obj(&[("query", wire::first_str(a, 1))]));
        }
        // task (sub-agent)
        19 => {
            if let Some(a) = &args {
                // `subagent_type` is a oneof of empty marker messages; the
                // variant order matches the CLI's own enum error text
                // ("generalPurpose | cursor-guide | best-of-n-runner").
                let subagent_type = wire::first_message(a, 3).and_then(|m| {
                    wire::Fields::new(&m).next().map(|(no, _)| {
                        match no {
                            1 => "generalPurpose",
                            2 => "cursor-guide",
                            3 => "best-of-n-runner",
                            _ => "subagent",
                        }
                        .to_string()
                    })
                });
                tool.input = Some(json_obj(&[
                    ("description", wire::first_str(a, 1)),
                    ("prompt", wire::first_str(a, 2)),
                    ("subagent_type", subagent_type),
                    ("model", wire::first_str(a, 4)),
                ]));
            }
            if let Some(r) = &result {
                // oneof: 1 success {1 report (two rich-text wrapper layers),
                //                   2 sub-chat id, 4 duration_ms}
                //        2 error {1 message}
                if let Some(success) = wire::first_message(r, 1) {
                    tool.output = task_report_text(&success);
                } else if let Some(err) = wire::first_message(r, 2) {
                    tool.output = wire::first_str(&err, 1);
                    tool.is_error = true;
                }
            }
        }
        // ask_question
        23 => {
            if let Some(a) = &args {
                let questions: Vec<Value> = wire::Fields::new(a)
                    .filter(|(no, _)| *no == 2)
                    .filter_map(|(_, v)| v.bytes().map(<[u8]>::to_vec))
                    .filter_map(|q| wire::first_str(&q, 2).map(Value::String))
                    .collect();
                tool.input = Some(serde_json::json!({
                    "title": wire::first_str(a, 1),
                    "questions": questions,
                }));
            }
        }
        // fetch / web_fetch
        24 | 37 => {
            tool.input = args
                .as_deref()
                .map(|a| json_obj(&[("url", wire::first_str(a, 1))]));
        }
        _ => {}
    }

    tool
}

/// A task success's report text sits at a fixed depth:
/// `success.f1 (rich-text container) → .f1 (paragraph wrapper) → .f1 (text)`.
///
/// On the wire, `bytes` and an embedded message are the same type — a text
/// payload can be indistinguishable from a wrapper (e.g. `"\n#"` + exactly 35
/// bytes IS a complete field-1 frame), so no decoder can pick the layer count
/// from bytes alone. This walk fails toward the SAFE side: descending one
/// level only when the current field-1 payload cannot be the text itself
/// (not valid printable UTF-8) and decodes end-to-end as a message. A
/// layer-count drift then returns the full text or nothing — never a
/// truncated substring. Residual trade-off: a report short enough (< 128
/// bytes) for its wrapper frame to read as printable ASCII surfaces with a
/// two-byte prefix instead of descending — mangled-prefix beats truncation.
fn task_report_text(success: &[u8]) -> Option<String> {
    let mut layer: Vec<u8> = wire::first_message(success, 1)?;
    // Real schema is two wrapper hops; bound the walk defensively.
    for _ in 0..3 {
        let payload = wire::first_bytes(&layer, 1)?;
        if let Ok(text) = std::str::from_utf8(&payload) {
            if is_report_text(text) {
                return Some(text.to_string());
            }
        }
        if !wire::is_complete_message(&payload) {
            return None;
        }
        layer = payload;
    }
    None
}

/// Printable text (common whitespace allowed) with non-whitespace content —
/// the shape of a real report body, as opposed to a wrapper frame whose
/// length prefix usually injects control/invalid bytes.
fn is_report_text(s: &str) -> bool {
    !s.trim().is_empty()
        && s.chars()
            .all(|c| !c.is_control() || matches!(c, '\n' | '\r' | '\t'))
}

fn json_obj(entries: &[(&str, Option<String>)]) -> Value {
    let mut map = serde_json::Map::new();
    for (key, value) in entries {
        if let Some(v) = value {
            if !v.is_empty() {
                map.insert((*key).to_string(), Value::String(v.clone()));
            }
        }
    }
    Value::Object(map)
}

fn join_streams(stdout: &str, stderr: &str) -> Option<String> {
    match (stdout.is_empty(), stderr.is_empty()) {
        (true, true) => None,
        (false, true) => Some(stdout.to_string()),
        (true, false) => Some(stderr.to_string()),
        (false, false) => Some(format!("{stdout}\n{stderr}")),
    }
}

fn bounded_json_preview_ref(value: &Value) -> Option<String> {
    bounded_json_preview(value)
}

/// Serialize a tool input as VALID JSON bounded by `CURSOR_TOOL_INPUT_CAP`:
/// string values are truncated (structure preserved) and the per-string cap
/// halves until the whole serialized preview fits, so downstream `JSON.parse`
/// (e.g. the delegation card) always succeeds. Mirrors the Grok parser.
fn bounded_json_preview(value: &Value) -> Option<String> {
    if value.is_null() {
        return None;
    }
    let mut per_string = CURSOR_TOOL_INPUT_CAP;
    loop {
        let serialized = serde_json::to_string(&cap_json_string_values(value, per_string)).ok()?;
        if serialized.len() <= CURSOR_TOOL_INPUT_CAP || per_string == 0 {
            return Some(serialized);
        }
        per_string /= 2;
    }
}

fn cap_json_string_values(value: &Value, cap: usize) -> Value {
    match value {
        Value::String(s) => Value::String(truncate_str(s, cap)),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|v| cap_json_string_values(v, cap))
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), cap_json_string_values(v, cap)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// Immediate subdirectories of `dir` (non-recursive). Missing dir → empty.
fn read_subdirs(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // -- protobuf test encoder (writer mirror of the wire reader) -----------

    fn varint(mut v: u64, out: &mut Vec<u8>) {
        loop {
            let b = (v & 0x7f) as u8;
            v >>= 7;
            if v == 0 {
                out.push(b);
                break;
            }
            out.push(b | 0x80);
        }
    }

    fn field_varint(no: u32, v: u64, out: &mut Vec<u8>) {
        varint(u64::from(no) << 3, out);
        varint(v, out);
    }

    fn field_bytes(no: u32, data: &[u8], out: &mut Vec<u8>) {
        varint((u64::from(no) << 3) | 2, out);
        varint(data.len() as u64, out);
        out.extend_from_slice(data);
    }

    fn field_str(no: u32, s: &str, out: &mut Vec<u8>) {
        field_bytes(no, s.as_bytes(), out);
    }

    // -- fixture store builder ----------------------------------------------

    struct StoreBuilder {
        conn: Connection,
        next_id: u8,
    }

    impl StoreBuilder {
        fn create(path: &Path) -> Self {
            let conn = Connection::open(path).unwrap();
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, data BLOB);
                 CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
            )
            .unwrap();
            Self { conn, next_id: 1 }
        }

        fn put_blob(&mut self, data: &[u8]) -> Vec<u8> {
            let id = vec![0xab, 0xcd, self.next_id];
            self.next_id += 1;
            self.conn
                .execute(
                    "INSERT OR REPLACE INTO blobs (id, data) VALUES (?1, ?2)",
                    rusqlite::params![hex_encode(&id), data],
                )
                .unwrap();
            id
        }

        fn put_meta(&self, json: &Value) {
            let text = serde_json::to_string(json).unwrap();
            let hex = hex_encode(text.as_bytes());
            self.conn
                .execute(
                    "INSERT OR REPLACE INTO meta (key, value) VALUES ('0', ?1)",
                    [hex],
                )
                .unwrap();
        }
    }

    /// Build a chats/<md5>/<uuid>/store.db fixture with one agent turn
    /// (user prompt + thinking + text + shell tool + edit tool + mcp tool).
    fn build_fixture(root: &Path) -> (PathBuf, String) {
        let chat_id = "0198c9aa-1111-2222-3333-444455556666";
        let chat_dir = root
            .join("chats")
            .join("d41d8cd98f00b204e9800998ecf8427e")
            .join(chat_id);
        std::fs::create_dir_all(&chat_dir).unwrap();
        let mut store = StoreBuilder::create(&chat_dir.join("store.db"));

        // UserMessage { 1: text }
        let mut user_msg = Vec::new();
        field_str(1, "帮我构建项目", &mut user_msg);
        let user_id = store.put_blob(&user_msg);

        // Step: thinking
        let mut thinking = Vec::new();
        field_str(1, "Let me think", &mut thinking);
        let mut step_thinking = Vec::new();
        field_bytes(3, &thinking, &mut step_thinking);
        let step_thinking_id = store.put_blob(&step_thinking);

        // Step: assistant text
        let mut assistant = Vec::new();
        field_str(1, "好的，我来构建。", &mut assistant);
        let mut step_text = Vec::new();
        field_bytes(1, &assistant, &mut step_text);
        let step_text_id = store.put_blob(&step_text);

        // Step: shell tool call (success)
        let mut shell_args = Vec::new();
        field_str(1, "pnpm build", &mut shell_args);
        field_str(2, "/Users/me/proj", &mut shell_args);
        let mut shell_success = Vec::new();
        field_str(1, "pnpm build", &mut shell_success);
        field_varint(3, 0, &mut shell_success);
        field_str(5, "build ok", &mut shell_success);
        let mut shell_result = Vec::new();
        field_bytes(1, &shell_success, &mut shell_result);
        let mut shell_call = Vec::new();
        field_bytes(1, &shell_args, &mut shell_call);
        field_bytes(2, &shell_result, &mut shell_call);
        let mut tool_shell = Vec::new();
        field_bytes(1, &shell_call, &mut tool_shell);
        field_str(57, "tc-shell-1", &mut tool_shell);
        let mut step_shell = Vec::new();
        field_bytes(2, &tool_shell, &mut step_shell);
        let step_shell_id = store.put_blob(&step_shell);

        // Step: edit tool call (success with diff)
        let mut edit_args = Vec::new();
        field_str(1, "/Users/me/proj/src/app.ts", &mut edit_args);
        let mut edit_success = Vec::new();
        field_str(1, "/Users/me/proj/src/app.ts", &mut edit_success);
        field_str(5, "@@ -1 +1 @@\n-a\n+b", &mut edit_success);
        let mut edit_result = Vec::new();
        field_bytes(1, &edit_success, &mut edit_result);
        let mut edit_call = Vec::new();
        field_bytes(1, &edit_args, &mut edit_call);
        field_bytes(2, &edit_result, &mut edit_call);
        let mut tool_edit = Vec::new();
        field_bytes(12, &edit_call, &mut tool_edit);
        field_str(57, "tc-edit-1", &mut tool_edit);
        let mut step_edit = Vec::new();
        field_bytes(2, &tool_edit, &mut step_edit);
        let step_edit_id = store.put_blob(&step_edit);

        // Step: MCP tool call. `McpArgs.args` is map<string, Value>, so each
        // entry is one field-2 occurrence on McpArgs: {1: key, 2: Value}.
        let mut mcp_args = Vec::new();
        field_str(1, "delegate_to_agent", &mut mcp_args);
        for (key, text) in [("task", "run build"), ("agent_type", "codex")] {
            let mut value = Vec::new();
            field_str(3, text, &mut value);
            let mut entry = Vec::new();
            field_str(1, key, &mut entry);
            field_bytes(2, &value, &mut entry);
            field_bytes(2, &entry, &mut mcp_args);
        }
        field_str(5, "delegate_to_agent", &mut mcp_args);
        field_str(9, "codeg-mcp", &mut mcp_args);
        let mut mcp_text = Vec::new();
        field_str(1, "Delegation successful. task_id=42.", &mut mcp_text);
        let mut mcp_item = Vec::new();
        field_bytes(1, &mcp_text, &mut mcp_item);
        let mut mcp_success = Vec::new();
        field_bytes(1, &mcp_item, &mut mcp_success);
        let mut mcp_result = Vec::new();
        field_bytes(1, &mcp_success, &mut mcp_result);
        let mut mcp_call = Vec::new();
        field_bytes(1, &mcp_args, &mut mcp_call);
        field_bytes(2, &mcp_result, &mut mcp_call);
        let mut tool_mcp = Vec::new();
        field_bytes(15, &mcp_call, &mut tool_mcp);
        field_str(57, "tc-mcp-1", &mut tool_mcp);
        let mut step_mcp = Vec::new();
        field_bytes(2, &tool_mcp, &mut step_mcp);
        let step_mcp_id = store.put_blob(&step_mcp);

        // AgentConversationTurnStructure
        let mut agent_turn = Vec::new();
        field_bytes(1, &user_id, &mut agent_turn);
        for id in [&step_thinking_id, &step_text_id, &step_shell_id, &step_edit_id, &step_mcp_id] {
            field_bytes(2, id, &mut agent_turn);
        }
        let mut turn = Vec::new();
        field_bytes(1, &agent_turn, &mut turn);
        let turn_id = store.put_blob(&turn);

        // ConversationStateStructure
        let mut token_details = Vec::new();
        field_varint(1, 12_000, &mut token_details);
        field_varint(2, 200_000, &mut token_details);
        let mut timing = Vec::new();
        field_varint(1, 5_000, &mut timing);
        field_varint(2, 1_783_584_000_000, &mut timing);
        let mut repo = Vec::new();
        field_str(1, "/Users/me/proj", &mut repo);
        field_str(2, "main", &mut repo);
        let mut state = Vec::new();
        field_bytes(8, &turn_id, &mut state);
        field_bytes(5, &token_details, &mut state);
        field_bytes(14, &timing, &mut state);
        field_bytes(21, &repo, &mut state);
        field_varint(26, 1_783_583_999_000, &mut state);
        let root_id = store.put_blob(&state);

        store.put_meta(&serde_json::json!({
            "agentId": chat_id,
            "latestRootBlobId": hex_encode(&root_id),
            "name": "Build the project",
            "createdAt": 1_783_583_999_000_u64,
            "mode": "default",
            "lastUsedModel": "claude-opus-4.8",
        }));

        (root.join("chats"), chat_id.to_string())
    }

    #[test]
    fn lists_chat_with_metadata() {
        let tmp = tempfile::tempdir().unwrap();
        let (chats, chat_id) = build_fixture(tmp.path());
        let parser = CursorParser::with_base_dir(chats);
        let list = parser.list_conversations().unwrap();
        assert_eq!(list.len(), 1);
        let s = &list[0];
        assert_eq!(s.id, chat_id);
        assert_eq!(s.agent_type, AgentType::Cursor);
        assert_eq!(s.title.as_deref(), Some("Build the project"));
        assert_eq!(s.model.as_deref(), Some("claude-opus-4.8"));
        assert_eq!(s.folder_path.as_deref(), Some("/Users/me/proj"));
        assert_eq!(s.git_branch.as_deref(), Some("main"));
        assert!(s.ended_at.is_some());
    }

    #[test]
    fn decodes_turns_blocks_and_tools() {
        let tmp = tempfile::tempdir().unwrap();
        let (chats, chat_id) = build_fixture(tmp.path());
        let parser = CursorParser::with_base_dir(chats);
        let detail = parser.get_conversation(&chat_id).unwrap();
        assert_eq!(detail.turns.len(), 2);

        let user = &detail.turns[0];
        assert!(matches!(user.role, TurnRole::User));
        assert!(
            matches!(&user.blocks[0], ContentBlock::Text { text } if text == "帮我构建项目")
        );

        let assistant = &detail.turns[1];
        assert!(matches!(assistant.role, TurnRole::Assistant));
        assert_eq!(assistant.model.as_deref(), Some("claude-opus-4.8"));
        assert_eq!(assistant.duration_ms, Some(5_000));
        assert!(
            matches!(&assistant.blocks[0], ContentBlock::Thinking { text } if text == "Let me think")
        );
        assert!(
            matches!(&assistant.blocks[1], ContentBlock::Text { text } if text == "好的，我来构建。")
        );

        // shell tool: name/input/output/error state
        let shell_use = assistant
            .blocks
            .iter()
            .find_map(|b| match b {
                ContentBlock::ToolUse {
                    tool_name,
                    input_preview,
                    ..
                } if tool_name == "shell" => Some(input_preview.clone()),
                _ => None,
            })
            .expect("shell tool present");
        let input: Value = serde_json::from_str(&shell_use.unwrap()).unwrap();
        assert_eq!(
            input.get("command").and_then(Value::as_str),
            Some("pnpm build")
        );
        let shell_result = assistant
            .blocks
            .iter()
            .find_map(|b| match b {
                ContentBlock::ToolResult {
                    tool_use_id: Some(id),
                    output_preview,
                    is_error,
                    ..
                } if id == "tc-shell-1" => Some((output_preview.clone(), *is_error)),
                _ => None,
            })
            .expect("shell result present");
        assert_eq!(shell_result.0.as_deref(), Some("build ok"));
        assert!(!shell_result.1);

        // edit tool: diff is surfaced
        let edit_result = assistant
            .blocks
            .iter()
            .find_map(|b| match b {
                ContentBlock::ToolResult {
                    tool_use_id: Some(id),
                    output_preview,
                    ..
                } if id == "tc-edit-1" => Some(output_preview.clone()),
                _ => None,
            })
            .expect("edit result present");
        assert!(edit_result.unwrap().contains("@@ -1 +1 @@"));

        // MCP tool: server__tool name + struct args decoded to JSON
        let (mcp_name, mcp_input) = assistant
            .blocks
            .iter()
            .find_map(|b| match b {
                ContentBlock::ToolUse {
                    tool_use_id: Some(id),
                    tool_name,
                    input_preview,
                    ..
                } if id == "tc-mcp-1" => Some((tool_name.clone(), input_preview.clone())),
                _ => None,
            })
            .expect("mcp tool present");
        assert_eq!(mcp_name, "codeg-mcp__delegate_to_agent");
        let mcp_json: Value = serde_json::from_str(&mcp_input.unwrap()).unwrap();
        assert_eq!(mcp_json.get("task").and_then(Value::as_str), Some("run build"));
        assert_eq!(
            mcp_json.get("agent_type").and_then(Value::as_str),
            Some("codex")
        );
        let mcp_result = assistant
            .blocks
            .iter()
            .find_map(|b| match b {
                ContentBlock::ToolResult {
                    tool_use_id: Some(id),
                    output_preview,
                    ..
                } if id == "tc-mcp-1" => Some(output_preview.clone()),
                _ => None,
            })
            .expect("mcp result present");
        assert!(mcp_result.unwrap().contains("task_id=42"));

        // session stats: context ring from token_details
        let stats = detail.session_stats.expect("session stats");
        assert_eq!(stats.context_window_used_tokens, Some(12_000));
        assert_eq!(stats.context_window_max_tokens, Some(200_000));
    }

    #[test]
    fn skips_metadata_only_and_subagent_chats() {
        let tmp = tempfile::tempdir().unwrap();
        let chats = tmp.path().join("chats");

        // Metadata-only chat (no turns).
        let empty_dir = chats.join("aa").join("chat-empty");
        std::fs::create_dir_all(&empty_dir).unwrap();
        let mut store = StoreBuilder::create(&empty_dir.join("store.db"));
        let mut state = Vec::new();
        field_varint(26, 1_783_583_999_000, &mut state);
        let root_id = store.put_blob(&state);
        store.put_meta(&serde_json::json!({
            "agentId": "chat-empty",
            "latestRootBlobId": hex_encode(&root_id),
            "name": "Empty",
        }));

        // Sub-agent chat.
        let sub_dir = chats.join("aa").join("chat-sub");
        std::fs::create_dir_all(&sub_dir).unwrap();
        let mut sub_store = StoreBuilder::create(&sub_dir.join("store.db"));
        let mut sub_state = Vec::new();
        let mut turn = Vec::new();
        field_bytes(1, &[0x01], &mut turn);
        let turn_id = sub_store.put_blob(&turn);
        field_bytes(8, &turn_id, &mut sub_state);
        let sub_root = sub_store.put_blob(&sub_state);
        sub_store.put_meta(&serde_json::json!({
            "agentId": "chat-sub",
            "latestRootBlobId": hex_encode(&sub_root),
            "name": "Sub agent",
            "subagentInfo": {"parent": "chat-x"},
        }));

        let parser = CursorParser::with_base_dir(chats);
        assert!(parser.list_conversations().unwrap().is_empty());
    }

    /// Build an `acp-sessions/<uuid>/{store.db, meta.json}` fixture with one
    /// agent turn. `store_name` controls whether the store meta carries a
    /// `name` (the sidecar `title` is the fallback).
    fn build_acp_fixture(root: &Path, session_id: &str, store_name: Option<&str>) {
        let session_dir = root.join("acp-sessions").join(session_id);
        std::fs::create_dir_all(&session_dir).unwrap();
        let mut store = StoreBuilder::create(&session_dir.join("store.db"));

        let mut user_msg = Vec::new();
        field_str(1, "跑一下构建", &mut user_msg);
        let user_id = store.put_blob(&user_msg);
        let mut assistant = Vec::new();
        field_str(1, "好的。", &mut assistant);
        let mut step_text = Vec::new();
        field_bytes(1, &assistant, &mut step_text);
        let step_id = store.put_blob(&step_text);

        let mut agent_turn = Vec::new();
        field_bytes(1, &user_id, &mut agent_turn);
        field_bytes(2, &step_id, &mut agent_turn);
        let mut turn = Vec::new();
        field_bytes(1, &agent_turn, &mut turn);
        let turn_id = store.put_blob(&turn);

        let mut state = Vec::new();
        field_bytes(8, &turn_id, &mut state);
        field_varint(26, 1_784_000_000_000, &mut state);
        let root_id = store.put_blob(&state);

        let mut meta = serde_json::json!({
            "agentId": session_id,
            "latestRootBlobId": hex_encode(&root_id),
            "createdAt": 1_784_000_000_000_u64,
        });
        if let Some(name) = store_name {
            meta["name"] = Value::String(name.to_string());
        }
        store.put_meta(&meta);

        std::fs::write(
            session_dir.join("meta.json"),
            r#"{"schemaVersion":1,"cwd":"/Users/me/acp-proj","title":"Sidecar Title"}"#,
        )
        .unwrap();
    }

    #[test]
    fn lists_and_gets_acp_sessions_with_sidecar_meta() {
        let tmp = tempfile::tempdir().unwrap();
        let (chats, chat_id) = build_fixture(tmp.path());
        build_acp_fixture(tmp.path(), "acp-1111-2222", Some("Store Name"));
        build_acp_fixture(tmp.path(), "acp-3333-4444", None);

        let parser = CursorParser::with_base_dir(chats);
        let list = parser.list_conversations().unwrap();
        assert_eq!(list.len(), 3);

        let named = list.iter().find(|s| s.id == "acp-1111-2222").unwrap();
        // Sidecar cwd is authoritative for folder attribution (the DAG has no
        // git repo / workspace refs in this store)…
        assert_eq!(named.folder_path.as_deref(), Some("/Users/me/acp-proj"));
        // …while the store's own name wins over the sidecar title.
        assert_eq!(named.title.as_deref(), Some("Store Name"));

        let unnamed = list.iter().find(|s| s.id == "acp-3333-4444").unwrap();
        assert_eq!(unnamed.title.as_deref(), Some("Sidecar Title"));

        // The chats bucket is still scanned alongside the flat root.
        assert!(list.iter().any(|s| s.id == chat_id));

        // `get` resolves the flat `acp-sessions/<uuid>` layout directly.
        let detail = parser.get_conversation("acp-1111-2222").unwrap();
        assert_eq!(detail.turns.len(), 2);
        assert_eq!(
            detail.summary.folder_path.as_deref(),
            Some("/Users/me/acp-proj")
        );
    }

    #[test]
    fn decodes_task_tool_args_and_result() {
        let tmp = tempfile::tempdir().unwrap();
        let chats = tmp.path().join("chats");
        let chat_dir = chats.join("cc").join("chat-task");
        std::fs::create_dir_all(&chat_dir).unwrap();
        let mut store = StoreBuilder::create(&chat_dir.join("store.db"));

        let mut user_msg = Vec::new();
        field_str(1, "调用子智能体", &mut user_msg);
        let user_id = store.put_blob(&user_msg);

        // Successful task. subagent_type oneof: generalPurpose = empty
        // message at field 1; the report sits under two rich-text wrappers.
        let mut subagent = Vec::new();
        field_bytes(1, &[], &mut subagent);
        let mut args = Vec::new();
        field_str(1, "执行 pnpm build", &mut args);
        field_str(2, "在项目目录执行 pnpm build 并回报结果", &mut args);
        field_bytes(3, &subagent, &mut args);
        field_str(4, "default", &mut args);

        // The report deliberately starts with "\n#": '\n' reads as a field-1
        // length-delimited tag and '#' as length 35, so those bytes form a
        // plausible protobuf frame INSIDE the text — a naive descend walk
        // would truncate to 35 bytes. Longer than 128 bytes (like every real
        // report) so its wrapper's length prefix is a multi-byte varint that
        // can never read as printable UTF-8: the walk must take the full
        // two-hop path and return the text verbatim.
        let report_text = "\n# 构建结果\n\n退出码 0：共 3 个路由全部静态预渲染成功，\
                           无警告无错误，构建产物完整可用，总耗时约四十秒。";
        assert!(report_text.len() > 128, "report must use a two-byte length prefix");
        let mut report_inner = Vec::new();
        field_str(1, report_text, &mut report_inner);
        let mut report_wrap = Vec::new();
        field_bytes(1, &report_inner, &mut report_wrap);
        let mut success = Vec::new();
        field_bytes(1, &report_wrap, &mut success);
        field_str(2, "child-chat-uuid", &mut success);
        field_varint(4, 39_894, &mut success);
        let mut result_ok = Vec::new();
        field_bytes(1, &success, &mut result_ok);

        let mut task_ok = Vec::new();
        field_bytes(1, &args, &mut task_ok);
        field_bytes(2, &result_ok, &mut task_ok);
        let mut tool_ok = Vec::new();
        field_bytes(19, &task_ok, &mut tool_ok);
        field_str(57, "tc-task-ok", &mut tool_ok);
        let mut step_ok = Vec::new();
        field_bytes(2, &tool_ok, &mut step_ok);
        let step_ok_id = store.put_blob(&step_ok);

        // Failed task: args absent (the call never validated), result oneof
        // error {1: message}.
        let mut error = Vec::new();
        field_str(
            1,
            "Invalid arguments:\nsubagent_type: Invalid enum value.",
            &mut error,
        );
        let mut result_err = Vec::new();
        field_bytes(2, &error, &mut result_err);
        let mut task_err = Vec::new();
        field_bytes(2, &result_err, &mut task_err);
        let mut tool_err = Vec::new();
        field_bytes(19, &task_err, &mut tool_err);
        field_str(57, "tc-task-err", &mut tool_err);
        let mut step_err = Vec::new();
        field_bytes(2, &tool_err, &mut step_err);
        let step_err_id = store.put_blob(&step_err);

        let mut agent_turn = Vec::new();
        field_bytes(1, &user_id, &mut agent_turn);
        field_bytes(2, &step_err_id, &mut agent_turn);
        field_bytes(2, &step_ok_id, &mut agent_turn);
        let mut turn = Vec::new();
        field_bytes(1, &agent_turn, &mut turn);
        let turn_id = store.put_blob(&turn);
        let mut state = Vec::new();
        field_bytes(8, &turn_id, &mut state);
        let root_id = store.put_blob(&state);
        store.put_meta(&serde_json::json!({
            "agentId": "chat-task",
            "latestRootBlobId": hex_encode(&root_id),
            "name": "Task",
        }));

        let parser = CursorParser::with_base_dir(chats);
        let detail = parser.get_conversation("chat-task").unwrap();
        let assistant = &detail.turns[1];

        let (ok_name, ok_input) = assistant
            .blocks
            .iter()
            .find_map(|b| match b {
                ContentBlock::ToolUse {
                    tool_use_id: Some(id),
                    tool_name,
                    input_preview,
                    ..
                } if id == "tc-task-ok" => Some((tool_name.clone(), input_preview.clone())),
                _ => None,
            })
            .expect("ok task present");
        assert_eq!(ok_name, "task");
        let input: Value = serde_json::from_str(&ok_input.unwrap()).unwrap();
        assert_eq!(
            input.get("description").and_then(Value::as_str),
            Some("执行 pnpm build")
        );
        assert_eq!(
            input.get("subagent_type").and_then(Value::as_str),
            Some("generalPurpose")
        );
        assert_eq!(input.get("model").and_then(Value::as_str), Some("default"));

        let ok_result = assistant
            .blocks
            .iter()
            .find_map(|b| match b {
                ContentBlock::ToolResult {
                    tool_use_id: Some(id),
                    output_preview,
                    is_error,
                    ..
                } if id == "tc-task-ok" => Some((output_preview.clone(), *is_error)),
                _ => None,
            })
            .expect("ok result present");
        assert_eq!(
            ok_result.0.as_deref(),
            Some(
                "\n# 构建结果\n\n退出码 0：共 3 个路由全部静态预渲染成功，\
                 无警告无错误，构建产物完整可用，总耗时约四十秒。"
            )
        );
        assert!(!ok_result.1);

        let err_result = assistant
            .blocks
            .iter()
            .find_map(|b| match b {
                ContentBlock::ToolResult {
                    tool_use_id: Some(id),
                    output_preview,
                    is_error,
                    ..
                } if id == "tc-task-err" => Some((output_preview.clone(), *is_error)),
                _ => None,
            })
            .expect("err result present");
        assert!(err_result.0.unwrap().starts_with("Invalid arguments"));
        assert!(err_result.1);
    }

    #[test]
    fn task_report_missing_wrapper_returns_full_text() {
        // One wrapper layer missing upstream: success.f1 IS the paragraph
        // {f1: text}. The walk must recognize the payload as text (valid
        // printable UTF-8) and return it whole instead of descending into
        // its leading "\n#…" bytes and truncating.
        let text = "\n# 构建结果\n\n退出码 0：共 3 个路由静态预渲染成功，无警告，产物完整。";
        let mut paragraph = Vec::new();
        field_str(1, text, &mut paragraph);
        let mut success = Vec::new();
        field_bytes(1, &paragraph, &mut success);
        field_varint(4, 1_000, &mut success);
        assert_eq!(task_report_text(&success).as_deref(), Some(text));
    }

    #[test]
    fn task_report_exact_frame_text_is_not_truncated() {
        // Adversarial shape: the text IS a complete field-1 frame by itself
        // ('\n' = field-1 tag, '#' = length 35, exactly 35 bytes follow). On
        // the wire this is indistinguishable from one more wrapper layer —
        // the walk must still prefer the text reading and return all 37
        // bytes, not the 35-byte "payload".
        let text = format!("\n#{}", "a".repeat(35));
        let mut paragraph = Vec::new();
        field_str(1, &text, &mut paragraph);
        let mut success = Vec::new();
        field_bytes(1, &paragraph, &mut success);
        assert_eq!(task_report_text(&success).as_deref(), Some(text.as_str()));
    }

    #[test]
    fn incomplete_trailing_varint_is_not_a_complete_message() {
        // A parse failure can advance the cursor to the exact buffer end
        // (truncated trailing varint) — `consumed == len` alone would
        // misreport completeness; the malformed flag must reject it.
        assert!(wire::is_complete_message(b"\x08\x96\x01")); // f1 varint 150
        assert!(!wire::is_complete_message(b"\x08\x96")); // truncated varint
    }

    #[test]
    fn reads_store_whose_content_sits_in_the_wal() {
        // Cursor keeps live stores in WAL mode with most pages still in the
        // `-wal` file (a real ACP store measured 4KB main / 436KB wal). The
        // read-only open must see those pages while the CLI's own writer
        // connection is still alive.
        let tmp = tempfile::tempdir().unwrap();
        let chats = tmp.path().join("chats");
        let chat_dir = chats.join("ee").join("chat-wal");
        std::fs::create_dir_all(&chat_dir).unwrap();

        let mut store = StoreBuilder::create(&chat_dir.join("store.db"));
        store
            .conn
            .pragma_update(None, "journal_mode", "wal")
            .unwrap();

        // All content written AFTER the WAL switch stays in the -wal file
        // until a checkpoint (which never runs while `store` stays alive).
        let mut user_msg = Vec::new();
        field_str(1, "wal 里的提问", &mut user_msg);
        let user_id = store.put_blob(&user_msg);
        let mut assistant = Vec::new();
        field_str(1, "wal 里的回答", &mut assistant);
        let mut step = Vec::new();
        field_bytes(1, &assistant, &mut step);
        let step_id = store.put_blob(&step);
        let mut agent_turn = Vec::new();
        field_bytes(1, &user_id, &mut agent_turn);
        field_bytes(2, &step_id, &mut agent_turn);
        let mut turn = Vec::new();
        field_bytes(1, &agent_turn, &mut turn);
        let turn_id = store.put_blob(&turn);
        let mut state = Vec::new();
        field_bytes(8, &turn_id, &mut state);
        let root_id = store.put_blob(&state);
        store.put_meta(&serde_json::json!({
            "agentId": "chat-wal",
            "latestRootBlobId": hex_encode(&root_id),
            "name": "WAL chat",
        }));
        assert!(
            chat_dir.join("store.db-wal").metadata().unwrap().len() > 0,
            "fixture must keep its pages in the wal"
        );

        let parser = CursorParser::with_base_dir(chats);
        let detail = parser.get_conversation("chat-wal").unwrap();
        assert_eq!(detail.turns.len(), 2);
        assert!(matches!(
            &detail.turns[0].blocks[0],
            ContentBlock::Text { text } if text == "wal 里的提问"
        ));
        drop(store);
    }

    #[test]
    fn missing_conversation_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let (chats, _) = build_fixture(tmp.path());
        let parser = CursorParser::with_base_dir(chats);
        assert!(matches!(
            parser.get_conversation("does-not-exist"),
            Err(ParseError::ConversationNotFound(_))
        ));
    }

    #[test]
    fn honors_cursor_config_dir_env() {
        // CURSOR_CONFIG_DIR wins over everything.
        let dir = resolve_cursor_config_from(
            Some("/custom/cursor".into()),
            Some("/xdg".into()),
            Some("/home/me".into()),
        );
        assert_eq!(dir, PathBuf::from("/custom/cursor"));
        // XDG_CONFIG_HOME/cursor is the CLI's second stop.
        let xdg = resolve_cursor_config_from(None, Some("/xdg".into()), Some("/home/me".into()));
        assert_eq!(xdg, PathBuf::from("/xdg/cursor"));
        let fallback = resolve_cursor_config_from(None, None, Some("/home/me".into()));
        assert_eq!(fallback, PathBuf::from("/home/me/.cursor"));
    }

    #[test]
    fn shell_conversation_turn_renders_command_card() {
        let tmp = tempfile::tempdir().unwrap();
        let chats = tmp.path().join("chats");
        let chat_dir = chats.join("bb").join("chat-shell");
        std::fs::create_dir_all(&chat_dir).unwrap();
        let mut store = StoreBuilder::create(&chat_dir.join("store.db"));

        let mut cmd = Vec::new();
        field_str(1, "ls -la", &mut cmd);
        let cmd_id = store.put_blob(&cmd);
        let mut output = Vec::new();
        field_str(1, "total 8", &mut output);
        field_varint(3, 0, &mut output);
        let out_id = store.put_blob(&output);
        let mut shell_turn = Vec::new();
        field_bytes(1, &cmd_id, &mut shell_turn);
        field_bytes(2, &out_id, &mut shell_turn);
        let mut turn = Vec::new();
        field_bytes(2, &shell_turn, &mut turn);
        let turn_id = store.put_blob(&turn);
        let mut state = Vec::new();
        field_bytes(8, &turn_id, &mut state);
        let root_id = store.put_blob(&state);
        store.put_meta(&serde_json::json!({
            "agentId": "chat-shell",
            "latestRootBlobId": hex_encode(&root_id),
            "name": "Shell",
        }));

        let parser = CursorParser::with_base_dir(chats);
        let detail = parser.get_conversation("chat-shell").unwrap();
        assert_eq!(detail.turns.len(), 2);
        assert!(matches!(
            &detail.turns[0].blocks[0],
            ContentBlock::Text { text } if text == "! ls -la"
        ));
        let result = detail.turns[1]
            .blocks
            .iter()
            .find_map(|b| match b {
                ContentBlock::ToolResult { output_preview, .. } => output_preview.clone(),
                _ => None,
            })
            .expect("shell output present");
        assert_eq!(result, "total 8");
    }

    /// ACP-written stores carry no root `turn_timings` and no
    /// `lastUsedModel`; the turn clock must come from the tool calls'
    /// started/ended stamps (ToolCall fields 59/60).
    #[test]
    fn synthesizes_turn_clock_from_tool_call_stamps() {
        let tmp = tempfile::tempdir().unwrap();
        let session_dir = tmp.path().join("acp-sessions").join("acp-clock-1");
        std::fs::create_dir_all(&session_dir).unwrap();
        let mut store = StoreBuilder::create(&session_dir.join("store.db"));

        let mut user_msg = Vec::new();
        field_str(1, "构建", &mut user_msg);
        let user_id = store.put_blob(&user_msg);

        let mut shell_args = Vec::new();
        field_str(1, "pnpm build", &mut shell_args);
        let mut shell_call = Vec::new();
        field_bytes(1, &shell_args, &mut shell_call);

        // A failed-fast tool call carrying only the end stamp…
        let mut tool_a = Vec::new();
        field_bytes(1, &shell_call, &mut tool_a);
        field_varint(60, 1_784_000_010_000, &mut tool_a);
        let mut step_a = Vec::new();
        field_bytes(2, &tool_a, &mut step_a);
        let step_a_id = store.put_blob(&step_a);

        // …and a successful one with both stamps.
        let mut tool_b = Vec::new();
        field_bytes(1, &shell_call, &mut tool_b);
        field_str(57, "tc-b", &mut tool_b);
        field_varint(59, 1_784_000_012_000, &mut tool_b);
        field_varint(60, 1_784_000_052_000, &mut tool_b);
        let mut step_b = Vec::new();
        field_bytes(2, &tool_b, &mut step_b);
        let step_b_id = store.put_blob(&step_b);

        // Closing text step — carries no clock.
        let mut assistant = Vec::new();
        field_str(1, "完成。", &mut assistant);
        let mut step_text = Vec::new();
        field_bytes(1, &assistant, &mut step_text);
        let step_text_id = store.put_blob(&step_text);

        let mut agent_turn = Vec::new();
        field_bytes(1, &user_id, &mut agent_turn);
        for id in [&step_a_id, &step_b_id, &step_text_id] {
            field_bytes(2, id, &mut agent_turn);
        }
        let mut turn = Vec::new();
        field_bytes(1, &agent_turn, &mut turn);
        let turn_id = store.put_blob(&turn);

        // Root without field 14 (turn_timings), as ACP stores are written.
        let mut state = Vec::new();
        field_bytes(8, &turn_id, &mut state);
        field_varint(26, 1_784_000_000_000, &mut state);
        let root_id = store.put_blob(&state);
        store.put_meta(&serde_json::json!({
            "agentId": "acp-clock-1",
            "latestRootBlobId": hex_encode(&root_id),
            "createdAt": 1_784_000_000_000_u64,
        }));

        let parser = CursorParser::with_base_dir(tmp.path().join("chats"));
        let detail = parser.get_conversation("acp-clock-1").unwrap();
        assert_eq!(detail.turns.len(), 2);

        // Turn timestamp = the earliest tool stamp, not the meta createdAt.
        let user = &detail.turns[0];
        assert_eq!(user.timestamp.timestamp_millis(), 1_784_000_010_000);

        // Span folds both stamp kinds across every tool call in the turn.
        let assistant = &detail.turns[1];
        assert_eq!(assistant.duration_ms, Some(42_000));
        assert_eq!(
            assistant.completed_at.map(|t| t.timestamp_millis()),
            Some(1_784_000_052_000)
        );
        // Cursor records no per-turn token usage; the field stays honest.
        assert!(assistant.usage.is_none());
    }

    /// Builds one tool-free `[user text → assistant text]` DAG turn and
    /// returns its blob id. No tool steps → no `f59`/`f60` → natively
    /// clockless (the case codeg's timing journal exists for).
    fn put_text_only_turn(store: &mut StoreBuilder, user_text: &str, reply: &str) -> Vec<u8> {
        let mut user_msg = Vec::new();
        field_str(1, user_text, &mut user_msg);
        let user_id = store.put_blob(&user_msg);
        let mut assistant = Vec::new();
        field_str(1, reply, &mut assistant);
        let mut step_text = Vec::new();
        field_bytes(1, &assistant, &mut step_text);
        let step_id = store.put_blob(&step_text);
        let mut agent_turn = Vec::new();
        field_bytes(1, &user_id, &mut agent_turn);
        field_bytes(2, &step_id, &mut agent_turn);
        let mut turn = Vec::new();
        field_bytes(1, &agent_turn, &mut turn);
        store.put_blob(&turn)
    }

    /// Tool-free turns have no clock anywhere in the store (no root
    /// `turn_timings`, no tool stamps, no message timestamps — verified on
    /// real ACP sessions). codeg's own turn-span journal fills them, and the
    /// alignment is tail-anchored: a leading turn recorded before the journal
    /// feature existed stays honestly clockless.
    #[test]
    fn fills_tool_free_turn_clock_from_timing_journal() {
        let tmp = tempfile::tempdir().unwrap();
        let session_dir = tmp.path().join("acp-sessions").join("acp-journal-1");
        std::fs::create_dir_all(&session_dir).unwrap();
        let mut store = StoreBuilder::create(&session_dir.join("store.db"));

        let turn_a = put_text_only_turn(&mut store, "旧问题", "旧回答");
        let turn_b = put_text_only_turn(&mut store, "这是什么", "这是一张图。");

        let mut state = Vec::new();
        field_bytes(8, &turn_a, &mut state);
        field_bytes(8, &turn_b, &mut state);
        let root_id = store.put_blob(&state);
        store.put_meta(&serde_json::json!({
            "agentId": "acp-journal-1",
            "latestRootBlobId": hex_encode(&root_id),
            "createdAt": 1_784_000_000_000_u64,
        }));

        // Journal covers only the TAIL turn — the leading one predates the
        // feature.
        crate::turn_timings::append_turn_timing_in(
            &tmp.path().join("turn-timings"),
            crate::turn_timings::CURSOR_JOURNAL_AGENT,
            "acp-journal-1",
            &crate::turn_timings::TurnTiming {
                v: crate::turn_timings::TURN_TIMING_SCHEMA_VERSION,
                ord: 1,
                conn: "conn-1".into(),
                prompt_sha: crate::turn_timings::prompt_hash("这是什么"),
                started_at_ms: 1_784_000_100_000,
                ended_at_ms: 1_784_000_107_500,
            },
        );

        let parser = CursorParser::with_base_dir(tmp.path().join("chats"));
        let detail = parser.get_conversation("acp-journal-1").unwrap();
        assert_eq!(detail.turns.len(), 4);

        // Tail turn: the journal supplies the span and upgrades the fallback
        // (meta createdAt) timestamps to the observed send time.
        assert_eq!(
            detail.turns[2].timestamp.timestamp_millis(),
            1_784_000_100_000
        );
        let b = &detail.turns[3];
        assert_eq!(b.duration_ms, Some(7_500));
        assert_eq!(
            b.completed_at.map(|t| t.timestamp_millis()),
            Some(1_784_000_107_500)
        );
        assert_eq!(b.timestamp.timestamp_millis(), 1_784_000_100_000);

        // Leading pre-journal turn: honestly clockless.
        let a = &detail.turns[1];
        assert!(a.duration_ms.is_none());
        assert!(a.completed_at.is_none());
        assert_eq!(
            detail.turns[0].timestamp.timestamp_millis(),
            1_784_000_000_000
        );
    }

    /// A routed or briefed prompt reaches Cursor with codeg's internal frames
    /// appended after the user's text, while the connection journaled the hash
    /// of the user's text alone. The pairing must see through the frames —
    /// whatever Cursor put between the prompt's blocks — or every such turn
    /// loses its clock.
    #[test]
    fn a_turn_carrying_internal_frames_still_pairs_with_its_journal_line() {
        use crate::acp::agent_mentions::{
            append_agent_routes, append_assistant_routes, render_assistant_brief,
        };
        use crate::acp::types::PromptInputBlock;

        let visible = "ask [@Codex](codeg://agent/codex) and [@Reviewer](codeg://assistant/3) ";
        let mut prompt = vec![PromptInputBlock::Text {
            text: visible.into(),
        }];
        append_agent_routes(&mut prompt, true);
        append_assistant_routes(&mut prompt, true);
        prompt.push(PromptInputBlock::Text {
            text: render_assistant_brief("Reviewer", "Cite line numbers.").unwrap(),
        });
        let parts: Vec<String> = prompt
            .iter()
            .map(|b| match b {
                PromptInputBlock::Text { text } => text.clone(),
                _ => unreachable!(),
            })
            .collect();
        assert_eq!(parts.len(), 4, "the fixture must carry every frame kind");

        for joiner in ["", "\n", "\n\n", " "] {
            let tmp = tempfile::tempdir().unwrap();
            let session_dir = tmp.path().join("acp-sessions").join("acp-frames");
            std::fs::create_dir_all(&session_dir).unwrap();
            let mut store = StoreBuilder::create(&session_dir.join("store.db"));
            let turn = put_text_only_turn(&mut store, &parts.join(joiner), "done");
            let mut state = Vec::new();
            field_bytes(8, &turn, &mut state);
            let root_id = store.put_blob(&state);
            store.put_meta(&serde_json::json!({
                "agentId": "acp-frames",
                "latestRootBlobId": hex_encode(&root_id),
                "createdAt": 1_784_000_000_000_u64,
            }));
            crate::turn_timings::append_turn_timing_in(
                &tmp.path().join("turn-timings"),
                crate::turn_timings::CURSOR_JOURNAL_AGENT,
                "acp-frames",
                &crate::turn_timings::TurnTiming {
                    v: crate::turn_timings::TURN_TIMING_SCHEMA_VERSION,
                    ord: 1,
                    conn: "conn-1".into(),
                    // What the connection hashes: the user's own text blocks.
                    prompt_sha: crate::turn_timings::prompt_hash(visible),
                    started_at_ms: 1_784_000_100_000,
                    ended_at_ms: 1_784_000_104_000,
                },
            );

            let parser = crate::parsers::sanitized(CursorParser::with_base_dir(
                tmp.path().join("chats"),
            ));
            let detail = parser.get_conversation("acp-frames").unwrap();
            assert_eq!(
                detail.turns[1].duration_ms,
                Some(4_000),
                "joiner {joiner:?} must still pair"
            );
            let ContentBlock::Text { text } = &detail.turns[0].blocks[0] else {
                panic!("user text");
            };
            assert_eq!(text, visible.trim_end(), "the frames are gone from the bubble");
        }
    }

    /// Builds one `[user text → shell tool (f59/f60 stamps) → assistant
    /// text]` DAG turn and returns its blob id. The tool stamps give the
    /// turn a tool-span fallback clock (the case the journal must REPLACE,
    /// not fill).
    fn put_tool_turn(
        store: &mut StoreBuilder,
        user_text: &str,
        tool_started_ms: u64,
        tool_ended_ms: u64,
    ) -> Vec<u8> {
        let mut user_msg = Vec::new();
        field_str(1, user_text, &mut user_msg);
        let user_id = store.put_blob(&user_msg);

        let mut shell_args = Vec::new();
        field_str(1, "pnpm build", &mut shell_args);
        let mut shell_call = Vec::new();
        field_bytes(1, &shell_args, &mut shell_call);
        let mut tool = Vec::new();
        field_bytes(1, &shell_call, &mut tool);
        field_str(57, "tc-span", &mut tool);
        field_varint(59, tool_started_ms, &mut tool);
        field_varint(60, tool_ended_ms, &mut tool);
        let mut step_tool = Vec::new();
        field_bytes(2, &tool, &mut step_tool);
        let step_tool_id = store.put_blob(&step_tool);

        let mut assistant = Vec::new();
        field_str(1, "构建完成。", &mut assistant);
        let mut step_text = Vec::new();
        field_bytes(1, &assistant, &mut step_text);
        let step_text_id = store.put_blob(&step_text);

        let mut agent_turn = Vec::new();
        field_bytes(1, &user_id, &mut agent_turn);
        for id in [&step_tool_id, &step_text_id] {
            field_bytes(2, id, &mut agent_turn);
        }
        let mut turn = Vec::new();
        field_bytes(1, &agent_turn, &mut turn);
        store.put_blob(&turn)
    }

    /// Real-device bug (session 118b6805): a 16s turn whose only clock was a
    /// sub-second tool span rendered "0 秒". A matched journal line REPLACES
    /// the tool-span fallback — the span covers first-tool-start →
    /// last-tool-end only, while the journal measured the full
    /// prompt→`end_turn` wall span at the connection.
    #[test]
    fn journal_replaces_tool_span_fallback_clock() {
        let tmp = tempfile::tempdir().unwrap();
        let session_dir = tmp.path().join("acp-sessions").join("acp-journal-span-1");
        std::fs::create_dir_all(&session_dir).unwrap();
        let mut store = StoreBuilder::create(&session_dir.join("store.db"));

        let turn = put_tool_turn(&mut store, "构建", 1_784_000_012_000, 1_784_000_012_600);
        let mut state = Vec::new();
        field_bytes(8, &turn, &mut state);
        let root_id = store.put_blob(&state);
        store.put_meta(&serde_json::json!({
            "agentId": "acp-journal-span-1",
            "latestRootBlobId": hex_encode(&root_id),
            "createdAt": 1_784_000_000_000_u64,
        }));

        crate::turn_timings::append_turn_timing_in(
            &tmp.path().join("turn-timings"),
            crate::turn_timings::CURSOR_JOURNAL_AGENT,
            "acp-journal-span-1",
            &crate::turn_timings::TurnTiming {
                v: crate::turn_timings::TURN_TIMING_SCHEMA_VERSION,
                ord: 1,
                conn: "conn-1".into(),
                prompt_sha: crate::turn_timings::prompt_hash("构建"),
                started_at_ms: 1_784_000_006_000,
                ended_at_ms: 1_784_000_022_000,
            },
        );

        let parser = CursorParser::with_base_dir(tmp.path().join("chats"));
        let detail = parser.get_conversation("acp-journal-span-1").unwrap();
        assert_eq!(detail.turns.len(), 2);

        let assistant = &detail.turns[1];
        assert_eq!(assistant.duration_ms, Some(16_000));
        assert_eq!(
            assistant.completed_at.map(|t| t.timestamp_millis()),
            Some(1_784_000_022_000)
        );
        // Both siblings' timestamps upgrade from first-tool-start to the
        // observed prompt send time.
        assert_eq!(
            detail.turns[0].timestamp.timestamp_millis(),
            1_784_000_006_000
        );
        assert_eq!(assistant.timestamp.timestamp_millis(), 1_784_000_006_000);
    }

    /// Store-native root `turn_timings` (IDE-written chats) stay
    /// authoritative: a matched journal line only corroborates, never
    /// overwrites.
    #[test]
    fn journal_never_overrides_store_native_root_timing() {
        let tmp = tempfile::tempdir().unwrap();
        let session_dir = tmp.path().join("acp-sessions").join("acp-journal-native-1");
        std::fs::create_dir_all(&session_dir).unwrap();
        let mut store = StoreBuilder::create(&session_dir.join("store.db"));

        let turn = put_text_only_turn(&mut store, "构建", "完成。");
        let mut timing = Vec::new();
        field_varint(1, 5_000, &mut timing);
        field_varint(2, 1_784_000_000_000, &mut timing);
        let mut state = Vec::new();
        field_bytes(8, &turn, &mut state);
        field_bytes(14, &timing, &mut state);
        let root_id = store.put_blob(&state);
        store.put_meta(&serde_json::json!({
            "agentId": "acp-journal-native-1",
            "latestRootBlobId": hex_encode(&root_id),
            "createdAt": 1_784_000_000_000_u64,
        }));

        crate::turn_timings::append_turn_timing_in(
            &tmp.path().join("turn-timings"),
            crate::turn_timings::CURSOR_JOURNAL_AGENT,
            "acp-journal-native-1",
            &crate::turn_timings::TurnTiming {
                v: crate::turn_timings::TURN_TIMING_SCHEMA_VERSION,
                ord: 1,
                conn: "conn-1".into(),
                prompt_sha: crate::turn_timings::prompt_hash("构建"),
                started_at_ms: 1_784_000_100_000,
                ended_at_ms: 1_784_000_116_000,
            },
        );

        let parser = CursorParser::with_base_dir(tmp.path().join("chats"));
        let detail = parser.get_conversation("acp-journal-native-1").unwrap();
        assert_eq!(detail.turns.len(), 2);

        let assistant = &detail.turns[1];
        assert_eq!(assistant.duration_ms, Some(5_000));
        assert_eq!(
            assistant.completed_at.map(|t| t.timestamp_millis()),
            Some(1_784_000_005_000)
        );
        assert_eq!(
            detail.turns[0].timestamp.timestamp_millis(),
            1_784_000_000_000
        );
    }

    /// A degenerate journal line (zero span — no duration to offer, and
    /// unable to bracket a real tool span) never erases an existing
    /// tool-span fallback clock.
    #[test]
    fn degenerate_journal_line_keeps_tool_span_clock() {
        let tmp = tempfile::tempdir().unwrap();
        let session_dir = tmp.path().join("acp-sessions").join("acp-journal-degen-1");
        std::fs::create_dir_all(&session_dir).unwrap();
        let mut store = StoreBuilder::create(&session_dir.join("store.db"));

        let turn = put_tool_turn(&mut store, "构建", 1_784_000_012_000, 1_784_000_052_000);
        let mut state = Vec::new();
        field_bytes(8, &turn, &mut state);
        let root_id = store.put_blob(&state);
        store.put_meta(&serde_json::json!({
            "agentId": "acp-journal-degen-1",
            "latestRootBlobId": hex_encode(&root_id),
            "createdAt": 1_784_000_000_000_u64,
        }));

        crate::turn_timings::append_turn_timing_in(
            &tmp.path().join("turn-timings"),
            crate::turn_timings::CURSOR_JOURNAL_AGENT,
            "acp-journal-degen-1",
            &crate::turn_timings::TurnTiming {
                v: crate::turn_timings::TURN_TIMING_SCHEMA_VERSION,
                ord: 1,
                conn: "conn-1".into(),
                prompt_sha: crate::turn_timings::prompt_hash("构建"),
                started_at_ms: 1_784_000_060_000,
                ended_at_ms: 1_784_000_060_000,
            },
        );

        let parser = CursorParser::with_base_dir(tmp.path().join("chats"));
        let detail = parser.get_conversation("acp-journal-degen-1").unwrap();
        assert_eq!(detail.turns.len(), 2);

        let assistant = &detail.turns[1];
        assert_eq!(assistant.duration_ms, Some(40_000));
        assert_eq!(
            assistant.completed_at.map(|t| t.timestamp_millis()),
            Some(1_784_000_052_000)
        );
        // Timestamps keep the tool-span fallback too — the guard bails
        // before any field is touched.
        assert_eq!(
            detail.turns[0].timestamp.timestamp_millis(),
            1_784_000_012_000
        );
    }

    /// Codex-review scenario: the documented missing-suffix residual pairs a
    /// STALE line (recorded for an older identical prompt) with the store's
    /// newest turn. When that turn carries a tool-span clock, the stale line
    /// — which ended before this turn's tools even started — must not
    /// replace it: the containment guard rejects any line that doesn't
    /// bracket the existing span. (Clockless turns have no clock to lose;
    /// for them the residual stands, pinned by
    /// `accepted_residual_missing_tail_lines_can_misattribute_span`.)
    #[test]
    fn stale_journal_line_never_overrides_tool_span_clock() {
        let tmp = tempfile::tempdir().unwrap();
        let session_dir = tmp.path().join("acp-sessions").join("acp-journal-stale-1");
        std::fs::create_dir_all(&session_dir).unwrap();
        let mut store = StoreBuilder::create(&session_dir.join("store.db"));

        // Same prompt text at the head and the tail; a different one between,
        // so the same-hash run-length guard sees 1:1 runs at the tail.
        let turn_a = put_text_only_turn(&mut store, "构建", "第一次构建完成。");
        let turn_b = put_text_only_turn(&mut store, "解释", "解释如下。");
        let turn_c = put_tool_turn(&mut store, "构建", 1_784_000_012_000, 1_784_000_052_000);
        let mut state = Vec::new();
        for t in [&turn_a, &turn_b, &turn_c] {
            field_bytes(8, t, &mut state);
        }
        let root_id = store.put_blob(&state);
        store.put_meta(&serde_json::json!({
            "agentId": "acp-journal-stale-1",
            "latestRootBlobId": hex_encode(&root_id),
            "createdAt": 1_784_000_000_000_u64,
        }));

        // The only surviving line measured turn A (long before turn C's
        // tools); B's and C's lines were lost — the residual precondition.
        crate::turn_timings::append_turn_timing_in(
            &tmp.path().join("turn-timings"),
            crate::turn_timings::CURSOR_JOURNAL_AGENT,
            "acp-journal-stale-1",
            &crate::turn_timings::TurnTiming {
                v: crate::turn_timings::TURN_TIMING_SCHEMA_VERSION,
                ord: 1,
                conn: "conn-1".into(),
                prompt_sha: crate::turn_timings::prompt_hash("构建"),
                started_at_ms: 1_784_000_000_500,
                ended_at_ms: 1_784_000_001_500,
            },
        );

        let parser = CursorParser::with_base_dir(tmp.path().join("chats"));
        let detail = parser.get_conversation("acp-journal-stale-1").unwrap();
        assert_eq!(detail.turns.len(), 6);

        // Tail turn keeps its own (partial but honest) tool-span clock.
        let c = &detail.turns[5];
        assert_eq!(c.duration_ms, Some(40_000));
        assert_eq!(
            c.completed_at.map(|t| t.timestamp_millis()),
            Some(1_784_000_052_000)
        );
        assert_eq!(
            detail.turns[4].timestamp.timestamp_millis(),
            1_784_000_012_000
        );

        // Earlier turns stay untouched (the walk never reaches them).
        assert!(detail.turns[1].duration_ms.is_none());
        assert!(detail.turns[3].duration_ms.is_none());
    }

    /// Codex-review scenario: the journal's same-hash run is LONGER than the
    /// store's (an identical prompt whose turn the store didn't keep). Counts
    /// are equal overall, so only the run-length equality guard stands
    /// between the walk and handing the wrong span to the older identical
    /// prompt — it must stop and assign nothing.
    #[test]
    fn journal_longer_duplicate_run_assigns_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let session_dir = tmp.path().join("acp-sessions").join("acp-journal-3");
        std::fs::create_dir_all(&session_dir).unwrap();
        let mut store = StoreBuilder::create(&session_dir.join("store.db"));

        // Store: [ "x", "重试" ] — journal: 2 × "重试" (equal counts, so the
        // count guard passes; ordinals contiguous, so the trim keeps both).
        let turn_a = put_text_only_turn(&mut store, "x", "好的");
        let turn_b = put_text_only_turn(&mut store, "重试", "再来");
        let mut state = Vec::new();
        field_bytes(8, &turn_a, &mut state);
        field_bytes(8, &turn_b, &mut state);
        let root_id = store.put_blob(&state);
        store.put_meta(&serde_json::json!({
            "agentId": "acp-journal-3",
            "latestRootBlobId": hex_encode(&root_id),
            "createdAt": 1_784_000_000_000_u64,
        }));

        for (ord, start, end) in [
            (1_u64, 1_784_000_100_000_u64, 1_784_000_105_000_u64),
            (2, 1_784_000_200_000, 1_784_000_200_800),
        ] {
            crate::turn_timings::append_turn_timing_in(
                &tmp.path().join("turn-timings"),
                crate::turn_timings::CURSOR_JOURNAL_AGENT,
                "acp-journal-3",
                &crate::turn_timings::TurnTiming {
                    v: crate::turn_timings::TURN_TIMING_SCHEMA_VERSION,
                    ord,
                    conn: "conn-1".into(),
                    prompt_sha: crate::turn_timings::prompt_hash("重试"),
                    started_at_ms: start,
                    ended_at_ms: end,
                },
            );
        }

        let parser = CursorParser::with_base_dir(tmp.path().join("chats"));
        let detail = parser.get_conversation("acp-journal-3").unwrap();
        for turn in &detail.turns {
            assert!(
                turn.duration_ms.is_none() && turn.completed_at.is_none(),
                "ambiguous duplicate run must degrade to no clock, not a wrong one"
            );
        }
    }

    /// Codex re-review scenario: a stalled (timeout-abandoned) append for
    /// turn A lands AFTER turn B's line, so the journal order is [B, A] while
    /// the store order is [A, B]. The two same-hash runs have EQUAL length,
    /// so the run guard alone would pair them swapped — the reader's order
    /// gate must reject the whole journal so nothing is assigned. No turn
    /// may wear the other's span.
    #[test]
    fn journal_reordered_equal_hash_run_never_swaps_spans() {
        let tmp = tempfile::tempdir().unwrap();
        let session_dir = tmp.path().join("acp-sessions").join("acp-journal-5");
        std::fs::create_dir_all(&session_dir).unwrap();
        let mut store = StoreBuilder::create(&session_dir.join("store.db"));

        let turn_a = put_text_only_turn(&mut store, "重试", "第一次");
        let turn_b = put_text_only_turn(&mut store, "重试", "第二次");
        let mut state = Vec::new();
        field_bytes(8, &turn_a, &mut state);
        field_bytes(8, &turn_b, &mut state);
        let root_id = store.put_blob(&state);
        store.put_meta(&serde_json::json!({
            "agentId": "acp-journal-5",
            "latestRootBlobId": hex_encode(&root_id),
            "createdAt": 1_784_000_000_000_u64,
        }));

        // Journal lines in REORDERED (landing) order: B first, then stalled A.
        for (ord, start, end) in [
            (2_u64, 1_784_000_200_000_u64, 1_784_000_209_000_u64), // turn B's span
            (1, 1_784_000_100_000, 1_784_000_104_000),             // turn A's late span
        ] {
            crate::turn_timings::append_turn_timing_in(
                &tmp.path().join("turn-timings"),
                crate::turn_timings::CURSOR_JOURNAL_AGENT,
                "acp-journal-5",
                &crate::turn_timings::TurnTiming {
                    v: crate::turn_timings::TURN_TIMING_SCHEMA_VERSION,
                    ord,
                    conn: "conn-1".into(),
                    prompt_sha: crate::turn_timings::prompt_hash("重试"),
                    started_at_ms: start,
                    ended_at_ms: end,
                },
            );
        }

        let parser = CursorParser::with_base_dir(tmp.path().join("chats"));
        let detail = parser.get_conversation("acp-journal-5").unwrap();
        // The order gate rejects the whole journal → all clockless.
        for turn in &detail.turns {
            assert!(
                turn.duration_ms.is_none() && turn.completed_at.is_none(),
                "a reordered journal must never assign swapped spans"
            );
        }
    }

    /// Codex R3 scenario — stale pseudo-tail: with prefix TRUNCATION (the
    /// rejected design) the surviving prefix's last entry could pair with a
    /// LATER same-hash turn across the gap. Store [A"x", B"重试", C"重试",
    /// D"z", E"重试"], file landed [A, C, B, D, E] (B stalled): truncation
    /// would keep [A, C] and E would wear C's span. Whole-journal rejection
    /// must leave every turn clockless instead.
    #[test]
    fn journal_disorder_leaves_no_stale_pseudo_tail() {
        let tmp = tempfile::tempdir().unwrap();
        let session_dir = tmp.path().join("acp-sessions").join("acp-journal-6");
        std::fs::create_dir_all(&session_dir).unwrap();
        let mut store = StoreBuilder::create(&session_dir.join("store.db"));

        let mut state = Vec::new();
        for (text, reply) in [
            ("x", "一"),
            ("重试", "二"),
            ("重试", "三"),
            ("z", "四"),
            ("重试", "五"),
        ] {
            let turn = put_text_only_turn(&mut store, text, reply);
            field_bytes(8, &turn, &mut state);
        }
        let root_id = store.put_blob(&state);
        store.put_meta(&serde_json::json!({
            "agentId": "acp-journal-6",
            "latestRootBlobId": hex_encode(&root_id),
            "createdAt": 1_784_000_000_000_u64,
        }));

        // Landing order [A, C, B, D, E] — B's line stalled past C's.
        for (ord, text, start, end) in [
            (1_u64, "x", 1_784_000_100_000_u64, 1_784_000_101_000_u64),
            (3, "重试", 1_784_000_300_000, 1_784_000_301_000), // C landed early
            (2, "重试", 1_784_000_200_000, 1_784_000_201_000), // stalled B
            (4, "z", 1_784_000_400_000, 1_784_000_401_000),
            (5, "重试", 1_784_000_500_000, 1_784_000_501_000), // E
        ] {
            crate::turn_timings::append_turn_timing_in(
                &tmp.path().join("turn-timings"),
                crate::turn_timings::CURSOR_JOURNAL_AGENT,
                "acp-journal-6",
                &crate::turn_timings::TurnTiming {
                    v: crate::turn_timings::TURN_TIMING_SCHEMA_VERSION,
                    ord,
                    conn: "conn-1".into(),
                    prompt_sha: crate::turn_timings::prompt_hash(text),
                    started_at_ms: start,
                    ended_at_ms: end,
                },
            );
        }

        let parser = CursorParser::with_base_dir(tmp.path().join("chats"));
        let detail = parser.get_conversation("acp-journal-6").unwrap();
        assert_eq!(detail.turns.len(), 10);
        for turn in &detail.turns {
            assert!(
                turn.duration_ms.is_none() && turn.completed_at.is_none(),
                "no stale pseudo-tail may assign any span after a disorder"
            );
        }
    }

    /// Codex R5 scenario — interior journal gap: store [x, y, x, z] but the
    /// journal only has lines for the FIRST x (ord 1) and z (ord 4) — y was
    /// skipped (non-`end_turn`) and the third turn's line was dropped at the
    /// queue. Without the ordinal trim, the reverse walk pairs z correctly
    /// and then slides the FIRST x's span onto the THIRD turn (hashes match,
    /// contiguous runs are both length 1, counts pass). The trailing
    /// ordinal-contiguity trim must trust only [z]: z gets its span, the
    /// third turn stays clockless.
    #[test]
    fn journal_gap_never_slides_onto_older_same_hash_entry() {
        let tmp = tempfile::tempdir().unwrap();
        let session_dir = tmp.path().join("acp-sessions").join("acp-journal-8");
        std::fs::create_dir_all(&session_dir).unwrap();
        let mut store = StoreBuilder::create(&session_dir.join("store.db"));

        let mut state = Vec::new();
        for (text, reply) in [("x", "一"), ("y", "二"), ("x", "三"), ("z", "四")] {
            let turn = put_text_only_turn(&mut store, text, reply);
            field_bytes(8, &turn, &mut state);
        }
        let root_id = store.put_blob(&state);
        store.put_meta(&serde_json::json!({
            "agentId": "acp-journal-8",
            "latestRootBlobId": hex_encode(&root_id),
            "createdAt": 1_784_000_000_000_u64,
        }));

        for (ord, text, start, end) in [
            (1_u64, "x", 1_784_000_100_000_u64, 1_784_000_101_000_u64),
            (4, "z", 1_784_000_400_000, 1_784_000_402_000),
        ] {
            crate::turn_timings::append_turn_timing_in(
                &tmp.path().join("turn-timings"),
                crate::turn_timings::CURSOR_JOURNAL_AGENT,
                "acp-journal-8",
                &crate::turn_timings::TurnTiming {
                    v: crate::turn_timings::TURN_TIMING_SCHEMA_VERSION,
                    ord,
                    conn: "conn-1".into(),
                    prompt_sha: crate::turn_timings::prompt_hash(text),
                    started_at_ms: start,
                    ended_at_ms: end,
                },
            );
        }

        let parser = CursorParser::with_base_dir(tmp.path().join("chats"));
        let detail = parser.get_conversation("acp-journal-8").unwrap();
        assert_eq!(detail.turns.len(), 8);
        // z (last assistant turn) gets its own span from the trusted tail.
        assert_eq!(detail.turns[7].duration_ms, Some(2_000));
        assert_eq!(
            detail.turns[7].completed_at.map(|t| t.timestamp_millis()),
            Some(1_784_000_402_000)
        );
        // The THIRD turn ("x") must NOT wear the first x's span.
        assert!(detail.turns[5].duration_ms.is_none());
        assert!(detail.turns[5].completed_at.is_none());
        // And the first x stays clockless too (outside the trusted run).
        assert!(detail.turns[1].duration_ms.is_none());
        assert!(detail.turns[1].completed_at.is_none());
    }

    /// ACCEPTED RESIDUAL (Codex R7) — this test PINS a known limitation, it
    /// does not bless it as desirable. When the session's newest turns ALL
    /// lost their journal lines (canceled/empty turns are deliberately
    /// unjournaled; queue-full drops), an older line remains the journal
    /// tail, and if the store's newest turn hash-collides with it while the
    /// same-hash run lengths align (here: [x, y, x] with only the FIRST x
    /// journaled — the y between breaks the store-side run), the old span is
    /// attributed to the newer turn. Closing this needs a store-side
    /// persistence/tail anchor Cursor does not expose. If this test starts
    /// failing because the misattribution no longer happens, the residual
    /// was closed — update the docs in `turn_timings` and flip these
    /// assertions.
    #[test]
    fn accepted_residual_missing_tail_lines_can_misattribute_span() {
        let tmp = tempfile::tempdir().unwrap();
        let session_dir = tmp.path().join("acp-sessions").join("acp-journal-10");
        std::fs::create_dir_all(&session_dir).unwrap();
        let mut store = StoreBuilder::create(&session_dir.join("store.db"));

        let mut state = Vec::new();
        for (text, reply) in [("x", "一"), ("y", "二"), ("x", "三")] {
            let turn = put_text_only_turn(&mut store, text, reply);
            field_bytes(8, &turn, &mut state);
        }
        let root_id = store.put_blob(&state);
        store.put_meta(&serde_json::json!({
            "agentId": "acp-journal-10",
            "latestRootBlobId": hex_encode(&root_id),
            "createdAt": 1_784_000_000_000_u64,
        }));

        // Only the FIRST turn's line exists; y and the second x lost theirs.
        crate::turn_timings::append_turn_timing_in(
            &tmp.path().join("turn-timings"),
            crate::turn_timings::CURSOR_JOURNAL_AGENT,
            "acp-journal-10",
            &crate::turn_timings::TurnTiming {
                v: crate::turn_timings::TURN_TIMING_SCHEMA_VERSION,
                ord: 1,
                conn: "conn-1".into(),
                prompt_sha: crate::turn_timings::prompt_hash("x"),
                started_at_ms: 1_784_000_100_000,
                ended_at_ms: 1_784_000_101_000,
            },
        );

        let parser = CursorParser::with_base_dir(tmp.path().join("chats"));
        let detail = parser.get_conversation("acp-journal-10").unwrap();
        // The THIRD turn wears the FIRST turn's span — the documented
        // residual. (The first turn itself stays clockless: its line was
        // consumed by the tail pairing.)
        assert_eq!(detail.turns[5].duration_ms, Some(1_000));
        assert_eq!(
            detail.turns[5].completed_at.map(|t| t.timestamp_millis()),
            Some(1_784_000_101_000)
        );
        assert!(detail.turns[1].duration_ms.is_none());
    }

    /// Codex R6 scenario — cross-connection ordinal coincidence: the old
    /// connection journaled its first "x" as ord 1; a RESUMED connection's
    /// first turn (ord 1) was canceled-unjournaled and its second turn "z"
    /// landed as ord 2. `1 → 2` is numerically consecutive but spans two
    /// connections — trusting it would slide the old x's span onto the
    /// store's third turn. The trim must require equal `conn`: only [z] is
    /// trusted; z gets its span, everything older stays clockless.
    #[test]
    fn journal_connection_boundary_breaks_ordinal_contiguity() {
        let tmp = tempfile::tempdir().unwrap();
        let session_dir = tmp.path().join("acp-sessions").join("acp-journal-9");
        std::fs::create_dir_all(&session_dir).unwrap();
        let mut store = StoreBuilder::create(&session_dir.join("store.db"));

        let mut state = Vec::new();
        for (text, reply) in [("x", "一"), ("y", "二"), ("x", "三"), ("z", "四")] {
            let turn = put_text_only_turn(&mut store, text, reply);
            field_bytes(8, &turn, &mut state);
        }
        let root_id = store.put_blob(&state);
        store.put_meta(&serde_json::json!({
            "agentId": "acp-journal-9",
            "latestRootBlobId": hex_encode(&root_id),
            "createdAt": 1_784_000_000_000_u64,
        }));

        for (conn, ord, text, start, end) in [
            (
                "conn-old",
                1_u64,
                "x",
                1_784_000_100_000_u64,
                1_784_000_101_000_u64,
            ),
            ("conn-new", 2, "z", 1_784_000_400_000, 1_784_000_402_000),
        ] {
            crate::turn_timings::append_turn_timing_in(
                &tmp.path().join("turn-timings"),
                crate::turn_timings::CURSOR_JOURNAL_AGENT,
                "acp-journal-9",
                &crate::turn_timings::TurnTiming {
                    v: crate::turn_timings::TURN_TIMING_SCHEMA_VERSION,
                    ord,
                    conn: conn.into(),
                    prompt_sha: crate::turn_timings::prompt_hash(text),
                    started_at_ms: start,
                    ended_at_ms: end,
                },
            );
        }

        let parser = CursorParser::with_base_dir(tmp.path().join("chats"));
        let detail = parser.get_conversation("acp-journal-9").unwrap();
        assert_eq!(detail.turns.len(), 8);
        assert_eq!(detail.turns[7].duration_ms, Some(2_000));
        // The third turn ("x") must NOT wear the old connection's x span.
        assert!(detail.turns[5].duration_ms.is_none());
        assert!(detail.turns[5].completed_at.is_none());
        assert!(detail.turns[1].duration_ms.is_none());
    }

    /// Codex R4-2 scenario — non-contiguous phantom: the store kept only
    /// `A:"x"`, but a (hand-built / legacy) journal carries three monotonic
    /// lines `[x, y, x]` — e.g. two later turns canceled before Cursor
    /// persisted them. Tail pairing would hand the LAST "x" line's span to
    /// store-A (both contiguous runs have length 1, so the run guard is
    /// blind). The count guard (journal longer than the store's user turns)
    /// must reject everything.
    #[test]
    fn journal_with_more_entries_than_store_turns_assigns_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let session_dir = tmp.path().join("acp-sessions").join("acp-journal-7");
        std::fs::create_dir_all(&session_dir).unwrap();
        let mut store = StoreBuilder::create(&session_dir.join("store.db"));

        let turn_a = put_text_only_turn(&mut store, "x", "回答");
        let mut state = Vec::new();
        field_bytes(8, &turn_a, &mut state);
        let root_id = store.put_blob(&state);
        store.put_meta(&serde_json::json!({
            "agentId": "acp-journal-7",
            "latestRootBlobId": hex_encode(&root_id),
            "createdAt": 1_784_000_000_000_u64,
        }));

        for (ord, text, start, end) in [
            (1_u64, "x", 1_784_000_100_000_u64, 1_784_000_101_000_u64),
            (2, "y", 1_784_000_200_000, 1_784_000_201_000),
            (3, "x", 1_784_000_300_000, 1_784_000_300_500), // phantom duplicate
        ] {
            crate::turn_timings::append_turn_timing_in(
                &tmp.path().join("turn-timings"),
                crate::turn_timings::CURSOR_JOURNAL_AGENT,
                "acp-journal-7",
                &crate::turn_timings::TurnTiming {
                    v: crate::turn_timings::TURN_TIMING_SCHEMA_VERSION,
                    ord,
                    conn: "conn-1".into(),
                    prompt_sha: crate::turn_timings::prompt_hash(text),
                    started_at_ms: start,
                    ended_at_ms: end,
                },
            );
        }

        let parser = CursorParser::with_base_dir(tmp.path().join("chats"));
        let detail = parser.get_conversation("acp-journal-7").unwrap();
        for turn in &detail.turns {
            assert!(
                turn.duration_ms.is_none() && turn.completed_at.is_none(),
                "a journal longer than the store must assign nothing"
            );
        }
    }

    /// The guard must NOT over-block the legitimate case: equal-length
    /// duplicate runs (both prompts persisted) pair 1:1 and both turns get
    /// their own span.
    #[test]
    fn journal_equal_duplicate_runs_pair_one_to_one() {
        let tmp = tempfile::tempdir().unwrap();
        let session_dir = tmp.path().join("acp-sessions").join("acp-journal-4");
        std::fs::create_dir_all(&session_dir).unwrap();
        let mut store = StoreBuilder::create(&session_dir.join("store.db"));

        let turn_a = put_text_only_turn(&mut store, "重试", "第一次");
        let turn_b = put_text_only_turn(&mut store, "重试", "第二次");
        let mut state = Vec::new();
        field_bytes(8, &turn_a, &mut state);
        field_bytes(8, &turn_b, &mut state);
        let root_id = store.put_blob(&state);
        store.put_meta(&serde_json::json!({
            "agentId": "acp-journal-4",
            "latestRootBlobId": hex_encode(&root_id),
            "createdAt": 1_784_000_000_000_u64,
        }));

        for (ord, start, end) in [
            (1_u64, 1_784_000_100_000_u64, 1_784_000_104_000_u64),
            (2, 1_784_000_200_000, 1_784_000_209_000),
        ] {
            crate::turn_timings::append_turn_timing_in(
                &tmp.path().join("turn-timings"),
                crate::turn_timings::CURSOR_JOURNAL_AGENT,
                "acp-journal-4",
                &crate::turn_timings::TurnTiming {
                    v: crate::turn_timings::TURN_TIMING_SCHEMA_VERSION,
                    ord,
                    conn: "conn-1".into(),
                    prompt_sha: crate::turn_timings::prompt_hash("重试"),
                    started_at_ms: start,
                    ended_at_ms: end,
                },
            );
        }

        let parser = CursorParser::with_base_dir(tmp.path().join("chats"));
        let detail = parser.get_conversation("acp-journal-4").unwrap();
        assert_eq!(detail.turns.len(), 4);
        assert_eq!(detail.turns[1].duration_ms, Some(4_000));
        assert_eq!(
            detail.turns[1].completed_at.map(|t| t.timestamp_millis()),
            Some(1_784_000_104_000)
        );
        assert_eq!(detail.turns[3].duration_ms, Some(9_000));
        assert_eq!(
            detail.turns[3].completed_at.map(|t| t.timestamp_millis()),
            Some(1_784_000_209_000)
        );
    }

    /// A journal whose tail does NOT hash-match the last user turn must
    /// assign nothing — the walk stops instead of scanning, which could
    /// misattribute a span to an earlier identical prompt.
    #[test]
    fn journal_tail_mismatch_assigns_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let session_dir = tmp.path().join("acp-sessions").join("acp-journal-2");
        std::fs::create_dir_all(&session_dir).unwrap();
        let mut store = StoreBuilder::create(&session_dir.join("store.db"));

        let turn_a = put_text_only_turn(&mut store, "重试", "好的");
        let turn_b = put_text_only_turn(&mut store, "换个说法", "明白");
        let mut state = Vec::new();
        field_bytes(8, &turn_a, &mut state);
        field_bytes(8, &turn_b, &mut state);
        let root_id = store.put_blob(&state);
        store.put_meta(&serde_json::json!({
            "agentId": "acp-journal-2",
            "latestRootBlobId": hex_encode(&root_id),
            "createdAt": 1_784_000_000_000_u64,
        }));

        // The lone journal line matches the FIRST turn's text, not the last —
        // tail anchoring must refuse it rather than pair it with turn A.
        crate::turn_timings::append_turn_timing_in(
            &tmp.path().join("turn-timings"),
            crate::turn_timings::CURSOR_JOURNAL_AGENT,
            "acp-journal-2",
            &crate::turn_timings::TurnTiming {
                v: crate::turn_timings::TURN_TIMING_SCHEMA_VERSION,
                ord: 1,
                conn: "conn-1".into(),
                prompt_sha: crate::turn_timings::prompt_hash("重试"),
                started_at_ms: 1_784_000_100_000,
                ended_at_ms: 1_784_000_101_000,
            },
        );

        let parser = CursorParser::with_base_dir(tmp.path().join("chats"));
        let detail = parser.get_conversation("acp-journal-2").unwrap();
        for turn in &detail.turns {
            assert!(turn.duration_ms.is_none(), "no span may be assigned");
            assert!(turn.completed_at.is_none());
        }
    }

    #[test]
    fn decodes_user_image_attachments() {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let tmp = tempfile::tempdir().unwrap();
        let session_dir = tmp.path().join("acp-sessions").join("acp-img-1");
        std::fs::create_dir_all(&session_dir).unwrap();
        let mut store = StoreBuilder::create(&session_dir.join("store.db"));

        let png_bytes: &[u8] = b"\x89PNG\r\n\x1a\nfakepixels";
        let png_blob_id = store.put_blob(png_bytes);

        // Attachment entry: field 1 wraps the image variant
        // {1: blob id, 2: uuid, 7: mime}.
        let mut image = Vec::new();
        field_bytes(1, &png_blob_id, &mut image);
        field_str(2, "a790dbed-a763-4d16-98c1-d100203ba9e8", &mut image);
        field_str(7, "image/png", &mut image);
        let mut attachment = Vec::new();
        field_bytes(1, &image, &mut attachment);

        // A non-image attachment must be skipped, not decoded.
        let pdf_blob_id = store.put_blob(b"%PDF-1.7 fake");
        let mut pdf = Vec::new();
        field_bytes(1, &pdf_blob_id, &mut pdf);
        field_str(7, "application/pdf", &mut pdf);
        let mut pdf_attachment = Vec::new();
        field_bytes(1, &pdf, &mut pdf_attachment);

        // Turn 1: text + both attachments.
        let mut user_msg = Vec::new();
        field_str(1, "这是什么", &mut user_msg);
        field_bytes(3, &attachment, &mut user_msg);
        field_bytes(3, &pdf_attachment, &mut user_msg);
        let user_id = store.put_blob(&user_msg);

        let mut assistant = Vec::new();
        field_str(1, "一张图片。", &mut assistant);
        let mut step_text = Vec::new();
        field_bytes(1, &assistant, &mut step_text);
        let step_text_id = store.put_blob(&step_text);

        let mut agent_turn = Vec::new();
        field_bytes(1, &user_id, &mut agent_turn);
        field_bytes(2, &step_text_id, &mut agent_turn);
        let mut turn1 = Vec::new();
        field_bytes(1, &agent_turn, &mut turn1);
        let turn1_id = store.put_blob(&turn1);

        // Turn 2: image-only prompt (no text) must still produce a user turn.
        let mut user_msg2 = Vec::new();
        field_bytes(3, &attachment, &mut user_msg2);
        let user2_id = store.put_blob(&user_msg2);
        let mut agent_turn2 = Vec::new();
        field_bytes(1, &user2_id, &mut agent_turn2);
        field_bytes(2, &step_text_id, &mut agent_turn2);
        let mut turn2 = Vec::new();
        field_bytes(1, &agent_turn2, &mut turn2);
        let turn2_id = store.put_blob(&turn2);

        let mut state = Vec::new();
        field_bytes(8, &turn1_id, &mut state);
        field_bytes(8, &turn2_id, &mut state);
        field_varint(26, 1_784_000_000_000, &mut state);
        let root_id = store.put_blob(&state);
        store.put_meta(&serde_json::json!({
            "agentId": "acp-img-1",
            "latestRootBlobId": hex_encode(&root_id),
            "createdAt": 1_784_000_000_000_u64,
        }));

        let parser = CursorParser::with_base_dir(tmp.path().join("chats"));
        let detail = parser.get_conversation("acp-img-1").unwrap();
        assert_eq!(detail.turns.len(), 4);

        let user = &detail.turns[0];
        assert_eq!(user.blocks.len(), 2, "text + one image (pdf skipped)");
        assert!(matches!(&user.blocks[0], ContentBlock::Text { text } if text == "这是什么"));
        match &user.blocks[1] {
            ContentBlock::Image {
                data,
                mime_type,
                uri,
            } => {
                assert_eq!(data, &STANDARD.encode(png_bytes));
                assert_eq!(mime_type, "image/png");
                assert!(uri.is_none());
            }
            other => panic!("expected image block, got {other:?}"),
        }

        let image_only = &detail.turns[2];
        assert!(matches!(image_only.role, TurnRole::User));
        assert_eq!(image_only.blocks.len(), 1);
        assert!(matches!(&image_only.blocks[0], ContentBlock::Image { .. }));
    }

    /// #948: built with an agent's launch env, the parser reads where THAT
    /// env puts the agent's files, not where codeg's own environment does.
    #[test]
    fn for_env_reads_the_config_dir_of_the_launch_env() {
        let env = AgentEnv::with_overrides(&[("CURSOR_CONFIG_DIR", "/relocated/cursor")]);
        let parser = CursorParser::for_env(&env);
        let config_dir = PathBuf::from("/relocated/cursor");
        assert_eq!(parser.chats_dir, config_dir.join("chats"));
        assert_eq!(parser.acp_sessions_dir, config_dir.join("acp-sessions"));

        // Removed for the child, `CURSOR_CONFIG_DIR` gives way to the XDG home.
        let env = AgentEnv::with_overrides(&[
            ("CURSOR_CONFIG_DIR", ""),
            ("XDG_CONFIG_HOME", "/relocated/xdg"),
        ]);
        assert_eq!(
            CursorParser::for_env(&env).chats_dir,
            PathBuf::from("/relocated/xdg").join("cursor").join("chats")
        );
    }
}
