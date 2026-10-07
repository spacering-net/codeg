"use client"

import {
  useState,
  useEffect,
  useLayoutEffect,
  useCallback,
  useRef,
  useImperativeHandle,
  forwardRef,
  type ReactNode,
} from "react"
import { useTranslations } from "next-intl"
import {
  Check,
  ChevronRight,
  Home,
  Loader2,
  UndoDot,
  type LucideIcon,
} from "lucide-react"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useImeGuard } from "@/hooks/use-ime-guard"
import { cn } from "@/lib/utils"
import { getHomeDirectory, listDirectoryEntries } from "@/lib/api"
import { parentFsPath } from "@/lib/path-utils"
import type { DirectoryEntry } from "@/lib/types"

/**
 * Strip trailing separators (POSIX `/` or Windows `\`) so otherwise-equivalent
 * paths compare equal for the row highlight; an all-separator root is left
 * intact rather than collapsed away.
 */
export const normalizeFsPath = (path: string) =>
  path.replace(/[/\\]+$/, "") || path

// One nesting level, in px. Matches the file tree's own step
// (FILE_TREE_INDENT_STEP_REM) so every tree in the app indents alike — roughly
// one leading-glyph width, which keeps deep paths inside a dialog's width.
const INDENT_STEP_PX = 16

// Synchronous layout effect on the client (so the session/selection guards see
// the latest committed values before any pending async work resolves), but a
// passive effect during the static-export prerender to avoid the SSR warning.
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect

export interface DirectoryBrowserHandle {
  /**
   * Validate the typed/selected path and return it, or `null` when it is not a
   * readable directory (an inline error is shown in that case). Hosts call this
   * from their own confirm button so the panel stays presentational about
   * *when* a selection is committed while still owning *how* it is validated.
   *
   * The panel keeps the pending flag itself and reports it through
   * `onBusyChange` — a confirm that outlives its browsing session deliberately
   * never clears it, so a stale round trip can't re-enable a newer session's
   * button.
   */
  confirm: () => Promise<string | null>
}

interface DirectoryBrowserProps {
  /**
   * Whether the panel is currently shown. Every transition to `true` starts a
   * fresh browsing session: state is reset and in-flight requests from the
   * previous session are discarded rather than landing in the new one.
   */
  active: boolean
  /** Directory to open at; defaults to the user's home. */
  initialPath?: string
  /** Currently highlighted path (the value the host would commit). */
  value: string
  onValueChange: (path: string) => void
  /** Double-clicking a row commits it directly. */
  onQuickSelect?: (path: string) => void
  /** Mirrors the panel's in-flight confirm so hosts can disable their button. */
  onBusyChange?: (busy: boolean) => void
  /** Turns rows into checkboxes; `value` still tracks the last row clicked. */
  multiple?: boolean
  selectedPaths?: string[]
  onToggleSelected?: (path: string) => void
  /**
   * Rendered inside the path box, at its trailing edge. Hosts use it for
   * shortcuts that belong to the path itself (the native picker, say) instead
   * of parking them in a far-away footer.
   */
  pathInputAction?: ReactNode
  /** Tailwind height for the scroll area. */
  heightClassName?: string
}

/**
 * Server-side directory tree browser. Extracted from `DirectoryBrowserDialog`
 * so it can also be embedded in multi-step flows (the workspace folder dialog)
 * without nesting one dialog inside another.
 */
export const DirectoryBrowser = forwardRef<
  DirectoryBrowserHandle,
  DirectoryBrowserProps
