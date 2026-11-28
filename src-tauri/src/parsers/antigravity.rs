//! Transcript reader for Google Antigravity — both the CLI's own `agy acp`
//! sessions (the current backend) and the standalone `agy_acp_server` archives
//! codeg used before.
//!
//! LAYOUT. Everything hangs off the *Gemini home* — `$GEMINI_HOME` when set and
//! non-empty, else `~/.gemini`. Unlike Gemini CLI's `GEMINI_CLI_HOME` (which
//! names the PARENT and gets `.gemini` joined onto it), `GEMINI_HOME` names the
//! `.gemini` directory itself, so setting it relocates the whole tree:
//!
//! ```text
//! <home>/antigravity-cli/                 the CLI's subtree (agy acp writes here)
//! ├── conversation_summaries.db           title / workspace_uris / step_count
//! ├── settings.json                       the CLI's own settings
//! └── conversations/
//!     └── <session id>.db                 SQLite trajectory (no .meta sidecar)
//!
//! <home>/antigravity-acp/                 LEGACY standalone server (read-only)
//! ├── settings.json, acp_token.json, …
//! └── conversations/
//!     ├── <session id>.db
//!     └── <session id>.meta               sidecar JSON (cwd, mode_id, …)
//! ```
//!
//! FORMAT. The `.db` is a plain SQLite file with a single `steps(idx,
//! step_payload)` table; each payload is a serialized `gemini_coder.Step`
//! protobuf. The CLI and the old server use the same schema. A brand-new
//! session's DB is pre-created EMPTY (0 bytes) before the harness writes the
//! schema, so "no such table: steps" is a normal state, not a corruption — it
//! reads as an empty conversation.
//!
//! The CLI keeps no per-session `.meta`; its workspace comes from
//! `conversation_summaries.workspace_uris` (the same column its own
//! `session/list` reads). The legacy `.meta` sidecar still supplies `cwd` (and
//! `mode_id` / `allowed_tool_calls`) for old sessions. Neither carries a title
//! worth mirroring, so the title comes from the first user prompt like every
//! other parser.
//!
//! WHY A HAND-WRITTEN PROTO SUBSET. The real `Step` has ~130 fields, almost all
//! of them one arm of a `oneof step` over Google-internal `exa.cortex_pb`
//! messages. Only a handful carry anything a transcript reader needs, and
//! protobuf lets a decoder declare just those and skip the rest by wire type —
//! so [`Step`] below mirrors a strict subset of the real schema at the real
//! field numbers rather than vendoring a megabyte of generated code. Fields are
//! declared proto3-style (no explicit presence): a proto2 `optional` scalar and
//! a proto3 singular one are byte-identical on the wire, and nothing here needs
//! to tell "absent" from "default".
//!
//! Dispatch is on WHICH oneof arm is populated, never on the `type` enum: the
//! arm is self-describing, while the enum has 118 values whose numbering is
//! upstream's to change.

pub(crate) mod background;
mod failure;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use chrono::{DateTime, TimeZone, Utc};
use prost::Message as _;
use rusqlite::{Connection, OpenFlags};

use crate::models::{
    AgentType, ContentBlock, ConversationDetail, ConversationSummary, MessageTurn, TurnRole,
    TurnUsage,
};
use crate::parsers::expand_home_prefix;
use crate::parsers::{
    backfill_turn_durations, compute_session_stats, folder_name_from_path,
    infer_context_window_max_tokens, merge_context_window_stats, relocate_orphaned_tool_results,
    structurize_read_tool_output, title_from_user_text, truncate_str, AgentEnv, AgentParser,
    ParseError,
};

/// Bound a single tool output / input preview so one enormous step cannot blow
/// up a conversation payload. Mirrors the Cursor and Grok parsers' caps.
const TOOL_OUTPUT_CAP: usize = 16_000;
const TOOL_INPUT_CAP: usize = 8_000;
/// Bound assistant/user text too — a `view_file` step can inline a whole file.
const TEXT_CAP: usize = 200_000;

const SESSIONS_DIR_NAME: &str = "conversations";
const BRAIN_DIR_NAME: &str = "brain";
const ACP_SUBDIR: &str = "antigravity-acp";
const CLI_SUBDIR: &str = "antigravity-cli";
const SUMMARY_DB_NAME: &str = "conversation_summaries.db";
const METADATA_FILE_SUFFIX: &str = "meta";

// ---------------------------------------------------------------------------
// Path resolution (mirrors the server's own `acp_server/paths.py`)
// ---------------------------------------------------------------------------

/// Resolve the Gemini home the way `paths.gemini_home()` does: `$GEMINI_HOME`
/// when set and non-empty, else `~/.gemini`, with a leading `~` expanded in
/// either case (upstream runs `os.path.expanduser` on the env value too, so
/// `GEMINI_HOME=~/gemini` does not create a literal `~` directory).
///
/// Empty counts as unset — Python treats `""` as falsy at that branch — so a
/// blank override never resolves the home to the process's cwd.
pub(crate) fn resolve_gemini_home() -> PathBuf {
    resolve_gemini_home_for_env(&AgentEnv::inherited())
}

/// [`resolve_gemini_home`] for the server launched with `env`.
pub(crate) fn resolve_gemini_home_for_env(env: &AgentEnv) -> PathBuf {
    resolve_gemini_home_from(env.var_os("GEMINI_HOME"), dirs::home_dir())
}

/// The same resolution for an EXPLICIT `GEMINI_HOME`, so a caller holding a
/// launch environment does not have to rebuild the rules by hand.
///
/// It exists because rebuilding them by hand once went wrong: a bare
/// `PathBuf::from` drops the `~` expansion above and points a
/// `GEMINI_HOME=~/...` launch at a literal `~` directory beside codeg's
/// working directory. `--gemini-dir` and the migration target both go through
/// here (`acp::connection::antigravity_gemini_dir_arg`).
/// `home_dir` is the home the value's `~` is expanded against, and that the
/// `~/.gemini` default hangs off. A caller holding a launch environment must
/// pass the CHILD's home (`acp::file_system_runtime::child_home_dir`), not
/// codeg's: `merge_agent_env` copies `HOME` into the child like any other
/// variable, so `HOME=/srv/agy GEMINI_HOME=~/profile` means `/srv/agy/profile`
/// to the server and nothing else.
pub(crate) fn resolve_gemini_home_from_value(
    value: Option<std::ffi::OsString>,
    home_dir: Option<PathBuf>,
) -> PathBuf {
    resolve_gemini_home_from(value, home_dir)
}

fn resolve_gemini_home_from(
    gemini_home_env: Option<std::ffi::OsString>,
    home_dir: Option<PathBuf>,
) -> PathBuf {
    let configured = gemini_home_env
        .map(|value| value.to_string_lossy().into_owned())
        .filter(|value| !value.is_empty());
    match configured {
        Some(value) => expand_home_prefix(&value, home_dir.as_ref()),
        None => home_dir.unwrap_or_default().join(".gemini"),
    }
}

/// `<home>/antigravity-cli/conversations` — the Antigravity CLI's session
/// trajectories, which `agy acp` writes too.
pub(crate) fn resolve_antigravity_sessions_dir() -> PathBuf {
    resolve_antigravity_sessions_dir_for_env(&AgentEnv::inherited())
}

/// [`resolve_antigravity_sessions_dir`] for the CLI launched with `env`.
pub(crate) fn resolve_antigravity_sessions_dir_for_env(env: &AgentEnv) -> PathBuf {
    resolve_gemini_home_for_env(env)
        .join(CLI_SUBDIR)
        .join(SESSIONS_DIR_NAME)
}

/// `<home>/antigravity-acp/conversations` — the sessions the standalone
/// `agy_acp_server` wrote, read (and backed up) until each is migrated into the
/// CLI's tree on open.
pub(crate) fn resolve_antigravity_legacy_sessions_dir() -> PathBuf {
    resolve_antigravity_legacy_sessions_dir_for_env(&AgentEnv::inherited())
}

/// [`resolve_antigravity_legacy_sessions_dir`] for the CLI launched with `env`.
pub(crate) fn resolve_antigravity_legacy_sessions_dir_for_env(env: &AgentEnv) -> PathBuf {
    resolve_gemini_home_for_env(env)
        .join(ACP_SUBDIR)
        .join(SESSIONS_DIR_NAME)
}

/// `<home>/config` — the config shared with every other Gemini/Antigravity
/// surface on the machine (`hooks.json`, `mcp_config.json`, `skills/`).
pub(crate) fn resolve_antigravity_shared_config_dir() -> PathBuf {
    resolve_gemini_home().join("config")
}

/// `<home>/antigravity-cli` — the Antigravity CLI's own subtree. The ACP server
/// reads the user's CLI-installed skills out of it so they need not be
/// installed twice.
pub(crate) fn resolve_antigravity_cli_dir() -> PathBuf {
    resolve_gemini_home().join("antigravity-cli")
}

/// 按需将旧版独立 `agy_acp_server` 下的会话迁移到原生 `agy acp` 目录。
///
/// 旧版服务端将会话保存在 `<gemini_home>/antigravity-acp/conversations/<id>.db`
/// （以及可选的 `antigravity-acp/brain/<id>/`），而原生 `agy acp` 仅读写
/// `<gemini_home>/antigravity-cli/`。两者轨迹库表结构完全一致，因此在打开
/// 旧会话前将其按页备份（完整合并 WAL）到新目录即可恢复续聊，同时保留旧目录
/// 原始文件与 `.meta` 侧车文件（供历史解析器回退读取原始工作区路径）。
///
/// 返回值：
/// - `Ok(true)`：本次成功执行了迁移；
/// - `Ok(false)`：无需迁移（目标已存在非空 DB、旧会话不存在/为空、或 id 非法）；
/// - `Err(_)`：迁移过程中发生 SQLite 或文件系统错误。
pub(crate) fn migrate_legacy_session_to_cli(
    gemini_home: &Path,
    session_id: &str,
) -> Result<bool, String> {
    if !is_safe_session_id(session_id) {
        return Ok(false);
    }

    let legacy_dir = gemini_home.join(ACP_SUBDIR);
    let cli_dir = gemini_home.join(CLI_SUBDIR);
    let legacy_db = legacy_dir
        .join(SESSIONS_DIR_NAME)
        .join(format!("{session_id}.db"));
    let cli_conversations = cli_dir.join(SESSIONS_DIR_NAME);
    let cli_db = cli_conversations.join(format!("{session_id}.db"));

    // 目标已存在非空轨迹库时不覆盖，避免抹掉新会话中的续聊记录。
    if is_non_empty_file(&cli_db) {
        return Ok(false);
    }
    // 旧目录不存在有效轨迹库则无需迁移。
    if !is_non_empty_file(&legacy_db) {
        return Ok(false);
    }

    std::fs::create_dir_all(&cli_conversations)
        .map_err(|e| format!("创建目标会话目录失败 ({}): {e}", cli_conversations.display()))?;

    let nonce = next_migration_nonce();
    let tmp_db = cli_conversations.join(format!(
        ".{session_id}.migrate-{}-{nonce}.tmp",
        std::process::id()
    ));

    if let Err(err) = copy_legacy_sqlite_db(&legacy_db, &tmp_db) {
        let _ = std::fs::remove_file(&tmp_db);
        return Err(err);
    }

    // 二次确认：若并发启动已写入非空目标文件，放弃覆盖并清理临时文件。
    if is_non_empty_file(&cli_db) {
        let _ = std::fs::remove_file(&tmp_db);
        return Ok(false);
    }

    #[cfg(windows)]
    if cli_db.is_file() {
        let _ = std::fs::remove_file(&cli_db);
    }

    if let Err(err) = std::fs::rename(&tmp_db, &cli_db) {
        let _ = std::fs::remove_file(&tmp_db);
        return Err(format!(
            "原子写入迁移轨迹库失败 ({} -> {}): {err}",
            tmp_db.display(),
            cli_db.display()
        ));
    }

    // 顺带迁移旧会话的 brain 产物目录（best-effort，不阻断主会话加载）。
    migrate_legacy_brain_dir(
        &legacy_dir.join(BRAIN_DIR_NAME).join(session_id),
        &cli_dir.join(BRAIN_DIR_NAME).join(session_id),
        session_id,
    );

    Ok(true)
}

/// 仅允许单个普通路径组件作为会话 ID，防止路径穿越。
fn is_safe_session_id(session_id: &str) -> bool {
    if session_id.is_empty() || session_id.contains('/') || session_id.contains('\\') {
        return false;
    }
    let mut components = Path::new(session_id).components();
    matches!(
        (components.next(), components.next()),
        (Some(std::path::Component::Normal(_)), None)
    )
}

fn is_non_empty_file(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|meta| meta.is_file() && meta.len() > 0)
        .unwrap_or(false)
}

fn next_migration_nonce() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    COUNTER.fetch_add(1, Ordering::Relaxed)
}

