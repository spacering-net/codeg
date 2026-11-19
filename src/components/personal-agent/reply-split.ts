/**
 * A reply as short bubbles (10.7): its text splits at blank lines into one
 * bubble per paragraph when every paragraph is short — at most
 * `SPLIT_PARAGRAPH_CHARS` characters — and the reply holds no code block
 * and no card (a fence of either kind). At most `SPLIT_MAX_BUBBLES`; the
 * paragraphs past the last join it. Only how it shows: the reply is stored
 * as one.
 */

export const SPLIT_PARAGRAPH_CHARS = 280
export const SPLIT_MAX_BUBBLES = 4

/** A fence opens on its own line: three or more backticks or tildes, up to
 *  three spaces in. */
const FENCE = /^ {0,3}(```|~~~)/m

export function splitReply(text: string): string[] {
  const whole = text.trim()
  if (!whole || FENCE.test(whole)) return [whole]
  const paragraphs = whole
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  if (paragraphs.length < 2) return [whole]
  if (paragraphs.some((p) => Array.from(p).length > SPLIT_PARAGRAPH_CHARS)) {
    return [whole]
  }
  if (paragraphs.length <= SPLIT_MAX_BUBBLES) return paragraphs
  return [
    ...paragraphs.slice(0, SPLIT_MAX_BUBBLES - 1),
    paragraphs.slice(SPLIT_MAX_BUBBLES - 1).join("\n\n"),
  ]
}

/** The line that opens or closes a fence, and the fence it is. */
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/

/**
 * Whether a reply's text is one card and nothing else — a single ```spec
 * fence, no words before or after it: drawn as the card alone, with no
 * bubble round it.
 */
export function isOneCard(text: string): boolean {
  const lines = text.trim().split(/\r?\n/)
  if (lines.length < 3) return false
  const open = FENCE_LINE.exec(lines[0])
  if (!open || open[2].trim().split(/\s+/)[0] !== "spec") return false
  const close = FENCE_LINE.exec(lines[lines.length - 1])
  if (!close || close[2].trim() !== "" || close[1][0] !== open[1][0]) {
    return false
  }
  if (close[1].length < open[1].length) return false
  // No fence closes before the last line: one card, not two.
  return !lines.slice(1, -1).some((l) => {
    const m = FENCE_LINE.exec(l)
    return (
      m != null &&
      m[1][0] === open[1][0] &&
      m[1].length >= open[1].length &&
      m[2].trim() === ""
    )
  })
}
