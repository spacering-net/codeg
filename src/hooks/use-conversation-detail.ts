"use client"

import { useEffect, useRef } from "react"
import { useShallow } from "zustand/react/shallow"
import {
  sessionHoldsActiveTurns,
  useConversationRuntimeActions,
  useConversationRuntimeStore,
} from "@/stores/conversation-runtime-store"
import type { DbConversationDetail } from "@/lib/types"

function isVirtualConversationId(conversationId: number): boolean {
  return !Number.isFinite(conversationId) || conversationId <= 0
}

/**
 * Delays before each automatic retry of a failed detail fetch; the last one
 * repeats for as long as the failure lasts. A failure leaves no detail and
 * nothing in flight, which is exactly what the auto-fetch keys on, so it used
 * to re-request on the very next render, as fast as the transport could fail:
 * a transcript that will not parse was re-parsed in a hot loop, a server that
 * was down was hammered until it came back, and the error flickered in and out
 * the whole time. Spaced retries keep what that loop did right — a view picks
 * its conversation back up once the server is reachable again, here within
 * half a minute — and the error stays readable, next to its Reload action, in
 * between.
 */
export const DETAIL_RETRY_DELAYS_MS: readonly number[] = [
  1_000, 2_000, 4_000, 8_000, 16_000, 30_000,
]

export function useConversationDetail(
  conversationId: number,
  options?: {
    /**
     * Gate the built-in auto-fetch. Defaults to `true`. Pass `false` when the
     * caller drives fetching itself and must prevent a fetch from landing at
     * the wrong moment — e.g. the sub-agent session dialog, which must not load
     * the child's persisted detail while it is mid-stream (the parser surfaces
     * the in-progress turn as a normal turn, which would then duplicate the
     * live stream).
     *
     * Also pass `false` for a mounted-but-OFF-SCREEN view. The workspace keeps
     * every open tab mounted (that is what preserves a background session's
     * stream and scroll state), so an ungated hook fires one detail fetch per
     * open tab as soon as the tab set is restored — N concurrent
     * `get_folder_conversation` calls carrying tens of MB for a large tab set,
     * before the user has looked at any of them. Flipping `enabled` to `true`
     * (which is what a tab switch / group selection / tiling does) re-runs the
     * effect and fetches then.
     */
    enabled?: boolean
  }
): {
  detail: DbConversationDetail | null
  /**
   * True while the detail is being fetched — and ALSO on the render that is
   * about to start that fetch. The fetch is dispatched from an effect, i.e.
   * only after the render that decided it has committed, so without the second
   * half that render reads as "settled, nothing persisted": no detail, not
   * loading. A view kept mounted while hidden already has a runtime session
   * (its mount effects create one), so the render that first shows it is
   * exactly such a render — and the conversation panel's auto-connect gate,
   * which waits on `loading` for the stored session id, would let the connect
   * through with `sessionId: undefined` (backend `session/new`, history
   * orphaned on the next prompt).
   */
  loading: boolean
  error: string | null
  acpLoadError: string | null
} {
  const enabled = options?.enabled ?? true
  // Subscribe to ONLY the detail-related fields this hook exposes, not the whole
  // session object. The live-message sink replaces the session object on every
  // streaming batch (~60/s, via SET_LIVE_MESSAGE); a whole-session selector here
  // would re-render every consumer — notably the keep-alive conversation panel,
  // which calls this hook — on each streaming token. None of these fields change
  // mid-stream, so `useShallow` keeps the slice reference-stable across batches
  // and consumers re-render only on a real detail transition. (`hasSession`
  // preserves the "session exists yet?" signal the loading state depends on.)
  const {
    detail,
    detailLoading,
    detailError,
    acpLoadError,
    hasSession,
    needsFetch,
    retryDue,
  } = useConversationRuntimeStore(
    useShallow((s) => {
      const session = s.byConversationId.get(conversationId)
      // `fetchDetail`'s own admission rule: nothing loaded, nothing in flight,
      // no ongoing turn holding the session. Exposed only as booleans: a
      // streaming batch can't flip them — once a stream is under way (or a
      // detail exists) they are already false — so the slice stays stable.
      const admissible =
        session == null ||
        (session.detail == null &&
          !session.detailLoading &&
          !sessionHoldsActiveTurns(session))
      return {
        detail: session?.detail ?? null,
        detailLoading: session?.detailLoading ?? false,
        detailError: session?.detailError ?? null,
        acpLoadError: session?.acpLoadError ?? null,
        hasSession: session != null,
        // Fetch right away — unless the last fetch failed, which waits for
        // the retry schedule instead.
        needsFetch: admissible && session?.detailError == null,
        retryDue: admissible && session?.detailError != null,
      }
    })
  )
  const { fetchDetail } = useConversationRuntimeActions()
  const isVirtual = isVirtualConversationId(conversationId)
  const fetchPending = enabled && !isVirtual && needsFetch
  const retryPending = enabled && !isVirtual && retryDue

  useEffect(() => {
    if (!fetchPending) return
    fetchDetail(conversationId)
  }, [fetchPending, conversationId, fetchDetail])

  // Automatic retries spent on the current run of failures. A loaded detail or
  // another conversation starts a new run. A hidden view's pending retry is
  // dropped and rescheduled, at the same step, when the view is shown again.
  const retriesUsedRef = useRef(0)
  useEffect(() => {
    retriesUsedRef.current = 0
  }, [conversationId])
  useEffect(() => {
    if (detail) retriesUsedRef.current = 0
  }, [detail])
  useEffect(() => {
    if (!retryPending) return
    const used = retriesUsedRef.current
    const delay =
      DETAIL_RETRY_DELAYS_MS[Math.min(used, DETAIL_RETRY_DELAYS_MS.length - 1)]
    const timer = setTimeout(() => {
      retriesUsedRef.current = used + 1
      fetchDetail(conversationId)
    }, delay)
    return () => clearTimeout(timer)
  }, [retryPending, conversationId, fetchDetail])

  return {
    detail,
    loading: hasSession ? detailLoading || fetchPending : !isVirtual,
    error: detailError,
    acpLoadError,
  }
}
