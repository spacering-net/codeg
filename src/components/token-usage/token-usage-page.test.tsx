import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { act } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import en from "@/i18n/messages/en.json"
import type { TokenUsageReport } from "@/lib/types"
import { TokenUsagePage } from "./token-usage-page"

const h = vi.hoisted(() => ({
  report: vi.fn(),
  facets: vi.fn(),
  sync: vi.fn(),
  staleConversations: 0,
  handlers: new Map<string, (payload: unknown) => void>(),
  agents: [] as { agent_type: string; name: string; enabled: boolean }[],
}))

vi.mock("@/lib/api", () => ({
  tokenUsageReport: h.report,
  tokenUsageFacets: h.facets,
  tokenUsageStatus: async () => ({
    total_conversations: 3,
    synced_conversations: 3,
    stale_conversations: h.staleConversations,
    fact_rows: 1,
    last_synced_at: null,
    running: false,
  }),
  tokenUsageSync: h.sync,
  opencodeProviderCatalog: async () => [],
}))
vi.mock("@/hooks/use-acp-agents", () => ({
  useAcpAgents: () => ({ agents: h.agents, fresh: true, refresh: vi.fn() }),
}))
vi.mock("@/lib/platform", () => ({
  subscribe: async (event: string, handler: (payload: unknown) => void) => {
    h.handlers.set(event, handler)
    return () => {
      if (h.handlers.get(event) === handler) h.handlers.delete(event)
    }
  },
}))
vi.mock("./charts", async () => ({
  ...(await vi.importActual<typeof import("./charts")>("./charts")),
  ActivityHeatmap: () => null,
  RingMeter: () => null,
  TrendChart: () => null,
}))

const report: TokenUsageReport = {
  range_start: null,
  range_end: null,
  bucket: "day",
  totals: {
    input_tokens: 100,
    output_tokens: 20,
    cache_creation_tokens: 10,
    cache_read_tokens: 70,
    total_tokens: 200,
    turn_count: 1,
    conversation_count: 3,
    duration_ms: 1000,
    active_days: 1,
  },
  previous_totals: null,
  series: [],
  by_folder: [],
  by_agent: [],
  by_model: [],
  heatmap: [],
  top_conversations: [],
  streak: { longest_days: 1, current_days: 1, current_ends_on: null },
  first_activity_at: null,
  last_activity_at: null,
  truncated: false,
}

function page() {
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      <TokenUsagePage />
    </NextIntlClientProvider>
  )
}

describe("Token Usage agent filter", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.agents = [
      { agent_type: "claude_code", name: "Claude Code", enabled: true },
      { agent_type: "codex", name: "Codex CLI", enabled: true },
      {
        agent_type: "custom:claude-code-2",
        name: "Claude Code 2",
        enabled: true,
      },
      {
        agent_type: "custom:claude-code-3",
        name: "Review account",
        enabled: true,
      },
      {
        agent_type: "custom:unused-disabled",
        name: "Disabled account",
        enabled: false,
      },
    ]
    h.report.mockResolvedValue(report)
    // Registered accounts without usage, and deleted registrations with
    // history, must both remain reachable in the same filter.
    h.facets.mockResolvedValue({
      folders: [],
      agents: ["claude_code", "custom:retired-reviewer"],
      models: [],
      data_start: null,
      data_end: null,
    })
  })

  it("includes configured custom accounts and submits their exact IDs", async () => {
    const user = userEvent.setup()
    render(page())
    await waitFor(() => expect(h.report).toHaveBeenCalled())
    await user.click(
      await screen.findByRole("button", {
        name: en.TokenUsage.agentFilter,
        expanded: false,
      })
    )
    const menu = within(screen.getByRole("dialog"))
    expect(menu.getByRole("button", { name: "Codex" })).toBeTruthy()
    expect(menu.getByRole("button", { name: "Claude Code 2" })).toBeTruthy()
    expect(menu.getByRole("button", { name: "Retired Reviewer" })).toBeTruthy()
    expect(menu.queryByRole("button", { name: "Disabled account" })).toBeNull()
    await user.click(menu.getByRole("button", { name: "Review account" }))
    await waitFor(() =>
      expect(h.report).toHaveBeenLastCalledWith(
        expect.objectContaining({ agentTypes: ["custom:claude-code-3"] })
      )
    )
  })

  it("updates custom names while open and keeps a selection after its registration disappears", async () => {
    const user = userEvent.setup()
    const view = render(page())
    await user.click(
      await screen.findByRole("button", {
        name: en.TokenUsage.agentFilter,
        expanded: false,
      })
    )
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Review account",
      })
    )
    await waitFor(() =>
      expect(h.report).toHaveBeenLastCalledWith(
        expect.objectContaining({ agentTypes: ["custom:claude-code-3"] })
      )
    )
    h.agents = h.agents.map((agent) =>
      agent.agent_type === "custom:claude-code-3"
        ? { ...agent, name: "Renamed account" }
        : agent
    )
    view.rerender(page())
    expect(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Renamed account",
      })
    ).toHaveAttribute("aria-pressed", "true")
    h.agents = h.agents.filter(
      (agent) => agent.agent_type !== "custom:claude-code-3"
    )
    view.rerender(page())
    expect(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Claude Code 3",
      })
    ).toHaveAttribute("aria-pressed", "true")
  })

  it("refreshes the rendered agent breakdown after a registration is renamed", async () => {
    h.report.mockResolvedValue({
      ...report,
      by_agent: [
        {
          ...report.totals,
          key: "custom:claude-code-3",
          label: "custom:claude-code-3",
        },
      ],
    })
    const user = userEvent.setup()
    const view = render(page())
    await user.click(
      await screen.findByRole("button", { name: en.TokenUsage.byAgentTitle })
    )
    expect(await screen.findByText("Review account")).toBeInTheDocument()

    h.agents = h.agents.map((agent) =>
      agent.agent_type === "custom:claude-code-3"
        ? { ...agent, name: "Renamed reviewer" }
        : agent
    )
    view.rerender(page())
    expect(screen.getByText("Renamed reviewer")).toBeInTheDocument()
    expect(screen.queryByText("Review account")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /Renamed reviewer/ }))
    await waitFor(() =>
      expect(h.report).toHaveBeenLastCalledWith(
        expect.objectContaining({ agentTypes: ["custom:claude-code-3"] })
      )
    )
  })
})

