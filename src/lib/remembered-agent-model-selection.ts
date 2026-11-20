"use client"

import { getModelProviderApiTypes } from "@/lib/model-provider-capabilities"
import type {
  ModelProviderApiType,
  ModelProviderRecord,
} from "@/lib/model-provider-types"
import type { AgentType } from "@/lib/types"
import { isCustomAgentType } from "@/lib/types"

/** A per-agent remembered provider/model choice (Model Provider source mode). */
export interface RememberedAgentModelSelection {
  providerId: string
  modelId: string
}

const AGENT_MODEL_SELECTION_KEY = "codeg:agent-model-selection:v1"

type AgentModelSelectionMap = Partial<
  Record<AgentType, RememberedAgentModelSelection>
>

function readAll(): AgentModelSelectionMap {
  if (typeof window === "undefined") return {}
  try {
    const raw = localStorage.getItem(AGENT_MODEL_SELECTION_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object") return {}
    return parsed as AgentModelSelectionMap
  } catch {
    return {}
  }
}

function writeAll(all: AgentModelSelectionMap): void {
  if (typeof window === "undefined") return
  try {
    localStorage.setItem(AGENT_MODEL_SELECTION_KEY, JSON.stringify(all))
  } catch {
    /* ignore storage quota/permission failures */
  }
}

function isValidSelection(
  value: unknown
): value is RememberedAgentModelSelection {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  return typeof v.providerId === "string" && typeof v.modelId === "string"
}

/** Remember the last provider/model choice for an agent so a future new
 *  conversation can restore it (Model Provider source mode). */
export function rememberAgentModelSelection(
  agentType: AgentType,
  selection: RememberedAgentModelSelection
): void {
  const all = readAll()
  all[agentType] = selection
  writeAll(all)
}

/** Load the remembered choice for an agent, or null when none / malformed. */
export function loadRememberedAgentModelSelection(
  agentType: AgentType
): RememberedAgentModelSelection | null {
  const value = readAll()[agentType]
  return isValidSelection(value) ? value : null
}

/** True when the remembered choice can still be restored: the provider is
 *  enabled, its model still exists, and its API family matches the agent.
 *  `customApiTypes` is the caller's backend-provided family list for a custom
 *  agent (`AcpAgentInfo.model_provider_api_types`); omitting it means the
 *  caller has no list, and a remembered custom-agent choice is treated as
 *  available — the save path still validates it. */
export function isRememberedAgentModelSelectionAvailable(
  agentType: AgentType,
  selection: RememberedAgentModelSelection,
  records: readonly ModelProviderRecord[],
  customApiTypes?: readonly ModelProviderApiType[]
): boolean {
  const supportedApis = new Set(
    getModelProviderApiTypes(
      agentType,
      customApiTypes ??
        (isCustomAgentType(agentType)
          ? ["openai-completions", "openai-responses", "anthropic-messages"]
          : [])
    )
  )
  const record = records.find((r) => r.providerId === selection.providerId)
  return (
    record != null &&
    record.enabled &&
    supportedApis.has(record.api) &&
    record.models.some((m) => m.id === selection.modelId)
  )
}
