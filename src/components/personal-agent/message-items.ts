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
 * them is one line that opens to each. Those a turn wrote while it ran cut
 * the turn into parts, where it wrote them (P6): every text the turn said,
 * and the work it handed out, in the order it came — the part with its
 * conclusion (its body) is its reply, each other part with something in it
 * a bubble of its own (`said`). Work handed out
 * makes way for its news once that came (the news draws its pill), but for
 * the newest pill of work under way. Lines that cannot say where (written
 * before lines recorded it) come first. A question or permission request
 * another assistant's brain raised for something that began here (a mirror)
 * is a card of its own.
 *
 * Pure, so it can be tested on rows alone.
 */

import type { ReplyText, TimelineRow } from "@/lib/types"

import {
  conclusionOf,
  turnMarkOf,
  turnTexts,
  WHOLE_TURN,
  type TurnPart,
} from "./turn-texts"

export { turnMarkOf, type TurnMark } from "./turn-texts"

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
      /** The work it draws as pills: its part's, and what its turn handed
       *  out at no recorded step — not work whose news draws it. */
      pills: TimelineRow[]
      /** Its part's pills before any made way, in the order they came
       *  (`partEntries`). */
      partPills: TimelineRow[]
      /** Its part of the turn: the texts it draws. */
      part: TurnPart
      /** It draws the turn's quote: the first of the turn's parts drawn. */
      quote: boolean
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
      /** The pills of its work that made way for it (`yieldedPills`): the
       *  card draws them — what done looks like — instead. */
      pills: TimelineRow[]
    })
  /** A native card codeg wrote itself (a proposal): on the assistants'
   *  side, standing alone. */
  | (ItemBase & { kind: "notice"; row: TimelineRow })
  /** Messages between assistants, in the middle: `row` is the first of
   *  `rows`, a run of lines with nothing between them. */
  | (ItemBase & { kind: "exchange"; row: TimelineRow; rows: TimelineRow[] })
  /** A part of a turn that is not its reply's (P6): what it said and the
   *  work it handed out between the lines it wrote, on the assistant's side.
   *  `row` is the line next to it — the one after it, or for the turn's
   *  last part the one before; `reply` the turn's reply. */
  | (ItemBase & {
      kind: "said"
      row: TimelineRow
      reply: TimelineRow
      batchId: number
      pills: TimelineRow[]
      partPills: TimelineRow[]
      part: TurnPart
      /** Something to draw: a text, or a pill that has not made way. */
      shown: boolean
      quote: boolean
    })
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

/** A routine's run the owner started — the trial right after it was made,
 *  or one they ran now (`data.routine.trigger`): they wait to see what it
 *  finds, nothing new too. */
export function ownerStartedRun(row: TimelineRow): boolean {
  const routine = row.data?.routine
  const trigger =
    routine && typeof routine === "object"
      ? (routine as { trigger?: unknown }).trigger
      : null
  return trigger === "trial" || trigger === "now"
}

/** A reply whose prompt never reached the agent — or a routine's that had
 *  nothing to say (`[[silent]]`, 6.9), on a run that came round by itself:
 *  as if it never was. One the owner started shows, saying nothing was
 *  new. */
