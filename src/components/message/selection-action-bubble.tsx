"use client"

import { useCallback, useEffect, useRef, useState, type RefObject } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  ArrowUp,
  CopyIcon,
  MessageCircleQuestionMark,
  StickyNote,
  TextQuote,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { useImeGuard } from "@/hooks/use-ime-guard"
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
    }

const NO_SELECTION: SelectionState = { kind: "none" }

function sameState(a: SelectionState, b: SelectionState): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === "none" || b.kind === "none") return true
  if (a.text !== b.text) return false
  if (a.kind !== "visible" || b.kind !== "visible") return true
  return a.x === b.x && a.y === b.y && a.below === b.below
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
   * Ask a question ABOUT the selection: the host opens a fresh conversation on
   * the same agent and sends the quoted selection followed by `question`.
   * Omitted wherever a new conversation can't be opened, and the action then
   * isn't offered — same rule as `onQuote`.
   */
  onAsk?: (selection: string, question: string) => void
  /**
   * Keep the selection as a note beside the transcript. Only the canvas has
   * somewhere to put one, so everywhere else omits it and the action isn't
   * offered — same rule as `onQuote`.
   */
  onSaveAsNote?: (text: string) => void
}

/**
 * Floating quick-action toolbar for a text selection inside a message
 * transcript: copy the selected text, quote it into the composer, or ask a
 * question about it in a new conversation. Every action dismisses the toolbar
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
  onAsk,
  onSaveAsNote,
}: SelectionActionBubbleProps) {
  const t = useTranslations("Folder.chat.messageList")
  const ime = useImeGuard()
  const [state, setState] = useState<SelectionState>(NO_SELECTION)
  const stateRef = useRef<SelectionState>(NO_SELECTION)
  const bubbleRef = useRef<HTMLDivElement | null>(null)
  // The "ask" composer is open. While it is, the toolbar FREEZES: the selection
  // text is already captured in `state`, and every tracker below stands down.
  // It has to — focusing the input collapses the page selection, so a live
  // tracker would measure nothing and tear the input down under the user
  // mid-sentence. The ref is the synchronous copy the document-level handlers
  // and the frame loop read.
  const [asking, setAsking] = useState(false)
  const askingRef = useRef(false)
  const [question, setQuestion] = useState("")
  const inputRef = useRef<HTMLInputElement | null>(null)
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

  /** Close the ask composer and throw away whatever was typed. */
  const closeAsk = useCallback(() => {
    askingRef.current = false
    setAsking(false)
    setQuestion("")
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
    const below = top < FLIP_BELOW_WITHIN
    const y = Math.round(
      below
        ? Math.min(rect.bottom - box.top + GAP, box.height - FLIP_BELOW_WITHIN)
        : top - GAP
    )
    return { kind: "visible", text, x, y, below }
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
      pressedInsideRef.current = false
      draggingRef.current = true
      // A press anywhere outside is the dismissal gesture for the ask composer
      // too — it abandons the question, same as pressing Escape.
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
  }, [apply, closeAsk, measure])

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

  const handleQuote = useCallback(() => {
    const current = stateRef.current
    if (current.kind === "none" || !onQuote) return
    onQuote(current.text)
    dismiss()
  }, [onQuote, dismiss])

  /**
   * Swap the buttons for the question input. `askingRef` is set synchronously
   * (not just via state) because the frame loop and the document handlers read
   * it, and the very next thing that happens is the input taking focus — which
   * collapses the page selection and would otherwise dismiss us.
   */
  const handleAskOpen = useCallback(() => {
    if (stateRef.current.kind !== "visible" || !onAsk) return
    pressedInsideRef.current = false
    askingRef.current = true
    setAsking(true)
  }, [onAsk])

  // Re-clamp for the ask row's (much wider) box, THEN take focus — in that
  // order, because focusing collapses the page selection and `measure` would
  // have nothing left to read. This is the last measurement the toolbar takes
  // before it freezes, so getting it wrong here strands the input hanging over
  // the container edge, where the panel's overflow-hidden shears it.
  //
  // A measurement that no longer finds the selection is DISCARDED rather than
  // applied: on touch there is no mousedown to preventDefault, so the tap that
  // opened the composer has already dropped the selection — applying that would
  // unmount the input the user is about to type into.
  useEffect(() => {
    if (!asking) return
    const next = measure()
    if (next.kind === "visible") apply(next)
    inputRef.current?.focus()
  }, [apply, asking, measure])

  const handleAskSubmit = useCallback(() => {
    const current = stateRef.current
    const trimmed = question.trim()
    if (current.kind === "none" || !onAsk || !trimmed) return
    // The selection goes over verbatim; turning it into a quote is the host's
    // job, exactly as for `onQuote`.
    onAsk(current.text, trimmed)
    dismiss()
  }, [dismiss, onAsk, question])

  if (state.kind !== "visible") return null

  return (
    <div
      ref={bubbleRef}
      role="toolbar"
      aria-label={t("selectionActions")}
      className={cn(
        "absolute z-30 flex items-center gap-0.5 rounded-full border border-border bg-popover p-0.5 shadow-md select-none",
        // Only the ask row can outgrow a narrow tiled column. Capping it against
        // the container (the bubble's containing block) lets the input shrink
        // instead of being sheared off by the panel's overflow-hidden; the
        // button row is left to size itself, where a cap would squeeze labels.
        asking && "max-w-[calc(100%-1rem)]"
      )}
      style={{
        left: state.x,
        top: state.y,
        transform: `translate(-50%, ${state.below ? "0" : "-100%"})`,
      }}
      // Keep the selection (and the page's focus) intact while a button is
      // pressed. Without this the press collapses the selection, the resulting
      // `selectionchange` tears the toolbar down, and the button unmounts before
      // its `click` is ever dispatched — the action would simply never run.
      //
      // The ask input is the one exception: it NEEDS the default (focus, caret
      // placement, drag-selecting what you typed), and by then the toolbar is
      // frozen and no longer cares about the page selection.
      onMouseDown={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest("input, textarea")
        ) {
          return
        }
        event.preventDefault()
      }}
      // Touch/pen presses arm the conversation panel's long-press context menu.
      // Stop them here so a slow tap on a bubble button doesn't pop that menu.
      onPointerDown={(event) => {
        if (event.pointerType !== "mouse") event.stopPropagation()
      }}
      onContextMenu={(event) => event.stopPropagation()}
    >
      {asking ? (
        <>
          <input
            ref={inputRef}
            type="text"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder={t("selectionAskPlaceholder")}
            aria-label={t("selectionAskPlaceholder")}
            // `select-text` undoes the toolbar's `select-none`, which some
            // engines otherwise inherit into the field and make untouchable.
            className="h-6 w-56 min-w-0 bg-transparent px-2 text-xs outline-none select-text placeholder:text-muted-foreground"
            {...ime.props}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                // Swallow it: the conversation pane and any surrounding overlay
                // treat Escape as their own dismissal.
                event.preventDefault()
                event.stopPropagation()
                dismiss()
                return
              }
              if (event.key !== "Enter") return
              // Mid-composition Enter belongs to the IME (it commits the
              // candidate); submitting on it would send a half-typed question,
              // which is the common case for every CJK input method.
              if (ime.isComposing(event)) return
              event.preventDefault()
              event.stopPropagation()
              handleAskSubmit()
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={question.trim().length === 0}
            onClick={handleAskSubmit}
            aria-label={t("selectionAskSubmit")}
          >
            <ArrowUp />
          </Button>
        </>
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
          {onAsk && (
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
        </>
      )}
    </div>
  )
}
