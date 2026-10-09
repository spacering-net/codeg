import { act, render } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"

import enMessages from "@/i18n/messages/en.json"
import type { TabItem as TabItemData } from "@/contexts/tab-context"
import type { TabAttentionKind } from "@/lib/tab-arrangement"
import { singleGroupLayout } from "@/lib/tab-group-layout"
import { useTabArrangeStore } from "@/stores/tab-arrangement-store"

const mocks = vi.hoisted(() => ({
  tabs: [] as TabItemData[],
  activeTabId: null as string | null,
  attention: new Map() as ReadonlyMap<string, TabAttentionKind>,
}))

// The strip is a Reorder.Group; motion's drag machinery is not what these
// tests are about. Strip the motion-only props so the rest reaches the DOM.
vi.mock("motion/react", () => {
  const MOTION_ONLY = new Set(["as", "values", "onReorder", "axis"])
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
  return { Reorder: { Group: passthrough, Item: passthrough } }
})

// Only a tab's slot in the strip matters here: stand it in with a bare
// element carrying the id the strip's reveal looks up.
vi.mock("./tab-item", () => ({
  TabItem: ({ tab }: { tab: TabItemData }) => (
    <div data-tab-id={tab.id}>{tab.title}</div>
  ),
}))

vi.mock("@/contexts/tab-context", () => {
  const state = () => ({
    tabs: mocks.tabs,
    activeTabId: mocks.activeTabId,
    groupOf: {},
    groupLayout: singleGroupLayout(),
    groupSelection: {},
    tileByGroup: {},
    tabDrag: null,
  })
  return {
    useTabStore: (select: (s: ReturnType<typeof state>) => unknown) =>
      select(state()),
    useTabActions: () => ({}),
  }
})
vi.mock("@/stores/tab-store", () => ({ groupOfTab: () => null }))
vi.mock("@/stores/app-workspace-store", () => ({
  useAppWorkspaceStore: (
    select: (s: {
      allFolders: unknown[]
      branches: Map<number, string>
    }) => unknown
  ) =>
    select({
      allFolders: [
        { id: 1, name: "api", alias: null, color: "blue", kind: "folder" },
        { id: 2, name: "web", alias: null, color: "green", kind: "folder" },
      ],
      branches: new Map(),
    }),
}))
vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({ activeFolder: null }),
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({ openConversations: vi.fn() }),
}))
vi.mock("@/hooks/use-is-coarse-pointer", () => ({
  useIsCoarsePointer: () => false,
}))
vi.mock("@/hooks/use-tab-attention", () => ({
  useTabAttention: () => mocks.attention,
}))

import { TabBar } from "./tab-bar"

function tab(
  id: string,
  folderId: number,
  status?: TabItemData["status"]
): TabItemData {
  return {
    id,
    kind: "conversation",
    folderId,
    conversationId: Number(id.replace(/\D/g, "")) || 1,
    agentType: "custom:test-agent",
    title: `Tab ${id}`,
    isPinned: false,
    status,
  }
}

function strip() {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TabBar />
    </NextIntlClientProvider>
  )
}

/** Render the strip; `rerenderStrip` re-renders it after the mocked stores
 *  change (a fresh element, so React doesn't bail out on it). */
function renderStrip() {
  const view = render(strip())
  return { ...view, rerenderStrip: () => view.rerender(strip()) }
}

/** Ids of the tabs the strip scrolled into view, in call order. */
let revealed: (string | null)[] = []
const originalScrollIntoView = Element.prototype.scrollIntoView

beforeEach(() => {
  revealed = []
  Element.prototype.scrollIntoView = function (this: Element) {
    revealed.push(this.getAttribute("data-tab-id"))
  }
  window.localStorage.clear()
  useTabArrangeStore.setState({ mode: "manual", hydrated: true })
  mocks.attention = new Map()
})

afterEach(() => {
  Element.prototype.scrollIntoView = originalScrollIntoView
})

function stripOrder(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll("[data-tab-id], [data-tab-group-label]")
  ).map(
    (el) =>
      el.getAttribute("data-tab-id") ??
      `label:${el.getAttribute("data-tab-group-label")}`
  )
}

function lastSlot(container: HTMLElement): string | undefined {
  const order = stripOrder(container)
  return order[order.length - 1]
}

describe("TabBar keeps the active tab in view", () => {
  it("reveals the active tab when a new arrangement moves it", () => {
    mocks.tabs = [tab("t1", 1), tab("t2", 2), tab("t3", 1)]
    mocks.activeTabId = "t2"
    const { container } = renderStrip()
    expect(revealed).toEqual(["t2"])
    revealed = []

    // Same active id, new slot: t2 moves behind t3 and two group labels.
    act(() => useTabArrangeStore.getState().setMode("folder"))
    expect(stripOrder(container)).toEqual([
      "label:folder-1",
      "t1",
      "t3",
      "label:folder-2",
      "t2",
    ])
    expect(revealed).toEqual(["t2"])
    revealed = []

    act(() => useTabArrangeStore.getState().setMode("manual"))
    expect(stripOrder(container)).toEqual(["t1", "t2", "t3"])
    expect(revealed).toEqual(["t2"])
  })

  it("reveals the active tab when its status band moves it", () => {
    useTabArrangeStore.setState({ mode: "status", hydrated: true })
    mocks.tabs = [
      tab("t1", 1, "in_progress"),
      tab("t2", 1, "completed"),
      tab("t3", 2, "pending_review"),
    ]
    mocks.activeTabId = "t2"
    const { container, rerenderStrip } = renderStrip()
    expect(lastSlot(container)).toBe("t2")
    revealed = []

    // Another tab's band changes but the active tab keeps its slot: no scroll.
    mocks.attention = new Map<string, TabAttentionKind>([["t1", "permission"]])
    rerenderStrip()
    expect(lastSlot(container)).toBe("t2")
    expect(revealed).toEqual([])

    // The active tab now waits on the user: it jumps to the front band.
    mocks.attention = new Map<string, TabAttentionKind>([["t2", "question"]])
    rerenderStrip()
    expect(stripOrder(container).slice(0, 2)).toEqual([
      "label:status-needs_you",
      "t2",
    ])
    expect(revealed).toEqual(["t2"])
  })

  it("leaves manual order to the user's own drag", () => {
    mocks.tabs = [tab("t1", 1), tab("t2", 1), tab("t3", 1)]
    mocks.activeTabId = "t2"
    const { container, rerenderStrip } = renderStrip()
    revealed = []

    // A drag reorders the manual order underneath the active tab: the strip
    // must not scroll mid-gesture.
    mocks.tabs = [mocks.tabs[1], mocks.tabs[0], mocks.tabs[2]]
    rerenderStrip()
    expect(stripOrder(container)).toEqual(["t2", "t1", "t3"])
    expect(revealed).toEqual([])
  })
})
