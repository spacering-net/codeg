import { act, render, waitFor, cleanup } from "@testing-library/react"
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"

// The workspace half lives in the real zustand store: tests seed it via
// setState in beforeEach and flip hydration with act(setState). The tab half
// is still a mutable hook mock — the mock reads this module-level var, so
// reassigning + rerendering simulates the provider state changing.
let tabs: { tabsHydrated: boolean; openTab: Mock }
let addFolderToWorkspaceById: Mock
let handlers: Map<string, (p: unknown) => void>
let takePendingDeepLink: Mock
let takePendingHarnessLink: Mock

const FOCUS = "workspace://focus-conversation"
const PENDING = "workspace://deep-link-pending"

vi.mock("@/contexts/tab-context", () => ({
  useTabStore: (selector: (s: typeof tabs) => unknown) => selector(tabs),
  useTabActions: () => tabs,
}))
vi.mock("@/lib/transport", () => ({
  getTransport: () => ({
    subscribe: async (event: string, cb: (p: unknown) => void) => {
      handlers.set(event, cb)
      return () => handlers.delete(event)
    },
  }),
}))
vi.mock("@/lib/deep-link", () => ({
  takePendingDeepLink: () => takePendingDeepLink(),
  takePendingHarnessLink: () => takePendingHarnessLink(),
}))

import {
  __resetHarnessLinkForTests,
  subscribeWaitingHarnessLink,
  waitingHarnessLink,
} from "@/lib/harness-link"
import { PetFocusBridge } from "./deep-link-bootstrap"

/** One-shot backend slot, mirroring `PENDING_FOCUS`'s atomic take. */
function parkOne(target: unknown) {
  let slot: unknown = target
  return vi.fn(async () => {
    const taken = slot
    slot = null
    return taken
  })
}

