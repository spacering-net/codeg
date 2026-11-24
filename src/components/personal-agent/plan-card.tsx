"use client"

/**
 * A plan's card (7.6), codeg's own: the steps, who carries each out, what
 * each waits for and how far it got, with the changes made to it.
 * - shown first (the owner asked to see plans first, or a step is one they
 *   confirm first): [Start] [Change] [Cancel];
 * - running or stuck: [Stop] [Change]; a step waiting for the owner's
 *   confirmation has [Confirm];
 * - stopped: [Go on] [Change] [End plan], and each step under way [Cancel];
 * - done or ended: what it came to.
 * [Change] is the owner's message to the assistant, quoting the card: it
 * changes the plan with `plan_update`. A change to steps that have not
 * started can be taken back.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  ChevronDown,
  ChevronRight,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  CircleX,
  ListTree,
  LoaderCircle,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { SyncedSpinner } from "@/components/ui/synced-spinner"
import { useBotId } from "@/contexts/personal-agent-context"
import { personalAgentNoticeAct, type NoticeAction } from "@/lib/api"
import type {
  AgentType,
  BotAvatar as AvatarValue,
  PlanChangeItem,
  PlanChangeView,
  PlanStepView,
  PlanView,
} from "@/lib/types"
import { cn } from "@/lib/utils"

import { BotAvatar } from "./bot-avatar"
import type { MessageItem } from "./message-items"
import { MessageRow } from "./message-row"
import {
  canOpenWork,
  CardMessage,
  SHEET_TITLE,
  SheetActions,
  SheetLabel,
  SheetNote,
  SheetPart,
  useOpenWork,
  usePageScope,
} from "./shared"

type NoticeItem = Extract<MessageItem, { kind: "notice" }>

const PLAN_STATES = new Set([
  "draft",
  "running",
  "stuck",
  "stopped",
  "done",
  "canceled",
])

/** The plan a card's row carries, when it reads as one. */
export function planOf(v: unknown): PlanView | null {
  if (!v || typeof v !== "object") return null
  const p = v as PlanView
  return typeof p.id === "number" &&
    typeof p.title === "string" &&
    PLAN_STATES.has(p.state) &&
    Array.isArray(p.steps)
    ? { ...p, changes: Array.isArray(p.changes) ? p.changes : [] }
    : null
}

/** Where a step stands, as its line says it: one not started tells whether
 *  it waits for its steps or for the owner. */
export function stepWord(s: PlanStepView): string {
  if (s.state === "pending") {
    if (s.ready && !s.confirmed) return "confirm"
    return s.ready ? "ready" : "pending"
  }
  return s.state
}

function StepIcon({ word }: { word: string }) {
  const cls = "size-3.5 shrink-0"
  switch (word) {
    case "done":
      return <CircleCheck className={cn(cls, "text-emerald-600")} aria-hidden />
    case "running":
      return (
        <LoaderCircle
          className={cn(
            cls,
            "animate-spin text-primary motion-reduce:animate-none"
          )}
          aria-hidden
        />
      )
    case "failed":
      return <CircleX className={cn(cls, "text-red-600")} aria-hidden />
    case "canceled":
    case "stopped":
      return (
        <CircleSlash className={cn(cls, "text-muted-foreground")} aria-hidden />
      )
    case "confirm":
      return <Circle className={cn(cls, "text-orange-500")} aria-hidden />
    default:
      return (
        <CircleDashed
          className={cn(cls, "text-muted-foreground")}
          aria-hidden
        />
      )
  }
}

/** A step's word on its tone, beside who carries it out. */
const STATUS_TONE: Record<string, string> = {
  done: "text-emerald-700 dark:text-emerald-400",
  running: "text-sky-700 dark:text-sky-400",
  failed: "text-red-700 dark:text-red-400",
  confirm: "font-medium text-orange-700 dark:text-orange-400",
}