/// 将旧版 SQLite 轨迹库导出为自包含的单文件副本。
///
/// 优先使用 SQLite Online Backup API（自动合并 `-wal` 中的未 checkpoint 页），
/// 先尝试只读打开，遇 `SQLITE_READONLY_RECOVERY` 时回退读写模式（与解析器一致）。
/// 若源库不存在非空 `-wal` 且 SQLite 备份异常，则回退普通文件拷贝。
fn copy_legacy_sqlite_db(src: &Path, dest: &Path) -> Result<(), String> {
    let try_backup = |flags: OpenFlags| -> Result<(), rusqlite::Error> {
        let _ = std::fs::remove_file(dest);
        let conn = Connection::open_with_flags(src, flags)?;
        let _ = conn.busy_timeout(std::time::Duration::from_millis(500));
        conn.backup(rusqlite::DatabaseName::Main, dest, None)
    };

    let backup_err = match try_backup(OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
    {
        Ok(()) => None,
        Err(_) => try_backup(OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX)
            .err(),
    };

    if let Some(err) = backup_err {
        let mut wal_os = src.as_os_str().to_os_string();
        wal_os.push("-wal");
        let has_pending_wal = is_non_empty_file(Path::new(&wal_os));
        if has_pending_wal {
            return Err(format!(
                "SQLite 备份旧轨迹库失败且存在未合并 WAL ({}): {err}",
                src.display()
            ));
        }
        let _ = std::fs::remove_file(dest);
        std::fs::copy(src, dest).map_err(|copy_err| {
            format!(
                "复制旧轨迹库失败 ({}): sqlite={err}; copy={copy_err}",
                src.display()
            )
        })?;
    }

    if !is_non_empty_file(dest) {
        return Err(format!(
            "迁移后的轨迹库为空文件 ({})",
            dest.display()
        ));
    }
    Ok(())
}

/// 迁移旧会话的 `brain/<session_id>` 目录（若源存在且目标不存在）。
fn migrate_legacy_brain_dir(src: &Path, dest: &Path, session_id: &str) {
    if !src.is_dir() || dest.exists() {
        return;
    }
    let Some(parent) = dest.parent() else {
        return;
    };
    if let Err(err) = std::fs::create_dir_all(parent) {
        tracing::warn!(
            "[antigravity] 创建目标 brain 父目录失败 ({}): {err}",
            parent.display()
        );
        return;
    }
    let nonce = next_migration_nonce();
    let tmp_dir = parent.join(format!(
        ".{session_id}.brain-migrate-{}-{nonce}.tmp",
        std::process::id()
    ));
    if let Err(err) = copy_dir_recursive(src, &tmp_dir) {
        let _ = std::fs::remove_dir_all(&tmp_dir);
        tracing::warn!(
            "[antigravity] 复制旧 brain 目录失败 ({} -> {}): {err}",
            src.display(),
            dest.display()
        );
        return;
    }
    if dest.exists() {
        let _ = std::fs::remove_dir_all(&tmp_dir);
        return;
    }
    if let Err(err) = std::fs::rename(&tmp_dir, dest) {
        let _ = std::fs::remove_dir_all(&tmp_dir);
        tracing::warn!(
            "[antigravity] 提交迁移 brain 目录失败 ({} -> {}): {err}",
            tmp_dir.display(),
            dest.display()
        );
    }
}

/// 递归复制普通目录与文件，跳过符号链接以防循环或逃逸目录树。
fn copy_dir_recursive(src: &Path, dest: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let meta = std::fs::symlink_metadata(&src_path)?;
        let file_type = meta.file_type();
        if file_type.is_symlink() {
            continue;
        }
        let dest_path = dest.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&src_path, &dest_path)?;
        } else if file_type.is_file() {
            std::fs::copy(&src_path, &dest_path)?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Wire subset of `gemini_coder.Step` and its `exa.cortex_pb` payloads
// ---------------------------------------------------------------------------

#[derive(Clone, PartialEq, ::prost::Message)]
struct Timestamp {
    #[prost(int64, tag = "1")]
    seconds: i64,
    #[prost(int32, tag = "2")]
    nanos: i32,
}

/// `exa.codeium_common_pb.ChatToolCall` — the model's tool invocation. Present
/// both inside `planner_response.tool_calls` (the announcement) and on the
/// executing step's `metadata.tool_call` (the correlation key).
#[derive(Clone, PartialEq, ::prost::Message)]
struct ChatToolCall {
    #[prost(string, tag = "1")]
    id: String,
    #[prost(string, tag = "2")]
    name: String,
    #[prost(string, tag = "3")]
    arguments_json: String,
}

/// `exa.codeium_common_pb.ModelUsageStats`.
#[derive(Clone, PartialEq, ::prost::Message)]
struct ModelUsageStats {
    #[prost(uint64, tag = "2")]
    input_tokens: u64,
    #[prost(uint64, tag = "3")]
    output_tokens: u64,
    #[prost(uint64, tag = "4")]
    cache_write_tokens: u64,
    #[prost(uint64, tag = "5")]
    cache_read_tokens: u64,
}

/// `exa.codeium_common_pb.ModelInfo` — only the two human-readable names.
/// `generator_model` next to it is an ENUM, not a string, so it is useless as a
/// display model and deliberately not decoded.
#[derive(Clone, PartialEq, ::prost::Message)]
struct ModelInfo {
    #[prost(string, tag = "8")]
    model_name: String,
    #[prost(string, tag = "20")]
    display_name: String,
}

/// `exa.cortex_pb.CortexStepMetadata`.
#[derive(Clone, PartialEq, ::prost::Message)]
struct StepMetadata {
    #[prost(message, optional, tag = "1")]
    created_at: Option<Timestamp>,
    #[prost(message, optional, tag = "4")]
    tool_call: Option<ChatToolCall>,
    #[prost(message, optional, tag = "8")]
    completed_at: Option<Timestamp>,
    #[prost(message, optional, tag = "9")]
    model_usage: Option<ModelUsageStats>,
    #[prost(message, optional, tag = "24")]
    model_info: Option<ModelInfo>,
}

/// `exa.codeium_common_pb.TextOrScopeItem` — one chunk of a structured prompt.
/// The `item` arm is a context-scope reference with no text of its own.
#[derive(Clone, PartialEq, ::prost::Message)]
struct TextOrScopeItem {
    #[prost(string, tag = "1")]
    text: String,
}

/// `exa.cortex_pb.CortexStepUserInput`. `query` is the plain prompt; `items` is
/// the structured form editors send; `user_response` is the reply to an agent
/// question. All three are decoded because which one is populated depends on
/// how the prompt was submitted.
#[derive(Clone, PartialEq, ::prost::Message)]
struct UserInput {
    #[prost(string, tag = "1")]
    query: String,
    #[prost(string, tag = "2")]
    user_response: String,
    #[prost(message, repeated, tag = "3")]
    items: Vec<TextOrScopeItem>,
}

/// `exa.cortex_pb.CortexStepPlannerResponse` — one assistant step.
#[derive(Clone, PartialEq, ::prost::Message)]
struct PlannerResponse {
    #[prost(string, tag = "1")]
    response: String,
    #[prost(string, tag = "3")]
    thinking: String,
    #[prost(message, repeated, tag = "7")]
    tool_calls: Vec<ChatToolCall>,
}

/// `exa.cortex_pb.RunCommandOutput`.
#[derive(Clone, PartialEq, ::prost::Message)]
struct RunCommandOutput {
    #[prost(string, tag = "1")]
    full: String,
    #[prost(string, tag = "2")]
    truncated: String,
}

#[derive(Clone, PartialEq, ::prost::Message)]
struct RunCommand {
    #[prost(string, tag = "1")]
    command: String,
    #[prost(int32, tag = "6")]
    exit_code: i32,
    #[prost(string, tag = "23")]
    command_line: String,
    #[prost(message, optional, tag = "21")]
    combined_output: Option<RunCommandOutput>,
    #[prost(string, tag = "4")]
    stdout: String,
    #[prost(string, tag = "5")]
    stderr: String,
}

#[derive(Clone, PartialEq, ::prost::Message)]
struct ViewFile {
    #[prost(string, tag = "1")]
    absolute_path_uri: String,
    #[prost(string, tag = "4")]
    content: String,
}

#[derive(Clone, PartialEq, ::prost::Message)]
struct WriteToFile {
    #[prost(string, tag = "1")]
    target_file_uri: String,
    #[prost(bool, tag = "4")]
    file_created: bool,
}

#[derive(Clone, PartialEq, ::prost::Message)]
struct FileChange {
    #[prost(string, tag = "1")]
    absolute_path_uri: String,
    #[prost(string, tag = "5")]
    instruction: String,
}

#[derive(Clone, PartialEq, ::prost::Message)]
struct GrepSearch {
    #[prost(string, tag = "1")]
    query: String,
    #[prost(string, tag = "3")]
    raw_output: String,
    #[prost(string, tag = "5")]
    grep_error: String,
    #[prost(uint32, tag = "7")]
    total_results: u32,
}

#[derive(Clone, PartialEq, ::prost::Message)]
struct ListDirectory {
    #[prost(string, tag = "1")]
    directory_path_uri: String,
    #[prost(string, repeated, tag = "2")]
    children: Vec<String>,
    #[prost(bool, tag = "4")]
    dir_not_found: bool,
}

#[derive(Clone, PartialEq, ::prost::Message)]
struct McpTool {
    #[prost(string, tag = "1")]
    server_name: String,
    #[prost(message, optional, tag = "2")]
    tool_call: Option<ChatToolCall>,
    #[prost(string, tag = "3")]
    result_string: String,
    #[prost(bool, tag = "7")]
    user_rejected: bool,
}

/// `google.protobuf.Any`. Only the two wire fields — the payload is decoded by
/// hand after checking `type_url`, because the inner messages live in Go-side
/// protos that are not worth mirroring whole.
#[derive(Clone, PartialEq, ::prost::Message)]
struct ProtoAny {
    #[prost(string, tag = "1")]
    type_url: String,
    #[prost(bytes = "vec", tag = "2")]
    value: Vec<u8>,
}

/// `antigravity.localharness.ToolResponse` — the payload the Go harness packs
/// into [`AgencyToolCall::response_messages`].
#[derive(Clone, PartialEq, ::prost::Message)]
struct HarnessToolResponse {
    #[prost(string, tag = "2")]
    response_json: String,
    #[prost(string, tag = "5")]
    error_message: String,
}

/// The fully-qualified message name that marks a [`ProtoAny`] as a harness tool
/// response.
const HARNESS_TOOL_RESPONSE_TYPE: &str = "antigravity.localharness.ToolResponse";

impl ProtoAny {
    /// Whether this `Any` holds `name`.
    ///
    /// A `type_url` is `<prefix>/<fully.qualified.Name>`, so the check is on
    /// the last path segment — NOT a suffix of the whole string, which
    /// `evil.antigravity.localharness.ToolResponse` would also satisfy. The
    /// payload is decoded only after this passes, because prost will happily
    /// read arbitrary bytes as a message of two strings and hand back junk;
    /// the type check, not the decode, is what makes that safe.
    fn holds(&self, name: &str) -> bool {
        self.type_url
            .rsplit('/')
            .next()
            .is_some_and(|declared| declared == name)
    }
}

/// `exa.cortex_pb.CortexStepAgencyToolCall` — the generic envelope the Go
/// localharness uses for tools it runs itself rather than through a dedicated
/// step arm. The same tool (`view_file`, …) can therefore arrive EITHER as its
/// own arm or wrapped in here, depending on which side executed it, so this is
/// decoded as well: without it such a step has no body, and a tool call with no
/// result renders as a spinner that never resolves.
#[derive(Clone, PartialEq, ::prost::Message)]
struct AgencyToolCall {
    #[prost(string, tag = "2")]
    function_name: String,
    #[prost(message, repeated, tag = "4")]
    response_messages: Vec<ProtoAny>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
struct SearchWeb {
    #[prost(string, tag = "1")]
    query: String,
    #[prost(string, tag = "5")]
    summary: String,
}

#[derive(Clone, PartialEq, ::prost::Message)]
struct ReadUrlContent {
    #[prost(string, tag = "1")]
    url: String,
    #[prost(string, tag = "3")]
    resolved_url: String,
}

/// `exa.cortex_pb.CortexErrorDetails`.
#[derive(Clone, PartialEq, ::prost::Message)]
struct ErrorDetails {
    #[prost(string, tag = "1")]
    user_error_message: String,
    #[prost(string, tag = "2")]
    short_error: String,
    #[prost(string, tag = "3")]
    full_error: String,
}

/// `exa.cortex_pb.AskQuestionOption`.
#[derive(Clone, PartialEq, ::prost::Message)]
struct AntigravityAskOption {
    #[prost(string, tag = "1")]
    id: String,
    #[prost(string, tag = "2")]
    text: String,
}

/// `exa.cortex_pb.AskQuestionEntry`: one question of an `ask_question` step and
/// the user's answer to it. Checked against the 1.4.1, 1.4.3, 1.4.4, 1.4.5,
/// 1.5.0 and 1.5.2 descriptors and live runs: options are numbered `"1"`, `"2"`, …; a
/// question the user dismissed (or never reached, once an earlier one was dismissed) is
/// `skipped` with nothing chosen; a multi-select question is still answered
/// with one option, because the ACP server asks it as a single-choice
/// permission request. From 1.5.2 a dismissed question ends the turn, and the
/// step is stored `CORTEX_STEP_STATUS_CANCELED` with nothing chosen and no
/// `skipped` (a Stop while the question waits stores the same; 1.5.0 stored no
/// step for that).
#[derive(Clone, PartialEq, ::prost::Message)]
struct AntigravityAskItem {
    #[prost(string, tag = "1")]
    question: String,
    #[prost(message, repeated, tag = "2")]
    options: Vec<AntigravityAskOption>,
    #[prost(bool, tag = "3")]
    is_multi_select: bool,
    /// `selected_option_ids`.
    #[prost(string, repeated, tag = "4")]
    chosen_ids: Vec<String>,
    #[prost(string, tag = "5")]
    write_in_response: String,
    #[prost(bool, tag = "6")]
    skipped: bool,
}

/// `exa.cortex_pb.CortexStepAskQuestion`, carried on `Step` field 154.
#[derive(Clone, PartialEq, ::prost::Message)]
struct AntigravityAskQuestions {
    #[prost(message, repeated, tag = "1")]
    items: Vec<AntigravityAskItem>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
struct ErrorMessageStep {
    #[prost(message, optional, tag = "3")]
    error: Option<ErrorDetails>,
    #[prost(bool, tag = "5")]
    should_show_user: bool,
}

// Native notifications include the original typed message. The sender id is
// independent of the human-readable (and possibly truncated) result text.
#[derive(Clone, PartialEq, ::prost::Message)]
struct SystemMessage {
    #[prost(string, tag = "3")]
    kind: String,
    #[prost(message, optional, tag = "4")]
    message: Option<TaskMessage>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
struct TaskMessage {
    #[prost(string, tag = "1")]
    id: String,
    #[prost(string, tag = "2")]
    recipient: String,
    #[prost(string, tag = "3")]
    sender: String,
    #[prost(int32, tag = "5")]
    priority: i32,
}

#[derive(Clone, PartialEq, ::prost::Message)]
struct NativeTask {
    #[prost(string, tag = "1")]
    id: String,
    #[prost(string, tag = "7")]
    title: String,
    #[prost(message, optional, tag = "8")]
    moved_to_background_at: Option<Timestamp>,
}

// Antigravity 1.5.13 executes shell and file tools through this generic arm.
#[derive(Clone, PartialEq, ::prost::Message)]
struct GenericTool {
    #[prost(message, optional, tag = "2")]
    result: Option<GenericResult>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
struct GenericResult {
    #[prost(string, tag = "1")]
    text: String,
    #[prost(message, optional, tag = "3")]
    render: Option<GenericRender>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
struct GenericRender {
    #[prost(message, optional, tag = "10")]
    details: Option<GenericRenderDetails>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
struct GenericRenderDetails {
    #[prost(message, optional, tag = "3")]
    command: Option<CommandResult>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
struct CommandResult {
    #[prost(int32, optional, tag = "3")]
    exit_code: Option<i32>,
    #[prost(string, tag = "4")]
    output: String,
}

/// `gemini_coder.Step`. Every field is one arm of the real `oneof step` (plus
/// the four common fields at the top), decoded as independent optionals — a
/// oneof is just ordinary fields on the wire.
#[derive(Clone, PartialEq, ::prost::Message)]
struct Step {
    #[prost(int32, tag = "4")]
    status: i32,
    #[prost(message, optional, tag = "5")]
    metadata: Option<StepMetadata>,
    #[prost(message, optional, tag = "31")]
    error: Option<ErrorDetails>,

    #[prost(message, optional, tag = "13")]
    grep_search: Option<GrepSearch>,
    #[prost(message, optional, tag = "14")]
    view_file: Option<ViewFile>,
    #[prost(message, optional, tag = "15")]
    list_directory: Option<ListDirectory>,
    #[prost(message, optional, tag = "19")]
    user_input: Option<UserInput>,
    #[prost(message, optional, tag = "20")]
    planner_response: Option<PlannerResponse>,
    #[prost(message, optional, tag = "23")]
    write_to_file: Option<WriteToFile>,
    #[prost(message, optional, tag = "24")]
    error_message: Option<ErrorMessageStep>,
    #[prost(message, optional, tag = "28")]
    run_command: Option<RunCommand>,
    #[prost(message, optional, tag = "40")]
    read_url_content: Option<ReadUrlContent>,
    #[prost(message, optional, tag = "42")]
    search_web: Option<SearchWeb>,
    #[prost(message, optional, tag = "47")]
    mcp_tool: Option<McpTool>,
    #[prost(message, optional, tag = "98")]
    file_change: Option<FileChange>,
    #[prost(message, optional, tag = "114")]
    system_message: Option<SystemMessage>,
    #[prost(message, optional, tag = "140")]
    generic_tool: Option<GenericTool>,
    #[prost(message, optional, tag = "148")]
    task: Option<NativeTask>,
    #[prost(message, optional, tag = "116")]
    agency_tool_call: Option<AgencyToolCall>,
    #[prost(message, optional, tag = "154")]
    ask_question: Option<AntigravityAskQuestions>,
}

const STEP_STATUS_DONE: i32 = 3;
/// `CORTEX_STEP_STATUS_CANCELED`.
const STEP_STATUS_CANCELED: i32 = 6;
const STEP_STATUS_ERROR: i32 = 7;

impl Step {
    fn terminal(&self) -> bool {
        matches!(self.status, 3..=7 | 12)
    }

    fn task_message(&self) -> Option<&TaskMessage> {
        let notification = self.system_message.as_ref()?;
        (notification.kind == "task_notification").then_some(notification.message.as_ref()?)
    }

    fn final_answer(&self) -> bool {
        self.status == STEP_STATUS_DONE
            && self.planner_response.as_ref().is_some_and(|planner| {
                planner.tool_calls.is_empty() && !planner.response.trim().is_empty()
            })
    }

    fn generic_result(&self) -> Option<&GenericResult> {
        self.generic_tool.as_ref()?.result.as_ref()
    }

    fn command_result(&self) -> Option<&CommandResult> {
        self.generic_result()?
            .render
            .as_ref()?
            .details
            .as_ref()?
            .command
            .as_ref()
    }

    fn exit_code(&self) -> Option<i64> {
        self.command_result()
            .and_then(|r| r.exit_code)
            .or_else(|| self.run_command.as_ref().map(|r| r.exit_code))
            .map(i64::from)
    }
}

impl Timestamp {
    fn to_utc(&self) -> Option<DateTime<Utc>> {
        Utc.timestamp_opt(self.seconds, self.nanos.clamp(0, 999_999_999) as u32)
            .single()
    }
}

impl ErrorDetails {
    /// The most user-facing message this error carries, if any.
    fn best_message(&self) -> Option<String> {
        [
            &self.user_error_message,
            &self.short_error,
            &self.full_error,
        ]
        .into_iter()
        .find(|s| !s.trim().is_empty())
        .map(|s| truncate_str(s, TOOL_OUTPUT_CAP))
    }

    /// The executor's raw error string, the one the ACP server words its
    /// account from (see [`failure`]).
    fn raw_error(&self) -> Option<&str> {
        [&self.short_error, &self.full_error]
            .into_iter()
            .map(|s| s.trim())
            .find(|s| !s.is_empty())
    }
}

/// A failure that ENDED a turn, worded as the ACP server told it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TurnFailure {
    pub(crate) text: String,
    /// AIR category (`access|limit|request|service|unknown`).
    pub(crate) category: &'static str,
}

impl Step {
    /// The failure this step records as ending the turn: an `error_message`
    /// step the server marked `should_show_user`. agy 1.5.2 stores one when
    /// the agent executor dies (the model API refused, the quota ran out, …)
    /// and the server then sends the user its account as a plain
    /// `agent_message_chunk` and ends the turn `end_turn`. An `error_message`
    /// WITHOUT the flag is model-facing (an invalid tool call the model is
    /// asked to fix), and the turn goes on.
    fn turn_failure(&self) -> Option<TurnFailure> {
        let step = self.error_message.as_ref().filter(|e| e.should_show_user)?;
        let details = step.error.as_ref()?;
        let (text, category) = match details.raw_error() {
            Some(raw) => (
                failure::turn_failure_text(raw),
                failure::failure_category(raw),
            ),
            None => (details.user_error_message.trim().to_string(), "unknown"),
        };
        (!text.trim().is_empty()).then(|| TurnFailure {
            text: truncate_str(text.trim(), TOOL_OUTPUT_CAP),
            category,
        })
    }
}

/// The failure the newest round of `session_id`'s trajectory ended on, with
/// the step's position among the decoded steps (stable, and unique within the
/// session) — `None` when that round did not end on one, or when its prompt
/// was stored before `since` (the turn that just ended has not reached the
/// trajectory, and the newest round is an earlier one).
///
/// The live counterpart of the failure line [`project_steps`] draws: read when
/// a turn ends, because the server tells the failure as an ordinary reply
/// chunk. Measured on 1.5.2: the step is on disk before the prompt response
/// is sent.
pub(crate) fn newest_round_failure(
    sessions_dir: &Path,
    session_id: &str,
    since: DateTime<Utc>,
) -> Option<(usize, TurnFailure)> {
    if !crate::parsers::is_safe_subagent_id(session_id) {
        return None;
    }
    let fallback = default_trajectory_dir();
    let (steps, _) = read_trajectory(&session_db_path(
        sessions_dir,
        fallback.as_deref(),
        session_id,
    ));
    let prompt = steps.iter().rposition(|step| step.user_input.is_some())?;
    let prompted_at = steps[prompt]
        .metadata
        .as_ref()
        .and_then(|m| m.created_at.as_ref())
        .and_then(Timestamp::to_utc)?;
    if prompted_at < since {
        return None;
    }
    let mut failure = None;
    for (position, step) in steps.iter().enumerate().skip(prompt + 1) {
        if let Some(found) = step.turn_failure() {
            failure = Some((position, found));
        } else if step.planner_response.as_ref().is_some_and(|planner| {
            !planner.response.trim().is_empty() || !planner.tool_calls.is_empty()
        }) {
            // The model went on after it: that failure did not end the turn.
            failure = None;
        }
    }
    failure
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/// `agy` keeps its tree beneath the OS home unless told otherwise (1.5.13
/// wrote there even with GEMINI_HOME in its environment; codeg now passes
/// `--gemini-dir` instead). Resolve only the requested session there; a
/// different configured profile must not be merged wholesale with the
/// default profile.
fn default_trajectory_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|home| {
        home.join(".gemini")
            .join(CLI_SUBDIR)
            .join(SESSIONS_DIR_NAME)
    })
}

fn session_db_path(directory: &Path, fallback: Option<&Path>, id: &str) -> PathBuf {
    let name = format!("{id}.db");
    let configured = directory.join(&name);
    if configured.is_file() {
        return configured;
    }
    fallback
        .map(|dir| dir.join(name))
        .filter(|path| path.is_file())
        .unwrap_or(configured)
}

pub struct AntigravityParser {
    base_dir: PathBuf,
    /// Sessions the standalone `agy_acp_server` wrote before codeg switched to
    /// `agy acp`. Still listed so that history does not disappear.
    legacy_dir: Option<PathBuf>,
    /// The CLI's default tree under the OS home, consulted only for a session
    /// the caller already identified (see [`default_trajectory_dir`]).
    fallback: Option<PathBuf>,
}

impl AntigravityParser {
    pub fn new() -> Self {
        Self::for_env(&AgentEnv::inherited())
    }

    /// The history of the Antigravity CLI launched with `env`.
    pub fn for_env(env: &AgentEnv) -> Self {
        let base_dir = resolve_antigravity_sessions_dir_for_env(env);
        let legacy = resolve_antigravity_legacy_sessions_dir_for_env(env);
        let legacy_dir = (legacy != base_dir).then_some(legacy);
        let fallback = default_trajectory_dir().filter(|dir| *dir != base_dir);
        Self {
            base_dir,
            legacy_dir,
            fallback,
        }
    }

    /// Construct a parser pointed at an explicit `conversations/` directory
    /// (test fixtures).
    #[cfg(any(test, feature = "test-utils"))]
    pub fn with_base_dir(base_dir: PathBuf) -> Self {
        Self {
            base_dir,
            legacy_dir: None,
            fallback: None,
        }
    }

    fn dirs(&self) -> impl Iterator<Item = &PathBuf> {
        std::iter::once(&self.base_dir).chain(self.legacy_dir.iter())
    }

    fn resolve_db(&self, conversation_id: &str) -> Option<PathBuf> {
        self.dirs()
            .chain(self.fallback.iter())
            .map(|dir| dir.join(format!("{conversation_id}.db")))
            .find(|path| path.is_file())
    }

    fn resolve_meta(&self, conversation_id: &str) -> Option<PathBuf> {
        self.dirs()
            .map(|dir| dir.join(format!("{conversation_id}.{METADATA_FILE_SUFFIX}")))
            .find(|path| path.is_file())
    }

    /// `<cli>/conversation_summaries.db`, the CLI's own index beside the
    /// `conversations/` directory. The standalone server kept no such index;
    /// its cwd came from the `.meta` sidecar.
    fn summary_db_path(&self) -> PathBuf {
        self.base_dir
            .parent()
            .map(|parent| parent.join(SUMMARY_DB_NAME))
            .unwrap_or_default()
    }

    fn build(
        &self,
        conversation_id: &str,
        db_path: &Path,
        summary_cwds: Option<&HashMap<String, String>>,
    ) -> SessionParse {
        let (steps, watermark) = read_trajectory(db_path);
        let mut parsed = project_steps(&steps);
        parsed.watermark = watermark;
        // 优先读与该 `.db` 同目录的 `.meta` sidecar（旧 standalone server 格式），
        // 再读轨迹库自身的 `trajectory_metadata_blob`，然后查
        // `conversation_summaries.db`（新 CLI 格式），最后才回退到旧目录同名
        // `.meta`，避免其意外覆盖新 CLI 会话的工作区。
        let sibling_meta = db_path.with_extension(METADATA_FILE_SUFFIX);
        parsed.cwd = sibling_meta
            .is_file()
            .then(|| read_sidecar_cwd(&sibling_meta))
            .flatten()
            // The CLI's own trajectory records its workspace, so a session
            // restored from a backup (or copied between machines) without the
            // shared `conversation_summaries.db` row still knows its folder.
            .or_else(|| read_trajectory_cwd(db_path))
            .or_else(|| {
                if let Some(map) = summary_cwds {
                    map.get(conversation_id).cloned()
                } else {
                    read_summary_cwd(&self.summary_db_path(), conversation_id)
                }
            })
            .or_else(|| {
                self.resolve_meta(conversation_id)
                    .and_then(|path| read_sidecar_cwd(&path))
            });
        parsed
    }

    fn summary_from(&self, conversation_id: &str, parsed: &SessionParse) -> ConversationSummary {
        ConversationSummary {
            id: conversation_id.to_string(),
            agent_type: AgentType::Antigravity,
            folder_name: parsed.cwd.as_deref().map(folder_name_from_path),
            folder_path: parsed.cwd.clone(),
            title: parsed.first_user_text.clone(),
            started_at: parsed.first_ts.unwrap_or_else(Utc::now),
            ended_at: parsed.last_ts,
            message_count: parsed.message_count,
            model: parsed.model.clone(),
            git_branch: None,
            parent_id: None,
            parent_tool_use_id: None,
            delegation_call_id: None,
        }
    }
}

impl Default for AntigravityParser {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentParser for AntigravityParser {
    fn list_conversations(&self) -> Result<Vec<ConversationSummary>, ParseError> {
        let mut conversations = Vec::new();
        let mut seen = HashSet::new();
        // 一次性读取 `conversation_summaries.db` 的工作区索引，避免列表扫描时
        // 为每个会话反复开关 SQLite 连接（N+1 I/O）。
        let summary_cwds = load_summary_cwds(&self.summary_db_path());

        for dir in self.dirs() {
            let Ok(entries) = std::fs::read_dir(dir) else {
                continue;
            };

            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_file() || path.extension().and_then(|e| e.to_str()) != Some("db") {
                    continue;
                }
                let Some(conversation_id) =
                    path.file_stem().map(|s| s.to_string_lossy().into_owned())
                else {
                    continue;
                };
                // The CLI directory is scanned first; an id present in both
                // trees is the same conversation, and the CLI copy is current.
                if !seen.insert(conversation_id.clone()) {
                    continue;
                }
                let parsed = self.build(&conversation_id, &path, Some(&summary_cwds));
                // A session whose DB is still the pre-created empty file (or
                // which was cleared) has no content to show — matching the
                // other parsers' "metadata-only is not listed" rule.
                if parsed.turns.is_empty() {
                    continue;
                }
                conversations.push(self.summary_from(&conversation_id, &parsed));
            }
        }

        conversations.sort_by_key(|c| std::cmp::Reverse(c.started_at));
        Ok(conversations)
    }

    fn get_conversation(&self, conversation_id: &str) -> Result<ConversationDetail, ParseError> {
        let db_path = crate::parsers::is_safe_subagent_id(conversation_id)
            .then(|| self.resolve_db(conversation_id))
            .flatten();
        let Some(db_path) = db_path else {
            return Err(ParseError::ConversationNotFound(
                conversation_id.to_string(),
            ));
        };
        let parsed = self.build(conversation_id, &db_path, None);

        let mut turns = parsed.turns.clone();
        relocate_orphaned_tool_results(&mut turns);
        structurize_read_tool_output(&mut turns);
        backfill_turn_durations(&mut turns, &[]);

        // Context-window occupancy is the LATEST step's input side, never the
        // per-turn sum: usage is recorded per step and every step re-sends the
        // whole prefix, so summing would re-count the cached prompt once per
        // step. Capacity is inferred from the model name — the trajectory
        // records no window size of its own.
        let mut unplaced = TurnUsage::default();
        for (at, usage) in &parsed.spend_elsewhere {
            if !crate::parsers::add_usage_to_turn_current_at(&mut turns, *at, usage) {
                unplaced = TurnUsage {
                    input_tokens: unplaced.input_tokens.saturating_add(usage.input_tokens),
                    output_tokens: unplaced.output_tokens.saturating_add(usage.output_tokens),
                    cache_creation_input_tokens: unplaced
                        .cache_creation_input_tokens
                        .saturating_add(usage.cache_creation_input_tokens),
                    cache_read_input_tokens: unplaced
                        .cache_read_input_tokens
                        .saturating_add(usage.cache_read_input_tokens),
                };
            }
        }
        let max_tokens = infer_context_window_max_tokens(parsed.model.as_deref());
        let session_stats = merge_context_window_stats(
            crate::parsers::add_unplaced_usage_to_total(compute_session_stats(&turns), &unplaced),
            parsed.last_step_input_side,
            max_tokens,
        );

        Ok(ConversationDetail {
            summary: self.summary_from(conversation_id, &parsed),
            turns,
            session_stats,
            transcript_watermark: parsed.watermark,
        })
    }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/// Read every `steps` row in `idx` order. Returns an empty vec — never an
/// error — for the states that are normal rather than broken: the 0-byte DB a
/// brand-new session starts as (no `steps` table yet), a file the ACP server
/// currently holds, or a payload that fails to decode.
fn read_trajectory(db_path: &Path) -> (Vec<Step>, Option<u64>) {
    let Some(conn) = open_trajectory(db_path) else {
        return (Vec::new(), None);
    };
    let Ok(mut stmt) = conn.prepare("SELECT idx, step_payload FROM steps ORDER BY idx") else {
        return (Vec::new(), None);
    };
    let Ok(rows) = stmt.query_map([], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
    }) else {
        return (Vec::new(), None);
    };

    let mut steps = Vec::new();
    let mut watermark = None;
    for (idx, payload) in rows.flatten() {
        match Step::decode(payload.as_slice()) {
            Ok(step) => {
                // An in-progress planner row is rewritten at the same index.
                // Only its final content covers a published background reply.
                if step.final_answer()
                    || step
                        .error_message
                        .as_ref()
                        .is_some_and(|e| e.should_show_user)
                {
                    watermark = Some((idx + 1) as u64);
                }
                steps.push(step);
            }
            // One unreadable step must not sink the conversation; the rest of
            // the trajectory still renders.
            Err(err) => {
                tracing::debug!(
                    "[antigravity] skipping undecodable step in {}: {err}",
                    db_path.display()
                );
            }
        }
    }
    (steps, watermark)
}

fn open_trajectory(db_path: &Path) -> Option<Connection> {
    // A brand-new session's DB is pre-created at 0 bytes before the harness
    // writes the schema. Opening it read-only succeeds and then fails on the
    // query; skipping it here keeps the debug log honest.
    if std::fs::metadata(db_path).ok()?.len() == 0 {
        return None;
    }
    // codeg never mutates the server's stores, so ask for a read-only handle;
    // fall back to read-write (no CREATE) exactly as the Cursor parser does,
    // because a live WAL whose index needs recovery cannot be recovered from a
    // read-only connection (SQLITE_READONLY_RECOVERY).
    try_open_trajectory(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .or_else(|| {
        try_open_trajectory(
            db_path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
    })
}

fn try_open_trajectory(db_path: &Path, flags: OpenFlags) -> Option<Connection> {
    let conn = Connection::open_with_flags(db_path, flags).ok()?;
    // The server may hold the trajectory open while codeg lists sessions; give
    // reads a short grace period rather than failing on a transient lock.
    let _ = conn.busy_timeout(std::time::Duration::from_millis(200));
    // Opening is lazy — probe so a handle that cannot actually read reports
    // failure here instead of silently yielding no rows.
    conn.query_row("SELECT count(*) FROM steps", [], |row| row.get::<_, i64>(0))
        .ok()?;
    Some(conn)
}

/// The `cwd` the session ran in, from its `.meta` sidecar. Deliberately no
/// fallback to the Gemini home (which is what the server's own `session/list`
/// substitutes): an unknown cwd must read as unknown here, not as a folder the
/// user never worked in.
fn read_sidecar_cwd(meta_path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(meta_path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    value
        .get("cwd")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// `trajectory_metadata_blob.data` — the per-conversation metadata record, a
/// protobuf in the trajectory `.db` itself. Only the workspace is read.
///
/// Field 7 is REPEATED: `agy acp` (1.5.18) writes the session folder once,
/// while the standalone server wrote the session folder first and then every
/// skill directory it scanned (`…/.gemini/skills`, `…/.agents/skills`, …), so
/// the FIRST entry is the folder — a singular field would keep the last one
/// and name a skills directory instead. Checked against every legacy session
/// on a real machine that has the record: the first entry equalled the
/// `.meta` sidecar's `cwd` in all 27. Field 1 (CLI only) is the workspace set,
/// whose first URI is the same folder; the CLI's values also match
/// `conversation_summaries.workspace_uris`.
#[derive(Clone, PartialEq, ::prost::Message)]
struct TrajectoryMetadata {
    #[prost(message, optional, tag = "1")]
    workspaces: Option<TrajectoryWorkspaces>,
    #[prost(string, repeated, tag = "7")]
    workspace_uris: Vec<String>,
}

#[derive(Clone, PartialEq, ::prost::Message)]
struct TrajectoryWorkspaces {
    #[prost(string, tag = "1")]
    primary_uri: String,
}

/// The workspace folder a CLI session ran in, from its own trajectory `.db`.
fn read_trajectory_cwd(db_path: &Path) -> Option<String> {
    let conn = open_trajectory(db_path)?;
    let data: Vec<u8> = conn
        .query_row(
            "SELECT data FROM trajectory_metadata_blob ORDER BY id = 'main' DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .ok()?;
    let meta = TrajectoryMetadata::decode(data.as_slice()).ok()?;
    meta.workspace_uris
        .into_iter()
        .next()
        .into_iter()
        .chain(meta.workspaces.map(|w| w.primary_uri))
        .find_map(|uri| file_uri_to_path(&uri))
}

/// 打开 CLI 的 `conversation_summaries.db`（表为 `conversation_summaries`，
/// 不存在轨迹库的 `steps` 表，不能复用 `try_open_trajectory`）。
fn open_summary_db(summary_db: &Path) -> Option<Connection> {
    if !summary_db.is_file() || std::fs::metadata(summary_db).ok()?.len() == 0 {
        return None;
    }
    try_open_summary_db(
        summary_db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .or_else(|| {
        try_open_summary_db(
            summary_db,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
    })
}

fn try_open_summary_db(db_path: &Path, flags: OpenFlags) -> Option<Connection> {
    let conn = Connection::open_with_flags(db_path, flags).ok()?;
    let _ = conn.busy_timeout(std::time::Duration::from_millis(200));
    conn.prepare("SELECT 1 FROM conversation_summaries LIMIT 1")
        .ok()?;
    Some(conn)
}

/// 批量加载 `conversation_summaries.db` 中所有会话的首个工作区路径，供
/// `list_conversations` 复用单次连接。
fn load_summary_cwds(summary_db: &Path) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Some(conn) = open_summary_db(summary_db) else {
        return map;
    };
    let Ok(mut stmt) = conn.prepare(
        "SELECT conversation_id, workspace_uris FROM conversation_summaries WHERE workspace_uris != ''",
    ) else {
        return map;
    };
    let Ok(rows) = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    }) else {
        return map;
    };
    for (id, raw) in rows.flatten() {
        if let Some(path) = parse_primary_workspace_uri(&raw) {
            map.insert(id, path);
        }
    }
    map
}

/// The workspace the CLI session ran in, from `conversation_summaries`.
/// `workspace_uris` is a JSON array of `file://` URIs (the CLI's own
/// `session/list` reads the same column); the first entry is the session's
/// primary folder.
fn read_summary_cwd(summary_db: &Path, conversation_id: &str) -> Option<String> {
    let conn = open_summary_db(summary_db)?;
    let raw: String = conn
        .query_row(
            "SELECT workspace_uris FROM conversation_summaries WHERE conversation_id = ?1",
            [conversation_id],
            |row| row.get(0),
        )
        .ok()?;
    parse_primary_workspace_uri(&raw)
}

fn parse_primary_workspace_uri(raw: &str) -> Option<String> {
    let uris: Vec<String> = serde_json::from_str(raw).ok()?;
    uris.into_iter().find_map(|uri| file_uri_to_path(&uri))
}

/// 将 CLI 记录的 `file://` URI（含 `file://localhost/...`、百分号编码、
/// Windows 盘符 `file:///C:/...`）转为本地文件系统路径。
fn file_uri_to_path(uri: &str) -> Option<String> {
    let parsed = url::Url::parse(uri).ok()?;
    if parsed.scheme() != "file" {
        return None;
    }
    parsed
        .to_file_path()
        .ok()
        .map(|path| path.to_string_lossy().into_owned())
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

#[derive(Default, Clone)]
struct SessionParse {
    watermark: Option<u64>,
    turns: Vec<MessageTurn>,
    cwd: Option<String>,
    /// First user prompt, already truncated for use as the title.
    first_user_text: Option<String>,
    /// Latest `metadata.model_info` name.
    model: Option<String>,
    /// The latest single step's input side (`input + cache_read`) — the
    /// context-window occupancy. NOT the per-turn sum (see `get_conversation`).
    last_step_input_side: Option<u64>,
    first_ts: Option<DateTime<Utc>>,
    last_ts: Option<DateTime<Utc>>,
    /// User prompts + assistant text messages: the list view's activity count.
    message_count: u32,
    /// Spend no turn carries: `(when, usage)` — steps of a turn that rendered
    /// nothing, and a failing step's own call.
    spend_elsewhere: Vec<(Option<DateTime<Utc>>, TurnUsage)>,
}

/// Accumulator for the assistant turn currently being built.
#[derive(Default)]
struct PendingAssistant {
    blocks: Vec<ContentBlock>,
    usage: TurnUsage,
    has_usage: bool,
    model: Option<String>,
    first_ts: Option<DateTime<Utc>>,
    last_ts: Option<DateTime<Utc>>,
}

impl PendingAssistant {
    fn is_empty(&self) -> bool {
        self.blocks.is_empty()
    }

    /// The usage of a turn being dropped for having nothing to show: its steps
    /// were billed all the same.
    fn unshown_spend(&self) -> Option<(Option<DateTime<Utc>>, TurnUsage)> {
        (self.is_empty() && self.has_usage)
            .then(|| (self.last_ts.or(self.first_ts), self.usage.clone()))
    }

    fn finish(&mut self, id: String, fallback_ts: DateTime<Utc>) -> MessageTurn {
        let timestamp = self.first_ts.unwrap_or(fallback_ts);
        MessageTurn {
            id,
            role: TurnRole::Assistant,
            blocks: std::mem::take(&mut self.blocks),
            timestamp,
            usage: std::mem::take(&mut self.has_usage).then(|| std::mem::take(&mut self.usage)),
            duration_ms: None,
            model: self.model.take(),
            completed_at: self.last_ts,
            agent_message_id: None,
        }
    }
}

/// The `ChatToolCall` a tool step correlates by. `metadata.tool_call` is what
/// the planner announced; an MCP step also repeats it in its own body, which is
/// the fallback for steps the metadata does not carry it on. ONE definition,
/// used both by the projection loop and by the `resolved` sweep it depends on —
/// two walkers that disagreed would settle a call that does get answered.
fn correlating_call(step: &Step) -> Option<&ChatToolCall> {
    step.metadata
        .as_ref()
        .and_then(|m| m.tool_call.as_ref())
        .or_else(|| step.mcp_tool.as_ref().and_then(|t| t.tool_call.as_ref()))
}

fn project_steps(steps: &[Step]) -> SessionParse {
    let mut parsed = SessionParse::default();
    let mut pending = PendingAssistant::default();
    // Tool-call ids already announced by a `planner_response`, so a tool step
    // that repeats its own `metadata.tool_call` does not render a second card.
    let mut announced: std::collections::HashSet<String> = std::collections::HashSet::new();
    // Two facts about every correlated call id, gathered before projecting,
    // because the settling pass below has to know what the REST of the
    // trajectory says about a call it is looking at now:
    //
    //   `resolved` — some step renders a real result for this id, so the
    //     settling pass must stay out of the way. A `tool_call_proposal` and
    //     the execution it proposes share one id, and settling the proposal in
    //     place would give that one card two results.
    //   `failed_unresolved` — for the ids nothing answers, whether ANY of
    //     their steps failed. The single settling result is emitted at the
    //     first occurrence (so it stays adjacent to its call card), which on
    //     its own would report the status of whichever step came first.
    //
    // The predicate is `step_outcome` ITSELF rather than a cheaper mirror of
    // which arms it handles. A mirror is a second source of truth that drifts:
    // "the step has an `error` submessage" is not the same as "`step_outcome`
    // renders something", because an error carrying only fields this parser
    // does not model decodes to a present-but-blank `ErrorDetails` — which the
    // mirror counts as resolved and `step_outcome` does not, suppressing
    // exactly the settling result this sweep exists to emit.
    let mut resolved: std::collections::HashSet<&str> = std::collections::HashSet::new();
    let mut failed_unresolved: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for step in steps {
        let Some(id) = correlating_call(step)
            .map(|call| call.id.as_str())
            .filter(|id| !id.is_empty())
        else {
            continue;
        };
        if step_outcome(step).is_some() {
            resolved.insert(id);
        } else if step.status == STEP_STATUS_ERROR {
            failed_unresolved.insert(id);
        }
    }
    // Ids already given a settling result. Several steps can share one id and
    // all be unmodelled (a proposal and its choice, say); each would otherwise
    // append its own result, leaving one call card answered two or three times
    // — and, when their statuses differ, answered both ways.
    let mut settled: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut turn_index = 0_usize;
    let mut background_id = None;
    let mut yielded = false;

    for (idx, step) in steps.iter().enumerate() {
        let ts = step
            .metadata
            .as_ref()
            .and_then(|m| m.created_at.as_ref())
            .and_then(Timestamp::to_utc);
        if let Some(ts) = ts {
            parsed.first_ts.get_or_insert(ts);
            parsed.last_ts = Some(ts);
        }

        // FLUSH BEFORE ABSORBING. A user step closes the assistant turn before
        // it, so none of this step's clocks may reach that turn: folding the
        // next prompt's timestamp into it would set `completed_at` to whenever
        // the user came back, and `backfill_turn_durations` would then report
        // the idle gap — possibly hours — as the response's duration.
        let wake = step
            .task_message()
            .filter(|msg| msg.priority == 3 && yielded && !msg.id.is_empty());
        if step.user_input.is_some() || wake.is_some() {
            if !pending.is_empty() {
                let fallback = pending.last_ts.or(ts).unwrap_or_else(Utc::now);
                let id = background_id
                    .take()
                    .unwrap_or_else(|| format!("agy-{turn_index}"));
                parsed.turns.push(pending.finish(id, fallback));
                turn_index += 1;
            }
            parsed.spend_elsewhere.extend(pending.unshown_spend());
            pending = PendingAssistant::default();
            background_id = wake.map(|msg| format!("agy-bg-{}", msg.id));
            yielded = false;
        }
        if let Some(user_input) = step.user_input.as_ref() {
            let Some(text) = user_input_text(user_input) else {
                continue;
            };
            parsed
                .first_user_text
                .get_or_insert_with(|| title_from_user_text(&text));
            parsed.turns.push(MessageTurn {
                id: format!("agy-{idx}-user"),
                role: TurnRole::User,
                blocks: vec![ContentBlock::Text {
                    text: truncate_str(&text, TEXT_CAP),
                }],
                timestamp: ts.unwrap_or_else(Utc::now),
                usage: None,
                duration_ms: None,
                model: None,
                completed_at: None,
            agent_message_id: None,
            });
            parsed.message_count = parsed.message_count.saturating_add(1);
            continue;
        }

        // A failure that ended the turn closes the round as its failure line
        // (`turn_error_message`), never as a reply or a tool result: it is the
        // server's account, not the model's words, and nothing was called.
        // The work before it stays its own assistant turn.
        if let Some(failure) = step.turn_failure() {
            // What the failing call itself cost, should the step report it.
            if let Some(usage) = step.metadata.as_ref().and_then(|m| m.model_usage.as_ref()) {
                parsed.spend_elsewhere.push((
                    ts,
                    TurnUsage {
                        input_tokens: usage.input_tokens,
                        output_tokens: usage.output_tokens,
                        cache_creation_input_tokens: usage.cache_write_tokens,
                        cache_read_input_tokens: usage.cache_read_tokens,
                    },
                ));
            }
            if let Some(unshown) = pending.unshown_spend() {
                parsed.spend_elsewhere.push(unshown);
                pending = PendingAssistant::default();
            }
            if !pending.is_empty() {
                let fallback = pending.last_ts.or(ts).unwrap_or_else(Utc::now);
                let id = background_id
                    .take()
                    .unwrap_or_else(|| format!("agy-{turn_index}"));
                parsed.turns.push(pending.finish(id, fallback));
                turn_index += 1;
                pending = PendingAssistant::default();
            }
            if let Some(line) = crate::parsers::turn_error_message(
                format!("agy-{idx}-error"),
                &failure.text,
                ts.unwrap_or_else(Utc::now),
            ) {
                parsed.turns.push(MessageTurn {
                    id: line.id,
                    role: TurnRole::System,
                    blocks: line.content,
                    timestamp: line.timestamp,
                    usage: None,
                    duration_ms: None,
                    model: None,
                    completed_at: line.completed_at,
                    agent_message_id: None,
                });
            }
            continue;
        }

        if let Some(model) = step
            .metadata
            .as_ref()
            .and_then(|m| m.model_info.as_ref())
            .and_then(display_model_name)
        {
            if pending.model.is_none() {
                pending.model = Some(model.clone());
            }
            parsed.model = Some(model);
        }

        if let Some(usage) = step.metadata.as_ref().and_then(|m| m.model_usage.as_ref()) {
            // Per-step usage SUMS into the turn (cost accounting) while the
            // window gauge tracks only the latest step's input side.
            pending.usage.input_tokens = pending.usage.input_tokens.saturating_add(usage.input_tokens);
            pending.usage.output_tokens = pending
                .usage
                .output_tokens
                .saturating_add(usage.output_tokens);
            pending.usage.cache_read_input_tokens = pending
                .usage
                .cache_read_input_tokens
                .saturating_add(usage.cache_read_tokens);
            pending.usage.cache_creation_input_tokens = pending
                .usage
                .cache_creation_input_tokens
                .saturating_add(usage.cache_write_tokens);
            pending.has_usage = true;
            let input_side = usage.input_tokens.saturating_add(usage.cache_read_tokens);
            if input_side > 0 {
                parsed.last_step_input_side = Some(input_side);
            }
        }

        if let Some(ts) = ts {
            pending.first_ts.get_or_insert(ts);
        }
        // The turn finishes when its LAST step did, which the harness records
        // separately from when that step was created — a long-running command
        // can put minutes between the two. `completed_at` when present, else
        // the step's own clock.
        if let Some(done) = step
            .metadata
            .as_ref()
            .and_then(|m| m.completed_at.as_ref())
            .and_then(Timestamp::to_utc)
            .or(ts)
        {
            pending.last_ts = Some(done);
            // A step that outlived its creation also extends the session.
            parsed.last_ts = Some(match parsed.last_ts {
                Some(previous) if previous > done => previous,
                _ => done,
            });
        }

        if let Some(planner) = step.planner_response.as_ref() {
            yielded = step.final_answer();
            if !planner.thinking.trim().is_empty() {
                pending.blocks.push(ContentBlock::Thinking {
                    text: truncate_str(&planner.thinking, TEXT_CAP),
                });
            }
            if !planner.response.trim().is_empty() {
                pending.blocks.push(ContentBlock::Text {
                    text: truncate_str(&planner.response, TEXT_CAP),
                });
                parsed.message_count = parsed.message_count.saturating_add(1);
            }
            for call in &planner.tool_calls {
                announced.insert(call.id.clone());
                pending.blocks.push(tool_use_block(call));
            }
            continue;
        }

        // Everything else is a tool execution. `metadata.tool_call` is the
        // correlation key the planner announced; when it was NOT announced
        // (a server-injected step, or a flow that skips the announcement)
        // synthesize the call card too, or the result would render orphaned.
        let call = correlating_call(step);
        let Some(outcome) = step_outcome(step) else {
            // No recognized body and no error: a bookkeeping step
            // (checkpoints, task boundaries, …) with nothing to render — unless
            // it carries a tool call, in which case it IS a tool execution this
            // parser does not model.
            let Some(call) = call else { continue };
            if announced.insert(call.id.clone()) {
                pending.blocks.push(tool_use_block(call));
            }
            // Such a call must still SETTLE. A `ToolUse` with no matching
            // `ToolResult` adapts to `input-available`, which renders as a
            // spinner — and nothing will ever finish it, because a persisted
            // transcript has no live channel behind it. An empty result reads
            // as "no detail we could decode"; a spinner reads as "still
            // running", which is never true of a step already on disk.
            if !call.id.is_empty()
                && !resolved.contains(call.id.as_str())
                && settled.insert(call.id.clone())
            {
                pending.blocks.push(ContentBlock::ToolResult {
                    tool_use_id: Some(call.id.clone()),
                    output_preview: None,
                    is_error: failed_unresolved.contains(call.id.as_str()),
                    agent_stats: None,
                    images: Vec::new(),
                    exit_code: None,
                });
            }
            continue;
        };

        if let Some(call) = call {
            if announced.insert(call.id.clone()) {
                pending.blocks.push(tool_use_block(call));
            }
        }
        pending.blocks.push(ContentBlock::ToolResult {
            tool_use_id: call.map(|c| c.id.clone()).filter(|id| !id.is_empty()),
            output_preview: outcome.output,
            is_error: outcome.is_error,
            agent_stats: None,
            images: Vec::new(),
            // A proto3 int: a run that exited 0 leaves it off the wire, which
            // decodes to the same 0.
            exit_code: step.exit_code(),
        });
    }

    parsed.spend_elsewhere.extend(pending.unshown_spend());
    if !pending.is_empty() {
        let fallback = parsed.last_ts.unwrap_or_else(Utc::now);
        let turn = pending.finish(
            background_id.unwrap_or_else(|| format!("agy-{turn_index}")),
            fallback,
        );
        parsed.turns.push(turn);
    }

    parsed
}

fn display_model_name(info: &ModelInfo) -> Option<String> {
    [&info.model_name, &info.display_name]
        .into_iter()
        .find(|s| !s.trim().is_empty())
        .map(|s| s.trim().to_string())
}

/// The sentinel name the SDK gives EVERY MCP call — the real tool identity
/// lives inside the arguments envelope, not in the call's `name`. Mirrors
/// `acp_server/tools.py::MCP_DISPATCH_TOOL_NAME`.
const MCP_DISPATCH_TOOL_NAME: &str = "call_mcp_tool";

/// Keys the server scans, in order, for a human sentence describing an MCP call
/// (`unwrap_mcp_tool_call`'s `prompt_keys`).
const MCP_PROMPT_KEYS: [&str; 5] = [
    "prompt",
    "Description",
    "description",
    "toolAction",
    "toolSummary",
];

/// Re-present an MCP dispatch the way the LIVE ACP stream already does.
///
/// Every MCP call reaches the trajectory as the SDK's PascalCase envelope —
/// `{"ServerName": …, "ToolName": …, "Arguments": {…}}` — under the sentinel
/// name `call_mcp_tool`, on BOTH the planner's announcement and the executing
/// step. Projected verbatim, every MCP call in a session is named
/// "call_mcp_tool" and its real identity is buried in a JSON blob, so none of
/// codeg's MCP-aware cards (delegation, ask-question, the workbench
/// companions) can match it.
///
/// The server does not ship that shape to ACP clients either:
/// `tools.py::unwrap_mcp_tool_call` rewrites it to `<server>_<tool>` with
/// `{"arguments": {…}}` before it goes on the wire. This is the same rewrite,
/// so the historical and live views resolve to the same tool. 1.2 also copies
/// the arguments onto the top level and moves the sentence into `_meta`; the
/// live path folds that back into this shape
/// (`acp::connection::fold_antigravity_mcp_raw_input`) rather than this one
/// doubling every input against `TOOL_INPUT_CAP`.
///
/// `None` means "not an MCP envelope" — every native tool, plus any envelope
/// missing `ToolName` or whose `Arguments` is not an object, which is exactly
/// upstream's own no-op condition.
fn unwrap_mcp_dispatch(call: &ChatToolCall) -> Option<(String, String)> {
    let parsed: serde_json::Value = serde_json::from_str(call.arguments_json.trim()).ok()?;
    let envelope = parsed.as_object()?;
    // Upstream's guard is `if not mcp_tool`, which a whitespace-only string
    // passes — it would then name the tool `<server>_   `. Deliberately
    // stricter: a blank name is treated as no name at all, leaving the call
    // untouched rather than renaming it to whitespace.
    let mcp_tool = envelope.get("ToolName")?.as_str()?.trim();
    if mcp_tool.is_empty() {
        return None;
    }
    let arguments = envelope.get("Arguments")?.as_object()?;

    // An already-resolved name is kept; the sentinel (and an empty name) is
    // replaced by the MCP tool's own.
    let mut display = call.name.trim().to_string();
    if display.is_empty() || display == MCP_DISPATCH_TOOL_NAME {
        display = mcp_tool.to_string();
    }
    if let Some(server) = envelope.get("ServerName").and_then(|v| v.as_str()) {
        let server = server.trim();
        if !server.is_empty() {
            display = format!("{server}_{display}");
        }
    }

    let mut input = serde_json::Map::new();
    input.insert(
        String::from("arguments"),
        serde_json::Value::Object(arguments.clone()),
    );
    // Upstream's `get_first_present` returns the first key present with a
    // NON-NULL value, and the caller only then rejects a blank one and moves to
    // the next MAP — not to the next key. Same here, so the same sentence is
    // chosen: `null` is skipped like an absent key, but a present blank one
    // ends the scan of that map.
    let prompt = [envelope, arguments].into_iter().find_map(|map| {
        let present = MCP_PROMPT_KEYS
            .iter()
            .filter_map(|key| map.get(*key))
            .find(|value| !value.is_null())?;
        let text = present.as_str()?.trim();
        (!text.is_empty()).then(|| text.to_string())
    });
    if let Some(prompt) = prompt {
        input.insert(String::from("prompt"), serde_json::Value::String(prompt));
    }

    let text = serde_json::Value::Object(input.clone()).to_string();
    if text.chars().count() <= TOOL_INPUT_CAP {
        return Some((display, text));
    }
    // `prompt` is a display convenience, and when it was read from INSIDE
    // `arguments` it is a verbatim copy of a value already in the payload — so
    // a long one can push an envelope that used to fit over the cap and get
    // `truncate_str` to cut the JSON mid-string, leaving every card unable to
    // parse arguments it could read before this rewrite. Drop the derived copy
    // first; only the irreducible `arguments` are then subject to the cap, the
    // same as the raw envelope was.
    input.remove("prompt");
    Some((display, serde_json::Value::Object(input).to_string()))
}

fn tool_use_block(call: &ChatToolCall) -> ContentBlock {
    let (name, input) = match unwrap_mcp_dispatch(call) {
        Some((name, input)) => (name, Some(input)),
        None => (
            call.name.clone(),
            (!call.arguments_json.trim().is_empty()).then(|| call.arguments_json.clone()),
        ),
    };
    ContentBlock::ToolUse {
        tool_use_id: (!call.id.is_empty()).then(|| call.id.clone()),
        tool_name: if name.is_empty() {
            String::from("tool")
        } else {
            name
        },
        input_preview: input.map(|text| truncate_str(&text, TOOL_INPUT_CAP)),
        status: None,
        meta: None,
    }
}

fn user_input_text(input: &UserInput) -> Option<String> {
    if !input.query.trim().is_empty() {
        return Some(input.query.clone());
    }
    // The structured form editors send: `items` is a sequence of text chunks
    // interleaved with context-scope references, which carry no text of their
    // own. Joined without a separator — the chunks are already contiguous
    // slices of one prompt.
    let from_items = input
        .items
        .iter()
        .map(|item| item.text.as_str())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("");
    if !from_items.trim().is_empty() {
        return Some(from_items);
    }
    (!input.user_response.trim().is_empty()).then(|| input.user_response.clone())
}

struct StepOutcome {
    output: Option<String>,
    is_error: bool,
}

/// Render one tool step's result, or `None` when the step carries no body this
/// parser understands and no error worth showing.
fn step_outcome(step: &Step) -> Option<StepOutcome> {
    let status_error = step.status == STEP_STATUS_ERROR;
    let step_error = step.error.as_ref().and_then(ErrorDetails::best_message);

    if let Some(result) = step.generic_result() {
        let command = step.command_result();
        let text = command
            .map(|run| run.output.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or(&result.text);
        if !text.is_empty() || command.is_some() {
            return Some(StepOutcome {
                output: non_empty_capped(text.to_owned()),
                is_error: status_error
                    || matches!(step.status, 4..=6 | 12)
                    || step.exit_code().is_some_and(|code| code != 0),
            });
        }
    }

    if let Some(run) = step.run_command.as_ref() {
        let command = first_non_empty([run.command_line.as_str(), run.command.as_str()]);
        let output = run
            .combined_output
            .as_ref()
            .and_then(|o| first_non_empty([o.full.as_str(), o.truncated.as_str()]))
            .or_else(|| first_non_empty([run.stdout.as_str(), run.stderr.as_str()]));
        let mut body = String::new();
        if let Some(command) = command {
            body.push_str(&format!("$ {command}\n"));
        }
        if let Some(output) = output {
            body.push_str(&output);
        }
        return Some(StepOutcome {
            output: non_empty_capped(body),
            is_error: status_error || run.exit_code != 0,
        });
    }

    if let Some(view) = step.view_file.as_ref() {
        let mut body = String::new();
        if !view.absolute_path_uri.is_empty() {
            body.push_str(&format!("{}\n", view.absolute_path_uri));
        }
        body.push_str(&view.content);
        return Some(StepOutcome {
            output: non_empty_capped(body),
            is_error: status_error,
        });
    }

    if let Some(write) = step.write_to_file.as_ref() {
        let verb = if write.file_created {
            "Created"
        } else {
            "Wrote"
        };
        return Some(StepOutcome {
            output: non_empty_capped(format!("{verb} {}", write.target_file_uri)),
            is_error: status_error,
        });
    }

    if let Some(change) = step.file_change.as_ref() {
        let mut body = format!("Edited {}", change.absolute_path_uri);
        if !change.instruction.trim().is_empty() {
            body.push_str(&format!("\n{}", change.instruction));
        }
        return Some(StepOutcome {
            output: non_empty_capped(body),
            is_error: status_error,
        });
    }

    if let Some(grep) = step.grep_search.as_ref() {
        if !grep.grep_error.trim().is_empty() {
            return Some(StepOutcome {
                output: non_empty_capped(grep.grep_error.clone()),
                is_error: true,
            });
        }
        let mut body = String::new();
        if !grep.query.is_empty() {
            body.push_str(&format!("{} ({} results)\n", grep.query, grep.total_results));
        }
        body.push_str(&grep.raw_output);
        return Some(StepOutcome {
            output: non_empty_capped(body),
            is_error: status_error,
        });
    }

    if let Some(list) = step.list_directory.as_ref() {
        if list.dir_not_found {
            return Some(StepOutcome {
                output: non_empty_capped(format!("Not found: {}", list.directory_path_uri)),
                is_error: true,
            });
        }
        return Some(StepOutcome {
            output: non_empty_capped(list.children.join("\n")),
            is_error: status_error,
        });
    }

    if let Some(mcp) = step.mcp_tool.as_ref() {
        if mcp.user_rejected {
            return Some(StepOutcome {
                output: Some(format!("Rejected by user ({})", mcp.server_name)),
                is_error: true,
            });
        }
        return Some(StepOutcome {
            output: non_empty_capped(mcp.result_string.clone()),
            is_error: status_error,
        });
    }

    if let Some(web) = step.search_web.as_ref() {
        let mut body = String::new();
        if !web.query.is_empty() {
            body.push_str(&format!("{}\n", web.query));
        }
        body.push_str(&web.summary);
        return Some(StepOutcome {
            output: non_empty_capped(body),
            is_error: status_error,
        });
    }

    if let Some(url) = step.read_url_content.as_ref() {
        let resolved = first_non_empty([url.resolved_url.as_str(), url.url.as_str()]);
        return Some(StepOutcome {
            output: resolved,
            is_error: status_error,
        });
    }

    if let Some(agency) = step.agency_tool_call.as_ref() {
        let responses = agency
            .response_messages
            .iter()
            .filter(|any| any.holds(HARNESS_TOOL_RESPONSE_TYPE))
            .filter_map(|any| HarnessToolResponse::decode(any.value.as_slice()).ok())
            .collect::<Vec<_>>();
        if let Some(message) = responses
            .iter()
            .find_map(|resp| first_non_empty([resp.error_message.as_str()]))
        {
            return Some(StepOutcome {
                output: non_empty_capped(message),
                is_error: true,
            });
        }
        let body = responses
            .iter()
            .find_map(|resp| first_non_empty([resp.response_json.as_str()]))
            .map(|json| harness_response_text(&json));
        return Some(StepOutcome {
            output: body.and_then(non_empty_capped),
            is_error: status_error,
        });
    }

    if let Some(ask) = step.ask_question.as_ref() {
        // The `{answers, declined}` envelope the question card reads, keyed by
        // question text (the model's `ask_question` arguments carry no header).
        // Selections are the options' text, trimmed the way the card trims the
        // option strings it reads from those arguments; a written-in answer
        // rides along as one more selection, which the card shows as "Other".
        let answers: Vec<serde_json::Value> = ask
            .items
            .iter()
            .map(|item| {
                let mut selected: Vec<String> = item
                    .chosen_ids
                    .iter()
                    .map(|id| {
                        item.options
                            .iter()
                            .find(|opt| &opt.id == id)
                            .map(|opt| opt.text.trim().to_string())
                            .unwrap_or_else(|| id.clone())
                    })
                    .collect();
                let write_in = item.write_in_response.trim();
                if !write_in.is_empty() {
                    selected.push(write_in.to_string());
                }
                serde_json::json!({
                    "header": "",
                    "question": item.question,
                    "multi_select": item.is_multi_select,
                    "selected": selected,
                })
            })
            .collect();
        // Dismissing the card skips every question with nothing chosen (from
        // 1.5.2: cancels the step with nothing chosen); record that as the live
        // bridge does (a decline), not as "no selection".
        let cancelled = step.status == STEP_STATUS_CANCELED;
        let declined = !ask.items.is_empty()
            && ask.items.iter().all(|item| {
                (item.skipped || cancelled)
                    && item.chosen_ids.is_empty()
                    && item.write_in_response.trim().is_empty()
            });
        let payload = if declined {
            serde_json::json!({ "answers": [], "declined": true })
        } else {
            serde_json::json!({ "answers": answers, "declined": false })
        };
        return Some(StepOutcome {
            output: serde_json::to_string(&payload).ok().and_then(non_empty_capped),
            is_error: status_error,
        });
    }

    if let Some(err) = step.error_message.as_ref() {
        let message = err
            .error
            .as_ref()
            .and_then(ErrorDetails::best_message)
            .or_else(|| step_error.clone());
        return Some(StepOutcome {
            output: message,
            is_error: true,
        });
    }

    // No recognized body: still surface a step-level error rather than dropping
    // it silently.
    step_error.map(|message| StepOutcome {
        output: Some(message),
        is_error: true,
    })
}

/// A harness `ToolResponse.response_json` as readable text.
///
/// The harness wraps a tool's payload as `{"result": "<text>"}`, which is a
/// JSON dump of a string the reader wants verbatim. Anything else — a richer
/// object, an array, a bare scalar — is passed through as-is rather than
/// guessed at.
fn harness_response_text(response_json: &str) -> String {
    serde_json::from_str::<serde_json::Value>(response_json)
        .ok()
        .as_ref()
        .and_then(|value| value.get("result"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| response_json.to_string())
}

fn first_non_empty<const N: usize>(candidates: [&str; N]) -> Option<String> {
    candidates
        .into_iter()
        .find(|s| !s.trim().is_empty())
        .map(str::to_string)
}

fn non_empty_capped(body: String) -> Option<String> {
    let trimmed = body.trim_end();
    (!trimmed.trim().is_empty()).then(|| truncate_str(trimmed, TOOL_OUTPUT_CAP))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ts(seconds: i64) -> Option<Timestamp> {
        Some(Timestamp { seconds, nanos: 0 })
    }

    fn write_steps(dir: &Path, session_id: &str, steps: &[Step]) {
        let conn = Connection::open(dir.join(format!("{session_id}.db"))).unwrap();
        conn.execute(
            "CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_payload BLOB)",
            [],
        )
        .unwrap();
        for (idx, step) in steps.iter().enumerate() {
            conn.execute(
                "INSERT INTO steps (idx, step_payload) VALUES (?1, ?2)",
                rusqlite::params![idx as i64, step.encode_to_vec()],
            )
            .unwrap();
        }
    }

    // `GEMINI_HOME` names the `.gemini` directory ITSELF (unlike Gemini CLI's
    // `GEMINI_CLI_HOME`, which is the parent), an empty value counts as unset,
    // and a leading `~` is expanded — all three straight from `paths.py`.
    #[test]
    fn gemini_home_resolution_matches_upstream() {
        let home = PathBuf::from("/home/demo");
        assert_eq!(
            resolve_gemini_home_from(None, Some(home.clone())),
            PathBuf::from("/home/demo/.gemini")
        );
        assert_eq!(
            resolve_gemini_home_from(Some("".into()), Some(home.clone())),
            PathBuf::from("/home/demo/.gemini"),
            "an empty GEMINI_HOME must count as unset"
        );
        assert_eq!(
            resolve_gemini_home_from(Some("/srv/gemini".into()), Some(home.clone())),
            PathBuf::from("/srv/gemini"),
            "the env value is the .gemini dir itself; nothing is joined onto it"
        );
        assert_eq!(
            resolve_gemini_home_from(Some("~/relocated".into()), Some(home)),
            PathBuf::from("/home/demo/relocated")
        );
    }

    #[test]
    fn empty_and_missing_databases_read_as_empty_not_error() {
        let dir = tempfile::tempdir().unwrap();
        // The 0-byte DB a brand-new session starts as, before the harness
        // writes the `steps` schema.
        std::fs::write(dir.path().join("fresh.db"), b"").unwrap();
        let parser = AntigravityParser::with_base_dir(dir.path().to_path_buf());
        assert!(parser.list_conversations().unwrap().is_empty());
        // `get_conversation` still resolves it (the file exists) and returns an
        // empty transcript rather than an error.
        let detail = parser.get_conversation("fresh").unwrap();
        assert!(detail.turns.is_empty());
        // A session id with no file at all is genuinely not found.
        assert!(matches!(
            parser.get_conversation("nope"),
            Err(ParseError::ConversationNotFound(_))
        ));
    }

    /// A step billed for a turn that rendered nothing still counts.
    #[test]
    fn a_billed_turn_with_nothing_to_show_keeps_its_spend() {
        let dir = tempfile::tempdir().unwrap();
        let user = |at: i64, query: &str| Step {
            metadata: Some(StepMetadata {
                created_at: ts(at),
                ..Default::default()
            }),
            user_input: Some(UserInput {
                query: query.into(),
                ..Default::default()
            }),
            ..Default::default()
        };
        let billed = |at: i64, input: u64, response: &str| Step {
            metadata: Some(StepMetadata {
                created_at: ts(at),
                model_usage: Some(ModelUsageStats {
                    input_tokens: input,
                    output_tokens: 0,
                    cache_read_tokens: 0,
                    cache_write_tokens: 0,
                }),
                ..Default::default()
            }),
            planner_response: Some(PlannerResponse {
                response: response.into(),
                ..Default::default()
            }),
            ..Default::default()
        };
        let steps = vec![
            user(1_700_000_000, "first"),
            billed(1_700_000_010, 300, ""),
            user(1_700_000_020, "second"),
            billed(1_700_000_030, 40, "answer"),
        ];
        write_steps(dir.path(), "s1", &steps);
        let detail = AntigravityParser::with_base_dir(dir.path().to_path_buf())
            .get_conversation("s1")
            .unwrap();
        let input: u64 = detail
            .turns
            .iter()
            .filter_map(|t| t.usage.as_ref())
            .map(|u| u.input_tokens)
            .sum();
        assert_eq!(input, 300 + 40);
    }

    #[test]
    fn projects_user_prompt_assistant_text_and_tool_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let call = ChatToolCall {
            id: "call-1".into(),
            name: "run_command".into(),
            arguments_json: r#"{"command":"ls"}"#.into(),
        };
        let steps = vec![
            Step {
                metadata: Some(StepMetadata {
                    created_at: ts(1_700_000_000),
                    ..Default::default()
                }),
                user_input: Some(UserInput {
                    query: "list the files".into(),
                    ..Default::default()
                }),
                ..Default::default()
            },
            Step {
                metadata: Some(StepMetadata {
                    created_at: ts(1_700_000_010),
                    model_usage: Some(ModelUsageStats {
                        input_tokens: 100,
                        output_tokens: 20,
                        cache_read_tokens: 900,
                        cache_write_tokens: 5,
                    }),
                    model_info: Some(ModelInfo {
                        model_name: "gemini-3.7-flash-high".into(),
                        ..Default::default()
                    }),
                    ..Default::default()
                }),
                planner_response: Some(PlannerResponse {
                    response: "Running it now.".into(),
                    thinking: "the user wants a listing".into(),
                    tool_calls: vec![call.clone()],
                }),
                ..Default::default()
            },
            Step {
                metadata: Some(StepMetadata {
                    created_at: ts(1_700_000_020),
                    tool_call: Some(call.clone()),
                    ..Default::default()
                }),
                run_command: Some(RunCommand {
                    command_line: "ls -la".into(),
                    combined_output: Some(RunCommandOutput {
                        full: "a.txt\nb.txt".into(),
                        ..Default::default()
                    }),
                    ..Default::default()
                }),
                ..Default::default()
            },
        ];
        write_steps(dir.path(), "s1", &steps);
        std::fs::write(
            dir.path().join("s1.meta"),
            br#"{"cwd": "/work/proj", "mode_id": "default"}"#,
        )
        .unwrap();

        let parser = AntigravityParser::with_base_dir(dir.path().to_path_buf());
        let listed = parser.list_conversations().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "s1");
        assert_eq!(listed[0].folder_path.as_deref(), Some("/work/proj"));
        assert_eq!(listed[0].title.as_deref(), Some("list the files"));
        assert_eq!(listed[0].model.as_deref(), Some("gemini-3.7-flash-high"));

        let detail = parser.get_conversation("s1").unwrap();
        assert_eq!(detail.turns.len(), 2);
        assert!(matches!(detail.turns[0].role, TurnRole::User));
        assert!(matches!(detail.turns[1].role, TurnRole::Assistant));

        let blocks = &detail.turns[1].blocks;
        assert!(matches!(&blocks[0], ContentBlock::Thinking { text } if text.contains("listing")));
        assert!(matches!(&blocks[1], ContentBlock::Text { text } if text == "Running it now."));
        match &blocks[2] {
            ContentBlock::ToolUse {
                tool_use_id,
                tool_name,
                input_preview,
                ..
            } => {
                assert_eq!(tool_use_id.as_deref(), Some("call-1"));
                assert_eq!(tool_name, "run_command");
                assert_eq!(input_preview.as_deref(), Some(r#"{"command":"ls"}"#));
            }
            other => panic!("expected the announced tool call, got {other:?}"),
        }
        match &blocks[3] {
            ContentBlock::ToolResult {
                tool_use_id,
                output_preview,
                is_error,
                ..
            } => {
                assert_eq!(tool_use_id.as_deref(), Some("call-1"));
                let output = output_preview.as_deref().unwrap();
                assert!(output.contains("$ ls -la"), "{output}");
                assert!(output.contains("a.txt"), "{output}");
                assert!(!is_error);
            }
            other => panic!("expected a tool result, got {other:?}"),
        }
        // The announced call must NOT be duplicated by the executing step's
        // own `metadata.tool_call`.
        assert_eq!(blocks.len(), 4);

        // Per-step usage sums into the turn; the window gauge uses only the
        // latest step's input side (100 + 900), never the sum.
        let usage = detail.turns[1].usage.as_ref().expect("usage");
        assert_eq!(usage.input_tokens, 100);
        assert_eq!(usage.cache_read_input_tokens, 900);
        let stats = detail.session_stats.expect("session stats");
        assert_eq!(stats.context_window_used_tokens, Some(1_000));
    }

    // A turn ends when its own last step ended — NOT when the user came back.
    // Folding the next prompt's clock into the pending assistant would make
    // `backfill_turn_durations` report the idle gap as the response's duration,
    // which for an overnight gap is hours of "thinking".
    #[test]
    fn assistant_turn_ends_with_its_own_last_step_not_the_next_prompt() {
        let dir = tempfile::tempdir().unwrap();
        let steps = vec![
            Step {
                metadata: Some(StepMetadata {
                    created_at: ts(1_700_000_000),
                    ..Default::default()
                }),
                user_input: Some(UserInput {
                    query: "first".into(),
                    ..Default::default()
                }),
                ..Default::default()
            },
            Step {
                metadata: Some(StepMetadata {
                    created_at: ts(1_700_000_010),
                    // The command ran for 30s after the step was created.
                    completed_at: ts(1_700_000_040),
                    ..Default::default()
                }),
                planner_response: Some(PlannerResponse {
                    response: "done".into(),
                    ..Default::default()
                }),
                ..Default::default()
            },
            Step {
                // Nine hours later.
                metadata: Some(StepMetadata {
                    created_at: ts(1_700_032_400),
                    ..Default::default()
                }),
                user_input: Some(UserInput {
                    query: "second".into(),
                    ..Default::default()
                }),
                ..Default::default()
            },
        ];
        write_steps(dir.path(), "s4", &steps);

        let parser = AntigravityParser::with_base_dir(dir.path().to_path_buf());
        let detail = parser.get_conversation("s4").unwrap();
        let assistant = detail
            .turns
            .iter()
            .find(|t| matches!(t.role, TurnRole::Assistant))
            .expect("assistant turn");
        // `completed_at` is the step's OWN completion, not the next prompt's
        // clock — that is the whole point of flushing before the user step.
        assert_eq!(
            assistant.completed_at,
            Timestamp {
                seconds: 1_700_000_040,
                nanos: 0
            }
            .to_utc()
        );
        // `backfill_turn_durations` spans from the previous turn's end (the
        // prompt at :00) to this turn's end (:40), so 40s. Before the fix the
        // turn's end was the SECOND prompt's timestamp and this read ~9 hours.
        assert_eq!(assistant.duration_ms, Some(40_000));
        assert!(
            assistant.duration_ms.unwrap() < 60_000,
            "the idle gap before the next prompt must be charged to nobody"
        );
        // The second prompt still opens its own turn.
        assert_eq!(detail.turns.len(), 3);
        assert!(matches!(detail.turns[2].role, TurnRole::User));
    }

    // A tool step whose call the planner never announced still has to render a
    // card, or its result shows up as a reply from nowhere.
    #[test]
    fn unannounced_tool_step_synthesizes_its_call() {
        let dir = tempfile::tempdir().unwrap();
        let steps = vec![
            Step {
                metadata: Some(StepMetadata {
                    created_at: ts(1_700_000_000),
                    ..Default::default()
                }),
                user_input: Some(UserInput {
                    query: "read it".into(),
                    ..Default::default()
                }),
                ..Default::default()
            },
            Step {
                metadata: Some(StepMetadata {
                    created_at: ts(1_700_000_005),
                    tool_call: Some(ChatToolCall {
                        id: "call-9".into(),
                        name: "view_file".into(),
                        arguments_json: r#"{"path":"/a"}"#.into(),
                    }),
                    ..Default::default()
                }),
                view_file: Some(ViewFile {
                    absolute_path_uri: "/a".into(),
                    content: "hello".into(),
                }),
                ..Default::default()
            },
        ];
        write_steps(dir.path(), "s2", &steps);

        let parser = AntigravityParser::with_base_dir(dir.path().to_path_buf());
        let detail = parser.get_conversation("s2").unwrap();
        let blocks = &detail.turns[1].blocks;
        assert!(matches!(
            &blocks[0],
            ContentBlock::ToolUse { tool_name, .. } if tool_name == "view_file"
        ));
        assert!(matches!(&blocks[1], ContentBlock::ToolResult { .. }));
        // No sidecar was written, so the cwd is honestly unknown rather than
        // silently standing in as the Gemini home.
        assert_eq!(detail.summary.folder_path, None);
    }

    #[test]
    fn failing_command_and_error_step_mark_the_result_as_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let steps = vec![
            Step {
                metadata: Some(StepMetadata {
                    created_at: ts(1_700_000_000),
                    ..Default::default()
                }),
                user_input: Some(UserInput {
                    query: "build".into(),
                    ..Default::default()
                }),
                ..Default::default()
            },
            Step {
                metadata: Some(StepMetadata {
                    created_at: ts(1_700_000_001),
                    tool_call: Some(ChatToolCall {
                        id: "c".into(),
                        name: "run_command".into(),
                        ..Default::default()
                    }),
                    ..Default::default()
                }),
                run_command: Some(RunCommand {
                    command_line: "make".into(),
                    exit_code: 2,
                    stderr: "boom".into(),
                    ..Default::default()
                }),
                ..Default::default()
            },
            Step {
                metadata: Some(StepMetadata {
                    created_at: ts(1_700_000_002),
                    ..Default::default()
                }),
                error_message: Some(ErrorMessageStep {
                    error: Some(ErrorDetails {
                        user_error_message: "quota exhausted".into(),
                        ..Default::default()
                    }),
                    should_show_user: true,
                }),
                ..Default::default()
            },
        ];
        write_steps(dir.path(), "s3", &steps);

        let parser = AntigravityParser::with_base_dir(dir.path().to_path_buf());
        let detail = parser.get_conversation("s3").unwrap();
        let errors: Vec<_> = detail.turns[1]
            .blocks
            .iter()
            .filter_map(|b| match b {
                ContentBlock::ToolResult {
                    output_preview,
                    is_error: true,
                    exit_code,
                    ..
                } => Some((output_preview.clone(), *exit_code)),
                _ => None,
            })
            .collect();
        assert_eq!(errors.len(), 1, "{errors:?}");
        assert!(errors[0].0.as_deref().unwrap_or_default().contains("boom"));
        assert_eq!(errors[0].1, Some(2), "the run's exit code is kept");
        // The error the server showed the user ended the turn: it closes the
        // round as the failure line, after the work it interrupted.
        assert_eq!(detail.turns.len(), 3, "{:?}", detail.turns);
        assert!(matches!(detail.turns[2].role, TurnRole::System));
        assert!(matches!(
            detail.turns[2].blocks.as_slice(),
            [ContentBlock::TurnError { message }] if message == "quota exhausted"
        ));
    }

    /// The executor error agy 1.5.2 stores for a prompt Google refused (field
    /// capture of a 403 turn), with the generic `user_error_message` it
    /// carries beside the raw error.
    fn refused_turn_error(should_show_user: bool) -> ErrorMessageStep {
        ErrorMessageStep {
            error: Some(ErrorDetails {
                user_error_message: "Agent execution terminated due to error.".into(),
                short_error: "agent executor error: Error 403, Message: Your current account \
                              is not eligible for Gemini Code Assist for individuals because \
                              it is not currently available in your location., Status: \
                              PERMISSION_DENIED, Details: [map[@type:type.googleapis.com/\
                              google.rpc.ErrorInfo domain:cloudaicompanion.googleapis.com \
                              metadata:map[error_number:1008 uiMessage:true] \
                              reason:UNSUPPORTED_LOCATION]]"
                    .into(),
                ..Default::default()
            }),
            should_show_user,
        }
    }

    const REFUSAL_TEXT: &str = "Your current account is not eligible for Gemini Code Assist \
                                for individuals because it is not currently available in \
                                your location.";

    fn prompt_step(at: i64, text: &str) -> Step {
        Step {
            metadata: Some(StepMetadata {
                created_at: ts(at),
                ..Default::default()
            }),
            user_input: Some(UserInput {
                query: text.into(),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    fn error_step(at: i64, should_show_user: bool) -> Step {
        Step {
            metadata: Some(StepMetadata {
                created_at: ts(at),
                ..Default::default()
            }),
            error_message: Some(refused_turn_error(should_show_user)),
            ..Default::default()
        }
    }

    fn reply_step(at: i64, text: &str) -> Step {
        Step {
            status: STEP_STATUS_DONE,
            metadata: Some(StepMetadata {
                created_at: ts(at),
                ..Default::default()
            }),
            planner_response: Some(PlannerResponse {
                response: text.into(),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    // A turn the executor died in before the model said anything (the 403
    // refusal of a user's location) is the prompt and the failure line — in
    // the server's words, not the generic "terminated due to error", and not a
    // tool result with no call (which drew as a failed "Result" card).
    #[test]
    fn a_refused_turn_reads_as_its_failure_line() {
        let dir = tempfile::tempdir().unwrap();
        write_steps(
            dir.path(),
            "s-refused",
            &[
                prompt_step(1_700_000_000, "hi"),
                error_step(1_700_000_004, true),
                prompt_step(1_700_000_010, "again"),
                error_step(1_700_000_013, true),
            ],
        );
        let parser = AntigravityParser::with_base_dir(dir.path().to_path_buf());
        let detail = parser.get_conversation("s-refused").unwrap();
        let shape: Vec<_> = detail
            .turns
            .iter()
            .map(|turn| match (&turn.role, turn.blocks.as_slice()) {
                (TurnRole::User, [ContentBlock::Text { text }]) => format!("user:{text}"),
                (TurnRole::System, [ContentBlock::TurnError { message }]) => {
                    format!("failed:{message}")
                }
                other => panic!("unexpected turn {other:?}"),
            })
            .collect();
        assert_eq!(
            shape,
            vec![
                "user:hi".to_string(),
                format!("failed:{REFUSAL_TEXT}"),
                "user:again".to_string(),
                format!("failed:{REFUSAL_TEXT}"),
            ]
        );
        assert_eq!(
            detail.summary.message_count, 2,
            "a failure line says nothing"
        );
    }

    // An error the model is asked to fix (no `should_show_user`) does not end
    // the turn, so it is not a failure line.
    #[test]
    fn a_model_facing_error_is_not_a_failure_line() {
        let dir = tempfile::tempdir().unwrap();
        write_steps(
            dir.path(),
            "s-retry",
            &[
                prompt_step(1_700_000_000, "go"),
                error_step(1_700_000_001, false),
                reply_step(1_700_000_002, "done"),
            ],
        );
        let parser = AntigravityParser::with_base_dir(dir.path().to_path_buf());
        let detail = parser.get_conversation("s-retry").unwrap();
        assert!(detail
            .turns
            .iter()
            .all(|turn| !matches!(turn.role, TurnRole::System)));
    }

    #[test]
    fn the_newest_round_failure_is_read_for_the_turn_that_just_ended() {
        let dir = tempfile::tempdir().unwrap();
        let at = |seconds| Utc.timestamp_opt(seconds, 0).single().unwrap();
        write_steps(
            dir.path(),
            "s-live",
            &[
                prompt_step(1_700_000_000, "hi"),
                error_step(1_700_000_004, true),
            ],
        );
        let (position, failure) =
            newest_round_failure(dir.path(), "s-live", at(1_700_000_000)).unwrap();
        assert_eq!(position, 1);
        assert_eq!(failure.text, REFUSAL_TEXT);
        assert_eq!(failure.category, "access");
        // A prompt stored before the turn began is an EARLIER round's: the
        // turn that just ended has not reached the trajectory.
        assert_eq!(
            newest_round_failure(dir.path(), "s-live", at(1_700_000_001)),
            None
        );
        assert_eq!(newest_round_failure(dir.path(), "missing", at(0)), None);

        // The model going on after a shown error means it did not end the turn.
        write_steps(
            dir.path(),
            "s-recovered",
            &[
                prompt_step(1_700_000_000, "hi"),
                error_step(1_700_000_001, true),
                reply_step(1_700_000_002, "hello"),
            ],
        );
        assert_eq!(
            newest_round_failure(dir.path(), "s-recovered", at(1_700_000_000)),
            None
        );
        // A round with no failure at all.
        write_steps(
            dir.path(),
            "s-ok",
            &[
                prompt_step(1_700_000_000, "hi"),
                reply_step(1_700_000_001, "hello"),
            ],
        );
        assert_eq!(
            newest_round_failure(dir.path(), "s-ok", at(1_700_000_000)),
            None
        );
    }

    // The decoder declares a strict SUBSET of the real `Step`. Every field it
    // does not know must be skipped by wire type, not derail the decode — this
    // is what lets the parser survive upstream adding steps and fields.
    #[test]
    fn unknown_fields_and_unmodelled_oneof_arms_are_skipped() {
        // A `Step` carrying tag 155 (`attachments`, a repeated Any we never
        // model), tag 1 (`type`, a
        // varint enum) alongside the one arm we do model.
        #[derive(Clone, PartialEq, ::prost::Message)]
        struct WiderStep {
            #[prost(int32, tag = "1")]
            step_type: i32,
            #[prost(message, optional, tag = "5")]
            metadata: Option<StepMetadata>,
            #[prost(message, optional, tag = "19")]
            user_input: Option<UserInput>,
            #[prost(bytes = "vec", repeated, tag = "155")]
            attachments: Vec<Vec<u8>>,
            // An arm the parser deliberately does not model.
            #[prost(string, tag = "111")]
            conversation_history: String,
        }

        let wide = WiderStep {
            step_type: 42,
            metadata: Some(StepMetadata {
                created_at: ts(1_700_000_000),
                ..Default::default()
            }),
            user_input: Some(UserInput {
                query: "still readable".into(),
                ..Default::default()
            }),
            attachments: vec![vec![1, 2, 3], vec![4]],
            conversation_history: "ignored too".into(),
        };
        let decoded = Step::decode(wide.encode_to_vec().as_slice()).expect("decode subset");
        assert_eq!(
            decoded.user_input.as_ref().unwrap().query,
            "still readable"
        );
        assert!(decoded.metadata.unwrap().created_at.is_some());
    }

    fn dispatch(name: &str, arguments_json: &str) -> ChatToolCall {
        ChatToolCall {
            id: "tc-1".into(),
            name: name.into(),
            arguments_json: arguments_json.into(),
        }
    }

    #[test]
    fn mcp_dispatch_unwrap_is_a_no_op_on_everything_that_is_not_an_envelope() {
        // Upstream's own no-op conditions (`tools.py::unwrap_mcp_tool_call`).
        // Getting any of these wrong would rewrite a NATIVE tool's name and
        // arguments — worse than the bug being fixed.
        for arguments in [
            // A native tool.
            r#"{"AbsolutePath":"/work/a.rs"}"#,
            // Envelope with no tool name.
            r#"{"Arguments":{"a":1},"ServerName":"s"}"#,
            // Blank tool name.
            r#"{"ToolName":"  ","Arguments":{"a":1}}"#,
            // `Arguments` present but not an object.
            r#"{"ToolName":"t","Arguments":"a=1"}"#,
            r#"{"ToolName":"t","Arguments":null}"#,
            // Not JSON at all, and not an object.
            "not json",
            "[1,2]",
            "",
        ] {
            assert!(
                unwrap_mcp_dispatch(&dispatch("view_file", arguments)).is_none(),
                "should not have unwrapped {arguments}"
            );
        }
    }

    #[test]
    fn mcp_dispatch_unwrap_names_the_tool_and_peels_the_arguments() {
        let (name, input) = unwrap_mcp_dispatch(&dispatch(
            MCP_DISPATCH_TOOL_NAME,
            r#"{"Arguments":{"task_ids":["a"]},"ServerName":"codeg-mcp","ToolName":"get_delegation_status","toolAction":"Checking"}"#,
        ))
        .expect("an MCP envelope");
        assert_eq!(name, "codeg-mcp_get_delegation_status");
        assert_eq!(
            input,
            r#"{"arguments":{"task_ids":["a"]},"prompt":"Checking"}"#
        );

        // No server name: the tool's own name stands alone.
        let (name, _) = unwrap_mcp_dispatch(&dispatch(
            MCP_DISPATCH_TOOL_NAME,
            r#"{"Arguments":{},"ToolName":"delegate_to_agent"}"#,
        ))
        .expect("an MCP envelope");
        assert_eq!(name, "delegate_to_agent");

        // An already-resolved name is KEPT, not replaced by `ToolName` — the
        // sentinel is the only name upstream overwrites.
        let (name, _) = unwrap_mcp_dispatch(&dispatch(
            "resolved_name",
            r#"{"Arguments":{},"ServerName":"srv","ToolName":"delegate_to_agent"}"#,
        ))
        .expect("an MCP envelope");
        assert_eq!(name, "srv_resolved_name");
    }

    #[test]
    fn mcp_dispatch_drops_the_derived_prompt_rather_than_truncating_the_json() {
        // The rewrite lifts a `prompt` found INSIDE `arguments` to the top
        // level, so a long one is stored twice and can push an envelope that
        // used to fit over `TOOL_INPUT_CAP` — `truncate_str` would then cut the
        // JSON mid-string and every card would lose arguments it could read
        // before. The derived copy goes first; `arguments` stay parseable.
        let long_prompt = "x".repeat(TOOL_INPUT_CAP - 200);
        let envelope = serde_json::json!({
            "ToolName": "run_agent",
            "ServerName": "srv",
            "Arguments": { "prompt": long_prompt },
        })
        .to_string();
        assert!(
            envelope.chars().count() <= TOOL_INPUT_CAP,
            "the raw envelope has to fit, or the regression is not what is tested"
        );

        let (_, input) =
            unwrap_mcp_dispatch(&dispatch(MCP_DISPATCH_TOOL_NAME, &envelope)).expect("envelope");
        assert!(input.chars().count() <= TOOL_INPUT_CAP, "{}", input.len());
        let parsed: serde_json::Value =
            serde_json::from_str(&truncate_str(&input, TOOL_INPUT_CAP)).expect("still valid JSON");
        assert_eq!(parsed["arguments"]["prompt"].as_str(), Some(&*long_prompt));
        assert!(parsed.get("prompt").is_none(), "the derived copy is dropped");
    }

    #[test]
    fn mcp_dispatch_prompt_falls_through_to_the_inner_arguments() {
        // `get_first_present` returns the first key PRESENT in a map — blank
        // included — and only then rejects it and moves to the NEXT MAP, not
        // the next key. So a blank `toolAction` on the envelope does not let
        // `toolSummary` beside it win; the inner arguments get the turn.
        let (_, input) = unwrap_mcp_dispatch(&dispatch(
            MCP_DISPATCH_TOOL_NAME,
            r#"{"Arguments":{"description":"inner one"},"ToolName":"t","toolAction":"   ","toolSummary":"outer one"}"#,
        ))
        .expect("an MCP envelope");
        assert!(input.contains(r#""prompt":"inner one""#), "{input}");

        // …but a JSON `null` is skipped like an ABSENT key, not treated as a
        // present-but-unusable one: `get_first_present` returns "the first
        // non-None value in mapping matching one of keys", so the scan of this
        // map carries on to `toolAction` instead of falling to the next map.
        let (_, input) = unwrap_mcp_dispatch(&dispatch(
            MCP_DISPATCH_TOOL_NAME,
            r#"{"Arguments":{"description":"inner one"},"ToolName":"t","prompt":null,"toolAction":"outer one"}"#,
        ))
        .expect("an MCP envelope");
        assert!(input.contains(r#""prompt":"outer one""#), "{input}");

        // Nothing anywhere: no `prompt` key at all rather than an empty one.
        let (_, input) = unwrap_mcp_dispatch(&dispatch(
            MCP_DISPATCH_TOOL_NAME,
            r#"{"Arguments":{"a":1},"ToolName":"t"}"#,
        ))
        .expect("an MCP envelope");
        assert_eq!(input, r#"{"arguments":{"a":1}}"#);
    }

    #[test]
    fn harness_response_text_unwraps_only_the_string_result() {
        assert_eq!(
            harness_response_text(r#"{"result": "file body"}"#),
            "file body"
        );
        // A richer payload is passed through rather than guessed at.
        assert_eq!(
            harness_response_text(r#"{"result": {"a": 1}}"#),
            r#"{"result": {"a": 1}}"#
        );
        assert_eq!(harness_response_text(r#"{"other": 1}"#), r#"{"other": 1}"#);
        assert_eq!(harness_response_text("plain text"), "plain text");
    }

    #[test]
    fn an_error_this_parser_cannot_read_still_settles_the_call() {
        // `CortexErrorDetails` carries fields beyond the three this parser
        // models, so an error made only of those decodes to a PRESENT but
        // blank `ErrorDetails`: `step.error.is_some()` is true while
        // `step_outcome` renders nothing. Counting that as "gets a result"
        // would drop the id into `resolved` and suppress the settling result —
        // leaving the very spinner the sweep exists to prevent.
        let step = Step {
            metadata: Some(StepMetadata {
                created_at: ts(1_700_000_000),
                tool_call: Some(dispatch("some_future_tool", "{}")),
                ..Default::default()
            }),
            error: Some(ErrorDetails::default()),
            ..Default::default()
        };

        let parsed = project_steps(&[step]);
        let blocks = &parsed.turns[0].blocks;
        assert!(
            matches!(&blocks[0], ContentBlock::ToolUse { .. }),
            "{blocks:?}"
        );
        assert!(
            matches!(
                &blocks[1],
                ContentBlock::ToolResult { tool_use_id: Some(id), .. } if id == "tc-1"
            ),
            "the call has to settle: {blocks:?}"
        );
    }

    #[test]
    fn a_harness_response_of_another_type_is_not_decoded() {
        // `type_url` is `<prefix>/<fully.qualified.Name>`, so the check is on
        // the last path segment. A suffix match on the whole string would also
        // accept `…/evil.antigravity.localharness.ToolResponse` and render
        // whatever its bytes happened to decode to.
        let payload = HarnessToolResponse {
            response_json: r#"{"result": "from the impostor"}"#.into(),
            ..Default::default()
        }
        .encode_to_vec();
        let impostor = Step {
            agency_tool_call: Some(AgencyToolCall {
                function_name: "view_file".into(),
                response_messages: vec![ProtoAny {
                    type_url: format!("type.googleapis.com/evil.{HARNESS_TOOL_RESPONSE_TYPE}"),
                    value: payload.clone(),
                }],
            }),
            ..Default::default()
        };
        assert_eq!(step_outcome(&impostor).expect("an outcome").output, None);

        let genuine = Step {
            agency_tool_call: Some(AgencyToolCall {
                function_name: "view_file".into(),
                response_messages: vec![ProtoAny {
                    type_url: format!("type.googleapis.com/{HARNESS_TOOL_RESPONSE_TYPE}"),
                    value: payload,
                }],
            }),
            ..Default::default()
        };
        assert_eq!(
            step_outcome(&genuine).expect("an outcome").output.as_deref(),
            Some("from the impostor")
        );
    }

    #[test]
    fn several_unmodelled_steps_sharing_one_id_settle_it_once() {
        // A proposal and its choice (or any other pair of steps this parser
        // does not model) carry the SAME `metadata.tool_call`. `resolved` only
        // keeps the sweep away from calls something else answers, so without a
        // second guard each of them appends its own result and the one call
        // card is answered twice — and, since their statuses can differ,
        // answered both ways.
        let unmodelled = |status: i32| Step {
            status,
            metadata: Some(StepMetadata {
                created_at: ts(1_700_000_000),
                tool_call: Some(dispatch("some_future_tool", "{}")),
                ..Default::default()
            }),
            ..Default::default()
        };

        let parsed = project_steps(&[unmodelled(3), unmodelled(STEP_STATUS_ERROR)]);
        let blocks = &parsed.turns[0].blocks;
        assert_eq!(blocks.len(), 2, "one call, one result: {blocks:?}");
        assert!(matches!(&blocks[0], ContentBlock::ToolUse { .. }));
        // The failure any of the shared steps reported wins, even though the
        // result is emitted at the first (successful) one so that it stays
        // next to the call card.
        assert!(
            matches!(&blocks[1], ContentBlock::ToolResult { is_error: true, .. }),
            "{blocks:?}"
        );
    }

    #[test]
    fn a_settled_call_is_never_settled_twice() {
        // A `tool_call_proposal` (or any other unmodelled step) can share its
        // id with the execution it proposes. Settling the unmodelled one in
        // place would give that single card two results, so the sweep has to
        // know the id gets answered later.
        let proposal = Step {
            metadata: Some(StepMetadata {
                created_at: ts(1_700_000_000),
                tool_call: Some(dispatch("run_command", r#"{"CommandLine":"ls"}"#)),
                ..Default::default()
            }),
            ..Default::default()
        };
        let execution = Step {
            metadata: Some(StepMetadata {
                created_at: ts(1_700_000_001),
                tool_call: Some(dispatch("run_command", r#"{"CommandLine":"ls"}"#)),
                ..Default::default()
            }),
            run_command: Some(RunCommand {
                command_line: "ls".into(),
                combined_output: Some(RunCommandOutput {
                    full: "a.txt\n".into(),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            ..Default::default()
        };

        let parsed = project_steps(&[proposal, execution]);
        let blocks = &parsed.turns[0].blocks;
        let results = blocks
            .iter()
            .filter(|b| matches!(b, ContentBlock::ToolResult { .. }))
            .count();
        assert_eq!(results, 1, "one card, one result: {blocks:?}");
        assert!(matches!(
            &blocks[1],
            ContentBlock::ToolResult { output_preview: Some(out), .. } if out.contains("a.txt")
        ));
    }

    /// #948: built with an agent's launch env, the parser reads where THAT
    /// env puts the agent's files, not where codeg's own environment does.
    /// The CLI's tree leads; the old standalone server's tree stays readable.
    #[test]
    fn for_env_reads_the_home_of_the_launch_env() {
        let env = AgentEnv::with_overrides(&[("GEMINI_HOME", "/relocated/agy")]);
        let parser = AntigravityParser::for_env(&env);
        assert_eq!(
            parser.base_dir,
            PathBuf::from("/relocated/agy")
                .join("antigravity-cli")
                .join("conversations")
        );
        assert_eq!(
            parser.legacy_dir,
            Some(
                PathBuf::from("/relocated/agy")
                    .join("antigravity-acp")
                    .join("conversations")
            )
        );
    }

    #[test]
    fn decodes_the_cli_file_uris() {
        #[cfg(not(windows))]
        {
            assert_eq!(
                file_uri_to_path("file:///Users/me/my%20repo").as_deref(),
                Some("/Users/me/my repo")
            );
            assert_eq!(
                file_uri_to_path("file://localhost/Users/me/my%20repo").as_deref(),
                Some("/Users/me/my repo")
            );
        }
        assert_eq!(file_uri_to_path("https://example.com/repo"), None);
    }

    #[test]
    fn reads_workspace_cwd_from_cli_conversation_summaries_db() {
        let root = tempfile::tempdir().unwrap();
        let cli_dir = root.path().join("antigravity-cli");
        let conv_dir = cli_dir.join("conversations");
        std::fs::create_dir_all(&conv_dir).unwrap();

        // 写入不含 `steps` 表的真实 `conversation_summaries.db`
        let summary_db = cli_dir.join(SUMMARY_DB_NAME);
        let conn = Connection::open(&summary_db).unwrap();
        conn.execute(
            "CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, workspace_uris TEXT NOT NULL)",
            [],
        )
        .unwrap();
        let workspace_path = root.path().join("my repo");
        std::fs::create_dir_all(&workspace_path).unwrap();
        let uri = url::Url::from_directory_path(&workspace_path)
            .unwrap()
            .to_string();
        let expected_path = file_uri_to_path(&uri).unwrap();
        conn.execute(
            "INSERT INTO conversation_summaries (conversation_id, workspace_uris) VALUES (?1, ?2)",
            rusqlite::params!["cli-session-1", serde_json::to_string(&vec![uri]).unwrap()],
        )
        .unwrap();
        drop(conn);

        // 写入对应的会话轨迹 DB（无 .meta sidecar）
        let db_path = conv_dir.join("cli-session-1.db");
        let step_conn = Connection::open(&db_path).unwrap();
        step_conn
            .execute(
                "CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_payload BLOB)",
                [],
            )
            .unwrap();
        let user_step = Step {
            user_input: Some(UserInput {
                query: "hello from agy acp".into(),
                ..Default::default()
            }),
            ..Default::default()
        };
        step_conn
            .execute(
                "INSERT INTO steps (idx, step_payload) VALUES (0, ?1)",
                [user_step.encode_to_vec()],
            )
            .unwrap();
        drop(step_conn);

        let parser = AntigravityParser::with_base_dir(conv_dir);
        let listed = parser.list_conversations().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "cli-session-1");
        assert_eq!(listed[0].folder_path.as_deref(), Some(expected_path.as_str()));

        let detail = parser.get_conversation("cli-session-1").unwrap();
        assert_eq!(
            detail.summary.folder_path.as_deref(),
            Some(expected_path.as_str())
        );
    }

    /// A CLI session restored without the shared `conversation_summaries.db`
    /// row (which backups no longer carry) still knows its folder from its own
    /// `trajectory_metadata_blob` — and a legacy record, whose repeated field 7
    /// lists the folder FIRST and then the skill directories, names the folder
    /// rather than the last skills directory.
    #[test]
    fn reads_workspace_cwd_from_the_trajectory_metadata_blob() {
        let root = tempfile::tempdir().unwrap();
        let conv_dir = root.path().join("antigravity-cli").join("conversations");
        std::fs::create_dir_all(&conv_dir).unwrap();
        let workspace = root.path().join("my repo");
        std::fs::create_dir_all(&workspace).unwrap();
        let uri = url::Url::from_directory_path(&workspace).unwrap().to_string();
        let expected = file_uri_to_path(&uri).unwrap();
        let skills_uri = url::Url::from_directory_path(workspace.join(".agents").join("skills"))
            .unwrap()
            .to_string();

        let cases = [
            (
                "cli-blob",
                TrajectoryMetadata {
                    workspaces: Some(TrajectoryWorkspaces {
                        primary_uri: uri.clone(),
                    }),
                    workspace_uris: vec![uri.clone()],
                },
            ),
            (
                "legacy-blob",
                TrajectoryMetadata {
                    workspaces: None,
                    workspace_uris: vec![uri.clone(), skills_uri.clone()],
                },
            ),
            (
                "workspace-set-only",
                TrajectoryMetadata {
                    workspaces: Some(TrajectoryWorkspaces {
                        primary_uri: uri.clone(),
                    }),
                    workspace_uris: Vec::new(),
                },
            ),
        ];
        for (id, meta) in &cases {
            let conn = Connection::open(conv_dir.join(format!("{id}.db"))).unwrap();
            conn.execute(
                "CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_payload BLOB)",
                [],
            )
            .unwrap();
            conn.execute(
                "CREATE TABLE trajectory_metadata_blob (id TEXT DEFAULT 'main', data BLOB, PRIMARY KEY (id))",
                [],
            )
            .unwrap();
            let step = Step {
                user_input: Some(UserInput {
                    query: format!("hello from {id}"),
                    ..Default::default()
                }),
                ..Default::default()
            };
            conn.execute(
                "INSERT INTO steps (idx, step_payload) VALUES (0, ?1)",
                [step.encode_to_vec()],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO trajectory_metadata_blob (id, data) VALUES ('main', ?1)",
                [meta.encode_to_vec()],
            )
            .unwrap();
        }

        let parser = AntigravityParser::with_base_dir(conv_dir);
        let listed = parser.list_conversations().unwrap();
        assert_eq!(listed.len(), cases.len());
        for summary in &listed {
            assert_eq!(
                summary.folder_path.as_deref(),
                Some(expected.as_str()),
                "{}",
                summary.id
            );
        }
        for (id, _) in &cases {
            let detail = parser.get_conversation(id).unwrap();
            assert_eq!(detail.summary.folder_path.as_deref(), Some(expected.as_str()), "{id}");
        }
    }

    /// One question of an `ask_question` step, options numbered from `"1"` the
    /// way antigravity-acp 1.4.1 records them.
    fn ask_item(question: &str, options: &[&str], chosen: &[&str]) -> AntigravityAskItem {
        AntigravityAskItem {
            question: question.into(),
            options: options
                .iter()
                .enumerate()
                .map(|(i, text)| AntigravityAskOption {
                    id: (i + 1).to_string(),
                    text: (*text).into(),
                })
                .collect(),
            chosen_ids: chosen.iter().map(|id| (*id).into()).collect(),
            ..Default::default()
        }
    }

    /// Round-trip one `ask_question` step (`Step` field 154) through the store
    /// and return the tool call's name and its result envelope.
    fn ask_step_outcome(items: Vec<AntigravityAskItem>) -> (String, serde_json::Value) {
        ask_step_outcome_with_status(STEP_STATUS_DONE, items)
    }

    fn ask_step_outcome_with_status(
        status: i32,
        items: Vec<AntigravityAskItem>,
    ) -> (String, serde_json::Value) {
        let dir = tempfile::tempdir().unwrap();
        let step = Step {
            status,
            metadata: Some(StepMetadata {
                created_at: ts(1_700_000_000),
                tool_call: Some(ChatToolCall {
                    id: "call_1".into(),
                    name: "ask_question".into(),
                    arguments_json: "{}".into(),
                }),
                ..Default::default()
            }),
            ask_question: Some(AntigravityAskQuestions { items }),
            ..Default::default()
        };
        write_steps(dir.path(), "test-session", &[step]);
        let parsed = project_steps(&read_trajectory(&dir.path().join("test-session.db")).0);
        let blocks: Vec<&ContentBlock> = parsed.turns.iter().flat_map(|t| &t.blocks).collect();
        let name = blocks
            .iter()
            .find_map(|block| match block {
                ContentBlock::ToolUse { tool_name, .. } => Some(tool_name.clone()),
                _ => None,
            })
            .expect("the ask_question call");
        let outputs: Vec<&String> = blocks
            .iter()
            .filter_map(|block| match block {
                ContentBlock::ToolResult {
                    output_preview: Some(out),
                    ..
                } => Some(out),
                _ => None,
            })
            .collect();
        assert_eq!(outputs.len(), 1, "one result for the ask");
        (
            name,
            serde_json::from_str(outputs[0]).expect("JSON envelope"),
        )
    }

    #[test]
    fn antigravity_ask_question_step_outcome_generates_json_envelope() {
        let (name, val) = ask_step_outcome(vec![
            ask_item(
                "您希望接下来优先开展哪一类开发任务？",
                &[
                    "(Recommended) 核心业务功能的新增与实现",
                    "现有功能的优化与缺陷修复",
                ],
                &["1"],
            ),
            ask_item(
                "在开发交付与流程配合上，您倾向于哪种模式？",
                &[
                    "(Recommended) 快速迭代交付，先实现最小可行版本（MVP）供确认",
                    "阶段性里程碑交付，按完整模块验收",
                ],
                &["2"],
            ),
        ]);
        // The card is keyed to this name (`ask_question` → "question" in the
        // frontend's tool-name aliases).
        assert_eq!(name, "ask_question");
        assert_eq!(
            val,
            serde_json::json!({
                "answers": [
                    {
                        "header": "",
                        "question": "您希望接下来优先开展哪一类开发任务？",
                        "multi_select": false,
                        "selected": ["(Recommended) 核心业务功能的新增与实现"],
                    },
                    {
                        "header": "",
                        "question": "在开发交付与流程配合上，您倾向于哪种模式？",
                        "multi_select": false,
                        "selected": ["阶段性里程碑交付，按完整模块验收"],
                    },
                ],
                "declined": false,
            })
        );
    }

    /// A multi-select question keeps its kind even though the ACP server could
    /// only take one pick for it; a written-in answer and padded option text
    /// come out the way the card reads them.
    #[test]
    fn antigravity_ask_question_outcome_keeps_multi_select_and_write_in() {
        let mut multi = ask_item("Pick tags", &["Alpha", "Beta", " Gamma "], &["3"]);
        multi.is_multi_select = true;
        let mut write_in = ask_item("Anything else?", &["No", "Later"], &[]);
        write_in.write_in_response = " Ship it on Friday ".into();
        let (_, val) = ask_step_outcome(vec![multi, write_in]);
        assert_eq!(val["declined"], false);
        assert_eq!(val["answers"][0]["multi_select"], true);
        assert_eq!(val["answers"][0]["selected"], serde_json::json!(["Gamma"]));
        assert_eq!(val["answers"][1]["multi_select"], false);
        assert_eq!(
            val["answers"][1]["selected"],
            serde_json::json!(["Ship it on Friday"])
        );
    }

    /// Dismissing the card leaves every question skipped with nothing chosen:
    /// that reads as a decline, as the live bridge records it. Dismissing a
    /// later question keeps the earlier answer.
    #[test]
    fn antigravity_ask_question_outcome_reads_a_dismissed_card_as_declined() {
        let skipped = |mut item: AntigravityAskItem| {
            item.skipped = true;
            item
        };
        let (_, all_skipped) = ask_step_outcome(vec![
            skipped(ask_item("Which area first?", &["Backend", "Frontend"], &[])),
            skipped(ask_item("Pick tags", &["Alpha", "Beta"], &[])),
        ]);
        assert_eq!(
            all_skipped,
            serde_json::json!({ "answers": [], "declined": true })
        );

        let (_, partly) = ask_step_outcome(vec![
            ask_item("Which area first?", &["Backend", "Frontend"], &["2"]),
            skipped(ask_item("Pick tags", &["Alpha", "Beta"], &[])),
        ]);
        assert_eq!(partly["declined"], false);
        assert_eq!(
            partly["answers"][0]["selected"],
            serde_json::json!(["Frontend"])
        );
        assert_eq!(partly["answers"][1]["selected"], serde_json::json!([]));
    }

    #[test]
    fn migrate_legacy_session_copies_db_and_brain_and_stays_idempotent() {
        let root = tempfile::tempdir().unwrap();
        let legacy_conv = root.path().join(ACP_SUBDIR).join(SESSIONS_DIR_NAME);
        let legacy_brain = root
            .path()
            .join(ACP_SUBDIR)
            .join(BRAIN_DIR_NAME)
            .join("legacy-1");
        std::fs::create_dir_all(&legacy_conv).unwrap();
        std::fs::create_dir_all(legacy_brain.join("nested")).unwrap();

        let step = Step {
            metadata: Some(StepMetadata {
                created_at: ts(1_700_000_000),
                ..Default::default()
            }),
            user_input: Some(UserInput {
                query: "来自旧版 acp server 的会话".to_string(),
                ..Default::default()
            }),
            ..Default::default()
        };
        write_steps(&legacy_conv, "legacy-1", &[step]);
        std::fs::write(
            legacy_conv.join("legacy-1.meta"),
            r#"{"cwd":"/Users/demo/project","mode_id":"yolo"}"#,
        )
        .unwrap();
        std::fs::write(legacy_brain.join("nested").join("note.md"), "artifact").unwrap();

        // 首次迁移：应将 .db 与 brain 迁移至 antigravity-cli，并保留旧目录原件。
        assert!(migrate_legacy_session_to_cli(root.path(), "legacy-1").unwrap());

        let cli_db = root
            .path()
            .join(CLI_SUBDIR)
            .join(SESSIONS_DIR_NAME)
            .join("legacy-1.db");
        let cli_note = root
            .path()
            .join(CLI_SUBDIR)
            .join(BRAIN_DIR_NAME)
            .join("legacy-1")
            .join("nested")
            .join("note.md");
        assert!(cli_db.is_file());
        assert_eq!(std::fs::read_to_string(&cli_note).unwrap(), "artifact");
        assert!(legacy_conv.join("legacy-1.db").is_file());
        assert!(legacy_conv.join("legacy-1.meta").is_file());

        // 迁移后解析器列表不应去重失败或丢失原始工作区 cwd。
        let env = AgentEnv::with_overrides(&[(
            "GEMINI_HOME",
            root.path().to_string_lossy().as_ref(),
        )]);
        let parser = AntigravityParser::for_env(&env);
        let list = parser.list_conversations().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "legacy-1");
        assert_eq!(list[0].folder_path.as_deref(), Some("/Users/demo/project"));
        assert_eq!(
            list[0].title.as_deref(),
            Some("来自旧版 acp server 的会话")
        );

        // 再次调用应保持幂等，不覆盖新目录中后续追加的新步骤。
        let cli_conn = Connection::open(&cli_db).unwrap();
        let new_step = Step {
            metadata: Some(StepMetadata {
                created_at: ts(1_700_000_010),
                ..Default::default()
            }),
            planner_response: Some(PlannerResponse {
                response: "新 acp 续聊回复".to_string(),
                ..Default::default()
            }),
            ..Default::default()
        };
        cli_conn
            .execute(
                "INSERT INTO steps (idx, step_payload) VALUES (1, ?1)",
                rusqlite::params![new_step.encode_to_vec()],
            )
            .unwrap();
        drop(cli_conn);

        assert!(!migrate_legacy_session_to_cli(root.path(), "legacy-1").unwrap());
        let detail = parser.get_conversation("legacy-1").unwrap();
        assert_eq!(detail.turns.len(), 2);
    }

    #[test]
    fn migrate_legacy_session_includes_uncheckpointed_wal_data() {
        let root = tempfile::tempdir().unwrap();
        let legacy_conv = root.path().join(ACP_SUBDIR).join(SESSIONS_DIR_NAME);
        std::fs::create_dir_all(&legacy_conv).unwrap();

        let legacy_db = legacy_conv.join("wal-session.db");
        let conn = Connection::open(&legacy_db).unwrap();
        // 启用 WAL 且关闭自动 checkpoint，确保最新提交留在 -wal 中。
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
        conn.execute(
            "CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_payload BLOB)",
            [],
        )
        .unwrap();
        let step = Step {
            metadata: Some(StepMetadata {
                created_at: ts(1_700_000_100),
                ..Default::default()
            }),
            user_input: Some(UserInput {
                query: "WAL 未刷盘的消息".to_string(),
                ..Default::default()
            }),
            ..Default::default()
        };
        conn.execute(
            "INSERT INTO steps (idx, step_payload) VALUES (0, ?1)",
            rusqlite::params![step.encode_to_vec()],
        )
        .unwrap();

        // 保持连接打开（WAL 未 checkpoint），执行迁移后目标库应完整包含该消息。
        assert!(migrate_legacy_session_to_cli(root.path(), "wal-session").unwrap());
        drop(conn);

        let cli_db = root
            .path()
            .join(CLI_SUBDIR)
            .join(SESSIONS_DIR_NAME)
            .join("wal-session.db");
        let (steps, _) = read_trajectory(&cli_db);
        assert_eq!(steps.len(), 1);
        assert_eq!(
            steps[0].user_input.as_ref().map(|u| u.query.as_str()),
            Some("WAL 未刷盘的消息")
        );
    }

    #[test]
    fn migrate_legacy_session_replaces_empty_placeholder_and_rejects_unsafe_ids() {
        let root = tempfile::tempdir().unwrap();
        let legacy_conv = root.path().join(ACP_SUBDIR).join(SESSIONS_DIR_NAME);
        let cli_conv = root.path().join(CLI_SUBDIR).join(SESSIONS_DIR_NAME);
        std::fs::create_dir_all(&legacy_conv).unwrap();
        std::fs::create_dir_all(&cli_conv).unwrap();

        // 合法旧会话 + 目标 0 字节占位文件：应允许覆盖。
        let step = Step {
            user_input: Some(UserInput {
                query: "恢复内容".to_string(),
                ..Default::default()
            }),
            ..Default::default()
        };
        write_steps(&legacy_conv, "placeholder-1", &[step]);
        std::fs::write(cli_conv.join("placeholder-1.db"), b"").unwrap();
        assert!(migrate_legacy_session_to_cli(root.path(), "placeholder-1").unwrap());
        assert_eq!(read_trajectory(&cli_conv.join("placeholder-1.db")).0.len(), 1);

        // 旧会话不存在或为 0 字节时跳过。
        std::fs::write(legacy_conv.join("empty-old.db"), b"").unwrap();
        assert!(!migrate_legacy_session_to_cli(root.path(), "empty-old").unwrap());
        assert!(!migrate_legacy_session_to_cli(root.path(), "missing").unwrap());

        // 非法路径 ID 直接拒绝，不越界访问。
        for bad in ["", ".", "..", "../escape", "a/b", r"a\b"] {
            assert!(
                !migrate_legacy_session_to_cli(root.path(), bad).unwrap(),
                "非法 session_id 应被忽略: {bad:?}"
            );
        }
    }
    /// 1.5.2 stores a dismissed (or stopped) question as a cancelled step with
    /// nothing chosen and no `skipped`: still a decline, not "no selection". A
    /// cancelled step that kept an earlier answer keeps it.
    #[test]
    fn antigravity_ask_question_outcome_reads_a_cancelled_step_as_declined() {
        let (_, cancelled) = ask_step_outcome_with_status(
            STEP_STATUS_CANCELED,
            vec![ask_item("Which area first?", &["Backend", "Frontend"], &[])],
        );
        assert_eq!(
            cancelled,
            serde_json::json!({ "answers": [], "declined": true })
        );

        let (_, partly) = ask_step_outcome_with_status(
            STEP_STATUS_CANCELED,
            vec![
                ask_item("Which area first?", &["Backend", "Frontend"], &["2"]),
                ask_item("Pick tags", &["Alpha", "Beta"], &[]),
            ],
        );
        assert_eq!(partly["declined"], false);
        assert_eq!(
            partly["answers"][0]["selected"],
            serde_json::json!(["Frontend"])
        );
    }
}
