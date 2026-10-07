import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type {
  ConversationTagDetail,
  DbConversationSummary,
  FolderDetail,
} from "@/lib/types"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"
import {
  resetConversationTagsStore,
  useConversationTagsStore,
} from "@/stores/conversation-tags-store"
import { EMPTY_TAG_FILTER } from "@/lib/conversation-tags"

const h = vi.hoisted(() => ({ openConversationTagsManager: vi.fn() }))
vi.mock("./conversation-tags-manager", () => ({
  openConversationTagsManager: h.openConversationTagsManager,
}))

import { SidebarTagFilterButton } from "./sidebar-tag-filter"

function folder(
  id: number,
  name: string,
  parentId: number | null = null
): FolderDetail {
  return {
    id,
    name,
    path: `/p/${id}`,
    alias: null,
    parent_id: parentId,
    kind: "regular",
  } as unknown as FolderDetail
}

function conv(
  id: number,
  folderId: number,
  overrides: Partial<DbConversationSummary> = {}
): DbConversationSummary {
  return {
    id,
    folder_id: folderId,
    title: `conv-${id}`,
    title_locked: false,
    agent_type: "claude_code",
    status: "pending_review",
    kind: "regular",
    model: null,
    git_branch: null,
    external_id: null,
    message_count: 0,
    child_count: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    pinned_at: null,
    ...overrides,
  }
}

const tag = (
  id: number,
  name: string,
  folder_id: number | null
): ConversationTagDetail => ({
  id,
  folder_id,
  name,
  color: "#0969da",
  sort_order: id,
})

beforeEach(() => {
  h.openConversationTagsManager.mockClear()
  resetAppWorkspaceStore()
  resetConversationTagsStore()
  const store = useConversationTagsStore.getState()
  for (const t of [
    tag(1, "bug", null),
    tag(2, "repo-tag", 10), // repo 10 is closed, its worktree 11 is open
    tag(3, "pinned-tag", 20), // folder 20 is closed, a pinned row carries it
    tag(4, "closed-tag", 30), // folder 30 is closed and nothing shown has it
    tag(5, "open-tag", 40),
  ]) {
    store.applyChange({ kind: "upsert", tag: t })
  }
  const all = [
    folder(10, "repo"),
    folder(11, "repo-wt", 10),
    folder(20, "old"),
    folder(30, "gone"),
    folder(40, "open"),
  ]
  useAppWorkspaceStore.setState({
    // Open: the worktree (without its repo) and folder 40.
    folders: [all[1], all[4]],
    allFolders: all,
    conversations: [
      conv(1, 11, { tag_ids: [1, 2] }),
      conv(2, 20, { tag_ids: [3], pinned_at: "2026-01-02T00:00:00.000Z" }),
      // Unpinned in a closed folder: not in the sidebar, so not counted.
      conv(3, 30, { tag_ids: [1, 4] }),
      conv(4, 40),
    ],
  })
})

async function openPanel() {
  const user = userEvent.setup({ pointerEventsCheck: 0 })
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SidebarTagFilterButton filter={EMPTY_TAG_FILTER} onChange={vi.fn()} />
    </NextIntlClientProvider>
  )
  await user.click(screen.getByRole("button", { name: "Filter by tags" }))
  return { user, panel: await screen.findByRole("dialog") }
}

describe("SidebarTagFilterButton options", () => {
  it("offers the scopes the sidebar can show, named even when closed", async () => {
    const { panel } = await openPanel()
    // A closed repo's tag, because its open worktree's rows carry it.
    expect(within(panel).getByText("repo-tag")).toBeTruthy()
    expect(within(panel).getByText("repo")).toBeTruthy()
    // A closed folder's tag carried by a pinned row.
    expect(within(panel).getByText("pinned-tag")).toBeTruthy()
    // An open folder's tag, even before anything carries it.
    expect(within(panel).getByText("open-tag")).toBeTruthy()
    // Nothing the sidebar shows could ever match this one.
    expect(within(panel).queryByText("closed-tag")).toBeNull()
  })

  it("counts only conversations the sidebar can show", async () => {
    const { panel } = await openPanel()
    const bugRow = within(panel).getByText("bug").closest("[cmdk-item]")
    // conv 1 (open worktree) — not conv 3, whose folder is closed.
    expect(within(bugRow as HTMLElement).getByText("1")).toBeTruthy()
  })
})

describe("SidebarTagFilterButton manage entry", () => {
  it("leads to the tag manager, closing the filter on the way", async () => {
    const { user, panel } = await openPanel()
    await user.click(within(panel).getByText("Manage tags…"))

    // No folder of its own: the manager opens on the conversation on screen's.
    expect(h.openConversationTagsManager).toHaveBeenCalledWith()
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("is offered before there is any tag to filter by", async () => {
    resetConversationTagsStore()
    const { user, panel } = await openPanel()
    expect(
      within(panel).getByText(
        "No tags yet. Add one from a conversation's menu."
      )
    ).toBeTruthy()
    await user.click(within(panel).getByText("Manage tags…"))
    expect(h.openConversationTagsManager).toHaveBeenCalledTimes(1)
  })
})
