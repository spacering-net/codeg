"use client"

import { useCallback } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { detachAskConversation } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { notify } from "@/lib/notify"

/**
 * "Convert to a normal conversation": unlink an ask conversation from its main
 * one. The backend broadcasts the row without its `parent_id`, which is what
 * moves it — every sidebar lifts it to a root row, every ask list drops it —
 * so this only reports the outcome.
 */
export function useDetachAskConversation(): (conversationId: number) => void {
  const t = useTranslations("Folder.askConversations")
  return useCallback(
    (conversationId: number) => {
      detachAskConversation(conversationId)
        .then(() => {
          toast.success(t("converted"))
        })
        .catch((error: unknown) => {
          notify({
            level: "error",
            key: `ask-detach:${conversationId}`,
            title: t("convertFailed"),
            description: toErrorMessage(error),
          })
        })
    },
    [t]
  )
}
