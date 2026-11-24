/**
 * The workbench row's action, derived from ONE reverse-lookup row.
 *
 * No test here can see the backend's `ACTIVE_STATUSES` (it is Rust), so this
 * does not prove parity with it — what it pins is the classification of every
 * status the frontend knows about, and, through the `Record` below, that a
 * status added to the union cannot be left unclassified. The drift that would
 * hurt (a live status silently reading as terminal, offering a re-trigger for
 * a running task) shows up as a type error rather than as a wrong chip.
 */
import { describe, expect, it } from "vitest"

import { chipStateForLink, type ForgeChipState } from "./forge-task-chip"
import type { ForgeTaskLink, WorkTaskStatus } from "./types"

function link(status: WorkTaskStatus): ForgeTaskLink {
  return {
    source_key: "github:github.com/o/r/issue/1",
    task_id: 3,
    status,
    verdict: null,
    updated_at: "2026-08-19T00:00:00Z",
  }
}

/**
 * Every member of the status union, classified — the `Record` is the real
 * guard here. A status added to `WorkTaskStatus` (mirroring a new backend
 * state) with no line here fails `tsc`, and `tsc` is the only check that can
 * see the union at all; at runtime an unclassified status would just fall
 * through to "terminal" and offer a re-trigger for a live task.
 */
const EXPECTED: Record<WorkTaskStatus, ForgeChipState> = {
  todo: "active",
  queued: "active",
  preparing: "active",
  running: "active",
  awaiting_input: "active",
  review: "active",
  merging: "active",
  done: "terminal",
  failed: "terminal",
  canceled: "terminal",
}

describe("chipStateForLink", () => {
  it("offers Start when nothing has ever handled the item", () => {
    expect(chipStateForLink(null)).toBe("none")
    expect(chipStateForLink(undefined)).toBe("none")
  })

  it.each(Object.entries(EXPECTED))("reads %s as %s", (status, expected) => {
    expect(chipStateForLink(link(status as WorkTaskStatus))).toBe(expected)
  })
})
