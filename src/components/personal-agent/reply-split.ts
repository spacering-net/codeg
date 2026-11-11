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
