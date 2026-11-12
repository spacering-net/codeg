import { describe, it, expect, vi } from "vitest"

import {
  pickModelFromTurns,
  resolveActiveSessionDetails,
} from "./active-session-details"
import type {
  DbConversationDetail,
  DbConversationSummary,
  MessageTurn,
  SessionStats,
} from "@/lib/types"
import type { ConversationRuntimeSession } from "@/contexts/conversation-runtime-context"

function summary(
  over: Partial<DbConversationSummary> = {}
): DbConversationSummary {
  return {
    id: 5,
    folder_id: 1,
    title: "t",
    title_locked: false,
    agent_type: "claude_code",
    status: "in_progress",
    kind: "regular",
    model: null,
    git_branch: null,
    external_id: null,
    message_count: 0,
    child_count: 0,
    created_at: "2026-06-10T10:00:00.000Z",
    updated_at: "2026-06-10T10:00:00.000Z",
    pinned_at: null,
    ...over,
  }
}

function stats(over: Partial<SessionStats> = {}): SessionStats {
  return {
    total_usage: null,
    total_tokens: null,
    total_duration_ms: 0,
    context_window_used_tokens: null,
    context_window_max_tokens: null,
    context_window_usage_percent: null,
    ...over,
  }
}

function detail(
  over: Partial<DbConversationDetail> = {}
): DbConversationDetail {
  return { summary: summary(), turns: [], ...over }
}

function turn(over: Partial<MessageTurn> = {}): MessageTurn {
  return {
    id: "t",
    role: "assistant",
    blocks: [],
    timestamp: "2026-06-10T10:00:00.000Z",
    ...over,
  }
}

// The resolver only reads `.detail` and `.sessionStats`, so a cast partial is
// enough and keeps the fixture focused.
function session(
  over: Partial<ConversationRuntimeSession>
): ConversationRuntimeSession {
  return {
    detail: null,
    sessionStats: null,
    ...over,
  } as ConversationRuntimeSession
}

