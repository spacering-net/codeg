import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  copyTextFromMenu: vi.fn(async () => true),
  copyFilesToClipboard: vi.fn(async () => undefined),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock("@/lib/utils", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/utils")>("@/lib/utils")
  return { ...actual, copyTextFromMenu: mocks.copyTextFromMenu }
})

vi.mock("@/lib/clipboard-files", () => ({
  copyFilesToClipboard: mocks.copyFilesToClipboard,
}))

vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}))

vi.mock("next-intl", () => ({
  // The labels under test are the keys themselves; the real strings live in
  // the message catalogs and are covered by the i18n parity suite.
  useTranslations: () => (key: string, params?: Record<string, string>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"

import { FileTreeCopySubContent } from "./file-tree-copy-menu"

function renderMenu(
  overrides: Partial<{
    name: string
    relativePath: string
    absolutePath: string
    kind: "file" | "dir"
    remote: boolean
  }> = {}
) {
  const props = {
    name: "api.ts",
    relativePath: "src/lib/api.ts",
    absolutePath: "/Users/me/repo/src/lib/api.ts",
    kind: "file" as const,
    remote: false,
    ...overrides,
  }
  render(
    <ContextMenu>
      <ContextMenuTrigger data-testid="target">row</ContextMenuTrigger>
      <ContextMenuContent>
        {/* Pinned open: what's under test is the submenu's contents, not
            Radix's hover-to-open choreography. */}
        <ContextMenuSub open>
          <ContextMenuSubTrigger>copy</ContextMenuSubTrigger>
          <FileTreeCopySubContent {...props} />
        </ContextMenuSub>
      </ContextMenuContent>
    </ContextMenu>
  )
  fireEvent.contextMenu(screen.getByTestId("target"))
}

function item(name: string): HTMLElement {
  return screen.getByRole("menuitem", { name })
}

describe("FileTreeCopySubContent", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.copyTextFromMenu.mockResolvedValue(true)
    mocks.copyFilesToClipboard.mockResolvedValue(undefined)
  })

  it("copies the workspace-relative path, not the absolute one", async () => {
    renderMenu()
    fireEvent.click(item("copyRelativePath"))
    await waitFor(() =>
      expect(mocks.copyTextFromMenu).toHaveBeenCalledWith("src/lib/api.ts")
    )
    expect(mocks.toastSuccess).toHaveBeenCalledWith("toasts.pathCopied")
  })

  it("copies the absolute path from the other row", async () => {
    renderMenu()
    fireEvent.click(item("copyAbsolutePath"))
    await waitFor(() =>
      expect(mocks.copyTextFromMenu).toHaveBeenCalledWith(
        "/Users/me/repo/src/lib/api.ts"
      )
    )
  })

  it("reports a refused clipboard write instead of claiming success", async () => {
    // The execCommand fallback returns false in a non-secure web context; a
    // success toast there would be a lie.
    mocks.copyTextFromMenu.mockResolvedValue(false)
    renderMenu()
    fireEvent.click(item("copyRelativePath"))
    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith("toasts.copyPathFailed")
    )
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
  })

  it("puts the file itself on the OS clipboard by absolute path", async () => {
    renderMenu()
    fireEvent.click(item("copyFileItself"))
    await waitFor(() =>
      expect(mocks.copyFilesToClipboard).toHaveBeenCalledWith([
        "/Users/me/repo/src/lib/api.ts",
      ])
    )
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      'toasts.fileCopied:{"name":"api.ts"}'
    )
  })

  it("labels a directory row as a folder", () => {
    renderMenu({ kind: "dir", name: "lib", relativePath: "src/lib" })
    expect(item("copyDirectoryItself")).toBeTruthy()
    expect(
      screen.queryByRole("menuitem", { name: "copyFileItself" })
    ).toBeNull()
  })

  it("surfaces a failed native copy", async () => {
    mocks.copyFilesToClipboard.mockRejectedValue(new Error("clipboard busy"))
    renderMenu()
    fireEvent.click(item("copyFileItself"))
    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        'toasts.copyFileFailed:{"name":"api.ts"}',
        { description: "clipboard busy" }
      )
    )
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
  })

  it("hides the copy-the-file-itself row when the workspace is remote", () => {
    // Web and remote-desktop both put the files on another host: the native
    // copy would fill the SERVER's clipboard, so the row must not exist.
    renderMenu({ remote: true })
    expect(item("copyRelativePath")).toBeTruthy()
    expect(item("copyAbsolutePath")).toBeTruthy()
    expect(
      screen.queryByRole("menuitem", { name: "copyFileItself" })
    ).toBeNull()
  })
})
