"use client"

/** How it runs, on one card: what it runs on and its model, its session
 *  and when that started — the way to change what it runs on and to open
 *  that session at the card's end — then the one thing about it to know now,
 *  if any (it runs elsewhere, a new session comes with the next message, it
 *  is not connected), and its working directory (copyable); at the card's
 *  foot, its run log and the rest of how it runs, each opening in a dialog.
 *  Its state is the panel's head's, under its name. */

import type { ReactNode } from "react"
import { useLocale, useTranslations } from "next-intl"
import {
  ChevronRight,
  Folder,
  Settings2,
  SquareArrowOutUpRight,
  Unplug,
} from "lucide-react"
import { AgentIcon } from "@/components/agent-icon"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import type { PersonalAgentSnapshot } from "@/lib/types"
import { cn } from "@/lib/utils"
import {
  PERSONAL_AGENT_EVENTS,
  usePersonalAgentUi,
} from "@/stores/personal-agent-ui-store"

import { PANEL_SURFACE } from "../../panel-section"
import { CopyPropertyButton } from "../../property-row"
import { DetailsList, RunLogList, useRunLogMarkers } from "./run-log"

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

export function RuntimeCard({
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
  const when = useWhen()
  const markers = useRunLogMarkers()
  const { agent, status } = snapshot
  const seg = status.segment
  const model = agent?.label_snapshot?.options.find(
    (o) => o.id === "model"
  )?.value_label
  const segment = seg
    ? [
        t("segmentValue", { seq: seg.seq, reason: tr(seg.start_reason) }),
        `${t("started")} ${when(seg.started_at)}`,
      ].join(" · ")
    : t("noSegment")
  // The one thing to know now, most pressing first.
  const notice = readOnly
    ? t("elsewhere")
    : seg?.pending_reason
      ? t("pendingValue", { reason: tr(seg.pending_reason) })
      : !status.connected
        ? t("disconnected")
        : null
  return (
    <section
      data-pa-status
      className={cn(PANEL_SURFACE, "flex min-w-0 flex-col overflow-hidden")}
    >
      <div className="flex min-w-0 flex-col gap-3 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <span
            aria-hidden
            className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted"
          >
            {agent?.agent_type ? (
              <AgentIcon
                agentType={agent.agent_type}
                className="size-[1.125rem]"
              />
            ) : null}
          </span>
          <div className="flex min-w-0 flex-1 flex-col">
            <p
              data-pa-runtime-agent
              className="min-w-0 truncate text-sm leading-5"
              title={[agent?.label_snapshot?.agent, model]
                .filter(Boolean)
                .join(" · ")}
            >
              <span className="font-semibold">
                {agent?.label_snapshot?.agent ?? "—"}
              </span>
              {model ? (
                <span className="text-muted-foreground"> · {model}</span>
              ) : null}
            </p>
            <p
              data-pa-runtime-session
              className="line-clamp-2 min-w-0 text-xs leading-5 break-words text-muted-foreground tabular-nums"
              title={segment}
            >
              {segment}
            </p>
          </div>
          <div className="-me-1.5 -mt-0.5 flex shrink-0 items-center">
            {seg?.conversation_id != null ? (
              <Button
                size="icon-sm"
                variant="ghost"
                className="text-muted-foreground"
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
            {readOnly ? null : (
              <Button
                size="icon-sm"
                variant="ghost"
                className="text-muted-foreground"
                title={to("editBrain")}
                aria-label={to("editBrain")}
                onClick={() =>
                  usePersonalAgentUi.getState().openBotPage("identity")
                }
              >
                <Settings2 aria-hidden />
              </Button>
            )}
          </div>
        </div>
        {notice ? (
          <p
            data-pa-runtime-notice
            className="flex min-w-0 items-start gap-2 rounded-xl bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-800 dark:bg-amber-400/10 dark:text-amber-200"
          >
            {!readOnly && !seg?.pending_reason ? (
              <Unplug className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            ) : null}
            <span className="min-w-0">{notice}</span>
          </p>
        ) : null}
        {status.workdir ? (
          <div
            data-pa-runtime-workdir
            className="group/prop flex min-w-0 items-center gap-2 text-xs text-muted-foreground"
          >
            <Folder className="size-3.5 shrink-0" aria-hidden />
            <span className="sr-only">{t("workdir")}</span>
            <PathValue path={status.workdir} />
            <CopyPropertyButton
              text={status.workdir}
              copyLabel={t("copyPath")}
              copiedLabel={t("copied")}
            />
          </div>
        ) : null}
      </div>
      {/* Its run log and the rest of how it runs, a dialog each — the
          focus back on the button that opened it once it closes. */}
      <div className="grid grid-cols-2 divide-x divide-border/60 border-t border-border/60 rtl:divide-x-reverse">
        <FootDialog label={to("runLog")} count={markers.length}>
          <RunLogList markers={markers} />
        </FootDialog>
        <FootDialog label={to("details")}>
          <DetailsList snapshot={snapshot} />
        </FootDialog>
      </div>
    </section>
  )
}

/** One of the card's foot — its name, how many, a chevron — and the dialog
 *  it opens, titled the same. */
function FootDialog({
  label,
  count,
  children,
}: {
  label: string
  count?: number
  children: ReactNode
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className="flex h-11 min-w-0 items-center gap-1.5 px-4 text-start text-[0.8125rem] font-medium transition-colors outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
        >
          <span className="min-w-0 truncate">{label}</span>
          {count != null && count > 0 ? (
            <span className="shrink-0 text-xs font-normal text-muted-foreground tabular-nums">
              {count}
            </span>
          ) : null}
          <ChevronRight
            aria-hidden
            className="ms-auto size-4 shrink-0 text-muted-foreground rtl:-scale-x-100"
          />
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[80vh] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{label}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto">{children}</div>
      </DialogContent>
    </Dialog>
  )
}
