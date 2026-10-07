/**
 * Regression coverage for the per-conversation fetch-generation guard
 * that protects `FETCH_DETAIL_SUCCESS` / `FETCH_DETAIL_ERROR` from
 * out-of-order resolution and from resurrecting a removed session.
 *
 * The bug fixed by the generation counter:
 *
 *   1. Open dialog for child 99 → `refetchDetail(99)` issues fetch A.
 *   2. User closes the dialog → `removeConversation(99)` deletes state.
 *   3. Fetch A resolves AFTER the unmount → `FETCH_DETAIL_SUCCESS`
 *      reducer recreates the session with stale detail.
 *   4. User reopens → `useConversationDetail`'s active-data guard
 *      skips the auto-fetch because `session.detail` is set.
 *   5. The user is shown a stale pre-completion transcript.
 *
 * The counter also prevents a stale-response-wins race:
 *
 *   1. Open A → fetch A (slow).
 *   2. Close A.
 *   3. Open B → fetch B (faster).
 *   4. Fetch B resolves first — fresh detail in state.
 *   5. Fetch A resolves second — would overwrite B's fresh detail
 *      with stale, but the generation guard ignores it.
 */

import { act, render, screen } from "@testing-library/react"
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest"
import { useEffect, type ReactNode } from "react"

import {
  buildStreamingTurnsFromLiveMessage,
  ConversationRuntimeProvider,
  resetConversationRuntimeStore,
  useConversationRuntime,
} from "@/contexts/conversation-runtime-context"
import type {
  LiveContentBlock,
  LiveMessage,
  ToolCallInfo,
} from "@/contexts/acp-connections-context"
import type {
  ContentBlock,
  DbConversationDetail,
  MessageTurn,
} from "@/lib/types"

vi.mock("@/lib/api", () => ({
  getFolderConversation: vi.fn(),
}))

const { getFolderConversation } = await import("@/lib/api")
const mockGetFolderConversation = vi.mocked(getFolderConversation)

function detailWithTitle(title: string): DbConversationDetail {
  return {
    summary: {
      id: 99,
      folder_id: 1,
      agent_type: "codex",
      title,
      title_locked: false,
      status: "in_progress",
      kind: "regular",
      model: null,
      git_branch: null,
      external_id: "ext-1",
      message_count: 0,
      child_count: 0,
      created_at: "2026-05-28T00:00:00.000Z",
      updated_at: "2026-05-28T00:00:00.000Z",
      pinned_at: null,
    },
    turns: [],
    session_stats: null,
  }
}

let preserveLiveFlag = false

const LIVE_MSG: LiveMessage = {
  id: "lm-1",
  role: "assistant",
  content: [],
  startedAt: 0,
}

/** Probe component that exposes runtime actions to the test and lets it
 *  read back the session state via DOM attributes. */
function Probe() {
  const {
    refetchDetail,
    removeConversation,
    setLiveMessage,
    setLiveOwnsActiveTurn,
    getSession,
  } = useConversationRuntime()
  const session = getSession(99)
  return (
    <div>
      <button
        data-testid="refetch"
        type="button"
        onClick={() => refetchDetail(99)}
      >
        refetch
      </button>
      <button
        data-testid="refetch-preserve"
        type="button"
        onClick={() => refetchDetail(99, { preserveLive: preserveLiveFlag })}
      >
        refetch-preserve
      </button>
      <button
        data-testid="set-live"
        type="button"
        onClick={() => setLiveMessage(99, LIVE_MSG, true)}
      >
        set-live
      </button>
      <button
        data-testid="set-live-owns"
        type="button"
        onClick={() => setLiveOwnsActiveTurn(99, true)}
      >
        set-live-owns
      </button>
      <button
        data-testid="remove"
        type="button"
        onClick={() => removeConversation(99)}
      >
        remove
      </button>
      <div data-testid="title">
        {session?.detail?.summary.title ?? "no-detail"}
      </div>
      <div data-testid="has-session">{session ? "yes" : "no"}</div>
      <div data-testid="loading">{session?.detailLoading ? "yes" : "no"}</div>
      <div data-testid="has-live">{session?.liveMessage ? "yes" : "no"}</div>
      <div data-testid="live-owns">
        {session?.liveOwnsActiveTurn ? "yes" : "no"}
      </div>
    </div>
  )
}

function renderProvider(children: ReactNode = <Probe />) {
  return render(
    <ConversationRuntimeProvider>{children}</ConversationRuntimeProvider>
  )
}

// Runtime state is now a module-level singleton store (was per-provider reducer
// state). Reset it before every test — this file-level hook runs ahead of each
// describe's own beforeEach — so the singleton never leaks across tests.
beforeEach(() => {
  resetConversationRuntimeStore()
})

