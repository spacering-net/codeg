"use client"

/**
 * A routine in the activity's "coming up" (C4, 6.9): one row — what it is
 * called (opening it to edit), whether it is paused, its menu ([Run now]
 * [Pause/Resume] [Edit] [Delete]) and the way to unfold it; under it when
 * it runs and its next run, or that it is running; a second line, in the
 * caution's colour, only when something is wrong — codeg paused it, its
 * last run failed, was missed, or waits on the owner. Unfolded: its facts,
 * one to a line, as the panel had them.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  ChevronRight,
  CirclePlay,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
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
import { usePersonalAgent } from "@/contexts/personal-agent-context"
import { personalAgentRoutineAct } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { Routine, RoutineAction } from "@/lib/types"
import { cn } from "@/lib/utils"
import { refreshActivity } from "@/stores/personal-agent-activity-store"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

import {
  eventWords,
  OutcomeWord,
  precheckWords,
  RoutineWhen,
  useWhen,
} from "./routine-bits"
import { SheetField, SheetFields } from "./shared"
import { StatusPill } from "./aux-parts/kit/status-pill"

/** A last run that says something is wrong, on the row's second line. */
const WRONG_OUTCOMES = new Set(["failed", "missed", "asked", "declined"])

export function RoutineRow({
  r,
  readOnly,
  open,
  onOpenChange,
  flash = false,
}: {
  r: Routine
  readOnly: boolean
  /** Its facts unfolded under it. */
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Just brought into view: marked for a moment. */
  flash?: boolean
}) {
  const t = useTranslations("PersonalAgent.routines")
  const ta = useTranslations("PersonalAgent.feed")
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
      refreshActivity()
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
    (r.paused_reason === "failures" || r.paused_reason === "work_agent")
  // Running: not one waiting on the owner to confirm, which has not ended
  // either and says so on its warning line.
  const running = last?.outcome === "running"
  const edit = () =>
    openEditor({ botId, routineId: r.id, draft: null, noticeId: null })
  const titleClass =
    "line-clamp-2 max-w-full min-w-0 text-sm leading-5 font-semibold break-words text-foreground"
  // When it runs, then where it stands: running, or its next run.
  const whenText = r.cron ? (
    <RoutineWhen cron={r.cron} event={null} zone={r.timezone} />
  ) : r.event ? (
    eventWords(t, r.event)
  ) : null
  const status = running ? (
    <span className="text-primary" data-pa-routine-status="running">
      {ta("routineRunning")}
    </span>
  ) : r.enabled && r.trigger === "schedule" && r.next_run_at ? (
    <span className="tabular-nums" data-pa-routine-status="next">
      {when(r.next_run_at)}
    </span>
  ) : null
  // Something wrong: one line in the caution's colour.
  const wrong = codegPaused
    ? r.paused_reason === "work_agent"
      ? t("card.pausedWorkAgent")
      : t("card.pausedFailures")
    : last && WRONG_OUTCOMES.has(last.outcome)
      ? ta("routineLast", {
          outcome: t(`outcome.${last.outcome}` as "outcome.failed"),
        })
      : null
  return (
    <>
      <div
        role="listitem"
        className={cn(
          "relative flex min-w-0 scroll-mt-12 flex-col gap-1 border-b border-border/50 px-4 py-3 transition-colors last:border-b-0",
          !readOnly && "has-[[data-pa-item-open]:hover]:bg-muted/40",
          !r.enabled && "opacity-70",
          flash && "bg-primary/10"
        )}
        data-pa-routine={r.id}
        data-pa-routine-enabled={r.enabled ? "on" : "off"}
        data-pa-activity-row={`routine:${r.id}`}
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
          <span className="relative z-10 -me-1.5 flex h-5 shrink-0 items-center">
            {readOnly ? null : (
              // What can be done with it — run it, pause or resume it,
              // edit, delete — in its menu; whether it is paused the pill
              // after its name says.
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
            )}
            <UnfoldButton open={open} onOpenChange={onOpenChange} />
          </span>
        </div>
        {whenText || status ? (
          <p
            className="min-w-0 text-xs leading-5 text-muted-foreground"
            data-pa-routine-line
          >
            {whenText}
            {whenText && status ? " · " : null}
            {status}
          </p>
        ) : null}
        {wrong ? (
          <p
            className="min-w-0 text-xs leading-5 text-amber-700 dark:text-amber-300"
            data-pa-routine-wrong
          >
            {wrong}
          </p>
        ) : null}
        {/* Unfolded: its facts, one to a line — what each is quiet on the
            left, the values lined up after them. */}
        {open ? (
          <SheetFields className="mt-1 gap-y-1" data-pa-routine-facts>
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
                  {r.paused_reason === "work_agent"
                    ? t("card.pausedWorkAgent")
                    : t("card.pausedFailures")}
                </span>
              </SheetField>
            ) : null}
          </SheetFields>
        ) : null}
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

/** The way to unfold a row of the activity (C3): a chevron at its end,
 *  turned while it is open — a button of its own, reached by the keyboard,
 *  saying whether it is open. */
export function UnfoldButton({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useTranslations("PersonalAgent.feed")
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      className="relative z-10 text-muted-foreground hover:text-foreground"
      aria-expanded={open}
      aria-label={open ? t("fold") : t("unfold")}
      title={open ? t("fold") : t("unfold")}
      onClick={() => onOpenChange(!open)}
      data-pa-unfold
    >
      <ChevronRight
        aria-hidden
        className={cn(
          "size-4 transition-transform rtl:-scale-x-100",
          open && "rotate-90 rtl:rotate-90"
        )}
      />
    </Button>
  )
}
