/**
 * How catalog data is turned into what a card or a detail shows: which
 * language a text is taken in, what an unknown value falls back to, and which
 * addresses may be linked. No React, and nothing here trusts the catalog to
 * be complete or current.
 */
import type {
  HarnessItemSummary,
  HarnessKnownKind,
  HarnessKnownRisk,
  HarnessLocalized,
} from "./types"

/** The two languages the catalog writes display text in. */
export type HarnessLang = "en" | "zh"

/**
 * The catalog language for an interface locale: both Chinese locales read its
 * `zh`, every other locale its `en`.
 */
export function harnessLang(locale: string): HarnessLang {
  return locale.toLowerCase().startsWith("zh") ? "zh" : "en"
}

function present(text: unknown): string | undefined {
  return typeof text === "string" && text.trim() ? text : undefined
}

/** `text` in `lang`, else in the other language, else nothing. A blank string
 *  counts as missing. */
export function pickLocalized(
  text: HarnessLocalized | null | undefined,
  lang: HarnessLang
): string | undefined {
  if (!text) return undefined
  return present(text[lang]) ?? present(text[lang === "en" ? "zh" : "en"])
}

/** An item's title: in the reader's language, else the other one, else the
 *  name it is addressed by. */
export function itemTitle(
  item: Pick<HarnessItemSummary, "title" | "name">,
  lang: HarnessLang
): string {
  return pickLocalized(item.title, lang) ?? item.name
}

/**
 * The line under an item's title. Prompts and assistants often have no
 * summary of their own; what their cards carry instead — the prompt's first
 * line, the assistant's role — says the same thing.
 */
export function itemSummary(
  item: Pick<HarnessItemSummary, "summary" | "prompt" | "assistant">,
  lang: HarnessLang
): string | undefined {
  return (
    pickLocalized(item.summary, lang) ??
    present(item.prompt?.excerpt) ??
    present(item.assistant?.role)
  )
}

const KNOWN_KINDS: readonly HarnessKnownKind[] = [
  "skill",
  "mcp",
  "prompt",
  "assistant",
  "connector",
  "plugin",
]

/** `kind` if this build has a name for it, else `null` ("unknown"). */
export function knownKind(kind: unknown): HarnessKnownKind | null {
  return KNOWN_KINDS.find((known) => known === kind) ?? null
}

const KNOWN_RISKS: readonly HarnessKnownRisk[] = ["low", "medium", "high"]

export function knownRisk(risk: unknown): HarnessKnownRisk | null {
  return KNOWN_RISKS.find((known) => known === risk) ?? null
}

/** `value` if it is one of `known`, else `null`. For the small closed sets
 *  the catalog uses (a version's status, a package's check, a source). */
export function oneOf<const T extends string>(
  known: readonly T[],
  value: unknown
): T | null {
  return known.find((entry) => entry === value) ?? null
}

/**
 * `value` as an address that may be linked, or `null`.
 *
 * Third-party text names where a link goes, so only the one scheme a browser
 * can be handed safely is let through: `https:`. No `http:`, no `mailto:`,
 * nothing script-like; and no address with a user name or password in it,
 * which exists to make one host look like another.
 */
export function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  if (url.protocol !== "https:" || url.username || url.password) return null
  return url.href
}

/**
 * The SpaceRing origin the backend reported, if it is one a link can be built
 * on: `https:`, or plain `http:` to this machine — a development build may
 * point at a local copy of the website.
 */
export function harnessOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  if (url.username || url.password) return null
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]"
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    return null
  }
  return url.origin
}

/**
 * An item's page on the website: `/harness/<publisher>/<name>`, under `/zh`
 * for Chinese. Every kind lives at the same address there. `null` until the
 * backend has said which origin it talks to.
 */
export function harnessItemUrl(
  origin: string | null,
  ref: string,
  lang: HarnessLang
): string | null {
  if (!origin) return null
  const path = ref.split("/").map(encodeURIComponent).join("/")
  return `${origin}${lang === "zh" ? "/zh" : ""}/harness/${path}`
}

/** Where on GitHub a package's files are read from, when Harness may not
 *  keep a copy of them: the folder at the commit that was checked. */
