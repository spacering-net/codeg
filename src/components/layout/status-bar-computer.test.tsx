import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type {
  ComputerStatePayload,
  ComputerStatus,
  ComputerToolsSettings,
  StopKeyStatus,
} from "@/lib/computer/types"

const api = vi.hoisted(() => ({
  computerAvailable: vi.fn(() => true),
  useComputerAvailable: () => api.computerAvailable(),
  askComputerServed: vi.fn(async () => api.computerAvailable()),
  subscribeComputerServed: vi.fn(() => () => {}),
  computerServerPlatform: vi.fn(() => null),
  getComputerToolsSettings: vi.fn(),
  computerStatus: vi.fn<() => Promise<ComputerStatus>>(),
  computerSharedState: vi.fn(
    async (): Promise<ComputerStatePayload> => ({ shared: [] })
  ),
  computerRequestPermission: vi.fn(),
  computerOpenPermissionSettings: vi.fn(async () => {}),
  computerRevealHelper: vi.fn(async () => {}),
  computerShareWindow: vi.fn(),
  computerShareWindows: vi.fn(),
  computerShareApp: vi.fn(),
  computerShareScreen: vi.fn(),
  computerRevokeAll: vi.fn(),
  computerStop: vi.fn(async () => {}),
  computerListShareableWindows: vi.fn(),
  computerWindowThumbnail: vi.fn(),
  computerStopKeyStatus: vi.fn(async (): Promise<StopKeyStatus> => ({})),
}))
vi.mock("@/lib/computer/computer-api", () => api)
vi.mock("@/hooks/use-is-mac", () => ({ useIsMac: () => true }))
const handlers = new Map<string, (p: unknown) => void>()
vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn((event: string, handler: (p: unknown) => void) => {
    handlers.set(event, handler)
    return Promise.resolve(() => {})
  }),
}))
const shell = vi.hoisted(() => ({ openSettingsWindow: vi.fn(async () => {}) }))
vi.mock("@/lib/api", () => shell)

import { StatusBarComputer } from "./status-bar-computer"
import enMessages from "@/i18n/messages/en.json"
import {
  recordComputerActivity,
  resetComputerStoreForTest,
  setComputerShared,
} from "@/lib/computer/computer-store"

function status(overrides: Partial<ComputerStatus> = {}): ComputerStatus {
  return {
    enabled: true,
    platform: "macos",
    verifiedPlatform: false,
    backend: { state: "ready", driverVersion: "0.28.2", peer: "verified" },
    permissions: {
      required: true,
      accessibility: true,
      screenRecording: false,
    },
    codeg: {
      accessibility: false,
      screenRecording: false,
      selfResponsible: true,
    },
    shared: [],
    ...overrides,
  }
}

function mount() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <StatusBarComputer />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  handlers.clear()
  resetComputerStoreForTest()
  api.computerAvailable.mockReturnValue(true)
  api.getComputerToolsSettings.mockResolvedValue({
    enabled: true,
    grantTtlMinutes: 30,
    blocklist: [],
    blocklistRemoved: [],
    blocklistDefaults: [],
    stopShortcut: "Control+Command+Escape",
    showIndicator: true,
    allowForeground: false,
    defaultDelivery: "background",
  })
  api.computerStatus.mockResolvedValue(status())
  api.computerStopKeyStatus.mockResolvedValue({})
  api.computerSharedState.mockResolvedValue({ shared: [] })
})

const controlled = {
  targetId: "w4",
  appName: "TextEdit",
  appKey: "com.apple.TextEdit",
  title: "notes.txt",
  level: "control" as const,
  grantedAt: 1,
  lastUsedAt: 1,
}

