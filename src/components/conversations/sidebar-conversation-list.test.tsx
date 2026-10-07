import {
  createRef,
  type ReactNode,
  type Ref,
  useEffect,
  useImperativeHandle,
  useState,
} from "react"
import { act, fireEvent, render } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  SidebarConversationList,
  type SidebarConversationListHandle,
} from "./sidebar-conversation-list"
import type { DbConversationSummary, FolderDetail } from "@/lib/types"
import type { TagFilter } from "@/lib/conversation-tags"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"
import enMessages from "@/i18n/messages/en.json"

// ── Probes ────────────────────────────────────────────────────────────────
// AgentIcon renders once per card body → counts card re-renders. The Folder /
// FolderOpen lucide icon renders once per FolderHeader body → counts folder
// re-renders. Both increment only when the owning memoized component does NOT
// bail out, so they measure exactly the production memo path.
const probes = vi.hoisted(() => ({ card: 0, folder: 0, root: 0 }))

// Mutable backing store the mocked tab-context hook reads from (workspace data
// now lives in the real zustand store, seeded per test below). `tabs` is
// rebuilt fresh every render to mirror tab-context re-deriving it on each
// `conversations` change.
const store = vi.hoisted(() => ({
  activeTabId: null as string | null,
  tabSpec: [] as Array<{
    id: string
    conversationId: number | null
    agentType: string
    folderId: number
    title: string
    isPinned: boolean
  }>,
}))

// Action spies installed into the workspace store before each test. zustand
// keeps these referentially stable across renders (as the real store's action
// fields are), so the list's folder callbacks that close over them stay
// memoized.
const stableWorkspaceFns = vi.hoisted(() => ({
  refreshConversations: async () => {},
  updateConversationLocal: () => {},
  removeFolderFromWorkspace: async () => {},
  applySidebarLayout: vi.fn(() => Promise.resolve()),
  openFolder: async () => ({}) as FolderDetail,
  refreshFolder: async () => {},
}))

const stableTabFns = vi.hoisted(() => ({
  openTab: () => {},
  closeConversationTab: () => {},
  closeTabsByFolder: () => {},
  openNewConversationTab: () => {},
}))

const stableAgents = vi.hoisted(() => ({ sortedTypes: ["claude_code"] }))

// Context functions are stable refs in production (useCallback values); the
// mocks must be too, else the list's folder callbacks (which close over them)
// would churn and mask the memo behaviour under test.
const stableTask = vi.hoisted(() => ({
  addTask: () => {},
  updateTask: () => {},
}))
const stableTerminal = vi.hoisted(() => ({
  createTerminalInDirectory: () => {},
}))

vi.mock("@/components/agent-icon", () => ({
  AgentIcon: () => {
    probes.card++
    return null
  },
}))

// Controllable virtua geometry for the sticky-overlay tests. All rows are 32px
// (h-[2rem]), so offsets are index*32 and findItemIndex is floor(offset/32).
const virtuaCtl = vi.hoisted(() => ({
  scrollOffset: 0,
  onScroll: null as ((offset: number) => void) | null,
  scrollToIndex: vi.fn(),
}))

// Render EVERY row (data.map) rather than only a window, so the render-count
// probes stay meaningful in jsdom (which has no real layout/scroll). This is
// exactly why virtua's windowing itself needs manual QA on a large dataset. The
// mock also forwards a settable VirtualizerHandle (ref-as-prop, React 19) so the
// list's scroll-driven sticky logic can be exercised; with scrollOffset left at
// 0 the overlay stays hidden, so the memo-scope tests below are unaffected.
vi.mock("virtua", () => ({
  Virtualizer: ({
    data,
    children,
    onScroll,
    ref,
  }: {
    data: unknown[]
    children: (row: unknown, index: number) => ReactNode
    onScroll?: (offset: number) => void
    ref?: Ref<unknown>
  }) => {
    virtuaCtl.onScroll = onScroll ?? null
    useImperativeHandle(ref, () => ({
      get scrollOffset() {
        return virtuaCtl.scrollOffset
      },
      get scrollSize() {
        return data.length * 32
      },
      get viewportSize() {
        return 600
      },
      findItemIndex: (offset: number) =>
        Math.max(0, Math.min(data.length - 1, Math.floor(offset / 32))),
      getItemOffset: (index: number) => index * 32,
      getItemSize: () => 32,
      scrollToIndex: virtuaCtl.scrollToIndex,
      scrollTo: () => {},
      scrollBy: () => {},
    }))
    return <>{data.map((row, i) => children(row, i))}</>
  },
}))

// FolderHeader renders exactly one glyph in its body per variant: FolderClosed/
// FolderOpen (a repo / plain folder / repo container header) → `probes.folder`,
// or FolderRoot (a container's "root" sub-group header) → `probes.root`. Every
// other icon stays real. FolderRoot is used ONLY by the root sub-group, so it is
// an exact re-render probe. Worktree headers use FolderGit2, which the Folders
// section header's Clone action ALSO renders — so it is deliberately left real
// (not a probe); worktree headers are asserted via `data-folder-id` + the branch
// label instead.
vi.mock("lucide-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lucide-react")>()
  return {
    ...actual,
    FolderClosed: () => {
      probes.folder++
      return null
    },
    FolderOpen: () => {
      probes.folder++
      return null
    },
    FolderRoot: () => {
      probes.root++
      return null
    },
  }
})

// The list mounts the Virtualizer only once OverlayScrollbars surfaces its
// viewport; the mock fires that bridge synchronously after mount.
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({
    children,
    onViewportRef,
  }: {
    children?: ReactNode
    onViewportRef?: (el: HTMLElement | null) => void
  }) => {
    useEffect(() => {
      onViewportRef?.(document.createElement("div"))
    }, [onViewportRef])
    return <>{children}</>
  },
}))

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}))

vi.mock("@/hooks/use-appearance", () => ({
  useThemeColor: () => ({ themeColor: "blue" }),
  // 100% — the folder-drag row height reads this, so the drag cases below
  // measure against the same 32px row the real hook yields at that zoom.
  useZoomLevel: () => ({ zoomLevel: 100, setZoomLevel: () => {} }),
}))

vi.mock("@/hooks/use-sorted-available-agents", () => ({
  useSortedAvailableAgents: () => ({
    sortedTypes: stableAgents.sortedTypes,
    fresh: true,
    refresh: () => {},
  }),
}))

vi.mock("@/contexts/terminal-context", () => ({
  useTerminalContext: () => stableTerminal,
}))

vi.mock("@/contexts/task-context", () => ({
  useTaskContext: () => stableTask,
}))

vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({ activeFolder: null }),
}))

vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => stableTabFns,
  useTabStore: (
    selector: (s: {
      activeTabId: string | null
      tabs: Array<Record<string, unknown>>
    }) => unknown
  ) =>
    selector({
      activeTabId: store.activeTabId,
      // Fresh array + fresh objects every render → worst-case churn, exactly
      // what the list's reuseSelected/reuseSet must absorb to keep folders
      // memoized.
      tabs: store.tabSpec.map((t) => ({ ...t })),
    }),
}))
vi.mock("@/contexts/workbench-route-context", () => {
  // Stable singleton — the real provider memoizes these (useCallback([])), so a
  // fresh object per render would break the list's callback-identity memoization
  // probes.
  const value = {
    routeId: "conversations",
    isConversations: true,
    setRoute: () => {},
    openConversations: () => {},
  }
  return { useWorkbenchRoute: () => value }
})

