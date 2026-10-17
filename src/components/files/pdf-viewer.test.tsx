import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest"

import type { FileWorkspaceTab } from "@/contexts/workspace-context"

vi.mock("next-intl", () => {
  // Stable across renders, like the real hook.
  const t = (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key
  return { useTranslations: () => t }
})

const openUrlTarget = vi.hoisted(() => vi.fn())
vi.mock("@/hooks/use-open-url-target", () => ({
  isPrimaryModifier: (event: { metaKey?: boolean; ctrlKey?: boolean }) =>
    Boolean(event.metaKey || event.ctrlKey),
  useOpenUrlTarget: () => openUrlTarget,
}))

// PDF.js stands in as a set of recording fakes; `loadPdfjs` hands them out.
// The decode and parameter helpers in `@/lib/pdfjs` stay real.
const pdfjs = vi.hoisted(() => {
  type Listener = (event: unknown) => void

  class FakeEventBus {
    listeners = new Map<string, Listener[]>()
    dispatched: Array<{ name: string; data: Record<string, unknown> }> = []
    on(name: string, listener: Listener) {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener])
    }
    dispatch(name: string, data: Record<string, unknown>) {
      this.dispatched.push({ name, data })
      for (const listener of this.listeners.get(name) ?? []) listener(data)
    }
  }

  class FakeLinkService {
    setViewer = vi.fn()
    setDocument = vi.fn()
    setHash = vi.fn()
    constructor(public options: { eventBus: FakeEventBus }) {
      state.linkServices.push(this)
    }
  }

  class FakeFindController {
    constructor(public options: unknown) {}
  }

  class FakeViewer {
    scaleValues: string[] = []
    #scaleValue = ""
    pdfDocument: unknown = null
    currentPageNumber = 1
    increaseScale = vi.fn()
    decreaseScale = vi.fn()
    update = vi.fn()
    updateScale = vi.fn()
    setDocument = vi.fn((doc: unknown) => {
      this.pdfDocument = doc
    })
    constructor(
      public options: {
        container: HTMLDivElement
        eventBus: FakeEventBus
        abortSignal?: AbortSignal
      }
    ) {
      state.viewers.push(this)
    }
    get currentScaleValue() {
      return this.#scaleValue
    }
    set currentScaleValue(value: string) {
      this.#scaleValue = value
      this.scaleValues.push(value)
    }
  }

  interface FakeTask {
    params: { data: Uint8Array; cMapUrl: string }
    promise: Promise<unknown>
    resolve: (doc: unknown) => void
    reject: (error: unknown) => void
    onPassword: ((update: (pw: string) => void, reason: number) => void) | null
    destroy: Mock
  }

  const state = {
    viewers: [] as FakeViewer[],
    linkServices: [] as FakeLinkService[],
    tasks: [] as FakeTask[],
  }

  const lib = {
    PasswordResponses: { NEED_PASSWORD: 1, INCORRECT_PASSWORD: 2 },
    getDocument: vi.fn((params: FakeTask["params"]) => {
      let resolve!: FakeTask["resolve"]
      let reject!: FakeTask["reject"]
      const promise = new Promise<unknown>((res, rej) => {
        resolve = res
        reject = rej
      })
      const task: FakeTask = {
        params,
        promise,
        resolve,
        reject,
        onPassword: null,
        destroy: vi.fn(() => Promise.resolve()),
      }
      state.tasks.push(task)
      return task
    }),
  }

  const components = {
    EventBus: FakeEventBus,
    PDFLinkService: FakeLinkService,
    PDFFindController: FakeFindController,
    PDFViewer: FakeViewer,
    FindState: { FOUND: 0, NOT_FOUND: 1, WRAPPED: 2, PENDING: 3 },
  }

  return {
    state,
    lib,
    components,
    reset() {
      state.viewers.length = 0
      state.linkServices.length = 0
      state.tasks.length = 0
      lib.getDocument.mockClear()
    },
  }
})

const loadPdfjs = vi.hoisted(() => vi.fn())
vi.mock("@/lib/pdfjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pdfjs")>()),
  loadPdfjs,
}))

