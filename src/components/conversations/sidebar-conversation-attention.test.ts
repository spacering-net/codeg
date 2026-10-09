import { describe, expect, it, vi } from "vitest"

import type {
  ConnectionState,
  ConnectionStoreApi,
} from "@/contexts/acp-connections-context"
import type { TabItem } from "@/stores/tab-store"
import {
  connectionNeedsAttention,
  createSidebarAttentionStore,
  reduceSidebarCompletionState,
  sidebarAttentionTargets,
  type SidebarCompletionObservation,
  type SidebarCompletionState,
} from "./sidebar-conversation-attention"

function connection(patch: Partial<ConnectionState> = {}): ConnectionState {
  return {
    connectionId: "connection-1",
    contextKey: "tab-1",
    agentType: "claude_code",
    workingDir: "/tmp/project",
    status: "prompting",
    promptCapabilities: { image: false, audio: false, embedded_context: false },
    supportsFork: false,
    selectorsReady: true,
    sessionId: "session-1",
    modes: null,
    configOptions: null,
    availableCommands: null,
    usage: null,
    liveMessage: null,
    pendingPermission: null,
    pendingUserMessage: null,
    steeredMessageIds: [],
    pendingQuestion: null,
    pendingAskQuestion: null,
    pendingPlanApproval: null,
    claudeApiRetry: null,
    sessionFailures: [],
    asyncTasks: [],
    error: null,
    loadError: null,
    loadErrorCommand: null,
    lastAppliedSeq: 0,
    isDelegationChild: false,
    parentToolUseId: null,
    parentConnectionId: null,
    isViewer: false,
    configStale: false,
    configStaleKind: null,
    configStaleDismissed: false,
    backgroundOutstanding: 0,
    outOfTurnToolCalls: null,
    ...patch,
  }
}

function tab(id: string, conversationId: number | null): TabItem {
  return {
    id,
    kind: "conversation",
    folderId: 1,
    conversationId,
    agentType: "claude_code",
    title: id,
    isPinned: false,
  }
}

function store(
  connections: Map<string, ConnectionState>
): ConnectionStoreApi & {
  listeners: Map<string, Set<() => void>>
} {
  const listeners = new Map<string, Set<() => void>>()
  return {
    listeners,
    getConnection: (key) => connections.get(key),
    getConnectPending: () => undefined,
    getActiveKey: () => null,
    subscribeKey: (key, callback) => {
      const callbacks = listeners.get(key) ?? new Set()
      callbacks.add(callback)
      listeners.set(key, callbacks)
      return () => {
        callbacks.delete(callback)
        if (callbacks.size === 0) listeners.delete(key)
      }
    },
    subscribeActiveKey: () => () => {},
  }
}

describe("connectionNeedsAttention", () => {
  it.each([
    {
      name: "permission request",
      patch: {
        pendingPermission: {
          request_id: "permission-1",
          tool_call: {},
          options: [],
        },
      },
    },
    {
      name: "free-text question",
      patch: {
        pendingQuestion: { tool_call_id: "tool-1", question: "Continue?" },
      },
    },
    {
      name: "structured question",
      patch: {
        pendingAskQuestion: {
          question_id: "question-1",
          questions: [
            {
              id: "choice-1",
              question: "Choose",
              header: "Choice",
              multi_select: false,
              options: [],
            },
          ],
          created_at: "2026-09-19T00:00:00.000Z",
        },
      },
    },
    {
      name: "plan approval",
      patch: {
        pendingPlanApproval: {
          approval_id: "approval-1",
          tool_call_id: "tool-1",
          plan_markdown: "Plan",
          created_at: "2026-09-19T00:00:00.000Z",
        },
      },
    },
  ])("returns true for a pending $name", ({ patch }) => {
    expect(connectionNeedsAttention(connection(patch))).toBe(true)
  })

  it("ignores an empty structured-question payload", () => {
    expect(
      connectionNeedsAttention(
        connection({
          pendingAskQuestion: {
            question_id: "question-1",
            questions: [],
            created_at: "2026-09-19T00:00:00.000Z",
          },
        })
      )
    ).toBe(false)
  })
})

