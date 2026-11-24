/**
 * Installing plugins from Harness: the commands the plugin install dialog is
 * built on — `harness_plugin_plan`, `harness_plugin_install`,
 * `harness_plugin_uninstall` (`commands/harness_plugins.rs`).
 *
 * As with the skill install's (`skill-install-types.ts`): arguments are
 * camelCase, answers snake_case, the catalog's own objects (a member, an
 * autorun part, a host's manifest, a snapshot) keep its camelCase. Agents are
 * the skills engine's names (`claude_code`, …). A value from a known set may
 * be one this build does not know: it is kept as it came (`Open`) and never
 * taken for the permissive case. What is SENT stays closed.
 */
import type { Open } from "@/lib/mcp/types"
import type { SkillsApplyResult } from "@/lib/skills/types"
import type { AgentType } from "@/lib/types"
import type {
  HarnessMcpPlanItem,
  HarnessReason,
  HarnessVersionState,
} from "./mcp-install-types"
import type { HarnessSkillPackageFile } from "./skill-install-types"
import type { HarnessUpdateItem } from "./updates"

/** How an agent is to have the plugin: whole, through its host's own plugin
 *  system; its skills only, through Codeg's skill store; or not at all. */
export type PluginMode = "native" | "skills" | "none"

/** How an agent has an installed plugin. */
export type PluginHostMode = Open<"native" | "skills">

/** A plugin's member, as the catalog lists it. */
export interface HarnessPluginMember {
  kind: Open<"skill" | "assistant">
  name: string
  /** Its folder (a skill) or file (an assistant), from the plugin's root. */
  path: string
  summary: string | null
  /** `null` from a site that does not send it yet. */
  treeSha256: string | null
}

/** Something that runs once the plugin is installed whole. A type this build
 *  does not know still runs on its own. */
export interface HarnessAutorunPart {
  host: string
  type: Open<"hook" | "code" | "mcp" | "lsp" | "monitor" | "bin">
  /** The file that declares it, or is it. */
  path: string
  event: string | null
  name: string | null
  command: string | null
}

/** One host the plugin has a manifest for, and what it gets there. */
export interface HarnessPluginHostInfo {
  host: string
  manifest: string
  name: string | null
  skills: number
  agents: number
  commands: number
  hooks: number
  mcp: number
  code: number
}

/** One revision the plan offers: the latest, or the one to install whole. */
export interface HarnessPluginRevision {
  revision: number
  version: string | null
  published_at: string
  /** `PluginInfo.name`: the install name with this revision. */
  name: string | null
  /** Its `/resolve` fingerprint: what an install of it confirms. */
  state_sha256: string | null
  /** May it be installed whole, by the fresh snapshot. */
  approved: boolean
  exec_sha256: string | null
  mcp_unpinned: string[]
  members: HarnessPluginMember[]
  autorun: HarnessAutorunPart[]
  autorun_files: string[]
  hosts: HarnessPluginHostInfo[]
  archive: { url: string; sha256: string; size: number } | null
  source: { repository: string; commit: string; path: string } | null
  files: HarnessSkillPackageFile[]
  total_bytes: number
  /** Why this revision cannot be installed at all now. */
  blocking: HarnessReason[]
  /** To be confirmed in so many words: `yanked`. */
  confirm: HarnessReason[]
  warnings: HarnessReason[]
}

/** What the host's adapter found of an agent's host. */
export interface HarnessPluginDetect {
  found: boolean
  /** `wrapper` (the ACP wrapper's own copy) or `native` (the user's CLI). */
  via: string | null
  version: string | null
  supported: boolean
  why_not: HarnessReason | null
}

/** One of the Experts pack's links in an agent's skill folder. */
export interface HarnessExpertLink {
  name: string
  path: string
  copy: boolean
  /** Every agent that reads the folder. */
  agents: AgentType[]
}

/** What holds a name one of the plugin's skills would take. */
export interface HarnessPluginNameHeld {
  name: string
  path: string
  by: Open<"harness" | "custom" | "pack" | "plugin" | "agent">
  plugin: string | null
  agents: AgentType[]
}

