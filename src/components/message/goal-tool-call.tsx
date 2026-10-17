"use client"

import { memo, useMemo, useState, type ReactNode } from "react"
import type {
  AdaptedContentPart,
  AdaptedGoalRunPart,
} from "@/lib/adapters/ai-elements-adapter"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/instant-collapsible"
import { Shimmer } from "@/components/ai-elements/shimmer"
import { normalizeToolName } from "@/lib/tool-call-normalization"
import { cn } from "@/lib/utils"
import { unwrapWholeFence } from "@/lib/fenced-text"
import { ChevronRightIcon, PauseIcon, XIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useGoalControl } from "./goal-control-context"

type GoalToolPart = Extract<AdaptedContentPart, { type: "tool-call" }>

type ParsedGoal = {
  objective: string | null
  status: string | null
  tokensUsed: number | null
  tokenBudget: number | null
  timeUsedSeconds: number | null
  remainingTokens: number | null
}

type RenderGoalPart = (part: AdaptedContentPart, key: string) => ReactNode

function parseJsonObject(
  raw: string | null | undefined
): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null
    }
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function objectField(
  obj: Record<string, unknown> | null,
  key: string
): Record<string, unknown> | null {
  const value = obj?.[key]
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function stringField(
  obj: Record<string, unknown> | null,
  keys: string[]
): string | null {
  for (const key of keys) {
    const value = obj?.[key]
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim()
    }
  }
  return null
}

