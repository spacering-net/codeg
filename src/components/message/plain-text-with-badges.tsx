"use client"

import type { ReactNode } from "react"
import { createContext, memo, useContext, useMemo, useState } from "react"

import {
  isEmbeddedReferenceUri,
  refOfEmbeddedReferenceUri,
} from "@/components/chat/composer/reference-uri"
import { ReferenceBadge } from "@/components/chat/composer/badges/reference-badge"
import { parseQuoteBlocks, type QuoteBlock } from "@/lib/message-quote"
import { cn } from "@/lib/utils"

import { FileReferenceActions } from "./file-reference-actions"
import { useKnownInvocations } from "./known-invocations-context"
import {
  parseUserMessageSegments,
  type UserMessageSegment,
} from "./user-message-segments"

/** The key a badge and its `<annotation>` tag match on: the annotation's
 *  own uri, fragment off, percent-forms unified (a rebuilt badge carries the
 *  double-encoded uri; the tag carries the block's own). */
function annotationKey(uri: string | undefined): string | null {
  if (!uri || !uri.toLowerCase().startsWith("codeg://embedded/")) return null
  const ref = refOfEmbeddedReferenceUri(uri)
  const base = ref && isEmbeddedReferenceUri(ref) ? ref : uri
  return base.split("#")[0]
}

/** Which annotation reports one user bubble has open. Lives above the
 *  message's parts because the badge and the report it opens typically sit in
 *  different parts (an agent's record keeps the block at the end). `reports`
 *  lists every ref the WHOLE message carries, so a badge in one part can
 *  open a report stored in another. */
interface AnnotationOpenState {
  isOpen: (ref: string) => boolean
  toggle: (ref: string) => void
  reports: Set<string>
}
const AnnotationOpenContext = createContext<AnnotationOpenState | null>(null)

export function AnnotationReportProvider({
  children,
  reports,
}: {
  children: ReactNode
  reports?: Iterable<string>
}) {
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const allReports = useMemo(() => new Set(reports ?? []), [reports])
  const value = useMemo<AnnotationOpenState>(
    () => ({
      isOpen: (ref) => open.has(ref),
      toggle: (ref) =>
        setOpen((prev) => {
          const next = new Set(prev)
          if (next.has(ref)) next.delete(ref)
          else next.add(ref)
          return next
        }),
      reports: allReports,
    }),
    [open, allReports]
  )
  return (
    <AnnotationOpenContext.Provider value={value}>
      {children}
    </AnnotationOpenContext.Provider>
  )
}

/** The report an annotation badge opens: the prompt the markup wrote, shown
 *  as the plain lines it is. */
function AnnotationReport({ body }: { body: string }) {
  return (
    <div
      data-testid="annotation-report"
      className="mt-1.5 rounded-md border-s-2 border-foreground/25 bg-black/5 px-2.5 py-1.5 text-xs whitespace-pre-wrap text-muted-foreground dark:bg-white/5"
      dir="auto"
    >
      {body}
    </div>
  )
}

/**
 * Re-read transcripts carry an annotation as a bare uri line and its
 * `<annotation>` block BELOW the prose — the wire order, not what the sender
 * composed. Show what they composed instead: the badges lead inline, the
 * prose follows, and the reports (rendered only once opened) sit at the
 * bottom. No-op unless this part actually holds an annotation report.
 */
function hoistAnnotations(
  segments: UserMessageSegment[],
  reportRefs: Set<string>
): UserMessageSegment[] {
  if (reportRefs.size === 0) return segments
  const badges: UserMessageSegment[] = []
  const reports: UserMessageSegment[] = []
  const rest: UserMessageSegment[] = []
  for (const segment of segments) {
    if (segment.kind === "annotation") reports.push(segment)
    else if (
      segment.kind === "reference" &&
      reportRefs.has(annotationKey(segment.attrs.uri ?? undefined) ?? "")
    )
      badges.push(segment)
    else rest.push(segment)
  }
  if (badges.length === 0) return segments
  // The lines the badges and blocks were lifted out of leave blank runs
  // behind: merge adjacent prose (into fresh objects — the parsed segments
  // stay untouched), fold 3+ newlines, trim the message ends.
  const prose: UserMessageSegment[] = []
  for (const segment of rest) {
    const last = prose[prose.length - 1]
    if (segment.kind === "text" && last?.kind === "text")
      last.text = last.text + segment.text
    else prose.push(segment.kind === "text" ? { ...segment } : segment)
  }
  prose.forEach((segment, index) => {
    if (segment.kind !== "text") return
    let text = segment.text.replace(/\n{3,}/g, "\n\n")
    if (index === 0) text = text.replace(/^\s+/, "")
    if (index === prose.length - 1) text = text.replace(/\s+$/, "")
    segment.text = text
  })
  const kept = prose.filter((s) => s.kind !== "text" || s.text.length > 0)
  return [...badges, ...kept, ...reports]
}

/**
 * One prose run: literal text with the five built-in reference kinds (file /
 * agent / session / commit / skill) resolved into inline colored badges, and
 * page-annotation reports kept for the badge that opens them. A bare
 * `/word`·`$word` is a skill badge only when the transcript's agent offers it
 * ({@link useKnownInvocations}); a path or any other slash word stays text.
 *
 * A fragment, not a wrapping element, so adjacent text and badges share one
 * inline flow and the caller's `whitespace-pre-wrap` collapses nothing.
 */
