import { fireEvent, render, waitFor, within } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest"

import type { DbConversationSummary } from "@/lib/types"
import enMessages from "@/i18n/messages/en.json"

// Regression guard: the branch selector + command launcher were REMOVED from
// this tab — they live in the bottom status bar now, on every platform. Stub
// them so that if either is ever re-added here, its test id surfaces and the
// "no actions bar" assertions below fail.
vi.mock("./branch-dropdown", () => ({
  BranchDropdown: () => <div data-testid="branch-dropdown" />,
}))
vi.mock("./command-dropdown", () => ({
  CommandDropdown: () => <div data-testid="command-dropdown" />,
}))
// The agent icon renders inline SVG with a <title> that duplicates the label;
// the stub only marks where it sits.
vi.mock("@/components/agent-icon", () => ({
  AgentIcon: () => <span data-testid="agent-icon" />,
}))
// Stats are always supplied here, so the cold-fetch path must never fire; stub
// the API so an accidental call is inert rather than a real transport hit.
vi.mock("@/lib/api", () => ({ getFolderConversation: vi.fn() }))
const { copyTextToClipboard } = vi.hoisted(() => ({
  copyTextToClipboard: vi.fn(async () => true),
}))
vi.mock("@/lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/utils")>()),
  copyTextToClipboard,
}))

// The insights sections have their own tests; here, only what they're handed.
const insightsProps = vi.hoisted(
  () => [] as Array<{ conversationId: number | null; active: boolean }>
)
vi.mock("./session-details-insights", () => ({
  SessionDetailsInsights: (props: {
    conversationId: number | null
    active: boolean
  }) => {
    insightsProps.push(props)
    return <div data-testid="session-insights" />
  },
}))

vi.mock("@/contexts/aux-panel-context", () => ({ useAuxPanelContext: vi.fn() }))
vi.mock("@/contexts/tab-context", () => ({ useTabStore: vi.fn() }))
vi.mock("@/stores/conversation-runtime-store", () => ({
  useConversationRuntimeStore: vi.fn(),
}))
vi.mock("@/stores/app-workspace-store", () => ({
  useAppWorkspaceStore: vi.fn(),
}))

import { SessionDetailsTab } from "./aux-panel-session-details-tab"
import { useAuxPanelContext } from "@/contexts/aux-panel-context"
import { useTabStore } from "@/contexts/tab-context"
import { useConversationRuntimeStore } from "@/stores/conversation-runtime-store"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"

const mockAux = useAuxPanelContext as unknown as Mock
const mockTabs = useTabStore as unknown as Mock
const mockRuntime = useConversationRuntimeStore as unknown as Mock
const mockWorkspace = useAppWorkspaceStore as unknown as Mock

type TabSlice = {
  tabs: Array<{
    id: number
    conversationId: number | null
    runtimeConversationId?: number
  }>
  activeTabId: number | null
}
type RuntimeSlice = { byConversationId: Map<number, unknown> }
type WorkspaceSlice = { conversations: DbConversationSummary[] }

function summary(
  over: Partial<DbConversationSummary> = {}
): DbConversationSummary {
  return {
    id: 7,
    folder_id: 1,
    title: "My session",
    title_locked: false,
    agent_type: "claude_code",
    status: "in_progress",
    kind: "regular",
    model: "claude-opus-4-8",
    git_branch: "main",
    external_id: "ext-abc",
    message_count: 12,
    child_count: 0,
    created_at: "2026-06-10T10:00:00.000Z",
    updated_at: "2026-06-12T12:00:00.000Z",
    pinned_at: null,
    ...over,
  }
}

function setupScene(opts: {
  hasActiveConversation: boolean
  runtimeConversationId?: number
  activeTab?: string
  conversation?: Partial<DbConversationSummary>
}) {
  mockAux.mockReturnValue({
    isOpen: true,
    activeTab: opts.activeTab ?? "session_details",
  })

  const tabState: TabSlice = {
    tabs: opts.hasActiveConversation
      ? [
          {
            id: 1,
            conversationId: 7,
            runtimeConversationId: opts.runtimeConversationId,
          },
        ]
      : [],
    activeTabId: opts.hasActiveConversation ? 1 : null,
  }
  mockTabs.mockImplementation((sel: (s: TabSlice) => unknown) => sel(tabState))
  mockRuntime.mockImplementation((sel: (s: RuntimeSlice) => unknown) =>
    sel({ byConversationId: new Map() })
  )
  mockWorkspace.mockImplementation((sel: (s: WorkspaceSlice) => unknown) =>
    sel({
      conversations: opts.hasActiveConversation
        ? [summary(opts.conversation)]
        : [],
    })
  )
}

/** What the insights were rendered with last. */
function lastInsightsProps() {
  return insightsProps[insightsProps.length - 1]
}