function numberField(
  obj: Record<string, unknown> | null,
  keys: string[]
): number | null {
  for (const key of keys) {
    const value = obj?.[key]
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return null
}

function parseGoal(
  startPart: GoalToolPart,
  endPart: GoalToolPart | null
): ParsedGoal {
  const startInput = parseJsonObject(startPart.input)
  const startOutput = parseJsonObject(
    startPart.output ?? startPart.errorText ?? null
  )
  const endInput = parseJsonObject(endPart?.input)
  const endOutput = parseJsonObject(endPart?.output ?? endPart?.errorText)
  const startGoal = objectField(startOutput, "goal")
  const endGoal = objectField(endOutput, "goal")

  return {
    objective:
      stringField(endGoal, ["objective"]) ??
      stringField(endInput, ["objective"]) ??
      stringField(startGoal, ["objective"]) ??
      stringField(startInput, ["objective"]),
    status:
      stringField(endGoal, ["status"]) ??
      stringField(endInput, ["status"]) ??
      stringField(startGoal, ["status"]) ??
      stringField(startInput, ["status"]) ??
      (normalizeToolName(startPart.toolName) === "create_goal"
        ? "active"
        : null),
    tokensUsed:
      numberField(endGoal, ["tokensUsed", "tokens_used"]) ??
      numberField(startGoal, ["tokensUsed", "tokens_used"]),
    tokenBudget:
      numberField(endGoal, ["tokenBudget", "token_budget"]) ??
      numberField(startGoal, ["tokenBudget", "token_budget"]) ??
      numberField(startInput, ["tokenBudget", "token_budget"]),
    timeUsedSeconds:
      numberField(endGoal, ["timeUsedSeconds", "time_used_seconds"]) ??
      numberField(startGoal, ["timeUsedSeconds", "time_used_seconds"]),
    remainingTokens:
      numberField(endOutput, ["remainingTokens", "remaining_tokens"]) ??
      numberField(startOutput, ["remainingTokens", "remaining_tokens"]),
  }
}

function normalizeStatus(status: string | null): string | null {
  if (!status) return null
  return status.toLowerCase().replace(/[\s-]+/g, "_")
}

function formatTokens(count: number | null, tokenLabel: string): string | null {
  if (count === null) return null
  const abs = Math.abs(count)
  if (abs >= 1000) {
    const compact = (count / 1000).toFixed(1).replace(/\.0$/, "")
    return `${compact}K ${tokenLabel}`
  }
  return `${count} ${tokenLabel}`
}

function formatDuration(seconds: number | null): string | null {
  if (seconds === null) return null
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = seconds / 60
  if (minutes < 60) return `${minutes.toFixed(1).replace(/\.0$/, "")}m`
  const hours = minutes / 60
  return `${hours.toFixed(1).replace(/\.0$/, "")}h`
}

function statusTone(
  status: string | null
): "active" | "complete" | "error" | "muted" {
  switch (normalizeStatus(status)) {
    case "active":
      return "active"
    case "complete":
    case "completed":
      return "complete"
    case "blocked":
    case "usage_limited":
    case "budget_limited":
    // Neutral goal-extension snapshots (claude-agent-acp 0.66+/codex-acp
    // 1.2+) collapse usageLimited/budgetLimited into "limited" adapter-side.
    case "limited":
    case "failed":
      return "error"
    case "paused":
      return "muted"
    default:
      return "muted"
  }
}

function goalStatusLabel(
  status: string | null,
  normalizedStatus: string | null,
  t: ReturnType<typeof useTranslations>
): string | null {
  switch (normalizedStatus) {
    case "active":
      return t("status.active")
    case "paused":
      return t("status.paused")
    case "blocked":
      return t("status.blocked")
    case "usage_limited":
      return t("status.usageLimited")
    case "budget_limited":
      return t("status.budgetLimited")
    case "limited":
      return t("status.limited")
    case "complete":
    case "completed":
      return t("status.complete")
    default:
      return status
  }
}

function formatGoalHeaderText(title: string, objective: string | null): string {
  if (!objective) return title
  return title.endsWith("：") ? `${title}${objective}` : `${title} ${objective}`
}

function GoalCard({
  startPart,
  endPart,
  items = [],
  forceRunning,
  renderPart,
}: {
  startPart: GoalToolPart
  endPart: GoalToolPart | null
  items?: AdaptedContentPart[]
  forceRunning?: boolean
  renderPart?: RenderGoalPart
}) {
  const t = useTranslations("Folder.chat.contentParts.goal")
  const inferredRunning =
    startPart.state === "input-available" ||
    startPart.state === "input-streaming" ||
    endPart?.state === "input-available" ||
    endPart?.state === "input-streaming"
  const isRunning = forceRunning ?? inferredRunning
  const isError =
    startPart.state === "output-error" ||
    Boolean(startPart.errorText) ||
    endPart?.state === "output-error" ||
    Boolean(endPart?.errorText)
  // Derived, not mount-initialised: a `useState` seed is evaluated once, and
  // the card always mounts BEFORE its body exists (create_goal is adapted on
  // its own, so the run starts with `items: []`). Seeding would leave the
  // default hostage to whether the row happens to remount later — it does on
  // the sub-turn merge and on virtualizer recycling, but not on a plain
  // same-key update. Deriving keeps the DEFAULT a function of the data:
  // a live run opens as soon as it holds anything, settling collapses it
  // again (its answer has been lifted out by then), and an error opens even
  // when it lands late. `userOpen` is the manual override and wins once set,
  // so any of those defaults yields to a deliberate toggle.
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const bodyOpen = userOpen ?? (isError || (isRunning && items.length > 0))
  const goal = useMemo(
    () => parseGoal(startPart, endPart),
    [startPart, endPart]
  )
  const normalizedStatus = normalizeStatus(goal.status)
  const statusLabel = goalStatusLabel(goal.status, normalizedStatus, t)
  const title = t("title")
  const headerText = formatGoalHeaderText(title, goal.objective)
  const tone = isError ? "error" : statusTone(goal.status)
  const tokenSummary = formatTokens(goal.tokensUsed, t("tokens"))
  const budgetSummary = formatTokens(goal.tokenBudget, t("tokens"))
  const remainingSummary = formatTokens(goal.remainingTokens, t("tokens"))
  const durationSummary = formatDuration(goal.timeUsedSeconds)

  const errorText = endPart?.errorText ?? startPart.errorText

  // Pause/Clear are only offered for a live, controllable goal (the provider
  // supplies a callback only when the session is live and the user owns it; it
  // is `null` on history reload / for viewers / in the read-only sub-agent
  // dialog), AND only when the adapter's advertised action vocabulary carries
  // the action — claude's neutral goal extension offers no "pause", so its
  // cards show Clear alone. Pause applies to an active goal; Clear to active
  // OR paused. No "resume" control — resuming is re-issuing the `/goal`
  // prompt.
  const { onGoalControl, actions: goalActions } = useGoalControl()
  const showPause =
    Boolean(onGoalControl) &&
    goalActions.includes("pause") &&
    normalizedStatus === "active"
  const showClear =
    Boolean(onGoalControl) &&
    goalActions.includes("clear") &&
    (normalizedStatus === "active" || normalizedStatus === "paused")

  return (
    <Collapsible open={bodyOpen} onOpenChange={setUserOpen} className="w-full">
      <CollapsibleTrigger
        className={cn(
          "group inline-flex max-w-full items-center gap-1.5 rounded-full px-3.5 py-2 text-xs font-medium transition-colors",
          "bg-primary/10 text-foreground hover:bg-primary/15",
          tone === "error" &&
            "bg-destructive/10 text-destructive hover:bg-destructive/15",
          tone === "muted" && "bg-muted/70 text-foreground hover:bg-muted"
        )}
        aria-label={headerText}
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={cn(
            "size-3 shrink-0 opacity-60 transition-transform",
            bodyOpen && "rotate-90"
          )}
        />
        <span className="min-w-0 truncate">
          {isRunning ? (
            <Shimmer as="span" duration={1} shineColor="var(--primary)">
              {headerText}
            </Shimmer>
          ) : (
            headerText
          )}
        </span>
        {tokenSummary && (
          <span className="shrink-0 text-muted-foreground/60">
            {tokenSummary}
          </span>
        )}
        {durationSummary && (
          <span className="shrink-0 text-muted-foreground/60">
            {durationSummary}
          </span>
        )}
      </CollapsibleTrigger>

      <CollapsibleContent
        className={cn(
          "w-full outline-none",
          "data-[state=open]:animate-in data-[state=closed]:animate-out",
          "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
          "data-[state=closed]:slide-out-to-top-1 data-[state=open]:slide-in-from-top-1"
        )}
      >
        <div className="mt-3 w-full rounded-md border border-border/60 px-3.5 py-3 text-sm">
          <div className="space-y-3">
            {goal.objective && (
              <div>
                <div className="mb-1 text-xs font-medium text-muted-foreground">
                  {t("objective")}
                </div>
                <div className="break-words">{goal.objective}</div>
              </div>
            )}

            {items.length > 0 && renderPart && (
              <div className="space-y-3">
                {items.map((item, index) =>
                  renderPart(item, `goal-run-item-${index}`)
                )}
              </div>
            )}

            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {statusLabel && (
                <span>
                  {t("statusLabel")}:{" "}
                  <span className="font-medium text-foreground">
                    {statusLabel}
                  </span>
                </span>
              )}
              {tokenSummary && (
                <span>
                  {t("tokensUsed")}:{" "}
                  <span className="font-medium text-foreground">
                    {tokenSummary}
                  </span>
                </span>
              )}
              {budgetSummary && (
                <span>
                  {t("budget")}:{" "}
                  <span className="font-medium text-foreground">
                    {budgetSummary}
                  </span>
                </span>
              )}
              {remainingSummary && (
                <span>
                  {t("remaining")}:{" "}
                  <span className="font-medium text-foreground">
                    {remainingSummary}
                  </span>
                </span>
              )}
              {durationSummary && (
                <span>
                  {t("elapsed")}:{" "}
                  <span className="font-medium text-foreground">
                    {durationSummary}
                  </span>
                </span>
              )}
            </div>

            {(showPause || showClear) && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {showPause && (
                  <button
                    type="button"
                    onClick={() => onGoalControl?.("pause")}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <PauseIcon aria-hidden="true" className="size-3" />
                    {t("pause")}
                  </button>
                )}
                {showClear && (
                  <button
                    type="button"
                    onClick={() => onGoalControl?.("clear")}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <XIcon aria-hidden="true" className="size-3" />
                    {t("clear")}
                  </button>
                )}
              </div>
            )}

            {isError && errorText && (
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-destructive/10 p-3 text-xs text-destructive">
                {unwrapWholeFence(errorText)}
              </pre>
            )}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

export const GoalToolCallPart = memo(function GoalToolCallPart({
  part,
}: {
  part: GoalToolPart
}) {
  return <GoalCard startPart={part} endPart={null} />
})

export const GoalRunPart = memo(function GoalRunPart({
  part,
  renderPart,
}: {
  part: AdaptedGoalRunPart
  renderPart: RenderGoalPart
}) {
  return (
    <GoalCard
      startPart={part.start}
      endPart={part.end}
      items={part.items}
      forceRunning={part.isRunning}
      renderPart={renderPart}
    />
  )
})
