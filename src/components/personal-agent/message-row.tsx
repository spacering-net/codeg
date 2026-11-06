"use client"

/**
 * The frame every message in the list sits in: the assistant's on the left,
 * the owner's on the right, the news cards from the assistants that ran
 * handed-out work on the left too — none with an avatar beside it (the
 * page's own assistant is in the title, and a card names its speaker inside
 * it).
 *
 * Messages on one side sit 4px apart, whoever speaks them, and hold
 * together at their corners on that side (`bubbleCorners`); the other side
 * starts 32px down — the room for the actions of the message above it, the
 * last on its side (all in rem, so app zoom keeps the proportions):
 * - its actions (time, quote, copy, stop) float under the bubble on hover,
 *   a little apart from it, in that room — showing them moves nothing. The
 *   messages before it in its side's stretch, too close to what follows to
 *   have them float over it, show none on hover; keyboard focus shows
 *   anyone's, over what is below.
 * - a right-click on any bubble (a long press, on touch) opens the same
 *   actions as a menu, ringing the bubble while it is open.
 * - a mark it always shows (unread) sits beside the bubble's foot, on the
 *   side toward the middle of the list, so it comes and goes without moving
 *   a line;
 * - a state that stays (the owner's message that never finished, with the
 *   way to send it again) is a line under the bubble, in the flow.
 * A divider (a time, the "new messages" line) keeps as much room under it as
 * over it, and the message under it starts right there.
 */

import { useRef, useState } from "react"

import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu"
import { cn } from "@/lib/utils"

import {
  MessageActions,
  MessageMenu,
  type MessageActionsSpec,
} from "./message-actions"
import type { MessageGap } from "./message-items"

/**
 * A bubble's corners: round — past half a one-line bubble's height (10px of
 * padding around a 20px line, and a hairline), so the browser clamps them to
 * a capsule while a message is one line, and a longer one keeps the same
 * round corners — but tight on its speaker's side where a run on that side
 * holds together: at the top of every bubble, and at the foot of all but
 * the last before the other side (`tail`), which closes the run round. In
 * rem, so app zoom keeps them.
 */
export function bubbleCorners(side: "start" | "end", tail: boolean): string {
  return cn(
    "rounded-[1.375rem]",
    side === "start" ? "rounded-ss-[0.375rem]" : "rounded-se-[0.375rem]",
    !tail &&
      (side === "start" ? "rounded-es-[0.375rem]" : "rounded-ee-[0.375rem]")
  )
}

/** The room above, in rem (Tailwind's spacing): the "side" one holds the
 *  actions over it (6px apart from their bubble, 24px tall) with a little
 *  to spare. */
const GAP: Record<MessageGap, string> = {
  near: "mt-1",
  side: "mt-8",
}

/** On hover (or keyboard focus anywhere in the message), for the last on
 *  its side. */
const SHOWN_ON_HOVER =
  "group-hover/msg:pointer-events-auto group-hover/msg:opacity-100 group-has-[:focus-visible]/msg:pointer-events-auto group-has-[:focus-visible]/msg:opacity-100"
/** On keyboard focus in the bar itself, for the others. */
const SHOWN_ON_FOCUS =
  "has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100"

/** How long after a right button's press its menu still counts as opened
 *  by it (macOS opens it on the press, others on the release). */
const PRESS_MS = 2000

/** The selection's range over `el`, or `null` when none of it is
 *  selected. */
function selectionIn(el: HTMLElement): Range | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed) return null
  for (let i = 0; i < selection.rangeCount; i++) {
    const range = selection.getRangeAt(i)
    if (range.intersectsNode(el)) return range
  }
  return null
}

/** The text selected in `el`, or "" when none of it is. */
function selectedIn(el: HTMLElement): string {
  return selectionIn(el) ? window.getSelection()!.toString() : ""
}

