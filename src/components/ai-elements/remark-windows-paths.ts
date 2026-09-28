/**
 * Restore the Windows path separators CommonMark drops (issue #508).
 *
 * The parser reads `\` + ASCII punctuation as an escape and drops the
 * backslash, so a Windows path in agent prose is silently corrupted whenever a
 * segment starts with punctuation — which every dot-directory does:
 *
 *   agent wrote   C:\workspace\…\hj-cloud-single.git\.playwright-cli\shot.png
 *   rendered as   C:\workspace\…\hj-cloud-single.git.playwright-cli\shot.png
 *
 * `\w`, `\c`, `\h`, `\p` survive (those letters are not escapable), so only the
 * one separator vanishes and the result still *looks* like a path — it just
 * points nowhere, and `link-safety` then hands that dead path to the file
 * opener. `C:\a\-dir\_x\(y)\#z\+w\!v\file.txt` loses six separators at once.
 *
 * This repairs the PARSED TREE rather than the source text, which is what makes
 * it safe. An earlier source-level version had to answer, with regexes, every
 * question the parser answers itself — is this inside code, does this `[` open
 * a link, is this backslash an escape — and each wrong answer put visible
 * backslashes into text or deleted working Markdown. Here the parse has already
 * happened:
 *
 *   - code and math are their own node types, so they are never visited. No
 *     mask, no fence/indent/backtick heuristics, nothing to get wrong.
 *   - a text node's content is by definition not markup, so restoring a
 *     backslash inside it CANNOT change the document's structure. The tree is
 *     never reshaped — only `value` and `url` strings gain back their
 *     separators — so the rendering can differ from before only by the
 *     separators this exists to restore.
 *   - `position` gives the ORIGINAL source for each node, which still holds the
 *     backslashes the parser dropped.
 *
 * Deliberately narrow, and the limits are accepted (a miss leaves the
 * pre-existing bug; a false positive would corrupt correct Markdown):
 *
 *   - a BARE relative path (`src\.env`) is not recognized: it cannot be told
 *     apart from a legitimate `foo\_bar` escape agents write in prose.
 *   - a path is never followed across whitespace, so a spaced path with a
 *     punctuation-initial segment (`C:\Program Files\.next\x`) keeps the bug.
 *     Following one means a backslash arbitrarily far to the right can
 *     retroactively pull a whole sentence in, and every bound on that is a
 *     guess that mangles either real directory names or real prose.
 *   - markup the eaten separator already caused stays as it is: in
 *     `C:\repo\__pycache__\x` the emphasis has been parsed before this runs, so
 *     the separator comes back but the `<em>` remains. Reshaping the tree is
 *     exactly the freedom that made the source-level version dangerous.
 *   - a separator at the END OF A LINE is consumed as a hard break, so it lives
 *     in a `break` node and is not restored. Putting it back would mean
 *     deciding that `See C:\foo\bar\` + newline is a path and not the line
 *     break the author asked for, and that is not decidable.
 */

/** The characters CommonMark lets a backslash escape. */
const ASCII_PUNCTUATION = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"

/**
 * Start of a Windows path: a drive (`C:\`, `C:/`), a UNC / extended-length
 * prefix (`\\`), or an explicit relative path (`.\`, `..\`).
 *
 * Preceding-character constraints are checked in code rather than with a
 * lookbehind, which older WebKit (the macOS Tauri webview before Safari 16.4)
 * rejects at parse time — a syntax error there would take down the module.
 */
const PATH_ANCHOR = /[A-Za-z]:[\\/]|\\{2}|\.{1,2}\\/g

/**
 * An anchor that is not a drive letter only counts at a word boundary, never
 * mid-token: `A\\B\_C` renders `A\B_C` and must keep to it, so the `\\` there
 * is not a UNC prefix.
 */
