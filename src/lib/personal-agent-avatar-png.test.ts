import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  desktop: true,
  upload: vi.fn(async () => {}),
}))
vi.mock("@/lib/transport", () => ({ isDesktop: () => h.desktop }))
vi.mock("@/lib/api", () => ({ personalAgentAvatarPng: h.upload }))

import {
  __resetAvatarPngsForTests,
  avatarPngDataUrl,
  avatarSource,
  faceSvg,
  uploadAvatarPngs,
} from "./personal-agent-avatar-png"
import type { BotAvatar } from "./types"

class LoadingImage {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  set src(_v: string) {
    queueMicrotask(() => this.onload?.())
  }
}

beforeEach(() => {
  h.desktop = true
  vi.stubGlobal("Image", LoadingImage)
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
    "data:image/png;base64,UE5H"
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  h.upload.mockClear()
  __resetAvatarPngsForTests()
})

const face: BotAvatar = { kind: "face", shape: "pebble", color: "yellow" }

async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe("an assistant's avatar as a PNG", () => {
  it("draws the idle face with the light theme's colours", () => {
    const svg = faceSvg("pebble", "yellow")
    expect(svg).toContain('fill="#facc15"')
    // Dark eyes on a light body: two capsules.
    expect(svg.match(/<rect /g)).toHaveLength(2)
    expect(svg).toContain('fill="#171717"')
    expect(faceSvg("blob", "blue")).toContain('fill="#ffffff"')
  })

  it("has an icon for a face or a picture, not an emoji or a monogram", () => {
    expect(avatarSource(face)).toMatch(/^data:image\/svg\+xml/)
    expect(
      avatarSource({ kind: "image", data_url: "data:image/png;base64,QQ" })
    ).toBe("data:image/png;base64,QQ")
    expect(avatarSource({ kind: "emoji", emoji: "🧭", color: "violet" })).toBe(
      null
    )
    expect(avatarSource({ kind: "monogram", color: "violet" })).toBe(null)
    expect(avatarSource(null)).toBe(null)
  })

  it("hands each avatar to the desktop backend once, again when it changes", async () => {
    expect(await avatarPngDataUrl(face)).toBe("data:image/png;base64,UE5H")
    uploadAvatarPngs([{ id: 3, avatar: face }])
    await settle()
    expect(h.upload).toHaveBeenCalledWith(3, "UE5H")
    uploadAvatarPngs([{ id: 3, avatar: face }])
    await settle()
    expect(h.upload).toHaveBeenCalledTimes(1)
    uploadAvatarPngs([{ id: 3, avatar: { ...face, color: "red" } }])
    await settle()
    expect(h.upload).toHaveBeenCalledTimes(2)
    // No icon, nothing handed over.
    uploadAvatarPngs([{ id: 4, avatar: { kind: "monogram", color: "teal" } }])
    await settle()
    expect(h.upload).toHaveBeenCalledTimes(2)
  })

  it("hands nothing over off the desktop", async () => {
    h.desktop = false
    uploadAvatarPngs([{ id: 3, avatar: face }])
    await settle()
    expect(h.upload).not.toHaveBeenCalled()
  })
})
