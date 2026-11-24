"use client"

/**
 * Computer use, bottom-right of the workspace: which windows agents may see
 * or act on right now, what they have done with them, and whatever stands in
 * the way.
 *
 * Present only in the desktop runtime and only while computer use is switched
 * on — off, there is nothing to show and nothing to decide. The glyph carries
 * the violet mark the browser uses for "an agent can read this" whenever at
 * least one window is shared, because a shared window is the one fact here a
 * person should be able to see without opening anything.
 *
 * **Stop sharing** heads the popover while anything is shared: it ends every
 * sharing at once and cuts off whatever agents are in the middle of. Nothing
 * is left to resume — sharing again is the Share button, as the first time.
 * Where the stop shortcut is in force the button names it, so it is learnt
 * where it is needed; the strip above every window carries the same Stop
 * for when codeg is out of sight.
 *
 * The permission rows name the helper, never codeg: on macOS the grants belong
 * to `codeg-computer-helper`, and one given to codeg would be given to every
 * agent's shell. If codeg itself holds one, a line says so — nothing is
 * refused over it: the agents' shells have that permission whatever computer
 * use does. The rows are asked afresh when the popover opens and whenever
 * this window comes back to the front while it is open, which is when a
 * person returns from granting one in System Settings.
 */

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  AppWindow,
  BrushCleaning,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Monitor,
  RotateCw,
  ScreenShare,
  Settings2,
  ShieldAlert,
  Square,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { useIsMac } from "@/hooks/use-is-mac"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { ComputerWindowPicker } from "@/components/computer/computer-window-picker"
import { openSettingsWindow } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import {
  computerShareApp,
  computerShareScreen,
  computerShareWindow,
  computerSharedState,
  computerStop,
} from "@/lib/computer/computer-api"
import {
  clearComputerActivity,
  computerStoreMark,
  setComputerSharedSince,
  setComputerStateSince,
  useComputerStore,
  type ComputerActivityLine,
} from "@/lib/computer/computer-store"
import { stopShortcutLabel } from "@/lib/computer/stop-shortcut"
import type { GrantLevel } from "@/lib/computer/types"
import { useComputerEnabled } from "@/lib/computer/use-computer-enabled"
import {
  codegHoldsPermission,
  useComputerStatus,
} from "@/lib/computer/use-computer-status"
import { useComputerStopKey } from "@/lib/computer/use-stop-key"
import { cn } from "@/lib/utils"

const AGENT_MARK = "text-violet-600 dark:text-violet-400"

/** What the entire screen goes by among targets (Rust
 *  `targets::SCREEN_TARGET_ID`). */
const SCREEN_TARGET_ID = "d1"

/** How many activity lines the popover shows; the store keeps more. */
const ACTIVITY_SHOWN = 8

function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  })
}

/** One shared thing in the popover — a window, an application shared as a
 *  whole, or the entire screen — with what it is shared for, and a way to
 *  stop. */
