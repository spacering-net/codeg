import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type {
  ComputerStatus,
  ComputerToolsSettings,
  DriverInfo,
} from "@/lib/computer/types"

const api = vi.hoisted(() => ({
  computerAvailable: vi.fn(() => true),
  useComputerAvailable: () => api.computerAvailable(),
  askComputerServed: vi.fn(async () => api.computerAvailable()),
  subscribeComputerServed: vi.fn(() => () => {}),
  computerServerPlatform: vi.fn(() => null),
  getComputerToolsSettings: vi.fn<() => Promise<ComputerToolsSettings>>(),
  setComputerToolsEnabled:
    vi.fn<(enabled: boolean) => Promise<ComputerToolsSettings>>(),
  setComputerToolsPreferences: vi.fn(),
  computerStopKeyStatus: vi.fn(async () => ({})),
  computerStatus: vi.fn<() => Promise<ComputerStatus>>(),
  computerRequestPermission: vi.fn(async () => ({
    report: { required: true, accessibility: true, screenRecording: false },
    prompted: false,
  })),
  computerOpenPermissionSettings: vi.fn(async () => {}),
  computerRevealHelper: vi.fn(async () => {}),
  computerDriverInfo: vi.fn<() => Promise<DriverInfo>>(),
  computerDriverInstall: vi.fn<() => Promise<DriverInfo>>(),
  computerDriverUninstall: vi.fn<() => Promise<DriverInfo>>(),
}))
vi.mock("@/lib/computer/computer-api", () => api)
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@/hooks/use-is-mac", () => ({ useIsMac: () => true }))
const handlers = new Map<string, (p: unknown) => void>()
vi.mock("@/lib/platform", () => ({
  isLocalDesktop: () => true,
  subscribe: vi.fn((event: string, handler: (p: unknown) => void) => {
    handlers.set(event, handler)
    return Promise.resolve(() => {})
  }),
}))

import { ComputerUseSettings } from "./computer-use-settings"
import enMessages from "@/i18n/messages/en.json"

function settings(enabled: boolean): ComputerToolsSettings {
  return {
    enabled,
    grantTtlMinutes: 30,
    blocklist: [],
    blocklistRemoved: [],
    blocklistDefaults: [],
    stopShortcut: "Control+Command+Escape",
    showIndicator: true,
    allowForeground: false,
    defaultDelivery: "background",
  }
}

function driver(overrides: Partial<DriverInfo> = {}): DriverInfo {
  return {
    version: "0.28.2",
    supported: true,
    installed: [],
    ...overrides,
  }
}

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
      <ComputerUseSettings />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  handlers.clear()
  api.computerAvailable.mockReturnValue(true)
  api.getComputerToolsSettings.mockResolvedValue(settings(false))
  api.setComputerToolsEnabled.mockImplementation(async (enabled) =>
    settings(enabled)
  )
  api.computerDriverInfo.mockResolvedValue(driver())
  api.computerStatus.mockResolvedValue(status())
})

