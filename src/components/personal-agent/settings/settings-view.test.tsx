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
import type {
  PersonalAgentAccount,
  PersonalAgentPrefs,
  PersonalAgentSnapshot,
} from "@/lib/types"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

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

import { SettingsView } from "./settings-view"

const PREFS: PersonalAgentPrefs = {
  reply_length: "medium",
  cards: "prefer",
  when_unsure: "assume",
  chat_changes: "apply",
  confirm_dispatch: "never",
  followups: "auto",
  messages: "auto",
  worker_handoff: "message",
  loop_rounds: 3,
  interrupt_retry: "auto",
  retry_rounds: 2,
  exec_questions: "assistant",
  exec_plans: "assistant",
}

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
      "communication",
      "automation",
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
})
