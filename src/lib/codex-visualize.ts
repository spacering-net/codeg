/**
 * Codex's `visualize` skill puts an inline visualization into a reply as a
 * *content reference* on its own line:
 *
 *     visualize{"path":"/abs/path/chart.html"}
 *     visualize{"path":"/abs/path/app.html","mode":"wide"}
 *
 * The three Private Use Area code points fence the reference so it can never
 * collide with prose. The Codex app swaps the line for a sandboxed iframe that
 * renders the referenced HTML fragment; everything else in the reply is
 * ordinary Markdown. This module finds those references so the transcript can
 * do the same instead of showing the raw marker (`visualize{"path":…}` with
 * tofu boxes around it).
 *
 * Hermes has its own explicit form, a directive on its own line:
 *
 *     ::preview{file="/abs/path/report.html"}
 *
 * which is treated the same way. Both are *explicit* "show this here" requests
 * and render expanded in place.
 *
 * Every other mention of a local HTML file — Hermes' `MEDIA:/…/x.html`, Claude
 * Code's `` `index.html` `` / `[index.html](index.html)`, a bare absolute path
 * — is collected by {@link findHtmlFileMentions} and offered as an on-demand
 * preview under the reply, so any agent that writes an HTML file gets one.
 */

export const CODEX_VISUALIZE_OPEN = "\uE200"
export const CODEX_VISUALIZE_ARGS = "\uE202"
export const CODEX_VISUALIZE_CLOSE = "\uE201"

const MARKER_START = `${CODEX_VISUALIZE_OPEN}visualize${CODEX_VISUALIZE_ARGS}`

export type CodexVisualizeMode = "normal" | "wide"

export interface CodexVisualizeRef {
  /** Absolute path of the HTML fragment on the machine that ran Codex. */
  path: string
  mode: CodexVisualizeMode
}

export type CodexVisualizeSegment =
  | { kind: "markdown"; text: string }
  | { kind: "visualize"; ref: CodexVisualizeRef; raw: string }

/**
 * The Codex marker written WITHOUT its Private Use Area fences — what other
 * agents (e.g. Claude Code running the Codex visualize skill) tend to emit:
 * `visualize{"path":"…"}` alone on its line. Only a whole line with valid JSON
 * carrying a `path` counts, so prose that merely mentions the syntax is left
 * alone.
 */
const BARE_VISUALIZE_LINE = /^\s*visualize(\{.*\})\s*$/

/** `::preview{file="…"}` (Hermes), alone on its line. */
const HERMES_PREVIEW_LINE =
  /^\s*:{1,2}preview\{\s*file\s*=\s*"([^"]+)"\s*\}\s*$/

/** Cheap pre-check so the common (marker-free) reply never pays for a split. */
export function hasCodexVisualizeRef(text: string): boolean {
  return (
    text.includes(MARKER_START) ||
    text.includes("preview{") ||
    text.includes("visualize{")
  )
}

/**
 * Parse the JSON payload between the ARGS and CLOSE fences. Anything that is
 * not an object with a non-empty string `path` is rejected — the marker then
 * stays visible as text, which is the honest failure mode.
 */
export function parseCodexVisualizeArgs(
  json: string
): CodexVisualizeRef | null {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof value !== "object" || value === null) return null
  const path = (value as { path?: unknown }).path
  if (typeof path !== "string" || path.trim().length === 0) return null
  const mode = (value as { mode?: unknown }).mode
  return { path: path.trim(), mode: mode === "wide" ? "wide" : "normal" }
}

/**
 * Split a reply into Markdown runs and visualization references, in order.
 *
 * Fenced code blocks are skipped so a reply that *documents* the marker (as
 * the skill's own SKILL.md does) keeps it as literal code. Adjacent Markdown
 * is merged; a reply without any valid marker comes back as one Markdown
 * segment.
 */
export function splitCodexVisualizeRefs(text: string): CodexVisualizeSegment[] {
  if (!hasCodexVisualizeRef(text)) return [{ kind: "markdown", text }]

  const segments: CodexVisualizeSegment[] = []
  let markdown = ""
  const flushMarkdown = () => {
    if (markdown.length > 0) {
      segments.push({ kind: "markdown", text: markdown })
      markdown = ""
    }
  }

  const lines = text.split("\n")
  let fence: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const eol = i < lines.length - 1 ? "\n" : ""
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (fenceMatch) {
      const run = fenceMatch[1]
      if (fence === null) fence = run
      else if (run[0] === fence[0] && run.length >= fence.length) fence = null
      markdown += line + eol
      continue
    }
    if (fence !== null) {
      markdown += line + eol
      continue
    }

    const bare = BARE_VISUALIZE_LINE.exec(line)
    const bareRef = bare ? parseCodexVisualizeArgs(bare[1]) : null
    if (bareRef) {
      flushMarkdown()
      segments.push({ kind: "visualize", ref: bareRef, raw: line.trim() })
      continue
    }

    const hermes = HERMES_PREVIEW_LINE.exec(line)
    if (hermes && hermes[1].trim().length > 0) {
      flushMarkdown()
      segments.push({
        kind: "visualize",
        ref: { path: hermes[1].trim(), mode: "normal" },
        raw: line.trim(),
      })
      continue
    }

    let rest = line
    let consumed = false
    for (;;) {
      const start = rest.indexOf(MARKER_START)
      if (start === -1) break
      const argsStart = start + MARKER_START.length
      const end = rest.indexOf(CODEX_VISUALIZE_CLOSE, argsStart)
      if (end === -1) break
      const ref = parseCodexVisualizeArgs(rest.slice(argsStart, end))
      const raw = rest.slice(start, end + CODEX_VISUALIZE_CLOSE.length)
      if (ref === null) {
        // Keep the malformed marker as text and continue scanning after it.
        markdown += rest.slice(0, end + CODEX_VISUALIZE_CLOSE.length)
        rest = rest.slice(end + CODEX_VISUALIZE_CLOSE.length)
        continue
      }
      markdown += rest.slice(0, start)
      flushMarkdown()
      segments.push({ kind: "visualize", ref, raw })
      rest = rest.slice(end + CODEX_VISUALIZE_CLOSE.length)
      consumed = true
    }
    if (consumed) {
      // Drop whitespace-only leftovers so the card is not followed by an
      // empty paragraph; keep anything the model wrote after the marker.
      if (rest.trim().length > 0) markdown += rest + eol
      else if (eol && markdown.length > 0) markdown += eol
    } else {
      markdown += rest + eol
    }
  }
  flushMarkdown()

  if (!segments.some((s) => s.kind === "visualize")) {
    return [{ kind: "markdown", text }]
  }
  return segments
}

