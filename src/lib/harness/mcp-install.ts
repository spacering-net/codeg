/**
 * The install dialog's decisions, as pure functions of the plan and of what
 * the user put in: which way of running the server is chosen, what is filled
 * in, the name, the agents, which existing entries may be replaced — and,
 * from all that, the one install call the dialog may make.
 *
 * Two rules shape everything here:
 *
 * - **What is sent is what was shown.** The call carries the planned revision,
 *   the fingerprint of the catalog state the dialog showed (or, after the
 *   catalog's account changed, of the state the user was shown next), and for
 *   each target the basis the plan read its file with. Nothing is taken from
 *   anywhere else, and the call is not built at all while something the user
 *   has to decide is still open.
 * - **Defaults never decide for the user what the user has to confirm.** An
 *   entry that is not this item's is never ticked for replacement; a yanked
 *   version is never accepted without a tick; an agent the record has at a
 *   newer revision is not ticked to be taken back to this one.
 */
import { DEFAULT_KEY_PATTERN, DEFAULT_RESERVED_KEYS } from "@/lib/mcp/keys"
import { isMcpAppType, type McpAppType, type McpBasis } from "@/lib/mcp/types"
import type {
  HarnessAgentEntry,
  HarnessKeyConflict,
  HarnessMcpInstallArgs,
  HarnessMcpPlan,
  HarnessMcpPlanAgent,
  HarnessMcpPlanOption,
  HarnessMcpPlanParameter,
  HarnessPackageState,
  HarnessReason,
  HarnessVersionState,
} from "./mcp-install-types"

// ─── What the user put in ─────────────────────────────────────────────

export interface McpInstallInput {
  optionId: string | null
  /**
   * By parameter key. Secrets are among them: this lives in a slot — memory,
   * for as long as the dialog is open — and is never written anywhere else.
   */
  values: Readonly<Record<string, string>>
  key: string
  agents: readonly McpAppType[]
  replace: readonly McpAppType[]
  acceptYanked: boolean
  /** Parameters the user set themselves (typed in, chose, or took a
   *  recorded value for): kept over a new plan, and what settles agents'
   *  entries that disagree. */
  decided: readonly string[]
  /** What the user changed from the plan's proposal: kept over a new plan,
   *  where it still applies. */
  touched: {
    option: boolean
    key: boolean
    agents: boolean
    replace: boolean
  }
}

/**
 * After an install came back `state_changed`: the catalog's state as it is
 * now, which the next confirmation is a confirmation of, and what changed.
 */
export interface McpInstallRestate {
  snapshot: HarnessVersionState | null
  stateSha256: string
  changes: HarnessReason[]
}

const UNTOUCHED: McpInstallInput["touched"] = {
  option: false,
  key: false,
  agents: false,
  replace: false,
}

// ─── Options ──────────────────────────────────────────────────────────

export function optionOf(
  plan: HarnessMcpPlan,
  id: string | null
): HarnessMcpPlanOption | null {
  return id === null
    ? null
    : (plan.options.find((option) => option.id === id) ?? null)
}

/** The option the user chose, when it can be chosen. */
export function chosenOption(
  plan: HarnessMcpPlan,
  input: McpInstallInput
): HarnessMcpPlanOption | null {
  const option = optionOf(plan, input.optionId)
  return option?.selectable && plan.blocking.length === 0 ? option : null
}

function proposedOption(plan: HarnessMcpPlan): HarnessMcpPlanOption | null {
  if (plan.blocking.length > 0) return null
  const proposed = optionOf(plan, plan.default_option)
  if (proposed?.selectable) return proposed
  return plan.options.find((option) => option.selectable) ?? null
}

// ─── Agents ───────────────────────────────────────────────────────────

/** Why an agent cannot be a target. */
export type McpInstallTargetBlock =
  /** A newer Codeg's agent: this build cannot name it in a call. */
  | { kind: "unknownAgent" }
  /** Codeg does not write its file now: unreadable, read-only, listed only. */
  | { kind: "file"; status: string }
  | { kind: "transport"; transport: string }

export interface McpInstallTargetRow {
  /** As the backend spells it. */
  id: string
  agent: McpAppType | null
  info: HarnessMcpPlanAgent
  block: McpInstallTargetBlock | null
  /** It has a server under the chosen name already. */
  existing: boolean
  /** What the plan knows of that server, for the name it planned. */
  conflict: HarnessKeyConflict | null
  /** Where the server under the chosen name came from — for any name, the
   *  ones the user types too. */
  entry: HarnessAgentEntry | null
}