describe("StatusBarComputer", () => {
  it("is not there while computer use is off", async () => {
    api.getComputerToolsSettings.mockResolvedValue({
      enabled: false,
      grantTtlMinutes: 30,
      blocklist: [],
      blocklistRemoved: [],
      blocklistDefaults: [],
      stopShortcut: "",
      showIndicator: true,
      allowForeground: false,
      defaultDelivery: "background",
    })
    const { container } = mount()
    await waitFor(() => expect(api.getComputerToolsSettings).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  /** A missing permission is named, with one way to grant it: a helper
   * asks macOS for that one — which lists it in System Settings — and, with
   * no dialog of the system's to lead there, System Settings opens at that
   * pane, where the switch is. */
  it("asks for a missing permission, then opens its pane", async () => {
    api.computerRequestPermission.mockResolvedValue({
      report: { required: true, accessibility: true, screenRecording: false },
      prompted: false,
    })
    mount()
    fireEvent.click(await screen.findByRole("button", { name: "Computer use" }))
    await screen.findByText("Screen Recording")
    expect(screen.getByText("Granted")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Open Settings" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Grant…" }))
    await waitFor(() =>
      expect(api.computerOpenPermissionSettings).toHaveBeenCalledWith(
        "screenRecording"
      )
    )
    expect(api.computerRequestPermission).toHaveBeenCalledWith(
      "screenRecording"
    )
    // Not listed there, it can be dragged in from the Finder.
    fireEvent.click(screen.getByRole("button", { name: "Show in Finder" }))
    await waitFor(() => expect(api.computerRevealHelper).toHaveBeenCalled())
  })

  /** When macOS puts up its own dialog — which has a button to the pane —
   * System Settings is not opened as well: one thing at a time. */
  it("leaves it to the system's own dialog when there is one", async () => {
    api.computerRequestPermission.mockResolvedValue({
      report: { required: true, accessibility: true, screenRecording: false },
      prompted: true,
    })
    mount()
    fireEvent.click(await screen.findByRole("button", { name: "Computer use" }))
    fireEvent.click(await screen.findByRole("button", { name: "Grant…" }))
    await waitFor(() =>
      expect(api.computerRequestPermission).toHaveBeenCalledWith(
        "screenRecording"
      )
    )
    await waitFor(() => expect(api.computerStatus).toHaveBeenCalledTimes(2))
    expect(api.computerOpenPermissionSettings).not.toHaveBeenCalled()
  })

  /** One request at a time: a double click neither asks twice nor opens
   * System Settings twice. */
  it("asks once however often the button is clicked", async () => {
    let answer: (report: unknown) => void = () => {}
    api.computerRequestPermission.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve
      })
    )
    mount()
    fireEvent.click(await screen.findByRole("button", { name: "Computer use" }))
    const grant = await screen.findByRole("button", { name: "Grant…" })
    fireEvent.click(grant)
    fireEvent.click(grant)
    await waitFor(() => expect(grant).toBeDisabled())
    await act(async () =>
      answer({
        report: {
          required: true,
          accessibility: true,
          screenRecording: false,
        },
        prompted: false,
      })
    )
    expect(api.computerRequestPermission).toHaveBeenCalledTimes(1)
    await waitFor(() =>
      expect(api.computerOpenPermissionSettings).toHaveBeenCalledTimes(1)
    )
  })

  /** Granted by the request itself — nothing more to open. */
  it("opens nothing once the request has done it", async () => {
    api.computerRequestPermission.mockResolvedValue({
      report: { required: true, accessibility: true, screenRecording: true },
      prompted: false,
    })
    mount()
    fireEvent.click(await screen.findByRole("button", { name: "Computer use" }))
    fireEvent.click(await screen.findByRole("button", { name: "Grant…" }))
    await waitFor(() =>
      expect(api.computerRequestPermission).toHaveBeenCalled()
    )
    await waitFor(() => expect(api.computerStatus).toHaveBeenCalledTimes(2))
    expect(api.computerOpenPermissionSettings).not.toHaveBeenCalled()
  })

  /** codeg holding a permission itself is said — and nothing is held back
   * over it: agents' shells have that permission whatever computer use
   * does. */
  it("tells, and only tells, when codeg itself holds a permission", async () => {
    api.computerStatus.mockResolvedValue(
      status({
        codeg: {
          accessibility: true,
          screenRecording: false,
          selfResponsible: true,
        },
      })
    )
    mount()
    fireEvent.click(await screen.findByRole("button", { name: "Computer use" }))
    await screen.findByText(/codeg itself has Accessibility/)
    expect(
      screen.getByRole("button", { name: "Share a window…" })
    ).toBeEnabled()
  })

  /** Someone who went to System Settings to grant a permission comes back to
   * this window: the rows are asked for again then, while the popover is
   * open, and not while it is shut. */
  it("asks again when the window comes back to the front", async () => {
    mount()
    const trigger = await screen.findByRole("button", { name: "Computer use" })
    act(() => {
      window.dispatchEvent(new Event("focus"))
    })
    expect(api.computerStatus).not.toHaveBeenCalled()
    fireEvent.click(trigger)
    await screen.findByText("Screen Recording")
    expect(api.computerStatus).toHaveBeenCalledTimes(1)
    api.computerStatus.mockResolvedValue(
      status({
        permissions: {
          required: true,
          accessibility: true,
          screenRecording: true,
        },
      })
    )
    act(() => {
      window.dispatchEvent(new Event("focus"))
    })
    await waitFor(() => expect(api.computerStatus).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Grant…" })).toBeNull()
    )
  })

  /** A development build's helper is a new program to macOS after every
   * rebuild; with a permission missing, that is what the note says. */
  it("explains a development build's lost grants", async () => {
    api.computerStatus.mockResolvedValue(
      status({
        backend: {
          state: "ready",
          driverVersion: "0.28.2",
          peer: "development",
        },
      })
    )
    mount()
    fireEvent.click(await screen.findByRole("button", { name: "Computer use" }))
    await screen.findByText(
      /remove the old codeg-computer-helper from the list/
    )
    // Said once, as a tag on the status line.
    expect(screen.getByTitle(/doesn't check/)).toHaveTextContent(
      "development build"
    )
  })

  /** Settings lead to the Computer use page. */
  it("opens the Computer use settings page", async () => {
    mount()
    fireEvent.click(await screen.findByRole("button", { name: "Computer use" }))
    fireEvent.click(
      await screen.findByRole("button", { name: "Open full settings" })
    )
    await waitFor(() =>
      expect(shell.openSettingsWindow).toHaveBeenCalledWith("computer-use")
    )
  })

  it("lists shared windows and stops one", async () => {
    api.computerStatus.mockResolvedValue(
      status({
        shared: [
          {
            targetId: "w4",
            appName: "TextEdit",
            appKey: "com.apple.TextEdit",
            title: "notes.txt",
            level: "read",
            grantedAt: 1,
            lastUsedAt: 1,
          },
        ],
      })
    )
    api.computerShareWindow.mockResolvedValue([])
    mount()
    fireEvent.click(await screen.findByRole("button", { name: "Computer use" }))
    await screen.findByText("notes.txt")
    fireEvent.click(screen.getByRole("button", { name: "Stop" }))
    await waitFor(() =>
      expect(api.computerShareWindow).toHaveBeenCalledWith("w4", "none")
    )
  })

  /** An application shared as a whole is one row — its windows are not
   * listed again — and stopping it ends its share. */
  it("lists an application shared as a whole once, and stops it", async () => {
    const viaApp = { ...controlled, wholeApp: true, appId: "a1" }
    const shared = [viaApp, { ...viaApp, targetId: "w5", title: "todo.txt" }]
    api.computerSharedState.mockResolvedValue({
      shared,
      apps: [
        {
          appId: "a1",
          appName: "TextEdit",
          appKey: "com.apple.TextEdit",
          level: "control",
          grantedAt: 1,
          lastUsedAt: 1,
          windows: 2,
        },
      ],
    })
    api.computerStatus.mockResolvedValue(status({ shared }))
    api.computerShareApp.mockResolvedValue({ shared: [], apps: [] })
    mount()
    const trigger = await screen.findByRole("button", { name: "Computer use" })
    await waitFor(() => expect(trigger.title).toContain("2 windows shared"))
    fireEvent.click(trigger)
    expect(await screen.findByText("Whole app · 2 windows")).toBeInTheDocument()
    expect(screen.queryByText("notes.txt")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Stop" }))
    await waitFor(() =>
      expect(api.computerShareApp).toHaveBeenCalledWith({ appId: "a1" }, "none")
    )
  })

  /** The entire screen shared is one row — the windows shared with it are
   * not listed again — and stopping it ends the screen's share. What agents
   * did on it reads as done to the screen. */
  it("lists the entire screen once, and stops it", async () => {
    const viaScreen = { ...controlled, wholeScreen: true }
    const shared = [viaScreen, { ...viaScreen, targetId: "w5" }]
    api.computerSharedState.mockResolvedValue({
      shared,
      apps: [],
      screen: { level: "control", grantedAt: 1, lastUsedAt: 1, windows: 2 },
    })
    api.computerStatus.mockResolvedValue(status({ shared }))
    api.computerShareScreen.mockResolvedValue({ shared: [], apps: [] })
    mount()
    const trigger = await screen.findByRole("button", { name: "Computer use" })
    await waitFor(() => expect(trigger.title).toContain("2 windows shared"))
    act(() =>
      recordComputerActivity({
        targetId: "d1",
        action: "click",
        outcome: "done",
        at: 1,
      })
    )
    fireEvent.click(trigger)
    expect(await screen.findByText("2 windows")).toBeInTheDocument()
    expect(screen.queryByText("notes.txt")).toBeNull()
    expect(screen.getByText(/Click · Entire screen/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Stop" }))
    await waitFor(() =>
      expect(api.computerShareScreen).toHaveBeenCalledWith("none")
    )
  })

  /** Stop sits in the popover, once: nothing beside the glyph, however much
   * is shared. Pressed, it ends every sharing and cuts off what agents are
   * doing. */
  it("stops sharing from the popover, and only there", async () => {
    api.computerStatus.mockResolvedValue(status({ shared: [controlled] }))
    mount()
    await screen.findByRole("button", { name: "Computer use" })
    act(() => setComputerShared([controlled]))
    expect(screen.queryByRole("button", { name: /^Stop sharing/ })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Computer use" }))
    fireEvent.click(
      await screen.findByRole("button", { name: /^Stop sharing/ })
    )
    await waitFor(() => expect(api.computerStop).toHaveBeenCalled())
  })

  /** A window that loads after something was shared learns of it at once:
   * the glyph says so without anyone opening the popover. */
  it("knows of the sharing in a window that loaded after it", async () => {
    api.computerSharedState.mockResolvedValue({ shared: [controlled] })
    mount()
    const trigger = await screen.findByRole("button", { name: "Computer use" })
    await waitFor(() => expect(trigger.title).toContain("1 window shared"))
    expect(api.computerStatus).not.toHaveBeenCalled()
  })

  /** Where the stop shortcut is in force, the Stop button names it — and
   * only then: a shortcut the OS would not take is not offered. */
  it("names the stop shortcut where it is in force", async () => {
    api.computerSharedState.mockResolvedValue({ shared: [controlled] })
    api.computerStatus.mockResolvedValue(status({ shared: [controlled] }))
    // Asked only once the listener is in place, so no change can fall
    // between the answer and the first broadcast.
    let listening: boolean | undefined
    api.computerStopKeyStatus.mockImplementation(async () => {
      listening = handlers.has("computer://stop-key")
      return { failed: "Control+Command+Escape", detail: "taken" }
    })
    mount()
    fireEvent.click(await screen.findByRole("button", { name: "Computer use" }))
    const stop = await screen.findByRole("button", { name: /^Stop sharing/ })
    await waitFor(() => expect(listening).toBe(true))
    expect(stop).not.toHaveTextContent("⌃⌘Esc")
    await waitFor(() =>
      expect(handlers.get("computer://stop-key")).toBeDefined()
    )
    act(() =>
      handlers.get("computer://stop-key")!({ active: "Control+Command+Escape" })
    )
    await waitFor(() => expect(stop).toHaveTextContent("⌃⌘Esc"))
  })

  /** Stopped is not a state: once every sharing has ended, there is nothing
   * to resume, and sharing a window is right there as the first time. */
  it("leaves nothing to resume after a Stop", async () => {
    api.computerStatus.mockResolvedValue(status({ shared: [controlled] }))
    mount()
    fireEvent.click(await screen.findByRole("button", { name: "Computer use" }))
    fireEvent.click(
      await screen.findByRole("button", { name: /^Stop sharing/ })
    )
    await waitFor(() => expect(api.computerStop).toHaveBeenCalled())
    // What the backend's state event would carry.
    act(() => setComputerShared([]))
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /^Stop sharing/ })).toBeNull()
    )
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull()
    expect(
      screen.getByRole("button", { name: "Share a window…" })
    ).toBeEnabled()
  })

  /** Recent activity can be cleared: the list goes with its button, the
   * popover keeps the focus, and what agents do next starts a new list. */
  it("clears recent activity", async () => {
    mount()
    fireEvent.click(await screen.findByRole("button", { name: "Computer use" }))
    act(() =>
      recordComputerActivity({
        targetId: "w4",
        action: "capture",
        outcome: "done",
        at: 1,
      })
    )
    await screen.findByText("Recent activity")
    const clear = screen.getByRole("button", { name: "Clear recent activity" })
    clear.focus()
    fireEvent.click(clear)
    expect(screen.queryByText("Recent activity")).toBeNull()
    expect(screen.getByRole("dialog")).toHaveFocus()

    act(() =>
      recordComputerActivity({
        targetId: "w4",
        action: "click",
        outcome: "refused",
        at: 2,
      })
    )
    expect(await screen.findByText("Click · w4")).toBeInTheDocument()
    expect(screen.queryByText(/Screenshot/)).toBeNull()
  })

  /** The switch flipped on elsewhere while the first read was in flight: the
   * read is older, and must not hide the item again. */
  it("keeps a broadcast over the older first read", async () => {
    let finishRead: (v: ComputerToolsSettings) => void = () => {}
    api.getComputerToolsSettings.mockReturnValue(
      new Promise((resolve) => {
        finishRead = resolve
      })
    )
    mount()
    await waitFor(() =>
      expect(handlers.get("computer-tools-settings://changed")).toBeDefined()
    )
    act(() =>
      handlers.get("computer-tools-settings://changed")!({
        enabled: true,
        grantTtlMinutes: 30,
        blocklist: [],
        blocklistRemoved: [],
        blocklistDefaults: [],
        stopShortcut: "",
        showIndicator: true,
        allowForeground: false,
        defaultDelivery: "background",
      })
    )
    await screen.findByRole("button", { name: "Computer use" })
    await act(async () =>
      finishRead({
        enabled: false,
        grantTtlMinutes: 30,
        blocklist: [],
        blocklistRemoved: [],
        blocklistDefaults: [],
        stopShortcut: "",
        showIndicator: true,
        allowForeground: false,
        defaultDelivery: "background",
      })
    )
    expect(
      screen.getByRole("button", { name: "Computer use" })
    ).toBeInTheDocument()
  })
})
