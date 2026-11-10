import { useState } from "react"
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type {
  DirectoryEntry,
  FolderDetail,
  FolderLinkDetail,
  FolderLinkPlan,
} from "@/lib/types"
import { WorkspaceFolderDialog } from "./workspace-folder-dialog"

const api = vi.hoisted(() => ({
  getHomeDirectory: vi.fn(),
  listDirectoryEntries: vi.fn(),
  createDirectory: vi.fn(),
  listFolderLinks: vi.fn(),
  previewFolderLinks: vi.fn(),
  createFolderLinks: vi.fn(),
  renameFolderLink: vi.fn(),
  repairFolderLink: vi.fn(),
  removeFolderLink: vi.fn(),
}))
vi.mock("@/lib/api", () => api)

// Default to the in-app browser path: the native picker is a shortcut, not a
// separate flow, and jsdom has no Tauri. Individual tests opt into desktop.
const platform = vi.hoisted(() => ({
  desktop: false,
  openFileDialog: vi.fn(),
}))
vi.mock("@/lib/platform", () => ({
  isDesktop: () => platform.desktop,
  openFileDialog: platform.openFileDialog,
}))
vi.mock("@/lib/transport", () => ({
  getActiveRemoteConnectionId: () => null,
}))

const openFolder = vi.hoisted(() => vi.fn())
vi.mock("@/stores/app-workspace-store", () => ({
  useAppWorkspaceStore: (selector: (state: unknown) => unknown) =>
    selector({ openFolder }),
}))

const toast = vi.hoisted(() => ({
  error: vi.fn(),
  warning: vi.fn(),
  success: vi.fn(),
}))
vi.mock("sonner", () => ({ toast }))

const dir = (
  name: string,
  path: string,
  hasChildren = false
): DirectoryEntry => ({ name, path, hasChildren })

const folder = (overrides: Partial<FolderDetail> = {}): FolderDetail => ({
  id: 7,
  name: "root",
  path: "/home/me/root",
  git_branch: null,
  default_agent_type: null,
  last_opened_at: "2026-08-03T00:00:00Z",
  sort_order: 1,
  color: "inherit",
  parent_id: null,
  kind: "regular",
  alias: null,
  group_id: null,
  ...overrides,
})

const link = (overrides: Partial<FolderLinkDetail> = {}): FolderLinkDetail => ({
  id: 1,
  folderId: 7,
  name: "api",
  targetPath: "/home/me/work/api",
  status: "ok",
  ...overrides,
})

const plan = (overrides: Partial<FolderLinkPlan> = {}): FolderLinkPlan => ({
  targetPath: "/home/me/work/api",
  baseName: "api",
  name: "api",
  renamed: false,
  collidesWithExistingEntry: false,
  rejection: null,
  existingLinkName: null,
  ...overrides,
})

function Harness({ manage }: { manage?: FolderDetail }) {
  const [open, setOpen] = useState(true)
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <WorkspaceFolderDialog
        open={open}
        onOpenChange={setOpen}
        folder={manage ?? null}
      />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  platform.desktop = false
  api.getHomeDirectory.mockResolvedValue("/home/me")
  api.listDirectoryEntries.mockResolvedValue([])
  api.listFolderLinks.mockResolvedValue([])
  api.previewFolderLinks.mockResolvedValue([])
  api.createFolderLinks.mockResolvedValue([])
  openFolder.mockResolvedValue(folder())
})

