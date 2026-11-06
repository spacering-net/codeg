"use client"

/**
 * The personal agent's buttons in the window's top-right chrome, left of
 * the window's own settings gear: a "⋯" menu with what acts on the agent
 * itself — its settings, the session it runs on underneath, compacting that
 * session's context (or, while a turn runs, stopping it: the reply being
 * written, or the compaction), and starting a new one — then the side
 * panel's toggle, nearest the edge the panel opens at. Two buttons, the room
 * the chrome keeps for a route's own (`RIGHT_CHROME_CLUSTER`).
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  Eye,
  MoreHorizontal,
  PanelRight,
  RotateCcw,
  Settings2,
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
import type { WorkbenchChromeActionsProps } from "@/components/workbench/workbench-content"
import { usePersonalAgent } from "@/contexts/personal-agent-context"
import { personalAgentCancel, personalAgentCompact } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import {
  PERSONAL_AGENT_EVENTS,
  usePersonalAgentUi,
} from "@/stores/personal-agent-ui-store"

export function PersonalAgentChromeActions({
  buttonClassName,
  iconClassName,
}: WorkbenchChromeActionsProps) {
  const t = useTranslations("PersonalAgent.menu")
  const { snapshot } = usePersonalAgent()
  const auxOpen = usePersonalAgentUi((s) => s.auxOpen)
  const toggleAux = usePersonalAgentUi((s) => s.toggleAux)
  const [acting, setActing] = useState(false)
  const status = snapshot?.status ?? null
  const configured = snapshot?.agent != null
  const readOnly = status?.engine !== "here"
  const turn = status?.turn ?? null
  const compacting = turn?.kind === "compaction"
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
  const panelLabel = auxOpen ? t("hidePanel") : t("showPanel")
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={buttonClassName}
            title={t("more")}
            aria-label={t("more")}
          >
            <MoreHorizontal className={iconClassName} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-52">
          <DropdownMenuItem
            onClick={() =>
              window.dispatchEvent(
                new Event(PERSONAL_AGENT_EVENTS.openSettings)
              )
            }
          >
            <Settings2 className="size-4" />
            {t("settings")}
          </DropdownMenuItem>
          {configured ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={!hasSession}
                onClick={() =>
                  window.dispatchEvent(
                    new Event(PERSONAL_AGENT_EVENTS.openSession)
                  )
                }
              >
                <Eye className="size-4" />
                {t("viewSession")}
              </DropdownMenuItem>
              {turn ? (
                <DropdownMenuItem
                  disabled={readOnly || acting}
                  onClick={() => void act(personalAgentCancel)}
                >
                  <Square className="size-4" />
                  {compacting ? t("stopCompaction") : t("stopReply")}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  disabled={readOnly || acting || !status?.segment}
                  title={t("compactHint")}
                  onClick={() => void act(personalAgentCompact)}
                >
                  <Shrink className="size-4" />
                  {t("compact")}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                disabled={readOnly || !status?.segment}
                onClick={() =>
                  window.dispatchEvent(
                    new Event(PERSONAL_AGENT_EVENTS.newSession)
                  )
                }
              >
                <RotateCcw className="size-4" />
                {t("newSession")}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {configured ? (
        <Button
          variant="ghost"
          size="icon"
          className={buttonClassName}
          onClick={toggleAux}
          title={panelLabel}
          aria-label={panelLabel}
          aria-pressed={auxOpen}
        >
          <PanelRight className={iconClassName} />
        </Button>
      ) : null}
    </>
  )
}
