"use client"

import { memo, useCallback, useState } from "react"
import {
  ChevronRight,
  FolderGit2,
  FolderOpenDot,
  Layers,
  MoreHorizontal,
  Palette,
  Pencil,
  Trash2,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { useImeGuard } from "@/hooks/use-ime-guard"
import {
  FOLDER_THEME_COLOR_INHERIT,
  THEME_COLOR_PREVIEW,
  THEME_COLORS,
  folderTitleTintVars,
  type FolderThemeColor,
  type ThemeColor,
} from "@/lib/theme-presets"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { SubsessionAncestorRails } from "./sidebar-conversation-card"

/**
 * Heading row for one folder GROUP inside the sidebar's "Folders" section.
 *
 * Geometry is deliberately the folder header's, not the section header's: a
 * group sits at the same top-level indent as an ungrouped folder and the two
 * interleave in one list, so they have to read as siblings. Same `h-[2rem]`
 * outer box (virtua's fixed item size), same rounded-full hover pill, same
 * rail-axis glyph, same hover-revealed trailing `⋯` — and, past geometry, the
 * same title type (size, weight and colour) and the same running-sessions
 * badge. The one thing that sets a group apart is its glyph: Layers, not a
 * folder. Past the `⋯` it carries the Folders heading's own "add a folder" pair
 * — Clone Repository, then Open Folder — scoped to this group.
 *
 * Owns its own `useTranslations` rather than receiving `t`: next-intl returns a
 * fresh `t` on every parent render, so a `t` prop would defeat this component's
 * memo and re-render every group heading on each status event.
 */
export const SidebarFolderGroupHeader = memo(function SidebarFolderGroupHeader({
  groupId,
  name,
  runningCount,
  expanded,
  onToggle,
  onRename,
  onChangeColor,
  onDelete,
  onOpenFolder,
  onCloneRepository,
  themeColor,
  appThemeColor,
  isDragging,
  onGripPointerDown,
  presentation = false,
}: {
  groupId: number
  name: string
  /**
   * How many sessions are currently RUNNING (`in_progress`) across every folder
   * in the group — the folder header's badge, one level up, and zero renders no
   * badge at all. Deliberately not "how many folders it holds": that number was
   * a different question asked in the same slot as the folder rows' live-activity
   * badge, and the rows under an open group already answer it.
   */
  runningCount: number
  expanded: boolean
  onToggle?: (groupId: number) => void
  onRename?: (groupId: number, name: string) => void
  onChangeColor?: (groupId: number, color: FolderThemeColor) => void
  onDelete?: (groupId: number) => void
  /**
   * The Folders heading's Open Folder / Clone Repository actions, scoped to
   * this group: the caller lands whatever folder they open INSIDE it. Each
   * renders as a hover-revealed button only when provided, and never on the
   * presentation copy. Must be referentially stable to preserve the memo.
   */
  onOpenFolder?: (groupId: number) => void
  onCloneRepository?: (groupId: number) => void
  themeColor: FolderThemeColor
  appThemeColor: ThemeColor
  isDragging?: boolean
  /**
   * Starts a reorder gesture from the row. Omitted on the drag surface (already
   * dragging), where headings are pure drop-target visuals.
   */
  onGripPointerDown?: (groupId: number, event: React.PointerEvent) => void
  /**
   * Render as a non-interactive copy: no context menu, no trailing `⋯`, no
   * rename dialog. Used by the drag surface, whose rows are pure drop-target
   * visuals — a live context menu there could open mid-gesture, and duplicate
   * dialogs would be mounted for every group at once.
   */
  presentation?: boolean
}) {
  const t = useTranslations("Folder.sidebar")
  const tCommon = useTranslations("Folder.common")
  // The "add a folder" pair reuses the Folders heading's strings (which are the
  // top-of-page dropdown's), so the same action reads the same everywhere.
  const tDropdown = useTranslations("Folder.folderNameDropdown")
  const ime = useImeGuard()

  // Controlled dialog rendered as a SIBLING of the ContextMenu, never a child:
  // the menu unmounts its content on select, which would take a nested dialog
  // with it. Same shape as the folder header's alias dialog.
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameValue, setRenameValue] = useState("")
  const openRename = useCallback(() => {
    setRenameValue(name)
    setRenameOpen(true)
  }, [name])
  const confirmRename = useCallback(() => {
    const trimmed = renameValue.trim()
    // An all-whitespace name would render as an invisible band; the backend
    // rejects it too, so don't even send it — just close.
    if (trimmed && trimmed !== name) onRename?.(groupId, trimmed)
    setRenameOpen(false)
  }, [renameValue, name, groupId, onRename])

  // The group's chosen colour paints its TITLE and nothing else — same contract
  // as a folder's (see `folderTitleTintVars`); undefined for `inherit`.
  const titleTint = folderTitleTintVars(themeColor)

  // One look for every trailing action, the folder row's: hover-revealed (and
  // kept on keyboard focus and on touch, which has no hover), /90 at rest to
  // clear 3:1 non-text contrast, full foreground on hover. justify-end flushes
  // each 14px glyph to its box's right edge, so the glyphs — not the transparent
  // boxes — keep the list's shared right-edge rhythm.
  const trailingActionClassName = cn(
    "flex h-6 w-6 shrink-0 items-center justify-end",
    "rounded-[0.375rem] cursor-pointer outline-none text-muted-foreground/90",
    "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100",
    "transition-[opacity,color] duration-150 hover:text-sidebar-foreground"
  )

  const row = (
    <div className={cn("relative h-[2rem]", isDragging && "opacity-60")}>
      <div
        onPointerDown={(e) => onGripPointerDown?.(groupId, e)}
        className={cn(
          "group flex h-[1.9375rem] w-full items-center",
          "rounded-full",
          "transition-colors duration-150",
          isDragging
            ? "cursor-grabbing"
            : "cursor-grab hover:bg-[color-mix(in_oklab,var(--sidebar-accent),var(--sidebar-foreground)_2%)]"
        )}
      >
        <button
          data-folder-group-id={groupId}
          onClick={() => onToggle?.(groupId)}
          aria-expanded={expanded}
          className={cn(
            "relative flex h-full min-w-0 flex-1 items-center pr-[0.5rem] outline-none",
            "rounded-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
            "text-sidebar-foreground",
            isDragging ? "cursor-grabbing" : "cursor-grab"
          )}
          style={{
            paddingLeft: "calc(var(--conv-rail-axis) + 0.875rem)",
          }}
        >
          {/* Depth 0 — a group is always top level, so no ancestor rail.
                    Rendered anyway so the row's box model matches the folder
                    header's exactly and the two never drift by a pixel. */}
          <SubsessionAncestorRails depth={0} />
          <span
            aria-hidden
            className="pointer-events-none absolute flex items-center justify-center text-muted-foreground/75"
            style={{
              top: "50%",
              left: "var(--conv-rail-axis)",
              width: "0.875rem",
              height: "0.875rem",
              transform: "translate(-50%, -50%)",
            }}
          >
            {/* Layers, not a folder glyph: a group is a layer OVER folders, and
                at 14px the stacked-sheets outline is the one shape that reads
                as "container of the folders below" rather than "one more
                folder" beside `FolderOpen`/`FolderClosed`. */}
            <Layers className="h-[0.875rem] w-[0.875rem]" />
          </span>
          <div className="flex min-w-0 flex-1 items-center gap-[0.5rem]">
            {/* Typographically identical to a folder title — same size, same
                      `normal` weight, same colour (`/75`, or the chosen tint) —
                      so the two read as siblings in one column. What marks a
                      group as the container of the rows under it is the Layers
                      glyph and the indent beneath it, not a heavier title. */}
            <span
              style={titleTint}
              className={cn(
                "min-w-0 flex-shrink truncate text-left text-[0.875rem] font-normal",
                titleTint ? "folder-title-tint" : "text-sidebar-foreground/75"
              )}
            >
              {name}
            </span>
            {/* Live-activity badge, byte-identical to the folder header's: the
                      number of RUNNING sessions anywhere in the group, amber to
                      match the spinner on the cards, and nothing at all when
                      none are. A collapsed group is exactly when this is the
                      only way to see that work is under way in there. */}
            {runningCount > 0 && (
              <span
                title={t("runningCountBadge", { count: runningCount })}
                className={cn(
                  "inline-flex shrink-0 items-center justify-center",
                  "h-[0.9375rem] min-w-[1rem] rounded-[0.3125rem] px-[0.25rem]",
                  "text-[0.625rem] font-semibold leading-none tabular-nums",
                  "bg-amber-500/12 text-amber-700",
                  "dark:bg-amber-400/15 dark:text-amber-300"
                )}
              >
                <span aria-hidden>{runningCount}</span>
                <span className="sr-only">
                  {t("runningCountBadge", { count: runningCount })}
                </span>
              </span>
            )}
            {/* Same hover-revealed disclosure chevron as the folder
                      header, including `group-focus-within` (focus lands on a
                      child button, not on the `group` element itself). */}
            <ChevronRight
              aria-hidden
              className={cn(
                "h-3 w-3 shrink-0 text-muted-foreground/60",
                "transition-[transform,opacity] duration-200 ease-out",
                "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
                "[@media(hover:none)]:opacity-100",
                expanded && "rotate-90"
              )}
            />
          </div>
        </button>
        {!presentation && (
          // The trailing cluster. `⋯` leads it, as it leads a folder row's, and
          // the "add a folder" pair follows in the Folders heading's own order —
          // Clone Repository, then Open Folder flush right — so the same two
          // glyphs stack in one column under the heading's. The CLUSTER carries
          // the right-edge margin (0.375rem + the list's px-1.5 = the uniform
          // 0.75rem inset), so the inset holds whichever actions are present,
          // and the heading's `gap-px`, so both glyphs land on the heading's
          // to the pixel. Every button is a sibling of the toggle, so none of
          // them ever collapses or expands the group.
          <div className="mr-[0.375rem] flex shrink-0 items-center gap-px">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                // Re-open the SAME context menu as right-click rather than
                // duplicating its items (single source of truth). The
                // synthetic event bubbles to the enclosing trigger, which
                // Radix opens at these coords.
                const rect = e.currentTarget.getBoundingClientRect()
                e.currentTarget.dispatchEvent(
                  new MouseEvent("contextmenu", {
                    bubbles: true,
                    cancelable: true,
                    button: 2,
                    clientX: rect.left,
                    clientY: rect.bottom,
                  })
                )
              }}
              title={t("moreOptions")}
              aria-label={t("moreOptions")}
              aria-haspopup="menu"
              className={trailingActionClassName}
            >
              <MoreHorizontal className="h-[0.875rem] w-[0.875rem]" />
            </button>
            {onCloneRepository != null && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onCloneRepository(groupId)
                }}
                title={tDropdown("cloneRepository")}
                aria-label={tDropdown("cloneRepository")}
                className={trailingActionClassName}
              >
                <FolderGit2 className="h-[0.875rem] w-[0.875rem]" />
              </button>
            )}
            {onOpenFolder != null && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onOpenFolder(groupId)
                }}
                title={tDropdown("openFolder")}
                aria-label={tDropdown("openFolder")}
                className={trailingActionClassName}
              >
                <FolderOpenDot className="h-[0.875rem] w-[0.875rem]" />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )

  // Presentation copy (the drag surface): the row only, with no menu, dialog or
  // trailing action — those belong to the real list, and mounting one per group
  // during a drag would be both wasteful and openable mid-gesture.
  if (presentation) return row

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={openRename}>
            <Pencil className="h-4 w-4" />
            {t("folderGroup.rename")}
          </ContextMenuItem>
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Palette className="h-4 w-4" />
              {t("folderHeaderMenu.changeColor")}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="min-w-[12rem] p-2">
              <ContextMenuItem
                onSelect={() =>
                  onChangeColor?.(groupId, FOLDER_THEME_COLOR_INHERIT)
                }
                className="gap-2"
              >
                <span
                  aria-hidden
                  className="h-[1.125rem] w-[1.125rem] shrink-0 rounded-[0.25rem] border border-border"
                  style={{
                    backgroundColor: THEME_COLOR_PREVIEW[appThemeColor],
                  }}
                />
                <span className="min-w-0 flex-1 truncate">
                  {t("folderHeaderMenu.useThemeColor")}
                </span>
              </ContextMenuItem>
              <ContextMenuSeparator />
              <div className="grid grid-cols-6 gap-1">
                {THEME_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    title={color}
                    aria-label={color}
                    onClick={() => onChangeColor?.(groupId, color)}
                    className={cn(
                      "h-[1.125rem] w-[1.125rem] cursor-pointer rounded-[0.25rem]",
                      "outline-none ring-offset-1 ring-offset-popover",
                      "transition-[box-shadow,transform] duration-100 hover:scale-110",
                      color === themeColor && "ring-2 ring-foreground/60"
                    )}
                    style={{ backgroundColor: THEME_COLOR_PREVIEW[color] }}
                  />
                ))}
              </div>
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuSeparator />
          <ContextMenuItem
            variant="destructive"
            onSelect={() => onDelete?.(groupId)}
          >
            <Trash2 className="h-4 w-4" />
            {t("folderGroup.delete")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="sm:max-w-[24rem]">
          <DialogHeader>
            <DialogTitle>{t("folderGroup.renameTitle")}</DialogTitle>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            {...ime.props}
            onKeyDown={(e) => {
              // Enter must not commit mid-composition — that is how an IME's
              // candidate-selection Enter would submit a half-typed name.
              if (ime.isComposing(e)) return
              if (e.key === "Enter") confirmRename()
            }}
            placeholder={t("folderGroup.namePlaceholder")}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>
              {tCommon("cancel")}
            </Button>
            <Button onClick={confirmRename}>{tCommon("confirm")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
})