export function targetBlockOf(
  plan: HarnessMcpPlan,
  info: HarnessMcpPlanAgent,
  option: HarnessMcpPlanOption | null
): McpInstallTargetBlock | null {
  if (!isMcpAppType(info.agent)) return { kind: "unknownAgent" }
  // A file the plan has no basis for is not one the install may write.
  if (!info.writable || plan.basis[info.agent] === undefined) {
    return { kind: "file", status: info.status }
  }
  if (option && !info.transports.includes(option.transport)) {
    return { kind: "transport", transport: option.transport }
  }
  return null
}

export function conflictOf(
  plan: HarnessMcpPlan,
  agent: string,
  key: string
): HarnessKeyConflict | null {
  return (
    plan.key.conflicts.find(
      (conflict) => conflict.agent === agent && conflict.key === key
    ) ?? null
  )
}

function holdsKey(info: HarnessMcpPlanAgent, key: string): boolean {
  return (
    key !== "" &&
    (info.keys.includes(key) || info.entries.some((entry) => entry.key === key))
  )
}

function hasKey(plan: HarnessMcpPlan, agent: string, key: string): boolean {
  const info = plan.agents.find((candidate) => candidate.agent === agent)
  return info ? holdsKey(info, key) : false
}

/** Every agent, in the plan's order, as the target list shows it. */
export function targetRowsOf(
  plan: HarnessMcpPlan,
  option: HarnessMcpPlanOption | null,
  key: string
): McpInstallTargetRow[] {
  return plan.agents.map((info) => ({
    id: info.agent,
    agent: isMcpAppType(info.agent) ? info.agent : null,
    info,
    block: targetBlockOf(plan, info, option),
    existing: holdsKey(info, key),
    conflict: key !== "" ? conflictOf(plan, info.agent, key) : null,
    entry:
      key !== ""
        ? (info.entries.find((entry) => entry.key === key) ?? null)
        : null,
  }))
}

function allowedTargets(
  plan: HarnessMcpPlan,
  option: HarnessMcpPlanOption | null
): Set<McpAppType> {
  const allowed = new Set<McpAppType>()
  for (const info of plan.agents) {
    if (isMcpAppType(info.agent) && !targetBlockOf(plan, info, option)) {
      allowed.add(info.agent)
    }
  }
  return allowed
}

/** Agents the record has at a revision newer than the one planned: managing
 *  agents at an older revision must not quietly take them back to it. */
function newerRecorded(plan: HarnessMcpPlan): Set<string> {
  return new Set(
    (plan.installed?.agents ?? [])
      .filter((agent) => agent.revision > plan.item.revision)
      .map((agent) => agent.agent)
  )
}

/** The targets the plan proposes for `option`, and of those the ones whose
 *  entry — this item's own — is ticked to be replaced. */
export function defaultTargetsOf(
  plan: HarnessMcpPlan,
  option: HarnessMcpPlanOption | null
): { agents: McpAppType[]; replace: McpAppType[] } {
  if (!option) return { agents: [], replace: [] }
  const allowed = allowedTargets(plan, option)
  const newer = newerRecorded(plan)
  const agents = option.default_targets.filter(
    (agent): agent is McpAppType =>
      isMcpAppType(agent) && allowed.has(agent) && !newer.has(agent)
  )
  // Only this item's own entries are ever ticked for the user: overwriting
  // anything else is something they tick themselves.
  const replace = option.default_replace.filter(
    (agent): agent is McpAppType =>
      isMcpAppType(agent) &&
      agents.includes(agent) &&
      conflictOf(plan, agent, plan.key.default)?.owner === "this_item"
  )
  return { agents, replace }
}

// ─── Values ───────────────────────────────────────────────────────────

/**
 * What the fields start with: what an installed item's own entries hold for
 * each parameter now (`current`, read back by the backend — only where that
 * is certain), else its default. Codeg keeps no copy of what was typed at the
 * last install, and an update writes the entries anew: without this, a key
 * typed then would be dropped.
 *
 * Where the agents' entries disagree, nothing is filled in silently: the
 * field starts as it would for a new install, and the dialog says why and
 * asks (see the `disagree` blocker).
 */
export function prefillOf(
  _plan: HarnessMcpPlan,
  option: HarnessMcpPlanOption | null
): Record<string, string> {
  const out: Record<string, string> = {}
  if (!option) return out
  for (const parameter of option.parameters) {
    const current = parameter.current
    out[parameter.key] =
      current && !current.conflicting
        ? current.value
        : (parameter.default ?? "")
  }
  return out
}

