/**
 * The catalog's answers, made safe to render.
 *
 * The backend passes the API's JSON through as it came. That keeps new fields
 * flowing to a newer frontend without a backend release — and means nothing
 * between the catalog and a component has checked that an array is an array.
 * These functions do: each returns the shape the types promise, with every
 * field a component reads present and of the right type, so that a missing
 * `tags` or a `findings` that is not a list costs one blank row rather than
 * the page.
 *
 * Nothing is thrown away: unknown fields are carried over, and a string that
 * is not one of the values this build knows (a new kind, a new status) is
 * kept as it is, for the display helpers to call "unknown".
 */
import { accessOf } from "./assistant"
import { HarnessClientError } from "./errors"
import { isItemRef } from "./item-ref"
import {
  HARNESS_PERMISSION_KEYS,
  type HarnessAccess,
  type HarnessAssistantExample,
  type HarnessAssistantInfo,
  type HarnessConfig,
  type HarnessFileEntry,
  type HarnessFinding,
  type HarnessItemDetail,
  type HarnessItemList,
  type HarnessItemSummary,
  type HarnessLocalized,
  type HarnessPermissions,
  type HarnessPinnedPackage,
  type HarnessPromptInfo,
  type HarnessShowcase,
  type HarnessStatus,
  type HarnessVersionSummary,
  type SrnAsset,
} from "./types"

type Json = Record<string, unknown>

function record(value: unknown): Json | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : null
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function countOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function texts(value: unknown): string[] {
  return list(value).filter(
    (entry): entry is string => typeof entry === "string"
  )
}

function records(value: unknown): Json[] {
  return list(value)
    .map(record)
    .filter((entry): entry is Json => entry !== null)
}

function localized(value: unknown): HarnessLocalized {
  const source = record(value)
  const out: HarnessLocalized = {}
  if (typeof source?.en === "string") out.en = source.en
  if (typeof source?.zh === "string") out.zh = source.zh
  return out
}

function invalid(what: string): HarnessClientError {
  return new HarnessClientError(
    "invalidResponse",
    `Harness: ${what} is not in the expected shape`
  )
}

function permissions(value: unknown): HarnessPermissions {
  const source = record(value) ?? {}
  const out = { ...source } as Json
  for (const key of HARNESS_PERMISSION_KEYS) out[key] = texts(source[key])
  return out as HarnessPermissions
}

/** A publisher's declaration: only the rows it actually made. A row left out
 *  means "said nothing", which is not the same as an empty one. */
function declaredPermissions(value: unknown): Partial<HarnessPermissions> {
  const source = record(value) ?? {}
  const out: Json = {}
  for (const key of HARNESS_PERMISSION_KEYS) {
    if (Array.isArray(source[key])) out[key] = texts(source[key])
  }
  return out as Partial<HarnessPermissions>
}

function latestOf(value: unknown): HarnessItemSummary["latest"] {
  const source = record(value) ?? {}
  return {
    ...source,
    revision: count(source.revision),
    version: textOrNull(source.version),
    publishedAt: text(source.publishedAt),
  }
}

/**
 * One item of a list, or `null` for an entry that cannot be shown at all: not
 * an object, or with no address the commands would take. Everything else is
 * filled in.
 */
export function normalizeItemSummary(
  value: unknown
): HarnessItemSummary | null {
  const source = record(value)
  if (!source || !isItemRef(source.ref)) return null
  const ref = source.ref
  const [publisherHandle, refName] = ref.split("/")
  const publisher = record(source.publisher) ?? {}
  const handle = text(publisher.handle) || publisherHandle
  return {
    ...source,
    id: text(source.id) || ref,
    ref,
    name: text(source.name) || refName,
    kind: text(source.kind),
    status: text(source.status),
    title: localized(source.title),
    summary: localized(source.summary),
    publisher: {
      ...publisher,
      handle,
      name: text(publisher.name) || handle,
      kind: text(publisher.kind),
      verified: publisher.verified === true,
      unclaimed: publisher.unclaimed === true,
      avatar: textOrNull(publisher.avatar),
    },
    tags: texts(source.tags),
    runtime: text(source.runtime),
    risk: text(source.risk),
    reviewed: source.reviewed === true,
    featured: source.featured === true,
    source: text(source.source),
    repoStars: countOrNull(source.repoStars),
    stars: count(source.stars),
    installs: count(source.installs),
    latest: latestOf(source.latest),
    // The two card extras are only ever read through optional chaining, and
    // only for a string each; anything that is not an object is dropped.
    prompt: (record(source.prompt) ??
      undefined) as HarnessItemSummary["prompt"],
    assistant: (record(source.assistant) ??
      undefined) as HarnessItemSummary["assistant"],
  }
}

