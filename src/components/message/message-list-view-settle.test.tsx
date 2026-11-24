/**
 * A reply that finishes streaming settles into history in the same row: the
 * virtual list keeps its key, so React keeps the reply's DOM instead of
 * tearing it down and drawing it again at the moment it finishes.
 *
 * Renders the real `MessageListView` against the runtime store, with the
 * virtual list stubbed to record the keys it is handed.
 */
import { act, cleanup, render } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { LiveMessage } from "@/contexts/acp-connections-context"
import type { DbConversationDetail, MessageTurn } from "@/lib/types"
import {
  resetConversationRuntimeStore,
  useConversationRuntimeStore,
  type ConversationRuntimeSession,
} from "@/stores/conversation-runtime-store"
import type { ThreadRenderItem } from "./message-list-view"

const { stableT, rendered } = vi.hoisted(() => ({
  stableT: (key: string) => key,
  rendered: {
    rows: [] as { key: string; item: ThreadRenderItem }[],
  },
}))

vi.mock("next-intl", () => ({
  useTranslations: () => stableT,
  useLocale: () => "en",
}))
vi.mock("@/lib/api", () => ({
  getFolderConversation: vi.fn(() => new Promise(() => {})),
  getFolderConversationTurns: vi.fn(),
  getFolderConversationOutline: vi.fn(() => new Promise(() => {})),
  readFileBase64: vi.fn(),
  readWorkspaceFileBase64: vi.fn(),
}))
vi.mock("@/components/message/virtualized-message-thread", () => ({
  VirtualizedMessageThread: ({
    items,
    getItemKey,
  }: {
    items: ThreadRenderItem[]
    getItemKey: (item: ThreadRenderItem, index: number) => string
  }) => {
    rendered.rows = items.map((item, index) => ({
      key: getItemKey(item, index),
      item,
    }))
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
  AgentPlanOverlay: () => null,
}))
vi.mock("@/components/chat/sub-agent-overlay", () => ({
  SubAgentOverlay: () => null,
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

const CID = 41
const at = (n: number) => new Date(1_700_000_000_000 + n * 1000).toISOString()

const TURNS: MessageTurn[] = [
  {
    id: "u1",
    role: "user",
    blocks: [{ type: "text", text: "Run the tests" }],
    timestamp: at(1),
  },
]

function detail(): DbConversationDetail {
  return {
    summary: {
      id: CID,
      folder_id: 1,
      agent_type: "claude_code",
      title: "t",
      title_locked: false,
      status: "in_progress",
      kind: "regular",
      model: null,
      git_branch: null,
      external_id: "ext-41",
      message_count: TURNS.length,
      child_count: 0,
      created_at: at(0),
      updated_at: at(1),
      pinned_at: null,
    },
    turns: TURNS,
    session_stats: null,
  }
}

const LIVE: LiveMessage = {
  id: "live-7",
  role: "assistant",
  content: [{ type: "text", text: "Running them now. All 48 pass." }],
  startedAt: Date.parse(at(2)),
}

function seed(): void {
  const session: ConversationRuntimeSession = {
    conversationId: CID,
    externalId: "ext-41",
    dbConversationId: CID,
    detail: detail(),
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

const actions = () => useConversationRuntimeStore.getState().actions

const reply = () => {
  const row = rendered.rows.find(
    (r) => r.item.kind === "turn" && r.item.group.role === "assistant"
  )
  if (!row || row.item.kind !== "turn") throw new Error("no reply row")
  return { key: row.key, phase: row.item.phase }
}

beforeEach(() => {
  resetConversationRuntimeStore()
  rendered.rows = []
})

afterEach(() => {
  cleanup()
  resetConversationRuntimeStore()
})

describe("MessageListView: a reply settling into history", () => {
  it("keeps its row's key, so the reply is not drawn again", () => {
    seed()
    act(() => {
      actions().setLiveMessage(CID, LIVE, true)
    })
    render(
      <MessageListView
        conversationId={CID}
        imageRoot={null}
        agentType="claude_code"
        availableCommands={[]}
        connStatus="prompting"
      />
    )
    const live = reply()
    expect(live.phase).toBe("streaming")

    act(() => {
      actions().completeTurn(CID)
    })
    const settled = reply()
    expect(settled.phase).toBe("persisted")
    expect(settled.key).toBe(live.key)
  })
})