>(function DirectoryBrowser(
  {
    active,
    initialPath,
    value,
    onValueChange,
    onQuickSelect,
    onBusyChange,
    multiple = false,
    selectedPaths,
    onToggleSelected,
    pathInputAction,
    heightClassName = "h-[18.75rem]",
  },
  ref
) {
  const t = useTranslations("DirectoryBrowser")
  const ime = useImeGuard()

  const [rootPath, setRootPath] = useState("")
  const [entries, setEntries] = useState<Map<string, DirectoryEntry[]>>(
    new Map()
  )
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  const initialized = useRef(false)
  // Monotonic session id, bumped synchronously on every real show/hide
  // transition. Async flows capture it before awaiting and discard their writes
  // when it changes, so a slow request from a previous session can't clobber —
  // or expose — state in a newer one. Guarding on the previous `active` keeps
  // the bump idempotent under StrictMode's mount-time effect replay (which
  // would otherwise bump again and strand the first init's in-flight writes).
  const sessionGen = useRef(0)
  const prevActive = useRef(active)
  useIsomorphicLayoutEffect(() => {
    if (prevActive.current !== active) {
      prevActive.current = active
      sessionGen.current += 1
    }
  }, [active])
  // Monotonic navigation id. Each navigateTo() bumps it and the open-time init()
  // captures it, so within a single session a slower earlier navigation (or a
  // late init) can't overwrite the destination of a newer one — the latest user
  // intent always wins.
  const navSeq = useRef(0)
  // Latest committed value, mirrored synchronously so a confirm validation can
  // tell the selection moved (within the session) before its check resolved.
  const valueRef = useRef(value)
  useIsomorphicLayoutEffect(() => {
    valueRef.current = value
  }, [value])

  const busyRef = useRef(onBusyChange)
  useIsomorphicLayoutEffect(() => {
    busyRef.current = onBusyChange
  }, [onBusyChange])
  useEffect(() => {
    busyRef.current?.(confirming)
  }, [confirming])

  const loadEntries = useCallback(
    async (path: string): Promise<DirectoryEntry[] | null> => {
      // Already cached
      if (entries.has(path)) return entries.get(path)!

      const gen = sessionGen.current
      setLoading((prev) => new Set(prev).add(path))
      setError(null)
      try {
        const result = await listDirectoryEntries(path)
        // Skip writes if a hide/show happened mid-flight — they belong to a
        // session that no longer exists and would surface stale data.
        if (gen === sessionGen.current) {
          setEntries((prev) => new Map(prev).set(path, result))
        }
        return result
      } catch {
        if (gen === sessionGen.current) setError(t("errorLoadingDir"))
        return null
      } finally {
        if (gen === sessionGen.current) {
          setLoading((prev) => {
            const next = new Set(prev)
            next.delete(path)
            return next
          })
        }
      }
    },
    [entries, t]
  )

  const navigateTo = useCallback(
    async (path: string) => {
      const gen = sessionGen.current
      const seq = (navSeq.current += 1)
      const result = await loadEntries(path)
      // Discard if a newer navigation started, or the load outlived its session
      // (hide/show), so the most recent navigation wins.
      if (gen !== sessionGen.current || seq !== navSeq.current) return
      if (result !== null) {
        setRootPath(path)
        onValueChange(path)
        setExpandedPaths(new Set())
      }
    },
    [loadEntries, onValueChange]
  )

  // Initialize when shown
  useEffect(() => {
    if (!active) {
      initialized.current = false
      return
    }
    if (initialized.current) return
    initialized.current = true

    const gen = sessionGen.current
    const seq = navSeq.current

    // Reset synchronously so a re-shown panel never displays — or lets the user
    // confirm — the previous session's path while the start dir is loading.
    setRootPath("")
    onValueChange(initialPath ?? "")
    setExpandedPaths(new Set())
    setEntries(new Map())
    setError(null)
    setLoading(new Set())
    setConfirming(false)

    const init = async () => {
      try {
        const startPath = initialPath || (await getHomeDirectory())
        // Drop these writes if a hide/show superseded this init, or the user
        // already navigated somewhere else while the start dir was loading.
        if (gen !== sessionGen.current || seq !== navSeq.current) return
        setRootPath(startPath)
        onValueChange(startPath)
        setLoading(new Set([startPath]))

        const result = await listDirectoryEntries(startPath)
        if (gen !== sessionGen.current || seq !== navSeq.current) return
        setEntries(new Map([[startPath, result]]))
        setLoading(new Set())
      } catch {
        if (gen !== sessionGen.current || seq !== navSeq.current) return
        setError(t("errorLoadingDir"))
        setLoading(new Set())
      }
    }
    init()
    // `onValueChange` is intentionally omitted: it changes identity on every
    // host render and re-running init would restart browsing mid-session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, initialPath, t])

  const handleToggleExpand = useCallback(
    async (path: string) => {
      if (expandedPaths.has(path)) {
        setExpandedPaths((prev) => {
          const next = new Set(prev)
          next.delete(path)
          return next
        })
        return
      }
      const gen = sessionGen.current
      await loadEntries(path)
      if (gen !== sessionGen.current) return
      // Functional update so two folders expanded concurrently compose instead
      // of overwriting each other with a stale snapshot.
      setExpandedPaths((prev) => new Set(prev).add(path))
    },
    [expandedPaths, loadEntries]
  )

  useImperativeHandle(
    ref,
    () => ({
      confirm: async () => {
        const path = value.trim()
        if (!path || confirming) return null
        // Validate the path is a real, readable directory before committing.
        // Visited dirs (clicked rows / navigated roots) are served from the
        // entries cache, so this is instant in the common case; a typed path is
        // verified here and leaves an inline error on failure.
        const gen = sessionGen.current
        setConfirming(true)
        const result = await loadEntries(path)
        // A stale confirm from a previous session must not touch the new
        // session's state — not even its spinner — so bail before clearing.
        if (gen !== sessionGen.current) return null
        setConfirming(false)
        // Within the session, still bail if the selection moved while
        // validating (e.g. the user picked another directory after pressing).
        if (valueRef.current.trim() !== path) return null
        return result !== null ? path : null
      },
    }),
    [value, confirming, loadEntries]
  )

  const handleNavigateUp = useCallback(() => {
    const parent = parentFsPath(value.trim() || rootPath)
    if (!parent) return
    navigateTo(parent)
  }, [value, rootPath, navigateTo])

  const handleGoHome = useCallback(async () => {
    const gen = sessionGen.current
    try {
      const home = await getHomeDirectory()
      if (gen !== sessionGen.current) return
      navigateTo(home)
    } catch {
      if (gen !== sessionGen.current) return
      setError(t("errorLoadingDir"))
    }
  }, [navigateTo, t])

  const handlePathInputKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (ime.isComposing(e)) return
      if (e.key === "Enter" && value.trim()) {
        navigateTo(value.trim())
      }
    },
    [ime, value, navigateTo]
  )

  const selectedSet = new Set((selectedPaths ?? []).map(normalizeFsPath))

  const renderEntries = (parentPath: string, depth: number) => {
    const children = entries.get(parentPath)
    const isLoading = loading.has(parentPath)

    if (isLoading) {
      return (
        <div
          className="flex items-center gap-2 py-2 text-sm text-muted-foreground"
          style={{ paddingLeft: `${depth * INDENT_STEP_PX + 8}px` }}
        >
          <Loader2 className="size-3.5 animate-spin" />
          <span>{t("loading")}</span>
        </div>
      )
    }

    if (!children) return null

    if (children.length === 0) {
      return (
        <div
          className="py-2 text-sm text-muted-foreground"
          style={{ paddingLeft: `${depth * INDENT_STEP_PX + 28}px` }}
        >
          {t("emptyDirectory")}
        </div>
      )
    }

    return children.map((entry) => {
      const isExpanded = expandedPaths.has(entry.path)
      const normalized = normalizeFsPath(entry.path)
      const isChecked = selectedSet.has(normalized)
      const isCursor = normalized === normalizeFsPath(value)

      return (
        <div key={entry.path}>
          <button
            className={cn(
              "flex w-full items-center gap-1 rounded px-2 py-1 text-left text-sm transition-colors hover:bg-muted/50",
              !multiple && isCursor && "bg-accent text-accent-foreground",
              multiple && isChecked && "bg-accent/60 text-accent-foreground"
            )}
            style={{ paddingLeft: `${depth * INDENT_STEP_PX + 8}px` }}
            onClick={() => {
              onValueChange(entry.path)
              if (multiple) onToggleSelected?.(entry.path)
            }}
            onDoubleClick={() => {
              if (!multiple) onQuickSelect?.(entry.path)
            }}
            type="button"
            aria-pressed={multiple ? isChecked : undefined}
          >
            <span
              className="shrink-0 p-0.5"
              onClick={(e) => {
                e.stopPropagation()
                if (entry.hasChildren) {
                  handleToggleExpand(entry.path)
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.stopPropagation()
                  if (entry.hasChildren) {
                    handleToggleExpand(entry.path)
                  }
                }
              }}
              role="button"
              tabIndex={0}
            >
              <ChevronRight
                className={cn(
                  "size-3.5 text-muted-foreground transition-transform",
                  isExpanded && "rotate-90",
                  !entry.hasChildren && "invisible"
                )}
              />
            </span>
            {multiple ? (
              <span
                aria-hidden
                className={cn(
                  "flex size-4 shrink-0 items-center justify-center rounded-[0.25rem] border",
                  isChecked
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border"
                )}
              >
                {isChecked ? <Check className="size-3" /> : null}
              </span>
            ) : null}
            {/* Chevron only: every row here IS a directory, so a folder icon
                beside the expand arrow adds nothing but width. */}
            <span className="truncate">{entry.name}</span>
          </button>
          {isExpanded && renderEntries(entry.path, depth + 1)}
        </div>
      )
    })
  }

  return (
    <div className="space-y-3">
      {/* The app mounts no global tooltip provider — each surface brings its
          own, and Radix throws without one. */}
      <TooltipProvider delayDuration={200}>
        <InputGroup className="h-8">
          <InputGroupAddon align="inline-start" className="gap-0.5 py-0">
            <NavButton icon={Home} label={t("goHome")} onClick={handleGoHome} />
            <NavButton
              icon={UndoDot}
              label={t("navigateUp")}
              onClick={handleNavigateUp}
            />
          </InputGroupAddon>
          <InputGroupInput
            value={value}
            onChange={(e) => onValueChange(e.target.value)}
            {...ime.props}
            onKeyDown={handlePathInputKeyDown}
            placeholder={t("pathPlaceholder")}
            className="h-8 text-sm font-mono"
          />
          {pathInputAction ? (
            <InputGroupAddon align="inline-end" className="py-0">
              {pathInputAction}
            </InputGroupAddon>
          ) : null}
        </InputGroup>
      </TooltipProvider>

      <ScrollArea className={cn(heightClassName, "rounded-md border")}>
        <div className="p-1">
          {renderEntries(rootPath, 0)}
          {error && !loading.size && (
            <div className="p-4 text-center text-sm text-destructive">
              {error}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
})

/**
 * Icon-only navigation shortcut for the leading edge of the path box. The label
 * lives in a tooltip so the whole row reads as one control, and is mirrored onto
 * `aria-label` so the button still has an accessible name.
 */
function NavButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: LucideIcon
  label: string
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <InputGroupButton
          size="icon-xs"
          variant="ghost"
          type="button"
          onClick={onClick}
          aria-label={label}
        >
          <Icon className="size-3.5" />
        </InputGroupButton>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
