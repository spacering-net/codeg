/**
 * The plugin install dialog's decisions, as pure functions of the plan and of
 * what the user put in: each agent's mode (as a plugin, its skills only, not
 * at all), the agreement to what runs on its own, the withdrawn version — and,
 * from all that, the one install call the dialog may make.
 *
 * The rules of `skill-install.ts` hold here too:
 *
 * - **What is sent is what was shown.** The plan is made for the modes on
 *   show (`modes`): the revision they install, what must be agreed to, each
 *   skills agent's link preview and each Experts takeover's ack are the
 *   plan's for exactly those modes. While the modes ticked are not the ones
 *   the plan on show was made for, nothing can be confirmed; a new plan is
 *   asked for.
 * - **Defaults never decide for the user what the user has to confirm.** The
 *   agreement to what runs on its own is given for one `exec_sha256` — the
 *   plan's — and counts for no other; a withdrawn version is never accepted
 *   without a tick.
 *
 * One revision for every agent (docs/harness-plugins.md §7): the one to
 * install whole (`full`) when any agent has it as a plugin, else the latest.
 */
import type {
  HarnessAutorunPart,
  HarnessPluginInstallArgs,
  HarnessPluginPlan,
  HarnessPluginPlanHost,
  HarnessPluginRevision,
  PluginMode,
} from "./plugin-install-types"
import type { HarnessVersionState } from "./mcp-install-types"

// ─── What the user put in ─────────────────────────────────────────────

export interface PluginInstallInput {
  /** One mode per plan row, by agent. */
  modes: Record<string, PluginMode>
  /** The `exec_sha256` the user agreed to; counts only while it is the
   *  plan's. */
  consentExec: string | null
  acceptYanked: boolean
  /** The agents whose mode the user chose: kept over a new plan. */
  touched: string[]
}

/** The modes in the order they are offered. */
export const PLUGIN_MODES = ["native", "skills", "none"] as const

export function knownPluginMode(value: unknown): PluginMode | null {
  return PLUGIN_MODES.find((mode) => mode === value) ?? null
}

export function planRowOf(
  plan: HarnessPluginPlan,
  agent: string
): HarnessPluginPlanHost | null {
  return plan.hosts.find((row) => row.agent === agent) ?? null
}

/** The modes a row may be given — the ones this build knows, in its own
 *  order. "Not at all" always is. */
export function offeredModes(row: HarnessPluginPlanHost): PluginMode[] {
  return PLUGIN_MODES.filter(
    (mode) => mode === "none" || row.offered.includes(mode)
  )
}

export function isModeOffered(
  row: HarnessPluginPlanHost,
  mode: PluginMode
): boolean {
  return offeredModes(row).includes(mode)
}

/** The row's default, as the plan proposes it (by what its host's adapter
 *  found and whether the plugin may be installed whole): one it does not
 *  offer, or does not know, is "not at all". */
export function defaultModeOf(row: HarnessPluginPlanHost): PluginMode {
  const mode = knownPluginMode(row.default)
  return mode && isModeOffered(row, mode) ? mode : "none"
}

/** The mode the row's preview was made for. */
export function plannedModeOf(row: HarnessPluginPlanHost): PluginMode {
  return knownPluginMode(row.planned) ?? "none"
}

/** Every row's default mode. */
export function defaultPluginModes(
  plan: HarnessPluginPlan
): Record<string, PluginMode> {
  return Object.fromEntries(
    plan.hosts.map((row) => [row.agent, defaultModeOf(row)])
  )
}

/**
 * The input for a plan: its defaults — or, over a new plan of the same
 * dialog, the modes the user chose wherever the new plan still offers them.
 * The agreement and the withdrawn-version tick are carried over as they
 * were; the agreement counts only for the plan's `exec_sha256`.
 */
