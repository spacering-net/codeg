"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangle, RefreshCw, X } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useConnection } from "@/hooks/use-connection"
import { cn } from "@/lib/utils"

/**
 * Per-conversation banner shown at the top of a session panel when the agent's
 * effective settings changed AFTER the session spawned, so the running process
 * is still on its launch-time config. In the tiled layout each stale session
 * renders its own banner, so the user can spot and resolve them one by one.
 *
 * Behaviour:
 * - Owners only — viewers and delegation children don't own the backend
 *   process, so reconnecting isn't theirs to do.
 * - "Reconnect to apply" disconnects + resumes the same session (history kept),
 *   so the new process reads current config and the banner clears.
 * - Disabled while a turn is in flight (`prompting`) — reconnecting would
 *   interrupt it — with a tooltip explaining why.
 * - The X dismisses the banner for the CURRENT drift only; a later settings
 *   change re-shows it.
 * - Responsive via container queries: in a narrow panel (small screen or a
 *   thin tiled column) the text and the actions stack; they sit on one row
 *   once the panel is wide enough.
 *
 * Returns null (no layout impact) when there's nothing to show.
 */
export function SessionConfigStaleBanner({
  contextKey,
}: {
  contextKey: string
}) {
  const t = useTranslations("Folder.chat.configStale")
  const {
    configStale,
    configStaleKind,
    configStaleDismissed,
    isViewer,
    isDelegationChild,
    status,
    reapplyConfig,
    dismissConfigStale,
  } = useConnection(contextKey)
  // Our own "reconnect in flight" flag. Kept distinct from the connection's
  // `connecting` status because `reapplyConfig` briefly disconnects first.
  const [reconnecting, setReconnecting] = useState(false)

  // Owners only: viewers and delegation children don't own the backend process,
  // so "reconnect to apply" isn't theirs to do.
  if (!configStale || configStaleDismissed || isViewer || isDelegationChild)
    return null

  const turnInFlight = status === "prompting"
  // Spinner while our reconnect is in flight OR the connection is
  // (re)establishing — `connecting` covers the reconnect `reapplyConfig` fires.
  const busy = reconnecting || status === "connecting"
  const actionDisabled = turnInFlight || busy

  const title =
    configStaleKind === "model_provider"
      ? t("modelProviderTitle")
      : t("agentConfigTitle")

  const handleReconnect = async () => {
    if (actionDisabled) return
    setReconnecting(true)
    try {
      const reconnected = await reapplyConfig()
      if (reconnected) toast.success(t("applied"))
      // else: no-op (connection vanished mid-click, viewer/child) — say nothing.
    } catch {
      // Nothing to add here: a failed reconnect is published by `connect()`
      // itself, as a notification with the reason and a Retry button. A toast
      // from here too would say it twice.
    } finally {
      // Always clear our flag. Returning null above does NOT unmount this
      // component, so a leaked `true` would later show a phantom "reconnecting…"
      // spinner on the NEXT drift without the user clicking anything.
      setReconnecting(false)
    }
  }

  return (
    <div className="@container border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-1.5 @lg:flex-row @lg:items-center @lg:gap-2">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400 @lg:mt-0" />
          <div className="min-w-0 leading-snug">
            <span className="font-medium">{title}</span>{" "}
            <span className="text-amber-700/80 dark:text-amber-300/80">
              {t("description")}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1 self-end @lg:self-auto">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                {/* Wrapper span so the tooltip still fires while the button is
                    disabled (disabled elements don't emit pointer events). */}
                <span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1.5 border-amber-500/40 bg-transparent text-amber-700 hover:bg-amber-500/20 hover:text-amber-800 dark:text-amber-300 dark:hover:text-amber-200"
                    disabled={actionDisabled}
                    onClick={handleReconnect}
                  >
                    <RefreshCw
                      className={cn("h-3.5 w-3.5", busy && "animate-spin")}
                    />
                    {busy ? t("reconnecting") : t("reconnect")}
                  </Button>
                </span>
              </TooltipTrigger>
              {turnInFlight && (
                <TooltipContent>
                  {t("reconnectDisabledDuringTurn")}
                </TooltipContent>
              )}
            </Tooltip>
          </TooltipProvider>
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6 shrink-0 text-amber-700/70 hover:bg-amber-500/20 hover:text-amber-800 dark:text-amber-300/70 dark:hover:text-amber-200"
            onClick={dismissConfigStale}
            aria-label={t("dismiss")}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  )
}
