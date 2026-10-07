"use client"

import { forwardRef, useMemo } from "react"
import { useTranslations } from "next-intl"
import { formatTokenCount } from "@/lib/token-format"
import {
  CACHE_HIT_RATE_DIGITS,
  cacheHitRate,
  deriveArchetype,
  formatDuration,
  formatPercent,
  formatTokensPrecise,
  type ArchetypeId,
} from "@/lib/token-usage"
import type { TokenUsageReport } from "@/lib/types"

/**
 * The shareable poster.
 *
 * ## Why it is styled the way it is
 *
 * This subtree is rasterized by `html-to-image`, which walks computed styles
 * and inlines them into an SVG `<foreignObject>`. Two consequences drive every
 * choice here:
 *
 *  1. **Fixed pixel geometry, not responsive units.** The card is always
 *     rendered at its natural 720 × 1040 size and scaled down for preview with
 *     a CSS transform on a wrapper, so the raster is identical regardless of
 *     the window it was exported from.
 *  2. **Literal colours, not CSS custom properties.** The dialog portals to
 *     `<body>`, outside the page's `.tu-viz` scope, and the rasterizer's clone
 *     resolves `var()` against wherever the clone happens to sit — so the card
 *     never says `var(--…)`. Instead [`resolveShareCardTheme`] reads the live
 *     theme once (through a probe element parked *inside* the scope) and hands
 *     the card plain resolved strings. The poster therefore follows the app's
 *     background, accent and font in both light and dark themes, while the
 *     export pipeline still only ever sees literals.
 */

/** The card's natural size. The page pins the export to exactly these numbers
 *  (and lays the preview out at them before scaling), so they are the one
 *  definition both sides read. */
export const CARD_WIDTH = 720
export const CARD_HEIGHT = 1040

/** Everything the poster needs from the live theme, as resolved literals. */
export interface ShareCardTheme {
  bg: string
  panel: string
  border: string
  text: string
  textMuted: string
  textDim: string
  /** Cache-served context — the dashboard's accent. */
  accent: string
  accentSoft: string
  /** Freshly computed tokens — the dashboard's ink. */
  ink: string
  /** Quiet track behind ranked bars. */
  track: string
  washA: string
  washB: string
  fontFamily: string
}

/**
 * Read the dashboard's palette off the live page.
 *
 * A hidden probe is appended *inside* `scope` (the `.tu-viz` page root), given
 * a candidate colour, and read back through `getComputedStyle` — which returns
 * a concrete colour with every `var()` and `color-mix()` already evaluated.
 * That concrete string is safe anywhere: in the portal'd dialog, and in the
 * rasterizer's cloned tree.
 */
export function resolveShareCardTheme(scope: HTMLElement): ShareCardTheme {
  const probe = document.createElement("div")
  probe.style.position = "absolute"
  probe.style.visibility = "hidden"
  probe.style.pointerEvents = "none"
  scope.appendChild(probe)
  const resolve = (css: string): string => {
    probe.style.color = ""
    probe.style.color = css
    return getComputedStyle(probe).color
  }
  try {
    return {
      bg: resolve("var(--background)"),
      panel: resolve("var(--card)"),
      border: resolve("var(--border)"),
      text: resolve("var(--foreground)"),
      textMuted: resolve("var(--muted-foreground)"),
      textDim: resolve(
        "color-mix(in oklab, var(--muted-foreground) 72%, var(--background))"
      ),
      accent: resolve("var(--tu-accent)"),
      accentSoft: resolve("var(--tu-accent-soft)"),
      ink: resolve("var(--tu-ink)"),
      track: resolve("color-mix(in oklab, var(--border) 55%, transparent)"),
      washA: resolve("color-mix(in oklab, var(--tu-accent) 13%, transparent)"),
      washB: resolve("color-mix(in oklab, var(--tu-accent) 7%, transparent)"),
      fontFamily: getComputedStyle(scope).fontFamily,
    }
  } finally {
    probe.remove()
  }
}

export const ARCHETYPE_EMOJI: Record<ArchetypeId, string> = {
  nightOwl: "🌙",
  earlyBird: "🌅",
  weekendWarrior: "⚔️",
  cacheMaster: "⚡",
  marathoner: "🏃",
  polyglot: "🎛️",
  laserFocus: "🎯",
  deepDiver: "🤿",
  steady: "🧱",
}