// These only mount when their state opens (never in these tests); stub to keep
// the import graph light.
vi.mock("./conversation-manage-dialog", () => ({
  ConversationManageDialog: () => null,
}))
vi.mock("@/components/layout/clone-dialog", () => ({ CloneDialog: () => null }))
// The sub-session realtime sync hook reaches @/lib/platform (transport), which
// these tests don't load; stub it to a no-op — it has its own unit tests.
vi.mock("@/hooks/use-subsession-sync", () => ({ useSubsessionSync: () => {} }))
vi.mock("@/components/shared/directory-browser-dialog", () => ({
  DirectoryBrowserDialog: () => null,
}))

const MINUTE = 60_000
const FIXED = 1_700_000_000_000

function conv(
  id: number,
  folderId: number,
  overrides: Partial<DbConversationSummary> = {}
): DbConversationSummary {
  const createdAt = new Date(FIXED - 5 * MINUTE).toISOString()
  return {
    id,
    folder_id: folderId,
    title: `conv-${id}`,
    title_locked: false,
    agent_type: "claude_code",
    status: "pending",
    kind: "regular",
    model: null,
    git_branch: null,
    external_id: null,
    message_count: 0,
    child_count: 0,
    created_at: createdAt,
    updated_at: createdAt,
    pinned_at: null,
    ...overrides,
  }
}

function folder(
  id: number,
  name: string,
  parentId: number | null = null
): FolderDetail {
  return {
    id,
    name,
    path: `/p/${id}`,
    color: "blue",
    default_agent_type: null,
    parent_id: parentId,
  } as unknown as FolderDetail
}

// Re-render only the list, leaving the intl provider mounted once — mirrors
// production, where NextIntlClientProvider sits high in the tree and stays
// stable (so `useTranslations` returns a stable `t`) while the list re-renders
// on each conversations change.
const harness: { rerender: () => void } = { rerender: () => {} }
function Harness() {
  const [, setTick] = useState(0)
  useEffect(() => {
    harness.rerender = () => setTick((n) => n + 1)
  }, [])
  return <SidebarConversationList showCompleted sortMode="created" />
}

function tree() {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <Harness />
    </NextIntlClientProvider>
  )
}

// Reset the virtua geometry and the workspace store before every test (runs
// before each describe's own beforeEach) so a scrolled overlay test never
// bleeds into the memo-scope or drag suites, which all assume scrollOffset 0 →
// overlay hidden. The store reset restores pristine state; the setState then
// flips the loading flags off and installs the stable action spies, and each
// describe's own beforeEach seeds its folders/conversations fixture on top.
beforeEach(() => {
  resetAppWorkspaceStore()
  useAppWorkspaceStore.setState({
    conversationsLoading: false,
    conversationsError: null,
    ...stableWorkspaceFns,
  })
  virtuaCtl.scrollOffset = 0
  virtuaCtl.onScroll = null
  virtuaCtl.scrollToIndex.mockClear()
})

describe("SidebarConversationList — single status event re-render scope", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: FIXED })
    probes.card = 0
    probes.folder = 0
    const folders = [folder(1, "Folder 1"), folder(2, "Folder 2")]
    useAppWorkspaceStore.setState({
      folders,
      allFolders: folders,
      conversations: [
        conv(11, 1),
        conv(12, 1),
        conv(21, 2),
        conv(22, 2),
        conv(23, 2),
      ],
    })
    // One open tab in folder 1 → exercises the selectedConversation object and
    // openTabKeys Set reuse paths (these churn refs every render via the mock).
    store.activeTabId = "tab-11"
    store.tabSpec = [
      {
        id: "tab-11",
        conversationId: 11,
        agentType: "claude_code",
        folderId: 1,
        title: "conv-11",
        isPinned: false,
      },
    ]
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("re-renders exactly one card and no folder headers when a single summary changes", () => {
    render(tree())

    // Sanity: initial mount rendered all 5 cards and both folders.
    expect(probes.card).toBe(5)
    expect(probes.folder).toBe(2)

    // Mirror updateConversationLocal: replace exactly one summary (folder 2,
    // conv 22) with a new object; every other summary keeps its identity.
    const prev = useAppWorkspaceStore.getState().conversations
    const next = prev.slice()
    const idx = next.findIndex((c) => c.id === 22)
    next[idx] = { ...next[idx], status: "completed" }

    probes.card = 0
    probes.folder = 0
    act(() => {
      useAppWorkspaceStore.setState({ conversations: next })
    })
    act(() => harness.rerender())

    // Card-level gate: only the changed card re-renders (R1 + R1b + shared now).
    expect(probes.card).toBe(1)
    // Folder headers are fully decoupled from their conversation rows in the
    // flat model — a status event leaves every header's props (count, expanded,
    // stable callbacks) unchanged, so no header re-renders at all.
    expect(probes.folder).toBe(0)
  })

  it("re-renders nothing when conversations are unchanged despite tab churn", () => {
    render(tree())

    probes.card = 0
    probes.folder = 0
    // Same conversations reference; tabs still churns (fresh array each render).
    act(() => harness.rerender())

    expect(probes.card).toBe(0)
    expect(probes.folder).toBe(0)
  })
})

describe("SidebarConversationList — Pinned section (migration semantics)", () => {
  beforeEach(() => {
    probes.card = 0
    probes.folder = 0
    const folders = [folder(1, "Folder 1"), folder(2, "Folder 2")]
    store.activeTabId = null
    store.tabSpec = []
    useAppWorkspaceStore.setState({
      folders,
      allFolders: folders,
      conversations: [
        conv(11, 1),
        conv(12, 1, { pinned_at: new Date(FIXED).toISOString() }), // pinned
        conv(21, 2),
      ],
    })
  })

  it("moves a pinned conversation into the Pinned section above Folders, without duplicating it", () => {
    render(tree())
    const text = document.body.textContent ?? ""
    // The Pinned section header exists only because something is pinned, and it
    // sits above the Folders section.
    expect(text).toContain("Pinned")
    expect(text).toContain("Folders")
    const iPinned = text.indexOf("Pinned")
    const iFolders = text.indexOf("Folders")
    const iConv12 = text.indexOf("conv-12") // the pinned conversation
    const iConv11 = text.indexOf("conv-11") // unpinned → stays in its folder
    // conv-12 renders under the Pinned header and above the Folders section…
    expect(iPinned).toBeLessThan(iConv12)
    expect(iConv12).toBeLessThan(iFolders)
    // …while the unpinned conv-11 lives down in the folders section.
    expect(iFolders).toBeLessThan(iConv11)
    // Migration, not duplication: 3 conversations → exactly 3 rendered cards.
    expect(probes.card).toBe(3)
  })

  it("omits the Pinned section entirely when nothing is pinned", () => {
    useAppWorkspaceStore.setState({ conversations: [conv(11, 1), conv(21, 2)] })
    render(tree())
    const text = document.body.textContent ?? ""
    expect(text).not.toContain("Pinned")
    expect(text).toContain("Folders")
  })
})

// jsdom has no PointerEvent and no layout, so the gesture is driven with plain
// bubbling events plus a mocked getBoundingClientRect. This exercises the
// component wiring (threshold → surface gating → commit/abort) that the pure
// index-math unit tests can't reach; real virtua scrolling/autoscroll still
// needs manual QA.
function firePointer(
  target: EventTarget,
  type: string,
  props: {
    clientX?: number
    clientY?: number
    pointerId?: number
    button?: number
  } = {}
) {
  const ev = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(ev, {
    pointerId: 1,
    button: 0,
    clientX: 0,
    clientY: 0,
    ...props,
  })
  target.dispatchEvent(ev)
}

