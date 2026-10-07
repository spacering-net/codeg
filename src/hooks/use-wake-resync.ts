"use client"

import { useEffect, useRef } from "react"
import { onTransportReconnect } from "@/lib/platform"

/**
 * One resync per window. A wake shows the page again and, once the dead
 * socket is replaced, reconnects the transport within seconds; either alone
 * is reason enough to resync, so the pair collapses into one refetch.
 *
 * The window opens when a refetch LANDS, not when it is issued. One that
 * failed (the page shown while the Wi-Fi was still coming back) must not
 * swallow the reconnect that follows it, and one still in flight may be stuck
 * on that same dead link, so a trigger meanwhile issues a fresh one (the
 * store keeps only the newest response).
 */
const RESYNC_DEBOUNCE_MS = 2_000

/**
 * A page shown again counts as a wake only after being hidden this long.
 * Switching tabs or windows loses nothing (the socket stays up), and every
 * resync is a full transcript refetch that the status bar reports while it
 * runs; the sleep this trigger is for hides the page far longer.
 */
const RESYNC_MIN_HIDDEN_MS = 30_000

/**
 * How long a trigger that landed mid-stream stays owed (see the guards
 * below). Comfortably longer than a re-attach round trip, which is what
 * settles a status that went stale while the socket was down; a turn still
 * streaming past this is being delivered live.
 */
const RESYNC_HOLD_MS = 10_000

/**
 * Quiet period after a stream settles. A reply that streamed in live may
 * still be flushing to the agent's transcript (seconds, for some agents; see
 * the sync backoffs in the runtime store), so a refetch this soon could only
 * replace it with a truncated read.
 */
const RESYNC_AFTER_SETTLE_MS = 10_000

/**
 * Re-fetch the open conversation's transcript when the client wakes from
 * sleep or its event stream reconnects.
 *
 * Whatever the server broadcast while this client's WebSocket was down is
 * gone for good. The re-attach that follows restores the LIVE state (replay
 * or snapshot), but a turn that finished inside the gap has left the live
 * state: its reply now exists only in the persisted transcript, while the
 * view keeps whatever it had streamed before the drop — until the
 * conversation is reopened. This hook runs the canonical `refetchDetail` path
 * on:
 *
 * - transport reconnect (the socket was replaced after a drop);
 * - the page becoming visible after RESYNC_MIN_HIDDEN_MS or more hidden, i.e.
 *   a wake. This also covers a socket that survived the sleep but fell
 *   behind: its lagged re-attach settles a turn exactly like a reconnect's,
 *   with no reconnect to announce it.
 *
 * Guards:
 * - inert on transports with no reconnect lifecycle (the local desktop app):
 *   its IPC loses nothing across sleep, and a refetch just after a turn ends
 *   races the agent's transcript flush (see `completeTurn` in the runtime
 *   store) for no benefit;
 * - never refetches under a live stream, nor over a reply the stream
 *   delivered. A trigger that lands while the client believes a turn is
 *   streaming is HELD until the stream settles: after sleep that belief is
 *   stale by construction (the events that ended the turn died with the
 *   socket), the re-attach snapshot is what flips the status, and no later
 *   trigger is coming to catch up on. The settle releases the hold only if
 *   the turn's end never reached the view (`turnReachedView`). A turn that
 *   ended in view (the stream carried on after the reconnect, or the
 *   re-attach replayed the gap) is complete as `completeTurn` promotes it,
 *   and a refetch at its end would race the agent's transcript flush with
 *   that reply — the reason `completeTurn` itself never refetches. A hold
 *   also lapses after RESYNC_HOLD_MS;
 * - for the same reason, a trigger within RESYNC_AFTER_SETTLE_MS of a stream
 *   settling (say, the user returning on the turn's completion
 *   notification) is skipped;
 * - debounced to one resync per RESYNC_DEBOUNCE_MS, counted from when a
 *   refetch lands: a failed one leaves the next trigger free to retry;
 * - inert unless the panel is the active tab bound to a persisted
 *   conversation (each panel owns its own listener set and gates itself).
 *
 * Listeners re-bind when the gating inputs change (cheap) so every callback
 * reads current truth rather than refs captured at bind time.
 */
