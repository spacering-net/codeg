"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { PromptDraft } from "@/lib/types"
import type { MessageQueueChangedPayload, PersistedQueueItem, MessageQueueSaveItem } from "@/lib/types"
import { randomUUID } from "@/lib/utils"
import { messageQueueList, messageQueueSave } from "@/lib/api"
import { subscribe } from "@/lib/platform"

export const MESSAGE_QUEUE_CHANGED_EVENT = "message-queue://changed"

export interface QueuedMessage {
  id: string
  draft: PromptDraft
  /**
   * The mode this message will be sent under. `null` means "leave the agent's
   * mode alone" — an explicit choice for the answer / plan-notes retry paths,
   * which must not switch mode on their way out.
   *
   * That is why {@link QueuedMessage.adoptSendTimeMode} exists as a separate
   * flag rather than being spelled `modeId === null`: "unknown yet" and
   * "deliberately none" are different intents.
   */
  modeId: string | null
  /**
   * Resolve the mode when this message actually SENDS, ignoring `modeId`.
   *
   * For messages queued before their tab could know its modes — a prompt parked
   * on a brand-new draft by "ask about this selection", which is enqueued while
   * the connection is still coming up. Without it the agent would run in
   * whatever mode it happened to start in while the composer above displayed the
   * user's saved mode.
   */
  adoptSendTimeMode?: boolean
}

export interface UseMessageQueueReturn {
  queue: QueuedMessage[]
  enqueue: (
    draft: PromptDraft,
    modeId: string | null,
    opts?: { adoptSendTimeMode?: boolean }
  ) => void
  /**
   * Put a draft back at the FRONT of the queue. Used when an auto-flushed item
   * was dequeued, sent, and bounced (TurnBusyError): it must return to the head
   * so it retries before items that were already behind it (FIFO preserved).
   */
  requeueFront: (draft: PromptDraft, modeId: string | null) => void
  dequeue: () => QueuedMessage | undefined
  remove: (id: string) => void
  reorder: (items: QueuedMessage[]) => void
  /** Prioritize a still-queued item using its latest draft and mode. */
  moveToFront: (id: string) => void
  updateItem: (id: string, draft: PromptDraft) => void
  /**
   * The queue length, read SYNCHRONOUSLY from the authoritative ref — it
   * reflects the same-tick result of an enqueue/requeue/dequeue, before React
   * commits the next render. Callers gating on "is the queue non-empty right
   * now" — the direct-send routing — must use this rather than `queue.length`
   * (which lags a render).
   */
  getQueueLength: () => number
  editingItemId: string | null
  startEditing: (id: string) => void
  cancelEditing: () => void
}

function serializeDraft(draft: PromptDraft): string {
  return JSON.stringify(draft)
}

function parseItem(item: PersistedQueueItem): QueuedMessage | null {
  try {
    const draft = JSON.parse(item.draft_json) as PromptDraft
    return {
      id: item.id,
      draft,
      modeId: item.mode_id,
      adoptSendTimeMode: item.adopt_send_time_mode || undefined,
    }
  } catch {
    // A corrupt persisted draft must not crash the queue; skip it.
    return null
  }
}

function toSaveItem(q: QueuedMessage): MessageQueueSaveItem {
  return {
    id: q.id,
    draftJson: serializeDraft(q.draft),
    modeId: q.modeId,
    adoptSendTimeMode: q.adoptSendTimeMode ?? false,
  }
}

/**
 * Manages a conversation's "send later" message queue.
 *
 * Without an `ownerId` (e.g. an unbound draft tab) the queue is purely in-memory
 * and behaves exactly as before — synchronous, no persistence, no network. This
 * keeps the existing unit tests (which construct the hook with no owner) valid.
 *
 * With an `ownerId` (a conversation id) the queue is PERSISTED to the backend and
 * SYNCHRONIZED across every window / web client:
 *  - on mount (and whenever the owner changes) the persisted queue is loaded;
 *  - every local mutation is persisted via `message_queue_save`;
 *  - a `message-queue://changed` broadcast (emitted by the backend on every save)
 *    lets other clients converge to the same queue. The originating client
 *    ignores its own echo via the `origin` tag so a concurrent local mutation is
 *    never clobbered by the broadcast it triggered.
 */
