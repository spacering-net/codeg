import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Controllable stand-in for the connection store. `vi.hoisted` guarantees the
// shared object exists before the hoisted `vi.mock` factory runs.
const store = vi.hoisted(() => {
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
    reconnectWebNow: vi.fn(),
    redirectToCodegLogin: vi.fn(),
    probeTransportLiveness: vi.fn(),
  }
})

vi.mock("@/lib/transport/web-connection-store", () => ({
  subscribeWebConnection: store.subscribe,
  getWebConnectionSnapshot: store.getState,
  getWebConnectionServerSnapshot: () => "connected",
  reconnectWebNow: store.reconnectWebNow,
  notifyWebUnauthorized: vi.fn(),
}))

vi.mock("@/lib/transport/web-auth", () => ({
  redirectToCodegLogin: store.redirectToCodegLogin,
  getCodegToken: () => "tok",
}))

vi.mock("@/lib/platform", () => ({
  probeTransportLiveness: store.probeTransportLiveness,
}))

import { WebConnectionGuard } from "./web-connection-guard"
import enMessages from "@/i18n/messages/en.json"

function renderGuard() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <WebConnectionGuard />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  vi.useFakeTimers()
  store.reset()
  store.reconnectWebNow.mockClear()
  store.redirectToCodegLogin.mockClear()
  store.probeTransportLiveness.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("WebConnectionGuard", () => {
  it("renders nothing while connected", () => {
    const { container } = renderGuard()
    expect(container.firstChild).toBeNull()
    expect(screen.queryByText("Connection lost")).not.toBeInTheDocument()
  })

  it("stays hidden during the grace window, then shows the reconnecting dialog", () => {
    renderGuard()
    act(() => store.setState("reconnecting"))
    // Within the grace window — a brief blip must not flash a modal.
    expect(screen.queryByText("Connection lost")).not.toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(4000)
    })
    expect(screen.getByText("Connection lost")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Reconnect now" })
    ).toBeInTheDocument()
  })

  it("fires reconnectWebNow when the reconnect button is clicked", () => {
    renderGuard()
    act(() => store.setState("reconnecting"))
    act(() => {
      vi.advanceTimersByTime(4000)
    })
    fireEvent.click(screen.getByRole("button", { name: "Reconnect now" }))
    expect(store.reconnectWebNow).toHaveBeenCalledTimes(1)
  })

  it("shows the session-expired dialog immediately (no grace) for unauthorized", () => {
    renderGuard()
    act(() => store.setState("unauthorized"))
    // No timer advance: a rejected token is surfaced at once.
    expect(screen.getByText("Session expired")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Go to login" }))
    expect(store.redirectToCodegLogin).toHaveBeenCalledTimes(1)
  })

  it("dismisses automatically once the connection recovers", () => {
    renderGuard()
    act(() => store.setState("reconnecting"))
    act(() => {
      vi.advanceTimersByTime(4000)
    })
    expect(screen.getByText("Connection lost")).toBeInTheDocument()

    act(() => store.setState("connected"))
    expect(screen.queryByText("Connection lost")).not.toBeInTheDocument()
  })

  it("probes transport liveness on network restore while reconnecting", () => {
    renderGuard()
    act(() => store.setState("reconnecting"))

    act(() => {
      window.dispatchEvent(new Event("online"))
    })
    // The transport decides what a probe means in this state (skip the
    // remaining backoff); the guard never reaches past it.
    expect(store.probeTransportLiveness).toHaveBeenCalledTimes(1)
    expect(store.reconnectWebNow).not.toHaveBeenCalled()
  })

  it("probes liveness on every wake signal even while the link looks connected", () => {
    // A socket that died during sleep still reports "connected" — the probe
    // is exactly how that gets noticed, so it must not be gated on state.
    renderGuard()
    act(() => {
      window.dispatchEvent(new Event("online"))
      window.dispatchEvent(new Event("pageshow"))
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "visible",
      })
      document.dispatchEvent(new Event("visibilitychange"))
    })
    expect(store.probeTransportLiveness).toHaveBeenCalledTimes(3)
  })

  it("does not probe when the tab goes hidden", () => {
    renderGuard()
    act(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      })
      document.dispatchEvent(new Event("visibilitychange"))
    })
    expect(store.probeTransportLiveness).not.toHaveBeenCalled()
  })
})