/** Explicit key maps rather than a built `archetype${Id}` template string, so
 *  next-intl's key checking still catches a typo or a removed message. */
export const ARCHETYPE_LABEL_KEYS = {
  nightOwl: "archetypeNightOwl",
  earlyBird: "archetypeEarlyBird",
  weekendWarrior: "archetypeWeekendWarrior",
  cacheMaster: "archetypeCacheMaster",
  marathoner: "archetypeMarathoner",
  polyglot: "archetypePolyglot",
  laserFocus: "archetypeLaserFocus",
  deepDiver: "archetypeDeepDiver",
  steady: "archetypeSteady",
} as const satisfies Record<ArchetypeId, string>

export const ARCHETYPE_DESC_KEYS = {
  nightOwl: "archetypeNightOwlDesc",
  earlyBird: "archetypeEarlyBirdDesc",
  weekendWarrior: "archetypeWeekendWarriorDesc",
  cacheMaster: "archetypeCacheMasterDesc",
  marathoner: "archetypeMarathonerDesc",
  polyglot: "archetypePolyglotDesc",
  laserFocus: "archetypeLaserFocusDesc",
  deepDiver: "archetypeDeepDiverDesc",
  steady: "archetypeSteadyDesc",
} as const satisfies Record<ArchetypeId, string>

function formatDay(iso: string | null, locale: string): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleDateString(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

/** How many trend bars the poster draws at most. More buckets than this are
 *  chunk-merged so every bar keeps a readable width at poster scale. */
const TREND_MAX_BARS = 48
const TREND_HEIGHT = 120
/** Inner width available to content (card width minus its padding). */
const INNER_WIDTH = CARD_WIDTH - 88

/** The dashboard's two-tone trend, at poster scale: cache-served context in
 *  accent at the baseline, freshly computed tokens capping it in ink. */
function TrendBars({
  series,
  theme,
}: {
  series: { cache: number; fresh: number }[]
  theme: ShareCardTheme
}) {
  const gap = 2
  const n = series.length
  const barW = (INNER_WIDTH - gap * (n - 1)) / n
  const max = Math.max(...series.map((p) => p.cache + p.fresh), 1)
  const scale = (TREND_HEIGHT - 2) / max
  const radius = Math.min(2, barW / 2)

  return (
    <svg
      width={INNER_WIDTH}
      height={TREND_HEIGHT}
      viewBox={`0 0 ${INNER_WIDTH} ${TREND_HEIGHT}`}
      aria-hidden="true"
      style={{ display: "block" }}
    >
      {series.map((p, i) => {
        const x = i * (barW + gap)
        const cacheH = p.cache * scale
        const freshH = p.fresh * scale
        // The 2px seam between the segments is carved from the fresh cap so
        // the stack's total height stays truthful.
        const seam = cacheH > 0 && freshH > 2 ? 2 : 0
        const totalH = cacheH + freshH
        const top = TREND_HEIGHT - totalH
        return (
          <g key={i}>
            {totalH > 0 && (
              <rect
                x={x}
                y={top}
                width={barW}
                height={totalH}
                rx={radius}
                fill={freshH > 0 ? theme.ink : theme.accent}
              />
            )}
            {cacheH > 0 && freshH > 0 && (
              <rect
                x={x}
                y={TREND_HEIGHT - cacheH + seam}
                width={barW}
                height={Math.max(cacheH - seam, 0)}
                rx={radius}
                fill={theme.accent}
              />
            )}
          </g>
        )
      })}
    </svg>
  )
}

function LegendChip({
  color,
  label,
  theme,
}: {
  color: string
  label: string
  theme: ShareCardTheme
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12,
        color: theme.textMuted,
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: 2,
          backgroundColor: color,
        }}
      />
      {label}
    </span>
  )
}

