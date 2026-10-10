// Bare invocation tokens — `/slash` commands and `$skill`/`$expert` tokens — that
// user messages send literally (the agent CLI needs them verbatim, so there is no
// link to key a badge off). This regex is only a SHAPE test: the token is
// indistinguishable from typed text, so no surface badges it on a match alone —
// the token also has to be a known invocation (`KnownInvocations` below).
//
// The slug starts with a letter (so `/123` / `$5` don't match) and the boundary
// before it must be start-of-text or whitespace. A trailing `/` (a path like
// `/usr/bin`) or word char disqualifies it. Read through `user-message-segments.ts`
// by both the sent-message bubble and the composer's paste/seed hydration, so the
// two badge exactly the same tokens.
//
// Stateful (`g` flag): reset `lastIndex` before an `exec` loop, or use `matchAll`
// (which operates on a private copy). Capture groups: [1] = the leading
// boundary (start-of-text or the whitespace char), [2] = the token incl. prefix.
export const INVOCATION_TOKEN_RE =
  /(^|\s)([/$][A-Za-z][A-Za-z0-9_-]*)(?![/\w-])/g

/**
 * The literal invocation tokens (`/review`, `$deploy` — prefix included) the
 * current agent actually offers (the commands it advertises, plus Codex's
 * on-disk `$` skills), so a `/word` in free prose can be checked against
 * something real instead of being trusted on shape alone.
 *
 * The regex above is a shape test, and shape is all `/notacommand` needs to pass
 * it. Membership here is what both the composer and the sent-message bubble
 * require before turning such a token into a badge, matched EXACTLY: a prefix of
 * a real command (`/rev` for `/review`) is not that command, and names are
 * case-sensitive because that is how the agent CLI reads them.
 *
 * Before the connection advertises anything, the composer knows only what it
 * can without one: Codex's disk skills, and for any other agent nothing. The
 * transcript also knows what the agent last advertised in that folder
 * (`advertised-commands-store`), so its badges hold steady across a reconnect
 * or a restart; in a folder the agent never advertised in, it knows no more
 * than the composer. A surface with no agent behind it knows nothing at all.
 * Knowing too little is the safe direction: text that stays text is still
 * editable, sends byte for byte the way it was written, and in the transcript
 * shows exactly what was sent.
 */
export type KnownInvocations = ReadonlySet<string>

/** No advertised invocation: every bare `/word` / `$word` stays literal text. */
export const NO_KNOWN_INVOCATIONS: KnownInvocations = new Set<string>()
