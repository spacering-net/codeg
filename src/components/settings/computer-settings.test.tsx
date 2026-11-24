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

vi.mock("@/lib/computer/computer-api", () => ({
  getComputerToolsSettings: vi.fn(),
  setComputerToolsPreferences: vi.fn(),
  computerAvailable: vi.fn(() => true),
  useComputerAvailable: vi.fn(() => true),
  computerServerPlatform: vi.fn(() => where.serverPlatform),
  askComputerServed: vi.fn(async () => true),
  computerStopKeyStatus: vi.fn(),
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@/hooks/use-is-mac", () => ({ useIsMac: () => false }))
/** Where the page runs: the desktop app's own machine, or a web client of a
 *  server that shares its screen (and that server's machine). */
const where = vi.hoisted(() => ({
  local: true,
  serverPlatform: null as "macos" | "windows" | "linux" | null,
}))
const platform = vi.hoisted(() => ({ isLinux: false }))
vi.mock("@/hooks/use-platform", () => ({
  usePlatform: () => ({
    platform: platform.isLinux ? "linux" : "windows",
    isMac: false,
    isWindows: !platform.isLinux,
    isLinux: platform.isLinux,
  }),
}))

const handlers = new Map<string, (p: unknown) => void>()
vi.mock("@/lib/platform", () => ({
  isLocalDesktop: () => where.local,
  subscribe: vi.fn((event: string, handler: (p: unknown) => void) => {
    handlers.set(event, handler)
    return Promise.resolve(() => {})
  }),
}))

import { ComputerSettingsSection } from "./computer-settings"
import enMessages from "@/i18n/messages/en.json"
import {
  computerStopKeyStatus,
  getComputerToolsSettings,
  setComputerToolsPreferences,
} from "@/lib/computer/computer-api"
import type { ComputerToolsSettings, DefaultBlock } from "@/lib/computer/types"

const mockGet = vi.mocked(getComputerToolsSettings)
const mockSet = vi.mocked(setComputerToolsPreferences)
const mockStopKey = vi.mocked(computerStopKeyStatus)

const DEFAULT_KEY = "Control+Alt+Escape"

const DEFAULTS: DefaultBlock[] = [
  {
    key: "system-settings",
    name: "System Settings",
    names: ["systemsettings.exe"],
  },
  {
    key: "1password",
    name: "1Password",
    names: ["1password.exe"],
  },
]

/** The record as the backend answers it. */
function record(
  overrides: Partial<ComputerToolsSettings> = {}
): ComputerToolsSettings {
  return {
    enabled: true,
    grantTtlMinutes: 30,
    blocklist: ["com.example.vault"],
    blocklistRemoved: [],
    blocklistDefaults: DEFAULTS,
    stopShortcut: DEFAULT_KEY,
    showIndicator: true,
    allowForeground: true,
    defaultDelivery: "background",
    ...overrides,
  }
}

const LABEL = "Apps that are never shared"

/** Type an entry and add it to the list. */
function addEntry(box: HTMLElement, entry: string) {
  fireEvent.change(box, { target: { value: entry } })
  fireEvent.click(screen.getByRole("button", { name: "Add" }))
}

function mount() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ComputerSettingsSection />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  handlers.clear()
  mockGet.mockResolvedValue(record())
  mockSet.mockImplementation(async (prefs) =>
    record({
      grantTtlMinutes: prefs.grantTtlMinutes ?? 30,
      blocklist: prefs.blocklist ?? ["com.example.vault"],
      blocklistRemoved: prefs.blocklistRemoved ?? [],
      stopShortcut: prefs.stopShortcut ?? DEFAULT_KEY,
      showIndicator: prefs.showIndicator ?? true,
      allowForeground: prefs.allowForeground ?? true,
      defaultDelivery: prefs.defaultDelivery ?? "background",
      launchEnabled: prefs.launchEnabled ?? false,
      clipboardEnabled: prefs.clipboardEnabled ?? false,
      screenEnabled: prefs.screenEnabled ?? false,
    })
  )
  mockStopKey.mockResolvedValue({ active: DEFAULT_KEY })
  platform.isLinux = false
  where.local = true
  where.serverPlatform = null
})

/** The shortcut button, once the stored values are in. */
async function shortcutButton(label = "Ctrl+Alt+Esc") {
  return screen.findByRole("button", { name: label })
}

function press(
  code: string,
  held: Partial<Record<"ctrlKey" | "altKey" | "shiftKey", boolean>> = {}
) {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { code, bubbles: true, ...held })
    )
  })
}

