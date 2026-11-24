import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type {
  PersonalAgentAccount,
  PersonalAgentGrades,
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
    workday: { start: 570, end: 1110, learned: true, days: 12, set: false },
    restday: { start: 540, end: 1080, learned: false, days: 0, set: false },
  },
  learned_hours: {
    workday: { start: 570, end: 1110, learned: true, days: 12, set: false },
    restday: { start: 540, end: 1080, learned: false, days: 0, set: false },
  },
  learn_days: 28,
  reactions: true,
  seen_since: "2026-10-12T02:00:00Z",
  cleared_at: null as string | null,
  projects: [
    {
      folder_id: 3,
      name: "codeg",
      recent: 5,
      sessions: 9,
      last_at: "2026-11-11T01:00:00Z",
      excluded: false,
    },
  ],
  excluded: [[8, "old-site"]] as [number, string][],
  agents: [{ agent_type: "claude_code", sessions: 9, percent: 90 }],
  cards: [
    {
      kind: "rule",
      raised: 6,
      acted: 3,
      dismissed: 2,
      muted: 1,
      undone: 0,
      expired: 0,
      open: 0,
      act_minutes: 12,
    },
  ],
}))

const HISTORY = vi.hoisted(() => ({
  documents: 120,
  sessions_done: 3,
  sessions_total: 8,
  sessions_on: true,
  tasks_on: true,
  reading: true,
}))

