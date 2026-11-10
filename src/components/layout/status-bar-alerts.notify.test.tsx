import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

// The whole path a session's notification takes to the status bar, with the
// real pieces: `notify()` → `recordAlert` → the mounted `AlertProvider` → the
// list. Only the toast itself and the list's unrelated action plumbing are
// stubbed.
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), warning: vi.fn(), info: vi.fn(), dismiss: vi.fn() },
}))
vi.mock("@/contexts/acp-connections-context", () => ({
  useAcpActions: () => ({ connect: vi.fn() }),
}))
vi.mock("@/lib/platform", () => ({ openUrl: vi.fn() }))
vi.mock("@/lib/api", () => ({ openSettingsWindow: vi.fn() }))

import { StatusBarAlerts } from "./status-bar-alerts"
import { AlertProvider } from "@/contexts/alert-context"
import enMessages from "@/i18n/messages/en.json"
import { notify } from "@/lib/notify"

function mountStatusBar() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <AlertProvider>
        <StatusBarAlerts />
      </AlertProvider>
    </NextIntlClientProvider>
  )
}

function openList() {
  fireEvent.click(screen.getByRole("button", { name: "Alerts" }))
}

describe("a notification reaches the status-bar alert list", () => {
  it("lists every warning and error it was told, newest first — not an info", () => {
    mountStatusBar()
    const signIn = vi.fn()
    act(() => {
      notify({
        level: "warning",
        key: "acp-notice:c1:warning:Fast mode turned off",
        title: "Claude Code: Fast mode turned off",
      })
      notify({
        level: "error",
        key: "acp-turn-failure:c1:1",
        title: "Claude Code: Authentication required.",
        evidence: "stderr (this turn, last 1 lines):\n  401",
        actions: [
          { label: "Sign in", onClick: signIn },
          { label: "Retry", onClick: vi.fn(), toastOnly: true },
        ],
      })
      notify({ level: "info", key: "k-info", title: "Model rerouted" })
    })

    // The badge counts what was recorded.
    expect(screen.getByRole("button", { name: "Alerts" })).toHaveTextContent(
      "2"
    )
    openList()
    const error = screen.getByText("Claude Code: Authentication required.")
    const warning = screen.getByText("Claude Code: Fast mode turned off")
    expect(
      error.compareDocumentPosition(warning) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(screen.queryByText("Model rerouted")).not.toBeInTheDocument()

    // The evidence waits behind its disclosure; the lasting button works; the
    // toast-only one never reached the list.
    expect(screen.queryByText(/401/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Details" }))
    expect(screen.getByText(/401/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }))
    expect(signIn).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull()
  })

  it("keeps one entry per message: telling it again replaces it", () => {
    mountStatusBar()
    act(() => {
      notify({
        level: "error",
        key: "acp-error:c1:process_exited",
        title: "Codex exited unexpectedly.",
      })
      notify({
        level: "error",
        key: "acp-error:c1:process_exited",
        title: "Codex exited unexpectedly (again).",
      })
    })
    openList()
    expect(
      screen.queryByText("Codex exited unexpectedly.")
    ).not.toBeInTheDocument()
    expect(
      screen.getByText("Codex exited unexpectedly (again).")
    ).toBeInTheDocument()
  })
})
