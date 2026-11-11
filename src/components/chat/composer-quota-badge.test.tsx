/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AgentQuotaInfo } from "@/lib/types"
import enMessages from "@/i18n/messages/en.json"

const mockGetAgentQuota = vi.fn()
const mockRefreshAgentQuota = vi.fn()

let mockConnState: { status: string; agentType: string } | undefined = undefined
let mockTabAgentType: string | null = null
const mockConnSubscribers = new Set<() => void>()

const mockConnectionStore = {
  subscribeKey: (_tabId: string, cb: () => void) => {
    mockConnSubscribers.add(cb)
    return () => {
      mockConnSubscribers.delete(cb)
    }
  },
  getConnection: () => mockConnState,
  getConnectPending: () => undefined,
  getConnectError: () => undefined,
}

vi.mock("@/lib/api", () => ({
  getAgentQuota: (...args: unknown[]) => mockGetAgentQuota(...args),
  refreshAgentQuota: (...args: unknown[]) => mockRefreshAgentQuota(...args),
}))

vi.mock("@/contexts/acp-connections-context", () => ({
  useConnectionStore: () => mockConnectionStore,
}))

vi.mock("@/contexts/tab-context", () => ({
  useTabStore: (
    selector: (s: {
      tabs: Array<{ id: string; agentType: string | null }>
    }) => unknown
  ) =>
    selector({
      tabs: [{ id: "tab-1", agentType: mockTabAgentType }],
    }),
}))

import {
  ComposerQuotaBadge,
  isQuotaSupportedAgent,
  pickBindingWindow,
  resetQuotaCache,
} from "./composer-quota-badge"
import {
  isDraftOfficialSubscriptionMode,
  isQuotaProbeCapableAgent,
  quotaProbeEnabledForDraft,
  setQuotaProbeMode,
  type QuotaDraftSlice,
} from "@/components/settings/acp-agent-settings"

function renderWithIntl(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

function makeSampleQuota(agentType = "codex"): AgentQuotaInfo {
  return {
    agentType,
    planName: "Plus",
    shortWindow: {
      label: "5h Window",
      usedPercent: 24,
      remainingPercent: 76,
      resetsAt: null,
      resetInSeconds: 5400,
    },
    weeklyWindow: {
      label: "7d Window",
      usedPercent: 42,
      remainingPercent: 58,
      resetsAt: null,
      resetInSeconds: 172800,
    },
    spendLimit: null,
    modelQuotas: [],
    lastUpdated: new Date().toISOString(),
  }
}

function baseDraft(overrides: Partial<QuotaDraftSlice> = {}): QuotaDraftSlice {
  return {
    envText: "",
    modelProviderId: null,
    apiKey: "",
    apiBaseUrl: "",
    claudeAuthMode: "official_subscription",
    codexAuthMode: "chatgpt_subscription",
    geminiAuthMode: "login_google",
    grokAuthMode: "subscription",
    clineProvider: "cline",
    ...overrides,
  }
}

describe("ComposerQuotaBadge", () => {
  beforeEach(() => {
    resetQuotaCache()
    mockGetAgentQuota.mockReset()
    mockRefreshAgentQuota.mockReset()
    mockConnSubscribers.clear()
    mockConnState = undefined
    mockTabAgentType = null
  })

  afterEach(() => {
    cleanup()
  })

  it("recognizes codex, antigravity, and custom antigravity agents", () => {
    expect(isQuotaSupportedAgent("codex")).toBe(true)
    expect(isQuotaSupportedAgent("antigravity")).toBe(true)
    expect(isQuotaSupportedAgent("custom:antigravity-b")).toBe(true)
    expect(isQuotaSupportedAgent("custom:agy-work")).toBe(true)
    expect(isQuotaSupportedAgent("open_code")).toBe(false)
    expect(isQuotaSupportedAgent(null)).toBe(false)
  })

  it("does not render for unsupported agents", () => {
    mockConnState = { status: "connected", agentType: "open_code" }
    mockTabAgentType = "open_code"
    const { container } = renderWithIntl(<ComposerQuotaBadge tabId="tab-1" />)
    expect(container.firstChild).toBeNull()
    expect(mockGetAgentQuota).not.toHaveBeenCalled()
  })

  it("renders binding remaining percentage and popover windows for connected Codex session", async () => {
    mockConnState = { status: "connected", agentType: "codex" }
    mockTabAgentType = "codex"
    mockGetAgentQuota.mockResolvedValueOnce(makeSampleQuota("codex"))

    const { getByRole, getByText } = renderWithIntl(
      <ComposerQuotaBadge tabId="tab-1" />
    )

    await waitFor(() => {
      expect(mockGetAgentQuota).toHaveBeenCalledWith("codex")
    })

    const trigger = await waitFor(() =>
      getByRole("button", { name: "View agent quota" })
    )
    await waitFor(() => {
      // Weekly window has 58% remaining (< 76%), so it is the binding window
      expect(trigger.textContent).toContain("7d: 58%")
    })

    fireEvent.click(trigger)
    await waitFor(() => {
      expect(getByText("5h Window")).toBeTruthy()
      expect(getByText("7d Window")).toBeTruthy()
    })
  })

  it("hides badge when backend reports quota probing is disabled", async () => {
    mockConnState = { status: "connected", agentType: "codex" }
    mockTabAgentType = "codex"
    mockGetAgentQuota.mockRejectedValueOnce(
      new Error("Quota probing is disabled for codex")
    )

    const { queryByRole } = renderWithIntl(<ComposerQuotaBadge tabId="tab-1" />)

    await waitFor(() => {
      expect(mockGetAgentQuota).toHaveBeenCalledWith("codex")
    })
    await waitFor(() => {
      expect(queryByRole("button", { name: "View agent quota" })).toBeNull()
    })
  })

  it("refreshes quota when turn completes (prompting -> connected)", async () => {
    mockConnState = { status: "prompting", agentType: "custom:antigravity-b" }
    mockTabAgentType = "custom:antigravity-b"
    mockGetAgentQuota.mockResolvedValue(makeSampleQuota("custom:antigravity-b"))

    const { rerender } = renderWithIntl(<ComposerQuotaBadge tabId="tab-1" />)

    await waitFor(() => {
      expect(mockGetAgentQuota).toHaveBeenCalledTimes(1)
    })

    mockConnState = { status: "connected", agentType: "custom:antigravity-b" }
    mockConnSubscribers.forEach((cb) => cb())
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ComposerQuotaBadge tabId="tab-1" />
      </NextIntlClientProvider>
    )

    await waitFor(() => {
      expect(mockGetAgentQuota).toHaveBeenCalledTimes(2)
    })
  })

  it("picks the binding quota window with lower remaining percentage", () => {
    const sample = makeSampleQuota("codex")
    const binding = pickBindingWindow(sample)
    expect(binding?.label).toBe("7d Window")
    expect(binding?.remainingPercent).toBe(58)
  })
})

