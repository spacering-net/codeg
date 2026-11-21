/** Kimi 2.5.3 drops custom OAuth events at its ACP boundary, but forwards
 * this exact status template as a title-only tool_call_update. Never scan
 * tool inputs, results, assistant prose or pages for an authorization URL. */
export const KIMI_MCP_OAUTH_META = "codeg.kimiMcpOAuth"

type Meta = Record<string, unknown> | null

// Kimi's tool-naming.ts; status text uses the original server label.
function qualifiedAuthTool(server: string): string {
  const name = server.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_")
  return `mcp__${name}__authenticate`
}

export interface KimiMcpOAuth {
  toolName: string
  server: string
  phase: "pending" | "waiting" | "reconnecting"
  url: string | null
}

/** This binding is derived locally, never accepted from agent metadata. */
export function stripKimiMcpOAuth(meta: Meta): Meta {
  return meta && KIMI_MCP_OAUTH_META in meta
    ? { ...meta, [KIMI_MCP_OAUTH_META]: null }
    : meta
}

export function isOAuthHttpsUrl(value: string): boolean {
  if (!value.startsWith("https://") || /[\s\u0000-\u001f\u007f]/.test(value)) {
    return false
  }
  try {
    const url = new URL(value)
    return !!url.hostname && !url.username && !url.password
  } catch {
    return false
  }
}

export function readKimiMcpOAuth(meta: Meta | undefined): KimiMcpOAuth | null {
  const value = meta?.[KIMI_MCP_OAUTH_META]
  if (!value || typeof value !== "object") return null
  const p = value as KimiMcpOAuth
  if (
    typeof p.server !== "string" ||
    !p.server ||
    /["\r\n]/.test(p.server) ||
    p.toolName !== qualifiedAuthTool(p.server) ||
    !["pending", "waiting", "reconnecting"].includes(p.phase) ||
    (p.phase === "waiting"
      ? typeof p.url !== "string" || !isOAuthHttpsUrl(p.url)
      : p.url !== null)
  ) {
    return null
  }
  return p
}

/** Only the opening call can establish provenance. Snapshots/late updates
 * that missed that identity fail closed until a new authenticate call. */
export function startKimiMcpOAuth(
  agentType: string,
  title: string,
  meta: Meta
): Meta {
  const server =
    agentType === "kimi_code"
      ? /^mcp__([\w-]+)__authenticate$/.exec(title)?.[1]
      : null
  if (!server) return stripKimiMcpOAuth(meta)
  return {
    ...meta,
    [KIMI_MCP_OAUTH_META]: server
      ? { toolName: title, server, phase: "pending", url: null }
      : null,
  }
}

/** A newer snapshot replaces a live call whose opening this client saw. The
 * snapshot keeps Kimi's latest status as the call's title (the backend's
 * `KimiToolTitles`) but cannot carry the binding, so keep the identity bound
 * locally and re-derive phase and URL from the snapshot's title and status,
 * never from a URL held before. Returns null when `previous` was unbound. */
export function rebindKimiMcpOAuth(
  previous: Meta,
  snapshot: { title: string; status: string; meta: Meta }
): Meta | null {
  const bound = readKimiMcpOAuth(previous)
  if (!bound) return null
  return updateKimiMcpOAuth(
    {
      ...snapshot.meta,
      [KIMI_MCP_OAUTH_META]: { ...bound, phase: "pending", url: null },
    },
    {
      title: snapshot.title,
      status: null,
      content: null,
      raw_input: null,
      raw_output: null,
      meta: null,
    },
    snapshot.status
  )
}

const WAIT_SUFFIX =
  "\n\nWaiting for the OAuth callback (timeout 15 min). If you cancel, call this tool again to restart the flow."

export function updateKimiMcpOAuth(
  previous: Meta,
  update: {
    title: string | null
    status: string | null
    content: string | null
    raw_input: string | null
    raw_output: string | null
    meta: Meta
  },
  currentStatus: string
): Meta {
  const next = update.meta ?? previous
  const progress = readKimiMcpOAuth(previous)
  if (!progress && !next?.[KIMI_MCP_OAUTH_META]) return next
  const status = (update.status ?? currentStatus)
    .toLowerCase()
    .replace(/_/g, "")
  if (!progress || !["pending", "inprogress"].includes(status)) {
    return { ...next, [KIMI_MCP_OAUTH_META]: null }
  }
  let value = progress
  if (
    update.title !== null &&
    update.status === null &&
    update.content === null &&
    update.raw_input === null &&
    update.raw_output === null
  ) {
    // A new status retires the old URL, including reconnect and retry.
    value = { ...progress, phase: "pending", url: null }
    const prefix =
      /^Open this URL in your browser to authorize "([^"\r\n]+)":\n\n/.exec(
        update.title
      )
    const server = prefix?.[1]
    if (
      prefix &&
      server &&
      qualifiedAuthTool(server) === progress.toolName &&
      update.title.endsWith(WAIT_SUFFIX)
    ) {
      const url = update.title.slice(prefix[0].length, -WAIT_SUFFIX.length)
      if (isOAuthHttpsUrl(url))
        value = { ...value, server, phase: "waiting", url }
    } else {
      const reconnect =
        /^(?:Authorized — reconnecting |Already authorized; reconnecting )([^"\r\n]+)…$/.exec(
          update.title
        )?.[1]
      if (reconnect && qualifiedAuthTool(reconnect) === progress.toolName) {
        value = { ...value, server: reconnect, phase: "reconnecting" }
      }
    }
  }
  return { ...next, [KIMI_MCP_OAUTH_META]: value }
}
