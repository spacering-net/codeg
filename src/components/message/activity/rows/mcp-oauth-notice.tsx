"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"

import { BrowserLink } from "@/components/ui/browser-link"
import type { KimiMcpOAuth } from "@/lib/kimi-mcp-oauth"
import { openInSystemBrowser } from "@/lib/link-open"

/** Opening a browser is only a user action, never proof of authentication. */
export function McpOAuthNotice({ progress }: { progress: KimiMcpOAuth }) {
  const t = useTranslations("Folder.chat.activity.oauth")
  const [failed, setFailed] = useState(false)
  if (progress.phase === "pending") return null
  return (
    <div className="space-y-2 rounded-lg border p-3 text-sm" role="status">
      <p>{t(progress.phase, { server: progress.server })}</p>
      {progress.phase === "waiting" && progress.url ? (
        <BrowserLink
          href={progress.url}
          className="text-activity-accent underline underline-offset-4"
          onClick={(event) => {
            event.preventDefault()
            setFailed(false)
            // Keep the exact string, including state, PKCE and callback port.
            void openInSystemBrowser(progress.url!).catch(() => setFailed(true))
          }}
        >
          {t("open")}
        </BrowserLink>
      ) : null}
      <p className="text-xs text-muted-foreground">{t("verify")}</p>
      {failed ? <p className="text-tone-danger">{t("openFailed")}</p> : null}
    </div>
  )
}
