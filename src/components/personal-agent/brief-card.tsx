"use client"

/**
 * The morning brief codeg wrote itself (6.4), when no brain could write it:
 * the materials the brain would have had — what waits on the owner, last
 * night's work and how it went, what happened since the last brief, what
 * the assistants watch, the day's schedule, a line for each work assistant,
 * loose ends, the owner's yesterday — each row opening what it is about, as
 * "today"'s rows do. Nothing is settled from it.
 */

import { useTranslations } from "next-intl"
import { Newspaper } from "lucide-react"

import type {
  BriefBotLine,
  BriefLoose,
  BriefMaterial,
  BriefTonightMessage,
  DispatchInfo,
  TodayRow,
} from "@/lib/types"
import { cn } from "@/lib/utils"

import type { MessageItem } from "./message-items"
import { bubbleCorners, MessageRow } from "./message-row"
import { AGENT_SURFACE } from "./shared"
import { BriefRows } from "./today-section"

type NoticeItem = Extract<MessageItem, { kind: "notice" }>

/** Rows a part shows before "…and N more". */
const PART_SHOWN = 8

function materialOf(v: unknown): BriefMaterial | null {
  return v && typeof v === "object" && (v as { kind?: unknown }).kind
    ? (v as BriefMaterial)
    : null
}

function rowsOf(v: unknown): TodayRow[] {
  return Array.isArray(v)
    ? v.filter(
        (r): r is TodayRow =>
          r != null &&
          typeof r === "object" &&
          typeof (r as TodayRow).key === "string"
      )
    : []
}

function Part({
  name,
  title,
  children,
}: {
  name: string
  title: string
  children: React.ReactNode
}) {
  return (
    <section data-pa-brief-part={name} className="flex flex-col gap-1.5">
      <h4 className="text-xs font-semibold text-muted-foreground">{title}</h4>
      {children}
    </section>
  )
}

