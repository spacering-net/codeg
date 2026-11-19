/**
 * "Open in Codeg" for a Harness item, as the workspace takes it.
 *
 * Pinned down here: the `?harness=` address is read once and taken off the
 * page's address (the rest left as it was); a claimed or read address waits
 * until the workspace is ready and is then opened once — on Discover, with
 * `intent: "install"`, and nothing more — whatever re-renders, remounts or
 * StrictMode do; a browser turned away keeps it for the login; a remote
 * workspace window opens nothing; and a catalog that is switched off is said
 * in words.
 */
import { StrictMode, useEffect, useRef, type ReactNode } from "react"
import { act, cleanup, render, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { HarnessOpenRequest } from "@/lib/harness-sections"

const h = vi.hoisted(() => ({
  toastWarning: vi.fn(),
  remote: false,
  connection: "connected",
  connectionListeners: new Set<() => void>(),
  opens: [] as unknown[],
}))

vi.mock("sonner", () => ({ toast: { warning: h.toastWarning } }))
vi.mock("@/lib/transport", () => ({
  isRemoteDesktopMode: () => h.remote,
  getTransport: () => ({ call: vi.fn(), subscribe: async () => () => {} }),
}))
vi.mock("@/lib/transport/web-connection-store", () => ({
  subscribeWebConnection: (listener: () => void) => {
    h.connectionListeners.add(listener)
    return () => h.connectionListeners.delete(listener)
  },
  getWebConnectionSnapshot: () => h.connection,
  getWebConnectionServerSnapshot: () => "connected",
}))
// The tab store's two fields this reads, in a store of their own: the real
// one comes with the whole tab machinery.
vi.mock("@/contexts/tab-context", async () => {
  const { create } = await import("zustand")
  return {
    useTabStore: create(() => ({
      tabsHydrated: false,
      activeTabId: null as string | null,
    })),
  }
})
// Every request the component makes, as it makes it — counted here rather than
// read off the page, where two requests in one batch would look like one.
vi.mock("@/hooks/use-open-harness", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/use-open-harness")>()
  const { useMemo } = await import("react")
  return {
    ...actual,
    useOpenHarness: () => {
      const real = actual.useOpenHarness()
      return useMemo(
        () => ({
          available: real.available,
          openHarness: (request?: HarnessOpenRequest) => {
            h.opens.push(request)
            return real.openHarness(request)
          },
        }),
        [real]
      )
    },
  }
})

import { useTabStore } from "@/contexts/tab-context"
import {
  HarnessViewProvider,
  useHarnessView,
} from "@/contexts/harness-view-context"
import {
  WorkbenchRouteProvider,
  useWorkbenchRoute,
} from "@/contexts/workbench-route-context"
import {
  __resetHarnessLinkForTests,
  keepHarnessLinkForLogin,
  queueHarnessLink,
  waitingHarnessLink,
} from "@/lib/harness-link"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"
import { HarnessLinkBootstrap } from "./harness-link-bootstrap"

const AFTER_LOGIN_KEY = "codeg:harness-link-after-login"
const OPENED = {
  section: "discover",
  itemRef: "acme/pdf-tools",
  intent: "install",
} as const

let route: ReturnType<typeof useWorkbenchRoute>
let view: ReturnType<typeof useHarnessView>

function Probe() {
  const currentRoute = useWorkbenchRoute()
  const currentView = useHarnessView()
  useEffect(() => {
    route = currentRoute
    view = currentView
  })
  return null
}

function Workspace({
  discoverEnabled,
  children,
}: {
  discoverEnabled?: boolean
  children?: ReactNode
}) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <HarnessViewProvider discoverEnabled={discoverEnabled}>
        <WorkbenchRouteProvider>
          {children}
          <HarnessLinkBootstrap />
          <Probe />
        </WorkbenchRouteProvider>
      </HarnessViewProvider>
    </NextIntlClientProvider>
  )
}

/** The folders and the tabs come in. */
function restore() {
  act(() => {
    useAppWorkspaceStore.setState({ foldersHydrated: true })
    useTabStore.setState({ tabsHydrated: true })
  })
}

function setConnection(next: string) {
  act(() => {
    h.connection = next
    for (const listener of [...h.connectionListeners]) listener()
  })
}