import { PdfViewer } from "./pdf-viewer"

// "%PDF-1." and "%PDF-2." as base64.
const DOC_A = "data:application/pdf;base64,JVBERi0xLg=="
const DOC_B = "data:application/pdf;base64,JVBERi0yLg=="

// The viewer remembers where each tab was read, by tab id, for the whole
// session: every test gets a tab of its own.
let tabSerial = 0

function pdfTab(content: string, loading = false): FileWorkspaceTab {
  return {
    id: `file:%2Frepo%2Freport-${tabSerial}.pdf`,
    kind: "file",
    folderId: null,
    title: "report.pdf",
    description: "/repo/report.pdf",
    path: "/repo/report.pdf",
    language: "pdf",
    content,
    loading,
    readonly: true,
  }
}

const last = <T,>(items: T[]): T => items[items.length - 1]
const lastViewer = () => last(pdfjs.state.viewers)
const lastTask = () => last(pdfjs.state.tasks)
const lastLinkService = () => last(pdfjs.state.linkServices)
const bus = () => lastViewer().options.eventBus

/** Render a PDF tab and resolve its document (12 pages). */
async function renderReady(content = DOC_A) {
  const view = render(<PdfViewer tab={pdfTab(content)} />)
  await waitFor(() => expect(pdfjs.state.tasks).toHaveLength(1))
  const doc = { numPages: 12 }
  await act(async () => {
    lastTask().resolve(doc)
  })
  return { ...view, doc }
}

