"use client"

/**
 * Whether the composer's `@` panel offers agents. A per-device display
 * preference (`agent-mention-prefs.ts`), so it applies the moment it is
 * flipped and needs no save bar. Files, sessions and commits stay mentionable
 * with `@` either way; this only removes the Agents tab.
 */

import { useTranslations } from "next-intl"
import { AtSign } from "lucide-react"

import { SettingsSection } from "@/components/shared/settings-section"
import { Switch } from "@/components/ui/switch"
import {
  saveAgentMentionsEnabled,
  useAgentMentionsEnabled,
} from "@/lib/agent-mention-prefs"

export function AgentMentionSettingsSection() {
  const t = useTranslations("CollaborationSettings")
  const enabled = useAgentMentionsEnabled()

  return (
    <SettingsSection
      icon={AtSign}
      title={t("agentMentionsTitle")}
      description={t("agentMentionsDescription")}
      htmlFor="agent-mentions-enabled"
      control={
        <Switch
          id="agent-mentions-enabled"
          checked={enabled}
          onCheckedChange={saveAgentMentionsEnabled}
        />
      }
    />
  )
}
