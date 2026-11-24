"use client"

import { MoreHorizontal } from "lucide-react"
import type { MouseEvent as ReactMouseEvent } from "react"
import { useTranslations } from "next-intl"

import { useFileTreeRovingFocus } from "@/components/ai-elements/file-tree"
import { cn } from "@/lib/utils"

interface RowMoreButtonProps {
  /** Optional className overrides. */
  className?: string
}

/**
 * Tiny horizontal-three-dots button rendered on the right of a tree row.
 * Clicking it dispatches a synthetic `contextmenu` MouseEvent that bubbles to
 * the enclosing Radix `ContextMenuTrigger`, which opens the very same menu
 * right-click opens — one source of truth, nothing duplicated. Same trick as
 * the sidebar conversation row's ⋯ button.
 *
 * The menu is anchored at the button's own box rather than at the click point:
 * a keyboard or programmatic activation reports `clientX/clientY` as 0, which
 * would park the menu in the viewport's top-left corner.
 *
 * The click is `stopPropagation`-ed so it doesn't fire the row's own `onClick`
 * (which would open the file preview / toggle the folder).
 *
 * Hidden at rest on pointer devices — right-click is the primary affordance
 * there and one ⋯ per file-tree row is a lot of ink. Pinned visible where there
 * is no hover to reveal it, which is exactly the touch case this exists for.
 */
export function RowMoreButton({ className }: RowMoreButtonProps) {
  const t = useTranslations("Folder.fileTreeTab")
  // In roving-focus trees the container is the single tab stop; a focusable
  // widget per row would break that (and `FileTreeActions` swallows keydown, so
  // the arrow keys would die on it too).
  const rovingFocus = useFileTreeRovingFocus()
  return (
    <button
      type="button"
      title={t("moreActions")}
      aria-label={t("moreActions")}
      aria-haspopup="menu"
      tabIndex={rovingFocus ? -1 : undefined}
      onClick={(event: ReactMouseEvent<HTMLButtonElement>) => {
        // The click must not reach the row's onClick (open preview / toggle the
        // folder). The synthetic contextmenu below is the sole opener.
        event.stopPropagation()
        event.preventDefault()
        const rect = event.currentTarget.getBoundingClientRect()
        event.currentTarget.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            button: 2,
            clientX: rect.left,
            clientY: rect.bottom,
          })
        )
      }}
      className={cn(
        "inline-flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground/70 transition-[opacity,color,background-color] hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        "opacity-0 group-hover/file-tree-row:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100",
        className
      )}
    >
      <MoreHorizontal className="size-3.5" aria-hidden />
    </button>
  )
}