export function githubTreeUrl(
  source:
    | { repository?: unknown; commit?: unknown; path?: unknown }
    | null
    | undefined
): string | null {
  if (!source) return null
  const { repository, commit, path } = source
  if (typeof repository !== "string" || typeof commit !== "string") return null
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[\w.-]+$/.test(commit)) {
    return null
  }
  const folder =
    typeof path === "string"
      ? path
          .split("/")
          .filter((part) => part && part !== "." && part !== "..")
          .map(encodeURIComponent)
          .join("/")
      : ""
  return `https://github.com/${repository}/tree/${commit}${folder ? `/${folder}` : ""}`
}

/** An address without the parts a reader does not need: the scheme, `www.`. */
export function shortUrl(href: string): string {
  return href.replace(/^https:\/\/(www\.)?/, "").replace(/\/$/, "")
}

/** A byte count, in the largest unit that keeps it readable. */
export function formatBytes(bytes: number, locale: string): string {
  const value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0
  const units = ["B", "KB", "MB", "GB"] as const
  let unit = 0
  let amount = value
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024
    unit += 1
  }
  const digits = unit === 0 || amount >= 100 ? 0 : 1
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(amount)} ${units[unit]}`
}

/** A count as a card shows it: `194.7K`. */
export function formatCompact(count: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(count)
}

/** A catalog timestamp as a date, or `null` when it is not one. */
export function formatDate(iso: unknown, locale: string): string | null {
  if (typeof iso !== "string" || !iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date)
}

/** The models prompts are written for, by name; other ids are read below. */
const MODEL_NAMES: ReadonlyMap<string, string> = new Map([
  ["claude-opus-5-5", "Claude Opus 5.5"],
  ["claude-sonnet-5-5", "Claude Sonnet 5.5"],
  ["claude-fable-5-1", "Claude Fable 5.1"],
  ["claude-haiku-4-5", "Claude Haiku 4.5"],
])

/** The aliases Claude Code takes for the latest model of a family — what an
 *  assistant's definition usually names. */
const MODEL_ALIASES: ReadonlyMap<string, string> = new Map([
  ["opus", "Claude Opus"],
  ["sonnet", "Claude Sonnet"],
  ["haiku", "Claude Haiku"],
  ["fable", "Claude Fable"],
])

/** Another Claude model's id, read: `claude-sonnet-4-20250514` is Claude
 *  Sonnet 4, `claude-3-5-haiku-20241022` Claude Haiku 3.5. */
function claudeModel(id: string): string | null {
  const match =
    /^claude-(?:(\d+)-(?:(\d)-)?)?(opus|sonnet|haiku|fable)(?:-(\d{1,2})(?:-(\d{1,2}))?)?(?:-\d{8})?$/i.exec(
      id
    )
  if (!match) return null
  const major = match[4] ?? match[1]
  const minor = match[4] ? match[5] : match[2]
  const family =
    match[3].charAt(0).toUpperCase() + match[3].slice(1).toLowerCase()
  return `Claude ${family}${major ? ` ${major}${minor ? `.${minor}` : ""}` : ""}`
}

/**
 * A model's name, from the id or the alias a prompt or an assistant gives —
 * the website reads them the same way. An id it cannot read is shown as it
 * is. `null` for none, and for `inherit` (an assistant that runs on whatever
 * model its session does), which the interface words itself.
 */
export function modelName(id: unknown): string | null {
  if (typeof id !== "string") return null
  const trimmed = id.trim()
  if (!trimmed || trimmed.toLowerCase() === "inherit") return null
  return (
    MODEL_NAMES.get(trimmed) ??
    MODEL_ALIASES.get(trimmed.toLowerCase()) ??
    claudeModel(trimmed) ??
    trimmed
  )
}

/**
 * Whether an item's runtime says anything. A prompt is text and an assistant
 * a definition: the catalog files both under "none", which on a card would be
 * a row of "No code" telling nobody anything.
 */
export function showsRuntime(item: { kind: string; runtime: string }): boolean {
  return (
    item.runtime !== "" && item.kind !== "prompt" && item.kind !== "assistant"
  )
}

/**
 * Runtimes whose names are the same in every language. The three that are
 * words rather than names (`remote`, `none`, `bundle`) are translated, under
 * `Harness.discover.runtimes`; anything else is shown as the catalog spells
 * it.
 */
export const RUNTIME_PROPER_NAMES: ReadonlyMap<string, string> = new Map([
  ["node", "Node.js"],
  ["python", "Python"],
  ["docker", "Docker"],
  ["shell", "Shell"],
  ["dotnet", ".NET"],
  ["rust", "Rust"],
])

export const TRANSLATED_RUNTIMES = ["remote", "none", "bundle"] as const
