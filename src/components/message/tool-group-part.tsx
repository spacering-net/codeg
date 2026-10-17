import { memo, useMemo, useState, type ReactNode } from "react"
import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"
import {
  classifyToolKind,
  TOOL_KIND_ORDER,
  type ToolKindLabel,
} from "@/lib/adapters/tool-kind-classifier"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import { Shimmer } from "@/components/ai-elements/shimmer"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/instant-collapsible"
import { ChevronRightIcon } from "lucide-react"

export type AdaptedToolCallPart = Extract<
  AdaptedContentPart,
  { type: "tool-call" }
>
export type AdaptedToolGroupPart = Extract<
  AdaptedContentPart,
  { type: "tool-group" }
>

/**
 * One segment of an ordered display stream: a run of consecutive tool calls
 * (collapsed into one pill group) or a single non-tool entry that breaks the
 * run. Same semantics as the main thread's `groupConsecutiveToolCalls`, but
 * over already-materialized display items instead of adapter parts — callers
 * that must interleave prose/thinking with tool cards (e.g. the sub-agent
 * timeline) build the display stream first, then group it with this.
 */
export type ToolRunSegment<TCall, TOther> =
  | { kind: "calls"; calls: TCall[]; start: number }
  | { kind: "other"; value: TOther; index: number }

export function groupConsecutiveToolRuns<TCall, TOther>(
  display: Array<{ call?: TCall; other?: TOther }>
): Array<ToolRunSegment<TCall, TOther>> {
  const segments: Array<ToolRunSegment<TCall, TOther>> = []
  let run: { calls: TCall[]; start: number } | null = null
  display.forEach((item, index) => {
    if (item.call !== undefined) {
      if (!run) {
        run = { calls: [], start: index }
        segments.push({ kind: "calls", calls: run.calls, start: run.start })
      }
      run.calls.push(item.call)
      return
    }
    run = null
    if (item.other !== undefined) {
      segments.push({ kind: "other", value: item.other, index })
    }
  })
  return segments
}

/**
 * The summary pill the main thread folds consecutive tool calls into.
 * Shared so other card bodies (e.g. the sub-agent capsule) can collapse
 * their own tool runs with the exact same look and behavior. Single-item
 * groups fold too — one call reads as one pill, matching the main thread.
 *
 * The child rendering is injected (`renderItem`) rather than imported:
 * the natural child is the renderer's `ToolCallPart`, and importing it here
 * would close a cycle back through `content-parts-renderer`.
 */
export const ToolGroupPart = memo(function ToolGroupPart({
  part,
  renderItem,
}: {
  part: AdaptedToolGroupPart
  renderItem: (item: AdaptedToolCallPart, key: string) => ReactNode
}) {
  const t = useTranslations("Folder.chat.contentParts.toolGroup")
  const [open, setOpen] = useState(false)

  const { phrases, errorPhrase } = useMemo(() => {
    const counts = TOOL_KIND_ORDER.reduce(
      (acc, kind) => {
        acc[kind] = 0
        return acc
      },
      {} as Record<ToolKindLabel, number>
    )
    let errors = 0
    for (const item of part.items) {
      counts[classifyToolKind(item.toolName)] += 1
      if (item.state === "output-error" || item.errorText) errors += 1
    }
    const built: string[] = []
    for (const kind of TOOL_KIND_ORDER) {
      const count = counts[kind]
      if (count <= 0) continue
      built.push(t(kind, { count }))
    }
    if (built.length === 0) {
      built.push(t("other", { count: part.items.length }))
    }
    return {
      phrases: built,
      errorPhrase: errors > 0 ? t("errorSuffix", { count: errors }) : null,
    }
  }, [part, t])

  if (part.items.length === 0) return null

  const joiner = t("joiner")
  const titleText = phrases.join(joiner)

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="w-full">
      <CollapsibleTrigger
        className={cn(
          "group inline-flex max-w-full items-center gap-1.5 rounded-full bg-muted/60 px-3.5 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground ws-msg-chip"
        )}
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={cn(
            "size-3 shrink-0 opacity-60 transition-transform",
            open && "rotate-90"
          )}
        />
        <span className="min-w-0 truncate">
          {part.isStreaming ? (
            <Shimmer as="span" duration={1} shineColor="var(--primary)">
              {titleText}
            </Shimmer>
          ) : (
            titleText
          )}
          {errorPhrase && (
            <span className="text-destructive">
              {joiner}
              {errorPhrase}
            </span>
          )}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent
        className={cn(
          "w-full outline-none",
          "data-[state=open]:animate-in data-[state=closed]:animate-out",
          "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
          "data-[state=closed]:slide-out-to-top-1 data-[state=open]:slide-in-from-top-1"
        )}
      >
        <div className="mt-3 w-full space-y-3">
          {part.items.map((item, idx) =>
            renderItem(item, `grouped-tc-${item.toolCallId ?? idx}-${idx}`)
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
})