describe("ComputerSettingsSection", () => {
  /** Only what changed is written — never the switch, and not the timeout
   * when only the blocklist moved — and an entry goes out trimmed. */
  it("saves only the changed field, through the preferences writer", async () => {
    mount()
    const box = await screen.findByLabelText(LABEL)
    await screen.findByText("com.example.vault")
    await waitFor(() => expect(box).not.toBeDisabled())
    addEntry(box, "  keepass.exe  ")
    expect(box).toHaveValue("")
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(mockSet).toHaveBeenCalledTimes(1))
    expect(mockSet.mock.calls[0][0]).toEqual({
      grantTtlMinutes: undefined,
      blocklist: ["com.example.vault", "keepass.exe"],
    })
  })

  /** Any default can be taken off — System Settings too; "restore defaults",
   * once confirmed, takes off what was added and puts back what was removed.
   * Each goes out as the one field it moved. */
  it("takes a default off the list and restores the defaults", async () => {
    mount()
    const box = await screen.findByLabelText(LABEL)
    await waitFor(() => expect(box).not.toBeDisabled())
    fireEvent.click(
      screen.getByRole("button", { name: "Remove System Settings" })
    )
    fireEvent.click(screen.getByRole("button", { name: "Remove 1Password" }))
    expect(screen.queryByText("System Settings")).toBeNull()
    expect(screen.queryByText("1Password")).toBeNull()
    expect(screen.getByText("2 default apps removed.")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(mockSet).toHaveBeenCalledTimes(1))
    expect(mockSet.mock.calls[0][0]).toEqual({
      blocklistRemoved: ["system-settings", "1password"],
    })

    await waitFor(() => expect(box).not.toBeDisabled())
    fireEvent.click(screen.getByRole("button", { name: "Restore defaults" }))
    const confirm = await screen.findByRole("alertdialog")
    expect(
      within(confirm).getByText("The app you added comes off the list.")
    ).toBeInTheDocument()
    expect(
      within(confirm).getByText(
        "The 2 default apps you removed go back on the list."
      )
    ).toBeInTheDocument()
    fireEvent.click(
      within(confirm).getByRole("button", { name: "Restore defaults" })
    )
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    expect(screen.getByText("System Settings")).toBeInTheDocument()
    expect(screen.getByText("1Password")).toBeInTheDocument()
    expect(screen.queryByText("com.example.vault")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(mockSet).toHaveBeenCalledTimes(2))
    expect(mockSet.mock.calls[1][0]).toEqual({
      blocklist: [],
      blocklistRemoved: [],
    })
  })

  /** Restoring asks first — the person's own entries go with it — and
   * backing out of the question changes nothing, and puts the focus back on
   * the button it was asked from. */
  it("leaves the list alone when the restore is not confirmed", async () => {
    mount()
    const box = await screen.findByLabelText(LABEL)
    await waitFor(() => expect(box).not.toBeDisabled())
    const restore = screen.getByRole("button", { name: "Restore defaults" })
    restore.focus()
    fireEvent.click(restore)
    const confirm = await screen.findByRole("alertdialog")
    expect(within(confirm).queryByText(/default apps? you removed/)).toBeNull()
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    expect(screen.getByText("com.example.vault")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
    await waitFor(() => expect(restore).toHaveFocus())
  })

  /** An entry already on the list is refused; a default that was taken off
   * is put back when typed again. */
  it("refuses a duplicate and puts a removed default back", async () => {
    mockGet.mockResolvedValue(record({ blocklistRemoved: ["1password"] }))
    mount()
    const box = await screen.findByLabelText(LABEL)
    await waitFor(() => expect(box).not.toBeDisabled())
    addEntry(box, "COM.EXAMPLE.VAULT")
    expect(screen.getByText("Already on the list.")).toBeInTheDocument()
    addEntry(box, "1Password.exe")
    expect(screen.getByText("1Password")).toBeInTheDocument()
    expect(screen.queryByText(/default app removed/)).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(mockSet).toHaveBeenCalledTimes(1))
    expect(mockSet.mock.calls[0][0]).toEqual({ blocklistRemoved: [] })
  })

  /** A default goes by the name the list shows too: typed that way it is
   * put back, or found to be on the list already. */
  it("knows a default by the name it is shown under", async () => {
    mockGet.mockResolvedValue(record({ blocklistRemoved: ["1password"] }))
    mount()
    const box = await screen.findByLabelText(LABEL)
    await waitFor(() => expect(box).not.toBeDisabled())
    addEntry(box, "system settings")
    expect(screen.getByText("Already on the list.")).toBeInTheDocument()
    addEntry(box, "1Password")
    expect(screen.getByText("1Password")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(mockSet).toHaveBeenCalledTimes(1))
    expect(mockSet.mock.calls[0][0]).toEqual({ blocklistRemoved: [] })
  })

  /** Another window's save moves the fields this form has not touched and
   * leaves the one it has; saving then writes only that one. */
  it("merges a save made elsewhere into the fields it did not touch", async () => {
    mount()
    const box = await screen.findByLabelText(LABEL)
    await waitFor(() => expect(box).not.toBeDisabled())
    await waitFor(() =>
      expect(handlers.get("computer-tools-settings://changed")).toBeDefined()
    )
    fireEvent.click(
      screen.getByRole("button", { name: "Remove com.example.vault" })
    )
    addEntry(box, "com.example.mine")
    act(() => {
      handlers.get("computer-tools-settings://changed")!(
        record({
          grantTtlMinutes: 60,
          blocklist: ["com.example.vault", "org.example.theirs"],
        })
      )
    })
    expect(screen.getByText("com.example.mine")).toBeInTheDocument()
    expect(screen.queryByText("org.example.theirs")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(mockSet).toHaveBeenCalledTimes(1))
    expect(mockSet.mock.calls[0][0]).toEqual({
      grantTtlMinutes: undefined,
      blocklist: ["com.example.mine"],
    })
  })

  /** A form that could not read the stored values shows no defaults to save
   * over them: it stays locked until a read succeeds. */
  it("stays locked after a failed read until one succeeds", async () => {
    mockGet.mockRejectedValueOnce(new Error("offline"))
    mount()
    const box = await screen.findByLabelText(LABEL)
    await screen.findByText(/offline/)
    expect(box).toBeDisabled()
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }))
    await screen.findByText("com.example.vault")
    await waitFor(() => expect(box).not.toBeDisabled())
  })

  /** Nothing can be edited while a save is on its way: its answer replaces
   * the fields. */
  it("locks the fields while saving", async () => {
    let finish: (
      v: Awaited<ReturnType<typeof setComputerToolsPreferences>>
    ) => void = () => {}
    mockSet.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    mount()
    const box = await screen.findByLabelText(LABEL)
    await waitFor(() => expect(box).not.toBeDisabled())
    addEntry(box, "com.example.new")
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(box).toBeDisabled())
    await act(async () => {
      finish(record({ blocklist: ["com.example.new"] }))
    })
    await waitFor(() => expect(box).not.toBeDisabled())
    expect(screen.getByText("com.example.new")).toBeInTheDocument()
    expect(screen.queryByText("com.example.vault")).toBeNull()
  })

  it("has nothing to save until something changes", async () => {
    mount()
    await screen.findByLabelText(LABEL)
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
    )
  })

  /** Another window saved the record: an untouched form follows it. */
  it("follows a save made elsewhere", async () => {
    mount()
    await screen.findByLabelText(LABEL)
    await waitFor(() =>
      expect(handlers.get("computer-tools-settings://changed")).toBeDefined()
    )
    act(() => {
      handlers.get("computer-tools-settings://changed")!(
        record({
          grantTtlMinutes: 60,
          blocklist: ["org.example.other"],
          blocklistRemoved: ["1password"],
        })
      )
    })
    await screen.findByText("org.example.other")
    expect(screen.queryByText("1Password")).toBeNull()
  })

  /** New keys are recorded off the physical keys, and saved as the one
   * spelling — alone, like every other field. */
  it("records a new stop shortcut and saves only it", async () => {
    mount()
    fireEvent.click(await shortcutButton())
    expect(screen.getByRole("button", { name: "Press keys…" })).toBeVisible()
    press("ControlLeft", { ctrlKey: true })
    press("KeyK", { ctrlKey: true, shiftKey: true })
    await shortcutButton("Ctrl+Shift+K")
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(mockSet).toHaveBeenCalledTimes(1))
    expect(mockSet.mock.calls[0][0]).toEqual({
      stopShortcut: "Control+Shift+KeyK",
    })
  })

  /** Keys too easy to press, or not on the list, are refused where they are
   * pressed; Escape alone gives up and keeps what was there. */
  it("refuses keys that would make a poor stop shortcut", async () => {
    mount()
    fireEvent.click(await shortcutButton())
    press("KeyK", { ctrlKey: true })
    expect(
      screen.getByText(
        "Hold at least two modifiers, one of them Ctrl (or ⌘ on a Mac)."
      )
    ).toBeVisible()
    press("Space", { ctrlKey: true, altKey: true })
    expect(screen.getByText(/That key can't be used/)).toBeVisible()
    press("Escape")
    await shortcutButton()
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
  })

  it("can be switched off, and back to the default", async () => {
    mount()
    await shortcutButton()
    expect(
      screen.queryByRole("button", { name: "Default" })
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Turn off" }))
    await shortcutButton("Off")
    fireEvent.click(screen.getByRole("button", { name: "Default" }))
    await shortcutButton()
    fireEvent.click(screen.getByRole("button", { name: "Turn off" }))
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(mockSet).toHaveBeenCalledTimes(1))
    expect(mockSet.mock.calls[0][0]).toEqual({ stopShortcut: "" })
  })

  /** Whether the OS holds the keys is said, so nobody counts on a shortcut
   * that does nothing — and it follows the backend's news. */
  it("says whether the shortcut is in force", async () => {
    mockStopKey.mockResolvedValue({ failed: DEFAULT_KEY, detail: "taken" })
    mount()
    await screen.findByText(
      "Not active: another app is probably using these keys. Choose others."
    )
    await waitFor(() =>
      expect(handlers.get("computer://stop-key")).toBeDefined()
    )
    act(() => {
      handlers.get("computer://stop-key")!({ active: DEFAULT_KEY })
    })
    await screen.findByText(
      "Active: press it anywhere to stop sharing every window."
    )
  })

  /** Until the stored shortcut has been read, the row claims nothing — not
   * even "off". */
  it("says nothing of the shortcut it has not read", async () => {
    mockGet.mockRejectedValueOnce(new Error("offline"))
    mount()
    await screen.findByText(/offline/)
    expect(screen.getByRole("button", { name: "…" })).toBeDisabled()
    expect(screen.queryByRole("button", { name: "Off" })).toBeNull()
    expect(screen.queryByText(/^Off:/)).toBeNull()
  })

  /** A save locks the row and ends recording: keys pressed while it is on
   * its way are not caught, only to be overwritten by its answer. */
  it("stops recording when a save locks the row", async () => {
    let finish: (
      v: Awaited<ReturnType<typeof setComputerToolsPreferences>>
    ) => void = () => {}
    mockSet.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    mount()
    const box = await screen.findByLabelText(LABEL)
    await waitFor(() => expect(box).not.toBeDisabled())
    fireEvent.click(
      screen.getByRole("button", { name: "Remove com.example.vault" })
    )
    addEntry(box, "com.example.new")
    fireEvent.click(await shortcutButton())
    await screen.findByRole("button", { name: "Press keys…" })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(box).toBeDisabled())
    press("KeyK", { ctrlKey: true, shiftKey: true })
    expect(screen.queryByRole("button", { name: "Press keys…" })).toBeNull()
    await act(async () => {
      finish(record({ blocklist: ["com.example.new"] }))
    })
    await shortcutButton()
    expect(mockSet.mock.calls[0][0]).toEqual({
      blocklist: ["com.example.new"],
    })
  })

  /** The floating stop bar is one more field: on unless turned off, and
   *  saved alone. */
  it("turns the floating stop bar off, saving only that", async () => {
    mount()
    const strip = await screen.findByRole("switch", {
      name: "Floating stop bar",
    })
    await waitFor(() => expect(strip).not.toBeDisabled())
    expect(strip).toBeChecked()
    fireEvent.click(strip)
    expect(strip).not.toBeChecked()
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(mockSet).toHaveBeenCalledTimes(1))
    expect(mockSet.mock.calls[0][0]).toEqual({ showIndicator: false })
    await waitFor(() => expect(strip).not.toBeDisabled())
    expect(strip).not.toBeChecked()
  })

  it("says the shortcut waits for computer use to be switched on", async () => {
    mockGet.mockResolvedValue(record({ enabled: false, blocklist: [] }))
    mockStopKey.mockResolvedValue({})
    mount()
    await screen.findByText("Takes effect while computer use is switched on.")
  })

  /** Bringing windows to the front is on out of the box, with Background
   *  the default input mode; making Foreground the default saves that, and
   *  nothing else. */
  it("lets agents bring windows to the front, and can make it the default", async () => {
    const user = userEvent.setup()
    mount()
    const front = await screen.findByRole("switch", {
      name: "Let agents bring windows to the front",
    })
    await waitFor(() => expect(front).not.toBeDisabled())
    const mode = () =>
      screen.getByRole("combobox", { name: "Default input mode" })
    expect(front).toBeChecked()
    expect(mode()).toHaveTextContent("Background")
    expect(mode()).not.toBeDisabled()
    await user.click(mode())
    const list = await screen.findByRole("listbox")
    await user.click(within(list).getByRole("option", { name: "Foreground" }))
    expect(mode()).toHaveTextContent("Foreground")
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(mockSet).toHaveBeenCalledTimes(1))
    expect(mockSet.mock.calls[0][0]).toEqual({ defaultDelivery: "foreground" })
  })

  /** Switched off, the default input mode is Background and cannot be
   *  moved; only the switch is saved. */
  it("switches bringing windows to the front off, saving only that", async () => {
    mount()
    const front = await screen.findByRole("switch", {
      name: "Let agents bring windows to the front",
    })
    await waitFor(() => expect(front).not.toBeDisabled())
    const mode = () =>
      screen.getByRole("combobox", { name: "Default input mode" })
    fireEvent.click(front)
    expect(front).not.toBeChecked()
    expect(mode()).toHaveTextContent("Background")
    expect(mode()).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(mockSet).toHaveBeenCalledTimes(1))
    expect(mockSet.mock.calls[0][0]).toEqual({ allowForeground: false })
  })

  /** Starting applications and moving windows is off until the person
   *  turns it on; turning it on saves only that. */
  it("lets agents open applications and move windows, saving only that", async () => {
    mount()
    const launch = await screen.findByRole("switch", {
      name: "Let agents open applications and move windows",
    })
    await waitFor(() => expect(launch).not.toBeDisabled())
    expect(launch).not.toBeChecked()
    fireEvent.click(launch)
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(mockSet).toHaveBeenCalledTimes(1))
    expect(mockSet.mock.calls[0][0]).toEqual({ launchEnabled: true })
  })

  /** The clipboard tools are off until the person turns them on; turning
   *  them on saves only that. */
  it("lets agents use the clipboard, saving only that", async () => {
    mount()
    const clipboard = await screen.findByRole("switch", {
      name: "Let agents use the clipboard",
    })
    await waitFor(() => expect(clipboard).not.toBeDisabled())
    expect(clipboard).not.toBeChecked()
    fireEvent.click(clipboard)
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(mockSet).toHaveBeenCalledTimes(1))
    expect(mockSet.mock.calls[0][0]).toEqual({ clipboardEnabled: true })
  })

  /** The entire screen is not offered until the person turns it on;
   *  turning it on saves only that. */
  it("offers the entire screen, saving only that", async () => {
    mount()
    const offer = await screen.findByRole("switch", {
      name: "Offer the entire screen",
    })
    await waitFor(() => expect(offer).not.toBeDisabled())
    expect(offer).not.toBeChecked()
    fireEvent.click(offer)
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(mockSet).toHaveBeenCalledTimes(1))
    expect(mockSet.mock.calls[0][0]).toEqual({ screenEnabled: true })
  })

  /** A server that shares its screen has no stop shortcut and no floating
   *  bar — its Stop is in this panel — and offers the entire screen where
   *  its own machine can, whatever machine this page shows on. */
  it("on a server, leaves out what only the desktop app has", async () => {
    where.local = false
    where.serverPlatform = "windows"
    platform.isLinux = true
    mount()
    await screen.findByRole("switch", { name: "Let agents use the clipboard" })
    expect(
      screen.getByRole("switch", { name: "Offer the entire screen" })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("switch", { name: "Floating stop bar" })
    ).toBeNull()
    expect(screen.queryByText("Stop shortcut")).toBeNull()
  })

  /** A Linux server offers no entire screen, whatever machine the page
   *  shows on. */
  it("on a Linux server, has no entire screen to offer", async () => {
    where.local = false
    where.serverPlatform = "linux"
    mount()
    await screen.findByRole("switch", { name: "Let agents use the clipboard" })
    expect(
      screen.queryByRole("switch", { name: "Offer the entire screen" })
    ).toBeNull()
  })

  /** Linux is not offered the entire screen, so there is nothing to turn
   *  on there. */
  it("has no entire screen to offer on Linux", async () => {
    platform.isLinux = true
    mount()
    await screen.findByRole("switch", { name: "Let agents use the clipboard" })
    expect(
      screen.queryByRole("switch", { name: "Offer the entire screen" })
    ).toBeNull()
  })

  /** A default of the front chosen before shows as Background while the
   *  front is not allowed — that is what an action gets then — and comes
   *  back when it is allowed again. */
  it("shows the front as the default only while it is allowed", async () => {
    mockGet.mockResolvedValue(
      record({ allowForeground: false, defaultDelivery: "foreground" })
    )
    mount()
    const front = await screen.findByRole("switch", {
      name: "Let agents bring windows to the front",
    })
    await waitFor(() => expect(front).not.toBeDisabled())
    const mode = () =>
      screen.getByRole("combobox", { name: "Default input mode" })
    expect(mode()).toHaveTextContent("Background")
    fireEvent.click(front)
    expect(mode()).toHaveTextContent("Foreground")
  })
})
