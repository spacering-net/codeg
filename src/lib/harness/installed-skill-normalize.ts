/**
 * The skills part of `harness_installed`, read defensively — kept apart from
 * the rest of the skill install's answers so that the listing's reader
 * (`mcp-install-normalize.ts`) can use it without the two modules importing
 * each other.
 *
 * A state this build does not know stays as it came, for the labels to call
 * "unknown"; an entry without an id or a name is dropped (nothing could act
 * on it); everything else defaults to "nothing known", never to "as
 * installed".
 */
import type {
  HarnessInstalledSkill,
  HarnessSkillFileChanges,
  HarnessSkillRewrites,
} from "./skill-install-types"

type Json = Record<string, unknown>

function record(value: unknown): Json | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : null
}

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
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

export function normalizeFileChanges(value: unknown): HarnessSkillFileChanges {
  const source = record(value)
  return {
    changed: texts(source?.changed),
    added: texts(source?.added),
    missing: texts(source?.missing),
  }
}

export function normalizeRewrites(value: unknown): HarnessSkillRewrites {
  const source = record(value)
  const name = record(source?.name)
  return {
    name:
      name && typeof name.to === "string"
        ? { from: textOrNull(name.from), to: name.to }
        : null,
    allowedTools: textOrNull(source?.allowed_tools),
  }
}

export function normalizeInstalledSkill(
  value: unknown
): HarnessInstalledSkill | null {
  const source = record(value)
  const id = text(source?.id)
  const name = text(source?.name)
  if (!source || !id || !name) return null
  return {
    id,
    ref: text(source.ref),
    name,
    revision: count(source.revision),
    version: textOrNull(source.version),
    // Unread is not "as installed".
    state: textOrNull(source.state) ?? "unknown",
    agents: texts(source.agents),
    files: normalizeFileChanges(source.files),
    rewrites: normalizeRewrites(source.rewrites),
    archive_sha256: textOrNull(source.archive_sha256),
    state_sha256: text(source.state_sha256),
    installed_at: text(source.installed_at),
  }
}

/** The listing's `skills`: `[]` when absent — a Codeg from before skills
 *  could be installed from Harness has none to list. */
export function normalizeInstalledSkills(
  value: unknown
): HarnessInstalledSkill[] {
  if (!Array.isArray(value)) return []
  return value
    .map(normalizeInstalledSkill)
    .filter((entry): entry is HarnessInstalledSkill => entry !== null)
}
