import { extractAppCommandError, toErrorMessage } from "@/lib/app-error"
import { isUnsupportedCommandError } from "@/lib/harness/errors"

/**
 * Why a skills command was REJECTED. The engine's own commands report nearly
 * everything in their result; the older commands the page also uses (the
 * Custom skill authoring, an agent's own skills) throw instead, with a stable
 * code in `i18n_params.code`. What a rejection can be:
 *
 * - `unsupported` — the backend has no such command: an older Codeg at the
 *   other end of a remote workspace window or behind a browser. Updating that
 *   Codeg is the answer, not asking again.
 * - `coded` — the backend refused it and said why, with one of the engine's
 *   codes (`id_taken`, `store_link_read_only`, `lock_busy`, …).
 * - `invalidResponse` — an answer this build cannot read.
 * - `unknown` — anything else (the Codeg server out of reach, a timeout, a
 *   request the backend could not deserialize), shown with its own text.
 */
export type SkillsFailureKind =
  | "unsupported"
  | "coded"
  | "invalidResponse"
  | "unknown"

/** Plain data, so a failure can be kept in a slot and shown later. */
export interface SkillsFailure {
  kind: SkillsFailureKind
  /** `coded`: the backend's snake_case code. */
  code?: string
  /** Technical and untranslated: a path, an OS error, the backend's own
   *  English for a code this build does not know. Empty when there is none. */
  detail: string
  /** Codes whose `detail` names agents instead — who would see a new skill
   *  (`no_own_directory`), who loses a deleted one (`acknowledgement_required`,
   *  `effects_changed`): those agents, and `detail` is empty. */
  agents?: string[]
}

/** Codes thrown with the agents they concern, comma-separated, in
 *  `i18n_params.detail`. */
const AGENTS_IN_DETAIL = new Set([
  "no_own_directory",
  "acknowledgement_required",
  "effects_changed",
])

/** A failure raised on this side of the transport: an answer that is not the
 *  shape a command promises. */
export class SkillsClientError extends Error {
  readonly kind: SkillsFailureKind

  constructor(kind: SkillsFailureKind, message: string) {
    super(message)
    this.name = "SkillsClientError"
    this.kind = kind
  }
}

/** Sorts a rejected skills command into a {@link SkillsFailure}. Never
 *  throws. */
export function skillsFailureOf(error: unknown): SkillsFailure {
  if (error instanceof SkillsClientError)
    return { kind: error.kind, detail: "" }
  const appError = extractAppCommandError(error)
  const code = appError?.i18n_params?.code
  if (code) {
    const named = appError?.i18n_params?.detail
    if (AGENTS_IN_DETAIL.has(code) && named !== undefined) {
      const agents = named
        .split(",")
        .map((agent) => agent.trim())
        .filter(Boolean)
      return { kind: "coded", code, detail: "", agents }
    }
    return {
      kind: "coded",
      code,
      detail: named ?? appError?.detail ?? appError?.message ?? "",
    }
  }
  if (isUnsupportedCommandError(error))
    return { kind: "unsupported", detail: "" }
  return { kind: "unknown", detail: toErrorMessage(error) }
}