describe("sidebar conversation attention external store", () => {
  it("maps attention from open tab context keys to conversation keys", () => {
    const connections = new Map([
      [
        "tab-11",
        connection({
          contextKey: "tab-11",
          pendingQuestion: { tool_call_id: "tool-1", question: "Continue?" },
        }),
      ],
      ["tab-12", connection({ contextKey: "tab-12" })],
    ])
    const targets = sidebarAttentionTargets([
      tab("tab-11", 11),
      tab("tab-12", 12),
      tab("draft", null),
    ])
    const attention = createSidebarAttentionStore(targets, store(connections))

    expect(attention.getSnapshot()).toBe("claude_code:11")
  })

  it("subscribes only to open persisted conversation tabs and cleans up", () => {
    const connectionStore = store(new Map())
    const attention = createSidebarAttentionStore(
      sidebarAttentionTargets([
        tab("tab-11", 11),
        tab("tab-12", 12),
        tab("draft", null),
      ]),
      connectionStore
    )
    const listener = vi.fn()

    const unsubscribe = attention.subscribe(listener)
    expect([...connectionStore.listeners.keys()].sort()).toEqual([
      "tab-11",
      "tab-12",
    ])

    connectionStore.listeners.get("tab-11")?.forEach((callback) => callback())
    expect(listener).toHaveBeenCalledOnce()

    unsubscribe()
    expect(connectionStore.listeners.size).toBe(0)
  })
})

function observation(
  contextKey: string,
  conversationKey: string,
  status: ConnectionState["status"]
): SidebarCompletionObservation {
  return { contextKey, conversationKey, status }
}

function completionState(
  observations: SidebarCompletionObservation[] = [],
  unreadConversationKeys: string[] = []
): SidebarCompletionState {
  return {
    observations: new Map(
      observations.map((item) => [item.contextKey, item] as const)
    ),
    unreadConversationKeys: new Set(unreadConversationKeys),
  }
}

describe("sidebar conversation completion state", () => {
  it("does not mark an already-connected conversation unread on first observation", () => {
    const next = reduceSidebarCompletionState(
      completionState(),
      [observation("tab-11", "claude_code:11", "connected")],
      null
    )

    expect([...next.unreadConversationKeys]).toEqual([])
  })

  it("marks a background conversation unread when prompting finishes", () => {
    const previous = completionState([
      observation("tab-11", "claude_code:11", "prompting"),
    ])

    const next = reduceSidebarCompletionState(
      previous,
      [observation("tab-11", "claude_code:11", "connected")],
      "claude_code:12"
    )

    expect([...next.unreadConversationKeys]).toEqual(["claude_code:11"])
  })

  it("treats a completion in the active conversation as already read", () => {
    const previous = completionState([
      observation("tab-11", "claude_code:11", "prompting"),
    ])

    const next = reduceSidebarCompletionState(
      previous,
      [observation("tab-11", "claude_code:11", "connected")],
      "claude_code:11"
    )

    expect([...next.unreadConversationKeys]).toEqual([])
  })

  it("clears an unread completion when that conversation becomes active", () => {
    const previous = completionState(
      [observation("tab-11", "claude_code:11", "connected")],
      ["claude_code:11"]
    )

    const next = reduceSidebarCompletionState(
      previous,
      [observation("tab-11", "claude_code:11", "connected")],
      "claude_code:11"
    )

    expect([...next.unreadConversationKeys]).toEqual([])
  })

  it("clears the prior completion when a new prompt starts", () => {
    const previous = completionState(
      [observation("tab-11", "claude_code:11", "connected")],
      ["claude_code:11"]
    )

    const next = reduceSidebarCompletionState(
      previous,
      [observation("tab-11", "claude_code:11", "prompting")],
      null
    )

    expect([...next.unreadConversationKeys]).toEqual([])
  })

  it("drops unread state when the conversation tab closes", () => {
    const previous = completionState(
      [observation("tab-11", "claude_code:11", "connected")],
      ["claude_code:11"]
    )

    const next = reduceSidebarCompletionState(previous, [], null)

    expect([...next.unreadConversationKeys]).toEqual([])
  })
})