export function MessageRow({
  rowId,
  side,
  gap,
  tail,
  roomy,
  actions,
  aside,
  below,
  children,
}: {
  rowId: number
  side: "start" | "end"
  /** The room above it. */
  gap: MessageGap
  /** The last on its side before the other side, a line or the end: its
   *  actions show on hover. */
  tail: boolean
  /** It holds a card (a news card's work row): at least a card's width
   *  (never past the column's share), however short its text. */
  roomy?: boolean
  /** What its actions act on: the bar under it, and its bubble's menu. */
  actions?: MessageActionsSpec
  /** A mark beside the bubble's foot, toward the middle (unread). */
  aside?: React.ReactNode
  /** A line under the bubble, in the flow (a state that stays). */
  below?: React.ReactNode
  /** The bubble. */
  children: React.ReactNode
}) {
  // What of the bubble was selected when its menu opened, to copy, and
  // where, to show it selected while the menu is open.
  const [selection, setSelection] = useState("")
  const selectedRange = useRef<Range | null>(null)
  // The selection as a right button's press found it, before the press
  // could change it.
  const press = useRef<{ at: number; text: string } | null>(null)
  // The menu opens from our contextmenu handler (rather than a long press).
  const fromEvent = useRef(false)

  const frame = (
    <div
      data-pa-frame
      className={cn(
        "relative min-w-0",
        side === "start" ? "max-w-[88%]" : "max-w-[80%]",
        // Against the row's width, which is the column's: a definite
        // share, unlike the bubble's own fit-to-content width.
        roomy &&
          (side === "start"
            ? "min-w-[min(22rem,88%)]"
            : "min-w-[min(22rem,80%)]")
      )}
      onPointerDownCapture={
        actions
          ? (event) => {
              if (event.button === 2 || (event.button === 0 && event.ctrlKey))
                press.current = {
                  at: performance.now(),
                  text: selectedIn(event.currentTarget),
                }
            }
          : undefined
      }
      onContextMenu={
        actions
          ? (event) => {
              // A link's or an image's own menu has it.
              if (event.defaultPrevented) return
              const now = selectedIn(event.currentTarget)
              const pressed = press.current
              press.current = null
              const before =
                pressed && performance.now() - pressed.at < PRESS_MS
                  ? pressed.text
                  : null
              if (before != null && now !== before) {
                // The press selected the word under the pointer (macOS
                // does, for the system's menu, which this one replaces):
                // not the owner's selection, so it goes.
                if (now) window.getSelection()?.removeAllRanges()
                setSelection("")
                selectedRange.current = null
              } else {
                setSelection(now)
                selectedRange.current = now
                  ? (selectionIn(event.currentTarget)?.cloneRange() ?? null)
                  : null
              }
              fromEvent.current = true
            }
          : undefined
      }
    >
      {children}
      {aside ? (
        <div
          data-pa-aside
          className={cn(
            "absolute bottom-0.5 flex whitespace-nowrap",
            side === "start" ? "start-full ms-2" : "end-full me-2"
          )}
        >
          {aside}
        </div>
      ) : null}
    </div>
  )

  return (
    <div
      data-row-id={rowId}
      className={cn(
        "group/msg relative flex min-w-0 flex-col",
        side === "start" ? "items-start" : "items-end",
        GAP[gap],
        "[[data-pa-divider]+&]:mt-0"
      )}
    >
      {actions ? (
        <ContextMenu
          onOpenChange={(open) => {
            // A long press opens it with no contextmenu event of ours: no
            // selection to offer.
            if (open && !fromEvent.current) {
              setSelection("")
              selectedRange.current = null
            }
            if (!open) selectedRange.current = null
            fromEvent.current = false
          }}
        >
          <ContextMenuTrigger asChild>{frame}</ContextMenuTrigger>
          <MessageMenu
            spec={actions}
            selection={selection}
            onFocusInside={() => {
              // WebKit drops the page's selection whenever focus moves to
              // an element outside it — the menu, each item the pointer or
              // the arrow keys reach — before the focus lands: put it back,
              // so what the menu offers to copy stays marked.
              const range = selectedRange.current
              const page = window.getSelection()
              if (!range || !page || !page.isCollapsed) return
              page.removeAllRanges()
              page.addRange(range)
            }}
          />
        </ContextMenu>
      ) : (
        frame
      )}
      {below}
      {actions ? (
        <div
          data-pa-actions
          className={cn(
            // `pt-1.5`: apart from the bubble, and a bridge the pointer
            // crosses to reach them without leaving the message.
            "pointer-events-none absolute top-full z-20 flex pt-1.5 opacity-0 transition-opacity duration-150",
            // Keyboard focus, not a click: a clicked button keeps focus,
            // and the actions would stay over the message below.
            tail ? SHOWN_ON_HOVER : SHOWN_ON_FOCUS,
            side === "start" ? "start-0" : "end-0"
          )}
        >
          <MessageActions {...actions} side={side} />
        </div>
      ) : null}
    </div>
  )
}
