import { describe, expect, it } from "vitest"

import type { BlockingPrompts } from "@/lib/blocking-prompts"
import {
  buildAttentionIndex,
  EMPTY_ATTENTION_INDEX,
  sameAttentionIndex,
} from "@/lib/conversation-attention"

const PERMISSION = { request_id: "r", tool_call: {}, options: [] }
const QUESTION = {
  question_id: "q",
  questions: [
    {
      id: "q",
      question: "Which DB?",
      header: "DB",
      multi_select: false,
      options: [],
    },
  ],
  created_at: "2026-10-18T00:00:00Z",
}
const PLAN = {
  approval_id: "p",
  tool_call_id: "tc",
  plan_markdown: "1. go",
  created_at: "2026-10-18T00:00:00Z",
}

function prompts(overrides: Partial<BlockingPrompts>): BlockingPrompts {
  return {
    permission: null,
    askQuestion: null,
    planApproval: null,
    ids: [],
    ...overrides,
  }
}

describe("buildAttentionIndex", () => {
  it("returns the shared empty index when nothing is parked", () => {
    // Allocating on every dispatch would churn every sidebar subscriber.
    expect(buildAttentionIndex([])).toBe(EMPTY_ATTENTION_INDEX)
    expect(buildAttentionIndex([{ conversationId: 1, prompts: null }])).toBe(
      EMPTY_ATTENTION_INDEX
    )
  })

  it("marks a conversation with the prompt it waits on", () => {
    const index = buildAttentionIndex([
      { conversationId: 7, prompts: prompts({ permission: PERMISSION }) },
    ])
    expect(index.get(7)).toBe("permission")
    expect(index.size).toBe(1)
  })

  it("skips a connection that serves no persisted row", () => {
    // A draft's first turn, and a delegated sub-agent, both have no row the
    // sidebar lists — there is nothing to mark.
    const index = buildAttentionIndex([
      { conversationId: null, prompts: prompts({ permission: PERMISSION }) },
      {
        conversationId: undefined,
        prompts: prompts({ askQuestion: QUESTION }),
      },
      // A client-side draft key: never a real row id.
      { conversationId: -9, prompts: prompts({ planApproval: PLAN }) },
      { conversationId: 0, prompts: prompts({ planApproval: PLAN }) },
    ])
    expect(index).toBe(EMPTY_ATTENTION_INDEX)
  })

  it("keeps the strongest block when two connections serve one conversation", () => {
    // An owner and a viewer can both hold the same conversation, as can a stale
    // entry the idle sweep has not reclaimed. Reporting either is honest; the
    // harder block is the more useful of the two.
    const index = buildAttentionIndex([
      { conversationId: 4, prompts: prompts({ planApproval: PLAN }) },
      { conversationId: 4, prompts: prompts({ askQuestion: QUESTION }) },
      { conversationId: 4, prompts: prompts({ permission: PERMISSION }) },
    ])
    expect(index.get(4)).toBe("permission")
    expect(index.size).toBe(1)
  })

  it("does not downgrade a mark from a later connection", () => {
    const index = buildAttentionIndex([
      { conversationId: 4, prompts: prompts({ permission: PERMISSION }) },
      { conversationId: 4, prompts: prompts({ planApproval: PLAN }) },
    ])
    expect(index.get(4)).toBe("permission")
  })

  it("marks every parked conversation, and only those", () => {
    const index = buildAttentionIndex([
      { conversationId: 1, prompts: prompts({ permission: PERMISSION }) },
      { conversationId: 2, prompts: null },
      { conversationId: 3, prompts: prompts({ askQuestion: QUESTION }) },
    ])
    expect([...index.keys()].sort()).toEqual([1, 3])
  })
})

describe("sameAttentionIndex", () => {
  it("treats one identity as unchanged, and a different mark as changed", () => {
    const a = buildAttentionIndex([
      { conversationId: 1, prompts: prompts({ permission: PERMISSION }) },
    ])
    expect(sameAttentionIndex(a, a)).toBe(true)
    expect(
      sameAttentionIndex(
        a,
        buildAttentionIndex([
          { conversationId: 1, prompts: prompts({ permission: PERMISSION }) },
        ])
      )
    ).toBe(true)
    // Same conversation, harder prompt: the kind changed even though the key set
    // did not — a key-set comparison alone would report "no change" and the row
    // would keep the stale mark.
    expect(
      sameAttentionIndex(
        a,
        buildAttentionIndex([
          { conversationId: 1, prompts: prompts({ askQuestion: QUESTION }) },
        ])
      )
    ).toBe(false)
  })

  it("sees an added or removed mark", () => {
    const one = buildAttentionIndex([
      { conversationId: 1, prompts: prompts({ permission: PERMISSION }) },
    ])
    const two = buildAttentionIndex([
      { conversationId: 1, prompts: prompts({ permission: PERMISSION }) },
      { conversationId: 2, prompts: prompts({ permission: PERMISSION }) },
    ])
    expect(sameAttentionIndex(one, two)).toBe(false)
    expect(sameAttentionIndex(two, one)).toBe(false)
    expect(sameAttentionIndex(one, EMPTY_ATTENTION_INDEX)).toBe(false)
  })
})
