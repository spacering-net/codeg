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
  targetFolderId: number | null,
  onMoved = vi.fn(),
  onOpenChange = vi.fn()
): ReactElement {
  const ui = (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <MoveConversationDialog
        open
        onOpenChange={onOpenChange}
        conversations={conversations}
        targetFolderId={targetFolderId}
        onMoved={onMoved}
      />
    </NextIntlClientProvider>
  )
  render(ui)
  return ui
}

function conv(
  id: number,
  folder_id: number,
  kind: MovableConversation["kind"] = "regular",
  title: string | null = `conv-${id}`
): MovableConversation {
  return { id, folder_id, kind, title }
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

  it("confirms the picked folder and moves there", async () => {
    const result: MoveConversationsResult = { moved: [5], skipped: [] }
    moveConversationsMock.mockResolvedValue(result)
    const onMoved = vi.fn()
    const onOpenChange = vi.fn()
    renderDialog([conv(5, 1)], OTHER.id, onMoved, onOpenChange)

    expect(screen.getByText("Move conversation")).toBeDefined()
    expect(
      screen.getByText("“conv-5” will be moved to this folder:")
    ).toBeDefined()
    expect(screen.getByText("/work/other")).toBeDefined()
    fireEvent.click(screen.getByRole("button", { name: "Move" }))

    await waitFor(() => expect(onMoved).toHaveBeenCalledWith(result))
    expect(moveConversationsMock).toHaveBeenCalledWith([5], 2)
    expect(toastMock.success).toHaveBeenCalledWith(
      "Moved 1 conversation to other"
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("names an untitled conversation as such", () => {
    renderDialog([conv(5, 1, "regular", null)], OTHER.id)
    expect(
      screen.getByText("“Untitled conversation” will be moved to this folder:")
    ).toBeDefined()
  })

  it("tells where a chat's files stay", () => {
    renderDialog([conv(7, CHAT.id, "chat")], REPO.id)
    expect(
      screen.getByText(
        /Files created during the chat stay in its scratch directory \/data\/chat-sessions\/2026-11-12\/abc/
      )
    ).toBeDefined()
  })

  it("explains why some conversations stayed", async () => {
    moveConversationsMock.mockResolvedValue({
      moved: [1],
      skipped: [
        { conversationId: 2, reason: "task_owned" },
        { conversationId: 3, reason: "busy" },
      ],
    } satisfies MoveConversationsResult)
    renderDialog([conv(1, 1), conv(2, 1), conv(3, 2)], OTHER.id)
    expect(screen.getByText("Move 3 conversations")).toBeDefined()
    expect(
      screen.getByText(
        "The selected 3 conversations will be moved to this folder:"
      )
    ).toBeDefined()
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
    renderDialog([conv(1, 1)], OTHER.id, vi.fn(), onOpenChange)
    fireEvent.click(screen.getByRole("button", { name: "Move" }))

    await waitFor(() => expect(toastMock.error).toHaveBeenCalled())
    expect(toastMock.error.mock.calls[0][0]).toContain(
      "folder 2 is not a project folder"
    )
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it("won't move into a folder that closed while it was open", () => {
    useAppWorkspaceStore.setState({ folders: [REPO] })
    renderDialog([conv(1, 1)], OTHER.id)
    expect(
      screen.getByText("This folder was closed or removed — pick another one.")
    ).toBeDefined()
    expect(
      (screen.getByRole("button", { name: "Move" }) as HTMLButtonElement)
        .disabled
    ).toBe(true)
  })
})
