/**
 * The plugin install commands' answers, read defensively — for the reason
 * `mcp-install-normalize.ts` gives: the backend may be a newer (or older)
 * Codeg than this window. Every field a component reads is present and of its
 * type afterwards; a value this build does not know stays as it came; only an
 * answer that is not the shape at all is refused, as `invalidResponse`.
 *
 * Nothing is made more permissive than it came: a revision not said to be
 * approved is not, a host not said to be supported is not, a mode missing is
 * "none", an autorun part of an unknown type is kept (it still runs), and a
 * link preview that cannot be read is no preview.
 */
import { normalizeApplyResult } from "@/lib/skills/normalize"
import type { SkillsApplyResult } from "@/lib/skills/types"
import { HarnessClientError } from "./errors"
import { normalizeVersionState } from "./mcp-install-normalize"
import type { HarnessMcpPlanItem, HarnessReason } from "./mcp-install-types"
import type {
  HarnessAutorunPart,
  HarnessHookStatus,
  HarnessHookTrust,
  HarnessListedPlugin,
  HarnessListedPluginHost,
  HarnessPluginMemberChange,
  HarnessPluginRepairNote,
  HarnessPluginUpdateHost,
  HarnessPluginUpdatePlan,
  HarnessExpertLink,
  HarnessInstalledPluginEntry,
  HarnessInstalledPluginHost,
  HarnessPluginDetect,
  HarnessPluginHostInfo,
  HarnessPluginHostOutcome,
  HarnessPluginHostState,
  HarnessPluginInfo,
  HarnessPluginInstallResult,
  HarnessPluginMember,
  HarnessPluginNameHeld,
  HarnessPluginPlan,
  HarnessPluginPlanHost,
  HarnessPluginRelease,
  HarnessPluginRevision,
  HarnessPluginSkillsPlan,
  HarnessPluginUninstallResult,
} from "./plugin-install-types"
import type { HarnessSkillPackageFile } from "./skill-install-types"
import { normalizeUpdateItem } from "./updates"

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

/** A value of a known set: kept as it came, `fallback` when it is none. */
function open(value: unknown, fallback: string): string {
  return typeof value === "string" && value !== "" ? value : fallback
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0
}

function countOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null
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

function list<T>(value: unknown, read: (source: Json) => T | null): T[] {
  return records(value)
    .map(read)
    .filter((entry): entry is T => entry !== null)
}

/** An object keyed by agent (or member), each value read by `read`. */
function keyed<T>(
  value: unknown,
  read: (entry: unknown) => T | null
): Record<string, T> {
  const out: Record<string, T> = {}
  for (const [key, entry] of Object.entries(record(value) ?? {})) {
    const read_ = read(entry)
    if (key && read_ !== null) out[key] = read_
  }
  return out
}

function stringMap(value: unknown): Record<string, string> {
  return keyed(value, (entry) => (typeof entry === "string" ? entry : null))
}

function invalid(what: string): HarnessClientError {
  return new HarnessClientError(
    "invalidResponse",
    `Harness: ${what} is not in the expected shape`
  )
}

function reason(value: unknown): HarnessReason | null {
  const source = record(value)
  if (!source || typeof source.code !== "string" || source.code === "") {
    return null
  }
  return {
    code: source.code,
    params: stringMap(source.params),
    detail: textOrNull(source.detail),
  }
}

function reasons(value: unknown): HarnessReason[] {
  return Array.isArray(value)
    ? value
        .map(reason)
        .filter((entry): entry is HarnessReason => entry !== null)
    : []
}

function title(value: unknown): { en?: string; zh?: string } {
  const source = record(value) ?? {}
  return {
    ...(typeof source.en === "string" ? { en: source.en } : {}),
    ...(typeof source.zh === "string" ? { zh: source.zh } : {}),
  }
}

function linksOrNull(value: unknown): SkillsApplyResult | null {
  if (value === null || value === undefined) return null
  try {
    return normalizeApplyResult(value)
  } catch {
    return null
  }
}

export function pluginMember(source: Json): HarnessPluginMember | null {
  const name = text(source.name)
  if (!name) return null
  return {
    kind: open(source.kind, "unknown"),
    name,
    path: text(source.path),
    summary: textOrNull(source.summary),
    treeSha256: textOrNull(source.treeSha256),
  }
}