const TextRun = memo(function TextRun({ text }: { text: string }) {
  const knownInvocations = useKnownInvocations()
  const annotations = useContext(AnnotationOpenContext)
  const parsed = useMemo(
    () => parseUserMessageSegments(text, { knownInvocations }),
    [text, knownInvocations]
  )
  // A badge opens a report only where this MESSAGE carries one — reports may
  // sit in a sibling part (the provider knows the whole bubble), so merge
  // this part's own refs with the message-level set.
  const reportRefs = useMemo(
    () =>
      new Set([
        ...parsed.flatMap((s) =>
          s.kind === "annotation" ? [s.ref.split("#")[0]] : []
        ),
        ...(annotations?.reports ?? []),
      ]),
    [parsed, annotations]
  )
  const segments = useMemo(
    () => hoistAnnotations(parsed, reportRefs),
    [parsed, reportRefs]
  )
  return (
    <>
      {segments.map((segment, index) => {
        if (segment.kind === "annotation") {
          return annotations?.isOpen(segment.ref.split("#")[0]) ? (
            <AnnotationReport key={index} body={segment.body} />
          ) : null
        }
        if (segment.kind === "text") {
          return <span key={index}>{segment.text}</span>
        }
        if (segment.attrs.refType !== "file" || !segment.attrs.uri) {
          // A non-file reference (session, agent, commit, skill) has no path
          // and no report, so it stays a bare badge.
          return <ReferenceBadge key={index} data={segment.attrs} />
        }
        const key = annotationKey(segment.attrs.uri)
        const badge = <ReferenceBadge data={segment.attrs} />
        if (key !== null && reportRefs.has(key)) {
          // The badge stands for an annotation report in this message: a
          // click opens it under the bubble. It has no path to reveal.
          return (
            <button
              key={index}
              type="button"
              className="cursor-pointer"
              aria-expanded={annotations?.isOpen(key) ?? false}
              onClick={() => annotations?.toggle(key)}
            >
              {badge}
            </button>
          )
        }
        // Right-clicking a file badge opens its reveal / copy-path menu.
        return (
          <FileReferenceActions key={index} target={segment.attrs.uri}>
            {badge}
          </FileReferenceActions>
        )
      })}
    </>
  )
})

/**
 * Render one parsed block. A quote nests, so this recurses.
 *
 * The rule is `border-foreground/25`, not `border-border`: a user bubble sits on
 * `bg-secondary` (see `ai-elements/message.tsx`), where `--border` all but
 * disappears. Quoted text keeps the surrounding color rather than going muted —
 * muted on `bg-secondary` washes out, and the rule already marks it as quoted.
 */
function renderBlock(block: QuoteBlock, key: number) {
  if (block.kind === "quote") {
    return (
      <div
        key={key}
        data-testid="user-message-quote"
        className="my-1.5 border-s-2 border-foreground/25 ps-3 first:mt-0 last:mb-0"
      >
        {block.children.map(renderBlock)}
      </div>
    )
  }
  return (
    <div key={key} className="whitespace-pre-wrap">
      <TextRun text={block.text} />
    </div>
  )
}

/**
 * Read-only renderer for a USER message's text: plain text with literal line
 * breaks, and the five built-in reference kinds (file / agent / session / commit
 * / skill) shown as inline colored badges. Everything else — including Markdown
 * syntax like `# heading`, `**bold**`, `- item`, code fences — renders VERBATIM.
 *
 * This is the transcript counterpart of the plain-text composer: what the user
 * typed is what they see. Assistant/agent output keeps full Markdown via
 * {@link "@/components/ai-elements/message".MessageResponse} and must NOT use this.
 *
 * The ONE exception is a line-leading `>`, which renders as a quote rule instead
 * of a literal marker ({@link parseQuoteBlocks}) — the transcript's half of the
 * quote action, and the same treatment the composer's `.codeg-quote-marker`
 * decoration gives the draft, so a quote looks the same before and after
 * sending. Markdown rendering is NOT otherwise widened: only `>` is structural.
 *
 * `whitespace-pre-wrap` preserves the sender's newlines (replacing the old
 * `remark-breaks` path); `break-words` keeps long unbroken tokens from
 * overflowing the bubble. `dir="auto"` reads the message in the direction of
 * its own text, like everything else a person typed: an English message in the
 * Arabic interface keeps its full stop at the end.
 */
export const PlainTextWithBadges = memo(function PlainTextWithBadges({
  text,
  className,
}: {
  text: string
  className?: string
}) {
  const blocks = useMemo(() => parseQuoteBlocks(text), [text])

  // Fast path for the overwhelming majority of messages, which quote nothing:
  // one prose run, rendered by exactly the markup this component always emitted.
  if (blocks.length === 1 && blocks[0].kind === "text") {
    return (
      <div
        className={cn("whitespace-pre-wrap break-words", className)}
        dir="auto"
      >
        <TextRun text={blocks[0].text} />
      </div>
    )
  }

  return (
    <div className={cn("break-words", className)} dir="auto">
      {blocks.map(renderBlock)}
    </div>
  )
})
