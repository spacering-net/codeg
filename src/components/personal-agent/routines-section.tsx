"use client"

/**
 * The details' "Routines" (6.9, 10.1): this assistant's routines, each with
 * when it runs, its next run and how its last went, and [Run now] [Pause /
 * Resume] [Edit] [Delete]. Empty: a line saying to ask for one in the
 * conversation, and [New routine].
 */

import { useEffect, useRef, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { CalendarClock, Plus, Zap } from "lucide-react"
import { toast } from "sonner"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { usePersonalAgent } from "@/contexts/personal-agent-context"
import { personalAgentRoutineAct, personalAgentRoutines } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { Routine, RoutineAction } from "@/lib/types"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

import {
  OutcomeChip,
  precheckWords,
  RoutineWhen,
  useWhen,
} from "./routine-bits"

/** An assistant's routines, kept fresh as they change. */
export function useRoutines(): Routine[] | null {
  const { botId, routineVersion } = usePersonalAgent()
  // Kept with the assistant they are of: another one shown waits for its
  // own, never listing the last one's.
  const [read, setRead] = useState<{
    bot: number | null
    list: Routine[]
  } | null>(null)
  useEffect(() => {
    let alive = true
    personalAgentRoutines(botId)
      .then((l) => {
        if (alive) setRead({ bot: botId, list: l })
      })
      .catch(() => {
        if (alive) setRead({ bot: botId, list: [] })
      })
    return () => {
      alive = false
    }
  }, [botId, routineVersion])
  return read?.bot === botId ? read.list : null
}

export function RoutinesSection({
  head,
  readOnly,
}: {
  head: ReactNode
  /** The assistants run in another process: nothing is acted on here. */
  readOnly: boolean
}) {
  const t = useTranslations("PersonalAgent.routines")
  const { botId } = usePersonalAgent()
  const list = useRoutines()
  const openEditor = usePersonalAgentUi((s) => s.openRoutineEditor)
  // `pa.open` on a routine brings them into view.
  const asked = usePersonalAgentUi((s) => s.routinesAsked)
  const ref = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (asked > 0) ref.current?.scrollIntoView({ block: "start" })
  }, [asked])
  const add = () =>
    openEditor({ botId, routineId: null, draft: null, noticeId: null })
  return (
    <section
      ref={ref}
      className="flex scroll-mt-3 flex-col gap-2"
      data-pa-detail="routines"
    >
      {head}
      {list == null ? (
        <Skeleton className="h-14 w-full rounded-xl" aria-hidden />
      ) : list.length === 0 ? (
        <div className="flex flex-col items-start gap-2">
          <p
            className="text-xs leading-5 text-muted-foreground"
            data-pa-routines-empty
          >
            {t("empty")}
          </p>
          {!readOnly ? (
            <Button size="xs" variant="outline" onClick={add}>
              <Plus aria-hidden />
              {t("new")}
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {list.map((r) => (
            <RoutineCard key={r.id} r={r} readOnly={readOnly} />
          ))}
          {!readOnly ? (
            <Button
              size="xs"
              variant="ghost"
              className="self-start text-muted-foreground"
              onClick={add}
              data-pa-routine-new
            >
              <Plus aria-hidden />
              {t("new")}
            </Button>
          ) : null}
        </div>
      )}
    </section>
  )
}

function RoutineCard({ r, readOnly }: { r: Routine; readOnly: boolean }) {
  const t = useTranslations("PersonalAgent.routines")
  const { botId } = usePersonalAgent()
  const openEditor = usePersonalAgentUi((s) => s.openRoutineEditor)
  const when = useWhen()
  const [busy, setBusy] = useState<RoutineAction | null>(null)
  const [deleting, setDeleting] = useState(false)
  const act = async (a: RoutineAction) => {
    if (busy) return
    setBusy(a)
    try {
      await personalAgentRoutineAct(botId, r.id, a)
    } catch (e) {
      toast.error(toErrorMessage(e))
    } finally {
      setBusy(null)
    }
  }
  const last = r.last[0]
  const precheck = precheckWords(t, r.precheck)
  const Icon = r.trigger === "event" ? Zap : CalendarClock
  const state = !r.enabled
    ? t(
        `paused.${r.paused_reason === "failures" || r.paused_reason === "executor" ? r.paused_reason : "owner"}` as "paused.owner"
      )
    : r.trigger === "schedule" && r.next_run_at
      ? t("next", { when: when(r.next_run_at) })
      : null
  return (
    <div
      className="flex w-full min-w-0 flex-col rounded-xl border border-foreground/15 bg-card ws-msg-card p-3"
      data-pa-routine={r.id}
      data-pa-routine-enabled={r.enabled ? "on" : "off"}
    >
      <span className="flex min-w-0 items-start gap-2">
        <Icon
          className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
          aria-hidden
        />
        <span className="min-w-0 flex-1 text-[0.8125rem] leading-snug font-medium break-words text-foreground">
          {r.title}
        </span>
        {last ? <OutcomeChip outcome={last.outcome} /> : null}
      </span>
      <span className="mt-1.5 block text-[0.6875rem] break-words text-muted-foreground">
        <RoutineWhen cron={r.cron} event={r.event} zone={r.timezone} />
        {" · "}
        {t(`kind.${r.kind}` as "kind.brain")}
        {precheck ? ` · ${precheck}` : null}
      </span>
      {state ? (
        <span
          className={
            r.enabled
              ? "mt-1 block text-[0.6875rem] text-muted-foreground tabular-nums"
              : "mt-1 block text-[0.6875rem] text-amber-700 dark:text-amber-300"
          }
          data-pa-routine-state
        >
          {state}
        </span>
      ) : null}
      {last ? (
        <span className="mt-1 block text-[0.6875rem] text-muted-foreground tabular-nums">
          {t("last", {
            when: when(last.ended_at ?? last.started_at),
            n: r.runs,
          })}
          {last.note && last.outcome !== "reported" ? ` · ${last.note}` : null}
        </span>
      ) : null}
      {!readOnly ? (
        <div className="mt-2 flex flex-wrap gap-1">
          <Button
            size="xs"
            variant="outline"
            disabled={busy != null || !r.enabled}
            onClick={() => void act("run_now")}
            data-pa-routine-act="run_now"
          >
            {t("runNow")}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={busy != null}
            onClick={() => void act(r.enabled ? "pause" : "resume")}
            data-pa-routine-act={r.enabled ? "pause" : "resume"}
          >
            {r.enabled ? t("pause") : t("resume")}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={busy != null}
            onClick={() =>
              openEditor({
                botId,
                routineId: r.id,
                draft: null,
                noticeId: null,
              })
            }
            data-pa-routine-act="edit"
          >
            {t("edit")}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            className="text-muted-foreground"
            disabled={busy != null}
            onClick={() => setDeleting(true)}
            data-pa-routine-act="delete"
          >
            {t("delete")}
          </Button>
        </div>
      ) : null}
      <AlertDialog open={deleting} onOpenChange={setDeleting}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteDescription", { title: r.title })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void act("delete")}
              data-pa-routine-delete-confirm
            >
              {t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
