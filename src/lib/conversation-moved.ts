/**
 * Recognizing the backend's "this conversation was moved to another folder"
 * prompt rejection across transports.
 *
 * A conversation the user moved to another project refuses prompts on a
 * connection that was started in the folder it left (another window still
 * showing it there, say): the turn would otherwise run in the old directory.
 * `AcpError::ConversationMoved` serializes to its Display string on Tauri and
 * becomes `AppCommandError.message` on the web path, so — as with
 * `turn-busy.ts` — it is recognized by a backend-controlled marker, and the
 * folder it moved to is read back out of that same string.
 */

/** Substring of the backend Display string
 *  `conversation moved to another folder (folder <id>)`. */
const CONVERSATION_MOVED_MARKER = "conversation moved to another folder"
const FOLDER_ID_PATTERN =
  /conversation moved to another folder \(folder (\d+)\)/

/** Thrown by `acpPrompt` when the backend refused the send because the
 *  conversation now lives in another folder. `folderId` is that folder, when
 *  the message named it. */
export class ConversationMovedError extends Error {
  constructor(readonly folderId: number | null) {
    super(CONVERSATION_MOVED_MARKER)
    this.name = "ConversationMovedError"
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

/** The `ConversationMovedError` `err` stands for, or null when it is some other
 *  failure. */
export function asConversationMovedError(
  err: unknown
): ConversationMovedError | null {
  if (err instanceof ConversationMovedError) return err
  const message = rejectionMessage(err)
  if (message == null || !message.includes(CONVERSATION_MOVED_MARKER)) {
    return null
  }
  const match = FOLDER_ID_PATTERN.exec(message)
  return new ConversationMovedError(match ? Number(match[1]) : null)
}
