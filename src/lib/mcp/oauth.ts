/**
 * Host-side unified OAuth 2.1 + PKCE authorization & local authenticated MCP
 * proxy bridge client (#1296 Phase 3).
 *
 * Security boundary:
 * - Real OAuth access/refresh tokens stay exclusively inside the host
 *   keychain / 0600 credential store and never cross IPC/HTTP to the frontend.
 * - `mcpOAuthBridgeDefinition` returns the loopback bridge definition (with a
 *   per-route bridge Bearer token) solely to feed into `mcp_apply` when
 *   writing agent configuration files. Callers MUST NOT display, log, or
 *   persist that token in UI state or storage.
 */
import { getTransport, type UnsubscribeFn } from "@/lib/transport"
import { McpClientError } from "./errors"
import type { McpModel } from "./model"
import { normalizeDefinition } from "./normalize"
import { planOf, setOps, type McpPlan } from "./ops"
import { setTargetBlock } from "./targets"
import type { McpAgentId, McpDefinition, McpRemoteDefinition } from "./types"

// ─── Event & wire types ───────────────────────────────────────────────

export const MCP_OAUTH_CHANGED_EVENT = "mcp://oauth-changed"

export type McpOAuthGrantStatus =
  | "authorized"
  | "authorizing"
  | "expired"
  | "revoked"

export interface McpOAuthChanged {
  route_id: string
  upstream_url: string
  status: McpOAuthGrantStatus
}

export interface McpOAuthRouteInfo {
  route_id: string
  upstream_url: string
  transport: "http" | "sse"
  bridge_url: string | null
  status: McpOAuthGrantStatus
  issuer?: string | null
  scopes: string[]
  expires_at?: string | null
  has_refresh_token: boolean
  last_error?: string | null
  updated_at: string
}

export interface McpOAuthBridgeSnapshot {
  bridge_running: boolean
  bridge_base_url: string | null
  routes: McpOAuthRouteInfo[]
}

export interface McpOAuthStartArgs {
  upstream_url: string
  transport?: "http" | "sse"
  resource_metadata_url?: string | null
  client_id?: string | null
  client_secret?: string | null
  scopes?: string[] | null
}

export interface McpOAuthStartResult {
  flow_id: string
  route_id: string
  upstream_url: string
  authorization_url: string
  callback_url: string
  expires_at: string
  registration_mode: "dynamic" | "manual"
}

export interface McpOAuthCompleteCallbackArgs {
  flow_id: string
  callback_url: string
}

export interface McpOAuthCancelResult {
  cancelled: boolean
}

// ─── Normalizers ──────────────────────────────────────────────────────

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

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string")
}

function grantStatus(value: unknown): McpOAuthGrantStatus {
  switch (value) {
    case "authorized":
    case "authorizing":
    case "expired":
    case "revoked":
      return value
    default:
      return "revoked"
  }
}

function remoteTransport(value: unknown): "http" | "sse" {
  return value === "sse" ? "sse" : "http"
}

export function normalizeOAuthRouteInfo(value: unknown): McpOAuthRouteInfo {
  if (
    !isRaw(value) ||
    typeof value.route_id !== "string" ||
    !value.route_id ||
    typeof value.upstream_url !== "string" ||
    !value.upstream_url
  ) {
    throw new McpClientError(
      "invalidResponse",
      "OAuth route info answered with an invalid shape"
    )
  }
  return {
    route_id: value.route_id,
    upstream_url: value.upstream_url,
    transport: remoteTransport(value.transport),
    bridge_url: strOrNull(value.bridge_url),
    status: grantStatus(value.status),
    issuer: strOrNull(value.issuer),
    scopes: strings(value.scopes),
    expires_at: strOrNull(value.expires_at),
    has_refresh_token: bool(value.has_refresh_token),
    last_error: strOrNull(value.last_error),
    updated_at: str(value.updated_at),
  }
}

