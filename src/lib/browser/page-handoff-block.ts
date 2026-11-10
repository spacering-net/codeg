/**
 * What the built-in browser handed a conversation, read back out of the block
 * it wrote for the agent.
 *
 * "Send to chat" puts a badge in the composer named in the person's own
 * language — "Page screenshot", "3 console errors" — and sends the agent a
 * block the backend writes in English (`browser/handoff.rs`). An agent's own
 * record of the message keeps the block and nothing of the badge, so a message
 * re-read from that record has to learn from the block what the badge said:
 * which kind of thing went over, and for a picked element, its label.
 */

/** How every such block opens (`UNTRUSTED_NOTE` in `browser/handoff.rs`). It
 *  is what tells one apart from a pasted file that happens to hold lines
 *  like `- element: …`. */
const HEADER = "Captured from a web page in the built-in browser"

/**
 * The fact naming what was handed over. The first one is the block's own:
 * everything a page wrote that can run over several lines — an element's text
 * and attributes, the markup and console lines in their fences — comes after
 * it. (The `- page:` title above it is the page's too, but a document title
 * has its line breaks collapsed before it gets here.)
 */
const KIND_LINE = /^- (element|screenshot|console):[ \t]*(.*)$/m

/** Added under a screenshot the person drew on (`withMarkup`). A screenshot's
 *  block holds nothing else a page wrote, so the line can only be that. */
const MARKUP_LINE = /^- markup:/m

export type PageHandoffBlock =
  | {
      kind: "element"
      /** The label the picker gave the element — the badge's own. */
      label: string
    }
  | { kind: "screenshot"; marked: boolean }
  | { kind: "console"; count: number }

/** What a block the built-in browser wrote says was handed over, or null for
 *  a block it did not write. */
export function readPageHandoffBlock(text: string): PageHandoffBlock | null {
  if (!text.trimStart().startsWith(HEADER)) return null
  const fact = KIND_LINE.exec(text)
  if (!fact) return null
  const value = fact[2].trim()
  switch (fact[1]) {
    case "element":
      return { kind: "element", label: value }
    case "screenshot":
      return { kind: "screenshot", marked: MARKUP_LINE.test(text) }
    default: {
      const count = /^\d+/.exec(value)
      return count ? { kind: "console", count: Number(count[0]) } : null
    }
  }
}