export function autorunPart(source: Json): HarnessAutorunPart {
  return {
    host: text(source.host),
    // A part whose type is not said still runs on its own.
    type: open(source.type, "unknown"),
    path: text(source.path),
    event: textOrNull(source.event),
    name: textOrNull(source.name),
    command: textOrNull(source.command),
  }
}

export function pluginHostInfo(source: Json): HarnessPluginHostInfo | null {
  const host = text(source.host)
  if (!host) return null
  return {
    host,
    manifest: text(source.manifest),
    name: textOrNull(source.name),
    skills: count(source.skills),
    agents: count(source.agents),
    commands: count(source.commands),
    hooks: count(source.hooks),
    mcp: count(source.mcp),
    code: count(source.code),
  }
}

function packageFile(source: Json): HarnessSkillPackageFile | null {
  const path = text(source.path)
  if (!path) return null
  return {
    path,
    sha256: text(source.sha256),
    size: count(source.size),
    executable: source.executable === true,
  }
}

function revisionOf(value: unknown): HarnessPluginRevision | null {
  const source = record(value)
  if (!source || typeof source.revision !== "number") return null
  const archive = record(source.archive)
  const origin = record(source.source)
  return {
    revision: count(source.revision),
    version: textOrNull(source.version),
    published_at: text(source.published_at),
    name: textOrNull(source.name),
    state_sha256: textOrNull(source.state_sha256),
    approved: source.approved === true,
    exec_sha256: textOrNull(source.exec_sha256),
    mcp_unpinned: texts(source.mcp_unpinned),
    members: list(source.members, pluginMember),
    autorun: records(source.autorun).map(autorunPart),
    autorun_files: texts(source.autorun_files),
    hosts: list(source.hosts, pluginHostInfo),
    archive: archive
      ? {
          url: text(archive.url),
          sha256: text(archive.sha256),
          size: count(archive.size),
        }
      : null,
    source: origin
      ? {
          repository: text(origin.repository),
          commit: text(origin.commit),
          path: text(origin.path),
        }
      : null,
    files: list(source.files, packageFile),
    total_bytes: count(source.total_bytes),
    blocking: reasons(source.blocking),
    confirm: reasons(source.confirm),
    warnings: reasons(source.warnings),
  }
}

function detect(value: unknown): HarnessPluginDetect | null {
  const source = record(value)
  if (!source) return null
  return {
    found: source.found === true,
    via: textOrNull(source.via),
    version: textOrNull(source.version),
    supported: source.supported === true,
    why_not: reason(source.why_not),
  }
}

function expertLink(source: Json): HarnessExpertLink | null {
  const name = text(source.name)
  if (!name) return null
  return {
    name,
    path: text(source.path),
    copy: source.copy === true,
    agents: texts(source.agents),
  }
}

function nameHeld(source: Json): HarnessPluginNameHeld | null {
  const name = text(source.name)
  if (!name) return null
  return {
    name,
    path: text(source.path),
    by: open(source.by, "unknown"),
    plugin: textOrNull(source.plugin),
    agents: texts(source.agents),
  }
}

export function skillsPlan(value: unknown): HarnessPluginSkillsPlan | null {
  const source = record(value)
  if (!source) return null
  return {
    agent: text(source.agent),
    links: linksOrNull(source.links),
    takeover: list(source.takeover, expertLink),
    held: list(source.held, nameHeld),
    copies_to_take: texts(source.copies_to_take),
    issues: reasons(source.issues),
  }
}

function planHost(source: Json): HarnessPluginPlanHost | null {
  const agent = text(source.agent)
  if (!agent) return null
  const offered = texts(source.offered)
  return {
    agent,
    host_id: textOrNull(source.host_id),
    installed: typeof source.installed === "boolean" ? source.installed : null,
    detect: detect(source.detect),
    // Not at all is always a choice.
    offered: offered.includes("none") ? offered : [...offered, "none"],
    default: open(source.default, "none"),
    planned: open(source.planned, "none"),
    why_not: reason(source.why_not),
    experts_to_take_over: list(source.experts_to_take_over, expertLink),
    experts_ack: textOrNull(source.experts_ack),
    codex_hooks_need_trust: source.codex_hooks_need_trust === true,
    skills: skillsPlan(source.skills),
  }
}

