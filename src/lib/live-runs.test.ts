import { describe, expect, it } from "vitest"

import type { AdaptedToolCallPart } from "@/lib/adapters/ai-elements-adapter"
import {
  collectLiveRuns,
  runningSubAgentCalls,
  subAgentCallsById,
  type LiveRunDelegationBinding,
  type LiveRunsInput,
} from "@/lib/live-runs"
import type { AsyncTaskRecord, BackgroundOutstandingTask } from "@/lib/types"

function task(overrides: Partial<AsyncTaskRecord> = {}): AsyncTaskRecord {
  return {
    task_id: "t1",
    name: "pnpm test",
    task_type: "shell",
    description: "",
    show_in_transcript: false,
    can_stop: true,
    state: "running",
    ...overrides,
  }
}

function agentCall(
  id: string,
  overrides: Partial<AdaptedToolCallPart> = {}
): AdaptedToolCallPart {
  return {
    type: "tool-call",
    toolCallId: id,
    toolName: "Agent",
    input: JSON.stringify({
      subagent_type: "Explore",
      description: `Look into ${id}`,
      prompt: "…",
    }),
    state: "input-available",
    ...overrides,
  }
}

function background(
  overrides: Partial<BackgroundOutstandingTask> = {}
): BackgroundOutstandingTask {
  return {
    task_id: "a1",
    kind: "agent",
    tool_use_id: "toolu_1",
    description: "Survey the runners",
    started_at_ms: 1_000,
    ...overrides,
  }
}

function binding(
  child: string,
  status: LiveRunDelegationBinding["status"] = "running",
  parentToolUseId = `call-${child}`
): LiveRunDelegationBinding {
  return {
    parentToolUseId,
    childConnectionId: child,
    agentType: "codex",
    status,
  }
}

function input(
  overrides: Partial<LiveRunsInput> = {}
): LiveRunsInput<LiveRunDelegationBinding> {
  return {
    asyncTasks: [],
    foregroundAgents: [],
    backgroundTasks: [],
    findLaunchCard: () => null,
    delegatedChildren: [],
    delegationBindings: [],
    ...overrides,
  }
}

