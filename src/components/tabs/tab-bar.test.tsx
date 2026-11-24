import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"

import enMessages from "@/i18n/messages/en.json"
import type { TabItem as TabItemData } from "@/contexts/tab-context"

const h = vi.hoisted(() => ({
  view: {
    mode: "fusion" as "conversation" | "fusion",
    activePane: "conversation" as "conversation" | "files",
    filesMaximized: false,
    conversationMaximized: false,
  },
  isMobile: false,
  toggleConversationMaximized: vi.fn(),
  tabs: [] as TabItemData[],
  groupOf: {} as Record<string, string>,
  visibleLayout: { type: "group", id: "g-main" } as unknown,
  groupLayout: { type: "group", id: "g-main" } as unknown,
  toggleGroupTile: vi.fn(),
  allFolders: [] as never[],
  branches: new Map<number, string>(),
}))

// The strip is a Reorder.Group; the drag machinery is motion's, not ours, and
// none of it is what these tests are about. Strip the motion-only props so the
// rest (role, className, data-*, handlers) still reaches the DOM.
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
  return { Reorder: { Group: passthrough, Item: passthrough } }
})
vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceView: () => h.view,
  useWorkspaceActions: () => ({
    toggleConversationMaximized: h.toggleConversationMaximized,
  }),
}))
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => h.isMobile }))
vi.mock("@/hooks/use-is-coarse-pointer", () => ({
  useIsCoarsePointer: () => false,
}))
vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({ activeFolder: null }),
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({ openConversations: vi.fn() }),
}))
vi.mock("@/stores/app-workspace-store", () => ({
  useAppWorkspaceStore: <T,>(
    selector: (s: { allFolders: never[]; branches: Map<number, string> }) => T
  ) => selector({ allFolders: h.allFolders, branches: h.branches }),
}))
// One group holds every tab: the unsplit layout.
vi.mock("@/stores/tab-store", () => ({
  groupOfTab: (_groups: unknown, _layout: unknown, tabId: string) =>
    h.groupOf[tabId] ?? "g-main",
  useVisibleConversationTabs: () => h.tabs,
  useVisibleConversationLayout: () => h.visibleLayout,
}))
vi.mock("@/contexts/tab-context", () => {
  const store = {
    activeTabId: "conv-1",
    groupOf: {},
    groupLayout: { type: "group", id: "g-main" },
    groupSelection: { "g-main": "conv-1" },
    tileByGroup: {},
    tabDrag: null,
  }
  return {
    useTabActions: () => ({
      switchTab: vi.fn(),
      closeTab: vi.fn(),
      closeOtherTabs: vi.fn(),
      closeAllTabs: vi.fn(),
      pinTab: vi.fn(),
      toggleGroupTile: h.toggleGroupTile,
      splitTab: vi.fn(),
      moveTabToGroup: vi.fn(),
      toggleGroupOrientation: vi.fn(),
      dissolveGroup: vi.fn(),
      unsplitAll: vi.fn(),
      reorderTabs: vi.fn(),
      reorderGroupTabs: vi.fn(),
      updateTabDrag: vi.fn(),
      endTabDrag: vi.fn(),
      openNewConversationTab: vi.fn(),
      openChatModeTab: vi.fn(),
    }),
    useTabStore: <T,>(selector: (s: Record<string, unknown>) => T) =>
      selector({ ...store, groupLayout: h.groupLayout, tabs: h.tabs }),
  }
})
// The tab itself is not what these tests are about.
vi.mock("./tab-item", () => ({
  TabItem: ({
    tab,
    onToggleTile,
    isSplit,
    moveTargets,
  }: {
    tab: TabItemData
    onToggleTile: () => void
    isSplit: boolean
    moveTargets: { groupId: string }[]
  }) => (
    <div
      data-tab-id={tab.id}
      data-split={String(isSplit)}
      data-move-targets={moveTargets.map((target) => target.groupId).join(",")}
    >
      {tab.title}
      <button onClick={onToggleTile}>Tile</button>
    </div>
  ),
}))

import { TabBar } from "./tab-bar"
import {
  resetFolderTabsStore,
  useFolderTabsStore,
} from "@/stores/folder-tabs-store"

function conversationTab(id: string): TabItemData {
  return {
    id,
    kind: "conversation",
    folderId: 1,
    conversationId: 1,
    agentType: "claude_code",
    title: id,
    isPinned: false,
  }
}

function renderStrip(props: Parameters<typeof TabBar>[0] = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TabBar {...props} />
    </NextIntlClientProvider>
  )
}

const maximizeButton = () => screen.queryByRole("button", { name: "Maximize" })
const restoreButton = () => screen.queryByRole("button", { name: "Restore" })

beforeEach(() => {
  h.view = {
    mode: "fusion",
    activePane: "conversation",
    filesMaximized: false,
    conversationMaximized: false,
  }
  h.isMobile = false
  h.groupOf = {}
  h.visibleLayout = { type: "group", id: "g-main" }
  h.groupLayout = { type: "group", id: "g-main" }
  h.toggleGroupTile.mockClear()
  h.tabs = [conversationTab("conv-1")]
  h.toggleConversationMaximized.mockClear()
})

