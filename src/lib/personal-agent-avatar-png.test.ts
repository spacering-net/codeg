import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  desktop: true,
  upload: vi.fn(async () => {}),
}))
vi.mock("@/lib/transport", () => ({ isDesktop: () => h.desktop }))
vi.mock("@/lib/api", () => ({ personalAgentAvatarPng: h.upload }))

import { EYE_DARK, faceTones } from "@/components/personal-agent/bot-shapes"

import {
  __resetAvatarPngsForTests,
  avatarPngDataUrl,
  avatarSource,
  faceSvg,
  trayFaceSvg,
  trayPngDataUrl,
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
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    clip: vi.fn(),
    fill: vi.fn(),
    fillText: vi.fn(),
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

const face: BotAvatar = { kind: "face", shape: "braces", color: "yellow" }

async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe("an assistant's avatar as a PNG", () => {
  it("draws the idle face with the light theme's colours", () => {
    // The mug: yellow, its eyes on it dark grey, its edges drawn.
    const svg = faceSvg("mug", "yellow")
    const tones = faceTones("yellow", "light")
    expect(svg).toContain(`fill="${tones.body}"`)
    expect(tones.body).toBe("#facc15")
    expect(svg.match(new RegExp(`fill="${EYE_DARK}"`, "g"))).toHaveLength(2)
    expect(svg).toContain(`stroke="${tones.edge}"`)
    // In hex, not in the page's classes.
    expect(svg).not.toMatch(/class="pa-[fs]-/)
    // The ring's eyes are in its hole, seen only through it.
    const ring = faceSvg("ring", "black")
    expect(ring).toContain('<clipPath id="f-h">')
    expect(ring).toContain('<g clip-path="url(#f-h)">')
    expect(ring).toContain(`fill="${EYE_DARK}"`)
  })

  it("draws a face from before as the one it became", () => {
    expect(faceSvg("donut" as never, "red")).toBe(faceSvg("braces", "red"))
    expect(faceSvg("pebble" as never, "red")).toBe(faceSvg("terminal", "red"))
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
    uploadAvatarPngs([{ id: 3, name: "Nova", avatar: face }])
    await settle()
    expect(h.upload).toHaveBeenCalledWith(3, "UE5H", "UE5H")
    uploadAvatarPngs([{ id: 3, name: "Nova", avatar: face }])
    await settle()
    expect(h.upload).toHaveBeenCalledTimes(1)
    uploadAvatarPngs([
      { id: 3, name: "Nova", avatar: { ...face, color: "red" } },
    ])
    await settle()
    expect(h.upload).toHaveBeenCalledTimes(2)
    // Less motion asked for: drawn again, one frame.
    uploadAvatarPngs(
      [{ id: 3, name: "Nova", avatar: { ...face, color: "red" } }],
      true
    )
    await settle()
    expect(h.upload).toHaveBeenCalledTimes(3)
    // No notification icon — an old one goes — but a frame for the tray.
    uploadAvatarPngs([
      { id: 4, name: "Lin", avatar: { kind: "monogram", color: "teal" } },
    ])
    await settle()
    expect(h.upload).toHaveBeenLastCalledWith(4, null, "UE5H")
    // A monogram is drawn from the name: renamed, drawn again.
    uploadAvatarPngs([
      { id: 4, name: "Mo", avatar: { kind: "monogram", color: "teal" } },
    ])
    await settle()
    expect(h.upload).toHaveBeenCalledTimes(5)
  })

  it("draws a face's tray frames: open, blinking, glancing left, right, up", async () => {
    // The mug's small drawing: no edges.
    const open = trayFaceSvg("mug", "yellow", "open")
    expect(open).toContain('width="36"')
    expect(open).not.toContain(`stroke="${faceTones("yellow", "light").edge}"`)
    expect(open.match(new RegExp(`fill="${EYE_DARK}"`, "g"))).toHaveLength(2)
    // Each frame its own: shut, and glancing three ways.
    const frames = (["open", "blink", "left", "right", "up"] as const).map(
      (look) => trayFaceSvg("mug", "yellow", look)
    )
    expect(new Set(frames).size).toBe(5)
    // Shut: the eyes a sliver of their height.
    const eyeHeight = (svg: string) => {
      const d = svg.match(new RegExp(`d="([^"]+)" fill="${EYE_DARK}"`))![1]!
      const ys = [...d.matchAll(/[ML][\d.-]+ ([\d.-]+)/g)].map((m) => +m[1]!)
      return Math.max(...ys) - Math.min(...ys)
    }
    expect(eyeHeight(frames[1]!)).toBeLessThan(eyeHeight(frames[0]!) / 2)
    const widths: number[] = []
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(
      function (this: HTMLCanvasElement) {
        widths.push(this.width)
        return "data:image/png;base64,UE5H"
      }
    )
    expect(await trayPngDataUrl(face, "Nova", false)).toBe(
      "data:image/png;base64,UE5H"
    )
    await trayPngDataUrl(face, "Nova", true)
    expect(widths).toEqual([36 * 5, 36])
    expect(await trayPngDataUrl(null, "Nova", false)).toBe(null)
  })

  it("hands nothing over off the desktop", async () => {
    h.desktop = false
    uploadAvatarPngs([{ id: 3, avatar: face }])
    await settle()
    expect(h.upload).not.toHaveBeenCalled()
  })
})
