/**
 * The personal agent's timeline rows, as the message list draws them: one
 * bubble per owner message, one per turn of the assistant, one card per
 * result. A turn's questions, permission requests and dispatches go into its
 * reply's bubble; a phase-one turn that wrote no reply row gets a bubble with
 * no body at its first card. Markers are not drawn (the aux panel's run log
 * reads them), nor a reply whose prompt never went out.
 *
 * Messages on one side run together, whoever speaks them (the owner on
 * one side; the assistant and the assistants that ran handed-out work, whose
 * news is a card naming them, on the other): they sit close, and where one
 * meets the next their corners on that side are tight; the other side
 * starts further down. The last message on a side before the other side (a
 * time line, the end) closes the run with a round corner, and is the only
 * one that shows its actions on hover, under it, in that room; the messages
 * before it, too close to the next to have them float over it, keep theirs
 * to a right-click.
 * A reply or card that quotes the message drawn right above it does not
 * repeat that message as a quote.
 *
 * The lines codeg writes for messages between assistants ("sent a message
 * to …", "message from …") sit in the middle, as a time line does; a run of
 * them is one line that opens to each. Those a turn wrote while it ran sit
 * where the turn wrote them: after the text it had written before sending
 * (kept and drawn there, though a reply's body is only its last text), and
 * before the reply's body — or after it, when the turn sent the message once
 * it had written its last word. A line that cannot say where (one written
 * before lines recorded it) comes right before the reply: the reply is the
 * conclusion. A question or permission request another assistant's brain
 * raised for something that began here (a mirror) is a card of its own.
 *
 * Pure, so it can be tested on rows alone.
 */

import type { TimelineRow } from "@/lib/types"

/** Rows a turn's bubble holds rather than drawing on their own. */
const GROUPED_KINDS = new Set(["question", "permission", "dispatch"])
/** A gap longer than this between two messages gets a time line. */
export const TIME_GAP_MS = 5 * 60 * 1000

/** The room above a message: close under the one before on its side
 *  (whoever spoke it), or after the other side — under the actions the last
 *  message there shows on hover. Nothing under a time line, which keeps its
 *  own. */
/** The room over a message: `near` under another of its side, `card` the
 *  same when it or the one above is a card of its own (a card does not
 *  join a run of bubbles, and two cards that touch read as one), `side`
 *  under the other side's. */
export type MessageGap = "near" | "card" | "side"

interface ItemBase {
  key: string
  gap: MessageGap
  /** The last message on its side before the other side, a time line or
   *  the end: its bubble closes the run with a round corner, and its
   *  actions show on hover. */
  tail: boolean
  /** It quotes the message drawn right above it: the quote is not drawn. */
  quotesPrevious: boolean
}

export type MessageItem =
  | { kind: "time"; key: string; at: string }
  | (ItemBase & { kind: "owner"; row: TimelineRow })
  | (ItemBase & {
      kind: "reply"
      /** The reply row; `null` for a phase-one turn that wrote none. */
      row: TimelineRow | null
      /** The row the bubble stands at (and jumps land on). */
      anchor: TimelineRow
      batchId: number | null
      /** The turn's questions, permission requests and dispatches. */
      attached: TimelineRow[]
      /** The owner messages the turn carried. */
      owners: TimelineRow[]
      /** The ordinals of the turn's texts drawn before its lines (`said`
       *  items): while it runs, its bubble does not draw them again. */
      saidNs: number[]
      /** Its dispatches whose news it reported (`reportedPill`): drawn by
       *  that news's card, not as a pill of its own. */
      reported?: number[]
    })
  | (ItemBase & {
      kind: "event"
      row: TimelineRow
      /** The latest news of its work among the rows held: it carries the
       *  work's task card (8.5); earlier news keeps how it stood then. */
      latest: boolean
      /** A reply said in full reported it (its `covers`, A1): the reply
       *  says what came of it, so its own text folds away. */
      covered: boolean
      /** The acceptance of its work, folded into it as its head (A4): its
       *  check and what the check found, and the card of a round its
       *  assistant accepted on a pass — `null` for none on the page. */
      acceptance: AcceptanceFold | null
      /** The dispatch of its work, when the reply that handed the work out
       *  reported this news too (`reportedPill`): the card draws it — what
       *  done looks like — instead of a pill in the reply. */
      pill?: TimelineRow | null
    })
  /** A native card codeg wrote itself (a proposal): on the assistants'
   *  side, standing alone. */
  | (ItemBase & { kind: "notice"; row: TimelineRow })
  /** Messages between assistants, in the middle: `row` is the first of
   *  `rows`, a run of lines with nothing between them. */
  | (ItemBase & { kind: "exchange"; row: TimelineRow; rows: TimelineRow[] })
  /** What a turn wrote before a message it sent (its line comes right
   *  under it), on the assistant's side: `row` is the line, which keeps the
   *  text — the turn's reply keeps only its last. */
  | (ItemBase & { kind: "said"; row: TimelineRow; text: string })
  /** Another assistant's question or permission request, shown where what
   *  it is for began. */
  | (ItemBase & { kind: "mirror"; row: TimelineRow })

