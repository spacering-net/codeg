import { describe, expect, it } from "vitest"

import {
  groupConsecutiveBackgroundTasks,
  mergeAdjacentBackgroundTaskGroups,
  type AdaptedContentPart,
  type AdaptedToolCallPart,
} from "@/lib/adapters/ai-elements-adapter"

const POLL_OUTPUT = `<retrieval_status>success</retrieval_status>
<task_id>bfb5xnq1t</task_id>
<task_type>local_bash</task_type>
<status>completed</status>
<exit_code>0</exit_code>
<output>done</output>`

function taskPoll(id: string): AdaptedToolCallPart {
  return {
    type: "tool-call",
    toolCallId: id,
    toolName: "TaskOutput",
    input: JSON.stringify({ task_id: "bfb5xnq1t", block: true, timeout: 1000 }),
    output: POLL_OUTPUT,
    state: "output-available",
  }
}

function bash(id: string): AdaptedToolCallPart {
  return {
    type: "tool-call",
    toolCallId: id,
    toolName: "bash",
    input: JSON.stringify({ command: "ls" }),
    output: "file.txt",
    state: "output-available",
  }
}

const text = (s: string): AdaptedContentPart => ({ type: "text", text: s })

describe("groupConsecutiveBackgroundTasks", () => {
  it("collapses a consecutive run of polls into one group", () => {
    const parts = groupConsecutiveBackgroundTasks([
      text("before"),
      taskPoll("p1"),
      taskPoll("p2"),
      text("after"),
    ])
    expect(parts.map((p) => p.type)).toEqual([
      "text",
      "background-task-group",
      "text",
    ])
    const group = parts[1]
    expect(group.type === "background-task-group" && group.polls).toHaveLength(
      2
    )
  })

  it("does NOT merge polls separated by other content", () => {
    const parts = groupConsecutiveBackgroundTasks([
      taskPoll("p1"),
      text("interruption"),
      taskPoll("p2"),
    ])
    expect(parts.map((p) => p.type)).toEqual([
      "background-task-group",
      "text",
      "background-task-group",
    ])
  })
})

describe("groupConsecutiveBackgroundTasks + other tool calls", () => {
  it("leaves a command next to the polls as its own call", () => {
    const parts = groupConsecutiveBackgroundTasks([bash("b1"), taskPoll("p1")])
    expect(parts.map((p) => p.type)).toEqual([
      "tool-call",
      "background-task-group",
    ])
    expect(parts[0].type === "tool-call" && parts[0].toolName).toBe("bash")
  })
})

describe("mergeAdjacentBackgroundTaskGroups", () => {
  it("merges adjacent groups (cross-turn poll rounds)", () => {
    const parts = mergeAdjacentBackgroundTaskGroups([
      { type: "background-task-group", polls: [taskPoll("p1")] },
      { type: "background-task-group", polls: [taskPoll("p2")] },
    ])
    expect(parts).toHaveLength(1)
    expect(
      parts[0].type === "background-task-group" && parts[0].polls
    ).toHaveLength(2)
  })

  it("does not merge groups separated by other parts", () => {
    const parts = mergeAdjacentBackgroundTaskGroups([
      { type: "background-task-group", polls: [taskPoll("p1")] },
      text("x"),
      { type: "background-task-group", polls: [taskPoll("p2")] },
    ])
    expect(parts).toHaveLength(3)
  })
})
