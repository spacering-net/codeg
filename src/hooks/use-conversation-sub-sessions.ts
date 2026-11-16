"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { listChildConversations } from "@/lib/api"
import { mergeChildrenById } from "@/lib/conversation-children"
import { onTransportReconnect } from "@/lib/platform"
import type { DbConversationSummary } from "@/lib/types"
import { useSubsessionSync } from "@/hooks/use-subsession-sync"

const EMPTY_CHILDREN: DbConversationSummary[] = []

/** Parent-scoped history, kept current by the same events as the sidebar tree. */
export function useConversationSubSessions(parentId: number) {
  const [childrenByParent, setChildrenByParent] = useState<
    Map<number, DbConversationSummary[]>
  >(() => new Map())
  const [loading, setLoading] = useState<Set<number>>(() => new Set())
  const [errors, setErrors] = useState<Set<number>>(() => new Set())
  const deletedChildIdsRef = useRef(new Set<number>())
  const inFlight = useRef(new Map<number, number>())
  const requestId = useRef(0)
  const statusSequence = useRef(0)
  const statuses = useRef(
    new Map<number, { status: string; sequence: number; updatedAt: string }>()
  )
  const bufferStatus = useCallback((id: number, status: string) => {
    statuses.current.set(id, {
      status,
      sequence: ++statusSequence.current,
      updatedAt: new Date().toISOString(),
    })
    if (statuses.current.size > 512) {
      const oldest = statuses.current.keys().next().value
      if (oldest !== undefined) statuses.current.delete(oldest)
    }
  }, [])

  useSubsessionSync({
    setChildrenByParent,
    deletedChildIdsRef,
    onStatus: bufferStatus,
  })

  const load = useCallback(async (id: number) => {
    if (inFlight.current.has(id)) return
    const request = ++requestId.current
    const startedAtSequence = statusSequence.current
    inFlight.current.set(id, request)
    // Establish the live-event buffer before starting the DB request.
    setChildrenByParent((prev) => new Map(prev).set(id, []))
    setLoading((prev) => new Set(prev).add(id))
    setErrors((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
    try {
      const fetched = await listChildConversations(id)
      if (inFlight.current.get(id) !== request) return
      setChildrenByParent((prev) => {
        const snapshot = fetched
          .filter(
            (child) =>
              child.parent_id === id &&
              !deletedChildIdsRef.current.has(child.id)
          )
          .map((child) => {
            const update = statuses.current.get(child.id)
            return update && update.sequence > startedAtSequence
              ? {
                  ...child,
                  status: update.status,
                  updated_at: update.updatedAt,
                }
              : child
          })
        const buffered = prev.get(id) ?? EMPTY_CHILDREN
        return new Map(prev).set(id, mergeChildrenById(snapshot, buffered))
      })
    } catch {
      if (inFlight.current.get(id) === request) {
        setErrors((prev) => new Set(prev).add(id))
      }
    } finally {
      if (inFlight.current.get(id) === request) {
        inFlight.current.delete(id)
        setLoading((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      }
    }
  }, [])

  useEffect(() => {
    // The sync hook invalidates history on reconnect. Also fence off requests
    // made before that reconnect, so their stale results cannot refill it.
    return (
      onTransportReconnect(() => {
        inFlight.current.clear()
        setLoading(new Set())
        setErrors(new Set())
      }) ?? undefined
    )
  }, [])

  const loaded = childrenByParent.has(parentId)
  const isLoading = loading.has(parentId)
  const error = errors.has(parentId)
  useEffect(() => {
    if (!loaded && !isLoading && !error) void load(parentId)
  }, [parentId, loaded, isLoading, error, load])

  const reload = useCallback(() => void load(parentId), [load, parentId])
  return {
    children: childrenByParent.get(parentId) ?? EMPTY_CHILDREN,
    loading: isLoading || !loaded,
    error,
    reload,
  }
}
