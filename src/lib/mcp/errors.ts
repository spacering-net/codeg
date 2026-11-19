import { toErrorMessage } from "@/lib/app-error"
import { isUnsupportedCommandError } from "@/lib/harness/errors"

/**
 * Why an MCP command was REJECTED — which is rare: the engine reports nearly
 * everything in its result (a busy lock, a file changed elsewhere, a write
 * that failed). What is left:
 *
 * - `unsupported` — the backend has no such command: an older Codeg at the
 *   other end of a remote workspace window or behind a browser. Asking again
 *   cannot help; updating that Codeg does.
 * - `invalidResponse` — an answer this build cannot read.
 * - `unknown` — anything else (the Codeg server out of reach, a timeout, a
 *   request the backend refused to deserialize), shown with its own text.
 */
export type McpFailureKind = "unsupported" | "invalidResponse" | "unknown"

/** Plain data, so a failure can be kept in a slot and shown later. */
export interface McpFailure {
  kind: McpFailureKind
  /** `unknown`: the failure's own text, untranslated. Empty otherwise. */
  detail: string
}

/** A failure raised on this side of the transport — an answer that is not
 *  the shape a command promises. */
export class McpClientError extends Error {
  readonly kind: McpFailureKind

  constructor(kind: McpFailureKind, message: string) {
    super(message)
    this.name = "McpClientError"
    this.kind = kind
  }
}

/** Sorts a rejected MCP command into a {@link McpFailure}. Never throws. */
export function mcpFailureOf(error: unknown): McpFailure {
  if (error instanceof McpClientError) return { kind: error.kind, detail: "" }
  if (isUnsupportedCommandError(error)) {
    return { kind: "unsupported", detail: "" }
  }
  return { kind: "unknown", detail: toErrorMessage(error) }
}
