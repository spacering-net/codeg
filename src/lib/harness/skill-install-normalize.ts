/**
 * The skill install commands' answers, read defensively — for the reason
 * `mcp-install-normalize.ts` gives: the backend may be a newer (or older)
 * Codeg than this window. Every field a component reads is present and of
 * its type afterwards; a value this build does not know stays as it came,
 * for the labels to call "unknown"; only an answer that is not the shape at
 * all is refused, as `invalidResponse`.
 *
 * Nothing here makes a fact more reassuring than it came: a missing risk or
 * review stays missing, an agent not said to be installed is not taken for
 * one, a link preview that cannot be read is no preview — and the dialog then
 * confirms nothing it did not show.
 */
import { normalizeApplyResult, opResult } from "@/lib/skills/normalize"
import type { SkillOpResult, SkillsApplyResult } from "@/lib/skills/types"
import { HarnessClientError } from "./errors"
import {
  normalizeFileChanges,
  normalizeInstalledSkill,
  normalizeRewrites,
} from "./installed-skill-normalize"
import { normalizeVersionState } from "./mcp-install-normalize"
import type { HarnessReason } from "./mcp-install-types"
import type {
  HarnessSkillInstallResult,
  HarnessSkillNameTaken,
  HarnessSkillPackageFile,
  HarnessSkillPhase,
  HarnessSkillPlan,
  HarnessSkillPlanAgent,
  HarnessSkillRemoval,
  HarnessSkillUninstallResult,
} from "./skill-install-types"

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

function reasons(value: unknown): HarnessReason[] {
  return records(value)
    .filter((entry) => typeof entry.code === "string" && entry.code !== "")
    .map((entry) => ({
      code: String(entry.code),
      params: stringMap(entry.params),
      detail: textOrNull(entry.detail),
    }))
}

function title(value: unknown): { en?: string; zh?: string } {
  const source = record(value) ?? {}
  return {
    ...(typeof source.en === "string" ? { en: source.en } : {}),
    ...(typeof source.zh === "string" ? { zh: source.zh } : {}),
  }
}

/** A link preview, or `null` when there is none that can be read — never a
 *  made-up one. */
function linksOrNull(value: unknown): SkillsApplyResult | null {
  if (value === null || value === undefined) return null
  try {
    return normalizeApplyResult(value)
  } catch {
    return null
  }
}

function opResults(value: unknown): SkillOpResult[] {
  return Array.isArray(value)
    ? value
        .map(opResult)
        .filter((entry): entry is SkillOpResult => entry !== null)
    : []
}

function phases(value: unknown): HarnessSkillPhase[] {
  return records(value)
    .filter((entry) => typeof entry.phase === "string")
    .map((entry) => ({
      phase: String(entry.phase),
      status: text(entry.status, "unknown") || "unknown",
      detail: textOrNull(entry.detail),
    }))
}

function nameTaken(source: Json): HarnessSkillNameTaken | null {
  const name = text(source.name)
  if (!name) return null
  return {
    name,
    by: text(source.by, "unknown") || "unknown",
    pack: textOrNull(source.pack),
    item_id: textOrNull(source.item_id),
    item_ref: textOrNull(source.item_ref),
    path: textOrNull(source.path),
    agents: texts(source.agents),
  }
}

