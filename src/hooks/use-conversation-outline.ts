"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { getFolderConversationOutline } from "@/lib/api"
import { extendPrefixFingerprint, FNV_SEED_HEX } from "@/lib/turn-window"
import type { ConversationOutline, MessageTurn } from "@/lib/types"

export type ConversationOutlineState =
  /** Nothing to outline: disabled, or no messages above the window. */
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error" }
  /** `turns` is exactly the history above the window, `full[0..offset)`. */
  | { status: "ready"; turns: readonly MessageTurn[] }

export interface ConversationOutlineRequest {
  /** DB row id to fetch with; null while the conversation has none. */
  fetchId: number | null
  /** Global index of the loaded window's first turn. */
  offset: number
  /** The window's `prefix_hash`: the fingerprint of `full[0..offset)`. */
  prefixHash: string | null
  enabled: boolean
}

const IDLE: ConversationOutlineState = { status: "idle" }
const LOADING: ConversationOutlineState = { status: "loading" }
const ERROR: ConversationOutlineState = { status: "error" }

/**
 * `outline.turns[0..offset)` when it provably is the history above a window
 * starting at `offset` whose prefix fingerprint is `prefixHash`; null when it
 * isn't (the window moved past it, or the history was rewritten since).
 *
 * An outline fetched for a window keeps serving it as older pages are
 * prepended (the offset only shrinks), checked by fingerprinting the shorter
 * prefix it now has to cover.
 */
export function outlinePrefix(
  outline: ConversationOutline,
  offset: number,
  prefixHash: string
): readonly MessageTurn[] | null {
  const { turns } = outline
  if (turns.length < offset) return null
  if (turns.length === offset) {
    return outline.prefix_hash === prefixHash ? turns : null
  }
  const prefix = turns.slice(0, offset)
  return extendPrefixFingerprint(FNV_SEED_HEX, prefix) === prefixHash
    ? prefix
    : null
}

/**
 * The message navigator's outline of the history above a conversation's
 * loaded window, fetched while `enabled` (the navigator is open and there is
 * history above the window) and reused for as long as it still covers it.
 *
 * Read-only and verified at use rather than ordered against the window's own
 * fetches: whatever the window does meanwhile, an outline is only ever shown
 * for a window whose prefix fingerprint it reproduces. One fetch at a time; an
 * outline that doesn't cover the window it was fetched for marks that window
 * failed instead of being fetched again, until the window moves or `retry`.
 */
export function useConversationOutline({
  fetchId,
  offset,
  prefixHash,
  enabled,
}: ConversationOutlineRequest): {
  state: ConversationOutlineState
  retry: () => void
} {
  const [fetched, setFetched] = useState<{
    fetchId: number
    outline: ConversationOutline
  } | null>(null)
  const [failedKey, setFailedKey] = useState<string | null>(null)
  const inFlight = useRef(false)

  const key =
    enabled && fetchId != null && prefixHash != null && offset > 0
      ? `${fetchId}:${offset}:${prefixHash}`
      : null

  const turns = useMemo(() => {
    if (key == null || prefixHash == null) return null
    if (fetched == null || fetched.fetchId !== fetchId) return null
    return outlinePrefix(fetched.outline, offset, prefixHash)
  }, [key, fetched, fetchId, offset, prefixHash])

  useEffect(() => {
    if (key == null || fetchId == null || prefixHash == null) return
    if (turns != null || failedKey === key || inFlight.current) return
    inFlight.current = true
    const requested = { key, fetchId, offset, prefixHash }
    getFolderConversationOutline(requested.fetchId, requested.offset)
      .then((outline) => {
        inFlight.current = false
        setFetched({ fetchId: requested.fetchId, outline })
        if (
          outlinePrefix(outline, requested.offset, requested.prefixHash) == null
        ) {
          setFailedKey(requested.key)
        }
      })
      .catch(() => {
        inFlight.current = false
        setFailedKey(requested.key)
      })
    // `fetched` and `failedKey` re-run this after every landing: an outline
    // fetched for a window that has moved on since may not cover the current
    // one, which then needs its own fetch.
  }, [key, turns, failedKey, fetched, fetchId, offset, prefixHash])

  const retry = useCallback(() => setFailedKey(null), [])

  const state = useMemo<ConversationOutlineState>(() => {
    if (key == null) return IDLE
    if (turns != null) return { status: "ready", turns }
    return failedKey === key ? ERROR : LOADING
  }, [key, turns, failedKey])

  return { state, retry }
}
