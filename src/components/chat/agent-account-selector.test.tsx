import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"
import messages from "@/i18n/messages/en.json"
import { AgentAccountSelector } from "./agent-account-selector"

const accounts = [
  {
    id: "a",
    agentType: "codex" as const,
    name: "Personal",
    homeDir: "/a",
    removed: false,
  },
  {
    id: "b",
    agentType: "codex" as const,
    name: "Team",
    homeDir: "/b",
    removed: true,
  },
]

describe("account picker", () => {
  it("keeps the account selected while Remote Control is active", () => {
    const view = render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <AgentAccountSelector
          accounts={accounts}
          value="a"
          onChange={vi.fn()}
          persisted
          canSwitch
          remoteControlActive
        />
      </NextIntlClientProvider>
    )
    const picker = screen.getByRole("combobox", { name: "Switch account" })
    expect(picker).toBeDisabled()
    expect(picker).toHaveTextContent("Personal")
    expect(picker).toHaveAttribute(
      "title",
      messages.AgentAccounts.remoteControlHint
    )
    view.rerender(
      <NextIntlClientProvider locale="en" messages={messages}>
        <AgentAccountSelector
          accounts={accounts}
          value="a"
          onChange={vi.fn()}
          persisted
          canSwitch
        />
      </NextIntlClientProvider>
    )
    expect(picker).toBeEnabled()
  })

  it("switches a persisted Default conversation without creating a new chat", async () => {
    const changed = vi.fn()
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <AgentAccountSelector
          accounts={accounts}
          value={null}
          onChange={changed}
          persisted
          canSwitch
        />
      </NextIntlClientProvider>
    )
    fireEvent.click(screen.getByRole("combobox", { name: "Switch account" }))
    fireEvent.click(await screen.findByRole("option", { name: "Personal" }))
    expect(changed).toHaveBeenCalledWith("a")
  })

  it("keeps the current selection and disables repeat clicks while switching", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <AgentAccountSelector
          accounts={accounts}
          value="a"
          onChange={vi.fn()}
          persisted
          canSwitch
          switching
        />
      </NextIntlClientProvider>
    )
    const picker = screen.getByRole("combobox", { name: "Switch account" })
    expect(picker).toBeDisabled()
    expect(picker).toHaveAttribute("aria-busy", "true")
    expect(picker).toHaveTextContent("Switching account")
  })
  it("keeps a removed persisted account visible without offering a switch", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <AgentAccountSelector
          accounts={accounts}
          value="b"
          onChange={vi.fn()}
          persisted
        />
      </NextIntlClientProvider>
    )
    expect(screen.getByText("Team (Unavailable account)")).toBeVisible()
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument()
  })

  it("lets a draft select a live account or Default, excluding removed accounts", async () => {
    const changed = vi.fn()
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <AgentAccountSelector
          accounts={accounts}
          value={null}
          onChange={changed}
        />
      </NextIntlClientProvider>
    )
    fireEvent.click(screen.getByRole("combobox", { name: "Account" }))
    fireEvent.click(await screen.findByRole("option", { name: "Personal" }))
    expect(changed).toHaveBeenCalledWith("a")
    expect(
      screen.queryByRole("option", { name: "Team" })
    ).not.toBeInTheDocument()
  })
})
