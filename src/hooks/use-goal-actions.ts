"use client"

/**
 * The goal-control action vocabulary a connection's adapter ADVERTISED,
 * recovered from the session snapshot (`goal_actions` — launch-latched, same
 * snapshot-read pattern as the steering availability in
 * `use-session-feedback`).
 *
 * Fail-closed contract: until the snapshot for EXACTLY this `connectionId`
 * reports a KNOWN vocabulary, the hook returns `NO_GOAL_ACTIONS` — the goal card
 * then offers no Pause/Clear at all. Offering a wrong affordance is worse than
 * briefly offering none: claude's advertised vocabulary has no "pause", so a
 * legacy-default window would let the user fire a request the adapter rejects.
 * Keying the loaded value by connection id also guarantees a reconnect/re-spawn
 * (new id, possibly a different binary) never inherits the previous process's
 * vocabulary.
 *
 * The snapshot answers in three ways, and the middle one is the whole reason
 * this hook takes `connStatus`:
 *   * a list — known, latch it and stop reading;
 *   * `null` — the connection hasn't finished `initialize`, so NOTHING is known
 *     yet. `spawn_agent` returns (and the frontend learns the connection id)
 *     with the handshake still in flight, so the first read of a brand-new
 *     conversation routinely lands here. Latching anything now is how a claude
 *     card ended up with a Pause its adapter answers `Invalid params: goal
 *     action must be "set" or "clear"`;
 *   * ABSENT (`undefined`) — a server too old to carry the field, mapped to the
 *     legacy `["pause","clear"]` for backward compatibility.
 *
 * Anything short of a known vocabulary is retried, because a single miss must
 * not cost the card its buttons for the connection's whole life. Two triggers:
 * the `connStatus` transition (the handshake's own signal) and a bounded
 * backoff (for the mount that finds the connection already settled — a fetch
 * that simply failed then has no status change coming).
 */

import { useEffect, useRef, useState } from "react"

import { acpGetSessionSnapshot } from "@/lib/api"
import {
  LEGACY_GOAL_ACTIONS,
  NO_GOAL_ACTIONS,
} from "@/components/message/goal-control-context"
import type { ConnectionStatus } from "@/lib/types"

/** Timer-driven retries per connection, before giving up and leaving the card
 *  without controls. Small on purpose: the vocabulary is decided in one
 *  round-trip at launch, so needing more than a few reads means something other
 *  than a transient miss. */
const MAX_RETRIES = 4
/** First backoff step; doubles per attempt (0.4s, 0.8s, 1.6s, 3.2s). */
const RETRY_BASE_MS = 400

export function useAdvertisedGoalActions(
  connectionId: string | null,
  connStatus?: ConnectionStatus | null
): readonly string[] {
  const [loaded, setLoaded] = useState<{
    id: string
    actions: readonly string[]
  } | null>(null)
  // Retry budget, scoped to one connection id so a reconnect starts fresh.
  const retriesRef = useRef<{ id: string; spent: number }>({ id: "", spent: 0 })
  const [retryTick, setRetryTick] = useState(0)

  useEffect(() => {
    if (!connectionId) return
    // The vocabulary is fixed for a connection's lifetime, so one known answer
    // ends the reads. Without this the effect would re-fetch on every
    // connected↔prompting flip, i.e. on every turn.
    if (loaded?.id === connectionId) return
    if (retriesRef.current.id !== connectionId) {
      retriesRef.current = { id: connectionId, spent: 0 }
    }
    let stale = false
    let timer: ReturnType<typeof setTimeout> | undefined
    // Nothing was learned. Come back on our own — the connection may already be
    // settled, in which case no status change will ever nudge this effect.
    const readAgainLater = () => {
      const budget = retriesRef.current
      if (stale || budget.id !== connectionId || budget.spent >= MAX_RETRIES) {
        return
      }
      const delay = RETRY_BASE_MS * 2 ** budget.spent
      budget.spent += 1
      timer = setTimeout(() => {
        if (!stale) setRetryTick((t) => t + 1)
      }, delay)
    }
    acpGetSessionSnapshot(connectionId)
      .then((snap) => {
        if (stale) return
        // A nullish snapshot means NOTHING was learned (connection already
        // gone, or a transport hiccup) and an explicit `null` field means the
        // handshake hasn't answered yet. Only an EXISTING snapshot missing the
        // field entirely maps to the legacy vocabulary.
        if (!snap || snap.goal_actions === null) {
          readAgainLater()
          return
        }
        setLoaded({
          id: connectionId,
          actions: snap.goal_actions ?? LEGACY_GOAL_ACTIONS,
        })
      })
      .catch(() => {
        // Unknown vocabulary stays unknown — the card keeps rendering no
        // controls rather than guessing — but a transient failure gets another
        // read rather than costing this connection its buttons for good.
        if (!stale) readAgainLater()
      })
    return () => {
      stale = true
      if (timer) clearTimeout(timer)
    }
  }, [connectionId, connStatus, loaded, retryTick])

  return loaded && loaded.id === connectionId ? loaded.actions : NO_GOAL_ACTIONS
}
