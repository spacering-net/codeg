import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { FileWorkspaceTab } from "@/contexts/workspace-context"
import { buildFileTabId } from "@/lib/file-tab-id"

const mocks = vi.hoisted(() => ({
  fileTabs: [] as FileWorkspaceTab[],
  activeFileTabId: null as string | null,
}))

vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceFileTabs: () => ({
    fileTabs: mocks.fileTabs,
    activeFileTab:
      mocks.fileTabs.find((tab) => tab.id === mocks.activeFileTabId) ?? null,
  }),
}))
vi.mock("next-intl", () => ({ useTranslations: () => (k: string) => k }))
vi.mock("@/lib/api", () => ({
  startOfficeWatch: vi.fn(),
  stopOfficeWatch: vi.fn(),
  renewOfficeWatch: vi.fn(),
  openSettingsWindow: vi.fn(),
}))
vi.mock("@/lib/transport", () => ({
  isDesktop: () => true,
  isRemoteDesktopMode: () => false,
  getServerBaseUrl: () => "",
}))

import { renewOfficeWatch, startOfficeWatch, stopOfficeWatch } from "@/lib/api"
import {
  KeptOfficePreviews,
  isOfficeFileTab,
  nextKeptOfficePreviews,
} from "./kept-office-previews"

const mockStart = vi.mocked(startOfficeWatch)
const mockStop = vi.mocked(stopOfficeWatch)
const mockRenew = vi.mocked(renewOfficeWatch)

/** Each document's watch capability, as its start hands it out. */
const capOf = (file: string) => `cap-${file}`

/** A port per document, so each preview's iframe says whose it is. */
const PORTS: Record<string, number> = {
  "a.docx": 30001,
  "b.xlsx": 30002,
  "c.pptx": 30003,
  "d.docx": 30004,
  "e.xlsx": 30005,
  "f.pptx": 30006,
}

function fileTab(
  path: string,
  language: string,
  kind: "file" | "rich-diff" = "file"
): FileWorkspaceTab {
  return {
    id: buildFileTabId({ kind: "file", path }),
    kind,
    folderId: null,
    title: path.split("/").pop() ?? path,
    description: path,
    path,
    language,
    content: "",
    loading: false,
  }
}

const docA = fileTab("/repo/docs/a.docx", "office")
const docB = fileTab("/repo/docs/b.xlsx", "office")
const docC = fileTab("/repo/docs/c.pptx", "office")
const code = fileTab("/repo/src/main.ts", "typescript")

function show(tabs: FileWorkspaceTab[], active: FileWorkspaceTab | null) {
  mocks.fileTabs = tabs
  mocks.activeFileTabId = active?.id ?? null
}

/** The iframe of the preview loading `file` (by the port its watch got). */
function frameOf(file: string): HTMLIFrameElement | null {
  const src = `http://127.0.0.1:${PORTS[file]}/`
  return (
    (screen
      .queryAllByTitle("officePreviewTitle")
      .find((frame) => frame.getAttribute("src") === src) as
      | HTMLIFrameElement
      | undefined) ?? null
  )
}

/** The kept-preview box wrapping `frame`: hidden ones are inert. (Starts above
 *  the iframe, which carries `absolute inset-0` itself.) */
function boxOf(frame: HTMLElement): HTMLElement {
  return frame.parentElement!.closest(".absolute.inset-0") as HTMLElement
}

beforeEach(() => {
  vi.clearAllMocks()
  mockStart.mockImplementation(async (_root, path) => ({
    port: PORTS[path],
    cap: capOf(path),
  }))
  mockStop.mockResolvedValue(undefined)
  // Like the backend: live only under the capability its start handed out.
  mockRenew.mockImplementation(async (_root, path, cap) => cap === capOf(path))
  show([], null)
})
afterEach(() => cleanup())

describe("isOfficeFileTab", () => {
  it("matches file tabs of the three office formats only", () => {
    expect(isOfficeFileTab(docA)).toBe(true)
    expect(isOfficeFileTab(docB)).toBe(true)
    expect(isOfficeFileTab(docC)).toBe(true)
    expect(isOfficeFileTab(code)).toBe(false)
    // A diff of a document is a diff, not a preview of it.
    expect(
      isOfficeFileTab(fileTab("/repo/docs/a.docx", "office", "rich-diff"))
    ).toBe(false)
  })
})

describe("nextKeptOfficePreviews", () => {
  const open = (...ids: string[]) => new Set(ids)

  it("keeps the shown tab and returns the same state while nothing changes", () => {
    const first = nextKeptOfficePreviews([], "a", open("a", "b"))
    expect(first).toEqual(["a"])
    expect(nextKeptOfficePreviews(first, "a", open("a", "b"))).toBe(first)
    // Moving to a tab that isn't an office tab keeps what is kept.
    expect(nextKeptOfficePreviews(first, null, open("a", "b"))).toBe(first)
  })

  it("keeps every tab that has been shown, however many", () => {
    const ids = ["a", "b", "c", "d", "e", "f", "g"]
    let kept: readonly string[] = []
    for (const id of ids) kept = nextKeptOfficePreviews(kept, id, open(...ids))
    expect(kept).toEqual(ids)
  })

  it("never reorders what stays mounted, so no kept iframe is re-inserted", () => {
    let kept: readonly string[] = []
    for (const id of ["a", "b", "c", "a", "c", "b"]) {
      kept = nextKeptOfficePreviews(kept, id, open("a", "b", "c"))
    }
    expect(kept).toEqual(["a", "b", "c"])
  })

  it("drops closed tabs", () => {
    let kept = nextKeptOfficePreviews([], "a", open("a", "b"))
    kept = nextKeptOfficePreviews(kept, "b", open("a", "b"))
    kept = nextKeptOfficePreviews(kept, "b", open("b"))
    expect(kept).toEqual(["b"])
  })
})

