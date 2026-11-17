//! What the MCP engine says to its callers: the inventory of every agent's
//! MCP servers, the operations `mcp_apply` takes, and what came of them.
//!
//! Everything a person might read is a stable code (see [`codes`]) rather
//! than a sentence, so the page can say it in the user's language; `detail`
//! carries the technical remainder (an OS error, the offending value) and is
//! never the only explanation.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::commands::mcp::McpAppType;

/// The built-in companion's name. Sessions get it from codeg itself, so no
/// agent's config may define a server under it.
pub const RESERVED_KEY: &str = "codeg-mcp";

/// What a NEW server name must match: agents such as Claude Code build tool
/// names out of it. Names already on disk are listed and edited as they are.
pub const KEY_PATTERN: &str = "^[A-Za-z0-9_-]{1,64}$";

/// The basis of a config file that does not exist.
pub const BASIS_MISSING: &str = "missing";

/// Announces that `mcp_apply` (or one of the retired commands) changed an
/// agent's MCP configuration. Payload: [`McpChanged`].
pub const MCP_CHANGED_EVENT: &str = "mcp://changed";

/// Whether `key` may name a new server.
pub fn is_valid_new_key(key: &str) -> bool {
    (1..=64).contains(&key.len())
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// The stable codes of results, problems and errors.
pub mod codes {
    // ── A config file that cannot be used ────────────────────────────────
    /// The file could not be read: permission.
    pub const IO_PERMISSION_DENIED: &str = "io_permission_denied";
    /// The file could not be read or written for another reason.
    pub const IO_ERROR: &str = "io_error";
    pub const NOT_UTF8: &str = "not_utf8";
    pub const INVALID_JSON: &str = "invalid_json";
    pub const INVALID_TOML: &str = "invalid_toml";
    pub const INVALID_YAML: &str = "invalid_yaml";
    /// The document's root is not an object / table / mapping.
    pub const ROOT_NOT_OBJECT: &str = "root_not_object";
    /// The place the servers live in (`mcpServers`, `mcp.servers`,
    /// `mcp_servers`) holds something that is not a map of servers.
    pub const CONTAINER_INVALID: &str = "container_invalid";
    /// A key codeg would have to pick one occurrence of occurs more than once:
    /// in a JSON document, the servers' container, a server's name (in any
    /// location an operation on it reaches — OpenCode's `mcp.servers.<name>`
    /// and `mcp.<name>` both), or a field inside an entry; in YAML, two keys
    /// that read as one name (`1` and `"1"`). An edit would land on one the
    /// agent may not read, so codeg lists what is there and edits none of it.
    /// On a file: `detail` names the container. On an entry: `field` is the
    /// path of the repeated key inside it, absent when it is the entry's own
    /// name.
    pub const DUPLICATE_KEY: &str = "duplicate_key";
    /// The agent manages this file itself; codeg only lists it.
    pub const MANAGED_BY_AGENT: &str = "managed_by_agent";
    /// The file carries no write permission.
    pub const FILE_NOT_WRITABLE: &str = "file_not_writable";
    /// A second file the agent needs changed alongside (Claude Code's and
    /// CodeBuddy's `settings.json`) cannot be read.
    pub const RELATED_FILE_UNREADABLE: &str = "related_file_unreadable";

    // ── One entry that is not a usable server ────────────────────────────
    pub const ENTRY_NOT_AN_OBJECT: &str = "entry_not_an_object";
    pub const MISSING_COMMAND_OR_URL: &str = "missing_command_or_url";
    pub const UNSUPPORTED_TYPE: &str = "unsupported_type";
    /// Both a command and a url, where the agent takes exactly one.
    pub const COMMAND_AND_URL: &str = "command_and_url";
    pub const INVALID_COMMAND: &str = "invalid_command";
    pub const INVALID_URL: &str = "invalid_url";
    pub const INVALID_ARGS: &str = "invalid_args";
    pub const INVALID_ENV: &str = "invalid_env";
    pub const INVALID_HEADERS: &str = "invalid_headers";
    /// The agent's on/off flag holds something that is not a boolean.
    pub const INVALID_ENABLED_FLAG: &str = "invalid_enabled_flag";
    /// The entry's transport is one this agent cannot run.
    pub const UNSUPPORTED_TRANSPORT: &str = "unsupported_transport";
    /// The agent itself refuses an entry of this shape.
    pub const REJECTED_BY_AGENT: &str = "rejected_by_agent";
    /// The entry sits where an older release of the agent kept its servers.
    pub const LEGACY_LOCATION: &str = "legacy_location";
    /// The entry is named like codeg's built-in companion: it is listed, not
    /// editable, and never sent to a session.
    pub const RESERVED_KEY: &str = "reserved_key";

    // ── An operation that cannot be carried out ──────────────────────────
    pub const AGENT_READ_ONLY: &str = "agent_read_only";
    pub const FILE_READ_ONLY: &str = "file_read_only";
    pub const BASIS_REQUIRED: &str = "basis_required";
    pub const BASIS_MISMATCH: &str = "basis_mismatch";
    pub const KEY_INVALID: &str = "key_invalid";
    pub const KEY_RESERVED: &str = "key_reserved";
    pub const KEY_EXISTS: &str = "key_exists";
    /// The name would be taken for part of the document's structure rather
    /// than for a server (`mcpServers` in Antigravity's bare map).
    pub const KEY_STRUCTURAL: &str = "key_structural";
    pub const ENTRY_NOT_FOUND: &str = "entry_not_found";
    pub const ENTRY_NOT_EDITABLE: &str = "entry_not_editable";
    pub const TRANSPORT_UNSUPPORTED: &str = "transport_unsupported";
    pub const COMMAND_REQUIRED: &str = "command_required";
    pub const URL_REQUIRED: &str = "url_required";
    pub const ENV_NAME_REQUIRED: &str = "env_name_required";
    pub const HEADER_NAME_REQUIRED: &str = "header_name_required";
    pub const DISABLE_UNSUPPORTED: &str = "disable_unsupported";
    /// The document could not be edited in place (see `detail`).
    pub const EDIT_FAILED: &str = "edit_failed";

    // ── Writing ──────────────────────────────────────────────────────────
    pub const LOCK_BUSY: &str = "lock_busy";
    pub const LOCK_HELD: &str = "lock_held";
    pub const CODEX_LOCK_BUSY: &str = "codex_lock_busy";
    pub const CODEX_LOCK_HELD: &str = "codex_lock_held";
    pub const CODEX_REPAIR_NEEDED: &str = "codex_repair_needed";
    pub const BACKUP_FAILED: &str = "backup_failed";
    pub const WRITE_FAILED: &str = "write_failed";
    /// The file changed between codeg's write and the attempt to undo it.
    pub const CHANGED_AFTER_WRITE: &str = "changed_after_write";
    pub const RESTORE_FAILED: &str = "restore_failed";
    /// A commit of Codex's config.toml reached outside `mcp_servers`.
    pub const OUTSIDE_MCP_SERVERS: &str = "outside_mcp_servers";

    // ── Notes that stop nothing ──────────────────────────────────────────
    /// Saving this YAML file drops the comments in it.
    pub const YAML_COMMENTS_LOST: &str = "yaml_comments_lost";
    /// Fields of the other transport were removed with it (see `detail`).
    pub const FIELDS_DROPPED: &str = "fields_dropped";

    // ── Pasted text ──────────────────────────────────────────────────────
    pub const SNIPPET_EMPTY: &str = "snippet_empty";
    pub const SNIPPET_UNRECOGNIZED: &str = "snippet_unrecognized";
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpTransport {
    Stdio,
    Http,
    Sse,
}

impl McpTransport {
    pub fn as_str(self) -> &'static str {
        match self {
            McpTransport::Stdio => "stdio",
            McpTransport::Http => "http",
            McpTransport::Sse => "sse",
        }
    }

    pub fn is_remote(self) -> bool {
        !matches!(self, McpTransport::Stdio)
    }
}

/// A server as every agent understands it: how to start it, or where it is.
/// Anything else an agent keeps on an entry is that agent's own (`extra`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum McpDefinition {
    Stdio {
        command: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        args: Vec<String>,
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        env: BTreeMap<String, String>,
    },
    Http {
        url: String,
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        headers: BTreeMap<String, String>,
    },
    Sse {
        url: String,
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        headers: BTreeMap<String, String>,
    },
}

