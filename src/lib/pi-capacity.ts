/**
 * Context-window / max-output capacity for a Pi model, derived when the user
 * picks a model id or adds one to a custom provider's model list.
 *
 * Source priority (the user's choice): the provider's own listing first, then
 * the litellm model catalogue:
 *  - `contextWindow`: the provider's `ListedProviderModel.contextWindow`, else
 *    the catalogue's `maxInputTokens`.
 *  - `maxTokens`: provider listings do not carry an output cap, so this always
 *    comes from the catalogue's `maxOutputTokens`.
 *
 * Both values must be positive integers; a missing/invalid value is left
 * undefined so the caller does not write a bogus 0 into `models.json` (pi
 * treats 0 as an unusable definition). A partial result is normal — only one
 * of the two sources may know a given model.
 */

import type { ListedProviderModel, ModelCatalogEntry } from "@/lib/types"

export interface PiModelCapacity {
  contextWindow?: number
  maxTokens?: number
}

function positive(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined
}

/** Resolve a model id against the provider's listed models (case-insensitive,
 *  exact id match). Providers list ids without a provider prefix, so compare
 *  both the raw id and its last `/` segment. */
function listedModel(
  models: readonly ListedProviderModel[] | null | undefined,
  modelId: string
): ListedProviderModel | undefined {
  if (!models || !modelId.trim()) return undefined
  const target = modelId.trim()
  const short = target.includes("/")
    ? target.slice(target.lastIndexOf("/") + 1)
    : target
  const lower = (value: string) => value.trim().toLowerCase()
  return models.find(
    (m) => lower(m.id) === lower(target) || lower(m.id) === lower(short)
  )
}

/** Resolve a model id against the litellm catalogue. The catalogue entry `model`
 *  is the unprefixed id; `id` carries the `provider/` prefix. */
function catalogEntry(
  entries: readonly ModelCatalogEntry[] | null | undefined,
  modelId: string
): ModelCatalogEntry | undefined {
  if (!entries || !modelId.trim()) return undefined
  const target = modelId.trim()
  const short = target.includes("/")
    ? target.slice(target.lastIndexOf("/") + 1)
    : target
  const lower = (value: string) => value.trim().toLowerCase()
  return entries.find(
    (entry) =>
      lower(entry.model) === lower(short) || lower(entry.id) === lower(target)
  )
}

/** The capacity to auto-fill for `modelId`: provider first, litellm second. */
export function piModelCapacity(
  modelId: string,
  listed: readonly ListedProviderModel[] | null | undefined,
  catalog: readonly ModelCatalogEntry[] | null | undefined
): PiModelCapacity {
  const fromProvider = listedModel(listed, modelId)
  const fromCatalog = catalogEntry(catalog, modelId)

  const contextWindow =
    positive(fromProvider?.contextWindow) ??
    positive(fromCatalog?.maxInputTokens)
  const maxTokens = positive(fromCatalog?.maxOutputTokens)

  const capacity: PiModelCapacity = {}
  if (contextWindow !== undefined) capacity.contextWindow = contextWindow
  if (maxTokens !== undefined) capacity.maxTokens = maxTokens
  return capacity
}
