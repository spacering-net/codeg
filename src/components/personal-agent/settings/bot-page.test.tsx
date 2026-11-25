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
  personalAgentSetWorkdir: vi.fn(),
  personalAgentSave: vi.fn(),
}))
vi.mock("@/lib/api", () => api)
vi.mock("@/lib/platform", () => ({
  subscribe: () => Promise.resolve(() => {}),
  onTransportReconnect: () => () => {},
  isDesktop: () => false,
}))
vi.mock("sonner", () => ({ toast: { error: vi.fn(), message: vi.fn() } }))
// The identity and persona tabs' editors are tested where they live.
const identity = vi.hoisted(() => ({
  props: null as Record<string, unknown> | null,
  mounts: 0,
}))
vi.mock("./identity-page", async () => {
  const { useEffect } = await import("react")
  return {
    IdentityPage: (props: Record<string, unknown>) => {
      identity.props = props
      useEffect(() => {
        identity.mounts += 1
      }, [])
      return <div data-testid="identity-page" />
    },
  }
})
vi.mock("../persona-files", () => ({
  PersonaFiles: (props: { botId: number | null; initial: string | null }) => (
    <div data-testid="persona-files" data-initial={props.initial ?? ""} />
  ),
}))
vi.mock("@/stores/assistants-store", () => ({
  useAssistants: () => [],
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
    refresh: vi.fn(),
  }),
  usePersonalAgentSwitch: () => ({ switching: ctx.switching, to: null }),
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
    avatar: { kind: "face", shape: "ring", color: "blue" },
    hidden: false,
    has_brain: true,
    legacy_assistant_id: null,
    created_at: "2026-11-10T00:00:00Z",
    persona: kind === "worker" ? "# Persona Default sentence." : "",
    persona_unwritten: kind === "worker",
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
      avatar: { kind: "face", shape: "ring", color: "blue" },
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
      work: {
        agent_type: "claude_code",
        agent_options: {},
        label_snapshot: { agent: "Claude Code", mode: null, options: [] },
      },
      work_instructions: "",
      legacy_assistant_id: null,
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
  identity.mounts = 0
  usePersonalAgentUi.setState({ viewBot: null, settings: null, botPage: null })
  usePersonalAgentUi.getState().openBotPage()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  usePersonalAgentUi.setState({ viewBot: null, settings: null, botPage: null })
})

