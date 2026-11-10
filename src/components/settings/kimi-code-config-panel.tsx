"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { useImeGuard } from "@/hooks/use-ime-guard"
import { useProviderModels } from "@/hooks/use-provider-models"
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  EyeOff,
  FolderOpen,
  Loader2,
  Plus,
  Save,
  XCircle,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  ModelIdInputWithFetch,
  useProviderModelsErrorText,
} from "@/components/settings/provider-models"
import { acpUpdateKimiCodeConfig } from "@/lib/api"
import { isLocalDesktop, revealItemInDir } from "@/lib/platform"
import type { AcpAgentInfo, ProviderModelsProtocol } from "@/lib/types"
import { cn } from "@/lib/utils"

const KIMI_BASE_URL_INTERNATIONAL = "https://api.moonshot.ai/v1"
const KIMI_BASE_URL_CHINA = "https://api.moonshot.cn/v1"
/** Placeholder model id (a real Moonshot coding model) for the model input. */
const KIMI_MODEL_PLACEHOLDER = "kimi-k2.7-code"

/**
 * Fallback context window, mirroring the backend's `KIMI_DEFAULT_MAX_CONTEXT_SIZE`.
 * Kimi's schema **requires** `[models.<alias>].max_context_size`: omitting it makes
 * kimi discard the whole model block, leaving `default_model` dangling so every
 * prompt ends with no reply. The backend substitutes this silently — the panel
 * pre-fills it instead, so the number the user sees is the number that gets written.
 */
export const KIMI_DEFAULT_MAX_CONTEXT = 262_144

/**
 * Context windows documented for the models Kimi ships in its own config example.
 * Used ONLY to auto-fill the max-context field on an exact model-id match — never
 * as the model picker's contents. These ids belong to the subscription-managed
 * endpoint and do NOT overlap the Moonshot open-platform naming (kimi-k2.7-code,
 * moonshot-v1-*), so anything unrecognized keeps whatever is already in the field.
 */
export const KIMI_MODEL_CONTEXT_PRESETS: Record<string, number> = {
  k3: 1_048_576,
  "kimi-for-coding": 262_144,
  "kimi-for-coding-highspeed": 262_144,
}

/** The documented context window for `modelId`, or null when unrecognized. */
export function kimiMaxContextForModel(modelId: string): number | null {
  return KIMI_MODEL_CONTEXT_PRESETS[modelId.trim()] ?? null
}

/**
 * Kimi credential mode. `apikey` writes a codeg-managed config.toml provider/model
 * block AND seeds a synthetic gate token, so the API key actually authenticates
 * `kimi acp` — whose session gate only checks for a stored token and rejects an
 * API key on its own. `login` clears the managed block and removes our synthetic
 * token so a real OAuth login (`kimi login`, needs a Kimi subscription) governs.
 * Exactly one is authoritative — saving clears the rest. A raw config.toml editor
 * is the escape hatch.
 */
export type KimiAuthMode = "apikey" | "login"
/** The six provider `type` values Kimi's config.toml `[providers]` accepts. */
export type KimiInterfaceType =
  | "kimi"
  | "openai"
  | "openai_responses"
  | "anthropic"
  | "google-genai"
  | "vertexai"
/** Native-provider credential placement: inline `api_key` vs the env sub-table. */
export type KimiNativeAuthType = "api_key" | "env"
/** Env-mode endpoint: the two Moonshot regions or a custom OpenAI-compatible URL. */
export type KimiEndpointRegion = "international" | "china" | "custom"

export interface KimiInterfaceTypeMeta {
  value: KimiInterfaceType
  /** Product label (proper noun — intentionally not localized). */
  label: string
  /** Base URL pre-filled when this interface is selected ("" → SDK default). */
  defaultBaseUrl: string
  /** vertexai authenticates via GCP ADC, so it exposes no API key field. */
  usesApiKey: boolean
  /** Whether a base URL is mandatory (an OpenAI-compatible endpoint has no
   * usable SDK default; the Anthropic/Google SDKs do). */
  requiresBaseUrl: boolean
  /** How the provider lists its models, for a type that takes an API key. */
  modelsProtocol: ProviderModelsProtocol | null
  /** Where the type's SDK goes when the base URL is left blank. */
  sdkBaseUrl: string
}

export const KIMI_INTERFACE_TYPES: KimiInterfaceTypeMeta[] = [
  {
    value: "kimi",
    label: "Kimi / Moonshot",
    defaultBaseUrl: KIMI_BASE_URL_INTERNATIONAL,
    usesApiKey: true,
    requiresBaseUrl: false,
    modelsProtocol: "openai",
    sdkBaseUrl: KIMI_BASE_URL_INTERNATIONAL,
  },
  {
    value: "openai",
    label: "OpenAI (Chat Completions)",
    defaultBaseUrl: "https://api.openai.com/v1",
    usesApiKey: true,
    requiresBaseUrl: true,
    modelsProtocol: "openai",
    sdkBaseUrl: "",
  },
  {
    value: "openai_responses",
    label: "OpenAI (Responses)",
    defaultBaseUrl: "https://api.openai.com/v1",
    usesApiKey: true,
    requiresBaseUrl: true,
    modelsProtocol: "openai",
    sdkBaseUrl: "",
  },
  {
    value: "anthropic",
    label: "Anthropic",
    defaultBaseUrl: "",
    usesApiKey: true,
    requiresBaseUrl: false,
    modelsProtocol: "anthropic",
    sdkBaseUrl: "https://api.anthropic.com",
  },
  {
    value: "google-genai",
    label: "Google Gemini",
    defaultBaseUrl: "",
    usesApiKey: true,
    requiresBaseUrl: false,
    modelsProtocol: "gemini",
    sdkBaseUrl: "https://generativelanguage.googleapis.com",
  },
  {
    value: "vertexai",
    label: "Google Vertex AI",
    defaultBaseUrl: "",
    usesApiKey: false,
    requiresBaseUrl: false,
    modelsProtocol: null,
    sdkBaseUrl: "",
  },
]