/**
 * Values for `option`: what the user set for a parameter it still has, the
 * prefill for the rest — and which of them the user set. A value that does
 * not come along (a way of running it without that parameter) loses its
 * "set by the user" too: coming back to it later starts from the prefill,
 * and a disagreement the user had settled is asked again.
 */
function valuesFor(
  plan: HarnessMcpPlan,
  option: HarnessMcpPlanOption | null,
  previous: Pick<McpInstallInput, "values" | "decided"> | null
): { values: Record<string, string>; decided: string[] } {
  const values = prefillOf(plan, option)
  const decided: string[] = []
  if (!previous) return { values, decided }
  for (const key of Object.keys(values)) {
    const set = previous.values[key]
    if (set !== undefined && previous.decided.includes(key)) {
      values[key] = set
      decided.push(key)
    }
  }
  return { values, decided }
}

// ─── Building and changing the input ──────────────────────────────────

function proposedReplace(
  plan: HarnessMcpPlan,
  option: HarnessMcpPlanOption | null,
  key: string,
  agents: readonly McpAppType[]
): McpAppType[] {
  if (key !== plan.key.default) return []
  return defaultTargetsOf(plan, option).replace.filter((agent) =>
    agents.includes(agent)
  )
}

/**
 * The input for a plan: its proposal — or, over a new plan of the same
 * dialog (a file changed under it), what the user had put in wherever it
 * still applies: a way of running it that can still be chosen, the values of
 * parameters it still has, a name, agents that can still take it, and
 * replacements of entries that are still there.
 */
export function initialInput(
  plan: HarnessMcpPlan,
  previous: McpInstallInput | null = null
): McpInstallInput {
  const touched = previous?.touched ?? UNTOUCHED
  const kept =
    previous && touched.option ? optionOf(plan, previous.optionId) : null
  const option = kept?.selectable ? kept : proposedOption(plan)
  const key = plan.installed
    ? plan.installed.key
    : previous && touched.key
      ? previous.key
      : plan.key.default
  const allowed = allowedTargets(plan, option)
  const agents =
    previous && touched.agents
      ? previous.agents.filter((agent) => allowed.has(agent))
      : defaultTargetsOf(plan, option).agents
  const replace =
    previous && touched.replace
      ? previous.replace.filter(
          (agent) => agents.includes(agent) && hasKey(plan, agent, key)
        )
      : proposedReplace(plan, option, key, agents)
  const { values, decided } = valuesFor(plan, option, previous)
  return {
    optionId: option?.id ?? null,
    values,
    key,
    agents,
    replace,
    acceptYanked: previous?.acceptYanked ?? false,
    decided,
    touched: {
      ...touched,
      // A name the plan fixed is not the user's choice any more.
      key: plan.installed ? false : touched.key,
    },
  }
}

export function chooseOption(
  plan: HarnessMcpPlan,
  input: McpInstallInput,
  optionId: string
): McpInstallInput {
  const option = optionOf(plan, optionId)
  if (!option?.selectable || plan.blocking.length > 0) return input
  const allowed = allowedTargets(plan, option)
  const agents = input.touched.agents
    ? input.agents.filter((agent) => allowed.has(agent))
    : defaultTargetsOf(plan, option).agents
  const replace = input.touched.replace
    ? input.replace.filter((agent) => agents.includes(agent))
    : proposedReplace(plan, option, input.key, agents)
  return {
    ...input,
    optionId,
    ...valuesFor(plan, option, input),
    agents,
    replace,
    touched: { ...input.touched, option: true },
  }
}

/** A new name. What was ticked for replacement was for the old one. */
export function setInstallKey(
  plan: HarnessMcpPlan,
  input: McpInstallInput,
  key: string
): McpInstallInput {
  if (plan.installed) return input
  return {
    ...input,
    key,
    replace: proposedReplace(
      plan,
      chosenOption(plan, input),
      key.trim(),
      input.agents
    ),
    touched: { ...input.touched, key: true, replace: false },
  }
}

export function toggleTarget(
  plan: HarnessMcpPlan,
  input: McpInstallInput,
  agent: McpAppType,
  on: boolean
): McpInstallInput {
  const option = chosenOption(plan, input)
  if (on && !allowedTargets(plan, option).has(agent)) return input
  const agents = on
    ? [...input.agents.filter((entry) => entry !== agent), agent]
    : input.agents.filter((entry) => entry !== agent)
  const key = input.key.trim()
  // Ticked again: this item's own entry is replaced as it was proposed.
  const own =
    on &&
    !input.touched.replace &&
    proposedReplace(plan, option, key, [agent]).includes(agent)
  const replace = on
    ? own
      ? [...input.replace.filter((entry) => entry !== agent), agent]
      : input.replace
    : input.replace.filter((entry) => entry !== agent)
  return {
    ...input,
    agents,
    replace,
    touched: { ...input.touched, agents: true },
  }
}

