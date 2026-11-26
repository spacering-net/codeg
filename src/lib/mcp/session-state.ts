/**
 * Unified per-session MCP status state machine (#1296 Phase 2).
 *
 * Combines live session runtime state (`SessionMcpState` from ACP events /
 * snapshots), host-side inventory (`McpAgentInventory`), on-demand host probes
 * (`McpProbeResult`), active session initialization failures, and config-stale
 * signals into one deterministic, pure model shared by:
 *   - Session Details sidebar flat accordion (`SessionMcpSection`)
 *   - Composer compact MCP status popover (`SessionMcpPopover`)
 *
 * Gracefully degrades on older servers that do not emit `session_mcp_state`
 * (or for draft/disconnected sessions) by deriving rows from `inventoryAgent`,
 * `probeMap`, and `sessionFailures`.
 */
import type {
  AgentType,
  ConfigStaleKind,
  ConnectionStatus,
  SessionFailureRecord,
  SessionMcpCapabilitiesSnapshot,
  SessionMcpServerEntry,
  SessionMcpState,
} from "@/lib/types"
import { agentTypeToMcpApp, extractMcpInitFailure } from "./failure-recovery"
import type {
  McpAgentId,
  McpAgentInventory,
  McpDefinition,
  McpEntry,
  McpProbeResult,
  McpTransport,
  Open,
} from "./types"

export type UnifiedMcpStatus =
  /** Confirmed in the running session (backend `confirmed` or non-`codeg-mcp`
   *  tool call observed in transcript, with no config drift). */
  | "session_confirmed"
  /** Session initialization failed or latest host probe failed. */
  | "connection_failed"
  /** Latest host probe returned `auth_required` (401 OAuth). */
  | "auth_required"
  /** Added, modified, resumed, paused, or removed after session launch —
   *  reconnect needed for the running session to match saved config. */
  | "saved_pending_reconnect"
  /** Host probe succeeded (`ok`, with tools count & latency), not yet
   *  confirmed inside the session. */
  | "probe_healthy"
  /** Skipped at session launch because the session did not advertise HTTP/SSE. */
  | "skipped_transport"
  /** Attached / read from local config at session launch; not yet probed. */
  | "configured"
  /** Currently paused or disabled. */
  | "paused"

export interface SessionMcpProbeRecord {
  phase: "loading" | "ready" | "error"
  fingerprint: string | null
  result: McpProbeResult | null
  failure: { kind: string; detail: string | null } | null
}

export type SessionMcpProbeMap = Readonly<Record<string, SessionMcpProbeRecord>>

export interface UnifiedMcpServerRow {
  key: string
  transport: Open<McpTransport> | null
  status: UnifiedMcpStatus
  origin: "codeg_session" | "agent_file" | null
  toolsCount: number | null
  confirmedTools: string[]
  probe: SessionMcpProbeRecord | null
  detail: string | null
  needsReconnect: boolean
  canPause: boolean
  canProbe: boolean
  paused: boolean
  removedPendingReconnect: boolean
  fingerprint: string | null
  definition: McpDefinition | null
}

export interface UnifiedMcpSummary {
  totalCount: number
  activeCount: number
  confirmedCount: number
  healthyCount: number
  attentionCount: number
  pendingReconnectCount: number
  pausedCount: number
}

export interface UnifiedMcpState {
  mcpAgentId: McpAgentId | null
  delivery: "agent_file" | "codeg_session" | null
  supportsMcp: boolean
  codegMcpAttached: boolean
  capabilities: SessionMcpCapabilitiesSnapshot | null
  needsReconnect: boolean
  rows: UnifiedMcpServerRow[]
  summary: UnifiedMcpSummary
}

export interface DeriveSessionMcpStateInput {
  agentType: AgentType | null | undefined
  connectionStatus?: ConnectionStatus | null
  sessionMcpState?: SessionMcpState | null
  inventoryAgent?: McpAgentInventory | null
  probeMap?: SessionMcpProbeMap | null
  sessionFailures?: readonly SessionFailureRecord[]
  errorText?: string | null
  configStale?: boolean
  configStaleKind?: ConfigStaleKind | null
  /** Optional map of MCP server key -> tool names observed in transcript
   *  (excluding `codeg-mcp`). */
  observedToolsByServer?: Readonly<Record<string, readonly string[]>>
}

const RESERVED_KEYS = new Set(["codeg-mcp", "codeg_mcp"])

