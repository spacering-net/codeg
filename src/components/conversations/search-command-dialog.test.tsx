import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { SearchCommandDialog } from "./search-command-dialog"
import enMessages from "@/i18n/messages/en.json"
import { searchConversations } from "@/lib/api"
import type { ConversationSearchResult } from "@/lib/types"
import { useConversationSearchStore } from "@/stores/conversation-search-store"

// The active folder and its conversations, per test: the agent filter chips
// only render once the folder holds more than one agent type.
const workspace = vi.hoisted(() => ({
  activeFolderId: null as number | null,
  conversations: [] as { folder_id: number; agent_type: string }[],
  openTab: vi.fn(),
}))

vi.mock("@/components/agent-icon", () => ({ AgentIcon: () => null }))

vi.mock("@/lib/api", () => ({
  searchConversations: vi.fn(async () => []),
}))

vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({ openTab: workspace.openTab }),
}))

vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({ openConversations: vi.fn() }),
}))

vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceActions: () => ({ openFilePreview: vi.fn() }),
}))

vi.mock("@/contexts/aux-panel-context", () => ({
  useAuxPanelContext: () => ({ revealInFileTree: vi.fn() }),
}))

vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({
    activeFolder: null,
    activeFolderId: workspace.activeFolderId,
  }),
}))

vi.mock("@/stores/app-workspace-store", () => ({
  useAppWorkspaceStore: (selector: (s: unknown) => unknown) =>
    selector({ conversations: workspace.conversations }),
}))

vi.mock("@/hooks/use-file-tree", () => ({
  useFileTree: () => ({ allFiles: [], loading: false, reset: vi.fn() }),
}))

function renderDialog() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SearchCommandDialog open onOpenChange={() => {}} />
    </NextIntlClientProvider>
  )
}

describe("SearchCommandDialog focus", () => {
  beforeEach(() => {
    workspace.openTab.mockClear()
    useConversationSearchStore.setState({ target: null })
    vi.mocked(searchConversations).mockResolvedValue([])
    workspace.activeFolderId = null
    workspace.conversations = []
  })

  it("shows a body match even when its title does not contain the query", async () => {
    vi.mocked(searchConversations).mockResolvedValue([
      {
        id: 42,
        folder_id: 1,
        title: "Database maintenance",
        agent_type: "codex",
        status: "completed",
        created_at: "2026-01-01T00:00:00Z",
      } as ConversationSearchResult,
    ])
    const user = userEvent.setup()
    renderDialog()
    await user.type(screen.getByRole("combobox"), "connection timeout")
    expect(await screen.findByText("Database maintenance")).toBeVisible()
  })

  it("ignores a slow response after the query changes", async () => {
    let resolveOld!: (rows: ConversationSearchResult[]) => void
    vi.mocked(searchConversations).mockImplementation(async (options) => {
      if (options?.search === "old") {
        return new Promise<ConversationSearchResult[]>((resolve) => {
          resolveOld = resolve
        })
      }
      return []
    })
    const user = userEvent.setup()
    renderDialog()
    const input = screen.getByRole("combobox")
    await user.type(input, "old")
    await waitFor(() => expect(resolveOld).toBeTypeOf("function"))
    await user.clear(input)
    await user.type(input, "new")
    await waitFor(() =>
      expect(searchConversations).toHaveBeenCalledWith(
        expect.objectContaining({ search: "new" })
      )
    )
    await act(async () => {
      resolveOld([
        {
          id: 42,
          folder_id: 1,
          title: "Obsolete result",
          agent_type: "codex",
          status: "completed",
          created_at: "2026-01-01T00:00:00Z",
        } as ConversationSearchResult,
      ])
    })
    expect(screen.queryByText("Obsolete result")).not.toBeInTheDocument()
  })

  it("previews and highlights a body match below its conversation title", async () => {
    vi.mocked(searchConversations).mockResolvedValue([
      {
        id: 42,
        folder_id: 1,
        title: "Database maintenance",
        agent_type: "codex",
        status: "completed",
        created_at: "2026-01-01T00:00:00Z",
        matches: [
          {
            turn_id: "turn-12",
            turn_index: 12,
            role: "assistant",
            before: "Retry the ",
            matched_text: "CONNECTION timeout",
            after: " after checking the network.",
          },
        ],
      } as ConversationSearchResult,
    ])
    const user = userEvent.setup()
    renderDialog()
    await user.type(screen.getByRole("combobox"), "connection timeout")
    const match = await screen.findByText("CONNECTION timeout")
    expect(match.tagName).toBe("MARK")
    expect(screen.getByText(/after checking the network/)).toBeVisible()
    await user.click(match)
    expect(workspace.openTab).toHaveBeenCalledWith(1, 42, "codex", true)
    expect(useConversationSearchStore.getState().target).toEqual(
      expect.objectContaining({
        conversationId: 42,
        turnId: "turn-12",
        turnIndex: 12,
      })
    )
  })

  it("opens with the cursor in the search box, so typing searches", async () => {
    const user = userEvent.setup()
    renderDialog()

    const input = await screen.findByPlaceholderText(
      enMessages.Folder.search.placeholder
    )
    expect(input).toHaveFocus()

    await user.keyboard("auth")
    expect(input).toHaveValue("auth")
  })

  it("keeps the cursor in the search box when switching tabs", async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.click(
      screen.getByRole("button", { name: enMessages.Folder.search.tabFiles })
    )

    expect(
      await screen.findByPlaceholderText(
        enMessages.Folder.search.filePlaceholder
      )
    ).toHaveFocus()
  })

  it("keeps the cursor in the search box when picking an agent filter", async () => {
    workspace.activeFolderId = 1
    workspace.conversations = [
      { folder_id: 1, agent_type: "claude_code" },
      { folder_id: 1, agent_type: "codex" },
    ]
    const user = userEvent.setup()
    renderDialog()

    const input = await screen.findByPlaceholderText(
      enMessages.Folder.search.placeholder
    )
    await user.click(screen.getByRole("button", { name: "Codex" }))
    expect(input).toHaveFocus()

    await user.click(
      screen.getByRole("button", { name: enMessages.Folder.search.allAgents })
    )
    expect(input).toHaveFocus()
  })

  it("pulls the cursor back when the chat composer behind it takes focus", async () => {
    // The composer refocuses itself when an agent turn ends, whether or not
    // the dialog is open over it. The dialog's focus trap must bring the
    // cursor back, or the rest of the query is typed into the composer.
    const composer = document.createElement("textarea")
    document.body.appendChild(composer)
    try {
      const user = userEvent.setup()
      renderDialog()

      const input = await screen.findByPlaceholderText(
        enMessages.Folder.search.placeholder
      )
      act(() => composer.focus())
      expect(input).toHaveFocus()

      await user.keyboard("auth")
      expect(input).toHaveValue("auth")
      expect(composer).toHaveValue("")
    } finally {
      composer.remove()
    }
  })
})