/** What putting the plugin's skills into one agent would do. */
export interface HarnessPluginSkillsPlan {
  agent: AgentType
  /** The engine's preflight, one op per member; each op's `ack` is sent
   *  back by member. `null` when it could not be read. */
  links: SkillsApplyResult | null
  takeover: HarnessExpertLink[]
  held: HarnessPluginNameHeld[]
  /** The agent's changed copies that go (into the backups first). */
  copies_to_take: string[]
  issues: HarnessReason[]
}

/** One agent's row in the install dialog. */
export interface HarnessPluginPlanHost {
  agent: AgentType
  /** The website's host id, for an agent whose host has an adapter. */
  host_id: string | null
  installed: boolean | null
  detect: HarnessPluginDetect | null
  /** The modes the agent may be given, in the plan's order. */
  offered: Open<PluginMode>[]
  default: Open<PluginMode>
  /** The mode this row's preflight is for. */
  planned: Open<PluginMode>
  /** Why "as a plugin" is not offered. */
  why_not: HarnessReason | null
  /** The Experts pack's links the install takes out of what it reads. */
  experts_to_take_over: HarnessExpertLink[]
  /** Set when that reaches other agents (a shared folder): sent back. */
  experts_ack: string | null
  codex_hooks_need_trust: boolean
  /** Skills planned: the links' preflight. */
  skills: HarnessPluginSkillsPlan | null
}

/** How Codeg left an agent's plugin. `suspended`: Codeg turned it off
 *  (`reason`), only an update turns it on again. */
export interface HarnessPluginHostState {
  kind: Open<"active" | "disabled_by_user" | "suspended" | "needs_repair">
  reason: string | null
}

export interface HarnessInstalledPluginHost {
  mode: PluginHostMode
  state: HarnessPluginHostState
  host_name: string | null
  skills: string[]
  experts: HarnessExpertLink[]
}

/** The record's entry, when the item is installed here. */
export interface HarnessInstalledPluginEntry {
  name: string
  item_id: string
  ref: string
  revision: number
  version: string | null
  /** By agent. */
  hosts: Record<string, HarnessInstalledPluginHost>
  /** The `exec_sha256` agreed to. */
  consent: string | null
  installed_at: string
}

export interface HarnessPluginPlan {
  item: HarnessMcpPlanItem
  item_status: string
  latest: HarnessPluginRevision
  /** The revision to install whole; `null`: none may be. */
  full: HarnessPluginRevision | null
  not_full: Open<"pending_review" | "mcp_unpinned"> | null
  /** The revision the planned modes install. */
  target: number
  /** `PluginInfo.name` of `target`. */
  install_name: string | null
  /** `target`'s members. */
  members: HarnessPluginMember[]
  /** What runs on its own in `full`. */
  autorun: HarnessAutorunPart[]
  snapshot_latest: HarnessVersionState | null
  snapshot_full: HarnessVersionState | null
  hosts: HarnessPluginPlanHost[]
  /** The planned modes need `consentExec` = `consent_exec`. */
  consent_required: boolean
  consent_exec: string | null
  blocking: HarnessReason[]
  warnings: HarnessReason[]
  installed: HarnessInstalledPluginEntry | null
}

export interface HarnessPluginInstallArgs {
  itemRef: string
  revision: number
  installName: string
  /** Every row of the plan, `none` included. */
  hosts: Record<string, PluginMode>
  stateSha256: string
  consentExec: string | null
  /** Skills agents: by member, the `ack` of its link. */
  acks: Record<string, Record<string, string>>
  expertsAcks: Record<string, string>
  acceptYanked: boolean
}

export type HarnessPluginInstallOutcome = Open<
  | "installed"
  | "refused"
  | "acknowledgement_required"
  | "state_changed"
  | "aborted"
  | "invalid_package"
  | "busy"
  | "failed"
  | "updated"
  | "changed"
  | "repaired"
  | "preflight"
>

/** What one agent's step did. */
export interface HarnessPluginHostOutcome {
  agent: AgentType
  mode: PluginHostMode
  status: Open<"done" | "failed" | "undone" | "needs_repair">
  host_name: string | null
  issues: HarnessReason[]
  experts_taken: HarnessExpertLink[]
  experts_back: HarnessExpertLink[]
  experts_left: HarnessExpertLink[]
}

