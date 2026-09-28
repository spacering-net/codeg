import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { useEffect, useState } from "react"
import { describe, expect, it, vi } from "vitest"

import { SessionFailureBanner } from "./session-failure-banner"
import enMessages from "@/i18n/messages/en.json"
import {
  dismissSessionFailures,
  upsertSessionFailure,
} from "@/lib/session-failures"
import type { SessionFailureRecord } from "@/lib/types"

function record(
  overrides: Partial<SessionFailureRecord> = {}
): SessionFailureRecord {
  return {
    id: "t1:error",
    revision: 1,
    category: "connection",
    severity: "warning",
    title: "Reconnecting... 1/5",
    actions: [],
    resolved: false,
    ...overrides,
  }
}

function renderBanner(
  failures: SessionFailureRecord[],
  onDismiss?: (ids: string[]) => void,
  hideRetryIncidents = false
) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SessionFailureBanner
        failures={failures}
        onDismiss={onDismiss}
        hideRetryIncidents={hideRetryIncidents}
      />
    </NextIntlClientProvider>
  )
}

describe("SessionFailureBanner", () => {
  it("draws an in-flight retry incident as progress", () => {
    renderBanner([record({ actions: ["retry", "new_session"] })])
    const strip = screen.getByRole("status")
    expect(strip).toHaveTextContent("Reconnecting... 1/5")
    expect(strip.className).toContain("bg-amber-500/10")
    // The adapter is recovering on its own — nothing for the user to press.
    expect(screen.queryByText("Retry")).not.toBeInTheDocument()
    expect(screen.queryByText("New session")).not.toBeInTheDocument()
  })

  it("never draws news — a failed turn or an advisory is a notification", () => {
    const { container } = renderBanner([
      record({
        id: "e1",
        severity: "error",
        category: "access",
        title: "Authentication required.",
        actions: ["login"],
      }),
      record({
        id: "adv",
        category: "unknown",
        title: "Model fallback",
      }),
    ])
    expect(container).toBeEmptyDOMElement()
  })

  it("falls back to the category label for a blank title and expands details", () => {
    renderBanner([
      record({
        category: "limit",
        title: "  ",
        details: "usage resets at 3pm",
      }),
    ])
    expect(screen.getByText("Limit reached")).toBeInTheDocument()
    expect(screen.queryByText("usage resets at 3pm")).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText("Toggle details"))
    expect(screen.getByText("usage resets at 3pm")).toBeInTheDocument()
  })

  it("maps an unknown category onto the generic label", () => {
    renderBanner([record({ category: "quantum", title: "" })])
    expect(screen.getByText("Session issue")).toBeInTheDocument()
  })

  it("collapses stacked incidents to the latest one plus a count (#496)", () => {
    renderBanner([
      record({ id: "i1" }),
      record({ id: "i2" }),
      record({ id: "i3", title: "Reconnecting... 3/5" }),
    ])
    // One strip, not three — the older incidents become a count.
    expect(screen.getAllByRole("status")).toHaveLength(1)
    expect(screen.getByText("Reconnecting... 3/5")).toBeInTheDocument()
    expect(screen.getByText("+2 more")).toBeInTheDocument()
  })

  it("closes every incident the collapsed strip stands for, opt-in via onDismiss", () => {
    const onDismiss = vi.fn()
    renderBanner(
      [record({ id: "i1" }), record({ id: "i2" }), record({ id: "i3" })],
      onDismiss
    )
    fireEvent.click(screen.getByLabelText("Dismiss"))
    expect(onDismiss).toHaveBeenCalledWith(["i1", "i2", "i3"])
  })

  it("omits the close button when no handler is wired", () => {
    renderBanner([record()])
    expect(screen.queryByLabelText("Dismiss")).not.toBeInTheDocument()
  })

  it("keeps the incidents out of sight when the host asks", () => {
    // The host shows the same retry on its richer line — or no turn is
    // running, and nothing can be retrying.
    const { container } = renderBanner([record()], undefined, true)
    expect(container).toBeEmptyDOMElement()
  })

  it("claims no recovery while a hidden incident is still in flight", () => {
    const { container } = renderBanner(
      [record({ id: "old", resolved: true }), record({ id: "live" })],
      undefined,
      true
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("shows only the most recent recovered incident", () => {
    const resolved = (id: string, title: string) =>
      record({ id, title, resolved: true })
    renderBanner([
      resolved("w1", "first retry incident"),
      resolved("w2", "second retry incident"),
      // Resolved ERRORS are watermarks only — never rendered.
      record({
        id: "e1",
        severity: "error",
        resolved: true,
        title: "old auth error",
      }),
    ])
    expect(
      screen.getByText(/Recovered · second retry incident/)
    ).toBeInTheDocument()
    expect(screen.queryByText(/first retry incident/)).not.toBeInTheDocument()
    expect(screen.queryByText(/old auth error/)).not.toBeInTheDocument()
  })

  it("claims no recovery after a turn that failed after all", () => {
    const { container } = renderBanner([
      record({ id: "w1", resolved: true }),
      record({ id: "e2", severity: "error", title: "still failing" }),
    ])
    expect(container).toBeEmptyDOMElement()
  })

  it("still confirms a recovery beside an unrelated advisory", () => {
    renderBanner([
      record({ id: "w1", title: "Reconnecting... 2/5", resolved: true }),
      record({ id: "adv", category: "unknown", title: "Model fallback" }),
    ])
    expect(
      screen.getByText(/Recovered · Reconnecting... 2\/5/)
    ).toBeInTheDocument()
  })

  it("never announces an advisory the turn end swept as recovered", () => {
    const { container } = renderBanner([
      record({
        id: "adv",
        category: "unknown",
        title: "Model fallback",
        resolved: true,
      }),
    ])
    expect(container).toBeEmptyDOMElement()
  })

  it("shows nothing at all after a dismissal — never a 'Recovered' line", () => {
    // Regression: dismissal used to be plain `resolved`, so closing the only
    // active warning swapped the strip for "Recovered · …" — a second bar, and
    // a false claim whenever the connection was still down.
    const { container } = renderBanner([
      record({
        id: "w1",
        severity: "warning",
        title: "Reconnecting... 1/5",
        resolved: true,
        dismissed: true,
      }),
    ])
    expect(container).toBeEmptyDOMElement()
  })

  it("still shows a genuine recovery alongside an unrelated dismissal", () => {
    renderBanner([
      record({
        id: "w1",
        severity: "warning",
        title: "recovered incident",
        resolved: true,
      }),
      record({
        id: "w2",
        severity: "warning",
        title: "silenced incident",
        resolved: true,
        dismissed: true,
      }),
    ])
    expect(
      screen.getByText(/Recovered · recovered incident/)
    ).toBeInTheDocument()
    expect(screen.queryByText(/silenced incident/)).not.toBeInTheDocument()
  })

  describe("the recovered line is transient", () => {
    const recoveredWarning = () =>
      record({
        id: "w1",
        title: "Reconnecting... 4/5",
        resolved: true,
      })

    it("self-dismisses instead of hanging under the composer forever", () => {
      // Field report 2026-08-17: the network came back, the incident settled,
      // and "Recovered · Reconnecting... 4/5" then sat there for the rest of
      // the session — records are kept as revision watermarks, so nothing
      // else ever took it down.
      vi.useFakeTimers()
      try {
        const onDismiss = vi.fn()
        renderBanner([recoveredWarning()], onDismiss)
        expect(screen.getByText(/Recovered/)).toBeInTheDocument()
        expect(onDismiss).not.toHaveBeenCalled()
        act(() => {
          vi.advanceTimersByTime(10_000)
        })
        // It writes the dismissal back to the store, so a remount can't
        // resurrect it.
        expect(onDismiss).toHaveBeenCalledWith(["w1"])
      } finally {
        vi.useRealTimers()
      }
    })

    it("can also be closed by hand, before the timer", () => {
      const onDismiss = vi.fn()
      renderBanner([recoveredWarning()], onDismiss)
      fireEvent.click(screen.getByLabelText("Dismiss"))
      expect(onDismiss).toHaveBeenCalledWith(["w1"])
    })

    // The tests above stub `onDismiss`, which proves only that the strip ASKS
    // to be removed. These drive the REAL `dismissSessionFailures` transition
    // and re-render, which is where the first attempt silently failed: the
    // helper used to ignore already-resolved records, so the recovered line
    // requested its own removal every time and never got it.
    function renderWired(initial: SessionFailureRecord[]) {
      const state = { current: initial }
      const capture = (next: SessionFailureRecord[]) => {
        state.current = next
      }
      function Harness() {
        const [failures, setFailures] = useState(initial)
        useEffect(() => capture(failures), [failures])
        return (
          <NextIntlClientProvider locale="en" messages={enMessages}>
            <SessionFailureBanner
              failures={failures}
              onDismiss={(ids) =>
                setFailures((prev) => dismissSessionFailures(prev, ids))
              }
            />
          </NextIntlClientProvider>
        )
      }
      return { ...render(<Harness />), state }
    }

    it("actually disappears once the real store transition runs", () => {
      vi.useFakeTimers()
      try {
        const { container, state, unmount } = renderWired([recoveredWarning()])
        expect(screen.getByText(/Recovered/)).toBeInTheDocument()
        act(() => {
          vi.advanceTimersByTime(10_000)
        })
        expect(container).toBeEmptyDOMElement()
        expect(state.current[0]).toMatchObject({
          resolved: true,
          dismissed: true,
        })

        // Remount on the post-dismissal table: it must stay gone, and must not
        // schedule another expiry.
        const settled = state.current
        unmount()
        const remounted = renderWired(settled)
        expect(remounted.container).toBeEmptyDOMElement()

        // A genuine recurrence at a higher revision still re-arms the strip.
        const recurred = upsertSessionFailure(settled, {
          ...recoveredWarning(),
          revision: 2,
          resolved: false,
        })
        remounted.unmount()
        renderWired(recurred)
        expect(screen.getByRole("status")).toBeInTheDocument()
        expect(screen.getByText("Reconnecting... 4/5")).toBeInTheDocument()
      } finally {
        vi.useRealTimers()
      }
    })

    it("disappears on a manual close through the real store too", () => {
      const { container } = renderWired([recoveredWarning()])
      fireEvent.click(screen.getByLabelText("Dismiss"))
      expect(container).toBeEmptyDOMElement()
    })

    it("renders without a handler and never schedules a stray dismissal", () => {
      vi.useFakeTimers()
      try {
        renderBanner([recoveredWarning()])
        expect(screen.getByText(/Recovered/)).toBeInTheDocument()
        expect(screen.queryByLabelText("Dismiss")).not.toBeInTheDocument()
        act(() => {
          vi.advanceTimersByTime(10_000)
        })
        expect(screen.getByText(/Recovered/)).toBeInTheDocument()
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