const api = vi.hoisted(() => ({
  personalAgentSettingsPatch: vi.fn(async () => []),
  personalAgentBots: vi.fn(async () => []),
  personalAgentGet: vi.fn(),
  openSettingsWindow: vi.fn(async () => {}),
  personalAgentTemplates: vi.fn(async () => []),
  personalAgentBotCopy: vi.fn(),
  personalAgentBotCreate: vi.fn(),
  personalAgentBotImpact: vi.fn(),
  personalAgentBotDelete: vi.fn(),
  personalAgentProfile: vi.fn(async () => PROFILE),
  personalAgentProfileUpdate: vi.fn(async () => ({
    ...PROFILE,
    hours: {
      ...PROFILE.hours,
      workday: { start: 600, end: 1200, learned: true, days: 12, set: true },
    },
  })),
  personalAgentGrades: vi.fn(
    async (): Promise<PersonalAgentGrades> => ({
      bots: {},
      cells: [],
    })
  ),
  personalAgentHistoryStatus: vi.fn(async () => HISTORY),
  personalAgentHistoryRebuild: vi.fn(async () => ({
    ...HISTORY,
    documents: 0,
    sessions_done: 0,
    reading: true,
  })),
  personalAgentRosterAct: vi.fn(async () => {}),
  personalAgentRules: vi.fn(async () => []),
  personalAgentRuleReset: vi.fn(async () => []),
  personalAgentMeetProjects: vi.fn(async (): Promise<unknown[]> => []),
}))
vi.mock("@/lib/api", () => api)
const shell = vi.hoisted(() => ({ desktop: false }))
vi.mock("@/lib/transport", async (orig) => ({
  ...(await orig<typeof import("@/lib/transport")>()),
  isDesktop: () => shell.desktop,
}))
vi.mock("@/lib/platform", () => ({
  subscribe: () => Promise.resolve(() => {}),
}))
vi.mock("sonner", () => ({ toast: { error: vi.fn(), message: vi.fn() } }))
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }))
vi.mock("@/components/layout/workspace-folder-dialog", () => ({
  WorkspaceFolderDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="folder-dialog" /> : null,
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
      work: {
        agent_type: "claude_code",
        agent_options: {},
        label_snapshot: { agent: "Claude Code", mode: null, options: [] },
      },
      work_instructions: "",
      legacy_assistant_id: null,
    },
    status: { engine } as PersonalAgentSnapshot["status"],
    account: {
      prefs: PREFS,
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
  usePersonalAgentUi.getState().openSettings()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  usePersonalAgentUi.getState().showConversation()
})

describe("the settings view", () => {
  it("has the preferences every assistant shares — no team pages any more — and none of an assistant's own", () => {
    draw()
    const nav = document.querySelector("[data-pa-settings-nav]") as HTMLElement
    expect(within(nav).getByRole("heading").textContent).toBe(
      "Assistant preferences"
    )
    // No line under the title, no group's name of its own: the title is it.
    expect(within(nav).queryByText("Shared by every assistant")).toBeNull()
    expect(within(nav).queryByText("Preferences")).toBeNull()
    expect(within(nav).queryAllByRole("group")).toHaveLength(0)
    expect(
      [...nav.querySelectorAll("[data-pa-nav]")].map((b) =>
        b.getAttribute("data-pa-nav")
      )
    ).toEqual(["communication", "projects", "proactive", "automation", "about"])
    // Each with its icon.
    for (const b of nav.querySelectorAll("[data-pa-nav]")) {
      expect(b.querySelector("svg")).not.toBeNull()
    }
    // An assistant's own pages are on its page, the assistants themselves
    // on the sidebar.
    for (const page of [
      "identity",
      "persona",
      "notify",
      "advanced",
      "workers",
      "executors",
    ]) {
      expect(document.querySelector(`[data-pa-nav="${page}"]`)).toBeNull()
    }
    // It opens on the first preferences page.
    expect(
      document
        .querySelector('[data-pa-nav="communication"]')
        ?.getAttribute("aria-current")
    ).toBe("page")
  })

  it("watches every project by default; picking some is sent as what it asks, never a whole list", async () => {
    const projects = [
      {
        id: 1,
        name: "app",
        path: "/p/app",
        forge: { kind: "account", provider: "github", host: "github.com" },
      },
      {
        id: 2,
        name: "lib",
        path: "/p/lib",
        forge: { kind: "no_account", provider: "gitlab", host: "gitlab.com" },
      },
      { id: 3, name: "notes", path: "/p/notes", forge: { kind: "none" } },
      {
        id: 4,
        name: "corp",
        path: "/p/corp",
        forge: { kind: "other", host: "gitee.com" },
      },
    ]
    api.personalAgentMeetProjects.mockResolvedValue(projects)
    usePersonalAgentUi.getState().openSettings("projects")
    const { unmount } = draw()
    expect(screen.getByRole("heading", { name: "Your projects" })).toBeTruthy()
    await screen.findByText("app")
    // All of them: every box ticked, none to untick.
    for (const box of screen.getAllByRole("checkbox")) {
      expect(box.getAttribute("aria-checked")).toBe("true")
      expect(box.hasAttribute("disabled")).toBe(true)
    }
    expect(
      screen
        .getByRole("radio", { name: /All projects/ })
        .getAttribute("aria-checked")
    ).toBe("true")
    expect(
      screen.getByRole("button", { name: "Restore defaults" })
    ).toBeDisabled()
    // Where each is hosted; only a public forge without an account offers
    // one.
    expect(screen.getByText("On GitHub")).toBeTruthy()
    expect(screen.getByText("On GitLab, no account connected")).toBeTruthy()
    expect(screen.getByText("No code host")).toBeTruthy()
    expect(screen.getByText("gitee.com")).toBeTruthy()
    const connect = screen.getAllByRole("button", { name: "Connect account" })
    expect(connect).toHaveLength(1)
    fireEvent.click(connect[0])
    expect(api.openSettingsWindow).toHaveBeenCalledWith("version-control")
    fireEvent.click(screen.getByRole("radio", { name: /Only the projects/ }))
    await waitFor(() =>
      expect(api.personalAgentSettingsPatch).toHaveBeenCalledWith(
        [{ key: "prefs.projects", value: "only" }],
        null
      )
    )
    unmount()

    // Some picked: a tick is one more, an untick one fewer.
    vi.mocked(api.personalAgentSettingsPatch).mockClear()
    ctx.snapshot = snapshot({ prefs: { ...PREFS, projects: [1] } })
    draw()
    await screen.findByText("app")
    const box = (name: string) =>
      screen.getByRole("checkbox", { name: new RegExp(name) })
    expect(box("app").getAttribute("aria-checked")).toBe("true")
    expect(box("lib").getAttribute("aria-checked")).toBe("false")
    fireEvent.click(box("lib"))
    await waitFor(() =>
      expect(api.personalAgentSettingsPatch).toHaveBeenCalledWith(
        [{ key: "prefs.projects", value: { add: 2 } }],
        null
      )
    )
    fireEvent.click(box("app"))
    await waitFor(() =>
      expect(api.personalAgentSettingsPatch).toHaveBeenCalledWith(
        [{ key: "prefs.projects", value: { remove: 1 } }],
        null
      )
    )
    fireEvent.click(screen.getByRole("button", { name: "Restore defaults" }))
    await waitFor(() =>
      expect(api.personalAgentSettingsPatch).toHaveBeenCalledWith(
        [{ key: "prefs.projects", value: "all" }],
        null
      )
    )
  })

  it("with no project yet, offers to open one", async () => {
    api.personalAgentMeetProjects.mockResolvedValue([])
    usePersonalAgentUi.getState().openSettings("projects")
    draw()
    await screen.findByText("codeg has no project yet.")
    fireEvent.click(
      screen.getByRole("button", { name: "Open a project folder" })
    )
    expect(screen.getByTestId("folder-dialog")).toBeTruthy()
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

  it("says how far the time machine is, switches what it searches and rebuilds it", async () => {
    usePersonalAgentUi.getState().openSettings("about")
    draw()
    const status = await waitFor(() => {
      const el = document.querySelector("[data-pa-history-status]")
      expect(el).not.toBeNull()
      return el!
    })
    expect(status.getAttribute("data-pa-history-status")).toBe("reading")
    expect(status.textContent).toBe(
      "Reading conversations: 3 of 8 so far (120 entries)."
    )
    // Leaving the conversations out saves at once.
    fireEvent.click(
      document.querySelector('[data-pa-pref="history_sessions"]')!
    )
    await waitFor(() =>
      expect(api.personalAgentSettingsPatch).toHaveBeenCalledWith(
        [{ key: "prefs.history_sessions", value: "off" }],
        null
      )
    )
    fireEvent.click(document.querySelector('[data-pa-pref="history_tasks"]')!)
    await waitFor(() =>
      expect(api.personalAgentSettingsPatch).toHaveBeenCalledWith(
        [{ key: "prefs.history_tasks", value: "off" }],
        null
      )
    )
    fireEvent.click(document.querySelector("[data-pa-history-rebuild]")!)
    await waitFor(() =>
      expect(api.personalAgentHistoryRebuild).toHaveBeenCalledTimes(1)
    )
  })

  it("changes the owner's hours, minds projects, counts answers and clears", async () => {
    usePersonalAgentUi.getState().openSettings("about")
    draw()
    const edit = await waitFor(() => {
      const el = document.querySelector('[data-pa-hours-edit="workday"]')
      expect(el).not.toBeNull()
      return el as HTMLElement
    })
    fireEvent.click(edit)
    fireEvent.change(
      document.querySelector('[data-pa-hours-start="workday"]')!,
      { target: { value: "10:00" } }
    )
    fireEvent.change(document.querySelector('[data-pa-hours-end="workday"]')!, {
      target: { value: "20:00" },
    })
    fireEvent.click(document.querySelector('[data-pa-hours-save="workday"]')!)
    await waitFor(() =>
      expect(api.personalAgentProfileUpdate).toHaveBeenCalledWith({
        op: "hours",
        day: "workday",
        start: "10:00",
        end: "20:00",
      })
    )
    // Theirs now: said so, and they can let go of it.
    await waitFor(() =>
      expect(
        document
          .querySelector('[data-pa-hours="workday"]')
          ?.getAttribute("data-set")
      ).toBe("true")
    )
    expect(
      document.querySelector('[data-pa-hours="workday"]')?.textContent
    ).toContain("set by you")
    fireEvent.click(document.querySelector('[data-pa-hours-unset="workday"]')!)
    await waitFor(() =>
      expect(api.personalAgentProfileUpdate).toHaveBeenCalledWith({
        op: "hours",
        day: "workday",
        start: null,
        end: null,
      })
    )
    // A project seen, one not minded.
    const project = document.querySelector('[data-pa-seen-project="3"]')!
    expect(project.textContent).toContain("5 / 9 conversations")
    fireEvent.click(document.querySelector('[data-pa-seen-exclude="3"]')!)
    await waitFor(() =>
      expect(api.personalAgentProfileUpdate).toHaveBeenCalledWith({
        op: "project",
        folder_id: 3,
        excluded: true,
      })
    )
    expect(
      document
        .querySelector('[data-pa-seen-project="8"]')
        ?.getAttribute("data-excluded")
    ).toBe("true")
    expect(
      document.querySelector('[data-pa-seen-agent="claude_code"]')?.textContent
    ).toContain("90%")
    // How they answer proposals.
    const row = document.querySelector('[data-pa-reaction="rule"]')!
    expect(row.textContent).toContain("Proposals")
    expect(row.textContent).toContain("12 min")
    fireEvent.click(document.querySelector('[data-pa-pref="reactions"]')!)
    await waitFor(() =>
      expect(api.personalAgentSettingsPatch).toHaveBeenCalledWith(
        [{ key: "prefs.reactions", value: "off" }],
        null
      )
    )
    // Clearing asks first.
    fireEvent.click(document.querySelector("[data-pa-profile-clear]")!)
    fireEvent.click(
      await waitFor(() => {
        const el = document.querySelector("[data-pa-profile-clear-confirm]")
        expect(el).not.toBeNull()
        return el as HTMLElement
      })
    )
    await waitFor(() =>
      expect(api.personalAgentProfileUpdate).toHaveBeenCalledWith({
        op: "clear",
      })
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

  it("goes back to the conversation from the pill over its title", () => {
    draw()
    const back = document.querySelector<HTMLElement>("[data-pa-settings-back]")!
    // It says where it goes, in words; the title is under it — small, as
    // a group's name over its pages, and nothing under it but the pages.
    expect(back.textContent).toBe("Back to the conversation")
    const title = document.querySelector("[data-pa-settings-title]")!
    expect(title.tagName).toBe("H1")
    expect(title.textContent).toBe("Assistant preferences")
    expect(title.className).toContain("text-xs")
    expect(
      title.nextElementSibling?.querySelector("[data-pa-nav]")
    ).toBeTruthy()
    expect(
      back.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    // The navigation's rows are pills.
    for (const b of document.querySelectorAll("[data-pa-nav]")) {
      expect(b.className).toContain("rounded-full")
    }
    fireEvent.click(back)
    expect(usePersonalAgentUi.getState().settings).toBeNull()
  })

  it("heads each page with its title alone", () => {
    usePersonalAgentUi.getState().openSettings("communication")
    draw()
    const page = document.querySelector<HTMLElement>(
      '[data-pa-settings-page="communication"]'
    )!
    const head = page.firstElementChild!
    expect(head.querySelector("h2")?.textContent).toBe("Communication")
    // No line under it saying what the page is for.
    expect(head.querySelector("p")).toBeNull()
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
      "level_pr_ready",
      "level_pr",
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
    // No menu bar or dock in a browser.
    expect(document.querySelector('[data-pa-pref-group="desktop"]')).toBeNull()
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
    // A level of the owner's own making is not overwritten unasked: "more"
    // also halves the proposal rules' six thresholds (6.7).
    api.personalAgentSettingsPatch.mockClear()
    fireEvent.click(document.querySelector('[data-pa-level="more"]')!)
    expect(api.personalAgentSettingsPatch).not.toHaveBeenCalled()
    expect(
      await screen.findByText("This overwrites 9 items you changed.")
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

  it("on the desktop, switches the menu bar's faces and the dock's badge", async () => {
    shell.desktop = true
    try {
      usePersonalAgentUi.getState().openSettings("proactive")
      draw()
      const group = document.querySelector('[data-pa-pref-group="desktop"]')
      expect(group?.querySelector('[data-pa-pref="menubar"]')).not.toBeNull()
      expect(group?.querySelector('[data-pa-pref="dock_badge"]')).not.toBeNull()
      expect(screen.getByText("Busy assistants in the menu bar")).toBeTruthy()
      expect(screen.getByText("Dock badge")).toBeTruthy()
    } finally {
      shell.desktop = false
    }
  })
})
