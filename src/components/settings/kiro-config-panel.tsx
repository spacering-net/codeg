"use client"

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { Eye, EyeOff, Loader2, Save, ShieldCheck } from "lucide-react"
import { toast } from "sonner"

import {
  AgentPanelCard,
  AgentPanelGroup,
  AgentPanelSaveBar,
} from "@/components/settings/agent-panel-layout"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { AcpAgentInfo } from "@/lib/types"

/** Kiro CLI's non-interactive sign-in (what its headless mode requires). */
const KIRO_API_KEY_ENV = "KIRO_API_KEY"
/** codeg-side launch knob: "1" launches `kiro-cli acp --trust-all-tools`, "0"
 * leaves the CLI asking before each tool call. Kiro reads no such env var —
 * the launch path (`kiro_trust_all_tools_enabled`) turns it into the flag. */
const KIRO_TRUST_ALL_TOOLS_ENV = "KIRO_TRUST_ALL_TOOLS"

export type KiroPermissionMode = "ask" | "trust_all"

/** The permission mode the next launch will use. Mirrors the backend reading:
 * only "1" / "true" trust every tool; unset and anything else asks. */
export function kiroPermissionModeFromEnv(
  env: Record<string, string>
): KiroPermissionMode {
  const value = (env[KIRO_TRUST_ALL_TOOLS_ENV] ?? "").trim().toLowerCase()
  return value === "1" || value === "true" ? "trust_all" : "ask"
}

/**
 * Build the env map to persist for Kiro. The permission knob is written for
 * BOTH states ("1" / "0"), never deleted, so the saved choice is always
 * explicit — the same rule as Cursor's `CURSOR_FORCE`. An empty API key
 * deletes `KIRO_API_KEY` (leaving the CLI's own `kiro-cli login` in charge).
 * Unrelated keys are preserved untouched.
 */
export function buildKiroEnv(
  prevEnv: Record<string, string>,
  apiKey: string,
  mode: KiroPermissionMode
): Record<string, string> {
  const env: Record<string, string> = { ...prevEnv }
  const trimmedKey = apiKey.trim()
  if (trimmedKey) {
    env[KIRO_API_KEY_ENV] = trimmedKey
  } else {
    delete env[KIRO_API_KEY_ENV]
  }
  env[KIRO_TRUST_ALL_TOOLS_ENV] = mode === "trust_all" ? "1" : "0"
  return env
}

/**
 * Settings panel for Kiro CLI. Everything here rides the generic per-agent env
 * path (`persistEnv`): the permission mode becomes the `--trust-all-tools`
 * launch flag, and the API key is passed to the CLI as `KIRO_API_KEY`. Model,
 * agent, thinking and effort are not here — Kiro reports them over ACP, so the
 * composer's own selectors own them per session. Local state resets on remount
 * when a different agent is selected.
 */
export function KiroConfigPanel({
  agent,
  saving,
  onSave,
}: {
  agent: AcpAgentInfo
  saving: boolean
  onSave: (env: Record<string, string>, enabled: boolean) => Promise<unknown>
}) {
  const t = useTranslations("AcpAgentSettings")
  const [mode, setMode] = useState<KiroPermissionMode>(() =>
    kiroPermissionModeFromEnv(agent.env)
  )
  const [apiKey, setApiKey] = useState(() => agent.env[KIRO_API_KEY_ENV] ?? "")
  const [showKey, setShowKey] = useState(false)

  const handleSave = useCallback(async () => {
    try {
      await onSave(buildKiroEnv(agent.env, apiKey, mode), agent.enabled)
      toast.success(t("toasts.kiroSaved"))
    } catch (error) {
      console.error("[Kiro] save config failed", error)
      toast.error(t("toasts.saveKiroFailed"))
    }
  }, [agent.env, agent.enabled, apiKey, mode, onSave, t])

  return (
    <AgentPanelGroup
      title={t("kiro.configManagement")}
      description={t("kiro.configDescription")}
    >
      <AgentPanelCard icon={ShieldCheck} title={t("kiro.permissionsTitle")}>
        <div className="space-y-1">
          <label
            htmlFor="kiro-permission-mode"
            className="text-2xs text-muted-foreground"
          >
            {t("kiro.permissionModeLabel")}
          </label>
          <Select
            value={mode}
            onValueChange={(value) => setMode(value as KiroPermissionMode)}
            disabled={saving}
          >
            <SelectTrigger
              id="kiro-permission-mode"
              className="w-full"
              aria-label={t("kiro.permissionModeLabel")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="start">
              <SelectItem value="ask">{t("kiro.permissionModeAsk")}</SelectItem>
              <SelectItem value="trust_all">
                {t("kiro.permissionModeTrustAll")}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        {/* Say what the selected mode actually does, including that it only
            reaches sessions launched after the save. */}
        <p className="text-2xs text-muted-foreground">
          {mode === "trust_all"
            ? t("kiro.permissionModeTrustAllHint")
            : t("kiro.permissionModeAskHint")}
        </p>
      </AgentPanelCard>

      <AgentPanelCard>
        <div className="space-y-1.5">
          <label
            htmlFor="kiro-api-key"
            className="text-2xs text-muted-foreground"
          >
            {t("kiro.apiKeyLabel")}
          </label>
          <div className="flex items-center gap-2">
            <Input
              id="kiro-api-key"
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
              title={
                showKey ? t("actions.hideApiKey") : t("actions.showApiKey")
              }
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
            {t("kiro.apiKeyHint")}
          </p>
        </div>
      </AgentPanelCard>

      <AgentPanelSaveBar>
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
              {t("kiro.saveConfig")}
            </>
          )}
        </Button>
      </AgentPanelSaveBar>
    </AgentPanelGroup>
  )
}
