/**
 * The install commands' answers, read defensively — for the reason
 * `./normalize.ts` and `lib/mcp/normalize.ts` give: the backend may be a
 * newer (or older) Codeg than this window. Every field a component reads is
 * present and of its type afterwards; a value this build does not know stays
 * as it came, for the labels to call "unknown"; only an answer that is not the
 * shape at all is refused, as `invalidResponse`.
 *
 * Nothing here ever makes a fact more reassuring than it came: a risk, a
 * review, a verification that is missing stays missing (`null`), and an
 * option is selectable only when the backend said so AND gave it no reason
 * not to be.
 */
import { normalizeApplyResult, normalizeDefinition } from "@/lib/mcp/normalize"
import type { McpApplyResult, McpIssue } from "@/lib/mcp/types"
import { HarnessClientError } from "./errors"
import { normalizeInstalledSkills } from "./installed-skill-normalize"
import type {
  HarnessAgentEntry,
  HarnessInstalled,
  HarnessInstalledAgent,
  HarnessInstalledChanged,
  HarnessInstalledItem,
  HarnessKeyConflict,
  HarnessMcpInstallResult,
  HarnessMcpPlan,
  HarnessMcpPlanAgent,
  HarnessMcpPlanOption,
  HarnessMcpPlanPackage,
  HarnessMcpPlanParameter,
  HarnessMcpUninstallResult,
  HarnessOptionRecovery,
  HarnessPackageState,
  HarnessReason,
  HarnessRecordWrite,
  HarnessRecoveredValue,
  HarnessUninstallAgent,
  HarnessVersionState,
} from "./mcp-install-types"
import { HARNESS_PERMISSION_KEYS, type HarnessPermissions } from "./types"

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
  return typeof value === "string" && value !== "" ? value : null
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0
}

function texts(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : []
}

function records(value: unknown): Json[] {
  return Array.isArray(value)
    ? value.map(record).filter((entry): entry is Json => entry !== null)
    : []
}

function stringMap(value: unknown): Record<string, string> {
  const source = record(value)
  const out: Record<string, string> = {}
  if (!source) return out
  for (const [key, entry] of Object.entries(source)) {
    if (typeof entry === "string") out[key] = entry
  }
  return out
}

function invalid(what: string): HarnessClientError {
  return new HarnessClientError(
    "invalidResponse",
    `Harness: ${what} is not in the expected shape`
  )
}

function reason(value: Json): HarnessReason | null {
  if (typeof value.code !== "string" || value.code === "") return null
  return {
    code: value.code,
    params: stringMap(value.params),
    detail: textOrNull(value.detail),
  }
}

function reasons(value: unknown): HarnessReason[] {
  return records(value)
    .map(reason)
    .filter((entry): entry is HarnessReason => entry !== null)
}

function permissions(value: unknown): HarnessPermissions {
  const source = record(value) ?? {}
  const out: Json = {}
  for (const key of HARNESS_PERMISSION_KEYS) out[key] = texts(source[key])
  return out as HarnessPermissions
}

function packageState(source: Json): HarnessPackageState {
  return {
    registryType: text(source.registryType),
    identifier: text(source.identifier),
    version: textOrNull(source.version),
    verified: text(source.verified, "unknown") || "unknown",
    hasInstallScript: source.hasInstallScript === true,
  }
}

/** The catalog's `VersionState`, or `null` for none. */
export function normalizeVersionState(
  value: unknown
): HarnessVersionState | null {
  const source = record(value)
  if (!source) return null
  const perms = record(source.permissions)
  const checks = record(source.checks)
  const findings = record(checks?.findings) ?? {}
  return {
    revision: count(source.revision),
    // A status that is missing is not "ok".
    status: text(source.status, "unknown") || "unknown",
    risk: typeof source.risk === "string" ? source.risk : null,
    reviewed: typeof source.reviewed === "boolean" ? source.reviewed : null,
    permissions: perms
      ? {
          declared: permissions(perms.declared),
          detected: permissions(perms.detected),
        }
      : null,
    checks: checks
      ? {
          findings: {
            low: count(findings.low),
            medium: count(findings.medium),
            high: count(findings.high),
          },
          secrets: count(checks.secrets),
          review: text(checks.review),
        }
      : null,
    packages: Array.isArray(source.packages)
      ? records(source.packages).map(packageState)
      : null,
    stateSha256: textOrNull(source.stateSha256),
  }
}

function planPackage(value: unknown): HarnessMcpPlanPackage | null {
  const source = record(value)
  if (!source) return null
  return {
    registry_type: text(source.registry_type),
    identifier: text(source.identifier),
    version: textOrNull(source.version),
    verified:
      source.verified === null || source.verified === undefined
        ? null
        : text(source.verified, "unknown") || "unknown",
    has_install_script: source.has_install_script === true,
    runtime: textOrNull(source.runtime),
  }
}

