/**
 * What the skills inventory comes to, for the page: every store skill and
 * every agent, and — for one skill and one agent — what its cell means in
 * words and what flipping its switch would ask of the engine.
 *
 * The engine decides every state; nothing here second-guesses it. What is
 * worked out here is only what the page needs to present the engine's rules
 * truthfully: a cell that is on through a shared directory is said to be so,
 * turning it off is planned first (the others lose it too), and a cell that
 * cannot be switched says why instead of offering a switch that would fail.
 */
import type { AgentType } from "@/lib/types"
import {
  isPackOrigin,
  type BrokenLink,
  type NameTaken,
  type PackOrigin,
  type SkillCell,
  type SkillsAgent,
  type SkillsInventory,
  type SkillsIssue,
  type StoreSkill,
} from "./types"

export interface SkillsModel {
  inventory: SkillsInventory
  /** Every agent with a skill store, in the engine's order. */
  agents: readonly SkillsAgent[]
  agent: (id: string) => SkillsAgent | undefined
  skill: (id: string) => StoreSkill | undefined
  cell: (skillId: string, agentId: string) => SkillCell | undefined
  /** The store's Custom and Harness skills — the Skills section's own. */
  managed: readonly StoreSkill[]
  /** A pack's skills in the store, by id. */
  packSkills: (pack: PackOrigin) => ReadonlyMap<string, StoreSkill>
  /** Pack ids another origin holds, by id. */
  nameTaken: ReadonlyMap<string, NameTaken>
  /** Codeg's broken links pointing at a skill, by its id. */
  brokenOf: (skillId: string) => readonly BrokenLink[]
  /** Codeg's broken links whose skill is no longer in the store. */
  orphanBroken: readonly BrokenLink[]
  /** Every id the store holds or a pack claims — what a new Custom skill
   *  cannot be called. */
  takenIds: ReadonlySet<string>
  /** The inventory's problems about one store skill's folder. */
  problemsOf: (skillId: string) => readonly SkillsIssue[]
  /** The inventory's problems about no store skill: a manifest, the link
   *  record. */
  looseProblems: readonly SkillsIssue[]
  /** A folder under `pack`'s `id` that nobody can tell is the pack's
   *  (`ownership_unresolved`): it reads as Custom, the pack's entry as
   *  name taken. */
  unresolved: (pack: string, id: string) => SkillsIssue | undefined
}

/** A path as a key: the same folder with or without a trailing separator. */
const pathKey = (path: string) => path.replace(/[\\/]+$/, "")

const byName = (a: StoreSkill, b: StoreSkill) =>
  a.name.localeCompare(b.name) || a.id.localeCompare(b.id)

