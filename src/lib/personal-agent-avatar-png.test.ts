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

const face: BotAvatar = { kind: "face", shape: "donut", color: "yellow" }

async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe("an assistant's avatar as a PNG", () => {
  it("draws the idle face with the light theme's colours", () => {
    // The mug: its body yellow, its eyes on it dark — two capsules.
    const svg = faceSvg("mug", "yellow")
    expect(svg).toContain('fill="#facc15"')
    expect(svg).toContain('<g color="#171717">')
    expect(svg.match(/fill="currentColor"/g)).toHaveLength(2)
    // The donut's eyes are in its hole: in its own colour, seen through.
    expect(faceSvg("donut", "blue")).toContain('<g color="#3b82f6">')
    // Its full drawing (the sprinkles), not the small one.
    expect(faceSvg("donut", "blue").match(/<rect /g)!.length).toBeGreaterThan(2)
    // The watch's eyes on its screen (painted in the colour that reads on
    // it): in its own colour.
    expect(faceSvg("watch", "teal")).toContain('<g color="#14b8a6">')
    // Seen only through their window, as on the page.
    expect(svg).toContain('<clipPath id="f-eyes">')
    expect(svg).toContain('<g clip-path="url(#f-eyes)">')
    // A picture is still: no mark running round the watch's screen.
    expect(faceSvg("watch", "teal")).not.toContain("pa-face-progress")
    expect(faceSvg("watch", "teal")).not.toContain("stroke-dasharray")
  })

  it("draws a face no longer drawn as the donut", () => {
    expect(faceSvg("pebble" as never, "red")).toBe(faceSvg("donut", "red"))
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
    // The mug's small drawing: its eyes 100 tall, on its body.
    const open = trayFaceSvg("mug", "yellow", "open")
    expect(open).toContain('width="36"')
    expect(open).toContain('height="100"')
    expect(open).not.toContain('transform="translate(')
    expect(trayFaceSvg("mug", "yellow", "blink")).toContain('height="10"')
    // Moved 4 of the face's 100, as far as its window lets them (0.8).
    expect(trayFaceSvg("mug", "yellow", "left")).toContain(
      'transform="translate(-16.384 0)"'
    )
    expect(trayFaceSvg("mug", "yellow", "right")).toContain(
      'transform="translate(16.384 0)"'
    )
    expect(trayFaceSvg("mug", "yellow", "up")).toContain(
      'transform="translate(0 -16.384)"'
    )
    // The small drawing: no steam.
    expect(open).not.toContain("pa-face-steam")
    expect(faceSvg("mug", "yellow")).toContain("pa-face-steam")
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
