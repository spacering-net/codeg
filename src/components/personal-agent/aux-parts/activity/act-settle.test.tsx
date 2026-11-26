import { act, cleanup, render } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"

const refresh = vi.hoisted(() => vi.fn())
vi.mock("@/stores/personal-agent-activity-store", () => ({
  refreshActivity: refresh,
}))

import {
  ACT_SETTLE_MS,
  atLeast,
  useActSettle,
  waitForSettle,
} from "./act-settle"

function Row({ k, now }: { k: string; now: string }) {
  const s = useActSettle(k, now)
  return <span data-waiting={s.waiting ? "yes" : "no"} />
}

function draw(k: string, now: string) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <Row k={k} now={now} />
    </NextIntlClientProvider>
  )
}

const waiting = (c: HTMLElement) =>
  c.querySelector("[data-waiting]")?.getAttribute("data-waiting")

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  refresh.mockReset()
})

describe("a row's act settling", () => {
  it("compares versions to the nanosecond, whatever digits they carry", () => {
    expect(
      atLeast("2026-11-26T03:04:05.1Z", "2026-11-26T03:04:05.099999999Z")
    ).toBe(true)
    expect(
      atLeast("2026-11-26T03:04:05Z", "2026-11-26T03:04:05.000000001Z")
    ).toBe(false)
    expect(
      atLeast("2026-11-26T03:04:05.123456Z", "2026-11-26T03:04:05.123456Z")
    ).toBe(true)
  })

  it("waits by the row's key, drawn again or not, until the row shows it", () => {
    const old = "2026-11-26T03:04:05Z"
    const first = draw("item:1", old)
    act(() => waitForSettle("item:1", { atLeast: "2026-11-26T03:04:06Z" }, "x"))
    expect(waiting(first.container)).toBe("yes")
    // The panel closed and opened: the same stale row, still waiting.
    first.unmount()
    const again = draw("item:1", old)
    expect(waiting(again.container)).toBe("yes")
    again.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <Row k="item:1" now="2026-11-26T03:04:06.5Z" />
      </NextIntlClientProvider>
    )
    expect(waiting(again.container)).toBe("no")
  })

  it("gives up after a while: reads the activity again and lets go", () => {
    vi.useFakeTimers()
    const { container } = draw("item:2", "2026-11-26T03:04:05Z")
    act(() => waitForSettle("item:2", { differs: "2026-11-26T03:04:05Z" }, "x"))
    expect(waiting(container)).toBe("yes")
    act(() => {
      vi.advanceTimersByTime(ACT_SETTLE_MS)
    })
    expect(refresh).toHaveBeenCalled()
    expect(waiting(container)).toBe("no")
  })

  it("stops waiting quietly for a row no longer drawn (it left its group)", () => {
    vi.useFakeTimers()
    const { unmount } = draw("item:3", "2026-11-26T03:04:05Z")
    act(() => waitForSettle("item:3", { atLeast: "2026-11-26T03:04:06Z" }, "x"))
    unmount()
    act(() => {
      vi.advanceTimersByTime(ACT_SETTLE_MS)
    })
    expect(refresh).not.toHaveBeenCalled()
  })
})
