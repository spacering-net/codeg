/**
 * A matter's time in words (6.1): when it is due, how late a reminder came,
 * how a repeating one comes back — in the page's language, in the browser's
 * time zone (the owner's).
 *
 * - A due time reads as a clock time today, "tomorrow 15:00" or "yesterday
 *   15:00" next door, the weekday within a week, and a date beyond.
 * - Lateness is minutes under an hour, hours (and minutes, under ten hours)
 *   under a day, days beyond.
 * - A repeat rule reads as "every weekday 09:00", "every Mon, Wed 09:00",
 *   "day 15 of every month 09:00", with the last day when it has one.
 */

import type { ItemRepeat, ItemWeekday } from "@/lib/types"

import type { Translate } from "./activity-text"

const DAY_MS = 86_400_000

const WEEKDAYS: readonly ItemWeekday[] = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
]

function startOfDay(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function clockOf(at: Date, locale: string): string {
  return at.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
}

/** `15:00`, `Tomorrow 15:00`, `Thu 15:00`, `Nov 20 15:00` — a due time
 *  against `now`. Empty for a time that does not parse. */
export function dueWhen(
  t: Translate,
  iso: string,
  now: number,
  locale: string
): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ""
  const time = clockOf(at, locale)
  const days = Math.round((startOfDay(at.getTime()) - startOfDay(now)) / DAY_MS)
  if (days === 0) return time
  if (days === 1) return t("due.tomorrow", { time })
  if (days === -1) return t("due.yesterday", { time })
  if (Math.abs(days) <= 6) {
    const day = at.toLocaleDateString(locale, { weekday: "short" })
    return t("due.dayTime", { day, time })
  }
  const date = at.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    ...(at.getFullYear() !== new Date(now).getFullYear()
      ? { year: "numeric" }
      : {}),
  })
  return t("due.dayTime", { day: date, time })
}

/** `5 min`, `2 h`, `2 h 30 min`, `3 days` — how long, in seconds. */
export function humanDuration(t: Translate, secs: number): string {
  const minutes = Math.max(1, Math.round(secs / 60))
  if (minutes < 60) return t("due.duration.minutes", { n: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const rest = minutes % 60
    return hours < 10 && rest > 0
      ? t("due.duration.hoursMinutes", { h: hours, m: rest })
      : t("due.duration.hours", { n: hours })
  }
  return t("due.duration.days", { n: Math.floor(hours / 24) })
}

/** A weekday's short name in `locale` (2024-01-01 was a Monday). */
function weekdayName(day: ItemWeekday, locale: string): string {
  const i = WEEKDAYS.indexOf(day)
  return new Date(2024, 0, 1 + i).toLocaleDateString(locale, {
    weekday: "short",
  })
}

/** `Every weekday 09:00`, `Every Mon, Wed 09:00, until Dec 31` — how a
 *  repeating matter comes back. Empty for a rule it cannot read. */
export function repeatText(
  t: Translate,
  repeat: ItemRepeat,
  now: number,
  locale: string
): string {
  const time = repeat.at
  let rule: string
  switch (repeat.every) {
    case "daily":
      rule = t("due.repeat.daily", { time })
      break
    case "weekdays":
      rule = t("due.repeat.weekdays", { time })
      break
    case "weekly": {
      const days = WEEKDAYS.filter((d) => repeat.days?.includes(d))
      if (days.length === 0) return ""
      rule = t("due.repeat.weekly", {
        days: days.map((d) => weekdayName(d, locale)).join(t("due.repeat.sep")),
        time,
      })
      break
    }
    case "monthly":
      if (repeat.day == null) return ""
      rule = t("due.repeat.monthly", { day: repeat.day, time })
      break
    default:
      return ""
  }
  if (!repeat.until) return rule
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(repeat.until)
  if (!m) return rule
  const last = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const date = last.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    ...(last.getFullYear() !== new Date(now).getFullYear()
      ? { year: "numeric" }
      : {}),
  })
  return t("due.repeat.until", { rule, date })
}