export function toggleReplace(
  input: McpInstallInput,
  agent: McpAppType,
  on: boolean
): McpInstallInput {
  return {
    ...input,
    replace: on
      ? [...input.replace.filter((entry) => entry !== agent), agent]
      : input.replace.filter((entry) => entry !== agent),
    touched: { ...input.touched, replace: true },
  }
}

/** The user sets a value — typing, choosing, or taking the one an agent's
 *  entry holds. */
export function setValue(
  input: McpInstallInput,
  key: string,
  value: string
): McpInstallInput {
  return {
    ...input,
    values: { ...input.values, [key]: value },
    decided: input.decided.includes(key)
      ? input.decided
      : [...input.decided, key],
  }
}

/** An installed item's agents' entries disagree on this parameter, and the
 *  user has not said which value to keep. */
export function isUndecided(
  parameter: HarnessMcpPlanParameter,
  input: McpInstallInput
): boolean {
  return (
    parameter.current?.conflicting === true &&
    !input.decided.includes(parameter.key)
  )
}

// ─── What is confirmed ────────────────────────────────────────────────

/** The catalog state on show: the plan's, or the one the catalog reported
 *  since. Every changeable fact the dialog shows comes from here. */
export function shownSnapshot(
  plan: HarnessMcpPlan,
  restate: McpInstallRestate | null
): HarnessVersionState | null {
  return restate ? restate.snapshot : plan.snapshot
}

export function confirmedFingerprint(
  plan: HarnessMcpPlan,
  restate: McpInstallRestate | null
): string | null {
  return restate?.stateSha256 ?? plan.state_sha256
}

/** The author withdrew the version: by the plan, or by the state since. */
export function needsYankedConfirm(
  plan: HarnessMcpPlan,
  restate: McpInstallRestate | null
): boolean {
  return (
    plan.confirm.some((reason) => reason.code === "yanked") ||
    shownSnapshot(plan, restate)?.status === "yanked"
  )
}

/** A package's state, by the snapshot on show — not by the plan's copy, which
 *  an update of the state since may have outdated. */
export function packageStateOf(
  snapshot: HarnessVersionState | null,
  registryType: string,
  identifier: string
): HarnessPackageState | null {
  return (
    snapshot?.packages?.find(
      (entry) =>
        entry.registryType === registryType && entry.identifier === identifier
    ) ?? null
  )
}

// ─── Checks ───────────────────────────────────────────────────────────

export type McpInstallKeyProblem =
  | "empty"
  | "invalid"
  | "reserved"
  /** An installed item keeps the name it was installed under. */
  | "fixed"

function keyRule(plan: HarnessMcpPlan): RegExp {
  try {
    return new RegExp(plan.key.pattern || DEFAULT_KEY_PATTERN)
  } catch {
    return new RegExp(DEFAULT_KEY_PATTERN)
  }
}

export function keyProblemOf(
  plan: HarnessMcpPlan,
  key: string
): McpInstallKeyProblem | null {
  if (plan.installed && key !== plan.installed.key) return "fixed"
  if (key === "") return "empty"
  if (DEFAULT_RESERVED_KEYS.includes(key)) return "reserved"
  if (!keyRule(plan).test(key)) return "invalid"
  return null
}

export type McpParameterProblem =
  | "required"
  | "number"
  | "integer"
  | "boolean"
  | "json"
  /** Not one of the values it takes. */
  | "choice"

/** What is wrong with a value, or `null`. Empty is "not given": fine unless
 *  the parameter is required and has no default to fall back on. */
export function parameterProblemOf(
  parameter: HarnessMcpPlanParameter,
  value: string | undefined
): McpParameterProblem | null {
  const given = (value ?? "").trim()
  if (given === "") {
    return parameter.required && parameter.default === null ? "required" : null
  }
  if (parameter.choices.length > 0 && !parameter.choices.includes(given)) {
    return "choice"
  }
  switch (parameter.kind) {
    case "number":
      return Number.isFinite(Number(given)) ? null : "number"
    case "integer":
      return /^[+-]?\d+$/.test(given) ? null : "integer"
    case "boolean":
      return given === "true" || given === "false" ? null : "boolean"
    case "json":
      try {
        JSON.parse(given)
        return null
      } catch {
        return "json"
      }
    default:
      return null
  }
}