export interface HarnessPluginInstallResult {
  outcome: HarnessPluginInstallOutcome
  issues: HarnessReason[]
  /** `state_changed`: what changed. */
  changes: HarnessReason[]
  snapshot: HarnessVersionState | null
  state_sha256: string | null
  name: string | null
  revision: number | null
  hosts: HarnessPluginHostOutcome[]
  /** `acknowledgement_required`: the skills agents' preflights now. */
  skills: Record<string, HarnessPluginSkillsPlan>
  experts_acks: Record<string, string>
  needs_repair: AgentType[]
  problems: string[]
  consent_required: boolean
  consent_exec: string | null
  experts_to_take_over: Record<string, HarnessExpertLink[]>
  experts_to_give_back: Record<string, HarnessExpertLink[]>
}

export type HarnessPluginUninstallOutcome = Open<
  | "preflight"
  | "uninstalled"
  | "refused"
  | "acknowledgement_required"
  | "busy"
  | "write_failed"
>

export interface HarnessPluginUninstallResult {
  outcome: HarnessPluginUninstallOutcome
  issues: HarnessReason[]
  item_id: string
  name: string | null
  /** Skills agents: what goes from where, and who stops seeing it. */
  removes: Record<string, HarnessPluginSkillsPlan>
  /** The Experts pack's links given back, by agent. */
  experts: Record<string, HarnessExpertLink[]>
  /** The preflight's: send it back with the real call. */
  ack: string | null
  hosts: HarnessPluginHostOutcome[]
  needs_repair: AgentType[]
  problems: string[]
}

/** A version's `plugin` part in the catalog's install info. */
export interface HarnessPluginInfo {
  name: string
  hosts: HarnessPluginHostInfo[]
  components: HarnessPluginMember[]
  autorun: HarnessAutorunPart[]
  autorunFiles: string[]
  mcpUnpinned: string[]
  approved: boolean
  full: { revision: number; version: string | null } | null
  notFull: Open<"pending_review" | "mcp_unpinned"> | null
}

/** One of a plugin's releases (`/items/{ref}/releases`), newest first. */
export interface HarnessPluginRelease {
  version: string
  tag: string | null
  url: string | null
  notes: string | null
  publishedAt: string | null
  /** The revision here that has this version. */
  revision: number | null
  /** Members changed since the release before it; `null`: not known. */
  changed: { added: string[]; updated: string[]; removed: string[] } | null
}

// ─── The installed list (`harness_installed`'s `plugins`) ──────────────

/** What an interrupted operation left on an agent to know (`needs_repair`). */
export interface HarnessPluginRepairNote {
  /** The state it had before; `null`: none, or not known. */
  was: HarnessPluginHostState | null
  /** Another mode a cut-short change may have left it in. */
  other_modes: PluginHostMode[]
  /** An uninstall stopped on this agent: the repair finishes it. */
  uninstalling: boolean
  /** Codeg's backup was restored over the plugin's files or record. */
  restored: boolean
}

/** What the host's own files say of a plugin installed whole and on. */
export interface HarnessPluginHostVerify {
  /** `null`: the host does not list it. */
  enabled: boolean | null
  problems: HarnessReason[]
}

/** One agent of an installed plugin, as the listing reads it now. */
export interface HarnessListedPluginHost {
  agent: AgentType
  /** The website's host id, for an agent whose host has an adapter. */
  host_id: string | null
  mode: PluginHostMode
  state: HarnessPluginHostState
  /** `suspended`: why Codeg switched it off (a reason code). */
  suspended_reason: string | null
  repair: HarnessPluginRepairNote | null
  /** As a plugin: the name its host knows it by. */
  host_name: string | null
  /** Its skills only: the member skills it has. */
  skills: string[]
  /** The Experts pack's links the plugin took out of what it reads. */
  experts: HarnessExpertLink[]
  /** Codex runs the plugin's hooks only once trusted there. */
  codex_hooks: boolean
  /** Native and on only; `null` when it was not (or could not be) checked. */
  verify: HarnessPluginHostVerify | null
}

