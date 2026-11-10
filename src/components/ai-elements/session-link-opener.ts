import { createContext } from "react"

/**
 * Opens the conversation a `codeg://session/<id>` link in a message names.
 *
 * Optional: where a page provides one (the assistants page, whose replies
 * link the sessions they talk about), a session link renders as a button
 * that calls it; everywhere else the link stays the inert badge it is.
 */
export type SessionLinkOpener = (conversationId: number) => void

export const SessionLinkOpenerContext = createContext<SessionLinkOpener | null>(
  null
)
