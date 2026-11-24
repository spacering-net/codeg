/**
 * A stand-in skills engine for tests: a small world of agents, store skills
 * and their cells, agents' own listings, contents and backups, and the
 * commands the Skills and Skill-packs sections send, answered the way the
 * engine answers them (k1-api) — including the acknowledgement rules: an op
 * that reaches other agents goes through only with the `ack` of its current
 * effects, and nothing is written when it is missing or stale.
 */
import type { AgentSkillItem, AgentType } from "@/lib/types"
import type {
  AgentSkillDir,
  BrokenLink,
  CellEntry,
  NameTaken,
  SkillBackup,
  SkillCell,
  SkillOp,
  SkillOpResult,
  SkillsAgent,
  SkillsApplyResult,
  SkillsChanged,
  SkillsInventory,
  SkillsIssue,
  StoreSkill,
} from "./types"

export const HOME = "/home/u"
export const STORE = `${HOME}/.codeg/skills`
export const SHARED_DIR = `${HOME}/.agents/skills`

export const ownDir = (agent: string) => `${HOME}/.${agent}/skills`

export interface AgentSpec {
  agent: AgentType
  /** Has a directory of its own (default). */
  own?: boolean
  /** Also reads `~/.agents/skills`. */
  shared?: boolean
}

export function agentsOf(specs: AgentSpec[]): SkillsAgent[] {
  const readers = specs.filter((spec) => spec.shared).map((spec) => spec.agent)
  return specs.map((spec) => {
    const dirs: AgentSkillDir[] = []
    if (spec.own !== false) {
      dirs.push({
        path: ownDir(spec.agent),
        role: "own",
        shared_with: [],
        exists: true,
      })
    }
    if (spec.shared) {
      dirs.push({
        path: SHARED_DIR,
        role: readers.length > 1 ? "shared" : "own",
        shared_with: readers.filter((agent) => agent !== spec.agent),
        exists: true,
      })
    }
    const own = dirs.find((dir) => dir.role === "own")
    const shared = dirs.find((dir) => dir.role === "shared")
    return {
      agent: spec.agent,
      dirs,
      link_dir: own?.path ?? shared?.path ?? null,
      link_dir_shared: !own && Boolean(shared),
    }
  })
}

export type CellSpec =
  | "off"
  | "linked"
  | "through"
  | "copy"
  | "copyOutdated"
  | "copyChanged"
  | "blocked"
  | "elsewhere"
  | "broken"
  | "brokenOther"
  | { state: string }

export interface SkillSpec {
  id: string
  origin?: string
  name?: string
  description?: string | null
  harness?: { ref: string | null; version: string | null }
  pending?: boolean
  backups?: number
  content?: string
  /** By agent; agents not named are off. */
  cells?: Record<string, CellSpec>
}

export interface ListingSpec {
  id: string
  owner?: string
  pack?: string | null
  linkTarget?: string | null
  readOnly?: boolean
  codegCopy?: boolean
  layout?: "skill_directory" | "markdown_file"
  dir?: string
  description?: string | null
  content?: string
}

export interface EngineOptions {
  agents: AgentSpec[]
  skills?: SkillSpec[]
  nameTaken?: NameTaken[]
  broken?: BrokenLink[]
  backups?: SkillBackup[]
  /** The inventory's problems. */
  problems?: SkillsIssue[]
  /** The By-agent listings, by `agent|scope|folder`. */
  listings?: Record<string, ListingSpec[]>
}

interface StoredSkill {
  spec: SkillSpec
  cells: Map<string, SkillCell>
}

export interface CallRecord {
  command: string
  args: Record<string, unknown>
}

export interface Engine {
  /** Answers a command as the backend would; throws for one it does not
   *  know, so a test notices a command it did not expect. */
  handle: (command: string, args?: Record<string, unknown>) => unknown
  calls: CallRecord[]
  /** The real (not preflight) runs of `skills_apply_links`. */
  writes: () => SkillOp[][]
  /** What the effects of every op are measured against: bump it to make
   *  every ack handed out so far stale. */
  bumpEffects: () => void
  /** Called after every write, with what the backend would announce. */
  onChanged?: (change: SkillsChanged) => void
  /** Override one command's answer; return `undefined` to fall through. */
  answer: Record<string, (args: Record<string, unknown>) => unknown>
  skillContent: Map<string, string>
  agentContent: Map<string, string>
  inventory: () => SkillsInventory
  setCell: (skill: string, agent: string, cell: CellSpec) => void
  listings: Map<string, ListingSpec[]>
  backups: SkillBackup[]
}

