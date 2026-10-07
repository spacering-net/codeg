import { act, render } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { BrowserWorkspaceTab } from "@/contexts/workspace-context"
import enMessages from "@/i18n/messages/en.json"
import type { BrowserTabState, FrozenFrame } from "@/lib/browser/types"

const mocks = vi.hoisted(() => ({
  openBrowserTab: vi.fn((): string | null => "browser:new"),
  fileTabs: [] as unknown[],
  /** Every tab the drawer showed, first paint included. */
  shown: [] as string[],
  /** Put the real surface host where the tab view goes, for the cases about
   *  whether the page shows at all. */
  surface: false,
  route: null as null | {
    isConversations: boolean
    openConversations: () => void
  },
}))
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
  browserFreezeFrame: vi.fn(() => Promise.resolve(null)),
}))

vi.mock("@/lib/browser/browser-api", () => api)
vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceActions: () => ({
    openBrowserTab: mocks.openBrowserTab,
    switchFileTab: vi.fn(),
  }),
  useWorkspaceFileTabs: () => ({ fileTabs: mocks.fileTabs }),
  useWorkspaceView: () => ({
    mode: "conversation",
    activePane: "files",
    filesMaximized: false,
  }),
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useOptionalWorkbenchRoute: () => mocks.route,
}))
vi.mock("./browser-tab-view", async () => {
  const { BrowserSurfaceHost } = await import("./browser-surface-host")
  return {
    BrowserTabView: ({ tab }: { tab: BrowserWorkspaceTab }) => {
      mocks.shown.push(tab.id)
      return mocks.surface ? <BrowserSurfaceHost tab={tab} /> : null
    },
  }
})

function browserRecord(id: string, remote: boolean) {
  return {
    id,
    kind: "browser",
    folderId: 1,
    title: "localhost:3000",
    description: null,
    path: null,
    language: "browser",
    content: "",
    loading: false,
    readonly: true,
    browser: {
      initialUrl: "http://localhost:3000/",
      openerTabId: null,
      profile: "default",
      ...(remote ? { remote: true } : {}),
    },
  }
}

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer"
import { resetBrowserTabStoreForTests } from "@/lib/browser/browser-tab-store"
import { resetNativeSurfaceOcclusionForTests } from "@/lib/browser/native-surface-occlusion"

import { BrowserViewerDrawer } from "./browser-viewer-drawer"

function pageState(id: string): BrowserTabState {
  return {
    tabId: id,
    ownerWindow: "main",
    kind: "page",
    surface: "child",
    channel: "degraded",
    channelError: null,
    url: "http://localhost:3000/",
    requestedUrl: "http://localhost:3000/",
    title: "localhost:3000",
    favicon: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    origin: "http://localhost:3000",
    zoom: 1,
    error: null,
    remoteHost: null,
    openerTabId: null,
    profile: "default",
    agentGrant: null,
  }
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function renderDrawer(remote?: boolean) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <BrowserViewerDrawer
        url="http://localhost:3000/"
        remote={remote}
        open
        onOpenChange={() => {}}
      />
    </NextIntlClientProvider>
  )
}

describe("BrowserViewerDrawer", () => {
  beforeEach(() => {
    mocks.openBrowserTab.mockReset()
    mocks.openBrowserTab.mockImplementation(() => "browser:new")
    mocks.fileTabs = []
    mocks.shown = []
    mocks.surface = false
    mocks.route = null
    api.browserOpenTab.mockReset()
    api.browserSetVisible.mockClear()
    resetBrowserTabStoreForTests()
    resetNativeSurfaceOcclusionForTests()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("opens the workspace record without activating the file column", () => {
    renderDrawer()
    expect(mocks.openBrowserTab).toHaveBeenCalledWith(
      "http://localhost:3000/",
      {
        activate: false,
      }
    )
  })

  // Seen from a remote workspace window, the address is that host's: the
  // record it opens must be a remote one, never a page of this computer.
  it("opens an address of the remote host as a remote record", () => {
    renderDrawer(true)
    expect(mocks.openBrowserTab).toHaveBeenCalledWith(
      "http://localhost:3000/",
      {
        activate: false,
        remote: true,
      }
    )
  })

  // The same page is open locally AND as a remote tab: the drawer must never
  // show the local one for a remote request, not even for the first paint
  // before its own open has resolved.
  it("shows only the remote record for a remote request", () => {
    mocks.fileTabs = [
      browserRecord("browser:local", false),
      browserRecord("browser:remote", true),
    ]
    mocks.openBrowserTab.mockImplementation(() => "browser:remote")
    renderDrawer(true)
    expect(mocks.shown.length).toBeGreaterThan(0)
    expect(new Set(mocks.shown)).toEqual(new Set(["browser:remote"]))
  })

  it("shows only the local record for a local request", () => {
    mocks.fileTabs = [
      browserRecord("browser:remote", true),
      browserRecord("browser:local", false),
    ]
    mocks.openBrowserTab.mockImplementation(() => "browser:local")
    renderDrawer(false)
    expect(new Set(mocks.shown)).toEqual(new Set(["browser:local"]))
  })

  // Under a full-page route the transcript a link was clicked in is itself in
  // a drawer, and this one opens on top of it: on the task board, a
  // transcript drawer stacked beside the task detail sheet's content. The
  // page is in front of both, so it shows — and an overlay opened over it
  // still takes it down.
  it("shows the page over the drawers it is stacked on, and hides it for an overlay above", async () => {
    mocks.surface = true
    mocks.route = { isConversations: false, openConversations: () => {} }
    mocks.fileTabs = [browserRecord("browser:stacked", false)]
    mocks.openBrowserTab.mockImplementation(() => "browser:stacked")
    api.browserOpenTab.mockImplementation(() =>
      Promise.resolve(pageState("stacked"))
    )
    // jsdom has no layout: give the page's slot a rect.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 600,
      y: 50,
      left: 600,
      top: 50,
      width: 500,
      height: 600,
      right: 1100,
      bottom: 650,
      toJSON: () => ({}),
    })
    const stack = (overlay: boolean) => (
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <Drawer open swipeDirection="right">
          <DrawerContent>
            <DrawerTitle>Task detail</DrawerTitle>
          </DrawerContent>
          <Drawer open swipeDirection="right">
            <DrawerContent>
              <DrawerTitle>Transcript</DrawerTitle>
              <BrowserViewerDrawer
                url="http://localhost:3000/"
                open
                onOpenChange={() => {}}
              />
            </DrawerContent>
          </Drawer>
        </Drawer>
        <Dialog open={overlay}>
          <DialogContent>
            <DialogTitle>Over everything</DialogTitle>
          </DialogContent>
        </Dialog>
      </NextIntlClientProvider>
    )
    const hides = () =>
      api.browserSetVisible.mock.calls.filter(
        ([id, visible]) => id === "stacked" && !visible
      ).length

    const { rerender } = render(stack(false))
    await flush()
    await flush()
    expect(api.browserOpenTab).toHaveBeenCalledTimes(1)
    expect(api.browserSetVisible).toHaveBeenCalledWith("stacked", true, false)
    expect(hides()).toBe(0)

    rerender(stack(true))
    await flush()
    expect(hides()).toBeGreaterThan(0)
  })
})
