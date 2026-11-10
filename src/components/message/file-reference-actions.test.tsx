import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"

const mocks = vi.hoisted(() => ({
  isLocalDesktop: vi.fn(() => true),
  revealItemInDir: vi.fn(async () => {}),
  copyTextFromMenu: vi.fn(async () => true),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  ancestorContextMenu: vi.fn(),
  ancestorPointerDown: vi.fn(),
  folderPath: "/repo" as string | undefined,
  isWorkspaceFileApiAvailable: vi.fn(() => true),
  downloadWorkspaceFile:
    vi.fn<
      (
        root: string,
        path: string,
        name: string
      ) => Promise<{ status: string; savedPath?: string }>
    >(),
}))

vi.mock("@/lib/platform", () => ({
  isLocalDesktop: mocks.isLocalDesktop,
  revealItemInDir: mocks.revealItemInDir,
}))

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return {
    ...actual,
    isWorkspaceFileApiAvailable: mocks.isWorkspaceFileApiAvailable,
    downloadWorkspaceFile: mocks.downloadWorkspaceFile,
  }
})

vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}))

vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({
    activeFolderId: 1,
    activeFolder: mocks.folderPath ? { path: mocks.folderPath } : null,
  }),
}))

vi.mock("@/lib/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/utils")>()
  return { ...actual, copyTextFromMenu: mocks.copyTextFromMenu }
})

import {
  FileReferenceActions,
  resolveFileReferenceTarget,
  systemFileManagerLabelKey,
} from "./file-reference-actions"

function renderActions(target: string) {
  return render(
    // The outer handler stands in for the conversation panel's own context menu
    // (copy text / export / …), which wraps the whole transcript.
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <div
        onContextMenu={mocks.ancestorContextMenu}
        onPointerDown={mocks.ancestorPointerDown}
      >
        <FileReferenceActions target={target}>
          <button type="button" data-testid="badge">
            app.ts
          </button>
        </FileReferenceActions>
      </div>
    </NextIntlClientProvider>
  )
}

/** The context-menu trigger wrapped around the badge. */
function trigger(): HTMLElement {
  const element = document.querySelector<HTMLElement>("[data-file-actions]")
  if (!element) throw new Error("expected a context-menu trigger on the badge")
  return element
}

/** Right-click the file name. */
function openMenu(): void {
  fireEvent.contextMenu(trigger())
}

function item(name: string): HTMLElement {
  return screen.getByRole("menuitem", { name })
}

describe("resolveFileReferenceTarget", () => {
  it("resolves a file:// uri, dropping the line-range fragment", () => {
    expect(
      resolveFileReferenceTarget("file:///repo/src/app.ts#L10-25", "/repo")
    ).toEqual({ absolute: "/repo/src/app.ts", relative: "src/app.ts" })
  })

  it("resolves the sanitize-safe Windows form back to a drive path", () => {
    expect(
      resolveFileReferenceTarget("/C:/repo/src/app.ts", "C:/repo")
    ).toEqual({ absolute: "C:/repo/src/app.ts", relative: "src/app.ts" })
  })

  it("joins an explicitly-relative path onto the active folder", () => {
    expect(resolveFileReferenceTarget("./src/app.ts", "/repo")).toEqual({
      absolute: "/repo/src/app.ts",
      relative: "src/app.ts",
    })
  })

  it("reports no relative form for a file outside the folder", () => {
    expect(resolveFileReferenceTarget("/elsewhere/a.ts", "/repo")).toEqual({
      absolute: "/elsewhere/a.ts",
      relative: null,
    })
  })

  it("resolves dot segments the way the opener does before placing the file", () => {
    // `../site/a.md` opens `/site/a.md`: outside the folder, so no relative
    // form (and no download) even though `/repo/../site/a.md` starts with it.
    expect(resolveFileReferenceTarget("../site/a.md", "/repo")).toEqual({
      absolute: "/site/a.md",
      relative: null,
    })
    expect(resolveFileReferenceTarget("./src/../a.md", "/repo")).toEqual({
      absolute: "/repo/a.md",
      relative: "a.md",
    })
    // …and places it against the folder resolved the same way.
    expect(resolveFileReferenceTarget("./a.md", "/repo/../site")).toEqual({
      absolute: "/site/a.md",
      relative: "a.md",
    })
  })

  it("keeps a ~ path in tilde form (home only resolves through the backend)", () => {
    expect(resolveFileReferenceTarget("~/notes/todo.md", "/repo")).toEqual({
      absolute: "~/notes/todo.md",
      relative: null,
    })
  })

  it("returns null for anything that isn't a local file", () => {
    expect(
      resolveFileReferenceTarget("https://example.com", "/repo")
    ).toBeNull()
    expect(resolveFileReferenceTarget("codeg://embedded/x", "/repo")).toBeNull()
    // Relative with no active folder: nothing could be revealed or copied.
    expect(resolveFileReferenceTarget("./src/app.ts", null)).toBeNull()
  })
})

