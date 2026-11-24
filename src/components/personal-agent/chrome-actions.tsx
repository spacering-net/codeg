"use client"

/**
 * The personal agent's buttons in the window's top-right chrome, left of
 * the window's own settings gear: the settings every assistant shares, then
 * the side panel's toggle, nearest the edge the panel opens at — not while
 * a page is over the conversation, the panel standing aside for it. What
 * acts on one assistant (its session, compacting, a new session, stopping
 * everything) is on the panel, by its face (`AgentMenu`). Two buttons, the
 * room the chrome keeps for a route's own (`RIGHT_CHROME_CLUSTER`).
 */

import { useTranslations } from "next-intl"
import { PanelRight, Settings2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { WorkbenchChromeActionsProps } from "@/components/workbench/workbench-content"
import { usePersonalAgent } from "@/contexts/personal-agent-context"
import { usePersonalAgentUi } from "@/stores/personal-agent-ui-store"

export function PersonalAgentChromeActions({
  buttonClassName,
  iconClassName,
}: WorkbenchChromeActionsProps) {
  const t = useTranslations("PersonalAgent.menu")
  const { snapshot } = usePersonalAgent()
  const auxOpen = usePersonalAgentUi((s) => s.auxOpen)
  const toggleAux = usePersonalAgentUi((s) => s.toggleAux)
  const settingsOpen = usePersonalAgentUi((s) => s.settings != null)
  const pageOver = usePersonalAgentUi(
    (s) => s.settings != null || s.botPage != null
  )
  const configured = snapshot?.agent != null
  const panelLabel = auxOpen ? t("hidePanel") : t("showPanel")
  return (
    <>
      {/* Pressed while they are open: pressed again, back to the
          conversation. */}
      <Button
        variant="ghost"
        size="icon"
        className={buttonClassName}
        onClick={() => {
          const ui = usePersonalAgentUi.getState()
          if (settingsOpen) ui.showConversation()
          else ui.openSettings()
        }}
        title={t("settings")}
        aria-label={t("settings")}
        aria-pressed={settingsOpen}
        data-pa-chrome-settings
      >
        <Settings2 className={iconClassName} />
      </Button>
      {configured && !pageOver ? (
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
