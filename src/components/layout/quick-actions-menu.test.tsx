import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { useEffect } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The quick actions, as they are now: the rows of the status bar's one menu,
// between the SRN account's head and its sign-in row (`status-bar-srn.tsx`),
// opened from the account's trigger — the routes, then, after a divider, the
// launch group: "Open project", "Open remote workspace" (desktop), "Open
// local workspace" (a remote workspace window), then "Open browser tab" and
// "Show pet" (desktop). The menu is a thin router over existing entry points,
// so every one of them is stubbed: the test's job is to prove each row reaches
// the right door (and that the desktop-only rows disappear off the desktop),
// not to re-test the doors. The account itself is stubbed too — signed out —
// and is `status-bar-srn.test.tsx`'s.
const mocks = vi.hoisted(() => {
  const connections = [
    { id: 11, name: "prod-box", base_url: "https://prod.example" },
    { id: 12, name: "lab-box", base_url: "https://lab.example" },
  ]
  return {
    connections,
    openProjectBootWindow: vi.fn(() => Promise.resolve()),
    openPetWindow: vi.fn(() => Promise.resolve()),
    openLocalWorkspace: vi.fn(() => Promise.resolve()),
    openRemoteWorkspace: vi.fn(() => Promise.resolve()),
    listRemoteWorkspaceConnections: vi.fn(() => Promise.resolve(connections)),
    setRoute: vi.fn(),
    openConversations: vi.fn(),
    openBrowserTab: vi.fn(() => "browser:new"),
    toastError: vi.fn(),
  }
})

// The built-in browser row is gated on the backend's own answer, not on the
// platform, so the test drives that answer directly.
let browserAvailable = true

let desktop = true
// A desktop window bound to a remote server, as opposed to the local `main`.
let remoteWindow = false
vi.mock("@/lib/platform", () => ({
  isDesktop: () => desktop,
  isRemoteDesktopWindow: () => desktop && remoteWindow,
}))

vi.mock("sonner", () => ({ toast: { error: mocks.toastError } }))

vi.mock("@/lib/api", () => ({
  openProjectBootWindow: mocks.openProjectBootWindow,
}))

vi.mock("@/lib/pet/api", () => ({ openPetWindow: mocks.openPetWindow }))

vi.mock("@/lib/remote-workspace", () => ({
  listRemoteWorkspaceConnections: mocks.listRemoteWorkspaceConnections,
  openLocalWorkspace: mocks.openLocalWorkspace,
  openRemoteWorkspace: mocks.openRemoteWorkspace,
}))

vi.mock("@/contexts/automations-view-context", () => ({
  useAutomationsView: () => ({ unseenFailures: 2 }),
}))

vi.mock("@/contexts/tasks-view-context", () => ({
  useTasksView: () => ({ attentionCount: 0 }),
}))

vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({
    routeId: "conversations",
    setRoute: mocks.setRoute,
    openConversations: mocks.openConversations,
  }),
}))

vi.mock("@/contexts/workspace-context", () => ({
  useOptionalWorkspaceActions: () => ({
    openBrowserTab: mocks.openBrowserTab,
  }),
}))

vi.mock("@/lib/browser/use-browser-capabilities", () => ({
  useBrowserCapabilities: () =>
    browserAvailable ? { available: true } : { available: false },
}))

// Dialogs render nothing until opened and drag in large trees; the menu only
// owns their open state, which the assertions below read off these stubs.
vi.mock("./clone-dialog", () => ({
  CloneDialog: ({ open }: { open: boolean }) =>
    open ? <div>CLONE-DIALOG</div> : null,
}))
vi.mock("./workspace-folder-dialog", () => ({
  WorkspaceFolderDialog: ({ open }: { open: boolean }) =>
    open ? <div>FOLDER-DIALOG</div> : null,
}))
vi.mock("./remote-workspace-manage-dialog", () => ({
  RemoteWorkspaceManageDialog: ({ open }: { open: boolean }) =>
    open ? <div>REMOTE-MANAGE-DIALOG</div> : null,
}))

// The account above the quick actions: signed out, and still.
vi.mock("@/lib/srn-account/source", () => ({
  getSrnAccountSource: () => ({
    kind: "desktop",
    read: async () => ({ status: "signedOut" }),
    onChange: async () => () => {},
  }),
}))