describe("ComputerUseSettings", () => {
  /** The switch is the page's first line, and writes the one setting every
   *  other switch for computer use writes too. */
  it("switches computer use on", async () => {
    mount()
    const toggle = await screen.findByRole("switch", {
      name: "Enable computer use",
    })
    await waitFor(() => expect(toggle).not.toBeDisabled())
    expect(toggle).not.toBeChecked()
    fireEvent.click(toggle)
    await waitFor(() =>
      expect(api.setComputerToolsEnabled).toHaveBeenCalledWith(true)
    )
    await waitFor(() => expect(toggle).toBeChecked())
  })

  /** Another window's write that lands while this one's is on its way is
   *  newer than this one's answer. */
  it("keeps a broadcast over its own older answer", async () => {
    let answer: (s: ComputerToolsSettings) => void = () => {}
    api.setComputerToolsEnabled.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve
      })
    )
    mount()
    const toggle = await screen.findByRole("switch", {
      name: "Enable computer use",
    })
    await waitFor(() => expect(toggle).not.toBeDisabled())
    fireEvent.click(toggle)
    act(() =>
      handlers.get("computer-tools-settings://changed")!(settings(false))
    )
    await act(async () => answer(settings(true)))
    expect(toggle).not.toBeChecked()
  })

  /** No driver yet: it says so and offers to fetch it now. */
  it("installs the driver", async () => {
    api.computerDriverInstall.mockResolvedValue(
      driver({ installed: ["0.28.2"], path: "/cache/cua-driver" })
    )
    mount()
    expect(await screen.findByText(/^Not installed\./)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Install" }))
    await waitFor(() => expect(api.computerDriverInstall).toHaveBeenCalled())
    expect(await screen.findByText("Installed · 0.28.2")).toBeInTheDocument()
    expect(screen.getByText("/cache/cua-driver")).toBeInTheDocument()
  })

  /** An older release in the cache is an upgrade to the one this codeg
   *  runs — never a choice of another. */
  it("offers the pinned release over an older one", async () => {
    api.computerDriverInfo.mockResolvedValue(driver({ installed: ["0.27.0"] }))
    mount()
    expect(
      await screen.findByText("0.27.0 is installed; this codeg runs 0.28.2.")
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Upgrade to 0.28.2" })
    ).toBeInTheDocument()
  })

  /** A download reports how far it has got, as it goes. */
  it("shows how far an install has got", async () => {
    mount()
    await screen.findByText(/^Not installed\./)
    await waitFor(() => expect(handlers.get("computer://driver")).toBeDefined())
    act(() =>
      handlers.get("computer://driver")!(
        driver({
          task: { kind: "installing", downloadedMb: 12, totalMb: 41.6 },
        })
      )
    )
    expect(
      await screen.findByText("Downloading… 12 / 41.6 MB")
    ).toBeInTheDocument()
    expect(screen.getByRole("progressbar")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull()
  })

  /** Removing it is confirmed first — it switches computer use off. */
  it("uninstalls the driver after asking", async () => {
    api.computerDriverInfo.mockResolvedValue(
      driver({ installed: ["0.28.2"], path: "/cache/cua-driver" })
    )
    api.computerDriverUninstall.mockResolvedValue(driver())
    mount()
    fireEvent.click(await screen.findByRole("button", { name: "Uninstall" }))
    expect(
      await screen.findByText(/Computer use will be switched off/)
    ).toBeInTheDocument()
    expect(api.computerDriverUninstall).not.toHaveBeenCalled()
    const confirm = screen
      .getAllByRole("button", { name: "Uninstall" })
      .find((b) => b.closest("[role=alertdialog]"))!
    fireEvent.click(confirm)
    await waitFor(() => expect(api.computerDriverUninstall).toHaveBeenCalled())
  })

  /** The helper's permissions are only there to ask about while computer
   *  use is on; then each missing one can be requested — and codeg holding
   *  one itself is said, not held against anything. */
  it("shows the helper's permissions while computer use is on", async () => {
    mount()
    expect(
      await screen.findByText(
        "Switch computer use on to check and grant permissions."
      )
    ).toBeInTheDocument()
    expect(api.computerStatus).not.toHaveBeenCalled()

    api.computerStatus.mockResolvedValue(
      status({
        codeg: {
          accessibility: true,
          screenRecording: false,
          selfResponsible: true,
        },
      })
    )
    await waitFor(() =>
      expect(handlers.get("computer-tools-settings://changed")).toBeDefined()
    )
    act(() =>
      handlers.get("computer-tools-settings://changed")!(settings(true))
    )
    fireEvent.click(await screen.findByRole("button", { name: "Grant…" }))
    await waitFor(() =>
      expect(api.computerRequestPermission).toHaveBeenCalledWith(
        "screenRecording"
      )
    )
    expect(
      screen.getByText(/codeg itself has Accessibility/)
    ).toBeInTheDocument()
  })

  /** In a browser session there is no screen here to manage: the switch and
   *  the sharing settings stay, the driver and permissions do not. */
  it("keeps only the settings in a browser session", async () => {
    api.computerAvailable.mockReturnValue(false)
    mount()
    expect(
      await screen.findByRole("switch", { name: "Enable computer use" })
    ).toBeInTheDocument()
    expect(screen.queryByText("Driver")).toBeNull()
    expect(screen.queryByText("Permissions")).toBeNull()
    expect(api.computerDriverInfo).not.toHaveBeenCalled()
  })
})
