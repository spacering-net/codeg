import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { FolderSelect, type FolderSelectOption } from "./folder-select"

// `next-intl` echoes keys, so the search box's placeholder reads back as
// "searchFolder" and the empty state as "noFolders".
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const FOLDERS: FolderSelectOption[] = [
  { id: 1, name: "codeg", alias: "My Project", path: "/work/codeg" },
  { id: 2, name: "other-repo", alias: null, path: "/work/other-repo" },
]

function open(folders = FOLDERS, props = {}) {
  const onChange = vi.fn()
  const onSelectAll = vi.fn()
  render(
    <FolderSelect
      folders={folders}
      value={null}
      onChange={onChange}
      allLabel="allFolders"
      onSelectAll={onSelectAll}
      {...props}
    />
  )
  return { onChange, onSelectAll, user: userEvent.setup() }
}

describe("FolderSelect", () => {
  it("keeps the real folder name visible beside the alias, over its path", async () => {
    const { user } = open()
    await user.click(screen.getByRole("button"))

    // `alias [ name ]` — the alias leads, but the on-disk name is still there,
    // which is the whole point: two folders aliased alike stay distinguishable.
    const row = screen
      .getByText("[ codeg ]")
      .closest("[data-slot=command-item]")
    expect(row?.textContent).toContain("My Project")
    expect(row?.textContent).toContain("/work/codeg")
    // An un-aliased folder shows its bare name (no empty brackets).
    expect(screen.getByText("other-repo")).toBeTruthy()
  })

  it("finds an aliased folder by its real directory name", async () => {
    const { user } = open()
    await user.click(screen.getByRole("button"))
    await user.type(screen.getByPlaceholderText("searchFolder"), "codeg")

    expect(screen.getByText("[ codeg ]")).toBeTruthy()
    expect(screen.queryByText("other-repo")).toBeNull()
  })

  it("finds a folder by its alias and by its path", async () => {
    const { user } = open()
    await user.click(screen.getByRole("button"))
    const search = screen.getByPlaceholderText("searchFolder")

    await user.type(search, "My Proj")
    expect(screen.getByText("[ codeg ]")).toBeTruthy()
    expect(screen.queryByText("other-repo")).toBeNull()

    await user.clear(search)
    await user.type(search, "/work/other")
    expect(screen.getByText("other-repo")).toBeTruthy()
    expect(screen.queryByText("[ codeg ]")).toBeNull()
  })

  it("reports the picked folder's id and closes", async () => {
    const { user, onChange } = open()
    await user.click(screen.getByRole("button"))
    await user.click(screen.getByText("other-repo"))

    expect(onChange).toHaveBeenCalledWith(2)
    expect(screen.queryByPlaceholderText("searchFolder")).toBeNull()
  })

  it("keeps the pinned all-folders row reachable under a search that matches no folder", async () => {
    const { user, onSelectAll } = open()
    await user.click(screen.getByRole("button"))
    await user.type(screen.getByPlaceholderText("searchFolder"), "zzzz")

    expect(screen.queryByText("other-repo")).toBeNull()
    // Two nodes read "allFolders" — the trigger's own summary and the pinned
    // row; the row is the one inside the list.
    const row = screen
      .getAllByText("allFolders")
      .find((el) => el.closest("[data-slot=command-item]"))
    await user.click(row!)
    expect(onSelectAll).toHaveBeenCalled()
  })

  it("shows the selected folder as `alias [ name ]` on the trigger", async () => {
    const user = userEvent.setup()
    render(
      <FolderSelect
        folders={FOLDERS}
        value={1}
        onChange={vi.fn()}
        allLabel="allFolders"
      />
    )
    const trigger = screen.getByRole("button")
    expect(trigger.textContent).toContain("My Project")
    expect(trigger.textContent).toContain("[ codeg ]")
    // The hover hint is a tooltip, not a native `title`, and it carries the
    // path — the one thing the trigger never shows. The folder's own name is
    // NOT repeated there: it is the trigger's own text.
    expect(trigger).not.toHaveAttribute("title")
    await user.hover(trigger)
    const tip = await screen.findByRole("tooltip")
    expect(tip).toHaveTextContent("/work/codeg")
    expect(tip).not.toHaveTextContent("My Project")
  })

  // A disabled trigger dispatches no pointer events, so Radix can never open —
  // the native `title` (which browsers do show on a disabled control) is the
  // only mechanism left, and the pinned-folder field in the task editor is
  // exactly that case.
  it("falls back to a native title while disabled", () => {
    render(
      <FolderSelect
        folders={FOLDERS}
        value={1}
        onChange={vi.fn()}
        title="Working folder"
        disabled
      />
    )
    expect(screen.getByRole("button")).toHaveAttribute(
      "title",
      "Working folder · /work/codeg"
    )
  })

  it("falls back to the placeholder and stays shut while disabled", async () => {
    const onChange = vi.fn()
    render(
      <FolderSelect
        folders={FOLDERS}
        value={null}
        onChange={onChange}
        placeholder="folderPlaceholder"
        disabled
      />
    )
    const trigger = screen.getByRole("button")
    expect(trigger.textContent).toContain("folderPlaceholder")

    await userEvent.setup().click(trigger)
    expect(screen.queryByPlaceholderText("searchFolder")).toBeNull()
  })

  it("never renders a still-set selection as the all-folders state", () => {
    // The folder left the workspace while it was the selection. The caller is
    // still filtering (and saving) by id 9, so the trigger must not claim the
    // opposite; it names the id instead.
    render(
      <FolderSelect
        folders={FOLDERS}
        value={9}
        onChange={vi.fn()}
        allLabel="allFolders"
        onSelectAll={vi.fn()}
      />
    )
    const trigger = screen.getByRole("button")
    expect(trigger.textContent).toContain("#9")
    expect(trigger.textContent).not.toContain("allFolders")
  })

  it("does not check the all-folders row while a folder it cannot resolve is selected", async () => {
    const allRowCheck = () =>
      screen
        .getAllByText("allFolders")
        .find((el) => el.closest("[data-slot=command-item]"))
        ?.closest("[data-slot=command-item]")
        ?.querySelector("svg.lucide-check") ?? null

    // Control: "all" really is the selection, so the row carries the check.
    const first = open(FOLDERS, { value: null })
    await first.user.click(screen.getByRole("button"))
    expect(allRowCheck()).not.toBeNull()
    cleanup()

    // An id the list can't resolve is NOT "all" — no check.
    const { user } = open(FOLDERS, { value: 9 })
    await user.click(screen.getByRole("button"))
    expect(allRowCheck()).toBeNull()
  })

  it("lists a folder it only knows by id (no path, no alias)", async () => {
    const { user } = open([{ id: 7, name: "#7" }])
    await user.click(screen.getByRole("button"))
    expect(screen.getByText("#7")).toBeTruthy()
  })
})
