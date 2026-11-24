"use client"

import { useTranslations } from "next-intl"
import { Copy, ExternalLink, PanelRight } from "lucide-react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type {
  BrowserPrefsSnapshot,
  LinkTarget,
} from "@/lib/browser/browser-prefs"
import { classifyLinkTarget } from "@/lib/link-classify"
import { copyTextToClipboard } from "@/lib/utils"

/** A click on a terminal link that is waiting for the user to say where it
 *  goes. The menu opens at the click's viewport coordinates. */
export interface TerminalLinkClick {
  url: string
  x: number
  y: number
}

/**
 * Whether a click on `url` in the terminal opens the action menu instead of
 * following the link at once: only when the user turned the menu on, only for
 * a plain click (a modifier-click already says which way the link goes), and
 * only for a web address — a local path or a `mailto:` has one destination
 * and nothing to choose from.
 */
export function terminalLinkClickOpensMenu(
  prefs: Pick<BrowserPrefsSnapshot, "terminalClickMenu">,
  modifier: boolean,
  url: string
): boolean {
  return (
    prefs.terminalClickMenu &&
    !modifier &&
    classifyLinkTarget(url).kind === "http"
  )
}

/**
 * The menu itself: built-in browser, system browser, copy. Anchored to a
 * zero-size element at the click point, so the menu opens where the click
 * was, like a context menu. The choice is made inside the item's own click,
 * which is the user gesture a system-browser open needs in web mode.
 */
export function TerminalLinkMenu({
  click,
  onChoose,
  onClose,
}: {
  click: TerminalLinkClick | null
  /** An explicit destination for the link; bypasses the per-source
   *  preference (never the site rules). */
  onChoose: (url: string, target: LinkTarget) => void
  /** The menu went away, by a choice, Escape or a click elsewhere. */
  onClose: () => void
}) {
  const t = useTranslations("Browser.link")
  if (!click) return null
  return (
    <DropdownMenu
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden
          data-terminal-link-anchor=""
          className="fixed h-0 w-0"
          style={{ left: click.x, top: click.y }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        // Focus goes back to the terminal (the caller's job), not to the
        // invisible anchor.
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <DropdownMenuItem onSelect={() => onChoose(click.url, "builtin")}>
          <PanelRight className="h-3.5 w-3.5" />
          {t("openBuiltin")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onChoose(click.url, "system")}>
          <ExternalLink className="h-3.5 w-3.5" />
          {t("openSystem")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void copyTextToClipboard(click.url)}>
          <Copy className="h-3.5 w-3.5" />
          {t("copy")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
