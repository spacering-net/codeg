import {
  ASSISTANT_AVATAR_COLORS,
  type AssistantAvatar,
  type AssistantAvatarColor,
} from "@/lib/types"

/** Side of an uploaded avatar after cropping, in pixels: sharp on a 36px card
 *  avatar at 3x, and far below the backend's 512px cap. */
export const AVATAR_IMAGE_SIDE = 128
/** Largest decoded image the backend accepts (it re-checks). */
export const AVATAR_IMAGE_MAX_BYTES = 256 * 1024

/** Largest emoji avatar the backend accepts, in UTF-8 bytes. */
export const AVATAR_EMOJI_MAX_BYTES = 64

/** `Intl.Segmenter`, typed locally: the project's TS lib predates it, and
 *  older webviews lack it at runtime. */
type GraphemeSegmenter = new (
  locale: undefined,
  options: { granularity: "grapheme" }
) => { segment(input: string): Iterable<{ segment: string }> }

let fallbackCluster: RegExp | null | undefined

/**
 * The first character the way {@link firstGrapheme} cuts it, for runtimes
 * without `Intl.Segmenter`: a flag (a regional-indicator pair), a Hangul
 * syllable spelled in jamo, or one code point with the marks — variation
 * selectors and the keycap included — skin tones and tag characters that
 * attach to it, joined by ZWJ to the next such cluster. Built lazily: a
 * runtime too old for property escapes gets `null`.
 */
function fallbackClusterPattern(): RegExp | null {
  if (fallbackCluster !== undefined) return fallbackCluster
  const part =
    "(?:\\p{Regional_Indicator}{2}" +
    "|(?:[\\u1100-\\u115F]+|[\\uAC00-\\uD7A3])[\\u1160-\\u11A7]*[\\u11A8-\\u11FF]*" +
    "|\\P{M}(?:\\p{M}|[\\u{1F3FB}-\\u{1F3FF}\\u{E0020}-\\u{E007F}])*)"
  try {
    fallbackCluster = new RegExp(`^${part}(?:\\u200D${part})*`, "u")
  } catch {
    fallbackCluster = null
  }
  return fallbackCluster
}

/** The first user-perceived character of `text` — a whole flag or family
 *  emoji, a letter with its combining marks — or `""` for blank text. */
export function firstGrapheme(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ""
  const Segmenter = (Intl as unknown as { Segmenter?: GraphemeSegmenter })
    .Segmenter
  if (Segmenter) {
    const segmenter = new Segmenter(undefined, { granularity: "grapheme" })
    for (const { segment } of segmenter.segment(trimmed)) return segment
  }
  const cluster = fallbackClusterPattern()?.exec(trimmed)?.[0]
  return cluster || (Array.from(trimmed)[0] ?? "")
}

/** The letter a monogram avatar shows for `name` — one character even where
 *  upper-casing makes two (`ß` → `SS`). */
export function monogramFor(name: string): string {
  return firstGrapheme(firstGrapheme(name).toLocaleUpperCase())
}

/** Whitespace and control characters, which the backend refuses in an emoji
 *  avatar (`char::is_whitespace` / `is_control`). */
const NOT_A_SYMBOL = /[\s\u0000-\u001f\u007f-\u009f]/

let emojiGlyph: RegExp | null | undefined

/** Whether `glyph` is drawn from an emoji font — a pictograph, a flag, a
 *  keycap — so it may name those fonts outright (`font-emoji`) rather than
 *  have the webview look it up through the interface's. Built lazily: a
 *  runtime too old for property escapes says no. */
export function isEmojiGlyph(glyph: string): boolean {
  if (emojiGlyph === undefined) {
    try {
      emojiGlyph = new RegExp(
        "\\p{Extended_Pictographic}|\\p{Regional_Indicator}|\\u20e3",
        "u"
      )
    } catch {
      emojiGlyph = null
    }
  }
  return emojiGlyph?.test(glyph) ?? false
}

/** The emoji avatar `text` makes — its first character — or `null` when that
 *  is blank, a control character, or longer than the backend accepts. */
