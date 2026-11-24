"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  CopyIcon,
  MessageCircleQuestionMark,
  ShieldCheck,
  StickyNote,
  TextQuote,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn, copyTextToClipboard } from "@/lib/utils"

/** Vertical gap between the selection box and the bubble. */
const GAP = 8
/** Minimum distance the bubble keeps from the container's left/right edges. */
const EDGE = 8
/** No room for the bubble above the selection within this many px of the
 *  container top — it flips underneath instead. */
const FLIP_BELOW_WITHIN = 40
/** A selection whose box is within this many px of a horizontal container edge
 *  counts as scrolled out of the message area, and the bubble hides. */
const OUT_OF_VIEW_SLACK = 4
/** Width of the ask composer card, before the container caps it. */
const ASK_WIDTH_REM = 32

/**
 * The element directly under `<body>` that holds `node` — the app shell for
 * anything in the page, or a portal's own root for an overlay (menus, the `@`
 * panel, tooltips) the browser hangs off `<body>` instead.
 */
function bodyChildOf(node: Node | null): Node | null {
  let current = node
  while (
    current &&
    current.parentNode &&
    current.parentNode !== document.body
  ) {
    current = current.parentNode
  }
  return current?.parentNode === document.body ? current : null
}

/**
 * Where the bubble sits, or why it isn't showing.
 *
 * `offscreen` is deliberately distinct from `none`: the selection is still live,
 * it has just scrolled out of the message area. While the transcript is
 * visible, the position tracker keeps running so scrolling back brings the
 * bubble straight back (scrolling does not fire `selectionchange`).
 */
type SelectionState =
  | { kind: "none" }
  | { kind: "offscreen"; text: string }
  | {
      kind: "visible"
      text: string
      /** Horizontal centre of the selection, container-relative px. */
      x: number
      /** Container-relative px edge the bubble is pinned to. */
      y: number
      /** Bubble hangs below the selection (no room above). */
      below: boolean
      /** The selection lies in one message that can be checked (10.3). */
      checkable: boolean
    }

const NO_SELECTION: SelectionState = { kind: "none" }

function sameState(a: SelectionState, b: SelectionState): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === "none" || b.kind === "none") return true
  if (a.text !== b.text) return false
  if (a.kind !== "visible" || b.kind !== "visible") return true
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.below === b.below &&
    a.checkable === b.checkable
  )
}

/** Where a checkable message is marked (`data-check-key`, 10.3). */
const CHECK_SELECTOR = "[data-check-key]"

function elementOf(node: Node | null | undefined): Element | null {
  if (!node) return null
  return node instanceof Element ? node : node.parentElement
}

interface SelectionActionBubbleProps {
  /**
   * The element whose text selections arm the bubble. It also owns positioning:
   * the bubble is an absolutely-positioned child, so this element must be
   * `position: relative` and must NOT be the scrolling box itself (offsets are
   * derived from viewport rects).
   */
  containerRef: RefObject<HTMLElement | null>
  /** A transcript can stay mounted while its tab is hidden. */
  isVisible?: boolean
  /**
   * Quote the selection into the conversation composer. Omitted on read-only
   * surfaces (the sub-agent transcript dialog, task transcripts) — the quote
   * action then simply isn't offered and only "copy" remains.
   */
  onQuote?: (text: string) => void
  /**
   * Ask a question ABOUT the selection: the "Ask" action swaps the buttons for
   * what this returns — the host's composer, holding the selection — inside
   * the bubble. `close` takes the bubble down (and drops the page selection);
   * the composer calls it once it has handed its draft over, or to abandon it.
   * Omitted wherever an ask conversation can't be opened, and the action then
   * isn't offered — same rule as `onQuote`.
   */
  renderAskComposer?: (selection: string, close: () => void) => ReactNode
  /**
   * Keep the selection as a note beside the transcript. Only the canvas has
   * somewhere to put one, so everywhere else omits it and the action isn't
   * offered — same rule as `onQuote`.
   */
  onSaveAsNote?: (text: string) => void
  /**
   * "Is this right?" (10.3): have the assistant check the selected sentence.
   * `from` is the message it lies in (its `data-check-key` element). Offered
   * only for a selection within one such message, and only where omitted it
   * is not — same rule as `onQuote`.
   */
  onCheck?: (text: string, from: Element) => void
}

