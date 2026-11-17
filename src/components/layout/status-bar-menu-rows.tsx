"use client"

/**
 * The rows of the status bar's one menu (`status-bar-srn.tsx`): the SRN
 * account's and the quick actions' (`quick-actions-menu.tsx`) alike, so the
 * whole menu keeps to one grid, set by the account's head.
 *
 * The grid, in the content's padding box: a glyph column as wide as the
 * head's 32px avatar (10–42px), then 8px, then the label edge (50px). A row's
 * icon is 18px: the app's usual 16px looked lost beside the avatar, and
 * anything near its size would compete with it. Centred in that column
 * (17–35px, `ps-4.25`), every icon sits on the avatar's axis, and a 15px gap
 * puts its label on the head's text edge. The avatar is about as tall as the
 * ink of the two lines beside it, which keeps that gap a natural one: a 36px
 * avatar needed 18px, a 40px one 23px. Trailing marks — counts, the ↗ of a
 * page in the browser, a submenu's › — end on one edge (`pe-3`), and need no
 * more than 12px from a label, which may run on into the rest of the gap.
 * Labels are a step above the app's 14px menu text, so they hold their own
 * beside those icons (see {@link MENU_TEXT}). Dropdown rows elsewhere in the
 * app keep the shared, tighter look; these classes are this menu's alone.
 */

