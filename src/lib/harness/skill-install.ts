/**
 * The skill install dialog's decisions, as pure functions of the plan and of
 * what the user put in: the name, the agents, `allowed-tools`, the withdrawn
 * version — and, from all that, the one install call the dialog may make.
 *
 * Two rules shape everything here, as in `mcp-install.ts`:
 *
 * - **What is sent is what was shown.** The call carries the planned
 *   revision, the fingerprint of the catalog state the dialog showed (or,
 *   after the catalog's account changed, of the state the user was shown
 *   next), and for each agent the `ack` of the link preview on show — the
 *   plan's, for the name and agents it previewed, or the one the install sent
 *   back for the name and agents the user chose. The call is not built while
 *   the preview on show is not the one for what is ticked.
 * - **Defaults never decide for the user what the user has to confirm.**
 *   `allowed-tools` is dropped unless ticked; a withdrawn version is never
 *   accepted without a tick.
 */
import type { SkillsApplyResult } from "@/lib/skills/types"
import type { AgentType } from "@/lib/types"
import { knownRisk } from "./display"
import type { HarnessReason, HarnessVersionState } from "./mcp-install-types"
import type {
  HarnessSkillInstallArgs,
  HarnessSkillNameTaken,
  HarnessSkillPlan,
  HarnessSkillPlanAgent,
} from "./skill-install-types"
import { HARNESS_PERMISSION_KEYS } from "./types"

// ─── What the user put in ─────────────────────────────────────────────

export interface SkillInstallInput {
  /** The install name: the store id and SKILL.md's `name`. */
  name: string
  /** The agents ticked, in the plan's order. */
  agents: readonly AgentType[]
  /** Keep SKILL.md's `allowed-tools`. */
  keepAllowedTools: boolean
  acceptYanked: boolean
  /** What the user changed from the plan's proposal: kept over a new plan. */
  touched: { name: boolean; agents: boolean; allowedTools: boolean }
}

/** After an install came back `state_changed`: the catalog's state as it is
 *  now, which the next confirmation is a confirmation of, and what changed. */
export interface SkillInstallRestate {
  snapshot: HarnessVersionState | null
  stateSha256: string
  changes: HarnessReason[]
}

/** After an install came back `acknowledgement_required`: the link preview
 *  as the engine made it then, for the name and the agents that were sent. */
export interface SkillInstallRelinks {
  links: SkillsApplyResult
  name: string
  agents: readonly AgentType[]
}

const UNTOUCHED: SkillInstallInput["touched"] = {
  name: false,
  agents: false,
  allowedTools: false,
}

/** A first install, an update to another revision, or the installed
 *  revision installed again — its files put back as published. */
export type SkillInstallMode = "install" | "update" | "reinstall"

export function skillInstallModeOf(plan: HarnessSkillPlan): SkillInstallMode {
  const installed = plan.installed
  if (!installed) return "install"
  return plan.item.revision === installed.revision ? "reinstall" : "update"
}

// ─── Agents ───────────────────────────────────────────────────────────

export function planAgentOf(
  plan: HarnessSkillPlan,
  agent: string
): HarnessSkillPlanAgent | null {
  return plan.agents.find((entry) => entry.agent === agent) ?? null
}

/** An agent the skill can be linked to: one the plan lists with a folder to
 *  link into. */
export function isLinkable(plan: HarnessSkillPlan, agent: string): boolean {
  return planAgentOf(plan, agent)?.link_dir != null
}

/** `agents`, in the plan's order, without repeats or agents it does not
 *  list. */
export function orderedAgents(
  plan: HarnessSkillPlan,
  agents: readonly string[]
): AgentType[] {
  return plan.agents
    .map((entry) => entry.agent)
    .filter((agent) => agents.includes(agent))
}

/** The agents that see the installed skill now. An install only adds agents
 *  (h3-api §3): these keep it whatever is ticked, so they stay ticked. */
