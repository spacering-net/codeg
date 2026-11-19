import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { useTabStore, type TabItem } from "@/stores/tab-store"
import { useConversationConnectionKey } from "./use-conversation-connection-key"

function convTab(id: string, conversationId: number, folderId = 1): TabItem {
  return {
    id,
    kind: "conversation",
    folderId,
    conversationId,
    agentType: "claude_code",
    title: "",
    isPinned: false,
  } as TabItem
}

function setTabs(tabs: TabItem[]) {
  act(() => {
    useTabStore.setState({ tabs })
  })
}

afterEach(() => {
  useTabStore.setState({ tabs: [] })
})

describe("会话连接键解析", () => {
  it("没开过 tab 时用规范 tab id", () => {
    const { result } = renderHook(() =>
      useConversationConnectionKey(1, "claude_code", 901)
    )
    expect(result.current).toBe("conv-1-claude_code-901")
  })

  it("草稿绑定的 tab 关掉后仍沿用它的 new-* id（忙碌连接还挂在上面）", () => {
    setTabs([convTab("new-draft-902", 902)])
    const { result, unmount } = renderHook(() =>
      useConversationConnectionKey(1, "claude_code", 902)
    )
    expect(result.current).toBe("new-draft-902")

    setTabs([])
    expect(result.current).toBe("new-draft-902")

    // 侧栏是虚拟列表：行滚出再滚回会重新挂载，键不能丢。
    unmount()
    const remounted = renderHook(() =>
      useConversationConnectionKey(1, "claude_code", 902)
    )
    expect(remounted.result.current).toBe("new-draft-902")
  })

  it("没有任何卡片挂载期间开关的 tab 也记得（侧栏折叠时不渲染卡片）", () => {
    setTabs([convTab("new-draft-905", 905)])
    setTabs([])
    const { result } = renderHook(() =>
      useConversationConnectionKey(1, "claude_code", 905)
    )
    expect(result.current).toBe("new-draft-905")
  })

  it("移动后的会话关掉 tab 仍用旧文件夹的 id", () => {
    setTabs([convTab("conv-1-claude_code-903", 903)])
    const { result } = renderHook(() =>
      useConversationConnectionKey(2, "claude_code", 903)
    )
    expect(result.current).toBe("conv-1-claude_code-903")
    setTabs([])
    expect(result.current).toBe("conv-1-claude_code-903")
  })

  it("重新打开时改用新 tab 的 id", () => {
    setTabs([convTab("new-draft-904", 904)])
    const { result } = renderHook(() =>
      useConversationConnectionKey(1, "claude_code", 904)
    )
    setTabs([])
    setTabs([convTab("conv-1-claude_code-904", 904)])
    expect(result.current).toBe("conv-1-claude_code-904")
    setTabs([])
    expect(result.current).toBe("conv-1-claude_code-904")
  })
})