/** The acceptance of a piece of work, drawn on its head (A4). */
export interface AcceptanceFold {
  /** The latest round's check: its own work's row. */
  check: TimelineRow | null
  /** What that check found: its result row. */
  result: TimelineRow | null
  /** The latest round's card, its assistant having accepted it on a pass:
   *  nothing to decide, so no card of its own. */
  card: TimelineRow | null
  /** Every row folded in — earlier rounds' too: a jump to any lands on
   *  the head. */
  rows: TimelineRow[]
}

function numIn(row: TimelineRow, key: string): number | null {
  const v = row.data?.[key]
  return typeof v === "number" ? v : null
}

/** An acceptance card with nothing for the owner on it (A4, D2): the
 *  latest round, accepted by its assistant on a check that passed — not
 *  one passed unverified, the owner's to decide, or to check again. */
export function foldsIntoHead(row: TimelineRow): boolean {
  const d = row.data
  return (
    row.kind === "notice" &&
    d?.notice === "acceptance" &&
    d.superseded !== true &&
    d.phase === "accepted" &&
    d.decided_by === "assistant" &&
    d.verdict === "pass" &&
    d.unchecked !== true
  )
}

/** The work a row is of the acceptance of (A4): a check's work and its
 *  result (`check_for`), a card to fold; `null` for any other. */
function acceptanceOf(row: TimelineRow): number | null {
  if (row.kind === "dispatch" || row.kind === "result") {
    return numIn(row, "check_for")
  }
  return foldsIntoHead(row) ? numIn(row, "dispatch_id") : null
}

/** A reply row's `data.state`; `null` on a phase-one row, which has none. */
export function replyState(row: TimelineRow): string | null {
  const s = row.data?.state
  return typeof s === "string" ? s : null
}

/** Where a line a turn wrote stands among the turn's steps, as the line
 *  records it (`data.turn`): the step the turn was on when it sent the
 *  message, and the text it had written last before — `null` for a line
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
  const s =
    t.said && typeof t.said === "object"
      ? (t.said as Record<string, unknown>)
      : null
  const said =
    s &&
    typeof s.n === "number" &&
    Number.isFinite(s.n) &&
    typeof s.text === "string" &&
    s.text.trim() !== ""
      ? { n: s.n, text: s.text }
      : null
  return { n: t.n, said }
}

/** The ordinal of a settled reply's body (its last text), or `null` — a
 *  turn still running, one that wrote no text, or a row that never
 *  recorded it. */
function bodyOrdinal(row: TimelineRow): number | null {
  if (replyState(row) === "running" || row.body.trim() === "") return null
  const n = row.data?.last_text_n
  return typeof n === "number" && Number.isFinite(n) ? n : null
}

/** A reply whose prompt never reached the agent — or a routine's that had
 *  nothing to say (`[[silent]]`, 6.9): as if it never was. */
export function isDiscarded(row: TimelineRow): boolean {
  if (row.kind !== "reply") return false
  const state = replyState(row)
  return state === "discarded" || state === "silent"
}

/** New to the owner, as the server counts it: a result card, a native card,
 *  or a reply once it settled, that they have not seen. */
export function isUnseen(row: TimelineRow): boolean {
  if (row.seen_at != null) return false
  if (row.kind === "result" || row.kind === "notice") return true
  if (row.kind !== "reply") return false
  const state = replyState(row)
  return state !== "running" && state !== "discarded" && state !== "silent"
}

/** The owner's messages are on the end side, everyone else's on the start. */
function sideOf(item: MessageItem): "start" | "end" {
  return item.kind === "owner" ? "end" : "start"
}