export function kimiInterfaceMeta(
  type: KimiInterfaceType
): KimiInterfaceTypeMeta {
  return (
    KIMI_INTERFACE_TYPES.find((meta) => meta.value === type) ??
    KIMI_INTERFACE_TYPES[0]
  )
}

/**
 * Region implied by an env-mode base URL: `.cn` → china, `.ai` or empty →
 * international, any other non-empty endpoint → custom (an OpenAI-compatible
 * third party such as DeepSeek / OpenRouter / a local server).
 */
export function kimiEndpointRegionFromBaseUrl(
  baseUrl: string
): KimiEndpointRegion {
  const raw = baseUrl.trim().toLowerCase()
  if (!raw) return "international"
  if (raw.includes("moonshot.cn")) return "china"
  if (raw.includes("moonshot.ai")) return "international"
  return "custom"
}

export function kimiBaseUrlForRegion(
  region: KimiEndpointRegion,
  customUrl: string
): string {
  if (region === "china") return KIMI_BASE_URL_CHINA
  if (region === "custom") return customUrl.trim()
  return KIMI_BASE_URL_INTERNATIONAL
}

/**
 * Mirror of the backend `load_kimi_code_config_json` projection. Keys are
 * deliberately NOT `apiKey` / `apiBaseUrl` / `model` / `env` so the projected
 * config.toml block never leaks back into the `KIMI_MODEL_*` runtime env.
 */
export interface KimiManagedConfig {
  interfaceType?: KimiInterfaceType
  baseUrl?: string
  key?: string
  authType?: KimiNativeAuthType
  modelId?: string
  maxContextSize?: number
  vertexProject?: string
  vertexLocation?: string
  /** `[models.<alias>].capabilities`. Absent means kimi allows everything and
   * advertises no Thinking picker; present means only what it lists is allowed. */
  capabilities?: string[]
  supportEfforts?: string[]
  defaultEffort?: string
  hasManagedBlock?: boolean
  /** Whether `kimi acp`'s session gate is satisfied (a token file is present). */
  credentialPresent?: boolean
  /** Whether that gate token is codeg's synthetic one (vs a real OAuth login). */
  credentialSynthetic?: boolean
  rawConfigToml?: string
}

export function parseKimiManagedConfig(
  configJson: string | null | undefined
): KimiManagedConfig {
  if (!configJson || !configJson.trim()) return {}
  try {
    return JSON.parse(configJson) as KimiManagedConfig
  } catch {
    return {}
  }
}

/**
 * Initial panel mode: the codeg-managed API-key block wins; otherwise, when a
 * real (non-synthetic) OAuth login is already present, show login; else default
 * to the API-key form.
 */
export function kimiInitialMode(config: KimiManagedConfig): KimiAuthMode {
  if (config.hasManagedBlock) return "apikey"
  if (config.credentialPresent && !config.credentialSynthetic) return "login"
  return "apikey"
}

/** Capability tokens that make `kimi acp` advertise its Thinking picker. */
const KIMI_THINKING_CAPABILITY = "thinking"
const KIMI_ALWAYS_THINKING_CAPABILITY = "always_thinking"
/** Sentinel for "let kimi pick" in the default-effort Select (Radix rejects ""). */
const KIMI_EFFORT_UNSET = "__unset__"

/**
 * Reasoning levels offered as one-click chips. NOT an enum codeg enforces —
 * kimi forwards the string to the provider unmapped, so the right set depends
 * on the model. These cover what kimi itself ships: Anthropic's budget
 * (low/medium/high) and adaptive (+max) profiles, the latest-Opus profile
 * (+xhigh), and Kimi's own catalog (low/high/max). `minimal` is there for
 * OpenAI-compatible endpoints. Anything else goes in through the custom field.
 */
export const KIMI_COMMON_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]

/** Every editable value in the panel, in one object so the whole form can be
 * re-seeded from disk and diffed against it in one place. */
export interface KimiDraft {
  mode: KimiAuthMode
  interfaceType: KimiInterfaceType
  region: KimiEndpointRegion
  /** Editable endpoint for kimi+custom and for every non-kimi interface. */
  baseUrl: string
  authType: KimiNativeAuthType
  apiKey: string
  model: string
  /** Kept as a string so an in-progress edit ("26214") round-trips verbatim. */
  maxContext: string
  vertexProject: string
  vertexLocation: string
  /** Declares a thinking capability, which is the gate on kimi advertising the
   * composer's Thinking picker at all. Off ⇒ no `capabilities` key is written. */
  reasoningEnabled: boolean
  /** `always_thinking` rather than `thinking`: the picker loses its Off row. */
  alwaysThinking: boolean
  /** The levels the picker offers. Empty ⇒ kimi degrades it to Off/On. */
  supportEfforts: string[]
  defaultEffort: string
}

/**
 * The single seam that derives the whole form from the backend's config.toml
 * projection. Used three ways: initial state, re-seeding after a save landed on
 * disk, and as the baseline the current draft is diffed against for the
 * unsaved-changes badge. A blank `maxContextSize` materializes the backend's
 * silent fallback so the number on screen is the number that gets written.
 */