describe("SidebarConversationList — folder drag gesture", () => {
  let rectSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers({ now: FIXED })
    stableWorkspaceFns.applySidebarLayout.mockClear()
    const folders = [folder(1, "F1"), folder(2, "F2"), folder(3, "F3")]
    useAppWorkspaceStore.setState({
      folders,
      allFolders: folders,
      conversations: [conv(11, 1), conv(21, 2), conv(31, 3)],
    })
    store.activeTabId = null
    store.tabSpec = []
    // Fixed geometry: viewport / drag surface anchored at top=0 and tall enough
    // that the test pointer Ys stay clear of the autoscroll edges.
    rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({
        top: 0,
        bottom: 600,
        left: 0,
        right: 200,
        width: 200,
        height: 600,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect)
  })

  afterEach(() => {
    // A committed drag leaves a one-shot capture-phase "click" suppressor on
    // window whose rAF-based removal does not fire under fake timers. Drain it
    // with a throwaway window click (target=window never reaches the React root)
    // so it cannot swallow a later test's click.
    window.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    rectSpy.mockRestore()
    vi.useRealTimers()
  })

  function grip(folderId: number): HTMLElement {
    const button = document.querySelector(`[data-folder-id="${folderId}"]`)
    const el = button?.parentElement
    if (!el) throw new Error(`grip for folder ${folderId} not found`)
    return el
  }

  // Press folder 1, cross the 6px threshold (mounts the collapsed surface), then
  // move to y=40 → slot floor(40/32)=1 (a MIDDLE slot, distinct from the
  // bottom-clamp value the old bug produced), i.e. order [1,2,3] → [2,1,3].
  function dragFolderOneToSlotOne() {
    act(() => firePointer(grip(1), "pointerdown", { clientY: 100 }))
    // Threshold crossing flips into drag mode. The surface is not mounted yet,
    // so this move must NOT retarget (the regression Codex flagged).
    act(() => firePointer(window, "pointermove", { clientY: 120 }))
    // Surface mounted now → retarget to slot 1.
    act(() => firePointer(window, "pointermove", { clientY: 40 }))
  }

  it("commits the reorder to the targeted slot on pointerup", async () => {
    render(tree())
    dragFolderOneToSlotOne()
    await act(async () => {
      firePointer(window, "pointerup", { clientY: 40 })
    })
    expect(stableWorkspaceFns.applySidebarLayout).toHaveBeenCalledTimes(1)
    // A middle slot — not the last — so this can only pass with correct
    // surface-relative targeting, not the old bottom-clamp behavior. The wire
    // format is the full layout: with no groups, three top-level folders.
    expect(stableWorkspaceFns.applySidebarLayout).toHaveBeenCalledWith([
      { kind: "folder", id: 2, groupId: null },
      { kind: "folder", id: 1, groupId: null },
      { kind: "folder", id: 3, groupId: null },
    ])
  })

  it("reconciles the drop against a folder closed after the last pointer move", async () => {
    render(tree())
    dragFolderOneToSlotOne()
    // Another window removes folder 3 from the workspace in the window between
    // the last pointermove and the release. The RENDERED layout reconciles on
    // every render, but the drop persists a snapshot taken at that last move —
    // and `apply_sidebar_layout` is authoritative for every row it names, so
    // writing the pre-removal view would silently undo the other window's
    // change. The user's own move must still survive the reconcile.
    act(() => {
      const folders = [folder(1, "F1"), folder(2, "F2")]
      useAppWorkspaceStore.setState({ folders, allFolders: folders })
    })
    await act(async () => {
      firePointer(window, "pointerup", { clientY: 40 })
    })
    expect(stableWorkspaceFns.applySidebarLayout).toHaveBeenCalledWith([
      { kind: "folder", id: 2, groupId: null },
      { kind: "folder", id: 1, groupId: null },
    ])
  })

  it("does not reorder when released right after crossing the threshold (before the surface can retarget)", async () => {
    render(tree())
    act(() => firePointer(grip(1), "pointerdown", { clientY: 100 }))
    // Cross the threshold from a 'scrolled' position, then release immediately.
    // The collapsed surface mounts only after this move, so there is no valid
    // target yet — the old viewport-fallback would have bottom-clamped here.
    act(() => firePointer(window, "pointermove", { clientY: 200 }))
    await act(async () => {
      firePointer(window, "pointerup", { clientY: 200 })
    })
    expect(stableWorkspaceFns.applySidebarLayout).not.toHaveBeenCalled()
  })

  it("aborts without persisting on pointercancel", () => {
    render(tree())
    dragFolderOneToSlotOne()
    act(() => firePointer(window, "pointercancel", { clientY: 40 }))
    expect(stableWorkspaceFns.applySidebarLayout).not.toHaveBeenCalled()
  })

  it("aborts without persisting on Escape", () => {
    render(tree())
    dragFolderOneToSlotOne()
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      )
    })
    expect(stableWorkspaceFns.applySidebarLayout).not.toHaveBeenCalled()
  })

  it("does nothing when the press never crosses the drag threshold", async () => {
    render(tree())
    act(() => firePointer(grip(1), "pointerdown", { clientY: 100 }))
    act(() => firePointer(window, "pointermove", { clientY: 103 })) // 3px < 6px
    await act(async () => {
      firePointer(window, "pointerup", { clientY: 103 })
    })
    expect(stableWorkspaceFns.applySidebarLayout).not.toHaveBeenCalled()
  })
})

