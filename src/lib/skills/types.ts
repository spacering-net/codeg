/**
 * The skills engine's interface: `skills_inventory`, `skills_apply_links`,
 * `skills_repair_link`, `skills_adopt`, the three backup commands and the
 * `skills://changed` event, as the backend serializes them
 * (`src-tauri/src/skills/model.rs`).
 *
 * Every engine type is snake_case on the wire — field names and enum values,
 * inside the arguments as well as in the answers.
 *
 * What comes back is read as it may be sent by a NEWER Codeg too: a remote
 * workspace window or a browser can be talking to a server of a later
 * release. So wherever an answer holds one of a few known strings, any other
 * string is allowed for as well ({@link Open}) and is shown as "unknown"
 * rather than looked up. What is SENT stays closed: an op names only actions
 * this build knows.
 */
import type { AgentType } from "@/lib/types"

/** One of a known set of strings, or one a newer backend added. */
export type Open<T extends string> = T | (string & {})

export interface SkillsIssue {
  code: string
  path?: string
  agents?: AgentType[]
  /** Technical and untranslated: shown as such, never as the message. */
  detail?: string
  /** `rollback_failed`: what was left where it is, so that nothing is lost —
   *  a staged original and its staging folder, a backup, the store's copy of
   *  an adopted skill. */
  kept?: string[]
}

// ─── skills_inventory ─────────────────────────────────────────────────

export type SkillOrigin =
  | "experts"
  | "science"
  | "office"
  | "ui"
  | "harness"
  | "custom"

export const PACK_ORIGINS = ["experts", "science", "office", "ui"] as const

export type PackOrigin = (typeof PACK_ORIGINS)[number]

export function isPackOrigin(value: unknown): value is PackOrigin {
  return (PACK_ORIGINS as readonly unknown[]).includes(value)
}

export type DirRole = "own" | "shared" | "read_only"

export interface AgentSkillDir {
  /** As the agent's spec declares it, with the environment applied. */
  path: string
  role: Open<DirRole>
  /** The other agents that read this directory. */
  shared_with: AgentType[]
  exists: boolean
}

export interface SkillsAgent {
  agent: AgentType
  /** Every global skill directory it reads, in its reading order. */
  dirs: AgentSkillDir[]
  /** Where `enable` puts the link: its first own directory, else its first
   *  shared one; `null` without either. */
  link_dir: string | null
  /** `link_dir` is shared: enabling needs confirming. */
  link_dir_shared: boolean
}

export type CellState =
  | "linked"
  | "visible_through"
  | "copy"
  | "linked_elsewhere"
  | "blocked"
  | "broken"
  | "not_linked"

export type EntryKind =
  | "codeg_link"
  | "codeg_copy"
  | "codeg_broken"
  | "link"
  | "broken_link"
  | "folder"
  | "file"
  | "unreadable"

/** One thing under the skill's name in one of the agent's directories. */
export interface CellEntry {
  path: string
  dir: string
  dir_role: Open<DirRole>
  kind: Open<EntryKind>
  /** Links only: the target as it reads, made absolute. */
  target?: string
  /** Copies only: still what Codeg copied. */
  copy_matches?: boolean
  /** Copies only: equals the skill in the store now. */
  copy_current?: boolean
}

export interface SkillCell {
  agent: AgentType
  state: Open<CellState>
  /** The entry that decides `state`; `null` for `not_linked`. */
  path: string | null
  dir: string | null
  dir_role: Open<DirRole> | null
  target: string | null
  /** The deciding entry is Codeg's (its link, copy or broken link). */
  codeg: boolean
  copy_matches: boolean | null
  copy_current: boolean | null
  /** Other agents that see this same entry (it is in a shared directory). */
  shared_with: AgentType[]
  /** Everything under the name, in the agent's reading order. */
  entries: CellEntry[]
}

export interface HarnessSkillInfo {
  ref: string | null
  version: string | null
}

export interface StoreSkill {
  id: string
  origin: Open<SkillOrigin>
  /** `~/.codeg/skills/<id>`. */
  path: string
  /** The frontmatter's `name:`, else the id. */
  name: string
  description: string | null
  /** A pack skill the user had changed, set aside at the last update. */
  pending_user_review: boolean
  /** `origin: "harness"` only. */
  harness: HarnessSkillInfo | null
  /** How many backups it has. */
  backups: number
  /** One per agent in `agents`, in the same order. */
  cells: SkillCell[]
}

/** A pack's skill whose id a skill of another origin holds in the store. */
export interface NameTaken {
  id: string
  pack: Open<SkillOrigin>
  held_by: Open<SkillOrigin>
}

/** A broken link Codeg made — also for a skill no longer in the store. */
export interface BrokenLink {
  path: string
  dir: string
  target: string | null
  /** The store id it points at, or that its record names. */
  skill: string
  /** Every agent that reads `dir`. */
  agents: AgentType[]
}

export interface SkillsInventory {
  store: string
  /** Every agent with a skill store, in registry order. */
  agents: SkillsAgent[]
  /** Every skill in the store, by id. */
  skills: StoreSkill[]
  name_taken: NameTaken[]
  broken_links: BrokenLink[]
  problems: SkillsIssue[]
}

// ─── skills_apply_links ───────────────────────────────────────────────

export type SkillAction = "enable" | "disable" | "only" | "refresh"

export interface SkillOp {
  /** A store id. */
  skill: string
  agent: AgentType
  action: SkillAction
  /** The `ack` the preflight returned for THIS op, when it had one. */
  ack?: string | null
  /** `refresh` only. */
  replace_modified?: boolean
}