function renderTab() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SessionDetailsTab />
    </NextIntlClientProvider>
  )
}

describe("SessionDetailsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    insightsProps.length = 0
  })

  it("renders the active session's details with no folder-actions bar", () => {
    // Branch + command moved to the bottom status bar on every platform, so the
    // tab shows the details alone — no branch/command controls here.
    setupScene({ hasActiveConversation: true })
    const { getByText, queryByTestId } = renderTab()
    expect(getByText("My session")).toBeTruthy()
    expect(getByText("Claude Code")).toBeTruthy()
    expect(queryByTestId("branch-dropdown")).toBeNull()
    expect(queryByTestId("command-dropdown")).toBeNull()
  })

  it("opens its card with the title, the agent's icon by its name under it", () => {
    setupScene({ hasActiveConversation: true })
    const { getByText, getByTestId } = renderTab()
    const title = getByText("My session")
    // Nothing shares the title's row.
    expect(title.closest("section")?.firstElementChild).toBe(title)
    const agentLine = title.nextElementSibling as HTMLElement
    expect(agentLine).toContainElement(getByText("Claude Code"))
    // The icon leads the agent's name; the name already says it, so it's
    // hidden from assistive tech.
    const icon = getByTestId("agent-icon")
    expect(agentLine.firstElementChild).toContainElement(icon)
    expect(icon.closest('[aria-hidden="true"]')).not.toBeNull()
  })

  it("lists the session's properties on its card", () => {
    setupScene({
      hasActiveConversation: true,
      conversation: { external_id: "5a1e3c9d-7b2f-4d8e-9a10-3c4b5d6e7f80" },
    })
    const { getByText, getAllByRole } = renderTab()
    const properties = getAllByRole("term").map((term) => [
      term.textContent,
      term.nextElementSibling?.textContent,
    ])
    expect(properties).toEqual([
      ["Model", "claude-opus-4-8"],
      ["Git Branch", "main"],
      ["Session ID", "7"],
      ["Extension ID", "5a1e3c9d-7b2f-4d8e-9a10-3c4b5d6e7f80"],
    ])
    // The status sits by the agent.
    expect(getByText("In Progress")).toBeInTheDocument()
  })

  it("copies an id from its row", async () => {
    setupScene({
      hasActiveConversation: true,
      conversation: { external_id: "5a1e3c9d-7b2f-4d8e-9a10-3c4b5d6e7f80" },
    })
    const { getByRole } = renderTab()
    fireEvent.click(getByRole("button", { name: "Copy Extension ID" }))
    expect(copyTextToClipboard).toHaveBeenCalledWith(
      "5a1e3c9d-7b2f-4d8e-9a10-3c4b5d6e7f80"
    )
    await waitFor(() =>
      expect(
        getByRole("button", { name: "Copied Extension ID" })
      ).toBeInTheDocument()
    )
  })

  it("adds the parent conversation when there is one", () => {
    setupScene({ hasActiveConversation: true, conversation: { parent_id: 3 } })
    const { getByText } = renderTab()
    const parent = getByText("Parent Session")
    expect(within(parent.parentElement!).getByText("3")).toBeInTheDocument()
  })

  it("shows the empty state when there is no active session", () => {
    setupScene({ hasActiveConversation: false })
    const { getByText, queryByTestId } = renderTab()
    expect(getByText("No active session")).toBeTruthy()
    expect(queryByTestId("branch-dropdown")).toBeNull()
    expect(queryByTestId("command-dropdown")).toBeNull()
    expect(queryByTestId("session-insights")).toBeNull()
  })

  // The panel follows the conversation's plan, sub-agents and messages
  // instead; the dialog still lists both.
  it("leaves out token usage and timestamps", () => {
    setupScene({ hasActiveConversation: true })
    const { queryByText } = renderTab()
    expect(queryByText("Token Usage")).toBeNull()
    expect(queryByText("Timestamps")).toBeNull()
    expect(queryByText("Created")).toBeNull()
    expect(queryByText("Updated")).toBeNull()
  })

  it("shows the active conversation's insights", () => {
    setupScene({ hasActiveConversation: true })
    const { getByTestId } = renderTab()
    expect(getByTestId("session-insights")).toBeTruthy()
    expect(lastInsightsProps()).toEqual({ conversationId: 7, active: true })
  })

  // A conversation started in this tab streams — and publishes — under its
  // virtual runtime id.
  it("reads the insights under the tab's runtime conversation id", () => {
    setupScene({ hasActiveConversation: true, runtimeConversationId: -42 })
    renderTab()
    expect(lastInsightsProps()?.conversationId).toBe(-42)
  })

  it("tells the insights when another tab is showing", () => {
    setupScene({ hasActiveConversation: true, activeTab: "file_tree" })
    renderTab()
    expect(lastInsightsProps()?.active).toBe(false)
  })
})