/** `harness_list`'s answer. Entries that cannot be shown are left out. */
export function normalizeItemList(value: unknown): HarnessItemList {
  const source = record(value)
  if (!source || !Array.isArray(source.items)) throw invalid("the item list")
  return {
    ...source,
    items: source.items
      .map(normalizeItemSummary)
      .filter((item): item is HarnessItemSummary => item !== null),
    next: textOrNull(source.next),
    approxTotal: countOrNull(source.approxTotal),
  }
}

function finding(source: Json): HarnessFinding {
  return {
    ...source,
    check: text(source.check),
    severity: text(source.severity),
    path: textOrNull(source.path) ?? undefined,
    line: countOrNull(source.line) ?? undefined,
    rule: textOrNull(source.rule) ?? undefined,
    category: textOrNull(source.category) ?? undefined,
  }
}

function fileEntry(source: Json): HarnessFileEntry {
  return {
    ...source,
    path: text(source.path),
    sha256: text(source.sha256),
    size: count(source.size),
    executable: source.executable === true,
  }
}

function pinnedPackage(source: Json): HarnessPinnedPackage {
  return {
    ...source,
    registryType: text(source.registryType),
    identifier: text(source.identifier),
    version: textOrNull(source.version),
    verified: text(source.verified),
    hasInstallScript: source.hasInstallScript === true,
  } as HarnessPinnedPackage
}

function showcase(source: Json): HarnessShowcase {
  const by = record(source.by)
  const name = by ? text(by.name).trim() : ""
  return {
    ...source,
    by: by && name ? { ...by, name, url: textOrNull(by.url) } : null,
    link: textOrNull(source.link),
    cover: textOrNull(source.cover),
    motion: textOrNull(source.motion),
    category: textOrNull(source.category),
    categoryName: record(source.categoryName)
      ? localized(source.categoryName)
      : undefined,
    labels: texts(source.labels),
    at: textOrNull(source.at),
  }
}

/** A prompt's own part of an item. Its text stays exactly as it came: it is
 *  what gets copied. */
function promptInfo(value: unknown): HarnessPromptInfo | undefined {
  const source = record(value)
  if (!source) return undefined
  return {
    ...source,
    text: text(source.text),
    model: textOrNull(source.model),
    argumentHint: textOrNull(source.argumentHint),
    partial: source.partial === true,
    rights: text(source.rights),
    lang: textOrNull(source.lang),
    showcases: records(source.showcases).map(showcase),
  }
}

function example(source: Json): HarnessAssistantExample {
  return {
    ...source,
    context: textOrNull(source.context),
    user: text(source.user),
    assistant: textOrNull(source.assistant),
    commentary: textOrNull(source.commentary),
  }
}

/** A skill an assistant loads: `{ name, ref }`, or a bare name, which is how
 *  a definition itself lists one. A `ref` is kept only if it is an address. */
function assistantSkills(value: unknown): HarnessAssistantInfo["skills"] {
  return list(value).flatMap((entry) => {
    if (typeof entry === "string") {
      return entry.trim() ? [{ name: entry.trim(), ref: null }] : []
    }
    const skill = record(entry)
    const name = skill ? text(skill.name).trim() : ""
    if (!skill || !name) return []
    return [{ ...skill, name, ref: isItemRef(skill.ref) ? skill.ref : null }]
  })
}

/**
 * An assistant's own part of an item.
 *
 * `tools` is a list, or `null` for "not limited". Anything else is read as
 * `null` too: if the catalog cannot be read on the point, saying the assistant
 * may use every tool overstates what it may touch, and the other way round
 * would understate it. What it may touch (`access`) is taken from the catalog
 * where it says, and worked out from the tools where it does not.
 */
function assistantInfo(value: unknown): HarnessAssistantInfo | undefined {
  const source = record(value)
  if (!source) return undefined
  const tools = Array.isArray(source.tools) ? texts(source.tools) : null
  const disallowedTools = texts(source.disallowedTools)
  const derived = accessOf(tools, disallowedTools)
  const stated = record(source.access) ?? {}
  const access = Object.fromEntries(
    (Object.keys(derived) as (keyof HarnessAccess)[]).map((key) => [
      key,
      typeof stated[key] === "boolean" ? stated[key] : derived[key],
    ])
  ) as HarnessAccess
  return {
    ...source,
    name: text(source.name),
    file: text(source.file),
    description: text(source.description),
    model: textOrNull(source.model),
    tools,
    disallowedTools,
    access,
    color: textOrNull(source.color),
    skills: assistantSkills(source.skills),
    mcpServers: texts(source.mcpServers),
    mcpLaunches: texts(source.mcpLaunches),
    permissionMode: textOrNull(source.permissionMode),
    hooks: source.hooks === true,
    starters: texts(source.starters),
    examples: records(source.examples)
      .map(example)
      .filter((entry) => entry.user.trim() || entry.assistant?.trim()),
    vibe: textOrNull(source.vibe),
    emoji: textOrNull(source.emoji),
    settings: record(source.settings) ?? {},
    plugin: textOrNull(source.plugin),
    alsoIn: texts(source.alsoIn),
  }
}

