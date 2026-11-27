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

import {
  AgentPanelCard,
  AgentPanelGroup,
  AgentPanelSaveBar,
} from "@/components/settings/agent-panel-layout"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { acpQoderAuthStatus, acpUpdateAgentConfig } from "@/lib/api"
import type { AcpAgentInfo, QoderAuthStatus } from "@/lib/types"
import { cn } from "@/lib/utils"

/** Qoder's non-interactive credential, for machines where the browser login
 * flow can't run. Mirrors the backend's `agent_env_keys(Qoder)`. */
const QODER_PAT_ENV = "QODER_PERSONAL_ACCESS_TOKEN"

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
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
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

  const refreshAuth = useCallback(async () => {
    setAuthLoading(true)
    try {
      const status = await acpQoderAuthStatus(tokenRef.current)
      if (mountedRef.current) setAuth(status)
    } catch {
      // Probe failures surface through `auth.error`; a transport-level failure
      // just leaves the card in its unknown state.
    } finally {
      if (mountedRef.current) setAuthLoading(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- auth probe on mount; the loader flips its loading flag first
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

  return (
    <AgentPanelGroup
      title={t("configManagement")}
      description={t("qoder.configDescription")}
    >
      {/* ---- Account ---- */}
      <AgentPanelCard
        title={t("qoder.authTitle")}
        control={
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
            {auth?.version ? (
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-3xs text-muted-foreground">
                {auth.version}
              </span>
            ) : null}
            <Button
              className="h-6 w-6"
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
        }
      >
        {authState === "ok" && auth?.email && auth.email !== auth.username ? (
          <p className="text-2xs text-muted-foreground">{auth.email}</p>
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
          <p className="text-2xs text-muted-foreground">
            {t("qoder.tokenHint")}
          </p>
        </div>

        {authMethod ? (
          <p className="text-2xs text-muted-foreground">
            {t("qoder.authMethodLabel")}:{" "}
            <code className="font-mono">{authMethod}</code>
          </p>
        ) : null}

        <AgentPanelSaveBar>
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
        </AgentPanelSaveBar>
      </AgentPanelCard>

      {/* ---- Advanced: raw settings.json ---- */}
      <AgentPanelCard>
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
              <p className="text-2xs text-muted-foreground">
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
      </AgentPanelCard>
    </AgentPanelGroup>
  )
}
