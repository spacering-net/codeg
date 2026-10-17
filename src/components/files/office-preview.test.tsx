import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next-intl", () => ({ useTranslations: () => (k: string) => k }))
vi.mock("@/lib/api", () => ({
  startOfficeWatch: vi.fn(),
  stopOfficeWatch: vi.fn(),
  renewOfficeWatch: vi.fn(),
  openSettingsWindow: vi.fn(),
}))
vi.mock("@/lib/transport", () => ({
  isDesktop: vi.fn(),
  isRemoteDesktopMode: vi.fn(),
  getServerBaseUrl: vi.fn(),
}))

import {
  openSettingsWindow,
  renewOfficeWatch,
  startOfficeWatch,
  stopOfficeWatch,
} from "@/lib/api"
import {
  isDesktop,
  isRemoteDesktopMode,
  getServerBaseUrl,
} from "@/lib/transport"
import { OfficePreview, WATCH_RENEW_INTERVAL_MS } from "./office-preview"

const mockStart = vi.mocked(startOfficeWatch)
const mockStop = vi.mocked(stopOfficeWatch)
const mockRenew = vi.mocked(renewOfficeWatch)
const mockOpenSettings = vi.mocked(openSettingsWindow)
const mockIsDesktop = vi.mocked(isDesktop)
const mockIsRemote = vi.mocked(isRemoteDesktopMode)
const mockBaseUrl = vi.mocked(getServerBaseUrl)

beforeEach(() => {
  vi.clearAllMocks()
  mockStop.mockResolvedValue(undefined)
  mockRenew.mockResolvedValue(true)
  mockOpenSettings.mockResolvedValue(undefined)
  mockIsRemote.mockReturnValue(false)
  mockBaseUrl.mockReturnValue("https://srv.example")
})
afterEach(() => cleanup())

