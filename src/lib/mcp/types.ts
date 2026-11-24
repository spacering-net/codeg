/**
 * The MCP engine's interface: `mcp_inventory`, `mcp_apply`,
 * `mcp_parse_snippet` and the `mcp://changed` event, as the backend
 * serializes them (`src-tauri/src/commands/mcp_engine/`).
 *
 * Every field is snake_case on the wire — inside the arguments as well as in
 * the answers — so these names are the backend's, not the app's.
 *
 * What comes back is read as it may be sent by a NEWER Codeg too: a remote
 * workspace window or a browser can be talking to a server of a later
 * release. So wherever an answer holds one of a few known strings (an agent,
 * a status, an outcome), any other string is allowed for as well
 * ({@link Open}), and has to be shown as "unknown" rather than looked up. What
 * is SENT stays closed: an op names only agents and actions this build knows.
 */
import type { McpAppType } from "@/lib/types"

export type { McpAppType }

/**
 * One of a known set of strings, or one a newer backend added. `string & {}`
 * rather than `string`, so the known values survive for `switch`es and
 * editors.
 */
export type Open<T extends string> = T | (string & {})

/** Every agent's place in the order `mcp_inventory` lists them. A `Record`, so
 *  an agent added to `McpAppType` and not here does not compile. */
const APP_ORDER: Record<McpAppType, number> = {
  claude_code: 0,
  codex: 1,
  gemini: 2,
  open_claw: 3,
  open_code: 4,
  cline: 5,
  hermes: 6,
  code_buddy: 7,
  kimi_code: 8,
  grok: 9,
  cursor: 10,
  deepseek: 11,
  qoder: 12,
  antigravity: 13,
  kiro: 14,
  pi: 15,
  zcode: 16,
  trae: 17,
  command_code: 18,
  minimax_code: 19,
}

/** Every agent the engine knows, in the order `mcp_inventory` lists them. */
export const MCP_APP_TYPES: readonly McpAppType[] = (
  Object.keys(APP_ORDER) as McpAppType[]
).sort((a, b) => APP_ORDER[a] - APP_ORDER[b])

const APP_TYPE_SET: ReadonlySet<string> = new Set(MCP_APP_TYPES)

/** Whether `value` is an agent this build knows — the only kind an op may
 *  name. */
export function isMcpAppType(value: unknown): value is McpAppType {
  return typeof value === "string" && APP_TYPE_SET.has(value)
}

// ─── Definitions ──────────────────────────────────────────────────────

export type McpTransport = "stdio" | "http" | "sse"

export const MCP_TRANSPORTS: readonly McpTransport[] = ["stdio", "http", "sse"]

export function isMcpTransport(value: unknown): value is McpTransport {
  return value === "stdio" || value === "http" || value === "sse"
}

/** Internally tagged on `type`. `args` / `env` / `headers` are left out of an
 *  answer when they are empty, and may be left out of an op. */
export type McpDefinition =
  | {
      type: "stdio"
      command: string
      args?: string[]
      env?: Record<string, string>
    }
  | { type: "http"; url: string; headers?: Record<string, string> }
  | { type: "sse"; url: string; headers?: Record<string, string> }

export type McpStdioDefinition = Extract<McpDefinition, { type: "stdio" }>
export type McpRemoteDefinition = Exclude<McpDefinition, McpStdioDefinition>

// ─── mcp_inventory ────────────────────────────────────────────────────

export interface McpIssue {
  code: string
  field?: string
  /** Technical and untranslated: shown as such, never as the message. */
  detail?: string
}

export type McpConfigFormat = "json" | "jsonc" | "toml" | "yaml"
export type McpFileStatus = "ok" | "missing" | "unreadable" | "read_only"
export type McpDelivery = "agent_file" | "codeg_session"

export interface McpRelatedFile {
  role: Open<"plugin_gate">
  path: string
  /** Present when codeg cannot edit this file: the agent's servers can then
   *  be listed, but `set`, `remove` and `rename` on it are refused. */
  reason?: McpIssue
}

export interface McpConfigFile {
  /** The actual path, with the agent's launch environment applied. */
  path: string
  format: Open<McpConfigFormat>
  status: Open<McpFileStatus>
  /** Present for `unreadable` and `read_only`. */
  reason?: McpIssue
  /** sha-256 of the file's bytes; `"missing"` when there is no file; `null`
   *  when it could not be read. */
  basis: string | null
  symlink: boolean
  /** YAML with comments: a save drops them. */
  comments_lost_on_write: boolean
  related: McpRelatedFile[]
}

export interface McpSessionCapabilities {
  http: boolean
  sse: boolean
  /** RFC 3339, UTC. */
  recorded_at: string
}