impl McpDefinition {
    pub fn transport(&self) -> McpTransport {
        match self {
            McpDefinition::Stdio { .. } => McpTransport::Stdio,
            McpDefinition::Http { .. } => McpTransport::Http,
            McpDefinition::Sse { .. } => McpTransport::Sse,
        }
    }

    /// A remote definition's parts.
    pub fn remote(&self) -> Option<(&str, &BTreeMap<String, String>)> {
        match self {
            McpDefinition::Http { url, headers } | McpDefinition::Sse { url, headers } => {
                Some((url.as_str(), headers))
            }
            McpDefinition::Stdio { .. } => None,
        }
    }

    /// The identity of this definition: equal definitions, wherever they
    /// are written and however their maps are ordered, share it.
    pub fn fingerprint(&self) -> String {
        let canonical = serde_json::to_vec(self).unwrap_or_default();
        super::fsio::sha256_hex(&canonical)
    }

    /// The shape `acp::connection` turns into an ACP `McpServer`.
    pub fn to_canonical_json(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

/// A coded remark: why a file cannot be used, what is wrong with an entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct McpIssue {
    pub code: String,
    /// The field of the entry it is about.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    /// Technical detail, not translated: an OS error, the offending value.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl McpIssue {
    pub fn new(code: &str) -> Self {
        Self {
            code: code.to_string(),
            field: None,
            detail: None,
        }
    }

    pub fn field(mut self, field: &str) -> Self {
        self.field = Some(field.to_string());
        self
    }

    pub fn detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum McpConfigFormat {
    Json,
    Jsonc,
    Toml,
    Yaml,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum McpFileStatus {
    /// Read, and codeg may change it.
    Ok,
    /// Not there. Writable unless the agent is listed only.
    Missing,
    /// It exists and could not be read or understood (`reason`).
    Unreadable,
    /// Read, but codeg will not change it (`reason`).
    ReadOnly,
}

/// How an agent's sessions come by the servers in its config file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum McpDelivery {
    /// The agent loads the file itself.
    AgentFile,
    /// codeg reads the file and sends the servers when a session starts.
    CodegSession,
}

/// A second file codeg keeps in step with an agent's servers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct McpRelatedFile {
    /// `plugin_gate`: the settings file whose `enabledPlugins` Claude Code
    /// and CodeBuddy activate user servers through.
    pub role: String,
    pub path: String,
    /// Why codeg cannot edit it, when it cannot: the agent's servers can then
    /// be listed but not added, removed or renamed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<McpIssue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct McpConfigFile {
    /// The file this agent reads, with the environment codeg launches the
    /// agent with applied.
    pub path: String,
    pub format: McpConfigFormat,
    pub status: McpFileStatus,
    /// Why, for `unreadable` and `read_only`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<McpIssue>,
    /// SHA-256 of the file's bytes (lowercase hex), `"missing"` for a file
    /// that is not there, `null` when it could not be read. Hand it back to
    /// `mcp_apply`.
    pub basis: Option<String>,
    /// The path is a symbolic link; writes go to what it points at.
    pub symlink: bool,
    /// Saving rewrites the whole document and drops the comments it has
    /// (YAML).
    pub comments_lost_on_write: bool,
    pub related: Vec<McpRelatedFile>,
}

/// What an agent's most recent session in this codeg said it can connect to
/// besides stdio servers. Only agents codeg sends servers to have one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct McpSessionCapabilities {
    pub http: bool,
    pub sse: bool,
    pub recorded_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct McpEntry {
    pub key: String,
    /// `null` when the entry is not a server codeg can describe (`problems`
    /// says why).
    pub definition: Option<McpDefinition>,
    /// The fields this agent keeps on the entry beyond the definition, as
    /// written. Shown, kept on every write, never copied to another agent.
    pub extra: Map<String, Value>,
    /// By this agent's own on/off flag; `true` where it has none.
    pub enabled: bool,
    /// [`McpDefinition::fingerprint`]; `null` without a definition.
    pub fingerprint: Option<String>,
    /// No operation is accepted on it.
    pub read_only: bool,
    /// Its name is codeg's own (`codeg-mcp`).
    pub reserved: bool,
    /// It sits where an older release of the agent kept servers. Editing it
    /// moves it to where the current one does.
    pub legacy: bool,
    pub problems: Vec<McpIssue>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct McpAgentInventory {
    pub agent: McpAppType,
    /// `null` when codeg could not tell.
    pub installed: Option<bool>,
    pub config: McpConfigFile,
    /// Whether `mcp_apply` accepts operations for this agent right now.
    pub writable: bool,
    /// The transports this agent's config can hold.
    pub transports: Vec<McpTransport>,
    pub delivery: McpDelivery,
    /// Whether the agent has an on/off flag of its own (`set_enabled`).
    pub can_disable: bool,
    /// The built-in `codeg-mcp` companion reaches this agent's sessions
    /// (when it is switched on in Settings).
    pub codeg_mcp: bool,
    /// For `codeg_session` agents; `null` until a session has started.
    pub session_capabilities: Option<McpSessionCapabilities>,
    pub entries: Vec<McpEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct McpInventory {
    pub agents: Vec<McpAgentInventory>,
    pub reserved_keys: Vec<String>,
    pub key_pattern: String,
}

// ─── mcp_apply ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum McpOpAction {
    /// Write this definition: a new entry, or the definition of the one
    /// already there (whose other fields stay).
    Set {
        definition: McpDefinition,
    },
    Remove,
    /// Turn the entry on or off with the agent's own flag.
    SetEnabled {
        enabled: bool,
    },
    Rename {
        new_key: String,
    },
}

/// One thing to do to one agent's entry.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct McpOp {
    pub agent: McpAppType,
    pub key: String,
    #[serde(flatten)]
    pub action: McpOpAction,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
pub struct McpApplyRequest {
    /// Per agent, the `config.basis` the caller last saw. Required for every
    /// agent an operation names, except in a preflight.
    #[serde(default)]
    pub basis: BTreeMap<McpAppType, String>,
    pub ops: Vec<McpOp>,
    /// Check everything and write nothing.
    #[serde(default)]
    pub preflight: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum McpApplyOutcome {
    /// A preflight: nothing was written. `ok` says whether it would be.
    Preflight,
    /// Every file that had to change was written.
    Applied,
    /// A file is not what the caller saw. Nothing was written.
    ChangedElsewhere,
    /// An operation cannot be carried out. Nothing was written.
    Invalid,
    /// A write failed part-way; see each agent for what was undone.
    WriteFailed,
    /// Another codeg held the MCP write lock. Nothing was written.
    Busy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum McpAgentStatus {
    /// Preflight: the operations would be written.
    Ready,
    /// The operations change nothing in this agent's files.
    Unchanged,
    /// Written.
    Written,
    Invalid,
    ChangedElsewhere,
    Unreadable,
    ReadOnly,
    /// Nothing wrong here, but the whole operation was called off.
    NotWritten,
    /// This agent's write failed; its file is as it was.
    WriteFailed,
    /// Written, then put back as it was after a later write failed.
    Restored,
    /// Written, then changed by something else before it could be put back:
    /// left as it is (`backup_path` has the copy from before).
    RestoreSkipped,
    /// Written, and putting it back failed (`backup_path`).
    RestoreFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct McpOpIssue {
    pub code: String,
    /// Position of the operation in `ops`, when it is about one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub op_index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl McpOpIssue {
    pub fn new(code: &str) -> Self {
        Self {
            code: code.to_string(),
            op_index: None,
            key: None,
            field: None,
            detail: None,
        }
    }

    pub fn op(mut self, index: usize, key: &str) -> Self {
        self.op_index = Some(index);
        self.key = Some(key.to_string());
        self
    }

    pub fn field(mut self, field: &str) -> Self {
        self.field = Some(field.to_string());
        self
    }

    pub fn detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    pub fn from_issue(issue: &McpIssue) -> Self {
        Self {
            code: issue.code.clone(),
            op_index: None,
            key: None,
            field: issue.field.clone(),
            detail: issue.detail.clone(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum McpOpEffect {
    Created,
    Updated,
    Removed,
    Renamed,
    Enabled,
    Disabled,
    /// Already so: the operation changes nothing.
    Unchanged,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct McpOpResult {
    /// Position of the operation in `ops`.
    pub index: usize,
    pub key: String,
    pub effect: McpOpEffect,
}

/// A file an agent's operations write.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct McpFileWrite {
    pub path: String,
    /// `servers` or `plugin_gate`.
    pub role: String,
    /// The file does not exist yet.
    pub creates: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct McpAgentResult {
    pub agent: McpAppType,
    pub path: String,
    pub status: McpAgentStatus,
    /// The basis of the agent's config file as this call left it (or, in a
    /// preflight, found it); `null` when it could not be read.
    pub basis: Option<String>,
    /// What stops this agent's operations.
    pub issues: Vec<McpOpIssue>,
    /// What the user should know, though it stops nothing.
    pub warnings: Vec<McpOpIssue>,
    pub ops: Vec<McpOpResult>,
    /// The files these operations write (or would).
    pub writes: Vec<McpFileWrite>,
    /// Where the copies codeg took before writing are, when it wrote.
    pub backup_paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct McpApplyResult {
    pub outcome: McpApplyOutcome,
    /// Applied in full — or, in a preflight, would be.
    pub ok: bool,
    pub agents: Vec<McpAgentResult>,
}

/// Payload of [`MCP_CHANGED_EVENT`]: which agents' configuration changed,
/// and nothing of what is in it — in Web mode every client of the instance
/// receives this.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct McpChanged {
    pub agents: Vec<McpAppType>,
}

// ─── mcp_parse_snippet ──────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum McpSnippetFormat {
    /// `{"mcpServers": {…}}` and its relatives (`servers`, `mcp.servers`).
    JsonServers,
    /// One server's object, with no name.
    JsonServer,
    /// `[mcp_servers.<name>]` tables.
    TomlServers,
    /// One server's keys, with no table header.
    TomlServer,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct McpSnippetServer {
    /// `null` when the text names none.
    pub key: Option<String>,
    pub definition: Option<McpDefinition>,
    /// Fields of the pasted entry that are not part of the definition. Not
    /// written anywhere.
    pub extra: Map<String, Value>,
    pub problems: Vec<McpIssue>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct McpSnippet {
    pub format: McpSnippetFormat,
    pub servers: Vec<McpSnippetServer>,
    /// Why nothing was recognised, when nothing was.
    pub problems: Vec<McpIssue>,
}
