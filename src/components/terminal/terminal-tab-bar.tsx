"use client"

import { useMemo, useRef, useState } from "react"
import { Keyboard, Minus, Plus, X } from "lucide-react"
import { useTranslations } from "next-intl"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useTerminalContext } from "@/contexts/terminal-context"
import { useShortcutSettings } from "@/hooks/use-shortcut-settings"
import { useIsMac } from "@/hooks/use-is-mac"
import { useImeGuard } from "@/hooks/use-ime-guard"
import { formatShortcutLabel } from "@/lib/keyboard-shortcuts"
import { handleMiddleClickClose } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

interface TerminalTabBarProps {
  /** 移动端折叠/展开键栏的开关。仅 isMobile 时父级才传 true。 */
  showKeybarToggle?: boolean
  /** 当前是否已折叠（驱动键盘按钮的 active 高亮）。 */
  keybarCollapsed?: boolean
  /** 点击键盘按钮的回调。 */
  onToggleKeybar?: () => void
}

export function TerminalTabBar({
  showKeybarToggle = false,
  keybarCollapsed = false,
  onToggleKeybar,
}: TerminalTabBarProps) {
  const t = useTranslations("Folder.terminal")
  const ime = useImeGuard()
  const { shortcuts } = useShortcutSettings()
  const isMac = useIsMac()
  const {
    tabs,
    activeTabId,
    switchTerminal,
    closeTerminal,
    closeOtherTerminals,
    closeAllTerminals,
    renameTerminal,
    createTerminal,
    toggle,
  } = useTerminalContext()
  const { activeFolderId } = useActiveFolder()
  const folders = useAppWorkspaceStore((s) => s.folders)

  const folderIndex = useMemo(() => {
    const map = new Map<number, string>()
    for (const f of folders) map.set(f.id, f.name)
    return map
  }, [folders])

  const canCreateTerminal = activeFolderId != null

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)

  const startRename = (id: string, title: string) => {
    setEditingId(id)
    setEditValue(title)
    setTimeout(() => inputRef.current?.select(), 0)
  }

  const commitRename = () => {
    if (editingId && editValue.trim()) {
      renameTerminal(editingId, editValue.trim())
    }
    setEditingId(null)
  }

  return (
    <div className="flex items-center h-8 bg-muted/50 border-b gap-0.5 px-1 shrink-0">
      {tabs.map((tab) => (
        <ContextMenu key={tab.id}>
          <ContextMenuTrigger asChild>
            <div
              className={`flex items-center gap-1 h-6 px-2 rounded-sm text-xs cursor-pointer select-none ${
                tab.id === activeTabId
                  ? "bg-background text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted"
              }`}
              onClick={() => switchTerminal(tab.id)}
              onMouseDown={(event) => {
                if (editingId === tab.id) return
                handleMiddleClickClose(event, () => closeTerminal(tab.id))
              }}
              title={`${folderIndex.get(tab.folderId) ?? String(tab.folderId)}  —  ${tab.title}`}
            >
              {editingId === tab.id ? (
                <input
                  ref={inputRef}
                  className="bg-transparent outline-none border border-primary/50 rounded px-0.5 w-20 text-xs"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  {...ime.props}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (ime.isComposing(e)) return
                    if (e.key === "Enter") commitRename()
                    if (e.key === "Escape") setEditingId(null)
                  }}
                />
              ) : (
                <span className="truncate max-w-[7.5rem]">{tab.title}</span>
              )}
              <button
                className="ml-1 rounded-sm hover:bg-muted-foreground/20 p-0.5"
                onClick={(e) => {
                  e.stopPropagation()
                  closeTerminal(tab.id)
                }}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onSelect={() => startRename(tab.id, tab.title)}>
              {t("rename")}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => closeTerminal(tab.id)}>
              {t("close")}
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => closeOtherTerminals(tab.id)}
              disabled={tabs.length <= 1}
            >
              {t("closeOthers")}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => closeAllTerminals()}>
              {t("closeAll")}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ))}
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0"
                onClick={() => void createTerminal()}
                disabled={!canCreateTerminal}
              >
                <Plus className="h-3 w-3" />
              </Button>
            </span>
          </TooltipTrigger>
          {!canCreateTerminal && (
            <TooltipContent side="top">{t("openFolderFirst")}</TooltipContent>
          )}
        </Tooltip>
      </TooltipProvider>
      {showKeybarToggle && onToggleKeybar && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={`h-6 w-6 shrink-0 ${keybarCollapsed ? "" : "text-primary"}`}
                onClick={onToggleKeybar}
                aria-pressed={!keybarCollapsed}
                aria-label={
                  keybarCollapsed ? t("keybar.show") : t("keybar.hide")
                }
              >
                <Keyboard className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {keybarCollapsed ? t("keybar.show") : t("keybar.hide")}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 shrink-0 ml-auto"
        onClick={toggle}
        title={t("hideTerminal", {
          shortcut: formatShortcutLabel(shortcuts.toggle_terminal, isMac),
        })}
      >
        <Minus className="h-3 w-3" />
      </Button>
    </div>
  )
}
