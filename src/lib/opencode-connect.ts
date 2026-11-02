/**
 * Pure model for OpenCode 2's providers, as codeg's settings manage them.
 *
 * OpenCode 2 splits a provider in two:
 *  - its **credentials** live in OpenCode's own credential store (a table in
 *    `opencode.db`), which codeg reads and writes only through OpenCode
 *    (`opencodeListIntegrations` / `opencodeConnectKey` /
 *    `opencodeDisconnectProvider`); no secret ever reaches the frontend.
 *    `auth.json` is read once, when OpenCode 2 first upgrades a 1.x database.
 *  - its **definition** lives in the config file under `providers.<id>`:
 *    `name`, `package` (an AI SDK package as `aisdk:<npm>`, or a native
 *    `@opencode/ai/…` entry point), `settings` (`baseURL`, …), `models`.
 *    A models.dev provider needs no block at all; one with only `settings`
 *    overrides its endpoint.
 *
 * OpenCode 2 still accepts 1.x's `provider.<id>` blocks (`npm`, `options`,
 * `api`), normalizing them in memory when it loads the file. codeg reads both
 * shapes and edits a block in the shape it is in, writing new blocks in 2.x's
 * shape: converting a 1.x block would have to reproduce OpenCode's migration
 * exactly, and a native block of the same id makes OpenCode ignore the 1.x one
 * entirely, so a partial conversion would lose settings.
 *
 * Enabling and disabling a provider is a `policies` rule (`provider.use`),
 * which 2.x evaluates last-match-wins within a document, defaulting to allow;
 * 1.x's `enabled_providers` / `disabled_providers` become rules placed first.
 *
 * Every function here is pure. The `apply*` / `set*` / `remove*` ones mutate a
 * parsed config object (a draft inside `patchJsoncText`), so the caller writes
 * only the keys that changed back to the user's file.
 */

import type {
  OpenCodeCatalogProvider,
  OpenCodeFormField,
  OpenCodeIntegration,
  OpenCodeIntegrationMethod,
  ProviderModelsProtocol,
} from "./types"

type JsonObject = Record<string, unknown>

export const DEFAULT_OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible"

/** How a provider built on the AI SDK package `npm` lists its models, or
 *  `null` for one that lists none with a key (Azure deployments, Bedrock and
 *  Vertex sign their own requests). */
export function openCodeModelsProtocol(
  npm: string
): ProviderModelsProtocol | null {
  switch (npm.trim()) {
    case "@ai-sdk/anthropic":
      return "anthropic"
    case "@ai-sdk/google":
      return "gemini"
    case "@ai-sdk/azure":
    case "@ai-sdk/amazon-bedrock":
    case "@ai-sdk/google-vertex":
      return null
    default:
      return "openai"
  }
}

const AISDK_PREFIX = "aisdk:"

/** OpenCode 2's `package` for an npm package: AI SDK packages load through
 *  the `aisdk:` prefix (`core/src/provider.ts`), native `@opencode/ai/…`
 *  entry points as they are. */
export function packageForNpm(npm: string): string {
  const name = npm.trim()
  if (
    !name ||
    name.startsWith(AISDK_PREFIX) ||
    name.startsWith("@opencode/ai/")
  )
    return name
  return `${AISDK_PREFIX}${name}`
}

/** The npm package a `package` names, for display and model listing. */
export function npmOfPackage(pkg: string): string {
  const name = pkg.trim()
  return name.startsWith(AISDK_PREFIX) ? name.slice(AISDK_PREFIX.length) : name
}

const PROVIDER_ID_PATTERN = /^[A-Za-z0-9_.-]+$/

/** Why a proposed custom-provider id is invalid, or null when it's acceptable. */
export type CustomProviderIdIssue = "pattern" | "exists" | "in-catalog"

/**
 * Validate an id for a NEW custom provider. A catalog id is rejected with
 * "in-catalog": those connect through the catalog dialog. NOTE: when
 * `catalogIds` is empty (catalog still loading or failed) the "in-catalog"
 * check cannot fire — callers must gate the custom dialog on catalog readiness.
 */
export function customProviderIdIssue(params: {
  id: string
  existingProviderIds: string[]
  catalogIds: string[]
}): CustomProviderIdIssue | null {
  const id = params.id.trim()
  if (!id) return null
  if (!PROVIDER_ID_PATTERN.test(id)) return "pattern"
  if (params.existingProviderIds.includes(id)) return "exists"
  if (params.catalogIds.includes(id)) return "in-catalog"
  return null
}