/** Every item but a time line: what a row is drawn as. */
type Placed = Exclude<MessageItem, { kind: "time" }>

/** A line across the list, as a time line is: what is above it closes its
 *  run, what is under it starts one. */
export function isLine(item: MessageItem | undefined): boolean {
  return item?.kind === "time" || item?.kind === "exchange"
}

/** A message that is a card of its own, no bubble (`CardMessage`): the news
 *  of a work, a native card, a request shown for another assistant. */
function isCardMessage(item: MessageItem): boolean {
  return (
    item.kind === "event" || item.kind === "notice" || item.kind === "mirror"
  )
}

/** A request row shown here for another assistant (`mirror_of`). */
export function isMirror(row: TimelineRow): boolean {
  return row.data?.mirror_of != null
}

/** The rows a quote can point at to mean "this message". */
function quotableIds(item: MessageItem): number[] {
  switch (item.kind) {
    case "time":
    case "said":
      return []
    case "reply":
      return item.row ? [item.row.id, item.anchor.id] : [item.anchor.id]
    case "exchange":
      return item.rows.map((r) => r.id)
    default:
      return [item.row.id]
  }
}

function sameDay(a: number, b: number): boolean {
  const x = new Date(a)
  const y = new Date(b)
  return (
    x.getFullYear() === y.getFullYear() &&
    x.getMonth() === y.getMonth() &&
    x.getDate() === y.getDate()
  )
}

/**
 * Work a reply handed out and whose news the same reply reported (A1): the
 * assistant dispatched it and waited for it within the turn, so its pill
 * and its news card would show the one piece of work twice, side by side.
 * The card stays — where the work stands, what came of it, its buttons —
 * and draws what done looks like; the pill goes. Only a plain pill: the
 * pill of an acceptance check, or of a round on a pull request, says more
 * than the card does, and a follow-up's ("continue: …", the work as it
 * stands now) says what the card of earlier news does not. Only news drawn
 * as its own card (not folded into a
 * work's head) and reported by that very reply; with two such pieces of
 * news, the newer draws it.
 *
 * `pillOf` maps a news card to the dispatch row it draws; `reportedBy` a
 * reply row to the dispatch rows it no longer draws.
 */
function reportedPills(
  rows: readonly TimelineRow[],
  attachedByBatch: ReadonlyMap<number, TimelineRow[]>,
  foldedIds: ReadonlySet<number>
): {
  pillOf: Map<number, TimelineRow>
  reportedBy: Map<number, number[]>
} {
  // Who reported each card: the reply said in full that names it.
  const reporter = new Map<number, TimelineRow>()
  for (const r of rows) {
    if (r.kind !== "reply" || replyState(r) !== "done" || r.body.trim() === "")
      continue
    const covers = r.data?.covers
    if (!Array.isArray(covers)) continue
    for (const id of covers) {
      if (typeof id === "number" && !reporter.has(id)) reporter.set(id, r)
    }
  }
  const cardOfPill = new Map<number, number>()
  const pillOf = new Map<number, TimelineRow>()
  const replyOfPill = new Map<number, number>()
  for (const r of rows) {
    if (r.kind !== "result" || r.dispatch_id == null) continue
    if (isDiscarded(r) || foldedIds.has(r.id)) continue
    if (numIn(r, "check_for") != null) continue
    const reply = reporter.get(r.id)
    if (reply?.batch_id == null) continue
    const pill = (attachedByBatch.get(reply.batch_id) ?? []).find(
      (a) =>
        a.kind === "dispatch" &&
        a.dispatch_id === r.dispatch_id &&
        !isMirror(a) &&
        numIn(a, "check_for") == null &&
        a.data?.pr_fix == null &&
        a.data?.failed !== true &&
        a.data?.followup !== true
    )
    if (!pill) continue
    // The newer news of the same work draws it.
    const held = cardOfPill.get(pill.id)
    if (held != null) pillOf.delete(held)
    cardOfPill.set(pill.id, r.id)
    pillOf.set(r.id, pill)
    replyOfPill.set(pill.id, reply.id)
  }
  const reportedBy = new Map<number, number[]>()
  for (const [pill, reply] of replyOfPill) {
    const list = reportedBy.get(reply) ?? []
    list.push(pill)
    reportedBy.set(reply, list)
  }
  return { pillOf, reportedBy }
}

