import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import {
  automationRunNow,
  automationSetEnabled,
  automationDelete,
} from "@/lib/api"
import type { Automation } from "@/lib/types"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"

// ── Context + side-effect mocks ────────────────────────────────────────────
const refetch = vi.fn().mockResolvedValue(undefined)
let automations: Automation[] = []

vi.mock("@/contexts/automations-view-context", () => ({
  useAutomationsView: () => ({ automations, unseenFailures: 0, refetch }),
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({ openConversations: vi.fn() }),
}))
vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({ openTab: vi.fn() }),
}))
vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn().mockResolvedValue(() => {}),
  onTransportReconnect: vi.fn(() => () => {}),
}))
vi.mock("@/lib/api", () => ({
  automationMarkSeen: vi.fn().mockResolvedValue(undefined),
  automationCreate: vi.fn(),
  automationUpdate: vi.fn(),
  automationDelete: vi.fn(),
  automationRunNow: vi.fn(),
  automationSetEnabled: vi.fn(),
  automationCancelRun: vi.fn(),
  automationRuns: vi.fn().mockResolvedValue([]),
}))

// Stub the heavy editor (AgentSelector / config probing) — surface only the
// seeded automation name and the back affordance so we can assert page wiring.
vi.mock("./automation-editor", () => ({
  AutomationEditor: ({
    automation,
    onBackToTemplates,
  }: {
    automation: { name?: string } | null
    onBackToTemplates?: () => void
  }) => (
    <div>
      <div data-testid="editor-name">{automation?.name ?? "<blank>"}</div>
      {onBackToTemplates ? (
        <button type="button" onClick={onBackToTemplates}>
          back-link
        </button>
      ) : null}
    </div>
  ),
}))

import { AutomationsPage } from "./automations-page"

// Components select `folders` from the real zustand store — seed it with the
// same data the old context mock provided.
beforeEach(() => {
  resetAppWorkspaceStore()
  useAppWorkspaceStore.setState({
    folders: [{ id: 1, name: "repo" }] as never,
  })
})

function renderPage() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <AutomationsPage />
    </NextIntlClientProvider>
  )
}

describe("AutomationsPage (empty + template flow)", () => {
  beforeEach(() => {
    automations = []
    vi.clearAllMocks()
  })

  it("shows the onboarding gallery when there are no automations", () => {
    renderPage()
    expect(
      screen.getByText(enMessages.Automations.onboardTitle)
    ).toBeInTheDocument()
    expect(screen.getByText("Blank automation")).toBeInTheDocument()
    expect(
      screen.getByText(enMessages.Automations.tplCodeReviewTitle)
    ).toBeInTheDocument()
  })

  it("seeds the editor with the template name when a template is picked", () => {
    renderPage()
    fireEvent.click(screen.getByText(enMessages.Automations.tplCodeReviewTitle))
    expect(screen.getByTestId("editor-name")).toHaveTextContent(
      enMessages.Automations.tplCodeReviewTitle
    )
    // Reached via the gallery, so the back-to-templates link is present.
    expect(screen.getByText("back-link")).toBeInTheDocument()
  })

  it("opens a blank editor when the Blank card is picked", () => {
    renderPage()
    fireEvent.click(screen.getByText("Blank automation"))
    expect(screen.getByTestId("editor-name")).toHaveTextContent("<blank>")
  })

  it("returns to the gallery from the editor via back-to-templates", () => {
    renderPage()
    fireEvent.click(screen.getByText(enMessages.Automations.tplCodeReviewTitle))
    expect(screen.getByTestId("editor-name")).toBeInTheDocument()
    fireEvent.click(screen.getByText("back-link"))
    // Gallery is shown again (onboarding hero + blank card).
    expect(screen.getByText("Blank automation")).toBeInTheDocument()
    expect(screen.queryByTestId("editor-name")).not.toBeInTheDocument()
  })
})

const FIXTURE: Automation = {
  id: 7,
  name: "Nightly sweep",
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
  config: {
    prompt_blocks: [{ type: "text", text: "do the thing" }],
    display_text: "do the thing",
    config_values: {},
  },
  last_run_at: null,
  last_run_status: null,
  last_run_conversation_id: null,
  unseen_failures: 0,
  created_at: "2026-06-01T00:00:00Z",
  updated_at: "2026-06-01T00:00:00Z",
}

