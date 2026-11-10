"use client"

import { memo, useMemo } from "react"
import { useTranslations } from "next-intl"

import { MessageResponse } from "@/components/ai-elements/message"
import { tryParseJson } from "@/lib/activity/json"
import type { ActivityStep } from "@/lib/activity/types"
import { parseTodosFromJson } from "@/lib/plan-parse"
import { cn } from "@/lib/utils"
import { PlanEntriesList } from "../../plan-card"
import { useActivityRender } from "../activity-context"
import { ActivityRow } from "../activity-row"
import { DetailBox } from "../detail-box"
import { useDisclosure } from "../disclosure-store"
import { RailIcon } from "../rail-icon"
import {
  RESULT_ICON,
  StatusFigure,
  ToolFigure,
  toolIcon,
  useStatusText,
} from "../step-visuals"
import { ResultBody } from "../result-body"
import type { ToolStep } from "./explore-rows"

/** Argument keys that only restate the row's own header. */
const HIDDEN_ARGUMENTS = new Set([
  "dangerouslyDisableSandbox",
  "session_command",
])

function argumentsText(input: string | null): string | null {
  if (!input?.trim()) return null
  const parsed = tryParseJson(input)
  if (!parsed) return input
  const shown = Object.fromEntries(
    Object.entries(parsed).filter(([key]) => !HIDDEN_ARGUMENTS.has(key))
  )
  return Object.keys(shown).length > 0 ? JSON.stringify(shown, null, 2) : null
}

/**
 * Any other tool call: its name and the argument that says what it was for,
 * opening to the arguments and the result. Also hosts skills, todo updates
 * and Cline's completion, which differ only in their label and panel.
 */
