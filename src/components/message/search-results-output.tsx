"use client"

/**
 * Result body for search-shaped tool calls (Grep / Glob, and codex's `search` /
 * `listFiles` command actions).
 *
 * codex-acp announces those calls with no `rawInput` and completes them with a
 * `{ formatted_output, exit_code }` envelope, so before this the card showed the
 * raw JSON. Here the unwrapped stdout is grouped per file with clickable paths
 * and line numbers; anything the parser can't confidently recognise falls back
 * to the plain code block the generic `<ToolOutput>` would have rendered.
 * Drawn inside an activity row's panel, edge to edge: the panel scrolls.
 */

import { useMemo, type ReactNode } from "react"
import { FileTextIcon, SearchXIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { CodeBlock } from "@/components/ai-elements/code-block"
import { FilePathLink } from "@/components/ai-elements/link-safety"
import { parseSearchOutput } from "@/lib/search-output"

interface Props {
  /** Unwrapped search stdout (envelope + CLI framing already stripped). */
  text: string
  /** Search pattern, highlighted in each matched line when it occurs literally. */
  query?: string | null
}

/**
 * Cap on `<mark>` elements per row. A short query (agents do write `rg "e"`)
 * against a long or minified matched line would otherwise mint one element per
 * occurrence — tens of thousands of nodes, enough to lock up the webview when
 * the card is expanded. Past the cap the rest of the line renders as plain text.
 */
const MAX_HIGHLIGHTS_PER_LINE = 100

/**
 * Highlight literal occurrences of `query` in `text`. The pattern is a regex on
 * the agent's side, so a literal search is intentionally the only thing tried —
 * a regex query simply renders unhighlighted rather than lighting up the wrong
 * characters.
 */
function highlightQuery(text: string, query: string | null | undefined) {
  const needle = query?.trim()
  if (!needle || needle.length > 200) return text

  const haystack = text.toLowerCase()
  const lowerNeedle = needle.toLowerCase()
  let at = haystack.indexOf(lowerNeedle)
  if (at < 0) return text

  const out: ReactNode[] = []
  let from = 0
  let key = 0
  while (at >= 0 && key < MAX_HIGHLIGHTS_PER_LINE) {
    if (at > from) out.push(text.slice(from, at))
    out.push(
      <mark
        key={key++}
        className="rounded bg-yellow-400/30 text-foreground dark:bg-yellow-300/25"
      >
        {text.slice(at, at + needle.length)}
      </mark>
    )
    from = at + needle.length
    at = haystack.indexOf(lowerNeedle, from)
  }
  if (from < text.length) out.push(text.slice(from))
  return out
}

export function SearchResultsOutput({ text, query }: Props) {
  const t = useTranslations("Folder.chat.contentParts")
  const parsed = useMemo(() => parseSearchOutput(text), [text])

  // Empty stdout from a search means "no matches" (rg/grep exit 1), which the
  // raw envelope rendered as `{"exit_code":1,"formatted_output":""}`.
  if (!text.trim()) {
    return (
      <div className="mx-3 flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
        <SearchXIcon className="size-3.5 shrink-0" />
        {t("search.noMatches")}
      </div>
    )
  }

  if (!parsed) {
    return (
      <div className="mx-3 overflow-hidden rounded-md bg-muted/50 text-xs">
        <CodeBlock code={text} language="log" />
      </div>
    )
  }

  const summary =
    parsed.mode === "matches"
      ? t("search.matchSummary", {
          matches: parsed.matchCount,
          files: parsed.fileCount,
        })
      : t("search.fileSummary", { files: parsed.fileCount })

  return (
    <div className="space-y-2">
      <div className="px-3 text-2xs text-muted-foreground">{summary}</div>
      {/* Straight in the row's panel, edge to edge: the panel caps the height
          and scrolls, and a box of its own inside it would nest a second
          scrollbar. */}
      <div className="divide-y divide-border/60 border-y border-border/60">
        {parsed.groups.map((group) => (
          <div key={group.path}>
            <div className="flex items-center gap-1.5 bg-muted/40 px-2.5 py-1.5">
              <FileTextIcon className="size-3 shrink-0 text-muted-foreground" />
              <FilePathLink
                filePath={group.path}
                className="min-w-0 flex-1 truncate text-left font-mono text-2xs text-foreground"
                title={group.path}
              >
                {group.path}
              </FilePathLink>
              {group.lines.length > 1 && (
                <span className="shrink-0 tabular-nums text-3xs text-muted-foreground">
                  {group.lines.length}
                </span>
              )}
            </div>
            {group.lines.length > 0 && (
              <div className="divide-y divide-border/30">
                {group.lines.map((entry, i) => (
                  <div
                    key={`${entry.line}-${i}`}
                    className="flex gap-2 px-2.5 py-1 font-mono text-2xs leading-[1.125rem] hover:bg-muted/30"
                  >
                    <FilePathLink
                      filePath={group.path}
                      line={entry.line}
                      className="w-10 shrink-0 text-right tabular-nums text-muted-foreground"
                    >
                      {entry.line}
                    </FilePathLink>
                    <span className="min-w-0 flex-1 whitespace-pre-wrap break-all text-foreground">
                      {highlightQuery(entry.text.replace(/^\s+/, ""), query)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      {parsed.hiddenCount > 0 && (
        <div className="px-3 text-2xs text-muted-foreground">
          {t("search.moreResults", { count: parsed.hiddenCount })}
        </div>
      )}
      {parsed.notes.length > 0 && (
        <div className="mx-3 space-y-0.5 rounded-md bg-muted/40 px-2.5 py-1.5 font-mono text-2xs text-muted-foreground">
          {parsed.notes.map((note, i) => (
            <div key={i} className="break-all">
              {note}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
