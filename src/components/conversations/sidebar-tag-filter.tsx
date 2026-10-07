"use client"

import { memo, useMemo, useState } from "react"
import { Check, ListFilter, Settings2, X } from "lucide-react"
import { useTranslations } from "next-intl"
import {
  isTagFilterActive,
  tagChipStyle,
  toggleTagInFilter,
  type TagFilter,
  type TagFilterMode,
} from "@/lib/conversation-tags"
import { formatFolderLabelWithAlias } from "@/lib/folder-display"
import type { ConversationTagDetail } from "@/lib/types"
import { cn } from "@/lib/utils"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useConversationTagsStore } from "@/stores/conversation-tags-store"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { ConversationTagChip } from "./conversation-tag-chip"
import { openConversationTagsManager } from "./conversation-tags-manager"

const FOOTER_ITEM_CLASS =
  "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50"

function ModeToggle({
  mode,
  onChange,
}: {
  mode: TagFilterMode
  onChange: (mode: TagFilterMode) => void
}) {
  const t = useTranslations("ConversationTags.filter")
  const options: { value: TagFilterMode; label: string; hint: string }[] = [
    { value: "any", label: t("matchAny"), hint: t("matchAnyHint") },
    { value: "all", label: t("matchAll"), hint: t("matchAllHint") },
  ]
  return (
    <div className="flex items-center gap-2 px-3 pt-2.5 pb-2">
      <span className="text-xs text-muted-foreground">{t("match")}</span>
      <div
        role="radiogroup"
        aria-label={t("match")}
        className="inline-flex rounded-md bg-muted p-0.5"
      >
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={mode === option.value}
            title={option.hint}
            onClick={() => onChange(option.value)}
            className={cn(
              "rounded-[0.3125rem] px-2 py-0.5 text-xs outline-none transition-colors",
              "focus-visible:ring-2 focus-visible:ring-ring",
              mode === option.value
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * The popover body: every tag a conversation the sidebar can show could carry
 * — global ones first, then each folder scope in reach (see `groups`) — each
 * with how many of those conversations carry it. Its footer clears the filter
 * and leads to the tag manager.
 */
function TagFilterPanel({
  filter,
  onChange,
  onManage,
}: {
  filter: TagFilter
  onChange: (filter: TagFilter) => void
  onManage: () => void
}) {
  const t = useTranslations("ConversationTags")
  const [query, setQuery] = useState("")
  const tags = useConversationTagsStore((s) => s.tags)
  const tagsById = useConversationTagsStore((s) => s.tagsById)
  const folders = useAppWorkspaceStore((s) => s.folders)
  const allFolders = useAppWorkspaceStore((s) => s.allFolders)
  const conversations = useAppWorkspaceStore((s) => s.conversations)

  // The conversations the sidebar can actually show: pinned ones wherever they
  // live, chats, and those of open folders (worktrees included). Counting and
  // offering beyond that would promise matches the list cannot produce.
  const reachable = useMemo(() => {
    const open = new Set(folders.map((f) => f.id))
    return conversations.filter(
      (c) => c.pinned_at != null || c.kind === "chat" || open.has(c.folder_id)
    )
  }, [conversations, folders])

  const counts = useMemo(() => {
    const map = new Map<number, number>()
    for (const c of reachable) {
      for (const id of c.tag_ids ?? []) map.set(id, (map.get(id) ?? 0) + 1)
    }
    return map
  }, [reachable])

  const groups = useMemo(() => {
    // Folder scopes worth offering: the ROOT of every open folder — an open
    // worktree's conversations carry its repo's tags even with the repo itself
    // closed — plus any scope a reachable conversation already carries a tag
    // from (a pinned row of a folder since closed, say).
    const scopes = new Set<number>()
    for (const f of folders) scopes.add(f.parent_id ?? f.id)
    for (const c of reachable) {
      for (const id of c.tag_ids ?? []) {
        const owner = tagsById.get(id)?.folder_id
        if (owner != null) scopes.add(owner)
      }
    }
    const global: ConversationTagDetail[] = []
    const byFolder = new Map<number, ConversationTagDetail[]>()
    for (const tag of tags) {
      if (tag.folder_id === null) {
        global.push(tag)
      } else if (scopes.has(tag.folder_id)) {
        const list = byFolder.get(tag.folder_id) ?? []
        list.push(tag)
        byFolder.set(tag.folder_id, list)
      }
    }
    const folderGroups = [...byFolder].map(([folderId, list]) => {
      // `allFolders`, not `folders`: a closed scope is still named properly.
      const folder = allFolders.find((f) => f.id === folderId)
      return {
        key: `folder-${folderId}`,
        label: folder ? formatFolderLabelWithAlias(folder) : `#${folderId}`,
        tags: list,
      }
    })
    folderGroups.sort((a, b) => a.label.localeCompare(b.label))
    return [
      ...(global.length > 0
        ? [{ key: "global", label: t("global"), tags: global }]
        : []),
      ...folderGroups,
    ]
  }, [tags, tagsById, folders, allFolders, reachable, t])

  const needle = query.trim().toLowerCase()
  const visible = groups
    .map((group) => ({
      ...group,
      tags: needle
        ? group.tags.filter((tag) => tag.name.toLowerCase().includes(needle))
        : group.tags,
    }))
    .filter((group) => group.tags.length > 0)
  const selected = new Set(filter.tagIds)

  const manageItem = (
    <button type="button" onClick={onManage} className={FOOTER_ITEM_CLASS}>
      <Settings2 className="size-4 shrink-0" />
      {t("manageTags")}
    </button>
  )

  if (groups.length === 0) {
    return (
      <>
        <p className="px-4 py-6 text-center text-xs text-muted-foreground">
          {t("filter.noTags")}
        </p>
        <div className="border-t p-1">{manageItem}</div>
      </>
    )
  }

  return (
    <>
      <ModeToggle
        mode={filter.mode}
        onChange={(mode) => onChange({ ...filter, mode })}
      />
      <Command className="rounded-none" shouldFilter={false}>
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder={t("filter.searchPlaceholder")}
        />
        <CommandList>
          {visible.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              {t("filter.noResults")}
            </div>
          ) : null}
          {visible.map((group) => (
            <CommandGroup key={group.key} heading={group.label}>
              {group.tags.map((tag) => {
                const checked = selected.has(tag.id)
                return (
                  <CommandItem
                    key={tag.id}
                    value={`filter-tag-${tag.id}`}
                    onSelect={() => onChange(toggleTagInFilter(filter, tag.id))}
                    data-checked={checked || undefined}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded-[0.3125rem] border",
                        checked
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-input"
                      )}
                    >
                      {checked ? <Check className="size-3!" /> : null}
                    </span>
                    <span className="min-w-0 flex-1">
                      <ConversationTagChip tag={tag} className="max-w-full" />
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      {counts.get(tag.id) ?? 0}
                    </span>
                  </CommandItem>
                )
              })}
            </CommandGroup>
          ))}
        </CommandList>
      </Command>
      <div className="border-t p-1">
        <button
          type="button"
          disabled={!isTagFilterActive(filter)}
          onClick={() => onChange({ ...filter, tagIds: [] })}
          className={FOOTER_ITEM_CLASS}
        >
          <X className="size-4 shrink-0" />
          {t("filter.clear")}
        </button>
        {manageItem}
      </div>
    </>
  )
}

/**
 * The sidebar header's tag filter: a funnel (the view-options eye beside it
 * only changes WHAT KIND of rows show; this narrows the list to matches) that
 * lights up and counts the selection while a filter is on.
 */
export const SidebarTagFilterButton = memo(function SidebarTagFilterButton({
  filter,
  onChange,
}: {
  /** Already pruned to tags that exist. */
  filter: TagFilter
  onChange: (filter: TagFilter) => void
}) {
  const t = useTranslations("ConversationTags.filter")
  const [open, setOpen] = useState(false)
  const active = isTagFilterActive(filter)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "relative h-6 w-6 shrink-0",
            active ? "bg-accent text-foreground" : "text-muted-foreground"
          )}
          title={t("button")}
          aria-label={t("button")}
          aria-pressed={active}
        >
          <ListFilter aria-hidden="true" className="h-3.5 w-3.5" />
          {active ? (
            <span
              aria-hidden
              className="absolute -top-0.5 -right-0.5 flex h-3 min-w-3 items-center justify-center rounded-full bg-primary px-0.5 text-[0.5625rem] leading-none font-semibold text-primary-foreground tabular-nums"
            >
              {filter.tagIds.length}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="flex w-72 flex-col gap-0 overflow-hidden p-0"
      >
        <TagFilterPanel
          filter={filter}
          onChange={onChange}
          onManage={() => {
            setOpen(false)
            openConversationTagsManager()
          }}
        />
      </PopoverContent>
    </Popover>
  )
})

