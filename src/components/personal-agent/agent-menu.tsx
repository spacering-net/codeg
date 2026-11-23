"use client"

/**
 * The "⋯" by an assistant's face at the side panel's top: what acts on that
 * assistant itself — its page first (as a row's menu on the roster has
 * it), then the session it runs on underneath, compacting that
 * session's context (or, while a turn runs, stopping it: the reply being
 * written, or the compaction), starting a new one, and stopping everything
 * it has going. With nothing coming up in its activity — the group that
 * holds [New routine] not shown — the way to make one is here (C4).
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  Eye,
  IdCard,
  MoreHorizontal,
  OctagonX,
  Plus,
  RotateCcw,
  Shrink,
  Square,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { usePersonalAgent } from "@/contexts/personal-agent-context"
import {
  personalAgentCancel,
  personalAgentCompact,
  personalAgentStopAll,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { cn } from "@/lib/utils"
import { useActivity } from "@/stores/personal-agent-activity-store"
import {
  PERSONAL_AGENT_EVENTS,
  usePersonalAgentUi,
} from "@/stores/personal-agent-ui-store"

export function AgentMenu({ className }: { className?: string }) {
  const t = useTranslations("PersonalAgent.menu")
  const tr = useTranslations("PersonalAgent.bots.roster.menu")
  const { snapshot, botId } = usePersonalAgent()
  const tro = useTranslations("PersonalAgent.routines")
  const openBotPage = usePersonalAgentUi((s) => s.openBotPage)
  const openRoutineEditor = usePersonalAgentUi((s) => s.openRoutineEditor)
  const activity = useActivity(botId)
  const [acting, setActing] = useState(false)
  const status = snapshot?.status ?? null
  const readOnly = status?.engine !== "here"
  const turn = status?.turn ?? null
  // The notes before a compaction are part of it (7.7).
  const compacting = turn?.kind === "compaction" || turn?.flush === true
  const hasSession = status?.segment?.conversation_id != null
  const act = async (fn: () => Promise<void>, done?: string) => {
    setActing(true)
    try {
      await fn()
      if (done) toast.message(done)
    } catch (e) {
      toast.error(toErrorMessage(e))
    } finally {
      setActing(false)
    }
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn("text-muted-foreground", className)}
          title={t("more")}
          aria-label={t("more")}
          data-pa-agent-menu
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuItem
          disabled={!snapshot?.agent}
          onSelect={() => openBotPage("identity")}
          data-pa-agent-menu-details
        >
          <IdCard className="size-4" />
          {tr("details")}
        </DropdownMenuItem>
        {!readOnly && activity != null && activity.next.length === 0 ? (
          <DropdownMenuItem
            onSelect={() =>
              openRoutineEditor({
                botId,
                routineId: null,
                draft: null,
                noticeId: null,
              })
            }
            data-pa-agent-menu-new-routine
          >
            <Plus className="size-4" />
            {tro("new")}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={!hasSession}
          onClick={() =>
            window.dispatchEvent(new Event(PERSONAL_AGENT_EVENTS.openSession))
          }
        >
          <Eye className="size-4" />
          {t("viewSession")}
        </DropdownMenuItem>
        {turn ? (
          <DropdownMenuItem
            disabled={readOnly || acting}
            onClick={() => void act(() => personalAgentCancel(botId))}
          >
            <Square className="size-4" />
            {compacting ? t("stopCompaction") : t("stopReply")}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            disabled={readOnly || acting || !status?.segment}
            title={t("compactHint")}
            onClick={() => void act(() => personalAgentCompact(botId))}
          >
            <Shrink className="size-4" />
            {t("compact")}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          disabled={readOnly || !status?.segment}
          onClick={() =>
            window.dispatchEvent(new Event(PERSONAL_AGENT_EVENTS.newSession))
          }
        >
          <RotateCcw className="size-4" />
          {t("newSession")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={readOnly || acting}
          title={t("stopAllHint")}
          onClick={() =>
            void act(() => personalAgentStopAll(botId), t("stoppedAll"))
          }
        >
          <OctagonX className="size-4" />
          {t("stopAll")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