/** One installed plugin, one row of the Plugins section. */
export interface HarnessListedPlugin {
  /** The install name. */
  name: string
  item_id: string
  ref: string
  revision: number
  version: string | null
  previous_revision: number | null
  installed_at: string
  exec_sha256: string
  /** The `exec_sha256` agreed to; `null`: none. */
  consent: string | null
  autorun: HarnessAutorunPart[]
  members: HarnessPluginMember[]
  hosts: HarnessListedPluginHost[]
  /** What the last update check said of it when the listing was read. */
  update: HarnessUpdateItem | null
  /** What is wrong with its own files, or why its hosts were not checked. */
  problems: HarnessReason[]
}

/** Codex's own trust of one of a plugin's hooks. */
export interface HarnessHookStatus {
  key: string
  event: string
  state: Open<"trusted" | "untrusted" | "modified" | "unknown">
}

/** `harness_plugin_hook_trust`'s answer. */
export interface HarnessHookTrust {
  hooks: HarnessHookStatus[]
  /** Why Codex could not be asked; every hook is then unknown. */
  problem: HarnessReason | null
}

// ─── Updating, a change of mode, on and off, repair ───────────────────

/** How a member differs between the installed revision and the target. */
export interface HarnessPluginMemberChange {
  kind: Open<"skill" | "assistant">
  name: string
  change: Open<"added" | "removed" | "changed">
}

export type HarnessPluginUpdateAction = Open<
  "update" | "resume" | "to_skills" | "record_only" | "none" | "needs_repair"
>

/** One agent's row in the update dialog. */
export interface HarnessPluginUpdateHost {
  agent: AgentType
  host_id: string | null
  mode: PluginHostMode
  state: HarnessPluginHostState
  to_mode: PluginHostMode
  to_state: HarnessPluginHostState
  action: HarnessPluginUpdateAction
  /** `to_skills`: why its host cannot take the target whole. */
  why_not: HarnessReason | null
  detect: HarnessPluginDetect | null
  experts_to_take_over: HarnessExpertLink[]
  experts_ack: string | null
  experts_to_give_back: HarnessExpertLink[]
  codex_hooks_need_trust: boolean
  /** Skills from now on: the links' preview (acks by member). */
  skills: HarnessPluginSkillsPlan | null
}

/** `harness_plugin_plan_update`'s answer. */
export interface HarnessPluginUpdatePlan {
  installed: HarnessInstalledPluginEntry | null
  item: HarnessMcpPlanItem | null
  item_status: string
  latest: HarnessPluginRevision | null
  full: HarnessPluginRevision | null
  not_full: Open<"pending_review" | "mcp_unpinned"> | null
  /** The revision every agent moves to; `null`: none to move to. */
  target: number | null
  revision_from: number
  version_from: string | null
  version_to: string | null
  /** `null` when the target is not known. */
  changed_members: HarnessPluginMemberChange[] | null
  up_to_date: boolean
  /** The update needs `consentExec` = `consent_exec`. */
  needs_consent: boolean
  consent_exec: string | null
  autorun: HarnessAutorunPart[]
  snapshot: HarnessVersionState | null
  state_sha256: string | null
  hosts: HarnessPluginUpdateHost[]
  blocking: HarnessReason[]
  warnings: HarnessReason[]
}

export interface HarnessPluginUpdateArgs {
  itemId: string
  revision: number
  stateSha256: string
  consentExec: string | null
  acks: Record<string, Record<string, string>>
  expertsAcks: Record<string, string>
  acceptYanked: boolean
}

export interface HarnessPluginSetHostArgs {
  itemId: string
  agent: AgentType
  mode: PluginMode
  preflight: boolean
  stateSha256: string | null
  consentExec: string | null
  /** By member. */
  acks: Record<string, string>
  expertsAck: string | null
}

export interface HarnessPluginSetEnabledArgs {
  itemId: string
  agent: AgentType
  enabled: boolean
  preflight: boolean
  acks: Record<string, string>
  expertsAck: string | null
}

export interface HarnessPluginRepairArgs {
  itemId: string
  /** `null`: every agent that needs it. */
  agent: AgentType | null
  preflight: boolean
  acks: Record<string, Record<string, string>>
  expertsAcks: Record<string, string>
}
