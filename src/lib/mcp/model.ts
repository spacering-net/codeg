/**
 * The inventory, arranged the two ways the page shows it: by server (one row
 * per key across every agent) and by agent.
 *
 * Nothing is merged. A key held by three agents is three entries; the server
 * row groups them, and when their definitions differ (by fingerprint) it says
 * so, keeping each definition apart — "Definition A: Claude Code, Gemini",
 * "Definition B: Codex" — so that each can be edited for its own agents only.
 *
 * Everything here is a pure function of one inventory: what an agent can
 * have done to it, what state each agent is in for a server, and what
 * flipping its switch would do.
 */
import {
  keyRulesOf,
  newKeyProblem,
  type McpKeyProblem,
  type McpKeyRules,
} from "./keys"
import {
  isMcpAppType,
  isMcpTransport,
  MCP_TRANSPORTS,
  type McpAgentInventory,
  type McpAppType,
  type McpDefinition,
  type McpEntry,
  type McpInventory,
  type McpIssue,
  type McpTransport,
} from "./types"

// ─── Agents ───────────────────────────────────────────────────────────

/** Why Codeg will not change an agent's file. */
export type McpAgentBlock =
  /** An agent this build does not know: a newer backend lists it, and this
   *  page cannot tell what its file holds or how it is spelled. */
  | { kind: "unknownAgent" }
  /** The file itself: unreadable, read-only (and why), or an agent Codeg only
   *  lists. `reason` is the backend's, when it gave one. */
  | { kind: "file"; status: string; reason: McpIssue | null }
  /** A second file that has to change with it (Claude Code's and CodeBuddy's
   *  `settings.json`) cannot be read or edited. */
  | { kind: "related"; path: string; reason: McpIssue }

export interface McpAgentInfo {
  inventory: McpAgentInventory
  /** As the backend spells it. */
  id: string
  /** `null` for an agent this build does not know. */
  agent: McpAppType | null
  installed: boolean | null
  transports: ReadonlySet<McpTransport>
  /** Why `set`, `remove` and `rename` are refused for it, or `null`. */
  editBlock: McpAgentBlock | null
  /** Why `set_enabled` is refused for it, or `null`. Turning a server off by
   *  removing it is an edit, and goes by `editBlock`. */
  toggleBlock: McpAgentBlock | null
  /** The file could not be read: its entries are not known at all. */
  unreadable: boolean
}

function fileBlock(inventory: McpAgentInventory): McpAgentBlock | null {
  if (inventory.writable) return null
  return {
    kind: "file",
    status: inventory.config.status,
    reason: inventory.config.reason ?? null,
  }
}

export function agentInfoOf(inventory: McpAgentInventory): McpAgentInfo {
  const agent = isMcpAppType(inventory.agent) ? inventory.agent : null
  const transports = new Set<McpTransport>(
    inventory.transports.filter(isMcpTransport)
  )
  const unknown: McpAgentBlock | null = agent ? null : { kind: "unknownAgent" }
  const file = fileBlock(inventory)
  const gate = inventory.config.related.find((file) => file.reason)
  const related: McpAgentBlock | null =
    gate && gate.reason
      ? { kind: "related", path: gate.path, reason: gate.reason }
      : null
  return {
    inventory,
    id: inventory.agent,
    agent,
    installed: inventory.installed,
    transports,
    editBlock: unknown ?? file ?? related,
    toggleBlock: unknown ?? file,
    unreadable: inventory.config.status === "unreadable",
  }
}

/** A problem worth a mark. An entry's sitting in an older place of its file
 *  is a remark — the next edit moves it — not a problem. */
export function isNotableProblem(issue: McpIssue): boolean {
  return issue.code !== "legacy_location"
}

/** Whether an agent's file is in a state worth marking — not the ordinary
 *  "Codeg only lists this agent". */
