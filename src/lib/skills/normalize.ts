/**
 * The skills engine's answers, read defensively — for the reason
 * `lib/mcp/normalize.ts` gives: a remote workspace window or a browser can
 * reach a Codeg of another release. An answer is checked for the shape the
 * page relies on, and whatever a newer backend added is let through as it is:
 * an unknown state or code stays a string the labels call "unknown", an
 * unknown field is ignored. Only an answer the page could not work with at all
 * is refused, as `invalidResponse`.
 */
import type {
  AgentSkillItem,
  AgentSkillsListResult,
  AgentType,
} from "@/lib/types"
import { SkillsClientError } from "./errors"
import type {
  AgentSkillDir,
  AgentSkillOwner,
  BrokenLink,
  CellEntry,
  HarnessSkillInfo,
  NameTaken,
  PathChange,
  PathMove,
  SkillBackup,
  SkillCell,
  SkillEffects,
  SkillOpResult,
  SkillPageDeleteResult,
  SkillsAdoptResult,
  SkillsAgent,
  SkillsApplyResult,
  SkillsBackupResult,
  SkillsBackups,
  SkillsChanged,
  SkillsInventory,
  SkillsIssue,
  SkillsRepairResult,
  StoreSkill,
} from "./types"

type Raw = Record<string, unknown>

function isRaw(value: unknown): value is Raw {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback
}

function boolOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0
}

function list<T>(value: unknown, read: (item: unknown) => T | null): T[] {
  if (!Array.isArray(value)) return []
  const out: T[] = []
  for (const item of value) {
    const read_ = read(item)
    if (read_ !== null) out.push(read_)
  }
  return out
}

function strings(value: unknown): string[] {
  return list(value, (item) => (typeof item === "string" ? item : null))
}

export function issue(value: unknown): SkillsIssue | null {
  if (!isRaw(value) || typeof value.code !== "string") return null
  const out: SkillsIssue = { code: value.code }
  if (typeof value.path === "string") out.path = value.path
  const agents = strings(value.agents)
  if (agents.length > 0) out.agents = agents
  if (typeof value.detail === "string") out.detail = value.detail
  const kept = strings(value.kept)
  if (kept.length > 0) out.kept = kept
  return out
}

// ─── skills_inventory ─────────────────────────────────────────────────

function dir(value: unknown): AgentSkillDir | null {
  if (!isRaw(value) || typeof value.path !== "string") return null
  return {
    path: value.path,
    role: str(value.role),
    shared_with: strings(value.shared_with),
    exists: bool(value.exists),
  }
}

function agent(value: unknown): SkillsAgent | null {
  if (!isRaw(value) || typeof value.agent !== "string") return null
  return {
    agent: value.agent,
    dirs: list(value.dirs, dir),
    link_dir: strOrNull(value.link_dir),
    link_dir_shared: bool(value.link_dir_shared),
  }
}

function entry(value: unknown): CellEntry | null {
  if (!isRaw(value) || typeof value.path !== "string") return null
  const out: CellEntry = {
    path: value.path,
    dir: str(value.dir),
    dir_role: str(value.dir_role),
    kind: str(value.kind),
  }
  if (typeof value.target === "string") out.target = value.target
  if (typeof value.copy_matches === "boolean") {
    out.copy_matches = value.copy_matches
  }
  if (typeof value.copy_current === "boolean") {
    out.copy_current = value.copy_current
  }
  return out
}

function cell(value: unknown): SkillCell | null {
  if (!isRaw(value) || typeof value.agent !== "string") return null
  return {
    agent: value.agent,
    state: str(value.state),
    path: strOrNull(value.path),
    dir: strOrNull(value.dir),
    dir_role: strOrNull(value.dir_role),
    target: strOrNull(value.target),
    codeg: bool(value.codeg),
    copy_matches: boolOrNull(value.copy_matches),
    copy_current: boolOrNull(value.copy_current),
    shared_with: strings(value.shared_with),
    entries: list(value.entries, entry),
  }
}

function harnessInfo(value: unknown): HarnessSkillInfo | null {
  if (!isRaw(value)) return null
  return { ref: strOrNull(value.ref), version: strOrNull(value.version) }
}

