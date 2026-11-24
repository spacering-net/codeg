/**
 * The resurrection guard's refusal is the one restart failure the UI must
 * recognize rather than toast: it repeats for as long as the other task lives,
 * so a card that cannot detect it has no road back into the active set.
 */
import { describe, expect, it } from "vitest"

import {
  duplicateActiveSource,
  duplicateActiveSourceLabel,
} from "./task-restart-guard"

/** As `retry` delivers it: DbError's Display wraps the marker twice over. */
const RETRY_WIRE =
  "validation error: validation error: duplicate_active_source: task #7 (Fix login) is already active for this work item"
/** As `requeue` delivers it: propagated, so wrapped once. */
const REQUEUE_WIRE =
  "validation error: duplicate_active_source: task #7 (Fix login) is already active for this work item"

describe("duplicateActiveSource", () => {
  it("reads both wire shapes the two restart roads produce", () => {
    for (const wire of [RETRY_WIRE, REQUEUE_WIRE]) {
      expect(duplicateActiveSource(new Error(wire))).toEqual({
        id: 7,
        title: "Fix login",
      })
    }
  })

  it("takes the title whole when it ends in a paren of its own", () => {
    // A lazy capture would stop at the inner `)` and hand the user a truncated
    // name for the task blocking them.
    const err = new Error(
      "validation error: duplicate_active_source: task #12 (Fix login (again)) is already active for this work item"
    )
    expect(duplicateActiveSource(err)).toEqual({
      id: 12,
      title: "Fix login (again)",
    })
  })

  it("reads the marker through both transports, not just the desktop one", () => {
    // Desktop: the Tauri command returns `Result<(), DbError>` and DbError
    // serializes as its Display string, so `invoke` rejects with a bare
    // string.
    expect(duplicateActiveSource(RETRY_WIRE)).toEqual({
      id: 7,
      title: "Fix login",
    })
    // Web: the handler throws the parsed `AppCommandError` OBJECT, whose
    // `message` is the generic "Database operation failed" — only `detail`
    // carries the marker. A match on `message` alone would leave the whole
    // server mode with no way through.
    expect(
      duplicateActiveSource({
        code: "database_error",
        message: "Database operation failed",
        detail: REQUEUE_WIRE,
      })
    ).toEqual({ id: 7, title: "Fix login" })
  })

  it("is not fooled into hanging by a hostile issue title", () => {
    // Titles come from the forge and become task titles verbatim. The capture
    // is greedy with an anchored suffix; a title built to backtrack must
    // still resolve promptly.
    const hostile = `${"(".repeat(2000)}${"a )".repeat(2000)}`
    const started = performance.now()
    const parsed = duplicateActiveSource(
      `validation error: duplicate_active_source: task #3 (${hostile}) is already active for this work item`
    )
    expect(performance.now() - started).toBeLessThan(1000)
    expect(parsed?.id).toBe(3)
  })

  it("still offers the override when only the marker survives", () => {
    // The marker is the contract; the sentence around it is not. A reworded
    // detail must not silently turn a recoverable refusal into a dead end.
    const err = new Error("validation error: duplicate_active_source: blocked")
    expect(duplicateActiveSource(err)).toEqual({ id: null, title: null })
  })

  it("leaves every other failure alone", () => {
    expect(duplicateActiveSource(new Error("task is not in failed"))).toBeNull()
    expect(duplicateActiveSource(null)).toBeNull()
    expect(duplicateActiveSource(undefined)).toBeNull()
  })
})

describe("duplicateActiveSourceLabel", () => {
  it("names the blocking task", () => {
    expect(
      duplicateActiveSourceLabel({ id: 7, title: "Fix login" }, "Another task")
    ).toBe("#7 (Fix login)")
  })

  it("drops the empty parens when the title did not survive", () => {
    expect(
      duplicateActiveSourceLabel({ id: 7, title: null }, "Another task")
    ).toBe("#7")
  })

  it("falls back to the localized stand-in with no id to point at", () => {
    expect(
      duplicateActiveSourceLabel({ id: null, title: null }, "Another task")
    ).toBe("Another task")
  })
})
