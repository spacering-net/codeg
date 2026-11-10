import type { AgentType } from "@/lib/types"

/** The kinds of inline reference the composer can embed. */
export type ReferenceKind =
  | "file"
  | "agent"
  | "assistant"
  | "session"
  | "commit"
  | "skill"

export const REFERENCE_KINDS: readonly ReferenceKind[] = [
  "file",
  "agent",
  "assistant",
  "session",
  "commit",
  "skill",
]

/**
 * Type-specific render hints carried alongside a reference. All fields are
 * optional — the badge reads only what its `refType` needs. Serialization is
 * `meta`-independent for every kind EXCEPT `skill` (commands / skills / experts),
 * which reads {@link ReferenceMeta.invocationPrefix} to emit `/id` vs `$id`.
 */
export interface ReferenceMeta {
  /** file: whether the entry is a directory. */
  fileKind?: "file" | "dir"
  /**
   * agent: drives the badge icon. session: the owning agent — used only for the
   * `@`-panel option-row icon; the inline session badge shows a neutral
   * conversation glyph regardless.
   */
  agentType?: AgentType
  /** agent: whether the agent is currently available. */
  available?: boolean
  /**
   * assistant: the assistant's id (also the reference `id`, as a string). Its
   * avatar is looked up by it in the assistants store rather than carried
   * here: meta is written into drafts and `data-meta`, and a later avatar
   * change should reach every badge.
   */
  assistantId?: number
  /** session: conversation status snapshot (not rendered — the inline badge has no status dot). */
  status?: string
  /** session: git branch snapshot (carried with the reference; not rendered on the badge). */
  branch?: string | null
  /** commit: short hash for display. */
  shortHash?: string
  /** commit: first line of the commit message. */
  message?: string
  /** commit: author name. */
  author?: string
  /** commit: whether the commit is pushed upstream. */
  pushed?: boolean | null
  /**
   * skill: "global" | "project" | "expert" scope. "expert" is read by the
   * editor's expert-replace logic (not the badge — all skills share one icon).
   */
  scope?: string
  /** skill: category grouping. */
  category?: string
  /** skill: lucide icon name. */
  icon?: string | null
  /**
   * skill: the invocation prefix the agent expects (`/` for commands and most
   * skills, `$` for Codex skills/experts). Read by `referenceToMarkdown` to
   * serialize the badge back to its literal `${prefix}${id}` token; defaults to
   * `/` when absent.
   */
  invocationPrefix?: "/" | "$"
}

/**
 * The attribute payload stored on a `reference` ProseMirror node. Mirrors the
 * data the `@` panel collects per source and the badge renders.
 */
export interface ReferenceAttrs {
  refType: ReferenceKind
  /**
   * Stable identity: file relative path / agent_type / assistant id / session
   * id / commit full hash / skill id.
   */
  id: string
  /** Human-readable display label. */
  label: string
  /**
   * Serialization URI (`file://…` / `codeg://…`) used when sending, or null for
   * agents and skills which serialize to plain text.
   */
  uri: string | null
  /** Type-specific render hints; see {@link ReferenceMeta}. */
  meta: ReferenceMeta | null
}
