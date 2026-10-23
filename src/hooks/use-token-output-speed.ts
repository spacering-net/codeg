"use client"

import { useEffect, useRef, useState } from "react"

import type { LiveMessage } from "@/contexts/acp-connections-context"
import { TokenCountAccumulator, TokenSpeedTracker } from "@/lib/token-speed"

/**
 * Sample period. One timer runs at a steady 2 Hz to sample incremental token
 * production and refresh the rolling average throughput over the last 10 active
 * output samples (inspired by Hermes's status-bar token velocity).
 *
 * During tool calls, silent pauses, or when text generation completes before the
 * turn finishes, the rolling speed is preserved rather than decaying to 0.
 */
const SAMPLE_MS = 500
/** Clamp, so a nonsense spike can never stretch the row it renders in. */
const MAX_TPS = 999.9

/**
 * Live token-output-speed for one streaming turn, in tok/s. A local estimate
 * from the message's `text` + `thinking` blocks — root agent only, since
 * sub-agent output belongs to its own capsule rather than to this turn's rate.
 *
 * Modeled after Hermes's rolling history (`deque(maxlen=10)`), this computes
 * the true throughput (`sum(tokens) / sum(latency)`) across up to the last 10
 * active output samples.
 *
 * `null` means "nothing to show": the turn has produced no output yet, or the
 * reading doesn't cover a meaningful slice of wall clock yet. The caller is
 * expected to mount this for the life of one turn and unmount when it ends.
 */
export function useTokenOutputSpeed(message: LiveMessage): number | null {
  const [tps, setTps] = useState<number | null>(null)

  // The sampler below runs off a timer rather than off this component's
  // render, so it reads the message through a ref. Written in an effect (never
  // during render); being one commit behind costs at most a frame, which the
  // cumulative counts absorb on the next sample anyway.
  const messageRef = useRef(message)
  useEffect(() => {
    messageRef.current = message
  })

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

    /** Cumulative estimated tokens. Only appended text is scanned. */
    const measure = (): number => {
      const live = messageRef.current
      // A snapshot hydration swaps the message out wholesale instead of
      // appending to it, so the accumulator's cached per-block prefixes can
      // describe entirely different text — re-seat on an identity change.
      if (live.id !== messageId) {
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

      // `null` is "still seeding / warming up", not "zero" — hold the last
      // reading rather than blinking out.
      const rate = tracker.observe(total, now)
      if (rate == null) return
      setTps(Math.min(Math.max(rate, 0), MAX_TPS))
    }, SAMPLE_MS)

    return () => clearInterval(timer)
  }, [])

  return tps
}
