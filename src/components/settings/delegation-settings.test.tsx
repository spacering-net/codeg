import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", () => ({
  getDelegationSettings: vi.fn(),
  setDelegationSettings: vi.fn(),
  acpListAgents: vi.fn(),
  // The assistants tab's store.
  assistantList: vi.fn(async () => []),
  assistantCreate: vi.fn(),
  assistantUpdate: vi.fn(),
  assistantDelete: vi.fn(),
  assistantReorder: vi.fn(),
  describeAgentOptions: vi.fn(() => new Promise(() => {})),
}))
vi.mock("@/hooks/use-acp-agents", () => ({
  useAcpAgents: () => ({ agents: [], fresh: true, refresh: () => {} }),
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
  subscribe: vi.fn((event: string, handler: (p: unknown) => void) => {
    if (event === "delegation-settings://changed") delegationHandler = handler
    return Promise.resolve(() => {})
  }),
  onTransportReconnect: vi.fn(() => () => {}),
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
  delegationHandler = undefined
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

describe("DelegationSettingsSection — tabs and the saved record", () => {
  const tab = (name: RegExp) => screen.getByRole("tab", { name })
  const dotOn = (name: RegExp) =>
    within(tab(name)).queryByRole("img", { name: "Unsaved changes" })
  const offNotice = /Multi-Agent Collaboration is off/

  it("shows the save bar on the first two tabs only", async () => {
    mockGetDelegationSettings.mockResolvedValue(settings({ enabled: true }))
    const user = userEvent.setup()
    renderWithIntl()
    await screen.findByLabelText("Enable delegation")
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument()

    await user.click(tab(/^Agent defaults/))
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument()

    // Every assistant change is written at once.
    await user.click(tab(/^Assistants/))
    await screen.findByText(/No assistants yet/)
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull()
  })

  it("explains the disabled agent defaults while the switch is off, and leads to it", async () => {
    mockGetDelegationSettings.mockResolvedValue(settings({ enabled: false }))
    const user = userEvent.setup()
    renderWithIntl()
    await screen.findByLabelText("Enable delegation")

    await user.click(tab(/^Agent defaults/))
    const notice = /Turn it on to edit these defaults/
    expect(screen.getByText(notice)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Go to General" }))
    expect(tab(/^General/)).toHaveAttribute("data-state", "active")

    // Switched on — saved or not — the defaults can be edited.
    await user.click(screen.getByLabelText("Enable delegation"))
    await user.click(tab(/^Agent defaults/))
    expect(screen.queryByText(notice)).toBeNull()
  })

  it("marks a tab with unsaved changes, and the assistants tab points back to it", async () => {
    mockGetDelegationSettings.mockResolvedValue(settings({ enabled: true }))
    const user = userEvent.setup()
    renderWithIntl()
    const depth = await screen.findByLabelText("Maximum delegation depth")
    expect(dotOn(/^General/)).toBeNull()

    fireEvent.change(depth, { target: { value: "4" } })
    expect(dotOn(/^General/)).not.toBeNull()
    expect(dotOn(/^Agent defaults/)).toBeNull()

    await user.click(tab(/^Assistants/))
    expect(
      await screen.findByText("General has unsaved changes.")
    ).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Go back" }))
    expect(tab(/^General/)).toHaveAttribute("data-state", "active")
    expect(screen.getByLabelText("Maximum delegation depth")).toHaveValue(4)

    // Putting the value back clears the mark.
    fireEvent.change(screen.getByLabelText("Maximum delegation depth"), {
      target: { value: "1" },
    })
    expect(dotOn(/^General/)).toBeNull()
  })

  it("tells the assistants tab what is saved, not what the form holds", async () => {
    mockGetDelegationSettings.mockResolvedValue(settings({ enabled: true }))
    const user = userEvent.setup()
    renderWithIntl()
    const toggle = await screen.findByLabelText("Enable delegation")

    // Switched off but not saved: assistants can still be delegated to.
    fireEvent.click(toggle)
    await user.click(tab(/^Assistants/))
    await screen.findByText("General has unsaved changes.")
    expect(screen.queryByText(offNotice)).toBeNull()

    // Switched off elsewhere: now they cannot.
    act(() => delegationHandler?.(settings({ enabled: false })))
    expect(await screen.findByText(offNotice)).toBeInTheDocument()
    // …and the form now matches what is saved.
    expect(screen.queryByText("General has unsaved changes.")).toBeNull()
  })

  it("keeps a broadcast that overtook the first load", async () => {
    let answerLoad: (s: DelegationSettings) => void = () => {}
    mockGetDelegationSettings.mockReturnValue(
      new Promise((resolve) => {
        answerLoad = resolve
      })
    )
    const user = userEvent.setup()
    renderWithIntl()
    await waitFor(() => expect(delegationHandler).toBeDefined())

    // The status-bar popover switches delegation on while this window's read
    // is out; the read answers from before it.
    act(() => delegationHandler?.(settings({ enabled: true, depth_limit: 3 })))
    await act(async () =>
      answerLoad(settings({ enabled: false, depth_limit: 3 }))
    )

    expect(screen.getByLabelText("Enable delegation")).toHaveAttribute(
      "data-state",
      "checked"
    )
    expect(screen.getByLabelText("Maximum delegation depth")).toHaveValue(3)
    expect(dotOn(/^General/)).toBeNull()
    await user.click(tab(/^Assistants/))
    await screen.findByText(/No assistants yet/)
    expect(screen.queryByText(offNotice)).toBeNull()
    expect(screen.queryByText(/unsaved changes/)).toBeNull()
  })

  /** A broadcast that landed while a save was out can be OLDER than the save:
   * the popover's flip committed just before it. The save's own values stay,
   * and its own broadcast — which comes after, broadcasts arrive in commit
   * order — settles the switch and the saved record. */
  it("keeps the saved values when an older broadcast lands during the save", async () => {
    mockGetDelegationSettings.mockResolvedValue(settings({ enabled: true }))
    let answerSave: (s: DelegationSettings) => void = () => {}
    mockSetDelegationSettings.mockReturnValue(
      new Promise((resolve) => {
        answerSave = resolve
      })
    )
    const user = userEvent.setup()
    renderWithIntl()
    const depth = await screen.findByLabelText("Maximum delegation depth")
    fireEvent.change(depth, { target: { value: "5" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    // The popover's flip, committed just before this save (so the save then
    // wrote its own switch back over it).
    act(() => delegationHandler?.(settings({ enabled: false, depth_limit: 1 })))
    await act(async () =>
      answerSave(settings({ enabled: true, depth_limit: 5 }))
    )
    // The depth just saved is not rolled back to the older broadcast's.
    expect(screen.getByLabelText("Maximum delegation depth")).toHaveValue(5)

    // The save's own broadcast settles the rest.
    act(() => delegationHandler?.(settings({ enabled: true, depth_limit: 5 })))
    expect(screen.getByLabelText("Enable delegation")).toHaveAttribute(
      "data-state",
      "checked"
    )
    expect(dotOn(/^General/)).toBeNull()
    await user.click(tab(/^Assistants/))
    await screen.findByText(/No assistants yet/)
    expect(screen.queryByText(offNotice)).toBeNull()
    expect(screen.queryByText(/unsaved changes/)).toBeNull()
  })

  it("keeps a broadcast that overtook a save's reply", async () => {
    mockGetDelegationSettings.mockResolvedValue(settings({ enabled: true }))
    let answerSave: (s: DelegationSettings) => void = () => {}
    mockSetDelegationSettings.mockReturnValue(
      new Promise((resolve) => {
        answerSave = resolve
      })
    )
    const user = userEvent.setup()
    renderWithIntl()
    const depth = await screen.findByLabelText("Maximum delegation depth")
    fireEvent.change(depth, { target: { value: "3" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    // The save's own broadcast, then the status-bar popover switching
    // delegation off — both before the reply.
    act(() => delegationHandler?.(settings({ enabled: true, depth_limit: 3 })))
    act(() => delegationHandler?.(settings({ enabled: false, depth_limit: 3 })))
    await act(async () =>
      answerSave(settings({ enabled: true, depth_limit: 3 }))
    )

    // The reply does not switch it back on.
    expect(screen.getByLabelText("Enable delegation")).toHaveAttribute(
      "data-state",
      "unchecked"
    )
    expect(dotOn(/^General/)).toBeNull()
    await user.click(tab(/^Assistants/))
    expect(await screen.findByText(offNotice)).toBeInTheDocument()
  })
})
