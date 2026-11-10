import { describe, expect, it } from "vitest"

import {
  extractPlanMarkdown,
  isPlanLikeToolName,
  isPlanModeToolName,
  kimiTodoWriteEntries,
  normalizePriority,
  normalizeStatus,
  parseTodosFromJson,
} from "./plan-parse"

describe("normalizeStatus", () => {
  it("maps common synonyms to the canonical status", () => {
    expect(normalizeStatus("completed")).toBe("completed")
    expect(normalizeStatus("done")).toBe("completed")
    expect(normalizeStatus("in_progress")).toBe("in_progress")
    expect(normalizeStatus("in-progress")).toBe("in_progress")
    expect(normalizeStatus("running")).toBe("in_progress")
    expect(normalizeStatus("active")).toBe("in_progress")
    expect(normalizeStatus("pending")).toBe("pending")
    expect(normalizeStatus("whatever")).toBe("pending")
    expect(normalizeStatus(undefined)).toBe("pending")
  })
})

describe("normalizePriority", () => {
  it("maps to high/medium/low with medium as default", () => {
    expect(normalizePriority("high")).toBe("high")
    expect(normalizePriority("urgent")).toBe("high")
    expect(normalizePriority("low")).toBe("low")
    expect(normalizePriority("medium")).toBe("medium")
    expect(normalizePriority("nonsense")).toBe("medium")
    expect(normalizePriority(undefined)).toBe("medium")
  })
})

describe("isPlanLikeToolName", () => {
  it("recognizes TodoWrite (any casing/separator) and plan-named tools", () => {
    expect(isPlanLikeToolName("TodoWrite")).toBe(true)
    expect(isPlanLikeToolName("todo_write")).toBe(true)
    expect(isPlanLikeToolName("update_plan")).toBe(true)
    expect(isPlanLikeToolName("exit_plan_mode")).toBe(true)
  })

  it("recognizes Kimi Code's TodoList (separators stripped)", () => {
    expect(isPlanLikeToolName("TodoList")).toBe(true)
    expect(isPlanLikeToolName("todo_list")).toBe(true)
  })

  it("returns false for unrelated tools", () => {
    expect(isPlanLikeToolName("Bash")).toBe(false)
    expect(isPlanLikeToolName("read_file")).toBe(false)
  })
})

describe("isPlanModeToolName", () => {
  it("recognizes plan-mode transition tools (any casing/separator)", () => {
    expect(isPlanModeToolName("EnterPlanMode")).toBe(true)
    expect(isPlanModeToolName("enter_plan_mode")).toBe(true)
    expect(isPlanModeToolName("ExitPlanMode")).toBe(true)
    expect(isPlanModeToolName("exit_plan_mode")).toBe(true)
    expect(isPlanModeToolName("switch_mode")).toBe(true)
    expect(isPlanModeToolName("switchMode")).toBe(true)
    expect(isPlanModeToolName("plan_review")).toBe(true)
    expect(isPlanModeToolName("planReview")).toBe(true)
  })

  it("plan_review is also plan-like, harmlessly (the seeded call has no input)", () => {
    // codex-acp ≥1.1.8's review gate contains "plan", so it matches the broader
    // predicate too. That is fine: codeg seeds the call WITHOUT rawInput, so
    // agent-plan's extractor finds no entries and builds no plan checklist.
    expect(isPlanLikeToolName("plan_review")).toBe(true)
    expect(isPlanModeToolName("plan_review")).toBe(true)
  })

  it("is narrower than isPlanLikeToolName: update_plan is plan-like, not plan-mode", () => {
    // update_plan (Codex) converts to a plan checklist — it must NOT be
    // pulled out of grouping as a mode tool.
    expect(isPlanLikeToolName("update_plan")).toBe(true)
    expect(isPlanModeToolName("update_plan")).toBe(false)
  })

  it("returns false for unrelated and plan-named-but-not-mode tools", () => {
    expect(isPlanModeToolName("TodoWrite")).toBe(false)
    // `plan_review` moved to the positive set (codex-acp ≥1.1.8's review gate),
    // so keep a different plan-named work tool as the negative example.
    expect(isPlanModeToolName("plan_summary")).toBe(false)
    expect(isPlanModeToolName("Bash")).toBe(false)
  })
})

describe("extractPlanMarkdown", () => {
  it("reads the direct plan / Plan field", () => {
    expect(extractPlanMarkdown({ plan: "# Title\n- a" })).toBe("# Title\n- a")
    expect(extractPlanMarkdown({ Plan: "do x" })).toBe("do x")
  })

  it("reads one level into a rawInput / raw_input envelope", () => {
    expect(extractPlanMarkdown({ rawInput: { plan: "nested" } })).toBe("nested")
    expect(extractPlanMarkdown({ raw_input: { Plan: "nested2" } })).toBe(
      "nested2"
    )
  })

  it("returns null when there is no non-empty plan string", () => {
    expect(extractPlanMarkdown({})).toBeNull()
    expect(extractPlanMarkdown({ plan: "   " })).toBeNull()
    expect(extractPlanMarkdown({ plan: 42 })).toBeNull()
    expect(extractPlanMarkdown({ rawInput: { other: "x" } })).toBeNull()
  })
})

