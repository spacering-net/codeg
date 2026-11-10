import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Ref } from "react"

import { Sidebar } from "./sidebar"
// Type-only (erased at runtime, so it does not defeat the mock below): pins the
// stub's imperative handle to the real component's contract.
import type { SidebarConversationListHandle } from "@/components/conversations/sidebar-conversation-list"
import enMessages from "@/i18n/messages/en.json"
import type { TagFilter } from "@/lib/conversation-tags"
import {
  resetConversationTagsStore,
  useConversationTagsStore,
} from "@/stores/conversation-tags-store"
import {
  resetFolderTabsStore,
  useFolderTabsStore,
} from "@/stores/folder-tabs-store"

// Stable spies + mutable active-folder, referenced from the hoisted mock
// factories below (vi.mock is hoisted above imports).
const spies = vi.hoisted(() => ({
  openNewConversationTab: vi.fn(),
  openChatModeTab: vi.fn(),
  setRoute: vi.fn(),
  openConversations: vi.fn(),
  // The list's imperative handle, driven by the header buttons.
  scrollToActive: vi.fn(),
  expandAll: vi.fn(),
  collapseAll: vi.fn(),
  // The tag manager the tag filter's footer leads to.
  openConversationTagsManager: vi.fn(),
  // Latest props the (stubbed) conversation list was rendered with, so tests can
  // assert what the sidebar threads down (e.g. showWorktrees / showCompleted).
  listProps: null as {
    showWorktrees?: boolean
    showCompleted?: boolean
    showRecent?: boolean
    sectionOrder?: readonly string[]
    tagFilter?: TagFilter
  } | null,
}))
const mockState = vi.hoisted(() => ({
  activeFolder: { id: 7, path: "/x" } as { id: number; path: string } | null,
}))

// The conversation list is irrelevant here — stub it so the test exercises only
// the sidebar's header + fixed nav region. The stub still fulfils the imperative
// handle (React 19 hands `ref` to a function component as a plain prop, which is
// how the real component takes it), so the header buttons that drive the list
// are asserted against real calls instead of clicking into a null ref.
vi.mock("@/components/conversations/sidebar-conversation-list", async () => {
  const { useImperativeHandle } = await import("react")
  return {
    SidebarConversationList: ({
      ref,
      ...props
    }: {
      ref?: Ref<SidebarConversationListHandle>
      showWorktrees?: boolean
      showCompleted?: boolean
      showRecent?: boolean
      sectionOrder?: readonly string[]
      tagFilter?: TagFilter
    }) => {
      spies.listProps = props
      useImperativeHandle(ref, () => ({
        scrollToActive: spies.scrollToActive,
        expandAll: spies.expandAll,
        collapseAll: spies.collapseAll,
      }))
      return null
    },
  }
})
vi.mock("@/components/conversations/conversation-tags-manager", () => ({
  openConversationTagsManager: spies.openConversationTagsManager,
}))
vi.mock("@/contexts/sidebar-context", () => ({
  useSidebarContext: () => ({ isOpen: true, toggle: vi.fn() }),
}))
vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({ activeFolder: mockState.activeFolder }),
}))
vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({
    openNewConversationTab: spies.openNewConversationTab,
    openChatModeTab: spies.openChatModeTab,
  }),
}))
vi.mock("@/contexts/automations-view-context", () => ({
  useAutomationsView: () => ({
    automations: [],
    unseenFailures: 0,
    refetch: async () => {},
  }),
}))
vi.mock("@/contexts/tasks-view-context", () => ({
  useTasksView: () => ({
    tasks: [],
    attentionCount: 0,
    refetch: async () => {},
  }),
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({
    routeId: "conversations",
    isConversations: true,
    setRoute: spies.setRoute,
    openConversations: spies.openConversations,
  }),
}))
vi.mock("@/hooks/use-is-mac", () => ({ useIsMac: () => false }))
vi.mock("@/hooks/use-shortcut-settings", () => ({
  useShortcutSettings: () => ({
    shortcuts: { toggle_search: "mod+k", new_conversation: "mod+t" },
  }),
}))
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }))
vi.mock("@/hooks/use-appearance", () => ({
  useZoomLevel: () => ({ zoomLevel: 100, setZoomLevel: () => {} }),
}))

