import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  listen,
  once,
  type Event,
  type EventTarget,
} from "@tauri-apps/api/event"
import { getCurrentWebview } from "@tauri-apps/api/webview"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)

describe("native Tauri event callback lifetime", () => {
  let callbacks: Map<number, (event: Event<unknown>) => void>
  let registered: Map<number, number>
  let invoke: ReturnType<
    typeof vi.fn<
      (command: string, args?: Record<string, unknown>) => Promise<unknown>
    >
  >
  let nextId: number

  beforeEach(() => {
    callbacks = new Map()
    registered = new Map()
    nextId = 0
    invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === "plugin:event|listen") {
        const handler = args?.handler
        if (typeof handler !== "number") throw new Error("missing handler")
        registered.set(1000 + handler, handler)
        return 1000 + handler
      }
    })
    vi.stubGlobal("__TAURI_INTERNALS__", {
      metadata: {
        currentWindow: { label: "main" },
        currentWebview: { label: "main" },
      },
      invoke,
      transformCallback: (callback: (event: Event<unknown>) => void) => {
        callbacks.set(++nextId, callback)
        return nextId
      },
      unregisterCallback: (id: number) => callbacks.delete(id),
    })
    vi.stubGlobal("__TAURI_EVENT_PLUGIN_INTERNALS__", {
      unregisterListener: (_event: string, eventId: number) => {
        const id = registered.get(eventId)
        if (id !== undefined) callbacks.delete(id)
      },
    })
  })

  afterEach(() => vi.unstubAllGlobals())

  const scopes: { scope: string; target: EventTarget }[] = [
    { scope: "global", target: { kind: "Any" } },
    { scope: "webview", target: { kind: "Webview", label: "main" } },
    { scope: "window", target: { kind: "Window", label: "main" } },
  ]

  function subscribe(scope: string, handler: (event: Event<unknown>) => void) {
    if (scope === "webview") {
      return getCurrentWebview().listen("tauri://drag-over", handler)
    }
    if (scope === "window") {
      return getCurrentWindow().listen("tauri://drag-over", handler)
    }
    return listen("tauri://drag-over", handler)
  }

  it.each(scopes)(
    "releases $scope callback when cleanup beats native registration eval",
    async ({ scope, target }) => {
      invoke.mockImplementation(async (command) =>
        command === "plugin:event|listen" ? 1001 : undefined
      )
      const handler = vi.fn()
      const stop = await subscribe(scope, handler)
      expect(callbacks.size).toBe(1)
      await stop()
      expect(callbacks.size).toBe(0)
      registered.set(1001, 1)
      callbacks.get(1)?.({ event: "tauri://drag-over", id: 1001, payload: 1 })
      expect(handler).not.toHaveBeenCalled()
      expect(invoke).toHaveBeenCalledWith(
        "plugin:event|listen",
        { event: "tauri://drag-over", target, handler: 1 },
        undefined
      )
      expect(invoke).toHaveBeenCalledWith(
        "plugin:event|unlisten",
        { event: "tauri://drag-over", eventId: 1001 },
        undefined
      )
    }
  )

  it.each(scopes)(
    "releases $scope callback when native registration fails",
    async ({ scope }) => {
      const error = new Error("synthetic closed webview")
      invoke.mockRejectedValueOnce(error)
      await expect(subscribe(scope, vi.fn())).rejects.toBe(error)
      expect(callbacks.size).toBe(0)
    }
  )

  it("does not retain scoped closures after repeated registration races", async () => {
    invoke.mockImplementation(async (command) =>
      command === "plugin:event|listen" ? 1001 : undefined
    )
    for (let i = 0; i < 100; i++) {
      const stop = await getCurrentWebview().listen(
        "tauri://drag-over",
        vi.fn()
      )
      await stop()
    }
    expect(callbacks.size).toBe(0)
  })

  it("still cleans native registration when the JS event registry throws", async () => {
    vi.stubGlobal("__TAURI_EVENT_PLUGIN_INTERNALS__", {
      unregisterListener: () => {
        throw new Error("registration eval unavailable")
      },
    })
    const stop = await listen("tauri://drag-over", vi.fn())
    await stop()
    expect(callbacks.size).toBe(0)
    expect(invoke).toHaveBeenLastCalledWith(
      "plugin:event|unlisten",
      { event: "tauri://drag-over", eventId: 1001 },
      undefined
    )
  })

  it("keeps independent scopes live and cleanup idempotent", async () => {
    const first = vi.fn()
    const second = vi.fn()
    const stopFirst = await getCurrentWebview().listen(
      "tauri://drag-over",
      first
    )
    const stopSecond = await getCurrentWindow().listen(
      "tauri://drag-over",
      second
    )
    const event = { event: "tauri://drag-over", id: 1002, payload: { x: 1 } }
    await stopFirst()
    await stopFirst()
    callbacks.get(2)?.(event)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledWith(event)
    await stopSecond()
    expect(callbacks.size).toBe(0)
    expect(
      invoke.mock.calls.filter(
        ([command]) => command === "plugin:event|unlisten"
      )
    ).toHaveLength(2)
  })

  it("releases a once callback when its event beats registration eval", async () => {
    invoke.mockImplementation(async (command) =>
      command === "plugin:event|listen" ? 1001 : undefined
    )
    const handler = vi.fn()
    const stop = await once("tauri://drag-over", handler)
    callbacks.get(1)?.({ event: "tauri://drag-over", id: 1001, payload: 1 })
    await Promise.resolve()
    expect(handler).toHaveBeenCalledTimes(1)
    expect(callbacks.size).toBe(0)
    await stop()
    expect(
      invoke.mock.calls.filter(
        ([command]) => command === "plugin:event|unlisten"
      )
    ).toHaveLength(1)
  })

  it("releases once before the listen response and ignores a second event", async () => {
    let finishListen!: (eventId: number) => void
    invoke.mockImplementation((command) =>
      command === "plugin:event|listen"
        ? new Promise<number>((resolve) => {
            finishListen = resolve
          })
        : Promise.resolve()
    )
    const handler = vi.fn()
    const pending = once("tauri://drag-over", handler)
    const callback = callbacks.get(1)!
    const event = { event: "tauri://drag-over", id: 1001, payload: 1 }
    callback(event)
    callback(event)
    expect(callbacks.size).toBe(0)
    expect(handler).toHaveBeenCalledTimes(1)
    finishListen(1001)
    const stop = await pending
    await stop()
    expect(
      invoke.mock.calls.filter(
        ([command]) => command === "plugin:event|unlisten"
      )
    ).toHaveLength(1)
  })

  it("also protects CommonJS consumers from failed registrations", async () => {
    const cjsEvent =
      require("@tauri-apps/api/event") as typeof import("@tauri-apps/api/event")
    const error = new Error("synthetic registration rejection")
    invoke.mockRejectedValueOnce(error)
    await expect(cjsEvent.listen("tauri://drag-over", vi.fn())).rejects.toBe(
      error
    )
    expect(callbacks.size).toBe(0)
  })
})
