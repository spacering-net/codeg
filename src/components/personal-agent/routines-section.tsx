"use client"

/**
 * The activity tab's "Routines" (6.9, 10.1): this assistant's routines, each with
 * when it runs, its next run and how its last went; a switch that pauses and
 * resumes it, and [Run now] [Edit] [Delete] in its menu — its title opens
 * it to edit. Empty: a line saying to ask for one in the conversation, and
 * [New routine]; with some, [+] at the section's head.
 */

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  CalendarClock,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Trash2,
  Zap,
} from "lucide-react"
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { usePersonalAgent } from "@/contexts/personal-agent-context"
import { personalAgentRoutineAct, personalAgentRoutines } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { Routine, RoutineAction } from "@/lib/types"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

import {
  PanelEmpty,
  PanelIcon,
  PanelItem,
  PanelList,
  PanelSection,
} from "./panel-section"
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
  title,
  readOnly,
}: {
  title: string
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
    <PanelSection
      ref={ref}
      title={title}
      count={list?.length ?? null}
      action={
        !readOnly && list != null && list.length > 0 ? (
          <Button
            size="icon-xs"
            variant="ghost"
            className="text-muted-foreground"
            onClick={add}
            title={t("new")}
            aria-label={t("new")}
            data-pa-routine-new
          >
            <Plus aria-hidden />
          </Button>
        ) : null
      }
      className="scroll-mt-3"
      data-pa-detail="routines"
    >
      {list == null ? (
        <Skeleton className="h-16 w-full rounded-xl" aria-hidden />
      ) : list.length === 0 ? (
        <PanelEmpty
          icon={CalendarClock}
          className="flex-wrap"
          action={
            !readOnly ? (
              <Button size="xs" variant="outline" onClick={add}>
                <Plus aria-hidden />
                {t("new")}
              </Button>
            ) : null
          }
        >
          <span data-pa-routines-empty>{t("empty")}</span>
        </PanelEmpty>
      ) : (
        <PanelList>
          {list.map((r) => (
            <RoutineCard key={r.id} r={r} readOnly={readOnly} />
          ))}
        </PanelList>
      )}
    </PanelSection>
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
  const edit = () =>
    openEditor({ botId, routineId: r.id, draft: null, noticeId: null })
  return (
    <>
      <PanelItem
        media={<PanelIcon icon={Icon} />}
        title={r.title}
        onOpen={readOnly ? null : edit}
        openLabel={t("edit")}
        chip={readOnly && last ? <OutcomeChip outcome={last.outcome} /> : null}
        aside={
          readOnly ? null : (
            <span className="flex items-center gap-0.5">
              <Switch
                checked={r.enabled}
                disabled={busy != null}
                onCheckedChange={(on) => void act(on ? "resume" : "pause")}
                aria-label={t("enabled")}
                title={r.enabled ? t("pause") : t("resume")}
                data-pa-routine-act={r.enabled ? "pause" : "resume"}
              />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="text-muted-foreground"
                    disabled={busy != null}
                    aria-label={t("more")}
                    title={t("more")}
                    data-pa-routine-menu
                  >
                    <MoreHorizontal aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-36">
                  <DropdownMenuItem
                    disabled={!r.enabled}
                    onSelect={() => void act("run_now")}
                    data-pa-routine-act="run_now"
                  >
                    <Play aria-hidden />
                    {t("runNow")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={edit} data-pa-routine-act="edit">
                    <Pencil aria-hidden />
                    {t("edit")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => setDeleting(true)}
                    data-pa-routine-act="delete"
                  >
                    <Trash2 aria-hidden />
                    {t("delete")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </span>
          )
        }
        meta={
          <>
            <RoutineWhen cron={r.cron} event={r.event} zone={r.timezone} />
            {" · "}
            {t(`kind.${r.kind}` as "kind.brain")}
            {precheck ? ` · ${precheck}` : null}
          </>
        }
        notes={[
          ...(state
            ? [
                <span
                  key="state"
                  className={
                    r.enabled
                      ? "tabular-nums"
                      : "text-amber-700 dark:text-amber-300"
                  }
                  data-pa-routine-state
                >
                  {state}
                </span>,
              ]
            : []),
          ...(last
            ? [
                <span
                  key="last"
                  className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 tabular-nums"
                >
                  {readOnly ? null : <OutcomeChip outcome={last.outcome} />}
                  <span>
                    {t("last", {
                      when: when(last.ended_at ?? last.started_at),
                      n: r.runs,
                    })}
                    {last.note && last.outcome !== "reported"
                      ? ` · ${last.note}`
                      : null}
                  </span>
                </span>,
              ]
            : []),
        ]}
        data-pa-routine={r.id}
        data-pa-routine-enabled={r.enabled ? "on" : "off"}
      />
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
    </>
  )
}
