import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { StatusBadge } from "./delegation-status-badge"

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

  it("comes in a smaller size for the side panel's cards", () => {
    const { unmount } = renderBadge({ status: "running" })
    expect(screen.getByText("running")).toHaveClass("text-xs")
    unmount()
    renderBadge({ status: "running", size: "sm" })
    const small = screen.getByText("running")
    expect(small).toHaveClass("text-2xs")
    expect(small).not.toHaveClass("text-xs")
  })
})