function renderSidebar() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <Sidebar />
    </NextIntlClientProvider>
  )
}

/**
 * Walk into one of the view-options menu's two visibility inventories, which
 * live behind submenus. Clicking a sub-trigger opens it synchronously; opening
 * it by HOVER runs on a 100ms Radix timer and is asserted separately below.
 *
 * This — and every click on a row inside the submenu — deliberately uses the
 * module-level `userEvent` instead of a `setup()` instance, matching the
 * quick-actions submenu tests. A shared instance remembers where the pointer
 * was, so the next click drags it off the sub-trigger first; Radix answers a
 * trigger-leave with its grace-area check, which needs real element geometry,
 * and jsdom reports every rect as 0×0. The check fails, the root menu takes
 * focus back, and the submenu closes out from under the click. A fresh
 * instance has no previous position, so nothing ever leaves the trigger.
 */
async function openViewOptionsGroup(
  group: "Filter by tags" | "Conversation list" | "Navigation items"
) {
  await userEvent.click(screen.getByRole("button", { name: "View options" }))
  await userEvent.click(screen.getByRole("menuitem", { name: group }))
}

describe("Sidebar — fixed nav region", () => {
  beforeEach(() => {
    spies.openNewConversationTab.mockClear()
    spies.openChatModeTab.mockClear()
    spies.setRoute.mockClear()
    spies.openConversations.mockClear()
    mockState.activeFolder = { id: 7, path: "/x" }
  })

  it("Automations navigates to the automations route", () => {
    const { getByText } = renderSidebar()
    fireEvent.click(getByText("Automations"))
    expect(spies.setRoute).toHaveBeenCalledWith("automations")
  })

  it("New chat returns to the conversation workspace", () => {
    const { getByText } = renderSidebar()
    fireEvent.click(getByText("New chat"))
    expect(spies.openConversations).toHaveBeenCalled()
  })

  it("New chat opens a conversation tab in the active folder", () => {
    const { getByText } = renderSidebar()
    fireEvent.click(getByText("New chat"))
    expect(spies.openNewConversationTab).toHaveBeenCalledWith(7, "/x")
  })

  it("renders the New chat shortcut hint", () => {
    const { getByText } = renderSidebar()
    // isMac=false → "mod" formats as "Ctrl". The badge is opacity-0 until the
    // row is hovered/focused but stays in the DOM, so getByText resolves it.
    expect(getByText("Ctrl+T")).toBeTruthy()
  })

  it("no longer carries a Search row — it moved to the window chrome", () => {
    const { queryByText } = renderSidebar()
    // The sidebar unmounts when collapsed, which left ⌘K as the only path to
    // search; the button now lives in LeftEdgeChrome / FolderTitleBar instead.
    expect(queryByText("Search")).toBeNull()
    expect(queryByText("Ctrl+K")).toBeNull()
  })

  it("falls back to chat mode (never disabled) when no folder is active", () => {
    mockState.activeFolder = null
    const { getByText } = renderSidebar()
    const btn = getByText("New chat").closest("button") as HTMLButtonElement
    // Defense-in-depth: the button stays clickable so a workspace that recovered
    // to no active folder is never a dead end — it opens folderless chat mode.
    expect(btn.disabled).toBe(false)
    fireEvent.click(btn)
    expect(spies.openChatModeTab).toHaveBeenCalled()
    expect(spies.openNewConversationTab).not.toHaveBeenCalled()
  })
})

