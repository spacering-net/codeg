"use client"

import { memo, useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { ActivityIcon, BanIcon } from "lucide-react"

import {
  DelegationIdentityGlyph,
  DelegationIdentityName,
} from "@/components/message/delegation-identity"
import {
  DelegationStatusWord,
  delegationStepStatus,
} from "@/components/message/delegation-status-badge"
import { DelegationStatusRow } from "@/components/message/delegation-status-row"
import { useSessionViewerHost } from "@/components/message/session-viewer-host-context"
import { SubAgentSessionDialog } from "@/components/message/sub-agent-session-dialog"
import { useDelegationCardModel } from "@/hooks/use-delegation-card-model"
import { useTruncation } from "@/hooks/use-truncation"
import { previewLine } from "@/lib/activity/format"
import type { ActivityStep, StepStatus } from "@/lib/activity/types"
import type { AdaptedToolCallPart } from "@/lib/adapters/ai-elements-adapter"
import {
  delegateCallTaskId,
  isContinueDelegationToolName,
} from "@/lib/delegation-card"
import { normalizeToolName } from "@/lib/tool-call-normalization"
import {
  buildDelegationTaskRows,
  deriveBadge,
  parseStatusReport,
  parseTaskId,
  type DelegationTaskRow,
} from "@/lib/delegation-status"
import { useActivityRender } from "../activity-context"
import { ActivityRow } from "../activity-row"
import { DetailBox } from "../detail-box"
import { useDisclosure } from "../disclosure-store"
import { ProgressLine } from "../progress-line"
import { RailIcon } from "../rail-icon"
import { useStatusText } from "../step-visuals"
import { useChildProgress } from "../use-child-progress"
import {
  formatClock,
  LIVE_CLOCK_AFTER_MS,
  useLiveElapsed,
} from "../use-live-elapsed"
import type { ToolStep } from "./explore-rows"
import { GenericRow } from "./generic-row"

/** Longest result line shown under a finished delegation. */
const RESULT_PREVIEW_CHARS = 240

/**
 * One delegation, start to finish: `Codex  #14be49e7  Update the stale
 * snapshot…  done · 1m 34s` — the task it was handed on the title line — and,
 * once it reports back, the first line of its result beside "Open
 * conversation ↗" (usable while it still runs; until it has something to
 * show, a skeleton holds that line). The panel holds the whole task, when the
 * title line cuts it short. The agent's `get_delegation_status` checks are
 * rows of their own (`DelegationPollsRow`); the newest says how it ended.
 */
export const DelegationRow = memo(function DelegationRow({
  step,
}: {
  step: ToolStep
}) {
  const t = useTranslations("Folder.chat.activity")
  const tDelegation = useTranslations("Folder.chat.delegation")
  const statusText = useStatusText()
  const { pinnedOnly } = useActivityRender()
  const { part } = step
  // The newest report on its task: what its step bar and result read once it
  // is no longer working — and, with nothing live or stored to go by, how it
  // ended. The polls were handed over by this call's own task id.
  const latest = useMemo(() => {
    const rows = step.laterPolls ? buildDelegationTaskRows(step.laterPolls) : []
    const taskId = delegateCallTaskId(part)
    return rows.find((row) => row.taskId === taskId) ?? rows[rows.length - 1]
  }, [step.laterPolls, part])
  const source = useMemo(
    () => ({
      parentToolUseId: part.toolCallId,
      input: part.input,
      output: part.output ?? null,
      errorText: part.errorText ?? null,
      state: part.state,
      meta: part.meta ?? null,
      laterReport: latest?.report ?? null,
    }),
    [part, latest]
  )
  const model = useDelegationCardModel(source)
  const viewerHost = useSessionViewerHost()
  const [dialogOpen, setDialogOpen] = useState(false)
  const status = delegationStepStatus(model.status)
  const working = status === "running" || status === "awaiting"
  // While it works, its own connection is the freshest source; the reports
  // its checks returned cover the rest (and, once it is done, say how it
  // ended).
  const liveProgress = useChildProgress(
    working ? model.childConnectionId : null
  )
  const progress = liveProgress ?? latest?.report.progress ?? null
  const [open, setOpen] = useDisclosure(step.key, { defaultOpen: false })
  // The task on the title line, as one line; the panel repeats it only when
  // that line cuts it short (and holds it while open, whatever the width).
  const taskLine = model.task?.replace(/\s+/g, " ").trim() || null
  const { ref: taskRef, truncated: taskCut } =
    useTruncation<HTMLSpanElement>(taskLine)
  const elapsed = useLiveElapsed(step.key, status === "running")

  if (!model.hasModel) return pinnedOnly ? null : <GenericRow step={step} />
  if (pinnedOnly && status !== "running" && status !== "awaiting") return null

  const result =
    model.status === "ok" || model.status === "err"
      ? previewLine(latest?.report.text, RESULT_PREVIEW_CHARS)
      : null
  // While it works, what it is doing now stands where the result will be.
  const current = working && status !== "awaiting" ? progress?.lastStep : null
  const summary = result ?? current ?? null
  const openSession =
    model.childConversationId != null
      ? () =>
          viewerHost
            ? viewerHost.open({ kind: "delegation", source })
            : setDialogOpen(true)
      : null

  return (
    <>
      <ActivityRow
        stepKey={step.key}
        approval={step.tool.approval}
        status={status}
        marker={
          <RailIcon
            glyph={<DelegationIdentityGlyph identity={model.identity} />}
            status={status}
            label={`${t("kind.delegation")}, ${statusText(status)}`}
          />
        }
        expandable={taskLine !== null && (taskCut || open)}
        expanded={open}
        onExpandedChange={setOpen}
        trailing={
          <DelegationStatusWord
            status={model.status}
            errorCode={model.errorCode}
            durationMs={latest?.report.durationMs ?? null}
            clock={
              elapsed !== null && elapsed >= LIVE_CLOCK_AFTER_MS
                ? formatClock(elapsed)
                : null
            }
          />
        }
        addon={
          <ProgressLine
            progress={progress}
            working={status === "running"}
            summary={summary}
            summaryLive={!result}
            onOpenSession={openSession}
          />
        }
        detail={() => (
          <DetailBox tone="neutral">
            <p
              dir="auto"
              className="whitespace-pre-wrap break-words px-4 py-3 text-sm text-foreground/90"
            >
              {model.task}
            </p>
          </DetailBox>
        )}
      >
        {/* The task gets whatever room the rest leaves (it is all in the
            panel), the step count gives way next, and nothing runs past the
            line's end. */}
        <span className="flex min-w-0 items-baseline gap-2 overflow-hidden">
          <DelegationIdentityName
            identity={model.identity}
            className="max-w-[60%] shrink-0 truncate font-semibold text-foreground"
          />
          {model.taskId ? (
            <span
              className="shrink-0 font-mono text-[0.8125rem] text-activity-secondary"
              title={model.taskId}
              dir="ltr"
            >
              #{model.taskId.slice(0, 8)}
            </span>
          ) : null}
          {isContinueDelegationToolName(normalizeToolName(part.toolName)) ? (
            <span className="shrink-0 text-[0.6875rem] text-activity-secondary">
              {tDelegation("continued")}
            </span>
          ) : null}
          {progress && progress.steps > 0 ? (
            // Pulled in by the space after its dot, so the dot sits centred
            // between the id and the count.
            <span className="-ms-1 min-w-0 truncate text-activity-secondary">
              {`· ${t("header.steps", { count: progress.steps })}`}
            </span>
          ) : null}
          {taskLine ? (
            <span
              ref={taskRef}
              dir="auto"
              className="min-w-0 flex-1 truncate text-activity-secondary"
            >
              {taskLine}
            </span>
          ) : null}
        </span>
      </ActivityRow>
      {viewerHost == null && model.childConversationId != null ? (
        <SubAgentSessionDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          childConversationId={model.childConversationId}
          childConnectionId={model.childConnectionId}
          identity={model.identity}
          kickoffTask={model.task}
        />
      ) : null}
    </>
  )
})

type BadgeStatus = DelegationTaskRow["badge"]["status"]

/** A delegation's checks, as the status rows that carry their results and any
 *  pending decision. `onStatusChange` hears what each row shows and
 *  `onOpenChange` whether its panel is open, keyed by row. */
function PollRows({
  rows,
  onStatusChange,
  onOpenChange,
}: {
  rows: DelegationTaskRow[]
  onStatusChange: (key: string, status: BadgeStatus) => void
  onOpenChange: (key: string, open: boolean) => void
}) {
  return (
    <div className="space-y-0.5">
      {rows.map((row) => (
        <PollRow
          key={row.key}
          row={row}
          onStatusChange={onStatusChange}
          onOpenChange={onOpenChange}
        />
      ))}
    </div>
  )
}

function PollRow({
  row,
  onStatusChange,
  onOpenChange,
}: {
  row: DelegationTaskRow
  onStatusChange: (key: string, status: BadgeStatus) => void
  onOpenChange: (key: string, open: boolean) => void
}) {
  const report = useCallback(
    (status: BadgeStatus) => onStatusChange(row.key, status),
    [onStatusChange, row.key]
  )
  const reportOpen = useCallback(
    (open: boolean) => onOpenChange(row.key, open),
    [onOpenChange, row.key]
  )
  return (
    <DelegationStatusRow
      kind="status"
      taskId={row.taskId}
      report={row.report}
      badge={row.badge}
      results={row.results}
      runningConfirmed={row.runningConfirmed}
      latestPollId={row.latestPollId}
      onStatusChange={report}
      onOpenChange={reportOpen}
    />
  )
}

function pollsStatus(statuses: BadgeStatus[]): StepStatus {
  if (statuses.includes("waiting")) return "awaiting"
  if (statuses.includes("running")) return "running"
  if (statuses.includes("err")) return "failed"
  return "succeeded"
}

type PollsStep = Extract<ActivityStep, { type: "delegation-polls" }>

/**
 * The agent's checks on its delegations: a thin `Waiting for task #… result
 * done · 1m 34s` row per task, which keeps the decision a waiting sub-agent
 * needs answered — and stays under a folded turn while it does.
 */
export const DelegationPollsRow = memo(function DelegationPollsRow({
  step,
}: {
  step: PollsStep
}) {
  const t = useTranslations("Folder.chat.activity")
  const statusText = useStatusText()
  const { pinnedOnly } = useActivityRender()
  const rows = useMemo(() => buildDelegationTaskRows(step.polls), [step.polls])
  // What each row shows, which the live sub-agent can override (parked on
  // the user under a still-spinning re-poll, or answered since): the rail
  // follows the rows, not the polls alone.
  const [shown, setShown] = useState<ReadonlyMap<string, BadgeStatus>>(
    () => new Map()
  )
  const onStatusChange = useCallback((key: string, status: BadgeStatus) => {
    setShown((prev) =>
      prev.get(key) === status ? prev : new Map(prev).set(key, status)
    )
  }, [])
  // Which rows have their panel open: as the last row, the rail runs beside an
  // open one.
  const [openKeys, setOpenKeys] = useState<ReadonlySet<string>>(() => new Set())
  const onOpenChange = useCallback((key: string, open: boolean) => {
    setOpenKeys((prev) => {
      if (prev.has(key) === open) return prev
      const next = new Set(prev)
      if (open) next.add(key)
      else next.delete(key)
      return next
    })
  }, [])
  if (rows.length === 0) return null
  const status = pollsStatus(
    rows.map((row) => shown.get(row.key) ?? row.badge.status)
  )
  if (pinnedOnly && status !== "awaiting" && status !== "running") return null
  return (
    <PollsLi
      stepKey={step.key}
      status={status}
      // Only rows still drawn count: one that went away open never said it
      // closed.
      open={rows.some((row) => openKeys.has(row.key))}
    >
      <RailIcon
        icon={ActivityIcon}
        status={status}
        label={`${t("kind.delegation")}, ${statusText(status)}`}
      />
      <PollRows
        rows={rows}
        onStatusChange={onStatusChange}
        onOpenChange={onOpenChange}
      />
    </PollsLi>
  )
})

/** `cancel_delegation`: one thin status row, like a check. */
export const DelegationCancelRow = memo(function DelegationCancelRow({
  part,
  stepKey,
}: {
  part: AdaptedToolCallPart
  stepKey: string
}) {
  const t = useTranslations("Folder.chat.activity")
  const statusText = useStatusText()
  const report = useMemo(
    () => parseStatusReport(part.output ?? null, part.errorText ?? null),
    [part.output, part.errorText]
  )
  const taskId = parseTaskId(part.input) ?? report.taskId
  const badge = deriveBadge("cancel", report, part.state, !!part.errorText)
  const [open, setOpen] = useState(false)
  const status: StepStatus =
    badge.status === "err"
      ? "failed"
      : badge.status === "running" || badge.status === "starting"
        ? "running"
        : "succeeded"
  return (
    <PollsLi stepKey={stepKey} status={status} open={open}>
      <RailIcon
        icon={BanIcon}
        status={status}
        label={`${t("kind.delegation")}, ${statusText(status)}`}
      />
      <DelegationStatusRow
        kind="cancel"
        taskId={taskId}
        report={report}
        badge={badge}
        onOpenChange={setOpen}
      />
    </PollsLi>
  )
})

function PollsLi({
  stepKey,
  status,
  open,
  children,
}: {
  stepKey: string
  status: StepStatus
  /** A row's panel is open: as the last row, the rail runs beside it. */
  open: boolean
  children: [React.ReactNode, React.ReactNode]
}) {
  const [marker, body] = children
  return (
    <li
      className="activity-item"
      data-marker="ring"
      data-status={status}
      data-step-key={stepKey}
      data-body={open ? "" : undefined}
    >
      <span className="absolute start-0 top-1 flex size-5 items-center justify-center">
        {marker}
      </span>
      <div className="min-w-0">{body}</div>
    </li>
  )
}
