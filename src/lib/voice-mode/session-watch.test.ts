import { describe, expect, it } from "vitest"
import type { PetSessionEntry, PetSessionsPayload } from "@/lib/pet/types"
import { diffPetSessions } from "./session-watch"

function entry(
  id: string,
  over: Partial<PetSessionEntry> = {}
): PetSessionEntry {
  return {
    connectionId: id,
    conversationId: 1,
    folderId: 1,
    agentType: "codex",
    title: `Session ${id}`,
    status: "prompting",
    ...over,
  }
}

function payload(sessions: PetSessionEntry[]): PetSessionsPayload {
  return { runningCount: 0, waitingCount: 0, errorCount: 0, sessions }
}

const pending = {
  requestId: "r1",
  toolCall: {},
  options: [],
} as unknown as NonNullable<PetSessionEntry["pending"]>

describe("diffPetSessions", () => {
  it("reports a prompting session that leaves the list as finished", () => {
    const events = diffPetSessions(payload([entry("a")]), payload([]), null)
    expect(events).toEqual([
      {
        kind: "finished",
        connectionId: "a",
        agentType: "codex",
        title: "Session a",
      },
    ])
  })

  it("reports newly pending approvals and new errors once", () => {
    const prev = payload([entry("a"), entry("b")])
    const next = payload([
      entry("a", { pending }),
      entry("b", { status: "error" }),
    ])
    expect(diffPetSessions(prev, next, null).map((e) => e.kind)).toEqual([
      "needsApproval",
      "failed",
    ])
    expect(diffPetSessions(next, next, null)).toEqual([])
  })

  it("does not report a session that leaves while waiting on approval", () => {
    const prev = payload([entry("a", { pending })])
    expect(diffPetSessions(prev, payload([]), null)).toEqual([])
  })

  it("ignores delegation children and the assistant's own connection", () => {
    const parent = {
      conversationId: 2,
      folderId: 1,
      agentType: "codex" as const,
      title: "Parent",
    }
    const prev = payload([entry("child", { parent }), entry("assistant")])
    const next = payload([
      entry("child", { parent, pending }),
      entry("assistant", { status: "error" }),
    ])
    expect(diffPetSessions(prev, next, "assistant")).toEqual([])
    expect(diffPetSessions(prev, payload([]), "assistant")).toEqual([])
  })

  it("reports nothing against the first snapshot", () => {
    expect(diffPetSessions(null, payload([entry("a")]), null)).toEqual([])
  })
})
