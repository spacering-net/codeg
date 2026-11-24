"use client"

import { memo, useState } from "react"
import { useTranslations } from "next-intl"
import { Check, ChevronDown, Folder } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { SelectorTooltip } from "@/components/chat/selector-tooltip"
import { FolderAliasLabel } from "@/components/conversations/folder-alias-label"
import { cn } from "@/lib/utils"

/** The minimum a folder has to carry to be listed. `alias`/`path` are optional
 *  so a caller can offer a folder it only knows by id (an automation targeting
 *  a folder that is no longer in the workspace, say). */
export interface FolderSelectOption {
  id: number
  name: string
  alias?: string | null
  path?: string | null
}

/**
 * The string cmdk matches the query against. Everything the user might type for
 * a folder goes in — the alias, the real directory name, and the full path — so
 * an aliased folder is still findable by its on-disk name.
 */
function folderSearchValue(f: FolderSelectOption): string {
  return `${f.alias ?? ""} ${f.name} ${f.path ?? ""}`
}

/**
 * One folder row: `alias [ name ]` over its dimmed path, with a trailing check
 * for the current one. Exported so every folder list in the app (the composer's
 * picker, the Tasks / Automations / Token-usage folder controls) renders the
 * same row — the alias never replaces the real folder name, it only leads it.
 */
export const FolderOptionItem = memo(function FolderOptionItem({
  folder,
  selected,
  onSelect,
}: {
  folder: FolderSelectOption
  selected: boolean
  onSelect: () => void
}) {
  return (
    <CommandItem value={folderSearchValue(folder)} onSelect={onSelect}>
      <Folder className="h-4 w-4" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">
          <FolderAliasLabel
            name={folder.name}
            alias={folder.alias ?? null}
            bracketClassName="text-muted-foreground"
          />
        </span>
        {folder.path ? (
          // Paths read LTR even in RTL locales, and the full value survives
          // truncation via the tooltip.
          <span
            dir="ltr"
            title={folder.path}
            className="truncate text-start text-xs text-muted-foreground"
          >
            {folder.path}
          </span>
        ) : null}
      </div>
      {selected ? <Check className="h-4 w-4 shrink-0" /> : null}
    </CommandItem>
  )
})

/** Trigger looks. `"pill"` is the borderless muted filter pill the workbench
 *  toolbars use; `"field"` is the bordered form control the editor dialogs put
 *  in their Target section (metrics copied from `SelectTrigger size="sm"`);
 *  `"ghost"` is the pill with no surface of its own, for a picker sitting
 *  INSIDE another chip — a second fill there reads as a nested control, and
 *  `ws-msg-chip` would draw one whatever the caller sets, since it paints from
 *  an unlayered rule that outranks a utility class. */
type FolderSelectVariant = "pill" | "field" | "ghost"

const TRIGGER_CLASS: Record<FolderSelectVariant, string> = {
  pill: "h-8 w-auto min-w-0 max-w-[14rem] gap-1.5 rounded-full border-transparent bg-muted/70 px-3 text-[0.8125rem] font-medium shadow-none ws-msg-chip hover:bg-muted",
  field:
    "h-7 w-auto min-w-0 max-w-[16rem] gap-1.5 rounded-4xl border-input bg-input/30 px-3 text-xs font-normal hover:bg-input/50 dark:hover:bg-input/50",
  ghost:
    "h-7 w-auto min-w-0 max-w-[14rem] gap-1.5 rounded-full border-transparent px-2.5 text-[0.8125rem] font-medium shadow-none hover:bg-muted dark:hover:bg-muted",
}

interface FolderSelectProps {
  folders: readonly FolderSelectOption[]
  /** The chosen folder id, or `null` for "no choice yet" / "all folders". */
  value: number | null
  onChange: (folderId: number) => void
  /** Supplied by filters: adds a pinned "all folders" row and makes `null` a
   *  real, selectable state. Omit for a picker that must end up on a folder. */
  allLabel?: string
  /** Trigger text while nothing is selected and there is no `allLabel`. */
  placeholder?: string
  /** Called when the pinned "all folders" row is picked. Required with
   *  `allLabel`. */
  onSelectAll?: () => void
  variant?: FolderSelectVariant
  disabled?: boolean
  /** Names the axis in the trigger's hover hint, e.g. "Working folder". Hint
   *  only — the accessible name stays the trigger's own text, so a screen
   *  reader announces WHICH folder is picked rather than just the axis. */
  title?: string
  className?: string
}

