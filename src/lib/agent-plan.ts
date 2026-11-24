import type {
  AdaptedContentPart,
  AdaptedMessage,
} from "@/lib/adapters/ai-elements-adapter"
import {
  isPlanLikeToolName,
  normalizePriority,
  normalizeToolName,
  normalizeStatus,
  parseTodosFromJson,
} from "@/lib/plan-parse"
import type { PlanEntryInfo } from "@/lib/types"

function parseEntriesFromReasoningText(text: string): PlanEntryInfo[] {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  if (lines.length === 0) return []

  const entries: PlanEntryInfo[] = []

  for (const line of lines) {
    const bracketMatch = line.match(
      /^-\s*\[([^\]]+)\]\s*(.*?)(?:\s*\(([^)]+)\))?$/i
    )
    if (bracketMatch) {
      const [, rawStatus, rawContent, rawPriority] = bracketMatch
      const content = rawContent.trim()
      if (!content) continue
      entries.push({
        content,
        status: normalizeStatus(rawStatus),
        priority: normalizePriority(rawPriority),
      })
      continue
    }

    const markdownMatch = line.match(/^[-*]\s*\[(x|\s)\]\s*(.+)$/i)
    if (markdownMatch) {
      const [, done, rawContent] = markdownMatch
      const content = rawContent.trim()
      if (!content) continue
      entries.push({
        content,
        status: done.toLowerCase() === "x" ? "completed" : "pending",
        priority: "medium",
      })
    }
  }

  return entries
}

function extractPlanEntriesFromPart(part: AdaptedContentPart): PlanEntryInfo[] {
  if (part.type === "plan") {
    return part.entries
  }

  if (part.type === "tool-call") {
    if (!isPlanLikeToolName(part.toolName)) return []
    if (!part.input) return []
    return parseTodosFromJson(part.input)
  }

  if (part.type === "goal-run") {
    // Recurse so plan-like tools (TodoWrite, plan-update, etc.) inside a goal
    // run are still discovered. Iterate backwards to match the "latest entry
    // wins" caller semantics.
    for (let i = part.items.length - 1; i >= 0; i -= 1) {
      const entries = extractPlanEntriesFromPart(part.items[i])
      if (entries.length > 0) return entries
    }
    return []
  }

  if (part.type === "reasoning") {
    return parseEntriesFromReasoningText(part.content)
  }

  return []
}

// ---------------------------------------------------------------------------
// Claude Code's Task tools.
//
// Under the SDK, Claude Code keeps its checklist with `TaskCreate` /
// `TaskUpdate` / `TaskList` instead of `TodoWrite`. Each call carries one task
// (or, for `TaskList`, a text listing), so no single call is the plan: it is
// the list the calls build up, keyed by the task id that only the result text
// names. Live, claude-agent-acp folds them into ACP `plan` updates (its
// `applyTaskCreate` / `applyTaskUpdate` / `applyTaskList`), and so does this,
// for the history parsed from the CLI's JSONL, where they are plain tool calls.
// Result texts are the CLI's `mapToolResultToToolResultBlockParam` output.

type TaskOp =
  | { kind: "create"; id: string; subject: string; activeForm?: string }
  | {
      kind: "update"
      id: string
      subject?: string
      status?: string
      activeForm?: string
    }
  | { kind: "list"; tasks: { id: string; subject: string; status: string }[] }

// `status` is absent only for a task seen solely through updates that never
// said its status (see `applyTaskOp`): it is remembered, not shown.
type TaskState = Map<
  string,
  { subject: string; status?: string; activeForm?: string }
>