describe("Sidebar — View options grouping", () => {
  beforeEach(() => {
    localStorage.clear()
    mockState.activeFolder = { id: 7, path: "/x" }
  })

  it("keeps both visibility inventories out of the root menu", async () => {
    const user = userEvent.setup()
    renderSidebar()
    await user.click(screen.getByRole("button", { name: "View options" }))

    // Six checkboxes inline turned the root into a wall; they now sit one hop
    // in, behind their group. Sort by / Section order stay inline — the
    // control on the right is the proof this is about the two inventories and
    // not the menu failing to render.
    expect(
      screen.queryByRole("menuitemcheckbox", { name: "Show worktree branches" })
    ).toBeNull()
    expect(
      screen.queryByRole("menuitemcheckbox", { name: "Automations" })
    ).toBeNull()
    expect(
      screen.getByRole("menuitemradio", { name: "Created time" })
    ).toBeTruthy()

    expect(
      screen.getByRole("menuitem", { name: "Conversation list" })
    ).toBeTruthy()
    expect(
      screen.getByRole("menuitem", { name: "Navigation items" })
    ).toBeTruthy()
    await user.keyboard("{Escape}")
  })

  it("opens a group on hover alone, with no click", async () => {
    const user = userEvent.setup()
    renderSidebar()
    await user.click(screen.getByRole("button", { name: "View options" }))

    // Load-bearing: without this the assertion below would also pass on a menu
    // that never nested the toggles in the first place.
    expect(
      screen.queryByRole("menuitemcheckbox", { name: "Automations" })
    ).toBeNull()

    // Pointing at the row is the whole interaction — Radix opens the submenu on
    // a short pointer-move timer, so this resolves without a second click.
    await user.hover(screen.getByRole("menuitem", { name: "Navigation items" }))

    expect(
      await screen.findByRole("menuitemcheckbox", { name: "Automations" })
    ).toBeTruthy()
    // Escape inside a submenu closes the whole stack, root included.
    await user.keyboard("{Escape}")
  })
})

describe("Sidebar — Tag filter inside View options", () => {
  beforeEach(() => {
    localStorage.clear()
    spies.listProps = null
    spies.openConversationTagsManager.mockClear()
    mockState.activeFolder = { id: 7, path: "/x" }
    resetConversationTagsStore()
    useConversationTagsStore.getState().applyChange({
      kind: "upsert",
      tag: {
        id: 1,
        folder_id: null,
        name: "bug",
        color: "#0969da",
        sort_order: 1,
      },
    })
  })

  it("has no header button of its own any more", () => {
    renderSidebar()
    expect(screen.queryByRole("button", { name: "Filter by tags" })).toBeNull()
    // Control: the header cluster itself rendered.
    expect(screen.getByRole("button", { name: "View options" })).toBeTruthy()
  })

  it("leads the View options menu", async () => {
    renderSidebar()
    await userEvent.click(screen.getByRole("button", { name: "View options" }))

    const rows = screen.getAllByRole("menuitem")
    expect(rows[0].textContent).toBe("Filter by tags")
    expect(rows[1].textContent).toBe("Conversation list")
  })

  it("narrows the list to a picked tag, persists it and stays open", async () => {
    renderSidebar()
    expect(spies.listProps?.tagFilter).toEqual({ tagIds: [], mode: "any" })

    await openViewOptionsGroup("Filter by tags")
    const panel = await screen.findByRole("dialog", { name: "Filter by tags" })
    await userEvent.click(within(panel).getByText("bug"))

    expect(spies.listProps?.tagFilter).toEqual({ tagIds: [1], mode: "any" })
    expect(
      JSON.parse(localStorage.getItem("workspace:sidebar-tag-filter") ?? "")
    ).toEqual({ tagIds: [1], mode: "any" })
    // Picking is iterative, like every option here: the panel stays up, and
    // the row now counts the pick.
    expect(screen.getByRole("dialog", { name: "Filter by tags" })).toBe(panel)
    expect(
      within(
        screen.getByRole("menuitem", { name: "Filter by tags" })
      ).getByText("1")
    ).toBeTruthy()
  })

  it("closes the whole menu on the way to the tag manager", async () => {
    renderSidebar()
    await openViewOptionsGroup("Filter by tags")
    const panel = await screen.findByRole("dialog", { name: "Filter by tags" })
    await userEvent.click(within(panel).getByText("Manage tags…"))

    expect(spies.openConversationTagsManager).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    expect(screen.queryByRole("dialog")).toBeNull()
  })
})