export function keptAgents(plan: HarnessSkillPlan): AgentType[] {
  if (!plan.installed) return []
  const seeing = new Set<string>([
    ...plan.installed.agents,
    ...plan.agents.filter((entry) => entry.sees).map((entry) => entry.agent),
  ])
  return orderedAgents(plan, [...seeing])
}

export const sameAgents = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((agent) => b.includes(agent))

/** The agents the plan proposes: its default ones that can be linked to,
 *  and those that see it already. */
function proposedAgents(plan: HarnessSkillPlan): AgentType[] {
  return orderedAgents(plan, [
    ...plan.default_agents.filter((agent) => isLinkable(plan, agent)),
    ...keptAgents(plan),
  ])
}

/** Whether SKILL.md declares `allowed-tools` at all. */
export function declaresAllowedTools(plan: HarnessSkillPlan): boolean {
  return (plan.skill.allowed_tools?.length ?? 0) > 0
}

/**
 * The input for a plan: its proposal — or, over a new plan of the same
 * dialog (other agents ticked, a link preview asked again), what the user had
 * put in wherever it still applies. An installed skill keeps the name it was
 * installed under; `allowed-tools` starts off, an update included.
 */
export function initialSkillInput(
  plan: HarnessSkillPlan,
  previous: SkillInstallInput | null = null
): SkillInstallInput {
  const touched = previous?.touched ?? UNTOUCHED
  const name = plan.installed
    ? plan.installed.name
    : previous && touched.name
      ? previous.name
      : plan.install_name.default
  const agents =
    previous && touched.agents
      ? orderedAgents(plan, [
          ...previous.agents.filter((agent) => isLinkable(plan, agent)),
          ...keptAgents(plan),
        ])
      : proposedAgents(plan)
  // Off until ticked in this dialog — an update too: the new version's
  // tools are not the ones the user kept last time. The dialog says what was
  // chosen then.
  const keepAllowedTools =
    declaresAllowedTools(plan) &&
    previous !== null &&
    touched.allowedTools &&
    previous.keepAllowedTools
  return {
    name,
    agents,
    keepAllowedTools,
    acceptYanked: previous?.acceptYanked ?? false,
    touched: { ...touched, name: plan.installed ? false : touched.name },
  }
}

export function setSkillInstallName(
  plan: HarnessSkillPlan,
  input: SkillInstallInput,
  name: string
): SkillInstallInput {
  if (plan.installed) return input
  return { ...input, name, touched: { ...input.touched, name: true } }
}

/** Tick or untick an agent. One that sees the installed skill now stays
 *  ticked: the install would not take it away. */
export function toggleSkillAgent(
  plan: HarnessSkillPlan,
  input: SkillInstallInput,
  agent: AgentType,
  on: boolean
): SkillInstallInput {
  if (on && !isLinkable(plan, agent)) return input
  if (!on && keptAgents(plan).includes(agent)) return input
  const rest = input.agents.filter((entry) => entry !== agent)
  return {
    ...input,
    agents: orderedAgents(plan, on ? [...rest, agent] : rest),
    touched: { ...input.touched, agents: true },
  }
}

export function setKeepAllowedTools(
  plan: HarnessSkillPlan,
  input: SkillInstallInput,
  keep: boolean
): SkillInstallInput {
  if (!declaresAllowedTools(plan)) return input
  return {
    ...input,
    keepAllowedTools: keep,
    touched: { ...input.touched, allowedTools: true },
  }
}

// ─── What is confirmed ────────────────────────────────────────────────

/** The catalog state on show: the plan's, or the one the catalog reported
 *  since. Every changeable fact the dialog shows comes from here. */
export function shownSkillSnapshot(
  plan: HarnessSkillPlan,
  restate: SkillInstallRestate | null
): HarnessVersionState | null {
  return restate ? restate.snapshot : plan.snapshot
}

export function confirmedSkillFingerprint(
  plan: HarnessSkillPlan,
  restate: SkillInstallRestate | null
): string | null {
  return restate?.stateSha256 ?? plan.state_sha256
}