export function isProblemBlock(block: McpAgentBlock | null): boolean {
  if (!block) return false
  if (block.kind === "unknownAgent") return false
  if (block.kind === "related") return true
  return block.reason !== null && block.reason.code !== "managed_by_agent"
}

// ─── Servers ──────────────────────────────────────────────────────────

export interface McpHolder {
  info: McpAgentInfo
  entry: McpEntry
  /** Index into the server's `groups`; `null` for an entry Codeg cannot
   *  describe. */
  group: number | null
}

export interface McpDefinitionGroup {
  /** "A", "B", …: what the page calls it when there is more than one. */
  letter: string
  fingerprint: string
  definition: McpDefinition
  holders: McpHolder[]
}

export interface McpServer {
  key: string
  /** Every agent's entry with this key, in inventory order. */
  holders: McpHolder[]
  /** The distinct definitions, most widely held first. */
  groups: McpDefinitionGroup[]
  /** Entries that are not a server Codeg can describe. */
  undescribed: McpHolder[]
  /** Every transport its definitions use, in the usual order. */
  transports: McpTransport[]
  /** The key is the built-in server's. */
  reserved: boolean
  /** A problem on an entry, or a holder's file that cannot be edited. */
  hasProblems: boolean
}

function letterOf(index: number): string {
  // Past Z (twenty-six different definitions of one name) the letters
  // double up rather than run into punctuation.
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
  return index < letters.length
    ? letters[index]
    : `${letters[Math.floor(index / letters.length) - 1]}${letters[index % letters.length]}`
}

function serverOf(
  key: string,
  held: { info: McpAgentInfo; entry: McpEntry }[],
  rules: McpKeyRules
): McpServer {
  const byFingerprint = new Map<
    string,
    {
      definition: McpDefinition
      holders: { info: McpAgentInfo; entry: McpEntry }[]
      first: number
    }
  >()
  held.forEach((holder, index) => {
    const { definition, fingerprint } = holder.entry
    if (!definition || !fingerprint) return
    const group = byFingerprint.get(fingerprint)
    if (group) group.holders.push(holder)
    else
      byFingerprint.set(fingerprint, {
        definition,
        holders: [holder],
        first: index,
      })
  })
  const ordered = [...byFingerprint.entries()].sort(
    ([, a], [, b]) => b.holders.length - a.holders.length || a.first - b.first
  )
  const groupOf = new Map<string, number>()
  ordered.forEach(([fingerprint], index) => groupOf.set(fingerprint, index))

  const holders: McpHolder[] = held.map((holder) => ({
    ...holder,
    group:
      holder.entry.definition && holder.entry.fingerprint
        ? (groupOf.get(holder.entry.fingerprint) ?? null)
        : null,
  }))
  const groups: McpDefinitionGroup[] = ordered.map(
    ([fingerprint, group], index) => ({
      letter: letterOf(index),
      fingerprint,
      definition: group.definition,
      holders: holders.filter((holder) => holder.group === index),
    })
  )
  const used = new Set(groups.map((group) => group.definition.type))
  return {
    key,
    holders,
    groups,
    undescribed: holders.filter((holder) => holder.group === null),
    transports: MCP_TRANSPORTS.filter((transport) => used.has(transport)),
    reserved:
      rules.reserved.includes(key) ||
      holders.some((holder) => holder.entry.reserved),
    hasProblems: holders.some(
      (holder) =>
        holder.entry.problems.some(isNotableProblem) ||
        isProblemBlock(holder.info.editBlock)
    ),
  }
}

/**
 * The agents among `holders`, each once, in order. One agent can hold a key
 * twice: in YAML two keys that read as one name (`1` and `"1"`) are both
 * listed, each marked `duplicate_key`.
 */
export function holderAgentIds(holders: readonly McpHolder[]): string[] {
  return [...new Set(holders.map((holder) => holder.info.id))]
}

// ─── The whole inventory ──────────────────────────────────────────────