describe("KeptOfficePreviews", () => {
  it("keeps a document mounted behind another tab, so coming back neither restarts the watch nor reloads the page", async () => {
    show([docA, code], docA)
    const { rerender } = render(<KeptOfficePreviews />)
    await waitFor(() => expect(frameOf("a.docx")).not.toBeNull())
    const frame = frameOf("a.docx")!
    expect(mockStart).toHaveBeenCalledTimes(1)
    expect(mockStart).toHaveBeenCalledWith("/repo/docs", "a.docx")
    expect(boxOf(frame)).not.toHaveAttribute("inert")

    show([docA, code], code)
    rerender(<KeptOfficePreviews />)
    // Still the same page, only out of sight and out of reach.
    expect(frameOf("a.docx")).toBe(frame)
    expect(boxOf(frame)).toHaveClass("invisible")
    expect(boxOf(frame)).toHaveAttribute("inert")
    expect(boxOf(frame)).toHaveAttribute("aria-hidden", "true")
    expect(mockStop).not.toHaveBeenCalled()

    show([docA, code], docA)
    rerender(<KeptOfficePreviews />)
    expect(frameOf("a.docx")).toBe(frame)
    expect(boxOf(frame)).not.toHaveClass("invisible")
    expect(boxOf(frame)).not.toHaveAttribute("inert")
    // Shown again, it asks once whether its own watch is still live.
    await waitFor(() =>
      expect(mockRenew).toHaveBeenCalledWith(
        "/repo/docs",
        "a.docx",
        "cap-a.docx",
        undefined
      )
    )
    expect(mockRenew).toHaveBeenCalledTimes(1)
    expect(frameOf("a.docx")).toBe(frame)
    expect(mockStart).toHaveBeenCalledTimes(1)
    expect(mockStop).not.toHaveBeenCalled()
  })

  it("starts nothing for an office tab that has never been shown", () => {
    // Opened in the background: no one has looked at it yet.
    show([docA, code], code)
    render(<KeptOfficePreviews />)
    expect(screen.queryAllByTitle("officePreviewTitle")).toHaveLength(0)
    expect(mockStart).not.toHaveBeenCalled()
  })

  it("releases the watch when the tab closes", async () => {
    show([docA, code], docA)
    const { rerender } = render(<KeptOfficePreviews />)
    await waitFor(() => expect(frameOf("a.docx")).not.toBeNull())

    show([code], code)
    rerender(<KeptOfficePreviews />)
    expect(frameOf("a.docx")).toBeNull()
    expect(mockStop).toHaveBeenCalledTimes(1)
    expect(mockStop).toHaveBeenCalledWith(
      "/repo/docs",
      "a.docx",
      "cap-a.docx",
      undefined
    )
  })

  it("keeps every document it has shown mounted, however many", async () => {
    const docs = ["a.docx", "b.xlsx", "c.pptx", "d.docx", "e.xlsx", "f.pptx"]
    const tabs = docs.map((file) => fileTab(`/repo/docs/${file}`, "office"))
    show(tabs, tabs[0])
    const { rerender } = render(<KeptOfficePreviews />)
    for (const tab of tabs) {
      show(tabs, tab)
      rerender(<KeptOfficePreviews />)
      await waitFor(() => expect(frameOf(tab.title)).not.toBeNull())
    }

    const frames = docs.map((file) => frameOf(file))
    expect(frames.every((frame) => frame !== null)).toBe(true)
    // Back to the first: the very same page, nothing restarted or released.
    show(tabs, tabs[0])
    rerender(<KeptOfficePreviews />)
    expect(docs.map((file) => frameOf(file))).toEqual(frames)
    expect(boxOf(frames[0]!)).not.toHaveAttribute("inert")
    expect(mockStart).toHaveBeenCalledTimes(docs.length)
    expect(mockStop).not.toHaveBeenCalled()
  })

  it("does not re-insert a kept iframe when the tab strip is reordered", async () => {
    show([docA, docB], docA)
    const { container, rerender } = render(<KeptOfficePreviews />)
    await waitFor(() => expect(frameOf("a.docx")).not.toBeNull())
    show([docA, docB], docB)
    rerender(<KeptOfficePreviews />)
    await waitFor(() => expect(frameOf("b.xlsx")).not.toBeNull())

    // A moved iframe is removed and inserted again, which reloads it. (The
    // callback collects: records it is handed are gone from takeRecords.)
    const moves: MutationRecord[] = []
    const observer = new MutationObserver((records) => moves.push(...records))
    observer.observe(container, { childList: true, subtree: true })
    show([docB, docA], docB)
    rerender(<KeptOfficePreviews />)
    show([docB, docA], docA)
    rerender(<KeptOfficePreviews />)
    await act(async () => {})
    moves.push(...observer.takeRecords())
    observer.disconnect()
    expect(moves).toEqual([])
    expect(frameOf("a.docx")).not.toBeNull()
    expect(frameOf("b.xlsx")).not.toBeNull()
  })
})
