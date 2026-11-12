import { type ReactElement } from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { FolderDetail, MoveConversationsResult } from "@/lib/types"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"
import {
  MoveConversationDialog,
  type MovableConversation,
} from "./move-conversation-dialog"

const moveConversationsMock = vi.fn()
vi.mock("@/lib/api", () => ({
  moveConversations: (...args: unknown[]) => moveConversationsMock(...args),
}))

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}))
vi.mock("sonner", () => ({ toast: toastMock }))

function folder(
  id: number,
  name: string,
  path: string,
  kind: FolderDetail["kind"] = "regular"
): FolderDetail {
  return {
    id,
    name,
    path,
    git_branch: null,
    default_agent_type: null,
    last_opened_at: "2026-11-12T00:00:00Z",
    sort_order: id,
    color: "inherit",
    parent_id: null,
    kind,
    alias: null,
    group_id: null,
  }
}

const REPO = folder(1, "repo", "/work/repo")
const OTHER = folder(2, "other", "/work/other")
const CHAT = folder(9, "Chat", "/data/chat-sessions/2026-11-12/abc", "chat")

function renderDialog(
  conversations: MovableConversation[],
  onMoved = vi.fn(),
  onOpenChange = vi.fn()
): ReactElement {
  const ui = (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <MoveConversationDialog
        open
        onOpenChange={onOpenChange}
        conversations={conversations}
        onMoved={onMoved}
      />
    </NextIntlClientProvider>
  )
  render(ui)
  return ui
}

function pickFolder(name: string) {
  fireEvent.click(screen.getByRole("button", { name: /Choose a project/ }))
  fireEvent.click(screen.getByText(name))
}

describe("MoveConversationDialog", () => {
  beforeEach(() => {
    moveConversationsMock.mockReset()
    toastMock.success.mockReset()
    toastMock.warning.mockReset()
    toastMock.error.mockReset()
    resetAppWorkspaceStore()
    useAppWorkspaceStore.setState({
      folders: [REPO, OTHER],
      allFolders: [REPO, OTHER, CHAT],
    })
  })

  it("offers only the other open projects and moves there", async () => {
    const result: MoveConversationsResult = { moved: [5], skipped: [] }
    moveConversationsMock.mockResolvedValue(result)
    const onMoved = vi.fn()
    const onOpenChange = vi.fn()
    renderDialog(
      [{ id: 5, folder_id: 1, kind: "regular" }],
      onMoved,
      onOpenChange
    )

    fireEvent.click(screen.getByRole("button", { name: /Choose a project/ }))
    // The conversation's own folder is no destination; hidden chat folders
    // never are.
    expect(screen.queryByText("/work/repo")).toBeNull()
    expect(screen.queryByText("Chat")).toBeNull()
    fireEvent.click(screen.getByText("other"))

    expect(
      screen.getByText(
        /From the next message on, the agent works in \/work\/other/
      )
    ).toBeDefined()
    fireEvent.click(screen.getByRole("button", { name: "Move" }))

    await waitFor(() => expect(onMoved).toHaveBeenCalledWith(result))
    expect(moveConversationsMock).toHaveBeenCalledWith([5], 2)
    expect(toastMock.success).toHaveBeenCalledWith(
      "Moved 1 conversation to other"
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("tells where a chat's files stay", () => {
    renderDialog([{ id: 7, folder_id: CHAT.id, kind: "chat" }])
    expect(
      screen.getByText(
        /Files created during the chat stay in its scratch directory \/data\/chat-sessions\/2026-11-12\/abc/
      )
    ).toBeDefined()
    // A chat lives in no open project, so every open project is a target.
    fireEvent.click(screen.getByRole("button", { name: /Choose a project/ }))
    expect(screen.getByText("repo")).toBeDefined()
    expect(screen.getByText("other")).toBeDefined()
  })

  it("explains why some conversations stayed", async () => {
    moveConversationsMock.mockResolvedValue({
      moved: [1],
      skipped: [
        { conversationId: 2, reason: "task_owned" },
        { conversationId: 3, reason: "busy" },
      ],
    } satisfies MoveConversationsResult)
    renderDialog([
      { id: 1, folder_id: 1, kind: "regular" },
      { id: 2, folder_id: 1, kind: "regular" },
      { id: 3, folder_id: 2, kind: "regular" },
    ])
    expect(
      screen.getByText("Move 3 conversations to another project")
    ).toBeDefined()
    pickFolder("other")
    fireEvent.click(screen.getByRole("button", { name: "Move" }))

    await waitFor(() => expect(toastMock.warning).toHaveBeenCalled())
    expect(toastMock.warning).toHaveBeenCalledWith(
      "2 conversations were not moved",
      {
        description:
          "It belongs to a to-do task · An agent is working on it — try again when it's done",
      }
    )
  })

  it("keeps the dialog open and reports a rejected target", async () => {
    moveConversationsMock.mockRejectedValue({
      code: "invalid_input",
      message: "folder 2 is not a project folder",
    })
    const onOpenChange = vi.fn()
    renderDialog(
      [{ id: 1, folder_id: 1, kind: "regular" }],
      vi.fn(),
      onOpenChange
    )
    pickFolder("other")
    fireEvent.click(screen.getByRole("button", { name: "Move" }))

    await waitFor(() => expect(toastMock.error).toHaveBeenCalled())
    expect(toastMock.error.mock.calls[0][0]).toContain(
      "folder 2 is not a project folder"
    )
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it("says so when there is nowhere to move to", () => {
    useAppWorkspaceStore.setState({ folders: [REPO] })
    renderDialog([{ id: 1, folder_id: 1, kind: "regular" }])
    expect(
      screen.getByText("There is no other open project to move to.")
    ).toBeDefined()
    expect(
      (screen.getByRole("button", { name: "Move" }) as HTMLButtonElement)
        .disabled
    ).toBe(true)
  })
})
