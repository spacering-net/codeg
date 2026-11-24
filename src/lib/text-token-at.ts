/**
 * Find the token sitting under a caret offset in a plain-text string.
 *
 * Used by the composer's right-click menu so a click lands ON something: the
 * token under the pointer is selected before the menu opens, and Cut/Copy —
 * plus whatever that kind of token can do — apply to it with nothing selected
 * by hand first.
 *
 * The unit is the whitespace-delimited run around the offset with wrapping
 * punctuation peeled off ("quoted", (parenthesised), a trailing full stop), so
 * a token written inside a sentence still comes out whole. That is wider than a
 * double-click word on purpose: someone right-clicking an address or a path
 * means all of it, not the fragment between two dots.
 */

export type TextTokenKind = "email" | "url" | "path" | "word"

export interface TextToken {
  kind: TextTokenKind
  /** The token exactly as it appears in the source text. */
  value: string
  /** Offset of the token's first character in the source text. */
  start: number
  /** Offset one past the token's last character in the source text. */
  end: number
  /**
   * Canonical uri for the kinds that have one — `mailto:` for an address, the
   * link itself (or an `https://` completion) for a url. Absent for a path or a
   * plain word, which are not opened through a url.
   */
  href?: string
}

const WHITESPACE = /\s/

/** Opening punctuation peeled off the front of a run. */
const LEADING_TRIM = new Set([
  "(",
  "[",
  "{",
  "<",
  '"',
  "'",
  "`",
  "\u00ab",
  "\u201c",
  "\u2018",
])

/** Sentence punctuation peeled off the end of a run. */
const TRAILING_TRIM = new Set([
  ".",
  ",",
  ";",
  ":",
  "!",
  "?",
  '"',
  "'",
  "`",
  "\u00bb",
  "\u201d",
  "\u2019",
])

/** Closers peeled off only when the run holds no matching opener. */
const BRACKETS: ReadonlyArray<readonly [string, string]> = [
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
  ["<", ">"],
]

const MAILTO = /^mailto:/i
const EMAIL =
  /^[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/
const SCHEME_URL = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+$/
const FILE_URI = /^file:\/\//i
/** `C:\…` / `C:/…`, `\\share\…`, `~/…`, `./…`, `../…`, `/…` (not `//host`). */
const ROOTED_PATH = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]|~[\\/]|\.\.?[\\/]|\/(?!\/))/
const PATH_SEPARATOR = /[\\/]/
const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/

/**
 * A schemeless `host.tld` is only read as a link when the suffix is a common
 * web tld. Source files wear the same shape (`utils.ts`, `main.rs`, `mod.py`,
 * `README.md`) and are the likelier thing to type in a coding composer, so
 * anything outside this list stays an ordinary token: still selected whole,
 * just without an "open link" action pointing at a website that isn't there.
 */
const WEB_TLDS = new Set([
  "com",
  "org",
  "net",
  "edu",
  "gov",
  "mil",
  "int",
  "io",
  "co",
  "ai",
  "app",
  "dev",
  "xyz",
  "info",
  "biz",
  "online",
  "site",
  "tech",
  "cloud",
  "store",
  "blog",
  "news",
  "page",
  "tv",
  "me",
  "cc",
  "uk",
  "us",
  "ca",
  "au",
  "de",
  "fr",
  "es",
  "it",
  "nl",
  "se",
  "jp",
  "cn",
  "in",
  "br",
  "ru",
  "eu",
])

function occurrences(value: string, char: string): number {
  let count = 0
  for (const c of value) if (c === char) count += 1
  return count
}

/** Peel wrapping/sentence punctuation off both ends until the bounds settle. */
function trimWrappers(
  text: string,
  start: number,
  end: number
): [number, number] {
  let from = start
  let to = end
  let changed = true
  while (changed && from < to) {
    changed = false
    while (from < to && LEADING_TRIM.has(text[from])) {
      from += 1
      changed = true
    }
    while (to > from && TRAILING_TRIM.has(text[to - 1])) {
      to -= 1
      changed = true
    }
    for (const [open, close] of BRACKETS) {
      while (to > from && text[to - 1] === close) {
        const slice = text.slice(from, to)
        // A closer with its opener inside the run belongs to the token
        // (a `…/Foo_(disambiguation)` url, a `{braced}` name).
        if (occurrences(slice, close) <= occurrences(slice, open)) break
        to -= 1
        changed = true
      }
    }
  }
  return [from, to]
}

/** `https://` completion for a schemeless host, or null when it isn't one. */
function schemelessUrl(value: string): string | null {
  const cut = value.search(/[/?#]/)
  const host = cut === -1 ? value : value.slice(0, cut)
  if (!HOST.test(host)) return null
  const lower = host.toLowerCase()
  const tld = lower.slice(lower.lastIndexOf(".") + 1)
  if (!lower.startsWith("www.") && !WEB_TLDS.has(tld)) return null
  return `https://${value}`
}

/** Address, link, path, or none of the three — in that order of preference. */
function classify(value: string): { kind: TextTokenKind; href?: string } {
  const address = MAILTO.test(value) ? value.slice("mailto:".length) : value
  if (EMAIL.test(address)) return { kind: "email", href: `mailto:${address}` }
  // Paths before urls: `C:\src` and `file:///tmp/x` are files, not websites.
  if (FILE_URI.test(value) || ROOTED_PATH.test(value)) return { kind: "path" }
  if (SCHEME_URL.test(value)) return { kind: "url", href: value }
  const schemeless = schemelessUrl(value)
  if (schemeless) return { kind: "url", href: schemeless }
  if (PATH_SEPARATOR.test(value)) return { kind: "path" }
  return { kind: "word" }
}

/**
 * The token covering `offset`, or null when the caret sits in whitespace (or
 * the text is empty) and there is nothing under it to act on.
 *
 * A caret resting exactly at a run's trailing edge takes that run, matching how
 * a native word selection reaches back at the end of a word.
 */
export function textTokenAt(text: string, offset: number): TextToken | null {
  if (!text) return null
  const at = Math.max(0, Math.min(offset, text.length))

  let anchor = -1
  if (at < text.length && !WHITESPACE.test(text[at])) anchor = at
  else if (at > 0 && !WHITESPACE.test(text[at - 1])) anchor = at - 1
  if (anchor < 0) return null

  let start = anchor
  let end = anchor + 1
  while (start > 0 && !WHITESPACE.test(text[start - 1])) start -= 1
  while (end < text.length && !WHITESPACE.test(text[end])) end += 1

  const [from, to] = trimWrappers(text, start, end)
  // A run that is nothing but punctuation (`...`, `-->`) keeps its raw bounds:
  // selecting it still beats offering nothing.
  const lo = from < to ? from : start
  const hi = from < to ? to : end
  const value = text.slice(lo, hi)
  return { ...classify(value), value, start: lo, end: hi }
}
