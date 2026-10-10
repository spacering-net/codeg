import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { RemoteTransportConfig } from "@/lib/transport"
import type { RemoteWorkspaceConnection } from "@/lib/types"

// The gate's two dead ends — a connection that could not be loaded, and one
// whose credentials expired — render instead of the whole workspace, Quick
// actions included. These tests pin the way back to the local workspace that
// those screens carry themselves.
const mocks = vi.hoisted(() => ({
  desktop: true,
  configureRemoteDesktopTransport: vi.fn(),
  getRemoteWorkspaceConnection: vi.fn(),
  openLocalWorkspace: vi.fn(() => Promise.resolve()),
}))

vi.mock("next/navigation", () => {
  const params = new URLSearchParams(
    "remoteConnectionId=12&remoteWindowId=rw-test"
  )
  return { useSearchParams: () => params }
})

vi.mock("@/lib/transport", () => ({
  clearRemoteDesktopTransport: vi.fn(),
  configureRemoteDesktopTransport: mocks.configureRemoteDesktopTransport,
  getTransport: vi.fn(),
}))

vi.mock("@/lib/platform", () => ({ isDesktop: () => mocks.desktop }))

// The gate shows the connection pill while it lets the workspace through.
vi.mock("@/components/connection/remote-connection-status", () => ({
  RemoteConnectionStatus: () => null,
}))

vi.mock("@/lib/remote-workspace", () => ({
  getRemoteWorkspaceConnection: mocks.getRemoteWorkspaceConnection,
  openLocalWorkspace: mocks.openLocalWorkspace,
}))

vi.mock("@/stores/backend-scoped-store-reset", () => ({
  resetBackendScopedStores: vi.fn(),
  registerBackendScopedStoreReset: vi.fn(),
  __clearRegisteredBackendScopedStoreResets: vi.fn(),
}))

import { RemoteConnectionGate } from "./remote-connection-context"
import enMessages from "@/i18n/messages/en.json"

const CONNECTION: RemoteWorkspaceConnection = {
  id: 12,
  name: "lab-box",
  base_url: "https://lab.example",
  token: "t",
  headers: [],
  sort_order: 0,
  created_at: "",
  updated_at: "",
}

const OPEN_LOCAL = { name: "Open local workspace" }

function mountGate() {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <RemoteConnectionGate>
        <div>WORKSPACE</div>
      </RemoteConnectionGate>
    </NextIntlClientProvider>
  )
}

/** Let the connection load, then have the transport report a 401. */
async function mountExpired() {
  mocks.getRemoteWorkspaceConnection.mockResolvedValue(CONNECTION)
  mountGate()
  expect(await screen.findByText("WORKSPACE")).toBeVisible()
  const [config] = mocks.configureRemoteDesktopTransport.mock.calls[0] as [
    RemoteTransportConfig,
  ]
  act(() => config.onUnauthorized?.())
  expect(
    await screen.findByText(/Remote connection "lab-box" is expired/)
  ).toBeVisible()
}

beforeEach(() => {
  mocks.desktop = true
  vi.clearAllMocks()
})

describe("RemoteConnectionGate dead ends", () => {
  it("offers the local workspace once the credentials expired", async () => {
    await mountExpired()
    expect(screen.queryByText("WORKSPACE")).toBeNull()
    // Offered, not done: nothing happens until the button is pressed.
    expect(mocks.openLocalWorkspace).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole("button", OPEN_LOCAL))
    expect(mocks.openLocalWorkspace).toHaveBeenCalledOnce()
  })

  it("offers it when the connection could not be loaded", async () => {
    mocks.getRemoteWorkspaceConnection.mockRejectedValue(new Error("gone"))
    mountGate()
    expect(
      await screen.findByText("Failed to load remote connection: gone")
    ).toBeVisible()
    expect(mocks.openLocalWorkspace).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole("button", OPEN_LOCAL))
    expect(mocks.openLocalWorkspace).toHaveBeenCalledOnce()
  })

  it("says why when the local workspace cannot be brought up", async () => {
    mocks.openLocalWorkspace.mockRejectedValueOnce(new Error("ipc down"))
    await mountExpired()

    await userEvent.click(screen.getByRole("button", OPEN_LOCAL))
    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("Failed to open local workspace")
    expect(alert).toHaveTextContent("ipc down")

    // A retry that works takes the old failure away.
    await userEvent.click(screen.getByRole("button", OPEN_LOCAL))
    expect(mocks.openLocalWorkspace).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => expect(screen.queryByRole("alert")).toBeNull())
  })

  it("has no local workspace to offer off the desktop", async () => {
    mocks.desktop = false
    mocks.getRemoteWorkspaceConnection.mockRejectedValue(new Error("gone"))
    mountGate()
    expect(
      await screen.findByText("Failed to load remote connection: gone")
    ).toBeVisible()
    expect(screen.queryByRole("button", OPEN_LOCAL)).toBeNull()
  })
})
