import { describe, expect, it } from "vitest"

import {
  MAX_STEP_MARKS,
  progressFromLiveContent,
  progressFromReport,
  progressKey,
  tallySteps,
} from "./progress"

describe("progressFromReport", () => {
  it("reads the broker's progress", () => {
    expect(
      progressFromReport({
        steps: 4,
        marks: ["ok", "failed", "ok", "ok"],
        last_step: "pnpm test\nmore",
      })
    ).toEqual({
      steps: 4,
      marks: ["ok", "failed", "ok", "ok"],
      lastStep: "pnpm test",
    })
  })

  it("keeps what it can of a malformed one", () => {
    expect(progressFromReport(null)).toBeNull()
    expect(progressFromReport({ marks: ["ok"] })).toBeNull()
    expect(progressFromReport({ steps: -1 })).toBeNull()
    const odd = progressFromReport({ steps: 1, marks: ["ok", "maybe", "ok"] })
    // Never fewer steps than the marks it draws.
    expect(odd).toEqual({ steps: 2, marks: ["ok", "ok"], lastStep: null })
  })
})

describe("progressFromLiveContent", () => {
  const call = (status: string, title: string) => ({
    type: "tool_call",
    info: { status, title },
  })

  it("tallies a live turn's finished calls in the order they started", () => {
    expect(
      progressFromLiveContent([
        { type: "text" },
        call("completed", "Read a.ts"),
        call("failed", "pnpm test"),
        { type: "thinking" },
        call("in_progress", "Edit a.ts"),
      ])
    ).toEqual({
      steps: 2,
      marks: ["ok", "failed"],
      lastStep: "Edit a.ts",
    })
  })

  it("has nothing for a turn that called no tool", () => {
    expect(progressFromLiveContent([{ type: "text" }])).toBeNull()
  })
})

describe("tallySteps", () => {
  it("draws the latest marks and counts the rest", () => {
    const steps = Array.from({ length: MAX_STEP_MARKS + 2 }, (_, i) => ({
      mark: i === 0 ? ("failed" as const) : ("ok" as const),
      title: `step ${i}`,
    }))
    const progress = tallySteps(steps)
    expect(progress?.steps).toBe(MAX_STEP_MARKS + 2)
    expect(progress?.marks).toHaveLength(MAX_STEP_MARKS)
    expect(progress?.marks.includes("failed")).toBe(false)
    expect(progress?.lastStep).toBe(`step ${MAX_STEP_MARKS + 1}`)
  })
})

describe("progressKey", () => {
  it("changes exactly when the drawn progress does", () => {
    const a = { steps: 1, marks: ["ok" as const], lastStep: "x" }
    expect(progressKey(a)).toBe(progressKey({ ...a, marks: ["ok"] }))
    expect(progressKey(a)).not.toBe(progressKey({ ...a, lastStep: "y" }))
    expect(progressKey(null)).toBe("")
  })
})