describe("kimiTodoWriteEntries", () => {
  it("parses a genuine Kimi todo write into one entry per todo", () => {
    const input = JSON.stringify({
      todos: [
        { title: "Confirm 401 behavior", status: "in_progress" },
        { title: "Unify request.js", status: "pending" },
        { title: "Verify changes", status: "done" },
      ],
    })
    expect(kimiTodoWriteEntries(input)).toEqual([
      {
        content: "Confirm 401 behavior",
        status: "in_progress",
        priority: "medium",
      },
      { content: "Unify request.js", status: "pending", priority: "medium" },
      { content: "Verify changes", status: "completed", priority: "medium" },
    ])
  })

  it("returns null for read/clear forms (no plan card)", () => {
    expect(kimiTodoWriteEntries("{}")).toBeNull()
    expect(kimiTodoWriteEntries(JSON.stringify({ todos: [] }))).toBeNull()
  })

  it("rejects non-Kimi shapes (entries/plan arrays, non-title items)", () => {
    expect(
      kimiTodoWriteEntries(JSON.stringify({ entries: [{ content: "A" }] }))
    ).toBeNull()
    expect(
      kimiTodoWriteEntries(JSON.stringify({ plan: [{ step: "B" }] }))
    ).toBeNull()
    expect(
      kimiTodoWriteEntries(
        JSON.stringify({ todos: [{ name: "X", status: "pending" }] })
      )
    ).toBeNull()
    expect(
      kimiTodoWriteEntries(JSON.stringify({ todos: [{ title: "X" }] }))
    ).toBeNull()
  })

  it("rejects unknown statuses and whitespace-only titles", () => {
    expect(
      kimiTodoWriteEntries(
        JSON.stringify({ todos: [{ title: "X", status: "weird" }] })
      )
    ).toBeNull()
    expect(
      kimiTodoWriteEntries(
        JSON.stringify({ todos: [{ title: "   ", status: "pending" }] })
      )
    ).toBeNull()
  })

  it("returns null for non-JSON, primitive, and empty input", () => {
    expect(kimiTodoWriteEntries("not json")).toBeNull()
    expect(kimiTodoWriteEntries("5")).toBeNull()
    expect(kimiTodoWriteEntries('"a string"')).toBeNull()
    expect(kimiTodoWriteEntries("")).toBeNull()
    expect(kimiTodoWriteEntries(null)).toBeNull()
    expect(kimiTodoWriteEntries(undefined)).toBeNull()
  })

  it("accepts status case-insensitively (matching the live wire defensively)", () => {
    expect(
      kimiTodoWriteEntries(
        JSON.stringify({ todos: [{ title: "X", status: "IN_PROGRESS" }] })
      )
    ).toEqual([{ content: "X", status: "in_progress", priority: "medium" }])
  })
})

describe("parseTodosFromJson", () => {
  it("parses the `todos` array shape", () => {
    const input = JSON.stringify({
      todos: [
        { content: "Build the thing", status: "in_progress", priority: "high" },
        { content: "Ship it", status: "pending", priority: "low" },
      ],
    })
    expect(parseTodosFromJson(input)).toEqual([
      { content: "Build the thing", status: "in_progress", priority: "high" },
      { content: "Ship it", status: "pending", priority: "low" },
    ])
  })

  it("supports `entries` and `plan` array shapes", () => {
    expect(
      parseTodosFromJson(JSON.stringify({ entries: [{ content: "A" }] }))
    ).toEqual([{ content: "A", status: "pending", priority: "medium" }])
    expect(
      parseTodosFromJson(
        JSON.stringify({ plan: [{ step: "B", status: "done" }] })
      )
    ).toEqual([{ content: "B", status: "completed", priority: "medium" }])
  })

  it("derives content from step/title/name fallbacks and skips empty rows", () => {
    const input = JSON.stringify({
      todos: [{ title: "Titled" }, { name: "Named" }, { status: "pending" }],
    })
    expect(parseTodosFromJson(input)).toEqual([
      { content: "Titled", status: "pending", priority: "medium" },
      { content: "Named", status: "pending", priority: "medium" },
    ])
  })

  it("returns [] for invalid JSON or non-plan payloads", () => {
    expect(parseTodosFromJson("not json")).toEqual([])
    expect(parseTodosFromJson(JSON.stringify({ other: 1 }))).toEqual([])
    expect(parseTodosFromJson("")).toEqual([])
  })
})
