"use client"

/**
 * The personal agent's timeline: what codeg kept of the conversation, across
 * every session the agent ran on — the owner's messages, the replies, the
 * questions and permission requests with their answers, the dispatch and
 * result cards, and the markers between sessions. The turn in flight streams
 * at the end (`LiveTurn`) until its reply lands as a row.
 */

import { useLayoutEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ArrowUpRight,
  Bot,
  CircleAlert,
  ClipboardList,
  KeyRound,
  Loader2,
  MessageCircleQuestion,
  MessagesSquare,
  RotateCcw,
  Shrink,
  SquareTerminal,
} from "lucide-react"
import { toast } from "sonner"

import { AgentIcon } from "@/components/agent-icon"
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message"
import { Button } from "@/components/ui/button"
import { useTabActions } from "@/contexts/tab-context"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import { personalAgentResend } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type {
  AgentType,
  DispatchMode,
  DispatchState,
  TimelineRow,
} from "@/lib/types"
import { cn } from "@/lib/utils"
import { requestTasksFocus } from "@/lib/workbench-focus"

type T = ReturnType<typeof useTranslations<"PersonalAgent">>

function str(data: Record<string, unknown> | null, key: string): string | null {
  const v = data?.[key]
  return typeof v === "string" && v.length > 0 ? v : null
}

function num(data: Record<string, unknown> | null, key: string): number | null {
  const v = data?.[key]
  return typeof v === "number" ? v : null
}

const DISPATCH_STATES: readonly DispatchState[] = [
  "queued",
  "running",
  "waiting_input",
  "review",
  "completed",
  "failed",
  "canceled",
  "interrupted",
  "handed_over",
]

function asDispatchState(v: unknown): DispatchState | null {
  return typeof v === "string" && DISPATCH_STATES.includes(v as DispatchState)
    ? (v as DispatchState)
    : null
}

function asMode(v: unknown): DispatchMode | null {
  return v === "task" || v === "chat" || v === "session" ? v : null
}

/** A dispatch state as a tone, shared by the cards and the panels. */
export function dispatchTone(state: DispatchState | null): string {
  switch (state) {
    case "running":
    case "queued":
      return "bg-sky-500/15 text-sky-700 dark:text-sky-300"
    case "waiting_input":
    case "review":
      return "bg-amber-500/15 text-amber-700 dark:text-amber-300"
    case "completed":
      return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
    case "failed":
    case "interrupted":
      return "bg-red-500/15 text-red-700 dark:text-red-300"
    default:
      return "bg-muted text-muted-foreground"
  }
}

export function DispatchStateChip({ state }: { state: DispatchState | null }) {
  const t = useTranslations("PersonalAgent.state")
  if (!state) return null
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[0.625rem] font-medium leading-none",
        dispatchTone(state)
      )}
    >
      {t(state)}
    </span>
  )
}

export function ModeIcon({
  mode,
  className,
}: {
  mode: DispatchMode | null
  className?: string
}) {
  const Icon =
    mode === "task"
      ? ClipboardList
      : mode === "session"
        ? SquareTerminal
        : MessagesSquare
  return <Icon className={cn("size-3.5 shrink-0", className)} aria-hidden />
}

/** Jump from a card to the work it points at: the board for a task, a tab
 *  for a conversation. */
export function useOpenDispatchTarget() {
  const { setRoute, openConversations } = useWorkbenchRoute()
  const { openTab } = useTabActions()
  return (target: {
    mode: DispatchMode | null
    workTaskId: number | null
    conversationId: number | null
    folderId: number | null
    agentType: AgentType | null
  }) => {
    if (target.mode === "task") {
      requestTasksFocus({ folderId: target.folderId })
      setRoute("tasks")
      return
    }
    if (target.conversationId == null || target.agentType == null) return
    if (target.folderId == null) return
    openConversations()
    openTab(target.folderId, target.conversationId, target.agentType)
  }
}

