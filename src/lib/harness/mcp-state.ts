/**
 * The MCP section's state, and the reads and writes that fill it.
 *
 * All of it lives in slots (`harness-slots.ts`), so it outlives the page: the
 * last inventory, the view and its filters, the selected server or agent, the
 * scroll offsets, and an open editor with everything typed into it are still
 * there after a trip to a conversation and back. The reads and writes are
 * plain functions over the slot store rather than hooks for the reason
 * `discover-state.ts` gives: a save started just before the page is left
 * still has somewhere to land.
 *
 * Three rules hold throughout:
 *
 * - **The inventory is only ever read, never patched.** Every change — a save
 *   here, `mcp://changed` from anywhere — is followed by a fresh
 *   `mcp_inventory`, and only the answer to the latest request is kept.
 * - **A save names its agents and nothing else**, with each agent's basis as
 *   last read, so a file changed elsewhere in the meantime is not written.
 * - **Nothing locks the page.** An agent being written to is busy until the
 *   inventory read after the write has landed — its basis is stale until then
 *   — and only what would write to that agent waits.
 */
import { defineHarnessSlot, type HarnessSlotStore } from "@/lib/harness-slots"
import { mcpApply, mcpInventory, mcpParseSnippet } from "@/lib/mcp/api"
import { draftFromDefinition, emptyDraft, type McpDraft } from "@/lib/mcp/draft"
import {
  editorDefinition,
  editorDrift,
  editorKey,
  editorSignature,
  effectiveTargets,
  snapshotOf,
  type McpEditorInput,
} from "@/lib/mcp/editor"
import { mcpFailureOf, type McpFailure } from "@/lib/mcp/errors"
import {
  agentServerState,
  buildModel,
  holderAgentIds,
  switchOf,
  type McpModel,
} from "@/lib/mcp/model"
import {
  agentsOf,
  basisFromResult,
  basisOf,
  enableOp,
  planOf,
  removeOps,
  renameOps,
  setOps,
  type McpPlan,
} from "@/lib/mcp/ops"
import {
  defaultPasteTargets,
  pasteChoicesOf,
  pasteOps,
  type McpPasteChoice,
} from "@/lib/mcp/paste"
import { isSaved } from "@/lib/mcp/results"
import { defaultCreateTargets } from "@/lib/mcp/targets"
import type {
  McpApplyResult,
  McpAppType,
  McpDefinition,
  McpInventory,
  McpOp,
  McpSnippet,
} from "@/lib/mcp/types"

// ─── Requests ─────────────────────────────────────────────────────────

// One counter for every read and write, kept outside the slots for the
// reason `discover-state.ts` gives: a reset section must not hand out a
// number an answer from before the reset still carries.
let lastRequest = 0
const newRequest = () => ++lastRequest

// ─── The inventory ────────────────────────────────────────────────────

export interface McpInventoryState {
  phase: "idle" | "loading" | "ready" | "error"
  /** The last inventory read — kept while a new one is read, and when that
   *  fails, so the page never goes blank over a refresh. */
  inventory: McpInventory | null
  error: McpFailure | null
  /** The read these contents belong to, or are waiting for. */
  request: number
}

export const MCP_INVENTORY = defineHarnessSlot<McpInventoryState>(
  "mcp",
  () => ({ phase: "idle", inventory: null, error: null, request: 0 })
)

// Built once per inventory: every list, detail and dialog reads the same one.
const models = new WeakMap<McpInventory, McpModel>()

export function modelOf(inventory: McpInventory): McpModel {
  let model = models.get(inventory)
  if (!model) {
    model = buildModel(inventory)
    models.set(inventory, model)
  }
  return model
}

/** The model of the inventory on show, or `null` before the first read. */
export function currentModel(slots: HarnessSlotStore): McpModel | null {
  const { inventory } = slots.get(MCP_INVENTORY)
  return inventory ? modelOf(inventory) : null
}

/**
 * Read every agent's configuration again. Returns the request's number at
 * once — what a write waits for — and a promise of its landing. A read that
 * a newer one overtakes lands nowhere.
 */
export function reloadMcpInventory(slots: HarnessSlotStore): {
  request: number
  done: Promise<void>
} {
  const request = newRequest()
  slots.set(
    MCP_INVENTORY,
    (prev): McpInventoryState => ({ ...prev, phase: "loading", request })
  )
  const current = () => slots.get(MCP_INVENTORY).request === request
  const done = (async () => {
    try {
      const inventory = await mcpInventory()
      if (!current()) return
      slots.set(
        MCP_INVENTORY,
        (prev): McpInventoryState => ({
          ...prev,
          phase: "ready",
          inventory,
          error: null,
        })
      )
    } catch (error) {
      if (!current()) return
      slots.set(
        MCP_INVENTORY,
        (prev): McpInventoryState => ({
          ...prev,
          phase: "error",
          error: mcpFailureOf(error),
        })
      )
    }
    settleWrites(slots, request)
  })()
  return { request, done }
}

