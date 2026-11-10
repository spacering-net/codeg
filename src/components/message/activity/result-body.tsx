"use client"

import { memo, useMemo } from "react"

import { MessageResponse } from "@/components/ai-elements/message"
import {
  JsonTreeView,
  parseJsonForTree,
} from "@/components/ai-elements/json-tree"
import { unwrapWholeFence } from "@/lib/fenced-text"
import { cn } from "@/lib/utils"

const MARKDOWN_SIGNS = [
  /^#{1,6}\s/m,
  /^\s*[-*+]\s/m,
  /^\s*\d+\.\s/m,
  /\*\*[^*]+\*\*/,
  /\[.+\]\(.+\)/,
  /```[\s\S]*?```/,
  /^\s*>/m,
  /^\|.+\|$/m,
]

/** Two or more Markdown constructs: worth rendering as Markdown. */
function looksLikeMarkdown(text: string): boolean {
  let count = 0
  for (const re of MARKDOWN_SIGNS) {
    if (re.test(text)) count++
    if (count >= 2) return true
  }
  return false
}

/** Longest result rendered in full; beyond it the tail is cut with a note. */
const MAX_RESULT_CHARS = 60_000
/** JSON up to this size reads best printed; past it, a foldable tree. */
const PRINTED_JSON_CHARS = 4_000

/**
 * A tool's result as the most readable thing it can be: a collapsible tree for
 * JSON, rendered Markdown for prose, plain monospace for everything else. Goes
 * inside a `DetailBox`, which supplies the surface and the height cap.
 */
export const ResultBody = memo(function ResultBody({
  text,
  tone = "neutral",
  className,
}: {
  text: string
  tone?: "neutral" | "danger"
  className?: string
}) {
  // Small JSON is pretty-printed text (what the reader expects to scan and
  // copy); a big payload gets the collapsible tree.
  const view = useMemo(() => {
    const body = unwrapWholeFence(
      text.length > MAX_RESULT_CHARS ? text.slice(0, MAX_RESULT_CHARS) : text
    )
    const trimmed = body.trimStart()
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      const json = parseJsonForTree(trimmed)
      if (json !== undefined) {
        if (body.length <= PRINTED_JSON_CHARS) {
          return {
            kind: "text" as const,
            body: JSON.stringify(json, null, 2),
          }
        }
        return { kind: "json" as const, json, body }
      }
    }
    if (looksLikeMarkdown(body)) return { kind: "markdown" as const, body }
    return { kind: "text" as const, body }
  }, [text])

  if (view.kind === "json") {
    return (
      <div className={cn("px-2 py-1.5 text-xs", className)}>
        <JsonTreeView value={view.json} rawText={view.body} />
      </div>
    )
  }
  if (view.kind === "markdown") {
    return (
      <div
        className={cn(
          "prose prose-sm dark:prose-invert max-w-none px-4 py-3 text-sm [&_ol]:list-inside [&_ul]:list-inside",
          className
        )}
      >
        <MessageResponse>{view.body}</MessageResponse>
      </div>
    )
  }
  return (
    <pre
      className={cn(
        "whitespace-pre-wrap break-words px-4 py-3 font-mono text-[0.78125rem] leading-relaxed",
        tone === "danger" ? "text-foreground" : "text-foreground/90",
        className
      )}
    >
      {view.body}
    </pre>
  )
})
