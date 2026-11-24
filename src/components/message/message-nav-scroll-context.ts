"use client"

import { createContext } from "react"

/**
 * The element the message navigator scrolls in — the Session Details tab's
 * scroll area — once it exists. Given one, the navigator renders only the
 * rows in view of it (a conversation can run to hundreds of messages) and
 * offers a way back to the current message when it is out of view; without
 * one it renders every row.
 */
export const MessageNavScrollContext = createContext<HTMLElement | null>(null)
