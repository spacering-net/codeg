"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  Loader2,
  RefreshCw,
  Save,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  acpQoderAuthStatus,
  acpQoderQuota,
  acpUpdateAgentConfig,
} from "@/lib/api"
import type { AcpAgentInfo, QoderAuthStatus, QoderQuota } from "@/lib/types"
import { cn } from "@/lib/utils"

/** Qoder's non-interactive credential, for machines where the browser login
 * flow can't run. Mirrors the backend's `agent_env_keys(Qoder)`. */
const QODER_PAT_ENV = "QODER_PERSONAL_ACCESS_TOKEN"

/** Credits read as whole numbers while they are whole (`3000`, not `3000.00`),
 * which is how Qoder's own surfaces show them. */
export function formatQoderCredits(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return ""
  return Number.isInteger(value)
    ? String(value)
    : String(Number(value.toFixed(2)))
}

/**
 * The account's credits for the auth card: one number beside the account name -
 * what is left across every package the account has, which is the allowance a
 * request actually draws on. The packages it is summed from (the personal plan,
 * the organization's shared package, any add-on) are deliberately not itemised
 * here; the backend sums them and reports the total.
 *
 * `remaining` receives the number and returns the whole line, so the unit is
 * spelled by the locale ("788 credits left" / "剩余 788") rather than pasted
 * from the raw token the service happens to send.
 */
export function qoderQuotaSummary(
  quota: QoderQuota,
  labels: { remaining: (credits: string) => string; exceeded: string }
): { line: string; title: string } {
  const credits = formatQoderCredits(quota.total_remaining)
  const line = labels.remaining(credits || "—")
  const title = [line, quota.is_quota_exceeded ? labels.exceeded : ""]
    .filter(Boolean)
    .join("\n")
  return { line, title }
}

/** Build the env map to persist: the PAT, or its removal when the field is
 * cleared (an empty value would be an empty credential, not "use the browser
 * login"). Unrelated keys are preserved untouched. */
export function buildQoderEnv(
  prevEnv: Record<string, string>,
  personalAccessToken: string
): Record<string, string> {
  const env: Record<string, string> = { ...prevEnv }
  const trimmed = personalAccessToken.trim()
  if (trimmed) {
    env[QODER_PAT_ENV] = trimmed
  } else {
    delete env[QODER_PAT_ENV]
  }
  return env
}

/** The copy-pasteable login command. A codeg-managed `qoder` lives in the
 * cache rather than on PATH, so a bare `qoder login` would fail — use the
 * resolved absolute path, quoted when it contains whitespace. */
export function qoderLoginCommand(binaryPath?: string | null): string {
  const path = (binaryPath ?? "").trim()
  if (!path) return "qoder login"
  const program = /\s/.test(path) ? `"${path}"` : path
  return `${program} login`
}

/** `security.auth.selectedType` (e.g. `qoder-browser`), read straight out of
 * the settings document the raw editor already carries. Written by the CLI's
 * own login flow and only ever displayed, so one read-only line does not
 * justify a projection of its own on the wire. Anything unparseable, or a
 * document that simply doesn't have the key, reads as "unknown" and the line
 * is skipped. */
export function qoderAuthMethod(configJson?: string | null): string {
  if (!configJson?.trim()) return ""
  try {
    const root = JSON.parse(configJson) as {
      security?: { auth?: { selectedType?: unknown } }
    } | null
    const value = root?.security?.auth?.selectedType
    return typeof value === "string" ? value : ""
  } catch {
    return ""
  }
}

/**
 * Dedicated settings panel for Qoder (`qoder --acp`).
 *
 * Two things only: the account (the browser login's status plus the personal
 * access token, which is a launch env var) and the raw
 * `<QODER_CONFIG_DIR>/settings.json`. Everything the CLI can be configured with
 * lives in that one file, and it is edited there verbatim rather than through a
 * wall of individual controls.
 *
 * Writing the whole document is also what makes deleting a key possible, and it
 * keeps codeg out of the way of the file's other writers — Qoder's own
 * `/settings` dialog, codeg's MCP settings page (owner of the top-level
 * `mcpServers`) and the CLI's permission engine all touch the same file.
 *
 * Model and reasoning effort are deliberately absent: Qoder reports both as
 * standard ACP config options, so the composer's own selectors own them per
 * session. A second copy here would only create two places to disagree about
 * what a session actually runs on.
 */