describe("WorkspaceFolderDialog — creation flow", () => {
  it("opens the picked folder and advances to the linking step", async () => {
    api.listDirectoryEntries.mockResolvedValue([
      dir("root", "/home/me/root"),
      dir("other", "/home/me/other"),
    ])
    render(<Harness />)
    await screen.findByDisplayValue("/home/me")

    fireEvent.click(screen.getByRole("button", { name: "root" }))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Next" }))
    })

    expect(openFolder).toHaveBeenCalledWith("/home/me/root")
    // Step 2 is up: the root is echoed back and links can be added.
    expect(await screen.findByText("/home/me/root")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: /Add folders/ })
    ).toBeInTheDocument()
  })

  it("stays on step 1 and reports when the folder cannot be opened", async () => {
    api.listDirectoryEntries.mockResolvedValue([dir("root", "/home/me/root")])
    openFolder.mockRejectedValue(new Error("nope"))
    render(<Harness />)
    await screen.findByDisplayValue("/home/me")

    fireEvent.click(screen.getByRole("button", { name: "root" }))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Next" }))
    })

    expect(toast.error).toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Next" })).toBeInTheDocument()
  })

  it("makes a new folder and opens it as the workspace", async () => {
    api.listDirectoryEntries.mockImplementation((path: string) =>
      Promise.resolve(
        path === "/home/me" ? [dir("other", "/home/me/other")] : []
      )
    )
    api.createDirectory.mockResolvedValue("/home/me/fresh")
    openFolder.mockResolvedValue(folder({ path: "/home/me/fresh" }))
    render(<Harness />)
    await screen.findByText("other")

    fireEvent.click(screen.getByRole("button", { name: "New folder" }))
    const name = screen.getByRole("textbox", { name: "Folder name" })
    fireEvent.change(name, { target: { value: "fresh" } })
    await act(async () => {
      fireEvent.keyDown(name, { key: "Enter" })
    })

    expect(api.createDirectory).toHaveBeenCalledWith("/home/me", "fresh")
    await screen.findByDisplayValue("/home/me/fresh")
    // Creating is not opening: that still waits for Next.
    expect(openFolder).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Next" }))
    })
    expect(openFolder).toHaveBeenCalledWith("/home/me/fresh")
    expect(await screen.findByText("/home/me/fresh")).toBeInTheDocument()
  })

  it("does not offer a new folder when picking link targets", async () => {
    render(<Harness manage={folder()} />)
    fireEvent.click(await screen.findByRole("button", { name: /Add folders/ }))
    await screen.findByRole("button", { name: "Go to parent directory" })
    expect(
      screen.queryByRole("button", { name: "New folder" })
    ).not.toBeInTheDocument()
  })

  // Double-clicking a row opens it and moves on to the links step, which
  // unmounts the browser without it ever going inactive. "Change" then brings
  // up a new one. A late answer to the first must not land in the second.
  it("keeps a later pick when a new folder lands after the browser has gone", async () => {
    api.listDirectoryEntries.mockImplementation((path: string) =>
      Promise.resolve(
        path === "/home/me"
          ? [dir("work", "/home/me/work"), dir("other", "/home/me/other")]
          : []
      )
    )
    let finish: (path: string) => void = () => {}
    api.createDirectory.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve
        })
    )
    render(<Harness />)
    await screen.findByText("work")
    fireEvent.click(screen.getByRole("button", { name: "New folder" }))
    const name = screen.getByRole("textbox", { name: "Folder name" })
    fireEvent.change(name, { target: { value: "fresh" } })
    await act(async () => {
      fireEvent.keyDown(name, { key: "Enter" })
    })

    await act(async () => {
      fireEvent.doubleClick(screen.getByRole("button", { name: "work" }))
    })
    fireEvent.click(await screen.findByRole("button", { name: "Change" }))
    fireEvent.click(await screen.findByRole("button", { name: "other" }))
    await screen.findByDisplayValue("/home/me/other")

    await act(async () => {
      finish("/home/me/fresh")
    })

    expect(screen.getByDisplayValue("/home/me/other")).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Next" }))
    })
    expect(openFolder).toHaveBeenLastCalledWith("/home/me/other")
  })

  it("keeps a later pick when a listing lands after the browser has gone", async () => {
    let finishListing: (entries: DirectoryEntry[]) => void = () => {}
    api.listDirectoryEntries.mockImplementation((path: string) => {
      if (path === "/srv/slow") {
        return new Promise<DirectoryEntry[]>((resolve) => {
          finishListing = resolve
        })
      }
      return Promise.resolve(
        path === "/home/me"
          ? [dir("work", "/home/me/work"), dir("other", "/home/me/other")]
          : []
      )
    })
    render(<Harness />)
    await screen.findByText("work")
    const pathBox = screen.getByDisplayValue("/home/me")
    fireEvent.change(pathBox, { target: { value: "/srv/slow" } })
    await act(async () => {
      fireEvent.keyDown(pathBox, { key: "Enter" })
    })

    await act(async () => {
      fireEvent.doubleClick(screen.getByRole("button", { name: "work" }))
    })
    fireEvent.click(await screen.findByRole("button", { name: "Change" }))
    fireEvent.click(await screen.findByRole("button", { name: "other" }))
    await screen.findByDisplayValue("/home/me/other")

    await act(async () => {
      finishListing([])
    })

    expect(screen.getByDisplayValue("/home/me/other")).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Next" }))
    })
    expect(openFolder).toHaveBeenLastCalledWith("/home/me/other")
  })
})

