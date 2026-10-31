"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { CopyIcon, MousePointerClick, TextQuote } from "lucide-react"
import { openExternalTab } from "@/lib/link-open"
import {
  buildRenderPageDocument,
  clampRenderPageHeight,
  collectRenderPageTheme,
  formatRenderPageAnnotation,
  readRenderPageFrameMessage,
  renderPageAnswerStateMessage,
  renderPageAnnotateMessage,
  renderPageClearSelectionMessage,
  renderPageSubmitReply,
  renderPageThemeMessage,
  type RenderPageAnswerState,
  type RenderPageSubmit,
} from "@/lib/render-page"
import { Button } from "@/components/ui/button"
import { cn, copyTextToClipboard } from "@/lib/utils"

interface RenderPageFrameProps {
  /** The agent's self-contained HTML document. */
  html: string
  /** Where the page stands on its answer: `waiting` injects the submit bridge
   *  and keeps the page live; a show-only page (and an answered replay) uses
   *  `{ waiting: false }`. */
  answerState: RenderPageAnswerState
  /** Called for a page submit while the page waits. The frame holds the
   *  page's promise until this settles and replies to the page — an error
   *  message makes `codeg.render.submit` reject so the page can retry. */
  onSubmit?: (submit: RenderPageSubmit) => Promise<void>
  /**
   * Quote selected page text into the conversation composer. Omitted on
   * read-only surfaces (the in-stream replay card, the sub-agent transcript)
   * — the quote action then simply isn't offered and only "copy" remains,
   * the same rule the transcript's `SelectionActionBubble` follows.
   */
  onQuote?: (text: string) => void
  /**
   * Send a finished annotation session (picked elements, boxed regions,
   * freehand marks, note) to the composer as formatted text. Omitted where
   * there is no composer, and the "annotate" entry button isn't offered.
   */
  onAnnotate?: (text: string) => void
  /** The page's title, echoed into the annotation text so the agent knows
   *  which page the marks were made on. */
  pageTitle?: string
  className?: string
}

/** Vertical gap between the selection box and the bubble, and the inset it
 *  keeps from the frame's edges. Mirrors `SelectionActionBubble`. */
const GAP = 8
const EDGE = 8
/** A selection within this many px of the page top gets the bubble under it
 *  instead of above (where the card's edge would clip it). */
const FLIP_BELOW_WITHIN = 40

/** Where the bubble hangs, in frame-relative px (the page reports viewport
 *  rects and the frame shows the page unscrolled vertically, so they read
 *  directly). `doc` pins the report to the document it was made against: a
 *  frame rebuild drops the page's selection with it, so a bubble from an
 *  older document simply stops showing. */
interface BubbleState {
  text: string
  x: number
  y: number
  below: boolean
  doc: string
}

/**
 * The sandboxed frame a `render_page` draws in. The page runs without
 * `allow-same-origin` — no access to this app's storage, credentials or DOM —
 * and talks to us only through the bootstrap's postMessage protocol: theme
 * variables (swapped live on a theme switch), its content height (the frame
 * takes it, so the chat scrolls around it and the page never scrolls inside),
 * http(s) link clicks (handed to the browser), answers
 * (`codeg.render.submit`), text selections, and annotation sessions. A
 * selection can't be read from outside the opaque-origin document, so the page
 * reports its text and rect; the frame hangs a small copy/quote bubble over
 * it, the counterpart of the transcript's `SelectionActionBubble`. Marking the
 * page up (pick elements, box regions, draw) runs entirely page-side — the
 * frame asks the bootstrap to open the overlay and receives one structured
 * report back, which `formatRenderPageAnnotation` turns into composer text.
 */
