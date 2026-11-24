import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { useState } from "react"
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
import { EMPTY_TAG_FILTER, type TagFilter } from "@/lib/conversation-tags"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

const h = vi.hoisted(() => ({ openConversationTagsManager: vi.fn() }))
vi.mock("./conversation-tags-manager", () => ({
  openConversationTagsManager: h.openConversationTagsManager,
}))

import { SidebarTagFilterSubmenu } from "./sidebar-tag-filter"

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

/**
 * The submenu as the sidebar hosts it: one row of a controlled menu. `live`
 * feeds each change back in as the next filter, as the sidebar does, so the
 * panel re-renders with it (Clear filter turning disabled, say).
 */
function Harness({
  filter,
  onChange,
  dir,
  live,
}: {
  filter: TagFilter
  onChange: (filter: TagFilter) => void
  dir?: "ltr" | "rtl"
  live?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [liveFilter, setLiveFilter] = useState(filter)
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <DropdownMenu open={open} onOpenChange={setOpen} dir={dir}>
        <DropdownMenuTrigger>View options</DropdownMenuTrigger>
        <DropdownMenuContent>
          <SidebarTagFilterSubmenu
            filter={live ? liveFilter : filter}
            onChange={(next) => {
              onChange(next)
              if (live) setLiveFilter(next)
            }}
            onCloseMenu={() => setOpen(false)}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </NextIntlClientProvider>
  )
}

/**
 * Open the menu and return the "Filter by tags" row. Every pointer step here
 * and below uses the module-level `userEvent`, as the sidebar's own submenu
 * tests do: a shared `setup()` instance would first drag the pointer off the
 * row, and Radix's grace-area check on that leave needs real geometry (jsdom
 * has none), so the submenu would close out from under the next click.
 */
async function openMenu({
  filter = EMPTY_TAG_FILTER,
  onChange = vi.fn(),
  dir,
  live,
}: {
  filter?: TagFilter
  onChange?: (filter: TagFilter) => void
  dir?: "ltr" | "rtl"
  live?: boolean
} = {}) {
  render(<Harness filter={filter} onChange={onChange} dir={dir} live={live} />)
  await userEvent.click(screen.getByRole("button", { name: "View options" }))
  return screen.getByRole("menuitem", { name: "Filter by tags" })
}

/**
 * Open the submenu by pointer and return its panel. Only the press, not the
 * hover `click` starts with: a pointer arriving on the row arms Radix's
 * hover-open timer (100 ms), and with no pointer ever leaving the row again
 * it is still pending if a test closes the submenu that soon. It then opens it
 * again, before or after the test looks, depending on machine speed.
 */
async function openPanel(options?: Parameters<typeof openMenu>[0]) {
  const row = await openMenu(options)
  await userEvent.click(row, { skipHover: true })
  return screen.findByRole("dialog", { name: "Filter by tags" })
}

const searchBox = (panel: HTMLElement) =>
  within(panel).getByPlaceholderText("Search tags…")

describe("SidebarTagFilterSubmenu options", () => {
  it("offers the scopes the sidebar can show, named even when closed", async () => {
    const panel = await openPanel()
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
    const panel = await openPanel()
    const bugRow = within(panel).getByText("bug").closest("[cmdk-item]")
    // conv 1 (open worktree) — not conv 3, whose folder is closed.
    expect(within(bugRow as HTMLElement).getByText("1")).toBeTruthy()
  })
})

describe("SidebarTagFilterSubmenu row", () => {
  it("counts the picked tags on the row while a filter is on", async () => {
    // Found by its name in both states: the chip stays out of it.
    const row = await openMenu({ filter: { tagIds: [1, 2], mode: "any" } })
    expect(within(row).getByText("2")).toBeTruthy()
    // The count is only drawn; what is announced is that a filter is on, as
    // the old header button's pressed state said.
    expect(row).toHaveAccessibleDescription("Filtered by tags")
  })

  it("carries no count while no filter is on", async () => {
    const row = await openMenu()
    expect(row.textContent).toBe("Filter by tags")
    expect(row).not.toHaveAccessibleDescription()
    // What it opens is a panel, not another menu.
    expect(row).toHaveAttribute("aria-haspopup", "dialog")
  })
})

