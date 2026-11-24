"use client"

import { memo, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Check, ChevronDown, Folder, MessageSquare } from "lucide-react"
import type { OverlayScrollbarsComponentRef } from "overlayscrollbars-react"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useTabActions, useTabStore } from "@/contexts/tab-context"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import {
  excludeChatFolders,
  filterTopLevelFolders,
  formatFolderLabelWithAlias,
  resolveFolderDisplayName,
  resolvePickerSelectedFolderId,
} from "@/lib/folder-display"
import { FolderAliasLabel } from "@/components/conversations/folder-alias-label"
import { FolderOptionItem } from "@/components/shared/folder-select"
import { BranchDropdown } from "@/components/layout/branch-dropdown"

interface ConversationContextBarProps {
  extraContent?: React.ReactNode
  hasExtraContent?: boolean
  scrollEndTrigger?: number
}

export const ConversationContextBar = memo(function ConversationContextBar({
  extraContent,
  hasExtraContent = false,
  scrollEndTrigger,
}: ConversationContextBarProps = {}) {
  const scrollRef = useRef<OverlayScrollbarsComponentRef>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const prevScrollTriggerRef = useRef<number>(scrollEndTrigger ?? 0)
  useEffect(() => {
    if (scrollEndTrigger == null) return
    if (scrollEndTrigger <= prevScrollTriggerRef.current) {
      prevScrollTriggerRef.current = scrollEndTrigger
      return
    }
    prevScrollTriggerRef.current = scrollEndTrigger
    requestAnimationFrame(() => {
      const viewport = scrollRef.current?.osInstance()?.elements().viewport
      if (!viewport) return
      viewport.scrollTo({ left: viewport.scrollWidth, behavior: "smooth" })
    })
  }, [scrollEndTrigger])

  useEffect(() => {
    if (!hasExtraContent) return
    const inner = innerRef.current
    if (!inner) return
    const handler = (e: WheelEvent) => {
      const viewport = scrollRef.current?.osInstance()?.elements().viewport
      if (!viewport) return
      if (viewport.scrollWidth <= viewport.clientWidth) return
      const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX
      if (delta === 0) return
      e.preventDefault()
      viewport.scrollLeft += delta
    }
    inner.addEventListener("wheel", handler, { passive: false })
    return () => inner.removeEventListener("wheel", handler)
  }, [hasExtraContent])

  if (!hasExtraContent) return null

  return (
    <div className="flex shrink-0 items-center gap-1.5 px-2 pt-2 text-xs text-muted-foreground">
      <ScrollArea
        x="scroll"
        y="hidden"
        className="min-w-0 flex-1"
        ref={scrollRef}
      >
        <div ref={innerRef} className="flex w-max items-center gap-1.5">
          {extraContent}
        </div>
      </ScrollArea>
    </div>
  )
})

ConversationContextBar.displayName = "ConversationContextBar"

// ============================================================================
// ConversationHeaderFolderPicker — the folder selector on its own. Rendered in
// the desktop conversation header (replacing the old folder-name breadcrumb).
// Self-contained: resolves its own tab/folder from `tabId` (or the active tab)
// so the mount site only passes `tabId`. The branch selector no longer sits
// beside it here — on desktop it lives in the bottom status bar.
// ============================================================================

interface ConversationHeaderFolderPickerProps {
  tabId?: string | null
}

