import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { SystemCloseBehaviorSettingsView } from "@/lib/types"

const getSettings = vi.fn<() => Promise<SystemCloseBehaviorSettingsView>>()
const updateSettings =
  vi.fn<(b: string) => Promise<SystemCloseBehaviorSettingsView>>()
const toastError = vi.fn()
let desktop = true
let remoteConnectionId: number | null = null

vi.mock("@/lib/api", () => ({
  getSystemCloseBehaviorSettings: () => getSettings(),
  updateSystemCloseBehaviorSettings: (b: string) => updateSettings(b),
}))
vi.mock("@/lib/platform", () => ({ isDesktop: () => desktop }))
vi.mock("@/lib/transport", () => ({
  getActiveRemoteConnectionId: () => remoteConnectionId,
}))
vi.mock("sonner", () => ({ toast: { error: (m: string) => toastError(m) } }))

import { CloseBehaviorSettingsSection } from "./close-behavior-settings"

function renderSection() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <CloseBehaviorSettingsSection />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  desktop = true
  remoteConnectionId = null
  toastError.mockClear()
  getSettings.mockReset()
  updateSettings.mockReset()
  getSettings.mockResolvedValue({ behavior: "ask", tray_available: true })
})
afterEach(() => cleanup())

describe("CloseBehaviorSettingsSection", () => {
  it("shows the stored preference", async () => {
    getSettings.mockResolvedValue({
      behavior: "minimize",
      tray_available: true,
    })
    renderSection()
    expect(await screen.findByText("Minimize to tray")).toBeInTheDocument()
  })

  it("persists a new choice", async () => {
    const user = userEvent.setup()
    updateSettings.mockResolvedValue({
      behavior: "exit",
      tray_available: true,
    })
    renderSection()

    await user.click(await screen.findByRole("combobox"))
    await user.click(await screen.findByRole("option", { name: "Exit codeg" }))

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith("exit"))
  })

  it("reverts the picker when the write fails", async () => {
    const user = userEvent.setup()
    updateSettings.mockRejectedValue(new Error("db locked"))
    renderSection()

    await user.click(await screen.findByRole("combobox"))
    await user.click(await screen.findByRole("option", { name: "Exit codeg" }))

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    // A picker left showing "exit" would claim a preference the next launch
    // will not honour.
    expect(await screen.findByText("Ask every time")).toBeInTheDocument()
  })

  it("disables the picker and says why when there is no tray", async () => {
    getSettings.mockResolvedValue({ behavior: "exit", tray_available: false })
    renderSection()

    expect(
      await screen.findByText(
        "This system has no usable tray, so the close button always exits codeg."
      )
    ).toBeInTheDocument()
    expect(screen.getByRole("combobox")).toBeDisabled()
  })

  it("stays out of the settings page on web and remote workspaces", async () => {
    desktop = false
    const { unmount } = renderSection()
    await waitFor(() => expect(getSettings).not.toHaveBeenCalled())
    expect(screen.queryByRole("combobox")).toBeNull()
    unmount()

    desktop = true
    remoteConnectionId = 3
    renderSection()
    await waitFor(() => expect(getSettings).not.toHaveBeenCalled())
    expect(screen.queryByRole("combobox")).toBeNull()
  })
})