export function kimiDraftFromConfig(config: KimiManagedConfig): KimiDraft {
  const interfaceType = config.interfaceType ?? "kimi"
  const capabilities = config.capabilities ?? []
  const alwaysThinking = capabilities.includes(KIMI_ALWAYS_THINKING_CAPABILITY)
  return {
    mode: kimiInitialMode(config),
    interfaceType,
    region: kimiEndpointRegionFromBaseUrl(config.baseUrl ?? ""),
    baseUrl: config.baseUrl ?? kimiInterfaceMeta(interfaceType).defaultBaseUrl,
    authType: config.authType ?? "api_key",
    apiKey: config.key ?? "",
    model: config.modelId ?? "",
    maxContext: String(config.maxContextSize ?? KIMI_DEFAULT_MAX_CONTEXT),
    vertexProject: config.vertexProject ?? "",
    vertexLocation: config.vertexLocation ?? "",
    // Mirrors kimi's own `supportsThinking`: either capability turns the
    // composer's picker on, and `always_thinking` additionally drops its Off row.
    reasoningEnabled:
      capabilities.includes(KIMI_THINKING_CAPABILITY) || alwaysThinking,
    alwaysThinking,
    supportEfforts: config.supportEfforts ?? [],
    defaultEffort: config.defaultEffort ?? "",
  }
}

/** Field-by-field draft equality. Needed because `supportEfforts` is an array:
 * a plain `!==` would report every freshly-seeded form as dirty. */
export function kimiDraftEquals(a: KimiDraft, b: KimiDraft): boolean {
  return (Object.keys(a) as (keyof KimiDraft)[]).every((key) => {
    const left = a[key]
    const right = b[key]
    if (Array.isArray(left) && Array.isArray(right)) {
      return (
        left.length === right.length && left.every((v, i) => v === right[i])
      )
    }
    return left === right
  })
}

/** The i18n key suffixes (under `AcpAgentSettings.kimiCode`) a validation rule
 * can produce. Rules return these rather than sentences, so they stay
 * locale-free and unit-testable. */
export type KimiErrorKey =
  | "errorBaseUrlRequired"
  | "errorBaseUrlInvalid"
  | "errorApiKeyRequired"
  | "errorApiKeyInvalid"
  | "errorModelRequired"
  | "errorMaxContextRequired"
  | "errorMaxContextInvalid"
  | "errorVertexProjectRequired"
  | "errorDefaultEffortUnlisted"

export type KimiErrorField =
  | "defaultEffort"
  | "baseUrl"
  | "apiKey"
  | "model"
  | "maxContext"
  | "vertexProject"

export type KimiFieldErrors = Partial<Record<KimiErrorField, KimiErrorKey>>

/**
 * Validate the API-key form. Mirrors what `build_kimi_managed_spec` rejects
 * server-side (model required, no newlines in the key/URL) plus the two rules
 * the backend can only paper over: a positive integer context window, and a
 * base URL that the selected interface actually needs. Login mode has no
 * fields, so it never produces errors.
 */
export function validateKimiDraft(draft: KimiDraft): KimiFieldErrors {
  if (draft.mode !== "apikey") return {}
  const errors: KimiFieldErrors = {}
  const meta = kimiInterfaceMeta(draft.interfaceType)
  const isKimi = draft.interfaceType === "kimi"

  const effectiveBaseUrl = isKimi
    ? kimiBaseUrlForRegion(draft.region, draft.baseUrl)
    : draft.baseUrl.trim()
  const needsBaseUrl = isKimi ? draft.region === "custom" : meta.requiresBaseUrl
  if (needsBaseUrl && !effectiveBaseUrl) {
    errors.baseUrl = "errorBaseUrlRequired"
  } else if (effectiveBaseUrl && !/^https?:\/\/\S+$/i.test(effectiveBaseUrl)) {
    errors.baseUrl = "errorBaseUrlInvalid"
  }

  if (meta.usesApiKey) {
    const key = draft.apiKey.trim()
    if (!key) {
      errors.apiKey = "errorApiKeyRequired"
    } else if (/[\n\r]/.test(key)) {
      errors.apiKey = "errorApiKeyInvalid"
    }
  } else if (!draft.vertexProject.trim()) {
    errors.vertexProject = "errorVertexProjectRequired"
  }

  if (!draft.model.trim()) {
    errors.model = "errorModelRequired"
  }

  const rawContext = draft.maxContext.trim()
  if (!rawContext) {
    errors.maxContext = "errorMaxContextRequired"
  } else if (!/^\d+$/.test(rawContext) || Number.parseInt(rawContext, 10) < 1) {
    errors.maxContext = "errorMaxContextInvalid"
  }

  // A default outside the offered levels is silently clamped to the middle
  // entry by kimi, so the composer would open on a level the user never chose.
  if (
    draft.reasoningEnabled &&
    draft.defaultEffort.trim() &&
    draft.supportEfforts.length > 0 &&
    !draft.supportEfforts.includes(draft.defaultEffort.trim())
  ) {
    errors.defaultEffort = "errorDefaultEffortUnlisted"
  }

  return errors
}

/** The `KIMI_MODEL_*` env family, which `kimi acp` reads BEFORE config.toml —
 * so a leftover entry silently wins over everything this panel writes. Every
 * save clears them server-side (`clear_kimi_model_env`); the panel warns while
 * they are still present. */
const KIMI_MODEL_ENV_KEYS = [
  "KIMI_MODEL_BASE_URL",
  "KIMI_MODEL_API_KEY",
  "KIMI_MODEL_NAME",
]

/** Which of the overriding env vars are currently set on the agent. */
export function kimiOverridingEnvKeys(env: Record<string, string>): string[] {
  return KIMI_MODEL_ENV_KEYS.filter((key) => (env[key] ?? "").trim() !== "")
}

