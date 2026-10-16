import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { createRef, type ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type {
  WorkspaceContentSearchResult,
  WorkspaceFileEntry,
} from "@/lib/types"

const api = vi.hoisted(() => ({
  listWorkspaceFiles: vi.fn(),
  searchWorkspaceContent: vi.fn(),
  cancelWorkspaceSearch: vi.fn(),
}))
vi.mock("@/lib/api", () => api)

const platform = vi.hoisted(() => ({ current: "macos" }))
vi.mock("@/hooks/use-platform", () => ({
  detectPlatform: () => platform.current,
}))

// OverlayScrollbars needs real layout; a plain box is enough here.
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({
    children,
    className,
  }: {
    children: ReactNode
    className?: string
  }) => <div className={className}>{children}</div>,
}))

import {
  CONTENT_DEBOUNCE_MS,
  CONTENT_RESULT_LIMIT,
  FileTreeSearch,
  isFindShortcut,
  NAME_DEBOUNCE_MS,
  type FileTreeSearchHandle,
} from "./file-tree-search"

const ROOT = "/repo"

const LISTING: WorkspaceFileEntry[] = [
  { name: "src", path: "src", kind: "dir" },
  { name: "main.rs", path: "src/main.rs", kind: "file" },
  { name: "search.rs", path: "src/search.rs", kind: "file" },
  { name: "README.md", path: "README.md", kind: "file" },
  { name: "docs", path: "docs", kind: "dir" },
  { name: "search-guide.md", path: "docs/search-guide.md", kind: "file" },
]

function contentResult(
  files: { path: string; lines: [number, string][] }[],
  extra: Partial<WorkspaceContentSearchResult> = {}
): WorkspaceContentSearchResult {
  const out = files.map(({ path, lines }) => ({
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    matches: lines.map(([line, preview]) => ({
      line,
      preview,
      ranges: [[0, Math.min(3, preview.length)]] as [number, number][],
    })),
  }))
  return {
    files: out,
    result_count: out.reduce((n, f) => n + f.matches.length, 0),
    truncated: false,
    file_limit_reached: false,
    cancelled: false,
    files_searched: 10,
    files_skipped: 0,
    ...extra,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function setup(rootPath = ROOT) {
  const onOpenFile = vi.fn()
  const onRevealDir = vi.fn()
  const onActiveChange = vi.fn()
  const ref = createRef<FileTreeSearchHandle>()
  const view = render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <FileTreeSearch
        ref={ref}
        rootPath={rootPath}
        onOpenFile={onOpenFile}
        onRevealDir={onRevealDir}
        onActiveChange={onActiveChange}
      />
    </NextIntlClientProvider>
  )
  const input = screen.getByRole("combobox")
  return { ...view, input, ref, onOpenFile, onRevealDir, onActiveChange }
}

function type(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } })
}

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms)
  })
  await flush()
}

function optionTexts() {
  return screen.queryAllByRole("option").map((o) => o.textContent)
}

beforeEach(() => {
  vi.useFakeTimers()
  platform.current = "macos"
  api.listWorkspaceFiles.mockReset().mockResolvedValue(LISTING)
  api.searchWorkspaceContent.mockReset()
  api.cancelWorkspaceSearch.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
})