export const ConversationHeaderFolderPicker = memo(
  function ConversationHeaderFolderPicker({
    tabId,
  }: ConversationHeaderFolderPickerProps) {
    const t = useTranslations("Folder.conversationContextBar")
    const tabs = useTabStore((s) => s.tabs)
    const activeTabId = useTabStore((s) => s.activeTabId)
    const { openNewConversationTab, openChatModeTab } = useTabActions()
    const folders = useAppWorkspaceStore((s) => s.folders)
    const allFolders = useAppWorkspaceStore((s) => s.allFolders)

    const ownTab = useMemo(() => {
      const lookupId = tabId ?? activeTabId
      return tabs.find((x) => x.id === lookupId) ?? null
    }, [tabs, tabId, activeTabId])

    const ownFolder = useMemo(
      () =>
        ownTab
          ? (allFolders.find((f) => f.id === ownTab.folderId) ?? null)
          : null,
      [ownTab, allFolders]
    )

    // Only top-level repos are switchable here; worktree folders are reached
    // via the branch picker, and hidden chat folders are a per-conversation
    // implementation detail, so both are excluded from the list.
    const topLevelFolders = useMemo(
      () => excludeChatFolders(filterTopLevelFolders(folders)),
      [folders]
    )

    if (!ownTab) return null
    // Chat mode: a draft flagged `isChat` (no folder yet) or a conversation
    // bound to a hidden chat folder. The chip still shows so the user can
    // switch back to a real folder while drafting.
    const isChatMode = ownTab.isChat === true || ownFolder?.kind === "chat"
    if (!ownFolder && !isChatMode) return null

    // Worktree folders surface their parent (root repo) row; resolve that same
    // folder so the header shows the repo's `alias [ name ]` (matching the
    // sidebar) rather than the worktree dir's own name. Git/path ops still use
    // `ownFolder` (the worktree) unchanged.
    const pickerSelectedId =
      isChatMode || !ownFolder ? -1 : resolvePickerSelectedFolderId(ownFolder)
    const displayFolder =
      isChatMode || !ownFolder
        ? null
        : (allFolders.find((f) => f.id === pickerSelectedId) ?? ownFolder)
    const displayFolderName = isChatMode
      ? t("chatModeLabel")
      : resolveFolderDisplayName(ownFolder!, allFolders)
    const displayFolderAlias = displayFolder?.alias ?? null
    // The full `alias [ name ]` also goes in the tooltip for the truncated case.
    const titleFolderName = displayFolder
      ? formatFolderLabelWithAlias(displayFolder)
      : displayFolderName

    // The header folder is a static, un-themed breadcrumb: folder (and chat-mode)
    // switching now lives in the below-composer picker row, so even a new
    // conversation draft shows a plain label here — never a popover trigger,
    // never the theme color.
    return (
      <FolderPicker
        variant="header"
        folders={topLevelFolders}
        currentFolderId={pickerSelectedId}
        currentFolderName={displayFolderName}
        alias={displayFolderAlias}
        title={`${t("folderTitle")}: ${titleFolderName}`}
        editable={false}
        onSelect={async (folderId) => {
          const target = folders.find((f) => f.id === folderId)
          if (!target) return
          try {
            // Route through openNewConversationTab so the target folder's saved
            // default agent is applied; the existing-draft branch reuses ownTab
            // via the singleton invariant. `inheritFromActive: true` keeps the
            // user's current agent when the target folder has no pinned default.
            // `retargetTabId` names ownTab outright: while tabs follow the
            // folder, the target folder may hold a draft of its own.
            openNewConversationTab(target.id, target.path, {
              inheritFromActive: true,
              ...(ownTab.conversationId == null
                ? { retargetTabId: ownTab.id }
                : {}),
            })
            toast.success(t("toasts.folderChanged", { name: target.name }))
          } catch (err) {
            console.error(
              "[ConversationHeaderFolderPicker] switch folder failed:",
              err
            )
            toast.error(t("toasts.openFolderFailed"))
          }
        }}
        labelEmpty={t("noFolders")}
        labelSearch={t("searchFolder")}
        labelChatMode={t("chatModeLabel")}
        isChatMode={isChatMode}
        onSelectChatMode={() => {
          try {
            openChatModeTab(
              ownTab.conversationId == null
                ? { retargetTabId: ownTab.id }
                : undefined
            )
            toast.success(t("toasts.switchedToChatMode"))
          } catch (err) {
            console.error(
              "[ConversationHeaderFolderPicker] switch to chat mode failed:",
              err
            )
            toast.error(t("toasts.openFolderFailed"))
          }
        }}
      />
    )
  }
)

ConversationHeaderFolderPicker.displayName = "ConversationHeaderFolderPicker"

// ============================================================================
// ConversationFolderBranchPicker — folder + branch buttons rendered below the
// message input on every platform. Lets the user switch the draft's folder (and
// its git branch) right where they type; the conversation header shows the same
// folder as a static breadcrumb.
// ============================================================================

