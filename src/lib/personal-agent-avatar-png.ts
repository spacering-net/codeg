"use client"

/**
 * An assistant's avatar as a PNG, for the icon of its notifications (1.13,
 * 10.10): the face in its idle pose, drawn standalone with the light
 * theme's colours (the classes `bot-avatar.tsx` uses), or the picture it
 * was given. An emoji or a monogram has no icon.
 *
 * The desktop backend posts the assistants' notifications itself, so each
 * avatar is handed to it once (`personal_agent_avatar_png`); a browser
 * notification takes the PNG as its `icon`.
 */

import { FACE_PATHS } from "@/components/personal-agent/bot-avatar"
import { personalAgentAvatarPng } from "@/lib/api"
import { isDesktop } from "@/lib/transport"
import type { BotAvatar, BotColor, BotShape } from "@/lib/types"

/** The icon's size, px. */
export const AVATAR_PNG_SIZE = 128
/** The most the backend takes, as base64. */
const MAX_BASE64 = 256 * 1024

/** The body colours: tailwind's, as `BODY` picks them on a light theme. */
const BODY_HEX: Record<BotColor, string> = {
  black: "#171717",
  brown: "#92400e",
  red: "#ef4444",
  orange: "#f97316",
  yellow: "#facc15",
  green: "#22c55e",
  teal: "#14b8a6",
  blue: "#3b82f6",
  purple: "#8b5cf6",
  magenta: "#d946ef",
  gray: "#94a3b8",
}

/** The eyes: light on the darker bodies, dark on the light ones (`EYES`). */
const EYES_HEX: Record<BotColor, string> = {
  black: "#ffffff",
  brown: "#ffffff",
  red: "#ffffff",
  orange: "#171717",
  yellow: "#171717",
  green: "#ffffff",
  teal: "#ffffff",
  blue: "#ffffff",
  purple: "#ffffff",
  magenta: "#ffffff",
  gray: "#171717",
}

/** The idle face as a standalone SVG document. */
export function faceSvg(shape: BotShape, color: BotColor): string {
  const body = BODY_HEX[color] ?? BODY_HEX.blue
  const eyes = EYES_HEX[color] ?? "#ffffff"
  const path = FACE_PATHS[shape] ?? FACE_PATHS.blob
  // The idle eyes: two capsules 9 × 20 at (38.5, 46) and (61.5, 46).
  const eye = (cx: number) =>
    `<rect x="${cx - 4.5}" y="36" width="9" height="20" rx="4.5" fill="${eyes}"/>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" ` +
    `width="${AVATAR_PNG_SIZE}" height="${AVATAR_PNG_SIZE}">` +
    `<path d="${path}" fill="${body}"/>${eye(38.5)}${eye(61.5)}</svg>`
  )
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

/** Hand the desktop backend each assistant's avatar it has not got as it
 *  is now. Elsewhere nothing: a browser draws its own icon. */
export function uploadAvatarPngs(
  bots: readonly { id: number; avatar: BotAvatar | null | undefined }[]
): void {
  if (!isDesktop()) return
  for (const b of bots) {
    const key = JSON.stringify(b.avatar ?? null)
    if (uploaded.get(b.id) === key) continue
    uploaded.set(b.id, key)
    void avatarPngDataUrl(b.avatar)
      .then((url) => {
        const png = url?.replace(/^data:image\/png;base64,/, "")
        if (!png || png === url || png.length > MAX_BASE64) return
        return personalAgentAvatarPng(b.id, png)
      })
      .catch(() => {
        // Handed over again with the next roster read.
        if (uploaded.get(b.id) === key) uploaded.delete(b.id)
      })
  }
}

/** Test seam. */
export function __resetAvatarPngsForTests(): void {
  rendered.clear()
  uploaded.clear()
}