function MarkerRow({ row, t }: { row: TimelineRow; t: T }) {
  const data = row.data
  const marker = str(data, "marker")
  let text: string = row.body
  let Icon: typeof Bot | null = null
  let tone = "text-muted-foreground"
  let agentType: AgentType | null = null
  switch (marker) {
    case "segment_start": {
      const reason = str(data, "reason") ?? "first"
      agentType = (str(data, "agent_type") as AgentType | null) ?? null
      text = t("marker.segmentStart", {
        seq: num(data, "seq") ?? 0,
        agent: str(data, "agent") ?? "",
        reason: t(`reason.${reason}` as "reason.first"),
      })
      break
    }
    case "pending_switch":
      text = t("marker.pendingSwitch", {
        reason: t(
          `reason.${str(data, "reason") ?? "manual"}` as "reason.manual"
        ),
      })
      break
    case "options_changed": {
      const opts = Array.isArray(data?.options)
        ? (data.options as { name?: string; value?: string }[])
            .map((o) => `${o.name ?? ""}: ${o.value ?? ""}`)
            .join(", ")
        : ""
      const mode = str(data, "mode")
      text = t("marker.optionsChanged", {
        changes: [opts, mode ? t("marker.modeIs", { mode }) : ""]
          .filter(Boolean)
          .join(" · "),
      })
      break
    }
    case "reconnected":
      text = t("marker.reconnected")
      break
    case "compaction": {
      Icon = Shrink
      const initiator = str(data, "initiator") ?? "auto"
      const status = str(data, "status") ?? "ok"
      const before = num(data, "before_percent")
      const after = num(data, "after_percent")
      const range =
        before != null && after != null
          ? t("marker.compactionRange", { before, after })
          : before != null
            ? t("marker.compactionFrom", { before })
            : ""
      text = t(`marker.compaction.${status}` as "marker.compaction.ok", {
        who: t(`initiator.${initiator}` as "initiator.auto"),
        range,
      })
      if (status !== "ok") tone = "text-amber-700 dark:text-amber-300"
      break
    }
    case "compaction_paused":
      Icon = CircleAlert
      tone = "text-amber-700 dark:text-amber-300"
      text = t("marker.compactionPaused")
      break
    case "turn_canceled":
      text = t("marker.turnCanceled")
      break
    case "turn_failed":
      Icon = CircleAlert
      tone = "text-red-700 dark:text-red-300"
      text = t("marker.turnFailed", { error: str(data, "error") ?? "" })
      break
    case "turn_interrupted":
      Icon = CircleAlert
      tone = "text-amber-700 dark:text-amber-300"
      text = t("marker.turnInterrupted")
      break
    case "overflow":
      Icon = CircleAlert
      tone = "text-amber-700 dark:text-amber-300"
      text =
        str(data, "action") === "new_segment"
          ? t("marker.overflowNewSegment")
          : t("marker.overflowCompact")
      break
    case "workdir_changed":
      text = t("marker.workdirChanged", { path: str(data, "path") ?? "" })
      break
  }
  const major = marker === "segment_start"
  return (
    <div
      className={cn(
        "flex items-center gap-2 py-1 text-xs",
        tone,
        major && "py-2"
      )}
    >
      <span className="h-px flex-1 bg-border" />
      <span className="flex max-w-[80%] min-w-0 items-center gap-1.5">
        {agentType ? (
          <AgentIcon agentType={agentType} className="size-3.5 shrink-0" />
        ) : Icon ? (
          <Icon className="size-3.5 shrink-0" aria-hidden />
        ) : null}
        <span className={cn("min-w-0", major && "font-medium")}>{text}</span>
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  )
}

function OwnerRow({
  row,
  t,
  readOnly,
}: {
  row: TimelineRow
  t: T
  readOnly: boolean
}) {
  const [busy, setBusy] = useState(false)
  const supplement = row.data?.supplement === true
  const resentAs = num(row.data, "resent_as")
  const images = Array.isArray(row.data?.blocks)
    ? (
        row.data.blocks as {
          type?: string
          data?: string
          mime_type?: string
        }[]
      ).filter((b) => b.type === "image" && b.data)
    : []
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="ml-auto max-w-[85%] rounded-2xl bg-secondary px-3.5 py-2 text-sm whitespace-pre-wrap break-words text-foreground">
        {row.body}
        {images.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {images.map((img, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={i}
                src={`data:${img.mime_type ?? "image/png"};base64,${img.data}`}
                alt=""
                className="h-16 w-16 rounded-md object-cover"
              />
            ))}
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-2 text-[0.6875rem] text-muted-foreground">
        {supplement ? <span>{t("timeline.supplement")}</span> : null}
        {row.status === "queued" ? <span>{t("timeline.queued")}</span> : null}
        {row.status === "interrupted" ? (
          <>
            <span className="text-amber-700 dark:text-amber-300">
              {t("timeline.interrupted")}
            </span>
            {resentAs != null ? (
              <span>{t("timeline.resent")}</span>
            ) : readOnly ? null : (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-1.5 text-[0.6875rem]"
                disabled={busy}
                onClick={() => {
                  setBusy(true)
                  personalAgentResend(row.id)
                    .catch((e) => toast.error(toErrorMessage(e)))
                    .finally(() => setBusy(false))
                }}
              >
                <RotateCcw className="size-3" aria-hidden />
                {t("timeline.resend")}
              </Button>
            )}
          </>
        ) : null}
      </div>
    </div>
  )
}

