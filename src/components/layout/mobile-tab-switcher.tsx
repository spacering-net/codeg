"use client"

import { useState } from "react"
import { Check, File, PanelsTopLeft, X } from "lucide-react"
import { useTranslations } from "next-intl"
import { AgentIcon } from "@/components/agent-icon"
import { ConversationStatusDot } from "@/components/conversations/conversation-status-dot"
import { Button } from "@/components/ui/button"
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer"
import { useTabActions, useTabStore } from "@/contexts/tab-context"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import {
  useWorkspaceActions,
  useWorkspaceFileTabs,
  useWorkspaceView,
} from "@/contexts/workspace-context"
import { useVisibleConversationTabs } from "@/stores/tab-store"
import { useHistoryBackDismiss } from "@/hooks/use-history-back-dismiss"
import { cn } from "@/lib/utils"

/** 手机不挂载桌面 Tab 栏，用独立入口切换已打开内容，不依赖悬停或快捷键。 */
export function MobileTabSwitcher() {
  const t = useTranslations("Folder.mobileTabs")
  const tTabs = useTranslations("Folder.tabs")
  const [open, setOpen] = useState(false)
  const tabs = useVisibleConversationTabs()
  const activeTabId = useTabStore((state) => state.activeTabId)
  const { switchTab, closeTab } = useTabActions()
  const { fileTabs, activeFileTabId } = useWorkspaceFileTabs()
  const { mode, activePane } = useWorkspaceView()
  const { switchFileTab, closeFileTab, activateConversationPane } =
    useWorkspaceActions()
  const { isConversations, openConversations } = useWorkbenchRoute()
  const conversationVisible =
    mode === "conversation" || activePane === "conversation"
  const count = tabs.length + fileTabs.length
  useHistoryBackDismiss(open, () => setOpen(false))

  return (
    <Drawer
      open={open}
      onOpenChange={setOpen}
      swipeDirection="down"
      disablePointerDismissal={false}
    >
      <Button
        variant="ghost"
        size="icon"
        className="relative size-10 shrink-0 touch-manipulation"
        onClick={() => setOpen(true)}
        aria-label={t("open", { count })}
        title={t("title")}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <PanelsTopLeft className="size-4" />
        {count > 0 && (
          <span className="absolute right-0.5 top-0.5 min-w-3.5 rounded bg-background px-0.5 text-[10px] leading-3.5 tabular-nums">
            {count > 99 ? "99+" : count}
          </span>
        )}
      </Button>
      <DrawerContent
        className="max-h-[80dvh] overflow-hidden p-0"
        closeButtonClassName="top-2 right-2 size-10"
      >
        <DrawerHeader className="shrink-0 border-b px-4 py-3">
          <DrawerTitle>{t("title")}</DrawerTitle>
        </DrawerHeader>
        <div className="min-h-0 min-w-0 overflow-y-auto overscroll-contain p-2">
          {count === 0 && (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">
              {t("empty")}
            </p>
          )}
          {tabs.length > 0 && (
            <div role="group" aria-label={t("conversations")}>
              <h3 className="px-2 py-2 text-xs font-medium text-muted-foreground">
                {t("conversations")}
              </h3>
              {tabs.map((tab) => {
                const selected =
                  isConversations &&
                  conversationVisible &&
                  tab.id === activeTabId
                return (
                  <div key={tab.id} className="flex min-w-0 items-center gap-1">
                    <button
                      type="button"
                      aria-current={selected ? "page" : undefined}
                      className={cn(
                        "flex min-h-12 min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-2 text-left text-sm touch-manipulation",
                        selected
                          ? "bg-accent text-accent-foreground"
                          : "hover:bg-accent/60"
                      )}
                      onClick={() => {
                        openConversations()
                        switchTab(tab.id)
                        activateConversationPane()
                        setOpen(false)
                      }}
                    >
                      <AgentIcon
                        agentType={tab.agentType}
                        className="size-4 shrink-0"
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {tab.title}
                      </span>
                      {tab.status && (
                        <ConversationStatusDot status={tab.status} />
                      )}
                      {selected && <Check className="size-4 shrink-0" />}
                    </button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-11 shrink-0 touch-manipulation"
                      aria-label={`${tTabs("closeConversationTab")}: ${tab.title}`}
                      onClick={() => closeTab(tab.id)}
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                )
              })}
            </div>
          )}
          {fileTabs.length > 0 && (
            <div role="group" aria-label={t("files")}>
              <h3 className="px-2 py-2 text-xs font-medium text-muted-foreground">
                {t("files")}
              </h3>
              {fileTabs.map((tab) => {
                const selected =
                  isConversations &&
                  !conversationVisible &&
                  tab.id === activeFileTabId
                return (
                  <div key={tab.id} className="flex min-w-0 items-center gap-1">
                    <button
                      type="button"
                      aria-current={selected ? "page" : undefined}
                      className={cn(
                        "flex min-h-12 min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-2 text-left text-sm touch-manipulation",
                        selected
                          ? "bg-accent text-accent-foreground"
                          : "hover:bg-accent/60"
                      )}
                      onClick={() => {
                        openConversations()
                        switchFileTab(tab.id)
                        setOpen(false)
                      }}
                    >
                      <File className="size-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">
                        {tab.title}
                      </span>
                      {tab.kind === "file" && tab.isDirty && (
                        <span className="size-1.5 shrink-0 rounded-full bg-primary" />
                      )}
                      {selected && <Check className="size-4 shrink-0" />}
                    </button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-11 shrink-0 touch-manipulation"
                      aria-label={`${tTabs("close")}: ${tab.title}`}
                      onClick={() => closeFileTab(tab.id)}
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  )
}
