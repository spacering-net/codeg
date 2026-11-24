/**
 * Installing MCP servers from Harness: the four commands the install dialog
 * and the MCP section's Harness marks are built on, and their event —
 * `harness_mcp_plan`, `harness_mcp_install`, `harness_installed`,
 * `harness_mcp_uninstall`, `harness://installed-changed`.
 *
 * Arguments are camelCase, as every Tauri command's are. Answers are
 * snake_case, like the MCP engine's types they embed (`apply`, `definition`),
 * except two objects that are the catalog's own and keep its camelCase: the
 * version's state (`snapshot`) and the newest version (`latest`).
 *
 * As everywhere a newer backend can answer (a remote workspace's host, the
 * server behind a browser), a value from a known set may be one this build
 * does not know: such values are kept as they came (`Open`) and shown as
 * "unknown", never taken for the permissive case. What is SENT stays closed.
 */
import type { HarnessListedPlugin } from "./plugin-install-types"
import type { HarnessInstalledSkill } from "./skill-install-types"
import type { HarnessPermissions } from "./types"
import type {
  McpApplyResult,
  McpAppType,
  McpBasis,
  McpDefinition,
  McpIssue,
  McpTransport,
  Open,
} from "@/lib/mcp/types"

/** Why something cannot be done, or is worth saying: a stable code, its
 *  parameters, and — never shown as the message — technical detail. */
export interface HarnessReason {
  code: string
  params: Readonly<Record<string, string>>
  detail: string | null
}

/** How an agent's entry stands against what Codeg installed there. */
export type HarnessLocalState = Open<
  "as_installed" | "changed_locally" | "missing" | "unknown"
>

/** A version's status, as `/resolve` tells it. */
export type HarnessVersionStatus = Open<"ok" | "yanked" | "blocked" | "unknown">

export type HarnessPackageCheck = Open<
  "ok" | "missing" | "unchecked" | "pending" | "unknown"
>

export interface HarnessPackageState {
  registryType: string
  identifier: string
  version: string | null
  verified: HarnessPackageCheck
  hasInstallScript: boolean
}

/**
 * What can change about a published version, read fresh from `/resolve` —
 * the only source of the dialog's status, risk, review, permissions, checks
 * and package verification. A part `/resolve` left out is `null`, and is
 * shown as "not stated", never as a reassuring default.
 */
export interface HarnessVersionState {
  revision: number
  status: HarnessVersionStatus
  risk: string | null
  reviewed: boolean | null
  permissions: {
    declared: HarnessPermissions
    detected: HarnessPermissions
  } | null
  checks: {
    findings: { low: number; medium: number; high: number }
    secrets: number
    review: string
  } | null
  packages: HarnessPackageState[] | null
  stateSha256: string | null
}

export interface HarnessMcpPlanItem {
  id: string
  ref: string
  kind: string
  title: { en?: string; zh?: string }
  revision: number
  version: string | null
  published_at: string
}

export interface HarnessMcpPlanPackage {
  registry_type: string
  identifier: string
  /** Pinned by Harness, by the snapshot. */
  version: string | null
  /** `null`: Harness has no pin for it. */
  verified: HarnessPackageCheck | null
  has_install_script: boolean
  runtime: string | null
}

export type HarnessParameterLocation = Open<"env" | "header" | "query" | "arg">
export type HarnessParameterKind = Open<
  "string" | "boolean" | "number" | "integer" | "json"
>

/** A value the user fills in for one way of running the server. */
export interface HarnessMcpPlanParameter {
  /** What `values` names it by: `env.<NAME>`, `headers.<Name>`,
   *  `variables.<name>`, `runtime_arguments.<i>`, `package_arguments.<i>`. */
  key: string
  /** The variable's, header's or argument's own name. */
  name: string
  location: HarnessParameterLocation
  /** Third-party text, from the server's definition. */
  description: string | null
  required: boolean
  /** Marked secret, or named like one: shown masked. */
  secret: boolean
  kind: HarnessParameterKind
  default: string | null
  /** Third-party text: what a value looks like. */
  placeholder: string | null
  /** The only values it takes (third-party text); empty when any goes. */
  choices: string[]
  /** An installed item: what its own entries hold for it now — in clear,
   *  secrets too (masked wherever it is shown, kept in memory only). */
  current: HarnessRecoveredValue | null
}

export interface HarnessRecoveredValue {
  /** With `conflicting`, the first agent's. */
  value: string
  /** Whose entries hold a value. */
  agents: string[]
  /** The entries disagree, or not all of them hold one. */
  conflicting: boolean
}

/** What an update can carry over from the entries an option installed. */
export interface HarnessOptionRecovery {
  /** The agents whose entries were read. */
  from: string[]
  /** Installed with this option, but nothing of theirs is carried over. */
  unmatched: string[]
  /** What an update would drop, by the key it was installed under. */
  lost: { key: string; agents: string[] }[]
}

/** One way of running or reaching the server. */
export interface HarnessMcpPlanOption {
  /** Send back as `optionId`. */
  id: string
  transport: Open<McpTransport>
  source: Open<"package" | "remote">
  package: HarnessMcpPlanPackage | null
  /** What will be run or reached, defaults filled in, no user values;
   *  `null` when it cannot be made before the user's values are in. */
  definition: McpDefinition | null
  /** A remote: the address as written, `{placeholders}` and all. */
  url: string | null
  parameters: HarnessMcpPlanParameter[]
  /** Why it cannot be chosen. */
  blocking: HarnessReason[]
  /** Worth saying; stops nothing. */
  warnings: HarnessReason[]
  selectable: boolean
  /** Ticked when this option is chosen. */
  default_targets: string[]
  /** Of those, the ones ticked to "replace" (an update). */
  default_replace: string[]
  /** An installed item, an option some agent was installed with. */
  recovery: HarnessOptionRecovery | null
}

