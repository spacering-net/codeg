import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type {
  ConversationBranchTag,
  ConversationTagDetail,
  FolderDetail,
} from "@/lib/types"

const h = vi.hoisted(() => ({
  tags: [] as ConversationTagDetail[],
  branchTag: { enabled: false, color: "#6e7781" } as ConversationBranchTag,
  // Stores what it is given, as the backend would, for the reads after it.
  updateBranchTag: vi.fn(async (setting: ConversationBranchTag) => {
    h.branchTag = setting
    return setting
  }),
}))

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  listConversationTags: vi.fn(async () => h.tags),
  getConversationBranchTag: vi.fn(async () => h.branchTag),
  updateConversationBranchTag: h.updateBranchTag,
}))

import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"
import {
  resetConversationTagsStore,
  useConversationTagsStore,
} from "@/stores/conversation-tags-store"
import {
  ConversationTagsManagerHost,
  openConversationTagsManager,
  resetConversationTagsManagerForTests,
} from "./conversation-tags-manager"

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

const folder = (
  id: number,
  name: string,
  parentId: number | null = null
): FolderDetail =>
  ({
    id,
    name,
    path: `/p/${name}`,
    alias: null,
    parent_id: parentId,
    kind: "regular",
  }) as unknown as FolderDetail

function renderHost() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ConversationTagsManagerHost />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  resetAppWorkspaceStore()
  resetConversationTagsStore()
  resetConversationTagsManagerForTests()
  // "alpha" sorts first, and is where a manager with nowhere better to go
  // lands; "beta-wt" is beta's worktree.
  const all = [folder(1, "alpha"), folder(2, "beta"), folder(3, "beta-wt", 2)]
  useAppWorkspaceStore.setState({
    folders: all,
    allFolders: all,
    foldersHydrated: true,
    activeFolderId: null,
  })
  h.tags = [
    tag(1, "bug", null),
    tag(2, "beta-only", 2),
    tag(3, "alpha-only", 1),
  ]
  h.branchTag = { enabled: false, color: "#6e7781" }
  h.updateBranchTag.mockClear()
})

