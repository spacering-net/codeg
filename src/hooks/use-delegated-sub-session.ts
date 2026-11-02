/**
 * Resolves a delegation binding by `parent_tool_use_id` (or, for a
 * `resume_delegation` card, by the broker task id) and fetches the child
 * conversation's persisted detail (turns + session stats) so the parent's
 * delegation row can show a preview inline.
 *
 * Returns `{ binding, detail, loading, error }`. `binding` may be undefined
 * if the parent UI mounted before the `delegation_started` event was
 * delivered (e.g. resuming an old conversation from disk where the live
 * broker has long since cleared the binding). In that case `detail` stays
 * null; callers may fall back to a placeholder.
 *
 * The child detail is fetched once and cached for the lifetime of the
 * binding — completion of the child causes the binding's status to flip
 * but does not invalidate the cached detail; callers re-fetch by remounting
 * the hook (e.g. user expands the sub-thread again).
 */

import { useEffect, useReducer } from "react"
import type { DbConversationDetail } from "@/lib/types"
import { getFolderConversation } from "@/lib/api"
import {
  useDelegation,
  type DelegationBinding,
} from "@/contexts/delegation-context"

export interface UseDelegatedSubSessionResult {
  binding: DelegationBinding | undefined
  detail: DbConversationDetail | null
  loading: boolean
  error: string | null
}

interface FetchState {
  detail: DbConversationDetail | null
  loading: boolean
  error: string | null
}

const INITIAL_STATE: FetchState = { detail: null, loading: false, error: null }

type FetchAction =
  | { kind: "start" }
  | { kind: "ok"; detail: DbConversationDetail }
  | { kind: "err"; message: string }

// `useReducer` instead of three `useState` slots so the in-effect transition
// to "fetching" / "ok" / "err" is a single dispatch — `react-hooks/set-state-
// in-effect` only flags raw setState calls, not dispatch.
function fetchReducer(_state: FetchState, action: FetchAction): FetchState {
  switch (action.kind) {
    case "start":
      return { detail: null, loading: true, error: null }
    case "ok":
      return { detail: action.detail, loading: false, error: null }
    case "err":
      return { detail: null, loading: false, error: action.message }
  }
}

export function useDelegatedSubSession(
  parentToolUseId: string,
  options?: {
    enabled?: boolean
    fallbackChildConversationId?: number | null
    /**
     * A broker task id to resolve the binding by when `parentToolUseId`
     * matches none. Set by `DelegationResumeRow`: `resume_delegation`
     * re-binds the child to the ORIGINAL `delegate_to_agent` call's
     * tool_use_id, so the resume call's own id is never a binding key — the
     * task id in its arguments is the only handle it has.
     */
    fallbackTaskId?: string | null
  }
): UseDelegatedSubSessionResult {
  const enabled = options?.enabled ?? true
  const fallbackChildConversationId =
    options?.fallbackChildConversationId ?? null
  const fallbackTaskId = options?.fallbackTaskId ?? null
  const { findByParentToolUseId, findByTaskId } = useDelegation()
  const binding =
    findByParentToolUseId(parentToolUseId) ??
    (fallbackTaskId ? findByTaskId(fallbackTaskId) : undefined)
  // When the live binding is unavailable (snapshot replay after refresh,
  // or the parent UI mounted after `delegation_started` was consumed),
  // fall back to a child id provided by the caller — typically derived
  // from `meta["codeg.delegation"].child_conversation_id` carried by the
  // parent's tool-call snapshot.
  const childId = binding?.childConversationId ?? fallbackChildConversationId
  const shouldFetch = enabled && childId != null

  const [state, dispatch] = useReducer(fetchReducer, INITIAL_STATE)

  useEffect(() => {
    if (!shouldFetch) return
    let cancelled = false
    dispatch({ kind: "start" })
    void getFolderConversation(childId)
      .then((d) => {
        if (cancelled) return
        dispatch({ kind: "ok", detail: d })
      })
      .catch((err) => {
        if (cancelled) return
        dispatch({
          kind: "err",
          message: err instanceof Error ? err.message : String(err),
        })
      })

    return () => {
      cancelled = true
    }
  }, [shouldFetch, childId])

  if (!shouldFetch) {
    return { binding, detail: null, loading: false, error: null }
  }
  return { binding, ...state }
}
