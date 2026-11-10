import { describe, expect, it } from "vitest"

import type { AdaptedToolCallPart } from "@/lib/adapters/ai-elements-adapter"
import { describeToolCall } from "./describe-tool-call"
import { summarizeActivity } from "./summarize"
import type { ActivityStep } from "./types"

let seq = 0
function tool(
  toolName: string,
  input: unknown,
  overrides: Partial<AdaptedToolCallPart> = {}
): ActivityStep {
  seq += 1
  const part: AdaptedToolCallPart = {
    type: "tool-call",
    toolCallId: `s-${seq}`,
    toolName,
    input: JSON.stringify(input),
    state: "output-available",
    output: "ok",
    ...overrides,
  }
  return {
    type: "tool",
    key: `tool:${part.toolCallId}`,
    part,
    tool: describeToolCall(part),
  }
}

const failed = { state: "output-error" as const, errorText: "Exit code 1" }

describe("summarizeActivity", () => {
  it("counts distinct files for reads and edits, calls for the rest", () => {
    const summary = summarizeActivity([
      tool("Read", { file_path: "/r/a.ts" }),
      tool("Read", { file_path: "/r/a.ts" }),
      tool("Read", { file_path: "/r/b.ts" }),
      tool("Edit", { file_path: "/r/a.ts", old_string: "a", new_string: "b" }),
      tool("Edit", { file_path: "/r/a.ts", old_string: "b", new_string: "c" }),
      tool("Grep", { pattern: "x" }),
      tool("Grep", { pattern: "y" }),
      tool("WebSearch", { query: "q" }),
      tool("mcp__linear__get_issue", { id: "1" }),
      tool("Bash", { command: "ls" }),
    ])
    expect(summary.steps).toBe(10)
    expect(summary.counts).toEqual({
      commands: 1,
      editedFiles: 1,
      agents: 0,
      mcp: 1,
      web: 1,
      readFiles: 2,
      searches: 2,
    })
  })

  it("counts a monitor and a network request as steps, not commands", () => {
    const summary = summarizeActivity([
      tool("Monitor", { command: "tail -f log", description: "log errors" }),
      tool("SandboxNetworkAccess", { host: "example.com" }),
      tool("Bash", { command: "curl example.com" }),
    ])
    expect(summary.steps).toBe(3)
    expect(summary.counts.commands).toBe(1)
    expect(summary.counts.web).toBe(0)
  })

  it("calls a monitor or a network request recovered when the same one later succeeds", () => {
    const monitor = { command: "tail -f log", description: "log errors" }
    const failedMonitor = tool("Monitor", monitor, failed)
    const declined = tool("SandboxNetworkAccess", { host: "a.dev" }, failed)
    const summary = summarizeActivity([
      failedMonitor,
      declined,
      tool("Monitor", monitor),
      tool("SandboxNetworkAccess", { host: "a.dev" }),
    ])
    expect(summary.failed).toBe(2)
    expect(summary.unrecovered).toBe(0)
  })

  it("does not call a monitor or a network request recovered by another one", () => {
    const failedMonitor = tool(
      "Monitor",
      { command: "tail -f a.log", description: "a errors" },
      failed
    )
    const summary = summarizeActivity([
      failedMonitor,
      tool("SandboxNetworkAccess", { host: "a.dev" }, failed),
      tool("Monitor", { command: "tail -f b.log", description: "b errors" }),
      tool("SandboxNetworkAccess", { host: "b.dev" }),
    ])
    expect(summary.failed).toBe(2)
    expect(summary.unrecovered).toBe(2)
    expect(summary.firstUnrecoveredKey).toBe(failedMonitor.key)
  })

  it("does not take a command of the same text for a monitor started again", () => {
    const failedMonitor = tool(
      "Monitor",
      { command: "tail -f log", description: "log errors" },
      failed
    )
    const summary = summarizeActivity([
      failedMonitor,
      tool("Bash", { command: "tail -f log" }),
      tool("SandboxNetworkAccess", { host: "b.dev" }),
    ])
    expect(summary.unrecovered).toBe(1)
    expect(summary.firstUnrecoveredKey).toBe(failedMonitor.key)
  })

  it("calls a failure recovered when the same command later succeeds", () => {
    const first = tool("Bash", { command: "pnpm   test" }, failed)
    const summary = summarizeActivity([
      first,
      tool("Edit", { file_path: "/r/a.ts", old_string: "a", new_string: "b" }),
      tool("Bash", { command: "pnpm test" }),
    ])
    expect(summary.failed).toBe(1)
    expect(summary.unrecovered).toBe(0)
    expect(summary.recoveredKeys.has(first.key)).toBe(true)
  })

  it("does not count a success before the failure, or a different command", () => {
    const failing = tool("Bash", { command: "pnpm test" }, failed)
    const summary = summarizeActivity([
      tool("Bash", { command: "pnpm test" }),
      failing,
      tool("Bash", { command: "pnpm lint" }),
    ])
    expect(summary.unrecovered).toBe(1)
    expect(summary.firstUnrecoveredKey).toBe(failing.key)
  })

  it("matches MCP retries on tool and arguments", () => {
    const summary = summarizeActivity([
      tool("mcp__gh__get", { id: 1 }, failed),
      tool("mcp__gh__get", { id: 2 }),
    ])
    expect(summary.unrecovered).toBe(1)
  })

  it("counts interruptions apart from failures", () => {
    const summary = summarizeActivity([
      tool(
        "Bash",
        { command: "pnpm dev" },
        {
          state: "output-error",
          errorText: "[Request interrupted by user for tool use]",
        }
      ),
    ])
    expect(summary.interrupted).toBe(1)
    expect(summary.failed).toBe(0)
  })

  it("does not count bookkeeping calls as steps", () => {
    const summary = summarizeActivity([
      tool("TodoWrite", { todos: [] }),
      tool("wait", { cell_id: "1" }),
      tool("mcp__codeg-mcp__get_delegation_status", { task_ids: ["t"] }),
    ])
    expect(summary.steps).toBe(0)
  })

  it("is running while any step is live", () => {
    expect(
      summarizeActivity([
        tool("Bash", { command: "ls" }, { state: "input-available" }),
      ]).running
    ).toBe(true)
  })

  it("counts a delegation whose task failed once, on the delegation", () => {
    // Its checks are rows of their own and may all say so; the newest is
    // what the delegation reads, and the failure is the delegation's.
    const TASK = "a1b2c3d4"
    const check = (id: string, status: string): AdaptedToolCallPart => ({
      type: "tool-call",
      toolCallId: id,
      toolName: "mcp__codeg-mcp__get_delegation_status",
      input: JSON.stringify({ task_ids: [TASK] }),
      state: "output-available",
      output: JSON.stringify({ task_id: TASK, status }),
    })
    const polls = [check("c1", "running"), check("c2", "failed")]
    const delegation = tool(
      "mcp__codeg-mcp__delegate_to_agent",
      { agent_type: "codex", task: "Run the checks." },
      { output: JSON.stringify({ task_id: TASK, status: "started" }) }
    )
    const summary = summarizeActivity([
      { ...delegation, laterPolls: polls } as ActivityStep,
      ...polls.map(
        (poll): ActivityStep => ({
          type: "delegation-polls",
          key: `dpoll:${poll.toolCallId}`,
          polls: [poll],
          status: "succeeded",
        })
      ),
      tool("mcp__codeg-mcp__get_delegation_status", { task_ids: [TASK] }),
    ])
    expect(summary.failed).toBe(1)
    expect(summary.firstUnrecoveredKey).toBe(delegation.key)
    expect(summary.counts.agents).toBe(1)
  })

  it("counts each background task once and its failure", () => {
    const poll = (id: string, status: string, exit: number) => {
      const part: AdaptedToolCallPart = {
        type: "tool-call",
        toolCallId: id,
        toolName: "TaskOutput",
        input: JSON.stringify({ task_id: "bg1", block: true }),
        state: "output-available",
        output: `<retrieval_status>success</retrieval_status>\n<task_id>bg1</task_id>\n<status>${status}</status>\n<exit_code>${exit}</exit_code>\n<output>x</output>`,
      }
      return part
    }
    const summary = summarizeActivity([
      {
        type: "background-tasks",
        key: "bg:p1",
        polls: [poll("p1", "running", 0), poll("p2", "completed", 2)],
        status: "failed",
        launches: {},
      },
    ])
    expect(summary.steps).toBe(1)
    expect(summary.failed).toBe(1)
  })
})