function storeSkill(value: unknown): StoreSkill | null {
  if (!isRaw(value) || typeof value.id !== "string") return null
  return {
    id: value.id,
    origin: str(value.origin),
    path: str(value.path),
    name: str(value.name) || value.id,
    description: strOrNull(value.description),
    pending_user_review: bool(value.pending_user_review),
    harness: harnessInfo(value.harness),
    backups: count(value.backups),
    cells: list(value.cells, cell),
  }
}

function nameTaken(value: unknown): NameTaken | null {
  if (!isRaw(value) || typeof value.id !== "string") return null
  return { id: value.id, pack: str(value.pack), held_by: str(value.held_by) }
}

function brokenLink(value: unknown): BrokenLink | null {
  if (!isRaw(value) || typeof value.path !== "string") return null
  return {
    path: value.path,
    dir: str(value.dir),
    target: strOrNull(value.target),
    skill: str(value.skill),
    agents: strings(value.agents),
  }
}

export function normalizeInventory(value: unknown): SkillsInventory {
  if (
    !isRaw(value) ||
    !Array.isArray(value.agents) ||
    !Array.isArray(value.skills)
  ) {
    throw new SkillsClientError(
      "invalidResponse",
      "skills_inventory answered with something that is not an inventory"
    )
  }
  return {
    store: str(value.store),
    agents: list(value.agents, agent),
    skills: list(value.skills, storeSkill),
    name_taken: list(value.name_taken, nameTaken),
    broken_links: list(value.broken_links, brokenLink),
    problems: list(value.problems, issue),
  }
}

// ─── skills_apply_links / skills_repair_link ──────────────────────────

function pathChange(value: unknown): PathChange | null {
  if (!isRaw(value) || typeof value.path !== "string") return null
  return { path: value.path, kind: str(value.kind) }
}

function pathMove(value: unknown): PathMove | null {
  if (!isRaw(value) || typeof value.from !== "string") return null
  return { from: value.from, to: str(value.to) }
}

function effects(value: Raw): SkillEffects {
  return {
    status: str(value.status),
    creates: list(value.creates, pathChange),
    removes: list(value.removes, pathChange),
    moves: list(value.moves, pathMove),
    gains: strings(value.gains),
    loses: strings(value.loses),
    touches: strings(value.touches),
    ack: strOrNull(value.ack),
    issues: list(value.issues, issue),
    warnings: list(value.warnings, issue),
  }
}

export function opResult(value: unknown): SkillOpResult | null {
  if (!isRaw(value) || typeof value.index !== "number") return null
  return {
    ...effects(value),
    index: value.index,
    skill: str(value.skill),
    agent: str(value.agent),
    action: str(value.action),
  }
}

export function normalizeApplyResult(value: unknown): SkillsApplyResult {
  if (!isRaw(value) || typeof value.outcome !== "string") {
    throw new SkillsClientError(
      "invalidResponse",
      "skills_apply_links answered with something that is not a result"
    )
  }
  return {
    outcome: value.outcome,
    ok: bool(value.ok),
    ops: list(value.ops, opResult),
    issues: list(value.issues, issue),
  }
}

export function normalizeRepairResult(value: unknown): SkillsRepairResult {
  if (!isRaw(value) || typeof value.outcome !== "string") {
    throw new SkillsClientError(
      "invalidResponse",
      "skills_repair_link answered with something that is not a result"
    )
  }
  return {
    ...effects(value),
    outcome: value.outcome,
    ok: bool(value.ok),
    path: str(value.path),
    action: str(value.action),
    skill: strOrNull(value.skill),
  }
}

// ─── skills_adopt ─────────────────────────────────────────────────────

export function normalizeAdoptResult(value: unknown): SkillsAdoptResult {
  if (!isRaw(value) || typeof value.outcome !== "string") {
    throw new SkillsClientError(
      "invalidResponse",
      "skills_adopt answered with something that is not a result"
    )
  }
  return {
    outcome: value.outcome,
    ok: bool(value.ok),
    skill: str(value.skill),
    agent: str(value.agent),
    source: strOrNull(value.source),
    store_path: strOrNull(value.store_path),
    link_path: strOrNull(value.link_path),
    mode: strOrNull(value.mode),
    restored: bool(value.restored),
    issues: list(value.issues, issue),
  }
}

// ─── Backups ──────────────────────────────────────────────────────────

