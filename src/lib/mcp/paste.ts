/**
 * A pasted piece of configuration, turned into ops.
 *
 * `mcp_parse_snippet` says which servers the text names; the user ticks the
 * ones to add, names the ones that need a (new) name, and picks the agents.
 * Each server is written only to the chosen agents that can hold its
 * transport — the others are listed as skipped, with the reason — and the
 * pasted entry's other fields are never written: only its definition is.
 */
import { newKeyProblem, type McpKeyProblem } from "./keys"
import type { McpModel } from "./model"
import { setOps } from "./ops"
import { setTargetBlock, type McpTargetBlock } from "./targets"
import type { McpAppType, McpOp, McpSnippet } from "./types"

export interface McpPasteChoice {
  /** The name it is added under: the pasted key, or what the user typed. */
  name: string
  chosen: boolean
}

export function pasteChoicesOf(snippet: McpSnippet): McpPasteChoice[] {
  return snippet.servers.map((server) => ({
    name: server.key ?? "",
    // Only what is a server can be added; a reserved or broken name still
    // comes ticked, and has to be changed before anything is written.
    chosen: server.definition !== null,
  }))
}

export type McpPasteIssue =
  | { kind: "key"; problem: McpKeyProblem }
  | { kind: "repeated" }

/** What stops a ticked server from being added, or `null`. */
export function pasteIssue(
  snippet: McpSnippet,
  choices: readonly McpPasteChoice[],
  index: number,
  model: McpModel
): McpPasteIssue | null {
  const choice = choices[index]
  if (!choice?.chosen || !snippet.servers[index]?.definition) return null
  const name = choice.name.trim()
  const problem = newKeyProblem(name, model.rules)
  if (problem) return { kind: "key", problem }
  const repeated = choices.some(
    (other, otherIndex) =>
      otherIndex !== index &&
      other.chosen &&
      snippet.servers[otherIndex]?.definition &&
      other.name.trim() === name
  )
  return repeated ? { kind: "repeated" } : null
}

/** The agents a default paste goes to: the installed ones Codeg can write. */
export function defaultPasteTargets(model: McpModel): McpAppType[] {
  return model.agents.flatMap((info) =>
    info.agent && info.installed === true && !info.editBlock ? [info.agent] : []
  )
}

/** Where one pasted server goes, and where it does not and why. */
export function pasteTargetsFor(
  snippet: McpSnippet,
  index: number,
  /** The name it is added under — an agent whose entry of that name takes
   *  no edits is skipped. */
  name: string,
  targets: readonly McpAppType[],
  model: McpModel
): {
  agents: McpAppType[]
  skipped: { agent: McpAppType; block: McpTargetBlock }[]
} {
  const definition = snippet.servers[index]?.definition
  const agents: McpAppType[] = []
  const skipped: { agent: McpAppType; block: McpTargetBlock }[] = []
  if (!definition) return { agents, skipped }
  for (const agent of targets) {
    const info = model.agent(agent)
    const block: McpTargetBlock | null = info
      ? setTargetBlock(info, definition.type, name.trim() || null, model.rules)
      : { kind: "agent", block: { kind: "unknownAgent" } }
    if (block) skipped.push({ agent, block })
    else agents.push(agent)
  }
  return { agents, skipped }
}

/** Whether the paste can go to review: something ticked, nothing that stops
 *  it, and somewhere for each ticked server to go. */
export function pasteReady(
  snippet: McpSnippet,
  choices: readonly McpPasteChoice[],
  targets: readonly McpAppType[],
  model: McpModel
): boolean {
  let any = false
  for (let index = 0; index < snippet.servers.length; index++) {
    const choice = choices[index]
    if (!choice?.chosen || !snippet.servers[index].definition) continue
    if (pasteIssue(snippet, choices, index, model)) return false
    if (
      pasteTargetsFor(snippet, index, choice.name, targets, model).agents
        .length === 0
    ) {
      return false
    }
    any = true
  }
  return any
}

export function pasteOps(
  snippet: McpSnippet,
  choices: readonly McpPasteChoice[],
  targets: readonly McpAppType[],
  model: McpModel
): McpOp[] {
  return snippet.servers.flatMap((server, index) => {
    const choice = choices[index]
    if (!choice?.chosen || !server.definition) return []
    if (pasteIssue(snippet, choices, index, model)) return []
    const { agents } = pasteTargetsFor(
      snippet,
      index,
      choice.name,
      targets,
      model
    )
    return setOps(choice.name.trim(), server.definition, agents)
  })
}
