import { act, cleanup, render, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"

const RESTORE_FAILED = "workspace://restore-failed"

let desktop = true
let remoteWindow = false
let handlers: Map<string, () => void>
let unsubscribe: ReturnType<typeof vi.fn>
let call: ReturnType<typeof vi.fn>
const toastError = vi.fn()

vi.mock("@/lib/transport", () => ({
  isDesktop: () => desktop,
  isRemoteDesktopMode: () => remoteWindow,
  getShellTransport: () => ({
    call: (command: string) => call(command),
    subscribe: async (event: string, handler: () => void) => {
      handlers.set(event, handler)
      return unsubscribe
    },
  }),
}))
vi.mock("sonner", () => ({
  toast: {
    error: (title: string, options?: { description?: string }) =>
      toastError(title, options),
  },
}))

import { WorkspaceRestoreNotices } from "./workspace-restore-notices"

/** The backend's one-shot slot: each failure is handed out once. */
function park(...batches: unknown[][]) {
  const queue = [...batches]
  return vi.fn(async (command: string) => {
    expect(command).toBe("take_workspace_restore_failures")
    return queue.shift() ?? []
  })
}

function failure(connectionId: number, name: string, detail: string) {
  return {
    connectionId,
    name,
    error: {
      code: "network",
      message: "Unable to connect to remote workspace",
      detail,
    },
  }
}

function renderNotices() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <WorkspaceRestoreNotices />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  desktop = true
  remoteWindow = false
  handlers = new Map()
  unsubscribe = vi.fn()
  call = park()
  toastError.mockClear()
})
afterEach(() => cleanup())

describe("WorkspaceRestoreNotices", () => {
  it("reports what was parked before the window was listening", async () => {
    call = park([failure(3, "Build box", "connection refused")])
    renderNotices()

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1))
    expect(toastError).toHaveBeenCalledWith(
      'Couldn\'t reopen remote workspace "Build box"',
      { description: "connection refused" }
    )
    // Subscribed first, so nothing parked in between could be missed.
    expect(handlers.has(RESTORE_FAILED)).toBe(true)
  })

  it("takes the failures again on every nudge", async () => {
    call = park(
      [],
      [failure(1, "One", "timed out"), failure(2, "Two", "token invalid")]
    )
    renderNotices()
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    expect(toastError).not.toHaveBeenCalled()

    await act(async () => {
      handlers.get(RESTORE_FAILED)!()
    })

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(2))
    expect(toastError.mock.calls.map(([title]) => title)).toEqual([
      'Couldn\'t reopen remote workspace "One"',
      'Couldn\'t reopen remote workspace "Two"',
    ])
  })

  it("shrugs off a backend that cannot answer", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    call = vi.fn(async () => {
      throw new Error("command take_workspace_restore_failures not found")
    })
    renderNotices()

    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    await act(async () => {})
    expect(toastError).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it("stops listening when it unmounts", async () => {
    const { unmount } = renderNotices()
    await waitFor(() => expect(handlers.has(RESTORE_FAILED)).toBe(true))

    unmount()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["a remote workspace window", { desktop: true, remote: true }],
    ["the web build", { desktop: false, remote: false }],
  ])("stays out of %s", async (_label, env) => {
    desktop = env.desktop
    remoteWindow = env.remote
    renderNotices()

    // Let any effect that would have run settle.
    await act(async () => {})
    expect(call).not.toHaveBeenCalled()
    expect(handlers.size).toBe(0)
  })
})