import {
  useCallback,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react"
import { ArrowUpRight, ChevronRight } from "lucide-react"
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui"

import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

/** The head's avatar — or the ring in its place — which sets the grid. */
export const MENU_AVATAR = "size-8"

/** The head's own padding and gap: its avatar starts the glyph column, as
 *  far in from the head's lit edge as from its top and bottom (10px), and
 *  the gap after it reaches the label edge. */
export const MENU_HEAD_GRID = "gap-2 py-1.75 ps-2.5 pe-3"

/** The leading icon's box, and the start padding and gap that put it on the
 *  avatar's axis and its words on the label edge. For the notes under the
 *  head, which are not rows but keep to the same column. The stroke is
 *  thinned in step with the size, so its weight stays the app's 16px one. */
export const MENU_ICON_COLUMN = "gap-3.75 ps-4.25"
export const MENU_ICON = "size-4.5 stroke-[1.78]"

/** A row's words: 15px, which balances the 18px icons where the app's 14px
 *  looked slight beside them, on a 20px line that keeps a row 36px tall. In
 *  rem, so the app's zoom takes them with the menu's width. */
export const MENU_TEXT = "text-[0.9375rem] leading-5"
/** The quieter words under and around the head — the line under the name,
 *  the notes and their links: half a pixel up with the labels, so they keep
 *  their place beside them, and still well below them. */
export const MENU_SMALL_TEXT = "text-[0.78125rem] leading-4"

/** A row on the grid. Its leading icon is muted, as in the picture the menu
 *  follows; `:where` keeps that below the item's focus colour, which still
 *  takes the icon with the label. Its size beats the shared item's 16px
 *  (`[&_svg:not([class*='size-'])]`) by one more pseudo-class, and leaves an
 *  icon that names its own size alone. */
const MENU_ROW_GRID = `min-h-9 pe-3 ${MENU_TEXT} ${MENU_ICON_COLUMN} [&>:where(svg:first-child)]:text-muted-foreground [&>svg:first-child:not([class*='size-'])]:size-4.5 [&>svg:first-child:not([class*='size-'])]:stroke-[1.78]`

/** A label with a mark after it: 12px clear of the mark rather than the
 *  icon's 15px, which the longest labels need (the remote workspaces'). */
const LABEL_BEFORE_MARK = "-me-0.75"

/** The submenu row's look: the shared item's, with an open state, which the
 *  shared sub-trigger has but this one is drawn without. */
const SUB_TRIGGER_CLASS =
  "relative flex cursor-default items-center rounded-xl py-2 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground data-open:bg-accent data-open:text-accent-foreground data-open:**:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"

/**
 * A menu with a submenu open over it ({@link MenuSub}, on a narrow window)
 * fades its other rows, so the submenu reads as the layer in front and the
 * rows it half covers do not compete with it. Its own row stays lit.
 */
export const MENU_FADES_UNDER_SUBMENU =
  "[&:has(>[data-over][data-state=open])>*:not([data-state=open])]:opacity-30 *:transition-opacity"

/**
 * One row of the menu: a muted icon on the glyph column's axis, the label on
 * the label edge, and an optional mark at the end.
 */
export function MenuRow({
  icon,
  label,
  trailing,
  className,
  ...props
}: Omit<ComponentProps<typeof DropdownMenuItem>, "children"> & {
  icon: ReactNode
  label: ReactNode
  trailing?: ReactNode
}) {
  return (
    <DropdownMenuItem className={cn(MENU_ROW_GRID, className)} {...props}>
      {icon}
      <span
        className={cn("min-w-0 flex-1 truncate", trailing && LABEL_BEFORE_MARK)}
      >
        {label}
      </span>
      {trailing}
    </DropdownMenuItem>
  )
}

/** The ↗ of a page in the browser. Its arrow is drawn inside its box; the
 *  negative margin puts the stroke itself on the end edge the counts end
 *  on. */
export function ExternalMark({ className }: { className?: string }) {
  return (
    <ArrowUpRight
      aria-hidden="true"
      className={cn(
        "-me-1 size-3.5 text-muted-foreground rtl:-scale-x-100",
        className
      )}
    />
  )
}

/** The submenu's ›, mirrored for right-to-left, its stroke on the same end
 *  edge. */
function SubmenuMark() {
  return (
    <ChevronRight
      aria-hidden="true"
      className="-me-1.5 size-4 text-muted-foreground rtl:-scale-x-100"
    />
  )
}

/** Beside its menu, a submenu starts this far out from the menu's edge (its
 *  `sideOffset` from its row, less the menu's padding), and keeps
 *  {@link COLLISION_PADDING_PX} from the window's edge. */
const BESIDE_GAP_PX = 4
const COLLISION_PADDING_PX = 8
/** Where it opens over its menu instead: this far in from the menu's start
 *  edge, so the menu still shows at its side. */
const OVER_INSET_PX = 16

type SubmenuPlacement =
  | { over: false }
  | { over: true; sideOffset: number; alignOffset: number; width: number }

/**
 * Where a submenu opens. Beside its menu where the window has room, as
 * usual. On a window too narrow for that — a phone, a narrow desktop window
 * — Radix would push it off screen (it only moves a submenu up and down,
 * never sideways), so there it opens over its own menu instead: as wide as
 * the menu, a little in from its start edge, and right above its own row,
 * which stays in view and lit. No gap between the two: a pointer going up
 * from the row to the submenu must not cross the rows behind it, which would
 * take it for a move to them.
 *
 * "Room" is at least the width it would have over the menu, which every
 * label is worded to fit: with less, beside would hold it to the room there
 * is and cut its labels short.
 *
 * Measured as the submenu opens. Radix places a submenu against its row,
 * which sits inside the menu's padding, so the offsets are taken from the
 * row; the room, from the menu.
 */
function useSubmenuPlacement() {
  const triggerRef = useRef<HTMLDivElement>(null)
  const [placement, setPlacement] = useState<SubmenuPlacement>({
    over: false,
  })

  const measure = useCallback(() => {
    const trigger = triggerRef.current
    const menu = trigger?.closest<HTMLElement>("[role=menu]")
    if (!trigger || !menu) return
    const box = menu.getBoundingClientRect()
    const row = trigger.getBoundingClientRect()
    const rtl = getComputedStyle(menu).direction === "rtl"
    const room = rtl ? box.left : window.innerWidth - box.right
    const overWidth = box.width - OVER_INSET_PX
    if (room - BESIDE_GAP_PX - COLLISION_PADDING_PX >= overWidth) {
      setPlacement({ over: false })
      return
    }
    setPlacement({
      over: true,
      // From the row's far edge back to the menu's start edge, and in.
      sideOffset: -(rtl
        ? box.right - OVER_INSET_PX - row.left
        : row.right - box.left - OVER_INSET_PX),
      // Its foot lifted to its row's top (`align="end"` puts the two feet
      // level).
      alignOffset: row.height,
      width: overWidth,
    })
  }, [])

  const contentProps: Pick<
    ComponentProps<typeof DropdownMenuSubContent>,
    "align" | "sideOffset" | "alignOffset" | "sticky" | "style"
  > = placement.over
    ? {
        align: "end",
        sideOffset: placement.sideOffset,
        alignOffset: placement.alignOffset,
        // Where it does not fit above its row, it may cover it rather than
        // be held beside it.
        sticky: "always",
        style: { width: placement.width },
      }
    : // Beside: the menu's padding plus a 4px gap away, its first row level
      // with its own (the content's padding, undone).
      { align: "start", sideOffset: 8, alignOffset: -4 }

  return { triggerRef, measure, over: placement.over, contentProps }
}

/**
 * A row that opens a submenu: on hover, on click or tap, and on → or Enter
 * (← in right-to-left), as Radix does; its rows use the same grid. Its own
 * › replaces the shared sub-trigger's, which neither mirrors nor keeps to
 * the end edge in right-to-left.
 */
export function MenuSub({
  icon,
  label,
  onOpenChange,
  contentClassName,
  children,
}: {
  icon: ReactNode
  label: string
  onOpenChange?: (open: boolean) => void
  contentClassName?: string
  children: ReactNode
}) {
  const { triggerRef, measure, over, contentProps } = useSubmenuPlacement()
  return (
    <DropdownMenuSub
      onOpenChange={(open) => {
        if (open) measure()
        onOpenChange?.(open)
      }}
    >
      <DropdownMenuPrimitive.SubTrigger
        ref={triggerRef}
        data-slot="dropdown-menu-sub-trigger"
        data-over={over || undefined}
        // Radix takes a pointer leaving a submenu's row for leaving the
        // submenu too, unless it heads sideways, toward where a submenu
        // usually is; this one is above its row, so going up is going to it.
        onPointerLeave={(event) => {
          if (over) event.preventDefault()
        }}
        className={cn(SUB_TRIGGER_CLASS, MENU_ROW_GRID)}
      >
        {icon}
        <span className={cn("min-w-0 flex-1 truncate", LABEL_BEFORE_MARK)}>
          {label}
        </span>
        <SubmenuMark />
      </DropdownMenuPrimitive.SubTrigger>
      {/* The shared sub-content clips (`overflow-hidden`, no max height)
          where the root content scrolls, so a long list would strand its
          tail offscreen: it borrows the root's scroll behaviour. As wide as
          its longest row, within the room it has. */}
      <DropdownMenuSubContent
        collisionPadding={COLLISION_PADDING_PX}
        {...contentProps}
        className={cn(
          "max-h-(--radix-dropdown-menu-content-available-height) w-max max-w-[min(22rem,var(--radix-dropdown-menu-content-available-width))] min-w-52 overflow-x-hidden overflow-y-auto",
          MENU_FADES_UNDER_SUBMENU,
          contentClassName
        )}
      >
        {children}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
