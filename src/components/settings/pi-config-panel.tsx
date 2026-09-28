"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  CheckCircle2,
  Cpu,
  Download,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  RotateCw,
  Save,
  ShieldCheck,
  TerminalSquare,
  Trash2,
  XCircle,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import {
  acpInstallPiBinary,
  acpPiListTrustEntries,
  acpPiSetProjectTrust,
  acpUninstallPiBinary,
  acpUpdatePiConfig,
  acpValidatePiCommand,
  loadPiConfig,
  type PiTrustEntry,
} from "@/lib/api"
import { useAgentInstallStream } from "@/hooks/use-agent-install-stream"
import { PI_CONFIG_DIR_ENV } from "@/lib/pi-config"
import {
  PI_THINKING_LEVELS,
  implicitWireValue,
  reasoningFromModel,
  reasoningToMap,
  toggleLevel,
  type PiModelReasoning,
  type PiThinkingLevel,
} from "@/lib/pi-thinking"
import type { AcpAgentInfo } from "@/lib/types"
import { cn, randomUUID } from "@/lib/utils"

const PI_COMMAND_ENV = "PI_ACP_PI_COMMAND"
const PI_SESSION_DIR_ENV = "PI_CODING_AGENT_SESSION_DIR"
/**
 * LEGACY per-agent `env_json` flag that used to gate launch-time workspace-trust
 * seeding. codeg no longer seeds pi's `trust.json` — auto-trusting the opened
 * folder let a repo's own `.pi/extensions` execute at pi startup — so nothing
 * reads this key any more; project trust is an explicit per-workspace decision
 * (see `PiProjectTrustBanner` and the Project trust list below). It stays
 * reserved so a `"0"` persisted by an older build keeps out of the raw env
 * editor instead of resurfacing there as a user-defined variable.
 */
const PI_TRUST_WORKSPACE_ENV = "PI_ACP_TRUST_WORKSPACE"

/**
 * Reserved env keys the structured pi UI owns. pi-acp reads `PI_ACP_PI_COMMAND`
 * to pick which `pi` binary to spawn, and forwards `PI_CODING_AGENT_DIR` /
 * `PI_CODING_AGENT_SESSION_DIR` to it; `PI_ACP_TRUST_WORKSPACE` is the inert
 * legacy key above. These persist through the same per-agent `env_json` path
 * every other env var uses, so the structured UI needs no bespoke storage — the
 * launch pipeline already injects env_json.
 */
export const PI_RESERVED_ENV_KEYS = [
  PI_COMMAND_ENV,
  PI_CONFIG_DIR_ENV,
  PI_SESSION_DIR_ENV,
  PI_TRUST_WORKSPACE_ENV,
] as const

type PiRuntimeMode = "default" | "custom"

/** A custom provider as `loadPiConfig` projects it out of `models.json`. */
type PiCustomProvider = Awaited<
  ReturnType<typeof loadPiConfig>
>["customProviders"][number]

/** A model that has never declared reasoning — pi treats it as `["off"]` only. */
const NO_REASONING: PiModelReasoning = {
  enabled: false,
  levels: [],
  wireValues: {},
}

/**
 * Curated built-in providers for the enum, as `{ id, label }`: the Select stores
 * the `id` (pi's provider key, written to settings.json / auth.json) but shows the
 * brand `label`. Mirrors pi's authoritative `env-api-keys.ts` `envMap` — the
 * single-API-key subset most users want. Labels are brand names, not localized
 * (same convention as `HERMES_PROVIDERS`). Special-auth providers (azure /
 * bedrock / vertex / cloudflare / github-copilot) are omitted on purpose — they
 * need more than a single key, so they don't fit this flow; use "Custom" for them.
 */
const PI_BUILTIN_PROVIDERS: { id: string; label: string }[] = [
  { id: "anthropic", label: "Anthropic" },
  { id: "openai", label: "OpenAI" },
  { id: "google", label: "Google Gemini" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "vercel-ai-gateway", label: "Vercel AI Gateway" },
  { id: "xai", label: "xAI" },
  { id: "deepseek", label: "DeepSeek" },
  { id: "groq", label: "Groq" },
  { id: "cerebras", label: "Cerebras" },
  { id: "mistral", label: "Mistral" },
  { id: "nvidia", label: "NVIDIA NIM" },
  { id: "together", label: "Together AI" },
  { id: "fireworks", label: "Fireworks" },
  { id: "huggingface", label: "Hugging Face" },
  { id: "kimi-coding", label: "Kimi For Coding" },
  { id: "moonshotai", label: "Moonshot AI" },
  { id: "moonshotai-cn", label: "Moonshot AI (China)" },
  { id: "zai", label: "Z.AI Coding Plan (Global)" },
  { id: "zai-coding-cn", label: "Z.AI Coding Plan (China)" },
  { id: "minimax", label: "MiniMax" },
  { id: "minimax-cn", label: "MiniMax (China)" },
  { id: "ant-ling", label: "Ant Ling" },
  { id: "xiaomi", label: "Xiaomi MiMo" },
  { id: "xiaomi-token-plan-cn", label: "Xiaomi MiMo Token Plan (China)" },
  { id: "xiaomi-token-plan-ams", label: "Xiaomi MiMo Token Plan (Amsterdam)" },
  { id: "xiaomi-token-plan-sgp", label: "Xiaomi MiMo Token Plan (Singapore)" },
  { id: "opencode", label: "OpenCode Zen" },
  { id: "opencode-go", label: "OpenCode Go" },
]

