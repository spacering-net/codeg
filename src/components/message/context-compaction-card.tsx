"use client"

/**
 * codex-acp #288 (v1.1.3+): the context-compaction lifecycle arrives as an ACP
 * `tool_call` tagged with `_meta.contextCompaction` — NOT under the `codex`
 * namespace, unlike codex's other `_meta` extensions. Through 1.2.x the tag is
 * the boolean `true`; 1.3.0 (#396) replaces it with the versioned object
 * `{version: 1, …}` on a claude-aligned lifecycle (kind "think", title
 * "Compact conversation", in_progress → completed sharing one `toolCallId`)
 * whose schema reserves optional `trigger`/`preTokens`/`postTokens`/
 * `durationMs`/`error` fields — 1.3.0 emits none of them yet. Grok's
 * `auto_compact_completed` bridge keeps synthesizing the boolean shape with
 * top-level `tokensBefore`/`tokensAfter`, so the delta label reads both
 * namings.
 *
 * claude-agent-acp 0.75.0 (#991) adopted the same versioned shape and is the
 * first adapter to fill every reserved field, so this card's full label —
 * counts, duration and trigger together — is only reachable there today.
 *
 * Rendered as a centered, chrome-less divider (a horizontal rule flanking a
 * token-delta label) so it reads as a conversation boundary marker — "context
 * was compacted here" — not a real tool call. Recognition is by `_meta`, so it
 * works for the live stream and DB/snapshot reloads. In history the compaction
 * is hoisted to a dedicated standalone timeline item (see `message-list-view`'s
 * `"compaction"` render kind) so it sits BETWEEN turns rather than folding into
 * the preceding assistant reply.
 *
 * The ACP compaction lifecycle (claude-agent-acp 0.78.0+, codex-acp 1.13.0+)
 * can also carry the RETAINED SUMMARY — what the model kept of the dropped
 * history. When it does, the divider grows a "Summary" toggle that opens it
 * beneath the rule, collapsed by default so the boundary stays one line. Only
 * a summary the backend explicitly claims is shown (see
 * `contextCompactionSummary`); history dividers carry none, because claude's
 * transcript keeps the summary in its own continuation turn below the divider.
 */

import { useId, useState } from "react"
import { useTranslations } from "next-intl"
import { Archive, ChevronDown, ChevronUp } from "lucide-react"

import { MessageResponse } from "@/components/ai-elements/message"
import { useCollapsibleOverflow } from "@/hooks/use-collapsible-overflow"
import type { ToolCallState } from "@/lib/adapters/ai-elements-adapter"
import { contextCompactionPayload } from "@/lib/context-compaction"
import { cn } from "@/lib/utils"

// `isContextCompactionMeta` now lives in the dependency-free
// `@/lib/context-compaction` module (shared with the grouping pass); re-exported
// here so existing importers keep resolving it from this file.
export { isContextCompactionMeta } from "@/lib/context-compaction"

