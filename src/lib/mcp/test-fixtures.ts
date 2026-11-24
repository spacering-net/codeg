/**
 * Engine answers for tests, shaped as the backend serializes them. Each
 * builder takes the fields a test cares about and fills in the rest.
 */
import type {
  McpAgentInventory,
  McpAgentResult,
  McpApplyResult,
  McpDefinition,
  McpEntry,
  McpInventory,
  McpOp,
} from "./types"

let fingerprints = new Map<string, string>()

/** A stable stand-in for the engine's fingerprint: equal definitions, equal
 *  fingerprints — env and headers in any order, args in order. */
export function fingerprintOf(definition: McpDefinition): string {
  const sorted = (record: Record<string, string> | undefined) =>
    Object.entries(record ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))
  const key = JSON.stringify(
    definition.type === "stdio"
      ? [
          definition.type,
          definition.command,
          definition.args ?? [],
          sorted(definition.env),
        ]
      : [definition.type, definition.url, sorted(definition.headers)]
  )
  let fingerprint = fingerprints.get(key)
  if (!fingerprint) {
    fingerprint = `fp${fingerprints.size + 1}`.padEnd(64, "0")
    fingerprints.set(key, fingerprint)
  }
  return fingerprint
}

export function resetFingerprints() {
  fingerprints = new Map()
}

export const stdio = (
  command = "npx",
  args: string[] = ["-y", "server"],
  env?: Record<string, string>
): McpDefinition => ({
  type: "stdio",
  command,
  ...(args.length > 0 ? { args } : {}),
  ...(env ? { env } : {}),
})

export const remote = (
  type: "http" | "sse",
  url = "https://mcp.example.com/mcp",
  headers?: Record<string, string>
): McpDefinition => ({ type, url, ...(headers ? { headers } : {}) })

export function entry(
  key: string,
  definition: McpDefinition | null = stdio(),
  overrides: Partial<McpEntry> = {}
): McpEntry {
  return {
    key,
    definition,
    extra: {},
    enabled: true,
    fingerprint: definition ? fingerprintOf(definition) : null,
    read_only: false,
    reserved: key === "codeg-mcp",
    legacy: false,
    problems: [],
    ...overrides,
  }
}

const TRANSPORTS: Record<string, McpAgentInventory["transports"]> = {
  codex: ["stdio", "http"],
  open_code: ["stdio", "http"],
  deepseek: ["stdio", "http"],
  kiro: ["stdio", "http"],
  zcode: ["stdio"],
  trae: ["stdio", "http"],
  command_code: ["stdio", "http"],
}

const CAN_DISABLE = new Set([
  "codex",
  "open_code",
  "cline",
  "hermes",
  "code_buddy",
  "kimi_code",
  "grok",
  "deepseek",
  "qoder",
  "kiro",
  "zcode",
  "trae",
  "command_code",
  "minimax_code",
])

const SESSION = new Set([
  "claude_code",
  "codex",
  "gemini",
  "code_buddy",
  "deepseek",
  "zcode",
  "minimax_code",
])

export function agent(
  id: string,
  entries: McpEntry[] = [],
  overrides: Omit<Partial<McpAgentInventory>, "config"> & {
    config?: Partial<McpAgentInventory["config"]>
  } = {}
): McpAgentInventory {
  const { config, ...rest } = overrides
  const listed = id === "open_claw" || id === "pi"
  return {
    agent: id,
    installed: true,
    config: {
      path: `/home/u/.${id}/config.json`,
      format:
        id === "codex" || id === "trae" || id === "grok"
          ? "toml"
          : id === "hermes"
            ? "yaml"
            : "json",
      status: "ok",
      basis: `basis-${id}-1`,
      symlink: false,
      comments_lost_on_write: false,
      related: [],
      ...(listed
        ? { status: "read_only", reason: { code: "managed_by_agent" } }
        : {}),
      ...config,
    },
    writable:
      !listed &&
      (config?.status ?? "ok") !== "unreadable" &&
      (config?.status ?? "ok") !== "read_only",
    transports: TRANSPORTS[id] ?? ["stdio", "http", "sse"],
    delivery: SESSION.has(id) ? "codeg_session" : "agent_file",
    can_disable: CAN_DISABLE.has(id),
    codeg_mcp: !["cline", "pi", "open_claw"].includes(id),
    session_capabilities: null,
    entries: listed
      ? entries.map((item) => ({ ...item, read_only: true }))
      : entries,
    ...rest,
  }
}

export function inventory(agents: McpAgentInventory[]): McpInventory {
  return {
    agents,
    reserved_keys: ["codeg-mcp"],
    key_pattern: "^[A-Za-z0-9_-]{1,64}$",
  }
}

export function agentResult(
  id: string,
  overrides: Partial<McpAgentResult> = {}
): McpAgentResult {
  return {
    agent: id,
    path: `/home/u/.${id}/config.json`,
    status: "ready",
    basis: `basis-${id}-1`,
    issues: [],
    warnings: [],
    ops: [],
    writes: [
      { path: `/home/u/.${id}/config.json`, role: "servers", creates: false },
    ],
    backup_paths: [],
    ...overrides,
  }
}

/** What a preflight of `ops` answers when nothing stops them. */
export function preflightOf(
  ops: McpOp[],
  overrides: Partial<Record<string, Partial<McpAgentResult>>> = {}
): McpApplyResult {
  const agents = [...new Set(ops.map((op) => op.agent))]
  const results = agents.map((id) =>
    agentResult(id, {
      ops: ops
        .map((op, index) => ({ op, index }))
        .filter(({ op }) => op.agent === id)
        .map(({ op, index }) => ({
          index,
          key: op.key,
          effect:
            op.action === "remove"
              ? "removed"
              : op.action === "rename"
                ? "renamed"
                : op.action === "set_enabled"
                  ? op.enabled
                    ? "enabled"
                    : "disabled"
                  : "updated",
        })),
      ...overrides[id],
    })
  )
  return {
    outcome: "preflight",
    ok: results.every((result) =>
      ["ready", "unchanged"].includes(result.status)
    ),
    agents: results,
  }
}

/** What a real run of `ops` answers when everything was written. */
export function appliedOf(ops: McpOp[]): McpApplyResult {
  const preflight = preflightOf(ops)
  return {
    outcome: "applied",
    ok: true,
    agents: preflight.agents.map((result) => ({
      ...result,
      status: "written",
      basis: `${result.basis}-next`,
      backup_paths: [`/home/u/.codeg/mcp/backups/${result.agent}/x.bak`],
    })),
  }
}
