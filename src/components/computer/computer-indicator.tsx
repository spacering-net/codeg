"use client"

/**
 * The strip codeg keeps above every window while any window is shared: what
 * agents may do and in which application, what one has just done, and Stop.
 *
 * It lives in a window of its own (`computer-indicator`), which the backend
 * shows while anything is shared and hides once nothing is — a Stop, which
 * ends every sharing, included. This part only draws it, sizes the window to
 * what it drew — the words are as long as the language makes them — and
 * passes Stop on. The whole strip is a drag handle except the button, so it
 * can be moved off whatever it covers.
 *
 * It names applications, never window titles: it is on the screen for
 * anyone looking at it, or at a recording of it.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Square } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useIsMac } from "@/hooks/use-is-mac"
import {
  computerIndicatorFit,
  computerSharedState,
  computerStop,
} from "@/lib/computer/computer-api"
import {
  computerStoreMark,
  setComputerStateSince,
  useComputerStore,
} from "@/lib/computer/computer-store"
import { stopShortcutLabel } from "@/lib/computer/stop-shortcut"
import type { ComputerAction } from "@/lib/computer/types"
import { useComputerStopKey } from "@/lib/computer/use-stop-key"
import { cn } from "@/lib/utils"

/** How long a finished action is named on the strip. */
const RECENT_MS = 4000

/** The room around the strip, for its shadow. */
const MARGIN = 6

/** What changes a window — the reads are not news on a strip that already
 *  says agents can see it. */
const ACTIONS: ReadonlySet<ComputerAction> = new Set([
  "click",
  "drag",
  "scroll",
  "type",
  "key",
  "hold-key",
  "set-value",
  "restore",
  "menu",
  "set-frame",
  "launch",
  "clipboard-write",
])

/** Painted before any script runs, so the window never flashes a
 *  background around the strip. */
const TRANSPARENT = "html,body{background:transparent!important}"

export function ComputerIndicator() {
  const t = useTranslations("ComputerUse")
  const isMac = useIsMac()
  const { shared, sharedApps, sharedScreen, sharedKnown, activity } =
    useComputerStore()
  const stopKey = useComputerStopKey()
  const [stopping, setStopping] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const stripRef = useRef<HTMLDivElement>(null)

  // Opened after something was shared: ask what, once.
  useEffect(() => {
    const mark = computerStoreMark()
    computerSharedState()
      .then((s) => setComputerStateSince(s, mark))
      .catch(() => {})
  }, [])

  // Tell the window how large the strip came out, whenever that changes. The
  // strip is as wide as its words (`w-max`), not as the window: a window
  // sized to an earlier, shorter strip must not clip the next one to fit.
  useLayoutEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    const fit = () => {
      const { width, height } = strip.getBoundingClientRect()
      if (width > 0 && height > 0) {
        void computerIndicatorFit(
          Math.ceil(width) + MARGIN * 2,
          Math.ceil(height) + MARGIN * 2
        ).catch(() => {})
      }
    }
    fit()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(fit)
    observer.observe(strip)
    return () => observer.disconnect()
  }, [])

  // The latest action that went through — a read that followed it is not
  // news here and must not take it down early.
  const latest = activity.find(
    (line) => line.outcome === "done" && ACTIONS.has(line.action)
  )
  const recent = latest && now - latest.at < RECENT_MS ? latest : null

  // Take the "just now" line down when its time is up. (Until then `now` may
  // be older than the line, which still reads as recent.)
  useEffect(() => {
    if (!latest) return
    const left = latest.at + RECENT_MS - Date.now()
    if (left <= 0) return
    const timer = window.setTimeout(() => setNow(Date.now()), left + 50)
    return () => window.clearTimeout(timer)
  }, [latest])

  const stop = async () => {
    setStopping(true)
    try {
      await computerStop()
    } catch {
      // The popover in the main window says what went wrong; the strip
      // stays up while anything is still shared.
    } finally {
      setStopping(false)
    }
  }

  // What is shared, as the person shared it: each application shared as a
  // whole once — open windows or not — and each window shared on its own.
  // The entire screen, when it is shared, is all of it.
  const units = [
    ...sharedApps.map((a) => ({
      name: a.appName,
      level: a.level,
      windows: a.windows,
    })),
    ...shared
      .filter((w) => !w.wholeApp && !w.wholeScreen)
      .map((w) => ({ name: w.appName, level: w.level, windows: 1 })),
  ]
  const controlled = units.filter((u) => u.level === "control")
  const acting = sharedScreen
    ? sharedScreen.level === "control"
    : controlled.length > 0
  const subject = acting ? controlled : units
  const appOf = (targetId: string) =>
    shared.find((w) => w.targetId === targetId)?.appName

  let summary: string | null = null
  if (sharedScreen)
    summary = t(acting ? "indicator.actScreen" : "indicator.readScreen")
  else if (subject.length === 1)
    summary = t(acting ? "indicator.actOne" : "indicator.readOne", {
      app: subject[0].name,
    })
  else if (subject.length > 1)
    summary = t(acting ? "indicator.actMany" : "indicator.readMany", {
      count: Math.max(
        subject.reduce((n, u) => n + u.windows, 0),
        subject.length
      ),
    })

  const recentApp = recent ? (recent.app ?? appOf(recent.targetId)) : undefined
  const shortcut = stopKey?.active
    ? stopShortcutLabel(stopKey.active, isMac)
    : null

  return (
    <div className="flex h-screen w-screen items-start justify-center overflow-hidden">
      <style>{TRANSPARENT}</style>
      <div
        ref={stripRef}
        data-tauri-drag-region
        style={{ margin: MARGIN }}
        className="flex w-max max-w-[680px] shrink-0 cursor-default select-none items-center gap-2 rounded-full border border-border bg-background py-1 pr-1 pl-3 text-xs text-foreground shadow-lg"
      >
        {sharedKnown && summary && (
          <>
            <span
              aria-hidden="true"
              data-tauri-drag-region
              className={cn(
                "size-2 shrink-0 rounded-full",
                acting ? "animate-pulse bg-red-500" : "bg-violet-500"
              )}
            />
            <span
              data-tauri-drag-region
              className="min-w-0 truncate font-medium"
            >
              {summary}
            </span>
            {recent && (
              <span
                data-tauri-drag-region
                className="min-w-0 truncate text-muted-foreground"
              >
                {recentApp
                  ? t("indicator.recent", {
                      action: t(`activity.${recent.action}`),
                      app: recentApp,
                    })
                  : t(`activity.${recent.action}`)}
              </span>
            )}
          </>
        )}
        {/* Nothing left to stop once a Stop has ended every sharing: the
            strip is on its way down then, and says nothing more. */}
        {(!sharedKnown || units.length > 0 || sharedScreen) && (
          <Button
            size="xs"
            variant="destructive"
            className="shrink-0 rounded-full"
            onClick={() => void stop()}
            disabled={stopping || !sharedKnown}
            title={
              shortcut
                ? t("indicator.stopWithKey", { key: shortcut })
                : t("stopHint")
            }
          >
            <Square className="size-2.5 fill-current" />
            {t("indicator.stop")}
            {shortcut && (
              <kbd className="font-sans text-3xs opacity-80">{shortcut}</kbd>
            )}
          </Button>
        )}
      </div>
    </div>
  )
}
