import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it } from "vitest"

import {
  ComposerStatusStrips,
  type ComposerStatusStripsProps,
} from "./composer-status-strips"
import enMessages from "@/i18n/messages/en.json"
import type { ClaudeApiRetryState } from "@/contexts/acp-connections-context"
import type { SessionFailureRecord } from "@/lib/types"

function renderStrips(props: Partial<ComposerStatusStripsProps>) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ComposerStatusStrips
        status="prompting"
        claudeApiRetry={null}
        {...props}
      />
    </NextIntlClientProvider>
  )
}

function failure(
  overrides: Partial<SessionFailureRecord> = {}
): SessionFailureRecord {
  return {
    id: "f1",
    revision: 1,
    category: "access",
    severity: "error",
    title: "Authentication required.",
    actions: ["login"],
    resolved: false,
    ...overrides,
  }
}

function retry(
  overrides: Partial<ClaudeApiRetryState> = {}
): ClaudeApiRetryState {
  return {
    sessionId: "s1",
    attempt: 2,
    maxRetries: 10,
    error: "overloaded_error",
    errorStatus: 529,
    retryDelayMs: 4000,
    reportsError: true,
    ...overrides,
  }
}

const RETRY_LINE = "overloaded_error (HTTP 529) · retrying 2/10, next in 4.0s"

describe("ComposerStatusStrips", () => {
  it("renders nothing when the session has nothing to say", () => {
    const { container } = renderStrips({})
    expect(container).toBeEmptyDOMElement()
  })

  it("never draws news — a failed turn or an advisory is a notification", () => {
    const { container } = renderStrips({
      sessionFailures: [
        failure(),
        failure({
          id: "adv",
          severity: "warning",
          category: "unknown",
          title: "Model fallback",
          actions: [],
        }),
      ],
    })
    expect(container).toBeEmptyDOMElement()
  })

  describe("retry line", () => {
    it("reads as progress, not failure", () => {
      renderStrips({ claudeApiRetry: retry() })
      const line = screen.getByRole("status")
      expect(line).toHaveTextContent(RETRY_LINE)
      expect(line.className).toContain("bg-amber-500/10")
      expect(line.className).not.toContain("destructive")
    })

    it("wins over the typed retry incident claude publishes for the same retry", () => {
      // The line says why (cause + HTTP status) and when (delay); the incident
      // only says "attempt 2 of 10". One retry, one strip — the richer one.
      renderStrips({
        claudeApiRetry: retry(),
        sessionFailures: [
          failure({
            severity: "warning",
            category: "service",
            title: "Retrying Claude, attempt 2 of 10.",
            actions: [],
          }),
        ],
      })
      expect(screen.getAllByRole("status")).toHaveLength(1)
      expect(screen.getByRole("status")).toHaveTextContent(RETRY_LINE)
      expect(
        screen.queryByText("Retrying Claude, attempt 2 of 10.")
      ).not.toBeInTheDocument()
    })

    it("hands the dock back to the incident once the line is gone", () => {
      // claude's line clears on ERROR / the next prompt while its incident can
      // stay active a little longer — the incident must come back, not vanish.
      const sessionFailures = [
        failure({
          severity: "warning",
          category: "connection",
          title: "Reconnecting... 1/5",
          actions: [],
        }),
      ]
      const { rerender } = renderStrips({
        claudeApiRetry: retry(),
        sessionFailures,
      })
      expect(screen.getByRole("status")).toHaveTextContent(RETRY_LINE)

      rerender(
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <ComposerStatusStrips
            status="prompting"
            claudeApiRetry={null}
            sessionFailures={sessionFailures}
          />
        </NextIntlClientProvider>
      )
      expect(screen.getByRole("status")).toHaveTextContent(
        "Reconnecting... 1/5"
      )
    })

    it("lets an incident go once the turn is over — nothing is retrying then", () => {
      // A turn that failed instead of recovering leaves its incident active
      // until the next prompt; spinning over the finished turn would be false.
      const { container } = renderStrips({
        status: "connected",
        sessionFailures: [
          failure({
            severity: "warning",
            category: "connection",
            title: "Reconnecting... 5/5",
            actions: [],
          }),
        ],
      })
      expect(container).toBeEmptyDOMElement()
    })

    it("builds its text from the counters alone when the source reports no cause", () => {
      // pi (#525): counters only — no dangling "· retrying" separator.
      renderStrips({
        claudeApiRetry: retry({
          error: null,
          errorStatus: null,
          retryDelayMs: null,
          reportsError: false,
          attempt: 2,
          maxRetries: 5,
        }),
      })
      expect(screen.getByRole("status")).toHaveTextContent(/^retrying 2\/5$/)
    })
  })
})