/** Sentinel Select value that switches the credentials form to custom mode. */
const PI_CUSTOM_SENTINEL = "__custom__"

/** Wire protocols pi accepts for a custom provider in `models.json`. */
const PI_CUSTOM_API_PROTOCOLS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
]

type PiValidation = {
  found: boolean
  resolvedPath: string | null
  version: string | null
} | null

/**
 * Build the env map to persist for pi's runtime. `custom` mode writes
 * `PI_ACP_PI_COMMAND` (+ the optional dir overrides); `default` mode clears all
 * three so pi-acp falls back to the `pi` on PATH. Unrelated env keys are
 * preserved untouched, so this never clobbers other per-agent env.
 */
export function buildPiRuntimeEnv(
  prevEnv: Record<string, string>,
  mode: PiRuntimeMode,
  command: string,
  configDir: string,
  sessionDir: string
): Record<string, string> {
  const env: Record<string, string> = { ...prevEnv }
  const cmd = command.trim()
  if (mode === "custom" && cmd) {
    env[PI_COMMAND_ENV] = cmd
    const cfg = configDir.trim()
    if (cfg) env[PI_CONFIG_DIR_ENV] = cfg
    else delete env[PI_CONFIG_DIR_ENV]
    const ses = sessionDir.trim()
    if (ses) env[PI_SESSION_DIR_ENV] = ses
    else delete env[PI_SESSION_DIR_ENV]
  } else {
    delete env[PI_COMMAND_ENV]
    delete env[PI_CONFIG_DIR_ENV]
    delete env[PI_SESSION_DIR_ENV]
  }
  return env
}

/**
 * Dedicated settings panel for pi. Two concerns, two stores:
 *  - Credentials/model — written to pi's native `~/.pi/agent/settings.json`
 *    (`defaultProvider`/`defaultModel`/`defaultThinkingLevel`) and `auth.json`
 *    (the API key) via the `acp_update_pi_config` backend.
 *  - Runtime (bring-your-own-pi) — a visual default↔custom toggle that writes
 *    `PI_ACP_PI_COMMAND` (+ optional config/session dir overrides) into the
 *    per-agent `env_json`, letting users run their own pi build/install.
 */
