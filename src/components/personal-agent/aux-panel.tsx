"use client"

/**
 * The personal agent page's right-hand panel: status, recent dispatches, open
 * matters, and data. Its own panel rather than the workspace's aux panel,
 * which a full-page route closes.
 */

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { ArrowUpRight, Loader2, Play } from "lucide-react"
import { toast } from "sonner"

import { AgentIcon } from "@/components/agent-icon"
import {
  RankedBars,
  TrendChart,
  type RankedDatum,
  type TrendDatum,
} from "@/components/token-usage/charts"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { usePersonalAgent } from "@/contexts/personal-agent-context"
import {
  personalAgentDispatches,
  personalAgentItems,
  personalAgentResumeAutoCompact,
  personalAgentStats,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type {
  DispatchInfo,
  DispatchMode,
  ItemInfo,
  PersonalAgentSnapshot,
  PersonalAgentStats,
  WaitsFor,
} from "@/lib/types"
import { cn } from "@/lib/utils"

import { DispatchStateChip, ModeIcon, useOpenDispatchTarget } from "./timeline"

export type AuxTab = "status" | "dispatches" | "items" | "data"

export function PersonalAgentAuxPanel({
  tab,
  onTabChange,
  snapshot,
}: {
  tab: AuxTab
  onTabChange: (tab: AuxTab) => void
  snapshot: PersonalAgentSnapshot
}) {
  const t = useTranslations("PersonalAgent.aux")
  return (
    <Tabs
      value={tab}
      onValueChange={(v) => onTabChange(v as AuxTab)}
      className="flex h-full min-h-0 flex-col gap-0"
    >
      <div className="flex h-10 shrink-0 items-center border-b border-border/60 px-2">
        <TabsList variant="line" className="h-8">
          <TabsTrigger value="status" className="px-2 text-xs">
            {t("status")}
          </TabsTrigger>
          <TabsTrigger value="dispatches" className="px-2 text-xs">
            {t("dispatches")}
          </TabsTrigger>
          <TabsTrigger value="items" className="px-2 text-xs">
            {t("items")}
          </TabsTrigger>
          <TabsTrigger value="data" className="px-2 text-xs">
            {t("data")}
          </TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="status" className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          <StatusTab snapshot={snapshot} />
        </ScrollArea>
      </TabsContent>
      <TabsContent value="dispatches" className="min-h-0 flex-1">
        <DispatchesTab />
      </TabsContent>
      <TabsContent value="items" className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          <ItemsTab />
        </ScrollArea>
      </TabsContent>
      <TabsContent value="data" className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          <DataTab />
        </ScrollArea>
      </TabsContent>
    </Tabs>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right break-words text-foreground">
        {children}
      </span>
    </div>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="rounded-xl border border-border/70 bg-muted/40 px-3 py-2">
      <h3 className="pb-1 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <div className="divide-y divide-border/50">{children}</div>
    </section>
  )
}

/** The context ring with the auto-compaction threshold as a tick. */
function UsageRing({
  percent,
  threshold,
}: {
  percent: number | null
  threshold: number
}) {
  const size = 64
  const stroke = 7
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const ratio = percent == null ? 0 : Math.min(1, Math.max(0, percent / 100))
  const tickAngle =
    (Math.min(100, Math.max(0, threshold)) / 100) * 2 * Math.PI - Math.PI / 2
  const tx1 = size / 2 + (r - stroke) * Math.cos(tickAngle)
  const ty1 = size / 2 + (r - stroke) * Math.sin(tickAngle)
  const tx2 = size / 2 + (r + stroke) * Math.cos(tickAngle)
  const ty2 = size / 2 + (r + stroke) * Math.sin(tickAngle)
  const hot = percent != null && threshold > 0 && percent >= threshold
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--border)"
        strokeWidth={stroke}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={hot ? "var(--color-amber-500, #f59e0b)" : "var(--primary)"}
        strokeWidth={stroke}
        strokeDasharray={`${ratio * c} ${c}`}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      {threshold > 0 ? (
        <line
          x1={tx1}
          y1={ty1}
          x2={tx2}
          y2={ty2}
          stroke="var(--foreground)"
          strokeWidth={2}
        />
      ) : null}
      <text
        x="50%"
        y="50%"
        dominantBaseline="central"
        textAnchor="middle"
        className="fill-foreground text-[0.6875rem] font-medium"
      >
        {percent == null ? "—" : `${Math.round(percent)}%`}
      </text>
    </svg>
  )
}

