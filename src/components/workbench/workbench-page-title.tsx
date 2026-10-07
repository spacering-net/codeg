"use client"

import type { ReactNode } from "react"
import { ChevronRight, MessagesSquare } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"

interface WorkbenchPageTitleProps {
  title: string
  /**
   * For a route with a second level (the canvas list → one canvas), while the
   * second level is showing: the title turns into the way back up to the
   * route's own top level, and `trail` names where the user is now.
   */
  onTitleClick?: () => void
  /** Accessible name / tooltip for the title when it is a way back. */
  titleActionLabel?: string
  /** Further breadcrumb segments after the title. */
  trail?: ReactNode
}

/**
 * Shared header for every full-page workbench route, rendered into the
 * window-chrome strip above the page (the h-10 band the fixed corner overlays
 * sit on — see `WorkbenchRouteStrip` in workbench-content.tsx).
 *
 * It reads as a breadcrumb: a conversations button, a chevron, then the route's
 * title. That leading button is the ONLY way back out of a full-page route — it
 * replaces the lone back-arrow that used to sit in the top-right chrome next to
 * the (window-level) settings gear, where nothing said it meant "leave this
 * page". Here the trail itself says it.
 *
 * No route glyph before the title: it repeated the icon on the sidebar row the
 * user just came from, and the title already names the page.
 */
export function WorkbenchPageTitle({
  title,
  onTitleClick,
  titleActionLabel,
  trail,
}: WorkbenchPageTitleProps) {
  const tTitleBar = useTranslations("Folder.folderTitleBar")
  const { openConversations } = useWorkbenchRoute()

  return (
    // pl-3, not pl-4: the icon button carries its own optical padding, so the
    // breadcrumb's glyph lands on the same rail a bare pl-4 title used to.
    <div className="flex h-10 min-w-0 shrink-0 items-center gap-1 pl-3">
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 shrink-0 text-muted-foreground hover:bg-foreground/10 hover:text-foreground dark:hover:bg-foreground/10"
        onClick={openConversations}
        title={tTitleBar("backToConversations")}
        aria-label={tTitleBar("backToConversations")}
      >
        <MessagesSquare className="h-3.5 w-3.5" />
      </Button>
      <ChevronRight
        className="size-3 shrink-0 text-muted-foreground/50"
        aria-hidden="true"
      />
      {onTitleClick ? (
        // Same rail as the heading it replaces: `px-1` puts the text where the
        // heading's `pl-1` did, so going one level down doesn't shift it.
        <button
          type="button"
          className="min-w-0 shrink-0 truncate rounded-md px-1 py-1 text-[0.8125rem] font-medium leading-none text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
          onClick={onTitleClick}
          title={titleActionLabel}
          aria-label={titleActionLabel}
        >
          {title}
        </button>
      ) : (
        <h1 className="min-w-0 truncate pl-1 text-[0.8125rem] font-semibold leading-none">
          {title}
        </h1>
      )}
      {trail}
    </div>
  )
}