function installInfo(value: unknown): HarnessItemDetail["install"] {
  const source = record(value) ?? {}
  const version = record(source.version) ?? {}
  const repository = record(source.source)
  return {
    ...source,
    version: {
      ...version,
      revision: count(version.revision),
      version: textOrNull(version.version),
      publishedAt: text(version.publishedAt),
      status: text(version.status),
    },
    archive: record(source.archive),
    files: records(source.files).map(fileEntry),
    source: repository
      ? {
          ...repository,
          repository: text(repository.repository),
          commit: text(repository.commit),
          path: text(repository.path),
        }
      : null,
    server: record(source.server) ?? undefined,
    prompt: promptInfo(source.prompt),
    assistant: assistantInfo(source.assistant),
    packages: Array.isArray(source.packages)
      ? records(source.packages).map(pinnedPackage)
      : undefined,
    permissions: permissions(source.permissions),
    risk: text(source.risk),
    reviewed: source.reviewed === true,
    advisories: records(source.advisories),
  } as HarnessItemDetail["install"]
}

/** `harness_item`'s answer. Throws `invalidResponse` when it is not an item
 *  at all; otherwise every part a detail reads is there. */
export function normalizeItemDetail(value: unknown): HarnessItemDetail {
  const summary = normalizeItemSummary(value)
  const source = record(value)
  if (!summary || !source) throw invalid("the item")
  const itemPermissions = record(source.permissions) ?? {}
  const checks = record(source.checks) ?? {}
  return {
    ...summary,
    license: textOrNull(source.license),
    repositoryUrl: textOrNull(source.repositoryUrl),
    websiteUrl: textOrNull(source.websiteUrl),
    sourceUrl: textOrNull(source.sourceUrl),
    listedReasons: texts(source.listedReasons),
    permissions: {
      ...itemPermissions,
      declared: declaredPermissions(itemPermissions.declared),
      detected: permissions(itemPermissions.detected),
    },
    checks: {
      ...checks,
      findings: records(checks.findings).map(finding),
      review: text(checks.review),
      rules: textOrNull(checks.rules),
      checkedAt: text(checks.checkedAt),
      secrets: count(checks.secrets),
      warnings: texts(checks.warnings),
      dropped: records(checks.dropped).map((entry) => ({
        ...entry,
        path: text(entry.path),
        reason: text(entry.reason),
      })),
    },
    readme: textOrNull(source.readme),
    install: installInfo(source.install),
  }
}

/** `harness_versions`' answer: the versions, newest first as the API sends
 *  them. */
export function normalizeVersions(value: unknown): HarnessVersionSummary[] {
  if (!Array.isArray(value)) throw invalid("the version list")
  return records(value).map((source) => ({
    ...source,
    revision: count(source.revision),
    version: textOrNull(source.version),
    status: text(source.status),
    risk: text(source.risk),
    publishedAt: text(source.publishedAt),
  }))
}

/** `harness_config`'s answer: the lists the filters are built from. */
export function normalizeConfig(value: unknown): HarnessConfig {
  const source = record(value)
  if (!source) throw invalid("the configuration")
  return {
    ...source,
    limits: (record(source.limits) ?? {}) as HarnessConfig["limits"],
    kinds: texts(source.kinds),
    sorts: texts(source.sorts),
    runtimes: records(source.runtimes)
      .map((runtime) => ({
        ...runtime,
        id: text(runtime.id),
        count: count(runtime.count),
      }))
      .filter((runtime) => runtime.id),
    tags: records(source.tags)
      .map((tag) => ({
        ...tag,
        id: text(tag.id),
        name: localized(tag.name),
        count: count(tag.count),
      }))
      .filter((tag) => tag.id),
    review: text(source.review),
  }
}

/** `harness_status`' answer. */
export function normalizeStatus(value: unknown): HarnessStatus {
  const source = record(value)
  if (!source || typeof source.enabled !== "boolean") {
    throw invalid("the status")
  }
  return { ...source, enabled: source.enabled, origin: text(source.origin) }
}

/** `harness_readme`'s answer: the fragment, or `null` for none. */
export function normalizeReadme(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== "string") throw invalid("the description")
  return value
}

/** `harness_prompt`'s answer. */
export function normalizePrompt(value: unknown): string {
  if (typeof value !== "string") throw invalid("the prompt")
  return value
}

/** `harness_blob`'s answer: a package file's text. */
export function normalizeBlob(value: unknown): string {
  if (typeof value !== "string") throw invalid("the file")
  return value
}

/** `srn_asset`'s answer. */
export function normalizeAsset(value: unknown): SrnAsset {
  const source = record(value)
  if (
    !source ||
    typeof source.mime !== "string" ||
    typeof source.dataBase64 !== "string"
  ) {
    throw invalid("the image")
  }
  return { mime: source.mime, dataBase64: source.dataBase64 }
}
