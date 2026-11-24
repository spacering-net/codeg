import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { StrictMode, useEffect, useState, type ReactNode } from "react"
import { describe, it, expect, vi } from "vitest"
import { act, render } from "@testing-library/react"

import {
  claimRuntimeSession,
  getRuntimeSession,
  getTimelineTurns,
  releaseRuntimeSession,
  resetConversationRuntimeStore,
  useConversationRuntimeStore,
} from "@/stores/conversation-runtime-store"
import {
  isReparentUnmount,
  reparentedViewRuntimeConversationId,
  trackConversationView,
  type TabItemInternal,
} from "@/stores/tab-store"
import { singleGroupLayout, splitGroup } from "@/lib/tab-group-layout"

vi.mock("@/lib/api", () => ({
  getFolderConversation: vi.fn(),
}))

const { getFolderConversation } = await import("@/lib/api")

const source = readFileSync(
  resolve(
    process.cwd(),
    "src/components/conversations/conversation-detail-panel.tsx"
  ),
  "utf8"
)

/**
 * The zero-remount invariant, proven behaviourally.
 *
 * A conversation view owns a live ACP connection and streaming state, so a
 * remount is destructive: the split feature is only correct if flipping into
 * and out of split leaves every surviving view's DOM node identity untouched.
 *
 * The conditional shapes `renderGroupShell` relies on are:
 *   1. TWO leading `{isSplit && …}` siblings (the group strip, then the
 *      group's conversation title bar) ahead of the unkeyed content wrapper
 *      (inside each shell), and
 *   2. a trailing `{isSplit && handles.map(...)}` sibling after the keyed shell
 *      array (inside the container).
 *
 * Both are safe: React's array reconciler tracks each child's slot index, and
 * a `false` slot is a hole rather than a shift, so the following child is still
 * matched at its own index (`oldFiber.index > newIdx` skips the holes instead
 * of pairing the content wrapper with a newly-appearing sibling). These tests
 * pin that down so a future refactor of the shell's child shape — e.g. wrapping
 * the trio in a conditional fragment, which WOULD shift slots — fails loudly
 * here.
 */
function Shell({ isSplit }: { isSplit: boolean }) {
  return (
    <div data-testid="shell">
      {isSplit && (
        <div data-testid="strip" className="flex h-10 shrink-0 items-stretch">
          strip
        </div>
      )}
      {isSplit && (
        <div data-testid="header" className="shrink-0">
          title bar
        </div>
      )}
      <div
        data-testid="content"
        className="relative min-h-0 flex-1 overflow-hidden"
      >
        <span data-testid="view">conversation view</span>
      </div>
    </div>
  )
}

function Container({
  groupIds,
  isSplit,
}: {
  groupIds: string[]
  isSplit: boolean
}) {
  return (
    <div className="relative min-h-0 flex-1 overflow-hidden">
      {groupIds.map((groupId) => (
        <div key={groupId} data-testid={`shell-${groupId}`}>
          <Shell isSplit={isSplit} />
        </div>
      ))}
      {isSplit &&
        ["s-1:0"].map((handle) => (
          <div key={handle} data-testid={`handle-${handle}`} />
        ))}
    </div>
  )
}

describe("split group shell reconciliation", () => {
  it("keeps the content subtree mounted when the strip + title bar appear and disappear", () => {
    const { rerender, getByTestId, queryByTestId } = render(
      <Shell isSplit={false} />
    )
    const content = getByTestId("content")
    const view = getByTestId("view")
    expect(queryByTestId("strip")).toBeNull()
    expect(queryByTestId("header")).toBeNull()

    // Split: the strip AND the group title bar are prepended.
    rerender(<Shell isSplit={true} />)
    expect(queryByTestId("strip")).not.toBeNull()
    expect(queryByTestId("header")).not.toBeNull()
    expect(getByTestId("content")).toBe(content)
    expect(getByTestId("view")).toBe(view)

    // Unsplit: both go away again.
    rerender(<Shell isSplit={false} />)
    expect(queryByTestId("strip")).toBeNull()
    expect(queryByTestId("header")).toBeNull()
    expect(getByTestId("content")).toBe(content)
    expect(getByTestId("view")).toBe(view)
  })

  it("keeps existing shells mounted when a group is added, removed, and dividers toggle", () => {
    const { rerender, getByTestId, queryByTestId } = render(
      <Container groupIds={["g-main"]} isSplit={false} />
    )
    const mainShell = getByTestId("shell-g-main")
    const mainView = getByTestId("view")

    // Split Right: a second group is appended AFTER the source group and the
    // divider overlay appears.
    rerender(<Container groupIds={["g-main", "g-2"]} isSplit={true} />)
    expect(getByTestId("shell-g-main")).toBe(mainShell)
    expect(getByTestId("shell-g-2")).toBeTruthy()
    expect(getByTestId("handle-s-1:0")).toBeTruthy()

    // A third group joins the same row (same-orientation flatten).
    rerender(<Container groupIds={["g-main", "g-2", "g-3"]} isSplit={true} />)
    expect(getByTestId("shell-g-main")).toBe(mainShell)

    // Unsplit All: back to one group, dividers gone.
    rerender(<Container groupIds={["g-main"]} isSplit={false} />)
    expect(getByTestId("shell-g-main")).toBe(mainShell)
    expect(getByTestId("view")).toBe(mainView)
    expect(queryByTestId("handle-s-1:0")).toBeNull()
  })
})

