"use client"

/**
 * The exchange a line is on, between this conversation's assistant and the
 * other one: titled "Primary ⇄ Dev", every message the two wrote each other
 * there, in their own words, as chat bubbles — the other one's on the left,
 * this one's on the right — with their avatars and times, the work handed
 * out on the exchange as pills (either side's opens in the drawer), and
 * [Open the other one's conversation]. A bubble over what opened it (P6):
 * a line of the list, a card's link, a notice's [View]; it goes with that
 * as the list scrolls, hides when that scrolled out of sight, and closes
 * with a press outside, Esc, or on its way to what it opens.
 */

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { ArrowLeftRight, MessageSquare } from "lucide-react"

import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { SyncedSpinner } from "@/components/ui/synced-spinner"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useBotId, usePersonalAgent } from "@/contexts/personal-agent-context"
import { personalAgentThread } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type {
  BotFace,
  ThreadDispatch,
  ThreadView,
  TimelineRow,
} from "@/lib/types"
import { cn } from "@/lib/utils"
import {
  usePersonalAgentUi,
  type WorkTarget,
} from "@/stores/personal-agent-ui-store"

import { BotAvatar } from "./bot-avatar"
import { useMessageTime } from "./message-actions"
import { bubbleCorners } from "./message-row"
import {
  AGENT_SURFACE,
  canOpenWork,
  INSET_HOVER,
  INSET_SURFACE,
  num,
  str,
  useBotName,
  useOpenWork,
  workTargetOf,
} from "./shared"

/** A dispatch on the exchange as the drawer opens it — the other side's too,
 *  whose dispatches this assistant's page does not hold. */
function threadTarget(d: ThreadDispatch): WorkTarget {
  return {
    dispatchId: d.id,
    mode: d.mode,
    workTaskId: d.work_task_id,
    conversationId: d.conversation_id,
    folderId: d.conversation_folder_id,
    agentType: d.agent_type,
    title: d.title,
    assistantName: null,
    prompt: null,
    connectionId: null,
    state: d.state,
  }
}

/** The two ends of a line's exchange: this conversation's assistant, and the
 *  one the line names. */
function endsOf(row: TimelineRow): { me: number | null; peer: number | null } {
  const from = num(row.data, "from_bot_id")
  const to = num(row.data, "to_bot_id")
  return str(row.data, "direction") === "out"
    ? { me: from, peer: to }
    : { me: to, peer: from }
}

/** The message a line of the list is of (`m<id>`). */
export function lineMessageOf(row: TimelineRow): number | null {
  const m = /^m(\d+)$/.exec(row.ref_id ?? "")
  return m ? Number(m[1]) : null
}

export function ExchangeSheet({
  row,
  onClose,
  anchor,
  target = null,
}: {
  row: TimelineRow | null
  onClose: () => void
  /** What opened it, which it stands over. */
  anchor: React.RefObject<HTMLElement | null>
  /** The message to scroll to and mark — a line's of the list, when it is
   *  on this exchange; the latest otherwise. */
  target?: number | null
}) {
  const t = useTranslations("PersonalAgent.exchange")
  const open = row != null
  // What opened it gone from the page (its row drawn no more): it closes.
  useEffect(() => {
    if (open && anchor.current && !anchor.current.isConnected) onClose()
  })
  return (
    <Popover open={open} onOpenChange={(next) => !next && onClose()}>
      <PopoverAnchor
        virtualRef={
          anchor as React.RefObject<{ getBoundingClientRect(): DOMRect }>
        }
      />
      <PopoverContent
        className="w-[26rem] max-w-[calc(100vw-2rem)] gap-3 p-3"
        collisionPadding={8}
        hideWhenDetached
        aria-describedby={undefined}
        data-pa-exchange-sheet
      >
        {row != null ? (
          <SheetBody row={row} onClose={onClose} target={target} />
        ) : null}
        <p className="sr-only">{t("sheetHint")}</p>
      </PopoverContent>
    </Popover>
  )
}

