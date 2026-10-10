"use client"

import { memo, useMemo } from "react"

import { ReferenceBadge } from "@/components/chat/composer/badges/reference-badge"
import { parseQuoteBlocks, type QuoteBlock } from "@/lib/message-quote"
import { cn } from "@/lib/utils"

import { FileReferenceActions } from "./file-reference-actions"
import { useKnownInvocations } from "./known-invocations-context"
import { parseUserMessageSegments } from "./user-message-segments"

/**
 * One prose run: literal text with the five built-in reference kinds (file /
 * agent / session / commit / skill) resolved into inline colored badges. A bare
 * `/word`·`$word` is a skill badge only when the transcript's agent offers it
 * ({@link useKnownInvocations}); a path or any other slash word stays text.
 *
 * A fragment, not a wrapping element, so adjacent text and badges share one
 * inline flow and the caller's `whitespace-pre-wrap` collapses nothing.
 */
const TextRun = memo(function TextRun({ text }: { text: string }) {
  const knownInvocations = useKnownInvocations()
  const segments = useMemo(
    () => parseUserMessageSegments(text, { knownInvocations }),
    [text, knownInvocations]
  )
  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === "reference" ? (
          segment.attrs.refType === "file" && segment.attrs.uri ? (
            // Right-clicking a file badge opens its reveal / copy-path menu. A
            // non-file reference (session, agent, commit, skill) has no path, so
            // it stays a bare badge.
            <FileReferenceActions key={index} target={segment.attrs.uri}>
              <ReferenceBadge data={segment.attrs} />
            </FileReferenceActions>
          ) : (
            <ReferenceBadge key={index} data={segment.attrs} />
          )
        ) : (
          <span key={index}>{segment.text}</span>
        )
      )}
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
        className="my-1.5 border-l-2 border-foreground/25 pl-3 first:mt-0 last:mb-0"
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
 * overflowing the bubble.
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
      <div className={cn("whitespace-pre-wrap break-words", className)}>
        <TextRun text={blocks[0].text} />
      </div>
    )
  }

  return (
    <div className={cn("break-words", className)}>
      {blocks.map(renderBlock)}
    </div>
  )
})
