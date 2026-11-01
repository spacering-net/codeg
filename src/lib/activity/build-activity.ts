/**
 * `buildActivity`: a reply's adapted parts → the activity timeline's view
 * model (steps, grouped rows, trailing answer, header summary).
 *
 * Runs after the adapter and the cross-turn merge, so every lane those
 * produce — delegation polls, background-task polls, goal runs, plans — is
 * already settled and this only reshapes it: plain tool calls are grouped
 * here, by kind; the specialized lanes stay whole.
 */

import {
  splitTrailingAnswerParts,
  type AdaptedContentPart,
  type AdaptedToolCallPart,
} from "@/lib/adapters/ai-elements-adapter"
import { buildBackgroundTaskRows } from "@/lib/background-task"
import { delegateCallTaskId } from "@/lib/delegation-card"
import { buildDelegationTaskRows } from "@/lib/delegation-status"
import { describeToolCall } from "./describe-tool-call"
import { groupActivitySteps } from "./group"
import { combineStatuses, toolCallStatus, type StepStatus } from "./status"
import { summarizeActivity } from "./summarize"
import { thoughtTitle } from "./thought"
import type {
  ActivityItem,
  ActivityModel,
  ActivityStep,
  BackgroundLaunch,
  NotePart,
} from "./types"

function toolStep(part: AdaptedToolCallPart): ActivityStep {
  return {
    type: "tool",
    key: `tool:${part.toolCallId}`,
    part,
    tool: describeToolCall(part),
  }
}

/** Whether two parts carry the same fields, each holding the same value. */
function sameFields(a: object, b: object): boolean {
  if (a === b) return true
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => key in right && left[key] === right[key])
  )
}

function sameEach(a: readonly object[], b: readonly object[]): boolean {
  return a.length === b.length && a.every((item, i) => sameFields(item, b[i]!))
}

function sameLaunches(
  a: Readonly<Record<string, BackgroundLaunch>>,
  b: Readonly<Record<string, BackgroundLaunch>>
): boolean {
  const keys = Object.keys(a)
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => b[key] !== undefined && sameFields(a[key]!, b[key]!))
  )
}

/**
 * What a rebuild of a reply keeps from the model built for it before. A reply
 * that streams is rebuilt from fresh parts on every token, and so is one handed
 * over from the stream to history: a step whose part reads the same keeps its
 * object (and the tool call it describes), and a row whose steps did not change
 * keeps its item, so the memoized rows they feed skip rendering — only what
 * changed draws again.
 */
interface Previous {
  steps: Map<string, ActivityStep>
  items: Map<string, ActivityItem>
  recoveredKeys: ReadonlySet<string>
}

function previousOf(model: ActivityModel): Previous {
  return {
    steps: new Map(model.steps.map((step) => [step.key, step])),
    items: new Map(model.items.map((item) => [item.key, item])),
    recoveredKeys: model.summary.recoveredKeys,
  }
}

/** The rows of the build before whose steps are the same objects. */
function keepItems(
  items: ActivityItem[],
  previous: Previous | null
): ActivityItem[] {
  if (!previous) return items
  return items.map((item) => {
    const prev = previous.items.get(item.key)
    if (item.type === "step") {
      return prev?.type === "step" && prev.step === item.step ? prev : item
    }
    return prev?.type === "group" &&
      prev.kind === item.kind &&
      prev.status === item.status &&
      prev.steps.length === item.steps.length &&
      prev.steps.every((step, i) => step === item.steps[i])
      ? prev
      : item
  })
}

function sameKeys(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const key of a) if (!b.has(key)) return false
  return true
}

function backgroundStatus(polls: AdaptedToolCallPart[]): StepStatus {
  const rows = buildBackgroundTaskRows(polls)
  if (rows.some((row) => row.badge === "running")) return "running"
  if (rows.some((row) => row.badge === "failed")) return "failed"
  if (rows.length > 0 && rows.every((row) => row.badge === "stopped")) {
    return "cancelled"
  }
  return "succeeded"
}

