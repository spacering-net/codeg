"use client"

import { memo } from "react"
import { useTranslations } from "next-intl"
import { ChevronDownIcon, ChevronUpIcon, ListTodoIcon } from "lucide-react"

import type { ToolCallState } from "@/lib/adapters/ai-elements-adapter"
import { asRecord, extractPlanMarkdown } from "@/lib/plan-parse"
import { MessageResponse } from "@/components/ai-elements/message"
import { useCollapsibleOverflow } from "@/hooks/use-collapsible-overflow"
import { cn } from "@/lib/utils"
import { unwrapWholeFence } from "@/lib/fenced-text"

/**
 * Dedicated rendering for plan-*mode* transition tools — Claude Code's
 * `EnterPlanMode`/`ExitPlanMode`, Cline's `switch_mode`, and codex-acp
 * ≥1.1.8's `plan_review` gate. These are mode signals, not work tools, so they
 * render directly here instead of folding into the misleading "思考 N 次"
 * tool-group (see `isPlanModeToolName` in `plan-parse.ts` and the run-break in
 * `groupConsecutiveToolCalls`).
 *
 * Content-driven, not name-driven:
 *   - input carries freeform plan markdown (ExitPlanMode, or a switch_mode that
 *     proposes a plan) → render the plan directly as a card.
 *   - otherwise → a compact, non-collapsible mode marker. `enterplanmode` and
 *     `exitplanmode` get plan-specific labels; a non-plan `switch_mode` gets a
 *     neutral "switched mode" marker (never mislabeled as a plan);
 *     `plan_review` reports the user's decision.
 */

function parseInput(input: string | null): Record<string, unknown> | null {
  if (!input) return null
  try {
    return asRecord(JSON.parse(input))
  } catch {
    return null
  }
}

/**
 * Plan documents are frequently long enough to bury the rest of the turn, so
 * the body is clamped to the same height the sibling checklist `<PlanCard>`
 * scrolls at and gets a "Show more"/"Show less" footer once it's actually
 * clipped — the same `useCollapsibleOverflow` affordance user messages use.
 *
 * Exported because a codex plan reaches the UI through two different carriers
 * that must not look like two different features: the live `plan_review` tool
 * call's `rawInput.plan` (here) and the `<proposed_plan>` block lifted out of
 * assistant text (`ProposedPlanPart` in `content-parts-renderer.tsx`). Both
 * render THIS component with the same label, so the prose styling and the
 * clamp/expand affordance can't drift between live and reload.
 *
 * `emptyLabel` covers the streaming case where the block has opened but no
 * markdown has arrived yet; without one an empty plan renders as bare chrome.
 */
export function PlanMarkdownCard({
  markdown,
  label,
  emptyLabel,
}: {
  markdown: string
  label: string
  emptyLabel?: string
}) {
  const t = useTranslations("Folder.chat.messageList")
  const { contentRef, contentId, isOverflowing, expanded, toggle } =
    useCollapsibleOverflow<HTMLDivElement>(markdown)

  const clipped = !expanded

  return (
    <div className="w-full overflow-hidden rounded-md border border-border/60">
      <div className="flex items-center gap-1.5 border-b border-border/60 bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">
        <ListTodoIcon className="size-3.5 shrink-0" />
        {label}
      </div>
      <div
        ref={contentRef}
        id={contentId}
        data-testid="plan-mode-card-content"
        className={cn(
          "prose prose-sm max-w-none px-3.5 py-3 text-sm dark:prose-invert [&_ol]:list-inside [&_ul]:list-inside",
          clipped && "max-h-72 overflow-hidden",
          clipped && isOverflowing && "collapsed-content-fade"
        )}
      >
        {markdown.length > 0 ? (
          <MessageResponse>{markdown}</MessageResponse>
        ) : (
          emptyLabel && (
            <span className="text-muted-foreground">{emptyLabel}</span>
          )
        )}
      </div>
      {isOverflowing && (
        <button
          type="button"
          data-testid="plan-mode-card-toggle"
          onClick={toggle}
          aria-expanded={expanded}
          aria-controls={contentId}
          className="flex w-full items-center justify-center gap-1 border-t border-border/60 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
        >
          {expanded ? t("showLess") : t("showMore")}
          {expanded ? (
            <ChevronUpIcon className="size-3.5 shrink-0" />
          ) : (
            <ChevronDownIcon className="size-3.5 shrink-0" />
          )}
        </button>
      )}
    </div>
  )
}