export interface SkillsApplyArgs {
  ops: SkillOp[]
  preflight?: boolean
}

export type ApplyOutcome =
  | "preflight"
  | "applied"
  | "acknowledgement_required"
  | "invalid"
  | "busy"
  | "write_failed"

export type OpStatus =
  | "ready"
  | "unchanged"
  | "needs_ack"
  | "blocked"
  | "done"
  | "not_done"
  | "failed"
  | "rolled_back"
  | "rollback_failed"

export type ChangeKind = "link" | "copy" | "broken_link"

export interface PathChange {
  path: string
  kind: Open<ChangeKind>
}

export interface PathMove {
  from: string
  to: string
}

/** What an op does — or a repair: the part both answers have. */
export interface SkillEffects {
  status: Open<OpStatus>
  creates: PathChange[]
  removes: PathChange[]
  moves: PathMove[]
  /** OTHER agents that start seeing the skill. */
  gains: AgentType[]
  /** OTHER agents that stop seeing it. */
  loses: AgentType[]
  /** OTHER agents whose directories change though they keep seeing it. */
  touches: AgentType[]
  /** Present exactly when the effects reach another agent. */
  ack: string | null
  issues: SkillsIssue[]
  warnings: SkillsIssue[]
}

export interface SkillOpResult extends SkillEffects {
  /** Into `ops`. */
  index: number
  skill: string
  agent: AgentType
  action: Open<SkillAction>
}

export interface SkillsApplyResult {
  outcome: Open<ApplyOutcome>
  /** Applied in full — or, in a preflight, nothing is blocked. */
  ok: boolean
  /** One per op, in order. */
  ops: SkillOpResult[]
  /** About the request (lock, record). */
  issues: SkillsIssue[]
}

// ─── skills_repair_link ───────────────────────────────────────────────

export type RepairAction = "repoint" | "remove"

export interface SkillsRepairArgs {
  path: string
  action: RepairAction
  preflight?: boolean
  ack?: string | null
}

export interface SkillsRepairResult extends SkillEffects {
  outcome: Open<ApplyOutcome>
  ok: boolean
  path: string
  action: Open<RepairAction>
  /** `repoint`: the store id it points at afterwards. */
  skill: string | null
}

// ─── skills_adopt ─────────────────────────────────────────────────────

export type AdoptOutcome = "adopted" | "invalid" | "busy" | "failed"

export interface SkillsAdoptArgs {
  agent: AgentType
  skill: string
  /** Default: the first of the agent's directories that has the skill. */
  dir?: string | null
}

export interface SkillsAdoptResult {
  outcome: Open<AdoptOutcome>
  ok: boolean
  skill: string
  agent: AgentType
  /** The agent's skill that was moved: a folder, or a flat `<id>.md`. */
  source: string | null
  store_path: string | null
  link_path: string | null
  mode: Open<"symlink" | "junction" | "copy"> | null
  /** After a failure: everything was put back as it was. */
  restored: boolean
  issues: SkillsIssue[]
}

// ─── Backups ──────────────────────────────────────────────────────────

export type BackupKind = "update" | "copy" | "legacy"

export interface SkillBackup {
  /** The skill it is a backup of. */
  skill: string
  /** With `skill`, what restore and delete take. */
  name: string
  path: string
  kind: Open<BackupKind>
  /** RFC 3339, from the name. */
  created_at: string | null
  /** `copy`: whose copy it was, as the name labels it. */
  agent: string | null
  /** `legacy`: the agents that see it through a link. */
  linked_by: AgentType[]
}

export interface SkillsBackups {
  /** By skill, newest first. */
  backups: SkillBackup[]
  problems: SkillsIssue[]
}

export type BackupOutcome =
  | "restored"
  | "deleted"
  | "invalid"
  | "busy"
  | "failed"

export interface SkillsBackupResult {
  outcome: Open<BackupOutcome>
  ok: boolean
  skill: string
  name: string
  /** Restore: the Custom skill's id. */
  id: string | null
  /** Restore: its folder. */
  path: string | null
  /** Restore: the backup is still there (a linked legacy one is copied). */
  backup_kept: boolean
  issues: SkillsIssue[]
}

// ─── The Skills page's delete (`acp_delete_agent_skill`) ──────────────

export type SkillPageDeleteKind = "folder" | "file" | "link" | "broken_link"

/** What deleting one of an agent's skills does — the preflight's answer —
 *  or did. */
export interface SkillPageDeleteResult {
  deleted: boolean
  path: string
  kind: Open<SkillPageDeleteKind>
  /** The other agents that read the folder, and lose it too. */
  shared_with: AgentType[]
  /** Present when `shared_with` is not empty: the real delete needs it. */
  ack: string | null
}

// ─── skills://changed ─────────────────────────────────────────────────

export const SKILLS_CHANGED_EVENT = "skills://changed"

export type ChangedKind = "links" | "store" | "agent_skills" | "backups"

/** Kinds and agent names only: no paths, no skill ids, no content. */
export interface SkillsChanged {
  kinds: Open<ChangedKind>[]
  agents: AgentType[]
}

// ─── The Skills page's listing (`acp_list_agent_skills`) ──────────────

/** Whose an agent's listed skill is. */
export type AgentSkillOwner =
  | "pack"
  | "harness"
  | "custom"
  | "agent"
  | "linked_elsewhere"
  | "broken"
