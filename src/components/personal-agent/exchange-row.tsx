"use client"

/**
 * The lines codeg writes for messages between assistants, in the middle of
 * the list, light, as a time line is:
 * - one line: "Sent a message to (avatar) Dev" or "Message from (avatar)
 *   Dev"; hovering it shows the message's first line;
 * - a run of them (a turn that wrote to several, answers that came in one
 *   after another): one line, "Exchanged 5 messages with Dev and Review",
 *   that opens to each.
 * Any line opens the exchange it is on, both sides' words (`ExchangeSheet`).
 * Written by codeg, never by the model.
 */

import { useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { ArrowDownLeft, ArrowUpRight, ChevronDown } from "lucide-react"

import { AssistantAvatar } from "@/components/assistants/assistant-avatar"
import type { AssistantAvatar as AvatarValue, TimelineRow } from "@/lib/types"
import { cn } from "@/lib/utils"

import { ExchangeSheet } from "./exchange-sheet"
import type { MessageItem } from "./message-items"
import { num, str, useBotName } from "./shared"

type ExchangeItem = Extract<MessageItem, { kind: "exchange" }>

/** The other assistant a line names, as the line keeps it. */
export interface Peer {
  id: number | null
  name: string
  avatar: AvatarValue | null
  kind: string | null
}

export function peerOf(row: TimelineRow): Peer {
  const peer = row.data?.peer
  const p =
    peer && typeof peer === "object" ? (peer as Record<string, unknown>) : null
  return {
    id: num(p, "id"),
    name: str(p, "name") ?? "",
    avatar: (p?.avatar as AvatarValue | null | undefined) ?? null,
    kind: str(p, "kind"),
  }
}

/** The message's first line, for the hover. */
function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim() !== "") ?? ""
  return line.length > 140 ? `${line.slice(0, 140)}…` : line
}

/** Where a message stands, when that is worth a word: taken back or held. */
function useStateWord(): (row: TimelineRow) => string | null {
  const t = useTranslations("PersonalAgent.exchange")
  return (row) => {
    const s = str(row.data, "state")
    return s === "stopped" || s === "looped" || s === "canceled"
      ? t(`state.${s}` as "state.stopped")
      : null
  }
}

function Line({
  row,
  onOpen,
  nested,
}: {
  row: TimelineRow
  onOpen: (row: TimelineRow) => void
  nested?: boolean
}) {
  const t = useTranslations("PersonalAgent.exchange")
  const stateWord = useStateWord()
  const out = str(row.data, "direction") === "out"
  const botName = useBotName()
  const peer = peerOf(row)
  const peerName = botName(peer)
  const word = stateWord(row)
  const Icon = out ? ArrowUpRight : ArrowDownLeft
  const who = () => (
    <span className="inline-flex min-w-0 items-center gap-1">
      <AssistantAvatar avatar={peer.avatar} name={peerName} size={16} />
      <span className="min-w-0 truncate font-medium text-foreground/80">
        {peerName}
      </span>
    </span>
  )
  return (
    <button
      type="button"
      data-row-id={nested ? row.id : undefined}
      data-pa-exchange-line={out ? "out" : "in"}
      title={firstLine(row.body)}
      onClick={() => onOpen(row)}
      className={cn(
        "inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground",
        word && "line-through decoration-muted-foreground/50"
      )}
    >
      <Icon className="size-3 shrink-0" aria-hidden />
      <span className="inline-flex min-w-0 items-center gap-1">
        {t.rich(out ? "sentTo" : "from", { peer: who })}
      </span>
      {word ? <span className="shrink-0">· {word}</span> : null}
    </button>
  )
}

export function ExchangeRow({ item }: { item: ExchangeItem }) {
  const t = useTranslations("PersonalAgent.exchange")
  const format = useFormatter()
  const [open, setOpen] = useState(false)
  const [sheetRow, setSheetRow] = useState<TimelineRow | null>(null)
  const botName = useBotName()
  const rows = item.rows
  const names = [...new Set(rows.map((r) => botName(peerOf(r))))]
  return (
    <div
      data-row-id={item.row.id}
      data-pa-divider
      data-pa-exchange
      className="flex flex-col items-center gap-0.5 py-2 select-none first:pt-0"
    >
      {rows.length === 1 ? (
        <Line row={rows[0]} onOpen={setSheetRow} />
      ) : (
        <>
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
          >
            <span>
              {t("exchanged", {
                count: rows.length,
                names: format.list(names, { type: "conjunction" }),
              })}
            </span>
            <ChevronDown
              className={cn(
                "size-3 transition-transform",
                open && "rotate-180"
              )}
              aria-hidden
            />
          </button>
          {open
            ? rows.map((r) => (
                <Line key={r.id} row={r} onOpen={setSheetRow} nested />
              ))
            : null}
        </>
      )}
      <ExchangeSheet row={sheetRow} onClose={() => setSheetRow(null)} />
    </div>
  )
}
