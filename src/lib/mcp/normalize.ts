/**
 * The engine's answers, read defensively.
 *
 * The backend is Codeg's own, but not necessarily this build's: a remote
 * workspace window or a browser can reach a server of another release. So an
 * answer is checked for the shape the page relies on before anything reads
 * it, and whatever a newer backend added is let through as it is — an unknown
 * status stays a string the labels call "unknown", an unknown field is
 * ignored. Only an answer the page could not work with at all (not an object,
 * no list of agents) is refused, as `invalidResponse`.
 *
 * One thing is reinterpreted: a definition whose `type` this build does not
 * know (a transport added later). The page cannot show or edit it as a
 * server, so the entry is read the way the backend reads an entry it cannot
 * describe — no definition, no fingerprint — with the problem the backend
 * uses for a word it does not know (`unsupported_type`).
 */
import { McpClientError } from "./errors"
import type {
  McpAgentInventory,
  McpAgentResult,
  McpApplyResult,
  McpChanged,
  McpConfigFile,
  McpDefinition,
  McpEntry,
  McpFileWrite,
  McpInventory,
  McpIssue,
  McpOpIssue,
  McpOpResult,
  McpRelatedFile,
  McpSessionCapabilities,
  McpSnippet,
  McpSnippetServer,
} from "./types"

type Raw = Record<string, unknown>

function isRaw(value: unknown): value is Raw {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback
}

function list<T>(value: unknown, read: (item: unknown) => T | null): T[] {
  if (!Array.isArray(value)) return []
  const out: T[] = []
  for (const item of value) {
    const read_ = read(item)
    if (read_ !== null) out.push(read_)
  }
  return out
}

function strings(value: unknown): string[] {
  return list(value, (item) => (typeof item === "string" ? item : null))
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRaw(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") out[key] = item
  }
  return out
}

function optional<T extends object>(value: T): T | undefined {
  return Object.keys(value).length > 0 ? value : undefined
}

function issue(value: unknown): McpIssue | null {
  if (!isRaw(value) || typeof value.code !== "string") return null
  const out: McpIssue = { code: value.code }
  if (typeof value.field === "string") out.field = value.field
  if (typeof value.detail === "string") out.detail = value.detail
  return out
}

function opIssue(value: unknown): McpOpIssue | null {
  const base = issue(value)
  if (!base || !isRaw(value)) return null
  const out: McpOpIssue = { code: base.code }
  if (typeof value.op_index === "number") out.op_index = value.op_index
  if (typeof value.key === "string") out.key = value.key
  if (base.field !== undefined) out.field = base.field
  if (base.detail !== undefined) out.detail = base.detail
  return out
}

/** A definition this build can show and edit, or `null` — with the word that
 *  made it unreadable, when that was its `type`. */
function definition(value: unknown): {
  definition: McpDefinition | null
  unknownType?: string
} {
  if (!isRaw(value)) return { definition: null }
  const type = value.type
  if (type === "stdio") {
    if (typeof value.command !== "string") return { definition: null }
    const args = strings(value.args)
    const env = stringRecord(value.env)
    return {
      definition: {
        type,
        command: value.command,
        ...(args.length > 0 ? { args } : {}),
        ...(optional(env) ? { env } : {}),
      },
    }
  }
  if (type === "http" || type === "sse") {
    if (typeof value.url !== "string") return { definition: null }
    const headers = stringRecord(value.headers)
    return {
      definition: {
        type,
        url: value.url,
        ...(optional(headers) ? { headers } : {}),
      },
    }
  }
  return {
    definition: null,
    unknownType: typeof type === "string" ? type : undefined,
  }
}

/**
 * A definition from any answer that carries one (an install plan, a key
 * conflict), read the way an inventory's are: `null` for one this build
 * cannot show as a server.
 */
export function normalizeDefinition(value: unknown): McpDefinition | null {
  return definition(value).definition
}

function entry(value: unknown): McpEntry | null {
  if (!isRaw(value) || typeof value.key !== "string") return null
  const read = definition(value.definition)
  const problems = list(value.problems, issue)
  if (read.unknownType !== undefined) {
    problems.push({
      code: "unsupported_type",
      field: "type",
      detail: read.unknownType,
    })
  }
  return {
    key: value.key,
    definition: read.definition,
    extra: isRaw(value.extra) ? value.extra : {},
    enabled: bool(value.enabled, true),
    // Only meaningful beside a definition this build can read.
    fingerprint: read.definition ? strOrNull(value.fingerprint) : null,
    read_only: bool(value.read_only),
    reserved: bool(value.reserved),
    legacy: bool(value.legacy),
    problems,
  }
}