export type HarnessEntryOwner = Open<"this_item" | "other_item" | "elsewhere">

/** An agent's entry under a name the install may use. */
export interface HarnessKeyConflict {
  key: string
  agent: string
  owner: HarnessEntryOwner
  item_id: string | null
  item_ref: string | null
  state: HarnessLocalState | null
  /** What a replace would overwrite — values in clear, as in the agent's
   *  file: masked by whoever shows it. */
  definition: McpDefinition | null
  enabled: boolean
}

export interface HarnessMcpPlanAgent {
  agent: string
  installed: boolean | null
  writable: boolean
  transports: string[]
  path: string
  status: Open<"ok" | "missing" | "unreadable" | "read_only">
  /** Send back in `basis` for a target; `null` when its file cannot be
   *  read. */
  basis: string | null
  /** The servers already in it. */
  keys: string[]
  /** Why Codeg does not write it, as the engine says; `null` when it
   *  does. */
  reason: McpIssue | null
  /** Every server in it, by name, with where it came from. */
  entries: HarnessAgentEntry[]
}

export interface HarnessAgentEntry {
  key: string
  owner: HarnessEntryOwner
  item_id: string | null
  item_ref: string | null
}

export interface HarnessInstalledAgent {
  agent: string
  state: HarnessLocalState
  revision: number
  version: string | null
  option: string
  transport: string
  packages: { registry_type: string; identifier: string; version: string }[]
  state_sha256: string
  installed_at: string
}

/** An item installed from Harness, checked against the agents' files now. */
export interface HarnessInstalledItem {
  id: string
  ref: string
  /** As recorded at the last install; `null` for older records. */
  title: { en?: string; zh?: string } | null
  /** The server's name in every one of its agents. */
  key: string
  /** The lowest among its agents': where an update starts. */
  revision: number
  version: string | null
  state: HarnessLocalState
  agents: HarnessInstalledAgent[]
}

/**
 * What the host has installed from Harness. Each part is listed on its own:
 * a record that cannot be read leaves its part empty and says so in that
 * part's problem (`record_unreadable`, with why), and the other part is
 * listed as usual.
 */
export interface HarnessInstalled {
  mcp: HarnessInstalledItem[]
  /** `[]` from a Codeg that installs no skills from Harness. */
  skills: HarnessInstalledSkill[]
  mcp_problem: HarnessReason | null
  skills_problem: HarnessReason | null
  /** The installed plugins, one row each. Always set by the normalizer
   *  (`[]` from a Codeg that installs none). */
  plugins?: HarnessListedPlugin[]
  /** The plugin record cannot be read (or a newer Codeg wrote it). */
  plugins_problem?: HarnessReason | null
}

export interface HarnessMcpPlan {
  item: HarnessMcpPlanItem
  item_status: string
  latest: {
    revision: number
    version: string | null
    publishedAt: string
  } | null
  snapshot: HarnessVersionState | null
  /** The snapshot's fingerprint: what a confirmation is a confirmation of. */
  state_sha256: string | null
  /** The item as a whole cannot be installed. */
  blocking: HarnessReason[]
  /** To be confirmed in so many words: `yanked`. */
  confirm: HarnessReason[]
  options: HarnessMcpPlanOption[]
  default_option: string | null
  key: {
    name: string
    default: string
    conflicts: HarnessKeyConflict[]
    pattern: string
  }
  agents: HarnessMcpPlanAgent[]
  /** Every readable agent's basis, as the plan read it. */
  basis: Readonly<Record<string, string>>
  installed: HarnessInstalledItem | null
}

export interface HarnessMcpInstallArgs {
  itemRef: string
  revision: number
  optionId: string
  values: Record<string, string>
  key: string
  agents: McpAppType[]
  replace: McpAppType[]
  stateSha256: string
  basis: McpBasis
  acceptYanked: boolean
}

export type HarnessInstallOutcome = Open<
  | "installed"
  | "refused"
  | "changed_elsewhere"
  | "state_changed"
  | "aborted"
  | "invalid"
  | "busy"
  | "write_failed"
>

export interface HarnessRecordWrite {
  status: Open<"written" | "unchanged" | "failed">
  code: string | null
  detail: string | null
}

export interface HarnessMcpInstallResult {
  outcome: HarnessInstallOutcome
  issues: HarnessReason[]
  changes: HarnessReason[]
  snapshot: HarnessVersionState | null
  state_sha256: string | null
  /** The engine's own account, as `mcp_apply` gives it: the commit's once
   *  there was one, else the preflight's. */
  apply: McpApplyResult | null
  record: HarnessRecordWrite | null
}

export interface HarnessMcpUninstallArgs {
  itemId: string
  agents?: McpAppType[]
  removeChanged?: McpAppType[]
  basis?: McpBasis
  preflight?: boolean
}

export type HarnessUninstallAction = Open<
  "remove" | "keep_changed" | "keep_unknown" | "forget" | "not_requested"
>

export interface HarnessUninstallAgent {
  agent: string
  key: string
  state: HarnessLocalState
  action: HarnessUninstallAction
}

export interface HarnessMcpUninstallResult {
  outcome: Open<
    | "preflight"
    | "uninstalled"
    | "refused"
    | "changed_elsewhere"
    | "invalid"
    | "busy"
    | "write_failed"
  >
  issues: HarnessReason[]
  agents: HarnessUninstallAgent[]
  apply: McpApplyResult | null
  record: HarnessRecordWrite | null
}

export const HARNESS_INSTALLED_CHANGED_EVENT = "harness://installed-changed"

/** Which items and agents: nothing of what is in any file. */
export interface HarnessInstalledChanged {
  item_ids: string[]
  agents: string[]
}