describe("SidebarTagFilterSubmenu picking", () => {
  it("toggles a tag and keeps the menu open for the next one", async () => {
    const onChange = vi.fn()
    const panel = await openPanel({ onChange })
    await userEvent.click(within(panel).getByText("bug"))

    expect(onChange).toHaveBeenCalledWith({ tagIds: [1], mode: "any" })
    expect(screen.getByRole("dialog", { name: "Filter by tags" })).toBe(panel)
  })

  it("tells assistive tech which tags are picked", async () => {
    const panel = await openPanel({ filter: { tagIds: [1], mode: "any" } })
    const row = (name: string) =>
      within(panel).getByText(name).closest("[cmdk-item]")

    // Not `aria-selected`: cmdk spends that on the keyboard highlight.
    expect(row("bug")).toHaveAttribute("aria-checked", "true")
    expect(row("open-tag")).toHaveAttribute("aria-checked", "false")
  })

  it("moves focus on to the search box when Clear filter is pressed from the keyboard", async () => {
    const onChange = vi.fn()
    const panel = await openPanel({
      filter: { tagIds: [1], mode: "any" },
      onChange,
      live: true,
    })
    const clear = within(panel).getByRole("button", { name: "Clear filter" })
    await userEvent.click(searchBox(panel))
    await userEvent.keyboard("{Tab}")
    expect(clear).toHaveFocus()

    await userEvent.keyboard("{Enter}")

    expect(onChange).toHaveBeenCalledWith({ tagIds: [], mode: "any" })
    // The cleared filter came back in and disabled the button; focus had
    // already moved on, so the browser has nothing to drop out of the menu.
    expect(clear).toBeDisabled()
    expect(searchBox(panel)).toHaveFocus()
  })

  it("leaves focus alone when Clear filter is clicked", async () => {
    const onChange = vi.fn()
    const panel = await openPanel({
      filter: { tagIds: [1], mode: "any" },
      onChange,
      live: true,
    })
    const clear = within(panel).getByRole("button", { name: "Clear filter" })
    await userEvent.click(clear)

    expect(onChange).toHaveBeenCalledWith({ tagIds: [], mode: "any" })
    expect(clear).toBeDisabled()
    // No search box focus for a pointer: on touch it would raise a keyboard.
    expect(searchBox(panel)).not.toHaveFocus()
  })
})

