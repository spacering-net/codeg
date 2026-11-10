"use client"

/**
 * The assistants page's way to open a session link in a reply
 * (`codeg://session/<id>`): what the conversation is codeg reads first —
 * its project and agent — then it opens as a conversation tab, where the
 * owner can answer what it waits on, as `useOpenInWorkbench` opens one.
 */

import { useCallback } from "react"
import { toast } from "sonner"

import type { SessionLinkOpener } from "@/components/ai-elements/session-link-opener"
import { useTabActions } from "@/contexts/tab-context"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import { personalAgentConversationTarget } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"

export function useSessionLinkOpener(): SessionLinkOpener {
  const { openConversations } = useWorkbenchRoute()
  const { openTab } = useTabActions()
  return useCallback(
    (conversationId: number) => {
      personalAgentConversationTarget(conversationId)
        .then((target) => {
          openConversations()
          openTab(
            target.folder_id,
            target.conversation_id,
            target.agent_type,
            false,
            target.title ?? undefined
          )
        })
        .catch((e) => toast.error(toErrorMessage(e)))
    },
    [openConversations, openTab]
  )
}
