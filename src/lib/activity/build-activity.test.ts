import { describe, expect, it } from "vitest"

import {
  adaptMessageTurn,
  type AdaptedContentPart,
} from "@/lib/adapters/ai-elements-adapter"
import type { MessageTurn } from "@/lib/types"
import {
  MOCKUP_ADAPTER_TEXT,
  MOCKUP_ASSISTANT_TURN,
  MOCKUP_LIVE_TURN,
  toolResult,
  toolUse,
} from "./__fixtures__/mockup-turn"
import { buildActivity, rowIdentity } from "./build-activity"
import type { ActivityItem } from "./types"

function rows(items: ActivityItem[]): string[] {
  return items.map((item) => {
    if (item.type === "group") {
      return `${item.kind}(${item.steps
        .map((s) => (s.type === "tool" ? s.part.toolCallId : s.key))
        .join(",")})`
    }
    const step = item.step
    switch (step.type) {
      case "tool":
        return `${step.tool.kind}:${step.part.toolCallId}`
      case "thought":
        return `thought:${step.title}`
      default:
        return step.type
    }
  })
}

describe("buildActivity on the reference turn", () => {
  const parts = adaptMessageTurn(
    MOCKUP_ASSISTANT_TURN,
    MOCKUP_ADAPTER_TEXT
  ).content
  const model = buildActivity(parts, { isStreaming: false })

  it("draws one row per step, with exploration and commands folded", () => {
    expect(rows(model.items)).toEqual([
      "thought:Summarizing log status",
      "explore(t1,t2,t3,t4)",
      "command(t5,t6)",
      "mcp:t7",
      "thought:Planning the fix",
      "edit:t8",
      "command:t9",
      "note",
      "delegation:t10",
      "delegation-polls",
      "command(t12,t13)",
      "background-tasks",
      "command:t15",
    ])
  })

  it("hands a delegation its status poll, drawn as a row of its own", () => {
    const delegation = model.steps.find(
      (s) => s.type === "tool" && s.part.toolCallId === "t10"
    )
    expect(
      delegation?.type === "tool"
        ? delegation.laterPolls?.map((p) => p.toolCallId)
        : null
    ).toEqual(["t11"])
  })

  it("hands a delegation every check on its task, before or after other work", () => {
    // Each check is a row of its own, the one right after the hand-over too;
    // the delegation reads the newest.
    const TASK = "a1b2c3d4"
    const status = (id: string) =>
      toolUse(id, "mcp__codeg-mcp__get_delegation_status", {
        task_ids: [TASK],
        wait_ms: 3000,
      })
    const turn: MessageTurn = {
      id: "turn-later-check",
      role: "assistant",
      timestamp: "2026-10-22T09:00:00Z",
      blocks: [
        toolUse("d1", "mcp__codeg-mcp__delegate_to_agent", {
          agent_type: "claude_code",
          task: "Run the four checks.",
        }),
        toolResult("d1", JSON.stringify({ task_id: TASK, status: "started" })),
        status("d2"),
        toolResult("d2", JSON.stringify({ task_id: TASK, status: "running" })),
        { type: "text", text: "Still waiting on the sub-agent." },
        status("d3"),
        toolResult(
          "d3",
          JSON.stringify({ task_id: TASK, status: "completed", text: "Done." })
        ),
        { type: "text", text: "All done." },
      ],
    }
    const later = buildActivity(
      adaptMessageTurn(turn, MOCKUP_ADAPTER_TEXT).content,
      { isStreaming: false }
    )
    expect(rows(later.items)).toEqual([
      "delegation:d1",
      "delegation-polls",
      "note",
      "delegation-polls",
    ])
    const step = later.steps[0]
    expect(
      step?.type === "tool" ? step.laterPolls?.map((p) => p.toolCallId) : null
    ).toEqual(["d2", "d3"])
  })

  it("keeps the closing prose as the answer", () => {
    expect(model.answer).toHaveLength(1)
    expect(model.answer[0]).toMatchObject({ type: "text" })
  })

  it("summarizes the turn", () => {
    expect(model.summary).toMatchObject({
      steps: 14,
      counts: {
        commands: 6,
        editedFiles: 1,
        agents: 1,
        mcp: 1,
        web: 0,
        readFiles: 3,
        searches: 1,
      },
      failed: 1,
      unrecovered: 0,
      interrupted: 0,
      running: false,
      firstUnrecoveredKey: null,
    })
    expect([...model.summary.recoveredKeys]).toEqual(["tool:t9"])
  })

  it("describes the rows the way the mockup shows them", () => {
    const steps = new Map(
      model.steps.flatMap((s) =>
        s.type === "tool" ? [[s.part.toolCallId, s.tool] as const] : []
      )
    )
    expect(steps.get("t1")?.metric).toEqual({ kind: "lines", count: 84 })
    expect(steps.get("t4")?.metric).toEqual({
      kind: "matches",
      count: 4,
      files: 3,
    })
    expect(steps.get("t6")?.command?.heredoc?.bodyLines).toBe(5)
    expect(steps.get("t7")?.detail).toBe(
      "HVAC-212 · Inactive bindings leak into report"
    )
    expect(steps.get("t8")?.files?.[0]).toMatchObject({
      additions: 3,
      deletions: 1,
      lineRange: { start: 44, end: 46 },
    })
    expect(steps.get("t9")?.exit).toEqual({ code: 1, signal: null })
    expect(steps.get("t13")?.background).toEqual({ taskId: "beecec7d" })
  })

  it("is cached per parts array and streaming state", () => {
    expect(buildActivity(parts, { isStreaming: false })).toBe(model)
    expect(buildActivity(parts, { isStreaming: true })).not.toBe(model)
  })
})

