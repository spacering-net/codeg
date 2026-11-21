/**
 * How a prompt reads in its detail: its text, its length, whose it is, and
 * what keeping it as a quick message makes of it. No React, and nothing here
 * trusts the catalog to be complete or current.
 */
import type {
  HarnessItemDetail,
  HarnessPromptInfo,
  HarnessShowcase,
} from "./types"

/**
 * The text a prompt's item carries, or `null` when it carries none — a
 * catalog that left `install.prompt` out, or sent it without its text. The
 * text is then asked for on its own (`harness_prompt`).
 */
export function promptTextOf(item: HarnessItemDetail): string | null {
  const text = item.install.prompt?.text
  return typeof text === "string" && text !== "" ? text : null
}

/** Scripts a model reads at about a token a character. */
const WIDE_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

/**
 * About how many tokens `text` comes to. There is no tokenizer here, so it is
 * a rule of thumb, and the interface says "about": Chinese, Japanese and
 * Korean at a token a character, everything else at four characters a token
 * — what Claude's tokenizer comes to on ordinary prose. Rounded to two
 * significant figures, so that it does not look more exact than it is.
 */
export function approximateTokens(text: string): number {
  let wide = 0
  let other = 0
  for (const char of text) {
    if (WIDE_SCRIPT.test(char)) wide += 1
    else other += 1
  }
  const tokens = wide + other / 4
  if (tokens <= 0) return 0
  return Math.max(1, Number(tokens.toPrecision(2)))
}

/** A prompt's length: its characters (as a person counts them, not as
 *  UTF-16 counts them), and about how many tokens they are. */
export interface PromptLength {
  chars: number
  tokens: number
}

export function promptLength(text: string): PromptLength {
  return { chars: Array.from(text).length, tokens: approximateTokens(text) }
}

/**
 * Whose a prompt is. `creators`: whoever shared it, credited by name; the
 * item's license does not cover it. `license`: the item's license does.
 * Anything a newer catalog says is `unknown`, and nothing is claimed.
 */
export type PromptRights = "creators" | "license" | "unknown"

export function promptRights(
  info: Pick<HarnessPromptInfo, "rights"> | null | undefined
): PromptRights {
  const rights = info?.rights
  if (rights === "creators") return "creators"
  if (rights === "license") return "license"
  return "unknown"
}

/** The result shared first, which a prompt held by its creators credits —
 *  the catalog lists them the first first. */
export function firstShowcase(
  info: Pick<HarnessPromptInfo, "showcases"> | null | undefined
): HarnessShowcase | null {
  return info?.showcases[0] ?? null
}

/**
 * How long a quick message's title may be. Quick messages are listed by their
 * title on one line (the composer's + menu, Settings), so a prompt's title —
 * often its first sentence — is cut to what such a line can show.
 */
export const QUICK_MESSAGE_TITLE_MAX = 80

/**
 * The most a quick message's content may weigh, in UTF-8 bytes. The quick
 * message table has no limit of its own, but a Codeg reached over the web
 * takes at most 2 MiB in one request, and JSON can double a text's newlines
 * and quotes. The catalog keeps prompts far below this (100 KB); it is here
 * for one that is not.
 */
export const QUICK_MESSAGE_MAX_BYTES = 1_000_000

export type QuickMessageDraft =
  | { ok: true; title: string; content: string }
  | { ok: false; reason: "empty" | "tooLong" }

/**
 * What "Save as quick message" saves: the item's title, on one line and cut
 * to {@link QUICK_MESSAGE_TITLE_MAX} characters, and the prompt's text as it
 * is — not trimmed, not rewritten, and with nothing recorded about where it
 * came from. A prompt with no text, or too much of it, is not saved.
 */
export function quickMessageDraft(
  title: string,
  text: string
): QuickMessageDraft {
  if (!text.trim()) return { ok: false, reason: "empty" }
  if (new TextEncoder().encode(text).length > QUICK_MESSAGE_MAX_BYTES) {
    return { ok: false, reason: "tooLong" }
  }
  const line = title.replace(/\s+/g, " ").trim()
  const chars = Array.from(line)
  const cut =
    chars.length > QUICK_MESSAGE_TITLE_MAX
      ? `${chars
          .slice(0, QUICK_MESSAGE_TITLE_MAX - 1)
          .join("")
          .trimEnd()}…`
      : line
  return { ok: true, title: cut, content: text }
}

/**
 * A language's name in the interface's language — `ja` is "Japanese" in an
 * English interface and 「日语」 in a Chinese one — or the code as the catalog
 * gave it when there is no name for it.
 */
export function languageName(code: string, locale: string): string {
  try {
    const name = new Intl.DisplayNames([locale], { type: "language" }).of(code)
    return name && name !== code ? name : code
  } catch {
    return code
  }
}
