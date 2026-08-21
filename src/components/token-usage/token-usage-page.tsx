"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react"
import { useTranslations, useLocale } from "next-intl"
import { toast } from "sonner"
import {
  ArrowDownRight,
  ArrowUpRight,
  Bot,
  ChartNoAxesColumn,
  Cpu,
  DatabaseBackup,
  Folder,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
  Share2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import { WorkbenchPageTitle } from "@/components/workbench/workbench-page-title"
import { FolderAliasLabel } from "@/components/conversations/folder-alias-label"
import { formatFolderLabelWithAlias } from "@/lib/folder-display"
import {
  tokenUsageFacets,
  tokenUsageReport,
  tokenUsageStatus,
  tokenUsageSync,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { getAgentLabel } from "@/lib/custom-agents"
import { subscribe } from "@/lib/platform"
import { formatTokenCount } from "@/lib/token-format"
import { averageOutputTps, formatTokPerSec } from "@/lib/token-speed"
import {
  averagePerActiveDay,
  averagePerConversation,
  averageTurnsPerConversation,
  buildHeatMatrix,
  cacheHitRate,
  computeDelta,
  deriveArchetype,
  foldBreakdown,
  formatDuration,
  formatTokensPrecise,
  freshTokens,
  idleDays,
  localTzOffsetMinutes,
  peakHour,
  peakPoint,
  resolveRange,
  shareCardFilename,
  suggestBucket,
  type TokenUsageRangePreset,
} from "@/lib/token-usage"
import { cn } from "@/lib/utils"
import type {
  AgentType,
  TokenUsageBucket,
  TokenUsageFacets,
  TokenUsageReport,
  TokenUsageSyncProgress,
  TokenUsageSyncStatus,
} from "@/lib/types"
import {
  ACCENT,
  ActivityHeatmap,
  INK,
  INK_FAINT,
  INK_SOFT,
  NEUTRAL,
  RankedBars,
  RingMeter,
  TrendChart,
  type RankedDatum,
} from "./charts"
import {
  CustomRangeFields,
  MultiSelectFilter,
  SegmentedFilter,
  SingleSelectFilter,
} from "./token-usage-filters"
import {
  ARCHETYPE_DESC_KEYS,
  ARCHETYPE_EMOJI,
  ARCHETYPE_LABEL_KEYS,
  CARD_HEIGHT,
  CARD_WIDTH,
  resolveShareCardTheme,
  ShareCard,
  type ShareCardTheme,
} from "./share-card"

const SYNC_PROGRESS_EVENT = "token-usage-sync://progress"
/** Fired once per batch import — see `CONVERSATIONS_BULK_CHANGED_EVENT` in
 *  `web/event_bridge.rs`. */
const CONVERSATIONS_BULK_CHANGED_EVENT = "conversations://bulk-changed"

/** How much the on-screen preview shrinks the full-size card. */
const CARD_PREVIEW_SCALE = 0.5

/** Whether this runtime can put an image on the clipboard. WKWebView and older
 *  browsers expose `navigator.clipboard` without `write`/`ClipboardItem`, so
 *  feature-detect both rather than assuming. */
function canCopyImages(): boolean {
  return (
    typeof ClipboardItem !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.write === "function"
  )
}

/** Rows shown before the tail folds into "Other" — past this a ranked list
 *  stops being a ranking and starts being a table. */
const BREAKDOWN_LIMIT = 7

const RANGE_LABEL_KEYS = {
  "7d": "range7d",
  "30d": "range30d",
  "90d": "range90d",
  thisMonth: "rangeThisMonth",
  thisYear: "rangeThisYear",
  all: "rangeAll",
  custom: "rangeCustom",
} as const satisfies Record<TokenUsageRangePreset, string>

/** The one-click segments; everything else folds into the "more" pill so the
 *  toolbar keeps to one calm row. */
const HOT_RANGE_PRESETS = ["7d", "30d", "90d"] as const
const MORE_RANGE_PRESETS = ["thisMonth", "thisYear", "all", "custom"] as const

const BUCKET_LABEL_KEYS = {
  day: "bucketDay",
  week: "bucketWeek",
  month: "bucketMonth",
} as const satisfies Record<TokenUsageBucket, string>

/** Unit nouns for prose ("busiest day"), distinct from the segmented-control
 *  labels above — zh renders those as 按天/按周/按月, which is ungrammatical
 *  mid-sentence. */
const BUCKET_UNIT_KEYS = {
  day: "bucketUnitDay",
  week: "bucketUnitWeek",
  month: "bucketUnitMonth",
} as const satisfies Record<TokenUsageBucket, string>

const WEEKDAY_KEYS = [
  "weekMon",
  "weekTue",
  "weekWed",
  "weekThu",
  "weekFri",
  "weekSat",
  "weekSun",
] as const

type BreakdownDim = "folder" | "agent" | "model"

/** Page title in the window-chrome strip — the shared breadcrumb header, same
 *  as the Tasks and Automations routes. */
export function TokenUsagePageTitle() {
  const t = useTranslations("TokenUsage")
  return <WorkbenchPageTitle title={t("title")} />
}

/** One cell of the connected stats strip under the hero. */
function StatCell({
  label,
  value,
  hint,
  className,
}: {
  label: string
  value: string
  hint?: string
  className?: string
}) {
  return (
    <div className={cn("border-border px-5 py-4", className)}>
      <div className="text-xs text-muted-foreground">{label}</div>
      {/* Proportional figures on purpose — tabular digits look loose at this
          size and nothing needs to align vertically here. */}
      <div className="mt-1.5 text-xl font-semibold leading-tight tracking-tight">
        {value}
      </div>
      {hint ? (
        <div className="mt-1 truncate text-[0.6875rem] text-muted-foreground">
          {hint}
        </div>
      ) : null}
    </div>
  )
}

function Panel({
  title,
  hint,
  icon: Icon,
  actions,
  children,
  className,
}: {
  title: string
  hint?: string
  icon?: ComponentType<{ className?: string }>
  /** Right-aligned header slot — e.g. a segmented toggle. */
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    // flex-col so a child marked flex-1 (the heatmap) can absorb the extra
    // height a side-by-side grid row hands the card.
    <section
      className={cn(
        "flex flex-col rounded-xl border border-border bg-card p-4",
        className
      )}
    >
      <header className="mb-3 flex shrink-0 flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5 text-[0.8125rem] font-semibold">
            {Icon ? (
              <Icon
                className="size-3.5 text-muted-foreground"
                aria-hidden="true"
              />
            ) : null}
            {title}
          </h2>
          {hint ? (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {hint}
            </p>
          ) : null}
        </div>
        {actions}
      </header>
      {children}
    </section>
  )
}

/** The neutral "vs previous period" chip beside the hero figure. Spend going
 *  up is not good or bad, so the badge never wears a status colour. */
function DeltaBadge({
  delta,
  newLabel,
  title,
}: {
  delta: { ratio: number | null; direction: "up" | "down" | "flat" }
  newLabel: string
  title: string
}) {
  // Flat covers both "unchanged" and "two empty windows" — neither deserves
  // a chip.
  if (delta.direction === "flat") return null
  const Icon = delta.direction === "up" ? ArrowUpRight : ArrowDownRight
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-1 text-xs font-medium text-muted-foreground"
    >
      <Icon className="size-3.5" aria-hidden="true" />
      <span className="font-mono tabular-nums">
        {delta.ratio === null
          ? newLabel
          : `${delta.ratio > 0 ? "+" : ""}${Math.round(delta.ratio * 100)}%`}
      </span>
    </span>
  )
}

/** First-open placeholder — three quiet pulses where the cards will land. */
function LoadingSkeleton() {
  return (
    <div className="space-y-4" aria-hidden="true">
      <div className="h-40 animate-pulse rounded-xl border border-border bg-muted/40" />
      <div className="h-24 animate-pulse rounded-xl border border-border bg-muted/40" />
      <div className="h-64 animate-pulse rounded-xl border border-border bg-muted/40" />
    </div>
  )
}

/**
 * The Token Usage route.
 *
 * Data flows one way: filter state → one `token_usage_report` call → one
 * render. Every aggregate on screen (buckets, breakdowns, heatmap, streak,
 * top sessions) comes from that single response, so nothing on the page can
 * disagree with anything else on it.
 */
export function TokenUsagePage() {
  const t = useTranslations("TokenUsage")
  const locale = useLocale()

  const [preset, setPreset] = useState<TokenUsageRangePreset>("30d")
  const [custom, setCustom] = useState({ from: "", to: "" })
  const [bucket, setBucket] = useState<TokenUsageBucket>("day")
  const [bucketTouched, setBucketTouched] = useState(false)
  const [folderIds, setFolderIds] = useState<string[]>([])
  const [agentTypes, setAgentTypes] = useState<string[]>([])
  const [models, setModels] = useState<string[]>([])
  const [dim, setDim] = useState<BreakdownDim>("folder")

  const [facets, setFacets] = useState<TokenUsageFacets | null>(null)
  const [status, setStatus] = useState<TokenUsageSyncStatus | null>(null)
  const [report, setReport] = useState<TokenUsageReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [progress, setProgress] = useState<TokenUsageSyncProgress | null>(null)
  const [shareOpen, setShareOpen] = useState(false)
  // The live theme, resolved to literals the moment the dialog opens — the
  // dialog portals outside the `.tu-viz` scope, so the poster can't read the
  // custom properties itself.
  const [shareTheme, setShareTheme] = useState<ShareCardTheme | null>(null)
  const [exporting, setExporting] = useState(false)
  // Whether any content has scrolled under the toolbar — drives the fade.
  const [scrolled, setScrolled] = useState(false)
  // The preview's live scale. Nominally CARD_PREVIEW_SCALE, but it follows the
  // wrapper's measured width: when the dialog goes vertically scrollable a
  // classic (non-overlay) scrollbar steals ~15px of content width, and a
  // fixed-width preview would overflow into a horizontal scrollbar.
  const [previewScale, setPreviewScale] = useState(CARD_PREVIEW_SCALE)

  const pageRef = useRef<HTMLDivElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const previewRoRef = useRef<ResizeObserver | null>(null)
  // Callback ref so the observer follows the conditionally-mounted wrapper.
  const previewBoxRef = useCallback((el: HTMLDivElement | null) => {
    previewRoRef.current?.disconnect()
    previewRoRef.current = null
    if (!el) return
    const ro = new ResizeObserver(() => {
      // clientWidth excludes the wrapper's border, so the scaled card fits
      // exactly inside it. Never upscale past the nominal preview size.
      setPreviewScale(Math.min(CARD_PREVIEW_SCALE, el.clientWidth / CARD_WIDTH))
    })
    ro.observe(el)
    previewRoRef.current = ro
  }, [])
  const reqRef = useRef(0)
  // Frozen at mount so range presets stay anchored to when the page was
  // opened; reading the clock during render is impure. Same idiom as the
  // Automations page.
  const [now] = useState(() => new Date())

  const range = useMemo(
    () =>
      resolveRange(preset, now, {
        from: custom.from ? new Date(`${custom.from}T00:00:00`) : null,
        to: custom.to ? new Date(`${custom.to}T00:00:00`) : null,
      }),
    [preset, now, custom]
  )

  // The bucket follows the range's suggested default until the user picks one;
  // switching presets re-arms the suggestion (see changePreset). Derived, so
  // there is no effect racing the fetch.
  const effectiveBucket = bucketTouched ? bucket : suggestBucket(preset, range)

  // A preset switch re-applies that preset's natural granularity — a manual
  // bucket choice only sticks within the range it was made for.
  const changePreset = useCallback((next: TokenUsageRangePreset) => {
    setPreset(next)
    setBucketTouched(false)
  }, [])

  // Fires on every scroll tick, but the boolean rarely flips — React bails
  // out on identical state, so this costs nothing while scrolling.
  const handleContentScroll = useCallback((event: Event) => {
    const el = event.target as HTMLElement | null
    setScrolled((el?.scrollTop ?? 0) > 2)
  }, [])

  const load = useCallback(async () => {
    const id = ++reqRef.current
    setError(null)
    try {
      const [next, nextFacets, nextStatus] = await Promise.all([
        tokenUsageReport({
          start: range.start,
          end: range.end,
          folderIds: folderIds.length ? folderIds.map(Number) : null,
          agentTypes: agentTypes.length ? agentTypes : null,
          models: models.length ? models : null,
          bucket: effectiveBucket,
          tzOffsetMinutes: localTzOffsetMinutes(now),
          comparePrevious: true,
        }),
        tokenUsageFacets(),
        tokenUsageStatus(),
      ])
      // Drop a response overtaken by a newer request, so fast filter clicks
      // can't land an older result last.
      if (id !== reqRef.current) return
      setReport(next)
      setFacets(nextFacets)
      setStatus(nextStatus)
    } catch (e) {
      if (id !== reqRef.current) return
      setError(toErrorMessage(e))
    } finally {
      if (id === reqRef.current) setLoading(false)
    }
  }, [range, folderIds, agentTypes, models, effectiveBucket, now])

  useEffect(() => {
    void load()
  }, [load])

  // Latest-ref so the event subscription below is set up once, not torn down
  // and re-established on every filter change (`load`'s identity tracks the
  // filters). Same idiom as tasks-view-context.
  const loadRef = useRef(load)
  useEffect(() => {
    loadRef.current = load
  }, [load])

  // Progress ticks are broadcast, so a sync started from another window (or
  // the web client) drives this progress bar too.
  useEffect(() => {
    let unsub: (() => void) | undefined
    let cancelled = false
    void subscribe<TokenUsageSyncProgress>(SYNC_PROGRESS_EVENT, (payload) => {
      setProgress(payload.result ? null : payload)
      if (payload.result) {
        setSyncing(false)
        void loadRef.current()
      }
    }).then((u) => {
      if (cancelled) u()
      else unsub = u
    })
    return () => {
      cancelled = true
      unsub?.()
    }
  }, [])

  // An import is the main way new sessions appear while this page is open, and
  // it drops the usage stamp of everything it touched. Refetch so the stale
  // count updates in place instead of waiting for a remount.
  useEffect(() => {
    let unsub: (() => void) | undefined
    let cancelled = false
    void subscribe(CONVERSATIONS_BULK_CHANGED_EVENT, () => {
      void loadRef.current()
    }).then((u) => {
      if (cancelled) u()
      else unsub = u
    })
    return () => {
      cancelled = true
      unsub?.()
    }
  }, [])

  const runSync = useCallback(
    async (mode: "incremental" | "full", opts?: { silent?: boolean }) => {
      setSyncing(true)
      setProgress(null)
      try {
        const result = await tokenUsageSync(mode)
        if (!opts?.silent)
          toast.success(t("syncDone", { synced: result.synced }))
        if (result.failed > 0) toast.warning(t("syncFailed"))
      } catch (e) {
        // A silent pass still surfaces failures — the user needs to know the
        // numbers on screen are incomplete, even if they never asked for the
        // refresh.
        toast.error(toErrorMessage(e))
      } finally {
        setSyncing(false)
        setProgress(null)
        await load()
      }
    },
    [load, t]
  )

  // Catch the facts up once per page mount when they are behind the
  // conversation list — the common case right after importing local sessions,
  // where making the user find a button before seeing any numbers would be a
  // needless step. Silent: it reports failures but not routine success.
  //
  // The ref latches before the call, so the `status` refresh that a sync
  // triggers cannot start a second one.
  const autoSyncedRef = useRef(false)
  useEffect(() => {
    if (autoSyncedRef.current || !status) return
    autoSyncedRef.current = true
    if (status.running || status.stale_conversations === 0) return
    void runSync("incremental", { silent: true })
  }, [status, runSync])

  // `alias [ name ]`, not the alias alone: an aliased folder was otherwise
  // unidentifiable here — two projects aliased "Work" read as the same row, and
  // typing the real directory name found neither. `label` (plain) is what the
  // pill summary shows and what the search matches; `labelNode` is the same
  // text with the bracketed directory name in its own shade.
  const folderOptions = useMemo(
    () =>
      (facets?.folders ?? []).map((f) => ({
        value: String(f.folder_id),
        label: formatFolderLabelWithAlias(f),
        labelNode: (
          <FolderAliasLabel
            name={f.name}
            alias={f.alias}
            bracketClassName="text-muted-foreground"
          />
        ),
        hint: f.path,
      })),
    [facets]
  )
  const agentOptions = useMemo(
    () =>
      (facets?.agents ?? []).map((a) => ({
        value: a,
        label: getAgentLabel(a as AgentType),
      })),
    [facets]
  )
  const modelOptions = useMemo(
    () => (facets?.models ?? []).map((m) => ({ value: m, label: m })),
    [facets]
  )

  const hasFilters =
    folderIds.length > 0 || agentTypes.length > 0 || models.length > 0
  const resetFilters = () => {
    setFolderIds([])
    setAgentTypes([])
    setModels([])
  }

  const totals = report?.totals
  const cache = totals ? cacheHitRate(totals) : null
  const averageTps = totals
    ? averageOutputTps(totals.output_tokens, totals.duration_ms)
    : null
  const heat = useMemo(
    () => buildHeatMatrix(report?.heatmap ?? []),
    [report?.heatmap]
  )
  const archetype = useMemo(
    () => (report ? deriveArchetype(report) : null),
    [report]
  )

  const weekdayLabels = WEEKDAY_KEYS.map((k) => t(k))

  const formatBucketLabel = useCallback(
    (bucketKey: string) => {
      // Month buckets carry `YYYY-MM`; day and week buckets carry the first
      // local day of the bucket.
      if (bucketKey.length === 7) {
        const [y, m] = bucketKey.split("-")
        return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString(
          locale,
          {
            year: "numeric",
            month: "short",
          }
        )
      }
      const [y, m, d] = bucketKey.split("-")
      return new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString(
        locale,
        { month: "short", day: "numeric" }
      )
    },
    [locale]
  )

  const trendData = useMemo(() => {
    const isDay = report?.bucket === "day"
    return (report?.series ?? []).map((p) => {
      const [y, m, d] = p.bucket_key.split("-")
      return {
        key: p.bucket_key,
        label: formatBucketLabel(p.bucket_key),
        // Day buckets carry their weekday in the tooltip — too long for the
        // axis endpoints, exactly right when inspecting one bar.
        tooltipLabel: isDay
          ? new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString(
              locale,
              { month: "short", day: "numeric", weekday: "short" }
            )
          : undefined,
        cache: p.cache_read_tokens,
        fresh: Math.max(0, p.total_tokens - p.cache_read_tokens),
        detail: [
          {
            label: t("trendTurns"),
            value: p.turn_count.toLocaleString(locale),
          },
          {
            label: t("trendSessions"),
            value: p.conversation_count.toLocaleString(locale),
          },
        ],
      }
    })
  }, [report?.series, report?.bucket, formatBucketLabel, t, locale])

  // Where the tokens went — colours are pinned to the entity (cache reads
  // always wear the accent, fresh compute the ink scale), then the rows are
  // sorted by size for display.
  const compositionRows = useMemo<RankedDatum[]>(() => {
    if (!totals || totals.total_tokens <= 0) return []
    const rows = [
      {
        key: "cacheRead",
        label: t("cacheRead"),
        value: totals.cache_read_tokens,
        color: ACCENT,
      },
      {
        key: "input",
        label: t("inputTokens"),
        value: totals.input_tokens,
        color: INK,
      },
      {
        key: "cacheWrite",
        label: t("cacheWrite"),
        value: totals.cache_creation_tokens,
        color: INK_SOFT,
      },
      {
        key: "output",
        label: t("outputTokens"),
        value: totals.output_tokens,
        color: INK_FAINT,
      },
    ]
    rows.sort((a, b) => b.value - a.value)
    return rows.map((r) => ({
      ...r,
      share: r.value / totals.total_tokens,
    }))
  }, [totals, t])

  const breakdownItems = useMemo(() => {
    if (!report) return []
    return dim === "folder"
      ? report.by_folder
      : dim === "agent"
        ? report.by_agent
        : report.by_model
  }, [report, dim])

  const breakdownLabel = useCallback(
    (key: string, fallback: string) => {
      if (dim === "agent") return getAgentLabel(key as AgentType)
      if (dim === "model" && key === "__unknown__") return t("unknownModel")
      return fallback
    },
    [dim, t]
  )

  const breakdownRows = useMemo<RankedDatum[]>(() => {
    if (!totals) return []
    const { shown, other } = foldBreakdown(breakdownItems, BREAKDOWN_LIMIT)
    const share = (v: number) =>
      totals.total_tokens > 0 ? v / totals.total_tokens : null
    const rows: RankedDatum[] = shown.map((it) => ({
      key: it.key,
      label: breakdownLabel(it.key, it.label),
      value: it.total_tokens,
      share: share(it.total_tokens),
      hint: t("sessionsCount", { count: it.conversation_count }),
    }))
    if (other) {
      rows.push({
        key: other.key,
        label: t("otherLabel"),
        value: other.total_tokens,
        share: share(other.total_tokens),
        hint: t("sessionsCount", { count: other.conversation_count }),
        color: NEUTRAL,
      })
    }
    return rows
  }, [breakdownItems, breakdownLabel, totals, t])

  const onBreakdownSelect = useCallback(
    (key: string) => {
      if (key === "__other__" || key === "__unknown__") return
      if (dim === "folder") setFolderIds([key])
      else if (dim === "agent") setAgentTypes([key])
      else setModels([key])
    },
    [dim]
  )

  const exportCard = useCallback(
    async (action: "save" | "copy") => {
      const node = cardRef.current
      if (!node) return
      setExporting(true)
      try {
        const { toPng } = await import("html-to-image")
        const dataUrl = await toPng(node, {
          // Pinned to the card's own layout box. The preview wrapper scales it
          // with a CSS transform, and passing the size explicitly means the
          // export can never inherit that preview scale.
          width: CARD_WIDTH,
          height: CARD_HEIGHT,
          // 2× so the poster stays crisp when a chat app re-encodes it.
          pixelRatio: 2,
          // The resolved theme background — same literal the card paints, so
          // any pixel the layout leaves uncovered matches instead of flashing
          // a foreign colour.
          backgroundColor: shareTheme?.bg,
          cacheBust: true,
          style: { transform: "none", transformOrigin: "top left" },
        })
        const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1)
        if (action === "copy") {
          if (!canCopyImages()) {
            // Safari/WKWebView and older browsers have no image clipboard —
            // say so instead of throwing an opaque ReferenceError.
            toast.error(t("shareFailed"))
            return
          }
          const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
          await navigator.clipboard.write([
            new ClipboardItem({
              "image/png": new Blob([bytes as BlobPart], { type: "image/png" }),
            }),
          ])
          toast.success(t("shareCopied"))
        } else {
          const { downloadImage } = await import("@/lib/image-download")
          const saved = await downloadImage({
            data: base64,
            mime_type: "image/png",
            suggestedName: shareCardFilename(range, now),
          })
          if (saved) toast.success(t("shareSaved"))
        }
      } catch (e) {
        toast.error(`${t("shareFailed")}: ${toErrorMessage(e)}`)
      } finally {
        setExporting(false)
      }
    },
    [range, now, t, shareTheme]
  )

  const isEmpty =
    !loading &&
    report != null &&
    report.totals.total_tokens === 0 &&
    (status?.fact_rows ?? 0) === 0

  // Nothing has been indexed yet, so the page is one call to action: every
  // toolbar control slices data that doesn't exist, and the actions folded into
  // the ⋯ menu are all the empty state's own button (an incremental sync over
  // an empty fact table IS the full build). Hidden during the very first load
  // too — we don't know yet which of the two layouts applies, and putting a row
  // of controls on screen only to retract it a moment later reads worse than
  // letting it arrive together with the content. An error leaves `report` null
  // with `loading` false, so the toolbar (the only way to retry) comes back.
  const showToolbar = !isEmpty && !(loading && report == null)

  const fresh = totals ? freshTokens(totals) : 0
  const idle = report ? idleDays(report) : null
  const peak = report ? peakPoint(report.series) : null
  const busiestHour = report ? peakHour(report.heatmap) : null
  const delta =
    totals && report?.previous_totals
      ? computeDelta(totals.total_tokens, report.previous_totals.total_tokens)
      : null

  return (
    <div ref={pageRef} className="tu-viz flex h-full min-h-0 flex-col">
      {/* ─── Toolbar ───
            Borderless, aligned to the content column, with the same 16px
            breathing room on every side (the title band above carries its own
            border). Three zones on one wrapping row: the range (hot presets
            as segments, the long tail folded into one pill), the dimension
            filters, and a single overflow menu carrying every data action.
            Absent entirely on the first-run empty state — see `showToolbar`. */}
      {showToolbar && (
        <div className="shrink-0 p-4">
          <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-2.5 gap-y-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <SegmentedFilter
                ariaLabel={t("rangeLabel")}
                value={preset}
                onChange={changePreset}
                options={HOT_RANGE_PRESETS.map((p) => ({
                  value: p,
                  label: t(RANGE_LABEL_KEYS[p]),
                }))}
              />
              <SingleSelectFilter
                placeholder={t("moreRanges")}
                ariaLabel={t("rangeLabel")}
                options={MORE_RANGE_PRESETS.map((p) => ({
                  value: p,
                  label: t(RANGE_LABEL_KEYS[p]),
                }))}
                value={
                  (MORE_RANGE_PRESETS as readonly string[]).includes(preset)
                    ? preset
                    : null
                }
                onChange={(v) => changePreset(v as TokenUsageRangePreset)}
              />
              {preset === "custom" && (
                <CustomRangeFields
                  from={custom.from}
                  to={custom.to}
                  onChange={setCustom}
                />
              )}
            </div>

            <div className="h-5 w-px bg-border" aria-hidden="true" />

            <div className="flex flex-wrap items-center gap-1.5">
              <MultiSelectFilter
                icon={Folder}
                label={t("folderFilter")}
                allLabel={t("allFolders")}
                options={folderOptions}
                selected={folderIds}
                onChange={setFolderIds}
                searchPlaceholder={t("searchPlaceholder")}
                emptyLabel={t("noMatches")}
              />
              <MultiSelectFilter
                icon={Bot}
                label={t("agentFilter")}
                allLabel={t("allAgents")}
                options={agentOptions}
                selected={agentTypes}
                onChange={setAgentTypes}
                searchPlaceholder={t("searchPlaceholder")}
                emptyLabel={t("noMatches")}
              />
              <MultiSelectFilter
                icon={Cpu}
                label={t("modelFilter")}
                allLabel={t("allModels")}
                options={modelOptions}
                selected={models}
                onChange={setModels}
                searchPlaceholder={t("searchPlaceholder")}
                emptyLabel={t("noMatches")}
              />
              {hasFilters && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-8 gap-1.5 rounded-full px-2.5 text-xs text-muted-foreground"
                  onClick={resetFilters}
                >
                  <RotateCcw className="size-3.5" />
                  {t("resetFilters")}
                </Button>
              )}
            </div>

            {/* Stale counts are sync bookkeeping, not persistent user-facing
                status. Progress and actionable failures are surfaced while the
                sync runs. */}
            <div className="ms-auto flex items-center gap-1.5">
              {/* Every data action lives in one overflow menu; while a sync
                    runs the trigger itself spins, so the state stays visible
                    with the buttons folded away. Styled as a filled pill like
                    the filter triggers — a ghost icon here reads as free space,
                    so its right edge never looked aligned with the cards below
                    (and nudging the button out would misalign the hover pill
                    instead). A resting fill gives the eye a real edge to line
                    up, and hovering only deepens the tone. */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-8 rounded-full bg-muted/70 text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label={t("moreActions")}
                  >
                    {syncing ? (
                      <RefreshCw className="size-4 animate-spin" />
                    ) : (
                      <MoreHorizontal className="size-4" />
                    )}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-72 rounded-xl">
                  <DropdownMenuItem
                    disabled={syncing}
                    onSelect={() => void runSync("incremental")}
                    className="gap-2.5 rounded-lg"
                  >
                    {/* Two-line items pin the icon to the title line
                        (self-start + half-step nudge to its optical centre) —
                        centring against the whole block leaves each icon
                        floating at a different height per item. */}
                    <RefreshCw
                      className={cn(
                        "mt-0.5 size-4 shrink-0 self-start text-muted-foreground",
                        syncing && "animate-spin"
                      )}
                    />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-[0.8125rem] font-medium">
                        {syncing ? t("syncing") : t("refresh")}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {status?.last_synced_at
                          ? t("lastSynced", {
                              time: new Date(
                                status.last_synced_at
                              ).toLocaleString(locale),
                            })
                          : t("lastSyncedNever")}
                      </span>
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={syncing}
                    onSelect={() => void runSync("full")}
                    className="gap-2.5 rounded-lg"
                  >
                    <DatabaseBackup className="mt-0.5 size-4 shrink-0 self-start text-muted-foreground" />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-[0.8125rem] font-medium">
                        {t("rebuild")}
                      </span>
                      <span className="text-xs leading-relaxed text-muted-foreground">
                        {t("rebuildHint")}
                      </span>
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={!report || report.totals.total_tokens === 0}
                    onSelect={() => {
                      if (pageRef.current) {
                        setShareTheme(resolveShareCardTheme(pageRef.current))
                      }
                      setShareOpen(true)
                    }}
                    className="gap-2.5 rounded-lg"
                  >
                    <Share2 className="size-4 shrink-0 text-muted-foreground" />
                    <span className="text-[0.8125rem] font-medium">
                      {t("share")}
                    </span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </div>
      )}

      {progress && progress.total > 0 && (
        <div className="shrink-0 space-y-1 border-b border-border px-4 py-2">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="truncate">
              {progress.current_title ?? t("syncing")}
            </span>
            <span className="ml-2 shrink-0 font-mono tabular-nums">
              {t("syncProgress", {
                done: progress.done,
                total: progress.total,
              })}
            </span>
          </div>
          <Progress value={(progress.done / progress.total) * 100} />
        </div>
      )}

      {isEmpty ? (
        /* First run. With the toolbar withheld there is nothing above it and
           nothing to scroll, so the call to action takes the whole canvas —
           same shape as the Tasks board's empty state — instead of hanging in
           a dashed box pinned under the title bar. */
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          {error && (
            <p className="max-w-md rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              {t("loadFailed")}: {error}
            </p>
          )}
          <ChartNoAxesColumn
            className="size-10 text-muted-foreground/40"
            aria-hidden="true"
          />
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">{t("emptyTitle")}</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              {t("emptyHint")}
            </p>
          </div>
          {/* Full, not incremental. On a genuine first run the two do the same
              work (nothing is stamped yet, so everything is stale), but they
              part ways in the state where an empty fact table sits behind
              up-to-date stamps — a first pass that pinned every conversation at
              zero, a restore, a wipe. There an incremental pass skips
              everything and this button becomes a no-op, and with the toolbar
              withheld the ⋯ menu's rebuild entry isn't there to escape with. */}
          <Button
            type="button"
            size="sm"
            className="gap-1.5"
            disabled={syncing}
            onClick={() => void runSync("full")}
          >
            <RefreshCw className={cn("size-3.5", syncing && "animate-spin")} />
            {t("emptyAction")}
          </Button>
        </div>
      ) : (
        /* Scrolled cards slide under a soft fade below the toolbar — the same
           clip-fade treatment as collapsed chat messages, faded in only once
           there is actually something underneath it. */
        <div className="relative min-h-0 flex-1">
          <div
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-gradient-to-b from-background to-transparent transition-opacity duration-200",
              scrolled ? "opacity-100" : "opacity-0"
            )}
          />
          <ScrollArea className="h-full" onScroll={handleContentScroll}>
            {/* Same geometry as the toolbar — outer gutter, then the capped
                column — so the two columns stay flush at every viewport width.
                Padding inside the max-width element would instead shave 32px
                off the cards once the viewport clears the cap. */}
            <div className="px-4 pb-4">
              <div className="mx-auto w-full max-w-6xl space-y-4">
                {error && (
                  <p className="rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                    {t("loadFailed")}: {error}
                  </p>
                )}

                {report?.truncated && (
                  <p className="rounded-xl border border-border bg-muted/40 px-4 py-2.5 text-xs text-muted-foreground">
                    {t("truncatedNotice")}
                  </p>
                )}

                {loading && !report ? (
                  <LoadingSkeleton />
                ) : (
                  totals &&
                  report && (
                    <>
                      {/* ─── Hero: the one number, and what the cache did ─── */}
                      <section className="overflow-hidden rounded-xl border border-border bg-card">
                        {/* Even halves — but only while the cache panel exists,
                          so a cache-less report doesn't strand the hero figure
                          in half the card. */}
                        <div
                          className={cn(
                            "grid",
                            cache !== null && "lg:grid-cols-2"
                          )}
                        >
                          <div className="flex flex-col p-5">
                            <div className="text-[0.6875rem] font-medium uppercase tracking-wider text-muted-foreground">
                              {t("tileTotal")}
                            </div>
                            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                              <span className="text-5xl font-semibold leading-none tracking-tight">
                                {formatTokensPrecise(totals.total_tokens)}
                              </span>
                              {delta && (
                                <DeltaBadge
                                  delta={delta}
                                  newLabel={t("deltaNew")}
                                  title={t("vsPrevious")}
                                />
                              )}
                            </div>
                            {archetype && totals.total_tokens > 0 && (
                              // The outer wrapper owns the spacing: mt-auto pins
                              // the strip to the card's bottom edge on wide
                              // layouts, pt-5 keeps a floor under the hero number
                              // when there is no slack to distribute.
                              <div className="mt-auto pt-5">
                                <div
                                  className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 rounded-lg px-3 py-2.5 text-[0.8125rem] leading-relaxed"
                                  style={{
                                    backgroundColor: "var(--tu-accent-soft)",
                                  }}
                                >
                                  <span aria-hidden="true">
                                    {ARCHETYPE_EMOJI[archetype.id]}
                                  </span>
                                  <span className="font-semibold">
                                    {t(ARCHETYPE_LABEL_KEYS[archetype.id])}
                                  </span>
                                  <span className="text-muted-foreground">
                                    {t(
                                      ARCHETYPE_DESC_KEYS[archetype.id],
                                      archetype.values
                                    )}
                                    {archetype.id === "cacheMaster" &&
                                      totals.cache_read_tokens > 0 &&
                                      ` ${t("cacheSavedSuffix", {
                                        saved: formatTokensPrecise(
                                          totals.cache_read_tokens
                                        ),
                                      })}`}
                                  </span>
                                </div>
                              </div>
                            )}
                          </div>
                          {cache !== null && (
                            <div className="flex items-center gap-5 border-t border-border p-5 lg:border-s lg:border-t-0">
                              <RingMeter
                                ratio={cache}
                                valueText={`${Math.round(cache * 100)}%`}
                                caption={t("cacheHitCaption")}
                              />
                              <div className="min-w-0">
                                <div className="text-sm font-semibold">
                                  {cache >= 0.5
                                    ? t("cacheHeroTitleHigh")
                                    : t("cacheHeroTitleLow")}
                                </div>
                                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                                  {t("cacheHeroDesc", {
                                    cached: formatTokensPrecise(
                                      totals.cache_read_tokens
                                    ),
                                    fresh: formatTokensPrecise(fresh),
                                  })}
                                </p>
                              </div>
                            </div>
                          )}
                        </div>
                      </section>

                      {/* ─── Stats strip ─── */}
                      <section className="grid grid-cols-2 overflow-hidden rounded-xl border border-border bg-card lg:grid-cols-4">
                        {/* `conversation_count` is workspace-scoped on the
                          server (workspace_conversation_count), so with an
                          unbounded range it agrees exactly with the status
                          bar's session counter. */}
                        <StatCell
                          label={t("tileSessions")}
                          value={totals.conversation_count.toLocaleString(
                            locale
                          )}
                          hint={`${t("avgPerSession")} ${formatTokenCount(
                            Math.round(averagePerConversation(totals))
                          )}`}
                        />
                        <StatCell
                          className="border-s"
                          label={t("tileTurns")}
                          value={totals.turn_count.toLocaleString(locale)}
                          hint={t("avgTurnsPerSession", {
                            count:
                              averageTurnsPerConversation(totals).toFixed(1),
                          })}
                        />
                        <StatCell
                          className="border-t lg:border-s lg:border-t-0"
                          label={t("tileActiveDays")}
                          value={t("daysValue", { count: totals.active_days })}
                          hint={t("streakLongestDays", {
                            count: report.streak.longest_days,
                          })}
                        />
                        <StatCell
                          className="border-s border-t lg:border-t-0"
                          label={t("tileGenTime")}
                          value={formatDuration(totals.duration_ms)}
                          hint={
                            averageTps != null
                              ? t("avgOutputSpeed", {
                                  speed: formatTokPerSec(averageTps),
                                })
                              : `${t("avgPerActiveDay")} ${formatTokenCount(
                                  Math.round(averagePerActiveDay(totals))
                                )}`
                          }
                        />
                      </section>

                      {/* ─── Trend ─── */}
                      <Panel
                        title={t("trendTitle")}
                        icon={ChartNoAxesColumn}
                        actions={
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                            <div className="flex items-center gap-3 text-xs text-muted-foreground">
                              <span className="flex items-center gap-1.5">
                                <span
                                  aria-hidden="true"
                                  className="size-2 rounded-[2px]"
                                  style={{ backgroundColor: ACCENT }}
                                />
                                {t("cacheRead")}
                              </span>
                              <span className="flex items-center gap-1.5">
                                <span
                                  aria-hidden="true"
                                  className="size-2 rounded-[2px]"
                                  style={{ backgroundColor: INK }}
                                />
                                {t("freshTokens")}
                              </span>
                            </div>
                            <SegmentedFilter
                              ariaLabel={t("bucketLabel")}
                              value={effectiveBucket}
                              onChange={(v) => {
                                setBucket(v)
                                setBucketTouched(true)
                              }}
                              options={(["day", "week", "month"] as const).map(
                                (b) => ({
                                  value: b,
                                  label: t(BUCKET_LABEL_KEYS[b]),
                                })
                              )}
                            />
                          </div>
                        }
                      >
                        <TrendChart
                          data={trendData}
                          label={t("trendTitle")}
                          cacheLabel={t("cacheRead")}
                          freshLabel={t("freshTokens")}
                          emptyLabel={t("trendEmpty")}
                        />
                        {(peak || busiestHour !== null || idle !== null) && (
                          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
                            {peak && (
                              <span>
                                {t("peakBucket", {
                                  bucket: t(BUCKET_UNIT_KEYS[report.bucket]),
                                })}
                                {": "}
                                <span className="font-medium text-foreground">
                                  {formatBucketLabel(peak.bucket_key)} ·{" "}
                                  {formatTokenCount(peak.total_tokens)}
                                </span>
                              </span>
                            )}
                            {busiestHour !== null && (
                              <span>
                                {t("peakHour")}
                                {": "}
                                <span className="font-medium text-foreground">
                                  {String(busiestHour).padStart(2, "0")}:00
                                </span>
                              </span>
                            )}
                            {idle !== null && (
                              <span>
                                {t("idleDays")}
                                {": "}
                                <span className="font-medium text-foreground">
                                  {t("daysValue", { count: idle })}
                                </span>
                              </span>
                            )}
                          </div>
                        )}
                      </Panel>

                      {/* ─── Composition + rhythm — stretched to one shared height ─── */}
                      <div className="grid gap-4 lg:grid-cols-2">
                        <Panel
                          title={t("compositionTitle")}
                          hint={t("compositionHint")}
                        >
                          <RankedBars
                            data={compositionRows}
                            emptyLabel={t("emptyBreakdown")}
                          />
                          {totals.cache_read_tokens > 0 && (
                            <p className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
                              {t("compositionNote", {
                                value: formatTokensPrecise(
                                  totals.cache_read_tokens
                                ),
                              })}
                            </p>
                          )}
                        </Panel>

                        <Panel
                          title={t("heatmapTitle")}
                          hint={
                            busiestHour !== null
                              ? `${t("heatmapHint")} ${t("heatmapPeakHint", {
                                  hour: String(busiestHour).padStart(2, "0"),
                                })}`
                              : t("heatmapHint")
                          }
                        >
                          <ActivityHeatmap
                            matrix={heat.cells}
                            max={heat.max}
                            weekdayLabels={weekdayLabels}
                            legendLess={t("less")}
                            legendMore={t("more")}
                            formatAria={(weekday, hour, value) =>
                              t("heatmapCell", {
                                weekday: weekdayLabels[weekday],
                                hour: String(hour).padStart(2, "0"),
                                value: formatTokenCount(value),
                              })
                            }
                          />
                        </Panel>
                      </div>

                      {/* ─── Distribution ─── */}
                      <Panel
                        title={t("distributionTitle")}
                        hint={t("distributionHint")}
                        actions={
                          <SegmentedFilter
                            ariaLabel={t("distributionTitle")}
                            value={dim}
                            onChange={setDim}
                            options={[
                              {
                                value: "folder" as const,
                                label: t("byFolderTitle"),
                              },
                              {
                                value: "agent" as const,
                                label: t("byAgentTitle"),
                              },
                              {
                                value: "model" as const,
                                label: t("byModelTitle"),
                              },
                            ]}
                          />
                        }
                      >
                        <RankedBars
                          data={breakdownRows}
                          showRank
                          emptyLabel={t("emptyBreakdown")}
                          onSelect={onBreakdownSelect}
                        />
                      </Panel>

                      {/* ─── Top sessions ─── */}
                      <Panel title={t("topSessionsTitle")}>
                        {report.top_conversations.length === 0 ? (
                          <p className="py-6 text-center text-sm text-muted-foreground">
                            {t("topSessionsEmpty")}
                          </p>
                        ) : (
                          <ol className="divide-y divide-border">
                            {report.top_conversations.map((c, i) => {
                              const sessionTps = averageOutputTps(
                                c.output_tokens,
                                c.duration_ms
                              )
                              return (
                                <li
                                  key={c.conversation_id}
                                  className="flex items-center gap-3 py-2 first:pt-0 last:pb-0"
                                >
                                  <span
                                    aria-hidden="true"
                                    className="w-5 shrink-0 font-mono text-[0.625rem] tabular-nums text-muted-foreground/70"
                                  >
                                    {String(i + 1).padStart(2, "0")}
                                  </span>
                                  <span className="min-w-0 flex-1 truncate text-[0.8125rem]">
                                    {c.title || t("untitledSession")}
                                  </span>
                                  <span className="hidden shrink-0 truncate text-xs text-muted-foreground sm:block sm:max-w-[10rem]">
                                    {c.folder_label}
                                  </span>
                                  <span className="shrink-0 text-xs text-muted-foreground">
                                    {getAgentLabel(c.agent_type as AgentType)}
                                  </span>
                                  <span className="shrink-0 font-mono text-xs tabular-nums">
                                    {formatTokenCount(c.total_tokens)}
                                  </span>
                                  {sessionTps != null && (
                                    <span
                                      className="hidden shrink-0 font-mono text-xs tabular-nums text-muted-foreground sm:block"
                                      title={t("outputSpeedTooltip")}
                                    >
                                      {formatTokPerSec(sessionTps)}
                                    </span>
                                  )}
                                </li>
                              )
                            })}
                          </ol>
                        )}
                      </Panel>
                    </>
                  )
                )}
              </div>
            </div>
          </ScrollArea>
        </div>
      )}

      {/* ─── Share ─── */}
      <Dialog open={shareOpen} onOpenChange={setShareOpen}>
        {/* Sized so the dialog's 24px padding IS the margin around the card
            preview — its edges sit flush with the title text instead of
            floating on leftover slack. An inline style (not an arbitrary
            max-w-[…] class) because it derives from the CARD_* constants;
            hardcoding 25.5rem beside them would silently drift. */}
        <DialogContent
          style={{ maxWidth: CARD_WIDTH * CARD_PREVIEW_SCALE + 48 }}
        >
          <DialogHeader>
            <DialogTitle>{t("shareDialogTitle")}</DialogTitle>
            <DialogDescription>{t("shareDialogHint")}</DialogDescription>
          </DialogHeader>
          {report && shareTheme && (
            // The card is always laid out at its natural size so the export
            // is identical everywhere; the wrapper only scales the on-screen
            // preview. Its width flexes with the dialog's content box (see
            // previewBoxRef) and its height tracks the live scale, so the
            // preview can never overflow horizontally.
            <div
              ref={previewBoxRef}
              className="mx-auto w-full overflow-hidden rounded-xl border border-border"
              style={{
                // +2 on both axes: the border is inside the box, and the
                // scale is derived from clientWidth (which excludes it).
                maxWidth: CARD_WIDTH * CARD_PREVIEW_SCALE + 2,
                height: CARD_HEIGHT * previewScale + 2,
              }}
            >
              <div
                style={{
                  transform: `scale(${previewScale})`,
                  transformOrigin: "top left",
                  width: CARD_WIDTH,
                  height: CARD_HEIGHT,
                }}
              >
                <ShareCard
                  ref={cardRef}
                  report={report}
                  locale={locale}
                  theme={shareTheme}
                />
              </div>
            </div>
          )}
          <DialogFooter className="sm:justify-center">
            <Button
              type="button"
              variant="outline"
              disabled={exporting || !canCopyImages()}
              onClick={() => void exportCard("copy")}
            >
              {t("shareCopy")}
            </Button>
            <Button
              type="button"
              disabled={exporting}
              onClick={() => void exportCard("save")}
            >
              {exporting ? t("shareRendering") : t("shareSave")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
