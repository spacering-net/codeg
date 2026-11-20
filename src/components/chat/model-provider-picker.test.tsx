import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  clearModelProviderDraftSelection,
  clearModelProviderSelectionWriteInFlight,
  markModelProviderSelectionWriteInFlight,
  resetModelProviderSelectionStore,
  setModelProviderDraftSelection,
} from "@/stores/model-provider-selection-store"
import {
  loadRememberedAgentModelSelection,
  rememberAgentModelSelection,
} from "@/lib/remembered-agent-model-selection"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"

import { ModelProviderPicker } from "./model-provider-picker"
import enMessages from "@/i18n/messages/en.json"
import type { ModelProviderRecord } from "@/lib/model-provider-types"
import type { AgentType, DbConversationSummary } from "@/lib/types"

const reapplyConfig = vi.fn(async () => true)
vi.mock("@/hooks/use-connection", () => ({
  useConnection: () => ({
    isViewer: false,
    status: "connected",
    reapplyConfig,
  }),
}))
vi.mock("@/hooks/use-model-providers", () => ({
  useModelProviders: () => ({
    records: recordsFixture(),
    fresh: true,
    refresh: vi.fn(),
  }),
}))
vi.mock("@/hooks/use-acp-agents", () => ({
  useAcpAgents: () => ({
    agents: [{ agent_type: "claude_code", model_source: "provider" }],
    fresh: true,
    refresh: vi.fn(),
  }),
}))
let tabStoreState: {
  tabs: Array<{ id: string; conversationId: number | null }>
} = { tabs: [{ id: "tab-1", conversationId: 42 }] }
vi.mock("@/stores/tab-store", () => ({
  useTabStore: (selector: (s: unknown) => unknown) => selector(tabStoreState),
}))
vi.mock("@/stores/app-workspace-store", async () => {
  const { create } = await import("zustand")
  const store = create<{
    conversations: Array<Record<string, unknown>>
    applyConversationUpsert: (summary: Record<string, unknown>) => void
    refreshConversations: () => Promise<void>
  }>(() => ({
    conversations: [
      {
        id: 42,
        model_source: "provider",
        model_provider_id: "anthropic",
        model_provider_model_id: "claude-sonnet-4-5",
        model: "claude-sonnet-4-5",
      },
    ],
    applyConversationUpsert: (summary) =>
      store.setState((s) => ({
        conversations: s.conversations.map((c) =>
          (c.id as number) === summary.id ? summary : c
        ),
      })),
    refreshConversations: vi.fn(),
  }))
  return { useAppWorkspaceStore: store }
})
const updateSelection = vi.fn()
const rememberAgentSelection = vi.fn<(...args: unknown[]) => Promise<void>>(
  async () => {}
)
const openSettingsWindow = vi.fn<(...args: unknown[]) => Promise<void>>(
  async () => {}
)
vi.mock("@/lib/api", () => ({
  updateConversationModelSelection: (...args: unknown[]) =>
    updateSelection(...args),
  acpRememberAgentModelSelection: (...args: unknown[]) =>
    rememberAgentSelection(...args),
  openSettingsWindow: (...args: unknown[]) => openSettingsWindow(...args),
}))

function recordsFixture(): ModelProviderRecord[] {
  return [
    {
      providerId: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      enabled: true,
      apiKeyMasked: "",
      hasApiKey: true,
      compatSupportsDeveloperRole: null,
      models: [
        {
          id: "claude-sonnet-4-5",
          reasoning: false,
          input: "text",
          contextWindow: "200000",
        },
        { id: "claude-opus-4-5", reasoning: true, input: "text-image" },
      ],
    },
    // Enabled but incompatible with claude_code (openai family) — must not show.
    {
      providerId: "openai",
      api: "openai-completions",
      baseUrl: "https://api.openai.com/v1",
      enabled: true,
      apiKeyMasked: "",
      hasApiKey: true,
      compatSupportsDeveloperRole: null,
      models: [{ id: "gpt-5.1", reasoning: false, input: "text" }],
    },
    // Disabled — must not show even though the API family matches.
    {
      providerId: "deepseek",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com/v1",
      enabled: false,
      apiKeyMasked: "",
      hasApiKey: true,
      compatSupportsDeveloperRole: null,
      models: [{ id: "deepseek-chat", reasoning: false, input: "text" }],
    },
  ]
}

function renderPicker(
  overrides: { agentType?: AgentType; tabId?: string } = {}
) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ModelProviderPicker
        agentType={overrides.agentType ?? "claude_code"}
        tabId={overrides.tabId ?? "tab-1"}
      />
    </NextIntlClientProvider>
  )
}

function conversationSummary(id: number): DbConversationSummary {
  return {
    id,
    folder_id: 1,
    title: null,
    title_locked: false,
    agent_type: "claude_code",
    status: "pending",
    kind: "regular",
    model: null,
    git_branch: null,
    external_id: null,
    message_count: 0,
    child_count: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    pinned_at: null,
  }
}
const boundConversationRow: DbConversationSummary = {
  ...conversationSummary(42),
  model_source: "provider",
  model_provider_id: "anthropic",
  model_provider_model_id: "claude-sonnet-4-5",
  model: "claude-sonnet-4-5",
}

