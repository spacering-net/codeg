import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type {
  ConnectionState,
  ConnectionStoreApi,
} from "@/contexts/acp-connections-context"
import { useConnectionWaiting } from "./use-connection-waiting"

type PendingConnectionPatch = Partial<
  Pick<
    ConnectionState,
    | "pendingPermission"
    | "pendingQuestion"
    | "pendingAskQuestion"
    | "pendingPlanApproval"
  >
>

const fake = vi.hoisted(() => {
  const connections = new Map<string, ConnectionState>()
  const listeners = new Map<string, Set<() => void>>()
  return {
    connections,
    listeners,
    enabled: true,
    store: {
      getConnection: (key: string) => connections.get(key),
      subscribeKey: (key: string, notify: () => void) => {
        const subscribers = listeners.get(key) ?? new Set<() => void>()
        subscribers.add(notify)
        listeners.set(key, subscribers)
        return () => subscribers.delete(notify)
      },
    } as unknown as ConnectionStoreApi,
  }
})

vi.mock("@/contexts/acp-connections-context", () => ({
  useOptionalConnectionStore: () => (fake.enabled ? fake.store : null),
}))

function connection(patch: PendingConnectionPatch = {}): ConnectionState {
  return {
    pendingPermission: null,
    pendingQuestion: null,
    pendingAskQuestion: null,
    pendingPlanApproval: null,
    ...patch,
  } as unknown as ConnectionState
}

function update(key: string, next: ConnectionState) {
  act(() => {
    fake.connections.set(key, next)
    fake.listeners.get(key)?.forEach((notify) => notify())
  })
}

beforeEach(() => {
  fake.connections.clear()
  fake.listeners.clear()
  fake.enabled = true
})

describe("会话待处理订阅", () => {
  const pendingCases: [string, PendingConnectionPatch][] = [
    [
      "权限请求",
      {
        pendingPermission: {
          request_id: "permission-1",
          tool_call: {},
          options: [],
        },
      },
    ],
    [
      "提问",
      {
        pendingQuestion: {
          tool_call_id: "tool-1",
          question: "是否继续？",
        },
      },
    ],
    [
      "多选提问",
      {
        pendingAskQuestion: {
          question_id: "question-1",
          questions: [],
          created_at: "2026-11-16T00:00:00Z",
        },
      },
    ],
    [
      "计划审批",
      {
        pendingPlanApproval: {
          approval_id: "approval-1",
          tool_call_id: "tool-1",
          plan_markdown: "执行计划",
          created_at: "2026-11-16T00:00:00Z",
        },
      },
    ],
  ]

  it.each(pendingCases)("%s 显示为待处理，完成后恢复", (_name, pending) => {
    update("first", connection())
    const { result } = renderHook(() => useConnectionWaiting("first"))
    expect(result.current).toBe(false)

    update("first", connection(pending))
    expect(result.current).toBe(true)

    update("first", connection())
    expect(result.current).toBe(false)
  })

  it("只在当前会话的待处理状态变化时重绘", () => {
    update("first", connection())
    let renders = 0
    const { result } = renderHook(() => {
      renders++
      return useConnectionWaiting("first")
    })
    const initialRenders = renders

    update("first", connection({ pendingPermission: null }))
    update(
      "other",
      connection({
        pendingQuestion: {
          tool_call_id: "tool-2",
          question: "另一个会话的问题",
        },
      })
    )
    expect(renders).toBe(initialRenders)

    update(
      "first",
      connection({
        pendingQuestion: {
          tool_call_id: "tool-1",
          question: "是否继续？",
        },
      })
    )
    expect(result.current).toBe(true)
    expect(renders).toBe(initialRenders + 1)
  })

  it("无连接上下文时按未待处理显示", () => {
    fake.enabled = false
    const { result } = renderHook(() => useConnectionWaiting("first"))
    expect(result.current).toBe(false)
  })
})
