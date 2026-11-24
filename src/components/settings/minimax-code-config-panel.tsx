"use client"

import { useTranslations } from "next-intl"

/** MiniMax owns authentication and provider configuration. This panel never
 * reads, copies or writes credentials into codeg's settings. */
export function MiniMaxCodeConfigPanel() {
  const t = useTranslations("AcpAgentSettings.minimaxCode")

  return (
    <div className="space-y-3 rounded-md border bg-muted/10 p-3">
      <div>
        <h3 className="text-xs font-medium">{t("title")}</h3>
        <p className="mt-1 text-2xs text-muted-foreground">
          {t("description")}
        </p>
      </div>
      <div className="space-y-2 rounded-md border bg-background/60 p-2.5">
        <p className="text-2xs text-muted-foreground">{t("loginHint")}</p>
        <code className="block overflow-x-auto rounded bg-muted px-2 py-1 text-2xs font-mono whitespace-nowrap">
          mcode login
        </code>
        <p className="text-2xs text-muted-foreground">{t("globalHint")}</p>
        <code className="block overflow-x-auto rounded bg-muted px-2 py-1 text-2xs font-mono whitespace-nowrap">
          mcode login --region global
        </code>
      </div>
      <p className="text-2xs text-muted-foreground">{t("modelHint")}</p>
    </div>
  )
}
