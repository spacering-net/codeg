import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { PersonalAgentSnapshot, RosterEntry } from "@/lib/types"
import {
  __resetRosterForTests,
  usePersonalAgentRoster,
} from "@/stores/personal-agent-roster-store"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

const api = vi.hoisted(() => ({
  personalAgentSettingsPatch: vi.fn(async () => []),
  personalAgentBots: vi.fn(async () => [] as unknown[]),
  personalAgentRosterAct: vi.fn(async () => {}),
  personalAgentTemplates: vi.fn(async () => [
    { id: "review", name: "Reviewer role" },
  ]),
  personalAgentSetWorkdir: vi.fn(),
  personalAgentSave: vi.fn(),
}))
vi.mock("@/lib/api", () => api)
vi.mock("@/lib/platform", () => ({
  subscribe: () => Promise.resolve(() => {}),
  onTransportReconnect: () => () => {},
}))
vi.mock("sonner", () => ({ toast: { error: vi.fn(), message: vi.fn() } }))
// The identity and persona tabs' editors are tested where they live.
const identity = vi.hoisted(() => ({
  props: null as Record<string, unknown> | null,
}))
vi.mock("./identity-page", () => ({
  IdentityPage: (props: Record<string, unknown>) => {
    identity.props = props
    return <div data-testid="identity-page" />
  },
}))
vi.mock("../persona-files", () => ({
  PersonaFiles: (props: { botId: number | null; initial: string | null }) => (
    <div data-testid="persona-files" data-initial={props.initial ?? ""} />
  ),
}))

const ctx = vi.hoisted(() => ({
  snapshot: null as unknown,
  botId: null as number | null,
  switching: false,
}))
vi.mock("@/contexts/personal-agent-context", () => ({
  useBotId: () => ctx.botId,
  usePersonalAgent: () => ({
    botId: ctx.botId,
    snapshot: ctx.snapshot,
    switching: ctx.switching,
    refresh: vi.fn(),
  }),
}))

import { BotPage } from "./bot-page"

const FLAGS = {
  sort_order: 0,
  pinned_at: null,
  section: null,
  hidden: false,
  muted: false,
  unread_mark: false,
  notify: true,
}

function entry(
  id: number,
  name: string,
  kind: "primary" | "worker"
): RosterEntry {
  return {
    id,
    kind,
    uid: `u${id}`,
    name,
    avatar: { kind: "face", shape: "blob", color: "blue" },
    template: kind === "worker" ? "review" : null,
    executor_assistant_id: null,
    created_at: "2026-11-10T00:00:00Z",
    roster: { ...FLAGS, muted: id === 7 },
    live: { bot_id: id, updated_at: "2026-11-10T00:00:00Z" },
  } as unknown as RosterEntry
}

function snapshot(
  agent: { id: number; name: string; kind: "primary" | "worker" } | null,
  engine: "here" | "elsewhere" = "here"
): PersonalAgentSnapshot {
  return {
    agent: agent && {
      ...agent,
      avatar: { kind: "face", shape: "blob", color: "blue" },
      agent_type: "claude_code",
      agent_options: {},
      label_snapshot: { agent: "Claude Code", mode: null, options: [] },
      settings: {
        auto_compact_percent: 50,
        compact_command: null,
        compact_command_agent: null,
        handoff_budget_chars: 32000,
        dispatch_concurrency: 3,
        skill_enabled: true,
      },
      workdir: "/data/personal-agent",
      workdir_custom: false,
      folder_id: null,
      revision: 1,
      created_at: "2026-11-10T00:00:00Z",
      updated_at: "2026-11-10T00:00:00Z",
      uid: `u${agent.id}`,
      template: agent.kind === "worker" ? "review" : null,
      executor_assistant_id: null,
    },
    status: { engine } as PersonalAgentSnapshot["status"],
    account: null,
  } as unknown as PersonalAgentSnapshot
}

const ROSTER = [entry(1, "Nova", "primary"), entry(7, "Reviewer", "worker")]

function draw() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <BotPage />
    </NextIntlClientProvider>
  )
}

