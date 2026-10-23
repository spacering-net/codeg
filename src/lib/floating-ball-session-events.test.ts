import { describe, expect, vi, beforeEach } from "vitest"
import {
  requestDeleteConversation,
  requestFocusModeSelector,
  requestTogglePlanFull,
  eventMatchesConversation,
  DELETE_CONVERSATION_EVENT,
  FOCUS_MODE_SELECTOR_EVENT,
  TOGGLE_PLAN_FULL_EVENT,
} from "./floating-ball-session-events"

describe("floating-ball-session-events", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("dispatch carries the conversation id on the right event type", () => {
    const seen: Array<{ type: string; id: number | null }> = []
    const onDelete = (e: Event) =>
      seen.push({
        type: e.type,
        id: (e as CustomEvent<{ conversationId: number | null }>).detail
          .conversationId,
      })
    window.addEventListener(DELETE_CONVERSATION_EVENT, onDelete)
    window.addEventListener(FOCUS_MODE_SELECTOR_EVENT, onDelete)
    window.addEventListener(TOGGLE_PLAN_FULL_EVENT, onDelete)

    requestDeleteConversation(7)
    requestFocusModeSelector(null)
    requestTogglePlanFull(9)

    window.removeEventListener(DELETE_CONVERSATION_EVENT, onDelete)
    window.removeEventListener(FOCUS_MODE_SELECTOR_EVENT, onDelete)
    window.removeEventListener(TOGGLE_PLAN_FULL_EVENT, onDelete)

    expect(seen).toEqual([
      { type: DELETE_CONVERSATION_EVENT, id: 7 },
      { type: FOCUS_MODE_SELECTOR_EVENT, id: null },
      { type: TOGGLE_PLAN_FULL_EVENT, id: 9 },
    ])
  })

  it("eventMatchesConversation filters by id (multi-tab safety)", () => {
    expect(eventMatchesConversation({ conversationId: 3 }, 3)).toBe(true)
    expect(eventMatchesConversation({ conversationId: 3 }, 4)).toBe(false)
    // Draft (null) events only match draft instances.
    expect(eventMatchesConversation({ conversationId: null }, null)).toBe(true)
    expect(eventMatchesConversation({ conversationId: null }, 3)).toBe(false)
    expect(eventMatchesConversation(undefined, 3)).toBe(false)
  })
})
