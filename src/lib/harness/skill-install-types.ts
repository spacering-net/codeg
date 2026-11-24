/**
 * Installing skills from Harness: the three commands the skill install
 * dialog and the Skills section's Harness marks are built on —
 * `harness_skill_plan`, `harness_skill_install`, `harness_skill_uninstall` —
 * and the `skills` part of `harness_installed` (h3-api.md).
 *
 * Arguments are camelCase. Answers are snake_case, including the skills
 * engine's results they embed (`links`, k1-api §3); the catalog's own objects
 * keep its camelCase (`snapshot`, `latest`). Agent names are the skills
 * engine's (`claude_code`, …, `custom:<id>`).
 *
 * As everywhere a newer backend can answer, a value from a known set may be
 * one this build does not know: such values are kept as they came (`Open`)
 * and shown as "unknown", never taken for the permissive case. What is SENT
 * stays closed.
 */
import type { Open } from "@/lib/mcp/types"
import type { SkillOpResult, SkillsApplyResult } from "@/lib/skills/types"
import type { AgentType } from "@/lib/types"
import type {
  HarnessLocalState,
  HarnessMcpPlanItem,
  HarnessReason,
  HarnessVersionState,
} from "./mcp-install-types"

/** What Codeg changed in SKILL.md when it installed the skill. */
export interface HarnessSkillRewrites {
  /** SKILL.md's `name`, when the install name is not the skill's own. */
  name: { from: string | null; to: string } | null
  /** Only when SKILL.md declares `allowed-tools`. */
  allowedTools: Open<"removed" | "kept"> | null
}

export interface HarnessSkillFileChanges {
  changed: string[]
  added: string[]
  missing: string[]
}

/** A skill installed from Harness, checked against its folder now. */
export interface HarnessInstalledSkill {
  /** The item's id: what `/resolve` is asked by. */
  id: string
  /** The item's address as recorded at the last install. */
  ref: string
  /** The install name: the store id, what the Skills section knows it by. */
  name: string
  revision: number
  version: string | null
  state: HarnessLocalState
  /** Who sees Codeg's link (or copy) of it now. */
  agents: AgentType[]
  files: HarnessSkillFileChanges
  rewrites: HarnessSkillRewrites
  /** `null`: its files came from the source, not an archive. */
  archive_sha256: string | null
  state_sha256: string
  installed_at: string
}

export type HarnessNameTakenBy = Open<
  | "reserved"
  | "pack"
  | "custom"
  | "harness"
  | "store"
  | "codeg_link"
  | "agent_dir"
>

/** Why a name tried before the proposed one was not used. */
export interface HarnessSkillNameTaken {
  name: string
  by: HarnessNameTakenBy
  /** `reserved` / `pack`: whose. */
  pack: string | null
  /** `harness`: which item. */
  item_id: string | null
  item_ref: string | null
  /** What holds it. */
  path: string | null
  /** `codeg_link`: who reads it; `agent_dir`: whose folder. */
  agents: AgentType[]
}

export interface HarnessSkillPlanAgent {
  agent: AgentType
  /** `null`: not known whether it is installed here. */
  installed: boolean | null
  /** Where `enable` links; `null` when it has nowhere to link. */
  link_dir: string | null
  /** Linking there shows the skill to other agents too. */
  link_dir_shared: boolean
  /** Sees Codeg's skill under the proposed name now. */
  sees: boolean
  default: boolean
}

export interface HarnessSkillPackageFile {
  path: string
  sha256: string
  size: number
  executable: boolean
}

