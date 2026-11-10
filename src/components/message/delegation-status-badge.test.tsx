import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import {
  DelegationStatusWord,
  delegationStepStatus,
  StatusBadge,
} from "./delegation-status-badge"

function renderBadge(props: Parameters<typeof StatusBadge>[0]) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <StatusBadge {...props} />
    </NextIntlClientProvider>
  )
}

describe("StatusBadge", () => {
  it("words the status beside its icon", () => {
    renderBadge({ status: "ok" })
    const badge = screen.getByText("done")
    expect(badge.querySelector("svg")).not.toBeNull()
    expect(badge).not.toHaveAttribute("title")
  })

  it("words a failure by its code, which it keeps in its tooltip", () => {
    renderBadge({ status: "err", errorCode: "timeout" })
    expect(screen.getByText("timeout")).toHaveAttribute("title", "timeout")
  })
})

describe("DelegationStatusWord", () => {
  function renderWord(props: Parameters<typeof DelegationStatusWord>[0]) {
    return render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <p data-testid="word">
          <DelegationStatusWord {...props} />
        </p>
      </NextIntlClientProvider>
    )
  }

  it("says a finished one quietly, with how long it took", () => {
    renderWord({ status: "ok", durationMs: 94_000 })
    expect(screen.getByTestId("word")).toHaveTextContent("done · 1m 34s")
    expect(screen.getByTestId("word").querySelector("span")).toBeNull()
  })

  it("words a failure by its code, in the failure colour", () => {
    renderWord({ status: "err", errorCode: "timeout" })
    expect(screen.getByText("timeout")).toHaveClass("text-tone-danger")
  })

  it("says one waiting on the user in amber", () => {
    renderWord({ status: "waiting" })
    expect(screen.getByText("awaiting approval")).toHaveClass(
      "text-tone-warning"
    )
  })

  it("follows a running one with its clock, or with nothing", () => {
    const { unmount } = renderWord({ status: "running", clock: "1:05" })
    expect(screen.getByTestId("word")).toHaveTextContent("running 1:05")
    unmount()
    renderWord({ status: "running" })
    expect(screen.getByTestId("word")).toHaveTextContent(/^running$/)
  })
})

describe("delegationStepStatus", () => {
  it("reads a delegation's status as its ring shows a step's", () => {
    expect(delegationStepStatus("starting")).toBe("running")
    expect(delegationStepStatus("running")).toBe("running")
    expect(delegationStepStatus("waiting")).toBe("awaiting")
    expect(delegationStepStatus("ok")).toBe("succeeded")
    expect(delegationStepStatus("err")).toBe("failed")
  })
})