// ─── Writes in flight ─────────────────────────────────────────────────

export interface McpBusyState {
  /** Writes in flight, per agent. */
  writing: Readonly<Record<string, number>>
  /** Per agent written to: the inventory read begun after its last write.
   *  Until that read lands, the inventory's basis for it is stale. */
  awaiting: Readonly<Record<string, number>>
}

export const MCP_BUSY = defineHarnessSlot<McpBusyState>("mcp", () => ({
  writing: {},
  awaiting: {},
}))

export function isAgentBusy(busy: McpBusyState, agent: string): boolean {
  return (busy.writing[agent] ?? 0) > 0 || busy.awaiting[agent] !== undefined
}

function beginWrite(slots: HarnessSlotStore, agents: readonly string[]) {
  slots.set(MCP_BUSY, (prev) => {
    const writing = { ...prev.writing }
    for (const agent of agents) writing[agent] = (writing[agent] ?? 0) + 1
    return { ...prev, writing }
  })
}

function endWrite(
  slots: HarnessSlotStore,
  agents: readonly string[],
  refresh: number
) {
  slots.set(MCP_BUSY, (prev) => {
    const writing = { ...prev.writing }
    const awaiting = { ...prev.awaiting }
    for (const agent of agents) {
      const left = (writing[agent] ?? 1) - 1
      if (left > 0) writing[agent] = left
      else delete writing[agent]
      awaiting[agent] = refresh
    }
    return { writing, awaiting }
  })
}

/** A read has landed: the agents written to before it began are current
 *  again, and the switches that were only waiting for it show the truth. */
function settleWrites(slots: HarnessSlotStore, request: number) {
  slots.set(MCP_BUSY, (prev) => {
    const entries = Object.entries(prev.awaiting)
    if (!entries.some(([, waitingFor]) => waitingFor <= request)) return prev
    const awaiting: Record<string, number> = {}
    for (const [agent, waitingFor] of entries) {
      if (waitingFor > request) awaiting[agent] = waitingFor
    }
    return { ...prev, awaiting }
  })
  const busy = slots.get(MCP_BUSY)
  slots.set(MCP_ROW_WRITES, (prev) => {
    const done = Object.entries(prev).filter(
      ([, row]) => row.phase === "saved" && !isAgentBusy(busy, row.agent)
    )
    if (done.length === 0) return prev
    const next = { ...prev }
    for (const [id] of done) delete next[id]
    return next
  })
}

// ─── View, filters, selection ─────────────────────────────────────────

export type McpView = "servers" | "agents"

export const MCP_VIEW = defineHarnessSlot<McpView>("mcp", () => "servers")

/** `harness` and `updates` are offered only once the Harness seam has
 *  something to match (`mcp-marks.ts`). */
export type McpShow = "all" | "problems" | "harness" | "updates"

export interface McpFilters {
  text: string
  show: McpShow
}

export const DEFAULT_MCP_FILTERS: McpFilters = { text: "", show: "all" }

export const MCP_FILTERS = defineHarnessSlot<McpFilters>(
  "mcp",
  () => DEFAULT_MCP_FILTERS
)

/** Agents that are not installed (and hold nothing) are folded away until
 *  this is on. One choice for every list that names agents. */
export const MCP_SHOW_ALL_AGENTS = defineHarnessSlot<boolean>(
  "mcp",
  () => false
)

export const MCP_SELECTED_SERVER = defineHarnessSlot<string | null>(
  "mcp",
  () => null
)

/** The agent open in the agent view, as the backend spells it. */
export const MCP_SELECTED_AGENT = defineHarnessSlot<string | null>(
  "mcp",
  () => null
)

/** How far each view's list is scrolled. Read once, on the way back in. */
export const MCP_LIST_SCROLL = defineHarnessSlot<Record<McpView, number>>(
  "mcp",
  () => ({ servers: 0, agents: 0 })
)

/** How far the open detail is scrolled — for that detail only. */
export const MCP_DETAIL_SCROLL = defineHarnessSlot<{
  id: string
  top: number
} | null>("mcp", () => null)

/** The row a closed detail was opened from, which gets the focus back. */
export const MCP_RETURN_FOCUS = defineHarnessSlot<string | null>(
  "mcp",
  () => null
)

export function setMcpView(slots: HarnessSlotStore, view: McpView): void {
  slots.set(MCP_VIEW, view)
}

export function selectServer(slots: HarnessSlotStore, key: string | null) {
  slots.set(MCP_SELECTED_SERVER, key)
}