export function buildMessageItems(rows: readonly TimelineRow[]): MessageItem[] {
  // The head of each piece of work on the page: its latest news — not a
  // check's. What its acceptance wrote folds into it (A4); with no head
  // here (another page), it stands on its own.
  const heads = new Map<number, number>()
  for (const r of rows) {
    if (r.kind !== "result" || r.dispatch_id == null || isDiscarded(r)) continue
    if (numIn(r, "check_for") != null) continue
    const held = heads.get(r.dispatch_id)
    if (held == null || held < r.id) heads.set(r.dispatch_id, r.id)
  }
  const folded = new Map<number, TimelineRow[]>()
  const foldedIds = new Set<number>()
  for (const r of rows) {
    if (isDiscarded(r)) continue
    const work = acceptanceOf(r)
    if (work == null || !heads.has(work)) continue
    const list = folded.get(work) ?? []
    list.push(r)
    folded.set(work, list)
    foldedIds.add(r.id)
  }
  const replyByBatch = new Map<number, TimelineRow>()
  const attachedByBatch = new Map<number, TimelineRow[]>()
  const ownersByBatch = new Map<number, TimelineRow[]>()
  const exchangesByBatch = new Map<number, TimelineRow[]>()
  for (const r of rows) {
    if (r.batch_id == null || foldedIds.has(r.id)) continue
    if (r.kind === "reply" && !isDiscarded(r)) {
      if (!replyByBatch.has(r.batch_id)) replyByBatch.set(r.batch_id, r)
    } else if (r.kind === "exchange") {
      const list = exchangesByBatch.get(r.batch_id) ?? []
      list.push(r)
      exchangesByBatch.set(r.batch_id, list)
    } else if (GROUPED_KINDS.has(r.kind) && !isMirror(r)) {
      const list = attachedByBatch.get(r.batch_id) ?? []
      list.push(r)
      attachedByBatch.set(r.batch_id, list)
    } else if (r.kind === "owner") {
      const list = ownersByBatch.get(r.batch_id) ?? []
      list.push(r)
      ownersByBatch.set(r.batch_id, list)
    }
  }
  // The result cards a reply said in full reported (A1); a reply that did
  // not finish, or was not shown, reports none.
  const covered = new Set<number>()
  for (const r of rows) {
    if (r.kind !== "reply" || replyState(r) !== "done" || r.body.trim() === "")
      continue
    const covers = r.data?.covers
    if (!Array.isArray(covers)) continue
    for (const id of covers) if (typeof id === "number") covered.add(id)
  }
  const { pillOf, reportedBy } = reportedPills(rows, attachedByBatch, foldedIds)
  const items: MessageItem[] = []
  let prev: { at: number; item: MessageItem } | null = null
  const place = (item: Placed) => {
    const anchor = item.kind === "reply" ? item.anchor : item.row
    const parsed = Date.parse(anchor.created_at)
    const last: { at: number; item: MessageItem } | null = prev
    const at: number = Number.isFinite(parsed) ? parsed : (last?.at ?? 0)
    const timed =
      last == null || at - last.at > TIME_GAP_MS || !sameDay(last.at, at)
    // A run of lines between assistants is one line.
    const before = items[items.length - 1]
    if (item.kind === "exchange" && !timed && before?.kind === "exchange") {
      before.rows.push(...item.rows)
      prev = { at, item: before }
      return
    }
    if (timed) {
      items.push({ kind: "time", key: `t${anchor.id}`, at: anchor.created_at })
    }
    item.gap =
      last == null ||
      last.item.kind === "exchange" ||
      sideOf(last.item) !== sideOf(item)
        ? "side"
        : isCardMessage(item) || isCardMessage(last.item)
          ? "card"
          : "near"
    if (
      item.kind !== "owner" &&
      item.kind !== "exchange" &&
      item.kind !== "said"
    ) {
      // The owner's own quotes always show: they picked them.
      const quoted =
        item.kind === "reply" ? item.row?.reply_to : item.row.reply_to
      item.quotesPrevious =
        quoted != null &&
        last != null &&
        quotableIds(last.item).includes(quoted)
    }
    items.push(item)
    prev = { at, item }
  }
  const exchange = (list: TimelineRow[]): Placed => ({
    kind: "exchange",
    key: `x${list[0].id}`,
    gap: "side",
    tail: false,
    quotesPrevious: false,
    row: list[0],
    rows: [...list],
  })
  /** A reply and the lines its turn wrote, each where it was written: after
   *  the text the turn had written before sending (drawn there, once for a
   *  run of lines it came before), and before the body — or after it, for a
   *  message sent once the last text was written. */
  const placeTurn = (
    item: Extract<Placed, { kind: "reply" }>,
    reply: TimelineRow,
    lines: readonly TimelineRow[]
  ) => {
    const body = bodyOrdinal(reply)
    const after: TimelineRow[] = []
    let shown: number | null = null
    for (const line of lines) {
      const mark = turnMarkOf(line)
      if (body != null && mark != null && mark.n >= body) {
        after.push(line)
        continue
      }
      const said = mark?.said
      if (said && said.n !== shown && said.n !== body) {
        place({
          kind: "said",
          key: `s${line.id}`,
          gap: "side",
          tail: false,
          quotesPrevious: false,
          row: line,
          text: said.text,
        })
        shown = said.n
        item.saidNs.push(said.n)
      }
      place(exchange([line]))
    }
    place(item)
    for (const line of after) place(exchange([line]))
  }
  for (const r of rows) {
    let item: Placed | null = null
    if (r.kind === "marker" || isDiscarded(r)) continue
    // Drawn on its work's head (A4).
    if (foldedIds.has(r.id)) continue
    if (r.kind === "exchange") {
      // A turn's own lines come with its reply.
      if (r.batch_id != null && replyByBatch.has(r.batch_id)) continue
      place(exchange([r]))
      continue
    }
    if (GROUPED_KINDS.has(r.kind) && isMirror(r)) {
      place({
        kind: "mirror",
        key: `m${r.id}`,
        gap: "side",
        tail: false,
        quotesPrevious: false,
        row: r,
      })
      continue
    }
    if (r.kind === "owner") {
      item = {
        kind: "owner",
        key: `o${r.id}`,
        gap: "side",
        tail: false,
        quotesPrevious: false,
        row: r,
      }
    } else if (r.kind === "result") {
      item = {
        kind: "event",
        key: `e${r.id}`,
        gap: "side",
        tail: false,
        quotesPrevious: false,
        row: r,
        latest: false,
        covered: covered.has(r.id),
        acceptance:
          r.dispatch_id != null && heads.get(r.dispatch_id) === r.id
            ? foldOf(folded.get(r.dispatch_id) ?? [])
            : null,
        pill: pillOf.get(r.id) ?? null,
      }
    } else if (r.kind === "notice") {
      item = {
        kind: "notice",
        key: `n${r.id}`,
        gap: "side",
        tail: false,
        quotesPrevious: false,
        row: r,
      }
    } else if (r.kind === "reply") {
      const b = r.batch_id
      item = {
        kind: "reply",
        key: `r${r.id}`,
        gap: "side",
        tail: false,
        quotesPrevious: false,
        row: r,
        anchor: r,
        batchId: b,
        attached: b != null ? (attachedByBatch.get(b) ?? []) : [],
        owners: b != null ? (ownersByBatch.get(b) ?? []) : [],
        saidNs: [],
        reported: reportedBy.get(r.id) ?? [],
      }
    } else if (GROUPED_KINDS.has(r.kind)) {
      const b = r.batch_id
      // Drawn in its turn's reply, or at its turn's first card.
      if (b != null && replyByBatch.has(b)) continue
      const group = b != null ? (attachedByBatch.get(b) ?? [r]) : [r]
      if (group[0].id !== r.id) continue
      item = {
        kind: "reply",
        key: `r${r.id}`,
        gap: "side",
        tail: false,
        quotesPrevious: false,
        row: null,
        anchor: r,
        batchId: b,
        attached: group,
        owners: b != null ? (ownersByBatch.get(b) ?? []) : [],
        saidNs: [],
      }
    }
    if (!item) continue
    // What the turn said to other assistants, where it said it.
    const lines =
      item.kind === "reply" && item.row != null && item.batchId != null
        ? exchangesByBatch.get(item.batchId)
        : undefined
    if (item.kind === "reply" && item.row != null && lines?.length) {
      placeTurn(item, item.row, lines)
    } else {
      place(item)
    }
  }
  items.forEach((item, i) => {
    if (item.kind === "time") return
    const next = items[i + 1]
    item.tail = next == null || isLine(next) || sideOf(next) !== sideOf(item)
  })
  // The latest news of each piece of work: the highest row id, wherever a
  // page put it.
  const latestNews = new Map<number, Extract<MessageItem, { kind: "event" }>>()
  for (const item of items) {
    if (item.kind !== "event" || item.row.dispatch_id == null) continue
    const held = latestNews.get(item.row.dispatch_id)
    if (!held || held.row.id < item.row.id)
      latestNews.set(item.row.dispatch_id, item)
  }
  for (const item of latestNews.values()) item.latest = true
  return items
}

