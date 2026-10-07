"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Eye, EyeOff, Loader2, Save } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { AcpAgentInfo } from "@/lib/types"
import { cn } from "@/lib/utils"

const DEEPSEEK_API_KEY_ENV = "DEEPSEEK_API_KEY"
/** Endpoint override. `llm-deepseek` resolves it per request through the
 * launch-environment snapshot, which falls back to `process.env` when the host
 * installs none — deepseek-acp installs none, so codeg's launch env reaches it.
 * Empty ⇒ the adapter's own default, `https://api.deepseek.com`. */
const DEEPSEEK_BASE_URL_ENV = "DEEPSEEK_BASE_URL"

/** The adapter's public default endpoint, shown as the placeholder. */
export const DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com"

/** Every env key this panel owns. The settings page folds exactly these into
 * the raw editor's draft after a save, and rebases them onto it when the
 * persisted env changes elsewhere — a draft still holding pre-change values
 * would restore them wholesale the next time the enable switch commits it.
 *
 * `DEEPSEEK_ACP_MODEL` is deliberately NOT one of them: the model is a
 * per-session selector the composer owns, and its launch default stays with
 * the raw env editor. Claiming it here would let this panel overwrite a model
 * line the user is editing there. */
export const DEEPSEEK_PANEL_ENV_KEYS = [
  DEEPSEEK_API_KEY_ENV,
  DEEPSEEK_BASE_URL_ENV,
  "DEEPSEEK_ACP_PROVIDER",
] as const

/** The provider ROUTE id (`deepseek-official`). Not exposed by this panel —
 * `llm-deepseek` registers exactly one route, so any other value only breaks
 * session creation — but an earlier build bound the settings page's "API base
 * URL" field to it, so a development row may hold a URL here. */
const DEEPSEEK_PROVIDER_ENV = "DEEPSEEK_ACP_PROVIDER"

/**
 * Build the env map to persist. An empty field DELETES its key rather than
 * writing an empty string: an empty `DEEPSEEK_BASE_URL` would be an empty
 * endpoint rather than "use the default". Unrelated keys — `DEEPSEEK_ACP_MODEL`
 * included — are preserved untouched, with one exception: a
 * `DEEPSEEK_ACP_PROVIDER` holding a URL is dropped. That is never a valid route
 * id — it can only come from the older panel that wired the base-URL field to
 * this key — and leaving it would make `agents.create()` reject every session
 * while the endpoint field on screen looks correct. A non-URL value (a real
 * route id) is preserved.
 */
export function buildDeepSeekEnv(
  prevEnv: Record<string, string>,
  apiKey: string,
  baseUrl: string
): Record<string, string> {
  const env: Record<string, string> = { ...prevEnv }
  const setOrDelete = (key: string, value: string) => {
    const trimmed = value.trim()
    if (trimmed) {
      env[key] = trimmed
    } else {
      delete env[key]
    }
  }
  const legacyProvider = (env[DEEPSEEK_PROVIDER_ENV] ?? "").trim()
  if (legacyProvider && /^https?:\/\//i.test(legacyProvider)) {
    delete env[DEEPSEEK_PROVIDER_ENV]
  }
  setOrDelete(DEEPSEEK_API_KEY_ENV, apiKey)
  // Trailing slashes are stripped: the adapter concatenates
  // `${baseURL}/chat/completions`, so `https://host/` would request `//chat`.
  setOrDelete(DEEPSEEK_BASE_URL_ENV, baseUrl.trim().replace(/\/+$/, ""))
  return env
}

/** Whether `value` is an http(s) URL the adapter can actually build a request
 * from — an endpoint without a scheme cannot be fetched, and the failure would
 * only show up at the first turn.
 *
 * A query string or fragment is rejected for the same reason the trailing
 * slash is stripped: the adapter concatenates `${baseURL}/chat/completions`
 * textually, so `https://gw/v1?api-version=1` would request the path `/v1`
 * with the query `api-version=1/chat/completions` — a request that reaches the
 * gateway and fails as if the deployment were misconfigured. */
