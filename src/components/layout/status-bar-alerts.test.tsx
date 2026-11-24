import { render, screen, fireEvent } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"
import type { Alert } from "@/contexts/alert-context"

// Drive the list straight off the context value; the store's own behaviour
// (push / dismiss / cap) is covered by the provider.
let alerts: Alert[] = []
vi.mock("@/contexts/alert-context", () => ({
  useAlertContext: () => ({
    alerts,
    hasAlerts: alerts.length > 0,
    pushAlert: vi.fn(),
    dismissAlert: vi.fn(),
    clearAll: vi.fn(),
  }),
}))

vi.mock("@/contexts/acp-connections-context", () => ({
  useAcpActions: () => ({ connect: vi.fn() }),
}))

vi.mock("@/lib/platform", () => ({ openUrl: vi.fn() }))
vi.mock("@/lib/api", () => ({ openSettingsWindow: vi.fn() }))

import { StatusBarAlerts } from "./status-bar-alerts"
import enMessages from "@/i18n/messages/en.json"

const EVIDENCE =
  "dropped 1 unreadable update(s)\n" +
  "stderr (this turn, last 1 lines):\n  Error: 401 Unauthorized"

function makeAlert(overrides: Partial<Alert>): Alert {
  return {
    id: "a1",
    level: "error",
    message: "Agent error",
    detail: "claude ended the turn without producing any response.",
    timestamp: 0,
    ...overrides,
  }
}

function openAlerts(list: Alert[]) {
  alerts = list
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <StatusBarAlerts />
    </NextIntlClientProvider>
  )
  // The trigger is the only button before the popover opens.
  fireEvent.click(screen.getByRole("button"))
}

describe("StatusBarAlerts — evidence disclosure", () => {
  it("offers a collapsed expander for an alert carrying evidence", async () => {
    openAlerts([makeAlert({ evidence: EVIDENCE })])

    const toggle = await screen.findByRole("button", { name: "Details" })
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    // Evidence is agent output — never dumped inline into the alert list.
    expect(screen.queryByText(/401 Unauthorized/)).toBeNull()
  })

  it("reveals and re-hides the evidence on toggle", async () => {
    openAlerts([makeAlert({ evidence: EVIDENCE })])

    const toggle = await screen.findByRole("button", { name: "Details" })
    fireEvent.click(toggle)
    expect(screen.getByText(/401 Unauthorized/)).toBeVisible()
    expect(toggle).toHaveAttribute("aria-expanded", "true")

    fireEvent.click(toggle)
    expect(screen.queryByText(/401 Unauthorized/)).toBeNull()
    expect(toggle).toHaveAttribute("aria-expanded", "false")
  })

  it("shows no expander when the alert carries no evidence", async () => {
    openAlerts([makeAlert({})])

    // The alert still renders; only the expander is absent, so the copy that
    // points at it is never shown for an alert with nothing behind it.
    expect(
      await screen.findByText(
        "claude ended the turn without producing any response."
      )
    ).toBeVisible()
    expect(screen.queryByRole("button", { name: "Details" })).toBeNull()
  })
})

describe("StatusBarAlerts — the notification record", () => {
  it("lists the newest first", async () => {
    openAlerts([
      makeAlert({ id: "a1", message: "older", detail: undefined }),
      makeAlert({ id: "a2", message: "newer", detail: undefined }),
    ])
    const newer = await screen.findByText("newer")
    const older = screen.getByText("older")
    expect(
      newer.compareDocumentPosition(older) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it("runs a callback action a notification carried", async () => {
    const run = vi.fn()
    openAlerts([
      makeAlert({
        message: "Claude Code: Authentication required.",
        actions: [{ label: "Sign in", run }],
      }),
    ])
    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }))
    expect(run).toHaveBeenCalledTimes(1)
  })
})
