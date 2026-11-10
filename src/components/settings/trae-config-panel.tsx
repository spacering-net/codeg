"use client"

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { Copy, Eye, EyeOff, KeyRound, Loader2, Save } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { AcpAgentInfo } from "@/lib/types"
import { copyTextToClipboard } from "@/lib/utils"

/** TRAE CLI's personal access token. TRAE CLI does not read it on its own:
 * codeg signs in with it (the `trae-tob-pat` ACP auth method) when a session
 * starts — see `acp::trae` in the backend. */
export const TRAE_PAT_ENV = "TRAECLI_PERSONAL_ACCESS_TOKEN"
/** The API base URL of an enterprise's own TRAE deployment. */
export const TRAE_HOST_ENV = "TRAECLI_HOST"
/** The interactive sign-in (enterprise SSO in the browser) the ACP server
 * reuses. */
export const TRAE_LOGIN_COMMAND = "traecli login"

/**
 * Build the env map to persist for TRAE CLI. An empty field deletes its key,
 * so clearing the token hands sign-in back to `traecli login`. Unrelated keys
 * are preserved untouched.
 */
export function buildTraeEnv(
  prevEnv: Record<string, string>,
  pat: string,
  host: string
): Record<string, string> {
  const env: Record<string, string> = { ...prevEnv }
  const trimmedPat = pat.trim()
  if (trimmedPat) {
    env[TRAE_PAT_ENV] = trimmedPat
  } else {
    delete env[TRAE_PAT_ENV]
  }
  const trimmedHost = host.trim()
  if (trimmedHost) {
    env[TRAE_HOST_ENV] = trimmedHost
  } else {
    delete env[TRAE_HOST_ENV]
  }
  return env
}

/**
 * Settings panel for TRAE CLI. Sign-in is the CLI's own (`traecli login`);
 * the token and API URL ride the generic per-agent env path (`persistEnv`).
 * Model, mode and reasoning effort are not here — TRAE CLI reports them over
 * ACP, so the composer's selectors own them per session. Local state resets
 * on remount when a different agent is selected.
 */
export function TraeConfigPanel({
  agent,
  saving,
  onSave,
}: {
  agent: AcpAgentInfo
  saving: boolean
  onSave: (env: Record<string, string>, enabled: boolean) => Promise<unknown>
}) {
  const t = useTranslations("AcpAgentSettings")
  const [pat, setPat] = useState(() => agent.env[TRAE_PAT_ENV] ?? "")
  const [host, setHost] = useState(() => agent.env[TRAE_HOST_ENV] ?? "")
  const [showPat, setShowPat] = useState(false)

  const handleSave = useCallback(async () => {
    try {
      await onSave(buildTraeEnv(agent.env, pat, host), agent.enabled)
      toast.success(t("toasts.traeSaved"))
    } catch (error) {
      console.error("[TRAE CLI] save config failed", error)
      toast.error(t("toasts.saveTraeFailed"))
    }
  }, [agent.env, agent.enabled, host, onSave, pat, t])

  const handleCopyLogin = useCallback(async () => {
    if (await copyTextToClipboard(TRAE_LOGIN_COMMAND)) {
      toast.success(t("trae.commandCopied"))
    }
  }, [t])

  return (
    <div className="space-y-3 rounded-md border bg-muted/10 p-3">
      <div>
        <label className="text-xs font-medium">
          {t("trae.configManagement")}
        </label>
        <p className="mt-1 text-2xs text-muted-foreground">
          {t("trae.configDescription")}
        </p>
      </div>

      <div className="space-y-2 rounded-md border bg-background/60 p-2.5">
        <div className="flex items-center gap-1.5">
          <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-2xs font-medium">{t("trae.signInTitle")}</span>
        </div>
        <p className="text-2xs text-muted-foreground">{t("trae.signInHint")}</p>
        <div className="flex items-center gap-2">
          <code className="flex-1 overflow-x-auto rounded bg-muted px-2 py-1 text-2xs font-mono whitespace-nowrap">
            {TRAE_LOGIN_COMMAND}
          </code>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 w-7 shrink-0 p-0"
            onClick={handleCopyLogin}
            title={t("trae.copyCommand")}
            aria-label={t("trae.copyCommand")}
          >
            <Copy className="h-3 w-3" />
          </Button>
        </div>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="trae-pat" className="text-2xs text-muted-foreground">
          {t("trae.patLabel")}
        </label>
        <div className="flex items-center gap-2">
          <Input
            id="trae-pat"
            type={showPat ? "text" : "password"}
            value={pat}
            onChange={(event) => setPat(event.target.value)}
            autoComplete="off"
            disabled={saving}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setShowPat((prev) => !prev)}
            title={showPat ? t("actions.hideApiKey") : t("actions.showApiKey")}
            aria-label={
              showPat ? t("actions.hideApiKey") : t("actions.showApiKey")
            }
          >
            {showPat ? (
              <EyeOff className="h-3.5 w-3.5" />
            ) : (
              <Eye className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
        <p className="text-2xs text-muted-foreground">{t("trae.patHint")}</p>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="trae-host" className="text-2xs text-muted-foreground">
          {t("trae.hostLabel")}
        </label>
        <Input
          id="trae-host"
          value={host}
          onChange={(event) => setHost(event.target.value)}
          placeholder="https://api.example.com"
          autoComplete="off"
          spellCheck={false}
          disabled={saving}
        />
        <p className="text-2xs text-muted-foreground">{t("trae.hostHint")}</p>
      </div>

      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          onClick={handleSave}
          disabled={saving}
          className="gap-1.5"
        >
          {saving ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t("actions.saving")}
            </>
          ) : (
            <>
              <Save className="h-3.5 w-3.5" />
              {t("trae.saveConfig")}
            </>
          )}
        </Button>
      </div>
    </div>
  )
}