import { StatusBarSrn } from "./status-bar-srn"
import {
  HarnessViewProvider,
  useHarnessView,
} from "@/contexts/harness-view-context"
import enMessages from "@/i18n/messages/en.json"
import { SIDEBAR_NAV_ITEM_IDS } from "@/lib/sidebar-view-mode-storage"

/** Reports a number of available updates to the Harness provider, as the
 *  update check will. */
function HarnessUpdates({ count }: { count: number }) {
  const { setUpdatesCount } = useHarnessView()
  useEffect(() => setUpdatesCount(count), [count, setUpdatesCount])
  return null
}

/** Mount once, then open the (single) trigger. Under the real Harness provider
 *  — it talks to no backend — so the row's badge is fed the way the app feeds
 *  it. */
async function mountAndOpen({ harnessUpdates = 0 } = {}) {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <HarnessViewProvider>
        <HarnessUpdates count={harnessUpdates} />
        <StatusBarSrn />
      </HarnessViewProvider>
    </NextIntlClientProvider>
  )
  // The account is read before the trigger names it.
  await screen.findByRole("button", { name: "SRN account: not signed in" })
  await reopen()
}

/** Re-open the already-mounted menu — each item click closes it. The one
 *  trigger is the account's, described as the quick actions too. */
async function reopen() {
  await userEvent.click(
    screen.getByRole("button", { description: "Quick actions" })
  )
}

async function clickItem(name: string | RegExp) {
  await userEvent.click(await screen.findByRole("menuitem", { name }))
}

/** Opens a submenu from its row, by click (a tap on a phone). */
async function openSub(name: string) {
  await userEvent.click(await screen.findByRole("menuitem", { name }))
}

/** The top-level rows, in order, by their text. */
function topRows() {
  return [...screen.getByRole("menu").children]
    .filter((el) => el.getAttribute("role") === "menuitem")
    .map((el) => el.textContent)
}

/** The whole top level: the account's head, dividers, and the rows. */
function layout() {
  return [...screen.getAllByRole("menu")[0].children].map((el) => {
    if (el.getAttribute("role") === "group") return "head"
    if (el.getAttribute("role") === "separator") return "—"
    return el.textContent
  })
}

/** A submenu's rows, by their text. */
function subRows(name: string) {
  return within(screen.getByRole("menu", { name }))
    .getAllByRole("menuitem")
    .map((el) => el.textContent)
}

// "Automations" carries a failure-count badge inside the row (2, per the mock),
// so its accessible name is the label plus that number — matched by prefix.
const AUTOMATIONS_ROW = /^Automations/
const FORGE_ROW = "Repository panel"
// The Harness row's label is followed by what the page holds.
const HARNESS_ROW = "Harness EngineeringSkills · MCP"

beforeEach(() => {
  desktop = true
  remoteWindow = false
  browserAvailable = true
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
  window.innerWidth = 1024
})