// Drives the sticky overlay via the controllable virtua handle. The overlay is
// resolved from the layout effect at mount (no scroll event needed): set
// virtuaCtl.scrollOffset before render and assert the duplicated header. Real
// virtua scrolling / handoff smoothness still needs manual QA.
describe("SidebarConversationList — sticky folder header overlay", () => {
  beforeEach(() => {
    localStorage.clear() // folderExpanded persists across tests otherwise
    const folders = [folder(1, "Folder 1"), folder(2, "Folder 2")]
    // rows: F1(0) c11(1) c12(2) F2(3) c21(4) c22(5) c23(6)
    useAppWorkspaceStore.setState({
      folders,
      allFolders: folders,
      conversations: [
        conv(11, 1),
        conv(12, 1),
        conv(21, 2),
        conv(22, 2),
        conv(23, 2),
      ],
    })
    store.activeTabId = null
    store.tabSpec = []
  })

  function headerCount(folderId: number): number {
    return document.querySelectorAll(`[data-folder-id="${folderId}"]`).length
  }

  it("hides the overlay at the top of the list", () => {
    virtuaCtl.scrollOffset = 0
    render(tree())
    // Only the real in-list header exists for each folder.
    expect(headerCount(1)).toBe(1)
    expect(headerCount(2)).toBe(1)
  })

  it("shows a sticky overlay for the folder scrolled through", () => {
    virtuaCtl.scrollOffset = 40 // past F1's header (offset 0), inside conv 11
    render(tree())
    // Folder 1 header is duplicated in the DOM (in-list + overlay); folder 2 is
    // not.
    expect(headerCount(1)).toBe(2)
    expect(headerCount(2)).toBe(1)
    // Only one of the two is accessible: the in-list copy is suppressed
    // (inert + aria-hidden) so the overlay is the sole tab stop / announcement.
    const f1 = document.querySelectorAll('[data-folder-id="1"]')
    expect(
      (f1[0] as HTMLElement).closest('[aria-hidden="true"]')
    ).not.toBeNull()
    expect((f1[1] as HTMLElement).closest('[aria-hidden="true"]')).toBeNull()
    // The accessible (overlay) toggle exposes its expanded state to AT.
    expect((f1[1] as HTMLElement).getAttribute("aria-expanded")).toBe("true")
  })

  it("tracks the active folder as the scroll moves into the next folder", () => {
    virtuaCtl.scrollOffset = 130 // inside folder 2 (F2 header at offset 96)
    render(tree())
    expect(headerCount(1)).toBe(1)
    expect(headerCount(2)).toBe(2)
  })

  it("collapses from the overlay and scrolls the folder header to the top", () => {
    // rAF runs synchronously so the deferred scrollToIndex is observable.
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0)
      return 0
    })
    try {
      virtuaCtl.scrollOffset = 130 // overlay shows folder 2
      render(tree())
      const headers = document.querySelectorAll('[data-folder-id="2"]')
      expect(headers.length).toBe(2)
      // headers[1] is the overlay copy (rendered after ScrollArea in DOM order).
      act(() => {
        fireEvent.click(headers[1] as HTMLElement)
      })
      // The folder collapsed (its conversation rows are gone).
      expect(document.body.textContent).not.toContain("conv-21")
      // The "Folders" section header occupies flat index 0, so folder 2's header
      // is flat index 4 → scrolled to the top, instant.
      expect(virtuaCtl.scrollToIndex).toHaveBeenCalledWith(
        4,
        expect.objectContaining({ align: "start" })
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("hides the overlay while a folder drag is in progress", () => {
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({
        top: 0,
        bottom: 600,
        left: 0,
        right: 200,
        width: 200,
        height: 600,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect)
    try {
      virtuaCtl.scrollOffset = 40 // overlay shows folder 1
      render(tree())
      expect(headerCount(1)).toBe(2) // suppressed in-list + overlay
      // Drag a NON-sticky folder (folder 2) from its in-list header — folder 1's
      // in-list header is inert while its overlay is showing, and the overlay
      // itself has no drag grip.
      const grip = (
        document.querySelector('[data-folder-id="2"]') as HTMLElement
      ).parentElement as HTMLElement
      act(() => firePointer(grip, "pointerdown", { clientY: 100 }))
      act(() => firePointer(window, "pointermove", { clientY: 120 })) // cross 6px
      // Virtualizer unmounted → drag surface shows each folder once, overlay gone.
      expect(headerCount(1)).toBe(1)
      act(() => firePointer(window, "pointercancel", { clientY: 120 }))
    } finally {
      rectSpy.mockRestore()
    }
  })
})

describe("SidebarConversationList — scrollToActive across a worktree merge", () => {
  const EXPANDED_KEY = "workspace:sidebar-folder-expanded"

  beforeEach(() => {
    // Root folder 1 + worktree child folder 2 (parent_id = 1), one conversation
    // in each. Select the worktree conversation via the active tab.
    const folders = [folder(1, "Root"), folder(2, "Worktree", 1)]
    useAppWorkspaceStore.setState({
      folders,
      allFolders: folders,
      conversations: [conv(11, 1), conv(21, 2)],
    })
    store.activeTabId = "tab-21"
    store.tabSpec = [
      {
        id: "tab-21",
        conversationId: 21,
        agentType: "claude_code",
        folderId: 2,
        title: "conv-21",
        isPinned: false,
      },
    ]
    // Collapse the parent (root) group so the merged worktree row is initially
    // absent from the flat model.
    localStorage.setItem(EXPANDED_KEY, JSON.stringify({ 1: false }))
  })

  afterEach(() => {
    localStorage.removeItem(EXPANDED_KEY)
  })

  it("expands the parent group to reveal and scroll to a merged worktree conversation", () => {
    const ref = createRef<SidebarConversationListHandle>()
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <SidebarConversationList showCompleted sortMode="created" ref={ref} />
      </NextIntlClientProvider>
    )

    // Parent collapsed → the worktree row is not in the flat model, so no scroll
    // can resolve yet.
    expect(virtuaCtl.scrollToIndex).not.toHaveBeenCalled()

    act(() => {
      ref.current?.scrollToActive()
    })

    // The fix resolves the *display group* (parent folder 1), expands it, and the
    // deferred scroll then finds the worktree row. Pre-fix this stayed at 0
    // because it checked/expanded the child folder id (2) — never a rendered
    // group — so the row never entered the flat model.
    expect(virtuaCtl.scrollToIndex).toHaveBeenCalled()
  })
})

describe("SidebarConversationList — folder ⋯ opens the same menu as right-click", () => {
  beforeEach(() => {
    probes.card = 0
    probes.folder = 0
    const folders = [folder(1, "Folder 1")]
    useAppWorkspaceStore.setState({
      folders,
      allFolders: folders,
      conversations: [conv(11, 1)],
    })
    store.activeTabId = null
    store.tabSpec = []
  })

  it("opens the folder context menu via the ⋯ button — no right-click needed", () => {
    render(tree())
    // Closed: Radix mounts the menu content lazily, so its items aren't present.
    expect(document.body.textContent).not.toContain("Manage conversations")

    // The ⋯ button dispatches a synthetic `contextmenu` event that bubbles to the
    // same <ContextMenuTrigger> the right-click uses — single source of truth.
    const moreBtn = document.querySelector('[aria-label="More options"]')
    expect(moreBtn).not.toBeNull()
    act(() => {
      fireEvent.click(moreBtn as HTMLElement)
    })

    // The identical menu is now open — assert a label unique to the folder menu.
    expect(document.body.textContent).toContain("Manage conversations")
  })
})

describe("SidebarConversationList — worktree grouping (Show worktrees)", () => {
  // A repo (folder 1) with two conversations, plus a worktree child (folder 2,
  // branch "feature-x") holding one conversation.
  const wtHarness: { rerender: () => void } = { rerender: () => {} }
  function WtHarness({ showWorktrees }: { showWorktrees: boolean }) {
    const [, setTick] = useState(0)
    useEffect(() => {
      wtHarness.rerender = () => setTick((n) => n + 1)
    }, [])
    return (
      <SidebarConversationList
        showCompleted
        showWorktrees={showWorktrees}
        sortMode="created"
      />
    )
  }
  function wtTree(showWorktrees: boolean) {
    return (
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <WtHarness showWorktrees={showWorktrees} />
      </NextIntlClientProvider>
    )
  }

  function folderHeaderIds(): number[] {
    return Array.from(document.querySelectorAll("[data-folder-id]")).map((el) =>
      Number(el.getAttribute("data-folder-id"))
    )
  }

  beforeEach(() => {
    probes.card = 0
    probes.folder = 0
    probes.root = 0
    const wt = {
      ...folder(2, "wt-feature", 1),
      git_branch: "feature-x",
    } as unknown as FolderDetail
    const folders = [folder(1, "Repo"), wt]
    store.activeTabId = null
    store.tabSpec = []
    useAppWorkspaceStore.setState({
      folders,
      allFolders: folders,
      conversations: [conv(11, 1), conv(12, 1), conv(21, 2)],
      // The container's live HEAD, which labels its "root" sub-group. `gitHeads`
      // has to be seeded too: it — not `branches` — is what makes the list's
      // `ensureGitHead` call short-circuit, and without it every render here
      // would fire a real transport read.
      branches: new Map([[1, "main"]]),
      gitHeads: new Map([
        [
          1,
          {
            is_repo: true,
            branch: "main",
            detached: false,
            short_sha: "abc1234",
          },
        ],
      ]),
    })
  })

  it("merges worktree conversations flat under the parent when off", () => {
    render(wtTree(false))
    // Only the repo gets a header; the worktree child is hidden and its
    // conversation is merged into the repo bucket — no container/root split.
    expect(folderHeaderIds()).toEqual([1])
    const text = document.body.textContent ?? ""
    expect(text).toContain("conv-11")
    expect(text).toContain("conv-12")
    expect(text).toContain("conv-21")
    // No worktree header → no branch label; no root sub-group (probes.root===0,
    // the unambiguous check — the "root" label is a generic word to match on).
    expect(text).not.toContain("feature-x")
    expect(probes.root).toBe(0)
  })

  it("splits the repo into a container + root sub-group + worktree sub-group when on", () => {
    render(wtTree(true))
    // Container header (repo id 1) → root sub-group header (also repo id 1, its
    // own sessions) → worktree header (id 2). The repo id appears twice: the
    // container and its root sub-group both carry it.
    expect(folderHeaderIds()).toEqual([1, 1, 2])
    const text = document.body.textContent ?? ""
    // Order: container "Repo" → "root" sub-group + its own convs → worktree
    // branch "feature-x" + the worktree's conv.
    const iRoot = text.indexOf("root")
    const iRepoConv = text.indexOf("conv-11")
    const iBranch = text.indexOf("feature-x")
    const iWtConv = text.indexOf("conv-21")
    expect(iRoot).toBeGreaterThanOrEqual(0)
    expect(iRepoConv).toBeGreaterThan(iRoot)
    expect(iBranch).toBeGreaterThan(iRepoConv)
    expect(iWtConv).toBeGreaterThan(iBranch)
    // Exactly one container header (FolderOpen) + one root sub-group (FolderRoot).
    expect(probes.folder).toBe(1)
    expect(probes.root).toBe(1)
  })

  it("labels the root sub-group with the container's live branch", () => {
    render(wtTree(true))
    // The main worktree's branch, in the same `branch [ name ]` shape the
    // worktree sibling below it uses — so the subtree reads as one column of
    // branches rather than one anonymous "root" above a list of them.
    expect(document.body.textContent).toContain("main [ root ]")
  })

  it("falls back to a bare 'root' when the container's HEAD is unknown", () => {
    // Detached HEAD, a non-repo, or simply not resolved yet. The label degrades
    // to the plain word rather than rendering empty brackets.
    useAppWorkspaceStore.setState({
      branches: new Map([[1, null]]),
      gitHeads: new Map([
        [1, { is_repo: true, branch: null, detached: true, short_sha: "abc" }],
      ]),
    })
    render(wtTree(true))
    const text = document.body.textContent ?? ""
    expect(text).not.toContain("[ root ]")
    // Still present as its own sub-group — this is a label fallback, not a
    // missing row (the glyph probe is the unambiguous check).
    expect(probes.root).toBe(1)
  })

  it("collapsing the root sub-group hides the repo's own sessions but keeps the worktree", () => {
    render(wtTree(true))
    expect(document.body.textContent).toContain("conv-11")

    // Toggle the root sub-group header (the SECOND data-folder-id=1 button, after
    // the container). Its own sessions collapse; the worktree stays visible.
    const repoHeaders = document.querySelectorAll('[data-folder-id="1"]')
    expect(repoHeaders).toHaveLength(2)
    act(() => {
      fireEvent.click(repoHeaders[1] as HTMLElement)
    })

    const text = document.body.textContent ?? ""
    expect(text).not.toContain("conv-11")
    expect(text).not.toContain("conv-12")
    // The worktree sub-group is untouched.
    expect(text).toContain("feature-x")
    expect(text).toContain("conv-21")
  })

  it("labels a worktree sub-group `branch [ directory ]`", () => {
    // What a worktree registered through `open_worktree_folder_core` looks like:
    // the alias was seeded with the branch it was created on. `git_branch` on the
    // folder row is never written by the folder flow, so without the alias every
    // worktree fell back to its (long, derived) directory name alone.
    const cur = useAppWorkspaceStore.getState()
    const aliased = cur.allFolders.map((f) =>
      f.id === 2
        ? ({
            ...f,
            git_branch: null,
            alias: "feature-x",
          } as unknown as FolderDetail)
        : f
    )
    useAppWorkspaceStore.setState({ folders: aliased, allFolders: aliased })
    render(wtTree(true))

    // Same two-part label a repo header renders: what the worktree IS in front,
    // where it lives on disk bracketed behind it.
    expect(document.body.textContent ?? "").toContain(
      "feature-x [ wt-feature ]"
    )
  })

  it("leaves a worktree with no branch or alias on its bare directory name", () => {
    const cur = useAppWorkspaceStore.getState()
    const bare = cur.allFolders.map((f) =>
      f.id === 2
        ? ({ ...f, git_branch: null, alias: null } as unknown as FolderDetail)
        : f
    )
    useAppWorkspaceStore.setState({ folders: bare, allFolders: bare })
    render(wtTree(true))

    const text = document.body.textContent ?? ""
    expect(text).toContain("wt-feature")
    // No alias to lead with, so no empty brackets trailing the name either.
    expect(text).not.toContain("[ wt-feature ]")
  })

  it("keeps the connector spine continuous through an empty worktree sub-group", () => {
    // Add a second worktree (folder 3) with NO conversations → it renders the
    // empty-folder hint. That empty row must still draw the container spine
    // (ancestor rail) so the vertical connector doesn't break at "no
    // conversations".
    const wtEmpty = {
      ...folder(3, "wt-empty", 1),
      git_branch: "feature-y",
    } as unknown as FolderDetail
    const cur = useAppWorkspaceStore.getState()
    useAppWorkspaceStore.setState({
      folders: [...cur.folders, wtEmpty],
      allFolders: [...cur.allFolders, wtEmpty],
    })
    render(wtTree(true))

    const hint = enMessages.Folder.sidebar.emptyFolderHint
    const hintSpan = Array.from(document.querySelectorAll("span")).find(
      (s) => s.textContent === hint
    )
    expect(hintSpan).toBeTruthy()
    // The empty row (the hint span's row container) carries an ancestor rail.
    const row = hintSpan!.closest("div")
    expect(row?.querySelector("[data-subsession-rail]")).not.toBeNull()
  })

  it("keeps the single-status-event budget (1 card, 0 headers) with worktrees on", () => {
    render(wtTree(true))
    // Initial mount: all three conversations render a card.
    expect(probes.card).toBe(3)

    // Replace exactly the worktree's conversation (conv 21) with a new object;
    // every other summary keeps its identity (mirrors updateConversationLocal).
    const prev = useAppWorkspaceStore.getState().conversations
    const next = prev.slice()
    const idx = next.findIndex((c) => c.id === 21)
    next[idx] = { ...next[idx], status: "completed" }

    probes.card = 0
    probes.folder = 0
    probes.root = 0
    act(() => {
      useAppWorkspaceStore.setState({ conversations: next })
    })
    act(() => wtHarness.rerender())

    // Only the changed card re-renders; the container header AND the root
    // sub-group header (both keyed off `folders`, unchanged by a status event)
    // bail out, so the container split costs nothing extra per event. (The
    // worktree header shares the same memo + folder-derived props, so 0 root/
    // folder re-renders is sufficient evidence it bails too.)
    expect(probes.card).toBe(1)
    expect(probes.folder).toBe(0)
    expect(probes.root).toBe(0)
  })
})

describe("SidebarConversationList — Recent section", () => {
  function recentTree(showRecent: boolean) {
    return (
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <SidebarConversationList
          showCompleted
          showRecent={showRecent}
          sortMode="created"
        />
      </NextIntlClientProvider>
    )
  }

  const RECENT = enMessages.Folder.sidebar.sectionRecent

  beforeEach(() => {
    probes.card = 0
    const folders = [folder(1, "Repo")]
    store.activeTabId = null
    store.tabSpec = []
    useAppWorkspaceStore.setState({
      folders,
      allFolders: folders,
      conversations: [
        conv(11, 1),
        // A folderless chat-mode conversation and a conversation whose folder
        // is NOT open — Recent must take the first and drop the second.
        conv(12, 99, { kind: "chat" }),
        conv(13, 42),
      ],
    })
  })

  it("renders nothing for the section when showRecent is off", () => {
    render(recentTree(false))
    expect(document.body.textContent).not.toContain(RECENT)
    // Each conversation renders exactly one card (no Recent duplicates).
    expect(probes.card).toBe(2)
  })

  it("lists folder and chat conversations together, without duplicate React keys", () => {
    // A duplicated key would make React drop one of the two rows and log an
    // error; assert on the console as well as the card count.
    const errors: unknown[][] = []
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        errors.push(args)
      })
    try {
      render(recentTree(true))
      // 2 reachable conversations × (canonical row + Recent row) = 4 cards.
      expect(probes.card).toBe(4)
      expect(errors).toEqual([])
    } finally {
      spy.mockRestore()
    }

    expect(document.body.textContent).toContain(RECENT)
    // conv-13 lives in a folder that is not open, so it is unreachable in the
    // Folders section and must stay out of Recent too.
    expect(document.body.textContent).not.toContain("conv-13")
  })

  it("collapses independently of the other sections", () => {
    render(recentTree(true))
    const header = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent === RECENT
    )
    expect(header).toBeTruthy()
    act(() => {
      fireEvent.click(header!)
    })
    // Its rows are gone; the Folders section's copies remain.
    expect(probes.card).toBe(4)
    expect(document.body.textContent).toContain("conv-11")
    expect(
      Array.from(document.querySelectorAll("[data-conversation-id]"))
    ).toHaveLength(2)
  })

  describe("paging", () => {
    // `recentLimit` starts at RECENT_PAGE_SIZE and only ever grew, so a list
    // expanded a few pages deep stayed that way for the rest of the session.
    // These cover the way back out.
    const PAGE = 15
    const TOTAL = PAGE + 4

    // Recent duplicates every canonical row, so total cards = canonical + recent
    // slice. Counting the Recent slice alone keeps the assertions readable.
    const recentRowCount = () =>
      Array.from(document.querySelectorAll("[data-conversation-id]")).length -
      TOTAL

    const buttonWithText = (text: string) =>
      Array.from(document.querySelectorAll("button")).find((b) =>
        b.textContent?.includes(text)
      )
    const resetButton = () =>
      Array.from(document.querySelectorAll("button")).find(
        (b) => b.getAttribute("aria-label") === resetLabel
      )

    const showMoreLabel = (count: number) =>
      enMessages.Folder.sidebar.showMoreRecent.replace("{count}", String(count))
    const resetLabel = enMessages.Folder.sidebar.resetRecentLimit.replace(
      "{count}",
      String(PAGE)
    )

    beforeEach(() => {
      // The collapse test above persists `{recent: true}` into
      // `workspace:sidebar-section-collapsed`, and the list hydrates from it —
      // leave it and this whole section renders collapsed (zero rows).
      localStorage.clear()
      const folders = [folder(1, "Repo")]
      useAppWorkspaceStore.setState({
        folders,
        allFolders: folders,
        conversations: Array.from({ length: TOTAL }, (_, i) => conv(i + 1, 1)),
      })
    })

    it("folds a multi-page list back to the first page", () => {
      render(recentTree(true))
      expect(recentRowCount()).toBe(PAGE)
      // No reset on an untouched first page — there is nothing to fold back.
      expect(resetButton()).toBeUndefined()

      act(() => {
        fireEvent.click(buttonWithText(showMoreLabel(TOTAL - PAGE))!)
      })
      expect(recentRowCount()).toBe(TOTAL)

      // Everything is out, so the footer survives as a reset-only row: the
      // "show more" label is gone but the row itself is still the way back.
      expect(buttonWithText(showMoreLabel(0))).toBeUndefined()
      act(() => {
        fireEvent.click(buttonWithText(resetLabel)!)
      })
      expect(recentRowCount()).toBe(PAGE)
    })

    it("offers the reset at the row's right edge while pages remain", () => {
      // 3 pages' worth, so one "show more" click still leaves a remainder and
      // the footer keeps both affordances at once.
      const conversations = Array.from({ length: PAGE * 3 }, (_, i) =>
        conv(i + 1, 1)
      )
      useAppWorkspaceStore.setState({ conversations })
      render(recentTree(true))

      act(() => {
        fireEvent.click(buttonWithText(showMoreLabel(PAGE * 2))!)
      })
      const recentRows = () =>
        Array.from(document.querySelectorAll("[data-conversation-id]")).length -
        conversations.length
      expect(recentRows()).toBe(PAGE * 2)
      // Still more to reveal…
      expect(buttonWithText(showMoreLabel(PAGE))).toBeDefined()
      // …and the icon-only reset is a SIBLING of the row button, not nested
      // (buttons cannot nest) — so it is reachable on its own.
      const reset = resetButton()
      expect(reset).toBeDefined()
      expect(reset!.querySelector("button")).toBeNull()

      act(() => {
        fireEvent.click(reset!)
      })
      expect(recentRows()).toBe(PAGE)
    })

    it("keeps keyboard focus on the footer through a reset", () => {
      // The icon reset unmounts itself on activation, so without an explicit
      // hand-off focus falls to <body> — a keyboard user lands back at the top
      // of the document. Covers both variants: the icon (which disappears) and
      // the reset-only row (whose button survives as "show more").
      useAppWorkspaceStore.setState({
        conversations: Array.from({ length: PAGE * 3 }, (_, i) =>
          conv(i + 1, 1)
        ),
      })
      render(recentTree(true))
      act(() => {
        fireEvent.click(buttonWithText(showMoreLabel(PAGE * 2))!)
      })

      const icon = resetButton()!
      act(() => {
        icon.focus()
        fireEvent.click(icon)
      })
      expect(document.activeElement).not.toBe(document.body)
      const footer = buttonWithText(showMoreLabel(PAGE * 2))!
      expect(document.activeElement).toBe(footer)

      // Now the reset-only variant: reveal everything, then reset from the row.
      act(() => {
        fireEvent.click(buttonWithText(showMoreLabel(PAGE * 2))!)
      })
      act(() => {
        fireEvent.click(buttonWithText(showMoreLabel(PAGE))!)
      })
      const rowReset = buttonWithText(resetLabel)!
      act(() => {
        rowReset.focus()
        fireEvent.click(rowReset)
      })
      expect(document.activeElement).not.toBe(document.body)
      expect(document.activeElement).toBe(
        buttonWithText(showMoreLabel(PAGE * 2))
      )
    })
  })

  describe("kind filter", () => {
    const FILTER_KEY = "workspace:sidebar-recent-filter"
    const { noRecent, noRecentChats, noRecentFolders } =
      enMessages.Folder.sidebar

    // Cards rendered for one conversation: its canonical row (Folders or
    // Chat), plus a second one while Recent lists it too.
    const cardsFor = (id: number) =>
      document.querySelectorAll(`[data-conversation-id="${id}"]`).length

    // Radix arms its outside-pointer listener in a `setTimeout(0)` and jsdom has
    // no `PointerEvent`, so drive the header menu with real `MouseEvent`s under
    // the pointer-event names (same recipe as sidebar-section-header.test.tsx).
    async function settle() {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }
    function press(target: Element) {
      for (const type of ["pointerdown", "pointerup", "click"]) {
        fireEvent(
          target,
          new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 })
        )
      }
    }
    // Open the header menu from the trigger carrying `triggerLabel` and pick
    // the option whose text is `option`.
    async function pick(triggerLabel: string, option: string) {
      await settle()
      press(document.querySelector(`[aria-label="${triggerLabel}"]`)!)
      await settle()
      const item = Array.from(
        document.querySelectorAll('[role="menuitemradio"]')
      ).find((el) => el.textContent === option)
      expect(item).toBeDefined()
      press(item!)
    }

    beforeEach(() => {
      // The collapse test above persists `{recent: true}`; left in place the
      // section renders collapsed, with no rows for a filter to narrow.
      localStorage.clear()
    })

    afterEach(() => {
      // The describes after this one reset only the storage keys they use, so
      // a filter left behind would quietly narrow Recent in all of them.
      localStorage.removeItem(FILTER_KEY)
    })

    it("restores the persisted filter on mount", () => {
      localStorage.setItem(FILTER_KEY, "chats")
      render(recentTree(true))
      // conv-12 (chat) stays in Recent; conv-11 (folder) keeps only its
      // Folders row.
      expect(cardsFor(12)).toBe(2)
      expect(cardsFor(11)).toBe(1)
    })

    it.each([
      // Only a folder conversation left, so "chats" empties Recent…
      { filter: "chats", only: conv(11, 1), hint: noRecentChats },
      // …and only a chat, so "folders" does.
      {
        filter: "folders",
        only: conv(12, 99, { kind: "chat" }),
        hint: noRecentFolders,
      },
    ])(
      "names the $filter filter when it narrows Recent to nothing",
      ({ filter, only, hint }) => {
        localStorage.setItem(FILTER_KEY, filter)
        useAppWorkspaceStore.setState({ conversations: [only] })
        render(recentTree(true))
        const text = document.body.textContent
        expect(text).toContain(hint)
        // Exactly one hint: neither the other filter's nor the unfiltered one.
        for (const other of [noRecent, noRecentChats, noRecentFolders]) {
          if (other !== hint) expect(text).not.toContain(other)
        }
      }
    )

    it("applies, persists and undoes a pick from the header menu", async () => {
      render(recentTree(true))
      expect(cardsFor(11)).toBe(2)
      expect(cardsFor(12)).toBe(2)

      await pick("Show in Recent: All", "Folders")
      expect(localStorage.getItem(FILTER_KEY)).toBe("folders")
      expect(cardsFor(11)).toBe(2)
      expect(cardsFor(12)).toBe(1)

      // Back to All from the (now relabelled) trigger: both kinds return.
      await pick("Show in Recent: Folders", "All")
      expect(localStorage.getItem(FILTER_KEY)).toBe("all")
      expect(cardsFor(11)).toBe(2)
      expect(cardsFor(12)).toBe(2)
    })
  })
})

