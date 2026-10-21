"use client"

/**
 * The divider between two agents in one conversation.
 *
 * A handoff (`acp::handoff`) leaves a tool call tagged `_meta["codeg.handoff"]`
 * at the seam between the segment the previous agent ran and the session the
 * new one continues in. Rendered like the context-compaction divider: a
 * centered, chrome-less rule with a label, so it reads as a boundary marker
 * ("a different agent took over here"), not as a tool call.
 *
 * Two facts ride on it, both worth a glance rather than a click: which agents
 * were involved, and whether the context moved natively or as a briefing. The
 * briefing itself (summary path) folds away behind a toggle: it is the first
 * prompt the new agent read, useful to audit, too long to keep open.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ArrowRightLeft, ChevronDown, ChevronRight } from "lucide-react"

import { AgentIcon } from "@/components/agent-icon"
import { agentHandoffPayload } from "@/lib/agent-handoff"
import { getAgentLabel } from "@/lib/custom-agents"
import { cn } from "@/lib/utils"

interface Props {
  /** The tool call's `_meta`; anything but a handoff marker renders nothing. */
  meta?: Record<string, unknown> | null
}

export function AgentHandoffCard({ meta }: Props) {
  const t = useTranslations("Folder.chat.agentHandoff")
  const [briefingOpen, setBriefingOpen] = useState(false)
  const payload = agentHandoffPayload(meta)
  if (!payload) return null

  const from = payload.from ? getAgentLabel(payload.from) : "?"
  const to = payload.to ? getAgentLabel(payload.to) : "?"
  const detail =
    payload.path === "native"
      ? t("cardNative")
      : payload.path === "context"
        ? t("cardContext")
        : payload.truncated
          ? t("cardTruncated")
          : t("cardSummary")

  return (
    <div
      data-slot="agent-handoff-card"
      className="flex flex-col items-center gap-1 py-1 text-xs text-muted-foreground/80 select-none"
    >
      <div className="flex w-full items-center gap-3">
        <div className="h-px flex-1 bg-gradient-to-r from-transparent to-border/70" />
        <div
          className="flex min-w-0 flex-wrap items-center justify-center gap-1.5 text-center"
          title={detail}
        >
          {payload.from ? (
            <AgentIcon agentType={payload.from} className="size-3.5" />
          ) : null}
          <ArrowRightLeft className="size-3.5" aria-hidden />
          {payload.to ? (
            <AgentIcon agentType={payload.to} className="size-3.5" />
          ) : null}
          <span>{t("cardTitle", { from, to })}</span>
          <span className="text-muted-foreground/60">· {detail}</span>
        </div>
        <div className="h-px flex-1 bg-gradient-to-l from-transparent to-border/70" />
      </div>
      {payload.note ? (
        <div className="max-w-prose text-center text-muted-foreground/70">
          {t("cardNote", { note: payload.note })}
        </div>
      ) : null}
      {payload.path !== "native" && payload.briefing ? (
        <div className="flex w-full max-w-prose flex-col items-center">
          <button
            type="button"
            onClick={() => setBriefingOpen((open) => !open)}
            aria-expanded={briefingOpen}
            className="inline-flex max-sm:min-h-11 cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
          >
            {briefingOpen ? (
              <ChevronDown className="size-3" aria-hidden />
            ) : (
              <ChevronRight className="size-3" aria-hidden />
            )}
            {briefingOpen ? t("hideBriefing") : t("showBriefing")}
          </button>
          <pre
            className={cn(
              "mt-1 w-full overflow-x-auto rounded-md border border-border/50 bg-muted/30 p-2 text-left font-mono text-[11px] whitespace-pre-wrap text-muted-foreground select-text",
              !briefingOpen && "hidden"
            )}
          >
            {payload.briefing}
          </pre>
        </div>
      ) : null}
    </div>
  )
}
