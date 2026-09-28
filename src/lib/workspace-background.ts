// Transport-aware bindings + shared model for the workspace background image.
//
// The image bytes live on disk under `~/.codeg/backgrounds/` (backend
// `crate::backgrounds`), read/written through `getTransport().call(...)` so the
// same code runs in Tauri (`invoke`) and standalone-server (`fetch`) modes —
// mirroring `src/lib/pet/api.ts`. The lightweight display config (enabled,
// mask, blur, fill, panel opacity) lives in localStorage via the appearance
// provider; only the image itself round-trips through here.

import { getTransport } from "@/lib/transport"

// ─── Types ───

export type WorkspaceBgFillMode = "cover" | "contain" | "center" | "tile"

/** camelCase mirror of the Rust `BackgroundAsset` returned by `background_read`. */
export type BackgroundAsset = { mime: string; dataBase64: string }

// ─── Accepted image formats ───

/**
 * The formats `backgrounds::validate_background` allowlists (src-tauri). Keep
 * the two lists in step — the backend stays the authoritative gate; this copy
 * exists only so the picker can reject a wrong file *before* a ~21 MiB base64
 * round trip, and name the reason instead of the generic failure toast.
 *
 * GIF is here for animated backgrounds. Animation needs no separate opt-in
 * anywhere in the stack: the bytes are stored verbatim and painted by the
 * webview, so an animated GIF / APNG (sniffs as PNG) / animated WebP plays on
 * its own. See the note on `validate_background`.
 */
export const SUPPORTED_WORKSPACE_BG_MIMES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const

export type WorkspaceBgMime = (typeof SUPPORTED_WORKSPACE_BG_MIMES)[number]

/**
 * `accept` for the file input. Deliberately wider than the sniff list above,
 * because `accept` filters the native dialog by *name*, not by content:
 *
 * - Extensions ride along with the mime types because some platforms hand a
 *   picked file an empty `File.type`, which would otherwise grey it out.
 * - `.apng` / `image/apng` are listed even though APNG is not a distinct sniff
 *   result — its bytes are a PNG and it animates, but a file actually *named*
 *   `.apng` maps to `image/apng` on some platforms and so would not match the
 *   `image/png` entry. Omitting it would hide a working animated background
 *   from the picker.
 *
 * Anything that slips through by name is still checked by bytes on selection
 * (`sniffWorkspaceBgMime`) and again by the backend, so widening this is safe.
 */
export const WORKSPACE_BG_ACCEPT = [
  ...SUPPORTED_WORKSPACE_BG_MIMES,
  "image/apng",
  ".png",
  ".apng",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
].join(",")

/**
 * Magic-byte sniff mirroring the Rust `sniff_mime`, returning `null` for
 * anything outside the allowlist. Bytes, not `File.type`: the browser derives
 * that from the file extension, so a renamed `.png` that is really a BMP would
 * pass a type check and then be rejected by the backend.
 */