interface ConversationFolderBranchPickerProps {
  tabId?: string | null
  /**
   * Identity and switching for a surface that ISN'T a tab. Supplied, it
   * replaces the tab lookup entirely.
   *
   * Without it this picker resolves itself from `tabId ?? activeTabId`, which
   * for a surface with no tab of its own means "whatever tab the workspace last
   * had open" — every canvas card showed that tab's folder and switching moved
   * that tab, not the card. A non-tab surface has to say who it is.
   */
  override?: ConversationFolderPickerOverride
}

export interface ConversationFolderPickerOverride {
  /** The conversation's folder; `null` means chat mode (no folder yet). */
  folderId: number | null
  /** Whether the folder can still be changed — false once the conversation is
   *  bound, matching a tab's "only a new conversation may move". */
  editable: boolean
  onSelectFolder: (folderId: number, path: string) => void
  onSelectChatMode: () => void
}

export const ConversationFolderBranchPicker = memo(
  function ConversationFolderBranchPicker({
    tabId,
    override,
  }: ConversationFolderBranchPickerProps) {
    const t = useTranslations("Folder.conversationContextBar")
    const tabs = useTabStore((s) => s.tabs)
    const activeTabId = useTabStore((s) => s.activeTabId)
    const { openNewConversationTab, openChatModeTab } = useTabActions()
    const folders = useAppWorkspaceStore((s) => s.folders)
    const allFolders = useAppWorkspaceStore((s) => s.allFolders)

    const ownTab = useMemo(() => {
      if (override) return null
      const lookupId = tabId ?? activeTabId
      return tabs.find((x) => x.id === lookupId) ?? null
    }, [override, tabs, tabId, activeTabId])

    const ownFolder = useMemo(() => {
      if (override) {
        return override.folderId != null
          ? (allFolders.find((f) => f.id === override.folderId) ?? null)
          : null
      }
      return ownTab
        ? (allFolders.find((f) => f.id === ownTab.folderId) ?? null)
        : null
    }, [override, ownTab, allFolders])

    // The folder picker lists only top-level repos — worktree folders
    // (`parent_id != null`) are reached through the branch picker, not here, so
    // they're hidden to keep this picker a clean repo switcher. Hidden chat
    // folders are excluded too (they're a per-conversation implementation
    // detail, not a switchable repo).
    const topLevelFolders = useMemo(
      () => excludeChatFolders(filterTopLevelFolders(folders)),
      [folders]
    )

    if (!override && !ownTab) return null
    // Chat mode: either a draft flagged `isChat` (no folder yet) or a bound
    // conversation whose folder is a hidden chat folder. Show the folder
    // chip (so the user can switch back to a real folder while drafting) but
    // suppress the branch picker — a folderless chat has no git branch.
    const isChatMode = override
      ? override.folderId == null || ownFolder?.kind === "chat"
      : ownTab!.isChat === true || ownFolder?.kind === "chat"
    if (!ownFolder && !isChatMode) return null

    const isNewConversation = override
      ? override.editable
      : ownTab!.conversationId == null
    // Worktree folders surface their parent (root repo) name here; the picker's
    // own list below keeps real folder names/paths for selection, and every
    // git/path operation still uses `ownFolder` (the worktree) unchanged.
    const displayFolderName = isChatMode
      ? t("chatModeLabel")
      : resolveFolderDisplayName(ownFolder!, allFolders)
    // When the conversation lives in a worktree, the picker highlights its
    // parent repo (the worktree itself isn't listed). Display-only — the tab's
    // real folder/working dir is untouched. Chat mode has no real folder, so
    // `-1` (no row) is highlighted.
    const pickerSelectedId =
      isChatMode || !ownFolder ? -1 : resolvePickerSelectedFolderId(ownFolder)

    return (
      <>
        <FolderPicker
          folders={topLevelFolders}
          currentFolderId={pickerSelectedId}
          currentFolderName={displayFolderName}
          title={`${t("folderTitle")}: ${displayFolderName}`}
          editable={isNewConversation}
          onSelect={async (folderId) => {
            const target = folders.find((f) => f.id === folderId)
            if (!target) return
            if (override) {
              // The surface owns what "switch folder" means for it — a canvas
              // card retargets its own draft rather than opening a tab.
              override.onSelectFolder(target.id, target.path)
              toast.success(t("toasts.folderChanged", { name: target.name }))
              return
            }
            try {
              // Route through openNewConversationTab so the target folder's
              // saved default agent is applied. The function's existing-
              // draft branch reuses ownTab via the singleton invariant and
              // runs the disconnect-then-patch dance for folder+agent
              // changes. `inheritFromActive: true` preserves the user's
              // current agent when the target folder has no pinned default
              // — "I'm switching folders, keep my workflow". `retargetTabId`
              // names ownTab outright: while tabs follow the folder, the
              // target folder may hold a draft of its own.
              openNewConversationTab(target.id, target.path, {
                inheritFromActive: true,
                ...(ownTab!.conversationId == null
                  ? { retargetTabId: ownTab!.id }
                  : {}),
              })
              toast.success(t("toasts.folderChanged", { name: target.name }))
            } catch (err) {
              console.error(
                "[ConversationFolderBranchPicker] switch folder failed:",
                err
              )
              toast.error(t("toasts.openFolderFailed"))
            }
          }}
          labelEmpty={t("noFolders")}
          labelSearch={t("searchFolder")}
          labelChatMode={t("chatModeLabel")}
          isChatMode={isChatMode}
          onSelectChatMode={() => {
            if (override) {
              override.onSelectChatMode()
              toast.success(t("toasts.switchedToChatMode"))
              return
            }
            try {
              // Like the folder switch: this draft itself moves (see
              // `retargetTabId`), whatever the global scope already holds.
              openChatModeTab(
                ownTab!.conversationId == null
                  ? { retargetTabId: ownTab!.id }
                  : undefined
              )
              toast.success(t("toasts.switchedToChatMode"))
            } catch (err) {
              console.error(
                "[ConversationFolderBranchPicker] switch to chat mode failed:",
                err
              )
              toast.error(t("toasts.openFolderFailed"))
            }
          }}
        />

        {/* Branch selector — the rich BranchDropdown (pull / commit / push /
            new branch / worktree / stash / merge / rebase / … + branch tree).
            Mounted per tile with the tile's OWN folder so a tiled view keeps
            every tile's chip live; self-hides in chat mode and offers an init
            option for a non-git folder. */}
        <BranchDropdown folder={ownFolder} isChatMode={isChatMode} />
      </>
    )
  }
)