export function selectAgent(slots: HarnessSlotStore, agent: string | null) {
  slots.set(MCP_SELECTED_AGENT, agent)
}

/** Back from a detail, on a pane that shows one screen at a time. */
export function closeMcpDetail(slots: HarnessSlotStore): void {
  const view = slots.get(MCP_VIEW)
  const selected =
    view === "servers"
      ? slots.get(MCP_SELECTED_SERVER)
      : slots.get(MCP_SELECTED_AGENT)
  if (selected === null) return
  slots.set(MCP_RETURN_FOCUS, selected)
  if (view === "servers") slots.set(MCP_SELECTED_SERVER, null)
  else slots.set(MCP_SELECTED_AGENT, null)
}

/**
 * Open one server in the server view — what `openHarness({ section: "mcp",
 * serverKey })` asks for, and "Show server" from the agent view. The search
 * and the filter are cleared, so the list shows the row that is open; a key
 * that is not there opens on the message that says so.
 */
export function openMcpServer(slots: HarnessSlotStore, key: string): void {
  slots.set(MCP_VIEW, "servers")
  slots.set(MCP_FILTERS, DEFAULT_MCP_FILTERS)
  slots.set(MCP_SELECTED_SERVER, key)
}

// ─── Saves from a row ─────────────────────────────────────────────────

/** What a switch asks of one agent's entry. */
export type McpRowAction =
  | { kind: "enable" }
  | { kind: "disable" }
  | { kind: "remove" }
  | { kind: "add"; definition: McpDefinition }

export interface McpRowWrite {
  seq: number
  agent: McpAppType
  key: string
  action: McpRowAction
  /** Where the switch is going: on, or off. */
  target: boolean
  /** `saved` lasts until the inventory read after it has landed. */
  phase: "saving" | "saved" | "failed"
  result: McpApplyResult | null
  failure: McpFailure | null
  /** The agent's basis the save was made against — what the user saw when
   *  they decided. A retry goes with it again, so a file that changed in
   *  the meantime is reported, not written over. */
  basis: string | null
}

/** Each row's own save, by {@link rowId}. */
export const MCP_ROW_WRITES = defineHarnessSlot<
  Readonly<Record<string, McpRowWrite>>
>("mcp", () => ({}))

export const rowId = (agent: string, key: string) => `${agent}\u0000${key}`

/** What a screen reader is told about a row's save. */
export interface McpAnnouncement {
  seq: number
  agent: McpAppType
  key: string
  target: boolean
  saved: boolean
}

export const MCP_ANNOUNCEMENT = defineHarnessSlot<McpAnnouncement | null>(
  "mcp",
  () => null
)

function rowOps(agent: McpAppType, key: string, action: McpRowAction): McpOp[] {
  switch (action.kind) {
    case "enable":
      return [enableOp(key, agent, true)]
    case "disable":
      return [enableOp(key, agent, false)]
    case "remove":
      return removeOps(key, [agent])
    case "add":
      return setOps(key, action.definition, [agent])
  }
}

/**
 * Save one row's switch: one op, to one agent, with that agent's basis. The
 * row shows its own progress and its own answer; the rest of the page goes
 * on as it was.
 */
export async function writeRow(
  slots: HarnessSlotStore,
  agent: McpAppType,
  key: string,
  action: McpRowAction,
  /** The basis the user decided on, when that was not now: a question that
   *  stayed open, a retry. Without it, the inventory on show — what the
   *  user is looking at as they flip the switch. */
  decidedOn?: string | null
): Promise<void> {
  const { inventory } = slots.get(MCP_INVENTORY)
  if (!inventory || isAgentBusy(slots.get(MCP_BUSY), agent)) return
  const ops = rowOps(agent, key, action)
  const basis =
    decidedOn !== undefined
      ? decidedOn
      : (basisOf(inventory, [agent])[agent] ?? null)
  const plan: McpPlan = {
    ops,
    basis: basis === null ? {} : { [agent]: basis },
  }
  const seq = newRequest()
  const id = rowId(agent, key)
  const target = action.kind === "enable" || action.kind === "add"
  slots.set(
    MCP_ROW_WRITES,
    (prev): Record<string, McpRowWrite> => ({
      ...prev,
      [id]: {
        seq,
        agent,
        key,
        action,
        target,
        phase: "saving",
        result: null,
        failure: null,
        basis,
      },
    })
  )
  beginWrite(slots, [agent])
  let result: McpApplyResult | null = null
  let failure: McpFailure | null = null
  try {
    result = await mcpApply({ basis: plan.basis, ops: plan.ops })
  } catch (error) {
    failure = mcpFailureOf(error)
  }
  // Read again whatever came of it: a file that changed elsewhere is to be
  // shown as it is now, and a busy lock may have been someone else's save.
  const refresh = reloadMcpInventory(slots)
  endWrite(slots, [agent], refresh.request)
  const saved = result !== null && isSaved(result)
  slots.set(MCP_ROW_WRITES, (prev): Readonly<Record<string, McpRowWrite>> => {
    const row = prev[id]
    if (!row || row.seq !== seq) return prev
    return {
      ...prev,
      [id]: { ...row, phase: saved ? "saved" : "failed", result, failure },
    }
  })
  slots.set(MCP_ANNOUNCEMENT, { seq, agent, key, target, saved })
}