function SharedRow({
  whole = false,
  screen = false,
  name,
  detail,
  level,
  onLevel,
}: {
  whole?: boolean
  screen?: boolean
  name: string
  detail?: string
  level: GrantLevel
  onLevel: (level: GrantLevel) => void
}) {
  const t = useTranslations("ComputerUse")
  const Icon = screen ? ScreenShare : whole ? AppWindow : Monitor
  return (
    <div className="flex items-center gap-2 px-2 py-1.5">
      <Icon className={cn("size-3.5 shrink-0", AGENT_MARK)} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-2xs font-medium">{name}</span>
        {detail && (
          <span className="block truncate text-3xs text-muted-foreground">
            {detail}
          </span>
        )}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="xs"
            variant="ghost"
            aria-label={t("level.change")}
            className={cn(
              level === "control" && "text-red-600 dark:text-red-400"
            )}
          >
            {t(`level.${level === "control" ? "control" : "read"}`)}
            <ChevronDown className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          {(["read", "control"] as const).map((option) => (
            <DropdownMenuItem
              key={option}
              disabled={level === option}
              onSelect={() => onLevel(option)}
            >
              {t(`level.${option}Long`)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button size="xs" variant="ghost" onClick={() => onLevel("none")}>
        {t("shared.stop")}
      </Button>
    </div>
  )
}

export function StatusBarComputer() {
  const { enabled } = useComputerEnabled({ desktopOnly: true })
  if (!enabled) return null
  return <ComputerPopover />
}

function ComputerPopover() {
  const t = useTranslations("ComputerUse")
  const { shared, sharedApps, sharedScreen, backend, activity } =
    useComputerStore()
  // A window shared with its whole application is listed as the
  // application, once; one shared with the entire screen, as the screen.
  const ownWindows = shared.filter((w) => !w.wholeApp && !w.wholeScreen)
  const rows = (sharedScreen ? 1 : 0) + sharedApps.length + ownWindows.length
  const anyShared = rows > 0
  const isMac = useIsMac()
  const stopKey = useComputerStopKey()
  const [open, setOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [stopping, setStopping] = useState(false)
  const {
    status,
    loading,
    error,
    setError,
    refresh,
    request,
    requesting,
    revealHelper,
  } = useComputerStatus(open)
  const aliveRef = useRef(true)
  const contentRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  // A codeg window opened after something was shared has heard nothing of
  // it yet: ask once when it loads, so the glyph says so without anyone
  // opening the popover.
  useEffect(() => {
    const mark = computerStoreMark()
    computerSharedState()
      .then((s) => setComputerStateSince(s, mark))
      .catch(() => {})
  }, [])

  const handleOpenChange = (next: boolean) => {
    setOpen(next)
  }

  const setLevel = async (targetId: string, level: GrantLevel) => {
    const mark = computerStoreMark()
    try {
      setComputerSharedSince(await computerShareWindow(targetId, level), mark)
    } catch (e) {
      setError(toErrorMessage(e))
    }
  }

  const setAppLevel = async (appId: string, level: GrantLevel) => {
    const mark = computerStoreMark()
    try {
      setComputerStateSince(await computerShareApp({ appId }, level), mark)
    } catch (e) {
      setError(toErrorMessage(e))
    }
  }

  const setScreenLevel = async (level: GrantLevel) => {
    const mark = computerStoreMark()
    try {
      setComputerStateSince(await computerShareScreen(level), mark)
    } catch (e) {
      setError(toErrorMessage(e))
    }
  }

  // Stop answers once the backend has done it; the store follows from the
  // state event it sends, which is the one source of truth.
  const stopSharing = async () => {
    setStopping(true)
    try {
      await computerStop()
    } catch (e) {
      setError(toErrorMessage(e))
    } finally {
      if (aliveRef.current) setStopping(false)
    }
  }

  // The button goes with the list it clears: the popover takes the focus
  // first, so it is not lost with the button.
  const clearActivity = () => {
    contentRef.current?.focus()
    clearComputerActivity()
  }

  const liveBackend = backend ?? status?.backend ?? null
  const codegLeaks = codegHoldsPermission(status)
  const permissions = status?.permissions
  const development = liveBackend?.peer === "development"
  const shortcut = stopKey?.active
    ? stopShortcutLabel(stopKey.active, isMac)
    : null
  const appNameOf = (line: ComputerActivityLine) =>
    line.app ??
    (line.targetId === SCREEN_TARGET_ID
      ? t("shared.screen")
      : (shared.find((w) => w.targetId === line.targetId)?.appName ??
        line.targetId))

  return (
    <>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <button
            aria-label={t("title")}
            title={
              anyShared
                ? t("tooltipShared", { count: shared.length })
                : t("title")
            }
            className="relative flex items-center transition-colors hover:text-foreground"
          >
            <Monitor className={cn("size-3.5", anyShared && AGENT_MARK)} />
          </button>
        </PopoverTrigger>
        <PopoverContent
          ref={contentRef}
          side="top"
          align="end"
          className="w-88 gap-2 p-2.5"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 truncate text-xs font-medium">
              {t("title")}
              {!status?.verifiedPlatform && (
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-3xs font-medium text-muted-foreground">
                  {t("preview")}
                </span>
              )}
            </span>
            <button
              type="button"
              onClick={() => void refresh()}
              title={t("refresh")}
              aria-label={t("refresh")}
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              <RotateCw className={cn("h-3 w-3", loading && "animate-spin")} />
            </button>
          </div>

          {anyShared && (
            <Button
              size="sm"
              variant="destructive"
              className="w-full"
              onClick={() => void stopSharing()}
              disabled={stopping}
              title={t("stopHint")}
            >
              <Square className="size-3 fill-current" />
              {t("stop")}
              {shortcut && (
                <kbd className="font-sans text-2xs opacity-80">{shortcut}</kbd>
              )}
            </Button>
          )}

          {codegLeaks && (
            <div className="flex gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-2xs text-amber-600 dark:text-amber-400">
              <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
              <span>{t("codegGranted")}</span>
            </div>
          )}

          {liveBackend && (
            <p className="text-2xs text-muted-foreground">
              {t(`backend.${liveBackend.state}`)}
              {" · "}
              {t("driver", { version: liveBackend.driverVersion })}
              {development && (
                <span
                  className="text-amber-600 dark:text-amber-400"
                  title={t("devBuild")}
                >
                  {" · "}
                  {t("devTag")}
                </span>
              )}
              {liveBackend.detail ? ` — ${liveBackend.detail}` : ""}
            </p>
          )}

          {permissions?.required && (
            <div className="divide-y overflow-hidden rounded-lg border">
              {(
                [
                  ["accessibility", permissions.accessibility],
                  ["screenRecording", permissions.screenRecording],
                ] as const
              ).map(([permission, granted]) => (
                <div
                  key={permission}
                  className="flex items-center gap-2 px-2 py-1.5"
                >
                  {granted ? (
                    <CircleCheck className="size-3.5 shrink-0 text-emerald-500" />
                  ) : (
                    <CircleAlert className="size-3.5 shrink-0 text-amber-500" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-2xs font-medium">
                    {t(`permissions.${permission}`)}
                  </span>
                  {granted ? (
                    <span className="text-3xs text-muted-foreground">
                      {t("permissions.granted")}
                    </span>
                  ) : (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={requesting !== null}
                      onClick={() => void request(permission)}
                    >
                      {t("permissions.request")}
                    </Button>
                  )}
                </div>
              ))}
              {!(permissions.accessibility && permissions.screenRecording) && (
                <div className="space-y-1 px-2 py-1.5 text-3xs leading-snug text-muted-foreground">
                  <p>
                    {t("permissions.why")}
                    {development && ` ${t("permissions.devRebuild")}`}
                  </p>
                  <p>
                    {t("permissions.notListed")}{" "}
                    <button
                      type="button"
                      className="underline underline-offset-2 hover:text-foreground"
                      onClick={revealHelper}
                    >
                      {t("permissions.reveal")}
                    </button>
                  </p>
                </div>
              )}
            </div>
          )}

          <div className="overflow-hidden rounded-lg border">
            <div className="px-2 py-1.5">
              <span className="text-2xs font-medium">
                {t("shared.title", { count: shared.length })}
              </span>
            </div>
            {rows === 0 ? (
              <p className="border-t px-2 py-1.5 text-3xs text-muted-foreground">
                {t("shared.empty")}
              </p>
            ) : (
              <div className="divide-y border-t">
                {sharedScreen && (
                  <SharedRow
                    screen
                    name={t("shared.screen")}
                    detail={t("shared.screenWindows", {
                      count: sharedScreen.windows,
                    })}
                    level={sharedScreen.level}
                    onLevel={(level) => void setScreenLevel(level)}
                  />
                )}
                {sharedApps.map((a) => (
                  <SharedRow
                    key={a.appId}
                    whole
                    name={a.appName}
                    detail={t("shared.wholeApp", { count: a.windows })}
                    level={a.level}
                    onLevel={(level) => void setAppLevel(a.appId, level)}
                  />
                ))}
                {ownWindows.map((w) => (
                  <SharedRow
                    key={w.targetId}
                    name={w.appName}
                    detail={w.title}
                    level={w.level}
                    onLevel={(level) => void setLevel(w.targetId, level)}
                  />
                ))}
              </div>
            )}
          </div>

          {activity.length > 0 && (
            <div className="rounded-lg border px-2 py-1.5">
              <div className="mb-1 flex items-center justify-between gap-2">
                <p className="text-2xs font-medium">{t("activity.title")}</p>
                <button
                  type="button"
                  onClick={clearActivity}
                  title={t("activity.clear")}
                  aria-label={t("activity.clear")}
                  className="text-muted-foreground transition-colors hover:text-foreground"
                >
                  <BrushCleaning className="h-3 w-3" />
                </button>
              </div>
              <ul className="space-y-0.5">
                {activity.slice(0, ACTIVITY_SHOWN).map((line, i) => (
                  <li
                    key={`${line.at}-${i}`}
                    className="flex items-center gap-1.5 text-3xs text-muted-foreground"
                  >
                    <span className="tabular-nums">{formatTime(line.at)}</span>
                    <span className="min-w-0 flex-1 truncate">
                      {t(`activity.${line.action}`)}
                      {appNameOf(line) ? ` · ${appNameOf(line)}` : ""}
                      {line.count > 1 ? ` ×${line.count}` : ""}
                    </span>
                    <span
                      className={cn(
                        line.outcome === "done"
                          ? "text-emerald-600 dark:text-emerald-400"
                          : line.outcome === "refused"
                            ? "text-amber-600 dark:text-amber-400"
                            : "text-red-500"
                      )}
                    >
                      {t(`activity.outcome.${line.outcome}`)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {error && (
            <div className="rounded-md border border-red-500/30 bg-red-500/5 px-2 py-1.5 text-2xs break-words text-red-500">
              {error}
            </div>
          )}

          <Button
            size="sm"
            className="w-full"
            onClick={() => {
              setOpen(false)
              setPickerOpen(true)
            }}
          >
            <Monitor className="h-3.5 w-3.5" />
            {t("share")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="w-full"
            onClick={() => {
              openSettingsWindow("computer-use").catch((err) => {
                console.error(
                  "[StatusBarComputer] failed to open settings:",
                  err
                )
              })
            }}
          >
            <Settings2 className="h-3.5 w-3.5" />
            {t("openSettings")}
          </Button>
        </PopoverContent>
      </Popover>
      <ComputerWindowPicker open={pickerOpen} onOpenChange={setPickerOpen} />
    </>
  )
}
