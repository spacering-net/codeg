/**
 * Recognizing the backend's "an edited message's rewind was declined" prompt
 * rejection across transports.
 *
 * An edited message is sent as a prompt carrying a `rewind` target: the
 * backend cuts the agent's session back to just before the message it
 * replaces and admits the prompt in the same step. When the agent declines
 * the cut, nothing changed and nothing was sent; `AcpError::RewindRefused`
 * serializes to its Display string on Tauri and becomes
 * `AppCommandError.message` on the web path, so — as with
 * `conversation-moved.ts` — it is recognized by a backend-controlled marker,
 * and the agent's reason is read back out of that same string.
 */

const REWIND_REFUSED_PATTERN = /edited message refused: ([A-Za-z_]+)/

/** Thrown by `acpPrompt` when the agent declined an edited message's rewind.
 *  `reason` is the agent's word for why (`busy`, `beforeCompaction`, …) or
 *  codeg's `unavailable`. */
export class RewindRefusedError extends Error {
  constructor(readonly reason: string) {
    super(`edited message refused: ${reason}`)
    this.name = "RewindRefusedError"
  }
}

function rejectionMessage(err: unknown): string | null {
  if (typeof err === "string") return err
  if (err && typeof err === "object") {
    const message = (err as { message?: unknown }).message
    if (typeof message === "string") return message
  }
  return null
}

/** The `RewindRefusedError` `err` stands for, or null for any other failure. */
export function asRewindRefusedError(err: unknown): RewindRefusedError | null {
  if (err instanceof RewindRefusedError) return err
  const message = rejectionMessage(err)
  const match = message == null ? null : REWIND_REFUSED_PATTERN.exec(message)
  return match ? new RewindRefusedError(match[1]) : null
}
