"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from "react"
import { Reorder, useDragControls } from "motion/react"
import { useLocale, useTranslations } from "next-intl"
import { useImeGuard } from "@/hooks/use-ime-guard"
import { useSearchParams } from "next/navigation"
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  Eye,
  EyeOff,
  GripVertical,
  Loader2,
  Minus,
  PackagePlus,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Save,
  Stethoscope,
  Trash2,
  Wrench,
} from "lucide-react"
import { parse as parseTomlDocument } from "smol-toml"
import { isDesktop, openUrl } from "@/lib/platform"
import { getActiveRemoteConnectionId } from "@/lib/transport"
import { toast } from "sonner"
import {
  customAgentId,
  isCustomAgentType,
  setCustomAgentDisplay,
} from "@/lib/custom-agents"
import { AgentIcon } from "@/components/agent-icon"
import { AddCustomAgentDialog } from "@/components/settings/add-custom-agent-dialog"
import { SettingCard, SettingRow } from "@/components/shared/setting-card"
import { CustomAgentMcpToggle } from "@/components/settings/custom-agent-mcp-toggle"
import { CustomAgentSkillsToggle } from "@/components/settings/custom-agent-skills-toggle"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
} from "@/components/ui/combobox"
import { cn, copyTextToClipboard, randomUUID } from "@/lib/utils"
import {
  acpClearBinaryCache,
  acpDetectAgentLocalVersion,
  acpDownloadAgentBinary,
  acpInstallUvTool,
  acpGetAgentStatus,
  acpListAgents,
  acpPreflight,
  acpPrepareNpxAgent,
  acpReorderAgents,
  acpDeleteCustomAgent,
  acpUninstallAgent,
  acpUpdateAgentConfig,
  acpUpdateAgentEnv,
  acpUpdateHermesConfig,
  acpRevealHermesHome,
  acpOpenHermesSetupTerminal,
  codexPollDeviceCode,
  codexRequestDeviceCode,
  listModelProviders,
  opencodeProviderCatalog,
} from "@/lib/api"
import type {
  AcpAgentInfo,
  AdapterInfo,
  AgentType,
  CheckStatus,
  CodexGranularApproval,
  CodexSandboxStructuredConfig,
  FixAction,
  GrokStructuredConfig,
  HermesLocalConfig,
  ModelProviderInfo,
  OpenCodeCatalogProvider,
  PreflightResult,
} from "@/lib/types"
import {
  HERMES_PROVIDERS,
  parseClaudeProviderModel,
  parseCodexModelConfig,
  serializeCodexModelConfig,
  type CodexModelConfig,
} from "@/lib/types"
import { CodexModelListEditor } from "@/components/settings/codex-model-list-editor"
import {
  OpenCodeConnectDialog,
  OpenCodeCustomProviderDialog,
} from "@/components/settings/opencode-connect-dialog"
import { OpenCodeBehaviorSection } from "@/components/settings/opencode-behavior-section"
import { OpenCodePermissionsSection } from "@/components/settings/opencode-permissions-section"
import { AgentDiagnosticsDialog } from "@/components/settings/agent-diagnostics-dialog"
import {
  buildConnectedModelOptions,
  buildConnectedProviders,
  disconnectProvider,
  formatContextWindow,
  modelReferencesProvider,
  setProviderApiKey,
  setProviderEnabled,
  type OpenCodeModelOptionGroup,
} from "@/lib/opencode-connect"
import { toErrorMessage } from "@/lib/app-error"
import { getInstallErrorHintKey } from "@/lib/agent-install-error"
import { useAgentInstallStream } from "@/hooks/use-agent-install-stream"
import { OpencodePluginsModal } from "./opencode-plugins-modal"
import {
  ANTIGRAVITY_ENV_KEYS,
  AntigravityConfigPanel,
} from "./antigravity-config-panel"
import { CodeBuddyConfigPanel } from "./codebuddy-config-panel"
import { CursorConfigPanel } from "./cursor-config-panel"
import {
  DEEPSEEK_PANEL_ENV_KEYS,
  DeepSeekConfigPanel,
} from "./deepseek-config-panel"
import { DeepSeekModelListEditor } from "./deepseek-model-list-editor"
import { KimiCodeConfigPanel } from "./kimi-code-config-panel"
import { PiConfigPanel } from "./pi-config-panel"
import { QoderConfigPanel } from "./qoder-config-panel"

interface AgentCheckState {
  result?: PreflightResult
  error?: string
}

const CLAUDE_AUTH_MODES = [
  "official_subscription",
  "custom",
  "model_provider",
] as const
type ClaudeAuthMode = (typeof CLAUDE_AUTH_MODES)[number]

interface AgentDraft {
  enabled: boolean
  envText: string
  configText: string
  apiBaseUrl: string
  apiKey: string
  model: string
  claudeAuthMode: ClaudeAuthMode
  modelProviderId: number | null
  geminiAuthMode: GeminiAuthMode
  geminiApiKey: string
  googleApiKey: string
  googleCloudProject: string
  googleCloudLocation: string
  googleApplicationCredentials: string
  codexAuthMode: CodexAuthMode
  codexModelProvider: string
  codexProviderOptions: string[]
  codexSupportsWebsockets: boolean
  codexSkills: boolean
  /** `[features].default_mode_request_user_input` — see
   * {@link CODEX_DEFAULT_MODE_REQUEST_USER_INPUT_KEY}. */
  codexDefaultModeRequestUserInput: boolean
  codexServiceTierFast: boolean
  /** Sandbox / approval group — the thread defaults codex applies to turns it
   * starts itself (`/goal`, `/review`, `/compact`). Held as plain draft state
   * (not derived from `codexConfigTomlText`) and merged into config.toml
   * server-side on save. */
  codexApprovalPolicy: CodexApprovalPolicyChoice
  codexGranular: CodexGranularApproval
  codexSandboxMode: CodexSandboxModeChoice
  /** `writable_roots`, one absolute path per line. */
  codexWritableRootsText: string
  codexNetworkAccess: boolean
  codexExcludeTmpdirEnvVar: boolean
  codexExcludeSlashTmp: boolean
  /** The sandbox group as it was read off disk. A save sends only the fields
   * that differ from this, so neither the raw config.toml editor nor an
   * untouched control can revert the other. */
  codexSandboxBaseline: CodexSandboxBaseline
  /** Read-only diagnostics from the backend projection: `default_permissions`
   * makes codex ignore `sandbox_mode` entirely. */
  codexSandboxShadowed: boolean
  codexSandboxHasPermissionsTable: boolean
  claudeMainModel: string
  claudeReasoningModel: string
  claudeDefaultHaikuModel: string
  claudeDefaultSonnetModel: string
  claudeDefaultOpusModel: string
  claudeCustomModelOption: string
  claudeCustomModelOptionName: string
  claudeCustomModelOptionDescription: string
  // Claude Code hardening toggles (native config `env`). `claudeSendAttributionHeader`
  // → CLAUDE_CODE_ATTRIBUTION_HEADER (on="1"/off="0"), default off (don't send).
  // `claudeDisableNonessentialTraffic` → CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
  // default on (disabled).
  claudeSendAttributionHeader: boolean
  claudeDisableNonessentialTraffic: boolean
  codexAuthJsonText: string
  codexConfigTomlText: string
  /** Structured codex custom-model list (mirrors the catalog source sidecar).
   *  Drives the model editor + `model_catalog_json` generation on save. */
  codexModelList: CodexModelConfig
  grokConfigTomlText: string
  // Grok authentication method (subscription via `grok login` vs XAI_API_KEY).
  // Recorded in env as GROK_AUTH_MODE; drives which credential body renders and
  // whether XAI_API_KEY is stripped from env on subscription.
  grokAuthMode: GrokAuthMethod
  // Grok structured controls (empty string = "unset / use default"). Backed by
  // ~/.grok/config.toml [ui].permission_mode / [models].default_reasoning_effort;
  // merged onto the current on-disk config server-side on save.
  grokPermissionMode: string
  grokReasoningEffort: string
  // Grok custom model (BYO endpoint) → [model.<id>] + [models].default. Numeric
  // fields are held as strings for their inputs and parsed on save.
  grokCustomModelId: string
  grokCustomBaseUrl: string
  grokCustomApiKey: string
  grokCustomApiBackend: string
  grokCustomContextWindow: string
  grokAutoCompactThreshold: string
  openCodeAuthJsonText: string
  openClawGatewayUrl: string
  openClawGatewayToken: string
  openClawSessionKey: string
  clineProvider: ClineProvider
  clineApiKey: string
  clineModel: string
  clineBaseUrl: string
  // Hermes — `apiKey`/`model`/`apiBaseUrl` are reused for the active provider's
  // key, model.default, and model.base_url. These carry the rest.
  hermesProvider: string
  hermesConfigYaml: string
  hermesHome: string
  hermesSetupCommand: string
  hermesModelCommand: string
}

type RunningActionKind =
  | "download_binary"
  | "upgrade_binary"
  | "install_npx"
  | "upgrade_npx"
  | "uninstall_binary"
  | "uninstall_npx"
  | "redownload_binary"
  | "custom_install"
  | "install_uv"

type UiFixAction =
  | FixAction
  | {
      label: string
      kind:
        | "download_binary"
        | "upgrade_binary"
        | "install_npx"
        | "upgrade_npx"
        | "uninstall_binary"
        | "uninstall_npx"
        | "install_opencode_plugins"
        | "custom_install"
      payload: string
      // When true, the fix renders as a greyed-out button (e.g. the uvx
      // agent-install action while the uv runtime isn't ready yet).
      disabled?: boolean
    }

interface UiCheckItem {
  check_id: string
  label: string
  status: CheckStatus
  message: string
  fixes: UiFixAction[]
}

/**
 * Fix kinds that run a package operation. Only one of these may run at a time
 * across ALL agents, so while any of them is busy anywhere, every button whose
 * kind is listed here is disabled — and dimmed, so the lockout is visible on
 * agents other than the busy one.
 */
const PACKAGE_ACTION_FIX_KINDS: ReadonlyArray<UiFixAction["kind"]> = [
  "download_binary",
  "upgrade_binary",
  "install_npx",
  "upgrade_npx",
  "uninstall_binary",
  "uninstall_npx",
  "redownload_binary",
  "install_opencode_plugins",
  "custom_install",
  "install_uv",
]

type AcpTranslator = (
  key: string,
  values?: Record<string, string | number>
) => string

let acpTranslator: AcpTranslator | null = null

function acpText(
  key: string,
  fallback: string,
  values?: Record<string, string | number>
): string {
  if (!acpTranslator) return fallback
  return acpTranslator(key, values)
}

/**
 * Publish a freshly fetched agent list into the custom-agent display map
 * (names + icons behind `getAgentLabel` / `getAgentIconUrl`). The map is
 * normally hydrated by `useAcpAgents`, but that hook lives in the workspace
 * surfaces — the settings window fetches its own list, so without this every
 * custom agent here falls back to the initial-letter glyph.
 */
function publishAgentDisplay(list: AcpAgentInfo[]): void {
  setCustomAgentDisplay(
    list.map((agent) => ({
      agentType: agent.agent_type,
      name: agent.name,
      iconUrl: agent.icon_url,
    }))
  )
}

function statusTone(status: CheckStatus): string {
  if (status === "pass") return "text-green-500"
  if (status === "warn") return "text-yellow-500"
  return "text-red-500"
}

function summarizeChecks(checks: UiCheckItem[]): CheckStatus | "unchecked" {
  if (checks.length === 0) return "unchecked"
  if (checks.some((check) => check.status === "fail")) return "fail"
  if (checks.some((check) => check.status === "warn")) return "warn"
  return "pass"
}

/**
 * Per-agent `env_json` knob deciding WHICH SIDE of the ACP connection reads
 * files and runs commands (`HostToolsPolicy`, Rust side). codeg advertises
 * `fs.readTextFile` / `terminal` by default, and an agent that sees them stops
 * using its own backends and delegates — so the work happens in CODEG's
 * process, outside any OS sandbox the agent applies to itself. Set to
 * {@link HOST_TOOLS_AGENT} and codeg advertises neither, so the agent does its
 * own I/O and its own sandbox covers it again (#436). Absent ⇒ codeg hosts.
 */
const HOST_TOOLS_ENV = "CODEG_ACP_HOST_TOOLS"
const HOST_TOOLS_AGENT = "agent"
const HOST_TOOLS_DEFAULT = "default"

function envMapToText(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")
}

function parseEnvText(envText: string): Record<string, string> {
  const map: Record<string, string> = {}
  for (const rawLine of envText.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const idx = line.indexOf("=")
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (!key) continue
    map[key] = value
  }
  return map
}

/**
 * Fold the DeepSeek panel's own env keys, as they are actually persisted, into
 * an existing draft. Everything else in the draft — other keys, and any
 * unsaved edit to them — is left exactly as it was.
 *
 * Returns the draft unchanged when nothing moved, so this never invalidates a
 * memo or restarts a render for a no-op refresh.
 */
export function rebaseDeepSeekDraft(
  draft: AgentDraft,
  agent: AcpAgentInfo
): AgentDraft {
  // Decide on the VALUES, before rewriting anything, so an unrelated refresh
  // leaves the draft object (and its text) untouched.
  //
  // Mirrors `patchEnvText`'s own rule exactly: an empty persisted value means
  // DELETE the key, so `KEY=` present in the draft while the agent has no such
  // key IS a difference — the enable switch persists the draft wholesale, and
  // an empty `DEEPSEEK_BASE_URL` is not "use the default", it is an empty
  // endpoint.
  const current = parseEnvText(draft.envText)
  const patch: Record<string, string | undefined> = {}
  let moved = false
  for (const key of DEEPSEEK_PANEL_ENV_KEYS) {
    patch[key] = agent.env[key]
    const next = (agent.env[key] ?? "").trim()
    const present = key in current
    if (next ? current[key] !== next : present) moved = true
  }
  if (!moved) return draft
  const envText = patchEnvText(draft.envText, patch)
  if (envText === draft.envText) return draft
  const keys = importantEnvKeysByAgent("deepseek")
  const merged = parseEnvText(envText)
  return {
    ...draft,
    envText,
    apiBaseUrl: findEnvValue(merged, keys.apiBaseUrl),
    apiKey: findEnvValue(merged, keys.apiKey),
    model: findEnvValue(merged, keys.model),
  }
}

/**
 * Set (or, for an empty value, delete) exactly the given keys in a raw env
 * draft, leaving every other LINE byte-identical.
 *
 * Textual on purpose. The obvious implementation — parse to a map, patch,
 * serialize — rewrites the whole textarea, and the parser only understands
 * `KEY=VALUE`: a comment, a blank line, and a half-typed `NEW_PROXY` all
 * vanish. These patches run on refresh and on save completion, so that would
 * silently delete what the user is still typing in the raw editor next to the
 * structured panel that triggered the save.
 *
 * A key appearing on several lines collapses to one (its patched value), which
 * matches how `parseEnvText` reads the draft afterwards.
 */
function patchEnvText(
  envText: string,
  patch: Record<string, string | undefined>
): string {
  // `key in patch` would also answer yes for `constructor`, `toString` and the
  // rest of Object.prototype — all of them legal env var names — and then read
  // a function where a string was expected. Own properties only.
  const owns = (key: string) => Object.prototype.hasOwnProperty.call(patch, key)
  const pending = new Set(
    Object.keys(patch).filter((key) => (patch[key]?.trim() ?? "") !== "")
  )
  const lines = envText === "" ? [] : envText.split(/\r?\n/)
  const kept: string[] = []
  for (const rawLine of lines) {
    const line = rawLine.trim()
    const idx = line.startsWith("#") ? -1 : line.indexOf("=")
    const key = idx > 0 ? line.slice(0, idx).trim() : ""
    if (!key || !owns(key)) {
      kept.push(rawLine)
      continue
    }
    const value = patch[key]?.trim() ?? ""
    // Empty ⇒ the key is being removed; a duplicate line for a key already
    // emitted goes too, so the result reads back as the value just written.
    if (!value || !pending.delete(key)) continue
    kept.push(`${key}=${value}`)
  }
  if (pending.size > 0) {
    // A key with no line yet goes after the last real one, not after the blank
    // line the user may be about to type into.
    let end = kept.length
    while (end > 0 && kept[end - 1].trim() === "") end -= 1
    const tail = kept.splice(end)
    for (const key of pending) kept.push(`${key}=${patch[key]?.trim() ?? ""}`)
    kept.push(...tail)
  }
  return kept.join("\n")
}

/**
 * Whether this agent's env draft hands the ACP fs/terminal channels back to the
 * agent — see {@link HOST_TOOLS_ENV}. Anything other than the exact sentinel
 * (including a hand-typed `default`) reads as off, matching the Rust resolver,
 * which fails OPEN on an unrecognized value rather than silently withholding.
 *
 * Reads the per-agent layer ONLY. When the key is absent and an operator has
 * exported `CODEG_ACP_HOST_TOOLS=agent` in codeg's own environment, the switch
 * renders off while the next connection actually withholds the channels — the
 * display understates how restricted the agent is. Showing that inherited state
 * would need the backend to report its resolved process-env value; until then
 * the error is in the safe direction, and {@link setHostToolsAgentMode} makes
 * the per-agent value authoritative the moment the user touches the switch.
 */
export function hostToolsAgentModeEnabled(envText: string): boolean {
  return parseEnvText(envText)[HOST_TOOLS_ENV] === HOST_TOOLS_AGENT
}

/**
 * Flip the knob in an env draft, always writing an EXPLICIT value — including
 * `default` for off, rather than deleting the key.
 *
 * Deleting would be tidier but wrong: the backend resolves this knob as
 * `env_json` first, then codeg's own process env. An operator who exported
 * `CODEG_ACP_HOST_TOOLS=agent` process-wide makes "absent" mean `agent`, so a
 * toggle that cleared the key on OFF could not turn the mode off at all — the
 * switch would read false while the next connection still withheld the
 * channels. Writing the value the user actually chose makes the per-agent
 * setting authoritative in both directions.
 */
export function setHostToolsAgentMode(
  envText: string,
  enabled: boolean
): string {
  return patchEnvText(envText, {
    [HOST_TOOLS_ENV]: enabled ? HOST_TOOLS_AGENT : HOST_TOOLS_DEFAULT,
  })
}

/**
 * Per-agent `env_json` key that opts an npx agent into installing the
 * package's `latest` npm dist-tag instead of the maintainer-reviewed pin.
 * Same storage as pi's runtime override and the host-tools knob above. The
 * backend reads it at install/upgrade time only: a launch always runs whatever
 * is installed, nothing polls npm in the background, and a failed latest
 * install falls back to the pinned version with a note in the install log.
 */
const ADAPTER_CHANNEL_ENV = "CODEG_ADAPTER_CHANNEL"
const ADAPTER_CHANNEL_LATEST = "latest"

export type AdapterChannel = "pinned" | "latest"

/**
 * Which adapter channel an env draft selects. Anything other than the exact
 * (trimmed) `latest` sentinel reads as pinned, matching the Rust reader
 * (`adapter_channel_is_latest`), which treats the pin as the only default.
 */
export function adapterChannelFromEnvText(envText: string): AdapterChannel {
  return parseEnvText(envText)[ADAPTER_CHANNEL_ENV]?.trim() ===
    ADAPTER_CHANNEL_LATEST
    ? "latest"
    : "pinned"
}

/** [`adapterChannelFromEnvText`] over the saved env map the backend reports. */
export function adapterChannelFromEnv(
  env: Record<string, string>
): AdapterChannel {
  return env[ADAPTER_CHANNEL_ENV]?.trim() === ADAPTER_CHANNEL_LATEST
    ? "latest"
    : "pinned"
}

/**
 * Select the adapter channel in an env draft. Pinned DELETES the key: unlike
 * the host-tools knob there is no process-env second layer that could make
 * "absent" mean something else, so absent is unambiguously the pinned default
 * on both sides, and the raw editor stays free of a key that only restates it.
 */
export function setAdapterChannel(
  envText: string,
  channel: AdapterChannel
): string {
  return patchEnvText(envText, {
    [ADAPTER_CHANNEL_ENV]:
      channel === "latest" ? ADAPTER_CHANNEL_LATEST : undefined,
  })
}

interface ImportantEnvKeys {
  apiBaseUrl: string[]
  apiKey: string[]
  model: string[]
}

const CLAUDE_MODEL_ENV_KEYS = {
  claudeMainModel: "ANTHROPIC_MODEL",
  claudeReasoningModel: "ANTHROPIC_REASONING_MODEL",
  claudeDefaultHaikuModel: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  claudeDefaultSonnetModel: "ANTHROPIC_DEFAULT_SONNET_MODEL",
  claudeDefaultOpusModel: "ANTHROPIC_DEFAULT_OPUS_MODEL",
  claudeCustomModelOption: "ANTHROPIC_CUSTOM_MODEL_OPTION",
  claudeCustomModelOptionName: "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
  claudeCustomModelOptionDescription:
    "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION",
} as const

// Claude Code hardening flags surfaced as toggles below the reasoning settings.
// Each maps to a boolean env var in the native config's `env` (on = "1", off =
// "0"). Because Claude Code's own defaults are the opposite of what we want, the
// toggle values are materialized on save (see the config-save handler) so the
// shown default positions are actually applied — not left implicit/absent.
const CLAUDE_ATTRIBUTION_HEADER_ENV_KEY = "CLAUDE_CODE_ATTRIBUTION_HEADER"
const CLAUDE_NONESSENTIAL_TRAFFIC_ENV_KEY =
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"
const CLAUDE_ENV_FLAG_ON = "1"
const CLAUDE_ENV_FLAG_OFF = "0"
// `CLAUDE_CODE_ATTRIBUTION_HEADER` = "send the attribution/billing header" →
// default OFF (don't send). `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` = "disable
// telemetry / redundant pings" → default ON (disabled).
const CLAUDE_SEND_ATTRIBUTION_HEADER_DEFAULT = false
const CLAUDE_DISABLE_NONESSENTIAL_TRAFFIC_DEFAULT = true

const GEMINI_AUTH_MODES = [
  "custom",
  "login_google",
  "gemini_api_key",
  "vertex_adc",
  "vertex_service_account",
  "vertex_api_key",
  "model_provider",
] as const

type GeminiAuthMode = (typeof GEMINI_AUTH_MODES)[number]

const GEMINI_ENV_KEYS = {
  baseUrl: "GOOGLE_GEMINI_BASE_URL",
  legacyBaseUrl: "GEMINI_BASE_URL",
  geminiApiKey: "GEMINI_API_KEY",
  legacyGeminiApiKey: "GOOGLE_GEMINI_API_KEY",
  googleApiKey: "GOOGLE_API_KEY",
  cloudProject: "GOOGLE_CLOUD_PROJECT",
  cloudProjectLegacy: "GOOGLE_CLOUD_PROJECT_ID",
  cloudLocation: "GOOGLE_CLOUD_LOCATION",
  applicationCredentials: "GOOGLE_APPLICATION_CREDENTIALS",
  model: "GEMINI_MODEL",
} as const

const OPENCLAW_ENV_KEYS = {
  gatewayUrl: "OPENCLAW_GATEWAY_URL",
  gatewayToken: "OPENCLAW_GATEWAY_TOKEN",
  sessionKey: "OPENCLAW_SESSION_KEY",
} as const

/** Cline provider ids, as the CLI's own registry keys them (`cline auth -p`).
 *
 * `openai-compatible` is NOT interchangeable with `openai`: the `auth`
 * subcommand aliases the latter, but the ACP path does not, so an `openai`
 * selection reaches `session/new` as an unknown provider with an empty model
 * list. The backend's `normalize_cline_provider_id` maps the legacy value on
 * read so an existing config still lands on the right row here. */
/** Cline's own sign-in providers, labelled as its registry labels them. Their
 * credential is an OAuth token cline obtains through a device-code flow and
 * stores itself, so this panel shows the command that starts it rather than a
 * key field — and the backend neither overwrites those entries nor exports
 * `CLINE_PROVIDER`/`CLINE_API_KEY` for them (see `cline_provider_is_agent_managed`). */
const CLINE_SIGNIN_PROVIDERS = [
  { value: "cline", label: "Cline Usage-Billing" },
  { value: "cline-pass", label: "ClinePass" },
  { value: "openai-codex", label: "OpenAI ChatGPT Subscription" },
] as const

/** Bring-your-own providers this panel can actually configure — every one is
 * authenticated by a single API key, which is all the three fields below can
 * express.
 *
 * Deliberately a subset of cline's ~50-provider registry. AWS Bedrock and GCP
 * Vertex used to be listed and never worked: cline authenticates them with
 * `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_REGION` and
 * `GOOGLE_VERTEX_PROJECT`/`GOOGLE_VERTEX_LOCATION`/`GOOGLE_APPLICATION_CREDENTIALS`
 * respectively, none of which a lone `apiKey` string can carry. They are
 * reachable through `cline auth bedrock`, and an entry made that way is read
 * back and preserved here rather than clobbered.
 *
 * `openai-compatible` is NOT interchangeable with `openai`: the `auth`
 * subcommand aliases the latter, but the ACP path does not, so an `openai`
 * selection reaches `session/new` as an unknown provider with an empty model
 * list. The backend's `normalize_cline_provider_id` maps the legacy value on
 * read so an existing config still lands on the right row here. */
const CLINE_BYO_PROVIDERS = [
  { value: "anthropic", label: "Anthropic" },
  { value: "openai-native", label: "OpenAI" },
  { value: "openai-compatible", label: "OpenAI Compatible" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "gemini", label: "Gemini" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "ollama", label: "Ollama" },
  { value: "lmstudio", label: "LM Studio" },
] as const

type ClineProvider =
  | (typeof CLINE_SIGNIN_PROVIDERS)[number]["value"]
  | (typeof CLINE_BYO_PROVIDERS)[number]["value"]
  // A provider configured outside codeg (`cline auth bedrock`, a registry id
  // this list does not carry) still has to select a row, or saving from this
  // panel would silently retarget the user's store at whatever the dropdown
  // fell back to.
  | (string & {})

/** Whether cline owns this provider's credential (OAuth), rather than codeg.
 *  Mirrors the backend `cline_provider_is_agent_managed`. */
function isClineSignInProvider(provider: string): boolean {
  return CLINE_SIGNIN_PROVIDERS.some((p) => p.value === provider)
}

/** The terminal command that starts (or repairs) a sign-in. cline drives a
 *  device-code flow: it prints a code and an `authkit.cline.bot/device` URL and
 *  waits for the browser half, which is why this is a command to run rather
 *  than a button to press. */
function clineAuthCommand(provider: string): string {
  return `cline auth ${provider}`
}

type ClaudeModelKey = keyof typeof CLAUDE_MODEL_ENV_KEYS
type ImportantConfigKey = "apiBaseUrl" | "apiKey" | "model" | ClaudeModelKey
type ImportantDraftPatch = Partial<Pick<AgentDraft, ImportantConfigKey>>

interface ConfigParseResult {
  config: Record<string, unknown>
  error: string | null
}

/** Sentinel for the Grok structured selects' "unset / use default" choice
 * (Radix Select forbids an empty-string item value). Maps to `null` on save. */
const GROK_UNSET = "__grok_unset__"

/** Grok custom-model `api_backend` options (docs.x.ai). Default `responses` —
 * what Grok's own build models use; a BYO OpenAI-compatible proxy would pick
 * `chat_completions`, an Anthropic-format endpoint `messages`. */
const GROK_DEFAULT_API_BACKEND = "responses"

/** Grok's real credential env var (mirrors the backend `agent_env_keys(Grok)`
 * and `importantEnvKeysByAgent`). */
const GROK_API_KEY_ENV = "XAI_API_KEY"

/** codeg-side knob recording the chosen authentication method. Read by the
 * launch path (`apply_grok_env_policy`): in `subscription` mode it clears any
 * inherited XAI_API_KEY so the CLI uses the `grok login` browser credential.
 * The Grok binary itself ignores this var. Mirrors Cursor's CURSOR_AUTH_MODE. */
const GROK_AUTH_MODE_ENV = "GROK_AUTH_MODE"

/** The subscription sign-in command shown (and copied) in the auth card. Grok's
 * `login` is a root subcommand; a bare `grok login` matches the panel's existing
 * hint wording (codeg doesn't resolve the managed binary path here). */
const GROK_LOGIN_COMMAND = "grok login"

/** Grok's three authentication methods:
 *  - `subscription` — sign in with `grok login` (SuperGrok / X Premium+),
 *    whose session lives in `~/.grok/auth.json` (untouched by codeg);
 *  - `api_key` — a non-interactive XAI_API_KEY from the xAI console;
 *  - `custom` — a bring-your-own endpoint: a custom `[model.<id>]` in
 *    ~/.grok/config.toml with its own base_url/api_key (the custom-model card). */
export type GrokAuthMethod = "subscription" | "api_key" | "custom"

/** Resolve the persisted Grok authentication method, tolerant of legacy rows:
 * an explicit `GROK_AUTH_MODE` wins; otherwise a configured custom model implies
 * `custom`, a saved XAI_API_KEY implies `api_key`, and an empty env means the
 * user relies on `grok login`. `hasCustomModel` reflects whether a codeg-managed
 * `[model.<id>]` is set (it lives in config.toml, not env). Mirrors
 * `inferCursorMode`. */
export function inferGrokMode(
  env: Record<string, string>,
  hasCustomModel = false
): GrokAuthMethod {
  const explicit = (env[GROK_AUTH_MODE_ENV] ?? "").trim()
  if (
    explicit === "subscription" ||
    explicit === "api_key" ||
    explicit === "custom"
  ) {
    return explicit
  }
  if (hasCustomModel) return "custom"
  return (env[GROK_API_KEY_ENV] ?? "").trim() ? "api_key" : "subscription"
}

export function importantEnvKeysByAgent(
  agentType: AgentType
): ImportantEnvKeys {
  if (agentType === "claude_code") {
    return {
      apiBaseUrl: ["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "API_BASE_URL"],
      apiKey: ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
      model: ["ANTHROPIC_MODEL", "OPENAI_MODEL", "MODEL"],
    }
  }
  if (agentType === "gemini") {
    return {
      apiBaseUrl: ["GOOGLE_GEMINI_BASE_URL", "GEMINI_BASE_URL", "API_BASE_URL"],
      apiKey: [
        GEMINI_ENV_KEYS.geminiApiKey,
        GEMINI_ENV_KEYS.googleApiKey,
        GEMINI_ENV_KEYS.legacyGeminiApiKey,
        "API_KEY",
      ],
      model: ["GEMINI_MODEL", "MODEL"],
    }
  }
  if (agentType === "grok") {
    // Grok's non-interactive credential is XAI_API_KEY (mirrors the backend
    // `agent_env_keys(Grok)`). Model/endpoint have working env overrides too:
    // GROK_DEFAULT_MODEL and GROK_XAI_API_BASE_URL (both read by the Grok binary;
    // XAI_API_BASE_URL is also accepted). XAI_MODEL is NOT read by Grok.
    return {
      apiBaseUrl: ["GROK_XAI_API_BASE_URL", "XAI_API_BASE_URL", "API_BASE_URL"],
      // Only XAI_API_KEY is a real Grok credential; the generic API_KEY alias is
      // NOT read by Grok, so including it would let the auth panel report
      // "configured" for a key the agent never uses.
      apiKey: ["XAI_API_KEY"],
      model: ["GROK_DEFAULT_MODEL", "MODEL"],
    }
  }
  if (agentType === "deepseek") {
    // The endpoint knob is DEEPSEEK_BASE_URL (read per request by the
    // `llm-deepseek` adapter through the launch-environment snapshot, which
    // falls back to `process.env`). DEEPSEEK_ACP_PROVIDER is NOT it — that's
    // the provider ROUTE id, so binding a model provider to it would write a
    // URL into a registry key. Mirrors the backend `agent_env_keys(DeepSeek)`;
    // generic OPENAI_*/API_KEY aliases are NOT read.
    return {
      apiBaseUrl: ["DEEPSEEK_BASE_URL"],
      apiKey: ["DEEPSEEK_API_KEY"],
      model: ["DEEPSEEK_ACP_MODEL"],
    }
  }
  if (agentType === "qoder") {
    // `QODER_PERSONAL_ACCESS_TOKEN` is Qoder's non-interactive credential
    // ("设置后自动使用 PAT 认证" in the CLI package's own README) and the only
    // way to authenticate a headless/server/Docker install, where the
    // `qoder login` browser flow cannot run. `QODER_MODEL` is the env twin of
    // `-m/--model`. Qoder talks only to its own service, so there is no
    // endpoint var at all — an EMPTY list here hides that field rather than
    // offering a box whose value nothing reads (see `importantFieldsFor`).
    // Generic OPENAI_*/API_KEY aliases are deliberately absent: Qoder reads
    // neither, and listing them would let the panel report "configured" off a
    // key that never reaches it. Mirrors the backend `agent_env_keys(Qoder)`.
    return {
      apiBaseUrl: [],
      apiKey: ["QODER_PERSONAL_ACCESS_TOKEN"],
      model: ["QODER_MODEL"],
    }
  }
  return {
    apiBaseUrl: ["OPENAI_BASE_URL", "API_BASE_URL"],
    apiKey: ["OPENAI_API_KEY", "API_KEY"],
    model: ["OPENAI_MODEL", "MODEL"],
  }
}

/**
 * Which of the three generic env fields this agent actually has a variable for.
 *
 * An empty list in {@link importantEnvKeysByAgent} means "this agent reads no
 * env var for that slot" — Qoder, for instance, talks only to its own service
 * and has no endpoint override. Rendering the input anyway offers a box whose
 * value nothing will ever read, and (before `patchEnvByImportantKey` guarded
 * it) wrote the typed value to an env var literally named `undefined`.
 */
export function importantFieldsFor(agentType: AgentType): {
  apiBaseUrl: boolean
  apiKey: boolean
  model: boolean
} {
  const keys = importantEnvKeysByAgent(agentType)
  return {
    apiBaseUrl: keys.apiBaseUrl.length > 0,
    apiKey: keys.apiKey.length > 0,
    model: keys.model.length > 0,
  }
}

function parseConfigJsonText(configText: string): ConfigParseResult {
  const trimmed = configText.trim()
  if (!trimmed) return { config: {}, error: null }

  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        config: {},
        error: acpText(
          "errors.nativeJsonMustBeObject",
          "Native JSON config must be an object"
        ),
      }
    }
    return { config: parsed as Record<string, unknown>, error: null }
  } catch (err) {
    const message = toErrorMessage(err)
    return {
      config: {},
      error: acpText(
        "errors.nativeJsonInvalid",
        "Native JSON config format error: {message}",
        { message }
      ),
    }
  }
}

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function parseOpenCodeAuthJsonText(authJsonText: string): {
  authObject: Record<string, unknown> | null
  error: string | null
} {
  const trimmed = authJsonText.trim()
  if (!trimmed) return { authObject: {}, error: null }
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        authObject: null,
        error: acpText(
          "errors.openCodeAuthMustBeObject",
          "OpenCode auth.json must be a JSON object"
        ),
      }
    }
    return { authObject: parsed as Record<string, unknown>, error: null }
  } catch (err) {
    const message = toErrorMessage(err)
    return {
      authObject: null,
      error: acpText(
        "errors.openCodeAuthInvalid",
        "OpenCode auth.json format error: {message}",
        { message }
      ),
    }
  }
}

function patchOpenCodeAuthJsonText(
  authJsonText: string,
  mutator: (authObject: Record<string, unknown>) => void
): { authJsonText: string; recoveredFromInvalid: boolean } {
  const parsed = parseOpenCodeAuthJsonText(authJsonText)
  const authObject = parsed.error
    ? {}
    : (JSON.parse(JSON.stringify(parsed.authObject ?? {})) as Record<
        string,
        unknown
      >)
  mutator(authObject)
  return {
    authJsonText:
      Object.keys(authObject).length === 0
        ? ""
        : JSON.stringify(authObject, null, 2),
    recoveredFromInvalid: Boolean(parsed.error),
  }
}

function envFromConfig(
  config: Record<string, unknown>
): Record<string, string> {
  const raw = config.env
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {}
  }

  const map: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "string") continue
    const trimmedKey = key.trim()
    const trimmedValue = value.trim()
    if (!trimmedKey || !trimmedValue) continue
    map[trimmedKey] = trimmedValue
  }
  return map
}

function pickFirstString(
  source: Record<string, unknown>,
  keys: string[]
): string | null {
  for (const key of keys) {
    const value = source[key]
    if (typeof value !== "string") continue
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return null
}

function findEnvValue(env: Record<string, string>, keys: string[]): string {
  for (const key of keys) {
    const value = env[key]
    if (!value) continue
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return ""
}

function extractImportantConfigValues(
  agentType: AgentType,
  env: Record<string, string>,
  configText: string
): {
  apiBaseUrl: string
  apiKey: string
  model: string
  claudeMainModel: string
  claudeReasoningModel: string
  claudeDefaultHaikuModel: string
  claudeDefaultSonnetModel: string
  claudeDefaultOpusModel: string
  claudeCustomModelOption: string
  claudeCustomModelOptionName: string
  claudeCustomModelOptionDescription: string
  claudeSendAttributionHeader: boolean
  claudeDisableNonessentialTraffic: boolean
  configError: string | null
} {
  const parseResult = parseConfigJsonText(configText)
  const config = parseResult.config
  const keys = importantEnvKeysByAgent(agentType)

  const configEnv = envFromConfig(config)
  const mergedEnv = { ...env, ...configEnv }

  const apiBaseUrl =
    pickFirstString(config, ["apiBaseUrl", "api_base_url"]) ??
    findEnvValue(mergedEnv, keys.apiBaseUrl)
  const apiKey =
    pickFirstString(config, ["apiKey", "api_key"]) ??
    findEnvValue(mergedEnv, keys.apiKey)
  const model =
    pickFirstString(config, ["model", "model_name"]) ??
    findEnvValue(mergedEnv, keys.model)
  const claudeMainModel = findEnvValue(mergedEnv, [
    CLAUDE_MODEL_ENV_KEYS.claudeMainModel,
  ])
  const claudeReasoningModel = findEnvValue(mergedEnv, [
    CLAUDE_MODEL_ENV_KEYS.claudeReasoningModel,
  ])
  const claudeDefaultHaikuModel = findEnvValue(mergedEnv, [
    CLAUDE_MODEL_ENV_KEYS.claudeDefaultHaikuModel,
  ])
  const claudeDefaultSonnetModel = findEnvValue(mergedEnv, [
    CLAUDE_MODEL_ENV_KEYS.claudeDefaultSonnetModel,
  ])
  const claudeDefaultOpusModel = findEnvValue(mergedEnv, [
    CLAUDE_MODEL_ENV_KEYS.claudeDefaultOpusModel,
  ])
  const claudeCustomModelOption = findEnvValue(mergedEnv, [
    CLAUDE_MODEL_ENV_KEYS.claudeCustomModelOption,
  ])
  const claudeCustomModelOptionName = findEnvValue(mergedEnv, [
    CLAUDE_MODEL_ENV_KEYS.claudeCustomModelOptionName,
  ])
  const claudeCustomModelOptionDescription = findEnvValue(mergedEnv, [
    CLAUDE_MODEL_ENV_KEYS.claudeCustomModelOptionDescription,
  ])

  // Present in env → on iff value is "1"; absent → the toggle's default.
  const attributionRaw = findEnvValue(mergedEnv, [
    CLAUDE_ATTRIBUTION_HEADER_ENV_KEY,
  ])
  const claudeSendAttributionHeader =
    agentType === "claude_code"
      ? attributionRaw
        ? attributionRaw === CLAUDE_ENV_FLAG_ON
        : CLAUDE_SEND_ATTRIBUTION_HEADER_DEFAULT
      : false
  const nonessentialRaw = findEnvValue(mergedEnv, [
    CLAUDE_NONESSENTIAL_TRAFFIC_ENV_KEY,
  ])
  const claudeDisableNonessentialTraffic =
    agentType === "claude_code"
      ? nonessentialRaw
        ? nonessentialRaw === CLAUDE_ENV_FLAG_ON
        : CLAUDE_DISABLE_NONESSENTIAL_TRAFFIC_DEFAULT
      : false

  return {
    apiBaseUrl: apiBaseUrl ?? "",
    apiKey: apiKey ?? "",
    model: model ?? "",
    claudeMainModel: agentType === "claude_code" ? (claudeMainModel ?? "") : "",
    claudeReasoningModel:
      agentType === "claude_code" ? claudeReasoningModel : "",
    claudeDefaultHaikuModel:
      agentType === "claude_code" ? claudeDefaultHaikuModel : "",
    claudeDefaultSonnetModel:
      agentType === "claude_code" ? claudeDefaultSonnetModel : "",
    claudeDefaultOpusModel:
      agentType === "claude_code" ? claudeDefaultOpusModel : "",
    claudeCustomModelOption:
      agentType === "claude_code" ? claudeCustomModelOption : "",
    claudeCustomModelOptionName:
      agentType === "claude_code" ? claudeCustomModelOptionName : "",
    claudeCustomModelOptionDescription:
      agentType === "claude_code" ? claudeCustomModelOptionDescription : "",
    claudeSendAttributionHeader,
    claudeDisableNonessentialTraffic,
    configError: parseResult.error,
  }
}

interface GeminiImportantValues {
  authMode: GeminiAuthMode
  apiBaseUrl: string
  geminiApiKey: string
  googleApiKey: string
  googleCloudProject: string
  googleCloudLocation: string
  googleApplicationCredentials: string
  model: string
}

function inferGeminiAuthMode(values: {
  apiBaseUrl: string
  geminiApiKey: string
  googleApiKey: string
  googleCloudProject: string
  googleCloudLocation: string
  googleApplicationCredentials: string
}): GeminiAuthMode {
  if (values.apiBaseUrl.trim()) return "custom"
  if (values.geminiApiKey.trim()) return "gemini_api_key"
  if (values.googleApiKey.trim()) return "vertex_api_key"
  if (values.googleApplicationCredentials.trim())
    return "vertex_service_account"
  if (values.googleCloudProject.trim() || values.googleCloudLocation.trim()) {
    return "vertex_adc"
  }
  return "login_google"
}

function extractGeminiImportantValues(
  env: Record<string, string>,
  configText: string
): GeminiImportantValues {
  const parseResult = parseConfigJsonText(configText)
  const config = parseResult.config
  const configEnv = envFromConfig(config)
  const mergedEnv = { ...env, ...configEnv }

  const apiBaseUrl = findEnvValue(mergedEnv, [
    GEMINI_ENV_KEYS.baseUrl,
    GEMINI_ENV_KEYS.legacyBaseUrl,
    "API_BASE_URL",
  ])
  const geminiApiKey = findEnvValue(mergedEnv, [
    GEMINI_ENV_KEYS.geminiApiKey,
    GEMINI_ENV_KEYS.legacyGeminiApiKey,
  ])
  const googleApiKey = findEnvValue(mergedEnv, [GEMINI_ENV_KEYS.googleApiKey])
  const googleCloudProject = findEnvValue(mergedEnv, [
    GEMINI_ENV_KEYS.cloudProject,
    GEMINI_ENV_KEYS.cloudProjectLegacy,
  ])
  const googleCloudLocation = findEnvValue(mergedEnv, [
    GEMINI_ENV_KEYS.cloudLocation,
  ])
  const googleApplicationCredentials = findEnvValue(mergedEnv, [
    GEMINI_ENV_KEYS.applicationCredentials,
  ])
  const model = findEnvValue(mergedEnv, [GEMINI_ENV_KEYS.model, "MODEL"])

  return {
    authMode: inferGeminiAuthMode({
      apiBaseUrl,
      geminiApiKey,
      googleApiKey,
      googleCloudProject,
      googleCloudLocation,
      googleApplicationCredentials,
    }),
    apiBaseUrl,
    geminiApiKey,
    googleApiKey,
    googleCloudProject,
    googleCloudLocation,
    googleApplicationCredentials,
    model: model ?? "",
  }
}

interface OpenClawImportantValues {
  gatewayUrl: string
  gatewayToken: string
  sessionKey: string
}

interface ClineImportantValues {
  provider: ClineProvider
  apiKey: string
  model: string
  baseUrl: string
}

/** Mirrors the backend `normalize_cline_provider_id`, so a legacy `"openai"`
 * typed into the advanced JSON editor still selects a row instead of leaving the
 * provider dropdown blank. */
function normalizeClineProvider(provider: string): ClineProvider {
  return provider === "openai" ? "openai-compatible" : provider
}

function extractClineImportantValues(configText: string): ClineImportantValues {
  const parseResult = parseConfigJsonText(configText)
  const config = parseResult.config
  return {
    provider: normalizeClineProvider(
      typeof config.apiProvider === "string" && config.apiProvider
        ? config.apiProvider
        : "anthropic"
    ),
    apiKey: typeof config.apiKey === "string" ? config.apiKey : "",
    model: typeof config.model === "string" ? config.model : "",
    baseUrl: typeof config.apiBaseUrl === "string" ? config.apiBaseUrl : "",
  }
}

function extractOpenClawImportantValues(
  env: Record<string, string>,
  configText: string
): OpenClawImportantValues {
  const parseResult = parseConfigJsonText(configText)
  const config = parseResult.config
  const configEnv = envFromConfig(config)
  const mergedEnv = { ...env, ...configEnv }

  return {
    gatewayUrl: findEnvValue(mergedEnv, [OPENCLAW_ENV_KEYS.gatewayUrl]),
    gatewayToken: findEnvValue(mergedEnv, [OPENCLAW_ENV_KEYS.gatewayToken]),
    sessionKey: findEnvValue(mergedEnv, [OPENCLAW_ENV_KEYS.sessionKey]),
  }
}

function patchGeminiConfigText(
  configText: string,
  patch: {
    apiBaseUrl?: string
    model?: string
    geminiApiKey?: string
    googleApiKey?: string
    googleCloudProject?: string
    googleCloudLocation?: string
    googleApplicationCredentials?: string
  }
): {
  configText: string
  recoveredFromInvalid: boolean
} {
  const parseResult = parseConfigJsonText(configText)
  const config = parseResult.error ? {} : { ...parseResult.config }
  const env =
    typeof config.env === "object" && config.env && !Array.isArray(config.env)
      ? { ...(config.env as Record<string, unknown>) }
      : {}

  const assignOrRemoveEnv = (key: string, value: string | undefined) => {
    if (typeof value !== "string") return
    const trimmed = value.trim()
    if (!trimmed) {
      delete env[key]
      return
    }
    env[key] = trimmed
  }

  if (typeof patch.model === "string") {
    delete config.model
    delete config.model_name
    assignOrRemoveEnv(GEMINI_ENV_KEYS.model, patch.model)
  }
  assignOrRemoveEnv(GEMINI_ENV_KEYS.baseUrl, patch.apiBaseUrl)
  if (typeof patch.apiBaseUrl === "string") {
    assignOrRemoveEnv(GEMINI_ENV_KEYS.legacyBaseUrl, "")
  }
  assignOrRemoveEnv(GEMINI_ENV_KEYS.geminiApiKey, patch.geminiApiKey)
  assignOrRemoveEnv(GEMINI_ENV_KEYS.googleApiKey, patch.googleApiKey)
  if (typeof patch.geminiApiKey === "string") {
    assignOrRemoveEnv(GEMINI_ENV_KEYS.legacyGeminiApiKey, "")
  }
  if (typeof patch.googleCloudProject === "string") {
    const project = patch.googleCloudProject.trim()
    if (!project) {
      delete env[GEMINI_ENV_KEYS.cloudProject]
      delete env[GEMINI_ENV_KEYS.cloudProjectLegacy]
    } else {
      env[GEMINI_ENV_KEYS.cloudProject] = project
      delete env[GEMINI_ENV_KEYS.cloudProjectLegacy]
    }
  }
  assignOrRemoveEnv(GEMINI_ENV_KEYS.cloudLocation, patch.googleCloudLocation)
  assignOrRemoveEnv(
    GEMINI_ENV_KEYS.applicationCredentials,
    patch.googleApplicationCredentials
  )

  if (Object.keys(env).length === 0) {
    delete config.env
  } else {
    config.env = env
  }

  return {
    configText:
      Object.keys(config).length === 0 ? "" : JSON.stringify(config, null, 2),
    recoveredFromInvalid: Boolean(parseResult.error),
  }
}

function patchGeminiEnvText(
  envText: string,
  patch: {
    apiBaseUrl?: string
    geminiApiKey?: string
    googleApiKey?: string
    googleCloudProject?: string
    googleCloudLocation?: string
    googleApplicationCredentials?: string
    model?: string
  }
): string {
  const envPatch: Record<string, string | undefined> = {}
  if (typeof patch.apiBaseUrl === "string") {
    envPatch[GEMINI_ENV_KEYS.baseUrl] = patch.apiBaseUrl
    envPatch[GEMINI_ENV_KEYS.legacyBaseUrl] = ""
  }
  if (typeof patch.geminiApiKey === "string") {
    envPatch[GEMINI_ENV_KEYS.geminiApiKey] = patch.geminiApiKey
    envPatch[GEMINI_ENV_KEYS.legacyGeminiApiKey] = ""
  }
  if (typeof patch.googleApiKey === "string") {
    envPatch[GEMINI_ENV_KEYS.googleApiKey] = patch.googleApiKey
  }
  if (typeof patch.googleCloudProject === "string") {
    envPatch[GEMINI_ENV_KEYS.cloudProject] = patch.googleCloudProject
    envPatch[GEMINI_ENV_KEYS.cloudProjectLegacy] = ""
  }
  if (typeof patch.googleCloudLocation === "string") {
    envPatch[GEMINI_ENV_KEYS.cloudLocation] = patch.googleCloudLocation
  }
  if (typeof patch.googleApplicationCredentials === "string") {
    envPatch[GEMINI_ENV_KEYS.applicationCredentials] =
      patch.googleApplicationCredentials
  }
  if (typeof patch.model === "string") {
    envPatch[GEMINI_ENV_KEYS.model] = patch.model
  }
  return patchEnvText(envText, envPatch)
}

function patchGeminiAuthMode(
  current: GeminiImportantValues,
  mode: GeminiAuthMode
) {
  const next = {
    ...current,
    authMode: mode,
  }
  if (mode === "login_google") {
    next.apiBaseUrl = ""
    next.geminiApiKey = ""
    next.googleApiKey = ""
    next.googleCloudProject = ""
    next.googleCloudLocation = ""
    next.googleApplicationCredentials = ""
    return next
  }
  if (mode === "custom") {
    next.googleApiKey = ""
    next.googleCloudProject = ""
    next.googleCloudLocation = ""
    next.googleApplicationCredentials = ""
    return next
  }
  if (mode === "gemini_api_key") {
    next.apiBaseUrl = ""
    next.googleApiKey = ""
    next.googleCloudProject = ""
    next.googleCloudLocation = ""
    next.googleApplicationCredentials = ""
    return next
  }
  if (mode === "vertex_api_key") {
    next.apiBaseUrl = ""
    next.geminiApiKey = ""
    next.googleApplicationCredentials = ""
    return next
  }
  if (mode === "vertex_service_account") {
    next.apiBaseUrl = ""
    next.geminiApiKey = ""
    next.googleApiKey = ""
    return next
  }
  if (mode === "model_provider") {
    next.googleCloudProject = ""
    next.googleCloudLocation = ""
    next.googleApplicationCredentials = ""
    return next
  }
  next.apiBaseUrl = ""
  next.geminiApiKey = ""
  next.googleApiKey = ""
  next.googleApplicationCredentials = ""
  return next
}

function geminiAuthModeLabel(mode: GeminiAuthMode): string {
  if (mode === "custom")
    return acpText("authModeCustomEndpoint", "Custom Endpoint")
  if (mode === "login_google")
    return acpText("gemini.mode.loginGoogle", "Google Login (OAuth)")
  if (mode === "gemini_api_key") return "Gemini API Key"
  if (mode === "vertex_adc") return "Vertex AI (ADC)"
  if (mode === "vertex_service_account")
    return acpText(
      "gemini.mode.vertexServiceAccount",
      "Vertex AI (Service Account)"
    )
  if (mode === "model_provider")
    return acpText("authModeModelProvider", "Model Provider")
  return "Vertex AI API Key"
}

function geminiAuthModeHint(mode: GeminiAuthMode): string {
  if (mode === "custom") {
    return acpText(
      "gemini.hint.custom",
      "Fill API URL, API Key and Model, mapped to GOOGLE_GEMINI_BASE_URL / GEMINI_API_KEY / GEMINI_MODEL."
    )
  }
  if (mode === "login_google") {
    return acpText(
      "gemini.hint.loginGoogle",
      "Run gemini in terminal and complete Google login first; API key is not required."
    )
  }
  if (mode === "gemini_api_key") {
    return acpText(
      "gemini.hint.geminiApiKey",
      "Fill GEMINI_API_KEY when using Gemini API."
    )
  }
  if (mode === "vertex_adc") {
    return acpText(
      "gemini.hint.vertexAdc",
      "Use gcloud ADC; GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION are recommended."
    )
  }
  if (mode === "vertex_service_account") {
    return acpText(
      "gemini.hint.vertexServiceAccount",
      "Set service account JSON path to GOOGLE_APPLICATION_CREDENTIALS."
    )
  }
  if (mode === "model_provider") {
    return acpText(
      "modelProviderHint",
      "Use API URL and API Key from a configured model provider."
    )
  }
  return acpText(
    "gemini.hint.vertexApiKey",
    "Fill GOOGLE_API_KEY when using Vertex AI API key."
  )
}

/**
 * Compare original and current config objects. For any key present in
 * original but missing in current, set it to `null` in the result so
 * the backend merge can delete it from the file on disk.
 */
function markRemovedKeysNull(
  original: Record<string, unknown>,
  current: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...current }
  for (const key of Object.keys(original)) {
    if (!(key in result)) {
      result[key] = null
    } else if (
      original[key] &&
      typeof original[key] === "object" &&
      !Array.isArray(original[key]) &&
      result[key] &&
      typeof result[key] === "object" &&
      !Array.isArray(result[key])
    ) {
      result[key] = markRemovedKeysNull(
        original[key] as Record<string, unknown>,
        result[key] as Record<string, unknown>
      )
    }
  }
  return result
}

/**
 * Build the `config_json` payload for a merge-strategy agent save (Claude Code /
 * Gemini / OpenClaw). Diffs the current config against the original so removed
 * keys become explicit `null`s the backend merge deletes from disk — crucially
 * even when the current config emptied to "" (e.g. the last env flag toggled
 * off), which would otherwise serialize to a null `config_json` no-op and leave
 * the stale key on disk. Returns `null` when both sides are empty (nothing to
 * write, no empty file created). Pure — shared by `persistConfig` and tests.
 */
export function buildMergeConfigPayload(
  currentConfigText: string,
  originalConfigText: string | null | undefined
): string | null {
  const currentConfig = parseConfigJsonText(currentConfigText).config
  const originalConfig = originalConfigText
    ? parseConfigJsonText(originalConfigText).config
    : {}
  if (
    Object.keys(currentConfig).length === 0 &&
    Object.keys(originalConfig).length === 0
  ) {
    return null
  }
  return JSON.stringify(
    markRemovedKeysNull(originalConfig, currentConfig),
    null,
    2
  )
}

function normalizeConfigText(configText: string): string {
  const parseResult = parseConfigJsonText(configText)
  if (parseResult.error) return configText.trim()
  if (Object.keys(parseResult.config).length === 0) return ""
  return JSON.stringify(parseResult.config, null, 2)
}

interface OpenCodeProviderView {
  id: string
  name: string
  api: string
  npm: string
  baseUrl: string
  apiKey: string
  modelCount: number
  modelIds: string[]
  models: Record<string, OpenCodeModelView>
}

interface OpenCodeModelView {
  id: string
  name: string
  extraFieldCount: number
}

interface OpenCodeConfigView {
  model: string
  smallModel: string
  enabledProviders: string[]
  disabledProviders: string[]
  providerIds: string[]
  providers: Record<string, OpenCodeProviderView>
}

const OPENCODE_PROVIDER_NPM_OPTIONS = [
  {
    value: "@ai-sdk/openai-compatible",
    label: "@ai-sdk/openai-compatible",
  },
  {
    value: "@ai-sdk/cerebras",
    label: "@ai-sdk/cerebras",
  },
  {
    value: "@ai-sdk/azure",
    label: "@ai-sdk/azure",
  },
  {
    value: "@ai-sdk/xai",
    label: "@ai-sdk/xai",
  },
  {
    value: "@ai-sdk/anthropic",
    label: "@ai-sdk/anthropic",
  },
  {
    value: "@ai-sdk/amazon-bedrock",
    label: "@ai-sdk/amazon-bedrock",
  },
  {
    value: "@ai-sdk/google",
    label: "@ai-sdk/google",
  },
  {
    value: "@ai-sdk/google-vertex",
    label: "@ai-sdk/google-vertex",
  },
  {
    value: "@ai-sdk/deepseek",
    label: "@ai-sdk/deepseek",
  },
] as const

function buildOpenCodeModelOptions(
  config: OpenCodeConfigView | null
): OpenCodeModelOptionGroup[] {
  if (!config) return []
  const groups: OpenCodeModelOptionGroup[] = []
  for (const providerId of config.providerIds) {
    const provider = config.providers[providerId]
    if (!provider || provider.modelIds.length === 0) continue
    groups.push({
      providerId,
      label: provider.name || providerId,
      models: provider.modelIds.map((modelId) => ({
        value: `${providerId}/${modelId}`,
        label: modelId,
      })),
    })
  }
  return groups
}

function OpenCodeModelCombobox({
  value,
  onValueChange,
  groups,
  placeholder,
}: {
  value: string
  onValueChange: (value: string) => void
  groups: OpenCodeModelOptionGroup[]
  placeholder: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  const handleSelect = useCallback(
    (next: string | null) => {
      if (typeof next === "string" && next !== value) {
        onValueChange(next)
      }
    },
    [onValueChange, value]
  )

  const handleBlur = useCallback(() => {
    const trimmed = (inputRef.current?.value ?? "").trim()
    if (trimmed !== value) {
      onValueChange(trimmed)
    }
  }, [onValueChange, value])

  return (
    <Combobox key={value} value={value} onValueChange={handleSelect}>
      <ComboboxInput
        ref={inputRef}
        placeholder={placeholder}
        onBlur={handleBlur}
        showClear={false}
      />
      <ComboboxContent>
        <ComboboxList>
          {groups.map((group) => (
            <ComboboxGroup key={group.providerId}>
              <ComboboxLabel>{group.label}</ComboboxLabel>
              {group.models.map((model) => {
                const contextLabel =
                  typeof model.context === "number"
                    ? formatContextWindow(model.context)
                    : ""
                return (
                  <ComboboxItem key={model.value} value={model.value}>
                    <span className="truncate">{model.value}</span>
                    {(model.reasoning || contextLabel) && (
                      <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
                        {model.reasoning && (
                          <Badge
                            variant="outline"
                            className="px-1 text-[0.5625rem] font-normal"
                          >
                            {acpText("openCode.reasoningBadge", "reasoning")}
                          </Badge>
                        )}
                        {contextLabel && (
                          <span
                            className="text-3xs text-muted-foreground"
                            title={acpText(
                              "openCode.contextWindow",
                              "Context window"
                            )}
                          >
                            {contextLabel}
                          </span>
                        )}
                      </span>
                    )}
                  </ComboboxItem>
                )
              })}
            </ComboboxGroup>
          ))}
          <ComboboxEmpty>
            {acpText("openCode.noMatchingModels", "No matching models")}
          </ComboboxEmpty>
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}

function buildOpenCodeNpmOptions(currentValue: string): string[] {
  const next = new Set<string>(
    OPENCODE_PROVIDER_NPM_OPTIONS.map((v) => v.value)
  )
  const current = currentValue.trim()
  if (current) next.add(current)
  return Array.from(next)
}

function extractOpenCodeConfigValues(
  configText: string,
  authJsonText: string
): OpenCodeConfigView {
  const parseResult = parseConfigJsonText(configText)
  const config = parseResult.error ? {} : parseResult.config
  const authParsed = parseOpenCodeAuthJsonText(authJsonText)
  const authObject = authParsed.authObject ?? {}
  const providerRoot = asObjectRecord(config.provider) ?? {}
  const providerIds = Object.keys(providerRoot)
  const providers: Record<string, OpenCodeProviderView> = {}
  const knownModelKeys = new Set(["id", "name"])

  for (const providerId of providerIds) {
    const rawProvider = asObjectRecord(providerRoot[providerId]) ?? {}
    const options = asObjectRecord(rawProvider.options) ?? {}
    const models = asObjectRecord(rawProvider.models) ?? {}
    const modelIds = Object.keys(models)
    const providerModels: Record<string, OpenCodeModelView> = {}
    for (const modelId of modelIds) {
      const rawModel = asObjectRecord(models[modelId]) ?? {}
      providerModels[modelId] = {
        // OpenCode uses `provider.models.<model_id>` as the true model id.
        id: modelId,
        name:
          pickFirstString(rawModel, ["name"]) ??
          pickFirstString(rawModel, ["id"]) ??
          "",
        extraFieldCount: Object.keys(rawModel).filter(
          (key) => !knownModelKeys.has(key)
        ).length,
      }
    }
    const authEntry = asObjectRecord(authObject[providerId]) ?? {}
    const authKey = pickFirstString(authEntry, ["key"]) ?? ""
    providers[providerId] = {
      id: providerId,
      name: pickFirstString(rawProvider, ["name"]) ?? "",
      api: pickFirstString(rawProvider, ["api"]) ?? "",
      npm: pickFirstString(rawProvider, ["npm"]) ?? "",
      baseUrl: pickFirstString(options, ["baseURL", "baseUrl"]) ?? "",
      apiKey: pickFirstString(options, ["apiKey", "api_key"]) ?? authKey,
      modelCount: modelIds.length,
      modelIds,
      models: providerModels,
    }
  }

  return {
    model: pickFirstString(config, ["model"]) ?? "",
    smallModel:
      pickFirstString(config, ["small_model", "smallModel", "small-model"]) ??
      "",
    enabledProviders: Array.isArray(config.enabled_providers)
      ? config.enabled_providers
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean)
      : [],
    disabledProviders: Array.isArray(config.disabled_providers)
      ? config.disabled_providers
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean)
      : [],
    providerIds,
    providers,
  }
}

function patchOpenCodeConfigText(
  configText: string,
  mutator: (config: Record<string, unknown>) => void
): {
  configText: string
  recoveredFromInvalid: boolean
} {
  const parseResult = parseConfigJsonText(configText)
  const config = parseResult.error
    ? {}
    : (JSON.parse(JSON.stringify(parseResult.config)) as Record<
        string,
        unknown
      >)
  mutator(config)
  return {
    configText:
      Object.keys(config).length === 0 ? "" : JSON.stringify(config, null, 2),
    recoveredFromInvalid: Boolean(parseResult.error),
  }
}

// Fill in `provider.<id>.npm` with the first option for any providers that
// lack it, so the displayed Select value matches what gets persisted to disk.
function ensureOpenCodeProviderNpm(configText: string): string {
  if (!configText.trim()) return configText
  const parseResult = parseConfigJsonText(configText)
  if (parseResult.error) return configText
  const config = parseResult.config
  const providerRoot = asObjectRecord(config.provider)
  if (!providerRoot) return configText
  let mutated = false
  for (const providerId of Object.keys(providerRoot)) {
    const provider = asObjectRecord(providerRoot[providerId])
    if (!provider) continue
    const currentNpm =
      typeof provider.npm === "string" ? provider.npm.trim() : ""
    if (!currentNpm) {
      provider.npm = OPENCODE_PROVIDER_NPM_OPTIONS[0].value
      mutated = true
    }
  }
  if (!mutated) return configText
  return JSON.stringify(config, null, 2)
}

interface CodexTomlImportantValues {
  model: string
  modelProvider: string
  providerNames: string[]
  providerBaseUrls: Record<string, string>
  providerSupportsWebsockets: Record<string, boolean>
  featureResponsesWebsocketsV2: boolean
  featureSkills: boolean
  featureDefaultModeRequestUserInput: boolean
  serviceTierFast: boolean
}

interface CodexImportantValues {
  apiBaseUrl: string
  apiKey: string | null
  model: string
  modelProvider: string
  providerOptions: string[]
  supportsWebsockets: boolean
  skills: boolean
  defaultModeRequestUserInput: boolean
  serviceTierFast: boolean
}

const CODEX_DEFAULT_MODEL_PROVIDER = "codeg"

/**
 * `[features]` flag that lets codex call its `request_user_input` tool in the
 * DEFAULT collaboration mode.
 *
 * Upstream, `ModeKind::allows_request_user_input()` is true for `Plan` only
 * (codex-rs/protocol/src/config_types.rs), and
 * `request_user_input_available_modes()` widens it to `Default` exactly when
 * this feature is on (codex-rs/tools/src/tool_config.rs). Without it a
 * default-mode turn that reaches for the tool is refused with
 * "request_user_input is unavailable in Default mode" — i.e. codeg's question
 * cards only ever appear in Plan mode (openai/codex#24750).
 *
 * Stage is `UnderDevelopment` and `default_enabled` is false
 * (codex-rs/features/src/lib.rs), so it has no `/experimental` menu entry and
 * config.toml is the only way to turn it on. Verified against codex-cli 0.147.0
 * — the version codeg's pinned codex-acp 1.4.0 depends on — with
 * `codex features list`: absent ⇒ false, `= true` ⇒ true. Unknown keys under
 * `[features]` are ignored rather than rejected (also verified), so writing it
 * is safe on a codex build that predates the flag.
 */
const CODEX_DEFAULT_MODE_REQUEST_USER_INPUT_KEY =
  "default_mode_request_user_input"

/**
 * Header codex reads to decide whether a provider authenticates through the
 * "actor authorization" path. Mirrors `OPENAI_ACTOR_AUTHORIZATION_HEADER` in
 * codex's `model-provider-info` crate.
 */
const CODEX_ACTOR_AUTHORIZATION_HEADER = "x-openai-actor-authorization"

const CODEX_AUTH_MODES = [
  "api_key",
  "chatgpt_subscription",
  "model_provider",
] as const
type CodexAuthMode = (typeof CODEX_AUTH_MODES)[number]

/** The draft value meaning "leave the key out of config.toml", i.e. let codex
 * apply its own default. */
const CODEX_SANDBOX_UNSET = ""

/** Radix Select rejects "" as an item value, so the unset choice travels
 * through the widget under this sentinel and is mapped back on change. */
const CODEX_SANDBOX_UNSET_OPTION = "__codex_unset__"

/** `approval_policy` choices. The three presets are `AskForApproval`'s plain
 * string variants; `granular` is its table variant and reveals five switches.
 * (`on-failure` is only a legacy serde alias of `on-request` upstream, so it is
 * normalized away by the backend rather than offered here.) */
const CODEX_APPROVAL_POLICY_VALUES = [
  "on-request",
  "untrusted",
  "never",
  "granular",
] as const
type CodexApprovalPolicyChoice =
  | typeof CODEX_SANDBOX_UNSET
  | (typeof CODEX_APPROVAL_POLICY_VALUES)[number]

/** `SandboxMode`'s complete upstream vocabulary. */
const CODEX_SANDBOX_MODE_VALUES = [
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const
type CodexSandboxModeChoice =
  | typeof CODEX_SANDBOX_UNSET
  | (typeof CODEX_SANDBOX_MODE_VALUES)[number]

/** The five `granular` flags, in the order they are shown. */
const CODEX_GRANULAR_KEYS = [
  "sandbox_approval",
  "rules",
  "skill_approval",
  "request_permissions",
  "mcp_elicitations",
] as const

const CODEX_GRANULAR_DEFAULT: CodexGranularApproval = {
  sandbox_approval: true,
  rules: true,
  skill_approval: false,
  request_permissions: false,
  mcp_elicitations: true,
}

/** codex resolves a RELATIVE `writable_roots` entry against `CODEX_HOME`
 * instead of rejecting it, so `docs` would silently grant write access to
 * `~/.codex/docs`. Absolute-only is enforced here (and again server-side).
 * Both POSIX and Windows shapes are accepted regardless of host, since
 * config.toml is portable. */
function isAbsoluteWritableRoot(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.startsWith("/") || trimmed.startsWith("\\\\")) return true
  return /^[A-Za-z]:[\\/]/.test(trimmed)
}

/** One path per line → trimmed, de-blanked list. */
function parseWritableRootsText(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** The first relative entry, or null when every entry is absolute. */
function firstRelativeWritableRoot(text: string): string | null {
  return (
    parseWritableRootsText(text).find(
      (root) => !isAbsoluteWritableRoot(root)
    ) ?? null
  )
}

/** Whether the workspace-write sub-group applies. `sandbox_mode` unset falls
 * back to `workspace-write` for any directory carrying a `[projects]` trust
 * decision (which codeg writes for every folder it opens), so "unset" keeps the
 * group live rather than greying out the very knobs the fallback uses. */
function codexWorkspaceWriteApplies(mode: CodexSandboxModeChoice): boolean {
  return mode === "workspace-write" || mode === CODEX_SANDBOX_UNSET
}

/**
 * Whether `default_permissions` leaves `sandbox_mode` able to seed the ACP
 * session's starting approval preset. False when it shadows the root keys:
 * codex then resolves everything through that profile, and
 * `codex_initial_agent_mode` (commands/acp.rs) declines to map a shadowed
 * config at all — so no preset is injected and the adapter's own default stands.
 *
 * This is the shadowing gate specifically, not a complete "will a preset be
 * seeded" predicate: an unshadowed but UNSET `sandbox_mode` also maps to
 * `None`. The unset case needs no gate here, because the copy this guards is
 * about what the selected mode does and the select already reads "not set".
 *
 * Every claim the panel makes about the seeded preset has to be gated on this,
 * or it describes an injection that never happens. `sandboxShadowedWarning`
 * above already explains the shadowing itself.
 */
export function codexSandboxSeedsAcpPreset(shadowed: boolean): boolean {
  return !shadowed
}

/**
 * Whether to warn that the ACP adapter cannot honor a read-only sandbox.
 *
 * Fires exactly when codeg will inject the `read-only` preset, because the
 * warning's second half promises that every escalation reaches the user — true
 * of that preset on codex-acp ≥1.7.0 (`approvalsReviewer: "user"`), and false
 * of the `agent` default a shadowed config falls back to (`auto_review`, where
 * a model forwards only what it judges unsafe). Showing it for a shadowed
 * config would pair "your sandbox key is ignored" with "you will be asked about
 * everything" — the second being a guarantee codeg is not making.
 */
export function showsCodexReadOnlyAcpWarning(
  mode: CodexSandboxModeChoice,
  shadowed: boolean
): boolean {
  return mode === "read-only" && codexSandboxSeedsAcpPreset(shadowed)
}

/** The draft slice the sandbox payload is derived from. */
export type CodexSandboxDraftFields = {
  codexApprovalPolicy: CodexApprovalPolicyChoice
  codexGranular: CodexGranularApproval
  codexSandboxMode: CodexSandboxModeChoice
  codexWritableRootsText: string
  codexNetworkAccess: boolean
  codexExcludeTmpdirEnvVar: boolean
  codexExcludeSlashTmp: boolean
}

/** The sandbox controls as they were read off disk, kept on the draft so a save
 * can send ONLY what the user actually moved. */
export type CodexSandboxBaseline = CodexSandboxDraftFields

/** Baseline snapshot to seed a fresh draft with. */
export function codexSandboxBaselineOf(
  fields: CodexSandboxDraftFields
): CodexSandboxBaseline {
  return { ...fields }
}

/** Build the save PATCH for the Codex sandbox / approval controls: only the
 * fields whose control actually moved relative to `codexSandboxBaseline`.
 * Exported for tests.
 *
 * A whole-group payload would be wrong here. The panel sends the raw
 * config.toml text alongside this patch and the backend applies the patch LAST,
 * so any of these keys the user hand-edited in the raw editor — a surface the
 * panel never parses back into its controls — would be reverted by the panel's
 * stale value for that key. A per-field patch touches nothing the user did not
 * touch, in either surface.
 *
 * Throws on a relative `writable_roots` entry (only when that field moved) so
 * the save surfaces it instead of writing a path that would silently resolve
 * inside `~/.codex`. */
export function buildCodexSandboxConfig(
  draft: CodexSandboxDraftFields & {
    codexSandboxBaseline: CodexSandboxBaseline
  }
): CodexSandboxStructuredConfig {
  const base = draft.codexSandboxBaseline
  const patch: CodexSandboxStructuredConfig = {}

  // Approval is one externally tagged key upstream, so its two representations
  // move together: send both (one nulled) whenever either side changed.
  const granular = draft.codexApprovalPolicy === "granular"
  const approvalChanged =
    draft.codexApprovalPolicy !== base.codexApprovalPolicy ||
    (granular &&
      JSON.stringify(draft.codexGranular) !==
        JSON.stringify(base.codexGranular))
  if (approvalChanged) {
    patch.approvalPolicy =
      granular || draft.codexApprovalPolicy === CODEX_SANDBOX_UNSET
        ? null
        : draft.codexApprovalPolicy
    patch.granular = granular ? draft.codexGranular : null
  }

  if (draft.codexSandboxMode !== base.codexSandboxMode) {
    patch.sandboxMode =
      draft.codexSandboxMode === CODEX_SANDBOX_UNSET
        ? null
        : draft.codexSandboxMode
  }

  // The workspace-write group is sent as-is even in the modes that ignore it:
  // codex only reads it under `workspace-write`, so a dormant value costs
  // nothing, while clearing it would destroy the user's roots/flags on a round
  // trip through read-only or full-access.
  const roots = parseWritableRootsText(draft.codexWritableRootsText)
  const baseRoots = parseWritableRootsText(base.codexWritableRootsText)
  if (JSON.stringify(roots) !== JSON.stringify(baseRoots)) {
    const relative = roots.find((root) => !isAbsoluteWritableRoot(root))
    if (relative) {
      // `.replace` also covers the no-translator path, where acpText returns
      // the fallback uninterpolated.
      throw new Error(
        acpText(
          "codex.sandboxRootsRelativeError",
          "Writable folders must be absolute paths: {path}",
          { path: relative }
        ).replace("{path}", relative)
      )
    }
    patch.writableRoots = roots
  }
  if (draft.codexNetworkAccess !== base.codexNetworkAccess) {
    patch.networkAccess = draft.codexNetworkAccess
  }
  if (draft.codexExcludeTmpdirEnvVar !== base.codexExcludeTmpdirEnvVar) {
    patch.excludeTmpdirEnvVar = draft.codexExcludeTmpdirEnvVar
  }
  if (draft.codexExcludeSlashTmp !== base.codexExcludeSlashTmp) {
    patch.excludeSlashTmp = draft.codexExcludeSlashTmp
  }

  return patch
}

/** The `codexSandbox` value a Codex save should carry, or `undefined` when no
 * control moved (so the field is omitted from the request entirely). */
export function codexSandboxSaveConfig(
  draft: CodexSandboxDraftFields & {
    codexSandboxBaseline: CodexSandboxBaseline
  }
): CodexSandboxStructuredConfig | undefined {
  const patch = buildCodexSandboxConfig(draft)
  return Object.keys(patch).length > 0 ? patch : undefined
}

function buildCodexProviderOptions(
  activeProvider: string,
  providerNames: string[]
): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const raw of [
    activeProvider,
    ...providerNames,
    CODEX_DEFAULT_MODEL_PROVIDER,
  ]) {
    const provider = raw.trim()
    if (!provider || seen.has(provider)) continue
    seen.add(provider)
    result.push(provider)
  }
  return result
}

function parseTomlStringLiteral(raw: string): string | null {
  const text = raw.trim()
  if (!text) return null

  if (text.startsWith('"')) {
    let escaped = false
    for (let i = 1; i < text.length; i += 1) {
      const ch = text[i]
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === "\\") {
        escaped = true
        continue
      }
      if (ch === '"') {
        const literal = text.slice(0, i + 1)
        try {
          return JSON.parse(literal) as string
        } catch {
          return literal.slice(1, -1)
        }
      }
    }
    return null
  }

  if (text.startsWith("'")) {
    const end = text.indexOf("'", 1)
    if (end <= 0) return null
    return text.slice(1, end)
  }

  return null
}

function parseTomlStringAssignment(
  rawLine: string
): { key: string; value: string } | null {
  const key = parseTomlAssignmentKey(rawLine)
  if (!key) return null
  const line = rawLine.trim()
  const equalsIndex = line.indexOf("=")
  const valueText = line.slice(equalsIndex + 1)
  const value = parseTomlStringLiteral(valueText)
  if (value === null) return null
  return { key, value: value.trim() }
}

function parseTomlAssignmentKey(rawLine: string): string | null {
  const line = rawLine.trim()
  if (!line || line.startsWith("#")) return null
  const equalsIndex = line.indexOf("=")
  if (equalsIndex <= 0) return null
  const key = line.slice(0, equalsIndex).trim()
  if (!/^[A-Za-z0-9_.-]+$/.test(key)) return null
  return key
}

function parseTomlBooleanAssignment(
  rawLine: string
): { key: string; value: boolean } | null {
  const key = parseTomlAssignmentKey(rawLine)
  if (!key) return null
  const line = rawLine.trim()
  const equalsIndex = line.indexOf("=")
  const valueText = line.slice(equalsIndex + 1).trim()
  const boolMatch = valueText.match(/^(true|false)(?:\s+#.*)?$/)
  if (!boolMatch) return null
  return { key, value: boolMatch[1] === "true" }
}

function extractCodexTomlImportantValues(
  configTomlText: string
): CodexTomlImportantValues {
  const providerBaseUrls: Record<string, string> = {}
  const providerSupportsWebsockets: Record<string, boolean> = {}
  const providerNames = new Set<string>()
  let model = ""
  let modelProvider = ""
  let featureResponsesWebsocketsV2 = false
  let featureSkills = false
  let featureDefaultModeRequestUserInput = false
  let serviceTierFast = false
  let currentProviderSection: string | null = null
  let inFeaturesSection = false
  // Still above the first section header, i.e. in the implicit root table —
  // the only place a dotted `features.x` key actually means `[features].x`.
  let inRootTable = true

  for (const rawLine of configTomlText.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue

    // Section tracking goes through the same header predicate the writer uses,
    // so the two never disagree about where a table begins. A header carrying
    // a trailing comment (`[features] # flags`) is a header.
    const headerName = tomlSectionHeaderName(rawLine)
    if (isTomlSectionHeader(rawLine)) {
      inRootTable = false
      const providerName = headerName?.match(
        /^model_providers\.([A-Za-z0-9_-]+)$/
      )?.[1]
      if (providerName) {
        currentProviderSection = providerName
        inFeaturesSection = false
        providerNames.add(providerName)
      } else {
        currentProviderSection = null
        inFeaturesSection = headerName === "features"
      }
      continue
    }

    const assignment = parseTomlStringAssignment(rawLine)
    if (assignment) {
      if (assignment.key === "model") {
        model = assignment.value
        continue
      }
      if (assignment.key === "model_provider") {
        modelProvider = assignment.value
        continue
      }
      if (
        !currentProviderSection &&
        !inFeaturesSection &&
        assignment.key === "service_tier"
      ) {
        serviceTierFast = assignment.value.toLowerCase() === "fast"
        continue
      }
    }

    const boolAssignment = parseTomlBooleanAssignment(rawLine)
    if (boolAssignment) {
      if (
        currentProviderSection &&
        boolAssignment.key === "supports_websockets"
      ) {
        providerSupportsWebsockets[currentProviderSection] =
          boolAssignment.value
        providerNames.add(currentProviderSection.trim())
        continue
      }
      if (
        inFeaturesSection &&
        boolAssignment.key === "responses_websockets_v2"
      ) {
        featureResponsesWebsocketsV2 = boolAssignment.value
        continue
      }
      if (inFeaturesSection && boolAssignment.key === "skills") {
        featureSkills = boolAssignment.value
        continue
      }
      if (
        inFeaturesSection &&
        boolAssignment.key === CODEX_DEFAULT_MODE_REQUEST_USER_INPUT_KEY
      ) {
        featureDefaultModeRequestUserInput = boolAssignment.value
        continue
      }
      const dottedProviderWebsocketMatch = boolAssignment.key.match(
        /^model_providers\.([A-Za-z0-9_-]+)\.supports_websockets$/
      )
      if (dottedProviderWebsocketMatch && dottedProviderWebsocketMatch[1]) {
        const providerName = dottedProviderWebsocketMatch[1].trim()
        providerNames.add(providerName)
        providerSupportsWebsockets[providerName] = boolAssignment.value
        continue
      }
      // The three dotted `features.*` spellings below are ROOT-scoped on
      // purpose. Inside `[model_providers.codeg]` the same text means
      // `model_providers.codeg.features.…` — a key codex ignores — and the
      // writer only ever touches the root spelling. Reading a nested one would
      // show a value no save could clear, and (for the websocket flag, which
      // the writer re-derives on every patch) would promote a provider-local
      // key into a global `[features]` flag behind the user's back.
      if (inRootTable) {
        if (boolAssignment.key === "features.responses_websockets_v2") {
          featureResponsesWebsocketsV2 = boolAssignment.value
          continue
        }
        if (boolAssignment.key === "features.skills") {
          featureSkills = boolAssignment.value
          continue
        }
        if (
          boolAssignment.key ===
          `features.${CODEX_DEFAULT_MODE_REQUEST_USER_INPUT_KEY}`
        ) {
          featureDefaultModeRequestUserInput = boolAssignment.value
          continue
        }
      }
    }

    if (!assignment) continue

    const rawAssignmentKey = parseTomlAssignmentKey(rawLine)
    const dottedProviderMatch = rawAssignmentKey?.match(
      /^model_providers\.([A-Za-z0-9_-]+)\./
    )
    if (dottedProviderMatch && dottedProviderMatch[1]) {
      providerNames.add(dottedProviderMatch[1].trim())
    }
    if (
      currentProviderSection &&
      assignment.key === "base_url" &&
      assignment.value
    ) {
      providerBaseUrls[currentProviderSection] = assignment.value
      providerNames.add(currentProviderSection.trim())
      continue
    }
    const dottedMatch = assignment.key.match(
      /^model_providers\.([A-Za-z0-9_-]+)\.base_url$/
    )
    if (dottedMatch && assignment.value) {
      providerBaseUrls[dottedMatch[1]] = assignment.value
      providerNames.add(dottedMatch[1].trim())
    }
  }
  if (modelProvider.trim()) {
    providerNames.add(modelProvider.trim())
  }
  providerNames.add(CODEX_DEFAULT_MODEL_PROVIDER)
  for (const providerName of Object.keys(providerBaseUrls)) {
    if (providerName.trim()) {
      providerNames.add(providerName.trim())
    }
  }

  return {
    model,
    modelProvider,
    providerNames: Array.from(providerNames),
    providerBaseUrls,
    providerSupportsWebsockets,
    featureResponsesWebsocketsV2,
    featureSkills,
    featureDefaultModeRequestUserInput,
    serviceTierFast,
  }
}

function parseCodexAuthJsonObject(authJsonText: string): {
  authObject: Record<string, unknown> | null
  error: string | null
} {
  const trimmed = authJsonText.trim()
  if (!trimmed) return { authObject: {}, error: null }
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        authObject: null,
        error: acpText(
          "errors.authMustBeObject",
          "auth.json must be a JSON object"
        ),
      }
    }
    return { authObject: parsed as Record<string, unknown>, error: null }
  } catch (err) {
    const message = toErrorMessage(err)
    return {
      authObject: null,
      error: acpText(
        "errors.authInvalid",
        "auth.json format error: {message}",
        {
          message,
        }
      ),
    }
  }
}

function parseCodexAuthJsonText(authJsonText: string): string | null {
  return parseCodexAuthJsonObject(authJsonText).error
}

function inferCodexAuthMode(authJsonText: string): CodexAuthMode {
  const { authObject } = parseCodexAuthJsonObject(authJsonText)
  if (authObject) {
    // 官网订阅：auth_mode 为 chatgpt，或没有 OPENAI_API_KEY，或值为 null
    if (
      authObject.auth_mode === "chatgpt" ||
      !("OPENAI_API_KEY" in authObject) ||
      authObject.OPENAI_API_KEY === null
    ) {
      return "chatgpt_subscription"
    }
  }
  return "api_key"
}

function hasCodexChatgptTokens(authJsonText: string): boolean {
  const { authObject } = parseCodexAuthJsonObject(authJsonText)
  if (!authObject) return false
  const tokens = authObject.tokens as Record<string, unknown> | undefined
  if (tokens && typeof tokens === "object") {
    return (
      typeof tokens.access_token === "string" && tokens.access_token.length > 0
    )
  }
  return false
}

/** Exported so tests can assert the reader and
 * {@link patchCodexConfigTomlText} agree on every key — the two halves are what
 * make a toggle round-trip through config.toml instead of snapping back. */
export function extractCodexImportantValues(
  authJsonText: string,
  configTomlText: string
): CodexImportantValues {
  const parsedAuth = parseCodexAuthJsonObject(authJsonText)
  const authObject = parsedAuth.authObject ?? {}
  const toml = extractCodexTomlImportantValues(configTomlText)
  const hasExplicitProvider = Boolean(toml.modelProvider.trim())
  const activeProvider = hasExplicitProvider
    ? toml.modelProvider.trim()
    : CODEX_DEFAULT_MODEL_PROVIDER
  const providerBaseUrl = hasExplicitProvider
    ? (toml.providerBaseUrls[activeProvider] ?? "")
    : (toml.providerBaseUrls[CODEX_DEFAULT_MODEL_PROVIDER] ??
      toml.providerBaseUrls.openai ??
      "")
  const providerSupportsWebsockets =
    toml.providerSupportsWebsockets[activeProvider] ??
    (activeProvider === CODEX_DEFAULT_MODEL_PROVIDER
      ? toml.featureResponsesWebsocketsV2
      : false)
  return {
    apiBaseUrl: providerBaseUrl,
    apiKey:
      parsedAuth.error === null
        ? (pickFirstString(authObject, [
            "OPENAI_API_KEY",
            "OPENAI_API_TOKEN",
            "API_KEY",
          ]) ?? "")
        : null,
    model: toml.model,
    modelProvider: activeProvider,
    providerOptions: buildCodexProviderOptions(
      activeProvider,
      toml.providerNames
    ),
    supportsWebsockets: providerSupportsWebsockets,
    skills: toml.featureSkills,
    defaultModeRequestUserInput: toml.featureDefaultModeRequestUserInput,
    serviceTierFast: toml.serviceTierFast,
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Whether a line opens a new TOML table — `[table]` or `[[array]]` — allowing
 * the trailing comment TOML permits after a header. Matching `[x]` exactly
 * (what these helpers used to do) makes `[features] # flags` invisible, which
 * is not a cosmetic miss: the scanner then keeps treating the lines below it as
 * root-table keys, so an upsert appends a SECOND `[features]` and the file
 * stops parsing.
 */
function isTomlSectionHeader(rawLine: string): boolean {
  const line = rawLine.trim()
  return line.startsWith("[") && /^\[.*\]\s*(?:#.*)?$/.test(line)
}

/**
 * The table name from a `[table]` header, or null for anything else —
 * including `[[array]]`, which is not a plain table. Surrounding whitespace is
 * insignificant in TOML (`[ features ]` names `features`), so it is trimmed.
 */
function tomlSectionHeaderName(rawLine: string): string | null {
  const match = rawLine.trim().match(/^\[([^[\]]*)\]\s*(?:#.*)?$/)
  return match ? match[1].trim() : null
}

function findTomlRootEndIndex(lines: string[]): number {
  for (let i = 0; i < lines.length; i += 1) {
    if (isTomlSectionHeader(lines[i])) return i
  }
  return lines.length
}

function findTomlRootAssignmentIndex(lines: string[], key: string): number {
  const rootEnd = findTomlRootEndIndex(lines)
  for (let i = 0; i < rootEnd; i += 1) {
    const assignmentKey = parseTomlAssignmentKey(lines[i])
    if (assignmentKey === key) return i
  }
  return -1
}

function preferredTomlRootInsertionIndex(lines: string[], key: string): number {
  if (key === "model") {
    const providerIndex = findTomlRootAssignmentIndex(lines, "model_provider")
    return providerIndex >= 0 ? providerIndex : 0
  }
  let insertAt = findTomlRootEndIndex(lines)
  while (insertAt > 0 && lines[insertAt - 1].trim() === "") {
    insertAt -= 1
  }
  return insertAt
}

function updateTomlRootStringKey(
  configTomlText: string,
  key: string,
  value: string
): string {
  const lineText = `${key} = ${JSON.stringify(value)}`
  const lines = configTomlText.split(/\r?\n/)
  const assignmentIndex = findTomlRootAssignmentIndex(lines, key)

  const nextValue = value.trim()
  if (!nextValue) {
    if (assignmentIndex >= 0) {
      lines.splice(assignmentIndex, 1)
    }
    return lines.join("\n").trim()
  }

  const insertAt = preferredTomlRootInsertionIndex(lines, key)
  if (assignmentIndex >= 0) {
    lines[assignmentIndex] = lineText
  } else {
    lines.splice(Math.max(0, insertAt), 0, lineText)
  }
  return lines.join("\n").trim()
}

function updateTomlRootBooleanKey(
  configTomlText: string,
  key: string,
  value: boolean
): string {
  const lineText = `${key} = ${value ? "true" : "false"}`
  const lines = configTomlText.split(/\r?\n/)
  const assignmentIndex = findTomlRootAssignmentIndex(lines, key)
  if (assignmentIndex >= 0) {
    lines[assignmentIndex] = lineText
  } else {
    lines.splice(0, 0, lineText)
  }
  return lines.join("\n").trim()
}

function findTomlSectionRange(
  lines: string[],
  sectionName: string
): { start: number; end: number } | null {
  let sectionStart = -1
  let sectionEnd = lines.length
  for (let i = 0; i < lines.length; i += 1) {
    if (sectionStart < 0) {
      if (tomlSectionHeaderName(lines[i]) === sectionName) {
        sectionStart = i
      }
      continue
    }
    if (isTomlSectionHeader(lines[i])) {
      sectionEnd = i
      break
    }
  }
  if (sectionStart < 0) return null
  return { start: sectionStart, end: sectionEnd }
}

function removeTomlSection(
  configTomlText: string,
  sectionName: string
): string {
  const lines = configTomlText.split(/\r?\n/)
  const range = findTomlSectionRange(lines, sectionName)
  if (!range) return configTomlText
  // Remove blank line before section header if present
  const removeStart =
    range.start > 0 && lines[range.start - 1].trim() === ""
      ? range.start - 1
      : range.start
  lines.splice(removeStart, range.end - removeStart)
  return lines.join("\n").trim()
}

/**
 * Drop any ROOT-level `<section>.<key> = …` line — the dotted spelling of the
 * very key this upsert is about to write into `[section]`.
 *
 * TOML treats `features.skills = true` and `[features]` + `skills = true` as
 * the same key, but they cannot coexist: the dotted form defines the `features`
 * table implicitly, so a later `[features]` header is a hard
 * "trying to redefine an already defined table" parse error. Leaving the dotted
 * line in place therefore breaks both directions — turning the switch OFF would
 * not remove the value the reader still sees (the control snaps back), and
 * turning it ON would emit a config.toml the backend refuses to persist.
 *
 * Only lines above the FIRST section header are considered: inside
 * `[model_providers.codeg]`, `features.skills` means
 * `model_providers.codeg.features.skills`, an unrelated key we must not touch.
 */
function stripRootDottedKey(
  lines: string[],
  sectionName: string,
  key: string
): void {
  const dotted = `${sectionName}.${key}`
  for (let i = 0; i < lines.length; i += 1) {
    if (isTomlSectionHeader(lines[i])) return
    if (parseTomlAssignmentKey(lines[i]) === dotted) {
      lines.splice(i, 1)
      i -= 1
    }
  }
}

/**
 * Index of the last ROOT-level `<section>.…` dotted assignment, or -1.
 *
 * A surviving sibling means the root table already defines `[section]`
 * implicitly, so emitting a `[section]` header would be a redefinition. Writing
 * the new key in the same dotted spelling keeps the document valid and leaves
 * the sibling — someone else's setting — exactly where the user put it.
 */
function lastRootDottedSiblingIndex(
  lines: string[],
  sectionName: string
): number {
  const prefix = `${sectionName}.`
  let last = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (isTomlSectionHeader(lines[i])) break
    if (parseTomlAssignmentKey(lines[i])?.startsWith(prefix)) last = i
  }
  return last
}

function upsertTomlSectionBooleanKey(
  configTomlText: string,
  sectionName: string,
  key: string,
  value: boolean | null
): string {
  const lines = configTomlText.split(/\r?\n/)
  stripRootDottedKey(lines, sectionName, key)
  const section = findTomlSectionRange(lines, sectionName)

  if (section) {
    let assignmentIndex = -1
    for (let i = section.start + 1; i < section.end; i += 1) {
      const assignmentKey = parseTomlAssignmentKey(lines[i])
      if (assignmentKey === key) {
        assignmentIndex = i
        break
      }
    }

    if (value === null) {
      if (assignmentIndex >= 0) {
        lines.splice(assignmentIndex, 1)
      }
      const refreshedSection = findTomlSectionRange(lines, sectionName)
      if (refreshedSection) {
        const hasEntries = lines
          .slice(refreshedSection.start + 1, refreshedSection.end)
          .some((rawLine) => {
            const line = rawLine.trim()
            return line !== "" && !line.startsWith("#")
          })
        if (!hasEntries) {
          const before = lines.slice(0, refreshedSection.start)
          const after = lines.slice(refreshedSection.end)
          while (before.length > 0 && before[before.length - 1].trim() === "") {
            before.pop()
          }
          while (after.length > 0 && after[0].trim() === "") {
            after.shift()
          }
          const merged =
            before.length > 0 && after.length > 0
              ? [...before, "", ...after]
              : [...before, ...after]
          return merged.join("\n").trim()
        }
      }
      return lines.join("\n").trim()
    }

    const lineText = `${key} = ${value ? "true" : "false"}`
    if (assignmentIndex >= 0) {
      lines[assignmentIndex] = lineText
    } else {
      let insertAt = section.end
      for (let i = section.end - 1; i > section.start; i -= 1) {
        if (lines[i].trim() !== "") {
          insertAt = i + 1
          break
        }
      }
      lines.splice(insertAt, 0, lineText)
    }
    return lines.join("\n").trim()
  }

  // No `[section]` to edit. Removing is still not a no-op: a root-level dotted
  // spelling of this key may have just been stripped above, and that IS the
  // value the reader was showing.
  if (value === null) {
    return lines.join("\n").trim()
  }

  const lineText = `${key} = ${value ? "true" : "false"}`

  // The root table may already define this section through a dotted sibling we
  // must not touch (`features.skills = true` while we write
  // `features.default_mode_request_user_input`). Join it in its own spelling
  // rather than opening a header that would redefine the table.
  const sibling = lastRootDottedSiblingIndex(lines, sectionName)
  if (sibling >= 0) {
    lines.splice(sibling + 1, 0, `${sectionName}.${lineText}`)
    return lines.join("\n").trim()
  }

  const insertAt = findTomlRootEndIndex(lines)
  const prefixBlank =
    insertAt > 0 && lines[insertAt - 1].trim() !== "" ? [""] : []
  const suffixBlank =
    insertAt < lines.length && lines[insertAt].trim() !== "" ? [""] : []
  lines.splice(
    insertAt,
    0,
    ...prefixBlank,
    `[${sectionName}]`,
    lineText,
    ...suffixBlank
  )
  return lines.join("\n").trim()
}

function patchCodexProviderBaseUrl(
  configTomlText: string,
  provider: string,
  apiBaseUrl: string
): string {
  const trimmedProvider = provider.trim()
  if (!trimmedProvider) return configTomlText.trim()

  const nextApiBaseUrl = apiBaseUrl.trim()
  const lines = configTomlText.split(/\r?\n/)
  const sectionPattern = new RegExp(
    `^\\[\\s*model_providers\\.${escapeRegExp(trimmedProvider)}\\s*\\]$`
  )
  let sectionStart = -1
  let sectionEnd = lines.length
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim()
    if (sectionStart < 0) {
      if (sectionPattern.test(trimmed)) {
        sectionStart = i
      }
      continue
    }
    if (/^\[.*\]$/.test(trimmed)) {
      sectionEnd = i
      break
    }
  }

  if (sectionStart >= 0) {
    let baseUrlIndex = -1
    for (let i = sectionStart + 1; i < sectionEnd; i += 1) {
      const assignment = parseTomlStringAssignment(lines[i])
      if (!assignment || assignment.key !== "base_url") continue
      baseUrlIndex = i
      break
    }
    if (!nextApiBaseUrl) {
      if (baseUrlIndex >= 0) {
        lines.splice(baseUrlIndex, 1)
      }
      return lines.join("\n").trim()
    }

    const lineText = `base_url = ${JSON.stringify(nextApiBaseUrl)}`
    if (baseUrlIndex >= 0) {
      lines[baseUrlIndex] = lineText
    } else {
      lines.splice(sectionEnd, 0, lineText)
    }
    return lines.join("\n").trim()
  }

  if (!nextApiBaseUrl) return configTomlText.trim()

  const appended = configTomlText.trimEnd()
  const sectionText = `[model_providers.${trimmedProvider}]\nbase_url = ${JSON.stringify(nextApiBaseUrl)}`
  if (!appended) return sectionText
  return `${appended}\n\n${sectionText}`.trim()
}

function patchCodexProviderField(
  configTomlText: string,
  provider: string,
  key: string,
  lineText: string
): string {
  const trimmedProvider = provider.trim()
  if (!trimmedProvider) return configTomlText.trim()

  const lines = configTomlText.split(/\r?\n/)
  const sectionPattern = new RegExp(
    `^\\[\\s*model_providers\\.${escapeRegExp(trimmedProvider)}\\s*\\]$`
  )
  let sectionStart = -1
  let sectionEnd = lines.length
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim()
    if (sectionStart < 0) {
      if (sectionPattern.test(trimmed)) {
        sectionStart = i
      }
      continue
    }
    if (/^\[.*\]$/.test(trimmed)) {
      sectionEnd = i
      break
    }
  }

  if (sectionStart >= 0) {
    let fieldIndex = -1
    for (let i = sectionStart + 1; i < sectionEnd; i += 1) {
      const assignmentKey = parseTomlAssignmentKey(lines[i])
      if (assignmentKey !== key) continue
      fieldIndex = i
      break
    }
    if (fieldIndex >= 0) {
      lines[fieldIndex] = lineText
    } else {
      let insertAt = sectionEnd
      while (insertAt > sectionStart + 1 && lines[insertAt - 1].trim() === "") {
        insertAt -= 1
      }
      lines.splice(insertAt, 0, lineText)
    }
    return lines.join("\n").trim()
  }

  const appended = configTomlText.trimEnd()
  const sectionText = `[model_providers.${trimmedProvider}]\n${lineText}`
  if (!appended) return sectionText
  return `${appended}\n\n${sectionText}`.trim()
}

/**
 * Result of reading `[model_providers.<provider>]` out of a config.toml draft.
 * "table absent" and "document unparsable" are deliberately distinct: an absent
 * table is a brand-new provider we should seed, a document we cannot parse is
 * one we must not touch.
 */
type CodexProviderTableRead =
  | { status: "ok"; table: Record<string, unknown> | null }
  | { status: "unparsable" }

/**
 * Read-only view of one provider table. Every *write* in this file stays
 * text-based so user comments and key order survive; only the "is this field
 * already declared?" question goes through a real parser, because answering it
 * from text needs full TOML semantics — quoted keys containing dots, escape
 * decoding, dotted keys and inline tables — that a line scanner cannot supply.
 */
function readCodexProviderTable(
  configTomlText: string,
  provider: string
): CodexProviderTableRead {
  const name = provider.trim()
  if (!name) return { status: "unparsable" }
  let parsed: unknown
  try {
    parsed = parseTomlDocument(configTomlText)
  } catch {
    return { status: "unparsable" }
  }
  if (!parsed || typeof parsed !== "object") return { status: "unparsable" }
  const providers = (parsed as Record<string, unknown>).model_providers
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
    return { status: "ok", table: null }
  }
  const table = (providers as Record<string, unknown>)[name]
  if (!table || typeof table !== "object" || Array.isArray(table)) {
    return { status: "ok", table: null }
  }
  return { status: "ok", table: table as Record<string, unknown> }
}

/**
 * Mirrors the header half of codex's
 * `ModelProviderInfo::uses_openai_actor_authorization`. The ASCII-only fold
 * matches its `eq_ignore_ascii_case`.
 */
function codexProviderUsesActorAuthorization(
  table: Record<string, unknown> | null
): boolean {
  const headers = table?.http_headers
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return false
  }
  return Object.entries(headers as Record<string, unknown>).some(
    ([name, value]) =>
      name.replace(/[A-Z]/g, (char) => char.toLowerCase()) ===
        CODEX_ACTOR_AUTHORIZATION_HEADER &&
      typeof value === "string" &&
      value.trim() !== ""
  )
}

function ensureCodexProviderDefaults(
  configTomlText: string,
  provider: string
): string {
  if (provider.trim() !== CODEX_DEFAULT_MODEL_PROVIDER) {
    return configTomlText
  }
  let next = configTomlText
  const current = extractCodexTomlImportantValues(next)
  const codegBaseUrl =
    current.providerBaseUrls[CODEX_DEFAULT_MODEL_PROVIDER] ?? ""
  next = patchCodexProviderField(
    next,
    CODEX_DEFAULT_MODEL_PROVIDER,
    "base_url",
    `base_url = ${JSON.stringify(codegBaseUrl)}`
  )
  next = patchCodexProviderField(
    next,
    CODEX_DEFAULT_MODEL_PROVIDER,
    "name",
    'name = "codeg"'
  )
  next = patchCodexProviderField(
    next,
    CODEX_DEFAULT_MODEL_PROVIDER,
    "wire_api",
    'wire_api = "responses"'
  )
  // `requires_openai_auth` is the one managed field a user legitimately owns:
  // codex defaults it to false, and its `uses_openai_actor_authorization()`
  // requires `!requires_openai_auth`, so forcing true silently disables the
  // actor-authorization path. Supply codeg's default only when the provider
  // does not already declare it — true is right for a provider *we* created
  // (key in auth.json, no env_key), never for one the user configured.
  // Read the original text: the three patches above never touch
  // `requires_openai_auth` or `http_headers`, and the original is what the
  // user actually authored.
  const read = readCodexProviderTable(
    configTomlText,
    CODEX_DEFAULT_MODEL_PROVIDER
  )
  const providerTable = read.status === "ok" ? read.table : null
  const alreadyDeclared =
    read.status !== "ok" ||
    (providerTable !== null &&
      Object.prototype.hasOwnProperty.call(
        providerTable,
        "requires_openai_auth"
      ))
  if (!alreadyDeclared && !codexProviderUsesActorAuthorization(providerTable)) {
    next = patchCodexProviderField(
      next,
      CODEX_DEFAULT_MODEL_PROVIDER,
      "requires_openai_auth",
      "requires_openai_auth = true"
    )
  }
  return next
}

function patchCodexAuthJsonText(
  authJsonText: string,
  patch: { apiKey?: string; authMode?: "chatgpt" | null }
): {
  authJsonText: string
  recoveredFromInvalid: boolean
} {
  const parsed = parseCodexAuthJsonObject(authJsonText)
  const authObject =
    parsed.error === null && parsed.authObject ? { ...parsed.authObject } : {}
  if (typeof patch.apiKey === "string") {
    const apiKey = patch.apiKey.trim()
    if (apiKey) {
      authObject.OPENAI_API_KEY = apiKey
      delete authObject.API_KEY
    } else {
      delete authObject.OPENAI_API_KEY
      delete authObject.OPENAI_API_TOKEN
      delete authObject.API_KEY
    }
  }
  if ("authMode" in patch) {
    if (patch.authMode === "chatgpt") {
      authObject.auth_mode = "chatgpt"
      authObject.OPENAI_API_KEY = null
    } else {
      delete authObject.auth_mode
    }
  }
  return {
    authJsonText:
      Object.keys(authObject).length === 0
        ? ""
        : JSON.stringify(authObject, null, 2),
    recoveredFromInvalid: Boolean(parsed.error),
  }
}

export function patchCodexConfigTomlText(
  configTomlText: string,
  patch: {
    apiBaseUrl?: string
    model?: string
    modelProvider?: string
    supportsWebsockets?: boolean
    skills?: boolean
    defaultModeRequestUserInput?: boolean
    serviceTierFast?: boolean
  }
): string {
  let nextTomlText = configTomlText
  if (typeof patch.modelProvider === "string") {
    const modelProvider = patch.modelProvider.trim()
    if (modelProvider) {
      nextTomlText = updateTomlRootStringKey(
        nextTomlText,
        "model_provider",
        modelProvider
      )
      nextTomlText = ensureCodexProviderDefaults(nextTomlText, modelProvider)
    }
  }
  if (typeof patch.model === "string") {
    nextTomlText = updateTomlRootStringKey(nextTomlText, "model", patch.model)
  }
  if (typeof patch.apiBaseUrl === "string") {
    const tomlValues = extractCodexTomlImportantValues(nextTomlText)
    const modelProvider =
      patch.modelProvider?.trim() ||
      tomlValues.modelProvider.trim() ||
      CODEX_DEFAULT_MODEL_PROVIDER
    if (!tomlValues.modelProvider.trim() && patch.apiBaseUrl.trim()) {
      nextTomlText = updateTomlRootStringKey(
        nextTomlText,
        "model_provider",
        modelProvider
      )
    }
    nextTomlText = patchCodexProviderBaseUrl(
      nextTomlText,
      modelProvider,
      patch.apiBaseUrl
    )
    nextTomlText = ensureCodexProviderDefaults(nextTomlText, modelProvider)
  }
  if (typeof patch.supportsWebsockets === "boolean") {
    const tomlValues = extractCodexTomlImportantValues(nextTomlText)
    const modelProvider =
      patch.modelProvider?.trim() ||
      tomlValues.modelProvider.trim() ||
      CODEX_DEFAULT_MODEL_PROVIDER
    if (!tomlValues.modelProvider.trim()) {
      nextTomlText = updateTomlRootStringKey(
        nextTomlText,
        "model_provider",
        modelProvider
      )
    }
    nextTomlText = patchCodexProviderField(
      nextTomlText,
      modelProvider,
      "supports_websockets",
      `supports_websockets = ${patch.supportsWebsockets ? "true" : "false"}`
    )
    nextTomlText = ensureCodexProviderDefaults(nextTomlText, modelProvider)
  }
  const normalizedTomlValues = extractCodexTomlImportantValues(nextTomlText)
  if (normalizedTomlValues.model.trim()) {
    nextTomlText = updateTomlRootStringKey(
      nextTomlText,
      "model",
      normalizedTomlValues.model
    )
  }
  const activeProvider =
    normalizedTomlValues.modelProvider.trim() || CODEX_DEFAULT_MODEL_PROVIDER
  // This key is rewritten on EVERY patch, including ones that have nothing to
  // do with WebSockets, so it must resolve the flag exactly the way
  // `extractCodexImportantValues` does — including its fallback to the feature
  // key itself when the provider declares no `supports_websockets`. Reading
  // only the provider field would treat "declared solely as a feature flag" as
  // "off" and delete the user's setting the next time any other control moved.
  // `??` and not `||`: an explicit `false` on the provider must win over the
  // fallback, which is how the WebSocket switch turns itself off.
  const shouldEnableFeature =
    normalizedTomlValues.providerSupportsWebsockets[activeProvider] ??
    (activeProvider === CODEX_DEFAULT_MODEL_PROVIDER
      ? normalizedTomlValues.featureResponsesWebsocketsV2
      : false)
  nextTomlText = upsertTomlSectionBooleanKey(
    nextTomlText,
    "features",
    "responses_websockets_v2",
    shouldEnableFeature ? true : null
  )
  if (typeof patch.skills === "boolean") {
    nextTomlText = upsertTomlSectionBooleanKey(
      nextTomlText,
      "features",
      "skills",
      patch.skills ? true : null
    )
  }
  if (typeof patch.defaultModeRequestUserInput === "boolean") {
    // Upstream default is false, so "off" removes the key instead of writing
    // `= false` — same contract as `skills` above, and it keeps config.toml
    // free of a flag the user never opted into.
    nextTomlText = upsertTomlSectionBooleanKey(
      nextTomlText,
      "features",
      CODEX_DEFAULT_MODE_REQUEST_USER_INPUT_KEY,
      patch.defaultModeRequestUserInput ? true : null
    )
  }
  if (typeof patch.serviceTierFast === "boolean") {
    nextTomlText = updateTomlRootStringKey(
      nextTomlText,
      "service_tier",
      patch.serviceTierFast ? "fast" : ""
    )
  }
  nextTomlText = updateTomlRootBooleanKey(
    nextTomlText,
    "disable_response_storage",
    true
  )
  const trimmed = nextTomlText.trim()
  return trimmed ? `${trimmed}\n` : ""
}

/**
 * Build the Grok structured-config save payload from the draft's dropdown
 * fields. An empty draft field (the "unset / use default" choice) maps to
 * `null` — which the backend treats as "remove this key" — while a chosen value
 * passes through. This is the single seam that encodes the unset→remove contract
 * for the two managed keys.
 */
export function buildGrokStructuredConfig(draft: {
  grokAuthMode: GrokAuthMethod
  grokPermissionMode: string
  grokReasoningEffort: string
  grokCustomModelId: string
  grokCustomBaseUrl: string
  grokCustomApiKey: string
  grokCustomApiBackend: string
  grokCustomContextWindow: string
  grokAutoCompactThreshold: string
}): GrokStructuredConfig {
  // The custom-model group applies only in the `custom` auth method; the
  // subscription / api_key methods omit the codeg-managed [model.<id>] block
  // (an empty id → the backend removes it). Permission mode, reasoning effort
  // and compaction below stay independent of the auth method.
  const modelId =
    draft.grokAuthMode === "custom" ? draft.grokCustomModelId.trim() : ""
  const positiveInt = (raw: string): number | null => {
    const n = Number.parseInt(raw.trim(), 10)
    return Number.isFinite(n) && n > 0 ? n : null
  }
  const percent = (raw: string): number | null => {
    const trimmed = raw.trim()
    if (!trimmed) return null
    const n = Number.parseInt(trimmed, 10)
    return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : null
  }
  return {
    permissionMode: draft.grokPermissionMode || null,
    defaultReasoningEffort: draft.grokReasoningEffort || null,
    customModelId: modelId || null,
    // The model-scoped fields only matter when a model id is set; the backend
    // writes them inside the [model.<id>] block. api_backend defaults to
    // `responses` (Grok's build backend) whenever a model is configured.
    customBaseUrl: modelId ? draft.grokCustomBaseUrl.trim() || null : null,
    customApiKey: modelId ? draft.grokCustomApiKey.trim() || null : null,
    customApiBackend: modelId
      ? draft.grokCustomApiBackend || GROK_DEFAULT_API_BACKEND
      : null,
    customContextWindow: modelId
      ? positiveInt(draft.grokCustomContextWindow)
      : null,
    // Compaction is session-global, independent of the custom model.
    autoCompactThresholdPercent: percent(draft.grokAutoCompactThreshold),
  }
}

/**
 * Build the Grok save `persistConfig` options from the draft. The structured
 * controls always merge; the raw config.toml text is only sent when the user
 * actually edited it (dirty) — otherwise the backend merges the structured
 * controls onto the CURRENT on-disk file (never a stale in-memory snapshot). One
 * save persists both surfaces together, so there is no independent save that
 * could discard the other surface's unsaved edits.
 */
export function buildGrokSaveOptions(
  draft: {
    grokAuthMode: GrokAuthMethod
    grokPermissionMode: string
    grokReasoningEffort: string
    grokCustomModelId: string
    grokCustomBaseUrl: string
    grokCustomApiKey: string
    grokCustomApiBackend: string
    grokCustomContextWindow: string
    grokAutoCompactThreshold: string
    grokConfigTomlText: string
  },
  agentGrokConfigToml: string | null
): { grokStructured: GrokStructuredConfig; grokConfigTomlText?: string } {
  const rawDirty = draft.grokConfigTomlText !== (agentGrokConfigToml ?? "")
  return {
    grokStructured: buildGrokStructuredConfig(draft),
    ...(rawDirty ? { grokConfigTomlText: draft.grokConfigTomlText } : {}),
  }
}

export function patchImportantConfigText(
  agentType: AgentType,
  configText: string,
  patch: ImportantDraftPatch
): {
  configText: string
  recoveredFromInvalid: boolean
} {
  const parseResult = parseConfigJsonText(configText)
  const config = parseResult.error ? {} : { ...parseResult.config }

  const assignOrRemove = (key: string, value: string | undefined) => {
    const trimmed = value?.trim() ?? ""
    if (!trimmed) {
      delete config[key]
      return
    }
    config[key] = trimmed
  }

  if (agentType === "claude_code") {
    // Claude Code: write apiBaseUrl/apiKey into config.env, not root
    const env =
      typeof config.env === "object" && config.env && !Array.isArray(config.env)
        ? { ...(config.env as Record<string, unknown>) }
        : {}
    const assignEnv = (key: string, value: string | undefined) => {
      const trimmed = value?.trim() ?? ""
      if (!trimmed) {
        delete env[key]
        return
      }
      env[key] = trimmed
    }
    // Remove root-level apiBaseUrl/apiKey if present (legacy cleanup)
    delete config.apiBaseUrl
    delete config.apiKey
    assignEnv("ANTHROPIC_BASE_URL", patch.apiBaseUrl)
    assignEnv("ANTHROPIC_AUTH_TOKEN", patch.apiKey)

    assignEnv(CLAUDE_MODEL_ENV_KEYS.claudeMainModel, patch.claudeMainModel)
    assignEnv(
      CLAUDE_MODEL_ENV_KEYS.claudeReasoningModel,
      patch.claudeReasoningModel
    )
    assignEnv(
      CLAUDE_MODEL_ENV_KEYS.claudeDefaultHaikuModel,
      patch.claudeDefaultHaikuModel
    )
    assignEnv(
      CLAUDE_MODEL_ENV_KEYS.claudeDefaultSonnetModel,
      patch.claudeDefaultSonnetModel
    )
    assignEnv(
      CLAUDE_MODEL_ENV_KEYS.claudeDefaultOpusModel,
      patch.claudeDefaultOpusModel
    )
    assignEnv(
      CLAUDE_MODEL_ENV_KEYS.claudeCustomModelOption,
      patch.claudeCustomModelOption
    )
    assignEnv(
      CLAUDE_MODEL_ENV_KEYS.claudeCustomModelOptionName,
      patch.claudeCustomModelOptionName
    )
    assignEnv(
      CLAUDE_MODEL_ENV_KEYS.claudeCustomModelOptionDescription,
      patch.claudeCustomModelOptionDescription
    )

    if (Object.keys(env).length === 0) {
      delete config.env
    } else {
      config.env = env
    }
  } else {
    assignOrRemove("apiBaseUrl", patch.apiBaseUrl)
    assignOrRemove("apiKey", patch.apiKey)
    assignOrRemove("model", patch.model)
  }

  return {
    configText:
      Object.keys(config).length === 0 ? "" : JSON.stringify(config, null, 2),
    recoveredFromInvalid: Boolean(parseResult.error),
  }
}

/**
 * Make a Claude agent's native config provider-authoritative. When a provider
 * was bound in an earlier session, the on-disk config loaded into the draft can
 * still carry stale model keys (e.g. a leftover ANTHROPIC_CUSTOM_MODEL_OPTION)
 * that no longer match the provider — `handleModelProviderSelect` only rewrites
 * configText when the dropdown changes, not on reload. A config-management save
 * would otherwise persist that stale text back over the backend bind cascade, so
 * re-derive the provider-controlled keys here (empty => cleared by `assignEnv`)
 * before saving. Unrelated config/env keys are preserved.
 */
export function applyClaudeProviderToConfigText(
  configText: string,
  provider: Pick<ModelProviderInfo, "api_url" | "api_key" | "model">
): string {
  const model = parseClaudeProviderModel(provider.model ?? null)
  return patchImportantConfigText("claude_code", configText, {
    apiBaseUrl: provider.api_url,
    apiKey: provider.api_key,
    claudeMainModel: model.main ?? "",
    claudeReasoningModel: model.reasoning ?? "",
    claudeDefaultHaikuModel: model.haiku ?? "",
    claudeDefaultSonnetModel: model.sonnet ?? "",
    claudeDefaultOpusModel: model.opus ?? "",
    claudeCustomModelOption: model.customOption ?? "",
    claudeCustomModelOptionName: model.customOptionName ?? "",
    claudeCustomModelOptionDescription: model.customOptionDescription ?? "",
  }).configText
}

/**
 * Decide the config text to persist for a config-management save. For a bound
 * Claude agent with VALID config JSON, rewrite the provider-controlled keys to be
 * provider-authoritative (see {@link applyClaudeProviderToConfigText}). Anything
 * else — non-Claude, unbound, or INVALID JSON — passes through unchanged. The
 * invalid-JSON passthrough is important: persistConfig must still surface the
 * parse error, otherwise patchImportantConfigText would silently recover the bad
 * text as `{}` and persist provider-derived config over the user's broken edits.
 */
export function configTextForClaudeSave(
  configText: string,
  agentType: AgentType,
  modelProviderId: number | null,
  provider: Pick<ModelProviderInfo, "api_url" | "api_key" | "model"> | undefined
): string {
  if (
    agentType === "claude_code" &&
    modelProviderId != null &&
    provider &&
    !parseConfigJsonText(configText).error
  ) {
    return applyClaudeProviderToConfigText(configText, provider)
  }
  return configText
}

/**
 * Set a Claude Code env flag to an explicit value inside the native config's
 * `env` (creating `env` if needed), preserving all other keys. Used by the
 * hardening toggles and their save-time materialization so the flag is always
 * written explicitly ("1"/"0") rather than left implicit/absent. Pure — shared
 * by the toggle handler, the save path, and tests.
 */
export function setClaudeEnvFlagInConfigText(
  configText: string,
  envKey: string,
  value: string
): { configText: string; recoveredFromInvalid: boolean } {
  const parseResult = parseConfigJsonText(configText)
  const config: Record<string, unknown> = parseResult.error
    ? {}
    : { ...parseResult.config }
  const env =
    typeof config.env === "object" && config.env && !Array.isArray(config.env)
      ? { ...(config.env as Record<string, unknown>) }
      : {}
  env[envKey] = value
  config.env = env
  return {
    configText: JSON.stringify(config, null, 2),
    recoveredFromInvalid: Boolean(parseResult.error),
  }
}

/**
 * Materialize both Claude hardening toggles into the native config `env` AND the
 * DB env overlay (envText), writing the explicit "1"/"0" per toggle so the shown
 * default positions are actually applied on save. Returns the inputs UNCHANGED
 * when `configText` is invalid JSON — never recover it here, or the caller's
 * merge diff would treat the recovered minimal config as authoritative and
 * delete every other on-disk key. Pure — shared by the save handler and tests.
 */
export function materializeClaudeHardeningFlags(
  configText: string,
  envText: string,
  flags: { sendAttributionHeader: boolean; disableNonessentialTraffic: boolean }
): { configText: string; envText: string } {
  if (parseConfigJsonText(configText).error) {
    return { configText, envText }
  }
  const entries: Array<[string, boolean]> = [
    [CLAUDE_ATTRIBUTION_HEADER_ENV_KEY, flags.sendAttributionHeader],
    [CLAUDE_NONESSENTIAL_TRAFFIC_ENV_KEY, flags.disableNonessentialTraffic],
  ]
  let nextConfig = configText
  let nextEnv = envText
  for (const [key, on] of entries) {
    const value = on ? CLAUDE_ENV_FLAG_ON : CLAUDE_ENV_FLAG_OFF
    nextConfig = setClaudeEnvFlagInConfigText(nextConfig, key, value).configText
    nextEnv = patchEnvText(nextEnv, { [key]: value })
  }
  return { configText: nextConfig, envText: nextEnv }
}

export function patchEnvByImportantKey(
  agentType: AgentType,
  envText: string,
  key: ImportantConfigKey,
  value: string
): string {
  const keys = importantEnvKeysByAgent(agentType)
  // The FIRST key of each list is the one codeg writes; the rest are aliases it
  // only reads. An agent that has no env var for a slot leaves that list empty,
  // and `[0]` is then `undefined` — which `patchEnvText` would happily write as
  // an env var literally named `undefined`, silently swallowing what the user
  // typed. `writeKey` turns that into a no-op instead; the field is also hidden
  // (see `importantFieldsFor`), so this is the belt to that suspenders.
  const writeKey = (candidates: string[]): string | undefined => candidates[0]
  const patch = (candidates: string[]): string => {
    const target = writeKey(candidates)
    return target ? patchEnvText(envText, { [target]: value }) : envText
  }
  if (key === "apiBaseUrl") {
    return patch(keys.apiBaseUrl)
  }
  if (key === "apiKey") {
    return patch(keys.apiKey)
  }
  if (key === "model") {
    return patch(keys.model)
  }
  return patchEnvText(envText, { [CLAUDE_MODEL_ENV_KEYS[key]]: value })
}

function applyImportantFieldToDraft(
  draft: AgentDraft,
  key: ImportantConfigKey,
  value: string
): AgentDraft {
  if (key === "apiBaseUrl") return { ...draft, apiBaseUrl: value }
  if (key === "apiKey") return { ...draft, apiKey: value }
  if (key === "model") return { ...draft, model: value }
  if (key === "claudeMainModel") return { ...draft, claudeMainModel: value }
  if (key === "claudeReasoningModel") {
    return { ...draft, claudeReasoningModel: value }
  }
  if (key === "claudeDefaultHaikuModel") {
    return { ...draft, claudeDefaultHaikuModel: value }
  }
  if (key === "claudeDefaultSonnetModel") {
    return { ...draft, claudeDefaultSonnetModel: value }
  }
  if (key === "claudeDefaultOpusModel") {
    return { ...draft, claudeDefaultOpusModel: value }
  }
  if (key === "claudeCustomModelOption") {
    return { ...draft, claudeCustomModelOption: value }
  }
  if (key === "claudeCustomModelOptionName") {
    return { ...draft, claudeCustomModelOptionName: value }
  }
  return { ...draft, claudeCustomModelOptionDescription: value }
}

function buildImportantPatchFromDraft(draft: AgentDraft): ImportantDraftPatch {
  return {
    apiBaseUrl: draft.apiBaseUrl,
    apiKey: draft.apiKey,
    model: draft.model,
    claudeMainModel: draft.claudeMainModel,
    claudeReasoningModel: draft.claudeReasoningModel,
    claudeDefaultHaikuModel: draft.claudeDefaultHaikuModel,
    claudeDefaultSonnetModel: draft.claudeDefaultSonnetModel,
    claudeDefaultOpusModel: draft.claudeDefaultOpusModel,
    claudeCustomModelOption: draft.claudeCustomModelOption,
    claudeCustomModelOptionName: draft.claudeCustomModelOptionName,
    claudeCustomModelOptionDescription:
      draft.claudeCustomModelOptionDescription,
  }
}

interface HermesDraftValues {
  provider: string
  model: string
  baseUrl: string
  apiKey: string
  hermesHome: string
  setupCommand: string
  modelCommand: string
}

/**
 * Parse the normalized Hermes projection carried in `AcpAgentInfo.config_json`
 * (produced by the backend from ~/.hermes/.env + config.yaml). Falls back to a
 * sensible default provider when nothing is configured yet.
 */
function parseHermesConfig(configText: string): HermesDraftValues {
  let parsed: HermesLocalConfig = {}
  if (configText.trim()) {
    try {
      parsed = JSON.parse(configText) as HermesLocalConfig
    } catch {
      parsed = {}
    }
  }
  return {
    provider: parsed.provider ?? "openrouter",
    model: parsed.model ?? "",
    baseUrl: parsed.baseUrl ?? "",
    apiKey: parsed.apiKey ?? "",
    hermesHome: parsed.hermesHome ?? "",
    setupCommand: parsed.setupCommand ?? "",
    modelCommand: parsed.modelCommand ?? "",
  }
}

function buildAgentDraft(agent: AcpAgentInfo): AgentDraft {
  const configText =
    typeof agent.config_json === "string" && agent.config_json.trim()
      ? agent.config_json
      : ""
  const hermesValues =
    agent.agent_type === "hermes" ? parseHermesConfig(configText) : null
  const openCodeAuthJsonText = agent.opencode_auth_json ?? ""
  const codexAuthJsonText = agent.codex_auth_json ?? ""
  const codexConfigTomlText =
    agent.agent_type === "codex"
      ? updateTomlRootBooleanKey(
          agent.codex_config_toml ?? "",
          "disable_response_storage",
          true
        )
      : (agent.codex_config_toml ?? "")
  const codexSandbox = agent.codex_sandbox_settings ?? null
  // Seeded once, then fingerprinted, so a save can tell a real control change
  // from "untouched, still whatever config.toml says".
  const codexSandboxFields: CodexSandboxDraftFields = {
    // The granular table and the string presets are mutually exclusive upstream,
    // so a present table always wins the selector.
    codexApprovalPolicy: codexSandbox?.granular
      ? "granular"
      : ((codexSandbox?.approval_policy ??
          CODEX_SANDBOX_UNSET) as CodexApprovalPolicyChoice),
    codexGranular: codexSandbox?.granular ?? CODEX_GRANULAR_DEFAULT,
    codexSandboxMode: (codexSandbox?.sandbox_mode ??
      CODEX_SANDBOX_UNSET) as CodexSandboxModeChoice,
    codexWritableRootsText: (
      codexSandbox?.workspace_write.writable_roots ?? []
    ).join("\n"),
    codexNetworkAccess: codexSandbox?.workspace_write.network_access ?? false,
    codexExcludeTmpdirEnvVar:
      codexSandbox?.workspace_write.exclude_tmpdir_env_var ?? false,
    codexExcludeSlashTmp:
      codexSandbox?.workspace_write.exclude_slash_tmp ?? false,
  }
  const grokConfigTomlText = agent.grok_config_toml ?? ""
  const grokPermissionMode = agent.grok_settings?.permission_mode ?? ""
  const grokReasoningEffort =
    agent.grok_settings?.default_reasoning_effort ?? ""
  const important = extractImportantConfigValues(
    agent.agent_type,
    agent.env,
    configText
  )
  const geminiImportant = extractGeminiImportantValues(agent.env, configText)
  const openClawImportant = extractOpenClawImportantValues(
    agent.env,
    configText
  )
  const codexImportant = extractCodexImportantValues(
    codexAuthJsonText,
    codexConfigTomlText
  )
  const openCodeImportant = extractOpenCodeConfigValues(
    configText,
    openCodeAuthJsonText
  )
  const clineImportant = extractClineImportantValues(configText)
  const codexAuthMode: CodexAuthMode =
    agent.agent_type === "codex" && agent.model_provider_id != null
      ? "model_provider"
      : agent.agent_type === "codex"
        ? inferCodexAuthMode(codexAuthJsonText)
        : "api_key"
  const grokAuthMode: GrokAuthMethod =
    agent.agent_type === "grok"
      ? inferGrokMode(
          agent.env,
          Boolean(agent.grok_settings?.custom_model_id?.trim())
        )
      : "api_key"
  const rawEnvText = envMapToText(agent.env)
  // When codex is in official subscription mode, clean up API keys/URLs from env.
  // Grok mirrors this: record the auth-method knob, and in subscription mode
  // strip XAI_API_KEY so the editable env can't override the `grok login`
  // credential (the launch path enforces the same — see apply_grok_env_policy).
  const envText =
    agent.agent_type === "codex" && codexAuthMode === "chatgpt_subscription"
      ? patchEnvText(rawEnvText, {
          OPENAI_API_KEY: "",
          OPENAI_BASE_URL: "",
        })
      : agent.agent_type === "grok"
        ? patchEnvText(rawEnvText, {
            GROK_AUTH_MODE: grokAuthMode,
            ...(grokAuthMode === "subscription" ? { XAI_API_KEY: "" } : {}),
          })
        : rawEnvText
  return {
    enabled: agent.enabled,
    envText,
    configText,
    apiBaseUrl:
      agent.agent_type === "hermes"
        ? (hermesValues?.baseUrl ?? "")
        : agent.agent_type === "codex"
          ? codexImportant.apiBaseUrl
          : agent.agent_type === "gemini"
            ? geminiImportant.apiBaseUrl
            : important.apiBaseUrl,
    apiKey:
      agent.agent_type === "hermes"
        ? (hermesValues?.apiKey ?? "")
        : agent.agent_type === "codex"
          ? (codexImportant.apiKey ?? "")
          : agent.agent_type === "gemini"
            ? geminiImportant.geminiApiKey || geminiImportant.googleApiKey
            : important.apiKey,
    model:
      agent.agent_type === "hermes"
        ? (hermesValues?.model ?? "")
        : agent.agent_type === "codex"
          ? codexImportant.model
          : agent.agent_type === "gemini"
            ? geminiImportant.model
            : agent.agent_type === "open_code"
              ? openCodeImportant.model
              : important.model,
    claudeAuthMode:
      agent.agent_type === "claude_code" && agent.model_provider_id != null
        ? "model_provider"
        : agent.agent_type === "claude_code" &&
            (important.apiBaseUrl || important.apiKey)
          ? "custom"
          : "official_subscription",
    modelProviderId: agent.model_provider_id ?? null,
    geminiAuthMode:
      agent.agent_type === "gemini" && agent.model_provider_id != null
        ? "model_provider"
        : geminiImportant.authMode,
    geminiApiKey: geminiImportant.geminiApiKey,
    googleApiKey: geminiImportant.googleApiKey,
    googleCloudProject: geminiImportant.googleCloudProject,
    googleCloudLocation: geminiImportant.googleCloudLocation,
    googleApplicationCredentials: geminiImportant.googleApplicationCredentials,
    codexAuthMode,
    codexModelProvider: codexImportant.modelProvider,
    codexProviderOptions: codexImportant.providerOptions,
    codexSupportsWebsockets: codexImportant.supportsWebsockets,
    codexSkills: codexImportant.skills,
    codexDefaultModeRequestUserInput:
      codexImportant.defaultModeRequestUserInput,
    codexServiceTierFast: codexImportant.serviceTierFast,
    ...codexSandboxFields,
    codexSandboxBaseline: codexSandboxBaselineOf(codexSandboxFields),
    codexSandboxShadowed:
      codexSandbox?.shadowed_by_default_permissions ?? false,
    codexSandboxHasPermissionsTable:
      codexSandbox?.has_permissions_table ?? false,
    claudeMainModel: important.claudeMainModel,
    claudeReasoningModel: important.claudeReasoningModel,
    claudeDefaultHaikuModel: important.claudeDefaultHaikuModel,
    claudeDefaultSonnetModel: important.claudeDefaultSonnetModel,
    claudeDefaultOpusModel: important.claudeDefaultOpusModel,
    claudeCustomModelOption: important.claudeCustomModelOption,
    claudeCustomModelOptionName: important.claudeCustomModelOptionName,
    claudeCustomModelOptionDescription:
      important.claudeCustomModelOptionDescription,
    claudeSendAttributionHeader: important.claudeSendAttributionHeader,
    claudeDisableNonessentialTraffic:
      important.claudeDisableNonessentialTraffic,
    codexAuthJsonText,
    codexConfigTomlText,
    codexModelList: parseCodexModelConfig(agent.codex_model_catalog ?? null),
    grokConfigTomlText,
    grokAuthMode,
    grokPermissionMode,
    grokReasoningEffort,
    grokCustomModelId: agent.grok_settings?.custom_model_id ?? "",
    grokCustomBaseUrl: agent.grok_settings?.custom_base_url ?? "",
    grokCustomApiKey: agent.grok_settings?.custom_api_key ?? "",
    grokCustomApiBackend:
      agent.grok_settings?.custom_api_backend ?? GROK_DEFAULT_API_BACKEND,
    grokCustomContextWindow:
      agent.grok_settings?.custom_context_window != null
        ? String(agent.grok_settings.custom_context_window)
        : "",
    grokAutoCompactThreshold:
      agent.grok_settings?.auto_compact_threshold_percent != null
        ? String(agent.grok_settings.auto_compact_threshold_percent)
        : "",
    openCodeAuthJsonText,
    openClawGatewayUrl: openClawImportant.gatewayUrl,
    openClawGatewayToken: openClawImportant.gatewayToken,
    openClawSessionKey: openClawImportant.sessionKey,
    clineProvider: clineImportant.provider,
    clineApiKey: clineImportant.apiKey,
    clineModel: clineImportant.model,
    clineBaseUrl: clineImportant.baseUrl,
    hermesProvider: hermesValues?.provider ?? "openrouter",
    hermesConfigYaml: agent.hermes_config_yaml ?? "",
    hermesHome: hermesValues?.hermesHome ?? "",
    hermesSetupCommand: hermesValues?.setupCommand ?? "",
    hermesModelCommand: hermesValues?.modelCommand ?? "",
  }
}

function compareVersion(a: string, b: string): number {
  const toParts = (value: string): number[] => {
    const normalized = value.trim().replace(/^[^\d]*/, "")
    return normalized.split(".").map((part) => Number.parseInt(part, 10) || 0)
  }
  const left = toParts(a)
  const right = toParts(b)
  const len = Math.max(left.length, right.length)
  for (let i = 0; i < len; i += 1) {
    const lv = left[i] ?? 0
    const rv = right[i] ?? 0
    if (lv !== rv) return lv > rv ? 1 : -1
  }
  return 0
}

function hasComparableVersion(
  value: string | null | undefined
): value is string {
  return Boolean(value && /\d/.test(value) && value.includes("."))
}

// Mirror of the backend `sanitize_custom_version`: a custom install version
// tolerates a leading `v`, must start with a digit, must be dotted (e.g.
// `1.2.3`), and may only contain `[0-9A-Za-z.-+]` (semver pre-release/build +
// calendar versions). Rejects npm dist-tags like `latest`, bare majors like
// `2`, and anything with spaces / `@`.
function isValidCustomVersion(value: string): boolean {
  const normalized = value.trim().replace(/^[vV]/, "")
  return /^[0-9][0-9A-Za-z.\-+]*$/.test(normalized) && normalized.includes(".")
}

/**
 * The explainer card for agents whose codeg entry is a third-party ACP
 * *adapter* rather than the vendor's own CLI — Claude Code and Codex.
 *
 * Ten of the twelve built-ins install the vendor CLI itself, so a user's
 * existing global install is simply detected. These two are the exception:
 * neither `claude` nor `codex` speaks ACP, so codeg installs `claude-agent-acp`
 * / `codex-acp` instead, and the launch gate looks for THAT command. Without
 * this card the user only sees "Not installed" next to an agent they demonstrably
 * have — by far the most-reported confusion.
 *
 * Returns `null` for every non-adapter agent (backend decides, via
 * `PreflightResult.adapter`), and while preflight hasn't resolved yet.
 *
 * Deliberately carries NO install action: the Version Status card directly below
 * already has one, and two install buttons on adjacent cards only breeds doubt
 * about which is the right one.
 */
export function buildAcpAdapterCheck(
  adapter: AdapterInfo | null | undefined
): UiCheckItem | null {
  if (!adapter) return null

  const values = {
    nativeLabel: adapter.native_label,
    nativeCmd: adapter.native_cmd,
    nativePath: adapter.native_path ?? "",
    adapterPackage: adapter.adapter_package,
    adapterCmd: adapter.adapter_cmd,
    configDir: adapter.shared_config_dir,
  }

  // Installed → `pass`, so renderCheck collapses it: the relationship stays
  // documented for anyone who wonders later, without nagging a working setup.
  const installed = adapter.adapter_installed
  const sawNative = Boolean(adapter.native_path)
  // The English fallbacks mirror the four i18n messages one-for-one (they are
  // what renders if no translator is mounted), so each state keeps the detail
  // that state is about — above all, the path we found the vendor CLI at.
  const split = `Codeg drives agents over ACP and the ${adapter.native_label} does not speak ACP, so Codeg needs a separate adapter package, ${adapter.adapter_package}.`
  const coexist = `It ships its own runtime, never modifies or replaces your ${adapter.native_cmd} command, and reads the same ${adapter.shared_config_dir} — your existing sign-in and settings carry over.`
  const [key, fallback] = installed
    ? sawNative
      ? [
          "adapter.readyWithNative",
          `Adapter ${adapter.adapter_cmd} is installed — that is what Codeg launches, not your own ${adapter.native_cmd} at ${adapter.native_path}. They are separate packages that coexist, and both read ${adapter.shared_config_dir}.`,
        ]
      : [
          "adapter.ready",
          `Adapter ${adapter.adapter_cmd} is installed — that is what Codeg launches. It ships its own runtime, so the ${adapter.native_label} is not required.`,
        ]
    : sawNative
      ? [
          "adapter.missingWithNative",
          `Found your own ${adapter.native_label} at ${adapter.native_path}. ${split} ${coexist} Install it below.`,
        ]
      : [
          "adapter.missing",
          `${split} It ships its own runtime, so the ${adapter.native_cmd} CLI is not required first; if you do have it, the two coexist and share the same ${adapter.shared_config_dir} sign-in and settings. Install it below.`,
        ]

  return {
    check_id: "acp_adapter",
    label: acpText("adapter.label", "ACP adapter"),
    status: installed ? "pass" : "warn",
    message: acpText(key, fallback, values),
    fixes: [
      {
        label: acpText("adapter.learnMore", "Learn more"),
        kind: "open_url",
        payload: adapter.docs_url,
      },
    ],
  }
}

// `uvReady` reports whether the uv runtime (uvx) is installed — only meaningful
// for uvx agents (custom Python-package agents; built-in Hermes moved to the
// npm bridge). Derived from the uv preflight check by the caller. uvx agents
// need uv installed before their package can be prepared, so when uv isn't
// ready every managed install/upgrade action is surfaced disabled and the
// user is pointed at the separate "Install uv" preflight action.
export function buildVersionCheck(
  agent: AcpAgentInfo,
  uvReady: boolean = true
): UiCheckItem | null {
  if (
    agent.distribution_type !== "binary" &&
    agent.distribution_type !== "npx" &&
    agent.distribution_type !== "uvx"
  )
    return null

  const remoteVersion = agent.registry_version ?? "unknown"
  const localVersion =
    agent.installed_version ?? acpText("version.notInstalled", "Not installed")
  // A manually written definition has no registry behind it — its stored
  // version is whatever the user typed — so "Remote:" would be comparing
  // against noise. Every message shows the local side alone.
  const manualSource = agent.custom_source === "manual"
  const versionText = manualSource
    ? acpText("version.localOnly", "Local: {localVersion}", { localVersion })
    : acpText(
        "version.remoteLocal",
        "Remote: {remoteVersion} · Local: {localVersion}",
        { remoteVersion, localVersion }
      )
  const installAction: RunningActionKind =
    agent.distribution_type === "binary" ? "download_binary" : "install_npx"
  const upgradeAction: RunningActionKind =
    agent.distribution_type === "binary" ? "upgrade_binary" : "upgrade_npx"
  const uninstallAction: RunningActionKind =
    agent.distribution_type === "binary" ? "uninstall_binary" : "uninstall_npx"

  // uvx agents need the uv runtime before any managed install/upgrade can
  // run. Surface a single blocked state pointing at the separate "Install
  // uv" preflight action below, with the agent-install action shown disabled.
  // This covers both the fresh case (available=false) and the rare system-CLI
  // case (available=true via the agent's own PATH CLI, but uvx still missing).
  // Uninstall stays available even without uv — it only clears the prepared
  // marker — so a prepared package can still be removed when uv is gone.
  if (agent.distribution_type === "uvx" && !uvReady) {
    const blockedFixes: UiFixAction[] = [
      {
        label: acpText("actions.install", "Install"),
        kind: installAction,
        payload: agent.agent_type,
        disabled: true,
      },
    ]
    if (agent.installed_version) {
      blockedFixes.push({
        label: acpText("actions.uninstall", "Uninstall"),
        kind: uninstallAction,
        payload: agent.agent_type,
      })
    }
    return {
      check_id: "version_status",
      label: acpText("version.statusLabel", "Version Status"),
      status: "warn",
      message: acpText(
        "version.uvxNotReady",
        "{versionText}. The uv runtime isn't installed — install it from the uv check below to use this agent.",
        { versionText }
      ),
      fixes: blockedFixes,
    }
  }

  // Only binary agents can be genuinely platform-unsupported (no binary for
  // this platform). uvx runs everywhere — a uvx agent that reaches here (uv
  // treated as ready, i.e. preflight unknown) falls through to an actionable
  // install rather than a dead-end "unsupported" message.
  if (!agent.available && agent.distribution_type !== "uvx") {
    return {
      check_id: "version_status",
      label: acpText("version.statusLabel", "Version Status"),
      status: "fail",
      message: acpText(
        "version.platformUnsupported",
        "{versionText}. Current platform does not support this agent.",
        { versionText }
      ),
      fixes: [],
    }
  }

  // Custom-version install is offered in every installable state (and stays
  // available after a version is installed, so users can switch versions).
  //
  // The backend decides, because the condition is a property of the download
  // URL rather than of the distribution kind: a binary agent's custom install
  // substitutes the requested version into the pinned URL, which only yields a
  // different archive when the pinned version appears in it. Antigravity's URLs
  // carry a Google build id, so inferring support from
  // `binary && registry_version` — as this did — offered an install that
  // downloaded the same bytes and cached them under the number the user typed.
  const supportsCustomInstall = agent.supports_custom_version
  const customInstallFix: UiFixAction = {
    label: acpText("actions.customInstall", "Custom install"),
    kind: "custom_install",
    payload: agent.agent_type,
  }
  const withCustomInstall = (fixes: UiFixAction[]): UiFixAction[] =>
    supportsCustomInstall ? [...fixes, customInstallFix] : fixes

  // The opt-in "Adapter version: Latest" channel (npx agents only) — install
  // and upgrade actions resolve the `latest` dist-tag instead of the pin.
  const latestChannel =
    agent.distribution_type === "npx" &&
    adapterChannelFromEnv(agent.env) === "latest"

  if (!agent.installed_version) {
    return {
      check_id: "version_status",
      label: acpText("version.statusLabel", "Version Status"),
      status: "fail",
      message: acpText(
        "version.clickInstall",
        "{versionText}. Click Install on the right.",
        { versionText }
      ),
      fixes: withCustomInstall([
        {
          label: acpText("actions.install", "Install"),
          kind: installAction,
          payload: agent.agent_type,
        },
      ]),
    }
  }

  // Manual definitions stop here: installed is the whole story, and the
  // registry-comparison branches below would only manufacture "upgrade
  // available" noise against a user-typed version.
  if (manualSource) {
    return {
      check_id: "version_status",
      label: acpText("version.statusLabel", "Version Status"),
      status: "pass",
      message: acpText("version.localInstalled", "{versionText}. Installed.", {
        versionText,
      }),
      fixes: withCustomInstall([
        {
          label: acpText("actions.uninstall", "Uninstall"),
          kind: uninstallAction,
          payload: agent.agent_type,
        },
      ]),
    }
  }

  if (
    agent.registry_version &&
    hasComparableVersion(agent.registry_version) &&
    !hasComparableVersion(agent.installed_version)
  ) {
    return {
      check_id: "version_status",
      label: acpText("version.statusLabel", "Version Status"),
      status: "warn",
      message: acpText(
        "version.localUnrecognized",
        "{versionText}. Local version is not comparable; try upgrade to overwrite install.",
        { versionText }
      ),
      fixes: withCustomInstall([
        {
          label: acpText("actions.upgrade", "Upgrade"),
          kind: upgradeAction,
          payload: agent.agent_type,
        },
        {
          label: acpText("actions.uninstall", "Uninstall"),
          kind: uninstallAction,
          payload: agent.agent_type,
        },
      ]),
    }
  }

  if (
    hasComparableVersion(agent.registry_version) &&
    hasComparableVersion(agent.installed_version) &&
    compareVersion(agent.installed_version, agent.registry_version) < 0
  ) {
    return {
      check_id: "version_status",
      label: acpText("version.statusLabel", "Version Status"),
      status: "warn",
      message: acpText(
        "version.upgradeAvailable",
        "{versionText}. Upgrade available.",
        { versionText }
      ),
      fixes: withCustomInstall([
        {
          label: acpText("actions.upgrade", "Upgrade"),
          kind: upgradeAction,
          payload: agent.agent_type,
        },
        {
          label: acpText("actions.uninstall", "Uninstall"),
          kind: uninstallAction,
          payload: agent.agent_type,
        },
      ]),
    }
  }

  if (!agent.registry_version) {
    return {
      check_id: "version_status",
      label: acpText("version.statusLabel", "Version Status"),
      status: "warn",
      message: acpText(
        "version.remoteUnavailable",
        "{versionText}. Remote version is currently unavailable.",
        { versionText }
      ),
      fixes: withCustomInstall([
        {
          label: acpText("actions.uninstall", "Uninstall"),
          kind: uninstallAction,
          payload: agent.agent_type,
        },
      ]),
    }
  }

  // A latest-channel agent's installed version normally sits AT or AHEAD of
  // the pin, so the compare-to-pin branch above never offers an upgrade again
  // — and codeg cannot know whether npm has something newer, because nothing
  // polls in the background (by design). Keep the Upgrade action available:
  // it resolves the `latest` dist-tag on demand, and "Already latest" would
  // claim a comparison that was never made.
  if (latestChannel) {
    return {
      check_id: "version_status",
      label: acpText("version.statusLabel", "Version Status"),
      status: "pass",
      message: acpText(
        "version.latestChannel",
        "{versionText}. Latest channel is on; Upgrade installs the newest release.",
        { versionText }
      ),
      fixes: withCustomInstall([
        {
          label: acpText("actions.upgrade", "Upgrade"),
          kind: upgradeAction,
          payload: agent.agent_type,
        },
        {
          label: acpText("actions.uninstall", "Uninstall"),
          kind: uninstallAction,
          payload: agent.agent_type,
        },
      ]),
    }
  }

  return {
    check_id: "version_status",
    label: acpText("version.statusLabel", "Version Status"),
    status: "pass",
    message: acpText("version.latest", "{versionText}. Already latest.", {
      versionText,
    }),
    fixes: withCustomInstall([
      {
        label: acpText("actions.uninstall", "Uninstall"),
        kind: uninstallAction,
        payload: agent.agent_type,
      },
    ]),
  }
}

export function getAgentChecks(
  agent: AcpAgentInfo,
  current?: AgentCheckState
): UiCheckItem[] {
  // For uvx agents, only treat uv as not-ready when the preflight result is
  // present AND its uv check isn't passing. With no result yet (or an errored
  // preflight) stay optimistic — otherwise we'd block the version-status
  // install while the "Install uv" button (which lives in that same preflight
  // result) is absent, a dead end. When the result IS present, the button is
  // present alongside it, so blocking is always paired with an actionable fix.
  const uvCheck = current?.result?.checks?.find(
    (check) => check.check_id === "uv_available"
  )
  const uvReady =
    agent.distribution_type !== "uvx" || !uvCheck || uvCheck.status === "pass"
  const versionCheck = buildVersionCheck(agent, uvReady)
  const remoteChecks: UiCheckItem[] = (current?.result?.checks ?? []).map(
    (check) => ({
      ...check,
      fixes: [...check.fixes],
    })
  )
  // The adapter explainer goes FIRST: it answers "why does this say not
  // installed when I have the CLI?" before the Version Status card below it
  // offers the Install that fixes it.
  const adapterCheck = buildAcpAdapterCheck(current?.result?.adapter)
  return [adapterCheck, versionCheck, ...remoteChecks].filter(
    (check): check is UiCheckItem => check != null
  )
}

interface AgentReorderItemProps {
  agent: AcpAgentInfo
  selected: boolean
  reordering: boolean
  dragging: AgentType | null
  onDragStart: (agentType: AgentType) => void
  onDragEnd: () => void
  onSelect: (agentType: AgentType) => void
  children: (
    startDrag: (event: PointerEvent<HTMLButtonElement>) => void
  ) => ReactNode
}

function AgentReorderItem({
  agent,
  selected,
  reordering,
  dragging,
  onDragStart,
  onDragEnd,
  onSelect,
  children,
}: AgentReorderItemProps) {
  const dragControls = useDragControls()

  const startDrag = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      event.preventDefault()
      event.stopPropagation()
      dragControls.start(event)
    },
    [dragControls]
  )

  return (
    <Reorder.Item
      as="section"
      value={agent}
      data-agent-type={agent.agent_type}
      drag={reordering ? false : "y"}
      dragListener={false}
      dragControls={dragControls}
      dragMomentum={false}
      layout="position"
      className={cn(
        "rounded-lg border bg-card p-3 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
        selected && "border-primary/60 bg-primary/5",
        dragging === agent.agent_type && "border-primary/60 bg-primary/5"
      )}
      tabIndex={0}
      onDragStart={() => {
        onDragStart(agent.agent_type)
      }}
      onDragEnd={onDragEnd}
      onClick={() => {
        onSelect(agent.agent_type)
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key !== "Enter" && event.key !== " ") return
        event.preventDefault()
        onSelect(agent.agent_type)
      }}
    >
      {children(startDrag)}
    </Reorder.Item>
  )
}

export function AcpAgentSettings() {
  const ime = useImeGuard()
  const locale = useLocale()
  const t = useTranslations("AcpAgentSettings")
  const rawTranslator = t as unknown as AcpTranslator
  acpTranslator = (key, values) => rawTranslator(key, values)
  const searchParams = useSearchParams()
  const [agents, setAgents] = useState<AcpAgentInfo[]>([])
  const [loadingAgents, setLoadingAgents] = useState(true)
  const [addCustomOpen, setAddCustomOpen] = useState(false)
  // Registry id of the custom agent being edited; non-null renders the edit
  // instance of the add dialog (its own instance so the two flows never share
  // form state).
  const [editCustomAgentId, setEditCustomAgentId] = useState<string | null>(
    null
  )
  const [removingCustomAgent, setRemovingCustomAgent] = useState(false)
  const [loadingError, setLoadingError] = useState<string | null>(null)
  const [checkState, setCheckState] = useState<
    Partial<Record<AgentType, AgentCheckState>>
  >({})
  const [checking, setChecking] = useState<Partial<Record<AgentType, boolean>>>(
    {}
  )
  const [busyBinaryAction, setBusyBinaryAction] = useState<
    Partial<Record<AgentType, boolean>>
  >({})
  const [runningActionKind, setRunningActionKind] = useState<
    Partial<Record<AgentType, RunningActionKind>>
  >({})
  const [savingEnv, setSavingEnv] = useState<
    Partial<Record<AgentType, boolean>>
  >({})
  const [savingConfig, setSavingConfig] = useState<
    Partial<Record<AgentType, boolean>>
  >({})
  const [modelProviders, setModelProviders] = useState<ModelProviderInfo[]>([])
  const [uninstallConfirmAgent, setUninstallConfirmAgent] =
    useState<AcpAgentInfo | null>(null)
  const [removeConfirmAgent, setRemoveConfirmAgent] =
    useState<AcpAgentInfo | null>(null)
  const [customInstallAgent, setCustomInstallAgent] =
    useState<AcpAgentInfo | null>(null)
  const [customVersionInput, setCustomVersionInput] = useState("")
  const [pluginModalOpen, setPluginModalOpen] = useState(false)
  const [pluginModalAgent, setPluginModalAgent] = useState<AgentType | null>(
    null
  )
  const [expandedChecks, setExpandedChecks] = useState<Record<string, boolean>>(
    {}
  )
  const [selectedAgentType, setSelectedAgentType] = useState<AgentType | null>(
    null
  )
  const [drafts, setDrafts] = useState<Partial<Record<AgentType, AgentDraft>>>(
    {}
  )
  const [configErrors, setConfigErrors] = useState<
    Partial<Record<AgentType, string | null>>
  >({})
  const [showApiKeys, setShowApiKeys] = useState<
    Partial<Record<AgentType, boolean>>
  >({})
  // Whether the Grok panel's "advanced (raw config.toml)" escape hatch is open.
  const [grokAdvancedOpen, setGrokAdvancedOpen] = useState(false)
  // Show/hide toggle for the Grok custom-model API key (kept separate from the
  // per-agent `showApiKeys` map, which is keyed by AgentType only).
  const [showGrokCustomKey, setShowGrokCustomKey] = useState(false)
  // True for the WHOLE duration of a Grok save (write + post-save reseed), so
  // both Grok save buttons stay disabled and can't interleave while the draft
  // is being rebuilt from disk.
  const [grokSaving, setGrokSaving] = useState(false)
  const [openCodeProviderId, setOpenCodeProviderId] = useState("")
  const [openCodeNewModelIds, setOpenCodeNewModelIds] = useState<
    Record<string, string>
  >({})
  const [openCodeModelIdDrafts, setOpenCodeModelIdDrafts] = useState<
    Record<string, string>
  >({})
  const [openCodeModelConfigExpanded, setOpenCodeModelConfigExpanded] =
    useState<Record<string, boolean>>({})
  const [openCodeDeleteProviderId, setOpenCodeDeleteProviderId] = useState<
    string | null
  >(null)
  const [openCodeCatalog, setOpenCodeCatalog] = useState<
    OpenCodeCatalogProvider[]
  >([])
  const [openCodeCatalogLoading, setOpenCodeCatalogLoading] = useState(false)
  // True once the catalog fetch has settled at least once (success OR failure).
  // Gates "Add custom provider" so the catalog-id collision check runs against a
  // known set — an empty catalog while still loading must not let a catalog id
  // (e.g. "openai") slip in as a custom provider.
  const [openCodeCatalogReady, setOpenCodeCatalogReady] = useState(false)
  // Dedupe the one-shot catalog fetch without putting volatile state in the
  // effect deps (which would re-run the effect and self-cancel the request).
  const openCodeCatalogRequestedRef = useRef(false)
  const [openCodeConnectOpen, setOpenCodeConnectOpen] = useState(false)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  // Add-a-custom-provider dialog (separate from the catalog connect dialog).
  const [openCodeCustomOpen, setOpenCodeCustomOpen] = useState(false)
  // When set, the connect dialog opens in edit mode for this connected provider.
  const [openCodeEditProviderId, setOpenCodeEditProviderId] = useState<
    string | null
  >(null)
  const [dragging, setDragging] = useState<AgentType | null>(null)
  const [reordering, setReordering] = useState(false)
  const pendingOrderRef = useRef<AgentType[] | null>(null)
  const busyActionRef = useRef<Set<AgentType>>(new Set())
  const handledSearchAgentRef = useRef<string | null>(null)
  const agentListRef = useRef<HTMLDivElement | null>(null)
  const installStream = useAgentInstallStream()
  const [streamAgentType, setStreamAgentType] = useState<AgentType | null>(null)
  const installLogEndRef = useRef<HTMLDivElement | null>(null)
  const [codexDeviceCode, setCodexDeviceCode] = useState<{
    userCode: string
    verificationUrl: string
    deviceAuthId: string
    interval: number
  } | null>(null)
  const [codexLoginStatus, setCodexLoginStatus] = useState<
    "idle" | "requesting" | "polling" | "success" | "error"
  >("idle")
  const [codexLoginError, setCodexLoginError] = useState<string | null>(null)
  const codexPollCancelledRef = useRef(false)

  const sortedAgents = useMemo(
    () =>
      [...agents].sort(
        (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)
      ),
    [agents]
  )
  const selectedAgent = useMemo(
    () =>
      sortedAgents.find((agent) => agent.agent_type === selectedAgentType) ??
      null,
    [selectedAgentType, sortedAgents]
  )
  const agentTypesKey = useMemo(
    () =>
      [...new Set(agents.map((agent) => agent.agent_type))].sort().join(","),
    [agents]
  )
  const requestedAgentType = useMemo(
    () => searchParams.get("agent"),
    [searchParams]
  )

  const refreshAgents = useCallback(async () => {
    setLoadingAgents(true)
    setLoadingError(null)
    try {
      const [next, providers] = await Promise.all([
        acpListAgents(),
        listModelProviders().catch(() => [] as ModelProviderInfo[]),
      ])
      setAgents(next)
      publishAgentDisplay(next)
      setModelProviders(providers)
      setDrafts((prev) => {
        const updated = { ...prev }
        for (const agent of next) {
          if (!updated[agent.agent_type]) {
            updated[agent.agent_type] = buildAgentDraft(agent)
            continue
          }
          // An EXISTING draft is deliberately kept (it may hold in-progress
          // edits) — but for the keys a structured panel owns, keeping it is
          // what loses data: the enable switch persists `draft.envText`
          // wholesale, so a draft still holding this window's pre-refresh
          // values would restore them over whatever another window (or
          // another surface here) just saved. Rebase only those keys; every
          // other key, and every unsaved edit to them, is untouched.
          const existing = updated[agent.agent_type]
          if (agent.agent_type === "deepseek" && existing) {
            updated[agent.agent_type] = rebaseDeepSeekDraft(existing, agent)
          }
        }
        return updated
      })
      setConfigErrors((prev) => {
        const updated = { ...prev }
        for (const agent of next) {
          if (typeof updated[agent.agent_type] !== "undefined") continue
          const configText =
            typeof agent.config_json === "string" ? agent.config_json : ""
          updated[agent.agent_type] = parseConfigJsonText(configText).error
        }
        return updated
      })
    } catch (err) {
      const message = toErrorMessage(err)
      setLoadingError(message)
    } finally {
      setLoadingAgents(false)
    }
  }, [])

  const runPreflight = useCallback(
    async (agentType: AgentType, forceRefresh?: boolean) => {
      setChecking((prev) => ({ ...prev, [agentType]: true }))
      try {
        const [resultState, versionState, statusState] =
          await Promise.allSettled([
            acpPreflight(agentType, forceRefresh),
            acpDetectAgentLocalVersion(agentType),
            acpGetAgentStatus(agentType),
          ])

        if (versionState.status === "fulfilled") {
          setAgents((prev) => {
            if (versionState.value === null) return prev
            let changed = false
            const next = prev.map((agent) => {
              if (agent.agent_type !== agentType) return agent
              if (agent.installed_version === versionState.value) return agent
              changed = true
              return { ...agent, installed_version: versionState.value }
            })
            return changed ? next : prev
          })
        }

        // Re-sync `available` from the authoritative backend status. It is
        // recomputed live (e.g. `uvx_agent_launchable` for custom uvx
        // agents), so an install that provisions the runtime flips it true
        // here — otherwise the version-status panel would stay stuck on the
        // unavailable / "runtime not ready" branch with the freshly installed
        // version shown.
        if (statusState.status === "fulfilled") {
          setAgents((prev) => {
            let changed = false
            const next = prev.map((agent) => {
              if (agent.agent_type !== agentType) return agent
              if (agent.available === statusState.value.available) return agent
              changed = true
              return { ...agent, available: statusState.value.available }
            })
            return changed ? next : prev
          })
        }

        if (resultState.status === "fulfilled") {
          setCheckState((prev) => ({
            ...prev,
            [agentType]: { result: resultState.value },
          }))
        } else {
          const message =
            resultState.reason instanceof Error
              ? resultState.reason.message
              : String(resultState.reason)
          setCheckState((prev) => ({
            ...prev,
            [agentType]: { error: message },
          }))
        }
      } catch (err) {
        const message = toErrorMessage(err)
        setCheckState((prev) => ({ ...prev, [agentType]: { error: message } }))
      } finally {
        setChecking((prev) => ({ ...prev, [agentType]: false }))
      }
    },
    []
  )

  const runAllPreflight = useCallback(
    async (agentTypes: AgentType[]) => {
      if (agentTypes.length === 0) return
      setChecking((prev) => {
        const next = { ...prev }
        for (const agentType of agentTypes) {
          next[agentType] = true
        }
        return next
      })
      await Promise.all(agentTypes.map((agentType) => runPreflight(agentType)))
    },
    [runPreflight]
  )

  useEffect(() => {
    return () => installStream.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const container = installLogEndRef.current?.parentElement
    if (container) {
      container.scrollTop = container.scrollHeight
    }
  }, [installStream.logs])

  useEffect(() => {
    if (
      installStream.status === "success" ||
      installStream.status === "failed"
    ) {
      if (streamAgentType) {
        runPreflight(streamAgentType).catch(() => {})
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [installStream.status])

  useEffect(() => {
    refreshAgents().catch((err) => {
      console.error("[Settings] refresh agents failed:", err)
    })
  }, [refreshAgents])

  useEffect(() => {
    if (loadingAgents || !agentTypesKey) return
    const agentTypes = agentTypesKey.split(",") as AgentType[]
    runAllPreflight(agentTypes).catch((err) => {
      console.error("[Settings] run all preflight failed:", err)
    })
  }, [agentTypesKey, loadingAgents, runAllPreflight])

  useEffect(() => {
    if (!requestedAgentType) {
      handledSearchAgentRef.current = null
      return
    }
    if (sortedAgents.length === 0) {
      return
    }
    if (handledSearchAgentRef.current === requestedAgentType) {
      return
    }
    const matched = sortedAgents.find(
      (agent) => agent.agent_type === requestedAgentType
    )
    if (matched) {
      setSelectedAgentType(matched.agent_type)
    }
    handledSearchAgentRef.current = requestedAgentType
  }, [requestedAgentType, sortedAgents])

  useEffect(() => {
    if (!selectedAgentType) return
    const container = agentListRef.current
    if (!container) return
    const selected = container.querySelector<HTMLElement>(
      `[data-agent-type="${selectedAgentType}"]`
    )
    if (!selected) return
    selected.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }, [selectedAgentType, sortedAgents])

  useEffect(() => {
    if (sortedAgents.length === 0) {
      setSelectedAgentType(null)
      return
    }
    setSelectedAgentType((prev) => {
      if (prev && sortedAgents.some((agent) => agent.agent_type === prev)) {
        return prev
      }
      return sortedAgents[0].agent_type
    })
  }, [sortedAgents])

  // A settings save (env or native config) only takes effect on the NEXT agent
  // start, so any running session of that agent stays on its launch-time config
  // until restarted. The backend returns how many running sessions were left
  // stale; surface that as one info toast. Debounced + max-coalesced so a button
  // that saves env AND config together (e.g. Codex, Gemini) shows a single toast
  // rather than one per call.
  const affectedReportRef = useRef<{
    max: number
    timer: ReturnType<typeof setTimeout> | null
  }>({ max: 0, timer: null })
  const reportAffectedSessions = useCallback(
    (affected: number) => {
      const r = affectedReportRef.current
      r.max = Math.max(r.max, affected)
      if (r.timer) clearTimeout(r.timer)
      r.timer = setTimeout(() => {
        const count = affectedReportRef.current.max
        affectedReportRef.current = { max: 0, timer: null }
        if (count > 0) {
          toast.info(t("toasts.affectedRunningSessions", { count }))
        }
      }, 150)
    },
    [t]
  )

  const persistEnv = useCallback(
    async (
      agentType: AgentType,
      enabled: boolean,
      envText: string,
      modelProviderId?: number | null,
      /** The keys a STRUCTURED panel owns, when the env came from one rather
       * than from `draft.envText`. `undefined` for a key deletes it. See the
       * draft sync below. */
      draftEnvPatch?: Record<string, string | undefined>
    ) => {
      const parsedEnv = parseEnvText(envText)
      setSavingEnv((prev) => ({ ...prev, [agentType]: true }))
      try {
        const affected = await acpUpdateAgentEnv(agentType, {
          enabled,
          env: parsedEnv,
          modelProviderId: modelProviderId ?? null,
        })
        setAgents((prev) =>
          prev.map((agent) =>
            agent.agent_type === agentType
              ? {
                  ...agent,
                  enabled,
                  env: parsedEnv,
                  model_provider_id: modelProviderId ?? null,
                }
              : agent
          )
        )
        // A structured panel writes env the raw editor never sees, and the
        // agents refetch deliberately preserves existing drafts (to protect
        // in-progress edits). The enable switch persists `draft.envText`
        // WHOLESALE, so a draft left holding pre-save text silently undoes the
        // save the moment the user flips it. Fold the panel's keys into the
        // draft — in the same commit as `setAgents`, so no await window exists
        // in which the switch could fire with the old text, and no refetch
        // failure can leave it stale.
        //
        // A PATCH, not a wholesale replace: the textarea stays editable while
        // the panel's request is in flight, so overwriting the draft with the
        // panel's own map would erase whatever was typed in the meantime.
        if (draftEnvPatch) {
          const keys = importantEnvKeysByAgent(agentType)
          setDrafts((prev) => {
            const current = prev[agentType]
            if (!current) return prev
            const envText = patchEnvText(current.envText, draftEnvPatch)
            const mergedEnv = parseEnvText(envText)
            return {
              ...prev,
              [agentType]: {
                ...current,
                enabled,
                envText,
                modelProviderId: modelProviderId ?? null,
                // The structured mirrors read the same keys, so they have to
                // move with the text or the two views disagree.
                apiBaseUrl: findEnvValue(mergedEnv, keys.apiBaseUrl),
                apiKey: findEnvValue(mergedEnv, keys.apiKey),
                model: findEnvValue(mergedEnv, keys.model),
              },
            }
          })
        }
        reportAffectedSessions(affected)
      } finally {
        setSavingEnv((prev) => ({ ...prev, [agentType]: false }))
      }
    },
    [reportAffectedSessions]
  )

  const persistConfig = useCallback(
    async (
      agentType: AgentType,
      configText: string,
      options?: {
        openCodeAuthJsonText?: string
        codexAuthJsonText?: string
        codexConfigTomlText?: string
        codexModelCatalog?: string
        codexSandbox?: CodexSandboxStructuredConfig
        grokConfigTomlText?: string
        grokStructured?: GrokStructuredConfig
      }
    ) => {
      const parsedConfig = parseConfigJsonText(configText)
      if (parsedConfig.error) {
        throw new Error(parsedConfig.error)
      }
      const codexAuthJsonText = options?.codexAuthJsonText
      if (agentType === "codex" && typeof codexAuthJsonText === "string") {
        const authError = parseCodexAuthJsonText(codexAuthJsonText)
        if (authError) {
          throw new Error(authError)
        }
      }
      let normalizedConfig = normalizeConfigText(configText)
      if (agentType === "open_code" && normalizedConfig) {
        normalizedConfig = ensureOpenCodeProviderNpm(normalizedConfig)
      }
      // For agents using merge strategy, mark removed keys as null
      // so the backend merge_json_values can delete them from disk.
      let configForPersist =
        agentType === "open_code" && !normalizedConfig ? "{}" : normalizedConfig
      const usesMerge =
        agentType === "claude_code" ||
        agentType === "gemini" ||
        agentType === "open_claw"
      if (usesMerge) {
        const originalAgent = agents.find((a) => a.agent_type === agentType)
        // Diff even when the current config emptied to "" so removed keys still
        // produce null-deletion patches (`configForPersist` would otherwise be
        // "" → a null config_json no-op that leaves the stale key on disk).
        configForPersist =
          buildMergeConfigPayload(configText, originalAgent?.config_json) ?? ""
      }
      setSavingConfig((prev) => ({ ...prev, [agentType]: true }))
      try {
        const affected = await acpUpdateAgentConfig(agentType, {
          config_json: configForPersist || null,
          opencode_auth_json:
            typeof options?.openCodeAuthJsonText === "string"
              ? options.openCodeAuthJsonText
              : null,
          codex_auth_json:
            typeof codexAuthJsonText === "string" ? codexAuthJsonText : null,
          codex_config_toml:
            typeof options?.codexConfigTomlText === "string"
              ? options.codexConfigTomlText
              : null,
          codex_model_catalog:
            typeof options?.codexModelCatalog === "string"
              ? options.codexModelCatalog
              : null,
          codex_sandbox: options?.codexSandbox ?? null,
          grok_config_toml:
            typeof options?.grokConfigTomlText === "string"
              ? options.grokConfigTomlText
              : null,
          grok_structured: options?.grokStructured ?? null,
        })
        reportAffectedSessions(affected)
        setAgents((prev) =>
          prev.map((agent) =>
            agent.agent_type === agentType
              ? {
                  ...agent,
                  config_json: normalizedConfig || null,
                  opencode_auth_json:
                    typeof options?.openCodeAuthJsonText === "string"
                      ? options.openCodeAuthJsonText
                      : agent.opencode_auth_json,
                  codex_auth_json:
                    typeof codexAuthJsonText === "string"
                      ? codexAuthJsonText
                      : agent.codex_auth_json,
                  codex_config_toml:
                    typeof options?.codexConfigTomlText === "string"
                      ? options.codexConfigTomlText
                      : agent.codex_config_toml,
                  grok_config_toml:
                    typeof options?.grokConfigTomlText === "string"
                      ? options.grokConfigTomlText
                      : agent.grok_config_toml,
                  grok_settings: options?.grokStructured
                    ? {
                        default_reasoning_effort:
                          options.grokStructured.defaultReasoningEffort,
                        permission_mode: options.grokStructured.permissionMode,
                        // buildGrokStructuredConfig already trims/gates/clamps
                        // these to what the backend writes, so mirror them
                        // directly (reseedGrokDraft re-reads disk right after).
                        custom_model_id: options.grokStructured.customModelId,
                        custom_base_url: options.grokStructured.customBaseUrl,
                        custom_api_key: options.grokStructured.customApiKey,
                        custom_api_backend:
                          options.grokStructured.customApiBackend,
                        custom_context_window:
                          options.grokStructured.customContextWindow,
                        auto_compact_threshold_percent:
                          options.grokStructured.autoCompactThresholdPercent,
                      }
                    : agent.grok_settings,
                }
              : agent
          )
        )
      } finally {
        setSavingConfig((prev) => ({ ...prev, [agentType]: false }))
      }
    },
    [agents, reportAffectedSessions]
  )

  // After a Grok save, re-read the merged on-disk config and rebuild the Grok
  // draft. The agents-updated refetch deliberately does NOT overwrite existing
  // drafts (to preserve in-progress edits), so without this the collapsed raw
  // editor and the structured dropdowns could drift out of sync with disk (the
  // structured merge and the raw editor each write keys the other doesn't echo).
  const reseedAgentDraft = useCallback(async (agentType: AgentType) => {
    try {
      const fresh = await acpListAgents()
      setAgents(fresh)
      publishAgentDisplay(fresh)
      const agent = fresh.find((a) => a.agent_type === agentType)
      if (agent) {
        setDrafts((prev) => ({ ...prev, [agentType]: buildAgentDraft(agent) }))
      }
    } catch (err) {
      // Non-fatal: the save already committed, and the agents-updated
      // subscription will resync shortly — never surface this as a save failure.
      console.error(`[Settings] reseed ${agentType} draft failed:`, err)
    }
  }, [])

  const reseedGrokDraft = useCallback(
    () => reseedAgentDraft("grok"),
    [reseedAgentDraft]
  )

  const runBinaryAction = useCallback(
    async (
      agent: AcpAgentInfo,
      mode: "download" | "upgrade",
      kind?: RunningActionKind,
      versionOverride?: string
    ) => {
      if (busyActionRef.current.has(agent.agent_type)) return
      busyActionRef.current.add(agent.agent_type)
      setBusyBinaryAction((prev) => ({ ...prev, [agent.agent_type]: true }))
      setRunningActionKind((prev) => ({
        ...prev,
        [agent.agent_type]:
          kind ?? (mode === "download" ? "download_binary" : "upgrade_binary"),
      }))
      // A custom-version install must replace whatever is cached, otherwise a
      // higher cached version would still win on connect.
      const clearCache = mode === "upgrade" || Boolean(versionOverride)
      const actionLabel = versionOverride
        ? t("actions.customInstall")
        : mode === "upgrade"
          ? t("actions.upgrade")
          : t("actions.install")
      const taskId = randomUUID()
      setStreamAgentType(agent.agent_type)
      await installStream.start(taskId)
      try {
        if (clearCache) {
          await acpClearBinaryCache(agent.agent_type)
        }
        await acpDownloadAgentBinary(
          agent.agent_type,
          taskId,
          versionOverride ?? null
        )
        await runPreflight(agent.agent_type)
        const detectedVersion = await acpDetectAgentLocalVersion(
          agent.agent_type
        )
        setAgents((prev) =>
          prev.map((item) =>
            item.agent_type === agent.agent_type
              ? { ...item, installed_version: detectedVersion }
              : item
          )
        )
        toast.success(
          t("toasts.agentActionCompleted", {
            name: agent.name,
            action: actionLabel,
          }),
          {
            description: detectedVersion
              ? t("toasts.localVersion", { version: detectedVersion })
              : t("toasts.installCompletedVersionLater"),
          }
        )
      } catch (err) {
        const message = toErrorMessage(err)
        toast.error(
          t("toasts.agentActionFailed", {
            name: agent.name,
            action: actionLabel,
          }),
          {
            description: message,
          }
        )
        if (clearCache) {
          // The cache was cleared before downloading, so a failure here may
          // have removed the previously working binary — resync local state so
          // the UI doesn't keep showing a phantom version.
          try {
            const detected = await acpDetectAgentLocalVersion(agent.agent_type)
            setAgents((prev) =>
              prev.map((item) =>
                item.agent_type === agent.agent_type
                  ? { ...item, installed_version: detected ?? null }
                  : item
              )
            )
          } catch (detectErr) {
            console.error(
              "[Settings] failed to resync installed version after binary install failure:",
              detectErr
            )
          }
        }
        throw err
      } finally {
        busyActionRef.current.delete(agent.agent_type)
        setBusyBinaryAction((prev) => ({ ...prev, [agent.agent_type]: false }))
        setRunningActionKind((prev) => ({
          ...prev,
          [agent.agent_type]: undefined,
        }))
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runPreflight, t, installStream.start]
  )

  const runNpxAction = useCallback(
    async (
      agent: AcpAgentInfo,
      mode: "install" | "upgrade",
      versionOverride?: string
    ) => {
      if (busyActionRef.current.has(agent.agent_type)) return
      busyActionRef.current.add(agent.agent_type)
      setBusyBinaryAction((prev) => ({ ...prev, [agent.agent_type]: true }))
      setRunningActionKind((prev) => ({
        ...prev,
        [agent.agent_type]: versionOverride
          ? "custom_install"
          : mode === "install"
            ? "install_npx"
            : "upgrade_npx",
      }))
      // A custom-version install forces a clean reinstall so the requested
      // version replaces whatever is currently installed.
      const cleanFirst = mode === "upgrade" || Boolean(versionOverride)
      const actionLabel = versionOverride
        ? t("actions.customInstall")
        : mode === "upgrade"
          ? t("actions.upgrade")
          : t("actions.install")
      const taskId = randomUUID()
      setStreamAgentType(agent.agent_type)
      await installStream.start(taskId)
      try {
        const installedVersion = await acpPrepareNpxAgent(
          agent.agent_type,
          agent.registry_version,
          taskId,
          cleanFirst,
          versionOverride ?? null
        )
        setAgents((prev) =>
          prev.map((item) =>
            item.agent_type === agent.agent_type
              ? { ...item, installed_version: installedVersion }
              : item
          )
        )
        await runPreflight(agent.agent_type)
        const detectedVersion = await acpDetectAgentLocalVersion(
          agent.agent_type
        )
        if (detectedVersion && detectedVersion !== installedVersion) {
          setAgents((prev) =>
            prev.map((item) =>
              item.agent_type === agent.agent_type
                ? { ...item, installed_version: detectedVersion }
                : item
            )
          )
        }
        const finalVersion = detectedVersion ?? installedVersion
        toast.success(
          t("toasts.agentActionCompleted", {
            name: agent.name,
            action: actionLabel,
          }),
          {
            description: finalVersion
              ? t("toasts.localVersion", { version: finalVersion })
              : t("toasts.installCompletedVersionLater"),
          }
        )
      } catch (err) {
        const message = toErrorMessage(err)
        const hintKey = getInstallErrorHintKey(message)
        toast.error(
          t("toasts.agentActionFailed", {
            name: agent.name,
            action: actionLabel,
          }),
          {
            description: hintKey ? t(hintKey, { name: agent.name }) : message,
          }
        )
        if (cleanFirst) {
          // Clean reinstall may have removed the old install before failing —
          // resync local state so the UI doesn't keep showing a phantom version.
          try {
            const detected = await acpDetectAgentLocalVersion(agent.agent_type)
            setAgents((prev) =>
              prev.map((item) =>
                item.agent_type === agent.agent_type
                  ? { ...item, installed_version: detected ?? null }
                  : item
              )
            )
          } catch (detectErr) {
            console.error(
              "[Settings] failed to resync installed version after upgrade failure:",
              detectErr
            )
          }
        }
        throw err
      } finally {
        busyActionRef.current.delete(agent.agent_type)
        setBusyBinaryAction((prev) => ({ ...prev, [agent.agent_type]: false }))
        setRunningActionKind((prev) => ({
          ...prev,
          [agent.agent_type]: undefined,
        }))
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runPreflight, t, installStream.start]
  )

  /**
   * Remove a custom agent's definition. Recorded transcripts are kept — the
   * conversations that reference this agent are still readable afterwards,
   * they just cannot be resumed. Deleting them is a separate, explicit action.
   *
   * Confirmation happens in the `removeConfirmAgent` AlertDialog, never via
   * `window.confirm`: the Tauri webview does not reliably block on the native
   * prompt, so the deletion used to run before the user answered.
   */
  const handleRemoveCustomAgent = useCallback(
    async (agent: AcpAgentInfo) => {
      const id = customAgentId(agent.agent_type)
      if (!id) return
      setRemovingCustomAgent(true)
      try {
        await acpDeleteCustomAgent(id, false)
        toast.success(t("customAgentRemoved", { name: agent.name }))
        setSelectedAgentType(null)
        await refreshAgents()
      } catch (err) {
        toast.error(toErrorMessage(err))
      } finally {
        setRemovingCustomAgent(false)
      }
    },
    [refreshAgents, t]
  )

  const runUninstallAction = useCallback(
    async (agent: AcpAgentInfo) => {
      if (busyActionRef.current.has(agent.agent_type)) return
      busyActionRef.current.add(agent.agent_type)
      setBusyBinaryAction((prev) => ({ ...prev, [agent.agent_type]: true }))
      setRunningActionKind((prev) => ({
        ...prev,
        [agent.agent_type]:
          agent.distribution_type === "binary"
            ? "uninstall_binary"
            : "uninstall_npx",
      }))
      const taskId = randomUUID()
      setStreamAgentType(agent.agent_type)
      await installStream.start(taskId)
      try {
        await acpUninstallAgent(agent.agent_type, taskId)
        setAgents((prev) =>
          prev.map((item) =>
            item.agent_type === agent.agent_type
              ? { ...item, installed_version: null }
              : item
          )
        )
        await runPreflight(agent.agent_type)
        toast.success(t("toasts.uninstallCompleted", { name: agent.name }), {
          description: t("toasts.localVersionRemoved"),
        })
      } catch (err) {
        const message = toErrorMessage(err)
        const hintKey = getInstallErrorHintKey(message)
        toast.error(t("toasts.uninstallFailed", { name: agent.name }), {
          description: hintKey ? t(hintKey, { name: agent.name }) : message,
        })
        throw err
      } finally {
        busyActionRef.current.delete(agent.agent_type)
        setBusyBinaryAction((prev) => ({ ...prev, [agent.agent_type]: false }))
        setRunningActionKind((prev) => ({
          ...prev,
          [agent.agent_type]: undefined,
        }))
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runPreflight, t, installStream.start]
  )

  // Install ONLY the uv runtime (uvx) — separate from preparing a uvx agent's
  // package. Triggered by the uv preflight check's "Install uv" fix. On success
  // `runPreflight` re-syncs the uv check + `available`, unblocking the agent's
  // version-status install action.
  const runUvInstall = useCallback(
    async (agent: AcpAgentInfo) => {
      if (busyActionRef.current.has(agent.agent_type)) return
      busyActionRef.current.add(agent.agent_type)
      setBusyBinaryAction((prev) => ({ ...prev, [agent.agent_type]: true }))
      setRunningActionKind((prev) => ({
        ...prev,
        [agent.agent_type]: "install_uv",
      }))
      const actionLabel = t("actions.install")
      const taskId = randomUUID()
      setStreamAgentType(agent.agent_type)
      await installStream.start(taskId)
      try {
        await acpInstallUvTool(taskId)
        await runPreflight(agent.agent_type)
        toast.success(
          t("toasts.agentActionCompleted", { name: "uv", action: actionLabel })
        )
      } catch (err) {
        const message = toErrorMessage(err)
        toast.error(
          t("toasts.agentActionFailed", { name: "uv", action: actionLabel }),
          { description: message }
        )
        throw err
      } finally {
        busyActionRef.current.delete(agent.agent_type)
        setBusyBinaryAction((prev) => ({ ...prev, [agent.agent_type]: false }))
        setRunningActionKind((prev) => ({
          ...prev,
          [agent.agent_type]: undefined,
        }))
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runPreflight, t, installStream.start]
  )

  const handleFixAction = async (agent: AcpAgentInfo, action: UiFixAction) => {
    if (
      busyBinaryAction[agent.agent_type] ||
      busyActionRef.current.has(agent.agent_type)
    ) {
      return
    }
    if (action.kind === "open_url") {
      await openUrl(action.payload)
      return
    }
    if (action.kind === "download_binary") {
      await runBinaryAction(agent, "download")
      return
    }
    if (action.kind === "upgrade_binary") {
      await runBinaryAction(agent, "upgrade")
      return
    }
    if (action.kind === "install_npx") {
      await runNpxAction(agent, "install")
      return
    }
    if (action.kind === "upgrade_npx") {
      await runNpxAction(agent, "upgrade")
      return
    }
    if (action.kind === "uninstall_binary" || action.kind === "uninstall_npx") {
      setUninstallConfirmAgent(agent)
      return
    }
    if (action.kind === "redownload_binary") {
      await runBinaryAction(agent, "upgrade", "redownload_binary")
      return
    }
    if (action.kind === "install_opencode_plugins") {
      setPluginModalAgent(agent.agent_type)
      setPluginModalOpen(true)
      return
    }
    if (action.kind === "install_uv") {
      await runUvInstall(agent)
      return
    }
    if (action.kind === "custom_install") {
      setCustomVersionInput("")
      setCustomInstallAgent(agent)
      return
    }
    await runPreflight(agent.agent_type)
  }

  const confirmRemoveCustomAgent = useCallback(() => {
    if (!removeConfirmAgent) return
    const target = removeConfirmAgent
    handleRemoveCustomAgent(target)
      .catch((err) => {
        console.error("[Settings] remove custom agent failed:", err)
      })
      .finally(() => {
        setRemoveConfirmAgent(null)
      })
  }, [handleRemoveCustomAgent, removeConfirmAgent])

  const confirmUninstall = useCallback(() => {
    if (!uninstallConfirmAgent) return
    const target = uninstallConfirmAgent
    runUninstallAction(target)
      .catch((err) => {
        console.error("[Settings] uninstall action failed:", err)
      })
      .finally(() => {
        setUninstallConfirmAgent(null)
      })
  }, [runUninstallAction, uninstallConfirmAgent])

  const confirmCustomInstall = useCallback(() => {
    if (!customInstallAgent) return
    const agent = customInstallAgent
    const version = customVersionInput.trim()
    if (!isValidCustomVersion(version)) return
    // Close immediately; progress streams into the detail panel log, and any
    // failure is surfaced via toast inside the run* actions.
    const run =
      agent.distribution_type === "binary"
        ? runBinaryAction(agent, "upgrade", "custom_install", version)
        : runNpxAction(agent, "upgrade", version)
    run.catch((err) => {
      console.error("[Settings] custom install failed:", err)
    })
    setCustomInstallAgent(null)
  }, [customInstallAgent, customVersionInput, runBinaryAction, runNpxAction])

  const persistReorder = useCallback(
    async (order: AgentType[]) => {
      if (order.length === 0) return
      setReordering(true)
      try {
        await acpReorderAgents(order)
      } catch (err) {
        console.error("[Settings] reorder agents failed:", err)
        const message = toErrorMessage(err)
        toast.error(t("toasts.saveAgentOrderFailed"), {
          description: message,
        })
        await refreshAgents()
      } finally {
        setReordering(false)
      }
    },
    [refreshAgents, t]
  )

  const handleReorder = useCallback((next: AcpAgentInfo[]) => {
    const reordered = next.map((agent, index) => ({
      ...agent,
      sort_order: index,
    }))
    setAgents(reordered)
    pendingOrderRef.current = reordered.map((agent) => agent.agent_type)
  }, [])

  // One package operation at a time across ALL agents: while any
  // install/upgrade/uninstall runs, every agent's package-action buttons are
  // disabled — the busy flag is keyed per agent, so without this, selecting
  // another agent in the list offers a second, concurrent install. The
  // spinner stays precise via the per-agent `runningActionKind`.
  const anyBinaryActionBusy = Object.values(busyBinaryAction).some(Boolean)

  const renderCheck = (agent: AcpAgentInfo, check: UiCheckItem) => {
    const checkKey = `${agent.agent_type}:${check.check_id}`
    const expanded = expandedChecks[checkKey] ?? check.status !== "pass"

    return (
      <div
        key={check.check_id}
        className="rounded-md border bg-muted/20 px-3 py-2 space-y-2"
      >
        <button
          type="button"
          className="w-full flex items-center justify-between gap-2 text-left"
          onClick={() => {
            setExpandedChecks((prev) => ({
              ...prev,
              [checkKey]: !expanded,
            }))
          }}
        >
          <div className="min-w-0 flex items-center gap-1.5">
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            )}
            <span className="text-xs font-medium truncate">{check.label}</span>
          </div>
          <span
            className={`text-2xs font-semibold shrink-0 ${statusTone(check.status)}`}
          >
            {check.status.toUpperCase()}
          </span>
        </button>

        {expanded && (
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 text-2xs text-muted-foreground break-words">
              {check.message}
            </div>
            {check.fixes.length > 0 && (
              <div className="flex flex-wrap gap-1.5 justify-end max-w-[13.75rem] shrink-0">
                {check.fixes.map((fix, index) => {
                  const busyGated =
                    anyBinaryActionBusy &&
                    PACKAGE_ACTION_FIX_KINDS.includes(fix.kind)
                  const running =
                    runningActionKind[agent.agent_type] === fix.kind
                  return (
                    <Button
                      key={`${fix.label}-${index}`}
                      size="xs"
                      variant="outline"
                      className={cn(
                        "h-6 bg-muted/30 hover:bg-muted/50",
                        // Two disabled looks: while the global one-package-op-
                        // at-a-time gate is busy, every parked package action
                        // dims (backend-disabled or not) so the lockout shows
                        // on agents other than the busy one; only the button
                        // showing the spinner, and — when the gate is idle — a
                        // backend-declared inapplicable fix, keep the full-
                        // opacity chip look.
                        busyGated && !running
                          ? "disabled:opacity-50"
                          : "disabled:bg-muted/30 disabled:opacity-100"
                      )}
                      disabled={
                        ("disabled" in fix && fix.disabled === true) ||
                        busyGated
                      }
                      onClick={() => {
                        handleFixAction(agent, fix).catch((err) => {
                          console.error("[Settings] fix action failed:", err)
                        })
                      }}
                    >
                      {runningActionKind[agent.agent_type] === fix.kind ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : fix.kind === "download_binary" ||
                        fix.kind === "install_npx" ||
                        fix.kind === "install_uv" ? (
                        <Download className="h-3 w-3" />
                      ) : fix.kind === "upgrade_binary" ||
                        fix.kind === "upgrade_npx" ||
                        fix.kind === "redownload_binary" ? (
                        <Wrench className="h-3 w-3" />
                      ) : fix.kind === "uninstall_binary" ||
                        fix.kind === "uninstall_npx" ? (
                        <Trash2 className="h-3 w-3" />
                      ) : fix.kind === "install_opencode_plugins" ? (
                        <Download className="h-3 w-3" />
                      ) : fix.kind === "custom_install" ? (
                        <PackagePlus className="h-3 w-3" />
                      ) : null}
                      {fix.label}
                    </Button>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  const selectedCurrent = selectedAgent
    ? checkState[selectedAgent.agent_type]
    : undefined
  const selectedDraft = selectedAgent
    ? (drafts[selectedAgent.agent_type] ?? buildAgentDraft(selectedAgent))
    : null
  const selectedConfigError = selectedAgent
    ? (configErrors[selectedAgent.agent_type] ?? null)
    : null
  const selectedIsSaving = selectedAgent
    ? Boolean(
        savingEnv[selectedAgent.agent_type] ||
        savingConfig[selectedAgent.agent_type]
      )
    : false
  // The Grok save spans config + env + reseed as one action under `grokSaving`
  // (the per-command saving flags clear before the reseed). While it runs, the
  // SHARED env controls below (textarea / Save / enabled switch) mutate the same
  // envText/enabled the Grok save captured, so gate them too — scoped to Grok so
  // other agents are unaffected.
  const selectedGrokSaving = selectedAgent?.agent_type === "grok" && grokSaving
  const selectedIsSavingEnv = selectedAgent
    ? Boolean(savingEnv[selectedAgent.agent_type])
    : false
  const selectedIsSavingConfig = selectedAgent
    ? Boolean(savingConfig[selectedAgent.agent_type])
    : false
  const selectedAgentKind = selectedAgent?.agent_type ?? null

  const selectedModelProviders = useMemo(() => {
    if (!selectedAgent) return []
    return modelProviders.filter(
      (p) => p.agent_type === selectedAgent.agent_type
    )
  }, [modelProviders, selectedAgent])

  const selectedNeedsModelProvider = useMemo(() => {
    if (!selectedDraft) return false
    if (!selectedAgent) return false
    const at = selectedAgent.agent_type
    if (at === "claude_code")
      return selectedDraft.claudeAuthMode === "model_provider"
    if (at === "codex") return selectedDraft.codexAuthMode === "model_provider"
    if (at === "gemini")
      return selectedDraft.geminiAuthMode === "model_provider"
    return false
  }, [selectedAgent, selectedDraft])

  const selectedMissingModelProvider =
    selectedNeedsModelProvider && selectedDraft?.modelProviderId == null
  const selectedConfigText = selectedDraft?.configText ?? ""
  const selectedOpenCodeAuthJsonText = selectedDraft?.openCodeAuthJsonText ?? ""
  // Inline validation for `writable_roots`: codex would accept a relative entry
  // and resolve it against CODEX_HOME, so it is surfaced before the save throws.
  const codexRelativeWritableRoot =
    selectedAgent?.agent_type === "codex" && selectedDraft
      ? firstRelativeWritableRoot(selectedDraft.codexWritableRootsText)
      : null
  const selectedHermesProviderOption =
    selectedAgent?.agent_type === "hermes" && selectedDraft
      ? (HERMES_PROVIDERS.find((p) => p.id === selectedDraft.hermesProvider) ??
        null)
      : null
  const hermesCanUseNativeSetup =
    isDesktop() && getActiveRemoteConnectionId() === null
  const selectedOpenCodeConfig = useMemo(() => {
    if (selectedAgentKind !== "open_code" || !locale) return null
    return extractOpenCodeConfigValues(
      selectedConfigText,
      selectedOpenCodeAuthJsonText
    )
  }, [
    locale,
    selectedAgentKind,
    selectedConfigText,
    selectedOpenCodeAuthJsonText,
  ])
  const openCodeConnected = useMemo(() => {
    if (selectedAgentKind !== "open_code") return []
    return buildConnectedProviders({
      configText: selectedConfigText,
      authJsonText: selectedOpenCodeAuthJsonText,
      catalog: openCodeCatalog,
    })
  }, [
    selectedAgentKind,
    selectedConfigText,
    selectedOpenCodeAuthJsonText,
    openCodeCatalog,
  ])
  const openCodeModelOptions = useMemo(() => {
    const catalogGroups = buildConnectedModelOptions({
      connected: openCodeConnected,
      catalog: openCodeCatalog,
    })
    // Fall back to the config-derived groups before the catalog has loaded.
    return catalogGroups.length > 0
      ? catalogGroups
      : buildOpenCodeModelOptions(selectedOpenCodeConfig)
  }, [openCodeConnected, openCodeCatalog, selectedOpenCodeConfig])
  const openCodeCatalogIds = useMemo(
    () => new Set(openCodeCatalog.map((p) => p.id)),
    [openCodeCatalog]
  )
  // Split connected providers into two single-purpose surfaces:
  //  - well-known (catalog) providers connected via auth.json → top list
  //  - custom OpenAI-compatible endpoints (a `provider.<id>` block NOT in the
  //    catalog) → the bottom "custom provider" editor.
  // The discriminator is `hasConfigBlock && !inCatalog`, so an auth-only
  // well-known provider (no block) stays in the top list even if the catalog
  // fails to load — it can never be misfiled as custom and vanish.
  const openCodeWellKnownConnected = useMemo(
    () => openCodeConnected.filter((p) => !(p.hasConfigBlock && !p.inCatalog)),
    [openCodeConnected]
  )
  const openCodeCustomProviderIds = useMemo(
    () =>
      (selectedOpenCodeConfig?.providerIds ?? []).filter(
        (id) => !openCodeCatalogIds.has(id)
      ),
    [selectedOpenCodeConfig, openCodeCatalogIds]
  )
  // Lazily load the models.dev catalog the first time an OpenCode agent is
  // viewed. Backend resolves live → cache → bundled snapshot, so this never
  // hard-fails; on error we keep an empty catalog (custom-only flow) and allow
  // a retry the next time OpenCode is selected. The ref dedupes so we depend
  // only on `selectedAgentKind` — depending on the loading flag we set here
  // would re-run the effect and cancel its own in-flight request.
  useEffect(() => {
    if (selectedAgentKind !== "open_code") return
    if (openCodeCatalogRequestedRef.current) return
    openCodeCatalogRequestedRef.current = true
    setOpenCodeCatalogLoading(true)
    opencodeProviderCatalog()
      .then((list) => {
        setOpenCodeCatalog(list)
      })
      .catch((err) => {
        console.error("[Settings] opencode catalog load failed:", err)
        openCodeCatalogRequestedRef.current = false
      })
      .finally(() => {
        setOpenCodeCatalogLoading(false)
        setOpenCodeCatalogReady(true)
      })
  }, [selectedAgentKind])

  const selectedChecks = useMemo(() => {
    if (!selectedAgent || !locale) return []
    return getAgentChecks(selectedAgent, selectedCurrent)
  }, [locale, selectedAgent, selectedCurrent])

  useEffect(() => {
    if (!selectedAgent || selectedChecks.length === 0) return
    setExpandedChecks((prev) => {
      let next = prev
      for (const check of selectedChecks) {
        const key = `${selectedAgent.agent_type}:${check.check_id}`
        if (typeof next[key] !== "undefined") continue
        if (next === prev) next = { ...prev }
        next[key] = check.status !== "pass"
      }
      return next
    })
  }, [selectedAgent, selectedChecks])

  useEffect(() => {
    if (!selectedOpenCodeConfig) {
      if (openCodeProviderId) setOpenCodeProviderId("")
      return
    }
    if (!openCodeProviderId) return
    if (selectedOpenCodeConfig.providerIds.includes(openCodeProviderId)) {
      return
    }
    setOpenCodeProviderId("")
  }, [openCodeProviderId, selectedOpenCodeConfig])

  useEffect(() => {
    if (!openCodeDeleteProviderId) return
    if (!selectedOpenCodeConfig) {
      setOpenCodeDeleteProviderId(null)
      return
    }
    if (
      !selectedOpenCodeConfig.providerIds.includes(openCodeDeleteProviderId)
    ) {
      setOpenCodeDeleteProviderId(null)
    }
  }, [openCodeDeleteProviderId, selectedOpenCodeConfig])

  const updateSelectedDraft = useCallback(
    (updater: (current: AgentDraft) => AgentDraft) => {
      if (!selectedAgent || !selectedDraft) return
      setDrafts((prev) => {
        const current = prev[selectedAgent.agent_type] ?? selectedDraft
        return {
          ...prev,
          [selectedAgent.agent_type]: updater(current),
        }
      })
    },
    [selectedAgent, selectedDraft]
  )

  const handleConfigTextChange = useCallback(
    (nextText: string) => {
      if (!selectedAgent || !selectedDraft) return
      const parseResult = parseConfigJsonText(nextText)
      setConfigErrors((prev) => ({
        ...prev,
        [selectedAgent.agent_type]: parseResult.error,
      }))

      if (parseResult.error) {
        updateSelectedDraft((current) => ({
          ...current,
          configText: nextText,
        }))
        return
      }

      if (selectedAgent.agent_type === "open_code") {
        const openCode = extractOpenCodeConfigValues(
          nextText,
          selectedDraft.openCodeAuthJsonText
        )
        updateSelectedDraft((current) => ({
          ...current,
          configText: nextText,
          model: openCode.model,
        }))
        return
      }

      if (selectedAgent.agent_type === "cline") {
        const cline = extractClineImportantValues(nextText)
        updateSelectedDraft((current) => ({
          ...current,
          configText: nextText,
          clineProvider: cline.provider,
          clineApiKey: cline.apiKey,
          clineModel: cline.model,
          clineBaseUrl: cline.baseUrl,
        }))
        return
      }

      const important = extractImportantConfigValues(
        selectedAgent.agent_type,
        parseEnvText(selectedDraft.envText),
        nextText
      )
      const geminiImportant =
        selectedAgent.agent_type === "gemini"
          ? extractGeminiImportantValues(
              parseEnvText(selectedDraft.envText),
              nextText
            )
          : null
      updateSelectedDraft((current) => ({
        ...current,
        configText: nextText,
        apiBaseUrl: geminiImportant
          ? geminiImportant.apiBaseUrl
          : important.apiBaseUrl,
        apiKey: important.apiKey,
        model: geminiImportant ? geminiImportant.model : important.model,
        geminiAuthMode: geminiImportant
          ? geminiImportant.authMode
          : current.geminiAuthMode,
        geminiApiKey: geminiImportant
          ? geminiImportant.geminiApiKey
          : current.geminiApiKey,
        googleApiKey: geminiImportant
          ? geminiImportant.googleApiKey
          : current.googleApiKey,
        googleCloudProject: geminiImportant
          ? geminiImportant.googleCloudProject
          : current.googleCloudProject,
        googleCloudLocation: geminiImportant
          ? geminiImportant.googleCloudLocation
          : current.googleCloudLocation,
        googleApplicationCredentials: geminiImportant
          ? geminiImportant.googleApplicationCredentials
          : current.googleApplicationCredentials,
        claudeMainModel: important.claudeMainModel,
        claudeReasoningModel: important.claudeReasoningModel,
        claudeDefaultHaikuModel: important.claudeDefaultHaikuModel,
        claudeDefaultSonnetModel: important.claudeDefaultSonnetModel,
        claudeDefaultOpusModel: important.claudeDefaultOpusModel,
        claudeCustomModelOption: important.claudeCustomModelOption,
        claudeCustomModelOptionName: important.claudeCustomModelOptionName,
        claudeCustomModelOptionDescription:
          important.claudeCustomModelOptionDescription,
        claudeSendAttributionHeader: important.claudeSendAttributionHeader,
        claudeDisableNonessentialTraffic:
          important.claudeDisableNonessentialTraffic,
      }))
    },
    [selectedAgent, selectedDraft, updateSelectedDraft]
  )

  const handleImportantConfigChange = useCallback(
    (key: ImportantConfigKey, value: string) => {
      if (!selectedAgent || !selectedDraft) return
      const nextDraft = applyImportantFieldToDraft(selectedDraft, key, value)
      const nextJson = patchImportantConfigText(
        selectedAgent.agent_type,
        selectedDraft.configText,
        buildImportantPatchFromDraft(nextDraft)
      )
      if (nextJson.recoveredFromInvalid) {
        toast.warning(t("warnings.nativeJsonRecoveredStructured"))
      }
      setConfigErrors((prev) => ({
        ...prev,
        [selectedAgent.agent_type]: null,
      }))
      updateSelectedDraft((current) => {
        const nextCurrent = applyImportantFieldToDraft(current, key, value)
        return {
          ...nextCurrent,
          envText: patchEnvByImportantKey(
            selectedAgent.agent_type,
            current.envText,
            key,
            value
          ),
          configText: nextJson.configText,
        }
      })
    },
    [selectedAgent, selectedDraft, t, updateSelectedDraft]
  )

  // Toggle a Claude Code hardening flag: write the explicit "1"/"0" value into
  // the native config's `env` (and the DB env overlay in lockstep).
  const handleClaudeEnvFlagChange = useCallback(
    (
      field: "claudeSendAttributionHeader" | "claudeDisableNonessentialTraffic",
      envKey: string,
      enabled: boolean
    ) => {
      if (
        !selectedAgent ||
        !selectedDraft ||
        selectedAgent.agent_type !== "claude_code"
      )
        return
      const value = enabled ? CLAUDE_ENV_FLAG_ON : CLAUDE_ENV_FLAG_OFF
      const next = setClaudeEnvFlagInConfigText(
        selectedDraft.configText,
        envKey,
        value
      )
      if (next.recoveredFromInvalid) {
        toast.warning(t("warnings.nativeJsonRecoveredStructured"))
      }
      setConfigErrors((prev) => ({
        ...prev,
        [selectedAgent.agent_type]: null,
      }))
      updateSelectedDraft((current) => ({
        ...current,
        [field]: enabled,
        // The backend folds native `config.env` into `agent.env`, so keep the
        // DB env overlay (envText) in lockstep — otherwise persistEnv would
        // re-persist a stale value from the overlay. Mirrors
        // handleImportantConfigChange's dual configText + envText write.
        envText: patchEnvText(current.envText, { [envKey]: value }),
        configText: next.configText,
      }))
    },
    [selectedAgent, selectedDraft, t, updateSelectedDraft]
  )

  const handleGrokAuthModeChange = useCallback(
    (nextMode: GrokAuthMethod) => {
      if (
        !selectedAgent ||
        !selectedDraft ||
        selectedAgent.agent_type !== "grok"
      )
        return
      // Record the method knob in env; on subscription strip XAI_API_KEY so the
      // editable env can't override the `grok login` credential (the launch path
      // enforces the same via apply_grok_env_policy). Clearing the draft apiKey
      // keeps the now-hidden key input from resurrecting a stale value.
      updateSelectedDraft((current) => ({
        ...current,
        grokAuthMode: nextMode,
        apiKey: nextMode === "subscription" ? "" : current.apiKey,
        envText: patchEnvText(current.envText, {
          GROK_AUTH_MODE: nextMode,
          ...(nextMode === "subscription" ? { XAI_API_KEY: "" } : {}),
        }),
      }))
    },
    [selectedAgent, selectedDraft, updateSelectedDraft]
  )

  const handleClaudeAuthModeChange = useCallback(
    (nextMode: ClaudeAuthMode) => {
      if (
        !selectedAgent ||
        !selectedDraft ||
        selectedAgent.agent_type !== "claude_code"
      )
        return

      const keys = importantEnvKeysByAgent("claude_code")
      const allEnvKeys = [...keys.apiBaseUrl, ...keys.apiKey]

      if (nextMode === "official_subscription") {
        // Clear API URL/API Key from env and config
        const envPatch: Record<string, string> = {}
        for (const k of allEnvKeys) envPatch[k] = ""
        // Build clean display config (remove null keys)
        const parsed = parseConfigJsonText(selectedDraft.configText)
        const config: Record<string, unknown> = parsed.error
          ? {}
          : { ...parsed.config }
        delete config.apiBaseUrl
        delete config.apiKey
        if (config.env && typeof config.env === "object") {
          const cfgEnv = { ...(config.env as Record<string, unknown>) }
          for (const k of allEnvKeys) delete cfgEnv[k]
          if (Object.keys(cfgEnv).length > 0) {
            config.env = cfgEnv
          } else {
            delete config.env
          }
        }
        const nextConfigText =
          Object.keys(config).length > 0 ? JSON.stringify(config, null, 2) : ""
        setConfigErrors((prev) => ({
          ...prev,
          [selectedAgent.agent_type]: null,
        }))
        updateSelectedDraft((current) => ({
          ...current,
          claudeAuthMode: nextMode,
          modelProviderId: null,
          apiBaseUrl: "",
          apiKey: "",
          envText: patchEnvText(current.envText, envPatch),
          configText: nextConfigText,
        }))
        return
      }

      // "custom" or "model_provider" — keep existing values, just switch mode
      updateSelectedDraft((current) => ({
        ...current,
        claudeAuthMode: nextMode,
        modelProviderId:
          nextMode === "model_provider" ? current.modelProviderId : null,
      }))
    },
    [selectedAgent, selectedDraft, updateSelectedDraft]
  )

  const handleModelProviderSelect = useCallback(
    (providerIdStr: string) => {
      if (!selectedAgent || !selectedDraft) return
      const providerId = providerIdStr ? Number(providerIdStr) : null
      const provider = providerId
        ? modelProviders.find((p) => p.id === providerId)
        : null
      const apiUrl = provider?.api_url ?? ""
      const apiKey = provider?.api_key ?? ""
      const agentType = selectedAgent.agent_type

      if (agentType === "claude_code") {
        // Provider's model fields are authoritative: missing/empty keys clear
        // the corresponding draft + env value.
        const claudeModel = parseClaudeProviderModel(provider?.model ?? null)
        const claudeMain = claudeModel.main ?? ""
        const claudeReasoning = claudeModel.reasoning ?? ""
        const claudeHaiku = claudeModel.haiku ?? ""
        const claudeSonnet = claudeModel.sonnet ?? ""
        const claudeOpus = claudeModel.opus ?? ""
        const claudeCustomOption = claudeModel.customOption ?? ""
        const claudeCustomOptionName = claudeModel.customOptionName ?? ""
        const claudeCustomOptionDescription =
          claudeModel.customOptionDescription ?? ""
        const nextConfigJson = patchImportantConfigText(
          agentType,
          selectedDraft.configText,
          {
            apiBaseUrl: apiUrl,
            apiKey,
            model: selectedDraft.model,
            claudeMainModel: claudeMain,
            claudeReasoningModel: claudeReasoning,
            claudeDefaultHaikuModel: claudeHaiku,
            claudeDefaultSonnetModel: claudeSonnet,
            claudeDefaultOpusModel: claudeOpus,
            // The custom model option travels with the provider's model JSON,
            // authoritative like the five model fields: a defined value sets it,
            // an empty/omitted value clears the key from config.env.
            claudeCustomModelOption: claudeCustomOption,
            claudeCustomModelOptionName: claudeCustomOptionName,
            claudeCustomModelOptionDescription: claudeCustomOptionDescription,
          }
        )
        setConfigErrors((prev) => ({
          ...prev,
          [agentType]: null,
        }))
        updateSelectedDraft((current) => {
          let nextEnvText = patchEnvByImportantKey(
            agentType,
            current.envText,
            "apiBaseUrl",
            apiUrl
          )
          nextEnvText = patchEnvByImportantKey(
            agentType,
            nextEnvText,
            "apiKey",
            apiKey
          )
          nextEnvText = patchEnvByImportantKey(
            agentType,
            nextEnvText,
            "claudeMainModel",
            claudeMain
          )
          nextEnvText = patchEnvByImportantKey(
            agentType,
            nextEnvText,
            "claudeReasoningModel",
            claudeReasoning
          )
          nextEnvText = patchEnvByImportantKey(
            agentType,
            nextEnvText,
            "claudeDefaultHaikuModel",
            claudeHaiku
          )
          nextEnvText = patchEnvByImportantKey(
            agentType,
            nextEnvText,
            "claudeDefaultSonnetModel",
            claudeSonnet
          )
          nextEnvText = patchEnvByImportantKey(
            agentType,
            nextEnvText,
            "claudeDefaultOpusModel",
            claudeOpus
          )
          nextEnvText = patchEnvByImportantKey(
            agentType,
            nextEnvText,
            "claudeCustomModelOption",
            claudeCustomOption
          )
          nextEnvText = patchEnvByImportantKey(
            agentType,
            nextEnvText,
            "claudeCustomModelOptionName",
            claudeCustomOptionName
          )
          nextEnvText = patchEnvByImportantKey(
            agentType,
            nextEnvText,
            "claudeCustomModelOptionDescription",
            claudeCustomOptionDescription
          )
          return {
            ...current,
            modelProviderId: providerId,
            apiBaseUrl: apiUrl,
            apiKey,
            claudeMainModel: claudeMain,
            claudeReasoningModel: claudeReasoning,
            claudeDefaultHaikuModel: claudeHaiku,
            claudeDefaultSonnetModel: claudeSonnet,
            claudeDefaultOpusModel: claudeOpus,
            claudeCustomModelOption: claudeCustomOption,
            claudeCustomModelOptionName: claudeCustomOptionName,
            claudeCustomModelOptionDescription: claudeCustomOptionDescription,
            envText: nextEnvText,
            configText: nextConfigJson.configText,
          }
        })
      } else if (agentType === "codex") {
        // The provider stores a structured model config; root `model` is its
        // default slug and we reference the catalog the bind path generates.
        const codexList = parseCodexModelConfig(provider?.model ?? null)
        const codexHasConfig =
          codexList.customs.length > 0 ||
          (codexList.excludedOfficials?.length ?? 0) > 0
        const codexModel = codexList.default ?? codexList.customs[0]?.slug ?? ""
        const nextAuthPatch = patchCodexAuthJsonText(
          selectedDraft.codexAuthJsonText,
          { apiKey, authMode: null }
        )
        const nextAuthJsonText = nextAuthPatch.authJsonText
        // Always pass the provider's model (empty string clears it from the toml).
        let nextConfigTomlText = patchCodexConfigTomlText(
          selectedDraft.codexConfigTomlText,
          {
            modelProvider: CODEX_DEFAULT_MODEL_PROVIDER,
            apiBaseUrl: apiUrl,
            model: codexModel,
          }
        )
        nextConfigTomlText = updateTomlRootStringKey(
          nextConfigTomlText,
          "model_catalog_json",
          codexHasConfig ? "codeg-model-catalog.json" : ""
        )
        const synced = extractCodexImportantValues(
          nextAuthJsonText,
          nextConfigTomlText
        )
        updateSelectedDraft((current) => ({
          ...current,
          modelProviderId: providerId,
          apiBaseUrl: apiUrl,
          apiKey,
          model: codexModel,
          codexModelList: codexList,
          codexAuthJsonText: nextAuthJsonText,
          codexConfigTomlText: nextConfigTomlText,
          codexModelProvider: CODEX_DEFAULT_MODEL_PROVIDER,
          codexProviderOptions: synced.providerOptions,
          envText: patchEnvText(current.envText, {
            OPENAI_API_KEY: apiKey,
            OPENAI_BASE_URL: apiUrl,
            OPENAI_MODEL: codexModel,
          }),
        }))
      } else if (agentType === "gemini") {
        const geminiModel = provider?.model?.trim() ?? ""
        const nextConfigJson = patchGeminiConfigText(selectedDraft.configText, {
          apiBaseUrl: apiUrl,
          geminiApiKey: apiKey,
        })
        setConfigErrors((prev) => ({
          ...prev,
          [agentType]: null,
        }))
        updateSelectedDraft((current) => {
          let nextEnvText = patchGeminiEnvText(current.envText, {
            apiBaseUrl: apiUrl,
            geminiApiKey: apiKey,
          })
          // Always overwrite GEMINI_MODEL with the provider's value (empty
          // string clears it).
          nextEnvText = patchEnvText(nextEnvText, {
            GEMINI_MODEL: geminiModel,
          })
          return {
            ...current,
            modelProviderId: providerId,
            apiBaseUrl: apiUrl,
            apiKey,
            geminiApiKey: apiKey,
            model: geminiModel,
            envText: nextEnvText,
            configText: nextConfigJson.configText,
          }
        })
      } else {
        updateSelectedDraft((current) => ({
          ...current,
          modelProviderId: providerId,
        }))
      }
    },
    [selectedAgent, selectedDraft, modelProviders, updateSelectedDraft]
  )

  // Auto-select the first available provider when the user switches an agent to
  // "model_provider" auth mode and hasn't picked one yet. If the list is empty,
  // the existing "noModelProviderAvailable" hint handles the empty state.
  useEffect(() => {
    if (!selectedNeedsModelProvider) return
    if (selectedDraft?.modelProviderId != null) return
    if (selectedModelProviders.length === 0) return
    handleModelProviderSelect(String(selectedModelProviders[0].id))
  }, [
    selectedNeedsModelProvider,
    selectedDraft?.modelProviderId,
    selectedModelProviders,
    handleModelProviderSelect,
  ])

  const handleGeminiFieldChange = useCallback(
    (
      key:
        | "apiBaseUrl"
        | "model"
        | "geminiApiKey"
        | "googleApiKey"
        | "googleCloudProject"
        | "googleCloudLocation"
        | "googleApplicationCredentials",
      value: string
    ) => {
      if (
        !selectedAgent ||
        !selectedDraft ||
        selectedAgent.agent_type !== "gemini"
      )
        return

      const nextValues = {
        authMode: selectedDraft.geminiAuthMode,
        apiBaseUrl: selectedDraft.apiBaseUrl,
        geminiApiKey: selectedDraft.geminiApiKey,
        googleApiKey: selectedDraft.googleApiKey,
        googleCloudProject: selectedDraft.googleCloudProject,
        googleCloudLocation: selectedDraft.googleCloudLocation,
        googleApplicationCredentials:
          selectedDraft.googleApplicationCredentials,
        model: selectedDraft.model,
      }
      nextValues[key] = value
      const normalizedValues = patchGeminiAuthMode(
        nextValues,
        nextValues.authMode
      )

      const nextConfig = patchGeminiConfigText(selectedDraft.configText, {
        apiBaseUrl: normalizedValues.apiBaseUrl,
        model: normalizedValues.model,
        geminiApiKey: normalizedValues.geminiApiKey,
        googleApiKey: normalizedValues.googleApiKey,
        googleCloudProject: normalizedValues.googleCloudProject,
        googleCloudLocation: normalizedValues.googleCloudLocation,
        googleApplicationCredentials:
          normalizedValues.googleApplicationCredentials,
      })
      if (nextConfig.recoveredFromInvalid) {
        toast.warning(t("warnings.nativeJsonRecoveredStructured"))
      }
      setConfigErrors((prev) => ({
        ...prev,
        [selectedAgent.agent_type]: null,
      }))

      updateSelectedDraft((current) => {
        const nextEnvText = patchGeminiEnvText(current.envText, {
          apiBaseUrl: normalizedValues.apiBaseUrl,
          model: normalizedValues.model,
          geminiApiKey: normalizedValues.geminiApiKey,
          googleApiKey: normalizedValues.googleApiKey,
          googleCloudProject: normalizedValues.googleCloudProject,
          googleCloudLocation: normalizedValues.googleCloudLocation,
          googleApplicationCredentials:
            normalizedValues.googleApplicationCredentials,
        })
        return {
          ...current,
          apiBaseUrl: normalizedValues.apiBaseUrl,
          model: normalizedValues.model,
          apiKey:
            normalizedValues.geminiApiKey || normalizedValues.googleApiKey,
          geminiAuthMode: normalizedValues.authMode,
          geminiApiKey: normalizedValues.geminiApiKey,
          googleApiKey: normalizedValues.googleApiKey,
          googleCloudProject: normalizedValues.googleCloudProject,
          googleCloudLocation: normalizedValues.googleCloudLocation,
          googleApplicationCredentials:
            normalizedValues.googleApplicationCredentials,
          envText: nextEnvText,
          configText: nextConfig.configText,
        }
      })
    },
    [selectedAgent, selectedDraft, t, updateSelectedDraft]
  )

  const handleGeminiAuthModeChange = useCallback(
    (nextMode: GeminiAuthMode) => {
      if (
        !selectedAgent ||
        !selectedDraft ||
        selectedAgent.agent_type !== "gemini"
      )
        return

      if (nextMode === "model_provider") {
        // Keep existing values; provider selection will fill API URL/Key
        updateSelectedDraft((current) => ({
          ...current,
          geminiAuthMode: nextMode,
          modelProviderId: current.modelProviderId,
        }))
        return
      }

      const patched = patchGeminiAuthMode(
        {
          authMode: selectedDraft.geminiAuthMode,
          apiBaseUrl: selectedDraft.apiBaseUrl,
          geminiApiKey: selectedDraft.geminiApiKey,
          googleApiKey: selectedDraft.googleApiKey,
          googleCloudProject: selectedDraft.googleCloudProject,
          googleCloudLocation: selectedDraft.googleCloudLocation,
          googleApplicationCredentials:
            selectedDraft.googleApplicationCredentials,
          model: selectedDraft.model,
        },
        nextMode
      )

      const nextConfig = patchGeminiConfigText(selectedDraft.configText, {
        apiBaseUrl: patched.apiBaseUrl,
        model: patched.model,
        geminiApiKey: patched.geminiApiKey,
        googleApiKey: patched.googleApiKey,
        googleCloudProject: patched.googleCloudProject,
        googleCloudLocation: patched.googleCloudLocation,
        googleApplicationCredentials: patched.googleApplicationCredentials,
      })
      if (nextConfig.recoveredFromInvalid) {
        toast.warning(t("warnings.nativeJsonRecoveredStructured"))
      }
      setConfigErrors((prev) => ({
        ...prev,
        [selectedAgent.agent_type]: null,
      }))

      updateSelectedDraft((current) => ({
        ...current,
        geminiAuthMode: patched.authMode,
        modelProviderId: null,
        apiBaseUrl: patched.apiBaseUrl,
        apiKey: patched.geminiApiKey || patched.googleApiKey,
        geminiApiKey: patched.geminiApiKey,
        googleApiKey: patched.googleApiKey,
        googleCloudProject: patched.googleCloudProject,
        googleCloudLocation: patched.googleCloudLocation,
        googleApplicationCredentials: patched.googleApplicationCredentials,
        envText: patchGeminiEnvText(current.envText, {
          apiBaseUrl: patched.apiBaseUrl,
          model: patched.model,
          geminiApiKey: patched.geminiApiKey,
          googleApiKey: patched.googleApiKey,
          googleCloudProject: patched.googleCloudProject,
          googleCloudLocation: patched.googleCloudLocation,
          googleApplicationCredentials: patched.googleApplicationCredentials,
        }),
        configText: nextConfig.configText,
      }))
    },
    [selectedAgent, selectedDraft, t, updateSelectedDraft]
  )

  const handleOpenClawFieldChange = useCallback(
    (
      key: "openClawGatewayUrl" | "openClawGatewayToken" | "openClawSessionKey",
      value: string
    ) => {
      if (
        !selectedAgent ||
        !selectedDraft ||
        selectedAgent.agent_type !== "open_claw"
      )
        return

      const envKeyMap: Record<string, string> = {
        openClawGatewayUrl: OPENCLAW_ENV_KEYS.gatewayUrl,
        openClawGatewayToken: OPENCLAW_ENV_KEYS.gatewayToken,
        openClawSessionKey: OPENCLAW_ENV_KEYS.sessionKey,
      }

      updateSelectedDraft((current) => ({
        ...current,
        [key]: value,
        envText: patchEnvText(current.envText, {
          [envKeyMap[key]]: value,
        }),
      }))
    },
    [selectedAgent, selectedDraft, updateSelectedDraft]
  )

  const handleHermesFieldChange = useCallback(
    (
      key:
        | "hermesProvider"
        | "apiKey"
        | "model"
        | "apiBaseUrl"
        | "hermesConfigYaml",
      value: string
    ) => {
      if (
        !selectedAgent ||
        !selectedDraft ||
        selectedAgent.agent_type !== "hermes"
      )
        return
      updateSelectedDraft((current) => {
        if (key !== "hermesProvider") {
          return { ...current, [key]: value }
        }
        // Switching provider: the projection only carries the *configured*
        // provider's key, so restore it when returning to that provider and
        // clear otherwise — never carry one provider's secret into another's
        // env var. An empty key field then means "leave the stored key as-is".
        const projected = parseHermesConfig(
          typeof selectedAgent.config_json === "string"
            ? selectedAgent.config_json
            : ""
        )
        const sameAsConfigured = value === projected.provider
        return {
          ...current,
          hermesProvider: value,
          apiKey: sameAsConfigured ? projected.apiKey : "",
          apiBaseUrl: sameAsConfigured ? projected.baseUrl : "",
        }
      })
    },
    [selectedAgent, selectedDraft, updateSelectedDraft]
  )

  const handleSaveHermesConfig = useCallback(
    async (mode: "structured" | "raw") => {
      if (
        !selectedAgent ||
        !selectedDraft ||
        selectedAgent.agent_type !== "hermes"
      )
        return
      const agentType = selectedAgent.agent_type
      const draft = selectedDraft
      const providerOption = HERMES_PROVIDERS.find(
        (p) => p.id === draft.hermesProvider
      )
      setSavingConfig((prev) => ({ ...prev, [agentType]: true }))
      try {
        await acpUpdateHermesConfig(
          mode === "raw"
            ? {
                provider: draft.hermesProvider,
                rawConfigYaml: draft.hermesConfigYaml,
              }
            : {
                provider: draft.hermesProvider,
                // Blank key, or a provider with no key field (OAuth / AWS) →
                // null → backend leaves the stored ~/.hermes/.env value
                // untouched (so switching providers can't wipe it).
                apiKey:
                  providerOption?.kind !== "apiKey" || !draft.apiKey.trim()
                    ? null
                    : draft.apiKey,
                model: draft.model,
                baseUrl: providerOption?.needsBaseUrl ? draft.apiBaseUrl : null,
              }
        )
        await refreshAgents()
        // Drop the draft so it rebuilds from the freshly-persisted projection —
        // otherwise the *other* mode (structured fields vs. raw config.yaml)
        // keeps stale content and a later save could overwrite this one.
        setDrafts((prev) => {
          const next = { ...prev }
          delete next[agentType]
          return next
        })
        toast.success(t("toasts.hermesSaved"), {
          description: t("toasts.configSavedHint"),
        })
      } catch (err) {
        console.error("[Settings] save hermes config failed:", err)
        toast.error(t("toasts.saveHermesFailed"), {
          description: toErrorMessage(err),
        })
      } finally {
        setSavingConfig((prev) => ({ ...prev, [agentType]: false }))
      }
    },
    [selectedAgent, selectedDraft, refreshAgents, t]
  )

  // Hermes's interactive setup (`--setup` / `hermes model`) needs a real TTY +
  // browser, so launch it in an external OS terminal on local desktop (the
  // backend builds the exact command). Fall back to copying the displayed
  // command (web / remote, or if the launch fails).
  const runHermesSetupCommand = useCallback(
    async (kind: "setup" | "model", displayCommand: string) => {
      const native = isDesktop() && getActiveRemoteConnectionId() === null
      if (native) {
        try {
          await acpOpenHermesSetupTerminal(kind)
          return
        } catch (err) {
          console.error("[Settings] open hermes setup terminal failed:", err)
        }
      }
      if (displayCommand) {
        const ok = await copyTextToClipboard(displayCommand)
        if (ok) toast.success(t("hermes.commandCopied"))
      }
    },
    [t]
  )

  const handleRevealHermesHome = useCallback(async () => {
    try {
      await acpRevealHermesHome()
    } catch (err) {
      console.error("[Settings] reveal hermes home failed:", err)
      toast.error(toErrorMessage(err))
    }
  }, [])

  const handleClineFieldChange = useCallback(
    (
      key: "clineProvider" | "clineApiKey" | "clineModel" | "clineBaseUrl",
      value: string
    ) => {
      if (
        !selectedAgent ||
        !selectedDraft ||
        selectedAgent.agent_type !== "cline"
      )
        return

      updateSelectedDraft((current) => {
        const next = { ...current, [key]: value }
        // Rebuild config_json from Cline draft fields
        const config: Record<string, unknown> = {}
        config.apiProvider =
          key === "clineProvider" ? value : next.clineProvider
        const apiKey = key === "clineApiKey" ? value : next.clineApiKey
        if (apiKey.trim()) config.apiKey = apiKey.trim()
        const model = key === "clineModel" ? value : next.clineModel
        if (model.trim()) config.model = model.trim()
        const baseUrl = key === "clineBaseUrl" ? value : next.clineBaseUrl
        if (baseUrl.trim()) config.apiBaseUrl = baseUrl.trim()
        next.configText = JSON.stringify(config, null, 2)
        return next
      })
    },
    [selectedAgent, selectedDraft, updateSelectedDraft]
  )

  const handleOpenCodeConfigPatch = useCallback(
    (mutator: (config: Record<string, unknown>) => void) => {
      if (
        !selectedAgent ||
        !selectedDraft ||
        selectedAgent.agent_type !== "open_code"
      )
        return
      const nextConfig = patchOpenCodeConfigText(
        selectedDraft.configText,
        mutator
      )
      if (nextConfig.recoveredFromInvalid) {
        toast.warning(t("warnings.nativeJsonRecoveredOpenCode"))
      }
      setConfigErrors((prev) => ({
        ...prev,
        [selectedAgent.agent_type]: null,
      }))
      const parsed = extractOpenCodeConfigValues(
        nextConfig.configText,
        selectedDraft.openCodeAuthJsonText
      )
      updateSelectedDraft((current) => ({
        ...current,
        configText: nextConfig.configText,
        model: parsed.model,
      }))
    },
    [selectedAgent, selectedDraft, t, updateSelectedDraft]
  )

  const handleOpenCodeFieldChange = useCallback(
    (key: "model" | "small_model", value: string) => {
      handleOpenCodeConfigPatch((config) => {
        const trimmed = value.trim()
        if (!trimmed) {
          delete config[key]
          return
        }
        config[key] = trimmed
      })
    },
    [handleOpenCodeConfigPatch]
  )

  // Connect a provider from the dialog: sync the draft, then persist both files.
  const applyOpenCodeConnect = useCallback(
    async (
      next: { configText: string; authJsonText: string },
      providerId: string
    ) => {
      if (!selectedAgent || selectedAgent.agent_type !== "open_code") return
      const parsed = extractOpenCodeConfigValues(
        next.configText,
        next.authJsonText
      )
      updateSelectedDraft((current) => ({
        ...current,
        configText: next.configText,
        openCodeAuthJsonText: next.authJsonText,
        model: parsed.model,
      }))
      setConfigErrors((prev) => ({ ...prev, open_code: null }))
      try {
        await persistConfig("open_code", next.configText, {
          openCodeAuthJsonText: next.authJsonText,
        })
        toast.success(t("toasts.providerConnected", { providerId }), {
          description: t("toasts.configSavedHint"),
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        toast.error(t("toasts.connectFailed", { providerId }), {
          description: message,
        })
        throw err
      }
    },
    [selectedAgent, updateSelectedDraft, persistConfig, t]
  )

  const handleOpenCodeDisconnect = useCallback(
    async (providerId: string, hasConfigBlock: boolean) => {
      if (
        !selectedAgent ||
        !selectedDraft ||
        selectedAgent.agent_type !== "open_code"
      )
        return
      const next = disconnectProvider({
        configText: selectedDraft.configText,
        authJsonText: selectedDraft.openCodeAuthJsonText,
        providerId,
        removeConfigBlock: hasConfigBlock,
      })
      const parsed = extractOpenCodeConfigValues(
        next.configText,
        next.authJsonText
      )
      updateSelectedDraft((current) => ({
        ...current,
        configText: next.configText,
        openCodeAuthJsonText: next.authJsonText,
        model: parsed.model,
      }))
      try {
        await persistConfig("open_code", next.configText, {
          openCodeAuthJsonText: next.authJsonText,
        })
        toast.success(t("toasts.providerDisconnected", { providerId }))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        toast.error(t("toasts.disconnectFailed", { providerId }), {
          description: message,
        })
      }
    },
    [selectedAgent, selectedDraft, updateSelectedDraft, persistConfig, t]
  )

  const handleOpenCodeToggleEnabled = useCallback(
    async (providerId: string, enabled: boolean) => {
      if (
        !selectedAgent ||
        !selectedDraft ||
        selectedAgent.agent_type !== "open_code"
      )
        return
      const nextConfig = setProviderEnabled({
        configText: selectedDraft.configText,
        providerId,
        enabled,
      })
      updateSelectedDraft((current) => ({
        ...current,
        configText: nextConfig,
      }))
      try {
        await persistConfig("open_code", nextConfig, {
          openCodeAuthJsonText: selectedDraft.openCodeAuthJsonText,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        toast.error(t("toasts.saveOpenCodeFailed"), { description: message })
      }
    },
    [selectedAgent, selectedDraft, updateSelectedDraft, persistConfig, t]
  )

  // Force a fresh models.dev fetch (bypassing the 24h cache) on demand.
  const handleOpenCodeRefreshCatalog = useCallback(async () => {
    setOpenCodeCatalogLoading(true)
    try {
      const list = await opencodeProviderCatalog(true)
      setOpenCodeCatalog(list)
      openCodeCatalogRequestedRef.current = true
      toast.success(t("toasts.catalogRefreshed", { count: list.length }))
    } catch (err) {
      console.error("[Settings] opencode catalog refresh failed:", err)
      toast.error(t("toasts.catalogRefreshFailed"), {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setOpenCodeCatalogLoading(false)
    }
  }, [t])

  const handleOpenCodeRemoveProvider = useCallback(
    (providerId: string) => {
      if (
        !selectedAgent ||
        !selectedDraft ||
        selectedAgent.agent_type !== "open_code"
      ) {
        return null
      }
      const targetId = providerId.trim()
      if (!targetId) return null

      const nextConfig = patchOpenCodeConfigText(
        selectedDraft.configText,
        (config) => {
          const providerRoot = asObjectRecord(config.provider)
          if (providerRoot) {
            delete providerRoot[targetId]
            if (Object.keys(providerRoot).length === 0) {
              delete config.provider
            }
          }

          const enabledProviders = Array.isArray(config.enabled_providers)
            ? config.enabled_providers
                .filter((item): item is string => typeof item === "string")
                .filter((item) => item !== targetId)
            : []
          if (enabledProviders.length > 0) {
            config.enabled_providers = enabledProviders
          } else {
            delete config.enabled_providers
          }

          const disabledProviders = Array.isArray(config.disabled_providers)
            ? config.disabled_providers
                .filter((item): item is string => typeof item === "string")
                .filter((item) => item !== targetId)
            : []
          if (disabledProviders.length > 0) {
            config.disabled_providers = disabledProviders
          } else {
            delete config.disabled_providers
          }

          // Don't leave model/small_model pointing at the removed provider.
          for (const key of [
            "model",
            "small_model",
            "smallModel",
            "small-model",
          ]) {
            if (modelReferencesProvider(config[key], targetId)) {
              delete config[key]
            }
          }
        }
      )
      if (nextConfig.recoveredFromInvalid) {
        toast.warning(t("warnings.nativeJsonRecoveredOpenCode"))
      }

      const nextAuth = patchOpenCodeAuthJsonText(
        selectedDraft.openCodeAuthJsonText,
        (authObject) => {
          delete authObject[targetId]
        }
      )
      if (nextAuth.recoveredFromInvalid) {
        toast.warning(t("warnings.openCodeAuthRecovered"))
      }

      const nextOpenCode = extractOpenCodeConfigValues(
        nextConfig.configText,
        nextAuth.authJsonText
      )
      const nextDraft = {
        ...selectedDraft,
        configText: nextConfig.configText,
        openCodeAuthJsonText: nextAuth.authJsonText,
        model: nextOpenCode.model,
      }
      setConfigErrors((prev) => ({
        ...prev,
        [selectedAgent.agent_type]: null,
      }))
      setDrafts((prev) => ({
        ...prev,
        [selectedAgent.agent_type]: nextDraft,
      }))
      setOpenCodeProviderId((current) => (current === targetId ? "" : current))
      setOpenCodeNewModelIds((prev) => {
        if (typeof prev[targetId] === "undefined") return prev
        const next = { ...prev }
        delete next[targetId]
        return next
      })
      setOpenCodeModelConfigExpanded((prev) => {
        if (typeof prev[targetId] === "undefined") return prev
        const next = { ...prev }
        delete next[targetId]
        return next
      })
      setOpenCodeModelIdDrafts((prev) => {
        const prefix = `${targetId}:`
        const keys = Object.keys(prev).filter((key) => key.startsWith(prefix))
        if (keys.length === 0) return prev
        const next = { ...prev }
        for (const key of keys) {
          delete next[key]
        }
        return next
      })
      return {
        enabled: nextDraft.enabled,
        envText: nextDraft.envText,
        configText: nextDraft.configText,
        openCodeAuthJsonText: nextDraft.openCodeAuthJsonText,
      }
    },
    [selectedAgent, selectedDraft, t]
  )

  const confirmOpenCodeProviderDelete = useCallback(() => {
    const providerId = openCodeDeleteProviderId?.trim()
    if (!providerId) return
    const removed = handleOpenCodeRemoveProvider(providerId)
    setOpenCodeDeleteProviderId(null)
    if (
      !removed ||
      !selectedAgent ||
      selectedAgent.agent_type !== "open_code"
    ) {
      return
    }
    persistConfig(selectedAgent.agent_type, removed.configText, {
      openCodeAuthJsonText: removed.openCodeAuthJsonText,
    })
      .then(() => {
        toast.success(t("toasts.providerDeleted", { providerId }), {
          description: t("toasts.openCodeConfigSynced"),
        })
      })
      .catch((err) => {
        console.error("[Settings] remove opencode provider failed:", err)
        const message = toErrorMessage(err)
        toast.error(t("toasts.providerDeleteFailed", { providerId }), {
          description: message,
        })
      })
  }, [
    handleOpenCodeRemoveProvider,
    openCodeDeleteProviderId,
    persistConfig,
    selectedAgent,
    t,
  ])

  const handleOpenCodeProviderStatusChange = useCallback(
    (providerId: string, enabled: boolean) => {
      const targetId = providerId.trim()
      if (!targetId) return
      handleOpenCodeConfigPatch((config) => {
        const hadEnabledAllowlist =
          Array.isArray(config.enabled_providers) &&
          config.enabled_providers.length > 0
        const enabledProviders = Array.isArray(config.enabled_providers)
          ? config.enabled_providers
              .filter((item): item is string => typeof item === "string")
              .map((item) => item.trim())
              .filter(Boolean)
          : []
        const disabledProviders = Array.isArray(config.disabled_providers)
          ? config.disabled_providers
              .filter((item): item is string => typeof item === "string")
              .map((item) => item.trim())
              .filter(Boolean)
          : []

        const nextEnabled = new Set(enabledProviders)
        const nextDisabled = new Set(disabledProviders)

        if (enabled) {
          nextDisabled.delete(targetId)
          if (hadEnabledAllowlist) {
            nextEnabled.add(targetId)
          }
        } else {
          nextDisabled.add(targetId)
          if (hadEnabledAllowlist) {
            nextEnabled.delete(targetId)
          }
        }

        const enabledArray = Array.from(nextEnabled)
        const disabledArray = Array.from(nextDisabled)
        if (enabledArray.length > 0) {
          config.enabled_providers = enabledArray
        } else {
          delete config.enabled_providers
        }
        if (disabledArray.length > 0) {
          config.disabled_providers = disabledArray
        } else {
          delete config.disabled_providers
        }
      })
    },
    [handleOpenCodeConfigPatch]
  )

  const handleOpenCodeProviderFieldChange = useCallback(
    (
      providerId: string,
      key: "name" | "api" | "npm" | "baseURL" | "apiKey",
      value: string
    ) => {
      const targetId = providerId.trim()
      if (!targetId) return

      // The API key is a secret: it goes ONLY into auth.json, never into
      // opencode.json. setProviderApiKey also scrubs any stale options.apiKey.
      if (key === "apiKey") {
        if (!selectedDraft) return
        const next = setProviderApiKey({
          configText: selectedDraft.configText,
          authJsonText: selectedDraft.openCodeAuthJsonText,
          providerId: targetId,
          apiKey: value,
        })
        const parsed = extractOpenCodeConfigValues(
          next.configText,
          next.authJsonText
        )
        setConfigErrors((prev) => ({ ...prev, open_code: null }))
        updateSelectedDraft((current) => ({
          ...current,
          configText: next.configText,
          openCodeAuthJsonText: next.authJsonText,
          model: parsed.model,
        }))
        return
      }

      handleOpenCodeConfigPatch((config) => {
        const providerRoot = asObjectRecord(config.provider) ?? {}
        if (!asObjectRecord(config.provider)) {
          config.provider = providerRoot
        }

        const currentProvider = asObjectRecord(providerRoot[targetId]) ?? {}
        if (!asObjectRecord(providerRoot[targetId])) {
          providerRoot[targetId] = currentProvider
        }
        const trimmed = value.trim()
        if (key === "baseURL") {
          const options = asObjectRecord(currentProvider.options) ?? {}
          if (!asObjectRecord(currentProvider.options)) {
            currentProvider.options = options
          }
          if (trimmed) {
            options[key] = trimmed
          } else {
            delete options[key]
          }
          if (Object.keys(options).length === 0) {
            delete currentProvider.options
          }
          return
        }
        if (trimmed) {
          currentProvider[key] = trimmed
        } else {
          delete currentProvider[key]
        }
      })
    },
    [handleOpenCodeConfigPatch, selectedDraft, updateSelectedDraft]
  )

  const handleOpenCodeModelDraftChange = useCallback(
    (providerId: string, value: string) => {
      const targetId = providerId.trim()
      if (!targetId) return
      setOpenCodeNewModelIds((prev) => ({
        ...prev,
        [targetId]: value,
      }))
    },
    []
  )

  const handleOpenCodeAddModel = useCallback(
    (providerId: string) => {
      const targetProviderId = providerId.trim()
      if (!targetProviderId || !selectedOpenCodeConfig) return
      const nextModelId = (openCodeNewModelIds[targetProviderId] ?? "").trim()
      if (!nextModelId) return
      const targetProvider = selectedOpenCodeConfig.providers[targetProviderId]
      if (!targetProvider) return
      if (targetProvider.modelIds.includes(nextModelId)) {
        toast.error(t("errors.modelExists", { modelId: nextModelId }))
        return
      }
      handleOpenCodeConfigPatch((config) => {
        const providerRoot = asObjectRecord(config.provider) ?? {}
        if (!asObjectRecord(config.provider)) {
          config.provider = providerRoot
        }

        const currentProvider =
          asObjectRecord(providerRoot[targetProviderId]) ?? {}
        if (!asObjectRecord(providerRoot[targetProviderId])) {
          providerRoot[targetProviderId] = currentProvider
        }

        const modelsRoot = asObjectRecord(currentProvider.models) ?? {}
        if (!asObjectRecord(currentProvider.models)) {
          currentProvider.models = modelsRoot
        }
        modelsRoot[nextModelId] = {
          name: nextModelId,
        }
      })
      setOpenCodeNewModelIds((prev) => ({
        ...prev,
        [targetProviderId]: "",
      }))
    },
    [handleOpenCodeConfigPatch, openCodeNewModelIds, selectedOpenCodeConfig, t]
  )

  const handleOpenCodeRemoveModel = useCallback(
    (providerId: string, modelId: string) => {
      const targetProviderId = providerId.trim()
      const targetModelId = modelId.trim()
      if (!targetProviderId || !targetModelId) return
      handleOpenCodeConfigPatch((config) => {
        const providerRoot = asObjectRecord(config.provider)
        if (!providerRoot) return
        const currentProvider = asObjectRecord(providerRoot[targetProviderId])
        if (!currentProvider) return
        const modelsRoot = asObjectRecord(currentProvider.models)
        if (!modelsRoot) return
        delete modelsRoot[targetModelId]
        if (Object.keys(modelsRoot).length === 0) {
          delete currentProvider.models
        }
      })
      const draftKey = `${targetProviderId}:${targetModelId}`
      setOpenCodeModelIdDrafts((prev) => {
        if (typeof prev[draftKey] === "undefined") return prev
        const next = { ...prev }
        delete next[draftKey]
        return next
      })
    },
    [handleOpenCodeConfigPatch]
  )

  const handleOpenCodeModelIdDraftChange = useCallback(
    (providerId: string, modelId: string, value: string) => {
      const targetProviderId = providerId.trim()
      const targetModelId = modelId.trim()
      if (!targetProviderId || !targetModelId) return
      const draftKey = `${targetProviderId}:${targetModelId}`
      setOpenCodeModelIdDrafts((prev) => ({
        ...prev,
        [draftKey]: value,
      }))
    },
    []
  )

  const handleOpenCodeModelIdCommit = useCallback(
    (providerId: string, modelId: string) => {
      const targetProviderId = providerId.trim()
      const targetModelId = modelId.trim()
      if (!targetProviderId || !targetModelId || !selectedOpenCodeConfig) return
      const draftKey = `${targetProviderId}:${targetModelId}`
      const rawDraft = openCodeModelIdDrafts[draftKey]
      if (typeof rawDraft !== "string") return
      const nextModelId = rawDraft.trim()

      if (!nextModelId || nextModelId === targetModelId) {
        setOpenCodeModelIdDrafts((prev) => {
          const next = { ...prev }
          delete next[draftKey]
          return next
        })
        return
      }

      if (!/^[A-Za-z0-9_.:-]+$/.test(nextModelId)) {
        toast.error(t("errors.modelIdPattern"))
        return
      }

      const targetProvider = selectedOpenCodeConfig.providers[targetProviderId]
      if (!targetProvider) return
      if (targetProvider.modelIds.includes(nextModelId)) {
        toast.error(t("errors.modelExists", { modelId: nextModelId }))
        return
      }

      handleOpenCodeConfigPatch((config) => {
        const providerRoot = asObjectRecord(config.provider) ?? {}
        if (!asObjectRecord(config.provider)) {
          config.provider = providerRoot
        }
        const currentProvider =
          asObjectRecord(providerRoot[targetProviderId]) ?? {}
        if (!asObjectRecord(providerRoot[targetProviderId])) {
          providerRoot[targetProviderId] = currentProvider
        }
        const modelsRoot = asObjectRecord(currentProvider.models) ?? {}
        if (!asObjectRecord(currentProvider.models)) {
          currentProvider.models = modelsRoot
        }
        const currentModel = asObjectRecord(modelsRoot[targetModelId]) ?? {}
        if (!asObjectRecord(modelsRoot[targetModelId])) return
        delete currentModel.id
        modelsRoot[nextModelId] = currentModel
        delete modelsRoot[targetModelId]
      })

      setOpenCodeModelIdDrafts((prev) => {
        const next = { ...prev }
        delete next[draftKey]
        return next
      })
    },
    [
      handleOpenCodeConfigPatch,
      openCodeModelIdDrafts,
      selectedOpenCodeConfig,
      t,
    ]
  )

  const handleOpenCodeModelFieldChange = useCallback(
    (providerId: string, modelId: string, value: string) => {
      const targetProviderId = providerId.trim()
      const targetModelId = modelId.trim()
      if (!targetProviderId || !targetModelId) return
      handleOpenCodeConfigPatch((config) => {
        const providerRoot = asObjectRecord(config.provider) ?? {}
        if (!asObjectRecord(config.provider)) {
          config.provider = providerRoot
        }
        const currentProvider =
          asObjectRecord(providerRoot[targetProviderId]) ?? {}
        if (!asObjectRecord(providerRoot[targetProviderId])) {
          providerRoot[targetProviderId] = currentProvider
        }
        const modelsRoot = asObjectRecord(currentProvider.models) ?? {}
        if (!asObjectRecord(currentProvider.models)) {
          currentProvider.models = modelsRoot
        }
        const currentModel = asObjectRecord(modelsRoot[targetModelId]) ?? {}
        if (!asObjectRecord(modelsRoot[targetModelId])) {
          modelsRoot[targetModelId] = currentModel
        }
        const trimmed = value.trim()
        if (trimmed) {
          currentModel.name = trimmed
        } else {
          delete currentModel.name
        }
        // Cleanup legacy schema written by earlier versions.
        delete currentModel.id
      })
    },
    [handleOpenCodeConfigPatch]
  )

  const handleCodexConfigTomlTextChange = useCallback(
    (nextText: string) => {
      if (!selectedAgent || selectedAgent.agent_type !== "codex") return
      const important = extractCodexImportantValues(
        selectedDraft?.codexAuthJsonText ?? "",
        nextText
      )
      updateSelectedDraft((current) => ({
        ...current,
        codexConfigTomlText: nextText,
        apiBaseUrl: important.apiBaseUrl,
        apiKey: important.apiKey ?? current.apiKey,
        model: important.model,
        codexModelProvider: important.modelProvider,
        codexProviderOptions: important.providerOptions,
        codexSupportsWebsockets: important.supportsWebsockets,
        codexSkills: important.skills,
        codexDefaultModeRequestUserInput: important.defaultModeRequestUserInput,
        codexServiceTierFast: important.serviceTierFast,
      }))
    },
    [selectedAgent, selectedDraft, updateSelectedDraft]
  )

  const handleCodexAuthModeChange = useCallback(
    (nextMode: CodexAuthMode) => {
      if (
        !selectedAgent ||
        !selectedDraft ||
        selectedAgent.agent_type !== "codex"
      )
        return

      if (nextMode === "chatgpt_subscription") {
        // Official subscription: set auth_mode to chatgpt, OPENAI_API_KEY to null
        const nextAuth = patchCodexAuthJsonText(
          selectedDraft.codexAuthJsonText,
          { authMode: "chatgpt" }
        )
        const nextAuthJsonText = nextAuth.authJsonText
        let nextConfigTomlText = updateTomlRootStringKey(
          selectedDraft.codexConfigTomlText,
          "model_provider",
          ""
        )
        nextConfigTomlText = removeTomlSection(
          nextConfigTomlText,
          `model_providers.${CODEX_DEFAULT_MODEL_PROVIDER}`
        )
        const synced = extractCodexImportantValues(
          nextAuthJsonText,
          nextConfigTomlText
        )
        updateSelectedDraft((current) => ({
          ...current,
          codexAuthMode: nextMode,
          modelProviderId: null,
          codexAuthJsonText: nextAuthJsonText,
          codexConfigTomlText: nextConfigTomlText,
          envText: patchEnvText(current.envText, {
            OPENAI_API_KEY: "",
            OPENAI_BASE_URL: "",
          }),
          apiBaseUrl: "",
          apiKey: "",
          model: synced.model,
          codexModelProvider: synced.modelProvider,
          codexProviderOptions: synced.providerOptions,
          codexSupportsWebsockets: synced.supportsWebsockets,
          codexSkills: synced.skills,
          codexDefaultModeRequestUserInput: synced.defaultModeRequestUserInput,
          codexServiceTierFast: synced.serviceTierFast,
        }))
        return
      }

      // "api_key" or "model_provider": ensure model_provider = "codeg" in toml
      const nextConfigTomlText = patchCodexConfigTomlText(
        selectedDraft.codexConfigTomlText,
        { modelProvider: CODEX_DEFAULT_MODEL_PROVIDER }
      )
      const nextAuthPatch = patchCodexAuthJsonText(
        selectedDraft.codexAuthJsonText,
        { authMode: null }
      )
      const nextAuthJsonText = nextAuthPatch.authJsonText
      const synced = extractCodexImportantValues(
        nextAuthJsonText,
        nextConfigTomlText
      )
      updateSelectedDraft((current) => ({
        ...current,
        codexAuthMode: nextMode,
        modelProviderId:
          nextMode === "model_provider" ? current.modelProviderId : null,
        codexAuthJsonText: nextAuthJsonText,
        codexConfigTomlText: nextConfigTomlText,
        apiBaseUrl: synced.apiBaseUrl,
        apiKey: synced.apiKey ?? current.apiKey,
        model: synced.model,
        codexModelProvider: CODEX_DEFAULT_MODEL_PROVIDER,
        codexProviderOptions: synced.providerOptions,
        codexSupportsWebsockets: synced.supportsWebsockets,
        codexSkills: synced.skills,
        codexDefaultModeRequestUserInput: synced.defaultModeRequestUserInput,
        codexServiceTierFast: synced.serviceTierFast,
      }))
    },
    [selectedAgent, selectedDraft, updateSelectedDraft]
  )

  const handleCodexModelListChange = useCallback(
    (next: CodexModelConfig) => {
      const defaultSlug = next.default ?? next.customs[0]?.slug ?? ""
      // `next` arrives already pruned of exclusions that no longer name a
      // listable official, so a plain count is the *effective* customization —
      // codeg only takes over codex's model table when something really deviates.
      const hasCatalog =
        next.customs.length > 0 || (next.excludedOfficials?.length ?? 0) > 0
      updateSelectedDraft((current) => {
        let toml = updateTomlRootStringKey(
          current.codexConfigTomlText,
          "model",
          defaultSlug
        )
        toml = updateTomlRootStringKey(
          toml,
          "model_catalog_json",
          hasCatalog ? "codeg-model-catalog.json" : ""
        )
        return {
          ...current,
          codexModelList: next,
          model: defaultSlug,
          codexConfigTomlText: toml,
        }
      })
    },
    [updateSelectedDraft]
  )

  const handleCodexImportantConfigChange = useCallback(
    (key: "apiBaseUrl" | "apiKey" | "model", value: string) => {
      if (
        !selectedAgent ||
        !selectedDraft ||
        selectedAgent.agent_type !== "codex"
      )
        return
      const nextAuth =
        key === "apiKey"
          ? patchCodexAuthJsonText(selectedDraft.codexAuthJsonText, {
              apiKey: value,
            })
          : {
              authJsonText: selectedDraft.codexAuthJsonText,
              recoveredFromInvalid: false,
            }
      const nextToml =
        key === "apiBaseUrl"
          ? patchCodexConfigTomlText(selectedDraft.codexConfigTomlText, {
              apiBaseUrl: value,
              modelProvider: selectedDraft.codexModelProvider,
            })
          : key === "model"
            ? patchCodexConfigTomlText(selectedDraft.codexConfigTomlText, {
                model: value,
              })
            : selectedDraft.codexConfigTomlText
      if (nextAuth.recoveredFromInvalid) {
        toast.warning(t("warnings.authRecoveredStructured"))
      }
      const synced = extractCodexImportantValues(
        nextAuth.authJsonText,
        nextToml
      )
      updateSelectedDraft((current) => ({
        ...applyImportantFieldToDraft(current, key, value),
        apiBaseUrl: synced.apiBaseUrl,
        apiKey: synced.apiKey ?? current.apiKey,
        model: synced.model,
        codexModelProvider: synced.modelProvider,
        codexProviderOptions: synced.providerOptions,
        codexSupportsWebsockets: synced.supportsWebsockets,
        codexSkills: synced.skills,
        codexDefaultModeRequestUserInput: synced.defaultModeRequestUserInput,
        codexServiceTierFast: synced.serviceTierFast,
        codexAuthJsonText: nextAuth.authJsonText,
        codexConfigTomlText: nextToml,
      }))
    },
    [selectedAgent, selectedDraft, t, updateSelectedDraft]
  )

  const handleCodexSupportsWebsocketsChange = useCallback(
    (enabled: boolean) => {
      if (
        !selectedAgent ||
        !selectedDraft ||
        selectedAgent.agent_type !== "codex"
      )
        return
      const nextToml = patchCodexConfigTomlText(
        selectedDraft.codexConfigTomlText,
        {
          modelProvider: selectedDraft.codexModelProvider,
          supportsWebsockets: enabled,
        }
      )
      const synced = extractCodexImportantValues(
        selectedDraft.codexAuthJsonText,
        nextToml
      )
      updateSelectedDraft((current) => ({
        ...current,
        apiBaseUrl: synced.apiBaseUrl,
        apiKey: synced.apiKey ?? current.apiKey,
        model: synced.model,
        codexModelProvider: synced.modelProvider,
        codexProviderOptions: synced.providerOptions,
        codexSupportsWebsockets: synced.supportsWebsockets,
        codexSkills: synced.skills,
        codexDefaultModeRequestUserInput: synced.defaultModeRequestUserInput,
        codexServiceTierFast: synced.serviceTierFast,
        codexConfigTomlText: nextToml,
      }))
    },
    [selectedAgent, selectedDraft, updateSelectedDraft]
  )

  const handleCodexSkillsChange = useCallback(
    (enabled: boolean) => {
      if (
        !selectedAgent ||
        !selectedDraft ||
        selectedAgent.agent_type !== "codex"
      )
        return
      const nextToml = patchCodexConfigTomlText(
        selectedDraft.codexConfigTomlText,
        { skills: enabled }
      )
      const synced = extractCodexImportantValues(
        selectedDraft.codexAuthJsonText,
        nextToml
      )
      updateSelectedDraft((current) => ({
        ...current,
        apiBaseUrl: synced.apiBaseUrl,
        apiKey: synced.apiKey ?? current.apiKey,
        model: synced.model,
        codexModelProvider: synced.modelProvider,
        codexProviderOptions: synced.providerOptions,
        codexSupportsWebsockets: synced.supportsWebsockets,
        codexSkills: synced.skills,
        codexDefaultModeRequestUserInput: synced.defaultModeRequestUserInput,
        codexServiceTierFast: synced.serviceTierFast,
        codexConfigTomlText: nextToml,
      }))
    },
    [selectedAgent, selectedDraft, updateSelectedDraft]
  )

  const handleCodexDefaultModeRequestUserInputChange = useCallback(
    (enabled: boolean) => {
      if (
        !selectedAgent ||
        !selectedDraft ||
        selectedAgent.agent_type !== "codex"
      )
        return
      const nextToml = patchCodexConfigTomlText(
        selectedDraft.codexConfigTomlText,
        { defaultModeRequestUserInput: enabled }
      )
      const synced = extractCodexImportantValues(
        selectedDraft.codexAuthJsonText,
        nextToml
      )
      updateSelectedDraft((current) => ({
        ...current,
        apiBaseUrl: synced.apiBaseUrl,
        apiKey: synced.apiKey ?? current.apiKey,
        model: synced.model,
        codexModelProvider: synced.modelProvider,
        codexProviderOptions: synced.providerOptions,
        codexSupportsWebsockets: synced.supportsWebsockets,
        codexSkills: synced.skills,
        codexDefaultModeRequestUserInput: synced.defaultModeRequestUserInput,
        codexServiceTierFast: synced.serviceTierFast,
        codexConfigTomlText: nextToml,
      }))
    },
    [selectedAgent, selectedDraft, updateSelectedDraft]
  )

  const handleCodexServiceTierFastChange = useCallback(
    (enabled: boolean) => {
      if (
        !selectedAgent ||
        !selectedDraft ||
        selectedAgent.agent_type !== "codex"
      )
        return
      const nextToml = patchCodexConfigTomlText(
        selectedDraft.codexConfigTomlText,
        { serviceTierFast: enabled }
      )
      const synced = extractCodexImportantValues(
        selectedDraft.codexAuthJsonText,
        nextToml
      )
      updateSelectedDraft((current) => ({
        ...current,
        apiBaseUrl: synced.apiBaseUrl,
        apiKey: synced.apiKey ?? current.apiKey,
        model: synced.model,
        codexModelProvider: synced.modelProvider,
        codexProviderOptions: synced.providerOptions,
        codexSupportsWebsockets: synced.supportsWebsockets,
        codexSkills: synced.skills,
        codexDefaultModeRequestUserInput: synced.defaultModeRequestUserInput,
        codexServiceTierFast: synced.serviceTierFast,
        codexConfigTomlText: nextToml,
      }))
    },
    [selectedAgent, selectedDraft, updateSelectedDraft]
  )

  const handleCodexDeviceLogin = useCallback(async () => {
    setCodexLoginStatus("requesting")
    setCodexLoginError(null)
    setCodexDeviceCode(null)
    codexPollCancelledRef.current = false
    try {
      const resp = await codexRequestDeviceCode()
      setCodexDeviceCode(resp)
      setCodexLoginStatus("polling")
    } catch (err) {
      const msg = toErrorMessage(err)
      setCodexLoginError(msg)
      setCodexLoginStatus("error")
    }
  }, [])

  const cancelCodexDeviceLogin = useCallback(() => {
    codexPollCancelledRef.current = true
    setCodexLoginStatus("idle")
    setCodexDeviceCode(null)
    setCodexLoginError(null)
  }, [])

  useEffect(() => {
    if (codexLoginStatus !== "polling" || !codexDeviceCode) return
    codexPollCancelledRef.current = false
    const pollInterval = (codexDeviceCode.interval || 5) * 1000
    const deadline = Date.now() + 15 * 60 * 1000
    let timer: ReturnType<typeof setTimeout> | null = null
    let active = true

    const poll = async () => {
      if (!active || codexPollCancelledRef.current) return
      if (Date.now() > deadline) {
        setCodexLoginError(t("codex.loginTimeout"))
        setCodexLoginStatus("error")
        setCodexDeviceCode(null)
        return
      }
      try {
        const result = await codexPollDeviceCode({
          deviceAuthId: codexDeviceCode.deviceAuthId,
          userCode: codexDeviceCode.userCode,
        })
        if (!active || codexPollCancelledRef.current) return
        if (result.status === "success") {
          setCodexLoginStatus("success")
          setCodexDeviceCode(null)
          const authJson = JSON.stringify(
            {
              auth_mode: "chatgpt",
              OPENAI_API_KEY: null,
              tokens: {
                id_token: result.idToken,
                access_token: result.accessToken,
                refresh_token: result.refreshToken,
                account_id: result.accountId ?? "",
              },
              last_refresh: new Date().toISOString(),
            },
            null,
            2
          )
          updateSelectedDraft((current) => ({
            ...current,
            codexAuthJsonText: authJson,
          }))
          const draft = drafts.codex
          if (draft) {
            const codexEnvText =
              draft.codexAuthMode === "chatgpt_subscription"
                ? patchEnvText(draft.envText, {
                    OPENAI_API_KEY: "",
                    OPENAI_BASE_URL: "",
                  })
                : draft.envText
            try {
              // Persist sequentially, never in parallel: persistEnv
              // (acp_update_agent_env) rewrites ~/.codex/config.toml to sync the
              // root `model`, while persistConfig writes the full config.toml
              // (including base_url). Running both at once races two
              // read-modify-write cycles on the same file, letting the model
              // sync clobber the just-written base_url. persistConfig runs last
              // so its authoritative config.toml wins.
              await persistEnv(
                "codex",
                draft.enabled,
                codexEnvText,
                draft.modelProviderId
              )
              await persistConfig("codex", draft.configText, {
                codexAuthJsonText: authJson,
                codexConfigTomlText: draft.codexConfigTomlText,
                codexModelCatalog:
                  serializeCodexModelConfig(draft.codexModelList) ?? "",
                codexSandbox: codexSandboxSaveConfig(draft),
              })
            } catch (err) {
              const msg = toErrorMessage(err)
              toast.error(t("codex.loginSaveFailed"), {
                description: msg,
              })
            }
          }
          return
        }
        if (result.status === "error") {
          setCodexLoginError(result.message ?? "Unknown error")
          setCodexLoginStatus("error")
          setCodexDeviceCode(null)
          return
        }
        timer = setTimeout(poll, pollInterval)
      } catch {
        if (!active || codexPollCancelledRef.current) return
        timer = setTimeout(poll, pollInterval)
      }
    }

    timer = setTimeout(poll, pollInterval)
    return () => {
      active = false
      if (timer) clearTimeout(timer)
    }
  }, [
    codexLoginStatus,
    codexDeviceCode,
    drafts.codex,
    persistConfig,
    persistEnv,
    updateSelectedDraft,
    t,
  ])

  useEffect(() => {
    if (selectedAgent?.agent_type !== "codex" && codexLoginStatus !== "idle") {
      cancelCodexDeviceLogin()
    }
  }, [selectedAgent, codexLoginStatus, cancelCodexDeviceLogin])

  if (loadingAgents) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        {t("loadingAgents")}
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col p-3 md:p-4">
      <div className="flex items-center justify-between gap-3 pb-4">
        <div>
          <h2 className="text-base font-semibold">{t("title")}</h2>
          <p className="text-xs text-muted-foreground mt-1">
            {t("description")}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-8 text-xs shrink-0"
          onClick={() => setAddCustomOpen(true)}
        >
          <Plus className="h-3.5 w-3.5 mr-1" />
          {t("addCustomAgent")}
        </Button>
      </div>

      <AddCustomAgentDialog
        open={addCustomOpen}
        onOpenChange={setAddCustomOpen}
        onAdded={() => void refreshAgents()}
      />

      {/* Keyed by the id so switching agents never leaks a previous form. */}
      {editCustomAgentId !== null && (
        <AddCustomAgentDialog
          key={editCustomAgentId}
          open
          editRegistryId={editCustomAgentId}
          onOpenChange={(next) => {
            if (!next) setEditCustomAgentId(null)
          }}
          onAdded={() => void refreshAgents()}
        />
      )}

      {loadingError && (
        <div className="mb-3 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400">
          {loadingError}
        </div>
      )}

      <div className="flex-1 min-h-0 grid gap-3 lg:grid-cols-[minmax(15rem,20rem)_1fr]">
        <div className="min-h-0 min-w-0 rounded-lg border bg-card flex flex-col overflow-hidden">
          <div className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">
            {t("agentList")}
          </div>
          <Reorder.Group
            as="div"
            axis="y"
            values={sortedAgents}
            onReorder={handleReorder}
            ref={agentListRef}
            className="flex-1 min-h-0 overflow-y-auto space-y-2 p-2"
          >
            {sortedAgents.map((agent) => {
              const current = checkState[agent.agent_type]
              const isChecking = Boolean(checking[agent.agent_type])
              const draft = drafts[agent.agent_type] ?? buildAgentDraft(agent)
              const allChecks = getAgentChecks(agent, current)
              const summary = summarizeChecks(allChecks)
              const displaySummary: CheckStatus | "unchecked" | "checking" =
                isChecking ? "checking" : summary
              const statusLabel =
                displaySummary === "unchecked"
                  ? t("status.unchecked")
                  : displaySummary === "checking"
                    ? "Checking"
                    : displaySummary.toUpperCase()
              const statusToneClass = !draft.enabled
                ? "border-muted-foreground/30 bg-muted/30 text-muted-foreground"
                : displaySummary === "pass"
                  ? "border-green-500/40 bg-green-500/10 text-green-600 dark:text-green-400"
                  : displaySummary === "fail"
                    ? "border-red-500/40 bg-red-500/10 text-red-500"
                    : displaySummary === "warn"
                      ? "border-yellow-500/40 bg-yellow-500/10 text-yellow-600 dark:text-yellow-400"
                      : displaySummary === "checking"
                        ? "border-blue-500/40 bg-blue-500/10 text-blue-600 dark:text-blue-400"
                        : "border-muted-foreground/30 bg-muted/30 text-muted-foreground"

              return (
                <AgentReorderItem
                  key={agent.agent_type}
                  agent={agent}
                  selected={selectedAgentType === agent.agent_type}
                  reordering={reordering}
                  dragging={dragging}
                  onDragStart={(agentType) => {
                    setDragging(agentType)
                  }}
                  onDragEnd={() => {
                    const order = pendingOrderRef.current
                    pendingOrderRef.current = null
                    setDragging(null)
                    if (order && !reordering) {
                      persistReorder(order).catch((err) => {
                        console.error("[Settings] reorder agents failed:", err)
                      })
                    }
                  }}
                  onSelect={(agentType) => {
                    setSelectedAgentType(agentType)
                  }}
                >
                  {(startDrag) => (
                    <div className="flex items-center justify-between gap-2 overflow-hidden">
                      <div className="min-w-0 flex items-center gap-2">
                        <button
                          type="button"
                          className="text-muted-foreground cursor-grab active:cursor-grabbing rounded p-0.5 hover:bg-muted"
                          title={t("actions.dragSort")}
                          aria-label={t("actions.dragSortAgent", {
                            name: agent.name,
                          })}
                          onPointerDown={startDrag}
                          onClick={(event) => {
                            event.stopPropagation()
                          }}
                          disabled={reordering}
                        >
                          <GripVertical className="h-3.5 w-3.5" />
                        </button>
                        <AgentIcon
                          agentType={agent.agent_type}
                          className="h-4 w-4"
                        />
                        <span className="text-sm font-medium truncate">
                          {agent.name}
                        </span>
                        {draft.enabled && (
                          <span
                            className="h-2 w-2 rounded-full bg-emerald-500 shrink-0"
                            aria-label={t("status.agentEnabledAria", {
                              name: agent.name,
                            })}
                            title={t("status.enabled")}
                          />
                        )}
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <Badge
                          variant="outline"
                          className={cn(
                            "h-6 px-2 inline-flex items-center gap-1 text-xs leading-none",
                            statusToneClass
                          )}
                        >
                          <span>{statusLabel}</span>
                          {displaySummary === "checking" && (
                            <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
                          )}
                          {!isChecking && (
                            <button
                              type="button"
                              className="inline-flex h-4 w-4 items-center justify-center rounded hover:bg-black/10 dark:hover:bg-white/10"
                              title={t("actions.refreshCheck")}
                              aria-label={t("actions.refreshCheckAgent", {
                                name: agent.name,
                              })}
                              onClick={(event) => {
                                event.stopPropagation()
                                runPreflight(agent.agent_type, true).catch(
                                  (err) => {
                                    console.error(
                                      "[Settings] single preflight failed:",
                                      err
                                    )
                                  }
                                )
                              }}
                            >
                              <RefreshCw className="h-3 w-3 shrink-0" />
                            </button>
                          )}
                        </Badge>
                      </div>
                    </div>
                  )}
                </AgentReorderItem>
              )
            })}
          </Reorder.Group>
        </div>

        <div className="min-h-0 min-w-0 rounded-lg border bg-card">
          {selectedAgent && selectedDraft ? (
            <div className="h-full flex flex-col">
              <div className="border-b px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex items-center gap-2">
                    <AgentIcon
                      agentType={selectedAgent.agent_type}
                      className="h-5 w-5"
                    />
                    <h3 className="text-sm font-semibold truncate">
                      {selectedAgent.name}
                    </h3>
                    <Badge variant="outline" className="shrink-0">
                      {selectedAgent.distribution_type}
                    </Badge>
                    {/* Names the thing codeg actually installs, right next to
                        the vendor's name — so the split is visible even before
                        anyone reads the preflight card below. */}
                    {selectedAgent.is_acp_adapter && (
                      <Badge
                        variant="secondary"
                        className="shrink-0"
                        title={t("adapter.badgeHint")}
                      >
                        {t("adapter.badge")}
                      </Badge>
                    )}
                    {isCustomAgentType(selectedAgent.agent_type) && (
                      <Badge variant="secondary" className="shrink-0">
                        {t("customAgentBadge")}
                      </Badge>
                    )}
                  </div>
                  {/* Removing a custom agent lives in the danger row at the
                      bottom of the panel, not here: this line already carries
                      the name, the distribution badge, the Custom badge and
                      the enable switch. */}
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={selectedDraft.enabled}
                      aria-label={t("status.agentEnabledSwitch", {
                        name: selectedAgent.name,
                      })}
                      title={
                        selectedDraft.enabled
                          ? t("actions.clickDisable", {
                              name: selectedAgent.name,
                            })
                          : t("actions.clickEnable", {
                              name: selectedAgent.name,
                            })
                      }
                      disabled={selectedIsSaving || selectedGrokSaving}
                      className={cn(
                        "relative inline-flex h-5 w-9 items-center rounded-full transition-colors",
                        selectedDraft.enabled
                          ? "bg-primary"
                          : "bg-muted-foreground/30",
                        selectedIsSaving && "cursor-not-allowed opacity-60"
                      )}
                      onClick={() => {
                        const nextEnabled = !selectedDraft.enabled
                        const nextDraft = {
                          ...selectedDraft,
                          enabled: nextEnabled,
                        }
                        setDrafts((prev) => ({
                          ...prev,
                          [selectedAgent.agent_type]: nextDraft,
                        }))
                        persistEnv(
                          selectedAgent.agent_type,
                          nextEnabled,
                          nextDraft.envText,
                          nextDraft.modelProviderId
                        ).catch((err) => {
                          console.error(
                            "[Settings] persist enabled failed:",
                            err
                          )
                          const message = toErrorMessage(err)
                          toast.error(t("toasts.saveAgentSwitchFailed"), {
                            description: message,
                          })
                        })
                      }}
                    >
                      <span
                        className={cn(
                          "inline-block h-4 w-4 rounded-full bg-background shadow-sm transition-transform",
                          selectedDraft.enabled
                            ? "translate-x-4"
                            : "translate-x-0.5"
                        )}
                      />
                    </button>
                  </div>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {selectedAgent.description}
                </p>
              </div>

              <AgentDiagnosticsDialog
                open={diagnosticsOpen}
                onOpenChange={setDiagnosticsOpen}
                agentType={selectedAgent.agent_type}
              />

              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                <div className="space-y-2">
                  {selectedCurrent?.error && (
                    <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400 flex items-start gap-2">
                      <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                      <span className="break-all">{selectedCurrent.error}</span>
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-2xs text-muted-foreground flex items-center gap-1">
                      <CheckCircle2 className="h-3 w-3" />
                      {t("preflight.count", { count: selectedChecks.length })}
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={() => setDiagnosticsOpen(true)}
                    >
                      <Stethoscope className="h-3.5 w-3.5" />
                      {t("actions.diagnose")}
                    </Button>
                  </div>
                  {selectedChecks.length > 0 ? (
                    selectedChecks.map((check) =>
                      renderCheck(selectedAgent, check)
                    )
                  ) : (
                    <div className="text-xs text-muted-foreground">
                      {t("preflight.notRun")}
                    </div>
                  )}
                  {installStream.status !== "idle" &&
                    streamAgentType === selectedAgent.agent_type && (
                      <div className="mt-2 rounded-md border bg-muted/50 text-muted-foreground p-3 max-h-[12.5rem] overflow-y-auto font-mono text-2xs leading-relaxed">
                        {installStream.logs.map((line, i) => (
                          <div
                            key={i}
                            className={
                              line.startsWith("ERROR:")
                                ? "text-destructive"
                                : ""
                            }
                          >
                            {line}
                          </div>
                        ))}
                        <div ref={installLogEndRef} />
                      </div>
                    )}
                </div>

                <div className="space-y-2">
                  <label className="text-xs font-medium">{t("envVars")}</label>
                  <div className="relative group">
                    <Textarea
                      value={selectedDraft.envText}
                      onChange={(event) => {
                        updateSelectedDraft((current) => ({
                          ...current,
                          envText: event.target.value,
                        }))
                      }}
                      placeholder={"KEY1=VALUE1\nKEY2=VALUE2"}
                      className="min-h-24"
                      disabled={selectedGrokSaving}
                    />
                    <div className="pointer-events-none absolute inset-0 rounded-md bg-background/10 backdrop-blur-[3px] transition-opacity duration-200 group-focus-within:opacity-0" />
                  </div>
                  {/*
                    Backed by the same `envText` draft as the textarea above,
                    not self-persisting: saving on toggle would also commit
                    whatever unsaved edits the textarea happens to hold. One
                    Save button owns both.
                  */}
                  <div className="flex items-start justify-between gap-3 rounded-md border bg-muted/10 p-3">
                    <div className="space-y-1">
                      <label className="text-xs font-medium">
                        {t("hostTools.label")}
                      </label>
                      <p className="text-2xs text-muted-foreground">
                        {t("hostTools.description")}
                      </p>
                    </div>
                    <Switch
                      checked={hostToolsAgentModeEnabled(selectedDraft.envText)}
                      onCheckedChange={(checked) => {
                        updateSelectedDraft((current) => ({
                          ...current,
                          envText: setHostToolsAgentMode(
                            current.envText,
                            checked
                          ),
                        }))
                      }}
                      disabled={selectedGrokSaving}
                      aria-label={t("hostTools.label")}
                    />
                  </div>
                  {/*
                    Same contract as the host-tools switch above: backed by the
                    `envText` draft, persisted by the one Save button. Npx
                    agents only — a binary or uvx install has no npm dist-tag
                    to track.
                  */}
                  {selectedAgent.distribution_type === "npx" && (
                    <div className="flex items-start justify-between gap-3 rounded-md border bg-muted/10 p-3">
                      <div className="min-w-0 space-y-1">
                        <label className="text-xs font-medium">
                          {t("adapterChannel.label")}
                        </label>
                        <p className="text-2xs text-muted-foreground">
                          {t("adapterChannel.description")}
                        </p>
                        {adapterChannelFromEnvText(selectedDraft.envText) ===
                          "latest" && (
                          <p className="text-2xs text-yellow-600 dark:text-yellow-400">
                            {t("adapterChannel.latestWarning")}
                          </p>
                        )}
                      </div>
                      <Select
                        value={adapterChannelFromEnvText(selectedDraft.envText)}
                        onValueChange={(value) => {
                          updateSelectedDraft((current) => ({
                            ...current,
                            envText: setAdapterChannel(
                              current.envText,
                              value === "latest" ? "latest" : "pinned"
                            ),
                          }))
                        }}
                        disabled={selectedGrokSaving}
                      >
                        <SelectTrigger
                          className="w-44 shrink-0"
                          aria-label={t("adapterChannel.label")}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="pinned">
                            {t("adapterChannel.pinned")}
                          </SelectItem>
                          <SelectItem value="latest">
                            {t("adapterChannel.latest")}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      onClick={() => {
                        persistEnv(
                          selectedAgent.agent_type,
                          selectedDraft.enabled,
                          selectedDraft.envText,
                          selectedDraft.modelProviderId
                        )
                          .then(() => {
                            toast.success(t("toasts.configSaved"), {
                              description: t("toasts.configSavedHint"),
                            })
                          })
                          .catch((err) => {
                            console.error("[Settings] save env failed:", err)
                            const message = toErrorMessage(err)
                            toast.error(t("toasts.saveEnvFailed"), {
                              description: message,
                            })
                          })
                      }}
                      disabled={selectedIsSavingEnv || selectedGrokSaving}
                    >
                      {selectedIsSavingEnv ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          {t("actions.saving")}
                        </>
                      ) : (
                        <>
                          <Save className="h-3.5 w-3.5" />
                          {t("actions.saveEnvVars")}
                        </>
                      )}
                    </Button>
                  </div>
                </div>

                {selectedAgent.agent_type === "codex" ? (
                  <div className="space-y-3 rounded-md border bg-muted/10 p-3">
                    <div>
                      <label className="text-xs font-medium">
                        {t("configManagement")}
                      </label>
                      <p className="mt-1 text-2xs text-muted-foreground">
                        {t("codex.configDescription")}
                      </p>
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-2xs text-muted-foreground">
                        {t("codex.authMode")}
                      </label>
                      <Select
                        value={selectedDraft.codexAuthMode}
                        onValueChange={(value) => {
                          if (
                            CODEX_AUTH_MODES.includes(value as CodexAuthMode)
                          ) {
                            handleCodexAuthModeChange(value as CodexAuthMode)
                          }
                        }}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent align="start">
                          {CODEX_AUTH_MODES.map((mode) => (
                            <SelectItem key={mode} value={mode}>
                              {mode === "chatgpt_subscription"
                                ? t("authModeOfficialSubscription")
                                : mode === "model_provider"
                                  ? t("authModeModelProvider")
                                  : t("authModeCustomEndpoint")}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-2xs text-muted-foreground">
                        {selectedDraft.codexAuthMode === "chatgpt_subscription"
                          ? t("codex.chatgptSubscriptionHint")
                          : selectedDraft.codexAuthMode === "model_provider"
                            ? t("modelProviderHint")
                            : t("authModeCustomEndpointHint")}
                      </p>
                    </div>

                    {selectedDraft.codexAuthMode === "chatgpt_subscription" && (
                      <div className="space-y-2">
                        {hasCodexChatgptTokens(
                          selectedDraft.codexAuthJsonText
                        ) &&
                          codexLoginStatus !== "polling" &&
                          codexLoginStatus !== "requesting" && (
                            <div className="flex items-center gap-1.5 text-xs text-green-600">
                              <CheckCircle2 className="h-3 w-3" />
                              {t("codex.loggedIn")}
                            </div>
                          )}
                        {codexLoginStatus === "idle" && (
                          <Button
                            onClick={handleCodexDeviceLogin}
                            size="sm"
                            variant="outline"
                          >
                            {hasCodexChatgptTokens(
                              selectedDraft.codexAuthJsonText
                            )
                              ? t("codex.loginRelogin")
                              : t("codex.loginButton")}
                          </Button>
                        )}
                        {codexLoginStatus === "requesting" && (
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            {t("codex.loginRequesting")}
                          </div>
                        )}
                        {codexLoginStatus === "polling" && codexDeviceCode && (
                          <div className="space-y-2 rounded-md border p-3">
                            <p className="text-xs">{t("codex.loginStep1")}</p>
                            <button
                              type="button"
                              className="text-xs text-primary underline cursor-pointer"
                              onClick={() =>
                                openUrl(codexDeviceCode.verificationUrl)
                              }
                            >
                              {codexDeviceCode.verificationUrl}
                            </button>
                            <p className="text-xs mt-1">
                              {t("codex.loginStep2")}
                            </p>
                            <div className="flex items-center gap-2">
                              <code className="rounded bg-muted px-2 py-1 text-sm font-mono font-bold tracking-widest">
                                {codexDeviceCode.userCode}
                              </code>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 w-7 p-0"
                                onClick={async () => {
                                  const ok = await copyTextToClipboard(
                                    codexDeviceCode.userCode
                                  )
                                  if (ok) {
                                    toast.success(t("codex.loginCodeCopied"))
                                  }
                                }}
                              >
                                <Copy className="h-3 w-3" />
                              </Button>
                            </div>
                            <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
                              <Loader2 className="h-3 w-3 animate-spin" />
                              {t("codex.loginPolling")}
                            </div>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={cancelCodexDeviceLogin}
                            >
                              {t("codex.loginCancel")}
                            </Button>
                          </div>
                        )}
                        {codexLoginStatus === "success" && (
                          <div className="flex items-center gap-1.5 text-xs text-green-600">
                            <CheckCircle2 className="h-3 w-3" />
                            {t("codex.loginSuccess")}
                          </div>
                        )}
                        {codexLoginStatus === "error" && (
                          <div className="space-y-1.5">
                            <p className="text-xs text-destructive">
                              {t("codex.loginFailed", {
                                message: codexLoginError ?? "Unknown error",
                              })}
                            </p>
                            <Button
                              onClick={handleCodexDeviceLogin}
                              size="sm"
                              variant="outline"
                            >
                              {t("codex.loginRetry")}
                            </Button>
                          </div>
                        )}
                      </div>
                    )}

                    {selectedDraft.codexAuthMode === "model_provider" && (
                      <div className="space-y-1.5">
                        <label className="text-2xs text-muted-foreground">
                          {t("selectModelProvider")}
                        </label>
                        {selectedModelProviders.length > 0 ? (
                          <Select
                            value={
                              selectedDraft.modelProviderId != null
                                ? String(selectedDraft.modelProviderId)
                                : ""
                            }
                            onValueChange={handleModelProviderSelect}
                          >
                            <SelectTrigger className="w-full">
                              <SelectValue
                                placeholder={t("selectModelProvider")}
                              />
                            </SelectTrigger>
                            <SelectContent align="start">
                              {selectedModelProviders.map((provider) => (
                                <SelectItem
                                  key={provider.id}
                                  value={String(provider.id)}
                                >
                                  {provider.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <p className="text-2xs text-muted-foreground">
                            {t("noModelProviderAvailable")}
                          </p>
                        )}
                      </div>
                    )}

                    {(selectedDraft.codexAuthMode === "api_key" ||
                      selectedDraft.codexAuthMode === "model_provider") && (
                      <div className="space-y-1.5">
                        <label className="text-2xs text-muted-foreground">
                          API URL
                        </label>
                        <Input
                          value={selectedDraft.apiBaseUrl}
                          readOnly={
                            selectedDraft.codexAuthMode === "model_provider"
                          }
                          onChange={(event) => {
                            handleCodexImportantConfigChange(
                              "apiBaseUrl",
                              event.target.value
                            )
                          }}
                          placeholder="https://api.openai.com/v1"
                        />
                      </div>
                    )}

                    {(selectedDraft.codexAuthMode === "api_key" ||
                      selectedDraft.codexAuthMode === "model_provider") && (
                      <div className="space-y-1.5">
                        <label className="text-2xs text-muted-foreground">
                          API Key
                        </label>
                        <div className="flex items-center gap-2">
                          <Input
                            type={
                              showApiKeys[selectedAgent.agent_type]
                                ? "text"
                                : "password"
                            }
                            value={selectedDraft.apiKey}
                            readOnly={
                              selectedDraft.codexAuthMode === "model_provider"
                            }
                            onChange={(event) => {
                              handleCodexImportantConfigChange(
                                "apiKey",
                                event.target.value
                              )
                            }}
                            placeholder="sk-..."
                          />
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setShowApiKeys((prev) => ({
                                ...prev,
                                [selectedAgent.agent_type]:
                                  !prev[selectedAgent.agent_type],
                              }))
                            }}
                            title={
                              showApiKeys[selectedAgent.agent_type]
                                ? t("actions.hideApiKey")
                                : t("actions.showApiKey")
                            }
                          >
                            {showApiKeys[selectedAgent.agent_type] ? (
                              <EyeOff className="h-3.5 w-3.5" />
                            ) : (
                              <Eye className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        </div>
                      </div>
                    )}

                    {(selectedDraft.codexAuthMode === "api_key" ||
                      selectedDraft.codexAuthMode === "model_provider") && (
                      <div className="space-y-1.5">
                        <CodexModelListEditor
                          value={selectedDraft.codexModelList}
                          onChange={handleCodexModelListChange}
                          readOnly={
                            selectedDraft.codexAuthMode === "model_provider"
                          }
                        />
                      </div>
                    )}

                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between rounded-md border px-3 py-2">
                        <label className="text-2xs text-muted-foreground">
                          {t("codex.enableWebsocket")}
                        </label>
                        <Switch
                          checked={selectedDraft.codexSupportsWebsockets}
                          onCheckedChange={handleCodexSupportsWebsocketsChange}
                          aria-label={t("codex.enableWebsocketAria")}
                        />
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between rounded-md border px-3 py-2">
                        <label className="text-2xs text-muted-foreground">
                          {t("codex.enableSkills")}
                        </label>
                        <Switch
                          checked={selectedDraft.codexSkills}
                          onCheckedChange={handleCodexSkillsChange}
                          aria-label={t("codex.enableSkillsAria")}
                        />
                      </div>
                    </div>

                    {/* `[features].default_mode_request_user_input` — without
                        it codex refuses its own `request_user_input` tool
                        outside Plan mode, so codeg's question cards never
                        appear in an ordinary turn (openai/codex#24750). */}
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between rounded-md border px-3 py-2">
                        <label className="text-2xs text-muted-foreground">
                          {t("codex.enableDefaultModeRequestUserInput")}
                        </label>
                        <Switch
                          checked={
                            selectedDraft.codexDefaultModeRequestUserInput
                          }
                          onCheckedChange={
                            handleCodexDefaultModeRequestUserInputChange
                          }
                          aria-label={t(
                            "codex.enableDefaultModeRequestUserInputAria"
                          )}
                        />
                      </div>
                      <p className="text-3xs text-muted-foreground">
                        {t("codex.enableDefaultModeRequestUserInputHint")}
                      </p>
                    </div>

                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between rounded-md border px-3 py-2">
                        <label className="text-2xs text-muted-foreground">
                          {t("codex.enableFast")}
                        </label>
                        <Switch
                          checked={selectedDraft.codexServiceTierFast}
                          onCheckedChange={handleCodexServiceTierFastChange}
                          aria-label={t("codex.enableFastAria")}
                        />
                      </div>
                    </div>

                    {/* ---- Sandbox & approvals (config.toml thread defaults) ----
                        These govern the turns codex starts by itself: /goal,
                        /review, /compact. Ordinary prompts carry the composer
                        preset's own policy per turn and ignore these keys. */}
                    <div className="space-y-2 rounded-md border px-3 py-2.5">
                      <div className="space-y-1">
                        <p className="text-2xs font-medium">
                          {t("codex.sandboxGroupTitle")}
                        </p>
                        <p className="text-3xs text-muted-foreground">
                          {t("codex.sandboxGroupHint")}
                        </p>
                      </div>

                      {selectedDraft.codexSandboxShadowed ? (
                        <p className="text-3xs text-yellow-500">
                          {t("codex.sandboxShadowedWarning")}
                        </p>
                      ) : null}
                      {selectedDraft.codexSandboxHasPermissionsTable &&
                      !selectedDraft.codexSandboxShadowed ? (
                        <p className="text-3xs text-yellow-500">
                          {t("codex.sandboxPermissionsTableWarning")}
                        </p>
                      ) : null}

                      <div className="space-y-1.5">
                        <label className="text-2xs text-muted-foreground">
                          {t("codex.approvalPolicyLabel")}
                        </label>
                        <Select
                          value={
                            selectedDraft.codexApprovalPolicy ||
                            CODEX_SANDBOX_UNSET_OPTION
                          }
                          onValueChange={(value) => {
                            updateSelectedDraft((current) => ({
                              ...current,
                              codexApprovalPolicy:
                                value === CODEX_SANDBOX_UNSET_OPTION
                                  ? CODEX_SANDBOX_UNSET
                                  : (value as CodexApprovalPolicyChoice),
                            }))
                          }}
                        >
                          <SelectTrigger className="h-8 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent align="start">
                            <SelectItem value={CODEX_SANDBOX_UNSET_OPTION}>
                              {t("codex.approvalPolicyUnset")}
                            </SelectItem>
                            {CODEX_APPROVAL_POLICY_VALUES.map((value) => (
                              <SelectItem key={value} value={value}>
                                {t(`codex.approvalPolicy_${value}`)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {/* `untrusted` has no equivalent in codex-acp's three
                            approval presets, so an ACP session cannot honor it
                            (#442). Say so where the user picks it, rather than
                            letting it look effective. */}
                        {selectedDraft.codexApprovalPolicy === "untrusted" ? (
                          <p className="text-3xs text-yellow-500">
                            {t("codex.approvalPolicyUntrustedAcpWarning")}
                          </p>
                        ) : null}
                      </div>

                      {selectedDraft.codexApprovalPolicy === "granular" ? (
                        <div className="space-y-1 rounded-md border border-dashed px-2.5 py-2">
                          <p className="text-3xs text-muted-foreground">
                            {t("codex.granularHint")}
                          </p>
                          {CODEX_GRANULAR_KEYS.map((key) => (
                            <div
                              className="flex items-center justify-between gap-2 py-0.5"
                              key={key}
                            >
                              <label className="text-2xs text-muted-foreground">
                                {t(`codex.granular_${key}`)}
                              </label>
                              <Switch
                                checked={selectedDraft.codexGranular[key]}
                                onCheckedChange={(checked) => {
                                  updateSelectedDraft((current) => ({
                                    ...current,
                                    codexGranular: {
                                      ...current.codexGranular,
                                      [key]: checked,
                                    },
                                  }))
                                }}
                                aria-label={t(`codex.granular_${key}`)}
                              />
                            </div>
                          ))}
                        </div>
                      ) : null}

                      <div className="space-y-1.5">
                        <label className="text-2xs text-muted-foreground">
                          {t("codex.sandboxModeLabel")}
                        </label>
                        <Select
                          disabled={selectedDraft.codexSandboxShadowed}
                          value={
                            selectedDraft.codexSandboxMode ||
                            CODEX_SANDBOX_UNSET_OPTION
                          }
                          onValueChange={(value) => {
                            updateSelectedDraft((current) => ({
                              ...current,
                              codexSandboxMode:
                                value === CODEX_SANDBOX_UNSET_OPTION
                                  ? CODEX_SANDBOX_UNSET
                                  : (value as CodexSandboxModeChoice),
                            }))
                          }}
                        >
                          <SelectTrigger className="h-8 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent align="start">
                            <SelectItem value={CODEX_SANDBOX_UNSET_OPTION}>
                              {t("codex.sandboxModeUnset")}
                            </SelectItem>
                            {CODEX_SANDBOX_MODE_VALUES.map((value) => (
                              <SelectItem key={value} value={value}>
                                {t(`codex.sandboxMode_${value}`)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <p className="text-3xs text-muted-foreground">
                          {t("codex.sandboxModeHint")}
                        </p>
                        {/* Sandbox mode is what codeg maps onto the session's
                            starting approval preset (#442), so it reaches
                            ordinary prompts even though approval_policy does
                            not. Worth stating next to the control that does it. */}
                        {codexSandboxSeedsAcpPreset(
                          selectedDraft.codexSandboxShadowed
                        ) ? (
                          <p className="text-3xs text-muted-foreground">
                            {t("codex.sandboxModeSeedsPresetHint")}
                          </p>
                        ) : null}
                        {/* codex-acp 1.7.0 redefined its `read-only` preset to
                            carry a workspace-write sandbox, and it re-sends
                            that policy every turn — so an ACP session cannot
                            honor a read-only sandbox at all any more. This
                            control keeps working for codex CLI/IDE sessions,
                            which is exactly why the divergence has to be said
                            out loud rather than left to look effective. */}
                        {showsCodexReadOnlyAcpWarning(
                          selectedDraft.codexSandboxMode,
                          selectedDraft.codexSandboxShadowed
                        ) ? (
                          <p className="text-3xs text-yellow-500">
                            {t("codex.sandboxModeReadOnlyAcpWarning")}
                          </p>
                        ) : null}
                      </div>

                      {codexWorkspaceWriteApplies(
                        selectedDraft.codexSandboxMode
                      ) && !selectedDraft.codexSandboxShadowed ? (
                        <div className="space-y-2 rounded-md border border-dashed px-2.5 py-2">
                          <div className="space-y-1">
                            <label className="text-2xs text-muted-foreground">
                              {t("codex.writableRootsLabel")}
                            </label>
                            <Textarea
                              className="min-h-16 font-mono text-2xs"
                              spellCheck={false}
                              value={selectedDraft.codexWritableRootsText}
                              onChange={(event) => {
                                const next = event.target.value
                                updateSelectedDraft((current) => ({
                                  ...current,
                                  codexWritableRootsText: next,
                                }))
                              }}
                              placeholder={"/Users/me/shared\n/srv/cache"}
                            />
                            {codexRelativeWritableRoot ? (
                              <p className="text-3xs text-red-500">
                                {t("codex.sandboxRootsRelativeError", {
                                  path: codexRelativeWritableRoot,
                                })}
                              </p>
                            ) : (
                              <p className="text-3xs text-muted-foreground">
                                {t("codex.writableRootsHint")}
                              </p>
                            )}
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <label className="text-2xs text-muted-foreground">
                              {t("codex.networkAccessLabel")}
                            </label>
                            <Switch
                              checked={selectedDraft.codexNetworkAccess}
                              onCheckedChange={(checked) => {
                                updateSelectedDraft((current) => ({
                                  ...current,
                                  codexNetworkAccess: checked,
                                }))
                              }}
                              aria-label={t("codex.networkAccessLabel")}
                            />
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <label className="text-2xs text-muted-foreground">
                              {t("codex.excludeTmpdirLabel")}
                            </label>
                            <Switch
                              checked={selectedDraft.codexExcludeTmpdirEnvVar}
                              onCheckedChange={(checked) => {
                                updateSelectedDraft((current) => ({
                                  ...current,
                                  codexExcludeTmpdirEnvVar: checked,
                                }))
                              }}
                              aria-label={t("codex.excludeTmpdirLabel")}
                            />
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <label className="text-2xs text-muted-foreground">
                              {t("codex.excludeSlashTmpLabel")}
                            </label>
                            <Switch
                              checked={selectedDraft.codexExcludeSlashTmp}
                              onCheckedChange={(checked) => {
                                updateSelectedDraft((current) => ({
                                  ...current,
                                  codexExcludeSlashTmp: checked,
                                }))
                              }}
                              aria-label={t("codex.excludeSlashTmpLabel")}
                            />
                          </div>
                        </div>
                      ) : null}
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-2xs text-muted-foreground">
                        {t("codex.configTomlNative")}
                      </label>
                      <Textarea
                        value={selectedDraft.codexConfigTomlText}
                        onChange={(event) => {
                          handleCodexConfigTomlTextChange(event.target.value)
                        }}
                        placeholder={`disable_response_storage = true
model = "gpt-6-astra"
model_reasoning_effort = "high"
model_provider = "codeg"

[features]
responses_websockets_v2 = true

[model_providers.codeg]
base_url = "https://api.openai.com/v1"
supports_websockets = true`}
                        className="min-h-40 max-h-80 font-mono text-xs"
                      />
                    </div>

                    <div className="flex justify-end">
                      <Button
                        size="sm"
                        onClick={() => {
                          if (selectedMissingModelProvider) {
                            toast.error(t("toasts.modelProviderRequired"))
                            return
                          }
                          const codexEnvText =
                            selectedDraft.codexAuthMode ===
                            "chatgpt_subscription"
                              ? patchEnvText(selectedDraft.envText, {
                                  OPENAI_API_KEY: "",
                                  OPENAI_BASE_URL: "",
                                })
                              : selectedDraft.envText
                          // Persist sequentially, never in parallel: persistEnv
                          // (acp_update_agent_env) rewrites ~/.codex/config.toml
                          // to sync the root `model`, while persistConfig writes
                          // the full config.toml including base_url. Running both
                          // at once races two read-modify-write cycles on the same
                          // file, letting the model sync clobber the just-written
                          // base_url (the API key in auth.json is unaffected, so
                          // the key saves but the URL silently does not).
                          // persistConfig runs last so its authoritative
                          // config.toml wins.
                          persistEnv(
                            selectedAgent.agent_type,
                            selectedDraft.enabled,
                            codexEnvText,
                            selectedDraft.modelProviderId
                          )
                            .then(() =>
                              persistConfig(
                                selectedAgent.agent_type,
                                selectedDraft.configText,
                                {
                                  codexAuthJsonText:
                                    selectedDraft.codexAuthJsonText,
                                  codexConfigTomlText:
                                    selectedDraft.codexConfigTomlText,
                                  codexModelCatalog:
                                    serializeCodexModelConfig(
                                      selectedDraft.codexModelList
                                    ) ?? "",
                                  codexSandbox:
                                    codexSandboxSaveConfig(selectedDraft),
                                }
                              )
                            )
                            .then(() => {
                              toast.success(t("toasts.codexSaved"), {
                                description: t("toasts.configSavedHint"),
                              })
                            })
                            .catch((err) => {
                              console.error(
                                "[Settings] save codex native config failed:",
                                err
                              )
                              const message = toErrorMessage(err)
                              toast.error(t("toasts.saveCodexNativeFailed"), {
                                description: message,
                              })
                            })
                        }}
                        disabled={selectedIsSavingEnv || selectedIsSavingConfig}
                      >
                        {selectedIsSavingEnv || selectedIsSavingConfig ? (
                          <>
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            {t("actions.saving")}
                          </>
                        ) : (
                          <>
                            <Save className="h-3.5 w-3.5" />
                            {t("actions.saveCodexConfig")}
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                ) : selectedAgent.agent_type === "gemini" ? (
                  <div className="space-y-3 rounded-md border bg-muted/10 p-3">
                    <div>
                      <label className="text-xs font-medium">
                        {t("gemini.authConfig")}
                      </label>
                      <p className="mt-1 text-2xs text-muted-foreground">
                        {t("gemini.authConfigDescription")}
                      </p>
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-2xs text-muted-foreground">
                        {t("gemini.authMode")}
                      </label>
                      <Select
                        value={selectedDraft.geminiAuthMode}
                        onValueChange={(value) => {
                          if (
                            GEMINI_AUTH_MODES.includes(value as GeminiAuthMode)
                          ) {
                            handleGeminiAuthModeChange(value as GeminiAuthMode)
                          }
                        }}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue
                            placeholder={t("gemini.selectAuthMode")}
                          />
                        </SelectTrigger>
                        <SelectContent align="start">
                          {GEMINI_AUTH_MODES.map((mode) => (
                            <SelectItem key={mode} value={mode}>
                              {geminiAuthModeLabel(mode)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-2xs text-muted-foreground">
                        {geminiAuthModeHint(selectedDraft.geminiAuthMode)}
                      </p>
                    </div>

                    {selectedDraft.geminiAuthMode === "model_provider" && (
                      <div className="space-y-1.5">
                        <label className="text-2xs text-muted-foreground">
                          {t("selectModelProvider")}
                        </label>
                        {selectedModelProviders.length > 0 ? (
                          <Select
                            value={
                              selectedDraft.modelProviderId != null
                                ? String(selectedDraft.modelProviderId)
                                : ""
                            }
                            onValueChange={handleModelProviderSelect}
                          >
                            <SelectTrigger className="w-full">
                              <SelectValue
                                placeholder={t("selectModelProvider")}
                              />
                            </SelectTrigger>
                            <SelectContent align="start">
                              {selectedModelProviders.map((provider) => (
                                <SelectItem
                                  key={provider.id}
                                  value={String(provider.id)}
                                >
                                  {provider.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <p className="text-2xs text-muted-foreground">
                            {t("noModelProviderAvailable")}
                          </p>
                        )}
                      </div>
                    )}

                    <div className="space-y-1.5">
                      <label className="text-2xs text-muted-foreground">
                        Model
                      </label>
                      <Input
                        value={selectedDraft.model}
                        readOnly={
                          selectedDraft.geminiAuthMode === "model_provider"
                        }
                        onChange={(event) => {
                          handleGeminiFieldChange("model", event.target.value)
                        }}
                        placeholder="gemini-3-pro-preview"
                      />
                      <p className="text-2xs text-muted-foreground">
                        {t("modelHintDefault")}
                      </p>
                    </div>

                    {(selectedDraft.geminiAuthMode === "custom" ||
                      selectedDraft.geminiAuthMode === "model_provider") && (
                      <div className="space-y-1.5">
                        <label className="text-2xs text-muted-foreground">
                          GOOGLE_GEMINI_BASE_URL
                        </label>
                        <Input
                          value={selectedDraft.apiBaseUrl}
                          readOnly={
                            selectedDraft.geminiAuthMode === "model_provider"
                          }
                          onChange={(event) => {
                            handleGeminiFieldChange(
                              "apiBaseUrl",
                              event.target.value
                            )
                          }}
                          placeholder="https://your-gemini-endpoint.example.com"
                        />
                      </div>
                    )}

                    {(selectedDraft.geminiAuthMode === "custom" ||
                      selectedDraft.geminiAuthMode === "gemini_api_key" ||
                      selectedDraft.geminiAuthMode === "model_provider" ||
                      selectedDraft.geminiAuthMode === "vertex_api_key") && (
                      <div className="space-y-1.5">
                        <label className="text-2xs text-muted-foreground">
                          {selectedDraft.geminiAuthMode === "vertex_api_key"
                            ? "GOOGLE_API_KEY"
                            : "GEMINI_API_KEY"}
                        </label>
                        <div className="flex items-center gap-2">
                          <Input
                            type={
                              showApiKeys[selectedAgent.agent_type]
                                ? "text"
                                : "password"
                            }
                            value={
                              selectedDraft.geminiAuthMode === "vertex_api_key"
                                ? selectedDraft.googleApiKey
                                : selectedDraft.geminiApiKey
                            }
                            readOnly={
                              selectedDraft.geminiAuthMode === "model_provider"
                            }
                            onChange={(event) => {
                              if (
                                selectedDraft.geminiAuthMode ===
                                "vertex_api_key"
                              ) {
                                handleGeminiFieldChange(
                                  "googleApiKey",
                                  event.target.value
                                )
                                return
                              }
                              handleGeminiFieldChange(
                                "geminiApiKey",
                                event.target.value
                              )
                            }}
                            placeholder="AIza..."
                          />
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setShowApiKeys((prev) => ({
                                ...prev,
                                [selectedAgent.agent_type]:
                                  !prev[selectedAgent.agent_type],
                              }))
                            }}
                            title={
                              showApiKeys[selectedAgent.agent_type]
                                ? t("actions.hideKey")
                                : t("actions.showKey")
                            }
                          >
                            {showApiKeys[selectedAgent.agent_type] ? (
                              <EyeOff className="h-3.5 w-3.5" />
                            ) : (
                              <Eye className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        </div>
                      </div>
                    )}

                    {(selectedDraft.geminiAuthMode === "vertex_adc" ||
                      selectedDraft.geminiAuthMode ===
                        "vertex_service_account" ||
                      selectedDraft.geminiAuthMode === "vertex_api_key") && (
                      <div className="grid gap-3 md:grid-cols-2">
                        <div className="space-y-1.5">
                          <label className="text-2xs text-muted-foreground">
                            GOOGLE_CLOUD_PROJECT
                          </label>
                          <Input
                            value={selectedDraft.googleCloudProject}
                            onChange={(event) => {
                              handleGeminiFieldChange(
                                "googleCloudProject",
                                event.target.value
                              )
                            }}
                            placeholder="my-gcp-project-id"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-2xs text-muted-foreground">
                            GOOGLE_CLOUD_LOCATION
                          </label>
                          <Input
                            value={selectedDraft.googleCloudLocation}
                            onChange={(event) => {
                              handleGeminiFieldChange(
                                "googleCloudLocation",
                                event.target.value
                              )
                            }}
                            placeholder="global / us-central1"
                          />
                        </div>
                      </div>
                    )}

                    {selectedDraft.geminiAuthMode ===
                      "vertex_service_account" && (
                      <div className="space-y-1.5">
                        <label className="text-2xs text-muted-foreground">
                          GOOGLE_APPLICATION_CREDENTIALS
                        </label>
                        <Input
                          value={selectedDraft.googleApplicationCredentials}
                          onChange={(event) => {
                            handleGeminiFieldChange(
                              "googleApplicationCredentials",
                              event.target.value
                            )
                          }}
                          placeholder="/path/to/service-account.json"
                        />
                      </div>
                    )}

                    <div className="flex items-center justify-between gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          openUrl(
                            "https://geminicli.com/docs/get-started/authentication/"
                          ).catch((err) => {
                            console.error(
                              "[Settings] open gemini auth doc failed:",
                              err
                            )
                          })
                        }}
                      >
                        {t("gemini.viewAuthDoc")}
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => {
                          if (selectedMissingModelProvider) {
                            toast.error(t("toasts.modelProviderRequired"))
                            return
                          }
                          Promise.all([
                            persistEnv(
                              selectedAgent.agent_type,
                              selectedDraft.enabled,
                              selectedDraft.envText,
                              selectedDraft.modelProviderId
                            ),
                            persistConfig(
                              selectedAgent.agent_type,
                              selectedDraft.configText
                            ),
                          ])
                            .then(() => {
                              toast.success(t("toasts.geminiSaved"), {
                                description: t("toasts.configSavedHint"),
                              })
                            })
                            .catch((err) => {
                              console.error(
                                "[Settings] save gemini config failed:",
                                err
                              )
                              const message = toErrorMessage(err)
                              toast.error(t("toasts.saveGeminiFailed"), {
                                description: message,
                              })
                            })
                        }}
                        disabled={selectedIsSavingEnv || selectedIsSavingConfig}
                      >
                        {selectedIsSavingEnv || selectedIsSavingConfig ? (
                          <>
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            {t("actions.saving")}
                          </>
                        ) : (
                          <>
                            <Save className="h-3.5 w-3.5" />
                            {t("actions.saveGeminiConfig")}
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                ) : selectedAgent.agent_type === "open_code" ? (
                  <div className="space-y-3 rounded-md border bg-muted/10 p-3">
                    <div>
                      <label className="text-xs font-medium">
                        {t("openCode.configManagement")}
                      </label>
                      <p className="mt-1 text-2xs text-muted-foreground">
                        {t("openCode.configDescription")}
                      </p>
                    </div>

                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="space-y-1.5">
                        <label className="text-2xs text-muted-foreground">
                          {t("openCode.mainModel")}
                        </label>
                        <OpenCodeModelCombobox
                          value={selectedOpenCodeConfig?.model ?? ""}
                          onValueChange={(v) =>
                            handleOpenCodeFieldChange("model", v)
                          }
                          groups={openCodeModelOptions}
                          placeholder="provider/model-id"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-2xs text-muted-foreground">
                          {t("openCode.smallModel")}
                        </label>
                        <OpenCodeModelCombobox
                          value={selectedOpenCodeConfig?.smallModel ?? ""}
                          onValueChange={(v) =>
                            handleOpenCodeFieldChange("small_model", v)
                          }
                          groups={openCodeModelOptions}
                          placeholder="provider/model-id"
                        />
                      </div>
                    </div>

                    <div className="space-y-2 rounded-md border bg-background/60 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <label className="text-2xs font-medium">
                          {t("openCode.providerManagement")}
                        </label>
                        <div className="text-2xs text-muted-foreground">
                          {t("openCode.providerCount", {
                            count:
                              selectedOpenCodeConfig?.providerIds.length ?? 0,
                          })}
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => {
                            setOpenCodeEditProviderId(null)
                            setOpenCodeConnectOpen(true)
                          }}
                        >
                          <Plug className="h-3.5 w-3.5" />
                          {t("openCode.connectProvider")}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            void handleOpenCodeRefreshCatalog()
                          }}
                          disabled={openCodeCatalogLoading}
                          title={t("openCode.refreshCatalog")}
                        >
                          <RefreshCw
                            className={cn(
                              "h-3.5 w-3.5",
                              openCodeCatalogLoading && "animate-spin"
                            )}
                          />
                          {t("openCode.refreshCatalog")}
                        </Button>
                        {openCodeCatalogLoading &&
                          openCodeCatalog.length === 0 && (
                            <span className="inline-flex items-center gap-1 text-2xs text-muted-foreground">
                              <Loader2 className="h-3 w-3 animate-spin" />
                              {t("openCode.connect.loading")}
                            </span>
                          )}
                      </div>

                      {openCodeWellKnownConnected.length === 0 ? (
                        <div className="text-2xs text-muted-foreground">
                          {t("openCode.noConnectedProviders")}
                        </div>
                      ) : (
                        <div className="space-y-1.5">
                          <label className="text-2xs font-medium">
                            {t("openCode.connectedProviders")}
                          </label>
                          <div className="space-y-1.5">
                            {openCodeWellKnownConnected.map((provider) => (
                              <div
                                key={provider.id}
                                className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/20 px-2.5 py-1.5"
                              >
                                <div className="flex min-w-0 flex-1 items-center gap-2">
                                  <span className="truncate text-xs font-medium">
                                    {provider.name}
                                  </span>
                                  <span className="text-3xs text-muted-foreground">
                                    {provider.id}
                                  </span>
                                  <Badge variant="outline" className="text-3xs">
                                    {provider.authKind === "oauth"
                                      ? t("openCode.authKindOauth")
                                      : provider.authKind === "api"
                                        ? t("openCode.authKindApi")
                                        : t("openCode.authKindNone")}
                                  </Badge>
                                  {!provider.inCatalog && (
                                    <Badge
                                      variant="secondary"
                                      className="text-3xs"
                                    >
                                      {t("openCode.customBadge")}
                                    </Badge>
                                  )}
                                </div>
                                <div className="flex items-center gap-2.5">
                                  <Switch
                                    checked={provider.enabled}
                                    onCheckedChange={(checked) => {
                                      void handleOpenCodeToggleEnabled(
                                        provider.id,
                                        checked
                                      )
                                    }}
                                    aria-label={t(
                                      "openCode.providerEnabledState",
                                      { providerId: provider.id }
                                    )}
                                  />
                                  {provider.authKind !== "oauth" && (
                                    <Button
                                      type="button"
                                      size="xs"
                                      variant="ghost"
                                      onClick={() => {
                                        // Top list is well-known only → the
                                        // guided dialog edits the key/base URL.
                                        setOpenCodeEditProviderId(provider.id)
                                        setOpenCodeConnectOpen(true)
                                      }}
                                    >
                                      {t("openCode.editConfig")}
                                    </Button>
                                  )}
                                  <Button
                                    type="button"
                                    size="xs"
                                    variant="outline"
                                    onClick={() => {
                                      void handleOpenCodeDisconnect(
                                        provider.id,
                                        provider.hasConfigBlock
                                      )
                                    }}
                                  >
                                    {t("openCode.disconnect")}
                                  </Button>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      <OpenCodeConnectDialog
                        open={openCodeConnectOpen}
                        onOpenChange={(o) => {
                          setOpenCodeConnectOpen(o)
                          if (!o) setOpenCodeEditProviderId(null)
                        }}
                        catalog={openCodeCatalog}
                        catalogLoading={openCodeCatalogLoading}
                        configText={selectedDraft.configText}
                        authJsonText={selectedDraft.openCodeAuthJsonText}
                        editProviderId={openCodeEditProviderId}
                        onConnect={applyOpenCodeConnect}
                      />

                      <OpenCodeCustomProviderDialog
                        open={openCodeCustomOpen}
                        onOpenChange={setOpenCodeCustomOpen}
                        existingProviderIds={
                          selectedOpenCodeConfig?.providerIds ?? []
                        }
                        catalogIds={openCodeCatalog.map((p) => p.id)}
                        configText={selectedDraft.configText}
                        authJsonText={selectedDraft.openCodeAuthJsonText}
                        onConnect={applyOpenCodeConnect}
                      />

                      <div className="space-y-1 border-t pt-2">
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-2xs font-medium text-muted-foreground">
                            {t("openCode.advancedProviderConfig")}
                          </div>
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            onClick={() => setOpenCodeCustomOpen(true)}
                            disabled={
                              openCodeCatalogLoading || !openCodeCatalogReady
                            }
                            title={
                              openCodeCatalogLoading || !openCodeCatalogReady
                                ? t("openCode.connect.loading")
                                : undefined
                            }
                          >
                            <Plus className="h-3.5 w-3.5" />
                            {t("openCode.addCustomProvider")}
                          </Button>
                        </div>
                        <p className="text-3xs text-muted-foreground">
                          {t("openCode.customProviderConfigHint")}
                        </p>
                      </div>

                      {openCodeCustomProviderIds.length === 0 ? (
                        <div className="text-2xs text-muted-foreground">
                          {t("openCode.emptyProvider")}
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {openCodeCustomProviderIds.map((providerId) => {
                            if (!selectedOpenCodeConfig) return null
                            const provider =
                              selectedOpenCodeConfig.providers[providerId]
                            if (!provider) return null
                            const expanded = openCodeProviderId === providerId
                            const isDisabled =
                              selectedOpenCodeConfig.disabledProviders.includes(
                                providerId
                              ) ||
                              (selectedOpenCodeConfig.enabledProviders.length >
                                0 &&
                                !selectedOpenCodeConfig.enabledProviders.includes(
                                  providerId
                                ))
                            return (
                              <Collapsible
                                key={providerId}
                                open={expanded}
                                onOpenChange={(open) => {
                                  setOpenCodeProviderId(open ? providerId : "")
                                }}
                              >
                                <div className="rounded-md border bg-muted/20">
                                  <div className="flex items-center justify-between gap-2 px-2.5 py-2">
                                    <button
                                      type="button"
                                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                                      onClick={() => {
                                        setOpenCodeProviderId((current) =>
                                          current === providerId
                                            ? ""
                                            : providerId
                                        )
                                      }}
                                    >
                                      <ChevronDown
                                        className={cn(
                                          "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                                          expanded && "rotate-180"
                                        )}
                                      />
                                      <span className="truncate text-xs font-medium">
                                        {providerId}
                                      </span>
                                      <span className="text-2xs text-muted-foreground">
                                        models: {provider.modelCount}
                                      </span>
                                    </button>
                                    <div className="flex items-center gap-3">
                                      <span className="text-2xs text-muted-foreground">
                                        {isDisabled
                                          ? t("status.disabled")
                                          : t("status.enabled")}
                                      </span>
                                      <Switch
                                        checked={!isDisabled}
                                        onCheckedChange={(checked) => {
                                          handleOpenCodeProviderStatusChange(
                                            providerId,
                                            checked
                                          )
                                        }}
                                        aria-label={t(
                                          "openCode.providerEnabledState",
                                          { providerId }
                                        )}
                                        title={
                                          isDisabled
                                            ? t("actions.clickEnable", {
                                                name: providerId,
                                              })
                                            : t("actions.clickDisable", {
                                                name: providerId,
                                              })
                                        }
                                      />
                                      <Button
                                        type="button"
                                        size="xs"
                                        variant="outline"
                                        onClick={() => {
                                          setOpenCodeDeleteProviderId(
                                            providerId
                                          )
                                        }}
                                      >
                                        {t("actions.delete")}
                                      </Button>
                                    </div>
                                  </div>

                                  <CollapsibleContent className="px-2.5 pb-2.5">
                                    <div className="grid gap-3 border-t pt-2.5 md:grid-cols-2">
                                      <div className="space-y-1.5">
                                        <label className="text-2xs text-muted-foreground">
                                          provider.name
                                        </label>
                                        <Input
                                          value={provider.name}
                                          onChange={(event) => {
                                            handleOpenCodeProviderFieldChange(
                                              providerId,
                                              "name",
                                              event.target.value
                                            )
                                          }}
                                          placeholder="My Provider"
                                        />
                                      </div>
                                      <div className="space-y-1.5">
                                        <label className="text-2xs text-muted-foreground">
                                          provider.npm
                                        </label>
                                        <Select
                                          value={
                                            provider.npm.trim()
                                              ? provider.npm
                                              : OPENCODE_PROVIDER_NPM_OPTIONS[0]
                                                  .value
                                          }
                                          onValueChange={(value) => {
                                            handleOpenCodeProviderFieldChange(
                                              providerId,
                                              "npm",
                                              value
                                            )
                                          }}
                                        >
                                          <SelectTrigger className="w-full">
                                            <SelectValue
                                              placeholder={t(
                                                "openCode.selectProviderNpm"
                                              )}
                                            />
                                          </SelectTrigger>
                                          <SelectContent align="start">
                                            {buildOpenCodeNpmOptions(
                                              provider.npm
                                            ).map((npmOption) => (
                                              <SelectItem
                                                key={npmOption}
                                                value={npmOption}
                                              >
                                                {npmOption}
                                              </SelectItem>
                                            ))}
                                          </SelectContent>
                                        </Select>
                                      </div>
                                      <div className="space-y-1.5">
                                        <label className="text-2xs text-muted-foreground">
                                          provider.api
                                        </label>
                                        <Input
                                          value={provider.api}
                                          onChange={(event) => {
                                            handleOpenCodeProviderFieldChange(
                                              providerId,
                                              "api",
                                              event.target.value
                                            )
                                          }}
                                          placeholder="openai.responses"
                                        />
                                      </div>
                                      <div className="space-y-1.5">
                                        <label className="text-2xs text-muted-foreground">
                                          provider.options.baseURL
                                        </label>
                                        <Input
                                          value={provider.baseUrl}
                                          onChange={(event) => {
                                            handleOpenCodeProviderFieldChange(
                                              providerId,
                                              "baseURL",
                                              event.target.value
                                            )
                                          }}
                                          placeholder="https://api.example.com/v1"
                                        />
                                      </div>
                                      <div className="space-y-1.5 md:col-span-2">
                                        <label className="text-2xs text-muted-foreground">
                                          provider.options.apiKey
                                        </label>
                                        <div className="flex items-center gap-2">
                                          <Input
                                            type={
                                              showApiKeys[
                                                selectedAgent.agent_type
                                              ]
                                                ? "text"
                                                : "password"
                                            }
                                            value={provider.apiKey}
                                            onChange={(event) => {
                                              handleOpenCodeProviderFieldChange(
                                                providerId,
                                                "apiKey",
                                                event.target.value
                                              )
                                            }}
                                            placeholder="sk-..."
                                          />
                                          <Button
                                            type="button"
                                            variant="outline"
                                            size="sm"
                                            onClick={() => {
                                              setShowApiKeys((prev) => ({
                                                ...prev,
                                                [selectedAgent.agent_type]:
                                                  !prev[
                                                    selectedAgent.agent_type
                                                  ],
                                              }))
                                            }}
                                            title={
                                              showApiKeys[
                                                selectedAgent.agent_type
                                              ]
                                                ? t("actions.hideKey")
                                                : t("actions.showKey")
                                            }
                                          >
                                            {showApiKeys[
                                              selectedAgent.agent_type
                                            ] ? (
                                              <EyeOff className="h-3.5 w-3.5" />
                                            ) : (
                                              <Eye className="h-3.5 w-3.5" />
                                            )}
                                          </Button>
                                        </div>
                                      </div>
                                    </div>
                                    <Collapsible
                                      open={Boolean(
                                        openCodeModelConfigExpanded[providerId]
                                      )}
                                      onOpenChange={(open) => {
                                        setOpenCodeModelConfigExpanded(
                                          (prev) => ({
                                            ...prev,
                                            [providerId]: open,
                                          })
                                        )
                                      }}
                                    >
                                      <div className="mt-3 rounded-md border bg-background/50 p-2.5">
                                        <button
                                          type="button"
                                          className="flex w-full items-center justify-between gap-2 text-left"
                                          onClick={() => {
                                            setOpenCodeModelConfigExpanded(
                                              (prev) => ({
                                                ...prev,
                                                [providerId]: !prev[providerId],
                                              })
                                            )
                                          }}
                                        >
                                          <div className="flex items-center gap-2">
                                            <ChevronDown
                                              className={cn(
                                                "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                                                openCodeModelConfigExpanded[
                                                  providerId
                                                ] && "rotate-180"
                                              )}
                                            />
                                            <span className="text-2xs font-medium">
                                              {t("openCode.modelManagement")}
                                            </span>
                                          </div>
                                          <span className="text-2xs text-muted-foreground">
                                            {t("openCode.modelCount", {
                                              count: provider.modelCount,
                                            })}
                                          </span>
                                        </button>
                                        <CollapsibleContent className="pt-2">
                                          <p className="text-2xs text-muted-foreground">
                                            {t("openCode.modelDescription")}
                                          </p>

                                          <div className="mt-2 flex flex-wrap items-center gap-2">
                                            <Input
                                              value={
                                                openCodeNewModelIds[
                                                  providerId
                                                ] ?? ""
                                              }
                                              onChange={(event) => {
                                                handleOpenCodeModelDraftChange(
                                                  providerId,
                                                  event.target.value
                                                )
                                              }}
                                              className="w-[15rem]"
                                              placeholder="new-model-id"
                                            />
                                            <Button
                                              type="button"
                                              size="sm"
                                              variant="outline"
                                              onClick={() => {
                                                handleOpenCodeAddModel(
                                                  providerId
                                                )
                                              }}
                                            >
                                              {t("openCode.addModel")}
                                            </Button>
                                          </div>

                                          {provider.modelIds.length === 0 ? (
                                            <div className="mt-2 text-2xs text-muted-foreground">
                                              {t("openCode.emptyModel")}
                                            </div>
                                          ) : (
                                            <div className="mt-2 space-y-1">
                                              <div className="flex items-center gap-2 px-1 text-3xs text-muted-foreground">
                                                <div className="min-w-0 flex-1">
                                                  {t("openCode.modelId")}
                                                </div>
                                                <div className="min-w-0 flex-1">
                                                  {t("openCode.modelName")}
                                                </div>
                                                <div className="size-8 shrink-0" />
                                              </div>
                                              {provider.modelIds.map(
                                                (modelId) => {
                                                  const model =
                                                    provider.models[modelId]
                                                  if (!model) return null
                                                  const modelDraftKey = `${providerId}:${modelId}`
                                                  return (
                                                    <div
                                                      key={`${providerId}:${modelId}`}
                                                      className="flex items-center gap-2"
                                                    >
                                                      <Input
                                                        value={
                                                          openCodeModelIdDrafts[
                                                            modelDraftKey
                                                          ] ?? model.id
                                                        }
                                                        onChange={(event) => {
                                                          handleOpenCodeModelIdDraftChange(
                                                            providerId,
                                                            modelId,
                                                            event.target.value
                                                          )
                                                        }}
                                                        onBlur={() => {
                                                          handleOpenCodeModelIdCommit(
                                                            providerId,
                                                            modelId
                                                          )
                                                        }}
                                                        {...ime.props}
                                                        onKeyDown={(event) => {
                                                          if (
                                                            ime.isComposing(
                                                              event
                                                            )
                                                          )
                                                            return
                                                          if (
                                                            event.key ===
                                                            "Enter"
                                                          ) {
                                                            event.preventDefault()
                                                            handleOpenCodeModelIdCommit(
                                                              providerId,
                                                              modelId
                                                            )
                                                            event.currentTarget.blur()
                                                            return
                                                          }
                                                          if (
                                                            event.key ===
                                                            "Escape"
                                                          ) {
                                                            setOpenCodeModelIdDrafts(
                                                              (prev) => {
                                                                if (
                                                                  typeof prev[
                                                                    modelDraftKey
                                                                  ] ===
                                                                  "undefined"
                                                                ) {
                                                                  return prev
                                                                }
                                                                const next = {
                                                                  ...prev,
                                                                }
                                                                delete next[
                                                                  modelDraftKey
                                                                ]
                                                                return next
                                                              }
                                                            )
                                                            event.currentTarget.blur()
                                                          }
                                                        }}
                                                        className="h-8 min-w-0 flex-1"
                                                        placeholder="model.id"
                                                      />
                                                      <Input
                                                        value={model.name}
                                                        onChange={(event) => {
                                                          handleOpenCodeModelFieldChange(
                                                            providerId,
                                                            modelId,
                                                            event.target.value
                                                          )
                                                        }}
                                                        className="h-8 min-w-0 flex-1"
                                                        placeholder="model.name"
                                                      />
                                                      <Button
                                                        type="button"
                                                        size="icon-sm"
                                                        variant="ghost"
                                                        className="shrink-0 text-muted-foreground hover:text-destructive"
                                                        aria-label={t(
                                                          "openCode.deleteModel",
                                                          { modelId }
                                                        )}
                                                        title={t(
                                                          "openCode.deleteModel",
                                                          { modelId }
                                                        )}
                                                        onClick={() => {
                                                          handleOpenCodeRemoveModel(
                                                            providerId,
                                                            modelId
                                                          )
                                                        }}
                                                      >
                                                        <Minus className="h-3.5 w-3.5" />
                                                      </Button>
                                                    </div>
                                                  )
                                                }
                                              )}
                                            </div>
                                          )}
                                        </CollapsibleContent>
                                      </div>
                                    </Collapsible>
                                    <div className="mt-3 flex justify-end">
                                      <Button
                                        type="button"
                                        size="sm"
                                        onClick={() => {
                                          persistConfig(
                                            selectedAgent.agent_type,
                                            selectedDraft.configText,
                                            {
                                              openCodeAuthJsonText:
                                                selectedDraft.openCodeAuthJsonText,
                                            }
                                          )
                                            .then(() => {
                                              toast.success(
                                                t("toasts.providerSaved", {
                                                  providerId,
                                                }),
                                                {
                                                  description: `${t("toasts.openCodeConfigSynced")} ${t("toasts.configSavedHint")}`,
                                                }
                                              )
                                            })
                                            .catch((err) => {
                                              console.error(
                                                "[Settings] save opencode provider failed:",
                                                err
                                              )
                                              const message =
                                                err instanceof Error
                                                  ? err.message
                                                  : String(err)
                                              toast.error(
                                                t("toasts.saveProviderFailed", {
                                                  providerId,
                                                }),
                                                {
                                                  description: message,
                                                }
                                              )
                                            })
                                        }}
                                        disabled={selectedIsSavingConfig}
                                      >
                                        {selectedIsSavingConfig ? (
                                          <>
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                            {t("actions.saving")}
                                          </>
                                        ) : (
                                          <>
                                            <Save className="h-3.5 w-3.5" />
                                            {t("actions.saveCurrentProvider")}
                                          </>
                                        )}
                                      </Button>
                                    </div>
                                  </CollapsibleContent>
                                </div>
                              </Collapsible>
                            )
                          })}
                        </div>
                      )}
                    </div>

                    {/*
                      The editor owns the `permission` key and hands back a
                      whole rewritten document, so it goes through the same
                      path as the raw JSON box below — draft-only, like the
                      model fields above, with the card's Save button doing
                      the write to opencode.json.
                    */}
                    <OpenCodePermissionsSection
                      configText={selectedDraft.configText}
                      onChange={handleConfigTextChange}
                      disabled={selectedIsSavingConfig}
                    />

                    {/*
                      Same contract as the permissions editor above: it owns a
                      disjoint set of top-level keys, rewrites the whole
                      document, and leaves the write to this card's Save button.
                    */}
                    <OpenCodeBehaviorSection
                      configText={selectedDraft.configText}
                      onChange={handleConfigTextChange}
                      disabled={selectedIsSavingConfig}
                    />

                    <div className="space-y-1.5">
                      <label className="text-2xs text-muted-foreground">
                        {t("openCode.nativeJsonConfig")}
                      </label>
                      <Textarea
                        value={selectedDraft.configText}
                        onChange={(event) => {
                          handleConfigTextChange(event.target.value)
                        }}
                        placeholder={`{
  "$schema": "https://opencode.ai/config.json",
  "model": "google/gemini-3-pro-preview",
  "provider": {
    "google": {
      "options": {
        "baseURL": "https://generativelanguage.googleapis.com/v1beta"
      }
    }
  }
}`}
                        className="min-h-44 max-h-96 overflow-y-auto font-mono text-xs"
                      />
                      {selectedConfigError && (
                        <div className="rounded-md border border-red-500/30 bg-red-500/5 px-2.5 py-1.5 text-2xs text-red-400">
                          {selectedConfigError}
                        </div>
                      )}
                    </div>

                    <div className="flex justify-end">
                      <Button
                        size="sm"
                        onClick={() => {
                          persistConfig(
                            selectedAgent.agent_type,
                            selectedDraft.configText,
                            {
                              openCodeAuthJsonText:
                                selectedDraft.openCodeAuthJsonText,
                            }
                          )
                            .then(() => {
                              toast.success(t("toasts.openCodeSaved"), {
                                description: t("toasts.configSavedHint"),
                              })
                            })
                            .catch((err) => {
                              console.error(
                                "[Settings] save opencode config failed:",
                                err
                              )
                              const message = toErrorMessage(err)
                              toast.error(t("toasts.saveOpenCodeFailed"), {
                                description: message,
                              })
                            })
                        }}
                        disabled={selectedIsSavingConfig}
                      >
                        {selectedIsSavingConfig ? (
                          <>
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            {t("actions.saving")}
                          </>
                        ) : (
                          <>
                            <Save className="h-3.5 w-3.5" />
                            {t("actions.saveOpenCodeConfig")}
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                ) : selectedAgent.agent_type === "cline" ? (
                  <div className="space-y-3 rounded-md border bg-muted/10 p-3">
                    <div>
                      <label className="text-xs font-medium">Cline</label>
                      <p className="mt-1 text-2xs text-muted-foreground">
                        {t("cline.configDescription")}
                      </p>
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-2xs text-muted-foreground">
                        Provider
                      </label>
                      <Select
                        value={selectedDraft.clineProvider}
                        onValueChange={(value) => {
                          handleClineFieldChange("clineProvider", value)
                        }}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectLabel>{t("cline.signInGroup")}</SelectLabel>
                            {CLINE_SIGNIN_PROVIDERS.map((p) => (
                              <SelectItem key={p.value} value={p.value}>
                                {p.label}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                          <SelectGroup>
                            <SelectLabel>{t("cline.byoGroup")}</SelectLabel>
                            {CLINE_BYO_PROVIDERS.map((p) => (
                              <SelectItem key={p.value} value={p.value}>
                                {p.label}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                          {/* A provider configured outside codeg (e.g. `cline
                              auth bedrock`) keeps its own row, so opening this
                              panel can't silently retarget the store. */}
                          {!isClineSignInProvider(
                            selectedDraft.clineProvider
                          ) &&
                            !CLINE_BYO_PROVIDERS.some(
                              (p) => p.value === selectedDraft.clineProvider
                            ) && (
                              <SelectGroup>
                                <SelectLabel>
                                  {t("cline.externalGroup")}
                                </SelectLabel>
                                <SelectItem value={selectedDraft.clineProvider}>
                                  {selectedDraft.clineProvider}
                                </SelectItem>
                              </SelectGroup>
                            )}
                        </SelectContent>
                      </Select>
                    </div>

                    {isClineSignInProvider(selectedDraft.clineProvider) ? (
                      // Sign-in: cline holds the credential, so there is nothing
                      // here to fill in — only the command that obtains it. The
                      // launch path deliberately exports no provider/key pair
                      // for these, leaving `tryRestoreAuth` to find the token.
                      <div className="space-y-1.5">
                        <p className="text-2xs text-muted-foreground">
                          {t("cline.signInHint")}
                        </p>
                        <div className="flex items-center gap-2">
                          <code className="flex-1 overflow-x-auto rounded bg-muted px-2 py-1 text-2xs font-mono whitespace-nowrap">
                            {clineAuthCommand(selectedDraft.clineProvider)}
                          </code>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 shrink-0 p-0"
                            onClick={async () => {
                              const ok = await copyTextToClipboard(
                                clineAuthCommand(selectedDraft.clineProvider)
                              )
                              if (ok) toast.success(t("grok.commandCopied"))
                            }}
                            title={t("grok.copyCommand")}
                            aria-label={t("grok.copyCommand")}
                          >
                            <Copy className="h-3 w-3" />
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        <label className="text-2xs text-muted-foreground">
                          API Key
                        </label>
                        <div className="flex items-center gap-2">
                          <Input
                            type={
                              showApiKeys[selectedAgent.agent_type]
                                ? "text"
                                : "password"
                            }
                            value={selectedDraft.clineApiKey}
                            onChange={(event) => {
                              handleClineFieldChange(
                                "clineApiKey",
                                event.target.value
                              )
                            }}
                            placeholder="sk-..."
                          />
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setShowApiKeys((prev) => ({
                                ...prev,
                                [selectedAgent.agent_type]:
                                  !prev[selectedAgent.agent_type],
                              }))
                            }}
                            title={
                              showApiKeys[selectedAgent.agent_type]
                                ? t("actions.hideApiKey")
                                : t("actions.showApiKey")
                            }
                          >
                            {showApiKeys[selectedAgent.agent_type] ? (
                              <EyeOff className="h-3.5 w-3.5" />
                            ) : (
                              <Eye className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        </div>
                      </div>
                    )}

                    <div className="space-y-1.5">
                      <label className="text-2xs text-muted-foreground">
                        Model
                      </label>
                      <Input
                        value={selectedDraft.clineModel}
                        onChange={(event) => {
                          handleClineFieldChange(
                            "clineModel",
                            event.target.value
                          )
                        }}
                        placeholder="claude-sonnet-5"
                      />
                    </div>

                    {/* Endpoint, like the key, is cline's own for a sign-in
                        provider — its account service, not something to point
                        elsewhere. */}
                    {!isClineSignInProvider(selectedDraft.clineProvider) && (
                      <div className="space-y-1.5">
                        <label className="text-2xs text-muted-foreground">
                          API URL
                        </label>
                        {/* Cline stores this as `settings.baseUrl`, which its
                            own schema validates as a full URL — and an
                            OpenAI-compatible endpoint wants the version suffix,
                            so the placeholder shows the whole shape. */}
                        <Input
                          value={selectedDraft.clineBaseUrl}
                          onChange={(event) => {
                            handleClineFieldChange(
                              "clineBaseUrl",
                              event.target.value
                            )
                          }}
                          placeholder="https://api.openai.com/v1"
                        />
                      </div>
                    )}

                    <div className="space-y-1.5">
                      <label className="text-2xs text-muted-foreground">
                        {t("nativeJsonConfig")} (config)
                      </label>
                      <Textarea
                        value={selectedDraft.configText}
                        onChange={(event) => {
                          handleConfigTextChange(event.target.value)
                        }}
                        className="min-h-24 font-mono text-xs"
                        placeholder={`{
  "apiProvider": "anthropic",
  "apiKey": "sk-...",
  "model": "claude-sonnet-5"
}`}
                      />
                      {selectedConfigError && (
                        <div className="rounded-md border border-red-500/30 bg-red-500/5 px-2.5 py-1.5 text-2xs text-red-400">
                          {selectedConfigError}
                        </div>
                      )}
                    </div>

                    <div className="flex items-center justify-end gap-2">
                      <Button
                        size="sm"
                        onClick={() => {
                          persistConfig(
                            selectedAgent.agent_type,
                            selectedDraft.configText
                          )
                            .then(() => {
                              toast.success(t("toasts.clineSaved"), {
                                description: t("toasts.configSavedHint"),
                              })
                            })
                            .catch((err) => {
                              console.error(
                                "[Settings] save cline config failed:",
                                err
                              )
                              const message = toErrorMessage(err)
                              toast.error(t("toasts.saveClineFailed"), {
                                description: message,
                              })
                            })
                        }}
                        disabled={selectedIsSavingConfig}
                      >
                        {selectedIsSavingConfig ? (
                          <>
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            {t("actions.saving")}
                          </>
                        ) : (
                          <>
                            <Save className="h-3.5 w-3.5" />
                            {t("actions.saveClineConfig")}
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                ) : selectedAgent.agent_type === "open_claw" ? (
                  <div className="space-y-3 rounded-md border bg-muted/10 p-3">
                    <div>
                      <label className="text-xs font-medium">
                        {t("openClaw.gatewayConfig")}
                      </label>
                      <p className="mt-1 text-2xs text-muted-foreground">
                        {t("openClaw.gatewayDescription")}
                      </p>
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-2xs text-muted-foreground">
                        Gateway URL
                      </label>
                      <Input
                        value={selectedDraft.openClawGatewayUrl}
                        onChange={(event) => {
                          handleOpenClawFieldChange(
                            "openClawGatewayUrl",
                            event.target.value
                          )
                        }}
                        placeholder="wss://gateway-host:18789"
                      />
                      <p className="text-2xs text-muted-foreground">
                        {t("openClaw.gatewayUrlHint")}
                      </p>
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-2xs text-muted-foreground">
                        Gateway Token
                      </label>
                      <div className="flex items-center gap-2">
                        <Input
                          type={
                            showApiKeys[selectedAgent.agent_type]
                              ? "text"
                              : "password"
                          }
                          value={selectedDraft.openClawGatewayToken}
                          onChange={(event) => {
                            handleOpenClawFieldChange(
                              "openClawGatewayToken",
                              event.target.value
                            )
                          }}
                          placeholder={t("openClaw.gatewayTokenPlaceholder")}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setShowApiKeys((prev) => ({
                              ...prev,
                              [selectedAgent.agent_type]:
                                !prev[selectedAgent.agent_type],
                            }))
                          }}
                          title={
                            showApiKeys[selectedAgent.agent_type]
                              ? t("actions.hideToken")
                              : t("actions.showToken")
                          }
                        >
                          {showApiKeys[selectedAgent.agent_type] ? (
                            <EyeOff className="h-3.5 w-3.5" />
                          ) : (
                            <Eye className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      </div>
                      <p className="text-2xs text-muted-foreground">
                        {t("openClaw.gatewayTokenHint")}
                      </p>
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-2xs text-muted-foreground">
                        Session Key
                      </label>
                      <Input
                        value={selectedDraft.openClawSessionKey}
                        onChange={(event) => {
                          handleOpenClawFieldChange(
                            "openClawSessionKey",
                            event.target.value
                          )
                        }}
                        placeholder="agent:main:main"
                      />
                      <p className="text-2xs text-muted-foreground">
                        {t("openClaw.sessionKeyHint")}
                      </p>
                    </div>

                    <div className="flex items-center justify-end gap-2">
                      <Button
                        size="sm"
                        onClick={() => {
                          Promise.all([
                            persistEnv(
                              selectedAgent.agent_type,
                              selectedDraft.enabled,
                              selectedDraft.envText,
                              selectedDraft.modelProviderId
                            ),
                            persistConfig(
                              selectedAgent.agent_type,
                              selectedDraft.configText
                            ),
                          ])
                            .then(() => {
                              toast.success(t("toasts.openClawSaved"), {
                                description: t("toasts.configSavedHint"),
                              })
                            })
                            .catch((err) => {
                              console.error(
                                "[Settings] save openclaw config failed:",
                                err
                              )
                              const message = toErrorMessage(err)
                              toast.error(t("toasts.saveOpenClawFailed"), {
                                description: message,
                              })
                            })
                        }}
                        disabled={selectedIsSavingEnv || selectedIsSavingConfig}
                      >
                        {selectedIsSavingEnv || selectedIsSavingConfig ? (
                          <>
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            {t("actions.saving")}
                          </>
                        ) : (
                          <>
                            <Save className="h-3.5 w-3.5" />
                            {t("actions.saveOpenClawConfig")}
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                ) : selectedAgent.agent_type === "hermes" ? (
                  <div className="space-y-3 rounded-md border bg-muted/10 p-3">
                    <div>
                      <label className="text-xs font-medium">
                        {t("hermes.configManagement")}
                      </label>
                      <p className="mt-1 text-2xs text-muted-foreground">
                        {t("hermes.configDescription")}
                      </p>
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-2xs text-muted-foreground">
                        {t("hermes.providerLabel")}
                      </label>
                      <Select
                        value={selectedDraft.hermesProvider}
                        onValueChange={(value) =>
                          handleHermesFieldChange("hermesProvider", value)
                        }
                        disabled={selectedIsSavingConfig}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent align="start">
                          {/* Preserve an existing config's provider in the list
                              even when it's outside the curated table, so the
                              dropdown shows the real value instead of going blank. */}
                          {selectedDraft.hermesProvider &&
                            !HERMES_PROVIDERS.some(
                              (p) => p.id === selectedDraft.hermesProvider
                            ) && (
                              <SelectItem value={selectedDraft.hermesProvider}>
                                {selectedDraft.hermesProvider}
                              </SelectItem>
                            )}
                          {(
                            [
                              ["apiKey", t("hermes.groupApiKey")],
                              ["oauth", t("hermes.groupOauth")],
                              ["aws", t("hermes.groupAws")],
                            ] as const
                          ).map(([kind, groupLabel]) => {
                            const items = HERMES_PROVIDERS.filter(
                              (p) => p.kind === kind
                            )
                            if (items.length === 0) return null
                            return (
                              <SelectGroup key={kind}>
                                <SelectLabel>{groupLabel}</SelectLabel>
                                {items.map((provider) => (
                                  <SelectItem
                                    key={provider.id}
                                    value={provider.id}
                                  >
                                    {provider.label}
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            )
                          })}
                        </SelectContent>
                      </Select>
                      <p className="text-2xs text-muted-foreground">
                        {t("hermes.providerHint")}
                      </p>
                    </div>

                    {selectedHermesProviderOption?.kind === "apiKey" && (
                      <div className="space-y-1.5">
                        <label className="text-2xs text-muted-foreground">
                          API Key
                        </label>
                        <div className="flex items-center gap-2">
                          <Input
                            type={
                              showApiKeys[selectedAgent.agent_type]
                                ? "text"
                                : "password"
                            }
                            value={selectedDraft.apiKey}
                            onChange={(event) =>
                              handleHermesFieldChange(
                                "apiKey",
                                event.target.value
                              )
                            }
                            placeholder="sk-..."
                            disabled={selectedIsSavingConfig}
                          />
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setShowApiKeys((prev) => ({
                                ...prev,
                                [selectedAgent.agent_type]:
                                  !prev[selectedAgent.agent_type],
                              }))
                            }}
                            title={
                              showApiKeys[selectedAgent.agent_type]
                                ? t("actions.hideApiKey")
                                : t("actions.showApiKey")
                            }
                          >
                            {showApiKeys[selectedAgent.agent_type] ? (
                              <EyeOff className="h-3.5 w-3.5" />
                            ) : (
                              <Eye className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        </div>
                        <p className="text-2xs text-muted-foreground">
                          {t("hermes.apiKeyHint")}
                        </p>
                      </div>
                    )}

                    {selectedHermesProviderOption?.needsBaseUrl && (
                      <div className="space-y-1.5">
                        <label className="text-2xs text-muted-foreground">
                          API URL
                        </label>
                        <Input
                          value={selectedDraft.apiBaseUrl}
                          onChange={(event) =>
                            handleHermesFieldChange(
                              "apiBaseUrl",
                              event.target.value
                            )
                          }
                          placeholder="https://api.example.com/v1"
                          disabled={selectedIsSavingConfig}
                        />
                      </div>
                    )}

                    <div className="space-y-1.5">
                      <label className="text-2xs text-muted-foreground">
                        {t("hermes.modelName")}
                      </label>
                      <Input
                        value={selectedDraft.model}
                        onChange={(event) =>
                          handleHermesFieldChange("model", event.target.value)
                        }
                        placeholder="moonshotai/kimi-k2"
                        disabled={selectedIsSavingConfig}
                      />
                    </div>

                    {selectedHermesProviderOption?.kind === "oauth" && (
                      <p className="text-2xs text-muted-foreground">
                        {t("hermes.oauthHint")}
                      </p>
                    )}

                    {selectedHermesProviderOption?.kind === "aws" && (
                      <p className="text-2xs text-muted-foreground">
                        {t("hermes.awsHint")}
                      </p>
                    )}

                    {!selectedHermesProviderOption && (
                      <p className="text-2xs text-amber-600 dark:text-amber-500">
                        {t("hermes.unsupportedProvider")}
                      </p>
                    )}

                    <div className="flex justify-end">
                      <Button
                        size="sm"
                        onClick={() => handleSaveHermesConfig("structured")}
                        disabled={
                          selectedIsSavingConfig ||
                          !selectedHermesProviderOption
                        }
                      >
                        {selectedIsSavingConfig ? (
                          <>
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            {t("actions.saving")}
                          </>
                        ) : (
                          <>
                            <Save className="h-3.5 w-3.5" />
                            {t("actions.saveHermesConfig")}
                          </>
                        )}
                      </Button>
                    </div>

                    <div className="space-y-2 rounded-md border p-3">
                      <div>
                        <label className="text-2xs font-medium">
                          {t("hermes.setupTitle")}
                        </label>
                        <p className="mt-1 text-2xs text-muted-foreground">
                          {t("hermes.setupHint")}
                        </p>
                      </div>
                      {hermesCanUseNativeSetup && (
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              runHermesSetupCommand(
                                "setup",
                                selectedDraft.hermesSetupCommand
                              )
                            }
                          >
                            <Wrench className="h-3.5 w-3.5" />
                            {t("hermes.runSetup")}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              runHermesSetupCommand(
                                "model",
                                selectedDraft.hermesModelCommand
                              )
                            }
                          >
                            {t("hermes.configureModel")}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={handleRevealHermesHome}
                          >
                            {t("hermes.openConfigFolder")}
                          </Button>
                        </div>
                      )}
                      {selectedDraft.hermesSetupCommand && (
                        <div className="flex items-center gap-2">
                          <code className="flex-1 overflow-x-auto rounded bg-muted px-2 py-1 text-2xs font-mono whitespace-nowrap">
                            {selectedDraft.hermesSetupCommand}
                          </code>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 w-7 shrink-0 p-0"
                            onClick={async () => {
                              const ok = await copyTextToClipboard(
                                selectedDraft.hermesSetupCommand
                              )
                              if (ok) {
                                toast.success(t("hermes.commandCopied"))
                              }
                            }}
                            title={t("hermes.copyCommand")}
                          >
                            <Copy className="h-3 w-3" />
                          </Button>
                        </div>
                      )}
                    </div>

                    <details className="rounded-md border p-3">
                      <summary className="cursor-pointer text-2xs font-medium text-muted-foreground">
                        {t("hermes.advancedTitle")}
                      </summary>
                      <div className="mt-2 space-y-2">
                        <p className="text-2xs text-muted-foreground">
                          {t("hermes.rawConfigHint")}
                        </p>
                        <Textarea
                          value={selectedDraft.hermesConfigYaml}
                          onChange={(event) =>
                            handleHermesFieldChange(
                              "hermesConfigYaml",
                              event.target.value
                            )
                          }
                          placeholder={`model:\n  provider: openrouter\n  default: moonshotai/kimi-k2`}
                          className="min-h-40 max-h-80 font-mono text-xs"
                          disabled={selectedIsSavingConfig}
                        />
                        <div className="flex justify-end">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleSaveHermesConfig("raw")}
                            disabled={selectedIsSavingConfig}
                          >
                            {selectedIsSavingConfig ? (
                              <>
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                {t("actions.saving")}
                              </>
                            ) : (
                              <>
                                <Save className="h-3.5 w-3.5" />
                                {t("hermes.saveRawConfig")}
                              </>
                            )}
                          </Button>
                        </div>
                      </div>
                    </details>
                  </div>
                ) : selectedAgent.agent_type === "code_buddy" ? (
                  <CodeBuddyConfigPanel
                    agent={selectedAgent}
                    saving={Boolean(savingEnv[selectedAgent.agent_type])}
                    onSave={(env, enabled) =>
                      persistEnv(
                        selectedAgent.agent_type,
                        enabled,
                        envMapToText(env),
                        selectedAgent.model_provider_id
                      )
                    }
                  />
                ) : selectedAgent.agent_type === "kimi_code" ? (
                  <KimiCodeConfigPanel
                    agent={selectedAgent}
                    onSaved={refreshAgents}
                  />
                ) : selectedAgent.agent_type === "pi" ? (
                  <PiConfigPanel
                    agent={selectedAgent}
                    saving={Boolean(savingEnv[selectedAgent.agent_type])}
                    onSaveEnv={(env, enabled) =>
                      persistEnv(
                        selectedAgent.agent_type,
                        enabled,
                        envMapToText(env),
                        selectedAgent.model_provider_id
                      )
                    }
                    onSaved={refreshAgents}
                  />
                ) : selectedAgent.agent_type === "cursor" ? (
                  <CursorConfigPanel
                    agent={selectedAgent}
                    saving={Boolean(savingEnv[selectedAgent.agent_type])}
                    onSaveEnv={(env, enabled) =>
                      persistEnv(
                        selectedAgent.agent_type,
                        enabled,
                        envMapToText(env),
                        selectedAgent.model_provider_id
                      )
                    }
                    onSaved={refreshAgents}
                    onAffectedSessions={reportAffectedSessions}
                  />
                ) : selectedAgent.agent_type === "deepseek" ? (
                  <>
                    <DeepSeekConfigPanel
                      agent={selectedAgent}
                      saving={Boolean(savingEnv[selectedAgent.agent_type])}
                      onSaveEnv={(env, enabled) =>
                        persistEnv(
                          selectedAgent.agent_type,
                          enabled,
                          envMapToText(env),
                          selectedAgent.model_provider_id,
                          // The keys this panel owns, folded into the raw
                          // editor's draft (which the enable switch persists
                          // wholesale) so the two can never disagree.
                          // `DEEPSEEK_ACP_MODEL` is NOT one of them — the raw
                          // editor owns it, and folding it in would overwrite a
                          // model line being typed there.
                          {
                            DEEPSEEK_API_KEY: env.DEEPSEEK_API_KEY,
                            DEEPSEEK_BASE_URL: env.DEEPSEEK_BASE_URL,
                            DEEPSEEK_ACP_PROVIDER: env.DEEPSEEK_ACP_PROVIDER,
                          }
                        )
                      }
                    />
                    {/* The deployment's model catalog. It lives in the harness'
                      own `settings.yaml`, not in the agent env, so it has its
                      own section and its own save — and it is what the
                      composer's per-session model selector gets to choose
                      from. */}
                    <DeepSeekModelListEditor
                      launchModel={selectedAgent.env.DEEPSEEK_ACP_MODEL}
                    />
                  </>
                ) : selectedAgent.agent_type === "qoder" ? (
                  <QoderConfigPanel
                    agent={selectedAgent}
                    saving={Boolean(savingEnv[selectedAgent.agent_type])}
                    onSaveEnv={(env, enabled) =>
                      persistEnv(
                        selectedAgent.agent_type,
                        enabled,
                        envMapToText(env),
                        selectedAgent.model_provider_id,
                        // The one key this panel owns, folded into the raw
                        // editor's draft. That draft is persisted WHOLESALE by
                        // the enable switch and the generic env Save button, so
                        // without this a saved token would be silently deleted
                        // the moment either one fires. `undefined` (the token
                        // field was cleared) deletes the line, which is the
                        // outcome clearing it asks for.
                        {
                          QODER_PERSONAL_ACCESS_TOKEN:
                            env.QODER_PERSONAL_ACCESS_TOKEN,
                        }
                      )
                    }
                    onSaved={refreshAgents}
                    onAffectedSessions={reportAffectedSessions}
                  />
                ) : selectedAgent.agent_type === "antigravity" ? (
                  <AntigravityConfigPanel
                    agent={selectedAgent}
                    saving={Boolean(savingEnv[selectedAgent.agent_type])}
                    onSaveEnv={(env, enabled) =>
                      persistEnv(
                        selectedAgent.agent_type,
                        enabled,
                        envMapToText(env),
                        selectedAgent.model_provider_id,
                        // The keys this panel owns, folded into the raw
                        // editor's draft. That draft is persisted WHOLESALE by
                        // the enable switch and the generic env Save button, so
                        // without this a saved auth method would be silently
                        // deleted the moment either one fires. `undefined` (the
                        // method does not use that credential) deletes the
                        // line, which is exactly what switching methods asks
                        // for.
                        Object.fromEntries(
                          ANTIGRAVITY_ENV_KEYS.map((key) => [key, env[key]])
                        )
                      )
                    }
                    onSaved={refreshAgents}
                  />
                ) : selectedAgent.agent_type === "grok" ? (
                  <div className="space-y-3 rounded-md border bg-muted/10 p-3">
                    <div>
                      <label className="text-xs font-medium">
                        {t("configManagement")}
                      </label>
                      <p className="mt-1 text-2xs text-muted-foreground">
                        {t("grok.configDescription")}
                      </p>
                    </div>

                    {/* Structured controls — mode + reasoning effort */}
                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="space-y-1.5">
                        <label className="text-2xs text-muted-foreground">
                          {t("grok.permissionModeLabel")}
                        </label>
                        <Select
                          value={selectedDraft.grokPermissionMode || GROK_UNSET}
                          disabled={grokSaving}
                          onValueChange={(value) =>
                            updateSelectedDraft((current) => ({
                              ...current,
                              grokPermissionMode:
                                value === GROK_UNSET ? "" : value,
                            }))
                          }
                        >
                          <SelectTrigger
                            className="w-full"
                            aria-label={t("grok.permissionModeLabel")}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={GROK_UNSET}>
                              {t("grok.optionDefault")}
                            </SelectItem>
                            <SelectItem value="default">
                              {t("grok.permissionDefault")}
                            </SelectItem>
                            <SelectItem value="acceptEdits">
                              {t("grok.permissionAcceptEdits")}
                            </SelectItem>
                            <SelectItem value="auto">
                              {t("grok.permissionAuto")}
                            </SelectItem>
                            <SelectItem value="bypassPermissions">
                              {t("grok.permissionAlwaysApprove")}
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="space-y-1.5">
                        <label className="text-2xs text-muted-foreground">
                          {t("grok.reasoningEffortLabel")}
                        </label>
                        <Select
                          value={
                            selectedDraft.grokReasoningEffort || GROK_UNSET
                          }
                          disabled={grokSaving}
                          onValueChange={(value) =>
                            updateSelectedDraft((current) => ({
                              ...current,
                              grokReasoningEffort:
                                value === GROK_UNSET ? "" : value,
                            }))
                          }
                        >
                          <SelectTrigger
                            className="w-full"
                            aria-label={t("grok.reasoningEffortLabel")}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={GROK_UNSET}>
                              {t("grok.optionDefault")}
                            </SelectItem>
                            <SelectItem value="low">
                              {t("grok.effortLow")}
                            </SelectItem>
                            <SelectItem value="medium">
                              {t("grok.effortMedium")}
                            </SelectItem>
                            <SelectItem value="high">
                              {t("grok.effortHigh")}
                            </SelectItem>
                            <SelectItem value="xhigh">
                              {t("grok.effortXhigh")}
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>

                    {/* Authentication — method selector + method-specific body.
                        Mirrors the Cursor panel: an explicit choice between the
                        `grok login` subscription and an XAI_API_KEY, recognized
                        on load via inferGrokMode and recorded as GROK_AUTH_MODE. */}
                    <div className="space-y-2.5 rounded-md border p-2.5">
                      <div className="space-y-1.5">
                        <label className="text-2xs font-medium">
                          {t("grok.authTitle")}
                        </label>
                        <Select
                          value={selectedDraft.grokAuthMode}
                          disabled={grokSaving}
                          onValueChange={(value) =>
                            handleGrokAuthModeChange(value as GrokAuthMethod)
                          }
                        >
                          <SelectTrigger
                            className="w-full"
                            aria-label={t("grok.authMode")}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="subscription">
                              {t("authModeOfficialSubscription")}
                            </SelectItem>
                            <SelectItem value="api_key">
                              {t("grok.authModeApiKey")}
                            </SelectItem>
                            <SelectItem value="custom">
                              {t("grok.authModeCustom")}
                            </SelectItem>
                          </SelectContent>
                        </Select>
                        <p className="text-2xs text-muted-foreground">
                          {selectedDraft.grokAuthMode === "subscription"
                            ? t("grok.subscriptionHint")
                            : selectedDraft.grokAuthMode === "custom"
                              ? t("grok.authModeCustomHint")
                              : t("grok.authModeApiKeyHint")}
                        </p>
                      </div>

                      {selectedDraft.grokAuthMode === "subscription" ? (
                        // Subscription: a copyable `grok login` command. Its
                        // session lives in ~/.grok/auth.json (untouched here); the
                        // launch path strips any inherited XAI_API_KEY.
                        <div className="space-y-1.5">
                          <p className="text-2xs text-muted-foreground">
                            {t("grok.loginHint")}
                          </p>
                          <div className="flex items-center gap-2">
                            <code className="flex-1 overflow-x-auto rounded bg-muted px-2 py-1 text-2xs font-mono whitespace-nowrap">
                              {GROK_LOGIN_COMMAND}
                            </code>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 shrink-0 p-0"
                              onClick={async () => {
                                const ok =
                                  await copyTextToClipboard(GROK_LOGIN_COMMAND)
                                if (ok) toast.success(t("grok.commandCopied"))
                              }}
                              title={t("grok.copyCommand")}
                              aria-label={t("grok.copyCommand")}
                            >
                              <Copy className="h-3 w-3" />
                            </Button>
                          </div>
                        </div>
                      ) : selectedDraft.grokAuthMode === "api_key" ? (
                        // API key: the non-interactive XAI_API_KEY credential.
                        <div className="space-y-1.5">
                          <label className="text-2xs text-muted-foreground">
                            XAI_API_KEY
                          </label>
                          <div className="flex items-center gap-2">
                            <Input
                              type={
                                showApiKeys[selectedAgent.agent_type]
                                  ? "text"
                                  : "password"
                              }
                              value={selectedDraft.apiKey}
                              onChange={(event) =>
                                handleImportantConfigChange(
                                  "apiKey",
                                  event.target.value
                                )
                              }
                              placeholder="xai-..."
                              aria-label="XAI_API_KEY"
                              name="grok-xai-api-key"
                              autoComplete="off"
                              spellCheck={false}
                              disabled={grokSaving}
                            />
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={grokSaving}
                              onClick={() =>
                                setShowApiKeys((prev) => ({
                                  ...prev,
                                  [selectedAgent.agent_type]:
                                    !prev[selectedAgent.agent_type],
                                }))
                              }
                              aria-label={
                                showApiKeys[selectedAgent.agent_type]
                                  ? t("actions.hideApiKey")
                                  : t("actions.showApiKey")
                              }
                              title={
                                showApiKeys[selectedAgent.agent_type]
                                  ? t("actions.hideApiKey")
                                  : t("actions.showApiKey")
                              }
                            >
                              {showApiKeys[selectedAgent.agent_type] ? (
                                <EyeOff className="h-3.5 w-3.5" />
                              ) : (
                                <Eye className="h-3.5 w-3.5" />
                              )}
                            </Button>
                          </div>
                          <p className="text-2xs text-muted-foreground">
                            {selectedDraft.apiKey.trim()
                              ? t("grok.authKeyConfigured")
                              : t("grok.authKeyMissing")}
                          </p>
                        </div>
                      ) : null}
                    </div>

                    {/* Custom model (BYO endpoint) → [model.<id>] + [models].default.
                        Only shown (and saved) in the `custom` auth method: a model
                        id registers a custom Grok model as the default; the other
                        methods omit the codeg-managed block. */}
                    {selectedDraft.grokAuthMode === "custom" ? (
                      <div className="space-y-2.5 rounded-md border p-2.5">
                        <div>
                          <label className="text-2xs font-medium">
                            {t("grok.customModelTitle")}
                          </label>
                          <p className="mt-1 text-2xs text-muted-foreground">
                            {t("grok.customModelHint")}
                          </p>
                        </div>

                        <div className="space-y-1.5">
                          <label className="text-2xs text-muted-foreground">
                            {t("grok.customModelIdLabel")}
                          </label>
                          <Input
                            value={selectedDraft.grokCustomModelId}
                            onChange={(event) =>
                              updateSelectedDraft((current) => ({
                                ...current,
                                grokCustomModelId: event.target.value,
                              }))
                            }
                            placeholder={t("grok.customModelIdPlaceholder")}
                            aria-label={t("grok.customModelIdLabel")}
                            autoComplete="off"
                            spellCheck={false}
                            disabled={grokSaving}
                          />
                          <p className="text-2xs text-muted-foreground">
                            {t("grok.customModelIdHint")}
                          </p>
                        </div>

                        <div className="grid gap-3 md:grid-cols-2">
                          <div className="space-y-1.5">
                            <label className="text-2xs text-muted-foreground">
                              {t("grok.customBaseUrlLabel")}
                            </label>
                            <Input
                              value={selectedDraft.grokCustomBaseUrl}
                              onChange={(event) =>
                                updateSelectedDraft((current) => ({
                                  ...current,
                                  grokCustomBaseUrl: event.target.value,
                                }))
                              }
                              placeholder={t("grok.customBaseUrlPlaceholder")}
                              aria-label={t("grok.customBaseUrlLabel")}
                              autoComplete="off"
                              spellCheck={false}
                              disabled={grokSaving}
                            />
                          </div>
                          <div className="space-y-1.5">
                            <label className="text-2xs text-muted-foreground">
                              {t("grok.customApiBackendLabel")}
                            </label>
                            <Select
                              value={
                                selectedDraft.grokCustomApiBackend ||
                                GROK_DEFAULT_API_BACKEND
                              }
                              disabled={grokSaving}
                              onValueChange={(value) =>
                                updateSelectedDraft((current) => ({
                                  ...current,
                                  grokCustomApiBackend: value,
                                }))
                              }
                            >
                              <SelectTrigger
                                className="w-full"
                                aria-label={t("grok.customApiBackendLabel")}
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="responses">
                                  {t("grok.backendResponses")}
                                </SelectItem>
                                <SelectItem value="chat_completions">
                                  {t("grok.backendChatCompletions")}
                                </SelectItem>
                                <SelectItem value="messages">
                                  {t("grok.backendMessages")}
                                </SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                        </div>

                        <div className="space-y-1.5">
                          <label className="text-2xs text-muted-foreground">
                            {t("grok.customApiKeyLabel")}
                          </label>
                          <div className="flex items-center gap-2">
                            <Input
                              type={showGrokCustomKey ? "text" : "password"}
                              value={selectedDraft.grokCustomApiKey}
                              onChange={(event) =>
                                updateSelectedDraft((current) => ({
                                  ...current,
                                  grokCustomApiKey: event.target.value,
                                }))
                              }
                              placeholder="xai-..."
                              aria-label={t("grok.customApiKeyLabel")}
                              name="grok-custom-api-key"
                              autoComplete="off"
                              spellCheck={false}
                              disabled={grokSaving}
                            />
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={grokSaving}
                              onClick={() =>
                                setShowGrokCustomKey((prev) => !prev)
                              }
                              aria-label={
                                showGrokCustomKey
                                  ? t("actions.hideApiKey")
                                  : t("actions.showApiKey")
                              }
                              title={
                                showGrokCustomKey
                                  ? t("actions.hideApiKey")
                                  : t("actions.showApiKey")
                              }
                            >
                              {showGrokCustomKey ? (
                                <EyeOff className="h-3.5 w-3.5" />
                              ) : (
                                <Eye className="h-3.5 w-3.5" />
                              )}
                            </Button>
                          </div>
                          <p className="text-2xs text-muted-foreground">
                            {t("grok.customApiKeyHint")}
                          </p>
                        </div>

                        <div className="space-y-1.5">
                          <label className="text-2xs text-muted-foreground">
                            {t("grok.customContextWindowLabel")}
                          </label>
                          <Input
                            type="number"
                            inputMode="numeric"
                            value={selectedDraft.grokCustomContextWindow}
                            onChange={(event) =>
                              updateSelectedDraft((current) => ({
                                ...current,
                                grokCustomContextWindow: event.target.value,
                              }))
                            }
                            placeholder="500000"
                            aria-label={t("grok.customContextWindowLabel")}
                            disabled={grokSaving}
                          />
                          <p className="text-2xs text-muted-foreground">
                            {t("grok.customContextWindowHint")}
                          </p>
                        </div>
                      </div>
                    ) : null}

                    {/* Compaction — session-global auto-compact threshold. */}
                    <div className="space-y-1.5">
                      <label className="text-2xs text-muted-foreground">
                        {t("grok.autoCompactLabel")}
                      </label>
                      <Input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={100}
                        value={selectedDraft.grokAutoCompactThreshold}
                        onChange={(event) =>
                          updateSelectedDraft((current) => ({
                            ...current,
                            grokAutoCompactThreshold: event.target.value,
                          }))
                        }
                        placeholder="85"
                        aria-label={t("grok.autoCompactLabel")}
                        disabled={grokSaving}
                      />
                      <p className="text-2xs text-muted-foreground">
                        {t("grok.autoCompactHint")}
                      </p>
                    </div>

                    {/* Advanced escape hatch — config.toml keys other than the
                        controls above. Saved together with those controls by the
                        single Save below (the structured settings merge onto this
                        text, format-preservingly, when it was edited). */}
                    <Collapsible
                      open={grokAdvancedOpen}
                      onOpenChange={setGrokAdvancedOpen}
                    >
                      <CollapsibleTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 gap-1 px-1 text-2xs text-muted-foreground"
                        >
                          <ChevronRight
                            className={cn(
                              "h-3.5 w-3.5 transition-transform",
                              grokAdvancedOpen && "rotate-90"
                            )}
                          />
                          {t("grok.advancedToggle")}
                        </Button>
                      </CollapsibleTrigger>
                      <CollapsibleContent className="space-y-1.5 pt-2">
                        <label className="text-2xs text-muted-foreground">
                          {t("grok.configTomlNative")}
                        </label>
                        <Textarea
                          value={selectedDraft.grokConfigTomlText}
                          onChange={(event) => {
                            const nextText = event.target.value
                            updateSelectedDraft((current) => ({
                              ...current,
                              grokConfigTomlText: nextText,
                            }))
                          }}
                          placeholder={t("grok.configTomlPlaceholder")}
                          className="min-h-40 max-h-80 font-mono text-xs"
                          spellCheck={false}
                          aria-label={t("grok.configTomlNative")}
                          disabled={grokSaving}
                        />
                        <p className="text-2xs text-muted-foreground">
                          {t("grok.configTomlHint")}
                        </p>
                      </CollapsibleContent>
                    </Collapsible>

                    {/* A single Save persists every surface together: the
                        structured controls merge (format-preserving) onto the raw
                        text when it was edited, else onto the current on-disk file,
                        then XAI_API_KEY is written. One action → no independent save
                        that could drop the other surface's unsaved edits. */}
                    <div className="flex justify-end">
                      <Button
                        size="sm"
                        onClick={async () => {
                          setGrokSaving(true)
                          try {
                            // Config first, so a malformed raw edit fails before
                            // the API key is touched. buildGrokSaveOptions sends
                            // the raw text only when the user actually edited it
                            // (else the merge runs against fresh on-disk config).
                            await persistConfig(
                              selectedAgent.agent_type,
                              selectedDraft.configText,
                              buildGrokSaveOptions(
                                selectedDraft,
                                selectedAgent.grok_config_toml
                              )
                            )
                            // Independent second write (the API key lives in env).
                            // If it fails after config committed, report that
                            // partial outcome honestly rather than a blanket fail.
                            try {
                              await persistEnv(
                                selectedAgent.agent_type,
                                selectedDraft.enabled,
                                selectedDraft.envText,
                                selectedDraft.modelProviderId
                              )
                            } catch (envErr) {
                              console.error(
                                "[Settings] save grok api key failed:",
                                envErr
                              )
                              await reseedGrokDraft()
                              toast.error(t("toasts.saveGrokApiKeyFailed"), {
                                description: toErrorMessage(envErr),
                              })
                              return
                            }
                            await reseedGrokDraft()
                            toast.success(t("toasts.grokSaved"), {
                              description: t("toasts.configSavedHint"),
                            })
                          } catch (err) {
                            console.error(
                              "[Settings] save grok settings failed:",
                              err
                            )
                            toast.error(t("toasts.saveGrokNativeFailed"), {
                              description: toErrorMessage(err),
                            })
                          } finally {
                            setGrokSaving(false)
                          }
                        }}
                        disabled={
                          grokSaving ||
                          selectedIsSavingConfig ||
                          selectedIsSavingEnv
                        }
                      >
                        {grokSaving ? (
                          <>
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            {t("actions.saving")}
                          </>
                        ) : (
                          <>
                            <Save className="h-3.5 w-3.5" />
                            {t("actions.saveGrokConfig")}
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                ) : isCustomAgentType(selectedAgent.agent_type) ? (
                  // A custom agent is driven purely by the ACP protocol: codeg
                  // knows nothing about its config file layout or auth model,
                  // so the generic "config management" editor below would be
                  // offering to write a file that may not exist in a format it
                  // cannot know. Environment variables (above) are the one
                  // channel that works for every agent, so they are the whole
                  // surface — plus the skills declaration and removing the
                  // agent.
                  // All four blocks share the settings-card vocabulary
                  // (`SettingCard` / `SettingRow`, as in the task settings
                  // dialog) so the panel reads as one stack of settings rather
                  // than four differently-shaped boxes.
                  <>
                    <SettingCard>
                      <SettingRow
                        icon={Pencil}
                        title={t("customAgentEdit")}
                        description={t("customAgentEditHint")}
                        control={
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              setEditCustomAgentId(
                                customAgentId(selectedAgent.agent_type)
                              )
                            }
                          >
                            <Pencil className="h-3.5 w-3.5" />
                            {t("customAgentEdit")}
                          </Button>
                        }
                      />
                    </SettingCard>
                    <CustomAgentSkillsToggle
                      registryId={customAgentId(selectedAgent.agent_type) ?? ""}
                    />
                    <CustomAgentMcpToggle
                      registryId={customAgentId(selectedAgent.agent_type) ?? ""}
                    />
                    {/* The one destructive action keeps its own tinting — the
                        card shape is shared, the color is the warning. */}
                    <SettingCard className="border-destructive/30 bg-destructive/5">
                      <SettingRow
                        icon={Trash2}
                        title={
                          <span className="text-destructive">
                            {t("customAgentRemove")}
                          </span>
                        }
                        description={t("customAgentRemoveHint")}
                        control={
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            disabled={removingCustomAgent}
                            onClick={() => setRemoveConfirmAgent(selectedAgent)}
                          >
                            {removingCustomAgent ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Trash2 className="h-3.5 w-3.5" />
                            )}
                            {t("customAgentRemove")}
                          </Button>
                        }
                      />
                    </SettingCard>
                  </>
                ) : (
                  <div className="space-y-3 rounded-md border bg-muted/10 p-3">
                    <div>
                      <label className="text-xs font-medium">
                        {t("configManagement")}
                      </label>
                      <p className="mt-1 text-2xs text-muted-foreground">
                        {selectedAgent.agent_type === "claude_code"
                          ? t("generalConfigDescriptionClaude")
                          : t("generalConfigDescriptionDefault")}
                      </p>
                    </div>

                    {selectedAgent.agent_type === "claude_code" && (
                      <div className="space-y-1.5">
                        <label className="text-2xs text-muted-foreground">
                          {t("claude.authMode")}
                        </label>
                        <Select
                          value={selectedDraft.claudeAuthMode}
                          onValueChange={(value) => {
                            if (
                              CLAUDE_AUTH_MODES.includes(
                                value as ClaudeAuthMode
                              )
                            ) {
                              handleClaudeAuthModeChange(
                                value as ClaudeAuthMode
                              )
                            }
                          }}
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent align="start">
                            <SelectItem value="official_subscription">
                              {t("authModeOfficialSubscription")}
                            </SelectItem>
                            <SelectItem value="custom">
                              {t("authModeCustomEndpoint")}
                            </SelectItem>
                            <SelectItem value="model_provider">
                              {t("authModeModelProvider")}
                            </SelectItem>
                          </SelectContent>
                        </Select>
                        <p className="text-2xs text-muted-foreground">
                          {selectedDraft.claudeAuthMode ===
                          "official_subscription"
                            ? t("claude.officialSubscriptionHint")
                            : selectedDraft.claudeAuthMode === "custom"
                              ? t("authModeCustomEndpointHint")
                              : t("modelProviderHint")}
                        </p>
                      </div>
                    )}

                    {selectedAgent.agent_type === "claude_code" &&
                      selectedDraft.claudeAuthMode === "model_provider" && (
                        <div className="space-y-1.5">
                          <label className="text-2xs text-muted-foreground">
                            {t("selectModelProvider")}
                          </label>
                          {selectedModelProviders.length > 0 ? (
                            <Select
                              value={
                                selectedDraft.modelProviderId != null
                                  ? String(selectedDraft.modelProviderId)
                                  : ""
                              }
                              onValueChange={handleModelProviderSelect}
                            >
                              <SelectTrigger className="w-full">
                                <SelectValue
                                  placeholder={t("selectModelProvider")}
                                />
                              </SelectTrigger>
                              <SelectContent align="start">
                                {selectedModelProviders.map((provider) => (
                                  <SelectItem
                                    key={provider.id}
                                    value={String(provider.id)}
                                  >
                                    {provider.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            <p className="text-2xs text-muted-foreground">
                              {t("noModelProviderAvailable")}
                            </p>
                          )}
                        </div>
                      )}

                    {(selectedAgent.agent_type !== "claude_code" ||
                      selectedDraft.claudeAuthMode === "custom" ||
                      selectedDraft.claudeAuthMode === "model_provider") && (
                      <>
                        {importantFieldsFor(selectedAgent.agent_type)
                          .apiBaseUrl && (
                          <div className="space-y-1.5">
                            <label className="text-2xs text-muted-foreground">
                              API URL
                            </label>
                            <Input
                              value={selectedDraft.apiBaseUrl}
                              readOnly={
                                selectedAgent.agent_type === "claude_code" &&
                                selectedDraft.claudeAuthMode ===
                                  "model_provider"
                              }
                              onChange={(event) => {
                                handleImportantConfigChange(
                                  "apiBaseUrl",
                                  event.target.value
                                )
                              }}
                              placeholder="https://api.example.com"
                            />
                          </div>
                        )}

                        {importantFieldsFor(selectedAgent.agent_type)
                          .apiKey && (
                          <div className="space-y-1.5">
                            <label className="text-2xs text-muted-foreground">
                              API Key
                            </label>
                            <div className="flex items-center gap-2">
                              <Input
                                type={
                                  showApiKeys[selectedAgent.agent_type]
                                    ? "text"
                                    : "password"
                                }
                                value={selectedDraft.apiKey}
                                readOnly={
                                  selectedAgent.agent_type === "claude_code" &&
                                  selectedDraft.claudeAuthMode ===
                                    "model_provider"
                                }
                                onChange={(event) => {
                                  handleImportantConfigChange(
                                    "apiKey",
                                    event.target.value
                                  )
                                }}
                                placeholder="sk-..."
                              />
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                  setShowApiKeys((prev) => ({
                                    ...prev,
                                    [selectedAgent.agent_type]:
                                      !prev[selectedAgent.agent_type],
                                  }))
                                }}
                                title={
                                  showApiKeys[selectedAgent.agent_type]
                                    ? t("actions.hideApiKey")
                                    : t("actions.showApiKey")
                                }
                              >
                                {showApiKeys[selectedAgent.agent_type] ? (
                                  <EyeOff className="h-3.5 w-3.5" />
                                ) : (
                                  <Eye className="h-3.5 w-3.5" />
                                )}
                              </Button>
                            </div>
                          </div>
                        )}
                      </>
                    )}

                    {selectedAgent.agent_type === "claude_code" ? (
                      <div className="space-y-2">
                        <div className="grid gap-3 md:grid-cols-2">
                          <div className="space-y-1.5">
                            <label className="text-2xs text-muted-foreground">
                              {t("claude.mainModel")}
                            </label>
                            <Input
                              value={selectedDraft.claudeMainModel}
                              readOnly={
                                selectedDraft.claudeAuthMode ===
                                "model_provider"
                              }
                              onChange={(event) => {
                                handleImportantConfigChange(
                                  "claudeMainModel",
                                  event.target.value
                                )
                              }}
                              placeholder="claude-sonnet-5"
                            />
                          </div>
                          <div className="space-y-1.5">
                            <label className="text-2xs text-muted-foreground">
                              {t("claude.reasoningModel")}
                            </label>
                            <Input
                              value={selectedDraft.claudeReasoningModel}
                              readOnly={
                                selectedDraft.claudeAuthMode ===
                                "model_provider"
                              }
                              onChange={(event) => {
                                handleImportantConfigChange(
                                  "claudeReasoningModel",
                                  event.target.value
                                )
                              }}
                              placeholder="claude-opus-5-5"
                            />
                          </div>
                          <div className="space-y-1.5">
                            <label className="text-2xs text-muted-foreground">
                              {t("claude.haikuDefaultModel")}
                            </label>
                            <Input
                              value={selectedDraft.claudeDefaultHaikuModel}
                              readOnly={
                                selectedDraft.claudeAuthMode ===
                                "model_provider"
                              }
                              onChange={(event) => {
                                handleImportantConfigChange(
                                  "claudeDefaultHaikuModel",
                                  event.target.value
                                )
                              }}
                              placeholder="claude-haiku-4-5"
                            />
                          </div>
                          <div className="space-y-1.5">
                            <label className="text-2xs text-muted-foreground">
                              {t("claude.sonnetDefaultModel")}
                            </label>
                            <Input
                              value={selectedDraft.claudeDefaultSonnetModel}
                              readOnly={
                                selectedDraft.claudeAuthMode ===
                                "model_provider"
                              }
                              onChange={(event) => {
                                handleImportantConfigChange(
                                  "claudeDefaultSonnetModel",
                                  event.target.value
                                )
                              }}
                              placeholder="claude-sonnet-5"
                            />
                          </div>
                          <div className="space-y-1.5 md:col-span-2">
                            <label className="text-2xs text-muted-foreground">
                              {t("claude.opusDefaultModel")}
                            </label>
                            <Input
                              value={selectedDraft.claudeDefaultOpusModel}
                              readOnly={
                                selectedDraft.claudeAuthMode ===
                                "model_provider"
                              }
                              onChange={(event) => {
                                handleImportantConfigChange(
                                  "claudeDefaultOpusModel",
                                  event.target.value
                                )
                              }}
                              placeholder="claude-opus-5-5"
                            />
                          </div>
                        </div>
                        <p className="text-2xs text-muted-foreground">
                          {t("modelHintDefault")}
                        </p>
                        <div className="space-y-2 border-t border-border/60 pt-3">
                          <div className="grid gap-3 md:grid-cols-2">
                            <div className="space-y-1.5 md:col-span-2">
                              <label className="text-2xs text-muted-foreground">
                                {t("claude.customModelOption")}
                              </label>
                              <Input
                                value={selectedDraft.claudeCustomModelOption}
                                readOnly={
                                  selectedDraft.claudeAuthMode ===
                                  "model_provider"
                                }
                                onChange={(event) => {
                                  handleImportantConfigChange(
                                    "claudeCustomModelOption",
                                    event.target.value
                                  )
                                }}
                                placeholder="my-gateway/claude-opus-5-5"
                              />
                            </div>
                            <div className="space-y-1.5">
                              <label className="text-2xs text-muted-foreground">
                                {t("claude.customModelOptionName")}
                              </label>
                              <Input
                                value={
                                  selectedDraft.claudeCustomModelOptionName
                                }
                                readOnly={
                                  selectedDraft.claudeAuthMode ===
                                  "model_provider"
                                }
                                onChange={(event) => {
                                  handleImportantConfigChange(
                                    "claudeCustomModelOptionName",
                                    event.target.value
                                  )
                                }}
                                placeholder="Gateway Opus"
                              />
                            </div>
                            <div className="space-y-1.5">
                              <label className="text-2xs text-muted-foreground">
                                {t("claude.customModelOptionDescription")}
                              </label>
                              <Input
                                value={
                                  selectedDraft.claudeCustomModelOptionDescription
                                }
                                readOnly={
                                  selectedDraft.claudeAuthMode ===
                                  "model_provider"
                                }
                                onChange={(event) => {
                                  handleImportantConfigChange(
                                    "claudeCustomModelOptionDescription",
                                    event.target.value
                                  )
                                }}
                                placeholder="Routed via custom gateway"
                              />
                            </div>
                          </div>
                          <p className="text-2xs text-muted-foreground">
                            {t("claude.customModelOptionHint")}
                          </p>
                        </div>
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between rounded-md border px-3 py-2">
                            <label className="text-2xs text-muted-foreground">
                              {t("claude.sendAttributionHeader")}
                            </label>
                            <Switch
                              checked={
                                selectedDraft.claudeSendAttributionHeader
                              }
                              onCheckedChange={(checked) => {
                                handleClaudeEnvFlagChange(
                                  "claudeSendAttributionHeader",
                                  CLAUDE_ATTRIBUTION_HEADER_ENV_KEY,
                                  checked
                                )
                              }}
                              aria-label={t("claude.sendAttributionHeaderAria")}
                            />
                          </div>
                        </div>
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between rounded-md border px-3 py-2">
                            <label className="text-2xs text-muted-foreground">
                              {t("claude.disableNonessentialTraffic")}
                            </label>
                            <Switch
                              checked={
                                selectedDraft.claudeDisableNonessentialTraffic
                              }
                              onCheckedChange={(checked) => {
                                handleClaudeEnvFlagChange(
                                  "claudeDisableNonessentialTraffic",
                                  CLAUDE_NONESSENTIAL_TRAFFIC_ENV_KEY,
                                  checked
                                )
                              }}
                              aria-label={t(
                                "claude.disableNonessentialTrafficAria"
                              )}
                            />
                          </div>
                        </div>
                      </div>
                    ) : (
                      importantFieldsFor(selectedAgent.agent_type).model && (
                        <div className="space-y-1.5">
                          <label className="text-2xs text-muted-foreground">
                            Model
                          </label>
                          <Input
                            value={selectedDraft.model}
                            readOnly={selectedDraft.modelProviderId != null}
                            onChange={(event) => {
                              handleImportantConfigChange(
                                "model",
                                event.target.value
                              )
                            }}
                            placeholder="gpt-6-astra / claude-sonnet-5 / gemini-3.1-pro-preview"
                          />
                        </div>
                      )
                    )}

                    <div className="space-y-1.5">
                      <label className="text-2xs text-muted-foreground">
                        {t("nativeJsonConfig")}
                      </label>
                      <Textarea
                        value={selectedDraft.configText}
                        onChange={(event) => {
                          handleConfigTextChange(event.target.value)
                        }}
                        placeholder={`{
  "apiBaseUrl": "https://api.example.com",
  "apiKey": "sk-...",
  "model": "gpt-6-astra",
  "env": {
    "CUSTOM_KEY": "VALUE"
  }
}`}
                        className="min-h-36 font-mono text-xs"
                      />
                      {selectedConfigError && (
                        <div className="rounded-md border border-red-500/30 bg-red-500/5 px-2.5 py-1.5 text-2xs text-red-400">
                          {selectedConfigError}
                        </div>
                      )}
                    </div>

                    <div className="flex justify-end">
                      <Button
                        size="sm"
                        onClick={() => {
                          if (selectedMissingModelProvider) {
                            toast.error(t("toasts.modelProviderRequired"))
                            return
                          }
                          // When a Claude provider is bound, the on-disk config
                          // loaded into configText may carry stale model keys
                          // (e.g. a leftover custom model option) from before the
                          // binding — re-derive them from the provider so
                          // persistConfig cannot write a stale value back over
                          // the backend bind cascade (invalid JSON passes through
                          // so persistConfig still surfaces the error). Sequence
                          // env→config (never parallel): persistEnv also rewrites
                          // config.env on the backend, so concurrent writes would
                          // interleave two writers of ~/.claude/settings.json.
                          let configToSave = configTextForClaudeSave(
                            selectedDraft.configText,
                            selectedAgent.agent_type,
                            selectedDraft.modelProviderId,
                            modelProviders.find(
                              (p) => p.id === selectedDraft.modelProviderId
                            )
                          )
                          // Materialize the Claude hardening toggles so the shown
                          // default positions are actually applied on save —
                          // writing the explicit "1"/"0" into both the native
                          // config `env` and the DB env overlay — regardless of
                          // whether the user touched the switches. Invalid JSON is
                          // left untouched so persistConfig surfaces the error.
                          let envToSave = selectedDraft.envText
                          if (selectedAgent.agent_type === "claude_code") {
                            const materialized =
                              materializeClaudeHardeningFlags(
                                configToSave,
                                envToSave,
                                {
                                  sendAttributionHeader:
                                    selectedDraft.claudeSendAttributionHeader,
                                  disableNonessentialTraffic:
                                    selectedDraft.claudeDisableNonessentialTraffic,
                                }
                              )
                            configToSave = materialized.configText
                            envToSave = materialized.envText
                          }
                          persistEnv(
                            selectedAgent.agent_type,
                            selectedDraft.enabled,
                            envToSave,
                            selectedDraft.modelProviderId
                          )
                            .then(() =>
                              persistConfig(
                                selectedAgent.agent_type,
                                configToSave
                              )
                            )
                            .then(() => {
                              // Reflect the provider-authoritative rewrite AND the
                              // materialized hardening flags in the editors so the
                              // textareas don't show stale values until reload —
                              // and so a later env-only save doesn't persist a
                              // stale envText that drops the flags from the DB
                              // overlay. Each inner guard preserves an edit the
                              // user typed while the save was in flight.
                              const syncedConfig =
                                configToSave !== selectedDraft.configText
                                  ? normalizeConfigText(configToSave)
                                  : null
                              const syncEnv =
                                envToSave !== selectedDraft.envText
                              if (syncedConfig !== null || syncEnv) {
                                updateSelectedDraft((current) => {
                                  let next = current
                                  if (
                                    syncedConfig !== null &&
                                    current.configText ===
                                      selectedDraft.configText
                                  ) {
                                    next = {
                                      ...next,
                                      configText: syncedConfig,
                                    }
                                  }
                                  if (
                                    syncEnv &&
                                    current.envText === selectedDraft.envText
                                  ) {
                                    next = { ...next, envText: envToSave }
                                  }
                                  return next
                                })
                              }
                              toast.success(t("toasts.configSaved"), {
                                description: t("toasts.configSavedHint"),
                              })
                            })
                            .catch((err) => {
                              console.error(
                                "[Settings] save config management failed:",
                                err
                              )
                              const message = toErrorMessage(err)
                              toast.error(
                                t("toasts.saveConfigManagementFailed"),
                                {
                                  description: message,
                                }
                              )
                            })
                        }}
                        disabled={selectedIsSavingEnv || selectedIsSavingConfig}
                      >
                        {selectedIsSavingEnv || selectedIsSavingConfig ? (
                          <>
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            {t("actions.saving")}
                          </>
                        ) : (
                          <>
                            <Save className="h-3.5 w-3.5" />
                            {t("actions.saveConfigManagement")}
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
              {t("emptyNoAgent")}
            </div>
          )}
        </div>
      </div>

      <AlertDialog
        open={Boolean(openCodeDeleteProviderId)}
        onOpenChange={(open) => {
          if (!open) setOpenCodeDeleteProviderId(null)
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("dialogs.confirmDeleteProvider", {
                providerId: openCodeDeleteProviderId ?? "",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("dialogs.confirmDeleteProviderDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={selectedIsSaving}>
              {t("actions.cancel")}
            </AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={confirmOpenCodeProviderDelete}
              disabled={selectedIsSaving}
            >
              {selectedIsSaving ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t("actions.deleting")}
                </>
              ) : (
                <>
                  <Trash2 className="h-3.5 w-3.5" />
                  {t("actions.confirmDelete")}
                </>
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={Boolean(uninstallConfirmAgent)}
        onOpenChange={(open) => {
          if (!open) setUninstallConfirmAgent(null)
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("dialogs.confirmUninstall", {
                name: uninstallConfirmAgent?.name ?? "Agent",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("dialogs.confirmUninstallDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={
                uninstallConfirmAgent
                  ? Boolean(busyBinaryAction[uninstallConfirmAgent.agent_type])
                  : false
              }
            >
              {t("actions.cancel")}
            </AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={confirmUninstall}
              disabled={
                uninstallConfirmAgent
                  ? Boolean(busyBinaryAction[uninstallConfirmAgent.agent_type])
                  : false
              }
            >
              {uninstallConfirmAgent &&
              busyBinaryAction[uninstallConfirmAgent.agent_type] ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t("actions.uninstalling")}
                </>
              ) : (
                <>
                  <Trash2 className="h-3.5 w-3.5" />
                  {t("actions.confirmUninstall")}
                </>
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={Boolean(removeConfirmAgent)}
        onOpenChange={(open) => {
          if (!open) setRemoveConfirmAgent(null)
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("customAgentRemove")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("customAgentRemoveConfirm", {
                name: removeConfirmAgent?.name ?? "Agent",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removingCustomAgent}>
              {t("actions.cancel")}
            </AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={confirmRemoveCustomAgent}
              disabled={removingCustomAgent}
            >
              {removingCustomAgent ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              {t("customAgentRemove")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={Boolean(customInstallAgent)}
        onOpenChange={(open) => {
          if (!open) setCustomInstallAgent(null)
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("dialogs.customInstallTitle", {
                name: customInstallAgent?.name ?? "Agent",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("dialogs.customInstallDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5">
            <label
              htmlFor="custom-version-input"
              className="text-xs font-medium"
            >
              {t("dialogs.customInstallVersionLabel")}
            </label>
            <Input
              id="custom-version-input"
              autoFocus
              value={customVersionInput}
              placeholder={customInstallAgent?.registry_version ?? "1.0.0"}
              onChange={(e) => setCustomVersionInput(e.target.value)}
              {...ime.props}
              onKeyDown={(e) => {
                if (ime.isComposing(e)) return
                if (
                  e.key === "Enter" &&
                  isValidCustomVersion(customVersionInput)
                ) {
                  e.preventDefault()
                  confirmCustomInstall()
                }
              }}
            />
            {customVersionInput.trim() !== "" &&
              !isValidCustomVersion(customVersionInput) && (
                <p className="text-2xs text-red-500">
                  {t("dialogs.customInstallInvalid")}
                </p>
              )}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("actions.cancel")}</AlertDialogCancel>
            <Button
              onClick={confirmCustomInstall}
              disabled={!isValidCustomVersion(customVersionInput)}
            >
              <PackagePlus className="h-3.5 w-3.5" />
              {t("dialogs.customInstallSubmit")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <OpencodePluginsModal
        open={pluginModalOpen}
        onOpenChange={setPluginModalOpen}
        onCompleted={() => {
          if (pluginModalAgent) {
            runPreflight(pluginModalAgent)
          }
          setPluginModalAgent(null)
        }}
      />
    </div>
  )
}
