"use client"

import { useMemo } from "react"
import { useTranslations } from "next-intl"

import {
  localizeConfigOption,
  localizeConfigOptionLabel,
  localizeConfigOptions,
  localizeConfigValueLabel,
  localizeModeLabel,
  localizePermissionOptions,
  localizeSessionModes,
} from "@/lib/agent-label-vocabulary"
import type {
  AgentType,
  PermissionOptionInfo,
  SessionConfigOptionInfo,
  SessionModeInfo,
} from "@/lib/types"

/**
 * Render-time localisation of the vocabulary an agent advertises over ACP —
 * see `lib/agent-label-vocabulary` for why this exists and what it refuses to
 * touch.
 *
 * Render time, not ingest time: selection, persistence and every callback run
 * on ids, so rewriting the display strings on the way out changes nothing the
 * app reasons about, and a locale switch takes effect without re-probing the
 * agent. The underlying helpers return their input unchanged when nothing is
 * rewritten, so passing a memoised array through here keeps its identity.
 */
export function useAgentVocabulary(agentType: AgentType | null | undefined) {
  const t = useTranslations("AgentVocabulary")
  return useMemo(
    () => ({
      modes: (modes: SessionModeInfo[]) =>
        localizeSessionModes(agentType, modes, t),
      modeLabel: (modeId: string, fallback: string) =>
        localizeModeLabel(agentType, modeId, fallback, t),
      configOptions: (options: SessionConfigOptionInfo[]) =>
        localizeConfigOptions(agentType, options, t),
      configOption: (option: SessionConfigOptionInfo) =>
        localizeConfigOption(agentType, option, t),
      configOptionLabel: (configId: string, fallback: string) =>
        localizeConfigOptionLabel(agentType, configId, fallback, t),
      configValueLabel: (
        configId: string,
        valueId: string | null | undefined,
        fallback: string
      ) => localizeConfigValueLabel(agentType, configId, valueId, fallback, t),
      permissionOptions: (options: PermissionOptionInfo[]) =>
        localizePermissionOptions(agentType, options, t),
    }),
    [agentType, t]
  )
}
