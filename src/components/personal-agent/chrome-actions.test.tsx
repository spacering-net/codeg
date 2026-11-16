import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

vi.mock("@/lib/api", () => ({
  personalAgentCancel: vi.fn(),
  personalAgentCompact: vi.fn(),
  personalAgentStopAll: vi.fn(),
}))
vi.mock("sonner", () => ({ toast: { message: vi.fn(), error: vi.fn() } }))
vi.mock("@/contexts/personal-agent-context", () => ({
  usePersonalAgent: () => ({
    botId: null,
    snapshot: {
      agent: { id: 1, kind: "primary", name: "Nova" },
      status: {
        engine: "here",
        turn: null,
        segment: { conversation_id: 9 },
      },
    },
  }),
}))

import { PersonalAgentChromeActions } from "./chrome-actions"

afterEach(cleanup)

describe("the top band's ⋯ menu", () => {
  it("opens the shared settings, not an assistant's own page", async () => {
    usePersonalAgentUi.setState({ settings: null, botPage: null })
    const user = userEvent.setup()
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <PersonalAgentChromeActions buttonClassName="" iconClassName="" />
      </NextIntlClientProvider>
    )
    await user.click(screen.getByRole("button", { name: "More" }))
    const items = (await screen.findAllByRole("menuitem")).map(
      (i) => i.textContent
    )
    // Its own page is on the roster's menu.
    expect(items).not.toContain("View details")
    expect(document.querySelector("[data-pa-menu-details]")).toBeNull()
    await user.click(
      screen.getByRole("menuitem", { name: /Personal agent settings/ })
    )
    expect(usePersonalAgentUi.getState().settings).toEqual({ page: "workers" })
    expect(usePersonalAgentUi.getState().botPage).toBeNull()
  })
})