export function needsSkillYankedConfirm(
  plan: HarnessSkillPlan,
  restate: SkillInstallRestate | null
): boolean {
  return (
    plan.confirm.some((reason) => reason.code === "yanked") ||
    shownSkillSnapshot(plan, restate)?.status === "yanked"
  )
}

/**
 * The link preview that stands for what is ticked now, or `null` when there
 * is none: the one the install sent back for this very name and these
 * agents, else the plan's — which is made under the proposed name, for the
 * agents it was asked about (`planAgents`).
 */
export function shownLinks(
  plan: HarnessSkillPlan,
  planAgents: readonly string[] | null,
  relinks: SkillInstallRelinks | null,
  input: SkillInstallInput
): SkillsApplyResult | null {
  const name = input.name.trim()
  if (
    relinks &&
    relinks.name === name &&
    sameAgents(relinks.agents, input.agents)
  ) {
    return relinks.links
  }
  if (
    name === plan.install_name.default &&
    planAgents !== null &&
    sameAgents(planAgents, input.agents)
  ) {
    return plan.links
  }
  return null
}

/** The plan's preview is for other agents than those ticked: a new plan is
 *  needed before anything can be confirmed. */
export function previewIsStale(
  planAgents: readonly string[] | null,
  input: SkillInstallInput
): boolean {
  return planAgents === null || !sameAgents(planAgents, input.agents)
}

// ─── Checks ───────────────────────────────────────────────────────────

export type SkillNameProblem =
  | "empty"
  | "invalid"
  /** An installed skill keeps the name it was installed under. */
  | "fixed"
  /** The plan found it held (a pack's, a custom skill, another item…). */
  | "taken"

/** Codeg's rule for a skill's install name (`names.rs`), for a plan whose
 *  own pattern cannot be read here. */
function fallbackRule(name: string): boolean {
  return (
    /^[a-z0-9-]{1,64}$/.test(name) &&
    !name.startsWith("-") &&
    !name.endsWith("-") &&
    !name.includes("--")
  )
}

function nameRule(plan: HarnessSkillPlan): (name: string) => boolean {
  if (plan.install_name.pattern) {
    try {
      const pattern = new RegExp(plan.install_name.pattern)
      return (name) => pattern.test(name)
    } catch {
      // A pattern this engine cannot compile: Codeg's own rule.
    }
  }
  return fallbackRule
}

/** Who holds `name`, by the plan — those that refuse an install. A name in
 *  an agent's own folder does not: that agent is just not linked. */
export function holdersOf(
  plan: HarnessSkillPlan,
  name: string
): HarnessSkillNameTaken[] {
  return plan.install_name.taken.filter(
    (entry) => entry.name === name && entry.by !== "agent_dir"
  )
}

export function skillNameProblemOf(
  plan: HarnessSkillPlan,
  name: string
): SkillNameProblem | null {
  if (plan.installed) return name === plan.installed.name ? null : "fixed"
  if (name === "") return "empty"
  if (!nameRule(plan)(name)) return "invalid"
  if (holdersOf(plan, name).length > 0) return "taken"
  return null
}

/** What still stands between the dialog and an install. */
export type SkillInstallBlocker =
  /** The item as a whole cannot be installed (`plan.blocking`). */
  | { kind: "item" }
  /** The catalog gave no fingerprint: there is no state to confirm. */
  | { kind: "state" }
  | { kind: "name"; problem: SkillNameProblem }
  /** What linking the ticked agents does is still being worked out. */
  | { kind: "links" }
  | { kind: "yanked" }