export function initialPluginInput(
  plan: HarnessPluginPlan,
  previous: PluginInputLike | null = null
): PluginInstallInput {
  const touched = (previous?.touched ?? []).filter((agent) => {
    const row = planRowOf(plan, agent)
    const mode = knownPluginMode(previous?.modes[agent])
    return row !== null && mode !== null && isModeOffered(row, mode)
  })
  const modes: Record<string, PluginMode> = {}
  for (const row of plan.hosts) {
    modes[row.agent] = touched.includes(row.agent)
      ? (knownPluginMode(previous?.modes[row.agent]) ?? "none")
      : defaultModeOf(row)
  }
  return {
    modes,
    consentExec: previous?.consentExec ?? null,
    acceptYanked: previous?.acceptYanked ?? false,
    touched,
  }
}

type PluginInputLike = Pick<
  PluginInstallInput,
  "modes" | "consentExec" | "acceptYanked" | "touched"
>

/** Give an agent a mode — only one its row offers. */
export function setPluginHostMode(
  plan: HarnessPluginPlan,
  input: PluginInstallInput,
  agent: string,
  mode: PluginMode
): PluginInstallInput {
  const row = planRowOf(plan, agent)
  if (!row || !isModeOffered(row, mode)) return input
  return {
    ...input,
    modes: { ...input.modes, [agent]: mode },
    touched: input.touched.includes(agent)
      ? input.touched
      : [...input.touched, agent],
  }
}

/** The agents "every agent: `mode`" would change: the rows that offer it
 *  and are not in it already. A row that does not offer it keeps its own. */
export function pluginRowsToSetAll(
  plan: HarnessPluginPlan,
  input: PluginInstallInput,
  mode: PluginMode
): string[] {
  return plan.hosts
    .filter(
      (row) =>
        isModeOffered(row, mode) && (input.modes[row.agent] ?? "none") !== mode
    )
    .map((row) => row.agent)
}

/** Every agent that offers `mode` set to it, as if chosen one by one. */
export function setPluginModeForAll(
  plan: HarnessPluginPlan,
  input: PluginInstallInput,
  mode: PluginMode
): PluginInstallInput {
  return pluginRowsToSetAll(plan, input, mode).reduce(
    (next, agent) => setPluginHostMode(plan, next, agent, mode),
    input
  )
}

/** Agree (or not) to what runs on its own — as the plan has it now. */
export function setPluginConsent(
  plan: HarnessPluginPlan,
  input: PluginInstallInput,
  agree: boolean
): PluginInstallInput {
  return { ...input, consentExec: agree ? plan.consent_exec : null }
}

export function setPluginAcceptYanked(
  input: PluginInstallInput,
  accept: boolean
): PluginInstallInput {
  return { ...input, acceptYanked: accept }
}

export const samePluginModes = (
  a: Readonly<Record<string, PluginMode>>,
  b: Readonly<Record<string, PluginMode>>
) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...keys].every((key) => (a[key] ?? "none") === (b[key] ?? "none"))
}

// ─── Which revision ───────────────────────────────────────────────────

export function anyNative(modes: Readonly<Record<string, PluginMode>>) {
  return Object.values(modes).includes("native")
}

/**
 * The revision these modes install: the one to install whole when any
 * agent has it as a plugin (and there is one), else the latest.
 */
export function pluginTargetOf(
  plan: HarnessPluginPlan,
  modes: Readonly<Record<string, PluginMode>>
): HarnessPluginRevision {
  return anyNative(modes) && plan.full ? plan.full : plan.latest
}

/** The catalog's state of that revision, read fresh with the plan. */
export function pluginTargetSnapshot(
  plan: HarnessPluginPlan,
  modes: Readonly<Record<string, PluginMode>>
): HarnessVersionState | null {
  return anyNative(modes) && plan.full
    ? plan.snapshot_full
    : plan.snapshot_latest
}

/** The plan on show was made for other modes than those chosen (or for
 *  another revision): a new plan is needed before anything is confirmed. */
export function pluginPreviewIsStale(
  plan: HarnessPluginPlan,
  input: PluginInstallInput
): boolean {
  const planned = Object.fromEntries(
    plan.hosts.map((row) => [row.agent, plannedModeOf(row)])
  )
  return (
    !samePluginModes(planned, input.modes) ||
    plan.target !== pluginTargetOf(plan, input.modes).revision
  )
}

