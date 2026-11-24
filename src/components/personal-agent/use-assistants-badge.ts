"use client"

import { useRoster } from "@/stores/personal-agent-roster-store"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

/**
 * The assistants' badge on the sidebar (1.13): how many assistants have
 * something the owner has not seen — not the hidden or muted ones, nor the
 * one the page is showing them right now — and whether any (not hidden)
 * waits on them. Until the roster is read, the primary's own. The web's
 * page title counts them too (10.10).
 */
export function useAssistantsBadge(
  primaryId: number | null,
  primaryUnseen: number,
  primaryNeeds: boolean
): { unreadBots: number; needsOwner: boolean } {
  const roster = useRoster()
  const watching = usePersonalAgentUi((s) => s.watching)
  const viewBot = usePersonalAgentUi((s) => s.viewBot)
  const watched = watching ? (viewBot ?? primaryId) : null
  if (!roster) {
    const seen = watching && viewBot == null
    return {
      unreadBots: primaryUnseen > 0 && !seen ? 1 : 0,
      needsOwner: primaryNeeds,
    }
  }
  let unreadBots = 0
  let needsOwner = false
  for (const e of roster) {
    if (e.roster.hidden) continue
    if (e.live.attention === "needs_you") needsOwner = true
    if (e.roster.muted || e.id === watched) continue
    if (
      e.live.unread > 0 ||
      e.roster.unread_mark ||
      e.live.attention === "unread"
    ) {
      unreadBots += 1
    }
  }
  return { unreadBots, needsOwner }
}
