"use client"

import {
  memo,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react"
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
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu"
import { ConversationTagChip } from "./conversation-tag-chip"
import { openConversationTagsManager } from "./conversation-tags-manager"

const FOOTER_ITEM_CLASS =
  "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50"

// The panel's keyboard stops, in DOM order: the match toggle, the search box
// and the footer actions. Tag rows are not among them — the search box walks
// those (cmdk) — so Tab moves between controls, never tag by tag.
const PANEL_TAB_STOPS = "button:not(:disabled), input:not(:disabled)"

// How many tags are picked, at the trailing edge of the "Filter by tags" row,
// so an open menu says a filter is on before its submenu does. Same chip as
// the sidebar's To-dos attention count.
const COUNT_CHIP_CLASS = cn(
  "inline-flex h-[0.9375rem] min-w-[0.9375rem] shrink-0 items-center justify-center",
  "rounded-full bg-primary/10 px-1",
  "font-mono text-[0.625rem] font-medium leading-none tabular-nums text-primary"
)

/**
 * One Tab step through the panel's controls in document order, wrapping at
 * either end — what Tab did natively in the popover. Focus can also sit
 * between controls (on the tag list after a press on a row) or around them
 * (the panel element itself): Tab then goes to the next control after it
 * and Shift+Tab to the last one before it.
 */
function stepPanelTabStop(panel: HTMLElement | null, backwards: boolean) {
  const stops = panel
    ? Array.from(panel.querySelectorAll<HTMLElement>(PANEL_TAB_STOPS))
    : []
  if (stops.length === 0) return
  const current = document.activeElement
  const follows = (stop: HTMLElement) =>
    !current ||
    (current.compareDocumentPosition(stop) &
      Node.DOCUMENT_POSITION_FOLLOWING) !==
      0
  const next = backwards
    ? ([...stops]
        .reverse()
        .find((stop) => stop !== current && !follows(stop)) ??
      stops[stops.length - 1])
    : (stops.find(follows) ?? stops[0])
  next.focus()
}

/**
 * Radix reads ← (→ in a right-to-left layout) anywhere inside a submenu as
 * "back to the parent menu", and handles it on the submenu element after
 * anything passed to that element — so only a descendant can keep the key
 * from it. A search box with text to move through keeps it; an empty box
 * lets it go back. Every other key passes through untouched: the panel holds
 * no menu items, so the menu's type-ahead has nothing to jump to.
 */
function keepArrowsInSearchBox(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
  const target = event.target
  if (
    target instanceof HTMLInputElement &&
    (target.value !== "" || event.nativeEvent.isComposing)
  ) {
    event.stopPropagation()
  }
}

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
 * The submenu body: every tag a conversation the sidebar can show could carry
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
  const searchRef = useRef<HTMLInputElement>(null)
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
          ref={searchRef}
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
                    // The box beside the chip is drawn, not announced, and
                    // cmdk's own `aria-selected` is the keyboard highlight:
                    // this is what tells assistive tech a tag is picked.
                    aria-checked={checked}
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
          onClick={(event) => {
            onChange({ ...filter, tagIds: [] })
            // Clearing disables this very button, and a browser drops the
            // focus of a control that turns disabled onto the page — out of
            // the menu. Pressed from the keyboard (a click with no pointer
            // behind it, `detail` 0), focus moves on to the search box
            // first. A pointer press leaves focus alone: no touch keyboard.
            if (event.detail === 0) searchRef.current?.focus()
          }}
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
 * "Filter by tags" in the sidebar's view-options menu: a submenu row (the
 * funnel, plus how many tags are picked while a filter is on) opening onto the
 * tag filter panel. It used to be a header button of its own; it lives with
 * the menu's other choices about what the list shows.
 *
 * What opens is a panel, not a menu (hence `role="dialog"`, as it was when a
 * popover): the match toggle, a search box over the tag rows (cmdk) and two
 * footer actions, none of them menu items. The menu's key handling assumes
 * nothing but items, so the panel keeps it out: Tab walks the panel's controls
 * (Radix would swallow it) and ← / → stay with a search box that has text
 * (`keepArrowsInSearchBox`). Opening it from the keyboard, Radix focuses the
 * panel element itself, from which nothing is one arrow away, so that focus is
 * handed on to the search box (with no tags yet, to the first control). A
 * press on the panel's padding focuses the panel element too and is left
 * there, so a tap never throws up a touch keyboard; Tab still steps in from
 * it. Opening it by pointer leaves focus where it was, as with every submenu.
 */
export const SidebarTagFilterSubmenu = memo(function SidebarTagFilterSubmenu({
  filter,
  onChange,
  onCloseMenu,
}: {
  /** Already pruned to tags that exist. */
  filter: TagFilter
  onChange: (filter: TagFilter) => void
  /** Close the whole menu this row is in: the manage entry leaves it for a
   *  dialog. */
  onCloseMenu: () => void
}) {
  const t = useTranslations("ConversationTags.filter")
  const activeId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  // True only for the rest of the task a press starts in: the focus a press
  // moves is its mousedown's default action, run in that same task. What
  // tells a press on the panel's padding from a keyboard entry (both focus
  // the panel element itself), with nothing left behind by a press that
  // moves no focus or is released outside the panel.
  const pressRef = useRef(false)
  const label = t("button")
  const active = isTagFilterActive(filter)
  return (
    <DropdownMenuSub>
      {/* `textValue`: type-ahead in the menu matches the label, not the
          label with the count run into it. The description is the old
          header button's pressed state: the count chip is only drawn. */}
      <DropdownMenuSubTrigger
        textValue={label}
        aria-haspopup="dialog"
        aria-describedby={active ? activeId : undefined}
      >
        <ListFilter className="text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {active ? (
          <>
            <span aria-hidden className={COUNT_CHIP_CLASS}>
              {filter.tagIds.length}
            </span>
            <span id={activeId} hidden>
              {t("active")}
            </span>
          </>
        ) : null}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        role="dialog"
        aria-orientation={undefined}
        className="flex w-72 flex-col gap-0 p-0"
        onMouseDown={() => {
          pressRef.current = true
          window.setTimeout(() => {
            pressRef.current = false
          }, 0)
        }}
        onFocus={(event) => {
          if (pressRef.current || event.target !== event.currentTarget) return
          const panel = panelRef.current
          const entry =
            panel?.querySelector<HTMLElement>("input") ??
            panel?.querySelector<HTMLElement>(PANEL_TAB_STOPS)
          entry?.focus()
        }}
        onKeyDown={(event) => {
          // Runs ahead of Radix's own key handling on this element, which
          // skips an event already prevented — so a Tab never reaches the
          // menu's "no Tab in menus" rule. Handled here rather than inside
          // the panel so it also works with focus on the panel element itself.
          if (event.key !== "Tab") return
          if (event.altKey || event.ctrlKey || event.metaKey) return
          event.preventDefault()
          stepPanelTabStop(panelRef.current, event.shiftKey)
        }}
      >
        <div
          ref={panelRef}
          onKeyDown={keepArrowsInSearchBox}
          className="flex flex-col"
        >
          <TagFilterPanel
            filter={filter}
            onChange={onChange}
            onManage={() => {
              onCloseMenu()
              openConversationTagsManager()
            }}
          />
        </div>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
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