/** Human-readable one-line summary of what is actually on disk, or null when
 * no codeg-managed block exists. Built from the projection (never the draft) so
 * it always answers "what did my last save write?". */
export function kimiConfigSummary(config: KimiManagedConfig): string | null {
  if (!config.hasManagedBlock) return null
  const parts: string[] = [
    kimiInterfaceMeta(config.interfaceType ?? "kimi").label,
  ]
  if (config.baseUrl) parts.push(config.baseUrl)
  if (config.modelId) parts.push(config.modelId)
  parts.push(`${config.maxContextSize ?? KIMI_DEFAULT_MAX_CONTEXT} tokens`)
  return parts.join(" · ")
}

/**
 * Settings panel for Kimi Code (Moonshot AI).
 *
 * `kimi acp` gates every session on a stored OAuth-style token and rejects API
 * keys on their own, so to support API-key users codeg manages BOTH a
 * `~/.kimi-code/config.toml` provider/model block (routing inference to the key)
 * AND a synthetic gate token under `credentials/` (so the session opens). The
 * panel keeps exactly one source authoritative (enforced server-side by
 * `acpUpdateKimiCodeConfig`):
 *   • apikey — write the codeg-managed config.toml block (any of the six
 *     interface types) + seed the gate token. The working path for a plain key.
 *   • login — clear the managed block + remove our synthetic token, so a real
 *     OAuth login (`kimi login`, needs a Kimi subscription) governs.
 *
 * Layout follows the Cursor panel: a status card that reads BACK from disk, a
 * short credential card, a model card, and one collapsed advanced section
 * holding the credential-placement knob and the raw config.toml escape hatch.
 * Because the backend's three write modes are mutually exclusive, the raw
 * editor keeps its own overwrite button rather than merging into the main save.
 */
