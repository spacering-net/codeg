import { act, fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { AuxPanelTab } from "@/lib/aux-panel-tab-order"

// jsdom has no layout, so Motion can never decide that a dragged tab crossed
// its neighbour. The fake keeps the wiring that matters here — the order the
// group reports while a drag is live, and the release that ends it — and hands
// both to the test to drive.
const motion = vi.hoisted(() => ({
  onReorder: null as ((next: unknown[]) => void) | null,
  dragStart: new Map<string, () => void>(),
  dragEnd: new Map<string, () => void>(),
}))
vi.mock("motion/react", async () => {
  const { useLayoutEffect } = await import("react")
  const MOTION_ONLY = new Set([
    "as",
    "axis",
    "values",
    "onReorder",
    "value",
    "drag",
    "layout",
    "whileDrag",
    "onDragStart",
    "onDragEnd",
  ])
  const domProps = (props: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(props).filter(([key]) => !MOTION_ONLY.has(key))
    )
  function Group(
    props: Record<string, unknown> & {
      children?: ReactNode
      onReorder: (next: unknown[]) => void
    }
  ) {
    const { onReorder } = props
    useLayoutEffect(() => {
      motion.onReorder = onReorder
    })
    return <div {...domProps(props)}>{props.children}</div>
  }
  function Item(
    props: Record<string, unknown> & {
      children?: ReactNode
      value: string
      onDragStart: () => void
      onDragEnd: () => void
    }
  ) {
    const { value, onDragStart, onDragEnd } = props
    useLayoutEffect(() => {
      motion.dragStart.set(value, onDragStart)
      motion.dragEnd.set(value, onDragEnd)
    })
    return <div {...domProps(props)}>{props.children}</div>
  }
  return { Reorder: { Group, Item } }
})

// The tab bodies are whole subsystems of their own; only which one shows
// matters here.
vi.mock("./aux-panel-session-details-tab", () => ({
  SessionDetailsTab: () => <div data-testid="body-session_details" />,
}))
vi.mock("./aux-panel-file-tree-tab", () => ({
  FileTreeTab: () => <div data-testid="body-file_tree" />,
}))
vi.mock("./aux-panel-git-changes-tab", () => ({
  GitChangesTab: () => <div data-testid="body-changes" />,
}))
vi.mock("./aux-panel-git-log-tab", () => ({
  GitLogTab: () => <div data-testid="body-git_log" />,
}))
vi.mock("./aux-panel-automations-tab", () => ({
  AutomationsAuxTab: () => <div data-testid="body-automations" />,
}))
vi.mock("./aux-panel-tasks-tab", () => ({
  TasksAuxTab: () => <div data-testid="body-tasks" />,
}))
vi.mock("./aux-panel-forge-tab", () => ({
  ForgeAuxTab: ({ auxTab, forgeTab }: { auxTab: string; forgeTab: string }) => (
    <div data-testid={`body-${auxTab}`} data-forge-tab={forgeTab} />
  ),
}))

const scene = vi.hoisted(() => ({
  isOpen: true,
  initialTab: "session_details" as AuxPanelTab,
  folderId: 1 as number | null,
  chatMode: false,
  mobile: false,
  /** The forge the project's remote resolves to. */
  provider: null as "github" | "gitlab" | "gitea" | null,
  /** Every folder the panel asked the forge lookup about, in order. */
  providerAsked: [] as (number | null)[],
}))
// A live selection and open state, so a press on the rail really switches the
// panel, and a click that closes it really does.
vi.mock("@/contexts/aux-panel-context", async () => {
  const { useCallback, useState } = await import("react")
  return {
    useAuxPanelContext: () => {
      const [activeTab, setTab] = useState<AuxPanelTab>(scene.initialTab)
      const [isOpen, setIsOpen] = useState(scene.isOpen)
      const setActiveTab = useCallback((tab: AuxPanelTab) => setTab(tab), [])
      const setOpen = useCallback((open: boolean) => setIsOpen(open), [])
      return { isOpen, activeTab, setActiveTab, setOpen }
    },
  }
})
vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({ activeFolderId: scene.folderId }),
}))
vi.mock("@/hooks/use-is-active-chat-mode", () => ({
  useIsActiveChatMode: () => scene.chatMode,
}))
// The active folder is its own project here: no worktrees in this scene.
vi.mock("@/hooks/use-active-project-folder", () => ({
  useActiveProjectFolderId: () => scene.folderId,
}))
vi.mock("@/lib/forge-provider-cache", () => ({
  useFolderForgeProvider: (folderId: number | null) => {
    scene.providerAsked.push(folderId)
    return folderId == null ? null : scene.provider
  },
}))
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => scene.mobile }))
vi.mock("@/hooks/use-platform", () => ({
  usePlatform: () => ({ isMac: true, isWindows: false, isLinux: false }),
}))
vi.mock("@/hooks/use-appearance", () => ({
  useZoomLevel: () => ({ zoomLevel: 100 }),
}))

