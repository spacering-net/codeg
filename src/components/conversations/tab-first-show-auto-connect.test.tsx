/**
 * A tab restored behind another one stays mounted but hidden, and its detail
 * fetch waits until it is shown. It is not session-less meanwhile: its mount
 * effects create its runtime session. So the render that shows it — which is
 * also the render that makes it the active tab — sees a session with no detail
 * and no fetch in flight, and the auto-connect effect takes its gate from that
 * very render. If the gate reads "not loading" there, the connect goes out with
 * `sessionId: undefined`: the backend takes `session/new`, and the next prompt
 * re-points the conversation at that empty session.
 *
 * Only that first load waits. A view that has held its detail keeps fetching
 * it while hidden, as every view did before the visibility gate, so a session
 * dropped under a hidden tab is loaded again before the tab's live connection
 * can refill it with nothing but the turn in progress.
 *
 * `ConversationTabView` is too heavy to render here, so `TabViewGate` repeats
 * its wiring of the pieces involved — the mount-time session claim, the fetch
 * gate on `useConversationDetail`, and the persisted-conversation gate in front
 * of the REAL `useConnectionLifecycle` — and the source checks at the bottom
 * keep that wiring pinned to the panel.
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { act, cleanup, render } from "@testing-library/react"
import { useEffect, useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { LiveMessage } from "@/contexts/acp-connections-context"
import { useConnectionLifecycle } from "@/hooks/use-connection-lifecycle"
import { useConversationDetail } from "@/hooks/use-conversation-detail"
import type { DbConversationDetail } from "@/lib/types"
import {
  claimRuntimeSession,
  resetConversationRuntimeStore,
  useConversationRuntimeActions,
  useConversationRuntimeStore,
} from "@/stores/conversation-runtime-store"

vi.mock("@/lib/api", () => ({
  getFolderConversation: vi.fn(),
  getFolderConversationTurns: vi.fn(),
}))

// Stable across renders: the lifecycle hook's unmount-cleanup effect depends
// on these, and fresh identities would tear the "connection" down every render.
const stubs = vi.hoisted(() => {
  const connect = vi.fn(() => Promise.resolve())
  return {
    connect,
    conn: {
      status: null,
      selectorsReady: false,
      connect,
      disconnect: vi.fn(() => Promise.resolve()),
      sendPrompt: vi.fn(),
      setMode: vi.fn(),
      setConfigOption: vi.fn(),
      cancel: vi.fn(),
      respondPermission: vi.fn(),
      modes: null,
      configOptions: null,
      hasCachedSelectors: false,
      isViewer: false,
      backgroundOutstanding: 0,
      sessionId: null,
    },
    acp: { setActiveKey: vi.fn(), touchActivity: vi.fn() },
    tasks: { addTask: vi.fn(), updateTask: vi.fn(), removeTask: vi.fn() },
    t: Object.assign((key: string) => key, { rich: (key: string) => key }),
  }
})
vi.mock("@/hooks/use-connection", () => ({ useConnection: () => stubs.conn }))
vi.mock("@/contexts/acp-connections-context", () => ({
  useAcpActions: () => stubs.acp,
}))
vi.mock("@/contexts/task-context", () => ({
  useTaskContext: () => stubs.tasks,
}))
vi.mock("next-intl", () => ({ useTranslations: () => stubs.t }))

const { getFolderConversation } = await import("@/lib/api")
const mockGet = vi.mocked(getFolderConversation)

const CID = 42
const STORED_SESSION = "sess-stored"

const storedDetail = (): DbConversationDetail =>
  ({
    summary: {
      id: CID,
      external_id: STORED_SESSION,
      agent_account_id: "account-work",
    },
    turns: [],
  }) as unknown as DbConversationDetail

const liveMsg: LiveMessage = {
  id: "live-1",
  role: "assistant",
  content: [],
  startedAt: 0,
}

function TabViewGate({
  visible,
  active,
}: {
  visible: boolean
  active: boolean
}) {
  // The panel's mount effect: claim the session and clear pendingCleanup —
  // which is what materializes a hidden tab's runtime session.
  const { setPendingCleanup } = useConversationRuntimeActions()
  useEffect(() => {
    claimRuntimeSession(CID)
    setPendingCleanup(CID, false)
  }, [setPendingCleanup])
  // The panel's fetch gate: the first load waits for the tab to be shown or
  // made active; once a detail has been held, the view keeps fetching.
  const [heldDetail, setHeldDetail] = useState(false)
  const { detail, loading: detailLoading } = useConversationDetail(CID, {
    enabled: visible || active || heldDetail,
  })
  if (detail != null && !heldDetail) setHeldDetail(true)
  const runtimeExternalId = useConversationRuntimeStore(
    (s) => s.byConversationId.get(CID)?.externalId ?? null
  )
  const externalId =
    runtimeExternalId ?? detail?.summary.external_id ?? undefined
  // A persisted, non-cline conversation: the gate is `detailLoading`.
  const awaitingHistoricalSessionId = detailLoading
  useConnectionLifecycle({
    contextKey: "tab-1",
    agentType: "claude_code",
    isActive: active && !awaitingHistoricalSessionId,
    workingDir: "/repo",
    sessionId: externalId,
    conversationId: CID,
    agentAccountId: detail?.summary.agent_account_id,
    preparing: active && awaitingHistoricalSessionId,
  })
  return null
}

function storedSession() {
  return useConversationRuntimeStore.getState().byConversationId.get(CID)
}

function resetAll() {
  cleanup()
  act(() => resetConversationRuntimeStore())
  mockGet.mockReset()
  stubs.connect.mockClear()
}

describe("a hidden tab's first show", () => {
  afterEach(resetAll)

  it("auto-connects only once its stored session id has arrived", async () => {
    let land!: (detail: DbConversationDetail) => void
    mockGet.mockImplementation(
      () =>
        new Promise<DbConversationDetail>((resolveFetch) => {
          land = resolveFetch
        })
    )

    const { rerender } = render(<TabViewGate visible={false} active={false} />)
    await act(async () => {})
    expect(mockGet).not.toHaveBeenCalled()
    expect(stubs.connect).not.toHaveBeenCalled()

    await act(async () => {
      rerender(<TabViewGate visible active />)
    })
    expect(mockGet).toHaveBeenCalledTimes(1)
    expect(stubs.connect).not.toHaveBeenCalled()

    await act(async () => {
      land(storedDetail())
    })
    expect(stubs.connect).toHaveBeenCalledTimes(1)
    expect(stubs.connect).toHaveBeenCalledWith(
      "claude_code",
      "/repo",
      STORED_SESSION,
      CID,
      "account-work"
    )
  })

  // Today the tab store makes a tab its group's selected one in the same write
  // that makes it active, so an active tab is always visible. The gate does not
  // lean on that: an active tab fetches, and holds its connect, regardless.
  it("holds the connect for a tab made active without being shown", async () => {
    let land!: (detail: DbConversationDetail) => void
    mockGet.mockImplementation(
      () =>
        new Promise<DbConversationDetail>((resolveFetch) => {
          land = resolveFetch
        })
    )

    const { rerender } = render(<TabViewGate visible={false} active={false} />)
    await act(async () => {})
    await act(async () => {
      rerender(<TabViewGate visible={false} active />)
    })
    expect(mockGet).toHaveBeenCalledTimes(1)
    expect(stubs.connect).not.toHaveBeenCalled()

    await act(async () => {
      land(storedDetail())
    })
    expect(stubs.connect).toHaveBeenCalledTimes(1)
    expect(stubs.connect).toHaveBeenCalledWith(
      "claude_code",
      "/repo",
      STORED_SESSION,
      CID,
      "account-work"
    )
  })
})

// Closing the sub-agent viewer drops the runtime session it shares with an
// open tab. If that tab is hidden and holds a live connection, the
// connection's next streamed batch recreates the session with live data and no
// detail, and `fetchDetail` never fetches a session holding a turn in progress.
describe("a hidden tab whose session is dropped", () => {
  afterEach(resetAll)

  it("loads its history again if it had loaded it before", async () => {
    let landAgain!: (detail: DbConversationDetail) => void
    mockGet.mockResolvedValueOnce(storedDetail()).mockImplementationOnce(
      () =>
        new Promise<DbConversationDetail>((resolveFetch) => {
          landAgain = resolveFetch
        })
    )

    const { rerender } = render(<TabViewGate visible active />)
    await act(async () => {})
    expect(storedSession()?.detail).not.toBeNull()

    // Switched away from: hidden, and no longer the active tab.
    await act(async () => {
      rerender(<TabViewGate visible={false} active={false} />)
    })
    act(() => {
      useConversationRuntimeStore.getState().actions.removeConversation(CID)
    })
    act(() => {
      useConversationRuntimeStore
        .getState()
        .actions.setLiveMessage(CID, liveMsg, true)
    })
    expect(mockGet).toHaveBeenCalledTimes(2)

    const again = storedDetail()
    await act(async () => {
      landAgain(again)
    })
    await act(async () => {
      rerender(<TabViewGate visible active />)
    })
    expect(storedSession()?.detail).toBe(again)
  })

  it("stays lazy if it never loaded", async () => {
    render(<TabViewGate visible={false} active={false} />)
    await act(async () => {})
    act(() => {
      useConversationRuntimeStore.getState().actions.removeConversation(CID)
    })
    await act(async () => {})

    expect(mockGet).not.toHaveBeenCalled()
  })
})

describe("TabViewGate mirrors ConversationTabView", () => {
  const panel = readFileSync(
    resolve(
      process.cwd(),
      "src/components/conversations/conversation-detail-panel.tsx"
    ),
    "utf8"
  )

  it("creates the session on mount and gates the first fetch on being shown", () => {
    expect(panel).toContain("setPendingCleanup(effectiveConversationId, false)")
    expect(panel).toContain(
      "const [heldDetail, setHeldDetail] = useState(false)"
    )
    expect(panel).toMatch(
      /useConversationDetail\(effectiveConversationId, \{\s+enabled: isVisible \|\| isActive \|\| heldDetail,\s+\}\)/
    )
    expect(panel).toContain(
      "if (detail != null && !heldDetail) setHeldDetail(true)"
    )
    expect(panel).toContain("isVisible={visible}")
  })

  it("holds the auto-connect on detailLoading", () => {
    expect(panel).toMatch(
      /const awaitingHistoricalSessionId =\s+hasPersistedConversation && selectedAgent !== "cline" && detailLoading/
    )
    expect(panel).toContain("!awaitingHistoricalSessionId &&")
    expect(panel).toContain("isActive: isActive && canAutoConnect,")
  })

  // A tab that started as a draft never fetches a detail (its runtime key stays
  // virtual). Waiting on the detail for its account held its reconnects for
  // good after the first send, and read its account as Default.
  it("waits for an account binding only while no source knows it", () => {
    expect(panel).toContain(
      "const conversationAccountId = resolveConversationAccount({"
    )
    expect(panel).toContain("listed: listedBinding,")
    expect(panel).toContain("detail: detailBinding,")
    expect(panel).toMatch(
      /const awaitingAccountBinding =\s+conversationAccountId === undefined && !detailError/
    )
    expect(panel).toContain("!awaitingAccountBinding &&")
  })
})
