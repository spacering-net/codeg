// Bare invocation tokens — `/slash` commands and `$skill`/`$expert` tokens — that
// user messages send literally (the agent CLI needs them verbatim, so there is no
// link to key a badge off). This regex finds them for badge *display*. It is
// intentionally a HEURISTIC: the token is indistinguishable from typed text.
//
// The slug starts with a letter (so `/123` / `$5` don't match) and the boundary
// before it must be start-of-text or whitespace. A trailing `/` (a path like
// `/usr/bin`) or word char disqualifies it. Shared by the user-message renderer
// (`user-message-segments.ts`) and the transcript rehype plugin
// (`ai-elements/rehype-command-badges.ts`) so both badge exactly the same tokens.
//
// Stateful (`g` flag): reset `lastIndex` before an `exec` loop, or use `matchAll`
// (which operates on a private copy). Capture groups: [1] = the leading
// boundary (start-of-text or the whitespace char), [2] = the token incl. prefix.
export const INVOCATION_TOKEN_RE =
  /(^|\s)([/$][A-Za-z][A-Za-z0-9_-]*)(?![/\w-])/g

/**
 * The literal invocation tokens (`/review`, `$deploy` — prefix included) the
 * current agent actually advertises, so a `/word` in free prose can be checked
 * against something real instead of being trusted on shape alone.
 *
 * The regex above is a shape test, and shape is all `/notacommand` needs to pass
 * it. Membership here is what the composer requires before turning such a token
 * into a badge, matched EXACTLY: a prefix of a real command (`/rev` for
 * `/review`) is not that command, and names are case-sensitive because that is
 * how the agent CLI reads them.
 *
 * An empty set is the honest answer while the connection is coming up (or for a
 * surface with no agent behind it), and it is also the safe one: text that stays
 * text is still editable, and sends byte for byte the way it was written.
 */
export type KnownInvocations = ReadonlySet<string>

/** No advertised invocation: every bare `/word` / `$word` stays literal text. */
export const NO_KNOWN_INVOCATIONS: KnownInvocations = new Set<string>()
