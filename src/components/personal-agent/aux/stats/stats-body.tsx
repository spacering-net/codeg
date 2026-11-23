"use client"

/** Its numbers over the last days: a tile each for the conversation and the
 *  tokens, a bar of what each is made of under its figure; the work handed
 *  out on a tile across, its rate of completion at its end; the daily
 *  conversation as a chart, the daily work handed out as a row of days;
 *  then, folded on one card, who it handed work to, the daily tokens and the
 *  context's curve. All in the colour of its face, where it has one. */

import { useEffect, useState, type CSSProperties } from "react"
import { useLocale, useTranslations } from "next-intl"
import {
  RankedBars,
  TrendChart,
  type RankedDatum,
  type TrendDatum,
} from "@/components/token-usage/charts"
import { Skeleton } from "@/components/ui/skeleton"
import { usePersonalAgent } from "@/contexts/personal-agent-context"
import { personalAgentStats } from "@/lib/api"
import { formatTokenCount } from "@/lib/token-format"
import type { BotColor, PersonalAgentStats } from "@/lib/types"
import { cn } from "@/lib/utils"

import { PANEL_SURFACE, PanelFold, PanelFolds } from "../../panel-section"
import { DotStrip } from "../kit/dot-strip"
import { KpiTile } from "../kit/kpi-tile"
import { type Of, ofBot } from "../use-work"

/** The ranges the stats tab covers, in days, and where it starts. */
export const STATS_RANGES = [7, 14, 30] as const
export type StatsRange = (typeof STATS_RANGES)[number]
export const DEFAULT_RANGE: StatsRange = 14

/** The panel's charts, in px: shorter than the token dashboard's. */
const CHART_HEIGHT = 148

/** Below this many pieces of work handed out, the rate says it is a small
 *  sample. */
const SMALL_SAMPLE = 5

/** The context-usage curve: the reading before each delivery and the two
 *  ends of each compaction, with each new session as a break. */
function UsageCurve({ stats }: { stats: PersonalAgentStats }) {
  const t = useTranslations("PersonalAgent.data")
  const points = stats.usage
  if (points.length < 2) {
    return (
      <p className="py-4 text-center text-xs text-muted-foreground">
        {t("noUsage")}
      </p>
    )
  }
  const w = 320
  const h = 110
  const t0 = new Date(points[0].at).getTime()
  const t1 = new Date(points[points.length - 1].at).getTime()
  const span = Math.max(1, t1 - t0)
  const x = (at: string) => ((new Date(at).getTime() - t0) / span) * (w - 8) + 4
  const y = (p: number) =>
    h - 6 - (Math.min(100, Math.max(0, p)) / 100) * (h - 12)
  // One polyline per segment: a new session starts from an empty context.
  const lines: string[] = []
  let current: string[] = []
  for (const p of points) {
    if (p.kind === "segment_start") {
      if (current.length > 1) lines.push(current.join(" "))
      current = []
      continue
    }
    current.push(`${x(p.at).toFixed(1)},${y(p.percent).toFixed(1)}`)
  }
  if (current.length > 1) lines.push(current.join(" "))
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="h-28 w-full"
      role="img"
      aria-label={t("usageCurve")}
    >
      {[25, 50, 75].map((g) => (
        <line
          key={g}
          x1={0}
          x2={w}
          y1={y(g)}
          y2={y(g)}
          stroke="var(--border)"
          strokeWidth={0.5}
        />
      ))}
      {lines.map((pts, i) => (
        <polyline
          key={i}
          points={pts}
          fill="none"
          stroke="var(--tu-accent)"
          strokeWidth={1.5}
        />
      ))}
      {points
        .filter((p) => p.kind === "compaction_after")
        .map((p, i) => (
          <circle
            key={`c${i}`}
            cx={x(p.at)}
            cy={y(p.percent)}
            r={2.5}
            fill="var(--color-amber-500, #f59e0b)"
          />
        ))}
      {points
        .filter((p) => p.kind === "segment_start")
        .map((p, i) => (
          <line
            key={`s${i}`}
            x1={x(p.at)}
            x2={x(p.at)}
            y1={4}
            y2={h - 4}
            stroke="var(--muted-foreground)"
            strokeDasharray="2 2"
            strokeWidth={0.75}
          />
        ))}
    </svg>
  )
}

