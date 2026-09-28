import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { StashWorkspace } from "./unstash-dialog"
import type { ImageDiffSides } from "@/lib/image-diff"

const api = vi.hoisted(() => ({
  gitStashList: vi.fn(),
  gitStashShow: vi.fn(),
  gitStashApply: vi.fn(),
  gitStashDrop: vi.fn(),
  gitShowFile: vi.fn(),
}))
vi.mock("@/lib/api", () => api)

const imageDiff = vi.hoisted(() => ({ loadImageDiffSides: vi.fn() }))
vi.mock("@/lib/image-diff", () => imageDiff)

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}))

// Monaco does not run in jsdom, and this test is about which side wins, not
// about text rendering.
vi.mock("@/components/diff/diff-viewer", () => ({
  DiffViewer: () => <div data-testid="text-diff" />,
}))

function sides(tag: string): ImageDiffSides {
  return {
    original: {
      kind: "image",
      src: `data:image/png;base64,${tag}-before`,
      byteSize: 10,
    },
    modified: {
      kind: "image",
      src: `data:image/png;base64,${tag}-after`,
      byteSize: 20,
    },
  }
}

/** A promise plus the handle to settle it, so the test picks the order. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function renderWorkspace() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <StashWorkspace folderPath="/repo" />
    </NextIntlClientProvider>
  )
}

/** File rows are tree items, not buttons. */
function fileRow(path: string): HTMLElement {
  const row = document.querySelector(`[data-tree-row-path="${path}"]`)
  if (!row) throw new Error(`no file row for ${path}`)
  return row as HTMLElement
}

function imageSources(): string[] {
  return screen.getAllByRole("img").map((img) => img.getAttribute("src") ?? "")
}

describe("StashWorkspace — image diff selection", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.gitStashList.mockResolvedValue([
      {
        ref_name: "stash@{0}",
        message: "wip",
        branch: "main",
        date: "today",
      },
    ])
    api.gitStashShow.mockResolvedValue([
      { status: "M", file: "first.png" },
      { status: "M", file: "second.png" },
    ])
  })

  it("keeps the newest selection when an older load settles last", async () => {
    // Two image loads in flight. The first one finishes last — a slow blob, a
    // retried request — and must not overwrite what the user is looking at.
    const first = deferred<ImageDiffSides>()
    const second = deferred<ImageDiffSides>()
    imageDiff.loadImageDiffSides
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    renderWorkspace()

    await act(async () => {})
    fireEvent.click(screen.getByRole("button", { name: /wip/ }))
    await act(async () => {})

    fireEvent.click(fileRow("first.png"))
    fireEvent.click(fileRow("second.png"))

    await act(async () => {
      second.resolve(sides("second"))
    })
    expect(imageSources()).toEqual([
      "data:image/png;base64,second-before",
      "data:image/png;base64,second-after",
    ])

    await act(async () => {
      first.resolve(sides("first"))
    })

    // The late arrival is dropped outright: not painted under the second
    // file's label, and not allowed to blank the pane either.
    expect(imageSources()).toEqual([
      "data:image/png;base64,second-before",
      "data:image/png;base64,second-after",
    ])
    expect(screen.queryByTestId("text-diff")).not.toBeInTheDocument()
  })

  it("routes a text file to the text viewer, not the image one", async () => {
    api.gitStashShow.mockResolvedValue([{ status: "M", file: "notes.txt" }])
    api.gitShowFile.mockResolvedValue("hello")

    renderWorkspace()
    await act(async () => {})
    fireEvent.click(screen.getByRole("button", { name: /wip/ }))
    await act(async () => {})

    fireEvent.click(fileRow("notes.txt"))
    await act(async () => {})

    expect(screen.getByTestId("text-diff")).toBeInTheDocument()
    expect(imageDiff.loadImageDiffSides).not.toHaveBeenCalled()
  })
})
