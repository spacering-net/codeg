/** A whole text inside one code fence: an opening line of three or more
 *  backticks (an info string allowed), the body, and a closing line of the
 *  same run. */
const WHOLE_FENCE_RE = /^[ \t]*(`{3,})[^`\n]*\n([\s\S]*?)\n[ \t]*\1[ \t]*$/

/**
 * The text a single code fence wraps, when that fence wraps all of `text`;
 * `text` itself otherwise.
 *
 * claude-agent-acp hands over every failed tool's result fenced
 * (`"```\n" + text + "\n```"`, its `toAcpContentBlock`) for clients that render
 * it as markdown. codeg shows an error as preformatted text, where the fence
 * prints as three backticks above and below the message — and the same card
 * read back from the transcript, which records the bare text, shows none. Only
 * a fence around the whole text is lifted, and only when no line inside could
 * close it first: anything else is more than one block, and stays as written.
 */
export function unwrapWholeFence(text: string): string {
  const match = WHOLE_FENCE_RE.exec(text.trim())
  if (!match) return text
  const [, fence, body] = match
  if (body.split("\n").some((line) => line.trimStart().startsWith(fence))) {
    return text
  }
  return body
}
