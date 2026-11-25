"use client"

/**
 * The morning brief codeg wrote itself (6.4), when no brain could write it:
 * the materials the brain would have had — what waits on the owner, last
 * night's work and how it went, what happened since the last brief, what
 * the assistants watch, the day's schedule, a line for each work assistant,
 * loose ends, the owner's yesterday — each row opening what it is about, as
 * "today"'s rows do — and, once a week, the week's figures (6.6). Nothing is
 * settled from it but last night's tidy-ups, a line each with its own
 * buttons (7.7). Drawn as an assistant's brief is: its parts on one card —
 * the card the message itself, no bubble round it — a part's title over
 * it, each thing on it a row as an assistant's list item is (`list-row`).
 */

import { useTranslations } from "next-intl"
import {
  CircleCheck,
  GitBranch,
  ListTodo,
  MessageSquare,
  Newspaper,
  type LucideIcon,
} from "lucide-react"

import type {
  BriefBotLine,
  BriefLoose,
  BriefMaterial,
  BriefTonightMessage,
  BriefWeek,
  BriefWeekCount,
  DispatchInfo,
  TodayRow,
} from "@/lib/types"
import { cn } from "@/lib/utils"
import { useRoster } from "@/stores/personal-agent-roster-store"

import { BotAvatar } from "./bot-avatar"
import { LIST_ROW, ROW_BODY, RowIcon, RowLines } from "./list-row"
import type { MessageItem } from "./message-items"
import { MessageRow } from "./message-row"
import { CardMessage, SheetPart, useBotName } from "./shared"
import { TidyLines, tidyRowsOf } from "./tidy-lines"
import { BriefRows } from "./today-section"

type NoticeItem = Extract<MessageItem, { kind: "notice" }>

/** Rows a part shows before "…and N more". */
const PART_SHOWN = 8

/** A thing of a part as a row, as an assistant's list item is
 *  (`PaItemCard`): no surface of its own, a hairline over and under it. */
const LINE_ROW = cn(LIST_ROW, "items-center")

/** An assistant's face, to lead its row. */
function Face({ botId }: { botId: number }) {
  const entries = useRoster()
  const botName = useBotName()
  const entry = entries?.find((e) => e.id === botId)
  return (
    <BotAvatar
      avatar={entry?.avatar}
      name={botName(entry ?? { id: botId, kind: "worker" })}
      size={32}
      star={entry?.kind === "primary"}
    />
  )
}

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
    <section data-pa-brief-part={name} className="flex flex-col gap-2">
      <h4 className="text-sm leading-5 font-semibold">{title}</h4>
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
        <ul className="flex flex-col">
          {messages.map((msg) => (
            <li
              key={msg.id}
              className={LINE_ROW}
              data-pa-brief-message={msg.id}
            >
              <Face botId={msg.to_bot_id} />
              <div className={ROW_BODY}>
                <RowLines
                  // "To Dev:" over the message: the colon goes.
                  head={t("message.to", { name: msg.to_name }).replace(
                    /\s*[:：]\s*$/u,
                    ""
                  )}
                  text={msg.text}
                />
                <p className="text-xs leading-4 text-muted-foreground">
                  {msg.reply
                    ? t("message.answered", { text: msg.reply })
                    : t("message.open")}
                </p>
              </div>
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
    <li className={LINE_ROW} data-pa-brief-bot={line.bot_id}>
      <Face botId={line.bot_id} />
      <div className={ROW_BODY}>
        <RowLines head={line.name} text={parts.join(" · ")} />
      </div>
    </li>
  )
}

/** A loose end's kind: its icon. */
const LOOSE_ICON: Record<string, LucideIcon> = {
  item: ListTodo,
  worktree: GitBranch,
  session: MessageSquare,
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
    <li className={LINE_ROW} data-pa-brief-loose={loose.kind}>
      <RowIcon
        icon={
          Object.prototype.hasOwnProperty.call(LOOSE_ICON, loose.kind)
            ? LOOSE_ICON[loose.kind]
            : ListTodo
        }
      />
      <div className={ROW_BODY}>
        <RowLines
          head={[loose.title, loose.project].filter(Boolean).join(" · ")}
          text={what}
        />
      </div>
    </li>
  )
}

