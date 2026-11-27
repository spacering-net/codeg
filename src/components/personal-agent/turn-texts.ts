/**
 * Every text run of an assistant's turn, as the page shows them (P6): all a
 * turn said stays, in the order it said it — a reply's body is only its
 * last run, its conclusion.
 *
 * Where the runs come from, whichever way the reply reached the page:
 * - settled: the row's `texts`; the conclusion is its body;
 * - running: the newer of the row's checkpoint and the last push, by their
 *   version (`ver`) — a slow read never takes text back — over the older;
 * - either way, the run each line the turn wrote kept (`turn.said`, written
 *   with the line) fills one a copy does not have yet: a line is never shown
 *   before the text written before it, nor a run lost that a reply settled
 *   from an older checkpoint never had;
 * - a row from before runs were kept: its lines' runs, then its body.
 *
 * Pure, so every case is a unit test.
 */

import type { LiveTurn } from "@/contexts/personal-agent-context"
import type { ReplyStep, ReplyText, TimelineRow } from "@/lib/types"

export type { LiveTurn }

/** Where a body that never recorded its run's ordinal stands: last. */
export const BODY_LAST = Number.MAX_SAFE_INTEGER

/** Where a line a turn wrote stands among the turn's steps, as the line
 *  records it (`data.turn`): the step the turn was on when it wrote the
 *  line, and the text it had written last before — `null` for a line
 *  written outside a turn, or before lines recorded it. */
export interface TurnMark {
  n: number
  said: { n: number; text: string } | null
}

export function turnMarkOf(row: TimelineRow): TurnMark | null {
  const turn = row.data?.turn
  if (!turn || typeof turn !== "object") return null
  const t = turn as Record<string, unknown>
  if (typeof t.n !== "number" || !Number.isFinite(t.n)) return null
  const said = runOf(t.said)
  return { n: t.n, said: said && said.text.trim() !== "" ? said : null }
}

function runOf(raw: unknown): ReplyText | null {
  if (!raw || typeof raw !== "object") return null
  const o = raw as Record<string, unknown>
  return typeof o.n === "number" &&
    Number.isFinite(o.n) &&
    typeof o.text === "string"
    ? { n: o.n, text: o.text }
    : null
}

/** A row's `texts`, well-formed entries only; `null` when it has none (a
 *  row an older codeg wrote). */
export function textsOf(raw: unknown): ReplyText[] | null {
  if (!Array.isArray(raw)) return null
  const out: ReplyText[] = []
  for (const t of raw) {
    const run = runOf(t)
    if (run) out.push(run)
  }
  return out
}

function stateOf(row: TimelineRow): string | null {
  const s = row.data?.state
  return typeof s === "string" ? s : null
}

/** The ordinal of a settled reply's conclusion — its body: the run it
 *  recorded, or last for a row that recorded none. `null` while it runs,
 *  or for one that wrote nothing. */
export function conclusionOf(row: TimelineRow): number | null {
  if (row.kind !== "reply") return null
  if (stateOf(row) === "running" || row.body.trim() === "") return null
  const n = row.data?.last_text_n
  return typeof n === "number" && Number.isFinite(n) ? n : BODY_LAST
}

function chars(text: string): number {
  return Array.from(text).length
}

/**
 * Every text run of reply `row`'s turn, in order. `live` is the last push
 * for it (none for a page that cannot hear the engine); `lines` the turn's
 * lines (messages it sent, work it handed out), whose kept runs fill in.
 */
export function turnTexts(
  row: TimelineRow,
  live: LiveTurn | undefined,
  lines: readonly TimelineRow[]
): ReplyText[] {
  const data = row.data
  const byN = new Map<number, string>()
  const put = (list: readonly ReplyText[]) => {
    for (const t of list) byN.set(t.n, t.text)
  }
  /** A copy of one run only grows: the longer of two is the later. */
  const fill = (run: ReplyText | null) => {
    if (!run || run.text.trim() === "") return
    const held = byN.get(run.n)
    if (held == null || chars(run.text) > chars(held)) byN.set(run.n, run.text)
  }
  /** What only says the step it is on fills a run no copy has yet. */
  const fillMissing = (run: ReplyText | null) => {
    if (run && run.text.trim() !== "" && !byN.has(run.n)) {
      byN.set(run.n, run.text)
    }
  }
  const own = textsOf(data?.texts)
  const lastN = data?.last_text_n
  const conclusion =
    typeof lastN === "number" && Number.isFinite(lastN) ? lastN : null
  if (stateOf(row) === "running") {
    const ver =
      typeof data?.ver === "number" && Number.isFinite(data.ver) ? data.ver : -1
    // The older copy first, the newer over it: a run it has is the newer's,
    // a run only the older has stays.
    if (live && live.ver > ver) {
      if (own) put(own)
      put(live.texts)
    } else {
      if (live) put(live.texts)
      if (own) put(own)
    }
    for (const line of lines) fill(turnMarkOf(line)?.said ?? null)
    // A checkpoint an older codeg wrote keeps its last run, and the step.
    if (!own) fillMissing(runOf(data?.last_text))
    const steps = [live?.current, stepText(data?.current)]
    for (const step of steps) {
      if (step?.t === "text") fillMissing({ n: step.n, text: step.text })
    }
  } else {
    if (own) put(own)
    // The runs its lines kept: all of them, for a row from before runs were
    // kept; a run written after the checkpoint it settled from, for one
    // settled without its connection.
    for (const line of lines) fill(turnMarkOf(line)?.said ?? null)
    // The conclusion is its body, whatever a copy kept of it.
    if (row.body.trim() !== "" && (conclusion != null || !own)) {
      byN.set(conclusion ?? BODY_LAST, row.body)
    }
  }
  return [...byN]
    .filter(([, text]) => text.trim() !== "")
    .sort((a, b) => a[0] - b[0])
    .map(([n, text]) => ({ n, text }))
}

function stepText(raw: unknown): ReplyStep | null {
  if (!raw || typeof raw !== "object") return null
  const o = raw as Record<string, unknown>
  return o.t === "text" && typeof o.n === "number" && typeof o.text === "string"
    ? { t: "text", n: o.n, text: o.text }
    : null
}

/** A part of a turn, between the lines it wrote: the runs with an ordinal
 *  past `lo`, up to `hi` (a run and a line at one step: the run first). */
export interface TurnPart {
  lo: number
  hi: number
  /** The lines whose kept runs fill the turn's texts. */
  lines: readonly TimelineRow[]
}

/** The whole of a turn that wrote no lines. */
export const WHOLE_TURN: TurnPart = { lo: -Infinity, hi: Infinity, lines: [] }

/** The runs of `texts` in `part`. */
export function textsIn(
  texts: readonly ReplyText[],
  part: Pick<TurnPart, "lo" | "hi">
): ReplyText[] {
  return texts.filter((t) => t.n > part.lo && t.n <= part.hi)
}

/** Text so far that may yet be a routine's `[[silent]]`. */
export function silentSoFar(text: string): boolean {
  const t = text.trim()
  return t.length > 0 && "[[silent]]".startsWith(t)
}

/** A run that is the "nothing to say" mark alone (as the server reads it:
 *  its words without spaces, a full stop after it allowed) — never words
 *  to show. */
export function isSilentMark(text: string): boolean {
  const t = text.replace(/\s+/g, "")
  return t === "[[silent]]" || t === "[[silent]]."
}
