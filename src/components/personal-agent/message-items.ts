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
export type MessageGap = "near" | "side"

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
    })
  | (ItemBase & { kind: "event"; row: TimelineRow })
  /** A native card codeg wrote itself (a proposal): on the assistants'
   *  side, standing alone. */
  | (ItemBase & { kind: "notice"; row: TimelineRow })

/** A reply row's `data.state`; `null` on a phase-one row, which has none. */
export function replyState(row: TimelineRow): string | null {
  const s = row.data?.state
  return typeof s === "string" ? s : null
}

/** A reply whose prompt never reached the agent: as if it never was. */
export function isDiscarded(row: TimelineRow): boolean {
  return row.kind === "reply" && replyState(row) === "discarded"
}

/** New to the owner, as the server counts it: a result card, a native card,
 *  or a reply once it settled, that they have not seen. */
export function isUnseen(row: TimelineRow): boolean {
  if (row.seen_at != null) return false
  if (row.kind === "result" || row.kind === "notice") return true
  if (row.kind !== "reply") return false
  const state = replyState(row)
  return state !== "running" && state !== "discarded"
}

/** The owner's messages are on the end side, everyone else's on the start. */
function sideOf(item: MessageItem): "start" | "end" {
  return item.kind === "owner" ? "end" : "start"
}

/** The rows a quote can point at to mean "this message". */
function quotableIds(item: MessageItem): number[] {
  switch (item.kind) {
    case "time":
      return []
    case "reply":
      return item.row ? [item.row.id, item.anchor.id] : [item.anchor.id]
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
  for (const r of rows) {
    if (r.batch_id == null) continue
    if (r.kind === "reply" && !isDiscarded(r)) {
      if (!replyByBatch.has(r.batch_id)) replyByBatch.set(r.batch_id, r)
    } else if (GROUPED_KINDS.has(r.kind)) {
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
  for (const r of rows) {
    let item: MessageItem | null = null
    if (r.kind === "marker" || isDiscarded(r)) continue
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
      }
    }
    if (!item) continue
    const anchor = item.kind === "reply" ? item.anchor : item.row
    const parsed = Date.parse(anchor.created_at)
    const last: { at: number; item: MessageItem } | null = prev
    const at: number = Number.isFinite(parsed) ? parsed : (last?.at ?? 0)
    if (last == null || at - last.at > TIME_GAP_MS || !sameDay(last.at, at)) {
      items.push({ kind: "time", key: `t${anchor.id}`, at: anchor.created_at })
    }
    item.gap =
      last == null || sideOf(last.item) !== sideOf(item) ? "side" : "near"
    if (item.kind !== "owner") {
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
  items.forEach((item, i) => {
    if (item.kind === "time") return
    const next = items[i + 1]
    item.tail =
      next == null || next.kind === "time" || sideOf(next) !== sideOf(item)
  })
  return items
}

/** Every row id a list of items draws (a turn's cards included): what a jump
 *  can land on. */
export function drawnRowIds(items: readonly MessageItem[]): Set<number> {
  const ids = new Set<number>()
  for (const item of items) {
    if (item.kind === "time") continue
    if (item.kind === "reply") {
      ids.add(item.anchor.id)
      if (item.row) ids.add(item.row.id)
      for (const r of item.attached) ids.add(r.id)
    } else {
      ids.add(item.row.id)
    }
  }
  return ids
}

/** Where the "new messages" line goes for row `rowId`: before the item that
 *  draws it — before the time line right above that item, if one is, so the
 *  time stays with its message. `-1` when no item draws it. */
export function newLineIndex(
  items: readonly MessageItem[],
  rowId: number
): number {
  const i = items.findIndex((item) =>
    item.kind === "time"
      ? false
      : item.kind === "reply"
        ? item.anchor.id === rowId || item.row?.id === rowId
        : item.row.id === rowId
  )
  if (i <= 0) return i
  return items[i - 1].kind === "time" ? i - 1 : i
}