/**
 * A call that was interrupted before it carried anything — no arguments, no
 * output beyond the interruption marker. It says nothing a row could show, so
 * it is left out of the timeline (the header still counts it as interrupted).
 */
function isBlankInterruption(step: ActivityStep): boolean {
  if (step.type !== "tool" || step.tool.status !== "cancelled") return false
  const input = step.part.input?.trim()
  return !input || input === "{}" || input === "[]" || input === "null"
}

/** djb2 — only has to tell replies apart, not resist collisions on purpose. */
function hashText(text: string): string {
  let hash = 5381
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(36)
}

/**
 * A stable name for the reply, prefixed onto the keys of steps that have no id
 * of their own (thoughts, notes, plans), so a remembered open/closed choice
 * stays with the right row across replies and through the live → history
 * hand-over. The opening prose or thought names it when the reply starts with
 * one (its first characters stop changing almost at once while it streams, and
 * reload with the same text); otherwise the first tool call id does (ids
 * persist across that hand-over).
 */
function replyAnchor(parts: AdaptedContentPart[]): string {
  const first = parts[0]
  if (first?.type === "text" || first?.type === "reasoning") {
    const text = first.type === "text" ? first.text : first.content
    if (text.trim().length >= ANCHOR_TEXT_LENGTH) {
      return `h${hashText(text.slice(0, ANCHOR_TEXT_LENGTH))}`
    }
  }
  for (const part of parts) {
    if (part.type === "tool-call") return part.toolCallId
    if (
      (part.type === "delegation-status-group" ||
        part.type === "background-task-group") &&
      part.polls[0]
    ) {
      return part.polls[0].toolCallId
    }
    if (part.type === "goal-run") return part.start.toolCallId
  }
  return first ? `h${hashText(JSON.stringify(first).slice(0, 200))}` : "empty"
}

const ANCHOR_TEXT_LENGTH = 32

/** Background launches among the steps so far, by task id. */
function launchesBefore(
  steps: ActivityStep[]
): Record<string, BackgroundLaunch> {
  const launches: Record<string, BackgroundLaunch> = {}
  for (const step of steps) {
    if (step.type !== "tool") continue
    const taskId = step.tool.background?.taskId
    if (!taskId || !step.tool.command) continue
    launches[taskId] = {
      stepKey: step.key,
      command: step.tool.command.display,
      description: step.tool.command.description,
    }
  }
  return launches
}

/**
 * A delegation's status checks are rows of their own — the agent waiting on
 * the task, right after handing it over or after other work — yet the newest
 * of them says how the delegation stands: hand the delegation step the polls
 * about its task, so its step bar and result read that report.
 */
function linkLaterDelegationPolls(steps: ActivityStep[]): ActivityStep[] {
  const tasksOf = new Map<AdaptedToolCallPart[], Set<string | null>>()
  const tasksIn = (polls: AdaptedToolCallPart[]): Set<string | null> => {
    const cached = tasksOf.get(polls)
    if (cached) return cached
    const tasks = new Set(buildDelegationTaskRows(polls).map((r) => r.taskId))
    tasksOf.set(polls, tasks)
    return tasks
  }
  return steps.map((step, index) => {
    if (step.type !== "tool" || step.tool.kind !== "delegation") return step
    const taskId = delegateCallTaskId(step.part)
    const later: AdaptedToolCallPart[] = []
    if (taskId !== null) {
      for (const next of steps.slice(index + 1)) {
        if (
          next.type === "delegation-polls" &&
          tasksIn(next.polls).has(taskId)
        ) {
          later.push(...next.polls)
        }
      }
    }
    // A step kept from the build before still carries the polls it had then.
    if (sameEach(step.laterPolls ?? [], later)) return step
    return { ...step, laterPolls: later.length > 0 ? later : undefined }
  })
}

