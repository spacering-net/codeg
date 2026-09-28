import { act, fireEvent, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { BrowserWorkspaceTab } from "@/contexts/workspace-context"
import type { BrowserTabState, FrozenFrame } from "@/lib/browser/types"

const api = vi.hoisted(() => ({
  browserOpenTab: vi.fn(),
  browserClose: vi.fn(() => Promise.resolve()),
  browserSetBounds: vi.fn(() => Promise.resolve()),
  browserSetVisible: vi.fn<
    (
      id: string,
      visible: boolean,
      handoff: boolean,
      freeze?: boolean
    ) => Promise<FrozenFrame | null>
  >(() => Promise.resolve(null)),
  browserFreezeFrame: vi.fn<(id: string) => Promise<FrozenFrame | null>>(() =>
    Promise.resolve(null)
  ),
}))
vi.mock("@/lib/browser/browser-api", () => api)
// `releaseBrowserTab` only talks to the backend on the desktop.
vi.mock("@/lib/transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/transport")>()),
  isDesktop: () => true,
}))
vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceView: () => ({
    mode: "conversation",
    activePane: "files",
    filesMaximized: false,
  }),
}))
const routeMock = vi.hoisted(() => ({
  current: null as null | { isConversations: boolean },
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useOptionalWorkbenchRoute: () => routeMock.current,
}))
vi.mock("@/components/ui/overlay-host-hidden", () => ({
  useOverlayHostHidden: () => false,
}))

import {
  BrowserSurfaceHost,
  NativeSurfaceBesideRoute,
  NativeSurfaceHost,
} from "./browser-surface-host"
import {
  getBrowserCreateOutcome,
  getBrowserTabState,
  hasSurfaceClaim,
  requestBrowserBoundsResync,
  resetBrowserTabStoreForTests,
  setBrowserTabState,
} from "@/lib/browser/browser-tab-store"
import {
  acquireNativeSurfaceOcclusion,
  resetNativeSurfaceOcclusionForTests,
  subscribeNativeSurfaceReclaim,
} from "@/lib/browser/native-surface-occlusion"

function tab(id = "abc"): BrowserWorkspaceTab {
  return {
    id: `browser:${id}`,
    kind: "browser",
    folderId: 1,
    title: "example.com",
    description: null,
    path: null,
    language: "browser",
    content: "",
    loading: true,
    readonly: true,
    browser: {
      initialUrl: "https://example.com/",
      openerTabId: null,
      profile: "default",
    },
  }
}

function state(id = "abc"): BrowserTabState {
  return {
    tabId: id,
    ownerWindow: "main",
    kind: "page",
    surface: "child",
    channel: "degraded",
    channelError: null,
    url: "",
    requestedUrl: "https://example.com/",
    title: "",
    favicon: null,
    loading: true,
    canGoBack: false,
    canGoForward: false,
    origin: null,
    zoom: 1,
    error: null,
    remoteHost: null,
    openerTabId: null,
    profile: "default",
    agentGrant: null,
  }
}

/** The same tab with a page committed in it — something to leave a still of. */
function showing(id = "abc"): BrowserTabState {
  return {
    ...state(id),
    url: "https://example.com/",
    title: "Example",
    origin: "https://example.com",
    loading: false,
  }
}

/** A tab the user opened empty: the blank page and nothing else. */
function emptyTab(id = "abc"): BrowserWorkspaceTab {
  const record = tab(id)
  return {
    ...record,
    browser: { ...record.browser, initialUrl: "about:blank" },
  }
}

/** Its state once the blank page has committed in it. */
function emptyState(id = "abc"): BrowserTabState {
  return {
    ...state(id),
    requestedUrl: "about:blank",
    url: "about:blank",
    loading: false,
  }
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/** Long enough for the two animation frames a freeze-then-hide waits on
 *  before it lets the native view go — and, on a loaded machine where those
 *  frames do not arrive, for the 100ms bound that backs them up. */
async function flushPaint() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150))
  })
}

