import {
  findSuggestionMatch,
  type SuggestionMatch,
  type Trigger,
} from "@tiptap/suggestion"

/**
 * One character after which a typed `@` may still open the mention panel.
 *
 * Whitespace (not just the literal space Tiptap accepts, so a non-breaking or
 * full-width space counts) plus the scripts that are written without spaces
 * between words — Han, kana, Hangul, Bopomofo — and the punctuation blocks
 * those scripts use: CJK Symbols and Punctuation (、。「」〜), CJK Compatibility
 * Forms, and Halfwidth/Fullwidth Forms (，！？（）).
 *
 * ASCII letters and digits are deliberately absent: the character before `@` is
 * then the tail of an email's local part (`me@x.com`), and opening a file picker
 * there is exactly the false positive the upstream prefix rule exists to stop.
 *
 * Four `Script=Common` characters are listed one by one because the scripts
 * above do not claim them and CJK text ends on them anyway: ー (U+30FC) closes a
 * large share of katakana words (ユーザー, サーバー) — exactly the position an
 * `@` follows — ・ (U+30FB) and ゠ (U+30A0) join transliterated katakana names,
 * and · (U+00B7) does the same in Chinese (玛丽·居里). Their halfwidth twins
 * are already inside the fullwidth range.
 *
 * Naming them beats widening the classes to `Script_Extensions`, which would
 * also admit 277 other code points — among them the combining marks U+0305 and
 * U+0323, and a combining mark is what this function would then read as "the
 * character before the `@`", letting a local part like `a◌̣@example.com` through
 * the guard below.
 *
 * Anchored, and matched with the `u` flag, so it accepts exactly one code point
 * — a surrogate pair (Han beyond the BMP, e.g. 𠀋) passes as the single
 * character it is rather than as two unmatchable halves.
 */
const ALLOWED_MENTION_PREFIX =
  /^[\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}　-〿︰-﹏＀-￯·゠・ー]$/u

/**
 * May a mention start at `index` (the offset of the `@`) within the text node
 * text `text`? True at the start of the text node — which is also where an `@`
 * typed right after a reference badge or a hard break lands.
 */
export function canStartMentionAt(text: string, index: number): boolean {
  if (index <= 0) return true
  // Step back a whole code point: `text` is UTF-16, so for a supplementary-plane
  // character the unit at `index - 1` is only its low surrogate.
  const unit = text.charCodeAt(index - 1)
  const prefix =
    unit >= 0xdc00 && unit <= 0xdfff && index >= 2
      ? text.slice(index - 2, index)
      : text.charAt(index - 1)
  return ALLOWED_MENTION_PREFIX.test(prefix)
}

/**
 * Tiptap's suggestion matcher with a prefix rule that CJK text can satisfy.
 *
 * Upstream ships `allowedPrefixes: [" "]`, and it joins that array straight into
 * a character class (`^[<chars>\0]?$`) — so the option can express neither a
 * Unicode property escape nor anything needing an escape, and its only literal
 * is an ASCII space. Chinese, Japanese and Korean put no spaces between words,
 * so `帮我看下@美术…` — the natural way to write the mention — never triggered
 * the panel at all. Everything except the prefix test is upstream's: we disable
 * that one check (its only other effect) and re-apply our own, reading the
 * preceding character from the same place upstream does (the text node's own
 * text, so an `@` typed right after a reference badge still counts as "start of
 * text node" rather than inheriting the badge's rendered label).
 */
export function findMentionMatch(config: Trigger): SuggestionMatch {
  const match = findSuggestionMatch({ ...config, allowedPrefixes: null })
  if (!match) return null

  // Upstream only returns a match when `nodeBefore` is a text node, and it
  // measures from that node's text: `textFrom = $position.pos - text.length`,
  // `match.index = match.range.from - textFrom`.
  const node = config.$position.nodeBefore
  const text = node?.isText ? (node.text ?? "") : ""
  const index = match.range.from - (config.$position.pos - text.length)
  return canStartMentionAt(text, index) ? match : null
}
