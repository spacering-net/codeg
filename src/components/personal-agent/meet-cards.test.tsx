/**
 * Getting to know the owner (5.4, 1.15): the cards after the primary's
 * brain is first picked, as the owner answers them.
 */
import {
  act,
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

describe("the projects", () => {
  const projects = [
    {
      id: 1,
      name: "app",
      path: "/p/app",
      provider: "github",
      host: "github.com",
      account: true,
    },
    {
      id: 2,
      name: "lib",
      path: "/p/lib",
      provider: "gitlab",
      host: "gitlab.com",
      account: false,
    },
    {
      id: 3,
      name: "notes",
      path: "/p/notes",
      provider: null,
      host: null,
      account: false,
    },
  ]
  const open = () =>
    card({ notice: "onboarding", purpose: "connect", state: "open" })

  it("lists the projects, ticks those with an account, and connects the ticked ones", async () => {
    api.personalAgentMeetProjects.mockResolvedValue(projects)
    draw(open())
    expect(
      screen.getByText(
        "While you're away, I keep an eye on the work I handed out and on your PRs."
      )
    ).toBeTruthy()
    await screen.findByText("app")
    expect(screen.getByText("On GitHub")).toBeTruthy()
    expect(screen.getByText("On GitLab, no account connected")).toBeTruthy()
    expect(screen.getByText("No code host")).toBeTruthy()
    // Only the one whose forge has no account offers to connect one.
    const connectAccount = screen.getAllByRole("button", {
      name: "Connect account",
    })
    expect(connectAccount).toHaveLength(1)
    fireEvent.click(connectAccount[0])
    expect(api.openSettingsWindow).toHaveBeenCalledWith("version-control")

    fireEvent.click(screen.getByRole("checkbox", { name: /notes/ }))
    fireEvent.click(screen.getByRole("button", { name: "Connect 2 projects" }))
    await waitFor(() =>
      expect(api.personalAgentStarter).toHaveBeenCalledWith(12, [1, 3], null)
    )
  })

  it("can be skipped, and opens a folder", async () => {
    api.personalAgentMeetProjects.mockResolvedValue([])
    draw(open())
    await screen.findByText("codeg has no project open yet.")
    fireEvent.click(
      screen.getByRole("button", { name: "Open a project folder" })
    )
    expect(screen.getByTestId("folder-dialog")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Skip" }))
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenCalledWith(
        12,
        "skip",
        null,
        undefined
      )
    )
  })

  it("says which were connected once it is answered", () => {
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

  it("offers the lead, hands it over in the owner's words, moves on or lets it be", async () => {
    draw(card({ notice: "starter", state: "found", lead, seen: [] }))
    expect(
      screen.getByText("PR #231's CI is red (lint) — app: Speed up")
    ).toBeTruthy()
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

  it("sets how much it may disturb and each switch through the preferences", async () => {
    draw(open())
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

  it("lays its switches out as the settings do, each group and its actions a card", () => {
    draw(open())
    // The level and the switches, each group on one surface, a row each.
    const level = document.querySelector("[data-pa-meet-level]")!
    const promises = document.querySelector("[data-pa-meet-promises]")!
    expect(level.className).toContain("divide-y")
    expect(promises.className).toContain("divide-y")
    expect(promises.querySelectorAll("[data-pa-promise]")).toHaveLength(10)
    // White cards on the bubble, their buttons their own colours.
    for (const card of [level, promises]) {
      expect(card.className).toContain("bg-card")
      expect(card.hasAttribute("data-pa-surface")).toBe(true)
    }
    // A row's title is its switch's label.
    const brief = promises.querySelector('[data-pa-promise="brief"]')!
    const label = brief.querySelector("label")!
    expect(label.getAttribute("for")).toBe(
      brief.querySelector('[role="switch"]')!.id
    )
    // The level is one segmented control, a radio group.
    expect(level.querySelector('[role="radiogroup"]')).not.toBeNull()
    // The ways on, secondary buttons, and [Done] at the end, on a card.
    const actions = document.querySelector("[data-pa-meet-actions]")!
    expect(actions.className).toContain("bg-card")
    expect(actions.hasAttribute("data-pa-surface")).toBe(true)
    const buttons = [...actions.querySelectorAll("button")]
    const last = buttons[buttons.length - 1]
    expect(last.hasAttribute("data-pa-meet-done")).toBe(true)
    expect(last.className).toContain("ms-auto")
    expect(
      buttons.filter((b) => b.getAttribute("data-variant") === "secondary")
    ).toHaveLength(buttons.length - 1)
  })

  it("suggests a team once, opens the preferences and the companion, and folds when done", async () => {
    const openSettings = vi.fn()
    usePersonalAgentUi.setState({ openSettings })
    draw(open())
    fireEvent.click(screen.getByRole("button", { name: "Build a team" }))
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenLastCalledWith(
        12,
        "team",
        null,
        undefined
      )
    )
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
    draw(open({ team: 77 }))
    expect(
      (
        screen.getByRole("button", {
          name: "Team suggested",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true)
    cleanup()
    draw(open({ state: "done" }))
    expect(
      screen.getByText("What I'll do on my own · disturbance: Standard")
    ).toBeTruthy()
    expect(screen.queryByRole("switch")).toBeNull()
  })
})

describe("a team suggested", () => {
  it("makes the ones ticked", async () => {
    draw(
      card({
        notice: "changed",
        what: "bots",
        why: "suggest",
        state: "open",
        bots: [],
        pending: {
          team: [
            { name: "Developer", template: "dev" },
            { name: "Reviewer", template: "review" },
            { name: "CI fixer", template: "ci" },
          ],
          projects: ["app"],
        },
      })
    )
    expect(screen.getByText("For app")).toBeTruthy()
    fireEvent.click(screen.getByRole("checkbox", { name: "Reviewer" }))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Make 2 assistants" }))
    })
    await waitFor(() =>
      expect(api.personalAgentNoticeAct).toHaveBeenLastCalledWith(
        12,
        "accept:dev,ci",
        null
      )
    )
  })
})
