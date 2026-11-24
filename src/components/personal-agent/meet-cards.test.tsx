/**
 * Getting to know the owner (5.4, 1.15): the cards after the primary's
 * brain is first picked, as the owner answers them.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { PersonalAgentAccount, TimelineRow } from "@/lib/types"

const api = vi.hoisted(() => ({
  personalAgentNoticeAct: vi.fn(),
  personalAgentChoiceAnswer: vi.fn(),
  personalAgentMeetProjects: vi.fn(),
  personalAgentStarter: vi.fn(),
  personalAgentSettingsPatch: vi.fn(),
  personalAgentBotSetTemplate: vi.fn(),
  openSettingsWindow: vi.fn(),
}))
const pet = vi.hoisted(() => ({ openPetWindow: vi.fn() }))
const platform = vi.hoisted(() => ({ openUrl: vi.fn() }))
const ctx = vi.hoisted(() => ({ account: null as unknown }))
vi.mock("@/lib/api", () => api)
vi.mock("@/lib/pet/api", () => pet)
vi.mock("@/lib/platform", () => platform)
vi.mock("@/lib/transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/transport")>()),
  isDesktop: () => true,
}))
vi.mock("@/components/layout/workspace-folder-dialog", () => ({
  WorkspaceFolderDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="folder-dialog" /> : null,
}))
vi.mock("@/contexts/personal-agent-context", () => ({
  useBotId: () => null,
  usePersonalAgent: () => ({
    liveReplies: new Map(),
    dispatchById: new Map(),
    quoted: new Map(),
    requestQuoted: () => {},
    rows: [],
    snapshot: { account: ctx.account },
  }),
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({ setRoute: vi.fn(), openConversations: vi.fn() }),
}))
vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({ openTab: vi.fn() }),
}))

import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

import { buildMessageItems, type MessageItem } from "./message-items"
import { leadText } from "./meet-cards"
import { NoticeCard } from "./notice-card"
import { DEFAULT_PREFS } from "./settings/pref-pages"
import { PageScopeContext, type PageScope } from "./shared"

function card(data: Record<string, unknown>, ref = "12"): TimelineRow {
  return {
    id: 40,
    segment_id: 1,
    batch_id: null,
    kind: "notice",
    status: null,
    body: "the brain's English line",
    data,
    dispatch_id: null,
    ref_id: ref,
    reply_to: null,
    read_at: null,
    event_id: null,
    seen_at: null,
    created_at: "2026-11-11T07:00:00Z",
    updated_at: "2026-11-11T07:00:00Z",
  }
}

function scope(readOnly = false): PageScope {
  return {
    readOnly,
    agentName: "Aide",
    liveRowId: null,
    connectionId: null,
    agentType: null,
    onQuote: vi.fn(),
    jumpTo: vi.fn(),
    rowsById: new Map(),
  }
}

function draw(row: TimelineRow, readOnly = false) {
  const item = buildMessageItems([row]).find((i) => i.kind === "notice")
  if (!item) throw new Error("no notice item")
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PageScopeContext.Provider value={scope(readOnly)}>
        <NoticeCard item={item as Extract<MessageItem, { kind: "notice" }>} />
      </PageScopeContext.Provider>
    </NextIntlClientProvider>
  )
}

function account(
  patch: Partial<PersonalAgentAccount> = {}
): PersonalAgentAccount {
  return {
    prefs: { ...DEFAULT_PREFS },
    team: { division: {}, usage: {} },
    automation_level: "standard",
    disturb_level: "standard",
    ...patch,
  } as PersonalAgentAccount
}

beforeEach(() => {
  ctx.account = account()
  for (const f of Object.values(api)) f.mockReset()
  api.personalAgentNoticeAct.mockResolvedValue(card({}))
  api.personalAgentChoiceAnswer.mockResolvedValue(card({}))
  api.personalAgentStarter.mockResolvedValue(card({}))
  api.personalAgentSettingsPatch.mockResolvedValue([])
  api.openSettingsWindow.mockResolvedValue(undefined)
  pet.openPetWindow.mockReset()
  pet.openPetWindow.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
})

describe("what to call each other", () => {
  const open = () =>
    card({
      notice: "choice",
      purpose: "meet",
      state: "open",
      owner: "sam",
      name: "",
    })

  it("asks one question at a time and sends both answers at the end", async () => {
    draw(open())
    expect(screen.getByText("What should I call you?")).toBeTruthy()
    expect(screen.getByText("1 / 2")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /sam/ }))
    expect(screen.getByText("Want to give me a name?")).toBeTruthy()
    // The name it goes by now: the default one while it has none.
    expect(screen.getByRole("button", { name: /Personal agent|Assistant/i }))
    fireEvent.click(screen.getByRole("button", { name: /Other/ }))
    fireEvent.change(screen.getByPlaceholderText("Write your own…"), {
      target: { value: "Gigi" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await waitFor(() =>
      expect(api.personalAgentChoiceAnswer).toHaveBeenCalledWith(
        12,
        { answers: [{ key: "A" }, { text: "Gigi" }] },
        null
      )
    )
  })

  it("skipped sends no answers; answered folds to one line", async () => {
    draw(open())
    fireEvent.click(screen.getByRole("button", { name: "Skip" }))
    await waitFor(() =>
      expect(api.personalAgentChoiceAnswer).toHaveBeenCalledWith(
        12,
        { answers: [] },
        null
      )
    )
    cleanup()
    draw(
      card({
        notice: "choice",
        purpose: "meet",
        state: "answered",
        owner: "sam",
        name: "",
        answer: { call: "Sam", name: "Gigi" },
      })
    )
    expect(screen.getByText("I'll call you “Sam”; I'm “Gigi”")).toBeTruthy()
  })
})

describe("one thing right away", () => {
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
  const open = () =>
    card({ notice: "onboarding", purpose: "connect", state: "open" })

  it("asks one question, nothing to pick, and finds one on its yes", async () => {
    api.personalAgentMeetProjects.mockResolvedValue(projects)
    draw(open())
    expect(
      screen.getByText(
        "I keep an eye on all your projects and tell you when a PR waits for your review."
      )
    ).toBeTruthy()
    expect(
      screen.getByText("Shall I find one thing I can help with right now?")
    ).toBeTruthy()
    expect(screen.queryByRole("checkbox")).toBeNull()
    // A watched project on a public forge with no account: one hint.
    await screen.findByText(
      "Connect your GitLab account and I can see PRs, CI and issues too."
    )
    fireEvent.click(screen.getByRole("button", { name: "Connect account" }))
    expect(api.openSettingsWindow).toHaveBeenCalledWith("version-control")
    // Projects there are: no folder to open.
    expect(
      screen.queryByRole("button", { name: "Open a project folder" })
    ).toBeNull()
    // The way to change them: the settings' page of them.
    fireEvent.click(screen.getByRole("button", { name: "Settings" }))
    expect(usePersonalAgentUi.getState().settings?.page).toBe("projects")
    fireEvent.click(screen.getByRole("button", { name: "Find one now" }))
    await waitFor(() =>
      expect(api.personalAgentStarter).toHaveBeenCalledWith(12, null)
    )
  })

  it("says the projects picked, and hints no account for one not watched or not a public forge", async () => {
    ctx.account = account({
      prefs: { ...DEFAULT_PREFS, projects: [1, 3, 4] },
    })
    api.personalAgentMeetProjects.mockResolvedValue(projects)
    draw(open())
    expect(
      screen.getByText(
        "I keep an eye on the projects you picked and tell you when a PR waits for your review."
      )
    ).toBeTruthy()
    await waitFor(() =>
      expect(api.personalAgentMeetProjects).toHaveBeenCalled()
    )
    // lib (GitLab, no account) is not watched; corp is Gitee: no hint.
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByRole("button", { name: "Connect account" })).toBeNull()
  })

  it("with no project, offers to open one — finding still answers — or not now", async () => {
    api.personalAgentMeetProjects.mockResolvedValue([])
    draw(open())
    await screen.findByText(
      "codeg has no project yet; open one and I'll keep an eye on it."
    )
    // Its buttons on the card's last band, under a hairline.
    expect(
      screen
        .getByRole("button", { name: "Not now" })
        .closest("[data-pa-sheet-actions]")
    ).not.toBeNull()
    fireEvent.click(
      screen.getByRole("button", { name: "Open a project folder" })
    )
    expect(screen.getByTestId("folder-dialog")).toBeTruthy()
    expect(
      screen
        .getByRole("button", { name: "Find one now" })
        .hasAttribute("disabled")
    ).toBe(false)
    fireEvent.click(screen.getByRole("button", { name: "Not now" }))
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(
        12,
        "skip",
        null,
        undefined
      )
    )
  })

  it("folds to a line once answered — and an old card still says which it connected", () => {
    draw(card({ notice: "onboarding", purpose: "connect", state: "connected" }))
    expect(screen.getByText("OK, looking now.")).toBeTruthy()
    cleanup()
    draw(card({ notice: "onboarding", purpose: "connect", state: "skipped" }))
    expect(screen.getByText("Not now, then. Ask me any time.")).toBeTruthy()
    cleanup()
    draw(
      card({
        notice: "onboarding",
        purpose: "connect",
        state: "connected",
        projects: [
          { id: 1, name: "app" },
          { id: 3, name: "notes" },
        ],
      })
    )
    expect(screen.getByText("Connected: app, notes")).toBeTruthy()
    expect(api.personalAgentMeetProjects).not.toHaveBeenCalled()
  })
})

describe("one thing at once", () => {
  const lead = {
    key: "pr:1:231",
    kind: "pr_ci",
    project: { id: 1, name: "app" },
    number: 231,
    title: "Speed up",
    url: "https://github.com/a/app/pull/231",
    checks: ["lint"],
  }

  it("is a card of its own, a lead handed over on its tone", () => {
    const found = draw(
      card({ notice: "starter", state: "found", lead, seen: [] })
    )
    const sheet = found.container.querySelector("[data-pa-card-message]")!
    expect(sheet.getAttribute("data-pa-meet")).toBe("starter")
    expect(sheet.closest(".pa-agent-bubble")).toBeNull()
    found.unmount()
    const handed = draw(
      card({ notice: "starter", state: "handed", lead, seen: [] })
    )
    expect(
      handed.container
        .querySelector("[data-pa-starter-lead]")
        ?.getAttribute("data-pa-outcome")
    ).toBe("done")
  })

  it("offers the lead, hands it over in the owner's words, moves on or lets it be", async () => {
    draw(card({ notice: "starter", state: "found", lead, seen: [] }))
    expect(
      screen.getByText("PR #231's CI is red (lint) — app: Speed up")
    ).toBeTruthy()
    expect(
      screen
        .getByRole("button", { name: "Hand it to me" })
        .closest("[data-pa-sheet-actions]")
    ).not.toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Hand it to me" }))
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenLastCalledWith(
        12,
        "hand",
        null,
        "Fix the CI of PR #231 in app: https://github.com/a/app/pull/231"
      )
    )
    fireEvent.click(screen.getByRole("button", { name: "Another one" }))
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenLastCalledWith(
        12,
        "next",
        null,
        undefined
      )
    )
    fireEvent.click(screen.getByRole("button", { name: "Not now" }))
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenLastCalledWith(
        12,
        "dismiss",
        null,
        undefined
      )
    )
  })

  it("says it keeps an eye on things when there is nothing to offer", () => {
    draw(card({ notice: "starter", state: "none", seen: [] }))
    expect(
      screen.getByText("Nothing is red right now; I'll keep an eye on it.")
    ).toBeTruthy()
    cleanup()
    draw(card({ notice: "starter", state: "none", seen: ["pr:1:231"] }))
    expect(
      screen.getByText("Nothing else right now; I'll keep an eye on it.")
    ).toBeTruthy()
    cleanup()
    draw(card({ notice: "starter", state: "looking", seen: [] }))
    expect(
      screen.getByText("Looking for one thing I can help with right away…")
    ).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Hand it to me" })).toBeNull()
  })

  it("words every kind of lead", () => {
    const t = (key: string, v?: Record<string, string | number>) =>
      `${key}|${JSON.stringify(v)}`
    for (const kind of ["pr_ci", "review", "issue", "task", "worktree"]) {
      expect(leadText({ ...lead, kind }, t)?.line).toContain(`lead.${kind}|`)
    }
    expect(leadText({ ...lead, kind: "other" }, t)).toBeNull()
  })
})

describe("what I'll do on my own", () => {
  const open = (data: Record<string, unknown> = {}) =>
    card({ notice: "onboarding", purpose: "promises", state: "open", ...data })
  /** Its switches, unfolded. */
  const unfold = () =>
    fireEvent.click(document.querySelector("[data-pa-meet-promises-toggle]")!)

  it("folds its switches under a line of how many are on, the line staying put as they open and close", () => {
    ctx.account = account({
      prefs: { ...DEFAULT_PREFS, brief: "off", followups: "ask" },
    })
    draw(open())
    const promises = document.querySelector("[data-pa-meet-promises]")!
    const toggle = promises.querySelector<HTMLElement>(
      "[data-pa-meet-promises-toggle]"
    )!
    expect(screen.queryByRole("switch")).toBeNull()
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    expect(toggle.textContent).toContain("What I do: 8 of 10 on")
    expect(toggle.textContent).toContain("Show")
    fireEvent.click(toggle)
    expect(toggle.getAttribute("aria-expanded")).toBe("true")
    expect(toggle.textContent).toContain("Hide")
    expect(promises.firstElementChild).toBe(toggle)
    expect(screen.getAllByRole("switch")).toHaveLength(10)
    fireEvent.click(toggle)
    expect(screen.queryByRole("switch")).toBeNull()
    expect(promises.firstElementChild).toBe(toggle)
  })

  it("sets how much it may disturb and each switch through the preferences", async () => {
    draw(open())
    unfold()
    fireEvent.click(screen.getByRole("radio", { name: "Fewer" }))
    await waitFor(() =>
      expect(api.personalAgentSettingsPatch).toHaveBeenLastCalledWith(
        [{ key: "prefs.disturb_level", value: "quiet" }],
        null
      )
    )
    const answer = screen.getByRole("switch", {
      name: /Answer the questions of the sessions I hand out/,
    })
    expect(answer.getAttribute("aria-checked")).toBe("true")
    fireEvent.click(answer)
    await waitFor(() =>
      expect(api.personalAgentSettingsPatch).toHaveBeenLastCalledWith(
        [{ key: "prefs.exec_questions", value: "owner" }],
        null
      )
    )
  })

  it("lists the brief, the wrap-up and fixing red pull requests, nothing left for later", async () => {
    ctx.account = account({
      prefs: { ...DEFAULT_PREFS, wrap: "ask" },
    })
    draw(open())
    unfold()
    expect(screen.queryByText(/join here as they arrive/)).toBeNull()
    // A wrap-up that asks first is still on.
    expect(
      screen
        .getByRole("switch", { name: /Wrap up your day/ })
        .getAttribute("aria-checked")
    ).toBe("true")
    const brief = screen.getByRole("switch", {
      name: /Write you a morning brief/,
    })
    expect(brief.getAttribute("aria-checked")).toBe("true")
    fireEvent.click(brief)
    await waitFor(() =>
      expect(api.personalAgentSettingsPatch).toHaveBeenLastCalledWith(
        [{ key: "prefs.brief", value: "off" }],
        null
      )
    )
    fireEvent.click(
      screen.getByRole("switch", {
        name: /Fix watched pull requests that go red/,
      })
    )
    await waitFor(() =>
      expect(api.personalAgentSettingsPatch).toHaveBeenLastCalledWith(
        [{ key: "prefs.ci_failure", value: "tell" }],
        null
      )
    )
  })

  it("lays its switches out as the settings do, each group a band of one card", () => {
    draw(open())
    unfold()
    // The level and the switches, each group a band, a row each.
    const level = document.querySelector("[data-pa-meet-level]")!
    const promises = document.querySelector("[data-pa-meet-promises]")!
    expect(level.className).toContain("divide-y")
    expect(promises.className).toContain("divide-y")
    expect(promises.querySelectorAll("[data-pa-promise]")).toHaveLength(10)
    // One card — no bubble round it, no card in a card: the groups bands
    // of it, their buttons their own colours.
    const card = level.closest("[data-pa-card-message]")!
    expect(card.closest(".pa-agent-bubble")).toBeNull()
    for (const group of [level, promises]) {
      expect(group.parentElement).toBe(card)
      expect(group.className).toContain("bg-transparent")
      expect(group.hasAttribute("data-pa-surface")).toBe(true)
    }
    // A row's title is its switch's label.
    const brief = promises.querySelector('[data-pa-promise="brief"]')!
    const label = brief.querySelector("label")!
    expect(label.getAttribute("for")).toBe(
      brief.querySelector('[role="switch"]')!.id
    )
    // The level is one segmented control, a radio group.
    expect(level.querySelector('[role="radiogroup"]')).not.toBeNull()
    // The ways on, secondary buttons, and [Done] at the end: the card's
    // last band.
    const actions = document.querySelector("[data-pa-meet-actions]")!
    expect(actions.hasAttribute("data-pa-sheet-actions")).toBe(true)
    expect(actions.parentElement).toBe(card)
    expect(card.lastElementChild).toBe(actions)
    const buttons = [...actions.querySelectorAll("button")]
    const last = buttons[buttons.length - 1]
    expect(last.hasAttribute("data-pa-meet-done")).toBe(true)
    expect(last.className).toContain("ms-auto")
    expect(
      buttons.filter((b) => b.getAttribute("data-variant") === "secondary")
    ).toHaveLength(buttons.length - 1)
  })

  it("opens the preferences and the companion, builds no team, and folds when done", async () => {
    const openSettings = vi.fn()
    usePersonalAgentUi.setState({ openSettings })
    draw(open())
    // No team made from templates: one is asked for in the conversation.
    expect(screen.queryByRole("button", { name: /team/i })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Adjust preferences" }))
    expect(openSettings).toHaveBeenCalledWith("proactive")
    fireEvent.click(
      screen.getByRole("button", { name: "Put me on the desktop" })
    )
    expect(pet.openPetWindow).toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Done" }))
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenLastCalledWith(
        12,
        "done",
        null,
        undefined
      )
    )
    cleanup()
    draw(open({ state: "done" }))
    expect(
      screen.getByText("What I'll do on my own · disturbance: Standard")
    ).toBeTruthy()
    expect(screen.queryByRole("switch")).toBeNull()
  })
})