describe("TabBar — maximize/restore", () => {
  it("maximizes the conversation column from the unsplit strip beside a file column", () => {
    renderStrip({ maximizeControl: true })
    const button = maximizeButton()
    expect(button).not.toBeNull()
    expect(button).toHaveAttribute("aria-pressed", "false")
    // The file strip's glyphs: outward arrows to maximize, inward to restore.
    expect(button!.querySelector("svg.lucide-maximize-2")).not.toBeNull()
    expect(button!.querySelector("svg.lucide-minimize-2")).toBeNull()
    fireEvent.click(button!)
    expect(h.toggleConversationMaximized).toHaveBeenCalledTimes(1)
  })

  it("reads Restore, pressed, while the conversation is maximized", () => {
    h.view.conversationMaximized = true
    renderStrip({ maximizeControl: true })
    expect(maximizeButton()).toBeNull()
    const button = restoreButton()
    expect(button).toHaveAttribute("aria-pressed", "true")
    expect(button!.querySelector("svg.lucide-minimize-2")).not.toBeNull()
    expect(button!.querySelector("svg.lucide-maximize-2")).toBeNull()
    fireEvent.click(button!)
    expect(h.toggleConversationMaximized).toHaveBeenCalledTimes(1)
  })

  // Like the file strip's: with no file column there is nothing to cover.
  it("is not offered without a file column", () => {
    h.view.mode = "conversation"
    renderStrip({ maximizeControl: true })
    expect(maximizeButton()).toBeNull()
    expect(restoreButton()).toBeNull()
  })

  // The column has one button: while split only the top-right group's strip
  // (the one the panel passes the control to) carries it.
  it("appears only on the strip given the control", () => {
    const other = renderStrip({ groupId: "g-main" })
    expect(maximizeButton()).toBeNull()
    other.unmount()

    renderStrip({ groupId: "g-main", maximizeControl: true })
    expect(maximizeButton()).not.toBeNull()
  })

  it("is not offered on mobile, which shows one pane at a time", () => {
    h.isMobile = true
    renderStrip({ maximizeControl: true })
    expect(maximizeButton()).toBeNull()
  })

  // Same arrangement as the file strip: tabs, then the new-tab button, the
  // window-drag spacer, and maximize flush right.
  it("sits flush right, after the drag spacer", () => {
    renderStrip({ maximizeControl: true })
    const button = maximizeButton()!
    expect(button.nextElementSibling).toBeNull()
    const spacer = button.previousElementSibling
    expect(spacer).toHaveAttribute("data-tauri-drag-region")
    expect(spacer?.previousElementSibling).toBe(
      screen.getByRole("button", { name: "New Conversation" })
    )
  })
})

it("targets the actual visible group when the projected strip is unsplit", () => {
  h.groupOf = { "conv-1": "g-second" }
  renderStrip()
  fireEvent.click(screen.getByRole("button", { name: "Tile" }))
  expect(h.toggleGroupTile).toHaveBeenCalledWith("g-second")
})

// Tabs follow the folder: the strip takes its groups from the on-screen view
// (`useVisibleConversationLayout`), not the store's raw layout, which can still
// hold another folder's groups before the tab set is known. Groups that are
// not on screen are no move targets, and the strip offers no split-only
// actions.
it("offers only on-screen groups as split targets", () => {
  h.groupLayout = {
    type: "split",
    id: "s",
    orientation: "horizontal",
    ratios: [0.5, 0.5],
    children: [
      { type: "group", id: "g-main" },
      { type: "group", id: "g-other-worktree" },
    ],
  }
  h.visibleLayout = { type: "group", id: "g-main" }
  renderStrip()
  const tab = document.querySelector('[data-tab-id="conv-1"]')!
  expect(tab).toHaveAttribute("data-split", "false")
  expect(tab).toHaveAttribute("data-move-targets", "")
})

it("lists every on-screen group while the visible layout is split", () => {
  h.visibleLayout = {
    type: "split",
    id: "s",
    orientation: "horizontal",
    ratios: [0.5, 0.5],
    children: [
      { type: "group", id: "g-main" },
      { type: "group", id: "g-second" },
    ],
  }
  renderStrip({ groupId: "g-main" })
  const tab = document.querySelector('[data-tab-id="conv-1"]')!
  expect(tab).toHaveAttribute("data-split", "true")
  expect(tab).toHaveAttribute("data-move-targets", "g-second")
})

describe("TabBar — tabs follow the folder", () => {
  afterEach(() => resetFolderTabsStore())
  const newConversation = () =>
    screen.queryByRole("button", { name: "New Conversation" })

  it("keeps the unsplit strip and its new-conversation button for a folder with nothing open", () => {
    h.tabs = []
    act(() => useFolderTabsStore.setState({ enabled: true, scope: 1 }))
    renderStrip({ maximizeControl: true })
    expect(newConversation()).not.toBeNull()
    // Nothing on screen to maximize over the file column.
    expect(maximizeButton()).toBeNull()
  })

  it("still renders nothing for an empty strip in normal mode, or an empty split group", () => {
    h.tabs = []
    const normal = renderStrip()
    expect(newConversation()).toBeNull()
    normal.unmount()
    act(() => useFolderTabsStore.setState({ enabled: true, scope: 1 }))
    renderStrip({ groupId: "g-main" })
    expect(newConversation()).toBeNull()
  })
})