function StatusTab({ snapshot }: { snapshot: PersonalAgentSnapshot }) {
  const t = useTranslations("PersonalAgent.status")
  const tr = useTranslations("PersonalAgent.reason")
  const { agent, status } = snapshot
  const seg = status.segment
  const [resuming, setResuming] = useState(false)
  const model = agent?.label_snapshot.options.find(
    (o) => o.id === "model"
  )?.value_label
  const check = status.last_check
  return (
    <div className="flex flex-col gap-3 p-3">
      {status.engine !== "here" ? (
        <p className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          {t("elsewhere")}
        </p>
      ) : null}
      <Section title={t("brain")}>
        <Field label={t("agent")}>
          {agent ? (
            <span className="inline-flex items-center gap-1.5">
              <AgentIcon agentType={agent.agent_type} className="size-3.5" />
              {agent.label_snapshot.agent}
            </span>
          ) : (
            "—"
          )}
        </Field>
        {model ? <Field label={t("model")}>{model}</Field> : null}
        {agent?.label_snapshot.mode ? (
          <Field label={t("mode")}>{agent.label_snapshot.mode}</Field>
        ) : null}
      </Section>

      <Section title={t("session")}>
        <Field label={t("segment")}>
          {seg
            ? t("segmentValue", { seq: seg.seq, reason: tr(seg.start_reason) })
            : t("noSegment")}
        </Field>
        {seg ? (
          <Field label={t("startedAt")}>
            {new Date(seg.started_at).toLocaleString()}
          </Field>
        ) : null}
        {seg?.pending_reason ? (
          <Field label={t("pending")}>{tr(seg.pending_reason)}</Field>
        ) : null}
        <Field label={t("connection")}>
          {status.connected ? t("connected") : t("disconnected")}
        </Field>
        {seg?.handoff_size != null ? (
          <Field label={t("handoff")}>
            {t("handoffSize", { size: seg.handoff_size })}
            {seg.handoff_trimmed ? ` · ${t("handoffTrimmed")}` : ""}
          </Field>
        ) : null}
      </Section>

      <Section title={t("context")}>
        <div className="flex items-center gap-3 py-2">
          <UsageRing
            percent={status.usage?.percent ?? null}
            threshold={status.auto_compact_percent}
          />
          <div className="min-w-0 text-xs">
            <p className="text-foreground">
              {status.usage
                ? t("usageValue", {
                    percent: Math.round(status.usage.percent),
                    source: t(`usageSource.${status.usage.source}`),
                  })
                : status.connected
                  ? t("usageUnknown")
                  : t("usageUnknownOffline")}
            </p>
            <p className="text-muted-foreground">
              {status.auto_compact_percent > 0
                ? t("threshold", { percent: status.auto_compact_percent })
                : t("thresholdOff")}
            </p>
            <p className="text-muted-foreground">
              {status.compact_command
                ? t("command", { command: status.compact_command })
                : t("noCommand")}
            </p>
          </div>
        </div>
        {seg ? (
          <Field label={t("compactions")}>
            {t("compactionCounts", {
              auto: seg.compactions_auto,
              manual: seg.compactions_manual,
              agent: seg.compactions_agent,
            })}
          </Field>
        ) : null}
        {status.last_compaction ? (
          <Field label={t("lastCompaction")}>
            {t(`compactionStatus.${status.last_compaction.status}`)}
            {status.last_compaction.before_percent != null
              ? ` · ${Math.round(status.last_compaction.before_percent)}%`
              : ""}
            {status.last_compaction.after_percent != null
              ? ` → ${Math.round(status.last_compaction.after_percent)}%`
              : ""}
          </Field>
        ) : null}
        {check ? (
          <Field label={t("lastCheck")}>{t(`check.${check.outcome}`)}</Field>
        ) : null}
        {seg?.auto_compact_paused ? (
          <div className="flex items-center justify-between gap-2 py-1.5 text-xs">
            <span className="text-amber-700 dark:text-amber-300">
              {t("paused")}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-6 gap-1 px-2 text-xs"
              disabled={resuming || status.engine !== "here"}
              onClick={() => {
                setResuming(true)
                personalAgentResumeAutoCompact()
                  .catch((e) => toast.error(toErrorMessage(e)))
                  .finally(() => setResuming(false))
              }}
            >
              <Play className="size-3" aria-hidden />
              {t("resume")}
            </Button>
          </div>
        ) : null}
      </Section>

      <Section title={t("work")}>
        <Field label={t("queued")}>
          {t("queuedValue", {
            messages: status.queued_messages,
            events: status.pending_events,
          })}
        </Field>
        <Field label={t("dispatchSlots")}>
          {status.dispatch_limit > 0
            ? t("slotsValue", {
                running: status.dispatch_running,
                limit: status.dispatch_limit,
                queued: status.dispatch_queued,
              })
            : t("slotsUnlimited", {
                running: status.dispatch_running,
                queued: status.dispatch_queued,
              })}
        </Field>
        {status.pending_permission || status.pending_question ? (
          <Field label={t("waiting")}>{t("waitingOwner")}</Field>
        ) : null}
        <Field label={t("engine")}>
          {status.engine === "here" ? t("engineHere") : t("engineElsewhere")}
        </Field>
        {status.workdir ? (
          <Field label={t("workdir")}>
            <span className="font-mono text-[0.6875rem]">{status.workdir}</span>
          </Field>
        ) : null}
        {status.last_error ? (
          <Field label={t("lastError")}>
            <span className="text-red-700 dark:text-red-300">
              {status.last_error}
            </span>
          </Field>
        ) : null}
      </Section>
    </div>
  )
}

