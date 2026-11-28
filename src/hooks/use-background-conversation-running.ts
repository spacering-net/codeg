"use client"

import { useSyncExternalStore } from "react"
import { acpListConnections } from "@/lib/api"

/**
 * 没有标签页的连接也要能被侧栏看到。
 *
 * 回合以 `end_turn` 收尾后会话落回待复查，但后台任务还挂在后端连接上；
 * 标签页关掉（或尚未重新挂载）时前端没有该连接，只能靠连接清单里的
 * `background_running` 兜底。所有侧栏行共用一个轮询，避免逐行查询。
 */
const POLL_MS = 5_000

let running: ReadonlySet<number> = new Set()
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null
let polling = false

/** 从连接清单里挑出仍带后台工作的会话。导出以便单测。 */
export function runningConversationIds(
  rows: ReadonlyArray<{
    conversation_id?: number | null
    background_running?: boolean
  }>
): Set<number> {
  const ids = new Set<number>()
  for (const row of rows) {
    if (row.background_running && row.conversation_id != null) {
      ids.add(row.conversation_id)
    }
  }
  return ids
}

function sameSet(a: ReadonlySet<number>, b: ReadonlySet<number>) {
  if (a.size !== b.size) return false
  for (const id of a) if (!b.has(id)) return false
  return true
}

async function refresh() {
  // 页面在后台时少发请求，切回来由下一轮补上。
  if (
    typeof document !== "undefined" &&
    document.visibilityState === "hidden"
  ) {
    return
  }
  if (polling) return
  polling = true
  try {
    const next = runningConversationIds(await acpListConnections())
    if (sameSet(next, running)) return
    running = next
    listeners.forEach((notify) => notify())
  } catch {
    // 轮询失败保留上一轮结果，下一轮再试。
  } finally {
    polling = false
  }
}

function subscribe(notify: () => void) {
  listeners.add(notify)
  if (timer == null) {
    void refresh()
    timer = setInterval(() => void refresh(), POLL_MS)
  }
  return () => {
    listeners.delete(notify)
    if (listeners.size === 0 && timer != null) {
      clearInterval(timer)
      timer = null
    }
  }
}

export function useBackgroundConversationRunning(
  conversationId: number | null
) {
  return useSyncExternalStore(
    subscribe,
    () => conversationId != null && running.has(conversationId),
    () => false
  )
}
