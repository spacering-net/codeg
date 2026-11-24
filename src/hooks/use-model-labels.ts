"use client"

import { useCallback, useMemo, useSyncExternalStore } from "react"
import { getModelLabels, subscribeModelLabels } from "@/lib/model-label-store"

/** Turns a raw model id into what the agent calls it, or hands the id back
 *  unchanged. `null`/empty in, `null` out — callers use that to drop the chip
 *  entirely rather than render an empty one. */
export type ModelLabelResolver = (
  model: string | null | undefined
) => string | null

/**
 * Resolve this agent's model ids to the names it advertises over ACP.
 *
 * Reads the per-agent labels [`rememberModelLabels`] captured from a live
 * connection's `config_options`, so a transcript that only ever recorded an
 * opaque key (qoder writes `qfmodel`, never `Qwen3.8-Flash`) renders the same
 * string the composer's model selector shows. An id nothing has named yet is
 * returned verbatim — the raw id is a worse label but never a wrong one.
 */
export function useModelLabels(
  agentType: string | null | undefined
): ModelLabelResolver {
  const getSnapshot = useCallback(
    () => (agentType ? getModelLabels(agentType) : null),
    [agentType]
  )
  const labels = useSyncExternalStore(
    subscribeModelLabels,
    getSnapshot,
    getSnapshot
  )
  return useMemo<ModelLabelResolver>(
    () => (model) => (model ? (labels?.get(model) ?? model) : null),
    [labels]
  )
}
