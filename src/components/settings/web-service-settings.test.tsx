import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { WebServerInfo, WebServiceConfig } from "@/lib/api"

const api = vi.hoisted(() => ({
  getWebServerStatus: vi.fn<() => Promise<WebServerInfo | null>>(),
  getWebServiceConfig: vi.fn<() => Promise<WebServiceConfig>>(),
  updateWebServiceConfig: vi.fn(async (c: WebServiceConfig) => c),
  startWebServer: vi.fn<(p?: unknown) => Promise<WebServerInfo>>(),
  stopWebServer: vi.fn<() => Promise<void>>(),
  probeWebServicePort: vi.fn(async () => ({ port: 3080, state: "free" })),
}))
vi.mock("@/lib/api", () => ({
  ...api,
  DEFAULT_WEB_SERVICE_HOST: "0.0.0.0",
  WEB_SERVICE_HOSTS: ["0.0.0.0", "127.0.0.1"],
  WEB_SERVICE_STATUS_CHANGED_EVENT: "web-service://status-changed",
}))
const handlers = new Map<string, (p: unknown) => void>()
vi.mock("@/lib/platform", () => ({
  openUrl: vi.fn(),
  subscribe: vi.fn((event: string, handler: (p: unknown) => void) => {
    handlers.set(event, handler)
    return Promise.resolve(() => {})
  }),
}))

import { WebServiceSettings } from "./web-service-settings"
import enMessages from "@/i18n/messages/en.json"

function info(overrides: Partial<WebServerInfo> = {}): WebServerInfo {
  return {
    port: 3080,
    token: "secret",
    addresses: ["http://127.0.0.1:3080"],
    bindHost: "0.0.0.0",
    ...overrides,
  }
}

function config(overrides: Partial<WebServiceConfig> = {}): WebServiceConfig {
  return {
    token: "secret",
    port: 3080,
    autoStart: false,
    host: null,
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

function mount() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <WebServiceSettings />
    </NextIntlClientProvider>
  )
}

function broadcast() {
  return act(async () => {
    handlers.get("web-service://status-changed")?.({ running: false })
  })
}

function portInput() {
  return screen.getByRole("spinbutton") as HTMLInputElement
}

beforeEach(() => {
  vi.clearAllMocks()
  handlers.clear()
  api.getWebServerStatus.mockResolvedValue(null)
  api.getWebServiceConfig.mockResolvedValue(config())
  api.startWebServer.mockResolvedValue(info())
  api.stopWebServer.mockResolvedValue(undefined)
})

describe("WebServiceSettings", () => {
  it("passes the chosen bind host to the start", async () => {
    api.getWebServiceConfig.mockResolvedValue(config({ host: "127.0.0.1" }))
    mount()
    await screen.findByText("This computer only (127.0.0.1)")
    fireEvent.click(screen.getByRole("button", { name: "Start" }))
    await waitFor(() =>
      expect(api.startWebServer).toHaveBeenCalledWith({
        port: 3080,
        host: "127.0.0.1",
        token: "secret",
      })
    )
  })

  /** Reads overlap now (mount, broadcasts, our own echo): an older Running
   *  must not land over a newer Stopped and lock the form. */
  it("ignores a status read overtaken by a newer one", async () => {
    const first = deferred<WebServerInfo | null>()
    api.getWebServerStatus.mockImplementationOnce(() => first.promise)
    mount()
    await waitFor(() => expect(handlers.size).toBe(1))
    await broadcast()
    await waitFor(() => expect(screen.getByText("Stopped")).toBeInTheDocument())

    await act(async () => first.resolve(info()))
    expect(screen.getByText("Stopped")).toBeInTheDocument()
    expect(portInput()).not.toBeDisabled()
  })

  /** A read asked before an edit must not put the saved values back over
   *  it — the debounced save would then persist the old ones. */
  it("keeps an edit made while a status read was in flight", async () => {
    mount()
    await waitFor(() => expect(portInput().value).toBe("3080"))

    const pendingConfig = deferred<WebServiceConfig>()
    api.getWebServiceConfig.mockImplementationOnce(() => pendingConfig.promise)
    await broadcast()
    fireEvent.change(portInput(), { target: { value: "4000" } })
    await act(async () => pendingConfig.resolve(config({ port: 3080 })))

    expect(portInput().value).toBe("4000")
    await waitFor(
      () =>
        expect(api.updateWebServiceConfig).toHaveBeenLastCalledWith(
          expect.objectContaining({ port: 4000 })
        ),
      { timeout: 2000 }
    )
  })

  it("follows a stop made in another window", async () => {
    api.getWebServerStatus.mockResolvedValue(info())
    mount()
    await screen.findByText("Running")
    api.getWebServerStatus.mockResolvedValue(null)
    await broadcast()
    await screen.findByText("Stopped")
  })
})
