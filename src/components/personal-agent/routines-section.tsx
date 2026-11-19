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

import { useEffect, useRef, useState, type RefObject } from "react"
import { useTranslations } from "next-intl"
import {
  CalendarClock,
  CirclePlay,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  Repeat,
  Trash2,
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
  eventWords,
  OutcomeWord,
  precheckWords,
  RoutineWhen,
  useWhen,
} from "./routine-bits"
import { SheetField, SheetFields } from "./shared"
import { StatusPill } from "./aux/kit/status-pill"

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
  // Paused by codeg: why, in the caution's colour — and its pill so.
  const codegPaused =
    !r.enabled &&
    (r.paused_reason === "failures" || r.paused_reason === "executor")
  const edit = () =>
    openEditor({ botId, routineId: r.id, draft: null, noticeId: null })
  const titleClass =
    "line-clamp-2 max-w-full min-w-0 text-sm leading-5 font-semibold break-words text-foreground"
  return (
    <>
      <div
        role="listitem"
        className={cn(
          "relative flex min-w-0 flex-col gap-2 border-b border-border/50 px-4 py-3 last:border-b-0",
          !readOnly && "has-[[data-pa-item-open]:hover]:bg-muted/40"
        )}
        data-pa-routine={r.id}
        data-pa-routine-enabled={r.enabled ? "on" : "off"}
      >
        {/* Its head: what it is called, whether it is paused, and its
            controls at the end. Narrow, the pill goes under the name: the
            name keeps the room the controls leave. */}
        <div className="flex min-w-0 items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
            {readOnly ? (
              <span className={titleClass}>{r.title}</span>
            ) : (
              // Its ::after covers the row: a click anywhere on it opens it
              // to edit, but on its controls, which sit over it.
              <button
                type="button"
                data-pa-item-open
                onClick={edit}
                title={t("edit")}
                className="flex max-w-full min-w-0 text-start outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-ring/50 focus-visible:after:ring-inset"
              >
                <span className={titleClass}>{r.title}</span>
              </button>
            )}
            {!r.enabled ? (
              <StatusPill
                tone={codegPaused ? "amber" : "muted"}
                data-pa-routine-state
              >
                {t("paused.owner")}
              </StatusPill>
            ) : null}
          </div>
          {readOnly ? null : (
            // One button at its end: what can be done with it — run it,
            // pause or resume it, edit, delete — in its menu; whether it is
            // paused the pill after its name says.
            <span className="relative z-10 -me-1.5 flex h-5 shrink-0 items-center">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="text-muted-foreground hover:text-foreground"
                    disabled={busy != null}
                    aria-label={t("more")}
                    title={t("more")}
                    data-pa-routine-menu
                  >
                    <MoreHorizontal aria-hidden className="size-4" />
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
                  <DropdownMenuItem
                    onSelect={() => void act(r.enabled ? "pause" : "resume")}
                    data-pa-routine-act={r.enabled ? "pause" : "resume"}
                  >
                    {r.enabled ? (
                      <Pause aria-hidden />
                    ) : (
                      <CirclePlay aria-hidden />
                    )}
                    {r.enabled ? t("pause") : t("resume")}
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
          )}
        </div>
        {/* Its facts, one to a line: what each is quiet on the left, the
            values lined up after them. */}
        <SheetFields className="gap-y-1" data-pa-routine-facts>
          {r.cron || r.event ? (
            <SheetField
              label={t(r.cron ? "row.when" : "row.trigger")}
              data-pa-routine-fact="when"
            >
              <span>
                {r.cron ? (
                  <RoutineWhen cron={r.cron} event={null} zone={r.timezone} />
                ) : (
                  eventWords(t, r.event!)
                )}
              </span>
            </SheetField>
          ) : null}
          <SheetField label={t("row.how")} data-pa-routine-fact="how">
            <span>
              {t(`kind.${r.kind}` as "kind.brain")}
              {precheck ? ` · ${precheck}` : null}
            </span>
          </SheetField>
          {r.enabled && r.trigger === "schedule" && r.next_run_at ? (
            <SheetField label={t("row.next")} data-pa-routine-fact="next">
              <span className="tabular-nums">{when(r.next_run_at)}</span>
            </SheetField>
          ) : null}
          {last ? (
            <SheetField label={t("row.last")} data-pa-routine-fact="last">
              {/* Each fact kept whole on its line: it wraps between them. */}
              <span>
                <span className="whitespace-nowrap tabular-nums">
                  {when(last.ended_at ?? last.started_at)}
                </span>
                {" · "}
                <OutcomeWord outcome={last.outcome} />
                {" · "}
                <span className="whitespace-nowrap tabular-nums">
                  {t("row.runs", { n: r.runs })}
                </span>
                {last.note && last.outcome !== "reported" ? (
                  <span className="text-muted-foreground">
                    {" · "}
                    {last.note}
                  </span>
                ) : null}
              </span>
            </SheetField>
          ) : null}
          {codegPaused ? (
            <SheetField label={t("row.why")} data-pa-routine-fact="why">
              <span className="text-amber-700 dark:text-amber-300">
                {r.paused_reason === "executor"
                  ? t("card.pausedExecutor")
                  : t("card.pausedFailures")}
              </span>
            </SheetField>
          ) : null}
        </SheetFields>
      </div>
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