export function isValidDeepSeekBaseUrl(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return true // empty = use the adapter default
  // Tested on the RAW text, not on the parsed URL: what gets persisted (and
  // concatenated) is this string, and a bare `https://gw/v1?` parses to an
  // EMPTY `search` while still turning the request into `/v1?/chat/completions`.
  if (/[?#]/.test(trimmed)) return false
  try {
    const url = new URL(trimmed)
    if (url.protocol !== "http:" && url.protocol !== "https:") return false
    // `fetch` refuses a URL carrying credentials, so the endpoint would fail
    // at the first turn with an error that names neither this field nor why.
    return url.username === "" && url.password === ""
  } catch {
    return false
  }
}

/**
 * Dedicated settings panel for DeepSeek Harness (through the `deepseek-acp`
 * bridge). Deliberately small: endpoint and key, in that order.
 *
 * No per-session selector belongs here. Model and reasoning effort are ACP
 * config options the bridge advertises per session, so the composer's own
 * selectors are where they are chosen; duplicating them here only creates two
 * places to disagree about what a session actually starts on. The model's
 * launch default is still settable by hand as `DEEPSEEK_ACP_MODEL` in the raw
 * env editor below.
 *
 * The list those selectors choose FROM is a different thing and lives in a
 * different file — `llm-deepseek.models` in the harness settings document,
 * edited by the sibling `DeepSeekModelListEditor` under its own section.
 *
 * Both fields here are plain per-agent env vars, read at spawn — a save reaches
 * sessions started after it, not the ones already running.
 */
export function DeepSeekConfigPanel({
  agent,
  saving,
  onSaveEnv,
}: {
  agent: AcpAgentInfo
  saving: boolean
  onSaveEnv: (env: Record<string, string>, enabled: boolean) => Promise<unknown>
}) {
  const t = useTranslations("AcpAgentSettings")

  const [baseUrl, setBaseUrl] = useState(
    () => agent.env[DEEPSEEK_BASE_URL_ENV] ?? ""
  )
  const [apiKey, setApiKey] = useState(
    () => agent.env[DEEPSEEK_API_KEY_ENV] ?? ""
  )
  const [showKey, setShowKey] = useState(false)

  // Re-seed when the persisted values change UNDER the panel — the settings
  // page refetches after every save it makes, including the raw env editor's
  // and the enable switch's, so those land here as a new `agent.env`. (A save
  // made in ANOTHER window does not: the page holds its own agent list and
  // does not subscribe to `app://acp-agents-updated`, so it only sees that
  // work on its next refetch.) Without this the panel keeps showing what it
  // was born with and its next save writes those stale values back over the
  // newer ones.
  //
  // A field the user has TYPED IN is left alone: what it holds is an intent,
  // not a stale snapshot, so overwriting it would discard the edit in progress
  // while the newer value is one save away from being written anyway.
  //
  // Dirtiness is a ref set by the change handlers rather than a comparison
  // against the state, because the state cannot be a dependency here: this
  // effect must NOT re-run between a save completing and the refresh it
  // triggers arriving. In that window the fields already show what was stored
  // while `agent.env` still holds the pre-save values, so a re-run would read
  // them back as an external change and revert the save on screen.
  const persistedKey = agent.env[DEEPSEEK_API_KEY_ENV] ?? ""
  const persistedBaseUrl = agent.env[DEEPSEEK_BASE_URL_ENV] ?? ""
  const seeded = useRef({ apiKey: persistedKey, baseUrl: persistedBaseUrl })
  const dirty = useRef({ apiKey: false, baseUrl: false })
  useEffect(() => {
    // Seeding state from a prop change is exactly what this rule warns about,
    // and here it is the point: the fields mirror `agent.env` until the user
    // types in them.
    /* eslint-disable react-hooks/set-state-in-effect */
    const last = seeded.current
    if (last.apiKey !== persistedKey) {
      last.apiKey = persistedKey
      if (!dirty.current.apiKey) setApiKey(persistedKey)
    }
    if (last.baseUrl !== persistedBaseUrl) {
      last.baseUrl = persistedBaseUrl
      if (!dirty.current.baseUrl) setBaseUrl(persistedBaseUrl)
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [persistedKey, persistedBaseUrl])

  const baseUrlValid = isValidDeepSeekBaseUrl(baseUrl)
  const saveDisabled = saving || !baseUrlValid

  const handleSave = useCallback(async () => {
    const env = buildDeepSeekEnv(agent.env, apiKey, baseUrl)
    try {
      await onSaveEnv(env, agent.enabled)
      // Show what was actually stored: the endpoint loses its trailing slash
      // and both fields are trimmed, so the text left on screen would
      // otherwise differ from the value sessions will use.
      const storedKey = (env[DEEPSEEK_API_KEY_ENV] ?? "").trim()
      const storedBaseUrl = (env[DEEPSEEK_BASE_URL_ENV] ?? "").trim()
      setApiKey(storedKey)
      setBaseUrl(storedBaseUrl)
      // Record what was written, so the refresh this save triggers — which
      // brings back exactly these values — is not read as an external change.
      // Either order works: if the effect runs first it finds the fields
      // dirty and leaves them, and if this runs first the seed already
      // matches. What was just committed is no longer an unsaved edit, so the
      // fields go back to mirroring the persisted values.
      seeded.current = { apiKey: storedKey, baseUrl: storedBaseUrl }
      dirty.current = { apiKey: false, baseUrl: false }
      toast.success(t("toasts.deepseekSaved"))
    } catch (error) {
      console.error("[DeepSeek] save config failed", error)
      toast.error(t("toasts.saveDeepSeekFailed"))
    }
  }, [agent.env, agent.enabled, apiKey, baseUrl, onSaveEnv, t])

  return (
    <div className="space-y-3 rounded-md border bg-muted/10 p-3">
      <div>
        <label className="text-xs font-medium">
          {t("deepseek.configManagement")}
        </label>
        <p className="mt-1 text-2xs text-muted-foreground">
          {t("deepseek.configDescription")}
        </p>
      </div>

      {/* ── Endpoint ───────────────────────────────────────────────── */}
      <div className="space-y-1.5">
        <label
          htmlFor="deepseek-base-url"
          className="text-2xs text-muted-foreground"
        >
          {t("deepseek.baseUrlLabel")}
        </label>
        <Input
          id="deepseek-base-url"
          type="url"
          inputMode="url"
          value={baseUrl}
          onChange={(event) => {
            dirty.current.baseUrl = true
            setBaseUrl(event.target.value)
          }}
          placeholder={DEEPSEEK_DEFAULT_BASE_URL}
          disabled={saving}
          aria-invalid={!baseUrlValid}
          aria-describedby="deepseek-base-url-hint"
        />
        <p
          id="deepseek-base-url-hint"
          className={cn(
            "text-2xs",
            baseUrlValid ? "text-muted-foreground" : "text-destructive"
          )}
        >
          {baseUrlValid
            ? t("deepseek.baseUrlHint")
            : t("deepseek.baseUrlInvalid")}
        </p>
      </div>

      {/* ── Credential ─────────────────────────────────────────────── */}
      <div className="space-y-1.5">
        <label
          htmlFor="deepseek-api-key"
          className="text-2xs text-muted-foreground"
        >
          {t("deepseek.apiKeyLabel")}
        </label>
        <div className="flex items-center gap-2">
          <Input
            id="deepseek-api-key"
            type={showKey ? "text" : "password"}
            value={apiKey}
            onChange={(event) => {
              dirty.current.apiKey = true
              setApiKey(event.target.value)
            }}
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
          {t("deepseek.apiKeyHint")}
        </p>
      </div>

      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          onClick={() => void handleSave()}
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
              {t("actions.saveDeepSeekConfig")}
            </>
          )}
        </Button>
      </div>
    </div>
  )
}
