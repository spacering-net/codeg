/**
 * The live activity row above the composer: the running turn's figures, and
 * the "N running" chip for work that outlives the turn — so the row stays
 * after the turn ends while any of that work still runs.
 *
 * Renders the real `MessageListView` against the runtime store, with the
 * virtual list stubbed out.
 */
import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { LiveMessage } from "@/contexts/acp-connections-context"
import enMessages from "@/i18n/messages/en.json"
import type {
  AsyncTaskRecord,
  DbConversationDetail,
  MessageTurn,
} from "@/lib/types"
import {
  resetConversationRuntimeStore,
  useConversationRuntimeStore,
  type ConversationRuntimeSession,
} from "@/stores/conversation-runtime-store"
import type { ThreadRenderItem } from "./message-list-view"

const { rendered } = vi.hoisted(() => ({
  rendered: {
    rows: [] as { key: string; item: ThreadRenderItem }[],
  },
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
vi.mock("@/contexts/workspace-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/contexts/workspace-context")>()),
  useWorkspaceActions: () => ({ openFilePreview: vi.fn() }),
}))
vi.mock("@/lib/browser/use-page-handoff-name", () => ({
  usePageHandoffName: () => "page",
}))

import { MessageListView, type LiveRunsSource } from "./message-list-view"

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

function seed(opts: { empty?: boolean } = {}): void {
  const session: ConversationRuntimeSession = {
    conversationId: CID,
    externalId: "ext-41",
    dbConversationId: CID,
    detail: opts.empty ? null : detail(),
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

const NO_RUNS: LiveRunsSource = {
  connectionId: "conn-1",
  asyncTasks: [],
  backgroundTasks: [],
  delegatedChildren: [],
}

const SHELL: AsyncTaskRecord = {
  task_id: "bg-1",
  name: "pnpm dev",
  task_type: "shell",
  description: "",
  show_in_transcript: false,
  can_stop: true,
  state: "running",
}

function view(props: {
  connStatus: "prompting" | "connected"
  liveRuns: LiveRunsSource
  detailLoading?: boolean
  detailError?: string | null
}) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <MessageListView
        conversationId={CID}
        imageRoot={null}
        agentType="claude_code"
        availableCommands={[]}
        connStatus={props.connStatus}
        liveRuns={props.liveRuns}
        detailLoading={props.detailLoading}
        detailError={props.detailError}
      />
    </NextIntlClientProvider>
  )
}

const timer = () => document.querySelector("svg.lucide-timer")
const chip = (count: number) =>
  screen.queryByRole("button", { name: `${count} running` })

beforeEach(() => {
  resetConversationRuntimeStore()
  rendered.rows = []
})

afterEach(() => {
  cleanup()
  resetConversationRuntimeStore()
})

describe("MessageListView: the live activity row", () => {
  it("shows the running turn's figures, with no chip while nothing else runs", () => {
    seed()
    act(() => {
      actions().setLiveMessage(CID, LIVE, true)
    })
    render(view({ connStatus: "prompting", liveRuns: NO_RUNS }))
    expect(timer()).not.toBeNull()
    expect(screen.queryByRole("button", { name: /running/ })).toBeNull()
  })

  it("stays after the turn ends while work it left still runs, the chip alone on it", () => {
    seed()
    act(() => {
      actions().setLiveMessage(CID, LIVE, true)
    })
    const running = { ...NO_RUNS, asyncTasks: [SHELL] }
    const { rerender } = render(
      view({ connStatus: "prompting", liveRuns: running })
    )
    expect(timer()).not.toBeNull()
    expect(chip(1)).not.toBeNull()

    act(() => {
      actions().completeTurn(CID)
    })
    rerender(view({ connStatus: "connected", liveRuns: running }))
    expect(chip(1)).not.toBeNull()
    expect(timer()).toBeNull()

    // The work ends too: the row goes (at once, with animations off).
    rerender(
      view({
        connStatus: "connected",
        liveRuns: {
          ...NO_RUNS,
          asyncTasks: [{ ...SHELL, state: "completed" }],
        },
      })
    )
    expect(chip(1)).toBeNull()
  })

  it("comes up for work running past any turn — a delegation, say — with no turn at all", () => {
    seed()
    render(
      view({
        connStatus: "connected",
        liveRuns: { ...NO_RUNS, delegatedChildren: ["child-1"] },
      })
    )
    expect(chip(1)).not.toBeNull()
    expect(timer()).toBeNull()
  })

  // What runs is the connection's, not the transcript's: a conversation whose
  // history is still loading — or failed to — still lists it, and can stop it.
  it.each([
    ["loading", { detailLoading: true }],
    ["failed to load", { detailError: "Could not read the transcript" }],
  ])(
    "lists the work, with its stop, while the history has %s",
    async (_, state) => {
      seed({ empty: true })
      const onStopAsyncTask = vi.fn().mockResolvedValue(true)
      render(
        view({
          connStatus: "connected",
          liveRuns: { ...NO_RUNS, asyncTasks: [SHELL], onStopAsyncTask },
          ...state,
        })
      )
      await userEvent.click(chip(1)!)
      await userEvent.click(
        await screen.findByRole("button", {
          name: enMessages.Folder.chat.asyncTasks.stop,
        })
      )
      expect(onStopAsyncTask).toHaveBeenCalledWith("bg-1")
    }
  )

  it("counts the streaming reply's sub-agents still at work", () => {
    seed()
    act(() => {
      actions().setLiveMessage(
        CID,
        {
          ...LIVE,
          content: [
            {
              type: "tool_call",
              info: {
                tool_call_id: "agent-1",
                title: "Agent",
                kind: "other",
                status: "in_progress",
                content: null,
                raw_input: JSON.stringify({
                  subagent_type: "Explore",
                  description: "Find the flaky test",
                  prompt: "…",
                }),
                raw_output_chunks: [],
                raw_output_total_bytes: 0,
                locations: null,
                meta: null,
                images: [],
              },
            },
          ],
        },
        true
      )
    })
    render(view({ connStatus: "prompting", liveRuns: NO_RUNS }))
    expect(timer()).not.toBeNull()
    expect(chip(1)).not.toBeNull()
  })
})
