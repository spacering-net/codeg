"use client"

/**
 * The activity tab's "Routines" (6.9, 10.1): this assistant's routines on
 * one folding card, as the tab's other groups are — its bar the part's
 * title, how many, [+] and the chevron; no head over it. Each a row: what
 * it is called and its switch, when it runs and what it does, and one
 * quiet line of where it stands — its next run or that it is paused (why,
 * in the caution's colour, when codeg paused it) and how its last run went.
 * [Run now] [Edit] [Delete] in its menu; its title opens it to edit.
 * Empty: one row — its name, a line saying to ask for one in the
 * conversation, and [New routine] at its end.
 */

import { Fragment, useEffect, useRef, useState, type RefObject } from "react"
import { useTranslations } from "next-intl"
import {
  CalendarClock,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  Repeat,
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
import { cn } from "@/lib/utils"
import {
  ROUTINES_FOLD,
  usePersonalAgentUi,
} from "@/stores/personal-agent-ui-store"

import { PanelGroup, PanelIcon, PanelItem, PanelStack } from "./panel-section"
import {
  OutcomeWord,
  precheckWords,
  RoutineWhen,
  useWhen,
} from "./routine-bits"

/** An assistant's routines, kept fresh as they change — read only while
 *  `active` (the page above may have read them already). */
export function useRoutines(active = true): Routine[] | null {
  const { botId, routineVersion } = usePersonalAgent()
  // Kept with the assistant they are of: another one shown waits for its
  // own, never listing the last one's.
  const [read, setRead] = useState<{
    bot: number | null
    list: Routine[]
  } | null>(null)
  useEffect(() => {
    if (!active) return
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
  }, [botId, routineVersion, active])
  return read?.bot === botId ? read.list : null
}

/** `pa.open` on a routine, or "open its routines", brings them into view —
 *  the card (`showRoutines` unfolds it), or the row that says there are
 *  none. */
function useRoutinesAsked(ref: RefObject<HTMLElement | null>) {
  const asked = usePersonalAgentUi((s) => s.routinesAsked)
  useEffect(() => {
    if (asked > 0) ref.current?.scrollIntoView({ block: "start" })
  }, [asked, ref])
}

/** No routines yet: one row — its name, how to get one, [New routine] at
 *  its end — to sit in a stack, alone or under the matters' own. */
export function RoutinesEmptyRow({
  title,
  readOnly,
}: {
  title: string
  readOnly: boolean
}) {
  const t = useTranslations("PersonalAgent.routines")
  const { botId } = usePersonalAgent()
  const openEditor = usePersonalAgentUi((s) => s.openRoutineEditor)
  const ref = useRef<HTMLDivElement | null>(null)
  useRoutinesAsked(ref)
  return (
    <PanelItem
      ref={ref}
      media={<PanelIcon icon={CalendarClock} />}
      title={title}
      meta={<span data-pa-routines-empty>{t("empty")}</span>}
      action={
        readOnly ? null : (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              openEditor({
                botId,
                routineId: null,
                draft: null,
                noticeId: null,
              })
            }
          >
            <Plus aria-hidden />
            {t("new")}
          </Button>
        )
      }
      className="scroll-mt-3"
      data-pa-detail="routines"
    />
  )
}

export function RoutinesSection({
  title,
  readOnly,
  list: given,
}: {
  title: string
  /** The assistants run in another process: nothing is acted on here. */
  readOnly: boolean
  /** Its routines, when the page above has read them; read here if not. */
  list?: Routine[] | null
}) {
  const t = useTranslations("PersonalAgent.routines")
  const { botId } = usePersonalAgent()
  const read = useRoutines(given === undefined)
  const list = given === undefined ? read : given
  const openEditor = usePersonalAgentUi((s) => s.openRoutineEditor)
  const ref = useRef<HTMLElement | null>(null)
  useRoutinesAsked(ref)
  const add = () =>
    openEditor({ botId, routineId: null, draft: null, noticeId: null })
  // None: the row that says so, no head over it.
  if (list != null && list.length === 0) {
    return (
      <PanelStack>
        <RoutinesEmptyRow title={title} readOnly={readOnly} />
      </PanelStack>
    )
  }
  if (list == null) {
    return (
      <Skeleton
        ref={ref as RefObject<HTMLDivElement | null>}
        className="h-16 w-full scroll-mt-3 rounded-2xl"
        aria-hidden
        data-pa-detail="routines"
      />
    )
  }
  return (
    <PanelGroup
      ref={ref}
      fold={ROUTINES_FOLD}
      tone="muted"
      icon={Repeat}
      label={title}
      count={list.length}
      titled
      action={
        readOnly ? null : (
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
        )
      }
      className="scroll-mt-3"
      data-pa-detail="routines"
    >
      {list.map((r) => (
        <RoutineRow key={r.id} r={r} readOnly={readOnly} />
      ))}
    </PanelGroup>
  )
}

function RoutineRow({ r, readOnly }: { r: Routine; readOnly: boolean }) {
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
  // Where it stands: paused by codeg — why, in the caution's colour — or
  // its next run. Paused by its owner says so by its switch, off, and its
  // name, quiet: no word more on a line that has little room — but where
  // there is no switch.
  const codegPaused =
    !r.enabled &&
    (r.paused_reason === "failures" || r.paused_reason === "executor")
  const state = codegPaused
    ? t(`paused.${r.paused_reason}` as "paused.owner")
    : !r.enabled && readOnly
      ? t("paused.owner")
      : r.enabled && r.trigger === "schedule" && r.next_run_at
        ? t("next", { when: when(r.next_run_at) })
        : null
  // One quiet line: where it stands, then how its last run went.
  const status = [
    state ? (
      <span
        key="state"
        className={cn(
          "tabular-nums",
          codegPaused
            ? "text-amber-700 dark:text-amber-300"
            : "whitespace-nowrap"
        )}
        data-pa-routine-state
      >
        {state}
      </span>
    ) : null,
    last ? <OutcomeWord key="outcome" outcome={last.outcome} /> : null,
    last ? (
      <span key="last" className="whitespace-nowrap tabular-nums">
        {t("last", {
          when: when(last.ended_at ?? last.started_at),
          n: r.runs,
        })}
      </span>
    ) : null,
    last?.note && last.outcome !== "reported" ? (
      <span key="note">{last.note}</span>
    ) : null,
  ].filter((x) => x != null)
  const edit = () =>
    openEditor({ botId, routineId: r.id, draft: null, noticeId: null })
  return (
    <>
      <PanelItem
        media={<PanelIcon icon={Icon} />}
        // Paused: its name quiet, as its switch is off.
        title={
          r.enabled ? (
            r.title
          ) : (
            <span className="text-muted-foreground">{r.title}</span>
          )
        }
        onOpen={readOnly ? null : edit}
        openLabel={t("edit")}
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
        notes={
          status.length > 0
            ? [
                // Each fact kept whole on its line: it wraps between them.
                <span key="status" data-pa-routine-status>
                  {status.map((el, i) => (
                    <Fragment key={i}>
                      {i > 0 ? " · " : null}
                      {el}
                    </Fragment>
                  ))}
                </span>,
              ]
            : []
        }
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
