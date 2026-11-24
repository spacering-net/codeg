import { render, screen, fireEvent, cleanup } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"

// Stub the backend command with a never-resolving promise so `busy` stays true
// after the first click (models an in-flight response).
vi.mock("@/lib/api", () => ({
  acpRespondPermission: vi.fn(() => new Promise<void>(() => {})),
}))

import { acpRespondPermission } from "@/lib/api"
import { PanelPermissionCard } from "./PanelPermissionCard"
import type { AgentType } from "@/lib/types"

// The card localises the agent's own approval vocabulary, so it needs the same
// catalogue the pet panel already provides in production (its parent
// `SessionRow` is a `useTranslations` consumer too).
function renderCard(agentType?: AgentType) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PanelPermissionCard
        connectionId="c1"
        permission={permission}
        agentType={agentType}
      />
    </NextIntlClientProvider>
  )
}

const permission = {
  requestId: "r1",
  toolCall: { tool_name: "Bash", rawInput: { command: "ls -la" } },
  options: [
    { option_id: "allow", name: "Allow", kind: "allow_once" },
    { option_id: "reject", name: "Reject", kind: "reject_once" },
  ],
}

describe("PanelPermissionCard", () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => cleanup())

  it("forwards a single response with the right ids", () => {
    renderCard()
    fireEvent.click(screen.getByRole("button", { name: "Allow" }))
    expect(acpRespondPermission).toHaveBeenCalledTimes(1)
    expect(acpRespondPermission).toHaveBeenCalledWith("c1", "r1", "allow")
  })

  // `deepseek-acp` hardcodes its approval buttons in Simplified Chinese, so the
  // pet panel re-labels them from the option ids just like the chat dialog.
  it("localises an agent's hardcoded approval labels", () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <PanelPermissionCard
          connectionId="c1"
          permission={{
            ...permission,
            options: [
              { option_id: "allow-once", name: "允许本次", kind: "allow_once" },
              { option_id: "reject-once", name: "拒绝", kind: "reject_once" },
            ],
          }}
          agentType="deepseek"
        />
      </NextIntlClientProvider>
    )
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }))
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument()
    expect(acpRespondPermission).toHaveBeenCalledWith("c1", "r1", "allow-once")
  })

  it("ignores rapid double-clicks while a response is in flight", () => {
    renderCard()
    const allow = screen.getByRole("button", { name: "Allow" })
    fireEvent.click(allow)
    fireEvent.click(allow)
    fireEvent.click(allow)
    expect(acpRespondPermission).toHaveBeenCalledTimes(1)
  })
})