/** What a piece of work's acceptance folds into its head: the latest
 *  round's check, what it found (that round's), the card of a round with
 *  nothing to decide. `null` for nothing. */
function foldOf(list: readonly TimelineRow[]): AcceptanceFold | null {
  if (list.length === 0) return null
  const latest = (kind: TimelineRow["kind"]) =>
    list
      .filter((r) => r.kind === kind)
      .reduce<TimelineRow | null>(
        (a, r) => (a == null || r.id > a.id ? r : a),
        null
      )
  const check = latest("dispatch")
  const result = latest("result")
  return {
    check,
    // Another check under way since — a later round, or the same round
    // checked again (its number kept): what the last one found is not what
    // this one found. A check is its own work: its result is its row's.
    result:
      result != null &&
      (check == null || result.dispatch_id === check.dispatch_id)
        ? result
        : null,
    card: latest("notice"),
    rows: [...list],
  }
}

/** The row ids an item draws (a turn's cards included): what a jump can
 *  land on. */
export function itemRowIds(item: MessageItem): number[] {
  // A turn's text before a line is no row of its own: the line draws it.
  if (item.kind === "time" || item.kind === "said") return []
  if (item.kind === "reply") {
    // A pill the news card draws is that card's (`reportedPills`).
    const reported = item.reported ?? []
    return [
      item.anchor.id,
      ...(item.row ? [item.row.id] : []),
      ...item.attached.filter((r) => !reported.includes(r.id)).map((r) => r.id),
    ]
  }
  if (item.kind === "exchange") return item.rows.map((r) => r.id)
  if (item.kind === "event") {
    return [
      item.row.id,
      // What its acceptance folded into it (A4), and the pill it draws.
      ...(item.acceptance ? item.acceptance.rows.map((r) => r.id) : []),
      ...(item.pill ? [item.pill.id] : []),
    ]
  }
  return [item.row.id]
}