describe("buildActivity on a live turn", () => {
  it("reports the running command and keeps every call visible", () => {
    const parts = adaptMessageTurn(
      MOCKUP_LIVE_TURN,
      MOCKUP_ADAPTER_TEXT,
      true,
      new Set(["l3"])
    ).content
    const model = buildActivity(parts, { isStreaming: true })
    expect(rows(model.items)).toEqual([
      "thought:Checking the failing test",
      "explore(l1,l2)",
      "command:l3",
    ])
    expect(model.summary.running).toBe(true)
    const last = model.items[2]
    expect(
      last?.type === "step" && last.step.type === "tool"
        ? last.step.tool.status
        : null
    ).toBe("running")
  })

  it("titles a streaming thought by its newest heading", () => {
    const parts: AdaptedContentPart[] = [
      {
        type: "reasoning",
        content: "**First**\n\nbody\n\n**Second**\n\nmore",
        isStreaming: true,
      },
    ]
    const model = buildActivity(parts, { isStreaming: true })
    expect(rows(model.items)).toEqual(["thought:Second"])
    expect(model.summary.running).toBe(true)
  })
})

describe("buildActivity on a reply rebuilt from fresh parts", () => {
  // A reply that streams is adapted afresh on every token: new part objects
  // that read the same as the ones before.
  const fresh = () =>
    adaptMessageTurn(MOCKUP_ASSISTANT_TURN, MOCKUP_ADAPTER_TEXT).content

  it("keeps every step and row whose content did not change", () => {
    const before = buildActivity(fresh(), { isStreaming: true })
    const after = buildActivity(fresh(), { isStreaming: true })
    expect(after).not.toBe(before)
    expect(after.steps).toHaveLength(before.steps.length)
    after.steps.forEach((step, i) => expect(step).toBe(before.steps[i]))
    expect(after.items).toHaveLength(before.items.length)
    after.items.forEach((item, i) => expect(item).toBe(before.items[i]))
    // The rows read it through context.
    expect(after.summary.recoveredKeys).toBe(before.summary.recoveredKeys)
  })

  it("builds again only the step that changed, and only its row", () => {
    const before = buildActivity(fresh(), { isStreaming: true })
    const after = buildActivity(
      fresh().map((part) =>
        part.type === "tool-call" && part.toolCallId === "t9"
          ? { ...part, output: `${part.output ?? ""}\none more line` }
          : part
      ),
      { isStreaming: true }
    )
    expect(
      after.steps
        .filter((step, i) => step !== before.steps[i])
        .map((s) => s.key)
    ).toEqual(["tool:t9"])
    expect(
      after.items
        .filter((item, i) => item !== before.items[i])
        .map((i) => i.key)
    ).toEqual(["tool:t9"])
  })

  it("redraws a group a call joins, and keeps the rows before it", () => {
    const live = (extra: MessageTurn["blocks"]) =>
      adaptMessageTurn(
        { ...MOCKUP_LIVE_TURN, blocks: [...MOCKUP_LIVE_TURN.blocks, ...extra] },
        MOCKUP_ADAPTER_TEXT,
        true
      ).content
    const before = buildActivity(live([]), { isStreaming: true })
    const after = buildActivity(
      live([toolUse("l4", "Bash", { command: "pnpm --filter web build" })]),
      { isStreaming: true }
    )
    expect(rows(after.items)).toEqual([
      "thought:Checking the failing test",
      "explore(l1,l2)",
      "command(l3,l4)",
    ])
    expect(after.items[0]).toBe(before.items[0])
    expect(after.items[1]).toBe(before.items[1])
    const l3 = (model: typeof after) =>
      model.steps.find((s) => s.type === "tool" && s.part.toolCallId === "l3")
    expect(l3(after)).toBe(l3(before))
  })

  it("hands a kept delegation the check that came after it", () => {
    const TASK = "a1b2c3d4"
    const blocks: MessageTurn["blocks"] = [
      toolUse("d1", "mcp__codeg-mcp__delegate_to_agent", {
        agent_type: "codex",
        task: "Update the snapshot.",
      }),
      toolResult("d1", JSON.stringify({ task_id: TASK, status: "started" })),
      toolUse("d2", "mcp__codeg-mcp__get_delegation_status", {
        task_ids: [TASK],
      }),
      toolResult("d2", JSON.stringify({ task_id: TASK, status: "running" })),
    ]
    const turn = (more: MessageTurn["blocks"]): MessageTurn => ({
      id: "turn-kept-delegation",
      role: "assistant",
      timestamp: "2026-10-22T09:00:00Z",
      blocks: [...blocks, ...more],
    })
    const build = (more: MessageTurn["blocks"]) =>
      buildActivity(adaptMessageTurn(turn(more), MOCKUP_ADAPTER_TEXT).content, {
        isStreaming: true,
      })
    const laterPolls = (model: ReturnType<typeof build>) => {
      const step = model.steps[0]
      return step?.type === "tool"
        ? step.laterPolls?.map((p) => p.toolCallId)
        : null
    }
    const before = build([])
    expect(laterPolls(before)).toEqual(["d2"])
    expect(build([]).steps[0]).toBe(before.steps[0])
    const after = build([
      { type: "text", text: "Still waiting on it." },
      toolUse("d3", "mcp__codeg-mcp__get_delegation_status", {
        task_ids: [TASK],
      }),
      toolResult(
        "d3",
        JSON.stringify({ task_id: TASK, status: "completed", text: "Done." })
      ),
    ])
    expect(laterPolls(after)).toEqual(["d2", "d3"])
    expect(after.steps[0]).not.toBe(before.steps[0])
    // The first check reads the same: its row stays as it was.
    expect(after.steps[1]).toBe(before.steps[1])
  })
})

