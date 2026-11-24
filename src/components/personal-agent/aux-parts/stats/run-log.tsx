"use client"

/** The run log, and the details of how it runs: what the runtime card's
 *  foot opens, each in a dialog. */

import { useMemo, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { usePersonalAgent } from "@/contexts/personal-agent-context"
import type { PersonalAgentSnapshot, TimelineRow } from "@/lib/types"

import { num, str } from "../../shared"
import { useWhen } from "./runtime-card"

/** Run-log lines the status tab lists. */
const RUN_LOG_LINES = 50

/** A marker row in words, for the run log. */
function useRunLogLine(): (row: TimelineRow) => string {
  const t = useTranslations("PersonalAgent.runLog")
  const tr = useTranslations("PersonalAgent.reason")
  return (row) => {
    const data = row.data
    switch (str(data, "marker")) {
      case "segment_start":
        return t("newSession", {
          agent: str(data, "agent") ?? "",
          reason: tr(`${str(data, "reason") ?? "first"}` as "first"),
        })
      case "pending_switch":
        return t("pendingSwitch", {
          reason: tr(`${str(data, "reason") ?? "manual"}` as "manual"),
        })
      case "reconnected":
        return t("reconnected")
      case "options_changed":
        return t("optionsChanged")
      case "compaction": {
        const status = str(data, "status") ?? "ok"
        const who = str(data, "initiator") ?? "auto"
        const before = num(data, "before_percent")
        const after = num(data, "after_percent")
        const range =
          before != null && after != null
            ? t("range", {
                before: Math.round(before),
                after: Math.round(after),
              })
            : ""
        const said = t(`compaction.${status}` as "compaction.ok", {
          who: t(`by.${who}` as "by.auto"),
          range,
        })
        // Notes taken before it (7.7).
        return str(data, "notes") === "ok" ? `${said}${t("notesFirst")}` : said
      }
      case "compaction_paused":
        return t("compactionPaused")
      case "overflow":
        return str(data, "action") === "new_segment"
          ? t("overflowNewSession")
          : t("overflowCompact")
      case "turn_canceled":
        return t("turnStopped")
      case "turn_failed":
        return t("turnFailed", { error: str(data, "error") ?? "" })
      case "turn_interrupted":
        return str(data, "why") === "preempted"
          ? t("turnPreempted")
          : t("turnInterrupted")
      case "workdir_changed":
        return t("workdirChanged", { path: str(data, "path") ?? "" })
      default:
        return row.body
    }
  }
}

/** The run log's lines: the marker rows, newest first, the last few. */
export function useRunLogMarkers(): TimelineRow[] {
  const { rows } = usePersonalAgent()
  return useMemo(
    () =>
      rows
        .filter((r) => r.kind === "marker")
        .slice(-RUN_LOG_LINES)
        .reverse(),
    [rows]
  )
}

/** The run log: what happened to the agent's sessions, a line each and
 *  when. */
export function RunLogList({ markers }: { markers: TimelineRow[] }) {
  const t = useTranslations("PersonalAgent.runLog")
  const when = useWhen()
  const line = useRunLogLine()
  return markers.length === 0 ? (
    <p className="text-xs leading-5 text-muted-foreground">{t("empty")}</p>
  ) : (
    <ul className="flex flex-col divide-y divide-border/50">
      {markers.map((m) => (
        <li key={m.id} className="flex min-w-0 items-start gap-3 py-1.5">
          <span className="min-w-0 flex-1 text-xs leading-5 break-words text-foreground/85">
            {line(m)}
          </span>
          <span className="shrink-0 text-2xs leading-5 text-muted-foreground tabular-nums">
            {when(m.created_at)}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** One label and its value in the details: the value wraps, as some run
 *  long (an error). */
function DetailRow({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div className="col-span-2 grid grid-cols-subgrid items-baseline border-b border-border/50 py-1.5 last:border-b-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 leading-5 break-words text-foreground/85">
        {children}
      </dd>
    </div>
  )
}

/** The rest of how it runs: its mode and connection, its handoff, its
 *  compactions, the command, its last check, what waits, its slots for
 *  handed-out work, where its engine runs, its last error. */
export function DetailsList({ snapshot }: { snapshot: PersonalAgentSnapshot }) {
  const t = useTranslations("PersonalAgent.status")
  const to = useTranslations("PersonalAgent.overview")
  const { agent, status } = snapshot
  const seg = status.segment
  const check = status.last_check
  const mode = agent?.label_snapshot?.mode
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 text-xs">
      {mode ? <DetailRow label={t("mode")}>{mode}</DetailRow> : null}
      <DetailRow label={t("connection")}>
        {status.connected ? t("connected") : t("disconnected")}
      </DetailRow>
      {seg?.handoff_size != null ? (
        <DetailRow label={t("handoff")}>
          {t("handoffSize", { size: seg.handoff_size })}
          {seg.handoff_trimmed ? ` · ${t("handoffTrimmed")}` : ""}
        </DetailRow>
      ) : null}
      {seg ? (
        <DetailRow label={t("compactions")}>
          {t("compactionCounts", {
            auto: seg.compactions_auto,
            manual: seg.compactions_manual,
            agent: seg.compactions_agent,
          })}
        </DetailRow>
      ) : null}
      <DetailRow label={to("command")}>
        {status.compact_command ? (
          <span dir="ltr" className="font-mono">
            {status.compact_command}
          </span>
        ) : (
          t("noCommand")
        )}
      </DetailRow>
      {check ? (
        <DetailRow label={t("lastCheck")}>
          {t(`check.${check.outcome}`)}
        </DetailRow>
      ) : null}
      <DetailRow label={t("queued")}>
        {t("queuedValue", {
          messages: status.queued_messages,
          events: status.pending_events,
        })}
      </DetailRow>
      <DetailRow label={t("dispatchSlots")}>
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
      </DetailRow>
      <DetailRow label={t("engine")}>
        {status.engine === "here" ? t("engineHere") : t("engineElsewhere")}
      </DetailRow>
      {status.last_error ? (
        <DetailRow label={t("lastError")}>
          <span className="text-red-700 dark:text-red-300">
            {status.last_error}
          </span>
        </DetailRow>
      ) : null}
    </dl>
  )
}