describe("split group shell source shape", () => {
  // Ties the mirrored components above to the real render path: if the shell's
  // children stop being [conditional strip, conditional title bar, content
  // wrapper] siblings, the behavioural proof above no longer describes
  // production.
  it("keeps strip, title bar, and content wrapper as plain sibling slots", () => {
    const shellStart = source.indexOf("const renderGroupShell = (groupId")
    expect(shellStart).toBeGreaterThan(-1)
    const shellBody = source.slice(shellStart, shellStart + 6000)
    const stripIdx = shellBody.indexOf("{isSplit && (")
    const headerIdx = shellBody.indexOf("{isSplit && selTab && (")
    const contentIdx = shellBody.indexOf(
      '<div className="relative min-h-0 flex-1 overflow-hidden">'
    )
    expect(stripIdx).toBeGreaterThan(-1)
    expect(headerIdx).toBeGreaterThan(stripIdx)
    expect(contentIdx).toBeGreaterThan(headerIdx)
    // The per-group title bar lives between them.
    expect(shellBody.slice(headerIdx, contentIdx)).toContain(
      "<ConversationDetailHeader"
    )
    // No fragment/wrapper around the trio — that would make the flip shift
    // slots and remount the content subtree.
    expect(shellBody.slice(stripIdx, contentIdx)).not.toContain("<>")
  })
})

/**
 * The reparents the shells above cannot absorb.
 *
 * A tab dragged into another group DOES change React parents, so its view is
 * remounted by design. The connection is deliberately carried across that
 * unmount (`isTransientUnmount`), and the runtime session — which holds the
 * transcript — has to be carried with it. Dropping the session there left the
 * message list empty for as long as the tab stayed open: the remounted view
 * re-registers its live-message sink on the connection it just kept, that
 * recreates the session with live data and no detail, and `fetchDetail` skips
 * a session that already has live data. Nothing refetches after that.
 */
describe("a reparented conversation view keeps its runtime session", () => {
  it("consults the reparent classifier before anything that ends the session's work", () => {
    const cleanupStart = source.indexOf(
      "// Cleanup runtime data on unmount (tab close)"
    )
    const cleanupEnd = source.indexOf(
      "const handleSend = useCallback(",
      cleanupStart
    )
    expect(cleanupStart).toBeGreaterThan(-1)
    expect(cleanupEnd).toBeGreaterThan(cleanupStart)
    const cleanup = source.slice(cleanupStart, cleanupEnd)
    const guardIdx = cleanup.indexOf("isReparentUnmount(useTabStore.getState()")
    const cancelSyncIdx = cleanup.indexOf("syncCancelRef.current?.()")
    const deferIdx = cleanup.indexOf("setPendingCleanup(")
    const removeIdx = cleanup.indexOf("releaseRuntimeSession(")
    expect(guardIdx).toBeGreaterThan(-1)
    // Both ways of ending a session sit behind the classifier.
    expect(deferIdx).toBeGreaterThan(guardIdx)
    expect(removeIdx).toBeGreaterThan(guardIdx)
    // So does cancelling its post-turn metadata sync: the sync patches the
    // session the reparent keeps, and a reply whose sync was cancelled never
    // gets its usage, model or fork-point name while the tab stays open.
    expect(cancelSyncIdx).toBeGreaterThan(guardIdx)
    // Same inputs the connection's own guard uses, so the two agree on what a
    // reparent is.
    expect(cleanup.slice(guardIdx, deferIdx)).toContain("tabId, groupId")
  })

  it("cannot reload the transcript once a live sink has recreated the session", async () => {
    resetConversationRuntimeStore()
    const { actions } = useConversationRuntimeStore.getState()

    // What the remounted view does first: re-register its live-message sink on
    // the connection it kept. The session comes back empty, but live.
    act(() => {
      actions.setLiveMessage(
        7,
        { id: "lm-1", role: "assistant", content: [], startedAt: 0 },
        true
      )
    })
    expect(getTimelineTurns(7)).toHaveLength(0)

    act(() => {
      actions.fetchDetail(7)
    })
    await act(async () => {})

    expect(getFolderConversation).not.toHaveBeenCalled()
    expect(getTimelineTurns(7)).toHaveLength(0)
  })
})