/**
 * A fragment vs. a complete document. The skill writes fragments (the Codex
 * app supplies the document around them); an export made with its `render.py`
 * is a complete document and must be shown as-is.
 */
export function isCompleteHtmlDocument(html: string): boolean {
  return /<!doctype\s|<\s*(?:html|head|body)(?:\s|>)/i.test(html)
}

// ── Mentions of local HTML files ─────────────────────────────────────────

const HTML_EXT = String.raw`\.html?`
/** `MEDIA:/abs/x.html` — Hermes' attachment reference. */
const MEDIA_RE = new RegExp(
  String.raw`MEDIA:((?:~|/)[^\s*\`'"<>]*?${HTML_EXT})(?![\w/])`,
  "gi"
)
/** `[label](target.html)` — a Markdown link to a file. */
const LINK_RE = new RegExp(
  String.raw`\]\(\s*<?([^()\s<>]+?${HTML_EXT})(?:#[^)\s]*)?>?\s*\)`,
  "gi"
)
/** `` `path/to/x.html` `` — a path in inline code. */
const CODE_RE = new RegExp(String.raw`\`([^\`\s]+?${HTML_EXT})\``, "gi")
/** A bare absolute (or `~/`, `file://`) path in prose. Not preceded by a word
 *  character, `/`, `:` or `.`, so the path part of a URL never matches. */
const BARE_RE = new RegExp(
  String.raw`(?<![\w/:.\-])((?:file://)?(?:~/|/)[^\s\`'"<>()\[\]*]*?${HTML_EXT})(?![\w/])`,
  "gi"
)

/** Normalise one candidate; `null` for anything that is not a local path. */
function normalizeMention(raw: string, allowRelative: boolean): string | null {
  let path = raw.trim()
  if (/^file:\/\//i.test(path)) path = path.replace(/^file:\/\//i, "")
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return null // http:, https:, data: …
  try {
    path = decodeURI(path)
  } catch {
    // keep as written
  }
  if (path.startsWith("/") || path.startsWith("~/")) return path
  if (!allowRelative) return null
  if (!/^[\w@+%.\-][\w@+%./\-]*$/.test(path)) return null
  return path.replace(/^\.\//, "")
}

/**
 * Local HTML files a reply mentions, in order of first appearance, without
 * duplicates. Relative paths (`index.html`, `out/report.html`) are only taken
 * from inline code and Markdown links — the places an agent names a file on
 * purpose — and are returned as written; the caller resolves them against the
 * conversation's folder. Fenced code blocks, explicit preview references
 * (handled by {@link splitCodexVisualizeRefs}) and anything in `exclude` are
 * skipped. At most `limit` paths are returned.
 */
export function findHtmlFileMentions(
  text: string,
  {
    exclude = [],
    limit = 4,
  }: { exclude?: Iterable<string>; limit?: number } = {}
): string[] {
  if (!/\.html?/i.test(text)) return []
  const skip = new Set(exclude)
  const found: { index: number; path: string }[] = []

  let fence: string | null = null
  let offset = 0
  for (const line of text.split("\n")) {
    const lineStart = offset
    offset += line.length + 1
    const fenceMatch = /^\s{0,3}(\`{3,}|~{3,})/.exec(line)
    if (fenceMatch) {
      const run = fenceMatch[1]
      if (fence === null) fence = run
      else if (run[0] === fence[0] && run.length >= fence.length) fence = null
      continue
    }
    if (fence !== null) continue
    if (
      line.includes(MARKER_START) ||
      HERMES_PREVIEW_LINE.test(line) ||
      BARE_VISUALIZE_LINE.test(line)
    )
      continue

    const collect = (re: RegExp, allowRelative: boolean) => {
      re.lastIndex = 0
      for (let m = re.exec(line); m; m = re.exec(line)) {
        const path = normalizeMention(m[1], allowRelative)
        if (path) found.push({ index: lineStart + m.index, path })
      }
    }
    collect(MEDIA_RE, false)
    collect(LINK_RE, true)
    collect(CODE_RE, true)
    collect(BARE_RE, false)
  }

  found.sort((a, b) => a.index - b.index)
  const out: string[] = []
  for (const { path } of found) {
    if (skip.has(path) || out.includes(path)) continue
    out.push(path)
    if (out.length >= limit) break
  }
  return out
}
