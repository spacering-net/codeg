"use client"

import { useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { RenderPageFrame } from "@/components/message/render-page-frame"
import {
  renderPageAnswerFromSubmit,
  type RenderPageSubmit,
} from "@/lib/render-page"
import type { PendingRenderPageState, RenderPageAnswer } from "@/lib/types"

interface RenderPageCardProps {
  /** The awaiting-answer page. The shell renders this card only while a page
   *  is pending, so the prop is always present. */
  page: PendingRenderPageState
  /** Resolves the parked `render_page` tool call. Returns a promise so the
   *  frame can reject the page's submit and let it retry on failure. */
  onAnswer: (pageId: string, answer: RenderPageAnswer) => void | Promise<void>
  /** Quotes selected page text into the composer; omitted where there is no
   *  composer, and the frame then offers only copy. */
  onQuote?: (text: string) => void
  /** Sends a finished annotation session to the composer as formatted text;
   *  omitted where there is no composer, and no annotate entry is offered. */
  onAnnotate?: (text: string) => void
}

/**
 * Pinned card for an awaiting-answer `render_page`: the page the agent is
 * blocked on, rendered in its sandboxed frame above the composer. The page
 * itself carries the submit control (`codeg.render.submit`); this card only
 * frames it, relays the answer, and offers the dismissal (Close) the agent is
 * told to read as "the user did not answer".
 */
export function RenderPageCard({
  page,
  onAnswer,
  onQuote,
  onAnnotate,
}: RenderPageCardProps) {
  const t = useTranslations("Folder.chat.renderPage")
  const [submitting, setSubmitting] = useState(false)
  const [dismissSubmitting, setDismissSubmitting] = useState(false)
  const [error, setError] = useState(false)
  const inFlight = useRef(false)

  const submit = async (s: RenderPageSubmit) => {
    if (inFlight.current) return
    inFlight.current = true
    setSubmitting(true)
    setError(false)
    try {
      await onAnswer(page.page_id, renderPageAnswerFromSubmit(s))
      // On success the backend's `render_page_resolved` unmounts this card;
      // keep the frame in-flight until then rather than flashing it back on.
      inFlight.current = false
    } catch (e) {
      setError(true)
      setSubmitting(false)
      inFlight.current = false
      // Rejections reach the page as a failed submit promise, so its own
      // error handling (a retry click) is the recovery path.
      throw e instanceof Error ? e : new Error(String(e))
    }
  }

  const dismiss = () => {
    if (inFlight.current) return
    inFlight.current = true
    setDismissSubmitting(true)
    setError(false)
    void (async () => {
      try {
        await onAnswer(page.page_id, { declined: true })
      } catch {
        setError(true)
      } finally {
        setDismissSubmitting(false)
        inFlight.current = false
      }
    })()
  }

  const locked = submitting || dismissSubmitting

  return (
    <div className="w-full space-y-2 rounded-lg border border-border/60 bg-card/60 p-4">
      <div className="flex items-center gap-1.5">
        <div className="min-w-0 flex-1 text-sm font-medium text-foreground">
          <span className="truncate">{page.title || t("title")}</span>
          <span className="ms-2 text-xs font-normal text-muted-foreground">
            {t("waitingHint")}
          </span>
        </div>
        {submitting && (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        )}
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          disabled={locked}
          onClick={dismiss}
          title={t("dismiss")}
          aria-label={t("dismiss")}
        >
          <X className="size-4" />
        </Button>
      </div>

      <div className="overflow-hidden rounded-md border border-border/60 bg-background">
        <RenderPageFrame
          html={page.html}
          // The card stays `waiting` through its own submit/dismiss: flipping
          // it would rebuild the srcdoc and reload the page, destroying the
          // very document whose submit promise the reply (or rejection) must
          // reach. `inFlight` already blocks a second answer, and a success
          // unmounts this card via `render_page_resolved`.
          answerState={{ waiting: true, answer: null }}
          onSubmit={submit}
          onQuote={onQuote}
          onAnnotate={onAnnotate}
          pageTitle={page.title}
        />
      </div>

      {error && <p className="text-xs text-destructive">{t("submitError")}</p>}
    </div>
  )
}
