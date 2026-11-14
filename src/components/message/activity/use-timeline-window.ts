"use client"

import {
  createContext,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react"

/**
 * Draws a long list of steps a stretch at a time: the rows near the view, and
 * in place of the rest a spacer as tall as they are, so the list keeps its
 * height and the rail runs on through it. A reply of hundreds or thousands of
 * steps then costs what a screenful of them does — to draw, to restyle while it
 * streams, and for the reply's motion to measure — and all of it is a scroll
 * away, where it used to sit behind a "show more" fold.
 *
 * The transcript's virtual list draws the reply as one of its rows; this goes
 * on inside that row, against the same scroll port.
 *
 * Heights: a row's is measured once it has been drawn (a `ResizeObserver`) and
 * kept by its key, so a stretch scrolled away and back, or a reply the
 * transcript drew again, comes back at the height it had; a row never drawn
 * stands in at an estimate. Two things keep the view still where those
 * disagree: a stretch drawn above the view moves the view by what it came out
 * taller or shorter than estimated (the anchor), and a drawn row above the view
 * that changes height moves it by as much — as the transcript's virtual list
 * does for its own rows — except at the bottom, which the transcript keeps in
 * view itself.
 */

/** Past this many rows a list is drawn a stretch at a time: an agent loop of
 *  hundreds or thousands of calls costs what a screenful of its rows does. */
export const WINDOWED_ROWS = 100

/** A row of a windowed list: the timeline's items, a group's members. */
export interface WindowRow {
  key: string
}

/**
 * A step a timeline was asked to draw (its failure link) that sits in a group's
 * members: the timeline draws the group, and the group's own windowed members
 * draw the step — told so now if they are drawn, or as they mount. One per
 * reply's timeline, handed down by `TimelineRevealContext`.
 */
export class RevealRequests {
  /** The step asked for and not drawn yet. */
  private wanted: string | null = null
  /** Members lists drawn now, to be told of a request. */
  private readonly listeners = new Set<() => void>()

  /** Ask for the step `key` to be drawn by whichever members list holds it;
   *  null withdraws the last ask. */
  ask(key: string | null) {
    this.wanted = key
    if (key === null) return
    for (const listener of [...this.listeners]) listener()
  }

  /** The step asked for, when `holds` has it: the ask is answered. */
  take(holds: (key: string) => boolean): string | null {
    const wanted = this.wanted
    if (wanted === null || !holds(wanted)) return null
    this.wanted = null
    return wanted
  }

  listen(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

export const TimelineRevealContext = createContext<RevealRequests | null>(null)

/** What a windowed list draws: rows `[start, end)`, and the spacers that stand
 *  for the rows before and after them (px, each spacer's own height). */
export interface TimelineWindow {
  start: number
  end: number
  before: number
  after: number
}

/** What a list's rows are laid out with, read off the list once it is drawn. */
export interface ListMetrics {
  /** The root font size: rows are sized in rem. */
  rem: number
  /** The margin between two rows. */
  gap: number
  /** The list's own padding above its first row. */
  padTop: number
  /** The width a row's content wraps in. */
  width: number
}

/** The view, extended this far (of its height) both ways, is drawn. */
const OVERSCAN_VIEWPORTS = 0.75
/** …and never less than this (px). */
const MIN_OVERSCAN_PX = 320
/** Rows drawn before the first measure places the list. */
const INITIAL_ROWS = 40
/** Rows drawn either side of one revealed (`reveal`) until the view settles. */
const REVEAL_ROWS = 15

const DEFAULT_METRICS: ListMetrics = { rem: 16, gap: 8, padTop: 0, width: 640 }

/** Measured row heights (px) by `<scope>\u0000<row key>` — kept across the
 *  list mounting again (the transcript recycling the reply, a fold and
 *  unfold), so the spacers stand for a stretch at the height it was drawn at.
 *  Scoped by the kind of list: a group shares its first member's key, and a
 *  timeline row holding a whole group is not as tall as that member's row. */
const measuredHeights = new Map<string, number>()
const MEASURED_HEIGHTS_MAX = 20_000

function rememberHeight(key: string, height: number) {
  measuredHeights.delete(key)
  measuredHeights.set(key, height)
  if (measuredHeights.size > MEASURED_HEIGHTS_MAX) {
    measuredHeights.delete(measuredHeights.keys().next().value!)
  }
}

function sameMetrics(a: ListMetrics, b: ListMetrics) {
  return (
    Math.abs(a.rem - b.rem) < 0.01 &&
    Math.abs(a.gap - b.gap) < 0.01 &&
    Math.abs(a.padTop - b.padTop) < 0.01 &&
    Math.abs(a.width - b.width) < 1
  )
}

/** Where each list scrolls, found once per list element (its ancestors do not
 *  change while it is mounted; React never moves it to another parent). */
const scrollPorts = new WeakMap<Element, HTMLElement | null>()

/**
 * The scroll port the list scrolls in: the transcript's; else the nearest
 * ancestor that scrolls on its own — a transcript drawn outside the virtual
 * list, as the sub-agent drawer draws one, scrolls in a plain overflowing box
 * whose scrolling the page never hears of; else the page.
 */
function scrollPortOf(list: Element): HTMLElement | null {
  let port = scrollPorts.get(list)
  if (port !== undefined) return port
  port = list.closest<HTMLElement>(".chat-scroll-port")
  if (!port) {
    for (let node = list.parentElement; node; node = node.parentElement) {
      if (node === document.body || node === document.documentElement) break
      const overflowY = getComputedStyle(node).overflowY
      if (
        overflowY === "auto" ||
        overflowY === "scroll" ||
        overflowY === "overlay"
      ) {
        port = node
        break
      }
    }
  }
  port ??= null
  // Detached, it has no ancestors to go by yet: ask again once it has.
  if (list.isConnected) scrollPorts.set(list, port)
  return port
}

/**
 * Whether the hook keeps the view still in `port` itself (see the observer and
 * the anchor below): where the browser does not — the transcript's port turns
 * its anchoring off (`overflow-anchor: none`), WebKit has none. Where it does,
 * moving the view here too would move it twice.
 */
function holdsViewIn(port: HTMLElement): boolean {
  let holds = selfAnchored.get(port)
  if (holds === undefined) {
    holds = getComputedStyle(port).overflowAnchor !== "auto"
    selfAnchored.set(port, holds)
  }
  return holds
}
const selfAnchored = new WeakMap<HTMLElement, boolean>()

function viewOf(port: HTMLElement | null) {
  if (port) {
    const rect = port.getBoundingClientRect()
    return { top: rect.top, bottom: rect.bottom, height: rect.height }
  }
  return {
    top: 0,
    bottom: globalThis.innerHeight,
    height: globalThis.innerHeight,
  }
}

/** Whether the element drawn as `stepKey` belongs to the row `key`: a row is
 *  one `li` (a step's, a group's) or several (a step listing background tasks,
 *  each keyed `<step>:<task>`). */
function belongsTo(key: string, stepKey: string): boolean {
  return stepKey === key || stepKey.startsWith(`${key}:`)
}

/** The drawn elements of each row of `rows[start, end)`, by row key. */
function rowElements<T extends WindowRow>(
  list: HTMLElement,
  rows: readonly T[],
  start: number,
  end: number
): Map<string, HTMLElement[]> {
  const out = new Map<string, HTMLElement[]>()
  let index = start
  for (const child of list.children) {
    if (!(child instanceof HTMLElement)) continue
    const stepKey = child.dataset.stepKey
    if (stepKey === undefined) continue
    while (index < end && !belongsTo(rows[index]!.key, stepKey)) index += 1
    if (index >= end) break
    const key = rows[index]!.key
    const elements = out.get(key)
    if (elements) elements.push(child)
    else out.set(key, [child])
  }
  return out
}

/** A row's height as drawn: its first element's top to its last's bottom. */
function extentOf(elements: HTMLElement[]): number {
  const first = elements[0]!.getBoundingClientRect()
  if (elements.length === 1) return first.height
  return (
    elements[elements.length - 1]!.getBoundingClientRect().bottom - first.top
  )
}

/** Observe the drawn rows of `list` (observing one twice is a no-op). */
function observeRows(list: HTMLElement | null, ro: ResizeObserver | null) {
  if (!list || !ro) return
  for (const child of list.children) {
    if (child instanceof HTMLElement && child.dataset.stepKey !== undefined) {
      ro.observe(child)
    }
  }
}

/** On a list drawn a stretch at a time, for a list nested in one of its rows
 *  to find it (`heldAbove`). */
const WINDOWED = "data-windowed"
/** On a row of the transcript's virtual list (`VirtualizedMessageThread`). */
const THREAD_ROW = "data-thread-row"

/**
 * Whether something holding the list may keep the view still for it, so that
 * moving it here too could move it twice:
 *
 * - the row of an outer windowed list it sits in, entirely above the view —
 *   that list's observer moves the view by however much the row changed;
 * - the transcript's row ending above the view's bottom. virtua moves the view
 *   for a row entirely above it, and while the view scrolls down for one that
 *   starts above it and ends inside it. Only a row reaching past both edges is
 *   never moved for: a long reply read in its middle.
 */
function heldAbove(
  list: Element,
  view: { top: number; bottom: number }
): boolean {
  for (let node = list.parentElement; node; node = node.parentElement) {
    if (node.hasAttribute(THREAD_ROW)) {
      return node.getBoundingClientRect().bottom <= view.bottom
    }
    if (
      node.parentElement?.hasAttribute(WINDOWED) &&
      node.getBoundingClientRect().bottom <= view.top
    ) {
      return true
    }
  }
  return false
}

export function useTimelineWindow<T extends WindowRow>({
  listRef,
  scope,
  rows,
  estimate,
  follow,
}: {
  listRef: RefObject<HTMLElement | null>
  /** The kind of list (a timeline's rows, a group's members): the heights it
   *  measures are kept apart from another kind's, whose keys may be the same.
   *  Must be stable. */
  scope: string
  /** The list's rows, or null while it is drawn whole. */
  rows: readonly T[] | null
  /** A row's height (px) before it has been drawn. Must be stable. */
  estimate: (row: T, metrics: ListMetrics) => number
  /** The list is live: rows join at its end, and a view resting there keeps
   *  drawing them as they join. */
  follow: boolean
}): {
  span: TimelineWindow | null
  /** Draw the row at `index` and — unless `scroll` is false, for a row that
   *  something inside it scrolls to — scroll it into the middle of the view. */
  reveal: (index: number, scroll?: boolean) => void
} {
  const [range, setRange] = useState<{
    start: number
    end: number
    /** The rows there were when it was placed: a range reaching their end
     *  takes the rows that join after them. */
    total: number
  } | null>(null)
  const [metrics, setMetrics] = useState<ListMetrics>(DEFAULT_METRICS)
  // Drawn whole again, the list forgets where its window was.
  if (rows === null && range !== null) setRange(null)

  const count = rows?.length ?? 0
  let start = 0
  let end = count
  if (rows) {
    if (!range) {
      if (follow) start = Math.max(0, count - INITIAL_ROWS)
      else end = Math.min(count, INITIAL_ROWS)
    } else {
      end = range.end >= range.total ? count : Math.min(range.end, count)
      start = Math.min(range.start, Math.max(0, end - 1))
    }
  }

  const heightOf = useCallback(
    (row: T) =>
      measuredHeights.get(`${scope}\u0000${row.key}`) ?? estimate(row, metrics),
    [scope, estimate, metrics]
  )

  let span: TimelineWindow | null = null
  if (rows) {
    let before = 0
    for (let i = 0; i < start; i++) before += heightOf(rows[i]!)
    if (start > 0) before += (start - 1) * metrics.gap
    let after = 0
    for (let i = end; i < count; i++) after += heightOf(rows[i]!)
    if (end < count) after += (count - end - 1) * metrics.gap
    span = { start, end, before, after }
  }

  // The latest of what the listeners below read, mirrored after each commit:
  // they run on scroll and resize, outside render.
  const latest = useRef({ rows, start, end, heightOf, metrics })
  useLayoutEffect(() => {
    latest.current = { rows, start, end, heightOf, metrics }
  })

  /** A drawn row in view as the window moves up, and where it was: the view
   *  goes back to where it was against it once the move is drawn. */
  const anchor = useRef<{ key: string; top: number } | null>(null)
  /** A row `reveal` asked for, to scroll into view once it is drawn. */
  const revealing = useRef<string | null>(null)

  const update = useCallback(() => {
    const list = listRef.current
    const { rows, start, end, heightOf, metrics } = latest.current
    if (!list || !rows || rows.length === 0) return
    const listRect = list.getBoundingClientRect()
    // Not laid out (a tab kept alive out of sight): nothing to place it by.
    if (listRect.height === 0) return
    const view = viewOf(scrollPortOf(list))
    const listTop = listRect.top + metrics.padTop
    const overscan = Math.max(MIN_OVERSCAN_PX, view.height * OVERSCAN_VIEWPORTS)
    const from = view.top - listTop - overscan
    const to = view.bottom - listTop + overscan
    const total = rows.length
    let first = -1
    let last = total
    let offset = 0
    for (let i = 0; i < total; i++) {
      const height = heightOf(rows[i]!)
      if (first < 0 && offset + height >= from) first = i
      if (offset > to) {
        last = i
        break
      }
      offset += height + metrics.gap
    }
    if (first < 0) first = total - 1
    if (last <= first) last = first + 1
    if (first === start && last === end) return
    if (first < start) {
      // Rows come in above what is drawn — the view moving up — at their own
      // height, which may not be what the spacer stood for: hold on to the
      // first drawn row in view, to keep it where it is once they have.
      // (Moving down, rows go above at the height they were drawn at, and
      // virtua may be moving the view for the reply itself.)
      const drawn = rowElements(list, rows, start, end)
      for (let i = start; i < end; i++) {
        const elements = drawn.get(rows[i]!.key)
        if (!elements) continue
        const rect = elements[0]!.getBoundingClientRect()
        if (rect.bottom > view.top) {
          anchor.current = { key: rows[i]!.key, top: rect.top }
          break
        }
      }
    }
    setRange({ start: first, end: last, total })
  }, [listRef])

  // Once a move is drawn: the view back against its anchor, or onto the row
  // `reveal` asked for.
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list || !rows) {
      anchor.current = null
      revealing.current = null
      return
    }
    const port = scrollPortOf(list)
    const target = revealing.current
    if (target !== null) {
      revealing.current = null
      anchor.current = null
      rowElements(list, rows, start, end)
        .get(target)?.[0]
        ?.scrollIntoView({ block: "center" })
      return
    }
    const held = anchor.current
    if (!held) return
    anchor.current = null
    const elements = rowElements(list, rows, start, end).get(held.key)
    if (!elements || !port || !holdsViewIn(port)) return
    const moved = elements[0]!.getBoundingClientRect().top - held.top
    if (Math.abs(moved) >= 0.5) port.scrollTop += moved
  }, [listRef, rows, start, end])

  // What the list is laid out with, once it is drawn and as it changes.
  const measureList = useCallback(() => {
    const list = listRef.current
    if (!list) return
    const rem =
      Number.parseFloat(getComputedStyle(document.documentElement).fontSize) ||
      DEFAULT_METRICS.rem
    const padTop = Number.parseFloat(getComputedStyle(list).paddingTop) || 0
    let gap = latest.current.metrics.gap
    for (const child of list.children) {
      if (!(child instanceof HTMLElement) || !child.previousElementSibling) {
        continue
      }
      const margin = Number.parseFloat(getComputedStyle(child).marginTop)
      if (Number.isFinite(margin) && margin > 0) {
        gap = margin
        break
      }
    }
    const width = list.clientWidth || DEFAULT_METRICS.width
    const next = { rem, gap, padTop, width }
    setMetrics((current) => (sameMetrics(current, next) ? current : next))
  }, [listRef])

  const windowed = rows !== null
  // Placed against the view before it is first painted: a list that mounts
  // with its end in view (the transcript jumping to its bottom) must not show
  // a frame of spacer there.
  useLayoutEffect(() => {
    if (!windowed) return
    // Measuring is what this is for: the list's layout, read once it is laid
    // out, before it is painted.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    measureList()
    update()
  }, [windowed, measureList, update])

  // A change of rows (one joining, a stretch drawn) is placed against the view
  // a frame later, once laid out.
  useEffect(() => {
    if (!windowed) return
    const frame = requestAnimationFrame(update)
    return () => cancelAnimationFrame(frame)
  }, [windowed, rows, start, end, update])

  // Scrolling and resizing move the view over the list.
  useEffect(() => {
    const list = listRef.current
    if (!windowed || !list) return
    const port = scrollPortOf(list)
    let frame: number | null = null
    const schedule = () => {
      if (frame !== null) return
      frame = requestAnimationFrame(() => {
        frame = null
        update()
      })
    }
    const scroller: HTMLElement | Window = port ?? globalThis.window
    scroller.addEventListener("scroll", schedule, { passive: true })
    const resize =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            measureList()
            schedule()
          })
    resize?.observe(list)
    if (port) resize?.observe(port)
    else globalThis.addEventListener("resize", schedule)
    return () => {
      scroller.removeEventListener("scroll", schedule)
      globalThis.removeEventListener("resize", schedule)
      resize?.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [windowed, listRef, update, measureList])

  // Each drawn row's height, kept by its key; a drawn row above the view that
  // changes height moves the view by as much. Set up as the list is laid out,
  // so the rows it mounts with are observed without waiting for a commit.
  const observer = useRef<ResizeObserver | null>(null)
  useLayoutEffect(() => {
    if (!windowed || typeof ResizeObserver === "undefined") return
    const sizes = new Map<Element, number>()
    const ro = new ResizeObserver((entries) => {
      const list = listRef.current
      const { rows, start, end } = latest.current
      if (!list || !rows) return
      // Out of sight (a tab kept alive hidden): nothing is laid out, and
      // nothing is to be measured or moved. Shown again, its rows report
      // their sizes afresh rather than as having changed.
      if (list.getBoundingClientRect().height === 0) {
        sizes.clear()
        return
      }
      const port = scrollPortOf(list)
      const view = viewOf(port)
      const atBottom =
        !port || port.scrollHeight - port.scrollTop - port.clientHeight < 2
      const moves = !atBottom && !heldAbove(list, view)
      const changed: { rect: DOMRect; was: number | undefined }[] = []
      for (const entry of entries) {
        const element = entry.target
        // Gone with a stretch scrolled away: nothing of the view moved.
        if (!element.isConnected || element.parentElement !== list) {
          ro.unobserve(element)
          sizes.delete(element)
          continue
        }
        const rect = element.getBoundingClientRect()
        changed.push({ rect, was: sizes.get(element) })
        sizes.set(element, rect.height)
      }
      // Each row placed where it was before the batch — its top less what the
      // rows above it in the batch grew by — and moved for if its bottom was
      // above the view then: a row that grows down across the view's top
      // pushes what was in view down all the same, and one that a shrinking
      // row above has pulled up was not above the view for that.
      changed.sort((a, b) => a.rect.top - b.rect.top)
      let moved = 0
      let shift = 0
      for (const { rect, was } of changed) {
        if (was === undefined) continue
        const grew = rect.height - was
        if (moves && rect.top - shift + was <= view.top) moved += grew
        shift += grew
      }
      for (const [key, elements] of rowElements(list, rows, start, end)) {
        rememberHeight(`${scope}\u0000${key}`, extentOf(elements))
      }
      if (port && Math.abs(moved) >= 0.5 && holdsViewIn(port)) {
        port.scrollTop += moved
      }
    })
    observer.current = ro
    observeRows(listRef.current, ro)
    return () => {
      ro.disconnect()
      observer.current = null
    }
  }, [windowed, listRef, scope])
  // Observe what each commit drew.
  useLayoutEffect(() => {
    observeRows(listRef.current, observer.current)
  })

  const reveal = useCallback((index: number, scroll = true) => {
    const { rows } = latest.current
    if (!rows || index < 0 || index >= rows.length) return
    revealing.current = scroll ? rows[index]!.key : null
    setRange({
      start: Math.max(0, index - REVEAL_ROWS),
      end: Math.min(rows.length, index + REVEAL_ROWS + 1),
      total: rows.length,
    })
  }, [])

  return { span, reveal }
}
