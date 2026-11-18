"use client"

/** The panel's head: who it is and, under its name, how it is — its state,
 *  and on the primary how many work assistants it has, on a work assistant
 *  its role — the bell that says whether it notifies the owner, and the "⋯"
 *  of what acts on it. */

import { type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { Bell, BellOff } from "lucide-react"
import { toast } from "sonner"
import { Toggle } from "@/components/ui/toggle"
import { usePersonalAgent } from "@/contexts/personal-agent-context"
import { personalAgentRosterAct } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { PersonalAgentSnapshot, PersonalAgentStatus } from "@/lib/types"
import { cn } from "@/lib/utils"
import {
  usePersonalAgentRoster,
  useRoster,
} from "@/stores/personal-agent-roster-store"

import { AgentMenu } from "../agent-menu"
import { useBotLook, useStatusWord } from "../shared"
import { BotAvatar } from "../bot-avatar"
import { useBotTemplates } from "../use-templates"

/** The assistant's face at the head of the panel, in px at 100% zoom. */
const HEAD_AVATAR_SIZE = 64

/** The dot before an assistant's state: at work, waiting on the owner, idle
 *  and connected, or neither. */
export function stateDot(status: PersonalAgentStatus): string {
  return status.engine !== "here" || !status.connected
    ? "bg-muted-foreground/40"
    : status.pending_permission || status.pending_question
      ? "bg-amber-500"
      : status.turn
        ? "bg-primary motion-safe:animate-pulse"
        : "bg-emerald-500"
}

/** Who the panel is about, over its tabs: its face — alive, as on the
 *  roster, its star on the primary's — its name and a line of how it is;
 *  in the top's corners,
 *  as far from either edge, whether it notifies the owner (the bell, at the
 *  start) and what acts on it (the "⋯", at the end — in the drawer left of
 *  its close button, which has the right). */
export function AuxHead({
  snapshot,
  inDrawer,
  children,
}: {
  snapshot: PersonalAgentSnapshot
  inDrawer: boolean
  children: ReactNode
}) {
  const t = useTranslations("PersonalAgent")
  const { botId } = usePersonalAgent()
  const agent = snapshot.agent
  const name = agent?.name?.trim() || t("title")
  const look = useBotLook(agent?.id ?? null)
  return (
    <header
      data-pa-aux-head
      className="relative flex shrink-0 flex-col items-center gap-3 px-4 pt-7 pb-3"
    >
      {agent ? (
        <>
          {/* Their boxes as far from the top as from the sides, by
              measure — not nudged for the "⋯" being a flat row of dots
              in the middle of its own. */}
          <NotifyToggle
            snapshot={snapshot}
            className={cn(
              "absolute",
              inDrawer ? "top-2.5 left-3" : "start-2 top-2"
            )}
          />
          <AgentMenu
            className={cn(
              "absolute",
              inDrawer ? "top-2.5 right-12" : "end-2 top-2"
            )}
          />
        </>
      ) : null}
      {agent ? (
        <BotAvatar
          avatar={agent.avatar}
          name={name}
          size={HEAD_AVATAR_SIZE}
          star={botId == null}
          look={look}
        />
      ) : null}
      <div className="flex max-w-full min-w-0 flex-col items-center gap-0.5">
        <h2
          title={name}
          className="max-w-full truncate text-base leading-6 font-semibold"
        >
          {name}
        </h2>
        {agent ? <HeadLine snapshot={snapshot} /> : null}
      </div>
      {children}
    </header>
  )
}

/** Under the name: its state, with its dot — then, on the primary, how many
 *  work assistants it has; on a work assistant, its role. */
function HeadLine({ snapshot }: { snapshot: PersonalAgentSnapshot }) {
  const t = useTranslations("PersonalAgent.aux")
  const word = useStatusWord()
  const entries = useRoster()
  const templates = useBotTemplates()
  const agent = snapshot.agent
  const worker = agent?.kind === "worker"
  const workers =
    entries?.filter((e) => e.kind === "worker" && !e.roster.hidden).length ?? 0
  const extra = worker
    ? (templates?.find((x) => x.id === agent?.template)?.name ?? null)
    : workers > 0
      ? t("workers", { count: workers })
      : null
  const parts = [word, extra].filter((p): p is string => !!p)
  if (parts.length === 0) return null
  const line = parts.join(" · ")
  return (
    <p
      data-pa-aux-head-line
      title={line}
      className="flex max-w-full min-w-0 items-center gap-1.5 text-xs leading-5 text-muted-foreground"
    >
      {word ? (
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            stateDot(snapshot.status)
          )}
        />
      ) : null}
      <span className="min-w-0 truncate">{line}</span>
    </p>
  )
}

/** "Notify me" (10.10): whether it notifies the owner when it is done or
 *  waits for them — the roster's switch, a bell pressed while it does. */
function NotifyToggle({
  snapshot,
  className,
}: {
  snapshot: PersonalAgentSnapshot
  className?: string
}) {
  const t = useTranslations("PersonalAgent.detail")
  const { botId } = usePersonalAgent()
  const readOnly = snapshot.status.engine !== "here"
  const entry = usePersonalAgentRoster((s) =>
    s.entries?.find((e) => e.id === (snapshot.agent?.id ?? botId))
  )
  useRoster()
  const on = entry?.roster.notify ?? true
  const label = `${t("notify")} · ${on ? t("notifyOn") : t("notifyOff")}`
  return (
    <Toggle
      size="sm"
      pressed={on}
      disabled={readOnly || !entry}
      onPressedChange={(next) => {
        if (!entry) return
        void personalAgentRosterAct(entry.id, {
          act: "notify",
          on: next,
        }).catch((e) => toast.error(toErrorMessage(e)))
      }}
      aria-label={t("notify")}
      title={`${label}\n${t("notifyHint")}`}
      data-pa-detail-notify={on ? "on" : "off"}
      className={cn(
        "size-8 min-w-8 px-0 text-muted-foreground aria-pressed:bg-transparent aria-pressed:text-foreground hover:aria-pressed:bg-muted",
        className
      )}
    >
      {on ? <Bell aria-hidden /> : <BellOff aria-hidden />}
    </Toggle>
  )
}
