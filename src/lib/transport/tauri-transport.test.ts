import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TauriTransport } from "./tauri-transport"
import { readTauriMemoryCalls } from "@/lib/frontend-memory-activity"

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  transformCallback: vi.fn(),
}))

vi.mock("@tauri-apps/api/core", () => mocks)

describe("Tauri event subscription lifetime", () => {
  let callbacks: Map<number, (event: { payload: unknown }) => void>
  let registered: Map<number, number>
  let unregisterCallback: ReturnType<typeof vi.fn<(id: number) => boolean>>
  let nextCallback: number

  beforeEach(() => {
    callbacks = new Map()
    registered = new Map()
    nextCallback = 0
    unregisterCallback = vi.fn((id: number) => callbacks.delete(id))
    vi.stubGlobal("__TAURI_INTERNALS__", { unregisterCallback })
    vi.stubGlobal("__TAURI_EVENT_PLUGIN_INTERNALS__", {
      // Tauri 2.12.4 can unregister by eventId only after its registration
      // eval has supplied handlerId. The invoke response can arrive first.
      unregisterListener: (_event: string, eventId: number) => {
        const handlerId = registered.get(eventId)
        if (handlerId !== undefined) unregisterCallback(handlerId)
      },
    })
    mocks.transformCallback.mockReset().mockImplementation((callback) => {
      const id = ++nextCallback
      callbacks.set(id, callback)
      return id
    })
    mocks.invoke.mockReset().mockImplementation(async (command, args) => {
      if (command === "plugin:event|listen") {
        registered.set(100 + args.handler, args.handler)
        return 100 + args.handler
      }
    })
  })

  afterEach(() => vi.unstubAllGlobals())

  it("releases a callback when cleanup beats the listener registration eval", async () => {
    mocks.invoke.mockImplementation(async (command) =>
      command === "plugin:event|listen" ? 101 : undefined
    )
    const listener = vi.fn()
    const unsubscribe = await new TauriTransport().subscribe(
      "acp://event",
      listener
    )
    expect(callbacks.size).toBe(1)
    unsubscribe()
    expect(callbacks.size).toBe(0)
    // A late native registration cannot revive the disposed callback.
    registered.set(101, 1)
    callbacks.get(1)?.({ payload: "late event" })
    expect(listener).not.toHaveBeenCalled()
    expect(mocks.invoke).toHaveBeenCalledWith("plugin:event|unlisten", {
      event: "acp://event",
      eventId: 101,
    })
  })

  it("releases a callback if native subscription creation rejects", async () => {
    const error = new Error("webview closed")
    mocks.invoke.mockRejectedValueOnce(error)
    await expect(
      new TauriTransport().subscribe("acp://event", vi.fn())
    ).rejects.toBe(error)
    expect(callbacks.size).toBe(0)
    expect(mocks.invoke).toHaveBeenCalledTimes(1)
  })

  it("does not accumulate callbacks across repeated mount and cleanup races", async () => {
    mocks.invoke.mockImplementation(async (command) =>
      command === "plugin:event|listen" ? 101 : undefined
    )
    const transport = new TauriTransport()
    for (let index = 0; index < 100; index++) {
      const unsubscribe = await transport.subscribe("acp://event", vi.fn())
      unsubscribe()
    }
    expect(callbacks.size).toBe(0)
  })

  it("keeps independent subscriptions live and cleanup idempotent", async () => {
    const transport = new TauriTransport()
    const first = vi.fn()
    const second = vi.fn()
    const stopFirst = await transport.subscribe("acp://event", first)
    const stopSecond = await transport.subscribe("acp://event", second)
    callbacks.get(1)?.({ payload: "first" })
    callbacks.get(2)?.({ payload: "second" })
    expect(first).toHaveBeenCalledWith("first")
    expect(second).toHaveBeenCalledWith("second")
    stopFirst()
    stopFirst()
    expect(callbacks.size).toBe(1)
    callbacks.get(2)?.({ payload: "still live" })
    expect(second).toHaveBeenLastCalledWith("still live")
    stopSecond()
    expect(callbacks.size).toBe(0)
    expect(
      mocks.invoke.mock.calls.filter(
        ([command]) => command === "plugin:event|unlisten"
      )
    ).toHaveLength(2)
  })

  it("cleans up both callback and native listener if the event registry throws", async () => {
    vi.stubGlobal("__TAURI_EVENT_PLUGIN_INTERNALS__", {
      unregisterListener: () => {
        throw new Error("registration eval not ready")
      },
    })
    const unsubscribe = await new TauriTransport().subscribe(
      "acp://event",
      vi.fn()
    )
    unsubscribe()
    expect(callbacks.size).toBe(0)
    expect(mocks.invoke).toHaveBeenLastCalledWith("plugin:event|unlisten", {
      event: "acp://event",
      eventId: 101,
    })
  })
})

describe("opt-in numeric Tauri call activity", () => {
  afterEach(() => vi.unstubAllEnvs())

  it("keeps disabled calls uninstrumented and preserves the result", async () => {
    vi.stubEnv("NEXT_PUBLIC_CODEG_MEMORY_DIAGNOSTICS", "0")
    const before = readTauriMemoryCalls()
    const result = { privateValue: "not inspected" }
    const args = { privateArgument: "not inspected" }
    mocks.invoke.mockReset().mockResolvedValueOnce(result)
    expect(await new TauriTransport().call("owned_command", args)).toBe(result)
    expect(mocks.invoke.mock.calls[0]?.[1]).toBe(args)
    expect(readTauriMemoryCalls()).toEqual(before)
  })

  it("settles pending counters while preserving returned values and rejections", async () => {
    vi.stubEnv("NEXT_PUBLIC_CODEG_MEMORY_DIAGNOSTICS", "1")
    const before = readTauriMemoryCalls()
    const result = { privateValue: "not inspected" }
    const error = new Error("owned native failure")
    let resolve: ((value: unknown) => void) | undefined
    mocks.invoke.mockReset().mockImplementation((command) => {
      if (command === "get_git_head") {
        return new Promise((done) => {
          resolve = done
        })
      }
      return Promise.reject(error)
    })
    const pending = new TauriTransport().call("get_git_head")
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"))
    expect(readTauriMemoryCalls().shellCallsPending).toBe(
      (before.shellCallsPending ?? 0) + 1
    )
    await expect(
      new TauriTransport().call("unlisted_owned_command")
    ).rejects.toBe(error)
    resolve?.(result)
    expect(await pending).toBe(result)
    const after = readTauriMemoryCalls()
    expect(after.shellCallsStarted).toBe((before.shellCallsStarted ?? 0) + 2)
    expect(after.shellCallsPending).toBe(before.shellCallsPending)
    expect(after.shellCallsResolved).toBe((before.shellCallsResolved ?? 0) + 1)
    expect(after.shellCallsRejected).toBe((before.shellCallsRejected ?? 0) + 1)
    expect(after.shellCallsGitHead).toBe((before.shellCallsGitHead ?? 0) + 1)
    expect(after.shellCallsOther).toBe((before.shellCallsOther ?? 0) + 1)
  })
})
