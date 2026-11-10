/**
 * Planning a start crosses a timezone boundary: the picker speaks the user's
 * wall clock and the backend stores an instant. These pin the conversion (a
 * silent UTC slip would run tasks hours off), the "opens empty" rule, and the
 * clear path.
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import { formatScheduleDay, toDateTimeLocalValue } from "@/lib/task-schedule"
import type { WorkTask } from "@/lib/types"

const scheduleMock = vi.fn().mockResolvedValue(undefined)

vi.mock("@/lib/api", () => ({
  workTaskSchedule: (...args: unknown[]) => scheduleMock(...args),
}))

import { TaskScheduleDialog } from "./task-schedule-dialog"

function task(overrides?: Partial<WorkTask>): WorkTask {
  return {
    id: 7,
    folder_id: 1,
    title: "Fix login",
    config: null,
    status: "todo",
    scheduled_at: null,
    ...overrides,
  } as WorkTask
}

function renderDialog(row: WorkTask = task()) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TaskScheduleDialog open onOpenChange={() => {}} task={row} />
    </NextIntlClientProvider>
  )
}

const dateTrigger = () => screen.getByLabelText("Date")
const timeInput = () => screen.getByLabelText("Time")
const saveButton = () => screen.getByRole("button", { name: "Save" })

/**
 * Pick a day in the calendar popover.
 *
 * By `data-day` rather than by role+name: the popover is itself a `dialog`
 * (so is the surrounding one), and a day's accessible name is the spelled-out
 * "Monday, August 3rd, 2026", not its number. `CalendarDayButton` stamps
 * `data-day` with `toLocaleDateString()`, so deriving it the same way here is
 * exact in whatever locale the runner defaults to.
 */
async function pickDay(day: Date) {
  await userEvent.click(dateTrigger())
  const cell = await waitFor(() => {
    const found = document.querySelector<HTMLButtonElement>(
      `button[data-day="${day.toLocaleDateString()}"]`
    )
    if (!found) throw new Error("day cell not rendered yet")
    return found
  })
  await userEvent.click(cell)
}

beforeEach(() => {
  scheduleMock.mockClear()
  // Pin "today" to mid-month: this calendar opens on the current month, so a
  // wall-clock run on a month's last days can look for a day cell (+2) outside
  // the grid. Fake only Date so userEvent and waitFor keep using real timers.
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date(2026, 6, 15, 12, 0))
})

afterEach(() => {
  vi.useRealTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("TaskScheduleDialog", () => {
  it("opens empty for a task with no plan, and cannot be saved yet", () => {
    renderDialog()
    // The whole point of not seeding: an unplanned task must not look planned.
    expect(dateTrigger()).toHaveTextContent("Select date")
    expect(timeInput()).toHaveValue("")
    expect(saveButton()).toBeDisabled()
  })

  it("fills the hour once a day is picked, and sends it as its own instant", async () => {
    // The calendar opens on the current month and shows the next month's days
    // only up to the end of its last week. Near a month's end, two days out
    // can fall past that week: October 2026 ends on a Saturday, so on the
    // 30th the target, November 1st, has no cell. A mid-month clock keeps the
    // target in view. Only `Date` is faked, so user-event and `waitFor` keep
    // their real timers.
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date(2026, 7, 12, 15, 0))
    renderDialog()
    // Two days out, so the seeded time is the fixed 09:00 rather than a
    // wall-clock-dependent "next hour".
    const target = new Date()
    target.setDate(target.getDate() + 2)
    target.setHours(0, 0, 0, 0)

    await pickDay(target)
    expect(timeInput()).toHaveValue("09:00")

    await userEvent.clear(timeInput())
    await userEvent.type(timeInput(), "09:30")
    await userEvent.click(saveButton())

    await waitFor(() => expect(scheduleMock).toHaveBeenCalled())
    const [id, iso] = scheduleMock.mock.calls[0]
    expect(id).toBe(7)
    const expected = new Date(target)
    expected.setHours(9, 30, 0, 0)
    // Whatever the machine's zone, the instant must denote 09:30 locally.
    expect(toDateTimeLocalValue(new Date(iso as string))).toBe(
      toDateTimeLocalValue(expected)
    )
  })

  it("seeds both fields from an existing plan and can clear it", async () => {
    const planned = new Date(2026, 7, 8, 9, 30)
    renderDialog(task({ scheduled_at: planned.toISOString() }))
    expect(dateTrigger()).toHaveTextContent(
      formatScheduleDay("2026-08-08", "en")
    )
    expect(timeInput()).toHaveValue("09:30")

    await userEvent.click(
      screen.getByRole("button", { name: "Clear schedule" })
    )
    await waitFor(() => expect(scheduleMock).toHaveBeenCalledWith(7, null))
  })

  it("offers no clear button when the task has no plan", () => {
    renderDialog()
    expect(screen.queryByRole("button", { name: "Clear schedule" })).toBeNull()
  })

  it("warns instead of refusing when the time has already passed", async () => {
    renderDialog(
      task({ scheduled_at: new Date(2020, 0, 1, 9, 0).toISOString() })
    )
    expect(screen.getByText(/That time has passed/)).toBeInTheDocument()
    // Still savable: the engine simply starts it at its next sweep.
    expect(saveButton()).toBeEnabled()
  })

  it("applies a preset to both fields", async () => {
    renderDialog()
    await userEvent.click(screen.getByRole("button", { name: "Tomorrow 9:00" }))
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    tomorrow.setHours(9, 0, 0, 0)
    expect(dateTrigger()).toHaveTextContent(
      formatScheduleDay(toDateTimeLocalValue(tomorrow).slice(0, 10), "en")
    )
    expect(timeInput()).toHaveValue("09:00")
  })
})