/** Put a row's failed save out of sight. */
export function dismissRow(
  slots: HarnessSlotStore,
  agent: string,
  key: string
) {
  const id = rowId(agent, key)
  slots.set(MCP_ROW_WRITES, (prev) => {
    if (!prev[id] || prev[id].phase === "saving") return prev
    const next = { ...prev }
    delete next[id]
    return next
  })
}

// ─── Dialogs ──────────────────────────────────────────────────────────

/**
 * A dialog's way to a save: what the user puts in (`input`), the preflight's
 * account of what would be written (`review`), the save itself, and each
 * agent's result.
 */
export interface McpFlow {
  step: "input" | "review" | "saving" | "result"
  /** The ops the review is for, with the basis they were built on. */
  plan: McpPlan | null
  preflight: McpApplyResult | null
  result: McpApplyResult | null
  /** A command that was rejected outright (see `lib/mcp/errors.ts`). */
  failure: McpFailure | null
  /** Shown again because a file changed after it was read. */
  notice: "changedElsewhere" | null
  request: number
}

const inputFlow = (): McpFlow => ({
  step: "input",
  plan: null,
  preflight: null,
  result: null,
  failure: null,
  notice: null,
  request: 0,
})

export interface McpEditorDialog extends McpEditorInput {
  kind: "editor"
  id: number
  view: "form" | "json"
  /** {@link editorSignature} when it opened: what "unsaved" is measured
   *  against. */
  initial: string
  /**
   * The JSON view shows secret values. Kept here, not in the component, for
   * one reason: text typed into the view that is not yet valid JSON cannot be
   * masked again, and has to come back as it was left.
   */
  revealJson: boolean
  flow: McpFlow
}

export interface McpRemoveDialog {
  kind: "remove"
  id: number
  key: string
  /** The agents ticked to remove it from. */
  agents: McpAppType[]
  flow: McpFlow
}

export interface McpRenameDialog {
  kind: "rename"
  id: number
  key: string
  newKey: string
  flow: McpFlow
}

export interface McpPasteDialog {
  kind: "paste"
  id: number
  text: string
  /** The text box, or the servers read from it. */
  stage: "text" | "servers"
  parse: {
    phase: "idle" | "loading" | "ready" | "error"
    snippet: McpSnippet | null
    failure: McpFailure | null
    request: number
  }
  choices: McpPasteChoice[]
  targets: McpAppType[]
  flow: McpFlow
}

/**
 * The questions a switch has to ask before it saves: off means removing the
 * entry (an agent without an off flag), which of several definitions to
 * write, and — for Hermes' YAML with comments — whether to save at all, since
 * the comments do not survive it.
 */
/** A definition a switch's question offers, as it was when the question
 *  opened: what the user sees is what gets written. */
export interface McpConfirmChoice {
  fingerprint: string
  letter: string
  /** The agents that held it, as the backend spells them. */
  agents: string[]
  definition: McpDefinition
}

export interface McpConfirmDialog {
  kind: "confirm"
  id: number
  agent: McpAppType
  key: string
  action: "enable" | "disable" | "remove" | "add"
  /** `add`: the definitions on offer. */
  choices: McpConfirmChoice[]
  /** The chosen one's fingerprint. */
  choice: string | null
  /** The agent's basis when the question opened. The save goes with it: if
   *  the file changes while the question is open, the engine reports that
   *  instead of the answer being written over what the user never saw. */
  basis: string | null
}

export type McpDialog =
  | McpEditorDialog
  | McpRemoveDialog
  | McpRenameDialog
  | McpPasteDialog
  | McpConfirmDialog

export const MCP_DIALOG = defineHarnessSlot<McpDialog | null>("mcp", () => null)

let lastDialog = 0

type DialogOf<K extends McpDialog["kind"]> = Extract<McpDialog, { kind: K }>

/** Change the open dialog — only if it is still the one `id` names. */
export function updateDialog<K extends McpDialog["kind"]>(
  slots: HarnessSlotStore,
  id: number,
  kind: K,
  update: (dialog: DialogOf<K>) => DialogOf<K>
): void {
  slots.set(MCP_DIALOG, (prev) =>
    prev && prev.id === id && prev.kind === kind
      ? update(prev as DialogOf<K>)
      : prev
  )
}