describe("collectLiveRuns", () => {
  it("is empty, count and all, when nothing runs", () => {
    expect(collectLiveRuns(input())).toEqual({
      tasks: [],
      subagents: [],
      delegations: [],
      count: 0,
    })
  })

  it("lists the background tasks still running or paused, not the settled", () => {
    // A settled task's outcome belongs to the transcript; a list of finished
    // jobs would grow all session.
    const runs = collectLiveRuns(
      input({
        asyncTasks: [
          task({ task_id: "run" }),
          task({ task_id: "paused", state: "paused" }),
          task({ task_id: "done", state: "completed" }),
          task({ task_id: "failed", state: "failed" }),
          task({ task_id: "stopped", state: "stopped" }),
        ],
      })
    )
    expect(runs.tasks.map((t) => t.task_id)).toEqual(["run", "paused"])
    expect(runs.count).toBe(2)
  })

  it("lists the streaming reply's sub-agents and the background ones its producer still counts", () => {
    const card = agentCall("toolu_1", { state: "output-available" })
    const runs = collectLiveRuns(
      input({
        foregroundAgents: [agentCall("toolu_fg")],
        backgroundTasks: [background()],
        findLaunchCard: (id) => (id === "toolu_1" ? card : null),
      })
    )
    expect(runs.subagents).toEqual([
      {
        key: "call:toolu_fg",
        part: expect.objectContaining({ toolCallId: "toolu_fg" }),
        background: false,
        description: null,
        startedAt: null,
      },
      {
        key: "bg:a1",
        part: card,
        background: true,
        description: "Survey the runners",
        startedAt: 1_000,
      },
    ])
    expect(runs.count).toBe(2)
  })

  it("leaves background shells to the task table, which can stop them", () => {
    const runs = collectLiveRuns(
      input({
        backgroundTasks: [
          background({ task_id: "shell", kind: "shell", tool_use_id: null }),
        ],
      })
    )
    expect(runs.subagents).toEqual([])
    expect(runs.count).toBe(0)
  })

  it("keeps a background sub-agent whose launch card is not loaded, titled by its producer", () => {
    const runs = collectLiveRuns(
      input({ backgroundTasks: [background({ tool_use_id: null })] })
    )
    expect(runs.subagents[0]).toMatchObject({
      part: null,
      description: "Survey the runners",
    })
  })

  it("lists a sub-agent once even when both sources name its call", () => {
    const runs = collectLiveRuns(
      input({
        foregroundAgents: [agentCall("toolu_1")],
        backgroundTasks: [background({ tool_use_id: "toolu_1" })],
      })
    )
    expect(runs.subagents.map((s) => s.key)).toEqual(["call:toolu_1"])
  })

  it("takes which delegations run from the parent's children, who they are from the bindings", () => {
    const runs = collectLiveRuns(
      input({
        delegatedChildren: ["child-a", "child-b"],
        delegationBindings: [binding("child-a")],
      })
    )
    expect(runs.delegations).toEqual([
      { childConnectionId: "child-a", binding: binding("child-a") },
      // Its call never got a card: listed bare rather than not at all.
      { childConnectionId: "child-b", binding: null },
    ])
    expect(runs.count).toBe(2)
  })

  it("drops a binding still marked running once the parent no longer lists its child", () => {
    // A missed completion event would otherwise keep it "running" forever.
    const runs = collectLiveRuns(
      input({ delegationBindings: [binding("child-a")] })
    )
    expect(runs.delegations).toEqual([])
  })

  it("leaves out a child whose completion is already in", () => {
    const runs = collectLiveRuns(
      input({
        delegatedChildren: ["child-a"],
        delegationBindings: [binding("child-a", "ok")],
      })
    )
    expect(runs.delegations).toEqual([])
  })

  it("speaks for a resumed child through its running binding", () => {
    const finished = binding("child-a", "ok", "call-first")
    const resumed = binding("child-a", "running", "call-again")
    const runs = collectLiveRuns(
      input({
        delegatedChildren: ["child-a"],
        delegationBindings: [resumed, finished],
      })
    )
    expect(runs.delegations).toEqual([
      { childConnectionId: "child-a", binding: resumed },
    ])
  })

  it("counts every row it lists", () => {
    const runs = collectLiveRuns(
      input({
        asyncTasks: [task()],
        foregroundAgents: [agentCall("toolu_fg")],
        backgroundTasks: [background()],
        delegatedChildren: ["child-a"],
      })
    )
    expect(runs.count).toBe(
      runs.tasks.length + runs.subagents.length + runs.delegations.length
    )
    expect(runs.count).toBe(4)
  })
})

describe("runningSubAgentCalls", () => {
  it("takes the sub-agent calls that have not settled, goal runs included", () => {
    const running = agentCall("a")
    const nested = agentCall("b", { state: "input-streaming" })
    const parts = [
      running,
      agentCall("done", { state: "output-available", output: "report" }),
      {
        type: "tool-call" as const,
        toolCallId: "bash",
        toolName: "Bash",
        input: JSON.stringify({ command: "ls" }),
        state: "input-available" as const,
      },
      {
        type: "goal-run" as const,
        start: agentCall("goal-start", { toolName: "create_goal" }),
        end: null,
        items: [nested],
        isRunning: true,
      },
    ]
    expect(runningSubAgentCalls(parts).map((p) => p.toolCallId)).toEqual([
      "a",
      "b",
    ])
  })

  it("counts a call whose forwarded status is still open", () => {
    // The adapter can flip state to output-available while the ACP status
    // stays in progress (an interrupted call promoted at turn end).
    const part = agentCall("a", {
      state: "output-available",
      toolStatus: "in_progress",
    })
    expect(runningSubAgentCalls([part])).toHaveLength(1)
  })
})

describe("subAgentCallsById", () => {
  it("indexes a reply's sub-agent calls, settled ones too, and keeps the index per parts array", () => {
    const parts = [
      agentCall("a", { state: "output-available" }),
      agentCall("b"),
    ]
    const index = subAgentCallsById(parts)
    expect([...index.keys()]).toEqual(["a", "b"])
    expect(subAgentCallsById(parts)).toBe(index)
  })
})