export function KimiCodeConfigPanel({
  agent,
  onSaved,
}: {
  agent: AcpAgentInfo
  onSaved: () => Promise<void>
}) {
  const t = useTranslations("AcpAgentSettings")
  const ime = useImeGuard()
  const config = useMemo(
    () => parseKimiManagedConfig(agent.config_json),
    [agent.config_json]
  )
  const savedDraft = useMemo(() => kimiDraftFromConfig(config), [config])

  const [draft, setDraft] = useState<KimiDraft>(savedDraft)
  const [saving, setSaving] = useState(false)
  const [showKey, setShowKey] = useState(false)
  /** Once the user edits the context window we stop auto-filling it from the
   * model, so a deliberate value is never silently replaced. */
  const [maxContextTouched, setMaxContextTouched] = useState(false)

  /** Free-text box for an effort level outside the common set. */
  const [customEffort, setCustomEffort] = useState("")

  // raw editor
  const [rawConfig, setRawConfig] = useState(() => config.rawConfigToml ?? "")

  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Re-seed the whole form whenever the projection changes — i.e. config.toml
  // actually changed on disk (our own save, or the raw editor rewriting the
  // file out from under the structured fields). Without this the structured
  // form keeps showing pre-save values after a raw overwrite.
  useEffect(() => {
    setDraft(savedDraft)
    setMaxContextTouched(false)
  }, [savedDraft])
  useEffect(() => {
    setRawConfig(config.rawConfigToml ?? "")
  }, [config.rawConfigToml])

  const patch = useCallback((next: Partial<KimiDraft>) => {
    setDraft((current) => ({ ...current, ...next }))
  }, [])

  const meta = kimiInterfaceMeta(draft.interfaceType)
  const isKimi = draft.interfaceType === "kimi"
  const isVertex = draft.interfaceType === "vertexai"
  // Resolved endpoint: kimi uses the region quick-select (custom falls back to
  // the editable field); other interfaces use the editable field directly.
  const effectiveBaseUrl = isKimi
    ? kimiBaseUrlForRegion(draft.region, draft.baseUrl)
    : draft.baseUrl.trim()

  // The provider's models (doubles as a key test), asked where and how the
  // interface's SDK itself would go — a blank URL is the SDK's default.
  const providerModels = useProviderModels(
    meta.usesApiKey && meta.modelsProtocol
      ? {
          protocol: meta.modelsProtocol,
          baseUrl: effectiveBaseUrl || meta.sdkBaseUrl,
          apiKey: draft.apiKey,
        }
      : null
  )
  const modelsErrorText = useProviderModelsErrorText()

  const errors = useMemo(() => validateKimiDraft(draft), [draft])
  const hasErrors = Object.keys(errors).length > 0
  const dirty = useMemo(
    () => !kimiDraftEquals(draft, savedDraft),
    [draft, savedDraft]
  )
  const overridingEnvKeys = useMemo(
    () => kimiOverridingEnvKeys(agent.env),
    [agent.env]
  )
  const summary = kimiConfigSummary(config)
  /** Three honest states: nothing written / written and in sync with the form /
   * edited since the last write. Deliberately NOT keyed on the gate token —
   * that file is seeded by every save and would always read "configured". */
  const status: "unconfigured" | "dirty" | "saved" = !config.hasManagedBlock
    ? config.credentialPresent && !config.credentialSynthetic
      ? "saved"
      : "unconfigured"
    : dirty
      ? "dirty"
      : "saved"

  const handleInterfaceChange = useCallback(
    (value: string) => {
      const next = value as KimiInterfaceType
      patch({
        interfaceType: next,
        // Pre-fill the documented default base URL for the new interface; kimi
        // drives its endpoint from the region quick-select instead.
        ...(next === "kimi"
          ? { region: "international" as KimiEndpointRegion, baseUrl: "" }
          : { baseUrl: kimiInterfaceMeta(next).defaultBaseUrl }),
      })
    },
    [patch]
  )

  /** Common levels plus any already-saved custom one, so a hand-written value
   * from config.toml still renders as a togglable chip instead of vanishing. */
  const effortChoices = useMemo(() => {
    const extra = draft.supportEfforts.filter(
      (effort) => !KIMI_COMMON_EFFORTS.includes(effort)
    )
    return [...KIMI_COMMON_EFFORTS, ...extra]
  }, [draft.supportEfforts])

  const toggleEffort = useCallback(
    (effort: string) => {
      setDraft((current) => {
        const on = current.supportEfforts.includes(effort)
        const supportEfforts = on
          ? current.supportEfforts.filter((e) => e !== effort)
          : // Keep the chip order stable rather than append-on-click, so the
            // written list reads low→high like kimi's own profiles.
            effortChoices.filter(
              (e) => e === effort || current.supportEfforts.includes(e)
            )
        return {
          ...current,
          supportEfforts,
          // Drop a default that just lost its level; kimi would clamp it anyway.
          defaultEffort: supportEfforts.includes(current.defaultEffort)
            ? current.defaultEffort
            : "",
        }
      })
    },
    [effortChoices]
  )

  const addCustomEffort = useCallback(() => {
    const effort = customEffort.trim()
    if (!effort) return
    setCustomEffort("")
    setDraft((current) =>
      current.supportEfforts.includes(effort)
        ? current
        : { ...current, supportEfforts: [...current.supportEfforts, effort] }
    )
  }, [customEffort])

  const handleModelChange = useCallback(
    (value: string) => {
      const preset =
        kimiMaxContextForModel(value) ??
        providerModels.models.find((m) => m.id === value.trim())
          ?.contextWindow ??
        null
      patch({
        model: value,
        // Auto-fill the documented window for a recognized model, unless the
        // user has already set the field by hand.
        ...(preset != null && !maxContextTouched
          ? { maxContext: String(preset) }
          : {}),
      })
    },
    [maxContextTouched, patch, providerModels.models]
  )

  const runSave = useCallback(
    async (params: Parameters<typeof acpUpdateKimiCodeConfig>[0]) => {
      setSaving(true)
      try {
        await acpUpdateKimiCodeConfig(params)
        await onSaved()
        toast.success(t("toasts.kimiCodeSaved"))
      } catch (error) {
        console.error("[KimiCode] save config failed", error)
        // Surface the backend's own message — "requires a model id", "invalid
        // config.toml: …" — instead of a generic failure the user can't act on.
        toast.error(
          `${t("toasts.saveKimiCodeFailed")}: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      } finally {
        if (mountedRef.current) setSaving(false)
      }
    },
    [onSaved, t]
  )

  const handleSave = useCallback(() => {
    if (draft.mode === "login") {
      void runSave({ mode: "login" })
      return
    }
    if (hasErrors) {
      toast.error(t("kimiCode.fixErrorsFirst"))
      return
    }
    void runSave({
      mode: "apikey",
      interfaceType: draft.interfaceType,
      authType: meta.usesApiKey ? draft.authType : null,
      baseUrl: effectiveBaseUrl,
      apiKey: meta.usesApiKey ? draft.apiKey : null,
      model: draft.model,
      maxContextSize: Number.parseInt(draft.maxContext, 10),
      // Off sends `false` and no levels, so the backend omits `capabilities`
      // entirely and kimi keeps its permissive default.
      reasoningEnabled: draft.reasoningEnabled,
      alwaysThinking: draft.reasoningEnabled && draft.alwaysThinking,
      supportEfforts: draft.reasoningEnabled ? draft.supportEfforts : [],
      defaultEffort: draft.reasoningEnabled ? draft.defaultEffort : null,
      vertexProject: isVertex ? draft.vertexProject : null,
      vertexLocation: isVertex ? draft.vertexLocation : null,
    })
  }, [draft, meta, effectiveBaseUrl, isVertex, hasErrors, runSave, t])

  const handleSaveRaw = useCallback(() => {
    void runSave({ mode: "raw", rawConfigToml: rawConfig })
  }, [rawConfig, runSave])

  const fetchedModels = providerModels.models
  /** The exact "Not found the model …" trap: a key that works, listing models
   * that don't include the one about to be written. */
  const modelUnlisted =
    providerModels.list != null &&
    fetchedModels.length > 0 &&
    draft.model.trim() !== "" &&
    !fetchedModels.some((m) => m.id === draft.model.trim())

  const configPath = agent.config_file_path
  const canReveal = configPath != null && isLocalDesktop()

  // next-intl only accepts literal message keys, so the rule-key union is
  // resolved through an explicit table rather than a template literal.
  const errorText: Record<KimiErrorKey, string> = {
    errorBaseUrlRequired: t("kimiCode.errorBaseUrlRequired"),
    errorBaseUrlInvalid: t("kimiCode.errorBaseUrlInvalid"),
    errorApiKeyRequired: t("kimiCode.errorApiKeyRequired"),
    errorApiKeyInvalid: t("kimiCode.errorApiKeyInvalid"),
    errorModelRequired: t("kimiCode.errorModelRequired"),
    errorMaxContextRequired: t("kimiCode.errorMaxContextRequired"),
    errorMaxContextInvalid: t("kimiCode.errorMaxContextInvalid"),
    errorVertexProjectRequired: t("kimiCode.errorVertexProjectRequired"),
    errorDefaultEffortUnlisted: t("kimiCode.errorDefaultEffortUnlisted"),
  }

  /** Inline error line for a field, or null. */
  const fieldError = (field: KimiErrorField) => {
    const key = errors[field]
    if (!key) return null
    return <p className="text-2xs text-destructive">{errorText[key]}</p>
  }

  /** The endpoint field, shared by the non-kimi interfaces (inside the grid)
   * and by kimi's "custom" region (full-width below it). */
  const baseUrlField = (
    <div className="space-y-1">
      <label
        className="text-2xs text-muted-foreground"
        htmlFor="kimi-base-url-input"
        title={t("kimiCode.baseUrlHint")}
      >
        {t("kimiCode.baseUrlLabel")}
      </label>
      <Input
        id="kimi-base-url-input"
        value={draft.baseUrl}
        onChange={(event) => patch({ baseUrl: event.target.value })}
        placeholder="https://api.example.com/v1"
        disabled={saving}
        aria-invalid={errors.baseUrl != null}
      />
    </div>
  )

  return (
    <div className="space-y-3 rounded-md border bg-muted/10 p-3">
      <div>
        <label className="text-xs font-medium">
          {t("kimiCode.configManagement")}
        </label>
        <p className="mt-1 text-2xs text-muted-foreground">
          {t("kimiCode.configDescription")}
        </p>
      </div>

      {/* ---- Status card: everything here is read BACK from config.toml ---- */}
      <div className="space-y-2 rounded-md border bg-background/60 p-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                "inline-flex h-2 w-2 shrink-0 rounded-full",
                status === "saved" && "bg-emerald-500",
                status === "dirty" && "bg-amber-500",
                status === "unconfigured" && "bg-muted-foreground/40"
              )}
            />
            {/* The label always describes DISK, never the form — the badge on
                the right is what reports unsaved edits. */}
            <span className="text-2xs font-medium">
              {status === "unconfigured"
                ? t("kimiCode.statusUnconfigured")
                : config.hasManagedBlock
                  ? t("kimiCode.gateReadyApiKey")
                  : t("kimiCode.gateReadyLogin")}
            </span>
          </div>
          {dirty && (
            <span className="shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 text-3xs text-amber-700 dark:text-amber-400">
              {t("kimiCode.statusDirty")}
            </span>
          )}
        </div>

        {summary && (
          <p className="text-2xs break-all text-muted-foreground">
            <span className="font-medium">{t("kimiCode.summaryLabel")}</span>
            {": "}
            {summary}
          </p>
        )}

        {configPath && (
          <div className="flex items-center gap-1.5">
            <code className="flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-3xs">
              {configPath}
            </code>
            {canReveal && (
              <Button
                className="h-6 gap-1 px-2 text-2xs"
                onClick={() => void revealItemInDir(configPath)}
                size="sm"
                type="button"
                variant="ghost"
              >
                <FolderOpen className="h-3 w-3" />
                {t("kimiCode.revealConfig")}
              </Button>
            )}
          </div>
        )}

        {overridingEnvKeys.length > 0 && (
          <p className="flex items-start gap-1.5 text-2xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            <span>
              {t("kimiCode.envOverrideWarning", {
                keys: overridingEnvKeys.join(", "),
              })}
            </span>
          </p>
        )}

        {providerModels.list && (
          <p className="flex items-start gap-1.5 text-2xs text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0" />
            <span>
              {fetchedModels.length > 0
                ? t("kimiCode.fetchModelsOk", { count: fetchedModels.length })
                : t("kimiCode.fetchModelsEmpty")}
            </span>
          </p>
        )}
        {providerModels.error && (
          <p className="flex items-start gap-1.5 text-2xs text-destructive">
            <XCircle className="mt-0.5 h-3 w-3 shrink-0" />
            <span className="break-all">
              {t("kimiCode.fetchModelsFailed")}:{" "}
              {modelsErrorText(providerModels.error)}
            </span>
          </p>
        )}
      </div>

      {/* ---- Authentication method ---- */}
      <div className="space-y-1.5">
        <label className="text-2xs text-muted-foreground">
          {t("kimiCode.authModeLabel")}
        </label>
        <Select
          value={draft.mode}
          onValueChange={(value) => patch({ mode: value as KimiAuthMode })}
          disabled={saving}
        >
          <SelectTrigger
            className="w-full"
            aria-label={t("kimiCode.authModeLabel")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start">
            <SelectItem value="apikey">
              {t("kimiCode.authModeApiKey")}
            </SelectItem>
            <SelectItem value="login">{t("kimiCode.authModeLogin")}</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-2xs text-muted-foreground">
          {draft.mode === "apikey"
            ? t("kimiCode.authModeApiKeyHint")
            : t("kimiCode.loginHint")}
        </p>
      </div>

      {draft.mode === "apikey" && (
        <>
          {/* ---- Credential card ---- */}
          <div className="space-y-2 rounded-md border bg-background/60 p-2.5">
            <span className="text-2xs font-medium">
              {t("kimiCode.credentialTitle")}
            </span>

            <div className="grid gap-2 md:grid-cols-2">
              <div className="space-y-1">
                <label
                  className="text-2xs text-muted-foreground"
                  title={t("kimiCode.interfaceTypeHint")}
                >
                  {t("kimiCode.interfaceTypeLabel")}
                </label>
                <Select
                  value={draft.interfaceType}
                  onValueChange={handleInterfaceChange}
                  disabled={saving}
                >
                  <SelectTrigger
                    className="w-full"
                    aria-label={t("kimiCode.interfaceTypeLabel")}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="start">
                    {KIMI_INTERFACE_TYPES.map((it) => (
                      <SelectItem key={it.value} value={it.value}>
                        {it.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Kimi drives its endpoint from the region quick-select; the
                  other interfaces take a URL directly. The kimi+custom case
                  falls through to the same field, rendered full-width below. */}
              {isKimi ? (
                <div className="space-y-1">
                  <label
                    className="text-2xs text-muted-foreground"
                    title={t("kimiCode.endpointHint")}
                  >
                    {t("kimiCode.endpointLabel")}
                  </label>
                  <Select
                    value={draft.region}
                    onValueChange={(value) =>
                      patch({ region: value as KimiEndpointRegion })
                    }
                    disabled={saving}
                  >
                    <SelectTrigger
                      className="w-full"
                      aria-label={t("kimiCode.endpointLabel")}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent align="start">
                      <SelectItem value="international">
                        {t("kimiCode.regionInternational")}
                      </SelectItem>
                      <SelectItem value="china">
                        {t("kimiCode.regionChina")}
                      </SelectItem>
                      <SelectItem value="custom">
                        {t("kimiCode.endpointCustom")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                baseUrlField
              )}
            </div>

            {isKimi && draft.region === "custom" && baseUrlField}
            {fieldError("baseUrl")}

            {meta.usesApiKey ? (
              <div className="space-y-1">
                <label
                  className="text-2xs text-muted-foreground"
                  htmlFor="kimi-api-key-input"
                  title={t("kimiCode.apiKeyHint")}
                >
                  {t("kimiCode.apiKeyLabel")}
                </label>
                <div className="flex items-center gap-2">
                  <Input
                    id="kimi-api-key-input"
                    type={showKey ? "text" : "password"}
                    value={draft.apiKey}
                    onChange={(event) => patch({ apiKey: event.target.value })}
                    placeholder="sk-..."
                    disabled={saving}
                    aria-invalid={errors.apiKey != null}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setShowKey((prev) => !prev)}
                    title={
                      showKey
                        ? t("actions.hideApiKey")
                        : t("actions.showApiKey")
                    }
                  >
                    {showKey ? (
                      <EyeOff className="h-3.5 w-3.5" />
                    ) : (
                      <Eye className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </div>
                {fieldError("apiKey")}
              </div>
            ) : (
              <div className="grid gap-2 md:grid-cols-2">
                <div className="space-y-1">
                  <label
                    className="text-2xs text-muted-foreground"
                    htmlFor="kimi-vertex-project-input"
                  >
                    {t("kimiCode.vertexProjectLabel")}
                  </label>
                  <Input
                    id="kimi-vertex-project-input"
                    value={draft.vertexProject}
                    onChange={(event) =>
                      patch({ vertexProject: event.target.value })
                    }
                    placeholder="my-gcp-project"
                    disabled={saving}
                    aria-invalid={errors.vertexProject != null}
                  />
                  {fieldError("vertexProject")}
                </div>
                <div className="space-y-1">
                  <label
                    className="text-2xs text-muted-foreground"
                    htmlFor="kimi-vertex-location-input"
                    title={t("kimiCode.vertexHint")}
                  >
                    {t("kimiCode.vertexLocationLabel")}
                  </label>
                  <Input
                    id="kimi-vertex-location-input"
                    value={draft.vertexLocation}
                    onChange={(event) =>
                      patch({ vertexLocation: event.target.value })
                    }
                    placeholder="us-central1"
                    disabled={saving}
                  />
                </div>
              </div>
            )}
          </div>

          {/* ---- Model card ---- */}
          <div className="space-y-2 rounded-md border bg-background/60 p-2.5">
            <span className="text-2xs font-medium">
              {t("kimiCode.modelTitle")}
            </span>

            <div className="grid gap-2 md:grid-cols-2">
              <div className="space-y-1">
                <label
                  className="text-2xs text-muted-foreground"
                  htmlFor="kimi-model-input"
                  title={t("kimiCode.modelHint")}
                >
                  {t("kimiCode.modelLabel")}
                  <span className="ml-0.5 text-destructive">*</span>
                </label>
                <ModelIdInputWithFetch
                  id="kimi-model-input"
                  value={draft.model}
                  onChange={handleModelChange}
                  state={providerModels}
                  placeholder={KIMI_MODEL_PLACEHOLDER}
                  disabled={saving}
                  aria-invalid={errors.model != null}
                />
                {fieldError("model")}
              </div>

              <div className="space-y-1">
                <label
                  className="text-2xs text-muted-foreground"
                  htmlFor="kimi-max-context-input"
                  title={t("kimiCode.maxContextHint")}
                >
                  {t("kimiCode.maxContextLabel")}
                  <span className="ml-0.5 text-destructive">*</span>
                </label>
                <Input
                  id="kimi-max-context-input"
                  inputMode="numeric"
                  value={draft.maxContext}
                  onChange={(event) => {
                    setMaxContextTouched(true)
                    patch({ maxContext: event.target.value })
                  }}
                  placeholder={String(KIMI_DEFAULT_MAX_CONTEXT)}
                  disabled={saving}
                  aria-invalid={errors.maxContext != null}
                />
                {fieldError("maxContext")}
              </div>
            </div>

            {modelUnlisted && (
              <p className="flex items-start gap-1.5 text-2xs text-amber-700 dark:text-amber-400">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <span>{t("kimiCode.modelNotInList")}</span>
              </p>
            )}
          </div>

          {/* ---- Reasoning card ----
              `kimi acp` only advertises its Thinking picker when the model
              declares a thinking capability, and sources the picker's rows from
              `support_efforts`. Both are written from here. */}
          <div className="space-y-2 rounded-md border bg-background/60 p-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-2xs font-medium">
                {t("kimiCode.reasoningTitle")}
              </span>
              <label className="flex cursor-pointer items-center gap-1.5 text-2xs text-muted-foreground">
                <Switch
                  checked={draft.reasoningEnabled}
                  onCheckedChange={(checked) =>
                    patch({ reasoningEnabled: checked })
                  }
                  disabled={saving}
                  aria-label={t("kimiCode.reasoningEnableLabel")}
                />
                {t("kimiCode.reasoningEnableLabel")}
              </label>
            </div>
            <p className="text-3xs text-muted-foreground">
              {t("kimiCode.reasoningDescription")}
            </p>

            {draft.reasoningEnabled && (
              <>
                <div className="space-y-1">
                  <label className="text-2xs text-muted-foreground">
                    {t("kimiCode.effortsLabel")}
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {effortChoices.map((effort) => {
                      const active = draft.supportEfforts.includes(effort)
                      return (
                        <button
                          key={effort}
                          type="button"
                          disabled={saving}
                          onClick={() => toggleEffort(effort)}
                          aria-pressed={active}
                          className={cn(
                            "rounded-full border px-2 py-0.5 font-mono text-2xs transition-colors",
                            active
                              ? "border-primary/40 bg-primary/10 text-foreground"
                              : "border-border text-muted-foreground hover:bg-muted"
                          )}
                        >
                          {effort}
                        </button>
                      )
                    })}
                  </div>
                  <div className="flex items-center gap-2">
                    <Input
                      value={customEffort}
                      onChange={(event) => setCustomEffort(event.target.value)}
                      {...ime.props}
                      onKeyDown={(event) => {
                        if (ime.isComposing(event) || event.key !== "Enter")
                          return
                        event.preventDefault()
                        addCustomEffort()
                      }}
                      placeholder={t("kimiCode.effortsCustomPlaceholder")}
                      className="h-7 text-xs"
                      disabled={saving}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 shrink-0 gap-1 px-2 text-2xs"
                      onClick={addCustomEffort}
                      disabled={saving || !customEffort.trim()}
                    >
                      <Plus className="h-3 w-3" />
                      {t("kimiCode.effortsAdd")}
                    </Button>
                  </div>
                  <p className="text-3xs text-muted-foreground">
                    {draft.supportEfforts.length === 0
                      ? t("kimiCode.effortsEmptyHint")
                      : t("kimiCode.effortsHint")}
                  </p>
                </div>

                {draft.supportEfforts.length > 0 && (
                  <div className="space-y-1">
                    <label className="text-2xs text-muted-foreground">
                      {t("kimiCode.defaultEffortLabel")}
                    </label>
                    <Select
                      value={draft.defaultEffort || KIMI_EFFORT_UNSET}
                      onValueChange={(value) =>
                        patch({
                          defaultEffort:
                            value === KIMI_EFFORT_UNSET ? "" : value,
                        })
                      }
                      disabled={saving}
                    >
                      <SelectTrigger
                        className="w-full"
                        aria-label={t("kimiCode.defaultEffortLabel")}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent align="start">
                        <SelectItem value={KIMI_EFFORT_UNSET}>
                          {t("kimiCode.defaultEffortAuto")}
                        </SelectItem>
                        {draft.supportEfforts.map((effort) => (
                          <SelectItem key={effort} value={effort}>
                            {effort}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {fieldError("defaultEffort")}
                  </div>
                )}

                <label className="flex cursor-pointer items-start gap-2 text-2xs text-muted-foreground">
                  <Checkbox
                    checked={draft.alwaysThinking}
                    onCheckedChange={(checked) =>
                      patch({ alwaysThinking: checked === true })
                    }
                    disabled={saving}
                    className="mt-0.5"
                  />
                  <span>{t("kimiCode.alwaysThinkingLabel")}</span>
                </label>
              </>
            )}
          </div>
        </>
      )}

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
              {t("actions.saveKimiCodeConfig")}
            </>
          )}
        </Button>
      </div>

      {/* ---- Advanced: credential placement + the raw config.toml hatch ---- */}
      <details className="rounded-md border bg-background/40 p-2">
        <summary className="cursor-pointer text-2xs font-medium text-muted-foreground">
          {t("kimiCode.advancedTitle")}
        </summary>
        <div className="mt-2 space-y-3">
          {draft.mode === "apikey" && meta.usesApiKey && (
            <div className="space-y-1">
              <label
                className="text-2xs text-muted-foreground"
                title={t("kimiCode.authTypeHint")}
              >
                {t("kimiCode.authTypeLabel")}
              </label>
              <Select
                value={draft.authType}
                onValueChange={(value) =>
                  patch({ authType: value as KimiNativeAuthType })
                }
                disabled={saving}
              >
                <SelectTrigger
                  className="w-full"
                  aria-label={t("kimiCode.authTypeLabel")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="start">
                  <SelectItem value="api_key">
                    {t("kimiCode.authTypeApiKey")}
                  </SelectItem>
                  <SelectItem value="env">
                    {t("kimiCode.authTypeEnv")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-2xs text-muted-foreground">
              {t("kimiCode.rawEditorLabel")}
            </label>
            <Textarea
              value={rawConfig}
              onChange={(event) => setRawConfig(event.target.value)}
              placeholder={t("kimiCode.rawEditorPlaceholder")}
              className="min-h-[8.75rem] font-mono text-2xs"
              disabled={saving}
            />
            <p className="flex items-start gap-1.5 text-2xs text-amber-700 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              <span>{t("kimiCode.rawEditorWarning")}</span>
            </p>
            <div className="flex justify-end">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleSaveRaw}
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
                    {t("actions.saveKimiCodeRawConfig")}
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      </details>
    </div>
  )
}
