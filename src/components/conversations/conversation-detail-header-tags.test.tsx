import { type ReactElement } from "react"
import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type {
  ConversationTagDetail,
  DbConversationSummary,
  FolderDetail,
} from "@/lib/types"

const h = vi.hoisted(() => ({
  changeConversationTags: vi.fn(async () => {}),
  createConversationTag: vi.fn(),
  openConversationTagsManager: vi.fn(),
  state: {
    conversations: [] as Partial<DbConversationSummary>[],
    allFolders: [] as Partial<FolderDetail>[],
  },
}))

vi.mock("@/lib/api", () => ({
  updateConversationTitle: vi.fn(),
  deleteConversation: vi.fn(),
  updateConversationStatus: vi.fn(),
  updateConversationPinned: vi.fn(),
  createConversationTag: h.createConversationTag,
  listConversationTags: vi.fn(async () => []),
}))
vi.mock("@/lib/conversation-tag-assignment", () => ({
  changeConversationTags: h.changeConversationTags,
}))
vi.mock("./conversation-tags-manager", () => ({
  openConversationTagsManager: h.openConversationTagsManager,
}))
vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({ closeTab: vi.fn(), openNewConversationTab: vi.fn() }),
}))
vi.mock("@/stores/app-workspace-store", () => {
  const full = {
    ...h.state,
    updateConversationLocal: vi.fn(),
    refreshConversations: vi.fn(),
  }
  const useStore = (selector: (s: typeof full) => unknown) =>
    selector({ ...full, ...h.state })
  useStore.getState = () => ({ ...full, ...h.state })
  return { useAppWorkspaceStore: useStore }
})
vi.mock("@/stores/conversation-runtime-store", () => ({
  getRuntimeSession: () => null,
}))
vi.mock("./session-details-dialog", () => ({
  SessionDetailsDialog: () => null,
}))
vi.mock("@/components/chat/conversation-context-bar", () => ({
  ConversationHeaderFolderPicker: () => null,
}))

import { ConversationDetailHeader } from "./conversation-detail-header"
import {
  resetConversationTagsStore,
  useConversationTagsStore,
} from "@/stores/conversation-tags-store"

function withIntl(ui: ReactElement) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

const tag = (
  id: number,
  name: string,
  folder_id: number | null = null
): ConversationTagDetail => ({
  id,
  folder_id,
  name,
  color: "#0969da",
  sort_order: id,
})

function header(conversationId: number | null, folderId = 1) {
  return withIntl(
    <ConversationDetailHeader
      tabId="tab-1"
      conversationId={conversationId}
      runtimeConversationId={null}
      folderId={folderId}
      folderPath="/repo"
      title="conv"
      status="in_progress"
    />
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  resetConversationTagsStore()
  const store = useConversationTagsStore.getState()
  for (const t of [tag(1, "bug"), tag(2, "frontend", 1), tag(3, "perf", 7)]) {
    store.applyChange({ kind: "upsert", tag: t })
  }
  h.state.allFolders = [
    { id: 1, name: "repo", alias: null, parent_id: null, kind: "regular" },
    { id: 4, name: "repo-wt", alias: null, parent_id: 1, kind: "regular" },
    { id: 9, name: "Chat", alias: null, parent_id: null, kind: "chat" },
  ]
  h.state.conversations = [
    { id: 1, folder_id: 1, tag_ids: [2] },
    { id: 2, folder_id: 4 },
    { id: 3, folder_id: 9 },
  ]
})

