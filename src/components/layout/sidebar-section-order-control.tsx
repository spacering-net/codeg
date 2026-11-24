"use client"

import { useEffect, useRef } from "react"
import { ChevronDown, ChevronUp, EyeOff } from "lucide-react"
import { useTranslations } from "next-intl"
import { DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { useIsMac } from "@/hooks/use-is-mac"
import type {
  SidebarSectionId,
  SidebarSectionOrder,
} from "@/lib/sidebar-view-mode-storage"
import { cn } from "@/lib/utils"

// Position chip at the row's leading edge. Same geometry/palette as the sidebar
// shortcut hints and the folder count badge, so the numbers read as part of the
// existing chip family rather than a new widget.
const POSITION_CHIP_CLASS = cn(
  "inline-flex h-[0.9375rem] min-w-[0.9375rem] shrink-0 items-center justify-center",
  "rounded-[0.3125rem] bg-primary/10 px-[0.25rem]",
  "font-mono text-[0.625rem] font-medium leading-none tabular-nums text-primary"
)

// Trailing move buttons. Nested inside the menu item (never a menu item of
// their own): Radix's roving focus only visits registered items, so a second
// tier of items here would make arrow-key navigation walk six stops instead of
// three. Keyboard users move a section with Alt+↑/↓ on the focused row instead
// — Radix's roving focus explicitly ignores modified arrows, so the two never
// collide. `size-3.5` (not h-/w-) opts out of the menu's `svg → size-4` rule.
const MOVE_BUTTON_CLASS = cn(
  "flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-[0.375rem]",
  "text-muted-foreground outline-none",
  "transition-colors duration-150 hover:bg-foreground/10 hover:text-foreground",
  "disabled:pointer-events-none disabled:opacity-25"
)

/**
 * The "Section order" block of the sidebar's view-options menu: one row per
 * reorderable section, in their current top-to-bottom order, each with move
 * up / move down affordances.
 *
 * Replaces the old two-value "Folders on top / Chat on top" radio pair, which
 * could only express one bit and did not survive the arrival of a third
 * section. Rows are `DropdownMenuItem`s (so the menu's roving focus, typeahead
 * and hover styling all keep working) with `onSelect` prevented — reordering
 * several sections in a row must not slam the menu shut after the first move.
 *
 * `hiddenSections` dims the sections currently switched off (today only
 * "Recent"). They stay listed and stay reorderable: hiding is a separate
 * preference, so a hidden section keeps the slot it will reappear in.
 */
export function SidebarSectionOrderControl({
  order,
  onMove,
  hiddenSections,
}: {
  order: SidebarSectionOrder
  /** Move `id` by `delta` slots (negative = up). The caller clamps at the
   *  ends — this component only disables the buttons that would no-op. */
  onMove: (id: SidebarSectionId, delta: number) => void
  hiddenSections?: ReadonlySet<SidebarSectionId>
}) {
  const t = useTranslations("Folder.sidebar")
  const isMac = useIsMac()
  const rowRefs = useRef(new Map<SidebarSectionId, HTMLDivElement | null>())
  // Set just before a keyboard-driven move so focus can be restored onto the
  // row after it changes slots. React reorders the keyed nodes rather than
  // recreating them, but moving the focused element in the DOM is not
  // guaranteed to preserve focus, and losing it mid-reorder would strand a
  // keyboard user outside the menu's roving focus.
  const pendingFocusRef = useRef<SidebarSectionId | null>(null)

  useEffect(() => {
    const pending = pendingFocusRef.current
    if (!pending) return
    pendingFocusRef.current = null
    rowRefs.current.get(pending)?.focus()
  }, [order])

  const label = (id: SidebarSectionId) =>
    id === "assistants"
      ? t("sectionAssistants")
      : id === "folders"
        ? t("sectionFolders")
        : id === "chats"
          ? t("sectionChats")
          : t("sectionRecent")

  const move = (id: SidebarSectionId, delta: number, viaKeyboard: boolean) => {
    if (viaKeyboard) pendingFocusRef.current = id
    onMove(id, delta)
  }

  return (
    <>
      {order.map((id, index) => {
        const first = index === 0
        const last = index === order.length - 1
        const hidden = hiddenSections?.has(id) ?? false
        const name = label(id)
        return (
          <DropdownMenuItem
            key={id}
            ref={(node) => {
              rowRefs.current.set(id, node)
            }}
            // Keep the menu open: reordering is an iterative action, and a menu
            // that closes on every nudge would force a reopen per slot.
            onSelect={(event) => event.preventDefault()}
            onKeyDown={(event) => {
              if (!event.altKey) return
              if (event.ctrlKey || event.metaKey || event.shiftKey) return
              if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
              const delta = event.key === "ArrowUp" ? -1 : 1
              if ((delta < 0 && first) || (delta > 0 && last)) return
              // Radix composes handlers with a defaultPrevented check, so this
              // also stops the row's own select/roving-focus handling.
              event.preventDefault()
              move(id, delta, true)
            }}
            // The visible row is a chip + a name + two icon buttons; spell the
            // whole thing out for assistive tech, including the slot it holds.
            aria-label={t("sectionOrderItemLabel", {
              name,
              position: index + 1,
              total: order.length,
            })}
            aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
            className={cn("gap-2 py-1.5", hidden && "opacity-50")}
          >
            <span aria-hidden className={POSITION_CHIP_CLASS}>
              {index + 1}
            </span>
            <span aria-hidden className="min-w-0 flex-1 truncate">
              {name}
            </span>
            {hidden && (
              <EyeOff
                aria-hidden
                className="size-3.5 shrink-0 text-muted-foreground"
              />
            )}
            <span className="flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                disabled={first}
                // Siblings inside the item, so a click would otherwise bubble
                // into the item's own select handling.
                onClick={(event) => {
                  event.stopPropagation()
                  move(id, -1, false)
                }}
                title={t("sectionOrderMoveUp")}
                aria-label={`${name} — ${t("sectionOrderMoveUp")}`}
                className={MOVE_BUTTON_CLASS}
              >
                <ChevronUp className="size-3.5" />
              </button>
              <button
                type="button"
                disabled={last}
                onClick={(event) => {
                  event.stopPropagation()
                  move(id, 1, false)
                }}
                title={t("sectionOrderMoveDown")}
                aria-label={`${name} — ${t("sectionOrderMoveDown")}`}
                className={MOVE_BUTTON_CLASS}
              >
                <ChevronDown className="size-3.5" />
              </button>
            </span>
          </DropdownMenuItem>
        )
      })}
      {/* Keyboard affordance for the move buttons, which the menu's roving
          focus cannot reach. One shared line rather than per-row noise, and
          right-aligned so it sits directly under the ↑/↓ column it explains
          (the item's px-3 puts both on the same right edge). */}
      <p className="px-3 pt-0.5 pb-1 text-right font-mono text-[0.625rem] leading-none text-muted-foreground/70">
        {isMac ? "⌥↑ / ⌥↓" : "Alt+↑ / Alt+↓"}
      </p>
    </>
  )
}