export function avatarEmojiFrom(text: string): string | null {
  const glyph = firstGrapheme(text)
  if (!glyph || NOT_A_SYMBOL.test(glyph)) return null
  if (new TextEncoder().encode(glyph).length > AVATAR_EMOJI_MAX_BYTES) {
    return null
  }
  return glyph
}

/** A stable palette colour for a name: the default of a new assistant, so two
 *  assistants made one after another rarely share one. */
export function colorForName(name: string): AssistantAvatarColor {
  let hash = 0
  for (const ch of name.trim().toLowerCase()) {
    hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0
  }
  return ASSISTANT_AVATAR_COLORS[hash % ASSISTANT_AVATAR_COLORS.length]
}

export function defaultAvatarFor(name: string): AssistantAvatar {
  return { kind: "monogram", color: colorForName(name) }
}

/** Decoded byte size of a base64 data URL's payload. */
export function dataUrlByteSize(dataUrl: string): number {
  const comma = dataUrl.indexOf(",")
  const payload = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0
  return Math.floor((payload.length * 3) / 4) - padding
}

export class AvatarImageError extends Error {
  constructor(public readonly reason: "unreadable" | "too_large") {
    super(reason)
    this.name = "AvatarImageError"
  }
}

/** Load a File into an image element (via an object URL). */
export function loadAvatarImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      if (!img.naturalWidth || !img.naturalHeight)
        reject(new AvatarImageError("unreadable"))
      else resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new AvatarImageError("unreadable"))
    }
    img.src = url
  })
}

/**
 * Encode a canvas the way the backend accepts: WebP first, PNG when the
 * webview cannot encode WebP (WKWebView's `toDataURL("image/webp")` silently
 * answers PNG), and JPEG when a PNG would not fit the size cap.
 */
export function encodeAvatarCanvas(canvas: HTMLCanvasElement): string {
  const webp = canvas.toDataURL("image/webp", 0.9)
  if (
    webp.startsWith("data:image/webp;") &&
    dataUrlByteSize(webp) <= AVATAR_IMAGE_MAX_BYTES
  ) {
    return webp
  }
  const png = webp.startsWith("data:image/png;")
    ? webp
    : canvas.toDataURL("image/png")
  if (dataUrlByteSize(png) <= AVATAR_IMAGE_MAX_BYTES) return png
  const jpeg = canvas.toDataURL("image/jpeg", 0.85)
  if (
    jpeg.startsWith("data:image/jpeg;") &&
    dataUrlByteSize(jpeg) <= AVATAR_IMAGE_MAX_BYTES
  ) {
    return jpeg
  }
  throw new AvatarImageError("too_large")
}

/** A square of an image, in its own pixels: from (`x`, `y`), `side` wide. */
export interface AvatarCrop {
  x: number
  y: number
  side: number
}

/**
 * The avatar data URL of the square `crop` of `img`: scaled to
 * {@link AVATAR_IMAGE_SIDE}, encoded (see {@link encodeAvatarCanvas}).
 * Done client-side because neither web mode nor a remote-workspace window
 * can hand the backend a local file path — the bytes travel in the request.
 */
export function cropToAvatarDataUrl(
  img: CanvasImageSource,
  crop: AvatarCrop
): string {
  const canvas = document.createElement("canvas")
  canvas.width = AVATAR_IMAGE_SIDE
  canvas.height = AVATAR_IMAGE_SIDE
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new AvatarImageError("unreadable")
  ctx.imageSmoothingQuality = "high"
  ctx.drawImage(
    img,
    crop.x,
    crop.y,
    crop.side,
    crop.side,
    0,
    0,
    AVATAR_IMAGE_SIDE,
    AVATAR_IMAGE_SIDE
  )
  return encodeAvatarCanvas(canvas)
}

/** Turn a picked image file into an avatar data URL: its middle square
 *  (see {@link cropToAvatarDataUrl}). */
export async function imageFileToAvatarDataUrl(file: Blob): Promise<string> {
  const img = await loadAvatarImage(file)
  const width = img.naturalWidth
  const height = img.naturalHeight
  const side = Math.min(width, height)
  return cropToAvatarDataUrl(img, {
    x: (width - side) / 2,
    y: (height - side) / 2,
    side,
  })
}
