import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CodegMcpServiceStatus } from "@/lib/api"

const getCodegMcpServiceStatus = vi.fn<() => Promise<CodegMcpServiceStatus>>()
const startCodegMcpService = vi.fn<() => Promise<void>>()
const setCodegMcpToolGroup = vi.fn<(k: string, e: boolean) => Promise<void>>()
const openSettingsWindow = vi.fn()

vi.mock("@/lib/api", () => ({
  getCodegMcpServiceStatus: () => getCodegMcpServiceStatus(),
  startCodegMcpService: () => startCodegMcpService(),
  setCodegMcpToolGroup: (k: string, e: boolean) => setCodegMcpToolGroup(k, e),
  openSettingsWindow: (...args: unknown[]) => openSettingsWindow(...args),
}))

import { StatusBarMcp } from "./status-bar-mcp"
import enMessages from "@/i18n/messages/en.json"

function makeStatus(
  overrides: Partial<CodegMcpServiceStatus> = {}
): CodegMcpServiceStatus {
  return {
    state: "running",
    listening: true,
    socket_path: "/tmp/codeg-delegation-4242.sock",
    binary_path: "/Applications/codeg.app/Contents/MacOS/codeg-mcp",
    tool_groups: [
      { key: "delegation", enabled: true },
      { key: "feedback", enabled: true },
      { key: "ask", enabled: false },
      { key: "sessions", enabled: false },
      { key: "automations", enabled: false },
      { key: "taskboard", enabled: false },
    ],
    companion_count: 2,
    session_count: 2,
    active_delegations: 1,
    depth_limit: 3,
    started_at: null,
    last_error: null,
    can_start: true,
    ...overrides,
  }
}

async function mount() {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <StatusBarMcp />
    </NextIntlClientProvider>
  )
  // Wait for the mount fetch to land before anyone reads the trigger.
  await waitFor(() => expect(getCodegMcpServiceStatus).toHaveBeenCalled())
}

/** Open the popover. The trigger is the only button until it opens. */
async function openPopover() {
  fireEvent.click(screen.getAllByRole("button")[0])
  await screen.findByText("Sessions")
}

/** The switch for one tool group, addressed by its visible label. */
function toolSwitch(label: string) {
  return screen.getByRole("switch", { name: label })
}

beforeEach(() => {
  getCodegMcpServiceStatus.mockReset()
  startCodegMcpService.mockReset()
  setCodegMcpToolGroup.mockReset()
  openSettingsWindow.mockReset()
  getCodegMcpServiceStatus.mockResolvedValue(makeStatus())
  startCodegMcpService.mockResolvedValue(undefined)
  setCodegMcpToolGroup.mockResolvedValue(undefined)
  // The real one returns a promise the component attaches a `.catch` to.
  openSettingsWindow.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
})

