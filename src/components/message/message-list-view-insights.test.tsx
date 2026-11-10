/**
 * The conversation page's transcript hands its message navigator, plan and
 * sub-agents to the Session Details side panel (`insightsInSidebar`); every
 * other transcript keeps the plan and sub-agent chips over its messages.
 *
 * Renders the real `MessageListView` against a seeded runtime store. Only the
 * pieces that need a real layout engine (the virtual list, the stick-to-bottom
 * thread) and the overlays themselves are stubbed — the list stub exposes the
 * scroll handle so a navigator jump is observable.
 */
import { act, cleanup, render, screen } from "@testing-library/react"
import type { ReactNode, RefObject } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type {
  ContentBlock,
  DbConversationDetail,
  MessageTurn,
} from "@/lib/types"
import {
  resetConversationRuntimeStore,
  useConversationRuntimeStore,
  type ConversationRuntimeSession,
} from "@/stores/conversation-runtime-store"
import {
  demandTranscriptNav,
  useTranscriptInsightsStore,
  type TranscriptInsights,
} from "@/stores/transcript-insights-store"
import type { MessageScrollContextValue } from "./message-scroll-context"

const { stableT, scrollToIndex, viewport } = vi.hoisted(() => ({
  stableT: (key: string) => key,
  scrollToIndex: vi.fn(),
  // What the list was last told to report its top row to.
  viewport: {
    listener: undefined as
      | undefined
      | ((top: { index: number; atEnd: boolean }) => void),
  },
}))