export function RenderPageFrame({
  html,
  answerState,
  onSubmit,
  onQuote,
  onAnnotate,
  pageTitle,
  className,
}: RenderPageFrameProps) {
  const t = useTranslations("Folder.chat.messageList")
  const trp = useTranslations("Folder.chat.renderPage")
  const frameRef = useRef<HTMLIFrameElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const bubbleRef = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(48)
  const [bubble, setBubble] = useState<BubbleState | null>(null)
  // An open annotation session, stamped with the document it was started
  // against: a frame rebuild drops the page's overlay with it, so the entry
  // button simply falls back to "start" without an extra state clear.
  const [annot, setAnnot] = useState<{ doc: string } | null>(null)
  // The latest answer state and the current submit handler, read by the stable
  // message listener so it never re-subscribes on every render. Synced in an
  // effect, not during render (react-hooks/refs); the listener only reads them
  // from a postMessage callback, which always lands after the effect ran.
  const answerStateRef = useRef(answerState)
  const submitRef = useRef(onSubmit)
  const annotateRef = useRef(onAnnotate)
  const titleRef = useRef(pageTitle)
  useEffect(() => {
    answerStateRef.current = answerState
    submitRef.current = onSubmit
    annotateRef.current = onAnnotate
    titleRef.current = pageTitle
  })

  const { waiting, answer } = answerState
  const srcdoc = useMemo(
    () =>
      buildRenderPageDocument(html, collectRenderPageTheme(), {
        waiting,
        answer,
      }),
    // A theme switch reaches the page as a message (below); only the page's
    // own document and its answer state rebuild the frame. The `doc` stamp on
    // the bubble drops it across a rebuild without an extra state clear.
    [html, waiting, answer]
  )
  // The listener stamps reports with the document they were made against
  // without re-subscribing on every rebuild.
  const srcdocRef = useRef(srcdoc)
  useEffect(() => {
    srcdocRef.current = srcdoc
  })

  const post = useCallback((message: unknown) => {
    frameRef.current?.contentWindow?.postMessage(message, "*")
  }, [])

  // Keep the loaded page's view of its answer current (another window may
  // have answered, the user may have dismissed the card) without reloading it.
  useEffect(() => {
    post(renderPageAnswerStateMessage({ waiting, answer }))
  }, [waiting, answer, post])

  // Re-push the theme when the app's own theme flips (the `dark` class is the
  // marker) or the interface size changes the root font. The frame reports it
  // rather than being rebuilt, so the page keeps its state.
  useEffect(() => {
    const push = () => post(renderPageThemeMessage(collectRenderPageTheme()))
    const observer = new MutationObserver(push)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-font-size"],
    })
    window.addEventListener("resize", push)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", push)
    }
  }, [post])

  const handleMessage = useCallback(
    (event: MessageEvent) => {
      const frame = frameRef.current
      if (!frame || event.source !== frame.contentWindow) return
      const message = readRenderPageFrameMessage(event.data)
      if (!message) return
      switch (message.kind) {
        case "size":
          setHeight(clampRenderPageHeight(message.height))
          break
        case "open-link":
          openExternalTab(message.url)
          break
        case "selection": {
          const r = message.rect
          if (!message.text || !r) {
            setBubble(null)
            break
          }
          const below = r.y < FLIP_BELOW_WITHIN
          setBubble({
            text: message.text,
            x: r.x + r.width / 2,
            y: below ? r.y + r.height + GAP : r.y - GAP,
            below,
            doc: srcdocRef.current,
          })
          break
        }
        case "selection-escape":
          setBubble(null)
          break
        case "annotation": {
          // One report per started session: `null` is the page's own cancel,
          // a payload is a finished session bound for the composer. The entry
          // button resets either way; a session from an older document (no
          // live overlay to close) is still delivered — the marks were real.
          setAnnot(null)
          const handler = annotateRef.current
          if (message.payload && handler) {
            handler(
              formatRenderPageAnnotation(
                message.payload,
                titleRef.current ?? ""
              )
            )
          }
          break
        }
        case "submit": {
          const handler = submitRef.current
          if (!handler || !answerStateRef.current.waiting) {
            post(
              renderPageSubmitReply(
                message.id,
                "This page is no longer waiting for an answer"
              )
            )
            break
          }
          // The host re-checks the cap the page checked — a page can replace
          // its own script.
          let oversized = false
          try {
            const encoded = JSON.stringify(message.data)
            oversized = !!encoded && encoded.length > 16000
          } catch {
            oversized = true
          }
          if (oversized) {
            post(
              renderPageSubmitReply(
                message.id,
                "data must stay under 16000 characters as JSON"
              )
            )
            break
          }
          if (!message.summary.trim()) {
            post(
              renderPageSubmitReply(
                message.id,
                "summary is required: the choice in a few words"
              )
            )
            break
          }
          void (async () => {
            try {
              await handler(message)
              // The answer landed (the card will clear on the resolved event);
              // settle the page's promise and end its wait.
              post(renderPageSubmitReply(message.id))
            } catch (e) {
              post(
                renderPageSubmitReply(
                  message.id,
                  e instanceof Error ? e.message : "The answer was not sent"
                )
              )
            }
          })()
          break
        }
      }
    },
    [post]
  )

  useEffect(() => {
    window.addEventListener("message", handleMessage)
    return () => window.removeEventListener("message", handleMessage)
  }, [handleMessage])

  // Clamp the bubble's ANCHOR so its box stays inside the frame: it hangs from
  // a -50% transform, so an unclamped anchor lets half of it run past the
  // edge, where the card clips it. The measure rides a frame callback (same
  // shape as `SelectionActionBubble`'s re-measure loop): `offsetWidth` is 0 on
  // the very first paint, and a post-mount callback is where measured layout
  // may be folded back into state without a cascading render.
  useEffect(() => {
    if (!bubble) return
    const raf = requestAnimationFrame(() => {
      const bubbleEl = bubbleRef.current
      const container = containerRef.current
      if (!bubbleEl || !container) return
      const half = bubbleEl.offsetWidth / 2
      const min = EDGE + half
      const max = container.clientWidth - EDGE - half
      const x =
        min > max
          ? Math.round(container.clientWidth / 2)
          : Math.round(Math.min(Math.max(bubble.x, min), max))
      if (x !== bubble.x) setBubble({ ...bubble, x })
    })
    return () => cancelAnimationFrame(raf)
  }, [bubble])

  /** Run one bubble action: the text was captured when the selection was
   *  reported, so the action works even after the page drops the selection. */
  const act = useCallback(
    (run: (text: string) => void) => {
      setBubble((current) => {
        if (current) {
          // Tell the page to drop the selection, so the highlight doesn't
          // stay under the cursor's next click as if nothing happened.
          post(renderPageClearSelectionMessage())
          run(current.text)
        }
        return null
      })
    },
    [post]
  )

  const handleCopy = useCallback(() => {
    act((text) => {
      void copyTextToClipboard(text).then((ok) =>
        toast[ok ? "success" : "error"](
          ok ? t("selectionCopied") : t("selectionCopyFailed")
        )
      )
    })
  }, [act, t])

  const handleQuote = useCallback(() => {
    if (!onQuote) return
    act(onQuote)
  }, [act, onQuote])

  /** Open the page's annotation overlay (element pick / region box / freehand
   *  draw, all page-side) with this locale's chrome labels, or close the one
   *  already open. The page answers once per start — payload or cancel. */
  const toggleAnnotate = useCallback(() => {
    if (annot) {
      post(renderPageAnnotateMessage("stop"))
      setAnnot(null)
      return
    }
    post(
      renderPageAnnotateMessage("start", {
        element: trp("annotateElement"),
        region: trp("annotateRegion"),
        draw: trp("annotateDraw"),
        placeholder: trp("annotatePlaceholder"),
        send: trp("annotateSend"),
        cancel: trp("annotateCancel"),
      })
    )
    setAnnot({ doc: srcdocRef.current })
  }, [annot, post, trp])

  // A report made against an older document is no longer a live selection: a
  // frame rebuild drops the page's selection with it.
  const shown = bubble && bubble.doc === srcdoc ? bubble : null
  const annotating = !!annot && annot.doc === srcdoc

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <iframe
        ref={frameRef}
        title=""
        srcDoc={srcdoc}
        // Scripts run, forms submit; no same-origin, so nothing of this app is
        // reachable from the page.
        sandbox="allow-scripts allow-forms"
        scrolling="no"
        className="block w-full border-0 bg-transparent"
        style={{ height }}
      />
      {onAnnotate && (
        <Button
          type="button"
          size="xs"
          variant={annotating ? "default" : "secondary"}
          onClick={toggleAnnotate}
          title={annotating ? trp("annotateStop") : trp("annotate")}
          aria-label={annotating ? trp("annotateStop") : trp("annotate")}
          aria-pressed={annotating}
          data-testid="render-page-annotate-button"
          className="absolute right-2 top-2 z-30 shadow-md select-none"
        >
          <MousePointerClick />
          {trp("annotate")}
        </Button>
      )}
      {shown && (
        <div
          ref={bubbleRef}
          role="toolbar"
          aria-label={t("selectionActions")}
          className="absolute z-30 flex items-center gap-0.5 rounded-full border border-border bg-popover p-0.5 shadow-md select-none"
          style={{
            left: shown.x,
            top: shown.y,
            transform: `translate(-50%, ${shown.below ? "0" : "-100%"})`,
          }}
          // Keep the page's selection (and its focus) intact while a button is
          // pressed: without this the press clears the selection, the page
          // reports it gone, and the button unmounts before its `click`
          // lands. The host's own selection machinery is not in play here —
          // the text was already captured with the report.
          onMouseDown={(event) => event.preventDefault()}
          // Touch/pen presses arm the conversation panel's long-press context
          // menu; stop them so a slow tap on a button doesn't pop it.
          onPointerDown={(event) => {
            if (event.pointerType !== "mouse") event.stopPropagation()
          }}
          onContextMenu={(event) => event.stopPropagation()}
        >
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
        </div>
      )}
    </div>
  )
}
