"use client"

/** The panel's head: who it is, the bell that says whether it notifies the
 *  owner, and the "⋯" of what acts on it. */

import { type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { Bell, BellOff } from "lucide-react"
import { toast } from "sonner"
import { Toggle } from "@/components/ui/toggle"
import { usePersonalAgent } from "@/contexts/personal-agent-context"
import { personalAgentRosterAct } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { PersonalAgentSnapshot } from "@/lib/types"
import { cn } from "@/lib/utils"
import {
  usePersonalAgentRoster,
  useRoster,
} from "@/stores/personal-agent-roster-store"

import { AgentMenu } from "../agent-menu"
import { useBotLook } from "../shared"
import { BotAvatar } from "../bot-avatar"

/** The assistant's face at the head of the panel, in px at 100% zoom. */
const HEAD_AVATAR_SIZE = 64

/** Who the panel is about, over its tabs: its face — alive, as on the
 *  roster, its star on the primary's — and its name; in the top's corners,
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
      <h2
        title={name}
        className="max-w-full truncate text-base leading-6 font-semibold"
      >
        {name}
      </h2>
      {children}
    </header>
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
