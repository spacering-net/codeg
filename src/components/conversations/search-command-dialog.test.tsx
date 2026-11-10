import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { SearchCommandDialog } from "./search-command-dialog"
import enMessages from "@/i18n/messages/en.json"

// The active folder and its conversations, per test: the agent filter chips
// only render once the folder holds more than one agent type.
const workspace = vi.hoisted(() => ({
  activeFolderId: null as number | null,
  conversations: [] as { folder_id: number; agent_type: string }[],
}))

vi.mock("@/components/agent-icon", () => ({ AgentIcon: () => null }))

vi.mock("@/lib/api", () => ({
  listAllConversations: vi.fn(async () => []),
}))

vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({ openTab: vi.fn() }),
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
    workspace.activeFolderId = null
    workspace.conversations = []
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