describe("Sidebar — Show worktree branches toggle", () => {
  beforeEach(() => {
    localStorage.clear()
    spies.listProps = null
    mockState.activeFolder = { id: 7, path: "/x" }
  })

  it("defaults Show worktree branches on and threads it to the conversation list", () => {
    renderSidebar()
    expect(spies.listProps?.showWorktrees).toBe(true)
  })

  it("respects an explicitly-stored 'false' from localStorage", () => {
    localStorage.setItem("workspace:sidebar-show-worktrees", "false")
    renderSidebar()
    // Hydration runs in a mount effect (flushed by render's act): a user who
    // unchecked it keeps it off despite the default-on.
    expect(spies.listProps?.showWorktrees).toBe(false)
  })

  it("toggling the view-options item off persists the choice and threads it down", async () => {
    renderSidebar()
    // Default on with a cleared store.
    expect(spies.listProps?.showWorktrees).toBe(true)

    await openViewOptionsGroup("Conversation list")
    await userEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "Show worktree branches" })
    )

    expect(localStorage.getItem("workspace:sidebar-show-worktrees")).toBe(
      "false"
    )
    expect(spies.listProps?.showWorktrees).toBe(false)
  })
})

describe("Sidebar — Show completed default", () => {
  beforeEach(() => {
    localStorage.clear()
    spies.listProps = null
    mockState.activeFolder = { id: 7, path: "/x" }
  })

  it("defaults Show completed off and threads it to the conversation list", () => {
    renderSidebar()
    expect(spies.listProps?.showCompleted).toBe(false)
  })

  it("respects an explicitly-stored 'true' from localStorage", () => {
    localStorage.setItem("workspace:sidebar-show-completed", "true")
    renderSidebar()
    expect(spies.listProps?.showCompleted).toBe(true)
  })
})

describe("Sidebar — Show Recent group toggle", () => {
  beforeEach(() => {
    localStorage.clear()
    spies.listProps = null
    mockState.activeFolder = { id: 7, path: "/x" }
  })

  it("defaults Show Recent on and threads it to the conversation list", () => {
    renderSidebar()
    expect(spies.listProps?.showRecent).toBe(true)
  })

  it("respects an explicitly-stored 'false' from localStorage", () => {
    localStorage.setItem("workspace:sidebar-show-recent", "false")
    renderSidebar()
    expect(spies.listProps?.showRecent).toBe(false)
  })

  it("toggling the view-options item off persists the choice and keeps the menu open", async () => {
    renderSidebar()

    await openViewOptionsGroup("Conversation list")
    await userEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "Show Recent group" })
    )

    expect(localStorage.getItem("workspace:sidebar-show-recent")).toBe("false")
    expect(spies.listProps?.showRecent).toBe(false)
    // The view-options menu is a settings panel: flipping one option must not
    // dismiss it — nor the submenu it lives in — or changing two costs two
    // trips back through the trigger.
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Show Recent group" })
    ).toBeTruthy()
  })
})

describe("Sidebar — Tabs follow folder", () => {
  beforeEach(() => {
    localStorage.clear()
    resetFolderTabsStore()
    mockState.activeFolder = { id: 7, path: "/x" }
  })

  it("is a root row of View options that switches the mode both ways and keeps the menu open", async () => {
    renderSidebar()
    await userEvent.click(screen.getByRole("button", { name: "View options" }))
    const row = () =>
      screen.getByRole("menuitemcheckbox", { name: "Tabs follow folder" })
    expect(row()).toHaveAttribute("aria-checked", "false")
    // A root row, not one more checkbox behind a submenu.
    expect(
      screen.queryByRole("menuitemcheckbox", { name: "Show Recent group" })
    ).toBeNull()

    await userEvent.click(row())
    expect(useFolderTabsStore.getState().enabled).toBe(true)
    expect(localStorage.getItem("workspace:tabs-follow-folder:local")).toBe(
      "true"
    )
    expect(row()).toHaveAttribute("aria-checked", "true")

    await userEvent.click(row())
    expect(useFolderTabsStore.getState().enabled).toBe(false)
    expect(localStorage.getItem("workspace:tabs-follow-folder:local")).toBe(
      "false"
    )
    expect(row()).toHaveAttribute("aria-checked", "false")
  })

  it("reflects a mode switched on elsewhere", async () => {
    act(() => {
      useFolderTabsStore.getState().setEnabled(true)
    })
    renderSidebar()
    await userEvent.click(screen.getByRole("button", { name: "View options" }))
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Tabs follow folder" })
    ).toHaveAttribute("aria-checked", "true")
  })
})

