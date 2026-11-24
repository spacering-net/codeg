"use client"

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { Copy, Eye, EyeOff, KeyRound, Loader2, Save } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { AcpAgentInfo } from "@/lib/types"
import { copyTextToClipboard } from "@/lib/utils"

/** The API key Command Code reads from its environment ahead of the login
 * `command-code login` stores — see `acp::command_code` in the backend. */
export const COMMAND_CODE_API_KEY_ENV = "COMMAND_CODE_API_KEY"
/** The CLI's own sign-in, which the ACP server reuses. Spelled with the full
 * command name: the docs' short `cmd` is the system shell on Windows. */
export const COMMAND_CODE_LOGIN_COMMAND = "command-code login"

/**
 * Build the env map to persist for Command Code. An empty key deletes
 * `COMMAND_CODE_API_KEY`, handing sign-in back to `command-code login`.
 * Unrelated keys are preserved untouched.
 */
export function buildCommandCodeEnv(
  prevEnv: Record<string, string>,
  apiKey: string
): Record<string, string> {
  const env: Record<string, string> = { ...prevEnv }
  const trimmedKey = apiKey.trim()
  if (trimmedKey) {
    env[COMMAND_CODE_API_KEY_ENV] = trimmedKey
  } else {
    delete env[COMMAND_CODE_API_KEY_ENV]
  }
  return env
}

/**
 * Settings panel for Command Code. Sign-in is the CLI's own
 * (`command-code login`); the API key rides the generic per-agent env path
 * (`persistEnv`). Model, mode and reasoning effort are not here — Command Code
 * reports them over ACP, so the composer's selectors own them per session.
 * Local state resets on remount when a different agent is selected.
 */
export function CommandCodeConfigPanel({
  agent,
  saving,
  onSave,
}: {
  agent: AcpAgentInfo
  saving: boolean
  onSave: (env: Record<string, string>, enabled: boolean) => Promise<unknown>
}) {
  const t = useTranslations("AcpAgentSettings")
  const [apiKey, setApiKey] = useState(
    () => agent.env[COMMAND_CODE_API_KEY_ENV] ?? ""
  )
  const [showKey, setShowKey] = useState(false)

  const handleSave = useCallback(async () => {
    try {
      await onSave(buildCommandCodeEnv(agent.env, apiKey), agent.enabled)
      toast.success(t("toasts.commandCodeSaved"))
    } catch (error) {
      console.error("[Command Code] save config failed", error)
      toast.error(t("toasts.saveCommandCodeFailed"))
    }
  }, [agent.env, agent.enabled, apiKey, onSave, t])

  const handleCopyLogin = useCallback(async () => {
    if (await copyTextToClipboard(COMMAND_CODE_LOGIN_COMMAND)) {
      toast.success(t("commandCode.commandCopied"))
    }
  }, [t])

  return (
    <div className="space-y-3 rounded-md border bg-muted/10 p-3">
      <div>
        <label className="text-xs font-medium">
          {t("commandCode.configManagement")}
        </label>
        <p className="mt-1 text-2xs text-muted-foreground">
          {t("commandCode.configDescription")}
        </p>
      </div>

      <div className="space-y-2 rounded-md border bg-background/60 p-2.5">
        <div className="flex items-center gap-1.5">
          <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-2xs font-medium">
            {t("commandCode.signInTitle")}
          </span>
        </div>
        <p className="text-2xs text-muted-foreground">
          {t("commandCode.signInHint")}
        </p>
        <div className="flex items-center gap-2">
          <code className="flex-1 overflow-x-auto rounded bg-muted px-2 py-1 text-2xs font-mono whitespace-nowrap">
            {COMMAND_CODE_LOGIN_COMMAND}
          </code>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 w-7 shrink-0 p-0"
            onClick={handleCopyLogin}
            title={t("commandCode.copyCommand")}
            aria-label={t("commandCode.copyCommand")}
          >
            <Copy className="h-3 w-3" />
          </Button>
        </div>
      </div>

      <div className="space-y-1.5">
        <label
          htmlFor="command-code-api-key"
          className="text-2xs text-muted-foreground"
        >
          {t("commandCode.apiKeyLabel")}
        </label>
        <div className="flex items-center gap-2">
          <Input
            id="command-code-api-key"
            type={showKey ? "text" : "password"}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            autoComplete="off"
            disabled={saving}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setShowKey((prev) => !prev)}
            title={showKey ? t("actions.hideApiKey") : t("actions.showApiKey")}
            aria-label={
              showKey ? t("actions.hideApiKey") : t("actions.showApiKey")
            }
          >
            {showKey ? (
              <EyeOff className="h-3.5 w-3.5" />
            ) : (
              <Eye className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
        <p className="text-2xs text-muted-foreground">
          {t("commandCode.apiKeyHint")}
        </p>
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
              {t("commandCode.saveConfig")}
            </>
          )}
        </Button>
      </div>
    </div>
  )
}