export function QoderConfigPanel({
  agent,
  saving,
  onSaveEnv,
  onSaved,
  onAffectedSessions,
}: {
  agent: AcpAgentInfo
  saving: boolean
  onSaveEnv: (env: Record<string, string>, enabled: boolean) => Promise<unknown>
  onSaved: () => void
  /** Reports how many running sessions a settings.json write marked
   * restart-required (the env step reports its own count internally). */
  onAffectedSessions: (count: number) => void
}) {
  const t = useTranslations("AcpAgentSettings")

  // --- auth card ---
  const [auth, setAuth] = useState<QoderAuthStatus | null>(null)
  // The account's credits, from their own probe: the CLI's usage lookup takes
  // seconds even when it succeeds, so it must not hold the account line back.
  const [quota, setQuota] = useState<QoderQuota | null>(null)
  const [authLoading, setAuthLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [token, setToken] = useState(() => agent.env[QODER_PAT_ENV] ?? "")
  const [showToken, setShowToken] = useState(false)
  const [savingToken, setSavingToken] = useState(false)

  // --- advanced (raw settings.json) ---
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [rawConfig, setRawConfig] = useState(() => agent.config_json ?? "")
  const [savingRaw, setSavingRaw] = useState(false)

  const authMethod = useMemo(
    () => qoderAuthMethod(agent.config_json),
    [agent.config_json]
  )

  const mountedRef = useRef(true)
  // Every refresh owns a generation. Two probes answer it at their own pace, so
  // a slow reply for a credential that is no longer on screen would otherwise
  // land on the current row; a reply from an older generation is dropped.
  const refreshGeneration = useRef(0)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      refreshGeneration.current += 1
    }
  }, [])

  // Re-seed when the persisted values change UNDER the panel — the settings
  // page refetches after every save, and another window (or the CLI itself) can
  // rewrite the file at any time.
  //
  // Edits in progress win: `dirty` is a ref set by the change handlers rather
  // than a comparison against the current text, because that text must NOT be a
  // dependency here. Between a save completing and the refresh it triggers
  // arriving, the editor already holds what was stored while `agent` still
  // holds the pre-save values — a re-run reading that as an external change
  // would revert the save on screen.
  const persistedRaw = agent.config_json ?? ""
  const rawSeeded = useRef(persistedRaw)
  const rawDirty = useRef(false)
  const persistedToken = agent.env[QODER_PAT_ENV] ?? ""
  const tokenSeeded = useRef(persistedToken)
  const tokenDirty = useRef(false)
  useEffect(() => {
    if (rawSeeded.current !== persistedRaw) {
      rawSeeded.current = persistedRaw
      if (!rawDirty.current) setRawConfig(persistedRaw)
    }
    if (tokenSeeded.current !== persistedToken) {
      tokenSeeded.current = persistedToken
      if (!tokenDirty.current) setToken(persistedToken)
    }
  }, [persistedRaw, persistedToken])

  // Mirrors of the two editable fields. The probe reads the token from here so
  // its callback stays stable across keystrokes; the save callbacks read both
  // after their await, to compare against what is on screen NOW rather than
  // what was on screen when the request went out.
  const tokenRef = useRef(token)
  const rawConfigRef = useRef(rawConfig)
  useEffect(() => {
    tokenRef.current = token
    rawConfigRef.current = rawConfig
  }, [rawConfig, token])

  // A balance belongs to one account: typing (or re-seeding) a token drops it
  // until a refresh answers for the new credential, so a name never sits beside
  // the previous account's credits.
  useEffect(() => {
    setQuota(null)
  }, [token])

  const refreshAuth = useCallback(async () => {
    const generation = ++refreshGeneration.current
    // Read the token ONCE for both calls: they must answer about the same
    // credential, or the row could mix one account's name with another's
    // credits.
    const liveToken = tokenRef.current
    /** Is this still the refresh the row is showing? */
    const current = () =>
      mountedRef.current && refreshGeneration.current === generation
    setQuota(null)
    setAuthLoading(true)
    // Both probes run at once and land on their own: the account line must not
    // wait for the slower usage lookup, and one failing must not hide the other.
    const status = acpQoderAuthStatus(liveToken).then(
      (answer) => {
        if (current()) setAuth(answer)
      },
      () => {
        // Probe failures surface through `auth.error`; a transport failure just
        // leaves the card in its unknown state.
      }
    )
    const credits = acpQoderQuota(liveToken).then(
      (answer) => {
        if (current()) setQuota(answer)
      },
      () => {
        // A failed lookup is the same "no numbers" as a null answer: the row
        // simply carries no credits.
      }
    )
    // The spinner describes the account line; the credits may still be in
    // flight behind it.
    await status
    if (current()) setAuthLoading(false)
    await credits
  }, [])

  useEffect(() => {
    void refreshAuth()
  }, [refreshAuth])

  const authState: "loading" | "missing" | "ok" | "error" | "loggedOut" =
    authLoading && !auth
      ? "loading"
      : !auth
        ? "missing"
        : !auth.installed
          ? "missing"
          : auth.error
            ? "error"
            : auth.logged_in
              ? "ok"
              : "loggedOut"

  const loginCommand = qoderLoginCommand(auth?.binary_path)

  const copyLoginCommand = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(loginCommand)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard may be unavailable; the command stays visible for manual copy.
    }
  }, [loginCommand])

  const saveToken = useCallback(async () => {
    setSavingToken(true)
    const prevEnv = agent.env
    const submitted = token
    try {
      // Nothing typed since the last save means nothing to write — no point
      // marking running sessions stale over an identical env.
      if (submitted.trim() !== (prevEnv[QODER_PAT_ENV] ?? "").trim()) {
        await onSaveEnv(buildQoderEnv(prevEnv, submitted), agent.enabled)
      }
      // Only the exact text that just landed stops counting as an unsaved
      // edit. The field stays editable while the request is in flight, so
      // anything typed since is NEWER than what was stored — clearing the flag
      // regardless would let the refresh this save triggers overwrite it.
      if (tokenRef.current === submitted) tokenDirty.current = false
      toast.success(t("toasts.qoderSaved"))
      onSaved()
    } catch (e) {
      toast.error(
        `${t("toasts.saveQoderConfigFailed")}: ${
          e instanceof Error ? e.message : String(e)
        }`
      )
    } finally {
      if (mountedRef.current) setSavingToken(false)
    }
  }, [agent.enabled, agent.env, onSaveEnv, onSaved, t, token])

  const saveRaw = useCallback(async () => {
    setSavingRaw(true)
    const submitted = rawConfig
    try {
      // The whole document, written verbatim — unlike the generic config
      // channel's merge, this is what lets a key be DELETED.
      const affected = await acpUpdateAgentConfig(agent.agent_type, {
        config_json: submitted,
      })
      onAffectedSessions(affected)
      // Same in-flight-edit rule as the token above: the editor stays typable
      // while the write is out, and only the text that actually landed stops
      // being an unsaved edit.
      if (rawConfigRef.current === submitted) rawDirty.current = false
      toast.success(t("toasts.qoderSaved"))
      onSaved()
    } catch (e) {
      toast.error(
        `${t("toasts.saveQoderConfigFailed")}: ${
          e instanceof Error ? e.message : String(e)
        }`
      )
    } finally {
      if (mountedRef.current) setSavingRaw(false)
    }
  }, [agent.agent_type, onAffectedSessions, onSaved, rawConfig, t])

  const busy = saving || savingToken

  // The account's credits for the row above; absent until the usage probe
  // answers, and absent for good when the CLI holds no credential the lookup
  // can use.
  const quotaSummary = useMemo(
    () =>
      quota
        ? qoderQuotaSummary(quota, {
            remaining: (credits) => t("qoder.quotaRemaining", { credits }),
            exceeded: t("qoder.quotaExceeded"),
          })
        : { line: "", title: "" },
    [quota, t]
  )

  return (
    <div className="space-y-3 rounded-md border bg-muted/10 p-3">
      <div>
        <label className="text-xs font-medium">{t("configManagement")}</label>
        <p className="mt-1 text-2xs text-muted-foreground">
          {t("qoder.configDescription")}
        </p>
      </div>

      {/* ---- Account ---- */}
      <div className="space-y-2 rounded-md border bg-background/60 p-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-2xs font-medium">{t("qoder.authTitle")}</span>
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                "inline-flex h-2 w-2 rounded-full",
                authState === "ok" && "bg-emerald-500",
                authState === "loggedOut" && "bg-amber-500",
                authState === "error" && "bg-destructive",
                authState === "missing" && "bg-muted-foreground/40",
                authState === "loading" &&
                  "bg-muted-foreground/40 animate-pulse"
              )}
            />
            <span className="text-2xs text-muted-foreground">
              {authState === "loading"
                ? t("qoder.authChecking")
                : authState === "missing"
                  ? t("qoder.authNotInstalled")
                  : authState === "error"
                    ? t("qoder.authUnknown")
                    : authState === "ok"
                      ? (auth?.username ??
                        auth?.email ??
                        t("qoder.authLoggedIn"))
                      : t("qoder.authNotLoggedIn")}
            </span>
            {authState === "ok" && auth?.user_type ? (
              <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-3xs text-emerald-600 dark:text-emerald-400">
                {auth.user_type}
              </span>
            ) : null}
            {authState === "ok" && quota ? (
              <span
                className={cn(
                  "rounded px-1.5 py-0.5 text-3xs tabular-nums",
                  quota.is_quota_exceeded
                    ? "bg-destructive/10 text-destructive"
                    : "bg-muted text-muted-foreground"
                )}
                data-testid="qoder-quota"
                title={quotaSummary.title}
              >
                {quotaSummary.line}
              </span>
            ) : null}
            {auth?.version ? (
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-3xs text-muted-foreground">
                {auth.version}
              </span>
            ) : null}
            <Button
              className="h-6 w-6"
              data-testid="qoder-auth-refresh"
              disabled={authLoading}
              onClick={() => void refreshAuth()}
              size="icon"
              type="button"
              variant="ghost"
            >
              <RefreshCw
                className={cn("h-3 w-3", authLoading && "animate-spin")}
              />
            </Button>
          </div>
        </div>

        {authState === "ok" && auth?.email && auth.email !== auth.username ? (
          <p className="text-3xs text-muted-foreground">{auth.email}</p>
        ) : null}

        {authState === "loggedOut" ? (
          <div className="space-y-1.5">
            <p className="text-2xs text-muted-foreground">
              {t("qoder.loginHint")}
            </p>
            <div className="flex items-center gap-1.5">
              <code className="flex-1 break-all rounded bg-muted px-2 py-1 font-mono text-2xs">
                {loginCommand}
              </code>
              <Button
                className="h-6 w-6 shrink-0"
                onClick={() => void copyLoginCommand()}
                size="icon"
                type="button"
                variant="ghost"
              >
                {copied ? (
                  <Check className="h-3 w-3 text-emerald-500" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
              </Button>
            </div>
          </div>
        ) : null}

        {auth?.error ? (
          <p className="text-2xs text-destructive">{auth.error}</p>
        ) : null}

        <div className="space-y-1">
          <label className="text-2xs text-muted-foreground" htmlFor="qoder-pat">
            {t("qoder.tokenLabel")}
          </label>
          <div className="flex items-center gap-1.5">
            <Input
              className="h-7 flex-1 text-xs"
              id="qoder-pat"
              onChange={(e) => {
                tokenDirty.current = true
                setToken(e.target.value)
              }}
              placeholder={t("qoder.tokenPlaceholder")}
              type={showToken ? "text" : "password"}
              value={token}
            />
            <Button
              className="h-7 w-7 shrink-0"
              onClick={() => setShowToken((v) => !v)}
              size="icon"
              title={
                showToken ? t("actions.hideApiKey") : t("actions.showApiKey")
              }
              type="button"
              variant="ghost"
            >
              {showToken ? (
                <EyeOff className="h-3.5 w-3.5" />
              ) : (
                <Eye className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
          <p className="text-3xs text-muted-foreground">
            {t("qoder.tokenHint")}
          </p>
        </div>

        {authMethod ? (
          <p className="text-3xs text-muted-foreground">
            {t("qoder.authMethodLabel")}:{" "}
            <code className="font-mono">{authMethod}</code>
          </p>
        ) : null}

        <div className="flex justify-end">
          <Button
            className="h-7 gap-1.5 px-2.5 text-xs"
            disabled={busy}
            onClick={() => void saveToken()}
            size="sm"
            type="button"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            {t("qoder.saveToken")}
          </Button>
        </div>
      </div>

      {/* ---- Advanced: raw settings.json ---- */}
      <div className="space-y-2">
        <button
          className="flex items-center gap-1 text-2xs text-muted-foreground hover:text-foreground"
          onClick={() => setAdvancedOpen((v) => !v)}
          type="button"
        >
          {advancedOpen ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
          {t("qoder.advancedToggle")}
        </button>
        {advancedOpen ? (
          <div className="space-y-1.5">
            <p className="text-3xs text-muted-foreground">
              {t("qoder.advancedHint")}
            </p>
            {agent.config_file_path ? (
              <code className="block overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-3xs whitespace-nowrap text-muted-foreground">
                {agent.config_file_path}
              </code>
            ) : null}
            <Textarea
              className="min-h-40 font-mono text-2xs"
              onChange={(e) => {
                rawDirty.current = true
                setRawConfig(e.target.value)
              }}
              spellCheck={false}
              value={rawConfig}
            />
            <div className="flex justify-end">
              <Button
                className="h-7 gap-1.5 px-2.5 text-xs"
                disabled={savingRaw || !rawConfig.trim()}
                onClick={() => void saveRaw()}
                size="sm"
                type="button"
                variant="outline"
              >
                {savingRaw ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="h-3.5 w-3.5" />
                )}
                {t("qoder.saveRawConfig")}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