/** Every row id a list of items draws. */
export function drawnRowIds(items: readonly MessageItem[]): Set<number> {
  const ids = new Set<number>()
  for (const item of items) for (const id of itemRowIds(item)) ids.add(id)
  return ids
}

/** A row of the list as it is drawn a screen at a time: one item, keyed as
 *  the item is (an item keeps its row, and what is in it, whatever comes in
 *  around it). */
export interface ListRow {
  key: string
  item: MessageItem
  /** The "new messages" line goes right over it, in its row. */
  newLine: boolean
  /** The item over it is a line (a time, the lines between assistants): a
   *  message right under one takes no room of its own over it, as under the
   *  "new messages" line. */
  underLine: boolean
}

/** The list's items as the rows it is drawn in, the "new messages" line
 *  over item `newLineAt` (`-1`: none). */
export function listRowsOf(
  items: readonly MessageItem[],
  newLineAt: number
): ListRow[] {
  return items.map((item, i) => ({
    key: item.key,
    item,
    newLine: i === newLineAt,
    underLine: isLine(items[i - 1]),
  }))
}

/** Where the "new messages" line goes for row `rowId`: before the item that
 *  draws it — before the time line right above that item, if one is, so the
 *  time stays with its message. `-1` when no item draws it. */
export function newLineIndex(
  items: readonly MessageItem[],
  rowId: number
): number {
  const i = items.findIndex((item) =>
    item.kind === "time" || item.kind === "said"
      ? false
      : item.kind === "reply"
        ? item.anchor.id === rowId || item.row?.id === rowId
        : item.kind === "exchange"
          ? item.rows.some((r) => r.id === rowId)
          : item.row.id === rowId ||
            (item.kind === "event" &&
              (item.acceptance?.rows.some((r) => r.id === rowId) ?? false))
  )
  if (i <= 0) return i
  return items[i - 1].kind === "time" ? i - 1 : i
}