beforeEach(() => {
  tabSerial += 1
  pdfjs.reset()
  openUrlTarget.mockReset()
  loadPdfjs.mockReset()
  loadPdfjs.mockResolvedValue({ lib: pdfjs.lib, components: pdfjs.components })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("PdfViewer", () => {
  it("shows the loader's message for a tab whose load failed, without starting PDF.js", () => {
    render(<PdfViewer tab={pdfTab("unableLoadContent: too large")} />)

    expect(screen.getByText("unableLoadContent: too large")).toBeVisible()
    expect(loadPdfjs).not.toHaveBeenCalled()
  })

  it("shows loading while the tab has no bytes yet", () => {
    render(<PdfViewer tab={pdfTab("", true)} />)

    expect(screen.getByText("loading")).toBeVisible()
    expect(loadPdfjs).not.toHaveBeenCalled()
  })

  it("opens the decoded bytes with the bundled asset URLs and fits the page", async () => {
    const { doc } = await renderReady()

    const params = lastTask().params as unknown as Record<string, unknown>
    expect(Array.from(params.data as Uint8Array)).toEqual(
      Array.from(new TextEncoder().encode("%PDF-1."))
    )
    expect(params).toMatchObject({
      cMapUrl: "http://localhost:3000/pdfjs/cmaps/",
      standardFontDataUrl: "http://localhost:3000/pdfjs/standard_fonts/",
      wasmUrl: "http://localhost:3000/pdfjs/wasm/",
      iccUrl: "http://localhost:3000/pdfjs/iccs/",
    })
    expect(lastViewer().options.container).toBe(
      screen.getByRole("region", { name: "pdfDocument" })
    )
    expect(lastViewer().setDocument).toHaveBeenCalledWith(doc)
    expect(lastLinkService().setDocument).toHaveBeenCalledWith(doc, null)
    // setHash and in-document links act through the viewer the link service
    // was given: it must be this one.
    expect(lastLinkService().setViewer).toHaveBeenCalledWith(lastViewer())
    expect(screen.getByText("/ 12")).toBeVisible()
    expect(screen.queryByText("loading")).toBeNull()

    act(() => bus().dispatch("pagesinit", {}))
    expect(lastViewer().scaleValues).toEqual(["auto"])
    // A tab never read before has no place to go back to.
    expect(lastLinkService().setHash).not.toHaveBeenCalled()
  })

  it("drives zoom from the toolbar and reflects the viewer's scale", async () => {
    await renderReady()

    fireEvent.click(screen.getByRole("button", { name: "pdfZoomIn" }))
    expect(lastViewer().increaseScale).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole("button", { name: "pdfZoomOut" }))
    expect(lastViewer().decreaseScale).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole("button", { name: "pdfFitWidth" }))
    fireEvent.click(screen.getByRole("button", { name: "pdfZoomReset" }))
    expect(lastViewer().scaleValues).toEqual(["page-width", "auto"])

    act(() =>
      bus().dispatch("scalechanging", { scale: 1.5, presetValue: "page-width" })
    )
    expect(
      screen.getByRole("button", { name: "pdfZoomReset" })
    ).toHaveTextContent("150%")
    expect(screen.getByRole("button", { name: "pdfFitWidth" })).toHaveAttribute(
      "aria-pressed",
      "true"
    )
  })

  it("zooms the document on ⌘/Ctrl + wheel: continuously for a pinch, by steps for a wheel", async () => {
    await renderReady()
    const container = screen.getByRole("region", { name: "pdfDocument" })

    const pinch = fireEvent.wheel(container, {
      ctrlKey: true,
      deltaY: -2,
      clientX: 10,
      clientY: 20,
    })
    expect(pinch).toBe(false)
    expect(lastViewer().updateScale).toHaveBeenLastCalledWith({
      drawingDelay: 400,
      scaleFactor: Math.exp(0.02),
      origin: [10, 20],
    })

    fireEvent.wheel(container, { metaKey: true, deltaY: 100 })
    expect(lastViewer().updateScale).toHaveBeenLastCalledWith({
      steps: -1,
      origin: [0, 0],
    })

    // A plain wheel scrolls.
    expect(fireEvent.wheel(container, { deltaY: 100 })).toBe(true)
    expect(lastViewer().updateScale).toHaveBeenCalledTimes(2)
  })

  it("jumps to a typed page and follows the viewer's page changes", async () => {
    await renderReady()
    const input = screen.getByRole("textbox", { name: "pdfPageNumber" })

    fireEvent.change(input, { target: { value: "7" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(lastViewer().currentPageNumber).toBe(7)

    // Out of range: nothing moves, the field shows the current page again.
    fireEvent.change(input, { target: { value: "40" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(lastViewer().currentPageNumber).toBe(7)

    act(() => bus().dispatch("pagechanging", { pageNumber: 4 }))
    expect(input).toHaveValue("4")
  })

  it("searches through PDF.js's find controller", async () => {
    await renderReady()
    const input = screen.getByRole("searchbox", { name: "pdfFind" })
    const finds = () =>
      bus().dispatched.filter((event) => event.name.startsWith("find"))

    fireEvent.change(input, { target: { value: "alpha" } })
    fireEvent.keyDown(input, { key: "Enter" })
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true })
    expect(finds().map((event) => event.data)).toEqual([
      expect.objectContaining({
        type: "",
        query: "alpha",
        findPrevious: false,
      }),
      expect.objectContaining({
        type: "again",
        query: "alpha",
        findPrevious: false,
      }),
      expect.objectContaining({
        type: "again",
        query: "alpha",
        findPrevious: true,
      }),
    ])

    act(() =>
      bus().dispatch("updatefindmatchescount", {
        matchesCount: { current: 2, total: 5 },
      })
    )
    expect(screen.getByText("2/5")).toBeVisible()

    act(() =>
      bus().dispatch("updatefindcontrolstate", {
        state: 1,
        matchesCount: { current: 0, total: 0 },
      })
    )
    expect(screen.getByText("pdfFindNoMatches")).toBeVisible()

    fireEvent.change(input, { target: { value: "" } })
    expect(last(finds()).name).toBe("findbarclose")
    expect(screen.queryByText("pdfFindNoMatches")).toBeNull()
  })

  it("leaves an Enter that confirms an IME candidate to the IME", async () => {
    await renderReady()
    const find = screen.getByRole("searchbox", { name: "pdfFind" })
    fireEvent.change(find, { target: { value: "你好" } })
    const dispatched = bus().dispatched.length

    // WebKit's candidate-confirming Enter: compositionend already fired, the
    // legacy 229 keyCode is the only trace left.
    fireEvent.keyDown(find, { key: "Enter", keyCode: 229 })
    expect(bus().dispatched).toHaveLength(dispatched)

    const page = screen.getByRole("textbox", { name: "pdfPageNumber" })
    fireEvent.change(page, { target: { value: "7" } })
    fireEvent.keyDown(page, { key: "Enter", keyCode: 229 })
    expect(lastViewer().currentPageNumber).toBe(1)
  })

  it("moves focus to the find box on ⌘/Ctrl+F inside the document", async () => {
    await renderReady()
    const container = screen.getByRole("region", { name: "pdfDocument" })

    fireEvent.keyDown(container, { key: "f", metaKey: true })

    expect(screen.getByRole("searchbox", { name: "pdfFind" })).toHaveFocus()
  })

  it("routes external links through the app's link decision and leaves in-document links to PDF.js", async () => {
    await renderReady()
    const pages = screen
      .getByRole("region", { name: "pdfDocument" })
      .querySelector(".pdfViewer")!
    const external = document.createElement("a")
    external.href = "https://example.com/spec"
    external.textContent = "spec"
    const internal = document.createElement("a")
    internal.setAttribute("href", "#page=2")
    internal.textContent = "see page 2"
    pages.append(external, internal)

    expect(fireEvent.click(external)).toBe(false)
    expect(openUrlTarget).toHaveBeenCalledWith("https://example.com/spec", {
      source: "editor",
      modifier: false,
    })

    expect(fireEvent.click(external, { metaKey: true })).toBe(false)
    expect(openUrlTarget).toHaveBeenLastCalledWith("https://example.com/spec", {
      source: "editor",
      modifier: true,
    })

    expect(fireEvent.click(internal)).toBe(true)
    expect(openUrlTarget).toHaveBeenCalledTimes(2)
  })

  it("asks for the password of a protected PDF and passes it to PDF.js", async () => {
    render(<PdfViewer tab={pdfTab(DOC_A)} />)
    await waitFor(() => expect(pdfjs.state.tasks).toHaveLength(1))
    const firstTry = vi.fn()

    act(() => lastTask().onPassword!(firstTry, 1))
    expect(screen.getByText("pdfPasswordPrompt")).toBeVisible()
    const field = screen.getByLabelText("pdfPassword")
    fireEvent.change(field, { target: { value: "hunter2" } })
    fireEvent.click(screen.getByRole("button", { name: "pdfPasswordSubmit" }))
    expect(firstTry).toHaveBeenCalledWith("hunter2")
    expect(screen.getByText("loading")).toBeVisible()

    act(() => lastTask().onPassword!(vi.fn(), 2))
    expect(screen.getByText("pdfPasswordIncorrect")).toBeVisible()
  })

  it("says so when the bytes are not a PDF", async () => {
    render(<PdfViewer tab={pdfTab(DOC_A)} />)
    await waitFor(() => expect(pdfjs.state.tasks).toHaveLength(1))

    await act(async () => {
      lastTask().reject(
        Object.assign(new Error("Invalid PDF structure."), {
          name: "InvalidPDFException",
        })
      )
    })

    expect(screen.getByText("pdfInvalid")).toBeVisible()
  })

  it("reports any other failure with its message", async () => {
    loadPdfjs.mockRejectedValueOnce(new Error("chunk failed"))
    render(<PdfViewer tab={pdfTab(DOC_A)} />)

    expect(
      await screen.findByText('pdfLoadFailed:{"message":"chunk failed"}')
    ).toBeVisible()
  })

  it("reopens changed bytes where the reader was, tearing the old document down", async () => {
    const { rerender } = await renderReady(DOC_A)
    const firstViewer = lastViewer()
    const firstTask = lastTask()
    act(() =>
      bus().dispatch("updateviewarea", {
        location: { pdfOpenParams: "#page=3&zoom=auto,-8,640" },
      })
    )

    rerender(<PdfViewer tab={pdfTab(DOC_B)} />)
    expect(firstTask.destroy).toHaveBeenCalled()
    expect(firstViewer.setDocument).toHaveBeenLastCalledWith(null)
    expect(firstViewer.options.abortSignal?.aborted).toBe(true)

    await waitFor(() => expect(pdfjs.state.tasks).toHaveLength(2))
    await act(async () => {
      lastTask().resolve({ numPages: 3 })
    })
    act(() => bus().dispatch("pagesinit", {}))

    expect(lastViewer()).not.toBe(firstViewer)
    expect(lastViewer().scaleValues).toEqual(["auto"])
    expect(lastLinkService().setViewer).toHaveBeenCalledWith(lastViewer())
    expect(lastLinkService().setHash).toHaveBeenCalledWith(
      "page=3&zoom=auto,-8,640"
    )
  })

  it("resumes where the tab was last read when its viewer comes back", async () => {
    const { unmount } = await renderReady()
    act(() =>
      bus().dispatch("updateviewarea", {
        location: { pdfOpenParams: "#page=5&zoom=125,0,300" },
      })
    )
    // Switching to another tab unmounts the viewer.
    unmount()

    render(<PdfViewer tab={pdfTab(DOC_A)} />)
    await waitFor(() => expect(pdfjs.state.tasks).toHaveLength(2))
    await act(async () => {
      lastTask().resolve({ numPages: 12 })
    })
    act(() => bus().dispatch("pagesinit", {}))

    expect(lastLinkService().setViewer).toHaveBeenCalledWith(lastViewer())
    expect(lastLinkService().setHash).toHaveBeenCalledWith(
      "page=5&zoom=125,0,300"
    )
  })

  it.each([
    ["a password prompt", () => act(() => lastTask().onPassword!(vi.fn(), 1))],
    [
      "an error",
      () =>
        act(async () => {
          lastTask().reject(
            Object.assign(new Error("Invalid PDF structure."), {
              name: "InvalidPDFException",
            })
          )
        }),
    ],
  ])("clears the previous document's figures behind %s", async (_, outcome) => {
    const { rerender } = await renderReady(DOC_A)
    const zoom = screen.getByRole("button", { name: "pdfZoomReset" })
    const page = screen.getByRole("textbox", { name: "pdfPageNumber" })
    act(() => bus().dispatch("scalechanging", { scale: 1.5 }))
    act(() => bus().dispatch("pagechanging", { pageNumber: 4 }))
    fireEvent.change(screen.getByRole("searchbox", { name: "pdfFind" }), {
      target: { value: "alpha" },
    })
    act(() =>
      bus().dispatch("updatefindmatchescount", {
        matchesCount: { current: 2, total: 5 },
      })
    )

    // The file changes on disk: while the new bytes load, the figures hold
    // (the reload reopens at the same place).
    rerender(<PdfViewer tab={pdfTab(DOC_B)} />)
    expect(zoom).toHaveTextContent("150%")
    expect(page).toHaveValue("4")
    expect(screen.getByText("2/5")).toBeVisible()

    // ...but the new file cannot be shown: nothing on screen they describe.
    await waitFor(() => expect(pdfjs.state.tasks).toHaveLength(2))
    await outcome()
    expect(zoom).toHaveTextContent("-")
    expect(page).toHaveValue("")
    expect(screen.queryByText("2/5")).toBeNull()
  })

  it("re-fits a fitted scale when the container resizes", async () => {
    const callbacks: Array<() => void> = []
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          callbacks.push(callback)
        }
        observe() {}
        disconnect() {}
      }
    )
    await renderReady()
    act(() => bus().dispatch("pagesinit", {}))
    const container = screen.getByRole("region", { name: "pdfDocument" })
    Object.defineProperty(container, "clientWidth", { value: 600 })
    Object.defineProperty(container, "clientHeight", { value: 400 })

    act(() => callbacks.forEach((callback) => callback()))

    expect(lastViewer().scaleValues).toEqual(["auto", "auto"])
    expect(lastViewer().update).toHaveBeenCalled()
  })

  it("destroys the document when the tab goes away", async () => {
    const { unmount } = await renderReady()
    const viewer = lastViewer()
    const task = lastTask()

    unmount()

    expect(task.destroy).toHaveBeenCalled()
    expect(viewer.setDocument).toHaveBeenLastCalledWith(null)
    expect(viewer.options.abortSignal?.aborted).toBe(true)
  })
})
