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
import { ChevronDown, ChevronUp, ShieldCheck } from "lucide-react"

import { useCheckNote } from "@/components/message/message-checks"
import { Button } from "@/components/ui/button"
import { SyncedSpinner } from "@/components/ui/synced-spinner"
import { useBotId, usePersonalAgent } from "@/contexts/personal-agent-context"
import { personalAgentNoticeAct } from "@/lib/api"
import type { MessageCheckVerdict } from "@/lib/types"
import { cn } from "@/lib/utils"

import type { MessageItem } from "./message-items"
import { MessageRow } from "./message-row"
import { useSessionLinkOpener } from "./session-link"
import {
  num,
  CardMessage,
  SHEET_TITLE,
  SheetActions,
  SheetField,
  SheetFields,
  SheetLabel,
  SheetNote,
  SheetPart,
  str,
  usePageScope,
} from "./shared"

type NoticeItem = Extract<MessageItem, { kind: "notice" }>

const VERDICTS: readonly MessageCheckVerdict[] = [
  "true",
  "false",
  "partly",
  "unsure",
]

const TONE: Record<MessageCheckVerdict, string> = {
  true: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  false: "bg-red-500/15 text-red-700 dark:text-red-300",
  partly: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  unsure: "bg-muted text-muted-foreground",
}

/** A verdict that is no word, to find where the line puts it. */
const VERDICT_MARK = "\u0001"

/** A done line up to its verdict, without what joins them (": ", "："). */
function withoutVerdict(marked: string): string | null {
  const at = marked.indexOf(VERDICT_MARK)
  if (at <= 0) return null
  return marked.slice(0, at).replace(/[\s:：]+$/u, "") || null
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
  // Done: what it checked, the verdict its chip — the line without it. The
  // line's own words end in the verdict: set one that is no word, and take
  // what comes before it (a title's own colon stays).
  const headline =
    state === "done" && verdict
      ? (withoutVerdict(
          t(sentence ? "cardLine.doneSentence" : "cardLine.done", {
            title,
            verdict: VERDICT_MARK,
          })
        ) ?? line)
      : line

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
      <CardMessage
        data-pa-check-card={state}
        data-pa-check-verdict={verdict ?? undefined}
        head={
          <>
            {state === "checking" ? (
              <SyncedSpinner small className="size-3.5" />
            ) : (
              <ShieldCheck aria-hidden />
            )}
            <span className="font-medium">{t(`heading.${state}`)}</span>
          </>
        }
      >
        {/* What it found, and who checked it. */}
        {/* What it checked and what it found: the line its title, the
            verdict on its tone at the title's end (not said twice), who
            checked it under. */}
        <SheetPart className="flex flex-col gap-1">
          <div className="flex min-w-0 items-start gap-2">
            <p className={cn(SHEET_TITLE, "min-w-0 flex-1")} data-pa-check-line>
              {headline}
            </p>
            {state === "done" && verdict ? (
              <span
                data-pa-check-chip={verdict}
                className={cn(
                  "inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-[0.6875rem] font-medium",
                  TONE[verdict]
                )}
              >
                <ShieldCheck className="size-3" aria-hidden />
                {word}
              </span>
            ) : null}
          </div>
          {note ? (
            <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
              <p data-pa-check-note>{note}</p>
            </div>
          ) : null}
        </SheetPart>
        {/* What it checked: what was asked, then the answer — the sentence
            of it, or the message — set in as a quote. */}
        <SheetPart className="flex flex-col gap-1.5 text-xs">
          <SheetLabel className="mb-0">
            {t(sentence ? "checkedSentence" : "checkedMessage")}
          </SheetLabel>
          {asked ? (
            <SheetFields>
              <SheetField label={t("asked")} data-pa-check-asked>
                <span className="text-foreground/80">{asked}</span>
              </SheetField>
            </SheetFields>
          ) : null}
          <div className="flex flex-col gap-1 border-s-2 border-border ps-3 text-sm leading-5">
            {sentence ? (
              <p className="break-words font-medium" data-pa-check-quote>
                {quote}
              </p>
            ) : null}
            {message && (!sentence || whole) ? (
              <p
                className={cn(
                  "break-words whitespace-pre-wrap",
                  sentence && "text-xs leading-5 text-muted-foreground",
                  !whole && "line-clamp-4"
                )}
                data-pa-check-message
              >
                {message}
              </p>
            ) : null}
          </div>
          {message ? (
            <button
              type="button"
              className="inline-flex w-fit items-center gap-0.5 rounded-sm text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              aria-expanded={whole}
              onClick={() => setWhole((v) => !v)}
            >
              {whole ? t("collapse") : t("expand")}
              {whole ? (
                <ChevronUp className="size-3.5" aria-hidden />
              ) : (
                <ChevronDown className="size-3.5" aria-hidden />
              )}
            </button>
          ) : null}
        </SheetPart>
        {/* What it went by: its evidence, as written. */}
        {state === "done" ? (
          <SheetPart>
            <SheetLabel>{t("evidence")}</SheetLabel>
            {evidence ? (
              // As written, not as markdown: evidence quotes code and
              // paths (a `<Tag>`, a `*`) that must read as they are.
              <pre
                className="field-scrollbar max-h-72 overflow-auto font-sans text-xs leading-5 whitespace-pre-wrap break-words text-foreground/90"
                data-pa-check-evidence
              >
                {evidence}
              </pre>
            ) : (
              <p className="text-xs text-muted-foreground">{t("noEvidence")}</p>
            )}
          </SheetPart>
        ) : null}
        <SheetActions>
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
        </SheetActions>
        {failed ? (
          <SheetNote>
            <p className="text-destructive" role="alert">
              {failed}
            </p>
          </SheetNote>
        ) : null}
      </CardMessage>
    </MessageRow>
  )
}