describe("Token Usage time range", () => {
  const syncResult = { scanned: 1, synced: 1, skipped: 0, failed: 0, lost: 0 }

  beforeEach(() => {
    vi.clearAllMocks()
    h.handlers.clear()
    h.agents = []
    h.staleConversations = 0
    h.report.mockResolvedValue(report)
    h.facets.mockResolvedValue({
      folders: [],
      agents: [],
      models: [],
      data_start: null,
      data_end: null,
    })
    // Only the clock is faked — timers stay real so testing-library's
    // polling and the mocked promises run normally.
    vi.useFakeTimers({ toFake: ["Date"] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("opens on the last 24 hours, charted by the hour", async () => {
    vi.setSystemTime(new Date(2026, 7, 3, 13, 20))
    render(page())
    await waitFor(() =>
      expect(h.report).toHaveBeenLastCalledWith(
        expect.objectContaining({
          start: new Date(2026, 7, 2, 14).toISOString(),
          end: new Date(2026, 7, 3, 14).toISOString(),
          bucket: "hour",
        })
      )
    )
  })

  it("keeps the advanced window when a sync finishes after the hour rolls", async () => {
    // A sync broadcast that lands past the hour must move the window — and the
    // sync command resolving afterwards must not pull it back.
    h.staleConversations = 1
    let finishSync!: (r: typeof syncResult) => void
    h.sync.mockImplementation(
      () => new Promise((resolve) => (finishSync = resolve))
    )
    vi.setSystemTime(new Date(2026, 7, 3, 13, 59))
    render(page())
    // The page auto-syncs because the status reports stale conversations.
    await waitFor(() => expect(h.sync).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(h.handlers.has("token-usage-sync://progress")).toBe(true)
    )

    vi.setSystemTime(new Date(2026, 7, 3, 14, 1))
    act(() => {
      h.handlers.get("token-usage-sync://progress")!({
        done: 1,
        total: 1,
        current_title: null,
        result: syncResult,
      })
    })
    const advanced = expect.objectContaining({
      end: new Date(2026, 7, 3, 15).toISOString(),
    })
    await waitFor(() => expect(h.report).toHaveBeenLastCalledWith(advanced))

    await act(async () => {
      finishSync(syncResult)
    })
    await waitFor(() => expect(h.sync).toHaveBeenCalledTimes(1))
    // Every request issued after the clock moved targets the new window.
    const calls: string[] = h.report.mock.calls.map((c) => c[0].end)
    const last = calls[calls.length - 1]
    expect(last).toBe(new Date(2026, 7, 3, 15).toISOString())
    expect(calls).not.toContain(undefined)
    const afterAdvance = calls.slice(
      calls.indexOf(new Date(2026, 7, 3, 15).toISOString())
    )
    expect(afterAdvance.every((e) => e === last)).toBe(true)
  })
})