function DispatchesTab() {
  const t = useTranslations("PersonalAgent")
  const { dispatchVersion } = usePersonalAgent()
  const open = useOpenDispatchTarget()
  const [mode, setMode] = useState<DispatchMode | "all">("all")
  const [rows, setRows] = useState<DispatchInfo[] | null>(null)
  useEffect(() => {
    let cancelled = false
    personalAgentDispatches(mode === "all" ? null : mode, 100)
      .then((list) => {
        if (!cancelled) setRows(list)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [mode, dispatchVersion])
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-3 py-2">
        <Select
          value={mode}
          onValueChange={(v) => setMode(v as DispatchMode | "all")}
        >
          <SelectTrigger size="sm" className="h-7 w-36 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("dispatches.all")}</SelectItem>
            <SelectItem value="task">{t("mode.task")}</SelectItem>
            <SelectItem value="chat">{t("mode.chat")}</SelectItem>
            <SelectItem value="session">{t("mode.session")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-1.5 px-3 pb-3">
          {rows == null ? (
            <Loader2 className="mx-auto my-6 size-4 animate-spin text-muted-foreground" />
          ) : rows.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              {t("dispatches.empty")}
            </p>
          ) : (
            rows.map((d) => (
              <div
                key={d.id}
                className="rounded-lg border border-border/60 bg-card/50 px-2.5 py-2 text-xs"
              >
                <div className="flex min-w-0 items-center gap-1.5">
                  <ModeIcon mode={d.mode} className="text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                    {d.title}
                  </span>
                  <DispatchStateChip state={d.state} />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6"
                    title={t("timeline.open")}
                    aria-label={t("timeline.open")}
                    disabled={d.mode !== "task" && d.conversation_id == null}
                    onClick={() =>
                      open({
                        mode: d.mode,
                        workTaskId: d.work_task_id,
                        conversationId: d.conversation_id,
                        folderId: d.conversation_folder_id ?? d.folder_id,
                        agentType: d.executor.agent_type,
                      })
                    }
                  >
                    <ArrowUpRight className="size-3.5" />
                  </Button>
                </div>
                <p className="mt-0.5 truncate text-muted-foreground">
                  {t("dispatches.meta", {
                    executor: d.executor.name,
                    folder: d.folder_name ?? t("dispatches.noProject"),
                    when: new Date(d.updated_at).toLocaleString(),
                  })}
                </p>
              </div>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

const WAIT_GROUPS: (WaitsFor | "none")[] = [
  "owner",
  "agent",
  "external",
  "time",
  "none",
]

function ItemsTab() {
  const t = useTranslations("PersonalAgent")
  const { itemVersion, dispatchVersion } = usePersonalAgent()
  const [items, setItems] = useState<ItemInfo[] | null>(null)
  useEffect(() => {
    let cancelled = false
    personalAgentItems("active")
      .then((list) => {
        if (!cancelled) setItems(list)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [itemVersion, dispatchVersion])
  const grouped = useMemo(() => {
    const m = new Map<WaitsFor | "none", ItemInfo[]>()
    for (const i of items ?? []) {
      const k = i.waits_for ?? "none"
      m.set(k, [...(m.get(k) ?? []), i])
    }
    return m
  }, [items])
  if (items == null) {
    return (
      <Loader2 className="mx-auto my-6 size-4 animate-spin text-muted-foreground" />
    )
  }
  if (items.length === 0) {
    return (
      <p className="py-6 text-center text-xs text-muted-foreground">
        {t("items.empty")}
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-3 p-3">
      {WAIT_GROUPS.filter((g) => grouped.has(g)).map((g) => (
        <section key={g}>
          <h3 className="pb-1 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
            {t(`items.waits.${g}`)}
          </h3>
          <div className="flex flex-col gap-1.5">
            {grouped.get(g)!.map((i) => (
              <div
                key={i.id}
                className="rounded-lg border border-border/60 bg-card/50 px-2.5 py-2 text-xs"
              >
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[0.625rem] text-muted-foreground">
                    {t(`items.kind.${i.kind}`)}
                  </span>
                  <span className="min-w-0 flex-1 text-foreground">
                    {i.summary}
                  </span>
                  {i.dispatch_state ? (
                    <DispatchStateChip state={i.dispatch_state} />
                  ) : null}
                </div>
                {i.on_done ? (
                  <p className="mt-0.5 text-muted-foreground">
                    {t("items.onDone", { text: i.on_done })}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ))}
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
          stroke="var(--primary)"
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

function DataTab() {
  const t = useTranslations("PersonalAgent.data")
  const tm = useTranslations("PersonalAgent.mode")
  const { dispatchVersion } = usePersonalAgent()
  const [stats, setStats] = useState<PersonalAgentStats | null>(null)
  useEffect(() => {
    let cancelled = false
    personalAgentStats(14)
      .then((s) => {
        if (!cancelled) setStats(s)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [dispatchVersion])
  if (!stats) {
    return (
      <Loader2 className="mx-auto my-6 size-4 animate-spin text-muted-foreground" />
    )
  }
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
    <div className={cn("tu-viz flex flex-col gap-4 p-3")}>
      <section>
        <h3 className="pb-1 text-xs font-medium text-foreground">
          {t("interactions")}
        </h3>
        <TrendChart
          data={interactions}
          label={t("interactions")}
          cacheLabel={t("replies")}
          freshLabel={t("messages")}
          emptyLabel={t("empty")}
        />
      </section>
      <section>
        <h3 className="pb-1 text-xs font-medium text-foreground">
          {t("dispatches")}
        </h3>
        <TrendChart
          data={dispatches}
          label={t("dispatches")}
          cacheLabel={t("completed")}
          freshLabel={t("other")}
          emptyLabel={t("empty")}
        />
      </section>
      <section>
        <h3 className="pb-1 text-xs font-medium text-foreground">
          {t("executors")}
        </h3>
        <RankedBars data={executors} emptyLabel={t("empty")} />
      </section>
      <section>
        <h3 className="pb-1 text-xs font-medium text-foreground">
          {t("tokens")}
        </h3>
        <TrendChart
          data={tokens}
          label={t("tokens")}
          cacheLabel={t("dispatchTokens")}
          freshLabel={t("agentTokens")}
          emptyLabel={t("empty")}
        />
        <p className="pt-1 text-[0.6875rem] text-muted-foreground">
          {stats.tokens_synced_at
            ? t("syncedAt", {
                when: new Date(stats.tokens_synced_at).toLocaleString(),
              })
            : t("notSynced")}
        </p>
      </section>
      <section>
        <h3 className="pb-1 text-xs font-medium text-foreground">
          {t("usageCurve")}
        </h3>
        <UsageCurve stats={stats} />
      </section>
    </div>
  )
}