describe("an assistant's own page", () => {
  it("shows whose it is beside its tabs, on “Identity & brain” first", () => {
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

  it("has a work assistant's tabs, no role in its head, and saves its own items to it", async () => {
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
      ).toBe("Assistant · Claude Code")
    )
    // The agent its work runs on is on "Identity & brain": no "Execution"
    // tab.
    expect(tabNames()).toEqual([
      "Identity & brain",
      "Persona & memory",
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

  it("says on “Persona & memory” when a work assistant's persona is not written yet", async () => {
    ctx.botId = 7
    ctx.snapshot = snapshot({ id: 7, name: "Reviewer", kind: "worker" })
    usePersonalAgentUi.setState({ viewBot: 7 })
    usePersonalAgentUi.getState().openBotPage("persona")
    const { unmount } = draw()
    const note = await waitFor(() => {
      const el = document.querySelector("[data-pa-persona-unwritten]")
      expect(el).not.toBeNull()
      return el!
    })
    expect(note.textContent).toMatch(/No persona written yet/)
    unmount()
    // The primary's says what it is: no such note.
    ctx.botId = null
    ctx.snapshot = snapshot({ id: 1, name: "Nova", kind: "primary" })
    usePersonalAgentUi.setState({ viewBot: null })
    usePersonalAgentUi.getState().openBotPage("persona")
    draw()
    expect(screen.getByTestId("persona-files")).toBeInTheDocument()
    expect(document.querySelector("[data-pa-persona-unwritten]")).toBeNull()
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
    expect(
      screen.getByRole("tab", { name: "Notifications" })
    ).toBeInTheDocument()
    expect(screen.queryByTestId("identity-page")).toBeNull()
    expect(
      document.querySelector("[data-pa-bot-page-subtitle]")?.textContent
    ).not.toContain("Claude Code")
  })

  // The first setup is the page's own screen, never this one: with no
  // assistant known, it shows no name, no tabs and no settings.
  it("shows nothing of an assistant while none is known", () => {
    usePersonalAgentRoster.setState({ entries: [] })
    api.personalAgentBots.mockResolvedValue([])
    ctx.snapshot = snapshot(null)
    draw()
    expect(
      document.querySelector("[data-pa-bot-page-head] h1")?.textContent
    ).toBe("")
    expect(screen.queryAllByRole("tab")).toEqual([])
    expect(screen.queryByTestId("identity-page")).toBeNull()
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

  it("goes back to the conversation from the arrow in its corner", () => {
    draw()
    const back = document.querySelector<HTMLElement>("[data-pa-bot-page-back]")!
    // An arrow on the head's line, named for a pointer and a screen reader.
    expect(back.textContent).toBe("")
    expect(back.getAttribute("aria-label")).toBe("Back to the conversation")
    expect(back.parentElement!.querySelector("h1")?.textContent).toBe("Nova")
    fireEvent.click(back)
    expect(usePersonalAgentUi.getState().botPage).toBeNull()
  })

  it("goes to its conversation from [Chat with it] under its name", () => {
    draw()
    const head = document.querySelector("[data-pa-bot-page-head]")!
    const chat = head.querySelector<HTMLElement>("[data-pa-bot-page-chat]")!
    expect(chat.textContent).toBe("Chat with it")
    fireEvent.click(chat)
    expect(usePersonalAgentUi.getState().botPage).toBeNull()
  })

  it("is laid out as the first setup is: who it is on the left, its tabs alone scrolling on the right, one column when narrow", () => {
    const observers: Array<() => void> = []
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: () => void) {
          observers.push(cb)
        }
        observe() {}
        disconnect() {}
      }
    )
    let width = 1200
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(() => ({ width }) as DOMRect)
    try {
      draw()
      const frame = document.querySelector("[data-pa-bot-frame]")!
      expect(frame.getAttribute("data-pa-bot-page-layout")).toBe("wide")
      // Over a wash of its face's colour.
      expect(frame.getAttribute("data-pa-face")).toBe("blue")
      expect(frame.querySelector(".pa-setup-wash")).not.toBeNull()
      const head = document.querySelector("[data-pa-bot-page-head]")!
      const body = screen.getByTestId("identity-page")
      const scroller = (el: Element) =>
        el.closest("[data-overlayscrollbars-initialize]")
      // The tabs' bodies scroll on their own, not with who it is, and
      // their row stays put over them.
      expect(scroller(body)).not.toBeNull()
      expect(scroller(head)).not.toBe(scroller(body))
      expect(scroller(body)!.contains(screen.getAllByRole("tab")[0])).toBe(
        false
      )
      // Narrower: one column, who it is over the tabs, scrolling as one —
      // the tab's body kept as it is (what is being changed on it stays).
      const mounted = identity.mounts
      const before = screen.getByTestId("identity-page")
      width = 700
      act(() => observers.forEach((o) => o()))
      expect(identity.mounts).toBe(mounted)
      expect(screen.getByTestId("identity-page")).toBe(before)
      expect(frame.getAttribute("data-pa-bot-page-layout")).toBe("narrow")
      const head2 = document.querySelector("[data-pa-bot-page-head]")!
      expect(scroller(head2)).toBe(
        scroller(screen.getByTestId("identity-page"))
      )
      expect(
        head2.compareDocumentPosition(screen.getAllByRole("tab")[0]) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy()
    } finally {
      rect.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it("saves a face picked on it at once, shown meanwhile, and takes it back when refused", async () => {
    let refuse: (e: Error) => void = () => {}
    api.personalAgentSave.mockImplementationOnce(
      () => new Promise((_, no) => (refuse = no))
    )
    draw()
    const frame = document.querySelector("[data-pa-bot-frame]")!
    fireEvent.click(
      document.querySelector("[data-pa-bot-page-head] [data-pa-face-picker]")!
    )
    fireEvent.click(await screen.findByRole("button", { name: "Teal" }))
    expect(frame.getAttribute("data-pa-face")).toBe("teal")
    await waitFor(() =>
      expect(api.personalAgentSave).toHaveBeenCalledWith(
        {
          avatar: { kind: "face", shape: "ring", color: "teal" },
          locale: "en",
        },
        null
      )
    )
    await act(async () => refuse(new Error("no")))
    expect(frame.getAttribute("data-pa-face")).toBe("blue")
  })

  it("saves faces picked one after another in the order picked, one at a time", async () => {
    let first: (v: unknown) => void = () => {}
    api.personalAgentSave
      .mockImplementationOnce(() => new Promise((ok) => (first = ok)))
      .mockResolvedValueOnce(undefined)
    draw()
    const picker = () =>
      document.querySelector<HTMLElement>(
        "[data-pa-bot-page-head] [data-pa-face-picker]"
      )!
    fireEvent.click(picker())
    fireEvent.click(await screen.findByRole("button", { name: "Teal" }))
    await waitFor(() => expect(api.personalAgentSave).toHaveBeenCalledTimes(1))
    fireEvent.click(await screen.findByRole("button", { name: "Purple" }))
    // The second waits for the first to be done.
    await act(async () => {})
    expect(api.personalAgentSave).toHaveBeenCalledTimes(1)
    await act(async () => first(undefined))
    await waitFor(() => expect(api.personalAgentSave).toHaveBeenCalledTimes(2))
    expect(api.personalAgentSave.mock.calls[1][0]).toMatchObject({
      avatar: { color: "purple" },
    })
  })

  it("sends only the last face picked, after a page closed and opened again meanwhile too", async () => {
    let first: (v: unknown) => void = () => {}
    api.personalAgentSave
      .mockImplementationOnce(() => new Promise((ok) => (first = ok)))
      .mockResolvedValue(undefined)
    // The picker stays open after a pick: opened only when it is not.
    const pickColor = async (name: string) => {
      if (!screen.queryByRole("button", { name }))
        fireEvent.click(
          document.querySelector(
            "[data-pa-bot-page-head] [data-pa-face-picker]"
          )!
        )
      fireEvent.click(await screen.findByRole("button", { name }))
    }
    draw()
    await pickColor("Teal")
    await waitFor(() => expect(api.personalAgentSave).toHaveBeenCalledTimes(1))
    await pickColor("Purple")
    // Closed and opened again, a third picked while the first is out.
    cleanup()
    draw()
    await pickColor("Orange")
    await act(async () => first(undefined))
    await waitFor(() => expect(api.personalAgentSave).toHaveBeenCalledTimes(2))
    await act(async () => {})
    expect(api.personalAgentSave).toHaveBeenCalledTimes(2)
    expect(api.personalAgentSave.mock.calls[1][0]).toMatchObject({
      avatar: { color: "orange" },
    })
  })

  it("shows a face picked for one assistant on its page only, not on the next one's with the same face", async () => {
    api.personalAgentSave.mockImplementationOnce(() => new Promise(() => {}))
    const { rerender } = draw()
    fireEvent.click(
      document.querySelector("[data-pa-bot-page-head] [data-pa-face-picker]")!
    )
    fireEvent.click(await screen.findByRole("button", { name: "Teal" }))
    const frame = () => document.querySelector("[data-pa-bot-frame]")!
    expect(frame().getAttribute("data-pa-face")).toBe("teal")
    // Another assistant opened, its saved face the same blue as the
    // first's was.
    ctx.botId = 7
    ctx.snapshot = snapshot({ id: 7, name: "Reviewer", kind: "worker" })
    act(() => usePersonalAgentUi.setState({ viewBot: 7 }))
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <BotPage />
      </NextIntlClientProvider>
    )
    expect(frame().getAttribute("data-pa-face")).toBe("blue")
  })

  it("renames it where its name is, the name alone saved", async () => {
    api.personalAgentSave.mockResolvedValueOnce(undefined)
    draw()
    const head = document.querySelector("[data-pa-bot-page-head]")!
    fireEvent.click(head.querySelector("[data-pa-aux-head-name]")!)
    const field = head.querySelector<HTMLInputElement>(
      "[data-pa-aux-head-name-input]"
    )!
    fireEvent.change(field, { target: { value: "Vega" } })
    fireEvent.keyDown(field, { key: "Enter" })
    expect(api.personalAgentSave).toHaveBeenCalledWith(
      { name: "Vega", locale: "en" },
      null
    )
  })

  it("changes neither its face nor its name while the engine runs elsewhere", () => {
    ctx.snapshot = snapshot(
      { id: 1, name: "Nova", kind: "primary" },
      "elsewhere"
    )
    draw()
    const head = document.querySelector("[data-pa-bot-page-head]")!
    expect(head.querySelector("[data-pa-face-picker]")).toBeNull()
    expect(head.querySelector("[data-pa-aux-head-name]")).toBeNull()
    expect(head.querySelector("h1")?.textContent).toBe("Nova")
  })
})

describe("opening an assistant's own page", () => {
  it("switches to the assistant asked for, closing what was open of the last one", () => {
    usePersonalAgentUi.setState({
      viewBot: null,
      settings: { page: "communication" },
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