describe("ModelProviderPicker", () => {
  beforeEach(() => {
    updateSelection.mockReset()
    rememberAgentSelection.mockReset()
    rememberAgentSelection.mockResolvedValue(undefined)
    openSettingsWindow.mockClear()
    reapplyConfig.mockClear()
    resetModelProviderSelectionStore()
    localStorage.clear()
    tabStoreState = { tabs: [{ id: "tab-1", conversationId: 42 }] }
    useAppWorkspaceStore.setState({ conversations: [boundConversationRow] })
  })

  it("shows the conversation's current provider · model selection", async () => {
    renderPicker()
    const trigger = await screen.findByRole("button", {
      name: "Model provider",
    })
    expect(
      within(trigger).getByText("anthropic · claude-sonnet-4-5")
    ).toBeInTheDocument()
  })

  it("lists compatible enabled providers fully expanded and saves a new choice", async () => {
    renderPicker()
    const trigger = await screen.findByRole("button", {
      name: "Model provider",
    })
    fireEvent.click(trigger)

    // Anthropic models are visible without expanding; the incompatible OpenAI
    // provider and the disabled DeepSeek provider are absent.
    expect(screen.getByText("claude-sonnet-4-5")).toBeInTheDocument()
    expect(screen.getByText("claude-opus-4-5")).toBeInTheDocument()
    expect(screen.queryByText("gpt-5.1")).not.toBeInTheDocument()
    expect(screen.queryByText("deepseek-chat")).not.toBeInTheDocument()

    fireEvent.click(screen.getByText("claude-opus-4-5"))
    expect(updateSelection).toHaveBeenCalledWith(
      42,
      "anthropic",
      "claude-opus-4-5"
    )
    await vi.waitFor(() => {
      expect(reapplyConfig).toHaveBeenCalledTimes(1)
    })
    expect(reapplyConfig).toHaveBeenCalledWith(42)
  })

  it("keeps a pre-bind selection across remounts and remembers it on the agent", async () => {
    tabStoreState = { tabs: [{ id: "tab-1", conversationId: null }] }
    const { unmount } = renderPicker()
    fireEvent.click(
      await screen.findByRole("button", { name: "Model provider" })
    )
    fireEvent.click(screen.getByText("claude-opus-4-5"))
    expect(
      within(screen.getByRole("button", { name: "Model provider" })).getByText(
        "anthropic · claude-opus-4-5"
      )
    ).toBeInTheDocument()
    // No conversation exists yet, so nothing can be saved to one…
    expect(updateSelection).not.toHaveBeenCalled()
    // …but the choice is remembered on the AGENT: the pre-bind session needs
    // credentials to start at all (an agent that refuses `session/new`
    // unauthenticated cannot be configured any other way).
    await vi.waitFor(() => {
      expect(rememberAgentSelection).toHaveBeenCalledWith(
        "claude_code",
        "anthropic",
        "claude-opus-4-5"
      )
    })

    unmount()
    renderPicker()
    expect(
      within(screen.getByRole("button", { name: "Model provider" })).getByText(
        "anthropic · claude-opus-4-5"
      )
    ).toBeInTheDocument()
  })

  it("opens the model providers settings page from the picker footer", async () => {
    renderPicker()
    fireEvent.click(
      await screen.findByRole("button", { name: "Model provider" })
    )
    fireEvent.click(screen.getByText("Configure model providers"))
    expect(openSettingsWindow).toHaveBeenCalledWith("model-providers")
  })

  it("saving a choice on a bound conversation remembers it per agent", async () => {
    renderPicker()
    fireEvent.click(
      await screen.findByRole("button", { name: "Model provider" })
    )
    fireEvent.click(screen.getByText("claude-opus-4-5"))

    await vi.waitFor(() => {
      expect(loadRememberedAgentModelSelection("claude_code")).toEqual({
        providerId: "anthropic",
        modelId: "claude-opus-4-5",
      })
    })
  })

  it("restores the remembered choice on a new draft when it still exists", async () => {
    rememberAgentModelSelection("claude_code", {
      providerId: "anthropic",
      modelId: "claude-opus-4-5",
    })
    tabStoreState = { tabs: [{ id: "tab-1", conversationId: null }] }

    renderPicker()

    expect(
      within(screen.getByRole("button", { name: "Model provider" })).getByText(
        "anthropic · claude-opus-4-5"
      )
    ).toBeInTheDocument()
    expect(updateSelection).not.toHaveBeenCalled()
  })

  it("falls back to the first provider's first model when the remembered choice no longer exists", async () => {
    // The remembered model was removed from the (still enabled) provider.
    rememberAgentModelSelection("claude_code", {
      providerId: "anthropic",
      modelId: "ghost-model",
    })
    tabStoreState = { tabs: [{ id: "tab-1", conversationId: null }] }

    renderPicker()

    const trigger = screen.getByRole("button", { name: "Model provider" })
    await vi.waitFor(() => {
      expect(
        within(trigger).getByText("anthropic · claude-sonnet-4-5")
      ).toBeInTheDocument()
    })
    // A fallback default is not a user choice — nothing is saved anywhere.
    expect(updateSelection).not.toHaveBeenCalled()
    expect(rememberAgentSelection).not.toHaveBeenCalled()
  })

  it("seeds a pre-bind composer with no remembered choice to the first provider's first model", async () => {
    tabStoreState = { tabs: [{ id: "tab-1", conversationId: null }] }

    renderPicker()

    const trigger = await screen.findByRole("button", {
      name: "Model provider",
    })
    await vi.waitFor(() => {
      expect(
        within(trigger).getByText("anthropic · claude-sonnet-4-5")
      ).toBeInTheDocument()
    })
    // Draft-only seed: persisted when the conversation binds, never pushed
    // to the agent or a conversation on its own.
    expect(updateSelection).not.toHaveBeenCalled()
    expect(rememberAgentSelection).not.toHaveBeenCalled()
  })

  it("defaults a bound conversation with no selection to the first provider's first model and saves it", async () => {
    useAppWorkspaceStore.setState({
      conversations: [{ ...conversationSummary(42), model_source: "provider" }],
    })

    renderPicker()

    const trigger = await screen.findByRole("button", {
      name: "Model provider",
    })
    await vi.waitFor(() => {
      expect(updateSelection).toHaveBeenCalledWith(
        42,
        "anthropic",
        "claude-sonnet-4-5"
      )
    })
    await vi.waitFor(() => {
      expect(
        within(trigger).getByText("anthropic · claude-sonnet-4-5")
      ).toBeInTheDocument()
    })
  })

  it("holds the auto-default while a draft choice is being written to the bound conversation", async () => {
    // A freshly created conversation: bound, but the pre-bind choice is still
    // being persisted (applyDraftModelSelection marked the write in flight).
    useAppWorkspaceStore.setState({
      conversations: [{ ...conversationSummary(42), model_source: "provider" }],
    })
    markModelProviderSelectionWriteInFlight("tab-1")

    renderPicker()

    const trigger = await screen.findByRole("button", {
      name: "Model provider",
    })
    // The selection-less row is a write in progress, not "no choice was ever
    // made" — the slot stays on the placeholder and nothing is auto-saved.
    expect(within(trigger).getByText("Provider · Model")).toBeInTheDocument()
    expect(updateSelection).not.toHaveBeenCalled()

    // The marker is a window, not a latch: once released with the row still
    // selection-less, the auto-default proceeds as it would for any
    // never-configured conversation.
    act(() => {
      clearModelProviderSelectionWriteInFlight("tab-1")
      useAppWorkspaceStore.setState({
        conversations: [
          { ...conversationSummary(42), model_source: "provider" },
        ],
      })
    })
    await vi.waitFor(() => {
      expect(updateSelection).toHaveBeenCalledWith(
        42,
        "anthropic",
        "claude-sonnet-4-5"
      )
    })
  })

  it("does not override an explicit draft choice with the remembered one", async () => {
    setModelProviderDraftSelection("tab-1", {
      providerId: "anthropic",
      modelId: "claude-sonnet-4-5",
    })
    rememberAgentModelSelection("claude_code", {
      providerId: "anthropic",
      modelId: "claude-opus-4-5",
    })
    tabStoreState = { tabs: [{ id: "tab-1", conversationId: null }] }

    renderPicker()

    expect(
      within(screen.getByRole("button", { name: "Model provider" })).getByText(
        "anthropic · claude-sonnet-4-5"
      )
    ).toBeInTheDocument()
  })

  it("restores the new agent's memory when the draft agent switches", async () => {
    rememberAgentModelSelection("claude_code", {
      providerId: "anthropic",
      modelId: "claude-opus-4-5",
    })
    rememberAgentModelSelection("pi", {
      providerId: "anthropic",
      modelId: "claude-sonnet-4-5",
    })
    tabStoreState = { tabs: [{ id: "tab-1", conversationId: null }] }

    const { rerender } = renderPicker({ agentType: "claude_code" })
    expect(
      within(screen.getByRole("button", { name: "Model provider" })).getByText(
        "anthropic · claude-opus-4-5"
      )
    ).toBeInTheDocument()

    // The composer's agent switch handler clears the old draft before the
    // picker sees the new agent; mirror that here.
    act(() => clearModelProviderDraftSelection("tab-1"))
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ModelProviderPicker agentType="pi" tabId="tab-1" />
      </NextIntlClientProvider>
    )

    expect(
      within(screen.getByRole("button", { name: "Model provider" })).getByText(
        "anthropic · claude-sonnet-4-5"
      )
    ).toBeInTheDocument()
  })
})
