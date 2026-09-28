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
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import {
  acpCursorAuthStatus,
  acpCursorListModels,
  acpUpdateAgentConfig,
} from "@/lib/api"
import type { AcpAgentInfo, CursorAuthStatus } from "@/lib/types"
import {
  buildCursorModelFamilies,
  decomposeCursorModelId,
  defaultCursorVariant,
  familyEffortValues,
  familyFastValues,
  familyThinkingValues,
  resolveCursorVariant,
  variantKey,
  type CursorEffort,
  type CursorModelEntry,
  type CursorModelFamily,
  type CursorVariant,
} from "@/lib/cursor-model-variants"
import { isDesktop, isRemoteDesktopMode } from "@/lib/transport"
import { cn } from "@/lib/utils"

const CURSOR_API_KEY_ENV = "CURSOR_API_KEY"
const CURSOR_API_BASE_URL_ENV = "CURSOR_API_BASE_URL"
const CURSOR_MODEL_ENV = "CURSOR_MODEL"
/** codeg-side launch knob: "1" inserts the CLI's root `--force` flag (Run
 * Everything) before the `acp` subcommand, "0" leaves it off. The CLI reads no
 * such env var. Off is written explicitly rather than by deleting the key —
 * see [`buildCursorEnv`]. */
const CURSOR_FORCE_ENV = "CURSOR_FORCE"
/** codeg-side knob recording the chosen authentication method. Read by the
 * launch path (`apply_cursor_env_policy`): in `subscription` mode it clears any
 * inherited CURSOR_API_KEY/BASE_URL so the CLI uses the browser-login
 * credential. The CLI itself ignores this var. */
const CURSOR_AUTH_MODE_ENV = "CURSOR_AUTH_MODE"

const UNSET = "__unset__"

/** The Cursor CLI's two real authentication methods. `custom` = a Cursor
 * account API key (headless/servers); it is NOT a third-party/OpenAI endpoint —
 * cursor-agent has no custom-endpoint support. The wire token stays `"custom"`
 * for backward-compatibility with rows saved before the rename. */
export type CursorAuthMethod = "subscription" | "custom"

/** One entry in the model-family picker. `value` is the family's base id, and
 * `label` its shared display name. base-ui's Combobox uses the `{ value, label
 * }` shape automatically (label for display + filtering, value for the value);
 * `isDefault` only drives our own badge. The `--model` id that actually gets
 * saved is the family member the variant controls resolve to. */
type CursorModelItem = { value: string; label: string; isDefault: boolean }

/** Effort ids are Cursor's own product vocabulary, shown verbatim in its CLI
 * and ACP pickers — model-parameter jargon, not prose, so it is not localized
 * (same treatment as the model names next to it). */
const EFFORT_LABELS: Record<CursorEffort, string> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
}

/**
 * Build the env map to persist for Cursor. The authentication method decides
 * which credential is written:
 *  - `subscription` — browser login only; the API key is deleted so a launch
 *    (and the probes) fall back to the Cursor account.
 *  - `custom` — the Cursor API key is written from the form.
 * The default model and the Run Everything (`--force`) knob apply to both.
 * `CURSOR_API_BASE_URL` is always removed (the CLI has no custom endpoint, so
 * a stale value is dead weight). `CURSOR_AUTH_MODE` is always recorded, and
 * unrelated keys are preserved untouched.
 *
 * `CURSOR_FORCE` is written for BOTH states ("1" / "0"), never deleted. Off
 * used to be a missing key, which the launch could not tell apart from "never
 * configured" — so the control showed one permission mode while the session ran
 * another. The backend (`cursor_force_enabled`) reads the same three states.
 */
export function buildCursorEnv(
  prevEnv: Record<string, string>,
  mode: CursorAuthMethod,
  apiKey: string,
  model: string,
  force: boolean
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
  env[CURSOR_AUTH_MODE_ENV] = mode
  // cursor-agent has no custom-endpoint support: the base URL is always removed,
  // scrubbing any value a legacy row or an old build may have written.
  delete env[CURSOR_API_BASE_URL_ENV]
  if (mode === "custom") {
    setOrDelete(CURSOR_API_KEY_ENV, apiKey)
  } else {
    // Subscription: never ship a saved key — the launch policy additionally
    // strips any inherited one so browser login is used.
    delete env[CURSOR_API_KEY_ENV]
  }
  setOrDelete(CURSOR_MODEL_ENV, model)
  env[CURSOR_FORCE_ENV] = force ? "1" : "0"
  return env
}

