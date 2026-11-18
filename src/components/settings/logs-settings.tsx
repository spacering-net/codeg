"use client"

import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import {
  Loader2,
  Pause,
  Play,
  RotateCw,
  Trash2,
  FolderOpen,
  ChevronRight,
  Plus,
  X,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Virtualizer } from "virtua"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  getLogSettings,
  getRecentLogs,
  listLogFiles,
  openLogsDir,
  readLogFile,
  setLogSettings,
  subscribeLogAppended,
  subscribeLogSettingsChanged,
} from "@/lib/api"
import { isDesktop, revealItemInDir } from "@/lib/platform"
import { toErrorMessage } from "@/lib/app-error"
import type {
  LogFileInfo,
  LogLevel,
  LogRecord,
  SpanInfo,
  TargetDirective,
} from "@/lib/types"
import { applyLogBatch } from "./log-buffer"

// Capture levels offered in the level dropdown (controls what the backend
// records). `off` disables capture entirely.
const CAPTURE_LEVELS: LogLevel[] = [
  "off",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
]

// View filter: minimum severity to display (client-side). "all" keeps every
// record currently in the buffer.
const VIEW_LEVELS = ["all", "error", "warn", "info", "debug", "trace"] as const

// Newest records kept in the DOM. A rendering bound (the backend ring buffer is
// the source of truth); aligned with the backend's buffer size.
const DISPLAY_LIMIT = 5000

// Animation frames to re-issue the open scroll-to-bottom. virtua measures
// dynamic (wrapping) row heights progressively after mount, so the scroll size
// keeps growing for a few frames and a single scroll lands at an early,
// estimated bottom. Re-pinning each frame keeps the view glued to the true
// bottom as it settles. Bounded so it always terminates.
const OPEN_SCROLL_REPIN_FRAMES = 6

// Mirror of the backend `READ_LOG_MAX_BYTES` (commands/logging.rs): a single
// file download returns at most the newest 16 MiB. Larger files come back
// truncated, which the download flow surfaces explicitly rather than passing a
// tail off as the complete log.
const READ_LOG_MAX_BYTES = 16 * 1024 * 1024

// Curated tracing targets offered as autocomplete suggestions for per-module
// overrides (free text is still allowed). Module paths under `codeg_lib`.
const CURATED_TARGETS = [
  "codeg_lib::acp",
  "codeg_lib::acp::delegation",
  "codeg_lib::web",
  "codeg_lib::chat_channel",
  "codeg_lib::db",
]

// A valid tracing target: `ident(::ident)*`. Rows failing this are flagged and
// excluded from the saved payload (EnvFilter would silently drop them anyway).
const TARGET_RE = /^[A-Za-z0-9_]+(::[A-Za-z0-9_]+)*$/

function validTargets(targets: TargetDirective[]): TargetDirective[] {
  return targets
    .map((t) => ({ ...t, target: t.target.trim() }))
    .filter((t) => TARGET_RE.test(t.target))
}

const LEVEL_RANK: Record<string, number> = {
  ERROR: 5,
  WARN: 4,
  INFO: 3,
  DEBUG: 2,
  TRACE: 1,
}

const MIN_RANK: Record<string, number> = {
  all: 0,
  trace: 1,
  debug: 2,
  info: 3,
  warn: 4,
  error: 5,
}

function rankOf(level: string): number {
  return LEVEL_RANK[level.toUpperCase()] ?? 0
}

function matchesFilter(
  r: LogRecord,
  minLevel: string,
  search: string
): boolean {
  if (rankOf(r.level) < (MIN_RANK[minLevel] ?? 0)) return false
  const q = search.trim().toLowerCase()
  if (q) {
    if (
      !r.message.toLowerCase().includes(q) &&
      !r.target.toLowerCase().includes(q)
    ) {
      return false
    }
  }
  return true
}

function levelBadgeClasses(level: string): string {
  switch (level.toUpperCase()) {
    case "ERROR":
      return "text-red-400"
    case "WARN":
      return "text-amber-400"
    case "INFO":
      return "text-sky-400"
    case "DEBUG":
      return "text-muted-foreground"
    default:
      return "text-muted-foreground/70"
  }
}

