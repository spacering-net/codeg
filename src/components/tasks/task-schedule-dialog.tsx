"use client"

import { useEffect, useState } from "react"
import { useLocale, useTranslations } from "next-intl"
import { toast } from "sonner"
import { CalendarClock, ChevronDown, TriangleAlert } from "lucide-react"
import { workTaskSchedule } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { dateFnsLocale } from "@/lib/date-fns-locale"
import {
  defaultTimeForDate,
  formatScheduleDay,
  formatScheduleFull,
  isoToDateTimeLocalValue,
  isScheduleInPast,
  joinDateAndTime,
  parseDateTimeLocalValue,
  schedulePresets,
  splitDateTimeLocalValue,
  toDateTimeLocalValue,
} from "@/lib/task-schedule"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import type { WorkTask } from "@/lib/types"

interface TaskScheduleDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  task: WorkTask | null
}

/** `YYYY-MM-DD` ⇄ `Date`, both anchored to LOCAL midnight — the calendar hands
 *  back a Date and the rest of the schedule code speaks the input strings. */
function toDayValue(date: Date): string {
  return toDateTimeLocalValue(date).slice(0, 10)
}
function fromDayValue(day: string): Date | undefined {
  if (!day) return undefined
  const parsed = new Date(`${day}T00:00`)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

/**
 * Plan when a to-do task starts.
 *
 * Two controls rather than one `datetime-local`: a calendar popover for the day
 * (shadcn's Popover + Calendar composition) and a plain time input for the
 * hour. Both speak the user's own wall clock — which is what "run it at nine"
 * means — and the conversion to the UTC instant the backend stores happens on
 * save (see `lib/task-schedule`).
 *
 * It opens EMPTY unless the task already has a plan. Seeding an unplanned task
 * with a time made every to-do task look scheduled; now a blank field says what
 * is true, and picking a day fills the hour in (see `defaultTimeForDate`) so
 * one decision stays one decision.
 *
 * A time already in the past is accepted rather than refused: the engine simply
 * claims it on its next sweep. The dialog says so, so it can't read as a plan
 * that silently did nothing.
 */
export function TaskScheduleDialog({
  open,
  onOpenChange,
  task,
}: TaskScheduleDialogProps) {
  const t = useTranslations("Tasks")
  const locale = useLocale()
  const [date, setDate] = useState("")
  const [time, setTime] = useState("")
  const [calendarOpen, setCalendarOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  // Frozen at open: the presets and the "already passed" hint are a snapshot of
  // the moment the dialog appeared, and a ticking `now` would move them under
  // the pointer.
  const [openedAt, setOpenedAt] = useState(() => Date.now())

  // Keyed on the task's IDENTITY, not the row object: the board refetches on
  // every `task://changed` nudge and hands down a fresh object each time, so
  // depending on `task` would wipe a half-typed time whenever anything else on
  // the board moved.
  const taskId = task?.id ?? null
  const plannedAt = task?.scheduled_at ?? null
  useEffect(() => {
    if (!open) return
    // Kept as an effect: the reset reads the clock, which must not happen
    // during render.
    /* eslint-disable react-hooks/set-state-in-effect */
    const now = new Date()
    setOpenedAt(now.getTime())
    const planned = plannedAt ? isoToDateTimeLocalValue(plannedAt) : null
    const parts = splitDateTimeLocalValue(planned ?? "")
    setDate(parts.date)
    setTime(parts.time)
    setCalendarOpen(false)
    setSubmitting(false)
    /* eslint-enable react-hooks/set-state-in-effect */
    // `plannedAt` seeds the fields but deliberately does not re-run this: while
    // the dialog is open the inputs belong to the user, not to the row.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, taskId])

  const value = joinDateAndTime(date, time)
  const picked = parseDateTimeLocalValue(value)

  const applyCombined = (combined: string) => {
    const parts = splitDateTimeLocalValue(combined)
    setDate(parts.date)
    setTime(parts.time)
  }

  const pickDay = (picked: Date | undefined) => {
    if (!picked) return
    const day = toDayValue(picked)
    setDate(day)
    // Only ever fills a BLANK time — an hour the user chose is never moved.
    if (!time) setTime(defaultTimeForDate(day, new Date(openedAt)))
    setCalendarOpen(false)
  }
  const isPast = picked != null && isScheduleInPast(picked, openedAt)
  const scheduled = plannedAt != null

  const save = async (next: string | null) => {
    if (!task) return
    setSubmitting(true)
    try {
      await workTaskSchedule(task.id, next)
      toast.success(
        next
          ? t("toastScheduled", { time: formatScheduleFull(next) })
          : t("toastScheduleCleared")
      )
      onOpenChange(false)
    } catch (e) {
      toast.error(toErrorMessage(e))
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[28rem]">
        <DialogHeader>
          <DialogTitle>{t("scheduleTitle")}</DialogTitle>
          <DialogDescription>{t("scheduleDescription")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {/* Day and hour side by side, each with its own label — the two are
              one plan, and a stacked pair would read as two questions. */}
          <div className="flex items-end gap-2">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Label htmlFor="task-schedule-date">
                {t("scheduleDateLabel")}
              </Label>
              <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
                <PopoverTrigger asChild>
                  <Button
                    id="task-schedule-date"
                    type="button"
                    variant="outline"
                    className={cn(
                      "h-9 w-full justify-between px-3 font-normal",
                      !date && "text-muted-foreground"
                    )}
                  >
                    <span className="truncate">
                      {date
                        ? formatScheduleDay(date, locale)
                        : t("schedulePickDate")}
                    </span>
                    <ChevronDown
                      className="size-4 shrink-0 opacity-50"
                      aria-hidden="true"
                    />
                  </Button>
                </PopoverTrigger>
                {/* w-auto p-0: the shared PopoverContent is a padded w-72 box,
                    which would crop and inset the calendar. */}
                <PopoverContent align="start" className="w-auto p-0">
                  <Calendar
                    mode="single"
                    autoFocus
                    locale={dateFnsLocale(locale)}
                    selected={fromDayValue(date)}
                    defaultMonth={fromDayValue(date)}
                    onSelect={pickDay}
                  />
                </PopoverContent>
              </Popover>
            </div>
            <div className="flex w-32 shrink-0 flex-col gap-1.5">
              <Label htmlFor="task-schedule-time">
                {t("scheduleTimeLabel")}
              </Label>
              <Input
                id="task-schedule-time"
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                // WebKit draws its own clock button inside the field; the
                // calendar next door already owns "open a picker".
                className="px-3 [&::-webkit-calendar-picker-indicator]:hidden"
              />
            </div>
          </div>

          {/* One-tap options for the times people actually pick — they fill
              both halves, so a preset is still a single decision. */}
          <div className="flex flex-wrap gap-1.5">
            {schedulePresets(new Date(openedAt)).map((preset) => (
              <Button
                key={preset.labelKey}
                type="button"
                size="sm"
                variant="ghost"
                aria-pressed={value === preset.value}
                className={cn(
                  "h-7 rounded-full bg-muted/70 px-3 text-xs font-medium hover:bg-muted",
                  value === preset.value && "bg-primary/10 text-primary"
                )}
                onClick={() => applyCombined(preset.value)}
              >
                {t(preset.labelKey)}
              </Button>
            ))}
          </div>

          <p
            className={cn(
              "flex items-center gap-1.5 text-xs",
              isPast
                ? "text-amber-600 dark:text-amber-400"
                : "text-muted-foreground"
            )}
          >
            {isPast ? (
              <>
                <TriangleAlert
                  className="size-3.5 shrink-0"
                  aria-hidden="true"
                />
                {t("schedulePastHint")}
              </>
            ) : picked ? (
              <>
                <CalendarClock
                  className="size-3.5 shrink-0"
                  aria-hidden="true"
                />
                {t("schedulePreview", {
                  time: formatScheduleFull(picked.toISOString()),
                })}
              </>
            ) : null}
          </p>
        </div>

        <DialogFooter>
          {/* Unplanning is not a cancel — it leaves the task on the board under
              manual control, so it belongs beside the save, not behind it. */}
          {scheduled ? (
            <Button
              type="button"
              variant="ghost"
              className="mr-auto text-muted-foreground hover:text-foreground"
              onClick={() => void save(null)}
              disabled={submitting}
            >
              {t("scheduleClear")}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            {t("cancel")}
          </Button>
          <Button
            type="button"
            onClick={() => picked && void save(picked.toISOString())}
            disabled={submitting || picked == null}
          >
            {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