export function normalizeOAuthBridgeSnapshot(
  value: unknown
): McpOAuthBridgeSnapshot {
  if (!isRaw(value) || !Array.isArray(value.routes)) {
    throw new McpClientError(
      "invalidResponse",
      "mcp_oauth_list answered with something that is not a bridge snapshot"
    )
  }
  const routes: McpOAuthRouteInfo[] = []
  for (const item of value.routes) {
    try {
      routes.push(normalizeOAuthRouteInfo(item))
    } catch {
      // Ignore individual malformed route entries from newer/older servers.
    }
  }
  return {
    bridge_running: bool(value.bridge_running),
    bridge_base_url: strOrNull(value.bridge_base_url),
    routes,
  }
}

export function normalizeOAuthStartResult(value: unknown): McpOAuthStartResult {
  if (
    !isRaw(value) ||
    typeof value.flow_id !== "string" ||
    !value.flow_id ||
    typeof value.route_id !== "string" ||
    !value.route_id ||
    typeof value.authorization_url !== "string" ||
    !value.authorization_url
  ) {
    throw new McpClientError(
      "invalidResponse",
      "mcp_oauth_start answered with an invalid shape"
    )
  }
  return {
    flow_id: value.flow_id,
    route_id: value.route_id,
    upstream_url: str(value.upstream_url),
    authorization_url: value.authorization_url,
    callback_url: str(value.callback_url),
    expires_at: str(value.expires_at),
    registration_mode:
      value.registration_mode === "manual" ? "manual" : "dynamic",
  }
}

export function normalizeOAuthChanged(value: unknown): McpOAuthChanged {
  if (!isRaw(value)) {
    return { route_id: "", upstream_url: "", status: "revoked" }
  }
  return {
    route_id: str(value.route_id),
    upstream_url: str(value.upstream_url),
    status: grantStatus(value.status),
  }
}

function normalizeBridgeDefinition(value: unknown): McpRemoteDefinition {
  const direct = normalizeDefinition(value)
  if (direct && (direct.type === "http" || direct.type === "sse")) {
    return direct
  }
  // Also accept `{ transport: "http" | "sse", url, headers }` on the wire
  // and map it into the tagged `McpDefinition` shape consumed by `mcp_apply`.
  if (
    isRaw(value) &&
    (value.transport === "http" || value.transport === "sse") &&
    typeof value.url === "string" &&
    value.url.length > 0
  ) {
    const mapped = normalizeDefinition({
      type: value.transport,
      url: value.url,
      headers: value.headers,
    })
    if (mapped && (mapped.type === "http" || mapped.type === "sse")) {
      return mapped
    }
  }
  throw new McpClientError(
    "invalidResponse",
    "mcp_oauth_bridge_definition answered with an invalid definition"
  )
}

// ─── Wire commands & event subscription ───────────────────────────────

export async function mcpOAuthList(): Promise<McpOAuthBridgeSnapshot> {
  return normalizeOAuthBridgeSnapshot(
    await getTransport().call("mcp_oauth_list")
  )
}

export async function mcpOAuthStart(
  args: McpOAuthStartArgs
): Promise<McpOAuthStartResult> {
  const payload: Record<string, unknown> = {
    upstream_url: args.upstream_url.trim(),
  }
  if (args.transport !== undefined) {
    payload.transport = args.transport
  }
  if (
    typeof args.resource_metadata_url === "string" &&
    args.resource_metadata_url.trim() !== ""
  ) {
    payload.resource_metadata_url = args.resource_metadata_url.trim()
  }
  if (typeof args.client_id === "string" && args.client_id.trim() !== "") {
    payload.client_id = args.client_id.trim()
  }
  if (
    typeof args.client_secret === "string" &&
    args.client_secret.trim() !== ""
  ) {
    payload.client_secret = args.client_secret.trim()
  }
  if (Array.isArray(args.scopes)) {
    const cleaned = args.scopes
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
    if (cleaned.length > 0) {
      payload.scopes = cleaned
    }
  }
  return normalizeOAuthStartResult(
    await getTransport().call("mcp_oauth_start", payload)
  )
}

export async function mcpOAuthCompleteCallback(
  args: McpOAuthCompleteCallbackArgs
): Promise<McpOAuthRouteInfo> {
  return normalizeOAuthRouteInfo(
    await getTransport().call("mcp_oauth_complete_callback", {
      flow_id: args.flow_id,
      callback_url: args.callback_url,
    })
  )
}