describe("PetFocusBridge", () => {
  beforeEach(() => {
    handlers = new Map()
    takePendingDeepLink = vi.fn(async () => null)
    takePendingHarnessLink = vi.fn(async () => null)
    __resetHarnessLinkForTests()
    addFolderToWorkspaceById = vi.fn()
    resetAppWorkspaceStore()
    useAppWorkspaceStore.setState({
      foldersHydrated: false,
      folders: [{ id: 7 }] as never,
      addFolderToWorkspaceById,
    })
    tabs = { tabsHydrated: false, openTab: vi.fn() }
  })
  afterEach(() => cleanup())

  it("queues a request that arrives before hydration and replays it", async () => {
    const { rerender } = render(<PetFocusBridge />)
    await waitFor(() => expect(handlers.has(FOCUS)).toBe(true))

    // Arrives before folders/tabs (and the independently-loading conversations
    // snapshot) are ready — must not be dropped.
    handlers.get(FOCUS)!({
      folderId: 7,
      conversationId: 42,
      agent: "claude_code",
    })
    expect(tabs.openTab).not.toHaveBeenCalled()

    // Hydration completes → queued request replays.
    tabs = { ...tabs, tabsHydrated: true }
    rerender(<PetFocusBridge />)
    act(() => {
      useAppWorkspaceStore.setState({ foldersHydrated: true })
    })

    await waitFor(() =>
      expect(tabs.openTab).toHaveBeenCalledWith(7, 42, "claude_code", true)
    )
  })

  it("opens immediately when already hydrated, without re-adding an open folder", async () => {
    useAppWorkspaceStore.setState({ foldersHydrated: true })
    tabs = { ...tabs, tabsHydrated: true }
    render(<PetFocusBridge />)
    await waitFor(() => expect(handlers.has(FOCUS)).toBe(true))

    handlers.get(FOCUS)!({ folderId: 7, conversationId: 9, agent: "codex" })
    await waitFor(() =>
      expect(tabs.openTab).toHaveBeenCalledWith(7, 9, "codex", true)
    )
    expect(addFolderToWorkspaceById).not.toHaveBeenCalled()
  })

  // A `codeg://session/<id>` that reaches the backend before this component
  // subscribes (macOS cold start) is parked there, and the nudge that went with
  // it was dropped — the mount drain is what finds it.
  it("opens the tab for a deep link parked before it subscribed", async () => {
    takePendingDeepLink = parkOne({
      folderId: 7,
      conversationId: 314,
      agent: "grok",
    })
    const { rerender } = render(<PetFocusBridge />)

    // Still queued while hydrating, exactly like a live request.
    await waitFor(() => expect(takePendingDeepLink).toHaveBeenCalled())
    expect(tabs.openTab).not.toHaveBeenCalled()

    tabs = { ...tabs, tabsHydrated: true }
    rerender(<PetFocusBridge />)
    act(() => {
      useAppWorkspaceStore.setState({ foldersHydrated: true })
    })
    await waitFor(() =>
      expect(tabs.openTab).toHaveBeenCalledWith(7, 314, "grok", true)
    )
  })

  it("opens the tab when a warm link nudges after it subscribed", async () => {
    useAppWorkspaceStore.setState({ foldersHydrated: true })
    tabs = { ...tabs, tabsHydrated: true }
    render(<PetFocusBridge />)
    await waitFor(() => expect(handlers.has(PENDING)).toBe(true))

    takePendingDeepLink = parkOne({
      folderId: 7,
      conversationId: 55,
      agent: "codex",
    })
    handlers.get(PENDING)!(null)
    await waitFor(() =>
      expect(tabs.openTab).toHaveBeenCalledWith(7, 55, "codex", true)
    )
  })

  // The slot is the only channel and the take is atomic, so a nudge racing the
  // mount drain cannot open the same conversation twice…
  it("opens a parked target exactly once when the nudge races the mount drain", async () => {
    useAppWorkspaceStore.setState({ foldersHydrated: true })
    tabs = { ...tabs, tabsHydrated: true }
    takePendingDeepLink = parkOne({
      folderId: 7,
      conversationId: 77,
      agent: "grok",
    })
    render(<PetFocusBridge />)
    await waitFor(() => expect(handlers.has(PENDING)).toBe(true))

    await act(async () => {
      handlers.get(PENDING)!(null)
    })

    await waitFor(() => expect(tabs.openTab).toHaveBeenCalledTimes(1))
    expect(tabs.openTab).toHaveBeenCalledWith(7, 77, "grok", true)
    // Two drains ran (mount + nudge) but only one target came back.
    expect(takePendingDeepLink.mock.calls.length).toBeGreaterThan(1)
  })

  // …and a link consumed on one mount cannot reappear on the next.
  it("does not replay a consumed deep link on a later mount", async () => {
    useAppWorkspaceStore.setState({ foldersHydrated: true })
    tabs = { ...tabs, tabsHydrated: true }
    takePendingDeepLink = parkOne({
      folderId: 7,
      conversationId: 88,
      agent: "grok",
    })
    const first = render(<PetFocusBridge />)
    await waitFor(() => expect(tabs.openTab).toHaveBeenCalledTimes(1))
    first.unmount()

    tabs = { ...tabs, openTab: vi.fn() }
    render(<PetFocusBridge />)
    await waitFor(() => expect(handlers.has(PENDING)).toBe(true))
    await act(async () => {})
    expect(tabs.openTab).not.toHaveBeenCalled()
  })

  // Both producers are one-shot — the pet event has no replay and the drained
  // deep link is already out of the backend slot — so neither may overwrite
  // the other while the workspace is still hydrating.
  it.each([
    ["deep link first", true],
    ["pet click first", false],
  ])(
    "keeps both requests queued before hydration (%s)",
    async (_, deepLinkFirst) => {
      // Hold the drain open so the two producers can be interleaved exactly,
      // rather than racing the mount effect's own scheduling.
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const take = parkOne({ folderId: 7, conversationId: 101, agent: "grok" })
      takePendingDeepLink = vi.fn(async () => {
        await gate
        return take()
      })

      const { rerender } = render(<PetFocusBridge />)
      // The drain has started and is now parked on the gate.
      await waitFor(() => expect(takePendingDeepLink).toHaveBeenCalled())

      const petClick = () =>
        handlers.get(FOCUS)!({
          folderId: 7,
          conversationId: 202,
          agent: "codex",
        })
      const deepLink = async () => {
        await act(async () => {
          release()
        })
      }
      if (deepLinkFirst) {
        await deepLink()
        petClick()
      } else {
        petClick()
        await deepLink()
      }
      expect(tabs.openTab).not.toHaveBeenCalled()

      tabs = { ...tabs, tabsHydrated: true }
      rerender(<PetFocusBridge />)
      act(() => {
        useAppWorkspaceStore.setState({ foldersHydrated: true })
      })

      await waitFor(() => expect(tabs.openTab).toHaveBeenCalledTimes(2))
      expect(tabs.openTab).toHaveBeenCalledWith(7, 101, "grok", true)
      expect(tabs.openTab).toHaveBeenCalledWith(7, 202, "codex", true)
      // The later request is opened last, so it is the one left focused.
      const calls = tabs.openTab.mock.calls
      expect(calls[calls.length - 1][1]).toBe(deepLinkFirst ? 202 : 101)
    }
  )

  // Opening a tab can await a folder load. A request that arrives during that
  // await gets its own batch, so batches have to be chained — otherwise the
  // newcomer opens first and leaves the *earlier* conversation focused.
  it("keeps request order when a later one arrives mid folder load", async () => {
    let finishFolderOpen: () => void = () => {}
    addFolderToWorkspaceById = vi.fn(
      () =>
        new Promise((resolve) => {
          finishFolderOpen = () => {
            useAppWorkspaceStore.setState({
              folders: [{ id: 8 }, { id: 9 }] as never,
            })
            resolve({ id: 9 } as never)
          }
        })
    )
    useAppWorkspaceStore.setState({
      foldersHydrated: true,
      folders: [{ id: 8 }] as never,
      addFolderToWorkspaceById,
    })
    tabs = { ...tabs, tabsHydrated: true }
    render(<PetFocusBridge />)
    await waitFor(() => expect(handlers.has(FOCUS)).toBe(true))

    // First request needs folder 9 opened; it parks on that promise.
    handlers.get(FOCUS)!({ folderId: 9, conversationId: 1, agent: "grok" })
    await waitFor(() =>
      expect(addFolderToWorkspaceById).toHaveBeenCalledWith(9)
    )
    expect(tabs.openTab).not.toHaveBeenCalled()

    // Second request arrives mid-await, into folder 8 — already open, so its
    // own batch has nothing to wait for and would otherwise jump the queue.
    handlers.get(FOCUS)!({ folderId: 8, conversationId: 2, agent: "grok" })
    await act(async () => {})
    expect(tabs.openTab).not.toHaveBeenCalled()

    await act(async () => {
      finishFolderOpen()
    })
    await waitFor(() => expect(tabs.openTab).toHaveBeenCalledTimes(2))
    expect(tabs.openTab.mock.calls[0][1]).toBe(1)
    expect(tabs.openTab.mock.calls[1][1]).toBe(2)
    expect(addFolderToWorkspaceById).toHaveBeenCalledTimes(1)
  })

  it("ignores malformed payloads", async () => {
    useAppWorkspaceStore.setState({ foldersHydrated: true })
    tabs = { ...tabs, tabsHydrated: true }
    render(<PetFocusBridge />)
    await waitFor(() => expect(handlers.has(FOCUS)).toBe(true))

    handlers.get(FOCUS)!({ folderId: "x", conversationId: 1, agent: "codex" })
    handlers.get(FOCUS)!({ folderId: 7, conversationId: 1 }) // missing agent
    await Promise.resolve()
    expect(tabs.openTab).not.toHaveBeenCalled()
  })
})

