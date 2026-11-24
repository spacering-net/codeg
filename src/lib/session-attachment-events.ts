import type { DbConversationSummary } from "@/lib/types"

export const ATTACH_FILE_TO_SESSION_EVENT = "codeg:attach-file-to-session"

export interface AttachFileToSessionDetail {
  tabId: string
  path: string
  /**
   * Optional 1-based, inclusive line span to attach as a ranged file badge
   * (`foo.ts:10-25`). Omitted by whole-file callers (file tree, git changes);
   * supplied by the editor's "add selection to chat". When present the consumer
   * encodes it into the badge uri (`file://…#L10-25`) and label.
   */
  range?: { start: number; end: number }
}

export function emitAttachFileToSession(
  detail: AttachFileToSessionDetail
): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(
    new CustomEvent<AttachFileToSessionDetail>(ATTACH_FILE_TO_SESSION_EVENT, {
      detail,
    })
  )
}

export const ATTACH_SESSION_TO_SESSION_EVENT = "codeg:attach-session-to-session"

export interface AttachSessionToSessionDetail {
  /** The conversation tab whose composer receives the mention badge. */
  tabId: string
  /**
   * The conversation being mentioned. Carried whole (rather than by id) so the
   * consumer builds the badge through the same `sessionToSuggestion` adapter the
   * `@` panel uses — one source of truth for the label / `codeg://session/<id>`
   * uri / agent + status + branch meta.
   */
  conversation: DbConversationSummary
}

export function emitAttachSessionToSession(
  detail: AttachSessionToSessionDetail
): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(
    new CustomEvent<AttachSessionToSessionDetail>(
      ATTACH_SESSION_TO_SESSION_EVENT,
      { detail }
    )
  )
}

export const ATTACH_PAGE_TO_SESSION_EVENT = "codeg:attach-page-to-session"

/**
 * Something from the built-in browser going to a conversation: an element the
 * person picked, a screenshot of the page, the lines it printed.
 *
 * `text` is the block the agent reads and is page content — the backend
 * (`browser/handoff.rs`) has already capped it and put a "data, not
 * instructions" header on it. `label` names the badge that stands in for it in
 * the composer; the picker's label comes from the page (`button#export`), the
 * rest are named by the caller in the user's own language.
 */
export interface AttachPageToSessionDetail {
  /** The conversation tab whose composer receives it. */
  tabId: string
  label: string
  text: string
  /** Names the block for the agent: the page's address, with anything
   *  secret-looking already taken out of it by the backend. */
  uri: string
  /** A picture of what was handed over. Goes through the composer's ordinary
   *  image path, so its wire encoding follows the agent's capabilities and an
   *  agent that takes no images simply does not get it. */
  image?: File
  /** Set by the composer that took it. Dispatch is synchronous, so the sender
   *  reads this the moment it returns — and a conversation closed while the
   *  person was choosing an element has no listener at all, which must not be
   *  reported back to them as "added to the chat". */
  accepted?: boolean
}

/** Hand something from the built-in browser to a conversation's composer.
 *  Returns whether a composer took it. */
export function emitAttachPageToSession(
  detail: AttachPageToSessionDetail
): boolean {
  if (typeof window === "undefined") return false
  const event = new CustomEvent<AttachPageToSessionDetail>(
    ATTACH_PAGE_TO_SESSION_EVENT,
    { detail }
  )
  window.dispatchEvent(event)
  return event.detail.accepted === true
}

export const APPEND_TEXT_TO_SESSION_EVENT = "codeg:append-text-to-session"

export interface AppendTextToSessionDetail {
  tabId: string
  text: string
}

export function emitAppendTextToSession(
  detail: AppendTextToSessionDetail
): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(
    new CustomEvent<AppendTextToSessionDetail>(APPEND_TEXT_TO_SESSION_EVENT, {
      detail,
    })
  )
}