const ANCHOR_BOUNDARY_PREFIX = /[\s("'[]/

function isAsciiPunctuation(ch: string | undefined): boolean {
  return ch !== undefined && ASCII_PUNCTUATION.includes(ch)
}

/**
 * A character that can appear inside a path segment. Excludes whitespace, the
 * separators, and the characters Windows forbids in a file name (`:"<>|*?`).
 */
function isPathChar(ch: string | undefined): boolean {
  if (ch === undefined) return false
  if (/\s/.test(ch)) return false
  return !'\\/:"<>|*?'.includes(ch)
}

function isSeparator(ch: string | undefined): boolean {
  return ch === "\\" || ch === "/"
}

function isAnchorUsable(text: string, index: number, anchor: string): boolean {
  const before = index > 0 ? text[index - 1] : undefined
  if (before === undefined) return true
  if (anchor[1] === ":") {
    // A drive letter, not the tail of a scheme: `http://` must not match.
    return !/[A-Za-z0-9]/.test(before)
  }
  // UNC (`\\`) and explicit-relative (`.\`) prefixes.
  return ANCHOR_BOUNDARY_PREFIX.test(before)
}

/**
 * The half-open ranges of `raw` that look like a Windows path. A run is just
 * path characters and separators up to the first character that cannot be in
 * one — whitespace included, which is the whole of the "never cross into
 * prose" rule.
 */
function pathRanges(raw: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  PATH_ANCHOR.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = PATH_ANCHOR.exec(raw)) !== null) {
    const start = match.index
    if (ranges.length > 0 && start < ranges[ranges.length - 1][1]) {
      PATH_ANCHOR.lastIndex = ranges[ranges.length - 1][1]
      continue
    }
    if (!isAnchorUsable(raw, start, match[0])) continue
    let end = start + match[0].length
    while (
      end < raw.length &&
      (isPathChar(raw[end]) || isSeparator(raw[end]))
    ) {
      end += 1
    }
    ranges.push([start, end])
    PATH_ANCHOR.lastIndex = end
  }
  return ranges
}

/**
 * Apply CommonMark's `characterEscape` construct to `raw` the way the parser
 * does — left to right, so `\\` consumes both characters and the parity of a
 * backslash run takes care of itself — optionally KEEPING the backslash when it
 * is a Windows path separator.
 *
 * Three conditions besides being inside a path run decide that a dropped
 * backslash really was a separator, and each keeps an already-correct rendering
 * exactly as it is:
 *
 *   - what it escapes must be able to START a segment. `\*` is not a separator
 *     — `*` cannot be in a Windows file name — so `C:\\\*b*` keeps rendering
 *     `C:\*b*` rather than gaining a backslash.
 *   - it must not escape another backslash: the parser already emits one
 *     literal backslash for `\\`, which IS the separator.
 *   - it must not FOLLOW a backslash, i.e. it belongs to a run the agent
 *     escaped itself. `C:\\\.env` renders `C:\.env` today and must keep to it.
 */
function applyEscapes(raw: string, keepSeparators: boolean): string {
  const ranges = keepSeparators ? pathRanges(raw) : []
  let rangeIndex = 0
  let out = ""
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]
    const next = raw[i + 1]
    if (ch !== "\\" || !isAsciiPunctuation(next)) {
      out += ch
      continue
    }
    while (rangeIndex < ranges.length && ranges[rangeIndex][1] <= i) {
      rangeIndex += 1
    }
    const isSeparatorEscape =
      next !== "\\" &&
      raw[i - 1] !== "\\" &&
      isPathChar(next) &&
      rangeIndex < ranges.length &&
      ranges[rangeIndex][0] <= i &&
      i < ranges[rangeIndex][1]
    if (isSeparatorEscape) out += "\\"
    out += next
    i += 1
  }
  return out
}

/**
 * The repaired form of `raw` — the original source of a parsed string — or null
 * when nothing needs restoring. Exported for tests: this is the whole rule, and
 * asserting it directly is cheaper than building a tree for every shape.
 */
export function restorePathSeparators(
  raw: string,
  parsed: string
): string | null {
  if (!raw.includes("\\")) return null
  // Only touch a value the escape rule alone explains. Anything else — a
  // character reference, say — means this node's text came from somewhere the
  // simple model does not cover, and guessing there could corrupt it.
  if (applyEscapes(raw, false) !== parsed) return null
  const repaired = applyEscapes(raw, true)
  return repaired === parsed ? null : repaired
}

interface MdastNode {
  type: string
  value?: unknown
  url?: unknown
  position?: {
    start?: { offset?: number }
    end?: { offset?: number }
  }
  children?: unknown
}

function rawOf(node: MdastNode, source: string): string | null {
  const start = node.position?.start?.offset
  const end = node.position?.end?.offset
  if (typeof start !== "number" || typeof end !== "number") return null
  return source.slice(start, end)
}