describe("resolveActiveSessionDetails", () => {
  it("reads a persisted conversation's session under its conversationId", () => {
    const live = stats({ total_tokens: 42 })
    const getSession = vi.fn((id: number) =>
      id === 5
        ? session({
            detail: detail({ summary: summary({ id: 5 }) }),
            sessionStats: live,
          })
        : null
    )
    const result = resolveActiveSessionDetails(
      { conversationId: 5 },
      getSession,
      []
    )
    expect(result.summary?.id).toBe(5)
    expect(result.stats).toBe(live)
    expect(getSession).toHaveBeenCalledWith(5)
  })

  it("uses runtimeConversationId for a new conversation whose session is keyed virtually", () => {
    const live = stats({ total_tokens: 7 })
    // The live session lives under the virtual -7; the persisted id 5 has no
    // runtime session yet, only a workspace summary.
    const getSession = vi.fn((id: number) =>
      id === -7 ? session({ detail: null, sessionStats: live }) : null
    )
    const result = resolveActiveSessionDetails(
      { conversationId: 5, runtimeConversationId: -7 },
      getSession,
      [summary({ id: 5, title: "from-workspace" })]
    )
    // Stats come from the virtual-keyed runtime session, summary from the
    // workspace fallback — never a bogus "no session" / disabled state.
    expect(result.stats).toBe(live)
    expect(result.summary?.title).toBe("from-workspace")
    expect(getSession).toHaveBeenCalledWith(-7)
    expect(getSession).not.toHaveBeenCalledWith(5)
  })

  it("prefers the loaded detail summary over the workspace summary", () => {
    const getSession = vi.fn(() =>
      session({
        detail: detail({
          summary: summary({ id: 5, external_id: "from-detail" }),
        }),
      })
    )
    const result = resolveActiveSessionDetails(
      { conversationId: 5 },
      getSession,
      [summary({ id: 5, external_id: null })]
    )
    expect(result.summary?.external_id).toBe("from-detail")
  })

  // The loaded detail is a snapshot of when the transcript was fetched; the
  // workspace list follows the backend's status/upsert events.
  it("takes the status and title from the live workspace row", () => {
    const loaded = summary({ id: 5, title: "old", status: "in_progress" })
    const getSession = vi.fn(() =>
      session({ detail: detail({ summary: loaded }) })
    )
    const result = resolveActiveSessionDetails(
      { conversationId: 5 },
      getSession,
      [summary({ id: 5, title: "renamed", status: "pending_review" })]
    )
    expect(result.summary?.status).toBe("pending_review")
    expect(result.summary?.title).toBe("renamed")
    // The rest is still the loaded detail's.
    expect(result.summary?.created_at).toBe(loaded.created_at)
  })

  // A sub-agent's conversation isn't in the workspace list; the tab's status
  // comes from the child-summary cache, which follows the same events.
  it("takes the status from the tab when the list doesn't hold the row", () => {
    const getSession = vi.fn(() =>
      session({
        detail: detail({ summary: summary({ id: 5, status: "in_progress" }) }),
      })
    )
    const result = resolveActiveSessionDetails(
      { conversationId: 5, status: "completed" },
      getSession,
      []
    )
    expect(result.summary?.status).toBe("completed")
  })

  it("hands back the loaded summary itself while it is current", () => {
    const loaded = summary({ id: 5 })
    const getSession = vi.fn(() =>
      session({ detail: detail({ summary: loaded }) })
    )
    const result = resolveActiveSessionDetails(
      { conversationId: 5, status: loaded.status },
      getSession,
      [summary({ id: 5 })]
    )
    expect(result.summary).toBe(loaded)
  })

  it("falls back to detail.session_stats when sessionStats is absent", () => {
    const ds = stats({ total_tokens: 99 })
    const getSession = vi.fn(() =>
      session({
        detail: detail({ summary: summary(), session_stats: ds }),
        sessionStats: null,
      })
    )
    const result = resolveActiveSessionDetails(
      { conversationId: 5 },
      getSession,
      []
    )
    expect(result.stats).toBe(ds)
  })

  it("returns nulls for a missing tab", () => {
    const getSession = vi.fn(() => null)
    const result = resolveActiveSessionDetails(null, getSession, [])
    expect(result.summary).toBeNull()
    expect(result.stats).toBeNull()
    expect(getSession).not.toHaveBeenCalled()
  })

  it("returns a null summary when neither a session nor a workspace row exists", () => {
    const getSession = vi.fn(() => null)
    const result = resolveActiveSessionDetails(
      { conversationId: 9 },
      getSession,
      []
    )
    expect(result.summary).toBeNull()
    expect(result.stats).toBeNull()
  })

  it("resolves the model from the latest live turn", () => {
    const getSession = vi.fn(() =>
      session({
        localTurns: [turn({ model: "model-a" }), turn({ model: "model-b" })],
      })
    )
    const result = resolveActiveSessionDetails(
      { conversationId: 5 },
      getSession,
      []
    )
    expect(result.model).toBe("model-b")
  })

  it("falls back to detail.turns for the model when there are no live turns", () => {
    const getSession = vi.fn(() =>
      session({
        detail: detail({ turns: [turn({ model: "hist-model" })] }),
        localTurns: [],
      })
    )
    const result = resolveActiveSessionDetails(
      { conversationId: 5 },
      getSession,
      []
    )
    expect(result.model).toBe("hist-model")
  })

  it("returns a null model when no turn records one", () => {
    const getSession = vi.fn(() =>
      session({ localTurns: [turn({ model: null })] })
    )
    const result = resolveActiveSessionDetails(
      { conversationId: 5 },
      getSession,
      []
    )
    expect(result.model).toBeNull()
  })
})

describe("pickModelFromTurns", () => {
  it("returns the most recent turn's model", () => {
    expect(
      pickModelFromTurns([turn({ model: "a" }), turn({ model: "b" })])
    ).toBe("b")
  })

  it("skips turns without a model", () => {
    expect(
      pickModelFromTurns([turn({ model: "a" }), turn({ model: null })])
    ).toBe("a")
  })

  it("returns null when no turn has a model", () => {
    expect(pickModelFromTurns([turn(), turn()])).toBeNull()
  })

  it("returns null for an empty list", () => {
    expect(pickModelFromTurns([])).toBeNull()
  })
})