function useChangeText(): (i: PlanChangeItem) => string {
  const t = useTranslations("PersonalAgent.plan")
  return (i) => {
    const seq = i.seq ?? 0
    const title = i.title ?? ""
    switch (i.kind) {
      case "added":
        return t("change.added", { seq, title })
      case "removed":
        return t("change.removed", { seq, title })
      case "retry":
        return t("change.retry", { seq, title })
      case "changed":
        return t("change.changed", {
          seq,
          title,
          fields: (i.fields ?? [])
            .map((f) => t(`field.${f}` as "field.prompt"))
            .join(t("sep")),
        })
      case "title":
        return t("change.title", { title })
      case "goal":
        return t("change.goal")
      default:
        return i.kind
    }
  }
}

export function PlanCard({ item }: { item: NoticeItem }) {
  const t = useTranslations("PersonalAgent.plan")
  const tm = useTranslations("PersonalAgent.mode")
  const tl = useTranslations("PersonalAgent.ladder")
  const { readOnly, onQuote } = usePageScope()
  const botId = useBotId()
  const openWork = useOpenWork()
  const changeText = useChangeText()
  const row = item.row
  const plan = planOf(row.data?.plan)
  const [busy, setBusy] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set())
  if (!plan) return null
  const noticeId = Number(row.ref_id)
  const act = async (action: NoticeAction) => {
    if (!Number.isFinite(noticeId) || busy) return
    setBusy(action)
    setFailed(null)
    try {
      await personalAgentNoticeAct(noticeId, action, botId)
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }
  const toggle = (seq: number) =>
    setOpen((was) => {
      const next = new Set(was)
      if (next.has(seq)) next.delete(seq)
      else next.add(seq)
      return next
    })
  const live =
    plan.state === "draft" ||
    plan.state === "running" ||
    plan.state === "stuck" ||
    plan.state === "stopped"
  const stuckOn = plan.steps.find(
    (s) => s.state === "failed" || s.state === "canceled"
  )
  const button = (
    action: NoticeAction,
    label: string,
    variant: "default" | "secondary" | "ghost" = "secondary",
    // A step's own, on its line: a size down; the card's, on its last band.
    inline = false
  ) => (
    <Button
      key={action}
      size="sm"
      variant={variant}
      className={inline ? "h-7 px-2.5 text-xs" : undefined}
      disabled={readOnly || busy != null}
      onClick={() => void act(action)}
      data-pa-plan-act={action}
    >
      {busy === action ? <SyncedSpinner className="size-3" /> : null}
      {label}
    </Button>
  )
  const change = (
    <Button
      key="change"
      size="sm"
      variant="secondary"
      disabled={readOnly}
      onClick={() => onQuote(row.id)}
      data-pa-plan-act="change"
    >
      {t("act.change")}
    </Button>
  )
  const actions =
    plan.state === "draft"
      ? [
          button("start", t("act.start"), "default"),
          change,
          button("cancel", t("act.cancel"), "ghost"),
        ]
      : plan.state === "running" || plan.state === "stuck"
        ? [button("stop", t("act.stop")), change]
        : plan.state === "stopped"
          ? [
              button("start", t("act.resume"), "default"),
              change,
              button("cancel", t("act.end"), "ghost"),
            ]
          : []
  return (
    <MessageRow
      rowId={row.id}
      side="start"
      gap={item.gap}
      tail={item.tail}
      roomy
      actions={{ rowId: row.id, text: row.body || null, at: row.created_at }}
    >
      <CardMessage
        data-pa-plan-card={plan.state}
        head={
          <>
            <ListTree aria-hidden />
            <span className="font-medium">{t("title")}</span>
            <span aria-hidden>·</span>
            <span data-pa-plan-state>{t(`state.${plan.state}`)}</span>
          </>
        }
      >
        {/* What the plan is for, how far it got, and how it stands. */}
        <SheetPart className="flex flex-col gap-2">
          <div className="flex min-w-0 items-start gap-3">
            <p className={cn(SHEET_TITLE, "min-w-0 flex-1")}>{plan.title}</p>
            <span
              className="mt-0.5 shrink-0 text-xs text-muted-foreground tabular-nums"
              data-pa-plan-progress
            >
              {t("progress", { done: plan.done, total: plan.total })}
            </span>
          </div>
          {plan.total > 0 ? (
            <div
              className="h-1 overflow-hidden rounded-full bg-muted"
              aria-hidden
            >
              <div
                className={cn(
                  "h-full rounded-full transition-[width]",
                  plan.state === "stuck"
                    ? "bg-orange-500"
                    : plan.state === "done"
                      ? "bg-emerald-500"
                      : plan.state === "canceled" || plan.state === "stopped"
                        ? "bg-muted-foreground/40"
                        : "bg-primary"
                )}
                style={{
                  width: `${Math.min(100, (plan.done / plan.total) * 100)}%`,
                }}
              />
            </div>
          ) : null}
          {plan.goal ? (
            <p className="text-xs leading-5 break-words text-muted-foreground">
              {plan.goal}
            </p>
          ) : null}
          {plan.state === "draft" ? (
            <p className="text-xs text-muted-foreground">{t("hint.draft")}</p>
          ) : plan.state === "stopped" ? (
            <p className="text-xs text-muted-foreground">{t("hint.stopped")}</p>
          ) : plan.state === "stuck" && stuckOn ? (
            <p className="flex items-start gap-1.5 text-xs text-orange-700 dark:text-orange-400">
              <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span data-pa-plan-stuck>
                {stuckOn.state === "canceled"
                  ? t("hint.stuckCanceled", {
                      seq: stuckOn.seq,
                      title: stuckOn.title,
                    })
                  : t("hint.stuck", { seq: stuckOn.seq, title: stuckOn.title })}
              </span>
            </p>
          ) : null}
        </SheetPart>
        {/* Its steps. */}
        <SheetPart>
          <ol
            className="flex flex-col divide-y divide-border/60"
            data-pa-plan-steps
          >
            {plan.steps.map((s) => {
              const word = stepWord(s)
              const target = {
                dispatchId: s.dispatch_id,
                mode: s.mode,
                workTaskId: s.work_task_id,
                conversationId: s.conversation_id,
                folderId:
                  s.mode === "task" ? s.project_id : s.conversation_folder_id,
                agentType: (s.agent_type ?? null) as AgentType | null,
                title: s.title,
                assistantName: s.target_name,
                prompt: null,
                connectionId: null,
                state: null,
              }
              const shown = open.has(s.seq)
              const status =
                s.state === "running" && s.ladder
                  ? tl(s.ladder as "working")
                  : t(`step.${word}` as "step.pending")
              return (
                <li
                  key={s.seq}
                  className="flex min-w-0 flex-col gap-1 py-2.5 first:pt-0 last:pb-0"
                  data-pa-plan-step={s.seq}
                  data-pa-plan-step-state={word}
                >
                  <div className="flex min-w-0 items-center gap-1.5">
                    <StepIcon word={word} />
                    <button
                      type="button"
                      className="flex min-w-0 items-center gap-1 rounded-sm text-start transition-colors hover:text-foreground/80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      onClick={() => toggle(s.seq)}
                      aria-expanded={shown}
                    >
                      {shown ? (
                        <ChevronDown className="size-3 shrink-0" aria-hidden />
                      ) : (
                        <ChevronRight className="size-3 shrink-0" aria-hidden />
                      )}
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {s.seq}.
                      </span>
                      <span className="truncate font-medium">{s.title}</span>
                    </button>
                    <span className="ms-auto flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                      <BotAvatar
                        avatar={faceAvatar(s.face)}
                        name={s.target_name}
                        size={14}
                      />
                      <span
                        className="max-w-32 truncate"
                        data-pa-plan-step-who={s.target_kind}
                      >
                        {s.target_kind === "self" ? t("self") : s.target_name}
                      </span>
                      <span aria-hidden>·</span>
                      <span
                        data-pa-plan-step-status
                        className={STATUS_TONE[word]}
                      >
                        {status}
                      </span>
                    </span>
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 ps-5 text-xs text-muted-foreground">
                    {s.target_kind === "self" && s.mode ? (
                      <span>
                        {tm(s.mode)}
                        {s.project_name ? ` · ${s.project_name}` : ""}
                      </span>
                    ) : null}
                    {s.depends_on.length > 0 ? (
                      <span>
                        {t("after", { steps: s.depends_on.join(t("sep")) })}
                      </span>
                    ) : null}
                    {canOpenWork(target) ? (
                      <button
                        type="button"
                        className="underline-offset-2 hover:underline"
                        onClick={() => openWork(target)}
                      >
                        {t("act.open")}
                      </button>
                    ) : null}
                    {!readOnly && word === "confirm" && live
                      ? button(
                          `confirm:${s.seq}` as NoticeAction,
                          t("act.confirm"),
                          "secondary",
                          true
                        )
                      : null}
                    {!readOnly &&
                    s.state === "running" &&
                    plan.state === "stopped"
                      ? button(
                          `cancel_step:${s.seq}` as NoticeAction,
                          t("act.cancelStep"),
                          "ghost",
                          true
                        )
                      : null}
                  </div>
                  {s.state === "done" && s.result ? (
                    <p className="ms-5 line-clamp-3 border-s-2 border-border ps-2.5 text-xs leading-5 break-words whitespace-pre-wrap text-foreground/80">
                      {s.result}
                    </p>
                  ) : null}
                  {(s.state === "failed" || s.state === "canceled") &&
                  s.error ? (
                    <p className="ps-5 text-xs break-words text-red-700 dark:text-red-400">
                      {s.error}
                    </p>
                  ) : null}
                  {shown ? (
                    <div
                      className="flex flex-col gap-1 ps-5 text-xs"
                      data-pa-plan-step-detail
                    >
                      <p className="break-words whitespace-pre-wrap">
                        {s.prompt}
                      </p>
                      {s.done_when ? (
                        <p className="break-words whitespace-pre-wrap text-muted-foreground">
                          <span className="font-medium">{t("doneWhen")}</span>{" "}
                          {s.done_when}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ol>
        </SheetPart>
        {plan.changes.length > 0 ? (
          <ChangeList
            changes={plan.changes}
            text={changeText}
            readOnly={readOnly}
            busy={busy}
            onUndo={(i) => void act(`undo:${i}` as NoticeAction)}
          />
        ) : null}
        {actions.length > 0 ? <SheetActions>{actions}</SheetActions> : null}
        {failed ? (
          <SheetNote>
            <p role="alert" className="break-words text-destructive">
              {failed}
            </p>
          </SheetNote>
        ) : null}
      </CardMessage>
    </MessageRow>
  )
}

function faceAvatar(v: unknown): AvatarValue | null {
  if (!v || typeof v !== "object") return null
  const avatar = (v as { avatar?: unknown }).avatar
  return avatar && typeof avatar === "object" ? (avatar as AvatarValue) : null
}

function ChangeList({
  changes,
  text,
  readOnly,
  busy,
  onUndo,
}: {
  changes: PlanChangeView[]
  text: (i: PlanChangeItem) => string
  readOnly: boolean
  busy: string | null
  onUndo: (index: number) => void
}) {
  const t = useTranslations("PersonalAgent.plan")
  return (
    <SheetPart data-pa-plan-changes>
      <SheetLabel>{t("changes")}</SheetLabel>
      <ul className="flex flex-col gap-1.5">
        {changes.map((c) => (
          <li
            key={c.index}
            className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-xs"
            data-pa-plan-change={c.index}
          >
            <span className={cn("break-words", c.undone && "line-through")}>
              {c.items.map(text).join(t("sep"))}
            </span>
            {c.reason ? (
              <span className="break-words text-muted-foreground">
                — {c.reason}
              </span>
            ) : null}
            {c.undone ? (
              <span className="text-muted-foreground">
                {c.kept.length > 0
                  ? t("undoneKept", { steps: c.kept.join(t("sep")) })
                  : t("undone")}
              </span>
            ) : c.undoable && !readOnly ? (
              <button
                type="button"
                className="text-primary underline-offset-2 hover:underline disabled:opacity-50"
                disabled={busy != null}
                onClick={() => onUndo(c.index)}
                data-pa-plan-undo={c.index}
              >
                {t("undo")}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </SheetPart>
  )
}