describe("WorkspaceFolderDialog — manage mode", () => {
  it("starts on the links list and skips root selection", async () => {
    api.listFolderLinks.mockResolvedValue([link()])
    render(<Harness manage={folder()} />)

    expect(await screen.findByText("api")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull()
    // The root cannot be re-picked while managing an existing folder.
    expect(screen.queryByRole("button", { name: "Change" })).toBeNull()
  })

  it("shows the empty state when nothing is linked", async () => {
    render(<Harness manage={folder()} />)
    expect(
      await screen.findByText("No linked folders yet.")
    ).toBeInTheDocument()
  })

  it("surfaces a broken link with a repair action", async () => {
    api.listFolderLinks.mockResolvedValue([link({ status: "missing" })])
    render(<Harness manage={folder()} />)

    expect(
      await screen.findByText("The link is gone from this folder")
    ).toBeInTheDocument()
    const repair = screen.getByRole("button", { name: "Recreate link" })
    api.repairFolderLink.mockResolvedValue(link())
    await act(async () => {
      fireEvent.click(repair)
    })
    expect(api.repairFolderLink).toHaveBeenCalledWith(1)
  })

  it("removes a link on demand", async () => {
    api.listFolderLinks.mockResolvedValue([link()])
    api.removeFolderLink.mockResolvedValue(undefined)
    render(<Harness manage={folder()} />)
    await screen.findByText("api")

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove link" }))
    })
    expect(api.removeFolderLink).toHaveBeenCalledWith(1, true)
  })

  it("blocks a rename that duplicates another link's name", async () => {
    api.listFolderLinks.mockResolvedValue([
      link(),
      link({ id: 2, name: "web", targetPath: "/home/me/work/web" }),
    ])
    render(<Harness manage={folder()} />)
    await screen.findByText("api")

    fireEvent.click(screen.getAllByRole("button", { name: "Rename" })[0])
    const input = screen.getByDisplayValue("api")
    // Case-insensitive: `WEB` and `web` are the same entry on macOS/Windows.
    fireEvent.change(input, { target: { value: "WEB" } })

    expect(screen.getByText("This name is already used")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
    expect(api.renameFolderLink).not.toHaveBeenCalled()
  })

  it("commits a valid rename", async () => {
    api.listFolderLinks.mockResolvedValue([link()])
    api.renameFolderLink.mockResolvedValue(link({ name: "backend" }))
    render(<Harness manage={folder()} />)
    await screen.findByText("api")

    fireEvent.click(screen.getByRole("button", { name: "Rename" }))
    fireEvent.change(screen.getByDisplayValue("api"), {
      target: { value: "backend" },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }))
    })
    expect(api.renameFolderLink).toHaveBeenCalledWith(1, "backend")
  })
})

