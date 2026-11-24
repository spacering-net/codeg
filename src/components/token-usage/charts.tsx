"use client"

import { Fragment, useCallback, useMemo, useRef, useState } from "react"
import { cn } from "@/lib/utils"
import { useElementWidth } from "@/hooks/use-element-width"
import { formatTokenCount } from "@/lib/token-format"
import { formatTokensPrecise } from "@/lib/token-usage"

/**
 * Hand-rolled SVG charts for the token dashboard.
 *
 * No charting dependency: every mark here is a rect or a path over data the
 * backend already shaped, and rolling them by hand keeps the marks on the
 * project's own geometry (thin bars, 4px rounded data-ends, a 2px surface gap
 * between stacked segments) instead of a library's defaults.
 *
 * Colour comes from the `.tu-viz` scope in globals.css and speaks exactly two
 * languages: the theme accent (`--tu-accent`) means "context served from the
 * prompt cache", the neutral ink scale (`--tu-ink*`) means "freshly computed
 * tokens". Identity in every list is carried by inline text labels, so colour
 * is a magnitude cue, never the sole encoding.
 */

export const ACCENT = "var(--tu-accent)"
export const INK = "var(--tu-ink)"
export const INK_SOFT = "var(--tu-ink-2)"
export const INK_FAINT = "var(--tu-ink-3)"
export const NEUTRAL = "var(--muted-foreground)"

// ─── Trend ──────────────────────────────────────────────────────────────

export interface TrendDatum {
  key: string
  label: string
  /** Tooltip heading override — e.g. the date with its weekday, which would
   *  be too long for the axis endpoint labels. */
  tooltipLabel?: string
  /** Context read back from the prompt cache — drawn in the theme accent. */
  cache: number
  /** Freshly computed tokens (input + output + cache writes) — drawn in ink. */
  fresh: number
  /** Extra lines for the tooltip, already formatted and translated. */
  detail: { label: string; value: string }[]
}

const TREND_HEIGHT = 224
const TREND_PAD_TOP = 14
const TREND_PAD_BOTTOM = 22
const GRID_LINES = 4
/** Mark-spec cap — a bar never fills its slot even on short ranges. */
const MAX_BAR_WIDTH = 24

/** A rect with only its top corners rounded: the data-end of a stack is round,
 *  the baseline (and any segment seam) stays square. */
function roundedTopPath(
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): string {
  const rr = Math.max(0, Math.min(r, w / 2, h))
  return [
    `M${x},${y + h}`,
    `V${y + rr}`,
    `Q${x},${y} ${x + rr},${y}`,
    `H${x + w - rr}`,
    `Q${x + w},${y} ${x + w},${y + rr}`,
    `V${y + h}`,
    "Z",
  ].join(" ")
}

/**
 * Bucketed spend over time — one stacked bar per bucket: cache reads in the
 * accent with the freshly-computed remainder capping it in ink.
 *
 * Bars (not a line) because the buckets are discrete accumulations, and because
 * a range with quiet days should read as gaps rather than as a line
 * interpolating through zero.
 *
 * The marks are memoized apart from the hover state: a pointer move repaints
 * only the highlight column and the tooltip, never the (up to a few hundred)
 * bar paths.
 */
