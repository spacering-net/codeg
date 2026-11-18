"use client"

/** How it runs, a row per property, as Session Details shows a
 *  conversation. */

import { useLocale, useTranslations } from "next-intl"
import { Settings2, SquareArrowOutUpRight } from "lucide-react"
import { AgentIcon } from "@/components/agent-icon"
import { Button } from "@/components/ui/button"
import type { PersonalAgentSnapshot } from "@/lib/types"
import { cn } from "@/lib/utils"
import {
  PERSONAL_AGENT_EVENTS,
  usePersonalAgentUi,
} from "@/stores/personal-agent-ui-store"

import { CopyPropertyButton, PropertyRow } from "../../property-row"
import { useStatusWord } from "../../shared"

/** A path in one line that, when it does not fit, gives way in its middle:
 *  the folder it starts from and its last name stay, which is where two
 *  working directories tell apart. Left to right in any language — under
 *  RTL its leading slash would otherwise jump to the far end. */
function PathValue({ path }: { path: string }) {
  const cut = path.replace(/[\\/]+$/, "").search(/[^\\/]+$/)
  const head = cut > 0 ? path.slice(0, cut) : ""
  const tail = cut > 0 ? path.slice(cut) : path
  return (
    <span dir="ltr" title={path} className="flex min-w-0 font-mono">
      <span className="min-w-0 truncate">{head}</span>
      <span className="shrink-0">{tail}</span>
    </span>
  )
}

/** A date and time, short. */
export function useWhen(): (iso: string) => string {
  const locale = useLocale()
  return (iso) =>
    new Date(iso).toLocaleString(locale, {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
}

/** How it runs, as Session Details shows a conversation: a row per
 *  property — what it runs on (the way to change it at the row's end), its
 *  state, its model and mode, its session (which opens), when that started,
 *  its connection, its working directory (copyable). Who it is is the
 *  panel's head. */
export function StatusRows({
  snapshot,
  readOnly,
}: {
  snapshot: PersonalAgentSnapshot
  readOnly: boolean
}) {
  const t = useTranslations("PersonalAgent.status")
  const tPage = useTranslations("PersonalAgent")
  const to = useTranslations("PersonalAgent.overview")
  const tr = useTranslations("PersonalAgent.reason")
  const word = useStatusWord()
  const when = useWhen()
  const { agent, status } = snapshot
  const seg = status.segment
  const model = agent?.label_snapshot.options.find(
    (o) => o.id === "model"
  )?.value_label
  const mode = agent?.label_snapshot.mode
  // The dot beside its state: at work, waiting on the owner, idle and
  // connected, or neither.
  const dot =
    status.engine !== "here" || !status.connected
      ? "bg-muted-foreground/40"
      : status.pending_permission || status.pending_question
        ? "bg-amber-500"
        : status.turn
          ? "bg-primary motion-safe:animate-pulse"
          : "bg-emerald-500"
  return (
    <div data-pa-status className="min-w-0">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 text-xs">
        <PropertyRow label={t("agent")}>
          {agent ? (
            <span aria-hidden className="inline-flex shrink-0">
              <AgentIcon agentType={agent.agent_type} className="size-3.5" />
            </span>
          ) : null}
          <span className="min-w-0 truncate">
            {agent?.label_snapshot.agent ?? "—"}
          </span>
          {readOnly ? null : (
            <Button
              size="icon-xs"
              variant="ghost"
              className="-me-1 ms-auto shrink-0 text-muted-foreground"
              title={to("editBrain")}
              aria-label={to("editBrain")}
              onClick={() =>
                usePersonalAgentUi.getState().openBotPage("identity")
              }
            >
              <Settings2 aria-hidden />
            </Button>
          )}
        </PropertyRow>
        {word ? (
          <PropertyRow label={t("state")}>
            <span
              aria-hidden
              className={cn("size-1.5 shrink-0 rounded-full", dot)}
            />
            <span className="min-w-0 truncate">{word}</span>
          </PropertyRow>
        ) : null}
        <PropertyRow label={t("model")}>
          <span className="min-w-0 truncate" title={model ?? undefined}>
            {model || "—"}
          </span>
        </PropertyRow>
        {mode ? (
          <PropertyRow label={t("mode")}>
            <span className="min-w-0 truncate" title={mode}>
              {mode}
            </span>
          </PropertyRow>
        ) : null}
        <PropertyRow label={t("session")}>
          <span className="min-w-0 truncate">
            {seg
              ? t("segmentValue", {
                  seq: seg.seq,
                  reason: tr(seg.start_reason),
                })
              : t("noSegment")}
          </span>
          {seg?.conversation_id != null ? (
            <Button
              size="icon-xs"
              variant="ghost"
              className="-me-1 ms-auto shrink-0 text-muted-foreground"
              title={tPage("viewSession")}
              aria-label={tPage("viewSession")}
              onClick={() =>
                window.dispatchEvent(
                  new Event(PERSONAL_AGENT_EVENTS.openSession)
                )
              }
            >
              <SquareArrowOutUpRight aria-hidden />
            </Button>
          ) : null}
        </PropertyRow>
        {seg ? (
          <PropertyRow label={t("started")}>
            <span className="min-w-0 truncate tabular-nums">
              {when(seg.started_at)}
            </span>
          </PropertyRow>
        ) : null}
        <PropertyRow label={t("connection")}>
          <span
            className="min-w-0 truncate"
            title={status.connected ? t("connected") : t("disconnected")}
          >
            {status.connected ? t("connected") : t("disconnected")}
          </span>
        </PropertyRow>
        {status.workdir ? (
          <PropertyRow label={t("workdir")}>
            <PathValue path={status.workdir} />
            <CopyPropertyButton
              text={status.workdir}
              copyLabel={t("copyPath")}
              copiedLabel={t("copied")}
            />
          </PropertyRow>
        ) : null}
      </dl>
      {seg?.pending_reason ? (
        <p className="mt-1.5 rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-xs leading-5 text-amber-800 dark:text-amber-200">
          {t("pendingValue", { reason: tr(seg.pending_reason) })}
        </p>
      ) : null}
    </div>
  )
}