/** Compact context-window label, e.g. 200000 → "200K", 1000000 → "1M". */
export function formatContextWindow(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return ""
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`
  return String(tokens)
}

// ─── JSON helpers ───

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null
}

function str(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((x): x is string => typeof x === "string")
    : []
}

/** Delete `key` from `parent`, then `parent` from `grandparent` when that left
 *  it empty. */
function deleteAndPrune(
  grandparent: JsonObject,
  parentKey: string,
  key: string
): void {
  const parent = asObject(grandparent[parentKey])
  if (!parent) return
  delete parent[key]
  if (Object.keys(parent).length === 0) delete grandparent[parentKey]
}

// ─── Provider blocks in the config ───

export type OpenCodeProviderShape = "native" | "legacy"

export interface OpenCodeProviderModelView {
  id: string
  name: string
  disabled: boolean
  /** Keys besides `name` (and 2.x's `modelID` alias), kept as they are. */
  extraFieldCount: number
}

export interface OpenCodeProviderBlock {
  id: string
  /** `providers.<id>` (OpenCode 2) or 1.x's `provider.<id>`. */
  shape: OpenCodeProviderShape
  name: string
  /** The npm package, without 2.x's `aisdk:` prefix. */
  npm: string
  baseUrl: string
  modelIds: string[]
  models: Record<string, OpenCodeProviderModelView>
}

function modelViews(
  block: JsonObject
): Record<string, OpenCodeProviderModelView> {
  const models = asObject(block.models) ?? {}
  const views: Record<string, OpenCodeProviderModelView> = {}
  for (const [id, raw] of Object.entries(models)) {
    const model = asObject(raw) ?? {}
    views[id] = {
      id,
      name: str(model.name),
      disabled: model.disabled === true,
      extraFieldCount: Object.keys(model).filter(
        (key) => key !== "name" && key !== "modelID" && key !== "id"
      ).length,
    }
  }
  return views
}

function nativeView(id: string, block: JsonObject): OpenCodeProviderBlock {
  const models = modelViews(block)
  return {
    id,
    shape: "native",
    name: str(block.name),
    npm: npmOfPackage(str(block.package)),
    baseUrl: str(asObject(block.settings)?.baseURL),
    modelIds: Object.keys(models),
    models,
  }
}

function legacyView(id: string, block: JsonObject): OpenCodeProviderBlock {
  const models = modelViews(block)
  const options = asObject(block.options)
  return {
    id,
    shape: "legacy",
    name: str(block.name),
    npm: str(block.npm),
    // 1.x's `api` is a base URL too; OpenCode 2 migrates it to
    // `settings.baseURL` (`v1/config/migrate.ts`).
    baseUrl: str(options?.baseURL) || str(block.api),
    modelIds: Object.keys(models),
    models,
  }
}

/** Every provider block the config declares, keyed by id. Where both shapes
 *  name the same id, OpenCode uses the 2.x block and ignores the 1.x one, and
 *  so does this. */
export function readProviderBlocks(
  config: JsonObject
): Record<string, OpenCodeProviderBlock> {
  const blocks: Record<string, OpenCodeProviderBlock> = {}
  for (const [id, raw] of Object.entries(asObject(config.provider) ?? {})) {
    const block = asObject(raw)
    if (block) blocks[id] = legacyView(id, block)
  }
  for (const [id, raw] of Object.entries(asObject(config.providers) ?? {})) {
    const block = asObject(raw)
    if (block) blocks[id] = nativeView(id, block)
  }
  return blocks
}

/** The block to edit for `id`: the 2.x one when present, else the 1.x one,
 *  else a new 2.x block (created in `config`). */
export function providerBlockForEdit(
  config: JsonObject,
  id: string
): { block: JsonObject; shape: OpenCodeProviderShape } {
  const native = asObject(asObject(config.providers)?.[id])
  if (native) return { block: native, shape: "native" }
  const legacy = asObject(asObject(config.provider)?.[id])
  if (legacy) return { block: legacy, shape: "legacy" }
  const root = asObject(config.providers) ?? {}
  const block: JsonObject = {}
  root[id] = block
  config.providers = root
  return { block, shape: "native" }
}

export function setProviderBlockName(block: JsonObject, name: string): void {
  if (name.trim()) block.name = name
  else delete block.name
}

export function setProviderBlockNpm(
  block: JsonObject,
  shape: OpenCodeProviderShape,
  npm: string
): void {
  const key = shape === "native" ? "package" : "npm"
  const value = shape === "native" ? packageForNpm(npm) : npm.trim()
  if (value) block[key] = value
  else delete block[key]
}

export function setProviderBlockBaseUrl(
  block: JsonObject,
  shape: OpenCodeProviderShape,
  baseUrl: string
): void {
  const url = baseUrl.trim()
  const containerKey = shape === "native" ? "settings" : "options"
  if (shape === "legacy") delete block.api
  if (url) {
    const container = asObject(block[containerKey]) ?? {}
    container.baseURL = url
    block[containerKey] = container
  } else {
    deleteAndPrune(block, containerKey, "baseURL")
  }
}

/** The `models` map of a block, created when missing. */
export function providerBlockModels(block: JsonObject): JsonObject {
  const models = asObject(block.models) ?? {}
  block.models = models
  return models
}

// ─── Models ───

/** A model selection as OpenCode 2 accepts it (`provider/model#variant` or
 *  `{providerID, model, variant}`), as the short string. */
