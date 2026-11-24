/**
 * Which agents a definition can be written to — the "Apply to" lists of the
 * editor and of a pasted configuration.
 *
 * An agent that cannot take it is still listed, with the reason, and cannot be
 * ticked: one that cannot hold the transport (the engine would refuse the
 * whole request for it), one whose file Codeg does not change, and — for a
 * key that is already in the files and breaks the rule for new names — one
 * that does not have it yet, since the key could only be created there.
 */
import { newKeyProblem, type McpKeyProblem, type McpKeyRules } from "./keys"
import {
  readOnlyReasonOf,
  type McpAgentBlock,
  type McpAgentInfo,
  type McpModel,
  type McpReadOnlyReason,
} from "./model"
import type { McpAppType, McpTransport } from "./types"

export type McpTargetBlock =
  | { kind: "agent"; block: McpAgentBlock }
  | { kind: "transport"; transport: McpTransport }
  | { kind: "key"; problem: McpKeyProblem }
  /** The agent already has an entry with this name, and it takes no edits
   *  — a name or a field that is there twice, the built-in server's name.
   *  The engine would refuse the whole request for it. */
  | { kind: "entry"; reason: McpReadOnlyReason }

/**
 * Why `info` cannot be written `key` with a definition over `transport`, or
 * `null` when it can.
 *
 * `newKey` applies the rule for new names to an agent that does not have the
 * key yet. Leave it off while a new name is still being typed: its own field
 * says what is wrong with it, and the list should not grey out on every
 * keystroke. An existing entry that takes no edits blocks either way.
 */
export function setTargetBlock(
  info: McpAgentInfo,
  transport: McpTransport,
  key: string | null,
  rules: McpKeyRules,
  options: { newKey?: boolean } = {}
): McpTargetBlock | null {
  if (info.editBlock) return { kind: "agent", block: info.editBlock }
  if (!info.transports.has(transport)) return { kind: "transport", transport }
  if (!key) return null
  // More than one where YAML lists a name twice; any of them decides.
  const held = info.inventory.entries.filter((entry) => entry.key === key)
  for (const entry of held) {
    const reason = readOnlyReasonOf(info, entry)
    if (reason) return { kind: "entry", reason }
  }
  if (held.length === 0 && options.newKey) {
    const problem = newKeyProblem(key, rules)
    if (problem) return { kind: "key", problem }
  }
  return null
}

/** The agents a NEW server is offered to by default: installed ones that can
 *  hold its transport. Not every agent — a server, and its secrets, go only
 *  where they are asked for. */
export function defaultCreateTargets(
  model: McpModel,
  transport: McpTransport
): McpAppType[] {
  return model.agents.flatMap((info) =>
    info.agent &&
    info.installed === true &&
    !setTargetBlock(info, transport, null, model.rules)
      ? [info.agent]
      : []
  )
}