/**
 * Floating quick-action toolbar for a text selection inside a message
 * transcript: copy the selected text, quote it into the composer, or ask a
 * question about it in an ask conversation — written in a composer the bubble
 * opens in place of its buttons. Every action dismisses the toolbar
 * and drops the selection; copy confirms with a toast, since the toolbar it
 * would otherwise confirm on is gone by then.
 *
 * Rendered IN-TREE (not portalled to `body`) on purpose. Inactive conversation
 * tabs stay mounted and are hidden with `visibility: hidden`, which is
 * inherited — an in-tree overlay disappears with its tab for free, while a
 * portalled one would keep floating over whatever the user switched to.
 */
export function SelectionActionBubble({
  containerRef,
  isVisible = true,
  onQuote,
  renderAskComposer,
  onSaveAsNote,
  onCheck,
}: SelectionActionBubbleProps) {
  const t = useTranslations("Folder.chat.messageList")
  const tCheck = useTranslations("MessageCheck")
  const [state, setState] = useState<SelectionState>(NO_SELECTION)
  const stateRef = useRef<SelectionState>(NO_SELECTION)
  const bubbleRef = useRef<HTMLDivElement | null>(null)
  // The message the selection lies in, when it can be checked: kept at the
  // last measure, since on touch the tap on "Check" drops the selection
  // before its click.
  const checkFromRef = useRef<Element | null>(null)
  // The "ask" composer is open. While it is, the toolbar FREEZES: the selection
  // text is already captured in `state`, and every tracker below stands down.
  // It has to — focusing the composer collapses the page selection, so a live
  // tracker would measure nothing and tear the composer down under the user
  // mid-sentence. The ref is the synchronous copy the document-level handlers
  // and the frame loop read.
  const [asking, setAsking] = useState(false)
  const askingRef = useRef(false)
  // A pointer is down somewhere: the user is (probably) dragging out a
  // selection, so hold the bubble back until they let go.
  const draggingRef = useRef(false)
  // A press has landed on the bubble and its `click` hasn't been dispatched yet.
  // On touch there is no `mousedown` to preventDefault, so the tap CLEARS the
  // selection — and tearing the bubble down on that `selectionchange` would
  // unmount the button before its click ever lands. Frozen until the next press
  // outside the bubble.
  const pressedInsideRef = useRef(false)

  const apply = useCallback((next: SelectionState) => {
    if (sameState(stateRef.current, next)) return
    stateRef.current = next
    setState(next)
  }, [])

  /** Close the ask composer and throw away whatever was typed (the composer
   *  unmounts with it, so the next ask starts fresh). */
  const closeAsk = useCallback(() => {
    askingRef.current = false
    setAsking(false)
  }, [])

  const measure = useCallback((): SelectionState => {
    const container = containerRef.current
    if (!container) return NO_SELECTION
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return NO_SELECTION
    }
    const range = selection.getRangeAt(0)
    // Only OUR transcript. A selection that starts here and ends outside (or
    // lives in another tab / the composer) has a common ancestor above the
    // container, so it is correctly rejected.
    if (!container.contains(range.commonAncestorContainer)) return NO_SELECTION
    const text = selection.toString()
    if (!text.trim()) return NO_SELECTION
    const from = elementOf(range.startContainer)?.closest(CHECK_SELECTOR)
    const to = elementOf(range.endContainer)?.closest(CHECK_SELECTOR)
    checkFromRef.current =
      from && from === to && container.contains(from) ? from : null
    const checkable = checkFromRef.current !== null

    const rect = range.getBoundingClientRect()
    const box = container.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0)
      return { kind: "offscreen", text }
    if (
      rect.bottom < box.top + OUT_OF_VIEW_SLACK ||
      rect.top > box.bottom - OUT_OF_VIEW_SLACK
    ) {
      return { kind: "offscreen", text }
    }

    // Clamp the toolbar's BOX inside the container, not just its anchor point:
    // it is centred on `x` by a -50% transform, so clamping the anchor alone
    // still lets half the toolbar hang past the edge — where the panel's
    // `overflow-hidden` shears it off (measured: 35px of a button gone in a
    // 300px-wide tiled column). `offsetWidth` is 0 on the very first measure,
    // before the toolbar has rendered; the frame loop below re-measures with the
    // real width on the next frame, and since the width doesn't depend on `x`
    // that settles in one step. A toolbar wider than its container can't fit
    // either way, so it just centres.
    const centre = rect.left + rect.width / 2 - box.left
    const half = (bubbleRef.current?.offsetWidth ?? 0) / 2
    const minX = EDGE + half
    const maxX = box.width - EDGE - half
    const x = Math.round(
      minX > maxX ? box.width / 2 : Math.min(Math.max(centre, minX), maxX)
    )
    const top = rect.top - box.top
    // The ask composer is far taller than the button row: it hangs above the
    // selection only when it fits there, and below it is kept off the
    // container's bottom edge, where the panel's overflow-hidden would shear it.
    const height = askingRef.current
      ? (bubbleRef.current?.offsetHeight ?? 0)
      : 0
    const below = top < Math.max(FLIP_BELOW_WITHIN, height + GAP + EDGE)
    const floor = askingRef.current
      ? Math.max(EDGE, box.height - height - EDGE)
      : box.height - FLIP_BELOW_WITHIN
    const y = Math.round(
      below ? Math.min(rect.bottom - box.top + GAP, floor) : top - GAP
    )
    return { kind: "visible", text, x, y, below, checkable }
  }, [containerRef])

  useEffect(() => {
    const insideBubble = (target: EventTarget | null) =>
      target instanceof Node && bubbleRef.current?.contains(target) === true

    const handleSelectionChange = () => {
      // Mid-drag the selection is still growing and the bubble would chase the
      // cursor; `pointerup` takes the final reading. While the ask composer is
      // open the toolbar is frozen — and the very act of focusing its input
      // fires this with an empty selection.
      if (
        draggingRef.current ||
        pressedInsideRef.current ||
        askingRef.current
      ) {
        return
      }
      apply(measure())
    }
    const handlePointerDown = (event: PointerEvent) => {
      // Pressing our own buttons must not tear the bubble down before `click`.
      // Only the PRIMARY button is armed: a right-click inside the bubble is
      // followed by `contextmenu`, never by `click`, so arming there would
      // freeze the bubble with nothing left to release it. `button` is read
      // with the DOM's own default (0 = primary) because jsdom has no
      // `PointerEvent` and synthesizes these without the property.
      if (insideBubble(event.target)) {
        if ((event.button ?? 0) === 0) pressedInsideRef.current = true
        return
      }
      // The composer's own overlays — its `@` panel, the mode menu, a tooltip —
      // are portalled to `<body>`, outside the bubble: a press in one of them
      // is still the user working in the composer, never a dismissal.
      if (
        askingRef.current &&
        event.target instanceof Node &&
        bodyChildOf(event.target) !== bodyChildOf(containerRef.current)
      ) {
        return
      }
      pressedInsideRef.current = false
      draggingRef.current = true
      // A press anywhere else in the page is the dismissal gesture for the ask
      // composer too — it abandons the question, same as pressing Escape.
      closeAsk()
      apply(NO_SELECTION)
    }
    const handlePointerUp = (event: PointerEvent) => {
      draggingRef.current = false
      if (insideBubble(event.target)) return
      // The browser finalises the selection after dispatching pointerup (a
      // double/triple click in particular), so read it on the next task.
      window.setTimeout(() => {
        if (draggingRef.current || askingRef.current) return
        apply(measure())
      }, 0)
    }
    // A cancelled press (scroll takeover, palm rejection) is never followed by a
    // `click`, so the guard below would stay armed forever and strand the
    // bubble. Release it here — this is the cancel path's whole job.
    const handlePointerCancel = (event: PointerEvent) => {
      pressedInsideRef.current = false
      handlePointerUp(event)
    }
    // The press-inside freeze ends the moment its `click` is dispatched — that
    // is the whole window it exists to bridge. Leaving it armed would strand the
    // bubble: the position tracker below honours the same flag, so after a copy
    // it would stop following the text it points at.
    const handleClick = () => {
      pressedInsideRef.current = false
    }

    // Capture phase throughout: a handler deeper in the tree may stop
    // propagation (Radix menus and the composer both do), and this bookkeeping
    // has to see every press regardless.
    document.addEventListener("selectionchange", handleSelectionChange)
    document.addEventListener("pointerdown", handlePointerDown, true)
    document.addEventListener("pointerup", handlePointerUp, true)
    document.addEventListener("pointercancel", handlePointerCancel, true)
    document.addEventListener("click", handleClick, true)
    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange)
      document.removeEventListener("pointerdown", handlePointerDown, true)
      document.removeEventListener("pointerup", handlePointerUp, true)
      document.removeEventListener("pointercancel", handlePointerCancel, true)
      document.removeEventListener("click", handleClick, true)
    }
  }, [apply, closeAsk, containerRef, measure])

  // Keep the bubble glued to the selection while anything moves it: thread
  // scrolling, the window resizing, a sidebar animating, or new streamed content
  // reflowing the transcript above it. None of those fire `selectionchange`, and
  // a scroll listener alone misses the reflow cases — a frame loop covers them
  // all while the transcript and its selection can be moved. Hidden tabs and
  // the frozen Ask composer have no position to track.
  const live = state.kind !== "none"
  useEffect(() => {
    if (!live || !isVisible || asking) return
    let frame = requestAnimationFrame(function tick() {
      frame = requestAnimationFrame(tick)
      if (
        draggingRef.current ||
        pressedInsideRef.current ||
        askingRef.current
      ) {
        return
      }
      apply(measure())
    })
    return () => cancelAnimationFrame(frame)
  }, [live, isVisible, asking, apply, measure])

  // The action handlers read the selection through `stateRef` rather than
  // `state`, so they stay referentially stable while the frame loop repositions
  // the bubble.

  /**
   * Drop the selection and take the bubble down. Every action ends this way:
   * the work is done, so the toolbar gets out of the way instead of hovering
   * over text the user is finished with. Clearing the selection (rather than
   * only hiding) is what makes the dismissal stick — the frame loop re-measures
   * every frame and would put the bubble straight back otherwise.
   */
  const dismiss = useCallback(() => {
    pressedInsideRef.current = false
    closeAsk()
    window.getSelection()?.removeAllRanges()
    apply(NO_SELECTION)
  }, [apply, closeAsk])

  const handleCopy = useCallback(() => {
    const current = stateRef.current
    if (current.kind === "none") return
    const { text } = current
    // Dismiss BEFORE the write, not in its `.then()`. The clipboard write is
    // async (and on the non-secure-context fallback path it focuses a hidden
    // textarea, which churns the page selection), so waiting on it would leave
    // a stale toolbar hovering over text that is already being taken away.
    // Clearing first also means the fallback's snapshot-and-restore of the page
    // selection has nothing to put back.
    dismiss()
    void copyTextToClipboard(text).then((ok) => {
      toast[ok ? "success" : "error"](
        ok ? t("selectionCopied") : t("selectionCopyFailed")
      )
    })
  }, [dismiss, t])

  const handleSaveAsNote = useCallback(() => {
    const current = stateRef.current
    if (current.kind === "none" || !onSaveAsNote) return
    onSaveAsNote(current.text)
    dismiss()
  }, [onSaveAsNote, dismiss])

  const handleCheck = useCallback(() => {
    const current = stateRef.current
    const from = checkFromRef.current
    if (current.kind === "none" || !from || !onCheck) return
    const { text } = current
    dismiss()
    onCheck(text, from)
  }, [dismiss, onCheck])

  const handleQuote = useCallback(() => {
    const current = stateRef.current
    if (current.kind === "none" || !onQuote) return
    onQuote(current.text)
    dismiss()
  }, [onQuote, dismiss])

  /**
   * Swap the buttons for the ask composer. `askingRef` is set synchronously
   * (not just via state) because the frame loop and the document handlers read
   * it, and the very next thing that happens is the composer taking focus —
   * which collapses the page selection and would otherwise dismiss us.
   */
  const handleAskOpen = useCallback(() => {
    if (stateRef.current.kind !== "visible" || !renderAskComposer) return
    pressedInsideRef.current = false
    askingRef.current = true
    setAsking(true)
  }, [renderAskComposer])

  // Re-clamp for the composer's (much larger) box. This is the last
  // measurement the toolbar takes before it freezes, so getting it wrong here
  // strands the composer hanging over the container edge, where the panel's
  // overflow-hidden shears it. A layout effect, so it lands before the
  // composer takes focus (which collapses the page selection `measure` reads)
  // and before the first paint at the button row's position.
  //
  // A measurement that no longer finds the selection is DISCARDED rather than
  // applied: on touch there is no mousedown to preventDefault, so the tap that
  // opened the composer has already dropped the selection — applying that would
  // unmount the composer the user is about to type into.
  useLayoutEffect(() => {
    if (!asking) return
    const next = measure()
    if (next.kind === "visible") apply(next)
  }, [apply, asking, measure])

  if (state.kind !== "visible") return null

  return (
    <div
      ref={bubbleRef}
      role={asking ? "dialog" : "toolbar"}
      aria-label={asking ? t("selectionAsk") : t("selectionActions")}
      className={cn(
        "absolute z-30 border border-border bg-popover shadow-md",
        asking
          ? // Capped against the container (the bubble's containing block) so
            // a narrow tiled column shrinks the composer instead of the
            // panel's overflow-hidden shearing it off; the button row is left
            // to size itself, where a cap would squeeze labels.
            "max-w-[calc(100%-1rem)] rounded-2xl p-1.5"
          : "flex items-center gap-0.5 rounded-full p-0.5 select-none"
      )}
      style={{
        left: state.x,
        top: state.y,
        transform: `translate(-50%, ${state.below ? "0" : "-100%"})`,
        width: asking ? `${ASK_WIDTH_REM}rem` : undefined,
      }}
      // Keep the selection (and the page's focus) intact while a button is
      // pressed. Without this the press collapses the selection, the resulting
      // `selectionchange` tears the toolbar down, and the button unmounts before
      // its `click` is ever dispatched — the action would simply never run.
      //
      // The ask composer is the exception: it NEEDS the default (focus, caret
      // placement, drag-selecting what you typed), and by then the toolbar is
      // frozen and no longer cares about the page selection.
      onMouseDown={(event) => {
        if (asking) return
        event.preventDefault()
      }}
      // Escape abandons the question — unless something inside the composer
      // (its `@` or `/` panel) already took it for itself. Swallowed either
      // way while asking: the conversation pane and any surrounding overlay
      // treat Escape as their own dismissal.
      onKeyDown={(event) => {
        if (!asking || event.key !== "Escape") return
        event.stopPropagation()
        if (event.defaultPrevented || event.nativeEvent.isComposing) return
        event.preventDefault()
        dismiss()
      }}
      // Touch/pen presses arm the conversation panel's long-press context menu.
      // Stop them here so a slow tap on a bubble button doesn't pop that menu.
      onPointerDown={(event) => {
        if (event.pointerType !== "mouse") event.stopPropagation()
      }}
      onContextMenu={(event) => event.stopPropagation()}
    >
      {asking && renderAskComposer ? (
        renderAskComposer(state.text, dismiss)
      ) : (
        <>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={handleCopy}
            aria-label={t("selectionCopy")}
          >
            <CopyIcon />
            {t("selectionCopy")}
          </Button>
          {onQuote && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={handleQuote}
              aria-label={t("selectionQuote")}
            >
              <TextQuote />
              {t("selectionQuote")}
            </Button>
          )}
          {onSaveAsNote && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={handleSaveAsNote}
              aria-label={t("selectionSaveAsNote")}
            >
              <StickyNote />
              {t("selectionSaveAsNote")}
            </Button>
          )}
          {renderAskComposer && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={handleAskOpen}
              aria-label={t("selectionAsk")}
            >
              <MessageCircleQuestionMark />
              {t("selectionAsk")}
            </Button>
          )}
          {onCheck && state.checkable && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={handleCheck}
              aria-label={tCheck("selection")}
              data-check-selection
            >
              <ShieldCheck />
              {tCheck("selection")}
            </Button>
          )}
        </>
      )}
    </div>
  )
}