describe("ConversationRuntimeProvider fetch-generation guard", () => {
  let originalConsoleError: typeof console.error
  let consoleErrorSpy: MockInstance

  beforeEach(() => {
    mockGetFolderConversation.mockReset()
    // Default to a promise that never resolves so any call a test doesn't
    // explicitly configure is a harmless no-op; `mockResolvedValueOnce` calls
    // below take priority for calls a test does care about.
    mockGetFolderConversation.mockImplementation(() => new Promise(() => {}))
    preserveLiveFlag = false
    originalConsoleError = console.error
    // Filter React's act() warnings produced when promise resolutions
    // commit asynchronously; the tests use act() correctly but the
    // microtask boundary is finer-grained than RTL's wrapper.
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    console.error = originalConsoleError
    consoleErrorSpy.mockRestore()
  })

  it("ignores a fetch response that resolves after removeConversation — no zombie session is created", async () => {
    let resolveA!: (detail: DbConversationDetail) => void
    mockGetFolderConversation.mockImplementationOnce(
      () =>
        new Promise<DbConversationDetail>((resolve) => {
          resolveA = resolve
        })
    )

    renderProvider()
    await act(async () => {
      screen.getByTestId("refetch").click()
    })
    expect(screen.getByTestId("loading").textContent).toBe("yes")

    // Tear down the session BEFORE fetch A resolves — simulates the user
    // closing the dialog while the detail is still loading.
    await act(async () => {
      screen.getByTestId("remove").click()
    })
    expect(screen.getByTestId("has-session").textContent).toBe("no")

    // Fetch A resolves with stale detail AFTER removal. The
    // generation-counter guard must drop this resolution silently — no
    // FETCH_DETAIL_SUCCESS dispatched, so the session stays gone.
    await act(async () => {
      resolveA(detailWithTitle("stale-A"))
      await Promise.resolve()
    })
    expect(screen.getByTestId("has-session").textContent).toBe("no")
    expect(screen.getByTestId("title").textContent).toBe("no-detail")
  })

  it("refetchDetail preserves a bridged live message when preserveLive:true, and wipes it on a plain load", async () => {
    let resolveA!: (detail: DbConversationDetail) => void
    let resolveB!: (detail: DbConversationDetail) => void
    mockGetFolderConversation
      .mockImplementationOnce(
        () =>
          new Promise<DbConversationDetail>((resolve) => {
            resolveA = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<DbConversationDetail>((resolve) => {
            resolveB = resolve
          })
      )

    renderProvider()

    // Bridge a live reply (isLive bypasses the SET_LIVE_MESSAGE guard).
    await act(async () => {
      screen.getByTestId("set-live").click()
    })
    expect(screen.getByTestId("has-live").textContent).toBe("yes")

    // preserveLive=true (child still streaming) → the load folds in the
    // persisted detail but keeps the bridged live reply.
    preserveLiveFlag = true
    await act(async () => {
      screen.getByTestId("refetch-preserve").click()
    })
    await act(async () => {
      resolveA(detailWithTitle("with-live"))
      await Promise.resolve()
    })
    expect(screen.getByTestId("title").textContent).toBe("with-live")
    expect(screen.getByTestId("has-live").textContent).toBe("yes")

    // preserveLive=false (settled) → the next load is authoritative and wipes
    // the (now-promoted) live reply, matching the default FETCH_DETAIL_SUCCESS
    // behavior.
    preserveLiveFlag = false
    await act(async () => {
      screen.getByTestId("refetch-preserve").click()
    })
    await act(async () => {
      resolveB(detailWithTitle("no-live"))
      await Promise.resolve()
    })
    expect(screen.getByTestId("title").textContent).toBe("no-live")
    expect(screen.getByTestId("has-live").textContent).toBe("no")
  })

  it("setLiveOwnsActiveTurn marks the session so getTimelineTurns strips persisted assistant turns while liveMessage is present", () => {
    renderProvider()
    // Initially no session.
    expect(screen.getByTestId("live-owns").textContent).toBe("no")
    // After marking, the session is created and the flag is set.
    act(() => {
      screen.getByTestId("set-live-owns").click()
    })
    expect(screen.getByTestId("live-owns").textContent).toBe("yes")
  })

  it("drops a stale fetch resolution that arrives after a fresh refetchDetail (fresh-wins regardless of order)", async () => {
    let resolveA!: (detail: DbConversationDetail) => void
    let resolveB!: (detail: DbConversationDetail) => void
    mockGetFolderConversation
      .mockImplementationOnce(
        () =>
          new Promise<DbConversationDetail>((resolve) => {
            resolveA = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<DbConversationDetail>((resolve) => {
            resolveB = resolve
          })
      )

    renderProvider()
    // First open — fetch A in flight.
    await act(async () => {
      screen.getByTestId("refetch").click()
    })
    // Close, then second open — fetch B in flight. Each refetchDetail
    // bumps the generation counter, so A's eventual resolution should
    // be ignored.
    await act(async () => {
      screen.getByTestId("remove").click()
    })
    await act(async () => {
      screen.getByTestId("refetch").click()
    })

    // Resolve B FIRST — fresh detail lands.
    await act(async () => {
      resolveB(detailWithTitle("fresh-B"))
      await Promise.resolve()
    })
    expect(screen.getByTestId("title").textContent).toBe("fresh-B")

    // Then resolve A — stale. Without the generation guard this would
    // overwrite fresh-B; with it, fresh-B stays put.
    await act(async () => {
      resolveA(detailWithTitle("stale-A"))
      await Promise.resolve()
    })
    expect(screen.getByTestId("title").textContent).toBe("fresh-B")
  })

  it("a fresh fetch resolution after a stale one still wins (forward direction unchanged)", async () => {
    let resolveA!: (detail: DbConversationDetail) => void
    let resolveB!: (detail: DbConversationDetail) => void
    mockGetFolderConversation
      .mockImplementationOnce(
        () =>
          new Promise<DbConversationDetail>((resolve) => {
            resolveA = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<DbConversationDetail>((resolve) => {
            resolveB = resolve
          })
      )

    renderProvider()
    await act(async () => {
      screen.getByTestId("refetch").click()
    })
    await act(async () => {
      screen.getByTestId("remove").click()
    })
    await act(async () => {
      screen.getByTestId("refetch").click()
    })

    // Resolve A first (stale, already invalidated by remove + new refetch).
    await act(async () => {
      resolveA(detailWithTitle("stale-A"))
      await Promise.resolve()
    })
    // A's resolution was ignored — title stays empty until B lands.
    expect(screen.getByTestId("title").textContent).toBe("no-detail")

    // Resolve B — fresh detail wins as the latest generation.
    await act(async () => {
      resolveB(detailWithTitle("fresh-B"))
      await Promise.resolve()
    })
    expect(screen.getByTestId("title").textContent).toBe("fresh-B")
  })
})

/**
 * codex classifies file-reading shell commands (sed/cat/head) as ACP `read`
 * commandActions: kind="read", the path only in `locations`/`title`, and NO
 * raw_input. The live builder synthesizes a `file_path` input from the location
 * so the read card derives a proper "Read <path>" title (instead of falling back
 * to "read: <output>") — matching how a normal Read tool renders.
 */
describe("ConversationRuntimeProvider codex read-commandAction input synthesis", () => {
  const runtimeHolder: {
    current: ReturnType<typeof useConversationRuntime> | undefined
  } = { current: undefined }

  function RuntimeCapture() {
    const runtime = useConversationRuntime()
    useEffect(() => {
      runtimeHolder.current = runtime
    })
    return null
  }

  beforeEach(() => {
    runtimeHolder.current = undefined
  })

  function readToolCall(
    rawInput: string | null,
    locations: unknown
  ): LiveMessage {
    return {
      id: "lm-read",
      role: "assistant",
      startedAt: 0,
      content: [
        {
          type: "tool_call",
          info: {
            tool_call_id: "tc-read-1",
            title: "Read file '/Users/x/SKILL.md'",
            kind: "read",
            status: "completed",
            content: null,
            raw_input: rawInput,
            raw_output_chunks: [],
            raw_output_total_bytes: 0,
            locations,
            meta: null,
            images: [],
          },
        },
      ],
    }
  }

  function firstToolUseInput(
    api: ReturnType<typeof useConversationRuntime>
  ): string | null | undefined {
    const block = api
      .getTimelineTurns(99)
      .flatMap((t) => t.turn.blocks)
      .find((b) => b.type === "tool_use")
    return block?.type === "tool_use" ? block.input_preview : undefined
  }

  it("synthesizes a file_path input from locations when raw_input is absent", () => {
    renderProvider(<RuntimeCapture />)
    const api = () => runtimeHolder.current!
    act(() => {
      api().setLiveMessage(
        99,
        readToolCall(null, [{ path: "/Users/x/SKILL.md" }]),
        true
      )
    })
    const input = firstToolUseInput(api())
    expect(input).toBeTruthy()
    expect(JSON.parse(input as string)).toEqual({
      file_path: "/Users/x/SKILL.md",
    })
  })

  it("keeps an explicit raw_input untouched (normal Read tool, no synthesis)", () => {
    renderProvider(<RuntimeCapture />)
    const api = () => runtimeHolder.current!
    const explicit = JSON.stringify({ file_path: "/real/input.ts" })
    act(() => {
      api().setLiveMessage(
        99,
        readToolCall(explicit, [{ path: "/Users/x/SKILL.md" }]),
        true
      )
    })
    expect(firstToolUseInput(api())).toBe(explicit)
  })

  it("leaves input null when there is no location path to synthesize from", () => {
    renderProvider(<RuntimeCapture />)
    const api = () => runtimeHolder.current!
    act(() => {
      api().setLiveMessage(99, readToolCall(null, null), true)
    })
    expect(firstToolUseInput(api())).toBeNull()
  })
})

/**
 * `getTimelineTurns` memoizes per conversation by session reference, so a
 * dispatch that updates conversation A leaves conversation B's timeline array
 * referentially identical. This is what lets MessageListView's `threadItems`
 * useMemo short-circuit for every tab except the one whose session actually
 * changed — neutralizing the cross-tab broadcast fan-out without unmounting
 * any session (tile mode keeps every active conversation mounted).
 */
describe("ConversationRuntimeProvider getTimelineTurns memoization", () => {
  const runtimeHolder: {
    current: ReturnType<typeof useConversationRuntime> | undefined
  } = { current: undefined }

  function RuntimeCapture() {
    const runtime = useConversationRuntime()
    useEffect(() => {
      runtimeHolder.current = runtime
    })
    return null
  }

  function userTurn(id: string): MessageTurn {
    return {
      id,
      role: "user",
      blocks: [{ type: "text", text: id }],
      timestamp: "2026-05-28T00:00:00.000Z",
    }
  }

  beforeEach(() => {
    runtimeHolder.current = undefined
  })

  it("returns a stable reference for a conversation untouched by an unrelated update, and a fresh reference for the one that changed", () => {
    renderProvider(<RuntimeCapture />)
    const api = () => runtimeHolder.current!

    // Seed two independent conversations.
    act(() => {
      api().appendOptimisticTurn(1, userTurn("a1"), "a1")
    })
    act(() => {
      api().appendOptimisticTurn(2, userTurn("b1"), "b1")
    })

    // Prime the cache for both.
    const timeline1Before = api().getTimelineTurns(1)
    const timeline2Before = api().getTimelineTurns(2)
    expect(timeline1Before).toHaveLength(1)
    expect(timeline2Before).toHaveLength(1)

    // Update only conversation 1.
    act(() => {
      api().appendOptimisticTurn(1, userTurn("a2"), "a2")
    })

    const timeline1After = api().getTimelineTurns(1)
    const timeline2After = api().getTimelineTurns(2)

    // Conversation 2 was untouched → identical array reference (cache hit).
    expect(timeline2After).toBe(timeline2Before)
    // Conversation 1 changed → new reference and new content.
    expect(timeline1After).not.toBe(timeline1Before)
    expect(timeline1After).toHaveLength(2)
  })

  it("returns a stable empty-array reference for an unknown conversation", () => {
    renderProvider(<RuntimeCapture />)
    const first = runtimeHolder.current!.getTimelineTurns(12345)
    const second = runtimeHolder.current!.getTimelineTurns(67890)
    expect(first).toHaveLength(0)
    expect(second).toBe(first)
  })
})

describe("ConversationRuntimeProvider removeOptimisticTurn (bounce rollback)", () => {
  const runtimeHolder: {
    current: ReturnType<typeof useConversationRuntime> | undefined
  } = { current: undefined }

  function RuntimeCapture() {
    const runtime = useConversationRuntime()
    useEffect(() => {
      runtimeHolder.current = runtime
    })
    return null
  }

  function userTurn(id: string): MessageTurn {
    return {
      id,
      role: "user",
      blocks: [{ type: "text", text: id }],
      timestamp: "2026-05-28T00:00:00.000Z",
    }
  }

  beforeEach(() => {
    runtimeHolder.current = undefined
  })

  it("removes the turn by id and resets syncState to idle when none remain", () => {
    renderProvider(<RuntimeCapture />)
    const api = () => runtimeHolder.current!

    act(() => {
      api().appendOptimisticTurn(7, userTurn("t1"), "t1")
    })
    expect(api().getSession(7)?.optimisticTurns).toHaveLength(1)
    expect(api().getSession(7)?.syncState).toBe("awaiting_persist")

    act(() => {
      api().removeOptimisticTurn(7, "t1")
    })
    // Optimistic turn rolled back, and awaiting_persist cleared so the next
    // detail fetch reconciles cleanly instead of preserving a stale turn.
    expect(api().getSession(7)?.optimisticTurns).toHaveLength(0)
    expect(api().getSession(7)?.syncState).toBe("idle")
  })

  it("keeps awaiting_persist while another optimistic turn is still in flight", () => {
    renderProvider(<RuntimeCapture />)
    const api = () => runtimeHolder.current!

    act(() => {
      api().appendOptimisticTurn(8, userTurn("a"), "a")
    })
    act(() => {
      api().appendOptimisticTurn(8, userTurn("b"), "b")
    })
    act(() => {
      api().removeOptimisticTurn(8, "a")
    })
    const session = api().getSession(8)
    expect(session?.optimisticTurns.map((t) => t.id)).toEqual(["b"])
    expect(session?.syncState).toBe("awaiting_persist")
  })

  it("is a no-op for an unknown id", () => {
    renderProvider(<RuntimeCapture />)
    const api = () => runtimeHolder.current!

    act(() => {
      api().appendOptimisticTurn(9, userTurn("keep"), "keep")
    })
    act(() => {
      api().removeOptimisticTurn(9, "does-not-exist")
    })
    const after = api().getSession(9)
    expect(after?.optimisticTurns.map((t) => t.id)).toEqual(["keep"])
    expect(after?.syncState).toBe("awaiting_persist")
  })
})

/**
 * Delegation-child viewer projection in `getTimelineTurns`. When the sub-agent
 * dialog marks a session `liveOwnsActiveTurn` and supplies the kickoff task:
 *   - the persisted copy of the reply is stripped while a live/local reply
 *     owns the turn (no partial-plus-stream duplicate), and
 *   - the kickoff USER turn is synthesized from the known task text while the
 *     async JSONL transcript still lags — then automatically replaced by the
 *     real persisted user turn once it lands (no duplicate, no cleanup).
 */
describe("ConversationRuntimeProvider delegation kickoff projection", () => {
  const runtimeHolder: {
    current: ReturnType<typeof useConversationRuntime> | undefined
  } = { current: undefined }

  function RuntimeCapture() {
    const runtime = useConversationRuntime()
    useEffect(() => {
      runtimeHolder.current = runtime
    })
    return null
  }

  function assistantTurn(id: string): MessageTurn {
    return {
      id,
      role: "assistant",
      blocks: [{ type: "text", text: id }],
      timestamp: "2026-05-28T00:00:00.000Z",
    }
  }

  function userTurn(id: string): MessageTurn {
    return {
      id,
      role: "user",
      blocks: [{ type: "text", text: id }],
      timestamp: "2026-05-28T00:00:00.000Z",
    }
  }

  function detailWithTurns(turns: MessageTurn[]): DbConversationDetail {
    return {
      summary: {
        id: 99,
        folder_id: 1,
        agent_type: "codex",
        title: "child",
        title_locked: false,
        status: "in_progress",
        kind: "regular",
        model: null,
        git_branch: null,
        external_id: "ext-1",
        message_count: turns.length,
        child_count: 0,
        created_at: "2026-05-28T00:00:00.000Z",
        updated_at: "2026-05-28T00:00:00.000Z",
        pinned_at: null,
      },
      turns,
      session_stats: null,
    }
  }

  beforeEach(() => {
    runtimeHolder.current = undefined
    mockGetFolderConversation.mockReset()
    // See the fetch-generation-guard describe's beforeEach above for why.
    mockGetFolderConversation.mockImplementation(() => new Promise(() => {}))
  })

  /** The live message the strip stands in for: one that IS showing the reply. */
  const streamingReply: LiveMessage = {
    id: "lm-streaming",
    role: "assistant",
    content: [{ type: "text", text: "working on it" }],
    startedAt: 0,
  }

  it("synthesizes the kickoff user turn (and strips the persisted reply) while the transcript has no user turn yet", async () => {
    // DB lags: only a partial assistant turn is persisted, no user turn.
    mockGetFolderConversation.mockResolvedValueOnce(
      detailWithTurns([assistantTurn("a1")])
    )
    renderProvider(<RuntimeCapture />)
    const api = () => runtimeHolder.current!

    act(() => {
      api().setLiveOwnsActiveTurn(99, true, "do the thing")
    })
    act(() => {
      api().setLiveMessage(99, streamingReply, true)
    })
    await act(async () => {
      api().refetchDetail(99, { preserveLive: true })
      await Promise.resolve()
    })

    const timeline = api().getTimelineTurns(99)
    // First item is the synthesized kickoff user turn from the known task.
    expect(timeline[0].key).toBe("kickoff-99")
    expect(timeline[0].turn.role).toBe("user")
    expect(timeline[0].turn.blocks[0]).toMatchObject({
      type: "text",
      text: "do the thing",
    })
    // The persisted partial assistant turn is stripped (live owns the reply).
    expect(
      timeline.some(
        (t) => t.phase === "persisted" && t.turn.role === "assistant"
      )
    ).toBe(false)
  })

  it("keeps the persisted reply while the live message is showing nothing", async () => {
    // The child's next turn has begun: `status_changed → prompting` put a fresh
    // `content: []` live message on the connection and the viewer bridged it,
    // but no chunk has arrived. Stripping the reply then leaves the dialog
    // showing a prompt with nothing under it.
    mockGetFolderConversation.mockResolvedValueOnce(
      detailWithTurns([userTurn("u1"), assistantTurn("a1")])
    )
    renderProvider(<RuntimeCapture />)
    const api = () => runtimeHolder.current!

    act(() => {
      api().setLiveOwnsActiveTurn(99, true, "do the thing")
    })
    act(() => {
      api().setLiveMessage(99, LIVE_MSG, true)
    })
    await act(async () => {
      api().refetchDetail(99, { preserveLive: true })
      await Promise.resolve()
    })

    expect(
      api()
        .getTimelineTurns(99)
        .map((t) => t.turn.id)
    ).toEqual(["u1", "a1"])
  })

  it("uses the real persisted user turn instead of synthesizing once it has landed", async () => {
    mockGetFolderConversation.mockResolvedValueOnce(
      detailWithTurns([userTurn("u1"), assistantTurn("a1")])
    )
    renderProvider(<RuntimeCapture />)
    const api = () => runtimeHolder.current!

    act(() => {
      api().setLiveOwnsActiveTurn(99, true, "do the thing")
    })
    act(() => {
      api().setLiveMessage(99, LIVE_MSG, true)
    })
    await act(async () => {
      api().refetchDetail(99, { preserveLive: true })
      await Promise.resolve()
    })

    const timeline = api().getTimelineTurns(99)
    // Exactly one user turn, and it's the authentic persisted one — no synthetic.
    const users = timeline.filter((t) => t.turn.role === "user")
    expect(users).toHaveLength(1)
    expect(users[0].turn.id).toBe("u1")
    expect(timeline.some((t) => t.key === "kickoff-99")).toBe(false)
  })

  it("keeps the adopted local reply and dedupes the persisted copy once [user, assistant] lands (reopen-after-completion)", async () => {
    // The persisted transcript catches up only after the adoption already ran.
    mockGetFolderConversation.mockResolvedValueOnce(
      detailWithTurns([userTurn("u1"), assistantTurn("a1")])
    )
    renderProvider(<RuntimeCapture />)
    const api = () => runtimeHolder.current!

    // Simulate the adopt-settled-reply path the dialog runs on reopen: mark the
    // viewer, bridge the retained reply as live, promote it to a completed
    // local turn.
    const liveReply: LiveMessage = {
      id: "lr-1",
      role: "assistant",
      content: [{ type: "text", text: "final reply" }],
      startedAt: 0,
    }
    act(() => {
      api().setLiveOwnsActiveTurn(99, true, "do the thing")
    })
    act(() => {
      api().setLiveMessage(99, liveReply, true)
    })
    act(() => {
      api().completeTurn(99, liveReply)
    })
    await act(async () => {
      api().refetchDetail(99, { preserveLive: true })
      await Promise.resolve()
    })

    const timeline = api().getTimelineTurns(99)
    const users = timeline.filter((t) => t.turn.role === "user")
    const assistants = timeline.filter((t) => t.turn.role === "assistant")
    // Exactly one user (the real persisted one) and one assistant (the adopted
    // local reply; the persisted copy is stripped) — no duplication, no blank.
    expect(users).toHaveLength(1)
    expect(users[0].turn.id).toBe("u1")
    expect(assistants).toHaveLength(1)
    expect(timeline.some((t) => t.key === "kickoff-99")).toBe(false)
  })

  it("does not synthesize a kickoff for a normal (non-live-owned) session", async () => {
    mockGetFolderConversation.mockResolvedValueOnce(
      detailWithTurns([assistantTurn("a1")])
    )
    renderProvider(<RuntimeCapture />)
    const api = () => runtimeHolder.current!

    // No setLiveOwnsActiveTurn → ordinary panel. Even with a kickoff-less
    // assistant-only transcript, nothing is synthesized or stripped.
    await act(async () => {
      api().refetchDetail(99, { preserveLive: true })
      await Promise.resolve()
    })

    const timeline = api().getTimelineTurns(99)
    expect(timeline.some((t) => t.key === "kickoff-99")).toBe(false)
    expect(timeline.some((t) => t.turn.role === "assistant")).toBe(true)
  })
})

/**
 * Streaming/local turn dedup in `getTimelineTurns`. A premature or duplicate
 * COMPLETE_TURN (e.g. the background `turn_complete` listener in
 * ConversationDetailPanel racing the panel's own promotion) promotes a snapshot
 * of the in-flight turn into `localTurns` while the SAME liveMessage keeps
 * streaming and is re-bridged. Both are built from that one liveMessage, so
 * they share `live-<cid>-<liveMessageId>` turn ids. The timeline must surface
 * the turn exactly once (the live copy wins), never duplicated — otherwise
 * `mergeConsecutiveAssistantTurns` flat-maps the same parts twice and React
 * throws `Encountered two children with the same key, tc-<toolCallId>`.
 */
describe("ConversationRuntimeProvider streaming/local turn dedup", () => {
  const runtimeHolder: {
    current: ReturnType<typeof useConversationRuntime> | undefined
  } = { current: undefined }

  function RuntimeCapture() {
    const runtime = useConversationRuntime()
    useEffect(() => {
      runtimeHolder.current = runtime
    })
    return null
  }

  beforeEach(() => {
    runtimeHolder.current = undefined
  })

  it("drops the promoted snapshot when the same liveMessage is still streaming (no duplicate turn id)", () => {
    const liveMsg: LiveMessage = {
      id: "lm-dup",
      role: "assistant",
      content: [{ type: "text", text: "streaming reply" }],
      startedAt: 0,
    }
    renderProvider(<RuntimeCapture />)
    const api = () => runtimeHolder.current!

    // Bridge the live turn, promote it (the premature COMPLETE_TURN), then the
    // mirror effect re-bridges the SAME liveMessage while still "streaming".
    act(() => {
      api().setLiveMessage(99, liveMsg, true)
    })
    act(() => {
      api().completeTurn(99, liveMsg)
    })
    act(() => {
      api().setLiveMessage(99, liveMsg, true)
    })

    const timeline = api().getTimelineTurns(99)
    const ids = timeline.map((t) => t.turn.id)
    // The turn id appears exactly once; the duplicate localTurns snapshot is
    // filtered out and the streaming copy survives.
    expect(ids.filter((id) => id === "live-99-lm-dup")).toHaveLength(1)
    expect(new Set(ids).size).toBe(ids.length)
    expect(timeline.find((t) => t.turn.id === "live-99-lm-dup")?.phase).toBe(
      "streaming"
    )
  })

  it("keeps both turns when a completed turn and a different streaming turn coexist (distinct ids, no false dedup)", () => {
    const turnA: LiveMessage = {
      id: "lm-a",
      role: "assistant",
      content: [{ type: "text", text: "turn A" }],
      startedAt: 0,
    }
    const turnB: LiveMessage = {
      id: "lm-b",
      role: "assistant",
      content: [{ type: "text", text: "turn B" }],
      startedAt: 0,
    }
    renderProvider(<RuntimeCapture />)
    const api = () => runtimeHolder.current!

    // Turn A streams then completes (promoted to localTurns, liveMessage cleared
    // by COMPLETE_TURN); turn B then starts streaming with a fresh liveMessage.
    act(() => {
      api().setLiveMessage(99, turnA, true)
    })
    act(() => {
      api().completeTurn(99, turnA)
    })
    act(() => {
      api().setLiveMessage(99, turnB, true)
    })

    const timeline = api().getTimelineTurns(99)
    const assistantIds = timeline
      .filter((t) => t.turn.role === "assistant")
      .map((t) => t.turn.id)
    // Both turns survive — distinct liveMessage ids never collide.
    expect(assistantIds).toContain("live-99-lm-a")
    expect(assistantIds).toContain("live-99-lm-b")
    expect(new Set(assistantIds).size).toBe(assistantIds.length)
  })

  it("does not accumulate duplicate localTurns when the same live turn is re-promoted after a re-bridge (final completion, liveMessage cleared)", () => {
    const liveMsg: LiveMessage = {
      id: "lm-dup2",
      role: "assistant",
      content: [{ type: "text", text: "streaming reply" }],
      startedAt: 0,
    }
    renderProvider(<RuntimeCapture />)
    const api = () => runtimeHolder.current!

    // Premature promote, re-bridge of the SAME liveMessage, then a final
    // promote. COMPLETE_TURN must not append a second copy of the turn, and the
    // final promote clears liveMessage so there is no streaming turn left to
    // filter against — the dedup has to already hold in localTurns.
    act(() => {
      api().setLiveMessage(99, liveMsg, true)
    })
    act(() => {
      api().completeTurn(99, liveMsg)
    })
    act(() => {
      api().setLiveMessage(99, liveMsg, true)
    })
    act(() => {
      api().completeTurn(99, liveMsg)
    })

    const session = api().getSession(99)
    // liveMessage is cleared by the final COMPLETE_TURN…
    expect(session?.liveMessage).toBeNull()
    // …and localTurns holds the turn exactly once (no re-promotion duplicate).
    expect(
      session?.localTurns.filter((t) => t.id === "live-99-lm-dup2")
    ).toHaveLength(1)

    const ids = api()
      .getTimelineTurns(99)
      .map((t) => t.turn.id)
    expect(ids.filter((id) => id === "live-99-lm-dup2")).toHaveLength(1)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

/**
 * Cross-client VIEWER user-turn synthesis (Bug 2). When another client sends a
 * prompt, this client (a viewer of the shared connection) only receives the
 * assistant stream — `appendViewerUserTurn` synthesizes the sender's user turn
 * so the reply doesn't render headless. It reuses the optimistic→local
 * promotion machinery, is a no-op on the SENDER (which renders its own
 * optimistic turn), and is idempotent by turn id.
 */
describe("ConversationRuntimeProvider viewer user-turn synthesis", () => {
  const runtimeHolder: {
    current: ReturnType<typeof useConversationRuntime> | undefined
  } = { current: undefined }

  function RuntimeCapture() {
    const runtime = useConversationRuntime()
    useEffect(() => {
      runtimeHolder.current = runtime
    })
    return null
  }

  function userTurn(id: string): MessageTurn {
    return {
      id,
      role: "user",
      blocks: [{ type: "text", text: id }],
      timestamp: "2026-05-28T00:00:00.000Z",
    }
  }

  function assistantTurn(id: string): MessageTurn {
    return {
      id,
      role: "assistant",
      blocks: [{ type: "text", text: id }],
      timestamp: "2026-05-28T00:00:00.000Z",
    }
  }

  function detailWithTurns(turns: MessageTurn[]): DbConversationDetail {
    return {
      summary: {
        id: 99,
        folder_id: 1,
        agent_type: "codex",
        title: "c",
        title_locked: false,
        status: "in_progress",
        kind: "regular",
        model: null,
        git_branch: null,
        external_id: "ext-1",
        message_count: turns.length,
        child_count: 0,
        created_at: "2026-05-28T00:00:00.000Z",
        updated_at: "2026-05-28T00:00:00.000Z",
        pinned_at: null,
      },
      turns,
      session_stats: null,
    }
  }

  const LIVE: LiveMessage = {
    id: "lm-v",
    role: "assistant",
    content: [],
    startedAt: 0,
  }

  beforeEach(() => {
    runtimeHolder.current = undefined
    mockGetFolderConversation.mockReset()
    // See the fetch-generation-guard describe's beforeEach above for why.
    mockGetFolderConversation.mockImplementation(() => new Promise(() => {}))
  })

  it("synthesizes the sender's user turn for a viewer", () => {
    renderProvider(<RuntimeCapture />)
    const api = () => runtimeHolder.current!
    act(() => {
      api().appendViewerUserTurn(99, userTurn("user-c-5"))
    })
    const users = api()
      .getTimelineTurns(99)
      .filter((t) => t.turn.role === "user")
    expect(users).toHaveLength(1)
    expect(users[0].turn.id).toBe("user-c-5")
  })

  it("is a NO-OP on the sender — its echo shares the optimistic turn id (exact dedup)", () => {
    renderProvider(<RuntimeCapture />)
    const api = () => runtimeHolder.current!
    // Sender appended its own optimistic turn on send; the UI threaded that id
    // to the backend, which echoes it as the user_message message_id…
    act(() => {
      api().appendOptimisticTurn(99, userTurn("optimistic-x"), "tok")
    })
    // …so the broadcast echo (SAME id) dedups — no second user turn.
    act(() => {
      api().appendViewerUserTurn(99, userTurn("optimistic-x"))
    })
    const users = api()
      .getTimelineTurns(99)
      .filter((t) => t.turn.role === "user")
    expect(users).toHaveLength(1)
    expect(users[0].turn.id).toBe("optimistic-x")
  })

  it("does NOT suppress a different sender's prompt when this client has an unrelated optimistic turn (co-control)", () => {
    renderProvider(<RuntimeCapture />)
    const api = () => runtimeHolder.current!
    // This client has its own in-flight optimistic turn (it sent something)…
    act(() => {
      api().appendOptimisticTurn(99, userTurn("mine-1"), "tok")
    })
    // …and ANOTHER client's user_message arrives with a DIFFERENT id. Exact-id
    // dedup must NOT suppress it (a broad "has optimistic turns" guard would).
    act(() => {
      api().appendViewerUserTurn(99, userTurn("theirs-2"))
    })
    const users = api()
      .getTimelineTurns(99)
      .filter((t) => t.turn.role === "user")
    expect(users.map((u) => u.turn.id)).toEqual(["mine-1", "theirs-2"])
  })

  it("is idempotent: a re-delivered user_message after promotion does not duplicate", () => {
    renderProvider(<RuntimeCapture />)
    const api = () => runtimeHolder.current!
    act(() => {
      api().appendViewerUserTurn(99, userTurn("user-c-5"))
    })
    // Turn completes → the synthesized user turn promotes into localTurns.
    act(() => {
      api().completeTurn(99, LIVE)
    })
    // A snapshot re-delivers the SAME user_message — dedups against localTurns.
    act(() => {
      api().appendViewerUserTurn(99, userTurn("user-c-5"))
    })
    const users = api()
      .getTimelineTurns(99)
      .filter((t) => t.turn.role === "user")
    expect(users).toHaveLength(1)
    expect(users[0].turn.id).toBe("user-c-5")
  })

  it("promotes the synthesized user turn to a local turn on completion (survives the live→local handoff)", () => {
    renderProvider(<RuntimeCapture />)
    const api = () => runtimeHolder.current!
    act(() => {
      api().appendViewerUserTurn(99, userTurn("user-c-5"))
    })
    act(() => {
      api().completeTurn(99, LIVE)
    })
    const session = api().getSession(99)
    expect(session?.optimisticTurns).toHaveLength(0)
    expect(session?.localTurns.some((t) => t.id === "user-c-5")).toBe(true)
  })

  it("synthesizes the CURRENT turn's user message even when the persisted transcript already has prior user turns (multi-turn viewer)", async () => {
    // Viewer cold-opened a conversation WITH history, then the owner sends a
    // new turn. The prior persisted user turn must NOT suppress the synthesis —
    // this is the multi-turn case a `!persistedHasUser` guard would break.
    mockGetFolderConversation.mockResolvedValueOnce(
      detailWithTurns([userTurn("u-old"), assistantTurn("a-old")])
    )
    renderProvider(<RuntimeCapture />)
    const api = () => runtimeHolder.current!
    await act(async () => {
      api().refetchDetail(99)
      await Promise.resolve()
    })
    act(() => {
      api().appendViewerUserTurn(99, userTurn("user-c-9"))
    })
    const users = api()
      .getTimelineTurns(99)
      .filter((t) => t.turn.role === "user")
    expect(users.map((u) => u.turn.id)).toEqual(["u-old", "user-c-9"])
  })

  it("suppresses the synthesized turn when the SAME prompt is already persisted under a different id (mid-stream cross-client duplicate)", async () => {
    // The reported bug: a viewer opens the conversation mid-stream AFTER the
    // owner's prompt was already written to the JSONL transcript. History
    // (`detail.turns`) carries it under the parser-assigned id, while the live
    // broadcast synthesizes the same prompt under the unrelated `message_id`.
    // Same content, different ids → without content dedup the user message
    // renders twice. The fetch lands BEFORE the synthesized turn here.
    mockGetFolderConversation.mockResolvedValueOnce(
      detailWithTurns([
        {
          id: "jsonl-xyz",
          role: "user",
          blocks: [{ type: "text", text: "hello" }],
          timestamp: "2026-05-28T00:00:00.000Z",
        },
      ])
    )
    renderProvider(<RuntimeCapture />)
    const api = () => runtimeHolder.current!
    await act(async () => {
      api().refetchDetail(99)
      await Promise.resolve()
    })
    act(() => {
      api().appendViewerUserTurn(99, {
        id: "msg-abc",
        role: "user",
        blocks: [{ type: "text", text: "hello" }],
        timestamp: "2026-05-28T00:00:01.000Z",
      })
    })
    const users = api()
      .getTimelineTurns(99)
      .filter((t) => t.turn.role === "user")
    expect(users).toHaveLength(1)
    expect(users[0].turn.id).toBe("jsonl-xyz")
  })

  it("does not duplicate when the synthesized turn is added BEFORE the persisted copy lands (fetch clears the viewer's ephemeral turn)", async () => {
    // The complementary ordering: the viewer synthesizes the user turn first
    // (from the snapshot/event), THEN the history fetch resolves with the same
    // prompt under its parser id. FETCH_DETAIL_SUCCESS clears the viewer's
    // ephemeral optimistic turn (it never sets awaiting_persist), so the
    // persisted copy cleanly replaces it — exactly one user turn remains.
    mockGetFolderConversation.mockResolvedValueOnce(
      detailWithTurns([
        {
          id: "jsonl-xyz",
          role: "user",
          blocks: [{ type: "text", text: "hello" }],
          timestamp: "2026-05-28T00:00:00.000Z",
        },
      ])
    )
    renderProvider(<RuntimeCapture />)
    const api = () => runtimeHolder.current!
    act(() => {
      api().appendViewerUserTurn(99, {
        id: "msg-abc",
        role: "user",
        blocks: [{ type: "text", text: "hello" }],
        timestamp: "2026-05-28T00:00:01.000Z",
      })
    })
    await act(async () => {
      api().refetchDetail(99)
      await Promise.resolve()
    })
    const users = api()
      .getTimelineTurns(99)
      .filter((t) => t.turn.role === "user")
    expect(users).toHaveLength(1)
    expect(users[0].turn.id).toBe("jsonl-xyz")
  })

  it("keeps a NEW in-flight prompt visible when an earlier COMPLETED turn has identical text (repeated 'continue', not yet persisted)", async () => {
    // Codex review case: a prior 'continue' was already answered (its assistant
    // reply is persisted right after it), then the owner sends ANOTHER
    // 'continue'. While that new prompt is still streaming, the transcript ends
    // at the COMPLETED reply and has not captured the new prompt yet. The viewer
    // must keep the synthesized turn — only a prompt sitting as the LAST turn is
    // treated as the persisted copy, so a completed earlier twin never suppresses
    // it. Suppressing here would hide a message the user actually sent.
    mockGetFolderConversation.mockResolvedValueOnce(
      detailWithTurns([
        {
          id: "jsonl-u1",
          role: "user",
          blocks: [{ type: "text", text: "continue" }],
          timestamp: "2026-05-28T00:00:00.000Z",
        },
        {
          id: "jsonl-a1",
          role: "assistant",
          blocks: [{ type: "text", text: "done" }],
          timestamp: "2026-05-28T00:00:01.000Z",
        },
      ])
    )
    renderProvider(<RuntimeCapture />)
    const api = () => runtimeHolder.current!
    await act(async () => {
      api().refetchDetail(99)
      await Promise.resolve()
    })
    act(() => {
      api().appendViewerUserTurn(99, {
        id: "msg-new",
        role: "user",
        blocks: [{ type: "text", text: "continue" }],
        timestamp: "2026-05-28T00:00:02.000Z",
      })
    })
    const users = api()
      .getTimelineTurns(99)
      .filter((t) => t.turn.role === "user")
    expect(users.map((u) => u.turn.id)).toEqual(["jsonl-u1", "msg-new"])
  })

  it("suppresses the synthesized copy of a repeated prompt once it is itself persisted as the trailing turn", async () => {
    // The complement to the case above: the SAME 'continue' is repeated, but the
    // new prompt has now landed in the transcript as the trailing user turn. The
    // synthesized copy is redundant and must be dropped — even though an
    // identical earlier 'continue' also exists in history — so the timeline shows
    // the two persisted prompts and no third (synthesized) duplicate.
    mockGetFolderConversation.mockResolvedValueOnce(
      detailWithTurns([
        {
          id: "jsonl-u1",
          role: "user",
          blocks: [{ type: "text", text: "continue" }],
          timestamp: "2026-05-28T00:00:00.000Z",
        },
        {
          id: "jsonl-a1",
          role: "assistant",
          blocks: [{ type: "text", text: "done" }],
          timestamp: "2026-05-28T00:00:01.000Z",
        },
        {
          id: "jsonl-u2",
          role: "user",
          blocks: [{ type: "text", text: "continue" }],
          timestamp: "2026-05-28T00:00:02.000Z",
        },
      ])
    )
    renderProvider(<RuntimeCapture />)
    const api = () => runtimeHolder.current!
    await act(async () => {
      api().refetchDetail(99)
      await Promise.resolve()
    })
    act(() => {
      api().appendViewerUserTurn(99, {
        id: "msg-new",
        role: "user",
        blocks: [{ type: "text", text: "continue" }],
        timestamp: "2026-05-28T00:00:03.000Z",
      })
    })
    const users = api()
      .getTimelineTurns(99)
      .filter((t) => t.turn.role === "user")
    expect(users.map((u) => u.turn.id)).toEqual(["jsonl-u1", "jsonl-u2"])
  })

  it("dedups against a backend-stamped in-flight user turn that ends in a partial assistant (OpenCode/Gemini shape)", async () => {
    // OpenCode/Gemini persist a PARTIAL assistant turn mid-stream, so the
    // transcript tail is [user X, partial assistant Y] — the content guard
    // (which only matches a trailing USER turn) can't see X. Instead the detail
    // endpoint stamps the persisted in-flight user turn with the broadcast
    // message_id (`apply_in_flight_message_id`), so the synthesized copy dedups
    // by exact id and stays in its correct position BEFORE the partial reply.
    mockGetFolderConversation.mockResolvedValueOnce(
      detailWithTurns([
        {
          id: "msg-live",
          role: "user",
          blocks: [{ type: "text", text: "hello" }],
          timestamp: "2026-05-28T00:00:00.000Z",
        },
        {
          id: "jsonl-a1",
          role: "assistant",
          blocks: [{ type: "text", text: "partial…" }],
          timestamp: "2026-05-28T00:00:01.000Z",
        },
      ])
    )
    renderProvider(<RuntimeCapture />)
    const api = () => runtimeHolder.current!
    await act(async () => {
      api().refetchDetail(99)
      await Promise.resolve()
    })
    act(() => {
      api().appendViewerUserTurn(99, {
        id: "msg-live",
        role: "user",
        blocks: [{ type: "text", text: "hello" }],
        timestamp: "2026-05-28T00:00:02.000Z",
      })
    })
    const timeline = api().getTimelineTurns(99)
    const users = timeline.filter((t) => t.turn.role === "user")
    expect(users).toHaveLength(1)
    expect(users[0].turn.id).toBe("msg-live")
    // Ordering preserved: the user turn renders before the partial reply.
    expect(timeline.map((t) => t.turn.id)).toEqual(["msg-live", "jsonl-a1"])
  })

  it("keeps the SENDER's stamped prompt ordered before a partial reply when its optimistic copy is preserved across a mid-turn refetch", async () => {
    // Sender path: the client sent the prompt, so it holds its OWN optimistic
    // turn (id == the message_id it threaded to the backend) and is in
    // `awaiting_persist`, which makes FETCH_DETAIL_SUCCESS PRESERVE optimistic
    // turns. If a refetch lands mid-turn with OpenCode/Gemini stamped detail
    // shaped [user id=M, partial assistant], the timeline holds the persisted
    // user(M), the partial assistant, AND the preserved optimistic user(M). The
    // role-aware dedup must keep the persisted (first) user copy so the prompt
    // stays before its own streaming reply — not the later optimistic copy.
    mockGetFolderConversation.mockResolvedValueOnce(
      detailWithTurns([
        {
          id: "msg-M",
          role: "user",
          blocks: [{ type: "text", text: "hello" }],
          timestamp: "2026-05-28T00:00:00.000Z",
        },
        {
          id: "jsonl-a1",
          role: "assistant",
          blocks: [{ type: "text", text: "partial…" }],
          timestamp: "2026-05-28T00:00:01.000Z",
        },
      ])
    )
    renderProvider(<RuntimeCapture />)
    const api = () => runtimeHolder.current!
    // Sender's own optimistic turn → syncState becomes awaiting_persist.
    act(() => {
      api().appendOptimisticTurn(
        99,
        {
          id: "msg-M",
          role: "user",
          blocks: [{ type: "text", text: "hello" }],
          timestamp: "2026-05-28T00:00:02.000Z",
        },
        "tok"
      )
    })
    expect(api().getSession(99)?.syncState).toBe("awaiting_persist")
    await act(async () => {
      api().refetchDetail(99)
      await Promise.resolve()
    })
    // Optimistic copy is preserved (awaiting_persist), so the collision is real.
    expect(api().getSession(99)?.optimisticTurns).toHaveLength(1)
    const timeline = api().getTimelineTurns(99)
    const users = timeline.filter((t) => t.turn.role === "user")
    expect(users).toHaveLength(1)
    expect(timeline.map((t) => t.turn.id)).toEqual(["msg-M", "jsonl-a1"])
  })

  it("keeps a repeated identical prompt visible across an awaiting_persist refetch when the prior prompt predates the turn (no false backend stamp)", async () => {
    // The repeated-'continue' case for the SENDER. A prior 'continue' was sent in
    // an earlier turn, so the backend's recency check refuses to stamp that prior
    // user turn — it stays under its parser id. The sender's new optimistic
    // 'continue' (id=msg-new) therefore does NOT collide, and survives both the
    // awaiting_persist refetch and the turn completion. (Were the prior turn
    // wrongly stamped msg-new, keep-first would have hidden the new prompt.)
    mockGetFolderConversation.mockResolvedValueOnce(
      detailWithTurns([
        {
          id: "jsonl-u1",
          role: "user",
          blocks: [{ type: "text", text: "continue" }],
          timestamp: "2026-05-28T00:00:00.000Z",
        },
        {
          id: "jsonl-a1",
          role: "assistant",
          blocks: [{ type: "text", text: "done" }],
          timestamp: "2026-05-28T00:00:01.000Z",
        },
      ])
    )
    renderProvider(<RuntimeCapture />)
    const api = () => runtimeHolder.current!
    act(() => {
      api().appendOptimisticTurn(
        99,
        {
          id: "msg-new",
          role: "user",
          blocks: [{ type: "text", text: "continue" }],
          timestamp: "2026-05-28T00:00:02.000Z",
        },
        "tok"
      )
    })
    await act(async () => {
      api().refetchDetail(99)
      await Promise.resolve()
    })
    // New prompt is visible right after the refetch…
    expect(
      api()
        .getTimelineTurns(99)
        .filter((t) => t.turn.role === "user")
        .map((u) => u.turn.id)
    ).toEqual(["jsonl-u1", "msg-new"])
    // …and survives completion (promoted into localTurns, not dropped).
    act(() => {
      api().completeTurn(99, LIVE)
    })
    expect(
      api()
        .getTimelineTurns(99)
        .filter((t) => t.turn.role === "user")
        .map((u) => u.turn.id)
    ).toEqual(["jsonl-u1", "msg-new"])
  })

  it("hides the persisted PARTIAL in-flight reply while the live stream shows it (no doubled first reasoning)", async () => {
    // The OpenCode/Gemini viewer symptom: mid-stream the persisted tail is
    // [user msg-M (stamped), partial assistant] where the partial holds only the
    // first reasoning block. The live stream carries the same reply in full under
    // a `live-…` id; rendered together, mergeConsecutiveAssistantTurns would show
    // the first reasoning twice. While liveMessage is in hand the persisted
    // partial is suppressed, so only the live reply renders.
    mockGetFolderConversation.mockResolvedValueOnce({
      // The backend stamped the in-flight prompt and reports its id.
      ...detailWithTurns([
        userTurn("msg-M"),
        {
          id: "jsonl-a1",
          role: "assistant",
          blocks: [{ type: "thinking", text: "Let me think about this…" }],
          timestamp: "2026-05-28T00:00:01.000Z",
        },
      ]),
      in_flight_user_turn_id: "msg-M",
    })
    renderProvider(<RuntimeCapture />)
    const api = () => runtimeHolder.current!
    await act(async () => {
      api().refetchDetail(99)
      await Promise.resolve()
    })
    // The viewer's synthesized prompt is suppressed here (the persisted copy
    // already carries the broadcast id), so the suppression relies on the
    // backend-reported id, not the optimistic turn.
    act(() => {
      api().appendViewerUserTurn(99, userTurn("msg-M"))
    })
    // The live reply is in hand (carries the same reasoning, plus the rest).
    act(() => {
      api().setLiveMessage(
        99,
        {
          id: "lm-v",
          role: "assistant",
          content: [{ type: "thinking", text: "Let me think about this…" }],
          startedAt: 0,
        },
        true
      )
    })
    const timeline = api().getTimelineTurns(99)
    // The persisted partial is gone; the prompt shows once and the live reply
    // (a single `live-…` turn) carries the reasoning — not doubled.
    expect(timeline.map((t) => t.turn.id)).toEqual(["msg-M", "live-99-lm-v"])
  })

  it("keeps an earlier COMPLETED reply visible when the new in-flight prompt is not yet persisted (anchors on the stamped prompt, not the last user turn)", async () => {
    // The dangerous shape: the viewer's detail still ends at a PRIOR completed
    // round [u-old, a-old] because the new prompt isn't persisted yet. The
    // in-flight synthesized prompt (user-new) matches NO persisted user turn, so
    // the suppression must not fire — dropping a-old here would hide a completed
    // reply, the forbidden outcome.
    mockGetFolderConversation.mockResolvedValueOnce(
      detailWithTurns([userTurn("u-old"), assistantTurn("a-old")])
    )
    renderProvider(<RuntimeCapture />)
    const api = () => runtimeHolder.current!
    await act(async () => {
      api().refetchDetail(99)
      await Promise.resolve()
    })
    act(() => {
      api().appendViewerUserTurn(99, userTurn("user-new"))
    })
    act(() => {
      api().setLiveMessage(99, LIVE, true)
    })
    const ids = api()
      .getTimelineTurns(99)
      .map((t) => t.turn.id)
    expect(ids).toContain("a-old")
    expect(ids).toEqual(["u-old", "a-old", "user-new"])
  })

  it("does NOT hide the persisted reply when no live stream is in hand (never drops what it can't re-show)", async () => {
    // Suppression is gated on liveMessage: with none in hand (e.g. the
    // promote→refetch grace window, or a completed turn), the persisted reply is
    // the only copy and must stay visible — at worst a transient visible
    // duplicate, never a hidden turn.
    mockGetFolderConversation.mockResolvedValueOnce({
      ...detailWithTurns([userTurn("msg-M"), assistantTurn("jsonl-a1")]),
      // Even though the backend reports the in-flight prompt id…
      in_flight_user_turn_id: "msg-M",
    })
    renderProvider(<RuntimeCapture />)
    const api = () => runtimeHolder.current!
    await act(async () => {
      api().refetchDetail(99)
      await Promise.resolve()
    })
    act(() => {
      api().appendViewerUserTurn(99, userTurn("msg-M"))
    })
    // …no setLiveMessage — liveMessage stays null, so the gate keeps it visible.
    const ids = api()
      .getTimelineTurns(99)
      .map((t) => t.turn.id)
    expect(ids).toContain("jsonl-a1")
    expect(ids).toEqual(["msg-M", "jsonl-a1"])
  })

  it("never hides a completed reply when a STALE in_flight_user_turn_id meets a new live turn (self-heals via localTurns)", async () => {
    // Staleness residual: detail from turn N still reports in_flight_user_turn_id
    // = msg-M while a NEW turn (N+1) streams and detail hasn't been refetched. The
    // suppression can still hide the STALE persisted partial after msg-M — but
    // turn N's COMPLETED reply was promoted into localTurns, so it stays visible.
    // The stale projection is at most a transient, never a hidden completed turn.
    mockGetFolderConversation.mockResolvedValueOnce({
      ...detailWithTurns([userTurn("msg-M"), assistantTurn("a-M")]),
      in_flight_user_turn_id: "msg-M",
    })
    renderProvider(<RuntimeCapture />)
    const api = () => runtimeHolder.current!
    await act(async () => {
      api().refetchDetail(99)
      await Promise.resolve()
    })
    // Turn N streams, then completes → its full reply lands in localTurns.
    const replyN: LiveMessage = {
      id: "lm-N",
      role: "assistant",
      content: [{ type: "text", text: "done-N" }],
      startedAt: 0,
    }
    act(() => {
      api().setLiveMessage(99, replyN, true)
    })
    act(() => {
      api().completeTurn(99, replyN)
    })
    expect(
      api()
        .getSession(99)
        ?.localTurns.map((t) => t.id)
    ).toContain("live-99-lm-N")
    // A NEW turn (N+1) begins streaming; detail is still the stale turn-N copy.
    act(() => {
      api().setLiveMessage(
        99,
        {
          id: "lm-N1",
          role: "assistant",
          content: [{ type: "text", text: "streaming-N1" }],
          startedAt: 0,
        },
        true
      )
    })
    const ids = api()
      .getTimelineTurns(99)
      .map((t) => t.turn.id)
    // Turn N's COMPLETED reply (in localTurns) stays visible; only the stale
    // persisted partial "a-M" is suppressed — no completed turn is hidden.
    expect(ids).toContain("live-99-lm-N")
    expect(ids).not.toContain("a-M")
    expect(ids).toEqual(["msg-M", "live-99-lm-N", "live-99-lm-N1"])
  })

  it("does not let an id-colliding ASSISTANT turn suppress (or overwrite) a viewer prompt", async () => {
    // An id collision is only reachable via a client id that slipped into another
    // namespace, but it must never hide a prompt. The exact-id guard is role-
    // scoped (an assistant turn with this id does NOT suppress the synth) and the
    // timeline dedup keys by role+id (the two same-id turns are both kept).
    mockGetFolderConversation.mockResolvedValueOnce(
      detailWithTurns([assistantTurn("collide")])
    )
    renderProvider(<RuntimeCapture />)
    const api = () => runtimeHolder.current!
    await act(async () => {
      api().refetchDetail(99)
      await Promise.resolve()
    })
    act(() => {
      api().appendViewerUserTurn(99, userTurn("collide"))
    })
    const timeline = api().getTimelineTurns(99)
    expect(
      timeline.filter((t) => t.turn.role === "user").map((t) => t.turn.id)
    ).toEqual(["collide"])
    // Both survive — neither role overwrites the other in the id dedup.
    expect(timeline.map((t) => `${t.turn.role}:${t.turn.id}`)).toEqual([
      "assistant:collide",
      "user:collide",
    ])
  })

  it("a stale in-flight detail landing after completion does not clear the promoted reply (no hidden completed turn)", async () => {
    // turn N: in-flight detail loads, streams, completes → reply promoted into
    // localTurns.
    mockGetFolderConversation.mockResolvedValueOnce({
      ...detailWithTurns([userTurn("msg-M"), assistantTurn("a-M")]),
      in_flight_user_turn_id: "msg-M",
    })
    renderProvider(<RuntimeCapture />)
    const api = () => runtimeHolder.current!
    await act(async () => {
      api().refetchDetail(99)
      await Promise.resolve()
    })
    const replyN: LiveMessage = {
      id: "lm-N",
      role: "assistant",
      content: [{ type: "text", text: "done-N" }],
      startedAt: 0,
    }
    act(() => {
      api().setLiveMessage(99, replyN, true)
    })
    act(() => {
      api().completeTurn(99, replyN)
    })
    // A STALE, still-in-flight-stamped detail (the turn-N mid-snapshot) resolves
    // AFTER completion. Because it carries `in_flight_user_turn_id`, the reducer
    // must preserve the live buffers rather than wipe the promoted reply.
    mockGetFolderConversation.mockResolvedValueOnce({
      ...detailWithTurns([userTurn("msg-M"), assistantTurn("a-M")]),
      in_flight_user_turn_id: "msg-M",
    })
    await act(async () => {
      api().refetchDetail(99)
      await Promise.resolve()
    })
    expect(
      api()
        .getSession(99)
        ?.localTurns.map((t) => t.id)
    ).toContain("live-99-lm-N")
    // A new live turn (N+1) starts; the stale id would suppress "a-M".
    act(() => {
      api().setLiveMessage(
        99,
        {
          id: "lm-N1",
          role: "assistant",
          content: [{ type: "text", text: "streaming-N1" }],
          startedAt: 0,
        },
        true
      )
    })
    const ids = api()
      .getTimelineTurns(99)
      .map((t) => t.turn.id)
    // The completed reply survives via localTurns; only the stale partial hides.
    expect(ids).toContain("live-99-lm-N")
    expect(ids).not.toContain("a-M")
  })
})

describe("buildStreamingTurnsFromLiveMessage — orphan status provenance", () => {
  // The forward that lets the render layer drop an interrupted arg-less orphan
  // after it is promoted into localTurns at COMPLETE_TURN (see
  // dropEmptyInFlightToolCalls). Without it, the promoted block loses its ACP
  // status and the orphan re-inflates the "运行 N 个命令" count post-completion.
  it("forwards the ACP tool status onto the promoted tool_use block", () => {
    const blocks = buildStreamingTurnsFromLiveMessage(1, {
      id: "lm-orphan",
      role: "assistant",
      startedAt: 0,
      content: [
        {
          type: "tool_call",
          info: {
            tool_call_id: "tc-orphan",
            title: "bash",
            kind: "execute",
            status: "pending",
            content: null,
            raw_input: "{}",
            raw_output_chunks: [],
            raw_output_total_bytes: 0,
            locations: null,
            meta: null,
            images: [],
          },
        },
      ],
    }).turns.flatMap((t) => t.blocks)
    const toolUse = blocks.find((b) => b.type === "tool_use")
    expect(toolUse?.type === "tool_use" ? toolUse.status : "MISSING").toBe(
      "pending"
    )
  })
})

describe("buildStreamingTurnsFromLiveMessage — subagent transcript routing (claude-agent-acp ≥0.63)", () => {
  function toolInfo(overrides: Partial<ToolCallInfo> = {}): ToolCallInfo {
    return {
      tool_call_id: "toolu_x",
      title: "Bash",
      kind: "execute",
      status: "in_progress",
      content: null,
      raw_input: null,
      raw_output_chunks: [],
      raw_output_total_bytes: 0,
      locations: null,
      meta: null,
      images: [],
      ...overrides,
    }
  }
  const agentCall = (id: string): LiveContentBlock => ({
    type: "tool_call",
    info: toolInfo({ tool_call_id: id, title: "Agent", kind: "other" }),
  })
  const build = (
    content: LiveContentBlock[],
    opts?: { attachAgentTranscripts?: boolean }
  ) =>
    buildStreamingTurnsFromLiveMessage(
      1,
      { id: "lm-sub", role: "assistant", startedAt: 0, content },
      opts
    )

  it("routes parented text/thinking out of the main thread and attaches them in order", () => {
    const result = build([
      agentCall("toolu_agent"),
      { type: "thinking", text: "planning", parentToolUseId: "toolu_agent" },
      { type: "text", text: "found it", parentToolUseId: "toolu_agent" },
    ])
    const blocks = result.turns.flatMap((t) => t.blocks)
    // No main-thread text/thinking leaked.
    expect(blocks.some((b) => b.type === "text" || b.type === "thinking")).toBe(
      false
    )
    const carrier = blocks.find((b) => b.type === "tool_result")
    expect(
      carrier?.type === "tool_result" ? carrier.agent_transcript : null
    ).toEqual([
      { type: "thinking", text: "planning" },
      { type: "text", text: "found it" },
    ])
    // The carrier keeps the card in its running state.
    expect(result.inProgressToolCallIds.has("toolu_agent")).toBe(true)
  })

  it("does not split a new turn group on parented text after a completed tool", () => {
    const result = build([
      {
        type: "tool_call",
        info: toolInfo({ tool_call_id: "toolu_done", status: "completed" }),
      },
      agentCall("toolu_agent"),
      { type: "text", text: "sub prose", parentToolUseId: "toolu_agent" },
    ])
    expect(result.turns).toHaveLength(1)
  })

  it("keeps positional child capture alive across parented blocks", () => {
    // Agent (in progress) → subagent text → child tool call WITHOUT explicit
    // parent meta: the positional fallback must still nest the child.
    const result = build([
      agentCall("toolu_agent"),
      { type: "text", text: "sub prose", parentToolUseId: "toolu_agent" },
      {
        type: "tool_call",
        info: toolInfo({ tool_call_id: "toolu_child", title: "Read" }),
      },
    ])
    const blocks = result.turns.flatMap((t) => t.blocks)
    // The child folded into the agent card (no standalone tool_use for it).
    const standalone = blocks.filter(
      (b) => b.type === "tool_use" && b.tool_use_id === "toolu_child"
    )
    expect(standalone).toHaveLength(0)
    const carrier = blocks.find((b) => b.type === "tool_result")
    expect(
      carrier?.type === "tool_result"
        ? (carrier.agent_stats?.tool_calls ?? []).map((c) => c.tool_name)
        : []
    ).toEqual(["read"])
  })

  it("emits the carrier block for a text-only subagent (no child tools yet)", () => {
    const result = build([
      agentCall("toolu_agent"),
      { type: "text", text: "just prose", parentToolUseId: "toolu_agent" },
    ])
    const carrier = result.turns
      .flatMap((t) => t.blocks)
      .find((b) => b.type === "tool_result")
    expect(carrier).toBeDefined()
    expect(
      carrier?.type === "tool_result" ? carrier.agent_transcript : null
    ).toEqual([{ type: "text", text: "just prose" }])
  })

  it("attachAgentTranscripts:false (promotion) routes blocks out but attaches nothing", () => {
    const result = build(
      [
        agentCall("toolu_agent"),
        { type: "text", text: "sub prose", parentToolUseId: "toolu_agent" },
      ],
      { attachAgentTranscripts: false }
    )
    const blocks = result.turns.flatMap((t) => t.blocks)
    expect(blocks.some((b) => b.type === "text")).toBe(false)
    for (const b of blocks) {
      if (b.type === "tool_result") {
        expect(b.agent_transcript).toBeUndefined()
      }
    }
  })

  it("drops a parented block whose parent is not a classified agent", () => {
    const result = build([
      {
        type: "tool_call",
        info: toolInfo({ tool_call_id: "toolu_bash" }),
      },
      { type: "text", text: "stray", parentToolUseId: "toolu_bash" },
      { type: "text", text: "stray2", parentToolUseId: "toolu_gone" },
    ])
    const blocks = result.turns.flatMap((t) => t.blocks)
    expect(blocks.some((b) => b.type === "text")).toBe(false)
    for (const b of blocks) {
      if (b.type === "tool_result") {
        expect(b.agent_transcript).toBeUndefined()
      }
    }
  })

  // #494: the wire splits blocks at kind AND attribution boundaries, so a
  // sub-agent chunk landing between two main-thread deltas ends the main
  // block. Once the parented blocks are routed out, what remains is one
  // uninterrupted run of the main agent's output — rendering it as N cards
  // torn mid-word (`先看 cli` ⁄ `.py 怎么起 server`) is the reported bug, and
  // it scales with the number of sub-agents streaming at once.
  it("rejoins main-thread thinking torn apart by interleaved subagent chunks", () => {
    const result = build([
      agentCall("toolu_agent"),
      { type: "thinking", text: "先看 cli" },
      {
        type: "thinking",
        text: "子代理在读文件",
        parentToolUseId: "toolu_agent",
      },
      { type: "thinking", text: ".py 怎么起 server、token 放哪。" },
      {
        type: "thinking",
        text: "子代理还在读",
        parentToolUseId: "toolu_agent",
      },
      { type: "thinking", text: "注意不要和子代理冲突——" },
    ])
    const thinking = result.turns
      .flatMap((t) => t.blocks)
      .filter((b) => b.type === "thinking")
    expect(thinking).toEqual([
      {
        type: "thinking",
        text: "先看 cli.py 怎么起 server、token 放哪。注意不要和子代理冲突——",
      },
    ])
  })

  it("rejoins main-thread text torn apart by interleaved subagent chunks", () => {
    const result = build([
      agentCall("toolu_agent"),
      { type: "text", text: "C" },
      { type: "text", text: "sub prose", parentToolUseId: "toolu_agent" },
      { type: "text", text: "airn 的 agent 更换机制" },
    ])
    const text = result.turns
      .flatMap((t) => t.blocks)
      .filter((b) => b.type === "text")
    expect(text).toEqual([{ type: "text", text: "Cairn 的 agent 更换机制" }])
  })

  it("rejoins one subagent's transcript split by a second subagent's chunks", () => {
    const result = build([
      agentCall("toolu_a"),
      agentCall("toolu_b"),
      { type: "thinking", text: "A 想了", parentToolUseId: "toolu_a" },
      { type: "thinking", text: "B 也在想", parentToolUseId: "toolu_b" },
      { type: "thinking", text: "一半", parentToolUseId: "toolu_a" },
      { type: "text", text: "A 说完了", parentToolUseId: "toolu_a" },
    ])
    const carriers = result.turns
      .flatMap((t) => t.blocks)
      .filter((b) => b.type === "tool_result")
    // Attribution still holds: A's run is one entry, B's is its own card.
    expect(carriers.map((c) => c.agent_transcript)).toEqual([
      [
        { type: "thinking", text: "A 想了一半" },
        { type: "text", text: "A 说完了" },
      ],
      [{ type: "thinking", text: "B 也在想" }],
    ])
  })

  it("keeps a subagent's own tool call as a boundary in its transcript", () => {
    // Another agent's chunks do not interrupt A's run, but A stopping to run
    // a tool does — fusing across it would run two paragraphs together.
    const result = build([
      agentCall("toolu_a"),
      { type: "thinking", text: "before", parentToolUseId: "toolu_a" },
      {
        type: "tool_call",
        info: toolInfo({
          tool_call_id: "toolu_child",
          title: "Read",
          meta: { claudeCode: { parentToolUseId: "toolu_a" } },
        }),
      },
      { type: "thinking", text: "after", parentToolUseId: "toolu_a" },
    ])
    const carrier = result.turns
      .flatMap((t) => t.blocks)
      .find((b) => b.type === "tool_result")
    expect(
      carrier?.type === "tool_result" ? carrier.agent_transcript : null
    ).toEqual([
      { type: "thinking", text: "before" },
      { type: "thinking", text: "after" },
    ])
  })

  it("keeps a main-thread run split across a turn boundary", () => {
    // A completed tool between two thinking blocks opens a new turn group —
    // rejoining must not reach back across it.
    const result = build([
      { type: "thinking", text: "before" },
      {
        type: "tool_call",
        info: toolInfo({ tool_call_id: "toolu_done", status: "completed" }),
      },
      { type: "thinking", text: "after" },
    ])
    expect(
      result.turns.map((t) =>
        t.blocks.filter((b) => b.type === "thinking").map((b) => b.text)
      )
    ).toEqual([["before"], ["after"]])
  })

  it("keeps a boundary that preprocessing removed (codex collab close)", () => {
    // collapseLiveCollabBlocks folds a completed `closeAgent` into the spawn
    // capsule, so by Phase 2 the two texts look adjacent. They are not: a real
    // top-level tool call stood between them on the wire.
    const collab = (id: string, title: string): LiveContentBlock => ({
      type: "tool_call",
      info: {
        tool_call_id: id,
        title,
        kind: "other",
        status: "completed",
        content: null,
        raw_input: JSON.stringify({
          senderThreadId: "main",
          receiverThreadIds: ["a1"],
          agentsStates: { a1: { status: "completed", message: null } },
        }),
        raw_output_chunks: [],
        raw_output_total_bytes: 0,
        locations: null,
        meta: null,
        images: [],
      },
    })
    const result = build([
      collab("collab-spawn", "spawnAgent"),
      { type: "text", text: "before" },
      collab("collab-close", "closeAgent"),
      { type: "text", text: "after" },
    ])
    expect(
      result.turns
        .flatMap((t) => t.blocks)
        .filter((b) => b.type === "text")
        .map((b) => b.text)
    ).toEqual(["before", "after"])
  })

  it("does not let a stale snapshot's empty text block re-split a run", () => {
    // An empty text block renders nothing (Phase 2 drops it), so it is not a
    // boundary. Neither producer emits one any more, but a snapshot taken by
    // an older backend can still carry it.
    const result = build([
      { type: "thinking", text: "before" },
      { type: "text", text: "" },
      { type: "thinking", text: " after" },
    ])
    expect(
      result.turns
        .flatMap((t) => t.blocks)
        .filter((b) => b.type === "thinking")
        .map((b) => b.text)
    ).toEqual(["before after"])
  })

  it("keeps a boundary the PLAN_UPDATE reducer relocated away", () => {
    // `thinking → plan(v1) → thinking → plan(v2)` reaches the builder as two
    // adjacent thinking blocks: PLAN_UPDATE keeps one plan and moves it to the
    // end. The split predicate never leaves same-kind main prose adjacent, so
    // that shape means a boundary was removed — do not fuse across it.
    const result = build([
      { type: "thinking", text: "before" },
      { type: "thinking", text: "after" },
      { type: "plan", entries: [] },
    ])
    expect(
      result.turns
        .flatMap((t) => t.blocks)
        .filter((b) => b.type === "thinking")
        .map((b) => b.text)
    ).toEqual(["before", "after"])
  })

  it("keeps a plan block between two thinking blocks from fusing them", () => {
    const result = build([
      { type: "thinking", text: "before" },
      { type: "plan", entries: [] },
      { type: "thinking", text: "after" },
    ])
    expect(
      result.turns
        .flatMap((t) => t.blocks)
        .map((b) => (b.type === "thinking" ? b.text : b.type))
    ).toEqual(["before", "plan", "after"])
  })
})

describe("buildStreamingTurnsFromLiveMessage — Kimi TodoList suppression", () => {
  function kimiToolCall(
    rawInput: string | null,
    overrides: Partial<ToolCallInfo> = {}
  ): LiveContentBlock {
    return {
      type: "tool_call",
      info: {
        tool_call_id: "kc-todo-1",
        // The live ACP title is the localized description, never "TodoList".
        title: "Updating todo list",
        kind: "other",
        status: "in_progress",
        content: null,
        raw_input: rawInput,
        raw_output_chunks: [],
        raw_output_total_bytes: 0,
        locations: null,
        meta: null,
        images: [],
        ...overrides,
      },
    }
  }

  const write = (todos: Array<{ title: string; status: string }>): string =>
    JSON.stringify({ todos })

  const planBlock = (
    entries: Array<{ content: string; status: string; priority: string }>
  ): LiveContentBlock => ({ type: "plan", entries })

  function buildBlocks(content: LiveContentBlock[]): ContentBlock[] {
    const result = buildStreamingTurnsFromLiveMessage(1, {
      id: "lm-1",
      role: "assistant",
      startedAt: 0,
      content,
    })
    return result.turns.flatMap((t) => t.blocks)
  }

  const planEntries = (b: ContentBlock[]) => b.filter((x) => x.type === "plan")
  const toolUses = (b: ContentBlock[]) => b.filter((x) => x.type === "tool_use")
  const toolResults = (b: ContentBlock[]) =>
    b.filter((x) => x.type === "tool_result")

  it("renders a PlanCard from the call's own todos before Kimi's plan arrives (no tool card, no flash)", () => {
    const blocks = buildBlocks([
      kimiToolCall(
        write([
          { title: "A", status: "in_progress" },
          { title: "B", status: "pending" },
        ])
      ),
    ])

    expect(planEntries(blocks)).toHaveLength(1)
    expect(toolUses(blocks)).toHaveLength(0)
    expect(toolResults(blocks)).toHaveLength(0)
    const plan = planEntries(blocks)[0]
    if (plan.type !== "plan") throw new Error("expected plan")
    expect(plan.entries).toEqual([
      { content: "A", status: "in_progress", priority: "medium" },
      { content: "B", status: "pending", priority: "medium" },
    ])
  })

  it("drops the redundant tool card once Kimi's own plan block is present (single PlanCard)", () => {
    const blocks = buildBlocks([
      kimiToolCall(write([{ title: "A", status: "pending" }])),
      planBlock([{ content: "A", status: "pending", priority: "medium" }]),
    ])

    expect(planEntries(blocks)).toHaveLength(1)
    expect(toolUses(blocks)).toHaveLength(0)
  })

  it("shows the latest write's content, not an earlier write's stale plan block", () => {
    // Pre-plan window of a SECOND write: tool_call(write2 = {A,B}) is present,
    // but the reducer's collapsed plan block still reflects write1 ({A}) until
    // write2's own `plan` update lands. The single PlanCard must reflect write2.
    const blocks = buildBlocks([
      kimiToolCall(write([{ title: "A", status: "pending" }]), {
        tool_call_id: "w1",
        status: "completed",
      }),
      kimiToolCall(
        write([
          { title: "A", status: "pending" },
          { title: "B", status: "pending" },
        ]),
        { tool_call_id: "w2" }
      ),
      // Stale collapsed plan: still write1's content only.
      planBlock([{ content: "A", status: "pending", priority: "medium" }]),
    ])

    expect(toolUses(blocks)).toHaveLength(0)
    const plans = planEntries(blocks)
    expect(plans).toHaveLength(1)
    const plan = plans[0]
    if (plan.type !== "plan") throw new Error("expected plan")
    expect(plan.entries).toEqual([
      { content: "A", status: "pending", priority: "medium" },
      { content: "B", status: "pending", priority: "medium" },
    ])
  })

  it("leaves no tool_use or tool_result for a completed write (no orphan)", () => {
    const blocks = buildBlocks([
      kimiToolCall(write([{ title: "A", status: "done" }]), {
        status: "completed",
      }),
      planBlock([{ content: "A", status: "completed", priority: "medium" }]),
    ])

    expect(toolUses(blocks)).toHaveLength(0)
    expect(toolResults(blocks)).toHaveLength(0)
    expect(planEntries(blocks)).toHaveLength(1)
  })

  it("suppresses every write across an add/remove/replace sequence, leaving one plan", () => {
    const blocks = buildBlocks([
      kimiToolCall(write([{ title: "A", status: "pending" }]), {
        tool_call_id: "w1",
        status: "completed",
      }),
      kimiToolCall(
        write([
          { title: "A", status: "pending" },
          { title: "B", status: "pending" },
        ]),
        { tool_call_id: "w2", status: "completed" }
      ),
      // Final write replaces the list entirely (A removed, B kept).
      kimiToolCall(write([{ title: "B", status: "in_progress" }]), {
        tool_call_id: "w3",
        status: "completed",
      }),
      planBlock([{ content: "B", status: "in_progress", priority: "medium" }]),
    ])

    expect(toolUses(blocks)).toHaveLength(0)
    expect(planEntries(blocks)).toHaveLength(1)
  })

  it("does not suppress a coexisting non-Kimi tool (only the todo write is dropped)", () => {
    const blocks = buildBlocks([
      kimiToolCall('{"command":"ls"}', {
        tool_call_id: "bash-1",
        title: "Run ls",
        kind: "execute",
        status: "completed",
      }),
      kimiToolCall(write([{ title: "A", status: "pending" }]), {
        tool_call_id: "kc-1",
      }),
      planBlock([{ content: "A", status: "pending", priority: "medium" }]),
    ])

    const uses = toolUses(blocks)
    expect(uses).toHaveLength(1)
    expect(uses[0].type === "tool_use" && uses[0].tool_use_id).toBe("bash-1")
    expect(planEntries(blocks)).toHaveLength(1)
  })

  it.each([
    ["entries array", JSON.stringify({ entries: [{ content: "A" }] })],
    [
      "non-title items",
      JSON.stringify({ todos: [{ name: "A", status: "pending" }] }),
    ],
    ["read", "{}"],
    ["clear", JSON.stringify({ todos: [] })],
  ])(
    "never suppresses a non-Kimi-write shape (%s), rendering it as a tool card",
    (_label, rawInput) => {
      const blocks = buildBlocks([
        kimiToolCall(rawInput, { status: "completed" }),
        planBlock([{ content: "Z", status: "pending", priority: "medium" }]),
      ])

      // The non-write call is not dropped — it renders through the tool path.
      expect(toolUses(blocks)).toHaveLength(1)
    }
  )
})

/**
 * Cursor announces its `task` tool with rawInput = `{_toolName:"task"}` (args
 * stream in later frames the CLI never resends) and puts the only human-
 * readable label in the wire title ("Task: <description>"). The live builder
 * folds that title into the input as `description` so the Agent card shows a
 * real title instead of the "starting…" placeholder.
 */
describe("buildStreamingTurnsFromLiveMessage — cursor task title folding", () => {
  function cursorTaskCall(
    rawInput: string | null,
    title: string,
    overrides: Partial<ToolCallInfo> = {}
  ): LiveContentBlock {
    return {
      type: "tool_call",
      info: {
        tool_call_id: "tc-cursor-task-1",
        title,
        kind: "other",
        status: "in_progress",
        content: null,
        raw_input: rawInput,
        raw_output_chunks: [],
        raw_output_total_bytes: 0,
        locations: null,
        meta: null,
        images: [],
        ...overrides,
      },
    }
  }

  function firstToolUseInput(content: LiveContentBlock[]): string | null {
    const result = buildStreamingTurnsFromLiveMessage(1, {
      id: "lm-cursor",
      role: "assistant",
      startedAt: 0,
      content,
    })
    const block = result.turns
      .flatMap((t) => t.blocks)
      .find((b) => b.type === "tool_use")
    if (!block || block.type !== "tool_use") throw new Error("no tool_use")
    return block.input_preview ?? null
  }

  it("folds the wire title into `description` for a bare identity stamp", () => {
    const input = firstToolUseInput([
      cursorTaskCall(
        JSON.stringify({ _toolName: "task" }),
        "Task: run the build"
      ),
    ])
    expect(JSON.parse(input as string)).toEqual({
      _toolName: "task",
      description: "run the build",
    })
  })

  it("never overwrites a description the args already carry", () => {
    const explicit = JSON.stringify({
      _toolName: "task",
      description: "real description",
      prompt: "…",
    })
    const input = firstToolUseInput([
      cursorTaskCall(explicit, "Task: stale wire title"),
    ])
    expect(input).toBe(explicit)
  })

  it("leaves non-task agent payloads untouched (claude Task, codex spawn)", () => {
    const claude = JSON.stringify({
      subagent_type: "Explore",
      description: "map the repo",
    })
    const input = firstToolUseInput([
      // Claude's live Task carries subagent_type — classified "agent", but
      // there's no `_toolName` stamp, so the title must not be folded in.
      cursorTaskCall(claude, "Task: something else"),
    ])
    expect(input).toBe(claude)
  })
})

describe("buildStreamingTurnsFromLiveMessage — codex search/list-files command actions", () => {
  // codex-acp announces a search-classified shell command with kind="search", a
  // human title, and NO raw_input / locations (createCommandActionEvent), then
  // completes it with rawOutput `{formatted_output, exit_code}`. The query and
  // path exist nowhere but the title, so the store has to recover them — without
  // that the card's "tool name" was the whole title (wrench icon, "other" group
  // tally) and its body dumped the raw envelope as JSON.
  function build(title: string, kind: string, output: string) {
    return buildStreamingTurnsFromLiveMessage(1, {
      id: "lm-search",
      role: "assistant",
      startedAt: 0,
      content: [
        {
          type: "tool_call",
          info: {
            tool_call_id: "tc-search",
            title,
            kind,
            status: "completed",
            content: null,
            raw_input: null,
            raw_output_chunks: [output],
            raw_output_total_bytes: output.length,
            locations: null,
            meta: null,
            images: [],
          },
        },
      ],
    }).turns.flatMap((t) => t.blocks)
  }

  it("classifies a search command action as grep with a synthesized pattern/path", () => {
    const blocks = build(
      "Search for 'Tests run:' in com.forwayaudio.app",
      "search",
      JSON.stringify({ exit_code: 0, formatted_output: "Foo.java:42:hit" })
    )

    const toolUse = blocks.find((b) => b.type === "tool_use")
    expect(toolUse?.type === "tool_use" ? toolUse.tool_name : null).toBe("grep")
    expect(
      JSON.parse(
        (toolUse?.type === "tool_use" ? toolUse.input_preview : null) ?? "null"
      )
    ).toEqual({ pattern: "Tests run:", path: "com.forwayaudio.app" })
  })

  it("classifies a list-files command action as glob with a synthesized path", () => {
    const blocks = build(
      "List files in 'src/components'",
      "read",
      JSON.stringify({ exit_code: 0, formatted_output: "src/components/a.tsx" })
    )

    const toolUse = blocks.find((b) => b.type === "tool_use")
    expect(toolUse?.type === "tool_use" ? toolUse.tool_name : null).toBe("glob")
    expect(
      JSON.parse(
        (toolUse?.type === "tool_use" ? toolUse.input_preview : null) ?? "null"
      )
    ).toEqual({ path: "src/components" })
  })

  it("keeps the raw envelope on the result block for the renderer to unwrap", () => {
    const output = JSON.stringify({
      exit_code: 1,
      formatted_output: "",
    })
    const blocks = build("Search for 'nothing'", "search", output)

    const result = blocks.find((b) => b.type === "tool_result")
    expect(result?.type === "tool_result" ? result.output_preview : null).toBe(
      output
    )
  })
})

/**
 * A message sent WHILE the agent is replying (native `_session/steering`)
 * reaches the agent as a user message, so the transcript shows it as one.
 *
 * Before this, the live view dropped it entirely: the strip above the composer
 * was the only trace, and because no user turn landed between the two halves
 * of the reply, the answer to the steered message continued inside the SAME
 * assistant bubble - two separate replies rendered as one run-on paragraph.
 *
 * The persisted projection already did the right thing (see the
 * `user_message_chunk` arm of `project_turns` in `parsers/acp_native.rs`,
 * which flushes the assistant turn and pushes a user turn), so this is what
 * makes the live view agree with a reload.
 */
/** When the backend injected the steered message — its note's `created_at`,
 *  stamped where the agent runs. Later than the `turn()` helper's default
 *  timestamp below, so an unrelated turn from earlier history is provably
 *  older than any steer in these tests. */
const STEER_AT = "2026-05-28T00:05:00.000Z"
/** A turn the agent wrote after that injection — i.e. its own copy. */
const AFTER_STEER = "2026-05-28T00:05:01.000Z"

describe("buildStreamingTurnsFromLiveMessage - mid-turn steering messages", () => {
  function live(content: LiveContentBlock[]): LiveMessage {
    return { id: "lm-steer", role: "assistant", content, startedAt: 0 }
  }

  it("stamps the message with the instant it was sent, not the turn's start", () => {
    const turns = buildStreamingTurnsFromLiveMessage(
      1,
      live([
        { type: "text", text: "working on it" },
        { type: "steering", id: "note-1", text: "stop", createdAt: STEER_AT },
      ])
    ).turns
    const [reply, user] = turns
    expect(user.timestamp).toBe(STEER_AT)
    expect(reply.timestamp).toBe(new Date(0).toISOString())
  })

  it("falls back to the turn's start when the stamp is unreadable", () => {
    const turns = buildStreamingTurnsFromLiveMessage(
      1,
      live([{ type: "steering", id: "note-1", text: "stop", createdAt: "" }])
    ).turns
    expect(turns[0].timestamp).toBe(new Date(0).toISOString())
  })

  it("renders a steered attachment as its blocks, not as the display text", () => {
    // `text` is what the composer collapsed the draft into, so a steer that
    // carried an image must render from `blocks` — otherwise the running turn
    // shows a sentence about the image and only a reload puts the image back.
    const turns = buildStreamingTurnsFromLiveMessage(
      1,
      live([
        {
          type: "steering",
          id: "note-1",
          text: "this colour",
          createdAt: STEER_AT,
          blocks: [
            { type: "text", text: "this colour" },
            {
              type: "image",
              data: "aGk=",
              mime_type: "image/png",
              uri: null,
            },
          ],
        },
      ])
    ).turns
    expect(turns[0].role).toBe("user")
    expect(turns[0].blocks).toEqual([
      { type: "text", text: "this colour" },
      { type: "image", data: "aGk=", mime_type: "image/png", uri: null },
    ])
  })

  it("still renders a text-only steer from its text alone", () => {
    // The historical shape: no blocks on the note, so nothing about the
    // text-only path changes.
    const turns = buildStreamingTurnsFromLiveMessage(
      1,
      live([
        { type: "steering", id: "note-1", text: "stop", createdAt: STEER_AT },
      ])
    ).turns
    expect(turns[0].blocks).toEqual([{ type: "text", text: "stop" }])
  })

  it("renders a delivered mid-turn message as its own user turn", () => {
    const turns = buildStreamingTurnsFromLiveMessage(
      1,
      live([
        { type: "text", text: "working on it" },
        {
          type: "steering",
          id: "note-1",
          text: "actually, use the other API",
          createdAt: STEER_AT,
        },
      ])
    ).turns

    const user = turns.filter((t) => t.role === "user")
    expect(user).toHaveLength(1)
    expect(user[0].blocks).toEqual([
      { type: "text", text: "actually, use the other API" },
    ])
  })

  it("splits the reply at the boundary so two answers never share one bubble", () => {
    const turns = buildStreamingTurnsFromLiveMessage(
      1,
      live([
        { type: "text", text: "I will report both links once CI is green." },
        {
          type: "steering",
          id: "note-1",
          text: "not done",
          createdAt: STEER_AT,
        },
        { type: "text", text: "Not done - those are the two PRs..." },
      ])
    ).turns

    expect(turns.map((t) => t.role)).toEqual(["assistant", "user", "assistant"])
    // The two replies stay in separate turns; concatenating them into one
    // block is exactly the run-on paragraph this fixes.
    expect(turns[0].blocks).toEqual([
      { type: "text", text: "I will report both links once CI is green." },
    ])
    expect(turns[2].blocks).toEqual([
      { type: "text", text: "Not done - those are the two PRs..." },
    ])
    // Distinct ids, or the timeline dedup would collapse them back together.
    expect(new Set(turns.map((t) => t.id)).size).toBe(3)
  })

  it("splits even when the round has no completed tool call before it", () => {
    // The ordinary round split needs a settled tool call first; a user
    // interrupting mid-sentence is a boundary regardless.
    const turns = buildStreamingTurnsFromLiveMessage(
      1,
      live([
        { type: "thinking", text: "hmm" },
        { type: "steering", id: "note-1", text: "stop", createdAt: STEER_AT },
        { type: "text", text: "ok" },
      ])
    ).turns
    expect(turns.map((t) => t.role)).toEqual(["assistant", "user", "assistant"])
  })

  it("keeps prose either side of it in separate blocks", () => {
    // `mainProseContinuations` fuses same-kind prose only across blocks that
    // render nothing. A steering turn renders, so it must break the run.
    const turns = buildStreamingTurnsFromLiveMessage(
      1,
      live([
        { type: "text", text: "first" },
        { type: "steering", id: "note-1", text: "wait", createdAt: STEER_AT },
        { type: "text", text: "second" },
      ])
    ).turns
    expect(turns[0].blocks).toEqual([{ type: "text", text: "first" }])
    expect(turns[2].blocks).toEqual([{ type: "text", text: "second" }])
  })

  it("carries several steering messages in the order they were sent", () => {
    const turns = buildStreamingTurnsFromLiveMessage(
      1,
      live([
        { type: "text", text: "a" },
        { type: "steering", id: "n1", text: "one", createdAt: STEER_AT },
        { type: "text", text: "b" },
        { type: "steering", id: "n2", text: "two", createdAt: STEER_AT },
        { type: "text", text: "c" },
      ])
    ).turns
    expect(turns.map((t) => t.role)).toEqual([
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ])
    expect(
      turns
        .filter((t) => t.role === "user")
        .map((t) => (t.blocks[0].type === "text" ? t.blocks[0].text : ""))
    ).toEqual(["one", "two"])
  })

  it("leaves a turn with no steering completely unchanged", () => {
    const turns = buildStreamingTurnsFromLiveMessage(
      1,
      live([
        { type: "thinking", text: "think" },
        { type: "text", text: "reply" },
      ])
    ).turns
    expect(turns).toHaveLength(1)
    expect(turns[0].role).toBe("assistant")
  })
})

/**
 * The agent writes a steered message into its own transcript, so a detail
 * fetch landing DURING the turn brings it back as an ordinary user turn under
 * a parser-assigned id - which no id-keyed dedup can match to the live copy.
 * Both would render. The live copy is kept because it sits between the two
 * halves of the reply; the persisted one would land after the whole thing.
 */
describe("conversation timeline - a steered message survives a mid-turn reload once", () => {
  const runtimeHolder: {
    current: ReturnType<typeof useConversationRuntime> | undefined
  } = { current: undefined }

  function RuntimeCapture() {
    const runtime = useConversationRuntime()
    useEffect(() => {
      runtimeHolder.current = runtime
    })
    return null
  }

  function turn(
    id: string,
    role: "user" | "assistant",
    text: string,
    timestamp = "2026-05-28T00:00:00.000Z"
  ): MessageTurn {
    return {
      id,
      role,
      blocks: [{ type: "text" as const, text }],
      timestamp,
    }
  }

  function detailWith(
    turns: MessageTurn[],
    inFlightUserTurnId: string | null
  ): DbConversationDetail {
    return {
      summary: {
        id: 99,
        folder_id: 1,
        agent_type: "claude",
        title: "c",
        title_locked: false,
        status: "in_progress",
        kind: "regular",
        model: null,
        git_branch: null,
        external_id: "ext-1",
        message_count: turns.length,
        child_count: 0,
        created_at: "2026-05-28T00:00:00.000Z",
        updated_at: "2026-05-28T00:00:00.000Z",
        pinned_at: null,
      },
      turns,
      session_stats: null,
      in_flight_user_turn_id: inFlightUserTurnId,
    } as DbConversationDetail
  }

  function userTexts(
    items: ReturnType<
      NonNullable<typeof runtimeHolder.current>["getTimelineTurns"]
    >
  ): string[] {
    return items
      .filter((t) => t.turn.role === "user")
      .map((t) =>
        t.turn.blocks[0]?.type === "text" ? t.turn.blocks[0].text : ""
      )
  }

  beforeEach(() => {
    runtimeHolder.current = undefined
    mockGetFolderConversation.mockReset()
    mockGetFolderConversation.mockImplementation(() => new Promise(() => {}))
  })

  it("shows the steered message once, keeping the live copy's position", async () => {
    renderProvider(<RuntimeCapture />)
    const api = () => runtimeHolder.current!

    // The turn is running and the reply has been split by a steering message.
    act(() => {
      api().setLiveMessage(
        99,
        {
          id: "lm-1",
          role: "assistant",
          content: [
            { type: "text", text: "half one" },
            {
              type: "steering",
              id: "note-1",
              text: "use the other API",
              createdAt: STEER_AT,
            },
            { type: "text", text: "half two" },
          ],
          startedAt: 0,
        },
        true
      )
    })

    // A mid-turn detail fetch lands, carrying the agent's own record of that
    // same message under a parser id — written after the injection, which is
    // what marks it as this message's copy. The backend cannot stamp an
    // in-flight prompt here: it matches the pending prompt against the
    // transcript TAIL, and the tail is now the steered message.
    mockGetFolderConversation.mockResolvedValueOnce(
      detailWith(
        [
          turn("p-1", "user", "the original prompt"),
          turn("p-2", "user", "use the other API", AFTER_STEER),
        ],
        null
      )
    )
    await act(async () => {
      api().refetchDetail(99, { preserveLive: true })
    })

    const timeline = api().getTimelineTurns(99)
    // Once, not twice - and the original prompt is untouched.
    expect(userTexts(timeline)).toEqual([
      "the original prompt",
      "use the other API",
    ])
    const steered = timeline.filter(
      (t) =>
        t.turn.role === "user" &&
        t.turn.blocks[0]?.type === "text" &&
        t.turn.blocks[0].text === "use the other API"
    )
    // The surviving copy is the live one, between the halves of the reply.
    expect(steered).toHaveLength(1)
    expect(steered[0].phase).toBe("streaming")
  })

  it("never suppresses this round's prompt, even when a steer repeats it", async () => {
    // And with NO in-flight stamp, which is the shape the backend produces
    // once the steered message is on the transcript tail: the prompt is safe
    // because the agent wrote it before the user steered, not because it was
    // named.
    renderProvider(<RuntimeCapture />)
    const api = () => runtimeHolder.current!
    act(() => {
      api().setLiveMessage(
        99,
        {
          id: "lm-2",
          role: "assistant",
          content: [
            {
              type: "steering",
              id: "note-1",
              text: "continue",
              createdAt: STEER_AT,
            },
          ],
          startedAt: 0,
        },
        true
      )
    })
    mockGetFolderConversation.mockResolvedValueOnce(
      detailWith([turn("p-1", "user", "continue")], null)
    )
    await act(async () => {
      api().refetchDetail(99, { preserveLive: true })
    })
    // Both survive: hiding a prompt is the one failure worse than showing a
    // duplicate.
    expect(userTexts(api().getTimelineTurns(99))).toEqual([
      "continue",
      "continue",
    ])
  })

  it("leaves an earlier round's identical prompt in history", async () => {
    // Steered text is short and repeatable ("continue", "stop"), and content is
    // the only thing linking the live copy to the persisted one. Matching it
    // across the whole window would hide the SAME words the user sent three
    // rounds ago for as long as this turn runs. Only a turn written after the
    // injection can be a copy of it.
    renderProvider(<RuntimeCapture />)
    const api = () => runtimeHolder.current!
    act(() => {
      api().setLiveMessage(
        99,
        {
          id: "lm-3",
          role: "assistant",
          content: [
            { type: "text", text: "half one" },
            {
              type: "steering",
              id: "note-1",
              text: "continue",
              createdAt: STEER_AT,
            },
            { type: "text", text: "half two" },
          ],
          startedAt: 0,
        },
        true
      )
    })
    mockGetFolderConversation.mockResolvedValueOnce(
      detailWith(
        [
          turn("p-1", "user", "continue"), // an earlier round, same words
          turn("p-2", "assistant", "sure"),
          turn("p-3", "user", "now do the thing"), // this turn's prompt
          turn("p-4", "user", "continue", AFTER_STEER), // the agent's copy
        ],
        null
      )
    )
    await act(async () => {
      api().refetchDetail(99, { preserveLive: true })
    })
    // History intact; only the copy inside the running round is folded away.
    expect(userTexts(api().getTimelineTurns(99))).toEqual([
      "continue",
      "now do the thing",
      "continue",
    ])
    const steered = api()
      .getTimelineTurns(99)
      .filter(
        (t) =>
          t.turn.role === "user" &&
          t.turn.blocks[0]?.type === "text" &&
          t.turn.blocks[0].text === "continue"
      )
    expect(steered.map((t) => t.phase)).toEqual(["persisted", "streaming"])
  })

  it("suppresses nothing when the message carries no readable instant", async () => {
    // An unparseable stamp on either side leaves no way to tell this round's
    // copy from an older message, so both copies render — a duplicate, never a
    // disappearance.
    renderProvider(<RuntimeCapture />)
    const api = () => runtimeHolder.current!
    act(() => {
      api().setLiveMessage(
        99,
        {
          id: "lm-4",
          role: "assistant",
          content: [
            { type: "steering", id: "note-1", text: "continue", createdAt: "" },
          ],
          startedAt: Date.parse(STEER_AT),
        },
        true
      )
    })
    mockGetFolderConversation.mockResolvedValueOnce(
      detailWith([turn("p-9", "user", "continue", AFTER_STEER)], null)
    )
    await act(async () => {
      api().refetchDetail(99, { preserveLive: true })
    })
    expect(userTexts(api().getTimelineTurns(99))).toEqual([
      "continue",
      "continue",
    ])
  })

  it("leaves a promoted local turn from an earlier round alone", async () => {
    // `localTurns` render as phase "persisted" but are NOT part of the detail's
    // projection — a mid-turn refetch preserves them, and they are stamped from
    // the client clock, so they are never compared against the injection
    // instant. Only what the detail itself lists can be the agent's copy.
    renderProvider(<RuntimeCapture />)
    const api = () => runtimeHolder.current!
    const earlierReply: LiveMessage = {
      id: "lm-earlier",
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      startedAt: 0,
    }
    act(() => {
      api().appendOptimisticTurn(99, turn("o-1", "user", "continue"), "o-1")
    })
    act(() => {
      api().completeTurn(99, earlierReply)
    })
    act(() => {
      api().setLiveMessage(
        99,
        {
          id: "lm-5",
          role: "assistant",
          content: [
            { type: "text", text: "half one" },
            {
              type: "steering",
              id: "note-1",
              text: "continue",
              createdAt: STEER_AT,
            },
            { type: "text", text: "half two" },
          ],
          startedAt: 0,
        },
        true
      )
    })
    mockGetFolderConversation.mockResolvedValueOnce(
      detailWith([turn("p-1", "user", "now do the thing")], "p-1")
    )
    await act(async () => {
      api().refetchDetail(99, { preserveLive: true })
    })
    expect(userTexts(api().getTimelineTurns(99))).toEqual([
      "now do the thing",
      "continue", // the earlier round's promoted prompt
      "continue", // this round's steer, live
    ])
  })
})
