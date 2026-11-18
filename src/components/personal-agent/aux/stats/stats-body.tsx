"use client"

/** Its numbers over the last days: four figures, then the charts. */

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

import { PANEL_SURFACE, PanelCard } from "../../panel-section"
import { type Of, ofBot } from "../use-work"

/** Days the stats tab covers. */
export const STATS_DAYS = 14

/** The panel's charts, in px: shorter than the token dashboard's. */
const CHART_HEIGHT = 148

/** One figure of the last two weeks: what it counts, how many, what it is
 *  made of. */
function Figure({
  label,
  value,
  sub,
}: {
  label: string
  value: string
  sub?: string
}) {
  return (
    <div className="min-w-0 px-3 py-2.5">
      <dt className="truncate text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-[1.375rem] leading-7 font-semibold tracking-tight text-foreground tabular-nums">
        {value}
      </dd>
      {sub ? (
        <dd
          className="truncate text-[0.6875rem] leading-4 text-muted-foreground tabular-nums"
          title={sub}
        >
          {sub}
        </dd>
      ) : null}
    </div>
  )
}

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

/** A chart of the stats tab, as a folding card: its title and total in
 *  its header. */
const ChartSection = PanelCard

/** Its numbers: the stats tab's second part — its charts in the colour of
 *  its face, where it has one. */
export function StatsBody({ face }: { face: BotColor | null }) {
  const t = useTranslations("PersonalAgent.data")
  const locale = useLocale()
  const tm = useTranslations("PersonalAgent.mode")
  const { botId, dispatchVersion } = usePersonalAgent()
  const [statsOf, setStatsOf] = useState<Of<PersonalAgentStats> | null>(null)
  useEffect(() => {
    let cancelled = false
    personalAgentStats(STATS_DAYS, botId)
      .then((s) => {
        if (!cancelled) setStatsOf({ bot: botId, value: s })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [dispatchVersion, botId])
  const stats = ofBot(statsOf, botId)
  if (!stats) {
    return <Skeleton className="h-[10.5rem] w-full rounded-xl" aria-hidden />
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
  const dispatches: TrendDatum[] = stats.days.map((d) => ({
    key: d.date,
    label: label(d.date),
    tooltipLabel: d.date,
    cache: d.dispatches_completed,
    fresh: Math.max(
      0,
      d.dispatches_task +
        d.dispatches_chat +
        d.dispatches_session -
        d.dispatches_completed
    ),
    detail: [
      { label: tm("task"), value: String(d.dispatches_task) },
      { label: tm("chat"), value: String(d.dispatches_chat) },
      { label: tm("session"), value: String(d.dispatches_session) },
      { label: t("failed"), value: String(d.dispatches_failed) },
    ],
  }))
  const tokens: TrendDatum[] = stats.days.map((d) => ({
    key: d.date,
    label: label(d.date),
    tooltipLabel: d.date,
    cache: d.dispatch_tokens,
    fresh: d.agent_tokens,
    detail: [],
  }))
  const totalDispatches = stats.executors.reduce((n, e) => n + e.dispatches, 0)
  const executors: RankedDatum[] = stats.executors.map((e) => ({
    key: String(e.assistant_id),
    label: e.name,
    value: e.dispatches,
    share: totalDispatches > 0 ? e.dispatches / totalDispatches : null,
    hint: t("completedHint", { count: e.completed }),
  }))
  return (
    <div
      className="tu-viz flex min-w-0 flex-col gap-2.5 text-sm"
      data-pa-face={face ?? undefined}
      // The token dashboard's accent, for these, the face's own colour.
      style={
        face
          ? ({ "--tu-accent": "var(--pa-body)" } as CSSProperties)
          : undefined
      }
    >
      {/* The four on one card, a hairline between them. */}
      <dl
        className={cn(
          PANEL_SURFACE,
          "grid grid-cols-2 overflow-hidden [&>div]:border-border/60 [&>div:nth-child(-n+2)]:border-b [&>div:nth-child(odd)]:border-e"
        )}
      >
        <Figure
          label={t("figure.conversation")}
          value={String(owner + replies)}
          sub={t("figure.conversationSub", { owner, replies })}
        />
        <Figure
          label={t("figure.dispatches")}
          value={String(handed)}
          sub={t("figure.dispatchesSub", { completed, failed })}
        />
        <Figure
          label={t("figure.completion")}
          value={
            handed > 0 ? `${Math.round((completed / handed) * 100)}%` : "—"
          }
          sub={t("figure.completionSub")}
        />
        <Figure
          label={t("figure.tokens")}
          value={synced ? formatTokenCount(agentTokens + dispatchTokens) : "—"}
          sub={
            synced
              ? t("figure.tokensSub", {
                  agent: formatTokenCount(agentTokens),
                  dispatch: formatTokenCount(dispatchTokens),
                })
              : t("figure.tokensUnsynced")
          }
        />
      </dl>
      <ChartSection
        fold="stats.interactions"
        title={t("interactions")}
        summary={owner + replies}
      >
        <TrendChart
          data={interactions}
          label={t("interactions")}
          cacheLabel={t("replies")}
          freshLabel={t("messages")}
          emptyLabel={t("empty")}
          height={CHART_HEIGHT}
        />
      </ChartSection>
      <ChartSection
        fold="stats.dispatches"
        title={t("dispatches")}
        summary={handed}
      >
        <TrendChart
          data={dispatches}
          label={t("dispatches")}
          cacheLabel={t("completed")}
          freshLabel={t("other")}
          emptyLabel={t("empty")}
          height={CHART_HEIGHT}
        />
      </ChartSection>
      <ChartSection
        fold="stats.executors"
        title={t("executors")}
        summary={stats.executors.length}
      >
        <RankedBars data={executors} emptyLabel={t("empty")} />
      </ChartSection>
      <ChartSection
        fold="stats.tokens"
        title={t("tokens")}
        summary={synced ? formatTokenCount(agentTokens + dispatchTokens) : "—"}
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
                when: new Date(stats.tokens_synced_at!).toLocaleString(locale),
              })
            : t("notSynced")}
        </p>
      </ChartSection>
      <ChartSection fold="stats.usage" title={t("usageCurve")} summary={null}>
        <UsageCurve stats={stats} />
      </ChartSection>
    </div>
  )
}
