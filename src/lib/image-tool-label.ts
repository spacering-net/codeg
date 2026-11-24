/**
 * Label for an in-position image card.
 *
 * Codex image generation hardcodes the English title "Image generation"
 * (codex-acp PR #271). Codeg also routes ANY image-bearing tool (Read of a
 * PNG, a page screenshot, a fetched resource) through that same card, and
 * the card used to print "Image generation" even when the tool already had
 * a real name. Keep the dedicated copy only for actual generation; otherwise
 * use the filename or URL slug the agent already knew, falling back to the
 * tool's own title/name.
 */

const IMAGE_GENERATION_TITLE = "image generation"

export function isImageGenerationTitle(
  title: string | null | undefined
): boolean {
  return (title ?? "").trim().toLowerCase() === IMAGE_GENERATION_TITLE
}

/**
 * Parse as a URL, or `null` when the string is a filesystem path.
 *
 * The scheme must be at least TWO characters: `new URL("C:\\shots\\x.png")`
 * succeeds — WHATWG reads the drive letter as protocol `c:` and hands back
 * `\shots\x.png` as one opaque path — so a single-letter scheme would send
 * every Windows absolute path down the URL branch and print the whole thing
 * as the heading. No real scheme is one character.
 */
function asUrl(raw: string): URL | null {
  if (!/^[a-z][a-z0-9+.-]+:/i.test(raw)) return null
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

/** The heading-worthy part of a filesystem path or URL. */
function labelFromPathOrUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  const url = asUrl(trimmed)
  if (url) {
    const leaf = url.pathname
      .replace(/\/+$/, "")
      .split("/")
      .filter(Boolean)
      .pop()
    // A root URL has no slug to humanize; the host IS the page name, and it
    // must skip `humanizeSegment` — whose extension strip would eat the TLD
    // and turn "example.com" into "Example".
    if (!leaf) return url.hostname || null
    let decoded = leaf
    try {
      decoded = decodeURIComponent(leaf)
    } catch {
      /* malformed percent-escape — the raw slug still names the page */
    }
    return humanizeSegment(decoded) || null
  }

  const leaf = trimmed.split(/[\\/]/).filter(Boolean).pop()
  return leaf ? humanizeSegment(leaf) : null
}

function humanizeSegment(segment: string): string {
  const withoutExt = segment.replace(/\.[a-z0-9]{1,8}$/i, "")
  const words = withoutExt.replace(/[-_]+/g, " ").trim()
  if (!words) return segment
  return words.replace(/\b\w/g, (c) => c.toUpperCase())
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

/** Filename or URL from a tool's JSON input preview. */
export function pathFromToolInput(
  input: string | null | undefined
): string | null {
  if (!input) return null
  try {
    const parsed: unknown = JSON.parse(input)
    if (!parsed || typeof parsed !== "object") return null
    const obj = parsed as Record<string, unknown>
    return (
      stringField(obj.file_path) ||
      stringField(obj.path) ||
      stringField(obj.filename) ||
      stringField(obj.url) ||
      stringField(obj.uri)
    )
  } catch {
    return null
  }
}

export function imageCardLabel(opts: {
  title?: string | null
  toolName?: string | null
  input?: string | null
}): string | null {
  // The tool input comes FIRST because it is the only naming signal both
  // renderers hold. The live ACP stream has the agent's `title`; a reloaded
  // conversation does not — a persisted tool_use row keeps `tool_name` and
  // `input_preview` only. Reading the title first made the same Read print
  // "Read file '/Users/x/shots/page-capture.png'" live and "Page Capture"
  // after a reload, re-opening the live/historical asymmetry that
  // `adaptImageToolResultParts` exists to close.
  const fromInput = pathFromToolInput(opts.input ?? null)
  if (fromInput) {
    const fromPath = labelFromPathOrUrl(fromInput)
    if (fromPath) return fromPath
  }

  // Both remaining fallbacks are one-sided (title is live-only, tool_name is
  // history-only), so they can still disagree across a reload — but only for
  // an image tool whose input carries no path at all.
  const title = opts.title?.trim() || null
  if (title && !isImageGenerationTitle(title)) return title

  const toolName = opts.toolName?.trim() || null
  if (toolName && !isImageGenerationTitle(toolName)) return toolName

  return null
}
