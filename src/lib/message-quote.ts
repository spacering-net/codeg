/**
 * Turn a transcript text selection into a Markdown blockquote for the composer.
 *
 * The composer is a PLAIN-TEXT editor (no blockquote node — see
 * `buildComposerExtensions`), so the quote is literal `> ` markers: what the user
 * sees in the input is exactly what the agent receives, and the transcript
 * renders it back as a blockquote once sent.
 *
 * - CR / CRLF newlines normalize to `\n` (a selection copied out of a code block
 *   can carry either).
 * - Leading and trailing blank lines are dropped — a selection that runs past the
 *   end of a paragraph routinely picks them up, and they'd otherwise become empty
 *   `>` lines around the quote.
 * - Interior blank lines become a bare `>` so the whole selection stays inside
 *   ONE blockquote; a truly empty `` line would terminate it and leave the
 *   remainder as unquoted prose.
 * - Per-line trailing whitespace is dropped so a stray double space can't turn
 *   into a Markdown hard break.
 *
 * Returns "" when the selection has no visible content, so callers can skip the
 * insert entirely. The result carries no trailing newline — separating it from
 * whatever is already in the draft is the caller's decision.
 */
export function buildQuotedMarkdown(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n")

  let start = 0
  let end = lines.length
  while (start < end && lines[start].trim() === "") start += 1
  while (end > start && lines[end - 1].trim() === "") end -= 1
  if (start === end) return ""

  return lines
    .slice(start, end)
    .map((line) => {
      const trimmed = line.trimEnd()
      return trimmed === "" ? ">" : `> ${trimmed}`
    })
    .join("\n")
}

/**
 * One level of CommonMark blockquote marker at the start of a line: up to three
 * leading spaces, a `>`, and one optional space after it. A tab is deliberately
 * NOT accepted — {@link buildQuotedMarkdown} never emits one, and swallowing a
 * tab into the (invisible) composer marker would eat a wide, visible indent.
 */
const QUOTE_MARKER_RE = /^ {0,3}> ?/

/**
 * Length of the blockquote marker starting `line`, or 0 when the line isn't
 * quoted. This is the READ side of the `> ` contract {@link buildQuotedMarkdown}
 * writes, and the ONLY place the marker shape is defined — the composer's
 * decoration ({@link "@/components/chat/composer/quote-decoration"}) and the
 * transcript's user-bubble renderer both call it, so what the input paints and
 * what the sent message renders can never drift apart.
 *
 * A bare `>` counts (length 1): that's how `buildQuotedMarkdown` keeps an
 * interior blank line inside one blockquote.
 */
export function quoteMarkerLength(line: string): number {
  return QUOTE_MARKER_RE.exec(line)?.[0].length ?? 0
}

/**
 * A run of a user message's text: literal prose, or a blockquote holding further
 * blocks (so `> > x` nests, which is exactly what quoting an agent message that
 * already contains a quote produces).
 */
export type QuoteBlock =
  | { kind: "text"; text: string }
  | { kind: "quote"; children: QuoteBlock[] }

/**
 * Split plain text into prose runs and blockquote runs.
 *
 * Deliberately NOT a Markdown parser: only a line-leading `>` means anything
 * here. `#`, `**`, `- `, code fences and everything else stay literal prose,
 * matching the plain-text composer — this exists purely so the `> ` markers the
 * quote action inserts can be painted as a quote rule instead of shown raw.
 *
 * Strictness beyond CommonMark, on purpose: lazy continuation is not
 * implemented, so an unmarked line always ends the quote. Being conservative
 * keeps prose that merely happens to sit under a quote from being absorbed.
 *
 * ONE blank line is consumed at each quote boundary. It's the structural
 * separator between a quote and the prose around it (`> a\n\nmy question`), not
 * content — leaving it in would stack a blank line on top of the block gap.
 * Extra blank lines survive, so deliberate spacing still shows.
 *
 * Text with no quoted line at all yields exactly one `text` block holding it
 * verbatim, which callers use as a zero-risk fast path.
 */
export function parseQuoteBlocks(text: string): QuoteBlock[] {
  const lines = text.split("\n")
  const blocks: QuoteBlock[] = []
  let prose: string[] = []
  // Whether the prose being accumulated directly follows a quote block, i.e.
  // whether its leading blank line is a boundary separator to swallow.
  let afterQuote = false

  const flushProse = (beforeQuote: boolean) => {
    let start = 0
    let end = prose.length
    if (afterQuote && start < end && prose[start] === "") start += 1
    if (beforeQuote && end > start && prose[end - 1] === "") end -= 1
    if (end > start) {
      blocks.push({ kind: "text", text: prose.slice(start, end).join("\n") })
    }
    prose = []
  }

  let index = 0
  while (index < lines.length) {
    const marker = quoteMarkerLength(lines[index])
    if (marker === 0) {
      prose.push(lines[index])
      index += 1
      continue
    }
    flushProse(true)
    // Strip ONE level off every line of the run, then recurse: a second `>` on
    // those lines becomes a nested quote, anything else becomes prose.
    const inner: string[] = []
    let width = marker
    while (width > 0) {
      inner.push(lines[index].slice(width))
      index += 1
      width = index < lines.length ? quoteMarkerLength(lines[index]) : 0
    }
    blocks.push({ kind: "quote", children: parseQuoteBlocks(inner.join("\n")) })
    afterQuote = true
  }
  flushProse(false)
  return blocks
}