export interface HarnessSkillPlan {
  item: HarnessMcpPlanItem
  item_status: string
  latest: {
    revision: number
    version: string | null
    publishedAt: string
  } | null
  /** The version's state read fresh from `/resolve` — the only source of the
   *  dialog's status, risk, review, permissions, checks and packages. */
  snapshot: HarnessVersionState | null
  /** The snapshot's fingerprint: what a confirmation is a confirmation of. */
  state_sha256: string | null
  /** Nothing can be installed. */
  blocking: HarnessReason[]
  /** To be confirmed in so many words: `yanked`. */
  confirm: HarnessReason[]
  warnings: HarnessReason[]
  /** SKILL.md's frontmatter, as the catalog read it — third-party text. */
  skill: {
    name: string
    description: string
    license: string | null
    compatibility: string | null
    /** `null`: SKILL.md declares no `allowed-tools`. */
    allowed_tools: string[] | null
  }
  package: {
    archive: { url: string; sha256: string; size: number } | null
    source: { repository: string; commit: string; path: string } | null
    files: HarnessSkillPackageFile[]
    total_bytes: number
  }
  install_name: {
    /** The skill's own name. */
    name: string
    /** The name proposed. */
    default: string
    /** Why each name tried before `default` was not used. */
    taken: HarnessSkillNameTaken[]
    pattern: string
  }
  /** Every agent with skill folders, in the engine's order. */
  agents: HarnessSkillPlanAgent[]
  default_agents: AgentType[]
  /** The engine's preflight of `enable` for the agents the plan was asked
   *  about (or its default ones), under `install_name.default`. */
  links: SkillsApplyResult
  /** Set when the item is installed here. */
  installed: HarnessInstalledSkill | null
}

export interface HarnessSkillInstallArgs {
  itemRef: string
  revision: number
  installName: string
  agents: AgentType[]
  keepAllowedTools: boolean
  stateSha256: string
  acks: Record<string, string>
  acceptYanked: boolean
}

export type HarnessSkillInstallOutcome = Open<
  | "installed"
  | "refused"
  | "acknowledgement_required"
  | "state_changed"
  | "aborted"
  | "invalid_package"
  | "busy"
  | "write_failed"
>

export interface HarnessSkillPhase {
  phase: string
  status: Open<"done" | "skipped" | "failed" | "rolled_back">
  detail: string | null
}

export interface HarnessSkillInstallResult {
  outcome: HarnessSkillInstallOutcome
  issues: HarnessReason[]
  /** `state_changed`: what changed since the state the user confirmed. */
  changes: HarnessReason[]
  snapshot: HarnessVersionState | null
  /** `state_changed`: the fingerprint to confirm next. */
  state_sha256: string | null
  name: string | null
  phases: HarnessSkillPhase[]
  /** `acknowledgement_required`: the preflight now; `installed`: the
   *  engine's result of the links. */
  links: SkillsApplyResult | null
  /** Links the preflight under the lock found blocked: not made. */
  links_skipped: SkillOpResult[]
  /** An update: Codeg's copies of the old content. */
  copies: {
    refreshed: string[]
    kept_changed: string[]
    problems: string[]
  } | null
  /** An update over changed files: where the old folder was kept. */
  backup: string | null
  rewrites: HarnessSkillRewrites | null
  /** `rollback_failed`: where things were left. */
  kept: string[]
}

export interface HarnessSkillRemoval {
  path: string
  kind: string
  agents: AgentType[]
}

export type HarnessSkillUninstallOutcome = Open<
  | "preflight"
  | "uninstalled"
  | "refused"
  | "acknowledgement_required"
  | "busy"
  | "write_failed"
>

export interface HarnessSkillUninstallResult {
  outcome: HarnessSkillUninstallOutcome
  issues: HarnessReason[]
  item_id: string
  name: string | null
  removes: HarnessSkillRemoval[]
  /** Every agent that stops seeing it. */
  loses: AgentType[]
  /** Copies changed on the agent's side: left where they are. */
  kept_copies: { code: string; path: string | null; agents: string[] }[]
  files: HarnessSkillFileChanges
  /** Why the folder could not be compared: it is then kept whole. */
  files_unreadable: string | null
  /** The folder goes to `.user-backups` rather than being deleted. */
  keeps_folder: boolean
  /** The real call: where the folder went. */
  backup: string | null
  /** The preflight's: send it back to confirm exactly this. */
  ack: string | null
  phases: HarnessSkillPhase[]
  kept: string[]
}