/** A token count in a few characters: 1.2M, 34.5k. */
export function tokensShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function counts(v: BriefWeekCount[]): string {
  return v
    .slice(0, 6)
    .map((c) => `${c.name} ${c.n}`)
    .join(", ")
}

/** The week's figures (6.6, 3.1), as codeg gathered them. */
export function WeekPart({ week }: { week: BriefWeek }) {
  const t = useTranslations("PersonalAgent.brief.week")
  const most = Math.max(1, ...week.tokens_by_day.map(([, n]) => n))
  const modes = Object.entries(week.by_mode)
    .map(([m, n]) => `${t(`mode.${m}` as "mode.task")} ${n}`)
    .join(" · ")
  const lines: { key: string; text: string }[] = [
    {
      key: "work",
      text: t("work", {
        count: week.dispatched,
        modes: modes || "—",
        completed: week.completed,
        failed: week.failed,
        firstPass: week.first_pass,
        settled: week.settled,
      }),
    },
  ]
  if (week.by_bot.length > 0) {
    lines.push({
      key: "byBot",
      text: t("byBot", { list: counts(week.by_bot) }),
    })
  }
  const ciFixed = week.ci_fixed ?? 0
  if (
    week.caught + week.retried + ciFixed + week.routine_done + week.merged >
    0
  ) {
    lines.push({
      key: "done",
      text: t("doneForYou", {
        caught: week.caught,
        retried: week.retried,
        ciFixed,
        routines: week.routine_done,
        merged: week.merged,
      }),
    })
  }
  if (week.asked > 0) {
    lines.push({
      key: "asks",
      text: t("asks", {
        count: week.asked,
        answered: week.answered_by.reduce((a, c) => a + c.n, 0),
        forwarded: week.forwarded,
      }),
    })
  }
  if (week.messages > 0 || week.loops > 0) {
    lines.push({
      key: "between",
      text: t("between", {
        messages: week.messages,
        threads: week.threads,
        loops: week.loops,
      }),
    })
  }
  if (week.unblock_minutes != null) {
    lines.push({
      key: "unblock",
      text:
        week.unblock_before != null
          ? t("unblockBefore", {
              minutes: week.unblock_minutes,
              count: week.unblocked,
              before: week.unblock_before,
            })
          : t("unblock", {
              minutes: week.unblock_minutes,
              count: week.unblocked,
            }),
    })
  }
  const held = week.held.merged + week.held.deferred + week.held.kept
  if (held > 0) {
    lines.push({
      key: "held",
      text: t("held", {
        merged: week.held.merged,
        deferred: week.held.deferred,
        kept: week.held.kept,
      }),
    })
  }
  if (week.proposals > 0) {
    lines.push({
      key: "proposals",
      text: t("proposals", {
        count: week.proposals,
        taken: week.proposals_taken,
        dismissed: week.proposals_dismissed,
      }),
    })
  }
  if (week.changes + week.memory > 0) {
    lines.push({
      key: "undone",
      text: t("undone", {
        changes: week.changes,
        changesUndone: week.changes_undone,
        memory: week.memory,
        memoryUndone: week.memory_undone,
      }),
    })
  }
  if (week.reminders > 0) {
    lines.push({
      key: "reminders",
      text: t("reminders", {
        count: week.reminders,
        done: week.reminders_done,
        snoozed: week.reminders_snoozed,
      }),
    })
  }
  if (week.lowered.length > 0) {
    lines.push({
      key: "lowered",
      text: t("lowered", { rules: week.lowered.join(", ") }),
    })
  }
  return (
    <Part
      name="week"
      title={t(week.so_far ? "titleSoFar" : "title", {
        first: week.first.slice(5),
        last: week.last.slice(5),
      })}
    >
      <ul className="flex flex-col gap-0.5" data-pa-brief-week={week.label}>
        {lines.map((l) => (
          <li
            key={l.key}
            className="text-xs leading-5 break-words text-muted-foreground"
            data-pa-week-line={l.key}
          >
            {l.text}
          </li>
        ))}
      </ul>
      {week.tokens > 0 ? (
        <div className="flex flex-col gap-1" data-pa-week-tokens>
          <p className="text-xs text-muted-foreground">
            {t("tokens", { total: tokensShort(week.tokens) })}
          </p>
          <div className="flex h-10 items-end gap-1">
            {week.tokens_by_day.map(([day, n]) => (
              <div
                key={day}
                className="flex min-w-0 flex-1 flex-col items-center gap-0.5"
                title={`${day} · ${tokensShort(n)}`}
              >
                <div
                  className="w-full rounded-sm bg-primary/60"
                  style={{ height: `${Math.max(2, (n / most) * 32)}px` }}
                />
                <span className="text-[0.625rem] leading-none text-muted-foreground tabular-nums">
                  {day.slice(8)}
                </span>
              </div>
            ))}
          </div>
          {week.tokens_by_bot.length > 0 ? (
            <ul className="flex flex-col gap-0.5">
              {week.tokens_by_bot.map((b) => (
                <li
                  key={b.bot_id}
                  className="text-xs leading-5 text-muted-foreground"
                  data-pa-week-bot={b.bot_id}
                >
                  <span className="font-medium text-foreground">{b.name}</span>{" "}
                  {t("botTokens", {
                    total: tokensShort(b.own + b.handed_out),
                    own: tokensShort(b.own),
                    handed: tokensShort(b.handed_out),
                  })}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </Part>
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
  const week = m?.week ?? null
  const messages = Array.isArray(m?.tonight_messages) ? m.tonight_messages : []
  const tidied = tidyRowsOf(m?.tidied)
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
    loose.length === 0 &&
    tidied.length === 0 &&
    week == null
  const shown = !nothing || (y != null && y.total > 0)
  return (
    <MessageRow
      rowId={row.id}
      side="start"
      gap={item.gap}
      tail={item.tail}
      roomy
      actions={{ rowId: row.id, text: row.body || null, at: row.created_at }}
    >
      <CardMessage
        data-pa-brief-card
        head={
          <>
            <Newspaper aria-hidden />
            <span className="font-medium">{t("title")}</span>
            <span className="basis-full text-[0.6875rem] leading-4">
              {t("byCodeg")}
            </span>
          </>
        }
      >
        {shown ? (
          // Its parts on the card, as an assistant's brief is drawn.
          <SheetPart
            data-pa-brief-body
            className="flex flex-col gap-5 pt-3 pb-3.5"
          >
            {parts.map((p) => (
              <RowsPart
                key={p.name}
                name={p.name}
                rows={p.rows}
                dispatches={dispatches}
                messages={p.name === "tonight" ? messages : undefined}
              />
            ))}
            <TidyLines rows={tidied} />
            {bots.length > 0 ? (
              <Part name="bots" title={t("part.bots")}>
                <ul className="flex flex-col">
                  {bots.map((b) => (
                    <BotLine key={b.bot_id} line={b} />
                  ))}
                </ul>
              </Part>
            ) : null}
            {loose.length > 0 && m ? (
              <Part name="loose" title={t("part.loose")}>
                <ul className="flex flex-col">
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
            {week ? <WeekPart week={week} /> : null}
          </SheetPart>
        ) : null}
        {nothing ? (
          <SheetPart>
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <CircleCheck
                className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
                aria-hidden
              />
              {t("nothing")}
            </p>
          </SheetPart>
        ) : null}
      </CardMessage>
    </MessageRow>
  )
}