export function PiConfigPanel({
  agent,
  saving,
  onSaveEnv,
  onSaved,
}: {
  agent: AcpAgentInfo
  saving: boolean
  onSaveEnv: (env: Record<string, string>, enabled: boolean) => Promise<unknown>
  onSaved: () => Promise<void>
}) {
  const t = useTranslations("AcpAgentSettings")

  // --- Credentials (pi's native ~/.pi/agent/{settings,auth,models}.json) ---
  // `selectedProvider` is the Select value: a built-in id, a loaded-but-not-
  // enumerated built-in, or PI_CUSTOM_SENTINEL. In custom mode the effective
  // provider is `customId` (the key written to models.json / auth.json).
  const [selectedProvider, setSelectedProvider] = useState("")
  const [customId, setCustomId] = useState("")
  const [customBaseUrl, setCustomBaseUrl] = useState("")
  const [customApi, setCustomApi] = useState(PI_CUSTOM_API_PROTOCOLS[0])
  const [customProviders, setCustomProviders] = useState<PiCustomProvider[]>([])
  const [model, setModel] = useState("")
  const [thinkingLevel, setThinkingLevel] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [showKey, setShowKey] = useState(false)
  const [authProviders, setAuthProviders] = useState<string[]>([])
  const [savingCreds, setSavingCreds] = useState(false)
  const [loadingCreds, setLoadingCreds] = useState(true)
  const [reasoning, setReasoning] = useState<PiModelReasoning>(NO_REASONING)
  const [showWireValues, setShowWireValues] = useState(false)

  const isCustom = selectedProvider === PI_CUSTOM_SENTINEL
  const effectiveProvider = (isCustom ? customId : selectedProvider).trim()

  // Rehydrate the reasoning controls whenever the edited model's identity changes
  // (provider switch, or a different model id typed in). Reading the stored entry
  // rather than defaulting the form to "off" is what stops a save from wiping a
  // declaration the user hand-wrote into models.json. Adjusting during render is
  // React's documented pattern for "reset state when the thing it describes
  // changes" — an effect would render one frame of the previous model's chips.
  // Newline separator: neither a provider key nor a model id can contain one,
  // so the halves cannot run together into a colliding key.
  const reasoningKey =
    loadingCreds || !isCustom ? null : `${effectiveProvider}\n${model.trim()}`
  const [lastReasoningKey, setLastReasoningKey] = useState<string | null>(null)
  if (reasoningKey !== null && reasoningKey !== lastReasoningKey) {
    setLastReasoningKey(reasoningKey)
    const stored = customProviders
      .find((provider) => provider.id === effectiveProvider)
      ?.models?.find((entry) => entry.id === model.trim())
    setReasoning(
      reasoningFromModel(stored?.reasoning, stored?.thinkingLevelMap)
    )
  }

  useEffect(() => {
    let cancelled = false
    setLoadingCreds(true)
    loadPiConfig()
      .then((cfg) => {
        if (cancelled) return
        setModel(cfg.defaultModel ?? "")
        setThinkingLevel(cfg.defaultThinkingLevel ?? "")
        setAuthProviders(cfg.authProviders ?? [])
        const customs = cfg.customProviders ?? []
        setCustomProviders(customs)
        const dp = cfg.defaultProvider ?? ""
        const matched = customs.find((c) => c.id === dp)
        if (matched) {
          // defaultProvider is a custom/self-hosted provider → custom mode.
          setSelectedProvider(PI_CUSTOM_SENTINEL)
          setCustomId(matched.id)
          setCustomBaseUrl(matched.baseUrl)
          setCustomApi(matched.api || PI_CUSTOM_API_PROTOCOLS[0])
        } else {
          setSelectedProvider(dp)
        }
      })
      .catch((error) => {
        console.error("[Pi] load config failed", error)
      })
      .finally(() => {
        if (!cancelled) setLoadingCreds(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Levels the picker may offer. A built-in provider keeps pi's full vocabulary —
  // pi carries its own, more accurate declaration for those models.
  const availableLevels: readonly PiThinkingLevel[] =
    isCustom && reasoning.enabled ? reasoning.levels : PI_THINKING_LEVELS
  // pi's `defaultThinkingLevel` is global, not per-model, so a level that suits one
  // model can be unreachable on another. Say so instead of letting pi clamp it.
  const defaultLevelUnlisted =
    isCustom &&
    reasoning.enabled &&
    thinkingLevel !== "" &&
    !reasoning.levels.includes(thinkingLevel as PiThinkingLevel)
  const effectiveThinkingLevel =
    isCustom && !reasoning.enabled ? "off" : thinkingLevel

  const handleSaveCreds = useCallback(async () => {
    const trimmedModel = model.trim()
    if (!effectiveProvider || !trimmedModel) {
      toast.error(t("pi.providerModelRequired"))
      return
    }
    const trimmedBaseUrl = customBaseUrl.trim()
    if (isCustom && !trimmedBaseUrl) {
      toast.error(t("pi.baseUrlRequired"))
      return
    }
    // An enabled declaration with nothing checked leaves pi with an empty
    // vocabulary, which clamps to `off` — the exact failure the card exists to
    // prevent, so refuse it rather than write it.
    if (isCustom && reasoning.enabled && reasoning.levels.length === 0) {
      toast.error(t("pi.levelsEmptyError"))
      return
    }
    if (defaultLevelUnlisted) {
      toast.error(t("pi.defaultLevelUnlisted"))
      return
    }
    const thinkingLevelMap = reasoningToMap(reasoning)
    setSavingCreds(true)
    try {
      await acpUpdatePiConfig({
        provider: effectiveProvider,
        model: trimmedModel,
        thinkingLevel: effectiveThinkingLevel || undefined,
        apiKey: apiKey.trim() || undefined,
        customBaseUrl: isCustom ? trimmedBaseUrl : undefined,
        customApi: isCustom ? customApi : undefined,
        modelReasoning: isCustom
          ? {
              reasoning: reasoning.enabled,
              thinkingLevelMap: thinkingLevelMap as Record<
                string,
                string | null
              >,
            }
          : undefined,
      })
      if (apiKey.trim()) {
        setApiKey("")
        setAuthProviders((prev) =>
          prev.includes(effectiveProvider)
            ? prev
            : [...prev, effectiveProvider].sort()
        )
      }
      if (isCustom) {
        // Reflect the just-saved custom provider so a reopen rehydrates it —
        // including the model's declaration, so switching away and back shows
        // the chips that are now on disk rather than a stale read.
        setCustomProviders((prev) => {
          const previous = prev.find((c) => c.id === effectiveProvider)
          const models = (previous?.models ?? []).filter(
            (entry) => entry.id !== trimmedModel
          )
          models.push({
            id: trimmedModel,
            reasoning: reasoning.enabled,
            thinkingLevelMap: thinkingLevelMap as Record<string, string | null>,
          })
          models.sort((a, b) => a.id.localeCompare(b.id))
          const next = prev.filter((c) => c.id !== effectiveProvider)
          next.push({
            id: effectiveProvider,
            baseUrl: trimmedBaseUrl,
            api: customApi,
            models,
          })
          next.sort((a, b) => a.id.localeCompare(b.id))
          return next
        })
      }
      await onSaved()
      toast.success(t("toasts.piSaved"))
    } catch (error) {
      console.error("[Pi] save config failed", error)
      toast.error(t("toasts.savePiFailed"))
    } finally {
      setSavingCreds(false)
    }
  }, [
    effectiveProvider,
    isCustom,
    customBaseUrl,
    customApi,
    model,
    effectiveThinkingLevel,
    defaultLevelUnlisted,
    reasoning,
    apiKey,
    onSaved,
    t,
  ])

  const providerHasKey =
    effectiveProvider !== "" && authProviders.includes(effectiveProvider)

  // Built-in enum, plus a loaded built-in that isn't in the curated list (so a
  // pre-existing defaultProvider is never dropped from the dropdown). An unknown
  // id doubles as its own label since we have no friendly name for it.
  const providerOptions =
    selectedProvider &&
    selectedProvider !== PI_CUSTOM_SENTINEL &&
    !PI_BUILTIN_PROVIDERS.some((p) => p.id === selectedProvider)
      ? [
          ...PI_BUILTIN_PROVIDERS,
          { id: selectedProvider, label: selectedProvider },
        ]
      : PI_BUILTIN_PROVIDERS

  const credsIncomplete =
    !effectiveProvider || !model.trim() || (isCustom && !customBaseUrl.trim())

  const handleProviderChange = useCallback(
    (value: string) => {
      setSelectedProvider(value)
      // Switching to custom with nothing typed yet → prefill from an existing
      // custom provider (if any) so a known endpoint need not be re-entered.
      if (
        value === PI_CUSTOM_SENTINEL &&
        !customId.trim() &&
        customProviders[0]
      ) {
        const first = customProviders[0]
        setCustomId(first.id)
        setCustomBaseUrl(first.baseUrl)
        setCustomApi(first.api || PI_CUSTOM_API_PROTOCOLS[0])
      }
    },
    [customId, customProviders]
  )

  // --- pi binary (pi-coding-agent) — the prerequisite pi-acp spawns ---
  // Status reflects the default `pi` on PATH (the global npm package); Install/
  // Uninstall manage that package and stream to the shared install-log block.
  // Surfaced inside the Runtime card's "Default pi" mode (where the global pi is
  // what runs); the bring-your-own-pi override is the "Custom pi" mode.
  const installStream = useAgentInstallStream()
  const {
    status: piInstallStatus,
    logs: piInstallLogs,
    start: startPiInstall,
    reset: resetPiInstall,
  } = installStream
  const installLogEndRef = useRef<HTMLDivElement | null>(null)
  const [piStatus, setPiStatus] = useState<PiValidation>(null)
  const [checkingPi, setCheckingPi] = useState(true)
  const [piOp, setPiOp] = useState<"install" | "uninstall" | null>(null)

  const detectPiBinary = useCallback(async () => {
    setCheckingPi(true)
    try {
      setPiStatus(await acpValidatePiCommand("pi"))
    } catch (error) {
      console.error("[Pi] detect binary failed", error)
      setPiStatus({ found: false, resolvedPath: null, version: null })
    } finally {
      setCheckingPi(false)
    }
  }, [])

  useEffect(() => {
    void detectPiBinary()
  }, [detectPiBinary])

  // Keep the streaming log pinned to its latest line.
  useEffect(() => {
    const container = installLogEndRef.current?.parentElement
    if (container) container.scrollTop = container.scrollHeight
  }, [piInstallLogs])

  // Tear the subscription down on unmount (reset is stable across renders).
  useEffect(() => () => resetPiInstall(), [resetPiInstall])

  const handleInstallPi = useCallback(async () => {
    const taskId = randomUUID()
    setPiOp("install")
    await startPiInstall(taskId)
    try {
      await acpInstallPiBinary(taskId)
      toast.success(t("toasts.piBinaryInstalled"))
      await detectPiBinary()
    } catch (error) {
      console.error("[Pi] install binary failed", error)
      toast.error(t("toasts.piBinaryInstallFailed"))
    } finally {
      setPiOp(null)
    }
  }, [startPiInstall, detectPiBinary, t])

  const handleUninstallPi = useCallback(async () => {
    const taskId = randomUUID()
    setPiOp("uninstall")
    await startPiInstall(taskId)
    try {
      await acpUninstallPiBinary(taskId)
      toast.success(t("toasts.piBinaryUninstalled"))
      await detectPiBinary()
    } catch (error) {
      console.error("[Pi] uninstall binary failed", error)
      toast.error(t("toasts.piBinaryUninstallFailed"))
    } finally {
      setPiOp(null)
    }
  }, [startPiInstall, detectPiBinary, t])

  // --- Runtime (bring-your-own-pi, persisted to env_json reserved keys) ---
  const [mode, setMode] = useState<PiRuntimeMode>(() =>
    (agent.env[PI_COMMAND_ENV] ?? "").trim() ? "custom" : "default"
  )
  const [command, setCommand] = useState(() => agent.env[PI_COMMAND_ENV] ?? "")
  const [configDir, setConfigDir] = useState(
    () => agent.env[PI_CONFIG_DIR_ENV] ?? ""
  )
  const [sessionDir, setSessionDir] = useState(
    () => agent.env[PI_SESSION_DIR_ENV] ?? ""
  )
  const [validating, setValidating] = useState(false)
  const [validation, setValidation] = useState<PiValidation>(null)

  // Project-trust decisions recorded in pi's `trust.json`, listed for review.
  const [trustEntries, setTrustEntries] = useState<PiTrustEntry[] | null>(null)
  const [revoking, setRevoking] = useState<string | null>(null)

  const loadTrustEntries = useCallback(async () => {
    try {
      setTrustEntries(await acpPiListTrustEntries())
    } catch (error) {
      console.error("[Pi] list project trust failed", error)
      setTrustEntries([])
    }
  }, [])

  useEffect(() => {
    void loadTrustEntries()
  }, [loadTrustEntries])

  const handleRevokeTrust = useCallback(
    async (path: string) => {
      setRevoking(path)
      try {
        await acpPiSetProjectTrust(path, null)
        await loadTrustEntries()
      } catch (error) {
        console.error("[Pi] revoke project trust failed", error)
        toast.error(t("toasts.savePiTrustFailed"))
      } finally {
        setRevoking(null)
      }
    },
    [loadTrustEntries, t]
  )

  const handleValidate = useCallback(async () => {
    const cmd = command.trim()
    if (!cmd) return
    setValidating(true)
    setValidation(null)
    try {
      setValidation(await acpValidatePiCommand(cmd))
    } catch (error) {
      console.error("[Pi] validate command failed", error)
      setValidation({ found: false, resolvedPath: null, version: null })
    } finally {
      setValidating(false)
    }
  }, [command])

  const customIncomplete = mode === "custom" && !command.trim()

  const handleSaveRuntime = useCallback(async () => {
    const env = buildPiRuntimeEnv(
      agent.env,
      mode,
      command,
      configDir,
      sessionDir
    )
    try {
      await onSaveEnv(env, agent.enabled)
      toast.success(t("toasts.piRuntimeSaved"))
    } catch (error) {
      console.error("[Pi] save runtime failed", error)
      toast.error(t("toasts.savePiRuntimeFailed"))
    }
  }, [
    agent.env,
    agent.enabled,
    mode,
    command,
    configDir,
    sessionDir,
    onSaveEnv,
    t,
  ])

  return (
    <div className="space-y-4">
      {/* Runtime — which pi binary pi-acp spawns. "Default pi" manages the
          global pi on PATH (install XOR uninstall, never both); "Custom pi"
          points at your own build. */}
      <div className="space-y-3 rounded-md border bg-muted/10 p-3">
        <div>
          <label className="flex items-center gap-1.5 text-xs font-medium">
            <Cpu className="h-3.5 w-3.5 text-muted-foreground" />
            {t("pi.runtimeTitle")}
          </label>
          <p className="mt-1 text-2xs text-muted-foreground">
            {t("pi.runtimeDescription")}
          </p>
        </div>

        <RadioGroup
          value={mode}
          onValueChange={(value) => setMode(value as PiRuntimeMode)}
          className="grid-cols-2"
        >
          <label
            htmlFor="pi-mode-default"
            className={cn(
              "flex cursor-pointer items-start gap-2 rounded-md border p-2.5 text-2xs",
              mode === "default"
                ? "border-primary bg-primary/5"
                : "border-input"
            )}
          >
            <RadioGroupItem
              value="default"
              id="pi-mode-default"
              className="mt-0.5"
            />
            <span>
              <span className="block font-medium text-foreground">
                {t("pi.modeDefault")}
              </span>
              <span className="mt-0.5 block text-muted-foreground">
                {t("pi.modeDefaultHint")}
              </span>
            </span>
          </label>
          <label
            htmlFor="pi-mode-custom"
            className={cn(
              "flex cursor-pointer items-start gap-2 rounded-md border p-2.5 text-2xs",
              mode === "custom" ? "border-primary bg-primary/5" : "border-input"
            )}
          >
            <RadioGroupItem
              value="custom"
              id="pi-mode-custom"
              className="mt-0.5"
            />
            <span>
              <span className="block font-medium text-foreground">
                {t("pi.modeCustom")}
              </span>
              <span className="mt-0.5 block text-muted-foreground">
                {t("pi.modeCustomHint")}
              </span>
            </span>
          </label>
        </RadioGroup>

        {/* Default pi → status of the global `pi`, with a single contextual
            action: Install when missing, Uninstall when present (never both). */}
        {mode === "default" && (
          <div className="space-y-2.5 rounded-md border border-dashed p-2.5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1 text-2xs">
                {checkingPi ? (
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {t("pi.binaryChecking")}
                  </span>
                ) : piStatus?.found ? (
                  <span className="flex items-start gap-1.5 text-emerald-600">
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0">
                      <span className="font-medium">
                        {t("pi.binaryInstalled")}
                      </span>
                      {piStatus.version ? ` · ${piStatus.version}` : ""}
                      {piStatus.resolvedPath ? (
                        <span className="mt-0.5 block break-all text-muted-foreground">
                          {piStatus.resolvedPath}
                        </span>
                      ) : null}
                    </span>
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <XCircle className="h-3.5 w-3.5 shrink-0" />
                    {t("pi.binaryMissing")}
                  </span>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={detectPiBinary}
                  disabled={checkingPi || piOp !== null}
                  title={t("pi.recheck")}
                  className="h-7 px-2"
                >
                  <RotateCw
                    className={cn("h-3.5 w-3.5", checkingPi && "animate-spin")}
                  />
                </Button>
                {!checkingPi &&
                  (piStatus?.found ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleUninstallPi}
                      disabled={piOp !== null}
                      className="gap-1.5"
                    >
                      {piOp === "uninstall" ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          {t("actions.uninstalling")}
                        </>
                      ) : (
                        <>
                          <Trash2 className="h-3.5 w-3.5" />
                          {t("actions.uninstall")}
                        </>
                      )}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      onClick={handleInstallPi}
                      disabled={piOp !== null}
                      className="gap-1.5"
                    >
                      {piOp === "install" ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          {t("pi.installing")}
                        </>
                      ) : (
                        <>
                          <Download className="h-3.5 w-3.5" />
                          {t("pi.installBinary")}
                        </>
                      )}
                    </Button>
                  ))}
              </div>
            </div>

            {piInstallStatus !== "idle" && (
              <div className="max-h-[12.5rem] overflow-y-auto rounded-md border bg-muted/50 p-3 font-mono text-2xs leading-relaxed text-muted-foreground">
                {piInstallLogs.map((line, i) => (
                  <div
                    key={i}
                    className={
                      line.startsWith("ERROR:") ? "text-destructive" : ""
                    }
                  >
                    {line}
                  </div>
                ))}
                <div ref={installLogEndRef} />
              </div>
            )}
          </div>
        )}

        {/* Custom pi → bring your own build / wrapper. */}
        {mode === "custom" && (
          <>
            <div className="space-y-1.5">
              <label className="text-2xs text-muted-foreground">
                {t("pi.commandLabel")}
              </label>
              <div className="flex items-center gap-2">
                <Input
                  value={command}
                  onChange={(event) => {
                    setCommand(event.target.value)
                    setValidation(null)
                  }}
                  placeholder="/path/to/pi · pi · ./pi-test.sh"
                  spellCheck={false}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleValidate}
                  disabled={validating || !command.trim()}
                  className="gap-1.5 whitespace-nowrap"
                >
                  {validating ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <TerminalSquare className="h-3.5 w-3.5" />
                  )}
                  {t("pi.validate")}
                </Button>
              </div>
              {validation && (
                <p
                  className={cn(
                    "flex items-start gap-1.5 text-2xs",
                    validation.found ? "text-emerald-600" : "text-destructive"
                  )}
                >
                  {validation.found ? (
                    <>
                      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span className="break-all">
                        {validation.resolvedPath}
                        {validation.version ? ` (${validation.version})` : ""}
                      </span>
                    </>
                  ) : (
                    <>
                      <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      {t("pi.commandNotFound")}
                    </>
                  )}
                </p>
              )}
              <p className="text-2xs text-muted-foreground">
                {t("pi.commandHint")}
              </p>
            </div>

            <details className="rounded-md border border-dashed">
              <summary className="cursor-pointer list-none px-2.5 py-1.5 text-2xs font-medium text-muted-foreground">
                {t("pi.advanced")}
              </summary>
              <div className="space-y-2.5 px-2.5 pb-2.5">
                <div className="space-y-1.5">
                  <label className="text-2xs text-muted-foreground">
                    {t("pi.configDirLabel")}
                  </label>
                  <Input
                    value={configDir}
                    onChange={(event) => setConfigDir(event.target.value)}
                    placeholder="~/.pi/agent"
                    spellCheck={false}
                  />
                  {configDir.trim() !== "" && (
                    <p className="text-2xs text-amber-600 dark:text-amber-400">
                      {t("pi.configDirSkillsNote")}
                    </p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <label className="text-2xs text-muted-foreground">
                    {t("pi.sessionDirLabel")}
                  </label>
                  <Input
                    value={sessionDir}
                    onChange={(event) => setSessionDir(event.target.value)}
                    placeholder="~/.pi/agent/sessions"
                    spellCheck={false}
                  />
                </div>
                {/*
                  Both dirs persist to the per-agent `env_json`, which is injected
                  into the spawned pi child and nowhere else — while the history
                  parser resolves pi's sessions directory from codeg's OWN process
                  environment. So a custom dir here splits the two: pi writes and
                  resumes fine, and the sessions never show up in the list. Saying
                  so beats letting the user discover it as missing history.
                */}
                {(configDir.trim() !== "" || sessionDir.trim() !== "") && (
                  <p className="text-2xs text-amber-600 dark:text-amber-400">
                    {t("pi.dirHistoryNote")}
                  </p>
                )}
                <p className="text-2xs text-muted-foreground">
                  {t("pi.flagsHint")}
                </p>
              </div>
            </details>
          </>
        )}

        <div className="flex items-center justify-between gap-2">
          <span className="text-2xs text-muted-foreground">
            {customIncomplete ? t("pi.customIncomplete") : ""}
          </span>
          <Button
            type="button"
            size="sm"
            onClick={handleSaveRuntime}
            disabled={saving || customIncomplete}
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
                {t("pi.saveRuntime")}
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Credentials / model — pi's native settings.json / auth.json */}
      <div className="space-y-3 rounded-md border bg-muted/10 p-3">
        <div>
          <label className="flex items-center gap-1.5 text-xs font-medium">
            <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
            {t("pi.configManagement")}
          </label>
          <p className="mt-1 text-2xs text-muted-foreground">
            {t("pi.configDescription")}
          </p>
        </div>

        <div className="space-y-1.5">
          <label className="text-2xs text-muted-foreground">
            {t("pi.providerLabel")}
          </label>
          <Select
            value={selectedProvider}
            onValueChange={handleProviderChange}
            disabled={savingCreds || loadingCreds}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder={t("pi.providerPlaceholder")} />
            </SelectTrigger>
            <SelectContent align="start">
              <SelectItem value={PI_CUSTOM_SENTINEL}>
                {t("pi.customProvider")}
              </SelectItem>
              <SelectSeparator />
              {providerOptions.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {isCustom && (
          <div className="space-y-2.5 rounded-md border border-dashed p-2.5">
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <label className="text-2xs text-muted-foreground">
                  {t("pi.providerIdLabel")}
                </label>
                <Input
                  value={customId}
                  onChange={(event) => setCustomId(event.target.value)}
                  placeholder="my-provider"
                  spellCheck={false}
                  disabled={savingCreds || loadingCreds}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-2xs text-muted-foreground">
                  {t("pi.apiProtocolLabel")}
                </label>
                <Select
                  value={customApi}
                  onValueChange={setCustomApi}
                  disabled={savingCreds || loadingCreds}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="start">
                    {PI_CUSTOM_API_PROTOCOLS.map((api) => (
                      <SelectItem key={api} value={api}>
                        {api}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-2xs text-muted-foreground">
                {t("pi.baseUrlLabel")}
              </label>
              <Input
                value={customBaseUrl}
                onChange={(event) => setCustomBaseUrl(event.target.value)}
                placeholder="https://api.example.com/v1"
                spellCheck={false}
                disabled={savingCreds || loadingCreds}
              />
            </div>
            <p className="text-2xs text-muted-foreground">
              {t("pi.customProviderHint")}
            </p>
          </div>
        )}

        <div className="space-y-1.5">
          <label className="text-2xs text-muted-foreground">
            {t("pi.modelLabel")}
          </label>
          <Input
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder="claude-sonnet-5"
            spellCheck={false}
            disabled={savingCreds || loadingCreds}
          />
        </div>

        {/* ---- Reasoning card ----
            pi reads `reasoning: modelDef.reasoning ?? false`, and an undeclared
            model gets `["off"]` as its whole thinking vocabulary — so every level
            the composer sends is clamped back and the picker snaps to Off. Only
            custom providers need this: a built-in model carries pi's own, more
            accurate declaration. */}
        {isCustom && (
          <div className="space-y-2 rounded-md border bg-background/60 p-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-2xs font-medium">
                {t("pi.reasoningTitle")}
              </span>
              <label className="flex cursor-pointer items-center gap-1.5 text-2xs text-muted-foreground">
                <Switch
                  checked={reasoning.enabled}
                  onCheckedChange={(checked) =>
                    setReasoning((prev) => ({
                      ...prev,
                      enabled: checked,
                      // First enable with nothing remembered → offer pi's whole
                      // vocabulary bar xhigh, which most backends reject.
                      levels:
                        checked && prev.levels.length === 0
                          ? PI_THINKING_LEVELS.filter(
                              (level) => level !== "xhigh"
                            )
                          : prev.levels,
                    }))
                  }
                  disabled={savingCreds || loadingCreds}
                  aria-label={t("pi.reasoningEnableLabel")}
                />
                {t("pi.reasoningEnableLabel")}
              </label>
            </div>
            <p className="text-3xs text-muted-foreground">
              {t("pi.reasoningDescription")}
            </p>

            {reasoning.enabled && (
              <>
                <div className="space-y-1">
                  <label className="text-2xs text-muted-foreground">
                    {t("pi.levelsLabel")}
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {PI_THINKING_LEVELS.map((level) => {
                      const active = reasoning.levels.includes(level)
                      return (
                        <button
                          key={level}
                          type="button"
                          disabled={savingCreds || loadingCreds}
                          onClick={() =>
                            setReasoning((prev) => ({
                              ...prev,
                              levels: toggleLevel(prev.levels, level),
                            }))
                          }
                          aria-pressed={active}
                          className={cn(
                            "rounded-full border px-2 py-0.5 font-mono text-2xs transition-colors",
                            active
                              ? "border-primary/40 bg-primary/10 text-foreground"
                              : "border-border text-muted-foreground hover:bg-muted"
                          )}
                        >
                          {level}
                        </button>
                      )
                    })}
                  </div>
                  <p className="text-3xs text-muted-foreground">
                    {reasoning.levels.length === 0
                      ? t("pi.levelsEmptyError")
                      : t("pi.levelsHint")}
                  </p>
                </div>

                {reasoning.levels.length > 0 && (
                  <div className="space-y-1">
                    <button
                      type="button"
                      onClick={() => setShowWireValues((prev) => !prev)}
                      className="text-2xs text-muted-foreground hover:text-foreground"
                    >
                      {showWireValues ? "▾ " : "▸ "}
                      {t("pi.wireValuesTitle")}
                    </button>
                    {showWireValues && (
                      <div className="space-y-1.5 rounded-md border border-dashed p-2">
                        {reasoning.levels.map((level) => (
                          <div key={level} className="flex items-center gap-2">
                            <span className="w-16 shrink-0 font-mono text-2xs text-muted-foreground">
                              {level}
                            </span>
                            <Input
                              value={reasoning.wireValues[level] ?? ""}
                              onChange={(event) =>
                                setReasoning((prev) => ({
                                  ...prev,
                                  wireValues: {
                                    ...prev.wireValues,
                                    [level]: event.target.value,
                                  },
                                }))
                              }
                              placeholder={implicitWireValue(level)}
                              spellCheck={false}
                              className="h-7 font-mono text-xs"
                              aria-label={`${t("pi.wireValuesTitle")}: ${level}`}
                              disabled={savingCreds || loadingCreds}
                            />
                          </div>
                        ))}
                        <p className="text-3xs text-muted-foreground">
                          {t("pi.wireValuesHint")}
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <div className="space-y-1.5">
          <label className="text-2xs text-muted-foreground">
            {t("pi.thinkingLabel")}
          </label>
          <Select
            value={effectiveThinkingLevel || "off"}
            onValueChange={(value) => setThinkingLevel(value)}
            // A model with no reasoning has exactly one reachable level, so the
            // control would be a lie.
            disabled={
              savingCreds || loadingCreds || (isCustom && !reasoning.enabled)
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="start">
              {availableLevels.map((level) => (
                <SelectItem key={level} value={level}>
                  {t(`pi.thinking.${level}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {defaultLevelUnlisted && (
            <p className="text-2xs text-destructive">
              {t("pi.defaultLevelUnlisted")}
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <label className="text-2xs text-muted-foreground">
            {t("pi.apiKeyLabel")}
          </label>
          <div className="flex items-center gap-2">
            <Input
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={
                providerHasKey ? t("pi.apiKeySetPlaceholder") : "sk-..."
              }
              disabled={savingCreds || loadingCreds}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowKey((prev) => !prev)}
              title={
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
          <p className="text-2xs text-muted-foreground">{t("pi.apiKeyHint")}</p>
        </div>

        <div className="flex justify-end">
          <Button
            type="button"
            size="sm"
            onClick={handleSaveCreds}
            disabled={savingCreds || loadingCreds || credsIncomplete}
            className="gap-1.5"
          >
            {savingCreds ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t("actions.saving")}
              </>
            ) : (
              <>
                <Save className="h-3.5 w-3.5" />
                {t("pi.saveConfig")}
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Project trust — review/revoke the decisions in pi's trust.json.
          A trusted folder lets that repo's `.pi/extensions` run at pi startup,
          and the decision is inherited by every folder beneath it and honored by
          the standalone `pi` CLI too, so it is worth being able to audit. Older
          codeg builds auto-trusted every opened workspace; those entries are
          indistinguishable from ones made inside pi, so they are listed for
          review rather than pruned automatically. */}
      <div className="space-y-2 rounded-md border bg-muted/10 p-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-xs font-medium">
            <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />
            {t("pi.projectTrustTitle")}
          </div>
          <p className="mt-1 text-2xs text-muted-foreground">
            {t("pi.projectTrustDescription")}
          </p>
        </div>

        {trustEntries === null ? (
          <p className="text-2xs text-muted-foreground">
            {t("pi.projectTrustLoading")}
          </p>
        ) : trustEntries.length === 0 ? (
          <p className="text-2xs text-muted-foreground">
            {t("pi.projectTrustEmpty")}
          </p>
        ) : (
          <ul className="space-y-1">
            {trustEntries.map((entry) => (
              <li
                key={entry.path}
                className="flex items-center gap-2 rounded border bg-background/60 px-2 py-1.5"
              >
                <span
                  className={cn(
                    "shrink-0 rounded px-1.5 py-0.5 text-3xs font-medium",
                    entry.trusted
                      ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                      : "bg-muted text-muted-foreground"
                  )}
                >
                  {entry.trusted
                    ? t("pi.projectTrustTrusted")
                    : t("pi.projectTrustDenied")}
                </span>
                <span
                  className="min-w-0 flex-1 truncate font-mono text-2xs"
                  title={entry.path}
                >
                  {entry.path}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 shrink-0 px-2 text-2xs"
                  disabled={revoking === entry.path}
                  onClick={() => void handleRevokeTrust(entry.path)}
                >
                  {revoking === entry.path ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    t("pi.projectTrustRevoke")
                  )}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
