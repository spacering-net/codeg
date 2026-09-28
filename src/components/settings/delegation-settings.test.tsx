import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", () => ({
  getDelegationSettings: vi.fn(),
  setDelegationSettings: vi.fn(),
  acpListAgents: vi.fn(),
}))

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

// Capture the settings-change handler so a test can play a remote write back.
let delegationHandler: ((p: unknown) => void) | undefined
vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn((_event: string, handler: (p: unknown) => void) => {
    delegationHandler = handler
    return Promise.resolve(() => {})
  }),
}))

import { DelegationSettingsSection } from "./delegation-settings"
import enMessages from "@/i18n/messages/en.json"
import {
  acpListAgents,
  getDelegationSettings,
  setDelegationSettings,
  type DelegationSettings,
} from "@/lib/api"
import type { AcpAgentInfo } from "@/lib/types"

const mockGetDelegationSettings = vi.mocked(getDelegationSettings)
const mockSetDelegationSettings = vi.mocked(setDelegationSettings)
const mockAcpListAgents = vi.mocked(acpListAgents)

/** Just the fields the panel reads off an agent. */
function agent(
  name: string,
  enabled: boolean,
  hostToolsAgentMode: boolean
): AcpAgentInfo {
  return {
    name,
    enabled,
    host_tools_agent_mode: hostToolsAgentMode,
  } as unknown as AcpAgentInfo
}

function renderWithIntl() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <DelegationSettingsSection />
    </NextIntlClientProvider>
  )
}

function settings(
  overrides: Partial<DelegationSettings> = {}
): DelegationSettings {
  // Mirror the new backend default (DelegationSettings::default) so tests
  // that don't care about the toggle reflect the production wire shape.
  // Tests that need delegation active for save/depth assertions must
  // override explicitly.
  return {
    enabled: false,
    depth_limit: 1,
    completed_cache_max_mb: 512,
    agent_defaults: {},
    ...overrides,
  }
}

beforeEach(() => {
  mockGetDelegationSettings.mockReset()
  mockSetDelegationSettings.mockReset()
  mockAcpListAgents.mockReset()
  mockAcpListAgents.mockResolvedValue([])
})

