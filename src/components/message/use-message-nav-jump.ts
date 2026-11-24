"use client"

import { useCallback, useEffect, useRef, useState, type RefObject } from "react"
import type { MessageNavEntry } from "@/components/message/conversation-message-nav"
import type { MessageScrollContextValue } from "@/components/message/message-scroll-context"

interface MessageNavJumpOptions {
  conversationId: number
  /** Each loaded user turn's index among the rendered thread items. */
  threadIndexByTurnId: ReadonlyMap<string, number>
  scrollApiRef: RefObject<MessageScrollContextValue | null>
  /** Glide rather than jump (Settings → Appearance → "Chat animations"). */
  smooth: boolean
  /** The runtime store's `loadOlderTurnsThrough`. */
  loadOlderTurnsThrough: (
    conversationId: number,
    throughIndex: number
  ) => Promise<boolean>
}

interface PendingReveal {
  /** Which click this is. Two clicks on one message are two reveals, and
   *  only the latest one's paging may settle or drop it. */
  token: number
  conversationId: number
  turnId: string
  /** The paging is over (it reached the message); only the scroll is left. */
  settled: boolean
}

/**
 * What a click on a message navigator entry does. A loaded message is
 * scrolled to at once (gliding when chat animations are on). One above the
 * loaded window is paged in first — history is loaded through it, the same
 * seam-verified pages scrolling up would load — and jumped to once it
 * renders.
 *
 * At most one reveal is pending: a newer click replaces it (even on the same
 * message, whose earlier paging then no longer speaks for it), a click on a
 * loaded message drops it, and so does paging that can't reach the message.
 * The scroll waits a frame so virtua has settled the prepend (`shift`) it
 * scrolls into.
 */
export function useMessageNavJump({
  conversationId,
  threadIndexByTurnId,
  scrollApiRef,
  smooth,
  loadOlderTurnsThrough,
}: MessageNavJumpOptions): {
  select: (entry: MessageNavEntry) => void
  revealingTurnId: string | null
} {
  const [reveal, setReveal] = useState<PendingReveal | null>(null)
  const lastToken = useRef(0)
  // A reveal belongs to the conversation it was started in.
  const active =
    reveal != null && reveal.conversationId === conversationId ? reveal : null
  const targetIndex =
    active != null ? (threadIndexByTurnId.get(active.turnId) ?? null) : null

  // Nothing left to wait for: the conversation changed under the reveal, or
  // the paging is over and the message still isn't in the thread.
  if (
    reveal != null &&
    (active == null || (active.settled && targetIndex == null))
  ) {
    setReveal(null)
  }

  useEffect(() => {
    if (active == null || targetIndex == null) return
    const { token } = active
    const frame = requestAnimationFrame(() => {
      // Jumped to, never glided, whatever `smooth` says: the prepend that
      // brought the message in keeps the main thread busy re-rendering a much
      // longer thread, and virtua's smooth scroll gives up without moving
      // when the rows it waits on aren't measured within 150 ms. An instant
      // scroll lands first and settles as those rows are measured.
      scrollApiRef.current?.scrollToIndex(targetIndex, {
        align: "start",
        smooth: false,
      })
      setReveal((current) => (current?.token === token ? null : current))
    })
    return () => cancelAnimationFrame(frame)
  }, [active, targetIndex, scrollApiRef])

  const select = useCallback(
    (entry: MessageNavEntry) => {
      if (entry.threadIndex != null) {
        setReveal(null)
        scrollApiRef.current?.scrollToIndex(entry.threadIndex, {
          align: "start",
          smooth,
        })
        return
      }
      if (entry.turnIndex == null) return
      const token = ++lastToken.current
      setReveal({
        token,
        conversationId,
        turnId: entry.turnId,
        settled: false,
      })
      void loadOlderTurnsThrough(conversationId, entry.turnIndex).then(
        (reached) => {
          setReveal((current) => {
            if (current?.token !== token) return current
            return reached ? { ...current, settled: true } : null
          })
        }
      )
    },
    [conversationId, loadOlderTurnsThrough, scrollApiRef, smooth]
  )

  return { select, revealingTurnId: active?.turnId ?? null }
}