function cellOf(
  agent: SkillsAgent,
  skill: string,
  spec: CellSpec,
  agents: SkillsAgent[]
): SkillCell {
  const own = agent.dirs.find((dir) => dir.role === "own")?.path ?? null
  const sharedDir = agent.dirs.find((dir) => dir.role === "shared")
  const base: SkillCell = {
    agent: agent.agent,
    state: "not_linked",
    path: null,
    dir: null,
    dir_role: null,
    target: null,
    codeg: false,
    copy_matches: null,
    copy_current: null,
    shared_with: [],
    entries: [],
  }
  const entry = (
    dir: string,
    role: string,
    kind: string,
    extra: Partial<CellEntry> = {}
  ): CellEntry => ({
    path: `${dir}/${skill}`,
    dir,
    dir_role: role,
    kind,
    ...extra,
  })
  const at = (
    dir: string,
    role: string,
    kind: string,
    extra: Partial<SkillCell> = {},
    entryExtra: Partial<CellEntry> = {}
  ): SkillCell => ({
    ...base,
    path: `${dir}/${skill}`,
    dir,
    dir_role: role,
    entries: [entry(dir, role, kind, entryExtra)],
    ...extra,
  })
  if (typeof spec === "object") return { ...base, state: spec.state }
  const target = `${STORE}/${skill}`
  switch (spec) {
    case "off":
      return base
    case "linked":
      return at(
        own ?? SHARED_DIR,
        "own",
        "codeg_link",
        { state: "linked", codeg: true, target },
        { target }
      )
    case "through": {
      const others = agents
        .filter(
          (other) =>
            other.agent !== agent.agent &&
            other.dirs.some((dir) => dir.path === SHARED_DIR)
        )
        .map((other) => other.agent)
      return at(
        SHARED_DIR,
        "shared",
        "codeg_link",
        {
          state: "visible_through",
          codeg: true,
          target,
          shared_with: sharedDir?.shared_with ?? others,
        },
        { target }
      )
    }
    case "copy":
    case "copyOutdated":
    case "copyChanged": {
      const matches = spec !== "copyChanged"
      const current = spec === "copy"
      return at(
        own ?? SHARED_DIR,
        "own",
        "codeg_copy",
        {
          state: "copy",
          codeg: true,
          copy_matches: matches,
          copy_current: current,
        },
        { copy_matches: matches, copy_current: current }
      )
    }
    case "blocked":
      return at(own ?? SHARED_DIR, "own", "folder", { state: "blocked" })
    case "elsewhere":
      return at(
        own ?? SHARED_DIR,
        "own",
        "link",
        {
          state: "linked_elsewhere",
          target: `${HOME}/elsewhere/${skill}`,
        },
        { target: `${HOME}/elsewhere/${skill}` }
      )
    case "broken":
      return at(own ?? SHARED_DIR, "own", "codeg_broken", {
        state: "broken",
        codeg: true,
        target,
      })
    case "brokenOther":
      return at(own ?? SHARED_DIR, "own", "broken_link", { state: "broken" })
  }
}