export function isDiscarded(row: TimelineRow): boolean {
  if (row.kind !== "reply") return false
  const state = replyState(row)
  return state === "discarded" || (state === "silent" && !ownerStartedRun(row))
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

/** A pill that can make way for its work's news: a plain one, or a
 *  follow-up's that went out — not a check's or a pull request round's,
 *  which say more than the news does, nor one that never went out. */
function givesWay(r: TimelineRow): boolean {
  return (
    r.kind === "dispatch" &&
    r.dispatch_id != null &&
    !isMirror(r) &&
    numIn(r, "check_for") == null &&
    r.data?.pr_fix == null &&
    r.data?.failed !== true
  )
}

/**
 * The pills that make way for their work's news (P6.3 5): a piece of work
 * shows once, not as a pill and its news side by side. Each makes way for
 * the latest news of its work that came after it and is drawn on its own
 * (no check's, nothing folded into a work's head) — wherever either is;
 * a follow-up's pill only for news after it. Work under way (`live`:
 * queued or running) keeps its newest pill, which shows it moving and can
 * stop it — it has news only once it ended, so news before it is an
 * earlier round's.
 *
 * `pillsOf` maps a news row to the pills it draws; `yielded` holds them.
 */
function yieldedPills(
  rows: readonly TimelineRow[],
  foldedIds: ReadonlySet<number>,
  live: ReadonlySet<number>
): { pillsOf: Map<number, TimelineRow[]>; yielded: Set<number> } {
  const kept = new Map<number, number>()
  const latest = new Map<number, number>()
  for (const r of rows) {
    if (r.dispatch_id == null || foldedIds.has(r.id)) continue
    if (givesWay(r) && live.has(r.dispatch_id)) {
      const held = kept.get(r.dispatch_id)
      if (held == null || held < r.id) kept.set(r.dispatch_id, r.id)
    } else if (r.kind === "result" && numIn(r, "check_for") == null) {
      const held = latest.get(r.dispatch_id)
      if (held == null || held < r.id) latest.set(r.dispatch_id, r.id)
    }
  }
  const pillsOf = new Map<number, TimelineRow[]>()
  const yielded = new Set<number>()
  for (const r of rows) {
    if (!givesWay(r) || foldedIds.has(r.id)) continue
    const work = r.dispatch_id!
    if (kept.get(work) === r.id) continue
    const news = latest.get(work)
    if (news == null || news < r.id) continue
    yielded.add(r.id)
    const list = pillsOf.get(news) ?? []
    list.push(r)
    pillsOf.set(news, list)
  }
  return { pillsOf, yielded }
}

/** No work under way. */
const NO_WORK: ReadonlySet<number> = new Set()

/**
 * The list's items. `liveWork`: the work queued or running now (by
 * dispatch id) — its newest pill stays (`yieldedPills`).
 */
export function buildMessageItems(
  rows: readonly TimelineRow[],
  liveWork: ReadonlySet<number> = NO_WORK
): MessageItem[] {
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
  const { pillsOf, yielded } = yieldedPills(rows, foldedIds, liveWork)
  const drawnPill = (r: TimelineRow) =>
    r.kind === "dispatch" && !yielded.has(r.id)
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
  /**
   * A reply's turn, cut by the lines it wrote (P6.3 2): its texts, the work
   * it handed out and its lines in the order they came — by step, a text
   * before a line at its step, two lines at one step by which was written
   * first. The part with the conclusion is the reply (the last while it
   * runs, or when it wrote none); every other part with anything in it is
   * a `said` item. The turn's quote goes on the first part drawn.
   */
  const placeTurn = (
    item: Extract<Placed, { kind: "reply" }>,
    reply: TimelineRow,
    lines: readonly TimelineRow[],
    pills: readonly TimelineRow[]
  ) => {
    const marked = [...lines, ...pills].filter((r) => turnMarkOf(r) != null)
    const texts = turnTexts(reply, undefined, marked)
    type Entry =
      | { n: number; text: true; row: null }
      | { n: number; text: false; row: TimelineRow }
    const entries: Entry[] = [
      ...texts.map((t): Entry => ({ n: t.n, text: true, row: null })),
      ...marked.map(
        (r): Entry => ({ n: turnMarkOf(r)!.n, text: false, row: r })
      ),
    ].sort(
      (a, b) =>
        a.n - b.n ||
        (a.text === b.text ? 0 : a.text ? -1 : 1) ||
        (a.row?.id ?? 0) - (b.row?.id ?? 0)
    )
    interface Part {
      lo: number
      hi: number
      texts: number[]
      pills: TimelineRow[]
      /** The line right after it; `null` for the last part. */
      next: TimelineRow | null
      /** The line right before it. */
      prev: TimelineRow | null
    }
    const parts: Part[] = []
    let cur: Part = {
      lo: -Infinity,
      hi: Infinity,
      texts: [],
      pills: [],
      next: null,
      prev: null,
    }
    for (const e of entries) {
      if (e.text) cur.texts.push(e.n)
      else if (e.row.kind === "exchange") {
        cur.hi = e.n
        cur.next = e.row
        parts.push(cur)
        cur = {
          lo: e.n,
          hi: Infinity,
          texts: [],
          pills: [],
          next: null,
          prev: e.row,
        }
      } else cur.pills.push(e.row)
    }
    parts.push(cur)
    const conclusion = conclusionOf(reply)
    const found =
      conclusion == null
        ? -1
        : parts.findIndex((p) => p.texts.includes(conclusion))
    const replyAt = found >= 0 ? found : parts.length - 1
    const unmarkedLines = lines.filter((r) => turnMarkOf(r) == null)
    const unmarkedPills = pills.filter((r) => turnMarkOf(r) == null)
    const turnItems: Extract<Placed, { kind: "reply" | "said" }>[] = []
    const before = prev?.item ?? null
    // Lines from before lines said where: first, as they always came
    // before the reply (a turn's lines say where, or none do).
    for (const line of unmarkedLines) place(exchange([line]))
    parts.forEach((p, i) => {
      const part: TurnPart = { lo: p.lo, hi: p.hi, lines: marked }
      if (i === replyAt) {
        item.part = part
        const all = [...p.pills, ...unmarkedPills]
        item.pills = all.filter(drawnPill)
        item.partPills = all
        place(item)
        turnItems.push(item)
      } else if (p.texts.length > 0 || p.pills.length > 0) {
        // Kept while its pills make way, drawn empty: the lines round it
        // stay apart, and what is open on them stays open.
        const drawn = p.pills.filter(drawnPill)
        const line = (p.next ?? p.prev)!
        const said: Extract<Placed, { kind: "said" }> = {
          kind: "said",
          key: p.next ? `s${p.next.id}` : `sa${line.id}`,
          gap: "side",
          tail: false,
          quotesPrevious: false,
          row: line,
          reply,
          batchId: reply.batch_id!,
          pills: drawn,
          partPills: p.pills,
          part,
          shown: p.texts.length > 0 || drawn.length > 0,
          quote: false,
        }
        place(said)
        turnItems.push(said)
      }
      if (p.next) place(exchange([p.next]))
    })
    // The turn's quote, once: on its first part drawn — left out when what
    // it quotes is right above the turn.
    item.quote = false
    const first = turnItems.find((t) => t.kind === "reply" || t.shown) ?? item
    first.quote = true
    const quoted = reply.reply_to
    first.quotesPrevious =
      quoted != null && before != null && quotableIds(before).includes(quoted)
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
        pills: pillsOf.get(r.id) ?? [],
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
      const attached = b != null ? (attachedByBatch.get(b) ?? []) : []
      const reply: Extract<Placed, { kind: "reply" }> = {
        kind: "reply",
        key: `r${r.id}`,
        gap: "side",
        tail: false,
        quotesPrevious: false,
        row: r,
        anchor: r,
        batchId: b,
        attached,
        owners: b != null ? (ownersByBatch.get(b) ?? []) : [],
        pills: attached.filter(drawnPill),
        partPills: attached.filter((a) => a.kind === "dispatch"),
        part: WHOLE_TURN,
        quote: true,
      }
      if (b != null) {
        placeTurn(
          reply,
          r,
          exchangesByBatch.get(b) ?? [],
          attached.filter((a) => a.kind === "dispatch")
        )
      } else {
        place(reply)
      }
      continue
    } else if (GROUPED_KINDS.has(r.kind)) {
      const b = r.batch_id
      // Drawn in its turn's reply, or at its turn's first card.
      if (b != null && replyByBatch.has(b)) continue
      const group = b != null ? (attachedByBatch.get(b) ?? [r]) : [r]
      if (group[0].id !== r.id) continue
      // Without the pills that made way: drawn at the first row left — as
      // the same item still, so what is open in it stays open.
      const left = group.filter((g) => g.kind !== "dispatch" || drawnPill(g))
      if (left.length === 0) continue
      item = {
        kind: "reply",
        key: `r${r.id}`,
        gap: "side",
        tail: false,
        quotesPrevious: false,
        row: null,
        anchor: left[0],
        batchId: b,
        attached: left,
        owners: b != null ? (ownersByBatch.get(b) ?? []) : [],
        pills: left.filter((g) => g.kind === "dispatch"),
        partPills: group.filter((g) => g.kind === "dispatch"),
        part: WHOLE_TURN,
        quote: true,
      }
    }
    if (item) place(item)
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

/** One thing a part of a turn draws, in the order it came: a run, or the
 *  work handed out between two runs — by its first pill before any made
 *  way, which keeps its "N more" open as pills move to another part or
 *  make way. */
export type PartEntry =
  | { kind: "text"; run: ReplyText }
  | { kind: "pills"; group: number; rows: TimelineRow[] }

/**
 * What a part draws, in step order (P6.3): its runs (`texts`) and its
 * pills (`pills`, before any made way; those drawn, `drawn`) — a run
 * before a pill at its step. A group whose pills all made way is left out.
 */
export function partEntries(
  texts: readonly ReplyText[],
  pills: readonly TimelineRow[],
  drawn: readonly TimelineRow[]
): PartEntry[] {
  const shown = new Set(drawn.map((r) => r.id))
  const order = [
    ...texts.map((t) => ({ n: t.n, text: t, row: null })),
    ...pills.map((r) => ({
      n: turnMarkOf(r)?.n ?? Infinity,
      text: null,
      row: r,
    })),
  ].sort(
    (a, b) =>
      a.n - b.n ||
      (a.text ? 0 : 1) - (b.text ? 0 : 1) ||
      (a.row?.id ?? 0) - (b.row?.id ?? 0)
  )
  const out: PartEntry[] = []
  let group: Extract<PartEntry, { kind: "pills" }> | null = null
  for (const e of order) {
    if (e.text) {
      group = null
      out.push({ kind: "text", run: e.text })
      continue
    }
    if (!group) {
      group = { kind: "pills", group: e.row!.id, rows: [] }
      out.push(group)
    }
    if (shown.has(e.row!.id)) group.rows.push(e.row!)
  }
  return out.filter((e) => e.kind === "text" || e.rows.length > 0)
}

/** The row ids an item draws (a turn's cards included): what a jump can
 *  land on. */
export function itemRowIds(item: MessageItem): number[] {
  if (item.kind === "time") return []
  // A part of a turn: the work it draws (its text is the reply's).
  if (item.kind === "said") return item.pills.map((r) => r.id)
  if (item.kind === "reply") {
    // Its pills only — another part's are that part's, and a pill that made
    // way is its news's.
    return [
      ...new Set([
        item.anchor.id,
        ...(item.row ? [item.row.id] : []),
        ...item.attached.filter((r) => r.kind !== "dispatch").map((r) => r.id),
        ...item.pills.map((r) => r.id),
      ]),
    ]
  }
  if (item.kind === "exchange") return item.rows.map((r) => r.id)
  if (item.kind === "event") {
    return [
      item.row.id,
      // What its acceptance folded into it (A4), and the pills it draws.
      ...(item.acceptance ? item.acceptance.rows.map((r) => r.id) : []),
      ...item.pills.map((r) => r.id),
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
 *  draws it — for a reply, before its turn's first part or line (and a time
 *  line between them; a run of lines the turn's are in, whole) — and before
 *  the time line right above, if one is, so the time stays with its
 *  message. `-1` when no item draws it. */
export function newLineIndex(
  items: readonly MessageItem[],
  rowId: number
): number {
  let i = items.findIndex((item) =>
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
  const found = items[i]
  if (found?.kind === "reply" && found.row != null && found.batchId != null) {
    const batch = found.batchId
    const ofTurn = (item: MessageItem | undefined) =>
      (item?.kind === "said" && item.batchId === batch) ||
      (item?.kind === "exchange" && item.rows.some((r) => r.batch_id === batch))
    while (i > 0) {
      if (ofTurn(items[i - 1])) i--
      else if (items[i - 1].kind === "time" && ofTurn(items[i - 2])) i--
      else break
    }
  }
  if (i <= 0) return i
  return items[i - 1].kind === "time" ? i - 1 : i
}
