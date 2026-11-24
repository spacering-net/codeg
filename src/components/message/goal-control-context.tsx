"use client"

import { createContext, useContext } from "react"

export type GoalControlAction = "pause" | "clear"

/** The legacy codex goal-control vocabulary — what a snapshot with no
 *  `goal_actions` field AT ALL (a server too old to carry it) maps to,
 *  mirroring what the backend resolves a non-advertising adapter to at
 *  initialize, so an older codex keeps today's Pause/Clear affordances. An
 *  explicitly `null` field is NOT this case: it means the handshake hasn't
 *  answered yet (see `useAdvertisedGoalActions`). */
export const LEGACY_GOAL_ACTIONS: readonly string[] = ["pause", "clear"]

/** No controls: the vocabulary before a connection's advertisement is KNOWN
 *  (snapshot not yet fetched / still initializing / fetch failed / connection
 *  switched). Offering a wrong affordance (claude has no "pause") is worse than
 *  briefly offering none, so unknown always renders as none. Stable
 *  reference. */
export const NO_GOAL_ACTIONS: readonly string[] = []

export interface GoalControlValue {
  /**
   * Fire a pause/clear on the session's currently active goal, or `null`
   * when goal control isn't available for this surface — a history reload with
   * no live connection, a read-only viewer, or the read-only sub-agent dialog
   * (which renders its own `MessageListView` with no provider). The goal card
   * hides its control buttons whenever this is `null`, so liveness/ownership are
   * decided once at the panel where the connection is owned, not in the card.
   */
  onGoalControl: ((action: GoalControlAction) => void) | null
  /**
   * The action vocabulary this connection's adapter actually offers — the
   * advertised `_meta.goal.actions` for neutral-goal adapters (claude 0.66+
   * offers ["set","clear"], NO pause; codex 1.2+ all four), else the legacy
   * default (snapshot `goal_actions`). The card additionally gates each
   * button on membership here, so a claude session never offers a pause the
   * adapter would reject.
   */
  actions: readonly string[]
}

const GoalControlContext = createContext<GoalControlValue>({
  onGoalControl: null,
  actions: LEGACY_GOAL_ACTIONS,
})

export const GoalControlProvider = GoalControlContext.Provider

export function useGoalControl(): GoalControlValue {
  return useContext(GoalControlContext)
}
