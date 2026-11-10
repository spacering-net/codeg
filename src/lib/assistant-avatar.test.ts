import { afterEach, describe, expect, it, vi } from "vitest"

import { ASSISTANT_AVATAR_COLORS } from "@/lib/types"
import {
  AVATAR_IMAGE_MAX_BYTES,
  AVATAR_IMAGE_SIDE,
  AvatarImageError,
  avatarEmojiFrom,
  colorForName,
  dataUrlByteSize,
  encodeAvatarCanvas,
  firstGrapheme,
  imageFileToAvatarDataUrl,
  monogramFor,
} from "./assistant-avatar"

/** A base64 data URL whose payload decodes to `bytes` bytes. */
function dataUrl(type: string, bytes: number): string {
  return `data:${type};base64,${"A".repeat(Math.ceil((bytes * 4) / 3 / 4) * 4)}`
}

describe("firstGrapheme", () => {
  it("takes a whole user-perceived character", () => {
    expect(firstGrapheme("👩‍👩‍👧 family")).toBe("👩‍👩‍👧")
    expect(firstGrapheme("🇯🇵 flag")).toBe("🇯🇵")
    expect(firstGrapheme("école")).toBe("é")
    expect(firstGrapheme("  Reviewer")).toBe("R")
  })

  it("is empty for blank text", () => {
    expect(firstGrapheme("")).toBe("")
    expect(firstGrapheme(" \n\t")).toBe("")
  })

  it("keeps a character whole without Intl.Segmenter too", () => {
    const intl = Intl as unknown as { Segmenter?: unknown }
    const segmenter = intl.Segmenter
    intl.Segmenter = undefined
    try {
      expect(firstGrapheme("🦊 fox")).toBe("🦊")
      expect(firstGrapheme("abc")).toBe("a")
      expect(firstGrapheme("🇯🇵 flag")).toBe("🇯🇵")
      expect(firstGrapheme("1️⃣ one")).toBe("1️⃣")
      expect(firstGrapheme("e\u0301cole")).toBe("e\u0301")
      expect(firstGrapheme("👩‍👩‍👧 family")).toBe("👩‍👩‍👧")
      expect(firstGrapheme("👍🏽 ok")).toBe("👍🏽")
      expect(firstGrapheme("🏴󠁧󠁢󠁥󠁮󠁧󠁿 England")).toBe("🏴󠁧󠁢󠁥󠁮󠁧󠁿")
      // 한 spelled in jamo (ㅎ ㅏ ㄴ), and a syllable taking a trailing jamo.
      expect(firstGrapheme("\u1112\u1161\u11ab\u1100")).toBe(
        "\u1112\u1161\u11ab"
      )
      expect(firstGrapheme("\uac00\u11a8x")).toBe("\uac00\u11a8")
      expect(firstGrapheme("代码")).toBe("代")
    } finally {
      intl.Segmenter = segmenter
    }
  })
})

describe("avatarEmojiFrom", () => {
  it("takes the first character", () => {
    expect(avatarEmojiFrom("🦉 owl")).toBe("🦉")
    expect(avatarEmojiFrom("  🧑‍💻")).toBe("🧑‍💻")
  })

  it("refuses what the backend would refuse", () => {
    expect(avatarEmojiFrom("")).toBeNull()
    expect(avatarEmojiFrom("   ")).toBeNull()
    expect(avatarEmojiFrom("\u001b")).toBeNull()
    expect(avatarEmojiFrom("\u0085")).toBeNull()
    // Ten women joined into one character: 67 bytes, over the 64 allowed.
    expect(avatarEmojiFrom(Array(10).fill("👩").join("\u200d"))).toBeNull()
  })
})

describe("monogram and colour", () => {
  it("upper-cases the name's first character, keeping it one", () => {
    expect(monogramFor("reviewer")).toBe("R")
    expect(monogramFor("ärger")).toBe("Ä")
    expect(monogramFor("ßeta")).toBe("S")
    expect(monogramFor("")).toBe("")
  })

  it("gives a name the same palette colour every time", () => {
    const color = colorForName("Reviewer")
    expect(ASSISTANT_AVATAR_COLORS).toContain(color)
    expect(colorForName("  reviewer ")).toBe(color)
  })
})

describe("dataUrlByteSize", () => {
  it("counts decoded bytes, padding excluded", () => {
    expect(dataUrlByteSize("data:image/png;base64,AAAA")).toBe(3)
    expect(dataUrlByteSize("data:image/png;base64,AAA=")).toBe(2)
    expect(dataUrlByteSize("data:image/png;base64,AA==")).toBe(1)
  })
})