export function sessionProbeEntryKey(agent: McpAgentId, key: string): string {
  return `entry:${agent}:${key}`
}

function sessionProbeGroupKey(key: string, fingerprint: string): string {
  return `group:${key}:${fingerprint}`
}

function normalizeServerMatchKey(name: string): string {
  return name.trim().toLowerCase().replace(/-/g, "_")
}

/**
 * Extract observed non-`codeg-mcp` MCP tool calls from transcript tool names
 * (e.g. `mcp__github__search_issues` -> `{ github: ["search_issues"] }`)
 * matched against `knownServerKeys`.
 */
export function extractObservedMcpTools(
  toolNames: Iterable<string>,
  knownServerKeys: ReadonlySet<string>
): Record<string, string[]> {
  if (knownServerKeys.size === 0) return {}
  const normalizedToKey = new Map<string, string>()
  for (const key of knownServerKeys) {
    if (RESERVED_KEYS.has(key.toLowerCase())) continue
    normalizedToKey.set(normalizeServerMatchKey(key), key)
  }
  const result: Record<string, Set<string>> = {}
  for (const rawName of toolNames) {
    if (!rawName || !rawName.startsWith("mcp__")) continue
    const rest = rawName.slice("mcp__".length)
    const sep = rest.indexOf("__")
    if (sep <= 0) continue
    const rawServer = rest.slice(0, sep)
    const toolName = rest.slice(sep + 2).trim()
    if (!toolName || RESERVED_KEYS.has(rawServer.toLowerCase())) continue
    const canonical = normalizedToKey.get(normalizeServerMatchKey(rawServer))
    if (!canonical) continue
    if (!result[canonical]) result[canonical] = new Set()
    result[canonical].add(toolName)
  }
  const out: Record<string, string[]> = {}
  for (const [serverKey, tools] of Object.entries(result)) {
    out[serverKey] = [...tools]
  }
  return out
}

function extractFailuresFromText(
  text: string | null | undefined,
  target: Map<string, string>
): void {
  if (!text) return
  for (const line of text.split(/\r?\n/)) {
    const found = extractMcpInitFailure(line)
    if (found && !RESERVED_KEYS.has(found.serverName.toLowerCase())) {
      target.set(found.serverName, found.reason)
    }
  }
}

function collectSessionInitFailures(
  sessionFailures: readonly SessionFailureRecord[] | undefined,
  errorText: string | null | undefined
): Map<string, string> {
  const failures = new Map<string, string>()
  if (sessionFailures) {
    for (const record of sessionFailures) {
      if (record.resolved) continue
      extractFailuresFromText(record.details, failures)
      extractFailuresFromText(record.title, failures)
    }
  }
  extractFailuresFromText(errorText, failures)
  return failures
}

function isEntrySkippedByCapabilities(
  delivery: "agent_file" | "codeg_session" | null,
  caps: SessionMcpCapabilitiesSnapshot | null,
  transport: Open<McpTransport> | null
): boolean {
  if (delivery !== "codeg_session" || !caps || !transport) return false
  return (
    (transport === "http" && !caps.http) || (transport === "sse" && !caps.sse)
  )
}

function resolveProbeForEntry(
  probeMap: SessionMcpProbeMap | null | undefined,
  mcpAgentId: McpAgentId | null,
  key: string,
  fingerprint: string | null
): SessionMcpProbeRecord | null {
  if (!probeMap) return null
  const entryCandidate = mcpAgentId
    ? probeMap[sessionProbeEntryKey(mcpAgentId, key)]
    : undefined
  if (entryCandidate) {
    if (
      entryCandidate.phase === "loading" ||
      fingerprint === null ||
      entryCandidate.fingerprint === null ||
      entryCandidate.fingerprint === fingerprint
    ) {
      return entryCandidate
    }
  }
  if (fingerprint) {
    const groupCandidate = probeMap[sessionProbeGroupKey(key, fingerprint)]
    if (groupCandidate) return groupCandidate
  }
  return null
}

function mergeConfirmedTools(
  sessionEntry: SessionMcpServerEntry | undefined,
  observed: readonly string[] | undefined
): string[] {
  const set = new Set<string>()
  for (const tool of sessionEntry?.confirmed_tools ?? []) {
    if (tool) set.add(tool)
  }
  for (const tool of observed ?? []) {
    if (tool) set.add(tool)
  }
  return [...set]
}