export function useWakeResync(options: {
  /** Panel is the active tab AND bound to a persisted conversation. */
  enabled: boolean
  /**
   * The runtime conversation key. May be a virtual (negative) id for
   * new-chat drafts — `refetchDetail` resolves those to the bound DB row
   * itself, so the raw runtime key is the right thing to pass.
   */
  conversationId: number | null
  /** True while the agent is streaming (connStatus === "prompting"). */
  isStreaming: boolean
  /**
   * Read when the stream settles with a trigger held: whether the turn that
   * settled reached this view through its end, i.e. the connection still
   * holds its live message (streamed, replayed by the re-attach, or carried
   * by its snapshot) for `completeTurn` to promote. False when the re-attach
   * reported the turn already over, which a post-turn snapshot does by
   * carrying no live message: whatever the turn produced after the drop is
   * then only in the transcript.
   */
  turnReachedView: () => boolean
  /**
   * The store's `refetchDetail`: resolves true once its response is in the
   * store, false when it failed or was superseded.
   */
  refetch: (conversationId: number) => Promise<boolean>
}): void {
  const { enabled, conversationId, isStreaming, turnReachedView, refetch } =
    options

  // When a resync last landed. Survives listener re-binds: one resync per
  // debounce window.
  const landedAt = useRef(0)
  // When the page was hidden, while it still is. Survives the re-binds too:
  // a turn can settle while the page is away.
  const hiddenAt = useRef<number | null>(null)
  // When the trigger held for the stream to settle arrived; null when none
  // is held. Survives the re-binds too — the settle itself is one.
  const heldSince = useRef<number | null>(null)
  // When the stream last went from streaming to settled.
  const settledAt = useRef(0)
  const wasStreaming = useRef(isStreaming)

  // A held trigger belongs to the conversation it fired for. Declared before
  // the main effect so a conversation switch clears it in the same commit,
  // before the main effect could release it against the new one.
  useEffect(() => {
    heldSince.current = null
  }, [conversationId])

  // Tracked apart from the gated effect below so a settle is on record even
  // if it happened while the panel was in the background.
  useEffect(() => {
    if (wasStreaming.current && !isStreaming) settledAt.current = Date.now()
    wasStreaming.current = isStreaming
  }, [isStreaming])

  useEffect(() => {
    if (!enabled || conversationId == null) return

    const runResync = () => {
      if (Date.now() - landedAt.current < RESYNC_DEBOUNCE_MS) return
      void refetch(conversationId).then((landed) => {
        if (landed) landedAt.current = Date.now()
      })
    }

    // The stream settled with a trigger held. Release it only for a turn
    // whose end this client never received (the re-attach correcting a stale
    // status): what that turn produced after the drop is only in the
    // transcript. Drop it when the turn ended in view — its reply is complete
    // in memory and the transcript may still be catching up with it — or when
    // the settle came long after the trigger.
    if (!isStreaming && heldSince.current !== null) {
      const settledPromptly = Date.now() - heldSince.current <= RESYNC_HOLD_MS
      heldSince.current = null
      if (settledPromptly && !turnReachedView()) runResync()
    }

    const resync = () => {
      if (isStreaming) {
        heldSince.current = Date.now()
        return
      }
      if (Date.now() - settledAt.current < RESYNC_AFTER_SETTLE_MS) return
      runResync()
    }

    // Null on a transport with no reconnect lifecycle: nothing to recover.
    const offReconnect = onTransportReconnect(resync)
    if (!offReconnect) return

    const onVisibility = () => {
      if (document.visibilityState !== "visible") {
        hiddenAt.current = Date.now()
        return
      }
      const since = hiddenAt.current
      hiddenAt.current = null
      if (since !== null && Date.now() - since >= RESYNC_MIN_HIDDEN_MS) {
        resync()
      }
    }

    document.addEventListener("visibilitychange", onVisibility)

    return () => {
      offReconnect()
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [enabled, conversationId, isStreaming, turnReachedView, refetch])
}
