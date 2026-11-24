import { describe, expect, it } from "vitest"
import type { PetSessionEntry, PetSessionsPayload } from "@/lib/pet/types"
import {
  pickPetBadge,
  sessionSortRank,
  sessionStatusKind,
} from "@/lib/pet/session-display"

function entry(over: Partial<PetSessionEntry> = {}): PetSessionEntry {
  return {
    connectionId: "c",
    conversationId: 1,
    folderId: 1,
    agentType: "claude_code",
    title: "t",
    status: "prompting",
    ...over,
  }
}

const pending = {
  requestId: "r",
  toolCall: {},
  options: [],
}

function payload(over: Partial<PetSessionsPayload> = {}): PetSessionsPayload {
  return {
    runningCount: 0,
    waitingCount: 0,
    errorCount: 0,
    sessions: [],
    ...over,
  }
}

describe("pickPetBadge", () => {
  it("returns null when idle", () => {
    expect(pickPetBadge(payload())).toBeNull()
  })

  it("shows running count when only running", () => {
    expect(pickPetBadge(payload({ runningCount: 3 }))).toEqual({
      kind: "running",
      count: 3,
    })
  })

  it("waiting outranks running", () => {
    expect(pickPetBadge(payload({ runningCount: 2, waitingCount: 1 }))).toEqual(
      { kind: "waiting", count: 1 }
    )
  })

  it("error outranks waiting and running", () => {
    expect(
      pickPetBadge(payload({ runningCount: 5, waitingCount: 2, errorCount: 1 }))
    ).toEqual({ kind: "error", count: 1 })
  })
})

describe("sessionStatusKind", () => {
  it("a pending permission is waiting even while prompting", () => {
    expect(sessionStatusKind(entry({ status: "prompting", pending }))).toBe(
      "waiting"
    )
  })

  it("a question or a plan approval is waiting too", () => {
    for (const kind of ["question", "plan"] as const) {
      const ask = { kind, text: "Which database?" }
      expect(sessionStatusKind(entry({ status: "prompting", ask }))).toBe(
        "waiting"
      )
      expect(sessionSortRank(entry({ ask }))).toBe(0)
    }
  })

  it("errored connection is error", () => {
    expect(sessionStatusKind(entry({ status: "error" }))).toBe("error")
  })

  it("prompting with no permission is running", () => {
    expect(sessionStatusKind(entry({ status: "prompting" }))).toBe("running")
  })
})

describe("sessionSortRank", () => {
  it("orders waiting < error < running", () => {
    const waiting = sessionSortRank(entry({ pending }))
    const errored = sessionSortRank(entry({ status: "error" }))
    const running = sessionSortRank(entry({ status: "prompting" }))
    expect(waiting).toBeLessThan(errored)
    expect(errored).toBeLessThan(running)
  })
})