describe("buildActivity edge cases", () => {
  it("keeps a goal run's prose inside the run, where it is drawn", () => {
    const start: AdaptedContentPart = {
      type: "tool-call",
      toolCallId: "g1",
      toolName: "create_goal",
      input: '{"objective":"Ship it"}',
      state: "output-available",
      output: "ok",
    }
    const parts: AdaptedContentPart[] = [
      {
        type: "goal-run",
        start: start as Extract<AdaptedContentPart, { type: "tool-call" }>,
        end: null,
        isRunning: true,
        items: [
          {
            type: "tool-call",
            toolCallId: "r1",
            toolName: "Read",
            input: '{"file_path":"/r/a.ts"}',
            state: "output-available",
            output: "x",
          },
          { type: "text", text: "Halfway there." },
        ],
      },
    ]
    const model = buildActivity(parts, { isStreaming: true })
    const goal = model.steps.find((s) => s.type === "goal")
    if (goal?.type !== "goal") throw new Error("expected a goal step")
    expect(goal.model.answer).toEqual([])
    expect(rows(goal.model.items)).toEqual(["read:r1", "note"])
  })

  it("returns an empty timeline for a text-only reply", () => {
    const parts: AdaptedContentPart[] = [{ type: "text", text: "Hi" }]
    const model = buildActivity(parts, { isStreaming: false })
    expect(model.items).toEqual([])
    expect(model.answer).toEqual(parts)
    expect(model.summary.steps).toBe(0)
  })

  it("keeps prose written between steps as a note", () => {
    const parts: AdaptedContentPart[] = [
      { type: "text", text: "Looking around." },
      {
        type: "tool-call",
        toolCallId: "a",
        toolName: "Read",
        input: '{"file_path":"/r/a.ts"}',
        state: "output-available",
        output: "x",
      },
      { type: "text", text: "Done." },
    ]
    const model = buildActivity(parts, { isStreaming: false })
    expect(rows(model.items)).toEqual(["note", "read:a"])
    expect(model.answer).toEqual([parts[2]])
  })

  it("leaves out an interrupted call that carried nothing, but counts it", () => {
    const parts: AdaptedContentPart[] = [
      {
        type: "tool-call",
        toolCallId: "a",
        toolName: "Bash",
        input: "{}",
        state: "output-error",
        errorText: "[Request interrupted by user for tool use]",
      },
      {
        type: "tool-call",
        toolCallId: "b",
        toolName: "Bash",
        input: '{"command":"pnpm dev"}',
        state: "output-error",
        errorText: "[Request interrupted by user for tool use]",
      },
    ]
    const model = buildActivity(parts, { isStreaming: false })
    expect(rows(model.items)).toEqual(["command:b"])
    expect(model.summary.interrupted).toBe(2)
    expect(model.summary.failed).toBe(0)
  })
})