export function sniffWorkspaceBgMime(
  bytes: Uint8Array
): WorkspaceBgMime | null {
  const startsWith = (sig: readonly number[], offset = 0): boolean =>
    bytes.length >= offset + sig.length &&
    sig.every((b, i) => bytes[offset + i] === b)

  // 0x89 "PNG" CR LF SUB LF — also covers APNG, which shares the signature.
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png"
  }
  if (startsWith([0xff, 0xd8, 0xff])) return "image/jpeg"
  // "RIFF" ....(size).... "WEBP" — the animated variant shares this header.
  if (
    startsWith([0x52, 0x49, 0x46, 0x46]) &&
    startsWith([0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return "image/webp"
  }
  // "GIF89a" (animation-capable) and the static original "GIF87a".
  if (
    startsWith([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]) ||
    startsWith([0x47, 0x49, 0x46, 0x38, 0x37, 0x61])
  ) {
    return "image/gif"
  }
  return null
}

// ─── Presets / defaults / ranges ───

export const WORKSPACE_BG_FILL_MODES = [
  "cover",
  "contain",
  "center",
  "tile",
] as const satisfies readonly WorkspaceBgFillMode[]

/** CSS `background-size` / `background-repeat` for each fill mode. */
export const FILL_MODE_STYLE: Record<
  WorkspaceBgFillMode,
  { size: string; repeat: string }
> = {
  cover: { size: "cover", repeat: "no-repeat" },
  contain: { size: "contain", repeat: "no-repeat" },
  center: { size: "auto", repeat: "no-repeat" },
  tile: { size: "auto", repeat: "repeat" },
}

export const DEFAULT_WORKSPACE_BG_ENABLED = false
export const DEFAULT_WORKSPACE_BG_MASK_OPACITY = 0.82
export const DEFAULT_WORKSPACE_BG_IMAGE_BLUR = 0
export const DEFAULT_WORKSPACE_BG_PANEL_OPACITY = 0.3
export const DEFAULT_WORKSPACE_BG_FILL_MODE: WorkspaceBgFillMode = "cover"

export const WORKSPACE_BG_MASK_OPACITY_RANGE = { min: 0, max: 0.99, step: 0.01 }
export const WORKSPACE_BG_IMAGE_BLUR_RANGE = { min: 0, max: 24, step: 1 }
export const WORKSPACE_BG_PANEL_OPACITY_RANGE = { min: 0, max: 1, step: 0.01 }

/** Client-side upload ceiling; matches the backend `MAX_BG_BYTES` (16 MiB). */
export const MAX_WORKSPACE_BG_BYTES = 16 * 1024 * 1024

/**
 * Decoded-pixel ceiling; matches the backend `MAX_BG_PIXELS` (40 Mpx ≈ an 8K
 * image). A local pick can't know this before the round trip — the picker never
 * decodes the file — but the wallpaper market gets both dimensions in the
 * listing, so it can tell which wallpapers would be refused before offering
 * them as something to click.
 */
export const MAX_WORKSPACE_BG_PIXELS = 40_000_000

// ─── Validation / clamp ───

function clamp(v: number, min: number, max: number): number {
  if (Number.isNaN(v)) return min
  return Math.min(max, Math.max(min, v))
}

export function clampMaskOpacity(v: number): number {
  return clamp(
    v,
    WORKSPACE_BG_MASK_OPACITY_RANGE.min,
    WORKSPACE_BG_MASK_OPACITY_RANGE.max
  )
}

export function clampImageBlur(v: number): number {
  return clamp(
    v,
    WORKSPACE_BG_IMAGE_BLUR_RANGE.min,
    WORKSPACE_BG_IMAGE_BLUR_RANGE.max
  )
}

export function clampPanelOpacity(v: number): number {
  return clamp(
    v,
    WORKSPACE_BG_PANEL_OPACITY_RANGE.min,
    WORKSPACE_BG_PANEL_OPACITY_RANGE.max
  )
}

export function isValidFillMode(v: unknown): v is WorkspaceBgFillMode {
  return (
    typeof v === "string" &&
    (WORKSPACE_BG_FILL_MODES as readonly string[]).includes(v)
  )
}

// ─── base64 / blob-URL helpers (equivalents of the pet sprite helpers) ───

export function arrayBufferToBase64(bytes: Uint8Array): string {
  let binary = ""
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunk))
    )
  }
  return btoa(binary)
}

export function createBackgroundObjectUrl(asset: BackgroundAsset): string {
  const binary = atob(asset.dataBase64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return URL.createObjectURL(new Blob([bytes], { type: asset.mime }))
}

export function revokeBackgroundObjectUrl(
  url: string | null | undefined
): void {
  if (url?.startsWith("blob:")) {
    URL.revokeObjectURL(url)
  }
}

// ─── Transport bindings (dual-mode, mirrors src/lib/pet/api.ts) ───

/** Returns the stored background asset, or `null` when none is set. */
export async function readWorkspaceBackground(): Promise<BackgroundAsset | null> {
  return getTransport().call("background_read")
}

export async function setWorkspaceBackground(
  imageBase64: string
): Promise<void> {
  return getTransport().call("background_set", { imageBase64 })
}

export async function clearWorkspaceBackground(): Promise<void> {
  return getTransport().call("background_clear")
}