/** `HostState` as serde writes it: `"active"`, or `{"suspended": {…}}`. */
export function pluginHostState(value: unknown): HarnessPluginHostState {
  if (typeof value === "string" && value !== "") {
    return { kind: value, reason: null }
  }
  const source = record(value)
  const [kind] = Object.keys(source ?? {})
  if (!source || !kind) return { kind: "unknown", reason: null }
  return { kind, reason: textOrNull(record(source[kind])?.reason) }
}

function installedHost(value: unknown): HarnessInstalledPluginHost | null {
  const source = record(value)
  if (!source) return null
  return {
    mode: open(source.mode, "unknown"),
    state: pluginHostState(source.state),
    host_name: textOrNull(source.host_name),
    skills: texts(source.skills),
    experts: list(source.experts, expertLink),
  }
}

function installedEntry(value: unknown): HarnessInstalledPluginEntry | null {
  const source = record(value)
  if (!source) return null
  return {
    name: text(source.name),
    item_id: text(source.item_id),
    ref: text(source.ref),
    revision: count(source.revision),
    version: textOrNull(source.version),
    hosts: keyed(source.hosts, installedHost),
    consent: textOrNull(source.consent),
    installed_at: text(source.installed_at),
  }
}

function planItem(item: Json): HarnessMcpPlanItem {
  return {
    id: text(item.id),
    ref: text(item.ref),
    kind: open(item.kind, "unknown"),
    title: title(item.title),
    revision: count(item.revision),
    version: textOrNull(item.version),
    published_at: text(item.published_at),
  }
}

/** `harness_plugin_plan`'s answer. */
export function normalizePluginPlan(value: unknown): HarnessPluginPlan {
  const source = record(value)
  const item = record(source?.item)
  const latest = revisionOf(source?.latest)
  if (!source || !item || !latest || !Array.isArray(source.hosts)) {
    throw invalid("the plugin install plan")
  }
  return {
    item: planItem(item),
    item_status: open(source.item_status, "unknown"),
    latest,
    full: revisionOf(source.full),
    not_full: textOrNull(source.not_full),
    target: count(source.target),
    install_name: textOrNull(source.install_name),
    members: list(source.members, pluginMember),
    autorun: records(source.autorun).map(autorunPart),
    snapshot_latest: normalizeVersionState(source.snapshot_latest),
    snapshot_full: normalizeVersionState(source.snapshot_full),
    hosts: list(source.hosts, planHost),
    consent_required: source.consent_required === true,
    consent_exec: textOrNull(source.consent_exec),
    blocking: reasons(source.blocking),
    warnings: reasons(source.warnings),
    installed: installedEntry(source.installed),
  }
}

function hostOutcome(source: Json): HarnessPluginHostOutcome | null {
  const agent = text(source.agent)
  if (!agent) return null
  return {
    agent,
    mode: open(source.mode, "unknown"),
    status: open(source.status, "unknown"),
    host_name: textOrNull(source.host_name),
    issues: reasons(source.issues),
    experts_taken: list(source.experts_taken, expertLink),
    experts_back: list(source.experts_back, expertLink),
    experts_left: list(source.experts_left, expertLink),
  }
}

function expertsByAgent(value: unknown): Record<string, HarnessExpertLink[]> {
  return keyed(value, (entry) =>
    Array.isArray(entry) ? list(entry, expertLink) : null
  )
}

/** `harness_plugin_install`'s answer (and the update's, a change's, a
 *  repair's: one shape). */
