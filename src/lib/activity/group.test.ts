import { describe, expect, it } from "vitest"

import type { AdaptedToolCallPart } from "@/lib/adapters/ai-elements-adapter"
import { describeToolCall } from "./describe-tool-call"
import { groupActivitySteps } from "./group"
import type { ActivityItem, ActivityStep } from "./types"

function tool(
  id: string,
  toolName: string,
  input: unknown,
  overrides: Partial<AdaptedToolCallPart> = {}
): ActivityStep {
  const part: AdaptedToolCallPart = {
    type: "tool-call",
    toolCallId: id,
    toolName,
    input: JSON.stringify(input),
    state: "output-available",
    output: "ok",
    ...overrides,
  }
  return { type: "tool", key: `tool:${id}`, part, tool: describeToolCall(part) }
}

const read = (id: string) => tool(id, "Read", { file_path: `/r/${id}.ts` })
const grep = (id: string) => tool(id, "Grep", { pattern: id })
const bash = (id: string, overrides?: Partial<AdaptedToolCallPart>) =>
  tool(id, "Bash", { command: `echo ${id}` }, overrides)

function thought(id: string, streaming = false): ActivityStep {
  return {
    type: "thought",
    key: `thought:${id}`,
    part: { type: "reasoning", content: id, isStreaming: streaming },
    title: id,
    streaming,
  }
}

function note(id: string): ActivityStep {
  return { type: "note", key: `note:${id}`, part: { type: "text", text: id } }
}

/** Compact picture of the rows: `explore[a,b]`, `step:x`. */
function shape(items: ActivityItem[]): string[] {
  return items.map((item) =>
    item.type === "group"
      ? `${item.kind}[${item.steps.map((s) => s.key.split(":")[1]).join(",")}]`
      : `step:${item.key.split(":")[1]}`
  )
}

describe("groupActivitySteps", () => {
  it("folds a run of exploration into one row", () => {
    const items = groupActivitySteps([read("a"), read("b"), grep("c")])
    expect(shape(items)).toEqual(["explore[a,b,c]"])
    expect(items[0]).toMatchObject({ key: "tool:a", status: "succeeded" })
  })

  it("leaves a lone call as a plain row", () => {
    expect(shape(groupActivitySteps([read("a"), bash("b")]))).toEqual([
      "step:a",
      "step:b",
    ])
  })

  it("lets a thought between two exploration calls stand on its own", () => {
    expect(
      shape(
        groupActivitySteps([
          thought("t0"),
          read("a"),
          read("b"),
          thought("t1"),
          read("c"),
          grep("d"),
          thought("t2", true),
          read("e"),
        ])
      )
    ).toEqual([
      "step:t0",
      "explore[a,b]",
      "step:t1",
      "explore[c,d]",
      "step:t2",
      "step:e",
    ])
  })

  it("keeps a thought that no call followed after its run", () => {
    expect(
      shape(
        groupActivitySteps([read("a"), read("b"), thought("t1"), bash("c")])
      )
    ).toEqual(["explore[a,b]", "step:t1", "step:c"])
  })

  it("folds commands, and lets a thought split them", () => {
    expect(
      shape(groupActivitySteps([bash("a"), bash("b"), thought("t"), bash("c")]))
    ).toEqual(["command[a,b]", "step:t", "step:c"])
  })

  it("ends a run at prose, edits and other tools", () => {
    const edit = tool("e", "Edit", {
      file_path: "/r/x.ts",
      old_string: "a",
      new_string: "b",
    })
    const mcp = tool("m", "mcp__linear__get_issue", { id: "1" })
    expect(
      shape(
        groupActivitySteps([
          read("a"),
          note("n"),
          read("b"),
          edit,
          read("c"),
          mcp,
          read("d"),
        ])
      )
    ).toEqual([
      "step:a",
      "step:n",
      "step:b",
      "step:e",
      "step:c",
      "step:m",
      "step:d",
    ])
  })

  it("keeps a failure inside its group and marks the group failed", () => {
    const items = groupActivitySteps([
      bash("a"),
      bash("b", { state: "output-error", errorText: "Exit code 1" }),
    ])
    expect(shape(items)).toEqual(["command[a,b]"])
    expect(items[0]).toMatchObject({ status: "failed" })
  })

  it("marks a group with a live member running", () => {
    const items = groupActivitySteps([
      bash("a"),
      bash("b", { state: "input-available", output: null }),
    ])
    expect(items[0]).toMatchObject({ status: "running" })
  })
})
