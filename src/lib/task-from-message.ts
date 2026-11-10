/**
 * "Create a task from this message": the request a message's action makes,
 * held here for the one host that draws the task editor over the page
 * (`TaskFromMessageHost`, mounted in the workspace). Kept apart from the host
 * so a transcript that offers the action need not load the editor to do so.
 *
 * A store rather than an event: the host reads the open request on every
 * render, so it is never a matter of who was listening when it was sent.
 */

export interface TaskFromMessageRequest {
  /** The message's text: the task's description, its first line the title. */
  text: string
  /** The conversation's project folder, or null when it has none (a chat-mode
   *  conversation) — the editor then starts on a project of its own choosing. */
  folderId: number | null
}

export interface OpenTaskFromMessage extends TaskFromMessageRequest {
  id: number
}

let current: OpenTaskFromMessage | null = null
let lastId = 0
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of [...listeners]) listener()
}

export function subscribeTaskFromMessage(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The open request, or null while the editor is closed. */
export function currentTaskFromMessage(): OpenTaskFromMessage | null {
  return current
}

/**
 * Open the task editor on a message. Ignored while it is already open: it is
 * modal, so a second request can only come from code, and replacing the editor
 * would throw away a task half written.
 */
export function openTaskFromMessage(request: TaskFromMessageRequest): void {
  if (current) return
  lastId += 1
  current = { ...request, id: lastId }
  notify()
}

/** Named by id, so a close from an editor already gone is a no-op. */
export function closeTaskFromMessage(id: number): void {
  if (current?.id !== id) return
  current = null
  notify()
}

export function resetTaskFromMessageForTests(): void {
  current = null
  notify()
}