ConversationFolderBranchPicker.displayName = "ConversationFolderBranchPicker"

/**
 * Mirror the visibility check inside `ConversationFolderBranchPicker` so the
 * parent can decide whether to render its wrapper row at all. The picker
 * itself returns `null` when no tab/folder is resolved (e.g. while folders
 * are still loading on first paint), and the parent must avoid rendering an
 * otherwise-empty wrapper in that interval.
 */
export function useConversationFolderBranchPickerVisible(
  tabId?: string | null,
  override?: ConversationFolderPickerOverride
): boolean {
  const tabs = useTabStore((s) => s.tabs)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const allFolders = useAppWorkspaceStore((s) => s.allFolders)
  // An overriding surface is always its own answer: it has an identity whether
  // or not any tab exists, and a chat-mode card has no folder to find.
  if (override) {
    return (
      override.folderId == null ||
      allFolders.some((f) => f.id === override.folderId)
    )
  }
  const lookupId = tabId ?? activeTabId
  const ownTab = tabs.find((x) => x.id === lookupId) ?? null
  const ownFolder = ownTab
    ? (allFolders.find((f) => f.id === ownTab.folderId) ?? null)
    : null
  // The row shows below the composer on every platform. Chat-mode drafts have
  // no resolvable folder yet, but the row must still show so the folder chip
  // (and the chat-mode item) stay reachable.
  return Boolean(ownTab && (ownFolder || ownTab.isChat))
}

// ============================================================================
// FolderPicker
// ============================================================================

interface FolderPickerProps {
  folders: { id: number; name: string; path: string; alias?: string | null }[]
  currentFolderId: number
  currentFolderName: string
  title: string
  editable: boolean
  onSelect: (folderId: number) => void | Promise<void>
  labelEmpty: string
  labelSearch: string
  /** Label for the pinned "no-folder (chat) mode" item at the bottom. */
  labelChatMode: string
  /** Whether the draft is currently in chat mode (shows the check mark). */
  isChatMode: boolean
  /** Select folderless chat mode. */
  onSelectChatMode: () => void
  /** Trigger appearance. `"chip"` (default) = folder icon + name + chevron, the
   *  compact below-input row (mobile). `"header"` = bare text sized to the
   *  conversation title, alias-aware, themed while editable — the desktop
   *  conversation-header breadcrumb. */
  variant?: "chip" | "header"
  /** Folder alias for the `"header"` variant's `alias [ name ]` label (rendered
   *  via {@link FolderAliasLabel}). Ignored by the chip variant. */
  alias?: string | null
}