describe("AutomationsPage (master-detail)", () => {
  beforeEach(() => {
    automations = [FIXTURE]
    vi.clearAllMocks()
  })

  it("can open the gallery from New and cancel back to the detail", () => {
    renderPage()
    // Detail of the only automation is shown (name appears in list + detail).
    expect(screen.getAllByText("Nightly sweep").length).toBeGreaterThan(0)
    // Enter the gallery, then cancel back.
    fireEvent.click(screen.getByText(enMessages.Automations.new))
    expect(
      screen.getByText(enMessages.Automations.startFromTemplate)
    ).toBeInTheDocument()
    fireEvent.click(screen.getByText(enMessages.Automations.cancel))
    // Back to detail; the gallery heading is gone.
    expect(screen.getAllByText("Nightly sweep").length).toBeGreaterThan(0)
    expect(
      screen.queryByText(enMessages.Automations.startFromTemplate)
    ).not.toBeInTheDocument()
  })

  // `label_snapshot` freezes whatever the agent called these at save time —
  // including its language, for an agent that hardcodes one. The detail has the
  // stable ids too, so it resolves from those and keeps the frozen label only
  // as a fallback.
  it("localises a frozen DeepSeek label snapshot from the ids beside it", () => {
    automations = [
      {
        ...FIXTURE,
        agent_type: "deepseek",
        config: {
          prompt_blocks: [{ type: "text", text: "do the thing" }],
          display_text: "do the thing",
          mode_id: "plan",
          config_values: { sandbox: "read-only", model: "deepseek-flash" },
          label_snapshot: {
            mode_label: "计划",
            config_labels: {
              sandbox: "只读",
              model: "深度求索 Flash",
            },
          },
        },
      },
    ]
    renderPage()
    expect(screen.getByText("Plan")).toBeInTheDocument()
    expect(screen.getByText("Read-only")).toBeInTheDocument()
    expect(screen.queryByText("只读")).not.toBeInTheDocument()
    // The model catalogue is the user's own data, so its frozen label stands.
    expect(screen.getByText("深度求索 Flash")).toBeInTheDocument()
  })

  it("keeps the header switch and surfaces Run now + Edit under the title", () => {
    renderPage()
    // The detail title row exposes only the enable toggle...
    expect(screen.getByRole("switch")).toBeInTheDocument()
    // ...the per-row ⋯ menu carries the full action set...
    expect(
      screen.getByLabelText(enMessages.Automations.moreActions)
    ).toBeInTheDocument()
    // ...and the primary actions sit on their own row under the title.
    expect(
      screen.getByRole("button", { name: enMessages.Automations.runNow })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: enMessages.Automations.edit })
    ).toBeInTheDocument()
  })

  // Open the per-row ⋯ menu. Radix opens its menu on pointerdown, which
  // user-event's click doesn't drive through this particular tree under jsdom
  // (real browsers open on click fine); the keyboard path is deterministic and
  // exercises the same menu wiring.
  async function openRowMenu(user: ReturnType<typeof userEvent.setup>) {
    const trigger = screen.getByLabelText(enMessages.Automations.moreActions)
    trigger.focus()
    await user.keyboard("{Enter}")
  }

  it("runs an automation from the list ⋯ menu", async () => {
    const user = userEvent.setup()
    renderPage()
    await openRowMenu(user)
    await user.click(
      await screen.findByRole("menuitem", {
        name: enMessages.Automations.runNow,
      })
    )
    await waitFor(() =>
      expect(vi.mocked(automationRunNow)).toHaveBeenCalledWith(7)
    )
  })

  it("toggles enabled from the list ⋯ menu (enabled → disable)", async () => {
    const user = userEvent.setup()
    renderPage()
    await openRowMenu(user)
    // FIXTURE is enabled, so the toggle reads "Disable" and flips it off.
    await user.click(
      await screen.findByRole("menuitem", {
        name: enMessages.Automations.disable,
      })
    )
    await waitFor(() =>
      expect(vi.mocked(automationSetEnabled)).toHaveBeenCalledWith(7, false)
    )
  })

  it("confirms before deleting from the list ⋯ menu", async () => {
    const user = userEvent.setup()
    renderPage()
    await openRowMenu(user)
    await user.click(
      await screen.findByRole("menuitem", {
        name: enMessages.Automations.delete,
      })
    )
    // A confirm dialog gates the destructive action.
    const confirm = await screen.findByRole("alertdialog")
    await user.click(
      within(confirm).getByRole("button", {
        name: enMessages.Automations.delete,
      })
    )
    await waitFor(() =>
      expect(vi.mocked(automationDelete)).toHaveBeenCalledWith(7)
    )
  })

  it("runs the automation from the detail Run now button", async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(
      screen.getByRole("button", { name: enMessages.Automations.runNow })
    )
    await waitFor(() =>
      expect(vi.mocked(automationRunNow)).toHaveBeenCalledWith(7)
    )
  })

  it("opens the editor from the detail Edit button", async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(
      screen.getByRole("button", { name: enMessages.Automations.edit })
    )
    expect(screen.getByTestId("editor-name")).toHaveTextContent("Nightly sweep")
  })
})