describe("Smart Quota Toggle Switch Helpers", () => {
  it("shows toggle only for subscription-capable agents", () => {
    expect(isQuotaProbeCapableAgent({ agent_type: "codex" })).toBe(true)
    expect(isQuotaProbeCapableAgent({ agent_type: "antigravity" })).toBe(true)
    expect(
      isQuotaProbeCapableAgent({ agent_type: "custom:antigravity-b" })
    ).toBe(true)
    expect(isQuotaProbeCapableAgent({ agent_type: "claude_code" })).toBe(true)
    expect(isQuotaProbeCapableAgent({ agent_type: "gemini" })).toBe(true)
    expect(isQuotaProbeCapableAgent({ agent_type: "open_code" })).toBe(false)
    expect(isQuotaProbeCapableAgent({ agent_type: "deepseek" })).toBe(false)
    expect(isQuotaProbeCapableAgent({ agent_type: "hermes" })).toBe(false)
  })

  it("auto-enables on official subscription login and auto-disables on 3rd-party API / Model Provider", () => {
    const officialDraft = baseDraft()
    expect(isDraftOfficialSubscriptionMode("codex", officialDraft)).toBe(true)
    expect(quotaProbeEnabledForDraft("codex", officialDraft)).toBe(true)

    const manuallyOffDraft = baseDraft({
      envText: setQuotaProbeMode("", false),
    })
    expect(manuallyOffDraft.envText).toContain("CODEG_QUOTA_PROBE_MODE=off")
    expect(quotaProbeEnabledForDraft("codex", manuallyOffDraft)).toBe(false)

    const apiKeyCodexDraft = baseDraft({ codexAuthMode: "api_key" })
    expect(isDraftOfficialSubscriptionMode("codex", apiKeyCodexDraft)).toBe(
      false
    )
    expect(quotaProbeEnabledForDraft("codex", apiKeyCodexDraft)).toBe(false)

    const providerBoundDraft = baseDraft({ modelProviderId: 42 })
    expect(
      isDraftOfficialSubscriptionMode("antigravity", providerBoundDraft)
    ).toBe(false)
    expect(quotaProbeEnabledForDraft("antigravity", providerBoundDraft)).toBe(
      false
    )
  })
})
