import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { usePersonalAgentRoster } from "@/stores/personal-agent-roster-store"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

const api = vi.hoisted(() => ({
  personalAgentCancel: vi.fn(),
  personalAgentCompact: vi.fn(),
  personalAgentStopAll: vi.fn(),
  personalAgentSave: vi.fn(),
}))
vi.mock("@/lib/api", () => api)
vi.mock("sonner", () => ({ toast: { message: vi.fn(), error: vi.fn() } }))
const ctx = vi.hoisted(() => ({
  turn: null as null | { kind: string },
}))
vi.mock("@/contexts/personal-agent-context", () => ({
  usePersonalAgent: () => ({
    botId: 7,
    snapshot: {
      agent: { id: 7, kind: "worker", name: "Nova" },
      status: {
        engine: "here",
        turn: ctx.turn,
        segment: { conversation_id: 9 },
      },
    },
  }),
}))

import { AgentMenu } from "./agent-menu"
import { PersonalAgentChromeActions } from "./chrome-actions"

function wrap(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  ctx.turn = null
  usePersonalAgentUi.setState({ settings: null, botPage: null, auxOpen: true })
  usePersonalAgentRoster.setState({ entries: null })
})
afterEach(cleanup)

describe("the top band's buttons", () => {
  it("are the shared settings, then the panel's toggle — no ⋯ menu", async () => {
    const user = userEvent.setup()
    wrap(<PersonalAgentChromeActions buttonClassName="" iconClassName="" />)
    const buttons = screen.getAllByRole("button")
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Personal agent settings",
      "Hide the side panel",
    ])
    expect(screen.queryByRole("button", { name: "More" })).toBeNull()

    const settings = screen.getByRole("button", {
      name: "Personal agent settings",
    })
    await user.click(settings)
    expect(usePersonalAgentUi.getState().settings).toEqual({
      page: "communication",
    })
    expect(usePersonalAgentUi.getState().botPage).toBeNull()
    // Pressed while open, the panel standing aside; pressed again, back to
    // the conversation.
    expect(settings.getAttribute("aria-pressed")).toBe("true")
    expect(
      screen.queryByRole("button", { name: "Hide the side panel" })
    ).toBeNull()
    await user.click(settings)
    expect(usePersonalAgentUi.getState().settings).toBeNull()
  })
})

describe("the ⋯ by the face on the panel", () => {
  it("acts on the assistant itself", async () => {
    const user = userEvent.setup()
    const opened = vi.fn()
    window.addEventListener("codeg:open-personal-agent-session", opened)
    try {
      wrap(<AgentMenu />)
      await user.click(screen.getByRole("button", { name: "More" }))
      const items = (await screen.findAllByRole("menuitem")).map(
        (i) => i.textContent
      )
      expect(items).toEqual([
        "View details",
        "View the session underneath",
        "Compact the context",
        "Start a new session…",
        "Stop everything",
      ])
      await user.click(screen.getByRole("menuitem", { name: /Compact/ }))
      expect(api.personalAgentCompact).toHaveBeenCalledWith(7)

      await user.click(screen.getByRole("button", { name: "More" }))
      await user.click(
        await screen.findByRole("menuitem", { name: /View the session/ })
      )
      expect(opened).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener("codeg:open-personal-agent-session", opened)
    }
  })

  it("opens its page, as a row's menu on the roster does — its name and face are edited on the panel's head, not here", async () => {
    usePersonalAgentUi.setState({ viewBot: 7 })
    const user = userEvent.setup()
    wrap(<AgentMenu />)
    await user.click(screen.getByRole("button", { name: "More" }))
    expect(screen.queryByRole("menuitem", { name: /Edit basic info/ })).toBe(
      null
    )
    await user.click(
      await screen.findByRole("menuitem", { name: "View details" })
    )
    expect(usePersonalAgentUi.getState().botPage).toEqual({ tab: "identity" })
    expect(usePersonalAgentUi.getState().viewBot).toBe(7)
  })

  it("stops the reply while a turn runs, in place of compacting", async () => {
    ctx.turn = { kind: "reply" }
    const user = userEvent.setup()
    wrap(<AgentMenu />)
    await user.click(screen.getByRole("button", { name: "More" }))
    await user.click(
      await screen.findByRole("menuitem", { name: "Stop the reply" })
    )
    expect(api.personalAgentCancel).toHaveBeenCalledWith(7)
    expect(screen.queryByRole("menuitem", { name: /Compact/ })).toBeNull()
  })
})