describe("WorkspaceFolderDialog — adding link targets", () => {
  async function goToAddView() {
    render(<Harness manage={folder()} />)
    await screen.findByText("No linked folders yet.")
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Add folders/ }))
    })
  }

  it("previews the selection and queues it with the resolved name", async () => {
    api.listDirectoryEntries.mockResolvedValue([
      dir("api", "/home/me/work/api"),
    ])
    api.previewFolderLinks.mockResolvedValue([plan()])
    await goToAddView()

    fireEvent.click(await screen.findByRole("button", { name: /api/ }))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add" }))
    })

    expect(api.previewFolderLinks).toHaveBeenCalledWith(7, [
      "/home/me/work/api",
    ])
    expect(screen.getByDisplayValue("api")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Link 1 folder(s)" })
    ).toBeEnabled()
  })

  it("explains an auto-rename caused by an existing entry", async () => {
    api.listDirectoryEntries.mockResolvedValue([
      dir("api", "/home/me/work/api"),
    ])
    api.previewFolderLinks.mockResolvedValue([
      plan({ name: "api-2", renamed: true, collidesWithExistingEntry: true }),
    ])
    await goToAddView()

    fireEvent.click(await screen.findByRole("button", { name: /api/ }))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add" }))
    })

    expect(screen.getByDisplayValue("api-2")).toBeInTheDocument()
    expect(
      screen.getByText("Renamed — api already exists in this folder")
    ).toBeInTheDocument()
  })

  it("lists a rejected pick instead of silently dropping it", async () => {
    api.listDirectoryEntries.mockResolvedValue([
      dir("inner", "/home/me/root/inner"),
    ])
    api.previewFolderLinks.mockResolvedValue([
      plan({ targetPath: "/home/me/root/inner", rejection: "inside_root" }),
    ])
    await goToAddView()

    fireEvent.click(await screen.findByRole("button", { name: /inner/ }))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add" }))
    })

    expect(screen.getByText("Already inside the workspace")).toBeInTheDocument()
    // Nothing queued, so there is no create button.
    expect(screen.queryByRole("button", { name: /^Link \d/ })).toBeNull()
  })

  it("names the existing link when the target is already linked", async () => {
    api.listDirectoryEntries.mockResolvedValue([
      dir("api", "/home/me/work/api"),
    ])
    api.previewFolderLinks.mockResolvedValue([
      plan({ rejection: "already_linked", existingLinkName: "backend" }),
    ])
    await goToAddView()

    fireEvent.click(await screen.findByRole("button", { name: /api/ }))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add" }))
    })

    expect(screen.getByText("Already linked as backend")).toBeInTheDocument()
  })

  it("blocks creation while a queued name is invalid", async () => {
    api.listDirectoryEntries.mockResolvedValue([
      dir("api", "/home/me/work/api"),
    ])
    api.previewFolderLinks.mockResolvedValue([plan()])
    await goToAddView()

    fireEvent.click(await screen.findByRole("button", { name: /api/ }))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add" }))
    })

    fireEvent.change(screen.getByDisplayValue("api"), {
      target: { value: "a/b" },
    })
    expect(
      screen.getByText('Cannot contain / \\ : * ? " < > |')
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Link 1 folder(s)" })
    ).toBeDisabled()
  })

  it("creates the queued links with the edited names", async () => {
    api.listDirectoryEntries.mockResolvedValue([
      dir("api", "/home/me/work/api"),
    ])
    api.previewFolderLinks.mockResolvedValue([plan()])
    api.createFolderLinks.mockResolvedValue([link()])
    await goToAddView()

    fireEvent.click(await screen.findByRole("button", { name: /api/ }))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add" }))
    })
    fireEvent.change(screen.getByDisplayValue("api"), {
      target: { value: "backend" },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Link 1 folder(s)" }))
    })

    expect(api.createFolderLinks).toHaveBeenCalledWith(
      7,
      [{ path: "/home/me/work/api", name: "backend" }],
      true
    )
  })

  it("warns when the backend could only link some of them", async () => {
    api.listDirectoryEntries.mockResolvedValue([
      dir("api", "/home/me/work/api"),
      dir("web", "/home/me/work/web"),
    ])
    api.previewFolderLinks.mockResolvedValue([
      plan(),
      plan({ targetPath: "/home/me/work/web", baseName: "web", name: "web" }),
    ])
    api.createFolderLinks.mockResolvedValue([link()])
    await goToAddView()

    fireEvent.click(await screen.findByRole("button", { name: /api/ }))
    fireEvent.click(screen.getByRole("button", { name: /web/ }))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add 2" }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Link 2 folder(s)" }))
    })

    expect(toast.warning).toHaveBeenCalled()
  })

  it("keeps earlier picks when a second batch is added", async () => {
    api.listDirectoryEntries.mockResolvedValue([
      dir("api", "/home/me/work/api"),
      dir("web", "/home/me/work/web"),
    ])
    api.previewFolderLinks.mockResolvedValueOnce([plan()])
    await goToAddView()
    fireEvent.click(await screen.findByRole("button", { name: /api/ }))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add" }))
    })

    api.previewFolderLinks.mockResolvedValueOnce([
      plan({ targetPath: "/home/me/work/web", baseName: "web", name: "web" }),
    ])
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Add folders/ }))
    })
    fireEvent.click(await screen.findByRole("button", { name: /web/ }))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add" }))
    })

    expect(screen.getByDisplayValue("api")).toBeInTheDocument()
    expect(screen.getByDisplayValue("web")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Link 2 folder(s)" })
    ).toBeInTheDocument()
  })

  it("flags two queued picks that resolve to the same name", async () => {
    // The backend disambiguates within a batch, but the user can still edit one
    // into a collision before pressing create.
    api.listDirectoryEntries.mockResolvedValue([
      dir("api", "/home/me/work/api"),
      dir("web", "/home/me/work/web"),
    ])
    api.previewFolderLinks.mockResolvedValue([
      plan(),
      plan({ targetPath: "/home/me/work/web", baseName: "web", name: "web" }),
    ])
    await goToAddView()
    fireEvent.click(await screen.findByRole("button", { name: /api/ }))
    fireEvent.click(screen.getByRole("button", { name: /web/ }))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add 2" }))
    })

    fireEvent.change(screen.getByDisplayValue("web"), {
      target: { value: "api" },
    })
    expect(screen.getByText("This name is already used")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Link 2 folder(s)" })
    ).toBeDisabled()
  })

  it("discards the queue without creating anything", async () => {
    api.listDirectoryEntries.mockResolvedValue([
      dir("api", "/home/me/work/api"),
    ])
    api.previewFolderLinks.mockResolvedValue([plan()])
    await goToAddView()
    fireEvent.click(await screen.findByRole("button", { name: /api/ }))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add" }))
    })

    fireEvent.click(screen.getByRole("button", { name: "Discard" }))
    expect(api.createFolderLinks).not.toHaveBeenCalled()
    expect(screen.getByText("No linked folders yet.")).toBeInTheDocument()
  })

  it("returns to the list without adding anything on Back", async () => {
    api.listDirectoryEntries.mockResolvedValue([
      dir("api", "/home/me/work/api"),
    ])
    await goToAddView()
    fireEvent.click(await screen.findByRole("button", { name: /api/ }))

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Back" }))
    })
    expect(api.previewFolderLinks).not.toHaveBeenCalled()
    expect(screen.getByText("No linked folders yet.")).toBeInTheDocument()
  })

  it("respects the git-exclude opt-out", async () => {
    api.listDirectoryEntries.mockResolvedValue([
      dir("api", "/home/me/work/api"),
    ])
    api.previewFolderLinks.mockResolvedValue([plan()])
    api.createFolderLinks.mockResolvedValue([link()])
    await goToAddView()
    fireEvent.click(await screen.findByRole("button", { name: /api/ }))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add" }))
    })

    const toggle = screen.getByRole("checkbox")
    fireEvent.click(toggle)
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Link 1 folder(s)" }))
    })

    expect(api.createFolderLinks).toHaveBeenCalledWith(
      7,
      expect.anything(),
      false
    )
  })
})

