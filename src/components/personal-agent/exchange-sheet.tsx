"use client"

/**
 * The exchange a line is on, between this conversation's assistant and the
 * other one: titled "Primary ⇄ Dev", every message the two wrote each other
 * there, in their own words, as chat bubbles — the other one's on the left,
 * this one's on the right — with their avatars and times, and the work
 * handed out on the exchange as pills (this assistant's open in the drawer).
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { ArrowLeftRight } from "lucide-react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { SyncedSpinner } from "@/components/ui/synced-spinner"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useBotId, usePersonalAgent } from "@/contexts/personal-agent-context"
import { personalAgentThread } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { BotFace, ThreadView, TimelineRow } from "@/lib/types"
import { cn } from "@/lib/utils"

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

/** The two ends of a line's exchange: this conversation's assistant, and the
 *  one the line names. */
function endsOf(row: TimelineRow): { me: number | null; peer: number | null } {
  const from = num(row.data, "from_bot_id")
  const to = num(row.data, "to_bot_id")
  return str(row.data, "direction") === "out"
    ? { me: from, peer: to }
    : { me: to, peer: from }
}

export function ExchangeSheet({
  row,
  onClose,
}: {
  row: TimelineRow | null
  onClose: () => void
}) {
  const t = useTranslations("PersonalAgent.exchange")
  return (
    <Dialog open={row != null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl">
        {row != null ? <SheetBody row={row} /> : null}
        <DialogDescription className="sr-only">
          {t("sheetHint")}
        </DialogDescription>
      </DialogContent>
    </Dialog>
  )
}

function SheetBody({ row }: { row: TimelineRow }) {
  const t = useTranslations("PersonalAgent.exchange")
  const tState = useTranslations("PersonalAgent.state")
  const botId = useBotId()
  const { dispatchById } = usePersonalAgent()
  const openWork = useOpenWork()
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
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2 text-sm">
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
        </DialogTitle>
      </DialogHeader>
      {failed ? (
        <p role="alert" className="text-sm text-destructive">
          {t("unavailable", { error: failed })}
        </p>
      ) : view == null ? (
        <div className="flex h-24 items-center justify-center text-muted-foreground">
          <SyncedSpinner small className="size-4" />
        </div>
      ) : (
        <ScrollArea className="max-h-[60vh]">
          <div className="flex flex-col gap-3 pe-2">
            {between.map((m) => {
              const own = m.from_bot_id === me
              const who = own ? mine : theirs
              return (
                <div
                  key={m.id}
                  data-pa-thread-message={m.id}
                  className={cn(
                    "flex items-end gap-2",
                    own ? "flex-row-reverse" : "flex-row"
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
                  const target = info ? workTargetOf(info) : null
                  const openable = target != null && canOpenWork(target)
                  return (
                    <button
                      key={d.id}
                      type="button"
                      disabled={!openable}
                      onClick={() => target && openWork(target)}
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
    </>
  )
}