export function buildModel(inventory: SkillsInventory): SkillsModel {
  const agents = new Map(inventory.agents.map((agent) => [agent.agent, agent]))
  const skills = new Map(inventory.skills.map((skill) => [skill.id, skill]))
  const cells = new Map<string, SkillCell>()
  for (const skill of inventory.skills) {
    for (const cell of skill.cells)
      cells.set(`${skill.id}\u0000${cell.agent}`, cell)
  }
  const packs = new Map<PackOrigin, Map<string, StoreSkill>>()
  for (const skill of inventory.skills) {
    if (!isPackOrigin(skill.origin)) continue
    const pack = packs.get(skill.origin) ?? new Map<string, StoreSkill>()
    pack.set(skill.id, skill)
    packs.set(skill.origin, pack)
  }
  const broken = new Map<string, BrokenLink[]>()
  const orphans: BrokenLink[] = []
  for (const link of inventory.broken_links) {
    if (skills.has(link.skill)) {
      const of = broken.get(link.skill) ?? []
      of.push(link)
      broken.set(link.skill, of)
    } else {
      orphans.push(link)
    }
  }
  const nameTaken = new Map(
    inventory.name_taken.map((taken) => [taken.id, taken])
  )
  const takenIds = new Set<string>([...skills.keys(), ...nameTaken.keys()])
  const empty = new Map<string, StoreSkill>()
  const byPath = new Map(
    inventory.skills.map((skill) => [pathKey(skill.path), skill.id])
  )
  const problems = new Map<string, SkillsIssue[]>()
  const loose: SkillsIssue[] = []
  const unresolved = new Map<string, SkillsIssue>()
  for (const problem of inventory.problems) {
    const owner = problem.path ? byPath.get(pathKey(problem.path)) : undefined
    if (owner === undefined) {
      loose.push(problem)
    } else {
      const of = problems.get(owner) ?? []
      of.push(problem)
      problems.set(owner, of)
    }
    if (problem.code === "ownership_unresolved" && problem.path) {
      const id = baseName(problem.path)
      unresolved.set(`${problem.detail ?? ""}\u0000${id}`, problem)
    }
  }
  return {
    inventory,
    agents: inventory.agents,
    agent: (id) => agents.get(id),
    skill: (id) => skills.get(id),
    cell: (skillId, agentId) => cells.get(`${skillId}\u0000${agentId}`),
    managed: inventory.skills
      .filter(
        (skill) => skill.origin === "custom" || skill.origin === "harness"
      )
      .sort(byName),
    packSkills: (pack) => packs.get(pack) ?? empty,
    nameTaken,
    brokenOf: (skillId) => broken.get(skillId) ?? [],
    orphanBroken: orphans,
    takenIds,
    problemsOf: (skillId) => problems.get(skillId) ?? [],
    looseProblems: loose,
    unresolved: (pack, id) => unresolved.get(`${pack}\u0000${id}`),
  }
}

// ─── One cell ─────────────────────────────────────────────────────────

/**
 * What a cell is, as the page tells it:
 *
 * - `on` — Codeg's link, in a directory of the agent's own.
 * - `through` — Codeg's link in a shared directory the agent reads: the
 *   others that read it see the same link.
 * - `copy` — Codeg's copy where no link could be made; it is not updated by
 *   itself. `copyOutdated`: it still is what Codeg copied, but the skill has
 *   changed since. `copyChanged`: it was changed on the agent's side.
 * - `off` — nothing of the skill's name there.
 * - `blocked` — a real folder or file holds the name.
 * - `elsewhere` — a link to somewhere else holds the name.
 * - `broken` — a broken link Codeg made (repair or remove it);
 *   `brokenOther` — one it did not make.
 * - `unknown` — a state this build does not know.
 */
export type CellKind =
  | "on"
  | "through"
  | "copy"
  | "copyOutdated"
  | "copyChanged"
  | "off"
  | "blocked"
  | "elsewhere"
  | "broken"
  | "brokenOther"
  | "unknown"

export interface CellView {
  kind: CellKind
  /** The agent sees Codeg's skill: the switch is on. */
  on: boolean
  /** What flipping the switch asks of the engine; `null`: it cannot be
   *  flipped, and {@link CellView.why} or the kind says why. */
  toggle: "enable" | "disable" | null
  /** The flip may reach other agents: it is planned, and shown, first. */
  check: boolean
  /** "Only for this agent" is on offer: Codeg's link is in a shared
   *  directory and the agent has one of its own to move it to. */
  only: boolean
  /** The broken link Codeg made that holds the name, to repair or remove. */
  brokenPath: string | null
  /** Why an off cell cannot be switched on. */
  why: "noDirectory" | "notReady" | null
}

const CODEG_LIVE = new Set(["codeg_link", "codeg_copy"])

/** Codeg's link or copy of the skill sits in a shared directory the agent
 *  reads: turning it off there turns it off for the other readers too. */
function inSharedDirectory(cell: SkillCell): boolean {
  return cell.entries.some(
    (entry) => entry.dir_role === "shared" && CODEG_LIVE.has(entry.kind)
  )
}

export function hasOwnDirectory(agent: SkillsAgent | undefined): boolean {
  return agent?.dirs.some((dir) => dir.role === "own") ?? false
}

/**
 * The cell of `skill` for `agent`, as the page presents it. `ready` is false
 * for a skill that cannot be switched on at all (a pack skill whose name is
 * taken, an Office skill not synced yet).
 */