export function normalizePluginInstallResult(
  value: unknown
): HarnessPluginInstallResult {
  const source = record(value)
  if (!source || typeof source.outcome !== "string") {
    throw invalid("the plugin install result")
  }
  return {
    outcome: source.outcome,
    issues: reasons(source.issues),
    changes: reasons(source.changes),
    snapshot: normalizeVersionState(source.snapshot),
    state_sha256: textOrNull(source.state_sha256),
    name: textOrNull(source.name),
    revision: countOrNull(source.revision),
    hosts: list(source.hosts, hostOutcome),
    skills: keyed(source.skills, skillsPlan),
    experts_acks: stringMap(source.experts_acks),
    needs_repair: texts(source.needs_repair),
    problems: texts(source.problems),
    consent_required: source.consent_required === true,
    consent_exec: textOrNull(source.consent_exec),
    experts_to_take_over: expertsByAgent(source.experts_to_take_over),
    experts_to_give_back: expertsByAgent(source.experts_to_give_back),
  }
}

/** `harness_plugin_uninstall`'s answer. */
export function normalizePluginUninstallResult(
  value: unknown
): HarnessPluginUninstallResult {
  const source = record(value)
  if (!source || typeof source.outcome !== "string") {
    throw invalid("the plugin uninstall result")
  }
  return {
    outcome: source.outcome,
    issues: reasons(source.issues),
    item_id: text(source.item_id),
    name: textOrNull(source.name),
    removes: keyed(source.removes, skillsPlan),
    experts: expertsByAgent(source.experts),
    ack: textOrNull(source.ack),
    hosts: list(source.hosts, hostOutcome),
    needs_repair: texts(source.needs_repair),
    problems: texts(source.problems),
  }
}

function release(source: Json): HarnessPluginRelease | null {
  const version = text(source.version)
  if (!version) return null
  const changed = record(source.changed)
  return {
    version,
    tag: textOrNull(source.tag),
    url: textOrNull(source.url),
    notes: textOrNull(source.notes),
    publishedAt: textOrNull(source.publishedAt),
    revision: countOrNull(source.revision),
    changed: changed
      ? {
          added: texts(changed.added),
          updated: texts(changed.updated),
          removed: texts(changed.removed),
        }
      : null,
  }
}

/** `harness_releases`' answer: newest first, as the API sends them. */
export function normalizeReleases(value: unknown): HarnessPluginRelease[] {
  if (!Array.isArray(value)) throw invalid("the release list")
  return list(value, release)
}

/** A version's `plugin` part as the catalog's install info has it (an
 *  item's detail): `null` when there is none. */
export function normalizePluginInfo(value: unknown): HarnessPluginInfo | null {
  const source = record(value)
  if (!source) return null
  const full = record(source.full)
  return {
    name: text(source.name),
    hosts: list(source.hosts, pluginHostInfo),
    components: list(source.components, pluginMember),
    autorun: records(source.autorun).map(autorunPart),
    autorunFiles: texts(source.autorunFiles),
    mcpUnpinned: texts(source.mcpUnpinned),
    approved: source.approved === true,
    full:
      full && typeof full.revision === "number"
        ? { revision: count(full.revision), version: textOrNull(full.version) }
        : null,
    notFull: textOrNull(source.notFull),
  }
}

// ─── The installed list ───────────────────────────────────────────────

function repairNote(value: unknown): HarnessPluginRepairNote | null {
  const source = record(value)
  if (!source) return null
  return {
    was:
      source.was === undefined || source.was === null
        ? null
        : pluginHostState(source.was),
    other_modes: texts(source.other_modes),
    uninstalling: source.uninstalling === true,
    restored: source.restored === true,
  }
}

function listedHost(source: Json): HarnessListedPluginHost | null {
  const agent = text(source.agent)
  if (!agent) return null
  const verify = record(source.verify)
  return {
    agent,
    host_id: textOrNull(source.host_id),
    mode: open(source.mode, "unknown"),
    state: pluginHostState(source.state),
    suspended_reason: textOrNull(source.suspended_reason),
    repair: repairNote(source.repair),
    host_name: textOrNull(source.host_name),
    skills: texts(source.skills),
    experts: list(source.experts, expertLink),
    codex_hooks: source.codex_hooks === true,
    verify: verify
      ? {
          enabled: typeof verify.enabled === "boolean" ? verify.enabled : null,
          problems: reasons(verify.problems),
        }
      : null,
  }
}