export function closeDialog(slots: HarnessSlotStore, id: number): void {
  slots.set(MCP_DIALOG, (prev) => (prev && prev.id === id ? null : prev))
}

function setFlow(
  slots: HarnessSlotStore,
  id: number,
  update: (flow: McpFlow) => McpFlow
) {
  slots.set(MCP_DIALOG, (prev) => {
    if (!prev || prev.id !== id || prev.kind === "confirm") return prev
    return { ...prev, flow: update(prev.flow) }
  })
}

function flowOf(slots: HarnessSlotStore, id: number): McpFlow | null {
  const dialog = slots.get(MCP_DIALOG)
  return dialog && dialog.id === id && dialog.kind !== "confirm"
    ? dialog.flow
    : null
}

// ─── The editor ───────────────────────────────────────────────────────

/** A ready definition to start from: a suggestion, or anything else that
 *  knows what it wants to add. */
export interface McpEditorPreset {
  key: string
  definition: McpDefinition
}

function editorDialog(input: McpEditorInput): Omit<McpEditorDialog, "id"> {
  return {
    kind: "editor",
    ...input,
    view: "form",
    initial: editorSignature(input),
    revealJson: false,
    flow: inputFlow(),
  }
}

/** The editor, for a new server. It goes by default to the installed agents
 *  that can hold its transport — never to every agent. */
export function openCreateEditor(
  slots: HarnessSlotStore,
  preset?: McpEditorPreset
): void {
  const model = currentModel(slots)
  const draft = preset ? draftFromDefinition(preset.definition) : emptyDraft()
  const input: McpEditorInput = {
    mode: "create",
    key: preset?.key ?? "",
    origin: null,
    draft,
    json: null,
    targets: model ? defaultCreateTargets(model, draft.transport) : [],
  }
  slots.set(MCP_DIALOG, { ...editorDialog(input), id: ++lastDialog })
}

/** Fill an open new-server editor from a preset, replacing what it held. */
export function applyEditorPreset(
  slots: HarnessSlotStore,
  id: number,
  preset: McpEditorPreset
): void {
  updateDialog(slots, id, "editor", (dialog) =>
    dialog.mode !== "create"
      ? dialog
      : {
          ...dialog,
          key: preset.key,
          draft: draftFromDefinition(preset.definition, dialog.draft),
          json: null,
        }
  )
}

/**
 * The editor, on one definition of a server: the one with `fingerprint`.
 * It applies by default to the agents that hold that definition now — with
 * several definitions, editing one leaves the others' agents alone.
 */
export function openEditEditor(
  slots: HarnessSlotStore,
  key: string,
  fingerprint: string
): boolean {
  const model = currentModel(slots)
  const server = model?.server(key)
  const group = server?.groups.find(
    (entry) => entry.fingerprint === fingerprint
  )
  if (!server || !group) return false
  const input: McpEditorInput = {
    mode: "edit",
    key,
    origin: {
      letter: server.groups.length > 1 ? group.letter : null,
      snapshot: snapshotOf(group),
    },
    draft: draftFromDefinition(group.definition),
    json: null,
    targets: group.holders.flatMap((holder) =>
      holder.info.agent ? [holder.info.agent] : []
    ),
  }
  slots.set(MCP_DIALOG, { ...editorDialog(input), id: ++lastDialog })
  return true
}

/**
 * The definition changed elsewhere and the user wants the new one: the
 * editor starts over on what the first of its agents now holds. Returns
 * false when none of them holds the server any more.
 */
export function reloadEditor(slots: HarnessSlotStore, id: number): boolean {
  const dialog = slots.get(MCP_DIALOG)
  const model = currentModel(slots)
  if (!dialog || dialog.id !== id || dialog.kind !== "editor" || !model) {
    return false
  }
  const server = model.server(dialog.key)
  const agents = Object.keys(dialog.origin?.snapshot ?? {})
  const holder = server?.holders.find(
    (entry) => agents.includes(entry.info.id) && entry.group !== null
  )
  if (!server || !holder || holder.group === null) return false
  const group = server.groups[holder.group]
  const input: McpEditorInput = {
    mode: "edit",
    key: dialog.key,
    origin: {
      letter: server.groups.length > 1 ? group.letter : null,
      snapshot: snapshotOf(group),
    },
    draft: draftFromDefinition(group.definition),
    json: null,
    targets: group.holders.flatMap((entry) =>
      entry.info.agent ? [entry.info.agent] : []
    ),
  }
  slots.set(MCP_DIALOG, { ...editorDialog(input), id })
  return true
}