vi.mock("next-intl", () => ({ useTranslations: () => stableT }))
vi.mock("@/lib/api", () => ({
  getFolderConversation: vi.fn(),
  getFolderConversationTurns: vi.fn(),
  getFolderConversationOutline: vi.fn(() => new Promise(() => {})),
  // The transcript's image scope holds them even without a folder.
  readFileBase64: vi.fn(),
  readWorkspaceFileBase64: vi.fn(),
}))
vi.mock("@/components/message/virtualized-message-thread", () => ({
  VirtualizedMessageThread: ({
    scrollApiRef,
    onViewportTopChange,
  }: {
    scrollApiRef: RefObject<MessageScrollContextValue | null>
    onViewportTopChange?: (top: { index: number; atEnd: boolean }) => void
  }) => {
    scrollApiRef.current = {
      scrollToIndex,
    } as unknown as MessageScrollContextValue
    viewport.listener = onViewportTopChange
    return null
  },
}))
vi.mock("@/components/ai-elements/message-thread", () => ({
  MessageThread: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  MessageThreadScrollButton: () => null,
}))
vi.mock("use-stick-to-bottom", () => ({
  useStickToBottomContext: () => ({ scrollToBottom: () => {} }),
}))
vi.mock("@/components/chat/agent-plan-overlay", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/components/chat/agent-plan-overlay")
  >()),
  AgentPlanOverlay: () => <div data-testid="plan-overlay" />,
}))
vi.mock("@/components/chat/sub-agent-overlay", () => ({
  SubAgentOverlay: () => <div data-testid="sub-agent-overlay" />,
}))
vi.mock("@/components/message/session-viewer-host", () => ({
  SessionViewerHost: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock("@/components/message/selection-action-bubble", () => ({
  SelectionActionBubble: () => null,
}))
vi.mock("@/components/message/use-transcript-known-invocations", () => ({
  useTranscriptKnownInvocations: () => null,
}))
vi.mock("@/hooks/use-model-labels", () => ({
  useModelLabels: () => (id: string | null | undefined) => id ?? null,
}))
vi.mock("@/hooks/use-appearance", () => ({
  useChatAnimationsEnabled: () => false,
}))
vi.mock("@/lib/browser/use-page-handoff-name", () => ({
  usePageHandoffName: () => "page",
}))

import { MessageListView } from "./message-list-view"

const CID = 31
const at = (n: number) => new Date(1_700_000_000_000 + n * 1000).toISOString()

function turn(
  id: string,
  role: MessageTurn["role"],
  blocks: ContentBlock[],
  n: number
): MessageTurn {
  return { id, role, blocks, timestamp: at(n) }
}

function delegateCall(id: string, taskId: string): ContentBlock[] {
  return [
    {
      type: "tool_use",
      tool_use_id: id,
      tool_name: "mcp__codeg-mcp__delegate_to_agent",
      input_preview: JSON.stringify({ agent_type: "codex", task: "dig" }),
    },
    {
      type: "tool_result",
      tool_use_id: id,
      output_preview: JSON.stringify({ task_id: taskId, status: "running" }),
      is_error: false,
    },
  ]
}

const TURNS: MessageTurn[] = [
  turn("u1", "user", [{ type: "text", text: "first message" }], 1),
  turn("a1", "assistant", delegateCall("tu-1", "task-1"), 2),
  turn("u2", "user", [{ type: "text", text: "second message" }], 3),
  turn(
    "a2",
    "assistant",
    [
      {
        type: "tool_use",
        tool_use_id: "todo-1",
        tool_name: "TodoWrite",
        input_preview: JSON.stringify({
          todos: [
            { content: "Read the code", status: "completed" },
            { content: "Write the fix", status: "in_progress" },
          ],
        }),
      },
      ...delegateCall("tu-2", "task-2"),
    ],
    4
  ),
]

function detail(
  over: Partial<DbConversationDetail> = {}
): DbConversationDetail {
  return {
    summary: {
      id: CID,
      folder_id: 1,
      agent_type: "claude_code",
      title: "t",
      title_locked: false,
      status: "completed",
      kind: "regular",
      model: null,
      git_branch: null,
      external_id: "ext-1",
      message_count: TURNS.length,
      child_count: 0,
      created_at: at(0),
      updated_at: at(9),
      pinned_at: null,
    },
    turns: TURNS,
    session_stats: null,
    ...over,
  }
}

function seed(over: Partial<DbConversationDetail> = {}): void {
  const session: ConversationRuntimeSession = {
    conversationId: CID,
    externalId: "ext-1",
    dbConversationId: CID,
    detail: detail(over),
    detailLoading: false,
    detailError: null,
    acpLoadError: null,
    localTurns: [],
    backgroundTurns: [],
    pendingBackgroundSettlements: [],
    pendingCancelledTurnReports: null,
    optimisticTurns: [],
    liveMessage: null,
    syncState: "idle",
    activeTurnToken: null,
    lastTurnOwned: false,
    liveOwnsActiveTurn: false,
    delegationKickoffText: null,
    sessionStats: null,
    historyAssistantBaseline: null,
    batchBoundaryIndex: null,
    batchBoundaryPrefixHash: null,
    loadingOlderTurns: false,
    olderTurnsPrependEpoch: 0,
    pendingOutOfTurnContent: false,
    pendingCleanup: false,
  }
  useConversationRuntimeStore.setState({
    byConversationId: new Map([[CID, session]]),
  })
}

function renderTranscript(insightsInSidebar: boolean) {
  return render(
    <MessageListView
      conversationId={CID}
      imageRoot={null}
      agentType="claude_code"
      availableCommands={[]}
      connStatus="connected"
      insightsInSidebar={insightsInSidebar}
    />
  )
}

function published(): TranscriptInsights | undefined {
  return useTranscriptInsightsStore.getState().byConversationId.get(CID)
    ?.insights
}

beforeEach(() => {
  resetConversationRuntimeStore()
  scrollToIndex.mockClear()
  viewport.listener = undefined
})

afterEach(() => {
  cleanup()
  useTranscriptInsightsStore.setState({
    byConversationId: new Map(),
    navDemand: new Map(),
  })
})

describe("MessageListView insights", () => {
  it("keeps the plan and sub-agent chips on a transcript without a side panel", () => {
    seed()
    renderTranscript(false)
    expect(screen.getByTestId("plan-overlay")).toBeInTheDocument()
    expect(screen.getByTestId("sub-agent-overlay")).toBeInTheDocument()
    expect(published()).toBeUndefined()
  })

  it("hands the plan and the message count to the side panel instead", () => {
    seed()
    renderTranscript(true)
    expect(screen.queryByTestId("plan-overlay")).not.toBeInTheDocument()
    expect(screen.queryByTestId("sub-agent-overlay")).not.toBeInTheDocument()

    const insights = published()
    expect(insights?.nav.count).toBe(2)
    // Rows are only built once the panel asks for them.
    expect(insights?.nav.entries).toEqual([])
    expect(insights?.plan.entries.map((entry) => entry.content)).toEqual([
      "Read the code",
      "Write the fix",
    ])
    expect(insights?.plan.streaming).toBe(false)
  })

  it("builds the navigator rows on demand, and jumps through its own list", () => {
    seed()
    renderTranscript(true)
    act(() => {
      demandTranscriptNav(CID)
    })
    const entries = published()?.nav.entries ?? []
    expect(entries.map((entry) => entry.label)).toEqual([
      "first message",
      "second message",
    ])
    // Each message lists the sub-agents its round started.
    expect(
      entries.map((entry) =>
        entry.subAgents.map((source) => source.parentToolUseId)
      )
    ).toEqual([["tu-1"], ["tu-2"]])
    const second = entries[1]
    expect(second.threadIndex).not.toBeNull()
    act(() => published()?.actions.selectNavEntry(second))
    expect(scrollToIndex).toHaveBeenCalledWith(second.threadIndex, {
      align: "start",
      smooth: false,
    })
  })

  it("counts the messages above a loaded window", () => {
    seed({
      turns_offset: 6,
      turns_total: 10,
      prefix_hash: "0123456789abcdef",
      user_turns_before_offset: 3,
    })
    renderTranscript(true)
    expect(published()?.nav.count).toBe(5)
  })

  it("follows the message the transcript shows while the rows are wanted", () => {
    seed()
    renderTranscript(true)
    // Nobody shows the rows: the list isn't asked where it is.
    expect(viewport.listener).toBeUndefined()
    expect(published()?.nav.currentTurnId).toBeNull()

    let release = () => {}
    act(() => {
      release = demandTranscriptNav(CID)
    })
    // Thread: u1, its reply, u2, its reply.
    act(() => viewport.listener?.({ index: 1, atEnd: false }))
    expect(published()?.nav.currentTurnId).toBe("u1")
    act(() => viewport.listener?.({ index: 2, atEnd: false }))
    expect(published()?.nav.currentTurnId).toBe("u2")
    act(() => viewport.listener?.({ index: 0, atEnd: true }))
    expect(published()?.nav.currentTurnId).toBe("u2")

    act(() => release())
    expect(viewport.listener).toBeUndefined()
    expect(published()?.nav.currentTurnId).toBeNull()
  })

  it("takes its insights back when it unmounts", () => {
    seed()
    const { unmount } = renderTranscript(true)
    expect(published()).toBeDefined()
    unmount()
    expect(published()).toBeUndefined()
  })
})