describe("SidebarConversationList — expand / collapse all", () => {
  const SECTION_COLLAPSED_KEY = "workspace:sidebar-section-collapsed"
  const FOLDER_EXPANDED_KEY = "workspace:sidebar-folder-expanded"
  const { sectionPinned, sectionFolders, sectionChats, sectionRecent } =
    enMessages.Folder.sidebar
  const ALL_SECTIONS = [
    sectionPinned,
    sectionFolders,
    sectionChats,
    sectionRecent,
  ]

  // The section header's toggle carries the state under test; its textContent is
  // exactly the label (the chevron is an svg).
  const sectionHeader = (label: string) =>
    Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent === label
    )
  const expandedOf = (label: string) =>
    sectionHeader(label)?.getAttribute("aria-expanded")

  function renderList() {
    const ref = createRef<SidebarConversationListHandle>()
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <SidebarConversationList
          showCompleted
          showRecent
          sortMode="created"
          ref={ref}
        />
      </NextIntlClientProvider>
    )
    return ref
  }

  beforeEach(() => {
    localStorage.removeItem(SECTION_COLLAPSED_KEY)
    localStorage.removeItem(FOLDER_EXPANDED_KEY)
    const folders = [folder(1, "Repo")]
    store.activeTabId = null
    store.tabSpec = []
    useAppWorkspaceStore.setState({
      folders,
      allFolders: folders,
      conversations: [
        // conv-11 is folder-bound (Folders + Recent), conv-12 is folderless
        // chat mode (Chat + Recent only), conv-14 is pinned (Pinned only).
        conv(11, 1),
        conv(12, 99, { kind: "chat" }),
        conv(14, 1, { pinned_at: new Date(FIXED).toISOString() }),
      ],
    })
  })

  afterEach(() => {
    localStorage.removeItem(SECTION_COLLAPSED_KEY)
    localStorage.removeItem(FOLDER_EXPANDED_KEY)
  })

  it("closes all four section headers, not just the folder groups", () => {
    const ref = renderList()
    for (const label of ALL_SECTIONS) expect(expandedOf(label)).toBe("true")

    act(() => ref.current?.collapseAll())

    for (const label of ALL_SECTIONS) expect(expandedOf(label)).toBe("false")
    // Not just the header state — every row is actually gone. The three
    // conversations cover the three ways a row can reach the list: conv-11 via
    // a folder group, conv-12 (folderless chat mode) via Chat + Recent, conv-14
    // via Pinned. What is left is four headers and nothing under them.
    for (const title of ["conv-11", "conv-12", "conv-14"])
      expect(document.body.textContent).not.toContain(title)
    expect(document.querySelectorAll("[data-conversation-id]")).toHaveLength(0)
    expect(
      JSON.parse(localStorage.getItem(SECTION_COLLAPSED_KEY) ?? "{}")
    ).toMatchObject({ pinned: true, folders: true, chats: true, recent: true })
  })

  it("re-opens every section AND the folder groups under them on expandAll", () => {
    const ref = renderList()
    act(() => ref.current?.collapseAll())
    act(() => ref.current?.expandAll())

    for (const label of ALL_SECTIONS) expect(expandedOf(label)).toBe("true")
    // Section collapse and per-folder collapse are stored separately, so
    // re-opening "Folders" is not enough on its own — conv-11 is only back if
    // its folder group was restored too.
    for (const title of ["conv-11", "conv-12", "conv-14"])
      expect(document.body.textContent).toContain(title)
    expect(
      JSON.parse(localStorage.getItem(SECTION_COLLAPSED_KEY) ?? "{}")
    ).toMatchObject({
      pinned: false,
      folders: false,
      chats: false,
      recent: false,
    })
  })

  it("is idempotent — a second collapseAll writes nothing new", () => {
    const ref = renderList()
    act(() => ref.current?.collapseAll())
    const afterFirst = localStorage.getItem(SECTION_COLLAPSED_KEY)

    act(() => ref.current?.collapseAll())

    expect(localStorage.getItem(SECTION_COLLAPSED_KEY)).toBe(afterFirst)
    for (const label of ALL_SECTIONS) expect(expandedOf(label)).toBe("false")
  })
})