function SheetBody({
  row,
  onClose,
  target,
}: {
  row: TimelineRow
  onClose: () => void
  target: number | null
}) {
  const t = useTranslations("PersonalAgent.exchange")
  const tState = useTranslations("PersonalAgent.state")
  const botId = useBotId()
  const { dispatchById } = usePersonalAgent()
  const openWork = useOpenWork()
  const setViewBot = usePersonalAgentUi((s) => s.setViewBot)
  const time = useMessageTime()
  const botName = useBotName()
  const threadId = num(row.data, "thread_id")
  const { me, peer } = endsOf(row)
  const [view, setView] = useState<ThreadView | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  useEffect(() => {
    if (threadId == null) return
    let live = true
    personalAgentThread(threadId, botId)
      .then((v) => live && setView(v))
      .catch((e) => live && setFailed(toErrorMessage(e)))
    return () => {
      live = false
    }
  }, [threadId, botId])
  const face = (id: number | null): BotFace | null =>
    view?.bots.find((b) => b.id === id) ?? null
  const mine = face(me)
  const theirs = face(peer)
  const between = (view?.messages ?? []).filter(
    (m) =>
      (m.from_bot_id === me && m.to_bot_id === peer) ||
      (m.from_bot_id === peer && m.to_bot_id === me)
  )
  // The line's own message when it is on this exchange; the latest else.
  const focus =
    target != null && between.some((m) => m.id === target)
      ? target
      : (between[between.length - 1]?.id ?? null)
  const list = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (focus == null) return
    list.current
      ?.querySelector<HTMLElement>(`[data-pa-thread-message="${focus}"]`)
      ?.scrollIntoView({ block: "nearest" })
  }, [focus])
  return (
    <>
      <div>
        <h2 className="flex items-center gap-2 text-sm font-medium">
          {mine ? (
            <BotAvatar avatar={mine.avatar} name={botName(mine)} size={20} />
          ) : null}
          <span>
            {t("sheetTitle", {
              a: mine ? botName(mine) : "…",
              b: theirs ? botName(theirs) : "…",
            })}
          </span>
          {theirs ? (
            <BotAvatar
              avatar={theirs.avatar}
              name={botName(theirs)}
              size={20}
            />
          ) : null}
        </h2>
      </div>
      {failed ? (
        <p role="alert" className="text-sm text-destructive">
          {t("unavailable", { error: failed })}
        </p>
      ) : view == null ? (
        <div className="flex h-24 items-center justify-center text-muted-foreground">
          <SyncedSpinner small className="size-4" />
        </div>
      ) : (
        <ScrollArea className="max-h-[50vh]">
          <div ref={list} className="flex flex-col gap-3 pe-2">
            {between.map((m) => {
              const own = m.from_bot_id === me
              const who = own ? mine : theirs
              const marked = target != null && m.id === target
              return (
                <div
                  key={m.id}
                  data-pa-thread-message={m.id}
                  data-pa-thread-target={marked || undefined}
                  className={cn(
                    "flex items-end gap-2 rounded-lg",
                    own ? "flex-row-reverse" : "flex-row",
                    marked && "bg-primary/5 ring-1 ring-primary/30"
                  )}
                >
                  <BotAvatar
                    avatar={who?.avatar ?? null}
                    name={who ? botName(who) : ""}
                    size={24}
                  />
                  <div
                    className={cn(
                      "flex max-w-[80%] min-w-0 flex-col gap-1",
                      own ? "items-end" : "items-start"
                    )}
                  >
                    <div
                      className={cn(
                        bubbleCorners(own ? "end" : "start", true),
                        own
                          ? "bg-primary/10 text-foreground"
                          : cn(AGENT_SURFACE, "text-foreground"),
                        "px-3 py-2 text-sm break-words whitespace-pre-wrap"
                      )}
                    >
                      {m.body}
                    </div>
                    <span className="text-[0.6875rem] text-muted-foreground tabular-nums">
                      {time(m.created_at)}
                      {m.state === "stopped" || m.state === "looped"
                        ? ` · ${t(`state.${m.state}` as "state.stopped")}`
                        : null}
                    </span>
                  </div>
                </div>
              )
            })}
            {view.dispatches.length > 0 ? (
              <div className="flex flex-wrap gap-1.5 border-t pt-3">
                {view.dispatches.map((d) => {
                  const info = dispatchById.get(d.id)
                  const work = info ? workTargetOf(info) : threadTarget(d)
                  const openable = canOpenWork(work)
                  return (
                    <button
                      key={d.id}
                      type="button"
                      disabled={!openable}
                      onClick={() => {
                        onClose()
                        openWork(work)
                      }}
                      className={cn(
                        "inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-xs",
                        INSET_SURFACE,
                        openable && INSET_HOVER
                      )}
                    >
                      <ArrowLeftRight className="size-3 shrink-0" aria-hidden />
                      <span className="min-w-0 truncate">{d.title}</span>
                      <span className="shrink-0 text-muted-foreground">
                        {tState(d.state)}
                      </span>
                    </button>
                  )
                })}
              </div>
            ) : null}
          </div>
        </ScrollArea>
      )}
      {theirs ? (
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="outline"
            data-pa-exchange-open-peer
            onClick={() => {
              setViewBot(theirs.kind === "primary" ? null : theirs.id)
              onClose()
            }}
          >
            <MessageSquare aria-hidden />
            {t("openPeer", { name: botName(theirs) })}
          </Button>
        </div>
      ) : null}
    </>
  )
}
