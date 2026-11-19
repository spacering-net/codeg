"use client"

/**
 * "Is this right?" (10.3): the owner had a message of one of their
 * conversations checked, and this is the check — being checked by whom,
 * then what it found: the verdict, its evidence, the message (or the
 * sentence of it) and what it answered. [Open the conversation], [Check
 * again], [See the check]. Nothing to answer: it is the answer.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ShieldCheck } from "lucide-react"

import { useCheckNote } from "@/components/message/message-checks"
import { Button } from "@/components/ui/button"
import { SyncedSpinner } from "@/components/ui/synced-spinner"
import { useBotId, usePersonalAgent } from "@/contexts/personal-agent-context"
import { personalAgentNoticeAct } from "@/lib/api"
import type { MessageCheckVerdict } from "@/lib/types"
import { cn } from "@/lib/utils"

import type { MessageItem } from "./message-items"
import { bubbleCorners, MessageRow } from "./message-row"
import { useSessionLinkOpener } from "./session-link"
import { AGENT_SURFACE, num, PaSheet, str, usePageScope } from "./shared"

type NoticeItem = Extract<MessageItem, { kind: "notice" }>

const VERDICTS: readonly MessageCheckVerdict[] = [
  "true",
  "false",
  "partly",
  "unsure",
]

const TONE: Record<MessageCheckVerdict, string> = {
  true: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  false: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300",
  partly:
    "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  unsure: "border-border bg-muted/60 text-muted-foreground",
}

export function CheckCard({ item }: { item: NoticeItem }) {
  const t = useTranslations("MessageCheck")
  const botId = useBotId()
  const { dispatchById } = usePersonalAgent()
  const { readOnly } = usePageScope()
  const openSession = useSessionLinkOpener()
  const noteOf = useCheckNote()
  const row = item.row
  const data = row.data
  const raw = str(data, "state")
  const state =
    raw === "done" || raw === "failed" || raw === "checking" ? raw : "checking"
  const rawVerdict = str(data, "verdict")
  const verdict = VERDICTS.find((v) => v === rawVerdict) ?? null
  const quote = str(data, "quote")
  const message = str(data, "message") ?? ""
  const asked = str(data, "asked")
  const evidence = str(data, "evidence")
  const note = noteOf(str(data, "note"))
  const executor = str(data, "executor")
  const conversationId = num(data, "conversation_id")
  const realTitle = str(data, "conversation_title")?.trim()
  const title = realTitle
    ? t("titleQuoted", { title: realTitle })
    : t("untitled")
  const dispatchId = num(data, "dispatch_id")
  const info = dispatchId != null ? dispatchById.get(dispatchId) : undefined
  const processId = info?.conversation_id ?? null
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [whole, setWhole] = useState(false)

  const word =
    state === "done" && verdict ? t(`verdict.${verdict}`) : t("unfinished")
  const sentence = quote != null
  const line =
    state === "checking"
      ? t(sentence ? "cardLine.checkingSentence" : "cardLine.checking", {
          title,
        })
      : state === "done"
        ? t(sentence ? "cardLine.doneSentence" : "cardLine.done", {
            title,
            verdict: word,
          })
        : t(sentence ? "cardLine.failedSentence" : "cardLine.failed", {
            title,
          })

  const recheck = async () => {
    const id = Number(row.ref_id)
    if (!Number.isFinite(id) || busy) return
    setBusy(true)
    setFailed(null)
    try {
      await personalAgentNoticeAct(id, "recheck", botId)
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

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
        data-pa-check-card={state}
        data-pa-check-verdict={verdict ?? undefined}
        className={cn(
          AGENT_SURFACE,
          bubbleCorners("start", item.tail),
          "flex min-w-0 flex-col gap-2 p-3 text-sm text-foreground"
        )}
      >
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {state === "checking" ? (
            <SyncedSpinner small className="size-3.5" />
          ) : (
            <ShieldCheck className="size-3.5 shrink-0" aria-hidden />
          )}
          <span className="font-medium">{t(`heading.${state}`)}</span>
        </p>
        <PaSheet className="flex flex-col gap-2">
          <p className="text-sm break-words" data-pa-check-line>
            {line}
          </p>
          {state === "done" && verdict ? (
            <span
              className={cn(
                "inline-flex w-fit items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
                TONE[verdict]
              )}
            >
              <ShieldCheck className="size-3" aria-hidden />
              {word}
            </span>
          ) : null}
          <div className="flex flex-col gap-1 rounded-md border border-border/70 bg-background/60 p-2 text-xs">
            <p className="text-muted-foreground">
              {t(sentence ? "checkedSentence" : "checkedMessage")}
            </p>
            {sentence ? (
              <p className="break-words font-medium" data-pa-check-quote>
                {quote}
              </p>
            ) : null}
            {message && (!sentence || whole) ? (
              <p
                className={cn(
                  "break-words whitespace-pre-wrap",
                  !whole && "line-clamp-4"
                )}
                data-pa-check-message
              >
                {message}
              </p>
            ) : null}
            {message ? (
              <button
                type="button"
                className="w-fit text-[0.6875rem] text-muted-foreground underline-offset-2 hover:underline"
                aria-expanded={whole}
                onClick={() => setWhole((v) => !v)}
              >
                {whole ? t("collapse") : t("expand")}
              </button>
            ) : null}
            {asked ? (
              <p className="break-words text-muted-foreground">
                {t("asked")}: {asked}
              </p>
            ) : null}
          </div>
          {state === "done" ? (
            <div className="text-xs">
              <p className="text-muted-foreground">{t("evidence")}</p>
              {evidence ? (
                <pre
                  className="field-scrollbar mt-0.5 max-h-72 overflow-auto rounded-md border border-border/70 bg-background/60 p-2 font-sans text-xs leading-relaxed whitespace-pre-wrap break-words"
                  data-pa-check-evidence
                >
                  {evidence}
                </pre>
              ) : (
                <p className="mt-0.5">{t("noEvidence")}</p>
              )}
            </div>
          ) : null}
          {note ? (
            <p className="text-xs text-muted-foreground" data-pa-check-note>
              {note}
            </p>
          ) : null}
          {executor ? (
            <p className="text-xs text-muted-foreground">
              {t("by", { executor })}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {conversationId != null ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => openSession(conversationId)}
              >
                {t("openConversation")}
              </Button>
            ) : null}
            {/* First in the row without the conversation's: a button that
              looks one, its edge on the text's. */}
            <Button
              size="sm"
              variant={conversationId != null ? "ghost" : "secondary"}
              disabled={readOnly || busy || state === "checking"}
              onClick={() => void recheck()}
            >
              {busy ? <SyncedSpinner small className="size-3.5" /> : null}
              {t("again")}
            </Button>
            {processId != null ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => openSession(processId)}
              >
                {t("process")}
              </Button>
            ) : null}
          </div>
        </PaSheet>
        {failed ? (
          <p className="text-xs text-destructive" role="alert">
            {failed}
          </p>
        ) : null}
      </div>
    </MessageRow>
  )
}