export function skillInstallBlockersOf(
  plan: HarnessSkillPlan,
  input: SkillInstallInput,
  restate: SkillInstallRestate | null,
  planAgents: readonly string[] | null
): SkillInstallBlocker[] {
  if (plan.blocking.length > 0) return [{ kind: "item" }]
  const blockers: SkillInstallBlocker[] = []
  if (!confirmedSkillFingerprint(plan, restate)) {
    blockers.push({ kind: "state" })
  }
  const problem = skillNameProblemOf(plan, input.name.trim())
  if (problem) blockers.push({ kind: "name", problem })
  if (previewIsStale(planAgents, input)) blockers.push({ kind: "links" })
  if (needsSkillYankedConfirm(plan, restate) && !input.acceptYanked) {
    blockers.push({ kind: "yanked" })
  }
  return blockers
}

/**
 * The one install call the dialog makes — or `null` while anything is still
 * open. Built from the plan, the input and the link preview on show alone:
 * the planned revision, the name, the ticked agents in the plan's order, the
 * fingerprint of the state the user confirmed, the ack of each link the
 * preview showed (no other), `allowed-tools` kept only where SKILL.md
 * declares it and the user ticked it, and `acceptYanked` only where it was
 * asked and ticked.
 */
export function skillInstallArgsOf(
  itemRef: string,
  plan: HarnessSkillPlan,
  input: SkillInstallInput,
  restate: SkillInstallRestate | null,
  planAgents: readonly string[] | null,
  relinks: SkillInstallRelinks | null
): HarnessSkillInstallArgs | null {
  if (skillInstallBlockersOf(plan, input, restate, planAgents).length > 0) {
    return null
  }
  const stateSha256 = confirmedSkillFingerprint(plan, restate)
  if (!stateSha256) return null
  const agents = orderedAgents(
    plan,
    input.agents.filter((agent) => isLinkable(plan, agent))
  )
  const links = shownLinks(plan, planAgents, relinks, input)
  const acks: Record<string, string> = {}
  for (const op of links?.ops ?? []) {
    if (op.ack && op.status !== "blocked" && agents.includes(op.agent)) {
      acks[op.agent] = op.ack
    }
  }
  return {
    itemRef,
    revision: plan.item.revision,
    installName: input.name.trim(),
    agents,
    keepAllowedTools: declaresAllowedTools(plan) && input.keepAllowedTools,
    stateSha256,
    acks,
    acceptYanked: needsSkillYankedConfirm(plan, restate) && input.acceptYanked,
  }
}

// ─── What grew ────────────────────────────────────────────────────────

const RISK_RANK: Record<string, number> = { low: 1, medium: 2, high: 3 }

export interface SkillGrowth {
  /** In the words of the catalog's changes (`risk_changed`,
   *  `permission_added`). */
  grown: HarnessReason[]
  /** False when one version's permissions were not stated: what it asks for
   *  could not be compared. */
  complete: boolean
}

/**
 * What the new version asks for that the installed one did not, and a risk
 * that is higher (or no longer stated) — by both versions' states as the
 * catalog gives them now. `null` when either state is not known: then
 * nothing can be said, which is not "nothing grew".
 */
export function grownSince(
  installed: HarnessVersionState | null,
  next: HarnessVersionState | null
): SkillGrowth | null {
  if (!installed || !next) return null
  const grown: HarnessReason[] = []
  if (next.risk !== installed.risk) {
    const from = knownRisk(installed.risk)
    const to = knownRisk(next.risk)
    const lower = from && to && RISK_RANK[to] < RISK_RANK[from]
    if (!lower) {
      grown.push({
        code: "risk_changed",
        params: { from: installed.risk ?? "", to: next.risk ?? "" },
        detail: null,
      })
    }
  }
  if (!installed.permissions || !next.permissions) {
    return { grown, complete: false }
  }
  for (const profile of ["declared", "detected"] as const) {
    for (const field of HARNESS_PERMISSION_KEYS) {
      const before = installed.permissions[profile][field]
      for (const value of next.permissions[profile][field]) {
        if (before.includes(value)) continue
        grown.push({
          code: "permission_added",
          params: { profile, field, value },
          detail: null,
        })
      }
    }
  }
  return { grown, complete: true }
}
