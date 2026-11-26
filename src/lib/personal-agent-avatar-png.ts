"use client"

/**
 * An assistant's avatar as a PNG, for the icon of its notifications (1.13,
 * 10.10): the face in its idle pose, drawn standalone in the light theme's
 * colours (`bot-shapes`' own drawing, as the page has it), or the picture
 * it was given. An emoji or a monogram has no icon.
 *
 * And the frames the desktop's menu bar shows while it works (10.10, 2.9):
 * a strip of squares side by side — the idle face open-eyed, blinking,
 * glancing left, right and up, in its small drawing — which the backend steps through as an idle
 * face blinks and glances (10.6). A picture, an emoji or a monogram is one
 * frame, as it is; with less motion asked for, so is a face.
 *
 * The desktop backend posts the assistants' notifications and draws the
 * tray itself, so each avatar is handed to it once
 * (`personal_agent_avatar_png`); a browser notification takes the PNG as
 * its `icon`.
 */

import {
  ART_BOX,
  faceMarkup,
  faceTones,
  isFaceColor,
  restPose,
} from "@/components/personal-agent/bot-shapes"
import { personalAgentAvatarPng } from "@/lib/api"
import { monogramFor } from "@/lib/assistant-avatar"
import { isDesktop } from "@/lib/transport"
import type {
  AssistantAvatarColor,
  AvatarTextColor,
  BotAvatar,
  BotColor,
  BotShape,
} from "@/lib/types"

/** The icon's size, px. */
export const AVATAR_PNG_SIZE = 128
/** The most the backend takes, as base64. */
const MAX_BASE64 = 256 * 1024

/** A face's idle drawing in the light theme's colours: its eyes moved by
 *  (`gx`, `gy`) on its face (up is +), or shut to a tenth. */
function faceMarkupStill(
  shape: BotShape,
  color: BotColor,
  small: boolean,
  { gx = 0, gy = 0, blink = false } = {}
): string {
  const rest = restPose(shape, "idle")
  const pose = {
    ...rest,
    gx: rest.gx + gx,
    gy: rest.gy + gy,
    open: blink ? 0.1 : 1,
  }
  return faceMarkup(shape, "idle", pose, small, "f", faceTones(color, "light"))
}

/** The idle face as a standalone SVG document. */
export function faceSvg(shape: BotShape, color: BotColor): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ART_BOX} ${ART_BOX}" ` +
    `width="${AVATAR_PNG_SIZE}" height="${AVATAR_PNG_SIZE}">` +
    `${faceMarkupStill(shape, color, false)}</svg>`
  )
}

/** A tray frame's size, px: 18 pt at 2×. */
export const TRAY_FRAME_SIZE = 36

/** The looks of a face's strip, in the order the backend reads them
 *  (`menubar::Frame`). */
export const TRAY_LOOKS = ["open", "blink", "left", "right", "up"] as const
export type TrayLook = (typeof TRAY_LOOKS)[number]

/** One look of the idle face as a standalone SVG — its small drawing, a
 *  little inset as the menu bar's icons are: the lids down to a tenth to
 *  blink, the eyes moved as a glance at rest moves them (`bot-avatar.tsx`). */
export function trayFaceSvg(
  shape: BotShape,
  color: BotColor,
  look: TrayLook
): string {
  const gx = look === "left" ? -14 : look === "right" ? 14 : 0
  const gy = look === "up" ? 12 : 0
  const inset = ART_BOX * 0.04
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `viewBox="${-inset} ${-inset} ${ART_BOX + 2 * inset} ${ART_BOX + 2 * inset}" ` +
    `width="${TRAY_FRAME_SIZE}" height="${TRAY_FRAME_SIZE}">` +
    `${faceMarkupStill(shape, color, true, { gx, gy, blink: look === "blink" })}</svg>`
  )
}

/** The disc of an emoji or a monogram made in one of the collaboration
 *  settings' colours, solid, with white words. */
const DISC_HEX: Record<AssistantAvatarColor, string> = {
  slate: "#64748b",
  red: "#ef4444",
  orange: "#f97316",
  amber: "#f59e0b",
  green: "#22c55e",
  teal: "#14b8a6",
  sky: "#0ea5e9",
  blue: "#3b82f6",
  violet: "#8b5cf6",
  pink: "#ec4899",
}

/** The disc of an emoji or a monogram, and its words: in a face's colour,
 *  that face's body and eyes (light theme); else the old solid swatch. */
function discPaint(color: AvatarTextColor): { fill: string; ink: string } {
  if (isFaceColor(color)) {
    const t = faceTones(color, "light")
    return { fill: t.body, ink: t.eyeBody }
  }
  return { fill: DISC_HEX[color] ?? DISC_HEX.slate, ink: "#ffffff" }
}

function svgUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/** What a PNG is drawn from: an SVG or picture URL, or nothing. */
export function avatarSource(
  avatar: BotAvatar | null | undefined
): string | null {
  if (!avatar) return null
  if (avatar.kind === "face") {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
      faceSvg(avatar.shape, avatar.color)
    )}`
  }
  if (avatar.kind === "image" && avatar.data_url.startsWith("data:image/")) {
    return avatar.data_url
  }
  return null
}

const rendered = new Map<string, Promise<string | null>>()

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    if (typeof Image === "undefined") {
      resolve(null)
      return
    }
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = src
  })
}

/** A strip of `n` frames, each drawn by `paint` at its offset. */
function strip(
  n: number,
  paint: (ctx: CanvasRenderingContext2D, x: number) => void
): string | null {
  if (typeof document === "undefined") return null
  try {
    const size = TRAY_FRAME_SIZE
    const canvas = document.createElement("canvas")
    canvas.width = size * n
    canvas.height = size
    const ctx = canvas.getContext("2d")
    if (!ctx) return null
    for (let i = 0; i < n; i++) paint(ctx, i * size)
    return canvas.toDataURL("image/png")
  } catch {
    return null
  }
}

async function drawTray(
  avatar: BotAvatar,
  name: string,
  still: boolean
): Promise<string | null> {
  const size = TRAY_FRAME_SIZE
  if (avatar.kind === "face") {
    const looks = still ? TRAY_LOOKS.slice(0, 1) : TRAY_LOOKS
    const imgs = await Promise.all(
      looks.map((look) =>
        loadImage(svgUrl(trayFaceSvg(avatar.shape, avatar.color, look)))
      )
    )
    if (imgs.some((img) => img == null)) return null
    return strip(imgs.length, (ctx, x) => {
      const img = imgs[x / size]
      if (img) ctx.drawImage(img, x, 0, size, size)
    })
  }
  if (avatar.kind === "image") {
    if (!avatar.data_url.startsWith("data:image/")) return null
    const img = await loadImage(avatar.data_url)
    if (!img) return null
    return strip(1, (ctx) => {
      // Round, its middle square, as the page shows it.
      const side = Math.min(img.naturalWidth, img.naturalHeight) || size
      const sx = ((img.naturalWidth || side) - side) / 2
      const sy = ((img.naturalHeight || side) - side) / 2
      ctx.save()
      ctx.beginPath()
      ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2)
      ctx.clip()
      ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size)
      ctx.restore()
    })
  }
  const glyph = avatar.kind === "emoji" ? avatar.emoji : monogramFor(name)
  if (!glyph) return null
  return strip(1, (ctx) => {
    const paint = discPaint(avatar.color)
    ctx.fillStyle = paint.fill
    ctx.beginPath()
    ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = paint.ink
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.font = `600 ${avatar.kind === "emoji" ? 22 : 18}px system-ui, sans-serif`
    ctx.fillText(glyph, size / 2, size / 2 + 1)
  })
}

const trays = new Map<string, Promise<string | null>>()

/** The avatar's strip of tray frames as a PNG data URL (`null`: none could
 *  be drawn). `still`: one frame, the face not to blink. Drawn once. */
export function trayPngDataUrl(
  avatar: BotAvatar | null | undefined,
  name: string,
  still: boolean
): Promise<string | null> {
  if (!avatar) return Promise.resolve(null)
  const key = JSON.stringify([
    avatar,
    avatar.kind === "monogram" ? name : null,
    still,
  ])
  let p = trays.get(key)
  if (!p) {
    p = drawTray(avatar, name, still).catch(() => null)
    trays.set(key, p)
  }
  return p
}

function draw(src: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (typeof Image === "undefined" || typeof document === "undefined") {
      resolve(null)
      return
    }
    const img = new Image()
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas")
        canvas.width = AVATAR_PNG_SIZE
        canvas.height = AVATAR_PNG_SIZE
        const ctx = canvas.getContext("2d")
        if (!ctx) {
          resolve(null)
          return
        }
        ctx.drawImage(img, 0, 0, AVATAR_PNG_SIZE, AVATAR_PNG_SIZE)
        resolve(canvas.toDataURL("image/png"))
      } catch {
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = src
  })
}

/** The avatar as a PNG data URL (`null`: it has no icon, or it could not
 *  be drawn). Drawn once per avatar. */
export function avatarPngDataUrl(
  avatar: BotAvatar | null | undefined
): Promise<string | null> {
  const src = avatarSource(avatar)
  if (!src) return Promise.resolve(null)
  let p = rendered.get(src)
  if (!p) {
    p = draw(src)
    rendered.set(src, p)
  }
  return p
}

/** What each assistant's avatar was last handed over as, by id. */
const uploaded = new Map<number, string>()

function base64Of(url: string | null): string | null {
  const b64 = url?.replace(/^data:image\/png;base64,/, "")
  return b64 && b64 !== url && b64.length <= MAX_BASE64 ? b64 : null
}

/** Hand the desktop backend each assistant's avatar it has not got as it
 *  is now: its notification icon and its tray frames (`still`: the owner
 *  asks for less motion — one frame). One it has none of is handed over
 *  as none, so an old one goes. Elsewhere nothing: a browser draws its own
 *  icon. */
export function uploadAvatarPngs(
  bots: readonly {
    id: number
    name?: string
    avatar: BotAvatar | null | undefined
  }[],
  still = false
): void {
  if (!isDesktop()) return
  for (const b of bots) {
    const name = b.name ?? ""
    const key = JSON.stringify([
      b.avatar ?? null,
      b.avatar?.kind === "monogram" ? name : null,
      still,
    ])
    if (uploaded.get(b.id) === key) continue
    uploaded.set(b.id, key)
    void Promise.all([
      avatarPngDataUrl(b.avatar),
      trayPngDataUrl(b.avatar, name, still),
    ])
      .then(([icon, tray]) =>
        personalAgentAvatarPng(b.id, base64Of(icon), base64Of(tray))
      )
      .catch(() => {
        // Handed over again with the next roster read.
        if (uploaded.get(b.id) === key) uploaded.delete(b.id)
      })
  }
}

/** Test seam. */
export function __resetAvatarPngsForTests(): void {
  rendered.clear()
  trays.clear()
  uploaded.clear()
}
