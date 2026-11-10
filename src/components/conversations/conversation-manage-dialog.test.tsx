import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { ConversationManageDialog } from "./conversation-manage-dialog"
import enMessages from "@/i18n/messages/en.json"
import type {
  AcpAgentInfo,
  DbConversationSummary,
  FolderDetail,
} from "@/lib/types"
import { setCustomAgentDisplay } from "@/lib/custom-agents"

const h = vi.hoisted(() => ({
  listAll: vi.fn(),
  deleteConv: vi.fn(),
  updateStatus: vi.fn(),
  closeConversationTab: vi.fn(),
  refreshConversations: vi.fn(),
  folders: [] as FolderDetail[],
  agents: [] as Pick<
    AcpAgentInfo,
    "agent_type" | "name" | "enabled" | "available"
  >[],
}))

vi.mock("@/hooks/use-acp-agents", () => ({
  useAcpAgents: () => ({ agents: h.agents, fresh: true, refresh: vi.fn() }),
}))

// Inline SVG with a <title> would duplicate the agent label in text queries.
vi.mock("@/components/agent-icon", () => ({ AgentIcon: () => null }))

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock("@/lib/api", () => ({
  listAllConversations: h.listAll,
  deleteConversation: h.deleteConv,
  updateConversationStatus: h.updateStatus,
}))

vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({ closeConversationTab: h.closeConversationTab }),
}))

vi.mock("@/stores/app-workspace-store", () => ({
  useAppWorkspaceStore: (selector: (s: unknown) => unknown) =>
    selector({
      allFolders: h.folders,
      refreshConversations: h.refreshConversations,
    }),
}))

function folder(over: Partial<FolderDetail> & { id: number }): FolderDetail {
  return {
    name: `folder-${over.id}`,
    path: `/work/folder-${over.id}`,
    git_branch: null,
    default_agent_type: null,
    last_opened_at: "2026-06-01T00:00:00.000Z",
    sort_order: over.id,
    color: "#000000",
    parent_id: null,
    kind: "regular",
    alias: null,
    group_id: null,
    ...over,
  }
}

// 1 = the folder the dialog is opened on, 2 = its worktree child, 3 = another
// project, 4 = a hidden chat-mode folder.
const FOLDERS: FolderDetail[] = [
  folder({ id: 1, name: "alpha" }),
  folder({ id: 2, name: "alpha-feature", parent_id: 1 }),
  folder({ id: 3, name: "beta" }),
  folder({ id: 4, name: "chat", kind: "chat" }),
]

function conversation(
  over: Partial<DbConversationSummary> & { id: number }
): DbConversationSummary {
  return {
    folder_id: 1,
    title: `conversation ${over.id}`,
    title_locked: false,
    agent_type: "claude_code",
    status: "in_progress",
    kind: "regular",
    model: null,
    git_branch: "main",
    external_id: null,
    message_count: 12,
    child_count: 0,
    created_at: "2026-06-10T10:00:00.000Z",
    updated_at: "2026-06-10T10:00:00.000Z",
    pinned_at: null,
    ...over,
  }
}

const ROWS: DbConversationSummary[] = [
  conversation({ id: 1, title: "on main", git_branch: "main" }),
  conversation({ id: 2, title: "on feature", git_branch: "feature/x" }),
  conversation({
    id: 3,
    title: "branchless",
    git_branch: null,
    folder_id: 3,
  }),
]

function renderDialog() {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ConversationManageDialog open onOpenChange={vi.fn()} folderId={1} />
    </NextIntlClientProvider>
  )
  return userEvent.setup()
}

/** The last `list_all_conversations` request's folder scope. */
function lastQueryFolderIds(): number[] | null | undefined {
  const calls = h.listAll.mock.calls
  return calls[calls.length - 1]?.[0]?.folder_ids
}

/** A request whose resolution the test controls, to order two of them by hand. */
function defer<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** A row inside an open command palette (the trigger renders the same text). */
function paletteRow(text: string): HTMLElement {
  const row = screen
    .getAllByText(text)
    .map((el) => el.closest("[data-slot=command-item]"))
    .find(Boolean)
  if (!row) throw new Error(`no command row for "${text}"`)
  return row as HTMLElement
}

