"use client"

import { Layers2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { SettingRow } from "@/components/shared/setting-card"
import { SettingsSection } from "@/components/shared/settings-section"
import { Switch } from "@/components/ui/switch"
import {
  saveConversationPanesEnabled,
  useConversationPanesEnabled,
} from "@/lib/conversation-pane-prefs"

export function ConversationPaneSettings() {
  const t = useTranslations("ConversationPanes")
  const enabled = useConversationPanesEnabled()

  return (
    <SettingsSection
      icon={Layers2}
      title={t("settingsTitle")}
      description={t("settingsDescription")}
    >
      <SettingRow
        title={t("enabled")}
        description={t("enabledDescription")}
        control={
          <Switch
            aria-label={t("enabled")}
            checked={enabled}
            onCheckedChange={saveConversationPanesEnabled}
          />
        }
      />
    </SettingsSection>
  )
}