export function createEngine(options: EngineOptions): Engine {
  const agents = agentsOf(options.agents)
  const skills = new Map<string, StoredSkill>()
  const skillContent = new Map<string, string>()
  const agentContent = new Map<string, string>()
  const listings = new Map<string, ListingSpec[]>(
    Object.entries(options.listings ?? {})
  )
  const backups = [...(options.backups ?? [])]
  let broken = [...(options.broken ?? [])]
  let effectsVersion = 1
  const calls: CallRecord[] = []
  const applied: SkillOp[][] = []

  const addSkill = (spec: SkillSpec) => {
    const cells = new Map<string, SkillCell>()
    for (const agent of agents) {
      cells.set(
        agent.agent,
        cellOf(agent, spec.id, spec.cells?.[agent.agent] ?? "off", agents)
      )
    }
    skills.set(spec.id, { spec, cells })
    skillContent.set(
      spec.id,
      spec.content ??
        `---\nname: ${spec.id}\ndescription: ${spec.description ?? "A skill"}\n---\n\n# ${spec.id}\n`
    )
  }
  for (const spec of options.skills ?? []) addSkill(spec)

  const inventory = (): SkillsInventory => ({
    store: STORE,
    agents: structuredClone(agents),
    skills: [...skills.values()].map(
      ({ spec, cells }): StoreSkill => ({
        id: spec.id,
        origin: spec.origin ?? "custom",
        path: `${STORE}/${spec.id}`,
        name: spec.name ?? spec.id,
        description: spec.description ?? null,
        pending_user_review: spec.pending ?? false,
        harness: spec.harness ?? null,
        backups:
          spec.backups ??
          backups.filter((backup) => backup.skill === spec.id).length,
        cells: agents.map((agent) => structuredClone(cells.get(agent.agent)!)),
      })
    ),
    name_taken: structuredClone(options.nameTaken ?? []),
    broken_links: structuredClone(broken),
    problems: structuredClone(options.problems ?? []),
  })

  const readersOf = (dir: string) =>
    agents
      .filter((agent) => agent.dirs.some((item) => item.path === dir))
      .map((agent) => agent.agent)

  const engine: Engine = {
    calls,
    writes: () => applied,
    bumpEffects: () => {
      effectsVersion += 1
    },
    answer: {},
    skillContent,
    agentContent,
    listings,
    backups,
    inventory,
    setCell: (skill, agent, spec) => {
      const stored = skills.get(skill)
      const info = agents.find((item) => item.agent === agent)
      if (stored && info)
        stored.cells.set(agent, cellOf(info, skill, spec, agents))
    },
    handle: () => undefined,
  }

  const announce = (change: SkillsChanged) => engine.onChanged?.(change)

  /** The plan of one op against the world as it is now. */
  function plan(op: SkillOp, index: number): SkillOpResult {
    const agent = agents.find((item) => item.agent === op.agent)
    const stored = skills.get(op.skill)
    const cell = stored?.cells.get(op.agent)
    const result: SkillOpResult = {
      index,
      skill: op.skill,
      agent: op.agent,
      action: op.action,
      status: "ready",
      creates: [],
      removes: [],
      moves: [],
      gains: [],
      loses: [],
      touches: [],
      ack: null,
      issues: [],
      warnings: [],
    }
    if (!agent) {
      result.status = "blocked"
      result.issues.push({ code: "agent_unsupported" })
      return result
    }
    if (!stored && op.action !== "disable") {
      result.status = "blocked"
      result.issues.push({ code: "skill_not_found" })
      return result
    }
    const on =
      cell?.state === "linked" ||
      cell?.state === "visible_through" ||
      cell?.state === "copy"
    switch (op.action) {
      case "enable":
        if (on) {
          result.status = "unchanged"
          result.warnings.push({
            code: "already_visible",
            path: cell?.path ?? undefined,
          })
        } else if (cell?.state === "blocked") {
          result.status = "blocked"
          result.issues.push({
            code: "target_occupied",
            path: cell.path ?? undefined,
          })
        } else if (!agent.link_dir) {
          result.status = "blocked"
          result.issues.push({ code: "agent_unsupported" })
        } else {
          result.creates.push({
            path: `${agent.link_dir}/${op.skill}`,
            kind: "link",
          })
          if (agent.link_dir_shared) {
            result.gains = readersOf(agent.link_dir).filter(
              (item) => item !== op.agent
            )
            result.warnings.push({
              code: "shared_directory",
              path: agent.link_dir,
              agents: result.gains,
            })
          }
        }
        break
      case "disable":
        if (!on) {
          result.status = "unchanged"
        } else if (cell?.dir_role === "shared") {
          result.removes.push({ path: cell.path ?? "", kind: "link" })
          result.loses = cell.shared_with
          result.warnings.push({
            code: "disabled_together",
            agents: cell.shared_with,
          })
        } else {
          result.removes.push({
            path: cell?.path ?? "",
            kind: cell?.state === "copy" ? "copy" : "link",
          })
        }
        break
      case "only": {
        const own = agent.dirs.find((dir) => dir.role === "own")
        if (!own) {
          result.status = "blocked"
          result.issues.push({ code: "no_own_directory" })
        } else if (cell?.state !== "visible_through") {
          result.status = on ? "unchanged" : "blocked"
          if (!on) result.issues.push({ code: "not_visible" })
        } else {
          result.moves.push({
            from: cell.path ?? "",
            to: `${own.path}/${op.skill}`,
          })
          result.loses = cell.shared_with
        }
        break
      }
      case "refresh":
        if (cell?.state !== "copy") {
          result.status = "unchanged"
          result.warnings.push({ code: "no_copy" })
        } else if (cell.copy_matches === false && !op.replace_modified) {
          result.status = "blocked"
          result.issues.push({
            code: "copy_modified",
            path: cell.path ?? undefined,
          })
        } else {
          result.removes.push({ path: cell.path ?? "", kind: "copy" })
          result.creates.push({ path: cell.path ?? "", kind: "copy" })
        }
        break
    }
    if (result.gains.length || result.loses.length || result.touches.length) {
      result.ack = `ack-${op.skill}-${op.agent}-${op.action}-${effectsVersion}`
      if (result.status === "ready") result.status = "needs_ack"
    }
    return result
  }

  function carryOut(op: SkillOp) {
    const stored = skills.get(op.skill)
    if (!stored) return
    const agent = agents.find((item) => item.agent === op.agent)!
    const set = (who: string, spec: CellSpec) => {
      const info = agents.find((item) => item.agent === who)
      if (info) stored.cells.set(who, cellOf(info, op.skill, spec, agents))
    }
    const cell = stored.cells.get(op.agent)
    switch (op.action) {
      case "enable":
        if (agent.link_dir_shared) {
          for (const who of readersOf(agent.link_dir ?? "")) set(who, "through")
        } else {
          set(op.agent, "linked")
        }
        break
      case "disable":
        if (cell?.dir_role === "shared") {
          for (const who of [op.agent, ...cell.shared_with]) set(who, "off")
        } else {
          set(op.agent, "off")
        }
        break
      case "only":
        for (const who of cell?.shared_with ?? []) set(who, "off")
        set(op.agent, "linked")
        break
      case "refresh":
        set(op.agent, "copy")
        break
    }
  }

  function apply(args: Record<string, unknown>): SkillsApplyResult {
    const ops = args.ops as SkillOp[]
    const preflight = args.preflight === true
    const plans = ops.map(plan)
    const blocked = plans.some((item) => item.status === "blocked")
    if (preflight) {
      return { outcome: "preflight", ok: !blocked, ops: plans, issues: [] }
    }
    if (blocked) {
      return {
        outcome: "invalid",
        ok: false,
        issues: [],
        ops: plans.map((item) =>
          item.status === "blocked" ? item : { ...item, status: "not_done" }
        ),
      }
    }
    const unacked = plans.filter(
      (item, index) => item.ack !== null && ops[index].ack !== item.ack
    )
    if (unacked.length > 0) {
      return {
        outcome: "acknowledgement_required",
        ok: false,
        issues: [],
        ops: plans.map((item, index) =>
          item.ack !== null && ops[index].ack !== item.ack
            ? {
                ...item,
                status: "needs_ack",
                issues: [
                  {
                    code: ops[index].ack
                      ? "effects_changed"
                      : "acknowledgement_required",
                    agents: [...item.gains, ...item.loses, ...item.touches],
                  },
                ],
              }
            : { ...item, status: "not_done" }
        ),
      }
    }
    applied.push(structuredClone(ops))
    for (const op of ops) carryOut(op)
    announce({ kinds: ["links"], agents: ops.map((op) => op.agent) })
    return {
      outcome: "applied",
      ok: true,
      issues: [],
      ops: plans.map((item) => ({
        ...item,
        status: item.status === "unchanged" ? "unchanged" : "done",
      })),
    }
  }

  const listingItems = (key: string): AgentSkillItem[] =>
    (listings.get(key) ?? []).map((spec) => {
      const [agent, scope] = key.split("|")
      const dir =
        spec.dir ??
        (scope === "global"
          ? ownDir(agent)
          : `${key.split("|")[2]}/.${agent}/skills`)
      return {
        id: spec.id,
        name: spec.id,
        scope: scope === "project" ? "project" : "global",
        layout: spec.layout ?? "skill_directory",
        path:
          spec.layout === "markdown_file"
            ? `${dir}/${spec.id}.md`
            : `${dir}/${spec.id}`,
        description: spec.description ?? null,
        read_only: spec.readOnly ?? false,
        link_target: spec.linkTarget ?? null,
        owner: spec.owner ?? "agent",
        pack: spec.pack ?? null,
        codeg_copy: spec.codegCopy ?? false,
      }
    })

  const coded = (code: string, message = code, detail?: string) => ({
    code: "invalid_input",
    message,
    i18n_key: `errors.${code}`,
    i18n_params: { code, ...(detail ? { detail } : {}) },
  })

  engine.handle = (command, rawArgs = {}) => {
    const args = rawArgs as Record<string, unknown>
    calls.push({ command, args: structuredClone(args) })
    const custom = engine.answer[command]?.(args)
    if (custom !== undefined) {
      if (custom instanceof Error) throw custom
      return structuredClone(custom)
    }
    switch (command) {
      case "skills_inventory":
        return inventory()
      case "skills_backups": {
        const skill = args.skill as string | null
        return {
          backups: structuredClone(
            backups.filter((backup) => !skill || backup.skill === skill)
          ),
          problems: [],
        }
      }
      case "skills_apply_links":
        return apply(args)
      case "skills_repair_link": {
        const path = args.path as string
        const link = broken.find((item) => item.path === path)
        const shared = link?.dir === SHARED_DIR
        const repoint = args.action === "repoint"
        const gains = repoint && shared ? link.agents.slice(1) : []
        const ack = gains.length ? `ack-repair-${path}-${effectsVersion}` : null
        const base = {
          ok: true,
          path,
          action: args.action,
          skill: link?.skill ?? null,
          creates: repoint ? [{ path, kind: "link" }] : [],
          removes: [{ path, kind: "broken_link" }],
          moves: [],
          gains,
          loses: [],
          touches: [],
          ack,
          issues: [],
          warnings: [],
        }
        if (!link) {
          return {
            ...base,
            outcome: "invalid",
            ok: false,
            status: "blocked",
            issues: [{ code: "not_found" }],
          }
        }
        if (args.preflight) {
          return {
            ...base,
            outcome: "preflight",
            status: ack ? "needs_ack" : "ready",
          }
        }
        if (ack && args.ack !== ack) {
          return {
            ...base,
            outcome: "acknowledgement_required",
            ok: false,
            status: "needs_ack",
            issues: [
              {
                code: args.ack ? "effects_changed" : "acknowledgement_required",
              },
            ],
          }
        }
        broken = broken.filter((item) => item.path !== path)
        const stored = skills.get(link.skill)
        if (stored) {
          for (const who of link.agents) {
            const info = agents.find((item) => item.agent === who)
            if (info) {
              stored.cells.set(
                who,
                cellOf(
                  info,
                  link.skill,
                  repoint ? (shared ? "through" : "linked") : "off",
                  agents
                )
              )
            }
          }
        }
        announce({ kinds: ["links"], agents: link.agents })
        return { ...base, outcome: "applied", status: "done" }
      }
      case "skills_adopt": {
        const agent = args.agent as string
        const skill = args.skill as string
        if (skills.has(skill)) {
          return {
            outcome: "invalid",
            ok: false,
            skill,
            agent,
            source: null,
            store_path: null,
            link_path: null,
            mode: null,
            restored: false,
            issues: [{ code: "id_taken", path: `${STORE}/${skill}` }],
          }
        }
        addSkill({ id: skill, origin: "custom", cells: { [agent]: "linked" } })
        for (const [key, items] of listings) {
          if (key.startsWith(`${agent}|global`)) {
            listings.set(
              key,
              items.map((item) =>
                item.id === skill
                  ? {
                      ...item,
                      owner: "custom",
                      linkTarget: `${STORE}/${skill}`,
                    }
                  : item
              )
            )
          }
        }
        announce({ kinds: ["store", "links", "agent_skills"], agents: [agent] })
        return {
          outcome: "adopted",
          ok: true,
          skill,
          agent,
          source: `${ownDir(agent)}/${skill}`,
          store_path: `${STORE}/${skill}`,
          link_path: `${ownDir(agent)}/${skill}`,
          mode: "symlink",
          restored: false,
          issues: [],
        }
      }
      case "skills_backup_restore": {
        const id = args.id as string
        if (skills.has(id)) {
          return {
            outcome: "invalid",
            ok: false,
            skill: args.skill,
            name: args.name,
            id: null,
            path: null,
            backup_kept: false,
            issues: [{ code: "id_taken" }],
          }
        }
        const index = backups.findIndex(
          (backup) => backup.skill === args.skill && backup.name === args.name
        )
        if (index < 0) {
          return {
            outcome: "invalid",
            ok: false,
            skill: args.skill,
            name: args.name,
            id: null,
            path: null,
            backup_kept: false,
            issues: [{ code: "backup_not_found" }],
          }
        }
        backups.splice(index, 1)
        addSkill({ id, origin: "custom" })
        announce({ kinds: ["store", "backups"], agents: [] })
        return {
          outcome: "restored",
          ok: true,
          skill: args.skill,
          name: args.name,
          id,
          path: `${STORE}/${id}`,
          backup_kept: false,
          issues: [],
        }
      }
      case "skills_backup_delete": {
        const index = backups.findIndex(
          (backup) => backup.skill === args.skill && backup.name === args.name
        )
        const backup = backups[index]
        if (backup && backup.linked_by.length > 0) {
          return {
            outcome: "invalid",
            ok: false,
            skill: args.skill,
            name: args.name,
            id: null,
            path: null,
            backup_kept: false,
            issues: [{ code: "backup_linked", agents: backup.linked_by }],
          }
        }
        if (index >= 0) backups.splice(index, 1)
        announce({ kinds: ["backups"], agents: [] })
        return {
          outcome: "deleted",
          ok: true,
          skill: args.skill,
          name: args.name,
          id: null,
          path: null,
          backup_kept: false,
          issues: [],
        }
      }
      case "custom_read_skill": {
        const content = skillContent.get(args.id as string)
        if (content === undefined) throw coded("not_found")
        return content
      }
      case "custom_create_skill": {
        const id = args.id as string
        if (skills.has(id))
          throw coded("id_taken", `a skill with id '${id}' already exists`)
        addSkill({ id, origin: "custom", content: args.content as string })
        announce({ kinds: ["store"], agents: [] })
        return {
          id,
          name: id,
          description: null,
          central_path: `${STORE}/${id}`,
        }
      }
      case "custom_save_skill": {
        const id = args.id as string
        skillContent.set(id, args.content as string)
        announce({ kinds: ["store"], agents: [] })
        return {
          id,
          name: id,
          description: null,
          central_path: `${STORE}/${id}`,
        }
      }
      case "custom_duplicate_skill": {
        const newId = args.newId as string
        if (skills.has(newId)) throw coded("id_taken")
        addSkill({
          id: newId,
          origin: "custom",
          content: skillContent.get(args.sourceId as string),
        })
        announce({ kinds: ["store"], agents: [] })
        return {
          id: newId,
          name: newId,
          description: null,
          central_path: `${STORE}/${newId}`,
        }
      }
      case "custom_delete_skills": {
        const ids = args.ids as string[]
        for (const id of ids) skills.delete(id)
        announce({
          kinds: ["store", "links"],
          agents: agents.map((agent) => agent.agent),
        })
        return ids.map((id) => ({ id, ok: true, error: null, code: null }))
      }
      case "custom_import_skill": {
        const id = String(args.sourcePath).split("/").pop() ?? "imported"
        addSkill({ id, origin: "custom" })
        return {
          id,
          name: id,
          description: null,
          central_path: `${STORE}/${id}`,
        }
      }
      case "acp_list_agent_skills": {
        const agent = args.agentType as string
        const folder = (args.workspacePath as string | null) ?? null
        const global = listingItems(`${agent}|global`)
        const project = folder ? listingItems(`${agent}|project|${folder}`) : []
        // As the listing has it: the first folder the agent reads — the
        // shared one, for those that read it (Cline reads it first).
        const info = agents.find((item) => item.agent === agent)
        const readsShared =
          info?.dirs.some((dir) => dir.path === SHARED_DIR) ?? false
        return {
          supported: true,
          message: null,
          locations: [
            {
              scope: "global",
              path: readsShared ? SHARED_DIR : ownDir(agent),
              exists: true,
            },
            ...(folder
              ? [
                  {
                    scope: "project",
                    path: `${folder}/.${agent}/skills`,
                    exists: true,
                  },
                ]
              : []),
          ],
          skills: [...global, ...project],
        }
      }
      case "acp_read_agent_skill": {
        const key = `${args.agentType}|${args.skillId}`
        const items = [...listings.entries()].flatMap(([listingKey, specs]) =>
          listingKey.startsWith(`${args.agentType}|`) ? specs : []
        )
        const spec = items.find((item) => item.id === args.skillId)
        const content =
          agentContent.get(key) ??
          spec?.content ??
          `---\nname: ${args.skillId}\n---\n\n# ${args.skillId}\n`
        return {
          skill: {
            id: args.skillId,
            name: args.skillId,
            scope: args.scope,
            layout: "skill_directory",
            path: "",
            description: null,
            read_only: false,
          },
          content,
        }
      }
      case "acp_save_agent_skill": {
        const agent = args.agentType as string
        const id = args.skillId as string
        const info = agents.find((item) => item.agent === agent)
        // A new skill goes, globally, into a folder only this agent reads;
        // without one, nothing is written.
        if (
          args.create &&
          args.scope === "global" &&
          info &&
          !info.dirs.some((dir) => dir.role === "own")
        ) {
          throw coded(
            "no_own_directory",
            "this agent has no skills folder of its own",
            readersOf(SHARED_DIR)
              .filter((other) => other !== agent)
              .join(",")
          )
        }
        if (args.create) {
          const taken =
            skills.has(id) ||
            [...listings.entries()].some(
              ([key, specs]) =>
                key.startsWith(`${agent}|${args.scope}`) &&
                specs.some((spec) => spec.id === id)
            )
          if (taken)
            throw coded(
              "id_taken",
              `a skill named '${id}' already exists`,
              `${ownDir(agent)}/${id}`
            )
          const key = `${agent}|${args.scope}${args.scope === "project" ? `|${args.workspacePath}` : ""}`
          listings.set(key, [...(listings.get(key) ?? []), { id }])
        }
        agentContent.set(`${agent}|${id}`, args.content as string)
        announce({ kinds: ["agent_skills"], agents: [agent] })
        return {
          id,
          name: id,
          scope: args.scope,
          layout: "skill_directory",
          path: `${ownDir(agent)}/${id}`,
          description: null,
          read_only: false,
        }
      }
      case "acp_delete_agent_skill": {
        const agent = args.agentType as string
        const key = `${agent}|${args.scope}${args.scope === "project" ? `|${args.workspacePath}` : ""}`
        const item = listingItems(key).find(
          (entry) => entry.id === args.skillId
        )
        if (!item) throw coded("not_found", "no such skill", undefined)
        const dir = item.path.slice(0, item.path.lastIndexOf("/"))
        const sharedWith =
          args.scope === "global"
            ? readersOf(dir).filter((other) => other !== agent)
            : []
        const ack = sharedWith.length
          ? `ack-delete-${agent}-${item.id}-${effectsVersion}`
          : null
        const result = {
          deleted: false,
          path: item.path,
          kind:
            item.owner === "broken"
              ? "broken_link"
              : item.link_target
                ? "link"
                : item.layout === "markdown_file"
                  ? "file"
                  : "folder",
          shared_with: sharedWith,
          ack,
        }
        if (args.preflight) return result
        if (ack && args.ack !== ack) {
          throw coded(
            args.ack ? "effects_changed" : "acknowledgement_required",
            "other agents read this folder",
            sharedWith.join(",")
          )
        }
        listings.set(
          key,
          (listings.get(key) ?? []).filter((spec) => spec.id !== args.skillId)
        )
        announce({ kinds: ["agent_skills"], agents: [agent] })
        return { ...result, deleted: true }
      }
      case "acp_list_agent_runtime_skills":
        return {
          supported: true,
          message: null,
          locations: [],
          skills: listingItems(`${args.agentType}|global`),
        }
      case "acp_list_agents":
        return agents.map((agent, index) => ({
          agent_type: agent.agent,
          name: agent.agent,
          skills_capable: true,
          sort_order: index,
          installed_version: "1.0.0",
          custom_source: null,
          env: {},
          enabled: true,
        }))
      case "experts_open_central_dir":
        return STORE
      default:
        throw new Error(`unexpected command ${command}`)
    }
  }
  return engine
}
