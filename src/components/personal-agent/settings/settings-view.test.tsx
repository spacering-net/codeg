import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type {
  PersonalAgentAccount,
  PersonalAgentPrefs,
  PersonalAgentSnapshot,
} from "@/lib/types"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

const PROFILE = vi.hoisted(() => ({
  time_zone: "system",
  zone: "Asia/Shanghai",
  system_zone: "Asia/Shanghai",
  zones: ["Asia/Shanghai", "Asia/Tokyo", "Europe/Berlin"],
  presence: true,
  present: true,
  last_active: "2026-11-11T02:00:00Z",
  hours: {
    workday: { start: 570, end: 1110, learned: true, days: 12 },
    restday: { start: 540, end: 1080, learned: false, days: 0 },
  },
  learn_days: 28,
}))

const api = vi.hoisted(() => ({
  personalAgentSettingsPatch: vi.fn(async () => []),
  personalAgentBots: vi.fn(async () => []),
  personalAgentExecutors: vi.fn(async () => []),
  personalAgentGet: vi.fn(),
  getDelegationSettings: vi.fn(async () => ({ enabled: true })),
  openSettingsWindow: vi.fn(async () => {}),
  personalAgentTemplates: vi.fn(async () => []),
  personalAgentBotCopy: vi.fn(),
  personalAgentBotCreate: vi.fn(),
  personalAgentBotImpact: vi.fn(),
  personalAgentBotDelete: vi.fn(),
  personalAgentProfile: vi.fn(async () => PROFILE),
  personalAgentRosterAct: vi.fn(async () => {}),
}))
vi.mock("@/lib/api", () => api)
vi.mock("@/lib/platform", () => ({
  subscribe: () => Promise.resolve(() => {}),
}))
vi.mock("sonner", () => ({ toast: { error: vi.fn(), message: vi.fn() } }))
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }))
// The pages with editors of their own are tested where they live.
vi.mock("./identity-page", () => ({
  IdentityPage: () => <div data-testid="identity-page" />,
}))
vi.mock("../persona-files", () => ({ PersonaFiles: () => null }))
vi.mock("@/components/settings/assistants-panel", () => ({
  AssistantsPanel: () => <div data-testid="executors-list" />,
}))

const ctx = vi.hoisted(() => ({
  snapshot: null as unknown,
  botId: null as number | null,
}))
vi.mock("@/contexts/personal-agent-context", () => ({
  useBotId: () => ctx.botId,
  usePersonalAgent: () => ({
    botId: ctx.botId,
    snapshot: ctx.snapshot,
    refresh: vi.fn(),
    dispatchById: new Map(),
  }),
}))

import { DEFAULT_PREFS } from "./pref-pages"
import { SettingsView } from "./settings-view"

const PREFS: PersonalAgentPrefs = { ...DEFAULT_PREFS }

function snapshot(
  account: Partial<PersonalAgentAccount> = {},
  engine: "here" | "elsewhere" = "here"
): PersonalAgentSnapshot {
  return {
    agent: {
      id: 1,
      name: "Nova",
      avatar: { kind: "emoji", emoji: "🧭", color: "violet" },
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
      kind: "primary",
      uid: "u1",
      template: null,
      executor_assistant_id: null,
    },
    status: { engine } as PersonalAgentSnapshot["status"],
    account: {
      prefs: PREFS,
      team: { division: {}, usage: {} },
      automation_level: "standard",
      disturb_level: "standard",
      ...account,
    },
  } as unknown as PersonalAgentSnapshot
}

function draw() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SettingsView />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  ctx.snapshot = snapshot()
  ctx.botId = null
  usePersonalAgentUi.getState().openSettings("identity")
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  usePersonalAgentUi.getState().closeSettings()
})

