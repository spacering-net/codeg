"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronDown, Folder, FolderInput } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandList,
} from "@/components/ui/command"
import {
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { FolderAliasLabel } from "@/components/conversations/folder-alias-label"
import { useMoveTargetFolders } from "@/components/conversations/move-conversation-dialog"
import { FolderOptionItem } from "@/components/shared/folder-select"

/**
 * The sidebar row's "Move to folder" submenu: hovering it lists every other open
 * folder, and picking one hands it to `onPick` (which asks for confirmation).
 * Rendered only inside an open menu, so the store subscription costs nothing
 * per idle row.
 */
export function MoveToFolderContextSubmenu({
  currentFolderId,
  onPick,
}: {
  currentFolderId: number
  onPick: (folderId: number) => void
}) {
  const t = useTranslations("Folder.moveConversation")
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <FolderInput className="h-4 w-4" />
        {t("menuLabel")}
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="max-h-[min(24rem,var(--radix-context-menu-content-available-height))] min-w-[12rem] max-w-[18rem] overflow-y-auto">
        <MoveTargetItems currentFolderId={currentFolderId} onPick={onPick} />
      </ContextMenuSubContent>
    </ContextMenuSub>
  )
}

function MoveTargetItems({
  currentFolderId,
  onPick,
}: {
  currentFolderId: number
  onPick: (folderId: number) => void
}) {
  const t = useTranslations("Folder.moveConversation")
  const targets = useMoveTargetFolders(currentFolderId)
  if (targets.length === 0) {
    return (
      <ContextMenuItem disabled className="text-muted-foreground">
        {t("noTargets")}
      </ContextMenuItem>
    )
  }
  return targets.map((f) => (
    <ContextMenuItem
      key={f.id}
      onSelect={() => onPick(f.id)}
      // The path tells two same-named repos apart; the row stays one line.
      title={f.path}
    >
      <Folder className="h-4 w-4" />
      <span className="min-w-0 flex-1 truncate">
        <FolderAliasLabel
          name={f.name}
          alias={f.alias ?? null}
          bracketClassName="text-muted-foreground"
        />
      </span>
    </ContextMenuItem>
  ))
}

/**
 * Manage conversations' "Move to…" button: a searchable list of the other open
 * folders (the same rows as every folder picker), handing the pick to `onPick`.
 * `currentFolderId` is the folder the selection shares, if it shares one.
 */
export function MoveToFolderButton({
  currentFolderId,
  disabled,
  onPick,
}: {
  currentFolderId: number | null
  disabled?: boolean
  onPick: (folderId: number) => void
}) {
  const t = useTranslations("Folder.moveConversation")
  const tManage = useTranslations("Folder.sidebar.manageConversations")
  const tPicker = useTranslations("Folder.conversationContextBar")
  const targets = useMoveTargetFolders(currentFolderId)
  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={(o) => !disabled && setOpen(o)}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline" disabled={disabled}>
          <FolderInput className="h-3.5 w-3.5 mr-1" />
          {tManage("moveSelected")}
          <ChevronDown className="h-3 w-3 ml-1 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 overflow-hidden p-0">
        <Command className="rounded-2xl">
          <CommandInput placeholder={tPicker("searchFolder")} />
          <CommandList>
            <CommandEmpty>
              {targets.length === 0 ? t("noTargets") : tPicker("noFolders")}
            </CommandEmpty>
            <CommandGroup>
              {targets.map((f) => (
                <FolderOptionItem
                  key={f.id}
                  folder={f}
                  selected={false}
                  onSelect={() => {
                    setOpen(false)
                    onPick(f.id)
                  }}
                />
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
