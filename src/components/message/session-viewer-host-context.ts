"use client"

/**
 * The transcript viewer host's CONTRACT, split out from the provider that
 * implements it (`session-viewer-host.tsx`).
 *
 * The provider has to import every viewer it can render, and those viewers
 * render transcripts of their own — so the provider's module graph loops back
 * through the whole message renderer. Consumers that only need to ASK for a
 * viewer (a tool card, the file-link opener) import this leaf instead and stay
 * out of that loop.
 */

import { createContext, useContext } from "react"

import type { DelegationCardSource } from "@/hooks/use-delegation-card-model"
import type { AgentType } from "@/lib/types"

/** A sub-agent delegated with `delegate_to_agent`, viewed through its child
 *  conversation. Carries the card's raw SOURCE rather than the resolved ids —
 *  see `DelegationViewer` in the provider module. */
export interface DelegationRequest {
  kind: "delegation"
  source: DelegationCardSource
}

/** A sub-agent that ran as a standalone session of its own (grok
 *  `spawn_subagent`), viewed by re-reading its transcript from disk. */
export interface AgentSessionRequest {
  kind: "agentSession"
  sessionId: string
  agentType: AgentType
  subagentType?: string | null
  description?: string | null
  /**
   * Whether to keep re-reading the child's transcript.
   *
   * A SNAPSHOT, taken when the card opened the viewer, and knowingly so: it is
   * derived from the tool call's state inside the card, and the card is
   * exactly what this host exists to stop depending on. The cost of it going
   * stale is bounded and one-directional — a child that finishes after the
   * card scrolls away keeps being re-read every couple of seconds until the
   * user closes the drawer, which is a no-op parse of a file that stopped
   * changing. The delegation branch has no equivalent problem.
   */
  live: boolean
}

/** A file referenced in the transcript: a path exactly as it appeared in the
 *  message (absolute, `~/`, or folder-relative) plus an optional line. */
export interface FileViewerRequest {
  path: string
  line: number | null
  /** Resolution base for a folder-relative path — mirrors `openFilePreview`'s
   *  option of the same name. */
  folderId?: number
  /**
   * A ready-made unified diff to show INSTEAD of the file's current bytes.
   *
   * The reply's "view diff" action already holds the patch text (the agent
   * reported it), so this branch reads nothing from disk and mirrors no file
   * tab — `path` is only a label and the "open in workspace" hand-off creates
   * the session diff tab rather than activating an existing one.
   */
  diff?: { content: string; groupLabel: string }
}

export interface FileRequest extends FileViewerRequest {
  kind: "file"
}

/** An http(s) page opened from the transcript while the file column is
 *  covered by a full-page route: shown in the built-in browser, inside the
 *  transcript's side panel. */
export interface BrowserRequest {
  kind: "browser"
  url: string
  /** An address on the remote codeg host (`BrowserTabSeed.remote`). */
  remote?: boolean
}

export type SessionViewerRequest =
  | DelegationRequest
  | AgentSessionRequest
  | FileRequest
  | BrowserRequest

export interface SessionViewerHostValue {
  open: (request: SessionViewerRequest) => void
}

export const SessionViewerHostContext =
  createContext<SessionViewerHostValue | null>(null)

/**
 * The host for the current transcript, or `null` when there is none.
 *
 * Null is a supported answer, not a failure: `ContentPartsRenderer` also
 * renders outside any `MessageListView` (the grok child transcript in
 * `subagent-session-dialog.tsx` renders parts directly), and those surfaces
 * are not virtualized, so a card there can keep owning its own viewer.
 */
export function useSessionViewerHost(): SessionViewerHostValue | null {
  return useContext(SessionViewerHostContext)
}
