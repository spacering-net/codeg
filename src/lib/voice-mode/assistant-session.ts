"use client"

import { useCallback, useMemo, useRef } from "react"

import { useAcpActions } from "@/contexts/acp-connections-context"
import { assistantEnsure } from "@/lib/api"
import type { AssistantSession, PromptInputBlock } from "@/lib/types"

const SURFACE = "voice-assistant"

export interface AssistantSessionHandle {
  ensure(): Promise<AssistantSession>
  send(text: string): Promise<void>
  release(): void
}

export function useAssistantSession(): AssistantSessionHandle {
  const {
    sendPrompt,
    attachDelegationChild,
    detachDelegationChild,
    registerLiveSurfaceKeys,
  } = useAcpActions()
  const sessionRef = useRef<AssistantSession | null>(null)
  const primerRef = useRef<string | null>(null)

  const release = useCallback(() => {
    const session = sessionRef.current
    if (!session) return
    sessionRef.current = null
    primerRef.current = null
    detachDelegationChild(session.connectionId)
    registerLiveSurfaceKeys(SURFACE, new Set())
  }, [detachDelegationChild, registerLiveSurfaceKeys])

  const ensure = useCallback(async () => {
    const session = await assistantEnsure()
    const previous = sessionRef.current
    if (previous && previous.connectionId !== session.connectionId) {
      detachDelegationChild(previous.connectionId)
    }
    sessionRef.current = session
    primerRef.current = session.primer
    attachDelegationChild({
      connectionId: session.connectionId,
      parentConnectionId: session.connectionId,
      parentToolUseId: SURFACE,
      agentType: session.agentType,
      hydrate: true,
    })
    registerLiveSurfaceKeys(SURFACE, new Set([session.connectionId]))
    return session
  }, [attachDelegationChild, detachDelegationChild, registerLiveSurfaceKeys])

  const send = useCallback(
    async (text: string) => {
      const session = sessionRef.current
      if (!session) throw new Error("assistant session is not ready")
      const blocks: PromptInputBlock[] = []
      if (primerRef.current) {
        blocks.push({ type: "text", text: primerRef.current })
        primerRef.current = null
      }
      blocks.push({ type: "text", text })
      await sendPrompt(session.connectionId, blocks, {
        folderId: session.folderId,
        conversationId: session.conversationId,
      })
    },
    [sendPrompt]
  )

  return useMemo(() => ({ ensure, send, release }), [ensure, send, release])
}