function StripCell({
  label,
  value,
  sub,
  divided,
  theme,
}: {
  label: string
  value: string
  sub?: string
  divided?: boolean
  theme: ShareCardTheme
}) {
  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        padding: "14px 18px",
        // Logical, so the divider lands between cells in RTL exports too.
        borderInlineStart: divided ? `1px solid ${theme.border}` : "none",
      }}
    >
      <div
        style={{
          fontSize: 11,
          letterSpacing: "0.05em",
          textTransform: "uppercase",
          color: theme.textDim,
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </div>
      <div
        style={{
          marginTop: 5,
          fontSize: 22,
          fontWeight: 650,
          lineHeight: 1.1,
          color: theme.text,
        }}
      >
        {value}
      </div>
      {sub ? (
        <div
          style={{
            marginTop: 3,
            fontSize: 11,
            color: theme.textMuted,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {sub}
        </div>
      ) : null}
    </div>
  )
}

function RankRow({
  rank,
  label,
  value,
  share,
  theme,
}: {
  rank: number
  label: string
  value: string
  share: number
  theme: ShareCardTheme
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 8,
            minWidth: 0,
          }}
        >
          <span
            style={{
              width: 18,
              flexShrink: 0,
              fontSize: 11,
              color: theme.textDim,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {String(rank).padStart(2, "0")}
          </span>
          <span
            style={{
              fontSize: 14,
              color: theme.text,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              maxWidth: 210,
            }}
          >
            {label}
          </span>
        </div>
        <span
          style={{
            fontSize: 12,
            color: theme.textMuted,
            fontVariantNumeric: "tabular-nums",
            flexShrink: 0,
          }}
        >
          {value}
        </span>
      </div>
      <div
        style={{
          marginTop: 6,
          // Indented to the label's start edge (past the rank column) —
          // logical, so RTL exports indent from the right.
          marginInlineStart: 26,
          height: 4,
          borderRadius: 999,
          backgroundColor: theme.track,
          overflow: "hidden",
        }}
      >
        {/* Identity lives in the label; the bar only carries magnitude, so
            every row wears the one accent instead of a rank-slot rainbow. */}
        <div
          style={{
            width: `${Math.max(share * 100, 2)}%`,
            height: "100%",
            borderRadius: 999,
            backgroundColor: theme.accent,
          }}
        />
      </div>
    </div>
  )
}

export interface ShareCardProps {
  report: TokenUsageReport
  /** BCP-47 tag for date formatting — the app's active locale. */
  locale: string
  /** Live theme, pre-resolved to literals by [`resolveShareCardTheme`]. */
  theme: ShareCardTheme
}

/**
 * Rendered off-screen at full size and rasterized by the parent through the
 * forwarded ref.
 */
export const ShareCard = forwardRef<HTMLDivElement, ShareCardProps>(
  function ShareCard({ report, locale, theme }, ref) {
    const t = useTranslations("TokenUsage")
    const { totals } = report

    const archetype = useMemo(() => deriveArchetype(report), [report])
    const cache = cacheHitRate(totals)
    const freshTotal = Math.max(
      0,
      totals.total_tokens - totals.cache_read_tokens
    )

    // Chunk-merge long series so a year of daily buckets still draws as
    // readable bars instead of hairlines.
    const trend = useMemo(() => {
      const points = report.series.map((p) => ({
        cache: p.cache_read_tokens,
        fresh: Math.max(0, p.total_tokens - p.cache_read_tokens),
      }))
      if (points.length <= TREND_MAX_BARS) return points
      const size = Math.ceil(points.length / TREND_MAX_BARS)
      const merged: { cache: number; fresh: number }[] = []
      for (let i = 0; i < points.length; i += size) {
        const chunk = points.slice(i, i + size)
        merged.push({
          cache: chunk.reduce((s, p) => s + p.cache, 0),
          fresh: chunk.reduce((s, p) => s + p.fresh, 0),
        })
      }
      return merged
    }, [report.series])

    const rangeLabel =
      report.range_start && report.range_end
        ? `${formatDay(report.range_start, locale)} – ${formatDay(
            // `range_end` is exclusive; step back an instant so the printed
            // end date is the last day actually counted.
            new Date(new Date(report.range_end).getTime() - 1).toISOString(),
            locale
          )}`
        : t("cardRangeAll")

    // Four rows each — with the agent chip row gone the rankings carry the
    // card's lower half, and three rows left it visibly bottom-heavy with
    // whitespace.
    const topModels = report.by_model.slice(0, 4)
    const topProjects = report.by_folder.slice(0, 4)
    const modelTotal = topModels.reduce((s, m) => s + m.total_tokens, 0)
    const projectTotal = topProjects.reduce((s, p) => s + p.total_tokens, 0)

    const panelStyle = {
      borderRadius: 16,
      backgroundColor: theme.panel,
      border: `1px solid ${theme.border}`,
    } as const

    return (
      <div
        ref={ref}
        style={{
          width: CARD_WIDTH,
          height: CARD_HEIGHT,
          position: "relative",
          overflow: "hidden",
          backgroundColor: theme.bg,
          color: theme.text,
          fontFamily: theme.fontFamily,
          // The rasterizer walks the live tree, so the card must be laid out
          // (not `display: none`) even while it is parked off-screen.
          display: "flex",
          flexDirection: "column",
          // Slightly shallower at the bottom: the footer divider reads as
          // evenly inset when its gap above (the flex slack) and this padding
          // sit around the mid-30s together.
          padding: "44px 44px 36px",
          boxSizing: "border-box",
        }}
      >
        {/* Two soft accent washes instead of a flat fill — enough depth to
            make the card feel designed, cheap enough to rasterize exactly. */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: `radial-gradient(760px 420px at 12% -6%, ${theme.washA}, transparent 62%), radial-gradient(680px 460px at 105% 104%, ${theme.washB}, transparent 60%)`,
            pointerEvents: "none",
          }}
        />

        <div
          style={{
            position: "relative",
            flex: 1,
            display: "flex",
            flexDirection: "column",
          }}
        >
          {/* Header */}
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: 16,
            }}
          >
            <div>
              <div
                style={{
                  fontSize: 27,
                  fontWeight: 700,
                  letterSpacing: "-0.02em",
                }}
              >
                {t("cardHeading")}
              </div>
              <div
                style={{ marginTop: 6, fontSize: 14, color: theme.textMuted }}
              >
                {rangeLabel}
              </div>
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 14px",
                borderRadius: 999,
                backgroundColor: theme.accentSoft,
                border: `1px solid ${theme.border}`,
                fontSize: 13,
              }}
            >
              <span style={{ fontSize: 15 }}>
                {ARCHETYPE_EMOJI[archetype.id]}
              </span>
              <span style={{ color: theme.text, fontWeight: 600 }}>
                {t(ARCHETYPE_LABEL_KEYS[archetype.id])}
              </span>
            </div>
          </div>

          {/* Hero number */}
          <div style={{ marginTop: 34 }}>
            <div
              style={{
                fontSize: 13,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: theme.textDim,
              }}
            >
              {t("cardTotalLabel")}
            </div>
            {/* Proportional figures on purpose — a hero number is read, not
                column-aligned, and tabular digits look loose at this size. */}
            <div
              style={{
                marginTop: 4,
                fontSize: 84,
                fontWeight: 750,
                letterSpacing: "-0.04em",
                lineHeight: 1,
                color: theme.text,
              }}
            >
              {formatTokensPrecise(totals.total_tokens)}
            </div>
            <div style={{ marginTop: 12, fontSize: 15, color: theme.text }}>
              {t(ARCHETYPE_DESC_KEYS[archetype.id], archetype.values)}
            </div>
          </div>

          {/* Trend, in the dashboard's two colours */}
          {trend.length > 1 && (
            <div style={{ marginTop: 26 }}>
              <TrendBars series={trend} theme={theme} />
              <div
                style={{
                  display: "flex",
                  gap: 16,
                  marginTop: 10,
                }}
              >
                <LegendChip
                  color={theme.accent}
                  label={t("cacheRead")}
                  theme={theme}
                />
                <LegendChip
                  color={theme.ink}
                  label={t("freshTokens")}
                  theme={theme}
                />
              </div>
            </div>
          )}

          {/* Cache meter — the poster's version of the dashboard's ring */}
          {cache !== null && (
            <div
              style={{
                ...panelStyle,
                marginTop: 18,
                padding: "16px 18px",
                display: "flex",
                alignItems: "center",
                gap: 18,
              }}
            >
              <div style={{ flexShrink: 0 }}>
                <div
                  style={{
                    fontSize: 11,
                    letterSpacing: "0.05em",
                    textTransform: "uppercase",
                    color: theme.textDim,
                    whiteSpace: "nowrap",
                  }}
                >
                  {t("cacheHitCaption")}
                </div>
                <div
                  style={{
                    marginTop: 4,
                    fontSize: 30,
                    fontWeight: 700,
                    lineHeight: 1,
                    color: theme.text,
                  }}
                >
                  {formatPercent(cache, CACHE_HIT_RATE_DIGITS)}
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    display: "flex",
                    gap: 2,
                    height: 8,
                    borderRadius: 999,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: `${cache * 100}%`,
                      backgroundColor: theme.accent,
                    }}
                  />
                  <div style={{ flex: 1, backgroundColor: theme.ink }} />
                </div>
                <div
                  style={{
                    marginTop: 8,
                    fontSize: 12,
                    lineHeight: 1.5,
                    color: theme.textMuted,
                  }}
                >
                  {t("cacheHeroDesc", {
                    cached: formatTokensPrecise(totals.cache_read_tokens),
                    fresh: formatTokensPrecise(freshTotal),
                  })}
                </div>
              </div>
            </div>
          )}

          {/* Stats strip — one connected band, like the dashboard's */}
          <div
            style={{
              ...panelStyle,
              marginTop: 12,
              display: "flex",
            }}
          >
            <StripCell
              label={t("tileSessions")}
              value={totals.conversation_count.toLocaleString(locale)}
              theme={theme}
            />
            <StripCell
              divided
              label={t("tileTurns")}
              value={totals.turn_count.toLocaleString(locale)}
              theme={theme}
            />
            <StripCell
              divided
              label={t("tileActiveDays")}
              value={totals.active_days.toLocaleString(locale)}
              sub={
                report.streak.longest_days > 1
                  ? `${t("streakLongest")} ${report.streak.longest_days}`
                  : undefined
              }
              theme={theme}
            />
            <StripCell
              divided
              label={t("tileGenTime")}
              value={formatDuration(totals.duration_ms)}
              theme={theme}
            />
          </div>

          {/* Rankings. Together with the taller trend block this sizes the
              column so the leftover slack above the footer divider lands
              close to the card's own 44px bottom padding — the divider reads
              as evenly inset, not floating. */}
          <div style={{ display: "flex", gap: 28, marginTop: 34 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 12,
                  letterSpacing: "0.04em",
                  textTransform: "uppercase",
                  color: theme.textDim,
                  marginBottom: 12,
                }}
              >
                {t("cardTopModels")}
              </div>
              {topModels.map((m, i) => (
                <RankRow
                  key={m.key}
                  rank={i + 1}
                  label={m.key === "__unknown__" ? t("unknownModel") : m.label}
                  value={formatTokenCount(m.total_tokens)}
                  share={modelTotal > 0 ? m.total_tokens / modelTotal : 0}
                  theme={theme}
                />
              ))}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 12,
                  letterSpacing: "0.04em",
                  textTransform: "uppercase",
                  color: theme.textDim,
                  marginBottom: 12,
                }}
              >
                {t("cardTopProjects")}
              </div>
              {topProjects.map((p, i) => (
                <RankRow
                  key={p.key}
                  rank={i + 1}
                  label={p.label}
                  value={formatTokenCount(p.total_tokens)}
                  share={projectTotal > 0 ? p.total_tokens / projectTotal : 0}
                  theme={theme}
                />
              ))}
            </div>
          </div>

          {/* Footer — a labelled divider (the shadcn "separator with label"
              pattern, hand-rolled: the card can't use components whose classes
              resolve against theme scopes the rasterizer never sees). */}
          <div
            style={{
              marginTop: "auto",
              display: "flex",
              alignItems: "center",
              gap: 14,
            }}
          >
            <div
              style={{ flex: 1, height: 1, backgroundColor: theme.border }}
            />
            <span
              style={{
                fontSize: 12,
                color: theme.textDim,
                whiteSpace: "nowrap",
              }}
            >
              {t("cardFooter")}
            </span>
            <div
              style={{ flex: 1, height: 1, backgroundColor: theme.border }}
            />
          </div>
        </div>
      </div>
    )
  }
)