function collectSteps(
  parts: AdaptedContentPart[],
  isStreaming: boolean,
  anchor: string,
  previous: Previous | null
): ActivityStep[] {
  const steps: ActivityStep[] = []
  const prior = (key: string) => previous?.steps.get(key)
  const note = (key: string, part: NotePart): ActivityStep => {
    const prev = prior(key)
    return prev?.type === "note" && sameFields(prev.part, part)
      ? prev
      : { type: "note", key, part }
  }
  parts.forEach((part, index) => {
    switch (part.type) {
      case "text":
        if (part.text.trim().length > 0) {
          steps.push(note(`note:${anchor}:${index}`, part))
        }
        return
      case "proposed-plan":
      case "turn-error":
        steps.push(note(`note:${anchor}:${index}`, part))
        return
      case "reasoning": {
        const streaming = isStreaming && part.isStreaming
        if (!streaming && part.content.trim().length === 0) return
        const key = `thought:${anchor}:${index}`
        const prev = prior(key)
        steps.push(
          prev?.type === "thought" &&
            prev.streaming === streaming &&
            sameFields(prev.part, part)
            ? prev
            : {
                type: "thought",
                key,
                part,
                title: thoughtTitle(part.content, streaming),
                streaming,
              }
        )
        return
      }
      case "tool-call": {
        const prev = prior(`tool:${part.toolCallId}`)
        steps.push(
          prev?.type === "tool" && sameFields(prev.part, part)
            ? prev
            : toolStep(part)
        )
        return
      }
      case "tool-result": {
        const key = `result:${part.toolCallId}:${index}`
        const prev = prior(key)
        steps.push(
          prev?.type === "tool-result" && sameFields(prev.part, part)
            ? prev
            : { type: "tool-result", key, part }
        )
        return
      }
      case "delegation-status-group": {
        if (part.polls.length === 0) return
        const key = `dpoll:${part.polls[0]!.toolCallId}`
        const prev = prior(key)
        steps.push(
          prev?.type === "delegation-polls" && sameEach(prev.polls, part.polls)
            ? prev
            : {
                type: "delegation-polls",
                key,
                polls: part.polls,
                status: combineStatuses(
                  part.polls.map((p) => toolCallStatus(p))
                ),
              }
        )
        return
      }
      case "background-task-group": {
        if (part.polls.length === 0) return
        const key = `bg:${part.polls[0]!.toolCallId}`
        const launches = launchesBefore(steps)
        const prev = prior(key)
        steps.push(
          prev?.type === "background-tasks" &&
            sameEach(prev.polls, part.polls) &&
            sameLaunches(prev.launches, launches)
            ? prev
            : {
                type: "background-tasks",
                key,
                polls: part.polls,
                status: backgroundStatus(part.polls),
                launches,
              }
        )
        return
      }
      case "goal-run":
        steps.push({
          type: "goal",
          key: `goal:${part.start.toolCallId}`,
          part,
          // The goal row has no answer slot: whatever prose the run holds
          // (the answer streaming inside a live run, notes before its closing
          // update_goal) stays a step, or it would never be drawn.
          model: buildActivityUncached(part.items, part.isRunning, false),
        })
        return
      case "plan": {
        const key = `plan:${anchor}:${index}`
        const prev = prior(key)
        steps.push(
          prev?.type === "plan" && sameFields(prev.part, part)
            ? prev
            : { type: "plan", key, part }
        )
        return
      }
      case "generated-image": {
        const key = `image:${anchor}:${index}`
        const prev = prior(key)
        steps.push(
          prev?.type === "image" && sameFields(prev.part, part)
            ? prev
            : { type: "image", key, part }
        )
        return
      }
    }
  })
  return steps
}

/** The last model built for each reply, by the anchor its keys carry — what
 *  its next rebuild keeps from (see `Previous`). A few replies at a time: the
 *  ones streaming now, and those just handed over to history. */
