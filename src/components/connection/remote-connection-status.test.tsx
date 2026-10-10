import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import type { RemoteConnectionState } from "@/lib/transport/remote-desktop-transport"
import { RemoteConnectionStatus } from "./remote-connection-status"

function createHealth() {
  let state: RemoteConnectionState = "reconnecting"
  const listeners = new Set<() => void>()
  return {
    listeners,
    getConnectionSnapshot: () => state,
    subscribeConnection: (callback: () => void) => {
      listeners.add(callback)
      return () => {
        listeners.delete(callback)
      }
    },
    eventStream: vi.fn(() => ({ attach: vi.fn() })),
    reconnectNow: vi.fn(),
    setState(next: RemoteConnectionState) {
      state = next
      for (const listener of listeners) listener()
    },
  }
}

function renderStatus(transport = createHealth()) {
  const view = render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <div>Workspace stays open</div>
      <RemoteConnectionStatus transport={transport} />
    </NextIntlClientProvider>
  )
  return { ...view, transport }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("RemoteConnectionStatus", () => {
  it("starts the shared proxy but hides brief initial connects", () => {
    const { transport } = renderStatus()
    expect(transport.eventStream).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(3_999)
      transport.setState("connected")
    })
    act(() => vi.advanceTimersByTime(10_000))
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })

  it("shows initial offline retries, then an honest terminal state and reconnect action", () => {
    const { transport } = renderStatus()
    act(() => vi.advanceTimersByTime(4_000))
    expect(screen.getByRole("status")).toHaveTextContent("Connection lost")
    expect(
      screen.getByText(enMessages.WebConnection.reconnectingDescription)
    ).toBeInTheDocument()

    act(() => transport.setState("disconnected"))
    expect(
      screen.queryByText(enMessages.WebConnection.reconnectingDescription)
    ).not.toBeInTheDocument()
    expect(screen.queryByText("Session expired")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Reconnect now" }))
    expect(transport.reconnectNow).toHaveBeenCalledTimes(1)
    expect(screen.getByText("Workspace stays open")).toBeInTheDocument()
  })

  it("shows terminal failures immediately and clears when the connection recovers", () => {
    const { transport } = renderStatus()
    act(() => transport.setState("disconnected"))
    expect(screen.getByRole("status")).toHaveTextContent("Connection lost")
    act(() => transport.setState("connected"))
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })

  it("starts a fresh grace window for each later outage", () => {
    const { transport } = renderStatus()
    act(() => vi.advanceTimersByTime(4_000))
    expect(screen.getByRole("status")).toBeInTheDocument()
    act(() => transport.setState("connected"))
    act(() => transport.setState("reconnecting"))
    act(() => vi.advanceTimersByTime(3_999))
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
    act(() => vi.advanceTimersByTime(1))
    expect(screen.getByRole("status")).toBeInTheDocument()
  })

  it("shows a requested retry's progress at once, without the grace window", () => {
    const { transport } = renderStatus()
    act(() => transport.setState("disconnected"))
    transport.reconnectNow.mockImplementation(() =>
      transport.setState("reconnecting")
    )

    fireEvent.click(screen.getByRole("button", { name: "Reconnect now" }))
    expect(screen.getByRole("status")).toHaveTextContent("Connection lost")
    expect(
      screen.getByText(enMessages.WebConnection.reconnectingDescription)
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Reconnect now" })
    ).not.toBeInTheDocument()

    // The retry gives up again: the action is back.
    act(() => transport.setState("disconnected"))
    fireEvent.click(screen.getByRole("button", { name: "Reconnect now" }))
    expect(screen.getByRole("status")).toBeInTheDocument()

    // Once a retry has connected, a later outage gets its grace again.
    act(() => transport.setState("connected"))
    act(() => transport.setState("reconnecting"))
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
    act(() => vi.advanceTimersByTime(4_000))
    expect(screen.getByRole("status")).toBeInTheDocument()
  })

  it("keeps the grace window after a retry the transport did not start", () => {
    const { transport } = renderStatus()
    act(() => transport.setState("disconnected"))

    // The mock ignores the retry, as the transport does while one is running.
    fireEvent.click(screen.getByRole("button", { name: "Reconnect now" }))
    expect(transport.reconnectNow).toHaveBeenCalledTimes(1)
    act(() => transport.setState("connected"))
    act(() => transport.setState("reconnecting"))

    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })

  it("unsubscribes and cancels the grace timer on unmount", () => {
    const { transport, unmount } = renderStatus()
    expect(transport.listeners.size).toBe(1)
    unmount()
    expect(transport.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