describe("SidebarConversationList — folder groups", () => {
  function group(
    id: number,
    name: string,
    sortOrder: number,
    color = "inherit"
  ) {
    return { id, name, color, sort_order: sortOrder }
  }

  beforeEach(() => {
    vi.useFakeTimers({ now: FIXED })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("renders a group heading and nests its member folder under it", () => {
    // sort_order 1/2/3 across the shared top-level space: loose folder, then
    // the group, then another loose folder — the interleaving the feature is for.
    const folders = [
      { ...folder(1, "Loose A"), sort_order: 1, group_id: null },
      { ...folder(5, "Member"), sort_order: 1, group_id: 7 },
      { ...folder(9, "Loose B"), sort_order: 3, group_id: null },
    ] as FolderDetail[]
    useAppWorkspaceStore.setState({
      folders,
      allFolders: folders,
      folderGroups: [group(7, "Work", 2)],
      conversations: [],
    })
    const { getByText, container } = render(tree())

    expect(getByText("Work")).not.toBeNull()
    // Rendered order follows the shared sort_order space, not "groups last".
    const labels = Array.from(
      container.querySelectorAll("[data-folder-id], [data-folder-group-id]")
    ).map((el) =>
      el.getAttribute("data-folder-group-id")
        ? `group:${el.getAttribute("data-folder-group-id")}`
        : `folder:${el.getAttribute("data-folder-id")}`
    )
    expect(labels).toEqual(["folder:1", "group:7", "folder:5", "folder:9"])
  })

  it("shows the empty hint for a group with no folders", () => {
    useAppWorkspaceStore.setState({
      folders: [],
      allFolders: [],
      folderGroups: [group(7, "Work", 1)],
      conversations: [conv(11, 1)],
    })
    const { getByText } = render(tree())
    // A freshly created group is empty and must still render something to
    // drag into.
    expect(getByText("No folders in this group")).not.toBeNull()
  })

  it("collapsing a group hides its members and persists the state", () => {
    const folders = [
      { ...folder(5, "Member"), sort_order: 1, group_id: 7 },
    ] as FolderDetail[]
    useAppWorkspaceStore.setState({
      folders,
      allFolders: folders,
      folderGroups: [group(7, "Work", 1)],
      conversations: [],
    })
    const { container, getByText } = render(tree())
    expect(container.querySelector('[data-folder-id="5"]')).not.toBeNull()

    act(() => {
      fireEvent.click(getByText("Work"))
    })
    expect(container.querySelector('[data-folder-id="5"]')).toBeNull()
    expect(
      JSON.parse(
        localStorage.getItem("workspace:sidebar-folder-group-expanded") ?? "{}"
      )
    ).toEqual({ 7: false })
  })

  // The heading's badge counts RUNNING sessions across the whole group (the
  // folder header's badge, one level up) — not how many folders it holds.
  function groupWith(
    members: number[],
    conversations: DbConversationSummary[],
    groupColor = "inherit"
  ) {
    // The collapse test above persists `{7: false}` and nothing clears
    // localStorage between tests, so a group seeded here would start collapsed
    // (members hidden) purely because of test order.
    localStorage.removeItem("workspace:sidebar-folder-group-expanded")
    const folders = members.map(
      (id, i) =>
        ({
          ...folder(id, `Member ${id}`),
          sort_order: i + 1,
          group_id: 7,
        }) as FolderDetail
    )
    useAppWorkspaceStore.setState({
      folders,
      allFolders: folders,
      folderGroups: [group(7, "Work", 1, groupColor)],
      conversations,
    })
  }

  it("badges the group with the running sessions of ALL its folders", () => {
    groupWith(
      [5, 6],
      [
        conv(11, 5, { status: "in_progress" }),
        conv(12, 5, { status: "done" }),
        conv(13, 6, { status: "in_progress" }),
      ]
    )
    const { container } = render(tree())

    const heading = container.querySelector('[data-folder-group-id="7"]')
    expect(heading?.textContent).toContain("2")
    // Same label the folder headers use, so the two badges read as one signal.
    expect(
      heading?.querySelector('[title="2 sessions running"]')
    ).not.toBeNull()
  })

  it("renders no group badge when nothing in it is running", () => {
    groupWith([5], [conv(11, 5, { status: "done" })])
    const { container } = render(tree())

    const heading = container.querySelector('[data-folder-group-id="7"]')
    expect(heading?.textContent).toBe("Work")
  })

  // A folder / group colour is a label for the ROW, not a skin for the sessions
  // under it: the list must not wrap anything in a `data-theme` scope any more.
  it("never re-themes conversation cards with the folder colour", () => {
    groupWith([5], [conv(11, 5)])
    const { container } = render(tree())

    expect(container.querySelector("[data-conversation-id]")).not.toBeNull()
    expect(container.querySelectorAll("[data-theme]")).toHaveLength(0)
  })

  // The colour lands on the title text of both row kinds, through the same
  // mechanism, so a group and a folder tint identically.
  it("tints the group and folder titles with the chosen colour", () => {
    groupWith([5], [], "red")
    const { getByText } = render(tree())

    // `folder()` seeds every folder as "blue".
    for (const title of [getByText("Member 5"), getByText("Work")]) {
      expect(title.className).toContain("folder-title-tint")
      expect(title.className).not.toContain("text-sidebar-foreground/")
      const style = title.getAttribute("style") ?? ""
      expect(style).toContain("--folder-title-light")
      expect(style).toContain("--folder-title-dark")
    }
  })

  // `inherit` is the default, and it must stay on the plain sidebar colour —
  // the same one a folder title falls back to — rather than pick a tint.
  it("leaves an uncoloured group title on the default sidebar colour", () => {
    groupWith([5], [])
    const title = render(tree()).getByText("Work")

    expect(title.className).toContain("text-sidebar-foreground/75")
    expect(title.className).not.toContain("folder-title-tint")
    expect(title.getAttribute("style")).toBeNull()
  })
})

describe("SidebarConversationList — tag filter", () => {
  // Rendered with its own filter prop; the provider stays mounted so `t` is
  // stable, exactly like `tree()`.
  const filterHarness: { set: (f: TagFilter) => void } = { set: () => {} }
  function FilteredHarness({ initial }: { initial: TagFilter }) {
    const [filter, setFilter] = useState(initial)
    useEffect(() => {
      filterHarness.set = setFilter
    }, [])
    return (
      <SidebarConversationList
        showCompleted
        sortMode="created"
        tagFilter={filter}
      />
    )
  }
  const filtered = (initial: TagFilter) => (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <FilteredHarness initial={initial} />
    </NextIntlClientProvider>
  )

  beforeEach(() => {
    probes.card = 0
    probes.folder = 0
    store.activeTabId = null
    store.tabSpec = []
    const folders = [folder(1, "Folder 1"), folder(2, "Folder 2")]
    useAppWorkspaceStore.setState({
      folders,
      allFolders: folders,
      conversations: [
        conv(11, 1, { tag_ids: [5] }),
        conv(12, 1),
        conv(21, 2, { tag_ids: [6] }),
        conv(31, 9, { kind: "chat" }),
      ],
    })
  })

  const shownIds = (container: HTMLElement) =>
    [...container.querySelectorAll("[data-conversation-id]")].map((el) =>
      Number(el.getAttribute("data-conversation-id"))
    )

  it("shows only matching conversations and drops folders with no match", () => {
    const { container, getByText } = render(
      filtered({ tagIds: [5], mode: "any" })
    )
    expect(shownIds(container)).toEqual([11])
    expect(container.querySelector('[data-folder-id="1"]')).not.toBeNull()
    expect(container.querySelector('[data-folder-id="2"]')).toBeNull()
    // The Chat section is still there, saying why it is empty.
    expect(getByText("No conversations with these tags")).toBeTruthy()
  })

  it("matches all selected tags in all mode", () => {
    useAppWorkspaceStore.setState({
      conversations: [
        conv(11, 1, { tag_ids: [5, 6] }),
        conv(12, 1, { tag_ids: [5] }),
      ],
    })
    const { container } = render(filtered({ tagIds: [5, 6], mode: "all" }))
    expect(shownIds(container)).toEqual([11])
  })

  it("puts every folder back once the filter is cleared", () => {
    const { container } = render(filtered({ tagIds: [5], mode: "any" }))
    act(() => filterHarness.set({ tagIds: [], mode: "any" }))
    expect(shownIds(container).sort()).toEqual([11, 12, 21, 31])
    expect(container.querySelector('[data-folder-id="2"]')).not.toBeNull()
  })

  it("still re-renders only the changed card under an active filter", () => {
    render(filtered({ tagIds: [5, 6], mode: "any" }))
    const prev = useAppWorkspaceStore.getState().conversations
    const next = prev.slice()
    const idx = next.findIndex((c) => c.id === 21)
    next[idx] = { ...next[idx], status: "completed" }
    probes.card = 0
    probes.folder = 0
    act(() => {
      useAppWorkspaceStore.setState({ conversations: next })
    })
    expect(probes.card).toBe(1)
    expect(probes.folder).toBe(0)
  })
})
