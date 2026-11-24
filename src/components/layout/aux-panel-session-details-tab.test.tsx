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
  /** The summary of the transcript the runtime session loaded. */
  loadedSummary?: DbConversationSummary
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
  const sessions = new Map<number, unknown>()
  if (opts.loadedSummary) {
    sessions.set(opts.runtimeConversationId ?? 7, {
      detail: { summary: opts.loadedSummary, turns: [] },
      sessionStats: null,
      localTurns: [],
    })
  }
  mockRuntime.mockImplementation((sel: (s: RuntimeSlice) => unknown) =>
    sel({ byConversationId: sessions })
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

  it("leads its card with the agent's icon, its status a dot on it", () => {
    setupScene({ hasActiveConversation: true })
    const { getByTestId } = renderTab()
    const avatar = getByTestId("session-agent-avatar")
    // The icon stands on its own at the card's start; the name under the
    // title already says which agent it is, so it's hidden from assistive
    // tech.
    expect(avatar.closest("section")?.firstElementChild).toContainElement(
      avatar
    )
    expect(avatar).toContainElement(getByTestId("agent-icon"))
    expect(avatar).toHaveAttribute("aria-hidden", "true")
    // The status rides the icon's corner, as in the conversation list.
    expect(avatar.querySelector(".bg-yellow-400")).not.toBeNull()
    expect(avatar.parentElement).toHaveTextContent("My session")
  })

  it("puts the agent's name and the model under the title", () => {
    setupScene({ hasActiveConversation: true })
    const { getByText, getByTestId } = renderTab()
    const line = getByTestId("session-agent-line")
    expect(getByText("My session").nextElementSibling).toBe(line)
    expect(line).toContainElement(getByText("Claude Code"))
    expect(line).toContainElement(getByText("claude-opus-4-8"))
    // The status is only a dot on the icon; a screen reader hears it here.
    expect(within(line).getByText("Status: In Progress")).toHaveClass("sr-only")
  })

  it("says nothing of when the conversation last moved", () => {
    setupScene({ hasActiveConversation: true })
    const { queryByText } = renderTab()
    expect(queryByText(/ago$/)).toBeNull()
  })

  // The loaded transcript's summary is a snapshot of when it was fetched;
  // the status shown follows the workspace list's, which the backend's
  // status events keep current.
  it("follows the conversation's status past the loaded snapshot", () => {
    const loaded = summary({ status: "in_progress" })
    setupScene({ hasActiveConversation: true, loadedSummary: loaded })
    const { getByTestId, rerender } = renderTab()
    const line = () => getByTestId("session-agent-line")
    expect(line()).toHaveTextContent("Status: In Progress")
    setupScene({
      hasActiveConversation: true,
      loadedSummary: loaded,
      conversation: { status: "pending_review" },
    })
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <SessionDetailsTab />
      </NextIntlClientProvider>
    )
    expect(line()).toHaveTextContent("Status: Review")
  })

  it("lists the session's properties on its card", () => {
    setupScene({
      hasActiveConversation: true,
      conversation: { external_id: "5a1e3c9d-7b2f-4d8e-9a10-3c4b5d6e7f80" },
    })
    const { getAllByRole, getByTitle } = renderTab()
    const properties = getAllByRole("term").map((term) => [
      term.textContent,
      term.nextElementSibling?.textContent,
    ])
    // The agent's own id by its first segment; the whole one in its tooltip.
    expect(properties).toEqual([
      ["Git Branch", "main"],
      ["Session ID", "7"],
      ["Session Index", "5a1e3c9d"],
    ])
    expect(
      getByTitle("5a1e3c9d-7b2f-4d8e-9a10-3c4b5d6e7f80")
    ).toHaveTextContent("5a1e3c9d")
  })

  it("copies an id from its row", async () => {
    setupScene({
      hasActiveConversation: true,
      conversation: { external_id: "5a1e3c9d-7b2f-4d8e-9a10-3c4b5d6e7f80" },
    })
    const { getByRole } = renderTab()
    const copy = getByRole("button", { name: "Copy Session Index" })
    // Shown only while its cell is pointed at or focused.
    expect(copy).toHaveClass("opacity-0", "group-hover/prop:opacity-100")
    fireEvent.click(copy)
    expect(copyTextToClipboard).toHaveBeenCalledWith(
      "5a1e3c9d-7b2f-4d8e-9a10-3c4b5d6e7f80"
    )
    // It stays while it says the copy went through.
    await waitFor(() =>
      expect(getByRole("button", { name: "Copied Session Index" })).toHaveClass(
        "opacity-100"
      )
    )
  })

  it("adds the parent conversation when there is one", () => {
    setupScene({ hasActiveConversation: true, conversation: { parent_id: 3 } })
    const { getByText } = renderTab()
    const parent = getByText("Parent Session")
    expect(within(parent.parentElement!).getByText("3")).toBeInTheDocument()
  })

  it("spaces its cards as far apart as they are from its sides", () => {
    setupScene({ hasActiveConversation: true })
    const { getByTestId } = renderTab()
    const column = getByTestId("session-insights").parentElement
    expect(column).toHaveClass("p-3", "space-y-3")
    expect(column).toContainElement(getByTestId("session-agent-avatar"))
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
  // instead; the dialog still lists both. (The card says when the
  // conversation last moved, as a time ago.)
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
