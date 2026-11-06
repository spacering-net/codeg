/**
 * What one reply bubble shows, decided in one place for every way a reply is
 * seen — streaming live, opened mid-turn, on a read-only page, after a
 * refresh, paged in from history. The bubble only draws what this returns,
 * so a reply looks the same whichever way it reached the page.
 *
 * - While it runs: the step it is on now — the last push, else the step its
 *   row last recorded (a page that cannot hear the engine, or one opened
 *   before the first push).
 * - Once it ended: only its row. The body is the last text the assistant
 *   wrote; how the turn ended is a line under it; a turn that wrote nothing
 *   says what it did instead.
 *
 * Pure, so every case of the plan's edge table is a unit test.
 */

import type { ReplyStep, TimelineRow } from "@/lib/types"

import { replyState } from "./message-items"

export type StepInfo = Extract<ReplyStep, { t: "step" }>

/** What the step slot holds. Keyed by the step's ordinal, so a text that
 *  grows, and the same text settling as the body, stay one element. */
export type SlotView =
  | { kind: "text"; key: string; text: string; streaming: boolean }
  | { kind: "step"; key: string; step: StepInfo }
  /** Running, no step yet. */
  | { kind: "waiting"; key: string }
  /** Ended without a word: what it did instead. */
  | {
      kind: "note"
      key: string
      note: "dispatched" | "continued" | "nothing"
      count: number
    }

export type ReplyEnding =
  | { kind: "stopped" }
  | { kind: "error"; detail: string | null }
  | { kind: "interrupted"; why: string | null; detail: string | null }
  | { kind: "truncated" }

/** An answer the owner gave during the turn, kept as one quiet line. */
export interface AnsweredLine {
  rowId: number
  kind: "permission" | "question" | "skipped" | "plan"
  /** The option chosen, the answers, or the plan decision. */
  text: string
}

export interface ReplyView {
  running: boolean
  slot: SlotView | null
  ending: ReplyEnding | null
  answered: AnsweredLine[]
  /** The turn's dispatch and follow-up cards, in order. */
  dispatches: TimelineRow[]
  /** Interrupted messages of the turn that can be sent again. */
  resend: number[]
  durationMs: number | null
}

export interface ReplyViewInput {
  /** The reply row; `null` for a phase-one turn that wrote none. */
  row: TimelineRow | null
  /** The last push for this row; `undefined` when none came. */
  live: ReplyStep | null | undefined
  attached: readonly TimelineRow[]
  owners: readonly TimelineRow[]
}

function str(data: Record<string, unknown> | null, key: string): string | null {
  const v = data?.[key]
  return typeof v === "string" && v.length > 0 ? v : null
}