describe("DelegationSettingsSection", () => {
  /** The status-bar codeg-mcp popover flips `enabled` on its own, and Save here
   * submits the whole record. A form left open across such a toggle must adopt
   * it, or changing only the depth limit would switch delegation back off. */
  it("adopts a remote enable instead of reverting it on save", async () => {
    mockGetDelegationSettings.mockResolvedValue(settings({ enabled: false }))
    mockSetDelegationSettings.mockImplementation(async (v) => v)
    renderWithIntl()
    const toggle = await screen.findByLabelText("Enable delegation")
    expect(toggle).toHaveAttribute("data-state", "unchecked")

    act(() => delegationHandler?.(settings({ enabled: true, depth_limit: 1 })))
    await waitFor(() => expect(toggle).toHaveAttribute("data-state", "checked"))

    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() =>
      expect(mockSetDelegationSettings).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: true })
      )
    )
  })

  /** ...but a switch the user already moved keeps their pending value. */
  it("keeps a pending local edit when a remote write lands", async () => {
    mockGetDelegationSettings.mockResolvedValue(settings({ enabled: false }))
    mockSetDelegationSettings.mockImplementation(async (v) => v)
    renderWithIntl()
    const toggle = await screen.findByLabelText("Enable delegation")

    fireEvent.click(toggle)
    await waitFor(() => expect(toggle).toHaveAttribute("data-state", "checked"))

    act(() => delegationHandler?.(settings({ enabled: false })))
    await waitFor(() => expect(toggle).toHaveAttribute("data-state", "checked"))
  })

  it("renders the enable switch and depth input", async () => {
    mockGetDelegationSettings.mockResolvedValue(settings())

    renderWithIntl()

    expect(
      await screen.findByLabelText("Maximum delegation depth")
    ).toBeInTheDocument()
    expect(screen.getByLabelText("Enable delegation")).toBeInTheDocument()
    expect(
      screen.getByLabelText("Completed-result cache (MB)")
    ).toBeInTheDocument()
    // No timeout knob anymore — cancel flows through MCP notifications.
    expect(screen.queryByLabelText(/timeout/i)).not.toBeInTheDocument()
  })

  it("names the agents whose sandbox switch withholds the delegation tools", async () => {
    // The reported confusion: the master switch reads "on" and the tools are
    // still missing, because a per-agent switch withholds them.
    mockGetDelegationSettings.mockResolvedValue(settings({ enabled: true }))
    mockAcpListAgents.mockResolvedValue([
      agent("Codex", true, true),
      agent("Claude Code", true, true),
      // Not affected: knob off, or the agent is disabled entirely.
      agent("Grok", true, false),
      agent("Pi", false, true),
    ])

    renderWithIntl()

    const note = await screen.findByText(/will not get the delegation tools/)
    expect(note).toHaveTextContent("Codex, Claude Code")
    expect(note).not.toHaveTextContent("Grok")
    expect(note).not.toHaveTextContent("Pi")
  })

  it("says nothing when no agent hands its channels back", async () => {
    mockGetDelegationSettings.mockResolvedValue(settings({ enabled: true }))
    mockAcpListAgents.mockResolvedValue([agent("Grok", true, false)])

    renderWithIntl()

    await screen.findByLabelText("Enable delegation")
    expect(
      screen.queryByText(/will not get the delegation tools/)
    ).not.toBeInTheDocument()
  })

  it("says nothing while delegation itself is off", async () => {
    // The switch above already explains the absence; a second reason would
    // just be noise.
    mockGetDelegationSettings.mockResolvedValue(settings({ enabled: false }))
    mockAcpListAgents.mockResolvedValue([agent("Codex", true, true)])

    renderWithIntl()

    await screen.findByLabelText("Enable delegation")
    expect(
      screen.queryByText(/will not get the delegation tools/)
    ).not.toBeInTheDocument()
  })

  it("saves the completed-result cache budget (MB); 0 means unlimited", async () => {
    mockGetDelegationSettings.mockResolvedValue(settings({ enabled: true }))
    mockSetDelegationSettings.mockImplementation(async (next) => next)

    renderWithIntl()

    const cacheInput = await screen.findByLabelText(
      "Completed-result cache (MB)"
    )
    fireEvent.change(cacheInput, { target: { value: "0" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => {
      expect(mockSetDelegationSettings).toHaveBeenCalledWith({
        enabled: true,
        depth_limit: 1,
        completed_cache_max_mb: 0,
        agent_defaults: {},
      })
    })
  })

  it("clearing the cache input falls back to the default, not unlimited", async () => {
    mockGetDelegationSettings.mockResolvedValue(
      settings({ enabled: true, completed_cache_max_mb: 256 })
    )
    mockSetDelegationSettings.mockImplementation(async (next) => next)

    renderWithIntl()

    const cacheInput = await screen.findByLabelText(
      "Completed-result cache (MB)"
    )
    fireEvent.change(cacheInput, { target: { value: "" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => {
      expect(mockSetDelegationSettings).toHaveBeenCalledWith({
        enabled: true,
        depth_limit: 1,
        completed_cache_max_mb: 512,
        agent_defaults: {},
      })
    })
  })

  it("saves the depth_limit and enabled flag", async () => {
    // Depth input is disabled while `enabled` is false (the production
    // default), so this flow explicitly opts in.
    mockGetDelegationSettings.mockResolvedValue(settings({ enabled: true }))
    mockSetDelegationSettings.mockImplementation(async (next) => next)

    renderWithIntl()

    const depthInput = await screen.findByLabelText("Maximum delegation depth")
    fireEvent.change(depthInput, { target: { value: "5" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => {
      expect(mockSetDelegationSettings).toHaveBeenCalledWith({
        enabled: true,
        depth_limit: 5,
        completed_cache_max_mb: 512,
        agent_defaults: {},
      })
    })
  })

  it("reflects backend default (disabled): switch off, depth input disabled", async () => {
    // Regression for the "default off" UX guarantee: when persistence has
    // never been written, the backend returns `enabled: false` and the
    // panel must surface that. Switch un-checked + depth input disabled
    // is what blocks the user from changing depth/agent-defaults before
    // they consciously opt in.
    mockGetDelegationSettings.mockResolvedValue(settings())

    renderWithIntl()

    const depthInput = (await screen.findByLabelText(
      "Maximum delegation depth"
    )) as HTMLInputElement
    const enableSwitch = screen.getByLabelText(
      "Enable delegation"
    ) as HTMLButtonElement

    expect(enableSwitch).toHaveAttribute("data-state", "unchecked")
    expect(depthInput).toBeDisabled()
  })
})