describe("OfficePreview", () => {
  it("web mode: proxies through the server with the cap, opaque-origin sandbox", async () => {
    mockIsDesktop.mockReturnValue(false)
    mockStart.mockResolvedValue({ port: 26315, cap: "capval" })

    render(<OfficePreview rootPath="/root/reports" relPath="a.docx" />)

    await waitFor(() =>
      expect(mockStart).toHaveBeenCalledWith("/root/reports", "a.docx")
    )
    const iframe = await screen.findByTitle("officePreviewTitle")
    expect(iframe.getAttribute("src")).toBe(
      "https://srv.example/api/office-watch-proxy/26315/?cap=capval"
    )
    // No allow-same-origin in web mode → the page can't read app storage.
    expect(iframe.getAttribute("sandbox")).toBe(
      "allow-scripts allow-popups allow-forms"
    )
  })

  it("local desktop: loads loopback directly with same-origin sandbox", async () => {
    mockIsDesktop.mockReturnValue(true)
    mockIsRemote.mockReturnValue(false)
    mockStart.mockResolvedValue({ port: 30000, cap: "ignored" })

    render(<OfficePreview rootPath="/root/reports" relPath="a.docx" />)

    const iframe = await screen.findByTitle("officePreviewTitle")
    expect(iframe.getAttribute("src")).toBe("http://127.0.0.1:30000/")
    expect(iframe.getAttribute("sandbox")).toContain("allow-same-origin")
  })

  it("remote-desktop: shows a hint and does NOT start a watch", async () => {
    // A Tauri window bound to a remote server can't load the preview iframe
    // (mixed-content); we must not spawn a remote watch nobody can see.
    mockIsDesktop.mockReturnValue(true)
    mockIsRemote.mockReturnValue(true)

    render(<OfficePreview rootPath="/root/reports" relPath="a.docx" />)

    expect(
      await screen.findByText("officeRemoteDesktopUnsupported")
    ).toBeTruthy()
    expect(mockStart).not.toHaveBeenCalled()
  })

  it("stops the watch on unmount", async () => {
    mockIsDesktop.mockReturnValue(false)
    mockStart.mockResolvedValue({ port: 1, cap: "c", hold: "h" })

    const { unmount } = render(
      <OfficePreview rootPath="/root/reports" relPath="a.docx" />
    )
    await screen.findByTitle("officePreviewTitle")
    unmount()

    // Named by the capability and hold its start returned: a release must
    // only ever take back the reference this preview acquired.
    expect(mockStop).toHaveBeenCalledWith("/root/reports", "a.docx", "c", "h")
  })

  it("releases what it acquired when unmounted before the start resolved", async () => {
    mockIsDesktop.mockReturnValue(true)
    let resolveStart: (value: { port: number; cap: string }) => void = () => {}
    mockStart.mockReturnValue(
      new Promise((resolve) => {
        resolveStart = resolve
      })
    )

    const { unmount } = render(
      <OfficePreview rootPath="/root/reports" relPath="a.docx" />
    )
    unmount()
    expect(mockStop).not.toHaveBeenCalled()
    resolveStart({ port: 30000, cap: "late" })

    await waitFor(() =>
      expect(mockStop).toHaveBeenCalledWith(
        "/root/reports",
        "a.docx",
        "late",
        undefined
      )
    )
    expect(mockStop).toHaveBeenCalledTimes(1)
  })

  it("restarts a preview whose watch is gone when it is shown again", async () => {
    // The backend stops a watch with its tab still open when the folder it
    // sits in is closed (or its worktree removed, or it crashes). A kept
    // preview must not go on showing that dead page.
    mockIsDesktop.mockReturnValue(true)
    mockStart.mockResolvedValueOnce({ port: 30000, cap: "first" })
    mockStart.mockResolvedValueOnce({ port: 30001, cap: "second" })
    mockRenew.mockResolvedValue(false)

    const { rerender } = render(
      <OfficePreview rootPath="/root/reports" relPath="a.docx" />
    )
    await screen.findByTitle("officePreviewTitle")
    rerender(
      <OfficePreview rootPath="/root/reports" relPath="a.docx" active={false} />
    )
    rerender(<OfficePreview rootPath="/root/reports" relPath="a.docx" active />)

    await waitFor(() =>
      expect(screen.getByTitle("officePreviewTitle").getAttribute("src")).toBe(
        "http://127.0.0.1:30001/"
      )
    )
    expect(mockRenew).toHaveBeenCalledTimes(1)
    expect(mockRenew).toHaveBeenCalledWith(
      "/root/reports",
      "a.docx",
      "first",
      undefined
    )
    expect(mockStart).toHaveBeenCalledTimes(2)
    // The dead watch's release still names it, so it can't take a reference
    // from whatever watch serves the file now.
    expect(mockStop).toHaveBeenCalledWith(
      "/root/reports",
      "a.docx",
      "first",
      undefined
    )
  })

  it("keeps a preview whose watch is still live when it is shown again", async () => {
    mockIsDesktop.mockReturnValue(true)
    mockStart.mockResolvedValue({ port: 30000, cap: "only" })

    const { rerender } = render(
      <OfficePreview rootPath="/root/reports" relPath="a.docx" />
    )
    const iframe = await screen.findByTitle("officePreviewTitle")
    // Shown the first time: nothing to check yet.
    expect(mockRenew).not.toHaveBeenCalled()
    rerender(
      <OfficePreview rootPath="/root/reports" relPath="a.docx" active={false} />
    )
    rerender(<OfficePreview rootPath="/root/reports" relPath="a.docx" active />)

    await waitFor(() =>
      expect(mockRenew).toHaveBeenCalledWith(
        "/root/reports",
        "a.docx",
        "only",
        undefined
      )
    )
    expect(mockRenew).toHaveBeenCalledTimes(1)
    expect(screen.getByTitle("officePreviewTitle")).toBe(iframe)
    expect(mockStart).toHaveBeenCalledTimes(1)
    expect(mockStop).not.toHaveBeenCalled()
  })

  it("desktop NOT_INSTALLED: offers Open Settings", async () => {
    mockIsDesktop.mockReturnValue(true)
    mockIsRemote.mockReturnValue(false)
    mockStart.mockRejectedValue({
      code: "dependency_missing",
      message: "officecli is not installed",
      i18n_params: { watchCode: "NOT_INSTALLED" },
    })

    render(<OfficePreview rootPath="/root/reports" relPath="a.docx" />)

    const btn = await screen.findByText("officeOpenSettings")
    fireEvent.click(btn)
    expect(mockOpenSettings).toHaveBeenCalled()
  })

  it("web NOT_INSTALLED: shows the server-side install hint instead", async () => {
    mockIsDesktop.mockReturnValue(false)
    mockStart.mockRejectedValue({
      code: "dependency_missing",
      message: "officecli is not installed",
      i18n_params: { watchCode: "NOT_INSTALLED" },
    })

    render(<OfficePreview rootPath="/root/reports" relPath="a.docx" />)

    expect(await screen.findByText("officeServerInstallHint")).toBeTruthy()
    expect(screen.queryByText("officeOpenSettings")).toBeNull()
  })

  it("retries a failed start when shown again after being kept out of sight", async () => {
    // A kept-mounted preview no longer remounts on a tab switch. Coming back
    // to a failed one must still try again — the desktop not-installed state
    // has no retry button, so this is how installing OfficeCLI gets noticed.
    mockIsDesktop.mockReturnValue(true)
    mockStart.mockRejectedValueOnce({
      code: "dependency_missing",
      message: "officecli is not installed",
      i18n_params: { watchCode: "NOT_INSTALLED" },
    })
    mockStart.mockResolvedValueOnce({ port: 30000, cap: "" })

    const { rerender } = render(
      <OfficePreview rootPath="/root/reports" relPath="a.docx" />
    )
    await screen.findByText("officeNotInstalled")
    rerender(
      <OfficePreview rootPath="/root/reports" relPath="a.docx" active={false} />
    )
    expect(mockStart).toHaveBeenCalledTimes(1)

    rerender(<OfficePreview rootPath="/root/reports" relPath="a.docx" active />)
    const iframe = await screen.findByTitle("officePreviewTitle")
    expect(iframe.getAttribute("src")).toBe("http://127.0.0.1:30000/")
    expect(mockStart).toHaveBeenCalledTimes(2)
  })

  it("does not restart a running preview when shown again", async () => {
    mockIsDesktop.mockReturnValue(true)
    mockStart.mockResolvedValue({ port: 30000, cap: "" })

    const { rerender } = render(
      <OfficePreview rootPath="/root/reports" relPath="a.docx" />
    )
    const iframe = await screen.findByTitle("officePreviewTitle")
    rerender(
      <OfficePreview rootPath="/root/reports" relPath="a.docx" active={false} />
    )
    rerender(<OfficePreview rootPath="/root/reports" relPath="a.docx" active />)

    expect(screen.getByTitle("officePreviewTitle")).toBe(iframe)
    expect(mockStart).toHaveBeenCalledTimes(1)
    expect(mockStop).not.toHaveBeenCalled()
  })

  it("does not start over again when shown while its replacement is still starting", async () => {
    mockIsDesktop.mockReturnValue(true)
    let resolveSecond: (value: { port: number; cap: string }) => void = () => {}
    mockStart.mockResolvedValueOnce({ port: 30000, cap: "first" })
    mockStart.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSecond = resolve
      })
    )
    mockStart.mockResolvedValue({ port: 30002, cap: "third" })
    mockRenew.mockResolvedValue(false)
    const preview = (active: boolean) => (
      <OfficePreview
        rootPath="/root/reports"
        relPath="a.docx"
        active={active}
      />
    )

    const { rerender } = render(preview(true))
    await screen.findByTitle("officePreviewTitle")
    rerender(preview(false))
    rerender(preview(true))
    // The first watch is gone, so the preview starts over…
    await waitFor(() => expect(mockStart).toHaveBeenCalledTimes(2))
    // …and is hidden and shown again before the new watch is up. Nothing is
    // loaded to check, and the answer about the first watch is spent.
    rerender(preview(false))
    rerender(preview(true))
    resolveSecond({ port: 30001, cap: "second" })

    await waitFor(() =>
      expect(screen.getByTitle("officePreviewTitle").getAttribute("src")).toBe(
        "http://127.0.0.1:30001/"
      )
    )
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(mockRenew).toHaveBeenCalledTimes(1)
    expect(mockStart).toHaveBeenCalledTimes(2)
    expect(screen.getByTitle("officePreviewTitle").getAttribute("src")).toBe(
      "http://127.0.0.1:30001/"
    )
  })

  it("offers retry for a START_FAILED error and re-starts the watch", async () => {
    mockIsDesktop.mockReturnValue(false)
    mockStart.mockRejectedValueOnce({
      code: "task_execution_failed",
      message: "boom",
      i18n_params: { watchCode: "START_FAILED" },
    })
    mockStart.mockResolvedValueOnce({ port: 5, cap: "c" })

    render(<OfficePreview rootPath="/root/reports" relPath="a.docx" />)

    const retry = await screen.findByText("officeWatchRetry")
    expect(mockStart).toHaveBeenCalledTimes(1)
    fireEvent.click(retry)
    await waitFor(() => expect(mockStart).toHaveBeenCalledTimes(2))
  })

  it("web mode: tells the page whether it is in sight, and tells it again when it asks", async () => {
    // Out of sight, the page lets go of its live connection: a browser
    // allows a handful per server, and every kept preview holding one would
    // starve the shown preview. The page asks whenever it (re)loads.
    mockIsDesktop.mockReturnValue(false)
    mockStart.mockResolvedValue({ port: 26315, cap: "c" })
    const preview = (active: boolean) => (
      <OfficePreview
        rootPath="/root/reports"
        relPath="a.docx"
        active={active}
      />
    )

    const { rerender } = render(preview(true))
    const frame = (await screen.findByTitle(
      "officePreviewTitle"
    )) as HTMLIFrameElement
    const page = frame.contentWindow!
    const post = vi.spyOn(page, "postMessage")
    const ask = (source: MessageEventSource | null) =>
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { codegOfficePreview: "ready" },
          source,
        })
      )

    rerender(preview(false))
    expect(post).toHaveBeenLastCalledWith({ codegOfficePreview: "hidden" }, "*")
    post.mockClear()
    ask(page)
    expect(post).toHaveBeenCalledWith({ codegOfficePreview: "hidden" }, "*")
    rerender(preview(true))
    expect(post).toHaveBeenLastCalledWith({ codegOfficePreview: "shown" }, "*")

    // Anything but the page asking is not the page asking.
    post.mockClear()
    ask(window)
    expect(post).not.toHaveBeenCalled()
  })

  it("desktop: says nothing to the page, which keeps its own connection", async () => {
    // Each desktop preview talks to its own loopback port, so there is no
    // shared connection pool to spare and no shim to listen.
    mockIsDesktop.mockReturnValue(true)
    mockStart.mockResolvedValue({ port: 30000, cap: "c" })

    const { rerender } = render(
      <OfficePreview rootPath="/root/reports" relPath="a.docx" />
    )
    const frame = (await screen.findByTitle(
      "officePreviewTitle"
    )) as HTMLIFrameElement
    const post = vi.spyOn(frame.contentWindow!, "postMessage")
    rerender(
      <OfficePreview rootPath="/root/reports" relPath="a.docx" active={false} />
    )
    rerender(<OfficePreview rootPath="/root/reports" relPath="a.docx" active />)
    expect(post).not.toHaveBeenCalled()
  })

  describe("renewing its hold on the watch", () => {
    beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
    afterEach(() => vi.useRealTimers())

    const preview = (active: boolean) => (
      <OfficePreview
        rootPath="/root/reports"
        relPath="a.docx"
        active={active}
      />
    )
    const frameSrc = () =>
      screen.getByTitle("officePreviewTitle").getAttribute("src")
    const tick = () =>
      act(async () => {
        vi.advanceTimersByTime(WATCH_RENEW_INTERVAL_MS)
      })
    // Mount, and let the start's answer land inside act(): the renewal timer
    // is armed by an effect of the render that answer brings. Waiting for the
    // frame alone can return before React has run that effect (outside act,
    // a commit's passive effects run in a later task, which load can delay),
    // and moving the clock before the timer exists skips it.
    const mount = async (active: boolean) => {
      const view = render(preview(active))
      await act(async () => {})
      return view
    }

    it("renews on a timer, out of sight too", async () => {
      // A web page's hold lapses once the page goes quiet; a hidden preview,
      // holding no live connection, keeps it by renewing.
      mockIsDesktop.mockReturnValue(false)
      mockStart.mockResolvedValue({ port: 26315, cap: "held", hold: "page" })

      const { rerender } = await mount(true)
      await screen.findByTitle("officePreviewTitle")
      expect(mockRenew).not.toHaveBeenCalled()
      await tick()
      expect(mockRenew).toHaveBeenCalledTimes(1)
      // Naming the hold, which the server takes again if it lapsed.
      expect(mockRenew).toHaveBeenLastCalledWith(
        "/root/reports",
        "a.docx",
        "held",
        "page"
      )

      rerender(preview(false))
      await tick()
      expect(mockRenew).toHaveBeenCalledTimes(2)
      expect(mockStart).toHaveBeenCalledTimes(1)
      expect(mockStop).not.toHaveBeenCalled()
    })

    it("starts over at once when it finds its watch gone while in sight", async () => {
      // The hold dropped while the machine slept, say: the page in front is
      // dead to further edits.
      mockIsDesktop.mockReturnValue(false)
      mockStart.mockResolvedValueOnce({ port: 26315, cap: "first", hold: "h1" })
      mockStart.mockResolvedValueOnce({
        port: 26316,
        cap: "second",
        hold: "h2",
      })
      mockRenew.mockResolvedValue(false)

      await mount(true)
      await screen.findByTitle("officePreviewTitle")
      await tick()

      await waitFor(() =>
        expect(frameSrc()).toBe(
          "https://srv.example/api/office-watch-proxy/26316/?cap=second"
        )
      )
      expect(mockStart).toHaveBeenCalledTimes(2)
      expect(mockStop).toHaveBeenCalledWith(
        "/root/reports",
        "a.docx",
        "first",
        "h1"
      )
    })

    it("waits to start over until shown when it finds its watch gone out of sight", async () => {
      mockIsDesktop.mockReturnValue(false)
      mockStart.mockResolvedValueOnce({ port: 26315, cap: "first" })
      mockStart.mockResolvedValueOnce({ port: 26316, cap: "second" })
      mockRenew.mockResolvedValue(false)

      const { rerender } = await mount(true)
      await screen.findByTitle("officePreviewTitle")
      rerender(preview(false))
      await tick()
      expect(mockRenew).toHaveBeenCalledTimes(1)
      // No one is looking: nothing is started for it yet.
      expect(mockStart).toHaveBeenCalledTimes(1)
      expect(mockStop).not.toHaveBeenCalled()

      rerender(preview(true))
      await waitFor(() =>
        expect(frameSrc()).toBe(
          "https://srv.example/api/office-watch-proxy/26316/?cap=second"
        )
      )
      // It knew already, so it did not ask again before starting over.
      expect(mockRenew).toHaveBeenCalledTimes(1)
      expect(mockStart).toHaveBeenCalledTimes(2)
    })

    it("keeps its watch through a renewal that fails to arrive", async () => {
      // Unreachable is not gone: the server may only be restarting or the
      // network briefly down.
      mockIsDesktop.mockReturnValue(false)
      mockStart.mockResolvedValue({ port: 26315, cap: "held" })
      mockRenew.mockRejectedValue(new Error("offline"))

      await mount(true)
      const frame = await screen.findByTitle("officePreviewTitle")
      await tick()
      expect(mockRenew).toHaveBeenCalledTimes(1)
      expect(screen.getByTitle("officePreviewTitle")).toBe(frame)
      expect(mockStart).toHaveBeenCalledTimes(1)
    })
  })
})
