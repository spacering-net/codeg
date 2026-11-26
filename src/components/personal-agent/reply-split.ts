/**
 * A reply's text cut at its cards: what an assistant wrote around a card
 * is words in a bubble, and the card a message of its own under them, as
 * wide as the column — never a card on the bubble's grey (P6: a turn's
 * every run is drawn whole otherwise, never split at its paragraphs).
 */

/** The line that opens or closes a fence, and the fence it is. */
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/

export interface ReplyPiece {
  kind: "text" | "card"
  /** Its markdown: a card's whole fence, its closing line too once it
   *  came. */
  text: string
}

/**
 * A run's text as its words and its cards, in order. A card is a ```spec
 * fence (up to three spaces in, as Markdown has one) that the page draws as
 * one (`specSourceFromPre`: its first line written starts a JSON object);
 * one still being written runs to the end of the text, and a fence inside
 * another fence is that fence's text. One in a quote stays in its words.
 * Each piece keeps its text as written, line ends and all — a card's
 * source is what its id and its buttons' are made of — but for the blank
 * lines round words, which go, and words that are blank, which go too.
 * Each piece is Markdown of its own: a reference-style link or a footnote
 * defined across a card from where it is used is not resolved.
 */
export function replyPieces(text: string): ReplyPiece[] {
  // Lines with their own ends.
  const lines = text.split(/(?<=\n)/)
  const bare = (line: string) => line.replace(/\r?\n$/, "")
  const out: ReplyPiece[] = []
  let words = ""
  const flush = () => {
    const w = words
      .replace(/^(?:[ \t]*\r?\n)+/, "")
      .replace(/(?:\r?\n[ \t]*)+$/, "")
    if (w.trim()) out.push({ kind: "text", text: w })
    words = ""
  }
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE_LINE.exec(bare(lines[i]))
    if (!open) {
      words += lines[i]
      continue
    }
    // Its closing line: the same mark, at least as long, nothing after it.
    let end = i + 1
    while (end < lines.length) {
      const m = FENCE_LINE.exec(bare(lines[end]))
      if (
        m &&
        m[1][0] === open[1][0] &&
        m[1].length >= open[1].length &&
        m[2].trim() === ""
      ) {
        break
      }
      end++
    }
    const fence = lines.slice(i, Math.min(end + 1, lines.length))
    const first = fence
      .slice(1, end - i)
      .map(bare)
      .find((l) => l.trim() !== "")
    const card =
      open[2].trim().split(/\s+/)[0] === "spec" &&
      first !== undefined &&
      first.trimStart().startsWith("{")
    if (card) {
      flush()
      out.push({ kind: "card", text: fence.join("").replace(/\r?\n$/, "") })
    } else {
      words += fence.join("")
    }
    i = end
  }
  flush()
  return out
}