describe("systemFileManagerLabelKey", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each([
    ["MacIntel", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "Finder"],
    ["Win32", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Explorer"],
    ["Linux x86_64", "Mozilla/5.0 (X11; Linux x86_64)", "FileManager"],
  ])("maps %s to openIn%s", (platform, userAgent, expected) => {
    vi.stubGlobal("navigator", { platform, userAgent })
    expect(systemFileManagerLabelKey()).toBe(`openIn${expected}`)
  })
})

describe("FileReferenceActions", () => {
  beforeEach(() => {
    mocks.isLocalDesktop.mockReturnValue(true)
    mocks.revealItemInDir.mockResolvedValue(undefined)
    mocks.copyTextFromMenu.mockResolvedValue(true)
    mocks.copyTextFromMenu.mockClear()
    mocks.revealItemInDir.mockClear()
    mocks.toastSuccess.mockClear()
    mocks.toastError.mockClear()
    mocks.ancestorContextMenu.mockClear()
    mocks.ancestorPointerDown.mockClear()
    mocks.folderPath = "/repo"
    mocks.isWorkspaceFileApiAvailable.mockReturnValue(true)
    mocks.downloadWorkspaceFile.mockReset()
    mocks.downloadWorkspaceFile.mockResolvedValue({ status: "started" })
  })

  it("passes the badge through untouched when the target has no local path", () => {
    const { container } = renderActions("codeg://embedded/abc-123")
    expect(screen.getByTestId("badge")).toBeInTheDocument()
    expect(document.querySelector("[data-file-actions]")).toBeNull()

    // …and its right-click still reaches the conversation panel's own menu.
    fireEvent.contextMenu(screen.getByTestId("badge"))
    expect(mocks.ancestorContextMenu).toHaveBeenCalled()
    expect(container.querySelector("[role='menu']")).toBeNull()
  })

  it("opens on right-click, and only on right-click", () => {
    renderActions("file:///repo/src/app.ts")
    // A left click belongs to the badge (it opens the file in the workspace).
    fireEvent.click(trigger())
    expect(screen.queryByRole("menu")).toBeNull()

    openMenu()
    expect(screen.getByRole("menu")).toBeInTheDocument()
  })

  it("keeps a touch long-press from arming the conversation menu too", () => {
    renderActions("file:///repo/src/app.ts")
    // jsdom's fireEvent.pointerDown drops `pointerType`, so pin it by hand.
    const event = new MouseEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
    })
    Object.defineProperty(event, "pointerType", { value: "touch" })
    fireEvent(trigger(), event)

    expect(mocks.ancestorPointerDown).not.toHaveBeenCalled()
  })

  it("keeps the right-click from also opening the conversation menu", () => {
    renderActions("file:///repo/src/app.ts")
    openMenu()

    expect(screen.getByRole("menu")).toBeInTheDocument()
    // The transcript is wrapped in the conversation panel's own context menu;
    // both opening at once was the bug this stopPropagation fixes.
    expect(mocks.ancestorContextMenu).not.toHaveBeenCalled()
  })

  it("reveals the absolute path in the file manager", async () => {
    renderActions("file:///repo/src/app.ts#L10-25")
    openMenu()

    fireEvent.click(screen.getByRole("menuitem", { name: /^Open in/ }))
    await waitFor(() => {
      expect(mocks.revealItemInDir).toHaveBeenCalledWith("/repo/src/app.ts")
    })
  })

  it("copies the relative and the absolute path", async () => {
    renderActions("file:///repo/src/app.ts")
    openMenu()

    fireEvent.click(item("Copy relative path"))
    await waitFor(() => {
      expect(mocks.copyTextFromMenu).toHaveBeenCalledWith("src/app.ts")
    })
    expect(mocks.toastSuccess).toHaveBeenCalled()

    openMenu()
    fireEvent.click(item("Copy absolute path"))
    await waitFor(() => {
      expect(mocks.copyTextFromMenu).toHaveBeenCalledWith("/repo/src/app.ts")
    })
  })

  it("toasts when the copy fails", async () => {
    mocks.copyTextFromMenu.mockResolvedValue(false)
    renderActions("file:///repo/src/app.ts")
    openMenu()

    fireEvent.click(item("Copy absolute path"))
    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalled()
    })
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
  })

  it("disables the relative copy for a file outside the active folder", () => {
    renderActions("file:///elsewhere/a.ts")
    openMenu()

    expect(item("Copy relative path")).toHaveAttribute("data-disabled")
    expect(item("Copy absolute path")).not.toHaveAttribute("data-disabled")
  })

  it("hides the reveal row when the file manager is unreachable (web / remote)", () => {
    mocks.isLocalDesktop.mockReturnValue(false)
    renderActions("file:///repo/src/app.ts")
    openMenu()

    expect(screen.queryByRole("menuitem", { name: /^Open in/ })).toBeNull()
    expect(item("Copy absolute path")).toBeInTheDocument()
  })

  /** In web / remote-desktop mode the file sits on a host the browser can't
   * reach, so the download ticket is the only way to get the bytes out. */
  it("downloads through the workspace ticket, rooted at the active folder", async () => {
    renderActions("file:///repo/src/app.ts#L10-25")
    openMenu()

    fireEvent.click(item("Download file"))
    await waitFor(() => {
      expect(mocks.downloadWorkspaceFile).toHaveBeenCalledWith(
        "/repo",
        "src/app.ts",
        "app.ts"
      )
    })
    // The browser's own download manager reports progress; a toast on top of
    // it would be noise.
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
  })

  it("downloads from the folder the way the opener resolves it", async () => {
    // A click on `./a.md` under `/repo/../site` opens `/site/a.md`; the
    // download has to fetch that same file, so it is rooted the same way.
    mocks.folderPath = "/repo/../site"
    renderActions("./a.md")
    openMenu()

    fireEvent.click(item("Download file"))
    await waitFor(() => {
      expect(mocks.downloadWorkspaceFile).toHaveBeenCalledWith(
        "/site",
        "a.md",
        "a.md"
      )
    })
    expect(mocks.downloadWorkspaceFile).toHaveBeenCalledTimes(1)
  })

  it("offers no relative path or download for a `../` file outside the folder", () => {
    renderActions("../site/a.md")
    openMenu()

    expect(item("Copy relative path")).toHaveAttribute("data-disabled")
    expect(item("Download file")).toHaveAttribute("data-disabled")
    expect(item("Copy absolute path")).not.toHaveAttribute("data-disabled")
  })

  /** The remote-desktop path writes through a save dialog, so where the file
   * landed is the one outcome the user cannot see for themselves. */
  it("names the saved path when the download went through a save dialog", async () => {
    mocks.downloadWorkspaceFile.mockResolvedValue({
      status: "done",
      savedPath: "/Users/me/Downloads/app.ts",
    })
    renderActions("file:///repo/src/app.ts")
    openMenu()

    fireEvent.click(item("Download file"))
    await waitFor(() => {
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "Downloaded app.ts",
        expect.objectContaining({ description: "/Users/me/Downloads/app.ts" })
      )
    })
  })

  it("toasts when the download is refused", async () => {
    mocks.downloadWorkspaceFile.mockRejectedValue(new Error("File not found"))
    renderActions("file:///repo/src/app.ts")
    openMenu()

    fireEvent.click(item("Download file"))
    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Failed to download app.ts",
        expect.objectContaining({
          description: expect.stringMatching(/not found/),
        })
      )
    })
  })

  /** The ticket is issued against the workspace root, so a file outside it has
   * nothing to download from — same boundary as the relative-path copy. */
  it("disables the download for a file outside the active folder", () => {
    renderActions("file:///elsewhere/a.ts")
    openMenu()

    expect(item("Download file")).toHaveAttribute("data-disabled")
  })

  /** A local desktop window opens the file straight off its own disk; routing
   * that through a download server would be the wrong tool. */
  it("hides the download row on a local desktop window", () => {
    mocks.isWorkspaceFileApiAvailable.mockReturnValue(false)
    renderActions("file:///repo/src/app.ts")
    openMenu()

    expect(screen.queryByRole("menuitem", { name: "Download file" })).toBeNull()
    expect(item("Copy absolute path")).toBeInTheDocument()
  })
})
