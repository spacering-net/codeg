"use client"

import { useCallback, useMemo } from "react"
import { Check, PanelsTopLeft } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ConversationStatusDot } from "@/components/conversations/conversation-status-dot"
import { useTabActions, useTabStore } from "@/contexts/tab-context"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { cn } from "@/lib/utils"

/**
 * Mobile's entry point to the open tabs.
 *
 * The desktop tab strip is not mounted on the mobile path, where tabs are
 * normally reached from the conversation list instead. That list only shows
 * conversations, so a background tab that no longer appears there (a draft, a
 * child session) would otherwise have no way back. This menu mirrors the
 * desktop strip's per-tab cues — status dot, title, folder — in a phone-sized
 * list.
 */
export function MobileTabSwitcher() {
  const t = useTranslations("Folder.folderTitleBar")
  const tabs = useTabStore((s) => s.tabs)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const { switchTab } = useTabActions()
  const { openConversations } = useWorkbenchRoute()
  const allFolders = useAppWorkspaceStore((s) => s.allFolders)

  const folderNames = useMemo(() => {
    const names = new Map<number, string>()
    for (const folder of allFolders) names.set(folder.id, folder.name)
    return names
  }, [allFolders])

  // Switching from a full-page route (settings, a repository page) has to
  // bring the conversation workspace back first, or the activated tab stays
  // hidden under the route overlay.
  const handleSwitch = useCallback(
    (tabId: string) => {
      openConversations()
      switchTab(tabId)
    },
    [openConversations, switchTab]
  )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          disabled={tabs.length === 0}
          title={t("openTabs")}
          aria-label={t("openTabs")}
        >
          <PanelsTopLeft className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-72 max-w-[calc(100vw-1rem)]"
      >
        <DropdownMenuLabel>{t("openTabs")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {tabs.map((tab) => {
          const active = tab.id === activeTabId
          const folderName = folderNames.get(tab.folderId)
          return (
            <DropdownMenuItem
              key={tab.id}
              onSelect={() => handleSwitch(tab.id)}
              aria-current={active ? "true" : undefined}
              className={cn("items-start", active && "bg-accent/60")}
            >
              <ConversationStatusDot
                status={tab.status}
                size="sm"
                className="mt-1.5"
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{tab.title}</span>
                {folderName ? (
                  <span className="truncate text-xs text-muted-foreground">
                    {folderName}
                  </span>
                ) : null}
              </span>
              {active ? (
                <Check className="ml-auto size-4 shrink-0 text-primary" />
              ) : null}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