function planAgent(source: Json): HarnessSkillPlanAgent | null {
  const agent = text(source.agent)
  if (!agent) return null
  return {
    agent,
    installed: typeof source.installed === "boolean" ? source.installed : null,
    link_dir: textOrNull(source.link_dir),
    // Unsure is shared: saying "other agents may see it" costs a line;
    // not saying it would hide who else gains the skill.
    link_dir_shared: source.link_dir_shared !== false,
    sees: source.sees === true,
    default: source.default === true,
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

/** `harness_skill_plan`'s answer. */
export function normalizeSkillPlan(value: unknown): HarnessSkillPlan {
  const source = record(value)
  const item = record(source?.item)
  const name = record(source?.install_name)
  const links = linksOrNull(source?.links)
  if (!source || !item || !name || !Array.isArray(source.agents) || !links) {
    throw invalid("the skill install plan")
  }
  const latest = record(source.latest)
  const skill = record(source.skill) ?? {}
  const pkg = record(source.package) ?? {}
  const archive = record(pkg.archive)
  const origin = record(pkg.source)
  return {
    item: {
      id: text(item.id),
      ref: text(item.ref),
      kind: text(item.kind, "unknown") || "unknown",
      title: title(item.title),
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
    warnings: reasons(source.warnings),
    skill: {
      name: text(skill.name),
      description: text(skill.description),
      license: textOrNull(skill.license),
      compatibility: textOrNull(skill.compatibility),
      allowed_tools: Array.isArray(skill.allowed_tools)
        ? texts(skill.allowed_tools)
        : null,
    },
    package: {
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
      files: records(pkg.files)
        .map(packageFile)
        .filter((entry): entry is HarnessSkillPackageFile => entry !== null),
      total_bytes: count(pkg.total_bytes),
    },
    install_name: {
      name: text(name.name),
      default: text(name.default),
      taken: records(name.taken)
        .map(nameTaken)
        .filter((entry): entry is HarnessSkillNameTaken => entry !== null),
      pattern: text(name.pattern),
    },
    agents: records(source.agents)
      .map(planAgent)
      .filter((entry): entry is HarnessSkillPlanAgent => entry !== null),
    default_agents: texts(source.default_agents),
    links,
    installed: normalizeInstalledSkill(source.installed),
  }
}

/** `harness_skill_install`'s answer. */
export function normalizeSkillInstallResult(
  value: unknown
): HarnessSkillInstallResult {
  const source = record(value)
  if (!source || typeof source.outcome !== "string") {
    throw invalid("the skill install result")
  }
  const copies = record(source.copies)
  return {
    outcome: source.outcome,
    issues: reasons(source.issues),
    changes: reasons(source.changes),
    snapshot: normalizeVersionState(source.snapshot),
    state_sha256: textOrNull(source.state_sha256),
    name: textOrNull(source.name),
    phases: phases(source.phases),
    links: linksOrNull(source.links),
    links_skipped: opResults(source.links_skipped),
    copies: copies
      ? {
          refreshed: texts(copies.refreshed),
          kept_changed: texts(copies.kept_changed),
          problems: texts(copies.problems),
        }
      : null,
    backup: textOrNull(source.backup),
    rewrites:
      source.rewrites === null || source.rewrites === undefined
        ? null
        : normalizeRewrites(source.rewrites),
    kept: texts(source.kept),
  }
}

function removal(source: Json): HarnessSkillRemoval | null {
  const path = text(source.path)
  if (!path) return null
  return {
    path,
    kind: text(source.kind, "unknown") || "unknown",
    agents: texts(source.agents),
  }
}

/** `harness_skill_uninstall`'s answer. */
export function normalizeSkillUninstallResult(
  value: unknown
): HarnessSkillUninstallResult {
  const source = record(value)
  if (!source || typeof source.outcome !== "string") {
    throw invalid("the skill uninstall result")
  }
  const files = normalizeFileChanges(source.files)
  const unreadable = textOrNull(source.files_unreadable)
  // Without a word on it, the files say: changed or added ones are kept.
  const keepsFolder =
    unreadable !== null ||
    (typeof source.keeps_folder === "boolean"
      ? source.keeps_folder
      : files.changed.length + files.added.length > 0)
  return {
    outcome: source.outcome,
    issues: reasons(source.issues),
    item_id: text(source.item_id),
    name: textOrNull(source.name),
    removes: records(source.removes)
      .map(removal)
      .filter((entry): entry is HarnessSkillRemoval => entry !== null),
    loses: texts(source.loses),
    kept_copies: records(source.kept_copies)
      .filter((entry) => typeof entry.code === "string")
      .map((entry) => ({
        code: String(entry.code),
        path: textOrNull(entry.path),
        agents: texts(entry.agents),
      })),
    files,
    files_unreadable: unreadable,
    keeps_folder: keepsFolder,
    backup: textOrNull(source.backup),
    ack: textOrNull(source.ack),
    phases: phases(source.phases),
    kept: texts(source.kept),
  }
}
