"use client"

import { createContext, useContext } from "react"
import type { ModelLabelResolver } from "@/hooks/use-model-labels"

/**
 * The transcript's model-id → display-name resolver, provided once by
 * `MessageListView` (which knows the agent) and read by whatever renders a
 * model deep inside the thread.
 *
 * A context rather than a prop because `HistoricalMessageGroup` sits between
 * the two and is memoized on a prop set that deliberately excludes the agent —
 * threading one more value through it would widen that memo for a string it
 * never reads itself.
 */
const ModelLabelContext = createContext<ModelLabelResolver | null>(null)

export const ModelLabelProvider = ModelLabelContext.Provider

/** Stable identity resolver for surfaces with no provider above them. */
const passThrough: ModelLabelResolver = (model) => model ?? null

/** Never null: an embed that never learned its agent (and every component test)
 *  simply renders the raw id, which is what it did before this existed. */
export function useModelLabel(): ModelLabelResolver {
  return useContext(ModelLabelContext) ?? passThrough
}