/** A chart's card: its title, what it adds up to, and what its colours
 *  are, over it. */
function ChartCard({
  title,
  summary,
  legend,
  children,
  ...props
}: {
  title: string
  summary?: string | number | null
  legend?: { label: string; color: string }[]
  children: React.ReactNode
} & Omit<React.ComponentProps<"section">, "title">) {
  return (
    <section
      className={cn(PANEL_SURFACE, "flex min-w-0 flex-col gap-3 p-4")}
      {...props}
    >
      <div className="flex min-w-0 items-center gap-3">
        <h3 className="min-w-0 truncate text-sm font-semibold">{title}</h3>
        {legend ? (
          <ul
            aria-hidden
            className="flex shrink-0 items-center gap-2.5 text-[0.6875rem] text-muted-foreground"
          >
            {legend.map((l) => (
              <li key={l.label} className="flex items-center gap-1">
                <span
                  className="size-2 rounded-[0.1875rem]"
                  style={{ background: l.color }}
                />
                {l.label}
              </li>
            ))}
          </ul>
        ) : null}
        {summary != null ? (
          <span className="ms-auto shrink-0 text-xs text-muted-foreground tabular-nums">
            {summary}
          </span>
        ) : null}
      </div>
      {children}
    </section>
  )
}

export function StatsBody({
  face,
  days,
}: {
  face: BotColor | null
  days: StatsRange
}) {
  const t = useTranslations("PersonalAgent.data")
  const locale = useLocale()
  const tm = useTranslations("PersonalAgent.mode")
  const { botId, dispatchVersion } = usePersonalAgent()
  // Kept with the assistant and the range it is of.
  const [statsOf, setStatsOf] = useState<Of<{
    days: number
    stats: PersonalAgentStats
  }> | null>(null)
  useEffect(() => {
    let cancelled = false
    personalAgentStats(days, botId)
      .then((s) => {
        if (!cancelled) setStatsOf({ bot: botId, value: { days, stats: s } })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [dispatchVersion, botId, days])
  const read = ofBot(statsOf, botId)
  const stats = read?.days === days ? read.stats : null
  if (!stats) {
    return <Skeleton className="h-[10.5rem] w-full rounded-2xl" aria-hidden />
  }
  const sum = (pick: (d: PersonalAgentStats["days"][number]) => number) =>
    stats.days.reduce((n, d) => n + pick(d), 0)
  const owner = sum((d) => d.owner_messages)
  const replies = sum((d) => d.replies)
  const handed = sum(
    (d) => d.dispatches_task + d.dispatches_chat + d.dispatches_session
  )
  const completed = sum((d) => d.dispatches_completed)
  const failed = sum((d) => d.dispatches_failed)
  const agentTokens = sum((d) => d.agent_tokens)
  const dispatchTokens = sum((d) => d.dispatch_tokens)
  const synced = stats.tokens_synced_at != null
  const label = (date: string) => date.slice(5)
  const interactions: TrendDatum[] = stats.days.map((d) => ({
    key: d.date,
    label: label(d.date),
    tooltipLabel: d.date,
    cache: d.replies,
    fresh: d.owner_messages,
    detail: [],
  }))
  const tokens: TrendDatum[] = stats.days.map((d) => ({
    key: d.date,
    label: label(d.date),
    tooltipLabel: d.date,
    cache: d.dispatch_tokens,
    fresh: d.agent_tokens,
    detail: [],
  }))
  const dispatchDays = stats.days.map((d) => {
    const count = d.dispatches_task + d.dispatches_chat + d.dispatches_session
    return {
      key: d.date,
      count,
      failed: d.dispatches_failed > 0,
      title: [
        label(d.date),
        `${tm("task")} ${d.dispatches_task}`,
        `${tm("chat")} ${d.dispatches_chat}`,
        `${tm("session")} ${d.dispatches_session}`,
        `${t("failed")} ${d.dispatches_failed}`,
      ].join(" · "),
    }
  })
  const totalDispatches = stats.agents.reduce((n, e) => n + e.dispatches, 0)
  const byAgent: RankedDatum[] = stats.agents.map((e) => ({
    key: e.agent_type,
    label: e.name,
    value: e.dispatches,
    share: totalDispatches > 0 ? e.dispatches / totalDispatches : null,
    hint: t("completedHint", { count: e.completed }),
  }))
  const rate = handed > 0 ? Math.round((completed / handed) * 100) : null
  return (
    <div
      className="tu-viz flex min-w-0 flex-col gap-4 text-sm"
      data-pa-face={face ?? undefined}
      // The token dashboard's accent, for these, the face's own colour.
      style={
        face
          ? ({ "--tu-accent": "var(--pa-body)" } as CSSProperties)
          : undefined
      }
    >
      <dl
        data-pa-figures
        className="grid grid-cols-2 gap-4 @max-[18rem]/aux:grid-cols-1"
      >
        <KpiTile
          label={t("figure.conversation")}
          value={String(owner + replies)}
          split={[owner, replies]}
          sub={t("figure.conversationSub", { owner, replies })}
        />
        <KpiTile
          label={t("figure.tokens")}
          value={synced ? formatTokenCount(agentTokens + dispatchTokens) : "—"}
          split={synced ? [agentTokens, dispatchTokens] : null}
          sub={
            synced
              ? t("figure.tokensSub", {
                  agent: formatTokenCount(agentTokens),
                  dispatch: formatTokenCount(dispatchTokens),
                })
              : t("figure.tokensUnsynced")
          }
        />
        <KpiTile
          className="col-span-2 @max-[18rem]/aux:col-span-1"
          label={t("figure.dispatches")}
          value={String(handed)}
          sub={t("figure.dispatchesSub", { completed, failed })}
          aside={
            <div className="flex flex-col items-end gap-1 text-end">
              <span className="text-xs text-muted-foreground">
                {t("figure.completion")}
              </span>
              <span
                data-pa-completion
                className={cn(
                  "text-lg leading-6 font-semibold tabular-nums",
                  rate != null && "text-emerald-600 dark:text-emerald-400"
                )}
              >
                {rate != null ? `${rate}%` : "—"}
              </span>
              {handed > 0 && handed < SMALL_SAMPLE ? (
                <span className="max-w-32 text-[0.6875rem] leading-4 text-muted-foreground">
                  {t("smallSample", { count: handed })}
                </span>
              ) : null}
            </div>
          }
        />
      </dl>
      <ChartCard
        title={t("interactions")}
        summary={owner + replies}
        legend={[
          { label: t("replies"), color: "var(--tu-accent)" },
          { label: t("messages"), color: "var(--tu-ink)" },
        ]}
        data-pa-chart-card="interactions"
      >
        <TrendChart
          data={interactions}
          label={t("interactions")}
          cacheLabel={t("replies")}
          freshLabel={t("messages")}
          emptyLabel={t("empty")}
          height={CHART_HEIGHT}
        />
      </ChartCard>
      <ChartCard
        title={t("dispatches")}
        summary={t("inDays", { days, count: handed })}
        data-pa-chart-card="dispatches"
      >
        <DotStrip
          days={dispatchDays}
          label={t("inDays", { days, count: handed })}
        />
      </ChartCard>
      {/* The rest, folded on one card. */}
      <PanelFolds>
        <PanelFold
          fold="stats.agents"
          title={t("agents")}
          summary={stats.agents.length}
        >
          <RankedBars data={byAgent} emptyLabel={t("empty")} />
        </PanelFold>
        <PanelFold
          fold="stats.tokens"
          title={t("tokens")}
          summary={
            synced ? formatTokenCount(agentTokens + dispatchTokens) : "—"
          }
        >
          <TrendChart
            data={tokens}
            label={t("tokens")}
            cacheLabel={t("dispatchTokens")}
            freshLabel={t("agentTokens")}
            emptyLabel={t("empty")}
            height={CHART_HEIGHT}
          />
          <p className="pt-1 text-[0.6875rem] leading-4 text-muted-foreground">
            {synced
              ? t("syncedAt", {
                  when: new Date(stats.tokens_synced_at!).toLocaleString(
                    locale
                  ),
                })
              : t("notSynced")}
          </p>
        </PanelFold>
        <PanelFold fold="stats.usage" title={t("usageCurve")}>
          <UsageCurve stats={stats} />
        </PanelFold>
      </PanelFolds>
    </div>
  )
}
