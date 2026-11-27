import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import messages from "@/i18n/messages/en.json"
import { SpaceRingOnlineSettings } from "./spacering-online-settings"

const shell = vi.hoisted(() => ({
  call: vi.fn(),
  subscribe: vi.fn(),
  local: true,
}))
vi.mock("@/lib/transport", () => ({ getShellTransport: () => shell }))
vi.mock("@/lib/platform", () => ({ isLocalDesktop: () => shell.local }))
vi.mock("@/lib/harness/status", () => ({
  refreshHarnessStatus: async () => {},
}))

function mount() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <SpaceRingOnlineSettings />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  shell.local = true
  shell.subscribe.mockResolvedValue(() => {})
})
afterEach(() => vi.resetAllMocks())

describe("SpaceRing online services", () => {
  it("saves an immediate local preference and reads the new value", async () => {
    let enabled = true
    shell.call.mockImplementation(async (cmd, args) => {
      if (cmd === "srn_set_online_settings") enabled = args.enabled
      return { enabled, managed: false }
    })
    mount()
    const toggle = await screen.findByRole("switch", {
      name: "SpaceRing online services",
    })
    await userEvent.click(toggle)
    expect(shell.call).toHaveBeenCalledWith("srn_set_online_settings", {
      enabled: false,
    })
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("false")
    )
  })

  it("shows a host-enforced preference as locked", async () => {
    shell.call.mockResolvedValue({ enabled: false, managed: true })
    mount()
    const toggle = await screen.findByRole("switch")
    expect(toggle.hasAttribute("disabled")).toBe(true)
    expect(screen.getByText(/CODEG_SRN/)).toBeTruthy()
  })

  it("lets the user retry a failed read", async () => {
    shell.call
      .mockRejectedValueOnce(new Error("Unavailable"))
      .mockResolvedValue({ enabled: false, managed: false })
    mount()
    await userEvent.click(await screen.findByRole("button", { name: "Retry" }))
    expect(
      (await screen.findByRole("switch")).getAttribute("aria-checked")
    ).toBe("false")
  })

  it("never exposes a host preference writer to remote or browser settings", () => {
    shell.local = false
    mount()
    expect(screen.queryByRole("switch")).toBeNull()
    expect(shell.call).not.toHaveBeenCalled()
  })
})
