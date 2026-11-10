"use client"

import { useLayoutEffect, useRef, type RefObject } from "react"

import { takesPendingPlace } from "../reply-motion"

/** On a row that joined the list while it was live: its rail segment, and a
 *  dot's incoming one, grow in from the top (globals.css). */
const ENTER = "data-rail-enter"
/** On the row that was last when rows joined after it: its segment, which
 *  stopped at its own line or body, runs on to them. (A list that ends on a
 *  capsule has its rows join above it: its last row already runs on to it.) */
const EXTEND = "data-rail-extend"
/** With `data-rail-extend`: a body ran beside that row's line when the rows
 *  joined, so only the part past it grows. Taken then, so a panel that closes
 *  meanwhile — a group sliding shut as the reply moves past it — does not
 *  start the segment over. */
const BODY = "data-rail-body"
/** How much longer each row's growth waits than the row above it, so one
 *  join draws down through its rows in turn. */
const STAGGER_MS = 100
/** More rows than this at once are a reveal, not steps joining: drawn as
 *  they stand. */
const MAX_JOIN = 6
/** What the marks start on a row of the list. */
const GROWTH = new Set(["activity-rail-grow", "activity-rail-extend"])
/** The foot a list ends on (timeline-foot.tsx). */
const FOOT = '[data-marker="working"], [data-marker="foot"]'

function unmark(row: Element) {
  row.removeAttribute(ENTER)
  row.removeAttribute(EXTEND)
  row.removeAttribute(BODY)
}

/** Holds back the growth the marks started on `row` (its own and its
 *  segments'). Set on the animations rather than through a custom property on
 *  the row: that would restyle the whole row, every element in it, twice. */
function delayGrowth(row: HTMLElement, ms: number) {
  if (typeof row.getAnimations !== "function") return
  for (const animation of row.getAnimations({ subtree: true })) {
    const name = (animation as Partial<CSSAnimation>).animationName
    const effect = animation.effect as KeyframeEffect | null
    if (!name || !GROWTH.has(name) || effect?.target !== row) continue
    const base = Number(effect.getTiming().delay ?? 0)
    effect.updateTiming({ delay: base + ms })
  }
}

/**
 * Grows a live list's rail down to the steps that join it, instead of drawing
 * each new segment at once. Only rows that join while the list is live and
 * mounted are marked: a reply opened mid-stream, scrolled back into view or
 * unfolded draws its rail as it stands. Rows join through React's DOM inserts,
 * which a MutationObserver reports — never the rows the list mounted with —
 * after the commit and before the frame is painted, so a segment starts from
 * nothing. The one list whose rows join as it mounts is a reply's that takes
 * the pending reply's place (`takesPendingPlace`): the pending reply stood as
 * that list before anything had come. A row's marks go once its growth has
 * run — a row that joined can later be the last one another row follows — and
 * every mark goes when the list settles, so a segment drawn again later (a row
 * opened in history) does not replay. Marks are attributes the stylesheet
 * matches on the row itself, so setting one restyles that row alone, never
 * what is inside it.
 */
export function useRailGrowth(
  listRef: RefObject<HTMLElement | null>,
  live: boolean
) {
  /** The list the marks go on while it is live. */
  const marked = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const list = listRef.current
    if (!live || !list || typeof MutationObserver === "undefined") {
      // Settled: every mark goes, so a segment drawn again later (a row
      // opened in history) does not replay.
      for (const row of marked.current?.children ?? []) unmark(row)
      marked.current = null
      return
    }
    marked.current = list
    const join = (joined: HTMLElement[], extended: HTMLElement[]) => {
      if (joined.length === 0 || joined.length > MAX_JOIN) return
      for (const row of extended) {
        row.setAttribute(EXTEND, "")
        if (row.hasAttribute("data-body")) row.setAttribute(BODY, "")
      }
      for (const row of joined) row.setAttribute(ENTER, "")
      // Top to bottom, the rows a join touched take their turn.
      const rows = [...new Set([...extended, ...joined])]
        .filter((row) => row.parentElement === list)
        .sort((a, b) =>
          a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING
            ? -1
            : 1
        )
      rows.forEach((row, index) => {
        if (index > 0) delayGrowth(row, index * STAGGER_MS)
      })
    }
    const observer = new MutationObserver((records) => {
      const joined: HTMLElement[] = []
      const extended: HTMLElement[] = []
      for (const record of records) {
        const added = [...record.addedNodes].filter(
          (node): node is HTMLElement =>
            node instanceof HTMLElement && node.parentElement === list
        )
        if (added.length === 0) continue
        joined.push(...added)
        // Appended after what was the last row: that row's segment runs on.
        const before = record.previousSibling
        if (record.nextSibling === null && before instanceof HTMLElement) {
          extended.push(before)
        }
      }
      join(joined, extended)
    })
    observer.observe(list, { childList: true })
    // A reply taking the pending reply's place mounts with what has come so
    // far: its rows join the list that stood there, its turning ring alone.
    if (takesPendingPlace(list)) {
      join(
        [...list.children].filter(
          (row): row is HTMLElement =>
            row instanceof HTMLElement && !row.matches(FOOT)
        ),
        []
      )
    }
    // Rows deeper down (a group's members, a live tail) have their own.
    const grown = (event: AnimationEvent) => {
      const row = event.target
      if (
        row instanceof HTMLElement &&
        row.parentElement === list &&
        GROWTH.has(event.animationName)
      ) {
        unmark(row)
      }
    }
    list.addEventListener("animationend", grown)
    // Not the marks: an effect run over again on a list still live (Strict
    // Mode) would take the ones a reply mounted with before they had run.
    return () => {
      observer.disconnect()
      list.removeEventListener("animationend", grown)
    }
  }, [listRef, live])
}