describe("WorkspaceFolderDialog — native picker", () => {
  it("only fills the path box — opening still waits for the confirm", async () => {
    platform.desktop = true
    platform.openFileDialog.mockResolvedValue("/home/me/picked")
    render(<Harness />)
    await screen.findByDisplayValue("/home/me")

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "System picker" }))
    })

    expect(platform.openFileDialog).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
    })
    // The box moved, but nothing has landed in the sidebar yet.
    expect(screen.getByDisplayValue("/home/me/picked")).toBeInTheDocument()
    expect(openFolder).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Next" }))
    })
    expect(openFolder).toHaveBeenCalledWith("/home/me/picked")
  })

  it("stages a multi-select pick instead of linking it outright", async () => {
    platform.desktop = true
    platform.openFileDialog.mockResolvedValue([
      "/home/me/work/api",
      "/home/me/work/web",
    ])
    api.previewFolderLinks.mockResolvedValue([plan()])
    render(<Harness manage={folder()} />)
    await screen.findByText("No linked folders yet.")
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Add folders/ }))
    })

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "System picker" }))
    })

    expect(platform.openFileDialog).toHaveBeenCalledWith({
      directory: true,
      multiple: true,
    })
    expect(api.previewFolderLinks).not.toHaveBeenCalled()

    // Both picks are queued as ticks, so the confirm reads them, not the box.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add 2" }))
    })
    expect(api.previewFolderLinks).toHaveBeenCalledWith(7, [
      "/home/me/work/api",
      "/home/me/work/web",
    ])
  })

  it("stays out of the way when there is no native picker", async () => {
    render(<Harness />)
    await screen.findByDisplayValue("/home/me")
    expect(screen.queryByRole("button", { name: "System picker" })).toBeNull()
  })
})

