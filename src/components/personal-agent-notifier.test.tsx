import { act, cleanup, render } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"

const h = vi.hoisted(() => ({
  desktop: true,
  prefs: { enabled: true, hideBody: false },
  listeners: new Set<() => void>(),
  handler: null as ((n: unknown) => void) | null,
  sync: vi.fn(async () => {}),
  handle: vi.fn(async () => "ignored"),
  path: "/workspace",
  subscribes: 0,
  transportListeners: new Set<() => void>(),
}))

vi.mock("next/navigation", () => ({ usePathname: () => h.path }))
vi.mock("@/lib/transport", () => ({
  isDesktop: () => h.desktop,
  onActiveTransportChange: (fn: () => void) => {
    h.transportListeners.add(fn)
    return () => h.transportListeners.delete(fn)
  },
}))
vi.mock("@/lib/api", () => ({ notificationPrefsSync: h.sync }))
vi.mock("@/lib/platform", () => ({
  subscribe: async (_event: string, fn: (n: unknown) => void) => {
    h.subscribes += 1
    h.handler = fn
    return () => {
      h.handler = null
    }
  },
}))
vi.mock("@/lib/desktop-notification-prefs", () => ({
  getDesktopNotificationPrefs: () => h.prefs,
  subscribeDesktopNotificationPrefs: (fn: () => void) => {
    h.listeners.add(fn)
    return () => h.listeners.delete(fn)
  },
}))
vi.mock("@/lib/personal-agent-notify", () => ({
  handlePersonalAgentNotify: h.handle,
}))

import { PersonalAgentNotifier } from "./personal-agent-notifier"

function draw() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PersonalAgentNotifier />
    </NextIntlClientProvider>
  )
}

async function flush() {
  for (let i = 0; i < 4; i++) await Promise.resolve()
}

beforeEach(() => {
  h.desktop = true
  h.prefs = { enabled: true, hideBody: false }
  h.path = "/workspace"
  h.subscribes = 0
  h.handler = null
  window.history.replaceState(null, "", "/workspace")
})

afterEach(() => {
  cleanup()
  h.listeners.clear()
  h.sync.mockClear()
  h.handle.mockClear()
})

describe("the assistants' notifier", () => {
  it("hands each notification to the window's handling, with its words", async () => {
    draw()
    await act(flush)
    h.handler?.({ id: "n1", mode: "toast" })
    expect(h.handle).toHaveBeenCalledWith(
      { id: "n1", mode: "toast" },
      { open: "Open" }
    )
  })

  it("tells the desktop backend this device's switch and hide-contents, as they change", async () => {
    draw()
    await act(flush)
    expect(h.sync).toHaveBeenCalledWith(true, false)
    // The same again is not sent again.
    for (const fn of h.listeners) fn()
    await act(flush)
    expect(h.sync).toHaveBeenCalledTimes(1)
    h.prefs = { enabled: false, hideBody: true }
    for (const fn of h.listeners) fn()
    await act(flush)
    expect(h.sync).toHaveBeenLastCalledWith(false, true)
  })

  it("subscribes once a window that signed in at /login goes on to the workspace", async () => {
    h.path = "/login"
    const view = draw()
    await act(flush)
    expect(h.handler).toBeNull()
    expect(h.sync).not.toHaveBeenCalled()
    h.path = "/workspace"
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <PersonalAgentNotifier />
      </NextIntlClientProvider>
    )
    await act(flush)
    expect(h.handler).not.toBeNull()
    expect(h.sync).toHaveBeenCalledWith(true, false)
  })

  it("subscribes again when a remote-desktop window points its transport at its server", async () => {
    draw()
    await act(flush)
    expect(h.subscribes).toBe(1)
    await act(async () => {
      for (const fn of h.transportListeners) fn()
      await flush()
    })
    expect(h.subscribes).toBe(2)
    expect(h.handler).not.toBeNull()
  })

  it("syncs nothing off the desktop, and stays out of the windows that are not the owner at work", async () => {
    h.desktop = false
    const first = draw()
    await act(flush)
    expect(h.sync).not.toHaveBeenCalled()
    expect(h.handler).not.toBeNull()
    first.unmount()
    h.desktop = true
    h.path = "/pet"
    window.history.replaceState(null, "", "/pet")
    draw()
    await act(flush)
    expect(h.sync).not.toHaveBeenCalled()
    expect(h.handler).toBeNull()
  })
})