describe("Sidebar — Navigation item visibility", () => {
  beforeEach(() => {
    localStorage.clear()
    mockState.activeFolder = { id: 7, path: "/x" }
  })

  // The nav rows are `button`s; the menu's toggles are `menuitemcheckbox`es, so
  // the two never collide even while the menu is open.
  const navRow = (name: string | RegExp) =>
    screen.queryByRole("button", { name })
  const FORGE_ROW = "Repository panel"

  it("shows every route row by default", () => {
    renderSidebar()
    expect(navRow("Automations")).toBeTruthy()
    expect(navRow("To-dos")).toBeTruthy()
    expect(navRow(FORGE_ROW)).toBeTruthy()
  })

  it("hides a row when its menu toggle is switched off, and persists it", async () => {
    renderSidebar()

    await openViewOptionsGroup("Navigation items")
    await userEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "Automations" })
    )
    // Like every other option here, flipping one must not dismiss the menu —
    // and the submenu it lives in has to survive too.
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Automations" })
    ).toBeTruthy()
    // Close it before looking at the rows: an open Radix menu is modal and
    // aria-hides the sidebar behind it, which would make "the row is gone" true
    // for the wrong reason. Escape inside a submenu closes the whole stack.
    await userEvent.keyboard("{Escape}")

    expect(navRow("Automations")).toBeNull()
    // Control: the other rows are still there, so the assertion above is about
    // this one row rather than a hidden subtree.
    expect(navRow("To-dos")).toBeTruthy()
    expect(
      JSON.parse(localStorage.getItem("workspace:sidebar-nav-items") ?? "{}")
    ).toEqual({ automations: false })
  })

  it("respects an explicitly-stored hidden row from localStorage", () => {
    localStorage.setItem(
      "workspace:sidebar-nav-items",
      JSON.stringify({ forge: false })
    )
    renderSidebar()
    expect(navRow(FORGE_ROW)).toBeNull()
    expect(navRow("Automations")).toBeTruthy()
  })

  it("ignores a stored entry for a route that no longer exists", () => {
    localStorage.setItem(
      "workspace:sidebar-nav-items",
      JSON.stringify({ retired: false, tasks: false })
    )
    renderSidebar()
    expect(navRow("To-dos")).toBeNull()
    expect(navRow("Automations")).toBeTruthy()
  })
})

describe("Sidebar — Expand / collapse all groups", () => {
  beforeEach(() => {
    localStorage.clear()
    spies.collapseAll.mockClear()
    spies.expandAll.mockClear()
    mockState.activeFolder = { id: 7, path: "/x" }
  })

  it("is an icon-only header button on desktop, no longer a menu row", async () => {
    const user = userEvent.setup()
    renderSidebar()

    // Icon-only, so the accessible name comes from aria-label and names the
    // action the click performs.
    const toggle = screen.getByRole("button", { name: "Collapse All Groups" })
    expect(toggle.textContent).toBe("")

    await user.click(screen.getByRole("button", { name: "View options" }))
    expect(
      screen.queryByRole("menuitem", { name: "Collapse All Groups" })
    ).toBeNull()
    await user.keyboard("{Escape}")
  })

  it("drives the list from the header in one click, and flips direction", async () => {
    const user = userEvent.setup()
    renderSidebar()

    // One click, from the header — it used to cost a trip through the menu.
    await user.click(
      screen.getByRole("button", { name: "Collapse All Groups" })
    )
    expect(spies.collapseAll).toHaveBeenCalledTimes(1)
    expect(spies.expandAll).not.toHaveBeenCalled()

    // The button now offers the opposite action, and performs it.
    await user.click(screen.getByRole("button", { name: "Expand All Groups" }))
    expect(spies.expandAll).toHaveBeenCalledTimes(1)
    expect(
      screen.getByRole("button", { name: "Collapse All Groups" })
    ).toBeTruthy()
  })
})