beforeEach(() => {
  h.toastWarning.mockReset()
  h.remote = false
  h.connection = "connected"
  h.connectionListeners.clear()
  h.opens = []
  __resetHarnessLinkForTests()
  resetAppWorkspaceStore()
  useAppWorkspaceStore.setState({ foldersHydrated: false })
  useTabStore.setState({ tabsHydrated: false, activeTabId: null })
  localStorage.clear()
  sessionStorage.clear()
  window.history.replaceState(null, "", "/workspace")
})

afterEach(() => cleanup())

describe("HarnessLinkBootstrap — the page's own ?harness=", () => {
  it("opens the item on Discover once the workspace is ready, and takes the parameter off the address", async () => {
    window.history.replaceState(
      null,
      "",
      "/workspace?view=compact&harness=acme%2Fpdf-tools&q=a%20b#notes"
    )
    render(<Workspace />)

    // Read as the workspace mounts, before anything could keep it around;
    // everything else on the address stays as it was.
    expect(window.location.pathname).toBe("/workspace")
    expect(window.location.search).toBe("?view=compact&q=a%20b")
    expect(window.location.hash).toBe("#notes")
    expect(h.opens).toEqual([])
    expect(route.routeId).toBe("conversations")

    restore()
    await waitFor(() => expect(route.routeId).toBe("harness"))
    expect(h.opens).toEqual([OPENED])
    expect(view.section).toBe("discover")
    expect(view.pendingTarget).toEqual(OPENED)
    expect(h.toastWarning).not.toHaveBeenCalled()
  })

  it("takes the address the way the desktop app writes it on a cold start", async () => {
    window.history.replaceState(
      null,
      "",
      "/workspace?harness=browser-use.com%2Fbrowser-use"
    )
    render(<Workspace />)
    restore()
    await waitFor(() =>
      expect(h.opens).toEqual([
        { ...OPENED, itemRef: "browser-use.com/browser-use" },
      ])
    )
    expect(window.location.search).toBe("")
  })

  it.each([
    "..%2F..%2Fother%2Fname",
    "acme",
    "acme%2Fpdf%2Fextra",
    "https%3A%2F%2Fspacering.net%2Fharness%2Facme%2Fpdf",
    "",
  ])("drops %j silently, and the workspace shows as usual", async (value) => {
    window.history.replaceState(null, "", `/workspace?a=1&harness=${value}#h`)
    render(<Workspace />)
    expect(window.location.search).toBe("?a=1")
    expect(window.location.hash).toBe("#h")

    restore()
    await act(async () => {})
    expect(h.opens).toEqual([])
    expect(route.routeId).toBe("conversations")
    expect(waitingHarnessLink()).toBeNull()
    expect(h.toastWarning).not.toHaveBeenCalled()
  })

  it("leaves an address without the parameter alone", async () => {
    window.history.replaceState({ kept: true }, "", "/workspace?a=1#h")
    render(<Workspace />)
    restore()
    await act(async () => {})
    expect(window.location.search).toBe("?a=1")
    expect(window.history.state).toEqual({ kept: true })
    expect(h.opens).toEqual([])
  })
})

