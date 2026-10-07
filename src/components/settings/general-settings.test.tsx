import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

// Shared by the module mock and by `shellsResolving` below, so a test that
// re-stubs the call can vary the resolved shell without restating the rows.
// `vi.hoisted` because the `vi.mock` factory is lifted above every plain
// `const` in this file.
const shellOptions = vi.hoisted(() => [
  {
    id: "system",
    label_key: "terminalSystemDefault",
    value: null,
    exists: true,
    accepts_custom_path: false,
  },
  {
    id: "custom",
    label_key: "terminalShellCustom",
    value: null,
    exists: true,
    accepts_custom_path: true,
  },
])

vi.mock("@/lib/api", () => ({
  getSystemTerminalSettings: vi.fn(async () => ({
    default_shell: null,
    colorize_command_output: false,
  })),
  getAvailableTerminalShells: vi.fn(async () => ({
    resolved_shell: "/bin/zsh",
    options: shellOptions,
  })),
  getSystemRenderingSettings: vi.fn(async () => ({
    disable_hardware_acceleration: false,
  })),
  updateSystemRenderingSettings: vi.fn(async (v: unknown) => v),
  updateSystemTerminalSettings: vi.fn(async (v: unknown) => v),
  probeTerminalShellPath: vi.fn(async () => true),
  getSystemCloseBehaviorSettings: vi.fn(async () => ({
    behavior: "ask" as const,
    tray_available: true,
  })),
  updateSystemCloseBehaviorSettings: vi.fn(async (behavior: string) => ({
    behavior,
    tray_available: true,
  })),
}))

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@/lib/platform", () => ({ isDesktop: () => true }))
vi.mock("@/lib/transport", () => ({
  getActiveRemoteConnectionId: () => null,
  // Read by the desktop-notification section to decide whether permission is
  // the browser's to grant or the OS's; `false` puts it on the browser branch,
  // which is the one with visible controls to assert on.
  isDesktop: () => false,
  getShellTransport: () => ({ call: vi.fn() }),
}))
// The rendering section is gated on the host webview having an env knob to
// flip, so the platform has to be steerable per test. `vi.hoisted` because the
// `vi.mock` factory is lifted above every plain `const` in this file.
const platform = vi.hoisted(() => ({ current: "windows" as PlatformType }))
vi.mock("@/hooks/use-platform", () => ({
  usePlatform: () => ({
    platform: platform.current,
    isMac: platform.current === "macos",
    isWindows: platform.current === "windows",
    isLinux: platform.current === "linux",
  }),
}))
vi.mock("@/lib/updater", () => ({ relaunchApp: vi.fn() }))

import { toast } from "sonner"

import {
  getAvailableTerminalShells,
  getSystemTerminalSettings,
  updateSystemTerminalSettings,
} from "@/lib/api"
import { GeneralSettings } from "./general-settings"
import type { PlatformType } from "@/hooks/use-platform"
import enMessages from "@/i18n/messages/en.json"

function renderSettings() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <GeneralSettings />
    </NextIntlClientProvider>
  )
}

/** The options list as the backend returns it, resolving to `path`. */
function shellsResolving(path: string) {
  return { resolved_shell: path, options: shellOptions }
}

/**
 * The page is a stack of sections rendered through the shared
 * `SettingsSection` / `SettingCard` / `SettingRow` grammar, so what is worth
 * pinning is the wiring that grammar carries: every row's label resolves to the
 * control it names (a `SettingRow` with the `htmlFor` left off still looks
 * right and silently loses the association), and each section actually mounts.
 */