export async function mcpOAuthCancel(
  flow_id: string
): Promise<McpOAuthCancelResult> {
  const raw = await getTransport().call("mcp_oauth_cancel", { flow_id })
  return {
    cancelled: isRaw(raw) ? bool(raw.cancelled) : false,
  }
}

export async function mcpOAuthRevoke(
  route_id: string
): Promise<McpOAuthBridgeSnapshot> {
  return normalizeOAuthBridgeSnapshot(
    await getTransport().call("mcp_oauth_revoke", { route_id })
  )
}

/**
 * Retrieve the local authenticated proxy bridge definition for `route_id`.
 *
 * SECURITY: The returned `headers.Authorization` contains the route's local
 * bridge bearer token. Pass it directly to `mcpApply` and NEVER render, log,
 * or persist it in UI state.
 */
export async function mcpOAuthBridgeDefinition(
  route_id: string
): Promise<McpDefinition> {
  return normalizeBridgeDefinition(
    await getTransport().call("mcp_oauth_bridge_definition", { route_id })
  )
}

export function onMcpOAuthChanged(
  handler: (payload: McpOAuthChanged) => void
): Promise<UnsubscribeFn> {
  return getTransport().subscribe<unknown>(MCP_OAUTH_CHANGED_EVENT, (payload) =>
    handler(normalizeOAuthChanged(payload))
  )
}

// ─── Pure helpers ─────────────────────────────────────────────────────

/**
 * Canonicalize a remote MCP URL for deterministic route matching:
 * - lowercases scheme & host
 * - strips hash fragment
 * - removes default ports (`80` for http, `443` for https)
 * - strips trailing slashes on non-root paths
 */
export function canonicalizeRemoteMcpUrl(url: string): string {
  const trimmed = url.trim()
  if (!trimmed) return ""
  try {
    const parsed = new URL(trimmed)
    parsed.hash = ""
    if (
      (parsed.protocol === "http:" && parsed.port === "80") ||
      (parsed.protocol === "https:" && parsed.port === "443")
    ) {
      parsed.port = ""
    }
    if (parsed.pathname.length > 1) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/"
    }
    return parsed.toString()
  } catch {
    return trimmed
  }
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"])

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase())
}

/**
 * If `url` points to Codeg's local loopback proxy bridge
 * (`http://127.0.0.1:<port>/mcp/<route_id>` or `localhost` / `[::1]`),
 * extract `<route_id>`. Otherwise returns `null`.
 */
export function extractBridgeRouteIdFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url.trim())
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null
    }
    if (!isLoopbackHost(parsed.hostname)) return null
    const match = /^\/mcp\/([^/?#]+)\/?$/.exec(parsed.pathname)
    if (!match) return null
    return decodeURIComponent(match[1])
  } catch {
    return null
  }
}

/**
 * Whether `def` is a remote definition targeting Codeg's local MCP OAuth proxy
 * bridge. Used to enforce strict non-revealable masking on bridge auth headers.
 */
export function isCodegBridgeDefinition(
  def: McpDefinition | null | undefined
): boolean {
  if (!def || (def.type !== "http" && def.type !== "sse")) return false
  return extractBridgeRouteIdFromUrl(def.url) !== null
}

export type McpOAuthRouteMatch =
  | {
      kind: "bridged"
      route: McpOAuthRouteInfo
      portDrifted: boolean
    }
  | {
      kind: "direct"
      route: McpOAuthRouteInfo
    }

/**
 * Match a server definition against the host's OAuth bridge snapshot.
 *
 * Precedence:
 * 1. Bridged match: exact `route.bridge_url` match, or loopback `/mcp/<route_id>`
 *    path match (setting `portDrifted: true` when the active bridge port/origin
 *    differs from the definition's URL).
 * 2. Direct match: canonical `def.url` equals canonical `route.upstream_url`.
 */
