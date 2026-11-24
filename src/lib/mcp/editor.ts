/**
 * The editor's rules, apart from any React: what it would write, to whom,
 * what stops it, whether anything changed, and whether the server changed
 * elsewhere since it was opened.
 */
import {
  definitionFromDraft,
  definitionSignature,
  draftProblems,
  type McpDraft,
  type McpDraftProblem,
  type McpJsonProblem,
} from "./draft"
import { newKeyProblem, type McpKeyProblem } from "./keys"
import type { McpDefinitionGroup, McpModel, McpServer } from "./model"
import { setTargetBlock, type McpTargetBlock } from "./targets"
import type { McpAppType, McpDefinition, McpTransport } from "./types"

export type McpEditorMode = "create" | "edit"

/** What the editor was opened on, when it edits a definition that exists. */
export interface McpEditorOrigin {
  /** The definition's letter when the server had several; `null` for one. */
  letter: string | null
  /** The agents that held this definition, with its fingerprint — what
   *  "changed elsewhere" is measured against. */
  snapshot: Partial<Record<McpAppType, string>>
}

export interface McpEditorInput {
  mode: McpEditorMode
  /** Edit: the server's key, fixed. Create: the name field, as typed. */
  key: string
  origin: McpEditorOrigin | null
  draft: McpDraft
  /** The JSON view's own text, while it differs from the form — `null` when
   *  the form is all there is. */
  json: { text: string; problem: McpJsonProblem | null } | null
  /** The agents ticked under "Apply to". An agent the current transport rules
   *  out stays here, unticked on screen, so that switching back ticks it
   *  again; it is never written to while ruled out. */
  targets: McpAppType[]
}

/** The name that would be written: an existing key as it is, a new one
 *  without the spaces around it. */
export function editorKey(input: McpEditorInput): string {
  return input.mode === "create" ? input.key.trim() : input.key
}

/** The definition that would be written, or `null` while the JSON view holds
 *  text that is not one. */
export function editorDefinition(input: McpEditorInput): McpDefinition | null {
  if (input.json?.problem) return null
  return definitionFromDraft(input.draft)
}

export function editorTransport(input: McpEditorInput): McpTransport {
  return input.draft.transport
}

/** Why an agent cannot be ticked, for the current transport. */
export function editorTargetBlock(
  input: McpEditorInput,
  model: McpModel,
  agent: McpAppType
): McpTargetBlock | null {
  const info = model.agent(agent)
  if (!info) return { kind: "agent", block: { kind: "unknownAgent" } }
  return setTargetBlock(
    info,
    editorTransport(input),
    editorKey(input) || null,
    model.rules,
    // An existing server's name is final; a new one is checked by its field.
    { newKey: input.mode === "edit" }
  )
}

/** The agents a save would write to. */
export function effectiveTargets(
  input: McpEditorInput,
  model: McpModel
): McpAppType[] {
  return input.targets.filter(
    (agent) => editorTargetBlock(input, model, agent) === null
  )
}

export type McpEditorIssue =
  | { kind: "key"; problem: McpKeyProblem }
  | { kind: "draft"; problem: McpDraftProblem }
  | { kind: "json"; problem: McpJsonProblem }
  | { kind: "noTargets" }

/** Everything that stops "Review changes", in the order the fields are
 *  shown. */
export function editorIssues(
  input: McpEditorInput,
  model: McpModel
): McpEditorIssue[] {
  const issues: McpEditorIssue[] = []
  if (input.mode === "create") {
    const problem = newKeyProblem(editorKey(input), model.rules)
    if (problem) issues.push({ kind: "key", problem })
  }
  if (input.json?.problem) {
    issues.push({ kind: "json", problem: input.json.problem })
  } else {
    for (const problem of draftProblems(input.draft)) {
      issues.push({ kind: "draft", problem })
    }
  }
  if (effectiveTargets(input, model).length === 0) {
    issues.push({ kind: "noTargets" })
  }
  return issues
}

/**
 * What the editor holds, as one string — compared with the one it opened
 * with to tell whether there are unsaved changes. Text in the JSON view that
 * is not (yet) a definition counts as a change of its own.
 */
export function editorSignature(input: McpEditorInput): string {
  const definition = editorDefinition(input)
  return JSON.stringify([
    editorKey(input),
    definition ? definitionSignature(definition) : ["json", input.json?.text],
    [...input.targets].sort(),
  ])
}

/** The holders of a definition, as an origin's snapshot. */
export function snapshotOf(
  group: McpDefinitionGroup
): Partial<Record<McpAppType, string>> {
  const snapshot: Partial<Record<McpAppType, string>> = {}
  for (const holder of group.holders) {
    if (holder.info.agent && holder.entry.fingerprint) {
      snapshot[holder.info.agent] = holder.entry.fingerprint
    }
  }
  return snapshot
}

/**
 * Whether the definition being edited has changed in some agent since the
 * editor opened: `changed` — another definition is there now; `removed` —
 * the server is gone from that agent. Other entries of the same files are
 * not this editor's business: the engine keeps every one of them as it finds
 * it, so a change to them neither stops the save nor is overwritten by it.
 */
export function editorDrift(
  input: McpEditorInput,
  server: McpServer | undefined
): "changed" | "removed" | null {
  if (input.mode !== "edit" || !input.origin) return null
  let removed = false
  for (const [agent, fingerprint] of Object.entries(input.origin.snapshot)) {
    const holder = server?.holders.find((entry) => entry.info.id === agent)
    if (!holder) {
      removed = true
      continue
    }
    if (holder.entry.fingerprint !== fingerprint) return "changed"
  }
  return removed ? "removed" : null
}
