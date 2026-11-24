import { describe, expect, it } from "vitest"

import { applyAskConversationChange } from "./use-ask-conversations"
import type { DbConversationSummary } from "@/lib/types"

function ask(
  overrides: Partial<DbConversationSummary> & { id: number }
): DbConversationSummary {
  return {
    folder_id: 1,
    title: null,
    title_locked: false,
    agent_type: "claude_code",
    status: "in_progress",
    kind: "ask",
    model: null,
    git_branch: null,
    external_id: null,
    message_count: 0,
    child_count: 0,
    created_at: "2026-11-24T00:00:00.000Z",
    updated_at: "2026-11-24T00:00:00.000Z",
    pinned_at: null,
    parent_id: 7,
    ...overrides,
  }
}

describe("applyAskConversationChange", () => {
  const older = ask({ id: 1, created_at: "2026-11-24T00:00:00.000Z" })
  const newer = ask({ id: 2, created_at: "2026-11-24T01:00:00.000Z" })

  it("adds a new ask of this conversation newest first", () => {
    const rows = applyAskConversationChange([older], 7, {
      kind: "upsert",
      summary: newer,
    })
    expect(rows.map((row) => row.id)).toEqual([2, 1])
  })

  it("replaces a listed ask in place", () => {
    const renamed = { ...older, title: "renamed" }
    const rows = applyAskConversationChange([newer, older], 7, {
      kind: "upsert",
      summary: renamed,
    })
    expect(rows).toEqual([newer, renamed])
  })

  it("drops an ask that was unlinked into an ordinary conversation", () => {
    const rows = applyAskConversationChange([newer, older], 7, {
      kind: "upsert",
      summary: { ...older, kind: "regular", parent_id: undefined },
    })
    expect(rows.map((row) => row.id)).toEqual([2])
  })

  it("ignores conversations that aren't this one's asks", () => {
    const rows = [newer]
    expect(
      applyAskConversationChange(rows, 7, {
        kind: "upsert",
        summary: ask({ id: 9, parent_id: 8 }),
      })
    ).toBe(rows)
    // A delegation child of this conversation is not one of its asks.
    expect(
      applyAskConversationChange(rows, 7, {
        kind: "upsert",
        summary: ask({ id: 10, kind: "delegate" }),
      })
    ).toBe(rows)
    expect(
      applyAskConversationChange(rows, 7, { kind: "deleted", id: 9 })
    ).toBe(rows)
    expect(
      applyAskConversationChange(rows, 7, {
        kind: "status",
        id: 9,
        status: "completed",
      })
    ).toBe(rows)
  })

  it("drops a deleted ask and follows a status change", () => {
    expect(
      applyAskConversationChange([newer, older], 7, { kind: "deleted", id: 2 })
    ).toEqual([older])
    const rows = applyAskConversationChange([newer], 7, {
      kind: "status",
      id: 2,
      status: "completed",
    })
    expect(rows[0].status).toBe("completed")
  })

  it("keeps a check list apart from the asks", () => {
    const check = ask({ id: 11, kind: "check" })
    // Into the checks…
    expect(
      applyAskConversationChange(
        [],
        7,
        { kind: "upsert", summary: check },
        "check"
      ).map((row) => row.id)
    ).toEqual([11])
    // …not the asks, and an ask is not a check.
    const asks = [newer]
    expect(
      applyAskConversationChange(asks, 7, { kind: "upsert", summary: check })
    ).toBe(asks)
    const checks = [check]
    expect(
      applyAskConversationChange(
        checks,
        7,
        { kind: "upsert", summary: older },
        "check"
      )
    ).toBe(checks)
  })
})
