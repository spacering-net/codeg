"use client"

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { Eye, EyeOff, Loader2, Save } from "lucide-react"
import { toast } from "sonner"

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

const CODEBUDDY_API_KEY_ENV = "CODEBUDDY_API_KEY"
const CODEBUDDY_ENVIRONMENT_ENV = "CODEBUDDY_INTERNET_ENVIRONMENT"
const CODEBUDDY_BASE_URL_ENV = "CODEBUDDY_BASE_URL"
export type CodeBuddyEnvironment =
  | "overseas"
  | "internal"
  | "ioa"
  | "self_hosted"

/**
 * True when `value` parses as an http(s) URL. Used to validate the private
 * deployment endpoint before it is written to CODEBUDDY_BASE_URL — a bare host
 * like `codebuddy.example.com` (no scheme) is rejected so the CLI never receives
 * an unusable base URL.
 */
export function isValidCodeBuddyBaseUrl(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return false
  try {
    const url = new URL(trimmed)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

/** Derive the environment dropdown value from CodeBuddy's persisted env. */
export function codeBuddyEnvironmentFromEnv(
  env: Record<string, string>
): CodeBuddyEnvironment {
  // A custom endpoint (private / self-hosted deployment) takes precedence: when
  // CODEBUDDY_BASE_URL is set, requests go straight to that endpoint and the
  // region selector is irrelevant (and must stay unset).
  if ((env[CODEBUDDY_BASE_URL_ENV] ?? "").trim()) return "self_hosted"
  const raw = (env[CODEBUDDY_ENVIRONMENT_ENV] ?? "").trim().toLowerCase()
  if (raw === "internal") return "internal"
  if (raw === "ioa") return "ioa"
  return "overseas"
}

/**
 * Build the env map to persist for CodeBuddy: write/clear CODEBUDDY_API_KEY, then
 * route by `environment`:
 *  - `self_hosted` (private deployment): write the trimmed, trailing-slash-stripped
 *    `baseUrl` to CODEBUDDY_BASE_URL and DELETE CODEBUDDY_INTERNET_ENVIRONMENT —
 *    requests go straight to the custom endpoint, so the region selector must be
 *    unset (per CodeBuddy's docs). An empty baseUrl clears the key.
 *  - `internal` (China) / `ioa` (iOA): set CODEBUDDY_INTERNET_ENVIRONMENT.
 *  - `overseas`: DELETE CODEBUDDY_INTERNET_ENVIRONMENT — the overseas build must
 *    leave it UNSET rather than empty.
 * CODEBUDDY_BASE_URL is removed for every non-self_hosted environment. Unrelated
 * env keys are preserved untouched.
 */
export function buildCodeBuddyEnv(
  prevEnv: Record<string, string>,
  apiKey: string,
  environment: CodeBuddyEnvironment,
  baseUrl = ""
): Record<string, string> {
  const env: Record<string, string> = { ...prevEnv }
  const trimmedKey = apiKey.trim()
  if (trimmedKey) {
    env[CODEBUDDY_API_KEY_ENV] = trimmedKey
  } else {
    delete env[CODEBUDDY_API_KEY_ENV]
  }
  if (environment === "self_hosted") {
    // Custom endpoint: never combine with the region selector.
    delete env[CODEBUDDY_ENVIRONMENT_ENV]
    const trimmedUrl = baseUrl.trim().replace(/\/+$/, "")
    if (trimmedUrl) {
      env[CODEBUDDY_BASE_URL_ENV] = trimmedUrl
    } else {
      delete env[CODEBUDDY_BASE_URL_ENV]
    }
  } else {
    delete env[CODEBUDDY_BASE_URL_ENV]
    if (environment === "overseas") {
      delete env[CODEBUDDY_ENVIRONMENT_ENV]
    } else {
      env[CODEBUDDY_ENVIRONMENT_ENV] = environment
    }
  }
  return env
}

/**
 * Dedicated settings panel for CodeBuddy (Tencent). CodeBuddy authenticates
 * purely through env vars, so this writes `CODEBUDDY_API_KEY`,
 * `CODEBUDDY_INTERNET_ENVIRONMENT`, and (for private deployments)
 * `CODEBUDDY_BASE_URL` via the generic per-agent env path (`persistEnv`) — no
 * bespoke backend command needed. The environment dropdown exists because the
 * China build REQUIRES `CODEBUDDY_INTERNET_ENVIRONMENT=internal` (iOA = `ioa`);
 * the overseas build must leave it UNSET, so "overseas" deletes the key rather
 * than writing an empty value. "self_hosted" instead writes `CODEBUDDY_BASE_URL`
 * (a custom endpoint) and leaves the region selector unset. Local state resets
 * naturally on remount when a different agent is selected.
 */
export function CodeBuddyConfigPanel({
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
    () => agent.env[CODEBUDDY_API_KEY_ENV] ?? ""
  )
  const [environment, setEnvironment] = useState<CodeBuddyEnvironment>(() =>
    codeBuddyEnvironmentFromEnv(agent.env)
  )
  const [baseUrl, setBaseUrl] = useState(
    () => agent.env[CODEBUDDY_BASE_URL_ENV] ?? ""
  )
  const [showKey, setShowKey] = useState(false)

  const isSelfHosted = environment === "self_hosted"
  const baseUrlValid = isValidCodeBuddyBaseUrl(baseUrl)
  // Only flag an error once the user has typed something — an empty field for a
  // fresh self-hosted selection reads as "incomplete", not "wrong".
  const showBaseUrlError =
    isSelfHosted && baseUrl.trim() !== "" && !baseUrlValid
  const saveDisabled = saving || (isSelfHosted && !baseUrlValid)

  const handleSave = useCallback(async () => {
    const env = buildCodeBuddyEnv(agent.env, apiKey, environment, baseUrl)
    try {
      await onSave(env, agent.enabled)
      toast.success(t("toasts.codeBuddySaved"))
    } catch (error) {
      console.error("[CodeBuddy] save config failed", error)
      toast.error(t("toasts.saveCodeBuddyFailed"))
    }
  }, [agent.env, agent.enabled, apiKey, environment, baseUrl, onSave, t])

  return (
    <div className="space-y-3 rounded-md border bg-muted/10 p-3">
      <div>
        <label className="text-xs font-medium">
          {t("codebuddy.configManagement")}
        </label>
        <p className="mt-1 text-2xs text-muted-foreground">
          {t("codebuddy.configDescription")}
        </p>
      </div>

      <div className="space-y-1.5">
        <label className="text-2xs text-muted-foreground">
          {t("codebuddy.apiKeyLabel")}
        </label>
        <div className="flex items-center gap-2">
          <Input
            type={showKey ? "text" : "password"}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="sk-..."
            disabled={saving}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setShowKey((prev) => !prev)}
            title={showKey ? t("actions.hideApiKey") : t("actions.showApiKey")}
          >
            {showKey ? (
              <EyeOff className="h-3.5 w-3.5" />
            ) : (
              <Eye className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
        <p className="text-2xs text-muted-foreground">
          {t(
            isSelfHosted
              ? "codebuddy.apiKeyHintSelfHosted"
              : "codebuddy.apiKeyHint"
          )}
        </p>
      </div>

      <div className="space-y-1.5">
        <label className="text-2xs text-muted-foreground">
          {t("codebuddy.environmentLabel")}
        </label>
        <Select
          value={environment}
          onValueChange={(value) =>
            setEnvironment(value as CodeBuddyEnvironment)
          }
          disabled={saving}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start">
            <SelectItem value="overseas">
              {t("codebuddy.envOverseas")}
            </SelectItem>
            <SelectItem value="internal">{t("codebuddy.envChina")}</SelectItem>
            <SelectItem value="ioa">{t("codebuddy.envIoa")}</SelectItem>
            <SelectItem value="self_hosted">
              {t("codebuddy.envSelfHosted")}
            </SelectItem>
          </SelectContent>
        </Select>
        {/* The region hint only applies to the hosted builds; for self_hosted
            the Base URL field below carries its own explanation. */}
        {!isSelfHosted && (
          <p className="text-2xs text-muted-foreground">
            {t("codebuddy.environmentHint")}
          </p>
        )}
      </div>

      {isSelfHosted && (
        <div className="space-y-1.5">
          <label
            htmlFor="codebuddy-base-url"
            className="text-2xs text-muted-foreground"
          >
            {t("codebuddy.baseUrlLabel")}
          </label>
          <Input
            id="codebuddy-base-url"
            type="url"
            inputMode="url"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder={t("codebuddy.baseUrlPlaceholder")}
            disabled={saving}
            aria-invalid={showBaseUrlError}
            aria-describedby="codebuddy-base-url-hint"
          />
          {showBaseUrlError ? (
            <p
              id="codebuddy-base-url-hint"
              className="text-2xs text-destructive"
            >
              {t("codebuddy.baseUrlInvalid")}
            </p>
          ) : (
            <p
              id="codebuddy-base-url-hint"
              className="text-2xs text-muted-foreground"
            >
              {t("codebuddy.baseUrlHint")}
            </p>
          )}
        </div>
      )}

      {/* CLI sign-in persists a token the --acp subprocess reuses for the hosted
          builds; it does not apply to a private endpoint, so hide it there. */}
      {!isSelfHosted && (
        <p className="text-2xs text-muted-foreground">
          {t("codebuddy.loginHint")}
        </p>
      )}

      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          onClick={handleSave}
          disabled={saveDisabled}
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
              {t("actions.saveCodeBuddyConfig")}
            </>
          )}
        </Button>
      </div>
    </div>
  )
}
