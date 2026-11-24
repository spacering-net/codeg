"use client"

import { CircleAlert } from "lucide-react"
import { useTranslations } from "next-intl"

/**
 * A turn that FAILED, in the agent's own words ("stream disconnected before
 * completion: …", "API Error: 503 …"), as one muted line where the reply would
 * have been — never as a reply bubble, which would put the error in the
 * model's mouth. Live it is the failure the adapter reported; reopened, the
 * record the agent wrote of it.
 */
export function TurnErrorPart({ message }: { message: string }) {
  const t = useTranslations("Folder.chat.messageList")
  return (
    <div
      role="note"
      data-testid="turn-error"
      className="flex items-start gap-1.5 text-xs text-muted-foreground"
    >
      <CircleAlert className="mt-px size-3.5 shrink-0 text-destructive/70" />
      <p className="min-w-0 whitespace-pre-wrap wrap-break-word">
        {t("turnFailed", { message })}
      </p>
    </div>
  )
}
