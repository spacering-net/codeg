import { describe, expect, it } from "vitest"

import {
  buildDelegationStatusIndex,
  collectDelegationStatusTasks,
  createDelegationStatusIndexer,
  type DelegationStatusTaskRef,
} from "./delegation-status-index"
import { buildDelegationTaskRows } from "./delegation-status"
import type {
  AdaptedContentPart,
  AdaptedToolCallPart,
} from "@/lib/adapters/ai-elements-adapter"

function report(taskId: string, status: string) {
  return { task_id: taskId, status, message: `${status} ${taskId}` }
}

/** A `get_delegation_status` call; `reports` absent = still in flight. */
function poll(
  id: string,
  taskIds: string[],
  reports?: Record<string, unknown>[],
  toolName = "mcp__codeg-mcp__get_delegation_status"
): AdaptedToolCallPart {
  return {
    type: "tool-call",
    toolCallId: id,
    toolName,
    input: JSON.stringify({ task_ids: taskIds }),
    state: reports ? "output-available" : "input-available",
    output: reports
      ? JSON.stringify({
          content: [{ type: "text", text: JSON.stringify({ tasks: reports }) }],
          isError: false,
          structuredContent: { tasks: reports },
        })
      : null,
  }
}

function group(...polls: AdaptedToolCallPart[]): AdaptedContentPart {
  return { type: "delegation-status-group", polls }
}

describe("buildDelegationTaskRows — latestPollId", () => {
  it("names each task's row by the last poll that reported on it", () => {
    const rows = buildDelegationTaskRows([
      poll("p1", ["a", "b"], [report("a", "running"), report("b", "running")]),
      poll("p2", ["a"], [report("a", "completed")]),
    ])
    expect(rows.map((r) => [r.taskId, r.latestPollId])).toEqual([
      ["a", "p2"],
      ["b", "p1"],
    ])
  })
})

describe("collectDelegationStatusTasks", () => {
  it("reads the rows of every status card a turn draws, in order", () => {
    const refs = collectDelegationStatusTasks([
      { type: "text", text: "Waiting on both." },
      group(
        poll("p1", ["a", "b"], [report("a", "running"), report("b", "running")])
      ),
      { type: "text", text: "Still waiting." },
      // A status call the grouper left bare: its own one-poll row.
      poll("p2", ["a"]),
      {
        type: "tool-call",
        toolCallId: "r1",
        toolName: "Read",
        input: "{}",
        state: "output-available",
      },
      poll("p3", ["b"], [report("b", "running")], "get_delegation_status"),
      {
        type: "goal-run",
        start: {
          type: "tool-call",
          toolCallId: "g1",
          toolName: "create_goal",
          input: "{}",
          state: "output-available",
        },
        end: null,
        isRunning: true,
        items: [group(poll("p4", ["c"], [report("c", "running")]))],
      },
    ])
    expect(refs).toEqual([
      { taskId: "a", latestPollId: "p1", runningConfirmed: true },
      { taskId: "b", latestPollId: "p1", runningConfirmed: true },
      { taskId: "a", latestPollId: "p2", runningConfirmed: false },
      { taskId: "b", latestPollId: "p3", runningConfirmed: true },
      { taskId: "c", latestPollId: "p4", runningConfirmed: true },
    ])
  })

  it("leaves out rows with no task id and calls that are not status polls", () => {
    const refs = collectDelegationStatusTasks([
      group({
        type: "tool-call",
        toolCallId: "p1",
        toolName: "get_delegation_status",
        input: "{}",
        state: "output-available",
        output: "Some note with no task in it.",
      }),
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "cancel_delegation",
        input: JSON.stringify({ task_id: "a" }),
        state: "output-available",
      },
    ])
    expect(refs).toEqual([])
  })

  it("reads a card's polls once while the card keeps them", () => {
    const polls = [poll("p1", ["a"], [report("a", "running")])]
    const first = collectDelegationStatusTasks([
      { type: "delegation-status-group", polls },
    ])
    const again = collectDelegationStatusTasks([
      { type: "delegation-status-group", polls },
    ])
    expect(again[0]).toBe(first[0])
  })
})

describe("buildDelegationStatusIndex", () => {
  const ref = (
    taskId: string,
    latestPollId: string,
    runningConfirmed = false
  ): DelegationStatusTaskRef => ({ taskId, latestPollId, runningConfirmed })

  it("makes a task's last row its newest", () => {
    const index = buildDelegationStatusIndex([
      [ref("a", "p1", true), ref("b", "p1", true)],
      [ref("a", "p2")],
    ])
    expect(index.get("a")?.latestPollId).toBe("p2")
    expect(index.get("b")?.latestPollId).toBe("p1")
  })

  it("lets a running answer anywhere vouch for the task", () => {
    // The newest row's own poll is still in flight; an earlier card's poll
    // was answered `running`.
    const index = buildDelegationStatusIndex([
      [ref("a", "p1", true)],
      [ref("a", "p2", false)],
    ])
    expect(index.get("a")).toEqual({
      latestPollId: "p2",
      runningConfirmed: true,
    })
    expect(
      buildDelegationStatusIndex([[ref("a", "p1")], [ref("a", "p2")]]).get("a")
        ?.runningConfirmed
    ).toBe(false)
  })

  it("returns the previous index while nothing in it changed", () => {
    const prev = buildDelegationStatusIndex([[ref("a", "p1", true)]])
    expect(buildDelegationStatusIndex([[ref("a", "p1", true)]], prev)).toBe(
      prev
    )
    expect(
      buildDelegationStatusIndex(
        [[ref("a", "p1", true)], [ref("a", "p2")]],
        prev
      )
    ).not.toBe(prev)
    expect(
      buildDelegationStatusIndex(
        [[ref("a", "p1", true)], [ref("b", "p1")]],
        prev
      )
    ).not.toBe(prev)
  })
})

describe("createDelegationStatusIndexer", () => {
  it("keeps its index across rebuilds that leave every task's newest row alone", () => {
    const index = createDelegationStatusIndexer()
    const first = index([
      collectDelegationStatusTasks([
        group(poll("p1", ["a"], [report("a", "running")])),
      ]),
    ])
    // The same transcript, re-adapted: new part objects, same polls.
    const second = index([
      collectDelegationStatusTasks([
        { type: "text", text: "Still waiting." },
        group(poll("p1", ["a"], [report("a", "running")])),
      ]),
    ])
    expect(second).toBe(first)
    const third = index([
      collectDelegationStatusTasks([
        group(poll("p1", ["a"], [report("a", "running")])),
        { type: "text", text: "Still waiting." },
        group(poll("p2", ["a"])),
      ]),
    ])
    expect(third).not.toBe(first)
    expect(third.get("a")).toEqual({
      latestPollId: "p2",
      runningConfirmed: true,
    })
  })
})