/**
 * Where a link's label ends inside `raw`, taken from the LAST child's position
 * rather than by searching for `](`. A label can contain that sequence itself —
 * in ``[x `](C:\a\.b` y](C:\a.b)`` the first one is inside a code span — and
 * mistaking it for the destination rewrites the wrong text.
 */
function labelEndInRaw(node: MdastNode, nodeStart: number): number | null {
  const children = node.children
  if (!Array.isArray(children)) return null
  // An empty label is exactly `[]`, so its `]` is at index 1.
  if (children.length === 0) return 1
  const last = children[children.length - 1] as MdastNode
  const end = last.position?.end?.offset
  return typeof end === "number" ? end - nodeStart : null
}

/**
 * IMAGE destinations are deliberately not repaired.
 *
 * An mdast `image` carries its label as the `alt` STRING and has no children,
 * so nothing in the tree says where its label ends and the destination would
 * have to be GUESSED — and every guess has an adversarial failure. Searching
 * from the right takes bytes out of a title; searching from the left takes them
 * out of a code span in the alt; either can rewrite a perfectly good REMOTE url
 * and point the image at a different file.
 *
 * Local images are handled by remarkLocalImages using the parsed destination.
 * Forward-slash paths and percent-encoded file URIs avoid these ambiguous
 * backslash escapes without guessing where the image label ends.
 */

/**
 * Locate a link's raw destination by replaying the escape rule from just after
 * the label and comparing to `url` one character at a time, bailing the moment
 * they diverge. Comparing per character rather than re-testing a growing prefix
 * keeps this LINEAR — the prefix form made a long destination quadratic.
 *
 * A match must also END where a destination can: at `)`, at the whitespace
 * before a title, or at the `>` of an angle form. Without that, a run of bytes
 * that merely happens to decode to `url` — inside a title, say — would pass.
 * Anything it cannot explain is refused.
 */
function destinationRange(
  raw: string,
  url: string,
  labelEnd: number
): { start: number; end: number } | null {
  if (raw[labelEnd] !== "]" || raw[labelEnd + 1] !== "(") return null
  let start = labelEnd + 2
  while (start < raw.length && /[ \t\n]/.test(raw[start])) start += 1
  const angled = raw[start] === "<"
  if (angled) start += 1

  let matched = 0
  let i = start
  while (i < raw.length) {
    const ch = raw[i]
    if (angled && ch === ">") break
    let produced: string
    if (ch === "\\" && isAsciiPunctuation(raw[i + 1])) {
      produced = raw[i + 1]
      i += 2
    } else {
      produced = ch
      i += 1
    }
    if (produced !== url[matched]) return null
    matched += 1
    if (matched === url.length) {
      const after = raw[i]
      const ends = angled
        ? after === ">"
        : after === ")" || after === undefined || /[ \t\n]/.test(after)
      return ends ? { start, end: i } : null
    }
  }
  return null
}

function visit(node: MdastNode, source: string): void {
  if (node.type === "text" && typeof node.value === "string") {
    const raw = rawOf(node, source)
    if (raw !== null) {
      const repaired = restorePathSeparators(raw, node.value)
      if (repaired !== null) node.value = repaired
    }
    return
  }

  if (node.type === "link" && typeof node.url === "string") {
    const nodeStart = node.position?.start?.offset
    const raw = rawOf(node, source)
    if (raw !== null && typeof nodeStart === "number") {
      const labelEnd = labelEndInRaw(node, nodeStart)
      const range =
        labelEnd === null ? null : destinationRange(raw, node.url, labelEnd)
      if (range) {
        const repaired = restorePathSeparators(
          raw.slice(range.start, range.end),
          node.url
        )
        if (repaired !== null) node.url = repaired
      }
    }
  }

  if (Array.isArray(node.children)) {
    for (const child of node.children) visit(child as MdastNode, source)
  }
}

/**
 * Remark plugin restoring Windows path separators in text and link
 * destinations. Must run BEFORE `remarkRewriteFileUriLinks`, which reshapes a
 * drive path into the sanitize-safe `/C:\…` form.
 */
export function remarkRestoreWindowsPaths() {
  return (tree: MdastNode, file: unknown) => {
    const source = String(file)
    if (!source.includes("\\")) return
    visit(tree, source)
  }
}