/**
 * The strip above the list while a tag filter is on: what it is filtering by
 * (each chip removable on its own), whether it needs any or all of them, and
 * the way out. Without it a persisted filter would greet the next launch as a
 * sidebar that is mysteriously missing conversations.
 */
export const SidebarTagFilterBar = memo(function SidebarTagFilterBar({
  filter,
  onChange,
}: {
  filter: TagFilter
  onChange: (filter: TagFilter) => void
}) {
  const t = useTranslations("ConversationTags.filter")
  const tagsById = useConversationTagsStore((s) => s.tagsById)
  const tags = filter.tagIds
    .map((id) => tagsById.get(id))
    .filter((tag): tag is ConversationTagDetail => tag != null)
  if (tags.length === 0) return null
  return (
    <div
      role="status"
      aria-label={t("active")}
      className="mx-1.5 mb-1.5 flex min-w-0 shrink-0 items-center gap-1.5 rounded-lg border border-border/60 bg-muted/40 py-1 pr-1 pl-2"
    >
      <ListFilter
        aria-hidden
        className="h-3 w-3 shrink-0 text-muted-foreground"
      />
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {tags.map((tag) => (
          // The chip IS the remove button, its × drawn inside in the chip's
          // own text colour, so the pair reads as one object in either theme.
          <button
            key={tag.id}
            type="button"
            onClick={() => onChange(toggleTagInFilter(filter, tag.id))}
            title={tag.name}
            aria-label={t("remove", { name: tag.name })}
            style={tagChipStyle(tag.color)}
            className={cn(
              "forge-label group/chip inline-flex h-[0.9375rem] max-w-[8rem] min-w-0 items-center gap-[0.125rem] rounded-full border pr-[0.1875rem] pl-[0.3125rem]",
              "text-[0.625rem] leading-none font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
            )}
          >
            <span className="min-w-0 truncate">{tag.name}</span>
            <X
              aria-hidden
              className="h-2.5 w-2.5 shrink-0 opacity-70 group-hover/chip:opacity-100"
            />
          </button>
        ))}
        {tags.length > 1 ? (
          <span className="text-[0.625rem] whitespace-nowrap text-muted-foreground">
            {filter.mode === "all" ? t("modeAll") : t("modeAny")}
          </span>
        ) : null}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-5 w-5 shrink-0 text-muted-foreground"
        onClick={() => onChange({ ...filter, tagIds: [] })}
        title={t("clear")}
        aria-label={t("clear")}
      >
        <X className="h-3 w-3" />
      </Button>
    </div>
  )
})
