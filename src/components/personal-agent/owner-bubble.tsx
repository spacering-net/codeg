"use client"

/**
 * One of the owner's messages: a bubble on the right, tinted with the
 * theme's colour, the quote it replies to at its top, its images in a grid.
 * While the assistant has not started on it, "unread" sits beside the
 * bubble's foot; once it has, nothing does (no "read" — that is the rule,
 * not news). A message whose turn never ended says so on a line under it,
 * with the way to send it again.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { CornerDownRight, RotateCcw } from "lucide-react"
import { toast } from "sonner"

import { personalAgentResend } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { useBotId } from "@/contexts/personal-agent-context"
import { cn } from "@/lib/utils"

import type { MessageItem } from "./message-items"
import { bubbleCorners, MessageRow } from "./message-row"
import { QuoteBar } from "./quote-bar"
import { num, UnreadMark, usePageScope } from "./shared"

interface ImageBlock {
  type?: string
  data?: string
  mime_type?: string
}

type OwnerItem = Extract<MessageItem, { kind: "owner" }>

export function OwnerBubble({ item }: { item: OwnerItem }) {
  const t = useTranslations("PersonalAgent.owner")
  const { row, tail } = item
  const { readOnly } = usePageScope()
  const botId = useBotId()
  const [busy, setBusy] = useState(false)
  const resentAs = num(row.data, "resent_as")
  const images = Array.isArray(row.data?.blocks)
    ? (row.data.blocks as ImageBlock[]).filter(
        (b) => b.type === "image" && b.data
      )
    : []
  const interrupted = row.status === "interrupted"
  // Folded into the reply that was already being written when it was sent.
  const merged = row.data?.merged === true && !interrupted
  const unread = row.read_at == null && !interrupted
  return (
    <MessageRow
      rowId={row.id}
      side="end"
      gap={item.gap}
      tail={tail}
      actions={{ rowId: row.id, text: row.body || null, at: row.created_at }}
      aside={unread ? <UnreadMark /> : null}
      below={
        merged ? (
          <div
            data-pa-state
            className="mt-1 flex h-5 items-center gap-1.5 pe-1 text-[0.6875rem] whitespace-nowrap text-muted-foreground"
          >
            <CornerDownRight className="size-3" aria-hidden />
            <span>{t("merged")}</span>
          </div>
        ) : interrupted ? (
          <div
            data-pa-state
            className="mt-1 flex h-5 items-center gap-1.5 pe-1 text-[0.6875rem] whitespace-nowrap text-muted-foreground"
          >
            <span className="text-amber-700 dark:text-amber-300">
              {t("unfinished")}
            </span>
            {resentAs != null ? (
              <span>{t("resent")}</span>
            ) : readOnly ? null : (
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-full px-1.5 text-foreground/80 transition-colors hover:text-foreground disabled:opacity-50"
                disabled={busy}
                onClick={() => {
                  setBusy(true)
                  personalAgentResend(row.id, botId)
                    .catch((e) => toast.error(toErrorMessage(e)))
                    .finally(() => setBusy(false))
                }}
              >
                <RotateCcw className="size-3" aria-hidden />
                {t("resend")}
              </button>
            )}
          </div>
        ) : null
      }
    >
      <div
        data-bubble
        className={cn(
          bubbleCorners("end", tail),
          "pa-owner-bubble min-w-0 p-3 text-sm text-foreground"
        )}
      >
        {row.reply_to != null ? (
          <QuoteBar targetId={row.reply_to} tone="light" className="mb-1.5" />
        ) : null}
        {row.body ? (
          <div className="whitespace-pre-wrap break-words">{row.body}</div>
        ) : null}
        {images.length > 0 ? (
          <div
            className={cn(
              "grid gap-1.5",
              row.body && "mt-2",
              images.length > 1 ? "grid-cols-2" : "grid-cols-1"
            )}
          >
            {images.map((img, i) => (
              // A data URL from the row: next/image has nothing to optimise.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={i}
                src={`data:${img.mime_type ?? "image/png"};base64,${img.data}`}
                alt=""
                className="max-h-48 w-full rounded-lg object-cover"
              />
            ))}
          </div>
        ) : null}
      </div>
    </MessageRow>
  )
}
