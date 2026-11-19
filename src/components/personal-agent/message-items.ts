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
    })
  | (ItemBase & {
      kind: "event"
      row: TimelineRow
      /** The latest news of its work among the rows held: it carries the
       *  work's task card (8.5); earlier news keeps how it stood then. */
      latest: boolean
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

export function buildMessageItems(rows: readonly TimelineRow[]): MessageItem[] {
  const replyByBatch = new Map<number, TimelineRow>()
  const attachedByBatch = new Map<number, TimelineRow[]>()
  const ownersByBatch = new Map<number, TimelineRow[]>()
  const exchangesByBatch = new Map<number, TimelineRow[]>()
  for (const r of rows) {
    if (r.batch_id == null) continue
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

/** The row ids an item draws (a turn's cards included): what a jump can
 *  land on. */
export function itemRowIds(item: MessageItem): number[] {
  // A turn's text before a line is no row of its own: the line draws it.
  if (item.kind === "time" || item.kind === "said") return []
  if (item.kind === "reply") {
    return [
      item.anchor.id,
      ...(item.row ? [item.row.id] : []),
      ...item.attached.map((r) => r.id),
    ]
  }
  if (item.kind === "exchange") return item.rows.map((r) => r.id)
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
          : item.row.id === rowId
  )
  if (i <= 0) return i
  return items[i - 1].kind === "time" ? i - 1 : i
}
