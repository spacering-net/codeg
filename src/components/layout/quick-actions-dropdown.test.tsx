import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { useEffect } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

// The menu is a thin router over existing entry points, so every one of them is
// stubbed: the test's job is to prove each row reaches the right door (and that
// the desktop-only rows disappear off the desktop), not to re-test the doors.
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

import { QuickActionsDropdown } from "./quick-actions-dropdown"
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
        <QuickActionsDropdown />
      </HarnessViewProvider>
    </NextIntlClientProvider>
  )
  await reopen()
}

/** Re-open the already-mounted menu — each item click closes it. */
async function reopen() {
  await userEvent.click(screen.getByRole("button", { name: "Quick actions" }))
}

async function clickItem(name: string | RegExp) {
  await userEvent.click(await screen.findByRole("menuitem", { name }))
}

// "Automations" carries a failure-count badge inside the row (2, per the mock),
// so its accessible name is the label plus that number — matched by prefix.
const AUTOMATIONS_ROW = /^Automations/
const FORGE_ROW = "Repository panel"

beforeEach(() => {
  desktop = true
  remoteWindow = false
  browserAvailable = true
  vi.clearAllMocks()
})

describe("QuickActionsDropdown", () => {
  it("groups desktop actions under their headings", async () => {
    await mountAndOpen()

    for (const group of ["Workspace", "Navigation", "More"]) {
      expect(await screen.findByText(group)).toBeVisible()
    }
    for (const label of [
      "Open Folder",
      "Clone Repository",
      "Project Boot",
      "Open remote workspace",
      AUTOMATIONS_ROW,
      "To-dos",
      FORGE_ROW,
      "Infinite Canvas",
      "Harness",
      "Open browser tab",
      "Show pet",
    ]) {
      expect(await screen.findByRole("menuitem", { name: label })).toBeVisible()
    }
  })

  it("opens a blank browser tab, returning to the conversations route first", async () => {
    await mountAndOpen()
    await clickItem("Open browser tab")

    // The file column that holds browser tabs only exists on the conversations
    // route, so the route swap has to happen too — otherwise the tab opens
    // behind whichever full-page route is covering the workspace.
    expect(mocks.openConversations).toHaveBeenCalled()
    expect(mocks.openBrowserTab).toHaveBeenCalledWith("about:blank")
  })

  it("drops the browser row when there is no built-in browser", async () => {
    browserAvailable = false
    await mountAndOpen()

    expect(
      screen.queryByRole("menuitem", { name: "Open browser tab" })
    ).toBeNull()
    // The rest of the group survives, so this is the gate and not the group
    // failing to render.
    expect(
      await screen.findByRole("menuitem", { name: "Show pet" })
    ).toBeVisible()
  })

  it("has no Search row — that button is always visible in the chrome", async () => {
    await mountAndOpen()
    // Every other entry here is a fallback for a home that disappears with the
    // sidebar; search's home (LeftEdgeChrome / FolderTitleBar) never does.
    expect(screen.queryByRole("menuitem", { name: "Search" })).toBeNull()
  })

  it("has no folder-scoped session rows", async () => {
    await mountAndOpen()
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

  it("drops the desktop-only rows in web mode", async () => {
    desktop = false
    await mountAndOpen()

    // The remaining six still render, so this is a targeted removal rather
    // than the menu failing to open. The navigation rows in particular are
    // platform-neutral route switches and must survive off the desktop.
    expect(
      await screen.findByRole("menuitem", { name: "Open Folder" })
    ).toBeVisible()
    expect(
      await screen.findByRole("menuitem", { name: FORGE_ROW })
    ).toBeVisible()
    expect(
      screen.queryByRole("menuitem", { name: "Open remote workspace" })
    ).toBeNull()
    expect(
      screen.queryByRole("menuitem", { name: "Open local workspace" })
    ).toBeNull()
    expect(screen.queryByRole("menuitem", { name: "Show pet" })).toBeNull()
    expect(screen.queryByText("More")).toBeNull()
  })

  it("offers the local workspace from a remote workspace window", async () => {
    remoteWindow = true
    await mountAndOpen()
    expect(mocks.openLocalWorkspace).not.toHaveBeenCalled()

    await clickItem("Open local workspace")
    expect(mocks.openLocalWorkspace).toHaveBeenCalledOnce()
    expect(mocks.openRemoteWorkspace).not.toHaveBeenCalled()
  })

  it("has no local workspace row in the local workspace itself", async () => {
    await mountAndOpen()

    // There it could only focus the window it was picked from. The rest of
    // the group survives, so this is the gate and not the group failing.
    expect(
      await screen.findByRole("menuitem", { name: "Open remote workspace" })
    ).toBeVisible()
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
    await clickItem("Project Boot")
    expect(mocks.openProjectBootWindow).toHaveBeenCalled()

    await reopen()
    await clickItem("To-dos")
    expect(mocks.setRoute).toHaveBeenCalledWith("tasks")

    await reopen()
    await clickItem(FORGE_ROW)
    expect(mocks.setRoute).toHaveBeenCalledWith("forge")

    await reopen()
    await clickItem("Harness")
    expect(mocks.setRoute).toHaveBeenCalledWith("harness")

    await reopen()
    await clickItem("Show pet")
    expect(mocks.openPetWindow).toHaveBeenCalled()
  })

  it("lists every sidebar route, in the sidebar's own order", async () => {
    await mountAndOpen()
    await screen.findByRole("menuitem", { name: "Harness" })

    // The same list the sidebar builds its rows from, so a route added there
    // cannot be left out of — or misplaced in — the one menu that still
    // reaches it with the sidebar collapsed or the row hidden.
    const labels = SIDEBAR_NAV_ITEM_IDS.map(
      (id) => enMessages.Folder.sidebar[id]
    )
    const rows = screen
      .getAllByRole("menuitem")
      // A badged row's text is its label plus the count.
      .map((el) => labels.find((label) => el.textContent?.startsWith(label)))
      .filter((label) => label !== undefined)
    expect(rows).toEqual(labels)
    expect(labels[labels.length - 1]).toBe("Harness")
  })

  it("keeps Harness reachable off the desktop", async () => {
    desktop = false
    await mountAndOpen()

    // A route switch, not a desktop feature: it is how a web client — or
    // anyone who hid the sidebar row — gets to the page at all.
    await clickItem("Harness")
    expect(mocks.setRoute).toHaveBeenCalledWith("harness")
  })

  it("carries no Harness badge while nothing has an update", async () => {
    await mountAndOpen()
    const row = await screen.findByRole("menuitem", { name: "Harness" })
    expect(row.textContent).toBe("Harness")
  })

  it("carries the sidebar's updates badge on the Harness row", async () => {
    await mountAndOpen({ harnessUpdates: 4 })

    const row = await screen.findByRole("menuitem", {
      name: "Harness 4 updates available",
    })
    const badge = row.querySelector('[title="4 updates available"]')
    expect(badge).not.toBeNull()
    // The To-dos tint: updates waiting are not a failure.
    expect(badge?.className).toContain("bg-primary/10")
    expect(badge?.className).not.toContain("destructive")
  })

  it("loads the remote connections only when its submenu opens", async () => {
    await mountAndOpen()
    // Opening the root menu must not fetch — the list is submenu-scoped.
    expect(mocks.listRemoteWorkspaceConnections).not.toHaveBeenCalled()

    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Open remote workspace" })
    )
    expect(await screen.findByText("prod-box")).toBeVisible()
    expect(screen.getByText("https://lab.example")).toBeVisible()
    expect(mocks.listRemoteWorkspaceConnections).toHaveBeenCalledTimes(1)
  })

  it("opens the picked remote workspace and its manage dialog", async () => {
    await mountAndOpen()
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Open remote workspace" })
    )
    await userEvent.click(await screen.findByText("lab-box"))
    expect(mocks.openRemoteWorkspace).toHaveBeenCalledWith(12)

    await reopen()
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Open remote workspace" })
    )
    await clickItem("Manage remote workspace")
    expect(await screen.findByText("REMOTE-MANAGE-DIALOG")).toBeVisible()
  })

  it("opens the folder and clone dialogs from their rows", async () => {
    await mountAndOpen()
    await clickItem("Open Folder")
    expect(await screen.findByText("FOLDER-DIALOG")).toBeVisible()

    await reopen()
    await clickItem("Clone Repository")
    expect(await screen.findByText("CLONE-DIALOG")).toBeVisible()
  })
})
