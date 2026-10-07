"use client"

/**
 * Where a person hands one window to agents — and takes it back.
 *
 * Every normal window on the desktop, with its application, its title and a
 * small picture of it: this is the person's own screen, shown to them, so it
 * is shown in full. What an *agent* is told about an unshared window is far
 * less (no title, no picture) and is decided on the backend.
 *
 * Pictures are fetched one window at a time as the list renders, through the
 * helper — codeg itself never captures the screen. A window that can never be
 * shared (codeg's, a credential manager, one whose application cannot be
 * told) is kept out of the grid, in a folded list at the bottom with the
 * reason, and gets no picture.
 *
 * Titles and pictures both need the helper to hold Screen Recording (macOS).
 * Without it the picker says so, with the way to grant it; it reads the
 * helper's permissions as it opens and again whenever this window comes back
 * to the front, and once Screen Recording has arrived it lists the windows
 * and fetches their pictures again. Refresh fetches the pictures again too.
 *
 * Two levels are offered — the browser's pair: reading a window cannot
 * change it, acting on it can, and they are different decisions. Each window
 * has the three choices side by side, not sharing among them, so what it is
 * shared for can be seen and changed with one click; a shared window moves
 * between the levels without being taken back first. The same two, and
 * "stop sharing", are offered for every shareable window in the list at
 * once.
 *
 * The windows are grouped by application, and each application can be
 * shared as a whole: every window of it, the ones it opens later too, its
 * menus and its own shortcuts. While it is, its windows go with it — their
 * own choices are shown as the application's, and wait until it is no longer
 * shared.
 *
 * Where the person has switched it on (macOS and Windows), the entire screen
 * heads the list: every window that may be shared, the ones that come up
 * later too, and the desktop's own shortcuts. While it is shared, every
 * window and application goes with it, and their own choices wait.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  AppWindow,
  ChevronDown,
  ChevronRight,
  Eye,
  Layers,
  Loader2,
  MousePointerClick,
  RotateCw,
  ScreenShare,
  ShieldOff,
  TriangleAlert,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { toErrorMessage } from "@/lib/app-error"
import {
  computerAvailable,
  computerListShareableWindows,
  computerRevokeAll,
  computerShareApp,
  computerShareScreen,
  computerShareWindow,
  computerShareWindows,
  computerWindowThumbnail,
} from "@/lib/computer/computer-api"
import {
  computerStoreMark,
  setComputerSharedSince,
  setComputerStateSince,
  useComputerStore,
} from "@/lib/computer/computer-store"
import type {
  GrantLevel,
  NotGrantable,
  PickerWindow,
} from "@/lib/computer/types"
import { useComputerStatus } from "@/lib/computer/use-computer-status"
import { cn } from "@/lib/utils"

/** Tiles as wide as fit, none narrower than this: four across the dialog at
 *  its widest, fewer as the window narrows — wide enough for the three
 *  levels side by side in every language. */
const GRID = "grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-3"

/** The shareable windows of one application. */
interface AppGroup {
  /** The application's process and key: one application, one group. */
  key: string
  appName: string
  windows: PickerWindow[]
}

/** A picture of one shareable window, fetched once. Keyed by the caller on
 *  the target id and on the picker's picture round, so a different window —
 *  or the same one asked for again — is a fresh component. Shown whole, as
 *  a window on a backdrop, whatever its shape. */
function Thumbnail({ targetId }: { targetId: string }) {
  const [src, setSrc] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    computerWindowThumbnail(targetId)
      .then((url) => {
        if (!cancelled) setSrc(url)
      })
      .catch(() => {
        if (!cancelled) setSrc(null)
      })
    return () => {
      cancelled = true
    }
  }, [targetId])

  return (
    <div className="relative aspect-video w-full bg-muted/60">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- a data: URL from the helper, not a route next/image could optimise
        <img
          src={src}
          alt=""
          className="absolute inset-0 m-auto max-h-[calc(100%-1rem)] max-w-[calc(100%-1rem)] rounded-[3px] shadow-sm ring-1 ring-black/5 dark:ring-white/10"
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          {src === undefined ? (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          ) : (
            <AppWindow className="size-6 text-muted-foreground/50" />
          )}
        </div>
      )}
    </div>
  )
}

