"use client"

/**
 * Read-only inline view of the codeg-mcp `render_page` tool in the message
 * stream (historical transcripts + the in-flight tool marker).
 *
 * The live interactive page (awaiting an answer) is owned by the PINNED
 * `RenderPageCard`, driven by the connection's `pendingRenderPage` — this
 * record never mounts a second frame while that wait is on, so an in-flight
 * awaited call shows only a quiet placeholder until it settles. What a
 * settled call records depends on how it ended: a show-only page draws the
 * page itself (replayed read-only in its sandbox); an answered one collapses
 * to a capsule naming the user's summary, expanding to the page; a declined
 * one says so in a line. Reconstructed from the tool's raw input JSON + the
 * persisted result envelope (see `@/lib/render-page`).
 */

import { useMemo, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { AppWindow, ChevronDown, ChevronUp, Loader2 } from "lucide-react"

import { RenderPageFrame } from "@/components/message/render-page-frame"
import {
  useRenderPageAnnotate,
  useRenderPageQuote,
} from "@/components/message/render-page-quote"
import { cn } from "@/lib/utils"
import { parseRenderPageInput, parseRenderPageOutcome } from "@/lib/render-page"
import type { ToolCallState } from "@/lib/adapters/ai-elements-adapter"

interface Props {
  input?: string | null
  output?: string | null
  errorText?: string | null
  state?: ToolCallState
}

export function RenderPageResultCard({
  input,
  output,
  errorText,
  state,
}: Props) {
  const t = useTranslations("Folder.chat.renderPageResult")
  const [expanded, setExpanded] = useState(false)
  // A page replayed in the transcript can still be marked up: where the view
  // has a composer (the provider is there), a text selection offers quote as
  // well as copy and the page grows an annotate entry; without one it stays
  // copy-only.
  const onQuote = useRenderPageQuote()
  const onAnnotate = useRenderPageAnnotate()

  const page = useMemo(() => parseRenderPageInput(input), [input])
  const outcome = useMemo(() => parseRenderPageOutcome(output), [output])

  const isError = !!errorText?.trim()
  const isRunning = state === "input-available" || state === "input-streaming"
  const isInFlight = !isError && !outcome && isRunning

  const shell = (subtitle: string | null, body?: ReactNode) => (
    <div
      data-testid="render-page-result-card"
      className={cn(
        "mb-2 overflow-hidden rounded-xl border bg-card ws-msg-card",
        isError ? "border-destructive/30" : "border-primary/30"
      )}
    >
      <div className="flex flex-col gap-2 p-3">
        <div className="flex items-start gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-primary">
            <AppWindow className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">
              {page?.title || t("title")}
            </p>
            {subtitle && (
              <p className="text-xs text-muted-foreground">{subtitle}</p>
            )}
          </div>
          {isInFlight && page?.awaitAnswer && (
            <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
          )}
        </div>
        {body}
      </div>
    </div>
  )

  // The settled page, replayed in its sandbox with the submit bridge inert.
  // Built lazily per use — the header-only states must not touch `page.html`
  // before the null checks below have run.
  const frame = page?.html ? (
    <div className="overflow-hidden rounded-lg border border-border/60 bg-background">
      <RenderPageFrame
        html={page.html}
        answerState={{ waiting: false, answer: null }}
        onQuote={onQuote ?? undefined}
        onAnnotate={onAnnotate ?? undefined}
        pageTitle={page.title}
      />
    </div>
  ) : null

  if (isError) {
    return shell(
      null,
      <p className="whitespace-pre-wrap text-xs text-destructive">
        {errorText?.trim()}
      </p>
    )
  }

  if (isInFlight) {
    // An awaited page is on screen (interactive) through the pinned card for
    // as long as it waits — the placeholder here only names it. A show-only
    // call, whose answer is the page itself, can draw it already.
    if (!page) return null
    if (page.awaitAnswer) return shell(t("awaiting"))
    return shell(null, frame)
  }

  if (!page) return null

  if (!outcome || outcome.kind === "declined") {
    return shell(outcome ? t("declined") : null, frame)
  }

  if (outcome.kind === "shown") return shell(null, frame)

  // Answered: collapse to a capsule naming the summary; expanding replays the
  // page so the record can be re-read without leaving the transcript.
  const capsule = (
    <button
      type="button"
      onClick={() => setExpanded((v) => !v)}
      aria-expanded={expanded}
      data-testid="render-page-result-card"
      className={cn(
        "flex w-fit max-w-full items-center gap-2 rounded-full border border-primary/30 bg-card ws-msg-card px-3 py-1.5 text-left transition-colors hover:bg-muted/40",
        !expanded && "mb-2"
      )}
    >
      <AppWindow className="size-4 shrink-0 text-primary" />
      <span className="min-w-0 flex-1 truncate text-xs">
        <span className="mr-1 text-muted-foreground">{t("answeredLabel")}</span>
        <span className="text-foreground/90">
          {outcome.summary || t("noSummary")}
        </span>
      </span>
      {expanded ? (
        <ChevronUp className="size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
      )}
    </button>
  )

  if (!expanded) return capsule

  return (
    <div className="mb-2 space-y-1.5">
      {capsule}
      {frame}
    </div>
  )
}