// `codeg://harness/install?ref=…` waits in a slot of its own, behind the same
// nudge. The bridge only claims it; `HarnessLinkBootstrap` opens it.
describe("PetFocusBridge — Harness links", () => {
  beforeEach(() => {
    handlers = new Map()
    takePendingDeepLink = vi.fn(async () => null)
    takePendingHarnessLink = vi.fn(async () => null)
    __resetHarnessLinkForTests()
    addFolderToWorkspaceById = vi.fn()
    resetAppWorkspaceStore()
    useAppWorkspaceStore.setState({
      foldersHydrated: true,
      folders: [{ id: 7 }] as never,
      addFolderToWorkspaceById,
    })
    tabs = { tabsHydrated: true, openTab: vi.fn() }
  })
  afterEach(() => cleanup())

  // The macOS cold start: parked before anything listened.
  it("claims a link parked before it subscribed, and hands the address on", async () => {
    takePendingHarnessLink = parkOne("acme/pdf-tools")
    render(<PetFocusBridge />)

    await waitFor(() => expect(waitingHarnessLink()).toBe("acme/pdf-tools"))
    // Subscribed first, claimed after: the order that loses nothing.
    expect(handlers.has(PENDING)).toBe(true)
    // An address is not a conversation.
    expect(tabs.openTab).not.toHaveBeenCalled()
  })

  it("claims a link when a warm start nudges", async () => {
    render(<PetFocusBridge />)
    await waitFor(() => expect(handlers.has(PENDING)).toBe(true))
    await act(async () => {})
    expect(waitingHarnessLink()).toBeNull()

    takePendingHarnessLink = parkOne("acme/pdf-tools")
    await act(async () => {
      handlers.get(PENDING)!(null)
    })
    await waitFor(() => expect(waitingHarnessLink()).toBe("acme/pdf-tools"))
  })

  it("claims both slots on one nudge", async () => {
    render(<PetFocusBridge />)
    await waitFor(() => expect(handlers.has(PENDING)).toBe(true))

    takePendingDeepLink = parkOne({
      folderId: 7,
      conversationId: 12,
      agent: "grok",
    })
    takePendingHarnessLink = parkOne("acme/pdf-tools")
    await act(async () => {
      handlers.get(PENDING)!(null)
    })

    await waitFor(() =>
      expect(tabs.openTab).toHaveBeenCalledWith(7, 12, "grok", true)
    )
    expect(waitingHarnessLink()).toBe("acme/pdf-tools")
  })

  it("hands a parked link on once when the nudge races the mount drain", async () => {
    const take = parkOne("acme/pdf-tools")
    takePendingHarnessLink = take
    const queue = vi.fn()
    const off = subscribeWaitingHarnessLink(queue)
    render(<PetFocusBridge />)
    await waitFor(() => expect(handlers.has(PENDING)).toBe(true))
    await act(async () => {
      handlers.get(PENDING)!(null)
    })

    await waitFor(() => expect(waitingHarnessLink()).toBe("acme/pdf-tools"))
    expect(take.mock.calls.length).toBeGreaterThan(1)
    // One address arrived, once.
    expect(queue).toHaveBeenCalledTimes(1)
    off()
  })

  // StrictMode mounts the bridge, drops it and mounts it again, and a claim
  // started by the first one can come back after it is gone. The backend has
  // already let go of the address, so it is handed on anyway.
  it("hands on a link claimed by a bridge that has gone since", async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const take = parkOne("acme/pdf-tools")
    takePendingHarnessLink = vi.fn(async () => {
      await gate
      return take()
    })
    const first = render(<PetFocusBridge />)
    await waitFor(() => expect(takePendingHarnessLink).toHaveBeenCalled())
    first.unmount()

    await act(async () => {
      release()
    })
    await waitFor(() => expect(waitingHarnessLink()).toBe("acme/pdf-tools"))
  })

  it("hands on nothing when nothing was parked", async () => {
    render(<PetFocusBridge />)
    await waitFor(() => expect(takePendingHarnessLink).toHaveBeenCalled())
    await act(async () => {})
    expect(waitingHarnessLink()).toBeNull()
  })
})