function PlanModeMarker({ label }: { label: string }) {
  return (
    <div className="inline-flex items-center gap-1.5 rounded-full bg-muted/60 px-3 py-1.5 text-xs font-medium text-muted-foreground">
      <ListTodoIcon className="size-3.5 shrink-0 opacity-70" />
      {label}
    </div>
  )
}

/**
 * codex-acp's own wording for an approved plan review, echoed back as the
 * tool call's `rawOutput` (`"User approved the plan."`; the other branch is
 * `"User kept the session in plan mode."`). Matching the adapter's constant is
 * the same pragmatism `parseCodexSearchTitle` and `is_mcp_tool_call_approval`
 * already apply to codex-specific wire strings. Anything unrecognised falls
 * back to the "kept in plan mode" label, so a wording change downgrades the
 * marker rather than mislabeling an approval.
 */
const CODEX_PLAN_APPROVED_PREFIX = "User approved"

export const PlanModeCard = memo(function PlanModeCard({
  toolName,
  input,
  output = null,
  errorText,
  state,
}: {
  /** Normalized (tool-call-normalization) form: enterplanmode|exitplanmode|switch_mode|plan_review. */
  toolName: string
  input: string | null
  /** Tool result text. Only read for `plan_review`, to report the decision. */
  output?: string | null
  errorText: string | null
  state: ToolCallState
}) {
  const t = useTranslations("Folder.chat.contentParts")
  // The plan card's own title comes from the `proposedPlan` namespace so this
  // card and `ProposedPlanPart` cannot be titled differently — they are the
  // same plan document arriving by two routes.
  const tPlan = useTranslations("Folder.chat.proposedPlan")
  const parsed = parseInput(input)
  const planMarkdown = parsed ? extractPlanMarkdown(parsed) : null
  const isError = state === "output-error" || !!errorText?.trim()

  const markerLabel = (() => {
    if (toolName === "exitplanmode") return t("planMode.submitted")
    if (toolName === "plan_review") {
      // While the permission card is still open the seeded call is unsettled
      // (`input-available`, no output yet). Reporting a decision here would
      // state an outcome the user has not chosen — say "awaiting" until the
      // tool call settles, then read the decision off the output.
      const settled = state === "output-available" || state === "output-error"
      if (!settled) return t("planMode.reviewPending")
      return output?.trimStart().startsWith(CODEX_PLAN_APPROVED_PREFIX)
        ? t("planMode.reviewApproved")
        : t("planMode.reviewKept")
    }
    if (toolName === "switch_mode") {
      const mode =
        typeof parsed?.mode === "string"
          ? parsed.mode
          : typeof parsed?.mode_slug === "string"
            ? parsed.mode_slug
            : null
      return mode
        ? `${t("planMode.switched")} · ${mode}`
        : t("planMode.switched")
    }
    return t("planMode.entered")
  })()

  // codex's review gate is the one plan-mode tool whose marker says something
  // the card does not: the plan is the card, the DECISION is the marker. Show
  // both. The other plan-mode tools keep the either/or shape, where the marker
  // would only restate the card it sits under.
  const showsDecision = toolName === "plan_review"

  return (
    <div className={cn(planMarkdown ? "w-full space-y-2" : "space-y-2")}>
      {planMarkdown && (
        <PlanMarkdownCard markdown={planMarkdown} label={tPlan("title")} />
      )}
      {(!planMarkdown || showsDecision) && (
        <PlanModeMarker label={markerLabel} />
      )}
      {isError && errorText && (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-destructive/10 p-3 text-xs text-destructive">
          {unwrapWholeFence(errorText)}
        </pre>
      )}
    </div>
  )
})