function ReplyRow({ row }: { row: TimelineRow }) {
  return (
    <Message from="assistant">
      <MessageContent>
        <MessageResponse>{row.body}</MessageResponse>
      </MessageContent>
    </Message>
  )
}

interface QuestionSpecLite {
  question?: string
  header?: string
  options?: { label?: string }[]
}

function QuestionRow({ row, t }: { row: TimelineRow; t: T }) {
  const data = row.data
  const state = str(data, "state") ?? "pending"
  const kind = str(data, "kind") ?? "ask"
  const questions = Array.isArray(data?.questions)
    ? (data.questions as QuestionSpecLite[])
    : []
  const answers =
    data?.answer && typeof data.answer === "object"
      ? ((
          data.answer as {
            answers?: { question?: string; selected?: string[] }[]
          }
        ).answers ?? [])
      : []
  const decision =
    data?.answer && typeof data.answer === "object"
      ? (data.answer as { decision?: string }).decision
      : undefined
  return (
    <div className="rounded-xl border border-border/70 bg-muted/40 p-3 text-sm">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <MessageCircleQuestion className="size-3.5" aria-hidden />
        {kind === "plan_approval" ? t("timeline.plan") : t("timeline.question")}
        <span className="ml-auto font-normal">
          {t(
            `timeline.questionState.${state}` as "timeline.questionState.pending"
          )}
        </span>
      </div>
      {kind === "plan_approval" ? (
        <div className="max-h-48 overflow-auto text-xs">
          <MessageResponse>{row.body}</MessageResponse>
          {decision ? (
            <p className="mt-2 font-medium">
              {t(
                `timeline.planDecision.${decision}` as "timeline.planDecision.approve"
              )}
            </p>
          ) : null}
        </div>
      ) : (
        <ul className="space-y-1.5">
          {questions.map((q, i) => {
            const a = answers.find((x) => x.question === q.question)
            return (
              <li key={i}>
                <p className="text-foreground">{q.question}</p>
                {a?.selected?.length ? (
                  <p className="mt-0.5 text-xs text-emerald-700 dark:text-emerald-300">
                    {t("timeline.answered", { answer: a.selected.join(", ") })}
                  </p>
                ) : q.options?.length ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {q.options.map((o) => o.label).join(" / ")}
                  </p>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function PermissionRow({ row, t }: { row: TimelineRow; t: T }) {
  const data = row.data
  const state = str(data, "state") ?? "pending"
  const options = Array.isArray(data?.options)
    ? (data.options as { option_id?: string; name?: string }[])
    : []
  const chosen = str(data, "option_id")
  const chosenName = options.find((o) => o.option_id === chosen)?.name ?? chosen
  return (
    <div className="flex items-start gap-2 rounded-xl border border-border/70 bg-muted/40 px-3 py-2 text-xs">
      <KeyRound
        className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-foreground">
          {row.body || t("timeline.permission")}
        </p>
        <p className="text-muted-foreground">
          {state === "answered"
            ? t("timeline.permissionChose", { option: chosenName ?? "" })
            : state === "withdrawn"
              ? t("timeline.permissionWithdrawn")
              : t("timeline.permissionPending")}
        </p>
      </div>
    </div>
  )
}

function DispatchCard({ row, t }: { row: TimelineRow; t: T }) {
  const data = row.data
  const open = useOpenDispatchTarget()
  const mode = asMode(data?.mode)
  const state = asDispatchState(data?.state)
  const result = row.kind === "result"
  const excerpt = str(data, "excerpt")
  const target = {
    mode,
    workTaskId: num(data, "work_task_id"),
    conversationId: num(data, "conversation_id"),
    // A chat dispatch's conversation sits in its own hidden chat folder.
    folderId: num(data, "conversation_folder_id") ?? num(data, "folder_id"),
    agentType: (str(data, "agent_type") as AgentType | null) ?? null,
  }
  const canOpen =
    mode === "task"
      ? true
      : target.conversationId != null && target.agentType != null
  return (
    <div
      className={cn(
        "rounded-xl border px-3 py-2.5 text-sm",
        result
          ? "border-border/70 bg-card/60"
          : "border-dashed border-border bg-muted/30"
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <ModeIcon mode={mode} className="text-muted-foreground" />
        <span className="text-xs text-muted-foreground">
          {result ? t("timeline.result") : t("timeline.dispatched")}
          {mode ? ` · ${t(`mode.${mode}` as "mode.task")}` : ""}
          {str(data, "executor")
            ? ` · ${t("timeline.executor", { name: str(data, "executor") ?? "" })}`
            : ""}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          {/* A dispatch card is the moment it went out; its progress is the
              result cards' to tell. */}
          {result ? <DispatchStateChip state={state} /> : null}
          {canOpen && result ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              title={
                mode === "task"
                  ? t("timeline.openTask")
                  : t("timeline.openConversation")
              }
              aria-label={
                mode === "task"
                  ? t("timeline.openTask")
                  : t("timeline.openConversation")
              }
              onClick={() => open(target)}
            >
              <ArrowUpRight className="size-3.5" />
            </Button>
          ) : null}
        </span>
      </div>
      <p className="mt-1 font-medium text-foreground">
        {result ? (str(data, "title") ?? row.body) : row.body}
      </p>
      {result && excerpt ? (
        <p className="mt-1 line-clamp-4 text-xs whitespace-pre-wrap text-muted-foreground">
          {excerpt}
        </p>
      ) : null}
      {result && str(data, "note") ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {str(data, "note")}
        </p>
      ) : null}
    </div>
  )
}

export function TimelineRowView({
  row,
  readOnly,
}: {
  row: TimelineRow
  readOnly: boolean
}) {
  const t = useTranslations("PersonalAgent")
  switch (row.kind) {
    case "owner":
      return <OwnerRow row={row} t={t} readOnly={readOnly} />
    case "reply":
      return <ReplyRow row={row} />
    case "question":
      return <QuestionRow row={row} t={t} />
    case "permission":
      return <PermissionRow row={row} t={t} />
    case "dispatch":
    case "result":
      return <DispatchCard row={row} t={t} />
    case "marker":
      return <MarkerRow row={row} t={t} />
  }
}

interface TimelineViewProps {
  rows: TimelineRow[]
  hasOlder: boolean
  onLoadOlder: () => Promise<void>
  readOnly: boolean
  /** The turn in flight, drawn after the rows. */
  live?: React.ReactNode
}

/** The scrolling timeline. Sticks to the bottom while the reader is there. */
export function TimelineView({
  rows,
  hasOlder,
  onLoadOlder,
  readOnly,
  live,
}: TimelineViewProps) {
  const t = useTranslations("PersonalAgent")
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const atBottom = useRef(true)
  const [loadingOlder, setLoadingOlder] = useState(false)

  // Follow new rows (and the live turn growing) while at the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && atBottom.current) el.scrollTop = el.scrollHeight
  })

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
      onScroll={(e) => {
        const el = e.currentTarget
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
      }}
    >
      <div className="mx-auto flex w-full max-w-[48rem] flex-col gap-3">
        {hasOlder ? (
          <div className="flex justify-center">
            <Button
              variant="ghost"
              size="sm"
              className="text-xs text-muted-foreground"
              disabled={loadingOlder}
              onClick={() => {
                const el = scrollRef.current
                const before = el?.scrollHeight ?? 0
                setLoadingOlder(true)
                onLoadOlder()
                  .then(() => {
                    // Keep the reader where they were.
                    requestAnimationFrame(() => {
                      if (el) el.scrollTop += el.scrollHeight - before
                    })
                  })
                  .catch((e) => toast.error(toErrorMessage(e)))
                  .finally(() => setLoadingOlder(false))
              }}
            >
              {loadingOlder ? (
                <Loader2 className="size-3 animate-spin" />
              ) : null}
              {t("timeline.loadOlder")}
            </Button>
          </div>
        ) : null}
        {rows.length === 0 && !live ? (
          <p className="py-16 text-center text-sm text-muted-foreground">
            {t("timeline.empty")}
          </p>
        ) : null}
        {rows.map((row) => (
          <TimelineRowView key={row.id} row={row} readOnly={readOnly} />
        ))}
        {live}
      </div>
    </div>
  )
}