function backup(value: unknown): SkillBackup | null {
  if (
    !isRaw(value) ||
    typeof value.skill !== "string" ||
    typeof value.name !== "string"
  ) {
    return null
  }
  return {
    skill: value.skill,
    name: value.name,
    path: str(value.path),
    kind: str(value.kind),
    created_at: strOrNull(value.created_at),
    agent: strOrNull(value.agent),
    linked_by: strings(value.linked_by),
  }
}

export function normalizeBackups(value: unknown): SkillsBackups {
  if (!isRaw(value) || !Array.isArray(value.backups)) {
    throw new SkillsClientError(
      "invalidResponse",
      "skills_backups answered with something that is not a list of backups"
    )
  }
  return {
    backups: list(value.backups, backup),
    problems: list(value.problems, issue),
  }
}

export function normalizeBackupResult(value: unknown): SkillsBackupResult {
  if (!isRaw(value) || typeof value.outcome !== "string") {
    throw new SkillsClientError(
      "invalidResponse",
      "a backup command answered with something that is not a result"
    )
  }
  return {
    outcome: value.outcome,
    ok: bool(value.ok),
    skill: str(value.skill),
    name: str(value.name),
    id: strOrNull(value.id),
    path: strOrNull(value.path),
    backup_kept: bool(value.backup_kept),
    issues: list(value.issues, issue),
  }
}

// ─── The Skills page's delete ─────────────────────────────────────────

export function normalizeDeleteResult(value: unknown): SkillPageDeleteResult {
  // An answer without `path` is no answer to this question — a backend that
  // returns nothing from a delete does not know a preflight either.
  if (!isRaw(value) || typeof value.path !== "string") {
    throw new SkillsClientError(
      "invalidResponse",
      "a skill delete answered with something that is not a result"
    )
  }
  return {
    deleted: bool(value.deleted),
    path: value.path,
    kind: str(value.kind),
    shared_with: uniqueAgents(strings(value.shared_with)),
    ack: strOrNull(value.ack),
  }
}

// ─── skills://changed ─────────────────────────────────────────────────

export function normalizeChanged(value: unknown): SkillsChanged {
  if (!isRaw(value)) return { kinds: [], agents: [] }
  return { kinds: strings(value.kinds), agents: strings(value.agents) }
}

// ─── The Skills page's listing ────────────────────────────────────────

const OWNERS: readonly AgentSkillOwner[] = [
  "pack",
  "harness",
  "custom",
  "agent",
  "linked_elsewhere",
  "broken",
]

/** What K1 added to a listed skill, as this build reads it. */
export interface AgentSkillFacts {
  /** Where the entry's link points; `null` for a real folder or file. */
  linkTarget: string | null
  /** `null` from a backend that does not say (or says something new). */
  owner: AgentSkillOwner | null
  /** The raw owner, for an owner this build does not know. */
  ownerRaw: string | null
  pack: string | null
  codegCopy: boolean
}

export function agentSkillFacts(item: AgentSkillItem): AgentSkillFacts {
  const raw = item as unknown as Raw
  const owner = str(raw.owner)
  const known = (OWNERS as readonly string[]).includes(owner)
    ? (owner as AgentSkillOwner)
    : null
  return {
    linkTarget: strOrNull(raw.link_target),
    owner: known,
    ownerRaw: owner || null,
    pack: strOrNull(raw.pack),
    codegCopy: bool(raw.codeg_copy),
  }
}

/** The listing as the page relies on it: a list of skills, each with an id. */
export function normalizeAgentSkills(value: unknown): AgentSkillsListResult {
  if (!isRaw(value) || !Array.isArray(value.skills)) {
    throw new SkillsClientError(
      "invalidResponse",
      "acp_list_agent_skills answered with something that is not a listing"
    )
  }
  return {
    supported: bool(value.supported, true),
    message: strOrNull(value.message),
    locations: list(value.locations, (item) =>
      isRaw(item) && typeof item.path === "string"
        ? {
            scope: item.scope === "project" ? "project" : "global",
            path: item.path,
            exists: bool(item.exists),
          }
        : null
    ),
    skills: list(value.skills, (item) =>
      isRaw(item) &&
      typeof item.id === "string" &&
      typeof item.path === "string"
        ? (item as unknown as AgentSkillItem)
        : null
    ),
  }
}

/** Agents named in an answer, deduplicated, in order. */
export function uniqueAgents(agents: readonly AgentType[]): AgentType[] {
  return [...new Set(agents)]
}
