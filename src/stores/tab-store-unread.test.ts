/**
 * The unread dot: a `pending_review` conversation whose latest turn finished
 * while the user was looking elsewhere shows purple until they focus its tab.
 *
 * It is a view-layer overlay, NOT a fifth `ConversationStatus` — the backend
 * and the DB are untouched, and the set lives only in memory. These tests pin
 * the three transitions that matter (mark, don't-mark, clear) plus the two
 * traps: hydration must not paint history, and a recompute must not wipe it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { DbConversationSummary } from "@/lib/types"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "./app-workspace-store"
import { resetTabStore, useTabStore } from "./tab-store"

vi.mock("@/lib/api", () => ({
  listOpenedTabs: vi.fn(),
  saveOpenedTabs: vi.fn(),
  getFolderConversation: vi.fn(),
}))

vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn(),
  onTransportReconnect: vi.fn(),
}))

const WATCHED = 1
const BACKGROUND = 2

function conversation(
  id: number,
  status: DbConversationSummary["status"]
): DbConversationSummary {
  return {
    id,
    folder_id: 1,
    agent_type: "claude_code",
    title: `conv ${id}`,
    status,
    message_count: 1,
    updated_at: "2026-01-01T00:00:00.000Z",
  } as unknown as DbConversationSummary
}

/** Two tabs, the first focused — the second is the one "in the background". */
function seedTabs(activeId: string) {
  useTabStore.setState({
    rawTabs: [
      {
        id: `conv-${WATCHED}`,
        kind: "conversation",
        folderId: 1,
        conversationId: WATCHED,
        agentType: "claude_code",
        title: "watched",
        isPinned: false,
      },
      {
        id: `conv-${BACKGROUND}`,
        kind: "conversation",
        folderId: 1,
        conversationId: BACKGROUND,
        agentType: "claude_code",
        title: "background",
        isPinned: false,
      },
    ],
    activeTabId: activeId,
    tabsHydrated: true,
  })
}

/** Move a conversation to `status` through the store's own patch path, which is
 *  what the `conversation_status_changed` bridge calls. */
function setStatus(id: number, status: DbConversationSummary["status"]) {
  useAppWorkspaceStore.getState().updateConversationLocal(id, { status })
}

const unreadOf = (id: number) =>
  useTabStore.getState().unreadConversationIds.has(id)

/** `hasUnread` is absent (not `false`) when clear, matching the file's other
 *  optional tab flags — the UI only ever reads it for truthiness. */
const hasUnreadFlag = (tabId: string) =>
  useTabStore.getState().tabs.find((t) => t.id === tabId)?.hasUnread

beforeEach(() => {
  resetTabStore()
  resetAppWorkspaceStore()
})

afterEach(() => {
  resetTabStore()
  resetAppWorkspaceStore()
})

describe("unread dot", () => {
  it("marks a background conversation unread when its turn lands", () => {
    useAppWorkspaceStore.setState({
      conversations: [
        conversation(WATCHED, "in_progress"),
        conversation(BACKGROUND, "in_progress"),
      ],
    })
    seedTabs(`conv-${WATCHED}`)

    setStatus(BACKGROUND, "pending_review")

    expect(unreadOf(BACKGROUND)).toBe(true)
    expect(hasUnreadFlag(`conv-${BACKGROUND}`)).toBe(true)
  })

  it("does not mark the conversation the user is looking at", () => {
    useAppWorkspaceStore.setState({
      conversations: [conversation(WATCHED, "in_progress")],
    })
    seedTabs(`conv-${WATCHED}`)

    setStatus(WATCHED, "pending_review")

    expect(unreadOf(WATCHED)).toBe(false)
    // The status itself still advances — only the purple overlay is skipped.
    expect(
      useTabStore.getState().tabs.find((t) => t.id === `conv-${WATCHED}`)
        ?.status
    ).toBe("pending_review")
  })

  it("clears the dot when its tab is focused", () => {
    useAppWorkspaceStore.setState({
      conversations: [
        conversation(WATCHED, "in_progress"),
        conversation(BACKGROUND, "in_progress"),
      ],
    })
    seedTabs(`conv-${WATCHED}`)
    setStatus(BACKGROUND, "pending_review")
    expect(unreadOf(BACKGROUND)).toBe(true)

    useTabStore.getState().switchTab(`conv-${BACKGROUND}`)

    expect(unreadOf(BACKGROUND)).toBe(false)
    expect(hasUnreadFlag(`conv-${BACKGROUND}`)).toBeFalsy()
    // Underneath, it is still pending_review — the blue the user asked for.
    expect(
      useTabStore.getState().tabs.find((t) => t.id === `conv-${BACKGROUND}`)
        ?.status
    ).toBe("pending_review")
  })

  it("survives a recompute that only re-derives titles and statuses", () => {
    useAppWorkspaceStore.setState({
      conversations: [
        conversation(WATCHED, "in_progress"),
        conversation(BACKGROUND, "in_progress"),
      ],
    })
    seedTabs(`conv-${WATCHED}`)
    setStatus(BACKGROUND, "pending_review")
    expect(hasUnreadFlag(`conv-${BACKGROUND}`)).toBe(true)

    // An unrelated title change forces the derive to rebuild the tab objects.
    useAppWorkspaceStore
      .getState()
      .updateConversationLocal(BACKGROUND, { title: "renamed" })

    expect(hasUnreadFlag(`conv-${BACKGROUND}`)).toBe(true)
  })

  it("does not mark an already-pending conversation on first hydration", () => {
    // History arrives in one shot, with no transition to observe.
    useAppWorkspaceStore.setState({
      conversations: [conversation(BACKGROUND, "pending_review")],
    })
    seedTabs(`conv-${WATCHED}`)

    expect(unreadOf(BACKGROUND)).toBe(false)
    expect(hasUnreadFlag(`conv-${BACKGROUND}`)).toBeFalsy()
  })

  it("drops the dot once the conversation leaves review", () => {
    useAppWorkspaceStore.setState({
      conversations: [
        conversation(WATCHED, "in_progress"),
        conversation(BACKGROUND, "in_progress"),
      ],
    })
    seedTabs(`conv-${WATCHED}`)
    setStatus(BACKGROUND, "pending_review")
    expect(unreadOf(BACKGROUND)).toBe(true)

    setStatus(BACKGROUND, "completed")

    expect(unreadOf(BACKGROUND)).toBe(false)
  })

  it("does not mark a cancelled turn — errors toast, they do not need a dot", () => {
    useAppWorkspaceStore.setState({
      conversations: [
        conversation(WATCHED, "in_progress"),
        conversation(BACKGROUND, "in_progress"),
      ],
    })
    seedTabs(`conv-${WATCHED}`)

    setStatus(BACKGROUND, "cancelled")

    expect(unreadOf(BACKGROUND)).toBe(false)
  })
})