describe("SidebarTagFilterSubmenu keyboard", () => {
  it("lands a keyboard opening in the search box", async () => {
    const row = await openMenu()
    act(() => row.focus())
    await userEvent.keyboard("{ArrowRight}")

    const panel = await screen.findByRole("dialog", { name: "Filter by tags" })
    // Radix focuses the panel itself, from which nothing is reachable.
    await waitFor(() => expect(searchBox(panel)).toHaveFocus())
  })

  it("lands on the manage entry when there is no tag to search", async () => {
    resetConversationTagsStore()
    const row = await openMenu()
    act(() => row.focus())
    await userEvent.keyboard("{ArrowRight}")

    const panel = await screen.findByRole("dialog", { name: "Filter by tags" })
    await waitFor(() =>
      expect(
        within(panel).getByRole("button", { name: "Manage tags…" })
      ).toHaveFocus()
    )
  })

  it("leaves focus on the row when opened by pointer", async () => {
    const row = await openMenu()
    await userEvent.click(row)

    const panel = await screen.findByRole("dialog", { name: "Filter by tags" })
    // As with every submenu — and a touch keyboard must not pop up.
    expect(row).toHaveFocus()
    expect(searchBox(panel)).not.toHaveFocus()
  })

  it("does not answer a press on the panel's padding with the search box", async () => {
    const panel = await openPanel()
    // Lands on the panel element itself, as a keyboard opening does.
    await userEvent.click(panel)

    expect(panel).toHaveFocus()
  })

  it("steps into the panel with Tab from the panel element itself", async () => {
    const panel = await openPanel()
    await userEvent.click(panel)
    await userEvent.keyboard("{Tab}")
    expect(within(panel).getByRole("radio", { name: "Any" })).toHaveFocus()

    await userEvent.click(panel)
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}")
    expect(
      within(panel).getByRole("button", { name: "Manage tags…" })
    ).toHaveFocus()
  })

  it("does not let a press that moved no focus spoil the next keyboard opening", async () => {
    const panel = await openPanel()
    const input = searchBox(panel)
    await userEvent.click(input)
    // A press on the box that already has focus, released outside the panel:
    // no focus moves and no mouseup reaches the panel.
    fireEvent.mouseDown(input)
    await userEvent.keyboard("{ArrowLeft}")
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())

    await userEvent.keyboard("{ArrowRight}")

    const reopened = await screen.findByRole("dialog", {
      name: "Filter by tags",
    })
    await waitFor(() => expect(searchBox(reopened)).toHaveFocus())
  })

  it("keeps ← and → for the search box while it has text", async () => {
    const panel = await openPanel()
    const input = searchBox(panel) as HTMLInputElement
    await userEvent.type(input, "repo")
    expect(within(panel).getByText("repo-tag")).toBeTruthy()
    expect(within(panel).queryByText("bug")).toBeNull()

    await userEvent.keyboard("{ArrowLeft}")
    // The caret moved and the submenu is still there.
    expect(input.selectionStart).toBe(3)
    expect(screen.getByRole("dialog", { name: "Filter by tags" })).toBe(panel)

    await userEvent.keyboard("{ArrowRight}")
    expect(input.selectionStart).toBe(4)
    expect(input).toHaveFocus()
    expect(screen.getByRole("dialog", { name: "Filter by tags" })).toBe(panel)
  })

  it("keeps → for the search box in a right-to-left menu, where → goes back", async () => {
    const panel = await openPanel({ dir: "rtl" })
    const input = searchBox(panel) as HTMLInputElement
    await userEvent.type(input, "repo")
    await userEvent.keyboard("{ArrowLeft}{ArrowRight}")

    expect(input.selectionStart).toBe(4)
    expect(screen.getByRole("dialog", { name: "Filter by tags" })).toBe(panel)

    // With the box empty, → is the way back again.
    await userEvent.clear(input)
    await userEvent.keyboard("{ArrowRight}")
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("goes back to the row on ← from an empty search box", async () => {
    const panel = await openPanel()
    await userEvent.click(searchBox(panel))
    await userEvent.keyboard("{ArrowLeft}")

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(
      screen.getByRole("menuitem", { name: "Filter by tags" })
    ).toHaveFocus()
  })

  it("cycles Tab through the panel's controls, both ways", async () => {
    const panel = await openPanel()
    const manage = within(panel).getByRole("button", { name: "Manage tags…" })
    const any = within(panel).getByRole("radio", { name: "Any" })
    await userEvent.click(searchBox(panel))

    // Clear filter is disabled with nothing picked, so it is skipped.
    await userEvent.keyboard("{Tab}")
    expect(manage).toHaveFocus()
    await userEvent.keyboard("{Tab}")
    expect(any).toHaveFocus()
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}")
    expect(manage).toHaveFocus()
    expect(screen.getByRole("dialog", { name: "Filter by tags" })).toBe(panel)
  })

  it("tabs on from the tag list in document order, as the popover did", async () => {
    const panel = await openPanel({ filter: { tagIds: [1], mode: "any" } })
    const list = panel.querySelector("[cmdk-list]")
    // A press on a tag row leaves focus on the list, between the search box
    // and the footer.
    await userEvent.click(within(panel).getByText("open-tag"))
    expect(list).toHaveFocus()
    await userEvent.keyboard("{Tab}")
    expect(
      within(panel).getByRole("button", { name: "Clear filter" })
    ).toHaveFocus()

    await userEvent.click(within(panel).getByText("open-tag"))
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}")
    expect(searchBox(panel)).toHaveFocus()
  })

  it("tabs from the search box to Clear filter while a filter is on", async () => {
    const panel = await openPanel({ filter: { tagIds: [1], mode: "any" } })
    await userEvent.click(searchBox(panel))
    await userEvent.keyboard("{Tab}")

    expect(
      within(panel).getByRole("button", { name: "Clear filter" })
    ).toHaveFocus()
  })

  it("closes the whole menu on Escape from the search box", async () => {
    const panel = await openPanel()
    await userEvent.click(searchBox(panel))
    await userEvent.keyboard("{Escape}")

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    expect(screen.queryByRole("dialog")).toBeNull()
  })
})

describe("SidebarTagFilterSubmenu manage entry", () => {
  it("leads to the tag manager, closing the whole menu on the way", async () => {
    const panel = await openPanel()
    await userEvent.click(within(panel).getByText("Manage tags…"))

    // No folder of its own: the manager opens on the conversation on screen's.
    expect(h.openConversationTagsManager).toHaveBeenCalledWith()
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("is offered before there is any tag to filter by", async () => {
    resetConversationTagsStore()
    const panel = await openPanel()
    expect(
      within(panel).getByText(
        "No tags yet. Add one from a conversation's menu."
      )
    ).toBeTruthy()
    await userEvent.click(within(panel).getByText("Manage tags…"))
    expect(h.openConversationTagsManager).toHaveBeenCalledTimes(1)
  })
})