export interface McpEntry {
  key: string
  /** `null` when the entry is not a server Codeg can describe. */
  definition: McpDefinition | null
  /** The agent's own fields on the entry, as written. Display only. */
  extra: Record<string, unknown>
  /** By the agent's own flag; `true` where it has none. */
  enabled: boolean
  /** sha-256 of the definition; `null` without one. Equal fingerprints are
   *  equal definitions. */
  fingerprint: string | null
  /** No op is accepted on it. */
  read_only: boolean
  /** The key is `codeg-mcp`. */
  reserved: boolean
  /** In an older location of the file; editing moves it. */
  legacy: boolean
  problems: McpIssue[]
}

export interface McpAgentInventory {
  agent: Open<McpAppType>
  /** `null`: codeg could not tell. */
  installed: boolean | null
  config: McpConfigFile
  /** `mcp_apply` accepts ops for this agent right now. */
  writable: boolean
  /** What this agent's config can hold. */
  transports: Open<McpTransport>[]
  delivery: Open<McpDelivery>
  /** `set_enabled` is supported. */
  can_disable: boolean
  /** The built-in codeg-mcp companion can reach this agent's sessions (when
   *  it is switched on in Settings). */
  codeg_mcp: boolean
  session_capabilities: McpSessionCapabilities | null
  entries: McpEntry[]
}

export interface McpInventory {
  agents: McpAgentInventory[]
  reserved_keys: string[]
  /** The rule for NEW keys only. */
  key_pattern: string
}

// ─── mcp_apply ────────────────────────────────────────────────────────

/** One thing to do to one agent's entry. `action` is the tag; its fields sit
 *  beside it. */
export type McpOp =
  | {
      agent: McpAppType
      key: string
      action: "set"
      definition: McpDefinition
    }
  | { agent: McpAppType; key: string; action: "remove" }
  | {
      agent: McpAppType
      key: string
      action: "set_enabled"
      enabled: boolean
    }
  | { agent: McpAppType; key: string; action: "rename"; new_key: string }

/** `config.basis` per agent, as last seen. */
export type McpBasis = Partial<Record<McpAppType, string>>

export interface McpApplyArgs {
  basis?: McpBasis
  ops: McpOp[]
  /** `true`: check everything, write nothing. */
  preflight?: boolean
}

export type McpApplyOutcome =
  | "preflight"
  | "applied"
  | "changed_elsewhere"
  | "invalid"
  | "write_failed"
  | "busy"

export type McpAgentStatus =
  | "ready"
  | "unchanged"
  | "written"
  | "invalid"
  | "changed_elsewhere"
  | "unreadable"
  | "read_only"
  | "not_written"
  | "write_failed"
  | "restored"
  | "restore_skipped"
  | "restore_failed"

export interface McpOpIssue {
  code: string
  /** Index into `ops`, when the issue is about one op. */
  op_index?: number
  /** That op's key. */
  key?: string
  field?: string
  detail?: string
}

export type McpOpEffect =
  | "created"
  | "updated"
  | "removed"
  | "renamed"
  | "enabled"
  | "disabled"
  | "unchanged"

export interface McpOpResult {
  index: number
  key: string
  effect: Open<McpOpEffect>
}

export interface McpFileWrite {
  path: string
  role: Open<"servers" | "plugin_gate">
  /** The file does not exist yet. */
  creates: boolean
}

export interface McpAgentResult {
  agent: Open<McpAppType>
  /** The agent's servers file. */
  path: string
  status: Open<McpAgentStatus>
  /** The servers file's basis as this call left it (a preflight: found it);
   *  `null` when unreadable or busy. */
  basis: string | null
  /** What stops this agent's ops. */
  issues: McpOpIssue[]
  /** Worth telling the user; stops nothing. */
  warnings: McpOpIssue[]
  /** One per op that could be carried out in memory. */
  ops: McpOpResult[]
  /** The files these ops write (or would). */
  writes: McpFileWrite[]
  /** Pre-write copies taken by this call. */
  backup_paths: string[]
}

export interface McpApplyResult {
  outcome: Open<McpApplyOutcome>
  /** Applied in full — or, in a preflight, would be. */
  ok: boolean
  /** One per agent named in `ops`, in order of first appearance. */
  agents: McpAgentResult[]
}

// ─── mcp_parse_snippet ────────────────────────────────────────────────

export type McpSnippetFormat =
  | "json_servers"
  | "json_server"
  | "toml_servers"
  | "toml_server"
  | "unknown"

export interface McpSnippetServer {
  /** `null` when the text names none (a single server object). */
  key: string | null
  definition: McpDefinition | null
  /** Other fields of the pasted entry; never written. */
  extra: Record<string, unknown>
  problems: McpIssue[]
}

export interface McpSnippet {
  format: Open<McpSnippetFormat>
  /** In the order of the text. */
  servers: McpSnippetServer[]
  /** Why nothing was recognised (format `unknown`). */
  problems: McpIssue[]
}

// ─── mcp://changed ────────────────────────────────────────────────────

export const MCP_CHANGED_EVENT = "mcp://changed"

/** Agent names only: no paths, no keys, no configuration. */
export interface McpChanged {
  agents: Open<McpAppType>[]
}