function listedPlugin(source: Json): HarnessListedPlugin | null {
  const name = text(source.name)
  const itemId = text(source.item_id)
  if (!name || !itemId) return null
  return {
    name,
    item_id: itemId,
    ref: text(source.ref),
    revision: count(source.revision),
    version: textOrNull(source.version),
    previous_revision: countOrNull(source.previous_revision),
    installed_at: text(source.installed_at),
    exec_sha256: text(source.exec_sha256),
    consent: textOrNull(source.consent),
    autorun: records(source.autorun).map(autorunPart),
    members: list(source.members, pluginMember),
    hosts: list(source.hosts, listedHost),
    update: normalizeUpdateItem(source.update),
    problems: reasons(source.problems),
  }
}

/** `harness_installed`'s `plugins`: `[]` from a Codeg that installs none.
 *  Should two rows claim one item, the first listed keeps it. */
export function normalizeListedPlugins(value: unknown): HarnessListedPlugin[] {
  const seen = new Set<string>()
  return list(value, listedPlugin).filter((plugin) => {
    if (seen.has(plugin.item_id)) return false
    seen.add(plugin.item_id)
    return true
  })
}

function hookStatus(source: Json): HarnessHookStatus | null {
  const key = text(source.key)
  if (!key) return null
  return {
    key,
    event: text(source.event),
    // Not said is not trusted.
    state: open(source.state, "unknown"),
  }
}

/** `harness_plugin_hook_trust`'s answer. */
export function normalizeHookTrust(value: unknown): HarnessHookTrust {
  const source = record(value)
  if (!source || !Array.isArray(source.hooks)) {
    throw invalid("the hook trust")
  }
  return {
    hooks: list(source.hooks, hookStatus),
    problem: reason(source.problem),
  }
}

// ─── The update plan ──────────────────────────────────────────────────

function memberChange(source: Json): HarnessPluginMemberChange | null {
  const name = text(source.name)
  if (!name) return null
  return {
    kind: open(source.kind, "unknown"),
    name,
    change: open(source.change, "changed"),
  }
}

function updateHost(source: Json): HarnessPluginUpdateHost | null {
  const agent = text(source.agent)
  if (!agent) return null
  return {
    agent,
    host_id: textOrNull(source.host_id),
    mode: open(source.mode, "unknown"),
    state: pluginHostState(source.state),
    to_mode: open(source.to_mode, "unknown"),
    to_state: pluginHostState(source.to_state),
    action: open(source.action, "unknown"),
    why_not: reason(source.why_not),
    detect: detect(source.detect),
    experts_to_take_over: list(source.experts_to_take_over, expertLink),
    experts_ack: textOrNull(source.experts_ack),
    experts_to_give_back: list(source.experts_to_give_back, expertLink),
    codex_hooks_need_trust: source.codex_hooks_need_trust === true,
    skills: skillsPlan(source.skills),
  }
}

/** `harness_plugin_plan_update`'s answer. */
export function normalizePluginUpdatePlan(
  value: unknown
): HarnessPluginUpdatePlan {
  const source = record(value)
  if (!source || !Array.isArray(source.hosts)) {
    throw invalid("the plugin update plan")
  }
  const item = record(source.item)
  return {
    installed: installedEntry(source.installed),
    item: item ? planItem(item) : null,
    item_status: open(source.item_status, "unknown"),
    latest: revisionOf(source.latest),
    full: revisionOf(source.full),
    not_full: textOrNull(source.not_full),
    target: countOrNull(source.target),
    revision_from: count(source.revision_from),
    version_from: textOrNull(source.version_from),
    version_to: textOrNull(source.version_to),
    changed_members: Array.isArray(source.changed_members)
      ? list(source.changed_members, memberChange)
      : null,
    up_to_date: source.up_to_date === true,
    // Asked again whenever it is said, and never taken for "not needed"
    // when the plan says it is.
    needs_consent: source.needs_consent === true,
    consent_exec: textOrNull(source.consent_exec),
    autorun: records(source.autorun).map(autorunPart),
    snapshot: normalizeVersionState(source.snapshot),
    state_sha256: textOrNull(source.state_sha256),
    hosts: list(source.hosts, updateHost),
    blocking: reasons(source.blocking),
    warnings: reasons(source.warnings),
  }
}
