"use client"

import { useTranslations } from "next-intl"

import {
  AgentPanelCard,
  AgentPanelGroup,
} from "@/components/settings/agent-panel-layout"

/** MiniMax owns authentication and provider configuration. This panel never
 * reads, copies or writes credentials into codeg's settings. */
export function MiniMaxCodeConfigPanel() {
  const t = useTranslations("AcpAgentSettings.minimaxCode")

  return (
    <AgentPanelGroup title={t("title")} description={t("description")}>
      <AgentPanelCard>
        <div className="space-y-2">
          <p className="text-2xs text-muted-foreground">{t("loginHint")}</p>
          <code className="block overflow-x-auto rounded bg-muted px-2 py-1 text-2xs font-mono whitespace-nowrap">
            mcode login
          </code>
          <p className="text-2xs text-muted-foreground">{t("globalHint")}</p>
          <code className="block overflow-x-auto rounded bg-muted px-2 py-1 text-2xs font-mono whitespace-nowrap">
            mcode login --region global
          </code>
        </div>
      </AgentPanelCard>
      <AgentPanelCard>
        <p className="text-2xs text-muted-foreground">{t("modelHint")}</p>
      </AgentPanelCard>
    </AgentPanelGroup>
  )
}
