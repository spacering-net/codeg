"use client"

import { useTranslations } from "next-intl"
import { getAgentLabel } from "@/lib/custom-agents"
import { AgentIcon } from "@/components/agent-icon"
import { closePetPanel, focusConversation } from "@/lib/pet/api"
import type { PetSessionEntry } from "@/lib/pet/types"
import {
  sessionStatusKind,
  type PetSessionStatusKind,
} from "@/lib/pet/session-display"
import { cn } from "@/lib/utils"
import { formatConversationTitle } from "@/lib/conversation-title"
import { PanelPermissionCard } from "./PanelPermissionCard"

interface SessionRowProps {
  session: PetSessionEntry
}

const STATUS_DOT: Record<PetSessionStatusKind, string> = {
  waiting: "bg-amber-500",
  error: "bg-red-500",
  running: "bg-blue-500",
}

export function SessionRow({ session }: SessionRowProps) {
  const t = useTranslations("Pet")
  const kind = sessionStatusKind(session)
  const parent = session.parent

  const jump = () => {
    // A delegation sub-agent is never openable as a tab, so its row navigates
    // to the conversation that delegated it. (Answering the permission doesn't
    // need this at all — the card below posts straight to the CHILD connection.)
    const target = parent ?? session
    void focusConversation(
      target.folderId,
      target.conversationId,
      target.agentType
    )
      .then(() => closePetPanel())
      .catch((err) =>
        console.warn("[PetPanel] focus conversation failed:", err)
      )
  }

  const statusLabel =
    kind === "waiting"
      ? t("panel.statusWaiting")
      : kind === "error"
        ? t("panel.statusError")
        : t("panel.statusRunning")

  return (
    <div className="px-2 py-1.5">
      <button
        type="button"
        onClick={jump}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left",
          "transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
        )}
      >
        <AgentIcon agentType={session.agentType} className="h-4 w-4 shrink-0" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm">
            {formatConversationTitle(session.title) ||
              getAgentLabel(session.agentType)}
          </span>
          {parent ? (
            <span className="truncate text-2xs text-muted-foreground">
              {t("panel.subAgentOf")} ·{" "}
              {formatConversationTitle(parent.title) ||
                getAgentLabel(parent.agentType)}
            </span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-1 text-2xs text-muted-foreground">
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              STATUS_DOT[kind],
              kind === "running" && "animate-pulse"
            )}
            aria-hidden
          />
          {statusLabel}
        </span>
      </button>

      {session.pending ? (
        <PanelPermissionCard
          connectionId={session.connectionId}
          permission={session.pending}
          agentType={session.agentType}
        />
      ) : null}
    </div>
  )
}