export function cellView(
  cell: SkillCell | undefined,
  agent: SkillsAgent | undefined,
  ready = true
): CellView {
  const base: CellView = {
    kind: "off",
    on: false,
    toggle: null,
    check: false,
    only: false,
    brokenPath: null,
    why: null,
  }
  switch (cell?.state ?? "not_linked") {
    case "linked":
      return {
        ...base,
        kind: "on",
        on: true,
        toggle: "disable",
        check: cell ? inSharedDirectory(cell) : false,
      }
    case "visible_through":
      return {
        ...base,
        kind: "through",
        on: true,
        toggle: "disable",
        check: true,
        only: hasOwnDirectory(agent),
      }
    case "copy": {
      // A copy changed on the agent's side is never taken away by turning
      // the skill off (the engine keeps it): the switch would not move.
      if (cell?.copy_matches === false) {
        return { ...base, kind: "copyChanged", on: true }
      }
      return {
        ...base,
        kind: cell?.copy_current === false ? "copyOutdated" : "copy",
        on: true,
        toggle: "disable",
        check: cell ? inSharedDirectory(cell) : false,
      }
    }
    case "linked_elsewhere":
      return { ...base, kind: "elsewhere" }
    case "blocked":
      return { ...base, kind: "blocked" }
    case "broken": {
      if (!cell?.codeg) return { ...base, kind: "brokenOther" }
      const entry = cell.entries.find((item) => item.kind === "codeg_broken")
      return { ...base, kind: "broken", brokenPath: entry?.path ?? cell.path }
    }
    case "not_linked": {
      if (!agent?.link_dir) return { ...base, why: "noDirectory" }
      if (!ready) return { ...base, why: "notReady" }
      return {
        ...base,
        toggle: "enable",
        check: agent.link_dir_shared,
      }
    }
    default:
      return { ...base, kind: "unknown" }
  }
}

/** The agents that see Codeg's skill — what "enabled" means to the chat. */
export function seenBy(skill: StoreSkill): AgentType[] {
  return skill.cells
    .filter(
      (cell) =>
        cell.state === "linked" ||
        cell.state === "visible_through" ||
        cell.state === "copy"
    )
    .map((cell) => cell.agent)
}

/** Whether a cell is worth a warning in a list: something is in the way, a
 *  link is broken, or a copy was changed on the agent's side. */
export function isProblemKind(kind: CellKind): boolean {
  return (
    kind === "blocked" ||
    kind === "elsewhere" ||
    kind === "broken" ||
    kind === "brokenOther" ||
    kind === "copyChanged" ||
    kind === "unknown"
  )
}

/** The directory an agent reads that holds `path`, when it is one of its
 *  global ones. */
export function directoryOf(
  agent: SkillsAgent | undefined,
  path: string
): SkillsAgent["dirs"][number] | undefined {
  if (!agent) return undefined
  const parent = parentOf(path)
  return agent.dirs.find((dir) => samePath(dir.path, parent))
}

/** The folder a path is in: what is left once its last part is cut. A
 *  backslash counts only in a path that reads as a Windows one. */
export function parentOf(path: string): string {
  const windows = /^([A-Za-z]:|\\\\)/.test(path)
  const trimmed = path.replace(windows ? /[\\/]+$/ : /\/+$/, "")
  const cut = windows
    ? Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
    : trimmed.lastIndexOf("/")
  return cut <= 0 ? trimmed : trimmed.slice(0, cut)
}

/** The last part of a path. */
export function baseName(path: string): string {
  const windows = /^([A-Za-z]:|\\\\)/.test(path)
  const trimmed = path.replace(windows ? /[\\/]+$/ : /\/+$/, "")
  const cut = windows
    ? Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
    : trimmed.lastIndexOf("/")
  return trimmed.slice(cut + 1)
}

function samePath(a: string, b: string): boolean {
  const strip = (value: string) => value.replace(/[\\/]+$/, "")
  return strip(a) === strip(b)
}
