"use client"

import { memo, useMemo } from "react"
import Ansi from "ansi-to-react"
import { useTranslations } from "next-intl"
import { BotIcon, HourglassIcon } from "lucide-react"

import { MessageResponse } from "@/components/ai-elements/message"
import type { ActivityStep, StepStatus } from "@/lib/activity/types"
import {
  buildBackgroundTaskRows,
  type BackgroundTaskRow,
} from "@/lib/background-task"
import { useActivityRender } from "../activity-context"
import { ActivityRow } from "../activity-row"
import { CopyAction, DetailBox } from "../detail-box"
import { useDisclosure } from "../disclosure-store"
import { RailIcon } from "../rail-icon"
import { useStatusText } from "../step-visuals"

type BackgroundTasksStep = Extract<ActivityStep, { type: "background-tasks" }>

function rowStatus(row: BackgroundTaskRow): StepStatus {
  switch (row.badge) {
    case "completed":
      return "succeeded"
    case "failed":
      return "failed"
    case "stopped":
      return "cancelled"
    case "running":
      // A settled poll that said "still running" is a snapshot, not live
      // work: only a poll still in flight turns the ring.
      return row.isInFlight ? "running" : "succeeded"
  }
}

/**
 * `Task finished #beecec7d  Regenerate audit report · report.md written  done`
 * — one row per background task, its polls folded together (the latest one
 * speaks). Named after the command that started it when that is in the same
 * reply.
 */
export const BackgroundTaskRows = memo(function BackgroundTaskRows({
  step,
}: {
  step: BackgroundTasksStep
}) {
  const { pinnedOnly } = useActivityRender()
  const rows = useMemo(() => buildBackgroundTaskRows(step.polls), [step.polls])
  return (
    <>
      {rows
        .filter(
          (row) => !pinnedOnly || (row.badge === "running" && row.isInFlight)
        )
        .map((row) => (
          <BackgroundTaskRowView
            key={row.key}
            stepKey={`${step.key}:${row.key}`}
            row={row}
            launch={row.taskId ? step.launches[row.taskId] : undefined}
          />
        ))}
    </>
  )
})

function firstLine(text: string | null | undefined): string | null {
  const line = text
    ?.split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  return line ? line.slice(0, 160) : null
}

function lastLine(text: string | null | undefined): string | null {
  const lines = text
    ?.split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  const line = lines?.[lines.length - 1]
  return line ? line.slice(0, 160) : null
}

function BackgroundTaskRowView({
  stepKey,
  row,
  launch,
}: {
  stepKey: string
  row: BackgroundTaskRow
  launch: BackgroundTasksStep["launches"][string] | undefined
}) {
  const t = useTranslations("Folder.chat.activity")
  const tParts = useTranslations("Folder.chat.contentParts.backgroundTask")
  const statusText = useStatusText()
  const status = rowStatus(row)
  const failed = row.badge === "failed"
  const hasOutput = !!row.output?.trim()
  const [open, setOpen] = useDisclosure(stepKey, {
    defaultOpen: false,
    force: failed,
  })
  const label =
    row.badge === "completed"
      ? t("row.taskFinished")
      : row.badge === "failed"
        ? t("row.taskFailed")
        : row.badge === "stopped"
          ? t("row.taskStopped")
          : t("row.taskRunning")
  const what =
    launch?.description ??
    (row.isSubagent ? null : firstLine(launch?.command ?? row.command))
  // A failure's last line is usually the error itself; a success's first line
  // is usually what it produced.
  const result =
    row.badge === "running"
      ? null
      : failed
        ? lastLine(row.output)
        : firstLine(row.output)
  const detail = [what, result].filter(Boolean).join(" · ")
  const shortId = row.taskId ? row.taskId.slice(0, 9) : null

  return (
    <ActivityRow
      stepKey={stepKey}
      status={status}
      marker={
        <RailIcon
          icon={row.isSubagent ? BotIcon : HourglassIcon}
          status={status}
          label={`${t("kind.background")}, ${statusText(status)}`}
        />
      }
      expandable={hasOutput}
      expanded={open}
      onExpandedChange={setOpen}
      title={
        row.pollCount > 1
          ? tParts("polledTimes", { count: row.pollCount })
          : (row.command ?? undefined)
      }
      trailing={
        failed ? (
          <span className="text-tone-danger">
            {row.exitCode != null
              ? t("metric.exit", { code: row.exitCode })
              : t("metric.failed")}
          </span>
        ) : row.badge === "stopped" ? (
          t("metric.stopped")
        ) : row.badge === "running" ? (
          t("metric.running")
        ) : (
          t("metric.done")
        )
      }
      detail={() =>
        row.isSubagent ? (
          <DetailBox tone="neutral">
            <div className="prose prose-sm dark:prose-invert max-w-none px-4 py-3 text-sm [&_ol]:list-inside [&_ul]:list-inside">
              <MessageResponse>{row.output ?? ""}</MessageResponse>
            </div>
          </DetailBox>
        ) : (
          <DetailBox
            tone={failed ? "danger" : "neutral"}
            anchor={failed || row.isInFlight ? "end" : "start"}
            actions={
              <CopyAction
                text={row.output ?? ""}
                label={t("detail.copyOutput")}
              />
            }
          >
            <pre
              className="activity-ansi whitespace-pre-wrap break-words px-4 py-3 font-mono text-[0.78125rem] leading-relaxed"
              dir="ltr"
            >
              <Ansi>{row.output ?? ""}</Ansi>
            </pre>
          </DetailBox>
        )
      }
    >
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 font-medium text-activity-secondary">
          {label}
        </span>
        {shortId ? (
          <span
            className="shrink-0 font-mono text-[0.8125rem] text-activity-secondary"
            dir="ltr"
          >
            #{shortId}
          </span>
        ) : null}
        {detail ? (
          <span className="min-w-0 truncate text-activity-secondary" dir="auto">
            {detail}
          </span>
        ) : null}
      </span>
    </ActivityRow>
  )
}
