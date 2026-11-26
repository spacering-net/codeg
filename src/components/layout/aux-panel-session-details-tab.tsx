"use client"

import { useCallback, useMemo, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { useShallow } from "zustand/react/shallow"
import { ListChecks, MessagesSquare, PanelRightDashed } from "lucide-react"
import { useTabStore } from "@/contexts/tab-context"
import { useConversationRuntimeStore } from "@/stores/conversation-runtime-store"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import {
  projectRuntimeSessionDetails,
  resolveActiveSessionDetailsFromSnapshot,
} from "@/components/conversations/active-session-details"
import {
  DraftSessionDetailsCard,
  SessionDetailsCard,
} from "@/components/conversations/session-details-content"
import { MessageNavScrollContext } from "@/components/message/message-nav-scroll-context"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { TabItem } from "@/stores/tab-store"
import { useAuxPanelContext } from "@/contexts/aux-panel-context"
import { SessionDetailsInsights } from "./session-details-insights"
import { SESSION_DETAILS_COLUMN } from "./session-details-layout"

/**
 * The aux-panel "Session Details" tab. Shows the active conversation's identity
 * and identifiers (`SessionDetailsCard`; the dialog is the full view,
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
  const focusedTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? null,
    [tabs, activeTabId]
  )
  const activeConversationTab =
    focusedTab?.conversationId != null ? focusedTab : null

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
        // Keyed apart from the pending view's scroll area, which sits in the
        // same place: reused, it would have initialized already, and never
        // hand this one's `onViewportRef` the viewport the navigator needs.
        <ScrollArea
          key="details"
          className="min-h-0 flex-1"
          onViewportRef={handleViewportRef}
        >
          <MessageNavScrollContext.Provider value={viewport}>
            <div className={SESSION_DETAILS_COLUMN}>
              <SessionDetailsCard summary={summary} model={model} />
              <SessionDetailsInsights
                conversationId={activeRuntimeId}
                dbConversationId={activeConversationTab?.conversationId ?? null}
                active={active}
              />
            </div>
          </MessageNavScrollContext.Provider>
        </ScrollArea>
      ) : focusedTab ? (
        // A new conversation, before its first message has made it one; or
        // one just made, or opened, whose summary hasn't come through yet —
        // what the tab already knows, rather than "no active session".
        <ScrollArea key="draft" className="min-h-0 flex-1">
          <DraftSessionDetails
            tab={focusedTab}
            pending={focusedTab.conversationId != null}
          />
        </ScrollArea>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 pb-10 text-center">
          <span
            aria-hidden="true"
            className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground"
          >
            <PanelRightDashed className="size-5" />
          </span>
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">
              {t("noActiveSession")}
            </p>
            <p className="max-w-64 text-xs leading-5 text-muted-foreground">
              {t("noActiveSessionHint")}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The tab for a conversation that has no messages yet: its card as far as it
 * goes (`DraftSessionDetailsCard` — the agent, the branch and the folder),
 * then the sections the transcript will fill, dimmed, and a line saying when
 * they will come. `pending`: the conversation exists but its summary isn't in
 * yet — the card alone, under the tab's title, nothing promised.
 */
function DraftSessionDetails({
  tab,
  pending,
}: {
  tab: TabItem
  pending: boolean
}) {
  const t = useTranslations("Folder.sessionDetails")
  const tPlan = useTranslations("Folder.chat.agentPlanOverlay")
  const tNav = useTranslations("Folder.chat.messageNav")
  // A folderless chat (or the personal agent's) runs in a hidden folder of
  // its own: no folder or branch of the user's to show.
  const folder = useAppWorkspaceStore((s) => {
    if (tab.isChat) return null
    const found = s.allFolders.find((f) => f.id === tab.folderId)
    return found?.kind === "regular" ? found : null
  })
  const branch = useAppWorkspaceStore((s) =>
    folder ? (s.branches.get(folder.id) ?? folder.git_branch ?? null) : null
  )
  return (
    <div className={SESSION_DETAILS_COLUMN}>
      <DraftSessionDetailsCard
        agentType={tab.agentType}
        branch={branch}
        folder={folder ? { name: folder.name, path: folder.path } : null}
        title={pending ? tab.title || t("untitled") : null}
      />
      {!pending && (
        <>
          <DraftSectionRow icon={<ListChecks />} title={tPlan("title")} />
          <DraftSectionRow icon={<MessagesSquare />} title={tNav("title")} />
          <p className="py-3 text-xs leading-5 text-muted-foreground">
            {t("draftHint")}
          </p>
        </>
      )}
    </div>
  )
}

/** A section still to come, as its header will look — dimmed, and nothing to
 *  fold yet. */
function DraftSectionRow({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div aria-hidden="true" className="py-1.5">
      <div className="flex h-9 min-w-0 items-center gap-2 text-muted-foreground/70">
        <span className="flex w-5 shrink-0 justify-center [&>svg]:size-4">
          {icon}
        </span>
        <span className="min-w-0 flex-1 truncate text-[0.8125rem] font-semibold">
          {title}
        </span>
      </div>
    </div>
  )
}
