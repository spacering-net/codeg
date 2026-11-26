/**
 * A reply that is one card and nothing else (P6: a turn's every run is
 * drawn whole, a bubble per part, never split at its paragraphs).
 */

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
