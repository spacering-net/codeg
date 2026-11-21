import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { copyPendingText } from "./clipboard"

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** What a browser with the async clipboard has: an item that takes a
 *  pending blob, read back the way user-event's clipboard reads one. */
class FakeClipboardItem {
  readonly types: string[]
  constructor(private readonly items: Record<string, Promise<Blob>>) {
    this.types = Object.keys(items)
  }
  getType(type: string) {
    return this.items[type]
  }
}

beforeEach(() => {
  userEvent.setup()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("copying text still on its way — no ClipboardItem (plain HTTP)", () => {
  it("waits for the text, then writes it", async () => {
    await expect(copyPendingText(Promise.resolve("Definition"))).resolves.toBe(
      true
    )
    await expect(navigator.clipboard.readText()).resolves.toBe("Definition")
  })

  it("fails with the fetch's own failure", async () => {
    const failure = new Error("offline")
    await expect(copyPendingText(Promise.reject(failure))).rejects.toBe(failure)
  })
})

describe("copying text still on its way — with ClipboardItem (the webview)", () => {
  beforeEach(() => {
    vi.stubGlobal("ClipboardItem", FakeClipboardItem)
  })

  it("writes at once, inside the gesture, with the text still pending", async () => {
    const write = vi.spyOn(navigator.clipboard, "write")
    const text = deferred<string>()
    const copy = copyPendingText(text.promise)
    // Not after the text arrives: by then the gesture would be spent.
    expect(write).toHaveBeenCalledTimes(1)

    text.resolve("---\nname: hunter\n---\nBody")
    await expect(copy).resolves.toBe(true)
    await expect(navigator.clipboard.readText()).resolves.toBe(
      "---\nname: hunter\n---\nBody"
    )
  })

  it("reports the fetch's failure rather than the clipboard's", async () => {
    vi.spyOn(navigator.clipboard, "write").mockImplementation(async (items) => {
      // A real clipboard awaits the item, and fails on its own terms.
      await (items[0] as unknown as FakeClipboardItem).getType("text/plain")
    })
    const failure = { code: "network_error", message: "offline" }
    await expect(copyPendingText(Promise.reject(failure))).rejects.toBe(failure)
  })

  it("falls back to the plain way when the clipboard refuses the item", async () => {
    vi.spyOn(navigator.clipboard, "write").mockRejectedValue(
      new DOMException("Not allowed", "NotAllowedError")
    )
    const writeText = vi.spyOn(navigator.clipboard, "writeText")
    await expect(copyPendingText(Promise.resolve("Text"))).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith("Text")
  })
})