describe("StatusBarMcp", () => {
  /** The bar glyph is as plain as its neighbours: the state lives in the
   * tooltip, not in a colour or a badge. */
  it("keeps the trigger plain, with the state only in its tooltip", async () => {
    await mount()
    const trigger = await screen.findByTitle(/Running/)
    expect(trigger).toHaveTextContent("")
    expect(trigger.className).not.toMatch(/text-(emerald|red|yellow)/)
  })

  /** `stopped` is exactly `not listening`, so a socket column would restate
   * the badge. The strip carries only what the badge cannot. */
  it("shows the three counts the badge does not already carry", async () => {
    await mount()
    await openPopover()

    for (const label of ["Sessions", "Delegations", "Depth cap"]) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
    expect(screen.queryByText("Status")).not.toBeInTheDocument()
    // The badge is the single place the socket verdict is stated.
    expect(screen.getAllByText("Running")).toHaveLength(1)
  })

  /** The paths never had a column, so they must still be reachable — they are
   * what people copy out of this popover. */
  it("keeps the socket and binary paths on the state badge", async () => {
    await mount()
    await openPopover()

    const glyph = screen.getByTitle(/codeg-delegation-4242\.sock/)
    expect(glyph).toHaveAttribute(
      "title",
      expect.stringContaining(
        "/Applications/codeg.app/Contents/MacOS/codeg-mcp"
      )
    )
  })

  /** Each row names the tool and says what it lets an agent do — the switch
   * alone does not tell someone whether they want it on. */
  it("describes every tool group beside its switch", async () => {
    await mount()
    await openPopover()

    expect(
      screen.getByText("Hand a task to another agent.")
    ).toBeInTheDocument()
    expect(
      screen.getByText("Create and manage work tasks.")
    ).toBeInTheDocument()
  })

  /** Every group gets a row, switched off ones included — the list is now a
   * control surface, so hiding the off ones would hide the way to turn them on. */
  it("lists every tool group with its current switch position", async () => {
    await mount()
    await openPopover()

    expect(toolSwitch("Delegation")).toBeChecked()
    expect(toolSwitch("Live Feedback")).toBeChecked()
    expect(toolSwitch("Ask user question")).not.toBeChecked()
    expect(toolSwitch("Get session info")).not.toBeChecked()
  })

  /** `browser_eval` is a switch inside another one: it is shown here (so the
   * popover is the whole list, not most of it) but is not something to turn
   * on in passing while the browser itself is off — the backend would drop it
   * and the row would be promising a tool nothing can call. */
  it("shows a switch that lives inside another as off and untouchable", async () => {
    getCodegMcpServiceStatus.mockResolvedValue(
      makeStatus({
        tool_groups: [
          { key: "browser", enabled: false },
          { key: "browser_eval", enabled: false, requires: "browser" },
        ],
      })
    )
    await mount()
    await openPopover()

    const evalSwitch = toolSwitch("Run code in the built-in browser")
    expect(evalSwitch).toBeDisabled()
    expect(evalSwitch).not.toBeChecked()
    fireEvent.click(evalSwitch)
    expect(setCodegMcpToolGroup).not.toHaveBeenCalled()

    // With the group on it is an ordinary row again, and writes its own key.
    getCodegMcpServiceStatus.mockResolvedValue(
      makeStatus({
        tool_groups: [
          { key: "browser", enabled: true },
          { key: "browser_eval", enabled: false, requires: "browser" },
        ],
      })
    )
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }))
    await waitFor(() =>
      expect(toolSwitch("Run code in the built-in browser")).toBeEnabled()
    )
    fireEvent.click(toolSwitch("Run code in the built-in browser"))
    await waitFor(() =>
      expect(setCodegMcpToolGroup).toHaveBeenCalledWith("browser_eval", true)
    )
  })

  it("writes a group toggle through and re-reads the status", async () => {
    await mount()
    await openPopover()

    getCodegMcpServiceStatus.mockResolvedValue(
      makeStatus({
        tool_groups: [
          { key: "delegation", enabled: true },
          { key: "feedback", enabled: true },
          { key: "ask", enabled: true },
          { key: "sessions", enabled: false },
          { key: "automations", enabled: false },
          { key: "taskboard", enabled: false },
        ],
      })
    )
    fireEvent.click(toolSwitch("Ask user question"))

    await waitFor(() =>
      expect(setCodegMcpToolGroup).toHaveBeenCalledWith("ask", true)
    )
    await waitFor(() => expect(toolSwitch("Ask user question")).toBeChecked())
  })

  /** A rejected write must not leave the switch showing a position no setting
   * backs — it snaps back to the last known truth and says why. */
  it("reverts a switch whose write was refused", async () => {
    setCodegMcpToolGroup.mockRejectedValue(new Error("database is locked"))
    await mount()
    await openPopover()

    fireEvent.click(toolSwitch("Ask user question"))

    expect(
      await screen.findByText(/Failed: database is locked/)
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(toolSwitch("Ask user question")).not.toBeChecked()
    )
    // The refusal is not a reason to re-read: the status never changed.
    expect(getCodegMcpServiceStatus).toHaveBeenCalledTimes(2)
  })

  /** Settings must land on the page that actually holds these switches. With
   * no section the desktop transport falls back to Appearance, which has
   * nothing to do with the popover the click came from. */
  it("opens settings on the general page", async () => {
    await mount()
    await openPopover()

    fireEvent.click(screen.getByRole("button", { name: /Open full settings/ }))
    expect(openSettingsWindow).toHaveBeenCalledWith("collaboration")
  })

  /** The headline promise of the feature: a dead socket is repairable in place. */
  it("offers the start button when stopped and refetches after starting", async () => {
    getCodegMcpServiceStatus.mockResolvedValue(
      makeStatus({ state: "stopped", listening: false, session_count: 0 })
    )
    await mount()
    await openPopover()

    const start = screen.getByRole("button", { name: /Start service/ })
    getCodegMcpServiceStatus.mockResolvedValue(makeStatus())
    fireEvent.click(start)

    await waitFor(() => expect(startCodegMcpService).toHaveBeenCalledTimes(1))
    // Status is re-read after the start so the popover reflects the new truth
    // rather than the one that motivated the click.
    await waitFor(() =>
      expect(getCodegMcpServiceStatus.mock.calls.length).toBeGreaterThan(1)
    )
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /Start service/ })
      ).not.toBeInTheDocument()
    )
  })

  /** A start we know would fail must not be offered — `can_start` is false in
   * runtimes that never bound a socket. */
  it("hides the start button when the process holds no service handle", async () => {
    getCodegMcpServiceStatus.mockResolvedValue(
      makeStatus({ state: "stopped", listening: false, can_start: false })
    )
    await mount()
    await openPopover()

    expect(
      screen.queryByRole("button", { name: /Start service/ })
    ).not.toBeInTheDocument()
  })

  /** Every other state is a healthy socket, so nothing here can start it. The
   * missing binary is named by the hint line, not by a row of its own. */
  it("does not offer a start button for a missing companion binary", async () => {
    getCodegMcpServiceStatus.mockResolvedValue(
      makeStatus({ state: "unavailable", binary_path: null })
    )
    await mount()
    await openPopover()

    expect(
      screen.getByText("The codeg-mcp binary is not on disk.")
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /Start service/ })
    ).not.toBeInTheDocument()
  })

  it("surfaces a failed start without claiming the service is broken", async () => {
    getCodegMcpServiceStatus.mockResolvedValue(
      makeStatus({ state: "stopped", listening: false })
    )
    startCodegMcpService.mockRejectedValue(new Error("address already in use"))
    await mount()
    await openPopover()

    fireEvent.click(screen.getByRole("button", { name: /Start service/ }))
    expect(
      await screen.findByText(/Failed: address already in use/)
    ).toBeInTheDocument()
  })

  /** A failed status call says nothing about the service, so it must not be
   * painted as a service fault. */
  it("falls back to an unknown state when the status call fails", async () => {
    getCodegMcpServiceStatus.mockRejectedValue(new Error("transport offline"))
    await mount()
    await openPopover2()

    expect(
      screen.getByText(/Could not read the status: transport offline/)
    ).toBeInTheDocument()
    // No strip and no switches: there is no status to render either from.
    expect(screen.queryByText("Sessions")).not.toBeInTheDocument()
    expect(screen.queryAllByRole("switch")).toHaveLength(0)
  })
})

/** Variant of {@link openPopover} for the error path, where neither the stat
 * strip nor the tool switches are rendered. */
async function openPopover2() {
  fireEvent.click(screen.getAllByRole("button")[0])
  await screen.findByRole("button", { name: /Open full settings/ })
}