export function TrendChart({
  data,
  label,
  cacheLabel,
  freshLabel,
  emptyLabel,
  className,
}: {
  data: TrendDatum[]
  /** Accessible name for the plot — what the chart shows, not what it says
   *  when it is empty. */
  label: string
  cacheLabel: string
  freshLabel: string
  emptyLabel: string
  className?: string
}) {
  const [ref, width] = useElementWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)

  const max = useMemo(
    () => data.reduce((m, d) => Math.max(m, d.cache + d.fresh), 0),
    [data]
  )
  const plotHeight = TREND_HEIGHT - TREND_PAD_TOP - TREND_PAD_BOTTOM
  const slot = data.length > 0 && width > 0 ? width / data.length : 0

  const marks = useMemo(() => {
    if (slot <= 0 || max <= 0) return null
    // Bars keep a 2px surface gap from each other; below ~3px of drawable
    // width the gap would eat the bar, so it collapses first.
    const gap = slot > 5 ? 2 : 0
    const barWidth = Math.min(MAX_BAR_WIDTH, Math.max(1, slot - gap))
    const radius = Math.min(4, barWidth / 2)
    const baseline = TREND_PAD_TOP + plotHeight
    return (
      <g>
        {data.map((d, i) => {
          const total = d.cache + d.fresh
          if (total <= 0) return null
          const totalH = Math.max(2, (total / max) * plotHeight)
          const x = i * slot + (slot - barWidth) / 2
          const freshH = (d.fresh / total) * totalH
          const cacheH = totalH - freshH
          // The 2px surface seam between segments only when both are tall
          // enough to survive it; it is carved out of the fresh cap so the
          // stack's total height stays honest.
          const seam = freshH >= 4 && cacheH >= 2 ? 2 : 0
          const parts: React.ReactNode[] = []
          if (cacheH > 0.5) {
            parts.push(
              freshH > 0.5 ? (
                <rect
                  key="c"
                  x={x}
                  y={baseline - cacheH}
                  width={barWidth}
                  height={cacheH}
                  fill={ACCENT}
                />
              ) : (
                <path
                  key="c"
                  d={roundedTopPath(
                    x,
                    baseline - cacheH,
                    barWidth,
                    cacheH,
                    radius
                  )}
                  fill={ACCENT}
                />
              )
            )
          }
          if (freshH > 0.5) {
            const h = Math.max(1, freshH - seam)
            parts.push(
              <path
                key="f"
                d={roundedTopPath(x, baseline - totalH, barWidth, h, radius)}
                fill={INK}
              />
            )
          }
          return <g key={d.key}>{parts}</g>
        })}
      </g>
    )
  }, [data, slot, max, plotHeight])

  if (data.length === 0) {
    return (
      <div
        className={cn(
          // px, deliberately: this placeholder stands in for the chart, whose
          // own `height={TREND_HEIGHT}` is px (the svg has no viewBox and every
          // offset in it is px math). rem here would make the card change
          // height between the empty and populated states at any zoom but 100%.
          "flex h-[224px] items-center justify-center text-sm text-muted-foreground",
          className
        )}
      >
        {emptyLabel}
      </div>
    )
  }

  const hovered = hover !== null ? data[hover] : null

  return (
    <div ref={ref} className={cn("relative w-full", className)}>
      {width > 0 && (
        <svg
          width={width}
          height={TREND_HEIGHT}
          role="img"
          aria-label={label}
          className="block overflow-visible"
          onMouseLeave={() => setHover(null)}
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            const index = Math.floor((e.clientX - rect.left) / slot)
            setHover(index >= 0 && index < data.length ? index : null)
          }}
        >
          {/* Recessive grid: four hairlines, no axis rules, no tick marks. */}
          {Array.from({ length: GRID_LINES + 1 }, (_, i) => {
            const y = TREND_PAD_TOP + (plotHeight * i) / GRID_LINES
            return (
              <line
                key={i}
                x1={0}
                x2={width}
                y1={y}
                y2={y}
                className="stroke-border"
                strokeWidth={1}
                opacity={i === GRID_LINES ? 0.8 : 0.35}
              />
            )
          })}

          {/* Hover highlight sits behind the marks so the column reads as a
              backdrop, not as data. */}
          {hover !== null && (
            <rect
              x={hover * slot}
              y={TREND_PAD_TOP}
              width={slot}
              height={plotHeight}
              fill="var(--tu-accent-soft)"
              opacity={0.6}
            />
          )}

          {marks}

          {/* Endpoint labels only — a tick under every bucket would collide at
              any realistic bucket count, and the tooltip carries the rest. */}
          <text
            x={0}
            y={TREND_HEIGHT - 6}
            className="fill-muted-foreground text-[0.6875rem]"
          >
            {data[0]?.label}
          </text>
          {data.length > 1 && (
            <text
              x={width}
              y={TREND_HEIGHT - 6}
              textAnchor="end"
              className="fill-muted-foreground text-[0.6875rem]"
            >
              {data[data.length - 1]?.label}
            </text>
          )}
          <text
            x={0}
            y={TREND_PAD_TOP - 4}
            className="fill-muted-foreground text-[0.6875rem]"
          >
            {formatTokenCount(max)}
          </text>
        </svg>
      )}

      {hover !== null && hovered && (
        <div
          className="pointer-events-none absolute top-0 z-10 min-w-[10rem] rounded-lg border border-border bg-popover px-2.5 py-2 text-xs shadow-md"
          style={{
            transform: `translateX(${Math.min(
              Math.max(0, (hover + 0.5) * slot - 80),
              Math.max(0, width - 168)
            )}px)`,
          }}
        >
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-medium text-popover-foreground">
              {hovered.tooltipLabel ?? hovered.label}
            </span>
            <span className="font-mono text-[0.8125rem] text-popover-foreground">
              {formatTokensPrecise(hovered.cache + hovered.fresh)}
            </span>
          </div>
          <div className="mt-1.5 space-y-0.5">
            <div className="flex items-center justify-between gap-3 text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="size-2 rounded-[2px]"
                  style={{ backgroundColor: ACCENT }}
                />
                {cacheLabel}
              </span>
              <span className="font-mono tabular-nums">
                {formatTokenCount(hovered.cache)}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3 text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="size-2 rounded-[2px]"
                  style={{ backgroundColor: INK }}
                />
                {freshLabel}
              </span>
              <span className="font-mono tabular-nums">
                {formatTokenCount(hovered.fresh)}
              </span>
            </div>
            {hovered.detail.map((d) => (
              <div
                key={d.label}
                className="flex justify-between gap-3 text-muted-foreground"
              >
                <span>{d.label}</span>
                <span className="font-mono tabular-nums">{d.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Ring meter ─────────────────────────────────────────────────────────

/**
 * A radial meter for one ratio against its whole — the cache hit rate.
 *
 * A meter, not a two-slice pie: the unfilled track is a lighter step of the
 * same accent ramp, so the fill reads as "how much of the ring", never as a
 * second data series.
 */
export function RingMeter({
  ratio,
  valueText,
  caption,
  size = 116,
  thickness = 11,
  className,
}: {
  /** 0–1, already clamped by the caller's data; re-clamped here defensively. */
  ratio: number
  valueText: string
  caption: string
  size?: number
  thickness?: number
  className?: string
}) {
  const clamped = Math.min(1, Math.max(0, ratio))
  const r = (size - thickness) / 2
  const circumference = 2 * Math.PI * r
  return (
    <div
      className={cn("relative shrink-0", className)}
      style={{ width: size, height: size }}
      role="img"
      aria-label={`${caption} ${valueText}`}
    >
      <svg width={size} height={size} className="-rotate-90" aria-hidden="true">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--tu-accent-soft)"
          strokeWidth={thickness}
        />
        {clamped > 0 && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={ACCENT}
            strokeWidth={thickness}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - clamped)}
          />
        )}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-[1.375rem] font-semibold leading-none tracking-tight">
          {valueText}
        </span>
        <span className="mt-1 text-[0.625rem] leading-none text-muted-foreground">
          {caption}
        </span>
      </div>
    </div>
  )
}

// ─── Ranked bars ────────────────────────────────────────────────────────

export interface RankedDatum {
  key: string
  label: string
  value: number
  /** 0–1 share of the framing total, printed as the right-hand percent column.
   *  `null` hides the column for lists where a share reads as noise. */
  share: number | null
  /** Rendered dimmed between the label and the value — e.g. a session count. */
  hint?: string
  /** Overrides the accent fill (used for the ink scale and the "other" fold). */
  color?: string
}

/**
 * A ranked horizontal-bar list — the form for "which of these is biggest".
 *
 * Every row is directly labeled with its name, value and share, so the bars
 * are a magnitude cue rather than the only way to read the chart. All rows
 * default to the single accent hue: identity lives in the text, and one hue
 * keeps the list from impersonating a categorical encoding.
 */
export function RankedBars({
  data,
  emptyLabel,
  showRank = false,
  onSelect,
  className,
}: {
  data: RankedDatum[]
  emptyLabel: string
  /** Prefix rows with 01/02/… — the reference treatment for top-N lists. */
  showRank?: boolean
  onSelect?: (key: string) => void
  className?: string
}) {
  const max = data.reduce((m, d) => Math.max(m, d.value), 0)
  if (data.length === 0) {
    return (
      <p
        className={cn(
          "py-6 text-center text-sm text-muted-foreground",
          className
        )}
      >
        {emptyLabel}
      </p>
    )
  }
  return (
    <ul className={cn("space-y-2.5", className)}>
      {data.map((d, i) => {
        const pct = max > 0 ? (d.value / max) * 100 : 0
        const fill = d.color ?? ACCENT
        const row = (
          <>
            <div className="flex items-baseline gap-3">
              <span className="flex min-w-0 flex-1 items-baseline gap-2">
                {showRank && (
                  <span
                    aria-hidden="true"
                    className="w-5 shrink-0 font-mono text-[0.625rem] tabular-nums text-muted-foreground/70"
                  >
                    {String(i + 1).padStart(2, "0")}
                  </span>
                )}
                <span className="truncate text-[0.8125rem]">{d.label}</span>
              </span>
              {d.hint ? (
                <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                  {d.hint}
                </span>
              ) : null}
              <span className="shrink-0 font-mono text-xs tabular-nums">
                {formatTokenCount(d.value)}
              </span>
              {d.share !== null && (
                <span className="w-10 shrink-0 text-right font-mono text-[0.6875rem] tabular-nums text-muted-foreground">
                  {`${(d.share * 100).toFixed(1)}%`}
                </span>
              )}
            </div>
            <div
              className={cn(
                "mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted/70",
                showRank && "ms-7 w-auto"
              )}
            >
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.max(pct, d.value > 0 ? 1.5 : 0)}%`,
                  backgroundColor: fill,
                }}
              />
            </div>
          </>
        )
        return (
          <li key={d.key}>
            {onSelect ? (
              <button
                type="button"
                onClick={() => onSelect(d.key)}
                className="w-full rounded-md px-1 py-0.5 text-left outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
              >
                {row}
              </button>
            ) : (
              <div className="px-1 py-0.5">{row}</div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

// ─── Heatmap ────────────────────────────────────────────────────────────

const RAMP_VARS = [
  "var(--tu-seq-1)",
  "var(--tu-seq-2)",
  "var(--tu-seq-3)",
  "var(--tu-seq-4)",
  "var(--tu-seq-5)",
  "var(--tu-seq-6)",
  "var(--tu-seq-7)",
] as const

/**
 * Map a value to a ramp step.
 *
 * Square-root rather than linear: one all-nighter would otherwise flatten every
 * other cell to the palest step, hiding the weekly rhythm the chart exists to
 * show. Zero is not on the ramp at all — it returns `null` so the caller can
 * draw an explicit empty cell.
 */
export function rampStep(value: number, max: number): number | null {
  if (value <= 0 || max <= 0) return null
  const normalized = Math.sqrt(value / max)
  const step = Math.ceil(normalized * RAMP_VARS.length)
  return Math.min(RAMP_VARS.length, Math.max(1, step)) - 1
}

/** Hour ticks over the 24-column grid; the last one right-aligns to the edge. */
const HOUR_TICKS = [0, 6, 12, 18] as const

/** 24 columns is past Tailwind's named grid-cols scale; an inline template
 *  keeps it exact instead of relying on a JIT utility a purge could miss. */
const HEAT_GRID_TEMPLATE = {
  gridTemplateColumns: "repeat(24, minmax(0, 1fr))",
} as const

interface HeatHover {
  weekday: number
  hour: number
  value: number
  /** Cell box relative to the component wrapper, physical pixels. */
  x: number
  y: number
  w: number
  h: number
  containerW: number
}

export function ActivityHeatmap({
  matrix,
  max,
  weekdayLabels,
  formatAria,
  legendLess,
  legendMore,
  className,
}: {
  matrix: number[][]
  max: number
  weekdayLabels: string[]
  /** Full-sentence cell description for assistive tech — the visual tooltip
   *  is composed from the weekday/hour parts directly. */
  formatAria: (weekday: number, hour: number, value: number) => string
  legendLess: string
  legendMore: string
  className?: string
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [hover, setHover] = useState<HeatHover | null>(null)

  const onEnterCell = useCallback(
    (
      e: React.MouseEvent<HTMLDivElement>,
      weekday: number,
      hour: number,
      value: number
    ) => {
      const wrap = wrapRef.current
      if (!wrap) return
      const cell = e.currentTarget.getBoundingClientRect()
      const box = wrap.getBoundingClientRect()
      setHover({
        weekday,
        hour,
        value,
        x: cell.left - box.left,
        y: cell.top - box.top,
        w: cell.width,
        h: cell.height,
        containerW: box.width,
      })
    },
    []
  )
  const clearHover = useCallback(() => setHover(null), [])

  // The 168 cells never change on hover — the highlight ring and tooltip are
  // overlays, so pointer traffic re-renders two small divs, not the grid.
  const grid = useMemo(
    () => (
      <div
        className="grid min-h-0 flex-1 grid-cols-[auto_minmax(0,1fr)] gap-x-1.5 gap-y-[2px]"
        // Explicit rows so the seven weekday tracks split any stretch equally
        // (the panel next to this one dictates the shared card height).
        style={{ gridTemplateRows: "auto repeat(7, minmax(0, 1fr))" }}
        onMouseLeave={clearHover}
      >
        {/* Hour rail: sparse ticks — 24 labels would collide at any width. */}
        <div />
        <div
          className="mb-0.5 grid text-[0.625rem] leading-none text-muted-foreground"
          style={HEAT_GRID_TEMPLATE}
        >
          {HOUR_TICKS.map((h) => (
            <span key={h} style={{ gridColumn: `${h + 1} / span 2` }}>
              {h}
            </span>
          ))}
          <span className="text-right" style={{ gridColumn: "23 / span 2" }}>
            23
          </span>
        </div>
        {matrix.map((row, weekday) => (
          <Fragment key={weekday}>
            {/* Every other row labeled: seven stacked 10px labels collide, and
                the alternating rail still reads as a week. */}
            <span className="flex items-center pr-0.5 text-[0.625rem] leading-none text-muted-foreground">
              {weekday % 2 === 0 ? weekdayLabels[weekday] : ""}
            </span>
            {/* Cells stretch both ways: at least 16px tall, growing with the
                row track when the neighbouring panel makes the card taller. */}
            <div
              className="grid h-full min-h-4 gap-[2px]"
              style={HEAT_GRID_TEMPLATE}
            >
              {row.map((value, hour) => {
                const step = rampStep(value, max)
                return (
                  <div
                    key={hour}
                    role="img"
                    aria-label={formatAria(weekday, hour, value)}
                    onMouseEnter={(e) => onEnterCell(e, weekday, hour, value)}
                    className={cn(
                      "h-full w-full rounded-[2px]",
                      step === null &&
                        "bg-muted/40 ring-1 ring-inset ring-border/50"
                    )}
                    style={
                      step === null
                        ? undefined
                        : { backgroundColor: RAMP_VARS[step] }
                    }
                  />
                )
              })}
            </div>
          </Fragment>
        ))}
      </div>
    ),
    [matrix, max, weekdayLabels, formatAria, onEnterCell, clearHover]
  )

  return (
    // Flex + gap, NOT space-y: Tailwind v4's space-y puts margin-bottom on
    // :not(:last-child), so the absolutely-positioned hover overlays becoming
    // the last children would hand the legend a sudden bottom margin and grow
    // the whole card on hover. Out-of-flow children are invisible to flex gap.
    <div
      ref={wrapRef}
      className={cn("relative flex min-h-0 flex-1 flex-col gap-2", className)}
    >
      {grid}
      <div className="flex shrink-0 items-center justify-end gap-1.5 text-[0.625rem] text-muted-foreground">
        <span>{legendLess}</span>
        <span className="size-2.5 rounded-[2px] bg-muted/40 ring-1 ring-inset ring-border/50" />
        {RAMP_VARS.map((v) => (
          <span
            key={v}
            className="size-2.5 rounded-[2px]"
            style={{ backgroundColor: v }}
          />
        ))}
        <span>{legendMore}</span>
      </div>

      {hover && (
        <>
          {/* Hovered-cell ring — an overlay, so the grid itself never
              re-renders on pointer moves. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute rounded-[3px] ring-2 ring-foreground/35"
            style={{
              left: hover.x - 1,
              top: hover.y - 1,
              width: hover.w + 2,
              height: hover.h + 2,
            }}
          />
          <div
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg border border-border bg-popover px-2.5 py-1.5 text-xs shadow-md"
            style={{
              left: Math.min(
                Math.max(hover.x + hover.w / 2, 56),
                Math.max(56, hover.containerW - 56)
              ),
              top: hover.y - 6,
            }}
          >
            <div className="font-medium text-popover-foreground">
              {weekdayLabels[hover.weekday]}{" "}
              {String(hover.hour).padStart(2, "0")}:00
            </div>
            <div className="mt-0.5 text-end font-mono tabular-nums text-muted-foreground">
              {formatTokenCount(hover.value)}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