function num(data: Record<string, unknown> | null, key: string): number | null {
  const v = data?.[key]
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

/** A step a row recorded (its last checkpoint), if well-formed. */
export function stepFromData(raw: unknown): ReplyStep | null {
  if (!raw || typeof raw !== "object") return null
  const o = raw as Record<string, unknown>
  if (typeof o.n !== "number") return null
  if (o.t === "text" && typeof o.text === "string") {
    return { t: "text", n: o.n, text: o.text }
  }
  if (o.t === "step") {
    return {
      t: "step",
      n: o.n,
      id: typeof o.id === "string" ? o.id : undefined,
      kind: typeof o.kind === "string" ? o.kind : "other",
      title: typeof o.title === "string" ? o.title : "",
      status: typeof o.status === "string" ? o.status : undefined,
      awaiting: o.awaiting === true,
    }
  }
  return null
}

export function slotOfStep(step: ReplyStep | null): SlotView {
  if (!step) return { kind: "waiting", key: "waiting" }
  if (step.t === "text") {
    return {
      kind: "text",
      key: `t${step.n}`,
      text: step.text,
      streaming: true,
    }
  }
  return { kind: "step", key: `s${step.n}`, step }
}

function answeredLines(attached: readonly TimelineRow[]): AnsweredLine[] {
  const lines: AnsweredLine[] = []
  for (const r of attached) {
    const data = r.data
    const state = str(data, "state")
    if (r.kind === "permission" && state === "answered") {
      const options = Array.isArray(data?.options)
        ? (data.options as { option_id?: string; name?: string }[])
        : []
      const chosen = str(data, "option_id")
      const name =
        options.find((o) => o.option_id === chosen)?.name ?? chosen ?? ""
      lines.push({ rowId: r.id, kind: "permission", text: name })
    } else if (r.kind === "question") {
      const answer =
        data?.answer && typeof data.answer === "object"
          ? (data.answer as {
              answers?: { selected?: string[]; text?: string }[]
              decision?: string
            })
          : null
      if (str(data, "kind") === "plan_approval") {
        if (state === "answered" && answer?.decision) {
          lines.push({ rowId: r.id, kind: "plan", text: answer.decision })
        }
      } else if (state === "answered") {
        const text = (answer?.answers ?? [])
          .flatMap((a) => [...(a.selected ?? []), ...(a.text ? [a.text] : [])])
          .filter((s) => s.trim().length > 0)
          .join("、")
        lines.push({ rowId: r.id, kind: "question", text })
      } else if (state === "skipped") {
        lines.push({ rowId: r.id, kind: "skipped", text: "" })
      }
    }
  }
  return lines
}

function endingOf(
  row: TimelineRow | null,
  hasBody: boolean
): ReplyEnding | null {
  if (!row) return null
  const data = row.data
  const state = replyState(row)
  if (state === null) {
    // A phase-one reply.
    if (data?.interrupted === true) {
      return { kind: "interrupted", why: null, detail: null }
    }
    if (data?.canceled === true) return { kind: "stopped" }
    return null
  }
  switch (state) {
    case "canceled":
      return { kind: "stopped" }
    case "interrupted":
      return {
        kind: "interrupted",
        why: str(data, "why"),
        detail: str(data, "error"),
      }
    case "done": {
      if (str(data, "stop_reason") === "max_tokens")
        return { kind: "truncated" }
      const error = str(data, "error")
      if (error && hasBody) return { kind: "error", detail: error }
      return null
    }
    default:
      return null
  }
}

export function replyView({
  row,
  live,
  attached,
  owners,
}: ReplyViewInput): ReplyView {
  const dispatches = attached.filter((r) => r.kind === "dispatch")
  const answered = answeredLines(attached)
  const state = row ? replyState(row) : null
  const running = state === "running"
  const resend = running
    ? []
    : owners
        .filter(
          (o) => o.status === "interrupted" && num(o.data, "resent_as") == null
        )
        .map((o) => o.id)

  if (running) {
    const current =
      live !== undefined ? live : stepFromData(row?.data?.current ?? null)
    return {
      running,
      slot: slotOfStep(current),
      ending: null,
      answered,
      dispatches,
      resend,
      durationMs: null,
    }
  }

  const body = row?.body.trim() ?? ""
  const hasBody = body.length > 0
  const ending = endingOf(row, hasBody)
  const lastN = row ? num(row.data, "last_text_n") : null
  let slot: SlotView | null = null
  if (hasBody) {
    slot = {
      kind: "text",
      key: lastN != null ? `t${lastN}` : "body",
      text: body,
      streaming: false,
    }
  } else if (ending == null || ending.kind === "truncated") {
    // Ended well but wrote nothing: say what it did.
    const fresh = new Set(
      dispatches
        .filter((d) => d.data?.followup !== true)
        .map((d) => d.dispatch_id ?? d.id)
    )
    const continued = new Set(
      dispatches
        .filter((d) => d.data?.followup === true)
        .map((d) => d.dispatch_id ?? d.id)
    )
    slot =
      fresh.size > 0
        ? { kind: "note", key: "note", note: "dispatched", count: fresh.size }
        : continued.size > 0
          ? {
              kind: "note",
              key: "note",
              note: "continued",
              count: continued.size,
            }
          : { kind: "note", key: "note", note: "nothing", count: 0 }
  }
  return {
    running,
    slot,
    ending,
    answered,
    dispatches,
    resend,
    durationMs: row ? num(row.data, "duration_ms") : null,
  }
}