function RowsPart({
  name,
  rows,
  dispatches,
  messages = [],
}: {
  name: string
  rows: TodayRow[]
  dispatches: DispatchInfo[]
  /** Tonight's messages and what came back (6.5). */
  messages?: BriefTonightMessage[]
}) {
  const t = useTranslations("PersonalAgent.brief")
  if (rows.length === 0 && messages.length === 0) return null
  return (
    <Part name={name} title={t(`part.${name}` as "part.needs")}>
      {rows.length > 0 ? (
        <BriefRows rows={rows.slice(0, PART_SHOWN)} dispatches={dispatches} />
      ) : null}
      {rows.length > PART_SHOWN ? (
        <p className="text-[0.6875rem] text-muted-foreground">
          {t("more", { count: rows.length - PART_SHOWN })}
        </p>
      ) : null}
      {messages.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {messages.map((msg) => (
            <li
              key={msg.id}
              className="text-xs leading-5 break-words"
              data-pa-brief-message={msg.id}
            >
              <span className="font-medium">
                {t("message.to", { name: msg.to_name })}
              </span>
              <span className="text-muted-foreground">
                {" "}
                {msg.text} —{" "}
                {msg.reply
                  ? t("message.answered", { text: msg.reply })
                  : t("message.open")}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </Part>
  )
}

function BotLine({ line }: { line: BriefBotLine }) {
  const t = useTranslations("PersonalAgent.brief.bot")
  const parts = [
    line.done > 0
      ? t("done", { count: line.done, titles: line.done_titles.join("; ") })
      : t("idle"),
    line.doing.length > 0 ? t("doing", { what: line.doing.join("; ") }) : null,
    line.stuck > 0 ? t("stuck", { count: line.stuck }) : null,
  ].filter(Boolean)
  return (
    <li
      className="text-xs leading-5 break-words"
      data-pa-brief-bot={line.bot_id}
    >
      <span className="font-medium">{line.name}</span>
      <span className="text-muted-foreground"> — {parts.join(" · ")}</span>
    </li>
  )
}

function LooseLine({ loose, at }: { loose: BriefLoose; at: string }) {
  const t = useTranslations("PersonalAgent.brief.loose")
  const days = Math.max(
    1,
    Math.round((Date.parse(at) - Date.parse(loose.since)) / 86_400_000)
  )
  const what =
    loose.kind === "item"
      ? t("item", { days })
      : loose.kind === "worktree"
        ? t("worktree", { days })
        : t("session")
  return (
    <li
      className="text-xs leading-5 break-words"
      data-pa-brief-loose={loose.kind}
    >
      <span className="font-medium">{loose.title}</span>
      {loose.project ? (
        <span className="text-muted-foreground"> · {loose.project}</span>
      ) : null}
      <span className="text-muted-foreground"> — {what}</span>
    </li>
  )
}

export function BriefCard({ item }: { item: NoticeItem }) {
  const t = useTranslations("PersonalAgent.brief")
  const row = item.row
  const m = materialOf(row.data?.material)
  const dispatches = Array.isArray(m?.dispatches) ? m.dispatches : []
  const bots = Array.isArray(m?.bots) ? m.bots : []
  const loose = Array.isArray(m?.loose) ? m.loose : []
  const y = m?.yesterday ?? null
  const messages = Array.isArray(m?.tonight_messages) ? m.tonight_messages : []
  const parts: { name: string; rows: TodayRow[] }[] = [
    { name: "needs", rows: rowsOf(m?.needs) },
    { name: "tonight", rows: rowsOf(m?.tonight) },
    { name: "night", rows: rowsOf(m?.night) },
    { name: "running", rows: rowsOf(m?.running) },
    { name: "schedule", rows: rowsOf(m?.schedule) },
  ]
  const nothing =
    parts.every((p) => p.rows.length === 0) &&
    messages.length === 0 &&
    bots.length === 0 &&
    loose.length === 0
  return (
    <MessageRow
      rowId={row.id}
      side="start"
      gap={item.gap}
      tail={item.tail}
      roomy
      actions={{ rowId: row.id, text: row.body || null, at: row.created_at }}
    >
      <div
        data-bubble
        data-pa-brief-card
        className={cn(
          AGENT_SURFACE,
          bubbleCorners("start", item.tail),
          "flex min-w-0 flex-col gap-3 p-3 text-sm text-foreground"
        )}
      >
        <div className="flex flex-col gap-0.5">
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Newspaper className="size-3.5 shrink-0" aria-hidden />
            <span className="font-medium">{t("title")}</span>
          </p>
          <p className="text-[0.6875rem] leading-4 text-muted-foreground">
            {t("byCodeg")}
          </p>
        </div>
        {parts.map((p) => (
          <RowsPart
            key={p.name}
            name={p.name}
            rows={p.rows}
            dispatches={dispatches}
            messages={p.name === "tonight" ? messages : undefined}
          />
        ))}
        {bots.length > 0 ? (
          <Part name="bots" title={t("part.bots")}>
            <ul className="flex flex-col gap-0.5">
              {bots.map((b) => (
                <BotLine key={b.bot_id} line={b} />
              ))}
            </ul>
          </Part>
        ) : null}
        {loose.length > 0 && m ? (
          <Part name="loose" title={t("part.loose")}>
            <ul className="flex flex-col gap-0.5">
              {loose.map((l) => (
                <LooseLine key={`${l.kind}:${l.id}`} loose={l} at={m.at} />
              ))}
            </ul>
          </Part>
        ) : null}
        {y && y.total > 0 ? (
          <Part name="yesterday" title={t("part.yesterday")}>
            <p className="text-xs leading-5 text-muted-foreground">
              {[
                t("sessions", { count: y.total }),
                y.by_project.map(([p, n]) => `${p} ${n}`).join(", "),
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </Part>
        ) : null}
        {nothing ? (
          <p className="text-xs text-muted-foreground">{t("nothing")}</p>
        ) : null}
      </div>
    </MessageRow>
  )
}
