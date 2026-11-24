/**
 * Fold a turn's steps into the rows the timeline draws.
 *
 * - Consecutive exploration calls (read / search / glob / list / fetch / web
 *   search / memory) become one "Explored" row; consecutive commands one "Ran N
 *   commands" row. A run needs two members — a lone call stays a plain row.
 * - Everything else ends a run: thoughts, prose, edits, MCP and other tools,
 *   sub-agents, plans, questions. A thought is the agent's own voice between
 *   its calls, so it always stands as a row of its own rather than being
 *   folded away with the calls around it. A failed call does NOT end a run;
 *   it stays inside, and the group shows the failure.
 * - A group's key is its first member's, so a run that grows keeps its key
 *   (and with it the reader's open/closed choice).
 */

import { combineStatuses } from "./status"
import {
  COMMAND_KINDS,
  EXPLORE_KINDS,
  type ActivityItem,
  type ActivityStep,
  type GroupKind,
} from "./types"

type ToolStep = Extract<ActivityStep, { type: "tool" }>

function familyOf(step: ActivityStep): GroupKind | null {
  if (step.type !== "tool") return null
  if (EXPLORE_KINDS.has(step.tool.kind)) return "explore"
  if (COMMAND_KINDS.has(step.tool.kind)) return "command"
  return null
}

interface Run {
  kind: GroupKind
  members: ToolStep[]
}

export function groupActivitySteps(steps: ActivityStep[]): ActivityItem[] {
  const items: ActivityItem[] = []
  let run: Run | null = null

  const emit = (step: ActivityStep) => {
    items.push({ type: "step", key: step.key, step })
  }

  const flush = () => {
    if (!run) return
    if (run.members.length >= 2) {
      items.push({
        type: "group",
        key: run.members[0]!.key,
        kind: run.kind,
        steps: run.members,
        status: combineStatuses(run.members.map((m) => m.tool.status)),
      })
    } else {
      for (const member of run.members) emit(member)
    }
    run = null
  }

  for (const step of steps) {
    const family = familyOf(step)
    if (family && step.type === "tool") {
      if (run && run.kind === family) {
        run.members.push(step)
        continue
      }
      flush()
      run = { kind: family, members: [step] }
      continue
    }
    flush()
    emit(step)
  }
  flush()
  return items
}

/**
 * The disclosure keys to open so the step `key` is in view: the step's own,
 * and its group's when it is folded into one.
 */
export function disclosureKeysFor(
  items: ActivityItem[],
  key: string
): string[] {
  for (const item of items) {
    if (item.type === "group" && item.steps.some((s) => s.key === key)) {
      return [`group:${item.key}`, key]
    }
  }
  return [key]
}