describe("FileTreeSearch: name search", () => {
  it("ranks the folder listing after the debounce and highlights the match", async () => {
    const { input, onActiveChange } = setup()
    type(input, "search")
    expect(onActiveChange).toHaveBeenLastCalledWith(true)
    await flush()
    expect(api.listWorkspaceFiles).toHaveBeenCalledWith(ROOT)

    // Nothing ranked until typing pauses.
    expect(screen.queryAllByRole("option")).toHaveLength(0)
    await advance(NAME_DEBOUNCE_MS)

    // Name hits outrank a path-only hit; the directory part is shown after
    // the name.
    expect(optionTexts()).toEqual(["search.rssrc", "search-guide.mddocs"])
    const marks = screen.getAllByRole("option")[0].querySelectorAll("mark")
    expect([...marks].map((m) => m.textContent)).toEqual(["search"])
    // The status line is announced and describes the box.
    const status = document.getElementById(
      input.getAttribute("aria-describedby") ?? ""
    )
    expect(status?.textContent).toBe("2 results")
  })

  it("fetches the listing once per search, not per keystroke", async () => {
    const { input } = setup()
    type(input, "s")
    type(input, "se")
    type(input, "sea")
    await advance(NAME_DEBOUNCE_MS)
    expect(api.listWorkspaceFiles).toHaveBeenCalledTimes(1)

    // Clearing and starting again refetches, so new files show up.
    type(input, "")
    type(input, "main")
    await advance(NAME_DEBOUNCE_MS)
    expect(api.listWorkspaceFiles).toHaveBeenCalledTimes(2)
    expect(optionTexts()).toEqual(["main.rssrc"])
  })

  it("opens the active result with Enter and moves with the arrow keys", async () => {
    const { input, onOpenFile } = setup()
    type(input, "search")
    await advance(NAME_DEBOUNCE_MS)

    fireEvent.keyDown(input, { key: "Enter" })
    expect(onOpenFile).toHaveBeenLastCalledWith("src/search.rs")

    fireEvent.keyDown(input, { key: "ArrowDown" })
    expect(input.getAttribute("aria-activedescendant")).toBe(
      screen.getAllByRole("option")[1].id
    )
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onOpenFile).toHaveBeenLastCalledWith("docs/search-guide.md")

    // Clamped at the ends.
    fireEvent.keyDown(input, { key: "ArrowDown" })
    fireEvent.keyDown(input, { key: "ArrowUp" })
    fireEvent.keyDown(input, { key: "ArrowUp" })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onOpenFile).toHaveBeenLastCalledWith("src/search.rs")
  })

  it("opens a file on click and reveals a directory in the tree", async () => {
    const { input, onOpenFile, onRevealDir, onActiveChange } = setup()
    type(input, "doc")
    await advance(NAME_DEBOUNCE_MS)

    const [dirRow, fileRow] = screen.getAllByRole("option")
    fireEvent.click(fileRow)
    expect(onOpenFile).toHaveBeenCalledWith("docs/search-guide.md")
    expect((input as HTMLInputElement).value).toBe("doc")

    // A directory has nothing to open: the search closes and the tree shows it.
    fireEvent.click(dirRow)
    expect(onRevealDir).toHaveBeenCalledWith("docs")
    expect((input as HTMLInputElement).value).toBe("")
    expect(onActiveChange).toHaveBeenLastCalledWith(false)
  })

  it("Esc clears the search, then a second Esc leaves the box", async () => {
    const { input, onActiveChange } = setup()
    ;(input as HTMLInputElement).focus()
    type(input, "main")
    await advance(NAME_DEBOUNCE_MS)
    expect(screen.getAllByRole("option")).toHaveLength(1)

    fireEvent.keyDown(input, { key: "Escape" })
    expect((input as HTMLInputElement).value).toBe("")
    expect(onActiveChange).toHaveBeenLastCalledWith(false)
    expect(screen.queryAllByRole("option")).toHaveLength(0)
    expect(document.activeElement).toBe(input)

    fireEvent.keyDown(input, { key: "Escape" })
    expect(document.activeElement).not.toBe(input)
  })

  it("never shows another folder's listing", async () => {
    const { input, rerender, onOpenFile, onRevealDir, onActiveChange } = setup()
    type(input, "main")
    await advance(NAME_DEBOUNCE_MS)
    expect(optionTexts()).toEqual(["main.rssrc"])

    const other = deferred<WorkspaceFileEntry[]>()
    api.listWorkspaceFiles.mockReturnValueOnce(other.promise)
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <FileTreeSearch
          rootPath="/other"
          onOpenFile={onOpenFile}
          onRevealDir={onRevealDir}
          onActiveChange={onActiveChange}
        />
      </NextIntlClientProvider>
    )
    await flush()
    expect(api.listWorkspaceFiles).toHaveBeenLastCalledWith("/other")
    expect(screen.queryAllByRole("option")).toHaveLength(0)

    other.resolve([{ name: "main.go", path: "main.go", kind: "file" }])
    await flush()
    expect(optionTexts()).toEqual(["main.go"])
  })
})

