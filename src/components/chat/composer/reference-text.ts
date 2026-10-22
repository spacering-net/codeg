import type { ReferenceAttrs } from "./types"

/** Collapse newline runs to a single space so a reference stays one inline token. */
function collapseNewlines(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " ")
}

/**
 * Escape text emitted as raw inline Markdown (Tiptap inserts a custom
 * `renderMarkdown` result verbatim). Backslash-escapes every inline-significant
 * ASCII punctuation char so a crafted label cannot inject Markdown structure
 * (links `[]()`, autolinks `<>`, code spans `` ` ``, emphasis `* _`,
 * strikethrough `~`, or escapes `\`).
 */
function escapeMarkdownText(text: string): string {
  return text.replace(/[\\`*_~[\]()<>]/g, "\\$&")
}

// GFM extended autolinks fire on bare URLs / `www.` / emails even when the
// structural punctuation above is escaped, so backslash-escaping is not enough
// for free-standing text (it is enough inside `[...]` link text, where GFM does
// not nest links). Detect those triggers and render such text as a code span,
// which never autolinks and reproduces the text literally.
const AUTOLINK_TRIGGER = /(?:https?|ftp|mailto):|www\.|@/i

// Slug shape of a real command / skill / expert id: alphanumeric ends with
// interior `._-/:` separators only, `:` for a namespaced command such as
// Qoder's `sites:sites-building`. See {@link isLiteralInvocationToken}.
const SAFE_INVOCATION_TOKEN = /^[A-Za-z0-9](?:[A-Za-z0-9._/:-]*[A-Za-z0-9])?$/

/**
 * Whether `token` can be emitted raw after a `/` / `$` prefix without any
 * Markdown breaking out — i.e. it is a genuine invocation slug the agent runs
 * verbatim (escaping it would defeat invocation). Beyond the slug shape it
 * rejects: GFM autolink triggers (`www.` / `http:` / `@`), and any `_` that is
 * not strictly intraword — a `_` touching a separator (e.g. `a/_b_/c`) flanks
 * into CommonMark emphasis (`/a/<em>b</em>/c`). Such ids — and anything else,
 * e.g. a maliciously-named skill folder `![x](http://evil)` (ids come from the
 * filesystem) — fall through to the safe (escaped / code-spanned) inline-text
 * path. Real ids (`code-review`, `claude_code`, `scope/my.skill_v2`) pass.
 */
function isLiteralInvocationToken(token: string): boolean {
  return (
    SAFE_INVOCATION_TOKEN.test(token) &&
    !AUTOLINK_TRIGGER.test(token) &&
    !/[^A-Za-z0-9]_|_[^A-Za-z0-9]/.test(token)
  )
}

/** Wrap text in a Markdown code span with a fence long enough to be literal. */
function toInlineCode(text: string): string {
  const runs = text.match(/`+/g)
  const longest = runs ? Math.max(...runs.map((run) => run.length)) : 0
  const fence = "`".repeat(longest + 1)
  // Per CommonMark, a code span beginning/ending with a backtick or space needs
  // a padding space (which the renderer strips back off).
  const pad = /^[`\s]|[`\s]$/.test(text) ? " " : ""
  return `${fence}${pad}${text}${pad}${fence}`
}

/**
 * Render free-standing inline text (agent label, no-URI fallback) safely:
 * code-span it when it could trigger a GFM autolink, otherwise escape the
 * inline-significant punctuation. Normal labels are unaffected.
 */
function inlineText(text: string): string {
  const flat = collapseNewlines(text)
  return AUTOLINK_TRIGGER.test(flat)
    ? toInlineCode(flat)
    : escapeMarkdownText(flat)
}

/**
 * Render a Markdown link destination safely. URIs containing spaces,
 * parentheses, angle brackets or backslashes (e.g. `file:///a/b (1).ts` or a
 * Windows `file:///C:\dir\`) are wrapped in `<…>` so a `)` or trailing `\`
 * can't terminate / escape the link early. Inside `<…>` CommonMark still
 * interprets backslash escapes, so `\`, `<` and `>` are all escaped; newlines
 * are stripped. Clean URLs stay bare.
 */
function escapeLinkDestination(uri: string): string {
  const cleaned = uri.replace(/[\r\n]+/g, "")
  return /[\s()<>\\]/.test(cleaned)
    ? `<${cleaned.replace(/[\\<>]/g, "\\$&")}>`
    : cleaned
}

/**
 * Canonical inline token for a reference — the wire format on send. Used by the
 * composer's plain-text send serialization (`to-prompt-blocks.composerLeafText`)
 * and the node's `renderText`/`renderHTML`, and inverted by the transcript
 * renderer (`message/user-message-segments.ts`) back into a badge.
 *
 * References with a URI render as a Markdown link `[label](uri)` — matching how
 * the backend's `user_blocks_from_prompt` already folds ResourceLinks into
 * `[name](uri)`. Agents render as `[@label](codeg://agent/…)` when they carry a
 * routing uri, or as plain `@label` otherwise; assistants the same way, as
 * `[@label](codeg://assistant/<id>)`. Skills render as the `/id`
 * invocation token (the stable id, never the possibly-localized display label).
 * Every interpolated label/uri is escaped — and free-standing URL/email-like
 * text is code-spanned — so a crafted reference cannot inject Markdown
 * structure (a second link, an autolink, an image, emphasis, …) into the prompt.
 */
export function referenceToMarkdown(attrs: ReferenceAttrs): string {
  switch (attrs.refType) {
    case "agent":
    case "assistant": {
      // With a routing uri → `[@label](uri)` (the `@` lives inside the link
      // text, where GFM cannot autolink it). Without one → plain `@label`, with
      // the `@` kept OUTSIDE inlineText so a URL-like label is still code-spanned
      // rather than the whole `@…` string being treated as autolink-triggering.
      // An assistant's `codeg://assistant/<id>` link is what the backend reads
      // its routing from (`agent_mentions.rs`), exactly as for an agent.
      const text = collapseNewlines(attrs.label || attrs.id)
      return attrs.uri
        ? `[@${escapeMarkdownText(text)}](${escapeLinkDestination(attrs.uri)})`
        : `@${inlineText(attrs.label || attrs.id)}`
    }
    case "skill": {
      // Invocation token: the stable id is what the agent executes, prefixed by
      // the trigger it was created from (`/` commands & most skills, `$` Codex
      // skills/experts — read from meta, default `/`). The label (possibly
      // localized / containing spaces) is never used; an empty id is neutralized
      // to nothing rather than emitting a broken `/command`.
      const token = collapseNewlines(attrs.id).trim()
      if (!token) return ""
      const prefix = attrs.meta?.invocationPrefix === "$" ? "$" : "/"
      return isLiteralInvocationToken(token)
        ? `${prefix}${token}`
        : inlineText(`${prefix}${token}`)
    }
    case "file":
    case "session":
    case "commit": {
      const text = collapseNewlines(attrs.label || attrs.id)
      return attrs.uri
        ? `[${escapeMarkdownText(text)}](${escapeLinkDestination(attrs.uri)})`
        : inlineText(text)
    }
    default:
      return inlineText(attrs.label || attrs.id)
  }
}