describe("BrowserSurfaceHost", () => {
  beforeEach(() => {
    api.browserOpenTab.mockReset()
    api.browserSetBounds.mockClear()
    api.browserSetVisible.mockClear()
    api.browserFreezeFrame.mockReset()
    api.browserFreezeFrame.mockImplementation(() => Promise.resolve(null))
    resetBrowserTabStoreForTests()
    resetNativeSurfaceOcclusionForTests()
    // jsdom has no layout: give the host a rect.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 100,
      y: 50,
      left: 100,
      top: 50,
      width: 800,
      height: 600,
      right: 900,
      bottom: 650,
      toJSON: () => ({}),
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    routeMock.current = null
  })

  it("creates the surface once at its rect, hides it under an overlay lease, and hides on unmount", async () => {
    api.browserOpenTab.mockImplementation(() => Promise.resolve(state("host1")))
    const { unmount } = render(<BrowserSurfaceHost tab={tab("host1")} />)
    await flush()
    expect(api.browserOpenTab).toHaveBeenCalledTimes(1)
    expect(api.browserOpenTab.mock.calls[0][0]).toMatchObject({
      tabId: "host1",
      url: "https://example.com/",
      bounds: { x: 100, y: 50, width: 800, height: 600 },
    })

    let release: () => void = () => {}
    await act(async () => {
      release = acquireNativeSurfaceOcclusion("dialog")
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    // Hidden with focus handoff, after its own frame was asked for: the
    // placeholder stays on screen under the overlay.
    expect(api.browserFreezeFrame).toHaveBeenCalledWith("host1")
    expect(api.browserSetVisible).toHaveBeenLastCalledWith(
      "host1",
      false,
      true,
      false
    )

    await act(async () => {
      release()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(api.browserSetVisible).toHaveBeenLastCalledWith("host1", true, false)

    unmount()
    expect(api.browserSetVisible).toHaveBeenLastCalledWith(
      "host1",
      false,
      false
    )
  })

  // A remote tab: opened through its connection, saying so while that takes
  // a moment, and leaving a refusal where any host of the tab can see it.
  it("opens a remote tab through its connection and records a refusal for every host", async () => {
    let refuse: (error: unknown) => void = () => {}
    api.browserOpenTab.mockImplementation(
      () =>
        new Promise((_, reject) => {
          refuse = reject
        })
    )
    const { container, getByText } = render(
      <BrowserSurfaceHost
        tab={tab("remote1")}
        egress={4}
        showCreateError={false}
        pendingLabel="Connecting through box…"
      />
    )
    await flush()
    expect(api.browserOpenTab.mock.calls[0][0]).toMatchObject({
      tabId: "remote1",
      egress: 4,
    })
    expect(getByText("Connecting through box…")).toBeInTheDocument()
    expect(getBrowserCreateOutcome("browser:remote1")).toEqual({
      kind: "pending",
    })
    const error = new Error("the tunnel is down")
    await act(async () => {
      refuse(error)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(getBrowserCreateOutcome("browser:remote1")).toEqual({
      kind: "failed",
      error,
    })
    // The caller shows it; this host says nothing of its own.
    expect(container).not.toHaveTextContent("Connecting through box…")
    expect(container).not.toHaveTextContent("the tunnel is down")
    // The claim is let go, so the tab can ask again.
    expect(hasSurfaceClaim("remote1")).toBe(false)
  })

  // The host that asked went away before the answer, and the one showing the
  // tab now never asked: the refusal is still that one's to show.
  it("shows a refusal on a host that did not ask for the surface", async () => {
    let refuse: (error: unknown) => void = () => {}
    api.browserOpenTab.mockImplementation(
      () =>
        new Promise((_, reject) => {
          refuse = reject
        })
    )
    const first = render(<BrowserSurfaceHost tab={tab("again1")} />)
    await flush()
    first.unmount()
    const second = render(<BrowserSurfaceHost tab={tab("again1")} />)
    await flush()
    // The second host could not claim what the first one holds.
    expect(api.browserOpenTab).toHaveBeenCalledTimes(1)
    await act(async () => {
      refuse(new Error("refused for a reason"))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(second.container).toHaveTextContent("refused for a reason")
    second.unmount()
  })

  // The host that asked went away before the answer, and nothing else shows
  // the tab: the hide it sent on its way out found no tab yet, so the new
  // surface is hidden when it arrives rather than left painted on screen.
  it("hides a surface that arrives after every host of its tab is gone", async () => {
    let answer: (state: BrowserTabState) => void = () => {}
    api.browserOpenTab.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve
        })
    )
    const { unmount } = render(<BrowserSurfaceHost tab={tab("late1")} />)
    await flush()
    unmount()
    api.browserSetVisible.mockClear()
    await act(async () => {
      answer(state("late1"))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(api.browserSetVisible).toHaveBeenCalledWith("late1", false, false)
    expect(getBrowserCreateOutcome("browser:late1")).toBeNull()
  })

  // The drawer and a pane both showed the tab, and the one that asked went
  // away: the other is still on screen, so nothing hides the page it shows.
  it("leaves a late surface up while another host still shows its tab", async () => {
    let answer: (state: BrowserTabState) => void = () => {}
    api.browserOpenTab.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve
        })
    )
    const { rerender } = render(
      <>
        <BrowserSurfaceHost key="asker" tab={tab("dual1")} />
        <BrowserSurfaceHost key="other" tab={tab("dual1")} />
      </>
    )
    await flush()
    expect(api.browserOpenTab).toHaveBeenCalledTimes(1)
    api.browserSetVisible.mockClear()
    rerender(
      <>
        <BrowserSurfaceHost key="other" tab={tab("dual1")} />
      </>
    )
    await flush()
    await act(async () => {
      answer(state("dual1"))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await flush()
    expect(api.browserSetVisible).not.toHaveBeenCalledWith(
      "dual1",
      false,
      expect.anything()
    )
    expect(api.browserSetVisible).toHaveBeenCalledWith("dual1", true, false)
  })

  // A full-page route hides the file column, and with it the hosts inside
  // it; the transcript's side panel over that route is not hidden by it.
  it("shows a host beside the route while a full-page route is up, and only that one", async () => {
    routeMock.current = { isConversations: false }
    api.browserOpenTab.mockImplementation(() =>
      Promise.resolve(state("route1"))
    )
    const inColumn = render(<BrowserSurfaceHost tab={tab("route1")} />)
    await flush()
    expect(api.browserSetVisible).not.toHaveBeenCalledWith(
      "route1",
      true,
      false
    )
    inColumn.unmount()

    api.browserOpenTab.mockImplementation(() =>
      Promise.resolve(state("route2"))
    )
    render(
      <NativeSurfaceBesideRoute.Provider value={true}>
        <BrowserSurfaceHost tab={tab("route2")} />
      </NativeSurfaceBesideRoute.Provider>
    )
    await flush()
    expect(api.browserSetVisible).toHaveBeenCalledWith("route2", true, false)
    expect(api.browserSetVisible).not.toHaveBeenCalledWith(
      "route2",
      false,
      expect.anything(),
      expect.anything()
    )
  })

  // The file column holds the tab too, mounted but hidden under the route:
  // it must not hide the page the side panel shows — and when the panel
  // goes, the page goes off screen with it.
  it("lets the host that shows a tab decide over a hidden one of the same tab", async () => {
    routeMock.current = { isConversations: false }
    api.browserOpenTab.mockImplementation(() => Promise.resolve(state("pair1")))
    const { rerender } = render(
      <>
        <NativeSurfaceBesideRoute.Provider value={true}>
          <BrowserSurfaceHost key="panel" tab={tab("pair1")} />
        </NativeSurfaceBesideRoute.Provider>
        <BrowserSurfaceHost key="column" tab={tab("pair1")} />
      </>
    )
    await flush()
    await flush()
    const hides = () =>
      api.browserSetVisible.mock.calls.filter(
        ([id, visible]) => id === "pair1" && visible === false
      ).length
    expect(hides()).toBe(0)
    expect(api.browserSetVisible).toHaveBeenCalledWith("pair1", true, false)

    rerender(
      <>
        <BrowserSurfaceHost key="column" tab={tab("pair1")} />
      </>
    )
    await flush()
    expect(hides()).toBeGreaterThan(0)
  })

  it("tears a destroy-on-unmount surface down instead of hiding it", async () => {
    const create = vi.fn(() =>
      Promise.resolve({ ...state("doc-1"), kind: "document" as const })
    )
    const { unmount } = render(
      <NativeSurfaceHost
        backendId="doc-1"
        storeKey="browser:doc-1"
        create={create}
        destroyOnUnmount
      />
    )
    await flush()
    expect(create).toHaveBeenCalledTimes(1)
    expect(getBrowserTabState("browser:doc-1")?.kind).toBe("document")

    unmount()
    await flush()
    expect(api.browserClose).toHaveBeenCalledWith("doc-1", undefined)
    expect(getBrowserTabState("browser:doc-1")).toBeNull()
    expect(api.browserSetVisible).not.toHaveBeenCalledWith(
      "doc-1",
      false,
      false
    )
  })

  it("drives an owned window from tab visibility, not from its invisible placeholder", async () => {
    // The tab view hides the placeholder (`invisible`) when the page lives in
    // its own window; the window must still be shown, and never sized.
    Object.defineProperty(HTMLElement.prototype, "checkVisibility", {
      configurable: true,
      value: () => false,
    })
    try {
      api.browserOpenTab.mockImplementation(() =>
        Promise.resolve({ ...state("host-window"), surface: "window" })
      )
      const { unmount } = render(
        <BrowserSurfaceHost tab={tab("host-window")} />
      )
      await flush()
      expect(api.browserSetBounds).not.toHaveBeenCalled()
      expect(api.browserSetVisible).toHaveBeenLastCalledWith(
        "host-window",
        true,
        false
      )
      unmount()
      expect(api.browserSetVisible).toHaveBeenLastCalledWith(
        "host-window",
        false,
        false
      )
    } finally {
      delete (HTMLElement.prototype as { checkVisibility?: unknown })
        .checkVisibility
    }
  })

  it("does not create a second surface for a tab that already has one", async () => {
    api.browserOpenTab.mockImplementation(() => Promise.resolve(state("host2")))
    const first = render(<BrowserSurfaceHost tab={tab("host2")} />)
    await flush()
    first.unmount()
    render(<BrowserSurfaceHost tab={tab("host2")} />)
    await flush()
    expect(api.browserOpenTab).toHaveBeenCalledTimes(1)
    // Re-mount re-applies bounds and shows the existing surface.
    expect(api.browserSetBounds).toHaveBeenCalledWith("host2", {
      x: 100,
      y: 50,
      width: 800,
      height: 600,
    })
    expect(api.browserSetVisible).toHaveBeenLastCalledWith("host2", true, false)
  })

  // The answer to `browser_open_tab` is decided before the page starts
  // loading, and on WKWebView it is not ordered against the event evals that
  // carry `browser://state` — so the state of a page that has already
  // committed can arrive first. Written over it, the tab would be loading
  // with nothing left to correct it: an empty tab's `about:blank` commits at
  // once and emits nothing afterwards, so it spun for the rest of the
  // session.
  it("does not put the create's answer over a state that arrived first", async () => {
    let answer: (state: BrowserTabState) => void = () => {}
    api.browserOpenTab.mockImplementation(
      () => new Promise<BrowserTabState>((resolve) => (answer = resolve))
    )
    render(<BrowserSurfaceHost tab={emptyTab("host10")} />)
    await flush()
    // The blank page committed and the event beat the answer home.
    act(() => setBrowserTabState(emptyState("host10")))
    expect(getBrowserTabState("browser:host10")?.loading).toBe(false)

    act(() => answer(state("host10")))
    await flush()
    expect(getBrowserTabState("browser:host10")?.loading).toBe(false)
    expect(getBrowserTabState("browser:host10")?.url).toBe("about:blank")
  })

  // And with nothing else to go on it IS the state: a tab whose events are
  // all still to come has only this one.
  it("seeds the store from the create's answer when nothing arrived first", async () => {
    api.browserOpenTab.mockImplementation(() =>
      Promise.resolve(state("host11"))
    )
    render(<BrowserSurfaceHost tab={tab("host11")} />)
    await flush()
    // The whole answer, not a field or two of it: seeding has to put the
    // state the command decided into the store, and a partial assertion
    // would pass just as happily on a truncated one.
    expect(getBrowserTabState("browser:host11")).toEqual(state("host11"))
  })

  // Bounds are pushed only when they change, which is right while this host
  // is the only thing that moves a surface. macOS's docked web inspector is
  // not: it resizes the page to fill the window and leaves it there, and the
  // placeholder never moved — so the page would stay full-window until some
  // unrelated layout change. A resync request is what says "push them again
  // even though they look the same".
  it("pushes unchanged bounds again when a resync is asked for", async () => {
    api.browserOpenTab.mockImplementation(() => Promise.resolve(state("host9")))
    render(<BrowserSurfaceHost tab={tab("host9")} />)
    await flush()
    const pushed = api.browserSetBounds.mock.calls.length
    expect(pushed).toBeGreaterThan(0)

    // Nothing moved, so nothing is pushed again on its own.
    await flush()
    expect(api.browserSetBounds.mock.calls.length).toBe(pushed)

    act(() => requestBrowserBoundsResync("host9"))
    await flush()
    expect(api.browserSetBounds.mock.calls.length).toBe(pushed + 1)
    expect(api.browserSetBounds).toHaveBeenLastCalledWith("host9", {
      x: 100,
      y: 50,
      width: 800,
      height: 600,
    })
  })

  // The whole point of the order: the still goes up while the native view is
  // still covering it, and only then does the view go. Hide first and the
  // placeholder is blank for the length of a round trip — the flash.
  it("paints the freeze frame before the native view goes", async () => {
    api.browserOpenTab.mockImplementation(() => Promise.resolve(state("host8")))
    api.browserFreezeFrame.mockImplementation(() =>
      Promise.resolve({
        mime: "image/jpeg",
        data: "QUJD",
        width: 1600,
        height: 1200,
      })
    )
    const { container } = render(<BrowserSurfaceHost tab={tab("host8")} />)
    await flush()
    api.browserSetVisible.mockClear()

    await act(async () => {
      acquireNativeSurfaceOcclusion("dialog")
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(api.browserFreezeFrame).toHaveBeenCalledWith("host8")
    expect(
      container
        .querySelector("img[data-browser-frozen-frame]")
        ?.getAttribute("src")
    ).toBe("data:image/jpeg;base64,QUJD")
    // Painted, and the page is still up behind it.
    expect(api.browserSetVisible).not.toHaveBeenCalled()

    await flushPaint()
    // Now it goes — and asks for no frame of its own, having one already.
    expect(api.browserSetVisible).toHaveBeenLastCalledWith(
      "host8",
      false,
      true,
      false
    )
  })

  // Waiting for a frame before hiding puts a window between the decision to
  // hide and the hide. An overlay that closes inside it has already shown the
  // surface, and the hide must be abandoned — landing late would take the
  // page away with nothing left on top of it.
  // Both answers are abandoned, and by different guards: with a frame the
  // paint has to be skipped as well as the hide, with none the hide would
  // otherwise fall straight through to the fallback.
  it.each([
    ["host9a", { mime: "image/jpeg", data: "QUJD", width: 10, height: 10 }],
    ["host9b", null],
  ] as const)(
    "abandons a hide whose overlay closed while the frame was in flight (%s)",
    async (id, late: FrozenFrame | null) => {
      api.browserOpenTab.mockImplementation(() => Promise.resolve(state(id)))
      let handOverFrame: () => void = () => {}
      api.browserFreezeFrame.mockImplementation(
        () =>
          new Promise<FrozenFrame | null>((resolve) => {
            handOverFrame = () => resolve(late)
          })
      )
      const { container } = render(<BrowserSurfaceHost tab={tab(id)} />)
      await flush()
      api.browserSetVisible.mockClear()

      let release: () => void = () => {}
      await act(async () => {
        release = acquireNativeSurfaceOcclusion("dialog")
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      await act(async () => {
        release()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      expect(api.browserSetVisible).toHaveBeenLastCalledWith(id, true, false)

      await act(async () => {
        handOverFrame()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      await flushPaint()
      expect(api.browserSetVisible).toHaveBeenLastCalledWith(id, true, false)
      // And no stale still left painted over a page that is showing.
      expect(
        container.querySelector("img[data-browser-frozen-frame]")
      ).toBeNull()
    }
  )

  // The still stays up for the whole life of the overlay, and goes only once
  // the native view is actually back.
  it("paints the freeze frame while hidden under an overlay and drops it once shown", async () => {
    api.browserOpenTab.mockImplementation(() => Promise.resolve(state("host4")))
    api.browserFreezeFrame.mockImplementation(() =>
      Promise.resolve({
        mime: "image/jpeg",
        data: "QUJD",
        width: 1600,
        height: 1200,
      })
    )
    let resolveShow: () => void = () => {}
    api.browserSetVisible.mockImplementation(
      (_id: string, visible: boolean) => {
        if (visible) {
          return new Promise<null>((resolve) => {
            resolveShow = () => resolve(null)
          })
        }
        return Promise.resolve(null)
      }
    )
    const { container } = render(<BrowserSurfaceHost tab={tab("host4")} />)
    await flush()

    let release: () => void = () => {}
    await act(async () => {
      release = acquireNativeSurfaceOcclusion("dialog")
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(api.browserFreezeFrame).toHaveBeenCalledWith("host4")
    const frame = container.querySelector("img[data-browser-frozen-frame]")
    expect(frame).not.toBeNull()
    expect(frame?.getAttribute("src")).toBe("data:image/jpeg;base64,QUJD")
    await flushPaint()

    await act(async () => {
      release()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(api.browserSetVisible).toHaveBeenLastCalledWith("host4", true, false)
    // Still painted until the native view is back: no blank frame between.
    expect(
      container.querySelector("img[data-browser-frozen-frame]")
    ).not.toBeNull()
    await act(async () => {
      resolveShow()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(container.querySelector("img[data-browser-frozen-frame]")).toBeNull()
  })

  // Close and reopen an overlay at once: the show issued for the close is
  // still in flight when the reopen's hide paints a new frame. The show's
  // answer must not wipe that frame — the native view is hidden again.
  it("keeps a newer hide's frame when a superseded show answers late", async () => {
    api.browserOpenTab.mockImplementation(() => Promise.resolve(state("host6")))
    let resolveShow: () => void = () => {}
    let frames = 0
    api.browserFreezeFrame.mockImplementation(() => {
      frames += 1
      return Promise.resolve({
        mime: "image/jpeg",
        data: `F${frames}`,
        width: 10,
        height: 10,
      })
    })
    api.browserSetVisible.mockImplementation(
      (_id: string, visible: boolean) => {
        if (visible) {
          return new Promise<null>((resolve) => {
            resolveShow = () => resolve(null)
          })
        }
        return Promise.resolve(null)
      }
    )
    const { container } = render(<BrowserSurfaceHost tab={tab("host6")} />)
    await flush()
    const frameSrc = () =>
      container
        .querySelector("img[data-browser-frozen-frame]")
        ?.getAttribute("src") ?? null

    let release: () => void = () => {}
    await act(async () => {
      release = acquireNativeSurfaceOcclusion("dialog")
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(frameSrc()).toBe("data:image/jpeg;base64,F1")

    // Close (show in flight, unresolved) and reopen right away.
    await act(async () => {
      release()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const staleShow = resolveShow
    await act(async () => {
      release = acquireNativeSurfaceOcclusion("dialog")
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(frameSrc()).toBe("data:image/jpeg;base64,F2")

    // The superseded show answers now: the newer frame stays.
    await act(async () => {
      staleShow()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(frameSrc()).toBe("data:image/jpeg;base64,F2")

    // The real close clears it.
    await act(async () => {
      release()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await act(async () => {
      resolveShow()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(frameSrc()).toBeNull()
  })

  it("drops the frame when the error page takes the surface's place", async () => {
    api.browserOpenTab.mockImplementation(() => Promise.resolve(state("host7")))
    api.browserFreezeFrame.mockImplementation(() =>
      Promise.resolve({
        mime: "image/jpeg",
        data: "QUJD",
        width: 10,
        height: 10,
      })
    )
    const { container, rerender } = render(
      <BrowserSurfaceHost tab={tab("host7")} />
    )
    await flush()
    await act(async () => {
      acquireNativeSurfaceOcclusion("dialog")
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(
      container.querySelector("img[data-browser-frozen-frame]")
    ).not.toBeNull()
    rerender(<BrowserSurfaceHost tab={tab("host7")} hidden />)
    expect(container.querySelector("img[data-browser-frozen-frame]")).toBeNull()
  })

  it("does not ask for a frame when the error page hides the surface", async () => {
    api.browserOpenTab.mockImplementation(() => Promise.resolve(state("host5")))
    render(<BrowserSurfaceHost tab={tab("host5")} hidden />)
    await flush()
    expect(api.browserSetVisible).toHaveBeenLastCalledWith(
      "host5",
      false,
      true,
      false
    )
  })

  it("stays hidden while the view is force-hidden (error page)", async () => {
    api.browserOpenTab.mockImplementation(() => Promise.resolve(state("host3")))
    render(<BrowserSurfaceHost tab={tab("host3")} hidden />)
    await flush()
    expect(api.browserSetVisible).toHaveBeenLastCalledWith(
      "host3",
      false,
      true,
      false
    )
  })

  // ---- a notice nobody opened (a toast) ----
  //
  // It has to take the page the same way — a native view is above every DOM
  // element there is — but it is not an overlay the user is looking at, so it
  // may not take the keyboard with it and may not be the last word.

  it("hides the page for a notice without taking the keyboard, and gives it back on a press", async () => {
    api.browserOpenTab.mockImplementation(() =>
      Promise.resolve({ ...showing("host-notice") })
    )
    api.browserFreezeFrame.mockImplementation(() =>
      Promise.resolve({
        mime: "image/jpeg",
        data: "QUJD",
        width: 10,
        height: 10,
      })
    )
    const { container } = render(
      <BrowserSurfaceHost tab={tab("host-notice")} />
    )
    await flush()
    api.browserSetVisible.mockClear()

    let release: () => void = () => {}
    await act(async () => {
      release = acquireNativeSurfaceOcclusion("toast", { passive: true })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await flushPaint()
    // The still goes up as it does for any overlay; the focus handoff does
    // not — the page keeps the caret the user left in it.
    expect(
      container.querySelector("img[data-browser-frozen-frame]")
    ).not.toBeNull()
    expect(api.browserSetVisible).toHaveBeenLastCalledWith(
      "host-notice",
      false,
      false,
      false
    )

    // Reaching for the page asks whoever holds the notice to take it away.
    const reclaimed = vi.fn()
    const stop = subscribeNativeSurfaceReclaim(reclaimed)
    const placeholder = container.querySelector(
      "[data-browser-surface]"
    ) as HTMLElement
    fireEvent.pointerDown(placeholder)
    expect(reclaimed).toHaveBeenCalledTimes(1)
    fireEvent.wheel(placeholder)
    expect(reclaimed).toHaveBeenCalledTimes(2)
    stop()

    await act(async () => {
      release()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(api.browserSetVisible).toHaveBeenLastCalledWith(
      "host-notice",
      true,
      false
    )
    // And with the page back, a press on the placeholder is just a press on
    // the placeholder again.
    const quiet = vi.fn()
    const stopQuiet = subscribeNativeSurfaceReclaim(quiet)
    fireEvent.pointerDown(placeholder)
    expect(quiet).not.toHaveBeenCalled()
    stopQuiet()
  })

  // A surface that has never committed a document has no frame to leave
  // behind, so hiding it for a notice would put an empty pane under the
  // toast — which is what the still exists to prevent. Reachable: a toast is
  // up and the user switches to a browser tab, whose surface is created
  // right then.
  it("leaves a pane with no page in it alone when a notice asks", async () => {
    api.browserOpenTab.mockImplementation(() =>
      Promise.resolve(state("host-blank"))
    )
    render(<BrowserSurfaceHost tab={tab("host-blank")} />)
    await flush()
    api.browserSetVisible.mockClear()
    api.browserFreezeFrame.mockClear()

    await act(async () => {
      acquireNativeSurfaceOcclusion("toast", { passive: true })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await flushPaint()
    expect(api.browserFreezeFrame).not.toHaveBeenCalled()
    expect(api.browserSetVisible).not.toHaveBeenCalled()
  })

  // A page in its own window is not over this window's toast, so taking the
  // whole window off the screen for one would be a bigger interruption than
  // the notice is. An overlay still hides it, as it always did.
  it("leaves an owned window up for a notice and hides it for an overlay", async () => {
    api.browserOpenTab.mockImplementation(() =>
      Promise.resolve({ ...showing("host-owned"), surface: "window" as const })
    )
    render(<BrowserSurfaceHost tab={tab("host-owned")} />)
    await flush()
    api.browserSetVisible.mockClear()

    let release: () => void = () => {}
    await act(async () => {
      release = acquireNativeSurfaceOcclusion("toast", { passive: true })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await flushPaint()
    expect(api.browserSetVisible).not.toHaveBeenCalled()

    await act(async () => {
      acquireNativeSurfaceOcclusion("dialog")
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(api.browserSetVisible).toHaveBeenLastCalledWith(
      "host-owned",
      false,
      true
    )
    release()
  })

  // The blank page an empty tab sits on is a committed document like any
  // other — the backend paints it in the app's colours (`browser::blank_page`)
  // — so a notice hides it behind its own still, exactly as it does a page.
  // Before this, the blank page was excluded from that and the empty tab was
  // the one surface in the app that covered a toast.
  it("hides a tab sitting on the blank page for a notice", async () => {
    api.browserFreezeFrame.mockImplementation(() =>
      Promise.resolve({ mime: "image/jpeg", data: "AAA", width: 8, height: 8 })
    )
    api.browserOpenTab.mockImplementation(() =>
      Promise.resolve(emptyState("host-empty"))
    )
    const { container } = render(
      <BrowserSurfaceHost tab={emptyTab("host-empty")} />
    )
    await flush()
    api.browserSetVisible.mockClear()

    await act(async () => {
      acquireNativeSurfaceOcclusion("toast", { passive: true })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await flushPaint()
    expect(api.browserFreezeFrame).toHaveBeenCalledWith("host-empty")
    expect(
      container.querySelector("img[data-browser-frozen-frame]")
    ).not.toBeNull()
    // No focus handoff: the notice is not something the user opened.
    expect(api.browserSetVisible).toHaveBeenLastCalledWith(
      "host-empty",
      false,
      false,
      false
    )
  })

  // One real overlay in the set and the hide is an overlay's again, notice or
  // no notice: the user is looking at the dialog and Esc has to reach it.
  it("treats a notice with an overlay open over it as an overlay", async () => {
    api.browserOpenTab.mockImplementation(() =>
      Promise.resolve({ ...showing("host-both") })
    )
    render(<BrowserSurfaceHost tab={tab("host-both")} />)
    await flush()
    api.browserSetVisible.mockClear()

    await act(async () => {
      acquireNativeSurfaceOcclusion("toast", { passive: true })
      acquireNativeSurfaceOcclusion("dialog")
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await flushPaint()
    expect(api.browserSetVisible).toHaveBeenLastCalledWith(
      "host-both",
      false,
      true,
      false
    )
  })
})
