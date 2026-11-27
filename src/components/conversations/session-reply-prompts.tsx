"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { ArrowUpRight } from "lucide-react"

import { useTabActions } from "@/contexts/tab-context"
import {
  acpPendingSessionReplyPrompts,
  type SessionReplyPrompt,
} from "@/lib/api"
import { onTransportReconnect, subscribe } from "@/lib/platform"

const PROMPTS_CHANGED = "session-reply-prompts://changed"

export function SessionReplyPrompts({
  conversationId,
}: {
  conversationId: number
}) {
  const t = useTranslations("Folder.sidebar.statusAwaiting")
  const { openTab } = useTabActions()
  const [prompts, setPrompts] = useState<SessionReplyPrompt[]>([])

  useEffect(() => {
    let disposed = false
    let version = 0
    const refresh = async () => {
      const request = ++version
      try {
        const pending = await acpPendingSessionReplyPrompts(conversationId)
        if (!disposed && request === version) setPrompts(pending)
      } catch {
        // Reconnection reloads the live prompts from the server.
      }
    }
    const subscription = subscribe<number>(PROMPTS_CHANGED, () => {
      void refresh()
    })
    void subscription.then(
      () => {
        if (!disposed) void refresh()
      },
      () => {
        if (!disposed) void refresh()
      }
    )
    const disconnectReconnect = onTransportReconnect(() => void refresh())
    return () => {
      disposed = true
      void subscription.then(
        (off) => off(),
        () => {}
      )
      disconnectReconnect?.()
    }
  }, [conversationId])

  if (prompts.length === 0) return null

  return (
    <ul
      className="mx-auto w-full max-w-(--chat-content-width) space-y-1 px-4"
      aria-live="polite"
    >
      {prompts.map((prompt) => (
        <li key={prompt.conversation_id + ":" + prompt.request_id}>
          <button
            type="button"
            className="flex w-full min-w-0 items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-start text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() =>
              openTab(
                prompt.folder_id,
                prompt.conversation_id,
                prompt.agent_type,
                true,
                prompt.title ?? undefined
              )
            }
          >
            <span className="truncate font-medium">
              {prompt.title?.trim() || "#" + prompt.conversation_id}
            </span>
            <span className="shrink-0 text-muted-foreground">
              {t(prompt.kind === "plan_approval" ? "plan" : prompt.kind)}
            </span>
            <ArrowUpRight className="ml-auto size-4 shrink-0" aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  )
}
