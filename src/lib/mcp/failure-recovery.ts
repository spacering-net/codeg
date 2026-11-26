/**
 * Session MCP initialization failure detection and agent mapping (#1295).
 *
 * Parses both raw agent error lines (`MCP load failed for <name>: <reason>`)
 * and formatted messages (`The MCP server '<name>' failed to initialize...`),
 * ignoring Codeg's built-in `chrome_devtools` server so only user-configured
 * MCP servers trigger the chat one-click pause & reconnect recovery strip.
 */
import { isCustomAgentType, type AgentType } from "@/lib/types"
import { isMcpAppType, type McpAppType } from "./types"

export interface McpInitFailure {
  serverName: string
  reason: string
}

const BUILTIN_IGNORED_SERVERS = new Set(["chrome_devtools"])

const RAW_MCP_LOAD_FAILED_RE =
  /MCP load failed for\s+(?:['"]([^'"]+)['"]|([^\s:]+))\s*:\s*([^\r\n]+)/i

const FORMATTED_MCP_INIT_FAILED_RE =
  /The MCP server\s+['"]([^'"]+)['"]\s+failed to initialize(?:\s*(?:[:—-]\s*|\(([^)]+)\)|\.\s+)(.*))?/i

function isIgnoredServer(name: string): boolean {
  return BUILTIN_IGNORED_SERVERS.has(name.trim().toLowerCase())
}

function cleanReason(raw: string | undefined, fallback: string): string {
  const trimmed = (raw ?? "").trim().replace(/\s+/g, " ")
  return trimmed.length > 0 ? trimmed : fallback.trim()
}

/**
 * Extract the first actionable MCP server initialization failure from `text`,
 * or `null` when none is present (or only the built-in `chrome_devtools`
 * server failed).
 */
export function extractMcpInitFailure(text: string): McpInitFailure | null {
  if (!text || text.trim().length === 0) return null

  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const rawMatch = RAW_MCP_LOAD_FAILED_RE.exec(trimmed)
    if (rawMatch) {
      const serverName = (rawMatch[1] ?? rawMatch[2] ?? "").trim()
      if (serverName && !isIgnoredServer(serverName)) {
        return {
          serverName,
          reason: cleanReason(rawMatch[3], trimmed),
        }
      }
      continue
    }

    const formattedMatch = FORMATTED_MCP_INIT_FAILED_RE.exec(trimmed)
    if (formattedMatch) {
      const serverName = (formattedMatch[1] ?? "").trim()
      if (serverName && !isIgnoredServer(serverName)) {
        const parenReason = formattedMatch[2]?.trim()
        const tailReason = formattedMatch[3]?.trim()
        const combined =
          parenReason && tailReason
            ? `${parenReason} ${tailReason}`
            : (parenReason ?? tailReason)
        return {
          serverName,
          reason: cleanReason(combined, trimmed),
        }
      }
    }
  }

  return null
}

/**
 * Map a conversation's {@link AgentType} to the corresponding MCP inventory
 * app id, or `null` for custom (`custom:*`) or unknown agents.
 */
export function agentTypeToMcpApp(
  agentType: AgentType | null | undefined
): McpAppType | null {
  if (!agentType || isCustomAgentType(agentType)) return null
  return isMcpAppType(agentType) ? agentType : null
}
