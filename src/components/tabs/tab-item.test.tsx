import { type ReactNode } from "react"
import { cleanup, render } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { TabItem as TabItemData } from "@/contexts/tab-context"
import type { BlockingPromptKind } from "@/lib/blocking-prompts"
import enMessages from "@/i18n/messages/en.json"

// 这条标签页的等待状态来自连接 store；本次只验证「标记怎么说清原因」，
// 所以直接把那个 hook 的值换成测试用的等待种类。
const h = vi.hoisted(() => ({
  awaiting: null as BlockingPromptKind | null,
}))

// 拖动机制是 motion 的，不是这里要验证的东西：保留 role / data-* / 事件，
// 丢掉只对 motion 有意义的属性。`useDragControls` 同样给个空实现。
vi.mock("motion/react", () => {
  const MOTION_ONLY = new Set([
    "as",
    "values",
    "onReorder",
    "axis",
    "drag",
    "dragControls",
    "dragListener",
    "whileDrag",
    "value",
    "onLayoutAnimationComplete",
  ])
  const passthrough = ({
    children,
    ...rest
  }: Record<string, unknown> & { children?: ReactNode }) => (
    <div
      {...Object.fromEntries(
        Object.entries(rest).filter(([key]) => !MOTION_ONLY.has(key))
      )}
    >
      {children}
    </div>
  )
  return {
    Reorder: { Group: passthrough, Item: passthrough },
    useDragControls: () => ({ start: () => {} }),
  }
})

vi.mock("@/hooks/use-conversation-attention", () => ({
  useAwaitingAnswer: () => h.awaiting,
}))

import { TabItem } from "./tab-item"

const noop = () => {}

function conversationTab(): TabItemData {
  return {
    id: "conv-1",
    kind: "conversation",
    folderId: 1,
    conversationId: 1,
    agentType: "claude_code",
    title: "Refactor the parser",
    isPinned: false,
  }
}

function renderTab() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TabItem
        tab={conversationTab()}
        isActive={false}
        isTileMode={false}
        folderName="repo"
        folderBranch="main"
        isSplit={false}
        canSplitMove={false}
        canMoveToGroup={false}
        moveTargets={[]}
        onSwitch={noop}
        onClose={noop}
        onCloseOthers={noop}
        onCloseAll={noop}
        onPin={noop}
        onToggleTile={noop}
        onSplit={noop}
        onMoveToGroup={noop}
        onToggleSplitOrientation={noop}
        onUnsplit={noop}
        onUnsplitAll={noop}
        isCoarsePointer={false}
        isTouchSorting={false}
        onTouchSortingStart={noop}
        onTouchSortingEnd={noop}
      />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  h.awaiting = null
})

afterEach(cleanup)

describe("TabItem awaiting-answer mark", () => {
  it("says in a tooltip WHICH decision the tab is parked on", () => {
    // 标签页只有一个状态点，没有文案的位置；悬停标题上原本只有文件夹、分支和
    // 标题，说不出"在等什么"。三种原因复用侧栏已有的翻译，不新增文案。
    for (const [kind, label] of [
      ["permission", "Needs your permission"],
      ["question", "Needs your answer"],
      ["plan", "Needs your approval"],
    ] as const) {
      h.awaiting = kind
      const view = renderTab()
      const dot = view.container.querySelector("[data-attention]")
      expect(dot?.getAttribute("data-attention")).toBe(kind)
      expect(dot?.getAttribute("title")).toBe(label)
      // 带上文案就不再是纯装饰，不能被无障碍树隐藏。
      expect(dot?.getAttribute("aria-hidden")).toBeNull()
      view.unmount()
    }
  })

  it("leaves an idle tab's dot silent", () => {
    const view = renderTab()
    expect(view.container.querySelector("[data-attention]")).toBeNull()
    // 标题自身的悬停提示仍然在（空白会被规范化，所以按正则匹配），且没有多出
    // 任何等待原因。
    expect(
      view.getByTitle(/repo · main\s+—\s+Refactor the parser/)
    ).toBeTruthy()
    expect(view.queryByTitle("Needs your permission")).toBeNull()
    expect(view.queryByTitle("Needs your answer")).toBeNull()
    expect(view.queryByTitle("Needs your approval")).toBeNull()
  })
})