describe("GeneralSettings", () => {
  beforeEach(() => {
    platform.current = "windows"
  })

  it("mounts every section and wires each row's label to its control", async () => {
    renderSettings()

    // Terminal section: the heading itself names the picker.
    const shell = await screen.findByLabelText("Default Terminal")
    expect(shell).toBeInTheDocument()
    expect(screen.getByText("Currently using: /bin/zsh")).toBeInTheDocument()

    // Rendering section: checkbox → Switch.
    const hwAccel = screen.getByLabelText("Disable hardware acceleration")
    expect(hwAccel).toHaveAttribute("role", "switch")
    expect(hwAccel).toHaveAttribute("data-state", "unchecked")
    fireEvent.click(hwAccel)
    await waitFor(() =>
      expect(hwAccel).toHaveAttribute("data-state", "checked")
    )

    // Every child section mounted. A section that is one option is titled by
    // that option, so these double as the labels asserted above.
    for (const heading of [
      "Default Terminal",
      "Colorize command output",
      "Disable hardware acceleration",
      "Desktop notifications",
      "Notification sounds",
    ]) {
      expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument()
    }

    // Moved out to their own pages (`collaboration-settings.test.tsx`,
    // `browser-settings.test.tsx`), which is the whole point of the split:
    // "general" now names what the page holds.
    for (const heading of [
      "Multi-Agent Collaboration",
      "In-conversation tools",
      "Built-in browser",
    ]) {
      expect(
        screen.queryByRole("heading", { name: heading })
      ).not.toBeInTheDocument()
    }
  })

  /**
   * The command-color switch ships OFF and has to stay that way — forcing
   * color on the agent breaks machine parsing of everything the agent runs, so
   * an accidental default flip is the regression worth catching. The save also
   * has to carry `default_shell` back unchanged: both settings share one stored
   * row, so a payload missing it would wipe the user's shell choice.
   */
  it("defaults command color off and preserves the shell when toggling it", async () => {
    renderSettings()

    const colorize = await screen.findByLabelText("Colorize command output")
    expect(colorize).toHaveAttribute("data-state", "unchecked")

    fireEvent.click(colorize)

    await waitFor(() =>
      expect(colorize).toHaveAttribute("data-state", "checked")
    )
    expect(vi.mocked(updateSystemTerminalSettings)).toHaveBeenCalledWith({
      default_shell: null,
      colorize_command_output: true,
    })
  })

  /**
   * A failed load is the one state where the switch must not be operable. The
   * save replaces the whole stored row, so a toggle made before the row was
   * read would send `default_shell: null` — indistinguishable from "the user
   * picked the system shell" — and quietly discard a configured shell path.
   * The picker is already inert here; the switch has to be too.
   */
  it("keeps the command-color switch inert when the settings fail to load", async () => {
    vi.mocked(updateSystemTerminalSettings).mockClear()
    vi.mocked(getSystemTerminalSettings).mockRejectedValueOnce(
      new Error("backend unreachable")
    )

    renderSettings()

    const colorize = await screen.findByLabelText("Colorize command output")
    expect(colorize).toBeDisabled()

    fireEvent.click(colorize)

    await waitFor(() =>
      expect(
        screen.getByText(/Load failed: backend unreachable/)
      ).toBeInTheDocument()
    )
    expect(vi.mocked(updateSystemTerminalSettings)).not.toHaveBeenCalled()
    expect(colorize).toHaveAttribute("data-state", "unchecked")
  })

  /**
   * The other end of the same coupling: once a shell save has landed, the
   * color toggle has to echo the NEW shell back. The save is followed by a
   * fallible options refresh, and a failure there used to leave the remembered
   * shell one revision behind — so the next toggle would faithfully resend the
   * superseded value and undo a save the user watched succeed.
   */
  it("keeps a just-saved shell when the options refresh fails", async () => {
    vi.mocked(updateSystemTerminalSettings).mockClear()
    vi.mocked(toast.error).mockClear()
    // A stored path outside the option list renders the custom-path row, which
    // is the save route that needs no Select interaction.
    vi.mocked(getSystemTerminalSettings).mockResolvedValueOnce({
      default_shell: "/opt/fish",
      colorize_command_output: false,
    })

    renderSettings()

    const path = await screen.findByLabelText("Shell path")
    fireEvent.change(path, { target: { value: "/opt/fish2" } })

    // The save lands; only the refresh that follows it fails.
    vi.mocked(getAvailableTerminalShells).mockRejectedValueOnce(
      new Error("options unavailable")
    )
    // Several sections have a "Save"; this one sits in the input's own row.
    const shellRow = path.parentElement as HTMLElement
    fireEvent.click(within(shellRow).getByRole("button", { name: "Save" }))

    await waitFor(() =>
      expect(vi.mocked(updateSystemTerminalSettings)).toHaveBeenCalledWith({
        default_shell: "/opt/fish2",
        colorize_command_output: false,
      })
    )

    // ...and the user is not told the save failed. It didn't: the row is
    // written, the shell is already live. Reporting the refresh as a failed
    // save sends them to re-save a setting that is already stored.
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled()

    const colorize = screen.getByLabelText("Colorize command output")
    await waitFor(() => expect(colorize).toBeEnabled())
    fireEvent.click(colorize)

    await waitFor(() =>
      expect(vi.mocked(updateSystemTerminalSettings)).toHaveBeenLastCalledWith({
        default_shell: "/opt/fish2",
        colorize_command_output: true,
      })
    )
  })

  /**
   * The picker moves ahead of the save so it feels immediate, which makes a
   * REJECTED save the one state where it can name a shell nothing uses — not
   * the line under it, not a new terminal tab, not an agent's command. The
   * toast that said so scrolls away; the wrong selection does not.
   */
  it("puts the picker back when the save is rejected", async () => {
    vi.mocked(getSystemTerminalSettings).mockResolvedValueOnce({
      default_shell: "/opt/fish",
      colorize_command_output: false,
    })
    vi.mocked(getAvailableTerminalShells).mockResolvedValueOnce(
      shellsResolving("/opt/fish")
    )
    vi.mocked(updateSystemTerminalSettings).mockRejectedValueOnce(
      new Error("disk full")
    )

    renderSettings()

    // A stored path outside the option list selects the custom row, so there
    // is a second option to switch away to.
    const picker = await screen.findByLabelText("Default Terminal")
    expect(picker).toHaveTextContent("Custom path")

    fireEvent.keyDown(picker, { key: "Enter" })
    fireEvent.click(await screen.findByText("System default"))

    await waitFor(() =>
      expect(vi.mocked(updateSystemTerminalSettings)).toHaveBeenLastCalledWith({
        default_shell: null,
        colorize_command_output: false,
      })
    )
    await waitFor(() => expect(picker).toHaveTextContent("Custom path"))
    // The stored shell is untouched, so the line under the picker keeps
    // naming it — picker and line agree again.
    expect(screen.getByText("Currently using: /opt/fish")).toBeInTheDocument()
  })

  /**
   * "Currently using" is the only place the page says what the choice actually
   * resolves to, and the backend answers that per selection — so the page has
   * to re-read it after every save. Leaving the first answer on screen is what
   * made the line read as a constant (always the host's `COMSPEC`/`SHELL`)
   * however the picker was set, which reads as "this setting does nothing".
   */
  it("re-reads the resolved shell after a save", async () => {
    vi.mocked(getSystemTerminalSettings).mockResolvedValueOnce({
      default_shell: "/opt/fish",
      colorize_command_output: false,
    })
    vi.mocked(getAvailableTerminalShells).mockResolvedValueOnce(
      shellsResolving("/opt/fish")
    )

    renderSettings()

    expect(
      await screen.findByText("Currently using: /opt/fish")
    ).toBeInTheDocument()

    const path = screen.getByLabelText("Shell path")
    fireEvent.change(path, { target: { value: "/opt/fish2" } })
    vi.mocked(getAvailableTerminalShells).mockResolvedValueOnce(
      shellsResolving("/opt/fish2")
    )
    const shellRow = path.parentElement as HTMLElement
    fireEvent.click(within(shellRow).getByRole("button", { name: "Save" }))

    await waitFor(() =>
      expect(
        screen.getByText("Currently using: /opt/fish2")
      ).toBeInTheDocument()
    )
  })

  // The switch only means something where the backend has an env knob to flip
  // at startup: `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` on Windows,
  // `WEBKIT_DISABLE_*` on Linux. WKWebView has neither.
  it("offers the rendering toggle on Linux too", async () => {
    platform.current = "linux"
    renderSettings()

    await screen.findByLabelText("Default Terminal")
    expect(
      screen.getByLabelText("Disable hardware acceleration")
    ).toBeInTheDocument()
  })

  it("hides the rendering toggle on macOS", async () => {
    platform.current = "macos"
    renderSettings()

    await screen.findByLabelText("Default Terminal")
    expect(
      screen.queryByLabelText("Disable hardware acceleration")
    ).not.toBeInTheDocument()
  })
})