const tabNames = () =>
  screen.getAllByRole("tab").map((tab) => tab.textContent ?? "")

beforeEach(() => {
  __resetRosterForTests()
  api.personalAgentBots.mockResolvedValue(ROSTER)
  usePersonalAgentRoster.setState({ entries: ROSTER })
  ctx.snapshot = snapshot({ id: 1, name: "Nova", kind: "primary" })
  ctx.botId = null
  ctx.switching = false
  identity.props = null
  usePersonalAgentUi.setState({ viewBot: null, settings: null, botPage: null })
  usePersonalAgentUi.getState().openBotPage()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  usePersonalAgentUi.setState({ viewBot: null, settings: null, botPage: null })
})

describe("an assistant's own page", () => {
  it("shows whose it is over its tabs, on “Identity & brain” first", () => {
    draw()
    const head = document.querySelector("[data-pa-bot-page-head]")!
    expect(within(head as HTMLElement).getByRole("heading").textContent).toBe(
      "Nova"
    )
    expect(
      document.querySelector("[data-pa-bot-page-subtitle]")?.textContent
    ).toBe("Primary assistant · Claude Code")
    // No title over a tab's body: the tab names it.
    expect(tabNames()).toEqual([
      "Identity & brain",
      "Persona & memory",
      "Notifications",
      "Advanced",
    ])
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe(
      "Identity & brain"
    )
    expect(screen.getByTestId("identity-page")).toBeInTheDocument()
    expect(identity.props).toMatchObject({ bot: null, disabled: false })
  })

  it("switches tabs, and opens a persona file a card names", async () => {
    draw()
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Advanced" }))
    expect(usePersonalAgentUi.getState().botPage).toEqual({ tab: "advanced" })
    expect(
      await screen.findByLabelText("Dispatched conversations at once")
    ).toBeInTheDocument()
    expect(screen.queryByTestId("identity-page")).toBeNull()
    act(() => {
      usePersonalAgentUi
        .getState()
        .openBotPage("persona", { entry: "memory/release.md" })
    })
    expect(
      screen.getByTestId("persona-files").getAttribute("data-initial")
    ).toBe("memory/release.md")
  })

  it("has a work assistant's execution, and saves its own items to it", async () => {
    ctx.botId = 7
    ctx.snapshot = snapshot({ id: 7, name: "Reviewer", kind: "worker" })
    usePersonalAgentUi.setState({ viewBot: 7 })
    usePersonalAgentUi.getState().openBotPage("advanced")
    draw()
    expect(
      document.querySelector("[data-pa-bot-page-head] h1")?.textContent
    ).toBe("Reviewer")
    await waitFor(() =>
      expect(
        document.querySelector("[data-pa-bot-page-subtitle]")?.textContent
      ).toBe("Reviewer role · Claude Code")
    )
    expect(tabNames()).toEqual([
      "Identity & brain",
      "Persona & memory",
      "Execution",
      "Notifications",
      "Advanced",
    ])
    const field = screen.getByLabelText("Dispatched conversations at once")
    fireEvent.change(field, { target: { value: "5" } })
    fireEvent.blur(field)
    await waitFor(() =>
      expect(api.personalAgentSettingsPatch).toHaveBeenCalledWith(
        [{ key: "own.dispatch_concurrency", value: 5 }],
        7
      )
    )
  })

  it("opens the primary's on its first tab when asked for a work assistant's execution", () => {
    usePersonalAgentUi.getState().openBotPage("execution")
    draw()
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe(
      "Identity & brain"
    )
    expect(screen.getByTestId("identity-page")).toBeInTheDocument()
  })

  it("turns its notifications on and off on “Notifications”", async () => {
    usePersonalAgentUi.getState().openBotPage("notify")
    const { unmount } = draw()
    const notify = await waitFor(() => {
      const el = document.querySelector('[data-pa-notify="notify"]')
      expect(el).not.toBeDisabled()
      return el!
    })
    // The primary cannot be hidden.
    expect(document.querySelector('[data-pa-notify="hidden"]')).toBeNull()
    fireEvent.click(notify)
    await waitFor(() =>
      expect(api.personalAgentRosterAct).toHaveBeenCalledWith(1, {
        act: "notify",
        on: false,
      })
    )
    unmount()
    // A work assistant: muted already, and it can be hidden.
    ctx.botId = 7
    ctx.snapshot = snapshot({ id: 7, name: "Reviewer", kind: "worker" })
    usePersonalAgentUi.setState({ viewBot: 7 })
    usePersonalAgentUi.getState().openBotPage("notify")
    draw()
    const muted = await waitFor(() => {
      const el = document.querySelector('[data-pa-notify="muted"]')
      expect(el).toHaveAttribute("data-state", "checked")
      return el!
    })
    fireEvent.click(muted)
    await waitFor(() =>
      expect(api.personalAgentRosterAct).toHaveBeenCalledWith(7, {
        act: "unmute",
      })
    )
    fireEvent.click(document.querySelector('[data-pa-notify="hidden"]')!)
    await waitFor(() =>
      expect(api.personalAgentRosterAct).toHaveBeenCalledWith(7, {
        act: "hide",
      })
    )
  })

  it("while another assistant is read, says whose it is and shows nothing of the last one's", () => {
    // Worker 7 picked; the page still holds the primary's, switching.
    ctx.switching = true
    usePersonalAgentUi.setState({ viewBot: 7 })
    usePersonalAgentUi.getState().openBotPage("identity")
    draw()
    expect(
      document.querySelector("[data-pa-bot-page-head] h1")?.textContent
    ).toBe("Reviewer")
    expect(screen.getByRole("tab", { name: "Execution" })).toBeInTheDocument()
    expect(screen.queryByTestId("identity-page")).toBeNull()
    expect(
      document.querySelector("[data-pa-bot-page-subtitle]")?.textContent
    ).not.toContain("Claude Code")
  })

  it("is the first setup with no assistant yet", () => {
    usePersonalAgentRoster.setState({ entries: [] })
    api.personalAgentBots.mockResolvedValue([])
    ctx.snapshot = snapshot(null)
    draw()
    expect(
      document.querySelector("[data-pa-bot-page-head] h1")?.textContent
    ).toBe("Set up your personal agent")
    expect(screen.queryAllByRole("tab")).toEqual([])
    expect(screen.getByTestId("identity-page")).toBeInTheDocument()
    expect(identity.props).toMatchObject({ agent: null })
  })

  it("is read-only while the engine runs elsewhere", () => {
    ctx.snapshot = snapshot(
      { id: 1, name: "Nova", kind: "primary" },
      "elsewhere"
    )
    draw()
    expect(screen.getByText(/settings are read-only here/)).toBeInTheDocument()
    expect(identity.props).toMatchObject({ disabled: true })
  })

  it("goes back to the conversation", () => {
    draw()
    fireEvent.click(document.querySelector("[data-pa-bot-page-back]")!)
    expect(usePersonalAgentUi.getState().botPage).toBeNull()
  })
})

describe("opening an assistant's own page", () => {
  it("switches to the assistant asked for, closing what was open of the last one", () => {
    usePersonalAgentUi.setState({
      viewBot: null,
      settings: { page: "workers" },
      workOpen: true,
    })
    usePersonalAgentUi.getState().openBotPage("identity", { bot: 7 })
    const ui = usePersonalAgentUi.getState()
    expect(ui.viewBot).toBe(7)
    expect(ui.botPage).toEqual({ tab: "identity" })
    expect(ui.settings).toBeNull()
    expect(ui.workOpen).toBe(false)
    // Picked on the roster: its conversation, the page closed.
    ui.setViewBot(null)
    expect(usePersonalAgentUi.getState().botPage).toBeNull()
  })

  it("gives way to the panel, asked for", () => {
    usePersonalAgentUi.getState().openBotPage("notify")
    usePersonalAgentUi.getState().showAux("stats")
    const ui = usePersonalAgentUi.getState()
    expect(ui.botPage).toBeNull()
    expect(ui.auxOpen).toBe(true)
    expect(ui.auxTab).toBe("stats")
  })
})
