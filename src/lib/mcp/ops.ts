/**
 * The ops the page sends, and the basis they are sent with.
 *
 * Every write is a list of explicit ops — "this agent, this key, this action"
 * — built only for the agents the user chose. Nothing is ever implied for the
 * agents that were not chosen: an agent left unticked is not in the list, so
 * its file is not even opened for writing.
 */
import {
  isMcpAppType,
  type McpApplyResult,
  type McpAppType,
  type McpBasis,
  type McpDefinition,
  type McpInventory,
  type McpOp,
} from "./types"

export interface McpPlan {
  ops: McpOp[]
  /** Each named agent's basis, as the page last read it. */
  basis: McpBasis
}

/** The agents `ops` names, in order of first appearance — the order the
 *  engine handles and reports them in. */
export function agentsOf(ops: readonly McpOp[]): McpAppType[] {
  const seen = new Set<McpAppType>()
  for (const op of ops) seen.add(op.agent)
  return [...seen]
}

/** `config.basis` for each agent, from the inventory. An agent whose file
 *  could not be read has none, and the engine says so for it. */
export function basisOf(
  inventory: McpInventory,
  agents: readonly McpAppType[]
): McpBasis {
  const basis: McpBasis = {}
  for (const agent of agents) {
    const found = inventory.agents.find(
      (candidate) => candidate.agent === agent
    )
    if (found?.config.basis) basis[agent] = found.config.basis
  }
  return basis
}

export function planOf(ops: McpOp[], inventory: McpInventory): McpPlan {
  return { ops, basis: basisOf(inventory, agentsOf(ops)) }
}

/**
 * The basis a preflight found, to commit with: the files as they were when
 * the user was shown what would be written. If one has changed since, the
 * commit writes nothing and says so.
 */
export function basisFromResult(result: McpApplyResult): McpBasis {
  const basis: McpBasis = {}
  for (const agent of result.agents) {
    if (isMcpAppType(agent.agent) && agent.basis !== null) {
      basis[agent.agent] = agent.basis
    }
  }
  return basis
}

export function setOps(
  key: string,
  definition: McpDefinition,
  agents: readonly McpAppType[]
): McpOp[] {
  return agents.map((agent) => ({ agent, key, action: "set", definition }))
}

export function removeOps(key: string, agents: readonly McpAppType[]): McpOp[] {
  return agents.map((agent) => ({ agent, key, action: "remove" }))
}

/** One `rename` per agent that has the key. */
export function renameOps(
  key: string,
  newKey: string,
  agents: readonly McpAppType[]
): McpOp[] {
  return agents.map((agent) => ({
    agent,
    key,
    action: "rename",
    new_key: newKey,
  }))
}

export function enableOp(
  key: string,
  agent: McpAppType,
  enabled: boolean
): McpOp {
  return { agent, key, action: "set_enabled", enabled }
}
