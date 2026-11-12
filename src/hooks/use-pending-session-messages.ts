"use client"

import { useEffect, useState } from "react"
import {
  listPendingSessionMessages,
  type PendingSessionMessage,
} from "@/lib/api"

/** Observe the persisted queue; never dispatch these messages from the UI. */
export function usePendingSessionMessages(
  conversationId: number | null,
  active: boolean
): PendingSessionMessage[] {
  const [snapshot, setSnapshot] = useState<{
    conversationId: number
    items: PendingSessionMessage[]
  } | null>(null)

  useEffect(() => {
    if (conversationId == null || !active) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try {
        const items = await listPendingSessionMessages(conversationId)
        if (!disposed) {
          setSnapshot((previous) =>
            previous?.conversationId === conversationId &&
            JSON.stringify(previous.items) === JSON.stringify(items)
              ? previous
              : { conversationId, items }
          )
        }
      } catch (error) {
        if (!disposed) console.error("Failed to read session queue", error)
      } finally {
        if (!disposed) timer = setTimeout(refresh, 1000)
      }
    }
    void refresh()
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [conversationId, active])

  return snapshot?.conversationId === conversationId ? snapshot.items : []
}