export const GenericRow = memo(function GenericRow({
  step,
}: {
  step: ToolStep
}) {
  const t = useTranslations("Folder.chat.activity")
  const statusText = useStatusText()
  const { recoveredKeys } = useActivityRender()
  const { tool, part } = step
  const failed = tool.status === "failed" || tool.status === "rejected"
  const isCompletion = tool.kind === "completion"
  const [open, setOpen] = useDisclosure(step.key, {
    // Cline's completion IS the turn's closing statement: shown open.
    defaultOpen: isCompletion,
    force:
      (failed && !recoveredKeys.has(step.key)) || tool.status === "awaiting",
  })
  const args = useMemo(() => argumentsText(part.input), [part.input])
  const result = part.errorText ?? part.output ?? null
  const todos = useMemo(
    () =>
      tool.kind === "todo" && part.input ? parseTodosFromJson(part.input) : [],
    [tool.kind, part.input]
  )
  const completion = useMemo(() => {
    if (!isCompletion) return null
    const parsed = part.input ? tryParseJson(part.input) : null
    const text = (key: string) =>
      typeof parsed?.[key] === "string" ? (parsed[key] as string).trim() : ""
    return { result: text("result"), progress: text("task_progress") }
  }, [isCompletion, part.input])
  // A sandbox's network request has one argument, the host, which its line
  // already names: there is nothing more to open.
  const isNetwork = tool.kind === "network"
  const expandable =
    !isNetwork &&
    (!!args || !!result?.trim() || todos.length > 0 || !!completion?.result)

  const label = (() => {
    switch (tool.kind) {
      case "skill":
        return (
          <>
            <span className="shrink-0 font-medium text-activity-secondary">
              {t("row.skill")}
            </span>
            {tool.target ? (
              <span className="min-w-0 truncate font-mono text-[0.8125rem] text-activity-secondary">
                {tool.target.text}
              </span>
            ) : null}
          </>
        )
      case "todo":
        return (
          <>
            <span className="shrink-0 font-medium text-activity-secondary">
              {t("row.todos")}
            </span>
            {tool.target ? (
              <span
                className="min-w-0 truncate text-activity-secondary"
                dir="auto"
              >
                {tool.target.text}
              </span>
            ) : null}
            {tool.detail ? (
              <span className="shrink-0 font-mono text-xs text-activity-secondary">
                {tool.detail}
              </span>
            ) : null}
          </>
        )
      case "network":
        return (
          <>
            <span className="shrink-0 font-medium text-activity-secondary">
              {t("row.networkAccess")}
            </span>
            {tool.target ? (
              <span
                className="min-w-0 truncate font-mono text-[0.8125rem] text-activity-secondary"
                dir="ltr"
              >
                {tool.target.text}
              </span>
            ) : null}
          </>
        )
      case "completion":
        return (
          <>
            <span className="shrink-0 font-medium text-activity-secondary">
              {t("row.completion")}
            </span>
            {tool.target ? (
              <span
                className="min-w-0 truncate text-activity-secondary"
                dir="auto"
              >
                {tool.target.text}
              </span>
            ) : null}
          </>
        )
      default:
        return (
          <>
            <span
              className={cn(
                "min-w-0 shrink-0 truncate font-mono text-[0.8125rem] font-medium",
                failed ? "text-tone-danger" : "text-foreground"
              )}
            >
              {tool.target?.text ?? tool.toolName}
            </span>
            {tool.detail ? (
              <span
                className="min-w-0 truncate text-activity-secondary"
                dir="auto"
              >
                {tool.detail}
              </span>
            ) : null}
          </>
        )
    }
  })()

  return (
    <ActivityRow
      stepKey={step.key}
      approval={step.tool.approval}
      status={tool.status}
      marker={
        <RailIcon
          icon={toolIcon(tool)}
          status={tool.status}
          label={`${t(isNetwork ? "kind.network" : "kind.tool")}, ${statusText(tool.status)}`}
        />
      }
      expandable={expandable}
      expanded={open}
      onExpandedChange={setOpen}
      title={tool.detail ?? tool.target?.full ?? undefined}
      trailing={<ToolFigure tool={tool} />}
      detail={() => (
        <div className="space-y-2">
          {completion?.result ? (
            <div className="prose prose-sm dark:prose-invert max-w-none text-sm [&_ol]:list-inside [&_ul]:list-inside">
              <MessageResponse>{completion.result}</MessageResponse>
              {completion.progress ? (
                <DetailBox tone="neutral" className="not-prose mt-2">
                  <div className="prose prose-sm dark:prose-invert max-w-none px-4 py-2 text-xs">
                    <MessageResponse>{completion.progress}</MessageResponse>
                  </div>
                </DetailBox>
              ) : null}
            </div>
          ) : todos.length > 0 ? (
            <PlanEntriesList entries={todos} />
          ) : args ? (
            <DetailBox tone="neutral">
              <p className="px-4 pt-2.5 font-mono text-xs text-muted-foreground">
                {t("detail.args")}
              </p>
              <ResultBody text={args} />
            </DetailBox>
          ) : null}
          {result?.trim() && !completion?.result ? (
            <DetailBox
              tone={failed ? "danger" : "neutral"}
              anchor={failed ? "end" : "start"}
            >
              <p className="px-4 pt-2.5 font-mono text-xs text-muted-foreground">
                {t("detail.result")}
              </p>
              <ResultBody text={result} tone={failed ? "danger" : "neutral"} />
            </DetailBox>
          ) : null}
        </div>
      )}
    >
      <span className="flex min-w-0 items-baseline gap-2">{label}</span>
    </ActivityRow>
  )
})

type ToolResultStep = Extract<ActivityStep, { type: "tool-result" }>

/** A result that arrived without its call (a parser that lost the pairing). */
export const ToolResultRow = memo(function ToolResultRow({
  step,
}: {
  step: ToolResultStep
}) {
  const t = useTranslations("Folder.chat.activity")
  const statusText = useStatusText()
  const failed = step.part.state === "output-error"
  const status = failed ? "failed" : "succeeded"
  const [open, setOpen] = useDisclosure(step.key, {
    defaultOpen: false,
    force: failed,
  })
  const text = step.part.errorText ?? step.part.output ?? ""
  return (
    <ActivityRow
      stepKey={step.key}
      status={status}
      marker={
        <RailIcon
          icon={RESULT_ICON}
          status={status}
          label={`${t("kind.tool")}, ${statusText(status)}`}
        />
      }
      expandable={!!text.trim()}
      expanded={open}
      onExpandedChange={setOpen}
      trailing={<StatusFigure status={status} />}
      detail={() => (
        <DetailBox tone={failed ? "danger" : "neutral"}>
          <ResultBody text={text} tone={failed ? "danger" : "neutral"} />
        </DetailBox>
      )}
    >
      <span className="font-medium text-activity-secondary">
        {t("row.toolResult")}
      </span>
    </ActivityRow>
  )
})