describe("ConversationManageDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.folders = FOLDERS
    h.agents = [
      {
        agent_type: "claude_code",
        name: "Claude Code",
        enabled: true,
        available: true,
      },
      {
        agent_type: "custom:claude-code-2",
        name: "Claude Code 2",
        enabled: true,
        available: true,
      },
      {
        agent_type: "custom:claude-code-3",
        name: "Review account",
        enabled: true,
        available: true,
      },
      {
        agent_type: "custom:codex-2",
        name: "Codex 2",
        enabled: false,
        available: false,
      },
    ]
    setCustomAgentDisplay(
      h.agents.map((a) => ({ agentType: a.agent_type, name: a.name }))
    )
    h.listAll.mockResolvedValue(ROWS)
  })

  it("offers configured custom agents by name and sends their exact filter id", async () => {
    const user = renderDialog()
    await screen.findByText("on main")
    await user.click(screen.getAllByRole("combobox")[0])

    expect(screen.getByRole("option", { name: "Claude Code 2" })).toBeTruthy()
    expect(screen.getByRole("option", { name: "Review account" })).toBeTruthy()
    expect(screen.getAllByRole("option", { name: "Claude Code" })).toHaveLength(
      1
    )
    // This is a history filter: disabling an agent must not hide its chats.
    expect(screen.getByRole("option", { name: "Codex 2" })).not.toHaveAttribute(
      "data-disabled"
    )
    await user.click(screen.getByRole("option", { name: "Claude Code 2" }))

    await waitFor(() =>
      expect(h.listAll).toHaveBeenLastCalledWith(
        expect.objectContaining({
          agent_type: "custom:claude-code-2",
          folder_ids: [1, 2],
        })
      )
    )
  })

  it("keeps a removed agent from saved chats selectable even when its filter returns no rows", async () => {
    h.listAll.mockResolvedValue([
      conversation({
        id: 4,
        title: "old custom chat",
        agent_type: "custom:retired-reviewer",
      }),
    ])
    const user = renderDialog()
    await screen.findByText("old custom chat")
    await user.click(screen.getAllByRole("combobox")[0])
    h.listAll.mockResolvedValue([])
    await user.click(screen.getByRole("option", { name: "Retired Reviewer" }))

    await waitFor(() =>
      expect(h.listAll).toHaveBeenLastCalledWith(
        expect.objectContaining({ agent_type: "custom:retired-reviewer" })
      )
    )
    await waitFor(() =>
      expect(screen.queryByText("old custom chat")).toBeNull()
    )
    const selected = screen.getAllByRole("combobox")[0]
    await user.click(selected)
    expect(
      screen.getByRole("option", { name: "Retired Reviewer" })
    ).toHaveAttribute("aria-selected", "true")
    await user.click(screen.getByRole("option", { name: "All agents" }))
    await waitFor(() =>
      expect(h.listAll).toHaveBeenLastCalledWith(
        expect.objectContaining({ agent_type: null })
      )
    )
  })

  it("shows each conversation's branch in place of its message count", async () => {
    renderDialog()
    await screen.findByText("on main")

    expect(screen.getByText("feature/x")).toBeTruthy()
    // The count the branch replaced is gone (rows carry message_count: 12).
    expect(screen.queryByText("12 msg")).toBeNull()
    // A conversation with no branch recorded reads as a dash, not a blank.
    expect(screen.getByTitle("No branch")).toBeTruthy()
  })

  it("opens scoped to the folder it was invoked on, plus that folder's worktrees", async () => {
    renderDialog()
    await screen.findByText("on main")

    // Worktree conversations keep `folder_id = the worktree folder`, so the
    // parent alone would drop them.
    expect(lastQueryFolderIds()).toEqual([1, 2])
  })

  it("re-queries when the folder facet moves to another project", async () => {
    const user = renderDialog()
    await screen.findByText("on main")

    await user.click(screen.getByRole("button", { name: /alpha/ }))
    await user.click(paletteRow("beta"))

    await waitFor(() => expect(lastQueryFolderIds()).toEqual([3]))
  })

  it("widens to every folder a scope can name — never the hidden chat folders", async () => {
    const user = renderDialog()
    await screen.findByText("on main")

    await user.click(screen.getByRole("button", { name: /alpha/ }))
    await user.click(paletteRow("All folders"))

    await waitFor(() => expect(lastQueryFolderIds()).toEqual([1, 2, 3]))
  })

  it("drops a reply that lands after its folder scope moved on", async () => {
    const inAlpha = defer<DbConversationSummary[]>()
    const inBeta = defer<DbConversationSummary[]>()
    h.listAll
      .mockReturnValueOnce(inAlpha.promise)
      .mockReturnValueOnce(inBeta.promise)

    const user = renderDialog()
    await waitFor(() => expect(h.listAll).toHaveBeenCalledTimes(1))

    await user.click(screen.getByRole("button", { name: /alpha/ }))
    await user.click(paletteRow("beta"))
    await waitFor(() => expect(h.listAll).toHaveBeenCalledTimes(2))

    // beta answers first, then alpha's slower request finally lands.
    inBeta.resolve([conversation({ id: 9, title: "in beta", folder_id: 3 })])
    await screen.findByText("in beta")
    inAlpha.resolve(ROWS)
    await new Promise((r) => setTimeout(r, 50))

    // The stale reply must not repopulate the list: it would put alpha's
    // conversations under beta's scope, where Delete would then act on them.
    expect(screen.queryByText("on main")).toBeNull()
    expect(screen.getByText("in beta")).toBeTruthy()
  })

  it("asks for nothing when the scope covers no folder at all", async () => {
    // No folders in the workspace: an empty id list would read as "every
    // non-deleted folder" on the backend — the hidden chat folders included.
    h.folders = []
    const user = renderDialog()
    await waitFor(() => expect(h.listAll).toHaveBeenCalledTimes(1))

    await user.click(screen.getByRole("button", { name: /#1/ }))
    await user.click(paletteRow("All folders"))

    await waitFor(() =>
      expect(
        screen.getByText("No conversations in the workspace.")
      ).toBeTruthy()
    )
    expect(h.listAll).toHaveBeenCalledTimes(1)
  })

  it("keeps the folder it was opened on selectable even when it is a worktree", async () => {
    // Under "Show worktrees" a worktree child draws its own header, and so its
    // own "manage conversations" entry — the picker lists only top-level repos.
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ConversationManageDialog open onOpenChange={vi.fn()} folderId={2} />
      </NextIntlClientProvider>
    )
    const user = userEvent.setup()
    await waitFor(() => expect(lastQueryFolderIds()).toEqual([2]))

    const trigger = screen.getByRole("button", { name: /alpha-feature/ })
    await user.click(trigger)
    await user.click(paletteRow("All folders"))
    await waitFor(() => expect(lastQueryFolderIds()).toEqual([1, 2, 3]))

    // ...and it is still there to go back to.
    await user.click(screen.getByRole("button", { name: /All folders/ }))
    await user.click(paletteRow("alpha-feature"))
    await waitFor(() => expect(lastQueryFolderIds()).toEqual([2]))
  })

  it("filters by branch without a round-trip, from the branches the rows use", async () => {
    const user = renderDialog()
    await screen.findByText("on main")
    const callsBefore = h.listAll.mock.calls.length

    await user.click(screen.getByRole("button", { name: /All branches/ }))
    // Each branch is offered with the number of conversations on it.
    expect(paletteRow("feature/x").textContent).toContain("1")
    await user.click(paletteRow("feature/x"))

    expect(screen.getByText("on feature")).toBeTruthy()
    expect(screen.queryByText("on main")).toBeNull()
    expect(screen.getByText("1 matched")).toBeTruthy()
    // Past the fetch debounce: the facet is applied to the rows in hand.
    await new Promise((r) => setTimeout(r, 350))
    expect(h.listAll.mock.calls.length).toBe(callsBefore)
  })

  it("folds branches that share a `/` prefix under one header", async () => {
    h.listAll.mockResolvedValue([
      conversation({ id: 1, title: "on 49", git_branch: "task/49" }),
      conversation({ id: 2, title: "on 50", git_branch: "task/50" }),
      conversation({ id: 3, title: "on trunk", git_branch: "main" }),
    ])
    const user = renderDialog()
    await screen.findByText("on 49")

    await user.click(screen.getByRole("button", { name: /All branches/ }))

    // The shared prefix becomes one header carrying both branches, folded — so
    // one `task/` group can't bury a plain branch below a scroll.
    expect(paletteRow("task/").textContent).toContain("2")
    expect(screen.queryByText("49")).toBeNull()
    // A branch that shares no prefix stays whole, and visible.
    expect(paletteRow("main")).toBeTruthy()

    // Opening the group shows each leaf under only what is left of its name.
    await user.click(paletteRow("task/"))
    expect(paletteRow("49")).toBeTruthy()
    expect(paletteRow("50")).toBeTruthy()

    await user.click(paletteRow("49"))
    expect(screen.getByText("on 49")).toBeTruthy()
    expect(screen.queryByText("on 50")).toBeNull()
  })

  it("re-opens onto the picked branch's group rather than hiding its check", async () => {
    h.listAll.mockResolvedValue([
      conversation({ id: 1, title: "on 49", git_branch: "task/49" }),
      conversation({ id: 2, title: "on 50", git_branch: "task/50" }),
    ])
    const user = renderDialog()
    await screen.findByText("on 49")

    await user.click(screen.getByRole("button", { name: /All branches/ }))
    await user.click(paletteRow("task/"))
    await user.click(paletteRow("49"))

    // Folds reset on each open — but a default fold over the current selection
    // would read as "nothing is picked".
    await user.click(screen.getByRole("button", { name: /task\/49/ }))
    expect(paletteRow("49")).toBeTruthy()
  })

  it("flattens to whole branch names while searching", async () => {
    h.listAll.mockResolvedValue([
      conversation({ id: 1, title: "on 49", git_branch: "task/49" }),
      conversation({ id: 2, title: "on 50", git_branch: "task/50" }),
    ])
    const user = renderDialog()
    await screen.findByText("on 49")

    await user.click(screen.getByRole("button", { name: /All branches/ }))
    await user.type(screen.getByPlaceholderText(/Search branches/), "49")

    // No group left to hide a match behind, so the row names the whole ref.
    expect(screen.queryByText("task/")).toBeNull()
    expect(paletteRow("task/49")).toBeTruthy()
    expect(screen.queryByText("50")).toBeNull()
  })

  it("isolates the conversations that carry no branch at all", async () => {
    const user = renderDialog()
    await screen.findByText("on main")

    await user.click(screen.getByRole("button", { name: /All branches/ }))
    await user.click(paletteRow("No branch"))

    expect(screen.getByText("branchless")).toBeTruthy()
    expect(screen.queryByText("on main")).toBeNull()
  })

  it("drops a branch facet the new folder scope knows nothing about", async () => {
    const user = renderDialog()
    await screen.findByText("on main")

    await user.click(screen.getByRole("button", { name: /All branches/ }))
    await user.click(paletteRow("feature/x"))
    expect(screen.queryByText("on main")).toBeNull()

    h.listAll.mockResolvedValue([conversation({ id: 9, title: "in beta" })])
    await user.click(screen.getByRole("button", { name: /alpha/ }))
    await user.click(paletteRow("beta"))

    // Not an empty list under "feature/x", a branch the new scope never had.
    await screen.findByText("in beta")
    expect(screen.getByRole("button", { name: /All branches/ })).toBeTruthy()
  })

  it("names the owning folder on every row once the scope spans folders", async () => {
    const user = renderDialog()
    await screen.findByText("on main")
    // Scoped to one folder the column is redundant, so it isn't drawn.
    expect(screen.queryByText("beta")).toBeNull()

    await user.click(screen.getByRole("button", { name: /alpha/ }))
    await user.click(paletteRow("All folders"))

    await waitFor(() => expect(screen.getByText("beta")).toBeTruthy())
  })

  it("closes the tabs of selected conversations the facets have since hidden", async () => {
    const user = renderDialog()
    await screen.findByText("on main")

    await user.click(screen.getByText("on main"))
    await user.click(screen.getByRole("button", { name: /All branches/ }))
    await user.click(paletteRow("feature/x"))
    // Out of view, still selected — and still what Delete acts on.
    expect(screen.getByText("1 selected")).toBeTruthy()

    await user.click(screen.getByRole("button", { name: "Delete" }))
    await user.click(screen.getByRole("button", { name: "Confirm" }))

    await waitFor(() => expect(h.deleteConv).toHaveBeenCalledWith(1))
    expect(h.closeConversationTab).toHaveBeenCalledWith(1, 1, "claude_code")
  })
})
