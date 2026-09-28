import { describe, expect, it } from "vitest"
import type { DbConversationDetail } from "@/lib/types"
import {
  PersistedConversationErrorAlertTracker,
  selectPersistedConversationErrorAlert,
} from "@/lib/persisted-conversation-error-alert"

function detail(
  id: number,
  revision: number,
  message: string,
  code: string | null = null,
  connectionId: string | null = null
): DbConversationDetail {
  return {
    summary: { id } as DbConversationDetail["summary"],
    last_error: { message, code, details: null },
    last_error_revision: revision,
    last_error_connection_id: connectionId,
    turns: [],
  }
}

describe("persisted conversation error alerts", () => {
  it("shows a cold-loaded history error once and keeps it scoped to its conversation", () => {
    const tracker = new PersistedConversationErrorAlertTracker()
    const first = selectPersistedConversationErrorAlert({
      conversationId: 17,
      detail: detail(17, 3, "history failed"),
      liveError: null,
      status: "disconnected",
      retiredRevision: null,
    })
    expect(first).toEqual({
      key: "persisted-acp-error:17:3",
      revisionKey: "persisted-acp-error:17:3",
      liveTurnFailurePrefix: null,
      level: "error",
      message: "history failed",
    })
    expect(tracker.claim(first!.revisionKey)).toBe(true)
    expect(tracker.claim(first!.revisionKey)).toBe(false)
    expect(
      selectPersistedConversationErrorAlert({
        conversationId: 18,
        detail: detail(17, 3, "history failed"),
        liveError: null,
        status: "disconnected",
        retiredRevision: null,
      })
    ).toBeNull()
    const second = selectPersistedConversationErrorAlert({
      conversationId: 18,
      detail: detail(18, 1, "other failure"),
      liveError: null,
      status: "disconnected",
      retiredRevision: null,
    })
    expect(second?.key).toBe("persisted-acp-error:18:1")
    expect(tracker.claim(second!.revisionKey)).toBe(true)
  })

  it("skips the live error and retires the old detail on a new prompt", () => {
    const old = detail(17, 3, "old failure")
    const input = {
      conversationId: 17,
      detail: old,
      liveError: "old failure",
      status: "connected",
      retiredRevision: null,
    }
    expect(selectPersistedConversationErrorAlert(input)).toBeNull()
    expect(
      selectPersistedConversationErrorAlert({
        ...input,
        liveError: null,
        status: "prompting",
      })
    ).toBeNull()
    expect(
      selectPersistedConversationErrorAlert({
        ...input,
        liveError: null,
        retiredRevision: 3,
      })
    ).toBeNull()
    expect(
      selectPersistedConversationErrorAlert({
        ...input,
        detail: detail(17, 4, "new failure"),
        liveError: null,
        retiredRevision: 3,
      })?.key
    ).toBe("persisted-acp-error:17:4")
  })

  it("reuses the live connection key after a detail refetch and reconnect", () => {
    const tracker = new PersistedConversationErrorAlertTracker()
    const fresh = detail(
      17,
      4,
      "transport stopped",
      "process_exited",
      "live-conn"
    )
    expect(
      selectPersistedConversationErrorAlert({
        conversationId: 17,
        detail: fresh,
        liveError: "transport stopped",
        status: "connected",
        retiredRevision: null,
      })
    ).toBeNull()
    const recovered = selectPersistedConversationErrorAlert({
      conversationId: 17,
      detail: fresh,
      liveError: null,
      status: "connected",
      retiredRevision: null,
    })
    expect(recovered).toMatchObject({
      key: "acp-error:live-conn:process_exited",
      revisionKey: "persisted-acp-error:17:4",
    })
    expect(tracker.claim(recovered!.revisionKey)).toBe(true)
    expect(tracker.claim(recovered!.revisionKey)).toBe(false)
    // Another client's new error has another connection identity.
    expect(
      selectPersistedConversationErrorAlert({
        conversationId: 17,
        detail: detail(
          17,
          5,
          "other client failed",
          "process_exited",
          "other-conn"
        ),
        liveError: null,
        status: "connected",
        retiredRevision: null,
      })?.key
    ).toBe("acp-error:other-conn:process_exited")
  })

  it("recognizes a live turn-failure serial without restoring a second alert", () => {
    const tracker = new PersistedConversationErrorAlertTracker()
    tracker.markLiveKey("acp-turn-failure:live-conn:42")
    const recovered = selectPersistedConversationErrorAlert({
      conversationId: 17,
      detail: detail(17, 8, "turn failed", "turn_failed_empty", "live-conn"),
      liveError: null,
      status: "disconnected",
      retiredRevision: null,
    })
    expect(recovered?.key).toBe("persisted-acp-error:17:8")
    expect(tracker.wasLiveNotified(recovered!)).toBe(true)
  })

  it("uses the raw message for a code-less live error key", () => {
    const restored = selectPersistedConversationErrorAlert({
      conversationId: 17,
      detail: detail(17, 7, "provider returned EOF", null, "live-conn"),
      liveError: null,
      status: "disconnected",
      retiredRevision: null,
    })
    expect(restored?.key).toBe("acp-error:live-conn:provider returned EOF")
  })

  it("follows upstream routing for warning and transcript-only errors", () => {
    expect(
      selectPersistedConversationErrorAlert({
        conversationId: 17,
        detail: detail(17, 1, "lost context", "session_load_fallback"),
        liveError: null,
        status: "connected",
        retiredRevision: null,
      })?.level
    ).toBe("warning")
    expect(
      selectPersistedConversationErrorAlert({
        conversationId: 17,
        detail: detail(17, 2, "already in transcript", "compaction_failed"),
        liveError: null,
        status: "connected",
        retiredRevision: null,
      })
    ).toBeNull()
    expect(
      selectPersistedConversationErrorAlert({
        conversationId: 17,
        detail: detail(17, 3, "old action", "set_mode_failed"),
        liveError: null,
        status: "disconnected",
        retiredRevision: null,
      })
    ).toBeNull()
  })
})