/** Resolve the persisted authentication method, tolerant of legacy rows: an
 * explicit `CURSOR_AUTH_MODE` wins; otherwise a saved API key implies custom. */
export function inferCursorMode(env: Record<string, string>): CursorAuthMethod {
  const explicit = (env[CURSOR_AUTH_MODE_ENV] ?? "").trim()
  if (explicit === "subscription" || explicit === "custom") return explicit
  return (env[CURSOR_API_KEY_ENV] ?? "").trim() ? "custom" : "subscription"
}

/** What the auth card can say about the account.
 *
 * `stale` is the state this panel used to be unable to express: the CLI still
 * has a login on disk (`is_authenticated`), so the card went green, but the
 * credential no longer works — and since `cursor-agent acp` refuses
 * `session/new` outright in exactly that case, the user was left reading
 * "signed in" next to a session failing with `Authentication required`. */
export type CursorAuthState =
  | "loading"
  | "missing"
  | "ok"
  | "stale"
  | "unauthenticated"

/** Derive the auth card's state. Split out of the component so the mapping —
 * in particular the `stale` case — is pinned by tests.
 *
 * `probing` only decides the FIRST answer: a re-probe must not blank a card
 * that already has one. */
export function cursorAuthState(
  auth: CursorAuthStatus | null,
  probing: boolean
): CursorAuthState {
  if (probing && !auth) return "loading"
  if (!auth || !auth.installed) return "missing"
  if (!auth.is_authenticated) return "unauthenticated"
  // Only an explicit `false` demotes a login: a backend that predates the flag
  // (or any status shape the probe did not recognize) leaves it null, and that
  // must keep meaning "signed in", not "broken".
  return auth.credential_verified === false ? "stale" : "ok"
}

/** A resolved binary path that says the codeg host runs Windows (`C:\…`, or a
 * UNC `\\server\share`). */
const WINDOWS_HOST_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/

/** Whether the login has to run on a machine other than the one showing this
 * panel.
 *
 * `login` opens a browser on the machine that RUNS it, which is the codeg host
 * — where cursor-agent lives. A web page and a remote-desktop window both talk
 * to a codeg server somewhere else, and a server usually has no display at
 * all: that is the reported case where the offered command "just cannot be
 * run". The instructions have to say where to run it and how to get through it
 * without a browser. */
export function cursorLoginRunsOnCodegHost(
  desktop: boolean,
  remoteDesktop: boolean
): boolean {
  return !desktop || remoteDesktop
}

/** Whether `NO_OPEN_BROWSER=1` — Cursor's documented way to print the sign-in
 * URL instead of opening a browser — can be put in front of the command.
 *
 * Deliberately narrower than [`cursorLoginRunsOnCodegHost`]: the prefix is
 * POSIX shell syntax, so on a Windows host cmd/PowerShell would read it as the
 * program name and the command would fail outright. Those users still get the
 * remote wording, which tells them to set the variable themselves. */
export function cursorLoginIsHeadless(
  binaryPath: string | null | undefined,
  desktop: boolean,
  remoteDesktop: boolean
): boolean {
  if (!cursorLoginRunsOnCodegHost(desktop, remoteDesktop)) return false
  return !WINDOWS_HOST_PATH.test((binaryPath ?? "").trim())
}

/** The copy-pasteable login command. The managed cursor-agent binary lives in
 * codeg's cache (not on PATH), so a bare `cursor-agent login` fails — use the
 * resolved absolute path, quoted when it contains whitespace. */
export function cursorLoginCommand(
  binaryPath?: string | null,
  headless = false
): string {
  const path = (binaryPath ?? "").trim()
  const program = !path ? "cursor-agent" : /\s/.test(path) ? `"${path}"` : path
  const command = `${program} login`
  return headless ? `NO_OPEN_BROWSER=1 ${command}` : command
}

/** The saved env's Run Everything knob, tolerant of hand-edited values. Mirrors
 * the launch-side `cursor_force_enabled`: unset (and anything unrecognized)
 * means Ask, which is what Cursor sessions have always actually done. */
export function isCursorForceEnabled(env: Record<string, string>): boolean {
  const value = (env[CURSOR_FORCE_ENV] ?? "").trim().toLowerCase()
  return value === "1" || value === "true"
}

