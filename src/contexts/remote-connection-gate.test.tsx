import { act, cleanup, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import type { RemoteTransportConfig } from "@/lib/transport/types"

const mocks = vi.hoisted(() => ({
  configure: vi.fn<(config: RemoteTransportConfig) => void>(),
  clear: vi.fn(),
  readConnection: vi.fn(),
  status: vi.fn(),
  transport: { id: "remote-transport" },
}))

vi.mock("next/navigation", () => ({
  useSearchParams: () =>
    new URLSearchParams("remoteConnectionId=17&remoteWindowId=window-instance"),
}))
vi.mock("@/lib/transport", () => ({
  configureRemoteDesktopTransport: mocks.configure,
  clearRemoteDesktopTransport: mocks.clear,
  getTransport: () => mocks.transport,
  isDesktop: () => true,
}))
vi.mock("@/lib/remote-workspace", () => ({
  getRemoteWorkspaceConnection: mocks.readConnection,
}))
vi.mock("@/stores/backend-scoped-store-reset", () => ({
  resetBackendScopedStores: vi.fn(),
}))
vi.mock("@/components/connection/remote-connection-status", () => ({
  RemoteConnectionStatus: (props: unknown) => {
    mocks.status(props)
    return <div>Remote status</div>
  },
}))

import { RemoteConnectionGate } from "./remote-connection-context"

beforeEach(() => {
  vi.clearAllMocks()
  mocks.readConnection.mockResolvedValue({
    id: 17,
    name: "Remote workspace",
    base_url: "http://remote.test:3210",
    token: "test-token",
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function renderGate() {
  await act(async () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <RemoteConnectionGate>
          <div>Workspace stays open</div>
        </RemoteConnectionGate>
      </NextIntlClientProvider>
    )
  })
  return mocks.configure.mock.calls[mocks.configure.mock.calls.length - 1][0]
}

describe("RemoteConnectionGate failure recovery", () => {
  // A socket that is merely down never reaches the gate: the transport
  // keeps retrying it in its own state, which the status pill shows.
  it("shows credential expiry once the transport reports a refused token", async () => {
    const config = await renderGate()
    expect(screen.queryByText(/expired/i)).not.toBeInTheDocument()

    act(() => config.onUnauthorized?.())

    expect(screen.queryByText("Workspace stays open")).not.toBeInTheDocument()
    expect(screen.queryByText("Remote status")).not.toBeInTheDocument()
    expect(screen.getByText(/expired/i)).toBeInTheDocument()
  })

  it("binds recovery to the existing transport instead of reloading the window", async () => {
    await renderGate()
    const props = mocks.status.mock.calls[mocks.status.mock.calls.length - 1][0]
    expect(props.transport).toBe(mocks.transport)
    expect(props).not.toHaveProperty("onReconnect")
    expect(mocks.configure).toHaveBeenCalledTimes(1)
    expect(screen.getByText("Workspace stays open")).toBeInTheDocument()
  })
})
