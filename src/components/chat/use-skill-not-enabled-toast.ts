"use client"

import { useCallback } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { useOpenHarness } from "@/hooks/use-open-harness"
import { getAgentLabel } from "@/lib/custom-agents"
import type { HarnessPackTab } from "@/lib/harness-sections"
import type { AgentType } from "@/lib/types"

/**
 * The warning shown instead of inserting a bundled skill the agent cannot use
 * yet — from the welcome page's quick actions and the composer's "+" menu —
 * with a way to where it is switched on: the Harness page's Skill packs
 * section, on the pack the skill comes from.
 *
 * Both surfaces render inside the workspace, where the page opens in place.
 * A window without a workbench (`available` false) gets the warning without
 * the button: the description already names where to go, and a button there
 * could do nothing.
 */
export function useSkillNotEnabledToast(
  agentType: AgentType | null
): (skillLabel: string, tab: HarnessPackTab) => void {
  const t = useTranslations("Folder.chat.welcomePanel.quickActions.notEnabled")
  const { available, openHarness } = useOpenHarness()

  return useCallback(
    (skillLabel: string, tab: HarnessPackTab) => {
      const agentLabel = agentType ? getAgentLabel(agentType) : ""
      toast.warning(t("title", { skill: skillLabel, agent: agentLabel }), {
        description: t("description"),
        action: available
          ? {
              label: t("action"),
              onClick: () => {
                openHarness({ section: "packs", tab })
              },
            }
          : undefined,
      })
    },
    [agentType, available, openHarness, t]
  )
}