describe("HarnessLinkBootstrap — waiting for the workspace", () => {
  it("waits for the folders and the tabs", async () => {
    window.history.replaceState(null, "", "/workspace?harness=acme/pdf-tools")
    render(<Workspace />)

    act(() => {
      useAppWorkspaceStore.setState({ foldersHydrated: true })
    })
    await act(async () => {})
    expect(h.opens).toEqual([])
    // Still waiting, not lost.
    expect(waitingHarnessLink()).toBe("acme/pdf-tools")

    act(() => {
      useTabStore.setState({ tabsHydrated: true })
    })
    await waitFor(() => expect(h.opens).toEqual([OPENED]))
    expect(waitingHarnessLink()).toBeNull()
  })

  it("opens a link claimed before the workspace was even mounted", async () => {
    queueHarnessLink("acme/pdf-tools")
    render(<Workspace />)
    await act(async () => {})
    expect(h.opens).toEqual([])

    restore()
    await waitFor(() => expect(h.opens).toEqual([OPENED]))
  })

  it("opens a link claimed while the workspace is up at once", async () => {
    render(<Workspace />)
    restore()
    await act(async () => {})

    act(() => queueHarnessLink("acme/pdf-tools"))
    await waitFor(() => expect(h.opens).toEqual([OPENED]))
    expect(route.routeId).toBe("harness")
  })

  it("opens only the newest of two links that arrive before it is ready", async () => {
    window.history.replaceState(null, "", "/workspace?harness=acme/first")
    render(<Workspace />)
    act(() => queueHarnessLink("acme/pdf-tools"))

    restore()
    await waitFor(() => expect(h.opens).toEqual([OPENED]))
  })

  it("opens each link that arrives after the last one opened", async () => {
    render(<Workspace />)
    restore()
    act(() => queueHarnessLink("acme/first"))
    await waitFor(() => expect(h.opens).toHaveLength(1))
    act(() => queueHarnessLink("acme/pdf-tools"))
    await waitFor(() => expect(h.opens).toHaveLength(2))
    expect(h.opens[1]).toEqual(OPENED)
    expect(view.pendingTarget).toEqual(OPENED)
  })

  // The tab provider settles the restored tabs in effects that run after this
  // component's, in the render that brings the tabs in — and a tab activated
  // there sends the route sync back to the conversations. Mirrors both, in the
  // order the workspace layout mounts them.
  it("is not shut again by a tab the workspace activates as it restores", async () => {
    function RouteSync() {
      const activeTabId = useTabStore((s) => s.activeTabId)
      const { openConversations } = useWorkbenchRoute()
      const prev = useRef(activeTabId)
      useEffect(() => {
        if (prev.current === activeTabId) return
        prev.current = activeTabId
        openConversations()
      }, [activeTabId, openConversations])
      return null
    }
    function RecoversADraft({ children }: { children: ReactNode }) {
      const tabsHydrated = useTabStore((s) => s.tabsHydrated)
      const foldersHydrated = useAppWorkspaceStore((s) => s.foldersHydrated)
      useEffect(() => {
        if (!tabsHydrated || !foldersHydrated) return
        if (useTabStore.getState().activeTabId === null) {
          useTabStore.setState({ activeTabId: "draft-1" })
        }
      }, [tabsHydrated, foldersHydrated])
      return <>{children}</>
    }

    window.history.replaceState(null, "", "/workspace?harness=acme/pdf-tools")
    render(
      <RecoversADraft>
        <Workspace>
          <RouteSync />
        </Workspace>
      </RecoversADraft>
    )
    restore()

    await waitFor(() => expect(route.routeId).toBe("harness"))
    for (let i = 0; i < 3; i++) await act(async () => {})
    expect(useTabStore.getState().activeTabId).toBe("draft-1")
    expect(route.routeId).toBe("harness")
    expect(h.opens).toEqual([OPENED])
  })
})

describe("HarnessLinkBootstrap — exactly once", () => {
  it("opens once under StrictMode", async () => {
    window.history.replaceState(null, "", "/workspace?harness=acme/pdf-tools")
    render(
      <StrictMode>
        <Workspace />
      </StrictMode>
    )
    restore()
    await waitFor(() => expect(route.routeId).toBe("harness"))
    for (let i = 0; i < 3; i++) await act(async () => {})
    expect(h.opens).toEqual([OPENED])
  })

  it("does not open again on a re-render or a remount", async () => {
    window.history.replaceState(null, "", "/workspace?harness=acme/pdf-tools")
    const first = render(<Workspace />)
    restore()
    await waitFor(() => expect(h.opens).toHaveLength(1))

    first.rerender(<Workspace />)
    first.rerender(<Workspace />)
    await act(async () => {})
    first.unmount()

    render(<Workspace />)
    await act(async () => {})
    expect(h.opens).toHaveLength(1)
  })

  it("does not bring the link back with the back button", async () => {
    window.history.replaceState(null, "", "/workspace?harness=acme/pdf-tools")
    const first = render(<Workspace />)
    restore()
    await waitFor(() => expect(h.opens).toHaveLength(1))

    // A layer opened over the page (the detail on a phone) pushes an entry;
    // back pops it, onto the entry the link arrived in.
    window.history.pushState({ layer: 1 }, "")
    const popped = new Promise<void>((resolve) =>
      window.addEventListener("popstate", () => resolve(), { once: true })
    )
    window.history.back()
    await popped
    expect(window.location.search).toBe("")

    first.unmount()
    render(<Workspace />)
    await act(async () => {})
    expect(h.opens).toHaveLength(1)
  })
})