export function useMessageQueue(ownerId?: string | null): UseMessageQueueReturn {
  const [queue, setQueue] = useState<QueuedMessage[]>([])
  const [editingItemId, setEditingItemId] = useState<string | null>(null)
  // Authoritative copy of the queue, updated SYNCHRONOUSLY by every mutation
  // (before the React state commit). Reads that must observe the same-tick
  // result of a mutation — the direct-send queue routing — go through this
  // ref / `getQueueLength`, NOT the `queue` state (which lags until React
  // commits) and NOT a passive-effect-synced mirror (which lags a full
  // render). Without this, a bounce that re-queues a draft leaves a window
  // where a caller still sees an empty queue.
  const queueRef = useRef<QueuedMessage[]>(queue)

  // Latest owner / client id, read inside async callbacks without re-subscribing.
  const ownerIdRef = useRef<string | null | undefined>(ownerId)
  ownerIdRef.current = ownerId
  const clientIdRef = useRef<string>(randomUUID())
  const editingItemIdRef = useRef<string | null>(null)
  editingItemIdRef.current = editingItemId
  // Tracks the previously-bound owner so we can tell "bind" from "switch".
  const prevOwnerRef = useRef<string | null | undefined>(undefined)

  // Persist the current queue to the backend (if owned) and broadcast.
  const persist = useCallback((next: QueuedMessage[]) => {
    const owner = ownerIdRef.current
    if (!owner) return
    const items = next.map(toSaveItem)
    // Fire-and-forget: a failed persist must not break the synchronous flush
    // path. The broadcast converges other clients when it succeeds.
    void messageQueueSave(owner, items, clientIdRef.current).catch(() => {})
  }, [])

  // Update the authoritative ref first, then schedule the render. A plain value
  // (not a functional updater) is correct because `queueRef.current` is always
  // the latest committed value.
  const commit = useCallback((next: QueuedMessage[]) => {
    queueRef.current = next
    setQueue(next)
  }, [])

  // Load the persisted queue when the owner appears or changes.
  useEffect(() => {
    if (!ownerId) {
      prevOwnerRef.current = ownerId
      return
    }
    const prev = prevOwnerRef.current
    prevOwnerRef.current = ownerId
    let cancelled = false
    messageQueueList(ownerId)
      .then((items) => {
        if (cancelled) return
        const parsed = items.map(parseItem).filter((x): x is QueuedMessage => x !== null)
        const hadInMemory = queueRef.current.length > 0
        if (prev === null || prev === undefined) {
          // Binding from an unbound tab: keep any parked prompts (they have no
          // persisted row yet) and persist them so they survive from here on.
          if (hadInMemory) {
            persist(queueRef.current)
          } else {
            commit(parsed)
          }
        } else {
          // Switched to a different conversation: load its persisted queue.
          commit(parsed)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [ownerId, commit, persist])

  // Cross-client sync: apply broadcasts that originated elsewhere.
  useEffect(() => {
    if (!ownerId) return
    let unsub: (() => void) | undefined
    let cancelled = false
    subscribe<MessageQueueChangedPayload>(MESSAGE_QUEUE_CHANGED_EVENT, (payload) => {
      if (payload.owner_id !== ownerIdRef.current) return
      if (payload.origin === clientIdRef.current) return
      const parsed = payload.items
        .map(parseItem)
        .filter((x): x is QueuedMessage => x !== null)
      // If the item being edited vanished on another client, drop edit mode.
      if (
        editingItemIdRef.current !== null &&
        !parsed.some((p) => p.id === editingItemIdRef.current)
      ) {
        setEditingItemId(null)
      }
      commit(parsed)
    })
      .then((u) => {
        if (!cancelled) unsub = u
      })
      .catch(() => {})
    return () => {
      cancelled = true
      unsub?.()
    }
  }, [ownerId, commit])

  const enqueue = useCallback(
    (
      draft: PromptDraft,
      modeId: string | null,
      opts?: { adoptSendTimeMode?: boolean }
    ) => {
      const next = [
        ...queueRef.current,
        {
          id: randomUUID(),
          draft,
          modeId,
          ...(opts?.adoptSendTimeMode ? { adoptSendTimeMode: true } : {}),
        },
      ]
      commit(next)
      persist(next)
    },
    [commit, persist]
  )

  const requeueFront = useCallback(
    (draft: PromptDraft, modeId: string | null) => {
      const next = [{ id: randomUUID(), draft, modeId }, ...queueRef.current]
      commit(next)
      persist(next)
    },
    [commit, persist]
  )

  const dequeue = useCallback((): QueuedMessage | undefined => {
    const current = queueRef.current
    if (current.length === 0) return undefined
    const next = current.slice(1)
    commit(next)
    persist(next)
    return current[0]
  }, [commit, persist])

  const remove = useCallback(
    (id: string) => {
      if (editingItemIdRef.current === id) {
        setEditingItemId(null)
      }
      const next = queueRef.current.filter((item) => item.id !== id)
      commit(next)
      persist(next)
    },
    [commit, persist]
  )

  const reorder = useCallback(
    (items: QueuedMessage[]) => {
      // Apply a reorder ONLY if it is a true permutation of the live queue, and
      // rebuild it from the AUTHORITATIVE items rather than the caller's
      // (possibly stale) objects. A drag emission carries the queue order from
      // the render it began in; if the live queue changed since (dequeue /
      // requeue / remove / updateItem), the dragged array is stale. Reject any
      // length mismatch, unknown id, or repeated id (e.g. `[A, A]` would
      // otherwise drop `B` and duplicate `A`); commit the current item objects
      // in the requested order so a concurrent `updateItem` isn't clobbered.
      const current = queueRef.current
      if (items.length !== current.length) return
      const byId = new Map(current.map((item) => [item.id, item]))
      const seen = new Set<string>()
      const next: QueuedMessage[] = []
      for (const item of items) {
        const authoritative = byId.get(item.id)
        if (!authoritative || seen.has(item.id)) return
        seen.add(item.id)
        next.push(authoritative)
      }
      commit(next)
      persist(next)
    },
    [commit, persist]
  )

  const updateItem = useCallback(
    (id: string, draft: PromptDraft) => {
      const next = queueRef.current.map((item) =>
        item.id === id ? { ...item, draft } : item
      )
      commit(next)
      persist(next)
      setEditingItemId(null)
    },
    [commit, persist]
  )

  const moveToFront = useCallback(
    (id: string) => {
      const current = queueRef.current
      const index = current.findIndex((item) => item.id === id)
      if (index <= 0) return
      const next = [current[index], ...current.filter((item) => item.id !== id)]
      commit(next)
      persist(next)
    },
    [commit, persist]
  )

  const getQueueLength = useCallback(() => queueRef.current.length, [])

  const startEditing = useCallback((id: string) => {
    setEditingItemId(id)
  }, [])

  const cancelEditing = useCallback(() => {
    setEditingItemId(null)
  }, [])

  return {
    queue,
    enqueue,
    requeueFront,
    dequeue,
    remove,
    reorder,
    moveToFront,
    updateItem,
    getQueueLength,
    editingItemId,
    startEditing,
    cancelEditing,
  }
}