function related(value: unknown): McpRelatedFile | null {
  if (!isRaw(value) || typeof value.path !== "string") return null
  const out: McpRelatedFile = { role: str(value.role), path: value.path }
  const reason = issue(value.reason)
  if (reason) out.reason = reason
  return out
}

function config(value: unknown): McpConfigFile {
  const raw = isRaw(value) ? value : {}
  const out: McpConfigFile = {
    path: str(raw.path),
    format: str(raw.format),
    status: str(raw.status),
    basis: strOrNull(raw.basis),
    symlink: bool(raw.symlink),
    comments_lost_on_write: bool(raw.comments_lost_on_write),
    related: list(raw.related, related),
  }
  const reason = issue(raw.reason)
  if (reason) out.reason = reason
  return out
}

function capabilities(value: unknown): McpSessionCapabilities | null {
  if (!isRaw(value)) return null
  return {
    http: bool(value.http),
    sse: bool(value.sse),
    recorded_at: str(value.recorded_at),
  }
}

function agent(value: unknown): McpAgentInventory | null {
  if (!isRaw(value) || typeof value.agent !== "string") return null
  return {
    agent: value.agent,
    installed: typeof value.installed === "boolean" ? value.installed : null,
    config: config(value.config),
    writable: bool(value.writable),
    transports: strings(value.transports),
    delivery: str(value.delivery),
    can_disable: bool(value.can_disable),
    codeg_mcp: bool(value.codeg_mcp),
    session_capabilities: capabilities(value.session_capabilities),
    entries: list(value.entries, entry),
  }
}

export function normalizeInventory(value: unknown): McpInventory {
  if (!isRaw(value) || !Array.isArray(value.agents)) {
    throw new McpClientError(
      "invalidResponse",
      "mcp_inventory answered with something that is not an inventory"
    )
  }
  return {
    agents: list(value.agents, agent),
    reserved_keys: strings(value.reserved_keys),
    key_pattern: str(value.key_pattern),
  }
}

function opResult(value: unknown): McpOpResult | null {
  if (!isRaw(value) || typeof value.index !== "number") return null
  return { index: value.index, key: str(value.key), effect: str(value.effect) }
}

function fileWrite(value: unknown): McpFileWrite | null {
  if (!isRaw(value) || typeof value.path !== "string") return null
  return {
    path: value.path,
    role: str(value.role),
    creates: bool(value.creates),
  }
}

function agentResult(value: unknown): McpAgentResult | null {
  if (!isRaw(value) || typeof value.agent !== "string") return null
  return {
    agent: value.agent,
    path: str(value.path),
    status: str(value.status),
    basis: strOrNull(value.basis),
    issues: list(value.issues, opIssue),
    warnings: list(value.warnings, opIssue),
    ops: list(value.ops, opResult),
    writes: list(value.writes, fileWrite),
    backup_paths: strings(value.backup_paths),
  }
}

export function normalizeApplyResult(value: unknown): McpApplyResult {
  if (!isRaw(value) || typeof value.outcome !== "string") {
    throw new McpClientError(
      "invalidResponse",
      "mcp_apply answered with something that is not a result"
    )
  }
  return {
    outcome: value.outcome,
    ok: bool(value.ok),
    agents: list(value.agents, agentResult),
  }
}

function snippetServer(value: unknown): McpSnippetServer | null {
  if (!isRaw(value)) return null
  const read = definition(value.definition)
  const problems = list(value.problems, issue)
  if (read.unknownType !== undefined) {
    problems.push({
      code: "unsupported_type",
      field: "type",
      detail: read.unknownType,
    })
  }
  return {
    key: strOrNull(value.key),
    definition: read.definition,
    extra: isRaw(value.extra) ? value.extra : {},
    problems,
  }
}

export function normalizeSnippet(value: unknown): McpSnippet {
  if (!isRaw(value) || typeof value.format !== "string") {
    throw new McpClientError(
      "invalidResponse",
      "mcp_parse_snippet answered with something that is not a snippet"
    )
  }
  return {
    format: value.format,
    servers: list(value.servers, snippetServer),
    problems: list(value.problems, issue),
  }
}

export function normalizeChanged(value: unknown): McpChanged {
  return { agents: isRaw(value) ? strings(value.agents) : [] }
}
