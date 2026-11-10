"use client"

import { useCallback } from "react"

import {
  useAcpEvent,
  useConnectionStore,
} from "@/contexts/acp-connections-context"
import {
  isOutOfTurnContentEvent,
  isUnrenderedAgentTurnContent,
} from "@/lib/background-agent"
import type { EventEnvelope } from "@/lib/types"
import { useConversationRuntimeActions } from "@/stores/conversation-runtime-store"

/**
 * Raise the "load background activity" notice on a conversation when its
 * agent runs a turn codeg never started.
 *
 * CodeBuddy drains a finished background task by prompting itself and streams
 * a whole turn for it; Codex continues an active goal on its own.
 * `applyStreamingAction`'s out-of-turn guard drops that content because the
 * `background_activity` overlay is supposed to own it — but that overlay only
 * has a producer for Claude Code, so for every other agent the turn renders
 * nowhere and the session looks frozen until it is reopened. The content IS on
 * disk and the agent's own parser already reads it correctly, so flag the
 * session and let the timeline offer a re-read.
 *
 * `contextKey` is the connection's key in the store, `connectionId` the
 * connection it holds now, and `conversationId` the runtime session to flag.
 *
 * This runs per streamed token, so every step is O(1) and ordered cheapest
 * first; the runtime store also early-returns once the flag is set.
 */
export function useOutOfTurnContentNotice(
  contextKey: string,
  connectionId: string | null,
  conversationId: number
): void {
  // A stable handle, for an event-time read that must not go through an
  // effect-refreshed ref (see below).
  const connectionStore = useConnectionStore()
  const { markOutOfTurnContent } = useConversationRuntimeActions()
  useAcpEvent(
    useCallback(
      (envelope: EventEnvelope) => {
        if (!isOutOfTurnContentEvent(envelope)) return
        if (envelope.connection_id !== connectionId) return
        // The same condition the guard drops on, read from the SAME place the
        // guard read it. Not a status mirrored into a ref by an effect: that
        // still says "connected" for any envelope that lands between the
        // StatusChanged(prompting) dispatch and React committing — which is
        // exactly the burst at the start of every turn, and would arm the
        // notice on turns we started ourselves. `getConnection` reads the store
        // the reducer just wrote, and subscribers fire after that write. Nor
        // before the connection's first turn: that is start-up output, and in
        // a new conversation it would raise the notice behind the welcome
        // screen, to show the moment the first message is sent.
        if (
          !isUnrenderedAgentTurnContent(
            connectionStore.getConnection(contextKey)
          )
        ) {
          return
        }
        markOutOfTurnContent(conversationId)
      },
      [
        connectionId,
        connectionStore,
        contextKey,
        conversationId,
        markOutOfTurnContent,
      ]
    )
  )
}
