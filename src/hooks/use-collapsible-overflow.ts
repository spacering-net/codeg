"use client"

import { useEffect, useId, useRef, useState } from "react"

/** Content keys whose overflow is remembered as values (a raw string) rather
 *  than by identity; past this many the oldest is forgotten. */
const MAX_REMEMBERED_VALUES = 512

const rememberedByIdentity = new WeakMap<object, boolean>()
const rememberedByValue = new Map<unknown, boolean>()

function recall(contentKey: unknown): boolean | undefined {
  return typeof contentKey === "object" && contentKey !== null
    ? rememberedByIdentity.get(contentKey)
    : rememberedByValue.get(contentKey)
}

function remember(contentKey: unknown, overflowing: boolean) {
  if (typeof contentKey === "object" && contentKey !== null) {
    rememberedByIdentity.set(contentKey, overflowing)
    return
  }
  rememberedByValue.delete(contentKey)
  rememberedByValue.set(contentKey, overflowing)
  if (rememberedByValue.size > MAX_REMEMBERED_VALUES) {
    rememberedByValue.delete(rememberedByValue.keys().next().value)
  }
}

/**
 * Shared "clamp a block, reveal a Show more/Show less toggle once it's actually
 * clipped" plumbing. Used by the chat's user messages and by the git-log tab's
 * commit message body — the clamp height itself stays with each caller (a CSS
 * class on the content node), so nothing here duplicates a numeric threshold.
 *
 * Bind `contentRef` to the node that carries the `max-h-*` class and `contentId`
 * to its `id` (paired with the toggle's `aria-controls`). Pass whatever value
 * identifies the content (`parts`, the raw string, …) as `contentKey` so a
 * changed body is remeasured.
 *
 * What a content measured outlives the block: the transcript is virtualized
 * and mounts a block again whenever it scrolls back to it, and a block that
 * started unmeasured would draw without its toggle for a frame and then with
 * it — a height change under the virtual list, which, near the bottom, the
 * bottom lock and the list's scroll correction could keep turning into
 * another.
 */
export function useCollapsibleOverflow<T extends HTMLElement>(
  contentKey: unknown
): {
  contentRef: React.RefObject<T | null>
  contentId: string
  isOverflowing: boolean
  expanded: boolean
  toggle: () => void
} {
  const contentRef = useRef<T>(null)
  const [isOverflowing, setIsOverflowing] = useState(
    () => recall(contentKey) ?? false
  )
  const [expanded, setExpanded] = useState(false)
  const contentId = useId()

  useEffect(() => {
    // Nothing useful to redetect once expanded: the caller drops its clamp
    // class, so clientHeight === scrollHeight trivially and this would
    // misreport `false`, dropping the "Show less" toggle. Freeze the last
    // known value instead.
    if (expanded) return
    const el = contentRef.current
    if (!el) return
    // Measured when the browser lays the node out: an observer reports a node
    // at its first layout (so a new observer per `contentKey` remeasures a
    // changed body) and again on every resize. Reading the heights here
    // instead would force a synchronous layout from inside React's effects,
    // once per clamped block — and a long transcript mounts dozens.
    const observer = new ResizeObserver(() => {
      // Both reads are on the same, currently clamped node: no numeric
      // threshold duplicated from CSS. clientHeight is capped by the caller's
      // class; scrollHeight always reports the untruncated height.
      const overflowing = el.scrollHeight > el.clientHeight + 1
      remember(contentKey, overflowing)
      setIsOverflowing(overflowing)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [contentKey, expanded])

  return {
    contentRef,
    contentId,
    isOverflowing,
    expanded,
    toggle: () => setExpanded((v) => !v),
  }
}