describe("the settings view", () => {
  it("has the assistant's own pages and the ones every assistant shares", () => {
    draw()
    expect(screen.getByText("This assistant · Nova")).toBeInTheDocument()
    expect(screen.getByText("All assistants")).toBeInTheDocument()
    for (const page of [
      "identity",
      "persona",
      "advanced",
      "workers",
      "executors",
      "division",
      "notify",
      "communication",
      "proactive",
      "automation",
      "about",
    ]) {
      expect(document.querySelector(`[data-pa-nav="${page}"]`)).not.toBeNull()
    }
    // A primary has no "Execution" page: it is a work assistant's.
    expect(document.querySelector('[data-pa-nav="execution"]')).toBeNull()
    expect(screen.getByTestId("identity-page")).toBeInTheDocument()
    fireEvent.click(document.querySelector('[data-pa-nav="executors"]')!)
    expect(screen.getByTestId("executors-list")).toBeInTheDocument()
    expect(
      screen.getByText(/these executor configs are the same ones/)
    ).toBeInTheDocument()
  })

  it("saves an item the moment it changes, and restores a page's defaults", async () => {
    ctx.snapshot = snapshot({ prefs: { ...PREFS, reply_length: "short" } })
    usePersonalAgentUi.getState().openSettings("communication")
    draw()
    fireEvent.click(screen.getByRole("button", { name: "Restore defaults" }))
    await waitFor(() =>
      expect(api.personalAgentSettingsPatch).toHaveBeenCalledWith(
        [{ key: "prefs.reply_length", value: "medium" }],
        null
      )
    )
  })

  it("takes a count when it is left", async () => {
    usePersonalAgentUi.getState().openSettings("automation")
    draw()
    const rounds = document.querySelector(
      '[data-pa-pref="loop_rounds"]'
    ) as HTMLInputElement
    fireEvent.change(rounds, { target: { value: "5" } })
    fireEvent.blur(rounds)
    await waitFor(() =>
      expect(api.personalAgentSettingsPatch).toHaveBeenCalledWith(
        [{ key: "prefs.loop_rounds", value: 5 }],
        null
      )
    )
  })

  it("has automatic acceptance, how work is sent back and its rounds on “Dispatch & automation” (7.5)", async () => {
    usePersonalAgentUi.getState().openSettings("automation")
    draw()
    for (const item of ["auto_accept", "accept_revise", "accept_rounds"]) {
      expect(document.querySelector(`[data-pa-pref="${item}"]`)).not.toBeNull()
    }
    expect(screen.getByText("Automatic acceptance")).toBeInTheDocument()
    expect(
      screen.getByText("Sending work back after its check")
    ).toBeInTheDocument()
    const rounds = document.querySelector(
      '[data-pa-pref="accept_rounds"]'
    ) as HTMLInputElement
    expect(rounds.value).toBe("3")
    fireEvent.change(rounds, { target: { value: "2" } })
    fireEvent.blur(rounds)
    await waitFor(() =>
      expect(api.personalAgentSettingsPatch).toHaveBeenCalledWith(
        [{ key: "prefs.accept_rounds", value: 2 }],
        null
      )
    )
  })

  it("has commenting, closing issues and merging pull requests on “Dispatch & automation” (7.4)", () => {
    usePersonalAgentUi.getState().openSettings("automation")
    draw()
    for (const item of ["forge_comment", "issue_close", "pr_merge"]) {
      expect(document.querySelector(`[data-pa-pref="${item}"]`)).not.toBeNull()
    }
    expect(screen.getByText("Comments on a forge")).toBeInTheDocument()
    expect(screen.getByText("Closing issues")).toBeInTheDocument()
    expect(screen.getByText("Merging pull requests")).toBeInTheDocument()
    expect(
      screen.getByText(/CNB can't show checks or hold the head/)
    ).toBeInTheDocument()
  })

  it("picks an automation level, and warns before overwriting the owner's own", async () => {
    usePersonalAgentUi.getState().openSettings("automation")
    const { unmount } = draw()
    fireEvent.click(document.querySelector('[data-pa-level="ask_more"]')!)
    await waitFor(() =>
      expect(api.personalAgentSettingsPatch).toHaveBeenCalledWith(
        [{ key: "prefs.automation_level", value: "ask_more" }],
        null
      )
    )
    unmount()
    api.personalAgentSettingsPatch.mockClear()
    ctx.snapshot = snapshot({
      prefs: { ...PREFS, followups: "ask" },
      automation_level: "custom",
    })
    draw()
    expect(document.querySelector('[data-pa-level="custom"]')).not.toBeNull()
    fireEvent.click(document.querySelector('[data-pa-level="standard"]')!)
    expect(
      await screen.findByText("This overwrites 1 item you changed.")
    ).toBeInTheDocument()
    expect(api.personalAgentSettingsPatch).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Switch" }))
    await waitFor(() =>
      expect(api.personalAgentSettingsPatch).toHaveBeenCalledWith(
        [{ key: "prefs.automation_level", value: "standard" }],
        null
      )
    )
  })

  it("is read-only while the engine runs elsewhere", () => {
    ctx.snapshot = snapshot({}, "elsewhere")
    usePersonalAgentUi.getState().openSettings("automation")
    draw()
    expect(
      screen.getAllByText(/settings are read-only here/).length
    ).toBeGreaterThan(0)
    expect(document.querySelector('[data-pa-level="ask_more"]')).toBeDisabled()
  })

  it("never shows a work assistant's own pages as another's", async () => {
    const worker = (id: number) => {
      const s = snapshot()
      return {
        ...s,
        agent: {
          ...s.agent!,
          id,
          name: `Worker ${id}`,
          kind: "worker" as const,
        },
      }
    }
    // Worker 2 reads; worker 3's read fails.
    api.personalAgentGet.mockImplementation(async (id: number) => {
      if (id === 3) throw new Error("gone")
      return worker(id)
    })
    usePersonalAgentUi.getState().openSettings("identity", 2)
    draw()
    expect(
      await screen.findByText("This assistant · Worker 2")
    ).toBeInTheDocument()
    expect(screen.getByTestId("identity-page")).toBeInTheDocument()
    // Another worker whose read fails: nothing of worker 2's stays up.
    act(() => {
      usePersonalAgentUi.getState().openSettings("identity", 3)
    })
    expect(
      await screen.findByText("Could not read this assistant's settings.")
    ).toBeInTheDocument()
    expect(screen.queryByTestId("identity-page")).toBeNull()
    expect(screen.queryByText("This assistant · Worker 2")).toBeNull()
  })

  it("has the owner's zone and their record of hours on “About you”", async () => {
    usePersonalAgentUi.getState().openSettings("about")
    draw()
    expect(
      document.querySelector('[data-pa-settings-page="about"]')
    ).not.toBeNull()
    const zone = screen.getByLabelText("Time zone") as HTMLInputElement
    await waitFor(() =>
      expect(zone.value).toBe("Follow the system (Asia/Shanghai)")
    )
    // The hours codeg sees: learned on workdays, the defaults on weekends.
    await waitFor(() =>
      expect(
        document.querySelector('[data-pa-hours="workday"]')?.textContent
      ).toContain("09:30–18:30")
    )
    const workday = document.querySelector('[data-pa-hours="workday"]')!
    expect(workday.textContent).toContain("from 12 days")
    const restday = document.querySelector('[data-pa-hours="restday"]')!
    expect(restday.getAttribute("data-learned")).toBe("false")
    expect(restday.textContent).toContain("still learning")
    expect(screen.getByText("You are in codeg now.")).toBeInTheDocument()
    // Nothing to restore at the defaults.
    expect(
      screen.getByRole("button", { name: "Restore defaults" })
    ).toBeDisabled()
    // Turning the record off saves at once.
    fireEvent.click(document.querySelector('[data-pa-pref="presence"]')!)
    await waitFor(() =>
      expect(api.personalAgentSettingsPatch).toHaveBeenCalledWith(
        [{ key: "prefs.presence", value: "off" }],
        null
      )
    )
  })

  it("shows a zone the owner set, and restores the system's", async () => {
    ctx.snapshot = snapshot({
      prefs: { ...PREFS, time_zone: "Europe/Berlin", presence: "off" },
    })
    usePersonalAgentUi.getState().openSettings("about")
    draw()
    const zone = screen.getByLabelText("Time zone") as HTMLInputElement
    expect(zone.value).toBe("Europe/Berlin")
    expect(
      screen.getByText("The record is off: your hours are the defaults.")
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Restore defaults" }))
    await waitFor(() =>
      expect(api.personalAgentSettingsPatch).toHaveBeenCalledWith(
        [
          { key: "prefs.time_zone", value: "system" },
          { key: "prefs.presence", value: "on" },
        ],
        null
      )
    )
  })

  it("picks a zone from the list", async () => {
    usePersonalAgentUi.getState().openSettings("about")
    draw()
    const zone = screen.getByLabelText("Time zone") as HTMLInputElement
    await waitFor(() =>
      expect(zone.value).toBe("Follow the system (Asia/Shanghai)")
    )
    const user = userEvent.setup()
    await user.clear(zone)
    await user.type(zone, "Tok")
    const tokyo = await screen.findByRole("option", { name: "Asia/Tokyo" })
    expect(screen.queryByRole("option", { name: "Europe/Berlin" })).toBeNull()
    await user.click(tokyo)
    await waitFor(() =>
      expect(api.personalAgentSettingsPatch).toHaveBeenCalledWith(
        [{ key: "prefs.time_zone", value: "Asia/Tokyo" }],
        null
      )
    )
  })

  it("goes back to the conversation", () => {
    draw()
    fireEvent.click(document.querySelector("[data-pa-settings-back]")!)
    expect(usePersonalAgentUi.getState().settings).toBeNull()
  })

  it("saves a work assistant's own items to it when the page shows it", async () => {
    // The page shows work assistant #7: its own pages are its.
    ctx.botId = 7
    const worker = snapshot() as unknown as {
      agent: Record<string, unknown>
    }
    worker.agent = { ...worker.agent, id: 7, kind: "worker", name: "Reviewer" }
    ctx.snapshot = worker
    usePersonalAgentUi.getState().openSettings("advanced")
    draw()
    expect(screen.getByText("This assistant · Reviewer")).toBeInTheDocument()
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

  it("sets how the assistants reach the owner on “Proactive & notifications”", async () => {
    usePersonalAgentUi.getState().openSettings("proactive")
    const { unmount } = draw()
    expect(
      document.querySelector('[data-pa-settings-page="proactive"]')
    ).not.toBeNull()
    for (const item of [
      "proactive",
      "urgent_via",
      "normal_via",
      "low_via",
      "focus_wait",
      "quiet_hours",
      "quiet_lets",
      "morning",
      "level_reminder",
      "level_answered",
      "level_acceptance",
      "level_used_up",
      "level_forge",
    ]) {
      expect(document.querySelector(`[data-pa-pref="${item}"]`)).not.toBeNull()
    }
    // The fixed times only show when they are fixed.
    expect(document.querySelector('[data-pa-pref="quiet_from"]')).toBeNull()
    expect(document.querySelector('[data-pa-pref="morning_at"]')).toBeNull()
    // A count saves when it is left.
    const wait = document.querySelector(
      '[data-pa-pref="focus_wait"]'
    ) as HTMLInputElement
    fireEvent.change(wait, { target: { value: "5" } })
    fireEvent.blur(wait)
    await waitFor(() =>
      expect(api.personalAgentSettingsPatch).toHaveBeenCalledWith(
        [{ key: "prefs.focus_wait", value: 5 }],
        null
      )
    )
    // A preset is a patch of its own.
    fireEvent.click(document.querySelector('[data-pa-level="quiet"]')!)
    await waitFor(() =>
      expect(api.personalAgentSettingsPatch).toHaveBeenCalledWith(
        [{ key: "prefs.disturb_level", value: "quiet" }],
        null
      )
    )
    unmount()
    api.personalAgentSettingsPatch.mockClear()
    // Fixed quiet hours and morning: their times show and save as HH:MM.
    ctx.snapshot = snapshot({
      prefs: {
        ...PREFS,
        quiet_hours: "fixed",
        morning: "fixed",
        normal_via: "in_page",
      },
      disturb_level: "custom",
    })
    draw()
    const from = document.querySelector(
      '[data-pa-pref="quiet_from"]'
    ) as HTMLInputElement
    expect(from.value).toBe("22:00")
    expect(document.querySelector('[data-pa-pref="quiet_to"]')).not.toBeNull()
    expect(document.querySelector('[data-pa-pref="morning_at"]')).not.toBeNull()
    fireEvent.change(from, { target: { value: "21:30" } })
    fireEvent.blur(from)
    await waitFor(() =>
      expect(api.personalAgentSettingsPatch).toHaveBeenCalledWith(
        [{ key: "prefs.quiet_from", value: "21:30" }],
        null
      )
    )
    // A level of the owner's own making is not overwritten unasked.
    api.personalAgentSettingsPatch.mockClear()
    fireEvent.click(document.querySelector('[data-pa-level="more"]')!)
    expect(api.personalAgentSettingsPatch).not.toHaveBeenCalled()
    expect(
      await screen.findByText("This overwrites 3 items you changed.")
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Switch" }))
    await waitFor(() =>
      expect(api.personalAgentSettingsPatch).toHaveBeenCalledWith(
        [{ key: "prefs.disturb_level", value: "more" }],
        null
      )
    )
    // Restore defaults puts the page's items back.
    api.personalAgentSettingsPatch.mockClear()
    fireEvent.click(screen.getByRole("button", { name: "Restore defaults" }))
    await waitFor(() =>
      expect(api.personalAgentSettingsPatch).toHaveBeenCalledWith(
        [
          { key: "prefs.normal_via", value: "system" },
          { key: "prefs.quiet_hours", value: "auto" },
          { key: "prefs.morning", value: "hours" },
        ],
        null
      )
    )
  })

  it("turns an assistant's own notifications on and off on its “Notifications” page", async () => {
    const flags = {
      sort_order: 0,
      pinned_at: null,
      section: null,
      hidden: false,
      muted: false,
      unread_mark: false,
      notify: true,
    }
    const entry = (id: number, kind: "primary" | "worker") => ({
      id,
      kind,
      uid: `u${id}`,
      name: kind === "primary" ? "Nova" : "Reviewer",
      avatar: { kind: "face", shape: "blob", color: "blue" },
      template: null,
      executor_assistant_id: null,
      created_at: "2026-11-10T00:00:00Z",
      roster: { ...flags, muted: id === 7 },
      live: { bot_id: id, updated_at: "2026-11-10T00:00:00Z" },
    })
    api.personalAgentBots.mockResolvedValue([
      entry(1, "primary"),
      entry(7, "worker"),
    ] as never)
    usePersonalAgentUi.getState().openSettings("notify")
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
    fireEvent.click(document.querySelector('[data-pa-notify="muted"]')!)
    await waitFor(() =>
      expect(api.personalAgentRosterAct).toHaveBeenCalledWith(1, {
        act: "mute",
      })
    )
    unmount()
    // A work assistant: muted already, and it can be hidden.
    ctx.botId = 7
    const worker = snapshot() as unknown as {
      agent: Record<string, unknown>
    }
    worker.agent = { ...worker.agent, id: 7, kind: "worker", name: "Reviewer" }
    ctx.snapshot = worker
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
    api.personalAgentBots.mockResolvedValue([])
  })
})