describe("HarnessLinkBootstrap — where the page already was", () => {
  it("switches from another section to Discover with the item", async () => {
    render(<Workspace />)
    restore()
    act(() => {
      view.open({ section: "mcp", serverKey: "github" })
      route.setRoute("harness")
    })
    expect(view.section).toBe("mcp")

    act(() => queueHarnessLink("acme/pdf-tools"))
    await waitFor(() => expect(view.section).toBe("discover"))
    expect(view.pendingTarget).toEqual(OPENED)
    expect(route.routeId).toBe("harness")
  })

  it("brings the page up from a conversation", async () => {
    render(<Workspace />)
    restore()
    act(() => route.setRoute("tasks"))

    act(() => queueHarnessLink("acme/pdf-tools"))
    await waitFor(() => expect(route.routeId).toBe("harness"))
    expect(view.pendingTarget).toEqual(OPENED)
  })
})

describe("HarnessLinkBootstrap — Codeg Web before the login", () => {
  it("leaves the item waiting while the browser is turned away, for the login to carry", async () => {
    h.connection = "unauthorized"
    window.history.replaceState(null, "", "/workspace?harness=acme/pdf-tools")
    render(<Workspace />)
    restore()
    await act(async () => {})

    expect(h.opens).toEqual([])
    expect(waitingHarnessLink()).toBe("acme/pdf-tools")
    // What "Go to login" keeps on its way out.
    keepHarnessLinkForLogin()
    expect(JSON.parse(sessionStorage.getItem(AFTER_LOGIN_KEY)!)).toMatchObject({
      ref: "acme/pdf-tools",
    })
  })

  it("waits the same for a proxy that turned the browser away", async () => {
    h.connection = "proxyUnauthorized"
    queueHarnessLink("acme/pdf-tools")
    render(<Workspace />)
    restore()
    await act(async () => {})
    expect(h.opens).toEqual([])

    // Let back in without leaving the page.
    setConnection("connected")
    await waitFor(() => expect(h.opens).toEqual([OPENED]))
  })

  it("forgets an item kept for a login that never came", () => {
    sessionStorage.setItem(
      AFTER_LOGIN_KEY,
      JSON.stringify({ ref: "acme/old", at: Date.now() })
    )
    render(<Workspace />)
    expect(sessionStorage.getItem(AFTER_LOGIN_KEY)).toBeNull()
  })
})

describe("HarnessLinkBootstrap — windows and switches", () => {
  // A link opens the item on this computer. A remote workspace window never
  // claims the desktop's parked link, and its own address has nothing to open.
  it("opens nothing from a remote workspace window's address", async () => {
    h.remote = true
    window.history.replaceState(
      null,
      "",
      "/workspace?remoteConnectionId=3&remoteWindowId=w&harness=acme/pdf-tools"
    )
    render(<Workspace />)
    expect(window.location.search).toBe(
      "?remoteConnectionId=3&remoteWindowId=w"
    )
    restore()
    await act(async () => {})
    expect(h.opens).toEqual([])
    expect(waitingHarnessLink()).toBeNull()
  })

  it("says in words that Discover is switched off, rather than failing silently", async () => {
    window.history.replaceState(null, "", "/workspace?harness=acme/pdf-tools")
    render(<Workspace discoverEnabled={false} />)
    restore()

    await waitFor(() => expect(h.toastWarning).toHaveBeenCalledTimes(1))
    expect(h.toastWarning).toHaveBeenCalledWith(
      "Discover is switched off on this Codeg, so acme/pdf-tools cannot be opened here.",
      { id: "harness-link-discover-off" }
    )
    // The page opens where it last was, with nothing parked to go off later.
    expect(route.routeId).toBe("harness")
    expect(view.section).toBe("mcp")
    expect(view.pendingTarget).toBeNull()
  })
})
