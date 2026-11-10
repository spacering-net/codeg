"use client"

import { CodeXml } from "lucide-react"
import { useTranslations } from "next-intl"
import { Switch } from "@/components/ui/switch"
import { saveChatHtmlEnabled, useChatHtmlEnabled } from "@/lib/chat-html-prefs"

export function ChatHtmlSettingsSection() {
  const t = useTranslations("HtmlCodePreview")
  const enabled = useChatHtmlEnabled()
  return (
    <section className="space-y-4 rounded-xl border bg-card p-4">
      <div className="flex items-center gap-2">
        <CodeXml className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{t("settingsTitle")}</h2>
      </div>
      <p
        id="chat-html-description"
        className="text-xs leading-5 text-muted-foreground"
      >
        {t("settingsDescription")}
      </p>
      <label className="flex items-center gap-2">
        <Switch
          checked={enabled}
          onCheckedChange={saveChatHtmlEnabled}
          aria-describedby="chat-html-description"
        />
        <span className="text-xs text-muted-foreground">
          {t("settingsEnable")}
        </span>
      </label>
    </section>
  )
}
