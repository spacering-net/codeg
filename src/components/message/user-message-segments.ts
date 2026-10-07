import { parseCodegReferenceUri } from "@/components/chat/composer/reference-uri"
import type { ReferenceAttrs } from "@/components/chat/composer/types"
import {
  INVOCATION_TOKEN_RE,
  type KnownInvocations,
} from "@/lib/invocation-token"
import {
  tokenizeReferenceLinks,
  unescapeReferenceLabel,
  unwrapReferenceDestination,
} from "@/lib/reference-link"

/**
 * One render unit of a user message: a run of literal prose, or a resolved
 * reference to show as an inline badge.
 */
export type UserMessageSegment =
  | { kind: "text"; text: string }
  | { kind: "reference"; attrs: ReferenceAttrs }

/**
 * Only these schemes become badges. A `[label](https://…)` a user typed is NOT a
 * reference — it stays literal text (the composer is plain-text; genuine badges
 * are always inserted via the `@`·`/`·`$` menus and serialize to `file:`/`codeg:`).
 */
const REFERENCE_SCHEME = /^(?:file:|codeg:)/i

/**
 * Split a plain-prose run into literal text and bare `/slug`·`$slug` skill
 * badges (same {@link INVOCATION_TOKEN_RE} the composer's `/`·`$` triggers use).
 * The badge label drops the literal `/`·`$` prefix (the parser strips it) so a
 * sent invocation token renders identically to the composer's inline badge,
 * which shows the bare command/skill name.
 *
 * `known`, when given, is the list of invocations the agent actually advertises,
 * and a token outside it stays literal text.
 */
function pushProseSegments(
  value: string,
  out: UserMessageSegment[],
  known: KnownInvocations | undefined
): void {
  INVOCATION_TOKEN_RE.lastIndex = 0
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = INVOCATION_TOKEN_RE.exec(value)) !== null) {
    const token = match[2]
    // Shape alone says nothing about whether this is a command; when the caller
    // knows the real list, the token has to be on it. Leaving the token inside
    // the current run (rather than pushing it as its own text segment) keeps
    // prose that badges nothing as one contiguous segment.
    if (known && !known.has(token)) continue
    const tokenStart = match.index + match[1].length
    if (tokenStart > lastIndex) {
      out.push({ kind: "text", text: value.slice(lastIndex, tokenStart) })
    }
    const slug = token.slice(1)
    // Resolve through the shared reference parser, which strips the leading
    // `/`·`$` so the badge label is the bare slug (`build`, `deploy`) — matching
    // the composer's inline command/skill badge.
    const attrs = parseCodegReferenceUri(
      `codeg://skill/${encodeURIComponent(slug)}`,
      token
    )
    out.push(
      attrs ? { kind: "reference", attrs } : { kind: "text", text: token }
    )
    lastIndex = INVOCATION_TOKEN_RE.lastIndex
  }
  if (lastIndex < value.length) {
    out.push({ kind: "text", text: value.slice(lastIndex) })
  }
}

export interface UserMessageSegmentOptions {
  /**
   * Restrict pass 2 below to the invocations an agent really advertises — the
   * composer passes it so seeded/pasted text cannot invent a command. Omitting
   * it keeps the bare-token heuristic on its own, which is what the transcript
   * does: a sent message is already fixed text, and a list that arrives with the
   * connection would otherwise re-badge history underneath the reader.
   */
  knownInvocations?: KnownInvocations
}

/**
 * Parse a sent user-message text string into ordered render segments: literal
 * prose (line breaks preserved by the renderer) interleaved with the five
 * built-in reference badges. Pure — no React, so it round-trips against
 * {@link "@/components/chat/composer/reference-text".referenceToMarkdown} in tests.
 *
 * Two passes over the shared wire format (unchanged by this feature):
 *  1. {@link tokenizeReferenceLinks} splits `[label](dest)` links from prose. A
 *     link whose (angle-unwrapped) destination is a `file:`/`codeg:` reference
 *     becomes a badge via {@link parseCodegReferenceUri}; any other link stays
 *     literal (rendered as its raw `[label](dest)` source).
 *  2. The prose between links is scanned for bare `/slug`·`$slug` skill tokens.
 *
 * Deliberately NOT Markdown: headings/bold/lists/code/tables in the text stay
 * literal, matching the plain-text composer.
 *
 * {@link UserMessageSegmentOptions.knownInvocations} narrows pass 2. Pass 1 is
 * unaffected either way — a `file:`/`codeg:` link is unambiguous.
 */
export function parseUserMessageSegments(
  text: string,
  options?: UserMessageSegmentOptions
): UserMessageSegment[] {
  const known = options?.knownInvocations
  const out: UserMessageSegment[] = []
  for (const token of tokenizeReferenceLinks(text)) {
    if (token.type === "link") {
      const destination = unwrapReferenceDestination(token.destination)
      if (REFERENCE_SCHEME.test(destination)) {
        const attrs = parseCodegReferenceUri(
          destination,
          unescapeReferenceLabel(token.label)
        )
        if (attrs) {
          out.push({ kind: "reference", attrs })
          continue
        }
      }
      // Not a recognized reference link: keep its raw source verbatim.
      out.push({ kind: "text", text: token.raw })
      continue
    }
    pushProseSegments(token.value, out, known)
  }
  return out
}