describe("Quick actions, in the status bar's account menu", () => {
  it("has no trigger of its own: the account's opens them", async () => {
    await mountAndOpen()
    // One button on the bar, named by the account, described as the quick
    // actions; one menu, the account's head first, the quick actions, and
    // the account's sign-in at the foot.
    const [trigger] = screen.getAllByRole("button", { hidden: true })
    expect(trigger).toHaveAccessibleName("SRN account: not signed in")
    expect(trigger).toHaveAccessibleDescription("Quick actions")
    expect(screen.queryByRole("button", { name: "Quick actions" })).toBeNull()
    const rows = topRows()
    expect(rows[0]).toBe("Personal agent")
    expect(rows[rows.length - 1]).toBe("Sign in to SRN")
  })

  it("the routes first, a divider, then the launch group, with no group titles", async () => {
    await mountAndOpen()
    expect(layout()).toEqual([
      "head",
      "—",
      "Personal agent",
      "Automations2",
      "To-dos",
      FORGE_ROW,
      "Infinite Canvas",
      HARNESS_ROW,
      "—",
      "Open project",
      "Open remote workspace",
      "Open browser tab",
      "Show pet",
      "—",
      "Sign in to SRN",
    ])
    for (const name of ["Open project", "Open remote workspace"]) {
      const row = screen.getByRole("menuitem", { name })
      expect(row).toHaveAttribute("aria-haspopup", "menu")
      expect(row).toHaveAttribute("aria-expanded", "false")
    }
    // The window-level extras are plain rows: the old "More" submenu is gone.
    for (const name of ["Open browser tab", "Show pet"]) {
      expect(screen.getByRole("menuitem", { name })).not.toHaveAttribute(
        "aria-haspopup"
      )
    }
    expect(screen.queryByRole("menuitem", { name: "More" })).toBeNull()
    // Their rows are not in the top level until opened; the old "Workspace"
    // submenu is gone.
    for (const name of [
      "Workspace",
      "Open Folder",
      "Clone Repository",
      "Project Boot",
      "Open local workspace",
      "Manage remote workspace",
    ]) {
      expect(screen.queryByRole("menuitem", { name })).toBeNull()
    }
    // No titles over the rows.
    expect(document.querySelector("[data-slot=dropdown-menu-label]")).toBeNull()
    for (const title of ["Navigation", "Workspace", "Open project", "More"]) {
      expect(
        screen
          .queryAllByText(title)
          .filter((el) => !el.closest("[role=menuitem]"))
      ).toEqual([])
    }
  })

  it("Open project opens on click, with the three ways in", async () => {
    await mountAndOpen()
    await openSub("Open project")
    const row = screen.getByRole("menuitem", { name: "Open project" })
    expect(row).toHaveAttribute("aria-expanded", "true")
    expect(subRows("Open project")).toEqual([
      "Open Folder",
      "Clone Repository",
      "Project Boot",
    ])
  })

  it("Open remote workspace is a submenu of its own, with the connections and the manage row", async () => {
    await mountAndOpen()
    await openSub("Open remote workspace")
    const sub = await screen.findByRole("menu", {
      name: "Open remote workspace",
    })
    await within(sub).findByText("prod-box")
    expect(subRows("Open remote workspace")).toEqual([
      "prod-boxhttps://prod.example",
      "lab-boxhttps://lab.example",
      "Manage remote workspace",
    ])
    // A long list scrolls inside it rather than running off the window.
    expect(sub).toHaveClass("overflow-y-auto")
    expect(sub.className).toContain(
      "max-h-(--radix-dropdown-menu-content-available-height)"
    )
  })

  it("Open remote workspace with no connections says so, and still offers to manage them", async () => {
    mocks.listRemoteWorkspaceConnections.mockResolvedValueOnce([])
    await mountAndOpen()
    await openSub("Open remote workspace")
    const sub = await screen.findByRole("menu", {
      name: "Open remote workspace",
    })
    expect(within(sub).getByText("No remote connections")).toBeVisible()
    expect(subRows("Open remote workspace")).toEqual([
      "Manage remote workspace",
    ])
  })

  it("reads the remote connections again each time their submenu opens", async () => {
    await mountAndOpen()
    const remote = screen.getByRole("menuitem", {
      name: "Open remote workspace",
    })
    remote.focus()
    await userEvent.keyboard("{ArrowRight}")
    await screen.findByText("prod-box")
    await userEvent.keyboard("{ArrowLeft}")
    await vi.waitFor(() =>
      expect(
        screen.queryByRole("menu", { name: "Open remote workspace" })
      ).toBeNull()
    )
    await userEvent.keyboard("{ArrowRight}")
    await screen.findByText("prod-box")
    expect(mocks.listRemoteWorkspaceConnections).toHaveBeenCalledTimes(2)
  })

  it.each(["{ArrowRight}", "{Enter}"])(
    "a submenu opens from the keyboard (%s), on its first row, and ← goes back",
    async (key) => {
      await mountAndOpen()
      const project = screen.getByRole("menuitem", { name: "Open project" })
      project.focus()
      await userEvent.keyboard(key)
      const sub = await screen.findByRole("menu", { name: "Open project" })
      expect(project).toHaveAttribute("aria-expanded", "true")
      expect(project).toHaveAttribute("aria-controls", sub.id)
      await vi.waitFor(() =>
        expect(sub).toContainElement(document.activeElement as HTMLElement)
      )
      await userEvent.keyboard("{ArrowLeft}")
      await vi.waitFor(() =>
        expect(screen.queryByRole("menu", { name: "Open project" })).toBeNull()
      )
      expect(document.activeElement).toBe(project)
    }
  )

  it("opens a blank browser tab, returning to the conversations route first", async () => {
    await mountAndOpen()
    await clickItem("Open browser tab")

    // The file column that holds browser tabs only exists on the conversations
    // route, so the route swap has to happen too — otherwise the tab opens
    // behind whichever full-page route is covering the workspace.
    expect(mocks.openConversations).toHaveBeenCalled()
    expect(mocks.openBrowserTab).toHaveBeenCalledWith("about:blank")
    // The whole menu closed with it.
    expect(screen.queryByRole("menu")).toBeNull()
  })

  it("drops the browser row when there is no built-in browser", async () => {
    browserAvailable = false
    await mountAndOpen()

    expect(
      screen.queryByRole("menuitem", { name: "Open browser tab" })
    ).toBeNull()
    // The pet row survives, so this is the gate and not the extras failing
    // to render.
    expect(
      await screen.findByRole("menuitem", { name: "Show pet" })
    ).toBeVisible()
  })

  it("has no Search row — that button is always visible in the chrome", async () => {
    await mountAndOpen()
    // Every other entry here is a fallback for a home that disappears with the
    // sidebar; search's home (LeftEdgeChrome / FolderTitleBar) never does.
    expect(screen.queryByRole("menuitem", { name: "Search" })).toBeNull()
    await openSub("Open project")
    expect(screen.queryByRole("menuitem", { name: "Search" })).toBeNull()
  })

  it("has no folder-scoped session rows", async () => {
    await mountAndOpen()
    await openSub("Open project")
    // Manage conversations / Import local sessions act on ONE folder, so their
    // homes are the folder row's context menu and the Folders section header —
    // both of which are reachable without this launcher. A copy here would only
    // ever act on whatever folder happened to be active.
    expect(screen.queryByText("Sessions")).toBeNull()
    expect(
      screen.queryByRole("menuitem", { name: "Manage conversations" })
    ).toBeNull()
    expect(
      screen.queryByRole("menuitem", { name: "Import local sessions" })
    ).toBeNull()
  })

  it("drops the desktop-only rows in web mode: the launch group is Open project alone", async () => {
    desktop = false
    await mountAndOpen()

    // The routes are platform-neutral route switches and must survive off
    // the desktop; the remote workspaces and the extras are the desktop's, so
    // they go whole.
    expect(layout()).toEqual([
      "head",
      "—",
      "Personal agent",
      "Automations2",
      "To-dos",
      FORGE_ROW,
      "Infinite Canvas",
      HARNESS_ROW,
      "—",
      "Open project",
      "—",
      "Sign in to SRN",
    ])
    await openSub("Open project")
    expect(subRows("Open project")).toEqual([
      "Open Folder",
      "Clone Repository",
      "Project Boot",
    ])
    expect(screen.queryByText(/remote workspace/i)).toBeNull()
    expect(screen.queryByText("Open local workspace")).toBeNull()
    expect(screen.queryByRole("menuitem", { name: "Show pet" })).toBeNull()
    expect(
      screen.queryByRole("menuitem", { name: "Open browser tab" })
    ).toBeNull()
    expect(mocks.listRemoteWorkspaceConnections).not.toHaveBeenCalled()
  })

  it("offers the local workspace from a remote workspace window, as a row of its own beside the remote one", async () => {
    remoteWindow = true
    await mountAndOpen()
    expect(topRows()).toEqual([
      "Personal agent",
      "Automations2",
      "To-dos",
      FORGE_ROW,
      "Infinite Canvas",
      HARNESS_ROW,
      "Open project",
      "Open remote workspace",
      "Open local workspace",
      "Open browser tab",
      "Show pet",
      "Sign in to SRN",
    ])
    const local = screen.getByRole("menuitem", { name: "Open local workspace" })
    // A plain row: it opens a window, not a submenu.
    expect(local).not.toHaveAttribute("aria-haspopup")
    expect(mocks.openLocalWorkspace).not.toHaveBeenCalled()

    await clickItem("Open local workspace")
    expect(mocks.openLocalWorkspace).toHaveBeenCalledOnce()
    expect(mocks.openRemoteWorkspace).not.toHaveBeenCalled()
    expect(screen.queryByRole("menu")).toBeNull()
  })

  it("has no local workspace row in the local workspace itself", async () => {
    await mountAndOpen()
    // There it could only focus the window it was picked from. The remote
    // workspaces stay, so this is the gate and not the group failing.
    expect(
      screen.getByRole("menuitem", { name: "Open remote workspace" })
    ).toBeVisible()
    expect(
      screen.queryByRole("menuitem", { name: "Open local workspace" })
    ).toBeNull()
    await openSub("Open project")
    expect(
      screen.queryByRole("menuitem", { name: "Open local workspace" })
    ).toBeNull()
  })

  it("says so when the local workspace cannot be brought up", async () => {
    remoteWindow = true
    mocks.openLocalWorkspace.mockRejectedValueOnce(new Error("ipc down"))
    await mountAndOpen()
    expect(mocks.toastError).not.toHaveBeenCalled()

    await clickItem("Open local workspace")
    await vi.waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Failed to open local workspace",
        { description: "ipc down" }
      )
    )
  })

  it("routes each action to its own entry point", async () => {
    await mountAndOpen()

    await clickItem(AUTOMATIONS_ROW)
    expect(mocks.setRoute).toHaveBeenCalledWith("automations")

    await reopen()
    await openSub("Open project")
    await clickItem("Project Boot")
    expect(mocks.openProjectBootWindow).toHaveBeenCalled()

    await reopen()
    await clickItem("To-dos")
    expect(mocks.setRoute).toHaveBeenCalledWith("tasks")

    await reopen()
    await clickItem(FORGE_ROW)
    expect(mocks.setRoute).toHaveBeenCalledWith("forge")

    await reopen()
    await clickItem(/^Harness Engineering/)
    expect(mocks.setRoute).toHaveBeenCalledWith("harness")

    await reopen()
    await clickItem("Personal agent")
    expect(mocks.setRoute).toHaveBeenCalledWith("personalAgent")

    await reopen()
    await clickItem("Show pet")
    expect(mocks.openPetWindow).toHaveBeenCalled()
  })

  it("lists every sidebar route, in the sidebar's own order", async () => {
    await mountAndOpen()
    await screen.findByRole("menuitem", { name: /^Harness Engineering/ })

    // The same list the sidebar builds its rows from, so a route added there
    // cannot be left out of — or misplaced in — the one menu that still
    // reaches it with the sidebar collapsed or the row hidden.
    const labels = SIDEBAR_NAV_ITEM_IDS.map(
      (id) => enMessages.Folder.sidebar[id]
    )
    const rows = topRows()
      // A badged row's text is its label plus the count.
      .map((text) => labels.find((label) => text?.startsWith(label)))
      .filter((label) => label !== undefined)
    expect(rows).toEqual(labels)
    expect(labels[labels.length - 1]).toBe("Harness Engineering")
  })

  it("keeps Harness reachable off the desktop", async () => {
    desktop = false
    await mountAndOpen()

    // A route switch, not a desktop feature: it is how a web client — or
    // anyone who hid the sidebar row — gets to the page at all.
    await clickItem(/^Harness Engineering/)
    expect(mocks.setRoute).toHaveBeenCalledWith("harness")
  })

  it("carries no Harness badge while nothing has an update", async () => {
    await mountAndOpen()
    const row = await screen.findByRole("menuitem", {
      name: /^Harness Engineering/,
    })
    expect(row.textContent).toBe(HARNESS_ROW)
  })

  it("carries the sidebar's updates badge on the Harness row", async () => {
    await mountAndOpen({ harnessUpdates: 4 })

    const row = await screen.findByRole("menuitem", {
      name: /^Harness Engineering.*4 updates available$/,
    })
    const badge = row.querySelector('[title="4 updates available"]')
    expect(badge).not.toBeNull()
    // The To-dos tint: updates waiting are not a failure.
    expect(badge?.className).toContain("bg-primary/10")
    expect(badge?.className).not.toContain("destructive")
  })

  it("loads the remote connections only when its submenu opens", async () => {
    await mountAndOpen()
    // Opening the root menu, or the project submenu beside it, must not
    // fetch — the list is its own submenu's.
    expect(mocks.listRemoteWorkspaceConnections).not.toHaveBeenCalled()
    await openSub("Open project")
    expect(mocks.listRemoteWorkspaceConnections).not.toHaveBeenCalled()

    await openSub("Open remote workspace")
    expect(await screen.findByText("prod-box")).toBeVisible()
    expect(screen.getByText("https://lab.example")).toBeVisible()
    expect(mocks.listRemoteWorkspaceConnections).toHaveBeenCalledTimes(1)
  })

  it("opens the picked remote workspace, and its manage dialog once the menu has closed", async () => {
    await mountAndOpen()
    await openSub("Open remote workspace")
    await userEvent.click(await screen.findByText("lab-box"))
    expect(mocks.openRemoteWorkspace).toHaveBeenCalledWith(12)
    expect(screen.queryByRole("menu")).toBeNull()

    await reopen()
    await openSub("Open remote workspace")
    await clickItem("Manage remote workspace")
    expect(screen.queryByRole("menu")).toBeNull()
    expect(await screen.findByText("REMOTE-MANAGE-DIALOG")).toBeVisible()
  })

  it("opens the folder and clone dialogs from Open project, once the menu has closed", async () => {
    await mountAndOpen()
    await openSub("Open project")
    await clickItem("Open Folder")
    expect(screen.queryByRole("menu")).toBeNull()
    expect(await screen.findByText("FOLDER-DIALOG")).toBeVisible()

    await reopen()
    await openSub("Open project")
    await clickItem("Clone Repository")
    expect(screen.queryByRole("menu")).toBeNull()
    expect(await screen.findByText("CLONE-DIALOG")).toBeVisible()
  })

  it("on a window with room, a submenu opens beside its menu", async () => {
    await mountAndOpen()
    await openSub("Open project")
    // (jsdom lays nothing out, so where Radix puts it is the visual check's;
    // here, that it was not asked to open over its menu.)
    const sub = screen.getByRole("menu", { name: "Open project" })
    expect(sub.style.width).toBe("")
    expect(
      screen.getByRole("menuitem", { name: "Open project" })
    ).not.toHaveAttribute("data-over")
  })

  /** The open menu, laid out as a browser would: 304px wide from 8px. */
  function layOutMenu() {
    const root = screen.getByRole("menu")
    const rect = HTMLElement.prototype.getBoundingClientRect
    return vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        return this === root
          ? DOMRect.fromRect({ x: 8, y: 300, width: 304, height: 420 })
          : rect.call(this)
      })
  }

  it("on a phone, a submenu opens over its menu, above its own row, and the menu fades behind it", async () => {
    // A 390px window: no room beside the menu.
    window.innerWidth = 390
    await mountAndOpen()
    layOutMenu()
    const root = screen.getByRole("menu")
    for (const name of ["Open project", "Open remote workspace"]) {
      await openSub(name)
      const row = screen.getByRole("menuitem", { name })
      const sub = screen.getByRole("menu", { name })
      // Over the menu, 16px in from its start edge: as wide as the rest of
      // it.
      expect(sub.style.width).toBe("288px")
      // Its own row stays lit; the rest of the menu fades behind it.
      expect(row).toHaveAttribute("data-over")
      expect(row).toHaveAttribute("data-state", "open")
    }
    expect(root.className).toContain("[&:has(>[data-over][data-state=open])")
  })

  it("opens a submenu beside its menu only where it is as wide there as over it", async () => {
    // Over the menu, a submenu is 288px wide; beside it, it starts 4px out
    // and keeps 8px from the window's edge. So it needs 300px past the
    // menu's end (312px): a window of 612px. Narrower, beside would squeeze
    // it and cut its labels short, so it opens over the menu. Each case opens
    // from a fresh menu: where a submenu goes is measured as it opens, so one
    // left open by the case before would keep that case's answer.
    await mountAndOpen()
    await userEvent.keyboard("{Escape}")
    for (const [width, name, over] of [
      [530, "Open project", true],
      [611, "Open remote workspace", true],
      [612, "Open project", false],
    ] as const) {
      window.innerWidth = width
      await reopen()
      const spy = layOutMenu()
      await openSub(name)
      const row = screen.getByRole("menuitem", { name })
      const sub = screen.getByRole("menu", { name })
      if (over) {
        expect(row).toHaveAttribute("data-over")
        expect(sub.style.width).toBe("288px")
      } else {
        expect(row).not.toHaveAttribute("data-over")
        expect(sub.style.width).toBe("")
      }
      spy.mockRestore()
      await userEvent.keyboard("{Escape}")
      expect(screen.queryByRole("menu")).toBeNull()
    }
  })
})