/** The two versions, when they are not one: the one installed whole and the
 *  latest — and why the latest is not the one. */
export type PluginVersions =
  | { kind: "same" }
  | {
      kind: "behind"
      full: string
      latest: string
      reason: "pending" | "unpinned"
    }
  | { kind: "none"; reason: "pending" | "unpinned" }

export function versionLabel(revision: {
  revision: number
  version: string | null
}): string {
  return revision.version ?? `#${revision.revision}`
}

/** As the website words it (docs/harness-plugins.md §9): `full` behind the
 *  latest, or none at all; a reason it does not know reads as waiting for
 *  review. */
export function pluginVersionsOf(
  full: { revision: number; version: string | null } | null,
  latest: { revision: number; version: string | null },
  notFull: string | null
): PluginVersions {
  const reason = notFull === "mcp_unpinned" ? "unpinned" : "pending"
  if (!full) return { kind: "none", reason }
  if (full.revision === latest.revision) return { kind: "same" }
  return {
    kind: "behind",
    full: versionLabel(full),
    latest: versionLabel(latest),
    reason,
  }
}

// ─── What runs on its own ─────────────────────────────────────────────

/** What runs on its own once installed whole: the plan's account of `full`,
 *  else `full`'s own. */
export function pluginAutorunOf(plan: HarnessPluginPlan): HarnessAutorunPart[] {
  return plan.autorun.length > 0 ? plan.autorun : (plan.full?.autorun ?? [])
}

/**
 * The modes chosen install something whole that runs on its own: the user
 * must agree to it. Never less strict than the plan says.
 */
export function pluginConsentNeeded(
  plan: HarnessPluginPlan,
  input: PluginInstallInput
): boolean {
  return (
    anyNative(input.modes) &&
    (plan.consent_required || pluginAutorunOf(plan).length > 0)
  )
}

export function pluginConsentGiven(
  plan: HarnessPluginPlan,
  input: PluginInstallInput
): boolean {
  return plan.consent_exec !== null && input.consentExec === plan.consent_exec
}

/**
 * The file an autorun part is declared in (or is), by its hash — to read it
 * whole. Only for a package SpaceRing keeps a copy of: one fetched from its
 * source has no file of that hash there.
 */
export function autorunFileOf<F extends { path: string; sha256: string }>(
  pkg: { archive: unknown; files: readonly F[] } | null,
  part: HarnessAutorunPart
): F | null {
  if (!pkg?.archive || !part.path) return null
  return (
    pkg.files.find((file) => file.path === part.path && file.sha256) ?? null
  )
}

// ─── What is confirmed ────────────────────────────────────────────────

export function needsPluginYankedConfirm(
  plan: HarnessPluginPlan,
  input: PluginInstallInput
): boolean {
  const target = pluginTargetOf(plan, input.modes)
  return (
    target.confirm.some((reason) => reason.code === "yanked") ||
    pluginTargetSnapshot(plan, input.modes)?.status === "yanked"
  )
}

/** What stands in the way of one row, by its preview: its skills cannot all
 *  go in (a name held, an op blocked, an issue), or there is no preview that
 *  can be read. */
export type PluginRowProblem = "blocked" | "noPreview"

export function pluginRowProblemOf(
  row: HarnessPluginPlanHost,
  mode: PluginMode
): PluginRowProblem | null {
  if (mode !== "skills" || plannedModeOf(row) !== "skills") return null
  const skills = row.skills
  if (!skills?.links) return "noPreview"
  if (
    skills.issues.length > 0 ||
    skills.held.length > 0 ||
    skills.links.ops.some((op) => op.status === "blocked")
  ) {
    return "blocked"
  }
  return null
}