function formatTime(ms: number): string {
  const d = new Date(ms)
  const hh = String(d.getHours()).padStart(2, "0")
  const mm = String(d.getMinutes()).padStart(2, "0")
  const ss = String(d.getSeconds()).padStart(2, "0")
  const millis = String(d.getMilliseconds()).padStart(3, "0")
  return `${hh}:${mm}:${ss}.${millis}`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// Render the enclosing span chain as a root→leaf breadcrumb, e.g.
// `http{method=GET path=/x} › connection{connection_id=…}`.
function spanBreadcrumb(spans: SpanInfo[]): string {
  return spans
    .map((s) => {
      const f = Object.entries(s.fields)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")
      return f ? `${s.name}{${f}}` : s.name
    })
    .join(" › ")
}

// One log line. Memoized because the virtualized list re-renders often during a
// live tail; rows only re-render when their record/expanded state changes.
const LogRow = memo(function LogRow({
  record,
  expanded,
  onToggle,
}: {
  record: LogRecord
  expanded: boolean
  onToggle: (seq: number) => void
}) {
  const t = useTranslations("LogsSettings")
  const fieldEntries = Object.entries(record.fields)
  const hasDetail = record.spans.length > 0 || fieldEntries.length > 0

  return (
    <div className="border-b border-border/40 hover:bg-muted/40">
      <div className="flex gap-2 px-2 py-1">
        {hasDetail ? (
          <button
            type="button"
            onClick={() => onToggle(record.seq)}
            className="shrink-0 text-muted-foreground hover:text-foreground"
            aria-expanded={expanded}
            aria-label={t("toggleDetails")}
          >
            <ChevronRight
              className={`h-3 w-3 transition-transform ${
                expanded ? "rotate-90" : ""
              }`}
            />
          </button>
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {formatTime(record.timestamp_ms)}
        </span>
        <span
          className={`w-12 shrink-0 font-semibold uppercase ${levelBadgeClasses(
            record.level
          )}`}
        >
          {record.level}
        </span>
        <span
          className="shrink-0 truncate text-muted-foreground/80"
          style={{ maxWidth: "12rem" }}
          title={record.target}
        >
          {record.target}
        </span>
        <span className="whitespace-pre-wrap break-all text-foreground/90">
          {record.message}
        </span>
      </div>
      {expanded && hasDetail && (
        <div className="space-y-1 px-2 pb-2 pl-7 text-3xs text-muted-foreground">
          {record.spans.length > 0 && (
            <div className="break-all">
              <span className="text-muted-foreground/60">spans: </span>
              {spanBreadcrumb(record.spans)}
            </div>
          )}
          {fieldEntries.length > 0 && (
            <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
              {fieldEntries.map(([k, v]) => (
                <Fragment key={k}>
                  <span className="text-muted-foreground/60">{k}</span>
                  <span className="break-all text-foreground/80">{v}</span>
                </Fragment>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
})

export function LogsSettings() {
  const t = useTranslations("LogsSettings")
  const desktop = isDesktop()

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [savingLevel, setSavingLevel] = useState(false)

  const [captureLevel, setCaptureLevel] = useState<LogLevel>("info")
  const [targets, setTargets] = useState<TargetDirective[]>([])
  const [envLocked, setEnvLocked] = useState(false)
  const [records, setRecords] = useState<LogRecord[]>([])
  const [search, setSearch] = useState("")
  const [viewLevel, setViewLevel] = useState<string>("all")
  const [liveTail, setLiveTail] = useState(true)

  const [logFiles, setLogFiles] = useState<LogFileInfo[]>([])
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set())

  // Virtualized list wiring (mirrors sidebar-conversation-list): the real
  // OverlayScrollbars viewport is surfaced via onViewportRef and fed to virtua.
  const viewportRef = useRef<HTMLElement | null>(null)
  const [viewportEl, setViewportEl] = useState<HTMLElement | null>(null)
  const wasNearBottomRef = useRef(true)
  // Guards the scroll-to-newest on open (see effects below). Set once content is
  // first shown, and re-armed only on a true reset (records emptied — Clear or an
  // empty reload), so a Clear followed by a live-tail burst snaps to the newest.
  // A search that merely filters every row out leaves `records` intact, so it
  // does NOT re-arm and a scrolled-up reader keeps their place.
  const didInitialScrollRef = useRef(false)
  // Live-tail ingestion buffer, flushed once per animation frame.
  const pendingRef = useRef<LogRecord[]>([])
  const rafRef = useRef<number | null>(null)

  // Authoritative {level, targets}, updated synchronously by every save handler
  // so a queued write always reads the freshest combined state — a level save
  // and a target save can't clobber each other's field (the API persists the
  // whole object). Synced from loadInitial and the cross-window broadcast.
  const settingsRef = useRef<{ level: LogLevel; targets: TargetDirective[] }>({
    level: "info",
    targets: [],
  })
  // Serialize writes so out-of-order async resolution can't lose an update; an
  // in-flight counter drives the saving spinner until the queue drains.
  const saveChainRef = useRef<Promise<void>>(Promise.resolve())
  const inFlightRef = useRef(0)

  const handleViewportRef = useCallback((el: HTMLElement | null) => {
    viewportRef.current = el
    // virtua requires its scroll container to opt out of browser scroll
    // anchoring; otherwise the size changes from progressively measuring
    // wrapping rows fight the programmatic scroll-to-bottom. (A no-op on
    // WebKit, which has no scroll anchoring, but correct for the web/server
    // build on Chromium/Firefox.)
    if (el) el.style.overflowAnchor = "none"
    setViewportEl(el)
  }, [])

  const handleScroll = useCallback(() => {
    const el = viewportRef.current
    if (!el) return
    wasNearBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }, [])

  // Scroll the live-log viewport to its true bottom. Drives the real
  // OverlayScrollbars viewport directly (scrollTop ← scrollHeight) instead of
  // virtua's scrollToIndex — see the open-scroll effect for why. scrollHeight is
  // the current measured total, so it lands at the real bottom even while virtua
  // re-measures wrapping rows. No-op until the viewport is surfaced.
  const scrollViewportToBottom = useCallback(() => {
    const el = viewportRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [])

  const toggleExpanded = useCallback((seq: number) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(seq)) next.delete(seq)
      else next.add(seq)
      return next
    })
  }, [])

  const refreshLogs = useCallback(async () => {
    const recent = await getRecentLogs({ limit: DISPLAY_LIMIT })
    setRecords(recent)
  }, [])

  const loadInitial = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const [settings, recent, files] = await Promise.all([
        getLogSettings(),
        getRecentLogs({ limit: DISPLAY_LIMIT }),
        desktop ? Promise.resolve<LogFileInfo[]>([]) : listLogFiles(),
      ])
      setCaptureLevel(settings.level)
      setTargets(settings.targets ?? [])
      settingsRef.current = {
        level: settings.level,
        targets: settings.targets ?? [],
      }
      setEnvLocked(settings.env_locked)
      setRecords(recent)
      setLogFiles(files)
    } catch (err) {
      setLoadError(toErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [desktop])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial settings and log fetch
    loadInitial().catch((err) => {
      console.error("[LogsSettings] initial load failed:", err)
    })
  }, [loadInitial])

  // Cross-window sync of the capture level.
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    void (async () => {
      const dispose = await subscribeLogSettingsChanged((s) => {
        setCaptureLevel(s.level)
        setTargets(s.targets ?? [])
        settingsRef.current = { level: s.level, targets: s.targets ?? [] }
      })
      if (disposed) dispose()
      else unlisten = dispose
    })()
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  // Live tail: coalesce incoming records via requestAnimationFrame so a burst of
  // events becomes one state update instead of one setState per record. The
  // monotonic-seq de-dup and the display cap are applied once per flush in
  // applyLogBatch.
  useEffect(() => {
    if (!liveTail) return
    let disposed = false
    let unlisten: (() => void) | undefined

    const flush = () => {
      rafRef.current = null
      const batch = pendingRef.current
      if (batch.length === 0) return
      pendingRef.current = []
      setRecords((prev) => applyLogBatch(prev, batch, DISPLAY_LIMIT))
    }

    void (async () => {
      const dispose = await subscribeLogAppended((record) => {
        pendingRef.current.push(record)
        if (rafRef.current == null) {
          rafRef.current = requestAnimationFrame(flush)
        }
      })
      if (disposed) dispose()
      else unlisten = dispose
    })()

    return () => {
      disposed = true
      unlisten?.()
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      pendingRef.current = []
    }
  }, [liveTail])

  const visible = useMemo(
    () => records.filter((r) => matchesFilter(r, viewLevel, search)),
    [records, viewLevel, search]
  )

  // Newest record seq (monotonic), or null when the buffer is empty. Drives the
  // stick effect: a new append always advances it — even at the display cap,
  // where the record count holds steady — while a search/level filter leaves
  // `records` untouched, so re-filtering never triggers a follow.
  const latestRecordSeq =
    records.length > 0 ? records[records.length - 1].seq : null
  // Newest seq the stick effect has already seen, so it follows only genuine
  // appends to an already-populated list.
  const seenSeqRef = useRef<number | null>(null)

  // Follow new records to the bottom while live-tailing, but only when the
  // reader is already near the bottom (tracked on scroll) — never yank someone
  // who scrolled up to read history. The initial jump (and the re-jump after a
  // Clear/reload) is the open-scroll effect's job, so this skips the first
  // population: it scrolls only when the newest seq strictly advances past one
  // already seen.
  useEffect(() => {
    const prev = seenSeqRef.current
    seenSeqRef.current = latestRecordSeq
    if (latestRecordSeq == null || prev == null || latestRecordSeq <= prev)
      return
    if (!liveTail || !wasNearBottomRef.current) return
    scrollViewportToBottom()
  }, [latestRecordSeq, liveTail, scrollViewportToBottom])

  // A true reset (records emptied via Clear, or an empty (re)load) re-arms the
  // open-scroll so the next records to arrive — e.g. a live-tail burst right
  // after Clear — snap to the newest. Keyed on records, not the viewport, so a
  // search that filters every row out (records intact) does not re-arm.
  useEffect(() => {
    if (records.length === 0) didInitialScrollRef.current = false
  }, [records.length])

  // Open at the newest record. The stick effect above can't cover the open: it
  // fires when records first load, but the viewport (and virtua) mount only once
  // onViewportRef surfaces the scroll container a few frames later, by which
  // point the stick deps are stable and it never re-runs. So scroll when the
  // viewport is first ready with content (the guard isn't set until a frame
  // actually fires, so an empty initial load still snaps to the bottom when the
  // first log lands).
  //
  // Three subtleties drive the shape below:
  //  - Scroll the real viewport (scrollTop ← scrollHeight) rather than virtua's
  //    scrollToIndex. A freshly-mounted virtua list driven by scrollToIndex can
  //    land the scroll *position* at the bottom yet leave the rendered window
  //    stuck on a blank, far target until a manual scroll nudges it — exactly
  //    the symptom we hit. A genuine scrollTop change is the path virtua renders
  //    from reliably (it is what the user's manual nudge does).
  //  - A single scroll at mount lands short — the OverlayScrollbars viewport
  //    (inits with `defer`) and virtua measure wrapping rows over several frames,
  //    so scrollHeight keeps growing. Re-pin for a bounded window of frames (rAF,
  //    like the sidebar list) so the view stays glued to the true bottom.
  //  - Latch on the first *fired* frame, not at schedule time: if a dependency
  //    changes between scheduling and that frame (e.g. a live-tail record landing
  //    as the page opens), the effect re-runs — and the cleanup cancels the
  //    pending frame. Latching at schedule would make that re-run skip and the
  //    scroll never happen; latching on fire lets it reschedule instead. Once a
  //    frame fires, later record changes are the stick effect's job.
  useEffect(() => {
    if (didInitialScrollRef.current || !viewportEl || visible.length === 0)
      return
    let raf = 0
    let frames = 0
    const pin = () => {
      didInitialScrollRef.current = true
      scrollViewportToBottom()
      frames += 1
      if (frames < OPEN_SCROLL_REPIN_FRAMES) raf = requestAnimationFrame(pin)
    }
    raf = requestAnimationFrame(pin)
    return () => cancelAnimationFrame(raf)
  }, [viewportEl, visible.length, scrollViewportToBottom])

  const queueSave = useCallback(() => {
    inFlightRef.current += 1
    setSavingLevel(true)
    saveChainRef.current = saveChainRef.current.then(async () => {
      try {
        await setLogSettings({
          level: settingsRef.current.level,
          targets: validTargets(settingsRef.current.targets),
        })
      } catch (err) {
        toast.error(t("levelSaveFailed"), { description: toErrorMessage(err) })
      } finally {
        inFlightRef.current -= 1
        if (inFlightRef.current === 0) setSavingLevel(false)
      }
    })
  }, [t])

  const handleLevelChange = useCallback(
    (value: string) => {
      const level = value as LogLevel
      settingsRef.current = { ...settingsRef.current, level }
      setCaptureLevel(level)
      queueSave()
    },
    [queueSave]
  )

  // Update targets in the authoritative ref (synchronously) and React state.
  // Whether to save is the caller's choice (not while a name is being typed).
  const updateTargets = useCallback((next: TargetDirective[]) => {
    settingsRef.current = { ...settingsRef.current, targets: next }
    setTargets(next)
  }, [])

  const handleAddTarget = useCallback(() => {
    // Local-only blank row; persisted once it holds a valid target (on blur).
    updateTargets([
      ...settingsRef.current.targets,
      { target: "", level: "debug" },
    ])
  }, [updateTargets])

  const handleTargetNameChange = useCallback(
    (index: number, target: string) => {
      updateTargets(
        settingsRef.current.targets.map((row, i) =>
          i === index ? { ...row, target } : row
        )
      )
    },
    [updateTargets]
  )

  const handleTargetLevelChange = useCallback(
    (index: number, level: LogLevel) => {
      updateTargets(
        settingsRef.current.targets.map((row, i) =>
          i === index ? { ...row, level } : row
        )
      )
      queueSave()
    },
    [updateTargets, queueSave]
  )

  const handleRemoveTarget = useCallback(
    (index: number) => {
      updateTargets(settingsRef.current.targets.filter((_, i) => i !== index))
      queueSave()
    },
    [updateTargets, queueSave]
  )

  const handleOpenFolder = useCallback(async () => {
    try {
      const path = await openLogsDir()
      // `revealItemInDir` (not `openPath`): the opener plugin's path scope
      // rejects the hidden `~/.codeg/logs` path under its require-literal-
      // leading-dot Unix default, whereas reveal is not scope-checked.
      await revealItemInDir(path)
    } catch (err) {
      toast.error(t("openFolderFailed"), { description: toErrorMessage(err) })
    }
  }, [t])

  const handleDownload = useCallback(
    async (file: LogFileInfo) => {
      try {
        const content = await readLogFile(file.name)
        // Files past the backend read cap come back as the newest slice only;
        // mark the download name and warn so a tail is never mistaken for the
        // full log (the complete file stays in the logs directory on disk).
        const truncated = file.size_bytes > READ_LOG_MAX_BYTES
        const downloadName = truncated
          ? `${file.name.replace(/\.log$/, "")}.tail.log`
          : file.name
        const blob = new Blob([content], { type: "text/plain" })
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement("a")
        anchor.href = url
        anchor.download = downloadName
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        URL.revokeObjectURL(url)
        if (truncated) {
          toast.info(
            t("downloadTruncated", { size: formatBytes(READ_LOG_MAX_BYTES) })
          )
        }
      } catch (err) {
        toast.error(t("downloadFailed"), { description: toErrorMessage(err) })
      }
    },
    [t]
  )

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("loading")}
      </div>
    )
  }

  return (
    <ScrollArea className="h-full">
      <div className="w-full space-y-4 p-3 md:p-4">
        <section className="space-y-1">
          <h1 className="text-sm font-semibold">{t("sectionTitle")}</h1>
          <p className="text-xs text-muted-foreground">
            {t("sectionDescription")}
          </p>
        </section>

        {loadError && (
          <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400">
            {loadError}
          </div>
        )}

        {/* Capture level */}
        <section className="space-y-3 rounded-xl border bg-card p-4">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold">{t("captureTitle")}</h2>
            <p className="text-xs leading-5 text-muted-foreground">
              {t("captureDescription")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {t("captureLabel")}
            </span>
            <Select
              value={captureLevel}
              onValueChange={handleLevelChange}
              disabled={envLocked}
            >
              <SelectTrigger
                className="h-8 w-40 text-xs"
                disabled={savingLevel || envLocked}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CAPTURE_LEVELS.map((level) => (
                  <SelectItem key={level} value={level} className="text-xs">
                    {t(`levels.${level}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {savingLevel && (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
            )}
          </div>
          {envLocked && (
            <p className="text-2xs text-amber-500">{t("captureEnvLocked")}</p>
          )}

          {/* Per-module overrides */}
          <div className="space-y-2 border-t pt-3">
            <div className="flex items-center justify-between gap-2">
              <div className="space-y-0.5">
                <h3 className="text-xs font-semibold">{t("targetsTitle")}</h3>
                <p className="text-2xs leading-4 text-muted-foreground">
                  {t("targetsDescription")}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={handleAddTarget}
                disabled={envLocked}
              >
                <Plus className="h-3.5 w-3.5" />
                {t("targetsAdd")}
              </Button>
            </div>
            {targets.length > 0 && (
              <div className="space-y-1.5">
                {targets.map((row, i) => {
                  const trimmed = row.target.trim()
                  const invalid = trimmed !== "" && !TARGET_RE.test(trimmed)
                  return (
                    <div key={i} className="flex items-center gap-2">
                      <Input
                        value={row.target}
                        onChange={(e) =>
                          handleTargetNameChange(i, e.target.value)
                        }
                        onBlur={queueSave}
                        placeholder="codeg_lib::acp"
                        list="codeg-log-targets"
                        disabled={envLocked}
                        className={`h-8 flex-1 text-xs ${
                          invalid ? "border-red-500/60" : ""
                        }`}
                      />
                      <Select
                        value={row.level}
                        onValueChange={(v) =>
                          handleTargetLevelChange(i, v as LogLevel)
                        }
                        disabled={envLocked}
                      >
                        <SelectTrigger className="h-8 w-28 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {CAPTURE_LEVELS.map((level) => (
                            <SelectItem
                              key={level}
                              value={level}
                              className="text-xs"
                            >
                              {t(`levels.${level}`)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 shrink-0"
                        onClick={() => handleRemoveTarget(i)}
                        disabled={envLocked}
                        aria-label={t("targetsRemove")}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  )
                })}
                <datalist id="codeg-log-targets">
                  {CURATED_TARGETS.map((tgt) => (
                    <option key={tgt} value={tgt} />
                  ))}
                </datalist>
              </div>
            )}
          </div>
        </section>

        {/* Viewer */}
        <section className="space-y-3 rounded-xl border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="space-y-1">
              <h2 className="text-sm font-semibold">{t("viewerTitle")}</h2>
              <p className="text-xs leading-5 text-muted-foreground">
                {t("viewerDescription")}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant={liveTail ? "default" : "outline"}
                onClick={() => setLiveTail((v) => !v)}
              >
                {liveTail ? (
                  <Pause className="h-3.5 w-3.5" />
                ) : (
                  <Play className="h-3.5 w-3.5" />
                )}
                {liveTail ? t("pause") : t("resume")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  refreshLogs().catch((err) => {
                    console.error("[LogsSettings] refresh failed:", err)
                  })
                }}
              >
                <RotateCw className="h-3.5 w-3.5" />
                {t("refresh")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setRecords([])}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t("clear")}
              </Button>
              {desktop && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    handleOpenFolder().catch((err) => {
                      console.error("[LogsSettings] open folder failed:", err)
                    })
                  }}
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  {t("openFolder")}
                </Button>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("searchPlaceholder")}
              className="h-8 max-w-xs text-xs"
            />
            <Select value={viewLevel} onValueChange={setViewLevel}>
              <SelectTrigger className="h-8 w-32 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VIEW_LEVELS.map((level) => (
                  <SelectItem key={level} value={level} className="text-xs">
                    {t(`viewLevels.${level}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-2xs text-muted-foreground">
              {t("shownCount", {
                shown: visible.length,
                total: records.length,
              })}
            </span>
          </div>

          <div className="h-[30rem] rounded-md border bg-background/50 font-mono text-2xs leading-5">
            {visible.length === 0 ? (
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                {t("empty")}
              </div>
            ) : (
              <ScrollArea
                className="h-full"
                onViewportRef={handleViewportRef}
                onScroll={handleScroll}
              >
                {viewportEl && (
                  <Virtualizer scrollRef={viewportRef} itemSize={28}>
                    {visible.map((r) => (
                      <LogRow
                        key={r.seq}
                        record={r}
                        expanded={expanded.has(r.seq)}
                        onToggle={toggleExpanded}
                      />
                    ))}
                  </Virtualizer>
                )}
              </ScrollArea>
            )}
          </div>
        </section>

        {/* On-disk files (web mode: download for history beyond the buffer) */}
        {!desktop && (
          <section className="space-y-3 rounded-xl border bg-card p-4">
            <div className="space-y-1">
              <h2 className="text-sm font-semibold">{t("filesTitle")}</h2>
              <p className="text-xs leading-5 text-muted-foreground">
                {t("filesDescription")}
              </p>
            </div>
            {logFiles.length === 0 ? (
              <p className="text-2xs text-muted-foreground">
                {t("filesEmpty")}
              </p>
            ) : (
              <div className="space-y-1">
                {logFiles.map((file) => (
                  <div
                    key={file.name}
                    className="flex items-center justify-between gap-2 rounded-md border px-3 py-1.5"
                  >
                    <span className="truncate font-mono text-xs">
                      {file.name}
                    </span>
                    <div className="flex shrink-0 items-center gap-3">
                      <span className="text-2xs text-muted-foreground">
                        {formatBytes(file.size_bytes)}
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          handleDownload(file).catch((err) => {
                            console.error(
                              "[LogsSettings] download failed:",
                              err
                            )
                          })
                        }}
                      >
                        {t("download")}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </ScrollArea>
  )
}