/**
 * The other half of a reparent: the view that REMOUNTS has to key itself on the
 * session its predecessor kept.
 *
 * A conversation started as a draft streams under a virtual runtime id and
 * keeps it after the first send binds the tab to a row. A remount that keyed
 * itself by the row id instead reloaded the row into a second session beside
 * the kept one, which then sat in the store for good — with the usage /
 * session-details / Diff readers that follow `runtimeConversationId ??
 * conversationId` still reading it, though nothing updates it anymore.
 *
 * The inheritance has to fire for a reparent and ONLY for one. The
 * desktop/mobile layout swap also remounts every view in one commit, but moves
 * none of them, so the predecessor's cleanup releases its session: a successor
 * that inherited that key would sit on nothing, and a virtual key never fetches.
 * And because an unmount cannot tell that a view is coming straight back —
 * that swap, or StrictMode replaying a fresh mount's effects in development —
 * a released session survives the task, and a view mounting on it claims it.
 */
describe("a reparented view inherits its predecessor's runtime key", () => {
  const TAB = "conv-1-codex-7"
  /** What the tab mounted on while it was still a draft. */
  const DRAFT_KEY = -7
  /** What a fresh mount keys on once the tab is bound to its row. */
  const ROW = 7
  const LAYOUT = splitGroup(singleGroupLayout("a"), "a", "right", "b")

  type TabState = Parameters<typeof isReparentUnmount>[0]

  /** The tab store as the views read it: the tab open, assigned to `group`. */
  function tabIn(group: string): TabState {
    return {
      rawTabs: [{ id: TAB } as TabItemInternal],
      groupOf: { [TAB]: group },
      groupLayout: LAYOUT,
    }
  }

  /** A runtime session with a transcript in it, like the one a bound draft's
   *  view has been streaming into. */
  function seedSession(key: number) {
    resetConversationRuntimeStore()
    const { actions } = useConversationRuntimeStore.getState()
    actions.setDbConversationId(key, ROW)
  }

  /** Let the task a release waits out end. */
  async function endTask() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }

  interface ViewProps {
    groupId: string
    freshKey: number
    state: () => TabState
    onKey: (key: number) => void
    onCleanup: (verdict: "keep" | "release") => void
  }

  /** `ConversationTabView` reduced to its session hand-off, wired the same
   *  way: pick the key at first render, register it, claim the session, and
   *  let the unmount ask the reparent classifier whether to release it. */
  function View({ groupId, freshKey, state, onKey, onCleanup }: ViewProps) {
    const [key] = useState(
      () => reparentedViewRuntimeConversationId(state(), TAB) ?? freshKey
    )
    useEffect(() => trackConversationView(TAB, groupId, key), [groupId, key])
    useEffect(() => {
      claimRuntimeSession(key)
    }, [key])
    useEffect(() => {
      onKey(key)
      return () => {
        if (isReparentUnmount(state(), TAB, groupId)) {
          onCleanup("keep")
          return
        }
        onCleanup("release")
        releaseRuntimeSession(key)
      }
    }, [groupId, key, onCleanup, onKey, state])
    return null
  }

  function Desktop({ children }: { children: ReactNode }) {
    return <div>{children}</div>
  }

  function Mobile({ children }: { children: ReactNode }) {
    return <section>{children}</section>
  }

  /** Keyed group shells, as `renderGroupShell` lays them out, under the layout
   *  shell — which, like the workspace layout's, is a different component on
   *  mobile and so remounts everything below it when the breakpoint flips. */
  function Workspace({
    mobile,
    group,
    ...view
  }: { mobile: boolean; group: string } & Omit<ViewProps, "groupId">) {
    const shells = ["a", "b"].map((groupId) => (
      <div key={groupId}>
        {groupId === group && <View groupId={groupId} {...view} />}
      </div>
    ))
    return mobile ? <Mobile>{shells}</Mobile> : <Desktop>{shells}</Desktop>
  }

  function harness({ strict = false } = {}) {
    let current = tabIn("a")
    const keys: number[] = []
    const cleanups: string[] = []
    const view = {
      state: () => current,
      onKey: (key: number) => keys.push(key),
      onCleanup: (verdict: string) => cleanups.push(verdict),
    }
    return {
      keys,
      cleanups,
      moveTo: (group: string) => {
        current = tabIn(group)
      },
      ui: (mobile: boolean, group: string, freshKey: number) => {
        const workspace = (
          <Workspace
            mobile={mobile}
            group={group}
            freshKey={freshKey}
            {...view}
          />
        )
        return strict ? <StrictMode>{workspace}</StrictMode> : workspace
      },
    }
  }

  it("carries the kept key and session when a move reparents the view", async () => {
    seedSession(DRAFT_KEY)
    const h = harness()
    const { rerender, unmount } = render(h.ui(false, "a", DRAFT_KEY))

    // The first send has bound the tab (a fresh mount would now key on the
    // row), and then the tab is dragged into the other group.
    h.moveTo("b")
    rerender(h.ui(false, "b", ROW))
    await endTask()

    expect(h.cleanups).toEqual(["keep"])
    expect(h.keys).toEqual([DRAFT_KEY, DRAFT_KEY])
    expect(getRuntimeSession(DRAFT_KEY)).not.toBeNull()

    // Closing it for real still gives the session up.
    unmount()
    await endTask()
    expect(getRuntimeSession(DRAFT_KEY)).toBeNull()
    expect(reparentedViewRuntimeConversationId(tabIn("a"), TAB)).toBeNull()
  })

  it("starts fresh when a layout swap remounts the view without moving it", async () => {
    seedSession(DRAFT_KEY)
    const h = harness()
    const { rerender, unmount } = render(h.ui(false, "a", DRAFT_KEY))

    rerender(h.ui(true, "a", ROW))
    await endTask()

    expect(h.cleanups).toEqual(["release"])
    expect(h.keys).toEqual([DRAFT_KEY, ROW])
    // Nothing mounted on the draft key again, so its session went.
    expect(getRuntimeSession(DRAFT_KEY)).toBeNull()
    unmount()
  })

  it("keeps the session a layout swap remounts a view straight back onto", async () => {
    seedSession(ROW)
    const h = harness()
    const { rerender, unmount } = render(h.ui(false, "a", ROW))

    rerender(h.ui(true, "a", ROW))
    await endTask()

    expect(h.cleanups).toEqual(["release"])
    expect(getRuntimeSession(ROW)).not.toBeNull()
    unmount()
  })

  it("survives StrictMode replaying the arriving view's effects", async () => {
    seedSession(DRAFT_KEY)
    const h = harness({ strict: true })
    const { rerender, unmount } = render(h.ui(false, "a", DRAFT_KEY))

    h.moveTo("b")
    rerender(h.ui(false, "b", ROW))
    await endTask()

    // The replay's unmount is not a reparent (the view is already in "b"), so
    // it releases — and the replayed mount claims the session straight back.
    expect(h.cleanups).toContain("release")
    expect(h.keys[h.keys.length - 1]).toBe(DRAFT_KEY)
    expect(getRuntimeSession(DRAFT_KEY)).not.toBeNull()
    unmount()
    await endTask()
    expect(getRuntimeSession(DRAFT_KEY)).toBeNull()
  })

  it("lets a view's release drop only its own registration", () => {
    const releasePredecessor = trackConversationView(TAB, "a", -1)
    const releaseSuccessor = trackConversationView(TAB, "b", -2)

    releasePredecessor()
    // The successor is still registered: moving the tab out of its group again
    // hands ITS key on.
    expect(reparentedViewRuntimeConversationId(tabIn("a"), TAB)).toBe(-2)

    releaseSuccessor()
    expect(reparentedViewRuntimeConversationId(tabIn("a"), TAB)).toBeNull()
  })

  it("is how the real view picks, registers and claims its key", () => {
    const initStart = source.indexOf(
      "const [effectiveConversationId] = useState("
    )
    const initEnd = source.indexOf("const [createdConversationId", initStart)
    expect(initStart).toBeGreaterThan(-1)
    expect(initEnd).toBeGreaterThan(initStart)
    const init = source.slice(initStart, initEnd)
    expect(init).toMatch(
      /reparentedViewRuntimeConversationId\(\s*useTabStore\.getState\(\),\s*tabId\s*\)\s*\?\?\s*conversationId\s*\?\?/
    )
    expect(init).toMatch(
      /trackConversationView\(\s*tabId,\s*groupId,\s*effectiveConversationId\s*\)/
    )
    // The mount effect that clears a deferred cleanup also takes the session
    // back from a release the previous view scheduled.
    expect(source).toMatch(
      /claimRuntimeSession\(effectiveConversationId\)\s*setPendingCleanup\(effectiveConversationId, false\)/
    )
  })
})
