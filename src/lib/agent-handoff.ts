/**
 * Mid-conversation agent handoff: the frontend half of `acp::handoff`.
 *
 * When a conversation is handed to another agent, the backend splices the
 * earlier segment in front of the new session and marks the seam with a tool
 * call tagged `_meta["codeg.handoff"]` (same shape as the context-compaction
 * divider). Recognition is by `_meta` key, never by agent or tool name, so the
 * card renders for history reads and live snapshots alike.
 *
 * Kept dependency-free, like `context-compaction.ts`, so the grouping pass in
 * the adapter and the card can share it without an import cycle.
 */

export const HANDOFF_META_KEY = "codeg.handoff"

/**
 * First line of the prompt that seeds a summary handoff. The backend folds
 * that turn into the divider on every detail read; this marker lets the live
 * path (a snapshot or `user_message` echo captured before the refetch) skip
 * the same bubble instead of flashing a screen of briefing as a user message.
 */
export const HANDOFF_BRIEFING_MARKER = "<!-- codeg:handoff-briefing -->"

export type AgentHandoffPath = "native" | "context" | "summary"

export interface AgentHandoffPayload {
  version: number
  from: string
  to: string
  path: AgentHandoffPath
  carried: boolean
  truncated: boolean
  at: string | null
  note: string | null
  briefing: string | null
}

export function isAgentHandoffMeta(meta: unknown): boolean {
  if (!meta || typeof meta !== "object") return false
  const marker = (meta as Record<string, unknown>)[HANDOFF_META_KEY]
  if (!marker || typeof marker !== "object") return false
  const version = (marker as Record<string, unknown>).version
  return (
    typeof version === "number" && Number.isInteger(version) && version >= 1
  )
}

function readString(
  source: Record<string, unknown>,
  key: string
): string | null {
  const value = source[key]
  return typeof value === "string" && value.length > 0 ? value : null
}

/**
 * The typed payload, or `null` for anything that is not a handoff marker.
 * Fields are read leniently: an older row may lack `note`/`briefing`, and an
 * unknown `path` value degrades to `summary` (the honest default: nothing was
 * carried natively unless the backend said so).
 */
export function agentHandoffPayload(meta: unknown): AgentHandoffPayload | null {
  if (!isAgentHandoffMeta(meta)) return null
  const marker = (meta as Record<string, unknown>)[HANDOFF_META_KEY] as Record<
    string,
    unknown
  >
  return {
    version: marker.version as number,
    from: readString(marker, "from") ?? "",
    to: readString(marker, "to") ?? "",
    path:
      marker.path === "native"
        ? "native"
        : marker.path === "context"
          ? "context"
          : "summary",
    carried: marker.carried === true,
    truncated: marker.truncated === true,
    at: readString(marker, "at"),
    note: readString(marker, "note"),
    briefing: readString(marker, "briefing"),
  }
}

/** True for text the backend seeded as a handoff briefing. */
export function isHandoffBriefingText(text: string): boolean {
  return text.trimStart().startsWith(HANDOFF_BRIEFING_MARKER)
}