/** What still stands between the dialog and an install. */
export type PluginInstallBlocker =
  /** The plan says nothing can be installed so (`plan.blocking`). */
  | { kind: "item" }
  /** Every agent is set to "not at all". */
  | { kind: "noHosts" }
  /** The revision has no install name. */
  | { kind: "name" }
  /** The catalog gave no fingerprint of the revision. */
  | { kind: "state" }
  /** A plan for the modes chosen is still being made. */
  | { kind: "planning" }
  | { kind: "consent" }
  | { kind: "yanked" }
  | { kind: "agent"; agent: string; problem: PluginRowProblem }

export function pluginInstallBlockersOf(
  plan: HarnessPluginPlan,
  input: PluginInstallInput
): PluginInstallBlocker[] {
  const blockers: PluginInstallBlocker[] = []
  if (plan.blocking.length > 0 || plan.installed) {
    blockers.push({ kind: "item" })
  }
  if (!Object.values(input.modes).some((mode) => mode !== "none")) {
    blockers.push({ kind: "noHosts" })
  }
  if (!plan.install_name) blockers.push({ kind: "name" })
  if (!pluginTargetOf(plan, input.modes).state_sha256) {
    blockers.push({ kind: "state" })
  }
  const stale = pluginPreviewIsStale(plan, input)
  if (stale) blockers.push({ kind: "planning" })
  if (pluginConsentNeeded(plan, input) && !pluginConsentGiven(plan, input)) {
    blockers.push({ kind: "consent" })
  }
  if (needsPluginYankedConfirm(plan, input) && !input.acceptYanked) {
    blockers.push({ kind: "yanked" })
  }
  if (!stale) {
    for (const row of plan.hosts) {
      const problem = pluginRowProblemOf(row, input.modes[row.agent] ?? "none")
      if (problem) blockers.push({ kind: "agent", agent: row.agent, problem })
    }
  }
  return blockers
}

/** The skills agents' acks, by agent and member: each op's of the preview on
 *  show, as the engine made it. */
export function pluginSkillsAcksOf(
  plan: HarnessPluginPlan,
  input: PluginInstallInput
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  for (const row of plan.hosts) {
    if (input.modes[row.agent] !== "skills") continue
    const acks: Record<string, string> = {}
    for (const op of row.skills?.links?.ops ?? []) {
      if (op.ack) acks[op.skill] = op.ack
    }
    if (Object.keys(acks).length > 0) out[row.agent] = acks
  }
  return out
}

/** The Experts takeovers that reach other agents, by agent: the ack the
 *  plan showed for each. */
export function pluginExpertsAcksOf(
  plan: HarnessPluginPlan,
  input: PluginInstallInput
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const row of plan.hosts) {
    const mode = input.modes[row.agent] ?? "none"
    if (mode !== "none" && row.experts_ack) out[row.agent] = row.experts_ack
  }
  return out
}

/**
 * The one install call the dialog makes — or `null` while anything is still
 * open. Built from the plan and the input alone: the plan's revision (the
 * one the modes install), its install name and fingerprint, every row's
 * mode, the agreement only where it is needed and given, the acks of what
 * the plan showed, and `acceptYanked` only where it was asked and ticked.
 */
export function pluginInstallArgsOf(
  itemRef: string,
  plan: HarnessPluginPlan,
  input: PluginInstallInput
): HarnessPluginInstallArgs | null {
  if (pluginInstallBlockersOf(plan, input).length > 0) return null
  const target = pluginTargetOf(plan, input.modes)
  if (!target.state_sha256 || !plan.install_name) return null
  const hosts: Record<string, PluginMode> = {}
  for (const row of plan.hosts) hosts[row.agent] = input.modes[row.agent]
  return {
    itemRef,
    revision: plan.target,
    installName: plan.install_name,
    hosts,
    stateSha256: target.state_sha256,
    consentExec: pluginConsentNeeded(plan, input) ? plan.consent_exec : null,
    acks: pluginSkillsAcksOf(plan, input),
    expertsAcks: pluginExpertsAcksOf(plan, input),
    acceptYanked: needsPluginYankedConfirm(plan, input) && input.acceptYanked,
  }
}