describe("ConversationTagsManager", () => {
  it("opens on the folder it was opened about — a worktree on its repo", async () => {
    renderHost()
    expect(screen.queryByRole("dialog")).toBeNull()
    act(() => openConversationTagsManager({ folderId: 3 }))

    expect(
      await screen.findByRole("dialog", { name: "Manage tags" })
    ).toBeTruthy()
    // Loaded on opening: nothing had fetched the tag list yet.
    expect(await screen.findByText("beta-only")).toBeTruthy()
    expect(screen.getByText("bug")).toBeTruthy()
    expect(screen.queryByText("alpha-only")).toBeNull()
  })

  it("opens on the folder of the conversation on screen when told none", async () => {
    useAppWorkspaceStore.setState({ activeFolderId: 2 })
    renderHost()
    act(() => openConversationTagsManager())

    expect(await screen.findByText("beta-only")).toBeTruthy()
    expect(screen.queryByText("alpha-only")).toBeNull()
  })

  it("otherwise lands on the first folder with tags and stays there when another gets one", async () => {
    h.tags = [tag(1, "bug", null), tag(2, "beta-only", 2)]
    renderHost()
    act(() => openConversationTagsManager())
    expect(await screen.findByText("beta-only")).toBeTruthy()

    // Another window gives "alpha" — earlier in the list — its first tag.
    act(() => {
      useConversationTagsStore
        .getState()
        .applyChange({ kind: "upsert", tag: tag(3, "alpha-first", 1) })
    })
    // Still on beta: the editor was not switched (or remounted) underneath.
    expect(screen.getByText("beta-only")).toBeTruthy()
    expect(screen.queryByText("alpha-first")).toBeNull()
  })

  it("keeps the open dialog's folder, and starts over once closed", async () => {
    const user = userEvent.setup()
    renderHost()
    act(() => openConversationTagsManager({ folderId: 2 }))
    expect(await screen.findByText("beta-only")).toBeTruthy()

    // A second request while one is showing changes nothing.
    act(() => openConversationTagsManager({ folderId: 1 }))
    expect(screen.getByText("beta-only")).toBeTruthy()
    expect(screen.queryByText("alpha-only")).toBeNull()

    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())

    act(() => openConversationTagsManager({ folderId: 1 }))
    expect(await screen.findByText("alpha-only")).toBeTruthy()
    expect(screen.queryByText("beta-only")).toBeNull()
  })

  it("turns the branch tag on from its checkbox, which unlocks its colour", async () => {
    const user = userEvent.setup()
    renderHost()
    act(() => openConversationTagsManager())
    const show = await screen.findByRole("checkbox", { name: "Show" })
    // Usable once the setting is known.
    await waitFor(() => expect(show.hasAttribute("disabled")).toBe(false))
    const swatch = () => screen.getByRole("radio", { name: "#1a7f37" })
    expect(swatch().hasAttribute("disabled")).toBe(true)

    await user.click(show)
    expect(h.updateBranchTag).toHaveBeenCalledWith({
      enabled: true,
      color: "#6e7781",
    })
    expect(swatch().hasAttribute("disabled")).toBe(false)
    expect(
      screen.getByTitle("Branch: main").style.getPropertyValue("--fl-bg")
    ).toBe("#6e7781")

    await user.click(show)
    expect(h.updateBranchTag).toHaveBeenLastCalledWith({
      enabled: false,
      color: "#6e7781",
    })
    expect(swatch().hasAttribute("disabled")).toBe(true)
  })

  it("saves a colour once it stays picked, and one still waiting on close", async () => {
    h.branchTag = { enabled: true, color: "#6e7781" }
    renderHost()
    act(() => openConversationTagsManager())
    // Loaded and usable before the clock is frozen: the async finders poll on
    // real timers.
    const red = await screen.findByRole("radio", { name: "#cf222e" })
    await waitFor(() => expect(red.hasAttribute("disabled")).toBe(false))
    const preview = () =>
      screen.getByTitle("Branch: main").style.getPropertyValue("--fl-bg")

    // Plain DOM events from here on: user-event's own pacing waits on the
    // frozen clock.
    vi.useFakeTimers()
    try {
      fireEvent.click(red)
      act(() => vi.advanceTimersByTime(200))
      fireEvent.click(screen.getByRole("radio", { name: "#1a7f37" }))
      act(() => vi.advanceTimersByTime(200))
      // Drawn at once; 400ms after the first pick but 200ms after the last,
      // nothing is saved yet — the pause runs from the LAST pick.
      expect(preview()).toBe("#1a7f37")
      expect(h.updateBranchTag).not.toHaveBeenCalled()
      await act(async () => vi.advanceTimersByTime(100))
      expect(h.updateBranchTag).toHaveBeenCalledTimes(1)
      expect(h.updateBranchTag).toHaveBeenLastCalledWith({
        enabled: true,
        color: "#1a7f37",
      })
      await act(async () => vi.advanceTimersByTime(2000))
      expect(h.updateBranchTag).toHaveBeenCalledTimes(1)

      // Picked, then closed before the pause is up: saved on the way out,
      // and only then.
      fireEvent.click(screen.getByRole("radio", { name: "#0969da" }))
      fireEvent.keyDown(document.activeElement ?? document.body, {
        key: "Escape",
      })
      expect(screen.queryByRole("dialog")).toBeNull()
      expect(h.updateBranchTag).toHaveBeenCalledTimes(2)
      expect(h.updateBranchTag).toHaveBeenLastCalledWith({
        enabled: true,
        color: "#0969da",
      })
      await act(async () => vi.advanceTimersByTime(2000))
      expect(h.updateBranchTag).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