import enMessages from "@/i18n/messages/en.json"
import { resetAuxTabOrderCacheForTests } from "@/lib/aux-panel-tab-order"
import { RIGHT_CHROME_CLUSTER } from "@/lib/window-chrome"

import { AuxPanel, resolveAuxTabView } from "./aux-panel"

const KEY = "workspace:right-sidebar-tab-order"

/** The rail in the built-in order, by name. */
const BUILT_IN = [
  "Session Details",
  "Files",
  "Changes",
  "Commits",
  "Automations",
  "To-dos",
  "Issues",
  "Pull requests",
]

/** A full custom order, and the same order by name. */
const REVERSED: AuxPanelTab[] = [
  "pull_requests",
  "issues",
  "tasks",
  "automations",
  "git_log",
  "changes",
  "file_tree",
  "session_details",
]
const REVERSED_NAMES = [...BUILT_IN].reverse()

function renderPanel() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <AuxPanel />
    </NextIntlClientProvider>
  )
}

function rail(): HTMLElement {
  const el = document.querySelector<HTMLElement>("[data-aux-tab-rail]")
  if (!el) throw new Error("no tab rail rendered")
  return el
}

/** The rail's tabs, top to bottom, by name. */
function railTabs(): string[] {
  return within(rail())
    .getAllByRole("tab", { hidden: true })
    .map((tab) => tab.getAttribute("aria-label") ?? "")
}

const storedOrder = () => JSON.parse(localStorage.getItem(KEY) ?? "null")

/** What another window writing the key looks like from this one. */
function writeFromAnotherWindow(value: unknown) {
  localStorage.setItem(KEY, JSON.stringify(value))
  window.dispatchEvent(
    new StorageEvent("storage", { key: KEY, newValue: JSON.stringify(value) })
  )
}

describe("resolveAuxTabView", () => {
  it("shows all tabs and keeps the selection in a folder workspace", () => {
    expect(resolveAuxTabView("file_tree", 1, false)).toEqual({
      showFolderTabs: true,
      effectiveTab: "file_tree",
    })
    expect(resolveAuxTabView("session_details", 1, false)).toEqual({
      showFolderTabs: true,
      effectiveTab: "session_details",
    })
  })

  it("collapses to Session Details in chat mode, even with a bound folder", () => {
    // A bound chat conversation has a (hidden) folder id but is chat mode.
    expect(resolveAuxTabView("git_log", 1, true)).toEqual({
      showFolderTabs: false,
      effectiveTab: "session_details",
    })
  })

  it("collapses to Session Details when no folder is open", () => {
    expect(resolveAuxTabView("changes", null, false)).toEqual({
      showFolderTabs: false,
      effectiveTab: "session_details",
    })
  })

  it("overrides a stale folder-tab selection with a valid shown tab", () => {
    // Stored selection is a folder tab but folder tabs are hidden: the shown
    // tab must fall back so Radix never points at a triggerless value.
    expect(resolveAuxTabView("file_tree", null, false).effectiveTab).toBe(
      "session_details"
    )
  })
})