describe("WorkspaceFolderDialog — link rows", () => {
  it("shows each link's real target path", async () => {
    api.listFolderLinks.mockResolvedValue([link()])
    render(<Harness manage={folder()} />)
    const row = (await screen.findByText("api")).closest("div")!
    expect(
      within(row.parentElement!).getByText("/home/me/work/api")
    ).toBeInTheDocument()
  })
})

describe("WorkspaceFolderDialog — selection bookkeeping", () => {
  it("does not re-add a folder the user unticked", async () => {
    // Clicking a row both ticks it and moves the path box onto it, so the box
    // still names the folder after it is unticked; only ticked rows count.
    api.listDirectoryEntries.mockResolvedValue([
      dir("api", "/home/me/work/api"),
      dir("web", "/home/me/work/web"),
    ])
    api.previewFolderLinks.mockResolvedValue([
      plan({ targetPath: "/home/me/work/web", baseName: "web", name: "web" }),
    ])
    render(<Harness manage={folder()} />)
    await screen.findByText("No linked folders yet.")
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Add folders/ }))
    })

    fireEvent.click(await screen.findByRole("button", { name: /web/ }))
    fireEvent.click(screen.getByRole("button", { name: /api/ }))
    fireEvent.click(screen.getByRole("button", { name: /api/ })) // untick
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add" }))
    })

    expect(api.previewFolderLinks).toHaveBeenCalledWith(7, [
      "/home/me/work/web",
    ])
  })

  it("uses the path box when nothing is ticked", async () => {
    api.listDirectoryEntries.mockResolvedValue([])
    api.previewFolderLinks.mockResolvedValue([])
    render(<Harness manage={folder()} />)
    await screen.findByText("No linked folders yet.")
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Add folders/ }))
    })

    const box = await screen.findByPlaceholderText("Enter directory path...")
    fireEvent.change(box, { target: { value: "/home/me/typed" } })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add" }))
    })

    expect(api.previewFolderLinks).toHaveBeenCalledWith(7, ["/home/me/typed"])
  })
})