const FolderPicker = memo(function FolderPicker({
  folders,
  currentFolderId,
  currentFolderName,
  title,
  editable,
  onSelect,
  labelEmpty,
  labelSearch,
  labelChatMode,
  isChatMode,
  onSelectChatMode,
  variant = "chip",
  alias = null,
}: FolderPickerProps) {
  const [open, setOpen] = useState(false)

  // Header variant: no icons, `alias [ name ]` inline (matching the sidebar
  // folder header), sized to the neighbouring conversation title. A new/editable
  // conversation renders in the theme color to advertise that it's switchable;
  // a bound one is a static foreground chip that reads as a breadcrumb crumb.
  const headerLabel =
    alias && alias.trim() ? (
      <FolderAliasLabel
        name={currentFolderName}
        alias={alias}
        bracketClassName={editable ? "text-primary/60" : "text-foreground"}
      />
    ) : (
      currentFolderName
    )

  const trigger =
    variant === "header" ? (
      <button
        type="button"
        title={title}
        className={cn(
          "flex shrink-0 items-center rounded-sm text-sm outline-none transition-colors",
          editable
            ? "cursor-pointer text-primary hover:text-primary/80 focus-visible:ring-[3px] focus-visible:ring-ring/50"
            : "cursor-default text-muted-foreground"
        )}
      >
        {/* Full display — the folder crumb never truncates; the neighbouring
            conversation title takes the ellipsis when the header runs out of
            room (see conversation-detail-header). */}
        <span className="whitespace-nowrap">{headerLabel}</span>
      </button>
    ) : (
      <Button
        variant="ghost"
        size="xs"
        title={title}
        // `px-1.5` (rem scale, so it tracks UI zoom) matches the composer "+"
        // button's icon breathing room; paired with the row's `pl-2` it lands the
        // folder icon on the same column as the centered "+" icon.
        className={cn(
          "min-w-0 gap-0.5 px-1.5",
          !editable && "cursor-default opacity-60 hover:bg-transparent"
        )}
      >
        <Folder className="size-3 shrink-0 text-muted-foreground" />
        <span className="max-w-[8.75rem] truncate">{currentFolderName}</span>
        <ChevronDown className="size-3 shrink-0 text-muted-foreground/60" />
      </Button>
    )

  if (!editable) {
    return trigger
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="start" className="p-0 w-72 overflow-hidden">
        <Command className="rounded-2xl">
          <CommandInput placeholder={labelSearch} />
          <CommandList>
            <CommandEmpty>{labelEmpty}</CommandEmpty>
            <CommandGroup>
              {/* Shared row (alias [ name ] over the path, alias included in the
                  search token) — the Tasks / Automations / Token-usage folder
                  controls render the very same one. */}
              {folders.map((f) => (
                <FolderOptionItem
                  key={f.id}
                  folder={f}
                  selected={f.id === currentFolderId}
                  onSelect={() => {
                    setOpen(false)
                    void onSelect(f.id)
                  }}
                />
              ))}
            </CommandGroup>
            {/* Pinned to the bottom as a sticky footer so the folderless
                "chat mode" entry point stays visible without scrolling past a
                long folder list. `bg-popover` keeps folders from bleeding
                through as they scroll underneath; `forceMount` + a stable,
                plain `value` (no folder name/path) keep it mounted and
                reachable under any search filter. */}
            <div className="sticky bottom-0 bg-popover">
              <CommandSeparator />
              <CommandGroup forceMount>
                <CommandItem
                  value="__chat_mode__ no folder chat mode"
                  forceMount
                  onSelect={() => {
                    setOpen(false)
                    onSelectChatMode()
                  }}
                >
                  <MessageSquare className="h-4 w-4" />
                  <span className="flex-1 truncate font-medium">
                    {labelChatMode}
                  </span>
                  {isChatMode && <Check className="h-4 w-4 shrink-0" />}
                </CommandItem>
              </CommandGroup>
            </div>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
})
