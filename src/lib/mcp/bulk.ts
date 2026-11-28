/**
 * Cross-agent compatible bulk allocation planners (#884).
 *
 * Pure planning functions that inspect an {@link McpModel} and return the
 * exact `McpOp` list to feed into `mcpApply({ preflight: true })` and then
 * commit atomically, together with transparent lists of already-active items
 * and skipped items with structured reasons.
 *
 * Safety invariant: {@link planServerBulkDisable} NEVER emits `remove` ops.
 * Agents that cannot disable/pause a server (`!can_disable`) are skipped with
 * `{ kind: "cannotDisable" }` so user definitions are never destroyed.
 */
import { newKeyProblem } from "./keys"
import {
  type McpAgentBlock,
  type McpAgentInfo,
  type McpDefinitionGroup,
  type McpModel,
  type McpServer,
} from "./model"
import type { McpAppType, McpDefinition, McpOp } from "./types"

export type McpBulkSkipReason =
  | { kind: "notInstalled" }
  | { kind: "unknownAgent" }
  | { kind: "readOnly" }
  | { kind: "unreadable" }
  | { kind: "unsupportedTransport"; transport: string }
  | { kind: "reservedKey" }
  | { kind: "keyNotNew" }
  | { kind: "entryReadOnly" }
  | { kind: "duplicateKey" }
  | { kind: "cannotDisable" }
  | { kind: "noDefinition" }
  | { kind: "differentDefinition" }

export interface McpServerBulkCandidate {
  agent: McpAppType
  op: McpOp
  effect: "add" | "enable" | "update" | "disable"
}

export interface McpServerBulkSkipped {
  agent: string
  reason: McpBulkSkipReason
}

export interface McpServerBulkPlan {
  mode: "server_enable" | "server_disable"
  serverKey: string
  ops: McpServerBulkCandidate[]
  /** Already enabled (for `server_enable`) or already off/paused (for `server_disable`). */
  alreadyActive: McpAppType[]
  skipped: McpServerBulkSkipped[]
}

export interface McpAgentBulkCandidate {
  serverKey: string
  op: McpOp
  effect: "add" | "enable"
  definition: McpDefinition
}

export interface McpAgentBulkSkipped {
  serverKey: string
  reason: McpBulkSkipReason
}

export interface McpAgentBulkPlan {
  mode: "agent_enable"
  agent: McpAppType
  ops: McpAgentBulkCandidate[]
  alreadyActive: string[]
  skipped: McpAgentBulkSkipped[]
}

export type McpBulkPlan = McpServerBulkPlan | McpAgentBulkPlan

function blockSkipReason(
  info: McpAgentInfo,
  block: McpAgentBlock
): McpBulkSkipReason {
  if (block.kind === "unknownAgent") return { kind: "unknownAgent" }
  if (info.unreadable || block.kind === "related") {
    return { kind: "unreadable" }
  }
  return { kind: "readOnly" }
}

/**
 * Plan applying or enabling `server` (using `group`'s definition) across every
 * compatible, installed, writable agent in `model`.
 */
export function planServerBulkEnable(
  server: McpServer,
  group: McpDefinitionGroup,
  model: McpModel
): McpServerBulkPlan {
  const ops: McpServerBulkCandidate[] = []
  const alreadyActive: McpAppType[] = []
  const skipped: McpServerBulkSkipped[] = []
  const isReservedServer =
    server.reserved || model.rules.reserved.includes(server.key)

  for (const info of model.agents) {
    if (!info.agent) {
      skipped.push({ agent: info.id, reason: { kind: "unknownAgent" } })
      continue
    }

    const holders = server.holders.filter((h) => h.info.id === info.id)
    const holder = holders[0]

    if (
      holders.length > 1 ||
      holder?.entry.problems.some((p) => p.code === "duplicate_key")
    ) {
      skipped.push({ agent: info.id, reason: { kind: "duplicateKey" } })
      continue
    }

    if (holder && holder.entry.enabled) {
      if (holder.entry.fingerprint === group.fingerprint) {
        alreadyActive.push(info.agent)
      } else {
        skipped.push({
          agent: info.id,
          reason: { kind: "differentDefinition" },
        })
      }
      continue
    }

    if (info.installed === false) {
      skipped.push({ agent: info.id, reason: { kind: "notInstalled" } })
      continue
    }

    if (isReservedServer || holder?.entry.reserved) {
      skipped.push({ agent: info.id, reason: { kind: "reservedKey" } })
      continue
    }

    if (holder?.entry.read_only) {
      skipped.push({ agent: info.id, reason: { kind: "entryReadOnly" } })
      continue
    }

    if (!info.transports.has(group.definition.type)) {
      skipped.push({
        agent: info.id,
        reason: {
          kind: "unsupportedTransport",
          transport: group.definition.type,
        },
      })
      continue
    }

    if (
      holder &&
      !holder.entry.enabled &&
      holder.entry.fingerprint === group.fingerprint
    ) {
      if (info.toggleBlock) {
        skipped.push({
          agent: info.id,
          reason: blockSkipReason(info, info.toggleBlock),
        })
        continue
      }
      ops.push({
        agent: info.agent,
        effect: "enable",
        op: {
          agent: info.agent,
          key: server.key,
          action: "set_enabled",
          enabled: true,
        },
      })
      continue
    }

    if (info.editBlock) {
      skipped.push({
        agent: info.id,
        reason: blockSkipReason(info, info.editBlock),
      })
      continue
    }

    if (!holder && newKeyProblem(server.key, model.rules) !== null) {
      skipped.push({ agent: info.id, reason: { kind: "keyNotNew" } })
      continue
    }

    ops.push({
      agent: info.agent,
      effect: holder ? "update" : "add",
      op: {
        agent: info.agent,
        key: server.key,
        action: "set",
        definition: group.definition,
      },
    })
  }

  return {
    mode: "server_enable",
    serverKey: server.key,
    ops,
    alreadyActive,
    skipped,
  }
}

