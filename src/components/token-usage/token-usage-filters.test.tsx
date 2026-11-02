/**
 * The custom range's calendar hands back `Date`s while the dashboard's range
 * math takes `YYYY-MM-DD` local days. That conversion is the one place this
 * control can be silently wrong — a UTC round-trip shifts every range a day
 * west of Greenwich — so it is what these pin, together with the two-click
 * gesture itself (which endpoint a click moves, and when the popover closes).
 */
import { useState } from "react"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import { toLocalDayValue } from "@/lib/token-usage"
import { CustomRangeFields } from "./token-usage-filters"

function renderFields(from = "", to = "") {
  const onChange = vi.fn()
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <CustomRangeFields from={from} to={to} onChange={onChange} />
    </NextIntlClientProvider>
  )
  return onChange
}

/**
 * The control is a controlled input, so a `vi.fn()` onChange leaves it frozen on
 * its initial props — fine for one click, useless for a two-click gesture. This
 * wrapper holds the state the page normally would, and records what it is told.
 */
function renderLive(from = "", to = "") {
  const seen: { from: string; to: string }[] = []
  // `Array.prototype.at` is outside this project's TS lib target.
  const last = () => seen[seen.length - 1]
  function Harness() {
    const [range, setRange] = useState({ from, to })
    return (
      <CustomRangeFields
        from={range.from}
        to={range.to}
        onChange={(next) => {
          seen.push(next)
          setRange(next)
        }}
      />
    )
  }
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <Harness />
    </NextIntlClientProvider>
  )
  return last
}

const pill = () => screen.getByRole("button", { name: "Pick a date range" })
const calendarOpen = () =>
  document.querySelector("[data-slot=calendar]") != null

/**
 * A day cell of the open calendar, by `data-day` — `CalendarDayButton` stamps
 * it with `toLocaleDateString()`, so deriving it the same way is exact in
 * whatever locale the runner defaults to. Two months are shown, so the same
 * date can appear twice (once as a neighbouring month's outside day); either
 * one denotes the same date.
 */
function dayCell(date: Date): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    `button[data-day="${date.toLocaleDateString()}"]`
  )
}

/** The calendar opens on mount, so this only waits for the cell to paint. */
function findDay(date: Date) {
  return waitFor(() => {
    const found = dayCell(date)
    if (!found) throw new Error("day cell not rendered yet")
    return found
  })
}

/** The nth day of the month the calendar's left pane opens on (one month back,
 *  so every day of it is in the past and none is disabled). */
function lastMonthDay(n: number): Date {
  const d = new Date()
  d.setDate(1)
  d.setMonth(d.getMonth() - 1)
  d.setDate(n)
  d.setHours(0, 0, 0, 0)
  return d
}

describe("CustomRangeFields", () => {
  beforeEach(() => {
    // Pin "today" to mid-month: the calendar renders a two-month window ending
    // this month, so tomorrow can fall outside the grid near month-end.
    // Fake only Date so userEvent and waitFor keep using real timers.
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date(2026, 6, 15, 12, 0))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("shows a placeholder until a range is picked", () => {
    renderFields()
    expect(pill()).toHaveTextContent("Pick a date range")
  })

  it("renders the picked span on the pill", () => {
    renderFields("2026-08-01", "2026-08-07")
    expect(pill()).toHaveTextContent("8/1 – 8/7")
  })

  it("reports a clicked day as a local YYYY-MM-DD, not a UTC slip", async () => {
    const onChange = renderFields()
    const first = lastMonthDay(1)

    await userEvent.click(await findDay(first))
    await waitFor(() => expect(onChange).toHaveBeenCalled())
    expect(onChange.mock.calls[0][0].from).toBe(toLocalDayValue(first))
  })

  it("disables days after today — there are no future statistics", async () => {
    renderFields()
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    expect(await findDay(tomorrow)).toBeDisabled()
  })

  it("opens on last month too, so a cross-month span needs no paging", async () => {
    // Defaulting to today would show [this month, next month] — and next month
    // is entirely future, hence entirely disabled. The 15th is picked as a day
    // that cannot be an adjacent month's outside day.
    renderFields()
    expect(await findDay(lastMonthDay(15))).toBeEnabled()
  })

  it("opens its calendar straight away — being mounted IS picking 'custom'", () => {
    renderFields()
    expect(calendarOpen()).toBe(true)
  })

  it("takes both ends in one visit, then closes", async () => {
    const lastChange = renderLive()
    const start = lastMonthDay(10)
    const end = lastMonthDay(14)

    await userEvent.click(await findDay(start))
    // Still open, and only the start is committed: closing here (or reporting a
    // one-day range) is what forced the second end into a separate trip.
    expect(calendarOpen()).toBe(true)
    expect(lastChange()).toEqual({ from: toLocalDayValue(start), to: "" })

    await userEvent.click(await findDay(end))
    expect(lastChange()).toEqual({
      from: toLocalDayValue(start),
      to: toLocalDayValue(end),
    })
    await waitFor(() => expect(calendarOpen()).toBe(false))
  })

  it("restarts the span when a complete range is clicked into again", async () => {
    // The reported bug: with a committed range, the first click used to keep the
    // endpoint you did NOT click and drag the other one to meet it — so you
    // could only ever move one end per visit.
    // Mounting with a range already set is the state you are in on reopening
    // the pill after a previous pick.
    const lastChange = renderLive(
      toLocalDayValue(lastMonthDay(2)),
      toLocalDayValue(lastMonthDay(5))
    )

    const newStart = lastMonthDay(10)
    await userEvent.click(await findDay(newStart))
    expect(lastChange()).toEqual({ from: toLocalDayValue(newStart), to: "" })

    const newEnd = lastMonthDay(20)
    await userEvent.click(await findDay(newEnd))
    expect(lastChange()).toEqual({
      from: toLocalDayValue(newStart),
      to: toLocalDayValue(newEnd),
    })
  })
})