describe("Sidebar — Section order control", () => {
  beforeEach(() => {
    localStorage.clear()
    spies.listProps = null
    mockState.activeFolder = { id: 7, path: "/x" }
  })

  // The order rows are `menuitem`s labelled "<name> — position N of 3"; the
  // move buttons inside them are labelled "<name> — Move up/down".
  const orderRowNames = () =>
    screen
      .getAllByRole("menuitem")
      .map((el) => el.getAttribute("aria-label") ?? "")
      .filter((label) => label.includes("position"))

  it("defaults to Folders → Chat → Recent", async () => {
    const user = userEvent.setup()
    renderSidebar()
    await user.click(screen.getByRole("button", { name: "View options" }))

    expect(orderRowNames()).toEqual([
      "Folders — position 1 of 3",
      "Chat — position 2 of 3",
      "Recent — position 3 of 3",
    ])
    expect(spies.listProps?.sectionOrder).toEqual([
      "folders",
      "chats",
      "recent",
    ])
  })

  it("moves a section up, persists the new order and threads it down", async () => {
    const user = userEvent.setup()
    renderSidebar()
    await user.click(screen.getByRole("button", { name: "View options" }))
    await user.click(screen.getByRole("button", { name: "Recent — Move up" }))

    expect(orderRowNames()).toEqual([
      "Folders — position 1 of 3",
      "Recent — position 2 of 3",
      "Chat — position 3 of 3",
    ])
    expect(spies.listProps?.sectionOrder).toEqual([
      "folders",
      "recent",
      "chats",
    ])
    expect(
      JSON.parse(localStorage.getItem("workspace:sidebar-section-order") ?? "")
    ).toEqual(["folders", "recent", "chats"])
  })

  it("disables the move buttons that would fall off an end", async () => {
    const user = userEvent.setup()
    renderSidebar()
    await user.click(screen.getByRole("button", { name: "View options" }))

    expect(
      screen.getByRole("button", { name: "Folders — Move up" })
    ).toBeDisabled()
    expect(
      screen.getByRole("button", { name: "Recent — Move down" })
    ).toBeDisabled()
    expect(
      screen.getByRole("button", { name: "Folders — Move down" })
    ).not.toBeDisabled()
  })

  it("reorders from the keyboard with Alt+Arrow on the focused row", async () => {
    const user = userEvent.setup()
    renderSidebar()
    await user.click(screen.getByRole("button", { name: "View options" }))

    // The nested move buttons are unreachable by Tab (Radix's menu swallows it)
    // and by the roving focus, so Alt+Arrow on the row is the ONLY keyboard
    // path — if this regresses, the control becomes mouse-only.
    const foldersRow = screen.getByRole("menuitem", {
      name: "Folders — position 1 of 3",
    })
    // Focusing a menu item updates Radix's roving-focus state, so it has to run
    // inside act().
    act(() => foldersRow.focus())
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}")

    expect(orderRowNames()).toEqual([
      "Chat — position 1 of 3",
      "Folders — position 2 of 3",
      "Recent — position 3 of 3",
    ])
    // Focus follows the row it moved, so a second press keeps going.
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Folders — position 2 of 3"
    )
  })

  it("restores a legacy 'chats-first' preference from an older build", async () => {
    const user = userEvent.setup()
    localStorage.setItem("workspace:sidebar-section-order", "chats-first")
    renderSidebar()
    await user.click(screen.getByRole("button", { name: "View options" }))

    expect(orderRowNames()).toEqual([
      "Chat — position 1 of 3",
      "Folders — position 2 of 3",
      "Recent — position 3 of 3",
    ])
  })

  it("keeps a hidden Recent section listed and reorderable", async () => {
    const user = userEvent.setup()
    localStorage.setItem("workspace:sidebar-show-recent", "false")
    renderSidebar()
    await user.click(screen.getByRole("button", { name: "View options" }))

    // Hiding is a separate preference from position: the row stays so the user
    // can park it where it will reappear.
    await user.click(screen.getByRole("button", { name: "Recent — Move up" }))
    expect(spies.listProps?.sectionOrder).toEqual([
      "folders",
      "recent",
      "chats",
    ])
    expect(spies.listProps?.showRecent).toBe(false)
  })
})