function isRunningSessionEntry(
  entry: SessionMcpServerEntry | undefined
): boolean {
  if (!entry) return false
  return (
    entry.status === "attached" ||
    entry.status === "configured" ||
    entry.status === "confirmed" ||
    entry.status === "skipped_transport"
  )
}

export function deriveSessionMcpState(
  input: DeriveSessionMcpStateInput
): UnifiedMcpState {
  const {
    agentType,
    connectionStatus,
    sessionMcpState,
    inventoryAgent,
    probeMap,
    sessionFailures,
    errorText,
    configStale = false,
    configStaleKind = null,
    observedToolsByServer,
  } = input

  const mcpAgentId = agentTypeToMcpApp(agentType)
  const hasLiveSession =
    connectionStatus === "connected" ||
    connectionStatus === "prompting" ||
    sessionMcpState != null

  const inventoryDelivery: "agent_file" | "codeg_session" | null =
    inventoryAgent?.delivery === "agent_file"
      ? "agent_file"
      : inventoryAgent?.delivery === "codeg_session"
        ? "codeg_session"
        : null
  const delivery: "agent_file" | "codeg_session" | null =
    sessionMcpState?.delivery ?? inventoryDelivery

  const capabilities: SessionMcpCapabilitiesSnapshot | null =
    sessionMcpState?.capabilities ??
    (inventoryAgent?.session_capabilities
      ? {
          http: inventoryAgent.session_capabilities.http,
          sse: inventoryAgent.session_capabilities.sse,
        }
      : null)

  const supportsMcp =
    sessionMcpState != null
      ? sessionMcpState.supports_mcp
      : inventoryAgent != null
        ? inventoryAgent.config.reason?.code !==
          "mcp_disabled_in_agent_settings"
        : mcpAgentId != null

  const codegMcpAttached =
    sessionMcpState?.codeg_mcp_attached ?? Boolean(inventoryAgent?.codeg_mcp)

  const initFailures = collectSessionInitFailures(sessionFailures, errorText)

  // Index session entries and inventory entries, preserving deterministic order.
  const sessionByKey = new Map<string, SessionMcpServerEntry>()
  const invByKey = new Map<string, McpEntry>()
  const orderedKeys: string[] = []
  const seenKeys = new Set<string>()
  const pushKey = (key: string) => {
    if (!key || RESERVED_KEYS.has(key.toLowerCase()) || seenKeys.has(key)) {
      return
    }
    seenKeys.add(key)
    orderedKeys.push(key)
  }

  for (const entry of sessionMcpState?.servers ?? []) {
    if (RESERVED_KEYS.has(entry.key.toLowerCase())) continue
    sessionByKey.set(entry.key, entry)
    pushKey(entry.key)
  }
  for (const entry of inventoryAgent?.entries ?? []) {
    if (entry.reserved || RESERVED_KEYS.has(entry.key.toLowerCase())) continue
    if (!invByKey.has(entry.key)) invByKey.set(entry.key, entry)
    pushKey(entry.key)
  }
  for (const key of initFailures.keys()) {
    pushKey(key)
  }

  const rows: UnifiedMcpServerRow[] = orderedKeys.map((key) => {
    const sessionEntry = sessionByKey.get(key)
    const invEntry = invByKey.get(key)
    const fingerprint =
      invEntry?.fingerprint ?? sessionEntry?.fingerprint ?? null
    const transport: Open<McpTransport> | null =
      invEntry?.definition?.type ?? sessionEntry?.transport ?? null
    const origin: "codeg_session" | "agent_file" | null =
      sessionEntry?.origin ?? delivery
    const probe = resolveProbeForEntry(probeMap, mcpAgentId, key, fingerprint)
    const failureReason = initFailures.get(key) ?? null

    const wasActiveInSession = isRunningSessionEntry(sessionEntry)
    const removedPendingReconnect = Boolean(
      hasLiveSession &&
      sessionMcpState != null &&
      wasActiveInSession &&
      inventoryAgent != null &&
      invEntry == null
    )
    const pausedAfterStart = Boolean(
      hasLiveSession &&
      sessionMcpState != null &&
      wasActiveInSession &&
      invEntry != null &&
      !invEntry.enabled
    )
    const addedOrResumedAfterStart = Boolean(
      hasLiveSession &&
      sessionMcpState != null &&
      invEntry != null &&
      invEntry.enabled &&
      sessionEntry == null
    )
    const modifiedAfterStart = Boolean(
      hasLiveSession &&
      sessionMcpState != null &&
      sessionEntry != null &&
      invEntry != null &&
      invEntry.enabled &&
      sessionEntry.fingerprint != null &&
      invEntry.fingerprint != null &&
      sessionEntry.fingerprint !== invEntry.fingerprint
    )
    const rowNeedsReconnect =
      removedPendingReconnect ||
      pausedAfterStart ||
      addedOrResumedAfterStart ||
      modifiedAfterStart

    const confirmedTools = mergeConfirmedTools(
      sessionEntry,
      observedToolsByServer?.[key]
    )

    const probeResult = probe?.phase === "ready" ? probe.result : null
    const probeAuthRequired = probeResult?.status === "auth_required"
    const probeFailed =
      probe?.phase === "error" ||
      (probeResult != null &&
        probeResult.status !== "ok" &&
        probeResult.status !== "auth_required")
    const probeHealthy = probeResult?.status === "ok"

    const skippedByCaps =
      sessionEntry?.status === "skipped_transport" ||
      (invEntry != null &&
        invEntry.enabled &&
        isEntrySkippedByCapabilities(delivery, capabilities, transport))

    let status: UnifiedMcpStatus
    if (rowNeedsReconnect) {
      status = "saved_pending_reconnect"
    } else if (invEntry != null && !invEntry.enabled) {
      status = "paused"
    } else if (probeAuthRequired) {
      status = "auth_required"
    } else if (
      sessionEntry?.status === "failed" ||
      failureReason != null ||
      probeFailed
    ) {
      status = "connection_failed"
    } else if (skippedByCaps) {
      status = "skipped_transport"
    } else if (
      sessionEntry?.status === "confirmed" ||
      confirmedTools.length > 0
    ) {
      status = "session_confirmed"
    } else if (probeHealthy) {
      status = "probe_healthy"
    } else {
      status = "configured"
    }

    const toolsCount = probeHealthy
      ? probeResult.tools_count
      : confirmedTools.length > 0
        ? confirmedTools.length
        : null

    const detail =
      failureReason ??
      sessionEntry?.detail ??
      probeResult?.detail ??
      null ??
      (probe?.phase === "error" ? (probe.failure?.detail ?? null) : null)

    const paused = Boolean(invEntry != null && !invEntry.enabled)
    const canPause = Boolean(
      mcpAgentId &&
      inventoryAgent?.writable &&
      inventoryAgent.can_disable &&
      inventoryAgent.config.basis !== null &&
      invEntry &&
      invEntry.enabled &&
      !invEntry.read_only &&
      !invEntry.reserved
    )
    const canProbe = Boolean(
      mcpAgentId &&
      invEntry &&
      invEntry.definition !== null &&
      !invEntry.reserved
    )

    return {
      key,
      transport,
      status,
      origin,
      toolsCount,
      confirmedTools,
      probe,
      detail,
      needsReconnect: rowNeedsReconnect,
      canPause,
      canProbe,
      paused,
      removedPendingReconnect,
      fingerprint,
      definition: invEntry?.definition ?? null,
    }
  })

  const basisDrifted = Boolean(
    hasLiveSession &&
    sessionMcpState?.config_basis &&
    inventoryAgent?.config.basis &&
    sessionMcpState.config_basis !== inventoryAgent.config.basis
  )

  const needsReconnect =
    rows.some((row) => row.needsReconnect) ||
    (Boolean(configStale) && configStaleKind === "mcp_config") ||
    basisDrifted

  let activeCount = 0
  let confirmedCount = 0
  let healthyCount = 0
  let attentionCount = 0
  let pendingReconnectCount = 0
  let pausedCount = 0

  for (const row of rows) {
    if (row.status === "paused") {
      pausedCount += 1
      continue
    }
    if (!row.removedPendingReconnect) {
      activeCount += 1
    }
    switch (row.status) {
      case "session_confirmed":
        confirmedCount += 1
        break
      case "probe_healthy":
        healthyCount += 1
        break
      case "saved_pending_reconnect":
        pendingReconnectCount += 1
        break
      case "connection_failed":
      case "auth_required":
      case "skipped_transport":
        attentionCount += 1
        break
      default:
        break
    }
  }

  return {
    mcpAgentId,
    delivery,
    supportsMcp,
    codegMcpAttached,
    capabilities,
    needsReconnect,
    rows,
    summary: {
      totalCount: rows.length,
      activeCount,
      confirmedCount,
      healthyCount,
      attentionCount,
      pendingReconnectCount,
      pausedCount,
    },
  }
}
