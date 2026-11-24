/**
 * JSON parsing that says WHERE the bad JSON came from.
 *
 * A bare `JSON.parse` failure surfaces as, verbatim, `Unterminated string in
 * JSON at position 80865 (line 1 column 80866)`. That names neither the file,
 * the API call, nor the field — so the only thing a user can report is the
 * offset, and the only thing a maintainer can do with the offset is guess.
 * Exactly that report arrived as part of #736, and it could not be traced.
 *
 * This is a diagnostics improvement, not a fix for whatever produced the
 * malformed payload: it does not make bad JSON parse, it makes the failure
 * identify itself.
 *
 * Nothing here quotes the body verbatim, and that is a hard requirement rather
 * than caution. The call in the original report was `acp_list_agents`, whose
 * rows carry each agent's `env` map — where users keep their provider API keys.
 * An error message is the one artifact a user is explicitly invited to paste
 * into a public issue. So both the excerpt this module builds and the engine's
 * own message (V8 quotes source text back at you for some inputs) are reduced
 * to structure before they go anywhere.
 */

/** How much of the document to quote on either side of the failure offset. */
const EXCERPT_RADIUS = 60

/** Parse the `position N` the engines put in their message. */
function offsetFromMessage(message: string): number | null {
  // V8: "... at position 80865 (line 1 column 80866)".
  // JavaScriptCore does not report an offset at all, hence the null case.
  const match = /position (\d+)/.exec(message)
  if (!match) return null
  const parsed = Number.parseInt(match[1], 10)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Put the engine's OWN message under the same policy as the excerpt.
 *
 * `JSON.parse` does not just report a position — every engine quotes some of
 * the source straight back at you, and each does it differently. Measured, not
 * assumed:
 *
 *     V8   `{"k":"SSSSS","x":}`  ->  Unexpected token '}', "{"k":"SSSSS","x":}" is not valid JSON
 *     V8   (older)               ->  Unexpected token o in JSON at position 1
 *     JSC  `SECRET`              ->  JSON Parse error: Unexpected identifier "SECRET"
 *     JSC  `{"k":"SSSSS","x":}`  ->  JSON Parse error: Unexpected token '}'
 *
 * Redacting our own excerpt would buy nothing while any of those rode along
 * untouched — and JSC is not hypothetical here, it is what the desktop build's
 * webview runs.
 *
 * Three passes, in order: cut at the first double quote (V8's document window
 * and JSC's quoted identifier both start there, and nothing after it is worth
 * keeping); redact inside single quotes (the offending token); redact a bare
 * token after `token ` (older V8). What survives is the English phrasing and
 * the position, which is the whole of the useful part.
 */
function sanitizeEngineMessage(message: string): string {
  const quote = message.indexOf('"')
  const head =
    quote < 0 ? message : message.slice(0, quote).replace(/[\s,.]+$/, "")
  return head
    .replace(/'([^']*)'/g, (_, token: string) => `'${redact(token)}'`)
    .replace(
      /(token )(\S)(?=\s|$)/g,
      (_, lead: string, token: string) => `${lead}${redact(token)}`
    )
}

/**
 * Reduce one character to its class.
 *
 * The excerpt exists to show the SHAPE of the failure — an unterminated
 * string, a stray brace, an HTML error page where JSON was expected, a raw
 * control byte mid-document. None of that needs the actual bytes, and the
 * actual bytes are not safe to quote: the payload that produced the report in
 * #736 was `acp_list_agents`, whose rows carry each agent's `env` map, which is
 * where users put their provider API keys. An error message is the one thing a
 * user is explicitly invited to paste into a public issue, so it must not be
 * able to carry a credential out of the app.
 *
 * So: punctuation and spaces survive verbatim — that IS the structure, and
 * `<!DOCTYPE html>` still reads as `<!AAAAAAA aaaa>`. Letters and digits
 * collapse to `A`/`a`/`0`. Control characters are escaped rather than dropped,
 * because a raw newline or NUL inside the body is itself the diagnosis.
 * Everything non-ASCII becomes `·`, which also disposes of the lone surrogate
 * that slicing on a UTF-16 boundary can leave behind.
 *
 * Codepoint tests rather than regex character classes throughout: a class would
 * have to spell a control-character range in escapes, which is easy to mangle
 * and silently inverts its own meaning when it is.
 */
function redactChar(char: string): string {
  const code = char.charCodeAt(0)
  if (code < 32 || code === 127) {
    return "\\x" + code.toString(16).padStart(2, "0")
  }
  if (code > 127) return "·"
  if (code >= 65 && code <= 90) return "A"
  if (code >= 97 && code <= 122) return "a"
  if (code >= 48 && code <= 57) return "0"
  return char
}

/** [`redactChar`] over a whole slice. Iterates by codepoint, not code unit. */
function redact(raw: string): string {
  return Array.from(raw).map(redactChar).join("")
}

/**
 * A structural window around `offset`, with the boundary marked and the
 * contents redacted (see [`redactChar`] for why).
 */
export function jsonExcerpt(raw: string, offset: number | null): string {
  if (offset === null) {
    const head = raw.slice(0, EXCERPT_RADIUS * 2)
    return `${redact(head)}${head.length < raw.length ? "…" : ""}`
  }
  // Clamp: the offset is parsed out of an engine's prose, so a different or
  // future engine reporting one past the end must still produce a window.
  const at = Math.min(Math.max(offset, 0), raw.length)
  const start = Math.max(0, at - EXCERPT_RADIUS)
  const end = Math.min(raw.length, at + EXCERPT_RADIUS)
  return `${start > 0 ? "…" : ""}${redact(raw.slice(start, at))}⟪here⟫${redact(
    raw.slice(at, end)
  )}${end < raw.length ? "…" : ""}`
}

/**
 * `JSON.parse` with the source named in the error.
 *
 * `source` should say what a user could act on — a file path, an API endpoint,
 * a config field — not the variable name at the call site.
 */
export function parseJsonOrThrow<T = unknown>(raw: string, source: string): T {
  try {
    return JSON.parse(raw) as T
  } catch (err) {
    // A non-`Error` throw is discarded rather than stringified: native
    // `JSON.parse` always throws a `SyntaxError`, so anything else came from a
    // polyfill or a shimmed global, and `String(err)` on one of those has been
    // known to be the input itself. Nothing is worth reading it for.
    const raised = err instanceof Error ? err.message : "non-Error throw"
    // Sanitize BEFORE reading the offset, so a document that happens to contain
    // the text "position 12345" cannot steer the window either.
    const message = sanitizeEngineMessage(raised)
    const offset = offsetFromMessage(message)
    const size = `${raw.length} chars`
    throw new SyntaxError(
      `Invalid JSON from ${source} (${size}): ${message}\n  near: ${jsonExcerpt(
        raw,
        offset
      )}`
    )
  }
}
