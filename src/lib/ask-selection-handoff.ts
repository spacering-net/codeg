import type { AgentType } from "@/lib/types"

/**
 * "Ask about this selection" hand-off: the selection bubble composes a prompt
 * (quoted selection + the user's question), opens a fresh conversation draft
 * tab, and parks the prompt here for THAT tab's panel to pick up and send.
 *
 * A module-level buffer rather than a bare CustomEvent, and keyed by tab id
 * rather than broadcast, for two reasons:
 *  - the target draft tab may still be mounting (a brand-new tab), so an event
 *    alone would fire before anyone is listening — the panel drains on mount;
 *  - each split group reuses ONE draft tab, so the target may equally be mounted
 *    already (inactive tabs stay mounted, hidden) — hence the event as the
 *    already-mounted fast path.
 * Keying by tab id is what keeps a second group's draft panel from swallowing a
 * prompt meant for the first.
 */

export const ASK_SELECTION_PARKED_EVENT = "codeg:ask-selection-parked"

export interface AskSelectionParkedDetail {
  /** Draft tab the prompt was parked for. */
  tabId: string
}

export interface ParkedAskPrompt {
  /** The composed prompt: quoted selection, blank line, the user's question. */
  prompt: string
  /**
   * The state the target tab must be in before this prompt may be taken —
   * exactly what `openNewConversationTab` reported it would end up as.
   *
   * This is a GUARD, not decoration. Reusing a draft that belongs to another
   * folder or agent retargets it ASYNCHRONOUSLY (the store queues a request, and
   * the tab is only patched after its stale ACP session has been torn down). In
   * that window the tab still looks — and, if it was already connected, still
   * behaves — like the old folder/agent: self-consistently ready, so neither the
   * queue's flush gate nor `handleSend`'s own readiness check would stop it.
   * Draining then would deliver the question to the WRONG agent, in the wrong
   * workspace. Matching on the promised identity holds the prompt until the
   * retarget has actually landed.
   */
  agentType: AgentType
  folderId: number
}

/** The state a draining panel reports about its own tab. */
export interface AskSelectionDrainState {
  agentType: AgentType
  folderId: number
}

/** Parked prompts per target tab. A list, not a single slot: two asks aimed at
 *  the same draft tab before it drains must both survive. */
const parked = new Map<string, ParkedAskPrompt[]>()

/** Park a composed prompt for `tabId` and nudge its panel if already mounted. */
export function parkAskSelectionPrompt(
  tabId: string,
  entry: ParkedAskPrompt
): void {
  const queued = parked.get(tabId)
  if (queued) {
    queued.push(entry)
  } else {
    parked.set(tabId, [entry])
  }
  if (typeof window === "undefined") return
  window.dispatchEvent(
    new CustomEvent<AskSelectionParkedDetail>(ASK_SELECTION_PARKED_EVENT, {
      detail: { tabId },
    })
  )
}

/**
 * Take the prompts parked for `tabId` that match the tab's CURRENT state, in
 * order. Anything that doesn't match stays parked for a later drain — the
 * caller re-runs this when its agent or folder changes, which is precisely when
 * a pending retarget lands.
 *
 * Returns [] when nothing was parked, or nothing parked matches yet.
 */
export function consumeAskSelectionPrompts(
  tabId: string,
  state: AskSelectionDrainState
): string[] {
  const queued = parked.get(tabId)
  if (!queued) return []

  const taken: string[] = []
  const held: ParkedAskPrompt[] = []
  for (const entry of queued) {
    if (
      entry.agentType === state.agentType &&
      entry.folderId === state.folderId
    ) {
      taken.push(entry.prompt)
    } else {
      held.push(entry)
    }
  }
  if (held.length === 0) {
    parked.delete(tabId)
  } else {
    parked.set(tabId, held)
  }
  return taken
}

/** Drop everything parked for a tab — its panel is going away for good, so
 *  nothing will ever drain it. Called on tab close so a prompt held back by the
 *  match guard can't outlive its target. */
export function discardAskSelectionPrompts(tabId: string): void {
  parked.delete(tabId)
}

/** Test seam: drop everything still parked. */
export function resetAskSelectionPromptsForTests(): void {
  parked.clear()
}
