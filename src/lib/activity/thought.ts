/**
 * A one-line title for a reasoning block, so a folded thought still says what
 * it was about ("Thought · Summarizing log status") instead of a bare
 * "Thought".
 *
 * Models that write reasoning summaries open each section with a heading —
 * a whole line of bold (`**Planning the fix**`) or an ATX heading. While the
 * block is still being written the newest heading is the live topic; once it
 * is done the first one names it, since later headings are steps inside it.
 * Reasoning without headings falls back to its first sentence.
 */

const MAX_TITLE_LENGTH = 60

const BOLD_LINE_RE = /^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*:?\s*$/
const ATX_HEADING_RE = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/
const SENTENCE_END_RE = /[.!?。！？](?=\s|$)/

function cleanInline(text: string): string {
  return text
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*|__/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function clip(text: string): string {
  if (text.length <= MAX_TITLE_LENGTH) return text
  return `${text.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`
}

function headings(content: string): string[] {
  const found: string[] = []
  let inFence = false
  for (const line of content.split("\n")) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const match = line.match(BOLD_LINE_RE) ?? line.match(ATX_HEADING_RE)
    if (!match) continue
    const title = cleanInline(match[1]!)
    if (title) found.push(title)
  }
  return found
}

function firstSentence(content: string): string | null {
  const text = content
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !/^(?:```|~~~)/.test(line))
  if (!text) return null
  const plain = cleanInline(text.replace(/^[-*+>]\s+/, ""))
  if (!plain) return null
  const end = plain.search(SENTENCE_END_RE)
  return end > 0 ? plain.slice(0, end) : plain
}

export function thoughtTitle(
  content: string,
  streaming: boolean
): string | null {
  if (!content.trim()) return null
  const found = headings(content)
  if (found.length > 0) {
    return clip(streaming ? found[found.length - 1]! : found[0]!)
  }
  const sentence = firstSentence(content)
  return sentence ? clip(sentence) : null
}

/**
 * The thought's body with the heading the title already shows taken off the
 * top, so the expanded panel does not repeat the row it hangs under.
 */
export function thoughtBodyWithoutTitle(
  content: string,
  title: string | null
): string {
  if (!title) return content
  const lines = content.split("\n")
  const first = lines.findIndex((line) => line.trim().length > 0)
  if (first < 0) return content
  const match =
    lines[first]!.match(BOLD_LINE_RE) ?? lines[first]!.match(ATX_HEADING_RE)
  if (!match || clip(cleanInline(match[1]!)) !== title) return content
  return lines
    .slice(first + 1)
    .join("\n")
    .replace(/^\s*\n/, "")
}
