import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ThreadRenderItem } from "./message-list-view"
import { useConversationSearchJump } from "./use-conversation-search-jump"
import {
  requestConversationSearchJump,
  useConversationSearchStore,
} from "@/stores/conversation-search-store"

function items(...ids: string[]): ThreadRenderItem[] {
  return ids.map((id) => ({
    kind: "turn",
    group: { id },
    sourceTurns: [{ id }],
  })) as ThreadRenderItem[]
}

function setup(initialItems: ThreadRenderItem[], enabled = true) {
  const scrollToIndex = vi.fn()
  let resolvePage!: (reached: boolean) => void
  const loadOlderTurnsThrough = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        resolvePage = resolve
      })
  )
  const onUnavailable = vi.fn()
  const scrollApiRef = {
    current: { scrollToIndex, revealFromAbove: vi.fn() },
  }
  const hook = renderHook(
    (props: { threadItems: ThreadRenderItem[]; enabled: boolean }) =>
      useConversationSearchJump({
        ...props,
        conversationId: -42,
        dbConversationId: 42,
        scrollApiRef,
        loadOlderTurnsThrough,
        onUnavailable,
      }),
    { initialProps: { threadItems: initialItems, enabled } }
  )
  return {
    ...hook,
    scrollToIndex,
    loadOlderTurnsThrough,
    onUnavailable,
    resolvePage: (reached: boolean) => resolvePage(reached),
  }
}

beforeEach(() => useConversationSearchStore.setState({ target: null }))

describe("搜索结果定位", () => {
  it("等待会话加载后定位已加载消息，并消费请求", async () => {
    requestConversationSearchJump(42, { turn_id: "turn-12", turn_index: 12 })
    const { result, rerender, scrollToIndex, loadOlderTurnsThrough } = setup(
      items("turn-11", "turn-12"),
      false
    )
    expect(scrollToIndex).not.toHaveBeenCalled()
    rerender({ threadItems: items("turn-11", "turn-12"), enabled: true })
    await waitFor(() =>
      expect(scrollToIndex).toHaveBeenCalledWith(1, {
        align: "start",
        smooth: false,
      })
    )
    expect(loadOlderTurnsThrough).not.toHaveBeenCalled()
    expect(result.current.highlightedTarget?.turnId).toBe("turn-12")
    expect(useConversationSearchStore.getState().target).toBeNull()
  })

  it("将合并助手回复的子消息定位到其所在行", async () => {
    requestConversationSearchJump(42, { turn_id: "turn-13", turn_index: 13 })
    const merged = items("turn-12")
    merged[0] = {
      ...merged[0],
      sourceTurns: [{ id: "turn-12" }, { id: "turn-13" }],
    } as ThreadRenderItem
    const { scrollToIndex } = setup(merged)
    await waitFor(() =>
      expect(scrollToIndex).toHaveBeenCalledWith(0, {
        align: "start",
        smooth: false,
      })
    )
  })

  it("先加载较早消息，再等待渲染后滚动", async () => {
    requestConversationSearchJump(42, { turn_id: "turn-2", turn_index: 2 })
    const { rerender, scrollToIndex, loadOlderTurnsThrough, resolvePage } =
      setup(items("turn-90"))
    await waitFor(() =>
      expect(loadOlderTurnsThrough).toHaveBeenCalledWith(-42, 2)
    )
    rerender({ threadItems: items("turn-2", "turn-90"), enabled: true })
    await act(async () => resolvePage(true))
    await waitFor(() =>
      expect(scrollToIndex).toHaveBeenCalledWith(0, {
        align: "start",
        smooth: false,
      })
    )
  })

  it("不会消费其他会话的定位请求", async () => {
    requestConversationSearchJump(99, { turn_id: "turn-2", turn_index: 2 })
    const { scrollToIndex, loadOlderTurnsThrough } = setup(items("turn-2"))
    await act(async () => {})
    expect(scrollToIndex).not.toHaveBeenCalled()
    expect(loadOlderTurnsThrough).not.toHaveBeenCalled()
    expect(useConversationSearchStore.getState().target?.conversationId).toBe(
      99
    )
  })

  it("按消息角色区分相同 id，避免跳到另一方的消息", async () => {
    requestConversationSearchJump(42, {
      turn_id: "shared",
      turn_index: 0,
      role: "user",
    })
    const shared = items("shared", "shared")
    for (let i = 0; i < shared.length; i++) {
      const item = shared[i]
      if (item.kind === "turn") {
        item.group.role = i === 0 ? "user" : "assistant"
      }
    }
    const { scrollToIndex } = setup(shared)
    await waitFor(() =>
      expect(scrollToIndex).toHaveBeenCalledWith(0, {
        align: "start",
        smooth: false,
      })
    )
  })

  it("历史消息无法加载时提示失败并消费请求", async () => {
    requestConversationSearchJump(42, { turn_id: "missing", turn_index: 2 })
    const { resolvePage, onUnavailable, scrollToIndex } = setup(
      items("turn-90")
    )
    await act(async () => resolvePage(false))
    await waitFor(() => expect(onUnavailable).toHaveBeenCalledTimes(1))
    expect(scrollToIndex).not.toHaveBeenCalled()
    expect(useConversationSearchStore.getState().target).toBeNull()
  })
})