function parseJsonRecord(input: string | null): Record<string, unknown> | null {
  if (!input) return null
  try {
    const parsed: unknown = JSON.parse(input)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

const TASK_STATUSES = new Set(["pending", "in_progress", "completed"])

/** `#<id> [<status>] <subject>[ (<owner>)][ [blocked by #a, #b]]` per line. */
function parseTaskListOutput(
  output: string
): { id: string; subject: string; status: string }[] | null {
  const text = output.trim()
  if (text === "No tasks found") return []
  const tasks: { id: string; subject: string; status: string }[] = []
  for (const line of text.split("\n")) {
    const match = /^#(\S+) \[(pending|in_progress|completed)\] (.+)$/.exec(line)
    // A line that does not parse means a listing this does not understand
    // (or a truncated one): ignore the call rather than lose tasks.
    if (!match) return null
    let subject = match[3]
    const blocked = subject.lastIndexOf(" [blocked by ")
    if (blocked > 0 && subject.endsWith("]"))
      subject = subject.slice(0, blocked)
    const owner = subject.lastIndexOf(" (")
    if (owner > 0 && subject.endsWith(")")) {
      const candidate = subject.slice(owner + 2, -1)
      if (!candidate.includes("(") && !candidate.includes(")")) {
        subject = subject.slice(0, owner)
      }
    }
    tasks.push({ id: match[1], subject, status: match[2] })
  }
  return tasks.length > 0 ? tasks : null
}

function taskOpOf(part: AdaptedContentPart): TaskOp | null {
  if (part.type !== "tool-call") return null
  if (part.state === "output-error") return null
  const name = normalizeToolName(part.toolName)
  if (name !== "taskcreate" && name !== "taskupdate" && name !== "tasklist") {
    return null
  }
  const output = (part.output ?? "").trim()
  const input = parseJsonRecord(part.input)

  if (name === "taskcreate") {
    // The id is only in the result; a call without one never made a task.
    const match = /^Task #(\S+) created successfully: (.*)$/.exec(output)
    if (!match) return null
    const subject = match[2].trim() || optionalString(input?.subject)?.trim()
    if (!subject) return null
    return {
      kind: "create",
      id: match[1],
      subject,
      activeForm: optionalString(input?.activeForm),
    }
  }

  if (name === "taskupdate") {
    const id = optionalString(input?.taskId)
    if (!id) return null
    // Only `Updated task #<id> <fields>` confirms the update. A refusal is
    // the call's own `error` text (a hook's message, "Task not found", "Failed
    // to delete task", …) or `Task #<id> not found`, so no other text counts.
    const confirmed = output.split("\n", 1)[0]
    if (
      confirmed !== `Updated task #${id}` &&
      !confirmed.startsWith(`Updated task #${id} `)
    ) {
      return null
    }
    return {
      kind: "update",
      id,
      subject: optionalString(input?.subject),
      status: optionalString(input?.status),
      activeForm: optionalString(input?.activeForm),
    }
  }

  const tasks = parseTaskListOutput(output)
  return tasks ? { kind: "list", tasks } : null
}

function applyTaskOp(state: TaskState, op: TaskOp) {
  if (op.kind === "create") {
    state.set(op.id, {
      subject: op.subject,
      status: "pending",
      activeForm: op.activeForm,
    })
    return
  }
  if (op.kind === "update") {
    if (op.status === "deleted") {
      state.delete(op.id)
      return
    }
    const existing = state.get(op.id)
    const status =
      op.status && TASK_STATUSES.has(op.status) ? op.status : existing?.status
    // A task whose TaskCreate is not in the messages — a reopened long session
    // loads only its latest turns until older ones are paged in — still
    // counts once an update states its status: named by what it is doing when
    // the update says, else by its id, as Claude Code itself names it. Until
    // then its labels are kept but it is not shown: it may be done already.
    const subject = op.subject ?? existing?.subject ?? `Task #${op.id}`
    state.set(op.id, {
      subject,
      status,
      activeForm: op.activeForm ?? existing?.activeForm,
    })
    return
  }
  const previous = new Map(state)
  state.clear()
  for (const task of op.tasks) {
    state.set(task.id, {
      subject: task.subject,
      status: task.status,
      activeForm: previous.get(task.id)?.activeForm,
    })
  }
}

function taskStateToEntries(state: TaskState): PlanEntryInfo[] {
  const tasks = Array.from(state.entries())
  // Claude Code numbers its tasks in creation order, which is the list's
  // order; sorting by it puts a task first seen by an update in its place.
  if (tasks.every(([id]) => /^\d+$/.test(id))) {
    tasks.sort(([a], [b]) => Number(a) - Number(b))
  }
  return tasks.flatMap(([, task]) =>
    task.status
      ? [
          {
            content:
              task.status === "in_progress" && task.activeForm
                ? task.activeForm
                : task.subject,
            status: task.status,
            priority: "medium",
          },
        ]
      : []
  )
}

// What one message says about the plan: its latest plan (and the part it is
// in), and its Task tool calls in order (and the part of the last one). A
// message's adapted object is kept for as long as it reads the same, and the
// transcript asks of every message above the newest plan on each streaming
// batch — reading every reasoning block in a long conversation line by line,
// each time, when it has no plan at all.
type MessagePlanInfo = {
  entries: PlanEntryInfo[] | null
  entriesAt: number
  taskOps: TaskOp[]
  lastTaskOpAt: number
}

const planInfoByMessage = new WeakMap<AdaptedMessage, MessagePlanInfo>()

function planInfoOf(message: AdaptedMessage): MessagePlanInfo {
  let info = planInfoByMessage.get(message)
  if (info === undefined) {
    info = { entries: null, entriesAt: -1, taskOps: [], lastTaskOpAt: -1 }
    for (let j = 0; j < message.content.length; j += 1) {
      const part = message.content[j]
      const op = taskOpOf(part)
      if (op) {
        info.taskOps.push(op)
        info.lastTaskOpAt = j
        continue
      }
      const entries = extractPlanEntriesFromPart(part)
      if (entries.length > 0) {
        info.entries = entries
        info.entriesAt = j
      }
    }
    planInfoByMessage.set(message, info)
  }
  return info
}

export function extractLatestPlanEntriesFromMessages(
  messages: AdaptedMessage[]
): PlanEntryInfo[] {
  let planEntries: PlanEntryInfo[] = []
  let planMessageIndex = -1

  // The newest checklist wins, whichever way it was written: a whole list (a
  // plan part, TodoWrite, a plan tool, reasoning) or the Task tools.
  let taskMessageIndex = -1
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const info = planInfoOf(messages[i])
    if (info.entries === null && info.taskOps.length === 0) continue
    if (info.taskOps.length > 0 && info.lastTaskOpAt > info.entriesAt) {
      taskMessageIndex = i
    } else {
      planEntries = info.entries ?? []
      planMessageIndex = i
    }
    break
  }

  if (taskMessageIndex !== -1) {
    // The task list lives for the whole session, so it is built from every
    // Task call up to the newest one.
    const state: TaskState = new Map()
    for (let i = 0; i <= taskMessageIndex; i += 1) {
      for (const op of planInfoOf(messages[i]).taskOps) applyTaskOp(state, op)
    }
    planEntries = taskStateToEntries(state)
    planMessageIndex = taskMessageIndex
  }

  if (planMessageIndex === -1 || planEntries.length === 0) return []

  // A fully completed plan that belongs to an earlier exchange is stale: once
  // the user has sent another message after it, a new turn has begun, so the
  // top-right overlay should only surface the plan of the latest agent reply.
  // Consecutive assistant messages (no user message in between) still count as
  // the same reply, matching how the UI merges adjacent assistant turns.
  const allCompleted = planEntries.every(
    (entry) => entry.status === "completed"
  )
  if (allCompleted) {
    const hasUserReplyAfterPlan = messages
      .slice(planMessageIndex + 1)
      .some((message) => message.role === "user")
    if (hasUserReplyAfterPlan) return []
  }

  return planEntries
}

export function buildPlanKey(entries: PlanEntryInfo[]): string | null {
  if (entries.length === 0) return null
  return entries
    .map((entry) => `${entry.status}:${entry.priority}:${entry.content}`)
    .join("|")
}