export interface McpModel {
  inventory: McpInventory
  rules: McpKeyRules
  /** Every agent, in inventory order. */
  agents: McpAgentInfo[]
  /** Every key, sorted by name. */
  servers: McpServer[]
  server: (key: string) => McpServer | undefined
  agent: (id: string) => McpAgentInfo | undefined
}

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true })

export function buildModel(inventory: McpInventory): McpModel {
  const rules = keyRulesOf(inventory)
  const agents = inventory.agents.map(agentInfoOf)
  const held = new Map<string, { info: McpAgentInfo; entry: McpEntry }[]>()
  for (const info of agents) {
    for (const entry of info.inventory.entries) {
      const list = held.get(entry.key)
      if (list) list.push({ info, entry })
      else held.set(entry.key, [{ info, entry }])
    }
  }
  const servers = [...held.entries()]
    .map(([key, list]) => serverOf(key, list, rules))
    // By name, case and accents aside; two keys that differ only in case keep
    // a fixed order.
    .sort((a, b) => collator.compare(a.key, b.key) || (a.key < b.key ? -1 : 1))
  const serverByKey = new Map(servers.map((server) => [server.key, server]))
  const agentById = new Map(agents.map((info) => [info.id, info]))
  return {
    inventory,
    rules,
    agents,
    servers,
    server: (key) => serverByKey.get(key),
    agent: (id) => agentById.get(id),
  }
}

/**
 * Whether an agent is folded away under "Show all agents": one that is not
 * installed and that has nothing to show. An agent that is not installed but
 * whose file still holds servers stays in view — hiding it would hide part of
 * what is configured, and a rename or a removal could then miss it.
 */
export function isFolded(info: McpAgentInfo): boolean {
  return (
    info.installed === false &&
    info.inventory.entries.length === 0 &&
    !isProblemBlock(info.editBlock)
  )
}

// ─── One agent, one server ────────────────────────────────────────────

/** Why an entry takes no edits. */
export type McpReadOnlyReason =
  | { kind: "agent"; block: McpAgentBlock }
  | { kind: "reserved" }
  /** A key twice in the file: the entry's name (`field` null) or a key
   *  inside it. Has to be fixed in the file by hand. */
  | { kind: "duplicate"; field: string | null }
  /** Read-only for a reason this build does not know. */
  | { kind: "entry" }

/** Why a server cannot be added to an agent that lacks it. */
export type McpAddBlock =
  | { kind: "agent"; block: McpAgentBlock }
  /** None of the server's definitions uses a transport the agent can hold. */
  | { kind: "transport"; transports: McpTransport[] }
  /** The key cannot be created: a new entry must match the rule. */
  | { kind: "key"; problem: McpKeyProblem }
  /** No agent has a definition Codeg could copy. */
  | { kind: "noDefinition" }

export type McpAgentServerState =
  | { kind: "unreadable"; info: McpAgentInfo }
  | {
      kind: "present"
      info: McpAgentInfo
      holder: McpHolder
      readOnly: McpReadOnlyReason | null
    }
  | {
      kind: "absent"
      info: McpAgentInfo
      /** The definitions it could take, as group indexes. */
      choices: number[]
      block: McpAddBlock | null
    }

/**
 * Why an entry takes no op at all, or `null`. A `settings.json` that cannot be
 * edited is not such a reason: it stops edits, not the on/off switch, and is
 * told where an edit is offered.
 */
export function readOnlyReasonOf(
  info: McpAgentInfo,
  entry: McpEntry
): McpReadOnlyReason | null {
  if (info.toggleBlock) return { kind: "agent", block: info.toggleBlock }
  if (entry.reserved) return { kind: "reserved" }
  const duplicate = entry.problems.find(
    (issue) => issue.code === "duplicate_key"
  )
  if (duplicate) return { kind: "duplicate", field: duplicate.field ?? null }
  if (entry.read_only) return { kind: "entry" }
  return null
}

