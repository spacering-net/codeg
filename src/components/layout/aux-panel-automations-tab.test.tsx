/**
 * The aux panel's automations tab: the active project's automations (its root
 * and its worktrees), a drill-down into one, and the hand-off to the full
 * Automations page for creating and editing.
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { Automation } from "@/lib/types"
import { peekAutomationsFocus } from "@/lib/workbench-focus"

const scene = vi.hoisted(() => ({
  projectFolderId: 1 as number | null,
  automations: [] as Automation[],
  refetch: vi.fn(async () => {}),
  setRoute: vi.fn(),
  setOpen: vi.fn(),
  mobile: false,
}))

vi.mock("@/contexts/automations-view-context", () => ({
  useAutomationsView: () => ({
    automations: scene.automations,
    unseenFailures: 0,
    refetch: scene.refetch,
  }),
}))
vi.mock("@/hooks/use-active-project-folder", () => ({
  useActiveProjectFolderId: () => scene.projectFolderId,
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({ setRoute: scene.setRoute }),
}))
vi.mock("@/contexts/aux-panel-context", () => ({
  useAuxPanelContext: () => ({ setOpen: scene.setOpen }),
}))
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => scene.mobile }))
vi.mock("@/stores/app-workspace-store", () => {
  const state = {
    allFolders: [
      {
        id: 1,
        name: "codeg",
        alias: "Codeg",
        parent_id: null,
        kind: "regular",
      },
      // A worktree of project 1.
      { id: 11, name: "codeg-wt", alias: null, parent_id: 1, kind: "regular" },
      { id: 2, name: "site", alias: null, parent_id: null, kind: "regular" },
    ],
  }
  const useStore = (selector: (s: typeof state) => unknown) => selector(state)
  return { useAppWorkspaceStore: useStore }
})
vi.mock("@/lib/api", () => ({
  automationDelete: vi.fn(async () => {}),
  automationRunNow: vi.fn(async () => {}),
  automationSetEnabled: vi.fn(async () => {}),
}))
// The page's own row and detail are covered by its suite; here they only
// expose the callbacks the tab wires.
vi.mock("@/components/automations/automations-page", () => ({
  AutomationListItem: ({
    automation,
    onSelect,
    onRunNow,
    onEdit,
  }: {
    automation: Automation
    onSelect: () => void
    onRunNow: () => void
    onEdit: () => void
  }) => (
    <li>
      <button type="button" onClick={onSelect}>
        {automation.name}
      </button>
      <button type="button" onClick={onRunNow}>
        {`run ${automation.id}`}
      </button>
      <button type="button" onClick={onEdit}>
        {`edit ${automation.id}`}
      </button>
    </li>
  ),
  AutomationDetail: ({
    automation,
    onEdit,
    onConversationOpened,
  }: {
    automation: Automation
    onEdit: () => void
    onConversationOpened?: () => void
  }) => (
    <div>
      <h2>{`detail ${automation.name}`}</h2>
      <button type="button" onClick={onEdit}>
        detail-edit
      </button>
      <button type="button" onClick={() => onConversationOpened?.()}>
        open-run
      </button>
    </div>
  ),
}))

import { automationRunNow } from "@/lib/api"
import { AutomationsAuxTab } from "./aux-panel-automations-tab"

function automation(overrides: Partial<Automation>): Automation {
  return {
    id: 1,
    name: "untitled",
    enabled: true,
    trigger_kind: "manual",
    cron: null,
    timezone: "UTC",
    next_run_at: null,
    agent_type: "claude_code",
    root_folder_id: 1,
    isolation: "worktree_per_run",
    branch: null,
    is_remote_branch: false,
    config: null,
    last_run_at: null,
    last_run_status: null,
    last_run_conversation_id: null,
    unseen_failures: 0,
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
    ...overrides,
  }
}

function Tab() {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <AutomationsAuxTab />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  scene.projectFolderId = 1
  scene.mobile = false
  scene.setRoute.mockClear()
  scene.setOpen.mockClear()
  scene.refetch.mockClear()
  vi.mocked(automationRunNow).mockClear()
  scene.automations = [
    automation({ id: 7, name: "Nightly sweep", root_folder_id: 1 }),
    automation({ id: 8, name: "Worktree lint", root_folder_id: 11 }),
    automation({ id: 9, name: "Weekly triage", root_folder_id: 2 }),
    automation({ id: 10, name: "Folderless", root_folder_id: null }),
  ]
})

describe("AutomationsAuxTab", () => {
  it("lists the project's automations, its worktrees' included", () => {
    render(<Tab />)
    expect(screen.getByText("Codeg")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Nightly sweep" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Worktree lint" })
    ).toBeInTheDocument()
    expect(screen.queryByText("Weekly triage")).not.toBeInTheDocument()
    expect(screen.queryByText("Folderless")).not.toBeInTheDocument()
  })

  it("runs one from its row and refreshes the list", async () => {
    const user = userEvent.setup()
    render(<Tab />)
    await user.click(screen.getByRole("button", { name: "run 7" }))
    expect(automationRunNow).toHaveBeenCalledWith(7)
    expect(scene.refetch).toHaveBeenCalled()
  })

  it("drills into one and back", async () => {
    const user = userEvent.setup()
    render(<Tab />)
    await user.click(screen.getByRole("button", { name: "Worktree lint" }))
    expect(
      screen.getByRole("heading", { name: "detail Worktree lint" })
    ).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Back" }))
    expect(
      screen.getByRole("button", { name: "Nightly sweep" })
    ).toBeInTheDocument()
  })

  it("hands editing to the full page, on the automation's own folder", async () => {
    const user = userEvent.setup()
    render(<Tab />)
    await user.click(screen.getByRole("button", { name: "edit 8" }))
    // The worktree folder, not the root: the page filters by exact folder,
    // and the automation must be in the list it opens on.
    expect(peekAutomationsFocus()).toEqual({
      folderId: 11,
      automationId: 8,
      intent: "edit",
    })
    expect(scene.setRoute).toHaveBeenCalledWith("automations")
  })

  it("opens the full page from the detail on that automation", async () => {
    const user = userEvent.setup()
    render(<Tab />)
    await user.click(screen.getByRole("button", { name: "Nightly sweep" }))
    await user.click(screen.getByRole("button", { name: "Open full page" }))
    expect(peekAutomationsFocus()).toEqual({ folderId: 1, automationId: 7 })

    await user.click(screen.getByRole("button", { name: "detail-edit" }))
    expect(peekAutomationsFocus()).toEqual({
      folderId: 1,
      automationId: 7,
      intent: "edit",
    })
  })

  it("creates on the full page, in this project", async () => {
    const user = userEvent.setup()
    render(<Tab />)
    await user.click(screen.getByRole("button", { name: "New automation" }))
    expect(peekAutomationsFocus()).toEqual({ folderId: 1, intent: "create" })
    expect(scene.setRoute).toHaveBeenCalledWith("automations")
  })

  it("leaves the drill-down when the conversation moves to another project", async () => {
    const user = userEvent.setup()
    const { rerender } = render(<Tab />)
    await user.click(screen.getByRole("button", { name: "Nightly sweep" }))
    scene.projectFolderId = 2
    rerender(<Tab />)
    expect(
      screen.getByRole("button", { name: "Weekly triage" })
    ).toBeInTheDocument()
    // And coming back lands on the list, not on the detail left behind.
    scene.projectFolderId = 1
    rerender(<Tab />)
    expect(
      screen.queryByRole("heading", { name: /^detail/ })
    ).not.toBeInTheDocument()
  })

  it("gets the drawer out of the way of a run it opened, on a phone", async () => {
    const user = userEvent.setup()
    scene.mobile = true
    render(<Tab />)
    await user.click(screen.getByRole("button", { name: "Nightly sweep" }))
    await user.click(screen.getByRole("button", { name: "open-run" }))
    expect(scene.setOpen).toHaveBeenCalledWith(false)
  })

  it("offers the first automation on a project that has none", async () => {
    const user = userEvent.setup()
    scene.automations = []
    render(<Tab />)
    expect(
      screen.getByText(enMessages.Folder.auxPanel.noAutomations)
    ).toBeInTheDocument()
    const buttons = screen.getAllByRole("button", { name: "New automation" })
    await user.click(buttons[buttons.length - 1])
    expect(peekAutomationsFocus()).toEqual({ folderId: 1, intent: "create" })
  })
})