/**
 * A searchable folder picker: a compact trigger that opens the same
 * command-palette list the new-conversation composer uses (search box, one row
 * per folder showing `alias [ name ]` over its path, trailing check).
 *
 * It replaces the plain `Select`s that used to show `alias ?? name` — those
 * offered no search (painful past a handful of projects) and, worse, hid the
 * real folder name behind the alias, so two folders aliased alike were
 * indistinguishable.
 */
export function FolderSelect({
  folders,
  value,
  onChange,
  allLabel,
  placeholder,
  onSelectAll,
  variant = "pill",
  disabled = false,
  title,
  className,
}: FolderSelectProps) {
  // Shared with the composer's picker: same control, same two strings — a
  // second copy per page would only drift in translation.
  const t = useTranslations("Folder.conversationContextBar")
  const [open, setOpen] = useState(false)

  const current =
    value != null ? folders.find((f) => f.id === value) : undefined
  // A selection the list can no longer resolve — the folder was closed or
  // removed from the workspace while it was the chosen one. It must NOT read as
  // the null state: the caller is still filtering (or saving) by that id, so
  // showing "all folders" / the placeholder would state the opposite of what
  // the page is doing. Named by the only handle left, its id — the same `#<id>`
  // idiom the Automations list uses for a folder it can only name that way.
  const unresolved = value != null && !current
  const fallbackText = unresolved
    ? `#${value}`
    : (allLabel ?? placeholder ?? "")
  // Hover hint: the axis the caller named ("Working folder"), over the selected
  // folder's path — the one thing the trigger never shows, and the only thing
  // that separates same-named repos. The folder's own name is deliberately NOT
  // repeated: it is the trigger's own text. A filter pill that names no axis
  // and has no selection therefore has nothing to say, and shows no hint.

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (!disabled) setOpen(o)
      }}
    >
      {/* `suppressed` while the list is open: the Popover is non-modal, so the
          trigger keeps taking hover underneath its own panel. `disabled` falls
          the hint back to a native `title` — a disabled trigger takes no
          pointer events, and a pinned folder can't be opened to inspect. */}
      <SelectorTooltip
        label={title}
        description={current?.path}
        suppressed={open}
        disabled={disabled}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant={variant === "field" ? "outline" : "ghost"}
            size="sm"
            disabled={disabled}
            className={cn(TRIGGER_CLASS[variant], className)}
          >
            <Folder
              className="size-3.5 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <span
              className={cn(
                // `flex-1` + `text-start` only bite when a caller stretches the
                // trigger past its content (a fixed-width filter column): the
                // label takes the slack and stays left-aligned with the icon,
                // instead of the whole icon/label/chevron group floating in the
                // middle of the pill. At the default content width there is no
                // slack, so nothing moves.
                "min-w-0 flex-1 truncate text-start",
                !current &&
                  (placeholder || unresolved) &&
                  "text-muted-foreground"
              )}
            >
              {current ? (
                <FolderAliasLabel
                  name={current.name}
                  alias={current.alias ?? null}
                  bracketClassName="text-muted-foreground"
                />
              ) : (
                fallbackText
              )}
            </span>
            <ChevronDown
              className="size-3.5 shrink-0 text-muted-foreground/60"
              aria-hidden="true"
            />
          </Button>
        </PopoverTrigger>
      </SelectorTooltip>
      <PopoverContent align="start" className="w-72 overflow-hidden p-0">
        <Command className="rounded-2xl">
          <CommandInput placeholder={t("searchFolder")} />
          <CommandList>
            <CommandEmpty>{t("noFolders")}</CommandEmpty>
            {allLabel ? (
              // Pinned above the (scrolling) folders as a sticky header:
              // clearing the filter is the one action that must never require
              // scrolling back up. `forceMount` + a stable, plain value (no
              // folder name/path) keep it reachable under any search too.
              <div className="sticky top-0 z-10 bg-popover">
                <CommandGroup forceMount>
                  <CommandItem
                    value="__all_folders__"
                    forceMount
                    onSelect={() => {
                      setOpen(false)
                      onSelectAll?.()
                    }}
                  >
                    <Folder className="h-4 w-4" />
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {allLabel}
                    </span>
                    {value == null ? (
                      <Check className="h-4 w-4 shrink-0" />
                    ) : null}
                  </CommandItem>
                </CommandGroup>
                <CommandSeparator />
              </div>
            ) : null}
            <CommandGroup>
              {folders.map((f) => (
                <FolderOptionItem
                  key={f.id}
                  folder={f}
                  selected={f.id === value}
                  onSelect={() => {
                    setOpen(false)
                    onChange(f.id)
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