/**
 * Plan disabling/pausing `server` on every currently enabled agent that
 * supports disabling (`can_disable === true`) and is writable.
 *
 * NEVER generates `remove` ops.
 */
export function planServerBulkDisable(
  server: McpServer,
  model: McpModel
): McpServerBulkPlan {
  const ops: McpServerBulkCandidate[] = []
  const alreadyActive: McpAppType[] = []
  const skipped: McpServerBulkSkipped[] = []
  const seen = new Set<string>()

  for (const holder of server.holders) {
    const { info, entry } = holder
    if (seen.has(info.id)) continue
    seen.add(info.id)

    if (!info.agent) {
      skipped.push({ agent: info.id, reason: { kind: "unknownAgent" } })
      continue
    }

    const dupes = server.holders.filter((h) => h.info.id === info.id)
    if (
      dupes.length > 1 ||
      entry.problems.some((p) => p.code === "duplicate_key")
    ) {
      skipped.push({ agent: info.id, reason: { kind: "duplicateKey" } })
      continue
    }

    if (!entry.enabled) {
      alreadyActive.push(info.agent)
      continue
    }

    if (entry.reserved || model.rules.reserved.includes(server.key)) {
      skipped.push({ agent: info.id, reason: { kind: "reservedKey" } })
      continue
    }

    if (entry.read_only) {
      skipped.push({ agent: info.id, reason: { kind: "entryReadOnly" } })
      continue
    }

    if (info.toggleBlock) {
      skipped.push({
        agent: info.id,
        reason: blockSkipReason(info, info.toggleBlock),
      })
      continue
    }

    if (!info.inventory.can_disable || info.disableMode === "unsupported") {
      skipped.push({ agent: info.id, reason: { kind: "cannotDisable" } })
      continue
    }

    ops.push({
      agent: info.agent,
      effect: "disable",
      op: {
        agent: info.agent,
        key: server.key,
        action: "set_enabled",
        enabled: false,
      },
    })
  }

  return {
    mode: "server_disable",
    serverKey: server.key,
    ops,
    alreadyActive,
    skipped,
  }
}

/**
 * Reverse bulk planner: given a single agent, plan enabling or adding every
 * compatible local MCP server in `model`.
 */
export function planAgentBulkEnable(
  agentInfo: McpAgentInfo,
  model: McpModel
): McpAgentBulkPlan {
  const ops: McpAgentBulkCandidate[] = []
  const alreadyActive: string[] = []
  const skipped: McpAgentBulkSkipped[] = []

  if (!agentInfo.agent) {
    return {
      mode: "agent_enable",
      agent: agentInfo.id as McpAppType,
      ops,
      alreadyActive,
      skipped: model.servers.map((server) => ({
        serverKey: server.key,
        reason: { kind: "unknownAgent" },
      })),
    }
  }

  const agent = agentInfo.agent
  for (const server of model.servers) {
    const holders = server.holders.filter((h) => h.info.id === agentInfo.id)
    const holder = holders[0]
    const isReserved =
      server.reserved || model.rules.reserved.includes(server.key)

    if (
      holders.length > 1 ||
      holder?.entry.problems.some((p) => p.code === "duplicate_key")
    ) {
      skipped.push({ serverKey: server.key, reason: { kind: "duplicateKey" } })
      continue
    }

    if (holder && holder.entry.enabled) {
      alreadyActive.push(server.key)
      continue
    }

    if (isReserved || holder?.entry.reserved) {
      skipped.push({ serverKey: server.key, reason: { kind: "reservedKey" } })
      continue
    }

    if (holder?.entry.read_only) {
      skipped.push({
        serverKey: server.key,
        reason: { kind: "entryReadOnly" },
      })
      continue
    }

    if (holder && !holder.entry.enabled && holder.entry.definition) {
      if (!agentInfo.transports.has(holder.entry.definition.type)) {
        skipped.push({
          serverKey: server.key,
          reason: {
            kind: "unsupportedTransport",
            transport: holder.entry.definition.type,
          },
        })
        continue
      }
      if (agentInfo.toggleBlock) {
        skipped.push({
          serverKey: server.key,
          reason: blockSkipReason(agentInfo, agentInfo.toggleBlock),
        })
        continue
      }
      ops.push({
        serverKey: server.key,
        effect: "enable",
        definition: holder.entry.definition,
        op: {
          agent,
          key: server.key,
          action: "set_enabled",
          enabled: true,
        },
      })
      continue
    }

    if (agentInfo.editBlock) {
      skipped.push({
        serverKey: server.key,
        reason: blockSkipReason(agentInfo, agentInfo.editBlock),
      })
      continue
    }

    if (!holder && newKeyProblem(server.key, model.rules) !== null) {
      skipped.push({ serverKey: server.key, reason: { kind: "keyNotNew" } })
      continue
    }

    if (server.groups.length === 0) {
      skipped.push({ serverKey: server.key, reason: { kind: "noDefinition" } })
      continue
    }

    const compatible = server.groups.find((group) =>
      agentInfo.transports.has(group.definition.type)
    )
    if (!compatible) {
      skipped.push({
        serverKey: server.key,
        reason: {
          kind: "unsupportedTransport",
          transport: server.groups[0].definition.type,
        },
      })
      continue
    }

    ops.push({
      serverKey: server.key,
      effect: "add",
      definition: compatible.definition,
      op: {
        agent,
        key: server.key,
        action: "set",
        definition: compatible.definition,
      },
    })
  }

  return {
    mode: "agent_enable",
    agent,
    ops,
    alreadyActive,
    skipped,
  }
}