/** One shareable window: its picture, whose it is, and what it is shared
 *  for. The tile takes the colour of its level — violet to be read, red to
 *  be acted on — as the strip over the screen does. */
function WindowTile({
  item: w,
  level,
  viaApp,
  viaScreen,
  pending,
  disabled,
  pictures,
  onLevel,
}: {
  item: PickerWindow
  level: GrantLevel
  /** Shared with its whole application: its level is the application's. */
  viaApp: boolean
  /** Shared with the entire screen: its level is the screen's. */
  viaScreen: boolean
  /** The level a change on its way for this window is going to. */
  pending: GrantLevel | null
  disabled: boolean
  /** The picker's picture round, part of the picture's key. */
  pictures: number
  onLevel: (next: GrantLevel) => void
}) {
  const t = useTranslations("ComputerUse.picker")
  const appName = w.appName || t("unnamedApp")
  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden rounded-2xl border bg-card transition-[border-color,box-shadow]",
        level === "none" && "hover:border-foreground/20",
        level === "read" && "border-violet-500/70 ring-2 ring-violet-500/15",
        level === "control" && "border-red-500/70 ring-2 ring-red-500/15"
      )}
    >
      <div className="relative">
        <Thumbnail key={`${w.targetId}:${pictures}`} targetId={w.targetId} />
        {(w.minimized || w.hidden) && (
          <span className="absolute start-2 top-2 rounded-full bg-background/85 px-2 py-0.5 text-2xs text-muted-foreground shadow-sm backdrop-blur-sm">
            {w.minimized ? t("minimized") : t("hidden")}
          </span>
        )}
        {(viaApp || viaScreen) && (
          <span className="absolute end-2 top-2 rounded-full bg-background/85 px-2 py-0.5 text-2xs text-muted-foreground shadow-sm backdrop-blur-sm">
            {t(viaScreen ? "viaScreen" : "viaApp")}
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-2 border-t px-2.5 pt-2 pb-2.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium" title={appName}>
            {appName}
          </p>
          <p
            className="truncate text-2xs text-muted-foreground"
            title={w.title}
          >
            {w.title || t("untitled")}
          </p>
        </div>
        <LevelControl
          label={t("levelLabel", { app: appName })}
          level={level}
          pending={pending}
          disabled={disabled || viaApp || viaScreen}
          onLevel={onLevel}
        />
      </div>
    </div>
  )
}

/** The entire screen, at the head of the list: what it is shared for, and
 *  what sharing it takes in. Coloured by its level, as a window's tile. */
function ScreenCard({
  level,
  pending,
  disabled,
  onLevel,
}: {
  level: GrantLevel
  pending: GrantLevel | null
  disabled: boolean
  onLevel: (next: GrantLevel) => void
}) {
  const t = useTranslations("ComputerUse.picker")
  return (
    <section
      aria-label={t("screenTitle")}
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border bg-card px-3 py-2.5 transition-[border-color,box-shadow]",
        level === "read" && "border-violet-500/70 ring-2 ring-violet-500/15",
        level === "control" && "border-red-500/70 ring-2 ring-red-500/15"
      )}
    >
      <ScreenShare className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium">{t("screenTitle")}</p>
        <p className="text-2xs leading-snug text-muted-foreground">
          {t("screenHint")}
        </p>
      </div>
      <div className="w-48">
        <LevelControl
          label={t("screenLevelLabel")}
          level={level}
          pending={pending}
          disabled={disabled}
          onLevel={onLevel}
        />
      </div>
    </section>
  )
}

const LEVELS = [
  { level: "none", label: "levelNone" },
  { level: "read", label: "levelRead" },
  { level: "control", label: "levelControl" },
] as const