/**
 * The definition changed elsewhere and the user keeps their own: what is in
 * the files now becomes the base the editor is measured against. The save
 * will write the user's version over it — which they have just been told.
 */
export function keepEditorVersion(slots: HarnessSlotStore, id: number): void {
  const model = currentModel(slots)
  updateDialog(slots, id, "editor", (dialog) => {
    if (!dialog.origin || !model) return dialog
    const server = model.server(dialog.key)
    const snapshot: Partial<Record<McpAppType, string>> = {}
    for (const agent of Object.keys(dialog.origin.snapshot) as McpAppType[]) {
      const holder = server?.holders.find((entry) => entry.info.id === agent)
      if (holder?.entry.fingerprint) snapshot[agent] = holder.entry.fingerprint
    }
    return { ...dialog, origin: { ...dialog.origin, snapshot } }
  })
}

export function editorIsDirty(dialog: McpEditorDialog): boolean {
  return editorSignature(dialog) !== dialog.initial
}

export function updateEditorDraft(
  slots: HarnessSlotStore,
  id: number,
  update: (draft: McpDraft) => McpDraft
): void {
  updateDialog(slots, id, "editor", (dialog) => ({
    ...dialog,
    draft: update(dialog.draft),
  }))
}

// ─── Remove, rename ───────────────────────────────────────────────────

/** The agents a server can be removed from or renamed in: those whose entry
 *  takes ops. */
export function editableHolders(model: McpModel, key: string): McpAppType[] {
  const server = model.server(key)
  if (!server) return []
  const agents = server.holders.flatMap((holder) => {
    const state = agentServerState(server, holder.info, model.rules)
    return holder.info.agent &&
      state.kind === "present" &&
      !state.readOnly &&
      !holder.info.editBlock
      ? [holder.info.agent]
      : []
  })
  return [...new Set(agents)]
}

/** Remove — from every agent it can be removed from, unless the user
 *  unticks some. */
export function openRemoveDialog(slots: HarnessSlotStore, key: string): void {
  const model = currentModel(slots)
  if (!model?.server(key)) return
  slots.set(MCP_DIALOG, {
    kind: "remove",
    id: ++lastDialog,
    key,
    agents: editableHolders(model, key),
    flow: inputFlow(),
  })
}

export function openRenameDialog(slots: HarnessSlotStore, key: string): void {
  if (!currentModel(slots)?.server(key)) return
  slots.set(MCP_DIALOG, {
    kind: "rename",
    id: ++lastDialog,
    key,
    newKey: key,
    flow: inputFlow(),
  })
}

// ─── Paste ────────────────────────────────────────────────────────────

export function openPasteDialog(slots: HarnessSlotStore): void {
  slots.set(MCP_DIALOG, {
    kind: "paste",
    id: ++lastDialog,
    text: "",
    stage: "text",
    parse: { phase: "idle", snippet: null, failure: null, request: 0 },
    choices: [],
    targets: [],
    flow: inputFlow(),
  })
}

/** Ask the engine what the pasted text names. */
export async function parsePaste(
  slots: HarnessSlotStore,
  id: number
): Promise<void> {
  const dialog = slots.get(MCP_DIALOG)
  if (!dialog || dialog.id !== id || dialog.kind !== "paste") return
  const request = newRequest()
  const text = dialog.text
  updateDialog(slots, id, "paste", (prev) => ({
    ...prev,
    parse: { ...prev.parse, phase: "loading", failure: null, request },
  }))
  const current = () => {
    const now = slots.get(MCP_DIALOG)
    return (
      now?.id === id && now.kind === "paste" && now.parse.request === request
    )
  }
  try {
    const snippet = await mcpParseSnippet(text)
    if (!current()) return
    const model = currentModel(slots)
    updateDialog(slots, id, "paste", (prev) => ({
      ...prev,
      parse: { phase: "ready", snippet, failure: null, request },
      stage: snippet.servers.length > 0 ? "servers" : "text",
      choices: pasteChoicesOf(snippet),
      targets:
        prev.targets.length > 0 || !model
          ? prev.targets
          : defaultPasteTargets(model),
      flow: inputFlow(),
    }))
  } catch (error) {
    if (!current()) return
    updateDialog(slots, id, "paste", (prev) => ({
      ...prev,
      parse: {
        phase: "error",
        snippet: null,
        failure: mcpFailureOf(error),
        request,
      },
    }))
  }
}

// ─── Review and save ──────────────────────────────────────────────────