/** What still stands between the dialog and an install. */
export type McpInstallBlocker =
  /** The item as a whole cannot be installed (`plan.blocking`). */
  | { kind: "item" }
  /** The catalog gave no fingerprint: there is no state to confirm. */
  | { kind: "state" }
  | { kind: "option" }
  | {
      kind: "parameter"
      parameter: HarnessMcpPlanParameter
      problem: McpParameterProblem
    }
  /** The agents' entries hold different values for it: the user picks. */
  | { kind: "disagree"; parameter: HarnessMcpPlanParameter }
  | { kind: "key"; problem: McpInstallKeyProblem }
  | { kind: "targets" }
  /** Ticked agents that have a server under the name, not ticked to be
   *  replaced. */
  | { kind: "replace"; agents: McpAppType[] }
  | { kind: "yanked" }

export function installBlockersOf(
  plan: HarnessMcpPlan,
  input: McpInstallInput,
  restate: McpInstallRestate | null
): McpInstallBlocker[] {
  if (plan.blocking.length > 0) return [{ kind: "item" }]
  const blockers: McpInstallBlocker[] = []
  if (!confirmedFingerprint(plan, restate)) blockers.push({ kind: "state" })
  const option = chosenOption(plan, input)
  if (!option) {
    blockers.push({ kind: "option" })
  } else {
    for (const parameter of option.parameters) {
      if (isUndecided(parameter, input)) {
        blockers.push({ kind: "disagree", parameter })
        continue
      }
      const problem = parameterProblemOf(parameter, input.values[parameter.key])
      if (problem) blockers.push({ kind: "parameter", parameter, problem })
    }
  }
  const key = input.key.trim()
  const keyProblem = keyProblemOf(plan, key)
  if (keyProblem) blockers.push({ kind: "key", problem: keyProblem })
  const allowed = allowedTargets(plan, option)
  const agents = input.agents.filter((agent) => allowed.has(agent))
  if (agents.length === 0) blockers.push({ kind: "targets" })
  const unconfirmed = agents.filter(
    (agent) => hasKey(plan, agent, key) && !input.replace.includes(agent)
  )
  if (unconfirmed.length > 0) {
    blockers.push({ kind: "replace", agents: unconfirmed })
  }
  if (needsYankedConfirm(plan, restate) && !input.acceptYanked) {
    blockers.push({ kind: "yanked" })
  }
  return blockers
}

/**
 * The one install call the dialog makes — or `null` while anything is still
 * open. Built from the plan and the input alone: the planned revision, the
 * chosen option's own parameters (an empty value is "not given" and left
 * out), each target's basis as the plan read it, the fingerprint of the
 * state the user confirmed, and `acceptYanked` only where it was asked and
 * ticked.
 */
export function installArgsOf(
  itemRef: string,
  plan: HarnessMcpPlan,
  input: McpInstallInput,
  restate: McpInstallRestate | null
): HarnessMcpInstallArgs | null {
  if (installBlockersOf(plan, input, restate).length > 0) return null
  const option = chosenOption(plan, input)
  const stateSha256 = confirmedFingerprint(plan, restate)
  if (!option || !stateSha256) return null
  const allowed = allowedTargets(plan, option)
  const agents = input.agents.filter((agent) => allowed.has(agent))
  const key = input.key.trim()
  const basis: McpBasis = {}
  for (const agent of agents) {
    const found = plan.basis[agent]
    if (found === undefined) return null
    basis[agent] = found
  }
  const values: Record<string, string> = {}
  for (const parameter of option.parameters) {
    const value = input.values[parameter.key]
    if (value !== undefined && value.trim() !== "") {
      values[parameter.key] = value
    }
  }
  return {
    itemRef,
    revision: plan.item.revision,
    optionId: option.id,
    values,
    key,
    agents,
    replace: input.replace.filter(
      (agent) => agents.includes(agent) && hasKey(plan, agent, key)
    ),
    stateSha256,
    basis,
    acceptYanked: needsYankedConfirm(plan, restate) && input.acceptYanked,
  }
}

// ─── What the dialog is ───────────────────────────────────────────────

/** Whether a plan installs afresh, updates, or only changes the agents of an
 *  item that is installed at this very revision. */
export type McpInstallMode = "install" | "update" | "manage"

export function installModeOf(plan: HarnessMcpPlan): McpInstallMode {
  const installed = plan.installed
  if (!installed) return "install"
  const newest = Math.max(
    installed.revision,
    ...installed.agents.map((agent) => agent.revision)
  )
  return plan.item.revision > newest ? "update" : "manage"
}