describe("FileTreeSearch: content search", () => {
  function enterContentMode() {
    fireEvent.click(screen.getByRole("button", { name: "Search inside files" }))
  }

  it("debounces typing into one backend search and groups hits by file", async () => {
    api.searchWorkspaceContent.mockResolvedValue(
      contentResult([
        {
          path: "src/main.rs",
          lines: [
            [2, "let needle = 1;"],
            [9, "needle()"],
          ],
        },
        { path: "README.md", lines: [[1, "needle in docs"]] },
      ])
    )
    const { input, onOpenFile } = setup()
    enterContentMode()
    type(input, "n")
    type(input, "ne")
    type(input, "needle")
    await advance(CONTENT_DEBOUNCE_MS - 1)
    expect(api.searchWorkspaceContent).not.toHaveBeenCalled()
    await advance(1)

    expect(api.searchWorkspaceContent).toHaveBeenCalledTimes(1)
    const params = api.searchWorkspaceContent.mock.calls[0][0]
    expect(params).toMatchObject({
      rootPath: ROOT,
      query: "needle",
      caseSensitive: false,
      regex: false,
      maxResults: CONTENT_RESULT_LIMIT,
    })
    expect(params.searchKey).toEqual(expect.any(String))

    expect(optionTexts()).toEqual([
      "main.rssrc2",
      "2let needle = 1;",
      "9needle()",
      "README.md1",
      "1needle in docs",
    ])
    expect(screen.getByText("3 results in 2 files")).toBeTruthy()

    // A line opens at that line; a file header at its first hit.
    fireEvent.click(screen.getAllByRole("option")[2])
    expect(onOpenFile).toHaveBeenLastCalledWith("src/main.rs", 9)
    fireEvent.click(screen.getAllByRole("option")[3])
    expect(onOpenFile).toHaveBeenLastCalledWith("README.md", 1)
  })

  it("discards a stale response that lands after a newer one", async () => {
    const first = deferred<WorkspaceContentSearchResult>()
    const second = deferred<WorkspaceContentSearchResult>()
    api.searchWorkspaceContent
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const { input } = setup()
    enterContentMode()

    type(input, "old")
    await advance(CONTENT_DEBOUNCE_MS)
    type(input, "new")
    await advance(CONTENT_DEBOUNCE_MS)
    expect(api.searchWorkspaceContent).toHaveBeenCalledTimes(2)

    // Both searches share the key, so the backend stops the first one.
    const [a, b] = api.searchWorkspaceContent.mock.calls.map((c) => c[0])
    expect(a.searchKey).toBe(b.searchKey)

    second.resolve(contentResult([{ path: "new.txt", lines: [[1, "new"]] }]))
    await flush()
    first.resolve(contentResult([{ path: "old.txt", lines: [[1, "old"]] }]))
    await flush()
    expect(optionTexts()).toEqual(["new.txt1", "1new"])
  })

  it("cancels the running search when the box is cleared", async () => {
    const pending = deferred<WorkspaceContentSearchResult>()
    api.searchWorkspaceContent.mockReturnValueOnce(pending.promise)
    const { input } = setup()
    enterContentMode()
    type(input, "needle")
    await advance(CONTENT_DEBOUNCE_MS)
    const { searchKey } = api.searchWorkspaceContent.mock.calls[0][0]

    fireEvent.keyDown(input, { key: "Escape" })
    expect(api.cancelWorkspaceSearch).toHaveBeenCalledWith(searchKey)

    // The cancelled search's late answer never shows, and the next search
    // uses a fresh key a late cancel cannot reach.
    pending.resolve(contentResult([{ path: "late.txt", lines: [[1, "x"]] }]))
    await flush()
    expect(screen.queryAllByRole("option")).toHaveLength(0)
    api.searchWorkspaceContent.mockResolvedValueOnce(contentResult([]))
    type(input, "again")
    await advance(CONTENT_DEBOUNCE_MS)
    expect(api.searchWorkspaceContent.mock.calls[1][0].searchKey).not.toBe(
      searchKey
    )
  })

  it("passes the case and regex toggles and says when results were capped", async () => {
    api.searchWorkspaceContent.mockResolvedValue(
      contentResult([{ path: "a.txt", lines: [[1, "Foo"]] }], {
        truncated: true,
      })
    )
    const { input } = setup()
    enterContentMode()
    fireEvent.click(screen.getByRole("button", { name: "Match case" }))
    fireEvent.click(
      screen.getByRole("button", { name: "Use regular expression" })
    )
    type(input, "Fo+")
    await advance(CONTENT_DEBOUNCE_MS)
    expect(api.searchWorkspaceContent.mock.calls[0][0]).toMatchObject({
      caseSensitive: true,
      regex: true,
    })
    expect(screen.getByText("Showing the first 1 results")).toBeTruthy()
  })

  it("shows a backend error in the user's language", async () => {
    api.searchWorkspaceContent.mockRejectedValue({
      code: "invalid_input",
      message: "backend wording",
      detail: "regex parse error",
      i18n_key: "search.errors.invalidPattern",
    })
    const { input } = setup()
    enterContentMode()
    type(input, "(")
    await advance(CONTENT_DEBOUNCE_MS)
    expect(screen.getByText("Invalid regular expression")).toBeTruthy()
  })
})

describe("Cmd/Ctrl+F", () => {
  const key = (init: Partial<KeyboardEventInit>) => ({
    key: "f",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...init,
  })

  it("is Cmd+F on macOS and Ctrl+F elsewhere", () => {
    platform.current = "macos"
    expect(isFindShortcut(key({ metaKey: true }))).toBe(true)
    expect(isFindShortcut(key({ ctrlKey: true }))).toBe(false)
    expect(isFindShortcut(key({ metaKey: true, shiftKey: true }))).toBe(false)
    platform.current = "windows"
    expect(isFindShortcut(key({ ctrlKey: true }))).toBe(true)
    expect(isFindShortcut(key({ key: "F", ctrlKey: true }))).toBe(true)
    expect(isFindShortcut(key({ metaKey: true }))).toBe(false)
    expect(isFindShortcut(key({ key: "g", ctrlKey: true }))).toBe(false)
  })

  it("focus() puts the caret in the box and selects its text", async () => {
    const { input, ref } = setup()
    type(input, "main")
    await flush()
    act(() => ref.current?.focus())
    expect(document.activeElement).toBe(input)
    const el = input as HTMLInputElement
    expect([el.selectionStart, el.selectionEnd]).toEqual([0, 4])
  })
})
