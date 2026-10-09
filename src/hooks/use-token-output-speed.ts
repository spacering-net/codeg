"use client"

import { useEffect, useRef, useState } from "react"

import type { LiveMessage } from "@/contexts/acp-connections-context"
import {
  commitLiveSessionOutputSpeed,
  migrateSessionOutputSpeed,
  setLiveSessionOutputSpeed,
} from "@/lib/session-output-speed"
import { TokenCountAccumulator, TokenSpeedTracker } from "@/lib/token-speed"

/**
 * Sample period. One timer does all three jobs the reading needs — take a
 * measurement, repaint, and notice a tool wait — so the gauge ticks at a
 * steady 2 Hz whether or not the wire is busy.
 *
 * The connection dispatches far more often than this (once per wire envelope),
 * but the smoother is time-constant based rather than per-event, so a coarser
 * regular sample reads the same rate for a fraction of the work.
 */
const SAMPLE_MS = 500
/** Clamp, so a nonsense spike can never stretch the row it renders in. */
const MAX_TPS = 999.9

export interface TokenOutputSpeedOptions {
  /** Runtime conversation id the session average is stored under. */
  conversationId?: number | null
  /**
   * Extra "not generating" signal from outside the message (a permission
   * prompt, a blocking question). In-flight tool calls on the message are
   * detected here already.
   */
  waiting?: boolean
}

function liveMessageIsWaitingOnTool(message: LiveMessage): boolean {
  return message.content.some(
    (block) =>
      block.type === "tool_call" &&
      (block.info.status === "pending" || block.info.status === "in_progress")
  )
}

/**
 * Live token-output-speed for one streaming turn, in tok/s. A local estimate
 * from the message's `text` + `thinking` blocks — root agent only, since
 * sub-agent output belongs to its own capsule rather than to this turn's rate.
 *
 * Time spent waiting on an in-flight tool (or `waiting`) is not generation
 * and is excluded from both the live EWMA and the session average.
 *
 * `null` means "nothing to show": the turn has produced no output yet, or the
 * reading doesn't cover a meaningful slice of generating time yet. The caller
 * is expected to mount this for the life of one turn and unmount when it ends.
 *
 * TODO: root-agent only; give sub-agent cards their own reading if cross-agent
 * delegation speed becomes something users ask about.
 */
export function useTokenOutputSpeed(
  message: LiveMessage,
  options: TokenOutputSpeedOptions = {}
): number | null {
  const [tps, setTps] = useState<number | null>(null)
  const { conversationId = null, waiting = false } = options

  const messageRef = useRef(message)
  const waitingRef = useRef(waiting)
  const conversationIdRef = useRef(conversationId)
  useEffect(() => {
    messageRef.current = message
    waitingRef.current = waiting
  })
  useEffect(() => {
    const prev = conversationIdRef.current
    if (prev != null && conversationId != null && prev !== conversationId) {
      migrateSessionOutputSpeed(prev, conversationId)
    }
    conversationIdRef.current = conversationId
  }, [conversationId])

  useEffect(() => {
    const counts = new TokenCountAccumulator()
    const tracker = new TokenSpeedTracker()
    let messageId: string | null = null
    /**
     * When we last saw the turn holding no eligible output at all, or `null`
     * when we can't claim that — a mid-turn attach and a hydration both arrive
     * with tokens produced over a window we never watched.
     */
    let emptyAt: number | null = null

    const publishSession = () => {
      const id = conversationIdRef.current
      if (id == null) return
      setLiveSessionOutputSpeed(
        id,
        tracker.generatingTokenCount,
        tracker.generatingElapsedMs
      )
    }

    const commitSession = () => {
      const id = conversationIdRef.current
      if (id == null) return
      publishSession()
      commitLiveSessionOutputSpeed(id)
    }

    /** Cumulative estimated tokens. Only appended text is scanned. */
    const measure = (): number => {
      const live = messageRef.current
      // A snapshot hydration swaps the message out wholesale instead of
      // appending to it, so the accumulator's cached per-block prefixes can
      // describe entirely different text — re-seat on an identity change.
      if (live.id !== messageId) {
        if (messageId != null) commitSession()
        messageId = live.id
        counts.reset()
        tracker.reset()
        // Whatever we knew about the old message says nothing about this one.
        emptyAt = null
      }
      counts.beginPass()
      for (const block of live.content) {
        if (
          (block.type === "text" || block.type === "thinking") &&
          block.parentToolUseId == null
        ) {
          counts.push(block.text)
        }
      }
      return counts.endPass()
    }

    // Seed from whatever has already streamed, so a mid-turn attach (a refresh,
    // a reconnect, a tab reopened while the agent was talking) measures a real
    // rate from here on instead of the whole accumulated turn. Deliberately
    // publishes nothing: `observe` only seeds on its first call, and setting
    // state in an effect body is a lint error besides.
    const initial = measure()
    if (initial > 0) tracker.observe(initial, performance.now())
    else emptyAt = performance.now()

    const timer = setInterval(() => {
      const now = performance.now()
      const total = measure()

      // Nothing produced yet: the turn is still waiting on its first token, or
      // running a tool before it says anything. The tracker must not see this
      // — a turn that thought for three seconds would carry three seconds of
      // zeros into its average and open at a third of the true rate, climbing
      // for seconds afterwards. Note when we saw nothing instead.
      if (total <= 0) {
        tracker.reset()
        emptyAt = now
        return
      }

      if (emptyAt != null) {
        // The turn held nothing one sample ago, so this whole count was
        // produced inside that window: seed at zero there and let the observe
        // below measure it, rather than burning it as a bare baseline.
        tracker.observe(0, emptyAt)
        emptyAt = null
      }

      const pause =
        waitingRef.current || liveMessageIsWaitingOnTool(messageRef.current)

      // `null` is "still seeding / warming up", not "zero" — hold the last
      // reading rather than blinking out.
      const rate = tracker.observe(total, now, { pause })
      publishSession()
      if (rate == null) return
      setTps(Math.min(Math.max(rate, 0), MAX_TPS))
    }, SAMPLE_MS)

    return () => {
      clearInterval(timer)
      commitSession()
    }
  }, [])

  return tps
}