const lastBuilt = new Map<string, ActivityModel>()
const LAST_BUILT_MAX = 8

function buildActivityUncached(
  parts: AdaptedContentPart[],
  isStreaming: boolean,
  splitAnswer = true
): ActivityModel {
  const { body, trailing } = splitAnswer
    ? splitTrailingAnswerParts(parts)
    : { body: parts, trailing: [] }
  const anchor = replyAnchor(body)
  const slot = `${splitAnswer ? "reply" : "all"}:${anchor}`
  const last = lastBuilt.get(slot)
  const previous = last ? previousOf(last) : null
  const steps = linkLaterDelegationPolls(
    collectSteps(body, isStreaming, anchor, previous)
  )
  const summary = summarizeActivity(steps)
  const model: ActivityModel = {
    steps,
    items: keepItems(
      groupActivitySteps(steps.filter((s) => !isBlankInterruption(s))),
      previous
    ),
    answer: trailing,
    // The rows read it through context: a new set of the same keys would
    // draw every row again.
    summary:
      previous && sameKeys(previous.recoveredKeys, summary.recoveredKeys)
        ? { ...summary, recoveredKeys: previous.recoveredKeys }
        : summary,
  }
  lastBuilt.delete(slot)
  lastBuilt.set(slot, model)
  if (lastBuilt.size > LAST_BUILT_MAX) {
    lastBuilt.delete(lastBuilt.keys().next().value!)
  }
  return model
}

/** A step keyed by its reply's anchor and its place in the reply:
 *  `note:<anchor>:<index>`, and so thoughts, plans and images. */
const ANCHORED_KEY = /^(note|thought|plan|image):.+:(\d+)$/

/**
 * A step's identity within its own reply: its key without the reply's anchor.
 * The anchor tells replies apart (the disclosure store, the last build kept
 * per reply), but while the first thing a reply says is still short it is
 * hashed from that text as it grows, so a thought's key changes several times
 * in its first moments — and a row keyed by it was drawn anew each time,
 * cutting short its arrival. Within one reply the part's place is enough.
 */
export function rowIdentity(key: string): string {
  const anchored = ANCHORED_KEY.exec(key)
  return anchored ? `${anchored[1]}@${anchored[2]}` : key
}

/**
 * Does a reply's answer leave anything for the reader? Whitespace-only text is
 * not an answer: it renders as an empty markdown block, so a turn "kept
 * visible" by it still reads as a blank reply.
 */
export function hasVisibleAnswer(answer: AdaptedContentPart[]): boolean {
  return answer.some(
    (part) => part.type !== "text" || part.text.trim().length > 0
  )
}

const cache = new WeakMap<
  AdaptedContentPart[],
  Partial<
    Record<
      "streaming" | "settled" | "streaming:all" | "settled:all",
      ActivityModel
    >
  >
>()

/**
 * Build the activity model for one reply. Cached per `parts` array: a settled
 * reply's array is pinned by the per-turn adapter cache and the merged-run
 * cache, so scrolling and re-rendering never rebuild it.
 */
export function buildActivity(
  parts: AdaptedContentPart[],
  opts: {
    isStreaming: boolean
    /** Keep closing prose as steps instead of splitting it off as the
     *  answer — for a sub-agent's own timeline, which has no answer slot,
     *  and for a reply still being written, whose closing prose is not
     *  known yet. */
    keepAnswer?: boolean
  }
): ActivityModel {
  let entry = cache.get(parts)
  if (!entry) {
    entry = {}
    cache.set(parts, entry)
  }
  const slot =
    `${opts.isStreaming ? "streaming" : "settled"}${opts.keepAnswer ? ":all" : ""}` as const
  const cached = entry[slot]
  if (cached) return cached
  const model = buildActivityUncached(parts, opts.isStreaming, !opts.keepAnswer)
  entry[slot] = model
  return model
}