function parameter(source: Json): HarnessMcpPlanParameter | null {
  const key = text(source.key)
  if (!key) return null
  return {
    key,
    name: text(source.name) || key,
    location: text(source.location, "arg") || "arg",
    description: textOrNull(source.description),
    required: source.required === true,
    // Unsure is secret: masking a value costs a click to reveal it.
    secret: source.secret !== false,
    kind: text(source.kind, "string") || "string",
    default: typeof source.default === "string" ? source.default : null,
    placeholder: textOrNull(source.placeholder),
    choices: texts(source.choices),
    current: recovered(source.current),
  }
}

function recovered(value: unknown): HarnessRecoveredValue | null {
  const source = record(value)
  if (!source || typeof source.value !== "string") return null
  return {
    value: source.value,
    agents: texts(source.agents),
    // Unsure is "they disagree": the dialog then asks rather than fills in.
    conflicting: source.conflicting !== false,
  }
}

function recovery(value: unknown): HarnessOptionRecovery | null {
  const source = record(value)
  if (!source) return null
  return {
    from: texts(source.from),
    unmatched: texts(source.unmatched),
    lost: records(source.lost)
      .filter((entry) => typeof entry.key === "string" && entry.key !== "")
      .map((entry) => ({
        key: String(entry.key),
        agents: texts(entry.agents),
      })),
  }
}

function issue(value: unknown): McpIssue | null {
  const source = record(value)
  if (!source || typeof source.code !== "string" || source.code === "") {
    return null
  }
  const out: McpIssue = { code: source.code }
  if (typeof source.field === "string") out.field = source.field
  if (typeof source.detail === "string") out.detail = source.detail
  return out
}

function agentEntry(source: Json): HarnessAgentEntry | null {
  const key = text(source.key)
  if (!key) return null
  return {
    key,
    owner: text(source.owner, "elsewhere") || "elsewhere",
    item_id: textOrNull(source.item_id),
    item_ref: textOrNull(source.item_ref),
  }
}

function option(source: Json): HarnessMcpPlanOption | null {
  const id = text(source.id)
  if (!id) return null
  const blocking = reasons(source.blocking)
  return {
    id,
    transport: text(source.transport),
    source: text(source.source),
    package: planPackage(source.package),
    definition: normalizeDefinition(source.definition),
    url: textOrNull(source.url),
    parameters: records(source.parameters)
      .map(parameter)
      .filter((entry): entry is HarnessMcpPlanParameter => entry !== null),
    blocking,
    warnings: reasons(source.warnings),
    selectable: source.selectable === true && blocking.length === 0,
    default_targets: texts(source.default_targets),
    default_replace: texts(source.default_replace),
    recovery: recovery(source.recovery),
  }
}

function conflict(source: Json): HarnessKeyConflict | null {
  const key = text(source.key)
  const agent = text(source.agent)
  if (!key || !agent) return null
  return {
    key,
    agent,
    owner: text(source.owner, "elsewhere") || "elsewhere",
    item_id: textOrNull(source.item_id),
    item_ref: textOrNull(source.item_ref),
    state: textOrNull(source.state),
    definition: normalizeDefinition(source.definition),
    enabled: source.enabled !== false,
  }
}

function planAgent(source: Json): HarnessMcpPlanAgent | null {
  const agent = text(source.agent)
  if (!agent) return null
  return {
    agent,
    installed: typeof source.installed === "boolean" ? source.installed : null,
    writable: source.writable === true,
    transports: texts(source.transports),
    path: text(source.path),
    status: text(source.status, "unreadable") || "unreadable",
    basis: textOrNull(source.basis),
    keys: texts(source.keys),
    reason: issue(source.reason),
    entries: records(source.entries)
      .map(agentEntry)
      .filter((entry): entry is HarnessAgentEntry => entry !== null),
  }
}

function installedAgent(source: Json): HarnessInstalledAgent | null {
  const agent = text(source.agent)
  if (!agent) return null
  return {
    agent,
    state: text(source.state, "unknown") || "unknown",
    revision: count(source.revision),
    version: textOrNull(source.version),
    option: text(source.option),
    transport: text(source.transport),
    packages: records(source.packages).map((entry) => ({
      registry_type: text(entry.registry_type),
      identifier: text(entry.identifier),
      version: text(entry.version),
    })),
    state_sha256: text(source.state_sha256),
    installed_at: text(source.installed_at),
  }
}

function installedItem(value: unknown): HarnessInstalledItem | null {
  const source = record(value)
  const id = text(source?.id)
  const key = text(source?.key)
  if (!source || !id || !key) return null
  const title = record(source.title)
  return {
    id,
    ref: text(source.ref),
    title: title
      ? {
          ...(typeof title.en === "string" ? { en: title.en } : {}),
          ...(typeof title.zh === "string" ? { zh: title.zh } : {}),
        }
      : null,
    key,
    revision: count(source.revision),
    version: textOrNull(source.version),
    state: text(source.state, "unknown") || "unknown",
    agents: records(source.agents)
      .map(installedAgent)
      .filter((entry): entry is HarnessInstalledAgent => entry !== null),
  }
}

