import { afterEach, describe, expect, it, vi, type Mock } from "vitest"

import {
  canCopyImageToClipboard,
  ClipboardImageUnsupportedError,
  copyImageToClipboard,
  normalizeImageMime,
} from "./copy-image"

// 1x1 PNG
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

type FakeItem = { items: Record<string, Blob | Promise<Blob>> }

/**
 * jsdom ships no object-URL implementation, so install one. Returns the
 * `revokeObjectURL` spy, which is how the leak-on-failure test checks that
 * every exit from the raster releases its URL.
 */
function stubObjectUrls(): Mock {
  const revoke = vi.fn()
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:stub"),
    revokeObjectURL: revoke,
  })
  return revoke
}

/** Stub `ClipboardItem` + `clipboard.write`, and collect what was written. */
function stubClipboard(): {
  writes: FakeItem[]
  write: Mock
} {
  const writes: FakeItem[] = []
  vi.stubGlobal(
    "ClipboardItem",
    class FakeItem {
      constructor(public items: Record<string, Blob | Promise<Blob>>) {}
    }
  )
  const write = vi.fn(async (items: FakeItem[]) => {
    for (const item of items) {
      try {
        await Promise.all(Object.values(item.items))
      } catch {
        // Like the real API: a rejected representation fails the write with an
        // error of the clipboard's own, losing the reason it rejected for.
        throw new Error("The write was cancelled")
      }
    }
    writes.push(...items)
  })
  vi.stubGlobal("navigator", { clipboard: { write } })
  return { writes, write }
}

describe("normalizeImageMime", () => {
  it("normalizes jpeg aliases and empty", () => {
    expect(normalizeImageMime("image/JPG")).toBe("image/jpeg")
    expect(normalizeImageMime(" image/png ")).toBe("image/png")
    expect(normalizeImageMime("")).toBe("image/png")
  })
})

describe("copyImageToClipboard", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("writes a PNG ClipboardItem", async () => {
    const { writes } = stubClipboard()
    await copyImageToClipboard({ data: PNG, mime_type: "image/png" })
    expect(writes).toHaveLength(1)
    const png = await writes[0].items["image/png"]
    expect(png).toBeInstanceOf(Blob)
    expect(png.type).toBe("image/png")
  })

  // WebKit only honours a clipboard write issued inside the user gesture, so
  // the raster must not be awaited before `write()` is called. Anything that
  // reintroduces an `await` ahead of the write breaks copying JPEGs on the
  // desktop app, and this is the assertion that catches it.
  it("calls write synchronously, before the raster resolves", () => {
    const { write } = stubClipboard()
    stubObjectUrls()
    let decodeStarted = false
    vi.stubGlobal(
      "Image",
      class {
        onload: (() => void) | null = null
        onerror: (() => void) | null = null
        set src(_value: string) {
          // A real decode never completes in the same tick.
          decodeStarted = true
        }
      }
    )
    const pending = copyImageToClipboard({
      data: PNG,
      mime_type: "image/jpeg",
    })
    expect(write).toHaveBeenCalledTimes(1)
    expect(decodeStarted).toBe(true)
    // The write never settles because the stubbed decode never fires; keep the
    // rejection handled so it can't surface as an unhandled rejection.
    pending.catch(() => {})
  })

  it("reports the raster failure rather than the write's own error", async () => {
    stubClipboard()
    stubObjectUrls()
    vi.stubGlobal(
      "Image",
      class {
        onload: (() => void) | null = null
        onerror: (() => void) | null = null
        set src(_value: string) {
          setTimeout(() => this.onerror?.(), 0)
        }
      }
    )
    await expect(
      copyImageToClipboard({ data: PNG, mime_type: "image/jpeg" })
    ).rejects.toBeInstanceOf(ClipboardImageUnsupportedError)
  })

  it("releases the object URL when the canvas is unavailable", async () => {
    stubClipboard()
    const revoke = stubObjectUrls()
    vi.stubGlobal(
      "Image",
      class {
        onload: (() => void) | null = null
        onerror: (() => void) | null = null
        set src(_value: string) {
          setTimeout(() => this.onload?.(), 0)
        }
      }
    )
    // jsdom has no 2d context, so this takes the `!ctx` bail-out.
    await expect(
      copyImageToClipboard({ data: PNG, mime_type: "image/jpeg" })
    ).rejects.toBeInstanceOf(ClipboardImageUnsupportedError)
    expect(revoke).toHaveBeenCalledWith("blob:stub")
  })

  it("throws when the clipboard cannot take images", async () => {
    vi.stubGlobal("navigator", { clipboard: {} })
    await expect(
      copyImageToClipboard({ data: "QQ==", mime_type: "image/png" })
    ).rejects.toBeInstanceOf(ClipboardImageUnsupportedError)
    expect(canCopyImageToClipboard()).toBe(false)
  })
})
