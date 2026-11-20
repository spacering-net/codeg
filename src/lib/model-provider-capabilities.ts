import type { AgentType } from "./types"
import { isCustomAgentType } from "./types"
import type {
  ModelProviderApiType,
  ModelProviderRecord,
} from "./model-provider-types"

/** Frontend capability declarations for the shared Model Provider source.
 * Backend adapters still need to support the same wire formats before launch. */
export const AGENT_MODEL_PROVIDER_API_TYPES: Partial<
  Record<AgentType, ModelProviderApiType[]>
> = {
  claude_code: ["anthropic-messages"],
  codex: ["openai-responses"],
  gemini: ["google-generative-ai"],
  open_code: [
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
    "google-generative-ai",
  ],
  cline: ["anthropic-messages", "openai-completions", "google-generative-ai"],
  grok: ["openai-completions", "openai-responses", "anthropic-messages"],
  pi: [
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
    "google-generative-ai",
  ],
  hermes: ["openai-completions", "anthropic-messages", "google-generative-ai"],
  code_buddy: ["openai-completions"],
  kimi_code: [
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
    "google-generative-ai",
  ],
  deepseek: ["openai-completions"],
  antigravity: ["google-generative-ai"],
}

/** Agents whose existing panel does not already have a Model Provider mode. */
export const MODEL_PROVIDER_SOURCE_CARD_AGENT_TYPES: AgentType[] = [
  "claude_code",
  "codex",
  "open_code",
  "cline",
  "hermes",
  "code_buddy",
  "kimi_code",
  "pi",
  "grok",
  "deepseek",
  "antigravity",
]

/** Stable ids are intentionally shown in the settings UI: provider and model
 * display names are not configurable, and API families are technical ids.
 *
 * `customApiTypes` is the backend verdict for a custom agent
 * (`AcpAgentInfo.model_provider_api_types`): the families its CLI can actually
 * speak. Empty means codeg cannot project into it at all — an agent that keeps
 * provider config in its own files, or reads only part of the env contract. */
export function getModelProviderApiTypes(
  agentType: AgentType,
  customApiTypes: readonly ModelProviderApiType[] = []
): ModelProviderApiType[] {
  if (isCustomAgentType(agentType)) {
    return [...customApiTypes]
  }
  return AGENT_MODEL_PROVIDER_API_TYPES[agentType] ?? []
}

/** Whether the settings panel offers the shared Model Provider source card.
 * Custom agents only get one when codeg can actually project into them — an
 * agent that keeps provider config in its own files would otherwise show a
 * selection that silently never applies. */
export function supportsModelProviderSourceCard(
  agentType: AgentType,
  customApiTypes: readonly ModelProviderApiType[] = []
): boolean {
  return (
    MODEL_PROVIDER_SOURCE_CARD_AGENT_TYPES.includes(
      agentType as (typeof MODEL_PROVIDER_SOURCE_CARD_AGENT_TYPES)[number]
    ) ||
    (isCustomAgentType(agentType) && customApiTypes.length > 0)
  )
}

export type CompatibleModelProvider = Pick<
  ModelProviderRecord,
  "api" | "enabled" | "models"
>

/** Count only providers a source can actually offer: enabled, a matching API
 * family, and at least one model id. `customApiTypes` follows
 * [`getModelProviderApiTypes`]. */
export function countCompatibleModelProviders(
  providers: readonly CompatibleModelProvider[],
  agentType: AgentType,
  customApiTypes: readonly ModelProviderApiType[] = []
): number {
  const supported = new Set(getModelProviderApiTypes(agentType, customApiTypes))
  return providers.filter(
    (provider) =>
      provider.enabled &&
      supported.has(provider.api) &&
      provider.models.length > 0
  ).length
}