export function matchOAuthRouteForDefinition(
  def: McpDefinition | null,
  snapshot: McpOAuthBridgeSnapshot | null
): McpOAuthRouteMatch | null {
  if (
    !def ||
    (def.type !== "http" && def.type !== "sse") ||
    !snapshot ||
    snapshot.routes.length === 0
  ) {
    return null
  }

  const defCanonical = canonicalizeRemoteMcpUrl(def.url)

  // 1a. Exact bridge_url match
  for (const route of snapshot.routes) {
    if (
      route.bridge_url &&
      canonicalizeRemoteMcpUrl(route.bridge_url) === defCanonical
    ) {
      return { kind: "bridged", route, portDrifted: false }
    }
  }

  // 1b. Loopback /mcp/<route_id> match (handles port changes across restarts)
  const routeIdFromUrl = extractBridgeRouteIdFromUrl(def.url)
  if (routeIdFromUrl) {
    const matched = snapshot.routes.find(
      (route) => route.route_id === routeIdFromUrl
    )
    if (matched) {
      let portDrifted = false
      if (matched.bridge_url) {
        portDrifted =
          canonicalizeRemoteMcpUrl(matched.bridge_url) !== defCanonical
      } else if (snapshot.bridge_base_url) {
        try {
          const defOrigin = new URL(def.url.trim()).origin
          const baseOrigin = new URL(snapshot.bridge_base_url.trim()).origin
          portDrifted = defOrigin !== baseOrigin
        } catch {
          portDrifted = false
        }
      }
      return { kind: "bridged", route: matched, portDrifted }
    }
  }

  // 2. Direct upstream URL match
  for (const route of snapshot.routes) {
    if (canonicalizeRemoteMcpUrl(route.upstream_url) === defCanonical) {
      return { kind: "direct", route }
    }
  }

  return null
}

/**
 * Parse space- or comma-separated scope strings from an advanced form field.
 */
export function parseOAuthScopesInput(raw: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const token of raw.split(/[\s,]+/)) {
    const trimmed = token.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

function eligibleAgentsForRemoteWrite(
  model: McpModel,
  serverKey: string,
  targetAgents: readonly McpAgentId[],
  transport: "http" | "sse"
): McpAgentId[] {
  const seen = new Set<McpAgentId>()
  const valid: McpAgentId[] = []
  for (const agentId of targetAgents) {
    if (seen.has(agentId)) continue
    seen.add(agentId)
    const info = model.agent(agentId)
    if (!info || !info.agent) continue
    const block = setTargetBlock(info, transport, serverKey, model.rules, {
      newKey: true,
    })
    if (block === null) {
      valid.push(info.agent)
    }
  }
  return valid
}

/**
 * Build a standard `McpPlan` (for `mcp_apply` preflight & commit) that writes
 * `bridgeDef` to all compatible writable agents in `targetAgents` (including
 * custom ACP agents).
 */
export function planBridgeRouteApply(
  model: McpModel,
  serverKey: string,
  targetAgents: readonly McpAgentId[],
  bridgeDef: McpDefinition
): McpPlan | null {
  if (bridgeDef.type !== "http" && bridgeDef.type !== "sse") return null
  const agents = eligibleAgentsForRemoteWrite(
    model,
    serverKey,
    targetAgents,
    bridgeDef.type
  )
  if (agents.length === 0) return null
  return planOf(setOps(serverKey, bridgeDef, agents), model.inventory)
}

/**
 * Build a standard `McpPlan` (for `mcp_apply` preflight & commit) that restores
 * `serverKey` on `targetAgents` back to its direct `upstreamUrl` definition
 * (removing the local bridge URL and bridge bearer header).
 */
export function planRestoreDirectUrl(
  model: McpModel,
  serverKey: string,
  targetAgents: readonly McpAgentId[],
  upstreamUrl: string,
  transport: "http" | "sse"
): McpPlan | null {
  const trimmedUrl = upstreamUrl.trim()
  if (!trimmedUrl) return null
  const agents = eligibleAgentsForRemoteWrite(
    model,
    serverKey,
    targetAgents,
    transport
  )
  if (agents.length === 0) return null
  const directDef: McpRemoteDefinition = {
    type: transport,
    url: trimmedUrl,
  }
  return planOf(setOps(serverKey, directDef, agents), model.inventory)
}