export function modelSelectionText(value: unknown): string {
  if (typeof value === "string") return value.trim()
  const object = asObject(value)
  if (!object) return ""
  const provider = str(object.providerID).trim()
  const model = str(object.model).trim()
  if (!provider || !model) return ""
  const variant = str(object.variant).trim()
  return `${provider}/${model}${variant ? `#${variant}` : ""}`
}

/** Whether a model selection targets the given provider. */
export function modelReferencesProvider(
  model: unknown,
  providerId: string
): boolean {
  const text = modelSelectionText(model)
  return text === providerId || text.startsWith(`${providerId}/`)
}

const LEGACY_SMALL_MODEL_KEYS = ["small_model", "smallModel", "small-model"]

export function readMainModel(config: JsonObject): string {
  return modelSelectionText(config.model)
}

export function setMainModel(config: JsonObject, value: string): void {
  const trimmed = value.trim()
  if (trimmed) config.model = trimmed
  else delete config.model
}

/** OpenCode 2's small model is the `title` agent's model; 1.x's `small_model`
 *  is normalized into it, losing to `agents.title.model` when both are set. */
export function readSmallModel(config: JsonObject): string {
  const native = modelSelectionText(
    asObject(asObject(config.agents)?.title)?.model
  )
  if (native) return native
  for (const key of LEGACY_SMALL_MODEL_KEYS) {
    const legacy = modelSelectionText(config[key])
    if (legacy) return legacy
  }
  return ""
}

export function setSmallModel(config: JsonObject, value: string): void {
  for (const key of LEGACY_SMALL_MODEL_KEYS) delete config[key]
  const trimmed = value.trim()
  const agents = asObject(config.agents) ?? {}
  const title = asObject(agents.title) ?? {}
  if (trimmed) {
    title.model = trimmed
    agents.title = title
    config.agents = agents
    return
  }
  delete title.model
  if (Object.keys(title).length === 0) delete agents.title
  if (Object.keys(agents).length === 0) delete config.agents
}

// ─── Enabling and disabling (policies) ───

interface PolicyRule {
  action: string
  resource: string
  effect: string
}

function policyRules(value: unknown): PolicyRule[] {
  return Array.isArray(value)
    ? value
        .map(asObject)
        .filter((rule): rule is JsonObject => rule !== null)
        .map((rule) => ({
          action: str(rule.action),
          resource: str(rule.resource),
          effect: str(rule.effect),
        }))
    : []
}

/** OpenCode's `Wildcard.match` (`core/src/util/wildcard.ts`): `*` and `?`,
 *  anchored, a trailing ` *` also matching the bare command. */