/** A canvas whose encoder answers per type; `null` = falls back to PNG, as
 *  a webview that cannot encode the type does. */
function fakeCanvas(answers: Record<string, string | null>) {
  const toDataURL = vi.fn((type: string) => {
    const answer = answers[type]
    return answer === null || answer === undefined
      ? (answers["image/png"] ?? "data:,")
      : answer
  })
  return { canvas: { toDataURL } as unknown as HTMLCanvasElement, toDataURL }
}

describe("encodeAvatarCanvas", () => {
  it("prefers WebP", () => {
    const webp = dataUrl("image/webp", 1000)
    const { canvas } = fakeCanvas({ "image/webp": webp })
    expect(encodeAvatarCanvas(canvas)).toBe(webp)
  })

  it("takes the PNG a webview answers for WebP, without encoding it twice", () => {
    const png = dataUrl("image/png", 1000)
    const { canvas, toDataURL } = fakeCanvas({
      "image/webp": null,
      "image/png": png,
    })
    expect(encodeAvatarCanvas(canvas)).toBe(png)
    expect(toDataURL).toHaveBeenCalledTimes(1)
  })

  it("falls back to JPEG when the lossless encodings do not fit", () => {
    const jpeg = dataUrl("image/jpeg", 1000)
    const { canvas } = fakeCanvas({
      "image/webp": dataUrl("image/webp", AVATAR_IMAGE_MAX_BYTES + 10),
      "image/png": dataUrl("image/png", AVATAR_IMAGE_MAX_BYTES + 10),
      "image/jpeg": jpeg,
    })
    expect(encodeAvatarCanvas(canvas)).toBe(jpeg)
  })

  it("refuses an image that fits no encoding", () => {
    const big = AVATAR_IMAGE_MAX_BYTES + 10
    const { canvas } = fakeCanvas({
      "image/webp": dataUrl("image/webp", big),
      "image/png": dataUrl("image/png", big),
      "image/jpeg": dataUrl("image/jpeg", big),
    })
    expect(() => encodeAvatarCanvas(canvas)).toThrow(AvatarImageError)
    try {
      encodeAvatarCanvas(canvas)
    } catch (err) {
      expect((err as AvatarImageError).reason).toBe("too_large")
    }
  })
})

describe("imageFileToAvatarDataUrl", () => {
  const RealImage = globalThis.Image

  /** jsdom never decodes images: this one "loads" at the given size. */
  function stubImage(width: number, height: number, fail = false) {
    class FakeImage {
      naturalWidth = width
      naturalHeight = height
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_url: string) {
        queueMicrotask(() => (fail ? this.onerror?.() : this.onload?.()))
      }
    }
    globalThis.Image = FakeImage as unknown as typeof Image
  }

  function stubCanvas() {
    const drawImage = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
      imageSmoothingQuality: "low",
    } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(
      (type?: string) => dataUrl(type ?? "image/png", 1000)
    )
    return drawImage
  }

  /** jsdom has no object URLs at all. */
  function stubObjectUrls() {
    const revoke = vi.fn()
    Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:avatar"),
      revokeObjectURL: revoke,
    })
    return revoke
  }

  afterEach(() => {
    globalThis.Image = RealImage
    const urls = URL as unknown as Record<string, unknown>
    delete urls.createObjectURL
    delete urls.revokeObjectURL
    vi.restoreAllMocks()
  })

  it("center-crops to a square and scales it to the avatar size", async () => {
    const revoke = stubObjectUrls()
    stubImage(300, 200)
    const drawImage = stubCanvas()
    const url = await imageFileToAvatarDataUrl(new Blob(["x"]))
    expect(url.startsWith("data:image/webp;")).toBe(true)
    expect(drawImage).toHaveBeenCalledWith(
      expect.anything(),
      50,
      0,
      200,
      200,
      0,
      0,
      AVATAR_IMAGE_SIDE,
      AVATAR_IMAGE_SIDE
    )
    expect(revoke).toHaveBeenCalledWith("blob:avatar")
  })

  it("calls a file it cannot decode unreadable", async () => {
    stubObjectUrls()
    stubImage(0, 0, true)
    stubCanvas()
    await expect(imageFileToAvatarDataUrl(new Blob(["x"]))).rejects.toThrow(
      AvatarImageError
    )
    stubImage(0, 0)
    await expect(
      imageFileToAvatarDataUrl(new Blob(["x"]))
    ).rejects.toMatchObject({ reason: "unreadable" })
  })
})