/** The ops a dialog stands for, against the inventory on show. */
export function planForDialog(
  dialog: McpDialog,
  model: McpModel
): McpPlan | null {
  let ops: McpOp[] = []
  switch (dialog.kind) {
    case "editor": {
      const definition = editorDefinition(dialog)
      if (!definition) return null
      ops = setOps(
        editorKey(dialog),
        definition,
        effectiveTargets(dialog, model)
      )
      break
    }
    case "remove": {
      const removable = editableHolders(model, dialog.key)
      ops = removeOps(
        dialog.key,
        dialog.agents.filter((agent) => removable.includes(agent))
      )
      break
    }
    case "rename": {
      const newKey = dialog.newKey.trim()
      if (newKey === "" || newKey === dialog.key) return null
      ops = renameOps(dialog.key, newKey, editableHolders(model, dialog.key))
      break
    }
    case "paste": {
      const snippet = dialog.parse.snippet
      if (!snippet) return null
      ops = pasteOps(snippet, dialog.choices, dialog.targets, model)
      break
    }
    case "confirm":
      return null
  }
  return ops.length > 0 ? planOf(ops, model.inventory) : null
}

/** Whether a changed file made the editor's own definition differ from the
 *  one it opened on — in which case the editor says so instead of
 *  reviewing. */
function editorDrifted(slots: HarnessSlotStore, id: number): boolean {
  const dialog = slots.get(MCP_DIALOG)
  const model = currentModel(slots)
  if (!dialog || dialog.id !== id || dialog.kind !== "editor" || !model) {
    return false
  }
  return editorDrift(dialog, model.server(dialog.key)) !== null
}

/**
 * Show what a dialog would write: a preflight, against the basis the page
 * read the files with. If one of them has changed since, the page reads
 * them again and asks once more, saying why; a second change in a row is
 * left for the user to look at.
 */
export async function reviewDialog(
  slots: HarnessSlotStore,
  id: number,
  options: { notice?: McpFlow["notice"]; retry?: boolean } = {}
): Promise<void> {
  const dialog = slots.get(MCP_DIALOG)
  const model = currentModel(slots)
  if (!dialog || dialog.id !== id || dialog.kind === "confirm" || !model) {
    return
  }
  const plan = planForDialog(dialog, model)
  if (!plan) return
  const request = newRequest()
  setFlow(slots, id, () => ({
    step: "review",
    plan,
    preflight: null,
    result: null,
    failure: null,
    notice: options.notice ?? null,
    request,
  }))
  const current = () => flowOf(slots, id)?.request === request
  try {
    const preflight = await mcpApply({
      basis: plan.basis,
      ops: plan.ops,
      preflight: true,
    })
    if (!current()) return
    if (preflight.outcome === "changed_elsewhere" && options.retry !== false) {
      await reloadMcpInventory(slots).done
      if (!current()) return
      if (editorDrifted(slots, id)) {
        setFlow(slots, id, (flow) => ({ ...flow, step: "input" }))
        return
      }
      return reviewDialog(slots, id, {
        notice: "changedElsewhere",
        retry: false,
      })
    }
    setFlow(slots, id, (flow) => ({ ...flow, preflight }))
  } catch (error) {
    if (!current()) return
    setFlow(slots, id, (flow) => ({ ...flow, failure: mcpFailureOf(error) }))
  }
}

/** Whether the dialog's save can go now: a preflight that says everything
 *  would be written — or a save the lock turned away, to try again. */
export function canCommit(flow: McpFlow): boolean {
  if (!flow.plan) return false
  if (flow.step === "review") return flow.preflight?.ok === true
  return flow.step === "result" && flow.result?.outcome === "busy"
}

/**
 * Save what the review showed, with the basis the preflight found. A file
 * changed in between is not written: the page reads the files again and
 * shows the review once more.
 */
export async function commitDialog(
  slots: HarnessSlotStore,
  id: number
): Promise<void> {
  const flow = flowOf(slots, id)
  if (!flow || !canCommit(flow) || !flow.plan) return
  const plan = flow.plan
  const basis = flow.preflight
    ? { ...plan.basis, ...basisFromResult(flow.preflight) }
    : plan.basis
  const agents = agentsOf(plan.ops)
  const busy = slots.get(MCP_BUSY)
  if (agents.some((agent) => isAgentBusy(busy, agent))) return
  const request = newRequest()
  setFlow(slots, id, (prev) => ({
    ...prev,
    step: "saving",
    failure: null,
    request,
  }))
  beginWrite(slots, agents)
  let result: McpApplyResult | null = null
  let failure: McpFailure | null = null
  try {
    result = await mcpApply({ basis, ops: plan.ops })
  } catch (error) {
    failure = mcpFailureOf(error)
  }
  const refresh = reloadMcpInventory(slots)
  endWrite(slots, agents, refresh.request)
  if (flowOf(slots, id)?.request !== request) return
  if (result?.outcome === "changed_elsewhere") {
    await refresh.done
    if (flowOf(slots, id)?.request !== request) return
    if (editorDrifted(slots, id)) {
      setFlow(slots, id, (prev) => ({ ...prev, step: "input" }))
      return
    }
    return reviewDialog(slots, id, { notice: "changedElsewhere" })
  }
  setFlow(slots, id, (prev) => ({ ...prev, step: "result", result, failure }))
  if (result && isSaved(result)) followSave(slots, id, plan)
}