/** One editable permission-rule row list (allow or deny). */
function RuleListEditor({
  rules,
  onChange,
  placeholder,
  addLabel,
  disabled,
  tone,
}: {
  rules: string[]
  onChange: (rules: string[]) => void
  placeholder: string
  addLabel: string
  disabled: boolean
  tone: "allow" | "deny"
}) {
  return (
    <div className="space-y-1.5">
      {rules.map((rule, index) => (
        <div className="flex items-center gap-1.5" key={index}>
          <Input
            className={cn(
              "h-7 flex-1 font-mono text-xs",
              tone === "deny" && "border-destructive/40"
            )}
            disabled={disabled}
            onChange={(e) => {
              const next = [...rules]
              next[index] = e.target.value
              onChange(next)
            }}
            placeholder={placeholder}
            value={rule}
          />
          <Button
            className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
            disabled={disabled}
            onClick={() => onChange(rules.filter((_, i) => i !== index))}
            size="icon"
            type="button"
            variant="ghost"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      <Button
        className="h-7 gap-1 px-2 text-xs"
        disabled={disabled}
        onClick={() => onChange([...rules, ""])}
        size="sm"
        type="button"
        variant="outline"
      >
        <Plus className="h-3 w-3" />
        {addLabel}
      </Button>
    </div>
  )
}

/**
 * Dedicated settings panel for Cursor (cursor-agent CLI). The user first picks
 * an **authentication method** (a Select, matching the Codex panel's idiom).
 * Both methods authenticate against Cursor's own backend — the CLI has no
 * bring-your-own-endpoint support, so there is no API-URL field:
 *
 * 1. **Official subscription** — sign in with a Cursor account
 *    (`"<path>" login`). No credential is stored; the launch clears any
 *    inherited CURSOR_API_KEY so browser login is used.
 * 2. **Cursor API key** — a Cursor Dashboard account key for headless/server
 *    machines (CURSOR_API_KEY), an alternative to browser login.
 *
 * The model card is shared and only shown once real models were fetched: a
 * searchable Combobox of model FAMILIES over `cursor-agent models`, plus
 * Thinking / Effort / Fast selects for the family's variants. The CLI reports
 * every combination as its own flat id (~200 of them), so those two knobs are
 * otherwise reachable only by knowing an id like
 * `claude-opus-5-thinking-max-fast` by heart. The resolved id is stored as
 * CURSOR_MODEL and passed to the CLI as its root `--model` flag at launch (it
 * seeds the session's model AND its parameters; the composer's live pickers
 * take over from there). The permission/sandbox editor and the raw-JSON
 * advanced card are unchanged.
 */
export function CursorConfigPanel({
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
  /** Reports how many running sessions a cli-config.json write marked
   * restart-required (the env step reports its own count internally). */
  onAffectedSessions: (count: number) => void
}) {
  const t = useTranslations("AcpAgentSettings")

  // --- authentication method ---
  const [mode, setMode] = useState<CursorAuthMethod>(() =>
    inferCursorMode(agent.env)
  )

  // --- auth card state ---
  const [auth, setAuth] = useState<CursorAuthStatus | null>(null)
  const [authLoading, setAuthLoading] = useState(false)
  const [copied, setCopied] = useState(false)

  // --- credential state (custom / API key mode) ---
  const [apiKey, setApiKey] = useState(
    () => agent.env[CURSOR_API_KEY_ENV] ?? ""
  )
  const [showKey, setShowKey] = useState(false)

  // --- model state (searchable family picker + variant controls) ---
  // `model` is the flat `cursor-agent models` id that gets persisted as
  // CURSOR_MODEL and passed to the CLI as `--model`; the controls below only
  // ever set it to an id the catalog actually reported.
  const [model, setModel] = useState(() => agent.env[CURSOR_MODEL_ENV] ?? "")
  const [models, setModels] = useState<CursorModelEntry[]>([])
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsLoaded, setModelsLoaded] = useState(false)

  // --- permissions card state ---
  const settings = agent.cursor_settings
  // Ask before running unless the knob explicitly says otherwise — the same
  // rule the launch applies (`cursor_force_enabled`), so what this control
  // shows is what the next session gets.
  const [force, setForce] = useState(() => isCursorForceEnabled(agent.env))
  const [sandboxMode, setSandboxMode] = useState(
    () => settings?.sandbox_mode ?? ""
  )
  const [allowRules, setAllowRules] = useState<string[]>(
    () => settings?.permissions_allow ?? []
  )
  const [denyRules, setDenyRules] = useState<string[]>(
    () => settings?.permissions_deny ?? []
  )

  // --- unified save state (auth method + model + permissions) ---
  const [savingAll, setSavingAll] = useState(false)

  // --- advanced card state ---
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [rawConfig, setRawConfig] = useState(
    () => agent.cursor_cli_config_json ?? ""
  )
  const [savingRaw, setSavingRaw] = useState(false)

  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // The effective API key the probes should test: the typed key in API-key
  // mode, or an empty string in subscription mode (which forces the
  // browser-login credential and strips any inherited CURSOR_API_KEY). Kept in
  // a ref so the probe callbacks stay stable and don't re-fire on keystroke.
  const probeKeyRef = useRef("")
  useEffect(() => {
    probeKeyRef.current = mode === "custom" ? apiKey : ""
  }, [mode, apiKey])

  const refreshAuth = useCallback(async () => {
    setAuthLoading(true)
    try {
      const status = await acpCursorAuthStatus(probeKeyRef.current)
      if (mountedRef.current) setAuth(status)
    } catch {
      // Probe failures already surface through `auth.error`; a transport-level
      // failure just leaves the card in its unknown state.
    } finally {
      if (mountedRef.current) setAuthLoading(false)
    }
  }, [])

  // Probe on mount and whenever the method changes (the ref above is updated
  // first, so the probe sees the right credential for the new mode).
  useEffect(() => {
    void refreshAuth()
  }, [refreshAuth, mode])

  const loadModels = useCallback(async () => {
    setModelsLoading(true)
    setModelsError(null)
    try {
      const result = await acpCursorListModels(probeKeyRef.current)
      if (!mountedRef.current) return
      setModels(
        result.models.map((m) => ({
          id: m.id,
          label: m.label || m.id,
          isDefault: m.is_default,
        }))
      )
      setModelsError(result.error)
      setModelsLoaded(true)
    } catch (e) {
      if (mountedRef.current) {
        setModelsError(e instanceof Error ? e.message : String(e))
        setModelsLoaded(true)
      }
    } finally {
      if (mountedRef.current) setModelsLoading(false)
    }
  }, [])

  const authState = cursorAuthState(auth, authLoading)

  // Once the account reports authenticated (either mode), fetch the model list
  // instead of waiting for a manual "load" click. Re-fetch when the method
  // changes so an API key and a browser login can list different catalogs.
  //
  // `stale` is excluded on purpose: the credential the CLI just failed to use
  // would fail `cursor-agent models` the same way, so loading would only swap
  // the "sign in again" hint for a raw API error. A later probe that clears
  // the flag flips this back to `ok` and the fetch runs then.
  useEffect(() => {
    if (authState !== "ok") return
    if (modelsLoaded || modelsLoading) return
    void loadModels()
  }, [authState, loadModels, modelsLoaded, modelsLoading])

  // Reset the "loaded" latch when the method changes so the effect above
  // re-probes the model list for the newly-selected credential.
  useEffect(() => {
    setModelsLoaded(false)
    setModels([])
    setModelsError(null)
  }, [mode])

  // Two decisions, not one: WHERE the command runs drives the wording, and
  // only a POSIX host can carry the env prefix.
  const remoteLogin = cursorLoginRunsOnCodegHost(
    isDesktop(),
    isRemoteDesktopMode()
  )
  const loginCommand = cursorLoginCommand(
    auth?.binary_path,
    cursorLoginIsHeadless(auth?.binary_path, isDesktop(), isRemoteDesktopMode())
  )

  const copyLoginCommand = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(loginCommand)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard may be unavailable (permissions); the command stays visible.
    }
  }, [loginCommand])

  // Model families: the fetched catalog grouped by base id, plus a
  // saved-but-unlisted model kept as its own one-member family so a hand-set
  // value still displays and isn't silently dropped on save.
  const families = useMemo<CursorModelFamily[]>(() => {
    const entries =
      model && !models.some((m) => m.id === model)
        ? [{ id: model, label: model, isDefault: false }, ...models]
        : models
    return buildCursorModelFamilies(entries)
  }, [models, model])

  const currentBase = model ? decomposeCursorModelId(model).base : ""
  const currentVariant = model ? decomposeCursorModelId(model).variant : null
  const currentFamily = families.find((f) => f.base === currentBase) ?? null

  const familyItems = useMemo<CursorModelItem[]>(
    () =>
      families.map((f) => ({
        value: f.base,
        label: f.label,
        isDefault: f.isDefault,
      })),
    [families]
  )
  const selectedFamilyItem =
    familyItems.find((f) => f.value === currentBase) ?? null

  // Picking a family carries the current variant across where the target
  // offers it (switching model rarely means "and drop my thinking level"),
  // falling back to that family's own default.
  const handleSelectFamily = useCallback(
    (item: CursorModelItem | null) => {
      if (!item) {
        setModel("")
        return
      }
      const family = families.find((f) => f.base === item.value)
      if (!family) return
      const want = currentVariant ?? defaultCursorVariant(family)
      const resolved = want ? resolveCursorVariant(family, want, null) : null
      setModel(resolved?.id ?? family.members[0]?.entry.id ?? "")
    },
    [families, currentVariant]
  )

  // Moving one variant control holds THAT dimension and repairs the rest —
  // not every combination exists (Cursor reaches xhigh/max on Opus only with
  // thinking on), so the others clamp to the nearest member that honours it.
  const setVariant = useCallback(
    (dimension: keyof CursorVariant, value: boolean | CursorEffort | null) => {
      if (!currentFamily || !currentVariant) return
      const want = { ...currentVariant, [dimension]: value } as CursorVariant
      const resolved = resolveCursorVariant(currentFamily, want, dimension)
      if (resolved) setModel(resolved.id)
    },
    [currentFamily, currentVariant]
  )

  // Only offer a dimension the family actually varies on — a lone "Fast: Off"
  // select is noise, and `auto` varies on nothing at all.
  const thinkingValues = currentFamily
    ? familyThinkingValues(currentFamily)
    : []
  const effortValues = currentFamily ? familyEffortValues(currentFamily) : []
  const fastValues = currentFamily ? familyFastValues(currentFamily) : []
  const hasVariantControls =
    thinkingValues.length > 1 ||
    effortValues.length > 1 ||
    fastValues.length > 1
  // What `--model` will actually receive, shown under the controls so the
  // resolved variant is never a guess.
  const resolvedEntry =
    currentFamily && currentVariant
      ? currentFamily.variants.get(variantKey(currentVariant))
      : undefined

  /** One save for auth method + model (env) and permissions (cli-config.json). */
  const saveAll = useCallback(async () => {
    if (mode === "custom" && !apiKey.trim()) {
      toast.error(t("cursor.customApiKeyRequired"))
      return
    }
    setSavingAll(true)
    const prevEnv = agent.env
    try {
      await onSaveEnv(
        buildCursorEnv(prevEnv, mode, apiKey, model, force),
        agent.enabled
      )
      try {
        const affected = await acpUpdateAgentConfig(agent.agent_type, {
          cursor_structured: {
            sandboxMode,
            permissionsAllow: allowRules,
            permissionsDeny: denyRules,
          },
        })
        onAffectedSessions(affected)
      } catch (e) {
        // A failed rules write must not leave the freshly-saved permission
        // knobs behind — e.g. Run Everything enabled while the new deny
        // rules never landed. Put the env back exactly as it was; if even
        // the rollback fails the error toast below still fires.
        await onSaveEnv(prevEnv, agent.enabled).catch(() => {})
        throw e
      }
      toast.success(t("toasts.cursorSaved"))
      onSaved()
    } catch (e) {
      toast.error(
        `${t("toasts.saveCursorConfigFailed")}: ${
          e instanceof Error ? e.message : String(e)
        }`
      )
    } finally {
      if (mountedRef.current) setSavingAll(false)
    }
  }, [
    agent.agent_type,
    agent.enabled,
    agent.env,
    allowRules,
    apiKey,
    denyRules,
    force,
    mode,
    model,
    onAffectedSessions,
    onSaveEnv,
    onSaved,
    sandboxMode,
    t,
  ])

  const saveRaw = useCallback(async () => {
    setSavingRaw(true)
    try {
      const affected = await acpUpdateAgentConfig(agent.agent_type, {
        cursor_cli_config_json: rawConfig,
      })
      onAffectedSessions(affected)
      toast.success(t("toasts.cursorSaved"))
      onSaved()
    } catch (e) {
      toast.error(
        `${t("toasts.saveCursorConfigFailed")}: ${
          e instanceof Error ? e.message : String(e)
        }`
      )
    } finally {
      if (mountedRef.current) setSavingRaw(false)
    }
  }, [agent.agent_type, onAffectedSessions, onSaved, rawConfig, t])

  const busy = saving || savingAll

  return (
    <div className="space-y-3 rounded-md border bg-muted/10 p-3">
      <div>
        <label className="text-xs font-medium">{t("configManagement")}</label>
        <p className="mt-1 text-2xs text-muted-foreground">
          {t("cursor.configDescription")}
        </p>
      </div>

      {/* ---- Authentication method ---- */}
      <div className="space-y-1.5">
        <label className="text-2xs text-muted-foreground">
          {t("cursor.authMode")}
        </label>
        <Select
          value={mode}
          onValueChange={(value) => setMode(value as CursorAuthMethod)}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start">
            <SelectItem value="subscription">
              {t("authModeOfficialSubscription")}
            </SelectItem>
            <SelectItem value="custom">{t("cursor.authModeApiKey")}</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-2xs text-muted-foreground">
          {mode === "subscription"
            ? t("cursor.subscriptionHint")
            : t("cursor.authModeApiKeyHint")}
        </p>
      </div>

      {/* ---- Credential card: shared auth status + method-specific body ---- */}
      <div className="space-y-2 rounded-md border bg-background/60 p-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-2xs font-medium">{t("cursor.authTitle")}</span>
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                "inline-flex h-2 w-2 rounded-full",
                authState === "ok" && "bg-emerald-500",
                authState === "stale" && "bg-amber-500",
                authState === "unauthenticated" && "bg-amber-500",
                authState === "missing" && "bg-muted-foreground/40",
                authState === "loading" &&
                  "bg-muted-foreground/40 animate-pulse"
              )}
            />
            <span className="text-2xs text-muted-foreground">
              {authState === "loading"
                ? t("cursor.authChecking")
                : authState === "missing"
                  ? t("cursor.authNotInstalled")
                  : authState === "ok"
                    ? (auth?.email ?? t("cursor.authLoggedIn"))
                    : authState === "stale"
                      ? t("cursor.authUnverified")
                      : t("cursor.authNotLoggedIn")}
            </span>
            {authState === "ok" && auth?.membership ? (
              <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-3xs text-emerald-600 dark:text-emerald-400">
                {auth.membership}
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
        </div>

        {/* A credential that is on disk but did not work is the case the
            session error comes from, so say what it means. The two modes fail
            for different reasons and recover differently — a browser login can
            only be re-run (the CLI carries no refresh-token grant), while a
            rejected key is replaced in the field below — so the text is not
            shared. */}
        {authState === "stale" ? (
          <p className="text-2xs text-amber-600 dark:text-amber-500">
            {t(
              mode === "custom"
                ? "cursor.authUnverifiedHintApiKey"
                : "cursor.authUnverifiedHint"
            )}
          </p>
        ) : null}

        {/* Subscription: runnable login command when the account is unusable. */}
        {mode === "subscription" &&
        (authState === "unauthenticated" || authState === "stale") ? (
          <div className="space-y-1.5">
            <p className="text-2xs text-muted-foreground">
              {t(remoteLogin ? "cursor.loginHintRemote" : "cursor.loginHint")}
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

        {/* API key mode: the Cursor Dashboard account key. */}
        {mode === "custom" ? (
          <div className="space-y-1">
            <label className="text-2xs text-muted-foreground">
              {t("cursor.apiKeyLabel")}
            </label>
            <div className="flex items-center gap-1.5">
              <Input
                className="h-7 flex-1 text-xs"
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={t("cursor.apiKeyPlaceholder")}
                type={showKey ? "text" : "password"}
                value={apiKey}
              />
              <Button
                className="h-7 w-7 shrink-0"
                onClick={() => setShowKey((v) => !v)}
                size="icon"
                type="button"
                variant="ghost"
              >
                {showKey ? (
                  <EyeOff className="h-3.5 w-3.5" />
                ) : (
                  <Eye className="h-3.5 w-3.5" />
                )}
              </Button>
            </div>
            <p className="text-3xs text-muted-foreground">
              {t("cursor.apiKeyHint")}
            </p>
          </div>
        ) : null}

        {auth?.error ? (
          <p className="text-2xs text-destructive">{auth.error}</p>
        ) : null}

        {/* No model list yet (not signed in / empty): tell the user why the
            picker is hidden, instead of showing an empty default control. */}
        {authState !== "missing" &&
        authState !== "loading" &&
        models.length === 0 ? (
          <p className="text-3xs text-muted-foreground">
            {t("cursor.modelsNeedAuth")}
          </p>
        ) : null}
      </div>

      {/* ---- Model picker (only when real models were fetched) ---- */}
      {models.length > 0 ? (
        <div className="space-y-2 rounded-md border bg-background/60 p-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-2xs font-medium">
              {t("cursor.modelTitle")}
            </span>
            <Button
              className="h-6 gap-1 px-2 text-2xs"
              disabled={modelsLoading}
              onClick={() => void loadModels()}
              size="sm"
              type="button"
              variant="ghost"
            >
              {modelsLoading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              {t("cursor.loadModels")}
            </Button>
          </div>
          <Combobox
            key={currentBase || UNSET}
            items={familyItems}
            value={selectedFamilyItem}
            onValueChange={handleSelectFamily}
            isItemEqualToValue={(
              a: CursorModelItem | null,
              b: CursorModelItem | null
            ) => (a?.value ?? null) === (b?.value ?? null)}
          >
            <ComboboxInput
              className="h-8 text-xs"
              placeholder={t("cursor.modelPickerPlaceholder")}
              showClear
            />
            <ComboboxContent>
              <ComboboxList>
                {(item: CursorModelItem) => (
                  <ComboboxItem
                    className="text-xs"
                    key={item.value}
                    value={item}
                  >
                    <span className="truncate">{item.label}</span>
                    <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2 font-mono text-3xs text-muted-foreground">
                      {item.isDefault ? (
                        <span className="rounded bg-muted px-1 py-0.5 font-sans text-[0.5625rem] text-foreground/70">
                          {t("cursor.modelDefaultBadge")}
                        </span>
                      ) : null}
                      {item.value}
                    </span>
                  </ComboboxItem>
                )}
              </ComboboxList>
              <ComboboxEmpty>{t("cursor.modelNoMatch")}</ComboboxEmpty>
            </ComboboxContent>
          </Combobox>

          {/* Variant controls — the reason the flat catalog was split up. The
              CLI ships one id per combination (`claude-opus-5-thinking-max-fast`
              and ~200 siblings), so without these the thinking level and the
              Fast flag are only reachable by knowing the id by heart. */}
          {hasVariantControls ? (
            <div className="flex flex-wrap gap-2">
              {thinkingValues.length > 1 ? (
                <div className="min-w-24 flex-1 space-y-1">
                  <label className="text-2xs text-muted-foreground">
                    {t("cursor.modelThinkingLabel")}
                  </label>
                  <Select
                    onValueChange={(value) =>
                      setVariant("thinking", value === "true")
                    }
                    value={currentVariant?.thinking ? "true" : "false"}
                  >
                    <SelectTrigger className="h-7 w-full text-xs" size="sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem className="text-xs" value="false">
                        {t("cursor.variantOff")}
                      </SelectItem>
                      <SelectItem className="text-xs" value="true">
                        {t("cursor.variantOn")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
              {effortValues.length > 1 ? (
                <div className="min-w-24 flex-1 space-y-1">
                  <label className="text-2xs text-muted-foreground">
                    {t("cursor.modelEffortLabel")}
                  </label>
                  <Select
                    onValueChange={(value) =>
                      setVariant(
                        "effort",
                        value === UNSET ? null : (value as CursorEffort)
                      )
                    }
                    value={currentVariant?.effort ?? UNSET}
                  >
                    <SelectTrigger className="h-7 w-full text-xs" size="sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {effortValues.map((effort) => (
                        <SelectItem
                          className="text-xs"
                          key={effort ?? UNSET}
                          value={effort ?? UNSET}
                        >
                          {effort
                            ? EFFORT_LABELS[effort]
                            : t("cursor.optionDefault")}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
              {fastValues.length > 1 ? (
                <div className="min-w-24 flex-1 space-y-1">
                  <label className="text-2xs text-muted-foreground">
                    {t("cursor.modelFastLabel")}
                  </label>
                  <Select
                    onValueChange={(value) =>
                      setVariant("fast", value === "true")
                    }
                    value={currentVariant?.fast ? "true" : "false"}
                  >
                    <SelectTrigger className="h-7 w-full text-xs" size="sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem className="text-xs" value="false">
                        {t("cursor.variantOff")}
                      </SelectItem>
                      <SelectItem className="text-xs" value="true">
                        {t("cursor.variantOn")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
            </div>
          ) : null}

          {/* The exact id `--model` receives. A repaired pick (an unavailable
              combination clamped to its nearest sibling) is only visible here. */}
          {resolvedEntry ? (
            <p className="text-3xs text-muted-foreground">
              <span className="text-foreground/80">{resolvedEntry.label}</span>{" "}
              <span className="font-mono">{resolvedEntry.id}</span>
            </p>
          ) : null}

          {modelsError ? (
            <p className="text-3xs text-muted-foreground">
              {t("cursor.modelsUnavailable")}: {modelsError}
            </p>
          ) : null}
          <p className="text-3xs text-muted-foreground">
            {t("cursor.modelHint")}
          </p>
          {hasVariantControls ? (
            <p className="text-3xs text-muted-foreground">
              {t("cursor.modelVariantHint")}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* ---- Permissions & sandbox card (both methods) ---- */}
      <div className="space-y-2 rounded-md border bg-background/60 p-2.5">
        <div className="flex items-center gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-2xs font-medium">
            {t("cursor.permissionsTitle")}
          </span>
        </div>
        <p className="text-3xs text-muted-foreground">
          {t("cursor.permissionsDescription")}
        </p>

        <div className="grid gap-2 md:grid-cols-2">
          <div className="space-y-1">
            <label className="text-2xs text-muted-foreground">
              {t("cursor.permissionModeLabel")}
            </label>
            <Select
              onValueChange={(value) => setForce(value === "force")}
              value={force ? "force" : "default"}
            >
              <SelectTrigger className="h-7 w-full text-xs" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem className="text-xs" value="default">
                  {t("cursor.permissionModeDefault")}
                </SelectItem>
                <SelectItem className="text-xs" value="force">
                  {t("cursor.permissionModeForce")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-2xs text-muted-foreground">
              {t("cursor.sandboxLabel")}
            </label>
            <Select
              onValueChange={(value) =>
                setSandboxMode(value === UNSET ? "" : value)
              }
              value={sandboxMode || UNSET}
            >
              <SelectTrigger className="h-7 w-full text-xs" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem className="text-xs" value={UNSET}>
                  {t("cursor.optionDefault")}
                </SelectItem>
                <SelectItem className="text-xs" value="enabled">
                  {t("cursor.sandboxEnabled")}
                </SelectItem>
                <SelectItem className="text-xs" value="disabled">
                  {t("cursor.sandboxDisabled")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        {/* Whichever mode is selected, say what it actually does. Ask mode's
            half matters most: Cursor's own prompt carries an "Allow always"
            button, and the rule it writes lands in the Allowed list right
            below — the connection is invisible otherwise. */}
        <p className="text-3xs text-muted-foreground">
          {force
            ? t("cursor.permissionModeHint")
            : t("cursor.permissionModeAskHint")}
        </p>

        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <label className="text-2xs text-muted-foreground">
              {t("cursor.allowRulesLabel")}
            </label>
            <RuleListEditor
              addLabel={t("cursor.addRule")}
              disabled={busy}
              onChange={setAllowRules}
              placeholder="Shell(git)"
              rules={allowRules}
              tone="allow"
            />
          </div>
          <div className="space-y-1">
            <label className="text-2xs text-muted-foreground">
              {t("cursor.denyRulesLabel")}
            </label>
            <RuleListEditor
              addLabel={t("cursor.addRule")}
              disabled={busy}
              onChange={setDenyRules}
              placeholder="Read(.env*)"
              rules={denyRules}
              tone="deny"
            />
          </div>
        </div>
        <p className="text-3xs text-muted-foreground">
          {t("cursor.rulesSyntaxHint")}
        </p>
      </div>

      {/* ---- One save for auth method + model + permissions ---- */}
      <div className="flex justify-end">
        <Button
          className="h-7 gap-1.5 px-2.5 text-xs"
          disabled={busy}
          onClick={() => void saveAll()}
          size="sm"
          type="button"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save className="h-3.5 w-3.5" />
          )}
          {t("cursor.saveConfig")}
        </Button>
      </div>

      {/* ---- Advanced: raw cli-config.json ---- */}
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
          {t("cursor.advancedToggle")}
        </button>
        {advancedOpen ? (
          <div className="space-y-1.5">
            <p className="text-3xs text-muted-foreground">
              {t("cursor.advancedHint")}
            </p>
            <Textarea
              className="min-h-40 font-mono text-2xs"
              onChange={(e) => setRawConfig(e.target.value)}
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
                {t("cursor.saveRawConfig")}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