describe("rowIdentity", () => {
  it("drops the reply's anchor from the steps keyed by place", () => {
    expect(rowIdentity("thought:h1abc:0")).toBe("thought@0")
    expect(rowIdentity("note:toolu_01:12")).toBe("note@12")
    expect(rowIdentity("plan:h9:3")).toBe("plan@3")
    expect(rowIdentity("image:h9:4")).toBe("image@4")
  })

  it("keeps a key the anchor plays no part in", () => {
    expect(rowIdentity("tool:toolu_01")).toBe("tool:toolu_01")
    expect(rowIdentity("result:call-1:3")).toBe("result:call-1:3")
    expect(rowIdentity("dpoll:call-2")).toBe("dpoll:call-2")
  })

  it("is the same while a short opening thought grows past the anchor's length", () => {
    // Its anchor is hashed from what it says so far until it says enough.
    const short = buildActivity(
      [{ type: "reasoning", content: "Look", isStreaming: true }],
      { isStreaming: true, keepAnswer: true }
    )
    const longer = buildActivity(
      [
        {
          type: "reasoning",
          content: "Looking at the repository layout before anything else",
          isStreaming: true,
        },
      ],
      { isStreaming: true, keepAnswer: true }
    )
    expect(short.items[0]!.key).not.toBe(longer.items[0]!.key)
    expect(rowIdentity(short.items[0]!.key)).toBe(
      rowIdentity(longer.items[0]!.key)
    )
  })
})