/** `harness_mcp_plan`'s answer. */
export function normalizeMcpPlan(value: unknown): HarnessMcpPlan {
  const source = record(value)
  const item = record(source?.item)
  const key = record(source?.key)
  if (!source || !item || !key || !Array.isArray(source.options)) {
    throw invalid("the install plan")
  }
  const latest = record(source.latest)
  const title = record(item.title) ?? {}
  return {
    item: {
      id: text(item.id),
      ref: text(item.ref),
      kind: text(item.kind, "unknown") || "unknown",
      title: {
        ...(typeof title.en === "string" ? { en: title.en } : {}),
        ...(typeof title.zh === "string" ? { zh: title.zh } : {}),
      },
      revision: count(item.revision),
      version: textOrNull(item.version),
      published_at: text(item.published_at),
    },
    item_status: text(source.item_status, "unknown") || "unknown",
    latest: latest
      ? {
          revision: count(latest.revision),
          version: textOrNull(latest.version),
          publishedAt: text(latest.publishedAt),
        }
      : null,
    snapshot: normalizeVersionState(source.snapshot),
    state_sha256: textOrNull(source.state_sha256),
    blocking: reasons(source.blocking),
    confirm: reasons(source.confirm),
    options: records(source.options)
      .map(option)
      .filter((entry): entry is HarnessMcpPlanOption => entry !== null),
    default_option: textOrNull(source.default_option),
    key: {
      name: text(key.name),
      default: text(key.default),
      conflicts: records(key.conflicts)
        .map(conflict)
        .filter((entry): entry is HarnessKeyConflict => entry !== null),
      pattern: text(key.pattern),
    },
    agents: records(source.agents)
      .map(planAgent)
      .filter((entry): entry is HarnessMcpPlanAgent => entry !== null),
    basis: stringMap(source.basis),
    installed: installedItem(source.installed),
  }
}

function applyOrNull(value: unknown): McpApplyResult | null {
  if (value === null || value === undefined) return null
  try {
    return normalizeApplyResult(value)
  } catch {
    return null
  }
}

function recordWrite(value: unknown): HarnessRecordWrite | null {
  const source = record(value)
  if (!source) return null
  return {
    status: text(source.status, "unknown") || "unknown",
    code: textOrNull(source.code),
    detail: textOrNull(source.detail),
  }
}

/** `harness_mcp_install`'s answer. */
export function normalizeMcpInstallResult(
  value: unknown
): HarnessMcpInstallResult {
  const source = record(value)
  if (!source || typeof source.outcome !== "string") {
    throw invalid("the install result")
  }
  return {
    outcome: source.outcome,
    issues: reasons(source.issues),
    changes: reasons(source.changes),
    snapshot: normalizeVersionState(source.snapshot),
    state_sha256: textOrNull(source.state_sha256),
    apply: applyOrNull(source.apply),
    record: recordWrite(source.record),
  }
}

/** A part's problem: `null` for none; one without a code is still a
 *  problem — a part that says it could not be read is not "fine". */
function problemOf(value: unknown): HarnessReason | null {
  if (value === null || value === undefined) return null
  const source = record(value)
  return (
    (source && reason(source)) ?? {
      code: "record_unreadable",
      params: {},
      detail: null,
    }
  )
}

/** `harness_installed`'s answer: each part on its own, with its problem. */
export function normalizeInstalled(value: unknown): HarnessInstalled {
  const source = record(value)
  if (!source || !Array.isArray(source.mcp)) {
    throw invalid("the installed items")
  }
  return {
    mcp: source.mcp
      .map(installedItem)
      .filter((entry): entry is HarnessInstalledItem => entry !== null),
    skills: normalizeInstalledSkills(source.skills),
    mcp_problem: problemOf(source.mcp_problem),
    skills_problem: problemOf(source.skills_problem),
  }
}

function uninstallAgent(source: Json): HarnessUninstallAgent | null {
  const agent = text(source.agent)
  if (!agent) return null
  return {
    agent,
    key: text(source.key),
    state: text(source.state, "unknown") || "unknown",
    action: text(source.action, "unknown") || "unknown",
  }
}

/** `harness_mcp_uninstall`'s answer. */
export function normalizeMcpUninstallResult(
  value: unknown
): HarnessMcpUninstallResult {
  const source = record(value)
  if (!source || typeof source.outcome !== "string") {
    throw invalid("the uninstall result")
  }
  return {
    outcome: source.outcome,
    issues: reasons(source.issues),
    agents: records(source.agents)
      .map(uninstallAgent)
      .filter((entry): entry is HarnessUninstallAgent => entry !== null),
    apply: applyOrNull(source.apply),
    record: recordWrite(source.record),
  }
}

/** The event's payload; nothing in it is acted on but its arrival. */
export function normalizeInstalledChanged(
  value: unknown
): HarnessInstalledChanged {
  const source = record(value)
  return { item_ids: texts(source?.item_ids), agents: texts(source?.agents) }
}
