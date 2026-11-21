"use client"

import { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useShallow } from "zustand/react/shallow"
import { useTabStore } from "@/contexts/tab-context"
import { useConversationRuntimeStore } from "@/stores/conversation-runtime-store"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import {
  projectRuntimeSessionDetails,
  resolveActiveSessionDetailsFromSnapshot,
} from "@/components/conversations/active-session-details"
import { SessionDetailsCard } from "@/components/conversations/session-details-content"
import { MessageNavScrollContext } from "@/components/message/message-nav-scroll-context"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useAuxPanelContext } from "@/contexts/aux-panel-context"
import { SessionDetailsInsights } from "./session-details-insights"

/**
 * The aux-panel "Session Details" tab. Shows the active conversation's identity
 * and identifiers as a card (`SessionDetailsCard`; the dialog is the full view,
 * with token usage and timestamps), then what its transcript knows: the
 * agent's plan and the message navigator, whose messages carry their
 * sub-agents and changed files (`SessionDetailsInsights`). The branch selector
 * + command launcher that used to sit atop this tab now live in the bottom
 * status bar on both platforms.
 *
 * Details are resolved from live runtime state exactly the way the conversation
 * detail panel does it (`resolveActiveSessionDetails`), so no network fetch is
 * needed for the focused session.
 */
export function SessionDetailsTab() {
  const t = useTranslations("Folder.sessionDetails")
  const { isOpen, activeTab } = useAuxPanelContext()
  const active = isOpen && activeTab === "session_details"

  const tabs = useTabStore((s) => s.tabs)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const activeConversationTab = useMemo(
    () =>
      tabs.find(
        (tab) => tab.id === activeTabId && tab.conversationId != null
      ) ?? null,
    [tabs, activeTabId]
  )

  // A brand-new conversation streams under its virtual `runtimeConversationId`
  // until it reconciles; key the live-session lookup on it first (mirrors the
  // detail panel, exercised by active-session-details.test.ts). It is also the
  // key the conversation's transcript publishes its insights under.
  const activeRuntimeId =
    activeConversationTab?.runtimeConversationId ??
    activeConversationTab?.conversationId ??
    null
  // Keep transcript payloads out of both current and previous hook snapshots.
  // Shallow comparison still suppresses updates that change only message text.
  // Token usage isn't shown here, so its stats aren't read.
  const runtimeDetails = useConversationRuntimeStore(
    useShallow((s) => {
      const session =
        activeRuntimeId != null
          ? s.byConversationId.get(activeRuntimeId)
          : undefined
      const { summary, model } = projectRuntimeSessionDetails(session)
      return { summary, stats: null, model }
    })
  )
  const conversations = useAppWorkspaceStore((s) => s.conversations)
  // The tab scrolls as one, and the message navigator renders only the rows
  // in view of that scroll: it needs the real scroll container, which
  // OverlayScrollbars hands over once it has initialized.
  const [viewport, setViewport] = useState<HTMLElement | null>(null)
  const handleViewportRef = useCallback(
    (element: HTMLElement | null) => setViewport(element),
    []
  )
  const { summary, model } = resolveActiveSessionDetailsFromSnapshot(
    activeConversationTab,
    runtimeDetails,
    conversations
  )

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {summary ? (
        <ScrollArea
          className="min-h-0 flex-1"
          onViewportRef={handleViewportRef}
        >
          <MessageNavScrollContext.Provider value={viewport}>
            {/* The cards are as far apart as they are from the panel's
                sides. */}
            <div className="min-w-0 space-y-3 p-3 text-sm">
              <SessionDetailsCard summary={summary} model={model} />
              <SessionDetailsInsights
                conversationId={activeRuntimeId}
                active={active}
              />
            </div>
          </MessageNavScrollContext.Provider>
        </ScrollArea>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
          {t("noActiveSession")}
        </div>
      )}
    </div>
  )
}
