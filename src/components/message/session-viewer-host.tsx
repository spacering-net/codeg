"use client"

/**
 * Owns the transcript's side-panel viewers — the "查看会话" drawers and the
 * file viewer — ABOVE the virtual list.
 *
 * The cards that offer those viewers — `DelegatedSubThread` for a
 * `delegate_to_agent` call, `AgentToolCallPart` for a grok `spawn_subagent` —
 * render inside `VirtualizedMessageThread`'s rows. They used to hold the
 * viewer's open state and render the drawer themselves, which meant scrolling
 * the card out of virtua's buffer unmounted the row and took the open drawer
 * down with it. Hoisting the state and the drawer to `MessageListView` (which
 * renders the virtualizer, not a row inside it) is what decouples the two.
 *
 * Nesting is unaffected: the viewer's own transcript renders another
 * `MessageListView`, which provides its own host, so a grandchild viewer still
 * mounts inside the parent drawer's React tree and Base UI still stacks it.
 *
 * ONE request slot, not one per kind. Two viewers open at the same level would
 * be same-width siblings with no stacking relationship between them — one
 * flatly covering the other, which reads as a glitch. Opening a second viewer
 * therefore replaces the first. That is also why the FILE viewer lives here
 * rather than in a host of its own: a file opened from a transcript is one
 * more thing this transcript is showing off to the side, and it has to stack
 * over (or replace) whatever else the transcript already put there.
 */

import * as React from "react"

import { BrowserViewerDrawer } from "@/components/browser/browser-viewer-drawer"
import { FileViewerDrawer } from "@/components/files/file-viewer-drawer"
import {
  SessionViewerHostContext,
  type SessionViewerHostValue,
  type SessionViewerRequest,
} from "@/components/message/session-viewer-host-context"
import { SubAgentSessionDialog } from "@/components/message/sub-agent-session-dialog"
import { SubagentSessionDialog } from "@/components/message/subagent-session-dialog"
import {
  useDelegationCardModel,
  type DelegationCardSource,
} from "@/hooks/use-delegation-card-model"

// The request shapes and `useSessionViewerHost` live in the leaf module beside
// this one; re-exported here so the cards that already import them from this
// path keep working.
export {
  useSessionViewerHost,
  type SessionViewerRequest,
} from "@/components/message/session-viewer-host-context"

export function SessionViewerHost({ children }: { children: React.ReactNode }) {
  const [request, setRequest] = React.useState<SessionViewerRequest | null>(
    null
  )
  const [open, setOpen] = React.useState(false)

  const value = React.useMemo<SessionViewerHostValue>(
    () => ({
      open: (next) => {
        setRequest(next)
        setOpen(true)
      },
    }),
    []
  )

  // Closing only lowers the flag; the request stays so the drawer has content
  // to draw through its exit transition. Harmless afterwards — both viewers
  // gate their body (and their fetches) on `open`.
  return (
    <SessionViewerHostContext.Provider value={value}>
      {children}
      {request?.kind === "delegation" && (
        <DelegationViewer
          // A different delegation is a different child conversation, and the
          // viewer's whole live bridge is keyed to that. Remount rather than
          // re-point.
          key={request.source.parentToolUseId}
          source={request.source}
          open={open}
          onOpenChange={setOpen}
        />
      )}
      {request?.kind === "agentSession" && (
        <SubagentSessionDialog
          key={request.sessionId}
          open={open}
          onOpenChange={setOpen}
          sessionId={request.sessionId}
          agentType={request.agentType}
          subagentType={request.subagentType}
          description={request.description}
          live={request.live}
        />
      )}
      {request?.kind === "file" && (
        <FileViewerDrawer
          request={request}
          open={open}
          onOpenChange={setOpen}
        />
      )}
      {request?.kind === "browser" && (
        <BrowserViewerDrawer
          key={`${request.remote ? "remote:" : ""}${request.url}`}
          url={request.url}
          remote={request.remote === true}
          open={open}
          onOpenChange={setOpen}
        />
      )}
    </SessionViewerHostContext.Provider>
  )
}

/**
 * Re-derives the delegation's live model here rather than taking the card's
 * word for it.
 *
 * `DelegationCardSource` is nothing but the tool call's own serializable
 * fields, and `useDelegationCardModel` turns those plus the live connection /
 * binding stores into the agent type, status and child ids. Running it here
 * means the viewer keeps tracking the child — a late binding, a reconnect that
 * moves `childConnectionId` — long after the card that opened it was scrolled
 * away and unmounted. A snapshot of the resolved ids would have frozen at
 * whatever was known at click time.
 */
function DelegationViewer({
  source,
  open,
  onOpenChange,
}: {
  source: DelegationCardSource
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { agentType, task, childConversationId, childConnectionId } =
    useDelegationCardModel(source)

  if (childConversationId == null) return null

  return (
    <SubAgentSessionDialog
      open={open}
      onOpenChange={onOpenChange}
      childConversationId={childConversationId}
      childConnectionId={childConnectionId}
      agentType={agentType}
      kickoffTask={task}
    />
  )
}