/** After a save, the selection follows what was saved: the new server, the
 *  new name — or nothing, once the server is gone from every agent. */
function followSave(slots: HarnessSlotStore, id: number, plan: McpPlan) {
  const dialog = slots.get(MCP_DIALOG)
  if (!dialog || dialog.id !== id) return
  const selected = slots.get(MCP_SELECTED_SERVER)
  if (dialog.kind === "editor" && dialog.mode === "create") {
    if (slots.get(MCP_VIEW) === "servers") {
      slots.set(MCP_SELECTED_SERVER, editorKey(dialog))
    }
  } else if (dialog.kind === "rename") {
    if (selected === dialog.key) {
      slots.set(MCP_SELECTED_SERVER, dialog.newKey.trim())
    }
  } else if (dialog.kind === "remove" && selected === dialog.key) {
    const model = currentModel(slots)
    const removed = new Set(agentsOf(plan.ops))
    const left = model
      ?.server(dialog.key)
      ?.holders.filter((holder) => !removed.has(holder.info.id as McpAppType))
    if (!left || left.length === 0) slots.set(MCP_SELECTED_SERVER, null)
  }
}

/** Back from a review or a result to what the user put in. */
export function backToInput(slots: HarnessSlotStore, id: number): void {
  setFlow(slots, id, (flow) =>
    flow.step === "saving" ? flow : { ...inputFlow(), notice: flow.notice }
  )
}

// ─── A switch's questions ─────────────────────────────────────────────

/**
 * An agent's switch for a server was flipped. Most flips save at once; the
 * ones with a question first — off meaning removal, several definitions to
 * choose from, a YAML file whose comments a save drops — ask it.
 */
export function requestSwitch(
  slots: HarnessSlotStore,
  key: string,
  agentId: string
): void {
  const model = currentModel(slots)
  const server = model?.server(key)
  const info = model?.agent(agentId)
  const agent = info?.agent
  if (!model || !server || !info || !agent) return
  if (isAgentBusy(slots.get(MCP_BUSY), agent)) return
  const { action } = switchOf(agentServerState(server, info, model.rules))
  if (!action) return
  const comments = info.inventory.config.comments_lost_on_write
  // What a question, if one is asked, will hold the save to.
  const basis = info.inventory.config.basis
  switch (action.kind) {
    case "enable":
    case "disable":
      if (comments) {
        openConfirmDialog(slots, {
          agent,
          key,
          action: action.kind,
          choices: [],
          choice: null,
          basis,
        })
      } else {
        void writeRow(slots, agent, key, { kind: action.kind })
      }
      return
    case "removeToDisable":
      openConfirmDialog(slots, {
        agent,
        key,
        action: "remove",
        choices: [],
        choice: null,
        basis,
      })
      return
    case "add": {
      const choices: McpConfirmChoice[] = action.choices.map((index) => {
        const group = server.groups[index]
        return {
          fingerprint: group.fingerprint,
          letter: group.letter,
          agents: holderAgentIds(group.holders),
          definition: group.definition,
        }
      })
      if (choices.length > 1 || comments) {
        openConfirmDialog(slots, {
          agent,
          key,
          action: "add",
          choices,
          // With several, nothing is picked for the user.
          choice: choices.length === 1 ? choices[0].fingerprint : null,
          basis,
        })
      } else {
        void writeRow(slots, agent, key, {
          kind: "add",
          definition: choices[0].definition,
        })
      }
    }
  }
}

export function openConfirmDialog(
  slots: HarnessSlotStore,
  dialog: Omit<McpConfirmDialog, "kind" | "id">
): void {
  slots.set(MCP_DIALOG, { kind: "confirm", id: ++lastDialog, ...dialog })
}

/** Carry out a confirmed switch, as a row save. */
export function confirmSwitch(slots: HarnessSlotStore, id: number): void {
  const dialog = slots.get(MCP_DIALOG)
  if (!dialog || dialog.id !== id || dialog.kind !== "confirm") return
  let action: McpRowAction
  if (dialog.action === "add") {
    const chosen = dialog.choices.find(
      (choice) => choice.fingerprint === dialog.choice
    )
    if (!chosen) return
    action = { kind: "add", definition: chosen.definition }
  } else {
    action = { kind: dialog.action }
  }
  closeDialog(slots, id)
  void writeRow(slots, dialog.agent, dialog.key, action, dialog.basis)
}