/** Not shared, read, act — side by side, the one in force marked, each a
 *  click away. Buttons rather than radios: arrowing across radios would
 *  share the window at every stop on the way. Words only: a third of a
 *  narrow tile has no room for an icon beside "Handeln" or "読み取り". */
function LevelControl({
  label,
  level,
  pending,
  disabled,
  onLevel,
}: {
  /** What the group is called to a screen reader. */
  label: string
  level: GrantLevel
  pending: GrantLevel | null
  disabled: boolean
  onLevel: (next: GrantLevel) => void
}) {
  const t = useTranslations("ComputerUse.picker")
  const hint: Record<GrantLevel, string | undefined> = {
    none: level === "none" ? undefined : t("stopSharing"),
    read: t("shareRead"),
    control: t("shareControl"),
  }
  return (
    <div
      role="group"
      aria-label={label}
      className="grid grid-cols-3 gap-0.5 rounded-full bg-muted p-0.5"
    >
      {LEVELS.map(({ level: option, label }) => {
        const on = level === option
        return (
          <button
            key={option}
            type="button"
            aria-pressed={on}
            disabled={disabled}
            title={hint[option]}
            onClick={() => {
              if (!on) onLevel(option)
            }}
            className={cn(
              "flex h-6 min-w-0 items-center justify-center gap-1 rounded-full px-1.5 text-2xs font-medium text-muted-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-60",
              !on && "hover:bg-background/60 hover:text-foreground",
              on && "bg-background text-foreground shadow-sm",
              on &&
                option === "read" &&
                "bg-violet-600 text-white dark:bg-violet-500",
              on &&
                option === "control" &&
                "bg-red-600 text-white dark:bg-red-500"
            )}
          >
            {pending === option && (
              <Loader2 className="size-3 shrink-0 animate-spin" />
            )}
            <span className="truncate">{t(label)}</span>
          </button>
        )
      })}
    </div>
  )
}

