"use client"

import { useEffect, useMemo, useState } from "react"
import { History } from "lucide-react"
import { useTranslations } from "next-intl"
import { useTabActions, useTabStore } from "@/contexts/tab-context"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import {
  isConversationDeleted,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"
import { useFolderTabsStore } from "@/stores/folder-tabs-store"
import { formatConversationTitle } from "@/lib/conversation-title"
import { getAgentLabel } from "@/lib/custom-agents"
import { STATUS_ORDER, type DbConversationSummary } from "@/lib/types"
import { AgentIcon } from "@/components/agent-icon"
import { ConversationStatusDot } from "@/components/conversations/conversation-status-dot"
import {
  compareByUpdatedAtDesc,
  formatRelative,
} from "@/components/conversations/sidebar-conversation-grouping"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { STRIP_ICON_BTN } from "./strip-icon-button"

/** History is the existing folder summaries minus open tabs, not a close log. */
export function ConversationHistoryMenu() {
  const t = useTranslations("Folder.conversationCard")
  const tCommon = useTranslations("Folder.common")
  const tStatus = useTranslations("Folder.statusLabels")
  const enabled = useFolderTabsStore((s) => s.enabled)
  const scope = useFolderTabsStore((s) => s.scope)
  const conversations = useAppWorkspaceStore((s) => s.conversations)
  const loading = useAppWorkspaceStore((s) => s.conversationsLoading)
  const error = useAppWorkspaceStore((s) => s.conversationsError)
  const refreshConversations = useAppWorkspaceStore(
    (s) => s.refreshConversations
  )
  const tabs = useTabStore((s) => s.rawTabs)
  const { openTab } = useTabActions()
  const { openConversations } = useWorkbenchRoute()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(interval)
  }, [])
  const history = useMemo(() => {
    const openIds = new Set(
      tabs
        .filter((tab) => tab.folderId === scope)
        .map((tab) => `${tab.agentType}:${tab.conversationId}`)
    )
    return conversations
      .filter(
        (c) =>
          c.folder_id === scope &&
          c.kind !== "chat" &&
          c.parent_id == null &&
          !openIds.has(`${c.agent_type}:${c.id}`)
      )
      .sort(compareByUpdatedAtDesc)
  }, [conversations, tabs, scope])

  if (!enabled || typeof scope !== "number") return null

  const openHistory = (conversation: DbConversationSummary) => {
    const current = useFolderTabsStore.getState()
    if (!current.enabled || current.scope !== scope) return
    // A delete/move may land between pointer-down and selection. Resolve the
    // latest summary rather than opening from a stale menu item's snapshot.
    const live = useAppWorkspaceStore
      .getState()
      .conversations.find(
        (c) =>
          c.id === conversation.id &&
          c.folder_id === scope &&
          c.agent_type === conversation.agent_type
      )
    if (!live || isConversationDeleted(live.id)) return
    openConversations()
    openTab(
      live.folder_id,
      live.id,
      live.agent_type,
      true,
      live.title ?? undefined
    )
  }

  return (
    <DropdownMenu
      key={scope}
      onOpenChange={(open) => {
        if (open) setNow(Date.now())
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={STRIP_ICON_BTN}
          aria-label={t("history")}
          title={t("history")}
        >
          <History className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-[40rem] max-w-[calc(100vw-1rem)]"
      >
        <DropdownMenuLabel>{t("history")}</DropdownMenuLabel>
        {error && (
          <>
            <DropdownMenuLabel>{t("historyLoadFailed")}</DropdownMenuLabel>
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault()
                void refreshConversations()
              }}
            >
              {tCommon("refresh")}
            </DropdownMenuItem>
          </>
        )}
        {history.length === 0 && (loading || !error) && (
          <DropdownMenuLabel>
            {loading ? tCommon("loading") : !error ? t("historyEmpty") : null}
          </DropdownMenuLabel>
        )}
        {history.map((conversation) => {
          const title =
            formatConversationTitle(conversation.title) ||
            t("untitledConversation")
          const knownStatus = STATUS_ORDER.find(
            (s) => s === conversation.status
          )
          const status = knownStatus ? tStatus(knownStatus) : undefined
          return (
            <DropdownMenuItem
              key={conversation.id}
              onSelect={() => openHistory(conversation)}
              className="items-start"
              title={title}
            >
              <AgentIcon
                agentType={conversation.agent_type}
                className="mt-0.5 size-4"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{title}</span>
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  {getAgentLabel(conversation.agent_type)}
                  <ConversationStatusDot
                    status={knownStatus}
                    size="sm"
                    title={status}
                  />
                  {status}
                </span>
              </span>
              <time
                dateTime={conversation.updated_at}
                title={conversation.updated_at}
                className="mt-0.5 shrink-0 text-xs text-muted-foreground tabular-nums"
              >
                {formatRelative(conversation.updated_at, now)}
              </time>
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
