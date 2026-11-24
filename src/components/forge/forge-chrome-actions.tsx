"use client"

import { useTranslations } from "next-intl"
import { RefreshCw, Settings2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useForgeRefreshStore } from "@/stores/forge-refresh-store"
import { cn } from "@/lib/utils"
import type { WorkbenchChromeActionsProps } from "@/components/workbench/workbench-content"

/** Fired by the chrome cluster's settings button; ForgePage owns the dialog,
 *  so the button just asks it to open. A window event rather than a store like
 *  the reload handler next to it: this direction is one-way — there is no
 *  "nothing to configure yet" state for the button to read back, because the
 *  global row exists before any repository is picked. */
export const OPEN_FORGE_SETTINGS_EVENT = "codeg:open-forge-settings"

/**
 * The forge route's entries in the window's top-right chrome cluster, drawn
 * immediately left of the (window-level) settings gear — see
 * `WorkbenchRouteChromeActions`.
 *
 * Reloading acts on the WHOLE list rather than narrowing it, which is what
 * separates it from everything in the page's own toolbar; up here it also
 * stops competing for width with the filters. The handler and the busy flag
 * come from the page through `useForgeRefreshStore`, because this component
 * and the page it reloads have no common ancestor below the window shell.
 */
export function ForgeChromeActions({
  buttonClassName,
  iconClassName,
}: WorkbenchChromeActionsProps) {
  const t = useTranslations("Forge")
  const refresh = useForgeRefreshStore((s) => s.refresh)
  const busy = useForgeRefreshStore((s) => s.busy)

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className={buttonClassName}
        // Nothing to reload until a page has published a repository — before
        // that the click would be a no-op the button gave no sign of.
        disabled={refresh == null || busy}
        onClick={() => refresh?.()}
        title={t("refresh")}
        aria-label={t("refresh")}
      >
        <RefreshCw className={cn(iconClassName, busy && "animate-spin")} />
      </Button>
      {/* Never disabled, unlike reload: the global row is always there to
          change, even over a folder with no remote. */}
      <Button
        variant="ghost"
        size="icon"
        className={buttonClassName}
        onClick={() =>
          window.dispatchEvent(new Event(OPEN_FORGE_SETTINGS_EVENT))
        }
        title={t("settingsTitle")}
        aria-label={t("settingsTitle")}
      >
        <Settings2 className={iconClassName} />
      </Button>
    </>
  )
}