export function ComputerWindowPicker({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useTranslations("ComputerUse.picker")
  const tComputer = useTranslations("ComputerUse")
  // Whether a window is shared is read from the live store, not from the list
  // as it was fetched: a grant can end (it lapses, another window stops it)
  // while the picker is open. Until the store has heard anything, the list's
  // own word is the only one there is.
  const { shared, sharedScreen, sharedKnown } = useComputerStore()
  /** What a window is shared for, and whether with its whole application or
   *  the entire screen. */
  const stateOf = (
    w: PickerWindow
  ): {
    level: GrantLevel
    wholeApp: boolean
    appId?: string
    wholeScreen: boolean
  } => {
    if (!sharedKnown) {
      return {
        level: w.level,
        wholeApp: !!w.wholeApp,
        appId: w.appId,
        wholeScreen: !!w.wholeScreen,
      }
    }
    const s = shared.find((x) => x.targetId === w.targetId)
    return {
      level: s?.level ?? "none",
      wholeApp: !!s?.wholeApp,
      appId: s?.appId,
      wholeScreen: !!s?.wholeScreen,
    }
  }
  const levelOf = (w: PickerWindow): GrantLevel => stateOf(w).level
  const [windows, setWindows] = useState<PickerWindow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /** The window a change is on its way for, and the level it goes to. */
  const [busy, setBusy] = useState<{
    targetId: string
    level: GrantLevel
  } | null>(null)
  /** The application a change is on its way for, and the level it goes to. */
  const [busyApp, setBusyApp] = useState<{
    key: string
    level: GrantLevel
  } | null>(null)
  /** The level a change to the entire screen is on its way to. */
  const [busyScreen, setBusyScreen] = useState<GrantLevel | null>(null)
  /** A change to every window at once is on its way. */
  const [bulk, setBulk] = useState(false)
  /** One change at a time: a "stop sharing all" that lands before a share
   *  still on its way would be undone by it, and the other way round. */
  const changing =
    bulk || busy !== null || busyApp !== null || busyScreen !== null
  const [showUnshareable, setShowUnshareable] = useState(false)
  /** Bumped to fetch every picture again: each is fetched once per value. */
  const [pictures, setPictures] = useState(0)
  /** The latest load; an older one that answers late is dropped. */
  const loadSeqRef = useRef(0)
  const {
    status,
    error: permissionError,
    request,
    requesting,
  } = useComputerStatus(open && computerAvailable())
  const permissions = status?.permissions
  const screenRecording = permissions?.required
    ? permissions.screenRecording
    : undefined
  /** What the entire screen is shared for. While it is, every window and
   *  application goes with it. */
  const screenLevel: GrantLevel = sharedScreen?.level ?? "none"
  const screenShared = screenLevel !== "none"
  const screenOffered = !!status?.screenOffered || screenShared

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current
    setError(null)
    try {
      const listed = await computerListShareableWindows()
      if (seq === loadSeqRef.current) setWindows(listed)
    } catch (e) {
      if (seq !== loadSeqRef.current) return
      setError(toErrorMessage(e))
      setWindows([])
    }
  }, [])

  useEffect(() => {
    if (open) {
      setWindows(null)
      setNotice(null)
      void load()
    }
  }, [open, load])

  /** The list again, and every picture in it. */
  const reload = useCallback(() => {
    setPictures((n) => n + 1)
    return load()
  }, [load])

  /** Screen Recording was missing and is here now: the titles and pictures
   *  it withheld can be had. */
  const missedRef = useRef(false)
  useEffect(() => {
    if (screenRecording === false) {
      missedRef.current = true
    } else if (screenRecording && missedRef.current) {
      missedRef.current = false
      void reload()
    }
  }, [screenRecording, reload])

  const shareable = windows?.filter((w) => !w.notGrantable) ?? []
  const unshareable =
    windows?.filter(
      (w): w is PickerWindow & { notGrantable: NotGrantable } =>
        !!w.notGrantable
    ) ?? []
  const sharedCount = shareable.filter((w) => levelOf(w) !== "none").length
  const anyShared = sharedCount > 0
  /** The shareable windows by application, in the list's order. */
  const groups: AppGroup[] = []
  for (const w of shareable) {
    const key = `${w.pid}:${w.appKey}`
    let group = groups.find((g) => g.key === key)
    if (!group) {
      group = { key, appName: w.appName || t("unnamedApp"), windows: [] }
      groups.push(group)
    }
    group.windows.push(w)
  }
  /** What an application is shared for as a whole: what its windows shared
   *  with it say. */
  const appOf = (group: AppGroup): { level: GrantLevel; appId?: string } => {
    for (const w of group.windows) {
      const state = stateOf(w)
      if (state.wholeApp) return { level: state.level, appId: state.appId }
    }
    return { level: "none" }
  }

  /** Every shareable window in the list, at one level — as each window's own
   *  menu would do it, one after the other. */
  const shareAll = async (next: GrantLevel) => {
    const mark = computerStoreMark()
    setBulk(true)
    setError(null)
    setNotice(null)
    try {
      // A window shared with its whole application goes with it.
      const result = await computerShareWindows(
        shareable.filter((w) => !stateOf(w).wholeApp).map((w) => w.targetId),
        next
      )
      setComputerSharedSince(result.shared, mark)
      if (result.skipped > 0) {
        setNotice(t("skipped", { count: result.skipped }))
        // Some have closed since the list was read.
        void load()
      }
    } catch (e) {
      setError(toErrorMessage(e))
      void load()
    } finally {
      setBulk(false)
    }
  }

  const stopAll = async () => {
    const mark = computerStoreMark()
    setBulk(true)
    setError(null)
    setNotice(null)
    try {
      await computerRevokeAll()
      setComputerSharedSince([], mark)
    } catch (e) {
      setError(toErrorMessage(e))
    } finally {
      setBulk(false)
    }
  }

  const setAppLevel = async (
    group: AppGroup,
    appId: string | undefined,
    next: GrantLevel
  ) => {
    const first = group.windows[0]
    if (!appId && !first) return
    const mark = computerStoreMark()
    setBusyApp({ key: group.key, level: next })
    setError(null)
    try {
      setComputerStateSince(
        await computerShareApp(
          appId ? { appId } : { targetId: first.targetId },
          next
        ),
        mark
      )
    } catch (e) {
      setError(toErrorMessage(e))
      void load()
    } finally {
      setBusyApp(null)
    }
  }

  const setScreenLevel = async (next: GrantLevel) => {
    const mark = computerStoreMark()
    setBusyScreen(next)
    setError(null)
    try {
      setComputerStateSince(await computerShareScreen(next), mark)
    } catch (e) {
      setError(toErrorMessage(e))
    } finally {
      setBusyScreen(null)
    }
  }

  const setLevel = async (item: PickerWindow, next: GrantLevel) => {
    const mark = computerStoreMark()
    setBusy({ targetId: item.targetId, level: next })
    setError(null)
    try {
      setComputerSharedSince(
        await computerShareWindow(item.targetId, next),
        mark
      )
    } catch (e) {
      setError(toErrorMessage(e))
      // The window may have closed; the list says what is there now.
      void load()
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* A column: the header, toolbar and notices stay put, and only the
          windows scroll — never the dialog around them as well. */}
      <DialogContent className="flex max-h-[min(calc(100dvh-2rem),52rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl">
        <div className="px-6 pt-6">
          <DialogHeader>
            <DialogTitle>{t("title")}</DialogTitle>
            <DialogDescription>{t("description")}</DialogDescription>
          </DialogHeader>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 px-6 pt-5 pb-3">
          <p className="text-xs text-muted-foreground">
            {windows ? t("count", { count: shareable.length }) : t("loading")}
            {anyShared && (
              <span className="text-violet-600 dark:text-violet-400">
                {" · "}
                {t("sharedCount", { count: sharedCount })}
              </span>
            )}
          </p>
          <div className="flex items-center gap-1.5">
            {anyShared && (
              <Button
                size="sm"
                variant="destructive"
                onClick={() => void stopAll()}
                disabled={changing}
              >
                {t("stopSharingAll")}
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={changing || screenShared || shareable.length === 0}
                >
                  {bulk ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Layers className="size-3.5" />
                  )}
                  {t("shareAll")}
                  <ChevronDown className="size-3 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-56">
                <DropdownMenuItem onSelect={() => void shareAll("read")}>
                  <Eye className="size-3.5" />
                  {t("shareAllRead")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void shareAll("control")}>
                  <MousePointerClick className="size-3.5" />
                  {t("shareAllControl")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => void reload()}
              disabled={windows === null}
              title={t("refresh")}
              aria-label={t("refresh")}
            >
              <RotateCw className="size-3.5" />
            </Button>
          </div>
        </div>

        {(screenRecording === false || error || notice) && (
          <div className="space-y-2 px-6 pb-3">
            {screenRecording === false && (
              <div className="flex items-center gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                <TriangleAlert className="size-4 shrink-0 text-amber-500" />
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    {t("noScreenRecording")}
                  </p>
                  {permissionError && (
                    <p className="text-2xs break-words text-red-500">
                      {permissionError}
                    </p>
                  )}
                </div>
                <Button
                  size="xs"
                  variant="outline"
                  className="shrink-0"
                  disabled={requesting !== null}
                  onClick={() => void request("screenRecording")}
                >
                  {tComputer("permissions.request")}
                </Button>
              </div>
            )}

            {error && (
              <div className="rounded-xl border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs break-words text-red-500">
                {error}
              </div>
            )}

            {notice && (
              <div className="rounded-xl border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                {notice}
              </div>
            )}
          </div>
        )}

        <ScrollArea className="min-h-0 flex-1 border-t">
          <div className="space-y-4 px-6 pt-4 pb-6">
            {screenOffered && (
              <ScreenCard
                level={screenLevel}
                pending={busyScreen}
                disabled={changing}
                onLevel={(next) => void setScreenLevel(next)}
              />
            )}
            {windows === null ? (
              <div className={GRID} aria-hidden="true">
                {Array.from({ length: 4 }, (_, i) => (
                  <div key={i} className="overflow-hidden rounded-2xl border">
                    <Skeleton className="aspect-video w-full rounded-none" />
                    <div className="space-y-1.5 border-t px-2.5 py-2.5">
                      <Skeleton className="h-3 w-2/3 rounded-md" />
                      <Skeleton className="h-2.5 w-1/2 rounded-md" />
                    </div>
                  </div>
                ))}
              </div>
            ) : shareable.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed px-6 py-10 text-center text-sm text-muted-foreground">
                <AppWindow className="size-6 text-muted-foreground/50" />
                {t(windows.length === 0 ? "empty" : "noneShareable")}
              </div>
            ) : (
              <div className="space-y-5">
                {groups.map((group) => {
                  const app = appOf(group)
                  return (
                    <section
                      key={group.key}
                      aria-label={group.appName}
                      className="space-y-2"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                        <p className="min-w-0 truncate text-xs font-medium">
                          {group.appName}
                          <span className="font-normal text-muted-foreground">
                            {" · "}
                            {t("count", { count: group.windows.length })}
                          </span>
                        </p>
                        <div
                          className="flex items-center gap-2"
                          title={t("wholeAppHint", { app: group.appName })}
                        >
                          <span className="text-2xs text-muted-foreground">
                            {t("wholeApp")}
                          </span>
                          <div className="w-48">
                            <LevelControl
                              label={t("appLevelLabel", {
                                app: group.appName,
                              })}
                              level={app.level}
                              pending={
                                busyApp?.key === group.key
                                  ? busyApp.level
                                  : null
                              }
                              disabled={changing || screenShared}
                              onLevel={(next) =>
                                void setAppLevel(group, app.appId, next)
                              }
                            />
                          </div>
                        </div>
                      </div>
                      <div className={GRID}>
                        {group.windows.map((w) => (
                          <WindowTile
                            key={w.targetId}
                            item={w}
                            level={levelOf(w)}
                            viaApp={stateOf(w).wholeApp}
                            viaScreen={stateOf(w).wholeScreen}
                            pending={
                              busy?.targetId === w.targetId ? busy.level : null
                            }
                            disabled={changing || screenShared}
                            pictures={pictures}
                            onLevel={(next) => void setLevel(w, next)}
                          />
                        ))}
                      </div>
                    </section>
                  )
                })}
              </div>
            )}

            {unshareable.length > 0 && (
              <Collapsible
                open={showUnshareable}
                onOpenChange={setShowUnshareable}
              >
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <ChevronRight
                      className={cn(
                        "size-3.5 transition-transform rtl:rotate-180",
                        showUnshareable && "rotate-90 rtl:rotate-90"
                      )}
                    />
                    {t("unshareable", { count: unshareable.length })}
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <ul className="mt-2 divide-y overflow-hidden rounded-xl border">
                    {unshareable.map((w) => (
                      <li
                        key={w.targetId}
                        className="flex items-center gap-2.5 px-3 py-2"
                      >
                        <ShieldOff className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate text-xs">
                          <span className="font-medium">
                            {w.appName || t("unnamedApp")}
                          </span>
                          {/* The title, when it says more than the name. */}
                          {w.title && w.title !== w.appName && (
                            <span
                              className="text-muted-foreground"
                              title={w.title}
                            >
                              {" · "}
                              {w.title}
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 text-2xs text-muted-foreground">
                          {t(`notGrantable.${w.notGrantable}`)}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {unshareable.some((w) => w.notGrantable === "codeg") && (
                    <p className="mt-2 text-2xs leading-snug text-muted-foreground">
                      {t("codegWhy")}
                    </p>
                  )}
                </CollapsibleContent>
              </Collapsible>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