export function opencodeWildcardMatch(input: string, pattern: string): boolean {
  let escaped = pattern
    .replace(/\\/g, "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)}( .*)?`
  return new RegExp(`^${escaped}$`, "s").test(input.replace(/\\/g, "/"))
}

/** A 1.x provider id as OpenCode 2 runs it: the provider lists and the main
 *  model name the renamed provider (`providerID` in
 *  `core/src/v1/config/migrate.ts`). `policies` are taken as written. */
function migratedProviderId(id: string): string {
  if (id === "azure-cognitive-services") return "azure"
  if (id === "google-vertex-anthropic") return "google-vertex"
  return id
}

/** The provider a row stands for at run time. A 1.x `provider` block under a
 *  retired id configures the renamed provider, while a native `providers`
 *  block keeps its key (`migrateProviders` in `core/src/config/normalize.ts`
 *  renames only the former); a row with no block is OpenCode's own id. */
function runtimeProviderId(config: JsonObject, id: string): string {
  if (asObject(asObject(config.providers)?.[id])) return id
  if (asObject(asObject(config.provider)?.[id])) return migratedProviderId(id)
  return id
}

/** The `provider.use` rules a document holds, in OpenCode's order: the ones
 *  1.x's provider lists turn into first, then `experimental.policies`, then
 *  `policies` (`core/src/config/normalize.ts`). An `enabled_providers` list
 *  that is present but empty allows nothing. */
function providerUseRules(config: JsonObject): PolicyRule[] {
  const rules: PolicyRule[] = []
  if (Array.isArray(config.enabled_providers)) {
    const enabled = stringArray(config.enabled_providers)
    if (config.enabled_providers.length === 0 || enabled.length > 0) {
      rules.push({ action: "provider.use", resource: "*", effect: "deny" })
      for (const id of enabled)
        rules.push({
          action: "provider.use",
          resource: migratedProviderId(id),
          effect: "allow",
        })
    }
  }
  for (const id of stringArray(config.disabled_providers))
    rules.push({
      action: "provider.use",
      resource: migratedProviderId(id),
      effect: "deny",
    })
  rules.push(...policyRules(asObject(config.experimental)?.policies))
  rules.push(...policyRules(config.policies))
  return rules.filter((rule) => rule.action === "provider.use")
}

/** Whether this config lets OpenCode use the provider: the last matching
 *  `provider.use` rule decides, and no rule means allowed. Asked of the
 *  provider the row stands for at run time (`runtimeProviderId`). */
export function isProviderEnabled(config: JsonObject, id: string): boolean {
  const runtimeId = runtimeProviderId(config, id)
  const rules = providerUseRules(config)
  for (let i = rules.length - 1; i >= 0; i--) {
    if (opencodeWildcardMatch(runtimeId, rules[i].resource))
      return rules[i].effect !== "deny"
  }
  return true
}

/** Drop every rule naming exactly `id`, and `id` from 1.x's lists. */
function forgetProviderRules(config: JsonObject, id: string): void {
  if (Array.isArray(config.policies)) {
    const kept = config.policies.filter((raw) => {
      const rule = asObject(raw)
      return !(rule && rule.action === "provider.use" && rule.resource === id)
    })
    if (kept.length > 0) config.policies = kept
    else delete config.policies
  }
  const named = (x: unknown) =>
    typeof x === "string" && migratedProviderId(x) === id
  if (Array.isArray(config.disabled_providers)) {
    const next = config.disabled_providers.filter((x) => !named(x))
    if (next.length > 0) config.disabled_providers = next
    else delete config.disabled_providers
  }
  // An allow-list keeps restricting once `id` leaves it: emptied, it allows
  // nothing, which is what it allowed besides `id`.
  if (Array.isArray(config.enabled_providers))
    config.enabled_providers = config.enabled_providers.filter((x) => !named(x))
}

/** Let OpenCode use the provider or not, as a `policies` rule. Rules naming
 *  exactly this provider are replaced; one is added only when the remaining
 *  rules would decide otherwise. The rules are those of the provider the row
 *  stands for at run time (`runtimeProviderId`): for a 1.x block under a
 *  retired id, a rule naming the old id would match nothing. */
export function setProviderEnabled(
  config: JsonObject,
  id: string,
  enabled: boolean
): void {
  const runtimeId = runtimeProviderId(config, id)
  forgetProviderRules(config, runtimeId)
  if (isProviderEnabled(config, id) === enabled) return
  const policies = Array.isArray(config.policies) ? config.policies : []
  policies.push({
    action: "provider.use",
    resource: runtimeId,
    effect: enabled ? "allow" : "deny",
  })
  config.policies = policies
}

// ─── Writing providers ───

export interface CustomProviderInput {
  id: string
  name?: string
  npm?: string
  baseUrl?: string
  modelIds?: string[]
}

/** Declare (or update) a custom provider. A new block is written in 2.x's
 *  shape; an existing one keeps its shape. The key is connected separately,
 *  after this is saved: OpenCode only knows the integration once its config
 *  declares it. */
export function applyCustomProvider(
  config: JsonObject,
  input: CustomProviderInput
): void {
  const id = input.id.trim()
  if (!id) throw new Error("provider id is required")
  const { block, shape } = providerBlockForEdit(config, id)
  const name =
    input.name?.trim() ||
    (typeof block.name === "string" ? block.name : "") ||
    id
  setProviderBlockName(block, name)
  const currentNpm =
    shape === "native" ? npmOfPackage(str(block.package)) : str(block.npm)
  setProviderBlockNpm(
    block,
    shape,
    input.npm?.trim() || currentNpm || DEFAULT_OPENAI_COMPATIBLE_NPM
  )
  if (input.baseUrl?.trim())
    setProviderBlockBaseUrl(block, shape, input.baseUrl)
  const models = providerBlockModels(block)
  for (const raw of input.modelIds ?? []) {
    const modelId = raw.trim()
    if (modelId && !asObject(models[modelId]))
      models[modelId] = { name: modelId }
  }
}

/**
 * Set or clear the base URL override of a models.dev provider. `undefined`
 * leaves it alone (reconnecting with a new key must not drop it), `""` clears
 * it, anything else sets it. A block left with nothing in it is removed.
 */
export function setWellKnownBaseUrl(
  config: JsonObject,
  id: string,
  baseUrl: string | undefined
): void {
  if (baseUrl === undefined) return
  const hadBlock =
    Boolean(asObject(asObject(config.providers)?.[id])) ||
    Boolean(asObject(asObject(config.provider)?.[id]))
  if (!baseUrl.trim() && !hadBlock) return
  const { block, shape } = providerBlockForEdit(config, id)
  setProviderBlockBaseUrl(block, shape, baseUrl)
  if (Object.keys(block).length === 0) {
    deleteAndPrune(config, shape === "native" ? "providers" : "provider", id)
  }
}

/**
 * Forget a provider in the config: its block in either shape, the rules that
 * name it, and model selections pointing at it (which would otherwise name a
 * provider OpenCode no longer has). Its credentials are removed separately,
 * through OpenCode.
 */
export function removeProviderFromConfig(config: JsonObject, id: string): void {
  const runtimeId = runtimeProviderId(config, id)
  deleteAndPrune(config, "providers", id)
  deleteAndPrune(config, "provider", id)
  forgetProviderRules(config, runtimeId)
  if (modelReferencesProvider(config.model, id)) delete config.model
  if (modelReferencesProvider(readSmallModel(config), id))
    setSmallModel(config, "")
}

// ─── Integrations (OpenCode's own view of how providers connect) ───

/** The method that stores an API key, when the integration has one. */
export function keyMethodOf(
  integration: OpenCodeIntegration
): OpenCodeIntegrationMethod | null {
  return integration.methods.find((method) => method.type === "key") ?? null
}

/** The fields a key method asks for besides the key, that a person answers.
 *  Hidden fields take OpenCode's default unless answered. */
export function visibleKeyFields(
  method: OpenCodeIntegrationMethod | null
): OpenCodeFormField[] {
  return (method?.form ?? []).filter(
    (field) => !field.hidden && field.type !== "external"
  )
}

/** Integrations an API key connects, by name. */
export function keyConnectableIntegrations(
  integrations: OpenCodeIntegration[]
): OpenCodeIntegration[] {
  return integrations
    .filter((integration) => keyMethodOf(integration) !== null)
    .sort(
      (a, b) =>
        a.name.toLowerCase().localeCompare(b.name.toLowerCase()) ||
        a.id.localeCompare(b.id)
    )
}

export type OpenCodeConnectionKind =
  | "key"
  | "oauth"
  | "external"
  | "env"
  | "none"

// ─── The panel's view ───

export interface OpenCodeConnectedProvider {
  id: string
  /** Display name: config `name` › OpenCode's › the catalog's › id. */
  name: string
  /** How OpenCode connects it: the connection it uses, or "none". */
  connection: OpenCodeConnectionKind
  /** For an environment connection, the variable's name. */
  envName: string | null
  /** Credentials OpenCode stores for it (the ones disconnect removes). */
  credentialCount: number
  /** A problem OpenCode reported for the connection it uses. */
  statusMessage: string | null
  /** Whether this config lets OpenCode use it (`policies`). */
  enabled: boolean
  /** Whether models.dev lists it (custom providers are the ones it doesn't). */
  inCatalog: boolean
  /** Whether the config declares a block for it. */
  hasConfigBlock: boolean
  shape: OpenCodeProviderShape | null
  baseUrl: string
  npm: string
  modelIds: string[]
  disabledModelIds: string[]
}

function connectionKindOf(integration: OpenCodeIntegration | undefined): {
  kind: OpenCodeConnectionKind
  envName: string | null
} {
  const active = integration?.connections[0]
  if (!active) return { kind: "none", envName: null }
  if (active.type === "env")
    return { kind: "env", envName: active.name ?? null }
  const method = active.method
  return {
    kind: method === "oauth" || method === "external" ? method : "key",
    envName: null,
  }
}

/**
 * The providers OpenCode is connected to — every integration with a
 * connection, the way `opencode auth list` filters them — plus the providers
 * the config declares, which OpenCode lists whether or not they have a key.
 */
export function buildConnectedProviders(params: {
  config: JsonObject
  integrations: OpenCodeIntegration[]
  catalog: OpenCodeCatalogProvider[]
}): OpenCodeConnectedProvider[] {
  const blocks = readProviderBlocks(params.config)
  const integrationById = new Map(params.integrations.map((i) => [i.id, i]))
  const catalogById = new Map(params.catalog.map((p) => [p.id, p]))
  const ids = new Set<string>(Object.keys(blocks))
  for (const integration of params.integrations) {
    if (integration.connections.length > 0) ids.add(integration.id)
  }

  const result: OpenCodeConnectedProvider[] = []
  for (const id of ids) {
    const block = blocks[id]
    const integration = integrationById.get(id)
    const { kind, envName } = connectionKindOf(integration)
    result.push({
      id,
      name: block?.name || integration?.name || catalogById.get(id)?.name || id,
      connection: kind,
      envName,
      credentialCount:
        integration?.connections.filter((c) => c.type === "credential")
          .length ?? 0,
      statusMessage: integration?.connections[0]?.status?.message ?? null,
      enabled: isProviderEnabled(params.config, id),
      inCatalog: catalogById.has(id),
      hasConfigBlock: Boolean(block),
      shape: block?.shape ?? null,
      baseUrl: block?.baseUrl ?? "",
      npm: block?.npm ?? "",
      modelIds: block?.modelIds ?? [],
      disabledModelIds: Object.values(block?.models ?? {})
        .filter((model) => model.disabled)
        .map((model) => model.id),
    })
  }
  result.sort(
    (a, b) =>
      a.name.toLowerCase().localeCompare(b.name.toLowerCase()) ||
      a.id.localeCompare(b.id)
  )
  return result
}

export interface OpenCodeModelOption {
  value: string
  label: string
  /** Context window (tokens) from the catalog, when known. */
  context?: number | null
  /** Whether the model is a reasoning model, from the catalog. */
  reasoning?: boolean
}

export interface OpenCodeModelOptionGroup {
  providerId: string
  label: string
  models: OpenCodeModelOption[]
}

/**
 * Model picker options: enabled connected providers, each offering its catalog
 * models unioned with the models its config block declares. Values are
 * `provider/model-id`, OpenCode's model selection.
 */
export function buildConnectedModelOptions(params: {
  connected: OpenCodeConnectedProvider[]
  catalog: OpenCodeCatalogProvider[]
}): OpenCodeModelOptionGroup[] {
  const catalogById = new Map(params.catalog.map((p) => [p.id, p]))
  const groups: OpenCodeModelOptionGroup[] = []
  for (const provider of params.connected) {
    if (!provider.enabled) continue
    const catalog = catalogById.get(provider.id)
    const metaById = new Map(catalog?.models.map((m) => [m.id, m]) ?? [])
    const ids = new Set<string>(provider.modelIds)
    if (catalog) for (const model of catalog.models) ids.add(model.id)
    for (const modelId of provider.disabledModelIds) ids.delete(modelId)
    if (ids.size === 0) continue
    groups.push({
      providerId: provider.id,
      label: provider.name,
      models: Array.from(ids)
        .sort()
        .map((modelId) => {
          const meta = metaById.get(modelId)
          return {
            value: `${provider.id}/${modelId}`,
            label: `${provider.id}/${modelId}`,
            context: meta?.context ?? null,
            reasoning: meta?.reasoning ?? false,
          }
        }),
    })
  }
  return groups
}
