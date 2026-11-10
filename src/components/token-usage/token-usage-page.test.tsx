import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import en from "@/i18n/messages/en.json"
import type { TokenUsageReport } from "@/lib/types"
import { TokenUsagePage } from "./token-usage-page"

const h = vi.hoisted(() => ({
  report: vi.fn(),
  facets: vi.fn(),
  agents: [] as { agent_type: string; name: string; enabled: boolean }[],
}))

vi.mock("@/lib/api", () => ({
  tokenUsageReport: h.report,
  tokenUsageFacets: h.facets,
  tokenUsageStatus: async () => ({
    total_conversations: 3,
    synced_conversations: 3,
    stale_conversations: 0,
    fact_rows: 1,
    last_synced_at: null,
    running: false,
  }),
  tokenUsageSync: vi.fn(),
  opencodeProviderCatalog: async () => [],
}))
vi.mock("@/hooks/use-acp-agents", () => ({
  useAcpAgents: () => ({ agents: h.agents, fresh: true, refresh: vi.fn() }),
}))
vi.mock("@/lib/platform", () => ({ subscribe: async () => () => {} }))
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
