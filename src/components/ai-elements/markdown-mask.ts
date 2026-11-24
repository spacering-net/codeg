/**
 * Placeholder masking for the pre-parse Markdown rewrites this directory runs
 * before handing text to Streamdown (`normalizeMathDelimiters` in message.tsx,
 * `escapeWindowsPathSeparators` in windows-path-escape.ts).
 *
 * Both rewrites edit the *source string*, so both must first take the regions
 * whose bytes are already literal — fenced blocks and inline code — out of
 * harm's way. Sharing the pattern and the placeholder here keeps the two from
 * drifting apart: a region one rewrite protects and the other does not would
 * corrupt exactly the content users are most likely to paste verbatim.
 */

/**
 * Fenced code blocks and inline code spans. Fences are matched before inline
 * spans so a ``` block containing single backticks is captured whole. The
 * inline alternative excludes LF, so a stray backtick cannot swallow the rest
 * of a message.
 */
export const CODE_SPANS = /`{3,}[\s\S]*?`{3,}|~{3,}[\s\S]*?~{3,}|`[^`\n]+`/g

/**
 * NUL-delimited so the placeholder cannot collide with anything a Markdown
 * rewrite might produce, and cannot be mistaken for prose by a scanner working
 * on the masked text.
 */
const PLACEHOLDER = /\0CBLK(\d+)\0/g

export interface MaskedSource {
  /** `text` with every `pattern` match replaced by an opaque placeholder. */
  masked: string
  /** Put the masked regions back, verbatim, once the rewrite is done. */
  restore: (rewritten: string) => string
}

/**
 * Replace every match of `pattern` (which MUST be a global regex) with an
 * opaque placeholder, returning the masked text plus the inverse operation.
 */
export function maskLiteralSpans(
  text: string,
  pattern: RegExp = CODE_SPANS
): MaskedSource {
  const saved: string[] = []
  const masked = text.replace(pattern, (match) => {
    saved.push(match)
    return `\0CBLK${saved.length - 1}\0`
  })
  return {
    masked,
    restore: (rewritten: string) =>
      rewritten.replace(
        PLACEHOLDER,
        (_m, index: string) => saved[Number(index)]
      ),
  }
}