describe("AuxPanel", () => {
  beforeEach(() => {
    localStorage.clear()
    resetAuxTabOrderCacheForTests()
    Object.assign(scene, {
      isOpen: true,
      initialTab: "session_details",
      folderId: 1,
      chatMode: false,
      mobile: false,
      provider: null,
      providerAsked: [],
    })
    motion.onReorder = null
    motion.dragStart.clear()
    motion.dragEnd.clear()
  })

  it("renders nothing while closed", () => {
    scene.isOpen = false
    const { container } = renderPanel()
    expect(container).toBeEmptyDOMElement()
  })

  it("lists every tab on the vertical rail, in the built-in order by default", () => {
    renderPanel()
    expect(railTabs()).toEqual(BUILT_IN)
    expect(rail()).toHaveAttribute("role", "tablist")
    expect(rail()).toHaveAttribute("aria-orientation", "vertical")
    expect(rail()).toBeVisible()
  })

  it("titles the strip with the selected tab where the tabs used to be", () => {
    scene.initialTab = "git_log"
    renderPanel()
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
      "Commits"
    )
    // The strip no longer hosts a tab switcher of its own.
    expect(screen.getAllByRole("tablist")).toHaveLength(1)
  })

  it("keeps the title clear of the window-chrome overlay", () => {
    renderPanel()
    const strip = screen.getByRole("heading", { level: 2 }).parentElement
    const reserve = strip?.querySelector<HTMLElement>(".chrome-reserve")
    expect(reserve?.style.width).toBe(`${RIGHT_CHROME_CLUSTER}px`)
    expect(screen.getByRole("heading", { level: 2 })).toHaveClass(
      "min-w-0",
      "truncate"
    )
  })

  it("switches the panel from the rail and retitles it", () => {
    renderPanel()
    expect(screen.getByTestId("body-session_details")).toBeVisible()

    // Radix tabs activate on mousedown, not click.
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Files" }), {
      button: 0,
    })
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Files")
    expect(screen.getByTestId("body-file_tree")).toBeVisible()
    expect(screen.getByRole("tab", { name: "Files" })).toHaveAttribute(
      "aria-selected",
      "true"
    )
  })

  it("hides the panel when the tab already showing is clicked again", async () => {
    const user = userEvent.setup()
    const { container } = renderPanel()

    // A first click only switches. Radix selects on the mousedown, so by the
    // time this click lands the tab is selected — it must not count as the
    // second one.
    await user.click(screen.getByRole("tab", { name: "Files" }))
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Files")

    await user.click(screen.getByRole("tab", { name: "Files" }))
    expect(container).toBeEmptyDOMElement()
  })

  it("keeps the panel when a press on the tab showing turns into a drag", async () => {
    const user = userEvent.setup()
    renderPanel()
    const details = screen.getByRole("tab", { name: "Session Details" })

    await user.pointer({ keys: "[MouseLeft>]", target: details })
    act(() => motion.dragStart.get("session_details")?.())
    await user.pointer({ keys: "[/MouseLeft]", target: details })
    act(() => motion.dragEnd.get("session_details")?.())

    expect(rail()).toBeVisible()
    expect(details).toHaveAttribute("aria-selected", "true")
  })

  it("leaves Enter and Space on the tab showing to the tabs", async () => {
    const user = userEvent.setup()
    renderPanel()
    const details = screen.getByRole("tab", { name: "Session Details" })

    // A press that ends off the tab sends its click elsewhere, so nothing
    // consumes the press it started. The keyboard's clicks after it must not.
    await user.pointer([
      { keys: "[MouseLeft>]", target: details },
      { target: screen.getByRole("heading", { level: 2 }) },
      { keys: "[/MouseLeft]" },
    ])
    act(() => details.focus())
    await user.keyboard("{Enter}")
    await user.keyboard(" ")

    expect(rail()).toBeVisible()
    expect(details).toHaveAttribute("aria-selected", "true")
  })

  it("follows the stored order, and a reorder made in another window", () => {
    localStorage.setItem(KEY, JSON.stringify(REVERSED))
    renderPanel()
    expect(railTabs()).toEqual(REVERSED_NAMES)

    act(() =>
      writeFromAnotherWindow([
        "tasks",
        "file_tree",
        "session_details",
        "issues",
        "git_log",
        "changes",
        "pull_requests",
        "automations",
      ])
    )
    expect(railTabs()).toEqual([
      "To-dos",
      "Files",
      "Session Details",
      "Issues",
      "Commits",
      "Changes",
      "Pull requests",
      "Automations",
    ])
  })

  it("adds the work tabs after Commits on a rail stored before they existed", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify(["git_log", "changes", "file_tree", "session_details"])
    )
    renderPanel()
    expect(railTabs()).toEqual([
      "Commits",
      "Automations",
      "To-dos",
      "Issues",
      "Pull requests",
      "Changes",
      "Files",
      "Session Details",
    ])
  })

  it("saves a dragged order once, on release", () => {
    renderPanel()
    const dragged = [
      "changes",
      "session_details",
      "file_tree",
      "git_log",
      "automations",
      "tasks",
      "issues",
      "pull_requests",
    ]
    const draggedNames = [
      "Changes",
      "Session Details",
      "Files",
      "Commits",
      "Automations",
      "To-dos",
      "Issues",
      "Pull requests",
    ]

    // Mid-drag the tabs follow the pointer, but nothing is written yet — other
    // windows are listening to the stored order.
    act(() => motion.dragStart.get("changes")?.())
    act(() => motion.onReorder?.(dragged))
    expect(railTabs()).toEqual(draggedNames)
    expect(localStorage.getItem(KEY)).toBeNull()
    // The press-and-sweep would otherwise select text across the page.
    expect(document.body).toHaveClass("select-none")

    act(() => motion.dragEnd.get("changes")?.())
    expect(storedOrder()).toEqual(dragged)
    expect(railTabs()).toEqual(draggedNames)
    expect(document.body).not.toHaveClass("select-none")
  })

  it("writes nothing when a drag ends where it started", () => {
    localStorage.setItem(KEY, JSON.stringify(REVERSED))
    renderPanel()
    const setItem = vi.spyOn(Storage.prototype, "setItem")

    const swapped = [...REVERSED]
    ;[swapped[4], swapped[5]] = [swapped[5], swapped[4]]
    act(() => motion.onReorder?.(swapped))
    act(() => motion.onReorder?.([...REVERSED]))
    act(() => motion.dragEnd.get("changes")?.())

    expect(setItem).not.toHaveBeenCalledWith(KEY, expect.anything())
    setItem.mockRestore()
  })

  it("moves the focused tab with Alt+↑/↓ and keeps it focused", () => {
    renderPanel()
    const changes = screen.getByRole("tab", { name: "Changes" })
    expect(changes).toHaveAttribute(
      "aria-keyshortcuts",
      "Alt+ArrowUp Alt+ArrowDown"
    )
    act(() => changes.focus())

    fireEvent.keyDown(changes, { key: "ArrowUp", altKey: true })
    expect(railTabs()).toEqual([
      "Session Details",
      "Changes",
      "Files",
      "Commits",
      "Automations",
      "To-dos",
      "Issues",
      "Pull requests",
    ])
    expect(storedOrder()).toEqual([
      "session_details",
      "changes",
      "file_tree",
      "git_log",
      "automations",
      "tasks",
      "issues",
      "pull_requests",
    ])
    expect(screen.getByRole("tab", { name: "Changes" })).toHaveFocus()

    fireEvent.keyDown(screen.getByRole("tab", { name: "Changes" }), {
      key: "ArrowUp",
      altKey: true,
    })
    expect(railTabs()[0]).toBe("Changes")
    expect(screen.getByRole("tab", { name: "Changes" })).toHaveFocus()

    // Already on top: the nudge goes nowhere and writes nothing new.
    const before = localStorage.getItem(KEY)
    fireEvent.keyDown(screen.getByRole("tab", { name: "Changes" }), {
      key: "ArrowUp",
      altKey: true,
    })
    expect(localStorage.getItem(KEY)).toBe(before)

    // Back down to where it started: the stored value goes with it.
    for (let i = 0; i < 2; i++) {
      fireEvent.keyDown(screen.getByRole("tab", { name: "Changes" }), {
        key: "ArrowDown",
        altKey: true,
      })
    }
    expect(railTabs()).toEqual(BUILT_IN)
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it("leaves plain and other-modifier arrows to the tabs' own navigation", () => {
    renderPanel()
    const changes = screen.getByRole("tab", { name: "Changes" })
    act(() => changes.focus())
    fireEvent.keyDown(changes, { key: "ArrowUp" })
    fireEvent.keyDown(changes, { key: "ArrowUp", altKey: true, metaKey: true })
    fireEvent.keyDown(changes, { key: "ArrowUp", altKey: true, shiftKey: true })
    expect(railTabs()).toEqual(BUILT_IN)
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it("hides the rail but keeps the title when only Session Details applies", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify(["git_log", "changes", "file_tree", "session_details"])
    )
    scene.chatMode = true
    scene.initialTab = "git_log"
    renderPanel()

    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
      "Session Details"
    )
    // display:none drops the lone trigger out of the tab order, while it stays
    // in the DOM for the panel's aria-labelledby.
    expect(rail()).toHaveClass("hidden")
    expect(railTabs()).toEqual(["Session Details"])
    expect(
      screen.getByRole("tabpanel", { name: "Session Details" })
    ).toBeInTheDocument()
  })

  it("lists the tabs in the stored order on mobile, without the title strip or the rail", () => {
    localStorage.setItem(KEY, JSON.stringify(REVERSED))
    scene.mobile = true
    renderPanel()

    expect(document.querySelector("[data-aux-tab-rail]")).toBeNull()
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull()
    const list = screen.getByRole("tablist")
    expect(list).toHaveAttribute("aria-orientation", "horizontal")
    expect(
      within(list)
        .getAllByRole("tab")
        .map((tab) => tab.getAttribute("aria-label"))
    ).toEqual(REVERSED_NAMES)
  })

  it("closes the drawer when the tab already showing is tapped again", async () => {
    scene.mobile = true
    const user = userEvent.setup()
    const { container } = renderPanel()

    await user.click(screen.getByRole("tab", { name: "Changes" }))
    expect(screen.getByRole("tab", { name: "Changes" })).toHaveAttribute(
      "aria-selected",
      "true"
    )
    expect(container).not.toBeEmptyDOMElement()

    await user.click(screen.getByRole("tab", { name: "Changes" }))
    expect(container).toBeEmptyDOMElement()
  })

  it("opens a work tab from the rail, mounting its body on first view", () => {
    renderPanel()
    // Lazy, like the folder tabs: nothing behind a tab never opened.
    expect(screen.queryByTestId("body-issues")).toBeNull()
    expect(screen.queryByTestId("body-pull_requests")).toBeNull()

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Issues" }), {
      button: 0,
    })
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
      "Issues"
    )
    expect(screen.getByTestId("body-issues")).toBeVisible()
    expect(screen.getByTestId("body-issues")).toHaveAttribute(
      "data-forge-tab",
      "issues"
    )

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Pull requests" }), {
      button: 0,
    })
    expect(screen.getByTestId("body-pull_requests")).toHaveAttribute(
      "data-forge-tab",
      "prs"
    )
    // Kept mounted once opened, its panel inactive while another tab shows.
    expect(
      screen.getByTestId("body-issues").closest("[role=tabpanel]")
    ).toHaveAttribute("data-state", "inactive")

    fireEvent.mouseDown(screen.getByRole("tab", { name: "To-dos" }), {
      button: 0,
    })
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
      "To-dos"
    )
    expect(screen.getByTestId("body-tasks")).toBeVisible()

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Automations" }), {
      button: 0,
    })
    expect(screen.getByTestId("body-automations")).toBeVisible()
  })

  it("names the change-request tab after the project's forge", () => {
    scene.provider = "gitlab"
    scene.initialTab = "pull_requests"
    renderPanel()
    expect(railTabs()).toContain("Merge requests")
    expect(railTabs()).not.toContain("Pull requests")
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
      "Merge requests"
    )
    // Asked about the project the rail is showing.
    expect(scene.providerAsked).toContain(1)
  })

  it("does not look the forge up while only Session Details applies", () => {
    scene.chatMode = true
    renderPanel()
    expect(scene.providerAsked.every((id) => id == null)).toBe(true)
  })

  it("falls back to Session Details when a work tab's folder tabs go away", () => {
    scene.initialTab = "tasks"
    scene.folderId = null
    renderPanel()
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(
      "Session Details"
    )
    expect(
      screen.getByRole("tabpanel", { name: "Session Details" })
    ).toHaveAttribute("data-state", "active")
  })
})
