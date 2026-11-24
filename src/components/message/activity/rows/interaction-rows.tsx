"use client"

import { memo, useMemo } from "react"
import { useLocale, useTranslations } from "next-intl"
import { MapIcon, MessagesSquareIcon } from "lucide-react"

import type { StepStatus } from "@/lib/activity/types"
import { parseFeedbackCheckOutcome } from "@/lib/feedback-check"
import { unwrapWholeFence } from "@/lib/fenced-text"
import { normalizeToolName } from "@/lib/tool-call-normalization"
import { PlanMarkdownCard, usePlanModeMarker } from "../../plan-mode-card"
import { ActivityRow } from "../activity-row"
import { DetailBox } from "../detail-box"
import { useDisclosure } from "../disclosure-store"
import { RailIcon } from "../rail-icon"
import { StatusFigure, useStatusText } from "../step-visuals"
import type { ToolStep } from "./explore-rows"

/** The plan document's first heading or line, for the row's label. */
function planTitle(markdown: string | null): string | null {
  const line = markdown
    ?.split("\n")
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .find((l) => l.length > 0)
  return line ? line.slice(0, 120) : null
}

/**
 * A plan-mode transition — `Entered plan mode`, `Submitted a plan · Wire the
 * report filter`, codex's plan review decision. A step that carries the plan
 * document opens to it by default: in a plan-mode turn the plan is what the
 * reader came for.
 */
export const PlanModeRow = memo(function PlanModeRow({
  step,
}: {
  step: ToolStep
}) {
  const t = useTranslations("Folder.chat.activity")
  const tPlan = useTranslations("Folder.chat.proposedPlan")
  const statusText = useStatusText()
  const { part, tool } = step
  const { planMarkdown, markerLabel, isError } = usePlanModeMarker({
    toolName: normalizeToolName(part.toolName).toLowerCase(),
    input: part.input,
    output: part.output ?? null,
    errorText: part.errorText ?? null,
    state: part.state,
  })
  const [open, setOpen] = useDisclosure(step.key, {
    defaultOpen: planMarkdown !== null,
    force: isError,
  })
  const title = planTitle(planMarkdown)
  const status: StepStatus = isError ? "failed" : tool.status

  return (
    <ActivityRow
      stepKey={step.key}
      status={status}
      marker={
        <RailIcon
          icon={MapIcon}
          status={status}
          label={`${t("kind.plan")}, ${statusText(status)}`}
        />
      }
      expandable={planMarkdown !== null || isError}
      expanded={open}
      onExpandedChange={setOpen}
      title={title ?? undefined}
      trailing={isError ? <StatusFigure status="failed" /> : null}
      detail={() => (
        <div className="space-y-2">
          {planMarkdown !== null ? (
            <PlanMarkdownCard markdown={planMarkdown} label={tPlan("title")} />
          ) : null}
          {isError && part.errorText ? (
            <DetailBox tone="danger">
              <pre className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-[0.78125rem]">
                {unwrapWholeFence(part.errorText)}
              </pre>
            </DetailBox>
          ) : null}
        </div>
      )}
    >
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 font-medium text-activity-secondary">
          {markerLabel}
        </span>
        {title ? (
          <span className="min-w-0 truncate text-activity-secondary" dir="auto">
            {title}
          </span>
        ) : null}
      </span>
    </ActivityRow>
  )
})

function formatTime(fmt: Intl.DateTimeFormat, iso: string | null) {
  if (!iso) return null
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : fmt.format(date)
}

/**
 * Notes the user sent while the agent worked, as the agent picked them up
 * (`check_user_feedback`): `2 notes from you · <first note>`, open by default —
 * the user's own words are worth seeing where the agent read them.
 */
export const FeedbackRow = memo(function FeedbackRow({
  step,
}: {
  step: ToolStep
}) {
  const t = useTranslations("Folder.chat.feedbackCheckResult")
  const tActivity = useTranslations("Folder.chat.activity")
  const statusText = useStatusText()
  const locale = useLocale()
  const { part, tool } = step
  const outcome = useMemo(
    () => parseFeedbackCheckOutcome(part.output ?? null),
    [part.output]
  )
  const timeFormat = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }),
    [locale]
  )
  const failed = tool.status === "failed"
  const [open, setOpen] = useDisclosure(step.key, { defaultOpen: true })
  const entries = outcome?.entries ?? []
  if (!failed && entries.length === 0) return null

  return (
    <ActivityRow
      stepKey={step.key}
      status={tool.status}
      marker={
        <RailIcon
          icon={MessagesSquareIcon}
          status={tool.status}
          label={`${tActivity("kind.other")}, ${statusText(tool.status)}`}
        />
      }
      expandable={entries.length > 0}
      expanded={open}
      onExpandedChange={setOpen}
      trailing={failed ? <StatusFigure status="failed" /> : null}
      detail={() => (
        <DetailBox tone="neutral">
          <ul className="divide-y divide-foreground/5">
            {entries.map((entry, i) => {
              const time = formatTime(timeFormat, entry.createdAt)
              return (
                <li
                  key={i}
                  className="flex items-start gap-3 px-4 py-2 text-start"
                >
                  <span
                    dir="auto"
                    className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm text-foreground/90"
                  >
                    {entry.text}
                  </span>
                  {time ? (
                    <time
                      dateTime={entry.createdAt ?? undefined}
                      className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground"
                    >
                      {time}
                    </time>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </DetailBox>
      )}
    >
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 font-medium text-activity-secondary">
          {failed ? t("errorTitle") : t("count", { count: entries.length })}
        </span>
        {failed ? (
          <span className="min-w-0 truncate text-tone-danger">
            {part.errorText?.trim()}
          </span>
        ) : entries[0] ? (
          <span className="min-w-0 truncate text-activity-secondary" dir="auto">
            {entries[0].text}
          </span>
        ) : null}
      </span>
    </ActivityRow>
  )
})
