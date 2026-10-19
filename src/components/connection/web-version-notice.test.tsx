import { act, render } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => {
  let state: "connected" | "reconnecting" | "unauthorized" = "connected"
  const listeners = new Set<() => void>()
  return {
    getState: () => state,
    setState: (s: "connected" | "reconnecting" | "unauthorized") => {
      state = s
      for (const l of listeners) l()
    },
    subscribe: (cb: () => void) => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    reset: () => {
      state = "connected"
      listeners.clear()
    },
    usesWebTransport: vi.fn(() => true),
    token: vi.fn(() => "tok"),
    serverVersion: vi.fn<() => Promise<string | null>>(),
    ownRestart: { running: false, listeners: new Set<() => void>() },
    toast: Object.assign(vi.fn(), { dismiss: vi.fn() }),
  }
})

vi.mock("@/lib/transport/web-connection-store", () => ({
  subscribeWebConnection: mocks.subscribe,
  getWebConnectionSnapshot: mocks.getState,
  getWebConnectionServerSnapshot: () => "connected",
  usesWebTransport: mocks.usesWebTransport,
}))
vi.mock("@/lib/transport/web-auth", () => ({
  getCodegToken: mocks.token,
}))
vi.mock("@/lib/updater", () => ({
  getRunningServerVersion: mocks.serverVersion,
  isOwnServerRestartRunning: () => mocks.ownRestart.running,
  subscribeOwnServerRestart: (listener: () => void) => {
    mocks.ownRestart.listeners.add(listener)
    return () => {
      mocks.ownRestart.listeners.delete(listener)
    }
  },
}))
vi.mock("sonner", () => ({ toast: mocks.toast }))

import { WEB_VERSION_TOAST_ID, WebVersionNotice } from "./web-version-notice"
import enMessages from "@/i18n/messages/en.json"

function renderNotice() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <WebVersionNotice />
    </NextIntlClientProvider>
  )
}

/** Let the version request settle. */
async function settle() {
  await act(async () => {})
}

beforeEach(() => {
  mocks.reset()
  mocks.usesWebTransport.mockReset().mockReturnValue(true)
  mocks.token.mockReset().mockReturnValue("tok")
  mocks.serverVersion.mockReset().mockResolvedValue("0.37.0")
  mocks.toast.mockReset()
  mocks.toast.dismiss.mockReset()
  mocks.ownRestart.running = false
  mocks.ownRestart.listeners.clear()
  vi.stubEnv("NODE_ENV", "production")
  vi.stubEnv("CODEG_APP_VERSION", "0.37.0")
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("WebVersionNotice", () => {
  it("offers a reload when the server runs another release than the page", async () => {
    mocks.serverVersion.mockResolvedValue("0.38.0")
    renderNotice()
    await settle()

    expect(mocks.toast).toHaveBeenCalledTimes(1)
    const [title, options] = mocks.toast.mock.calls[0]
    expect(title).toBe("The server is now running Codeg 0.38.0")
    expect(options).toMatchObject({
      id: WEB_VERSION_TOAST_ID,
      description:
        "This page is still on 0.37.0. Reload it to use the server's version.",
      duration: Infinity,
      action: { label: "Reload" },
    })
    const reload = vi.fn()
    const location = window.location
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...location, reload },
    })
    try {
      options.action.onClick()
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: location,
      })
    }
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it("asks again each time the connection comes back", async () => {
    renderNotice()
    await settle()
    expect(mocks.toast).not.toHaveBeenCalled()
    expect(mocks.toast.dismiss).toHaveBeenCalledWith(WEB_VERSION_TOAST_ID)

    // The server was upgraded while the tab stayed open.
    mocks.serverVersion.mockResolvedValue("0.38.0")
    act(() => mocks.setState("reconnecting"))
    await settle()
    expect(mocks.serverVersion).toHaveBeenCalledTimes(1)
    act(() => mocks.setState("connected"))
    await settle()

    expect(mocks.serverVersion).toHaveBeenCalledTimes(2)
    expect(mocks.toast).toHaveBeenCalledWith(
      "The server is now running Codeg 0.38.0",
      expect.objectContaining({ id: WEB_VERSION_TOAST_ID })
    )
  })

  it("leaves the page's own upgrade to report itself", async () => {
    // The in-app upgrade restarts the server under this page, watches the
    // new release prove itself and reloads; a second offer to reload would
    // cut that watch short.
    const setOwnRestart = (running: boolean) =>
      act(() => {
        mocks.ownRestart.running = running
        for (const listener of mocks.ownRestart.listeners) listener()
      })
    mocks.serverVersion.mockResolvedValue("0.38.0")
    renderNotice()
    await settle()
    expect(mocks.toast).toHaveBeenCalledTimes(1)

    setOwnRestart(true)
    expect(mocks.toast.dismiss).toHaveBeenCalledWith(WEB_VERSION_TOAST_ID)
    act(() => mocks.setState("reconnecting"))
    act(() => mocks.setState("connected"))
    await settle()
    expect(mocks.serverVersion).toHaveBeenCalledTimes(1)

    // It gave up without reloading: the page is still the old one.
    setOwnRestart(false)
    await settle()
    expect(mocks.serverVersion).toHaveBeenCalledTimes(2)
    expect(mocks.toast).toHaveBeenCalledTimes(2)
  })

  it("stays quiet for a server that does not report its version", async () => {
    mocks.serverVersion.mockResolvedValue(null)
    renderNotice()
    await settle()
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it.each([
    ["the page ships with the app (desktop, remote desktop)", "shell"],
    ["there is no token to ask with", "token"],
    ["this is a development build", "dev"],
  ])("does not ask when %s", async (_, gate) => {
    if (gate === "shell") mocks.usesWebTransport.mockReturnValue(false)
    if (gate === "token") mocks.token.mockReturnValue("")
    if (gate === "dev") vi.stubEnv("NODE_ENV", "development")
    mocks.serverVersion.mockResolvedValue("0.38.0")
    renderNotice()
    await settle()
    expect(mocks.serverVersion).not.toHaveBeenCalled()
    expect(mocks.toast).not.toHaveBeenCalled()
  })
})