describe("ConversationDetailHeader tags", () => {
  it("shows the conversation's tags and toggles one from the picker", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(header(1))
    // The chip is the trigger.
    await user.click(screen.getByRole("button", { name: "Edit tags" }))

    // Global first, then the folder's own; another folder's tag is not offered.
    expect(await screen.findByText("Global")).toBeTruthy()
    expect(screen.getAllByText("frontend").length).toBeGreaterThan(0)
    expect(screen.queryByText("perf")).toBeNull()

    await user.click(screen.getByText("bug"))
    expect(h.changeConversationTags).toHaveBeenCalledWith(1, { add: [1] })
  })

  it("offers a worktree conversation its repo's tags", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(header(2, 4))
    await user.click(screen.getByRole("button", { name: "Add tags" }))
    await user.click(await screen.findByText("frontend"))
    expect(h.changeConversationTags).toHaveBeenCalledWith(2, { add: [2] })
  })

  it("creates a typed tag globally or in the folder, and puts it on", async () => {
    h.createConversationTag.mockResolvedValueOnce(tag(10, "triage", 1))
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(header(1))
    await user.click(screen.getByRole("button", { name: "Edit tags" }))
    await user.type(
      await screen.findByPlaceholderText("Search or create a tag…"),
      "triage"
    )
    expect(screen.getByText("Create global tag “triage”")).toBeTruthy()
    await user.click(screen.getByText("Create “triage” in repo"))

    await waitFor(() =>
      expect(h.createConversationTag).toHaveBeenCalledWith({
        folderId: 1,
        name: "triage",
        // Distinct from both tags this conversation can show (#0969da).
        color: expect.not.stringMatching(/^#0969da$/),
      })
    )
    await waitFor(() =>
      expect(h.changeConversationTags).toHaveBeenCalledWith(1, { add: [10] })
    )
  })

  it("offers a chat-mode conversation global tags only", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(header(3, 9))
    await user.click(screen.getByRole("button", { name: "Add tags" }))
    expect(await screen.findByText("bug")).toBeTruthy()
    expect(screen.queryByText("frontend")).toBeNull()
    await user.type(
      screen.getByPlaceholderText("Search or create a tag…"),
      "idea"
    )
    expect(screen.getByText("Create global tag “idea”")).toBeTruthy()
    expect(screen.queryByText(/Create “idea” in/)).toBeNull()
  })

  it("leads to the tag manager on this conversation's folder, closing the picker", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(header(2, 4))
    await user.click(screen.getByRole("button", { name: "Add tags" }))
    await user.click(await screen.findByText("Manage tags…"))

    // The worktree's own id: the manager resolves it to the repo that owns
    // the tags.
    expect(h.openConversationTagsManager).toHaveBeenCalledWith({ folderId: 4 })
    await waitFor(() =>
      expect(
        screen.queryByPlaceholderText("Search or create a tag…")
      ).toBeNull()
    )
  })

  it("has no tag control on an unsaved draft or a sub-session", () => {
    const { rerender } = render(header(null))
    expect(screen.queryByRole("button", { name: /tags/i })).toBeNull()
    // Not a root row of the sidebar list (a delegation child, say).
    rerender(header(42))
    expect(screen.queryByRole("button", { name: /tags/i })).toBeNull()
  })

  it("follows the title with the branch chip, then the tag button", () => {
    const follows = (a: Node, b: Node) =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    act(() => {
      const store = useConversationTagsStore.getState()
      store.applyChange({ kind: "upsert", tag: tag(4, "ui") })
      store.applyChange({
        kind: "branch_tag",
        setting: { enabled: true, color: "#8250df" },
      })
    })
    h.state.conversations = [
      { id: 1, folder_id: 1, tag_ids: [1, 2, 4], git_branch: "task/280" },
      { id: 2, folder_id: 4, git_branch: "task/280" },
    ]
    const { rerender } = render(header(1))

    const title = screen.getByText("conv")
    const chip = screen.getByTitle("Branch: task/280")
    const trigger = screen.getByRole("button", { name: "Edit tags" })
    const more = screen.getByRole("button", { name: "More actions" })
    expect(follows(title, chip)).toBe(true)
    expect(follows(chip, trigger)).toBe(true)
    expect(follows(trigger, more)).toBe(true)
    // Grows only as far as its text, so what follows it stays beside it.
    expect(title.className).toMatch(/(^|\s)max-w-max(\s|$)/)
    // Outside the picker's trigger — the picker does not edit it — yet one
    // of the three chips a desktop header shows: two tags, then "+1".
    expect(trigger.contains(chip)).toBe(false)
    expect(within(trigger).getByText("bug")).toBeTruthy()
    expect(within(trigger).getByText("ui")).toBeTruthy()
    expect(within(trigger).queryByText("frontend")).toBeNull()
    expect(within(trigger).getByText("+1")).toBeTruthy()

    // No tags: the branch chip, and the quiet button to add some.
    rerender(header(2, 4))
    expect(screen.getByTitle("Branch: task/280")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Add tags" })).toBeTruthy()
  })

  it("drops a chip when its tag is deleted elsewhere", () => {
    render(header(1))
    expect(screen.getByText("frontend")).toBeTruthy()
    act(() => {
      useConversationTagsStore
        .getState()
        .applyChange({ kind: "deleted", id: 2 })
    })
    expect(screen.queryByText("frontend")).toBeNull()
    expect(screen.getByRole("button", { name: "Add tags" })).toBeTruthy()
  })
})
