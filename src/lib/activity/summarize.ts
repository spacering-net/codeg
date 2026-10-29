/**
 * The counts behind a turn's activity header: how many steps, of which kinds,
 * how many failed, and whether those failures were put right later in the
 * turn.
 *
 * - Reads and edits count distinct files; searches, commands, sub-agents
 *   (delegations included), MCP calls and web lookups count calls.
 * - A grep that matched nothing is not a failure (the adapter already settles
 *   it as a success), and a call the user interrupted counts as interrupted,
 *   not failed.
 * - A failure is "recovered" when a later step of the same kind on the same
 *   target succeeded: the same command line, the same file, the same MCP tool
 *   with the same arguments. t3code judges a run by its last attempt; this is
 *   that rule, narrowed to "the same thing was retried".
 */

import { buildBackgroundTaskRows } from "@/lib/background-task"
import { delegateCallTaskId } from "@/lib/delegation-card"
import { buildDelegationTaskRows } from "@/lib/delegation-status"
import { isFailureStatus, isLiveStatus } from "./status"
import type {
  ActivityCounts,
  ActivityStep,
  ActivitySummary,
  ToolDescriptor,
} from "./types"

/** What "the same thing" means for the recovery rule, or null when a step of
 *  this kind is never considered retried. */
function retrySignature(
  tool: ToolDescriptor,
  input: string | null
): string | null {
  switch (tool.kind) {
    case "command":
    case "script": {
      const command = tool.command?.display.replace(/\s+/g, " ").trim()
      return command ? `command:${command}` : null
    }
    // The same watch started again, or the same host asked for again; never
    // a command of the same text, which is another thing.
    case "monitor": {
      const watched = tool.command?.display.replace(/\s+/g, " ").trim()
      return watched ? `monitor:${watched}` : null
    }
    case "network":
      return tool.target
        ? `network:${tool.target.full ?? tool.target.text}`
        : null
    case "edit": {
      const paths = (tool.files ?? []).map((f) => f.path).sort()
      return paths.length > 0 ? `edit:${paths.join("\n")}` : null
    }
    case "mcp":
      return tool.mcp
        ? `mcp:${tool.mcp.server}/${tool.mcp.tool}:${(input ?? "").replace(/\s+/g, "")}`
        : null
    case "read":
    case "search":
    case "glob":
    case "list":
    case "fetch":
    case "web-search":
      return tool.target
        ? `${tool.kind}:${tool.target.path ?? tool.target.full ?? tool.target.text}`
        : null
    case "generic":
      return `generic:${tool.toolName}:${(input ?? "").replace(/\s+/g, "")}`
    default:
      return null
  }
}

function emptyCounts(): ActivityCounts {
  return {
    commands: 0,
    editedFiles: 0,
    agents: 0,
    mcp: 0,
    web: 0,
    readFiles: 0,
    searches: 0,
  }
}

/** Every step, with goal runs opened up into the steps they contain. */
function flatten(steps: ActivityStep[]): ActivityStep[] {
  const out: ActivityStep[] = []
  for (const step of steps) {
    if (step.type === "goal") out.push(...flatten(step.model.steps))
    else out.push(step)
  }
  return out
}

export function summarizeActivity(steps: ActivityStep[]): ActivitySummary {
  const all = flatten(steps)
  const counts = emptyCounts()
  const readPaths = new Set<string>()
  const editPaths = new Set<string>()
  let stepCount = 0
  let interrupted = 0
  let running = false

  const failures: { key: string; signature: string | null; index: number }[] =
    []
  const successes = new Map<string, number>()

  all.forEach((step, index) => {
    if (step.type === "background-tasks") {
      const rows = buildBackgroundTaskRows(step.polls)
      for (const row of rows) {
        stepCount += 1
        if (row.badge === "running") running = true
        if (row.badge === "failed") {
          failures.push({ key: step.key, signature: null, index })
        }
      }
      return
    }
    if (step.type === "delegation-polls") {
      if (isLiveStatus(step.status)) running = true
      return
    }
    if (step.type === "tool" && step.laterPolls) {
      // A delegation stands where its task's newest check says. The checks
      // are rows of their own, but a task that failed is the delegation's
      // failure — counted once, on its row.
      const taskId = delegateCallTaskId(step.part)
      const task = buildDelegationTaskRows(step.laterPolls).find(
        (row) => row.taskId === taskId
      )
      const badge = task?.badge.status
      if (badge === "running" || badge === "starting") running = true
      if (badge === "err") {
        failures.push({ key: step.key, signature: null, index })
      }
    }
    if (step.type === "thought" && step.streaming) {
      running = true
      return
    }
    if (step.type !== "tool") return

    const { tool, part } = step
    if (isLiveStatus(tool.status)) running = true

    switch (tool.kind) {
      case "compaction":
      case "handoff":
      case "todo":
      case "delegation-status":
      case "shell-session":
        // Continuations and bookkeeping, not steps of their own.
        break
      default:
        stepCount += 1
    }

    switch (tool.kind) {
      case "command":
      case "script":
        counts.commands += 1
        break
      case "edit":
        for (const file of tool.files ?? []) editPaths.add(file.path)
        if ((tool.files ?? []).length === 0) editPaths.add(step.key)
        break
      case "agent":
      case "collab-agent":
      case "delegation":
      case "delegation-resume":
        counts.agents += 1
        break
      case "mcp":
        counts.mcp += 1
        break
      case "fetch":
      case "web-search":
        counts.web += 1
        break
      case "read":
        readPaths.add(tool.target?.path ?? tool.target?.text ?? step.key)
        break
      case "search":
      case "glob":
      case "list":
        counts.searches += 1
        break
    }

    if (tool.status === "cancelled") {
      interrupted += 1
      return
    }
    const signature = retrySignature(tool, part.input)
    if (isFailureStatus(tool.status)) {
      failures.push({ key: step.key, signature, index })
    } else if (tool.status === "succeeded" && signature) {
      successes.set(signature, index)
    }
  })

  counts.readFiles = readPaths.size
  counts.editedFiles = editPaths.size

  const recoveredKeys = new Set<string>()
  let firstUnrecoveredKey: string | null = null
  for (const failure of failures) {
    const laterSuccess =
      failure.signature !== null ? successes.get(failure.signature) : undefined
    if (laterSuccess !== undefined && laterSuccess > failure.index) {
      recoveredKeys.add(failure.key)
    } else if (firstUnrecoveredKey === null) {
      firstUnrecoveredKey = failure.key
    }
  }

  return {
    steps: stepCount,
    counts,
    failed: failures.length,
    unrecovered: failures.length - recoveredKeys.size,
    interrupted,
    running,
    firstUnrecoveredKey,
    recoveredKeys,
  }
}