/** Read a finite numeric field off an opaque record. */
function readNumber(
  source: Record<string, unknown> | null | undefined,
  key: string
): number | null {
  if (!source) return null
  const value = source[key]
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/** Read a non-blank string field off an opaque record. */
function readText(
  source: Record<string, unknown> | null | undefined,
  key: string
): string | null {
  if (!source) return null
  const value = source[key]
  return typeof value === "string" && value.trim().length > 0 ? value : null
}

/**
 * The two triggers every adapter agrees on, mapped to their message key.
 *
 * Deliberately not exhaustive: `trigger` is adapter-defined vocabulary, and an
 * unrecognized value falls back to its raw string rather than being dropped or
 * mislabelled. The automatic case has two spellings in the wild — claude
 * renames the SDK's `auto` to `automatic` on the wire (and `parsers/claude.rs`
 * mirrors that rename for history), while deepseek's parser passes `auto`
 * through — so both map to the same key.
 */
const TRIGGER_KEYS: Record<string, "triggerManual" | "triggerAutomatic"> = {
  manual: "triggerManual",
  auto: "triggerAutomatic",
  automatic: "triggerAutomatic",
}

/** `durationMs` as a compact human label ("3.2s" / "45s"), or null. */
function formatDuration(durationMs: number | null): string | null {
  if (durationMs === null || durationMs <= 0) return null
  const seconds = durationMs / 1000
  return `${seconds >= 10 ? Math.round(seconds) : seconds.toFixed(1)}s`
}

interface Props {
  state?: ToolCallState
  /**
   * ACP tool-call `_meta`. grok stamps top-level `tokensBefore`/`tokensAfter`
   * next to its boolean marker; codex 1.3.0+ nests reserved fields inside the
   * versioned `contextCompaction` object (`preTokens`/`postTokens`/
   * `durationMs`/`trigger`/`error`). Every field may be absent — 1.3.0 sends
   * the bare `{version: 1}` — and the card then renders exactly as before.
   */
  meta?: Record<string, unknown> | null
  /**
   * The retained summary, already vetted by `contextCompactionSummary`. May
   * still be streaming in while `state` is running.
   */
  summary?: string | null
}

/**
 * The expanded summary: clamped to the same `max-h-72` preview as the other
 * collapsible transcript bodies (`CollapsibleSystemMessage`), with a footer
 * toggle that only appears once the text is actually cut off.
 */
function CompactionSummaryBody({
  id,
  summary,
  isStreaming,
}: {
  id: string
  summary: string
  isStreaming: boolean
}) {
  const t = useTranslations("Folder.chat.messageList")
  const { contentRef, isOverflowing, expanded, toggle } =
    useCollapsibleOverflow<HTMLDivElement>(summary)
  const clipped = !expanded
  return (
    <div
      id={id}
      data-testid="context-compaction-summary"
      className="mt-1 overflow-hidden rounded-md border border-border/60 bg-muted/30"
    >
      <div
        ref={contentRef}
        className={cn(
          'break-words px-3 py-2.5 text-sm text-muted-foreground prose prose-sm dark:prose-invert max-w-none [&_ul]:list-inside [&_ol]:list-inside [&_[data-streamdown="code-block-body"]]:max-h-96 [&_[data-streamdown="code-block-body"]]:overflow-auto',
          clipped && "max-h-72 overflow-hidden",
          clipped && isOverflowing && "collapsed-content-fade"
        )}
      >
        <MessageResponse
          mode={isStreaming ? "streaming" : "static"}
          parseIncompleteMarkdown={isStreaming}
        >
          {summary}
        </MessageResponse>
      </div>
      {isOverflowing && (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={expanded}
          className="flex w-full items-center justify-center gap-1 border-t border-border/60 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50"
        >
          {expanded ? t("showLess") : t("showMore")}
          {expanded ? (
            <ChevronUp className="size-3.5 shrink-0" />
          ) : (
            <ChevronDown className="size-3.5 shrink-0" />
          )}
        </button>
      )}
    </div>
  )
}

export function ContextCompactionCard({ state, meta, summary }: Props) {
  const t = useTranslations("Folder.chat.contextCompaction")
  const [summaryOpen, setSummaryOpen] = useState(false)
  const summaryId = useId()
  const isRunning = state === "input-streaming" || state === "input-available"
  const payload = contextCompactionPayload(meta)
  const before =
    readNumber(meta, "tokensBefore") ?? readNumber(payload, "preTokens")
  const after =
    readNumber(meta, "tokensAfter") ?? readNumber(payload, "postTokens")
  const errorText = readText(payload, "error")
  const failed = errorText !== null || state === "output-error"
  const duration = formatDuration(readNumber(payload, "durationMs"))
  // Trigger and error ride in the tooltip rather than inline prose — they
  // answer "why did this happen", which is a second-order question next to the
  // delta. Only the two shared triggers are translated; anything else is an
  // adapter's own word and is surfaced verbatim.
  const trigger = readText(payload, "trigger")
  const triggerKey = trigger ? TRIGGER_KEYS[trigger.toLowerCase()] : undefined
  const tooltip =
    errorText ?? (triggerKey ? t(triggerKey) : trigger) ?? undefined
  // Only show the delta when it's a real reduction — a no-op (before === after)
  // would read as a bug, so fall back to the plain label there and for codex
  // (which sends no counts).
  const label = failed
    ? t("failed")
    : isRunning
      ? t("compacting")
      : before !== null && after !== null && before !== after
        ? t("compactedTokens", {
            before: before.toLocaleString(),
            after: after.toLocaleString(),
          })
        : t("compacted")
  const summaryText =
    typeof summary === "string" && summary.trim().length > 0 ? summary : null
  const divider = (
    <div className="flex items-center gap-3 py-1 text-xs text-muted-foreground/80 select-none">
      <div className="h-px flex-1 bg-gradient-to-r from-transparent to-border/70" />
      <div
        className={`flex shrink-0 items-center gap-1.5${failed ? " text-destructive/80" : ""}`}
        title={tooltip}
      >
        <Archive className="size-3.5" />
        <span className={isRunning ? "animate-pulse" : undefined}>{label}</span>
        {!failed && !isRunning && duration ? (
          <span className="text-muted-foreground/60">· {duration}</span>
        ) : null}
      </div>
      {summaryText !== null ? (
        <button
          type="button"
          onClick={() => setSummaryOpen((open) => !open)}
          aria-expanded={summaryOpen}
          aria-controls={summaryOpen ? summaryId : undefined}
          className="flex shrink-0 items-center gap-0.5 rounded px-1 text-muted-foreground/80 transition-colors hover:bg-muted/60 hover:text-foreground"
        >
          {t("summary")}
          {summaryOpen ? (
            <ChevronUp className="size-3.5" />
          ) : (
            <ChevronDown className="size-3.5" />
          )}
        </button>
      ) : null}
      <div className="h-px flex-1 bg-gradient-to-l from-transparent to-border/70" />
    </div>
  )
  if (summaryText === null) return divider
  return (
    <div>
      {divider}
      {summaryOpen ? (
        <CompactionSummaryBody
          id={summaryId}
          summary={summaryText}
          isStreaming={isRunning}
        />
      ) : null}
    </div>
  )
}