/** An agent's state for a server — see the detail's agent rows. */
export function agentServerState(
  server: McpServer,
  info: McpAgentInfo,
  rules: McpKeyRules
): McpAgentServerState {
  const holder = server.holders.find((candidate) => candidate.info === info)
  if (holder) {
    return {
      kind: "present",
      info,
      holder,
      readOnly: readOnlyReasonOf(info, holder.entry),
    }
  }
  if (info.unreadable) return { kind: "unreadable", info }
  const choices = server.groups
    .map((group, index) => ({ group, index }))
    .filter(({ group }) => info.transports.has(group.definition.type))
    .map(({ index }) => index)
  let block: McpAddBlock | null = null
  if (info.editBlock) block = { kind: "agent", block: info.editBlock }
  else if (server.groups.length === 0) block = { kind: "noDefinition" }
  else if (choices.length === 0) {
    block = { kind: "transport", transports: server.transports }
  } else {
    const problem = newKeyProblem(server.key, rules)
    if (problem) block = { kind: "key", problem }
  }
  return { kind: "absent", info, choices, block }
}

/** What flipping an agent's switch for a server does. */
export type McpSwitchAction =
  | { kind: "enable" }
  | { kind: "disable" }
  /** The agent has no off flag: off means the entry goes, once confirmed. */
  | { kind: "removeToDisable" }
  /** Write one of these definitions (group indexes) to it; with more than
   *  one, the user picks. */
  | { kind: "add"; choices: number[] }

export interface McpSwitch {
  checked: boolean
  /** `null`: the switch cannot be flipped (see the state for why). */
  action: McpSwitchAction | null
}

export function switchOf(state: McpAgentServerState): McpSwitch {
  if (state.kind === "unreadable") return { checked: false, action: null }
  if (state.kind === "absent") {
    return {
      checked: false,
      action: state.block ? null : { kind: "add", choices: state.choices },
    }
  }
  const { entry } = state.holder
  const { info } = state
  if (state.readOnly) return { checked: entry.enabled, action: null }
  if (entry.enabled) {
    if (info.inventory.can_disable) {
      return {
        checked: true,
        action: info.toggleBlock ? null : { kind: "disable" },
      }
    }
    return {
      checked: true,
      action: info.editBlock ? null : { kind: "removeToDisable" },
    }
  }
  // Off, which only an agent with an off flag can be.
  return {
    checked: false,
    action:
      info.inventory.can_disable && !info.toggleBlock
        ? { kind: "enable" }
        : null,
  }
}

// ─── Sessions ─────────────────────────────────────────────────────────

/**
 * Whether the agent's sessions leave this entry out although it is on: Codeg
 * hands servers to a `codeg_session` agent when a session starts, and leaves
 * out remote ones whose transport the agent's last session did not declare.
 * Unknown (no session yet in this Codeg) is not "skipped".
 */
export function isSkippedInSessions(
  info: McpAgentInfo,
  entry: McpEntry
): boolean {
  const caps = info.inventory.session_capabilities
  if (info.inventory.delivery !== "codeg_session" || !caps) return false
  const type = entry.definition?.type
  return (type === "http" && !caps.http) || (type === "sse" && !caps.sse)
}

// ─── Filters ──────────────────────────────────────────────────────────

export function matchesSearch(key: string, text: string): boolean {
  const query = text.trim().toLowerCase()
  return query === "" || key.toLowerCase().includes(query)
}

/** An entry, for the agent view's filters. */
export function entryHasProblems(info: McpAgentInfo, entry: McpEntry): boolean {
  return entry.problems.some(isNotableProblem) || isProblemBlock(info.editBlock)
}

/** Whether an agent's own file is in trouble — shown on the agent whatever
 *  the filters say. */
export function agentHasFileProblem(info: McpAgentInfo): boolean {
  return info.unreadable || isProblemBlock(info.editBlock)
}
